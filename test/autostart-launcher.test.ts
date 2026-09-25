import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaLauncher, findOllamaBinary } from "../src/autostart.js";

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
