import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaLauncher, findOllamaBinary, type LauncherSystem } from "../src/autostart.js";

const target = { baseUrl: "http://localhost:11434" };
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("waiting for a launched server", () => {
	it("keeps checking until the server answers", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(url).toBe("http://localhost:11434/api/version");
				if (++calls < 3) throw refused();
				return Response.json({ version: "0.34.4" });
			}),
		);
		const launcher = createOllamaLauncher(target, { pollMs: 5, timeoutMs: 1000 });

		await expect(launcher.waitUntilUp()).resolves.toBe(true);
		expect(calls).toBe(3);
	});

	it("gives up once the wait runs out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw refused();
			}),
		);
		const launcher = createOllamaLauncher(target, { pollMs: 5, timeoutMs: 40 });

		await expect(launcher.waitUntilUp()).resolves.toBe(false);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("findOllamaBinary", () => {
	it("takes the first ollama on PATH", () => {
		const executables = new Set(["/opt/tools/ollama", "/usr/local/bin/ollama"]);

		const found = findOllamaBinary("/usr/bin:/opt/tools:/usr/local/bin", (p) => executables.has(p));

		expect(found).toBe("/opt/tools/ollama");
	});

	it.each(["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"])(
		"falls back to the usual install location when PATH is minimal (%s)",
		(installed) => {
			expect(findOllamaBinary("/bin", (p) => p === installed)).toBe(installed);
		},
	);

	it("finds nothing when ollama isn't installed", () => {
		expect(findOllamaBinary("/usr/bin:/bin", () => false)).toBeUndefined();
	});
});

/** A fake machine: which paths exist, where symlinks point, and what got run. */
function fakeSystem(overrides: Partial<LauncherSystem> = {}) {
	const runs: Array<{ command: string; args: string[] }> = [];
	const system: LauncherSystem = {
		platform: "darwin",
		pathEnv: "/usr/local/bin:/usr/bin",
		isExecutable: (p) => p === "/usr/local/bin/ollama",
		realpath: (p) =>
			p === "/usr/local/bin/ollama" ? "/Applications/Ollama.app/Contents/Resources/ollama" : p,
		exists: () => false,
		run: (command, args) => {
			runs.push({ command, args });
			return { pid: 4242 };
		},
		...overrides,
	};
	return { system, runs };
}

describe("starting Ollama on macOS", () => {
	it("opens the Ollama app hidden, menu-bar only, the way Ollama's own CLI does", () => {
		const { system, runs } = fakeSystem();
		const launcher = createOllamaLauncher(target, { system });

		const app = launcher.locate();
		const { stopHint } = launcher.launch(app!);

		expect(app).toBe("/Applications/Ollama.app");
		expect(runs).toEqual([
			{
				command: "/usr/bin/open",
				args: ["-j", "-a", "/Applications/Ollama.app", "--args", "--fast-startup"],
			},
		]);
		expect(stopHint).toMatch(/menu bar/i);
	});

	it("falls back to /Applications/Ollama.app when the CLI isn't the app's", () => {
		const { system } = fakeSystem({
			realpath: (p) => p, // e.g. a Homebrew ollama, not a link into the app
			exists: (p) => p === "/Applications/Ollama.app",
		});

		expect(createOllamaLauncher(target, { system }).locate()).toBe("/Applications/Ollama.app");
	});

	it("has nothing to offer when the Ollama app isn't installed", () => {
		const { system } = fakeSystem({ realpath: (p) => p, exists: () => false });

		expect(createOllamaLauncher(target, { system }).locate()).toBeUndefined();
	});
});

describe("starting Ollama on Linux", () => {
	it("runs a background ollama serve and says how to stop it by PID", () => {
		const { system, runs } = fakeSystem({ platform: "linux", realpath: (p) => p });
		const launcher = createOllamaLauncher(target, { system });

		const cli = launcher.locate();
		const { stopHint } = launcher.launch(cli!);

		expect(cli).toBe("/usr/local/bin/ollama");
		expect(runs).toEqual([{ command: "/usr/local/bin/ollama", args: ["serve"] }]);
		expect(stopHint).toBe("Stop it with: kill 4242");
		expect(launcher.manualHint).toContain("sudo systemctl start ollama");
	});
});

describe("starting Ollama elsewhere", () => {
	it("has nothing to offer on other platforms", () => {
		const { system } = fakeSystem({ platform: "win32" });

		expect(createOllamaLauncher(target, { system }).locate()).toBeUndefined();
	});
});
