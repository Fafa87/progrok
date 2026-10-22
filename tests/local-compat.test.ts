import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { resolveProxyListeners } from "../src/commands/proxy.js";
import { sanitizeLmStudioRequest } from "../src/proxy/lmstudio.js";
import { normalizeLocalModelId } from "../src/proxy/local-models.js";
import {
  translateOllamaMessages,
  translateOllamaParams,
} from "../src/proxy/ollama.js";
import {
  createProxyApp,
  type LocalCompatMode,
} from "../src/proxy/server.js";
import { fakeGrokChat, type RecordedCall } from "./helpers/fake-grok-chat.js";

interface Running {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

async function start(compat?: LocalCompatMode): Promise<Running> {
  const calls: RecordedCall[] = [];
  const app = createProxyApp(fakeGrokChat(calls), compat ? { compat } : {});
  const server = await new Promise<http.Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.on("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function ndjson(text: string): Array<Record<string, unknown>> {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sseData(text: string): string[] {
  return text.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function chatCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((entry) => entry.path === "/v1/chat/completions");
  assert.ok(call, "expected an upstream chat call");
  return call;
}

describe("local-server emulation: plain proxy stays unchanged", () => {
  it("does not answer LM Studio or Ollama paths without a compat mode", async () => {
    const proxy = await start();
    try {
      assert.equal((await fetch(`${proxy.baseUrl}/api/tags`)).status, 404);
      assert.equal((await fetch(`${proxy.baseUrl}/api/v0/models`)).status, 404);
      assert.equal((await fetch(`${proxy.baseUrl}/`)).status, 404);
    } finally {
      await proxy.close();
    }
  });
});

describe("local-server emulation: LM Studio", () => {
  it("lists chat models in the REST v0 shape without media models", async () => {
    const proxy = await start("lmstudio");
    try {
      const res = await fetch(`${proxy.baseUrl}/api/v0/models`);
      assert.equal(res.status, 200);
      const body = await res.json() as { object: string; data: Array<Record<string, unknown>> };
      assert.equal(body.object, "list");
      assert.deepEqual(body.data.map((m) => m.id), [
        "grok-4.6",
        "grok-build-0.1",
        "grok-4.20-0309-non-reasoning",
      ]);
      const first = body.data[0]!;
      assert.equal(first.object, "model");
      assert.equal(first.type, "vlm");
      assert.equal(first.state, "loaded");
      assert.equal(first.max_context_length, 500_000);
      assert.equal(body.data[1]!.type, "llm");

      const one = await fetch(`${proxy.baseUrl}/api/v0/models/grok-build-0.1`);
      assert.equal((await one.json() as Record<string, unknown>).max_context_length, 256_000);
    } finally {
      await proxy.close();
    }
  });

  it("lists models in the REST v1 shape", async () => {
    const proxy = await start("lmstudio");
    try {
      const body = await (await fetch(`${proxy.baseUrl}/api/v1/models`)).json() as {
        models: Array<Record<string, unknown>>;
      };
      assert.equal(body.models[0]!.key, "grok-4.6");
      assert.equal(body.models[0]!.type, "llm");
      assert.deepEqual(
        (body.models[0]!.capabilities as Record<string, unknown>).vision,
        true,
      );
    } finally {
      await proxy.close();
    }
  });

  it("serves OpenAI /v1/models with chat models only for Junie discovery", async () => {
    for (const mode of ["lmstudio", "ollama"] as const) {
      const proxy = await start(mode);
      try {
        const res = await fetch(`${proxy.baseUrl}/v1/models`);
        const body = await res.json() as { object: string; data: Array<{ id: string; object: string }> };
        assert.equal(body.object, "list");
        assert.deepEqual(body.data.map((m) => m.id), [
          "grok-4.6",
          "grok-build-0.1",
          "grok-4.20-0309-non-reasoning",
        ]);
        assert.equal(body.data[0]!.object, "model");
        assert.equal(proxy.calls[0]!.bearer, "test-bearer");
      } finally {
        await proxy.close();
      }
    }
  });

  it("falls back to the pinned catalog when xAI cannot list models", async () => {
    const app = createProxyApp({
      getBearer: async () => { throw new Error("not logged in"); },
      fetchUpstream: async () => { throw new Error("unreachable"); },
    }, { compat: "lmstudio" });
    const server = await new Promise<http.Server>((resolve) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    try {
      const { port } = server.address() as { port: number };
      const body = await (await fetch(`http://127.0.0.1:${port}/api/v0/models`)).json() as {
        data: Array<{ id: string }>;
      };
      assert.ok(body.data.some((m) => m.id === "grok-4.6"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams /api/v0/chat/completions as OpenAI SSE with sanitized params and no client auth", async () => {
    const proxy = await start("lmstudio");
    try {
      const res = await post(`${proxy.baseUrl}/api/v0/chat/completions`, {
        model: "xai/grok-4.6",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: -1,
        temperature: 1,
        ttl: 300,
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const lines = sseData(await res.text());
      assert.equal(lines.at(-1), "[DONE]");
      const text = lines.slice(0, -1)
        .map((line) => JSON.parse(line) as { choices: Array<{ delta: { content?: string } }> })
        .map((chunk) => chunk.choices[0]?.delta.content ?? "")
        .join("");
      assert.equal(text, "Hello from Grok");

      const call = chatCall(proxy.calls);
      assert.equal(call.bearer, "test-bearer");
      assert.equal(call.json!.model, "grok-4.6");
      assert.equal("max_tokens" in call.json!, false);
      assert.equal("ttl" in call.json!, false);
      assert.equal(call.json!.temperature, 1);
    } finally {
      await proxy.close();
    }
  });

  it("forwards tool calls on /v1/chat/completions unchanged for Junie", async () => {
    const proxy = await start("lmstudio");
    try {
      const res = await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-build-0.1",
        stream: true,
        messages: [{ role: "user", content: "weather in Warsaw?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      });
      const chunks = sseData(await res.text()).filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line) as { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> });
      const toolDeltas = chunks.flatMap((chunk) =>
        (chunk.choices[0]?.delta.tool_calls as Array<{ index: number; function: { name?: string; arguments?: string } }> | undefined) ?? []);
      assert.equal(toolDeltas[0]!.function.name, "get_weather");
      assert.equal(toolDeltas.filter((d) => d.index === 0).map((d) => d.function.arguments ?? "").join(""), "{\"city\":\"Warsaw\"}");
      assert.equal(chunks.at(-1)!.choices[0]!.finish_reason, "tool_calls");
    } finally {
      await proxy.close();
    }
  });

  it("accepts a chat body sent without a content type", async () => {
    const proxy = await start("lmstudio");
    try {
      const res = await fetch(`${proxy.baseUrl}/api/v0/chat/completions`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: -1 }),
      });
      assert.equal(res.status, 200);
      const call = chatCall(proxy.calls);
      assert.equal(call.headers.get("content-type"), "application/json");
      assert.equal("max_tokens" in call.json!, false);
    } finally {
      await proxy.close();
    }
  });

  it("serves legacy /api/v0/completions through Chat, streaming and not", async () => {
    const proxy = await start("lmstudio");
    try {
      const streamed = await post(`${proxy.baseUrl}/api/v0/completions`, {
        model: "grok-4.6",
        prompt: "function add(a, b) {",
        suffix: "}",
        stream: true,
        max_tokens: -1,
      });
      const lines = sseData(await streamed.text());
      assert.equal(lines.at(-1), "[DONE]");
      const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as {
        object: string;
        choices: Array<{ text: string; finish_reason: string | null }>;
      });
      assert.equal(chunks[0]!.object, "text_completion");
      assert.equal(chunks.map((c) => c.choices[0]!.text).join(""), "Hello from Grok");
      assert.equal(chunks.at(-1)!.choices[0]!.finish_reason, "stop");
      const call = chatCall(proxy.calls);
      const messages = call.json!.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0]!.role, "system");
      assert.match(messages[1]!.content, /<PREFIX>[\s\S]*function add[\s\S]*<SUFFIX>/);
      assert.equal(call.json!.stream, true);

      const plain = await post(`${proxy.baseUrl}/api/v0/completions`, {
        model: "grok-4.6",
        prompt: "1, 2, 3,",
      });
      const body = await plain.json() as {
        choices: Array<{ text: string }>;
        usage: { total_tokens: number };
      };
      assert.equal(body.choices[0]!.text, "Hello from Grok");
      assert.equal(body.usage.total_tokens, 18);
    } finally {
      await proxy.close();
    }
  });
});

describe("local-server emulation: Ollama", () => {
  it("answers the liveness, version, tags, ps and show probes", async () => {
    const proxy = await start("ollama");
    try {
      const root = await fetch(`${proxy.baseUrl}/`);
      assert.equal(await root.text(), "Ollama is running");
      const version = await (await fetch(`${proxy.baseUrl}/api/version`)).json() as { version: string };
      assert.match(version.version, /^\d+\.\d+\.\d+$/);

      const tags = await (await fetch(`${proxy.baseUrl}/api/tags`)).json() as {
        models: Array<Record<string, unknown>>;
      };
      assert.deepEqual(tags.models.map((m) => m.name), [
        "grok-4.6",
        "grok-build-0.1",
        "grok-4.20-0309-non-reasoning",
      ]);
      assert.equal(tags.models[0]!.model, "grok-4.6");
      assert.ok((tags.models[0]!.details as Record<string, unknown>).family);

      const ps = await (await fetch(`${proxy.baseUrl}/api/ps`)).json() as {
        models: Array<Record<string, unknown>>;
      };
      assert.equal(ps.models[0]!.context_length, 500_000);

      const show = await (await post(`${proxy.baseUrl}/api/show`, { model: "grok-4.6:latest" })).json() as {
        capabilities: string[];
        model_info: Record<string, unknown>;
      };
      assert.deepEqual(show.capabilities, ["completion", "tools", "vision", "thinking"]);
      assert.equal(show.model_info["grok.context_length"], 500_000);
      assert.equal(show.model_info["general.architecture"], "grok");
    } finally {
      await proxy.close();
    }
  });

  it("streams /api/chat as NDJSON with thinking, text and a final done line", async () => {
    const proxy = await start("ollama");
    try {
      const res = await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-4.6:latest",
        messages: [{ role: "user", content: "hi" }],
        think: true,
        options: { temperature: 0.2, num_predict: 64 },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/x-ndjson");
      const lines = ndjson(await res.text());
      const messages = lines.map((line) => line.message as Record<string, unknown>);
      assert.equal(messages.map((m) => m.thinking ?? "").join(""), "Effort default. Let me think.");
      assert.equal(messages.map((m) => m.content).join(""), "Hello from Grok");
      const last = lines.at(-1)!;
      assert.equal(last.done, true);
      assert.equal(last.done_reason, "stop");
      assert.equal(last.prompt_eval_count, 11);
      assert.equal(last.eval_count, 7);
      assert.equal(last.model, "grok-4.6");
      assert.ok(lines.slice(0, -1).every((line) => line.done === false));

      const call = chatCall(proxy.calls);
      assert.equal(call.json!.model, "grok-4.6");
      assert.equal(call.json!.temperature, 0.2);
      assert.equal(call.json!.max_tokens, 64);
      assert.equal(call.json!.stream, true);
    } finally {
      await proxy.close();
    }
  });

  it("returns one JSON object for stream:false and hides thinking unless think is set", async () => {
    const proxy = await start("ollama");
    try {
      const res = await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-4.6",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      });
      const body = await res.json() as { message: Record<string, unknown>; done: boolean };
      assert.equal(body.done, true);
      assert.equal(body.message.content, "Hello from Grok");
      assert.equal("thinking" in body.message, false);
    } finally {
      await proxy.close();
    }
  });

  it("emits whole tool calls with object arguments", async () => {
    const proxy = await start("ollama");
    try {
      const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];
      const streamed = ndjson(await (await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-build-0.1",
        messages: [{ role: "user", content: "weather in Warsaw?" }],
        tools,
      })).text());
      const toolLine = streamed.find((line) => (line.message as Record<string, unknown>)?.tool_calls);
      assert.ok(toolLine);
      const calls = (toolLine.message as { tool_calls: Array<{ function: Record<string, unknown> }> }).tool_calls;
      assert.equal(calls[0]!.function.name, "get_weather");
      assert.deepEqual(calls[0]!.function.arguments, { city: "Warsaw" });
      assert.deepEqual(chatCall(proxy.calls).json!.tools, tools);

      const whole = await (await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-build-0.1",
        stream: false,
        messages: [{ role: "user", content: "weather in Warsaw?" }],
        tools,
      })).json() as { message: { tool_calls: Array<{ function: Record<string, unknown> }> } };
      assert.deepEqual(whole.message.tool_calls[0]!.function.arguments, { city: "Warsaw" });
    } finally {
      await proxy.close();
    }
  });

  it("streams /api/generate with response fields", async () => {
    const proxy = await start("ollama");
    try {
      const lines = ndjson(await (await post(`${proxy.baseUrl}/api/generate`, {
        model: "grok-4.20-0309-non-reasoning",
        prompt: "def add(a, b):",
        suffix: "\n\nprint(add(1, 2))",
        system: "Python only",
      })).text());
      assert.equal(lines.map((line) => line.response).join(""), "Hello from Grok");
      assert.equal(lines.at(-1)!.done, true);
      const messages = chatCall(proxy.calls).json!.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0]!.role, "system");
      assert.match(messages[0]!.content, /^Python only/);
      assert.match(messages[1]!.content, /<SUFFIX>/);
    } finally {
      await proxy.close();
    }
  });

  it("maps upstream refusals to Ollama error bodies with the upstream status", async () => {
    const proxy = await start("ollama");
    try {
      const res = await post(`${proxy.baseUrl}/api/chat`, {
        model: "missing-model",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "The model missing-model does not exist" });
    } finally {
      await proxy.close();
    }
  });

  it("answers an empty chat as a model load", async () => {
    const proxy = await start("ollama");
    try {
      const body = await (await post(`${proxy.baseUrl}/api/chat`, { model: "grok-4.6", messages: [] })).json() as Record<string, unknown>;
      assert.equal(body.done_reason, "load");
      assert.equal(proxy.calls.some((call) => call.path === "/v1/chat/completions"), false);
    } finally {
      await proxy.close();
    }
  });
});

