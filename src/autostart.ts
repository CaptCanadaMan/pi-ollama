// Offering to start Ollama when it isn't running.
//
// Startup discovery records why it failed. If the configured Ollama is on this
// machine and refused the connection (nothing listening), pi offers once, at
// startup, to start it: on macOS the Ollama app, hidden, so only its menu-bar
// icon appears (quit it there); on Linux a background `ollama serve`, with its
// PID so the user can stop it. The prompt also names the manual routes.

import { spawn } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
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
	/** What would be started (the ollama CLI, or Ollama.app), or undefined when nothing can be. */
	locate(): string | undefined;
	/** Start it; returns how the user stops it again. */
	launch(what: string): { stopHint: string };
	/** Resolves true once the server answers, false if it never does. */
	waitUntilUp(): Promise<boolean>;
	/** Where the launched server's output goes, for the "didn't come up" message. */
	logPath: string;
	/** The ways to start Ollama by hand instead, shown in the prompt. */
	manualHint: string;
	/** What starting it means on this platform, asked in the prompt. */
	description: string;
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
		const startable = launcher.locate();
		if (!startable) return;

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
				`Ollama isn't running at ${settings.baseUrl}. ${launcher.description} ${launcher.manualHint}`,
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

		const { stopHint } = launcher.launch(startable);
		settings.startedOllamaStopHint = stopHint;
		if (!(await launcher.waitUntilUp())) {
			ctx.ui.notify(
				`Started Ollama, but it didn't answer at ${settings.baseUrl}. ` +
					`Its output is in ${launcher.logPath}.`,
				"error",
			);
			return;
		}
		try {
			const models = await refresh();
			ctx.ui.notify(`Started Ollama - ${models.length} model(s) registered. ${stopHint}`, "info");
		} catch (e) {
			ctx.ui.notify(`Started Ollama, but discovering models failed: ${errorText(e)}`, "error");
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

/** Everything a launcher needs from the machine - injected so tests never start real processes. */
export interface LauncherSystem {
	platform: string;
	pathEnv: string | undefined;
	isExecutable(path: string): boolean;
	realpath(path: string): string;
	exists(path: string): boolean;
	/** Start a command detached from pi, output to logPath if given; returns its PID. */
	run(command: string, args: string[], options?: { logPath?: string }): { pid?: number };
}

const realSystem: LauncherSystem = {
	platform: process.platform,
	pathEnv: process.env.PATH,
	isExecutable(path) {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
	realpath: (path) => realpathSync(path),
	exists: (path) => existsSync(path),
	run(command, args, { logPath } = {}) {
		let out: number | "ignore" = "ignore";
		if (logPath) {
			mkdirSync(dirname(logPath), { recursive: true });
			out = openSync(logPath, "a");
		}
		const child = spawn(command, args, { detached: true, stdio: ["ignore", out, out] });
		// A spawn failure arrives as an event; unhandled, it would crash pi.
		child.on("error", (e) => dbg("autostart-spawn-error", { error: String(e) }));
		child.unref();
		if (typeof out === "number") closeSync(out);
		return { pid: child.pid };
	},
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LauncherOptions {
	/** How often to check whether the server answers. Default: 250 ms. */
	pollMs?: number;
	/** How long to wait for it overall. Default: 20 s. */
	timeoutMs?: number;
	system?: LauncherSystem;
}

// Ollama.app bundles the CLI; this finds the bundle from the binary's real path.
const APP_BUNDLE = /^(.*\/Ollama\s?\d*\.app)\//;
const DEFAULT_APP = "/Applications/Ollama.app";

/**
 * The real launcher for this platform. macOS: open Ollama.app hidden, so only
 * its menu-bar icon appears - exactly what Ollama's own CLI does. Linux: a
 * background `ollama serve`, with its PID so the user can stop it. Anything
 * else: nothing to launch, so no offer.
 */
export function createOllamaLauncher(
	target: OllamaTarget,
	{ pollMs = 250, timeoutMs = 20_000, system = realSystem }: LauncherOptions = {},
): OllamaLauncher {
	const waitUntilUp = async () => {
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
	};
	const binary = () => findOllamaBinary(system.pathEnv, system.isExecutable);

	if (system.platform === "darwin") {
		return {
			description: "Start Ollama in the menu bar (no window)?",
			manualHint: "Or open the Ollama app yourself.",
			logPath: join(homedir(), ".ollama", "logs", "server.log"),
			waitUntilUp,
			locate() {
				const cli = binary();
				const app = cli ? APP_BUNDLE.exec(system.realpath(cli))?.[1] : undefined;
				return app ?? (system.exists(DEFAULT_APP) ? DEFAULT_APP : undefined);
			},
			launch(app) {
				system.run("/usr/bin/open", ["-j", "-a", app, "--args", "--fast-startup"]);
				return { stopHint: "Quit it from the Ollama icon in the menu bar when you're done." };
			},
		};
	}

	const logPath = join(homedir(), ".pi", "agent", "cache", "pi-ollama-serve.log");
	return {
		description: "Start a background ollama serve? It keeps running after pi exits.",
		manualHint:
			"Or start it yourself: `ollama serve` in another terminal, or `sudo systemctl start ollama`.",
		logPath,
		waitUntilUp,
		locate: () => (system.platform === "linux" ? binary() : undefined),
		launch(cli) {
			const { pid } = system.run(cli, ["serve"], { logPath });
			return { stopHint: `Stop it with: kill ${pid}` };
		},
	};
}
