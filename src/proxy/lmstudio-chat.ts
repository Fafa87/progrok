import { once } from "node:events";
import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { PayloadTooLargeError, readBoundedBody } from "./body.js";
import {
  collectLocalChat,
  LocalUpstreamError,
  openLocalChatStream,
  type ChatStreamItem,
  type CollectedChat,
} from "./local-chat.js";
import { normalizeLocalModelId, type LocalCatalogDeps } from "./local-models.js";
import { safeErrorMessage } from "./redact.js";

/**
 * LM Studio native REST v1 chat (`POST /api/v1/chat`, LM Studio 0.4+).
 *
 * Stateful: each stored response gets a `response_id`; a later request with
 * `previous_response_id` continues that conversation, reasoning included, so
 * a client can send only the new turn. History lives in memory for the life
 * of the proxy process. LM Studio's server-side MCP `integrations` are not
 * available here (Grok has no access to the caller's MCP servers), so they
 * are rejected rather than silently ignored.
 *
 * Reference: https://lmstudio.ai/docs/developer/rest/chat,
 * https://lmstudio.ai/docs/developer/rest/streaming-events
 */

type Json = Record<string, unknown>;

const MAX_STORED = 500;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendError(res: Response, status: number, type: string, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ error: { type, message } });
}

async function readJson(req: Request, res: Response): Promise<Json | undefined> {
  let body: Buffer;
  try {
    body = await readBoundedBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendError(res, 413, "invalid_request", error.message);
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
  sendError(res, 400, "invalid_request", "invalid JSON body");
  return undefined;
}

/** LM Studio `input` (string or item array) to one user message. */
export function inputToUserMessage(input: unknown): Json | undefined {
  if (typeof input === "string") return input ? { role: "user", content: input } : undefined;
  if (!Array.isArray(input)) return undefined;
  const parts: Json[] = [];
  for (const item of input.filter(isRecord)) {
    const text = typeof item.content === "string" ? item.content
      : typeof item.text === "string" ? item.text : undefined;
    if ((item.type === "message" || item.type === "text") && text) parts.push({ type: "text", text });
    else if (item.type === "image" && typeof item.data_url === "string") {
      parts.push({ type: "image_url", image_url: { url: item.data_url } });
    }
  }
  if (parts.length === 0) return undefined;
  return {
    role: "user",
    content: parts.every((part) => part.type === "text")
      ? parts.map((part) => part.text).join("\n")
      : parts,
  };
}

export class ChatHistoryStore {
  private readonly entries = new Map<string, Json[]>();

  get(id: string): Json[] | undefined {
    return this.entries.get(id);
  }

  put(messages: Json[]): string {
    const id = `resp_${randomBytes(24).toString("hex")}`;
    this.entries.set(id, messages);
    while (this.entries.size > MAX_STORED) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return id;
  }
}

function stats(collected: Pick<CollectedChat, "usage">, startedAt: number, firstTokenAt?: number): Json {
  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const output = collected.usage?.outputTokens ?? 0;
  const raw = collected.usage?.raw;
  const details = isRecord(raw?.completion_tokens_details) ? raw.completion_tokens_details : {};
  return {
    input_tokens: collected.usage?.inputTokens ?? 0,
    total_output_tokens: output,
    reasoning_output_tokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0,
    tokens_per_second: Number((output / seconds).toFixed(2)),
    time_to_first_token_seconds: Number((((firstTokenAt ?? Date.now()) - startedAt) / 1000).toFixed(3)),
  };
}

function output(collected: CollectedChat, showReasoning: boolean): Json[] {
  return [
    ...(showReasoning && collected.reasoning ? [{ type: "reasoning", content: collected.reasoning }] : []),
    ...(collected.text ? [{ type: "message", content: collected.text }] : []),
  ];
}

async function writeEvent(res: Response, type: string, data: Json): Promise<void> {
  if (!res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)) {
    await once(res, "drain");
  }
}

