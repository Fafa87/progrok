import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it, mock } from "node:test";
import { proxyCommand } from "../src/commands/proxy.js";
import { createProxyApp } from "../src/proxy/server.js";
import {
  DEFAULT_USAGE_EVERY_MS,
  formatUsageLine,
  parseUsageInterval,
  resolveUsageInterval,
  UsageReporter,
} from "../src/proxy/usage-report.js";
import { BillingError, fetchBilling, parseBilling } from "../src/transport/billing.js";
import { fakeBillingFetch } from "./helpers/fake-billing.js";
import { fakeGrokChat } from "./helpers/fake-grok-chat.js";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function reporter(intervalMs = 5 * 60_000, init?: Parameters<typeof fakeBillingFetch>[0]) {
  const billing = fakeBillingFetch(init);
  const lines: string[] = [];
  const usage = new UsageReporter({
    intervalMs,
    fetchUsage: () => fetchBilling({ bearer: "oauth-bearer", fetchImpl: billing.fetchImpl }),
    write: (line) => lines.push(line),
  });
  return { billing, lines, usage };
}

async function advance(ms: number): Promise<void> {
  // Step in 1s slices so timers and the async billing fetch interleave.
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    mock.timers.tick(Math.min(1_000, ms - elapsed));
    await settle();
  }
}

describe("usage interval parsing", () => {
  it("accepts durations and off values", () => {
    assert.equal(parseUsageInterval("30s"), 30_000);
    assert.equal(parseUsageInterval("5m"), 300_000);
    assert.equal(parseUsageInterval("1h"), 3_600_000);
    assert.equal(parseUsageInterval("1h30m"), 5_400_000);
    assert.equal(parseUsageInterval("90"), 90_000);
    assert.equal(parseUsageInterval(" 2M "), 120_000);
    assert.equal(parseUsageInterval("0"), 0);
    assert.equal(parseUsageInterval("off"), 0);
  });

  it("rejects garbage and out-of-range values", () => {
    for (const bad of ["", "5x", "-1m", "m5", "5 m", "abc", "5s", "25h"]) {
      assert.throws(() => parseUsageInterval(bad), /usage interval/, bad);
    }
  });

  it("resolves flags over env, with a 5m default", () => {
    assert.equal(resolveUsageInterval({}, {}), DEFAULT_USAGE_EVERY_MS);
    assert.equal(resolveUsageInterval({}, { PROGROK_USAGE_EVERY: "30s" }), 30_000);
    assert.equal(resolveUsageInterval({}, { PROGROK_USAGE_EVERY: "off" }), 0);
    assert.equal(resolveUsageInterval({ usageEvery: "1h" }, { PROGROK_USAGE_EVERY: "30s" }), 3_600_000);
    assert.equal(resolveUsageInterval({ usage: false, usageEvery: "1h" }, {}), 0);
    assert.equal(resolveUsageInterval({ usage: true }, {}), DEFAULT_USAGE_EVERY_MS);
    assert.throws(() => resolveUsageInterval({}, { PROGROK_USAGE_EVERY: "soon" }));
  });

  it("exposes --usage-every and --no-usage on `progrok proxy`", () => {
    const longs = proxyCommand().options.map((option) => option.long);
    assert.ok(longs.includes("--usage-every"));
    assert.ok(longs.includes("--no-usage"));
  });
});

describe("shared billing parser", () => {
  it("parses cents and the period, and rejects unexpected bodies", async () => {
    const { fetchImpl, state } = fakeBillingFetch();
    const summary = await fetchBilling({ bearer: "tok", fetchImpl });
    assert.equal(summary.used, 1_234);
    assert.equal(summary.limit, 5_000);
    assert.equal(summary.remaining, 3_766);
    assert.equal(summary.percent, 25);
    assert.equal(summary.periodStart, "2026-10-01");
    assert.equal(summary.periodEnd, "2026-10-31");
    assert.equal(state.calls[0]!.authorization, "Bearer tok");
    assert.throws(() => parseBilling({}), BillingError);
    assert.throws(() => parseBilling({ config: { used: { val: 1 } } }), /Unexpected billing response format/);
    state.fail = true;
    await assert.rejects(fetchBilling({ bearer: "tok", fetchImpl }), /HTTP 503/);
  });

  it("formats one concise line", () => {
    const line = formatUsageLine(parseBilling({
      config: { monthlyLimit: { val: 5_000 }, used: { val: 1_234 }, billingPeriodStart: "2026-10-01T00:00:00Z", billingPeriodEnd: "2026-10-31T23:59:59Z" },
    }), 42, new Date(2026, 9, 22, 16, 45, 0));
    assert.equal(line, "2026-10-22 16:45:00 usage: $12.34 / $50.00 used (24.7%), $37.66 left, period 2026-10-01..2026-10-31, 42 xAI requests since last report");
  });
});

