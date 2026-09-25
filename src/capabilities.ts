// Capability inference from Ollama's /api/show response.
//
// Ollama's /api/tags endpoint provides almost no useful metadata. /api/show
// gives a richer picture but capability detection still requires heuristics
// for models that predate Ollama's capabilities array.

import { type OllamaThinking, parseThinking } from "./thinking.js";

export interface OllamaShowResponse {
	details?: {
		family?: string;
		families?: string[];
		parameter_size?: string;
	};
	model_info?: Record<string, unknown>;
	capabilities?: string[];
	/** Ollama >= 0.34: the `think` values this model accepts (gh#13). */
	thinking?: unknown;
}

export interface InferredCapabilities {
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
	/** Validated thinking values, or undefined when the server reports none. */
	thinking: OllamaThinking | undefined;
	contextWindow: number;
	maxTokens: number;
}

// Fallbacks for Ollama versions that don't report a capabilities array.
// Only used then: a name guess must never override what Ollama says, because
// sending `think` to a model that can't think gets the request rejected.
const TOOL_FAMILIES = ["llama", "qwen", "mistral", "command", "granite", "nemotron"];
const REASONING_PATTERNS = [/\br1\b/i, /think/i, /reason/i, /gemma4/i, /deepseek/i, /qwq/i];

type CapabilityFlags = Pick<InferredCapabilities, "tools" | "vision" | "reasoning">;

/** The model reports at least one `think` value that turns thinking on. */
function reportsThinking(thinking: OllamaThinking | undefined): boolean {
	return thinking?.values.some((v) => v !== false) ?? false;
}

function fromCapabilities(
	caps: string[],
	thinking: OllamaThinking | undefined,
): CapabilityFlags {
	return {
		tools: caps.includes("tools"),
		vision: caps.includes("vision"),
		reasoning: caps.includes("thinking") || reportsThinking(thinking),
	};
}

function fromHeuristics(
	modelId: string,
	show: OllamaShowResponse,
	thinking: OllamaThinking | undefined,
): CapabilityFlags {
	const family = (show.details?.family ?? "").toLowerCase();
	const families = (show.details?.families ?? []).map((f) => f.toLowerCase());
	return {
		tools: TOOL_FAMILIES.some((f) => family.includes(f)),
		vision: families.includes("clip"),
		reasoning: reportsThinking(thinking) || REASONING_PATTERNS.some((p) => p.test(modelId)),
	};
}

export function inferCapabilities(
	modelId: string,
	show: OllamaShowResponse,
): InferredCapabilities {
	const thinking = parseThinking(show.thinking);
	const flags = show.capabilities
		? fromCapabilities(show.capabilities, thinking)
		: fromHeuristics(modelId, show, thinking);

	return {
		...flags,
		thinking,
		contextWindow: extractContextWindow(show.model_info) ?? 32768,
		maxTokens: 8192,
	};
}

function extractContextWindow(
	modelInfo: Record<string, unknown> | undefined,
): number | null {
	if (!modelInfo) return null;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith(".context_length") && typeof value === "number") {
			return value;
		}
	}
	return null;
}
