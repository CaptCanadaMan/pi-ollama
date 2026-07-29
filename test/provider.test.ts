import { describe, expect, it } from "vitest";
import { resolveThink, shouldFlagSwallowedToolCall } from "../src/provider.js";

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
