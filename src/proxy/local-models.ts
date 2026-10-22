import type { XaiFetchInput } from "../transport/fetch.js";
import { log } from "../utils/logger.js";
import { safeErrorMessage } from "./redact.js";

/**
 * Model catalog for the local-server emulation (LM Studio / Ollama).
 *
 * Tools that only know "local model servers" (JetBrains AI Assistant, Junie
 * CLI, Continue, ...) list models first and only then talk to one. They have
 * no notion of image or video models, so the catalog is reduced to chat-capable
 * language models and re-shaped by each emulator. The live xAI catalog is the
 * source of truth; a pinned fallback keeps "Test connection" green when the
 * catalog endpoint is briefly unavailable.
 */

export interface LocalModel {
  id: string;
  contextLength: number;
  vision: boolean;
  reasoning: boolean;
}

export interface LocalCatalogDeps {
  getBearer(): Promise<string>;
  fetchUpstream(
    input: XaiFetchInput,
    options: { bearer: string },
  ): Promise<Response>;
}

/** Context windows from README "Models" (live catalog does not carry them). */
const KNOWN_CONTEXT: Array<[RegExp, number]> = [
  [/^grok-4\.(5|6)/, 500_000],
  [/^grok-build/, 256_000],
  [/^grok-composer/, 256_000],
  [/^grok-4/, 256_000],
];

const DEFAULT_CONTEXT = 131_072;

/** Pinned SuperGrok catalog (README, 2026-09-19) used only when xAI is unreachable. */
export const FALLBACK_MODEL_IDS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
];

const NON_CHAT = /(imagine|embed|voice|tts|stt|realtime|transcri)/i;

const CACHE_TTL_MS = 60_000;

export function contextLengthFor(id: string): number {
  for (const [pattern, length] of KNOWN_CONTEXT) {
    if (pattern.test(id)) return length;
  }
  return DEFAULT_CONTEXT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(id: string, raw?: Record<string, unknown>): LocalModel {
  const modalities = Array.isArray(raw?.input_modalities)
    ? raw.input_modalities.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    id,
    contextLength: contextLengthFor(id),
    vision: modalities ? modalities.includes("image") : /^grok-4/.test(id),
    reasoning: !/non-reasoning/.test(id),
  };
}

/** Extra catalog entries the live list omits, e.g. `grok-composer-2.5-fast`. */
export function extraModelIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env["PROGROK_LOCAL_EXTRA_MODELS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Local servers name models freely (`grok-4.6:latest`, `xai/grok-4.6`); xAI
 * accepts only the bare id. Strip the decorations clients add on their own.
 */
export function normalizeLocalModelId(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  let id = model.trim();
  if (id.endsWith(":latest")) id = id.slice(0, -":latest".length);
  if (id.startsWith("xai/")) id = id.slice("xai/".length);
  return id.length > 0 ? id : undefined;
}

async function fetchJson(
  deps: LocalCatalogDeps,
  bearer: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await deps.fetchUpstream({
    method: "GET",
    pathWithQuery: path,
    headers: new Headers({ accept: "application/json" }),
  }, { bearer });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) throw new Error(`${path} returned a non-object`);
  return parsed;
}

async function loadLive(deps: LocalCatalogDeps): Promise<LocalModel[]> {
  const bearer = await deps.getBearer();
  try {
    const body = await fetchJson(deps, bearer, "/v1/language-models");
    if (Array.isArray(body.models)) {
      const models = body.models
        .filter(isRecord)
        .filter((raw) => typeof raw.id === "string")
        .map((raw) => describe(raw.id as string, raw));
      if (models.length > 0) return models;
    }
  } catch {
    // fall through to the generic catalog
  }
  const body = await fetchJson(deps, bearer, "/v1/models");
  if (!Array.isArray(body.data)) throw new Error("/v1/models is missing data[]");
  return body.data
    .filter(isRecord)
    .map((raw) => raw.id)
    .filter((id): id is string => typeof id === "string")
    .map((id) => describe(id));
}

export class LocalModelCatalog {
  private cached?: { at: number; models: LocalModel[] };
  private inflight?: Promise<LocalModel[]>;

  constructor(
    private readonly deps: LocalCatalogDeps,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<LocalModel[]> {
    if (this.cached && this.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.models;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async find(model: unknown): Promise<LocalModel | undefined> {
    const id = normalizeLocalModelId(model);
    if (!id) return undefined;
    const models = await this.list();
    return models.find((entry) => entry.id === id) ?? describe(id);
  }

  private async refresh(): Promise<LocalModel[]> {
    let models: LocalModel[];
    try {
      models = await loadLive(this.deps);
    } catch (error) {
      log.dim(
        `[progrok] model catalog unavailable, using pinned list: ${safeErrorMessage(error)}`,
      );
      models = FALLBACK_MODEL_IDS.map((id) => describe(id));
    }
    const seen = new Set<string>();
    const merged: LocalModel[] = [];
    for (const model of [
      ...models.filter((entry) => !NON_CHAT.test(entry.id)),
      ...extraModelIds().map((id) => describe(id)),
    ]) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    this.cached = { at: this.now(), models: merged };
    return merged;
  }
}

/**
 * OpenAI `GET /v1/models` as a local server answers it: chat models only,
 * because the local-provider UIs offer every listed id as a chat model.
 */
export function openAiModelList(models: LocalModel[], ownedBy: string): Record<string, unknown> {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: ownedBy,
    })),
  };
}
