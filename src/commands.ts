// Extension commands: /ollama-status, /ollama-refresh, /ollama-info
//
// Output is delivered via ctx.ui.notify() — the TUI-aware notification API
// from pi's ExtensionCommandContext. Direct console.log to stdout corrupts
// pi's carriage-return cursor positioning, especially on the first command
// of a session. notify() routes through pi's render loop so output integrates
// cleanly with the TUI regardless of when it fires.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { discoverModels, type DiscoveredModel } from "./discovery.js";
import { parseKeepAlive, type OllamaExtensionSettings } from "./settings.js";

interface OllamaPs {
	models?: Array<{
		name: string;
		size_vram?: number;
		expires_at?: string;
	}>;
}

// Minimal structural type for the ctx.ui surface we use.
// The real type is ExtensionCommandContext from @earendil-works/pi-coding-agent.
interface CommandUIContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(
			title: string,
			options: string[],
			opts?: { signal?: AbortSignal; timeout?: number },
		): Promise<string | undefined>;
		input(
			title: string,
			placeholder?: string,
			opts?: { signal?: AbortSignal; timeout?: number },
		): Promise<string | undefined>;
	};
}

// Minimal structural interface for the pi ExtensionAPI — only the methods
// this module calls.
interface Pi {
	registerCommand(
		name: string,
		config: {
			description: string;
			handler: (args: string, ctx: CommandUIContext) => void | Promise<void>;
		},
	): void;
}

