// Capability inference from Ollama's /api/show response.
//
// Ollama's /api/tags endpoint provides almost no useful metadata. /api/show
// gives a richer picture but capability detection still requires heuristics
// for models that predate Ollama's capabilities array.

export interface OllamaShowResponse {
	details?: {
		family?: string;
		families?: string[];
		parameter_size?: string;
	};
	model_info?: Record<string, unknown>;
	capabilities?: string[];
}

export interface InferredCapabilities {
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// Model families known to support tool calling. Used as fallback when the
// capabilities array is absent or incomplete.
const TOOL_FAMILIES = ["llama", "qwen", "mistral", "command", "granite", "nemotron"];

// Name patterns that indicate native reasoning/thinking support.
const REASONING_PATTERNS = [/\br1\b/i, /think/i, /reason/i, /gemma4/i, /deepseek/i, /qwq/i];

export function inferCapabilities(
	modelId: string,
	show: OllamaShowResponse,
): InferredCapabilities {
	const caps = show.capabilities ?? [];
	const family = (show.details?.family ?? "").toLowerCase();
	const families = (show.details?.families ?? []).map((f) => f.toLowerCase());

	const tools =
		caps.includes("tools") ||
		TOOL_FAMILIES.some((f) => family.includes(f));

	const vision =
		caps.includes("vision") ||
		families.includes("clip") ||
		caps.includes("image");

	const reasoning =
		caps.includes("thinking") ||
		REASONING_PATTERNS.some((p) => p.test(modelId));

	const contextWindow = extractContextWindow(show.model_info) ?? 32768;

	return {
		tools,
		vision,
		reasoning,
		contextWindow,
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
