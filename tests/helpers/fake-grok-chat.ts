import type { XaiFetchInput } from "../../src/transport/fetch.js";

/**
 * In-process stand-in for xAI used by the local-server emulation tests and the
 * `scripts/mock-local-compat.ts` harness.
 *
 * It behaves like a strict reasoning-model backend so translation bugs fail
 * loudly instead of passing by accident:
 *  - Chat Completions accepts only xAI's documented top-level fields, rejects
 *    `stop` / `presence_penalty` / `frequency_penalty` on reasoning models and
 *    `reasoning_effort` on models that do not take it (HTTP 400, like xAI);
 *  - a `tool` message must answer a tool_call id from an earlier assistant turn;
 *  - reasoning models stream `reasoning_content` before anything else;
 *  - with tools and a weather question it makes two parallel tool calls whose
 *    arguments arrive in interleaved fragments; once tool results are in the
 *    history it answers from them; a json_schema response_format yields JSON;
 *  - Responses API: real event sequence, reasoning items with
 *    `encrypted_content` when `include` asks, function_call items, and
 *    `previous_response_id` continuation from an in-memory store.
 */

export interface RecordedCall {
  path: string;
  method: string;
  bearer: string;
  headers: Headers;
  json?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const CHAT_FIELDS = new Set([
  "deferred", "frequency_penalty", "guidelines", "logprobs", "max_completion_tokens", "max_tokens",
  "messages", "model", "n", "parallel_tool_calls", "presence_penalty", "prompt_cache_key",
  "reasoning_effort", "response_format", "safety_identifier", "search_parameters", "seed",
  "service_tier", "stop", "stream", "stream_options", "temperature", "tool_choice", "tools",
  "top_logprobs", "top_p", "user", "web_search_options",
]);

function sseBody(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function data(chunk: unknown): string {
  return `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decode(body: BodyInit | null | undefined): Json | undefined {
  if (body === undefined || body === null) return undefined;
  const text = typeof body === "string"
    ? body
    : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : undefined;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as Json).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

export const FAKE_CATALOG = {
  models: [
    { id: "grok-4.6", input_modalities: ["text", "image"] },
    { id: "grok-build-0.1", input_modalities: ["text"] },
    { id: "grok-4.20-0309-non-reasoning", input_modalities: ["text"] },
    { id: "grok-imagine-image", input_modalities: ["text", "image"] },
  ],
};

const REASONING_EFFORT_MODELS = /^grok-4\.(5|6|7)/;
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  completion_tokens_details: { reasoning_tokens: 5 },
};

interface Plan {
  reasoning: string[];
  text: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
}

/** Decide what a conversation's next assistant turn is. */
function plan(model: string, messages: Json[], tools: unknown, responseFormat: unknown, effort: unknown): Plan {
  const reasoning = /non-reasoning/.test(model)
    ? []
    : [`Effort ${typeof effort === "string" ? effort : "default"}. `, "Let me think."];
  const toolResults = messages.filter((m) => m.role === "tool");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = textOf(lastUser?.content);
  const lastIsTool = messages.at(-1)?.role === "tool";

  if (lastIsTool) {
    const facts = toolResults.slice(-2).map((m) => textOf(m.content)).join("; ");
    return { reasoning, text: `Weather: ${facts}`, toolCalls: [] };
  }
  if (Array.isArray(tools) && tools.length > 0 && /weather/i.test(prompt)) {
    return {
      reasoning,
      text: "",
      toolCalls: [
        { id: "call_waw", name: "get_weather", args: "{\"city\":\"Warsaw\"}" },
        { id: "call_krk", name: "get_weather", args: "{\"city\":\"Krakow\"}" },
      ],
    };
  }
  const format = responseFormat as Json | undefined;
  if (format?.type === "json_schema" || format?.type === "json_object") {
    return { reasoning, text: "{\"answer\":\"Hello from Grok\"}", toolCalls: [] };
  }
  return { reasoning, text: "Hello from Grok", toolCalls: [] };
}

function validateChat(json: Json): string | undefined {
  const model = String(json.model);
  for (const key of Object.keys(json)) {
    if (!CHAT_FIELDS.has(key)) return `Unknown field \`${key}\``;
  }
  if (!/non-reasoning/.test(model)) {
    for (const key of ["stop", "presence_penalty", "frequency_penalty"]) {
      if (json[key] !== undefined) return `Model ${model} does not support parameter ${key}`;
    }
  }
  if (json.reasoning_effort !== undefined && !REASONING_EFFORT_MODELS.test(model)) {
    return `Model ${model} does not support parameter reasoningEffort`;
  }
  const seen = new Set<string>();
  for (const message of (json.messages as Json[]) ?? []) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as Json[]) {
        const fn = call.function as Json;
        if (typeof fn?.arguments !== "string") return "tool_calls[].function.arguments must be a string";
        seen.add(String(call.id));
      }
    }
    if (message.role === "tool" && !seen.has(String(message.tool_call_id))) {
      return `tool message references unknown tool_call_id ${String(message.tool_call_id)}`;
    }
  }
  return undefined;
}

