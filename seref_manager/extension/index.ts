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
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";
import { applyEdits, changedItems, countItems, type LedgerItem, type LedgerSnapshot, parseLedger, progressKey } from "./ledger";
import { callManager, EFFORTS, type ManagerEffort, resolveManagerModel } from "./model";
import {
	CONTEXT_POLICIES,
	type ContextPolicy,
	latestPersistedEntry,
	type PersistedEntry,
	type PersistedLoop,
	STATE_ENTRY_TYPE,
} from "./state";
import { digestIteration, lastAssistant } from "./transcript";
import { type AskAnswer, type AskQuestion, type IterationVerdict, parseAskAnswers, parseIterationVerdict } from "./verdict";

const HERE = fs.realpathSync(import.meta.dir);
const GATE = process.env.SEREF_LOOP_GATE ?? path.resolve(HERE, "../../seref_loop/bin/seref-loop-gate");
const PROMPT_ITERATION = fs.readFileSync(path.join(HERE, "prompts/iteration.md"), "utf8");
const PROMPT_ASK = fs.readFileSync(path.join(HERE, "prompts/ask.md"), "utf8");
const PROMPT_WORKER = fs.readFileSync(path.join(HERE, "prompts/worker.md"), "utf8").trim();
const DECISIONS_WITH_ASK =
	"For a decision only the user can make, call `ask`: the loop manager answers it or tells you to mark the item blocked.";
const DECISIONS_WITHOUT_ASK =
	"There is no `ask` tool in this session: for a decision only the user can make, write the question in your final message; the loop manager answers it or tells you to mark the item blocked.";

const DEFAULT_GRACE_SECONDS = 120;
const DEFAULT_EFFORT: ManagerEffort = "medium";
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

/** The native ask renderer; `mergeCallAndResult` is not in ToolDefinition's type but is forwarded at runtime. */
const ASK_RENDERING = {
	renderCall: askToolRenderer.renderCall,
	renderResult: askToolRenderer.renderResult,
	describeCall: askToolRenderer.describeCall,
	describeResult: askToolRenderer.describeResult,
	mergeCallAndResult: true,
};

const USAGE = [
	"/seref_manager run <LOOP_X.md> [--max N] [--grace SECONDS] [--model SPEC[:effort]] [--context manager|keep|compact|reset] [--away]",
	"/seref_manager pause | resume | stop | status | away [on|off]",
].join("\n");

interface LoopState extends PersistedLoop {
	effort: ManagerEffort;
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
}

interface RunArgs {
	ledger: string;
	max?: number;
	graceSeconds?: number;
	model?: string;
	context: ContextPolicy;
	away: boolean;
}

function parseRunArgs(tokens: string[]): RunArgs {
	const args: RunArgs = { ledger: "", context: "manager", away: false };
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
		else if (token === "--context") {
			const policy = value();
			const match = CONTEXT_POLICIES.find(candidate => candidate === policy);
			if (!match) throw new Error(`--context takes ${CONTEXT_POLICIES.join(", ")}`);
			args.context = match;
		} else if (token.startsWith("--")) throw new Error(`unknown flag ${token}`);
		else if (args.ledger) throw new Error(`unexpected argument ${token}`);
		else args.ledger = token;
	}
	if (!args.ledger) throw new Error("missing ledger path");
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
		effort: loop.effort,
		contextPolicy: loop.contextPolicy,
		startLeafId: loop.startLeafId,
		startSnapshot: loop.startSnapshot,
		noProgress: loop.noProgress,
		reopenCounts: loop.reopenCounts,
		managerFailures: loop.managerFailures,
		history: loop.history,
	};
}

