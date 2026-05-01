// Model discovery via Ollama's /api/tags and /api/show endpoints.
//
// Strategy: load from cache instantly on startup, then refresh in the
// background (or on /ollama-refresh). This keeps startup fast even when
// Ollama is slow to respond or temporarily unavailable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inferCapabilities, type OllamaShowResponse } from "./capabilities.js";

export interface DiscoveredModel {
	id: string;
	name: string;
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

interface OllamaTagEntry {
	name: string;
	size?: number;
	details?: {
		family?: string;
		parameter_size?: string;
	};
}

interface OllamaTagsResponse {
	models: OllamaTagEntry[];
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

function saveCache(models: DiscoveredModel[]): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent", "cache"), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2));
	} catch {
		// Non-fatal — cache write failures don't block usage.
	}
}

export async function discoverModels(baseUrl: string): Promise<DiscoveredModel[]> {
	const tagsRes = await fetch(`${baseUrl}/api/tags`);
	if (!tagsRes.ok) {
		throw new Error(`Ollama /api/tags returned HTTP ${tagsRes.status}`);
	}
	const { models: entries } = (await tagsRes.json()) as OllamaTagsResponse;

	const models: DiscoveredModel[] = [];

	for (const entry of entries) {
		try {
			const showRes = await fetch(`${baseUrl}/api/show`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: entry.name }),
			});

			if (!showRes.ok) {
				models.push(minimal(entry.name));
				continue;
			}

			const show = (await showRes.json()) as OllamaShowResponse;
			const caps = inferCapabilities(entry.name, show);

			models.push({
				id: entry.name,
				name: friendlyName(entry.name),
				tools: caps.tools,
				vision: caps.vision,
				reasoning: caps.reasoning,
				contextWindow: caps.contextWindow,
				maxTokens: caps.maxTokens,
			});
		} catch {
			// /api/show failed for this model — include it with conservative defaults.
			models.push(minimal(entry.name));
		}
	}

	if (models.length > 0) saveCache(models);
	return models;
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
