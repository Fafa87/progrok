import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { proxyCommand } from "../src/commands/proxy.js";
import { createProxyApp, type LocalCompatMode } from "../src/proxy/server.js";
import {
  redactJson,
  redactText,
  renderBody,
  resolveTrafficLogLevel,
  TrafficLogger,
  trafficLogLevelFromEnv,
  type TrafficLogLevel,
} from "../src/proxy/traffic-log.js";
import { fakeGrokChat } from "./helpers/fake-grok-chat.js";

interface Running {
  baseUrl: string;
  lines: string[];
  waitFor(pattern: RegExp, count?: number): Promise<string[]>;
  close(): Promise<void>;
}

async function start(level: TrafficLogLevel, compat?: LocalCompatMode): Promise<Running> {
  const lines: string[] = [];
  const trafficLog = new TrafficLogger({ level, write: (line) => lines.push(line), maxBodyChars: 2_000 });
  const app = createProxyApp(fakeGrokChat(), { ...(compat ? { compat } : {}), trafficLog });
  const server = await new Promise<http.Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.on("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lines,
    async waitFor(pattern, count = 1) {
      for (let i = 0; i < 100; i += 1) {
        const hits = lines.filter((line) => pattern.test(line));
        if (hits.length >= count) return lines;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no log line matching ${pattern}:\n${lines.join("\n")}`);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const TOOLS = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];

describe("traffic log settings", () => {
  it("reads PROGROK_LOG and the CLI flags", () => {
    assert.equal(trafficLogLevelFromEnv(undefined), "off");
    assert.equal(trafficLogLevelFromEnv("0"), "off");
    assert.equal(trafficLogLevelFromEnv("1"), "events");
    assert.equal(trafficLogLevelFromEnv("debug"), "events");
    assert.equal(trafficLogLevelFromEnv("bodies"), "bodies");
    assert.equal(resolveTrafficLogLevel({}, {}), "off");
    assert.equal(resolveTrafficLogLevel({ verbose: true }, {}), "events");
    assert.equal(resolveTrafficLogLevel({ logBodies: true }, {}), "bodies");
    assert.equal(resolveTrafficLogLevel({ verbose: true }, { PROGROK_LOG: "bodies" }), "bodies");
    assert.equal(resolveTrafficLogLevel({}, { PROGROK_LOG: "1" }), "events");
  });

  it("exposes --verbose / -v and --log-bodies on `progrok proxy`", () => {
    const options = proxyCommand().options.map((option) => [option.short, option.long]);
    assert.ok(options.some(([short, long]) => short === "-v" && long === "--verbose"));
    assert.ok(options.some(([, long]) => long === "--log-bodies"));
  });
});

describe("traffic log redaction", () => {
  it("removes credentials, encrypted reasoning and inline data from JSON", () => {
    const redacted = redactJson({
      Authorization: "Bearer abc",
      api_key: "xai-123",
      nested: { access_token: "t", refresh_token: "r", keep: "visible" },
      input: [{ type: "reasoning", encrypted_content: "x".repeat(50) }],
      image: `data:image/png;base64,${"A".repeat(200)}`,
    }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    assert.ok(!text.includes("abc"));
    assert.ok(!text.includes("xai-123"));
    assert.ok(!text.includes("xxxxx"));
    assert.ok(!text.includes("AAAA"));
    assert.ok(text.includes("visible"));
    assert.ok(text.includes("[encrypted 50 chars]"));
  });

  it("redacts bearer tokens and API keys in raw text, and caps dumps", () => {
    const text = redactText(`Authorization: Bearer eyJhbGciOi.payload.sig and xai-${"k".repeat(30)} "encrypted_content":"blob"`);
    assert.ok(!text.includes("eyJhbGciOi"));
    assert.ok(!text.includes("kkkk"));
    assert.ok(!text.includes("blob"));
    assert.match(renderBody("x".repeat(50), 10), /more chars/);
  });
});

describe("traffic log events", () => {
  it("logs client request, xAI call, xAI stream result and client response for an agent turn", async () => {
    const proxy = await start("events", "lmstudio");
    try {
      const res = await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-4.6",
        stream: true,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "weather in Warsaw and Krakow?" }],
        tools: TOOLS,
      }, { authorization: "Bearer client-secret-token-123" });
      await res.text();
      const lines = await proxy.waitFor(/⇐ client/);
      const ids = new Set(lines.map((line) => /\[(#\d+) /.exec(line)?.[1]));
      assert.equal(ids.size, 1);
      assert.ok(lines.every((line) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[#1 lmstudio\]/.test(line)));
      assert.match(lines[0]!, /→ POST \/v1\/chat\/completions model=grok-4\.6 stream=yes messages=1 tools=1 effort=high/);
      assert.ok(lines.some((line) => line.includes("↗ xAI POST https://api.x.ai/v1/chat/completions")));
      const done = lines.find((line) => line.includes("stream done"))!;
      assert.match(done, /ttfb=\d+ms/);
      assert.match(done, /tokens in=11 out=7 reasoning=5/);
      assert.match(done, /finish=tool_calls tool_calls=2/);
      assert.match(lines.at(-1)!, /⇐ client 200 POST \/v1\/chat\/completions total=\d+ms/);
      assert.ok(!lines.join("\n").includes("client-secret-token"));
    } finally {
      await proxy.close();
    }
  });

  it("covers the plain passthrough listener and marks errors", async () => {
    const proxy = await start("events");
    try {
      await (await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "missing-model", messages: [{ role: "user", content: "hi" }],
      })).text();
      const lines = await proxy.waitFor(/⇐/);
      assert.ok(lines.every((line) => line.includes("[#1 openai]")));
      assert.ok(lines.some((line) => /↙ ERROR xAI 404 .*error="The model missing-model does not exist"/.test(line)));
      assert.ok(lines.some((line) => /⇐ ERROR client 404/.test(line)));
    } finally {
      await proxy.close();
    }
  });

  it("logs /v1/responses, /v1/messages, /api/v1/chat and Ollama /api/chat", async () => {
    const proxy = await start("events", "lmstudio");
    try {
      await (await post(`${proxy.baseUrl}/v1/responses`, { model: "grok-4.6", input: "hi", stream: true, tools: TOOLS })).text();
      await (await post(`${proxy.baseUrl}/v1/messages`, { model: "grok-4.6", max_tokens: 64, messages: [{ role: "user", content: "hi" }] })).text();
      await (await post(`${proxy.baseUrl}/api/v1/chat`, { model: "grok-4.6", input: "hi", reasoning: "low" })).text();
      const lines = await proxy.waitFor(/⇐ client/, 3);
      assert.ok(lines.some((line) => /\[#1 lmstudio\] ↙ xAI 200 POST \/v1\/responses stream done .*finish=completed/.test(line)));
      assert.ok(lines.some((line) => /\[#2 lmstudio\] → POST \/v1\/messages model=grok-4\.6 stream=no messages=1/.test(line)));
      assert.ok(lines.some((line) => /\[#3 lmstudio\] → POST \/api\/v1\/chat .*effort=low/.test(line)));
    } finally {
      await proxy.close();
    }
    const ollama = await start("events", "ollama");
    try {
      await (await post(`${ollama.baseUrl}/api/chat`, { model: "grok-4.6", think: "high", messages: [{ role: "user", content: "hi" }] })).text();
      const lines = await ollama.waitFor(/⇐ client/);
      assert.match(lines[0]!, /\[#1 ollama\] → POST \/api\/chat model=grok-4\.6 stream=yes messages=1 effort=high/);
    } finally {
      await ollama.close();
    }
  });

  it("dumps redacted bodies with --log-bodies", async () => {
    const proxy = await start("bodies", "ollama");
    try {
      await (await post(`${proxy.baseUrl}/v1/responses`, {
        model: "grok-4.6", input: "hi", stream: true, store: false, api_key: "xai-should-not-appear-1234567890",
      }, { authorization: "Bearer header-secret-123456" })).text();
      const lines = await proxy.waitFor(/client response body/);
      const all = lines.join("\n");
      assert.ok(all.includes("client request body:"));
      assert.ok(all.includes("xAI request body:"));
      assert.ok(all.includes("\"include\":[\"reasoning.encrypted_content\"]"));
      assert.ok(all.includes("xAI stream assembled: {\"reasoning\":"));
      assert.ok(!all.includes("xai-should-not-appear"));
      assert.ok(!all.includes("header-secret"));
      assert.ok(!/"encrypted_content":"enc:/.test(all));
    } finally {
      await proxy.close();
    }
  });

  it("is silent when off", async () => {
    const proxy = await start("off", "lmstudio");
    try {
      await (await post(`${proxy.baseUrl}/v1/chat/completions`, { model: "grok-4.6", messages: [{ role: "user", content: "hi" }] })).text();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(proxy.lines, []);
    } finally {
      await proxy.close();
    }
  });
});
