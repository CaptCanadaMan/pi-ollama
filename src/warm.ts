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
import {
	loadModel,
	type OllamaTarget,
	runningModels,
	targetFor,
	unloadModel,
} from "./ollama-client.js";
import { buildChatRequestBody, buildTurnRequest, type PiModel, requestOptions } from "./provider.js";
import type { OllamaExtensionSettings } from "./settings.js";
import { resolveModelSettings } from "./model-config.js";
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
		event:
			| "session_start"
			| "model_select"
			| "thinking_level_select"
			| "message_end"
			| "agent_start",
		handler: (
			event: {
				model?: WarmModel;
				level?: string;
				message?: { role?: string; api?: string; model?: string };
			},
			ctx: WarmContext,
		) => void,
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
	/** How long a model switch waits before warming, in case another follows. Default 2500 ms. */
	settleMs?: number;
}

// Reading pi's ~7,800-token prompt takes 17 s on an M1 Max and longer on
// smaller hardware; timing out would throw that work away.
const WARM_TIMEOUT_MS = 600_000;
const DEFAULT_SETTLE_MS = 2500;

export function registerWarmup(
	pi: Pi,
	settings: OllamaExtensionSettings,
	{ whenReady, settleMs = DEFAULT_SETTLE_MS }: WarmupDeps,
): void {
	// The model the user most recently landed on. A warm-up that was waiting
	// for Ollama and has since been overtaken by a switch is dropped, so
	// switching around before Ollama is up doesn't load several models.
	let latest: WarmModel | undefined;
	// Warm-up requests in flight, by their exact body.
	const inFlight = new Map<string, { modelId: string; controller: AbortController }>();
	// Models this session's warm-up brought into memory and that have had no
	// turn yet, with the server each is on. Moving to another model unloads
	// them, so browsing the model list doesn't leave a pile of loaded models.
	// A model that was already loaded, or that the user has used, is never here.
	const loadedUnused = new Map<string, OllamaTarget>();
	// Counts the runs pi has started, so a warm-up that was waiting can tell a
	// prompt went out in the meantime.
	let promptsSent = 0;

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
				keepAlive: resolveModelSettings(settings.modelConfig, settings, model.id).keepAlive,
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

	/** Stop warm-ups still running for any other model: two at once fight over memory and the GPU. */
	const stopOthers = (modelId: string) => {
		for (const running of inFlight.values()) {
			if (running.modelId !== modelId) running.controller.abort();
		}
	};

	/** Unload every model this session loaded and never used, except the one now wanted. */
	const releaseOthers = (modelId: string) => {
		for (const [id, target] of loadedUnused) {
			if (id === modelId) continue;
			loadedUnused.delete(id);
			unloadModel(target, id).catch((e) =>
				dbg("unload-failed", { model: id, error: errorText(e) }),
			);
		}
	};

	/** Remember the model as ours to release, but only if we can see it wasn't loaded already. */
	const claimIfNotLoaded = async (model: WarmModel, target: OllamaTarget) => {
		if (loadedUnused.has(model.id)) return;
		try {
			const running = await runningModels(target);
			if (!running.some((m) => m.name === model.id)) loadedUnused.set(model.id, target);
		} catch {
			// Can't tell: leave it alone rather than unload someone else's model.
		}
	};

	const warm = async (model: WarmModel, ctx: WarmContext, waitMs = 0) => {
		latest = model;
		stopOthers(model.id);
		const promptsBefore = promptsSent;
		await whenReady();
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		if (model !== latest) return;
		releaseOthers(model.id);
		// A prompt that went out while we waited is already loading the model and
		// reading the same prefix; a warm-up beside it would only compete with it.
		if (promptsSent !== promptsBefore) return;
		const body = warmBody(model, ctx);
		// Only an identical request is a duplicate: a new thinking level or tool
		// set is a different prefix and gets its own warm-up.
		const key = JSON.stringify(body);
		if (inFlight.has(key)) return;
		const controller = new AbortController();
		inFlight.set(key, { modelId: model.id, controller });
		const target = targetFor(settings, model.baseUrl);
		const doing = ctx.getSystemPrompt ? "reading pi's prompt" : "loading the model";
		const stopTicker = startFooterTicker(ctx, `warming ${model.id} · ${doing}`);
		try {
			await claimIfNotLoaded(model, target);
			await loadModel(target, body, { timeoutMs: WARM_TIMEOUT_MS, signal: controller.signal });
		} catch (e) {
			// Best-effort: the first real turn loads the model anyway, and reports
			// any real problem there. A stopped warm-up lands here too.
			dbg("warm-failed", { model: model.id, error: errorText(e) });
		} finally {
			inFlight.delete(key);
			stopTicker();
		}
	};

	// Resolved here, per request, so /ollama-warm-up takes effect at once. A
	// model's own `warm` in the config file wins over the global switch.
	const request = (model: WarmModel | undefined, ctx: WarmContext, waitMs = 0) => {
		if (model?.api !== "ollama-native") return;
		if (resolveModelSettings(settings.modelConfig, settings, model.id).warm) {
			void warm(model, ctx, waitMs);
		}
	};
	pi.on?.("session_start", (_event, ctx) => request(ctx.model, ctx));
	// A switch waits a moment before loading anything, so cycling through the
	// model list only warms the model the user stops on.
	pi.on?.("model_select", (event, ctx) => request(event.model, ctx, settleMs));
	pi.on?.("agent_start", () => {
		promptsSent++;
	});
	// A real turn makes the model the user's: from then on keep_alive decides
	// how long it stays loaded, and this session no longer unloads it.
	pi.on?.("message_end", (event, ctx) => {
		const message = event.message;
		if (message?.role !== "assistant" || message.api !== "ollama-native") return;
		const id = message.model ?? ctx.model?.id;
		if (id) loadedUnused.delete(id);
	});
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
			const unsaved = savePersistedConfig(config);
			if (unsaved) {
				ctx.ui?.notify?.(`Not changed: ${unsaved}`, "error");
				return;
			}
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
