// Per-model configuration: one schema, one validator, one resolver.
//
// The file is ~/.pi/agent/cache/pi-ollama-config.json (config.ts). Layers, per
// key: models[id] > defaults > top level > env var > built-in default. Keys
// starting with "_" are comments and are ignored everywhere.
//
// No runtime imports, so it can be tested on its own.

export type Severity = "error" | "warning";

export interface ConfigIssue {
	severity: Severity;
	/** Where in the file, e.g. models["gpt-oss:latest"].sampling.topP */
	path: string;
	/** Reads after the path, e.g. `= 1.4 must be at most 1 - ignored`. */
	message: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface SamplingConfig {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	typicalP?: number;
	repeatPenalty?: number;
	repeatLastN?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	numKeep?: number;
	stop?: string[];
}

export interface GpuConfig {
	/** Layers offloaded to the GPU - not a GPU count. -1 lets Ollama decide. */
	numGpu?: number;
	/** Primary GPU index: a nudge, not a pin. */
	mainGpu?: number;
	numBatch?: number;
	numThread?: number;
	useMmap?: boolean;
}

export interface RequestConfig {
	/** Abort the stream after this long with no chunk. 0 = no timeout. */
	idleTimeoutMs?: number;
	/** Retries after an idle timeout, only when no chunk arrived in that attempt. */
	maxRetries?: number;
	/** Send logprobs:true on real turns (never on the warm-up). */
	logprobs?: boolean;
}

export interface ModelSettings {
	contextLength?: number;
	maxTokens?: number;
	thinkingLevel?: ThinkingLevelName;
	keepAlive?: string | number;
	warm?: boolean;
	sampling?: SamplingConfig;
	gpu?: GpuConfig;
	request?: RequestConfig;
	/** Name of a `servers` entry. Model entries only. */
	server?: string;
}

export interface ServerConfig {
	host: string;
	port?: number;
}

export interface ModelConfigFile {
	defaults: ModelSettings;
	/** Model keys written at the top level of the file (where slash commands write without a defaults block). */
	topLevel: ModelSettings;
	/** Null-prototype map, so ids like "__proto__" are plain entries. */
	models: Record<string, ModelSettings>;
	servers: Record<string, ServerConfig>;
}

export function emptyModelConfig(): ModelConfigFile {
	return {
		defaults: {},
		topLevel: {},
		models: Object.create(null) as Record<string, ModelSettings>,
		servers: Object.create(null) as Record<string, ServerConfig>,
	};
}

// ── validators: return why a value is invalid, or undefined when it's fine ──

type Check = (v: unknown) => string | undefined;

interface FieldSpec {
	check: Check;
	/** Ollama's option name, for fields sent in `options`. */
	wire?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function int(min?: number, max?: number): Check {
	return (v) => {
		if (typeof v !== "number" || !Number.isInteger(v)) return "must be an integer";
		if (min !== undefined && v < min) return `must be at least ${min}`;
		if (max !== undefined && v > max) return `must be at most ${max}`;
		return undefined;
	};
}

function num(opts: { min?: number; max?: number; above?: number } = {}): Check {
	return (v) => {
		if (typeof v !== "number" || !Number.isFinite(v)) return "must be a number";
		if (opts.above !== undefined && v <= opts.above) return `must be greater than ${opts.above}`;
		if (opts.min !== undefined && v < opts.min) return `must be at least ${opts.min}`;
		if (opts.max !== undefined && v > opts.max) return `must be at most ${opts.max}`;
		return undefined;
	};
}

const bool: Check = (v) => (typeof v === "boolean" ? undefined : "must be true or false");

const stringList: Check = (v) =>
	Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0)
		? undefined
		: "must be a list of non-empty strings";

const nonEmptyString: Check = (v) =>
	typeof v === "string" && v.trim().length > 0 ? undefined : "must be a non-empty string";

// Same Go-style duration upstream's settings.ts accepts for keep_alive.
const GO_DURATION_RE = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

const keepAliveCheck: Check = (v) => {
	if (typeof v === "number" && Number.isInteger(v)) return undefined;
	if (typeof v === "string" && GO_DURATION_RE.test(v)) return undefined;
	return 'must be a duration like "30m" / "1h30m" or a whole number of seconds (-1 = keep loaded)';
};

const thinkingCheck: Check = (v) =>
	typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v)
		? undefined
		: `must be one of ${THINKING_LEVELS.join(", ")}`;

