import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";
import type { DiscoveredModel } from "../src/discovery.js";

// The config module is mocked so saved choices never touch the real ~/.pi file.
let saved: PersistedConfig | undefined;
let stored: PersistedConfig = {};
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => ({ ...stored }),
	savePersistedConfig: (c: PersistedConfig) => {
		saved = c;
	},
}));

const { registerAutostart } = await import("../src/autostart.js");
const { registerCommands } = await import("../src/commands.js");

type SessionStart = (event: { reason: string }, ctx: unknown) => Promise<void>;

/** What Node's fetch throws when nothing is listening on the port. */
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

const model = (id: string) => ({ id }) as DiscoveredModel;

interface Setup {
	answer?: string;
	failure?: unknown;
	baseUrl?: string;
	binary?: string;
	comesUp?: boolean;
}

function setup(opts: Setup = {}) {
	const {
		answer,
		baseUrl = "http://localhost:11434",
		binary = "/usr/local/bin/ollama",
		comesUp = true,
	} = opts;
	// Only absent means the default: an explicit undefined is "startup succeeded".
	const failure = "failure" in opts ? opts.failure : refused();
	let onStart: SessionStart | undefined;
	const pi = {
		on: (event: string, handler: SessionStart) => {
			if (event === "session_start") onStart = handler;
		},
	};
	const settings = {
		baseUrl,
		numCtx: 32768,
		ghostRetries: 2,
		throughput: true,
		apiKeyStatus: "none" as const,
	};
	const refresh = vi.fn(async () => [model("gemma4:26b"), model("gemma4:e4b")]);
	const launcher = {
		locate: vi.fn((): string | undefined => binary),
		launch: vi.fn(() => ({ stopHint: "Stop it with: kill 4242" })),
		waitUntilUp: vi.fn(async () => comesUp),
		logPath: "/home/me/.pi/agent/cache/pi-ollama-serve.log",
		manualHint: "Or start it yourself: ollama serve",
		description: "Start a background ollama serve?",
	};
	registerAutostart(pi, settings, { refresh, startupFailure: failure, launcher });
	const select = vi.fn(async () => answer);
	const notify = vi.fn();
	const start = (reason = "startup", hasUI = true) =>
		onStart?.({ reason }, { hasUI, ui: { select, notify } });
	/** Run /ollama-status against the same settings, with Ollama now answering. */
	const status = async () => {
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		registerCommands(
			{ registerCommand: (n: string, c: { handler: never }) => commands.set(n, c.handler) },
			settings,
			() => [],
			async () => [],
			() => undefined,
		);
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [] })));
		const statusNotify = vi.fn();
		await commands.get("ollama-status")?.("", { ui: { notify: statusNotify } });
		vi.unstubAllGlobals();
		return String(statusNotify.mock.calls[0]?.[0]);
	};
	return { refresh, launcher, select, notify, start, status };
}

afterEach(() => {
	saved = undefined;
	stored = {};
});