function chatCompletion(json: Json): Response {
  const model = String(json.model);
  if (model === "missing-model") {
    return jsonResponse({ error: "The model missing-model does not exist" }, 404);
  }
  const invalid = validateChat(json);
  if (invalid) return jsonResponse({ code: "Client specified an invalid argument", error: invalid }, 400);

  const next = plan(model, (json.messages as Json[]) ?? [], json.tools, json.response_format, json.reasoning_effort);
  const finish = next.toolCalls.length > 0 ? "tool_calls" : "stop";

  if (json.stream !== true) {
    return jsonResponse({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: next.text || null,
          ...(next.reasoning.length > 0 ? { reasoning_content: next.reasoning.join("") } : {}),
          ...(next.toolCalls.length > 0
            ? {
              tool_calls: next.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args },
              })),
            }
            : {}),
        },
        finish_reason: finish,
      }],
      usage: USAGE,
    });
  }

  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model };
  const chunk = (delta: Json, finishReason: string | null = null, extra: Json = {}) =>
    data({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });
  const frames: string[] = [chunk({ role: "assistant" })];
  for (const piece of next.reasoning) frames.push(chunk({ reasoning_content: piece }));
  next.toolCalls.forEach((call, index) => {
    frames.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }));
  });
  // Interleave argument fragments of the parallel calls.
  const halves = next.toolCalls.map((call) => [call.args.slice(0, 9), call.args.slice(9)]);
  for (const part of [0, 1]) {
    halves.forEach((pieces, index) => {
      frames.push(chunk({ tool_calls: [{ index, function: { arguments: pieces[part] } }] }));
    });
  }
  if (next.text) {
    const mid = Math.ceil(next.text.length / 2);
    frames.push(chunk({ content: next.text.slice(0, mid) }));
    frames.push(chunk({ content: next.text.slice(mid) }));
  }
  frames.push(chunk({}, finish, { usage: USAGE }));
  frames.push(data("[DONE]"));
  return sseBody(frames);
}

interface StoredResponse {
  input: Json[];
  output: Json[];
}

function responsesInput(json: Json, store: Map<string, StoredResponse>): Json[] | string {
  const input: Json[] = typeof json.input === "string"
    ? [{ type: "message", role: "user", content: json.input }]
    : Array.isArray(json.input) ? (json.input as Json[]) : [];
  if (typeof json.previous_response_id !== "string") return input;
  const previous = store.get(json.previous_response_id);
  if (!previous) return `Response with id '${json.previous_response_id}' not found`;
  return [...previous.input, ...previous.output, ...input];
}

