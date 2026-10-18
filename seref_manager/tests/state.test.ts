import { expect, test } from "bun:test";
import { parseLedger } from "../extension/ledger";
import { latestPersistedEntry, type PersistedLoop, STATE_ENTRY_TYPE } from "../extension/state";

const loop: PersistedLoop = {
	ledgerPath: "/repo/LOOP_X.md",
	cwd: "/repo",
	iteration: 3,
	max: 10,
	graceMs: 120_000,
	away: false,
	modelSpec: undefined,
	contextPolicy: "manager",
	startLeafId: "leaf-7",
	startSnapshot: parseLedger("STATUS: OPEN\n- [x] A1 a — DONE: x\n- [ ] A2 b"),
	noProgress: 1,
	reopenCounts: { A1: 2 },
	managerFailures: 0,
	history: ["- it2: continue, fine"],
	audited: true,
};

const custom = (data: unknown) => ({ type: "custom", customType: STATE_ENTRY_TYPE, data });
/** What the entry looks like after a JSONL round trip (undefined fields dropped). */
const stored = (value: PersistedLoop | null) => JSON.parse(JSON.stringify({ version: 1, loop: value }));

test("the newest state entry on the branch wins, and survives a JSON round trip", () => {
	const older = { ...loop, iteration: 1 };
	const entries = [custom(stored(older)), { type: "message", message: { role: "user" } }, custom(stored(loop))];
	expect(latestPersistedEntry(entries)?.loop).toEqual(loop);
});

test("an ended loop is not restored even when an earlier entry was running", () => {
	expect(latestPersistedEntry([custom(stored(loop)), custom(stored(null))])).toEqual({ version: 1, loop: null });
});

test("malformed or foreign entries are ignored", () => {
	const broken = stored({ ...loop, contextPolicy: "sometimes" as never });
	const badSnapshot = stored({ ...loop, startSnapshot: { status: "OPEN", items: [{ id: "A1", state: "maybe", line: "x" }] } as never });
	const foreign = { type: "custom", customType: "other_extension", data: stored(loop) };
	expect(latestPersistedEntry([custom(broken), custom(badSnapshot), foreign])).toBeUndefined();
	expect(latestPersistedEntry([])).toBeUndefined();
});
