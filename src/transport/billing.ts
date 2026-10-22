/**
 * Subscription billing for the signed-in SuperGrok account.
 *
 * Shared by `progrok billing` and the proxy's periodic usage report.
 *
 * Two undocumented views of the same account, both used by the official Grok
 * Build CLI (its `/usage` panel) and by community usage tools:
 *  - `GET /v1/billing` — legacy monthly allowance: integer `val`s in cents
 *    (`monthlyLimit`, `used`) plus the billing period.
 *  - `GET /v1/billing?format=credits` — the SuperGrok weekly usage pool:
 *    `currentPeriod {type: "USAGE_PERIOD_TYPE_WEEKLY", start, end}`,
 *    `creditUsagePercent` (percent USED; xAI publishes no absolute size),
 *    `productUsage[{product, usagePercent}]`, `prepaidBalance`,
 *    `onDemandCap` / `onDemandUsed`, `topUpMethod`, `isUnifiedBillingUser`.
 * xAI documents one shared weekly pool per paid seat (docs.x.ai/grok/faq,
 * docs.x.ai/x-subscription/usage-limits); there is no 5-hour window.
 */

export const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
export const USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const CREDITS_URL = `${BILLING_URL}?format=credits`;

/** Client marker the Grok CLI sends to the billing proxy. */
const CLIENT_HEADERS = { "x-xai-token-auth": "xai-grok-cli", Accept: "application/json" };

export interface BillingConfig {
  monthlyLimit: { val: number };
  used: { val: number };
  onDemandCap: { val: number };
  billingPeriodStart: string;
  billingPeriodEnd: string;
  history: Array<{
    billingCycle: { year: number; month: number };
    includedUsed: { val: number };
    onDemandUsed: { val: number };
    totalUsed: { val: number };
  }>;
}

