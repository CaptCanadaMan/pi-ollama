// Persistent extension configuration storage.
//
// Holds what should survive across pi launches: the choices the slash commands
// save, and the per-model settings the user writes by hand (model-config.ts).
//
// Location: <pi agent dir>/pi-ollama.json (paths.ts; by default
// ~/.pi/agent/cache/), next to the model discovery cache and the debug log.
//   - JSON object; tolerant to missing/extra fields.
//   - Because part of it is hand-written, a file that can't be read is never
//     saved over: the user's text matters more than the setting being saved.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath, legacyConfigFilePath } from "./paths.js";

const configPath = configFilePath;

/**
 * Which host the key in OLLAMA_API_KEY was approved for. Only a fingerprint
 * of the key is stored, never the key itself.
 */
export interface ApiKeyApproval {
	host: string;
	fingerprint: string;
}

export interface PersistedConfig {
	/**
	 * The default Ollama server, for when OLLAMA_HOST isn't set. Hand-edited;
	 * takes what OLLAMA_HOST takes and is validated in settings.ts.
	 */
	host?: string;
	/** User-set context length override (set via /ollama-context). */
	contextLength?: number;
	/** User-set keep_alive override (Idle Timeout in /ollama-preload). Absent = defer to the server. */
	keepAlive?: string | number;
	/** The host OLLAMA_API_KEY was approved for (see ApiKeyApproval). */
	apiKeyApproval?: ApiKeyApproval;
	/** Saved answer to "start Ollama?" at startup. Absent = ask. */
	autostart?: "always" | "never";
	/** Preload on select, set via /ollama-preload. Absent = OLLAMA_NATIVE_WARM, else on. */
	warm?: boolean;
	/** What happens to a used model after the user leaves it (Unload on Swap or Exit in /ollama-preload): 0, a duration or "keep". Absent = unload at once. */
	releaseAfter?: string | number;
	/** Per-model settings, keyed by exact model id. Hand-edited; validated by model-config.ts. */
	models?: unknown;
}

/**
 * The file used to live in the cache folder, as cache/pi-ollama-config.json.
 * It is moved once, as it is, the first time it is looked for and the new
 * file doesn't exist. If it can't be moved it is read where it lies, so a
 * permissions problem never costs the user their saved settings.
 */
function locate(): string {
	if (existsSync(configPath())) return configPath();
	const legacy = legacyConfigFilePath();
	if (!existsSync(legacy)) return configPath();
	try {
		mkdirSync(dirname(configPath()), { recursive: true });
		renameSync(legacy, configPath());
		return configPath();
	} catch {
		return legacy;
	}
}

/** The file's contents, or why it can't be used. A missing file is an empty config. */
function read(): { config: PersistedConfig; problem?: string } {
	try {
		const path = locate();
		if (!existsSync(path)) return { config: {} };
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { config: {}, problem: "the file must contain a JSON object" };
		}
		return { config: parsed as PersistedConfig };
	} catch (e) {
		return { config: {}, problem: e instanceof Error ? e.message : String(e) };
	}
}

export function loadPersistedConfig(): PersistedConfig {
	return read().config;
}

/** Why the file on disk can't be used right now, or undefined when it is fine or absent. */
export function persistedConfigProblem(): string | undefined {
	return read().problem;
}

/**
 * Write the config. Returns undefined when it was saved, otherwise why not -
 * callers show that to the user and leave the setting unchanged.
 *
 * Refuses when the file on disk can't be read: loading it gave an empty
 * config, so saving would replace everything the user wrote with that.
 */
export function savePersistedConfig(config: PersistedConfig): string | undefined {
	const problem = read().problem;
	if (problem) {
		return `pi-ollama.json couldn't be read (${problem}), so it was left as it is. Fix or delete ${configPath()} and try again.`;
	}
	try {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify(config, null, 2));
		return undefined;
	} catch (e) {
		return `Couldn't write ${configPath()} (${e instanceof Error ? e.message : String(e)}).`;
	}
}
