import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { assembleChatCompletion } from "../src/proxy/chat-assemble.js";
import { createProxyApp, type LocalCompatMode, type ProxyAppOptions } from "../src/proxy/server.js";
import { TrafficLogger } from "../src/proxy/traffic-log.js";
import { executeXaiFetch, type XaiFetchInput } from "../src/transport/fetch.js";
import {
  bodyRequestsStream,
  DEFAULT_UPSTREAM_TIMEOUTS,
  getUpstreamTimeouts,
  configureUpstreamTimeouts,
  resetUpstreamTimeouts,
  resolveUpstreamTimeouts,
  UpstreamTimeoutError,
  withIdleTimeout,
  type UpstreamTimeouts,
} from "../src/transport/timeouts.js";
import { fakeGrokChat, type RecordedCall } from "./helpers/fake-grok-chat.js";

type Json = Record<string, unknown>;

afterEach(() => resetUpstreamTimeouts());

function input(body?: Json): XaiFetchInput {
  return {
    pathWithQuery: "/v1/chat/completions",
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    ...(body ? { body: new TextEncoder().encode(JSON.stringify(body)) } : {}),
  };
}

/** A fetch that never answers until its signal aborts; records the signals. */
function hangingFetch(signals: AbortSignal[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal) signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
}

/** A fetch that answers after `delayMs` (aborting early if the signal fires). */
function delayedFetch(delayMs: number, answer: () => Response): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }) as typeof fetch;
}

describe("upstream timeout configuration", () => {
  it("defaults to 10m non-streaming, 5m streaming, 5m idle", () => {
    assert.deepEqual(resolveUpstreamTimeouts({}, {}), {
      nonStreamMs: 600_000, streamMs: 300_000, idleMs: 300_000,
    });
    assert.deepEqual(getUpstreamTimeouts(), DEFAULT_UPSTREAM_TIMEOUTS);
  });

  it("reads the flag before the env, accepts 0 = no limit, rejects nonsense", () => {
    assert.deepEqual(resolveUpstreamTimeouts({ upstreamTimeout: "20m" }, { PROGROK_UPSTREAM_TIMEOUT: "1m" }), {
      nonStreamMs: 1_200_000, streamMs: 1_200_000, idleMs: 300_000,
    });
    assert.deepEqual(resolveUpstreamTimeouts({}, { PROGROK_UPSTREAM_TIMEOUT: "0", PROGROK_UPSTREAM_IDLE_TIMEOUT: "90s" }), {
      nonStreamMs: 0, streamMs: 0, idleMs: 90_000,
    });
    assert.equal(resolveUpstreamTimeouts({ upstreamIdleTimeout: "off" }, {}).idleMs, 0);
    assert.throws(() => resolveUpstreamTimeouts({ upstreamTimeout: "soon" }, {}), /invalid upstream timeout/);
    assert.throws(() => resolveUpstreamTimeouts({ upstreamTimeout: "500ms" }, {}), /between 1s and 24h/);
  });

  it("spots stream:true in a JSON body but not inside string values", () => {
    const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    assert.equal(bodyRequestsStream(enc({ model: "m", stream: true })), true);
    assert.equal(bodyRequestsStream(enc({ model: "m", stream: false })), false);
    assert.equal(bodyRequestsStream(enc({ messages: [{ content: "\"stream\": true" }] })), false);
    assert.equal(bodyRequestsStream(undefined), false);
  });
});

