import { describe, expect, it } from "vitest";
import { isValidKeepAlive } from "../src/settings.js";

describe("isValidKeepAlive", () => {
	it("accepts numeric seconds", () => {
		for (const n of [0, 60, 3600, -1, -5, 1.5]) {
			expect(isValidKeepAlive(n)).toBe(true);
		}
	});

	it("accepts duration strings with units", () => {
		for (const s of ["5m", "30s", "1h", "0m", "5.5m", "1h30m", "-5m"]) {
			expect(isValidKeepAlive(s)).toBe(true);
		}
	});

	it("accepts bare numeric strings", () => {
		for (const s of ["3600", "-1", "0"]) {
			expect(isValidKeepAlive(s)).toBe(true);
		}
	});

	it("rejects nonsense strings", () => {
		for (const s of ["", "  ", "5 minutes", "5x", "abc", "m", "5 m", "2d", "5ms", "1h30"]) {
			expect(isValidKeepAlive(s)).toBe(false);
		}
	});

	it("rejects non-string, non-number values", () => {
		for (const v of [null, undefined, true, {}, []]) {
			expect(isValidKeepAlive(v)).toBe(false);
		}
	});
});
