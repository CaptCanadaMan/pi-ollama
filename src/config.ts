// Persistent extension configuration storage.
//
// Stores user choices that should survive across pi launches. Currently just
// the slash-command-set context length override; structure leaves room for
// additional persisted state without breaking forward-compat.
//
// Location: ~/.pi/agent/cache/pi-ollama-config.json
//   - Same directory as the model discovery cache and default debug log.
//   - JSON object; tolerant to missing/extra fields.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"cache",
	"pi-ollama-config.json",
);

/**
 * Which host the key in OLLAMA_API_KEY was approved for. Only a fingerprint
 * of the key is stored, never the key itself.
 */
export interface ApiKeyApproval {
	host: string;
	fingerprint: string;
}

export interface PersistedConfig {
	/** User-set context length override (set via /ollama-context). */
	contextLength?: number;
	/** User-set keep_alive override (set via /ollama-keep-alive). Absent = defer to the server. */
	keepAlive?: string | number;
	/** The host OLLAMA_API_KEY was approved for (see ApiKeyApproval). */
	apiKeyApproval?: ApiKeyApproval;
	/** Saved answer to "start Ollama?" at startup. Absent = ask. */
	autostart?: "always" | "never";
	/** Warm-up on/off set via /ollama-warm-up. Absent = OLLAMA_NATIVE_WARM, else on. */
	warm?: boolean;
}

export function loadPersistedConfig(): PersistedConfig {
	try {
		if (!existsSync(CONFIG_PATH)) return {};
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed as PersistedConfig;
	} catch {
		return {};
	}
}

export function savePersistedConfig(config: PersistedConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
	} catch (e) {
		// Best-effort — surface to stderr so the user knows persistence failed,
		// but don't block the slash command's in-memory effect.
		process.stderr.write(
			`[pi-ollama] Failed to persist config (${String(e)}). ` +
				`Changes will apply this session but not survive restart.\n`,
		);
	}
}
