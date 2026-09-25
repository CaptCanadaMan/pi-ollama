import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";

// loadSettings reads the environment and the persisted config. The config
// module is mocked so these never touch the real ~/.pi file.
const persisted: PersistedConfig = {};
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => persisted,
	savePersistedConfig: () => undefined,
}));

const { keyFingerprint, loadSettings } = await import("../src/settings.js");

afterEach(() => {
	vi.unstubAllEnvs();
	for (const k of Object.keys(persisted)) delete persisted[k as keyof PersistedConfig];
});

describe("loadSettings - the API key at startup", () => {
	it("uses OLLAMA_API_KEY when it's approved for OLLAMA_HOST", () => {
		vi.stubEnv("OLLAMA_HOST", "ollama.home:11434");
		vi.stubEnv("OLLAMA_API_KEY", "sk-home");
		persisted.apiKeyApproval = {
			host: "http://ollama.home:11434",
			fingerprint: keyFingerprint("sk-home"),
		};

		const settings = loadSettings();

		expect(settings.apiKey).toBe("sk-home");
		expect(settings.apiKeyStatus).toBe("approved");
	});

	it("holds the key back when OLLAMA_HOST now points somewhere new", () => {
		vi.stubEnv("OLLAMA_HOST", "jetson.tailnet:11434");
		vi.stubEnv("OLLAMA_API_KEY", "sk-home");
		persisted.apiKeyApproval = {
			host: "http://ollama.home:11434",
			fingerprint: keyFingerprint("sk-home"),
		};

		const settings = loadSettings();

		expect(settings.apiKey).toBeUndefined();
		expect(settings.apiKeyStatus).toBe("unapproved");
	});
});
