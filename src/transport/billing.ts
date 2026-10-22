/**
 * Subscription billing for the signed-in SuperGrok account.
 *
 * Shared by `progrok billing` and the proxy's periodic usage report.
 * `cli-chat-proxy.grok.com/v1/billing` reports amounts as integer `val`s in
 * cents (`monthlyLimit`, `used`), plus the current billing period.
 */

export const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
export const USER_URL = "https://cli-chat-proxy.grok.com/v1/user";

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
    headers: { Authorization: `Bearer ${opts.bearer}` },
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
