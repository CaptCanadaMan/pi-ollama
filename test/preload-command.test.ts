import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.js";
import { loadModelConfig } from "../src/model-config.js";
import type { OllamaExtensionSettings } from "../src/settings.js";

// /ollama-preload: one menu for when a model is loaded and when it is
// unloaded. Run against a real config file in a throwaway pi agent directory.

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

const PRELOAD_ROW = /^Preload on Select: /;
const IDLE_ROW = /^Idle Timeout: /;
const UNLOAD_ROW = /^Unload on Swap or Exit: /;

let agentDir: string;
const configFile = () => join(agentDir, "cache", "pi-ollama-config.json");
const savedConfig = () => JSON.parse(readFileSync(configFile(), "utf-8")) as Record<string, unknown>;
const writeRaw = (text: string) => {
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	writeFileSync(configFile(), text);
};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-preload-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

const freshSettings = (overrides: Partial<OllamaExtensionSettings> = {}): OllamaExtensionSettings => ({
	baseUrl: "http://ollama.test",
	numCtx: 32768,
	ghostRetries: 2,
	throughput: true,
	warm: true,
	apiKeyStatus: "none",
	...overrides,
});

/**
 * Open the menu and answer each picker in turn. An answer is a string to pick
 * exactly, or a pattern matching the option to pick. `typed` answers a text prompt.
 */
async function open(
	settings: OllamaExtensionSettings,
	answers: Array<string | RegExp>,
	{ typed, model }: { typed?: string; model?: { id: string } } = {},
) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (n: string, config: { handler: Handler }) => handlers.set(n, config.handler),
	};
	const preloadNow = vi.fn();
	registerCommands(pi, settings, () => [], async () => [], () => undefined, { preloadNow });
	const menus: Array<{ title: string; options: string[] }> = [];
	const notify = vi.fn();
	const select = async (title: string, options: string[]) => {
		menus.push({ title, options });
		const answer = answers.shift();
		if (answer === undefined) return undefined;
		return typeof answer === "string" ? answer : options.find((o) => answer.test(o));
	};
	await handlers.get("ollama-preload")?.("", {
		model,
		ui: { notify, select, input: async () => typed },
	});
	return {
		menus,
		notify,
		preloadNow,
		said: notify.mock.calls.map(([text]) => text as string),
		commandNames: [...handlers.keys()],
	};
}

describe("/ollama-preload - the first screen", () => {
	it("shows the three settings with their values, and their scope", async () => {
		const { menus } = await open(freshSettings(), []);

		expect(menus[0]).toEqual({
			title: "Model loading (global, persistent)",
			options: [
				"Preload on Select: on",
				"Idle Timeout: server default",
				"Unload on Swap or Exit: immediate",
			],
		});
	});

	it("states each saved value on its own row", async () => {
		const pinned = await open(freshSettings({ warm: false, keepAlive: -1, releaseAfter: "keep" }), []);
		const timed = await open(freshSettings({ keepAlive: "30m", releaseAfter: "5m" }), []);

		expect(pinned.menus[0]!.options).toEqual([
			"Preload on Select: off",
			"Idle Timeout: never sleep",
			"Unload on Swap or Exit: never unload",
		]);
		expect(timed.menus[0]!.options.slice(1)).toEqual([
			"Idle Timeout: 30m",
			"Unload on Swap or Exit: after 5m",
		]);
	});

	it("notes when the active model has per-model overrides in the config file", async () => {
		const { config: modelConfig } = loadModelConfig({ models: { "gemma4:12b": { releaseAfter: "keep" } } });
		const own = await open(freshSettings({ modelConfig }), [], { model: { id: "gemma4:12b" } });
		const plain = await open(freshSettings({ modelConfig }), [], { model: { id: "gemma4:e4b" } });

		expect(own.menus[0]!.title).toBe("Model loading (global, persistent; gemma4:12b has per-model overrides)");
		expect(plain.menus[0]!.title).toBe("Model loading (global, persistent)");
	});

	it("changes nothing when dismissed", async () => {
		const { notify } = await open(freshSettings(), []);

		expect(notify).not.toHaveBeenCalled();
	});

	it("replaces the old commands: /ollama-keep-alive and /ollama-warm-up are gone", async () => {
		const { commandNames } = await open(freshSettings(), []);

		expect(commandNames).toContain("ollama-preload");
		expect(commandNames).not.toContain("ollama-keep-alive");
		expect(commandNames).not.toContain("ollama-warm-up");
		expect(commandNames).not.toContain("ollama-release");
	});
});

describe("/ollama-preload - Preload on Select", () => {
	it("offers on and off", async () => {
		const { menus } = await open(freshSettings(), [PRELOAD_ROW]);

		expect(menus[1]).toEqual({
			title: "Preload on Select - load the model when a session starts or a model is selected",
			options: ["On (default)", "Off"],
		});
	});

	it("off is saved and nothing is preloaded", async () => {
		const settings = freshSettings();

		const { said, preloadNow } = await open(settings, [PRELOAD_ROW, "Off"]);

		expect(settings.warm).toBe(false);
		expect(savedConfig()).toEqual({ warm: false });
		expect(said).toEqual(["Preload on Select: off. Global, persistent."]);
		expect(preloadNow).not.toHaveBeenCalled();
	});

	it("on is saved and the active model is preloaded right away", async () => {
		const settings = freshSettings({ warm: false });

		const { said, preloadNow } = await open(settings, [PRELOAD_ROW, "On (default)"]);

		expect(settings.warm).toBe(true);
		expect(savedConfig()).toEqual({ warm: true });
		expect(said).toEqual(["Preload on Select: on. Global, persistent."]);
		expect(preloadNow).toHaveBeenCalledTimes(1);
	});
});

