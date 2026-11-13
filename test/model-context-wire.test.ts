import { afterEach, describe, expect, it, vi } from "vitest";
import { toProviderModel } from "../src/index.js";
import type { DiscoveredModel } from "../src/discovery.js";
import type { OllamaExtensionSettings } from "../src/settings.js";
import type { OllamaRequest } from "../src/wire.js";
import { doneChunk, ndjsonResponse, runStream, textChunk } from "./fixtures.js";

const defaults: OllamaExtensionSettings = {
 baseUrl: "http://ollama.test", numCtx: 32768, ghostRetries: 0,
 throughput: false, warm: false, apiKeyStatus: "none",
};
const discovered = (id: string, contextWindow: number): DiscoveredModel => ({
 id, name: id, tools: true, vision: false, reasoning: false,
 contextWindow, maxTokens: 8192,
});

afterEach(() => vi.unstubAllGlobals());

function captureRequests() {
 const requests: OllamaRequest[] = [];
 vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
  expect(String(url)).toBe("http://ollama.test/api/chat");
  requests.push(JSON.parse(init.body as string));
  return ndjsonResponse([textChunk("ok"), doneChunk(1, 1e6)]);
 }));
 return requests;
}

async function send(id: string, maximum: number, settings: OllamaExtensionSettings) {
 const registered = toProviderModel(discovered(id, maximum), settings);
 const result = await runStream(
  {messages: [{role: "user", content: "hello", timestamp: 1}]},
  undefined,
  {model: {...registered, provider: "ollama"}, settings},
 );
 expect(result.type).toBe("done");
 return registered;
}

describe("model limits reach the native request", () => {
 it.each([
  [262144, 202752, 202752],
  [262144, 1048576, 262144],
  [131072, 202752, 131072],
  [202752, 202752, 202752],
  [undefined, 202752, 32768],
  [undefined, 8192, 8192],
 ])("preference %s, maximum %s sends %s", async (preference, maximum, expected) => {
  const requests = captureRequests();
  const settings = {...defaults, contextLength: preference};
  const registered = await send("test", maximum, settings);
  expect(requests).toHaveLength(1);
  expect(requests[0].options?.num_ctx).toBe(expected);
  expect(registered.contextWindow).toBe(expected);
  expect(settings.contextLength).toBe(preference);
 });

 it("switches to a capped model and back without losing the preference", async () => {
  const requests = captureRequests();
  const settings = {...defaults, contextLength: 262144};
  await send("large", 1048576, settings);
  await send("glm", 202752, settings);
  await send("large", 1048576, settings);
  expect(requests.map(r => [r.model, r.options?.num_ctx])).toEqual([
   ["large", 262144], ["glm", 202752], ["large", 262144],
  ]);
 });
});
