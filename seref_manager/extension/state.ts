/**
 * Loop state persisted into the session as `seref_manager_state` custom entries, so a loop
 * survives an omp restart (`omp -c` / `--resume`) and an in-session `/resume`. Custom entries
 * never reach the model or compaction; the newest one on the branch wins.
 */
import { isRecord } from "./guards";
import type { ItemState, LedgerItem, LedgerSnapshot } from "./ledger";

export const STATE_ENTRY_TYPE = "seref_manager_state";

export const CONTEXT_POLICIES = ["manager", "keep", "compact", "reset"] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

/** The durable part of a running loop: everything except handles, flags and in-flight work. */
export interface PersistedLoop {
	ledgerPath: string;
	cwd: string;
	iteration: number;
	max: number;
	graceMs: number;
	away: boolean;
	modelSpec: string | undefined;
	contextPolicy: ContextPolicy;
	startLeafId: string | null;
	startSnapshot: LedgerSnapshot;
	noProgress: number;
	reopenCounts: Record<string, number>;
	managerFailures: number;
	history: string[];
	/** False until the start-of-run audit of unsupervised ticks finished (or was skipped). */
	audited: boolean;
	/** Set while the loop waits for a provider usage limit to reset. */
	quotaWait: QuotaWait | undefined;
	/** Paused by the user or an error; a restored loop is paused unless it was waiting out a usage limit. */
	paused: boolean;
	/** This loop's own ntfy topic (`<project>-<random>`), kept across restarts. */
	ntfyTopic: string | undefined;
}

const QUOTA_PHASES = ["worker", "manager", "audit"] as const;

/** A usage-limit pause: what hit the limit, and when to try again. */
export interface QuotaWait {
	/** Epoch ms of the next attempt. */
	until: number;
	/** What hit the limit and resumes afterwards: the worker's turn, the manager's review, or the audit. */
	phase: (typeof QUOTA_PHASES)[number];
	provider: string;
	model: string;
	/** How `until` was chosen (usage report, provider hint, …). */
	source: string;
}

function parseQuotaWait(raw: unknown): QuotaWait | undefined {
	if (!isRecord(raw)) return undefined;
	const phase = QUOTA_PHASES.find(candidate => candidate === raw.phase);
	if (!phase || typeof raw.until !== "number" || !Number.isFinite(raw.until)) return undefined;
	if (typeof raw.provider !== "string" || typeof raw.model !== "string" || typeof raw.source !== "string") return undefined;
	return { until: raw.until, phase, provider: raw.provider, model: raw.model, source: raw.source };
}

/** What one state entry records: the loop, or `null` once it ended. */
export type PersistedEntry = { version: 1; loop: PersistedLoop | null };

const ITEM_STATES: Record<string, ItemState> = { open: "open", done: "done", blocked: "blocked" };

function parseSnapshot(raw: unknown): LedgerSnapshot | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
	const items: LedgerItem[] = [];
	for (const item of raw.items) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.line !== "string") return undefined;
		const state = typeof item.state === "string" ? ITEM_STATES[item.state] : undefined;
		if (!state) return undefined;
		items.push({ id: item.id, state, line: item.line });
	}
	return { status: typeof raw.status === "string" ? raw.status : undefined, items };
}

/** Validate one entry's `data`; undefined when it is not a well-formed state entry. */
export function parsePersistedEntry(data: unknown): PersistedEntry | undefined {
	if (!isRecord(data) || data.version !== 1) return undefined;
	if (data.loop === null) return { version: 1, loop: null };
	const loop = data.loop;
	if (!isRecord(loop)) return undefined;
	const startSnapshot = parseSnapshot(loop.startSnapshot);
	const contextPolicy = CONTEXT_POLICIES.find(policy => policy === loop.contextPolicy);
	const numbers = [loop.iteration, loop.max, loop.graceMs, loop.noProgress, loop.managerFailures];
	if (
		typeof loop.ledgerPath !== "string" ||
		typeof loop.cwd !== "string" ||
		typeof loop.away !== "boolean" ||
		!(loop.modelSpec === undefined || loop.modelSpec === null || typeof loop.modelSpec === "string") ||
		!(loop.startLeafId === null || typeof loop.startLeafId === "string") ||
		!numbers.every(value => typeof value === "number" && Number.isFinite(value)) ||
		!isRecord(loop.reopenCounts) ||
		!Object.values(loop.reopenCounts).every(count => typeof count === "number") ||
		!Array.isArray(loop.history) ||
		!loop.history.every(line => typeof line === "string") ||
		!startSnapshot ||
		!contextPolicy
	) {
		return undefined;
	}
	return {
		version: 1,
		loop: {
			ledgerPath: loop.ledgerPath,
			cwd: loop.cwd,
			iteration: Number(loop.iteration),
			max: Number(loop.max),
			graceMs: Number(loop.graceMs),
			away: loop.away,
			modelSpec: typeof loop.modelSpec === "string" ? loop.modelSpec : undefined,
			contextPolicy,
			startLeafId: loop.startLeafId,
			startSnapshot,
			noProgress: Number(loop.noProgress),
			reopenCounts: Object.fromEntries(Object.entries(loop.reopenCounts).map(([id, count]) => [id, Number(count)])),
			managerFailures: Number(loop.managerFailures),
			history: loop.history,
			// Entries from before the audit existed belong to loops that were already running.
			audited: loop.audited !== false,
			quotaWait: parseQuotaWait(loop.quotaWait),
			paused: loop.paused === true,
			ntfyTopic: typeof loop.ntfyTopic === "string" && loop.ntfyTopic ? loop.ntfyTopic : undefined,
		},
	};
}

/**
 * The newest well-formed state entry among session entries (root → leaf order).
 * Undefined when the session never ran a loop; `loop: null` when the last one ended.
 */
export function latestPersistedEntry(entries: readonly unknown[]): PersistedEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parsePersistedEntry(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}
