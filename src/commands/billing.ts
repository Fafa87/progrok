import { Command } from "commander";
import { getValidBearer } from "../auth/token-store.js";
import {
  BillingError,
  dollars,
  fetchAccountEmail,
  fetchBilling,
} from "../transport/billing.js";
import { log } from "../utils/logger.js";

export function billingCommand(): Command {
  return new Command("billing")
    .description("Show subscription billing and usage")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const token = await getValidBearer();
        const [billingResult, email] = await Promise.all([
          fetchBilling({ bearer: token }).then(
            (summary) => ({ summary }),
            (error: unknown) => ({ error }),
          ),
          fetchAccountEmail({ bearer: token }),
        ]);

        if ("error" in billingResult) {
          const error = billingResult.error;
          log.error(
            error instanceof BillingError && error.message.startsWith("Unexpected")
              ? error.message
              : "Failed to fetch billing data.",
          );
          process.exit(1);
        }
        const billing = billingResult.summary;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
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
              },
              null,
              2,
            ),
          );
          return;
        }

        log.info(`Plan:      ${billing.tier}`);
        if (email) log.info(`Account:   ${email}`);
        log.info(`Period:    ${billing.periodStart} → ${billing.periodEnd}`);
        log.info(`Limit:     ${dollars(billing.limit)}`);
        log.info(`Used:      ${dollars(billing.used)} (${billing.percent}%)`);
        log.info(`Remaining: ${dollars(billing.remaining)}`);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
