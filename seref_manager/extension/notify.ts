/**
 * Phone notifications through ntfy (https://ntfy.sh, or a self-hosted server).
 *
 * - The configured `topic` is the general channel: it only announces new loops, each with its own
 *   topic (`<project>-<random>`) to subscribe to.
 * - A loop's topic gets its progress and alerts: done, stuck, paused, usage-limit waits, blockers,
 *   questions, stalls (worker, manager, idle), and an offline alert.
 * - The offline alert is a dead man's switch kept on the ntfy server: a delayed message under a
 *   fixed sequence id that a living loop keeps pushing back. When omp dies, the machine sleeps or
 *   the network drops, the pushes stop and the server delivers it.
 *
 * Config: `SEREF_NTFY_TOPIC` / `SEREF_NTFY_SERVER` / `SEREF_NTFY_TOKEN`, else the file at
 * `SEREF_NTFY_CONFIG` or
 * `~/.config/seref_omp_tools/ntfy.json`. Without a topic nothing is sent.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "./guards";

export interface NtfyConfig {
	server: string;
	/** The general channel: announcements of new loops (everything, when `perLoop` is off). */
	topic: string;
	/** Access token for a protected topic or a self-hosted server. */
	token?: string;
	/** Events below this priority are not sent (1 min … 5 max). */
	minPriority: number;
	/** Give every loop its own topic (default) instead of sending everything to `topic`. */
	perLoop: boolean;
	/** Minutes of silence before a worker, manager or idle-loop stall alert (default 20). */
	stallMinutes: number;
	/** Minutes without a sign of life before the server sends the offline alert (default 60; 0 = off). */
	offlineMinutes: number;
	/** Where the config came from, for status. */
	origin: string;
}

/** ntfy priorities: 1 min, 2 low, 3 default, 4 high, 5 urgent. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface NtfyEvent {
	title: string;
	message: string;
	priority: NtfyPriority;
	/** ntfy tags; emoji short codes render as icons (`white_check_mark`, `warning`, …). */
	tags: string[];
	/** Opened when the notification is tapped. */
	click?: string;
	/** A message with a sequence id replaces (or, scheduled, reschedules) the earlier one with that id. */
	sequenceId?: string;
	/** Deliver later, e.g. `60m`; with `sequenceId`, the dead man's switch. */
	delay?: string;
}

export const NTFY_CONFIG_PATH = path.join(os.homedir(), ".config", "seref_omp_tools", "ntfy.json");
const DEFAULT_SERVER = "https://ntfy.sh";
const SEND_TIMEOUT_MS = 10_000;
const MESSAGE_LIMIT = 3_500;
const OUTBOX_LIMIT = 20;

function intIn(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The ntfy settings, from the environment first, then the config file; undefined when no topic is set. */
export function loadNtfyConfig(
	env: Record<string, string | undefined> = process.env,
	file = env.SEREF_NTFY_CONFIG ?? NTFY_CONFIG_PATH,
): NtfyConfig | undefined {
	let fromFile: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(parsed)) fromFile = parsed;
	} catch {
		// No config file (or unreadable JSON): environment only.
	}
	const pick = (envKey: string, fileKey: string): string | undefined => {
		const value = env[envKey] ?? fromFile[fileKey];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	const topic = pick("SEREF_NTFY_TOPIC", "topic");
	if (!topic) return undefined;
	return {
		server: (pick("SEREF_NTFY_SERVER", "server") ?? DEFAULT_SERVER).replace(/\/+$/, ""),
		topic,
		token: pick("SEREF_NTFY_TOKEN", "token"),
		minPriority: intIn(fromFile.minPriority, 1, 5, 1),
		perLoop: fromFile.perLoop !== false,
		stallMinutes: intIn(fromFile.stallMinutes, 1, 24 * 60, 20),
		// ntfy.sh schedules at most 3 days ahead.
		offlineMinutes: intIn(fromFile.offlineMinutes, 0, 3 * 24 * 60, 60),
		origin: env.SEREF_NTFY_TOPIC ? "environment" : file,
	};
}

/** A fresh, unguessable topic for one loop: `<project>-<10 random chars>`, within ntfy's topic alphabet. */
export function perLoopTopic(project: string): string {
	const slug = project.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "loop";
	const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
	const random = [...crypto.randomBytes(10)].map(byte => alphabet[byte % alphabet.length]).join("");
	return `${slug}-${random}`;
}

