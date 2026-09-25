// One place that turns an Ollama failure into the message the user sees.
//
// The overflow case matters most. Requests go out with truncate:false, so
// when a chat no longer fits num_ctx Ollama refuses it instead of silently
// dropping the oldest messages. pi compacts and retries a turn only when the
// error text matches its overflow patterns, so an overflow is rewritten into
// "prompt too long; exceeded max context length" - the Ollama pattern pi-ai
// has recognized since at least 0.70. test/errors.test.ts checks this against
// pi-ai's real isContextOverflow.

// Phrasings Ollama and its llama-server runner use for "the prompt doesn't
// fit". Deliberately narrow: "requested context size too large for model" is
// a load-time failure that compacting can't fix, and must not match.
const OVERFLOW_PATTERNS = [
	/exceeds the available context size/i, // llama-server (observed on 0.34.4)
	/exceeds the (?:model's maximum )?context length/i,
	/exceeds maximum context length/i,
	/prompt is longer than the context length/i,
	/prompt too long/i,
];

const MAX_DETAIL_CHARS = 500;

export function isContextOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some((p) => p.test(text));
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** The message in a JSON `{error: string | {message}}` body, if it has one. */
function errorField(text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const { error } = parsed;
	if (typeof error === "string") return error;
	if (isRecord(error) && typeof error.message === "string") return error.message;
	return undefined;
}

/**
 * The readable message inside an Ollama error body. Ollama wraps
 * llama-server's own JSON error in a string inside its `error` field, so this
 * unwraps as many layers as it finds (bounded). Non-JSON passes through.
 */
export function extractErrorText(raw: string): string {
	let text = raw.trim();
	for (let depth = 0; depth < 3; depth++) {
		const inner = errorField(text);
		if (inner === undefined) break;
		text = inner.trim();
	}
	return text;
}

export interface OllamaErrorContext {
	/** The API path that failed, e.g. "/api/chat". */
	endpoint: string;
	/** HTTP status for a refused request; absent for an error inside the stream. */
	status?: number;
	/** The num_ctx the request carried, for the overflow hint. */
	numCtx?: number;
}

export function describeOllamaError(raw: string, ctx: OllamaErrorContext): string {
	const text = extractErrorText(raw);
	if (isContextOverflowText(text)) {
		const window = ctx.numCtx !== undefined ? ` (num_ctx=${ctx.numCtx})` : "";
		return (
			`Ollama: prompt too long; exceeded max context length${window}. ` +
			`Compact the session or raise the context length with /ollama-context. ` +
			`Ollama said: ${text}`
		);
	}
	const detail = text.slice(0, MAX_DETAIL_CHARS);
	return ctx.status !== undefined
		? `Ollama ${ctx.endpoint} returned HTTP ${ctx.status}: ${detail}`
		: `Ollama returned error: ${detail}`;
}
