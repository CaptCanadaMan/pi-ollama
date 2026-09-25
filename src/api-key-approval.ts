// Asking before OLLAMA_API_KEY is sent to a server.
//
// The key is only ever sent to the host it was approved for (see
// settings.resolveApiKey). When the key is set but not approved for the
// configured host - first use, a new OLLAMA_HOST, or a new key - pi asks once
// at startup. The approval stores the host and a fingerprint of the key,
// never the key itself.

import { loadPersistedConfig, savePersistedConfig } from "./config.js";
import type { DiscoveredModel } from "./discovery.js";
import { errorText } from "./errors.js";
import type { SessionStartPi } from "./session-start.js";
import { keyFingerprint, type OllamaExtensionSettings } from "./settings.js";

const APPROVE = "Yes, send it to this server";
const DECLINE = "No, not this session";

export function registerApiKeyApproval(
	pi: SessionStartPi,
	settings: OllamaExtensionSettings,
	refresh: () => Promise<DiscoveredModel[]>,
	envKey: string | undefined,
): void {
	pi.on?.("session_start", async (event, ctx) => {
		const key = envKey?.trim();
		const shouldAsk =
			key && settings.apiKeyStatus === "unapproved" && ctx.hasUI && event.reason === "startup";
		if (!shouldAsk) return;

		const answer = await ctx.ui.select(
			`OLLAMA_API_KEY is set. Send it to ${settings.baseUrl}?`,
			[APPROVE, DECLINE],
		);
		if (answer !== APPROVE) return;

		const config = loadPersistedConfig();
		config.apiKeyApproval = { host: settings.baseUrl, fingerprint: keyFingerprint(key) };
		savePersistedConfig(config);

		settings.apiKey = key;
		settings.apiKeyStatus = "approved";
		try {
			await refresh();
		} catch (e) {
			ctx.ui.notify(`Approved the key, but re-discovering models failed: ${errorText(e)}`, "error");
		}
	});
}
