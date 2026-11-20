// Where pi-ollama keeps its files: the cache folder of pi's agent directory.
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

/** A file in pi-ollama's cache folder, e.g. cachePath("pi-ollama-config.json"). */
export function cachePath(name: string): string {
	return join(cacheDir(), name);
}
