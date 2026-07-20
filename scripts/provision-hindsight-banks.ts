#!/usr/bin/env bun
/**
 * CLI: provision the three Hindsight banks for a repo.
 *
 * Usage: provision-hindsight-banks [--repo-slug <slug>]
 *
 - Reads HINDSIGHT_BASE_URL (default http://127.0.0.1:8888) and
 *   HINDSIGHT_BEARER_TOKEN (spec INV-HM1, preferred) or HINDSIGHT_API_KEY
 *   (research-brief/legacy fallback) for the real HindsightClient.
 * - Reads SWARMCLAW_BASE_URL for the bridge probe (optional — if unset, the
 *   probe falls back to http://127.0.0.1:3000; connection failure surfaces as
 *   -32001 bridge-not-registered, satisfying AC-4 from the real CLI).
 * - On {ok:false} → prints JSON envelope to stdout + exit(1).
 * - On {ok:true} → prints {ok,banks,requestId} JSON + exit(0).
 * - Single JSON object to stdout only (no interleaved log lines — the logger
 *   writes to a separate sink; we route it to stderr to keep stdout clean).
 */

import { basename } from "node:path";
import { HindsightClient } from "../src/hindsight/index.ts";
import {
  provisionBanks,
  type BridgeProbe,
} from "../src/hindsight/bank-provisioner.ts";
import { setLogSink } from "../src/swarmclaw/mcp/stdio-transport.ts";
import { parseValueFlags } from "./lib/cli-args.ts";

// Route structured logs to stderr so stdout carries only the JSON envelope.
// Guarded by import.meta.main so importing this module (e.g. for a shared
// helper) does not hijack the process-global log sink or kick off a provision.
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

interface ArgSpec {
  repoSlug?: string;
}

export function parseArgs(argv: string[]): ArgSpec {
  const out: ArgSpec = {};
  // Grammar + validation live in the shared helper; this wrapper owns only the
  // flag table (`--repo-slug` / `--repo` aliases), the output mapping, and the
  // help text. argv stays string[] — the only caller is process.argv.slice(2).
  parseValueFlags(argv, {
    flags: ["--repo-slug", "--repo"],
    onValue: (flag, v) => {
      if (flag === "--repo-slug" || flag === "--repo") out.repoSlug = v;
    },
    help: [
      "Usage: provision-hindsight-banks [--repo-slug <slug>]",
      "",
      "Defaults:",
      "  --repo-slug  QDS_REPO_SLUG env, else cwd basename",
      "",
    ],
  });
  return out;
}

function defaultRepoSlug(): string {
  return process.env.QDS_REPO_SLUG ?? basename(process.cwd());
}

/**
 * Bridge probe via SwarmClaw (optional). Looks for a registered MCP server
 * whose name contains "hindsight", then GETs its /test endpoint. If
 * SWARMCLAW_BASE_URL is unset, falls back to the conventional SwarmClaw port
 * http://127.0.0.1:3000 — if that connection fails the probe returns
 * {registered:false, healthy:false}, so AC-4 (-32001) can still fire from the
 * real CLI when SwarmClaw is down (previously the dev short-circuit masked it).
 */
export async function realBridgeProbe(): Promise<BridgeProbe> {
  const base = process.env.SWARMCLAW_BASE_URL ?? "http://127.0.0.1:3000";
  const url = base.replace(/\/+$/, "");
  // ponytail: 5s budget per fetch — hung SwarmClaw shouldn't hang provision.
  const fetchWithTimeout = async (target: string): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      return await fetch(target, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const res = await fetchWithTimeout(`${url}/api/mcp-servers`);
    if (!res.ok) {
      // 401/403: the bridge endpoint responded but auth-blocked us. The bridge
      // IS registered (the HTTP server is up); health can't be verified.
      // Anything else (404/5xx) → treat as not registered. Mapping 401/403 to
      // "not registered" would misdiagnose an auth gap as a registration gap.
      if (res.status === 401 || res.status === 403) {
        return { registered: true, healthy: false };
      }
      return { registered: false, healthy: false };
    }
    const data: unknown = await res.json();
    const servers: unknown[] = Array.isArray(data)
      ? data
      : (data as { servers?: unknown[] })?.servers ?? [];
    const hs = servers.find((s) => {
      if (s === null || typeof s !== "object") return false;
      const name = (s as { name?: unknown }).name;
      return typeof name === "string" && name.toLowerCase().includes("hindsight");
    });
    if (!hs) return { registered: false, healthy: false };
    const id = (hs as { id?: unknown }).id;
    if (typeof id !== "string" && typeof id !== "number") {
      // The server matched the "hindsight" name but exposes no usable id, so
      // we cannot call /test. Fail closed on health (AC-5): registered by name
      // match, but health unconfirmed rather than assumed healthy.
      return { registered: true, healthy: false };
    }
    // The server WAS found in /api/mcp-servers (we have its id), so it IS
    // registered. A failure reaching or parsing /test is a HEALTH-CHECK failure
    // (the -32002 Hindsight-unavailable path), NOT a registration failure
    // (-32001). Wrap the /test fetch + parse in a nested try-catch so a timeout
    // or non-JSON body returns {registered:true, healthy:false} instead of
    // throwing into the outer catch and misdiagnosing as not-registered.
    try {
      const testRes = await fetchWithTimeout(`${url}/api/mcp-servers/${id}/test`);
      if (!testRes.ok) return { registered: true, healthy: false };
      const testBody: unknown = await testRes.json();
      // Exclude arrays: typeof [] === "object" in JS, so an array body must not
      // be narrowed as a {ok} object.
      const ok =
        typeof testBody === "object" &&
        testBody !== null &&
        !Array.isArray(testBody) &&
        (testBody as { ok?: unknown }).ok === true;
      return { registered: true, healthy: ok };
    } catch {
      return { registered: true, healthy: false };
    }
  } catch {
    return { registered: false, healthy: false };
  }
}

async function main(): Promise<number> {
  let args: ArgSpec;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    // parseArgs throws on a bad flag / missing value (user typo). Emit a
    // structured envelope rather than a raw stack trace — parity with
    // import-mulch-expertise.ts. Shape mirrors ProvisionErr so consumers
    // reading {ok,error,requestId} see one consistent failure contract.
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        requestId: crypto.randomUUID(),
        error: { code: "bad_args", message: (e as Error).message },
      })}\n`,
    );
    return 1;
  }
  const repoSlug = args.repoSlug ?? defaultRepoSlug();

  // INV-HM1: the client constructor reads HINDSIGHT_BEARER_TOKEN (preferred)
  // then HINDSIGHT_API_KEY (legacy) from env, coercing empty strings to
  // undefined. No explicit apiKey here — passing one would re-introduce the
  // empty-string-shadows-fallback hazard the constructor now guards against.
  const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL,
  });
  const bridgeProbe = await realBridgeProbe();

  const result = await provisionBanks({ client, repoSlug, bridgeProbe });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

// Only run when invoked directly (not when imported by tests / other scripts).
if (import.meta.main) {
  const code = await main();
  process.exitCode = code;
}