describe("/ollama-preload - Idle Timeout", () => {
	it("offers the server default, never sleep, presets and a custom value", async () => {
		const { menus } = await open(freshSettings(), [IDLE_ROW]);

		expect(menus[1]).toEqual({
			title: "Idle Timeout - time since the last request to the active model",
			options: ["Server default (OLLAMA_KEEP_ALIVE)", "Never sleep", "5m", "30m", "1h", "Custom"],
		});
	});

	it("saves a preset, keeps hand-written per-model settings, and confirms in one line", async () => {
		writeRaw('{ "models": { "gemma4:12b": { "warm": false } } }');
		const settings = freshSettings();

		const { said } = await open(settings, [IDLE_ROW, "30m"]);

		expect(settings.keepAlive).toBe("30m");
		expect(savedConfig()).toEqual({ keepAlive: "30m", models: { "gemma4:12b": { warm: false } } });
		expect(said).toEqual(["Idle Timeout: 30m. Global, persistent. Overrides OLLAMA_KEEP_ALIVE."]);
	});

	it("saves never sleep as keep_alive -1", async () => {
		const settings = freshSettings();

		const { said } = await open(settings, [IDLE_ROW, "Never sleep"]);

		expect(settings.keepAlive).toBe(-1);
		expect(savedConfig()).toEqual({ keepAlive: -1 });
		expect(said).toEqual(["Idle Timeout: never sleep. Global, persistent. Overrides OLLAMA_KEEP_ALIVE."]);
	});

	it("server default removes the override", async () => {
		writeRaw('{ "keepAlive": -1 }');
		const settings = freshSettings({ keepAlive: -1 });

		const { said } = await open(settings, [IDLE_ROW, "Server default (OLLAMA_KEEP_ALIVE)"]);

		expect(settings.keepAlive).toBeUndefined();
		expect(savedConfig()).toEqual({});
		expect(said).toEqual(["Idle Timeout: server default. Global, persistent."]);
	});

	it("accepts a custom duration and rejects an invalid one", async () => {
		const settings = freshSettings();

		await open(settings, [IDLE_ROW, "Custom"], { typed: "1h30m" });
		const bad = await open(settings, [IDLE_ROW, "Custom"], { typed: "soon" });

		expect(settings.keepAlive).toBe("1h30m");
		expect(bad.notify.mock.calls[0]).toEqual([
			'Not changed: "soon" is not a valid duration. Use a duration such as "10m" or "1h30m", or whole seconds.',
			"error",
		]);
		expect(settings.keepAlive).toBe("1h30m");
	});

	it("changes nothing, and says why, when the config file can't be read", async () => {
		const broken = '{ "models": { "gemma4:12b": { "warm": false }, } }';
		writeRaw(broken);
		const settings = freshSettings();

		const { said, notify } = await open(settings, [IDLE_ROW, "30m"]);

		expect(notify.mock.calls[0]?.[1]).toBe("error");
		expect(said[0]).toMatch(/^Not changed: pi-ollama-config\.json couldn't be read/);
		expect(settings.keepAlive).toBeUndefined();
		expect(readFileSync(configFile(), "utf-8")).toBe(broken);
	});
});

describe("/ollama-preload - Unload on Swap or Exit", () => {
	it("offers immediate, presets, never unload and a custom value", async () => {
		const { menus } = await open(freshSettings(), [UNLOAD_ROW]);

		expect(menus[1]).toEqual({
			title: "Unload on Swap or Exit - time since the model was deselected",
			options: ["Immediate (default)", "After 5m", "After 30m", "Never unload", "Custom"],
		});
	});

	it("saves a preset", async () => {
		const settings = freshSettings();

		const { said } = await open(settings, [UNLOAD_ROW, "After 5m"]);

		expect(settings.releaseAfter).toBe("5m");
		expect(savedConfig()).toEqual({ releaseAfter: "5m" });
		expect(said).toEqual(["Unload on Swap or Exit: after 5m. Global, persistent."]);
	});

	it("saves never unload as an explicit value, since immediate is the default", async () => {
		const settings = freshSettings();

		const { said } = await open(settings, [UNLOAD_ROW, "Never unload"]);

		expect(settings.releaseAfter).toBe("keep");
		expect(savedConfig()).toEqual({ releaseAfter: "keep" });
		expect(said).toEqual(["Unload on Swap or Exit: never unload. Global, persistent."]);
	});

	it("immediate removes the saved value", async () => {
		writeRaw('{ "releaseAfter": "keep" }');
		const settings = freshSettings({ releaseAfter: "keep" });

		await open(settings, [UNLOAD_ROW, "Immediate (default)"]);

		expect(settings.releaseAfter).toBeUndefined();
		expect(savedConfig()).toEqual({});
	});

	it("accepts a custom duration and rejects an invalid one", async () => {
		const settings = freshSettings();

		await open(settings, [UNLOAD_ROW, "Custom"], { typed: "45m" });
		const bad = await open(settings, [UNLOAD_ROW, "Custom"], { typed: "-1" });

		expect(settings.releaseAfter).toBe("45m");
		expect(bad.notify.mock.calls[0]?.[1]).toBe("error");
		expect(settings.releaseAfter).toBe("45m");
	});
});
