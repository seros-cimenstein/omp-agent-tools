/**
 * Compact text digest of one loop iteration for the manager model: what the worker said,
 * which tools it ran with which arguments, and how each call ended (head + tail of output,
 * so test summaries at the end survive truncation).
 */

import { isRecord } from "./guards";

const USER_LIMIT = 2_000;
const ASSISTANT_LIMIT = 3_000;
const ARGS_LIMIT = 600;
const RESULT_HEAD = 400;
const RESULT_TAIL = 800;

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} chars cut]` : text;
}

function headTail(text: string): string {
	if (text.length <= RESULT_HEAD + RESULT_TAIL) return text;
	return `${text.slice(0, RESULT_HEAD)}\n… [${text.length - RESULT_HEAD - RESULT_TAIL} chars cut] …\n${text.slice(-RESULT_TAIL)}`;
}

/** Text of a message `content` (string or block array); non-text blocks are skipped. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function renderMessage(message: Record<string, unknown>): string | undefined {
	switch (message.role) {
		case "user": {
			const text = contentText(message.content).trim();
			return text ? `USER: ${clip(text, USER_LIMIT)}` : undefined;
		}
		case "assistant": {
			if (!Array.isArray(message.content)) return undefined;
			const lines: string[] = [];
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
					lines.push(`WORKER: ${clip(block.text.trim(), ASSISTANT_LIMIT)}`);
				} else if (block.type === "toolCall" && typeof block.name === "string") {
					lines.push(`CALL ${block.name} ${clip(JSON.stringify(block.arguments ?? {}), ARGS_LIMIT)}`);
				}
			}
			if (message.stopReason === "aborted") lines.push("(turn aborted by the user)");
			if (message.stopReason === "error") lines.push(`(turn ended with an error: ${String(message.errorMessage ?? "")})`);
			return lines.length > 0 ? lines.join("\n") : undefined;
		}
		case "toolResult": {
			const name = typeof message.toolName === "string" ? message.toolName : "?";
			const status = message.isError === true ? "ERROR" : "ok";
			return `RESULT ${name} [${status}]: ${headTail(contentText(message.content).trim())}`;
		}
		default:
			return undefined;
	}
}

/**
 * Digest of the session entries after `startLeafId` (the leaf before the iteration prompt
 * was sent). Falls back to the whole list when that entry is no longer on the branch.
 * `maxChars` keeps the first quarter and the most recent rest when the iteration is long.
 */
export function digestIteration(entries: readonly unknown[], startLeafId: string | null, maxChars: number): string {
	let start = 0;
	if (startLeafId !== null) {
		const index = entries.findIndex(entry => isRecord(entry) && entry.id === startLeafId);
		if (index !== -1) start = index + 1;
	}
	const rendered: string[] = [];
	for (const entry of entries.slice(start)) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const text = renderMessage(entry.message);
		if (text) rendered.push(text);
	}
	const full = rendered.join("\n\n");
	if (full.length <= maxChars) return full;
	const head = Math.floor(maxChars / 4);
	return `${full.slice(0, head)}\n\n… [${full.length - maxChars} chars of the middle of this iteration cut] …\n\n${full.slice(-(maxChars - head))}`;
}

/** The last assistant message in an `agent_end` message list, its text, and how it stopped. */
export function lastAssistant(
	messages: readonly unknown[],
): { text: string; stopReason: unknown; message: Record<string, unknown> } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (isRecord(message) && message.role === "assistant") {
			return { text: contentText(message.content), stopReason: message.stopReason, message };
		}
	}
	return undefined;
}
