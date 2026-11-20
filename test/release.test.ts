import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";

// The config module is mocked so /ollama-release never touches the real ~/.pi file.
let saved: PersistedConfig | undefined;
let refusal: string | undefined;
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => ({}),
	savePersistedConfig: (c: PersistedConfig) => {
		if (refusal) return refusal;
		saved = c;
		return undefined;
	},
}));

const { registerRelease } = await import("../src/release.js");
import { loadModelConfig } from "../src/model-config.js";
import type { OllamaRequest } from "../src/wire.js";
import { settings } from "./fixtures.js";

// What happens to a model you have used once you leave it, by switching to
// another or quitting pi. By default nothing: keep_alive decides. With
// releaseAfter set, pi-ollama tells Ollama to drop it, at once or after a
// while, so a session that visits several models doesn't keep them all loaded.

type Handler = (event: unknown, ctx: unknown) => unknown;

const model = (id: string, api = "ollama-native") => ({ id, api, provider: "ollama" });
const big = model("gemma4:31b");
const small = model("gemma4:e4b");
const claude = model("claude-opus-5-5", "anthropic-messages");

function stubOllama() {
	const sent: OllamaRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)) as OllamaRequest);
			return Response.json({ done: true, done_reason: "unload" });
		}),
	);
	return sent;
}

function setup(overrides: object = {}, settleMs = 0) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, config.handler),
	};
	const live = { ...settings, ...overrides };
	registerRelease(pi, live, { settleMs });
	const notify = vi.fn();
	return {
		live,
		notify,
		sessionStart: (m: object) => handlers.get("session_start")?.({ reason: "startup" }, { model: m }),
		selectModel: (m: object) => handlers.get("model_select")?.({ model: m }, { model: m }),
		/** A real turn finished on this model. */
		turnEnded: (m: { id: string; api: string }) =>
			handlers.get("message_end")?.({ message: { role: "assistant", api: m.api, model: m.id } }, { model: m }),
		quit: () => handlers.get("session_shutdown")?.({}, {}),
		releaseCommand: (answer: string | undefined, typed?: string) =>
			commands.get("ollama-release")?.("", {
				ui: { notify, select: async () => answer, input: async () => typed },
			}),
	};
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
	vi.unstubAllGlobals();
	saved = undefined;
	refusal = undefined;
});

describe("leaving a model you've used", () => {
	it("does nothing by default: keep_alive decides how long it stays", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, selectModel, quit } = setup();

		sessionStart(big);
		turnEnded(big);
		selectModel(small);
		await settle();
		await quit();

		expect(sent).toEqual([]);
	});

	it("unloads it at once when releaseAfter is 0", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, selectModel } = setup({ releaseAfter: 0 });

		sessionStart(big);
		turnEnded(big);
		selectModel(small);

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ model: "gemma4:31b", messages: [], keep_alive: 0 });
	});

	it("gives it that long to live when releaseAfter is a duration", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, selectModel } = setup({ releaseAfter: "10m" });

		sessionStart(big);
		turnEnded(big);
		selectModel(small);

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ model: "gemma4:31b", messages: [], keep_alive: "10m" });
	});

	it("applies when you switch to a model that isn't an Ollama one, too", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, selectModel } = setup({ releaseAfter: 0 });

		sessionStart(big);
		turnEnded(big);
		selectModel(claude);

		await vi.waitFor(() => expect(sent.map((s) => s.model)).toEqual(["gemma4:31b"]));
	});

	it("leaves a model you never had a turn with to the warm-up's own clean-up", async () => {
		const sent = stubOllama();
		const { sessionStart, selectModel } = setup({ releaseAfter: 0 });

		sessionStart(big);
		selectModel(small);
		await settle();

		expect(sent).toEqual([]);
	});

	it("does nothing if you come straight back", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, selectModel } = setup({ releaseAfter: 0 }, 40);

		sessionStart(big);
		turnEnded(big);
		selectModel(small);
		selectModel(big);
		await settle(150);

		expect(sent).toEqual([]);
	});

	it("uses a model's own releaseAfter from the config file over the global one", async () => {
		const sent = stubOllama();
		const { config: modelConfig } = loadModelConfig({
			models: { "gemma4:31b": { releaseAfter: 0 }, "gemma4:e4b": { releaseAfter: "1h" } },
		});
		const { sessionStart, turnEnded, selectModel } = setup({ modelConfig });

		sessionStart(big);
		turnEnded(big);
		selectModel(small);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		turnEnded(small);
		selectModel(big);
		await vi.waitFor(() => expect(sent).toHaveLength(2));

		expect(sent.map((s) => [s.model, s.keep_alive])).toEqual([
			["gemma4:31b", 0],
			["gemma4:e4b", "1h"],
		]);
	});
});

describe("quitting pi", () => {
	it("releases the model you were on, before pi exits", async () => {
		const sent = stubOllama();
		const { sessionStart, turnEnded, quit } = setup({ releaseAfter: 0 });

		sessionStart(big);
		turnEnded(big);
		await quit();

		expect(sent).toEqual([{ model: "gemma4:31b", messages: [], keep_alive: 0 }]);
	});

	it("doesn't hold pi open when Ollama is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		const { sessionStart, turnEnded, quit } = setup({ releaseAfter: 0 });

		sessionStart(big);
		turnEnded(big);

		await expect(quit()).resolves.toBeUndefined();
	});
});

describe("/ollama-release", () => {
	it("saves the choice and applies it from the next switch", async () => {
		const sent = stubOllama();
		const { live, releaseCommand, notify, sessionStart, turnEnded, selectModel } = setup();

		await releaseCommand("As soon as I leave the model");
		sessionStart(big);
		turnEnded(big);
		selectModel(small);

		expect(saved).toEqual({ releaseAfter: 0 });
		expect(live.releaseAfter).toBe(0);
		expect(notify.mock.calls[0]?.[1]).toBe("info");
		await vi.waitFor(() => expect(sent).toHaveLength(1));
	});

	it("takes a custom time", async () => {
		const { live, releaseCommand } = setup();

		await releaseCommand("Custom time…", "45m");

		expect(saved).toEqual({ releaseAfter: "45m" });
		expect(live.releaseAfter).toBe("45m");
	});

	it("rejects a time it can't read, and changes nothing", async () => {
		const { live, releaseCommand, notify } = setup({ releaseAfter: "10m" });

		await releaseCommand("Custom time…", "soon");

		expect(saved).toBeUndefined();
		expect(live.releaseAfter).toBe("10m");
		expect(notify.mock.calls[0]?.[1]).toBe("error");
	});

	it("goes back to leaving it to keep_alive", async () => {
		const { live, releaseCommand } = setup({ releaseAfter: 0 });

		await releaseCommand("Leave it to keep_alive (default)");

		expect(saved).toEqual({});
		expect(live.releaseAfter).toBeUndefined();
	});

	it("changes nothing when the config file can't be saved", async () => {
		const { live, releaseCommand, notify } = setup();
		refusal = "pi-ollama-config.json couldn't be read (bad JSON), so it was left as it is.";

		await releaseCommand("As soon as I leave the model");

		expect(live.releaseAfter).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(`Not changed: ${refusal}`, "error");
	});
});
