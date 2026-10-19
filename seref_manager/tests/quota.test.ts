import { describe, expect, test } from "bun:test";
import {
	chooseResumeAt,
	describeUsage,
	findUsageLimit,
	ompWaitFromFinalError,
	PROBE_INTERVAL_MS,
	type QuotaError,
} from "../extension/quota";

/** Stand-in for omp's classifier (exercised against the real one in omp); annotates its argument like the real one. */
const classifier = (fields: QuotaError): boolean => {
	fields.errorId = 1;
	return /usage limit/i.test(fields.errorMessage ?? "");
};

const MINUTE = 60_000;
const codexLimit = {
	role: "assistant",
	stopReason: "error",
	provider: "openai-codex",
	model: "gpt-6",
	errorStatus: 429,
	errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.",
};

describe("findUsageLimit", () => {
	test("finds the limit on a failed message and through an Error's cause chain", () => {
		expect(findUsageLimit(codexLimit, classifier)).toMatchObject({ provider: "openai-codex", model: "gpt-6" });
		const wrapped = new Error("outer", { cause: new Error("manager model error", { cause: codexLimit }) });
		expect(findUsageLimit(wrapped, classifier)?.provider).toBe("openai-codex");
	});

	test("returns nothing when the classifier says it is not a usage limit", () => {
		expect(findUsageLimit({ ...codexLimit, errorMessage: "429 Too many requests" }, classifier)).toBeUndefined();
		expect(findUsageLimit(new Error("plain failure"), classifier)).toBeUndefined();
	});

	test("the classifier works on a copy, so the session's message is not changed", () => {
		const message = { ...codexLimit };
		findUsageLimit(message, classifier);
		expect(message).toEqual(codexLimit);
	});
});

describe("chooseResumeAt", () => {
	const now = 1_000_000_000_000;

	test("an account reset from the usage report wins, earliest future one plus a minute", () => {
		expect(chooseResumeAt({ now, accountResets: [now - MINUTE, now + 90 * MINUTE, now + 30 * MINUTE], hintMs: 5 * MINUTE })).toEqual({
			at: now + 31 * MINUTE,
			source: "usage report",
		});
	});

	test("otherwise the longer of the provider hint and omp's estimate", () => {
		expect(chooseResumeAt({ now, accountResets: [], hintMs: 20 * MINUTE, ompWaitMs: 40 * MINUTE })).toEqual({
			at: now + 41 * MINUTE,
			source: "omp retry estimate",
		});
		expect(chooseResumeAt({ now, accountResets: [], hintMs: 20 * MINUTE }).source).toBe("provider hint");
	});

	test("without information it probes, and never resumes sooner than a minute", () => {
		expect(chooseResumeAt({ now, accountResets: [] })).toEqual({ at: now + PROBE_INTERVAL_MS, source: "probe" });
		expect(chooseResumeAt({ now, accountResets: [now + 1_000] }).at).toBe(now + 61_000);
		expect(chooseResumeAt({ now, accountResets: [], hintMs: 1 }).at).toBe(now + MINUTE + 1);
	});
});

test("usage lines read like /usage", () => {
	const now = new Date("2026-10-19T10:00:00").getTime();
	expect(describeUsage({ state: "healthy", resets: [], bestRemaining: 0.42 }, now)).toBe("ok, best account 42% left");
	expect(describeUsage({ state: "reserve", resets: [] }, now)).toBe("running low");
	expect(describeUsage({ state: "depleted", resets: [new Date("2026-10-19T14:30:00").getTime()] }, now)).toBe("out of quota until 14:30");
	expect(describeUsage({ state: "depleted", resets: [new Date("2026-10-24T14:24:00").getTime()] }, now)).toBe("out of quota until Sat Oct 24 14:24");
	expect(describeUsage({ state: "unknown", resets: [] }, now)).toMatch(/unknown/);
});

test("omp's give-up message carries the wait it computed", () => {
	expect(ompWaitFromFinalError("Provider requested 9480000ms wait, exceeds retry.maxDelayMs (300000)ms. Original error: …")).toBe(9_480_000);
	expect(ompWaitFromFinalError("Retry cancelled")).toBeUndefined();
});
