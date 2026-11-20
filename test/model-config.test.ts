import { describe, expect, it } from "vitest";
import { formatIssue, loadModelConfig, resolveModelSettings } from "../src/model-config.js";

// Per-model settings in pi-ollama-config.json (GH-14). The file is hand-edited,
// so everything in it is checked before use and every problem is reported.

describe("loadModelConfig", () => {
	it("reads per-model keepAlive and warm", () => {
		const { config, issues } = loadModelConfig({
			models: {
				"gemma4:12b": { keepAlive: -1, warm: true },
				"muse-glimmer:30b": { keepAlive: "30m", warm: false },
			},
		});

		expect(issues).toEqual([]);
		expect(config.models["gemma4:12b"]).toEqual({ keepAlive: -1, warm: true });
		expect(config.models["muse-glimmer:30b"]).toEqual({ keepAlive: "30m", warm: false });
	});

	it("is empty, without complaint, for a file with no models block", () => {
		expect(loadModelConfig({ contextLength: 65536, warm: false })).toEqual({
			config: { models: {} },
			issues: [],
		});
		expect(loadModelConfig(undefined).issues).toEqual([]);
	});

	it("drops an invalid value and says where and why", () => {
		const { config, issues } = loadModelConfig({
			models: { "gemma4:12b": { keepAlive: "banana", warm: "yes" } },
		});

		expect(config.models["gemma4:12b"]).toEqual({});
		expect(issues.map(formatIssue)).toEqual([
			'pi-ollama config: models["gemma4:12b"].keepAlive = "banana" must be a duration like "30m" / "1h30m" or a whole number of seconds (-1 = keep loaded) - ignored',
			'pi-ollama config: models["gemma4:12b"].warm = "yes" must be true or false - ignored',
		]);
		expect(issues.every((i) => i.severity === "error")).toBe(true);
	});

	it("warns about a setting it doesn't know, and keeps the rest of the entry", () => {
		const { config, issues } = loadModelConfig({
			models: { "gemma4:12b": { warm: false, colour: "blue" } },
		});

		expect(config.models["gemma4:12b"]).toEqual({ warm: false });
		expect(issues).toEqual([
			{
				severity: "warning",
				path: 'models["gemma4:12b"].colour',
				message: "is not a known setting - ignored",
			},
		]);
	});

	it("points per-model context and output limits at pi's own models.json", () => {
		const { issues } = loadModelConfig({
			models: { "gemma4:12b": { contextLength: 65536, maxTokens: 4096 } },
		});

		expect(issues.map((i) => i.message)).toEqual([
			'is not set here - use modelOverrides in pi\'s models.json ("contextWindow") - ignored',
			'is not set here - use modelOverrides in pi\'s models.json ("maxTokens") - ignored',
		]);
	});

	it("points sampling and GPU options at an Ollama Modelfile", () => {
		const { issues } = loadModelConfig({
			models: { "gemma4:12b": { sampling: { topP: 0.9 }, gpu: { numGpu: 99 } } },
		});

		expect(issues.map((i) => i.message)).toEqual([
			"is not set here - use PARAMETER lines in an Ollama Modelfile - ignored",
			"is not set here - use PARAMETER lines in an Ollama Modelfile - ignored",
		]);
	});

	it("rejects a models block or an entry that isn't an object", () => {
		expect(loadModelConfig({ models: ["gemma4:12b"] }).issues).toEqual([
			{ severity: "error", path: "models", message: '= ["gemma4:12b"] must be an object - ignored' },
		]);
		const { config, issues } = loadModelConfig({ models: { "gemma4:12b": true } });
		expect(config.models).toEqual({});
		expect(issues[0]?.path).toBe('models["gemma4:12b"]');
	});

	it("treats keys starting with an underscore as comments", () => {
		const { config, issues } = loadModelConfig({
			models: { _note: "robot models", "gemma4:12b": { _why: "onboard", warm: false } },
		});

		expect(issues).toEqual([]);
		expect(Object.keys(config.models)).toEqual(["gemma4:12b"]);
		expect(config.models["gemma4:12b"]).toEqual({ warm: false });
	});

	it("keeps a model id that collides with an Object property as a plain entry", () => {
		// "__proto__" starts with an underscore, so it is a comment like any other.
		const raw = JSON.parse('{"models":{"__proto__":{"warm":false},"toString":{"warm":false}}}');
		const { config } = loadModelConfig(raw);

		expect(Object.keys(config.models)).toEqual(["toString"]);
		expect(resolveModelSettings(config, { warm: true }, "toString").warm).toBe(false);
		expect(resolveModelSettings(config, { warm: true }, "constructor").warm).toBe(true);
		expect(resolveModelSettings(config, { warm: true }, "__proto__").warm).toBe(true);
	});
});

describe("resolveModelSettings", () => {
	const { config } = loadModelConfig({
		models: { "gemma4:12b": { keepAlive: -1 }, "muse-glimmer:30b": { warm: false } },
	});

	it("uses the model's own value where it has one, the global one otherwise", () => {
		const global = { keepAlive: "5m", warm: true };
		expect(resolveModelSettings(config, global, "gemma4:12b")).toEqual({ keepAlive: -1, warm: true });
		expect(resolveModelSettings(config, global, "muse-glimmer:30b")).toEqual({
			keepAlive: "5m",
			warm: false,
		});
		expect(resolveModelSettings(config, global, "gemma4:e4b")).toEqual(global);
	});

	it("leaves keepAlive unset when neither layer sets it, so the server decides", () => {
		const resolved = resolveModelSettings(config, { warm: true }, "muse-glimmer:30b");
		expect(resolved.keepAlive).toBeUndefined();
	});

	it("works without a config at all", () => {
		expect(resolveModelSettings(undefined, { keepAlive: "5m", warm: false }, "gemma4:12b")).toEqual({
			keepAlive: "5m",
			warm: false,
		});
	});
});
