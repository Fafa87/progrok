import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createProxyApp, type LocalCompatMode } from "../src/proxy/server.js";
import type { ReasoningFormat } from "../src/proxy/local-request.js";
import { fakeGrokChat, type RecordedCall } from "./helpers/fake-grok-chat.js";

/**
 * Multi-step agent loops with reasoning through every emulated surface:
 * the client asks, the model reasons and makes two parallel tool calls, the
 * client runs them and sends the results back (with the assistant turn and
 * its reasoning), and the model answers. The fake upstream rejects anything
 * xAI would reject, so a passing loop means the history was translated right.
 */

type Json = Record<string, unknown>;

interface Running {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

async function start(compat: LocalCompatMode, reasoningFormat?: ReasoningFormat): Promise<Running> {
  const calls: RecordedCall[] = [];
  const app = createProxyApp(fakeGrokChat(calls), { compat, ...(reasoningFormat ? { reasoningFormat } : {}) });
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

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sse(text: string): Json[] {
  return text.split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Json);
}

function sseEvents(text: string): Array<{ event: string; data: Json }> {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
    const raw = /^data: (.+)$/m.exec(block)?.[1] ?? "{}";
    return { event, data: JSON.parse(raw) as Json };
  });
}

function upstream(calls: RecordedCall[], path = "/v1/chat/completions"): Json[] {
  return calls.filter((call) => call.path === path).map((call) => call.json!);
}

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}];

const WEATHER: Record<string, string> = { Warsaw: "Warsaw 12C", Krakow: "Krakow 10C" };