/** The JSON body ntfy's publish endpoint takes (UTF-8 safe, unlike header publishing). */
export function ntfyPayload(topic: string, event: NtfyEvent): Record<string, unknown> {
	const message = event.message.length > MESSAGE_LIMIT ? `${event.message.slice(0, MESSAGE_LIMIT - 1)}…` : event.message;
	return {
		topic,
		title: event.title,
		message,
		priority: event.priority,
		tags: event.tags,
		...(event.click ? { click: event.click } : {}),
		...(event.sequenceId ? { sequence_id: event.sequenceId } : {}),
		...(event.delay ? { delay: event.delay } : {}),
	};
}

function authHeaders(config: NtfyConfig): Record<string, string> {
	return config.token ? { authorization: `Bearer ${config.token}` } : {};
}

/** Publish one event to `topic`; resolves to an error description instead of throwing. Ignores `minPriority`. */
export async function publishNtfy(config: NtfyConfig, topic: string, event: NtfyEvent): Promise<string | undefined> {
	try {
		const response = await fetch(config.server, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(config) },
			body: JSON.stringify(ntfyPayload(topic, event)),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		return response.ok ? undefined : `ntfy answered ${response.status} ${(await response.text()).slice(0, 200)}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Drop a scheduled message (the dead man's switch) before it is delivered. A missing one is fine.
 * ntfy.sh stores new messages in batches: until a publish is stored, a delete misses it and the
 * schedule does not show it, and the message is delivered later anyway. So wait `settleMs` when
 * the publish was just now, then delete until the schedule is clear.
 */
export async function cancelNtfy(
	config: NtfyConfig,
	topic: string,
	sequenceId: string,
	{ settleMs = 0, retryMs = 1000 }: { settleMs?: number; retryMs?: number } = {},
): Promise<string | undefined> {
	try {
		if (settleMs > 0) await Bun.sleep(settleMs);
		for (let attempt = 1; attempt <= 5; attempt++) {
			const response = await fetch(`${config.server}/${topic}/${sequenceId}`, {
				method: "DELETE",
				headers: authHeaders(config),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			if (!response.ok && response.status !== 404) return `ntfy answered ${response.status}`;
			const scheduled = await fetch(`${config.server}/${topic}/json?poll=1&sched=1`, {
				headers: authHeaders(config),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			const pending = (await scheduled.text()).split("\n").some(line => {
				if (!line.trim()) return false;
				const message: unknown = JSON.parse(line);
				return (
					isRecord(message) &&
					message.event === "message" &&
					message.sequence_id === sequenceId &&
					typeof message.time === "number" &&
					message.time * 1000 > Date.now()
				);
			});
			if (!pending) return undefined;
			await Bun.sleep(retryMs * attempt);
		}
		return "the scheduled message is still there after 5 deletes";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** The server's daily message allowance for this machine (ntfy.sh counts per IP), for status. */
export async function ntfyQuotaLine(config: NtfyConfig): Promise<string> {
	try {
		const response = await fetch(`${config.server}/v1/account`, { headers: authHeaders(config), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
		const body: unknown = await response.json();
		if (!isRecord(body) || !isRecord(body.limits) || !isRecord(body.stats)) return "";
		const { messages } = body.limits;
		const { messages_remaining: remaining } = body.stats;
		return typeof messages === "number" && typeof remaining === "number" ? `messages today: ${remaining} of ${messages} left` : "";
	} catch {
		return "";
	}
}

/**
 * Sends events, keeping the ones that could not be delivered (network down, rate limit) and
 * delivering them, marked as delayed, after the next send that works. Below `minPriority`
 * nothing is sent; scheduled (sequence id) messages are never queued, since they are re-sent anyway.
 */
export class NtfyOutbox {
	#pending: { topic: string; event: NtfyEvent; failedAt: number }[] = [];

	constructor(
		private readonly publish: (config: NtfyConfig, topic: string, event: NtfyEvent) => Promise<string | undefined> = publishNtfy,
		private readonly now: () => number = Date.now,
	) {}

	get pending(): number {
		return this.#pending.length;
	}

	async send(config: NtfyConfig, topic: string, event: NtfyEvent): Promise<string | undefined> {
		if (event.priority < config.minPriority) return undefined;
		const failure = await this.publish(config, topic, event);
		if (failure) {
			if (!event.sequenceId) {
				this.#pending.push({ topic, event, failedAt: this.now() });
				if (this.#pending.length > OUTBOX_LIMIT) this.#pending.shift();
			}
			return failure;
		}
		await this.flush(config);
		return undefined;
	}

	/** Deliver what is queued, oldest first; stops at the first failure. */
	async flush(config: NtfyConfig): Promise<void> {
		while (this.#pending.length > 0) {
			const [next] = this.#pending;
			const delayed = { ...next.event, message: `(delayed, from ${new Date(next.failedAt).toTimeString().slice(0, 5)}) ${next.event.message}` };
			if (await this.publish(config, next.topic, delayed)) return;
			this.#pending.shift();
		}
	}
}
