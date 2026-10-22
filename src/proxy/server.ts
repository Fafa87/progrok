import express, { type Request, type Response } from "express";
import {
  XAI_API_BASE_URL,
  PROXY_DEFAULT_PORT,
  PROXY_DEFAULT_HOST,
} from "../auth/constants.js";
import { getValidBearerSnapshot } from "../auth/token-manager.js";
import { executeXaiFetch } from "../transport/fetch.js";
import { log } from "../utils/logger.js";
import { PayloadTooLargeError, readBoundedBody } from "./body.js";
import {
  TrafficLogger,
  trafficLogLevelFromEnv,
  type TrafficLogLevel,
  type TrafficLogOptions,
} from "./traffic-log.js";
import { prepareGrokRequestObject } from "./composer-inject.js";
import { serveNativeStream } from "./native-stream.js";
import { createLmStudioRouter, type ForwardToProxy } from "./lmstudio.js";
import { createAnthropicRouter } from "./anthropic.js";
import { createLmStudioNativeChatRouter } from "./lmstudio-chat.js";
import { LocalModelCatalog } from "./local-models.js";
import {
  COMPAT_RESPONSES_ROUTE,
  compatChatRoute,
  parseReasoningFormat,
  type LocalProxyRoute,
  type ReasoningFormat,
} from "./local-request.js";
import { createOllamaRouter } from "./ollama.js";
import { safeErrorMessage } from "./redact.js";
import { filterRequestHeaders, relayUpstreamResponse } from "./relay.js";
import { decideProxyRoute } from "./route-policy.js";

/** Local model servers this proxy can impersonate on an extra listener. */
export type LocalCompatMode = "lmstudio" | "ollama";

export const LMSTUDIO_DEFAULT_PORT = 1234;
export const OLLAMA_DEFAULT_PORT = 11434;

/** Native routes each emulated local server answers in addition to `/v1/*`. */
export const LOCAL_COMPAT_ENDPOINTS: Record<LocalCompatMode, string[]> = {
  lmstudio: [
    "GET /v1/models",
    "POST /v1/chat/completions",
    "POST /v1/responses",
    "POST /v1/messages",
    "POST /v1/messages/count_tokens",
    "POST /api/v1/chat",
    "GET /api/v0/models",
    "GET /api/v0/models/{model}",
    "GET /api/v1/models",
    "POST /api/v0/chat/completions",
    "POST /api/v0/completions",
    "POST /api/v0/embeddings",
    "POST /v1/completions",
  ],
  ollama: [
    "GET /",
    "GET /api/version",
    "GET /api/tags",
    "GET /v1/models",
    "POST /v1/chat/completions",
    "POST /v1/responses",
    "POST /v1/messages",
    "POST /v1/messages/count_tokens",
    "GET /api/ps",
    "POST /api/show",
    "POST /api/chat",
    "POST /api/generate",
  ],
};

export interface ProxyAppOptions {
  /**
   * Also answer a local model server's native API. Off by default: the web app
   * mounts this same app and owns `GET /`, which Ollama emulation would take.
   */
  compat?: LocalCompatMode;
  /**
   * How emulated Chat Completions return reasoning. Defaults to
   * `PROGROK_REASONING_FORMAT`, else `both` (`reasoning_content` + `reasoning`).
   */
  reasoningFormat?: ReasoningFormat;
  /**
   * Traffic log (`--verbose` / `--log-bodies`). A logger is shared between
   * listeners so exchange ids stay unique; options build a new one. Defaults
   * to `PROGROK_LOG`.
   */
  trafficLog?: TrafficLogger | TrafficLogOptions;
}

type ProxyRoute = LocalProxyRoute;

export interface ProxyAppDependencies {
  getBearer(): Promise<string>;
  fetchUpstream: typeof executeXaiFetch;
}

const DEFAULT_DEPS: ProxyAppDependencies = {
  getBearer: async () => (await getValidBearerSnapshot()).bearer,
  fetchUpstream: executeXaiFetch,
};

