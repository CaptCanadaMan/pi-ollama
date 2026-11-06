import { describe, expect, it } from "vitest";
import {
	checkAgainstModels,
	formatIssue,
	loadModelConfig,
	registerConfigReporting,
	reportConfigIssues,
} from "../src/model-config.js";

// Problems that need the environment or the discovered models, and how they reach pi.

describe("config issues - env overrides, discovery checks, reporting", () => {
	it("env var overridden by saved config warns once per var", () => {
		const { issues } = loadModelConfig(
			{ contextLength: 1024, defaults: { keepAlive: "5m" }, models: { a: { contextLength: 4096 }, b: { contextLength: 4096 } } },
			{ OLLAMA_CONTEXT_LENGTH: "8192", OLLAMA_KEEP_ALIVE: "10m", OLLAMA_NATIVE_WARM: "0" },
		);
		const env = issues.filter((i) => i.path.startsWith("OLLAMA_"));
		expect(env.map((i) => i.path)).toEqual(["OLLAMA_CONTEXT_LENGTH", "OLLAMA_KEEP_ALIVE"]);
		expect(env.every((i) => i.severity === "warning")).toBeTruthy();
		expect(env[0].message).toMatch(/=8192 is set but overridden by the config \(the top level, 2 model entries\)/);
		expect(env[1].message).toMatch(/\(defaults\)/);
	});

	it("an empty env var is not treated as set", () => {
		const { issues } = loadModelConfig({ contextLength: 1024 }, { OLLAMA_CONTEXT_LENGTH: "" });
		expect(issues).toEqual([]);
	});

	it("checkAgainstModels: unknown ids warn, unsupported explicit thinkingLevel errors", () => {
		const { config } = loadModelConfig(
			{ defaults: { thinkingLevel: "off" }, models: { "gpt-oss:latest": { thinkingLevel: "off" }, typo: {}, ok: { thinkingLevel: "low" } } },
			{},
		);
		const issues = checkAgainstModels(config, [
			{ id: "gpt-oss:latest", supportedLevels: ["low", "medium", "high"] },
			{ id: "ok", supportedLevels: ["off", "low"] },
		]);
		expect(issues.map((i) => [i.severity, i.path])).toEqual([
				["error", 'models["gpt-oss:latest"].thinkingLevel'],
				["warning", 'models["typo"]'],
			]);
		expect(issues[0].message).toMatch(/supported: low, medium, high/);
	});

	it("formatIssue", () => {
		expect(formatIssue({ severity: "error", path: "defaults.sampling.topP", message: "= 1.4 must be at most 1 - ignored" })).toBe("pi-ollama config: defaults.sampling.topP = 1.4 must be at most 1 - ignored");
	});

	it("reportConfigIssues notifies with the issue's severity", () => {
		const seen: [string, string][] = [];
		reportConfigIssues(
			[
				{ severity: "error", path: "a", message: "x" },
				{ severity: "warning", path: "b", message: "y" },
			],
			(m, t) => seen.push([m, t]),
		);
		expect(seen).toEqual([
			["pi-ollama config: a x", "error"],
			["pi-ollama config: b y", "warning"],
		]);
	});

	it("registerConfigReporting reports on startup only", () => {
		let handler: ((e: { reason?: string }, ctx: unknown) => void) | undefined;
		const pi = { on: (_event: "session_start", h: typeof handler) => { handler = h; } };
		registerConfigReporting(pi as never, () => [{ severity: "error", path: "p", message: "m" }]);
		const seen: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (m: string) => seen.push(m) } };
		handler?.({ reason: "new" }, ctx);
		expect(seen).toEqual([]);
		handler?.({ reason: "startup" }, ctx);
		expect(seen).toEqual(["pi-ollama config: p m"]);
	});
});
