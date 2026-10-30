import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "./version.js";

/** Minimum Node from a ">=X.Y.Z" engines range; undefined if not that form. */
export function minimumNodeVersion(range: string | undefined): string | undefined {
  const match = range?.trim().match(/^>=\s*v?(\d+(?:\.\d+){0,2})$/);
  return match?.[1];
}

function versionParts(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function isOlderThan(version: string, minimum: string): boolean {
  const current = versionParts(version);
  const wanted = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const diff = (current[index] ?? 0) - (wanted[index] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/** Warning text when the running Node is older than the engines range. */
export function nodeEngineWarning(
  version: string,
  range: string | undefined,
): string | undefined {
  const minimum = minimumNodeVersion(range);
  if (!minimum || !isOlderThan(version, minimum)) return undefined;
  return `progrok: warning: running on Node ${version.replace(/^v?/, "v")}, but progrok requires Node ${range}. Continuing; some features may not work.`;
}

export function readEnginesNodeRange(): string | undefined {
  try {
    const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
    if (!root) return undefined;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node;
  } catch {
    return undefined;
  }
}

/** Print the warning (stderr, never fatal). Returns the text for tests. */
export function warnIfNodeTooOld(
  version: string = process.version,
  range: string | undefined = readEnginesNodeRange(),
): string | undefined {
  const warning = nodeEngineWarning(version, range);
  if (warning && process.env.PROGROK_NO_NODE_WARNING !== "1") {
    console.error(`\x1b[33m${warning}\x1b[0m`);
  }
  return warning;
}
