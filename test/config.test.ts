import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadPersistedConfig,
	persistedConfigProblem,
	savePersistedConfig,
} from "../src/config.js";

// The config file on a real disk, in a throwaway pi agent directory. It is
// hand-edited (per-model settings, GH-14), so the thing to protect is the
// user's own text: a slash command must never replace a file it couldn't read.

let agentDir: string;
const configFile = () => join(agentDir, "cache", "pi-ollama-config.json");
const writeRaw = (text: string) => {
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	writeFileSync(configFile(), text);
};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-config-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("the persisted config file", () => {
	it("lives in the cache folder of pi's agent directory, wherever that is", () => {
		expect(savePersistedConfig({ warm: false })).toBeUndefined();

		expect(JSON.parse(readFileSync(configFile(), "utf-8"))).toEqual({ warm: false });
		expect(loadPersistedConfig()).toEqual({ warm: false });
	});

	it("is empty, with nothing to report, before anything was saved", () => {
		expect(loadPersistedConfig()).toEqual({});
		expect(persistedConfigProblem()).toBeUndefined();
		expect(existsSync(configFile())).toBe(false);
	});

	it("keeps hand-written per-model settings when a slash command saves", () => {
		writeRaw('{ "models": { "gemma4:12b": { "keepAlive": -1 } } }');

		const config = loadPersistedConfig();
		config.contextLength = 65536;
		savePersistedConfig(config);

		expect(loadPersistedConfig()).toEqual({
			contextLength: 65536,
			models: { "gemma4:12b": { keepAlive: -1 } },
		});
	});
});

describe("a config file that can't be read", () => {
	const broken = '{ "models": { "gemma4:12b": { "keepAlive": -1 }, } }';

	it("loads as empty and says what is wrong with it", () => {
		writeRaw(broken);

		expect(loadPersistedConfig()).toEqual({});
		expect(persistedConfigProblem()).toMatch(/JSON/);
	});

	it("is never saved over: the user's text stays exactly as they left it", () => {
		writeRaw(broken);

		const config = loadPersistedConfig();
		config.warm = false;
		const refused = savePersistedConfig(config);

		expect(refused).toMatch(/pi-ollama-config\.json couldn't be read/);
		expect(readFileSync(configFile(), "utf-8")).toBe(broken);
	});

	it("counts a file that isn't a JSON object as unreadable too", () => {
		writeRaw('["gemma4:12b"]');

		expect(loadPersistedConfig()).toEqual({});
		expect(persistedConfigProblem()).toBe("the file must contain a JSON object");
		expect(savePersistedConfig({ warm: true })).toBeDefined();
		expect(readFileSync(configFile(), "utf-8")).toBe('["gemma4:12b"]');
	});

	it("can be saved again once it is fixed", () => {
		writeRaw(broken);
		writeRaw('{ "warm": true }');

		expect(savePersistedConfig({ warm: false })).toBeUndefined();
		expect(loadPersistedConfig()).toEqual({ warm: false });
	});
});
