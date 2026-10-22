import { dollars, type BillingSummary } from "../transport/billing.js";
import { timestamp } from "./traffic-log.js";

/**
 * Periodic subscription-usage line while `progrok proxy` runs.
 *
 * On by default. The first report comes FIRST_REPORT_DELAY_MS after the first
 * proxied xAI request (so the user sees it works without waiting a whole
 * interval); after that one line per interval, but only when at least one
 * request reached xAI since the previous report. Idle proxies stay silent.
 * Billing failures never affect proxying: one warning line per failure streak,
 * then exponential back-off (interval × 2ⁿ, capped at an hour).
 */

export const DEFAULT_USAGE_EVERY_MS = 5 * 60_000;
export const MIN_USAGE_EVERY_MS = 10_000;
export const MAX_USAGE_EVERY_MS = 24 * 60 * 60_000;
export const FIRST_REPORT_DELAY_MS = 10_000;
const MAX_BACKOFF_MS = 60 * 60_000;

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse `30s`, `5m`, `1h`, `1h30m`, `90` (seconds) or `0`/`off` (disabled → 0).
 * Throws on anything else or on intervals outside 10s..24h.
 */
export function parseUsageInterval(value: string): number {
  const text = value.trim().toLowerCase();
  if (["0", "off", "false", "no", "none", "disabled"].includes(text)) return 0;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * 1_000;
  } else {
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) {
      throw new Error(`invalid usage interval "${value}" (use e.g. 30s, 5m, 1h, or off)`);
    }
    ms = parts.reduce((sum, part) => sum + Number(part[1]) * UNITS[part[2]!]!, 0);
  }
  if (ms === 0) return 0;
  if (ms < MIN_USAGE_EVERY_MS || ms > MAX_USAGE_EVERY_MS) {
    throw new Error(`usage interval "${value}" must be between 10s and 24h (or off)`);
  }
  return Math.round(ms);
}

/** CLI flags + `PROGROK_USAGE_EVERY` → interval in ms (0 = disabled). */
export function resolveUsageInterval(
  flags: { usage?: boolean; usageEvery?: string },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (flags.usage === false) return 0;
  if (flags.usageEvery !== undefined) return parseUsageInterval(flags.usageEvery);
  const fromEnv = env["PROGROK_USAGE_EVERY"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return parseUsageInterval(fromEnv);
  return DEFAULT_USAGE_EVERY_MS;
}

export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export function formatUsageLine(summary: BillingSummary, requests: number, at = new Date()): string {
  const percent = summary.limit > 0 ? ((summary.used / summary.limit) * 100).toFixed(1) : "0.0";
  return `${timestamp(at).slice(0, 19)} usage: ${dollars(summary.used)} / ${dollars(summary.limit)} used (${percent}%), `
    + `${dollars(summary.remaining)} left, period ${summary.periodStart}..${summary.periodEnd}, `
    + `${requests} xAI request${requests === 1 ? "" : "s"} since last report`;
}

export interface UsageReporterOptions {
  intervalMs: number;
  fetchUsage(): Promise<BillingSummary>;
  write?: (line: string) => void;
  firstReportDelayMs?: number;
  now?: () => number;
}

export class UsageReporter {
  readonly intervalMs: number;
  private readonly fetchUsage: () => Promise<BillingSummary>;
  private readonly write: (line: string) => void;
  private readonly firstDelayMs: number;
  private readonly now: () => number;
  private requests = 0;
  private reportedOnce = false;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;

  constructor(options: UsageReporterOptions) {
    this.intervalMs = options.intervalMs;
    this.fetchUsage = options.fetchUsage;
    this.write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.firstDelayMs = options.firstReportDelayMs ?? Math.min(FIRST_REPORT_DELAY_MS, options.intervalMs);
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** Start the interval timer. No-op when disabled. */
  start(): void {
    if (!this.enabled || this.interval || this.stopped) return;
    this.interval = setInterval(() => void this.tick(), this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.interval = undefined;
    this.firstTimer = undefined;
  }

  /** Count one request that reached xAI. */
  noteRequest(): void {
    if (!this.enabled || this.stopped) return;
    this.requests += 1;
    if (!this.reportedOnce && !this.firstTimer) {
      this.firstTimer = setTimeout(() => {
        this.firstTimer = undefined;
        void this.tick();
      }, this.firstDelayMs);
      this.firstTimer.unref?.();
    }
  }

  /** One report attempt; resolves when done. Exposed for tests. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || this.requests === 0 || this.now() < this.retryAt) return Promise.resolve();
    const counted = this.requests;
    this.inFlight = (async () => {
      try {
        const summary = await this.fetchUsage();
        this.requests -= counted;
        this.reportedOnce = true;
        this.failures = 0;
        this.retryAt = 0;
        this.write(formatUsageLine(summary, counted, new Date(this.now())));
      } catch (error) {
        this.failures += 1;
        const backoff = Math.min(this.intervalMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
        this.retryAt = this.now() + backoff;
        if (this.failures === 1) {
          this.reportedOnce = true;
          const reason = error instanceof Error ? error.message : String(error);
          this.write(`${timestamp(new Date(this.now())).slice(0, 19)} usage: WARNING could not read billing (${reason}); proxying is unaffected, retrying with back-off`);
        }
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}
