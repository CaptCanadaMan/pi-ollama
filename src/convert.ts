// Converts pi's internal message and tool types to Ollama's /api/chat wire format.
//
// Key decisions:
//   - Thinking blocks from prior assistant turns are dropped. Ollama re-derives
//     reasoning each turn; round-tripping past thinking adds prompt tokens with
//     no behaviour gain.
//   - Images in user messages are passed as base64 strings in the images array.
//     Only included when the model's vision flag is true.
//   - Tool results map to role:"tool" with a tool_name field (Ollama's format,
//     distinct from the OpenAI shim's format).
//   - Aborted/errored assistant turns and the tool results that follow them are
//     stripped before conversion so Ollama never receives orphaned messages.

import { dbg } from "./debug.js";
import type { OllamaTool, OllamaWireMessage } from "./wire.js";

// ============================================================================
// Minimal pi message type declarations (structural — matched at runtime).
// These mirror the shapes in @earendil-works/pi-ai without importing the package,
// avoiding a hard runtime dependency on the installed version.
// ============================================================================

interface TextContent {
	type: "text";
	text: string;
}

interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface ImageContent {
	type: "image";
	data: string; // base64
	mediaType?: string;
}

type ContentBlock = TextContent | ThinkingContent | ToolCallContent | ImageContent;

interface UserMessage {
	role: "user";
	content: string | ContentBlock[];
}

interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	stopReason?: string;
}

interface ToolResultMessage {
	role: "toolResult";
	toolName: string;
	toolCallId: string;
	content: ContentBlock[];
}

type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

interface PiTool {
	name: string;
	description: string;
	parameters: object;
}

// ============================================================================
// Public API
// ============================================================================

export function convertMessages(
	messages: readonly PiMessage[],
	systemPrompt: string | undefined,
	supportsVision: boolean,
): OllamaWireMessage[] {
	const out: OllamaWireMessage[] = [];

	if (systemPrompt) {
		out.push({ role: "system", content: sanitize(systemPrompt) });
	}

	for (const msg of normalizeMessages(messages)) {
		if (msg.role === "user") {
			const wire = convertUser(msg as UserMessage, supportsVision);
			if (wire) out.push(wire);
		} else if (msg.role === "assistant") {
			const wire = convertAssistant(msg as AssistantMessage);
			if (wire) out.push(wire);
		} else if (msg.role === "toolResult") {
			out.push(convertToolResult(msg as ToolResultMessage, supportsVision));
		} else {
			// Unknown role — pi's compat flags should convert developer→system
			// before reaching us, but log if anything else arrives so we can
			// diagnose during the smoke test instead of silently dropping.
			dbg("unknown-role", { role: (msg as { role: string }).role });
		}
	}

	return out;
}

// pi >= 0.86 hands providers a normalized transcript: the system prompt and
// tool declarations are carried as role:"system" messages inside `messages`
// (content + named sections, toolsAdded/toolsRemoved deltas) instead of
// `systemPrompt` / `tools`. Mirrors pi-ai's getCurrentSystemPrompt() /
// getCurrentTools() / collapseSystemMessages(), reimplemented structurally so
// we don't depend on the installed pi-ai exporting them (issue #11).

interface PiSystemMessage {
	role: "system";
	content: string | ContentBlock[];
	sections?: Record<string, string | null>;
	toolsAdded?: PiTool[];
	toolsRemoved?: { name: string }[];
}

export interface PiContextLike {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: PiTool[];
}

export interface ResolvedContext {
	systemPrompt: string | undefined;
	messages: PiMessage[];
	tools: PiTool[];
}

/**
 * Resolve the system prompt, tool list and conversation messages from either
 * context contract. Old-style contexts (no system messages) pass through;
 * transcript contexts have every system message replayed into one prompt and
 * one tool set, and are dropped from the message list.
 */
