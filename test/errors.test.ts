import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { describeOllamaError } from "../src/errors.js";

// Captured live from Ollama 0.34.4 (gemma4:e4b): a 9,533-token chat sent with
// num_ctx 2048 and truncate:false. The error field holds a JSON string that
// itself wraps llama-server's error object.
const OBSERVED_OVERFLOW_BODY = JSON.stringify({
	error: JSON.stringify({
		error: {
			code: 400,
			message:
				"request (9533 tokens) exceeds the available context size (2048 tokens), try increasing it",
			type: "exceed_context_size_error",
			n_prompt_tokens: 9533,
			n_ctx: 2048,
		},
	}),
});
const OBSERVED_OVERFLOW_TEXT =
	"request (9533 tokens) exceeds the available context size (2048 tokens), try increasing it";

const chat = { endpoint: "/api/chat", status: 400, numCtx: 2048 };

/** pi's own verdict: would pi compact and retry on this error message? */
function piSeesOverflow(errorMessage: string): boolean {
	return isContextOverflow(erroredMessage(errorMessage));
}

/** pi's own verdict: would pi retry the turn on this error message? */
function piWouldRetry(errorMessage: string): boolean {
	return isRetryableAssistantError(erroredMessage(errorMessage));
}

function erroredMessage(errorMessage: string) {
	return {
		role: "assistant",
		content: [],
		api: "ollama-native",
		provider: "ollama",
		model: "gemma4:e4b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	} as Parameters<typeof isContextOverflow>[0];
}

// pi compacts and retries a turn only when isContextOverflow matches the
// errorMessage, so these check our messages against the real pi-ai check from
// the devDependency. A pi-ai bump that changes its patterns fails here.

describe("describeOllamaError - an overflow reaches pi as an overflow", () => {
	it("the observed Ollama refusal becomes an overflow pi will compact", () => {
		const msg = describeOllamaError(OBSERVED_OVERFLOW_BODY, chat);
		expect(piSeesOverflow(msg)).toBe(true);
	});

	it("tells the user the window and the fix, and keeps what Ollama said", () => {
		const msg = describeOllamaError(OBSERVED_OVERFLOW_BODY, chat);
		expect(msg).toContain("num_ctx=2048");
		expect(msg).toContain("/ollama-context");
		expect(msg).toContain(OBSERVED_OVERFLOW_TEXT);
	});

	it.each([
		"the input length exceeds the context length",
		"input length (9533 tokens) exceeds the model's maximum context length (2048 tokens)",
		"input exceeds maximum context length and cannot be truncated further",
		"the prompt is longer than the context length currently available to the model",
		"prompt too long; exceeded max context length by 12 tokens",
	])("other overflow phrasings Ollama uses are recognized too: %s", (text) => {
		const msg = describeOllamaError(JSON.stringify({ error: text }), chat);
		expect(piSeesOverflow(msg)).toBe(true);
	});

	it("an overflow reported inside the stream (no HTTP status) is recognized", () => {
		const msg = describeOllamaError(OBSERVED_OVERFLOW_TEXT, { endpoint: "/api/chat" });
		expect(piSeesOverflow(msg)).toBe(true);
	});
});

describe("describeOllamaError - other failures stay what they are", () => {
	it.each([
		// A load-time failure (num_ctx above what the model or memory allows):
		// compacting the chat can't fix it, so pi must not try.
		"requested context size too large for model",
		'model "gemma4:e4b" not found, try pulling it first',
	])("%s is not treated as an overflow", (text) => {
		const msg = describeOllamaError(JSON.stringify({ error: text }), {
			endpoint: "/api/chat",
			status: 500,
		});
		expect(piSeesOverflow(msg)).toBe(false);
		expect(msg).toBe(`Ollama /api/chat returned HTTP 500: ${text}`);
	});

	it("reads an {error: {message}} body", () => {
		expect(
			describeOllamaError('{"error":{"message":"boom"}}', { endpoint: "/api/show", status: 500 }),
		).toBe("Ollama /api/show returned HTTP 500: boom");
	});

	it("passes a non-JSON body through, trimmed", () => {
		expect(
			describeOllamaError("  502 Bad Gateway \n", { endpoint: "/api/tags", status: 502 }),
		).toBe("Ollama /api/tags returned HTTP 502: 502 Bad Gateway");
	});

	it("uses the stream-error shape when there's no status", () => {
		expect(describeOllamaError("boom", { endpoint: "/api/chat" })).toBe(
			"Ollama returned error: boom",
		);
	});

	it("keeps a huge error body (e.g. an HTML error page) from flooding the message", () => {
		const msg = describeOllamaError("x".repeat(20_000), { endpoint: "/api/chat", status: 500 });
		expect(msg.length).toBeLessThan(600);
	});
});

describe("describeOllamaError - a server that wants a key", () => {
	it("tells the user to set OLLAMA_API_KEY when none was sent, and pi doesn't retry", () => {
		const msg = describeOllamaError('{"error":"unauthorized"}', {
			endpoint: "/api/chat",
			status: 401,
			apiKeySent: false,
		});
		expect(msg).toContain("OLLAMA_API_KEY");
		expect(msg).toContain("unauthorized");
		expect(piWouldRetry(msg)).toBe(false);
	});

	it("says the key was rejected when one was sent, and pi doesn't retry", () => {
		const msg = describeOllamaError('{"error":"invalid token"}', {
			endpoint: "/api/tags",
			status: 403,
			apiKeySent: true,
		});
		expect(msg).toContain("The key in OLLAMA_API_KEY was rejected");
		expect(piWouldRetry(msg)).toBe(false);
	});
});
