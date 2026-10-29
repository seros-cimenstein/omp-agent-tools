/**
 * sketch — draw on a touchscreen/phone canvas and send it straight into the omp session.
 *
 * - `/sketch` starts a token-gated HTTP server (port 7878, LAN-reachable) and opens the canvas.
 * - Send from the canvas → `pi.sendUserMessage` with the PNG; starts a turn when idle, otherwise
 *   follows up or steers per the page's toggle.
 * - `request_sketch` tool lets the agent ask for a drawing and wait for it.
 * - `/sketch diagram` (or the canvas's 📊 button) puts the latest ```svg diagram from the chat
 *   (e.g. /diagramify) on the canvas to mark up.
 */
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Diagram, findDiagrams } from "./diagrams";
import { type Sketch, type SketchServer, type SketchState, startSketchServer } from "./server";

type RequestOutcome = Sketch | "declined" | "cancelled";

interface PendingRequest {
	prompt: string;
	settle(outcome: RequestOutcome): void;
}

// Module state is shared by every session in this process (main, subagents, switched sessions);
// the server and delivery always target the current main session.
const token = randomBytes(16).toString("base64url");
let server: SketchServer | undefined;
let owner: { pi: ExtensionAPI; ctx: ExtensionContext } | undefined;
let busy = false;
let pending: PendingRequest | undefined;
/** Server was running when the owning session shut down; restart it for the next main session. */
let resumeOnStart = false;

const state = (): SketchState => ({ busy, request: pending?.prompt ?? null });
const pushState = (): void => server?.broadcast("state", state());

function deliver(sketch: Sketch): string {
	if (pending) {
		const request = pending;
		pending = undefined;
		request.settle(sketch);
		pushState();
		return "answered";
	}
	if (!owner) throw new Error("No active omp session");
	const { pi, ctx } = owner;
	let idle: boolean;
	try {
		idle = ctx.isIdle();
	} catch {
		idle = !busy;
	}
	const content = [
		{ type: "text" as const, text: sketch.note || "Here's a sketch." },
		{ type: "image" as const, data: sketch.data, mimeType: sketch.mimeType },
	];
	Promise.resolve()
		.then(() => pi.sendUserMessage(content, idle ? undefined : { deliverAs: sketch.mode }))
		.catch(err => ctx.ui.notify(`Sketch delivery failed: ${err instanceof Error ? err.message : err}`, "error"));
	if (idle) return "started";
	return sketch.mode === "steer" ? "steered" : "queued";
}

function decline(): boolean {
	if (!pending) return false;
	const request = pending;
	pending = undefined;
	request.settle("declined");
	pushState();
	return true;
}

function diagrams(): Diagram[] {
	return owner ? findDiagrams(owner.ctx.sessionManager.getBranch()) : [];
}

function ensureServer(): SketchServer {
	server ??= startSketchServer(token, { send: deliver, decline, state, diagrams });
	return server;
}

const CHROMIUM_BINARIES = ["chromium", "google-chrome-stable", "google-chrome", "brave"];

/**
 * Opens the canvas in a new Chromium window, so the window manager puts it on the current
 * workspace; xdg-open would add a tab to whichever Chromium window already exists.
 */