function responses(json: Json, store: Map<string, StoredResponse>, counter: { n: number }): Response {
  const model = String(json.model);
  const history = responsesInput(json, store);
  if (typeof history === "string") return jsonResponse({ error: history }, 400);
  const reasoningItems = history.filter((item) => item.type === "reasoning");
  const clientReasoning = (Array.isArray(json.input) ? (json.input as Json[]) : [])
    .filter((item) => item.type === "reasoning");
  if (clientReasoning.some((item) => typeof item.encrypted_content !== "string")) {
    return jsonResponse({ error: "reasoning items must carry encrypted_content" }, 400);
  }
  const effort = (json.reasoning as Json | undefined)?.effort;
  if (effort !== undefined && !REASONING_EFFORT_MODELS.test(model)) {
    return jsonResponse({ error: `Model ${model} does not support parameter reasoningEffort` }, 400);
  }

  const messages: Json[] = history.map((item) => {
    if (item.type === "function_call_output") return { role: "tool", content: item.output };
    return { role: item.role ?? item.type, content: item.content };
  });
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const next = plan(model, messages, tools, undefined, effort);
  const id = `resp_fake_${++counter.n}`;
  const include = Array.isArray(json.include) ? json.include : [];
  const output: Json[] = [];
  const frames: string[] = [];
  let seq = 0;
  const event = (type: string, payload: Json) =>
    frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  const shell = (status: string, extra: Json = {}) => ({ id, object: "response", status, model, output: [...output], ...extra });

  event("response.created", { response: shell("in_progress") });
  if (next.reasoning.length > 0) {
    const item: Json = {
      id: `rs_${counter.n}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: next.reasoning.join("") }],
      ...(include.includes("reasoning.encrypted_content") ? { encrypted_content: `enc:${counter.n}:${reasoningItems.length}` } : {}),
    };
    event("response.output_item.added", { output_index: output.length, item: { ...item, summary: [] } });
    for (const piece of next.reasoning) {
      event("response.reasoning_summary_text.delta", { item_id: item.id, output_index: output.length, summary_index: 0, delta: piece });
    }
    event("response.output_item.done", { output_index: output.length, item });
    output.push(item);
  }
  for (const call of next.toolCalls) {
    const item = { id: `fc_${call.id}`, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.args };
    event("response.output_item.added", { output_index: output.length, item: { ...item, arguments: "", status: "in_progress" } });
    event("response.function_call_arguments.delta", { item_id: item.id, output_index: output.length, delta: call.args });
    event("response.function_call_arguments.done", { item_id: item.id, output_index: output.length, arguments: call.args });
    event("response.output_item.done", { output_index: output.length, item });
    output.push(item);
  }
  if (next.text) {
    const item = { id: `msg_${counter.n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: next.text, annotations: [] }] };
    event("response.output_item.added", { output_index: output.length, item: { ...item, content: [], status: "in_progress" } });
    event("response.output_text.delta", { item_id: item.id, output_index: output.length, content_index: 0, delta: next.text });
    event("response.output_item.done", { output_index: output.length, item });
    output.push(item);
  }
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 5 } };
  if (json.store !== false) store.set(id, { input: history, output: [...output] });
  event("response.completed", { response: shell("completed", { usage }) });

  if (json.stream === true) return sseBody(frames);
  return jsonResponse(shell("completed", { usage }));
}

export function fakeGrokChat(calls: RecordedCall[] = []) {
  const store = new Map<string, StoredResponse>();
  const counter = { n: 0 };
  return {
    getBearer: async () => "test-bearer",
    fetchUpstream: async (input: XaiFetchInput, { bearer }: { bearer: string }) => {
      const json = decode(input.body);
      calls.push({
        path: input.pathWithQuery,
        method: input.method,
        bearer,
        headers: input.headers,
        ...(json ? { json } : {}),
      });
      if (input.pathWithQuery === "/v1/language-models") return jsonResponse(FAKE_CATALOG);
      if (input.pathWithQuery === "/v1/models") {
        return jsonResponse({
          object: "list",
          data: FAKE_CATALOG.models.map((model) => ({ id: model.id, object: "model", owned_by: "xai" })),
        });
      }
      if (input.pathWithQuery === "/v1/chat/completions" && json) return chatCompletion(json);
      if (input.pathWithQuery === "/v1/responses" && json) return responses(json, store, counter);
      return jsonResponse({ error: { message: `unexpected ${input.pathWithQuery}` } }, 404);
    },
  };
}
