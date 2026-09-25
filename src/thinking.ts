// Per-model thinking levels (gh#13).
//
// Ollama >= 0.34 reports the `think` values each model accepts in /api/show:
//   "thinking": { "values": [false, "low", "medium", "xhigh"], "default": "medium" }
// A value is one whole choice for the request - `think: "medium"` already
// means "on, at medium effort", it isn't a setting layered under `true`.
//
// pi's Model.thinkingLevelMap is the matching mechanism on pi's side: a string
// is the provider-native value for that level, a missing key means "provider
// default", null means unsupported. pi's picker only shows supported levels
// (xhigh and max only when mapped explicitly) and clamps a saved level into
// that set on model switch. So the model's own list becomes the map, and pi
// does the rest.
//
// pi's level names are a fixed vocabulary. An Ollama value that matches one
// passes straight through. Anything else can't be offered without inventing
// a label, so it is reported as unexposed instead (/ollama-info shows it).

export type PiThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export interface OllamaThinking {
	values: (boolean | string)[];
	default?: boolean | string;
}

export interface ThinkingDescription {
	map: ThinkingLevelMap;
	/** pi levels the model gets, in pi's order. */
	levels: PiThinkingLevel[];
	/** Values the model accepts that no pi level can carry. */
	unexposed: (boolean | string)[];
}

// Same order as pi-ai's EXTENDED_THINKING_LEVELS - clamping walks it.
const PI_LEVELS: readonly PiThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const EFFORT_LEVELS = PI_LEVELS.slice(1);

function isEffortLevel(v: unknown): v is PiThinkingLevel {
	return typeof v === "string" && v !== "off" && PI_LEVELS.includes(v as PiThinkingLevel);
}

/** Validate /api/show's `thinking` field. Undefined when absent or unusable. */
export function parseThinking(raw: unknown): OllamaThinking | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { values, default: dflt } = raw as { values?: unknown; default?: unknown };
	if (!Array.isArray(values)) return undefined;
	const kept = values.filter(
		(v): v is boolean | string => typeof v === "boolean" || typeof v === "string",
	);
	if (kept.length === 0) return undefined;
	const thinking: OllamaThinking = { values: kept };
	if (typeof dflt === "boolean" || typeof dflt === "string") thinking.default = dflt;
	return thinking;
}

/**
 * Build pi's thinkingLevelMap from the model's reported values. Undefined
 * when the model reports none (older Ollama) - the legacy on/off mapping
 * applies then.
 */
export function toThinkingLevelMap(
	thinking: OllamaThinking | undefined,
): ThinkingLevelMap | undefined {
	if (!thinking) return undefined;
	const { values } = thinking;
	const map: ThinkingLevelMap = {};
	if (!values.includes(false)) map.off = null;

	const named = values.filter(isEffortLevel);
	for (const level of EFFORT_LEVELS) {
		if (named.length > 0) {
			map[level] = named.includes(level) ? level : null;
		} else if (level !== "medium" || !values.includes(true)) {
			map[level] = null;
		}
		// An on/off-only model keeps medium (pi's default level) unmapped:
		// the provider default for it is think:true.
	}
	return map;
}

/** The map plus what the model gets and what it loses, for display. */
export function describeThinking(
	thinking: OllamaThinking | undefined,
): ThinkingDescription | undefined {
	const map = toThinkingLevelMap(thinking);
	if (!thinking || !map) return undefined;
	const hasNamed = thinking.values.some(isEffortLevel);
	const unexposed = thinking.values.filter((v) => {
		if (v === false || isEffortLevel(v)) return false;
		if (v === true) return hasNamed; // covered by medium only when alone
		return true;
	});
	return { map, levels: supportedLevels(true, map), unexposed };
}

/** Human-readable summary for /ollama-info. */
export function thinkingSummary(thinking: OllamaThinking | undefined): string {
	const d = describeThinking(thinking);
	if (!d) return "pi thinking levels: on/off only (server reports no thinking values)";
	const lines = [`pi thinking levels: ${d.levels.join(", ")}`];
	if (d.unexposed.length > 0) {
		lines.push(
			`not exposed (no matching pi level): ${d.unexposed.map((v) => JSON.stringify(v)).join(", ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * Structural copy of pi-ai's getSupportedThinkingLevels, so the extension
 * doesn't depend on the host's pi-ai version. test/thinking-parity.test.ts
 * checks it against the real one.
 */
export function supportedLevels(
	reasoning: boolean,
	map: ThinkingLevelMap | undefined,
): PiThinkingLevel[] {
	if (!reasoning) return ["off"];
	return PI_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Structural copy of pi-ai's clampThinkingLevel (see supportedLevels). */
export function clampLevel(
	reasoning: boolean,
	map: ThinkingLevelMap | undefined,
	level: string,
): PiThinkingLevel {
	const available = supportedLevels(reasoning, map);
	if (available.includes(level as PiThinkingLevel)) return level as PiThinkingLevel;
	const requested = PI_LEVELS.indexOf(level as PiThinkingLevel);
	if (requested === -1) return available[0] ?? "off";
	for (let i = requested; i < PI_LEVELS.length; i++) {
		const candidate = PI_LEVELS[i] as PiThinkingLevel;
		if (available.includes(candidate)) return candidate;
	}
	for (let i = requested - 1; i >= 0; i--) {
		const candidate = PI_LEVELS[i] as PiThinkingLevel;
		if (available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

/**
 * Map pi's thinking level to Ollama's `think` value. pi encodes thinking-off
 * as the `reasoning` option being absent (its ThinkingLevel type has no "off"
 * member), while Ollama defaults thinking-capable models to thinking ON when
 * `think` is omitted - so off only works as an explicit `false` on the wire.
 * A literal "off" string is also treated as off, defensively - the option
 * crosses a runtime boundary from whatever pi version is hosting us.
 *
 * Without a map (no thinking field reported) every level sends `true`. With
 * one, the level is clamped the way pi clamps it and the model's own value is
 * sent. Undefined means "omit think": off was asked for but the model can't
 * switch thinking off, so its default is the honest outcome.
 */
export function resolveThink(
	reasoning: string | undefined,
	map?: ThinkingLevelMap,
): boolean | string | undefined {
	const off = reasoning === undefined || reasoning === "off";
	if (!map) return !off;
	if (off) return map.off === null ? undefined : false;

	const level = clampLevel(true, map, reasoning);
	if (level === "off") return map.off === null ? undefined : false;
	const mapped = map[level];
	if (typeof mapped === "string") return mapped;
	return mapped === null ? undefined : true;
}
