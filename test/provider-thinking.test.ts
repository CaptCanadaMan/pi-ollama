import { afterEach, describe, expect, it, vi } from "vitest";
import { toThinkingLevelMap } from "../src/thinking.js";
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, model, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// gh#13: drive the real streamOllama with the model shape pi hands back to
// us (thinkingLevelMap passed through by pi's provider-composer) and inspect
// the `think` value /api/chat actually receives.

const user = { role: "user", content: "hi", timestamp: 1 };

async function sentThink(
	thinkingLevelMap: ReturnType<typeof toThinkingLevelMap>,
	reasoning: string | undefined,
): Promise<OllamaRequest["think"] | "absent"> {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
		ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]),
	);
	vi.stubGlobal("fetch", fetchMock);
	await runStream({ messages: [user] }, undefined, {
		model: { ...model, reasoning: true, thinkingLevelMap },
		options: reasoning === undefined ? undefined : { reasoning },
	});
	const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as OllamaRequest;
	return "think" in body ? body.think : "absent";
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOllama - think on the wire (gh#13)", () => {
	const museGlimmer = toThinkingLevelMap({
		values: [false, "low", "medium", "high", "max"],
	});
	const gemma4 = toThinkingLevelMap({ values: [false, true] });

	it("sends the model's named level", async () => {
		expect(await sentThink(museGlimmer, "high")).toBe("high");
		expect(await sentThink(museGlimmer, "max")).toBe("max");
	});

	it("sends true / false for an on/off-only model", async () => {
		expect(await sentThink(gemma4, "medium")).toBe(true);
		expect(await sentThink(gemma4, undefined)).toBe(false);
	});

	it("falls back to on/off when pi didn't pass a map through", async () => {
		expect(await sentThink(undefined, "high")).toBe(true);
		expect(await sentThink(undefined, undefined)).toBe(false);
	});

	it("leaves think out for off on a model that can't turn it off", async () => {
		const noOff = toThinkingLevelMap({ values: ["low", "medium", "high"] });
		expect(await sentThink(noOff, undefined)).toBe("absent");
	});
});
