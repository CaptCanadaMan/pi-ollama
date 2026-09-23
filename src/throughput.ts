// Exact generation throughput, from Ollama's own final metrics.
//
// The done:true chunk of /api/chat carries eval_count (generated tokens) and
// eval_duration (nanoseconds spent generating). Those are authoritative for
// the completed attempt - wall-clock time would fold in model load and prompt
// evaluation, and chunk counts are not token counts on batched streams
// (issue #4). Pure functions only; the provider reports, the extension layer
// formats and displays.

import type { OllamaChunk } from "./wire.js";

export interface GenerationMetrics {
	outputTokens: number;
	evalDurationNs: number;
	tokensPerSecond: number;
	promptTokens?: number;
	promptEvalDurationNs?: number;
}

type MetricFields = Pick<
	OllamaChunk,
	"eval_count" | "eval_duration" | "prompt_eval_count" | "prompt_eval_duration"
>;

function isPositiveFinite(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Exact metrics from a done:true chunk, or undefined when they can't produce
 * a finite rate (older/remote servers omit them; a zero duration would divide
 * to Infinity). Undefined means "show nothing", never a made-up number.
 */
export function parseGenerationMetrics(
	chunk: MetricFields,
): GenerationMetrics | undefined {
	const outputTokens = chunk.eval_count;
	const evalDurationNs = chunk.eval_duration;
	if (!isPositiveFinite(outputTokens) || !isPositiveFinite(evalDurationNs)) {
		return undefined;
	}
	const metrics: GenerationMetrics = {
		outputTokens,
		evalDurationNs,
		tokensPerSecond: outputTokens / (evalDurationNs / 1e9),
	};
	if (isPositiveFinite(chunk.prompt_eval_count)) {
		metrics.promptTokens = chunk.prompt_eval_count;
	}
	if (isPositiveFinite(chunk.prompt_eval_duration)) {
		metrics.promptEvalDurationNs = chunk.prompt_eval_duration;
	}
	return metrics;
}

/** Completed-generation status: Ollama-reported, so one decimal is honest. */
export function formatExactThroughput(metrics: GenerationMetrics): string {
	return `${metrics.tokensPerSecond.toFixed(1)} tok/s · ${metrics.outputTokens.toLocaleString("en-US")} tok`;
}

/** Live status: an estimate, so it is marked and carries no decimals. */
export function formatEstimatedThroughput(tokensPerSecond: number): string {
	return `≈${Math.round(tokensPerSecond)} tok/s`;
}
