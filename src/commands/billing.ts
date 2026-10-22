import { Command } from "commander";
import { getValidBearer } from "../auth/token-store.js";
import {
  BillingError,
  dollars,
  fetchAccountEmail,
  fetchBilling,
  fetchUsagePool,
  formatPercent,
  formatReset,
  type BillingSummary,
  type UsagePool,
} from "../transport/billing.js";
import { log } from "../utils/logger.js";

function settle<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

function poolJson(pool: UsagePool): Record<string, unknown> {
  return {
    periodType: pool.periodType,
    usedPercent: pool.usedPercent,
    remainingPercent: Math.max(0, 100 - pool.usedPercent),
    periodStart: pool.periodStart,
    resetsAt: pool.resetsAt,
    productUsage: pool.productUsage,
    prepaidBalance: pool.prepaidBalance,
    onDemandCap: pool.onDemandCap,
    onDemandUsed: pool.onDemandUsed,
    topUpMethod: pool.topUpMethod,
    isUnifiedBillingUser: pool.isUnifiedBillingUser,
  };
}

function printPool(pool: UsagePool): void {
  const label = `${pool.periodType[0]!.toUpperCase()}${pool.periodType.slice(1)}:`.padEnd(11);
  log.info(`${label}${formatPercent(pool.usedPercent)} used${pool.resetsAt ? `, resets ${formatReset(pool.resetsAt)}` : ""}`);
  const products = pool.productUsage
    .filter((entry) => entry.usagePercent !== undefined)
    .map((entry) => `${entry.product} ${formatPercent(entry.usagePercent!)}`);
  if (products.length > 0) log.info(`           ${products.join(", ")}`);
}

export interface BillingCommandDeps {
  getBearer?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function billingCommand(deps: BillingCommandDeps = {}): Command {
  return new Command("billing")
    .description("Show subscription billing and usage (monthly allowance and the SuperGrok weekly usage pool)")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const token = await (deps.getBearer ?? getValidBearer)();
        const request = { bearer: token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
        const [billingResult, poolResult, email] = await Promise.all([
          settle(fetchBilling(request)),
          settle(fetchUsagePool(request)),
          fetchAccountEmail(request),
        ]);
        const pool = "value" in poolResult ? poolResult.value : undefined;

        if ("error" in billingResult && !pool) {
          const error = billingResult.error;
          log.error(
            error instanceof BillingError && error.message.startsWith("Unexpected")
              ? error.message
              : "Failed to fetch billing data.",
          );
          process.exit(1);
        }
        const billing: BillingSummary | undefined = "value" in billingResult ? billingResult.value : undefined;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ...(billing
                  ? {
                    tier: billing.tier,
                    email,
                    limit: billing.limit,
                    used: billing.used,
                    remaining: billing.remaining,
                    percent: billing.percent,
                    limitUsd: billing.limit / 100,
                    usedUsd: billing.used / 100,
                    remainingUsd: billing.remaining / 100,
                    billingPeriodStart: billing.billingPeriodStart,
                    billingPeriodEnd: billing.billingPeriodEnd,
                    history: billing.history,
                  }
                  : { email }),
                ...(pool ? { usagePool: poolJson(pool) } : {}),
              },
              null,
              2,
            ),
          );
          return;
        }

        if (billing) {
          log.info(`Plan:      ${billing.tier}`);
          if (email) log.info(`Account:   ${email}`);
          log.info(`Period:    ${billing.periodStart} → ${billing.periodEnd}`);
          log.info(`Limit:     ${dollars(billing.limit)}`);
          log.info(`Used:      ${dollars(billing.used)} (${billing.percent}%)`);
          log.info(`Remaining: ${dollars(billing.remaining)}`);
        } else if (email) {
          log.info(`Account:   ${email}`);
        }
        if (pool) printPool(pool);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
