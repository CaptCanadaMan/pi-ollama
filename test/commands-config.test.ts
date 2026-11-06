import { afterEach, describe, expect, it, vi } from "vitest";

// Slash commands that write the config file. The config module is mocked so
// these never touch the real ~/.pi file.
const persisted: Record<string, unknown> = {};
let readError: string | undefined;
const saved: unknown[] = [];
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => structuredClone(persisted),
	savePersistedConfig: (c: Record<string, unknown>) => {
		saved.push(structuredClone(c));
		for (const k of Object.keys(persisted)) delete persisted[k];
		Object.assign(persisted, structuredClone(c));
	},
	persistedConfigError: () => readError,
}));

const { registerCommands } = await import("../src/commands.js");
const { loadSettings } = await import("../src/settings.js");

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

/** Run one command, answering its picker and input; resolve with every notification. */
async function run(name: string, answers: { select?: string; input?: string } = {}) {
	const settings = loadSettings();
	const handlers: Record<string, Handler> = {};
	registerCommands(
		{ registerCommand: (n, c) => (handlers[n] = c.handler as Handler) },
		settings,
		() => [],
		async () => [],
		() => undefined,
	);
	const notices: [string | undefined, string][] = [];
	await handlers[name]!("", {
		ui: {
			notify: (m: string, t?: string) => notices.push([t, m]),
			select: async (_title: string, options: string[]) => options.find((o) => o.startsWith(answers.select ?? "")),
			input: async () => answers.input,
		},
	});
	return { notices, settings };
}

afterEach(() => {
	for (const k of Object.keys(persisted)) delete persisted[k];
	saved.length = 0;
	readError = undefined;
});

describe("/ollama-context and /ollama-keep-alive - writing the config", () => {
	it("writes into defaults when the file has a defaults block, and applies it at once", async () => {
		persisted.defaults = { warm: true };

		const { settings } = await run("ollama-context", { select: "16,384" });

		expect(saved).toEqual([{ defaults: { warm: true, contextLength: 16384 } }]);
		expect(settings.modelConfig.defaults.contextLength).toBe(16384);
	});

	it("writes at the top level when there is no defaults block", async () => {
		await run("ollama-keep-alive", { select: "30m" });

		expect(saved).toEqual([{ keepAlive: "30m" }]);
	});

	it("refuses a custom context length the config would reject, and saves nothing", async () => {
		const { notices } = await run("ollama-context", { select: "Custom", input: "200" });

		expect(notices.at(-1)).toEqual(["error", "Invalid context length: must be at least 256."]);
		expect(saved).toEqual([]);
	});

	it("never saves over a config file that didn't parse", async () => {
		readError = "Unexpected end of JSON input";

		const { notices } = await run("ollama-keep-alive", { select: "30m" });

		expect(saved).toEqual([]);
		expect(notices.at(-1)?.[0]).toBe("error");
		expect(notices.at(-1)?.[1]).toMatch(/couldn't be read \(Unexpected end of JSON input\)/);
	});
});

describe("/ollama-refresh - config problems", () => {
	it("reports what's wrong with the config after refreshing", async () => {
		persisted.defaults = { sampling: { topP: 1.4 } };

		const { notices } = await run("ollama-refresh");

		expect(notices).toContainEqual([
			"error",
			"pi-ollama config: defaults.sampling.topP = 1.4 must be at most 1 - ignored",
		]);
	});
});
