import { describe, expect, it } from "vitest";
import { parseKeepAlive, resolveKeepAlive } from "../src/settings.js";

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
