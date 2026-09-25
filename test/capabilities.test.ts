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
