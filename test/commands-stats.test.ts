import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands.js";
import { GENERATION_ENTRY_TYPE } from "../src/stats.js";

type Handler = (args: string, ctx: unknown) => void | Promise<void>;

function registered(throughput: boolean) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, config: { handler: Handler }) =>
			handlers.set(name, config.handler),
	};
	const settings = {
		baseUrl: "http://ollama.test",
		numCtx: 32768,
		ghostRetries: 2,
		throughput,
	};
	registerCommands(pi, settings, () => [], async () => [], () => undefined);
	return handlers;
}

const storedEntry = {
	type: "custom",
	customType: GENERATION_ENTRY_TYPE,
	data: {
		model: "gemma4:12b",
		timestamp: 1,
		outputTokens: 612,
		evalDurationNs: 12_938_689_217,
		tokensPerSecond: 47.3,
	},
};

describe("/ollama-stats", () => {
	it("summarizes the session's recorded generations", async () => {
		const notify = vi.fn();
		const ctx = {
			ui: { notify },
			sessionManager: { getEntries: () => [storedEntry] },
		};

		await registered(true).get("ollama-stats")?.("", ctx);

		expect(notify).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0];
		expect(level).toBe("info");
		expect(text).toContain("Model: gemma4:12b");
		expect(text).toContain("Last: 47.3 tok/s");
	});

	it("says how to turn telemetry back on when it is switched off", async () => {
		const notify = vi.fn();
		const ctx = { ui: { notify }, sessionManager: { getEntries: () => [] } };

		await registered(false).get("ollama-stats")?.("", ctx);

		expect(notify.mock.calls[0][0]).toContain("OLLAMA_NATIVE_THROUGHPUT");
	});
});
