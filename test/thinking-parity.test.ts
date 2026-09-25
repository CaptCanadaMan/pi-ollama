import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	clampLevel,
	type OllamaThinking,
	supportedLevels,
	toThinkingLevelMap,
} from "../src/thinking.js";

// thinking.ts reimplements pi-ai's level filtering and clamping instead of
// importing it, so the extension doesn't depend on the host's pi-ai version.
// These check it against the real helpers from the pi-ai devDependency: a
// devDep bump fails here if pi changes how a thinkingLevelMap is read - which
// would also mean the picker and the wire disagree.

const shapes: Record<string, OllamaThinking | undefined> = {
	legacy: undefined,
	"on/off only": { values: [false, true] },
	"named with off": { values: [false, "low", "medium", "xhigh"] },
	"named with max": { values: [false, "low", "medium", "high", "max"] },
	"mixed true + named": { values: [false, true, "medium"] },
	"no off": { values: ["low", "medium", "high"] },
	"only unknown": { values: [false, "ultra"] },
};

const requests = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "bogus"];

describe("thinking levels - parity with pi-ai", () => {
	for (const [name, thinking] of Object.entries(shapes)) {
		const map = toThinkingLevelMap(thinking);
		for (const reasoning of [true, false]) {
			// biome-ignore lint/suspicious/noExplicitAny: only the fields pi-ai reads
			const model = { reasoning, thinkingLevelMap: map } as any;

			it(`${name} (reasoning: ${reasoning}) - supported levels`, () => {
				expect(supportedLevels(reasoning, map)).toEqual(
					getSupportedThinkingLevels(model),
				);
			});

			it(`${name} (reasoning: ${reasoning}) - clamping`, () => {
				for (const level of requests) {
					expect(clampLevel(reasoning, map, level)).toBe(
						clampThinkingLevel(model, level as never),
					);
				}
			});
		}
	}
});
