import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { DiscoveredModel } from "../src/discovery.js";

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

const baseUrl = "http://ollama.test";

const gemma: DiscoveredModel = {
	id: "gemma4:26b",
	name: "Gemma4 26B (Ollama)",
	tools: true,
	vision: true,
	reasoning: true,
	contextWindow: 262144,
	maxTokens: 8192,
};

/** Run one command with typed args; resolve with its single notification. */
function command(name: string, models: DiscoveredModel[], ui: object = {}, overrides = {}) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (n: string, config: { handler: Handler }) => handlers.set(n, config.handler),
	};
	const settings = {
		baseUrl,
		numCtx: 32768,
		ghostRetries: 2,
		throughput: true,
		apiKeyStatus: "none" as const,
		...overrides,
	};
	registerCommands(pi, settings, () => models, async () => models, () => undefined);
	return async (args = "") => {
		const notify = vi.fn();
		await handlers.get(name)?.(args, { ui: { ...ui, notify } });
		expect(notify).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0] as [string, string];
		return { text, level };
	};
}

const statusCommand = (models: DiscoveredModel[]) => command("ollama-status", models);

/** Answers /api/tags and /api/ps like a server with one loaded model. */
function stubServer(tags: () => Promise<Response>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === `${baseUrl}/api/tags`) return tags();
			if (url === `${baseUrl}/api/ps`) {
				return Response.json({ models: [{ name: "gemma4:26b", size_vram: 18e9 }] });
			}
			return new Response("unexpected request", { status: 599 });
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("/ollama-status", () => {
	it("lists the registered models and what's loaded when Ollama is reachable", async () => {
		stubServer(async () => Response.json({ models: [{ name: "gemma4:26b" }] }));

		const { text, level } = await statusCommand([gemma])();

		expect(level).toBe("info");
		expect(text).toContain("1 model(s) registered");
		expect(text).toMatch(/gemma4:26b\s+ctx:262,144\s+\[tools, vision, reasoning\]/);
		expect(text).toContain("gemma4:26b (18.0 GB VRAM)");
	});

	it("reports what Ollama said when it answers with an error", async () => {
		stubServer(async () => new Response('{"error":"server busy"}', { status: 503 }));

		const { text, level } = await statusCommand([gemma])();

		expect(level).toBe("error");
		expect(text).toContain(baseUrl);
		expect(text).toContain("Ollama /api/tags returned HTTP 503: server busy");
	});

	it("says an approved API key is in use, without showing it", async () => {
		stubServer(async () => Response.json({ models: [] }));

		const { text } = await command("ollama-status", [], {}, {
			apiKey: "sk-home",
			apiKeyStatus: "approved",
		})();

		expect(text).toContain("API key: approved for this host (OLLAMA_API_KEY)");
		expect(text).not.toContain("sk-home");
	});

	it("says when a key is set but held back until approved for this host", async () => {
		stubServer(async () => Response.json({ models: [] }));

		const { text } = await command("ollama-status", [], {}, { apiKeyStatus: "unapproved" })();

		expect(text).toContain(
			"API key: set in OLLAMA_API_KEY but not approved for this host - not sent. Restart pi to approve it.",
		);
	});

	it("says whether model warm-up is on", async () => {
		stubServer(async () => Response.json({ models: [] }));

		const on = await command("ollama-status", [], {}, { warm: true })();
		const off = await command("ollama-status", [], {}, { warm: false })();

		expect(on.text).toContain("Warm-up: on (/ollama-warm-up to change)");
		expect(off.text).toContain("Warm-up: off (/ollama-warm-up to change)");
	});

	it("reports an error when there's no Ollama to talk to", async () => {
		stubServer(async () => {
			throw new TypeError("fetch failed");
		});

		const { text, level } = await statusCommand([gemma])();

		expect(level).toBe("error");
		expect(text).toBe(`Ollama check failed at ${baseUrl}: fetch failed`);
	});
});

describe("/ollama-info <model>", () => {
	function stubShow(reply: () => Promise<Response>) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url === `${baseUrl}/api/show` ? reply() : new Response("unexpected", { status: 599 }),
			),
		);
	}

	it("shows the model's details and which thinking levels pi exposes", async () => {
		stubShow(async () =>
			Response.json({
				capabilities: ["completion", "tools", "thinking"],
				thinking: { values: [false, "low", "high"] },
			}),
		);

		const { text, level } = await command("ollama-info", [gemma])("gemma4:26b");

		expect(level).toBe("info");
		expect(text.startsWith("gemma4:26b\n")).toBe(true);
		expect(text).toContain('"capabilities"');
		expect(text).toMatch(/low/);
	});

	it("with no model given, offers the registered models in the status row format", async () => {
		stubShow(async () => Response.json({ capabilities: ["completion"] }));
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);

		const { text } = await command("ollama-info", [gemma], { select })();

		const offered = select.mock.calls[0]![1];
		expect(offered).toHaveLength(1);
		expect(offered[0]).toMatch(/^gemma4:26b\s+ctx:262,144\s+\[tools, vision, reasoning\]$/);
		expect(text.startsWith("gemma4:26b\n")).toBe(true);
	});

	it("reports what Ollama said when the model can't be shown", async () => {
		stubShow(async () => new Response('{"error":"model \'nope\' not found"}', { status: 404 }));

		const { text, level } = await command("ollama-info", [gemma])("nope");

		expect(level).toBe("error");
		expect(text).toContain("Ollama /api/show returned HTTP 404: model 'nope' not found");
	});
});
