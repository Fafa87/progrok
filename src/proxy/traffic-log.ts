import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response as ExpressResponse } from "express";
import { resolveUpstreamUrl } from "../transport/base-url.js";
import type { XaiFetchInput } from "../transport/fetch.js";
import { describeRateLimit, parseRateLimitHeaders } from "./rate-limit.js";

/**
 * `progrok proxy --verbose` / `--log-bodies` traffic log.
 *
 * One line per event on stderr: the client request as it arrives, the request
 * progrok sends to xAI, xAI's answer (status, latency, time to first byte,
 * usage, finish reason, tool calls) and what the client finally got. Lines of
 * one exchange share a `#n` id. Headers are never printed; bodies (with
 * `--log-bodies`) are redacted: credentials, encrypted reasoning blobs and
 * inline data URLs are replaced, and every dump is capped.
 */

type Json = Record<string, unknown>;

export type TrafficLogLevel = "off" | "events" | "bodies";
export type ListenerName = "openai" | "lmstudio" | "ollama";

export interface TrafficLogOptions {
  level: TrafficLogLevel;
  /** Max characters per body dump. */
  maxBodyChars?: number;
  /** Sink for finished lines; defaults to stderr. */
  write?: (line: string) => void;
  /** Colour the ERROR marker (defaults to stderr being a TTY). */
  color?: boolean;
}

export const DEFAULT_MAX_BODY_CHARS = 4_000;

/** `PROGROK_LOG`: unset/0/off → off, `bodies` → bodies, anything else → events. */
export function trafficLogLevelFromEnv(value: string | undefined): TrafficLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ["0", "off", "false", "no", "none"].includes(normalized)) return "off";
  if (normalized === "bodies" || normalized === "body" || normalized === "2") return "bodies";
  return "events";
}

export function resolveTrafficLogLevel(
  flags: { verbose?: boolean; logBodies?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): TrafficLogLevel {
  if (flags.logBodies) return "bodies";
  const fromEnv = trafficLogLevelFromEnv(env["PROGROK_LOG"]);
  if (flags.verbose) return fromEnv === "bodies" ? "bodies" : "events";
  return fromEnv;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Redaction

const SECRET_KEY = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|bearer|client[-_]?secret|secret|password|cookie|set-cookie|deployment[-_]?key)$/i;

function redactValue(key: string | undefined, value: unknown): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && value !== null && value !== undefined) {
    return "[redacted]";
  }
  if (key === "encrypted_content" && typeof value === "string") {
    return `[encrypted ${value.length} chars]`;
  }
  if (typeof value === "string") {
    if (/^data:[^;,]+;base64,/.test(value) && value.length > 64) {
      return `[${value.slice(5, value.indexOf(";"))} data URL, ${value.length} chars]`;
    }
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(undefined, entry));
  if (isRecord(value)) {
    const out: Json = {};
    for (const [entryKey, entry] of Object.entries(value)) out[entryKey] = redactValue(entryKey, entry);
    return out;
  }
  return value;
}

/** Deep copy of a JSON value with credentials and opaque blobs removed. */
export function redactJson(value: unknown): unknown {
  return redactValue(undefined, value);
}