function sendUpstreamError(res: Response, error: unknown): void {
  if (res.destroyed) return;
  if (!res.headersSent) {
    res.status(502).json({
      error: {
        message: `Upstream error: ${safeErrorMessage(error)}`,
        type: "upstream_error",
      },
    });
    return;
  }
  log.dim(
    `[progrok] stream interrupted after response commit: ${safeErrorMessage(error)}`,
  );
  res.end();
}

export function createProxyApp(
  deps?: Partial<ProxyAppDependencies>,
  options: ProxyAppOptions = {},
): express.Express {
  const traffic = options.trafficLog instanceof TrafficLogger
    ? options.trafficLog
    : new TrafficLogger(options.trafficLog ?? { level: trafficLogLevelFromEnv(process.env["PROGROK_LOG"]) });
  const resolvedDeps: ProxyAppDependencies = {
    getBearer: deps?.getBearer ?? DEFAULT_DEPS.getBearer,
    fetchUpstream: traffic.wrapFetch(deps?.fetchUpstream ?? DEFAULT_DEPS.fetchUpstream),
  };
  const app = express();
  app.use(traffic.middleware(options.compat ?? "openai"));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", upstream: "xAI Grok", proxy: "progrok" });
  });

  if (options.compat) {
    const catalog = new LocalModelCatalog(resolvedDeps);
    const format = options.reasoningFormat
      ?? parseReasoningFormat(process.env["PROGROK_REASONING_FORMAT"], "both");
    const chatRoute = compatChatRoute(format);
    const forward: ForwardToProxy = (req, res, route) => {
      void handleProxy(req, res, resolvedDeps, route).catch((error: unknown) => {
        sendUpstreamError(res, error);
      });
    };
    // Agent-facing OpenAI and Anthropic surfaces, on both emulated servers.
    app.post("/v1/chat/completions", (req, res) => forward(req, res, chatRoute));
    app.post("/v1/responses", (req, res) => forward(req, res, COMPAT_RESPONSES_ROUTE));
    app.use(createAnthropicRouter(resolvedDeps));
    app.use(options.compat === "lmstudio"
      ? createLmStudioRouter(resolvedDeps, forward, chatRoute, catalog)
      : createOllamaRouter(resolvedDeps, catalog));
    if (options.compat === "lmstudio") {
      app.use(createLmStudioNativeChatRouter(resolvedDeps));
    }
  }

  app.all("/v1/*", (req: Request, res: Response) => {
    void handleProxy(req, res, resolvedDeps).catch((error: unknown) => {
      sendUpstreamError(res, error);
    });
  });

  return app;
}

async function handleProxy(
  req: Request,
  res: Response,
  deps: ProxyAppDependencies,
  route?: ProxyRoute,
): Promise<void> {
  const relPath = route?.relPath ?? req.path.replace(/^\/v1/, "");

  let bearer: string;
  try {
    bearer = await deps.getBearer();
  } catch (error) {
    res.status(401).json({
      error: { message: safeErrorMessage(error), type: "auth_error" },
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBoundedBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      res.status(413).json({
        error: {
          message: error.message,
          type: "payload_too_large",
        },
      });
      return;
    }
    throw error;
  }

  const rawContentType = req.headers["content-type"];
  // Emulated local-server routes always carry JSON, even when an IDE forgets
  // to say so; the native routes keep trusting the declared content type.
  const contentType = route?.rewrite
    ? "application/json"
    : Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const decision = decideProxyRoute({
    method: req.method,
    relPath,
    contentType,
    body,
  });
  let forwardBody = body;
  const headers = new Headers(filterRequestHeaders(req.headers));
  if (decision.kind !== "opaque-relay") {
    const json = route?.rewrite ? route.rewrite(decision.json) : decision.json;
    decision.json = json;
    const prepared = prepareGrokRequestObject(relPath, json);
    forwardBody = Buffer.from(JSON.stringify(prepared.value), "utf8");
    if (route?.rewrite) headers.set("content-type", "application/json");
  }

  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
  const controller = new AbortController();
  const abortUpstream = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("downstream request aborted"));
    }
  };
  req.once("aborted", abortUpstream);
  res.once("close", () => {
    if (!res.writableEnded) abortUpstream();
  });

  try {
    const upstream = await deps.fetchUpstream({
      method: req.method,
      pathWithQuery: `/v1${relPath}${query}`,
      headers,
      body:
        forwardBody.length > 0 ? new Uint8Array(forwardBody) : undefined,
      signal: controller.signal,
    }, { bearer });

    if (
      !route?.relayStreams &&
      (decision.kind === "native-chat" || decision.kind === "native-responses")
    ) {
      const model = typeof decision.json.model === "string"
        ? decision.json.model
        : "unknown";
      const handled = await serveNativeStream({
        protocol: decision.kind === "native-chat" ? "chat" : "responses",
        upstream,
        downstream: res,
        model,
        ...(route?.chatRender ? { chatRender: route.chatRender } : {}),
      });
      if (handled === "handled") return;
    }

    if (
      route?.transformJsonResponse &&
      upstream.ok &&
      (upstream.headers.get("content-type") ?? "").includes("application/json")
    ) {
      const text = await upstream.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        res.status(upstream.status).type("application/json").send(text);
        return;
      }
      res.status(upstream.status).json(route.transformJsonResponse(parsed));
      return;
    }

    await relayUpstreamResponse(upstream, res);
  } catch (error) {
    sendUpstreamError(res, error);
  }
}

