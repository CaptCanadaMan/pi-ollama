import { describe, expect, it } from "vitest";
import {
	describeThinking,
	parseThinking,
	resolveThink,
	thinkingSummary,
	toThinkingLevelMap,
} from "../src/thinking.js";

// gh#13: Ollama >= 0.34 reports each model's accepted `think` values in
// /api/show. The first two fixtures are real responses from a 0.34.4 server;
// qwen3.8 and the mixed Nemotron shape come from the issue report.
const museGlimmer = { values: [false, "low", "medium", "high", "max"], default: "high" };
const gemma4 = { values: [false, true], default: true };
const qwen38 = { values: [false, "low", "medium", "xhigh"], default: "medium" };
const nemotronMixed = { values: [false, true, "medium"], default: true };
const noOff = { values: ["low", "medium", "high"], default: "medium" };

describe("parseThinking - /api/show's thinking field", () => {
	it("keeps boolean and string values and the default", () => {
		expect(parseThinking(qwen38)).toEqual(qwen38);
	});

	it("drops values of other types", () => {
		expect(parseThinking({ values: [false, 3, null, "low"] })).toEqual({
			values: [false, "low"],
		});
	});

	it("returns undefined when the field is missing or malformed", () => {
		expect(parseThinking(undefined)).toBeUndefined();
		expect(parseThinking("yes")).toBeUndefined();
		expect(parseThinking({ values: "low" })).toBeUndefined();
		expect(parseThinking({ values: [] })).toBeUndefined();
		expect(parseThinking({ values: [42] })).toBeUndefined();
	});
});

describe("describeThinking - which pi levels a model gets", () => {
	it("passes named levels through and hides the rest (qwen3.8)", () => {
		const d = describeThinking(qwen38);
		expect(d?.levels).toEqual(["off", "low", "medium", "xhigh"]);
		expect(d?.unexposed).toEqual([]);
	});

	it("maps xhigh and max explicitly, since pi hides them otherwise", () => {
		expect(toThinkingLevelMap(museGlimmer)).toEqual({
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(describeThinking(museGlimmer)?.levels).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
		]);
	});

	it("offers off + medium for an on/off-only model (gemma4)", () => {
		const d = describeThinking(gemma4);
		expect(d?.levels).toEqual(["off", "medium"]);
		// medium left unmapped: the provider default for it is think:true
		expect(d?.map).not.toHaveProperty("medium");
		expect(d?.unexposed).toEqual([]);
	});

	it("drops a bare true that sits next to named levels, and reports it", () => {
		const d = describeThinking(nemotronMixed);
		expect(d?.levels).toEqual(["off", "medium"]);
		expect(d?.map.medium).toBe("medium");
		expect(d?.unexposed).toEqual([true]);
	});

	it("hides off when the model can't switch thinking off", () => {
		const d = describeThinking(noOff);
		expect(d?.map.off).toBeNull();
		expect(d?.levels).toEqual(["low", "medium", "high"]);
	});

	it("reports strings pi has no level name for", () => {
		const d = describeThinking({ values: [false, "low", "ultra"] });
		expect(d?.levels).toEqual(["off", "low"]);
		expect(d?.unexposed).toEqual(["ultra"]);
	});

	it("returns undefined for a model with no thinking field (legacy)", () => {
		expect(describeThinking(undefined)).toBeUndefined();
		expect(toThinkingLevelMap(undefined)).toBeUndefined();
	});
});

describe("thinkingSummary - the /ollama-info line", () => {
	it("lists the pi levels a model gets", () => {
		expect(thinkingSummary(museGlimmer)).toBe(
			"pi thinking levels: off, low, medium, high, max",
		);
	});

	it("names values pi can't offer", () => {
		expect(thinkingSummary({ values: [false, true, "medium", "ultra"] })).toBe(
			'pi thinking levels: off, medium\nnot exposed (no matching pi level): true, "ultra"',
		);
	});

	it("says so when the server reports no thinking values", () => {
		expect(thinkingSummary(undefined)).toBe(
			"pi thinking levels: on/off only (server reports no thinking values)",
		);
	});
});

describe("resolveThink - pi thinking level → Ollama think value", () => {
	describe("legacy: no thinking field reported", () => {
		it("maps an absent level (pi's encoding of off) to an explicit false", () => {
			expect(resolveThink(undefined)).toBe(false);
		});

		it("treats a literal 'off' string defensively as off", () => {
			expect(resolveThink("off")).toBe(false);
		});

		it("maps any set level to true", () => {
			for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
				expect(resolveThink(level)).toBe(true);
			}
		});
	});

	describe("with a per-model map", () => {
		const map = (t: object) => toThinkingLevelMap(t as never);

		it("sends the model's own level name", () => {
			expect(resolveThink("medium", map(qwen38))).toBe("medium");
			expect(resolveThink("max", map(museGlimmer))).toBe("max");
		});

		it("sends true for the on level of an on/off-only model", () => {
			expect(resolveThink("medium", map(gemma4))).toBe(true);
		});

		it("sends false for off when the model accepts it", () => {
			expect(resolveThink(undefined, map(qwen38))).toBe(false);
			expect(resolveThink("off", map(gemma4))).toBe(false);
		});

		it("omits think for off when the model can't switch thinking off", () => {
			expect(resolveThink(undefined, map(noOff))).toBeUndefined();
		});

		it("clamps a level the model doesn't have, the way pi does", () => {
			expect(resolveThink("high", map(qwen38))).toBe("xhigh");
			expect(resolveThink("high", map(gemma4))).toBe(true);
			expect(resolveThink("xhigh", map(museGlimmer))).toBe("max");
			expect(resolveThink("minimal", map(noOff))).toBe("low");
		});
	});
});
