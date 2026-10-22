# progrok

[![npm version](https://img.shields.io/npm/v/progrok.svg)](https://www.npmjs.com/package/progrok)
[![license: MIT](https://img.shields.io/badge/license-MIT-16a085.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-4cc9a6.svg)](https://lidge-jun.github.io/progrok/)
[![node](https://img.shields.io/badge/node-%3E%3D22-2d3748.svg)](./package.json)

Activate your xAI Grok OAuth session as a local API and tool surface.

`progrok` is an OAuth bridge for Grok. It signs in with your xAI account, stores
a refreshable local OAuth session, and activates that session through four
developer-facing surfaces:

1. a native localhost xAI bridge that parses and renders HTTP/SSE contracts for
   `/v1/*`, provides typed clients for direct xAI WebSockets, and retains
   verified binary/multipart passthroughs;
2. direct CLI commands for Grok workflows that need source selection, JSON
   output, async polling, local files, voice, or machine-readable metadata;
3. typed clients for the REST surface and direct Responses/Voice WebSockets;
4. a local web app that combines same-origin HTTP with browser-direct Voice
   connections without exposing the OAuth token to browser code.

The point is not only "no API key." The point is that Hermes Agent, OpenClaw,
and Grok Build-style coding workflows all rely on the same xAI OAuth credential
lineage: the xAI account session is the authority, and local tools need a way to
turn that session into a programmable endpoint. progrok is that activation tool.
Point the OpenAI SDK, curl scripts, or agent tools at `127.0.0.1:18645` and let
progrok inject the real xAI bearer token locally.

> Requires an active SuperGrok subscription. progrok does not bypass xAI account
> access, quotas, pricing, or product limits.

## Links

- Live docs: [lidge-jun.github.io/progrok](https://lidge-jun.github.io/progrok/)
- OAuth bridge: [lidge-jun.github.io/progrok/docs/concepts/oauth-bridge](https://lidge-jun.github.io/progrok/docs/concepts/oauth-bridge)
- Quick start: [lidge-jun.github.io/progrok/docs/quickstart](https://lidge-jun.github.io/progrok/docs/quickstart)
- npm: [npmjs.com/package/progrok](https://www.npmjs.com/package/progrok)
- Repository: [github.com/lidge-jun/progrok](https://github.com/lidge-jun/progrok)

## Why OAuth

xAI account access is session-based in the tools that made this workflow
useful. Hermes Agent and OpenClaw document the shared xAI OAuth client
identifier used by progrok, and Grok Build-style coding workflows benefit from
the same model: authenticate once with the xAI account, then expose Grok to
developer tooling through a local API surface.

That changes the shape of the problem:

- the user account and subscription decide what models and tools are available;
- the local machine holds the refreshable credential;
- existing SDKs and agents expect a base URL plus an API key;
- Grok media, search, and model discovery need more workflow glue than a raw
  HTTP proxy provides.

progrok handles that glue. It activates the OAuth credential as a proxy for
OpenAI-compatible clients and as direct commands for search, images, video,
models, and capability discovery.

## What "activation tool" means

After `progrok login`, the stored OAuth session powers every surface below:

| Surface | Command or URL | What gets activated |
| --- | --- | --- |
| OpenAI-compatible API | `http://127.0.0.1:18645/v1/*` | Chat, Responses, reasoning, structured output, server-side tools, files, batches, and other HTTP xAI API paths your account can access. |
| Current search | `progrok search` | Grok Responses with web search, X search, citations, JSON output, and optional reasoning effort. |
| Image workflows | `progrok image` | Imagine generation and editing with local reference files and output handling. |
| Video workflows | `progrok video` | Async video submission, polling, progress display, and download handling. |
| Coding models | `grok-build-0.1`, `grok-composer-2.5-fast` through the proxy | Grok Build and Composer coding work from clients that can point at a local OpenAI-compatible endpoint. |
| Agent discovery | `progrok capabilities --json` | Machine-readable ports, commands, models, endpoints, and auth requirements. |
| Voice CLI | `progrok tts`, `progrok stt`, `progrok live` | REST synthesis/transcription and a direct Realtime NDJSON bridge using the same OAuth session. |
| Responses WebSocket | `wss://api.x.ai/v1/responses` | Direct typed Responses session with server-side bearer auth. |
| Voice WebSockets | `wss://api.x.ai/v1/realtime`, `wss://api.x.ai/v1/stt`, `wss://api.x.ai/v1/tts` | Direct realtime speech, streaming transcription, and streaming synthesis with server-side bearer auth. Browser ephemeral auth is verified for realtime and STT only; mint a new one-use secret for every connection and reconnect. |
| Local web app | `http://127.0.0.1:18646` | Same-origin HTTP plus direct xAI Voice WebSockets without exposing OAuth tokens to browser code. |

The placeholder `OPENAI_API_KEY` or `Authorization` value is only there to
satisfy client libraries. progrok replaces it before forwarding the request.

## Install

```bash
npm install -g progrok
```

## Quick Start

```bash
# 1. Activate your xAI OAuth session.
progrok login

# `login` shows a URL and a code by default, which also works over SSH.
# On a desktop you can let it open the browser instead:
progrok login --browser

# 2. Start the OpenAI-compatible local proxy.
progrok proxy

# 3. Call Grok through localhost.
curl http://127.0.0.1:18645/v1/chat/completions \
  -H "Authorization: Bearer anything" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Hello"}]}'
```

The proxy replaces the placeholder `Authorization` value with your stored xAI
OAuth bearer token before forwarding the request. The API key value in your
client can be any non-empty placeholder.

For direct tool activation, the proxy process is optional:

```bash
progrok search --x --json "Grok Build release discussion"
progrok image "a precise product diagram of an OAuth bridge CLI" --output ./out
progrok video "a local proxy turning on Grok tools" --duration 5
progrok tts "Hello from Grok" --output hello.mp3
progrok stt meeting.wav --json
progrok live --event '{"type":"session.update","session":{"voice":"eve"}}' --once
progrok chat
progrok models --detail
progrok capabilities --json
```

## OpenAI SDK Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:18645/v1",
    api_key="anything",
)

result = client.chat.completions.create(
    model="grok-4.6",
    messages=[{"role": "user", "content": "Explain MCP in 5 bullets"}],
)

print(result.choices[0].message.content)
```

Shell configuration for tools that respect OpenAI-compatible environment
variables:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18645/v1
export OPENAI_API_KEY=anything
```

## Use Grok as a "local model" (LM Studio / Ollama emulation)

Some tools only let you plug in a *local* model server. JetBrains AI Assistant
offers "LM Studio" and "Ollama" as its local providers, and Junie CLI has a
one-click "LM Studio" / "Ollama" entry under custom models. progrok can stand
in for either server, backed by your SuperGrok OAuth session:

```bash
progrok proxy --lmstudio            # LM Studio API on http://127.0.0.1:1234
progrok proxy --ollama              # Ollama API on http://127.0.0.1:11434
progrok proxy --lmstudio --ollama   # both, plus the usual :18645
progrok proxy --lmstudio 4321 --no-openai   # custom port, LM Studio listener only
```

Each extra listener still forwards every `/v1/*` path like the normal proxy,
and additionally answers the server's native API:

| Emulated server | Native endpoints served | Notes |
| --- | --- | --- |
| LM Studio (`--lmstudio`, port 1234) | `GET /v1/models`, `GET /api/v0/models`, `GET /api/v0/models/{model}`, `GET /api/v1/models`, `POST /api/v0/chat/completions`, `POST /api/v0/completions`, `POST /v1/completions`, `POST /api/v0/embeddings` | Chat is OpenAI SSE, same as LM Studio. LM Studio-only knobs (`max_tokens: -1`, `ttl`, `top_k`, `min_p`, `repeat_penalty`, `draft_model`) are dropped before forwarding. Legacy text completions (IDE inline completion) are served through Chat Completions, with `suffix` turned into a fill-in-the-middle prompt. |
| Ollama (`--ollama`, port 11434) | `GET /`, `GET /api/version`, `GET /api/tags`, `GET /api/ps`, `GET /v1/models`, `POST /api/show`, `POST /api/chat`, `POST /api/generate` | Streams newline-delimited JSON like Ollama. Tool calls arrive whole with object `arguments`; `images` become image parts; `options` map to `temperature`/`top_p`/`seed`/`stop`/`max_tokens`; `format` maps to `response_format`; `thinking` is returned when the request sets `think`. |

Both listeners also serve the agent-facing surfaces coding agents use, with
tool calling and reasoning:

| Route | What works |
| --- | --- |
| `POST /v1/chat/completions` (+ LM Studio `/api/v0/chat/completions`) | Multi-turn tool calling: `tools`, `tool_choice`, `parallel_tool_calls`, parallel tool-call deltas, `finish_reason: "tool_calls"`, assistant `tool_calls` + `role:"tool"` history, `response_format` (JSON schema). Reasoning streams as `reasoning_content` **and** `reasoning`; assistant `reasoning_content` / `reasoning` / leading `<think>` sent back in history is forwarded to xAI as `reasoning_content`. Only fields xAI accepts are forwarded; `stop` / penalties are dropped for reasoning models. |
| `POST /v1/responses` | Relayed verbatim (reasoning items, `function_call` items, `previous_response_id`). With `store:false`, `include: ["reasoning.encrypted_content"]` is added so reasoning survives across stateless turns. |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages API translated to Chat: `tool_use` / `tool_result`, `thinking` blocks (stream + non-stream), `thinking.budget_tokens` / `output_config.effort` → effort. |
| `POST /api/v1/chat` (LM Studio) | LM Studio REST v1 chat: stateful via `response_id` / `previous_response_id`, `reasoning` off/low/medium/high/on, `reasoning.*` / `message.*` stream events. MCP `integrations` are rejected. |
| `POST /api/chat` (Ollama) | `tools` + `tool_calls` (object arguments), tool results by `tool_name` or `tool_call_id`, `think: true/false/"low"/"medium"/"high"`, `thinking` in history. |

Reasoning controls in any dialect (`reasoning_effort`, `reasoning: {effort}` or
`"off".."high"`, `think`, `thinking: {budget_tokens}`,
`chat_template_kwargs.enable_thinking`) become xAI `reasoning_effort` on models
that take it (grok-4.5/4.6/4.7, multi-agent; extend with
`PROGROK_REASONING_EFFORT_MODELS=<regex>`) and are dropped elsewhere. Grok
cannot switch reasoning off, so "off" means `low` and the reasoning is hidden.
Choose how reasoning is returned on Chat Completions with
`--reasoning-format both|reasoning_content|reasoning|think-tags|none` (or
`PROGROK_REASONING_FORMAT`). `PROGROK_STRIP_REASONING_HISTORY=1` stops sending
past reasoning back to xAI.

Model lists contain only chat models from your live catalog (Imagine and voice
models are hidden; a pinned list is used if the catalog cannot be read). Add
unlisted models with `PROGROK_LOCAL_EXTRA_MODELS=grok-composer-2.5-fast`.
Model names such as `grok-4.6:latest` or `xai/grok-4.6` are accepted. No API key
is required on these listeners; they bind to `127.0.0.1` by default.

### Junie CLI

1. `progrok proxy --lmstudio`
2. In Junie run `/account` → **Custom models and endpoints** → **LM Studio**,
   keep the base URL `http://localhost:1234` (host and port only).
3. `/model` and pick e.g. `grok-build-0.1` or `grok-4.6`.

Junie discovers models from `GET /v1/models` and chats on
`POST /v1/chat/completions` with tool calls. The Ollama entry works the same
way with `--ollama` and `http://localhost:11434`. A manual profile in
`~/.junie/models/grok.json` also works:

```json
{ "baseUrl": "http://localhost:1234/v1/chat/completions", "id": "grok-build-0.1", "apiType": "OpenAICompletion" }
```

`"apiType": "OpenAIResponses"` with `http://localhost:1234/v1/responses` keeps
encrypted reasoning across turns; `"apiType": "Anthropic"` with
`http://localhost:1234/v1/messages` uses the Messages translation.

### JetBrains AI Assistant

1. `progrok proxy --lmstudio` (or `--ollama`).
2. **Settings | Tools | AI Assistant | Providers & API keys** → Third-party AI
   providers → Provider **LM Studio**, URL `http://localhost:1234` (or
   **Ollama**, `http://localhost:11434`) → **Test Connection**.
3. Under **Models Assignment**, pick Grok models for chat, completion and other
   features. Raise the context window if you want more than the 64K default.

JetBrains documents that AI Assistant does not call MCP tools and its agents do
not use local models, so with these providers Grok is used for AI Chat and
AI Assistant features. For agent use with tools, use Junie CLI or the
OpenAI-compatible provider at `http://127.0.0.1:18645/v1`.

## Commands

| Command | Use it for |
| --- | --- |
| `progrok login` | Device-code OAuth login: prints a URL and a code. Works over SSH. |
| `progrok login --browser` | PKCE login that opens a browser and waits on `127.0.0.1:56121`. |
| `progrok login --manual-paste` | PKCE login where you paste the callback code by hand. |
| `progrok logout` | Remove stored local credentials. |
| `progrok status` | Check whether a local OAuth session exists. |
| `progrok proxy` | Start the local OpenAI-compatible proxy on `127.0.0.1:18645`. |
| `progrok proxy --lmstudio [port]` | Also impersonate an LM Studio server (default `:1234`) for JetBrains AI Assistant / Junie. |
| `progrok proxy --ollama [port]` | Also impersonate an Ollama server (default `:11434`). |
| `progrok proxy --verbose` (`-v`) | Log every request on stderr: what the client sent, the call to `api.x.ai`, xAI's status/latency/usage/finish reason, and what the client got. Same as `PROGROK_LOG=1`. |
| `progrok proxy --log-bodies` | Same plus redacted request/response bodies (`PROGROK_LOG=bodies`, cap with `PROGROK_LOG_MAX_BODY`). |
| `progrok proxy --usage-every 30m` / `--no-usage` | Subscription usage line on stderr (on by default): ~10s after the first request, then every 5m while requests reach xAI; silent when idle. `PROGROK_USAGE_EVERY=30m` / `off`. |
| `progrok proxy --lmstudio --reasoning-format think-tags` | Inline reasoning as `<think>…</think>` for clients that ignore `reasoning_content`. |
| `progrok chat` | Open the local workspace on `127.0.0.1:18646`: chat, live voice, and media. |
| `progrok models --detail` | List model aliases, pricing, context windows, and media models. |
| `progrok search <query>` | Search web and X sources through Grok Responses tools. |
| `progrok search <query> --web` | Restrict search to web sources. |
| `progrok search <query> --x` | Restrict search to X sources. |
| `progrok search <query> --reasoning high` | Add reasoning effort to a search request. |
| `progrok image <prompt>` | Generate an Imagine image. |
| `progrok image <prompt> --ref ./input.png` | Edit or compose from a reference image. |
| `progrok video <prompt>` | Text-to-video generation. |
| `progrok video <prompt> --image ./input.png` | Image-to-video (animate still image). |
| `progrok video edit <prompt> --video <url>` | Edit existing video with text (real V2V). `grok-imagine-video` only. |
| `progrok video extend <prompt> --video <url>` | Continue video from last frame. `grok-imagine-video` only. |
| `progrok billing` | Show subscription plan, usage, and remaining quota. |
| `progrok billing --json` | Machine-readable billing and usage data. |
| `progrok tts <text>` | Synthesize speech to a file or raw stdout. |
| `progrok stt <file>` | Transcribe a local audio file; supports language hints, diarization, multichannel audio, and repeatable key terms. |
| `progrok live` | Bridge direct Realtime events over NDJSON stdin/stdout; it does not capture the microphone. |
| `progrok capabilities --json` | Print machine-readable command, model, and endpoint metadata. |
| `progrok skill` | Print an agent-oriented usage guide. |

## Native Search

`progrok search` calls xAI's Responses API directly with `web_search` and
`x_search` tools. It does not require the proxy process to be running because it
loads the same OAuth session directly.

```bash
progrok search "latest Astro release"
progrok search --web "Node.js 22 features"
progrok search --x "grok API launch"
progrok search --json "rust async traits"
progrok search --model grok-4.20-multi-agent-0309 --reasoning xhigh \
  "compare current open-source browser automation tools"
```

Reasoning effort values: `none`, `low`, `medium`, `high`, `xhigh`.

## Image and Video

Image generation:

```bash
progrok image "a crisp terminal UI product shot for a CLI called progrok"
progrok image "make this diagram cleaner" --ref ./diagram.png --output ./out
```

Video generation:

```bash
# Text-to-video
progrok video "a terminal command expanding into a network diagram"

# Image-to-video (animate a still image)
progrok video "turn this interface into a smooth product demo" --image ./screen.png

# Reference-to-video (guide the scene with up to 7 images, max 10s)
progrok video "put this character in a quiet terminal workspace" \
  --ref ./character.png --ref ./workspace.png --duration 6

# Video editing — modify existing video, keep motion (grok-imagine-video only)
progrok video edit "Make the background a sunset sky" --video ./clip.mp4

# Video extension — continue from last frame (grok-imagine-video only)
progrok video extend "Camera slowly pulls back revealing the full scene" \
  --video file_id:file-abc123 --duration 5
```

### Model constraints

| Model | T2V | I2V | Ref2V | Edit | Extend |
|-------|:---:|:---:|:-----:|:----:|:------:|
| `grok-imagine-video` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `grok-imagine-video-1.5` | ❌¹ | ✅ | ❌¹ | ❌ | ❌ |

¹ xAI's model page describes text+image input, but live OAuth smoke returned
`Text-to-video is not supported for this model` for prompt-only T2V and
``reference_images` is not supported for this model` for Ref2V. progrok treats
1.5-preview as I2V-only until the API changes.

### Video API surface map

| Surface | CLI | REST canonical shape | Status |
| --- | --- | --- | --- |
| Text-to-video | `progrok video "<prompt>"` | `prompt` only on `/v1/videos/generations` | Supported |
| Image-to-video | `--image <file|url|data|file_id:id>` | `image: {url | file_id}` | Supported |
| Reference-to-video | `--ref <input>` repeatable | `reference_images: [{url | file_id}]` | Supported, max 7 refs, max 10s |
| Edit video | `progrok video edit ... --video <input>` | `video: {url | file_id}` on `/v1/videos/edits` | Supported on base model |
| Extend video | `progrok video extend ... --video <input>` | `video: {url | file_id}` on `/v1/videos/extensions` | Supported on base model |
| Duration alias | `--seconds <s>` | `seconds` instead of `duration` | OpenAI-compat alias |
| Signed output target | `--upload-url <url>` | `output: {upload_url}` | Exposed for signed PUT destinations |

`mode: "edit-video"` / `"extend-video"` / `"reference-to-video"` is a Vercel
AI SDK provider option, not a direct REST selector. Live REST smoke accepted a
stray `mode` field but treated the request as ordinary T2V.

### Live smoke verdicts

| Probe | Result |
| --- | --- |
| T2V, I2V, R2V on `grok-imagine-video` | Passed, `status: done` |
| Edit/extend by source URL | Passed, `status: done` |
| `file_id` image/video input | Passed for I2V, R2V, edit, and extend |
| `seconds` alias | Passed |
| `image_url` REST alias | Passed |
| `output.upload_url` | Passed with a public PUT endpoint; result `video.url` equals the upload URL |
| `video_url` REST alias | Failed with `422 missing field video`; use `video: {url}` |
| `1080p` | Failed for this team: `1080p video resolution is not available for your team` |
| `grok-imagine-video-1.5` | I2V passed; prompt-only T2V and Ref2V failed |

### Video editing/extension constraints

- **Input**: `.mp4` (H.264/H.265/AV1), max 8.7s (edit) or 2–15s (extend)
- **`--image`, `--ref`, `--video`**: local file, HTTPS URL, data URI, or
  `file_id:<id>`
- **Mutual exclusion**: `--image` and `--ref` cannot be combined; xAI returns
  `400 Bad Request`
- **Edit output**: Same duration/aspect/resolution as input (max 720p)
- **Extend duration**: 2–10s (default 6s), added to original
- **Model**: `grok-imagine-video` only — 1.5-preview returns "not supported"
- **Unsupported knobs**: edit ignores/rejects duration/aspect/resolution;
  extend ignores/rejects aspect/resolution; 1080p appears in one REST schema
  but current model/docs/pricing pages only confirm 480p/720p

Media commands call xAI endpoints directly with your OAuth session and poll async
jobs until completion.

## Proxy Coverage

The proxy forwards every HTTP `/v1/*` path to `api.x.ai`, so it can activate the
xAI API surface available to your account:

- Chat Completions and Responses
- reasoning, citations, structured output, and tool calls
- image generation and editing
- video generation, editing, extension, and polling
- text-to-speech, speech-to-text, and realtime client-secret minting
- files, batches, tokenizer, models, and collection search

The localhost server handles HTTP only and does not accept WebSocket upgrades.
Node and browser clients connect directly to these xAI endpoints:

- `wss://api.x.ai/v1/responses` for serial Responses requests on one connection;
- `wss://api.x.ai/v1/realtime` for native speech-to-speech;
- `wss://api.x.ai/v1/stt` for streaming transcription;
- `wss://api.x.ai/v1/tts` for streaming synthesis.

Server-side clients authenticate those sockets with the stored bearer. A browser
must use the same-origin flow for realtime or STT: call
`POST /v1/realtime/client_secrets`, create one socket with the returned secret
as the single `xai-client-secret.<token>` WebSocket subprotocol, then discard the
secret. A secret is consumed by one connection, so every reconnect must mint a
new one; never cache or reuse it. Browser ephemeral auth has not been verified
for `/v1/tts`, so TTS WebSocket documentation guarantees server-side bearer auth
only.

## Models

Your account decides what `/v1/models` returns. The table below is what a
SuperGrok session returned on 2026-09-19; treat `progrok models --json` as the
source of truth, not this page.

| Model | Best for | Context | Notes |
| --- | --- | --- | --- |
| `grok-4.6` | Default chat, tools, search, vision | 500K | `DEFAULT_MODEL`. Pricing below. |
| `grok-4.5` | Previous frontier text model | 500K | Still served. |
| `grok-4.3` | Older text model | 200K+ | Cheaper tier. |
| `grok-build-0.1` | Fast agentic coding | 256K | Good default for Grok Build-style coding tools through the OAuth proxy. |
| `grok-4.20-0309-reasoning` | Deep reasoning | 200K+ | Legacy reasoning model. |
| `grok-4.20-0309-non-reasoning` | Lower-latency text | 200K+ | Legacy non-reasoning model. |
| `grok-4.20-multi-agent-0309` | Deep research | 200K+ | Supports high and xhigh effort. |
| `grok-imagine-image` | Image generation and editing | - | $0.002/input image; $0.02/output image. |
| `grok-imagine-image-2.0` | Current Imagine image model | - | Returned by the live catalog. |
| `grok-imagine-image-quality` | Higher-quality image output | - | $0.01/input image; $0.05 (1K) or $0.07 (2K) output image. |
| `grok-imagine-video` | Video: T2V, I2V, Ref2V, Edit, Extend | - | $0.002/input image, $0.01/input video sec; $0.05/sec (480p), $0.07/sec (720p). |
| `grok-imagine-video-1.5` | Video: I2V only in live smoke; no native T2V/Ref2V/Edit/Extend | - | $0.01/input image; $0.08/sec (480p), $0.14/sec (720p). |

### Not in `/v1/models`

These are reachable but the catalog does not list them, so `progrok models`
will not show them.

| Model | Best for | Notes |
| --- | --- | --- |
| `grok-composer-2.5-fast` | Agentic code composition | Live on `/v1/chat/completions`; supports `reasoning_content`. May need team-level access. |
| `grok-voice-latest` | Rolling Voice alias, `progrok live` default | Realtime voice models are not catalog entries. Pin a dated build for reproducibility. |

Text pricing for `grok-4.6` is $2.00 per 1M input tokens and $6.00 per 1M output
tokens, from [docs.x.ai/developers/models](https://docs.x.ai/developers/models)
as of 2026-09-19. progrok is not the source of truth for pricing; xAI can change it.

Run the live metadata command before relying on a model in automation:

```bash
progrok models --detail
progrok capabilities --json
```

## How It Works

```text
OpenAI client, coding agent, curl script, or local web app
  -> http://127.0.0.1:18645/v1/* (or same-origin :18646/v1/*)
  -> parse known JSON requests into canonical request IR
  -> progrok loads/refreshes ~/.progrok/auth.json and injects the bearer
  -> https://api.x.ai/v1/*
  -> reduce known SSE streams into typed events
  -> render the client protocol; relay verified binary/multipart paths unchanged
```

Credentials are stored locally at `~/.progrok/auth.json` and refreshed before
expiry. Treat that file like any other account credential.

The direct command path is similar but skips the proxy server:

```text
progrok search / image / video / tts / stt / live / models / capabilities
  -> load the same local OAuth session
  -> call the relevant xAI endpoint
  -> add CLI-specific behavior such as polling, files, or JSON output
```

WebSocket clients skip the localhost proxy:

```text
server client -> stored bearer -> wss://api.x.ai/v1/{responses,realtime,stt,tts}
browser -> same-origin POST /v1/realtime/client_secrets
        -> fresh one-use xai-client-secret.<token> subprotocol
        -> wss://api.x.ai/v1/{realtime,stt}
```

## Relationship to Hermes Agent, OpenClaw, and Grok Build

progrok's OAuth client attribution comes from Hermes Agent and OpenClaw under
their MIT licenses. Those projects demonstrated the important part: Grok can be
made useful to local developer tools through xAI OAuth rather than through a
manually provisioned API key.

progrok takes that pattern and packages it as a focused bridge:

- Hermes Agent and OpenClaw establish the shared OAuth client lineage.
- Grok Build-style workflows need a coding model reachable from agent tools.
- progrok provides the localhost OpenAI-compatible endpoint and direct commands
  that let those tools use the same authenticated account session.

This is why the documentation describes progrok as an activation tool. Login is
the authorization step; the proxy and CLI commands are the activated surfaces.

ima2-gen v3.16.1 no longer bundles or supervises progrok. It calls xAI directly;
the two tools only share the path and schema of `~/.progrok/auth.json`.

## 3.0.0 migration: capabilities schema v2

`progrok capabilities --json` now emits `schemaVersion: 2`. Its `commands`
property is a `CommandManifestEntry[]`, not a string array:

```json
{
  "schemaVersion": 2,
  "commands": [
    {"name":"tts","summary":"Synthesize speech to a file or stdout.","mutatesRemote":true,"json":true}
  ]
}
```

Consumers written for schema v1 must read names with
`capabilities.commands.map((entry) => entry.name)`. `COMMAND_MANIFEST` owns the
command entries and `SURFACE_REGISTRY` owns endpoint metadata. Existing command
names and localhost HTTP routes remain, but the JSON shape change is the 3.0.0
breaking boundary.

## Security Notes

- The proxy binds to localhost by default.
- Do not expose the proxy port to a public network without adding your own access
  controls.
- The placeholder API key sent by OpenAI-compatible clients is ignored by the
  proxy and replaced with your xAI OAuth token.
- `progrok logout` removes the local credential file.
- Requests are forwarded to xAI. Sensitive prompt data should be handled under
  the same policy you use for direct xAI API usage.
- The OAuth file enables account-backed access. Do not commit it, sync it to
  untrusted machines, or share it between users.
- Ephemeral client secrets are one-connection credentials. Keep them in memory,
  pass them only as the WebSocket subprotocol, and mint a new secret for every
  connection and reconnect.

## Troubleshooting

### `progrok status` says no session

Run `progrok login` again. It prints a URL and a code, so it works over SSH as-is;
add `--browser` on a desktop to open the browser instead.

### The proxy starts but clients fail

Check that the client points to:

```bash
http://127.0.0.1:18645/v1
```

Also check that the client sends a non-empty API key placeholder.

### Port 18645 is already in use

Stop the existing process or start the proxy on another port if your version
supports a port flag. Then update `OPENAI_BASE_URL` accordingly.

### Port 1234 or 11434 is already in use

A real LM Studio or Ollama is probably running. Stop it, or pick another port
(`progrok proxy --lmstudio 1235`) and enter that URL in the IDE.

### A model returns 404 or 400

Run:

```bash
progrok models --detail
```

Model aliases and preview names can change. Use the live list before scripting a
long-running workflow.

### Search, image, or video commands fail

These commands call xAI directly with OAuth and may be subject to product access,
rate limits, quota, and account capability. Start with:

```bash
progrok status
progrok capabilities --json
```

## License

MIT. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for OAuth client
attribution.
