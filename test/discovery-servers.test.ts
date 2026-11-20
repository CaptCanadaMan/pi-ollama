import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiscoveredModel, discoverAll, discoverPinned, mergePinned } from "../src/discovery.js";
import { loadModelConfig } from "../src/model-config.js";

// Models pinned to a named server (GH-14) are looked up on that server and
// registered with its address. Stubbed per server, so a request to the wrong
// one fails loudly.

const JETSON = "http://10.0.0.5:11434";
const STUDIO = "https://studio.home/ollama";

type ShowReply = object | (() => Promise<Response>);

/** `servers` maps a base URL to the models it has; anything else is a wrong request. */
function stubServers(servers: Record<string, Record<string, ShowReply>>) {
	const calls: Array<{ url: string; model: string; auth: string | null }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const base = Object.keys(servers).find((b) => url === `${b}/api/show`);
			const { name } = JSON.parse(String(init?.body)) as { name: string };
			calls.push({ url, model: name, auth: new Headers(init?.headers).get("Authorization") });
			if (!base) return new Response("wrong server", { status: 599 });
			const reply = servers[base]?.[name];
			if (typeof reply === "function") return reply();
			if (reply) return Response.json(reply);
			return new Response('{"error":"model not found"}', { status: 404 });
		}),
	);
	return calls;
}

const config = (raw: object) => loadModelConfig(raw).config;

afterEach(() => vi.unstubAllGlobals());