/** Text-level redaction for non-JSON bodies and raw stream chunks. */
export function redactText(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/("encrypted_content"\s*:\s*")[^"]*(")/g, "$1[encrypted]$2")
    .replace(/("(?:api_key|access_token|refresh_token|id_token|authorization)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/(data:[a-z]+\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]{64,}/gi, "$1[…]");
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

/** Redacted, capped one-line rendering of a request/response body. */
export function renderBody(raw: string | Uint8Array | undefined, max: number): string {
  if (raw === undefined) return "(none)";
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (text.length === 0) return "(empty)";
  try {
    return cap(JSON.stringify(redactJson(JSON.parse(text))), max);
  } catch {
    return cap(redactText(text).replace(/\n/g, "\\n"), max);
  }
}

// ---------------------------------------------------------------------------
// Summaries

function count(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return 1;
  return undefined;
}

/** Effort / think setting of a request in whatever dialect it uses. */
export function describeEffort(body: Json): string | undefined {
  const reasoning = body.reasoning;
  const thinking = body.thinking;
  const outputConfig = body.output_config;
  const candidates: unknown[] = [
    body.reasoning_effort,
    isRecord(reasoning) ? reasoning.effort : reasoning,
    body.think,
    isRecord(thinking)
      ? (typeof thinking.budget_tokens === "number" ? `budget:${thinking.budget_tokens}` : thinking.type)
      : thinking,
    isRecord(outputConfig) ? outputConfig.effort : undefined,
  ];
  const found = candidates.find((value) => value !== undefined && value !== null);
  return found === undefined ? undefined : String(found);
}

const DEFAULT_STREAMING_PATHS = new Set(["/api/chat", "/api/generate"]);

export function describeRequest(path: string, body: Json): string {
  const parts: string[] = [];
  if (typeof body.model === "string") parts.push(`model=${body.model}`);
  const stream = body.stream === true || (body.stream === undefined && DEFAULT_STREAMING_PATHS.has(path));
  parts.push(`stream=${stream ? "yes" : "no"}`);
  const messages = count(body.messages) ?? count(body.input) ?? count(body.prompt);
  if (messages !== undefined) parts.push(`messages=${messages}`);
  const tools = count(body.tools);
  if (tools !== undefined && tools > 0) parts.push(`tools=${tools}`);
  const effort = describeEffort(body);
  if (effort !== undefined) parts.push(`effort=${effort}`);
  if (typeof body.previous_response_id === "string") parts.push("previous_response_id=yes");
  return parts.join(" ");
}

/** Facts gathered from an upstream (xAI) response body or SSE stream. */
export interface UpstreamFacts {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  toolCalls: number;
  text: string;
  reasoning: string;
  toolCallList: Array<{ name: string; arguments: string }>;
  error?: string;
}

function emptyFacts(): UpstreamFacts {
  return { toolCalls: 0, text: "", reasoning: "", toolCallList: [] };
}

function absorbUsage(facts: UpstreamFacts, usage: unknown): void {
  if (!isRecord(usage)) return;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const details = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  if (typeof input === "number") facts.inputTokens = input;
  if (typeof output === "number") facts.outputTokens = output;
  if (typeof details.reasoning_tokens === "number") facts.reasoningTokens = details.reasoning_tokens;
}

/** Fold one decoded JSON payload (a whole body or one SSE `data:`) into facts. */
export function absorbPayload(facts: UpstreamFacts, payload: unknown): void {
  if (!isRecord(payload)) return;
  if (payload.error !== undefined) {
    facts.error = typeof payload.error === "string"
      ? payload.error
      : isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : JSON.stringify(payload.error);
  }
  absorbUsage(facts, payload.usage);
  // Chat Completions (chunk or whole).
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices.filter(isRecord)) {
      if (typeof choice.finish_reason === "string") facts.finishReason = choice.finish_reason;
      const part = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
      if (typeof part.content === "string") facts.text += part.content;
      if (typeof part.reasoning_content === "string") facts.reasoning += part.reasoning_content;
      if (Array.isArray(part.tool_calls)) {
        for (const call of part.tool_calls.filter(isRecord)) {
          const fn = isRecord(call.function) ? call.function : {};
          const index = typeof call.index === "number" ? call.index : facts.toolCallList.length;
          const entry = facts.toolCallList[index] ?? (facts.toolCallList[index] = { name: "", arguments: "" });
          if (typeof fn.name === "string") entry.name += fn.name;
          if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
          facts.toolCalls = facts.toolCallList.filter(Boolean).length;
        }
      }
    }
  }
  // Responses API (stream events or whole response).
  const response = isRecord(payload.response) ? payload.response : payload.object === "response" ? payload : undefined;
  if (response) {
    absorbUsage(facts, response.usage);
    if (typeof response.status === "string" && response.status !== "in_progress") facts.finishReason = response.status;
    if (payload.type === undefined || payload.type === "response.completed") {
      const output = Array.isArray(response.output) ? response.output.filter(isRecord) : [];
      if (output.length > 0) {
        facts.toolCallList = output
          .filter((item) => item.type === "function_call")
          .map((item) => ({ name: String(item.name ?? ""), arguments: String(item.arguments ?? "") }));
        facts.toolCalls = facts.toolCallList.length;
        if (payload.type === undefined) {
          for (const item of output) {
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content.filter(isRecord)) {
                if (typeof part.text === "string") facts.text += part.text;
              }
            }
            if (item.type === "reasoning" && Array.isArray(item.summary)) {
              for (const part of item.summary.filter(isRecord)) {
                if (typeof part.text === "string") facts.reasoning += part.text;
              }
            }
          }
        }
      }
    }
  }
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") facts.text += payload.delta;
  if (
    (payload.type === "response.reasoning_summary_text.delta" || payload.type === "response.reasoning_text.delta")
    && typeof payload.delta === "string"
  ) facts.reasoning += payload.delta;
  if (payload.type === "response.output_item.done" && isRecord(payload.item) && payload.item.type === "function_call") {
    // response.completed replaces this running list with the final output.
    facts.toolCallList.push({ name: String(payload.item.name ?? ""), arguments: String(payload.item.arguments ?? "") });
    facts.toolCalls = facts.toolCallList.length;
  }
}

