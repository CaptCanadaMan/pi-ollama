// Native Ollama /api/chat streaming provider.
//
// Talks directly to Ollama's NDJSON endpoint, bypassing the OpenAI-compat
// shim at /v1/chat/completions which silently drops tool_calls from streamed
// deltas (ollama#12557). This is the core of the extension — all other modules
// exist to configure and feed this function.
//
// Reliability defences:
//   Ghost-token retry — Ollama occasionally generates output tokens but streams
//   nothing visible (done:true, eval_count > 0, empty message). The provider
//   detects this on the first NDJSON line and retries up to OLLAMA_NATIVE_GHOST_RETRIES
//   times (default 2). At 20% per-attempt failure rate, 2 retries → 99.2% success.
//
//   Truncation detection — if the connection closes before a done:true chunk
//   arrives, partial events have already been pushed to the consumer so we can't
//   retry safely. We surface a clear error instead of silently accepting partial
//   output.

import { dbg, dumpRequest, dumpResponseLine } from "./debug.js";
import { convertMessages, convertTools } from "./convert.js";
import type { OllamaChunk, OllamaRequest } from "./wire.js";
import type { OllamaExtensionSettings } from "./settings.js";

// ============================================================================
// Types — minimal structural interfaces that match pi-ai's shapes.
// We declare them locally to avoid a hard import-time dependency on the exact
// installed version of @mariozechner/pi-ai.
// ============================================================================

interface PiModel {
	id: string;
	api: string;
	provider?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
}

interface PiContext {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: PiTool[];
}

interface PiTool {
	name: string;
	description: string;
	parameters: object;
}

interface PiSimpleStreamOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
	temperature?: number;
	maxTokens?: number;
	onPayload?: (body: unknown, model: PiModel) => Promise<unknown> | unknown;
	onResponse?: (
		info: { status: number; headers: Record<string, string> },
		model: PiModel,
	) => Promise<void> | void;
}

