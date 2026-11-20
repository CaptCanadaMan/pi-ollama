// Releasing a model the user has used, once they leave it.
//
// keep_alive alone can't do this: it only counts from the last request, so
// with keep_alive -1 a used model stays in memory until Ollama quits - across
// model switches and after pi exits. Visit a few large models in one session
// and they are all still loaded at the end of it.
//
// So when the user leaves a model, by switching to another or quitting pi,
// `releaseAfter` decides what becomes of it (global via /ollama-preload,
// or per model in the config file):
//
//   0 (default)   the model is unloaded at once
//   "10m"         the model is given ten more minutes, then Ollama unloads it
//   "keep"        nothing happens; keep_alive goes on deciding
//
// It works by sending the model an empty request carrying that keep_alive, so
// the countdown is Ollama's own: nothing depends on pi still running, and
// coming back to the model simply restarts it with the normal keep_alive.
//
// Only models that had a real turn this session are touched. One the warm-up
// loaded and nobody used is warm.ts's to clean up; one that was never loaded
// by this session isn't ours at all.

import { dbg } from "./debug.js";
import { errorText } from "./errors.js";
import { resolveModelSettings } from "./model-config.js";
import { type OllamaTarget, setModelLifetime, targetFor } from "./ollama-client.js";
import type { OllamaExtensionSettings } from "./settings.js";

interface ReleaseModel {
	id: string;
	api?: string;
	baseUrl?: string;
}

interface ReleaseContext {
	model?: ReleaseModel;
}

interface Pi {
	on?: (
		event: "session_start" | "model_select" | "message_end" | "session_shutdown",
		handler: (
			event: { model?: ReleaseModel; message?: { role?: string; api?: string; model?: string } },
			ctx: ReleaseContext,
		) => void | Promise<void>,
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
		if (releaseAfter === "keep") return;
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
}
