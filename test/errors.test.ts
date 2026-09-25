import { isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	describeOllamaError,
	extractErrorText,
	isContextOverflowText,
} from "../src/errors.js";

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

/** An errored assistant message, the shape pi's overflow check reads. */
const erroredMessage = (errorMessage: string) =>
	({
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
	}) as Parameters<typeof isContextOverflow>[0];

describe("extractErrorText - the readable message inside an Ollama error body", () => {
	it("unwraps the nested llama-server error Ollama returns on overflow", () => {
		expect(extractErrorText(OBSERVED_OVERFLOW_BODY)).toBe(OBSERVED_OVERFLOW_TEXT);
	});

	it("reads a plain {error: string} body", () => {
		expect(extractErrorText('{"error":"model \\"x\\" not found"}')).toBe('model "x" not found');
	});

	it("reads an {error: {message}} body", () => {
		expect(extractErrorText('{"error":{"message":"boom"}}')).toBe("boom");
	});

	it("passes non-JSON text through, trimmed", () => {
		expect(extractErrorText("  502 Bad Gateway \n")).toBe("502 Bad Gateway");
		expect(extractErrorText("")).toBe("");
	});

	it("leaves JSON without an error field as-is", () => {
		expect(extractErrorText('{"status":"ok"}')).toBe('{"status":"ok"}');
	});
});

describe("isContextOverflowText - overflow phrasings only", () => {
	it.each([
		OBSERVED_OVERFLOW_TEXT,
		"the input length exceeds the context length",
		"input length (9533 tokens) exceeds the model's maximum context length (2048 tokens)",
		"input exceeds maximum context length and cannot be truncated further",
		"the prompt is longer than the context length currently available to the model",
		"prompt too long; exceeded max context length by 12 tokens",
	])("recognizes %s", (text) => {
		expect(isContextOverflowText(text)).toBe(true);
	});

	it.each([
		// A load-time failure (num_ctx above what the model or memory allows):
		// compacting the chat can't fix it, so it must not read as an overflow.
		"requested context size too large for model",
		'model "gemma4:e4b" not found, try pulling it first',
		"",
	])("does not treat %s as an overflow", (text) => {
		expect(isContextOverflowText(text)).toBe(false);
	});
});

describe("describeOllamaError - one message shape for every Ollama failure", () => {
	it("turns an overflow into text pi recognizes, with the fix and the original", () => {
		const msg = describeOllamaError(OBSERVED_OVERFLOW_BODY, {
			endpoint: "/api/chat",
			status: 400,
			numCtx: 2048,
		});
		expect(msg).toMatch(/prompt too long; exceeded max context length/);
		expect(msg).toContain("num_ctx=2048");
		expect(msg).toContain("/ollama-context");
		expect(msg).toContain(OBSERVED_OVERFLOW_TEXT);
	});

	it("keeps the HTTP shape for other failures", () => {
		expect(
			describeOllamaError('{"error":"model \\"x\\" not found"}', {
				endpoint: "/api/chat",
				status: 404,
			}),
		).toBe('Ollama /api/chat returned HTTP 404: model "x" not found');
	});

	it("keeps the stream-error shape when there's no status", () => {
		expect(describeOllamaError("boom", { endpoint: "/api/chat" })).toBe(
			"Ollama returned error: boom",
		);
	});

	it("caps a long body at 500 characters", () => {
		const msg = describeOllamaError("x".repeat(2000), { endpoint: "/api/chat", status: 500 });
		expect(msg).toBe(`Ollama /api/chat returned HTTP 500: ${"x".repeat(500)}`);
	});
});

describe("parity with pi's own overflow check (pi-ai devDependency)", () => {
	// pi compacts and retries a turn only when isContextOverflow matches the
	// errorMessage. A pi-ai bump that changes its patterns fails here.
	it("pi treats our overflow message as a context overflow", () => {
		const msg = describeOllamaError(OBSERVED_OVERFLOW_BODY, {
			endpoint: "/api/chat",
			status: 400,
			numCtx: 2048,
		});
		expect(isContextOverflow(erroredMessage(msg))).toBe(true);
	});

	it("pi does not treat other failures as an overflow", () => {
		const msg = describeOllamaError('{"error":"requested context size too large for model"}', {
			endpoint: "/api/chat",
			status: 500,
		});
		expect(isContextOverflow(erroredMessage(msg))).toBe(false);
	});
});