export function describeFacts(facts: UpstreamFacts): string {
  const parts: string[] = [];
  if (facts.inputTokens !== undefined || facts.outputTokens !== undefined) {
    parts.push(`tokens in=${facts.inputTokens ?? "?"} out=${facts.outputTokens ?? "?"}${facts.reasoningTokens !== undefined ? ` reasoning=${facts.reasoningTokens}` : ""}`);
  }
  if (facts.finishReason) parts.push(`finish=${facts.finishReason}`);
  if (facts.toolCalls > 0) parts.push(`tool_calls=${facts.toolCalls}`);
  if (facts.text) parts.push(`text_chars=${facts.text.length}`);
  if (facts.reasoning) parts.push(`reasoning_chars=${facts.reasoning.length}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Logger

interface ExchangeContext {
  id: number;
  listener: ListenerName;
  method: string;
  path: string;
  startedAt: number;
  announced: boolean;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Local wall-clock timestamp, `YYYY-MM-DD HH:MM:SS.mmm`. */
export function timestamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function upstreamUrl(pathWithQuery: string): string {
  try {
    return resolveUpstreamUrl(pathWithQuery, "oauth");
  } catch {
    return `https://api.x.ai${pathWithQuery}`;
  }
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (typeof FormData !== "undefined" && body instanceof FormData) return "[multipart form data]";
  return "[stream body]";
}

function isTextual(contentType: string): boolean {
  return /json|text\/|event-stream|ndjson|xml/i.test(contentType);
}

export class TrafficLogger {
  readonly level: TrafficLogLevel;
  private readonly maxBodyChars: number;
  private readonly sink: (line: string) => void;
  private readonly color: boolean;
  private readonly storage = new AsyncLocalStorage<ExchangeContext>();
  private readonly byRequest = new WeakMap<Request, ExchangeContext>();
  private nextId = 0;

