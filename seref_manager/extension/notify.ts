/**
 * Phone notifications through ntfy (https://ntfy.sh, or a self-hosted server): one message per
 * loop event that matters when you are away (done, stuck, paused, waiting on a usage limit, a
 * question only you can answer), titled with the project so several loops stay apart.
 *
 * Config: `SEREF_NTFY_TOPIC` / `SEREF_NTFY_SERVER` / `SEREF_NTFY_TOKEN`, else
 * `~/.config/seref_omp_tools/ntfy.json` `{ "topic": "…", "server": "https://ntfy.sh", "token"?: "…",
 * "minPriority"?: 1-5 }`. Without a topic nothing is sent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "./guards";

export interface NtfyConfig {
	server: string;
	topic: string;
	/** Access token for a protected topic or a self-hosted server. */
	token?: string;
	/** Events below this priority are not sent (1 min … 5 max). */
	minPriority: number;
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
}

export const NTFY_CONFIG_PATH = path.join(os.homedir(), ".config", "seref_omp_tools", "ntfy.json");
const DEFAULT_SERVER = "https://ntfy.sh";
const SEND_TIMEOUT_MS = 10_000;
const MESSAGE_LIMIT = 3_500;

function clampPriority(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : 1;
}

/** The ntfy settings, from the environment first, then the config file; undefined when no topic is set. */
export function loadNtfyConfig(env: Record<string, string | undefined> = process.env, file = NTFY_CONFIG_PATH): NtfyConfig | undefined {
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
		minPriority: clampPriority(fromFile.minPriority),
		origin: env.SEREF_NTFY_TOPIC ? "environment" : file,
	};
}

/** The JSON body ntfy's publish endpoint takes (UTF-8 safe, unlike header publishing). */
export function ntfyPayload(config: NtfyConfig, event: NtfyEvent): Record<string, unknown> {
	const message = event.message.length > MESSAGE_LIMIT ? `${event.message.slice(0, MESSAGE_LIMIT - 1)}…` : event.message;
	return { topic: config.topic, title: event.title, message, priority: event.priority, tags: event.tags };
}

/** Publish one event; resolves to an error description instead of throwing (notifications are best effort). */
export async function sendNtfy(config: NtfyConfig, event: NtfyEvent): Promise<string | undefined> {
	if (event.priority < config.minPriority) return undefined;
	try {
		const response = await fetch(config.server, {
			method: "POST",
			headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
			body: JSON.stringify(ntfyPayload(config, event)),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		return response.ok ? undefined : `ntfy answered ${response.status} ${(await response.text()).slice(0, 200)}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
