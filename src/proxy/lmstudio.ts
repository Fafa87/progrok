import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { PayloadTooLargeError, readBoundedBody } from "./body.js";
import {
  collectLocalChat,
  LocalUpstreamError,
  openLocalChatStream,
  promptText,
  promptToMessages,
  type ChatStreamItem,
} from "./local-chat.js";
import {
  LocalModelCatalog,
  normalizeLocalModelId,
  openAiModelList,
  type LocalCatalogDeps,
  type LocalModel,
} from "./local-models.js";
import type { LocalProxyRoute } from "./local-request.js";
import { safeErrorMessage } from "./redact.js";

/**
 * LM Studio-compatible surface (default port 1234).
 *
 * Two kinds of client reach for "LM Studio":
 *
 *  - Junie CLI probes `GET /v1/models` and talks to `POST /v1/chat/completions`
 *    (plain OpenAI). The model list is narrowed to chat models, as LM Studio
 *    does; Chat requests go through the regular proxy pipeline after the LM
 *    Studio request sanitizer below.
 *  - JetBrains AI Assistant uses LM Studio's own REST API v0:
 *    `GET /api/v0/models`, `POST /api/v0/chat/completions` (OpenAI SSE) and
 *    `POST /api/v0/completions` for inline code completion.
 *
 * `GET /api/v1/models` (LM Studio 0.4 REST v1) is answered as well so newer
 * clients that probe it see the same catalog.
 *
 * Reference: https://lmstudio.ai/docs/developer/rest/endpoints
 */

type Json = Record<string, unknown>;

/** Request knobs only a local llama.cpp/MLX runtime understands. */
const LOCAL_ONLY_FIELDS = [
  "ttl",
  "draft_model",
  "top_k",
  "min_p",
  "repeat_penalty",
  "keep_alive",
];

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Make an LM Studio-flavoured Chat/Completions body acceptable to xAI:
 * LM Studio clients use `max_tokens: -1` for "no limit" and send runtime knobs
 * xAI rejects; model ids may carry a publisher prefix.
 */
export function sanitizeLmStudioRequest(json: Json): Json {
  const out: Json = { ...json };
  for (const key of LOCAL_ONLY_FIELDS) delete out[key];
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const value = out[key];
    if (value !== undefined && !(typeof value === "number" && value > 0)) {
      delete out[key];
    }
  }
  const model = normalizeLocalModelId(out.model);
  if (model) out.model = model;
  return out;
}

function v0Model(model: LocalModel): Json {
  return {
    id: model.id,
    object: "model",
    type: model.vision ? "vlm" : "llm",
    publisher: "xai",
    arch: "grok",
    compatibility_type: "gguf",
    quantization: "remote",
    state: "loaded",
    max_context_length: model.contextLength,
    capabilities: ["tool_use"],
  };
}

function v1Model(model: LocalModel): Json {
  return {
    type: "llm",
    publisher: "xai",
    key: model.id,
    display_name: model.id,
    architecture: "grok",
    quantization: null,
    size_bytes: 0,
    params_string: null,
    loaded_instances: [
      { id: model.id, config: { context_length: model.contextLength } },
    ],
    max_context_length: model.contextLength,
    format: null,
    capabilities: {
      vision: model.vision,
      trained_for_tool_use: true,
      ...(model.reasoning
        ? { reasoning: { allowed_options: ["on"], default: "on" } }
        : {}),
    },
    description: null,
  };
}

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ error: { message, type: "upstream_error" } });
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
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  sendError(res, 400, "invalid JSON body");
  return undefined;
}

async function writeChunk(res: Response, chunk: string): Promise<void> {
  if (!res.write(chunk)) await once(res, "drain");
}

function completionUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): Json | undefined {
  if (!usage) return undefined;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

/**
 * Legacy text completions (`/api/v0/completions`, `/v1/completions` on the LM
 * Studio listener) served through Chat Completions and rendered back as
 * OpenAI `text_completion` objects or SSE chunks.
 */
async function serveTextCompletion(
  req: Request,
  res: Response,
  deps: LocalCatalogDeps,
): Promise<void> {
  const raw = await readJson(req, res);
  if (!raw) return;
  const body = sanitizeLmStudioRequest(raw);
  const model = typeof body.model === "string" ? body.model : undefined;
  if (!model) {
    sendError(res, 400, "model is required");
    return;
  }
  const prompt = promptText(body.prompt) ?? "";
  const request: Json = {
    model,
    messages: promptToMessages({
      prompt,
      ...(typeof body.suffix === "string" ? { suffix: body.suffix } : {}),
    }),
  };
  for (const key of ["temperature", "top_p", "max_tokens", "stop", "seed"]) {
    if (body[key] !== undefined) request[key] = body[key];
  }

  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("downstream request aborted"));
    }
  });

  let items: AsyncGenerator<ChatStreamItem>;
  try {
    items = await openLocalChatStream(deps, request, controller.signal);
  } catch (error) {
    const status = error instanceof LocalUpstreamError ? error.status : 502;
    sendError(res, status, safeErrorMessage(error));
    return;
  }

  const id = `cmpl-progrok-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "text_completion", created, model };

  if (body.stream !== true) {
    try {
      const collected = await collectLocalChat(items);
      const usage = completionUsage(collected.usage);
      res.json({
        ...base,
        choices: [{
          index: 0,
          text: collected.text,
          logprobs: null,
          finish_reason: collected.finishReason,
        }],
        ...(usage ? { usage } : {}),
      });
    } catch (error) {
      const status = error instanceof LocalUpstreamError ? error.status : 502;
      sendError(res, status, safeErrorMessage(error));
    }
    return;
  }

  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  try {
    for await (const item of items) {
      if (item.type === "text") {
        await writeChunk(res, `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, text: item.text, logprobs: null, finish_reason: null }],
        })}\n\n`);
      } else if (item.type === "done") {
        const usage = completionUsage(item.usage);
        await writeChunk(res, `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, text: "", logprobs: null, finish_reason: item.finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`);
        await writeChunk(res, "data: [DONE]\n\n");
      }
    }
  } catch (error) {
    await writeChunk(res, `data: ${JSON.stringify({
      error: { message: safeErrorMessage(error), type: "upstream_error" },
    })}\n\n`);
  }
  res.end();
}

/**
 * Forwards a request through the regular proxy pipeline (auth injection,
 * composer handling, native SSE re-rendering) under another xAI path.
 */
export type ForwardToProxy = (
  req: Request,
  res: Response,
  route: LocalProxyRoute,
) => void;

export function createLmStudioRouter(
  deps: LocalCatalogDeps,
  forward: ForwardToProxy,
  chatRoute: LocalProxyRoute,
  catalog = new LocalModelCatalog(deps),
): express.Router {
  const router = express.Router();
  const wrap = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      void handler(req, res).catch((error: unknown) => {
        sendError(res, 500, safeErrorMessage(error));
        if (!res.writableEnded) res.end();
      });
    };

  router.get("/api/v0/models", wrap(async (_req, res) => {
    const models = await catalog.list();
    res.json({ object: "list", data: models.map(v0Model) });
  }));

  router.get("/api/v0/models/:model(*)", wrap(async (req, res) => {
    const model = await catalog.find(req.params.model);
    if (!model) {
      sendError(res, 404, "model not found");
      return;
    }
    res.json(v0Model(model));
  }));

  router.get("/v1/models", wrap(async (_req, res) => {
    res.json(openAiModelList(await catalog.list(), "xai"));
  }));

  router.get("/api/v1/models", wrap(async (_req, res) => {
    const models = await catalog.list();
    res.json({ models: models.map(v1Model) });
  }));

  router.post("/api/v0/chat/completions", (req, res) => {
    forward(req, res, chatRoute);
  });
  router.post("/api/v0/embeddings", (req, res) => {
    forward(req, res, { relPath: "/embeddings", rewrite: sanitizeLmStudioRequest });
  });

  router.post("/api/v0/completions", wrap((req, res) => serveTextCompletion(req, res, deps)));
  router.post("/v1/completions", wrap((req, res) => serveTextCompletion(req, res, deps)));

  return router;
}