/** What an OpenAI client SDK assembles from a chat completion stream. */
function assembleChatStream(chunks: Json[]) {
  let content = "";
  let reasoningContent = "";
  let reasoning = "";
  let finish: string | null = null;
  const calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
  for (const chunk of chunks) {
    const choice = (chunk.choices as Json[] | undefined)?.[0];
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Json;
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    for (const part of (delta.tool_calls as Json[] | undefined) ?? []) {
      const index = part.index as number;
      const fn = (part.function ?? {}) as Json;
      calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (typeof part.id === "string") calls[index]!.id = part.id;
      if (typeof fn.name === "string") calls[index]!.function.name += fn.name;
      if (typeof fn.arguments === "string") calls[index]!.function.arguments += fn.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason as string;
  }
  return { content, reasoningContent, reasoning, finish, calls };
}

function runTools(calls: Array<{ id: string; function: { arguments: string } }>): Json[] {
  return calls.map((call) => ({
    role: "tool",
    tool_call_id: call.id,
    content: WEATHER[(JSON.parse(call.function.arguments) as { city: string }).city]!,
  }));
}

for (const path of ["/v1/chat/completions", "/api/v0/chat/completions"]) {
  describe(`agent loop: LM Studio ${path}`, () => {
    it("streams reasoning and parallel tool calls, then answers from tool results", async () => {
      const proxy = await start("lmstudio");
      try {
        const messages: Json[] = [
          { role: "developer", content: "You are a coding agent." },
          { role: "user", content: "What is the weather in Warsaw and Krakow?" },
        ];
        const first = await post(`${proxy.baseUrl}${path}`, {
          model: "grok-4.6",
          stream: true,
          stream_options: { include_usage: true },
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: true,
          reasoning_effort: "high",
          stop: ["\n\nUser:"],
          presence_penalty: 0.5,
          ttl: 300,
          draft_model: "x",
        });
        assert.equal(first.status, 200);
        const turn1 = assembleChatStream(sse(await first.text()));
        assert.equal(turn1.finish, "tool_calls");
        assert.equal(turn1.reasoningContent, "Effort high. Let me think.");
        assert.equal(turn1.reasoning, turn1.reasoningContent);
        assert.deepEqual(turn1.calls.map((call) => [call.id, call.function.name, call.function.arguments]), [
          ["call_waw", "get_weather", "{\"city\":\"Warsaw\"}"],
          ["call_krk", "get_weather", "{\"city\":\"Krakow\"}"],
        ]);

        const sent1 = upstream(proxy.calls)[0]!;
        assert.equal(sent1.reasoning_effort, "high");
        assert.equal("stop" in sent1, false);
        assert.equal("presence_penalty" in sent1, false);
        assert.equal("ttl" in sent1, false);
        assert.equal((sent1.messages as Json[])[0]!.role, "system");
        assert.equal(sent1.tool_choice, "auto");
        assert.equal(sent1.parallel_tool_calls, true);

        messages.push(
          { role: "assistant", content: "", reasoning_content: turn1.reasoningContent, tool_calls: turn1.calls },
          ...runTools(turn1.calls),
        );
        const second = await post(`${proxy.baseUrl}${path}`, {
          model: "grok-4.6", stream: true, messages, tools: TOOLS, reasoning_effort: "high",
        });
        assert.equal(second.status, 200);
        const turn2 = assembleChatStream(sse(await second.text()));
        assert.equal(turn2.finish, "stop");
        assert.equal(turn2.content, "Weather: Warsaw 12C; Krakow 10C");
        assert.equal(turn2.reasoningContent, "Effort high. Let me think.");

        const sent2 = upstream(proxy.calls)[1]!;
        const assistant = (sent2.messages as Json[])[2]!;
        assert.equal(assistant.reasoning_content, "Effort high. Let me think.");
        assert.equal(assistant.content, null);
        assert.equal((assistant.tool_calls as Json[]).length, 2);
      } finally {
        await proxy.close();
      }
    });

    it("runs the same loop without streaming", async () => {
      const proxy = await start("lmstudio");
      try {
        const messages: Json[] = [{ role: "user", content: "weather in Warsaw and Krakow?" }];
        const first = await (await post(`${proxy.baseUrl}${path}`, {
          model: "grok-4.6", messages, tools: TOOLS, reasoning: { effort: "low" },
        })).json() as Json;
        const choice1 = (first.choices as Json[])[0]!;
        const message1 = choice1.message as Json;
        assert.equal(choice1.finish_reason, "tool_calls");
        assert.equal(message1.reasoning_content, "Effort low. Let me think.");
        assert.equal(message1.reasoning, "Effort low. Let me think.");
        const calls = message1.tool_calls as Array<{ id: string; function: { arguments: string } }>;
        assert.equal(calls.length, 2);
        assert.equal(upstream(proxy.calls)[0]!.reasoning_effort, "low");

        messages.push(message1, ...runTools(calls));
        const second = await (await post(`${proxy.baseUrl}${path}`, { model: "grok-4.6", messages, tools: TOOLS })).json() as Json;
        const message2 = ((second.choices as Json[])[0]!).message as Json;
        assert.equal(message2.content, "Weather: Warsaw 12C; Krakow 10C");
        assert.ok((second.usage as Json).completion_tokens_details);
      } finally {
        await proxy.close();
      }
    });
  });
}

describe("agent loop: reasoning controls and output formats", () => {
  it("drops reasoning_effort for models that reject it and maps LM Studio `reasoning: off`", async () => {
    const proxy = await start("lmstudio");
    try {
      const build = await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-build-0.1", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high",
      });
      assert.equal(build.status, 200);
      assert.equal("reasoning_effort" in upstream(proxy.calls)[0]!, false);

      const off = await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-4.6", messages: [{ role: "user", content: "hi" }], reasoning: "off",
      });
      assert.equal(off.status, 200);
      assert.equal(upstream(proxy.calls)[1]!.reasoning_effort, "low");
    } finally {
      await proxy.close();
    }
  });

  it("can inline reasoning as <think> tags and strips them from returned history", async () => {
    const proxy = await start("lmstudio", "think-tags");
    try {
      const res = await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-4.6", stream: true, messages: [{ role: "user", content: "hi" }],
      });
      const turn = assembleChatStream(sse(await res.text()));
      assert.equal(turn.reasoningContent, "");
      assert.equal(turn.content, "<think>Effort default. Let me think.</think>\n\nHello from Grok");

      await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-4.6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: turn.content },
          { role: "user", content: "again" },
        ],
      });
      const assistant = (upstream(proxy.calls)[1]!.messages as Json[])[1]!;
      assert.equal(assistant.content, "Hello from Grok");
      assert.equal(assistant.reasoning_content, "Effort default. Let me think.");
    } finally {
      await proxy.close();
    }
  });

  it("passes structured output (response_format json_schema) through", async () => {
    const proxy = await start("lmstudio");
    try {
      const format = {
        type: "json_schema",
        json_schema: { name: "a", strict: true, schema: { type: "object", properties: { answer: { type: "string" } } } },
      };
      const res = await (await post(`${proxy.baseUrl}/v1/chat/completions`, {
        model: "grok-4.6", messages: [{ role: "user", content: "hi" }], response_format: format,
      })).json() as Json;
      assert.deepEqual(upstream(proxy.calls)[0]!.response_format, format);
      const content = (((res.choices as Json[])[0]!).message as Json).content as string;
      assert.deepEqual(JSON.parse(content), { answer: "Hello from Grok" });
    } finally {
      await proxy.close();
    }
  });
});

