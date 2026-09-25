import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";

// The config module is mocked so /ollama-warm-up never touches the real ~/.pi file.
let saved: PersistedConfig | undefined;
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => ({}),
	savePersistedConfig: (c: PersistedConfig) => {
		saved = c;
	},
}));

const { createReadySignal, registerWarmup } = await import("../src/warm.js");
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, ndjsonResponse, runStream, settings, textChunk } from "./fixtures.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const gemma = {
	id: "gemma4:26b",
	api: "ollama-native",
	provider: "ollama",
	contextWindow: 16384,
};
const e4b = { ...gemma, id: "gemma4:e4b", contextWindow: 8192 };

/** A stubbed Ollama that answers loads and chat turns, recording every body. */
function stubOllama(loadGate: Promise<void> = Promise.resolve()) {
	const bodies: OllamaRequest[] = [];
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as OllamaRequest;
		bodies.push(body);
		if (body.messages.length > 0) return ndjsonResponse([textChunk("hi"), doneChunk(1, 1e6)]);
		await loadGate;
		return Response.json({ done: true, done_reason: "load" });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, bodies };
}

function setup(
	whenReady: () => Promise<void> = async () => {},
	overrides: Partial<typeof settings> = {},
) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (
			name: string,
			config: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, config.handler),
	};
	registerWarmup(pi, { ...settings, ...overrides }, { whenReady });
	const setStatus = vi.fn();
	const ui = { setStatus };
	const notify = vi.fn();
	return {
		setStatus,
		notify,
		warmUpCommand: (answer: string | undefined, model: object | undefined = gemma) =>
			commands.get("ollama-warm-up")?.("", {
				model,
				ui: { setStatus, notify, select: vi.fn(async () => answer) },
			}),
		sessionStart: (model: object | undefined) =>
			handlers.get("session_start")?.({ reason: "startup" }, { model, ui }),
		selectModel: (model: object) => handlers.get("model_select")?.({ model }, { model, ui }),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	saved = undefined;
});

