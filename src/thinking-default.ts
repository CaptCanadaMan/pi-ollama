// A model's own thinking level, from the config file (GH-14).
//
// `models["<id>"].thinkingLevel` is the level that loads when that model
// becomes the active one: on a model switch, and for the model a new session
// starts on. Switching between two models therefore restores each one's level
// in a single step, with no second trip to the thinking picker.
//
// It is a default, applied once per activation, by setting pi's own level -
// so pi's picker shows the real value and the user can still change it.
//
// Coexisting with anything else that sets the level (the user, or another
// extension such as pi-persona, which switches model and then sets a level):
// a change this module didn't make is an explicit choice. One made since the
// model became active is never overridden. Because pi announces a model
// switch before another extension can follow it with its own level, that
// extension's level simply lands after ours and wins; and at session start,
// where handler order between extensions isn't ours to control, we stand
// down if a level was already chosen.
//
// With no thinkingLevel in the config file this module does nothing at all.
//
// /ollama-think sets it from inside pi: a picker of the levels the model
// supports, as Ollama reports them, saved to the model's entry in the config
// file. pi's own /thinking changes the level for now; this one decides what
// the model comes up with every time.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import type { DiscoveredModel } from "./discovery.js";
import {
	type ConfigIssue,
	loadModelConfig,
	type ModelConfigFile,
	resolveModelSettings,
} from "./model-config.js";
import type { OllamaExtensionSettings } from "./settings.js";
import { supportedLevels, type ThinkingLevelMap, toThinkingLevelMap } from "./thinking.js";

interface ThinkingModel {
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface Pi {
	on?: (
		event: "session_start" | "model_select" | "thinking_level_select",
		handler: (
			event: { reason?: string; model?: ThinkingModel; level?: string },
			ctx: { model?: ThinkingModel },
		) => void,
	) => void;
	// Optional: a pi without them can't have its level set, and nothing is applied.
	setThinkingLevel?: (level: string) => void;
	getThinkingLevel?: () => string;
	registerCommand?: (
		name: string,
		config: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> },
	) => void;
}