export interface BillingSummary {
  tier: string;
  /** Monthly limit, cents. */
  limit: number;
  /** Used this period, cents. */
  used: number;
  /** limit − used, cents. */
  remaining: number;
  /** Rounded whole percent, as `progrok billing` prints it. */
  percent: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  /** `YYYY-MM-DD` or `unknown`. */
  periodStart: string;
  periodEnd: string;
  history: BillingConfig["history"];
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

export function tierFromLimit(val: number): string {
  if (val >= 150_000) return "SuperGrok Heavy";
  if (val >= 15_000) return "SuperGrok";
  return `SuperGrok (${val} val)`;
}

/** Parse the billing endpoint's JSON body. */
export function parseBilling(raw: unknown): BillingSummary {
  const billing = (raw as { config?: BillingConfig } | null | undefined)?.config;
  if (!billing || billing.monthlyLimit?.val == null || billing.used?.val == null) {
    throw new BillingError("Unexpected billing response format.");
  }
  const limit = billing.monthlyLimit.val;
  const used = billing.used.val;
  return {
    tier: tierFromLimit(limit),
    limit,
    used,
    remaining: limit - used,
    percent: limit > 0 ? Math.round((used / limit) * 100) : 0,
    ...(billing.billingPeriodStart !== undefined ? { billingPeriodStart: billing.billingPeriodStart } : {}),
    ...(billing.billingPeriodEnd !== undefined ? { billingPeriodEnd: billing.billingPeriodEnd } : {}),
    periodStart: (billing.billingPeriodStart ?? "unknown").slice(0, 10),
    periodEnd: (billing.billingPeriodEnd ?? "unknown").slice(0, 10),
    history: billing.history ?? [],
  };
}

export interface BillingFetchOptions {
  bearer: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function billingRequest(url: string, opts: BillingFetchOptions, timeoutMs: number): Promise<Response> {
  return (opts.fetchImpl ?? globalThis.fetch)(url, {
    headers: { Authorization: `Bearer ${opts.bearer}`, ...CLIENT_HEADERS },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** GET the billing endpoint and parse it. Throws `BillingError` on failure. */
export async function fetchBilling(opts: BillingFetchOptions): Promise<BillingSummary> {
  let response: Response;
  try {
    response = await billingRequest(BILLING_URL, opts, opts.timeoutMs ?? 8000);
  } catch (error) {
    throw new BillingError(`Failed to fetch billing data. (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) {
    throw new BillingError(`Failed to fetch billing data. (HTTP ${response.status})`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new BillingError("Unexpected billing response format.");
  }
  return parseBilling(raw);
}

/** Account e-mail, or null when it cannot be read. Never throws. */
export async function fetchAccountEmail(opts: BillingFetchOptions): Promise<string | null> {
  try {
    const response = await billingRequest(USER_URL, opts, opts.timeoutMs ?? 5000);
    if (!response.ok) return null;
    const user = (await response.json()) as { email?: string };
    return user.email ?? null;
  } catch {
    return null;
  }
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Weekly SuperGrok usage pool (`?format=credits`)

export interface ProductUsage {
  product: string;
  /** Percent of the pool used by this product; absent = none yet. */
  usagePercent?: number;
}

export interface UsagePool {
  /** `weekly`, `monthly`, `daily`, … from `USAGE_PERIOD_TYPE_*`; `unknown` if absent. */
  periodType: string;
  /** Percent of the pool USED (0–100+). */
  usedPercent: number;
  periodStart?: string;
  /** Next reset (ISO timestamp). */
  resetsAt?: string;
  productUsage: ProductUsage[];
  /** Raw `val`s as returned (unit not documented; cents on the monthly view). */
  prepaidBalance?: number;
  onDemandCap?: number;
  onDemandUsed?: number;
  topUpMethod?: string;
  isUnifiedBillingUser?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function val(value: unknown): number | undefined {
  return isRecord(value) && typeof value.val === "number" ? value.val : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Parse the `?format=credits` body. Returns undefined when it carries neither
 * a usage percent nor a period (nothing to show). A period without
 * `creditUsagePercent` means nothing used yet (fresh week).
 */
export function parseUsagePool(raw: unknown): UsagePool | undefined {
  const config = isRecord(raw) && isRecord(raw.config) ? raw.config : isRecord(raw) ? raw : undefined;
  if (!config) return undefined;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const percent = typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)
    ? config.creditUsagePercent
    : undefined;
  const resetsAt = isoOrUndefined(period.end) ?? isoOrUndefined(config.billingPeriodEnd);
  const periodStart = isoOrUndefined(period.start) ?? isoOrUndefined(config.billingPeriodStart);
  if (percent === undefined && resetsAt === undefined) return undefined;
  const type = typeof period.type === "string" && period.type
    ? period.type.replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase()
    : "unknown";
  const pool: UsagePool = {
    periodType: type,
    usedPercent: percent ?? 0,
    productUsage: Array.isArray(config.productUsage)
      ? config.productUsage.filter(isRecord).filter((entry) => typeof entry.product === "string").map((entry) => ({
        product: entry.product as string,
        ...(typeof entry.usagePercent === "number" ? { usagePercent: entry.usagePercent } : {}),
      }))
      : [],
  };
  if (periodStart) pool.periodStart = periodStart;
  if (resetsAt) pool.resetsAt = resetsAt;
  const prepaid = val(config.prepaidBalance);
  const cap = val(config.onDemandCap);
  const onDemand = val(config.onDemandUsed);
  if (prepaid !== undefined) pool.prepaidBalance = prepaid;
  if (cap !== undefined) pool.onDemandCap = cap;
  if (onDemand !== undefined) pool.onDemandUsed = onDemand;
  if (typeof config.topUpMethod === "string") pool.topUpMethod = config.topUpMethod;
  if (typeof config.isUnifiedBillingUser === "boolean") pool.isUnifiedBillingUser = config.isUnifiedBillingUser;
  return pool;
}

/** GET `?format=credits`. Throws `BillingError` when unreachable or empty. */
export async function fetchUsagePool(opts: BillingFetchOptions): Promise<UsagePool> {
  let response: Response;
  try {
    response = await billingRequest(CREDITS_URL, opts, opts.timeoutMs ?? 8000);
  } catch (error) {
    throw new BillingError(`Failed to fetch usage pool. (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) throw new BillingError(`Failed to fetch usage pool. (HTTP ${response.status})`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new BillingError("Unexpected usage pool response format.");
  }
  const pool = parseUsagePool(raw);
  if (!pool) throw new BillingError("Unexpected usage pool response format.");
  return pool;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Mon 2026-10-27 02:00` in local time. */
export function formatReset(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()]} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** `weekly: 63% used, resets Mon 2026-10-27 02:00` */
export function describeUsagePool(pool: UsagePool): string {
  return `${pool.periodType}: ${formatPercent(pool.usedPercent)} used${pool.resetsAt ? `, resets ${formatReset(pool.resetsAt)}` : ""}`;
}
