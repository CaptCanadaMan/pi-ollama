import { afterEach, describe, expect, it, vi } from "vitest";
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// gh#11: pi >= 0.86 moved the system prompt and tool declarations out of
// context.systemPrompt / context.tools and into role:"system" transcript
// messages. These drive the real streamOllama and inspect the body /api/chat
// actually receives - the layer the regression showed up at.

const read = { name: "read", description: "Read a file", parameters: { type: "object" } };
const bash = { name: "bash", description: "Run a command", parameters: { type: "object" } };
const user = { role: "user", content: "hi", timestamp: 1 };

async function sentBody(context: Parameters<typeof runStream>[0]): Promise<OllamaRequest> {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
		ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]),
	);
	vi.stubGlobal("fetch", fetchMock);
	await runStream(context);
	return JSON.parse(fetchMock.mock.calls[0]![1].body as string) as OllamaRequest;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOllama - prompt and tools on the wire (gh#11)", () => {
	it("sends the prompt and tools carried by pi >= 0.86 system messages", async () => {
		const body = await sentBody({
			messages: [
				{
					role: "system",
					content: "You are pi.",
					sections: { rules: "<rules>Be brief.</rules>" },
					toolsAdded: [read, bash],
					timestamp: 0,
				},
				user,
			],
		});

		expect(body.messages).toEqual([
			{ role: "system", content: "You are pi.\n\n<rules>Be brief.</rules>" },
			{ role: "user", content: "hi" },
		]);
		expect(body.tools?.map((t) => t.function.name)).toEqual(["read", "bash"]);
	});

	it("sends the same body for the pre-0.86 systemPrompt/tools shape", async () => {
		const body = await sentBody({
			systemPrompt: "You are pi.",
			tools: [read, bash],
			messages: [user],
		});

		expect(body.messages).toEqual([
			{ role: "system", content: "You are pi." },
			{ role: "user", content: "hi" },
		]);
		expect(body.tools?.map((t) => t.function.name)).toEqual(["read", "bash"]);
	});

	it("omits tools and the system message when there are neither", async () => {
		const body = await sentBody({ messages: [user] });

		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
		expect("tools" in body).toBe(false);
	});
});
