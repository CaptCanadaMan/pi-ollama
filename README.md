# pi-ollama

Native Ollama provider extension for the [pi coding agent](https://github.com/badlogic/pi-mono).

Talks directly to Ollama's `/api/chat` endpoint, bypassing the OpenAI-compat shim at `/v1/chat/completions` that [silently drops `tool_calls`](https://github.com/ollama/ollama/issues/12557) from streamed responses.

---

## Why this exists

Pi ships with an `openai-completions` adapter that routes Ollama traffic through Ollama's OpenAI-compat shim. The shim has a known streaming bug: `tool_calls` are dropped from the streamed deltas. Without those tool calls, pi's agent loop stalls on the first tool use — the model produces a tool call, the wire eats it, pi never sees it.

Ollama's native `/api/chat` endpoint doesn't have this problem. This extension routes around the shim entirely.

---

## Install

```bash
pi install npm:pi-ollama
```

Or for local development:

```bash
git clone https://github.com/CaptCanadaMan/pi-ollama
cd pi-ollama
npm install
pi install /absolute/path/to/pi-ollama
```

Requires Ollama running locally (default `http://localhost:11434`) and at least one tool-capable model pulled.

---

## Quick start

After installation, launch pi and run:

```
/ollama-status
```

You should see something like:

```
Ollama base URL: http://localhost:11434
✓ Ollama reachable — 3 model(s) registered
  qwen2.5-coder:7b               ctx:131,072  [tools]
  gemma4:26b                     ctx:262,144  [tools, vision, reasoning]
  llama3.1:8b                    ctx:131,072  [tools]
```

Switch to one of the discovered models and use pi normally — tool calls work end-to-end.

---

## Slash commands

| Command | Description |
|---|---|
| `/ollama-status` | Show the Ollama base URL, registered models with capability flags, and currently loaded models. |
| `/ollama-refresh` | Re-discover models from `/api/tags` + `/api/show` and re-register the provider. Useful after `ollama pull <model>`. |
| `/ollama-info <model-id>` | Dump the full `/api/show` response for a model — capabilities, context length, parameters, etc. |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `localhost:11434` | Ollama server host[:port]. May include or omit protocol. |
| `OLLAMA_NATIVE_DEBUG` | unset | Set to `1` to enable per-chunk debug logging. Writes to a **file** (see below) — not stderr, since stderr writes corrupt pi's TUI rendering. |
| `OLLAMA_NATIVE_DEBUG_LOG` | `~/.pi/agent/cache/pi-ollama-debug.log` | Override the default debug log path. |
| `OLLAMA_NATIVE_DUMP_DIR` | unset | If set, writes paired `req-*.json` / `res-*.ndjson` files per request — exact replay artifacts for diagnostics. |
| `OLLAMA_NATIVE_GHOST_RETRIES` | `2` | Max retries when Ollama returns ghost-token responses (see Reliability below). |

Live-tail the debug log from another terminal:

```bash
tail -f ~/.pi/agent/cache/pi-ollama-debug.log
```

---

## How model discovery works

On extension load, the provider:

1. Reads cached models from `~/.pi/agent/cache/pi-ollama-models.json` (instant startup, no network).
2. Calls `GET /api/tags` to list pulled models.
3. For each model, calls `POST /api/show` to extract:
   - Context window from `model_info.*.context_length`.
   - Tool support from `capabilities` array, falling back to family-name heuristics for older Ollama versions.
   - Vision support from `capabilities` or `details.families` containing `clip`.
   - Reasoning/thinking support from `capabilities` or model-name patterns (`r1`, `deepseek`, `gemma4`, etc.).
4. Caches the result for next startup.

If Ollama is unreachable at startup, the cached list is used as a fallback. Run `/ollama-refresh` once it's available to re-discover.

---

## Reliability features

Ollama's streaming has a few known edge cases. The provider handles them explicitly rather than letting them surface as silent stalls:

**Ghost-token retry.** Ollama occasionally generates output tokens but streams nothing visible (`done:true`, `eval_count > 0`, empty message). The provider reads the first NDJSON line of each attempt, detects this pattern, cancels the connection, and retries. Up to `OLLAMA_NATIVE_GHOST_RETRIES` times (default 2 → ≈99% success at typical failure rates).

**Truncation detection.** If the connection closes before any chunk with `done:true` arrives, the provider surfaces a clear error rather than silently treating the partial response as complete. The error explains this is an Ollama-side reliability issue and prompts a retry.

**Empty-response detection.** If the connection closes without sending any chunks at all, the provider raises a distinct error pointing at the most likely causes (model failed to load, Ollama crashed, network issue).

**Post-stream ghost check.** Belt-and-suspenders: if `eval_count > 0` but no content, thinking, or tool calls landed in the parsed stream, the provider raises an error rather than reporting a successful empty turn.

---

## Compatibility

- **pi**: Tested against `@mariozechner/pi-coding-agent` v0.71.x. Should work with any version exposing the standard `ExtensionAPI` (`registerProvider` with `streamSimple`, `registerCommand` with `ctx.ui.notify`).
- **Ollama**: Requires Ollama with `/api/chat` support (most versions). `/api/ps` is used opportunistically and tolerates older versions that don't expose it.
- **Node**: Requires Node 18+ for built-in `fetch` and Web Streams.

---

## Architecture (one paragraph)

The extension registers an `ollama` provider with a custom `streamSimple` handler. Pi calls `streamSimple(model, context, options)` for every turn; the handler converts pi's internal message format to Ollama's `/api/chat` wire format, opens an NDJSON stream, parses chunks into pi's `AssistantMessageEventStream` events (text deltas, thinking deltas, tool-call bursts, done), and surfaces errors with explanatory messages. No core pi changes required — `streamSimple` fully replaces the built-in handler for the registered API string.

See [src/](./src/) for the implementation. Each file has a header comment explaining its role.

---

## Limitations / not yet implemented

- **Ollama Cloud (`https://ollama.com`).** This extension targets local Ollama. Cloud requires different auth (`OLLAMA_API_KEY`) and a different base URL — see [`fgrehm/pi-ollama-cloud`](https://github.com/fgrehm/pi-ollama-cloud) if you want cloud-only.
- **Per-model `temperature` / `top_p` defaults.** Sampling parameters are passed through from pi's options when set, but there's no extension-level config for default values per model. Open an issue if you need this.
- **Auto-pull.** If you select a model that isn't pulled, you'll get an error from Ollama. The extension doesn't offer to `ollama pull` it for you.

---

## Related projects

- **[pi-mono](https://github.com/badlogic/pi-mono)** — the pi coding agent itself
- **[ollama#12557](https://github.com/ollama/ollama/issues/12557)** — the upstream tool-calling streaming bug this extension routes around
- **[pi-mono#3357](https://github.com/badlogic/pi-mono/issues/3357)** — the open issue requesting an official local-LLM extension
- **[`@0xkobold/pi-ollama`](https://github.com/0xKobold/pi-ollama)** — alternative extension covering local + cloud via the OpenAI-compat shim
- **[`fgrehm/pi-ollama-cloud`](https://github.com/fgrehm/pi-ollama-cloud)** — cloud-only Ollama extension

---

## License

[MIT](./LICENSE) © 2026 CaptCanadaMan
