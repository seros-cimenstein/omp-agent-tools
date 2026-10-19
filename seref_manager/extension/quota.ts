/**
 * Provider usage limits (Claude 5-hour/weekly windows, Codex limits, spend caps): find them in
 * failed messages and decide when to try again. Short throttles (per-minute 429s) are not usage
 * limits; omp's own retry handles those inside the turn. The classifier itself is omp's
 * (`@oh-my-pi/pi-ai/error`), passed in by the extension so this module stays host-free.
 */
import { isRecord } from "./guards";

/** The error fields of a failed assistant message, as omp records them. */
export interface QuotaError {
	provider?: string;
	model?: string;
	errorMessage?: string;
	errorStatus?: number;
	errorId?: number;
	errorClassificationMessage?: string;
}

/** Where a resume time came from, for notices and the log. */
export type ResumeSource = "usage report" | "provider hint" | "omp retry estimate" | "probe";

/** Margin after a reset before trying again, so the first request does not race the window edge. */
const RESET_BUFFER_MS = 60_000;
/** Without any reset information, try again after this long (omp's own guess for an exhausted quota). */
export const PROBE_INTERVAL_MS = 30 * 60_000;

function errorFields(value: Record<string, unknown>): QuotaError | undefined {
	if (typeof value.errorMessage !== "string" && typeof value.errorId !== "number") return undefined;
	return {
		provider: typeof value.provider === "string" ? value.provider : undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
		errorStatus: typeof value.errorStatus === "number" ? value.errorStatus : undefined,
		errorId: typeof value.errorId === "number" ? value.errorId : undefined,
		errorClassificationMessage:
			typeof value.errorClassificationMessage === "string" ? value.errorClassificationMessage : undefined,
	};
}

/** Whether one failed message's fields classify as a usage limit (omp's classifier in the extension). */
export type UsageLimitTest = (fields: QuotaError) => boolean;

/**
 * The usage-limit error carried by `value`: a failed assistant message, or an Error whose
 * `cause` chain holds one. Undefined when it is not a usage limit. `isLimit` gets a copy, so a
 * classifier that annotates its argument cannot touch the session's message.
 */
export function findUsageLimit(value: unknown, isLimit: UsageLimitTest): QuotaError | undefined {
	let current: unknown = value;
	for (let depth = 0; depth < 5 && current !== undefined; depth++) {
		if (isRecord(current)) {
			const fields = errorFields(current);
			if (fields && isLimit({ ...fields })) return fields;
		}
		current = current instanceof Error ? current.cause : isRecord(current) ? current.cause : undefined;
	}
	return undefined;
}

/**
 * When to try again: the earliest future account reset from omp's usage reports (authoritative),
 * else the longer of the provider's hint and omp's own retry estimate, else a probe. Always at
 * least a minute from now.
 */
export function chooseResumeAt(input: {
	now: number;
	accountResets: readonly number[];
	hintMs?: number;
	ompWaitMs?: number;
}): { at: number; source: ResumeSource } {
	const floor = input.now + RESET_BUFFER_MS;
	const futureResets = input.accountResets.filter(reset => reset > input.now);
	if (futureResets.length > 0) return { at: Math.max(floor, Math.min(...futureResets) + RESET_BUFFER_MS), source: "usage report" };
	const hint = input.hintMs ?? 0;
	const omp = input.ompWaitMs ?? 0;
	if (hint > 0 || omp > 0) {
		return { at: Math.max(floor, input.now + Math.max(hint, omp) + RESET_BUFFER_MS), source: hint >= omp ? "provider hint" : "omp retry estimate" };
	}
	return { at: input.now + PROBE_INTERVAL_MS, source: "probe" };
}

/** The wait omp computed when it gave up on a usage limit (`auto_retry_end.finalError`). */
export function ompWaitFromFinalError(finalError: string | undefined): number | undefined {
	const match = finalError ? /Provider requested (\d+)ms wait/.exec(finalError) : null;
	return match ? Number(match[1]) : undefined;
}

/** One model's account-pool usage, from omp's usage reports and credential blocks (`/usage`). */
export interface RoleUsage {
	/** omp's aggregate: `depleted` only when every account is out. */
	state: "healthy" | "reserve" | "depleted" | "unknown";
	/** Reset times (epoch ms) of the depleted accounts. */
	resets: number[];
	/** Largest remaining fraction (0–1) among accounts that report one. */
	bestRemaining?: number;
}

export type ManagerChoice =
	| { kind: "role" }
	| { kind: "fallback" }
	/** Neither model can run; `until` is the earliest known reset of either, if any. */
	| { kind: "wait"; until: number | undefined };

/**
 * Which model reviews: the manager role while its quota lasts, else the worker's model (`fallback`,
 * undefined when it is the same model) while that one lasts, else wait for whichever resets first.
 */
export function chooseManager(role: RoleUsage, fallback: RoleUsage | undefined, now: number): ManagerChoice {
	if (role.state !== "depleted") return { kind: "role" };
	if (fallback && fallback.state !== "depleted") return { kind: "fallback" };
	const resets = [...role.resets, ...(fallback?.resets ?? [])].filter(reset => reset > now);
	return { kind: "wait", until: resets.length > 0 ? Math.min(...resets) : undefined };
}

/** One line of usage for `/seref_manager status`. */
export function describeUsage(usage: RoleUsage, now: number): string {
	if (usage.state === "depleted") {
		const resets = usage.resets.filter(reset => reset > now);
		return resets.length > 0 ? `out of quota until ${formatClock(Math.min(...resets), now)}` : "out of quota, reset time unknown";
	}
	if (usage.state === "unknown") return "usage unknown (no usage report for this login)";
	const left = usage.bestRemaining === undefined ? "" : `, best account ${Math.round(usage.bestRemaining * 100)}% left`;
	return `${usage.state === "reserve" ? "running low" : "ok"}${left}`;
}

export function formatClock(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toTimeString().slice(0, 5);
	const sameDay = new Date(now).toDateString() === date.toDateString();
	return sameDay ? time : `${date.toDateString().slice(0, 10)} ${time}`;
}
