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

// pi >= 0.86: the system prompt and tool declarations travel in the transcript.
// The leading one holds the base prompt; later ones append content, patch named
// sections (null removes one) and add or remove tools.
interface SystemMessage {
	role: "system";
	content: string | ContentBlock[];
	sections?: Record<string, string | null>;
	toolsAdded?: PiTool[];
	toolsRemoved?: { name: string }[];
}

type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type PiMessage = ConversationMessage | SystemMessage;

export interface PiTool {
	name: string;
	description: string;
	parameters: object;
}

/** What pi hands a provider. systemPrompt/tools only exist on pi < 0.86. */
export interface PiContext {
	systemPrompt?: string;
	messages: readonly PiMessage[];
	tools?: PiTool[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert one pi request context to the /api/chat messages and tools.
 *
 * pi >= 0.86 carries the system prompt and tools as system messages in the
 * transcript (gh#11); older pi passed them as context.systemPrompt and
 * context.tools. toTranscript folds the old shape into the new one, so both
 * contracts take the same path.
 */
export function convertContext(
	context: PiContext,
	supportsVision: boolean,
): { messages: OllamaWireMessage[]; tools: OllamaTool[] | undefined } {
	const { prompt, tools, messages } = collapseSystemMessages(toTranscript(context));
	return {
		messages: convertMessages(messages, prompt, supportsVision),
		tools: tools.length > 0 ? convertTools(tools) : undefined,
	};
}

/**
 * Fold pi < 0.86's systemPrompt/tools into a leading system message, the same
 * way pi-ai's normalizeContext() does - pi defines those fields as shorthand
 * for exactly that. On pi >= 0.86 they're absent and the messages pass through.
 */
export function toTranscript({ systemPrompt, tools, messages }: PiContext): readonly PiMessage[] {
	if (!systemPrompt && !tools?.length) return messages;
	return [{ role: "system", content: systemPrompt ?? "", toolsAdded: tools }, ...messages];
}

/**
 * Replay every system message in order into one prompt and the current tool
 * set, and drop them from the conversation. Mirrors pi-ai's
 * collapseSystemMessages() / getCurrentSystemPrompt() / getCurrentTools(),
 * reimplemented so we don't depend on the host's pi-ai version; the parity
 * tests in test/convert.test.ts check it against the real ones.
 *
 * Mid-conversation changes land in the leading prompt rather than in place:
 * most Ollama chat templates only honour a system message at the top.
 * Replay approach from TRex22's PR #12.
 */
export function collapseSystemMessages(transcript: readonly PiMessage[]): {
	prompt: string;
	tools: PiTool[];
	messages: ConversationMessage[];
} {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, PiTool>();
	const messages: ConversationMessage[] = [];
	for (const msg of transcript) {
		if (msg.role !== "system") {
			messages.push(msg);
			continue;
		}
		content.push(textOf(msg.content));
		for (const [name, text] of Object.entries(msg.sections ?? {})) {
			if (text === null) sections.delete(name);
			else sections.set(name, text);
		}
		for (const t of msg.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of msg.toolsAdded ?? []) tools.set(t.name, t);
	}
	const prompt = [content.filter(Boolean).join("\n\n"), ...sections.values()]
		.filter(Boolean)
		.join("\n\n");
	return { prompt, tools: [...tools.values()], messages };
}

export function convertMessages(
	messages: readonly ConversationMessage[],
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
			// Unknown role — log it so it can be diagnosed instead of silently
			// dropped. (System messages never get here: collapseSystemMessages
			// has already folded them into systemPrompt.)
			dbg("unknown-role", { role: (msg as { role: string }).role });
		}
	}

	return out;
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

	const text = textOf(msg.content);

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
	const text = textOf(msg.content, "");

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
	const text = textOf(msg.content);

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

function normalizeMessages(
	messages: readonly ConversationMessage[],
): ConversationMessage[] {
	const result: ConversationMessage[] = [];
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
// Type guards and content helpers
// ============================================================================

/** The text of a message's content, mirroring pi-ai's contentText(). */
function textOf(content: string | readonly ContentBlock[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter(isText)
		.map((b) => b.text)
		.join(separator);
}

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
