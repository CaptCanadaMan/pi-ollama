import { describe, expect, it } from "vitest";
import {
	checkGlobalValue,
	globalValue,
	loadModelConfig,
	REQUEST_DEFAULTS,
	resolveModelConfig,
	resolveServerUrl,
	serverBaseUrl,
	setGlobalSetting,
	toOllamaOptions,
} from "../src/model-config.js";

// One model's effective settings: models[id] > defaults > top level / env > built-in.

const cfg = (raw: unknown) => loadModelConfig(raw, {}).config;

describe("resolveModelConfig - layers, wire options, servers", () => {
	it("precedence: model > defaults > fallback (top level/env) > built-in", () => {
		const config = cfg({
			defaults: { contextLength: 16384, keepAlive: "10m", warm: false },
			models: { a: { contextLength: 65536 } },
		});
		const fallback = { contextLength: 8192, keepAlive: "1m", warm: true };
		const a = resolveModelConfig(config, fallback, "a");
		expect(a.contextLength).toBe(65536);
		expect(a.keepAlive).toBe("10m");
		expect(a.warm).toBe(false);
		const b = resolveModelConfig(config, fallback, "b");
		expect(b.contextLength).toBe(16384);
		const none = resolveModelConfig(cfg({}), fallback, "b");
		expect(none.contextLength).toBe(8192);
		expect(none.keepAlive).toBe("1m");
		const builtIn = resolveModelConfig(cfg({}), {}, "b");
		expect(builtIn.contextLength).toBe(undefined);
		expect(builtIn.keepAlive).toBe(undefined);
		expect(builtIn.warm).toBe(true);
		expect(builtIn.request).toEqual(REQUEST_DEFAULTS);
	});

	it("top-level non-fallback keys sit under defaults", () => {
		const config = cfg({ maxTokens: 100, thinkingLevel: "high", defaults: { thinkingLevel: "low" } });
		const r = resolveModelConfig(config, {}, "x");
		expect(r.maxTokens).toBe(100);
		expect(r.thinkingLevel).toBe("low");
	});

	it("sections merge key by key across layers", () => {
		const config = cfg({
			sampling: { seed: 1 },
			defaults: { sampling: { topK: 40, topP: 0.9 }, request: { maxRetries: 0 } },
			models: { a: { sampling: { topP: 0.95 }, request: { logprobs: true } } },
		});
		const r = resolveModelConfig(config, {}, "a");
		expect(r.sampling).toEqual({ seed: 1, topK: 40, topP: 0.95 });
		expect(r.request).toEqual({ idleTimeoutMs: 240000, maxRetries: 0, logprobs: true });
	});

	it("undefined config or model id resolves to built-ins plus fallback", () => {
		const r = resolveModelConfig(undefined, { contextLength: 4096 }, undefined);
		expect(r.contextLength).toBe(4096);
		expect(r.sampling).toEqual({});
	});

	it("prototype names never resolve to prototype properties", () => {
		const config = cfg(JSON.parse('{"models":{"constructor":{"contextLength":4096}}}'));
		expect(resolveModelConfig(config, {}, "constructor").contextLength).toBe(4096);
		expect(resolveModelConfig(config, {}, "toString").contextLength).toBe(undefined);
		expect(resolveModelConfig(config, {}, "__proto__").contextLength).toBe(undefined);
	});

	it("toOllamaOptions maps camelCase to Ollama names and skips unset", () => {
		const opts = toOllamaOptions({
			sampling: { topP: 0.9, repeatLastN: 64, stop: ["x"], numKeep: 4 },
			gpu: { numGpu: 99, mainGpu: 0, useMmap: false },
		});
		expect(opts).toEqual({ top_p: 0.9, repeat_last_n: 64, stop: ["x"], num_keep: 4, num_gpu: 99, main_gpu: 0, use_mmap: false });
		expect(toOllamaOptions({ sampling: {}, gpu: {} })).toEqual({});
	});

	it("serverBaseUrl adds scheme and default port only when missing", () => {
		expect(serverBaseUrl({ host: "100.64.0.5" })).toBe("http://100.64.0.5:11434");
		expect(serverBaseUrl({ host: "100.64.0.5", port: 11435 })).toBe("http://100.64.0.5:11435");
		expect(serverBaseUrl({ host: "box:1234" })).toBe("http://box:1234");
		expect(serverBaseUrl({ host: "box:1234", port: 99 })).toBe("http://box:99");
		expect(serverBaseUrl({ host: "https://ollama.example.com/" })).toBe("https://ollama.example.com");
		expect(serverBaseUrl({ host: "https://ollama.example.com", port: 8443 })).toBe("https://ollama.example.com:8443");
	});

	it("resolveServerUrl", () => {
		const config = cfg({ servers: { f: { host: "h" } } });
		expect(resolveServerUrl(config, "f")).toBe("http://h:11434");
		expect(resolveServerUrl(config, undefined)).toBe(undefined);
		expect(resolveServerUrl(config, "nope")).toBe(undefined);
	});

	it("globalValue prefers defaults over the fallback", () => {
		const config = cfg({ defaults: { warm: false } });
		expect(globalValue(config, { warm: true }, "warm")).toBe(false);
		expect(globalValue(cfg({}), { contextLength: 5 }, "contextLength")).toBe(5);
	});

	it("setGlobalSetting writes to defaults only when it's an object", () => {
		const withDefaults: Record<string, unknown> = { defaults: { warm: true }, contextLength: 1 };
		expect(setGlobalSetting(withDefaults, "contextLength", 2048)).toBe("defaults");
		expect(withDefaults).toEqual({ defaults: { warm: true, contextLength: 2048 }, contextLength: 1 });
		expect(setGlobalSetting(withDefaults, "warm", undefined)).toBe("defaults");
		expect(withDefaults.defaults).toEqual({ contextLength: 2048 });

		for (const odd of [null, [1], "x"]) {
			const file: Record<string, unknown> = { defaults: odd };
			expect(setGlobalSetting(file, "keepAlive", "5m")).toBe("top level");
			expect(file.keepAlive).toBe("5m");
		}
		const plain: Record<string, unknown> = { keepAlive: "5m" };
		expect(setGlobalSetting(plain, "keepAlive", undefined)).toBe("top level");
		expect(plain).toEqual({});
	});

	it("checkGlobalValue applies the schema's own rule (slash commands use it)", () => {
		expect(checkGlobalValue("contextLength", 4096)).toBe(undefined);
		expect(checkGlobalValue("contextLength", 200) ?? "").toMatch(/at least 256/);
		expect(checkGlobalValue("keepAlive", "30m")).toBe(undefined);
		expect(checkGlobalValue("keepAlive", "soon") ?? "").toMatch(/duration/);
		expect(checkGlobalValue("warm", "yes") ?? "").toMatch(/true or false/);
	});
});
