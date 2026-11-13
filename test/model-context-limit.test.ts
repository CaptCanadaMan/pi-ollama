import { describe, expect, it } from "vitest";
import { toProviderModel } from "../src/index.js";
import type { DiscoveredModel } from "../src/discovery.js";
import type { OllamaExtensionSettings } from "../src/settings.js";

const settings: OllamaExtensionSettings = {
 baseUrl: "http://localhost:11434", numCtx: 32768, ghostRetries: 2,
 throughput: true, warm: false, apiKeyStatus: "none", contextLength: 262144,
};
const model = (contextWindow: number): DiscoveredModel => ({
 id: "test", name: "test", tools: true, vision: false, reasoning: false,
 contextWindow, maxTokens: 8192,
});

describe("per-model context maximum", () => {
 it("caps GLM without changing the saved preference for other models", () => {
  expect(toProviderModel(model(202752), settings).contextWindow).toBe(202752);
  expect(settings.contextLength).toBe(262144);
  expect(toProviderModel(model(1048576), settings).contextWindow).toBe(262144);
 });
 it("honors smaller explicit overrides", () => {
  expect(toProviderModel(model(202752), {...settings, contextLength: 24576}).contextWindow).toBe(24576);
 });
 it("keeps the default cap bounded by the model maximum", () => {
  const defaults = {...settings, contextLength: undefined};
  expect(toProviderModel(model(202752), defaults).contextWindow).toBe(32768);
  expect(toProviderModel(model(8192), defaults).contextWindow).toBe(8192);
 });
});
