/**
 * Rate-limit headers seen on real xAI responses while proxying.
 *
 * api.x.ai has been observed to send `x-ratelimit-limit-requests`,
 * `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens` and
 * `x-ratelimit-remaining-tokens` on chat completions (per-model budgets,
 * undocumented), and no `x-ratelimit-reset-*`. `retry-after` is honoured if
 * a 429 carries it. These are API rate limits, not the SuperGrok weekly pool;
 * whether OAuth (SuperGrok) sessions receive them is not confirmed, so every
 * part is optional and omitted when absent.
 */

export interface RateWindow {
  limit?: number;
  remaining?: number;
  /** Raw reset header value (seconds, epoch or duration), if any. */
  reset?: string;
}

export interface RateLimitSnapshot {
  path: string;
  status: number;
  requests?: RateWindow;
  tokens?: RateWindow;
  retryAfter?: string;
  /** Any other `x-ratelimit-*` / quota-looking headers, verbatim. */
  other: Record<string, string>;
  at: number;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name) ?? headers.get(name.replace("x-ratelimit-", "x-rate-limit-"));
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function window(headers: Headers, dimension: "requests" | "tokens"): RateWindow | undefined {
  const limit = numberHeader(headers, `x-ratelimit-limit-${dimension}`);
  const remaining = numberHeader(headers, `x-ratelimit-remaining-${dimension}`);
  const reset = headers.get(`x-ratelimit-reset-${dimension}`) ?? headers.get(`x-rate-limit-reset-${dimension}`) ?? undefined;
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { reset } : {}),
  };
}

const KNOWN = /^x-rate-?limit-(limit|remaining|reset)-(requests|tokens)$/;
const QUOTA_LIKE = /^(x-rate-?limit-|x-ratelimit-|x-(xai-)?(usage|quota|subscription|entitlement)|xai-(usage|quota|subscription|entitlement))/i;

export function parseRateLimitHeaders(path: string, status: number, headers: Headers, at = Date.now()): RateLimitSnapshot | undefined {
  const requests = window(headers, "requests");
  const tokens = window(headers, "tokens");
  const retryAfter = headers.get("retry-after") ?? undefined;
  const other: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (QUOTA_LIKE.test(lower) && !KNOWN.test(lower)) other[lower] = value;
  });
  if (!requests && !tokens && retryAfter === undefined && Object.keys(other).length === 0) return undefined;
  return {
    path,
    status,
    ...(requests ? { requests } : {}),
    ...(tokens ? { tokens } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    other,
    at,
  };
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 10_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

function describeWindow(name: string, window: RateWindow | undefined): string | undefined {
  if (!window) return undefined;
  const left = window.remaining !== undefined ? compact(window.remaining) : "?";
  const total = window.limit !== undefined ? `/${compact(window.limit)}` : "";
  return `${name} ${left}${total} left${window.reset ? ` (reset ${window.reset})` : ""}`;
}

/** `rate-limit: requests 7199/7200 left, tokens 49.9M/50M left` */
export function describeRateLimit(snapshot: RateLimitSnapshot): string {
  const parts = [
    describeWindow("requests", snapshot.requests),
    describeWindow("tokens", snapshot.tokens),
    snapshot.retryAfter !== undefined ? `retry-after ${snapshot.retryAfter}s` : undefined,
    ...Object.entries(snapshot.other).map(([name, value]) => `${name}=${value}`),
  ].filter((part): part is string => part !== undefined);
  return `rate-limit: ${parts.join(", ")}`;
}

/** Keeps the most recent rate-limit headers seen on any listener. */
export class RateLimitTracker {
  private last: RateLimitSnapshot | undefined;

  observe(path: string, response: Response): void {
    const snapshot = parseRateLimitHeaders(path, response.status, response.headers);
    if (snapshot) this.last = snapshot;
  }

  latest(): RateLimitSnapshot | undefined {
    return this.last;
  }
}