describe("discoverPinned", () => {
	it("looks each pinned model up on its own server and registers it with that address", async () => {
		stubServers({
			[JETSON]: {
				"gemma4:12b": { capabilities: ["completion", "tools"], model_info: { "gemma4.context_length": 131072 } },
			},
			[STUDIO]: { "muse-glimmer:30b": { capabilities: ["completion", "vision"] } },
		});

		const { models, issues } = await discoverPinned(
			config({
				servers: { jetson: { host: "10.0.0.5" }, studio: { host: STUDIO } },
				models: { "gemma4:12b": { server: "jetson" }, "muse-glimmer:30b": { server: "studio" } },
			}),
			[],
		);

		expect(issues).toEqual([]);
		expect(models).toEqual([
			expect.objectContaining({
				id: "gemma4:12b",
				baseUrl: JETSON,
				tools: true,
				contextWindow: 131072,
				contextWindowKnown: true,
			}),
			expect.objectContaining({ id: "muse-glimmer:30b", baseUrl: STUDIO, vision: true }),
		]);
	});

	it("asks for nothing when no model is pinned", async () => {
		const calls = stubServers({});

		const { models } = await discoverPinned(
			config({ servers: { jetson: { host: "10.0.0.5" } }, models: { "gemma4:e4b": { warm: false } } }),
			[],
		);

		expect(models).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("never sends the API key to a named server", async () => {
		vi.stubEnv("OLLAMA_API_KEY", "sk-home");
		const calls = stubServers({ [JETSON]: { "gemma4:12b": { capabilities: ["completion"] } } });

		await discoverPinned(
			config({ servers: { jetson: { host: "10.0.0.5" } }, models: { "gemma4:12b": { server: "jetson" } } }),
			[],
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.auth).toBeNull();
		vi.unstubAllEnvs();
	});

	it("uses the cached entry for the same server when the server can't be reached, and says so", async () => {
		stubServers({
			[JETSON]: {
				"gemma4:12b": async () => {
					throw new TypeError("fetch failed");
				},
			},
		});
		const cached: DiscoveredModel[] = [
			{
				id: "gemma4:12b",
				name: "Gemma4 12B (Ollama)",
				tools: true,
				vision: false,
				reasoning: false,
				contextWindow: 131072,
				contextWindowKnown: true,
				maxTokens: 8192,
				baseUrl: JETSON,
			},
		];

		const { models, issues } = await discoverPinned(
			config({ servers: { jetson: { host: "10.0.0.5" } }, models: { "gemma4:12b": { server: "jetson" } } }),
			cached,
		);

		expect(models).toEqual(cached);
		expect(issues).toEqual([
			{
				severity: "warning",
				path: 'models["gemma4:12b"].server',
				message: `= "jetson": lookup on ${JETSON} failed (fetch failed) - using the cached entry`,
			},
		]);
	});

	it("doesn't reuse a cached entry from a different server", async () => {
		stubServers({ [JETSON]: {} });
		const cached = [
			{ id: "gemma4:12b", name: "x", tools: true, vision: false, reasoning: false, contextWindow: 32768, maxTokens: 8192 },
			{ id: "gemma4:12b", name: "x", tools: true, vision: false, reasoning: false, contextWindow: 32768, maxTokens: 8192, baseUrl: "http://old.server:11434" },
		];

		const { models, issues } = await discoverPinned(
			config({ servers: { jetson: { host: "10.0.0.5" } }, models: { "gemma4:12b": { server: "jetson" } } }),
			cached,
		);

		expect(models).toEqual([]);
		expect(issues[0]?.message).toMatch(/- not registered$/);
	});

	it("leaves out a pinned model that can't chat, and says so", async () => {
		stubServers({ [JETSON]: { "nomic-embed": { capabilities: ["embedding"] } } });

		const { models, issues } = await discoverPinned(
			config({ servers: { jetson: { host: "10.0.0.5" } }, models: { "nomic-embed": { server: "jetson" } } }),
			[],
		);

		expect(models).toEqual([]);
		expect(issues).toEqual([
			{
				severity: "warning",
				path: 'models["nomic-embed"].server',
				message: `= "jetson": nomic-embed on ${JETSON} is not a chat model - not registered`,
			},
		]);
	});
});

describe("mergePinned", () => {
	const local = (id: string): DiscoveredModel => ({
		id,
		name: id,
		tools: true,
		vision: false,
		reasoning: false,
		contextWindow: 32768,
		maxTokens: 8192,
	});

	it("adds pinned models to the default server's, and a pinned one replaces a same-named local one", () => {
		const pinned = { ...local("gemma4:12b"), baseUrl: JETSON };

		const merged = mergePinned([local("gemma4:e4b"), local("gemma4:12b")], [pinned]);

		expect(merged).toEqual([local("gemma4:e4b"), pinned]);
	});
});

describe("discoverAll", () => {
	const DEFAULT = "http://ollama.test";
	const pinnedConfig = config({
		servers: { jetson: { host: "10.0.0.5" } },
		models: { "gemma4:12b": { server: "jetson" } },
	});

	/** A default server answering /api/tags and /api/show, plus the jetson with gemma4:12b. */
	function stubBoth(defaultUp: boolean) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url.startsWith(DEFAULT)) {
					if (!defaultUp) throw new TypeError("fetch failed");
					if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "gemma4:e4b" }] });
					return Response.json({ capabilities: ["completion", "tools"] });
				}
				if (url === `${JETSON}/api/show`) {
					const { name } = JSON.parse(String(init?.body)) as { name: string };
					if (name === "gemma4:12b") return Response.json({ capabilities: ["completion"] });
				}
				return new Response("unexpected request", { status: 599 });
			}),
		);
	}

	it("returns the default server's models together with the pinned ones", async () => {
		stubBoth(true);

		const result = await discoverAll({ baseUrl: DEFAULT }, pinnedConfig, []);

		expect(result.models.map((m) => [m.id, m.baseUrl])).toEqual([
			["gemma4:e4b", undefined],
			["gemma4:12b", JETSON],
		]);
		expect(result.defaultError).toBeUndefined();
	});

	it("still reaches the pinned servers when the default one is down, and reports that it is", async () => {
		stubBoth(false);
		const cached = [
			{ id: "gemma4:26b", name: "x", tools: true, vision: false, reasoning: false, contextWindow: 32768, maxTokens: 8192 },
			{ id: "gone:7b", name: "x", tools: true, vision: false, reasoning: false, contextWindow: 32768, maxTokens: 8192, baseUrl: "http://removed.server:11434" },
		];

		const result = await discoverAll({ baseUrl: DEFAULT }, pinnedConfig, cached);

		// The default server's cached models, the live pinned one, and nothing from a removed server.
		expect(result.models.map((m) => [m.id, m.baseUrl])).toEqual([
			["gemma4:26b", undefined],
			["gemma4:12b", JETSON],
		]);
		expect(result.defaultError).toBeInstanceOf(Error);
	});
});
