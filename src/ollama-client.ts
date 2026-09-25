// Every request this extension makes to Ollama, one function per operation.
// Timeouts live here, so no caller can forget one and hang pi with a stuck
// server.

import type { OllamaShowResponse } from "./capabilities.js";
import { describeOllamaError } from "./errors.js";

/** Where an Ollama server lives, and the key it expects, if any. */
export interface OllamaTarget {
	baseUrl: string;
	apiKey?: string;
}

export interface RequestOptions {
	/** Give up after this long. Default: 5 s - these are quick metadata reads. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

const trimSlashes = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

function url(target: OllamaTarget, path: string): string {
	return `${trimSlashes(target.baseUrl)}${path}`;
}

/**
 * The target for a request to `baseUrl` (default: the configured server).
 * The key is only ever sent to the server it was configured for, so a model
 * that points somewhere else goes without it.
 */
export function targetFor(configured: OllamaTarget, baseUrl?: string): OllamaTarget {
	if (!baseUrl || trimSlashes(baseUrl) === trimSlashes(configured.baseUrl)) return configured;
	return { baseUrl };
}

/** JSON content type, the target's key if it has one, then caller layers (later wins). */
function headersFor(
	target: OllamaTarget,
	layers: Array<Record<string, string> | undefined> = [],
): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`);
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer ?? {})) headers.set(name, value);
	}
	return headers;
}

/**
 * A metadata request: bounded by a timeout, a non-2xx thrown as the described
 * error, the JSON body returned. `body` makes it a POST.
 */
async function requestJson<T>(
	target: OllamaTarget,
	path: string,
	{ timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions,
	body?: object,
): Promise<T> {
	const res = await fetch(url(target, path), {
		headers: headersFor(target),
		signal: AbortSignal.timeout(timeoutMs),
		...(body && { method: "POST", body: JSON.stringify(body) }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			describeOllamaError(text, {
				endpoint: path,
				status: res.status,
				apiKeySent: Boolean(target.apiKey),
			}),
		);
	}
	return (await res.json()) as T;
}

/** The names of the models the server has, from /api/tags. */
export async function listModels(
	target: OllamaTarget,
	options: RequestOptions = {},
): Promise<string[]> {
	const { models = [] } = await requestJson<{ models?: Array<{ name: string }> }>(
		target,
		"/api/tags",
		options,
	);
	return models.map((m) => m.name);
}

export interface RunningModel {
	name: string;
	size_vram?: number;
	expires_at?: string;
}

/** The models currently loaded in memory, from /api/ps. */
export async function runningModels(
	target: OllamaTarget,
	options: RequestOptions = {},
): Promise<RunningModel[]> {
	const { models = [] } = await requestJson<{ models?: RunningModel[] }>(
		target,
		"/api/ps",
		options,
	);
	return models;
}

/** The server's version, from /api/version - the cheapest "is it up?" check. */
export async function serverVersion(
	target: OllamaTarget,
	options: RequestOptions = {},
): Promise<string> {
	const { version } = await requestJson<{ version: string }>(target, "/api/version", options);
	return version;
}

/** A model's details and capabilities, from /api/show. */
export function showModel(
	target: OllamaTarget,
	name: string,
	options: RequestOptions = {},
): Promise<OllamaShowResponse> {
	return requestJson<OllamaShowResponse>(target, "/api/show", options, { name });
}

export interface ChatOptions {
	/** The turn's abort signal. Chat has no timeout: generation takes as long as it takes. */
	signal?: AbortSignal;
	/** Header layers applied in order over the JSON content type; later layers win. */
	headers?: Array<Record<string, string> | undefined>;
}

/**
 * Start a streaming /api/chat request and return the raw response. The caller
 * reads the NDJSON stream and handles a non-2xx itself, since only it knows
 * the num_ctx the request carried.
 */
export function openChat(
	target: OllamaTarget,
	body: object,
	{ signal, headers = [] }: ChatOptions = {},
): Promise<Response> {
	return fetch(url(target, "/api/chat"), {
		method: "POST",
		headers: headersFor(target, headers),
		body: JSON.stringify(body),
		signal,
	});
}
