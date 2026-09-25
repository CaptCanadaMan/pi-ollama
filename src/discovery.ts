// Model discovery via Ollama's /api/tags and /api/show endpoints, plus the
// on-disk cache used when Ollama can't be reached at startup.
//
// Every request is bounded by ollama-client's timeouts and the /api/show
// calls run in parallel, so a slow or hung server can't hold pi's startup.
// Writing the cache is the caller's job (index.ts refreshModels), so
// discovery itself has no side effects.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canChat, inferCapabilities } from "./capabilities.js";
import {
	listModels,
	type OllamaTarget,
	type RequestOptions,
	showModel,
} from "./ollama-client.js";
import type { OllamaThinking } from "./thinking.js";

export interface DiscoveredModel {
	id: string;
	name: string;
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
	/** The model's `think` values (gh#13). Absent on older Ollama and in older caches. */
	thinking?: OllamaThinking;
	contextWindow: number;
	maxTokens: number;
}

const CACHE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"cache",
	"pi-ollama-models.json",
);

export function loadCache(): DiscoveredModel[] {
	try {
		if (!existsSync(CACHE_PATH)) return [];
		return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as DiscoveredModel[];
	} catch {
		return [];
	}
}

/** Write a discovered model list for the next startup. An empty list is not saved. */
export function saveCache(models: DiscoveredModel[]): void {
	if (models.length === 0) return;
	try {
		mkdirSync(join(homedir(), ".pi", "agent", "cache"), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2));
	} catch {
		// Non-fatal — cache write failures don't block usage.
	}
}

export async function discoverModels(
	target: OllamaTarget,
	options: RequestOptions = {},
): Promise<DiscoveredModel[]> {
	const ids = await listModels(target, options);

	// All at once: /api/show is a metadata read, and a slow one shouldn't hold
	// up the rest. Promise.all keeps /api/tags order.
	const described = await Promise.all(ids.map((id) => describeModel(target, id, options)));
	return described.filter((m): m is DiscoveredModel => m !== undefined);
}

/** The model as pi should see it, or undefined when Ollama says it can't chat. */
async function describeModel(
	target: OllamaTarget,
	id: string,
	options: RequestOptions,
): Promise<DiscoveredModel | undefined> {
	try {
		const show = await showModel(target, id, options);
		if (!canChat(show)) return undefined;
		const caps = inferCapabilities(id, show);
		return {
			id,
			name: friendlyName(id),
			tools: caps.tools,
			vision: caps.vision,
			reasoning: caps.reasoning,
			...(caps.thinking && { thinking: caps.thinking }),
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
		};
	} catch {
		// /api/show failed for this model — include it with conservative defaults.
		return minimal(id);
	}
}

function minimal(id: string): DiscoveredModel {
	return {
		id,
		name: friendlyName(id),
		tools: false,
		vision: false,
		reasoning: false,
		contextWindow: 32768,
		maxTokens: 8192,
	};
}

// "gemma4:26b" → "Gemma4 26B (Ollama)"
function friendlyName(id: string): string {
	const parts = id.split(":");
	// parts[0] is always defined per the ES spec — `?? id` is a no-op at runtime
	// that satisfies noUncheckedIndexedAccess if it's ever turned on.
	const base = parts[0] ?? id;
	const tag = parts[1];
	const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
	return tag
		? `${capitalized} ${tag.toUpperCase()} (Ollama)`
		: `${capitalized} (Ollama)`;
}