describe("agent loop: Ollama /api/chat", () => {
  it("returns thinking and tool calls, accepts tool results by tool_name, maps think levels", async () => {
    const proxy = await start("ollama");
    try {
      const messages: Json[] = [{ role: "user", content: "weather in Warsaw and Krakow?" }];
      const first = await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-4.6:latest", messages, tools: TOOLS, think: "medium",
      });
      const lines = (await first.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);
      const thinking = lines.map((line) => (line.message as Json).thinking ?? "").join("");
      assert.equal(thinking, "Effort medium. Let me think.");
      const toolLine = lines.find((line) => (line.message as Json).tool_calls)!;
      const toolCalls = (toolLine.message as Json).tool_calls as Array<{ function: { name: string; arguments: Json } }>;
      assert.deepEqual(toolCalls.map((call) => call.function.arguments), [{ city: "Warsaw" }, { city: "Krakow" }]);
      assert.equal(lines.at(-1)!.done_reason, "stop");
      assert.equal(upstream(proxy.calls)[0]!.reasoning_effort, "medium");

      // Ollama clients send calls back without ids and answer by tool_name.
      messages.push(
        {
          role: "assistant",
          content: "",
          thinking,
          tool_calls: toolCalls.map((call) => ({ function: call.function })),
        },
        { role: "tool", tool_name: "get_weather", content: "Warsaw 12C" },
        { role: "tool", tool_name: "get_weather", content: "Krakow 10C" },
      );
      const second = await (await post(`${proxy.baseUrl}/api/chat`, {
        model: "grok-4.6", messages, tools: TOOLS, stream: false, think: false,
      })).json() as Json;
      assert.equal(second.status, undefined);
      const message = second.message as Json;
      assert.equal(message.content, "Weather: Warsaw 12C; Krakow 10C");
      assert.equal(message.thinking, undefined);
      const sent = upstream(proxy.calls)[1]!;
      assert.equal(sent.reasoning_effort, "low");
      const assistant = (sent.messages as Json[])[1]!;
      assert.equal(assistant.reasoning_content, thinking);
    } finally {
      await proxy.close();
    }
  });
});

