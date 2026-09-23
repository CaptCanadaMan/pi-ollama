import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllama } from "../src/provider.js";
import { GenerationTelemetry } from "../src/telemetry.js";

// Lifecycle tests drive the real streamOllama against a stubbed fetch (the
// network is the only thing faked), and observe what a consumer of the
// telemetry seam would see. The provider reports what happened; it knows
// nothing about status bars or session records.

const settings = {
	baseUrl: "http://ollama.test",
	keepAlive: undefined,
	numCtx: 32768,
	ghostRetries: 2,
	contextLength: undefined,
	throughput: true,
};

const model = { id: "gemma4:12b", api: "ollama-native", provider: "ollama" };
const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function ndjsonResponse(chunks: object[]): Response {
	const body = chunks.map((c) => `${JSON.stringify(c)}\n`).join("");
	return new Response(body, { status: 200 });
}

function textChunk(content: string) {
	return {
		model: model.id,
		created_at: "t",
		message: { role: "assistant", content },
		done: false,
	};
}

function doneChunk(evalCount: number, evalDurationNs: number) {
	return {
		model: model.id,
		created_at: "t",
		message: { role: "assistant", content: "" },
		done: true,
		done_reason: "stop",
		prompt_eval_count: 10,
		eval_count: evalCount,
		eval_duration: evalDurationNs,
	};
}

/** Run one streamOllama call to completion; resolve with the terminal event. */
function run(telemetry: GenerationTelemetry): Promise<{ type: string }> {
	return new Promise((resolve) => {
		let last: { type: string } = { type: "none" };
		class FakeStream {
			push(event: unknown) {
				last = event as { type: string };
			}
			end() {
				resolve(last);
			}
		}
		streamOllama(model, context, undefined, settings, FakeStream, telemetry);
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("provider → telemetry seam", () => {
	it("hands a completed generation's exact Ollama metrics to the consumer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([textChunk("Hello"), doneChunk(100, 500_000_000)]),
			),
		);
		const telemetry = new GenerationTelemetry();

		const terminal = await run(telemetry);

		expect(terminal.type).toBe("done");
		const completed = telemetry.takeCompleted();
		expect(completed?.model).toBe("gemma4:12b");
		expect(completed?.metrics.tokensPerSecond).toBeCloseTo(200);
		expect(completed?.metrics.outputTokens).toBe(100);
	});

	it("reports only the accepted attempt when a ghost response is retried", async () => {
		const ghost = doneChunk(999, 1_000_000_000); // tokens evaluated, nothing streamed
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(ndjsonResponse([ghost]))
			.mockResolvedValueOnce(
				ndjsonResponse([textChunk("Hello"), doneChunk(100, 500_000_000)]),
			);
		vi.stubGlobal("fetch", fetchMock);
		const telemetry = new GenerationTelemetry();
		const started = vi.spyOn(telemetry, "started");

		const terminal = await run(telemetry);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(terminal.type).toBe("done");
		expect(started).toHaveBeenCalledTimes(1);
		expect(telemetry.takeCompleted()?.metrics.outputTokens).toBe(100);
	});

	it("fabricates no measurement when the stream is truncated", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([textChunk("Hel"), textChunk("lo")])),
		);
		const telemetry = new GenerationTelemetry();

		const terminal = await run(telemetry);

		expect(terminal.type).toBe("error");
		expect(telemetry.takeCompleted()).toBeUndefined();
	});

	it("completes the turn without a measurement when Ollama omits the metrics", async () => {
		const bare = { ...doneChunk(0, 0), eval_count: undefined, eval_duration: undefined };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([textChunk("Hello"), bare])),
		);
		const telemetry = new GenerationTelemetry();

		const terminal = await run(telemetry);

		expect(terminal.type).toBe("done");
		expect(telemetry.takeCompleted()).toBeUndefined();
	});

	it("delivers the response untouched when the telemetry sink throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([textChunk("Hello"), doneChunk(100, 500_000_000)]),
			),
		);
		const telemetry = new GenerationTelemetry();
		for (const method of ["started", "completed", "failed"] as const) {
			vi.spyOn(telemetry, method).mockImplementation(() => {
				throw new Error("sink exploded");
			});
		}

		const terminal = (await run(telemetry)) as {
			type: string;
			message?: { content: Array<{ text?: string }> };
		};

		expect(terminal.type).toBe("done");
		expect(terminal.message?.content[0]?.text).toBe("Hello");
	});

	it("hands each measurement out once", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([textChunk("Hello"), doneChunk(100, 500_000_000)]),
			),
		);
		const telemetry = new GenerationTelemetry();
		await run(telemetry);

		expect(telemetry.takeCompleted()).toBeDefined();
		expect(telemetry.takeCompleted()).toBeUndefined();
	});
});
