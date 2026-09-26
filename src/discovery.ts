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
import { type ConfigIssue, type ModelConfigFile, resolveServerUrl } from "./model-config.js";

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
	/** Set when the model is pinned to a named server (model-config.ts). */
	baseUrl?: string;
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
		return fromShow(id, show);
	} catch {
		// /api/show failed for this model — include it with conservative defaults.
		return minimal(id);
	}
}

/** The model as pi should see it, from its /api/show response. */
function fromShow(
	id: string,
	show: Parameters<typeof inferCapabilities>[1],
	baseUrl?: string,
): DiscoveredModel {
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
		...(baseUrl && { baseUrl }),
	};
}

/**
 * Models pinned to a named server (model-config.ts): each is looked up on its
 * own server and registered with that server's address. A lookup that fails
 * falls back to the cached entry for the same server, if any. The API key is
 * never sent to these servers - targetFor() only sends it to the configured host.
 */
export async function discoverPinned(
	config: ModelConfigFile,
	cached: DiscoveredModel[],
	options: RequestOptions = {},
): Promise<{ models: DiscoveredModel[]; issues: ConfigIssue[] }> {
	const models: DiscoveredModel[] = [];
	const issues: ConfigIssue[] = [];
	await Promise.all(
		Object.entries(config.models).map(async ([id, entry]) => {
			const baseUrl = resolveServerUrl(config, entry.server);
			if (!baseUrl) return;
			const path = `models[${JSON.stringify(id)}].server`;
			try {
				const show = await showModel({ baseUrl }, id, options);
				if (!canChat(show)) {
					issues.push({ severity: "warning", path, message: `= "${entry.server}": ${id} on ${baseUrl} can't chat - not registered` });
					return;
				}
				models.push(fromShow(id, show, baseUrl));
			} catch (e) {
				const fallback = cached.find((m) => m.id === id && m.baseUrl === baseUrl);
				if (fallback) models.push(fallback);
				issues.push({
					severity: "warning",
					path,
					message: `= "${entry.server}": lookup on ${baseUrl} failed (${e instanceof Error ? e.message : String(e)}) - ${fallback ? "using the cached entry" : "not registered"}`,
				});
			}
		}),
	);
	return { models, issues };
}

/** The default server's models, with pinned ones replacing same-named entries. */
export function mergePinned(discovered: DiscoveredModel[], pinned: DiscoveredModel[]): DiscoveredModel[] {
	const pinnedIds = new Set(pinned.map((m) => m.id));
	return [...discovered.filter((m) => !pinnedIds.has(m.id)), ...pinned];
}

/**
 * The model list when the default server can't be reached: its cached models
 * plus a fresh lookup of the pinned ones, whose servers may well be up. Cached
 * entries for other servers are dropped here - discoverPinned only reuses one
 * for a server that is still configured - so a removed server is never used.
 */
export async function fallbackModels(
	config: ModelConfigFile,
	cached: DiscoveredModel[],
	options: RequestOptions = {},
): Promise<{ models: DiscoveredModel[]; issues: ConfigIssue[] }> {
	const pinned = await discoverPinned(config, cached, options);
	return { models: mergePinned(cached.filter((m) => !m.baseUrl), pinned.models), issues: pinned.issues };
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