const idleCheck: Check = (v) => {
	const reason = int(0)(v);
	if (reason) return reason;
	return v === 0 || (v as number) >= 1000 ? undefined : "must be 0 (no timeout) or at least 1000";
};

const hostCheck: Check = (v) =>
	typeof v === "string" && /^\S+$/.test(v) ? undefined : "must be a hostname or IP without spaces";

// ── schema ──

export const SAMPLING_FIELDS: Record<keyof SamplingConfig, FieldSpec> = {
	temperature: { check: num({ min: 0 }), wire: "temperature" },
	topP: { check: num({ min: 0, max: 1 }), wire: "top_p" },
	topK: { check: int(0), wire: "top_k" },
	minP: { check: num({ min: 0, max: 1 }), wire: "min_p" },
	typicalP: { check: num({ min: 0, max: 1 }), wire: "typical_p" },
	repeatPenalty: { check: num({ above: 0 }), wire: "repeat_penalty" },
	repeatLastN: { check: int(-1), wire: "repeat_last_n" },
	presencePenalty: { check: num(), wire: "presence_penalty" },
	frequencyPenalty: { check: num(), wire: "frequency_penalty" },
	seed: { check: int(), wire: "seed" },
	numKeep: { check: int(-1), wire: "num_keep" },
	stop: { check: stringList, wire: "stop" },
};

export const GPU_FIELDS: Record<keyof GpuConfig, FieldSpec> = {
	numGpu: { check: int(-1), wire: "num_gpu" }, // -1 = let Ollama decide
	mainGpu: { check: int(0), wire: "main_gpu" },
	numBatch: { check: int(1), wire: "num_batch" },
	numThread: { check: int(1), wire: "num_thread" },
	useMmap: { check: bool, wire: "use_mmap" },
};

export const REQUEST_FIELDS: Record<keyof RequestConfig, FieldSpec> = {
	idleTimeoutMs: { check: idleCheck },
	maxRetries: { check: int(0, 10) },
	logprobs: { check: bool },
};

const SECTIONS: Record<"sampling" | "gpu" | "request", Record<string, FieldSpec>> = {
	sampling: SAMPLING_FIELDS,
	gpu: GPU_FIELDS,
	request: REQUEST_FIELDS,
};

type ScalarKey = "contextLength" | "maxTokens" | "thinkingLevel" | "keepAlive" | "warm" | "server";

const SCALAR_FIELDS: Record<ScalarKey, FieldSpec> = {
	contextLength: { check: int(256) },
	maxTokens: { check: int(1) },
	thinkingLevel: { check: thinkingCheck },
	keepAlive: { check: keepAliveCheck },
	warm: { check: bool },
	server: { check: nonEmptyString },
};

/** Top-level-only keys. apiKeyApproval/autostart are upstream's own and validated there. */
const APP_KEYS = new Set(["defaults", "models", "servers", "apiKeyApproval", "autostart"]);

const RETIRED: Record<string, string> = {
	perModelContext: 'moved to models["<id>"].contextLength',
	perModelParams: 'moved to models["<id>"].sampling / .gpu / .keepAlive',
};

// ── loading ──

const show = (v: unknown): string => JSON.stringify(v) ?? String(v);
const error = (path: string, message: string): ConfigIssue => ({ severity: "error", path, message });
const warning = (path: string, message: string): ConfigIssue => ({ severity: "warning", path, message });
const join = (base: string, key: string) => (base ? `${base}.${key}` : key);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function validateFields(
	raw: Record<string, unknown>,
	spec: Record<string, FieldSpec>,
	basePath: string,
	issues: ConfigIssue[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key.startsWith("_")) continue;
		const path = join(basePath, key);
		if (!own(spec, key)) {
			issues.push(warning(path, "is not a known setting - ignored"));
			continue;
		}
		const reason = spec[key].check(value);
		if (reason) issues.push(error(path, `= ${show(value)} ${reason} - ignored`));
		else out[key] = value;
	}
	return out;
}

