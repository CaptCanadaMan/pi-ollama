// Extension settings resolved from environment variables and persisted config.
//
// OLLAMA_HOST                 — Ollama server host[:port]. Default: localhost:11434
// OLLAMA_NATIVE_GHOST_RETRIES — Max retries on ghost-token response. Default: 2
// OLLAMA_CONTEXT_LENGTH       — User-set context length override (also Ollama's own
//                                env var, honored for cross-tool consistency).
//                                Superseded by any slash-command-set persisted value.
// OLLAMA_KEEP_ALIVE           — keep_alive value sent on /api/chat requests (also
//                                Ollama's own env var, honored for cross-tool
//                                consistency). Superseded by any slash-command-set
//                                persisted value. When unset, the field is omitted
//                                from the request so the Ollama server default
//                                applies. Supports the same values as Ollama:
//                                duration strings ("5m", "24h"), seconds, negative
//                                for keep-forever, 0 to unload immediately.

import { loadPersistedConfig } from "./config.js";

export interface OllamaExtensionSettings {
	/** Base URL of the Ollama server, e.g. http://localhost:11434 */
	baseUrl: string;
	/**
	 * keep_alive value sent on /api/chat requests. Omitted when undefined so
	 * the Ollama server default (OLLAMA_KEEP_ALIVE) applies. Resolution order:
	 *   1. Persisted config from `/ollama-keep-alive` slash command
	 *   2. `OLLAMA_KEEP_ALIVE` env var
	 *   3. undefined (omit the field — server default applies)
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

	// persisted (slash-command-set) values take precedence over env vars for
	// both contextLength and keepAlive.
	const persisted = loadPersistedConfig();

	// contextLength resolution: persisted (slash-command set) wins over env var.
	const persistedContextLength = persisted.contextLength;
	const envContextLength = (() => {
		const raw = process.env.OLLAMA_CONTEXT_LENGTH;
		if (!raw) return undefined;
		const n = parseInt(raw, 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	})();
	const contextLength = persistedContextLength ?? envContextLength;

	// keepAlive resolution: persisted (slash-command set) wins over env var.
	// Both are validated; invalid values fall through to the next source and
	// ultimately to undefined (server default).
	const persistedKeepAlive = isValidKeepAlive(persisted.keepAlive)
		? persisted.keepAlive
		: undefined;
	const envKeepAlive = isValidKeepAlive(process.env.OLLAMA_KEEP_ALIVE)
		? process.env.OLLAMA_KEEP_ALIVE
		: undefined;
	const keepAlive = persistedKeepAlive ?? envKeepAlive;

	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		keepAlive,
		numCtx: 32768,
		ghostRetries,
		contextLength,
	};
}

/**
 * Accepts what Ollama accepts for keep_alive (Go's time.ParseDuration:
 * s/m/h units, fractional and compound values allowed, no day unit):
 *   - a duration string such as "5m", "1h", "1h30m", "30s"
 *   - a number of seconds; negative keeps the model loaded forever, 0 unloads
 *     immediately
 * Rejects arbitrary strings that would otherwise be forwarded to Ollama as-is.
 */
export function isValidKeepAlive(value: unknown): value is string | number {
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") {
		const v = value.trim();
		if (v.length === 0) return false;
		// duration (one or more value+unit segments) or bare seconds
		return /^[+-]?(?:(?:\d+(?:\.\d+)?[smh])+|\d+(?:\.\d+)?)$/.test(v);
	}
	return false;
}
