import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { PayloadTooLargeError, readBoundedBody } from "./body.js";
import {
  collectLocalChat,
  LocalUpstreamError,
  openLocalChatStream,
  parseToolArguments,
  type ChatStreamItem,
  type CollectedChat,
} from "./local-chat.js";
import type { LocalCatalogDeps } from "./local-models.js";
import { normalizeLocalModelId } from "./local-models.js";
import { safeErrorMessage } from "./redact.js";

/**
 * Anthropic Messages API (`POST /v1/messages`) on the emulated local servers.
 *
 * LM Studio (0.4+) and Ollama (0.14+) both serve the Anthropic API so that
 * Claude Code-style agents and Junie's `apiType: "Anthropic"` profiles can use
 * local models. xAI's own `/v1/messages` is "fully deprecated", so requests
 * are translated to Chat Completions: tool_use / tool_result blocks become
 * tool_calls / tool messages, `thinking` blocks carry reasoning both ways, and
 * the response is re-rendered as Anthropic JSON or SSE events.
 *
 * Reference: https://docs.anthropic.com/en/api/messages,
 * https://lmstudio.ai/docs/developer/anthropic-compat
 */

type Json = Record<string, unknown>;

/** Opaque marker for thinking blocks; Grok's reasoning carries no signature. */
export const PROGROK_THINKING_SIGNATURE = "progrok";

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  const type = status === 400 ? "invalid_request_error"
    : status === 401 ? "authentication_error"
      : status === 404 ? "not_found_error"
        : status === 429 ? "rate_limit_error" : "api_error";
  res.status(status).json({ type: "error", error: { type, message } });
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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function imagePart(block: Json): Json | undefined {
  const source = isRecord(block.source) ? block.source : undefined;
  if (!source) return undefined;
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${media};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return undefined;
}

function toolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/** Anthropic `messages` + `system` to OpenAI Chat messages. */
export function translateAnthropicMessages(body: Json): Json[] {
  const out: Json[] = [];
  const system = textOf(body.system);
  if (system) out.push({ role: "system", content: system });
  if (!Array.isArray(body.messages)) return out;

  for (const raw of body.messages) {
    if (!isRecord(raw)) continue;
    const role = raw.role === "assistant" ? "assistant" : "user";
    const blocks: Json[] = typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : Array.isArray(raw.content) ? raw.content.filter(isRecord) : [];

    if (role === "assistant") {
      let text = "";
      let reasoning = "";
      const toolCalls: Json[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") text += block.text;
        else if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : `toolu_${toolCalls.length}`,
            type: "function",
            function: {
              name: typeof block.name === "string" ? block.name : "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      out.push({
        role: "assistant",
        content: text || (toolCalls.length > 0 ? null : ""),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // Tool results must directly follow the assistant turn that asked for them.
    const parts: Json[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const content = toolResultContent(block.content);
        out.push({
          role: "tool",
          tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: block.is_error === true ? `Error: ${content}` : content,
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const image = imagePart(block);
        if (image) parts.push(image);
      }
    }
    if (parts.length === 0) continue;
    out.push({
      role: "user",
      content: parts.every((part) => part.type === "text")
        ? parts.map((part) => part.text).join("")
        : parts,
    });
  }
  return out;
}

/** Anthropic request knobs to Chat Completions fields. */
export function translateAnthropicParams(body: Json): Json {
  const out: Json = {};
  if (typeof body.max_tokens === "number") out.max_completion_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (body.thinking !== undefined) out.thinking = body.thinking;
  if (isRecord(body.output_config) && body.output_config.effort !== undefined) {
    out.reasoning_effort = body.output_config.effort;
  }

  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter(isRecord)
      .filter((tool) => typeof tool.name === "string" && isRecord(tool.input_schema))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: tool.input_schema,
        },
      }));
    if (tools.length > 0) out.tools = tools;
  }
  const choice = isRecord(body.tool_choice) ? body.tool_choice : undefined;
  if (choice && out.tools) {
    if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    } else out.tool_choice = "auto";
    if (choice.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }
  return out;
}

function stopReason(finishReason: string): string {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function usage(collected: Pick<CollectedChat, "usage">): Json {
  return {
    input_tokens: collected.usage?.inputTokens ?? 0,
    output_tokens: collected.usage?.outputTokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function messageBody(id: string, model: string, collected: CollectedChat): Json {
  const content: Json[] = [];
  if (collected.reasoning) {
    content.push({ type: "thinking", thinking: collected.reasoning, signature: PROGROK_THINKING_SIGNATURE });
  }
  if (collected.text) content.push({ type: "text", text: collected.text });
  for (const call of collected.toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolArguments(call.arguments) });
  }
  const reason = collected.toolCalls.length > 0 ? "tool_use" : stopReason(collected.finishReason);
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reason,
    stop_sequence: null,
    usage: usage(collected),
  };
}