function validateSettings(
	raw: Record<string, unknown>,
	basePath: string,
	where: "model" | "global",
	issues: ConfigIssue[],
	skip: Set<string> = new Set(),
): ModelSettings {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key.startsWith("_") || skip.has(key)) continue;
		const path = join(basePath, key);
		if (own(SECTIONS, key)) {
			if (!isObject(value)) {
				issues.push(error(path, `= ${show(value)} must be an object - ignored`));
				continue;
			}
			out[key] = validateFields(value, SECTIONS[key as keyof typeof SECTIONS], path, issues);
			continue;
		}
		if (own(SCALAR_FIELDS, key)) {
			if (key === "server" && where !== "model") {
				issues.push(error(path, "is only allowed inside a models entry - ignored"));
				continue;
			}
			const reason = SCALAR_FIELDS[key as ScalarKey].check(value);
			if (reason) issues.push(error(path, `= ${show(value)} ${reason} - ignored`));
			else out[key] = value;
			continue;
		}
		if (APP_KEYS.has(key)) {
			issues.push(error(path, "is a top-level setting and isn't allowed here - ignored"));
			continue;
		}
		const hint = own(RETIRED, key) ? ` (${RETIRED[key]})` : "";
		issues.push(warning(path, `is not a known setting - ignored${hint}`));
	}
	return out as ModelSettings;
}

function validateServers(raw: unknown, issues: ConfigIssue[]): Record<string, ServerConfig> {
	const out = Object.create(null) as Record<string, ServerConfig>;
	if (raw === undefined) return out;
	if (!isObject(raw)) {
		issues.push(error("servers", `= ${show(raw)} must be an object - ignored`));
		return out;
	}
	for (const [name, value] of Object.entries(raw)) {
		if (name.startsWith("_")) continue;
		const path = `servers[${JSON.stringify(name)}]`;
		if (!isObject(value)) {
			issues.push(error(path, `= ${show(value)} must be an object - ignored`));
			continue;
		}
		const hostReason = hostCheck(value.host);
		if (hostReason) {
			issues.push(error(`${path}.host`, `= ${show(value.host)} ${hostReason} - server ignored`));
			continue;
		}
		const server: ServerConfig = { host: value.host as string };
		if (value.port !== undefined) {
			const portReason = int(1, 65535)(value.port);
			if (portReason) issues.push(error(`${path}.port`, `= ${show(value.port)} ${portReason} - ignored`));
			else server.port = value.port as number;
		}
		for (const key of Object.keys(value)) {
			if (key !== "host" && key !== "port" && !key.startsWith("_")) {
				issues.push(warning(`${path}.${key}`, "is not a known setting - ignored"));
			}
		}
		out[name] = server;
	}
	return out;
}

/**
 * Validate the parsed config file. Invalid values are dropped (reported as
 * errors) so they fall through to the next layer; unknown keys are warnings.
 * `env` is only read for the env-override warnings.
 */
export function loadModelConfig(
	raw: unknown,
	env: Record<string, string | undefined> = process.env,
): { config: ModelConfigFile; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const config = emptyModelConfig();
	if (raw === undefined || raw === null) return { config, issues };
	if (!isObject(raw)) {
		issues.push(error("pi-ollama-config.json", "must contain a JSON object - ignored"));
		return { config, issues };
	}

	config.topLevel = validateSettings(raw, "", "global", issues, APP_KEYS);

	if (raw.defaults !== undefined) {
		if (isObject(raw.defaults)) config.defaults = validateSettings(raw.defaults, "defaults", "global", issues);
		else issues.push(error("defaults", `= ${show(raw.defaults)} must be an object - ignored`));
	}

	config.servers = validateServers(raw.servers, issues);

	if (raw.models !== undefined) {
		if (!isObject(raw.models)) {
			issues.push(error("models", `= ${show(raw.models)} must be an object - ignored`));
		} else {
			for (const [id, entry] of Object.entries(raw.models)) {
				if (id.startsWith("_")) continue;
				const path = `models[${JSON.stringify(id)}]`;
				if (!isObject(entry)) {
					issues.push(error(path, `= ${show(entry)} must be an object - ignored`));
					continue;
				}
				const settings = validateSettings(entry, path, "model", issues);
				if (settings.server !== undefined && !own(config.servers, settings.server)) {
					issues.push(error(`${path}.server`, `= ${show(settings.server)} doesn't match any entry in servers - using the default server`));
					delete settings.server;
				}
				config.models[id] = settings;
			}
		}
	}

	for (const key of Object.keys(config.defaults)) {
		if (own(config.topLevel, key)) {
			issues.push(warning(`defaults.${key}`, `is also set at the top level - defaults wins`));
		}
	}

	issues.push(...envOverrideWarnings(config, env));
	return { config, issues };
}

