import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedConfig } from "../src/config.js";

// The config module is mocked so approvals never touch the real ~/.pi file.
let saved: PersistedConfig | undefined;
const stored: PersistedConfig = { keepAlive: "1h" };
vi.mock("../src/config.js", () => ({
	loadPersistedConfig: () => ({ ...stored }),
	savePersistedConfig: (c: PersistedConfig) => {
		saved = c;
	},
}));

const { registerApiKeyApproval } = await import("../src/api-key-approval.js");
const { keyFingerprint } = await import("../src/settings.js");

type SessionStart = (event: { reason: string }, ctx: unknown) => Promise<void>;

const home = "http://ollama.home:11434";

function setup(answer: string | undefined, apiKeyStatus: "none" | "approved" | "unapproved") {
	let onStart: SessionStart | undefined;
	const pi = {
		on: (event: string, handler: SessionStart) => {
			if (event === "session_start") onStart = handler;
		},
	};
	const settings = {
		baseUrl: home,
		numCtx: 32768,
		ghostRetries: 2,
		throughput: true,
		apiKeyStatus,
		apiKey: undefined as string | undefined,
	};
	const refresh = vi.fn(async () => []);
	registerApiKeyApproval(pi, settings, refresh, "sk-home");
	const select = vi.fn(async () => answer);
	const notify = vi.fn();
	const start = (reason = "startup", hasUI = true) =>
		onStart?.({ reason }, { hasUI, ui: { select, notify } });
	return { settings, refresh, select, notify, start };
}

afterEach(() => {
	saved = undefined;
});

describe("approving OLLAMA_API_KEY for this host", () => {
	it("on yes, remembers the host and a fingerprint (never the key), then uses the key", async () => {
		const { settings, refresh, select, start } = setup("Yes, send it to this server", "unapproved");

		await start();

		expect(select).toHaveBeenCalledTimes(1);
		expect(saved).toEqual({
			keepAlive: "1h",
			apiKeyApproval: { host: home, fingerprint: keyFingerprint("sk-home") },
		});
		expect(JSON.stringify(saved)).not.toContain("sk-home");
		expect(settings.apiKey).toBe("sk-home");
		expect(settings.apiKeyStatus).toBe("approved");
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("on no, saves nothing and keeps the key back", async () => {
		const { settings, refresh, start } = setup("No, not this session", "unapproved");

		await start();

		expect(saved).toBeUndefined();
		expect(settings.apiKey).toBeUndefined();
		expect(settings.apiKeyStatus).toBe("unapproved");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("doesn't ask when the key is already approved for this host", async () => {
		const { select, start } = setup("Yes, send it to this server", "approved");

		await start();

		expect(select).not.toHaveBeenCalled();
	});

	it("never asks, and never sends the key, without a UI (rpc/print modes)", async () => {
		const { settings, select, start } = setup("Yes, send it to this server", "unapproved");

		await start("startup", false);

		expect(select).not.toHaveBeenCalled();
		expect(settings.apiKey).toBeUndefined();
	});

	it.each(["new", "resume", "fork", "reload"])(
		"asks only when pi starts, not on a %s session",
		async (reason) => {
			const { select, start } = setup("Yes, send it to this server", "unapproved");

			await start(reason);

			expect(select).not.toHaveBeenCalled();
		},
	);

	it("reports, rather than throws, when discovery with the approved key fails", async () => {
		const { refresh, notify, start } = setup("Yes, send it to this server", "unapproved");
		refresh.mockRejectedValueOnce(new Error("The key in OLLAMA_API_KEY was rejected"));

		await expect(start()).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("The key in OLLAMA_API_KEY was rejected"),
			"error",
		);
	});
});