describe("executeXaiFetch timeouts", () => {
  it("non-streaming: gives up after the header timeout with an actionable error, no retry", async () => {
    const signals: AbortSignal[] = [];
    const started = Date.now();
    await assert.rejects(
      executeXaiFetch(input({ model: "m", stream: false }), {
        bearer: "b", fetchImpl: hangingFetch(signals), timeouts: { nonStreamMs: 60, streamMs: 10_000 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamTimeoutError);
        assert.equal(error.phase, "headers");
        assert.match(error.message, /--upstream-timeout/);
        assert.match(error.message, /PROGROK_UPSTREAM_TIMEOUT/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(signals.length, 1);
    assert.ok(signals[0]!.aborted);
  });

  it("streaming requests use the streaming header timeout", async () => {
    await assert.rejects(
      executeXaiFetch(input({ model: "m", stream: true }), {
        bearer: "b", fetchImpl: hangingFetch(), timeouts: { nonStreamMs: 10_000, streamMs: 60 },
      }),
      { name: "TimeoutError", phase: "stream-headers" },
    );
  });

  it("the process-wide setting applies when no per-call timeouts are given", async () => {
    configureUpstreamTimeouts({ nonStreamMs: 60 });
    await assert.rejects(
      executeXaiFetch(input({ model: "m" }), { bearer: "b", fetchImpl: hangingFetch() }),
      { phase: "headers" },
    );
  });

  it("a slow answer within a higher timeout succeeds (the old 30s cap is gone)", async () => {
    const response = await executeXaiFetch(input({ model: "m" }), {
      bearer: "b",
      fetchImpl: delayedFetch(250, () => Response.json({ ok: true })),
      timeouts: { nonStreamMs: 2_000 },
    });
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("0 disables the header timeout", async () => {
    const response = await executeXaiFetch(input({ model: "m" }), {
      bearer: "b",
      fetchImpl: delayedFetch(150, () => Response.json({ ok: 1 })),
      timeouts: { nonStreamMs: 0, idleMs: 0 },
    });
    assert.equal(response.status, 200);
  });

  it("idle timeout errors a body that stops sending and cancels the upstream body", async () => {
    let cancelled: unknown;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const response = withIdleTimeout(new Response(stalled, { status: 200 }), 60);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await assert.rejects(reader.read(), (error: unknown) => {
      assert.ok(error instanceof UpstreamTimeoutError);
      assert.equal(error.phase, "idle");
      assert.match(error.message, /--upstream-idle-timeout/);
      return true;
    });
    assert.ok(cancelled instanceof UpstreamTimeoutError);
  });
});

interface Running {
  baseUrl: string;
  calls: RecordedCall[];
  logs: string[];
  close(): Promise<void>;
}

async function start(
  fetchImpl: typeof fetch | undefined,
  timeouts: Partial<UpstreamTimeouts>,
  compat?: LocalCompatMode,
  extra: ProxyAppOptions = {},
): Promise<Running> {
  const calls: RecordedCall[] = [];
  const fake = fakeGrokChat(calls);
  const logs: string[] = [];
  const app = createProxyApp({
    getBearer: fake.getBearer,
    // The real transport (timeouts, retries) on top of a fake network.
    fetchUpstream: (request, { bearer }) => {
      if (request.pathWithQuery === "/v1/language-models" || request.pathWithQuery === "/v1/models") {
        return fake.fetchUpstream(request, { bearer });
      }
      return executeXaiFetch(request, {
        bearer,
        fetchImpl: fetchImpl ?? ((async (_url: unknown, init?: RequestInit) =>
          fake.fetchUpstream({ ...request, body: init?.body ?? null }, { bearer })) as typeof fetch),
        timeouts,
      });
    },
  }, {
    ...(compat ? { compat } : {}),
    trafficLog: new TrafficLogger({ level: "events", write: (line) => logs.push(line), color: false }),
    ...extra,
  });
  const server = await new Promise<http.Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.on("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    logs,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const CHAT = { model: "grok-4.7", stream: false, messages: [{ role: "user", content: "hi" }] };

describe("proxy: upstream timeout → 504", () => {
  const cases: Array<{ name: string; compat?: LocalCompatMode; path: string; body: Json }> = [
    { name: "LM Studio /v1/chat/completions", compat: "lmstudio", path: "/v1/chat/completions", body: CHAT },
    { name: "OpenAI /v1/chat/completions", path: "/v1/chat/completions", body: CHAT },
    { name: "Ollama /api/chat", compat: "ollama", path: "/api/chat", body: CHAT },
    { name: "Anthropic /v1/messages", compat: "lmstudio", path: "/v1/messages", body: { model: "grok-4.7", max_tokens: 50, messages: [{ role: "user", content: "hi" }] } },
    { name: "LM Studio native /api/v1/chat", compat: "lmstudio", path: "/api/v1/chat", body: { model: "grok-4.7", input: "hi" } },
  ];
  for (const testCase of cases) {
    it(`${testCase.name} answers 504 naming the flag and env`, async () => {
      const proxy = await start(hangingFetch(), { nonStreamMs: 80, streamMs: 80 }, testCase.compat);
      try {
        const response = await post(`${proxy.baseUrl}${testCase.path}`, testCase.body);
        assert.equal(response.status, 504);
        const text = await response.text();
        assert.match(text, /--upstream-timeout/);
        assert.match(text, /PROGROK_UPSTREAM_TIMEOUT/);
        const log = proxy.logs.join("\n");
        assert.match(log, /ERROR xAI request failed after \d+ms: Upstream headers timed out/);
        assert.match(log, /504/);
      } finally {
        await proxy.close();
      }
    });
  }

  it("a slow (but in-limit) non-streaming answer reaches the client", async () => {
    const calls: RecordedCall[] = [];
    const fake = fakeGrokChat(calls);
    const slow = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fake.fetchUpstream(
        { pathWithQuery: "/v1/chat/completions", method: "POST", headers: new Headers(), body: init?.body ?? null },
        { bearer: "b" },
      );
    }) as typeof fetch;
    const proxy = await start(slow, { nonStreamMs: 3_000 }, "lmstudio");
    try {
      const response = await post(`${proxy.baseUrl}/v1/chat/completions`, CHAT);
      assert.equal(response.status, 200);
      const json = await response.json() as Json;
      assert.equal(((json.choices as Json[])[0]!.message as Json).content, "Hello from Grok");
    } finally {
      await proxy.close();
    }
  });
});

describe("proxy: client disconnect aborts the xAI request", () => {
  const cases: Array<{ name: string; compat?: LocalCompatMode; path: string; body: Json }> = [
    { name: "LM Studio /v1/chat/completions (stream=false)", compat: "lmstudio", path: "/v1/chat/completions", body: CHAT },
    { name: "OpenAI /v1/chat/completions (stream=true)", path: "/v1/chat/completions", body: { ...CHAT, stream: true } },
    { name: "Ollama /api/chat", compat: "ollama", path: "/api/chat", body: CHAT },
    { name: "LM Studio native /api/v1/chat", compat: "lmstudio", path: "/api/v1/chat", body: { model: "grok-4.7", input: "hi" } },
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const signals: AbortSignal[] = [];
      const proxy = await start(hangingFetch(signals), { nonStreamMs: 0, streamMs: 0 }, testCase.compat);
      try {
        const url = new URL(`${proxy.baseUrl}${testCase.path}`);
        const request = http.request(url, { method: "POST", headers: { "content-type": "application/json" } });
        request.on("error", () => undefined);
        request.end(JSON.stringify(testCase.body));
        const deadline = Date.now() + 2_000;
        while (signals.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.equal(signals.length, 1, "request reached the fake upstream");
        assert.equal(signals[0]!.aborted, false);
        request.destroy();
        while (!signals[0]!.aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.equal(signals[0]!.aborted, true, "upstream signal aborted after the client left");
      } finally {
        await proxy.close();
      }
    });
  }
});

describe("--upstream-stream", () => {
  const requests: Array<{ name: string; body: Json }> = [
    { name: "plain text with reasoning", body: CHAT },
    { name: "non-reasoning model", body: { ...CHAT, model: "grok-4.20-0309-non-reasoning" } },
    {
      name: "parallel tool calls",
      body: {
        ...CHAT,
        messages: [{ role: "user", content: "weather in Warsaw and Krakow?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      },
    },
    {
      name: "after tool results",
      body: {
        ...CHAT,
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_waw", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Warsaw\"}" } }] },
          { role: "tool", tool_call_id: "call_waw", content: "sunny" },
        ],
      },
    },
    { name: "json mode", body: { ...CHAT, response_format: { type: "json_object" } } },
  ];

  for (const compat of ["lmstudio", "ollama"] as const) {
    for (const request of requests) {
      it(`${compat}: ${request.name} — same JSON as a non-streaming upstream call`, async () => {
        const direct = await start(undefined, {}, compat);
        const streamed = await start(undefined, {}, compat, { upstreamStream: true });
        try {
          const a = await post(`${direct.baseUrl}/v1/chat/completions`, request.body);
          const b = await post(`${streamed.baseUrl}/v1/chat/completions`, request.body);
          assert.equal(a.status, 200);
          assert.equal(b.status, 200);
          assert.deepEqual(await b.json(), await a.json());
          const directCall = direct.calls.find((call) => call.path === "/v1/chat/completions")!;
          const streamCall = streamed.calls.find((call) => call.path === "/v1/chat/completions")!;
          assert.notEqual(directCall.json!.stream, true);
          assert.equal(streamCall.json!.stream, true);
          assert.deepEqual(streamCall.json!.stream_options, { include_usage: true });
          assert.match(b.headers.get("content-type") ?? "", /application\/json/);
        } finally {
          await direct.close();
          await streamed.close();
        }
      });
    }
  }

  it("leaves stream=true requests and upstream errors alone", async () => {
    const direct = await start(undefined, {}, "lmstudio");
    const streamed = await start(undefined, {}, "lmstudio", { upstreamStream: true });
    try {
      const sseA = await (await post(`${direct.baseUrl}/v1/chat/completions`, { ...CHAT, stream: true })).text();
      const sseB = await (await post(`${streamed.baseUrl}/v1/chat/completions`, { ...CHAT, stream: true })).text();
      const stable = (text: string) => text.replace(/chatcmpl_progrok_[\w-]+/g, "ID");
      assert.equal(stable(sseB), stable(sseA));
      const errA = await post(`${direct.baseUrl}/v1/chat/completions`, { ...CHAT, model: "missing-model" });
      const errB = await post(`${streamed.baseUrl}/v1/chat/completions`, { ...CHAT, model: "missing-model" });
      assert.equal(errB.status, errA.status);
      assert.deepEqual(await errB.json(), await errA.json());
    } finally {
      await direct.close();
      await streamed.close();
    }
  });

  it("is off by default and does not touch the plain OpenAI listener", async () => {
    const plain = await start(undefined, {}, undefined, { upstreamStream: true });
    const lm = await start(undefined, {}, "lmstudio");
    try {
      await post(`${plain.baseUrl}/v1/chat/completions`, CHAT);
      await post(`${lm.baseUrl}/v1/chat/completions`, CHAT);
      assert.notEqual(plain.calls.find((c) => c.path === "/v1/chat/completions")!.json!.stream, true);
      assert.notEqual(lm.calls.find((c) => c.path === "/v1/chat/completions")!.json!.stream, true);
    } finally {
      await plain.close();
      await lm.close();
    }
  });
});

describe("assembleChatCompletion", () => {
  const sse = (frames: unknown[]): ReadableStream<Uint8Array> =>
    new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("")).body!;

  it("handles xAI's separate usage chunk, extra top-level fields and split tool names", async () => {
    const base = { id: "c1", object: "chat.completion.chunk", created: 7, model: "grok-4.7", system_fingerprint: "fp" };
    const result = await assembleChatCompletion(sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Hm" } }] },
      { ...base, choices: [{ index: 0, delta: { reasoning_content: "m." } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "rea", arguments: "{\"a\":" } }] } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "d", arguments: "1}" } }] } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, citations: ["x"] },
      "[DONE]",
    ]));
    assert.deepEqual(result, {
      id: "c1",
      object: "chat.completion",
      created: 7,
      model: "grok-4.7",
      system_fingerprint: "fp",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      citations: ["x"],
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "Hmm.",
          tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"a\":1}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });

  it("turns an in-stream error into a 502 LocalUpstreamError", async () => {
    await assert.rejects(
      assembleChatCompletion(sse([{ error: { message: "boom" } }])),
      { name: "LocalUpstreamError", status: 502, message: "boom" },
    );
    await assert.rejects(assembleChatCompletion(sse(["[DONE]"])), { status: 502 });
  });
});

describe("upstreamFetch (undici with progrok-managed timeouts)", () => {
  it("talks to a real HTTP server, streams the body and propagates aborts", async () => {
    let serverSawClose = false;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/hang") {
          res.on("close", () => { serverSawClose = true; });
          return;
        }
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${body}\n\n`);
          setTimeout(() => res.end("data: [DONE]\n\n"), 50);
        }, 150);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { upstreamFetch } = await import("../src/transport/timeouts.js");
    try {
      const response = await upstreamFetch(`http://127.0.0.1:${port}/ok`, {
        method: "POST",
        body: new TextEncoder().encode("{\"x\":1}"),
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "data: {\"x\":1}\n\ndata: [DONE]\n\n");

      const controller = new AbortController();
      const pending = upstreamFetch(`http://127.0.0.1:${port}/hang`, {
        method: "POST", body: "{}", signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("client left")), 100);
      await assert.rejects(pending, /client left/);
      const deadline = Date.now() + 2_000;
      while (!serverSawClose && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(serverSawClose, true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
