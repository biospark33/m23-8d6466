#!/usr/bin/env bun
/**
 * CLI: provision the three Hindsight banks for a repo.
 *
 * Usage: provision-hindsight-banks [--repo-slug <slug>]
 *
 - Reads HINDSIGHT_BASE_URL (default http://127.0.0.1:8888) + HINDSIGHT_API_KEY
 *   for the real HindsightClient.
 * - Reads SWARMCLAW_BASE_URL for the bridge probe (optional — if unset, the
 *   probe defaults to {registered:true, healthy:true} so the script can run
 *   standalone in tests / dev without a live SwarmClaw).
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

// Route structured logs to stderr so stdout carries only the JSON envelope.
setLogSink((entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
});

interface ArgSpec {
  repoSlug?: string;
}

function parseArgs(argv: string[]): ArgSpec {
  const out: ArgSpec = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo-slug" || a === "--repo") {
      const v = argv[i + 1];
      if (typeof v === "string" && v.length > 0) {
        out.repoSlug = v;
        i++;
      }
    } else if (a.startsWith("--repo-slug=")) {
      out.repoSlug = a.slice("--repo-slug=".length);
    }
  }
  return out;
}

function defaultRepoSlug(): string {
  return process.env.QDS_REPO_SLUG ?? basename(process.cwd());
}

/**
 * Bridge probe via SwarmClaw (optional). Looks for a registered MCP server
 * whose name contains "hindsight", then GETs its /test endpoint. If
 * SWARMCLAW_BASE_URL is unset, returns {registered:true, healthy:true} so the
 * script works standalone in dev/tests.
 */
async function realBridgeProbe(): Promise<BridgeProbe> {
  const base = process.env.SWARMCLAW_BASE_URL;
  if (!base) return { registered: true, healthy: true };
  const url = base.replace(/\/+$/, "");
  try {
    const res = await fetch(`${url}/api/mcp-servers`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { registered: false, healthy: false };
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
      return { registered: true, healthy: true };
    }
    const testRes = await fetch(`${url}/api/mcp-servers/${id}/test`, {
      headers: { accept: "application/json" },
    });
    if (!testRes.ok) return { registered: true, healthy: false };
    const testBody: unknown = await testRes.json();
    const ok =
      typeof testBody === "object" &&
      testBody !== null &&
      (testBody as { ok?: unknown }).ok === true;
    return { registered: true, healthy: ok };
  } catch {
    return { registered: false, healthy: false };
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repoSlug = args.repoSlug ?? defaultRepoSlug();

  const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL,
    apiKey: process.env.HINDSIGHT_API_KEY,
  });
  const bridgeProbe = await realBridgeProbe();

  const result = await provisionBanks({ client, repoSlug, bridgeProbe });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

const code = await main();
process.exit(code);
