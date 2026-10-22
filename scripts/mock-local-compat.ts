// Manual harness: run the LM Studio / Ollama emulators against an in-process
// fake xAI (tests/helpers/fake-grok-chat.ts) so every endpoint can be poked
// with curl without an xAI login. Never touches api.x.ai.
//
//   PROGROK_LOG=1 npx tsx scripts/mock-local-compat.ts [openaiPort] [lmstudioPort] [ollamaPort]

import { createProxyApp, type LocalCompatMode } from "../src/proxy/server.js";
import { TrafficLogger, trafficLogLevelFromEnv } from "../src/proxy/traffic-log.js";
import { resolveUsageInterval, UsageReporter } from "../src/proxy/usage-report.js";
import { fetchBilling } from "../src/transport/billing.js";
import { fakeBillingFetch } from "../tests/helpers/fake-billing.js";
import { fakeGrokChat } from "../tests/helpers/fake-grok-chat.js";

const [openai = "18645", lmstudio = "1234", ollama = "11434"] = process.argv.slice(2);
const listeners: Array<[number, LocalCompatMode | undefined]> = [
  [Number(openai), undefined],
  [Number(lmstudio), "lmstudio"],
  [Number(ollama), "ollama"],
];

const deps = fakeGrokChat();
// Fake billing endpoint (cents, like the real one); usage grows per read.
const billing = fakeBillingFetch({ limit: 5_000, used: 1_234, step: 37 });
const usage = new UsageReporter({
  intervalMs: resolveUsageInterval({}, process.env),
  fetchUsage: () => fetchBilling({ bearer: "fake", fetchImpl: billing.fetchImpl }),
  ...(process.env["PROGROK_USAGE_FIRST_DELAY_MS"]
    ? { firstReportDelayMs: Number(process.env["PROGROK_USAGE_FIRST_DELAY_MS"]) }
    : {}),
});
usage.start();
const trafficLog = new TrafficLogger({ level: trafficLogLevelFromEnv(process.env["PROGROK_LOG"]) });
for (const [port, compat] of listeners) {
  createProxyApp(deps, {
    ...(compat ? { compat } : {}),
    trafficLog,
    ...(usage.enabled ? { onUpstreamRequest: () => usage.noteRequest() } : {}),
  }).listen(port, "127.0.0.1", () => {
    console.log(`mock ${compat ?? "openai"} listening on http://127.0.0.1:${port}`);
  });
}