/** Upstream env vars sit below saved config; say so when one is being overridden. */
const ENV_KEYS: Array<[string, GlobalOverrideKey]> = [
	["OLLAMA_CONTEXT_LENGTH", "contextLength"],
	["OLLAMA_KEEP_ALIVE", "keepAlive"],
	["OLLAMA_NATIVE_WARM", "warm"],
];
type GlobalOverrideKey = "contextLength" | "keepAlive" | "warm";

function envOverrideWarnings(config: ModelConfigFile, env: Record<string, string | undefined>): ConfigIssue[] {
	const out: ConfigIssue[] = [];
	for (const [name, key] of ENV_KEYS) {
		const value = env[name];
		if (value === undefined || value === "") continue;
		const where: string[] = [];
		if (config.topLevel[key] !== undefined) where.push("the top level");
		if (config.defaults[key] !== undefined) where.push("defaults");
		const n = Object.values(config.models).filter((m) => m[key] !== undefined).length;
		if (n > 0) where.push(`${n} model entr${n === 1 ? "y" : "ies"}`);
		if (where.length > 0) out.push(warning(name, `=${value} is set but overridden by the config (${where.join(", ")})`));
	}
	return out;
}

// ── resolving ──

/**
 * The top-level + env layer for the keys upstream already resolves in
 * settings.ts (saved value > env var). The settings object satisfies this.
 */
export interface GlobalFallback {
	contextLength?: number;
	keepAlive?: string | number;
	warm?: boolean;
}

export const REQUEST_DEFAULTS: Required<RequestConfig> = {
	idleTimeoutMs: 240_000,
	maxRetries: 2,
	logprobs: false,
};

export interface ResolvedModelConfig {
	contextLength?: number;
	maxTokens?: number;
	thinkingLevel?: ThinkingLevelName;
	keepAlive?: string | number;
	warm: boolean;
	sampling: SamplingConfig;
	gpu: GpuConfig;
	request: Required<RequestConfig>;
	server?: string;
}

/** One model's effective settings: models[id] > defaults > top level / env > built-in. */
export function resolveModelConfig(
	config: ModelConfigFile | undefined,
	fallback: GlobalFallback,
	modelId: string | undefined,
): ResolvedModelConfig {
	const c = config ?? emptyModelConfig();
	const m: ModelSettings = (modelId !== undefined && own(c.models, modelId) ? c.models[modelId] : undefined) ?? {};
	const d = c.defaults;
	const t = c.topLevel;
	const resolved: ResolvedModelConfig = {
		contextLength: m.contextLength ?? d.contextLength ?? fallback.contextLength,
		maxTokens: m.maxTokens ?? d.maxTokens ?? t.maxTokens,
		thinkingLevel: m.thinkingLevel ?? d.thinkingLevel ?? t.thinkingLevel,
		keepAlive: m.keepAlive ?? d.keepAlive ?? fallback.keepAlive,
		warm: m.warm ?? d.warm ?? fallback.warm ?? true,
		sampling: { ...t.sampling, ...d.sampling, ...m.sampling },
		gpu: { ...t.gpu, ...d.gpu, ...m.gpu },
		request: { ...REQUEST_DEFAULTS, ...t.request, ...d.request, ...m.request },
	};
	if (m.server !== undefined) resolved.server = m.server;
	return resolved;
}

/** The sampling/gpu values as Ollama `options` (snake_case), unset fields omitted. */
export function toOllamaOptions(
	r: Pick<ResolvedModelConfig, "sampling" | "gpu">,
): Record<string, number | boolean | string[]> {
	const out: Record<string, number | boolean | string[]> = {};
	const add = (values: object, spec: Record<string, FieldSpec>) => {
		for (const [key, field] of Object.entries(spec)) {
			const v = (values as Record<string, unknown>)[key];
			if (v !== undefined && field.wire) out[field.wire] = v as number | boolean | string[];
		}
	};
	add(r.sampling, SAMPLING_FIELDS);
	add(r.gpu, GPU_FIELDS);
	return out;
}

