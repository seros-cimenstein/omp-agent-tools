/**
 * Finds ```svg diagrams (e.g. from /diagramify) in the session's assistant messages and
 * themes them dark: the chat SVGs colour themselves with the reader's theme variables
 * (`var(--fg)`, `currentColor`), which mean nothing outside omp's renderer, so they are
 * resolved to the titanium palette /diagramify checks its renders against.
 */

export interface Diagram {
	id: string;
	title: string;
	/** Standalone, dark-themed SVG ready to load as an image (transparent; paint `background` under it). */
	svg: string;
	background: string;
}

const MAX_DIAGRAMS = 12;
const SVG_BLOCK = /```svg[^\n]*\n([\s\S]*?)```/g;
const BACKGROUND = "#242424";

/** Titanium theme values for omp's theme variables. */
const DARK: Record<string, string> = {
	fg: "#e8ecf4",
	muted: "#9aa3b2",
	border: "#4a4f59",
	surface: "#2e3138",
	accent: "#00b4ff",
	success: "#00ff88",
	warning: "#ffb347",
	error: "#ff4757",
	c1: "#00b4ff",
	c2: "#ff6fb0",
	c3: "#7ddc6a",
	c4: "#c39bff",
	c5: "#ffb347",
	c6: "#5ce0d0",
};

function themeDark(svg: string): string {
	let out = svg.replace(/var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)/g, (_, name: string) => DARK[name] ?? DARK.fg);
	const open = out.match(/<svg\b[^>]*>/);
	if (!open) return out;
	let tag = open[0];
	// `<img>`-loaded SVG needs the namespace; `currentColor` resolves against `color`.
	if (!/\sxmlns=/.test(tag)) tag = tag.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
	if (!/\scolor=/.test(tag)) tag = tag.replace("<svg", `<svg color="${DARK.fg}"`);
	out = out.replace(open[0], tag);
	return out;
}

function titleOf(svg: string): string {
	const raw = svg.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? svg.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
	const text = raw
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();
	return text || "Diagram";
}

function assistantText(entry: unknown): string {
	if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message") return "";
	if (!("message" in entry) || !entry.message || typeof entry.message !== "object") return "";
	const message = entry.message;
	if (!("role" in message) || message.role !== "assistant" || !("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") text += `${block.text}\n`;
	}
	return text;
}

/** Newest first, deduplicated, at most 12. `entries` is `ctx.sessionManager.getBranch()`. */
export function findDiagrams(entries: readonly unknown[]): Diagram[] {
	const found: Diagram[] = [];
	const seen = new Set<string>();
	for (let i = entries.length - 1; i >= 0 && found.length < MAX_DIAGRAMS; i--) {
		const blocks = [...assistantText(entries[i]).matchAll(SVG_BLOCK)].map(m => m[1].trim()).reverse();
		for (const source of blocks) {
			if (!source.includes("<svg") || found.length >= MAX_DIAGRAMS) continue;
			const id = Bun.hash(source).toString(36);
			if (seen.has(id)) continue;
			seen.add(id);
			found.push({ id, title: titleOf(source), svg: themeDark(source), background: BACKGROUND });
		}
	}
	return found;
}
