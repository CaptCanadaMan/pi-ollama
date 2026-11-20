import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredModel } from "../src/discovery.js";
import { loadModelConfig } from "../src/model-config.js";
import { registerThinkingDefault, thinkingLevelIssues } from "../src/thinking-default.js";
import { settings } from "./fixtures.js";

// A model's own thinking level in the config file (GH-14): the level that
// loads when that model becomes the active one, so switching between models
// restores each one's level in a single step. It is a default, applied once
// per activation - anything else that sets a level (the user, or another
// extension such as pi-persona) is an explicit choice and is left alone.

type Handler = (event: unknown, ctx: unknown) => unknown;

const model = (id: string, extra: object = {}) => ({
	id,
	api: "ollama-native",
	provider: "ollama",
	reasoning: true,
	...extra,
});
const big = model("muse-glimmer:30b", { thinkingLevelMap: { xhigh: null, max: "max" } });
const small = model("gemma4:e4b", { thinkingLevelMap: { minimal: null, low: null, high: null } });
const plain = model("llama3.1:8b", { reasoning: false });
const claude = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "anthropic", reasoning: true };

const config = (models: object) => loadModelConfig({ models }).config;

/**
 * A stand-in for pi: it holds the current level, and setThinkingLevel emits
 * thinking_level_select the way pi does.
 */
function fakePi(start: string, modelConfig: ReturnType<typeof config>, { legacy = false } = {}) {
	const handlers = new Map<string, Handler[]>();
	const state = { level: start, sets: [] as string[] };
	const emit = (event: string, payload: object, ctx: object = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const setThinkingLevel = (level: string) => {
		const previousLevel = state.level;
		state.level = level;
		state.sets.push(level);
		if (level !== previousLevel) emit("thinking_level_select", { level, previousLevel });
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		...(legacy ? {} : { setThinkingLevel, getThinkingLevel: () => state.level }),
	};
	registerThinkingDefault(pi, { ...settings, modelConfig });
	return {
		state,
		/** The user, or another extension, sets a level. */
		someoneSets: setThinkingLevel,
		/** pi switches model: it clamps the level first if the new model needs it, then announces the switch. */
		selectModel: (m: object, clampTo?: string) => {
			if (clampTo !== undefined) setThinkingLevel(clampTo);
			emit("model_select", { model: m }, { model: m });
		},
		sessionStart: (reason: string, m: object) => emit("session_start", { reason }, { model: m }),
	};
}

describe("a model's own thinking level", () => {
	const modelConfig = config({
		"muse-glimmer:30b": { thinkingLevel: "high" },
		"gemma4:e4b": { thinkingLevel: "off" },
	});

	it("loads when that model is selected", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(big);

		expect(pi.state.level).toBe("high");
	});

	it("restores each model's level when switching back and forth", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(big);
		pi.selectModel(small);
		const atSmall = pi.state.level;
		pi.selectModel(big);

		expect([atSmall, pi.state.level]).toEqual(["off", "high"]);
	});

	it("loads again after the user changed the level by hand and then switched away and back", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(big);
		pi.someoneSets("low");
		pi.selectModel(small);
		pi.selectModel(big);

		expect(pi.state.level).toBe("high");
	});

	it("applies to the model a new session starts on", () => {
		const startup = fakePi("medium", modelConfig);
		const fresh = fakePi("medium", modelConfig);

		startup.sessionStart("startup", big);
		fresh.sessionStart("new", small);

		expect([startup.state.level, fresh.state.level]).toEqual(["high", "off"]);
	});

	it("leaves a resumed, forked or reloaded session's own level alone", () => {
		const pi = fakePi("low", modelConfig);

		pi.sessionStart("resume", big);
		pi.sessionStart("fork", big);
		pi.sessionStart("reload", big);

		expect(pi.state.sets).toEqual([]);
	});

	it("doesn't touch the level for a model with no entry, or one that isn't an Ollama model", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(model("gemma4:12b"));
		pi.selectModel(claude);

		expect(pi.state.sets).toEqual([]);
	});

	it("sets nothing when the level is already the one wanted", () => {
		const pi = fakePi("high", modelConfig);

		pi.selectModel(big);

		expect(pi.state.sets).toEqual([]);
	});

	it("does nothing on a pi too old to set the level", () => {
		const pi = fakePi("medium", modelConfig, { legacy: true });

		expect(() => pi.selectModel(big)).not.toThrow();
		expect(pi.state.level).toBe("medium");
	});

	it("is not applied when the model doesn't support that level", () => {
		const pi = fakePi("medium", config({ "gemma4:e4b": { thinkingLevel: "high" }, "llama3.1:8b": { thinkingLevel: "low" } }));

		pi.selectModel(small);
		pi.selectModel(plain);

		expect(pi.state.sets).toEqual([]);
	});
});

