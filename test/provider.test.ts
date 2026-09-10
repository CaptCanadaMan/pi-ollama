import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildChatRequestBody,
	resolveThink,
	shouldFlagSwallowedToolCall,
} from "../src/provider.js";

vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));

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

describe("writeLiveProgress / writeLastTurnSummary - status-line signal files", () => {
	beforeEach(() => {
		// Fresh module instance per test so the throttle's module-level
		// timestamp doesn't leak across tests; clear the fs mock's call
		// history separately since resetModules() doesn't touch it.
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("writes model id and chunk count on the first live-progress call", async () => {
		const fs = await import("node:fs");
		const { writeLiveProgress } = await import("../src/provider.js");
		writeLiveProgress("gemma4:12b", 3);
		expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
		const [path, body] = vi.mocked(fs.writeFileSync).mock.calls[0];
		expect(String(path)).toContain("pi-ollama-live-progress.json");
		expect(JSON.parse(body as string)).toMatchObject({
			modelId: "gemma4:12b",
			chunksReceived: 3,
		});
	});

	it("throttles back-to-back live-progress writes within the interval", async () => {
		const fs = await import("node:fs");
		const { writeLiveProgress } = await import("../src/provider.js");
		writeLiveProgress("gemma4:12b", 1);
		writeLiveProgress("gemma4:12b", 2);
		expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
	});

	it("force bypasses the throttle", async () => {
		const fs = await import("node:fs");
		const { writeLiveProgress } = await import("../src/provider.js");
		writeLiveProgress("gemma4:12b", 1);
		writeLiveProgress("gemma4:12b", 2, true);
		expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
	});

	it("writes tokens and the computed avg tok/s once a turn completes", async () => {
		const fs = await import("node:fs");
		const { writeLastTurnSummary } = await import("../src/provider.js");
		writeLastTurnSummary("gemma4:12b", 100, 500_000_000); // 100 tok / 0.5s
		expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
		const [path, body] = vi.mocked(fs.writeFileSync).mock.calls[0];
		expect(String(path)).toContain("pi-ollama-last-turn.json");
		expect(JSON.parse(body as string).avgTokPerSec).toBeCloseTo(200);
	});

	it("skips the write when tokens or eval duration is zero", async () => {
		const fs = await import("node:fs");
		const { writeLastTurnSummary } = await import("../src/provider.js");
		writeLastTurnSummary("gemma4:12b", 0, 500_000_000);
		writeLastTurnSummary("gemma4:12b", 100, 0);
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});
});
