import { once } from "node:events";
import express, { type Request, type Response } from "express";
import { PayloadTooLargeError, readBoundedBody } from "./body.js";
import {
  collectLocalChat,
  LocalUpstreamError,
  openLocalChatStream,
  parseToolArguments,
  promptText,
  promptToMessages,
  type ChatStreamItem,
  type CollectedChat,
} from "./local-chat.js";
import {
  LocalModelCatalog,
  normalizeLocalModelId,
  openAiModelList,
  type LocalCatalogDeps,
  type LocalModel,
} from "./local-models.js";
import { safeErrorMessage } from "./redact.js";

/**
 * Ollama-compatible surface (default port 11434).
 *
 * JetBrains AI Assistant's "Ollama" provider, and many editor plugins, speak
 * Ollama's native API rather than OpenAI's: `GET /api/tags` to list models,
 * `POST /api/show` for model details and capabilities, `POST /api/chat`
 * for chat and `POST /api/generate` for completion, both streaming
 * newline-delimited JSON. This module translates those to xAI Chat
 * Completions. Ollama's own OpenAI-compatible `/v1/*` paths are still served
 * by the regular proxy route on the same listener.
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

/** Advertised Ollama version; clients gate features such as tools on it. */
export const OLLAMA_COMPAT_VERSION = "0.12.6";

const MODIFIED_AT = "2026-01-01T00:00:00Z";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function details(): Json {
  return {
    parent_model: "",
    format: "gguf",
    family: "grok",
    families: ["grok"],
    parameter_size: "",
    quantization_level: "",
  };
}

function tagEntry(model: LocalModel): Json {
  return {
    name: model.id,
    model: model.id,
    modified_at: MODIFIED_AT,
    size: 0,
    digest: "",
    details: details(),
  };
}

function capabilities(model: LocalModel): string[] {
  const out = ["completion", "tools"];
  if (model.vision) out.push("vision");
  if (model.reasoning) out.push("thinking");
  return out;
}

function showBody(model: LocalModel): Json {
  return {
    license: "",
    modelfile: `FROM ${model.id}\n`,
    parameters: "",
    template: "{{ .Prompt }}",
    details: details(),
    model_info: {
      "general.architecture": "grok",
      "general.basename": model.id,
      "general.parameter_count": 0,
      "grok.context_length": model.contextLength,
    },
    capabilities: capabilities(model),
    modified_at: MODIFIED_AT,
  };
}

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ error: message });
}

async function readJson(req: Request, res: Response): Promise<Json | undefined> {
  let body: Buffer;
  try {
    body = await readBoundedBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendError(res, 413, error.message);
      return undefined;
    }
    throw error;
  }
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  sendError(res, 400, "invalid JSON body");
  return undefined;
}

function imageMime(base64: string): string {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function imageParts(images: unknown): Json[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => ({
      type: "image_url",
      image_url: {
        url: value.startsWith("data:") ? value : `data:${imageMime(value)};base64,${value}`,
      },
    }));
}

function withImages(content: unknown, images: unknown): unknown {
  const parts = imageParts(images);
  if (parts.length === 0) return content ?? "";
  const text = typeof content === "string" ? content : "";
  return [...(text ? [{ type: "text", text }] : []), ...parts];
}

/**
 * Ollama messages to OpenAI messages. Ollama tool calls carry arguments as an
 * object and may lack ids; tool results name the tool (`tool_name`) instead of
 * the call. Ids are synthesised and matched back so xAI sees a valid history.
 */
export function translateOllamaMessages(messages: unknown): Json[] {
  if (!Array.isArray(messages)) return [];
  const pending: Array<{ id: string; name: string }> = [];
  const out: Json[] = [];
  messages.forEach((raw, messageIndex) => {
    if (!isRecord(raw)) return;
    const role = typeof raw.role === "string" ? raw.role : "user";
    if (role === "assistant") {
      const message: Json = { role, content: typeof raw.content === "string" ? raw.content : "" };
      // Ollama returns reasoning as `thinking`; agents send it back the same way.
      if (typeof raw.thinking === "string" && raw.thinking) message.reasoning_content = raw.thinking;
      if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
        message.tool_calls = raw.tool_calls.filter(isRecord).map((call, callIndex) => {
          const fn = isRecord(call.function) ? call.function : {};
          const name = typeof fn.name === "string" ? fn.name : "";
          const id = typeof call.id === "string" && call.id
            ? call.id
            : `call_${messageIndex}_${callIndex}`;
          pending.push({ id, name });
          return {
            id,
            type: "function",
            function: {
              name,
              arguments: typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
            },
          };
        });
      }
      out.push(message);
      return;
    }
    if (role === "tool") {
      let id = typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined;
      const name = typeof raw.tool_name === "string"
        ? raw.tool_name
        : typeof raw.name === "string" ? raw.name : undefined;
      const matchIndex = id
        ? pending.findIndex((entry) => entry.id === id)
        : pending.findIndex((entry) => name === undefined || entry.name === name);
      const fallbackIndex = matchIndex >= 0 ? matchIndex : pending.length > 0 ? 0 : -1;
      if (fallbackIndex >= 0) {
        id ??= pending[fallbackIndex]!.id;
        pending.splice(fallbackIndex, 1);
      }
      out.push({
        role: "tool",
        tool_call_id: id ?? `call_${messageIndex}`,
        content: typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? ""),
      });
      return;
    }
    out.push({ role, content: withImages(raw.content, raw.images) });
  });
  return out;
}

