// Debug logging and request/response dump infrastructure.
//
// OLLAMA_NATIVE_DEBUG=1       — enable per-chunk debug logging
// OLLAMA_NATIVE_DEBUG_LOG=... — override default log path
//                                (default: ~/.pi/agent/cache/pi-ollama-debug.log)
// OLLAMA_NATIVE_DUMP_DIR=...  — write paired req-*.json / res-*.ndjson files
//                                per request for replay diagnostics
//
// Why a file by default: pi's TUI uses carriage-return redraws to update
// streaming output in place. Writing debug output to stderr in the same
// terminal breaks the cursor positioning and produces a "ladder" of
// fragmentary text. Routing to a file keeps the TUI clean while still
// giving full diagnostics — `tail -f $OLLAMA_NATIVE_DEBUG_LOG` for live view.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OLLAMA_DEBUG = process.env.OLLAMA_NATIVE_DEBUG === "1";
export const OLLAMA_DUMP_DIR = process.env.OLLAMA_NATIVE_DUMP_DIR;

const DEFAULT_LOG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"cache",
	"pi-ollama-debug.log",
);
export const OLLAMA_DEBUG_LOG =
	process.env.OLLAMA_NATIVE_DEBUG_LOG ?? DEFAULT_LOG_PATH;

let dumpCounter = 0;
let logDirReady = false;

function ensureLogDir(): void {
	if (logDirReady) return;
	logDirReady = true; // try once; if mkdir fails, file write will fall back to stderr
	try {
		mkdirSync(dirname(OLLAMA_DEBUG_LOG), { recursive: true });
	} catch {
		// Fall through — file write may still succeed if dir already exists.
	}
}

export function dbg(label: string, data: unknown): void {
	if (!OLLAMA_DEBUG) return;
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	const line = `[${new Date().toISOString()}] [pi-ollama:${label}] ${payload}\n`;
	ensureLogDir();
	try {
		appendFileSync(OLLAMA_DEBUG_LOG, line);
	} catch {
		// File write failed (permissions, full disk, etc.) — fall back to stderr.
		// Will fragment the TUI but keeps the diagnostic message visible.
		process.stderr.write(line);
	}
}

// Returns a unique prefix (timestamp + counter) to pair req/res dump files.
export function dumpRequest(body: object): string | null {
	if (!OLLAMA_DUMP_DIR) return null;
	try {
		const n = ++dumpCounter;
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const prefix = `${ts}-${n}`;
		mkdirSync(OLLAMA_DUMP_DIR, { recursive: true });
		writeFileSync(
			`${OLLAMA_DUMP_DIR}/req-${prefix}.json`,
			JSON.stringify(body, null, 2),
		);
		return prefix;
	} catch (e) {
		// Dump errors go to stderr at extension init / first-request time, before
		// the TUI is heavily streaming. Acceptable trade-off vs. silent loss.
		process.stderr.write(`[pi-ollama:dump-error] ${String(e)}\n`);
		return null;
	}
}

export function dumpResponseLine(prefix: string | null, line: string): void {
	if (!OLLAMA_DUMP_DIR || prefix === null) return;
	try {
		appendFileSync(`${OLLAMA_DUMP_DIR}/res-${prefix}.ndjson`, line + "\n");
	} catch {
		// Swallow — dump failures must not kill the stream.
	}
}
