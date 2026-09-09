import { describe, expect, it } from "vitest";
import {
	buildChatRequestBody,
	buildRequestOptions,
	resolveThink,
	shouldFlagSwallowedToolCall,
} from "../src/provider.js";

describe("resolveThink — pi thinking level → Ollama think flag", () => {
	it("maps an absent level (pi's encoding of off) to an explicit false", () => {
		expect(resolveThink(undefined)).toBe(false);
	});

	it("treats a literal 'off' string defensively as off", () => {
		expect(resolveThink("off")).toBe(false);
	});

	it("maps any set level to true", () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
			expect(resolveThink(level)).toBe(true);
		}
	});
});

describe("shouldFlagSwallowedToolCall — issue #3 detection with the issue #4 batched-stream stand-down", () => {
	const base = { sawToolCalls: false, sawDoneChunk: true };

	it("flags the real issue-#3 swallow (1896 generated, 677 streamed, ~2.8 tok/chunk)", () => {
		expect(
			shouldFlagSwallowedToolCall({
				...base,
				outputTokens: 1896,
				chunksReceived: 677,
			}),
		).toBe(true);
	});

	it("stays quiet on a healthy local text turn (~1 token/chunk)", () => {
		expect(
			shouldFlagSwallowedToolCall({
				...base,
				outputTokens: 900,
				chunksReceived: 850,
			}),
		).toBe(false);
	});

	it("stands down on a batched cloud stream (~30 tokens/chunk, issue #4)", () => {
		expect(
			shouldFlagSwallowedToolCall({
				...base,
				outputTokens: 900,
				chunksReceived: 30,
			}),
		).toBe(false);
	});

	it("stays quiet when a tool call actually streamed", () => {
		expect(
			shouldFlagSwallowedToolCall({
				sawToolCalls: true,
				sawDoneChunk: true,
				outputTokens: 1896,
				chunksReceived: 677,
			}),
		).toBe(false);
	});

	it("stays quiet without a done chunk (that path is the truncation error's)", () => {
		expect(
			shouldFlagSwallowedToolCall({
				sawToolCalls: false,
				sawDoneChunk: false,
				outputTokens: 1896,
				chunksReceived: 677,
			}),
		).toBe(false);
	});

	it("ignores short turns below the noise floor", () => {
		expect(
			shouldFlagSwallowedToolCall({
				...base,
				outputTokens: 150,
				chunksReceived: 20,
			}),
		).toBe(false);
	});
});

describe("buildRequestOptions - the wire /api/chat `options` object", () => {
	// Extra sampling params (OLLAMA_TOP_P etc.) are env-var sourced on
	// settings, not pi core's per-turn options - same key-absent-when-unset
	// contract as keep_alive (gh#5): a present key always overrides whatever
	// default Ollama's Modelfile/server would otherwise apply.
	const noSamplingSettings = {
		topP: undefined,
		topK: undefined,
		repeatPenalty: undefined,
		minP: undefined,
		presencePenalty: undefined,
		frequencyPenalty: undefined,
		seed: undefined,
	};

	it("always includes num_ctx", () => {
		expect(
			buildRequestOptions(32768, undefined, noSamplingSettings).num_ctx,
		).toBe(32768);
	});

	it("omits temperature/num_predict/all sampling params when nothing is configured", () => {
		const opts = buildRequestOptions(32768, undefined, noSamplingSettings);
		for (const key of [
			"temperature",
			"num_predict",
			"top_p",
			"top_k",
			"repeat_penalty",
			"min_p",
			"presence_penalty",
			"frequency_penalty",
			"seed",
		]) {
			expect(key in opts).toBe(false);
		}
	});

	it("forwards temperature and maxTokens from pi's per-turn options", () => {
		const opts = buildRequestOptions(
			32768,
			{ temperature: 0.7, maxTokens: 1024 },
			noSamplingSettings,
		);
		expect(opts.temperature).toBe(0.7);
		expect(opts.num_predict).toBe(1024);
	});

	it("maps every env-var-sourced sampling setting to its wire key", () => {
		const opts = buildRequestOptions(32768, undefined, {
			topP: 0.9,
			topK: 40,
			repeatPenalty: 1.1,
			minP: 0.05,
			presencePenalty: 0.5,
			frequencyPenalty: 0.3,
			seed: 42,
		});
		expect(opts.top_p).toBe(0.9);
		expect(opts.top_k).toBe(40);
		expect(opts.repeat_penalty).toBe(1.1);
		expect(opts.min_p).toBe(0.05);
		expect(opts.presence_penalty).toBe(0.5);
		expect(opts.frequency_penalty).toBe(0.3);
		expect(opts.seed).toBe(42);
	});

	it("includes only the sampling params that are actually set", () => {
		const opts = buildRequestOptions(32768, undefined, {
			...noSamplingSettings,
			topP: 0.9,
			seed: -1,
		});
		expect(opts.top_p).toBe(0.9);
		expect(opts.seed).toBe(-1);
		expect("top_k" in opts).toBe(false);
		expect("repeat_penalty" in opts).toBe(false);
	});
});

describe("buildChatRequestBody - the wire body /api/chat actually receives", () => {
	// Wire-level lock on gh#5 (adopted from PR #6's test approach): the
	// keep_alive KEY must be absent — not undefined-valued — when no override
	// is configured, so the Ollama server's own OLLAMA_KEEP_ALIVE decides.
	const base = {
		modelId: "gemma4:12b",
		messages: [{ role: "user" as const, content: "hi" }],
		options: { num_ctx: 32768 },
		keepAlive: undefined,
		reasoningCapable: false,
		reasoningLevel: undefined,
		tools: undefined,
	};

	it("omits keep_alive entirely when no override is configured (server decides)", () => {
		const body = buildChatRequestBody(base);
		expect("keep_alive" in body).toBe(false);
	});

	it("includes keep_alive when an override is configured", () => {
		expect(buildChatRequestBody({ ...base, keepAlive: "10m" }).keep_alive).toBe(
			"10m",
		);
		expect(buildChatRequestBody({ ...base, keepAlive: -1 }).keep_alive).toBe(-1);
	});

	it("carries the invariant fields verbatim", () => {
		const body = buildChatRequestBody(base);
		expect(body.model).toBe("gemma4:12b");
		expect(body.stream).toBe(true);
		expect(body.options).toEqual({ num_ctx: 32768 });
		expect(body.messages).toHaveLength(1);
	});

	it("sends think only for thinking-capable models (Ollama rejects it otherwise)", () => {
		expect("think" in buildChatRequestBody(base)).toBe(false);
		const thinking = buildChatRequestBody({
			...base,
			reasoningCapable: true,
			reasoningLevel: undefined,
		});
		expect(thinking.think).toBe(false); // absent level = explicit false (#3)
		expect(
			buildChatRequestBody({
				...base,
				reasoningCapable: true,
				reasoningLevel: "high",
			}).think,
		).toBe(true);
	});

	it("includes tools only when provided", () => {
		expect("tools" in buildChatRequestBody(base)).toBe(false);
		const withTools = buildChatRequestBody({
			...base,
			tools: [
				{
					type: "function",
					function: { name: "t", description: "", parameters: { type: "object" } },
				},
			],
		});
		expect(withTools.tools).toHaveLength(1);
	});
});
