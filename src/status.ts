// Throughput display: pulls from the telemetry seam inside pi's message
// events and writes to the footer via ctx.ui.setStatus().
//
// Event handlers are where pi hands out a UI context, so nothing here (or in
// the provider) ever has to hold one. Everything is guarded: a pi too old to
// have on()/setStatus(), a mode with no UI, or a throwing UI call all degrade
// to "no status", never to a failed turn.

import type { GenerationTelemetry } from "./telemetry.js";
import { formatExactThroughput } from "./throughput.js";

export const STATUS_KEY = "ollama-throughput";

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
): void {
	if (typeof pi.on !== "function") return;

	pi.on("message_end", (event: MessageEvent, ctx) => {
		if (!isOllamaAssistantMessage(event)) return;
		const completed = telemetry.takeCompleted();
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
