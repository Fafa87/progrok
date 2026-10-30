import { LocalUpstreamError } from "./local-chat.js";

/**
 * `--upstream-stream`: build the non-streaming `chat.completion` body from an
 * xAI Chat Completions SSE stream (sent with `stream_options.include_usage`).
 *
 * Merging is generic so no field is lost: string delta fields (`content`,
 * `reasoning_content`, `reasoning`, `refusal`, …) are concatenated, other
 * delta fields keep their last value, tool calls are merged by `index`
 * (arguments concatenated), and top-level chunk fields (`id`, `created`,
 * `model`, `system_fingerprint`, `usage`, `citations`, …) keep their last
 * non-null value.
 */

type Json = Record<string, unknown>;

interface ChoiceState {
  index: number;
  message: Json;
  toolCalls: Map<number, { id?: string; type: string; function: { name: string; arguments: string }; extra: Json }>;
  finishReason: unknown;
  logprobs: unknown;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = function* (block: string): Generator<string> {
    const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (lines.length === 0) return;
    yield lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* flush(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* flush(buffer);
}

export async function assembleChatCompletion(body: ReadableStream<Uint8Array>): Promise<Json> {
  const top: Json = {};
  const choices = new Map<number, ChoiceState>();
  let chunks = 0;

  for await (const data of sseData(body)) {
    if (data.trim() === "[DONE]") break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.error !== undefined) {
      const error = parsed.error;
      const message = isRecord(error) && typeof error.message === "string"
        ? error.message
        : typeof error === "string" ? error : "xAI stream reported an error";
      throw new LocalUpstreamError(502, message);
    }
    chunks += 1;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "choices" || key === "object") continue;
      if (value !== null && value !== undefined) top[key] = value;
    }
    if (!Array.isArray(parsed.choices)) continue;
    for (const raw of parsed.choices) {
      if (!isRecord(raw)) continue;
      const index = typeof raw.index === "number" ? raw.index : 0;
      let state = choices.get(index);
      if (!state) {
        state = { index, message: {}, toolCalls: new Map(), finishReason: null, logprobs: undefined };
        choices.set(index, state);
      }
      if (raw.finish_reason !== null && raw.finish_reason !== undefined) state.finishReason = raw.finish_reason;
      if (raw.logprobs !== undefined && raw.logprobs !== null) state.logprobs = raw.logprobs;
      const delta = isRecord(raw.delta) ? raw.delta : isRecord(raw.message) ? raw.message : {};
      for (const [key, value] of Object.entries(delta)) {
        if (key === "tool_calls") {
          if (!Array.isArray(value)) continue;
          value.forEach((call, position) => {
            if (!isRecord(call)) return;
            const callIndex = typeof call.index === "number" ? call.index : position;
            let merged = state!.toolCalls.get(callIndex);
            if (!merged) {
              merged = { type: "function", function: { name: "", arguments: "" }, extra: {} };
              state!.toolCalls.set(callIndex, merged);
            }
            for (const [field, fieldValue] of Object.entries(call)) {
              if (field === "index") continue;
              if (field === "id" && typeof fieldValue === "string") merged.id = fieldValue;
              else if (field === "type" && typeof fieldValue === "string") merged.type = fieldValue;
              else if (field === "function" && isRecord(fieldValue)) {
                if (typeof fieldValue.name === "string") merged.function.name += fieldValue.name;
                if (typeof fieldValue.arguments === "string") merged.function.arguments += fieldValue.arguments;
              } else if (fieldValue !== null && fieldValue !== undefined) merged.extra[field] = fieldValue;
            }
          });
        } else if (key === "role") {
          if (typeof value === "string") state.message.role = value;
        } else if (typeof value === "string") {
          state.message[key] = (typeof state.message[key] === "string" ? state.message[key] as string : "") + value;
        } else if (value !== null && value !== undefined) {
          state.message[key] = value;
        }
      }
    }
  }

  if (chunks === 0) throw new LocalUpstreamError(502, "xAI stream ended without any completion chunk");

  const assembledChoices = [...choices.values()]
    .sort((a, b) => a.index - b.index)
    .map((state) => {
      const message: Json = { role: "assistant", ...state.message };
      if (typeof message.content !== "string" || message.content === "") {
        // xAI's non-streaming body uses null when there is no text.
        message.content = state.toolCalls.size > 0 || message.content === undefined
          ? null
          : message.content;
      }
      if (state.toolCalls.size > 0) {
        message.tool_calls = [...state.toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => ({
            ...(call.id !== undefined ? { id: call.id } : {}),
            type: call.type,
            function: call.function,
            ...call.extra,
          }));
      }
      return {
        index: state.index,
        message,
        finish_reason: state.finishReason,
        ...(state.logprobs !== undefined ? { logprobs: state.logprobs } : {}),
      };
    });

  return { ...top, object: "chat.completion", choices: assembledChoices };
}

/** Make a non-streaming Chat Completions body ask xAI for a stream instead. */
export function asUpstreamStream(json: Json): Json {
  const streamOptions = isRecord(json.stream_options) ? json.stream_options : {};
  return { ...json, stream: true, stream_options: { ...streamOptions, include_usage: true } };
}
