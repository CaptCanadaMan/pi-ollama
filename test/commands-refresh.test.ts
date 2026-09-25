import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { DiscoveredModel } from "../src/discovery.js";

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

const model = (id: string): DiscoveredModel => ({
	id,
	name: id,
	tools: true,
	vision: false,
	reasoning: false,
	contextWindow: 32768,
	maxTokens: 8192,
});

async function runRefresh(refresh: () => Promise<DiscoveredModel[]>) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (n: string, config: { handler: Handler }) => handlers.set(n, config.handler),
	};
	const settings = { baseUrl: "http://ollama.test", numCtx: 32768, ghostRetries: 2, throughput: true };
	registerCommands(pi, settings, () => [], refresh, () => undefined);
	const notify = vi.fn();
	await handlers.get("ollama-refresh")?.("", { ui: { notify } });
	expect(notify).toHaveBeenCalledTimes(1);
	const [text, level] = notify.mock.calls[0] as [string, string];
	return { text, level };
}

beforeEach(() => {
	// The command must go through the refresh it's given, never the network.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network call");
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("/ollama-refresh", () => {
	it("refreshes once and reports how many models are now registered", async () => {
		const refresh = vi.fn(async () => [model("a:1b"), model("b:1b"), model("c:1b")]);

		const { text, level } = await runRefresh(refresh);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(level).toBe("info");
		expect(text).toContain("3 model(s) registered");
	});

	it("reports why when the refresh fails", async () => {
		const refresh = vi.fn(async (): Promise<DiscoveredModel[]> => {
			throw new Error("Ollama /api/tags returned HTTP 503: server busy");
		});

		const { text, level } = await runRefresh(refresh);

		expect(level).toBe("error");
		expect(text).toBe("Refresh failed: Ollama /api/tags returned HTTP 503: server busy");
	});
});
