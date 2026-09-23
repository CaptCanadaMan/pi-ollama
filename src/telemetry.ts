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

import { RatioCalibrator } from "./calibration.js";
import type { GenerationMetrics } from "./throughput.js";

/** What the provider reports. It knows nothing about rendering or storage. */
export interface TelemetrySink {
	started(model: string): void;
	/** Characters of generated text/thinking just streamed. */
	progress(chars: number): void;
	completed(
		metrics: GenerationMetrics | undefined,
		info?: { sawToolCalls?: boolean },
	): void;
	failed(): void;
}

export interface CompletedGeneration {
	model: string;
	timestamp: number;
	metrics: GenerationMetrics;
}

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
	private readonly calibrator = new RatioCalibrator();
	private ratio = this.calibrator.ratioFor("");
	private charsStreamed = 0;
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
		this.ratio = this.calibrator.ratioFor(model);
		this.charsStreamed = 0;
	}

	progress(chars: number): void {
		if (this.activeModel === undefined || !(chars > 0)) return;
		const now = this.now();
		this.charsStreamed += chars;
		this.samples.push({ t: now, tokens: chars * this.ratio });
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

	completed(
		metrics: GenerationMetrics | undefined,
		info: { sawToolCalls?: boolean } = {},
	): void {
		const model = this.activeModel;
		this.activeModel = undefined;
		this.samples = [];
		if (model === undefined || metrics === undefined) return;
		// eval_count includes tool-call tokens, which never stream as characters -
		// a tool-call turn would teach a badly inflated ratio.
		if (!info.sawToolCalls) {
			this.calibrator.observe(model, metrics.outputTokens, this.charsStreamed);
		}
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