export interface ProxyListener {
  port: number;
  compat?: LocalCompatMode;
  /**
   * How emulated Chat Completions return reasoning. Defaults to
   * `PROGROK_REASONING_FORMAT`, else `both` (`reasoning_content` + `reasoning`).
   */
  reasoningFormat?: ReasoningFormat;
}

const COMPAT_LABEL: Record<LocalCompatMode, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
};

function listen(
  app: express.Express,
  port: number,
  host: string,
): Promise<ReturnType<express.Express["listen"]>> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(new Error(`Proxy failed to start on ${host}:${port}: ${err.message}`));
    });
  });
}

/**
 * Start one listener per entry. The plain listener is the OpenAI-compatible
 * proxy; an entry with `compat` additionally answers that local server's
 * native API (LM Studio on 1234, Ollama on 11434 by default) so IDEs that only
 * offer "local model" providers can use the OAuth session.
 */
export async function startProxy(
  port = PROXY_DEFAULT_PORT,
  host = PROXY_DEFAULT_HOST,
  extraListeners: ProxyListener[] = [],
  options: { openai?: boolean; trafficLog?: TrafficLogLevel } = {},
): Promise<void> {
  const traffic = new TrafficLogger({
    level: options.trafficLog ?? trafficLogLevelFromEnv(process.env["PROGROK_LOG"]),
  });
  const listeners: ProxyListener[] = [
    ...(options.openai === false ? [] : [{ port }]),
    ...extraListeners,
  ];
  if (listeners.length === 0) throw new Error("No proxy listener configured");

  const servers: Array<ReturnType<express.Express["listen"]>> = [];
  try {
    for (const listener of listeners) {
      const app = createProxyApp(undefined, {
        ...(listener.compat ? { compat: listener.compat } : {}),
        ...(listener.reasoningFormat ? { reasoningFormat: listener.reasoningFormat } : {}),
        trafficLog: traffic,
      });
      servers.push(await listen(app, listener.port, host));
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }

  log.success("progrok proxy running");
  for (const listener of listeners) {
    const label = listener.compat ? `${COMPAT_LABEL[listener.compat]}:` : "OpenAI:";
    const suffix = listener.compat ? "" : "/v1";
    log.info(`  ${label.padEnd(13)} http://${host}:${listener.port}${suffix}`);
  }
  log.info(`  Forwarding:   ${XAI_API_BASE_URL}`);
  if (host === "0.0.0.0" || host === "::") {
    log.error(
      "  ⚠ Bound to all interfaces — your OAuth token is accessible on the local network!",
    );
  }
  log.dim(
    "  Client auth:  any bearer token or none (proxy injects your OAuth credential)",
  );
  if (traffic.enabled) {
    log.dim(`  Traffic log:  ${traffic.bodies ? "events + bodies (redacted)" : "events"} on stderr`);
  } else {
    log.dim("  Traffic log:  off (use --verbose or PROGROK_LOG=1 to see requests to xAI)");
  }
  log.info("\nPress Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    log.info("\nprogrok proxy stopped.");
    for (const server of servers) server.close();
    process.exit(0);
  });
}
