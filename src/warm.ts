// Warming the model so the first turn doesn't wait for Ollama to load it.
//
// The warm-up is the same request a real turn sends - same model options, so
// the same num_ctx Ollama loads with - minus the messages.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { dbg } from "./debug.js";
import { errorText } from "./errors.js";
import { loadModel, targetFor } from "./ollama-client.js";
import { buildChatRequestBody, requestOptions } from "./provider.js";
import type { OllamaExtensionSettings } from "./settings.js";
import { setFooterStatus, type StatusContext } from "./status.js";

interface WarmModel {
	id: string;
	api?: string;
	baseUrl?: string;
	contextWindow?: number;
}

interface WarmContext extends StatusContext {
	model?: WarmModel;
}

/** Footer status key, separate from the tok/s one so neither clobbers the other. */
const STATUS_KEY = "ollama-warm";

interface CommandContext extends WarmContext {
	ui?: StatusContext["ui"] & {
		select?(title: string, options: string[]): Promise<string | undefined>;
		notify?(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface Pi {
	on?: (
		event: "session_start" | "model_select",
		handler: (event: { model?: WarmModel }, ctx: WarmContext) => void,
	) => void;
	registerCommand?: (
		name: string,
		config: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> },
	) => void;
}

const ON = "On (default)";
const OFF = "Off";

export interface WarmupDeps {
	/** Resolves once Ollama has answered a refresh. */
	whenReady: () => Promise<void>;
}

export function registerWarmup(
	pi: Pi,
	settings: OllamaExtensionSettings,
	{ whenReady }: WarmupDeps,
): void {
	// The model the user most recently landed on. A warm-up that was waiting
	// for Ollama and has since been overtaken by a switch is dropped, so
	// switching around before Ollama is up doesn't load several models.
	let latest: WarmModel | undefined;
	// Loads in flight, by model and num_ctx: a second ask for the same load waits on nothing new.
	const inFlight = new Set<string>();

	const warm = async (model: WarmModel, ctx: WarmContext) => {
		latest = model;
		await whenReady();
		if (model !== latest) return;
		const options = requestOptions(model, settings);
		const key = `${model.id}@${options.num_ctx}`;
		if (inFlight.has(key)) return;
		inFlight.add(key);
		const body = buildChatRequestBody({
			modelId: model.id,
			messages: [],
			options,
			keepAlive: settings.keepAlive,
			reasoningCapable: false,
			reasoningLevel: undefined,
			thinkingLevelMap: undefined,
			tools: undefined,
		});
		setFooterStatus(ctx, STATUS_KEY, `loading ${model.id}…`);
		try {
			await loadModel(targetFor(settings, model.baseUrl), { ...body, messages: [] });
		} catch (e) {
			// Best-effort: the first real turn loads the model anyway, and reports
			// any real problem there.
			dbg("warm-failed", { model: model.id, error: errorText(e) });
		} finally {
			inFlight.delete(key);
			setFooterStatus(ctx, STATUS_KEY, undefined);
		}
	};

	// settings.warm is checked here, per request, so /ollama-warm-up takes effect at once.
	const request = (model: WarmModel | undefined, ctx: WarmContext) => {
		if (settings.warm && model?.api === "ollama-native") void warm(model, ctx);
	};
	pi.on?.("session_start", (_event, ctx) => request(ctx.model, ctx));
	pi.on?.("model_select", (event, ctx) => request(event.model, ctx));

	pi.registerCommand?.("ollama-warm-up", {
		description:
			"Turn model warm-up on or off: load the model at session start and on model switch. Persistent across restarts.",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui?.select?.(
				`Model warm-up - currently ${settings.warm ? "on" : "off"}`,
				[ON, OFF],
			);
			if (!choice) return;
			const on = choice === ON;
			const config = loadPersistedConfig();
			config.warm = on;
			savePersistedConfig(config);
			settings.warm = on;
			ctx.ui?.notify?.(
				on
					? "Model warm-up on: the model loads at session start and on switch. Persists across pi launches."
					: "Model warm-up off: the first turn loads the model. Persists across pi launches.",
				"info",
			);
			request(ctx.model, ctx);
		},
	});
}

/**
 * "Ollama has answered": marked by every successful refresh (startup, after
 * autostart launches the server, /ollama-refresh). Warm-ups wait on it, so
 * they never race a server that isn't up yet.
 */
export function createReadySignal(): { markReady(): void; whenReady(): Promise<void> } {
	let markReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	return { markReady: () => markReady(), whenReady: () => ready };
}
