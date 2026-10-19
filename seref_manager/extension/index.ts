/**
 * seref_manager: an AI manager for seref_loop ledgers.
 *
 * `/seref_manager run LOOP_X.md` drives the loop itself instead of omp's `/loop`: after every
 * worker yield it runs the seref-loop gate (the only way to finish), then asks the manager
 * model to review the iteration — reopen unproven ticks, reject weak blockers, answer
 * questions the worker left in text, write guidance, choose keep/compact/reset, or stop as
 * stuck — and sends the next iteration prompt. While the loop runs it also answers the
 * worker's `ask` calls when nobody answers the dialog within the grace period.
 *
 * Loop state is saved into the session after every change and restored (paused) when the
 * session is resumed, so an omp restart does not lose the loop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryWaitForUsageReset } from "@oh-my-pi/pi-coding-agent/session/settings";
import { classifyMessage, Flag, is } from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";
import {
	applyEdits,
	changedItems,
	countItems,
	findLedgers,
	type LedgerItem,
	type LedgerSnapshot,
	parseLedger,
	progressKey,
} from "./ledger";
import {
	callManager,
	callManagerWithTools,
	currentSettings,
	describeTarget,
	type ManagerTarget,
	registerManagerRole,
	resolveManagerModel,
} from "./model";
import {
	CONTEXT_POLICIES,
	type ContextPolicy,
	latestPersistedEntry,
	type PersistedEntry,
	type PersistedLoop,
	STATE_ENTRY_TYPE,
} from "./state";
import {
	chooseResumeAt,
	describeUsage,
	findUsageLimit,
	formatClock,
	ompWaitFromFinalError,
	type QuotaError,
	type RoleUsage,
} from "./quota";
import { loadNtfyConfig, NTFY_CONFIG_PATH, type NtfyPriority, sendNtfy } from "./notify";
import { digestIteration, lastAssistant } from "./transcript";
import { ledgerCommands, MANAGER_TOOLS, runManagerTool } from "./tools";
import {
	type AskAnswer,
	type AskQuestion,
	type IterationVerdict,
	parseAskAnswers,
	parseAuditVerdict,
	parseIterationVerdict,
} from "./verdict";

const HERE = fs.realpathSync(import.meta.dir);
const GATE = process.env.SEREF_LOOP_GATE ?? path.resolve(HERE, "../../seref_loop/bin/seref-loop-gate");
const PROMPT_ITERATION = fs.readFileSync(path.join(HERE, "prompts/iteration.md"), "utf8");
const PROMPT_ASK = fs.readFileSync(path.join(HERE, "prompts/ask.md"), "utf8");
const PROMPT_AUDIT = fs.readFileSync(path.join(HERE, "prompts/audit.md"), "utf8");
const PROMPT_WORKER = fs.readFileSync(path.join(HERE, "prompts/worker.md"), "utf8").trim();
const DECISIONS_WITH_ASK =
	"For a decision only the user can make, call `ask`: the loop manager answers it or tells you to mark the item blocked.";
const DECISIONS_WITHOUT_ASK =
	"There is no `ask` tool in this session: for a decision only the user can make, write the question in your final message; the loop manager answers it or tells you to mark the item blocked.";

const DEFAULT_GRACE_SECONDS = 120;
const MIN_DEFAULT_MAX = 5;
/** Consecutive iterations without any ledger progress before the loop stops as stuck. */
const NO_PROGRESS_LIMIT = 2;
/** Times one item may be reopened before the loop stops as stuck. */
const REOPEN_LIMIT = 3;
/** Consecutive manager failures (after a retry each) before the loop pauses. */
const MANAGER_FAILURE_LIMIT = 3;
const ITERATION_DIGEST_CHARS = 60_000;
const ASK_DIGEST_CHARS = 30_000;
const HISTORY_KEEP = 8;
const GATE_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 250;
const IDLE_POLL_LIMIT = 120;
/** Tool calls the audit may make; a full suite run usually covers many items at once. */
const AUDIT_TOOL_CALLS = 60;
const AUDIT_TIMEOUT_MS = 30 * 60_000;
/** Longest single timer while waiting for a usage reset; the wait re-arms until it is due. */
const QUOTA_TIMER_MAX_MS = 60 * 60_000;
/** omp's own give-up message about a usage limit counts for the stop that follows within this long. */
const OMP_GIVE_UP_FRESH_MS = 2 * 60_000;
const QUOTA_RESUME_PROMPT =
	"The provider's usage limit stopped this iteration and has reset now. Continue the iteration where it stopped: re-read the ledger if you need to, finish the current item, verify it and tick it with evidence.";

/** The native ask renderer; `mergeCallAndResult` is not in ToolDefinition's type but is forwarded at runtime. */
const ASK_RENDERING = {
	renderCall: askToolRenderer.renderCall,
	renderResult: askToolRenderer.renderResult,
	describeCall: askToolRenderer.describeCall,
	describeResult: askToolRenderer.describeResult,
	mergeCallAndResult: true,
};

const USAGE = [
	"/seref_manager run [LOOP_X.md] [--max N] [--grace SECONDS] [--model SPEC[:level]] [--context manager|keep|compact|reset] [--away] [--no-audit] [--force]",
	"/seref_manager pause | resume | stop | status | away [on|off] | notify [test]",
].join("\n");

interface LoopState extends PersistedLoop {
	paused: boolean;
	busy: boolean;
	/** Set while the loop itself starts a fresh session, so its `session_switch` is not mistaken for the user's. */
	resetting: boolean;
	/** From the last `run`/`resume`; the only context that can start a new session. */
	commandCtx: ExtensionCommandContext | undefined;
	/** Whether `ask` exists (and is shadowed) in this session; decides the worker prompt's decision line. */
	askAvailable: boolean;
	/** Aborted on pause/stop so an in-flight manager call ends. */
	abort: AbortController;
	/** Wakes the loop when a usage-limit wait is due; not persisted (re-armed on restore). */
	quotaTimer: Timer | undefined;
}

/** The usage-limit error in `value` (failed message or Error cause chain), by omp's own classifier. */
function usageLimitError(value: unknown): QuotaError | undefined {
	return findUsageLimit(value, fields => is(classifyMessage(fields), Flag.UsageLimit));
}

/** Milliseconds the provider asked to wait (`retry-after-ms=`, "try again in ~N min", "resets at …"). */
function providerHintMs(error: QuotaError): number | undefined {
	const hint = extractProviderRetryHint(error.provider, error.errorMessage);
	return hint !== undefined && hint > 0 ? hint : undefined;
}

/** No model can run the manager right now: the usage reports say both are out of quota. */
class UsageDepletedError extends Error {
	constructor(
		readonly provider: string,
		readonly model: string,
		/** Earliest known reset of either model, if any. */
		readonly until: number | undefined,
	) {
		super(`${provider}/${model} is out of quota`);
	}
}

interface RunArgs {
	/** Empty: find the `LOOP_*.md` in the working directory or repo root. */
	ledger: string;
	max?: number;
	graceSeconds?: number;
	model?: string;
	context: ContextPolicy;
	away: boolean;
	audit: boolean;
	/** Start even though omp's own `/loop` looks active. */
	force: boolean;
}

