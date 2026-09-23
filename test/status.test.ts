import { describe, expect, it, vi } from "vitest";
import { registerThroughputStatus, STATUS_KEY } from "../src/status.js";
import { GenerationTelemetry } from "../src/telemetry.js";

// The extension layer owns display. It listens to pi's message events (the
// place pi hands out a UI context) and pulls from the telemetry seam. These
// tests fire events at a fake pi and watch what lands in the status bar.

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi() {
	const handlers = new Map<string, Handler>();
	return {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		fire: (event: string, payload: unknown, ctx: unknown) =>
			handlers.get(event)?.(payload, ctx),
	};
}

function fakeCtx() {
	return { hasUI: true, ui: { setStatus: vi.fn() } };
}

const ollamaMessage = { role: "assistant", provider: "ollama", api: "ollama-native" };

function completeGeneration(telemetry: GenerationTelemetry) {
	telemetry.started("gemma4:12b");
	telemetry.completed({
		outputTokens: 612,
		evalDurationNs: 12_938_689_217,
		tokensPerSecond: 47.3,
	});
}

describe("throughput status - exact figure at generation end", () => {
	it("shows Ollama's exact figure when an ollama message ends", () => {
		const pi = fakePi();
		const telemetry = new GenerationTelemetry();
		registerThroughputStatus(pi, telemetry);
		const ctx = fakeCtx();

		completeGeneration(telemetry);
		pi.fire("message_end", { message: ollamaMessage }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			STATUS_KEY,
			"47.3 tok/s · 612 tok",
		);
	});

	it("clears the status when the generation failed or was cancelled (no invented number)", () => {
		const pi = fakePi();
		const telemetry = new GenerationTelemetry();
		registerThroughputStatus(pi, telemetry);
		const ctx = fakeCtx();

		telemetry.started("gemma4:12b");
		telemetry.failed();
		pi.fire("message_end", { message: ollamaMessage }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
	});

	it("leaves other providers' messages and non-assistant messages alone", () => {
		const pi = fakePi();
		const telemetry = new GenerationTelemetry();
		registerThroughputStatus(pi, telemetry);
		const ctx = fakeCtx();

		completeGeneration(telemetry);
		pi.fire(
			"message_end",
			{ message: { role: "assistant", provider: "anthropic", api: "anthropic-messages" } },
			ctx,
		);
		pi.fire("message_end", { message: { role: "user" } }, ctx);

		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	it("clears the figure when the user switches to a non-ollama model", () => {
		const pi = fakePi();
		registerThroughputStatus(pi, new GenerationTelemetry());
		const ctx = fakeCtx();

		pi.fire("model_select", { model: { api: "anthropic-messages" } }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);

		ctx.ui.setStatus.mockClear();
		pi.fire("model_select", { model: { api: "ollama-native" } }, ctx);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	it("is harmless without a UI, on a pi without setStatus, or when the UI throws", () => {
		const pi = fakePi();
		const telemetry = new GenerationTelemetry();
		registerThroughputStatus(pi, telemetry);
		const event = { message: ollamaMessage };

		const headless = { hasUI: false, ui: { setStatus: vi.fn() } };
		completeGeneration(telemetry);
		pi.fire("message_end", event, headless);
		expect(headless.ui.setStatus).not.toHaveBeenCalled();

		completeGeneration(telemetry);
		expect(() => pi.fire("message_end", event, { ui: {} })).not.toThrow();

		const throwing = {
			ui: {
				setStatus: () => {
					throw new Error("tui exploded");
				},
			},
		};
		completeGeneration(telemetry);
		expect(() => pi.fire("message_end", event, throwing)).not.toThrow();

		expect(() =>
			registerThroughputStatus({}, new GenerationTelemetry()),
		).not.toThrow();
	});
});
