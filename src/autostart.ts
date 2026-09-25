// Offering to start a local `ollama serve` when Ollama isn't running.
//
// Startup discovery records why it failed. If the configured Ollama is on this
// machine and refused the connection (nothing listening), pi offers once, at
// startup, to launch a headless server. It runs detached and outlives pi.

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import { dbg } from "./debug.js";
import type { DiscoveredModel } from "./discovery.js";
import { errorText } from "./errors.js";
import { type OllamaTarget, serverVersion } from "./ollama-client.js";
import type { SessionStartPi } from "./session-start.js";
import type { OllamaExtensionSettings } from "./settings.js";

const START_NOW = "Start Ollama now";
const ALWAYS = "Always start it automatically";
const NOT_NOW = "Not now";
const NEVER = "Never ask again";

/**
 * Nothing is listening: Node's fetch fails with ECONNREFUSED (on the error
 * itself or, for localhost's dual-stack attempt, the AggregateError). A
 * timeout means a server is there but stuck - never start a second one.
 */
function isConnectionRefused(err: unknown): boolean {
	const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
	return cause?.code === "ECONNREFUSED";
}

/** This machine: localhost, 127.x, ::1, or 0.0.0.0 (a common OLLAMA_HOST that reaches the local server). */
function isLoopbackUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	return host === "localhost" || host === "[::1]" || host === "0.0.0.0" || host.startsWith("127.");
}

/** Save the choice, keeping everything else in the config file. */
function remember(choice: "always" | "never"): void {
	const config = loadPersistedConfig();
	config.autostart = choice;
	savePersistedConfig(config);
}

/** Starting and watching the server - the process boundary, passed in so tests can fake it. */
export interface OllamaLauncher {
	findBinary(): string | undefined;
	launch(binary: string): void;
	/** Resolves true once the server answers, false if it never does. */
	waitUntilUp(): Promise<boolean>;
	/** Where the launched server's output goes, for the "didn't come up" message. */
	logPath: string;
}

export interface AutostartDeps {
	refresh: () => Promise<DiscoveredModel[]>;
	/** Why startup discovery failed, if it did. */
	startupFailure: unknown;
	launcher: OllamaLauncher;
}

export function registerAutostart(
	pi: SessionStartPi,
	settings: OllamaExtensionSettings,
	{ refresh, startupFailure, launcher }: AutostartDeps,
): void {
	pi.on?.("session_start", async (event, ctx) => {
		const offerable =
			event.reason === "startup" &&
			isConnectionRefused(startupFailure) &&
			isLoopbackUrl(settings.baseUrl);
		if (!offerable) return;
		const binary = launcher.findBinary();
		if (!binary) return;

		const preference = loadPersistedConfig().autostart;
		if (preference === "never") {
			ctx.ui.notify(
				`Ollama isn't running at ${settings.baseUrl}. Auto-start is off - remove "autostart" ` +
					`from ~/.pi/agent/cache/pi-ollama-config.json to be asked again.`,
				"info",
			);
			return;
		}
		if (preference !== "always") {
			if (!ctx.hasUI) return;
			const answer = await ctx.ui.select(
				`Ollama isn't running at ${settings.baseUrl}. Start a background ollama serve? ` +
					"It keeps running after pi exits.",
				[
					START_NOW,
					ALWAYS,
					NOT_NOW,
					NEVER,
				],
			);
			if (answer === ALWAYS) remember("always");
			if (answer === NEVER) remember("never");
			if (answer !== START_NOW && answer !== ALWAYS) return;
		}

		launcher.launch(binary);
		if (!(await launcher.waitUntilUp())) {
			ctx.ui.notify(
				`Started ollama serve, but it didn't answer at ${settings.baseUrl}. ` +
					`Its output is in ${launcher.logPath}.`,
				"error",
			);
			return;
		}
		try {
			const models = await refresh();
			ctx.ui.notify(`Started ollama serve - ${models.length} model(s) registered`, "info");
		} catch (e) {
			ctx.ui.notify(`Started ollama serve, but discovering models failed: ${errorText(e)}`, "error");
		}
	});
}

// Where installers put ollama, for a pi started without a login shell's PATH.
const USUAL_INSTALL_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

/** The first executable `ollama` on PATH, then in the usual install locations. */
export function findOllamaBinary(
	pathEnv: string | undefined,
	isExecutable: (path: string) => boolean,
): string | undefined {
	const dirs = [...(pathEnv ?? "").split(":").filter(Boolean), ...USUAL_INSTALL_DIRS];
	return dirs.map((dir) => `${dir}/ollama`).find(isExecutable);
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LauncherTiming {
	/** How often to check whether the server answers. Default: 250 ms. */
	pollMs?: number;
	/** How long to wait for it overall. Default: 20 s. */
	timeoutMs?: number;
}

/** The real launcher: a detached, headless `ollama serve` that outlives pi. */
export function createOllamaLauncher(
	target: OllamaTarget,
	{ pollMs = 250, timeoutMs = 20_000 }: LauncherTiming = {},
): OllamaLauncher {
	const logPath = join(homedir(), ".pi", "agent", "cache", "pi-ollama-serve.log");
	return {
		logPath,
		findBinary: () => findOllamaBinary(process.env.PATH, isExecutable),
		launch(binary) {
			mkdirSync(dirname(logPath), { recursive: true });
			const out = openSync(logPath, "a");
			const child = spawn(binary, ["serve"], { detached: true, stdio: ["ignore", out, out] });
			// A spawn failure arrives as an event; unhandled, it would crash pi.
			child.on("error", (e) => dbg("autostart-spawn-error", { error: String(e) }));
			child.unref();
			closeSync(out);
		},
		async waitUntilUp() {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				try {
					await serverVersion(target, { timeoutMs: pollMs * 4 });
					return true;
				} catch {
					await sleep(pollMs);
				}
			}
			return false;
		},
	};
}
