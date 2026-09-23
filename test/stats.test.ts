import { describe, expect, it } from "vitest";
import {
	GENERATION_ENTRY_TYPE,
	formatSessionStats,
	readGenerationRecords,
	summarizeByModel,
	type GenerationRecord,
} from "../src/stats.js";

function record(over: Partial<GenerationRecord> = {}): GenerationRecord {
	return {
		model: "gemma4:12b",
		timestamp: 1,
		outputTokens: 100,
		evalDurationNs: 2e9,
		tokensPerSecond: 50,
		...over,
	};
}

const entry = (data: unknown, customType = GENERATION_ENTRY_TYPE) => ({
	type: "custom",
	customType,
	data,
});

describe("readGenerationRecords - records back out of pi's session entries", () => {
	it("round-trips a record through a session entry", () => {
		const r = record({ promptTokens: 2048 });
		const stored = JSON.parse(JSON.stringify(entry(r)));

		expect(readGenerationRecords([stored])).toEqual([r]);
	});

	it("skips other extensions' entries, ordinary messages, and malformed records", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			entry(record(), "someone-elses-type"),
			entry(undefined),
			entry({ model: "m" }),
			entry({ ...record(), evalDurationNs: 0 }),
			entry({ ...record(), outputTokens: "100" }),
			null,
			entry(record({ model: "kept" })),
		];

		expect(readGenerationRecords(entries).map((r) => r.model)).toEqual(["kept"]);
	});
});

describe("summarizeByModel - session throughput per model", () => {
	it("averages by total tokens over total time, not the mean of per-turn rates", () => {
		// 1000 tok in 10s (100 tok/s) + 10 tok in 1s (10 tok/s).
		// Mean of rates would say 55; the work-weighted truth is 1010/11 = 91.8.
		const [s] = summarizeByModel([
			record({ outputTokens: 1000, evalDurationNs: 10e9, tokensPerSecond: 100 }),
			record({ outputTokens: 10, evalDurationNs: 1e9, tokensPerSecond: 10 }),
		]);

		expect(s.averageTokensPerSecond).toBeCloseTo(91.8, 1);
		expect(s.generatedTokens).toBe(1010);
		expect(s.generations).toBe(2);
	});

	it("reports the last and the fastest generation", () => {
		const [s] = summarizeByModel([
			record({ timestamp: 1, tokensPerSecond: 40 }),
			record({ timestamp: 2, tokensPerSecond: 51.2 }),
			record({ timestamp: 3, tokensPerSecond: 47.3 }),
		]);

		expect(s.lastTokensPerSecond).toBe(47.3);
		expect(s.fastestTokensPerSecond).toBe(51.2);
	});

	it("keeps models apart, most recently used first", () => {
		const summaries = summarizeByModel([
			record({ model: "a", timestamp: 1 }),
			record({ model: "b", timestamp: 2 }),
			record({ model: "a", timestamp: 3 }),
		]);

		expect(summaries.map((s) => [s.model, s.generations])).toEqual([
			["a", 2],
			["b", 1],
		]);
	});
});

describe("formatSessionStats - the /ollama-stats readout", () => {
	it("lays out one block per model", () => {
		const text = formatSessionStats(
			summarizeByModel([
				record({ outputTokens: 8000, evalDurationNs: 174e9, tokensPerSecond: 45.9 }),
				record({ timestamp: 2, outputTokens: 491, evalDurationNs: 10.4e9, tokensPerSecond: 47.3 }),
			]),
		);

		expect(text).toBe(
			[
				"Model: gemma4:12b",
				"  Last: 47.3 tok/s",
				"  Session avg: 46.0 tok/s",
				"  Fastest: 47.3 tok/s",
				"  Generated: 8,491 tok",
				"  Generations: 2",
			].join("\n"),
		);
	});

	it("says so when the session has no records yet", () => {
		expect(formatSessionStats([])).toMatch(/no completed ollama generations/i);
	});
});
