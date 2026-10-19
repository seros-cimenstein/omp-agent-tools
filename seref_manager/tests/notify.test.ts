import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadNtfyConfig, sendNtfy } from "../extension/notify";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seref-ntfy-"));
const file = path.join(dir, "ntfy.json");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("config comes from the file, the environment wins, and no topic means no notifications", () => {
	expect(loadNtfyConfig({}, file)).toBeUndefined();
	fs.writeFileSync(file, JSON.stringify({ topic: "file-topic", server: "https://ntfy.example/", minPriority: 3 }));
	expect(loadNtfyConfig({}, file)).toMatchObject({ topic: "file-topic", server: "https://ntfy.example", minPriority: 3, origin: file });
	expect(loadNtfyConfig({ SEREF_NTFY_TOPIC: "env-topic" }, file)).toMatchObject({ topic: "env-topic", server: "https://ntfy.example", origin: "environment" });
	fs.writeFileSync(file, "{ not json");
	expect(loadNtfyConfig({}, file)).toBeUndefined();
});

test("events are published as ntfy JSON with the token, and filtered below minPriority", async () => {
	const received: { body: unknown; auth: string | null }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			received.push({ body: await request.json(), auth: request.headers.get("authorization") });
			return new Response("{}");
		},
	});
	try {
		const config = { server: `http://127.0.0.1:${server.port}`, topic: "t", token: "secret", minPriority: 3, origin: "test" };
		const event = { title: "proj · LOOP_X.md · it 2/10", message: "Loop ended: gate passed ✅", priority: 4 as const, tags: ["white_check_mark"] };
		expect(await sendNtfy(config, event)).toBeUndefined();
		expect(await sendNtfy(config, { ...event, priority: 2 })).toBeUndefined();
		expect(received).toEqual([
			{ body: { topic: "t", title: event.title, message: event.message, priority: 4, tags: ["white_check_mark"] }, auth: "Bearer secret" },
		]);
	} finally {
		server.stop(true);
	}
});

test("a failing server is reported, not thrown", async () => {
	const failure = await sendNtfy(
		{ server: "http://127.0.0.1:1", topic: "t", minPriority: 1, origin: "test" },
		{ title: "x", message: "y", priority: 3, tags: [] },
	);
	expect(failure).toBeDefined();
});
