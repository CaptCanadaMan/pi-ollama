import { describe, expect, it } from "vitest";
import { inferCapabilities } from "../src/capabilities.js";

describe("inferCapabilities - thinking values from /api/show (gh#13)", () => {
	it("carries the model's thinking values through", () => {
		const caps = inferCapabilities("muse-glimmer:30b", {
			capabilities: ["completion", "tools", "thinking"],
			thinking: { values: [false, "low", "medium", "high", "max"], default: "high" },
		});
		expect(caps.reasoning).toBe(true);
		expect(caps.thinking).toEqual({
			values: [false, "low", "medium", "high", "max"],
			default: "high",
		});
	});

	it("treats reported thinking values as reasoning support", () => {
		const caps = inferCapabilities("some-model:7b", {
			capabilities: ["completion"],
			thinking: { values: [false, true] },
		});
		expect(caps.reasoning).toBe(true);
	});

	it("leaves thinking undefined on older Ollama (no field)", () => {
		const caps = inferCapabilities("gemma4:26b", { capabilities: ["thinking"] });
		expect(caps.reasoning).toBe(true);
		expect(caps.thinking).toBeUndefined();
	});
});

describe("inferCapabilities - Ollama's capabilities array wins over name guesses", () => {
	// A name that matches a reasoning pattern used to get `think` sent even
	// when Ollama said the model can't think, and Ollama rejects that request.
	it("does not call a model reasoning just because of its name", () => {
		expect(
			inferCapabilities("deepseek-coder:6.7b", { capabilities: ["completion", "tools"] })
				.reasoning,
		).toBe(false);
		expect(
			inferCapabilities("qwen3-think:8b", { capabilities: ["completion"] }).reasoning,
		).toBe(false);
	});

	it("takes vision and tools from the array, not the family", () => {
		const caps = inferCapabilities("llava-ish:7b", {
			capabilities: ["completion"],
			details: { family: "llama", families: ["llama", "clip"] },
		});
		expect(caps.vision).toBe(false);
		expect(caps.tools).toBe(false);

		const listed = inferCapabilities("gemma4:12b", {
			capabilities: ["completion", "vision", "tools", "thinking"],
		});
		expect(listed).toMatchObject({ vision: true, tools: true, reasoning: true });
	});

	it("falls back to name and family guesses when Ollama reports no array", () => {
		const caps = inferCapabilities("deepseek-r1:8b", {
			details: { family: "qwen", families: ["qwen", "clip"] },
		});
		expect(caps).toMatchObject({ reasoning: true, tools: true, vision: true });
		expect(inferCapabilities("plain:7b", {})).toMatchObject({
			reasoning: false,
			tools: false,
			vision: false,
		});
	});
});
