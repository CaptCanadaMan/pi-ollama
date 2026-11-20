// /ollama-preload: when a model is loaded into memory and when it is unloaded.
//
// One menu, three settings. All three are global (they apply to every model)
// and persistent (saved to the config file); a model's own entry in the
// config file's `models` block wins over them (model-config.ts).
//
//   Preload on Select        settings.warm - warm.ts loads the model, and
//                            pi's prompt, when a session starts or a model
//                            is selected
//   Idle Timeout             settings.keepAlive - the keep_alive sent with
//                            every request: time since the last request to
//                            the active model
//   Unload on Swap or Exit   settings.releaseAfter - what release.ts does
//                            once the model is deselected or pi exits
//
// Each row states its own value. No row is described by referring to another.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { releaseAfterCheck } from "./model-config.js";
import { type OllamaExtensionSettings, parseKeepAlive } from "./settings.js";

interface MenuContext {
	model?: { id: string };
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface Pi {
	registerCommand(
		name: string,
		config: { description: string; handler: (args: string, ctx: MenuContext) => Promise<void> },
	): void;
}

export interface PreloadCommandHooks {
	/** Preload the model the user is on now (warm.ts). Called when preloading is switched on. */
	preloadNow?: (ctx: MenuContext) => void;
}

const PRELOAD = "Preload on Select";
const IDLE = "Idle Timeout";
const UNLOAD = "Unload on Swap or Exit";
const SCOPE = "Global, persistent.";

const time = (value: string | number) => (typeof value === "number" ? `${value}s` : value);

export function describePreload(warm: boolean): string {
	return warm ? "on" : "off";
}

export function describeIdleTimeout(keepAlive: string | number | undefined): string {
	if (keepAlive === undefined) return "server default";
	if (typeof keepAlive === "number" && keepAlive < 0) return "never sleep";
	return time(keepAlive);
}

export function describeUnload(releaseAfter: string | number | undefined): string {
	if (releaseAfter === undefined || releaseAfter === 0) return "immediate";
	if (releaseAfter === "keep") return "never unload";
	return `after ${time(releaseAfter)}`;
}

/** The three settings as rows, for the menu and for /ollama-status. */
export function loadingRows(settings: OllamaExtensionSettings): [string, string, string] {
	return [
		`${PRELOAD}: ${describePreload(settings.warm)}`,
		`${IDLE}: ${describeIdleTimeout(settings.keepAlive)}`,
		`${UNLOAD}: ${describeUnload(settings.releaseAfter)}`,
	];
}

const CUSTOM = "Custom";

const PRELOAD_ON = "On (default)";
const PRELOAD_OFF = "Off";

const IDLE_SERVER = "Server default (OLLAMA_KEEP_ALIVE)";
const IDLE_CHOICES: Array<{ label: string; value: string | number }> = [
	{ label: "Never sleep", value: -1 },
	{ label: "5m", value: "5m" },
	{ label: "30m", value: "30m" },
	{ label: "1h", value: "1h" },
];

const UNLOAD_IMMEDIATE = "Immediate (default)";
const UNLOAD_CHOICES: Array<{ label: string; value: string | number }> = [
	{ label: "After 5m", value: "5m" },
	{ label: "After 30m", value: "30m" },
	{ label: "Never unload", value: "keep" },
];

const DURATION_HINT = 'Use a duration such as "10m" or "1h30m", or whole seconds.';

export function registerPreloadCommand(
	pi: Pi,
	settings: OllamaExtensionSettings,
	hooks: PreloadCommandHooks = {},
): void {
	/** Save one key of the config file; returns false (after telling the user) when it couldn't. */
	const save = <K extends "warm" | "keepAlive" | "releaseAfter">(
		ctx: MenuContext,
		key: K,
		value: OllamaExtensionSettings[K] | undefined,
	): boolean => {
		const config = loadPersistedConfig() as Record<string, unknown>;
		if (value === undefined) delete config[key];
		else config[key] = value;
		const unsaved = savePersistedConfig(config);
		if (unsaved) {
			ctx.ui.notify(`Not changed: ${unsaved}`, "error");
			return false;
		}
		return true;
	};

	const choosePreload = async (ctx: MenuContext) => {
		const choice = await ctx.ui.select(
			`${PRELOAD} - load the model when a session starts or a model is selected`,
			[PRELOAD_ON, PRELOAD_OFF],
		);
		if (!choice) return;
		const on = choice === PRELOAD_ON;
		if (!save(ctx, "warm", on)) return;
		settings.warm = on;
		ctx.ui.notify(`${PRELOAD}: ${describePreload(on)}. ${SCOPE}`, "info");
		if (on) hooks.preloadNow?.(ctx);
	};

	const chooseIdleTimeout = async (ctx: MenuContext) => {
		const choice = await ctx.ui.select(`${IDLE} - time since the last request to the active model`, [
			IDLE_SERVER,
			...IDLE_CHOICES.map((c) => c.label),
			CUSTOM,
		]);
		if (!choice) return;

		let value: string | number | undefined;
		if (choice === CUSTOM) {
			const typed = await ctx.ui.input(IDLE, 'Duration, e.g. "10m", "1h30m". -1 = never sleep');
			if (!typed) return;
			value = parseKeepAlive(typed);
			if (value === undefined) {
				ctx.ui.notify(`Not changed: "${typed}" is not a valid duration. ${DURATION_HINT}`, "error");
				return;
			}
		} else if (choice !== IDLE_SERVER) {
			value = IDLE_CHOICES.find((c) => c.label === choice)?.value;
			if (value === undefined) return;
		}

		if (!save(ctx, "keepAlive", value)) return;
		if (value === undefined) delete settings.keepAlive;
		else settings.keepAlive = value;
		ctx.ui.notify(
			`${IDLE}: ${describeIdleTimeout(value)}. ${SCOPE}${value === undefined ? "" : " Overrides OLLAMA_KEEP_ALIVE."}`,
			"info",
		);
	};

	const chooseUnload = async (ctx: MenuContext) => {
		const choice = await ctx.ui.select(`${UNLOAD} - time since the model was deselected`, [
			UNLOAD_IMMEDIATE,
			...UNLOAD_CHOICES.map((c) => c.label),
			CUSTOM,
		]);
		if (!choice) return;

		let value: string | number | undefined;
		if (choice === CUSTOM) {
			const typed = (await ctx.ui.input(UNLOAD, 'Duration, e.g. "10m", "1h30m"'))?.trim();
			if (!typed) return;
			const parsed = /^\d+$/.test(typed) ? Number.parseInt(typed, 10) : typed;
			if (parsed === "keep" || releaseAfterCheck(parsed)) {
				ctx.ui.notify(`Not changed: "${typed}" is not a valid duration. ${DURATION_HINT}`, "error");
				return;
			}
			value = parsed;
		} else if (choice !== UNLOAD_IMMEDIATE) {
			value = UNLOAD_CHOICES.find((c) => c.label === choice)?.value;
			if (value === undefined) return;
		}

		if (!save(ctx, "releaseAfter", value)) return;
		if (value === undefined) delete settings.releaseAfter;
		else settings.releaseAfter = value;
		ctx.ui.notify(`${UNLOAD}: ${describeUnload(value)}. ${SCOPE}`, "info");
	};

	pi.registerCommand("ollama-preload", {
		description:
			"Model loading: preload on select, idle timeout, and unload on swap or exit. Global, persistent.",
		handler: async (_args, ctx) => {
			const [preloadRow, idleRow, unloadRow] = loadingRows(settings);

			const id = ctx.model?.id;
			const entry = id === undefined ? undefined : settings.modelConfig?.models[id];
			const hasOverrides = entry !== undefined && Object.keys(entry).length > 0;
			const scope = hasOverrides
				? `global, persistent; ${id} has per-model overrides`
				: "global, persistent";

			const row = await ctx.ui.select(`Model loading (${scope})`, [preloadRow, idleRow, unloadRow]);
			if (row === preloadRow) await choosePreload(ctx);
			else if (row === idleRow) await chooseIdleTimeout(ctx);
			else if (row === unloadRow) await chooseUnload(ctx);
		},
	});
}
