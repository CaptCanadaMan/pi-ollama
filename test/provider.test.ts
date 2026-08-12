import { describe, expect, it, vi } from "vitest";
import {
	resolveThink,
	shouldFlagSwallowedToolCall,
	streamOllama,
} from "../src/provider.js";
import type { OllamaExtensionSettings } from "../src/settings.js";

class MockStream {
	events: unknown[] = [];
	push(event: unknown): void {
		this.events.push(event);
	}
	end(): void {}
}

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line + "\n"));
			}
			controller.close();
		},
	});
}

const baseSettings: OllamaExtensionSettings = {
	baseUrl: "http://localhost:11434",
	numCtx: 32768,
	ghostRetries: 2,
};

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

describe("streamOllama — keep_alive on the wire", () => {
	const doneChunks = [
		JSON.stringify({
			model: "test",
			created_at: "2026-01-01T00:00:00Z",
			message: { role: "assistant", content: "hi" },
			done: false,
		}),
		JSON.stringify({
			model: "test",
			created_at: "2026-01-01T00:00:01Z",
			done: true,
			eval_count: 1,
		}),
	];

	async function captureRequest(
		settings: OllamaExtensionSettings,
	): Promise<Record<string, unknown>> {
		let body: Record<string, unknown> = {};
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(ndjsonStream(doneChunks), { status: 200 });
			});

		let instance: MockStream;
		class CapturingStream extends MockStream {
			constructor() {
				super();
				instance = this;
			}
		}

		streamOllama(
			{ id: "test", api: "ollama-native", baseUrl: "http://localhost:11434" },
			{ messages: [] },
			undefined,
			settings,
			CapturingStream,
		);

		const endSpy = vi.spyOn(instance, "end");
		await vi.waitFor(() => {
			expect(endSpy).toHaveBeenCalled();
		});
		fetchMock.mockRestore();
		return body;
	}

	it("omits keep_alive when settings.keepAlive is unset (server default applies)", async () => {
		const body = await captureRequest(baseSettings);
		expect(body.keep_alive).toBeUndefined();
	});

	it("sends keep_alive when settings.keepAlive is set", async () => {
		const body = await captureRequest({ ...baseSettings, keepAlive: -1 });
		expect(body.keep_alive).toBe(-1);
	});
});