describe("agent loop: Responses API on the compat listeners", () => {
  it("relays reasoning items and function calls, round-trips encrypted reasoning when store:false", async () => {
    const proxy = await start("lmstudio");
    try {
      const input: Json[] = [{ type: "message", role: "user", content: "weather in Warsaw and Krakow?" }];
      const tools = [{ type: "function", name: "get_weather", parameters: TOOLS[0]!.function.parameters }];
      const first = await post(`${proxy.baseUrl}/v1/responses`, {
        model: "grok-4.6", input, tools, stream: true, store: false, reasoning: { effort: "high" },
      });
      const events = sseEvents(await first.text());
      assert.equal(events[0]!.event, "response.created");
      assert.equal(events.at(-1)!.event, "response.completed");
      const done = events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item as Json);
      assert.deepEqual(done.map((item) => item.type), ["reasoning", "function_call", "function_call"]);
      assert.equal(typeof done[0]!.encrypted_content, "string");
      const sent1 = upstream(proxy.calls, "/v1/responses")[0]!;
      assert.deepEqual(sent1.include, ["reasoning.encrypted_content"]);

      input.push(...done, ...done.filter((item) => item.type === "function_call").map((item) => ({
        type: "function_call_output",
        call_id: item.call_id,
        output: WEATHER[(JSON.parse(item.arguments as string) as { city: string }).city],
      })));
      const second = await (await post(`${proxy.baseUrl}/v1/responses`, {
        model: "grok-4.6", input, tools, store: false,
      })).json() as Json;
      const message = (second.output as Json[]).find((item) => item.type === "message")!;
      assert.equal(((message.content as Json[])[0]!).text, "Weather: Warsaw 12C; Krakow 10C");
    } finally {
      await proxy.close();
    }
  });

  it("continues a stored conversation with previous_response_id", async () => {
    const proxy = await start("ollama");
    try {
      const first = await (await post(`${proxy.baseUrl}/v1/responses`, {
        model: "grok-4.6", input: "weather in Warsaw and Krakow?",
        tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      })).json() as Json;
      const calls = (first.output as Json[]).filter((item) => item.type === "function_call");
      assert.equal(calls.length, 2);
      const second = await (await post(`${proxy.baseUrl}/v1/responses`, {
        model: "grok-4.6",
        previous_response_id: first.id,
        input: calls.map((call) => ({ type: "function_call_output", call_id: call.call_id, output: "sunny" })),
      })).json() as Json;
      const message = (second.output as Json[]).find((item) => item.type === "message")!;
      assert.equal(((message.content as Json[])[0]!).text, "Weather: sunny; sunny");
      assert.equal(upstream(proxy.calls, "/v1/responses")[1]!.previous_response_id, first.id);
    } finally {
      await proxy.close();
    }
  });
});

