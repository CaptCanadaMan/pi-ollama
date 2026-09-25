import { afterEach, describe, expect, it, vi } from "vitest";
import { doneChunk, model, ndjsonResponse, runStream, settings, textChunk } from "./fixtures.js";

// Where the chat request goes and what it carries. pi can give a model its own
// baseUrl and headers (models.json), and the caller can add headers and an
// abort signal per turn.

const user = { role: "user", content: "hi", timestamp: 1 };

function stubChat() {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
		ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOllama - the chat request", () => {
	it("goes to the model's own server when it has one, else the configured one", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] });
		await runStream({ messages: [user] }, undefined, {
			model: { ...model, baseUrl: "http://gpu-box:11434/" },
		});

		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
			`${settings.baseUrl}/api/chat`,
			"http://gpu-box:11434/api/chat",
		]);
	});

	it("carries the model's and the caller's headers, the caller's winning", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] }, undefined, {
			model: { ...model, headers: { "X-Team": "robot", "X-Trace": "model" } },
			options: { headers: { "X-Trace": "turn" } },
		});

		const headers = new Headers(fetchMock.mock.calls[0]![1].headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-team")).toBe("robot");
		expect(headers.get("x-trace")).toBe("turn");
	});

	it("carries the approved API key as a bearer token", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] }, undefined, { settings: { apiKey: "sk-home" } });

		const headers = new Headers(fetchMock.mock.calls[0]![1].headers);
		expect(headers.get("authorization")).toBe("Bearer sk-home");
	});

	it("never sends the key to a model that points at a different server", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] }, undefined, {
			model: { ...model, baseUrl: "http://elsewhere:11434" },
			settings: { apiKey: "sk-home" },
		});

		expect(new Headers(fetchMock.mock.calls[0]![1].headers).has("authorization")).toBe(false);
	});

	it("a rejected key ends the turn with a message saying so, without the key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"error":"invalid token"}', { status: 401 })),
		);

		const end = await runStream({ messages: [user] }, undefined, {
			settings: { apiKey: "sk-home" },
		});

		expect(end.error?.errorMessage).toMatch(/key in OLLAMA_API_KEY was rejected/);
		expect(end.error?.errorMessage).not.toContain("sk-home");
	});

	it("sends no Authorization header when there's no approved key", async () => {
		const fetchMock = stubChat();

		await runStream({ messages: [user] });

		expect(new Headers(fetchMock.mock.calls[0]![1].headers).has("authorization")).toBe(false);
	});

	it("is cancelled when the turn is aborted, and the turn ends as aborted", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					}),
			),
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const end = await runStream({ messages: [user] }, undefined, {
			options: { signal: controller.signal },
		});

		expect(end.type).toBe("error");
		expect(end.error?.stopReason).toBe("aborted");
	});
});
