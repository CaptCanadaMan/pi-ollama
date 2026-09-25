import { describe, expect, it } from "vitest";
import { buildChatRequestBody, shouldFlagSwallowedToolCall } from "../src/provider.js";
import { toThinkingLevelMap } from "../src/thinking.js";

// resolveThink's own cases live in thinking.test.ts.

describe("shouldFlagSwallowedToolCall — issue #3 detection with the issue #4 batched-stream stand-down", () => {
	const base = { sawToolCalls: false, sawDoneChunk: true };

	it("flags the real issue-#3 swallow (1896 generated, 677 streamed, ~2.8 tok/chunk)", () => {
		expect(
			shouldFlagSwallowedToolCall({ ...base, outputTokens: 1896, chunksReceived: 677 }),
		).toBe(true);
	});

	it("stays quiet on a healthy local text turn (~1 token/chunk)", () => {
		expect(
			shouldFlagSwallowedToolCall({ ...base, outputTokens: 900, chunksReceived: 850 }),
		).toBe(false);
	});

	it("stands down on a batched cloud stream (~30 tokens/chunk, issue #4)", () => {
		expect(
			shouldFlagSwallowedToolCall({ ...base, outputTokens: 900, chunksReceived: 30 }),
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
			shouldFlagSwallowedToolCall({ ...base, outputTokens: 150, chunksReceived: 20 }),
		).toBe(false);
	});
});

describe("buildChatRequestBody — the wire body /api/chat actually receives", () => {
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
		thinkingLevelMap: undefined,
		tools: undefined,
	};

	it("omits keep_alive entirely when no override is configured (server decides)", () => {
		const body = buildChatRequestBody(base);
		expect("keep_alive" in body).toBe(false);
	});

	it("includes keep_alive when an override is configured", () => {
		expect(buildChatRequestBody({ ...base, keepAlive: "10m" }).keep_alive).toBe("10m");
		expect(buildChatRequestBody({ ...base, keepAlive: -1 }).keep_alive).toBe(-1);
	});

	it("carries the invariant fields verbatim", () => {
		const body = buildChatRequestBody(base);
		expect(body.model).toBe("gemma4:12b");
		expect(body.stream).toBe(true);
		expect(body.options).toEqual({ num_ctx: 32768 });
		expect(body.messages).toHaveLength(1);
	});

	it("always asks Ollama not to truncate history (overflow must reach pi)", () => {
		expect(buildChatRequestBody(base).truncate).toBe(false);
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
			buildChatRequestBody({ ...base, reasoningCapable: true, reasoningLevel: "high" })
				.think,
		).toBe(true);
	});

	it("sends the model's own level name when it reports thinking values (gh#13)", () => {
		const thinkingLevelMap = toThinkingLevelMap({
			values: [false, "low", "medium", "xhigh"],
		});
		const body = buildChatRequestBody({
			...base,
			reasoningCapable: true,
			reasoningLevel: "medium",
			thinkingLevelMap,
		});
		expect(body.think).toBe("medium");
	});

	it("omits the think key for off when the model can't switch thinking off", () => {
		const body = buildChatRequestBody({
			...base,
			reasoningCapable: true,
			reasoningLevel: undefined,
			thinkingLevelMap: toThinkingLevelMap({ values: ["low", "medium", "high"] }),
		});
		expect("think" in body).toBe(false);
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
