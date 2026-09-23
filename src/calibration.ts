// Per-model calibration of the live estimate's tokens-per-character ratio.
//
// In-memory only, by design: it re-learns within a few turns of each launch,
// and persisting it would mean another cache file for a number that only
// sharpens an estimate already marked "≈".

/** Bootstrap heuristic: ~4 characters per token. */
export const DEFAULT_TOKENS_PER_CHAR = 0.25;

// EMA weight of each new observation. The average is SEEDED at the fallback
// rather than at the first sample, which is the whole confidence model: one
// reading moves the ratio a fifth of the way, ~10 readings carry ~90% of the
// weight, and no single odd response can dominate early or late.
const SMOOTHING = 0.2;

// Sanity bounds. Real text runs roughly 2-6 chars/token; outside 1-20 the
// sample is measuring something else (unstreamed output, a degenerate loop).
const MIN_RATIO = 0.05;
const MAX_RATIO = 1;
/** Below this a generation is too short for its ratio to mean anything. */
const MIN_SAMPLE_TOKENS = 20;

export class RatioCalibrator {
	private readonly byModel = new Map<string, number>();

	ratioFor(model: string): number {
		return this.byModel.get(model) ?? DEFAULT_TOKENS_PER_CHAR;
	}

	/** One completed generation: Ollama's exact token count vs characters streamed. */
	observe(model: string, tokens: number, chars: number): void {
		if (!(tokens >= MIN_SAMPLE_TOKENS) || !(chars > 0)) return;
		const observed = tokens / chars;
		if (!(observed >= MIN_RATIO && observed <= MAX_RATIO)) return;
		const current = this.ratioFor(model);
		this.byModel.set(model, current + SMOOTHING * (observed - current));
	}
}
