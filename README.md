# pi-ollama

Native Ollama provider extension for the [pi coding agent](https://github.com/earendil-works/pi).

pi-ollama connects pi to Ollama's native `/api/chat` API and builds every request itself. That's what the features below rely on: pi's built-in route to Ollama goes through Ollama's OpenAI-compatible endpoint, which doesn't carry settings like the context size, the thinking level or the truncation behaviour.

---

## Why this exists

*I was simply trying to use the pi agent locally with ollama and this can of worms opened up. Seemed like a good learning opportunity and a great way to start trying to get more involved in the community. New to contributing to open source and build-in-public etiquette, so feedback genuinely welcome. I hope you find this useful!*

I built this while getting pi to call tools on local models, and kept fixing problems as I ran into them. Some of the early tool-calling issues have since been fixed in Ollama itself. What pi-ollama gives you over pi's built-in route to Ollama:

- **The context size you choose, on every request.** pi-ollama sends `num_ctx` with each request, so the window in pi's footer is the one Ollama actually allocates, and you can change it per session with `/ollama-context`. Otherwise you get the server's default, which depends on your GPU memory (4K below 23 GiB). See [Context length and memory](#context-length-and-memory).
- **No silent loss of history.** When a conversation outgrows the window, Ollama normally drops the oldest messages without saying so. pi-ollama has it refuse instead, so pi compacts and carries on. See [When a conversation outgrows the context](#when-a-conversation-outgrows-the-context).
- **Thinking you can turn off, and each model's own levels.** Thinking off really is off on the wire, and pi's thinking-level picker shows the levels each model supports. See [Thinking control](#thinking-control).
- **A fast first answer.** Warm-up loads the model and has Ollama read pi's system prompt in the background, so your first message doesn't wait 30-50 seconds for it. See [Warm-up](#warm-up).
- **Ollama started for you.** If Ollama isn't running when pi starts, pi offers to start it and tells you how to stop it. See [Starting Ollama for you](#starting-ollama-for-you).
- **Each model's own sampling defaults.** pi-ollama leaves `temperature` and `top_p` to the model's settings unless pi sets them. The OpenAI-compatible endpoint forces both to 1.0.
- **Remote servers with a key.** Point pi at an Ollama behind a token-checking proxy, with the key only ever sent to that server. See [Using a remote Ollama with an API key](#using-a-remote-ollama-with-an-api-key).
- **Guards for Ollama's streaming failures,** readable error messages, and exact tok/s figures. See [Reliability features](#reliability-features) and [Generation speed](#generation-speed-toks).

Other Ollama extensions for pi (see [Related projects](#related-projects)) focus on getting models registered and on Ollama Cloud. This one is about how local models behave once you're using them.

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

Requires Ollama running locally (default `http://localhost:11434`) and at least one tool-capable model pulled. If Ollama isn't running when pi starts, pi offers to start it (see [Starting Ollama for you](#starting-ollama-for-you)).

**Try it without installing.** Load a local copy for one session only. `--no-extensions` keeps an installed `npm:pi-ollama` from loading alongside it (it also skips your other extensions; add one `-e` per extension you want to keep):

```bash
pi --no-extensions -e /absolute/path/to/pi-ollama/src/index.ts
```

**Using an Ollama on another machine.** Set `OLLAMA_HOST` before starting pi. The protocol is optional:

```bash
OLLAMA_HOST=192.168.1.20:11434 pi
```

If that server sits behind a proxy that checks a token, see [Using a remote Ollama with an API key](#using-a-remote-ollama-with-an-api-key).

---

## Uninstall

```bash
pi uninstall npm:pi-ollama
```

This removes the on-disk package and the entry from `~/.pi/agent/settings.json`. Pi won't auto-restore it on the next launch.

The bare form `pi uninstall pi-ollama` doesn't work - pi parses bare names as relative local paths rather than npm packages, so the `npm:` prefix is required for any npm-installed extension.

If you've already manually deleted the package directory (find it with `npm root -g`), pi will silently reinstall it on the next launch because `npm:pi-ollama` is still in `~/.pi/agent/settings.json`. Run the uninstall command above to clear the settings entry - the disk side is already clean.

Optional cleanup of the model discovery cache and saved settings:

```bash
rm -f ~/.pi/agent/cache/pi-ollama-models.json ~/.pi/agent/cache/pi-ollama-config.json
```

---

## Quick start

After installation, launch pi and run:

```
/ollama-status
```

You should see something like:

```
Ollama base URL: http://localhost:11434
keep_alive: defer to server (default)
Warm-up: on (/ollama-warm-up to change)
✓ Ollama reachable - 3 model(s) registered
  qwen2.5-coder:7b               ctx:32,768  [tools]
  gemma4:26b                     ctx:32,768  [tools, vision, reasoning]
  llama3.1:8b                    ctx:32,768  [tools]
```

Switch to one of the discovered models and use pi normally.

---

## Slash commands

| Command | Description |
|---|---|
| `/ollama-status` | Show the Ollama base URL, settings, registered models with capability flags, and currently loaded models. |
| `/ollama-refresh` | Re-discover models from `/api/tags` + `/api/show` and re-register the provider. Useful after `ollama pull <model>`. |
| `/ollama-info [model-id]` | Show capability details for a model. Omit the argument to pick from a list of currently registered models. |
| `/ollama-context` | Set the context length (`num_ctx`) pi-ollama sends to `/api/chat`. Picker with common presets + custom input. Persists across pi launches. |
| `/ollama-keep-alive` | Set the `keep_alive` pi-ollama sends to `/api/chat`, or (the default) send none and let the Ollama server's own setting decide. Picker with presets + custom input. Persists across pi launches. |
| `/ollama-warm-up` | Turn warm-up on or off (see [Warm-up](#warm-up)). Persists across pi launches. |
| `/ollama-stats` | Show tok/s throughput for this session's Ollama generations, per model: last, session average, fastest, tokens generated. |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `localhost:11434` | Ollama server host[:port]. May include or omit protocol. |
| `OLLAMA_CONTEXT_LENGTH` | unset | Override the `num_ctx` pi-ollama sends to `/api/chat`. Matches the env var Ollama itself respects, so a single setting works across tools. Superseded by `/ollama-context` if used. |
| `OLLAMA_KEEP_ALIVE` | unset | `keep_alive` for `/api/chat` requests (`"10m"`, `"1h30m"`, or an integer; `-1` = keep loaded forever). Matches the env var Ollama itself respects. **Unset (default): the field is omitted from requests and the server's own setting decides** - a per-request `keep_alive` overrides the server, so earlier versions' hardcoded `5m` silently defeated server-side keep-warm. Superseded by `/ollama-keep-alive` if used. |
| `OLLAMA_API_KEY` | unset | Bearer token for an Ollama behind a token-checking proxy. Only sent to `OLLAMA_HOST`, and only after you approve it (see [Using a remote Ollama with an API key](#using-a-remote-ollama-with-an-api-key)). |
| `OLLAMA_NATIVE_WARM` | on | Warm-up at session start and on model or thinking-level changes. Set to `0` to switch it off. Superseded by `/ollama-warm-up` if used. |
| `OLLAMA_NATIVE_DEBUG` | unset | Set to `1` to enable per-chunk debug logging. Writes to a **file** (see below) - not stderr, since stderr writes corrupt pi's TUI rendering. |
| `OLLAMA_NATIVE_DEBUG_LOG` | `~/.pi/agent/cache/pi-ollama-debug.log` | Override the default debug log path. |
| `OLLAMA_NATIVE_DUMP_DIR` | unset | If set, writes paired `req-*.json` / `res-*.ndjson` files per request - exact replay artifacts for diagnostics. |
| `OLLAMA_NATIVE_GHOST_RETRIES` | `2` | Max retries when Ollama returns ghost-token responses (see Reliability below). |
| `OLLAMA_NATIVE_THROUGHPUT` | on | Generation-speed telemetry (see Generation speed below). Set to `0` to switch the whole feature off - no footer figure, no session records. |

Live-tail the debug log from another terminal:

```bash
tail -f ~/.pi/agent/cache/pi-ollama-debug.log
```

---

## Context length and memory

pi-ollama sends a context size (`num_ctx`) with every request, and registers the same number with pi, so the context counter in pi's footer matches what Ollama actually allocates.

By default it's the model's trained context window, capped at 32,768 tokens. Some models report 262,144 or more, and asking Ollama for all of it would take more memory than most machines have.

To change it, run `/ollama-context` and pick a preset or enter your own number. It applies from the next request and is saved across pi launches. To go back to the default, pick "Use system default" in the same picker. You can also set `OLLAMA_CONTEXT_LENGTH` in the environment, which works the same way for Ollama itself; a value chosen in `/ollama-context` takes priority over it.

A bigger window holds more of the conversation but uses more memory, and a model that doesn't fit in memory will fail to load. If you hit that, step the size down. Changing the size makes Ollama reload the model on the next request.

---

## When a conversation outgrows the context

Ollama's default, when a chat no longer fits `num_ctx`, is to quietly drop the oldest messages until it does. The model answers without them, and the prompt size Ollama reports shrinks to match, so pi never notices it has run out of room. I measured it: a 9,533-token conversation sent with a 2,048-token window came back reporting a 32-token prompt, and the model answered as if the earlier messages had never been sent.

pi-ollama asks Ollama not to do that (`truncate: false`) and reports the refusal to pi in words pi recognizes as a context overflow. What you see then depends on how the window filled up:

- **Gradually, over a long session:** pi compacts on its usual schedule. The footer's context counter is accurate now, because nothing is being dropped behind its back.
- **In one jump, like reading a big file:** pi compacts and retries that turn once.
- **A single message bigger than the whole window:** pi stops with an error that says so and points at `/ollama-context`.
- **With pi's auto-compaction switched off:** the turn stops with that same error, and you run `/compact` yourself.

One trade-off: pi's compaction summary also runs through the model. On a very small window that summary request can now fail with an overflow error, where before it would have quietly summarized a truncated conversation.

This needs Ollama 0.12.5 or later. Older servers ignore the setting and truncate as before.

---

## Starting Ollama for you

If pi starts and nothing is listening at a local `OLLAMA_HOST` (localhost, `127.x`, `::1`), pi offers to start Ollama:

- **macOS:** it opens the Ollama app hidden, the same way Ollama's own CLI does. You get the menu-bar icon and no window. Quit it from that icon when you're done.
- **Linux:** it starts `ollama serve` in the background and tells you its PID, so `kill <pid>` stops it. The prompt also mentions the manual routes: `ollama serve` in another terminal, or `sudo systemctl start ollama`.

The choices are Start Ollama now, Always start it automatically, Not now, and Never ask again. Always and Never are remembered in `~/.pi/agent/cache/pi-ollama-config.json`; delete the `"autostart"` line there to be asked again. In headless modes (rpc, print) it only starts Ollama if you've chosen Always. After a launch, `/ollama-status` repeats how to stop it.

It never offers when Ollama is on another machine, or when a server is there but not answering, since a second one couldn't share its port.

---

## Warm-up

The first turn with a local model pays for two things: loading the weights, and Ollama reading pi's system prompt and tool definitions. That prompt is about 7,800 tokens, and reading it took about 50 seconds on gemma4:12b on my M1 Max.

Warm-up does both in the background, at session start and whenever you switch models or change the thinking level. It sends the exact beginning of the request your first turn will send and asks for one token back, so Ollama keeps that prompt cached and your first turn only has to read your own message. On that same 12B, the first turn went from 57 seconds to 3.

It can't make the read itself any faster. If you send a message before the warm-up finishes, that turn waits for the rest of it, but never longer than it would have without the warm-up. While it runs, the footer shows a spinner and a timer:

```text
⠹ warming gemma4:12b · reading pi's prompt · 23s
```

Warm-up loads the model as soon as a session starts, which costs memory whether or not you use it. Turn it off with `/ollama-warm-up` (saved across launches) or `OLLAMA_NATIVE_WARM=0`.

---

## Using a remote Ollama with an API key

A plain local Ollama doesn't need a key. This is for an Ollama behind a proxy that checks a bearer token, say a home server you reach over a tailnet or VPN. Set `OLLAMA_API_KEY` and pi-ollama sends it as `Authorization: Bearer <key>` on every request to `OLLAMA_HOST`, and nowhere else. A model pointed at a different server never gets it.

The first time pi starts with a key it hasn't seen for that host, it asks before sending it. The approval stores the host and a fingerprint of the key, never the key itself, so a new host or a new key asks again. Headless modes never send an unapproved key. `/ollama-status` shows whether the key is approved, and never shows the key.

To set it up:

```bash
OLLAMA_HOST=https://ollama.home.example:11434 OLLAMA_API_KEY=your-token pi
```

Approve the key when pi asks. If you answer No, pi runs without it for that session and asks again next time. To stop sending the key, unset `OLLAMA_API_KEY`. To withdraw an approval, delete the `"apiKeyApproval"` line from `~/.pi/agent/cache/pi-ollama-config.json`.

---

## How model discovery works

On extension load, the provider:

1. Calls `GET /api/tags` to list pulled models, then `POST /api/show` for every model at once. Each request has a 5 second timeout, so a stuck Ollama can't hold up pi's startup.
2. From `/api/show`, extracts:
   - Context window from `model_info.*.context_length`.
   - Tool, vision and thinking support from Ollama's `capabilities` list. Name and family guesses are only used when an older Ollama reports no list, because a wrong guess (sending `think` to a model that can't think) gets every request rejected.
   - The model's accepted thinking values from `thinking.values` (Ollama 0.34+), which drive the per-model thinking levels below.
3. Leaves out models Ollama can't chat with, like embedding and image-generation models.
4. Caches the result in `~/.pi/agent/cache/pi-ollama-models.json` for the next startup.

If Ollama can't be reached at startup, the cached list is used instead. Run `/ollama-refresh` once it's available, or let pi start it for you.

## Thinking control

For thinking-capable models, the provider forwards pi's thinking level to Ollama's `think` request field. Thinking off sends an explicit `think: false`. The explicit false is load-bearing - Ollama defaults thinking-capable models (the gemma4 family included) to thinking **on** when the field is omitted, so before this mapping existed, turning thinking off in pi had no effect on the wire and every turn paid the hidden reasoning-token cost (measured ~8× the generated tokens on a short gemma4:12b answer). Models without thinking support never get the field.

What pi offers above off depends on the model. Ollama 0.34 and later report the `think` values each model accepts in `/api/show`, and the extension hands that list to pi, so the thinking-level picker only shows levels the model actually has:

- A model with named levels gets exactly those, and the name goes on the wire unchanged. A model reporting `[false, "low", "medium", "high", "max"]` offers off, low, medium, high and max, and pi's high sends `think: "high"`.
- An on/off model (`[false, true]`, like the gemma4 family) offers off and medium, and medium sends `think: true`. Medium is used because it's pi's default level.
- A model that doesn't report `false` can't switch thinking off, so off isn't offered.
- If your saved level isn't one the model has, pi moves to the nearest one it does have when you switch models.

pi's level names are a fixed set: off, minimal, low, medium, high, xhigh and max. A value outside that set can't be offered without inventing a label for it, so it's left out. That includes a bare `true` listed next to named levels, where the named levels already cover "on". `/ollama-info <model>` shows the levels a model gets and lists anything left out.

On older Ollama servers that don't report thinking values, every level sends `think: true` as before. After upgrading Ollama, run `/ollama-refresh` so the cached model list picks the values up.

---

## Reliability features

Ollama's streaming has a few known edge cases. The provider handles them explicitly rather than letting them surface as silent stalls:

**Ghost-token retry.** Ollama occasionally generates output tokens but streams nothing visible (`done:true`, `eval_count > 0`, empty message). The provider reads the first NDJSON line of each attempt, detects this pattern, cancels the connection, and retries. Up to `OLLAMA_NATIVE_GHOST_RETRIES` times (default 2 → ≈99% success at typical failure rates).

**Truncation detection.** If the connection closes before any chunk with `done:true` arrives, the provider surfaces a clear error rather than silently treating the partial response as complete. The error explains this is an Ollama-side reliability issue and prompts a retry.

**Empty-response detection.** If the connection closes without sending any chunks at all, the provider raises a distinct error pointing at the most likely causes (model failed to load, Ollama crashed, network issue).

**Post-stream ghost check.** Belt-and-suspenders: if `eval_count > 0` but no content, thinking, or tool calls landed in the parsed stream, the provider raises an error rather than reporting a successful empty turn.

**Swallowed-tool-call detection.** Ollama can buffer a tool call server-side, fail to parse it, and end the turn with no `tool_calls` on the wire - the model announces an action and then nothing happens (issue #3). The guard detects the generated≫streamed token gap and raises a retryable error instead of completing silently. It stands down on batched streams (Ollama Cloud emits ~30 tokens per NDJSON chunk vs ~1 locally), which previously false-positived the ratio heuristic on healthy cloud turns (issue #4).

**Readable errors.** When Ollama refuses a request, the error says what Ollama said, not just the HTTP status: a missing model, a rejected key, a context overflow.

## Vision

For vision-capable models, images pass through from **both** user messages and **tool results** as base64 `images` arrays on the wire - a tool that returns a camera frame or screenshot reaches the model directly on its tool message (verified against gemma4). Models without vision never receive image data.

---

## Generation speed (tok/s)

While a response streams, pi's footer shows a live estimate, and when the generation finishes it is replaced by the exact figure:

```text
≈46 tok/s                  <- while streaming (estimate)
47.3 tok/s · 612 tok       <- when done (Ollama-reported)
```

The two numbers come from different places, and the `≈` is there so you can tell which one you're looking at.

**The final figure is Ollama's own.** It is `eval_count / eval_duration` from the last chunk of the response - tokens generated over the time spent generating them. Model load and prompt evaluation aren't in it, so it is the number to quote when comparing rigs or models.

**The live figure is an estimate.** Ollama doesn't report token counts mid-stream, so the extension counts streamed characters (text and thinking), converts them at roughly 4 characters per token, and measures over the last couple of seconds rather than from the start of the request. After each completed generation it compares Ollama's real token count against the characters it saw and adjusts the ratio for that model, smoothed so one odd response can't throw it. So the estimate gets closer to the final figure over the first several turns with a model. The calibration lives in memory only and starts fresh each launch. Turns that end in a tool call don't calibrate, because tool-call tokens never stream as characters.

If a generation fails, is cancelled, or the server doesn't send the metrics, the footer clears - it never invents a number.

**Session history.** Each completed generation is appended to the pi session as a custom entry (`pi-ollama-generation`). Custom entries are not sent to the model, so this costs no context. `/ollama-stats` reads them back:

```text
Model: gemma4:12b
  Last: 47.3 tok/s
  Session avg: 45.9 tok/s
  Fastest: 51.2 tok/s
  Generated: 8,491 tok
  Generations: 14
```

The session average is total tokens over total generation time, not the mean of the per-turn rates, so a long generation counts for more than a one-line reply. A "generation" is one model response - an agent turn that calls three tools is four of them.

Nothing here writes files while streaming, and nothing in it can fail a turn: the provider only reports what happened, and every display or storage call is best-effort. Set `OLLAMA_NATIVE_THROUGHPUT=0` to turn it all off.

Thanks to [@TRex22](https://github.com/TRex22) for the feature request (#10).

---

## Compatibility

- **pi**: Tested against `@earendil-works/pi-coding-agent` v0.87.x, and works back to v0.75.5. pi 0.86 moved the system prompt and tool declarations out of the request context and into the conversation transcript (gh#11); pi-ollama reads both shapes, so older versions keep working. Should work with any version exposing the standard `ExtensionAPI` (`registerProvider` with `streamSimple`, `registerCommand` with `ctx.ui.notify`). The footer displays, session records, startup prompts and warm-up use `pi.on`, `ctx.ui.setStatus`, `ctx.ui.select` and `pi.appendEntry`; on a pi without them those parts quietly do nothing. On a pi that can't report its system prompt, warm-up loads the model weights only.
- **Ollama**: Requires Ollama with `/api/chat` support (most versions). Overflow handling needs 0.12.5+, and per-model thinking levels need 0.34+. `/api/ps` is used opportunistically and tolerates older versions that don't expose it.
- **Starting Ollama**: macOS needs the Ollama app installed; Linux needs the `ollama` binary. Other platforms don't get the offer.
- **Node**: Requires Node 22.19+.

---

## Architecture (one paragraph)

The extension registers an `ollama` provider with a custom `streamSimple` handler. Pi calls `streamSimple(model, context, options)` for every turn; the handler converts pi's message format to an Ollama `/api/chat` request (in one place, `buildTurnRequest`, which the warm-up reuses so its prefix matches exactly), opens an NDJSON stream, parses chunks into pi's `AssistantMessageEventStream` events (text deltas, thinking deltas, tool-call bursts, done), and surfaces errors with explanatory messages. Every request to Ollama goes through `src/ollama-client.ts`, which owns timeouts, auth and error text. No core pi changes required - `streamSimple` fully replaces the built-in handler for the registered API string.

See [src/](./src/) for the implementation. Each file has a header comment explaining its role.

---

## Development

```bash
npm install
npm test         # vitest - behavior tests through each module's public interface,
                 # with the network and processes stubbed at the boundary, plus
                 # parity tests against pi-ai's own helpers
npm run check    # tsc --noEmit
```

No build step - pi loads the TypeScript source directly. Both commands should pass clean before any PR; the test suite grows one construct at a time, so a behavior fix should arrive with the test that would have caught it. Issues and PRs welcome - a couple of the recent fixes started as community reports, and that's exactly how this is supposed to work.

---

## Limitations / not yet implemented

- **Ollama Cloud (`https://ollama.com`) directly.** Not tested. `OLLAMA_API_KEY` may be enough for it, but this extension is built and tested for local and self-hosted Ollama. A local Ollama signed in with `ollama signin` already serves `:cloud` models without a key. For cloud-only use, see [`fgrehm/pi-ollama-cloud`](https://github.com/fgrehm/pi-ollama-cloud).
- **Per-model `temperature` / `top_p` defaults.** Sampling parameters are passed through from pi's options when set, but there's no extension-level config for default values per model. Open an issue if you need this.
- **Auto-pull.** If you select a model that isn't pulled, you'll get an error from Ollama. The extension doesn't offer to `ollama pull` it for you.

---

## Related projects

- **[pi](https://github.com/earendil-works/pi)** - the pi coding agent itself
- **[pi#3357](https://github.com/earendil-works/pi/issues/3357)** - the open issue requesting an official local-LLM extension
- **[`@jamesjfoong/pi-ollama`](https://github.com/jamesjfoong/pi-ollama)** - auto-discovery, per-model fixes and setup for Ollama through pi's built-in OpenAI-compatible route
- **[`@0xkobold/pi-ollama`](https://github.com/0xKobold/pi-ollama)** - alternative extension covering local + cloud via the OpenAI-compatible route
- **[`fgrehm/pi-ollama-cloud`](https://github.com/fgrehm/pi-ollama-cloud)** - cloud-only Ollama extension

---

## License

[MIT](./LICENSE) © 2026 CaptCanadaMan
