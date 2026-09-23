import { describe, expect, it, vi } from "vitest";
import { GENERATION_ENTRY_TYPE } from "../src/stats.js";
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

describe("throughput status - live estimate while streaming", () => {
	function liveSetup() {
		let t = 1_000_000;
		const now = () => t;
		const pi = fakePi();
		const telemetry = new GenerationTelemetry({ now });
		registerThroughputStatus(pi, telemetry, { now });
		const ctx = fakeCtx();
		/** One streamed delta: ~1 token, 100ms later, then pi's message_update. */
		const delta = () => {
			t += 100;
			telemetry.progress(4);
			pi.fire("message_update", { message: ollamaMessage }, ctx);
		};
		return { pi, telemetry, ctx, delta };
	}

	it("shows a marked estimate as deltas stream", () => {
		const { telemetry, ctx, delta } = liveSetup();
		telemetry.started("gemma4:12b");
		for (let i = 0; i < 10; i++) delta();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "≈10 tok/s");
	});

	it("updates at a readable cadence, not on every delta", () => {
		const { telemetry, ctx, delta } = liveSetup();
		telemetry.started("gemma4:12b");
		for (let i = 0; i < 50; i++) delta(); // 5 seconds of streaming

		const updates = ctx.ui.setStatus.mock.calls.length;
		expect(updates).toBeGreaterThanOrEqual(5);
		expect(updates).toBeLessThanOrEqual(15); // ~2-3 per second at most
	});

	it("hands over from the estimate to the exact figure when the message ends", () => {
		const { pi, telemetry, ctx, delta } = liveSetup();
		telemetry.started("gemma4:12b");
		for (let i = 0; i < 10; i++) delta();
		telemetry.completed({
			outputTokens: 612,
			evalDurationNs: 12_938_689_217,
			tokensPerSecond: 47.3,
		});
		pi.fire("message_end", { message: ollamaMessage }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			STATUS_KEY,
			"47.3 tok/s · 612 tok",
		);
	});
});

describe("session records - completed generations persist as custom session entries", () => {
	it("appends one record per completed generation, outside the LLM context", () => {
		const pi = { ...fakePi(), appendEntry: vi.fn() };
		const telemetry = new GenerationTelemetry({ now: () => 1_700_000_000_000 });
		registerThroughputStatus(pi, telemetry);

		telemetry.started("gemma4:12b");
		telemetry.completed({
			outputTokens: 612,
			evalDurationNs: 12_938_689_217,
			tokensPerSecond: 47.3,
			promptTokens: 2048,
		});
		pi.fire("message_end", { message: ollamaMessage }, fakeCtx());

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(GENERATION_ENTRY_TYPE, {
			model: "gemma4:12b",
			timestamp: 1_700_000_000_000,
			outputTokens: 612,
			evalDurationNs: 12_938_689_217,
			tokensPerSecond: 47.3,
			promptTokens: 2048,
		});
	});

	it("records nothing for a failed generation, and survives a pi without appendEntry", () => {
		const pi = { ...fakePi(), appendEntry: vi.fn() };
		const telemetry = new GenerationTelemetry();
		registerThroughputStatus(pi, telemetry);
		telemetry.started("gemma4:12b");
		telemetry.failed();
		pi.fire("message_end", { message: ollamaMessage }, fakeCtx());
		expect(pi.appendEntry).not.toHaveBeenCalled();

		const oldPi = fakePi();
		const t2 = new GenerationTelemetry();
		registerThroughputStatus(oldPi, t2);
		completeGeneration(t2);
		expect(() =>
			oldPi.fire("message_end", { message: ollamaMessage }, fakeCtx()),
		).not.toThrow();
	});
});
