import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationTelemetry } from "../src/telemetry.js";
import { doneChunk, model, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// Lifecycle tests drive the real streamOllama against a stubbed fetch (the
// network is the only thing faked), and observe what a consumer of the
// telemetry seam would see. The provider reports what happened; it knows
// nothing about status bars or session records.

const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const run = (telemetry: GenerationTelemetry) => runStream(context, telemetry);

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

	it("reports streamed text and thinking as progress, but not tool-call serialization", async () => {
		const thinking = {
			model: model.id,
			created_at: "t",
			message: { role: "assistant", content: "", thinking: "Hmm" },
			done: false,
		};
		const toolCall = {
			model: model.id,
			created_at: "t",
			message: {
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "read", arguments: { path: "a-long-path.txt" } } }],
			},
			done: false,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([thinking, textChunk("Hello"), toolCall, doneChunk(100, 5e8)]),
			),
		);
		const telemetry = new GenerationTelemetry();
		const progress = vi.spyOn(telemetry, "progress");

		await run(telemetry);

		const totalChars = progress.mock.calls.reduce((sum, [n]) => sum + n, 0);
		expect(totalChars).toBe("Hmm".length + "Hello".length);
	});
});