// Called from index.ts to register all commands.
// The `getModels` callback gives commands access to the current model list
// without creating a circular dependency.
export function registerCommands(
	pi: Pi,
	settings: OllamaExtensionSettings,
	getModels: () => DiscoveredModel[],
	setModels: (models: DiscoveredModel[]) => void,
	reregisterProvider: (models: DiscoveredModel[]) => void,
): void {
	pi.registerCommand("ollama-status", {
		description: "Show Ollama connection status and currently loaded models",
		handler: async (_args, ctx) => {
			const baseUrl = settings.baseUrl;
			const lines: string[] = [];
			lines.push(`Ollama base URL: ${baseUrl}`);
			lines.push(
				settings.keepAlive !== undefined
					? `keep_alive: ${settings.keepAlive} (override — sent on every request)`
					: "keep_alive: defer to server (default)",
			);

			// Check /api/tags to confirm Ollama is reachable.
			try {
				const tagsRes = await fetch(`${baseUrl}/api/tags`);
				if (!tagsRes.ok) {
					ctx.ui.notify(
						`Ollama not reachable (HTTP ${tagsRes.status}) at ${baseUrl}`,
						"error",
					);
					return;
				}
				const registered = getModels();
				lines.push(
					`✓ Ollama reachable — ${registered.length} model(s) registered`,
				);
				for (const m of registered) {
					const flags = [
						m.tools ? "tools" : null,
						m.vision ? "vision" : null,
						m.reasoning ? "reasoning" : null,
					]
						.filter(Boolean)
						.join(", ");
					lines.push(
						`  ${m.id.padEnd(32)} ctx:${m.contextWindow.toLocaleString()}  [${flags || "basic"}]`,
					);
				}
			} catch (e) {
				ctx.ui.notify(`Cannot reach Ollama: ${String(e)}`, "error");
				return;
			}

			// Show currently loaded models via /api/ps (optional).
			try {
				const psRes = await fetch(`${baseUrl}/api/ps`);
				if (psRes.ok) {
					const ps = (await psRes.json()) as OllamaPs;
					const running = ps.models ?? [];
					if (running.length > 0) {
						lines.push(``, `Currently loaded in memory:`);
						for (const m of running) {
							const vram = m.size_vram
								? ` (${(m.size_vram / 1e9).toFixed(1)} GB VRAM)`
								: "";
							lines.push(`  ${m.name}${vram}`);
						}
					} else {
						lines.push(``, `No models currently loaded in memory`);
					}
				}
			} catch {
				// /api/ps is optional — older Ollama versions may not have it.
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ollama-refresh", {
		description:
			"Re-discover models from Ollama and re-register the provider",
		handler: async (_args, ctx) => {
			try {
				const models = await discoverModels(settings.baseUrl);
				setModels(models);
				reregisterProvider(models);
				ctx.ui.notify(
					`Refreshed model list from ${settings.baseUrl} — ${models.length} model(s) registered`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Refresh failed: ${String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("ollama-info", {
		description:
			"Show capability details for an Ollama model. Usage: /ollama-info [model-id] (omit to pick from list)",
		handler: async (args, ctx) => {
			const typed = args.trim();
			let chosen: string | undefined;

			if (typed) {
				chosen = typed;
			} else {
				const registered = getModels();
				if (registered.length === 0) {
					ctx.ui.notify(
						"No Ollama models registered. Run /ollama-refresh first.",
						"warning",
					);
					return;
				}
				// Build enriched labels matching /ollama-status's row format,
				// with a label→id map so the picker returns a clean model id.
				const labelToId = new Map<string, string>();
				const options: string[] = [];
				for (const m of registered) {
					const flags = [
						m.tools ? "tools" : null,
						m.vision ? "vision" : null,
						m.reasoning ? "reasoning" : null,
					]
						.filter(Boolean)
						.join(", ");
					const label = `${m.id.padEnd(32)} ctx:${m.contextWindow.toLocaleString()}  [${flags || "basic"}]`;
					labelToId.set(label, m.id);
					options.push(label);
				}
				const selected = await ctx.ui.select(
					"Select a model to inspect",
					options,
				);
				if (!selected) {
					// User cancelled the picker — quiet exit, no notify.
					return;
				}
				chosen = labelToId.get(selected) ?? selected;
			}

			try {
				const res = await fetch(`${settings.baseUrl}/api/show`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: chosen }),
				});
				if (!res.ok) {
					ctx.ui.notify(
						`/api/show returned HTTP ${res.status} for ${chosen}`,
						"error",
					);
					return;
				}
				const show = await res.json();
				ctx.ui.notify(
					`${chosen}\n\n${JSON.stringify(show, null, 2)}`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Failed: ${String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("ollama-context", {
		description:
			"Set the num_ctx value pi-ollama sends to /api/chat. Persistent across restarts.",
		handler: async (_args, ctx) => {
			const PRESETS: Array<{ label: string; value: number }> = [
				{ label: "4,096 tokens (low memory)", value: 4096 },
				{ label: "8,192 tokens", value: 8192 },
				{ label: "16,384 tokens", value: 16384 },
				{ label: "32,768 tokens (current default cap)", value: 32768 },
				{ label: "65,536 tokens", value: 65536 },
				{ label: "131,072 tokens", value: 131072 },
			];
			const USE_DEFAULT = "Use system default (model maximum, capped at 32,768)";
			const CUSTOM = "Custom value…";

			const current = settings.contextLength;
			const currentNote =
				current !== undefined
					? `Current override: ${current.toLocaleString()} tokens`
					: "Current: system default (no override)";

			const options = [
				...PRESETS.map((p) => p.label),
				USE_DEFAULT,
				CUSTOM,
			];

			const selected = await ctx.ui.select(
				`Context length for /api/chat — ${currentNote}`,
				options,
			);
			if (!selected) {
				// User cancelled — quiet exit.
				return;
			}

			let newValue: number | undefined;

			if (selected === USE_DEFAULT) {
				newValue = undefined;
			} else if (selected === CUSTOM) {
				const raw = await ctx.ui.input(
					"Enter context length in tokens",
					"e.g., 16384",
				);
				if (!raw) {
					// User cancelled the input — quiet exit.
					return;
				}
				const n = parseInt(raw.trim(), 10);
				if (!Number.isFinite(n) || n <= 0) {
					ctx.ui.notify(
						"Invalid context length. Must be a positive integer.",
						"error",
					);
					return;
				}
				newValue = n;
			} else {
				const matched = PRESETS.find((p) => p.label === selected);
				if (!matched) {
					ctx.ui.notify("Unrecognized selection.", "error");
					return;
				}
				newValue = matched.value;
			}

			// Persist to disk AND mutate the shared settings object so the
			// next /api/chat request picks up the new value without a relaunch.
			const persisted = loadPersistedConfig();
			if (newValue === undefined) {
				delete persisted.contextLength;
			} else {
				persisted.contextLength = newValue;
			}
			savePersistedConfig(persisted);
			settings.contextLength = newValue;

			// Re-register the provider so pi's model registry (and the UI
			// context-usage counter) reflects the new effective contextWindow.
			// Without this the wire request would carry the new num_ctx but the
			// UI would keep showing the discovered max — a misleading mismatch.
			reregisterProvider(getModels());

			if (newValue === undefined) {
				ctx.ui.notify(
					"Context length override cleared. Using system default (model maximum, capped at 32,768 tokens).",
					"info",
				);
			} else {
				ctx.ui.notify(
					`Context length set to ${newValue.toLocaleString()} tokens. Applies to the next /api/chat request and persists across pi launches.`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("ollama-keep-alive", {
		description:
			"Set the keep_alive pi-ollama sends to /api/chat. Default: defer to the Ollama server's setting. Persistent across restarts.",
		handler: async (_args, ctx) => {
			const DEFER = "Defer to the Ollama server's setting (default)";
			const PRESETS: Array<{ label: string; value: string | number }> = [
				{ label: "-1 (keep the model loaded forever)", value: -1 },
				{ label: "5m (Ollama's factory default)", value: "5m" },
				{ label: "30m", value: "30m" },
				{ label: "1h", value: "1h" },
			];
			const CUSTOM = "Custom value…";

			const current = settings.keepAlive;
			const currentNote =
				current !== undefined
					? `Current override: ${current}`
					: "Current: defer to server (no override sent)";

			const selected = await ctx.ui.select(
				`keep_alive for /api/chat — ${currentNote}`,
				[DEFER, ...PRESETS.map((p) => p.label), CUSTOM],
			);
			if (!selected) {
				// User cancelled — quiet exit.
				return;
			}

			let newValue: string | number | undefined;

			if (selected === DEFER) {
				newValue = undefined;
			} else if (selected === CUSTOM) {
				const raw = await ctx.ui.input(
					"Enter keep_alive",
					'e.g., "10m", "1h30m", or -1 to keep loaded forever',
				);
				if (!raw) {
					// User cancelled the input — quiet exit.
					return;
				}
				const parsed = parseKeepAlive(raw);
				if (parsed === undefined) {
					ctx.ui.notify(
						'Invalid keep_alive. Use a duration like "5m" / "1h30m" or an integer (seconds; -1 = forever).',
						"error",
					);
					return;
				}
				newValue = parsed;
			} else {
				const matched = PRESETS.find((p) => p.label === selected);
				if (!matched) {
					ctx.ui.notify("Unrecognized selection.", "error");
					return;
				}
				newValue = matched.value;
			}

			// Persist to disk AND mutate the shared settings object so the
			// next /api/chat request picks up the new value without a relaunch.
			// (No provider re-registration needed — keep_alive doesn't affect
			// the model registry, unlike /ollama-context.)
			const persisted = loadPersistedConfig();
			if (newValue === undefined) {
				delete persisted.keepAlive;
			} else {
				persisted.keepAlive = newValue;
			}
			savePersistedConfig(persisted);
			settings.keepAlive = newValue;

			if (newValue === undefined) {
				ctx.ui.notify(
					"keep_alive override cleared. The field is omitted from requests — the Ollama server's own setting (OLLAMA_KEEP_ALIVE) decides.",
					"info",
				);
			} else {
				ctx.ui.notify(
					`keep_alive set to ${newValue}. Applies to the next /api/chat request and persists across pi launches. Note: this OVERRIDES the server's OLLAMA_KEEP_ALIVE.`,
					"info",
				);
			}
		},
	});
}
