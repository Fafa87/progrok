import type { AdapterEvent, AdapterUsage } from "../core/events.js";
import { reduceChatStream } from "../wire/chat-stream.js";
import { prepareGrokRequestObject } from "./composer-inject.js";
import type { LocalCatalogDeps } from "./local-models.js";
import { prepareLocalChatRequest } from "./local-request.js";
import { redactSecrets } from "./redact.js";

/**
 * Shared upstream leg for the local-server emulators. Every translated request
 * (Ollama chat/generate, LM Studio legacy completions) becomes one streaming
 * xAI Chat Completions call, reduced by the same hardened SSE parser the
 * native proxy uses. Emulators then render the events in their own wire
 * format, or collect them into one JSON body for non-streaming callers.
 */

export interface CompletedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatStreamItem =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: CompletedToolCall }
  | { type: "done"; finishReason: string; usage?: AdapterUsage };

export class LocalUpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LocalUpstreamError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function upstreamErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return redactSecrets(error);
      if (isRecord(error) && typeof error.message === "string") {
        return redactSecrets(error.message);
      }
      if (typeof parsed.message === "string") return redactSecrets(parsed.message);
    }
  } catch {
    // not JSON
  }
  return redactSecrets(text || `xAI returned HTTP ${response.status}`);
}

/**
 * Turn adapter events into completed items: text and reasoning pass through,
 * tool-call fragments are buffered until the call closes, so emulators that
 * expect whole tool calls (Ollama) never see partial JSON.
 */
export async function* completeToolCalls(
  events: AsyncIterable<AdapterEvent>,
): AsyncGenerator<ChatStreamItem> {
  const pending = new Map<string, CompletedToolCall>();
  for await (const event of events) {
    switch (event.type) {
      case "heartbeat":
        break;
      case "text_delta":
        yield { type: "text", text: event.text };
        break;
      case "reasoning_delta":
        yield { type: "reasoning", text: event.text };
        break;
      case "tool_call_start":
        pending.set(event.id, { id: event.id, name: event.name, arguments: "" });
        break;
      case "tool_call_delta": {
        const call = pending.get(event.id);
        if (call) call.arguments += event.arguments;
        break;
      }
      case "tool_call_end": {
        const call = pending.get(event.id);
        if (call) {
          pending.delete(event.id);
          yield { type: "tool_call", call };
        }
        break;
      }
      case "done":
        yield {
          type: "done",
          finishReason: event.finishReason ?? "stop",
          ...(event.usage ? { usage: event.usage } : {}),
        };
        return;
      case "incomplete":
        throw new LocalUpstreamError(502, event.reason);
      case "error":
        throw new LocalUpstreamError(event.status ?? 502, event.message);
    }
  }
  throw new LocalUpstreamError(502, "xAI stream ended without a terminal event");
}

/**
 * POST a Chat Completions body upstream as a stream. Throws LocalUpstreamError
 * before anything is yielded when xAI refuses the request, so callers can
 * still answer with a proper status code.
 */
export async function openLocalChatStream(
  deps: LocalCatalogDeps,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AsyncGenerator<ChatStreamItem>> {
  let bearer: string;
  try {
    bearer = await deps.getBearer();
  } catch (error) {
    throw new LocalUpstreamError(
      401,
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
  const prepared = prepareGrokRequestObject("/chat/completions", {
    ...prepareLocalChatRequest(body),
    stream: true,
    stream_options: { include_usage: true },
  }).value;
  const response = await deps.fetchUpstream({
    method: "POST",
    pathWithQuery: "/v1/chat/completions",
    headers: new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    body: new TextEncoder().encode(JSON.stringify(prepared)),
    signal,
  }, { bearer });

  if (!response.ok) {
    throw new LocalUpstreamError(response.status, await upstreamErrorMessage(response));
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    throw new LocalUpstreamError(502, "xAI did not return an event stream");
  }
  return completeToolCalls(reduceChatStream(response.body));
}

export interface CollectedChat {
  text: string;
  reasoning: string;
  toolCalls: CompletedToolCall[];
  finishReason: string;
  usage?: AdapterUsage;
}

export async function collectLocalChat(
  items: AsyncIterable<ChatStreamItem>,
): Promise<CollectedChat> {
  const out: CollectedChat = {
    text: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
  };
  for await (const item of items) {
    if (item.type === "text") out.text += item.text;
    else if (item.type === "reasoning") out.reasoning += item.text;
    else if (item.type === "tool_call") out.toolCalls.push(item.call);
    else {
      out.finishReason = item.finishReason;
      if (item.usage) out.usage = item.usage;
    }
  }
  return out;
}

/** Parse tool-call arguments into the object form Ollama clients require. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

const FIM_SYSTEM =
  "You are a code completion engine. You receive the text before the cursor " +
  "(PREFIX) and the text after it (SUFFIX). Reply with ONLY the text that " +
  "belongs between them: no explanations, no Markdown fences, no repetition " +
  "of the prefix or suffix.";

/**
 * Legacy text-completion requests (LM Studio `/api/v0/completions`, Ollama
 * `/api/generate`) are served by Chat Completions, because xAI's own legacy
 * `/v1/completions` is not available for reasoning models. A `suffix` turns
 * the prompt into a fill-in-the-middle instruction.
 */
export function promptToMessages(input: {
  prompt: string;
  suffix?: string;
  system?: string;
}): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const hasSuffix = typeof input.suffix === "string" && input.suffix.length > 0;
  if (hasSuffix) {
    messages.push({
      role: "system",
      content: input.system ? `${input.system}\n\n${FIM_SYSTEM}` : FIM_SYSTEM,
    });
    messages.push({
      role: "user",
      content: `<PREFIX>\n${input.prompt}\n</PREFIX>\n<SUFFIX>\n${input.suffix}\n</SUFFIX>`,
    });
    return messages;
  }
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });
  return messages;
}

export function promptText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}
