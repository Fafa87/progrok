import { Agent, fetch as undiciFetch } from "undici";
import { formatDuration, parseDuration } from "../utils/duration.js";

/**
 * How long progrok waits on xAI.
 *
 * Non-streaming requests get their response headers only once xAI has produced
 * the WHOLE answer, so a reasoning model working through a 170k-token agent
 * context can legitimately take minutes. Streaming requests get headers almost
 * at once, then chunks; for them a stalled connection shows up as silence
 * between chunks, which the idle timeout catches.
 *
 * 0 means "no limit" for any of the three.
 */
export interface UpstreamTimeouts {
  /** Wait for response headers on a non-streaming request. */
  nonStreamMs: number;
  /** Wait for response headers (time to first byte) on a streaming request. */
  streamMs: number;
  /** Maximum silence between two body chunks once the response has started. */
  idleMs: number;
}

export const DEFAULT_UPSTREAM_TIMEOUTS: Readonly<UpstreamTimeouts> = Object.freeze({
  nonStreamMs: 10 * 60_000,
  streamMs: 5 * 60_000,
  idleMs: 5 * 60_000,
});

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

let current: UpstreamTimeouts = { ...DEFAULT_UPSTREAM_TIMEOUTS };

/** Process-wide timeouts used by `executeXaiFetch` (set by `progrok proxy`). */
export function configureUpstreamTimeouts(next: Partial<UpstreamTimeouts>): UpstreamTimeouts {
  current = { ...current, ...next };
  return { ...current };
}

export function getUpstreamTimeouts(): UpstreamTimeouts {
  return { ...current };
}

export function resetUpstreamTimeouts(): void {
  current = { ...DEFAULT_UPSTREAM_TIMEOUTS };
}

export function parseUpstreamTimeout(value: string, label = "upstream timeout"): number {
  return parseDuration(value, {
    label,
    minMs: MIN_TIMEOUT_MS,
    maxMs: MAX_TIMEOUT_MS,
    rangeText: "1s and 24h",
  });
}

/**
 * CLI flags + env → timeouts. `--upstream-timeout` / `PROGROK_UPSTREAM_TIMEOUT`
 * sets the header wait for BOTH streaming and non-streaming requests;
 * `--upstream-idle-timeout` / `PROGROK_UPSTREAM_IDLE_TIMEOUT` the chunk gap.
 */
export function resolveUpstreamTimeouts(
  flags: { upstreamTimeout?: string; upstreamIdleTimeout?: string },
  env: NodeJS.ProcessEnv = process.env,
): UpstreamTimeouts {
  const pick = (flag: string | undefined, envName: string): string | undefined => {
    if (flag !== undefined) return flag;
    const fromEnv = env[envName];
    return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : undefined;
  };
  const resolved: UpstreamTimeouts = { ...DEFAULT_UPSTREAM_TIMEOUTS };
  const headers = pick(flags.upstreamTimeout, "PROGROK_UPSTREAM_TIMEOUT");
  if (headers !== undefined) {
    const ms = parseUpstreamTimeout(headers, "upstream timeout");
    resolved.nonStreamMs = ms;
    resolved.streamMs = ms;
  }
  const idle = pick(flags.upstreamIdleTimeout, "PROGROK_UPSTREAM_IDLE_TIMEOUT");
  if (idle !== undefined) resolved.idleMs = parseUpstreamTimeout(idle, "upstream idle timeout");
  return resolved;
}

export function describeUpstreamTimeouts(t: UpstreamTimeouts): string {
  const show = (ms: number): string => (ms === 0 ? "no limit" : formatDuration(ms));
  return `headers ${show(t.nonStreamMs)} (non-stream) / ${show(t.streamMs)} (stream), idle ${show(t.idleMs)}`;
}

export type UpstreamTimeoutPhase = "headers" | "stream-headers" | "idle";

/** Thrown (as an abort reason) when xAI is slower than the configured limit. */
export class UpstreamTimeoutError extends Error {
  override readonly name = "TimeoutError";
  readonly code = "UPSTREAM_TIMEOUT";
  constructor(
    readonly phase: UpstreamTimeoutPhase,
    readonly timeoutMs: number,
  ) {
    super(describeTimeout(phase, timeoutMs));
  }
}

function describeTimeout(phase: UpstreamTimeoutPhase, timeoutMs: number): string {
  const after = formatDuration(timeoutMs);
  if (phase === "idle") {
    return `Upstream stream went idle: no data from xAI for ${after}. ` +
      "Raise or disable the limit with --upstream-idle-timeout <duration> " +
      "or PROGROK_UPSTREAM_IDLE_TIMEOUT (0 = no limit).";
  }
  const kind = phase === "headers" ? "non-streaming" : "streaming";
  return `Upstream headers timed out: xAI did not answer the ${kind} request within ${after}. ` +
    "Raise or disable the limit with --upstream-timeout <duration> " +
    "or PROGROK_UPSTREAM_TIMEOUT (0 = no limit).";
}

export function isUpstreamTimeout(error: unknown): error is UpstreamTimeoutError {
  return error instanceof UpstreamTimeoutError ||
    (error instanceof Error && (error as { code?: unknown }).code === "UPSTREAM_TIMEOUT");
}

/**
 * Does this JSON body ask for `"stream": true`? Escaped quotes inside string
 * values (`\"stream\":true`) cannot match, so message text never trips it.
 */
export function bodyRequestsStream(body: BodyInit | null | undefined): boolean {
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(body));
  return text !== undefined && /"stream"\s*:\s*true\b/.test(text);
}

/**
 * Wrap a response body so it errors with UpstreamTimeoutError("idle") when no
 * chunk arrives for `idleMs`. Cancelling the wrapper cancels the upstream body
 * (closing the xAI connection).
 */
export function withIdleTimeout(response: Response, idleMs: number): Response {
  if (idleMs <= 0 || !response.body || [101, 204, 205, 304].includes(response.status)) {
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamTimeoutError("idle", idleMs)), idleMs);
      });
      try {
        const next = await Promise.race([reader.read(), idle]);
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new globalThis.Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/*
 * Node's built-in fetch runs on a bundled undici whose default dispatcher
 * gives up after 300s without headers (`UND_ERR_HEADERS_TIMEOUT`) or 300s
 * between body chunks — that would silently cap any longer limit configured
 * above. Upstream xAI calls therefore go through undici's own fetch with an
 * Agent whose built-in timers are off; progrok enforces the limits itself.
 */
let agent: Agent | undefined;

function upstreamAgent(): Agent {
  agent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });
  return agent;
}

const builtinFetch = globalThis.fetch;

export const upstreamFetch: typeof fetch = (input, init) => {
  // Someone replaced the global fetch (tests, instrumentation): respect it.
  if (globalThis.fetch !== builtinFetch) return globalThis.fetch(input, init);
  const body = init?.body;
  const plain = body === undefined || body === null || typeof body === "string" ||
    body instanceof Uint8Array || body instanceof ArrayBuffer;
  // Multipart / streamed bodies keep the built-in fetch (their own types).
  if (!plain) return globalThis.fetch(input, init);
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: upstreamAgent() },
  ) as unknown as Promise<Response>;
};
