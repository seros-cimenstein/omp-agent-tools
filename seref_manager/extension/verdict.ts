/**
 * Parse and validate the manager model's JSON replies. Anything malformed throws, so the
 * caller can retry once and then fall back; a partially valid reply is never half-applied.
 */
import { isRecord } from "./guards";
import type { LedgerEdit } from "./ledger";

export interface IterationVerdict {
	verdict: "continue" | "stuck";
	reason: string;
	edits: LedgerEdit[];
	answers: { question: string; answer: string }[];
	guidance: string;
	context: "keep" | "compact" | "reset";
}

export interface AskQuestion {
	id: string;
	question: string;
	options: { label: string; description?: string }[];
	multi?: boolean;
	recommended?: number;
}

export interface AskAnswer {
	id: string;
	question: string;
	/** Option labels picked, exactly as offered. */
	selected: string[];
	custom?: string;
	decided: boolean;
	why: string;
}

/** The first balanced top-level JSON object in `text` (tolerates ```json fences and prose around it). */
export function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start === -1) throw new Error("reply has no JSON object");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
	}
	throw new Error("reply has an unterminated JSON object");
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string {
	const value = record[key];
	if (typeof value === "string") return value.trim();
	if ((value === undefined || value === null) && fallback !== undefined) return fallback;
	throw new Error(`"${key}" must be a string`);
}

function arrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const value = record[key];
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`"${key}" must be an array of objects`);
	return value;
}

export function parseIterationVerdict(text: string): IterationVerdict {
	const raw = extractJsonObject(text);
	if (!isRecord(raw)) throw new Error("reply is not a JSON object");
	const verdict = raw.verdict;
	if (verdict !== "continue" && verdict !== "stuck") throw new Error(`"verdict" must be "continue" or "stuck"`);
	const context = raw.context ?? "keep";
	if (context !== "keep" && context !== "compact" && context !== "reset") {
		throw new Error(`"context" must be "keep", "compact" or "reset"`);
	}
	const edits: LedgerEdit[] = [];
	for (const [key, kind] of [
		["reopen", "reopen"],
		["unblock", "unblock"],
	] as const) {
		for (const entry of arrayField(raw, key)) {
			edits.push({ id: stringField(entry, "id"), kind, reason: stringField(entry, "reason") });
		}
	}
	return {
		verdict,
		reason: stringField(raw, "reason", ""),
		edits,
		answers: arrayField(raw, "answers").map(entry => ({
			question: stringField(entry, "question"),
			answer: stringField(entry, "answer"),
		})),
		guidance: stringField(raw, "guidance", ""),
		context,
	};
}

/**
 * Map the manager's ask reply onto the questions. Labels must match an offered option; a
 * single-select question takes only the first. A question the reply omits, or answers with
 * nothing usable, counts as deferred rather than guessed.
 */
export function parseAskAnswers(text: string, questions: readonly AskQuestion[]): AskAnswer[] {
	const raw = extractJsonObject(text);
	if (!isRecord(raw)) throw new Error("reply is not a JSON object");
	const byId = new Map(arrayField(raw, "answers").map(entry => [entry.id, entry]));
	return questions.map(question => {
		const entry = byId.get(question.id);
		if (!entry) return { id: question.id, question: question.question, selected: [], decided: false, why: "the manager gave no answer" };
		const labels = new Set(question.options.map(option => option.label));
		const picked = Array.isArray(entry.selected)
			? entry.selected.filter((label): label is string => typeof label === "string" && labels.has(label))
			: [];
		const selected = question.multi === true ? picked : picked.slice(0, 1);
		const custom = typeof entry.custom === "string" && entry.custom.trim() ? entry.custom.trim() : undefined;
		const why = typeof entry.why === "string" ? entry.why.trim() : "";
		const decided = entry.decided !== false && (selected.length > 0 || custom !== undefined);
		return {
			id: question.id,
			question: question.question,
			selected: decided ? selected : [],
			custom: decided ? custom : undefined,
			decided,
			why: why || (decided ? "" : "the manager would not decide this for the user"),
		};
	});
}