describe("agent loop: Anthropic /v1/messages", () => {
  const anthropicTools = [{
    name: "get_weather",
    description: "Current weather",
    input_schema: TOOLS[0]!.function.parameters,
  }];

  it("streams thinking and tool_use blocks, then answers from tool_result blocks", async () => {
    const proxy = await start("lmstudio");
    try {
      const messages: Json[] = [{ role: "user", content: "weather in Warsaw and Krakow?" }];
      const first = await post(`${proxy.baseUrl}/v1/messages`, {
        model: "grok-4.6",
        max_tokens: 1024,
        system: "You are an agent.",
        stream: true,
        thinking: { type: "enabled", budget_tokens: 10_000 },
        tools: anthropicTools,
        messages,
      }, { "anthropic-version": "2023-06-01", "x-api-key": "local" });
      assert.equal(first.status, 200);
      const events = sseEvents(await first.text());
      assert.equal(events[0]!.event, "message_start");
      assert.equal(events.at(-1)!.event, "message_stop");
      const blocks: Json[] = [];
      for (const { event, data } of events) {
        if (event === "content_block_start") blocks[data.index as number] = { ...(data.content_block as Json) };
        if (event === "content_block_delta") {
          const block = blocks[data.index as number]!;
          const delta = data.delta as Json;
          if (delta.type === "thinking_delta") block.thinking = `${String(block.thinking ?? "")}${String(delta.thinking)}`;
          if (delta.type === "signature_delta") block.signature = delta.signature;
          if (delta.type === "text_delta") block.text = `${String(block.text ?? "")}${String(delta.text)}`;
          if (delta.type === "input_json_delta") block.partial = `${String(block.partial ?? "")}${String(delta.partial_json)}`;
        }
      }
      const delta = events.find((e) => e.event === "message_delta")!.data.delta as Json;
      assert.equal(delta.stop_reason, "tool_use");
      assert.deepEqual(blocks.map((block) => block.type), ["thinking", "tool_use", "tool_use"]);
      assert.equal(blocks[0]!.thinking, "Effort medium. Let me think.");
      const toolUses = blocks.slice(1).map((block) => ({
        type: "tool_use", id: block.id, name: block.name, input: JSON.parse(block.partial as string) as Json,
      }));
      assert.deepEqual(toolUses.map((block) => block.input), [{ city: "Warsaw" }, { city: "Krakow" }]);
      const sent1 = upstream(proxy.calls)[0]!;
      assert.equal(sent1.max_completion_tokens, 1024);
      assert.equal((sent1.messages as Json[])[0]!.role, "system");

      messages.push(
        { role: "assistant", content: [{ type: "thinking", thinking: blocks[0]!.thinking, signature: blocks[0]!.signature }, ...toolUses] },
        {
          role: "user",
          content: toolUses.map((block) => ({
            type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: WEATHER[(block.input as { city: string }).city] }],
          })),
        },
      );
      const second = await (await post(`${proxy.baseUrl}/v1/messages`, {
        model: "grok-4.6", max_tokens: 1024, tools: anthropicTools, messages,
      })).json() as Json;
      assert.equal(second.type, "message");
      assert.equal(second.stop_reason, "end_turn");
      const text = (second.content as Json[]).find((block) => block.type === "text")!;
      assert.equal(text.text, "Weather: Warsaw 12C; Krakow 10C");
      const sent2 = upstream(proxy.calls)[1]!.messages as Json[];
      assert.equal(sent2[1]!.reasoning_content, "Effort medium. Let me think.");
      assert.deepEqual(sent2.slice(2).map((m) => m.role), ["tool", "tool"]);
    } finally {
      await proxy.close();
    }
  });

  it("counts tokens", async () => {
    const proxy = await start("ollama");
    try {
      const res = await (await post(`${proxy.baseUrl}/v1/messages/count_tokens`, {
        model: "grok-4.6", messages: [{ role: "user", content: "hello there" }],
      })).json() as Json;
      assert.equal(typeof res.input_tokens, "number");
    } finally {
      await proxy.close();
    }
  });
});

describe("agent loop: LM Studio native /api/v1/chat", () => {
  it("is stateful through previous_response_id and streams reasoning events", async () => {
    const proxy = await start("lmstudio");
    try {
      const first = await (await post(`${proxy.baseUrl}/api/v1/chat`, {
        model: "grok-4.6", system_prompt: "Be brief.", input: "hi", reasoning: "high",
      })).json() as Json;
      assert.deepEqual((first.output as Json[]).map((item) => item.type), ["reasoning", "message"]);
      assert.equal(typeof first.response_id, "string");
      assert.equal((first.stats as Json).reasoning_output_tokens, 5);

      const second = await post(`${proxy.baseUrl}/api/v1/chat`, {
        model: "grok-4.6", input: "again", previous_response_id: first.response_id, stream: true,
      });
      const events = sseEvents(await second.text()).map((e) => e.event);
      assert.equal(events[0], "chat.start");
      assert.ok(events.indexOf("reasoning.start") < events.indexOf("reasoning.end"));
      assert.ok(events.indexOf("reasoning.end") < events.indexOf("message.start"));
      assert.equal(events.at(-1), "chat.end");
      const sent = upstream(proxy.calls)[1]!.messages as Json[];
      assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "user"]);
      assert.equal(sent[2]!.reasoning_content, "Effort high. Let me think.");

      const missing = await post(`${proxy.baseUrl}/api/v1/chat`, {
        model: "grok-4.6", input: "x", previous_response_id: "resp_nope",
      });
      assert.equal(missing.status, 404);
    } finally {
      await proxy.close();
    }
  });
});
