import { isContextOverflow } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// With truncate:false Ollama refuses an over-long chat instead of silently
// dropping its oldest messages. These drive the real streamOllama and check
// the refusal reaches pi as an error pi's own overflow check recognizes -
// that recognition is what makes pi compact and retry the turn.

const user = { role: "user", content: "hi", timestamp: 1 };

// Captured live from Ollama 0.34.4 (HTTP 400, before any streaming).
const overflowError = JSON.stringify({
	error: {
		code: 400,
		message:
			"request (9533 tokens) exceeds the available context size (2048 tokens), try increasing it",
		type: "exceed_context_size_error",
	},
});

function asPiMessage(error: { stopReason?: string; errorMessage?: string } | undefined) {
	return {
		stopReason: error?.stopReason,
		errorMessage: error?.errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0 },
	} as unknown as Parameters<typeof isContextOverflow>[0];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOllama - context overflow reaches pi as an overflow", () => {
	it("asks Ollama not to truncate", async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
			ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]),
		);
		vi.stubGlobal("fetch", fetchMock);
		await runStream({ messages: [user] });
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as OllamaRequest;
		expect(body.truncate).toBe(false);
	});

	it("an HTTP overflow refusal ends the turn as an overflow pi will compact", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: overflowError }), { status: 400 })),
		);
		const end = await runStream({ messages: [user] });
		expect(end.type).toBe("error");
		expect(end.error?.errorMessage).toContain("num_ctx=32768");
		expect(isContextOverflow(asPiMessage(end.error))).toBe(true);
	});

	it("an overflow error line inside the stream is recognized too", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([{ error: overflowError }])));
		const end = await runStream({ messages: [user] });
		expect(end.type).toBe("error");
		expect(isContextOverflow(asPiMessage(end.error))).toBe(true);
	});

	it("other failures are not mistaken for an overflow", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"error":"model \\"x\\" not found"}', { status: 404 })),
		);
		const end = await runStream({ messages: [user] });
		expect(end.error?.errorMessage).toBe('Ollama /api/chat returned HTTP 404: model "x" not found');
		expect(isContextOverflow(asPiMessage(end.error))).toBe(false);
	});
});
