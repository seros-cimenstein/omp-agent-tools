/**
 * One manager model call: own system prompt, no tools, text out. Uses omp's model registry
 * and credentials, so any model the session can use works.
 */
import { completeSimple, type Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ManagerEffort = (typeof EFFORTS)[number];

const TIMEOUT_MS = 5 * 60_000;
const MAX_TOKENS = 16_000;

/**
 * Resolve `spec` (`provider/id`, bare id, `@role`, optional `:effort` suffix) or, without
 * one, the session's current model. Throws when nothing matches.
 */
export function resolveManagerModel(
	ctx: ExtensionContext,
	spec: string | undefined,
	fallbackEffort: ManagerEffort,
): { model: Model; effort: ManagerEffort } {
	if (!spec) {
		const current = ctx.models.current();
		if (!current) throw new Error("the session has no model; pass --model");
		return { model: current, effort: fallbackEffort };
	}
	const suffix = /:([a-z]+)$/.exec(spec);
	const effort = EFFORTS.find(candidate => candidate === suffix?.[1]);
	const base = effort ? spec.slice(0, -(effort.length + 1)) : spec;
	const model = ctx.models.resolve(base);
	if (!model) throw new Error(`no model matches "${base}"`);
	return { model, effort: effort ?? fallbackEffort };
}

export async function callManager(
	ctx: ExtensionContext,
	target: { model: Model; effort: ManagerEffort },
	systemPrompt: string,
	userText: string,
	signal: AbortSignal,
): Promise<string> {
	const message = await completeSimple(
		target.model,
		{ systemPrompt: [systemPrompt], messages: [{ role: "user", content: userText, timestamp: Date.now() }] },
		{
			apiKey: ctx.modelRegistry.resolver(target.model, ctx.sessionManager.getSessionId()),
			reasoning: target.effort,
			maxTokens: MAX_TOKENS,
			signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
		},
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(`manager model ${message.stopReason}: ${message.errorMessage ?? "no detail"}`);
	}
	const text = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	if (!text.trim()) throw new Error("manager model returned no text");
	return text;
}