export function createLmStudioNativeChatRouter(
  deps: LocalCatalogDeps,
  store = new ChatHistoryStore(),
): express.Router {
  const router = express.Router();

  router.post("/api/v1/chat", (req, res) => {
    void (async () => {
      const body = await readJson(req, res);
      if (!body) return;
      const model = normalizeLocalModelId(body.model);
      if (!model) {
        sendError(res, 400, "invalid_request", "\"model\" is required");
        return;
      }
      if (Array.isArray(body.integrations) && body.integrations.length > 0) {
        sendError(res, 400, "not_implemented", "MCP integrations are not available through progrok");
        return;
      }
      let history: Json[] = [];
      if (typeof body.previous_response_id === "string") {
        const previous = store.get(body.previous_response_id);
        if (!previous) {
          sendError(res, 404, "job_not_found", `unknown previous_response_id ${body.previous_response_id}`);
          return;
        }
        history = [...previous];
      } else if (typeof body.system_prompt === "string" && body.system_prompt) {
        history.push({ role: "system", content: body.system_prompt });
      }
      const user = inputToUserMessage(body.input);
      if (!user) {
        sendError(res, 400, "invalid_request", "\"input\" is required");
        return;
      }
      history.push(user);

      const showReasoning = body.reasoning !== "off";
      const request: Json = {
        model,
        messages: history,
        ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        ...(typeof body.max_output_tokens === "number" ? { max_completion_tokens: body.max_output_tokens } : {}),
      };

      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded && !controller.signal.aborted) controller.abort(new Error("aborted"));
      });
      const startedAt = Date.now();
      let items: AsyncGenerator<ChatStreamItem>;
      try {
        items = await openLocalChatStream(deps, request, controller.signal);
      } catch (error) {
        const status = error instanceof LocalUpstreamError ? error.status : 502;
        sendError(res, status, status === 404 ? "model_not_found" : "unknown", safeErrorMessage(error));
        return;
      }

      const finish = (collected: CollectedChat, firstTokenAt?: number): Json => {
        const result: Json = {
          model_instance_id: model,
          output: output(collected, showReasoning),
          stats: stats(collected, startedAt, firstTokenAt),
        };
        if (body.store !== false) {
          result.response_id = store.put([
            ...history,
            {
              role: "assistant",
              content: collected.text,
              ...(collected.reasoning ? { reasoning_content: collected.reasoning } : {}),
            },
          ]);
        }
        return result;
      };

      if (body.stream !== true) {
        try {
          res.json(finish(await collectLocalChat(items)));
        } catch (error) {
          sendError(res, 502, "unknown", safeErrorMessage(error));
        }
        return;
      }

      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      await writeEvent(res, "chat.start", { model_instance_id: model });
      await writeEvent(res, "prompt_processing.start", {});
      await writeEvent(res, "prompt_processing.end", {});
      const collected: CollectedChat = { text: "", reasoning: "", toolCalls: [], finishReason: "stop" };
      let open: "reasoning" | "message" | undefined;
      let firstTokenAt: number | undefined;
      const switchTo = async (next: "reasoning" | "message" | undefined): Promise<void> => {
        if (open === next) return;
        if (open) await writeEvent(res, `${open}.end`, {});
        if (next) await writeEvent(res, `${next}.start`, {});
        open = next;
      };
      try {
        for await (const item of items) {
          if (item.type === "reasoning") {
            collected.reasoning += item.text;
            if (!showReasoning) continue;
            firstTokenAt ??= Date.now();
            await switchTo("reasoning");
            await writeEvent(res, "reasoning.delta", { content: item.text });
          } else if (item.type === "text") {
            collected.text += item.text;
            firstTokenAt ??= Date.now();
            await switchTo("message");
            await writeEvent(res, "message.delta", { content: item.text });
          } else if (item.type === "done") {
            collected.finishReason = item.finishReason;
            if (item.usage) collected.usage = item.usage;
          }
        }
        await switchTo(undefined);
      } catch (error) {
        await switchTo(undefined);
        await writeEvent(res, "error", { error: { type: "unknown", message: safeErrorMessage(error) } });
      }
      await writeEvent(res, "chat.end", { result: finish(collected, firstTokenAt) });
      res.end();
    })().catch((error: unknown) => {
      sendError(res, 500, "internal_error", safeErrorMessage(error));
      if (!res.writableEnded) res.end();
    });
  });

  return router;
}
