import { normalizeLocalModelId } from "./local-models.js";

/**
 * Request and response shaping shared by every local-server emulator.
 *
 * Clients that believe they talk to LM Studio or Ollama send whatever those
 * servers tolerate: llama.cpp sampler knobs, `max_tokens: -1`, vLLM
 * `chat_template_kwargs`, Anthropic-style `thinking`, reasoning history under
 * three different names. xAI documents a closed set of Chat Completions
 * fields and rejects `stop` / `presence_penalty` / `frequency_penalty` on
 * reasoning models, so requests are reduced to that set and reasoning
 * controls are folded into `reasoning_effort` where the model accepts it.
 *
 * Sources: docs.x.ai/developers/rest-api-reference/inference/chat-completions
 * and docs.x.ai/developers/model-capabilities/text/reasoning.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Top-level Chat Completions fields xAI documents. Everything else is dropped. */
const XAI_CHAT_FIELDS = new Set([
  "deferred",
  "frequency_penalty",
  "guidelines",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "messages",
  "model",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "prompt_cache_key",
  "reasoning_effort",
  "response_format",
  "safety_identifier",
  "search_parameters",
  "seed",
  "service_tier",
  "stop",
  "stream",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
  "web_search_options",
]);

const MESSAGE_FIELDS = new Set(["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content"]);

/** Parameters xAI rejects with an error on reasoning models. */
const REASONING_MODEL_REJECTS = ["stop", "presence_penalty", "frequency_penalty"];

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Models documented to accept `reasoning_effort` (others error or ignore it). */
export function supportsReasoningEffort(model: string): boolean {
  if (/^grok-4\.(5|6|7)\b/.test(model)) return true;
  if (/multi-agent/.test(model)) return true;
  const extra = process.env["PROGROK_REASONING_EFFORT_MODELS"];
  return !!extra && new RegExp(extra).test(model);
}

/** Every Grok 4 family model reasons unless its id says otherwise. */
export function isReasoningModel(model: string): boolean {
  return !/non-reasoning/.test(model);
}

/**
 * Collapse every reasoning control dialect into one xAI effort level.
 * Returns `null` for "do not send" (default effort, or reasoning cannot be
 * turned off on Grok so "off" means the cheapest level, `low`).
 */
export function effortFrom(value: unknown): ReasoningEffort | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? null : "low";
  if (typeof value === "number") {
    if (value <= 0) return "low";
    if (value < 4_096) return "low";
    if (value < 16_384) return "medium";
    return "high";
  }
  if (isRecord(value)) {
    if (value.type === "disabled") return "low";
    if (typeof value.effort === "string") return effortFrom(value.effort);
    if (typeof value.budget_tokens === "number") return effortFrom(value.budget_tokens);
    if (value.type === "enabled" || value.type === "adaptive") return null;
    return null;
  }
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "none":
    case "off":
    case "minimal":
    case "disabled":
    case "false":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return null;
  }
}

/** Find the first reasoning control a client used, in any dialect. */
export function requestedEffort(json: Json): ReasoningEffort | null {
  const kwargs = isRecord(json.chat_template_kwargs) ? json.chat_template_kwargs : {};
  for (const candidate of [
    json.reasoning_effort,
    json.reasoning,
    json.thinking,
    json.think,
    kwargs.enable_thinking,
    kwargs.reasoning_effort,
  ]) {
    const effort = effortFrom(candidate);
    if (effort) return effort;
  }
  return null;
}

const THINK_BLOCK = /^\s*<think>([\s\S]*?)<\/think>\s*/;

/** Normalise one history message to the fields xAI accepts. */
function prepareMessage(raw: unknown, keepReasoning: boolean): Json | undefined {
  if (!isRecord(raw)) return undefined;
  const message: Json = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MESSAGE_FIELDS.has(key)) message[key] = value;
  }
  if (message.role === "developer") message.role = "system";

  if (message.role === "assistant") {
    let reasoning = typeof raw.reasoning_content === "string"
      ? raw.reasoning_content
      : typeof raw.reasoning === "string"
        ? raw.reasoning
        : typeof raw.thinking === "string" ? raw.thinking : undefined;
    if (typeof message.content === "string") {
      const match = THINK_BLOCK.exec(message.content);
      if (match) {
        reasoning ??= match[1]!.trim();
        message.content = message.content.slice(match[0].length);
      }
    }
    delete message.reasoning_content;
    if (keepReasoning && reasoning) message.reasoning_content = reasoning;
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.filter(isRecord).map((call, index) => {
        const fn = isRecord(call.function) ? call.function : {};
        return {
          id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
          type: "function",
          function: {
            name: typeof fn.name === "string" ? fn.name : "",
            arguments: typeof fn.arguments === "string"
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
          },
        };
      });
      if ((message.tool_calls as unknown[]).length === 0) delete message.tool_calls;
    }
    if (message.content === undefined || (message.tool_calls && message.content === "")) {
      message.content = message.tool_calls ? null : "";
    }
  } else {
    delete message.reasoning_content;
  }
  return message;
}

export interface PrepareOptions {
  /** Keep assistant reasoning in history (xAI `reasoning_content`). */
  keepReasoningHistory?: boolean;
}

export function keepReasoningHistoryDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PROGROK_STRIP_REASONING_HISTORY"] !== "1";
}

/**
 * Make an LM Studio / Ollama / generic OpenAI client's Chat Completions body
 * acceptable to xAI without losing agent semantics: tools, tool_choice,
 * parallel_tool_calls, tool-call history, structured output and the
 * reasoning effort survive; local runtime knobs do not.
 */
