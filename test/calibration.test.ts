import { describe, expect, it } from "vitest";
import { RatioCalibrator } from "../src/calibration.js";

// The live estimate converts streamed characters to tokens. ~4 chars/token is
// only a bootstrap: each completed generation reveals the true ratio for that
// model (Ollama's eval_count vs the characters we saw), and the calibrator
// learns it - smoothed, bounded, and per model.

const DEFAULT = 0.25;

describe("RatioCalibrator - learned tokens-per-character, per model", () => {
	it("falls back to ~4 chars/token for a model it has never seen", () => {
		expect(new RatioCalibrator().ratioFor("gemma4:12b")).toBe(DEFAULT);
	});

	it("converges on the ratio a model actually shows", () => {
		const cal = new RatioCalibrator();
		for (let i = 0; i < 20; i++) cal.observe("gemma4:12b", 300, 1000); // 0.3 tok/char

		expect(cal.ratioFor("gemma4:12b")).toBeCloseTo(0.3, 2);
	});

	it("keeps each model's calibration independent", () => {
		const cal = new RatioCalibrator();
		for (let i = 0; i < 20; i++) cal.observe("gemma4:12b", 300, 1000);

		expect(cal.ratioFor("qwen3:8b")).toBe(DEFAULT);
	});

	it("doesn't let a single first sample replace the fallback wholesale", () => {
		const cal = new RatioCalibrator();
		cal.observe("gemma4:12b", 500, 1000); // one 0.5 reading

		const ratio = cal.ratioFor("gemma4:12b");
		expect(ratio).toBeGreaterThan(DEFAULT);
		expect(ratio).toBeLessThan(0.4); // nudged, not replaced
	});

	it("doesn't let one odd response displace an established calibration", () => {
		const cal = new RatioCalibrator();
		for (let i = 0; i < 20; i++) cal.observe("gemma4:12b", 300, 1000);
		cal.observe("gemma4:12b", 600, 1000); // a 0.6 outlier

		expect(cal.ratioFor("gemma4:12b")).toBeCloseTo(0.3, 0);
		expect(cal.ratioFor("gemma4:12b")).toBeLessThan(0.4);
	});

	it("ignores samples that can't be a real ratio", () => {
		const cal = new RatioCalibrator();
		cal.observe("m", 300, 0); // no characters seen
		cal.observe("m", 0, 1000); // no tokens
		cal.observe("m", Number.NaN, 1000);
		cal.observe("m", 300, Number.POSITIVE_INFINITY);
		cal.observe("m", 5000, 1000); // 5 tokens per character: hidden output
		cal.observe("m", 10, 1000); // 100 characters per token: not text
		cal.observe("m", 5, 20); // too short to say anything

		expect(cal.ratioFor("m")).toBe(DEFAULT);
	});
});
