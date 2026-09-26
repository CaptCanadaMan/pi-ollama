import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiscoveredModel, discoverPinned, fallbackModels, mergePinned } from "../src/discovery.js";
import { loadModelConfig } from "../src/model-config.js";

// Models pinned to a named server in the config: looked up on their own
// server, registered with its address, and never sent the API key.

const remote = "http://remote.test:11434";
const config = loadModelConfig(
	{ servers: { remote: { host: "remote.test" } }, models: { "big:latest": { server: "remote" } } },
	{},
).config;

const cached = (id: string, baseUrl?: string): DiscoveredModel => ({
	id,
	name: id,
	tools: false,
	vision: false,
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 8192,
	...(baseUrl && { baseUrl }),
});

function stubShow(reply: () => Promise<Response>) {
	const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
		if (url === `${remote}/api/show`) return reply();
		throw new Error(`unexpected request to ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discoverPinned", () => {
	it("registers a pinned model with its own server's address, without the API key", async () => {
		const fetchMock = stubShow(async () =>
			Response.json({ capabilities: ["completion", "tools"], model_info: { "llama.context_length": 131072 } }),
		);

		const { models, issues } = await discoverPinned(config, []);

		expect(issues).toEqual([]);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "big:latest", baseUrl: remote, tools: true });
		const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
		expect(headers.has("Authorization")).toBe(false);
	});

	it("falls back to the cached entry for the same server when the lookup fails", async () => {
		stubShow(async () => {
			throw new TypeError("fetch failed");
		});

		const { models, issues } = await discoverPinned(config, [cached("big:latest", remote)]);

		expect(models.map((m) => m.baseUrl)).toEqual([remote]);
		expect(issues[0]?.message).toMatch(/using the cached entry/);
	});
});

describe("mergePinned / fallbackModels", () => {
	it("lets a pinned model replace the default server's model of the same name", () => {
		const merged = mergePinned([cached("big:latest"), cached("small:latest")], [cached("big:latest", remote)]);

		expect(merged.map((m) => [m.id, m.baseUrl])).toEqual([
			["small:latest", undefined],
			["big:latest", remote],
		]);
	});

	it("still looks up pinned models when the default server is down, dropping removed servers", async () => {
		stubShow(async () => Response.json({ capabilities: ["completion"] }));

		const { models } = await fallbackModels(config, [
			cached("small:latest"),
			cached("old:latest", "http://removed.test:11434"),
		]);

		expect(models.map((m) => [m.id, m.baseUrl])).toEqual([
			["small:latest", undefined],
			["big:latest", remote],
		]);
	});
});
