import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cancelNtfy, loadNtfyConfig, type NtfyConfig, type NtfyEvent, NtfyOutbox, perLoopTopic, publishNtfy } from "../extension/notify";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seref-ntfy-"));
const file = path.join(dir, "ntfy.json");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = (overrides: Partial<NtfyConfig> = {}): NtfyConfig => ({
	server: "http://127.0.0.1:1",
	topic: "general",
	minPriority: 1,
	perLoop: true,
	stallMinutes: 20,
	offlineMinutes: 60,
	origin: "test",
	...overrides,
});
const event: NtfyEvent = { title: "horus · LOOP_X.md · it 2/10", message: "Loop ended: gate passed ✅", priority: 4, tags: ["white_check_mark"] };

test("config: file values with defaults, environment wins, no topic means no notifications", () => {
	expect(loadNtfyConfig({}, file)).toBeUndefined();
	fs.writeFileSync(file, JSON.stringify({ topic: "file-topic", server: "https://ntfy.example/", minPriority: 3, offlineMinutes: 0 }));
	expect(loadNtfyConfig({}, file)).toEqual({
		server: "https://ntfy.example",
		topic: "file-topic",
		token: undefined,
		minPriority: 3,
		perLoop: true,
		stallMinutes: 20,
		offlineMinutes: 0,
		origin: file,
	});
	expect(loadNtfyConfig({ SEREF_NTFY_TOPIC: "env-topic" }, file)).toMatchObject({ topic: "env-topic", origin: "environment" });
	fs.writeFileSync(file, JSON.stringify({ topic: "t", perLoop: false, stallMinutes: -5, offlineMinutes: 99_999 }));
	expect(loadNtfyConfig({}, file)).toMatchObject({ perLoop: false, stallMinutes: 20, offlineMinutes: 60 });
	fs.writeFileSync(file, "{ not json");
	expect(loadNtfyConfig({}, file)).toBeUndefined();
});

test("per-loop topics start with the project, stay in ntfy's alphabet, and are not reused", () => {
	const topic = perLoopTopic("Horus Bot (v2)");
	expect(topic).toMatch(/^horus-bot-v2-[a-z0-9]{10}$/);
	expect(perLoopTopic("Horus Bot (v2)")).not.toBe(topic);
	expect(perLoopTopic("ğüş")).toMatch(/^loop-[a-z0-9]{10}$/);
});

test("publishing sends ntfy JSON; cancelling deletes until the schedule is clear (ntfy.sh can miss an early delete)", async () => {
	const received: { method: string; url: string; body: unknown; auth: string | null }[] = [];
	const now = Math.floor(Date.now() / 1000);
	// An offline alert delivered earlier (past time) stays in the cache and must not count as pending.
	const delivered = { event: "message", id: "old", sequence_id: "seref-offline", time: now - 3600 };
	let scheduled: Record<string, unknown> | undefined;
	let deletes = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = request.method === "POST" ? await request.json() : undefined;
			received.push({ method: request.method, url: url.pathname, body, auth: request.headers.get("authorization") });
			if (request.method === "POST") scheduled = { event: "message", id: "new", sequence_id: "seref-offline", time: now + 3600 };
			// The first delete lands before the publish is stored: it finds nothing.
			if (request.method === "DELETE" && ++deletes > 1) scheduled = undefined;
			if (request.method === "GET") return new Response([delivered, scheduled].filter(Boolean).map(line => JSON.stringify(line)).join("\n"));
			return new Response("{}", { status: request.method === "DELETE" && deletes === 1 ? 404 : 200 });
		},
	});
	try {
		const live = config({ server: `http://127.0.0.1:${server.port}`, token: "secret" });
		expect(await publishNtfy(live, "horus-abc", { ...event, sequenceId: "seref-offline", delay: "60m" })).toBeUndefined();
		expect(await cancelNtfy(live, "horus-abc", "seref-offline", { retryMs: 1 })).toBeUndefined();
		const deleteRequest = { method: "DELETE", url: "/horus-abc/seref-offline", body: undefined, auth: "Bearer secret" };
		const scheduleCheck = { method: "GET", url: "/horus-abc/json", body: undefined, auth: "Bearer secret" };
		expect(received).toEqual([
			{
				method: "POST",
				url: "/",
				body: { topic: "horus-abc", title: event.title, message: event.message, priority: 4, tags: ["white_check_mark"], sequence_id: "seref-offline", delay: "60m" },
				auth: "Bearer secret",
			},
			deleteRequest,
			scheduleCheck,
			deleteRequest,
			scheduleCheck,
		]);
	} finally {
		server.stop(true);
	}
});

test("the outbox keeps messages through an outage and delivers them, marked delayed, once a send works", async () => {
	let online = false;
	const delivered: { topic: string; message: string }[] = [];
	const outbox = new NtfyOutbox(
		async (_config, topic, sent) => {
			if (!online) return "network down";
			delivered.push({ topic, message: sent.message });
			return undefined;
		},
		() => new Date("2026-10-19T10:15:00").getTime(),
	);
	const cfg = config({ minPriority: 3 });
	expect(await outbox.send(cfg, "horus-abc", { ...event, message: "stuck" })).toBe("network down");
	expect(await outbox.send(cfg, "horus-abc", { ...event, message: "offline alert", sequenceId: "seref-offline" })).toBe("network down");
	expect(await outbox.send(cfg, "horus-abc", { ...event, priority: 2, message: "progress" })).toBeUndefined();
	expect(outbox.pending).toBe(1);
	online = true;
	await outbox.send(cfg, "general", { ...event, message: "new loop" });
	expect(delivered).toEqual([
		{ topic: "general", message: "new loop" },
		{ topic: "horus-abc", message: "(delayed, from 10:15) stuck" },
	]);
	expect(outbox.pending).toBe(0);
});
