/**
 * seref_loop ledger: parse item states and apply the manager's edits.
 *
 * Item lines match the gate (`bin/seref-loop-gate`): `- [ ] ID …`, `- [x] ID …`, `- [!] ID …`.
 * The manager never ticks anything; it only moves `[x]`/`[!]` back to `[ ]` with a
 * `— MANAGER(itN): …` note, so the gate keeps sole authority over "done".
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
 * Apply reopen/unblock edits, tagging each line `— MANAGER(<stamp>): …` (`it4`, `audit`). An edit
 * applies only to an item in the state it expects (`reopen` needs `[x]`, `unblock` needs `[!]`);
 * anything else is skipped with a reason. A ledger that claimed `STATUS: DONE` goes back to
 * `STATUS: OPEN` once an item is open again, so the worker never has to repair the claim itself
 * (it tends to invent statuses the gate rejects).
 */
export function applyEdits(
	text: string,
	edits: readonly LedgerEdit[],
	stamp: string,
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
		const action = edit.kind === "reopen" ? "reopened" : "blocker rejected";
		lines[index] = `- [ ] ${edit.id}${stripSuffixes(match[3])} — MANAGER(${stamp}): ${action}: ${sanitizeReason(edit.reason)}`;
		applied.push(edit);
	}
	if (applied.length > 0) {
		const status = lines.findIndex(line => STATUS_LINE.test(line));
		if (status !== -1 && lines[status] === "STATUS: DONE") lines[status] = "STATUS: OPEN";
	}
	return { text: lines.join("\n"), applied, skipped };
}

const LEDGER_NAME = /^LOOP_.+\.md$/;

/**
 * seref_loop ledgers (`LOOP_*.md`, not the `*.manager.md` audit logs) directly inside `dirs`,
 * as absolute paths, deduplicated, in directory order then name order.
 */
export function findLedgers(dirs: readonly string[]): string[] {
	const found = new Set<string>();
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const name of names) {
			if (!LEDGER_NAME.test(name) || name.endsWith(".manager.md")) continue;
			const file = path.resolve(dir, name);
			if (fs.statSync(file).isFile()) found.add(file);
		}
	}
	return [...found];
}
