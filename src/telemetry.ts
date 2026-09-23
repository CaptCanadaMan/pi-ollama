// The telemetry seam between the provider and the extension layer.
//
// The provider reports what happened to a generation (TelemetrySink); the
// extension layer pulls what it wants to show or persist from its own event
// handlers, which is where pi hands out a UI context. Deliberately tiny and
// in-memory: no files, no public event bus, no general metrics framework.
//
// One measurement = one streamOllama call that got past the ghost-retry loop.
// Ghost retries happen before any content streams, so an abandoned attempt
// never reports progress; the other reliability errors end the call, and any
// retry is a fresh call with a fresh started().

import type { GenerationMetrics } from "./throughput.js";

/** What the provider reports. It knows nothing about rendering or storage. */
export interface TelemetrySink {
	started(model: string): void;
	/** Characters of generated text/thinking just streamed. */
	progress(chars: number): void;
	completed(metrics: GenerationMetrics | undefined): void;
	failed(): void;
}

export interface CompletedGeneration {
	model: string;
	timestamp: number;
	metrics: GenerationMetrics;
}

/** Bootstrap heuristic: ~4 characters per token. */
export const DEFAULT_TOKENS_PER_CHAR = 0.25;

/** Rolling window the live estimate is measured over. */
const WINDOW_MS = 2000;

/** Below this span a rate is noise (10ms of output reads as thousands of tok/s). */
const MIN_SPAN_MS = 250;

interface Sample {
	t: number;
	tokens: number;
}

export class GenerationTelemetry implements TelemetrySink {
	private samples: Sample[] = [];
	private readonly now: () => number;
	private activeModel: string | undefined;
	private lastCompleted: CompletedGeneration | undefined;

	constructor(opts: { now?: () => number } = {}) {
		this.now = opts.now ?? Date.now;
	}

	started(model: string): void {
		this.activeModel = model;
		this.lastCompleted = undefined;
		this.samples = [];
	}

	progress(chars: number): void {
		if (this.activeModel === undefined || !(chars > 0)) return;
		const now = this.now();
		this.samples.push({ t: now, tokens: chars * DEFAULT_TOKENS_PER_CHAR });
		this.prune(now);
	}

	// Keep one sample at or before the window's edge as the anchor.
	private prune(now: number): void {
		while (this.samples.length > 1 && this.samples[1].t <= now - WINDOW_MS) {
			this.samples.shift();
		}
	}

	/** Estimated tok/s right now, or undefined when there's nothing to go on. */
	liveRate(): number | undefined {
		const now = this.now();
		this.prune(now);
		const first = this.samples[0];
		if (!first) return undefined;
		const elapsedMs = now - first.t;
		if (elapsedMs < MIN_SPAN_MS) return undefined;
		// The first sample only anchors the window's start: its tokens were
		// generated before the window opened.
		let tokens = 0;
		for (let i = 1; i < this.samples.length; i++) {
			tokens += this.samples[i].tokens;
		}
		return tokens / (elapsedMs / 1000);
	}

	completed(metrics: GenerationMetrics | undefined): void {
		const model = this.activeModel;
		this.activeModel = undefined;
		this.samples = [];
		if (model === undefined || metrics === undefined) return;
		this.lastCompleted = { model, timestamp: this.now(), metrics };
	}

	failed(): void {
		this.activeModel = undefined;
		this.samples = [];
		this.lastCompleted = undefined;
	}

	/**
	 * The completed measurement for the generation that just ended, once.
	 * Undefined when it failed, was cancelled, or Ollama sent no usable metrics.
	 */
	takeCompleted(): CompletedGeneration | undefined {
		const completed = this.lastCompleted;
		this.lastCompleted = undefined;
		return completed;
	}
}
