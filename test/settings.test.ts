import { afterEach, describe, expect, it } from "vitest";
import {
	envFloat,
	envInt,
	parseKeepAlive,
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

// Extra Ollama /api/chat sampling params (OLLAMA_TOP_P etc.): unset or
// unparseable = field omitted, Ollama's own Modelfile/server default applies.
describe("envFloat / envInt - sampling-param env var parsing", () => {
	const ENV_VAR = "OLLAMA_TEST_SAMPLING_PARAM";

	afterEach(() => {
		delete process.env[ENV_VAR];
	});

	it("envFloat returns undefined when unset", () => {
		expect(envFloat(ENV_VAR)).toBeUndefined();
	});

	it("envFloat parses a valid float", () => {
		process.env[ENV_VAR] = "0.9";
		expect(envFloat(ENV_VAR)).toBe(0.9);
	});

	it("envFloat parses a valid integer as a float", () => {
		process.env[ENV_VAR] = "42";
		expect(envFloat(ENV_VAR)).toBe(42);
	});

	it("envFloat returns undefined for garbage (defer to server default)", () => {
		process.env[ENV_VAR] = "banana";
		expect(envFloat(ENV_VAR)).toBeUndefined();
	});

	it("envInt returns undefined when unset", () => {
		expect(envInt(ENV_VAR)).toBeUndefined();
	});

	it("envInt parses a valid integer", () => {
		process.env[ENV_VAR] = "42";
		expect(envInt(ENV_VAR)).toBe(42);
	});

	it("envInt truncates a float string via parseInt semantics", () => {
		process.env[ENV_VAR] = "3.7";
		expect(envInt(ENV_VAR)).toBe(3);
	});

	it("envInt returns undefined for garbage (defer to server default)", () => {
		process.env[ENV_VAR] = "banana";
		expect(envInt(ENV_VAR)).toBeUndefined();
	});

	it("accepts a negative seed", () => {
		process.env[ENV_VAR] = "-1";
		expect(envInt(ENV_VAR)).toBe(-1);
	});
});
