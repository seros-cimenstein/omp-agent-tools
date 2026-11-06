/**
 * Read-mostly tools for the manager model when it has to verify work it did not watch (the audit
 * of items ticked before it took over). Everything runs inside the repo root:
 *
 * - `read_file`, `search` (ripgrep), `git` (read-only subcommands, no shell): observe only.
 * - `run_check`: runs a command only when it appears verbatim in the ledger (a backticked span the
 *   ledger's author wrote for the worker to run) and passes a denylist of mutating commands. The
 *   ledger allowlist bounds what can run; the denylist keeps deploys, deletes and writes out even
 *   when the ledger mentions them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "./guards";

export interface ToolResult {
	text: string;
	isError: boolean;
}

export interface ManagerTool {
	name: string;
	description: string;
	/** Plain JSON Schema, which omp's providers accept for tool parameters. */
	parameters: Record<string, unknown>;
}

const OUTPUT_LIMIT = 24_000;
const READ_LINE_LIMIT = 400;
const SEARCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 5 * 60_000;
const GIT_SUBCOMMANDS: Record<string, true> = {
	status: true,
	diff: true,
	log: true,
	show: true,
	blame: true,
	"ls-files": true,
	grep: true,
	"rev-parse": true,
};
/** Git flags that write files or launch programs even under a read-only subcommand. */
const GIT_FORBIDDEN_FLAG = /^(--output|-O|--open-files-in-pager|--ext-diff|--textconv)/;

/** Commands and constructs `run_check` refuses even when the ledger names them. */
const MUTATING_PATTERNS: readonly RegExp[] = [
	/(^|[\s;&|(`])(sudo|doas|su|rm|rmdir|mv|dd|shred|truncate|chmod|chown|chgrp|ln|kill|pkill|killall|reboot|shutdown|halt|systemctl|service|crontab|docker|podman|kubectl|helm|terraform|ansible|ansible-playbook|scp|rsync|ssh|sftp|ftp|psql|mysql|sqlite3|redis-cli|mongosh|tee|install|wget)(?=$|[\s;&|)`])/,
	/(^|[\s;&|(`])mkfs/,
	/(^|[\s;&|(`])deploy/i,
	/\bgit\s+(commit|push|pull|fetch|reset|checkout|switch|restore|clean|stash|rebase|merge|cherry-pick|revert|rm|mv|tag|am|apply|worktree|gc|prune|config|branch|remote|submodule|init|clone)\b/,
	/\b(npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go|gem|apt|apt-get|dnf|yum|pacman|brew)\s+(install|add|remove|uninstall|publish|update|upgrade|i|rm|sync|get)\b/,
	/\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
	/\bperl\b[^|;&]*\s-[a-zA-Z]*i/,
	/\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-d\b|--data|-F\b|--form|-T\b|--upload-file|-o\b|--output|-O\b)/i,
];

export const MANAGER_TOOLS: readonly ManagerTool[] = [
	{
		name: "read_file",
		description: "Read a text file inside the repository, with line numbers. Use offset/limit for long files.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the repository root" },
				offset: { type: "number", description: "1-based first line (default 1)" },
				limit: { type: "number", description: `Number of lines (default and max ${READ_LINE_LIMIT})` },
			},
			required: ["path"],
		},
	},
	{
		name: "search",
		description: "Search file contents in the repository with ripgrep (regex). Returns file:line:text matches.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "ripgrep regex" },
				path: { type: "string", description: "File or directory to search, relative to the repository root (default: whole repo)" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "git",
		description: `Run a read-only git command in the repository: ${Object.keys(GIT_SUBCOMMANDS).join(", ")}. Arguments are split on whitespace; no shell.`,
		parameters: {
			type: "object",
			properties: { args: { type: "string", description: 'For example "diff --stat" or "log -5 --oneline -- src/a.py"' } },
			required: ["args"],
		},
	},
	{
		name: "run_check",
		description:
			"Run a verification command exactly as it is written in the ledger (inside backticks), such as an item's acceptance command or the Protocol's test command. Other commands, and commands that deploy, delete, write files or touch remote hosts, are refused.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command, verbatim from the ledger" },
				cwd: { type: "string", description: "Directory relative to the repository root (default: root)" },
			},
			required: ["command"],
		},
	},
];

function normalizeCommand(command: string): string {
	return command.replace(/^\$\s+/, "").replace(/\s+/g, " ").trim();
}

