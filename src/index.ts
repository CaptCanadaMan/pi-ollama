// pi-ollama — native Ollama provider extension for pi coding agent.
//
// Registers an "ollama" provider backed by Ollama's /api/chat endpoint
// directly, bypassing the OpenAI-compat shim that drops tool_calls under
// streaming (ollama#12557).
//
// Install:  pi install npm:pi-ollama
// Refresh:  /ollama-refresh
// Status:   /ollama-status
// Details:  /ollama-info <model-id>
//
// Environment variables:
//   OLLAMA_HOST                  — Ollama server host[:port]. Default: localhost:11434
//   OLLAMA_NATIVE_DEBUG          — Set to "1" to enable debug logging (writes to a file)
//   OLLAMA_NATIVE_DEBUG_LOG      — Override default log path
//                                  (default: ~/.pi/agent/cache/pi-ollama-debug.log)
//   OLLAMA_NATIVE_DUMP_DIR       — Path to write req/res dump files for diagnostics
//   OLLAMA_NATIVE_GHOST_RETRIES  — Ghost-token retry count. Default: 2

import { loadSettings } from "./settings.js";
import { discoverModels, loadCache, type DiscoveredModel } from "./discovery.js";
import { streamOllama } from "./provider.js";
import { registerCommands } from "./commands.js";
import { OLLAMA_DEBUG, OLLAMA_DEBUG_LOG } from "./debug.js";

// ============================================================================
// Minimal structural interfaces for the pi extension API.
// The real types come from @mariozechner/pi-coding-agent at runtime.
// ============================================================================

interface ProviderModel {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	};
}

interface ExtensionAPI {
	registerProvider(
		name: string,
		config: {
			api: string;
			baseUrl: string;
			apiKey?: string;
			streamSimple: (
				model: unknown,
				context: unknown,
				options?: unknown,
			) => unknown;
			models: ProviderModel[];
		},
	): void;
	unregisterProvider(name: string): void;
	registerCommand(
		name: string,
		config: {
			description: string;
			handler: (args: string) => void | Promise<void>;
		},
	): void;
}

// AssistantMessageEventStream is the class pi uses for all streaming responses.
// We import it at runtime from @mariozechner/pi-ai — the extension receives the
// resolved package from pi's module loader so this works without the package
// being a direct dependency of pi-ollama.
let StreamClass: new () => { push(event: unknown): void; end(): void };

async function resolveStreamClass() {
	if (StreamClass) return;
	let mod: unknown;
	try {
		mod = await import("@mariozechner/pi-ai");
	} catch (e) {
		throw new Error(
			"pi-ollama: could not import @mariozechner/pi-ai. " +
				`Ensure it's available in pi's module resolution path. (${String(e)})`,
		);
	}
	// biome-ignore lint/suspicious/noExplicitAny: dynamic import path
	const cls = (mod as any).AssistantMessageEventStream;
	if (typeof cls !== "function") {
		throw new Error(
			"pi-ollama: @mariozechner/pi-ai loaded but did not export AssistantMessageEventStream. " +
				"This may indicate an incompatible pi-ai version.",
		);
	}
	StreamClass = cls;
}

// ============================================================================
// Extension factory
// ============================================================================

export default async function (pi: ExtensionAPI): Promise<void> {
	const settings = loadSettings();

	// One-time stderr notice when debug logging is enabled — printed at
	// extension load before pi's TUI begins streaming, so safe to write here.
	// All subsequent dbg() output goes to the log file to avoid corrupting
	// the TUI's carriage-return redraws.
	if (OLLAMA_DEBUG) {
		process.stderr.write(
			`[pi-ollama] Debug logging → ${OLLAMA_DEBUG_LOG} ` +
				`(override with OLLAMA_NATIVE_DEBUG_LOG=/path)\n`,
		);
	}

	// Seed from cache immediately so the provider is available at startup
	// even if Ollama is slow or temporarily unavailable.
	let models: DiscoveredModel[] = loadCache();

	// Attempt a live discovery. On failure, fall back to the cached list.
	try {
		models = await discoverModels(settings.baseUrl);
	} catch (e) {
		if (models.length > 0) {
			process.stderr.write(
				`[pi-ollama] Ollama not reachable (${String(e)}). ` +
					`Loaded ${models.length} model(s) from cache. Run /ollama-refresh when Ollama is available.\n`,
			);
		} else {
			process.stderr.write(
				`[pi-ollama] Ollama not reachable and no cache available (${String(e)}). ` +
					`Run /ollama-refresh when Ollama is available.\n`,
			);
		}
	}

	await resolveStreamClass();

	// Register the provider with the current model list.
	// On first call there's nothing to unregister; on refresh we attempt to
	// unregister and tolerate failure (older pi versions may lack the method —
	// duplicate registrations are preferable to a hard crash).
	let providerRegistered = false;
	const registerProvider = (currentModels: DiscoveredModel[]) => {
		if (providerRegistered) {
			try {
				pi.unregisterProvider("ollama");
			} catch (e) {
				process.stderr.write(
					`[pi-ollama] unregisterProvider failed (${String(e)}). ` +
						`Continuing — registration may end up duplicated.\n`,
				);
			}
		}
		pi.registerProvider("ollama", {
			api: "ollama-native",
			baseUrl: settings.baseUrl,
			apiKey: "ollama", // dummy — streamSimple doesn't auth, but pi may validate presence
			streamSimple: (model, context, options) =>
				streamOllama(
					model as Parameters<typeof streamOllama>[0],
					context as Parameters<typeof streamOllama>[1],
					options as Parameters<typeof streamOllama>[2],
					settings,
					StreamClass,
				),
			models: currentModels.map((m) => toProviderModel(m, settings.baseUrl)),
		});
		providerRegistered = true;
	};

	registerProvider(models);

	// Wire up commands. /ollama-refresh re-discovers and re-registers.
	registerCommands(
		pi,
		settings,
		() => models,
		(fresh) => { models = fresh; },
		registerProvider,
	);
}

// ============================================================================
// Model shape conversion
// ============================================================================

function toProviderModel(m: DiscoveredModel, baseUrl: string): ProviderModel {
	return {
		id: m.id,
		name: m.name,
		api: "ollama-native",
		baseUrl,
		reasoning: m.reasoning,
		input: m.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	};
}
