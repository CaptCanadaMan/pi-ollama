// Warming the model so the first turn doesn't wait on Ollama.
//
// Two costs make a cold first turn slow: loading the weights, and reading pi's
// system prompt and tool definitions (~7,800 tokens - 48 s on gemma4:12b). The
// warm-up pays both in the background: it sends the first turn's own prefix
// (built by the same buildTurnRequest as a real turn, so it matches exactly)
// asking for one token. Ollama keeps that prefix cached, and the first real
// turn only reads the user's message. On a pi that can't report its system
// prompt, it falls back to loading the weights alone.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { dbg } from "./debug.js";
import { errorText } from "./errors.js";
import { loadModel, targetFor } from "./ollama-client.js";
import { buildChatRequestBody, buildTurnRequest, type PiModel, requestOptions } from "./provider.js";
import type { OllamaExtensionSettings } from "./settings.js";
import { setFooterStatus, type StatusContext } from "./status.js";

type WarmModel = PiModel;

interface WarmContext extends StatusContext {
	model?: WarmModel;
	/** pi's current thinking level ("off" or a level name). */
	thinkingLevel?: string;
	/** pi's effective system prompt. Absent on older pi: weights-only warm-up. */
	getSystemPrompt?: () => string;
}

interface ToolInfo {
	name: string;
	description: string;
	parameters: object;
}

/** Footer status key, separate from the tok/s one so neither clobbers the other. */
const STATUS_KEY = "ollama-warm";

// Ollama reports nothing while it reads a prompt, so the footer shows what is
// happening and for how long, with a spinner so a long read doesn't look stuck.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 250;

/** Show `label` in the footer with a spinner and elapsed seconds; returns the stop function. */
function startFooterTicker(ctx: StatusContext, label: string): () => void {
	const started = Date.now();
	let frame = 0;
	const render = () => {
		const seconds = Math.floor((Date.now() - started) / 1000);
		setFooterStatus(ctx, STATUS_KEY, `${SPINNER[frame++ % SPINNER.length]} ${label} · ${seconds}s`);
	};
	render();
	const timer = setInterval(render, TICK_MS);
	return () => {
		clearInterval(timer);
		setFooterStatus(ctx, STATUS_KEY, undefined);
	};
}

interface CommandContext extends WarmContext {
	ui?: StatusContext["ui"] & {
		select?(title: string, options: string[]): Promise<string | undefined>;
		notify?(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface Pi {
	on?: (
		event: "session_start" | "model_select" | "thinking_level_select",
		handler: (event: { model?: WarmModel; level?: string }, ctx: WarmContext) => void,
	) => void;
	getAllTools?: () => ToolInfo[];
	getActiveTools?: () => string[];
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
	// Warm-up requests in flight, by their exact body.
	const inFlight = new Set<string>();

	/** The active tools, in pi's order - the order the first turn declares them in. */
	const activeTools = (): ToolInfo[] => {
		const all = new Map((pi.getAllTools?.() ?? []).map((t) => [t.name, t]));
		return (pi.getActiveTools?.() ?? []).flatMap((name) => all.get(name) ?? []);
	};

	/** The first turn's prefix, one token requested - or, on an older pi, just the load. */
	const warmBody = (model: WarmModel, ctx: WarmContext): object => {
		const systemPrompt = ctx.getSystemPrompt?.();
		if (systemPrompt === undefined) {
			return buildChatRequestBody({
				modelId: model.id,
				messages: [],
				options: requestOptions(model, settings),
				keepAlive: settings.keepAlive,
				reasoningCapable: false,
				reasoningLevel: undefined,
				thinkingLevelMap: undefined,
				tools: undefined,
			});
		}
		// pi sends no reasoning level when thinking is off.
		const reasoning = ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
		const body = buildTurnRequest(
			model,
			{ systemPrompt, tools: activeTools(), messages: [] },
			{ reasoning },
			settings,
		);
		return { ...body, stream: false, options: { ...body.options, num_predict: 1 } };
	};

	const warm = async (model: WarmModel, ctx: WarmContext) => {
		latest = model;
		await whenReady();
		if (model !== latest) return;
		const body = warmBody(model, ctx);
		// Only an identical request is a duplicate: a new thinking level or tool
		// set is a different prefix and gets its own warm-up.
		const key = JSON.stringify(body);
		if (inFlight.has(key)) return;
		inFlight.add(key);
		const doing = ctx.getSystemPrompt ? "reading pi's prompt" : "loading the model";
		const stopTicker = startFooterTicker(ctx, `warming ${model.id} · ${doing}`);
		try {
			await loadModel(targetFor(settings, model.baseUrl), body);
		} catch (e) {
			// Best-effort: the first real turn loads the model anyway, and reports
			// any real problem there.
			dbg("warm-failed", { model: model.id, error: errorText(e) });
		} finally {
			inFlight.delete(key);
			stopTicker();
		}
	};

	// settings.warm is checked here, per request, so /ollama-warm-up takes effect at once.
	const request = (model: WarmModel | undefined, ctx: WarmContext) => {
		if (settings.warm && model?.api === "ollama-native") void warm(model, ctx);
	};
	pi.on?.("session_start", (_event, ctx) => request(ctx.model, ctx));
	pi.on?.("model_select", (event, ctx) => request(event.model, ctx));
	// A new thinking level can change how the prompt renders, so the cached
	// prefix no longer matches. The event carries the new level; ctx may not yet.
	pi.on?.("thinking_level_select", (event, ctx) =>
		request(ctx.model, { ...ctx, thinkingLevel: event.level }),
	);

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
