import { describe, expect, it } from "vitest";
import { GenerationTelemetry } from "../src/telemetry.js";

// The live figure is an estimate: streamed characters x a tokens-per-character
// ratio, measured over a short rolling window so model load and prompt
// evaluation never drag the displayed generation rate down. Time is injected -
// no test here sleeps.

function clocked() {
	let t = 1_000_000;
	const telemetry = new GenerationTelemetry({ now: () => t });
	return {
		telemetry,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** Stream `chars` characters every `everyMs`, `times` times. */
function stream(
	c: ReturnType<typeof clocked>,
	chars: number,
	everyMs: number,
	times: number,
) {
	for (let i = 0; i < times; i++) {
		c.advance(everyMs);
		c.telemetry.progress(chars);
	}
}

describe("live estimate - rolling window over streamed characters", () => {
	it("estimates tok/s at ~4 characters per token before any calibration", () => {
		const c = clocked();
		c.telemetry.started("gemma4:12b");
		c.telemetry.progress(4);
		stream(c, 4, 100, 10); // 4 chars = ~1 token every 100ms

		expect(c.telemetry.liveRate()).toBeCloseTo(10);
	});

	it("forgets samples older than the window, so a slow start doesn't drag the figure down", () => {
		const c = clocked();
		c.telemetry.started("gemma4:12b");
		stream(c, 4, 1000, 5); // crawling: 1 tok/s for 5s
		stream(c, 4, 20, 150); // then 50 tok/s for 3s

		expect(c.telemetry.liveRate()).toBeCloseTo(50, 0);
	});

	it("shows nothing until there is enough signal to mean something", () => {
		const c = clocked();
		expect(c.telemetry.liveRate()).toBeUndefined(); // idle

		c.telemetry.started("gemma4:12b");
		expect(c.telemetry.liveRate()).toBeUndefined(); // no output yet

		c.telemetry.progress(400);
		expect(c.telemetry.liveRate()).toBeUndefined(); // one sample, zero elapsed

		c.advance(10);
		c.telemetry.progress(400);
		expect(c.telemetry.liveRate()).toBeUndefined(); // 10ms would read as thousands of tok/s
	});

	it("starts every generation from zero - a retry never inherits abandoned progress", () => {
		const c = clocked();
		c.telemetry.started("gemma4:12b");
		stream(c, 400, 100, 10); // a fast attempt that then fails
		c.telemetry.failed();

		c.telemetry.started("gemma4:12b");
		c.telemetry.progress(4);
		stream(c, 4, 100, 10);

		expect(c.telemetry.liveRate()).toBeCloseTo(10);
	});

	it("stops estimating once the generation ends, either way", () => {
		const c = clocked();
		c.telemetry.started("gemma4:12b");
		stream(c, 4, 100, 10);
		c.telemetry.completed(undefined);
		expect(c.telemetry.liveRate()).toBeUndefined();

		c.telemetry.started("gemma4:12b");
		stream(c, 4, 100, 10);
		c.telemetry.failed();
		expect(c.telemetry.liveRate()).toBeUndefined();
	});

	it("decays toward zero when the stream stalls instead of freezing on the last figure", () => {
		const c = clocked();
		c.telemetry.started("gemma4:12b");
		c.telemetry.progress(4);
		stream(c, 4, 100, 10);
		const flowing = c.telemetry.liveRate() ?? 0;

		c.advance(1500);
		const stalled = c.telemetry.liveRate() ?? 0;

		expect(stalled).toBeLessThan(flowing / 2);
	});
});
