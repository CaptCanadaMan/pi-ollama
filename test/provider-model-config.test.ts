import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelConfig } from "../src/model-config.js";
import { requestOptions } from "../src/provider.js";
import { doneChunk, model, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

// What the per-model config puts on the wire: options, keep_alive, logprobs,
// and the idle timeout around the chat stream.

const user = { role: "user", content: "hi", timestamp: 1 };
const config = (raw: unknown) => loadModelConfig(raw, {}).config;

function stubChat() {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
		ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const sentBody = (fetchMock: ReturnType<typeof stubChat>, call = 0) =>
	JSON.parse(String(fetchMock.mock.calls[call]![1].body)) as Record<string, unknown>;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("requestOptions - per-model sampling and GPU options", () => {
	const modelConfig = config({
		defaults: { sampling: { topK: 40, topP: 0.9 }, gpu: { numBatch: 512 } },
		models: { [model.id]: { sampling: { topP: 0.95, temperature: 0.6 }, gpu: { numGpu: 99, mainGpu: 0 } } },
	});

	it("maps camelCase config to Ollama's option names, the model's own values winning", () => {
		expect(requestOptions({ id: model.id, contextWindow: 8192 }, { numCtx: 32768, modelConfig })).toEqual({
			num_ctx: 8192,
			temperature: 0.6,
			top_k: 40,
			top_p: 0.95,
			num_batch: 512,
			num_gpu: 99,
			main_gpu: 0,
		});
	});

	it("lets a temperature pi sends for the turn win over the config", () => {
		const options = requestOptions({ id: model.id }, { numCtx: 32768, modelConfig }, { temperature: 0.2 });
		expect(options.temperature).toBe(0.2);
	});

	it("sends numGpu -1 through as num_gpu -1, leaving the layer split to Ollama", () => {
		const auto = config({ models: { [model.id]: { gpu: { numGpu: -1 } } } });
		expect(requestOptions({ id: model.id }, { numCtx: 4096, modelConfig: auto })).toEqual({ num_ctx: 4096, num_gpu: -1 });
	});

	it("sends only num_ctx when nothing is configured", () => {
		expect(requestOptions({ id: "other" }, { numCtx: 4096, modelConfig: config({}) })).toEqual({ num_ctx: 4096 });
	});
});

describe("streamOllama - per-model request settings", () => {
	it("sends the model's keep_alive over the global one", async () => {
		const fetchMock = stubChat();
		const modelConfig = config({ models: { [model.id]: { keepAlive: "30m" } } });

		await runStream({ messages: [user] }, undefined, { settings: { keepAlive: "5m", modelConfig } });

		expect(sentBody(fetchMock).keep_alive).toBe("30m");
	});

	it("asks for logprobs only when request.logprobs is on", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] }, undefined, { settings: { modelConfig: config({}) } });
		await runStream({ messages: [user] }, undefined, {
			settings: { modelConfig: config({ defaults: { request: { logprobs: true } } }) },
		});

		expect(sentBody(fetchMock, 0)).not.toHaveProperty("logprobs");
		expect(sentBody(fetchMock, 1).logprobs).toBe(true);
	});

	it("retries a request that goes silent before anything arrives, then succeeds", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			calls++;
			if (calls === 1) {
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
			}
			return ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const modelConfig = config({ defaults: { request: { idleTimeoutMs: 1000, maxRetries: 1 } } });

		const end = await runStream({ messages: [user] }, undefined, { settings: { modelConfig } });

		expect(end.type).toBe("done");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("never retries once output has started - a mid-answer timeout is an error", async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify(textChunk("partial"))}\n`));
					init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
				},
			});
			return new Response(body, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const modelConfig = config({ defaults: { request: { idleTimeoutMs: 1000, maxRetries: 2 } } });

		const end = await runStream({ messages: [user] }, undefined, { settings: { modelConfig } });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(end.type).toBe("error");
		expect(end.error?.errorMessage).toMatch(/idle-timed-out: nothing received for 1s mid-response/);
	});

	it("explains an idle timeout instead of a bare abort once retries run out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_url: string, init: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					}),
			),
		);
		const modelConfig = config({ defaults: { request: { idleTimeoutMs: 1000, maxRetries: 0 } } });

		const end = await runStream({ messages: [user] }, undefined, { settings: { modelConfig } });

		expect(end.type).toBe("error");
		expect(end.error?.errorMessage).toMatch(/idle-timed-out: nothing received for 1s after 1 attempt/);
	});
});
