// Session performance history: one record per completed generation, stored as
// a pi custom session entry. Custom entries never enter the LLM context, and
// they live in pi's own session file - no private cache-file protocol.

import type { CompletedGeneration } from "./telemetry.js";

export const GENERATION_ENTRY_TYPE = "pi-ollama-generation";

export interface GenerationRecord {
	model: string;
	timestamp: number;
	outputTokens: number;
	evalDurationNs: number;
	tokensPerSecond: number;
	promptTokens?: number;
	promptEvalDurationNs?: number;
}

export function toGenerationRecord(c: CompletedGeneration): GenerationRecord {
	return { model: c.model, timestamp: c.timestamp, ...c.metrics };
}

function isRecord(data: unknown): data is GenerationRecord {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	const positive = (n: unknown) =>
		typeof n === "number" && Number.isFinite(n) && n > 0;
	return (
		typeof d.model === "string" &&
		positive(d.outputTokens) &&
		positive(d.evalDurationNs) &&
		positive(d.tokensPerSecond)
	);
}

/**
 * Pull this extension's records out of a session's entries. Anything
 * malformed or from another version's shape is skipped, never thrown on -
 * session files outlive the code that wrote them.
 */
export function readGenerationRecords(
	entries: readonly unknown[],
): GenerationRecord[] {
	const records: GenerationRecord[] = [];
	for (const e of entries) {
		const entry = e as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom") continue;
		if (entry.customType !== GENERATION_ENTRY_TYPE) continue;
		if (isRecord(entry.data)) records.push(entry.data);
	}
	return records;
}

export interface ModelSummary {
	model: string;
	lastTokensPerSecond: number;
	/** sum(tokens) / sum(eval seconds) - weighted by work done, unlike a mean of rates. */
	averageTokensPerSecond: number;
	fastestTokensPerSecond: number;
	generatedTokens: number;
	generations: number;
	lastTimestamp: number;
}

/** One summary per model, most recently used first. */
export function summarizeByModel(
	records: readonly GenerationRecord[],
): ModelSummary[] {
	const byModel = new Map<string, GenerationRecord[]>();
	for (const r of records) {
		const list = byModel.get(r.model);
		if (list) list.push(r);
		else byModel.set(r.model, [r]);
	}

	const summaries: ModelSummary[] = [];
	for (const [model, list] of byModel) {
		const last = list.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
		const tokens = list.reduce((sum, r) => sum + r.outputTokens, 0);
		const seconds = list.reduce((sum, r) => sum + r.evalDurationNs / 1e9, 0);
		summaries.push({
			model,
			lastTokensPerSecond: last.tokensPerSecond,
			averageTokensPerSecond: tokens / seconds,
			fastestTokensPerSecond: Math.max(...list.map((r) => r.tokensPerSecond)),
			generatedTokens: tokens,
			generations: list.length,
			lastTimestamp: last.timestamp,
		});
	}
	return summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

export function formatSessionStats(summaries: readonly ModelSummary[]): string {
	if (summaries.length === 0) {
		return "No completed Ollama generations recorded in this session yet.";
	}
	return summaries
		.map((s) =>
			[
				`Model: ${s.model}`,
				`  Last: ${s.lastTokensPerSecond.toFixed(1)} tok/s`,
				`  Session avg: ${s.averageTokensPerSecond.toFixed(1)} tok/s`,
				`  Fastest: ${s.fastestTokensPerSecond.toFixed(1)} tok/s`,
				`  Generated: ${s.generatedTokens.toLocaleString("en-US")} tok`,
				`  Generations: ${s.generations}`,
			].join("\n"),
		)
		.join("\n\n");
}
