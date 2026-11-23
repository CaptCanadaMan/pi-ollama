// Tests for models.json override loading (thinking-level maps)

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadModelsJsonOverrides } from "../src/models-json.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-models-json-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function writeModelsJson(content: string) {
	writeFileSync(join(agentDir, "models.json"), content, "utf8");
}

describe("loadModelsJsonOverrides — reads thinking-level maps from models.json", () => {
	it("returns empty object when file doesn't exist", () => {
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("returns empty object when file is empty", () => {
		writeModelsJson("{}");
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("extracts ollama modelOverrides", () => {
		writeModelsJson(JSON.stringify({
			providers: {
				ollama: {
					modelOverrides: {
						"qwen38": {
							thinkingLevelMap: { xhigh: "__default__" }
						}
					}
				}
			}
		}));
		expect(loadModelsJsonOverrides()).toEqual({
			"qwen38": { thinkingLevelMap: { xhigh: "__default__" } }
		});
	});

	it("ignores other providers", () => {
		writeModelsJson(JSON.stringify({
			providers: {
				openai: { modelOverrides: { "gpt-4": { thinkingLevelMap: { xhigh: "__default__" } } } },
				ollama: { modelOverrides: { "my-model": { thinkingLevelMap: { high: "high" } } } }
			}
		}));
		expect(loadModelsJsonOverrides()).toEqual({
			"my-model": { thinkingLevelMap: { high: "high" } }
		});
	});

	it("handles missing providers object", () => {
		writeModelsJson(JSON.stringify({}));
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("handles missing ollama provider", () => {
		writeModelsJson(JSON.stringify({ providers: {} }));
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("handles missing modelOverrides", () => {
		writeModelsJson(JSON.stringify({ providers: { ollama: {} } }));
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("strips block comments", () => {
		writeModelsJson(`{
			"providers": {
				"ollama": {
					"modelOverrides": {
						/* comment */ "m1": { "thinkingLevelMap": { "xhigh": "__default__" } }
					}
				}
			}
		}`);
		expect(loadModelsJsonOverrides()).toEqual({
			m1: { thinkingLevelMap: { xhigh: "__default__" } }
		});
	});

	it("strips line comments", () => {
		writeModelsJson(`{
			"providers": {
				"ollama": {
					"modelOverrides": {
						// comment
						"m1": { "thinkingLevelMap": { "xhigh": "__default__" } }
					}
				}
			}
		}`);
		expect(loadModelsJsonOverrides()).toEqual({
			m1: { thinkingLevelMap: { xhigh: "__default__" } }
		});
	});

	it("strips trailing commas", () => {
		writeModelsJson(`{
			"providers": {
				"ollama": {
					"modelOverrides": {
						"m1": { "thinkingLevelMap": { "xhigh": "__default__" } },
					}
				}
			}
		}`);
		expect(loadModelsJsonOverrides()).toEqual({
			m1: { thinkingLevelMap: { xhigh: "__default__" } }
		});
	});

	it("handles BOM", () => {
		// Write with BOM
		const content = JSON.stringify({
			providers: { ollama: { modelOverrides: { "m1": { thinkingLevelMap: {} } } } }
		});
		writeFileSync(join(agentDir, "models.json"), "\uFEFF" + content, "utf8");
		expect(loadModelsJsonOverrides()).toEqual({ m1: { thinkingLevelMap: {} } });
	});

	it("returns empty object on malformed JSON without throwing", () => {
		writeModelsJson("{ this is not valid json }");
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("returns empty object when providers is not an object", () => {
		writeModelsJson(JSON.stringify({ providers: "not an object" }));
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("returns empty object when modelOverrides is not an object", () => {
		writeModelsJson(JSON.stringify({ providers: { ollama: { modelOverrides: "not an object" } } }));
		expect(loadModelsJsonOverrides()).toEqual({});
	});

	it("supports multiple models", () => {
		writeModelsJson(JSON.stringify({
			providers: {
				ollama: {
					modelOverrides: {
						"model-a": { thinkingLevelMap: { xhigh: "__default__" } },
						"model-b": { thinkingLevelMap: { high: "high", max: "max" } }
					}
				}
			}
		}));
		expect(loadModelsJsonOverrides()).toEqual({
			"model-a": { thinkingLevelMap: { xhigh: "__default__" } },
			"model-b": { thinkingLevelMap: { high: "high", max: "max" } }
		});
	});

	it("uses PI_CODING_AGENT_DIR env var", () => {
		const otherDir = mkdtempSync(join(tmpdir(), "pi-ollama-models-json-other-"));
		mkdirSync(otherDir, { recursive: true });
		writeFileSync(join(otherDir, "models.json"), JSON.stringify({
			providers: { ollama: { modelOverrides: { "env-model": { thinkingLevelMap: {} } } } }
		}), "utf8");
		vi.stubEnv("PI_CODING_AGENT_DIR", otherDir);
		expect(loadModelsJsonOverrides()).toEqual({ "env-model": { thinkingLevelMap: {} } });
		rmSync(otherDir, { recursive: true, force: true });
	});
});