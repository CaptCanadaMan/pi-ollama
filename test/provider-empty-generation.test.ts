import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doneChunk, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// Ollama sometimes counts generated tokens but sends back nothing. When the
// request offered tools, that is almost always a tool call Ollama's parser
// couldn't read and dropped (it logs "tool call parsing failed" and emits
// nothing), so the error should point there rather than at retries.

const user = { role: "user", content: "hi", timestamp: 1 };
const tool = {
	name: "webmcp_call",
	description: "Call a page tool",
	parameters: { type: "object", properties: { tool: { type: "string" } } },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOllama - tokens generated, nothing returned", () => {
	it("on a turn that offered tools, names the dropped tool call", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([doneChunk(34, 1e9)])));
		const end = await runStream({ systemPrompt: "sys", tools: [tool], messages: [user] });
		expect(end.type).toBe("error");
		expect(end.error?.errorMessage).toContain("tool call parsing failed");
		expect(end.error?.errorMessage).not.toContain("OLLAMA_NATIVE_GHOST_RETRIES");
	});

	it("gives the same diagnosis when the emptiness only shows at the end of the stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([textChunk(""), doneChunk(34, 1e9)])),
		);
		const end = await runStream({ systemPrompt: "sys", tools: [tool], messages: [user] });
		expect(end.type).toBe("error");
		expect(end.error?.errorMessage).toContain("tool call parsing failed");
	});

	it("with no tools on offer, counts the attempts and points at the retry setting", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([doneChunk(34, 1e9)])));
		const end = await runStream({ messages: [user] });
		expect(end.error?.errorMessage).toContain("(3 attempt(s))");
		expect(end.error?.errorMessage).toContain("OLLAMA_NATIVE_GHOST_RETRIES");
		expect(end.error?.errorMessage).not.toContain("parsing failed");
	});

	it("is not an error pi retries on its own - the retries already happened here", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([doneChunk(34, 1e9)])));
		const end = await runStream({ systemPrompt: "sys", tools: [tool], messages: [user] });
		const message = {
			stopReason: end.error?.stopReason,
			errorMessage: end.error?.errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0 },
		} as unknown as Parameters<typeof isRetryableAssistantError>[0];
		expect(isRetryableAssistantError(message)).toBe(false);
	});
});
