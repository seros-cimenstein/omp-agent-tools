/**
 * Discovery file for local tools (DevDeck+ drives the canvas from a phone app through it):
 * `<agent dir>/sketch/<pid>.json`, mode 600, holding this omp process's sketch server and the
 * pending `request_sketch`. Written while the extension is loaded, removed when omp exits.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Registration {
	pid: number;
	/** Port of the running server on 0.0.0.0 (loopback works), null until `/sketch` starts it. */
	port: number | null;
	/** Token every request needs as `?t=`. */
	token: string;
	/** The pending `request_sketch` call, if any. */
	request: { id: string; prompt: string } | null;
}

const DIR = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "sketch");
const FILE = path.join(DIR, `${process.pid}.json`);
let written: string | null = null;
let hooked = false;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Drops files of omp processes that died without cleaning up (killed, crashed). */
function pruneDead(): void {
	let names: string[];
	try {
		names = fs.readdirSync(DIR);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number(name.match(/^(\d+)\.json$/)?.[1]);
		if (!pid || pid === process.pid || alive(pid)) continue;
		try {
			fs.unlinkSync(path.join(DIR, name));
		} catch {}
	}
}

/** Writes the registration when it changed; never throws (the canvas works without it). */
export function publish(reg: Registration): void {
	const text = JSON.stringify(reg);
	if (text === written) return;
	try {
		if (!hooked) {
			hooked = true;
			fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
			pruneDead();
			process.on("exit", unpublish);
		}
		const tmp = `${FILE}.tmp`;
		fs.writeFileSync(tmp, text, { mode: 0o600 });
		fs.renameSync(tmp, FILE);
		written = text;
	} catch {}
}

export function unpublish(): void {
	if (written === null) return;
	written = null;
	try {
		fs.unlinkSync(FILE);
	} catch {}
}
