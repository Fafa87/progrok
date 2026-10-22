import { BILLING_URL, CREDITS_URL, USER_URL } from "../../src/transport/billing.js";

/**
 * Fake `cli-chat-proxy.grok.com` billing endpoint: a `fetch` that serves
 * `/v1/billing` (amounts in cents, like the real one) and `/v1/user`.
 * `used` grows by `step` cents per billing read; `fail` makes it answer 503
 * (or throw, for `fail = "network"`).
 */
export function fakeBillingFetch(init: { limit?: number; used?: number; step?: number } = {}) {
  const state = {
    limit: init.limit ?? 5_000,
    used: init.used ?? 1_234,
    step: init.step ?? 0,
    fail: false as boolean | "network",
    /** Fail only the monthly view (`/v1/billing`). */
    failMonthly: false,
    /** `?format=credits` config; `null` → 404 like an account without the pool. */
    pool: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-10-20T00:00:00+00:00",
        end: "2026-10-27T01:00:00+00:00",
      },
      creditUsagePercent: 63,
      productUsage: [{ product: "GrokBuild", usagePercent: 60 }, { product: "GrokChat", usagePercent: 3 }, { product: "Imagine" }],
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
      billingPeriodStart: "2026-10-20T00:00:00+00:00",
      billingPeriodEnd: "2026-10-27T01:00:00+00:00",
    } as Record<string, unknown> | null,
    calls: [] as Array<{ url: string; authorization: string | null; client: string | null }>,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    state.calls.push({ url, authorization: headers.get("authorization"), client: headers.get("x-xai-token-auth") });
    if (state.fail === "network") throw new TypeError("fetch failed");
    if (state.fail) return new Response("unavailable", { status: 503 });
    if (url === CREDITS_URL) {
      return state.pool ? Response.json({ config: state.pool }) : new Response("not found", { status: 404 });
    }
    if (url === BILLING_URL && state.failMonthly) return new Response("unavailable", { status: 503 });
    if (url === BILLING_URL) {
      const body = {
        config: {
          monthlyLimit: { val: state.limit },
          used: { val: state.used },
          onDemandCap: { val: 0 },
          billingPeriodStart: "2026-10-01T00:00:00Z",
          billingPeriodEnd: "2026-10-31T23:59:59Z",
          history: [],
        },
      };
      state.used += state.step;
      return Response.json(body);
    }
    if (url === USER_URL) return Response.json({ email: "filip@example.com" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl };
}