describe("alongside something else that sets the level", () => {
	const modelConfig = config({ "muse-glimmer:30b": { thinkingLevel: "high" } });

	it("an extension that switches model and then sets a level keeps its level", () => {
		const pi = fakePi("medium", modelConfig);

		// What pi-persona does for a preset that names a level.
		pi.selectModel(big);
		pi.someoneSets("low");

		expect(pi.state.level).toBe("low");
	});

	it("an extension that switches model without naming a level gets this model's own", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(big);

		expect(pi.state.level).toBe("high");
	});

	it("a level set earlier in session start is left alone, whichever extension ran first", () => {
		const pi = fakePi("medium", modelConfig);

		// Another extension's session_start handler ran before ours and chose a level.
		pi.someoneSets("low");
		pi.sessionStart("startup", big);

		expect(pi.state.level).toBe("low");
	});

	it("a level set at session start by a model switch plus a level is left alone too", () => {
		const pi = fakePi("medium", modelConfig);

		pi.selectModel(big);
		pi.someoneSets("minimal");
		pi.sessionStart("startup", big);

		expect(pi.state.level).toBe("minimal");
	});

	it("pi clamping the level during a switch doesn't count as someone choosing it", () => {
		const pi = fakePi("xhigh", modelConfig);

		// big doesn't support xhigh, so pi clamps to high... say medium, then announces the switch.
		pi.selectModel(big, "medium");

		expect(pi.state.level).toBe("high");
	});
});

describe("checking configured levels against the models found", () => {
	it("reports a level the model doesn't support, and one that isn't a level at all", () => {
		const loaded = loadModelConfig({
			models: {
				"gemma4:e4b": { thinkingLevel: "high" },
				"muse-glimmer:30b": { thinkingLevel: "max" },
				"llama3.1:8b": { thinkingLevel: "extreme" },
			},
		});

		expect(loaded.issues).toEqual([
			{
				severity: "error",
				path: 'models["llama3.1:8b"].thinkingLevel',
				message: '= "extreme" must be one of off, minimal, low, medium, high, xhigh, max - ignored',
			},
		]);
		expect(
			thinkingLevelIssues(loaded.config, [
				{ id: "gemma4:e4b", reasoning: true, thinkingLevelMap: { minimal: null, low: null, high: null } },
				{ id: "muse-glimmer:30b", reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } },
			]),
		).toEqual([
			{
				severity: "error",
				path: 'models["gemma4:e4b"].thinkingLevel',
				message: '= "high" is not a level this model supports (off, medium) - not applied',
			},
		]);
	});

	it("has nothing to say about a model that wasn't found: it may simply not be pulled yet", () => {
		const { config: c } = loadModelConfig({ models: { "not-here:7b": { thinkingLevel: "high" } } });

		expect(thinkingLevelIssues(c, [])).toEqual([]);
	});
});

