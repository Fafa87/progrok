// Manual harness: run the LM Studio / Ollama emulators against an in-process
// fake xAI (tests/helpers/fake-grok-chat.ts) so every endpoint can be poked
// with curl without an xAI login. Never touches api.x.ai.
//
//   PROGROK_LOG=1 npx tsx scripts/mock-local-compat.ts [openaiPort] [lmstudioPort] [ollamaPort]

import { createProxyApp, type LocalCompatMode } from "../src/proxy/server.js";
import { TrafficLogger, trafficLogLevelFromEnv } from "../src/proxy/traffic-log.js";
import { fakeGrokChat } from "../tests/helpers/fake-grok-chat.js";

const [openai = "18645", lmstudio = "1234", ollama = "11434"] = process.argv.slice(2);
const listeners: Array<[number, LocalCompatMode | undefined]> = [
  [Number(openai), undefined],
  [Number(lmstudio), "lmstudio"],
  [Number(ollama), "ollama"],
];

const deps = fakeGrokChat();
const trafficLog = new TrafficLogger({ level: trafficLogLevelFromEnv(process.env["PROGROK_LOG"]) });
for (const [port, compat] of listeners) {
  createProxyApp(deps, { ...(compat ? { compat } : {}), trafficLog }).listen(port, "127.0.0.1", () => {
    console.log(`mock ${compat ?? "openai"} listening on http://127.0.0.1:${port}`);
  });
}