export function resolveContext(context: PiContextLike): ResolvedContext {
	const systemMessages = context.messages.filter(
		(m): m is PiSystemMessage => (m as { role?: string })?.role === "system",
	);
	if (systemMessages.length === 0) {
		return {
			systemPrompt: context.systemPrompt,
			messages: context.messages as PiMessage[],
			tools: context.tools ?? [],
		};
	}

	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, PiTool>();
	for (const msg of systemMessages) {
		const text =
			typeof msg.content === "string"
				? msg.content
				: msg.content.filter(isText).map((b) => b.text).join("\n");
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(msg.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const t of msg.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of msg.toolsAdded ?? []) tools.set(t.name, t);
	}
	const prompt = [content.join("\n\n"), ...sections.values()]
		.filter((p) => p.length > 0)
		.join("\n\n");

	return {
		systemPrompt: prompt.length > 0 ? prompt : context.systemPrompt,
		messages: context.messages.filter(
			(m) => (m as { role?: string })?.role !== "system",
		) as PiMessage[],
		tools: tools.size > 0 ? [...tools.values()] : (context.tools ?? []),
	};
}

export function convertTools(tools: PiTool[]): OllamaTool[] {
	return tools.map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

// ============================================================================
// Per-role converters
// ============================================================================

function convertUser(
	msg: UserMessage,
	supportsVision: boolean,
): OllamaWireMessage | null {
	if (typeof msg.content === "string") {
		return { role: "user", content: sanitize(msg.content) };
	}

	const text = msg.content
		.filter(isText)
		.map((b) => b.text)
		.join("\n");

	const images = supportsVision
		? msg.content.filter(isImage).map((b) => b.data)
		: [];

	if (!text && images.length === 0) return null;

	const wire: OllamaWireMessage = { role: "user", content: sanitize(text) };
	if (images.length > 0) wire.images = images;
	return wire;
}

function convertAssistant(msg: AssistantMessage): OllamaWireMessage | null {
	// Drop thinking blocks — Ollama re-derives reasoning each turn.
	const text = msg.content
		.filter(isText)
		.map((b) => b.text)
		.join("");

	const toolCalls = msg.content.filter(isToolCall);

	if (!text && toolCalls.length === 0) return null;

	const wire: OllamaWireMessage = {
		role: "assistant",
		content: sanitize(text),
	};

	if (toolCalls.length > 0) {
		wire.tool_calls = toolCalls.map((tc) => ({
			id: tc.id,
			function: { name: tc.name, arguments: tc.arguments },
		}));
	}

	return wire;
}

function convertToolResult(
	msg: ToolResultMessage,
	supportsVision: boolean,
): OllamaWireMessage {
	const text = msg.content
		.filter(isText)
		.map((b) => b.text)
		.join("\n");

	// Ollama accepts an images array on role:"tool" messages, same as on user
	// messages — verified live against gemma4:12b (red/blue control images both
	// identified from the tool turn). If a future Ollama build regresses this,
	// the fallback shape is a synthetic follow-up user message carrying the
	// images (AdhamAH's fork approach).
	const images = supportsVision ? msg.content.filter(isImage).map((b) => b.data) : [];

	const wire: OllamaWireMessage = {
		role: "tool",
		content: sanitize(text || (images.length > 0 ? "(image result)" : "(no result)")),
		tool_name: msg.toolName,
	};
	if (images.length > 0) wire.images = images;
	return wire;
}

// ============================================================================
// Message normalisation
//
// Strips aborted/errored assistant turns and any tool results immediately
// following them (which would otherwise become orphaned). The pi core may
// already handle some of this via transformMessages; this is a defensive
// pass that runs regardless.
// ============================================================================

function normalizeMessages(messages: readonly PiMessage[]): PiMessage[] {
	const result: PiMessage[] = [];
	let skipToolResults = false;

	for (const msg of messages) {
		if (skipToolResults && msg.role === "toolResult") {
			continue;
		}
		skipToolResults = false;

		if (msg.role === "assistant") {
			const am = msg as AssistantMessage;
			if (am.stopReason === "error" || am.stopReason === "aborted") {
				skipToolResults = true;
				continue;
			}
		}

		result.push(msg);
	}

	return result;
}

// ============================================================================
// Type guards
// ============================================================================

function isText(b: ContentBlock): b is TextContent {
	return b.type === "text";
}

function isToolCall(b: ContentBlock): b is ToolCallContent {
	return b.type === "toolCall";
}

function isImage(b: ContentBlock): b is ImageContent {
	return b.type === "image";
}

// ============================================================================
// Unicode sanitisation
//
// Replaces unpaired surrogate code units with the Unicode replacement character
// (U+FFFD). Unpaired surrogates produce invalid JSON and can cause Ollama's
// parser to fail or behave erratically.
// ============================================================================

function sanitize(str: string): string {
	return str.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"�",
	);
}
