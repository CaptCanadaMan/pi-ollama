// Wire types for Ollama's /api/chat NDJSON protocol.
// These are the exact JSON shapes Ollama sends and receives — no pi dependencies.

export interface OllamaTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: object;
	};
}

export interface OllamaWireToolCall {
	id?: string;
	function: {
		index?: number;
		name: string;
		arguments: Record<string, unknown>;
	};
}

export interface OllamaWireMessage {
	role: "user" | "assistant" | "tool" | "system";
	content?: string;
	thinking?: string;
	tool_calls?: OllamaWireToolCall[];
	tool_name?: string;
	images?: string[];
}

export interface OllamaChunk {
	model: string;
	created_at: string;
	message?: OllamaWireMessage;
	done: boolean;
	done_reason?: string;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_count?: number;
	prompt_eval_duration?: number;
	eval_count?: number;
	eval_duration?: number;
	error?: string;
	// One entry per streamed token when the request set logprobs:true (model-config.ts request.logprobs).
	logprobs?: { token: string; logprob: number; bytes?: number[] }[];
}

export interface OllamaRequest {
	model: string;
	messages: OllamaWireMessage[];
	tools?: OllamaTool[];
	stream: true;
	// Ollama defaults thinking-capable models to thinking ON when this field is
	// absent — off must be sent explicitly, not omitted. A string is one of the
	// model's own levels from /api/show's thinking.values (gh#13).
	think?: boolean | string;
	// Everything past num_predict comes from the per-model config (model-config.ts).
	options?: {
		num_ctx?: number;
		temperature?: number;
		num_predict?: number;
		top_p?: number;
		top_k?: number;
		min_p?: number;
		typical_p?: number;
		repeat_penalty?: number;
		repeat_last_n?: number;
		presence_penalty?: number;
		frequency_penalty?: number;
		seed?: number;
		num_keep?: number;
		stop?: string[];
		/** Layers offloaded to the GPU - not a GPU count. */
		num_gpu?: number;
		main_gpu?: number;
		num_batch?: number;
		num_thread?: number;
		use_mmap?: boolean;
	};
	keep_alive?: string | number;
	format?: string | object;
	// Defaults to true on the server: a chat longer than num_ctx silently loses
	// its oldest messages. We always send false so Ollama refuses instead and
	// pi can compact (see errors.ts).
	truncate?: boolean;
	// Per-token log-probabilities (model-config.ts request.logprobs). No top_logprobs.
	logprobs?: boolean;
}