export function prepareLocalChatRequest(json: Json, options: PrepareOptions = {}): Json {
  const keepReasoning = options.keepReasoningHistory ?? keepReasoningHistoryDefault();
  const effort = requestedEffort(json);
  const out: Json = {};
  for (const [key, value] of Object.entries(json)) {
    if (XAI_CHAT_FIELDS.has(key)) out[key] = value;
  }
  const model = normalizeLocalModelId(out.model);
  if (model) out.model = model;
  const id = typeof out.model === "string" ? out.model : "";

  delete out.reasoning_effort;
  if (effort && supportsReasoningEffort(id)) out.reasoning_effort = effort;

  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const value = out[key];
    if (value !== undefined && !(typeof value === "number" && value > 0)) delete out[key];
  }
  if (out.max_tokens !== undefined && out.max_completion_tokens !== undefined) {
    delete out.max_tokens;
  }
  if (isReasoningModel(id)) {
    for (const key of REASONING_MODEL_REJECTS) delete out[key];
  }

  if (Array.isArray(out.messages)) {
    out.messages = out.messages
      .map((message) => prepareMessage(message, keepReasoning))
      .filter((message): message is Json => message !== undefined);
  }
  if (Array.isArray(out.tools)) {
    const tools = out.tools.filter(
      (tool) => isRecord(tool) && (tool.type === undefined || tool.type === "function") && isRecord(tool.function),
    ).map((tool) => ({ ...(tool as Json), type: "function" }));
    if (tools.length > 0) out.tools = tools;
    else {
      delete out.tools;
      delete out.tool_choice;
      delete out.parallel_tool_calls;
    }
  }
  return out;
}

/**
 * Responses API bodies: same model and effort normalisation, `reasoning`
 * kept in the Responses shape, and encrypted reasoning requested whenever the
 * client keeps history itself (`store: false`), so a stateless agent loop can
 * hand the model its own reasoning back on the next turn.
 */
export function prepareLocalResponsesRequest(json: Json): Json {
  const out: Json = { ...json };
  const model = normalizeLocalModelId(out.model);
  if (model) out.model = model;
  const id = typeof out.model === "string" ? out.model : "";
  const effort = effortFrom(isRecord(json.reasoning) ? json.reasoning.effort : undefined)
    ?? effortFrom(json.reasoning_effort);
  delete out.reasoning_effort;
  const reasoning: Json = isRecord(json.reasoning) ? { ...json.reasoning } : {};
  delete reasoning.effort;
  if (effort && supportsReasoningEffort(id)) reasoning.effort = effort;
  if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
  else delete out.reasoning;
  for (const key of ["max_output_tokens"]) {
    const value = out[key];
    if (value !== undefined && !(typeof value === "number" && value > 0)) delete out[key];
  }
  for (const key of ["ttl", "top_k", "min_p", "repeat_penalty", "draft_model", "keep_alive"]) {
    delete out[key];
  }
  if (out.store === false) {
    const include = Array.isArray(out.include) ? [...out.include] : [];
    if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
    out.include = include;
  }
  return out;
}

export type ReasoningFormat = "both" | "reasoning_content" | "reasoning" | "think-tags" | "none";

export const REASONING_FORMATS: ReasoningFormat[] = [
  "both",
  "reasoning_content",
  "reasoning",
  "think-tags",
  "none",
];

export function parseReasoningFormat(value: string | undefined, fallback: ReasoningFormat): ReasoningFormat {
  if (!value) return fallback;
  if ((REASONING_FORMATS as string[]).includes(value)) return value as ReasoningFormat;
  throw new Error(`reasoning format must be one of ${REASONING_FORMATS.join(", ")}`);
}

export function reasoningRenderOptions(format: ReasoningFormat): {
  reasoningFields: Array<"reasoning_content" | "reasoning">;
  thinkTags: boolean;
  assistantRole: boolean;
} {
  return {
    reasoningFields: format === "both"
      ? ["reasoning_content", "reasoning"]
      : format === "reasoning_content" || format === "reasoning" ? [format] : [],
    thinkTags: format === "think-tags",
    assistantRole: true,
  };
}

/** Reshape a non-streaming xAI Chat Completion's reasoning for the client. */
export function shapeChatCompletionReasoning(body: unknown, format: ReasoningFormat): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const message = choice.message;
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
    delete message.reasoning_content;
    if (!reasoning) continue;
    if (format === "both" || format === "reasoning_content") message.reasoning_content = reasoning;
    if (format === "both" || format === "reasoning") message.reasoning = reasoning;
    if (format === "think-tags") {
      const content = typeof message.content === "string" ? message.content : "";
      message.content = `<think>${reasoning}</think>\n\n${content}`;
    }
  }
  return body;
}

/** How the proxy pipeline should treat one emulated route. */
export interface LocalProxyRoute {
  relPath: string;
  rewrite?: (json: Json) => Json;
  /** Relay upstream SSE byte-for-byte instead of re-rendering it. */
  relayStreams?: boolean;
  chatRender?: {
    reasoningFields?: Array<"reasoning_content" | "reasoning">;
    thinkTags?: boolean;
    assistantRole?: boolean;
  };
  /** Reshape a successful non-streaming JSON body before it reaches the client. */
  transformJsonResponse?: (body: unknown) => unknown;
}

export function compatChatRoute(format: ReasoningFormat): LocalProxyRoute {
  return {
    relPath: "/chat/completions",
    rewrite: (json) => prepareLocalChatRequest(json),
    chatRender: reasoningRenderOptions(format),
    transformJsonResponse: (body) => shapeChatCompletionReasoning(body, format),
  };
}

export const COMPAT_RESPONSES_ROUTE: LocalProxyRoute = {
  relPath: "/responses",
  rewrite: prepareLocalResponsesRequest,
  relayStreams: true,
};