describe("local-server emulation: translation units", () => {
  it("rebuilds tool-call history with ids for Ollama tool results", () => {
    const out = translateOllamaMessages([
      { role: "user", content: "look", images: ["iVBORw0KGgo="] },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Warsaw" } } }] },
      { role: "tool", tool_name: "get_weather", content: "12C" },
    ]);
    assert.deepEqual(out[0]!.content, [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
    const calls = out[1]!.tool_calls as Array<{ id: string; function: { arguments: string } }>;
    assert.equal(calls[0]!.function.arguments, "{\"city\":\"Warsaw\"}");
    assert.equal(out[2]!.tool_call_id, calls[0]!.id);
  });

  it("maps Ollama options and formats", () => {
    assert.deepEqual(translateOllamaParams({
      options: { temperature: 0.1, top_p: 0.9, num_predict: -1, seed: 7, stop: ["\n"] },
      format: "json",
    }), {
      temperature: 0.1,
      top_p: 0.9,
      seed: 7,
      stop: ["\n"],
      response_format: { type: "json_object" },
    });
    const schema = { type: "object" };
    assert.deepEqual(translateOllamaParams({ format: schema }).response_format, {
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
  });

  it("sanitizes LM Studio runtime knobs and model names", () => {
    assert.deepEqual(sanitizeLmStudioRequest({
      model: "grok-4.6:latest",
      max_tokens: -1,
      top_k: 40,
      repeat_penalty: 1.1,
      temperature: 0.7,
    }), { model: "grok-4.6", temperature: 0.7 });
    assert.equal(normalizeLocalModelId("xai/grok-build-0.1"), "grok-build-0.1");
  });

  it("resolves CLI listener flags", () => {
    const base = { port: "18645", host: "127.0.0.1", openai: true };
    assert.deepEqual(resolveProxyListeners({ ...base, lmstudio: true }).extra, [
      { port: 1234, compat: "lmstudio" },
    ]);
    assert.deepEqual(resolveProxyListeners({ ...base, lmstudio: "4321", ollama: true }).extra, [
      { port: 4321, compat: "lmstudio" },
      { port: 11434, compat: "ollama" },
    ]);
    assert.throws(() => resolveProxyListeners({ ...base, openai: false }), /--no-openai/);
    assert.throws(() => resolveProxyListeners({ ...base, lmstudio: "18645" }), /own port/);
  });
});

describe("progrok proxy --reasoning-format", () => {
  it("applies the format to compat listeners and rejects unknown values", () => {
    const listeners = resolveProxyListeners({
      port: "18645", host: "127.0.0.1", openai: true, lmstudio: true, reasoningFormat: "think-tags",
    });
    assert.equal(listeners.extra[0]!.reasoningFormat, "think-tags");
    assert.throws(() => resolveProxyListeners({
      port: "18645", host: "127.0.0.1", openai: true, lmstudio: true, reasoningFormat: "xml",
    }), /--reasoning-format/);
  });
});