function openBrowser(url: string): void {
	const chromium = process.platform === "darwin" ? undefined : CHROMIUM_BINARIES.find(bin => Bun.which(bin));
	const cmd = chromium ? [chromium, "--new-window", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {}
}

function describeServer(srv: SketchServer): string {
	const [local, ...lan] = srv.urls;
	const lines = [`Sketch canvas: ${local.url}`];
	if (lan.length > 0) lines.push(`Phone/tablet: ${lan[0].url}  (📱 button on the canvas shows a QR code)`);
	if (srv.firewallHint) lines.push(`Firewall active; to allow phones run: ${srv.firewallHint}`);
	return lines.join("\n");
}

export default function sketchExtension(pi: ExtensionAPI): void {
	const z = pi.zod;

	const bind = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		owner = { pi, ctx };
		if (resumeOnStart) {
			resumeOnStart = false;
			ensureServer();
		}
	};

	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_switch", (_event, ctx) => bind(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		busy = true;
		pushState();
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		busy = false;
		pushState();
	});

	pi.on("session_shutdown", () => {
		if (owner?.pi !== pi) return;
		owner = undefined;
		busy = false;
		pending?.settle("cancelled");
		pending = undefined;
		if (server) {
			server.stop();
			server = undefined;
			resumeOnStart = true;
		}
	});

	pi.registerCommand("sketch", {
		description:
			"Open the drawing canvas (this screen or a phone on the LAN); `/sketch diagram` loads the latest chat SVG diagram; `/sketch url` only prints links",
		getArgumentCompletions: prefix =>
			["diagram", "url"].filter(sub => sub.startsWith(prefix.trim())).map(sub => ({ value: sub, label: sub })),
		handler: async (args, ctx) => {
			bind(ctx);
			const sub = args.trim();
			if (sub === "diagram") {
				const [latest] = diagrams();
				if (!latest) {
					ctx.ui.notify("No SVG diagram in this session yet. Run /diagramify first.", "warning");
					return;
				}
				const srv = ensureServer();
				if (srv.clientCount() > 0) {
					srv.broadcast("diagram", latest);
					ctx.ui.notify(`Diagram "${latest.title}" sent to the open canvas.\n${describeServer(srv)}`, "info");
				} else {
					openBrowser(`${srv.urls[0].url}&diagram=${latest.id}`);
					ctx.ui.notify(`Opening canvas with diagram "${latest.title}".\n${describeServer(srv)}`, "info");
				}
				return;
			}
			const srv = ensureServer();
			if (sub !== "url") openBrowser(srv.urls[0].url);
			ctx.ui.notify(describeServer(srv), "info");
		},
	});

	pi.registerTool({
		name: "request_sketch",
		label: "Request Sketch",
		description:
			"Ask the user to draw something on their touchscreen or phone canvas and wait for the drawing. " +
			"Use when a picture communicates faster than words: UI layouts, diagrams, shapes, or marking up a screenshot. " +
			"Returns the drawing as an image plus the user's optional note.",
		parameters: z.object({
			prompt: z.string().describe("What you want the user to draw; shown on the canvas as a banner"),
		}),
		approval: "read",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (pending) {
				return { content: [{ type: "text", text: "Another sketch request is already waiting for the user." }] };
			}
			bind(ctx);
			const srv = ensureServer();
			const { promise, resolve } = Promise.withResolvers<RequestOutcome>();
			const onAbort = (): void => {
				if (pending !== request) return;
				pending = undefined;
				pushState();
				resolve("cancelled");
			};
			const request: PendingRequest = {
				prompt: params.prompt,
				settle(result) {
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
			};
			pending = request;
			pushState();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();

			if (srv.clientCount() === 0) openBrowser(srv.urls[0].url);
			ctx.ui.notify(`Agent asks for a sketch: ${params.prompt}\n${describeServer(srv)}`, "info");
			onUpdate?.({ content: [{ type: "text", text: `Waiting for your sketch at ${srv.urls[0].url}` }] });
			return toolResult(await promise);
		},
	});

	function toolResult(outcome: RequestOutcome) {
		if (outcome === "declined") return { content: [{ type: "text" as const, text: "The user declined to draw." }] };
		if (outcome === "cancelled") return { content: [{ type: "text" as const, text: "Sketch request cancelled." }] };
		return {
			content: [
				{
					type: "text" as const,
					text: outcome.note ? `The user drew this sketch. Their note: ${outcome.note}` : "The user drew this sketch.",
				},
				{ type: "image" as const, data: outcome.data, mimeType: outcome.mimeType },
			],
			details: { note: outcome.note },
		};
	}
}
