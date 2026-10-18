import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, changedItems, parseLedger, progressKey } from "../extension/ledger";

const GATE = path.resolve(import.meta.dir, "../../seref_loop/bin/seref-loop-gate");

const DONE_LEDGER = `STATUS: DONE

- [x] A1 fix the leak (a.py:3). Acceptance: pytest. — DONE: a.py; pytest 12 passed
- [x] A2 wrong finding — INVALID: already guarded at b.py:12
- [!] A3 needs keys — BLOCKED: too much work`;

function gateExit(text: string): number {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seref-manager-"));
	try {
		fs.writeFileSync(path.join(dir, "L.md"), text);
		return Bun.spawnSync([GATE, "L.md"], { cwd: dir, stderr: "pipe" }).exitCode;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("parseLedger", () => {
	test("reads the first STATUS line and every item state", () => {
		const snapshot = parseLedger(`${DONE_LEDGER}\n- [ ] B1 open item\nSTATUS: OPEN`);
		expect(snapshot.status).toBe("DONE");
		expect(snapshot.items.map(item => `${item.id}:${item.state}`)).toEqual(["A1:done", "A2:done", "A3:blocked", "B1:open"]);
	});

	test("progress ignores evidence text but not state changes", () => {
		const before = parseLedger(DONE_LEDGER);
		expect(progressKey(parseLedger(DONE_LEDGER.replace("12 passed", "13 passed")))).toBe(progressKey(before));
		const reopened = parseLedger(DONE_LEDGER.replace("- [x] A2", "- [ ] A2"));
		expect(progressKey(reopened)).not.toBe(progressKey(before));
		expect(changedItems(before, reopened).map(change => `${change.item.id}:${change.from}->${change.item.state}`)).toEqual([
			"A2:done->open",
		]);
	});
});

describe("applyEdits", () => {
	test("reopen replaces the DONE evidence with a manager note and makes the gate run again", () => {
		expect(gateExit(DONE_LEDGER.replace("too much work", "no ssh access to host x"))).toBe(0);
		const { text, applied } = applyEdits(DONE_LEDGER, [{ id: "A1", kind: "reopen", reason: "pytest\nnever ran" }], 4);
		expect(applied).toHaveLength(1);
		expect(text).toContain("- [ ] A1 fix the leak (a.py:3). Acceptance: pytest. — MANAGER(it4): reopened: pytest never ran");
		expect(text).not.toContain("12 passed");
		expect(gateExit(text)).toBe(1);
	});

	test("a re-ticked item keeps the manager note and passes the gate", () => {
		const reopened = applyEdits(DONE_LEDGER.replace("too much work", "no ssh access"), [{ id: "A1", kind: "reopen", reason: "pytest never ran" }], 4).text;
		const reticked = reopened.replace(/^- \[ \] (A1 .*)$/m, "- [x] $1 — DONE: a.py; pytest 12 passed (ran it)");
		expect(gateExit(reticked)).toBe(0);
		const again = applyEdits(reticked, [{ id: "A1", kind: "reopen", reason: "wrong package" }], 6).text;
		const line = again.split("\n").find(entry => entry.includes(" A1 "));
		expect(line).toBe("- [ ] A1 fix the leak (a.py:3). Acceptance: pytest. — MANAGER(it6): reopened: wrong package");
	});

	test("unblock turns a weak blocker back into an open item", () => {
		const { text } = applyEdits(DONE_LEDGER, [{ id: "A3", kind: "unblock", reason: "size is not a blocker" }], 2);
		expect(text).toContain("- [ ] A3 needs keys — MANAGER(it2): blocker rejected: size is not a blocker");
	});

	test("edits that do not match the item's state or id are skipped, not forced", () => {
		const { text, applied, skipped } = applyEdits(
			DONE_LEDGER,
			[
				{ id: "A3", kind: "reopen", reason: "x" },
				{ id: "A1", kind: "unblock", reason: "x" },
				{ id: "Z9", kind: "reopen", reason: "x" },
			],
			1,
		);
		expect(applied).toEqual([]);
		expect(skipped.map(skip => skip.why)).toEqual(["item is not [x]", "item is not [!]", "no such item"]);
		expect(text).toBe(DONE_LEDGER);
	});
});
