import { describe, expect, it } from "vitest";
import {
	keyFingerprint,
	parseKeepAlive,
	resolveApiKey,
	resolveKeepAlive,
	resolveThroughputEnabled,
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

describe("resolveApiKey - OLLAMA_API_KEY is only used for the host it was approved for", () => {
	const home = "http://ollama.home:11434";

	it("uses a key approved for this host", () => {
		const approval = { host: home, fingerprint: keyFingerprint("sk-home") };
		expect(resolveApiKey("sk-home", home, approval)).toEqual({
			apiKey: "sk-home",
			apiKeyStatus: "approved",
		});
	});

	it.each([
		["the host changed", { host: "https://ollama.com", fingerprint: keyFingerprint("sk-home") }],
		["the key changed", { host: home, fingerprint: keyFingerprint("sk-old") }],
		["it was never approved", undefined],
	])("holds the key back when %s", (_why, approval) => {
		expect(resolveApiKey("sk-home", home, approval)).toEqual({ apiKeyStatus: "unapproved" });
	});

	it("has nothing to use or ask about when no key is set, or it's blank", () => {
		for (const raw of [undefined, "", "   "]) {
			expect(resolveApiKey(raw, home, undefined)).toEqual({ apiKeyStatus: "none" });
		}
	});
});

describe("resolveThroughputEnabled - tok/s telemetry is on unless switched off", () => {
	it("is on by default", () => {
		expect(resolveThroughputEnabled(undefined)).toBe(true);
		expect(resolveThroughputEnabled("")).toBe(true);
	});

	it("turns off for 0 / false / off / no (any case)", () => {
		for (const raw of ["0", "false", "OFF", "No", " 0 "]) {
			expect(resolveThroughputEnabled(raw)).toBe(false);
		}
	});

	it("stays on for anything else", () => {
		expect(resolveThroughputEnabled("1")).toBe(true);
		expect(resolveThroughputEnabled("banana")).toBe(true);
	});
});