/** Ollama `options` / `format` / `tools` to OpenAI request fields. */
export function translateOllamaParams(body: Json): Json {
  const out: Json = {};
  const options = isRecord(body.options) ? body.options : {};
  if (typeof options.temperature === "number") out.temperature = options.temperature;
  if (typeof options.top_p === "number") out.top_p = options.top_p;
  if (typeof options.seed === "number") out.seed = options.seed;
  if (typeof options.num_predict === "number" && options.num_predict > 0) {
    out.max_tokens = options.num_predict;
  }
  if (typeof options.stop === "string" || Array.isArray(options.stop)) {
    out.stop = options.stop;
  }
  if (body.format === "json") {
    out.response_format = { type: "json_object" };
  } else if (isRecord(body.format)) {
    out.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: body.format },
    };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;
  // `think: "low" | "medium" | "high"` picks an effort; `false` asks for the
  // least thinking Grok allows (it cannot be switched off); `true` = default.
  if (body.think !== undefined) out.think = body.think;
  return out;
}

function nanos(ms: number): number {
  return Math.max(0, Math.round(ms * 1e6));
}

function doneReason(finishReason: string): string {
  return finishReason === "length" ? "length" : "stop";
}

function finalStats(
  startedAt: number,
  usage: CollectedChat["usage"],
): Json {
  return {
    total_duration: nanos(Date.now() - startedAt),
    load_duration: 0,
    prompt_eval_count: usage?.inputTokens ?? 0,
    prompt_eval_duration: 0,
    eval_count: usage?.outputTokens ?? 0,
    eval_duration: nanos(Date.now() - startedAt),
  };
}

function ollamaToolCalls(calls: CollectedChat["toolCalls"]): Json[] {
  return calls.map((call, index) => ({
    id: call.id,
    function: {
      index,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    },
  }));
}

async function writeLine(res: Response, value: unknown): Promise<void> {
  if (!res.write(`${JSON.stringify(value)}\n`)) await once(res, "drain");
}

type OllamaKind = "chat" | "generate";

/**
 * Render translated items as Ollama NDJSON. `chat` chunks carry `message`,
 * `generate` chunks carry `response`; both end with a `done: true` line
 * holding the counters Ollama clients display.
 */
async function streamOllama(
  kind: OllamaKind,
  model: string,
  items: AsyncGenerator<ChatStreamItem>,
  res: Response,
  showThinking: boolean,
): Promise<void> {
  const startedAt = Date.now();
  const base = (): Json => ({ model, created_at: new Date().toISOString() });
  res.status(200);
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-cache");
  const toolCalls: CollectedChat["toolCalls"] = [];
  try {
    for await (const item of items) {
      if (item.type === "text") {
        await writeLine(res, kind === "chat"
          ? { ...base(), message: { role: "assistant", content: item.text }, done: false }
          : { ...base(), response: item.text, done: false });
      } else if (item.type === "reasoning") {
        if (!showThinking) continue;
        await writeLine(res, kind === "chat"
          ? { ...base(), message: { role: "assistant", content: "", thinking: item.text }, done: false }
          : { ...base(), response: "", thinking: item.text, done: false });
      } else if (item.type === "tool_call") {
        // Ollama delivers parallel calls together in one message; clients
        // that read only one chunk's tool_calls would otherwise miss some.
        if (kind === "chat") toolCalls.push(item.call);
      } else {
        if (toolCalls.length > 0) {
          await writeLine(res, {
            ...base(),
            message: { role: "assistant", content: "", tool_calls: ollamaToolCalls(toolCalls) },
            done: false,
          });
        }
        await writeLine(res, {
          ...base(),
          ...(kind === "chat"
            ? { message: { role: "assistant", content: "" } }
            : { response: "", context: [] }),
          done: true,
          done_reason: doneReason(item.finishReason),
          ...finalStats(startedAt, item.usage),
        });
      }
    }
  } catch (error) {
    await writeLine(res, { error: safeErrorMessage(error) });
  }
  res.end();
}