// Matches AssistantMessageEventStream's push/end interface.
interface EventStream {
	push(event: unknown): void;
	end(): void;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_NUM_CTX = 32768;
const DEFAULT_KEEP_ALIVE = "5m";

// ============================================================================
// Ghost-token detection
// ============================================================================

function isGhostChunk(chunk: OllamaChunk): boolean {
	if (!chunk.done) return false;
	if ((chunk.eval_count ?? 0) === 0) return false;
	const m = chunk.message;
	if (!m) return true;
	const hasContent =
		(m.content && m.content.length > 0) ||
		(m.thinking && m.thinking.length > 0) ||
		(m.tool_calls && m.tool_calls.length > 0);
	return !hasContent;
}

// ============================================================================
// Tool-call ID generation (fallback when Ollama omits one)
// ============================================================================

let toolCallCounter = 0;

function generateToolCallId(): string {
	return `ollama_${Date.now()}_${++toolCallCounter}`;
}

// ============================================================================
// Stop-reason mapping
// ============================================================================

function mapDoneReason(reason: string | undefined): string {
	switch (reason) {
		case "stop":
		case "end":
		case undefined:
			return "stop";
		case "length":
			return "length";
		default:
			return "stop";
	}
}

// ============================================================================
// Main streaming function
// ============================================================================

export function streamOllama(
	model: PiModel,
	context: PiContext,
	options: PiSimpleStreamOptions | undefined,
	settings: OllamaExtensionSettings,
	StreamClass: new () => EventStream,
): EventStream {
	const stream = new StreamClass();

	(async () => {
		// Build the output message shell — populated incrementally as chunks arrive.
		const output: Record<string, unknown> = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider ?? "ollama",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const baseUrl = (model.baseUrl || settings.baseUrl).replace(/\/+$/, "");
			const url = `${baseUrl}/api/chat`;

			const supportsVision = model.input?.includes("image") ?? false;
			const piMessages = context.messages as Parameters<typeof convertMessages>[0];

			const messages = convertMessages(
				piMessages,
				context.systemPrompt,
				supportsVision,
			);

			const numCtx = model.contextWindow ?? settings.numCtx ?? DEFAULT_NUM_CTX;

			const requestOptions: OllamaRequest["options"] = { num_ctx: numCtx };
			if (options?.temperature !== undefined) {
				requestOptions.temperature = options.temperature;
			}
			if (options?.maxTokens !== undefined) {
				requestOptions.num_predict = options.maxTokens;
			}

			let body: OllamaRequest = {
				model: model.id,
				messages,
				stream: true,
				options: requestOptions,
				keep_alive: settings.keepAlive ?? DEFAULT_KEEP_ALIVE,
			};

			if (context.tools && context.tools.length > 0) {
				body.tools = convertTools(context.tools);
			}

			// Allow callers to inspect or replace the request body.
			if (options?.onPayload) {
				const next = await options.onPayload(body, model);
				if (next !== undefined) body = next as OllamaRequest;
			}

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};

			dbg("request", {
				url,
				model: body.model,
				messages: body.messages.length,
				tools: body.tools?.length ?? 0,
				num_ctx: body.options?.num_ctx,
				lastMessageRole: body.messages[body.messages.length - 1]?.role,
			});

			// ── Ghost-token retry loop ──────────────────────────────────────────
			// Read the first NDJSON line of each attempt. If it's a ghost chunk
			// (done:true, eval_count > 0, empty message) cancel and retry.
			// On a healthy response, prepend the first line to initialBuffer so
			// the main streaming loop processes it normally.

			const maxRetries = settings.ghostRetries;
			let dumpId: string | null = null;
			let reader!: ReadableStreamDefaultReader<Uint8Array>;
			let initialBuffer = "";
			let ghostAttempts = 0;
			const decoder = new TextDecoder();

			while (true) {
				dumpId = dumpRequest(body);

				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: options?.signal,
				});

				if (options?.onResponse) {
					const hdrs: Record<string, string> = {};
					response.headers.forEach((v, k) => { hdrs[k] = v; });
					await options.onResponse({ status: response.status, headers: hdrs }, model);
				}

				dbg("response-status", {
					status: response.status,
					ok: response.ok,
					attempt: ghostAttempts,
				});

				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(
						`Ollama /api/chat returned HTTP ${response.status}: ${text.slice(0, 500)}`,
					);
				}
				if (!response.body) {
					throw new Error("Ollama /api/chat returned no response body");
				}

				reader = response.body.getReader();

				// Read until we have at least one complete NDJSON line.
				let buf = "";
				let firstLine: string | null = null;
				let streamEndedEarly = false;