describe("usage reporter", () => {
  afterEach(() => mock.timers.reset());

  it("stays silent while idle", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { usage, lines, billing } = reporter();
    usage.start();
    await advance(20 * 60_000);
    assert.deepEqual(lines, []);
    assert.equal(billing.state.calls.length, 0);
    usage.stop();
  });

  it("reports ~10s after the first request, then once per interval only with traffic", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: new Date(2026, 9, 22, 16, 40, 0) });
    const { usage, lines, billing } = reporter(5 * 60_000, { step: 100 });
    usage.start();
    usage.noteRequest();
    usage.noteRequest();
    usage.noteRequest();
    await advance(9_000);
    assert.equal(lines.length, 0);
    await advance(1_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^2026-10-22 16:40:10 usage: \$12\.34 \/ \$50\.00 used \(24\.7%\), \$37\.66 left, period 2026-10-01\.\.2026-10-31, 3 xAI requests since last report$/);

    // No traffic: the 5-minute tick is skipped.
    await advance(5 * 60_000);
    assert.equal(lines.length, 1);
    assert.equal(billing.state.calls.length, 1);

    usage.noteRequest();
    await advance(5 * 60_000);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /\$13\.34 \/ \$50\.00 used \(26\.7%\), \$36\.66 left, .* 1 xAI request since last report$/);
    usage.stop();
  });

  it("does nothing when disabled", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { usage, lines, billing } = reporter(0);
    assert.equal(usage.enabled, false);
    usage.start();
    usage.noteRequest();
    await advance(30 * 60_000);
    assert.deepEqual(lines, []);
    assert.equal(billing.state.calls.length, 0);
  });

  it("warns once on billing failures, backs off, and recovers with the full count", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { usage, lines, billing } = reporter(60_000);
    billing.state.fail = "network";
    usage.start();
    usage.noteRequest();
    await advance(10_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /usage: WARNING could not read billing \(Failed to fetch billing data\. \(fetch failed\)\); proxying is unaffected/);

    // Keep traffic flowing for 10 minutes while billing stays down.
    for (let minute = 0; minute < 10; minute += 1) {
      usage.noteRequest();
      await advance(60_000);
    }
    assert.equal(lines.length, 1, "only one warning per failure streak");
    // Back-off: retries at +1m, +2m, +4m … not every minute.
    assert.ok(billing.state.calls.length <= 4, `too many billing calls: ${billing.state.calls.length}`);

    billing.state.fail = false;
    usage.noteRequest();
    await advance(20 * 60_000);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /12 xAI requests since last report$/);
    usage.stop();
  });
});

describe("proxy request counting", () => {
  it("counts requests that reach xAI on any listener, not model listings", async () => {
    const counted: string[] = [];
    const servers: http.Server[] = [];
    try {
      const urls: string[] = [];
      for (const compat of [undefined, "lmstudio", "ollama"] as const) {
        const app = createProxyApp(fakeGrokChat(), {
          ...(compat ? { compat } : {}),
          trafficLog: { level: "off" },
          onUpstreamRequest: (path) => counted.push(path),
        });
        const server = await new Promise<http.Server>((resolve) => {
          const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
        });
        servers.push(server);
        const address = server.address() as { port: number };
        urls.push(`http://127.0.0.1:${address.port}`);
      }
      const body = (path: string) => JSON.stringify({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }], stream: path === "/api/chat" ? false : undefined });
      await (await fetch(`${urls[1]}/v1/models`)).text();
      await (await fetch(`${urls[2]}/api/tags`)).text();
      assert.deepEqual(counted, []);
      await (await fetch(`${urls[0]}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: body("/v1") })).text();
      await (await fetch(`${urls[1]}/api/v0/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: body("/v1") })).text();
      await (await fetch(`${urls[2]}/api/chat`, { method: "POST", body: body("/api/chat") })).text();
      assert.deepEqual(counted, ["/v1/chat/completions", "/v1/chat/completions", "/v1/chat/completions"]);
    } finally {
      for (const server of servers) server.close();
    }
  });
});
