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
	completed(metrics: GenerationMetrics | undefined): void;
	failed(): void;
}

export interface CompletedGeneration {
	model: string;
	timestamp: number;
	metrics: GenerationMetrics;
}

export class GenerationTelemetry implements TelemetrySink {
	private readonly now: () => number;
	private activeModel: string | undefined;
	private lastCompleted: CompletedGeneration | undefined;

	constructor(opts: { now?: () => number } = {}) {
		this.now = opts.now ?? Date.now;
	}

	started(model: string): void {
		this.activeModel = model;
		this.lastCompleted = undefined;
	}

	completed(metrics: GenerationMetrics | undefined): void {
		const model = this.activeModel;
		this.activeModel = undefined;
		if (model === undefined || metrics === undefined) return;
		this.lastCompleted = { model, timestamp: this.now(), metrics };
	}

	failed(): void {
		this.activeModel = undefined;
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