/** http://host:port for a server entry; scheme and port 11434 added only when missing. */
export function serverBaseUrl(server: ServerConfig): string {
	const host = server.host.replace(/\/+$/, "");
	const hasScheme = /^https?:\/\//i.test(host);
	const url = hasScheme ? host : `http://${host}`;
	if (server.port !== undefined) return `${url.replace(/:\d+$/, "")}:${server.port}`;
	if (hasScheme || /:\d+$/.test(host)) return url;
	return `${url}:11434`;
}

export function resolveServerUrl(config: ModelConfigFile, name: string | undefined): string | undefined {
	if (name === undefined || !own(config.servers, name)) return undefined;
	return serverBaseUrl(config.servers[name]);
}

// ── slash-command helpers ──

export type GlobalKey = "contextLength" | "keepAlive" | "warm";

/** The global value a slash command should show: defaults, else top level / env. */
export function globalValue<K extends GlobalKey>(
	config: ModelConfigFile | undefined,
	fallback: GlobalFallback,
	key: K,
): GlobalFallback[K] {
	return ((config?.defaults[key] as GlobalFallback[K] | undefined) ?? fallback[key]) as GlobalFallback[K];
}

/** Why a slash command's new global value would be rejected by the validator, or undefined when it's valid. */
export function checkGlobalValue(key: GlobalKey, value: unknown): string | undefined {
	return SCALAR_FIELDS[key].check(value);
}

/**
 * Write a global setting into the raw file object: into `defaults` when the
 * file has a defaults block, else the top level (so old files keep working).
 * `undefined` deletes it. Returns where it was written.
 */
export function setGlobalSetting(file: object, key: GlobalKey, value: unknown): "defaults" | "top level" {
	const raw = file as Record<string, unknown>;
	const inDefaults = isObject(raw.defaults);
	const target = inDefaults ? (raw.defaults as Record<string, unknown>) : raw;
	if (value === undefined) delete target[key];
	else target[key] = value;
	return inDefaults ? "defaults" : "top level";
}

// ── after discovery ──

/**
 * Checks that need the discovered model list: a models entry that matches no
 * model (usually a typo), and an explicit per-model thinkingLevel the model
 * doesn't support. A defaults-level thinkingLevel isn't an error: it's just
 * skipped for models that lack it.
 */
export function checkAgainstModels(
	config: ModelConfigFile,
	models: Array<{ id: string; supportedLevels: readonly string[] }>,
): ConfigIssue[] {
	const byId = new Map(models.map((m) => [m.id, m]));
	const issues: ConfigIssue[] = [];
	for (const [id, entry] of Object.entries(config.models)) {
		const path = `models[${JSON.stringify(id)}]`;
		const model = byId.get(id);
		if (!model) {
			issues.push(warning(path, "doesn't match any discovered model (see /ollama-status) - kept in case it appears after /ollama-refresh"));
			continue;
		}
		if (entry.thinkingLevel !== undefined && !model.supportedLevels.includes(entry.thinkingLevel)) {
			issues.push(error(`${path}.thinkingLevel`, `= ${show(entry.thinkingLevel)} isn't supported by this model (supported: ${model.supportedLevels.join(", ")}) - not applied`));
		}
	}
	return issues;
}

// ── reporting ──

export function formatIssue(issue: ConfigIssue): string {
	return `pi-ollama config: ${issue.path} ${issue.message}`;
}

/** Through pi's notify (errors show red) when there's a UI, else stderr. */
export function reportConfigIssues(
	issues: ConfigIssue[],
	notify?: (message: string, type: Severity) => void,
): void {
	for (const issue of issues) {
		if (notify) notify(formatIssue(issue), issue.severity);
		else process.stderr.write(`${formatIssue(issue)}\n`);
	}
}

interface ReportingPi {
	on?: (
		event: "session_start",
		handler: (
			event: { reason?: string },
			ctx: { hasUI?: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
		) => void,
	) => void;
}

/** Report config problems once, when pi starts (/ollama-refresh reports its own). */
export function registerConfigReporting(pi: ReportingPi, getIssues: () => ConfigIssue[]): void {
	pi.on?.("session_start", (event, ctx) => {
		if (event.reason !== undefined && event.reason !== "startup") return;
		reportConfigIssues(getIssues(), ctx.hasUI === false ? undefined : (m, t) => ctx.ui.notify(m, t));
	});
}
