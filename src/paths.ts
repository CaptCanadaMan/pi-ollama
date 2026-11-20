// Where pi-ollama keeps its files, all under pi's agent directory:
//
//   <agent dir>/pi-ollama.json   the config file: settings the user chose or
//                                wrote by hand. Not a cache - never deleted
//                                for them.
//   <agent dir>/cache/           the model list and logs: safe to delete.
//
// pi lets the agent directory be moved with PI_CODING_AGENT_DIR (default
// ~/.pi/agent). Resolved on every call, not at import, so a relocated
// directory is honoured and tests can point it at a throwaway folder.

import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

export function cacheDir(): string {
	return join(agentDir(), "cache");
}

/** A file in pi-ollama's cache folder, e.g. cachePath("pi-ollama-models.json"). */
export function cachePath(name: string): string {
	return join(cacheDir(), name);
}

/** pi-ollama's config file: <agent dir>/pi-ollama.json. */
export function configFilePath(): string {
	return join(agentDir(), "pi-ollama.json");
}

/** Where the config file lived before it held hand-written settings (config.ts moves it). */
export function legacyConfigFilePath(): string {
	return cachePath("pi-ollama-config.json");
}
