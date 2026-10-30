import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  compareVersions,
  nodeSupportsUndici,
  prepareUpstreamFetch,
  resetUpstreamFetch,
  upstreamFetch,
  upstreamFetchStatus,
  upstreamFetchWarning,
} from "../src/transport/timeouts.js";
import { isOlderThan, minimumNodeVersion, nodeEngineWarning } from "../src/utils/node-version.js";

afterEach(() => resetUpstreamFetch());

describe("Node version compatibility", () => {
  it("never imports undici statically (undici 7 crashes at import on Node 18)", () => {
    for (const file of ["src/transport/timeouts.ts", "src/transport/fetch.ts", "src/proxy/server.ts"]) {
      const source = readFileSync(file, "utf-8");
      assert.doesNotMatch(source, /^import\s+(?!type\b)[^;]*from\s+["']undici["']/m, file);
    }
  });

  it("pins an undici line that supports Node 18", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { dependencies: Record<string, string> };
    assert.match(pkg.dependencies.undici, /^\^6\./);
  });

  it("compares versions numerically", () => {
    assert.equal(compareVersions("18.19.1", "18.17.0"), 1);
    assert.equal(compareVersions("v18.9.0", "18.17.0"), -1);
    assert.equal(compareVersions("22.0.0", "22.0.0"), 0);
    assert.equal(nodeSupportsUndici("18.19.1"), true);
    assert.equal(nodeSupportsUndici("18.16.0"), false);
    assert.equal(nodeSupportsUndici("22.12.0"), true);
  });

  it("uses undici on a supported Node", async () => {
    const status = await prepareUpstreamFetch();
    assert.deepEqual(status, { mode: "undici" });
    assert.equal(upstreamFetchWarning(status), undefined);
    assert.deepEqual(upstreamFetchStatus(), { mode: "undici" });
  });

  it("falls back to the built-in fetch on an old Node, with a one-line warning", async () => {
    let loaded = false;
    const status = await prepareUpstreamFetch(async () => {
      loaded = true;
      return import("undici");
    }, "18.12.0");
    assert.equal(loaded, false, "undici must not even be imported");
    assert.equal(status.mode, "builtin");
    const warning = upstreamFetchWarning(status) ?? "";
    assert.match(warning, /Node 18\.12\.0 is older than 18\.17\.0/);
    assert.match(warning, /longer than ~300s may be cut/);
    assert.match(warning, /Node 18\.17\.0 or newer/);
    assert.doesNotMatch(warning, /\n/);
  });

  it("falls back when undici fails to load (e.g. File is not defined)", async () => {
    const status = await prepareUpstreamFetch(async () => {
      throw new ReferenceError("File is not defined");
    });
    assert.equal(status.mode, "builtin");
    assert.match(status.reason ?? "", /File is not defined/);
  });

  it("serves requests through the built-in fetch after a fallback", async () => {
    await prepareUpstreamFetch(async () => {
      throw new Error("nope");
    });
    const server = createServer((_req, res) => res.end("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await upstreamFetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "hello");
    } finally {
      server.close();
    }
  });
});

describe("engines check", () => {
  it("parses >= ranges only", () => {
    assert.equal(minimumNodeVersion(">=22.0.0"), "22.0.0");
    assert.equal(minimumNodeVersion(">= 20"), "20");
    assert.equal(minimumNodeVersion("^22 || ^24"), undefined);
    assert.equal(minimumNodeVersion(undefined), undefined);
  });

  it("supports Node 18.17+ (no warning on the user's Node 18.19.1)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { engines: { node: string } };
    assert.equal(pkg.engines.node, ">=18.17.0");
    assert.equal(nodeEngineWarning("v18.19.1", pkg.engines.node), undefined);
    assert.equal(nodeEngineWarning("v20.10.0", pkg.engines.node), undefined);
    assert.match(nodeEngineWarning("v18.12.0", pkg.engines.node) ?? "", /running on Node v18\.12\.0/);
  });

  it("warns (not throws) naming the running version", () => {
    assert.equal(isOlderThan("v18.19.1", "22.0.0"), true);
    const warning = nodeEngineWarning("v18.19.1", ">=22.0.0") ?? "";
    assert.match(warning, /running on Node v18\.19\.1/);
    assert.match(warning, />=22\.0\.0/);
    assert.equal(nodeEngineWarning("v22.12.0", ">=22.0.0"), undefined);
    assert.equal(nodeEngineWarning("v18.19.1", undefined), undefined);
  });
});
