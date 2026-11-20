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
 contextWindow, contextWindowKnown: true, maxTokens: 8192,
});
// What discovery produces when /api/show fails or reports no context length:
// a 32768 placeholder, not something the model said about itself.
const guessed = (): DiscoveredModel => ({
 id: "test", name: "test", tools: false, vision: false, reasoning: false,
 contextWindow: 32768, maxTokens: 8192,
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
 it("does not cap an explicit preference at a guessed maximum", () => {
  expect(toProviderModel(guessed(), settings).contextWindow).toBe(262144);
  expect(toProviderModel(guessed(), {...settings, contextLength: 16384}).contextWindow).toBe(16384);
 });
 it("uses the default cap when the maximum is a guess and nothing is set", () => {
  expect(toProviderModel(guessed(), {...settings, contextLength: undefined}).contextWindow).toBe(32768);
 });
 it("treats a cached model without the marker as guessed", () => {
  const fromOldCache = JSON.parse(JSON.stringify(guessed())) as DiscoveredModel;
  expect(toProviderModel(fromOldCache, settings).contextWindow).toBe(262144);
 });
 it("registers a model pinned to a named server with that server's address", () => {
  const pinned = {...model(32768), baseUrl: "http://10.0.0.5:11434"};
  expect(toProviderModel(pinned, settings).baseUrl).toBe("http://10.0.0.5:11434");
  expect(toProviderModel(model(32768), settings).baseUrl).toBe("http://localhost:11434");
 });
});
