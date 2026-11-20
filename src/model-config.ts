// Per-model settings: one schema, one validator, one resolver (GH-14).
//
// They live under `models` in ~/.pi/agent/cache/pi-ollama-config.json
// (config.ts), keyed by exact model id. A model's own value wins over the
// global one (the file's top level, set by the slash commands, else the env
// var). Keys starting with "_" are comments and are ignored everywhere.
//
// The file is hand-edited, so nothing in it is trusted: an invalid value is
// dropped and reported, and the setting falls through to the global one.
//
// What is deliberately NOT here: per-model context window and output limit
// (pi's models.json `modelOverrides` already does both for extension models)
// and sampling / GPU options (an Ollama Modelfile sets those on the server).
//
// No runtime imports, so it can be tested on its own.

export type Severity = "error" | "warning";

export interface ConfigIssue {
	severity: Severity;
	/** Where in the file, e.g. models["gemma4:12b"].keepAlive */
	path: string;
	/** Reads after the path, e.g. `= "banana" must be ... - ignored`. */
	message: string;
}

export interface ModelSettings {
	keepAlive?: string | number;
	warm?: boolean;
	/**
	 * What happens to the model once the user leaves it (release.ts): 0 unloads
	 * it at once, a duration that long after, "keep" leaves it loaded.
	 */
	releaseAfter?: string | number;
}

export interface ModelConfigFile {
	/** Null-prototype map, so ids like "__proto__" are plain entries. */
	models: Record<string, ModelSettings>;
}

export function emptyModelConfig(): ModelConfigFile {
	return { models: Object.create(null) as Record<string, ModelSettings> };
}

// ── validators: return why a value is invalid, or undefined when it's fine ──

type Check = (v: unknown) => string | undefined;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const bool: Check = (v) => (typeof v === "boolean" ? undefined : "must be true or false");

// The same Go-style duration settings.ts accepts for keep_alive.
const GO_DURATION_RE = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

const keepAliveCheck: Check = (v) => {
	if (typeof v === "number" && Number.isInteger(v)) return undefined;
	if (typeof v === "string" && GO_DURATION_RE.test(v)) return undefined;
	return 'must be a duration like "30m" / "1h30m" or a whole number of seconds (-1 = keep loaded)';
};

/**
 * Why a releaseAfter value is invalid, or undefined when it's fine. "keep"
 * means leaving the model doesn't unload it; it has to be said explicitly
 * because unloading at once is the default. Shared with the global setting
 * (settings.ts, keep-alive-command.ts).
 */
export const releaseAfterCheck: Check = (v) => {
	if (v === "keep") return undefined;
	if (typeof v === "number" && Number.isInteger(v) && v >= 0) return undefined;
	if (typeof v === "string" && GO_DURATION_RE.test(v)) return undefined;
	return 'must be 0 (unload at once), a duration like "10m" / "1h30m", a whole number of seconds, or "keep" (don\'t unload it for leaving)';
};

const MODEL_FIELDS: Record<keyof ModelSettings, Check> = {
	keepAlive: keepAliveCheck,
	warm: bool,
	releaseAfter: releaseAfterCheck,
};

const USE_MODEL_OVERRIDES = (field: string) =>
	`is not set here - use modelOverrides in pi's models.json ("${field}") - ignored`;
const USE_MODELFILE = "is not set here - use PARAMETER lines in an Ollama Modelfile - ignored";

/** Settings people reasonably expect here, and where they live instead. */
const ELSEWHERE: Record<string, string> = {
	contextLength: USE_MODEL_OVERRIDES("contextWindow"),
	contextWindow: USE_MODEL_OVERRIDES("contextWindow"),
	maxTokens: USE_MODEL_OVERRIDES("maxTokens"),
	sampling: USE_MODELFILE,
	gpu: USE_MODELFILE,
};

// ── loading ──

const show = (v: unknown): string => JSON.stringify(v) ?? String(v);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function validateModel(raw: Record<string, unknown>, path: string, issues: ConfigIssue[]): ModelSettings {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key.startsWith("_")) continue;
		const keyPath = `${path}.${key}`;
		if (own(MODEL_FIELDS, key)) {
			const reason = MODEL_FIELDS[key as keyof ModelSettings](value);
			if (reason) {
				issues.push({ severity: "error", path: keyPath, message: `= ${show(value)} ${reason} - ignored` });
			} else {
				out[key] = value;
			}
			continue;
		}
		issues.push({
			severity: "warning",
			path: keyPath,
			message: own(ELSEWHERE, key) ? (ELSEWHERE[key] as string) : "is not a known setting - ignored",
		});
	}
	return out as ModelSettings;
}

/**
 * Validate the per-model part of the parsed config file. Invalid values are
 * dropped and reported as errors, so they fall through to the global setting;
 * unknown keys are warnings. The file's other keys belong to settings.ts.
 */
export function loadModelConfig(raw: unknown): { config: ModelConfigFile; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const config = emptyModelConfig();
	if (!isObject(raw) || raw.models === undefined) return { config, issues };

	if (!isObject(raw.models)) {
		issues.push({ severity: "error", path: "models", message: `= ${show(raw.models)} must be an object - ignored` });
		return { config, issues };
	}
	for (const [id, entry] of Object.entries(raw.models)) {
		if (id.startsWith("_")) continue;
		const path = `models[${JSON.stringify(id)}]`;
		if (!isObject(entry)) {
			issues.push({ severity: "error", path, message: `= ${show(entry)} must be an object - ignored` });
			continue;
		}
		config.models[id] = validateModel(entry, path, issues);
	}
	return { config, issues };
}

// ── resolving ──

/** The global layer: the file's top level, else the env var (settings.ts resolves both). */
export interface GlobalSettings {
	keepAlive?: string | number;
	warm: boolean;
	releaseAfter?: string | number;
}

export interface ResolvedModelSettings {
	/** Absent means the field is left out of the request and the server decides. */
	keepAlive?: string | number;
	warm: boolean;
	/** 0 = unload when the user leaves it (the default), a duration, or "keep". */
	releaseAfter: string | number;
}

/** A used model is unloaded as soon as the user leaves it, unless they chose otherwise. */
export const DEFAULT_RELEASE_AFTER = 0;

/** One model's effective settings: its own entry, else the global value. */
export function resolveModelSettings(
	config: ModelConfigFile | undefined,
	global: GlobalSettings,
	modelId: string | undefined,
): ResolvedModelSettings {
	const entry: ModelSettings =
		config && modelId !== undefined && own(config.models, modelId) ? (config.models[modelId] ?? {}) : {};
	const keepAlive = entry.keepAlive ?? global.keepAlive;
	return {
		...(keepAlive !== undefined && { keepAlive }),
		warm: entry.warm ?? global.warm,
		releaseAfter: entry.releaseAfter ?? global.releaseAfter ?? DEFAULT_RELEASE_AFTER,
	};
}

// ── reporting ──

export function formatIssue(issue: ConfigIssue): string {
	return `pi-ollama config: ${issue.path} ${issue.message}`;
}
