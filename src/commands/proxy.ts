import { Command } from "commander";
import {
  LMSTUDIO_DEFAULT_PORT,
  OLLAMA_DEFAULT_PORT,
  startProxy,
  type ProxyListener,
} from "../proxy/server.js";
import { REASONING_FORMATS, type ReasoningFormat } from "../proxy/local-request.js";
import { resolveTrafficLogLevel } from "../proxy/traffic-log.js";
import { resolveUsageInterval } from "../proxy/usage-report.js";
import { loadTokens } from "../auth/token-store.js";
import {
  PROXY_DEFAULT_PORT,
  PROXY_DEFAULT_HOST,
} from "../auth/constants.js";
import { log } from "../utils/logger.js";
import { parseIntOrThrow } from "../utils/parse-int.js";

interface ProxyOptions {
  port: string;
  host: string;
  lmstudio?: string | boolean;
  ollama?: string | boolean;
  openai: boolean;
  reasoningFormat?: string;
  verbose?: boolean;
  logBodies?: boolean;
  usage?: boolean;
  usageEvery?: string;
}

/** `--lmstudio` alone means the default port; `--lmstudio 4321` picks one. */
function compatPort(
  value: string | boolean | undefined,
  fallback: number,
  name: string,
): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return fallback;
  return parseIntOrThrow(value, name, 1, 65535);
}

function parseReasoningFormatOrThrow(value: string): ReasoningFormat {
  if (!(REASONING_FORMATS as readonly string[]).includes(value)) {
    throw new Error(`--reasoning-format must be one of ${REASONING_FORMATS.join(", ")}`);
  }
  return value as ReasoningFormat;
}

export function resolveProxyListeners(opts: ProxyOptions): {
  port: number;
  extra: ProxyListener[];
  openai: boolean;
} {
  const extra: ProxyListener[] = [];
  const lmstudio = compatPort(opts.lmstudio, LMSTUDIO_DEFAULT_PORT, "lmstudio");
  const ollama = compatPort(opts.ollama, OLLAMA_DEFAULT_PORT, "ollama");
  const format = opts.reasoningFormat === undefined
    ? undefined
    : parseReasoningFormatOrThrow(opts.reasoningFormat);
  const shared = format ? { reasoningFormat: format } : {};
  if (lmstudio !== undefined) extra.push({ port: lmstudio, compat: "lmstudio", ...shared });
  if (ollama !== undefined) extra.push({ port: ollama, compat: "ollama", ...shared });
  if (!opts.openai && extra.length === 0) {
    throw new Error("--no-openai needs --lmstudio or --ollama");
  }
  const port = parseIntOrThrow(opts.port, "port", 1, 65535);
  const ports = [...(opts.openai ? [port] : []), ...extra.map((entry) => entry.port)];
  if (new Set(ports).size !== ports.length) {
    throw new Error("each listener needs its own port");
  }
  return { port, extra, openai: opts.openai };
}

export function proxyCommand(): Command {
  return new Command("proxy")
    .description(
      `Start OpenAI-compatible proxy server for Grok.
  Forwards ALL /v1/* requests to api.x.ai with your OAuth token injected.
  Any client (curl, OpenAI SDK, LangChain, etc.) can connect — no API key needed.
  Supports streaming (SSE), multipart (stt), and binary responses (tts).

  Local-server emulation for tools that only offer "LM Studio" or "Ollama"
  providers (JetBrains AI Assistant, Junie CLI, ...):
    $ progrok proxy --lmstudio          # also listen on :${LMSTUDIO_DEFAULT_PORT} as LM Studio
    $ progrok proxy --ollama            # also listen on :${OLLAMA_DEFAULT_PORT} as Ollama
    $ progrok proxy --lmstudio 4321 --no-openai

  Traffic log (stderr, one line per event, ids tie lines together):
    $ progrok proxy --verbose           # client request, call to api.x.ai, xAI status/latency/usage, client response
    $ progrok proxy --log-bodies        # also dump redacted request/response bodies
    PROGROK_LOG=1 / PROGROK_LOG=bodies do the same; PROGROK_LOG_MAX_BODY caps each dump (default 4000 chars).

  Usage report (on by default, stderr): subscription usage ~10s after the first
  request, then every 5m but only if requests reached xAI since the last line.
    $ progrok proxy --usage-every 30m   # or 30s, 1h, 1h30m; PROGROK_USAGE_EVERY
    $ progrok proxy --no-usage          # or PROGROK_USAGE_EVERY=off`,
    )
    .option("-p, --port <port>", "Port number", String(PROXY_DEFAULT_PORT))
    .option("--host <host>", "Host to bind", PROXY_DEFAULT_HOST)
    .option(
      "--lmstudio [port]",
      `Also serve the LM Studio API (default port ${LMSTUDIO_DEFAULT_PORT})`,
    )
    .option(
      "--ollama [port]",
      `Also serve the Ollama API (default port ${OLLAMA_DEFAULT_PORT})`,
    )
    .option("--no-openai", "Skip the plain OpenAI listener on --port")
    .option(
      "--reasoning-format <format>",
      "How emulated Chat Completions return reasoning: both | reasoning_content | reasoning | think-tags | none (default both, or PROGROK_REASONING_FORMAT)",
    )
    .option("-v, --verbose", "Log every request, the call to xAI and its result on stderr (or PROGROK_LOG=1)")
    .option("--log-bodies", "With the traffic log, also dump redacted request/response bodies (or PROGROK_LOG=bodies)")
    .option("--usage-every <duration>", "Subscription usage report interval while there is traffic: 10s..24h, e.g. 5m, 1h (default 5m, or PROGROK_USAGE_EVERY)")
    .option("--no-usage", "Do not print the periodic subscription usage report")
    .action(async (opts: ProxyOptions) => {
      const tokens = loadTokens();
      if (!tokens?.accessToken) {
        log.error("Not logged in. Run `progrok login` first.");
        process.exit(1);
      }

      try {
        const listeners = resolveProxyListeners(opts);
        await startProxy(listeners.port, opts.host, listeners.extra, {
          openai: listeners.openai,
          trafficLog: resolveTrafficLogLevel(opts),
          usageEveryMs: resolveUsageInterval(opts),
        });
        await new Promise(() => {});
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
