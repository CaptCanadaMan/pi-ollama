import { describe, expect, it } from "vitest";
import {
	parseKeepAlive,
	resolveContextWindow,
	resolveKeepAlive,
} from "../src/settings.js";

// keep_alive semantics (gh#5): a per-request keep_alive OVERRIDES the Ollama
// server's OLLAMA_KEEP_ALIVE, so the old hardcoded "5m" silently defeated any
// server-side keep-warm config. The fix: resolve persisted → env → undefined,
// where undefined means "omit the field — the server decides".

describe("parseKeepAlive — user/env input validation", () => {
	it("accepts Go-style duration strings verbatim", () => {
		expect(parseKeepAlive("5m")).toBe("5m");
		expect(parseKeepAlive("1h30m")).toBe("1h30m");
		expect(parseKeepAlive("10m30s")).toBe("10m30s");
		expect(parseKeepAlive("500ms")).toBe("500ms");
	});

	it("accepts bare integers as numbers (seconds; -1 = keep forever, 0 = unload now)", () => {
		expect(parseKeepAlive("-1")).toBe(-1);
		expect(parseKeepAlive("0")).toBe(0);
		expect(parseKeepAlive("300")).toBe(300);
	});

	it("trims surrounding whitespace", () => {
		expect(parseKeepAlive("  5m  ")).toBe("5m");
	});

	it("rejects garbage, empty, and malformed durations as undefined", () => {
		expect(parseKeepAlive("banana")).toBeUndefined();
		expect(parseKeepAlive("")).toBeUndefined();
		expect(parseKeepAlive("5x")).toBeUndefined();
		expect(parseKeepAlive("m5")).toBeUndefined();
		expect(parseKeepAlive("--1")).toBeUndefined();
	});
});

describe("resolveKeepAlive — persisted → env → defer-to-server", () => {
	it("returns undefined when nothing is configured (defer to the server)", () => {
		expect(resolveKeepAlive(undefined, undefined)).toBeUndefined();
	});

	it("uses the env var when no persisted value exists", () => {
		expect(resolveKeepAlive(undefined, "-1")).toBe(-1);
		expect(resolveKeepAlive(undefined, "10m")).toBe("10m");
	});

	it("persisted value wins over the env var", () => {
		expect(resolveKeepAlive("1h", "-1")).toBe("1h");
		expect(resolveKeepAlive(-1, "5m")).toBe(-1);
	});

	it("an invalid env value resolves to undefined (defer), never a fallback constant", () => {
		expect(resolveKeepAlive(undefined, "banana")).toBeUndefined();
	});
});

describe("resolveContextWindow - perModelContext -> contextLength -> capped default", () => {
	it("uses the per-model override when present, ignoring contextLength and the cap", () => {
		expect(
			resolveContextWindow({
				perModelContext: { "gemma4:12b": 65536 },
				modelId: "gemma4:12b",
				contextLength: 16384,
				discoveredContextWindow: 131072,
				numCtx: 32768,
			}),
		).toBe(65536);
	});

	it("falls through to contextLength when the model has no per-model entry", () => {
		expect(
			resolveContextWindow({
				perModelContext: { "other-model:latest": 65536 },
				modelId: "gemma4:12b",
				contextLength: 16384,
				discoveredContextWindow: 131072,
				numCtx: 32768,
			}),
		).toBe(16384);
	});

	it("falls through to contextLength when perModelContext is entirely undefined", () => {
		expect(
			resolveContextWindow({
				perModelContext: undefined,
				modelId: "gemma4:12b",
				contextLength: 16384,
				discoveredContextWindow: 131072,
				numCtx: 32768,
			}),
		).toBe(16384);
	});

	it("falls through to min(discovered, numCtx) when neither override is set", () => {
		expect(
			resolveContextWindow({
				perModelContext: undefined,
				modelId: "gemma4:12b",
				contextLength: undefined,
				discoveredContextWindow: 131072,
				numCtx: 32768,
			}),
		).toBe(32768);
	});

	it("caps the default at the discovered window when it's smaller than numCtx", () => {
		expect(
			resolveContextWindow({
				perModelContext: undefined,
				modelId: "gemma4:12b",
				contextLength: undefined,
				discoveredContextWindow: 8192,
				numCtx: 32768,
			}),
		).toBe(8192);
	});

	it("a per-model override of 0 is respected, not treated as falsy/unset", () => {
		expect(
			resolveContextWindow({
				perModelContext: { "gemma4:12b": 0 },
				modelId: "gemma4:12b",
				contextLength: 16384,
				discoveredContextWindow: 131072,
				numCtx: 32768,
			}),
		).toBe(0);
	});
});
