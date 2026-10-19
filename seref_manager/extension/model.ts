/**
 * The manager's model: a `seref_manager` model role that shows up in omp's `/models` role picker
 * (model and thinking level picked there like any other role), resolved through omp's own role
 * resolver, plus the one manager call. Credentials come from omp's model registry.
 */
import { completeSimple, type Message, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getModelMatchPreferences, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export const MANAGER_ROLE = "seref_manager";
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** A reasoning effort, or `off` for no reasoning. */
export type ManagerEffort = (typeof EFFORTS)[number] | "off";
/** Effort when the role (or `--model`) names none, or says `auto`/`inherit`. */
const DEFAULT_EFFORT: ManagerEffort = "high";

const TIMEOUT_MS = 5 * 60_000;
const MAX_TOKENS = 16_000;

export interface ManagerTarget {
	model: Model;
	effort: ManagerEffort;
	/** Where the choice came from, for status lines. */
	source: "--model" | "seref_manager role" | "session model" | "worker model (manager role out of quota)";
}

/** The settings of the session whose handler is running (call inside a handler), else omp's global settings. */
export function currentSettings(): Settings | undefined {
	return findScopedSettings();
}

/**
 * Make `seref_manager` a role in `/models` → Roles, so it can be assigned a model and thinking
 * level there. The tag lives in the runtime override layer, not config.yml: uninstalling the
 * extension removes the role from the picker, while an assignment stays in `modelRoles`. A tag
 * the user defined in config wins.
 */
export function registerManagerRole(settings: Settings): void {
	if (Object.hasOwn(cfgModelTags.get(settings), MANAGER_ROLE)) return;
	cfgModelTags.override(settings, { [MANAGER_ROLE]: { name: "Seref Manager", color: "accent" } });
}

function toEffort(level: unknown): ManagerEffort {
	if (level === "off") return "off";
	return EFFORTS.find(effort => effort === level) ?? DEFAULT_EFFORT;
}

/**
 * `spec` (`--model`: `provider/id`, bare id, `@role`, `:level` suffix) wins; then the
 * `seref_manager` role when assigned; then the session's model. Model and thinking level go
 * through omp's role resolver, so `@role` chains and `:level` suffixes behave as everywhere in omp.
 * Resolved on every call, so a role change in `/models` applies from the next review on.
 */
export function resolveManagerModel(ctx: ExtensionContext, settings: Settings | undefined, spec: string | undefined): ManagerTarget {
	const selector = spec ?? (settings?.getModelRole(MANAGER_ROLE) ? `@${MANAGER_ROLE}` : undefined);
	if (!selector) {
		const current = ctx.models.current();
		if (!current) throw new Error("the session has no model; assign the Seref Manager role in /models or pass --model");
		return { model: current, effort: DEFAULT_EFFORT, source: "session model" };
	}
	const resolved = resolveModelRoleValue(selector, ctx.modelRegistry.getAvailable(), {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) throw new Error(`no available model matches ${selector}${resolved.warning ? ` (${resolved.warning})` : ""}`);
	return { model: resolved.model, effort: toEffort(resolved.thinkingLevel), source: spec ? "--model" : "seref_manager role" };
}

export function describeTarget(target: ManagerTarget): string {
	return `${target.model.provider}/${target.model.id}:${target.effort} (${target.source})`;
}

export async function callManager(
	ctx: ExtensionContext,
	target: ManagerTarget,
	systemPrompt: string,
	userText: string,
	signal: AbortSignal,
): Promise<string> {
	const message = await completeSimple(
		target.model,
		{ systemPrompt: [systemPrompt], messages: [{ role: "user", content: userText, timestamp: Date.now() }] },
		{
			apiKey: ctx.modelRegistry.resolver(target.model, ctx.sessionManager.getSessionId()),
			...(target.effort === "off" ? { disableReasoning: true } : { reasoning: target.effort }),
			maxTokens: MAX_TOKENS,
			signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
		},
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(`manager model ${message.stopReason}: ${message.errorMessage ?? "no detail"}`, { cause: message });
	}
	const text = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	if (!text.trim()) throw new Error("manager model returned no text");
	return text;
}

/** Tool calls tolerated past the budget (each answered with an error) before the call fails. */
const OVER_BUDGET_CALLS = 8;

export interface ToolCallRecord {
	name: string;
	args: string;
	isError: boolean;
	/** First line of the result, for the audit log. */
	summary: string;
}

/**
 * A manager call that may investigate first: the model calls `tools` (executed by `execute`)
 * until it answers in text. After `maxCalls` tool calls, further calls get an error result and
 * the model is told to answer; `toolChoice: "none"` then forces the reply.
 */
export async function callManagerWithTools(
	ctx: ExtensionContext,
	target: ManagerTarget,
	systemPrompt: string,
	userText: string,
	signal: AbortSignal,
	options: {
		tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
		execute: (name: string, args: unknown, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;
		maxCalls: number;
		onCall?: (record: ToolCallRecord) => void;
	},
): Promise<{ text: string; calls: ToolCallRecord[] }> {
	const messages: Message[] = [{ role: "user", content: userText, timestamp: Date.now() }];
	const calls: ToolCallRecord[] = [];
	const reasoning: SimpleStreamOptions =
		target.effort === "off" ? { disableReasoning: true } : { reasoning: target.effort };
	for (;;) {
		if (calls.length >= options.maxCalls + OVER_BUDGET_CALLS) throw new Error("manager kept calling tools past its budget");
		const exhausted = calls.length >= options.maxCalls;
		const message = await completeSimple(
			target.model,
			{ systemPrompt: [systemPrompt], messages, tools: [...options.tools] },
			{
				apiKey: ctx.modelRegistry.resolver(target.model, ctx.sessionManager.getSessionId()),
				...reasoning,
				maxTokens: MAX_TOKENS,
				signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
				...(exhausted ? { toolChoice: "none" as const } : {}),
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(`manager model ${message.stopReason}: ${message.errorMessage ?? "no detail"}`, { cause: message });
		}
		messages.push(message);
		const toolCalls = message.content.flatMap(block => (block.type === "toolCall" ? [block] : []));
		if (toolCalls.length === 0) {
			const text = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
			if (!text.trim()) throw new Error("manager model returned no text");
			return { text, calls };
		}
		for (const call of toolCalls) {
			const result =
				calls.length >= options.maxCalls
					? { text: "Tool budget used up. Answer now with what you found; mark what you could not check as unverifiable.", isError: true }
					: await options.execute(call.name, call.arguments, signal);
			if (signal.aborted) throw new Error("manager call aborted");
			const record: ToolCallRecord = {
				name: call.name,
				args: JSON.stringify(call.arguments),
				isError: result.isError,
				summary: result.text.split("\n", 1)[0].slice(0, 160),
			};
			calls.push(record);
			options.onCall?.(record);
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
				timestamp: Date.now(),
			});
		}
	}
}
