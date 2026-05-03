// Extension commands: /ollama-status, /ollama-refresh, /ollama-info
//
// Output is delivered via ctx.ui.notify() — the TUI-aware notification API
// from pi's ExtensionCommandContext. Direct console.log to stdout corrupts
// pi's carriage-return cursor positioning, especially on the first command
// of a session. notify() routes through pi's render loop so output integrates
// cleanly with the TUI regardless of when it fires.

import { discoverModels, type DiscoveredModel } from "./discovery.js";
import type { OllamaExtensionSettings } from "./settings.js";

interface OllamaPs {
	models?: Array<{
		name: string;
		size_vram?: number;
		expires_at?: string;
	}>;
}

// Minimal structural type for the ctx.ui surface we use.
// The real type is ExtensionCommandContext from @mariozechner/pi-coding-agent.
interface CommandUIContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(
			title: string,
			options: string[],
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
}