async function writeEvent(res: Response, type: string, data: Json): Promise<void> {
  if (!res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)) {
    await once(res, "drain");
  }
}

async function streamMessage(
  id: string,
  model: string,
  items: AsyncGenerator<ChatStreamItem>,
  res: Response,
): Promise<void> {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  await writeEvent(res, "message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  await writeEvent(res, "ping", {});

  let index = -1;
  let open: "thinking" | "text" | undefined;
  let sawTool = false;
  const close = async (): Promise<void> => {
    if (!open) return;
    if (open === "thinking") {
      await writeEvent(res, "content_block_delta", {
        index,
        delta: { type: "signature_delta", signature: PROGROK_THINKING_SIGNATURE },
      });
    }
    await writeEvent(res, "content_block_stop", { index });
    open = undefined;
  };
  const openBlock = async (kind: "thinking" | "text"): Promise<void> => {
    if (open === kind) return;
    await close();
    index += 1;
    open = kind;
    await writeEvent(res, "content_block_start", {
      index,
      content_block: kind === "thinking"
        ? { type: "thinking", thinking: "", signature: "" }
        : { type: "text", text: "" },
    });
  };

  try {
    for await (const item of items) {
      if (item.type === "reasoning") {
        await openBlock("thinking");
        await writeEvent(res, "content_block_delta", {
          index,
          delta: { type: "thinking_delta", thinking: item.text },
        });
      } else if (item.type === "text") {
        await openBlock("text");
        await writeEvent(res, "content_block_delta", {
          index,
          delta: { type: "text_delta", text: item.text },
        });
      } else if (item.type === "tool_call") {
        await close();
        sawTool = true;
        index += 1;
        await writeEvent(res, "content_block_start", {
          index,
          content_block: { type: "tool_use", id: item.call.id, name: item.call.name, input: {} },
        });
        await writeEvent(res, "content_block_delta", {
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(parseToolArguments(item.call.arguments)),
          },
        });
        await writeEvent(res, "content_block_stop", { index });
      } else {
        await close();
        await writeEvent(res, "message_delta", {
          delta: {
            stop_reason: sawTool ? "tool_use" : stopReason(item.finishReason),
            stop_sequence: null,
          },
          usage: usage({ usage: item.usage }),
        });
        await writeEvent(res, "message_stop", {});
      }
    }
  } catch (error) {
    await writeEvent(res, "error", {
      error: { type: "api_error", message: safeErrorMessage(error) },
    });
  }
  res.end();
}

async function serveMessages(req: Request, res: Response, deps: LocalCatalogDeps): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  const model = normalizeLocalModelId(body.model);
  if (!model) {
    sendError(res, 400, "model: Field required");
    return;
  }
  const request: Json = {
    model,
    messages: translateAnthropicMessages(body),
    ...translateAnthropicParams(body),
  };
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
    sendError(res, error instanceof LocalUpstreamError ? error.status : 502, safeErrorMessage(error));
    return;
  }
  const id = `msg_progrok_${randomUUID().replace(/-/g, "")}`;
  if (body.stream === true) {
    await streamMessage(id, model, items, res);
    return;
  }
  try {
    res.json(messageBody(id, model, await collectLocalChat(items)));
  } catch (error) {
    sendError(res, error instanceof LocalUpstreamError ? error.status : 502, safeErrorMessage(error));
  }
}

/** Rough token count for `/v1/messages/count_tokens` (≈4 chars per token). */
export function estimateTokens(body: Json): number {
  const text = JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]);
  return Math.max(1, Math.ceil(text.length / 4));
}

export function createAnthropicRouter(deps: LocalCatalogDeps): express.Router {
  const router = express.Router();
  router.post("/v1/messages", (req, res) => {
    void serveMessages(req, res, deps).catch((error: unknown) => {
      sendError(res, 500, safeErrorMessage(error));
      if (!res.writableEnded) res.end();
    });
  });
  router.post("/v1/messages/count_tokens", (req, res) => {
    void readJson(req, res).then((body) => {
      if (body) res.json({ input_tokens: estimateTokens(body) });
    }).catch((error: unknown) => sendError(res, 500, safeErrorMessage(error)));
  });
  return router;
}
