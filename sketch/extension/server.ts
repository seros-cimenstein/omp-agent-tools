import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import type { Diagram } from "./diagrams";
import { qrSvg } from "./qr";

export interface Sketch {
	/** Base64 image bytes, no data: prefix. */
	data: string;
	mimeType: "image/png" | "image/jpeg";
	note: string;
}

/** What the canvas page shows about the agent. */
export interface SketchState {
	busy: boolean;
	/** Prompt of a pending `request_sketch` call, if any. */
	request: string | null;
}

export interface SketchHooks {
	/** Deliver a sketch; returns a short status for the page or throws with a user-facing message. */
	send(sketch: Sketch): string;
	/** Decline the pending `request_sketch`; false when nothing is pending. */
	decline(): boolean;
	state(): SketchState;
	/** SVG diagrams from the session, newest first. */
	diagrams(): Diagram[];
}

export interface SketchUrl {
	label: string;
	url: string;
}

export interface SketchServer {
	port: number;
	/** Local URL first, then LAN/tailnet URLs. */
	urls: SketchUrl[];
	/** Shell command to open the port in an active host firewall, if one is running. */
	firewallHint: string | null;
	clientCount(): number;
	broadcast(event: string, data: unknown): void;
	stop(): void;
}

export const PREFERRED_PORT = 7878;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_IMAGE_B64 = 24 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const VIRTUAL_IFACE = /^(lo|docker|br-|virbr|veth|vmnet|vboxnet|cloudflarewarp|warp|zt|podman|cni|flannel)/i;
const PHYSICAL_IFACE = /^(wl|en|eth)/i;
const PAGE_PATH = path.join(import.meta.dir, "canvas.html");

interface LanAddress {
	iface: string;
	address: string;
	cidr: string | null;
}

/** Interfaces carrying a main-table default route, best metric first (Linux `ip`; empty elsewhere). */
function defaultRouteIfaces(): string[] {
	try {
		const out = Bun.spawnSync(["ip", "-4", "route", "show", "default"]).stdout.toString();
		return [...out.matchAll(/\bdev (\S+)/g)].map(m => m[1]);
	} catch {
		return [];
	}
}

/** LAN-reachable IPv4 addresses: default-route interfaces, other physical NICs, others, tailnet last. */
function lanAddresses(): LanAddress[] {
	const found: LanAddress[] = [];
	for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL_IFACE.test(iface)) continue;
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal) found.push({ iface, address: info.address, cidr: info.cidr });
		}
	}
	const routed = defaultRouteIfaces();
	const rank = (a: LanAddress): number => {
		const r = routed.indexOf(a.iface);
		if (r >= 0) return r;
		return routed.length + (PHYSICAL_IFACE.test(a.iface) ? 0 : a.iface.startsWith("tailscale") ? 2 : 1);
	};
	return found.sort((a, b) => rank(a) - rank(b));
}

