import { afterEach, describe, expect, it, vi } from "vitest";

// The config module is mocked so nothing here touches the real ~/.pi file.
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => ({}),
	savePersistedConfig: () => undefined,
}));

const { registerWarmup } = await import("../src/warm.js");
import type { OllamaRequest } from "../src/wire.js";
import { settings } from "./fixtures.js";

// Switching models while a warm-up is running. Two models reading pi's prompt
// at once compete for the same memory and GPU, and a model that was only
// passed over stays loaded - so the one left behind is stopped, and released
// if this session is what loaded it and nothing was ever sent to it.

type Handler = (event: unknown, ctx: unknown) => unknown;

const model = (id: string) => ({ id, api: "ollama-native", provider: "ollama", contextWindow: 8192 });
const big = model("gemma4:12b");
const small = model("gemma4:e4b");
const other = model("muse-glimmer:30b");

interface Sent {
	body: OllamaRequest;
	signal: AbortSignal | undefined;
}

/**
 * A stubbed Ollama. `loaded` is what /api/ps reports as already in memory.
 * A warm-up for a model in `slow` never answers: it only ends when aborted.
 */
function stubOllama({ loaded = [] as string[], slow = [] as string[] } = {}) {
	const sent: Sent[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/ps")) {
				return Response.json({ models: loaded.map((name) => ({ name })) });
			}
			const body = JSON.parse(String(init?.body)) as OllamaRequest;
			const signal = init?.signal ?? undefined;
			sent.push({ body, signal });
			if (slow.includes(body.model) && body.keep_alive !== 0) {
				await new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				});
			}
			return Response.json({ done: true, done_reason: "load" });
		}),
	);
	const warmUps = () => sent.filter((s) => s.body.keep_alive !== 0);
	const unloads = () => sent.filter((s) => s.body.keep_alive === 0).map((s) => s.body.model);
	return { sent, warmUps, unloads };
}

function setup(settleMs = 0) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => undefined,
	};
	registerWarmup(pi, { ...settings }, { whenReady: async () => {}, settleMs });
	const setStatus = vi.fn();
	const ui = { setStatus };
	return {
		setStatus,
		sessionStart: (m: object) => handlers.get("session_start")?.({ reason: "startup" }, { model: m, ui }),
		selectModel: (m: object) => handlers.get("model_select")?.({ model: m }, { model: m, ui }),
		/** The user sent a prompt: pi starts a run. */
		promptSent: () => handlers.get("agent_start")?.({}, { ui }),
		/** A real turn finished on this model. */
		turnEnded: (m: { id: string }) =>
			handlers.get("message_end")?.(
				{ message: { role: "assistant", api: "ollama-native", model: m.id } },
				{ model: m, ui },
			),
	};
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.unstubAllGlobals());

describe("switching models during a warm-up", () => {
	it("stops the warm-up for the model that was left", async () => {
		const { warmUps } = stubOllama({ slow: ["gemma4:12b"] });
		const { sessionStart, selectModel } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		selectModel(small);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(2));

		expect(warmUps()[0]!.body.model).toBe("gemma4:12b");
		expect(warmUps()[0]!.signal?.aborted).toBe(true);
		expect(warmUps()[1]!.body.model).toBe("gemma4:e4b");
		expect(warmUps()[1]!.signal?.aborted).toBe(false);
	});

	it("clears the footer of the stopped warm-up, so only one model shows", async () => {
		const { warmUps } = stubOllama({ slow: ["gemma4:12b", "gemma4:e4b"] });
		const { sessionStart, selectModel, setStatus } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		selectModel(small);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(2));
		setStatus.mockClear();
		await settle(600);

		const shown = setStatus.mock.calls.map(([, text]) => text as string | undefined).filter(Boolean);
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every((text) => text!.includes("gemma4:e4b"))).toBe(true);
	});

	it("leaves a warm-up for the same model running", async () => {
		const { warmUps } = stubOllama({ slow: ["gemma4:12b"] });
		const { sessionStart, selectModel } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		selectModel(big);
		await settle();

		expect(warmUps()).toHaveLength(1);
		expect(warmUps()[0]!.signal?.aborted).toBe(false);
	});

	it("when cycling through models, warms only the one you stop on", async () => {
		const { warmUps } = stubOllama();
		const { selectModel } = setup(40);

		selectModel(big);
		selectModel(other);
		selectModel(small);
		await vi.waitFor(() => expect(warmUps().length).toBeGreaterThan(0));
		await settle(120);

		expect(warmUps().map((w) => w.body.model)).toEqual(["gemma4:e4b"]);
	});

	it("skips the warm-up when a prompt goes out first: that turn loads the model itself", async () => {
		const { warmUps } = stubOllama();
		const { selectModel, promptSent } = setup(60);

		selectModel(small);
		promptSent();
		await settle(160);

		expect(warmUps()).toEqual([]);
	});

	it("still releases the model left behind when a prompt beat the warm-up", async () => {
		const { warmUps, unloads } = stubOllama();
		const { sessionStart, selectModel, promptSent } = setup(60);

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		await settle();
		selectModel(small);
		promptSent();

		await vi.waitFor(() => expect(unloads()).toEqual(["gemma4:12b"]));
		expect(warmUps()).toHaveLength(1);
	});

	it("doesn't make the session's first warm-up wait", async () => {
		const { warmUps } = stubOllama();
		const { sessionStart } = setup(5_000);

		sessionStart(big);

		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
	});
});

describe("releasing a model that was only passed over", () => {
	it("unloads a model this session loaded and never used, once you move on", async () => {
		const { warmUps, unloads } = stubOllama();
		const { sessionStart, selectModel } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		await settle();
		selectModel(small);

		await vi.waitFor(() => expect(unloads()).toEqual(["gemma4:12b"]));
	});

	it("unloads one whose warm-up was stopped part-way too", async () => {
		const { warmUps, unloads } = stubOllama({ slow: ["gemma4:12b"] });
		const { sessionStart, selectModel } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		selectModel(small);

		await vi.waitFor(() => expect(unloads()).toEqual(["gemma4:12b"]));
	});

	it("leaves a model that was already loaded before this session touched it", async () => {
		const { warmUps, unloads } = stubOllama({ loaded: ["gemma4:12b"] });
		const { sessionStart, selectModel } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		await settle();
		selectModel(small);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(2));
		await settle();

		expect(unloads()).toEqual([]);
	});

	it("leaves a model you've had a turn with: keep_alive decides for those", async () => {
		const { warmUps, unloads } = stubOllama();
		const { sessionStart, selectModel, turnEnded } = setup();

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		await settle();
		turnEnded(big);
		selectModel(small);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(2));
		await settle();

		expect(unloads()).toEqual([]);
	});

	it("doesn't unload the model you came back to", async () => {
		const { warmUps, unloads } = stubOllama();
		const { sessionStart, selectModel } = setup(40);

		sessionStart(big);
		await vi.waitFor(() => expect(warmUps()).toHaveLength(1));
		await settle();
		selectModel(small);
		selectModel(big);
		await settle(150);

		expect(unloads()).toEqual([]);
	});
});