  constructor(options: TrafficLogOptions) {
    this.level = options.level;
    const envMax = Number(process.env["PROGROK_LOG_MAX_BODY"]);
    this.maxBodyChars = options.maxBodyChars
      ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_BODY_CHARS);
    this.sink = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.color = options.color ?? (options.write === undefined && process.stderr.isTTY === true);
  }

  get enabled(): boolean {
    return this.level !== "off";
  }

  get bodies(): boolean {
    return this.level === "bodies";
  }

  private emit(ctx: ExchangeContext | undefined, arrow: string, message: string, error = false): void {
    const tag = ctx ? `#${ctx.id} ${ctx.listener}` : "-";
    const marker = error ? (this.color ? "\x1b[31mERROR\x1b[0m " : "ERROR ") : "";
    this.sink(`${timestamp()} [${tag}] ${arrow} ${marker}${message}`);
  }

  private dump(ctx: ExchangeContext | undefined, label: string, rendered: string): void {
    this.emit(ctx, "  ", `${label}: ${rendered}`);
  }

  /** Express middleware: put first on every listener's app. */
  middleware(listener: ListenerName) {
    return (req: Request, res: ExpressResponse, next: NextFunction): void => {
      if (!this.enabled) {
        next();
        return;
      }
      const ctx: ExchangeContext = {
        id: ++this.nextId,
        listener,
        method: req.method,
        path: req.path,
        startedAt: Date.now(),
        announced: false,
      };
      this.byRequest.set(req, ctx);
      (req as LoggedRequest).progrokTrafficLogger = this;
      const hasBody = req.headers["content-length"] !== undefined
        ? req.headers["content-length"] !== "0"
        : req.headers["transfer-encoding"] !== undefined;
      if (!hasBody) this.announce(ctx);

      let clientBody = "";
      let clientBytes = 0;
      if (this.bodies) {
        const write = res.write.bind(res) as (...args: unknown[]) => boolean;
        const end = res.end.bind(res) as (...args: unknown[]) => ExpressResponse;
        const capture = (chunk: unknown): void => {
          if (chunk === undefined || chunk === null || typeof chunk === "function") return;
          const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString("utf8") : "";
          clientBytes += Buffer.byteLength(text);
          if (clientBody.length <= this.maxBodyChars) clientBody += text;
        };
        res.write = ((...args: unknown[]) => {
          capture(args[0]);
          return write(...args);
        }) as ExpressResponse["write"];
        res.end = ((...args: unknown[]) => {
          capture(args[0]);
          return end(...args);
        }) as ExpressResponse["end"];
      }

      res.once("close", () => {
        this.announce(ctx);
        const elapsed = Date.now() - ctx.startedAt;
        if (!res.writableFinished) {
          this.emit(ctx, "✖", `client disconnected after ${elapsed}ms (status ${res.statusCode} not completed)`, true);
          return;
        }
        const failed = res.statusCode >= 400;
        this.emit(ctx, "⇐", `client ${res.statusCode} ${ctx.method} ${ctx.path} total=${elapsed}ms`, failed);
        if (this.bodies) {
          const contentType = String(res.getHeader("content-type") ?? "");
          const rendered = !contentType || isTextual(contentType)
            ? renderBody(clientBody, this.maxBodyChars)
            : `[${contentType}, ${clientBytes} bytes]`;
          this.dump(ctx, "client response body", rendered);
        }
      });
      this.storage.run(ctx, next);
    };
  }

  private announce(ctx: ExchangeContext, detail?: string): void {
    if (ctx.announced) return;
    ctx.announced = true;
    this.emit(ctx, "→", `${ctx.method} ${ctx.path}${detail ? ` ${detail}` : ""}`);
  }

  /** Called by the body reader once a client request body is in memory. */
  noteRequestBody(req: Request, body: Buffer): void {
    const ctx = this.byRequest.get(req);
    if (!ctx || ctx.announced) return;
    let detail = `${body.byteLength}B`;
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/multipart|octet-stream|audio|image/i.test(contentType)) {
      try {
        const parsed: unknown = JSON.parse(body.toString("utf8"));
        if (isRecord(parsed)) detail = describeRequest(ctx.path, parsed);
      } catch {
        // not JSON; keep the byte count
      }
    }
    this.announce(ctx, detail);
    if (this.bodies) {
      this.dump(ctx, "client request body", /multipart|octet-stream|audio|image/i.test(contentType)
        ? `[${contentType}, ${body.byteLength} bytes]`
        : renderBody(body, this.maxBodyChars));
    }
  }

  /** Wrap an upstream fetch so every call to xAI is logged. */
  wrapFetch<T extends (input: XaiFetchInput, deps: { bearer: string }) => Promise<Response>>(fetchUpstream: T): T {
    if (!this.enabled) return fetchUpstream;
    const wrapped = async (input: XaiFetchInput, deps: { bearer: string }): Promise<Response> => {
      const ctx = this.storage.getStore();
      const startedAt = Date.now();
      const sent = bodyText(input.body);
      let summary = "";
      if (sent && sent.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(sent);
          if (isRecord(parsed)) summary = ` ${describeRequest(input.pathWithQuery, parsed)}`;
        } catch {
          // ignore
        }
      }
      this.emit(ctx, "↗", `xAI ${input.method} ${upstreamUrl(input.pathWithQuery)}${summary}`);
      if (this.bodies && sent !== undefined) this.dump(ctx, "xAI request body", renderBody(sent, this.maxBodyChars));
      let response: Response;
      try {
        response = await fetchUpstream(input, deps);
      } catch (error) {
        this.emit(ctx, "↙", `xAI request failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`, true);
        throw error;
      }
      return this.observeResponse(ctx, input, response, startedAt);
    };
    return wrapped as T;
  }

  private observeResponse(
    ctx: ExchangeContext | undefined,
    input: XaiFetchInput,
    response: Response,
    startedAt: number,
  ): Response {
    const headersAt = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") ?? "";
    const failed = !response.ok;
    const limits = parseRateLimitHeaders(input.pathWithQuery, response.status, response.headers);
    const head = `xAI ${response.status} ${input.method} ${input.pathWithQuery} headers=${headersAt}ms${limits ? ` ${describeRateLimit(limits)};` : ""}`;

    if (/event-stream/i.test(contentType) && response.body) {
      this.emit(ctx, "↙", `${head} stream opened`, failed);
      return this.tapStream(ctx, response, startedAt, head);
    }

    if (!response.body || !isTextual(contentType)) {
      const length = response.headers.get("content-length");
      this.emit(ctx, "↙", `${head}${contentType ? ` ${contentType}` : ""}${length ? ` ${length}B` : ""}`, failed);
      return response;
    }

    void response.clone().text().then((text) => {
      const facts = emptyFacts();
      try {
        absorbPayload(facts, JSON.parse(text));
      } catch {
        if (failed) facts.error = text.slice(0, 300);
      }
      const described = describeFacts(facts);
      const errorText = failed && facts.error ? ` error="${redactText(facts.error).slice(0, 300)}"` : "";
      this.emit(ctx, "↙", `${head} total=${Date.now() - startedAt}ms ${text.length}B${described ? ` ${described}` : ""}${errorText}`, failed);
      if (this.bodies) this.dump(ctx, "xAI response body", renderBody(text, this.maxBodyChars));
    }, (error: unknown) => {
      this.emit(ctx, "↙", `${head} body read failed: ${error instanceof Error ? error.message : String(error)}`, true);
    });
    return response;
  }

  private tapStream(
    ctx: ExchangeContext | undefined,
    response: Response,
    startedAt: number,
    head: string,
  ): Response {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const facts = emptyFacts();
    let buffer = "";
    let raw = "";
    let bytes = 0;
    let events = 0;
    let firstByteAt: number | undefined;
    let finished = false;

    const consume = (text: string, flush = false): void => {
      buffer += text;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = flush ? "" : blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        events += 1;
        if (data === "[DONE]") continue;
        try {
          absorbPayload(facts, JSON.parse(data));
        } catch {
          // non-JSON event
        }
      }
    };

    const finish = (outcome: "done" | "cancelled" | "error", error?: unknown): void => {
      if (finished) return;
      finished = true;
      consume(decoder.decode(), true);
      const ttfb = firstByteAt === undefined ? "-" : `${firstByteAt - startedAt}ms`;
      const base = `${head.replace(/ headers=\d+ms/, "")} stream ${outcome} ttfb=${ttfb} total=${Date.now() - startedAt}ms events=${events} ${bytes}B`;
      const described = describeFacts(facts);
      const errorText = error !== undefined
        ? ` error="${error instanceof Error ? error.message : String(error)}"`
        : facts.error ? ` error="${redactText(facts.error).slice(0, 300)}"` : "";
      this.emit(ctx, "↙", `${base}${described ? ` ${described}` : ""}${errorText}`, outcome === "error" || !response.ok || facts.error !== undefined);
      if (this.bodies) {
        const assembled = {
          ...(facts.reasoning ? { reasoning: facts.reasoning } : {}),
          ...(facts.text ? { text: facts.text } : {}),
          ...(facts.toolCallList.length > 0 ? { tool_calls: facts.toolCallList.filter(Boolean) } : {}),
        };
        if (Object.keys(assembled).length > 0) {
          this.dump(ctx, "xAI stream assembled", cap(JSON.stringify(redactJson(assembled)), this.maxBodyChars));
        } else {
          this.dump(ctx, "xAI stream raw", cap(redactText(raw).replace(/\n/g, "\\n"), this.maxBodyChars));
        }
      }
    };

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish("done");
            controller.close();
            return;
          }
          firstByteAt ??= Date.now();
          bytes += value.byteLength;
          const text = decoder.decode(value, { stream: true });
          if (this.bodies && raw.length <= this.maxBodyChars) raw += text;
          consume(text);
          controller.enqueue(value);
        } catch (error) {
          finish("error", error);
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        finish("cancelled");
        await reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

type LoggedRequest = Request & { progrokTrafficLogger?: TrafficLogger };

/** Called by `readBoundedBody` for every client body it reads. */
export function noteRequestBody(req: Request, body: Buffer): void {
  (req as LoggedRequest).progrokTrafficLogger?.noteRequestBody(req, body);
}