function parseRunArgs(tokens: string[]): RunArgs {
	const args: RunArgs = { ledger: "", context: "manager", away: false, audit: true, force: false };
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const value = (): string => {
			const next = tokens[++index];
			if (next === undefined) throw new Error(`${token} needs a value`);
			return next;
		};
		const count = (raw: string, min: number): number => {
			const parsed = Number(raw);
			if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${token} needs an integer >= ${min}`);
			return parsed;
		};
		if (token === "--max") args.max = count(value(), 1);
		else if (token === "--grace") args.graceSeconds = count(value(), 0);
		else if (token === "--model") args.model = value();
		else if (token === "--away") args.away = true;
		else if (token === "--no-audit") args.audit = false;
		else if (token === "--force") args.force = true;
		else if (token === "--context") {
			const policy = value();
			const match = CONTEXT_POLICIES.find(candidate => candidate === policy);
			if (!match) throw new Error(`--context takes ${CONTEXT_POLICIES.join(", ")}`);
			args.context = match;
		} else if (token.startsWith("--")) throw new Error(`unknown flag ${token}`);
		else if (args.ledger) throw new Error(`unexpected argument ${token}`);
		else args.ledger = token;
	}
	return args;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function displayPath(cwd: string, file: string): string {
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") ? relative : file;
}

/** The audit log next to the ledger: `LOOP_X.md` → `LOOP_X.manager.md`. */
function logPathFor(ledgerPath: string): string {
	return ledgerPath.replace(/(\.md)?$/, ".manager.md");
}

function toPersisted(loop: LoopState): PersistedLoop {
	return {
		ledgerPath: loop.ledgerPath,
		cwd: loop.cwd,
		iteration: loop.iteration,
		max: loop.max,
		graceMs: loop.graceMs,
		away: loop.away,
		modelSpec: loop.modelSpec,
		contextPolicy: loop.contextPolicy,
		startLeafId: loop.startLeafId,
		startSnapshot: loop.startSnapshot,
		noProgress: loop.noProgress,
		reopenCounts: loop.reopenCounts,
		managerFailures: loop.managerFailures,
		history: loop.history,
		audited: loop.audited,
		quotaWait: loop.quotaWait,
		paused: loop.paused,
	};
}

export default function serefManager(pi: ExtensionAPI): void {
	let state: LoopState | undefined;
	/** This session's settings, captured inside a handler (where omp scopes them); feeds role resolution. */
	let settings: Settings | undefined;
	let askShadowed = false;
	let askQueue: Promise<unknown> = Promise.resolve();
	/**
	 * omp's own `/loop` cannot be read by extensions, so it is tracked from what reaches them:
	 * typed `/loop` commands toggle it (as omp does), and its resubmissions are the only prompts
	 * that start a run without being typed (no `input` event) or sent by this loop.
	 */
	let builtinLoopLikelyOn = false;
	/** Typed prompts not yet seen starting a run, by text; consumed by `before_agent_start`. */
	const pendingTyped = new Map<string, number>();
	/** Every prompt the user typed this process, to recognize a resubmission of one. */
	const everTyped = new Set<string>();
	let lastSentPrompt: string | undefined;
	/** Set while this extension holds `retry.waitForUsageReset` on for a running loop. */
	let holdingUsageWaits = false;
	/** omp's last give-up on a usage limit (`auto_retry_end`), for the stop that follows it. */
	let ompGiveUp: { waitMs: number; at: number } | undefined;

	/**
	 * While a loop runs, let omp itself sleep through usage limits it knows the reset time of
	 * (`retry.waitForUsageReset`), so the worker's turn simply continues afterwards. Runtime-only:
	 * never written to config.yml, released when the loop ends. A configured `true` is left alone.
	 */
	const holdUsageWaits = (): void => {
		if (!settings || holdingUsageWaits || cfgRetryWaitForUsageReset.get(settings)) return;
		cfgRetryWaitForUsageReset.override(settings, true);
		holdingUsageWaits = true;
	};

	const releaseUsageWaits = (): void => {
		if (!settings || !holdingUsageWaits) return;
		cfgRetryWaitForUsageReset.clearOverride(settings);
		holdingUsageWaits = false;
	};

	const clearQuotaTimer = (ctx: ExtensionContext, loop: LoopState): void => {
		if (loop.quotaTimer) ctx.clearTimer(loop.quotaTimer);
		loop.quotaTimer = undefined;
	};

	const persist = (loop: LoopState | undefined): void => {
		const entry: PersistedEntry = { version: 1, loop: loop ? toPersisted(loop) : null };
		pi.appendEntry(STATE_ENTRY_TYPE, entry);
	};

	const log = (loop: LoopState, markdown: string): void => {
		try {
			fs.appendFileSync(logPathFor(loop.ledgerPath), `${markdown.trimEnd()}\n\n`);
		} catch {
			// The audit log is best effort; the ledger and the session hold the real state.
		}
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		const loop = state;
		if (!loop) {
			ctx.ui.setStatus("seref_manager", undefined);
			return;
		}
		const counts = countItems(loop.startSnapshot);
		const flags = [
			loop.paused ? "paused" : "",
			loop.quotaWait ? `usage limit, resumes ${formatClock(loop.quotaWait.until, Date.now())}` : "",
			loop.away ? "away" : "",
		]
			.filter(Boolean)
			.join(" · ");
		ctx.ui.setStatus(
			"seref_manager",
			`seref ${loop.iteration}/${loop.max} · ${counts.done} done ${counts.blocked} blocked ${counts.open} open${flags ? ` · ${flags}` : ""}`,
		);
	};

	/** Usage of the account pool behind `provider`/`model`, from omp's usage reports and credential blocks (what `/usage` shows). */
	const usageHealth = async (ctx: ExtensionContext, provider: string, model: string): Promise<RoleUsage> => {
		try {
			const health = await ctx.modelRegistry.authStorage.health.model(provider, {
				modelId: model,
				sessionId: ctx.sessionManager.getSessionId(),
				reserveFraction: 0,
				signal: AbortSignal.timeout(20_000),
			});
			const resets = health.accounts.flatMap(account =>
				account.state === "depleted" && account.resetsAt !== undefined ? [account.resetsAt] : [],
			);
			const remaining = health.accounts.flatMap(account =>
				account.state !== "depleted" && account.remainingFraction !== undefined ? [account.remainingFraction] : [],
			);
			return {
				state: health.state,
				resets,
				bestRemaining: remaining.length > 0 ? Math.max(...remaining) : undefined,
			};
		} catch {
			return { state: "unknown", resets: [] };
		}
	};

	/**
	 * The manager model for the next call. Only ever the manager's own model: when the usage
	 * reports (what `/usage` shows) say every account behind it is out, it throws with the earliest
	 * account reset, and the loop waits for that instead of making a call that would fail.
	 */
	const pickManager = async (ctx: ExtensionContext, loop: LoopState): Promise<ManagerTarget> => {
		const target = resolveManagerModel(ctx, settings, loop.modelSpec);
		const usage = await usageHealth(ctx, target.model.provider, target.model.id);
		if (usage.state !== "depleted") return target;
		const resets = usage.resets.filter(reset => reset > Date.now());
		throw new UsageDepletedError(target.model.provider, target.model.id, resets.length > 0 ? Math.min(...resets) : undefined);
	};

	/**
	 * One `/usage`-style line per model the loop spends quota on: the worker (session model), its
	 * subagents (`task` role) when that is another model, and the manager role.
	 */
	const roleUsageLines = async (ctx: ExtensionContext, loop: LoopState): Promise<string[]> => {
		const now = Date.now();
		const worker = ctx.models.current();
		const roles: { label: string; provider: string; id: string }[] = [];
		if (worker) roles.push({ label: "worker", provider: worker.provider, id: worker.id });
		try {
			const task = resolveManagerModel(ctx, settings, "@task").model;
			if (!worker || task.provider !== worker.provider || task.id !== worker.id) {
				roles.push({ label: "subagents (task role)", provider: task.provider, id: task.id });
			}
		} catch {
			// No task role configured; subagents use the worker's model.
		}
		const manager = resolveManagerModel(ctx, settings, loop.modelSpec).model;
		roles.push({ label: "manager", provider: manager.provider, id: manager.id });
		const usages = await Promise.all(roles.map(role => usageHealth(ctx, role.provider, role.id)));
		return roles.map((role, index) => `usage · ${role.label} ${role.provider}/${role.id}: ${describeUsage(usages[index], now)}`);
	};

	const armQuotaTimer = (ctx: ExtensionContext, loop: LoopState): void => {
		clearQuotaTimer(ctx, loop);
		const wait = loop.quotaWait;
		if (!wait) return;
		const delay = Math.max(1_000, Math.min(wait.until - Date.now(), QUOTA_TIMER_MAX_MS));
		loop.quotaTimer = ctx.setTimeout(() => {
			loop.quotaTimer = undefined;
			if (state !== loop || loop.paused || loop.quotaWait !== wait) return;
			if (Date.now() < wait.until) armQuotaTimer(ctx, loop);
			else void wakeFromQuota(ctx, loop, false);
		}, delay);
	};

	/**
	 * Stop driving the loop until the usage limit that `phase` hit resets: compute when (usage
	 * report, provider hint, omp's estimate, else a 30-minute probe), save it, and arm a timer.
	 * Not a failure: no counter moves, and the iteration resumes where it stopped.
	 */
	const enterQuotaWait = async (
		ctx: ExtensionContext,
		loop: LoopState,
		phase: "worker" | "manager" | "audit",
		error: QuotaError | UsageDepletedError,
	): Promise<void> => {
		const current = ctx.models.current();
		const provider = error.provider ?? current?.provider ?? "unknown";
		const model = error.model ?? current?.id ?? "unknown";
		const health = await usageHealth(ctx, provider, model);
		if (state !== loop || loop.paused) return;
		const now = Date.now();
		const ompWaitMs = phase === "worker" && ompGiveUp && now - ompGiveUp.at < OMP_GIVE_UP_FRESH_MS ? ompGiveUp.waitMs : undefined;
		const known = error instanceof UsageDepletedError && error.until !== undefined ? [error.until] : [];
		const { at, source } = chooseResumeAt({
			now,
			accountResets: [...known, ...health.resets],
			hintMs: error instanceof UsageDepletedError ? undefined : providerHintMs(error),
			ompWaitMs,
		});
		loop.quotaWait = { until: at, phase, provider, model, source };
		persist(loop);
		updateStatus(ctx);
		const who = phase === "worker" ? "the worker" : phase === "manager" ? "the manager's review" : "the audit";
		log(
			loop,
			`## Usage limit (${who}, iteration ${loop.iteration})\n\n${provider}/${model}: ${error instanceof UsageDepletedError ? "out of quota per the usage report" : (error.errorMessage ?? "usage limit")}\nResumes ${new Date(at).toISOString()} (${source}).`,
		);
		ctx.ui.notify(
			`seref_manager: ${provider}/${model} ${error instanceof UsageDepletedError ? "is out of quota" : "hit its usage limit"} during ${who}. Waiting until ${formatClock(at, now)} (${source}), then the loop continues by itself. /seref_manager resume tries now, /seref_manager stop ends the loop.`,
			"warning",
		);
		phone(
			loop,
			3,
			["hourglass_flowing_sand"],
			`${provider}/${model} ${error instanceof UsageDepletedError ? "is out of quota" : "hit its usage limit"} during ${who}. The loop continues by itself at ${formatClock(at, now)} (${source}).`,
		);
		armQuotaTimer(ctx, loop);
	};

	/** The wait is due (or `force`d by `resume`): re-check the account, then continue what stopped. */
	const wakeFromQuota = async (ctx: ExtensionContext, loop: LoopState, force: boolean): Promise<void> => {
		const wait = loop.quotaWait;
		if (!wait || state !== loop) return;
		if (!force) {
			const health = await usageHealth(ctx, wait.provider, wait.model);
			const later = health.state === "depleted" ? health.resets.filter(reset => reset > Date.now() + 60_000) : [];
			if (state !== loop || loop.paused || loop.quotaWait !== wait) return;
			if (later.length > 0) {
				loop.quotaWait = { ...wait, until: Math.min(...later) + 60_000, source: "usage report" };
				persist(loop);
				updateStatus(ctx);
				log(loop, `Usage limit still exhausted; next try ${new Date(loop.quotaWait.until).toISOString()}.`);
				armQuotaTimer(ctx, loop);
				return;
			}
		}
		if (!ctx.isIdle()) {
			// Someone is using the session right now; try again in a minute.
			loop.quotaWait = { ...wait, until: Date.now() + 60_000 };
			armQuotaTimer(ctx, loop);
			return;
		}
		loop.quotaWait = undefined;
		clearQuotaTimer(ctx, loop);
		persist(loop);
		updateStatus(ctx);
		log(loop, `Usage limit wait over; resuming ${wait.phase === "worker" ? `iteration ${loop.iteration}` : wait.phase}.`);
		ctx.ui.notify(`seref_manager: usage limit wait over (${wait.provider}/${wait.model}); continuing.`, "info");
		phone(loop, 2, ["arrow_forward"], `Usage limit over for ${wait.provider}/${wait.model}; the loop continues.`);
		if (wait.phase === "worker") {
			const prompt = `[seref_manager · iteration ${loop.iteration}/${loop.max}] ${QUOTA_RESUME_PROMPT}`;
			lastSentPrompt = prompt;
			pi.sendUserMessage(prompt, { attribution: "agent" });
		} else if (wait.phase === "manager") {
			void advance(ctx);
		} else {
			void auditThenStart(ctx, loop);
		}
	};

	/**
	 * Push one event to the phone through ntfy, titled with the project (the ledger's directory) and
	 * ledger. Config is re-read each time, so editing it applies at once; no config, no message.
	 */
	const phone = (loop: LoopState, priority: NtfyPriority, tags: string[], message: string): void => {
		const config = loadNtfyConfig();
		if (!config) return;
		const title = `${path.basename(path.dirname(loop.ledgerPath))} · ${path.basename(loop.ledgerPath)} · it ${loop.iteration}/${loop.max}`;
		void sendNtfy(config, { title, message, priority, tags }).then(failure => {
			if (failure) log(loop, `ntfy notification failed: ${failure}`);
		});
	};

	const FINISH_PHONE: Record<"info" | "warning" | "error", { priority: NtfyPriority; tag: string }> = {
		info: { priority: 3, tag: "white_check_mark" },
		warning: { priority: 4, tag: "warning" },
		error: { priority: 5, tag: "rotating_light" },
	};

	/** End the loop. `alert: false` for endings the user caused, which need no phone message. */
	const finish = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", alert = true): void => {
		const loop = state;
		if (!loop) return;
		state = undefined;
		loop.abort.abort();
		clearQuotaTimer(ctx, loop);
		releaseUsageWaits();
		persist(undefined);
		log(loop, `## Loop ended after iteration ${loop.iteration}\n\n${message}`);
		updateStatus(ctx);
		ctx.ui.notify(`seref_manager: ${message}`, level);
		if (alert) phone(loop, FINISH_PHONE[level].priority, [FINISH_PHONE[level].tag], `Loop ended: ${message}`);
	};

	/** Pause the loop. `alert: false` for pauses the user caused (the pause command, Esc). */
	const pause = (ctx: ExtensionContext, message: string, alert = true): void => {
		const loop = state;
		if (!loop) return;
		loop.paused = true;
		loop.abort.abort();
		loop.abort = new AbortController();
		clearQuotaTimer(ctx, loop);
		persist(loop);
		updateStatus(ctx);
		ctx.ui.notify(`seref_manager: ${message}`, "warning");
		if (alert) phone(loop, 4, ["pause_button"], `Loop paused: ${message}`);
	};

	const runGate = async (loop: LoopState): Promise<{ code: number; summary: string }> => {
		const result = await pi.exec(GATE, [loop.ledgerPath], { cwd: loop.cwd, timeout: GATE_TIMEOUT_MS });
		const summary = (result.stderr.trim() || result.stdout.trim()).replace(/^seref-loop-gate: /, "");
		return { code: result.killed ? -1 : result.code, summary: summary || "(no output)" };
	};

	const startIteration = (ctx: ExtensionContext, loop: LoopState, snapshot: LedgerSnapshot, notes: string[]): void => {
		loop.iteration++;
		loop.startLeafId = ctx.sessionManager.getLeafId();
		loop.startSnapshot = snapshot;
		persist(loop);
		let prompt = PROMPT_WORKER.replaceAll("{{iteration}}", String(loop.iteration))
			.replaceAll("{{max}}", String(loop.max))
			.replaceAll("{{ledger}}", displayPath(loop.cwd, loop.ledgerPath))
			.replaceAll("{{decisions}}", loop.askAvailable ? DECISIONS_WITH_ASK : DECISIONS_WITHOUT_ASK);
		if (notes.length > 0) {
			const source = loop.iteration === 1 ? "the audit" : `iteration ${loop.iteration - 1}`;
			prompt += `\n\nManager notes from ${source}:\n${notes.join("\n")}`;
		}
		updateStatus(ctx);
		lastSentPrompt = prompt.trim();
		pi.sendUserMessage(prompt, { attribution: "agent" });
	};

	/** Ask the manager to review the iteration; undefined after a failed retry (the loop continues unguided). */
	const reviewIteration = async (
		ctx: ExtensionContext,
		loop: LoopState,
		ledgerText: string,
		changes: { item: LedgerItem; from?: string }[],
		gateSummary: string,
		gatePassed: boolean,
	): Promise<IterationVerdict | undefined> => {
		const target = await pickManager(ctx, loop);
		const usage = ctx.getContextUsage();
		const input = [
			`# Iteration ${loop.iteration} of ${loop.max}`,
			gatePassed
				? `Gate: ${gateSummary}. The gate passes: the loop ends now unless you reopen or unblock an item.`
				: `Gate: ${gateSummary}`,
			usage && usage.contextWindow > 0
				? `Worker context: ${Math.round((usage.tokens / usage.contextWindow) * 100)}% of ${usage.contextWindow} tokens.`
				: "",
			loop.contextPolicy === "manager" ? "" : `Context policy is fixed to "${loop.contextPolicy}"; your "context" choice is ignored.`,
			`## Items whose state changed this iteration\n${changes.length > 0 ? changes.map(change => `${change.item.line}  (was ${change.from ?? "absent"})`).join("\n") : "(none)"}`,
			`## Your earlier decisions\n${loop.history.length > 0 ? loop.history.join("\n") : "(none)"}`,
			`## Ledger (${displayPath(loop.cwd, loop.ledgerPath)})\n${ledgerText}`,
			`## Transcript of iteration ${loop.iteration}\n${digestIteration(ctx.sessionManager.getBranch(), loop.startLeafId, ITERATION_DIGEST_CHARS) || "(empty)"}`,
		]
			.filter(Boolean)
			.join("\n\n");
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const verdict = parseIterationVerdict(await callManager(ctx, target, PROMPT_ITERATION, input, loop.abort.signal));
				loop.managerFailures = 0;
				return verdict;
			} catch (error) {
				// A usage limit is not the manager failing: advance() turns it into a wait.
				if (loop.abort.signal.aborted || usageLimitError(error)) throw error;
				lastError = error;
			}
		}
		loop.managerFailures++;
		log(loop, `## Iteration ${loop.iteration}: manager failed\n\n${errorText(lastError)}`);
		if (loop.managerFailures >= MANAGER_FAILURE_LIMIT) {
			throw new Error(`manager failed ${loop.managerFailures} iterations in a row (${errorText(lastError)})`);
		}
		ctx.ui.notify(`seref_manager: review failed (${errorText(lastError)}); continuing without guidance`, "warning");
		return undefined;
	};

	const waitForIdle = async (ctx: ExtensionContext): Promise<boolean> => {
		for (let poll = 0; poll < IDLE_POLL_LIMIT; poll++) {
			if (ctx.isIdle()) return !ctx.hasPendingMessages();
			await Bun.sleep(IDLE_POLL_MS);
		}
		return false;
	};

	/**
	 * Start the next iteration in a fresh session. Only a command context can do that, so the
	 * loop keeps the one from the last `run`/`resume`. Returns false when the loop must not go on.
	 */
	const resetSession = async (ctx: ExtensionContext, loop: LoopState): Promise<boolean> => {
		const command = loop.commandCtx;
		if (!command) {
			ctx.ui.notify("seref_manager: no command context to start a new session; compacting instead", "warning");
			await ctx.compact({ suppressContinuation: true });
			return state === loop && !loop.paused;
		}
		loop.resetting = true;
		try {
			const result = await command.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
			if (result.cancelled) {
				pause(ctx, "starting a fresh session was cancelled; loop paused.");
				return false;
			}
		} finally {
			loop.resetting = false;
		}
		log(loop, `Fresh session for iteration ${loop.iteration + 1}: ${ctx.sessionManager.getSessionFile() ?? "(in memory)"}`);
		return state === loop && !loop.paused;
	};

	/**
	 * One iteration boundary: gate → stop rules → manager review → ledger edits → context
	 * (keep/compact/reset) → next prompt. A passing gate still gets a review when the iteration
	 * changed items, so the final ticks and blockers are checked like any other; the loop then
	 * ends unless the manager reopened one.
	 */
	const advance = async (ctx: ExtensionContext): Promise<void> => {
		const loop = state;
		if (!loop || loop.paused || loop.busy || loop.quotaWait) return;
		loop.busy = true;
		try {
			// Queued user messages run first; their own agent_end brings us back here.
			if (!(await waitForIdle(ctx)) || state !== loop || loop.paused) return;
			const gate = await runGate(loop);
			if (gate.code !== 0 && gate.code !== 1) {
				return finish(ctx, `gate error, exit ${gate.code}: ${gate.summary}. Loop stopped.`, "error");
			}
			const gatePassed = gate.code === 0;
			const done = `gate passed (${gate.summary}). Done after ${loop.iteration} iterations.`;

			const ledgerText = await Bun.file(loop.ledgerPath).text();
			const after = parseLedger(ledgerText);
			const changes = changedItems(loop.startSnapshot, after);
			for (const change of changes) {
				if (change.item.state === "blocked") phone(loop, 4, ["raised_hand"], `Blocked, needs you: ${change.item.line.replace(/^- \[!\] /, "")}`);
			}
			if (gatePassed && changes.length === 0) return finish(ctx, done, "info");
			// Counted only once the review is through: a review retried after a usage limit is the same iteration.
			const noProgress = progressKey(after) === progressKey(loop.startSnapshot) ? loop.noProgress + 1 : 0;
			if (!gatePassed && loop.iteration >= loop.max) {
				return finish(ctx, `iteration limit ${loop.max} reached (${gate.summary}).`, "warning");
			}
			if (!gatePassed && noProgress >= NO_PROGRESS_LIMIT) {
				return finish(ctx, `stuck: ${noProgress} iterations without any ledger change (${gate.summary}).`, "warning");
			}

			const verdict = await reviewIteration(ctx, loop, ledgerText, changes, gate.summary, gatePassed);
			loop.noProgress = noProgress;
			if (state !== loop || loop.paused) return;
			if (gatePassed && !verdict) return finish(ctx, done, "info");
			const notes: string[] = [];
			let snapshot = after;
			if (verdict) {
				const edited = applyEdits(ledgerText, verdict.edits, `it${loop.iteration}`);
				if (edited.applied.length > 0) {
					await Bun.write(loop.ledgerPath, edited.text);
					snapshot = parseLedger(edited.text);
				}
				for (const edit of edited.applied) {
					if (edit.kind === "reopen") loop.reopenCounts[edit.id] = (loop.reopenCounts[edit.id] ?? 0) + 1;
					notes.push(`- ${edit.id} ${edit.kind === "reopen" ? "was reopened" : "blocker was rejected"}: ${edit.reason}`);
				}
				for (const answer of verdict.answers) notes.push(`- Your question "${answer.question}": ${answer.answer}`);
				if (verdict.guidance) notes.push(`- ${verdict.guidance}`);
				const summary = [
					`it${loop.iteration}: ${verdict.verdict}, ${verdict.reason}`,
					edited.applied.length > 0 ? `edited ${edited.applied.map(edit => `${edit.id} (${edit.kind})`).join(", ")}` : "",
					verdict.answers.length > 0 ? `answered ${verdict.answers.length} question(s)` : "",
					verdict.context === "keep" ? "" : verdict.context,
				]
					.filter(Boolean)
					.join("; ");
				loop.history = [...loop.history, `- ${summary}`].slice(-HISTORY_KEEP);
				log(
					loop,
					[
						`## Iteration ${loop.iteration} (gate: ${gate.summary})`,
						`Verdict: ${verdict.verdict}. ${verdict.reason}`,
						...edited.applied.map(edit => `- ${edit.kind} ${edit.id}: ${edit.reason}`),
						...edited.skipped.map(skip => `- skipped ${skip.edit.kind} ${skip.edit.id}: ${skip.why}`),
						...verdict.answers.map(answer => `- Q: ${answer.question}\n  A: ${answer.answer}`),
						verdict.guidance ? `Guidance: ${verdict.guidance}` : "",
						`Context: ${verdict.context}${loop.contextPolicy === "manager" ? "" : ` (policy: ${loop.contextPolicy})`}`,
					]
						.filter(Boolean)
						.join("\n"),
				);
				if (gatePassed && edited.applied.length === 0) return finish(ctx, `${done} The manager accepted the final iteration.`, "info");
				if (loop.iteration >= loop.max) {
					return finish(ctx, `iteration limit ${loop.max} reached after the manager reopened items.`, "warning");
				}
				const overReopened = Object.entries(loop.reopenCounts).find(([, count]) => count >= REOPEN_LIMIT);
				if (overReopened) {
					return finish(ctx, `stuck: ${overReopened[0]} was reopened ${overReopened[1]} times. Check its evidence yourself.`, "warning");
				}
				if (verdict.verdict === "stuck") return finish(ctx, `stuck: ${verdict.reason}`, "warning");
			}

			const contextAction = loop.contextPolicy === "manager" ? (verdict?.context ?? "keep") : loop.contextPolicy;
			if (contextAction === "compact") {
				try {
					await ctx.compact({ suppressContinuation: true });
				} catch (error) {
					ctx.ui.notify(`seref_manager: compaction failed (${errorText(error)}); continuing uncompacted`, "warning");
				}
				if (state !== loop || loop.paused) return;
			} else if (contextAction === "reset" && !(await resetSession(ctx, loop))) {
				return;
			}
			startIteration(ctx, loop, snapshot, notes);
		} catch (error) {
			const quota = error instanceof UsageDepletedError ? error : usageLimitError(error);
			if (quota && state === loop && !loop.paused) void enterQuotaWait(ctx, loop, "manager", quota);
			else if (state === loop && !loop.paused) pause(ctx, `${errorText(error)}. Loop paused; /seref_manager resume retries.`);
		} finally {
			loop.busy = false;
		}
	};

	const answerAsk = async (
		ctx: ExtensionContext,
		loop: LoopState,
		questions: AskQuestion[],
		signal: AbortSignal | undefined,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> => {
		const combined = AbortSignal.any([loop.abort.signal, ...(signal ? [signal] : [])]);
		let answers: AskAnswer[] | undefined;
		let failure: unknown;
		try {
			const target = await pickManager(ctx, loop);
			const ledgerText = await Bun.file(loop.ledgerPath)
				.text()
				.catch(() => "(ledger unreadable)");
			const input = [
				`## Questions\n${JSON.stringify(questions, null, 2)}`,
				`## Ledger (${displayPath(loop.cwd, loop.ledgerPath)})\n${ledgerText}`,
				`## Transcript of the current iteration (${loop.iteration})\n${digestIteration(ctx.sessionManager.getBranch(), loop.startLeafId, ASK_DIGEST_CHARS) || "(empty)"}`,
			].join("\n\n");
			for (let attempt = 0; attempt < 2 && !answers; attempt++) {
				try {
					answers = parseAskAnswers(await callManager(ctx, target, PROMPT_ASK, input, combined), questions);
				} catch (error) {
					if (combined.aborted) throw error;
					failure = error;
				}
			}
		} catch (error) {
			if (signal?.aborted) throw new Error("Ask input was cancelled");
			failure = error;
		}

		if (!answers) {
			const quota = failure instanceof UsageDepletedError || usageLimitError(failure) !== undefined;
			log(loop, `## Iteration ${loop.iteration}: ask unanswered (manager failed: ${errorText(failure)})`);
			ctx.ui.notify(`seref_manager: could not answer ask (${errorText(failure)})`, "warning");
			const text = quota
				? `Nobody is at the keyboard and the loop manager is out of its usage limit, so this is not decided. Mark the current item "- [!] … — BLOCKED: awaiting user: <your question>" and continue with the next open item.`
				: `Nobody is at the keyboard and the loop manager could not answer (${errorText(failure)}). Take the conservative default, record the choice in the item's evidence, and continue.`;
			return { content: [{ type: "text", text }], details: {} };
		}

		const lines = answers.map(answer => {
			if (!answer.decided) {
				return `${answer.id}: NOT DECIDED (${answer.why}). Mark the current item "- [!] … — BLOCKED: awaiting user: ${answer.question}" and continue with the next open item.`;
			}
			const choice = [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(", ");
			return `${answer.id}: ${choice}${answer.why ? ` (manager: ${answer.why})` : ""}`;
		});
		log(
			loop,
			[
				`## Iteration ${loop.iteration}: answered ask`,
				...answers.map(
					answer =>
						`- Q (${answer.id}): ${answer.question}\n  A: ${answer.decided ? [...answer.selected, answer.custom ?? ""].filter(Boolean).join(", ") : "NOT DECIDED"} — ${answer.why}`,
				),
			].join("\n"),
		);
		ctx.ui.notify(`seref_manager answered ask: ${lines.join(" | ")}`, "info");
		for (const answer of answers) {
			if (answer.decided) {
				phone(loop, 2, ["speech_balloon"], `Answered for you: ${answer.question} → ${[...answer.selected, answer.custom ?? ""].filter(Boolean).join(", ")} (${answer.why})`);
			} else {
				phone(loop, 4, ["raised_hand"], `Needs your decision: ${answer.question} (${answer.why}). The worker marks the item blocked and moves on.`);
			}
		}
		const results = answers.map((answer, index) => ({
			id: answer.id,
			question: answer.question,
			options: questions[index].options.map(option => option.label),
			multi: questions[index].multi === true,
			selectedOptions: answer.selected,
			customInput: answer.custom,
			note: `seref_manager${answer.decided ? "" : " (not decided)"}: ${answer.why}`,
		}));
		return {
			content: [{ type: "text", text: `Nobody is at the keyboard; seref_manager answered for the user.\n${lines.join("\n")}` }],
			details: results.length === 1 ? results[0] : { results },
		};
	};

	/**
	 * Shadow the built-in `ask` with the native schema, description and renderer. Outside an
	 * active loop it delegates unchanged; inside one, the native dialog gets `graceMs` before the
	 * manager answers. Registered on the first `run` or restore, so sessions that never use the
	 * loop are untouched.
	 */
	const shadowAsk = (): boolean => {
		if (askShadowed) return true;
		const native = pi.getAllTools().find(tool => tool.name === "ask");
		if (!native) return false;
		pi.registerTool({
			name: "ask",
			label: "Ask",
			description: native.description,
			parameters: native.parameters,
			approval: "read",
			...ASK_RENDERING,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const run = askQueue.then(async () => {
					const loop = state;
					const invokeNative = ctx.invokeTool;
					if (!loop || loop.paused) {
						if (!invokeNative) throw new Error("Ask tool requires interactive mode");
						return invokeNative(params, { signal, onUpdate });
					}
					const questions: AskQuestion[] = params.questions;
					const graceMs = loop.away ? 0 : loop.graceMs;
					if (invokeNative && graceMs > 0) {
						const dialog = new AbortController();
						const forward = (): void => dialog.abort();
						signal?.addEventListener("abort", forward, { once: true });
						let timer: Timer | undefined;
						const graceOver = new Promise<"grace">(resolve => {
							timer = setTimeout(() => resolve("grace"), graceMs);
						});
						const human = invokeNative(params, { signal: dialog.signal, onUpdate }).then(
							result => ({ kind: "answered" as const, result }),
							(error: unknown) => ({ kind: "failed" as const, error }),
						);
						const first = await Promise.race([human, graceOver]);
						clearTimeout(timer);
						signal?.removeEventListener("abort", forward);
						if (first !== "grace") {
							if (first.kind === "answered") return first.result;
							throw first.error;
						}
						dialog.abort();
						await human;
					}
					if (signal?.aborted) throw new Error("Ask input was cancelled");
					return answerAsk(ctx, loop, questions, signal);
				});
				askQueue = run.catch(() => undefined);
				return run;
			},
		});
		askShadowed = true;
		return true;
	};

	/** Bring back a loop saved in the current session, paused, so nothing runs until `resume`. */
	const restore = (ctx: ExtensionContext): void => {
		if (state || ctx.agent.kind !== "main") return;
		const saved = latestPersistedEntry(ctx.sessionManager.getBranch())?.loop;
		if (!saved) return;
		if (!fs.existsSync(saved.ledgerPath)) {
			ctx.ui.notify(`seref_manager: this session had a loop on ${saved.ledgerPath}, but the ledger is gone; not restored`, "warning");
			return;
		}
		// A loop that was waiting out a usage limit keeps waiting and continues by itself;
		// anything else comes back paused until `resume`.
		const waiting = saved.quotaWait !== undefined && !saved.paused;
		state = {
			...saved,
			paused: !waiting,
			busy: false,
			resetting: false,
			commandCtx: undefined,
			askAvailable: shadowAsk(),
			abort: new AbortController(),
			quotaTimer: undefined,
		};
		updateStatus(ctx);
		if (waiting && saved.quotaWait) {
			holdUsageWaits();
			armQuotaTimer(ctx, state);
			ctx.ui.notify(
				`seref_manager: restored the loop on ${displayPath(ctx.cwd, saved.ledgerPath)} at iteration ${saved.iteration}/${saved.max}; it is waiting for the ${saved.quotaWait.provider} usage limit and continues by itself at ${formatClock(saved.quotaWait.until, Date.now())}. /seref_manager pause holds it, /seref_manager stop ends it.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`seref_manager: restored the loop on ${displayPath(ctx.cwd, saved.ledgerPath)} at iteration ${saved.iteration}/${saved.max}, paused. /seref_manager resume continues, /seref_manager stop ends it.`,
			"info",
		);
	};

	const repoRoot = async (cwd: string): Promise<string> => {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
	};

	/** The ledger in the working directory or repo root; asks which one when there are several. */
	const pickLedger = async (ctx: ExtensionContext, root: string): Promise<string> => {
		const dirs = root === ctx.cwd ? [ctx.cwd] : [ctx.cwd, root];
		const found = findLedgers(dirs);
		if (found.length === 0) {
			throw new Error(`no LOOP_*.md in ${dirs.join(" or ")}; write one with /seref_loop or pass its path`);
		}
		if (found.length === 1) return found[0];
		const labels = found.map(file => {
			const snapshot = parseLedger(fs.readFileSync(file, "utf8"));
			const counts = countItems(snapshot);
			return `${displayPath(ctx.cwd, file)}  (${snapshot.status ?? "no STATUS"}: ${counts.done} done, ${counts.blocked} blocked, ${counts.open} open)`;
		});
		if (!ctx.hasUI) throw new Error(`several ledgers here, pass one: ${found.map(file => displayPath(ctx.cwd, file)).join(", ")}`);
		const choice = await ctx.ui.select("Which ledger should seref_manager run?", labels);
		const index = choice === undefined ? -1 : labels.indexOf(choice);
		if (index === -1) throw new Error("no ledger chosen");
		return found[index];
	};

	/**
	 * Check every `[x]`/`[!]` item the manager did not supervise, with tools: read the code, git
	 * history, run the ledger's own checks. Reopens what does not hold and rejects weak blockers.
	 * Returns notes for the first worker prompt.
	 */
	const runAudit = async (ctx: ExtensionContext, loop: LoopState): Promise<string[]> => {
		const ledgerText = await Bun.file(loop.ledgerPath).text();
		const items = parseLedger(ledgerText).items.filter(item => item.state !== "open");
		if (items.length === 0) return [];
		const target = await pickManager(ctx, loop);
		const root = await repoRoot(loop.cwd);
		ctx.ui.notify(
			`seref_manager: auditing ${items.length} item(s) ticked or blocked before it took over, with ${describeTarget(target)}. /seref_manager pause stops it.`,
			"info",
		);
		const input = [
			`## Items to audit\n${items.map(item => item.line).join("\n")}`,
			`## Commands run_check may run (backticked in the ledger)\n${[...ledgerCommands(ledgerText)].map(command => `- ${command}`).join("\n") || "(none)"}`,
			`## Repository root\n${root}`,
			`## Ledger (${displayPath(root, loop.ledgerPath)})\n${ledgerText}`,
		].join("\n\n");
		let callCount = 0;
		const { text, calls } = await callManagerWithTools(
			ctx,
			target,
			PROMPT_AUDIT,
			input,
			AbortSignal.any([loop.abort.signal, AbortSignal.timeout(AUDIT_TIMEOUT_MS)]),
			{
				tools: MANAGER_TOOLS,
				execute: (name, args, signal) =>
					runManagerTool(name, args, { root, ledgerText: () => fs.readFileSync(loop.ledgerPath, "utf8"), signal }),
				maxCalls: AUDIT_TOOL_CALLS,
				onCall: record => ctx.ui.setStatus("seref_manager", `seref audit · ${++callCount} tool calls · last: ${record.name}`),
			},
		);
		const verdict = parseAuditVerdict(text);
		const edited = applyEdits(await Bun.file(loop.ledgerPath).text(), verdict.edits, "audit");
		if (edited.applied.length > 0) await Bun.write(loop.ledgerPath, edited.text);
		for (const edit of edited.applied) {
			if (edit.kind === "reopen") loop.reopenCounts[edit.id] = (loop.reopenCounts[edit.id] ?? 0) + 1;
		}
		const tally = (result: string): number => verdict.checks.filter(check => check.result === result).length;
		const reopened = edited.applied.filter(edit => edit.kind === "reopen").map(edit => edit.id);
		const unblocked = edited.applied.filter(edit => edit.kind === "unblock").map(edit => edit.id);
		const summary = `${tally("holds")} hold, ${reopened.length} reopened${reopened.length ? ` (${reopened.join(", ")})` : ""}, ${tally("unverifiable")} unverifiable, ${tally("keep")} blockers kept, ${unblocked.length} unblocked${unblocked.length ? ` (${unblocked.join(", ")})` : ""}`;
		log(
			loop,
			[
				`## Audit of unsupervised items (${calls.length} tool calls)`,
				verdict.summary,
				...verdict.checks.map(check => `- ${check.id}: ${check.result}. ${check.how}`),
				...edited.skipped.map(skip => `- skipped ${skip.edit.kind} ${skip.edit.id}: ${skip.why}`),
				"",
				"Tool calls:",
				...calls.map(call => `- ${call.name} ${call.args} → ${call.isError ? "ERROR " : ""}${call.summary}`),
			].join("\n"),
		);
		loop.history = [...loop.history, `- audit: ${summary}`].slice(-HISTORY_KEEP);
		ctx.ui.notify(`seref_manager: audit done: ${summary}. ${verdict.summary}`, reopened.length > 0 ? "warning" : "info");
		phone(loop, reopened.length > 0 ? 3 : 2, ["mag"], `Audit of earlier ticks: ${summary}. ${verdict.summary}`);
		return edited.applied.map(
			edit => `- ${edit.id} ${edit.kind === "reopen" ? "was reopened by the manager's audit" : "blocker was rejected by the manager's audit"}: ${edit.reason}`,
		);
	};

	/** Audit (unless done already), then start iteration 1, or finish when the gate passes after all. */
	const auditThenStart = async (ctx: ExtensionContext, loop: LoopState): Promise<void> => {
		try {
			const notes = loop.audited ? [] : await runAudit(ctx, loop);
			if (state !== loop || loop.paused) return;
			loop.audited = true;
			const gate = await runGate(loop);
			if (gate.code === 0) return finish(ctx, `gate passes after the audit (${gate.summary}); nothing left to run.`, "info");
			if (gate.code !== 1) return finish(ctx, `gate error, exit ${gate.code}: ${gate.summary}. Loop stopped.`, "error");
			startIteration(ctx, loop, parseLedger(await Bun.file(loop.ledgerPath).text()), notes);
		} catch (error) {
			const quota = error instanceof UsageDepletedError ? error : usageLimitError(error);
			if (quota && state === loop && !loop.paused) void enterQuotaWait(ctx, loop, "audit", quota);
			else if (state === loop && !loop.paused) {
				pause(ctx, `audit failed: ${errorText(error)}. /seref_manager resume retries it; run with --no-audit to skip it.`);
			}
		}
	};

	const startRun = async (ctx: ExtensionCommandContext, tokens: string[]): Promise<void> => {
		if (state) throw new Error(`a loop is already running on ${displayPath(ctx.cwd, state.ledgerPath)}; /seref_manager stop first`);
		const args = parseRunArgs(tokens);
		if (builtinLoopLikelyOn && !args.force) {
			throw new Error(
				"omp's own /loop looks active in this session, and both loops would send a prompt after every turn. Type /loop to turn it off (the status line shows a Loop indicator while it is on); if it already ended by itself, add --force.",
			);
		}
		if (!fs.existsSync(GATE)) throw new Error(`gate not found at ${GATE} (set SEREF_LOOP_GATE)`);
		const ledgerPath = args.ledger
			? path.resolve(ctx.cwd, args.ledger.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
			: await pickLedger(ctx, await repoRoot(ctx.cwd));
		if (!fs.existsSync(ledgerPath)) throw new Error(`no ledger at ${ledgerPath}`);
		const target = resolveManagerModel(ctx, settings, args.model);

		const snapshot = parseLedger(await Bun.file(ledgerPath).text());
		const unsupervised = snapshot.items.filter(item => item.state !== "open").length;
		const audit = args.audit && unsupervised > 0;
		const loop: LoopState = {
			ledgerPath,
			cwd: ctx.cwd,
			iteration: 0,
			max: args.max ?? Math.max(MIN_DEFAULT_MAX, countItems(snapshot).total * 2),
			graceMs: (args.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000,
			away: args.away,
			modelSpec: args.model,
			contextPolicy: args.context,
			startLeafId: null,
			startSnapshot: snapshot,
			noProgress: 0,
			reopenCounts: {},
			managerFailures: 0,
			history: [],
			audited: !audit,
			quotaWait: undefined,
			paused: false,
			busy: false,
			resetting: false,
			commandCtx: ctx,
			askAvailable: false,
			abort: new AbortController(),
			quotaTimer: undefined,
		};
		const gate = await runGate(loop);
		if (gate.code !== 0 && gate.code !== 1) throw new Error(`gate exit ${gate.code}: ${gate.summary}`);
		if (gate.code === 0 && !audit) {
			ctx.ui.notify(`seref_manager: gate already passes (${gate.summary}) and there is nothing to audit; nothing to run`, "info");
			return;
		}
		loop.askAvailable = shadowAsk();
		holdUsageWaits();
		const askNote = loop.askAvailable
			? `ask answered after ${loop.away ? 0 : loop.graceMs / 1000}s`
			: "no ask tool in this session";
		const modelName = describeTarget(target);
		const usageLines = await roleUsageLines(ctx, loop);
		state = loop;
		log(
			loop,
			`# seref_manager run (${new Date().toISOString()})\n\nLedger: ${ledgerPath}\nMax iterations: ${loop.max}\nManager model: ${modelName}\nContext: ${loop.contextPolicy}\nStart: ${gate.summary}${audit ? `\nAudit: ${unsupervised} unsupervised item(s)` : ""}`,
		);
		ctx.ui.notify(
			[
				`seref_manager: running ${displayPath(ctx.cwd, ledgerPath)}, max ${loop.max} iterations, manager ${modelName}, context ${loop.contextPolicy}, ${askNote}. ${gate.summary}`,
				...usageLines,
			].join("\n"),
			"info",
		);
		phone(loop, 2, ["arrow_forward"], `Started: ${gate.summary}. Manager ${modelName}.${audit ? ` Auditing ${unsupervised} earlier tick(s) first.` : ""}`);
		if (audit) {
			persist(loop);
			updateStatus(ctx);
			void auditThenStart(ctx, loop);
		} else {
			startIteration(ctx, loop, snapshot, []);
		}
	};

	pi.registerCommand("seref_manager", {
		description: "AI-managed seref_loop: run a ledger with a manager that reviews each iteration and answers ask",
		getArgumentCompletions: prefix =>
			["run", "pause", "resume", "stop", "status", "away", "notify"]
				.filter(command => command.startsWith(prefix.trim()))
				.map(command => ({ value: command, label: command })),
		handler: async (args, ctx) => {
			settings ??= currentSettings();
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [command = "status", ...rest] = tokens;
			try {
				switch (command) {
					case "run":
						await startRun(ctx, rest);
						return;
					case "pause":
						if (!state) throw new Error("no loop is running");
						pause(ctx, "paused. /seref_manager resume continues.", false);
						return;
					case "resume": {
						const loop = state;
						if (!loop) throw new Error("no loop is running");
						if (!loop.paused && !loop.quotaWait) throw new Error("the loop is not paused");
						loop.paused = false;
						loop.commandCtx = ctx;
						holdUsageWaits();
						if (loop.quotaWait) {
							ctx.ui.notify("seref_manager: resumed; trying now instead of waiting for the usage limit reset", "info");
							void wakeFromQuota(ctx, loop, true);
							return;
						}
						persist(loop);
						updateStatus(ctx);
						ctx.ui.notify("seref_manager: resumed", "info");
						if (loop.iteration === 0) void auditThenStart(ctx, loop);
						else void advance(ctx);
						return;
					}
					case "stop":
						if (!state) throw new Error("no loop is running");
						finish(ctx, "stopped by the user.", "info", false);
						return;
					case "away": {
						const loop = state;
						if (!loop) throw new Error("no loop is running");
						const mode = rest[0];
						if (mode !== undefined && mode !== "on" && mode !== "off") throw new Error("away takes on or off");
						loop.away = mode === undefined ? !loop.away : mode === "on";
						persist(loop);
						updateStatus(ctx);
						ctx.ui.notify(
							`seref_manager: away ${loop.away ? "on: ask goes straight to the manager" : `off: ask waits ${loop.graceMs / 1000}s for you`}`,
							"info",
						);
						return;
					}
					case "notify": {
						const config = loadNtfyConfig();
						if (!config) {
							throw new Error(`no ntfy topic: set SEREF_NTFY_TOPIC or write {"topic": "…"} to ${NTFY_CONFIG_PATH}`);
						}
						const where = `${config.server}/${config.topic} (from ${config.origin}, min priority ${config.minPriority})`;
						if (rest[0] !== "test") {
							ctx.ui.notify(`seref_manager: phone notifications go to ${where}. /seref_manager notify test sends one.`, "info");
							return;
						}
						// The test always goes out, whatever minPriority filters.
						const failure = await sendNtfy({ ...config, minPriority: 1 }, {
							title: `${path.basename(ctx.cwd)} · seref_manager`,
							message: "Test notification: loop events from this machine arrive here.",
							priority: 3,
							tags: ["bell"],
						});
						if (failure) throw new Error(`test notification to ${where} failed: ${failure}`);
						ctx.ui.notify(`seref_manager: test notification sent to ${where}`, "info");
						return;
					}
					case "status": {
						const loop = state;
						if (!loop) {
							ctx.ui.notify(`seref_manager: no loop running.\n${USAGE}`, "info");
							return;
						}
						const counts = countItems(loop.startSnapshot);
						const target = resolveManagerModel(ctx, settings, loop.modelSpec);
						const usageLines = await roleUsageLines(ctx, loop);
						ctx.ui.notify(
							[
								`seref_manager: ${displayPath(ctx.cwd, loop.ledgerPath)}, iteration ${loop.iteration}/${loop.max}${loop.paused ? " (paused)" : ""}`,
								`${counts.done} done, ${counts.blocked} blocked, ${counts.open} open of ${counts.total}`,
								`manager: ${describeTarget(target)}; context: ${loop.contextPolicy}`,
								...usageLines,
								`ask: ${loop.away ? "manager answers at once" : `manager answers after ${loop.graceMs / 1000}s`}`,
								loop.quotaWait
									? `usage limit: ${loop.quotaWait.provider}/${loop.quotaWait.model} hit it during the ${loop.quotaWait.phase}; continues at ${formatClock(loop.quotaWait.until, Date.now())} (${loop.quotaWait.source})`
									: "",
								`log: ${displayPath(ctx.cwd, logPathFor(loop.ledgerPath))}`,
								...loop.history,
							].join("\n"),
							"info",
						);
						return;
					}
					default:
						throw new Error(`unknown subcommand "${command}"`);
				}
			} catch (error) {
				ctx.ui.notify(`seref_manager: ${errorText(error)}\n${USAGE}`, "error");
			}
		},
	});

	// omp's own /loop: keep it from starting while this loop drives, and track it for `run`.
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;
		const text = event.text.trim();
		if (/^\/loop(\s|$)/.test(text)) {
			// While on, `/loop` turns it off, which is always allowed; turning it on would double-drive.
			if (state && !builtinLoopLikelyOn) {
				ctx.ui.notify(
					"seref_manager: not starting omp's /loop while seref_manager drives this session; both would send a prompt after every turn. /seref_manager stop first.",
					"warning",
				);
				return { handled: true };
			}
			builtinLoopLikelyOn = !builtinLoopLikelyOn;
			return;
		}
		if (text.startsWith("/")) return;
		pendingTyped.set(text, (pendingTyped.get(text) ?? 0) + 1);
		everTyped.add(text);
	});

	// A run this loop did not send and nobody typed, repeating a typed prompt, is omp's /loop resubmitting.
	pi.on("before_agent_start", (event, ctx) => {
		const prompt = event.prompt.trim();
		if (prompt === lastSentPrompt) return;
		const pending = pendingTyped.get(prompt) ?? 0;
		if (pending > 0) {
			if (pending === 1) pendingTyped.delete(prompt);
			else pendingTyped.set(prompt, pending - 1);
			return;
		}
		const loop = state;
		if (!loop || loop.paused || !(everTyped.has(prompt) || builtinLoopLikelyOn)) return;
		builtinLoopLikelyOn = true;
		pause(
			ctx,
			`omp's /loop is also driving this session (it resubmitted "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"). Type /loop to turn it off, then /seref_manager resume.`,
		);
	});

	pi.on("agent_end", (event, ctx) => {
		const loop = state;
		if (!loop || loop.paused || loop.quotaWait || event.willContinue) return;
		const last = lastAssistant(event.messages);
		if (last?.stopReason === "aborted") {
			pause(ctx, "interrupted, loop paused. /seref_manager resume continues, /seref_manager stop ends it.", false);
			return;
		}
		if (last?.stopReason === "error") {
			const quota = usageLimitError(last.message);
			if (quota) {
				void enterQuotaWait(ctx, loop, "worker", quota);
				return;
			}
			pause(ctx, "the worker's turn ended with an error, loop paused. /seref_manager resume retries.");
			return;
		}
		ctx.setTimeout(() => advance(ctx), 0);
	});

	pi.on("session_start", (_event, ctx) => {
		settings = currentSettings();
		if (settings && ctx.agent.kind === "main") registerManagerRole(settings);
		restore(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		const loop = state;
		if (loop?.resetting) return;
		if (loop) {
			// The loop stays saved in the session it ran in; resuming that session restores it.
			loop.abort.abort();
			clearQuotaTimer(ctx, loop);
			releaseUsageWaits();
			state = undefined;
			updateStatus(ctx);
			ctx.ui.notify(`seref_manager: left the session running the loop on ${displayPath(ctx.cwd, loop.ledgerPath)}; resume that session to continue it.`, "warning");
		}
		restore(ctx);
	});

	// omp sleeping through a usage limit itself (retry.waitForUsageReset): show it on the status line.
	pi.on("auto_retry_start", (event, ctx) => {
		const loop = state;
		if (!loop || event.delayMs < 60_000 || !usageLimitError({ errorMessage: event.errorMessage, errorId: event.errorId })) return;
		const until = formatClock(Date.now() + event.delayMs, Date.now());
		ctx.ui.setStatus("seref_manager", `seref ${loop.iteration}/${loop.max} · usage limit, omp retries at ${until}`);
		log(loop, `omp is waiting out a usage limit inside iteration ${loop.iteration}; it retries at ${new Date(Date.now() + event.delayMs).toISOString()}.`);
	});

	// omp giving up on a usage limit: remember its estimate for the stop that follows.
	pi.on("auto_retry_end", (event, ctx) => {
		if (state) updateStatus(ctx);
		const waitMs = event.success ? undefined : ompWaitFromFinalError(event.finalError);
		ompGiveUp = waitMs !== undefined ? { waitMs, at: Date.now() } : undefined;
	});

	pi.on("session_shutdown", () => {
		state?.abort.abort();
		state = undefined;
	});
}
