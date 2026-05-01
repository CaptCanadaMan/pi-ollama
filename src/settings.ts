// Extension settings resolved from environment variables.
//
// OLLAMA_HOST               — Ollama server host[:port]. Default: localhost:11434
// OLLAMA_NATIVE_GHOST_RETRIES — Max retries on ghost-token response. Default: 2

export interface OllamaExtensionSettings {
	/** Base URL of the Ollama server, e.g. http://localhost:11434 */
	baseUrl: string;
	/** keep_alive value sent on every request. Default: "5m" */
	keepAlive: string | number;
	/** Default num_ctx if model's contextWindow is unavailable. Default: 32768 */
	numCtx: number;
	/** Max ghost-token retries before surfacing an error. Default: 2 */
	ghostRetries: number;
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

	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		keepAlive: "5m",
		numCtx: 32768,
		ghostRetries,
	};
}
