import { describe, expect, test } from "bun:test";
import { type AskQuestion, extractJsonObject, parseAskAnswers, parseIterationVerdict } from "../extension/verdict";

describe("extractJsonObject", () => {
	test("finds the object inside fences and prose, braces inside strings included", () => {
		const text = 'Here you go:\n```json\n{"guidance": "use {braces} and \\"quotes\\"", "n": {"x": 1}}\n```\ntrailing }';
		expect(extractJsonObject(text)).toEqual({ guidance: 'use {braces} and "quotes"', n: { x: 1 } });
	});

	test("throws without a complete object", () => {
		expect(() => extractJsonObject("no json")).toThrow();
		expect(() => extractJsonObject('{"a": 1')).toThrow();
	});
});

describe("parseIterationVerdict", () => {
	test("maps reopen and unblock into ledger edits and defaults optional fields", () => {
		const verdict = parseIterationVerdict(
			JSON.stringify({ verdict: "continue", reopen: [{ id: "A1", reason: "no test ran" }], unblock: [{ id: "B2", reason: "can do it" }] }),
		);
		expect(verdict.edits).toEqual([
			{ id: "A1", kind: "reopen", reason: "no test ran" },
			{ id: "B2", kind: "unblock", reason: "can do it" },
		]);
		expect(verdict.context).toBe("keep");
		expect(verdict.guidance).toBe("");
		expect(verdict.answers).toEqual([]);
	});

	test("the manager cannot declare the loop done", () => {
		expect(() => parseIterationVerdict('{"verdict": "done"}')).toThrow(/verdict/);
	});

	test("rejects malformed entries instead of applying part of them", () => {
		expect(() => parseIterationVerdict('{"verdict": "continue", "reopen": [{"id": "A1"}]}')).toThrow(/reason/);
		expect(() => parseIterationVerdict('{"verdict": "continue", "context": "reset"}')).toThrow(/context/);
	});
});

describe("parseAskAnswers", () => {
	const questions: AskQuestion[] = [
		{ id: "db", question: "Database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
		{ id: "fmt", question: "Formats?", options: [{ label: "json" }, { label: "csv" }], multi: true },
		{ id: "drop", question: "Drop the prod table?", options: [{ label: "Yes" }, { label: "No" }] },
	];

	test("keeps offered labels only, one for single-select, several for multi", () => {
		const answers = parseAskAnswers(
			JSON.stringify({
				answers: [
					{ id: "db", selected: ["Postgres", "SQLite"], decided: true, why: "existing infra" },
					{ id: "fmt", selected: ["json", "xml", "csv"], decided: true, why: "both used" },
					{ id: "drop", selected: [], decided: false, why: "destructive on live data" },
				],
			}),
			questions,
		);
		expect(answers.map(answer => [answer.id, answer.decided, answer.selected])).toEqual([
			["db", true, ["Postgres"]],
			["fmt", true, ["json", "csv"]],
			["drop", false, []],
		]);
	});

	test("an omitted question or an answer with no usable label is deferred, not guessed", () => {
		const answers = parseAskAnswers(JSON.stringify({ answers: [{ id: "db", selected: ["MySQL"], decided: true }] }), questions);
		expect(answers.every(answer => !answer.decided)).toBe(true);
	});

	test("custom text counts as an answer when no option fits", () => {
		const [db] = parseAskAnswers(JSON.stringify({ answers: [{ id: "db", selected: [], custom: "DuckDB", why: "analytics" }] }), questions);
		expect(db).toMatchObject({ decided: true, custom: "DuckDB", selected: [] });
	});
});
