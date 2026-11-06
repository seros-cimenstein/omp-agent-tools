import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ledgerCommands, refuseCommand, runManagerTool } from "../extension/tools";
import { parseAuditVerdict } from "../extension/verdict";

const LEDGER = [
	"STATUS: OPEN",
	"Verify with `pytest -q tests/` and `cat out.txt 2>&1`.",
	"Deploy: `ssh prod 'systemctl restart bot'`, then `rm -rf build`, `git push`, `echo hi > out.txt`, `curl -X POST http://x/api`.",
	"- [x] A1 fix — DONE: `grep -n fix a.py`",
].join("\n");
const allowed = ledgerCommands(LEDGER);

describe("refuseCommand", () => {
	test("runs only backticked ledger commands, whitespace and a leading $ aside", () => {
		expect(refuseCommand("pytest -q tests/", allowed)).toBeUndefined();
		expect(refuseCommand("$  pytest  -q tests/", allowed)).toBeUndefined();
		expect(refuseCommand("cat out.txt 2>&1", allowed)).toBeUndefined();
		expect(refuseCommand("grep -n fix a.py", allowed)).toBeUndefined();
		expect(refuseCommand("pytest -q", allowed)).toMatch(/not a command written in the ledger/);
	});

	test("refuses mutating ledger commands: remote, delete, push, redirect, POST", () => {
		for (const command of ["ssh prod 'systemctl restart bot'", "rm -rf build", "git push", "echo hi > out.txt", "curl -X POST http://x/api"]) {
			expect(refuseCommand(command, allowed)).toBeDefined();
		}
	});

	test("quoted > and harmless redirects are not writes", () => {
		const commands = new Set(["grep -c '>' a.py", "pytest 2>/dev/null", "make check >/dev/null 2>&1"]);
		for (const command of commands) expect(refuseCommand(command, commands)).toBeUndefined();
	});
});

describe("runManagerTool", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "seref-tools-"));
	fs.writeFileSync(path.join(root, "a.py"), "line one\nfix here\n");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "seref-outside-"));
	fs.writeFileSync(path.join(outside, "secret"), "nope");
	fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
	Bun.spawnSync(["git", "init", "-q"], { cwd: root });
	const options = { root, ledgerText: () => LEDGER, signal: new AbortController().signal };
	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("read_file numbers lines and refuses paths that escape the repository, symlinks included", async () => {
		expect((await runManagerTool("read_file", { path: "a.py", offset: 2 }, options)).text).toBe("2: fix here\n3: ");
		for (const escape of ["../" + path.basename(outside) + "/secret", "link"]) {
			const result = await runManagerTool("read_file", { path: escape }, options);
			expect(result).toMatchObject({ isError: true });
			expect(result.text).toMatch(/outside the repository/);
		}
	});

	test("run_check executes an allowed ledger command and reports its exit status", async () => {
		const result = await runManagerTool("run_check", { command: "grep -n fix a.py" }, options);
		expect(result.isError).toBe(false);
		expect(result.text).toBe("exit 0\n2:fix here");
		expect((await runManagerTool("run_check", { command: "rm -rf build" }, options)).text).toMatch(/^refused:/);
	});

	test("git allows read-only subcommands only", async () => {
		expect((await runManagerTool("git", { args: "status --short" }, options)).isError).toBe(false);
		expect((await runManagerTool("git", { args: "commit -m x" }, options)).text).toMatch(/only these git subcommands/);
		expect((await runManagerTool("git", { args: "diff --output=/tmp/x" }, options)).text).toMatch(/not allowed/);
	});
});

test("audit replies turn reopen/unblock checks into ledger edits and reject unknown results", () => {
	const verdict = parseAuditVerdict(
		JSON.stringify({
			checks: [
				{ id: "A1", result: "holds", how: "pytest passed" },
				{ id: "A2", result: "reopen", how: "the guard is not in b.py" },
				{ id: "A3", result: "unverifiable", how: "needs the live host" },
				{ id: "B1", result: "unblock", how: "only needs a local test" },
			],
			summary: "one tick does not hold",
		}),
	);
	expect(verdict.edits).toEqual([
		{ id: "A2", kind: "reopen", reason: "the guard is not in b.py" },
		{ id: "B1", kind: "unblock", reason: "only needs a local test" },
	]);
	expect(() => parseAuditVerdict('{"checks": [{"id": "A1", "result": "probably"}]}')).toThrow(/result/);
});
