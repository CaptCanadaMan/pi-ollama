// Model discovery via Ollama's /api/tags and /api/show endpoints, plus the
// on-disk cache used when Ollama can't be reached at startup.
//
// Every request is bounded by ollama-client's timeouts and the /api/show
// calls run in parallel, so a slow or hung server can't hold pi's startup.
// Writing the cache is the caller's job (index.ts refreshModels), so
// discovery itself has no side effects.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cacheDir, cachePath } from "./paths.js";
import { canChat, inferCapabilities, type OllamaShowResponse } from "./capabilities.js";
import { errorText } from "./errors.js";
import { type ConfigIssue, type ModelConfigFile, serverUrlFor } from "./model-config.js";
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
	/**
	 * True when the model itself reported `contextWindow`. Absent or false means
	 * it is a placeholder (/api/show failed or gave no context length, or the
	 * entry comes from a cache written before this field existed), which must
	 * not be used to cap what the user asked for (GH-15).
	 */
	contextWindowKnown?: boolean;
	maxTokens: number;
	/** Set when the model is pinned to a named server (model-config.ts): that server's address. */
	baseUrl?: string;
}

const modelsCachePath = () => cachePath("pi-ollama-models.json");

export function loadCache(): DiscoveredModel[] {
	try {
		if (!existsSync(modelsCachePath())) return [];
		return JSON.parse(readFileSync(modelsCachePath(), "utf-8")) as DiscoveredModel[];
	} catch {
		return [];
	}
}

/** Write a discovered model list for the next startup. An empty list is not saved. */
export function saveCache(models: DiscoveredModel[]): void {
	if (models.length === 0) return;
	try {
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(modelsCachePath(), JSON.stringify(models, null, 2));
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
function fromShow(id: string, show: OllamaShowResponse, baseUrl?: string): DiscoveredModel {
	const caps = inferCapabilities(id, show);
	return {
		id,
		name: friendlyName(id),
		tools: caps.tools,
		vision: caps.vision,
		reasoning: caps.reasoning,
		...(caps.thinking && { thinking: caps.thinking }),
		contextWindow: caps.contextWindow,
		contextWindowKnown: caps.contextWindowKnown,
		maxTokens: caps.maxTokens,
		...(baseUrl && { baseUrl }),
	};
}

/**
 * Models pinned to a named server (model-config.ts): each is looked up on its
 * own server and carries that server's address. A server that can't be
 * reached falls back to the cached entry for the same model on the same
 * server, if there is one - never one from a different or removed server.
 *
 * The target is the bare address: the API key belongs to the default server
 * and is never sent to a named one.
 */
export async function discoverPinned(
	config: ModelConfigFile,
	cached: DiscoveredModel[],
	options: RequestOptions = {},
): Promise<{ models: DiscoveredModel[]; issues: ConfigIssue[] }> {
	const issues: ConfigIssue[] = [];
	const found = await Promise.all(
		Object.entries(config.models).map(async ([id, entry]): Promise<DiscoveredModel | undefined> => {
			const baseUrl = serverUrlFor(config, id);
			if (!baseUrl) return undefined;
			const issue = (message: string) =>
				issues.push({
					severity: "warning",
					path: `models[${JSON.stringify(id)}].server`,
					message: `= ${JSON.stringify(entry.server)}: ${message}`,
				});
			try {
				const show = await showModel({ baseUrl }, id, options);
				if (!canChat(show)) {
					issue(`${id} on ${baseUrl} is not a chat model - not registered`);
					return undefined;
				}
				return fromShow(id, show, baseUrl);
			} catch (e) {
				const fallback = cached.find((m) => m.id === id && m.baseUrl === baseUrl);
				issue(
					`lookup on ${baseUrl} failed (${errorText(e)}) - ${fallback ? "using the cached entry" : "not registered"}`,
				);
				return fallback;
			}
		}),
	);
	return { models: found.filter((m): m is DiscoveredModel => m !== undefined), issues };
}

/**
 * Everything pi should register: the default server's models plus the pinned
 * ones. If the default server can't be reached, its cached models stand in
 * and `defaultError` says why - the pinned servers are still asked, since
 * they may well be up. Cached entries for named servers are only ever reused
 * by discoverPinned, for a server that is still configured.
 */
export async function discoverAll(
	target: OllamaTarget,
	config: ModelConfigFile,
	cached: DiscoveredModel[],
	options: RequestOptions = {},
): Promise<{ models: DiscoveredModel[]; issues: ConfigIssue[]; defaultError?: unknown }> {
	const [fromDefault, pinned] = await Promise.all([
		discoverModels(target, options).then(
			(models) => ({ models }),
			(error: unknown) => ({ models: cached.filter((m) => !m.baseUrl), error }),
		),
		discoverPinned(config, cached, options),
	]);
	return {
		models: mergePinned(fromDefault.models, pinned.models),
		issues: pinned.issues,
		..."error" in fromDefault && { defaultError: fromDefault.error },
	};
}

/** The default server's models plus the pinned ones; a pinned model replaces a same-named local one. */
export function mergePinned(discovered: DiscoveredModel[], pinned: DiscoveredModel[]): DiscoveredModel[] {
	const pinnedIds = new Set(pinned.map((m) => m.id));
	return [...discovered.filter((m) => !pinnedIds.has(m.id)), ...pinned];
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
