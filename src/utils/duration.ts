/**
 * Human durations for CLI flags and env vars: `30s`, `5m`, `1h`, `1h30m`,
 * `500ms`, a bare number (seconds), or `0`/`off`/`none` (→ 0, "disabled").
 */

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
const OFF_WORDS = ["0", "off", "false", "no", "none", "disabled"];

export interface DurationBounds {
  /** What the value is, used in error messages (e.g. "usage interval"). */
  label: string;
  minMs: number;
  maxMs: number;
  /** Human form of the bounds for error messages, e.g. "10s and 24h". */
  rangeText: string;
}

export function parseDuration(value: string, bounds: DurationBounds): number {
  const text = value.trim().toLowerCase();
  if (OFF_WORDS.includes(text)) return 0;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * 1_000;
  } else {
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) {
      throw new Error(`invalid ${bounds.label} "${value}" (use e.g. 30s, 5m, 1h, or off)`);
    }
    ms = parts.reduce((sum, part) => sum + Number(part[1]) * UNITS[part[2]!]!, 0);
  }
  if (ms === 0) return 0;
  if (ms < bounds.minMs || ms > bounds.maxMs) {
    throw new Error(`${bounds.label} "${value}" must be between ${bounds.rangeText} (or off)`);
  }
  return Math.round(ms);
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