interface CommandContext {
	model?: ThinkingModel;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

const NOT_SET = "Not set";
const OTHER_MODEL = "Other model";

const levelsOf = (model: Pick<ThinkingModel, "reasoning" | "thinkingLevelMap">): string[] =>
	supportedLevels(Boolean(model.reasoning), model.thinkingLevelMap);

export function registerThinkingDefault(
	pi: Pi,
	settings: OllamaExtensionSettings,
	/** The models discovery found, for /ollama-think's lists. */
	getModels: () => DiscoveredModel[] = () => [],
): void {
	// A level chosen by someone else since the current model became active.
	let chosenByOthers = false;
	// The level we are in the middle of setting, so our own change isn't
	// mistaken for someone else's.
	let ours: string | undefined;

	/** Set pi's level, marked as ours so the resulting event isn't taken for someone else's choice. */
	const setLevel = (level: string) => {
		if (!pi.setThinkingLevel || pi.getThinkingLevel?.() === level) return;
		ours = level;
		try {
			pi.setThinkingLevel(level);
		} finally {
			ours = undefined;
		}
	};

	const apply = (model: ThinkingModel | undefined) => {
		if (!model || model.api !== "ollama-native") return;
		const level = resolveModelSettings(settings.modelConfig, settings, model.id).thinkingLevel;
		if (level === undefined) return;
		// An unsupported level is reported at startup (thinkingLevelIssues), not forced on pi.
		if (!levelsOf(model).includes(level)) return;
		setLevel(level);
	};

	pi.on?.("thinking_level_select", (event) => {
		if (event.level !== undefined && event.level === ours) return;
		chosenByOthers = true;
	});

	pi.on?.("model_select", (event) => {
		// A new activation. pi may have clamped the level just before announcing
		// the switch; that was pi, not a choice, so it is forgotten here.
		chosenByOthers = false;
		apply(event.model);
	});

	pi.on?.("session_start", (event, ctx) => {
		// A resumed, forked or reloaded session restores its own level.
		if (event.reason !== "startup" && event.reason !== "new") return;
		if (chosenByOthers) return;
		apply(ctx.model);
	});

	// ── /ollama-think ──

	/** Models that have more than "off" to choose from, with their levels as Ollama reports them. */
	const thinkingModels = () =>
		getModels()
			.map((m) => ({ id: m.id, levels: supportedLevels(m.reasoning, toThinkingLevelMap(m.thinking)) }))
			.filter((m) => m.levels.length > 1);

	/** Write one model's thinkingLevel (undefined removes it) and reload the per-model settings. */
	const saveLevel = (modelId: string, level: string | undefined): string | undefined => {
		const config = loadPersistedConfig();
		const models = (
			typeof config.models === "object" && config.models !== null ? config.models : {}
		) as Record<string, Record<string, unknown>>;
		const entry = { ...models[modelId] };
		if (level === undefined) delete entry.thinkingLevel;
		else entry.thinkingLevel = level;
		if (Object.keys(entry).length > 0) models[modelId] = entry;
		else delete models[modelId];
		if (Object.keys(models).length > 0) config.models = models;
		else delete config.models;
		const unsaved = savePersistedConfig(config);
		if (!unsaved) settings.modelConfig = loadModelConfig(config).config;
		return unsaved;
	};

	pi.registerCommand?.("ollama-think", {
		description:
			"Set the thinking level a model loads with. Per-model, persistent. Shows the levels the model supports.",
		handler: async (_args, ctx) => {
			const available = thinkingModels();
			let target = available.find((m) => m.id === ctx.model?.id && ctx.model.api === "ollama-native");

			for (;;) {
				if (!target) {
					if (available.length === 0) {
						ctx.ui.notify("No Ollama model with thinking levels is registered.", "warning");
						return;
					}
					const picked = await ctx.ui.select(
						"Thinking level - choose a model",
						available.map((m) => m.id),
					);
					target = available.find((m) => m.id === picked);
					if (!target) return;
				}

				const saved = settings.modelConfig?.models[target.id]?.thinkingLevel;
				const choice = await ctx.ui.select(
					`Thinking level: ${target.id} (per-model, persistent) - ${saved ?? "not set"}`,
					[...target.levels, NOT_SET, OTHER_MODEL],
				);
				if (!choice) return;
				if (choice === OTHER_MODEL) {
					target = undefined;
					continue;
				}

				const level = choice === NOT_SET ? undefined : choice;
				const unsaved = saveLevel(target.id, level);
				if (unsaved) {
					ctx.ui.notify(`Not changed: ${unsaved}`, "error");
					return;
				}
				if (level === undefined) {
					ctx.ui.notify(`Thinking level: ${target.id} not set. pi's level applies.`, "info");
					return;
				}
				// The model the user is on takes the level now; any other gets it when selected.
				if (target.id === ctx.model?.id) setLevel(level);
				ctx.ui.notify(`Thinking level: ${target.id} = ${level}. Per-model, persistent.`, "info");
				return;
			}
		},
	});
}

/**
 * Configured levels the model they are set on doesn't support. Needs the
 * discovered models, so it runs after discovery; a configured model that
 * wasn't found is not a problem here.
 */
export function thinkingLevelIssues(
	config: ModelConfigFile | undefined,
	models: Array<Pick<ThinkingModel, "id" | "reasoning" | "thinkingLevelMap">>,
): ConfigIssue[] {
	if (!config) return [];
	const issues: ConfigIssue[] = [];
	for (const model of models) {
		const level = config.models[model.id]?.thinkingLevel;
		if (level === undefined) continue;
		const levels = levelsOf(model);
		if (levels.includes(level)) continue;
		issues.push({
			severity: "error",
			path: `models[${JSON.stringify(model.id)}].thinkingLevel`,
			message: `= ${JSON.stringify(level)} is not a level this model supports (${levels.join(", ")}) - not applied`,
		});
	}
	return issues;
}
