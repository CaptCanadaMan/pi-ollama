import { describe, expect, it } from "vitest";
import { loadModelConfig } from "../src/model-config.js";

// The per-model config file is hand-edited, so every value is validated before
// use: invalid values are errors and fall through, unknown keys are warnings.

const NO_ENV = {};
const load = (raw: unknown) => loadModelConfig(raw, NO_ENV);
const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe("loadModelConfig - validating the config file", () => {
	it("empty or missing file gives an empty config and no issues", () => {
		for (const raw of [undefined, null, {}]) {
			const { config, issues } = load(raw);
			expect(config.defaults).toEqual({});
			expect(config.topLevel).toEqual({});
			expect({ ...config.models }).toEqual({});
			expect({ ...config.servers }).toEqual({});
			expect(issues).toEqual([]);
		}
	});

	it("a non-object file is one error", () => {
		const { issues } = load([1, 2]);
		expect(issues.length).toBe(1);
		expect(issues[0].severity).toBe("error");
	});

	it("valid values in every layer are kept", () => {
		const { config, issues } = load({
			contextLength: 16384,
			keepAlive: "10m",
			warm: false,
			defaults: {
				maxTokens: 4096,
				thinkingLevel: "low",
				sampling: { temperature: 0.7, topP: 0.9, topK: 40, stop: ["</s>"] },
				gpu: { numGpu: 99, useMmap: true },
				request: { idleTimeoutMs: 0, maxRetries: 0, logprobs: true },
			},
			servers: { remote: { host: "10.0.0.5", port: 11435 } },
			models: { "gpt-oss:latest": { contextLength: 65536, keepAlive: -1, server: "remote" } },
		});
		expect(issues).toEqual([]);
		expect(config.topLevel.contextLength).toBe(16384);
		expect(config.topLevel.keepAlive).toBe("10m");
		expect(config.topLevel.warm).toBe(false);
		expect(config.defaults.sampling?.topP).toBe(0.9);
		expect(config.defaults.request).toEqual({ idleTimeoutMs: 0, maxRetries: 0, logprobs: true });
		expect(config.servers.remote).toEqual({ host: "10.0.0.5", port: 11435 });
		expect(config.models["gpt-oss:latest"].server).toBe("remote");
	});

	it("numbers written as strings are errors, never coerced", () => {
		const { config, issues } = load({
			defaults: { contextLength: "65536", sampling: { topP: "0.9" } },
		});
		expect(paths(issues)).toEqual(["defaults.contextLength", "defaults.sampling.topP"]);
		expect(issues.every((i) => i.severity === "error")).toBeTruthy();
		expect(config.defaults.contextLength).toBe(undefined);
		expect(config.defaults.sampling).toEqual({});
	});

	it("range and type errors name the path and value", () => {
		const { issues } = load({
			models: {
				m: {
					contextLength: 100,
					maxTokens: 0,
					thinkingLevel: "extreme",
					keepAlive: "soon",
					warm: "yes",
					sampling: { topP: 1.4, topK: 1.5, repeatPenalty: 0, repeatLastN: -2, stop: [""] },
					gpu: { numGpu: -2, numBatch: 0 },
					request: { idleTimeoutMs: 500, maxRetries: 11 },
				},
			},
		});
		expect(paths(issues)).toEqual([
			'models["m"].contextLength',
			'models["m"].maxTokens',
			'models["m"].thinkingLevel',
			'models["m"].keepAlive',
			'models["m"].warm',
			'models["m"].sampling.topP',
			'models["m"].sampling.topK',
			'models["m"].sampling.repeatPenalty',
			'models["m"].sampling.repeatLastN',
			'models["m"].sampling.stop',
			'models["m"].gpu.numGpu',
			'models["m"].gpu.numBatch',
			'models["m"].request.idleTimeoutMs',
			'models["m"].request.maxRetries',
		]);
		expect(issues.every((i) => i.severity === "error")).toBeTruthy();
		expect(issues[5].message).toMatch(/1\.4/);
	});

	it("accepts numGpu -1 (Ollama's 'decide automatically') but nothing lower", () => {
		expect(load({ defaults: { gpu: { numGpu: -1 } } }).issues).toEqual([]);
		expect(paths(load({ defaults: { gpu: { numGpu: -2 } } }).issues)).toEqual(["defaults.gpu.numGpu"]);
	});

	it("unknown keys are warnings; retired keys get a hint", () => {
		const { issues } = load({ perModelContext: {}, defaults: { sampling: { topQ: 1 } }, bogus: 1 });
		expect(paths(issues)).toEqual(["perModelContext", "bogus", "defaults.sampling.topQ"]);
		expect(issues.every((i) => i.severity === "warning")).toBeTruthy();
		expect(issues[0].message).toMatch(/models\["<id>"\]\.contextLength/);
	});

	it("_comment keys are ignored silently at every level", () => {
		const { issues } = load({
			_comment: "x",
			defaults: { _note: 1, sampling: { _why: "y" } },
			servers: { _c: 1, a: { host: "h", _c: 2 } },
			models: { _c: "z", m: { _c: 3 } },
		});
		expect(issues).toEqual([]);
	});

	it("server is only allowed in model entries; app keys are top level only", () => {
		const { issues } = load({ server: "a", defaults: { server: "a", servers: {} }, models: { m: { models: {} } } });
		expect(paths(issues)).toEqual(["server", "defaults.server", "defaults.servers", 'models["m"].models']);
		expect(issues.every((i) => i.severity === "error")).toBeTruthy();
	});

	it("a server name that isn't defined is an error and is dropped", () => {
		const { config, issues } = load({ models: { m: { server: "nope" } } });
		expect(paths(issues)).toEqual(['models["m"].server']);
		expect(issues[0].severity).toBe("error");
		expect(config.models.m.server).toBe(undefined);
	});

	it("server validation: host required, port range, unknown fields warn", () => {
		const { config, issues } = load({
			servers: { a: { port: 1 }, b: { host: "h", port: 70000 }, c: { host: "has space" }, d: { host: "h", tls: true } },
		});
		expect(paths(issues)).toEqual(['servers["a"].host', 'servers["b"].port', 'servers["c"].host', 'servers["d"].tls']);
		expect(Object.keys(config.servers).sort()).toEqual(["b", "d"]);
		expect(config.servers.b).toEqual({ host: "h" });
	});

	it("same key in defaults and top level warns", () => {
		const { issues } = load({ contextLength: 8192, defaults: { contextLength: 16384 } });
		expect(paths(issues)).toEqual(["defaults.contextLength"]);
		expect(issues[0].severity).toBe("warning");
	});

	it("sections must be objects", () => {
		const { issues } = load({ defaults: { sampling: [1] }, models: { m: 5 } });
		expect(paths(issues)).toEqual(["defaults.sampling", 'models["m"]']);
	});

	it("__proto__ can't pollute models; constructor is a plain entry", () => {
		// "__proto__" starts with "_", so the comment rule skips it (real Ollama
		// model names start with a letter or digit).
		const raw = JSON.parse('{"models":{"__proto__":{"contextLength":4096},"constructor":{"maxTokens":5}}}');
		const { config, issues } = load(raw);
		expect(issues).toEqual([]);
		expect(Object.getPrototypeOf(config.models)).toBe(null);
		expect(Object.keys(config.models)).toEqual(["constructor"]);
		expect(config.models["constructor"].maxTokens).toBe(5);
		expect(({} as Record<string, unknown>).contextLength).toBe(undefined);
	});
});
