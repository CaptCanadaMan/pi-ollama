// Extension settings resolved from environment variables and persisted config.
//
// OLLAMA_HOST                 — Ollama server host[:port]. Default: localhost:11434
// OLLAMA_NATIVE_GHOST_RETRIES — Max retries on ghost-token response. Default: 2
// OLLAMA_CONTEXT_LENGTH       — User-set context length override (also Ollama's own
//                                env var, honored for cross-tool consistency).
//                                Superseded by any slash-command-set persisted value.
// OLLAMA_KEEP_ALIVE           — keep_alive for /api/chat requests (also Ollama's own
//                                env var, honored for cross-tool consistency).
//                                Superseded by any slash-command-set persisted value.
//                                Unset (default): the field is OMITTED from requests
//                                and the server's own setting decides (gh#5 — a
//                                per-request keep_alive overrides the server, so the
//                                old hardcoded "5m" defeated server-side keep-warm).

import { loadPersistedConfig } from "./config.js";

export interface OllamaExtensionSettings {
	/** Base URL of the Ollama server, e.g. http://localhost:11434 */
	baseUrl: string;
	/**
	 * keep_alive for /api/chat requests. Resolution order:
	 *   1. Persisted config from `/ollama-keep-alive` slash command
	 *   2. `OLLAMA_KEEP_ALIVE` env var
	 *   3. undefined — the field is omitted; the Ollama server's own setting
	 *      decides (the default, since a per-request value overrides the server).
	 *
	 * Mutable at runtime — the slash command writes here AND to the persisted
	 * config file so changes survive restart.
	 */
	keepAlive?: string | number;
	/** Default num_ctx if model's contextWindow is unavailable. Default: 32768 */
	numCtx: number;
	/** Max ghost-token retries before surfacing an error. Default: 2 */
	ghostRetries: number;
	/**
	 * User-set context length override. Resolution order:
	 *   1. Persisted config from `/ollama-context` slash command
	 *   2. `OLLAMA_CONTEXT_LENGTH` env var
	 *   3. undefined (fall through to min(model.contextWindow, numCtx) in provider)
	 *
	 * Mutable at runtime — the slash command writes here AND to the persisted
	 * config file so changes survive restart.
	 */
	contextLength?: number;
}

// Go-style duration: one or more number+unit groups ("5m", "1h30m", "500ms").
const GO_DURATION_RE = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

/**
 * Validate/normalize a keep_alive value from user or env input.
 * Bare integers become numbers (Ollama reads them as seconds; -1 = keep
 * forever, 0 = unload immediately); Go-style duration strings pass verbatim;
 * anything else is undefined (invalid — callers decide how to surface it).
 */
export function parseKeepAlive(raw: string): string | number | undefined {
	const s = raw.trim();
	if (s === "") return undefined;
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (GO_DURATION_RE.test(s)) return s;
	return undefined;
}

/**
 * Resolve the effective keep_alive: persisted (slash command) wins over the
 * env var; neither → undefined, meaning "omit the field, the server decides".
 * An INVALID env value also resolves to undefined — deferring to the server,
 * never a silent fallback constant (a warning is written to stderr).
 */
export function resolveKeepAlive(
	persisted: string | number | undefined,
	envRaw: string | undefined,
): string | number | undefined {
	if (persisted !== undefined) return persisted;
	if (envRaw === undefined) return undefined;
	const parsed = parseKeepAlive(envRaw);
	if (parsed === undefined) {
		process.stderr.write(
			`[pi-ollama] Ignoring invalid OLLAMA_KEEP_ALIVE=${JSON.stringify(envRaw)} ` +
				`(expected a duration like "5m"/"1h30m" or an integer; -1 = keep forever). ` +
				`Deferring to the server's setting.\n`,
		);
	}
	return parsed;
}

export function loadSettings(): OllamaExtensionSettings {
	// OLLAMA_HOST may be bare "host:port" or already include a protocol.
	const rawHost = process.env.OLLAMA_HOST ?? "localhost:11434";
	const baseUrl = rawHost.startsWith("http")
		? rawHost
		: `http://${rawHost}`;

	const rawRetries = process.env.OLLAMA_NATIVE_GHOST_RETRIES;
	const ghostRetries = (() => {
		if (!rawRetries) return 2;
		const n = parseInt(rawRetries, 10);
		return Number.isFinite(n) && n >= 0 ? n : 2;
	})();

	// contextLength + keepAlive resolution: persisted (slash-command set) wins
	// over env var.
	const persisted = loadPersistedConfig();
	const persistedContextLength = persisted.contextLength;
	const envContextLength = (() => {
		const raw = process.env.OLLAMA_CONTEXT_LENGTH;
		if (!raw) return undefined;
		const n = parseInt(raw, 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	})();
	const contextLength = persistedContextLength ?? envContextLength;

	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		keepAlive: resolveKeepAlive(persisted.keepAlive, process.env.OLLAMA_KEEP_ALIVE),
		numCtx: 32768,
		ghostRetries,
		contextLength,
	};
}
