import { describe, expect, it } from "vitest";
import {
	formatEstimatedThroughput,
	formatExactThroughput,
	parseGenerationMetrics,
} from "../src/throughput.js";

// Exact throughput comes from Ollama's own final metrics on the done:true
// chunk - eval_count / eval_duration (ns) - never from wall-clock or chunk
// counts. Anything that can't produce a finite rate yields undefined, so no
// NaN/Infinity ever reaches the UI or a persisted record.

describe("parseGenerationMetrics - exact tok/s from the done chunk", () => {
	it("converts eval_duration from nanoseconds (100 tok in 0.5s = 200 tok/s)", () => {
		const m = parseGenerationMetrics({
			eval_count: 100,
			eval_duration: 500_000_000,
		});
		expect(m?.tokensPerSecond).toBeCloseTo(200);
		expect(m?.outputTokens).toBe(100);
		expect(m?.evalDurationNs).toBe(500_000_000);
	});

	it("yields nothing when the metrics are missing (older/remote servers)", () => {
		expect(parseGenerationMetrics({})).toBeUndefined();
		expect(parseGenerationMetrics({ eval_count: 100 })).toBeUndefined();
		expect(parseGenerationMetrics({ eval_duration: 5e8 })).toBeUndefined();
	});

	it("yields nothing for a zero duration or zero tokens (no Infinity, no 0 tok/s)", () => {
		expect(
			parseGenerationMetrics({ eval_count: 100, eval_duration: 0 }),
		).toBeUndefined();
		expect(
			parseGenerationMetrics({ eval_count: 0, eval_duration: 5e8 }),
		).toBeUndefined();
	});

	it("yields nothing for negative or non-finite values", () => {
		expect(
			parseGenerationMetrics({ eval_count: -5, eval_duration: 5e8 }),
		).toBeUndefined();
		expect(
			parseGenerationMetrics({ eval_count: Number.NaN, eval_duration: 5e8 }),
		).toBeUndefined();
		expect(
			parseGenerationMetrics({
				eval_count: 100,
				eval_duration: Number.POSITIVE_INFINITY,
			}),
		).toBeUndefined();
	});

	it("carries prompt metrics when present, and tolerates their absence", () => {
		const withPrompt = parseGenerationMetrics({
			eval_count: 100,
			eval_duration: 5e8,
			prompt_eval_count: 2048,
			prompt_eval_duration: 1e9,
		});
		expect(withPrompt?.promptTokens).toBe(2048);
		expect(withPrompt?.promptEvalDurationNs).toBe(1e9);

		const without = parseGenerationMetrics({
			eval_count: 100,
			eval_duration: 5e8,
			prompt_eval_count: Number.NaN,
		});
		expect(without?.tokensPerSecond).toBeCloseTo(200);
		expect(without && "promptTokens" in without).toBe(false);
	});
});

describe("status formatting - estimate is marked, exact carries the token count", () => {
	it("formats the exact figure as 'NN.N tok/s · NNN tok'", () => {
		expect(
			formatExactThroughput({
				outputTokens: 612,
				evalDurationNs: 12_938_689_217,
				tokensPerSecond: 47.3,
			}),
		).toBe("47.3 tok/s · 612 tok");
	});

	it("groups large token counts", () => {
		expect(
			formatExactThroughput({
				outputTokens: 8491,
				evalDurationNs: 1,
				tokensPerSecond: 45.94,
			}),
		).toBe("45.9 tok/s · 8,491 tok");
	});

	it("marks the live figure as approximate and rounds it (no false precision)", () => {
		expect(formatEstimatedThroughput(46.4)).toBe("≈46 tok/s");
	});
});