export default function serefManager(pi: ExtensionAPI): void {
	let state: LoopState | undefined;
	let askShadowed = false;
	let askQueue: Promise<unknown> = Promise.resolve();

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
		const flags = [loop.paused ? "paused" : "", loop.away ? "away" : ""].filter(Boolean).join(" · ");
		ctx.ui.setStatus(
			"seref_manager",
			`seref ${loop.iteration}/${loop.max} · ${counts.done} done ${counts.blocked} blocked ${counts.open} open${flags ? ` · ${flags}` : ""}`,
		);
	};

	const finish = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
		const loop = state;
		if (!loop) return;
		state = undefined;
		loop.abort.abort();
		persist(undefined);
		log(loop, `## Loop ended after iteration ${loop.iteration}\n\n${message}`);
		updateStatus(ctx);
		ctx.ui.notify(`seref_manager: ${message}`, level);
	};

	const pause = (ctx: ExtensionContext, message: string): void => {
		const loop = state;
		if (!loop) return;
		loop.paused = true;
		loop.abort.abort();
		loop.abort = new AbortController();
		persist(loop);
		updateStatus(ctx);
		ctx.ui.notify(`seref_manager: ${message}`, "warning");
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
		if (notes.length > 0) prompt += `\n\nManager notes from iteration ${loop.iteration - 1}:\n${notes.join("\n")}`;
		updateStatus(ctx);
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
		const target = resolveManagerModel(ctx, loop.modelSpec, loop.effort);
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
				if (loop.abort.signal.aborted) throw error;
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
		if (!loop || loop.paused || loop.busy) return;
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
			if (gatePassed && changes.length === 0) return finish(ctx, done, "info");
			loop.noProgress = progressKey(after) === progressKey(loop.startSnapshot) ? loop.noProgress + 1 : 0;
			if (!gatePassed && loop.iteration >= loop.max) {
				return finish(ctx, `iteration limit ${loop.max} reached (${gate.summary}).`, "warning");
			}
			if (!gatePassed && loop.noProgress >= NO_PROGRESS_LIMIT) {
				return finish(ctx, `stuck: ${loop.noProgress} iterations without any ledger change (${gate.summary}).`, "warning");
			}

			const verdict = await reviewIteration(ctx, loop, ledgerText, changes, gate.summary, gatePassed);
			if (state !== loop || loop.paused) return;
			if (gatePassed && !verdict) return finish(ctx, done, "info");
			const notes: string[] = [];
			let snapshot = after;
			if (verdict) {
				const edited = applyEdits(ledgerText, verdict.edits, loop.iteration);
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
			if (state === loop && !loop.paused) pause(ctx, `${errorText(error)}. Loop paused; /seref_manager resume retries.`);
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
			const target = resolveManagerModel(ctx, loop.modelSpec, loop.effort);
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
			log(loop, `## Iteration ${loop.iteration}: ask unanswered (manager failed: ${errorText(failure)})`);
			ctx.ui.notify(`seref_manager: could not answer ask (${errorText(failure)})`, "warning");
			return {
				content: [
					{
						type: "text",
						text: `Nobody is at the keyboard and the loop manager could not answer (${errorText(failure)}). Take the conservative default, record the choice in the item's evidence, and continue.`,
					},
				],
				details: {},
			};
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
		state = {
			...saved,
			effort: EFFORTS.find(effort => effort === saved.effort) ?? DEFAULT_EFFORT,
			paused: true,
			busy: false,
			resetting: false,
			commandCtx: undefined,
			askAvailable: shadowAsk(),
			abort: new AbortController(),
		};
		updateStatus(ctx);
		ctx.ui.notify(
			`seref_manager: restored the loop on ${displayPath(ctx.cwd, saved.ledgerPath)} at iteration ${saved.iteration}/${saved.max}, paused. /seref_manager resume continues, /seref_manager stop ends it.`,
			"info",
		);
	};

	const startRun = async (ctx: ExtensionCommandContext, tokens: string[]): Promise<void> => {
		if (state) throw new Error(`a loop is already running on ${displayPath(ctx.cwd, state.ledgerPath)}; /seref_manager stop first`);
		const args = parseRunArgs(tokens);
		const ledgerPath = path.resolve(ctx.cwd, args.ledger.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
		if (!fs.existsSync(ledgerPath)) throw new Error(`no ledger at ${ledgerPath}`);
		if (!fs.existsSync(GATE)) throw new Error(`gate not found at ${GATE} (set SEREF_LOOP_GATE)`);
		const target = resolveManagerModel(ctx, args.model, DEFAULT_EFFORT);

		const snapshot = parseLedger(await Bun.file(ledgerPath).text());
		const loop: LoopState = {
			ledgerPath,
			cwd: ctx.cwd,
			iteration: 0,
			max: args.max ?? Math.max(MIN_DEFAULT_MAX, countItems(snapshot).total * 2),
			graceMs: (args.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000,
			away: args.away,
			modelSpec: args.model,
			effort: target.effort,
			contextPolicy: args.context,
			startLeafId: null,
			startSnapshot: snapshot,
			noProgress: 0,
			reopenCounts: {},
			managerFailures: 0,
			history: [],
			paused: false,
			busy: false,
			resetting: false,
			commandCtx: ctx,
			askAvailable: false,
			abort: new AbortController(),
		};
		const gate = await runGate(loop);
		if (gate.code === 0) {
			ctx.ui.notify(`seref_manager: gate already passes (${gate.summary}); nothing to run`, "info");
			return;
		}
		if (gate.code !== 1) throw new Error(`gate exit ${gate.code}: ${gate.summary}`);
		loop.askAvailable = shadowAsk();
		const askNote = loop.askAvailable
			? `ask answered after ${loop.away ? 0 : loop.graceMs / 1000}s`
			: "no ask tool in this session";
		const modelName = `${target.model.provider}/${target.model.id}:${target.effort}`;
		state = loop;
		log(
			loop,
			`# seref_manager run (${new Date().toISOString()})\n\nLedger: ${ledgerPath}\nMax iterations: ${loop.max}\nManager model: ${modelName}\nContext: ${loop.contextPolicy}\nStart: ${gate.summary}`,
		);
		ctx.ui.notify(
			`seref_manager: running ${displayPath(ctx.cwd, ledgerPath)}, max ${loop.max} iterations, manager ${modelName}, context ${loop.contextPolicy}, ${askNote}. ${gate.summary}`,
			"info",
		);
		startIteration(ctx, loop, snapshot, []);
	};

	pi.registerCommand("seref_manager", {
		description: "AI-managed seref_loop: run a ledger with a manager that reviews each iteration and answers ask",
		getArgumentCompletions: prefix =>
			["run", "pause", "resume", "stop", "status", "away"]
				.filter(command => command.startsWith(prefix.trim()))
				.map(command => ({ value: command, label: command })),
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [command = "status", ...rest] = tokens;
			try {
				switch (command) {
					case "run":
						await startRun(ctx, rest);
						return;
					case "pause":
						if (!state) throw new Error("no loop is running");
						pause(ctx, "paused. /seref_manager resume continues.");
						return;
					case "resume": {
						const loop = state;
						if (!loop) throw new Error("no loop is running");
						if (!loop.paused) throw new Error("the loop is not paused");
						loop.paused = false;
						loop.commandCtx = ctx;
						persist(loop);
						updateStatus(ctx);
						ctx.ui.notify("seref_manager: resumed", "info");
						void advance(ctx);
						return;
					}
					case "stop":
						if (!state) throw new Error("no loop is running");
						finish(ctx, "stopped by the user.", "info");
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
					case "status": {
						const loop = state;
						if (!loop) {
							ctx.ui.notify(`seref_manager: no loop running.\n${USAGE}`, "info");
							return;
						}
						const counts = countItems(loop.startSnapshot);
						const target = resolveManagerModel(ctx, loop.modelSpec, loop.effort);
						ctx.ui.notify(
							[
								`seref_manager: ${displayPath(ctx.cwd, loop.ledgerPath)}, iteration ${loop.iteration}/${loop.max}${loop.paused ? " (paused)" : ""}`,
								`${counts.done} done, ${counts.blocked} blocked, ${counts.open} open of ${counts.total}`,
								`manager: ${target.model.provider}/${target.model.id}:${target.effort}; context: ${loop.contextPolicy}`,
								`ask: ${loop.away ? "manager answers at once" : `manager answers after ${loop.graceMs / 1000}s`}`,
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

	pi.on("agent_end", (event, ctx) => {
		const loop = state;
		if (!loop || loop.paused || event.willContinue) return;
		const last = lastAssistant(event.messages);
		if (last?.stopReason === "aborted") {
			pause(ctx, "interrupted, loop paused. /seref_manager resume continues, /seref_manager stop ends it.");
			return;
		}
		if (last?.stopReason === "error") {
			pause(ctx, "the worker's turn ended with an error, loop paused. /seref_manager resume retries.");
			return;
		}
		ctx.setTimeout(() => advance(ctx), 0);
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));

	pi.on("session_switch", (_event, ctx) => {
		const loop = state;
		if (loop?.resetting) return;
		if (loop) {
			// The loop stays saved in the session it ran in; resuming that session restores it.
			loop.abort.abort();
			state = undefined;
			updateStatus(ctx);
			ctx.ui.notify(`seref_manager: left the session running the loop on ${displayPath(ctx.cwd, loop.ledgerPath)}; resume that session to continue it.`, "warning");
		}
		restore(ctx);
	});

	pi.on("session_shutdown", () => {
		state?.abort.abort();
		state = undefined;
	});
}
