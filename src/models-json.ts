// Reads thinking-level overrides from pi's global models.json.
//
// pi's models.json lives at <agent dir>/models.json and supports comments.
// This module handles the I/O and parsing, mirroring the pattern in paths.ts
// and config.ts: resolve the agent dir, read the file, strip comments, parse.

import { agentDir } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbg } from "./debug.js";

/** Per-model thinking-level override from models.json. */
export interface OllamaModelThinkingOverride {
	thinkingLevelMap?: Record<string, string | null>;
}

/** Map of model id → override. */
export type OllamaModelsJsonOverrides = Record<string, OllamaModelThinkingOverride>;

interface ModelsJsonRoot {
	providers?: Record<string, { modelOverrides?: OllamaModelsJsonOverrides }>;
}

/**
 * Best-effort read of the ollama provider's modelOverrides from models.json.
 * Tolerates a missing file and any malformed JSON — discovery still works,
 * overrides just don't apply. No caching: files are tiny and refreshes rare.
 */
export function loadModelsJsonOverrides(): OllamaModelsJsonOverrides {
	try {
		const path = join(agentDir(), "models.json");
		if (!existsSync(path)) return {};
		let raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
		// models.json supports comments (block and line); strip them before parsing
		raw = raw
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/,(?=\s*[}\]])/g, "");
		const json = JSON.parse(raw) as ModelsJsonRoot;
		const overrides = json.providers?.ollama?.modelOverrides;
		return overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
	} catch (e) {
		dbg("models-json-override", { error: String(e) });
		return {};
	}
}