/** Backticked spans of the ledger: the commands its author wrote for the worker, and so the only ones `run_check` may run. */
export function ledgerCommands(ledgerText: string): Set<string> {
	const commands = new Set<string>();
	for (const match of ledgerText.matchAll(/`([^`\n]+)`/g)) {
		const command = normalizeCommand(match[1]);
		if (command) commands.add(command);
	}
	return commands;
}

/** Why `command` may not run, or undefined when it may. */
export function refuseCommand(command: string, allowed: ReadonlySet<string>): string | undefined {
	const normalized = normalizeCommand(command);
	if (!allowed.has(normalized)) return "not a command written in the ledger; run_check only runs backticked ledger commands verbatim";
	// Quoted text cannot redirect; drop it, then drop harmless redirections, before looking for writes.
	const unquoted = normalized.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
	const withoutSafeRedirects = unquoted.replace(/&?\d?>>?\s*\/dev\/null/g, "").replace(/\d?>&\d/g, "");
	if (withoutSafeRedirects.includes(">")) return "writes a file through output redirection";
	const pattern = MUTATING_PATTERNS.find(candidate => candidate.test(unquoted));
	if (pattern) return `looks like it changes state (matches ${pattern.source.slice(0, 60)}…)`;
	return undefined;
}

function cap(text: string): string {
	if (text.length <= OUTPUT_LIMIT) return text;
	const head = Math.floor(OUTPUT_LIMIT / 3);
	return `${text.slice(0, head)}\n… [${text.length - OUTPUT_LIMIT} chars cut] …\n${text.slice(-(OUTPUT_LIMIT - head))}`;
}

/** Resolve `relative` under `root`, refusing anything (symlinks included) that lands outside it. */
export function insideRoot(root: string, relative: string): string {
	const realRoot = fs.realpathSync(root);
	const target = fs.realpathSync(path.resolve(realRoot, relative));
	if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${relative} is outside the repository`);
	return target;
}

async function spawnCapture(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
	const proc = Bun.spawn(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const killed = proc.signalCode !== null;
	const body = [stdout.trimEnd(), stderr.trim() ? `[stderr]\n${stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
	const status = killed ? `killed (${proc.signalCode}${signal.aborted ? ", aborted" : `, timeout ${timeoutMs / 1000}s`})` : `exit ${code}`;
	return { text: cap(`${status}\n${body || "(no output)"}`), isError: killed };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

/**
 * Run one manager tool call. Never throws for bad input or failing commands: the model gets the
 * error as the result and can adjust. `ledgerText` is read at call time so the allowlist follows
 * the ledger as it is now.
 */
export async function runManagerTool(
	name: string,
	rawArgs: unknown,
	options: { root: string; ledgerText: () => string; signal: AbortSignal },
): Promise<ToolResult> {
	const args = isRecord(rawArgs) ? rawArgs : {};
	try {
		switch (name) {
			case "read_file": {
				const relative = stringArg(args, "path");
				if (!relative) return { text: "path is required", isError: true };
				const file = insideRoot(options.root, relative);
				const lines = fs.readFileSync(file, "utf8").split("\n");
				const offset = Math.max(1, numberArg(args, "offset") ?? 1);
				const limit = Math.min(READ_LINE_LIMIT, Math.max(1, numberArg(args, "limit") ?? READ_LINE_LIMIT));
				const shown = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`);
				const more = offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines` : "";
				return { text: cap(`${shown.join("\n")}${more}`), isError: false };
			}
			case "search": {
				const pattern = stringArg(args, "pattern");
				if (!pattern) return { text: "pattern is required", isError: true };
				const target = insideRoot(options.root, stringArg(args, "path") ?? ".");
				const argv = ["rg", "-n", "--no-heading", "--max-count", "20", "--max-columns", "300", "-e", pattern, "--", target];
				return await spawnCapture(argv, options.root, SEARCH_TIMEOUT_MS, options.signal);
			}
			case "git": {
				const parts = (stringArg(args, "args") ?? "").split(/\s+/).filter(Boolean);
				const [subcommand, ...rest] = parts;
				if (!subcommand || !GIT_SUBCOMMANDS[subcommand]) {
					return { text: `only these git subcommands: ${Object.keys(GIT_SUBCOMMANDS).join(", ")}`, isError: true };
				}
				const forbidden = rest.find(arg => GIT_FORBIDDEN_FLAG.test(arg));
				if (forbidden) return { text: `flag ${forbidden} is not allowed`, isError: true };
				return await spawnCapture(["git", "--no-pager", subcommand, ...rest], options.root, GIT_TIMEOUT_MS, options.signal);
			}
			case "run_check": {
				const command = stringArg(args, "command");
				if (!command) return { text: "command is required", isError: true };
				const refusal = refuseCommand(command, ledgerCommands(options.ledgerText()));
				if (refusal) return { text: `refused: ${refusal}`, isError: true };
				const cwd = insideRoot(options.root, stringArg(args, "cwd") ?? ".");
				return await spawnCapture(["bash", "-c", normalizeCommand(command)], cwd, CHECK_TIMEOUT_MS, options.signal);
			}
			default:
				return { text: `unknown tool ${name}`, isError: true };
		}
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}
