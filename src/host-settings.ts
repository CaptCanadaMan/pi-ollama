// Host selection uses only user-level settings, never untrusted project files.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveHost(
	envHost = process.env.OLLAMA_HOST,
	settingsPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json"),
): string {
	let host = envHost?.trim();
	if (!host) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			const configured = settings?.ollama?.baseUrl;
			if (typeof configured === "string") host = configured.trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Cannot read Ollama host from ${settingsPath}: ${String(error)}`);
			}
		}
	}
	host ||= "localhost:11434";
	const url = new URL(host.includes("://") ? host : `http://${host}`);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Ollama host must use http:// or https://");
	}
	if (url.search || url.hash || url.username || url.password) {
		throw new Error("Ollama host must not contain credentials, query parameters, or a fragment");
	}
	// Accept URLs migrated from an OpenAI-compatible or native API configuration.
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
	return url.toString().replace(/\/+$/, "");
}