/** "192.168.1.23/24" → "192.168.1.0/24" */
function networkOf(cidr: string): string {
	const [ip, bitsText] = cidr.split("/");
	const bits = Number(bitsText);
	const octets = ip.split(".").map(Number);
	const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	const net = (addr & mask) >>> 0;
	return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${bits}`;
}

function firewallHint(port: number, lan: LanAddress[]): string | null {
	const active = (unit: string): boolean => {
		try {
			return Bun.spawnSync(["systemctl", "is-active", "--quiet", unit]).exitCode === 0;
		} catch {
			return false;
		}
	};
	if (active("ufw")) {
		const primary = lan.find(a => !a.iface.startsWith("tailscale") && a.cidr);
		const from = primary?.cidr ? `from ${networkOf(primary.cidr)} ` : "";
		return `sudo ufw allow ${from}to any port ${port} proto tcp`;
	}
	if (active("firewalld")) return `sudo firewall-cmd --add-port=${port}/tcp`;
	return null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function parseSketch(body: unknown): Sketch | string {
	if (!body || typeof body !== "object") return "Body must be a JSON object";
	const { data, mimeType, note } = body as Record<string, unknown>;
	if (typeof data !== "string" || data.length === 0) return "Missing image data";
	if (data.length > MAX_IMAGE_B64) return "Image too large";
	if (!/^[A-Za-z0-9+/]+=*$/.test(data)) return "Image data must be plain base64";
	if (mimeType !== "image/png" && mimeType !== "image/jpeg") return "mimeType must be image/png or image/jpeg";
	if (note !== undefined && typeof note !== "string") return "note must be a string";
	return { data, mimeType, note: (note ?? "").trim() };
}

export function startSketchServer(token: string, hooks: SketchHooks): SketchServer {
	const encoder = new TextEncoder();
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const write = (client: ReadableStreamDefaultController<Uint8Array>, chunk: string): void => {
		try {
			client.enqueue(encoder.encode(chunk));
		} catch {
			clients.delete(client);
		}
	};
	const broadcast = (event: string, data: unknown): void => {
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of clients) write(client, chunk);
	};

	const handler = async (req: Request, server: Server): Promise<Response> => {
		const url = new URL(req.url);
		if (url.searchParams.get("t") !== token) return new Response("Forbidden", { status: 403 });

		if (req.method === "GET" && url.pathname === "/") {
			return new Response(Bun.file(PAGE_PATH), {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"Content-Security-Policy":
						"default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
				},
			});
		}
		if (req.method === "GET" && url.pathname === "/info") {
			return json({ urls: handle.urls, firewallHint: handle.firewallHint, state: hooks.state() });
		}
		if (req.method === "GET" && url.pathname === "/diagrams") {
			return json(hooks.diagrams());
		}
		if (req.method === "GET" && url.pathname === "/qr.svg") {
			const target = handle.urls[Number(url.searchParams.get("i") ?? 0)];
			if (!target) return new Response("Unknown URL index", { status: 404 });
			return new Response(qrSvg(target.url), {
				headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
			});
		}
		if (req.method === "GET" && url.pathname === "/events") {
			server.timeout(req, 0);
			let self: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					self = controller;
					clients.add(controller);
					write(controller, `retry: 2000\nevent: state\ndata: ${JSON.stringify(hooks.state())}\n\n`);
				},
				cancel() {
					clients.delete(self);
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
			});
		}
		if (req.method === "POST" && url.pathname === "/send") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return json({ error: "Invalid JSON" }, 400);
			}
			const sketch = parseSketch(body);
			if (typeof sketch === "string") return json({ error: sketch }, 400);
			try {
				return json({ status: hooks.send(sketch) });
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : String(err) }, 409);
			}
		}
		if (req.method === "POST" && url.pathname === "/decline") {
			return hooks.decline() ? json({ status: "declined" }) : json({ error: "No pending request" }, 409);
		}
		return new Response("Not found", { status: 404 });
	};

	const serve = (port: number): Server =>
		Bun.serve({ hostname: "0.0.0.0", port, maxRequestBodySize: MAX_BODY, fetch: handler });
	let server: Server;
	try {
		server = serve(PREFERRED_PORT);
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "EADDRINUSE")) throw err;
		server = serve(0);
	}
	const port = server.port as number;

	const heartbeat = setInterval(() => {
		for (const client of clients) write(client, ": ping\n\n");
	}, HEARTBEAT_MS);
	heartbeat.unref();

	const lan = lanAddresses();
	const handle: SketchServer = {
		port,
		urls: [
			{ label: "this computer", url: `http://localhost:${port}/?t=${token}` },
			...lan.map(a => ({ label: `${a.iface} ${a.address}`, url: `http://${a.address}:${port}/?t=${token}` })),
		],
		firewallHint: lan.length > 0 ? firewallHint(port, lan) : null,
		clientCount: () => clients.size,
		broadcast,
		stop() {
			clearInterval(heartbeat);
			for (const client of clients) {
				try {
					client.close();
				} catch {}
			}
			clients.clear();
			server.stop(true);
		},
	};
	return handle;
}