function collectedBody(
  kind: OllamaKind,
  model: string,
  collected: CollectedChat,
  startedAt: number,
  showThinking: boolean,
): Json {
  const thinking = showThinking && collected.reasoning ? { thinking: collected.reasoning } : {};
  const base = { model, created_at: new Date().toISOString() };
  if (kind === "generate") {
    return {
      ...base,
      response: collected.text,
      ...thinking,
      done: true,
      done_reason: doneReason(collected.finishReason),
      context: [],
      ...finalStats(startedAt, collected.usage),
    };
  }
  return {
    ...base,
    message: {
      role: "assistant",
      content: collected.text,
      ...thinking,
      ...(collected.toolCalls.length > 0
        ? { tool_calls: ollamaToolCalls(collected.toolCalls) }
        : {}),
    },
    done: true,
    done_reason: doneReason(collected.finishReason),
    ...finalStats(startedAt, collected.usage),
  };
}

function abortOnClose(req: Request, res: Response): AbortController {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error("downstream request aborted"));
  };
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });
  return controller;
}

async function serveOllamaCompletion(
  kind: OllamaKind,
  req: Request,
  res: Response,
  deps: LocalCatalogDeps,
): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  const model = normalizeLocalModelId(body.model);
  if (!model) {
    sendError(res, 400, "model is required");
    return;
  }

  let messages: Json[];
  if (kind === "chat") {
    messages = translateOllamaMessages(body.messages);
    if (messages.length === 0) {
      // Ollama treats an empty chat as "load the model"; answer the same way.
      res.json({
        model,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" },
        done_reason: "load",
        done: true,
      });
      return;
    }
  } else {
    const prompt = promptText(body.prompt) ?? "";
    if (prompt.length === 0 && !body.suffix) {
      res.json({
        model,
        created_at: new Date().toISOString(),
        response: "",
        done_reason: "load",
        done: true,
      });
      return;
    }
    messages = promptToMessages({
      prompt,
      ...(typeof body.suffix === "string" ? { suffix: body.suffix } : {}),
      ...(typeof body.system === "string" && body.raw !== true ? { system: body.system } : {}),
    });
    const images = imageParts(body.images);
    if (images.length > 0) {
      const last = messages[messages.length - 1]!;
      last.content = [{ type: "text", text: String(last.content) }, ...images];
    }
  }

  const request: Json = { model, messages, ...translateOllamaParams(body) };
  // Real Ollama returns `thinking` only when the caller opts in with `think`.
  const showThinking = body.think === true || typeof body.think === "string";
  const stream = body.stream !== false;
  const startedAt = Date.now();
  const controller = abortOnClose(req, res);

  let items: AsyncGenerator<ChatStreamItem>;
  try {
    items = await openLocalChatStream(deps, request, controller.signal);
  } catch (error) {
    const status = error instanceof LocalUpstreamError ? error.status : 502;
    sendError(res, status, safeErrorMessage(error));
    return;
  }

  if (stream) {
    await streamOllama(kind, model, items, res, showThinking);
    return;
  }
  try {
    const collected = await collectLocalChat(items);
    res.json(collectedBody(kind, model, collected, startedAt, showThinking));
  } catch (error) {
    const status = error instanceof LocalUpstreamError ? error.status : 502;
    sendError(res, status, safeErrorMessage(error));
  }
}

function wrap(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    void handler(req, res).catch((error: unknown) => {
      sendError(res, 500, safeErrorMessage(error));
      if (!res.writableEnded) res.end();
    });
  };
}

export function createOllamaRouter(
  deps: LocalCatalogDeps,
  catalog = new LocalModelCatalog(deps),
): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.type("text/plain").send("Ollama is running");
  });
  router.head("/", (_req, res) => {
    res.type("text/plain").end();
  });

  router.get("/api/version", (_req, res) => {
    res.json({ version: OLLAMA_COMPAT_VERSION });
  });

  router.get("/api/tags", wrap(async (_req, res) => {
    const models = await catalog.list();
    res.json({ models: models.map(tagEntry) });
  }));

  router.get("/v1/models", wrap(async (_req, res) => {
    res.json(openAiModelList(await catalog.list(), "library"));
  }));

  router.get("/api/ps", wrap(async (_req, res) => {
    const models = await catalog.list();
    res.json({
      models: models.map((model) => ({
        ...tagEntry(model),
        expires_at: "2099-01-01T00:00:00Z",
        size_vram: 0,
        context_length: model.contextLength,
      })),
    });
  }));

  router.post("/api/show", wrap(async (req, res) => {
    const body = await readJson(req, res);
    if (!body) return;
    const model = await catalog.find(body.model ?? body.name);
    if (!model) {
      sendError(res, 400, "model is required");
      return;
    }
    res.json(showBody(model));
  }));

  router.post("/api/chat", wrap((req, res) => serveOllamaCompletion("chat", req, res, deps)));
  router.post("/api/generate", wrap((req, res) => serveOllamaCompletion("generate", req, res, deps)));

  // Model management is meaningless for a hosted model: acknowledge, do nothing.
  for (const path of ["/api/pull", "/api/push", "/api/create", "/api/copy"]) {
    router.post(path, (_req, res) => {
      res.json({ status: "success" });
    });
  }
  router.delete("/api/delete", (_req, res) => {
    res.status(200).end();
  });

  return router;
}