describe("warming the model", () => {
	it("at session start, loads the model with exactly the options a real turn sends", async () => {
		const { bodies } = stubOllama();
		const { sessionStart } = setup();

		sessionStart(gemma);
		await vi.waitFor(() => expect(bodies).toHaveLength(1));
		await runStream({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }, undefined, {
			model: gemma,
		});

		const [warm, turn] = bodies;
		expect(warm!.model).toBe("gemma4:26b");
		expect(warm!.messages).toEqual([]);
		expect(warm!.options).toEqual(turn!.options);
	});

	it("carries keep_alive exactly when real turns do", async () => {
		const { bodies } = stubOllama();

		setup(undefined, { keepAlive: "30m" }).sessionStart(gemma);
		setup().sessionStart(gemma);
		await vi.waitFor(() => expect(bodies).toHaveLength(2));

		expect(bodies[0]!.keep_alive).toBe("30m");
		expect("keep_alive" in bodies[1]!).toBe(false);
	});

	it("waits until Ollama is up before sending anything", async () => {
		const { bodies } = stubOllama();
		let markReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const { sessionStart } = setup(() => ready);

		sessionStart(gemma);
		await new Promise((r) => setTimeout(r, 20));
		expect(bodies).toHaveLength(0);

		markReady();
		await vi.waitFor(() => expect(bodies).toHaveLength(1));
	});

	it("warms a model when the user switches to it", async () => {
		const { bodies } = stubOllama();
		const { selectModel } = setup();

		selectModel(e4b);

		await vi.waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]).toMatchObject({ model: "gemma4:e4b", options: { num_ctx: 8192 } });
	});

	it("leaves non-Ollama models alone, and does nothing with no model", async () => {
		const { fetchMock } = stubOllama();
		const claude = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "anthropic" };
		const { sessionStart, selectModel } = setup();

		sessionStart(claude);
		selectModel(claude);
		sessionStart(undefined);
		await new Promise((r) => setTimeout(r, 20));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("while waiting, warms only the model the user ends up on", async () => {
		const { bodies } = stubOllama();
		let markReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const { sessionStart, selectModel } = setup(() => ready);

		sessionStart(gemma);
		selectModel(e4b);
		markReady();
		await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 20));

		expect(bodies.map((b) => b.model)).toEqual(["gemma4:e4b"]);
	});

	it("sends one load when the same model is asked for twice at once", async () => {
		const { bodies } = stubOllama();
		const { sessionStart, selectModel } = setup();

		sessionStart(gemma);
		selectModel(gemma);
		await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 20));

		expect(bodies).toHaveLength(1);
	});

	it("shows the load in the footer while it runs, then clears it", async () => {
		let finishLoad!: () => void;
		stubOllama(
			new Promise<void>((resolve) => {
				finishLoad = resolve;
			}),
		);
		const { sessionStart, setStatus } = setup();

		sessionStart(gemma);
		await vi.waitFor(() =>
			expect(setStatus).toHaveBeenLastCalledWith("ollama-warm", "loading gemma4:26b…"),
		);
		finishLoad();

		await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("ollama-warm", undefined));
	});

	it("a failed load is quiet: no unhandled rejection, and the footer clears", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"error":"model not found"}', { status: 404 })),
		);
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		const { sessionStart, setStatus } = setup();

		sessionStart(gemma);
		await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("ollama-warm", undefined));
		await new Promise((r) => setTimeout(r, 20));
		process.off("unhandledRejection", unhandled);

		expect(unhandled).not.toHaveBeenCalled();
	});

	it("does nothing when switched off (OLLAMA_NATIVE_WARM=0)", async () => {
		const { fetchMock } = stubOllama();
		const { sessionStart, selectModel } = setup(undefined, { warm: false });

		sessionStart(gemma);
		selectModel(e4b);
		await new Promise((r) => setTimeout(r, 20));

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("warming the model - display is best-effort", () => {
	it("still loads, and stays quiet, when the footer can't be updated", async () => {
		const { bodies } = stubOllama();
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		const handlers = new Map<string, Handler>();
		registerWarmup(
			{ on: (event: string, handler: Handler) => handlers.set(event, handler) },
			settings,
			{ whenReady: async () => {} },
		);
		const ui = {
			setStatus: () => {
				throw new Error("no footer here");
			},
		};

		handlers.get("session_start")?.({ reason: "startup" }, { model: gemma, ui });
		await vi.waitFor(() => expect(bodies).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 20));
		process.off("unhandledRejection", unhandled);

		expect(unhandled).not.toHaveBeenCalled();
	});
});

describe("/ollama-warm-up", () => {
	it("Off saves the choice and stops future warm-ups", async () => {
		const { fetchMock } = stubOllama();
		const { warmUpCommand, sessionStart } = setup();

		await warmUpCommand("Off");
		sessionStart(gemma);
		await new Promise((r) => setTimeout(r, 20));

		expect(saved).toEqual({ warm: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("On saves the choice and warms the current model right away", async () => {
		const { bodies } = stubOllama();
		const { warmUpCommand } = setup(undefined, { warm: false });

		await warmUpCommand("On (default)", gemma);

		expect(saved).toEqual({ warm: true });
		await vi.waitFor(() => expect(bodies).toHaveLength(1));
		expect(bodies[0]!.model).toBe("gemma4:26b");
	});

	it("confirms the change, and cancelling changes nothing", async () => {
		stubOllama();
		const { warmUpCommand, notify } = setup();

		await warmUpCommand(undefined);
		expect(saved).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		await warmUpCommand("Off");
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/warm-up off/i), "info");
	});
});

describe("the Ollama-is-up signal", () => {
	it("releases waiters once marked, and stays marked", async () => {
		const ready = createReadySignal();
		let released = 0;
		void ready.whenReady().then(() => released++);
		await new Promise((r) => setTimeout(r, 5));
		expect(released).toBe(0);

		ready.markReady();
		ready.markReady();
		await ready.whenReady();
		await new Promise((r) => setTimeout(r, 5));

		expect(released).toBe(1);
	});
});
