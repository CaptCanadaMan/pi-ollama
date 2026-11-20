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
const configFile = () => join(agentDir, "pi-ollama.json");
const writeRaw = (text: string) => {
	writeFileSync(configFile(), text);
};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ollama-cfg-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("the persisted config file", () => {
	it("lives in pi's agent directory, wherever that is - not in its cache folder", () => {
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

		expect(refused).toMatch(/pi-ollama\.json couldn't be read/);
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

describe("a config file from before it moved out of the cache folder", () => {
	const legacyFile = () => join(agentDir, "cache", "pi-ollama-config.json");
	const writeLegacy = (text: string) => {
		mkdirSync(join(agentDir, "cache"), { recursive: true });
		writeFileSync(legacyFile(), text);
	};

	it("is moved to the new place, as it is, the first time settings are read", () => {
		const text = '{\n  "keepAlive": -1,\n  "apiKeyApproval": { "host": "http://ollama.home:11434", "fingerprint": "abc" }\n}';
		writeLegacy(text);

		expect(loadPersistedConfig()).toEqual({
			keepAlive: -1,
			apiKeyApproval: { host: "http://ollama.home:11434", fingerprint: "abc" },
		});
		expect(readFileSync(configFile(), "utf-8")).toBe(text);
		expect(existsSync(legacyFile())).toBe(false);
	});

	it("is left alone when a file already exists in the new place, which wins", () => {
		writeLegacy('{ "warm": false }');
		writeRaw('{ "warm": true }');

		expect(loadPersistedConfig()).toEqual({ warm: true });
		expect(readFileSync(legacyFile(), "utf-8")).toBe('{ "warm": false }');
	});

	it("is saved to the new place from then on", () => {
		writeLegacy('{ "warm": false }');

		const config = loadPersistedConfig();
		config.contextLength = 65536;
		expect(savePersistedConfig(config)).toBeUndefined();

		expect(JSON.parse(readFileSync(configFile(), "utf-8"))).toEqual({ warm: false, contextLength: 65536 });
		expect(existsSync(legacyFile())).toBe(false);
	});

	it("still protects the user's text when the old file is one that can't be read", () => {
		const broken = '{ "warm": false, }';
		writeLegacy(broken);

		expect(loadPersistedConfig()).toEqual({});
		expect(persistedConfigProblem()).toMatch(/JSON/);
		expect(savePersistedConfig({ warm: true })).toMatch(/couldn't be read/);
		expect(readFileSync(configFile(), "utf-8")).toBe(broken);
	});
});
