// Releasing a model the user has used, once they leave it.
//
// By default a used model stays loaded for as long as keep_alive says, which
// with keep_alive -1 is until Ollama quits - across model switches and after
// pi exits. Visit a few large models in one session and they all stay in
// memory. `releaseAfter` (global via /ollama-release, or per model in the
// config file) changes that for the moment the user leaves a model, by
// switching to another or quitting pi:
//
//   unset     nothing happens; keep_alive decides (the default)
//   0         the model is unloaded at once
//   "10m"     the model is given ten more minutes, then Ollama unloads it
//
// It works by sending the model an empty request carrying that keep_alive, so
// the countdown is Ollama's own: nothing depends on pi still running, and
// coming back to the model simply restarts it with the normal keep_alive.
//
// Only models that had a real turn this session are touched. One the warm-up
// loaded and nobody used is warm.ts's to clean up; one that was never loaded
// by this session isn't ours at all.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { dbg } from "./debug.js";
import { errorText } from "./errors.js";
import { releaseAfterCheck, resolveModelSettings } from "./model-config.js";
import { type OllamaTarget, setModelLifetime, targetFor } from "./ollama-client.js";
import type { OllamaExtensionSettings } from "./settings.js";

interface ReleaseModel {
	id: string;
	api?: string;
	baseUrl?: string;
}

interface ReleaseContext {
	model?: ReleaseModel;
	ui?: {
		select?(title: string, options: string[]): Promise<string | undefined>;
		input?(title: string, placeholder?: string): Promise<string | undefined>;
		notify?(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface Pi {
	on?: (
		event: "session_start" | "model_select" | "message_end" | "session_shutdown",
		handler: (
			event: { model?: ReleaseModel; message?: { role?: string; api?: string; model?: string } },
			ctx: ReleaseContext,
		) => void | Promise<void>,
	) => void;
	registerCommand?: (
		name: string,
		config: { description: string; handler: (args: string, ctx: ReleaseContext) => Promise<void> },
	) => void;
}

export interface ReleaseDeps {
	/** How long a switch waits before releasing, in case the user comes straight back. Default 2500 ms. */
	settleMs?: number;
}

const DEFAULT_SETTLE_MS = 2500;
// Quitting pi waits for the release, but not for long: an unreachable Ollama
// must not hold the exit.
const SHUTDOWN_TIMEOUT_MS = 3000;

const KEEP = "Leave it to keep_alive (default)";
const AT_ONCE = "As soon as I leave the model";
const PRESETS: Array<{ label: string; value: string }> = [
	{ label: "5 minutes after I leave it", value: "5m" },
	{ label: "30 minutes after I leave it", value: "30m" },
];
const CUSTOM = "Custom time…";

/** "unloaded as soon as you leave it" / "unloaded 10m after you leave it" / "left to keep_alive". */
export function describeRelease(releaseAfter: string | number | undefined): string {
	if (releaseAfter === undefined) return "left to keep_alive";
	if (releaseAfter === 0) return "unloaded as soon as you leave it";
	const time = typeof releaseAfter === "number" ? `${releaseAfter}s` : releaseAfter;
	return `unloaded ${time} after you leave it`;
}

export function registerRelease(
	pi: Pi,
	settings: OllamaExtensionSettings,
	{ settleMs = DEFAULT_SETTLE_MS }: ReleaseDeps = {},
): void {
	/** The model pi is on now, Ollama's or not. */
	let current: ReleaseModel | undefined;
	/** Models that had a real turn this session and are still ours to release, with their server. */
	const used = new Map<string, OllamaTarget>();

	const release = async (modelId: string, timeoutMs?: number): Promise<void> => {
		const target = used.get(modelId);
		if (!target) return;
		const { releaseAfter } = resolveModelSettings(settings.modelConfig, settings, modelId);
		if (releaseAfter === undefined) return;
		// Released once: if the user comes back and has another turn, it is used again.
		used.delete(modelId);
		try {
			await setModelLifetime(
				target,
				modelId,
				releaseAfter,
				timeoutMs === undefined ? undefined : { timeoutMs },
			);
		} catch (e) {
			// Best-effort: the model just stays loaded as it would have anyway.
			dbg("release-failed", { model: modelId, error: errorText(e) });
		}
	};

	pi.on?.("session_start", (_event, ctx) => {
		current = ctx.model;
	});

	pi.on?.("message_end", (event, ctx) => {
		const message = event.message;
		if (message?.role !== "assistant" || message.api !== "ollama-native") return;
		const id = message.model ?? ctx.model?.id;
		if (id) used.set(id, targetFor(settings, ctx.model?.id === id ? ctx.model.baseUrl : undefined));
	});

	pi.on?.("model_select", async (event) => {
		const left = current;
		current = event.model;
		if (!left || left.id === current?.id) return;
		// Cycling past a model and back is not leaving it.
		if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
		if (current?.id === left.id) return;
		await release(left.id);
	});

	pi.on?.("session_shutdown", async () => {
		await Promise.all([...used.keys()].map((id) => release(id, SHUTDOWN_TIMEOUT_MS)));
	});

	pi.registerCommand?.("ollama-release", {
		description:
			"Choose what happens to a model you've used once you switch away or quit pi: leave it loaded, unload it, or unload it after a while. Persistent across restarts.",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui?.select?.(
				`After you leave a model - currently ${describeRelease(settings.releaseAfter)}`,
				[KEEP, AT_ONCE, ...PRESETS.map((p) => p.label), CUSTOM],
			);
			if (!choice) return;

			let value: string | number | undefined;
			if (choice === KEEP) {
				value = undefined;
			} else if (choice === AT_ONCE) {
				value = 0;
			} else if (choice === CUSTOM) {
				const typed = (await ctx.ui?.input?.("Unload how long after you leave it?", 'e.g. "10m", "1h30m"'))?.trim();
				if (!typed) return;
				const parsed = /^\d+$/.test(typed) ? Number.parseInt(typed, 10) : typed;
				const reason = releaseAfterCheck(parsed);
				if (reason) {
					ctx.ui?.notify?.(`Not changed: "${typed}" ${reason}.`, "error");
					return;
				}
				value = parsed;
			} else {
				value = PRESETS.find((p) => p.label === choice)?.value;
				if (value === undefined) return;
			}

			const config = loadPersistedConfig();
			if (value === undefined) delete config.releaseAfter;
			else config.releaseAfter = value;
			const unsaved = savePersistedConfig(config);
			if (unsaved) {
				ctx.ui?.notify?.(`Not changed: ${unsaved}`, "error");
				return;
			}
			if (value === undefined) delete settings.releaseAfter;
			else settings.releaseAfter = value;
			ctx.ui?.notify?.(
				`A model you've used is now ${describeRelease(value)}. Applies from your next switch and persists across pi launches.`,
				"info",
			);
		},
	});
}
