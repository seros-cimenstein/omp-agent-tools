/**
 * seref_loop ledger: parse item states and apply the manager's edits.
 *
 * Item lines match the gate (`bin/seref-loop-gate`): `- [ ] ID …`, `- [x] ID …`, `- [!] ID …`.
 * The manager never ticks anything; it only moves `[x]`/`[!]` back to `[ ]` with a
 * `— MANAGER(itN): …` note, so the gate keeps sole authority over "done".
 */

export type ItemState = "open" | "done" | "blocked";

export interface LedgerItem {
	id: string;
	state: ItemState;
	/** Full line text. */
	line: string;
}

export interface LedgerSnapshot {
	/** `OPEN` / `DONE` / whatever follows the first `STATUS: `; undefined without one. */
	status: string | undefined;
	items: LedgerItem[];
}

export interface LedgerEdit {
	id: string;
	/** `reopen`: `[x]` → `[ ]`. `unblock`: `[!]` → `[ ]`. */
	kind: "reopen" | "unblock";
	reason: string;
}

export interface SkippedEdit {
	edit: LedgerEdit;
	why: string;
}

const ITEM_LINE = /^- \[([ x!])\] (\S+)(.*)$/;
const STATUS_LINE = /^STATUS: (.*)$/;
const STATE_BY_MARK: Record<string, ItemState> = { " ": "open", x: "done", "!": "blocked" };
/** Suffixes the worker or manager append to an item; everything from the first one on is replaced on edit. */
const SUFFIX_MARKERS = [" — MANAGER(", " — DONE: ", " — INVALID: ", " — BLOCKED: "];
const MAX_REASON = 300;

export function parseLedger(text: string): LedgerSnapshot {
	let status: string | undefined;
	const items: LedgerItem[] = [];
	for (const line of text.split("\n")) {
		if (status === undefined) {
			const statusMatch = STATUS_LINE.exec(line);
			if (statusMatch) status = statusMatch[1].trim();
		}
		const itemMatch = ITEM_LINE.exec(line);
		if (itemMatch) items.push({ id: itemMatch[2], state: STATE_BY_MARK[itemMatch[1]], line });
	}
	return { status, items };
}

/** Stable key of everything that counts as progress: the STATUS line and each item's state. */
export function progressKey(snapshot: LedgerSnapshot): string {
	return [snapshot.status ?? "", ...snapshot.items.map(item => `${item.id}:${item.state}`)].join("|");
}

export function countItems(snapshot: LedgerSnapshot): { open: number; done: number; blocked: number; total: number } {
	const counts = { open: 0, done: 0, blocked: 0, total: snapshot.items.length };
	for (const item of snapshot.items) counts[item.state]++;
	return counts;
}

/** Items whose state differs between two snapshots (new items count as changed). */
export function changedItems(before: LedgerSnapshot, after: LedgerSnapshot): { item: LedgerItem; from?: ItemState }[] {
	const previous = new Map(before.items.map(item => [item.id, item.state]));
	return after.items
		.filter(item => previous.get(item.id) !== item.state)
		.map(item => ({ item, from: previous.get(item.id) }));
}

export function sanitizeReason(reason: string): string {
	const flat = reason.replace(/\s+/g, " ").trim();
	return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat;
}

function stripSuffixes(rest: string): string {
	let cut = rest.length;
	for (const marker of SUFFIX_MARKERS) {
		const index = rest.indexOf(marker);
		if (index !== -1 && index < cut) cut = index;
	}
	return rest.slice(0, cut).trimEnd();
}

/**
 * Apply reopen/unblock edits for iteration `iteration`. An edit applies only to an item in the
 * state it expects (`reopen` needs `[x]`, `unblock` needs `[!]`); anything else is skipped with a reason.
 */
export function applyEdits(
	text: string,
	edits: readonly LedgerEdit[],
	iteration: number,
): { text: string; applied: LedgerEdit[]; skipped: SkippedEdit[] } {
	const lines = text.split("\n");
	const applied: LedgerEdit[] = [];
	const skipped: SkippedEdit[] = [];
	for (const edit of edits) {
		const wanted = edit.kind === "reopen" ? "x" : "!";
		const index = lines.findIndex(line => {
			const match = ITEM_LINE.exec(line);
			return match !== null && match[2] === edit.id;
		});
		if (index === -1) {
			skipped.push({ edit, why: "no such item" });
			continue;
		}
		const match = ITEM_LINE.exec(lines[index]);
		if (!match || match[1] !== wanted) {
			skipped.push({ edit, why: `item is not [${wanted}]` });
			continue;
		}
		const label = edit.kind === "reopen" ? "reopened" : "blocker rejected";
		lines[index] =
			`- [ ] ${edit.id}${stripSuffixes(match[3])} — MANAGER(it${iteration}): ${label}: ${sanitizeReason(edit.reason)}`;
		applied.push(edit);
	}
	return { text: lines.join("\n"), applied, skipped };
}