describe("/ollama-think", () => {
	// Against a real config file in a throwaway pi agent directory.
	let agentDir: string;
	const configFile = () => join(agentDir, "pi-ollama.json");
	const savedConfig = () => JSON.parse(readFileSync(configFile(), "utf-8")) as Record<string, unknown>;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-think-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const discovered = (id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
		id,
		name: id,
		tools: true,
		vision: false,
		reasoning: true,
		contextWindow: 32768,
		maxTokens: 8192,
		...extra,
	});
	// Ollama reports glimmer's own levels; e4b only switches thinking on or off.
	const found = [
		discovered("muse-glimmer:30b", { thinking: { values: [false, "low", "medium", "high", "max"] } }),
		discovered("gemma4:e4b", { thinking: { values: [false, true] } }),
		discovered("llama3.1:8b", { reasoning: false }),
	];

	/** Open the command and answer each picker in turn (a string, or a pattern matching an option). */
	async function open(answers: Array<string | RegExp>, active: object | undefined, startLevel = "medium") {
		const handlers = new Map<string, Handler[]>();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const state = { level: startLevel, sets: [] as string[] };
		const live = { ...settings, modelConfig: loadModelConfig(existingConfig()).config };
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerCommand: (name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				if (name === "ollama-think") command = config.handler;
			},
			setThinkingLevel: (level: string) => {
				state.level = level;
				state.sets.push(level);
			},
			getThinkingLevel: () => state.level,
		};
		registerThinkingDefault(pi, live, () => found);
		const menus: Array<{ title: string; options: string[] }> = [];
		const notify = vi.fn();
		await command?.("", {
			model: active,
			ui: {
				notify,
				select: async (title: string, options: string[]) => {
					menus.push({ title, options });
					const answer = answers.shift();
					if (answer === undefined) return undefined;
					return typeof answer === "string" ? answer : options.find((o) => answer.test(o));
				},
			},
		});
		return { menus, notify, state, live, said: notify.mock.calls.map(([text]) => text as string) };
	}
	const existingConfig = (): unknown => {
		try {
			return savedConfig();
		} catch {
			return {};
		}
	};

	it("offers the active model's own levels, as Ollama reports them", async () => {
		const glimmer = await open([], model("muse-glimmer:30b"));
		const e4b = await open([], model("gemma4:e4b"));

		expect(glimmer.menus[0]).toEqual({
			title: "Thinking level: muse-glimmer:30b (per-model, persistent) - not set",
			options: ["off", "low", "medium", "high", "max", "Not set", "Other model"],
		});
		expect(e4b.menus[0]!.options).toEqual(["off", "medium", "Not set", "Other model"]);
	});

	it("saves the level for that model and applies it at once", async () => {
		const { state, live, said } = await open(["high"], model("muse-glimmer:30b"));

		expect(savedConfig()).toEqual({ models: { "muse-glimmer:30b": { thinkingLevel: "high" } } });
		expect(live.modelConfig.models["muse-glimmer:30b"]?.thinkingLevel).toBe("high");
		expect(state.level).toBe("high");
		expect(said).toEqual(["Thinking level: muse-glimmer:30b = high. Per-model, persistent."]);
	});

	it("keeps the model's other settings, and everything else in the file", async () => {
		writeFileSync(
			configFile(),
			JSON.stringify({ keepAlive: -1, models: { "gemma4:e4b": { warm: false }, "gemma4:12b": { releaseAfter: "keep" } } }),
		);

		await open(["off"], model("gemma4:e4b"));

		expect(savedConfig()).toEqual({
			keepAlive: -1,
			models: { "gemma4:e4b": { warm: false, thinkingLevel: "off" }, "gemma4:12b": { releaseAfter: "keep" } },
		});
	});

	it("shows the saved level, and Not set removes it without touching pi's level", async () => {
		writeFileSync(configFile(), JSON.stringify({ models: { "gemma4:e4b": { thinkingLevel: "off", warm: false } } }));

		const { menus, state, said } = await open(["Not set"], model("gemma4:e4b"));

		expect(menus[0]!.title).toBe("Thinking level: gemma4:e4b (per-model, persistent) - off");
		expect(savedConfig()).toEqual({ models: { "gemma4:e4b": { warm: false } } });
		expect(state.sets).toEqual([]);
		expect(said).toEqual(["Thinking level: gemma4:e4b not set. pi's level applies."]);
	});

	it("removes a model's entry altogether once nothing is left in it", async () => {
		writeFileSync(configFile(), JSON.stringify({ models: { "gemma4:e4b": { thinkingLevel: "off" } } }));

		await open(["Not set"], model("gemma4:e4b"));

		expect(savedConfig()).toEqual({});
	});

	it("can set a level for a model other than the active one, without changing the active level", async () => {
		const { menus, state } = await open(["Other model", "gemma4:e4b", "off"], model("muse-glimmer:30b"));

		expect(menus[1]).toEqual({
			title: "Thinking level - choose a model",
			options: ["muse-glimmer:30b", "gemma4:e4b"],
		});
		expect(menus[2]!.title).toBe("Thinking level: gemma4:e4b (per-model, persistent) - not set");
		expect(savedConfig()).toEqual({ models: { "gemma4:e4b": { thinkingLevel: "off" } } });
		expect(state.sets).toEqual([]);
	});

	it("asks which model when the active one isn't an Ollama model that can think", async () => {
		const none = await open([], undefined);
		const cloud = await open([], claude);
		const noThinking = await open([], model("llama3.1:8b", { reasoning: false }));

		for (const { menus } of [none, cloud, noThinking]) {
			expect(menus[0]!.title).toBe("Thinking level - choose a model");
			expect(menus[0]!.options).toEqual(["muse-glimmer:30b", "gemma4:e4b"]);
		}
	});

	it("changes nothing when dismissed, or when the config file can't be read", async () => {
		const dismissed = await open([], model("gemma4:e4b"));
		const broken = '{ "models": { }, }';
		writeFileSync(configFile(), broken);
		const refused = await open(["off"], model("gemma4:e4b"));

		expect(dismissed.notify).not.toHaveBeenCalled();
		expect(refused.said[0]).toMatch(/^Not changed: pi-ollama\.json couldn't be read/);
		expect(refused.state.sets).toEqual([]);
		expect(readFileSync(configFile(), "utf-8")).toBe(broken);
	});
});

