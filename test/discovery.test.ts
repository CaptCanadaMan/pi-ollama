import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../src/discovery.js";

// Discovery against a stubbed Ollama. The stub answers only the exact URLs a
// real server would, so a wrong request fails loudly instead of passing.

const target = { baseUrl: "http://ollama.test" };

type ShowReply = object | ((init?: RequestInit) => Promise<Response>);

/** A request that never answers - it only ends if the caller aborts it. */
function hang(init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});
}

type Reply = (init?: RequestInit) => Promise<Response>;

function stubOllama(tags: string[] | Reply, show: Record<string, ShowReply>) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === `${target.baseUrl}/api/tags`) {
			if (typeof tags === "function") return tags(init);
			return Response.json({ models: tags.map((name) => ({ name })) });
		}
		if (url === `${target.baseUrl}/api/show`) {
			const { name, model } = JSON.parse(String(init?.body)) as {
				name?: string;
				model?: string;
			};
			const reply = show[model ?? name ?? ""];
			if (typeof reply === "function") return reply(init);
			if (reply) return Response.json(reply);
			return new Response('{"error":"model not found"}', { status: 404 });
		}
		return new Response("unexpected request", { status: 599 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discoverModels", () => {
	it("registers every model in /api/tags order, with capabilities from /api/show", async () => {
		stubOllama(["gemma4:26b", "nemotron-cascade-2:latest"], {
			"gemma4:26b": {
				capabilities: ["completion", "vision", "tools", "thinking"],
				model_info: { "gemma4.context_length": 262144 },
			},
			"nemotron-cascade-2:latest": {
				capabilities: ["completion", "tools", "thinking"],
			},
		});

		const models = await discoverModels(target);

		expect(models.map((m) => m.id)).toEqual(["gemma4:26b", "nemotron-cascade-2:latest"]);
		expect(models[0]).toMatchObject({
			name: "Gemma4 26B (Ollama)",
			vision: true,
			tools: true,
			reasoning: true,
			contextWindow: 262144,
		});
		expect(models[1]).toMatchObject({ vision: false, tools: true, reasoning: true });
	});

	it("still registers a model whose /api/show fails, with conservative defaults", async () => {
		stubOllama(["broken:7b", "gemma4:e4b"], {
			"broken:7b": async () => new Response("boom", { status: 500 }),
			"gemma4:e4b": { capabilities: ["completion", "tools"] },
		});

		const models = await discoverModels(target);

		expect(models.map((m) => m.id)).toEqual(["broken:7b", "gemma4:e4b"]);
		expect(models[0]).toMatchObject({
			tools: false,
			vision: false,
			reasoning: false,
			contextWindow: 32768,
		});
	});

	it("asks for every model's details at once, not one after another", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const slowShow = () => async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 20));
			inFlight--;
			return Response.json({ capabilities: ["completion"] });
		};
		stubOllama(["a:1b", "b:1b", "c:1b"], {
			"a:1b": slowShow(),
			"b:1b": slowShow(),
			"c:1b": slowShow(),
		});

		const models = await discoverModels(target);

		expect(models).toHaveLength(3);
		expect(maxInFlight).toBe(3);
	});

	it("gives up on a hung Ollama instead of hanging with it", async () => {
		stubOllama(hang, {});
		const started = Date.now();

		await expect(discoverModels(target, { timeoutMs: 20 })).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("doesn't let one hung model hold up the rest", async () => {
		stubOllama(["stuck:7b", "gemma4:e4b"], {
			"stuck:7b": hang,
			"gemma4:e4b": { capabilities: ["completion", "tools"] },
		});
		const started = Date.now();

		const models = await discoverModels(target, { timeoutMs: 20 });

		expect(Date.now() - started).toBeLessThan(1000);
		expect(models.map((m) => [m.id, m.tools])).toEqual([
			["stuck:7b", false],
			["gemma4:e4b", true],
		]);
	});

	it.each([
		["an embedding model", ["embedding"]],
		["an image-generation model", ["image"]],
	])("leaves out %s, which Ollama can't chat with", async (_kind, capabilities) => {
		stubOllama(["gemma4:e4b", "other:1b", "nemotron-cascade-2:latest"], {
			"gemma4:e4b": { capabilities: ["completion", "tools"] },
			"other:1b": { capabilities },
			"nemotron-cascade-2:latest": { capabilities: ["completion", "tools"] },
		});

		const models = await discoverModels(target);

		expect(models.map((m) => m.id)).toEqual(["gemma4:e4b", "nemotron-cascade-2:latest"]);
	});

	it("keeps a model when an older Ollama reports no capabilities to judge by", async () => {
		stubOllama(["llama3.1:8b"], { "llama3.1:8b": { details: { family: "llama" } } });

		const models = await discoverModels(target);

		expect(models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
	});

	it("sends the approved API key on every discovery request", async () => {
		const fetchMock = stubOllama(["gemma4:e4b"], {
			"gemma4:e4b": { capabilities: ["completion"] },
		});

		await discoverModels({ ...target, apiKey: "sk-home" });

		const auth = fetchMock.mock.calls.map(
			([, init]) => new Headers(init?.headers).get("authorization"),
		);
		expect(auth).toEqual(["Bearer sk-home", "Bearer sk-home"]);
	});

	it("says the key was rejected, without repeating it, when the server refuses it", async () => {
		stubOllama(async () => new Response('{"error":"invalid token"}', { status: 401 }), {});

		const failure = discoverModels({ ...target, apiKey: "sk-home" });

		await expect(failure).rejects.toThrow(/key in OLLAMA_API_KEY was rejected/);
		await expect(failure).rejects.not.toThrow(/sk-home/);
	});

	it("fails with what Ollama said when it can't list models", async () => {
		stubOllama(async () => new Response('{"error":"server busy"}', { status: 503 }), {});

		await expect(discoverModels(target)).rejects.toThrow(
			"Ollama /api/tags returned HTTP 503: server busy",
		);
	});
});
