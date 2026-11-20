import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelConfig } from "../src/model-config.js";
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// Per-model keep_alive on the wire (GH-14): what the config file says for a
// model is what /api/chat receives for that model, and only for that model.

afterEach(() => vi.unstubAllGlobals());

function captureRequests() {
	const requests: OllamaRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			requests.push(JSON.parse(String(init.body)) as OllamaRequest);
			return ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]);
		}),
	);
	return requests;
}

const { config: modelConfig } = loadModelConfig({
	models: { "gemma4:12b": { keepAlive: -1 }, "muse-glimmer:30b": { keepAlive: "10m" } },
});

const turn = (id: string, settings: object) =>
	runStream({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }, undefined, {
		model: { id, api: "ollama-native", provider: "ollama" },
		settings,
	});

describe("per-model keep_alive reaches the request", () => {
	it("sends each model its own value", async () => {
		const requests = captureRequests();

		await turn("gemma4:12b", { modelConfig });
		await turn("muse-glimmer:30b", { modelConfig });

		expect(requests.map((r) => [r.model, r.keep_alive])).toEqual([
			["gemma4:12b", -1],
			["muse-glimmer:30b", "10m"],
		]);
	});

	it("falls back to the global value for a model with no entry", async () => {
		const requests = captureRequests();

		await turn("gemma4:e4b", { modelConfig, keepAlive: "5m" });
		await turn("gemma4:12b", { modelConfig, keepAlive: "5m" });

		expect(requests.map((r) => r.keep_alive)).toEqual(["5m", -1]);
	});

	it("still leaves the field out when nothing sets it, so the server decides", async () => {
		const requests = captureRequests();

		await turn("gemma4:e4b", { modelConfig });

		expect("keep_alive" in requests[0]!).toBe(false);
	});
});
