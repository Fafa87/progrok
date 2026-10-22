import { Command } from "commander";
import {
  LMSTUDIO_DEFAULT_PORT,
  OLLAMA_DEFAULT_PORT,
  startProxy,
  type ProxyListener,
} from "../proxy/server.js";
import { REASONING_FORMATS, type ReasoningFormat } from "../proxy/local-request.js";
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
    $ progrok proxy --lmstudio 4321 --no-openai`,
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
        });
        await new Promise(() => {});
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
