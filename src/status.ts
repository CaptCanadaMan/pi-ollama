// Throughput display + session records: pulls from the telemetry seam inside
// pi's message events, writes to the footer via ctx.ui.setStatus(), and
// appends each completed generation to the session via pi.appendEntry().
//
// Event handlers are where pi hands out a UI context, so nothing here (or in
// the provider) ever has to hold one. Everything is guarded: a pi too old to
// have on()/setStatus(), a mode with no UI, or a throwing UI call all degrade
// to "no status", never to a failed turn.

import { GENERATION_ENTRY_TYPE, toGenerationRecord } from "./stats.js";
import type { GenerationTelemetry } from "./telemetry.js";
import {
	formatEstimatedThroughput,
	formatExactThroughput,
} from "./throughput.js";

export const STATUS_KEY = "ollama-throughput";

/** Live-status cadence: readable, not flickering (message_update fires per delta). */
const LIVE_UPDATE_INTERVAL_MS = 400;

// Minimal structural types for the slice of pi's extension API used here.
interface StatusContext {
	hasUI?: boolean;
	ui?: { setStatus?: (key: string, text: string | undefined) => void };
}

interface MessageEvent {
	message?: { role?: string; provider?: string; api?: string };
}

export interface StatusPi {
	on?: (
		event: string,
		handler: (event: never, ctx: StatusContext) => void,
	) => void;
	appendEntry?: (customType: string, data?: unknown) => void;
}

function isOllamaAssistantMessage(event: MessageEvent): boolean {
	const m = event.message;
	return m?.role === "assistant" && m.api === "ollama-native";
}

function setStatus(ctx: StatusContext, text: string | undefined): void {
	try {
		if (ctx.hasUI === false) return;
		ctx.ui?.setStatus?.(STATUS_KEY, text);
	} catch {
		// Display is best-effort.
	}
}

export function registerThroughputStatus(
	pi: StatusPi,
	telemetry: GenerationTelemetry,
	opts: { now?: () => number } = {},
): void {
	if (typeof pi.on !== "function") return;
	const now = opts.now ?? Date.now;
	let lastLiveUpdate = 0;

	pi.on("message_update", (event: MessageEvent, ctx) => {
		if (!isOllamaAssistantMessage(event)) return;
		const t = now();
		if (t - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS) return;
		const rate = telemetry.liveRate();
		if (rate === undefined) return;
		lastLiveUpdate = t;
		setStatus(ctx, formatEstimatedThroughput(rate));
	});

	pi.on("message_end", (event: MessageEvent, ctx) => {
		if (!isOllamaAssistantMessage(event)) return;
		const completed = telemetry.takeCompleted();
		if (completed) {
			try {
				pi.appendEntry?.(GENERATION_ENTRY_TYPE, toGenerationRecord(completed));
			} catch {
				// Persistence is best-effort.
			}
		}
		setStatus(
			ctx,
			completed ? formatExactThroughput(completed.metrics) : undefined,
		);
	});

	// A figure from an ollama model says nothing about whatever comes next.
	pi.on("model_select", (event: { model?: { api?: string } }, ctx) => {
		if (event.model?.api !== "ollama-native") setStatus(ctx, undefined);
	});
}
