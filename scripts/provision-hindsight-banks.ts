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
 *   probe falls back to SwarmClaw's default http://127.0.0.1:3100; connection
 *   failure surfaces as -32001 bridge-not-registered, satisfying AC-4 from the
 *   real CLI), SWARMCLAW_MCP_SERVER_ID (or --mcp-server-id) for the id to
 *   probe, and SWARMCLAW_AUTH_TOKEN for the bearer the listener requires when
 *   it is configured.
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
  /**
   * SwarmClaw's id for the registered Hindsight MCP server. Required to probe
   * the bridge: ids are UUIDs minted at registration (`MCPStore.reserve`) and
   * SwarmClaw exposes no listing route, so there is nothing to discover them
   * from. Falls back to SWARMCLAW_MCP_SERVER_ID.
   */
  mcpServerId?: string;
}

export function parseArgs(argv: string[]): ArgSpec {
  const out: ArgSpec = {};
  // Grammar + validation live in the shared helper; this wrapper owns only the
  // flag table (`--repo-slug` / `--repo` aliases), the output mapping, and the
  // help text. argv stays string[] — the only caller is process.argv.slice(2).
  parseValueFlags(argv, {
    flags: ["--repo-slug", "--repo", "--mcp-server-id"],
    onValue: (flag, v) => {
      if (flag === "--repo-slug" || flag === "--repo") out.repoSlug = v;
      if (flag === "--mcp-server-id") out.mcpServerId = v;
    },
    help: [
      "Usage: provision-hindsight-banks [--repo-slug <slug>] [--mcp-server-id <id>]",
      "",
      "Defaults:",
      "  --repo-slug      QDS_REPO_SLUG env, else cwd basename",
      "  --mcp-server-id  SWARMCLAW_MCP_SERVER_ID env (no default — without it",
      "                   the bridge probe cannot confirm registration)",
      "",
    ],
  });
  return out;
}

function defaultRepoSlug(): string {
  return process.env.QDS_REPO_SLUG ?? basename(process.cwd());
}

/**
 * Bridge probe via SwarmClaw: POST `/api/mcp-servers/{id}/test`, the route that
 * re-validates the registered server's transport (`src/swarmclaw/index.ts:7`).
 *
 * F008: this used to GET a `/api/mcp-servers` listing on port 3000. SwarmClaw
 * binds 3100 by default and every route is POST-only, so the probe returned
 * `{registered:false}` unconditionally and `provisionBanks` short-circuited to
 * -32001 on every real invocation.
 *
 * The id is not discoverable — SwarmClaw mints a UUID at registration
 * (`MCPStore.reserve`) and exposes no listing route — so it must be supplied
 * via `--mcp-server-id` or SWARMCLAW_MCP_SERVER_ID. Without one, registration
 * cannot be CONFIRMED, so the probe fails closed to `{registered:false}` (AC-4
 * -32001) rather than assuming a healthy bridge.
 */
export async function realBridgeProbe(mcpServerId?: string): Promise<BridgeProbe> {
  const base = process.env.SWARMCLAW_BASE_URL ?? "http://127.0.0.1:3100";
  const url = base.replace(/\/+$/, "");
  const id = mcpServerId ?? process.env.SWARMCLAW_MCP_SERVER_ID;
  if (!id) return { registered: false, healthy: false };
  // The listener checks this bearer above its 413 guard when
  // SWARMCLAW_AUTH_TOKEN is configured; unset means the listener runs open and
  // an Authorization header would just be ignored. No Origin header is sent —
  // SwarmClaw refuses any request carrying one (browser-only signal).
  const token = process.env.SWARMCLAW_AUTH_TOKEN;
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // ponytail: 5s budget per fetch — hung SwarmClaw shouldn't hang provision.
  // Ceiling: no retry, and the timeout is a per-call constant rather than a
  // shared transient-failure policy. Upgrade trigger: Task 5.4 replaces this
  // wrapper with `src/lib/http.ts`, at which point this block and the four
  // other hand-rolled fetch wrappers collapse into one contract.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${url}/api/mcp-servers/${encodeURIComponent(id)}/test`, {
      method: "POST",
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 401/403: the bridge endpoint responded but auth-blocked us. The bridge
      // IS registered (the HTTP server is up); health can't be verified.
      // Anything else (404 unknown id / 5xx) → treat as not registered. Mapping
      // 401/403 to "not registered" would misdiagnose an auth gap as a
      // registration gap.
      if (res.status === 401 || res.status === 403) {
        return { registered: true, healthy: false };
      }
      return { registered: false, healthy: false };
    }
    // A 200 proves the id is registered. A failure to PARSE the body is a
    // HEALTH-CHECK failure, not a registration failure, so it must not fall
    // through to the outer {registered:false}.
    try {
      const body: unknown = await res.json();
      // Exclude arrays: typeof [] === "object" in JS, so an array body must not
      // be narrowed as a {ok} object.
      const ok =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { ok?: unknown }).ok === true;
      return { registered: true, healthy: ok };
    } catch {
      return { registered: true, healthy: false };
    }
  } catch {
    return { registered: false, healthy: false };
  } finally {
    clearTimeout(timer);
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
  const bridgeProbe = await realBridgeProbe(args.mcpServerId);

  const result = await provisionBanks({ client, repoSlug, bridgeProbe });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

// Only run when invoked directly (not when imported by tests / other scripts).
if (import.meta.main) {
  const code = await main();
  process.exitCode = code;
}