describe("offering to start Ollama when it isn't running", () => {
	it("on 'Start Ollama now', starts it, waits for it, and registers its models", async () => {
		const { refresh, launcher, select, notify, start } = setup({ answer: "Start Ollama now" });

		await start();

		expect(select).toHaveBeenCalledTimes(1);
		expect(launcher.launch).toHaveBeenCalledWith("/usr/local/bin/ollama");
		expect(launcher.waitUntilUp).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("2 model(s) registered"), "info");
	});

	it("tells the user how to stop what it started", async () => {
		const { notify, start } = setup({ answer: "Start Ollama now" });

		await start();

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Stop it with: kill 4242"), "info");
	});

	it("/ollama-status keeps saying how to stop what pi started", async () => {
		const { start, status } = setup({ answer: "Start Ollama now" });

		await start();

		expect(await status()).toContain("Started by pi at startup. Stop it with: kill 4242");
	});

	it("names the ways to start it yourself alongside the choices", async () => {
		const { select, start } = setup({ answer: "Not now" });

		await start();

		expect(select.mock.calls[0]![0]).toContain("Or start it yourself: ollama serve");
	});

	it("on 'Always start it automatically', remembers that and launches", async () => {
		stored = { keepAlive: "1h" };
		const { launcher, start } = setup({ answer: "Always start it automatically" });

		await start();

		expect(saved).toEqual({ keepAlive: "1h", autostart: "always" });
		expect(launcher.launch).toHaveBeenCalledTimes(1);
	});

	it("with 'always' saved, launches without asking", async () => {
		stored = { autostart: "always" };
		const { launcher, refresh, select, start } = setup();

		await start();

		expect(select).not.toHaveBeenCalled();
		expect(launcher.launch).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("on 'Never ask again', remembers that and doesn't launch", async () => {
		const { launcher, start } = setup({ answer: "Never ask again" });

		await start();

		expect(saved).toEqual({ autostart: "never" });
		expect(launcher.launch).not.toHaveBeenCalled();
	});

	it("offers 'Not now', which saves nothing and launches nothing", async () => {
		const { launcher, select, start } = setup({ answer: "Not now" });

		await start();

		expect(select.mock.calls[0]![1]).toContain("Not now");
		expect(saved).toBeUndefined();
		expect(launcher.launch).not.toHaveBeenCalled();
	});

	it("doesn't offer when Ollama is up but hung - a second server can't share its port", async () => {
		const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
		const { launcher, select, start } = setup({ answer: "Start Ollama now", failure: timedOut });

		await start();

		expect(select).not.toHaveBeenCalled();
		expect(launcher.launch).not.toHaveBeenCalled();
	});

	it.each(["http://jetson.tailnet:11434", "http://192.168.20.40:11434"])(
		"doesn't offer for a server on another machine (%s)",
		async (baseUrl) => {
			const { select, start } = setup({ answer: "Start Ollama now", baseUrl });

			await start();

			expect(select).not.toHaveBeenCalled();
		},
	);

	it.each([
		"http://localhost:11434",
		"http://127.0.0.1:11434",
		"http://[::1]:11434",
		"http://0.0.0.0:11434",
	])("offers for a server on this machine (%s)", async (baseUrl) => {
		const { select, start } = setup({ answer: "Not now", baseUrl });

		await start();

		expect(select).toHaveBeenCalledTimes(1);
	});

	it.each(["new", "resume", "fork", "reload"])(
		"offers only when pi starts, not on a %s session",
		async (reason) => {
			const { select, start } = setup({ answer: "Start Ollama now" });

			await start(reason);

			expect(select).not.toHaveBeenCalled();
		},
	);

	it("doesn't offer when there's no ollama binary to start", async () => {
		const { select, start } = setup({ answer: "Start Ollama now", binary: "" });

		await start();

		expect(select).not.toHaveBeenCalled();
	});

	it("doesn't offer when Ollama was reachable at startup", async () => {
		const { select, start } = setup({ answer: "Start Ollama now", failure: undefined });

		await start();

		expect(select).not.toHaveBeenCalled();
	});

	it("without a UI (rpc/print), doesn't ask and doesn't launch unless 'always' is saved", async () => {
		const { launcher, select, start } = setup({ answer: "Start Ollama now" });

		await start("startup", false);

		expect(select).not.toHaveBeenCalled();
		expect(launcher.launch).not.toHaveBeenCalled();
	});

	it("without a UI but with 'always' saved, launches (e.g. pi driven over rpc)", async () => {
		stored = { autostart: "always" };
		const { launcher, refresh, start } = setup();

		await start("startup", false);

		expect(launcher.launch).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("with 'never' saved, doesn't ask, just says how to turn the offer back on", async () => {
		stored = { autostart: "never" };
		const { launcher, select, notify, start } = setup();

		await start();

		expect(select).not.toHaveBeenCalled();
		expect(launcher.launch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![0]).toMatch(/"autostart".*pi-ollama-config\.json/);
	});

	it("says where to look when the server never comes up, and doesn't refresh", async () => {
		const { refresh, notify, start } = setup({ answer: "Start Ollama now", comesUp: false });

		await start();

		expect(refresh).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/home/me/.pi/agent/cache/pi-ollama-serve.log"),
			"error",
		);
	});

	it("reports, rather than throws, when discovery fails after the server starts", async () => {
		const { refresh, notify, start } = setup({ answer: "Start Ollama now" });
		refresh.mockRejectedValueOnce(new Error("Ollama /api/tags returned HTTP 500: boom"));

		await expect(start()).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("HTTP 500: boom"), "error");
	});
});
