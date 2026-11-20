import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";

// loadSettings reads the environment and the persisted config. The config
// module is mocked so these never touch the real ~/.pi file.
const persisted: PersistedConfig = {};
let fileProblem: string | undefined;
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => persisted,
	persistedConfigProblem: () => fileProblem,
	savePersistedConfig: () => undefined,
}));

const { keyFingerprint, loadSettings } = await import("../src/settings.js");

afterEach(() => {
	vi.unstubAllEnvs();
	fileProblem = undefined;
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

describe("loadSettings - per-model settings from the config file", () => {
	it("loads the models block and reports what it had to drop", () => {
		persisted.models = { "gemma4:12b": { keepAlive: -1, warm: "yes" } };

		const settings = loadSettings();

		expect(settings.modelConfig?.models["gemma4:12b"]).toEqual({ keepAlive: -1 });
		expect(settings.configIssues?.map((i) => i.path)).toEqual(['models["gemma4:12b"].warm']);
	});

	it("reports a config file that couldn't be read at all", () => {
		fileProblem = "Unexpected token } in JSON at position 52";

		expect(loadSettings().configIssues).toEqual([
			{
				severity: "error",
				path: "pi-ollama.json",
				message:
					"couldn't be read (Unexpected token } in JSON at position 52) - using defaults until it is fixed",
			},
		]);
	});

	it("has nothing to report for a file without one", () => {
		expect(loadSettings().configIssues).toEqual([]);
	});
});

describe("loadSettings - the warm-up switch", () => {
	it("warms by default and switches off with OLLAMA_NATIVE_WARM=0", () => {
		expect(loadSettings().warm).toBe(true);
		vi.stubEnv("OLLAMA_NATIVE_WARM", "0");
		expect(loadSettings().warm).toBe(false);
	});

	it("a choice saved by /ollama-preload wins over OLLAMA_NATIVE_WARM", () => {
		vi.stubEnv("OLLAMA_NATIVE_WARM", "0");
		persisted.warm = true;
		expect(loadSettings().warm).toBe(true);

		vi.unstubAllEnvs();
		persisted.warm = false;
		expect(loadSettings().warm).toBe(false);
	});
});

describe("loadSettings - which Ollama server", () => {
	it("is the local one when nothing is set", () => {
		const settings = loadSettings();

		expect(settings.baseUrl).toBe("http://localhost:11434");
		expect(settings.hostSource).toBe("default");
		expect(settings.configIssues).toEqual([]);
	});

	it("uses the host saved in the config file", () => {
		persisted.host = "ollama.home";

		const settings = loadSettings();

		expect(settings.baseUrl).toBe("http://ollama.home:11434");
		expect(settings.hostSource).toBe("config");
	});

	it("lets OLLAMA_HOST override the saved host", () => {
		vi.stubEnv("OLLAMA_HOST", "jetson.tailnet:11434");
		persisted.host = "ollama.home";

		const settings = loadSettings();

		expect(settings.baseUrl).toBe("http://jetson.tailnet:11434");
		expect(settings.hostSource).toBe("env");
	});

	it("treats an empty OLLAMA_HOST as not set", () => {
		vi.stubEnv("OLLAMA_HOST", "  ");
		persisted.host = "https://ollama.home/proxy/";

		expect(loadSettings().baseUrl).toBe("https://ollama.home/proxy");
	});

	it("refuses a saved host that could leak a secret or misroute requests, and stays local", () => {
		persisted.host = "https://andrew:secret@ollama.home";

		const settings = loadSettings();

		expect(settings.baseUrl).toBe("http://localhost:11434");
		expect(settings.hostSource).toBe("default");
		expect(settings.configIssues).toEqual([
			{
				severity: "error",
				path: "host",
				message: "must not contain a username or password - using localhost:11434",
			},
		]);
	});

	it("an OLLAMA_HOST override means a bad saved host is never read", () => {
		vi.stubEnv("OLLAMA_HOST", "jetson.tailnet:11434");
		persisted.host = 42 as unknown as string;

		expect(loadSettings().configIssues).toEqual([]);
	});

	it("holds an API key back from a saved host it wasn't approved for", () => {
		vi.stubEnv("OLLAMA_API_KEY", "sk-home");
		persisted.host = "ollama.home";
		persisted.apiKeyApproval = {
			host: "http://localhost:11434",
			fingerprint: keyFingerprint("sk-home"),
		};

		const settings = loadSettings();

		expect(settings.apiKey).toBeUndefined();
		expect(settings.apiKeyStatus).toBe("unapproved");
	});
});

