// Shared harness for tests that drive the real streamOllama against a stubbed
// fetch. The network is the only thing faked.

import { streamOllama } from "../src/provider.js";
import type { TelemetrySink } from "../src/telemetry.js";

export const settings = {
	baseUrl: "http://ollama.test",
	keepAlive: undefined,
	numCtx: 32768,
	ghostRetries: 2,
	contextLength: undefined,
	throughput: true,
};

export const model = { id: "gemma4:12b", api: "ollama-native", provider: "ollama" };

export function ndjsonResponse(chunks: object[]): Response {
	const body = chunks.map((c) => `${JSON.stringify(c)}\n`).join("");
	return new Response(body, { status: 200 });
}

export function textChunk(content: string) {
	return {
		model: model.id,
		created_at: "t",
		message: { role: "assistant", content },
		done: false,
	};
}

export function doneChunk(evalCount: number, evalDurationNs: number) {
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

/** The terminal event; `error` carries the assistant message on failures. */
export interface TerminalEvent {
	type: string;
	error?: { stopReason?: string; errorMessage?: string };
}

/** Run one streamOllama call to completion; resolve with the terminal event. */
export function runStream(
	context: Parameters<typeof streamOllama>[1],
	telemetry?: TelemetrySink,
	turn: {
		model?: Parameters<typeof streamOllama>[0];
		options?: Parameters<typeof streamOllama>[2];
		settings?: Partial<Parameters<typeof streamOllama>[3]>;
	} = {},
): Promise<TerminalEvent> {
	return new Promise((resolve) => {
		let last: TerminalEvent = { type: "none" };
		class FakeStream {
			push(event: unknown) {
				last = event as TerminalEvent;
			}
			end() {
				resolve(last);
			}
		}
		streamOllama(
			turn.model ?? model,
			context,
			turn.options,
			{ ...settings, ...turn.settings },
			FakeStream,
			telemetry,
		);
	});
}
