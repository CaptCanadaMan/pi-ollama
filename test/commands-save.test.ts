import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { OllamaExtensionSettings } from "../src/settings.js";

// The slash commands that save a setting, against a real config file in a
// throwaway pi agent directory. The file can hold hand-written per-model
// settings (GH-14), so a command must keep them, and must not touch a file
// it couldn't read.

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

let agentDir: string;
const configFile = () => join(agentDir, "cache", "pi-ollama-config.json");
const writeRaw = (text: string) => {
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	writeFileSync(configFile(), text);
};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-commands-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

/** Run one command, picking `choice` in its menu; resolve with what it told the user. */
async function run(name: string, choice: string, settings: OllamaExtensionSettings) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (n: string, config: { handler: Handler }) => handlers.set(n, config.handler),
	};
	const reregister = vi.fn();
	registerCommands(pi, settings, () => [], async () => [], reregister);
	const notify = vi.fn();
	await handlers.get(name)?.("", { ui: { notify, select: async () => choice } });
	const [text, level] = notify.mock.calls[0] as [string, string];
	return { text, level, reregister };
}

const freshSettings = (): OllamaExtensionSettings => ({
	baseUrl: "http://ollama.test",
	numCtx: 32768,
	ghostRetries: 2,
	throughput: true,
	warm: true,
	apiKeyStatus: "none",
});

describe("/ollama-context", () => {
	it("changes nothing when the config file can't be read", async () => {
		const broken = "{ not json";
		writeRaw(broken);
		const settings = freshSettings();

		const { text, level, reregister } = await run("ollama-context", "65,536 tokens", settings);

		expect(level).toBe("error");
		expect(text).toMatch(/^Not changed: /);
		expect(settings.contextLength).toBeUndefined();
		expect(reregister).not.toHaveBeenCalled();
		expect(readFileSync(configFile(), "utf-8")).toBe(broken);
	});
});
