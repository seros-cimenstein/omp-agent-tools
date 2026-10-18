import { expect, test } from "bun:test";
import { digestIteration } from "../extension/transcript";

const message = (id: string, payload: Record<string, unknown>) => ({ id, type: "message", message: payload });

const entries = [
	message("1", { role: "user", content: "previous iteration prompt" }),
	message("2", { role: "assistant", content: [{ type: "text", text: "old work" }], stopReason: "stop" }),
	message("3", { role: "user", content: [{ type: "text", text: "[seref_manager · iteration 2/10] Read LOOP.md" }] }),
	message("4", {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret reasoning" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pytest -q" } },
		],
		stopReason: "toolUse",
	}),
	{ id: "5", type: "compaction", summary: "ignored" },
	message("6", { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: `${"x".repeat(5000)}\n3 failed, 9 passed` }] }),
	message("7", { role: "assistant", content: [{ type: "text", text: "A1 done" }], stopReason: "stop" }),
];

test("digest covers only this iteration and keeps the tail of long tool output", () => {
	const digest = digestIteration(entries, "2", 60_000);
	expect(digest).not.toContain("old work");
	expect(digest).not.toContain("secret reasoning");
	expect(digest).toContain('CALL bash {"command":"pytest -q"}');
	expect(digest).toContain("RESULT bash [ERROR]");
	expect(digest).toContain("3 failed, 9 passed");
	expect(digest.endsWith("WORKER: A1 done")).toBe(true);
});

test("an unknown start leaf falls back to the whole branch, and long digests keep the newest part", () => {
	expect(digestIteration(entries, "gone", 60_000)).toContain("old work");
	const short = digestIteration(entries, null, 400);
	expect(short).toContain("chars of the middle of this iteration cut");
	expect(short.endsWith("WORKER: A1 done")).toBe(true);
});