				while (firstLine === null) {
					const { value, done: streamDone } = await reader.read();
					if (streamDone) {
						streamEndedEarly = true;
						break;
					}
					buf += decoder.decode(value, { stream: true });
					const nl = buf.indexOf("\n");
					if (nl !== -1) {
						firstLine = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!firstLine) firstLine = null; // empty line — keep looking
					}
				}

				// Defensive structure: only short-circuit when there's nothing to
				// inspect. If we have a firstLine — even one that arrived alongside
				// a stream-end signal — we still want to check it for ghost-chunk
				// patterns and preserve it in initialBuffer for the main loop.
				// This decouples correctness from the inner loop's exit invariants.
				if (streamEndedEarly && firstLine === null) {
					initialBuffer = buf;
					break;
				}

				let firstChunk: OllamaChunk | null = null;
				if (firstLine !== null) {
					try {
						firstChunk = JSON.parse(firstLine) as OllamaChunk;
					} catch {
						firstChunk = null;
					}
				}

				// firstLine !== null is implied by firstChunk being non-null (firstChunk
				// is only assigned inside the `if (firstLine !== null)` parse block), but
				// the explicit check is needed for TS narrowing of dumpResponseLine.
				if (firstLine !== null && firstChunk && isGhostChunk(firstChunk)) {
					dbg("ghost-detected", {
						attempt: ghostAttempts,
						evalCount: firstChunk.eval_count,
						maxRetries,
					});
					dbg("chunk", firstLine);
					dumpResponseLine(dumpId, firstLine);

					await reader.cancel().catch(() => undefined);

					ghostAttempts++;
					if (ghostAttempts > maxRetries) {
						throw new Error(
							`Ollama returned ghost tokens (${firstChunk.eval_count} evaluated, none streamed) ` +
								`after ${maxRetries + 1} attempt(s). This is an Ollama-side reliability issue: ` +
								`tokens are generated internally but the streamed response contains no content, ` +
								`thinking, or tool calls. Set OLLAMA_NATIVE_GHOST_RETRIES=N to increase tolerance.`,
						);
					}
					continue;
				}

				// Healthy or unparseable — preserve firstLine if we have one, so the
				// main loop can attempt parsing too (and surface a clear error if it
				// was malformed). This handles the case where the stream delivered
				// content alongside its done signal in a single read.
				initialBuffer = (firstLine !== null ? `${firstLine}\n` : "") + buf;
				break;
			}

			stream.push({ type: "start", partial: output });

			// ── Content block helpers ───────────────────────────────────────────

			type Block =
				| { type: "text"; text: string }
				| { type: "thinking"; thinking: string }
				| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

			const blocks = output.content as Block[];
			let currentBlock: Block | null = null;

			const blockIndex = () => blocks.length - 1;

			const finishBlock = (block: typeof currentBlock) => {
				if (!block) return;
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					stream.push({
						type: "toolcall_end",
						contentIndex: blockIndex(),
						toolCall: block,
						partial: output,
					});
				}
			};

			// ── Main streaming loop ─────────────────────────────────────────────
			// Drain-first: process any complete lines already in the buffer before
			// issuing another reader.read(). This is required because the ghost
			// retry loop may have seeded initialBuffer with real content.

			let buffer = initialBuffer;
			let sawToolCalls = false;
			let sawDoneChunk = false;
			let chunksReceived = 0;
			let streamDoneFlag = false;

			outer: while (true) {
				while (true) {
					const nl = buffer.indexOf("\n");
					if (nl === -1) break;
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;

					chunksReceived++;
					dbg("chunk", line);
					dumpResponseLine(dumpId, line);

					let chunk: OllamaChunk;
					try {
						chunk = JSON.parse(line) as OllamaChunk;
					} catch (e) {
						dbg("parse-error", { line, error: String(e) });
						continue;
					}

					if (chunk.error) {
						throw new Error(`Ollama returned error: ${chunk.error}`);
					}

					if (!output.responseId && chunk.created_at) {
						output.responseId = `ollama-${chunk.created_at}-${chunk.model}`;
					}

					const m = chunk.message;
					if (m) {
						// Thinking deltas
						if (m.thinking !== undefined && m.thinking.length > 0) {
							if (!currentBlock || currentBlock.type !== "thinking") {
								finishBlock(currentBlock);
								currentBlock = { type: "thinking", thinking: "" };
								blocks.push(currentBlock);
								stream.push({
									type: "thinking_start",
									contentIndex: blockIndex(),
									partial: output,
								});
							}
							currentBlock.thinking += m.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: m.thinking,
								partial: output,
							});
						}

						// Text deltas
						if (m.content !== undefined && m.content.length > 0) {
							if (!currentBlock || currentBlock.type !== "text") {
								finishBlock(currentBlock);
								currentBlock = { type: "text", text: "" };
								blocks.push(currentBlock);
								stream.push({
									type: "text_start",
									contentIndex: blockIndex(),
									partial: output,
								});
							}
							currentBlock.text += m.content;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: m.content,
								partial: output,
							});
						}

						// Tool calls — Ollama delivers each as a complete parsed object.
						// Emit start+delta+end as a synchronous burst (mirrors google.ts).
						if (m.tool_calls && m.tool_calls.length > 0) {
							if (currentBlock) {
								finishBlock(currentBlock);
								currentBlock = null;
							}
							sawToolCalls = true;

							for (const wireTc of m.tool_calls) {
								const args = wireTc.function.arguments ?? {};
								const argsString = JSON.stringify(args);

								const providedId = wireTc.id;
								const isDuplicate =
									providedId !== undefined &&
									blocks.some(
										(b) => b.type === "toolCall" && b.id === providedId,
									);
								const id =
									!providedId || isDuplicate
										? generateToolCallId()
										: providedId;

								const toolCall: Block & { type: "toolCall" } = {
									type: "toolCall",
									id,
									name: wireTc.function.name,
									arguments: args,
								};

								blocks.push(toolCall);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(),
									partial: output,
								});
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: argsString,
									partial: output,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: blockIndex(),
									toolCall,
									partial: output,
								});
							}
						}
					}

					if (chunk.done) {
						sawDoneChunk = true;
						finishBlock(currentBlock);
						currentBlock = null;

						const inputTokens = chunk.prompt_eval_count ?? 0;
						const outputTokens = chunk.eval_count ?? 0;
						output.usage = {
							input: inputTokens,
							output: outputTokens,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: inputTokens + outputTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};

						// Ollama returns done_reason:"stop" even on tool-call turns.
						output.stopReason = sawToolCalls
							? "toolUse"
							: mapDoneReason(chunk.done_reason);

						break outer;
					}
				}

				if (streamDoneFlag) break;
				const { value, done: streamDone } = await reader.read();
				if (streamDone) {
					dbg("stream-end", { reason: "reader-done", buffered: buffer.length });
					streamDoneFlag = true;
					continue;
				}
				buffer += decoder.decode(value, { stream: true });
			}

			finishBlock(currentBlock);

			dbg("done", {
				stopReason: output.stopReason,
				sawToolCalls,
				chunksReceived,
				contentBlocks: blocks.length,
				blockTypes: blocks.map((b) => b.type),
				inputTokens: (output.usage as Record<string, number>).input,
				outputTokens: (output.usage as Record<string, number>).output,
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// Empty response: the connection closed before any chunk arrived.
			// Indicates Ollama crashed, the model failed to load, or an upstream
			// network issue. Distinct from truncation (which has partial chunks).
			if (!sawDoneChunk && chunksReceived === 0) {
				dbg("empty-response", { chunksReceived, bufferLength: buffer.length });
				throw new Error(
					`Ollama stream ended without sending any chunks. Check Ollama logs — ` +
						`the model may have failed to load, the server may have closed the ` +
						`connection, or an upstream network issue may have occurred. Retry the request.`,
				);
			}

			// Truncation: real content arrived but the connection closed without
			// a done:true terminator. Can't auto-retry — events already emitted.
			if (!sawDoneChunk && chunksReceived > 0) {
				dbg("truncated", {
					chunksReceived,
					blockTypes: blocks.map((b) => b.type),
				});
				throw new Error(
					`Ollama stream truncated mid-response: received ${chunksReceived} chunk(s) of ` +
						`${blocks.map((b) => b.type).join("+") || "no"} content, but the connection ` +
						`closed before any chunk with done:true was emitted. This is an Ollama-side ` +
						`reliability issue, often triggered when the model attempts to generate a tool ` +
						`call. Retry the turn.`,
				);
			}

			// Post-stream ghost check: eval_count > 0 but nothing visible arrived.
			const hasMeaningfulContent = blocks.some(
				(b) =>
					(b.type === "text" && (b as { type: "text"; text: string }).text.trim().length > 0) ||
					(b.type === "thinking" &&
						(b as { type: "thinking"; thinking: string }).thinking.trim().length > 0) ||
					b.type === "toolCall",
			);
			const outputTokens = (output.usage as Record<string, number>).output ?? 0;
			if (outputTokens > 0 && !hasMeaningfulContent) {
				dbg("ghost-tokens", { evalCount: outputTokens, chunksReceived });
				throw new Error(
					`Ollama generated ${outputTokens} output tokens but streamed no visible content, ` +
						`thinking, or tool calls. This is usually caused by a malformed tool call that ` +
						`Ollama's parser silently swallowed. Retry the request or rephrase.`,
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : JSON.stringify(error);
			dbg("error", {
				stopReason: output.stopReason,
				message: output.errorMessage,
			});
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
