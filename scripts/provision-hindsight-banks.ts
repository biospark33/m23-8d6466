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
 * - --no-bridge-probe (DD-17, dedicated Hindsight VPS): skip the SwarmClaw
 *   bridge probe entirely and provision against the always-healthy literal —
 *   the /invoke transport is dead on the dedicated instance, so a real probe
 *   would fail closed to {registered:false} (-32001) and block that topology.
 * - INV-MEM-1: the resolved per-repo bank id must be qds--prefixed (default
 *   slug "QDS-Factory" → resolveBankId → "qds-factory"); other --repo-slug
 *   values are refused with bank_prefix_violation before any client is
 *   constructed.
 * - Round-1 review hardening: the base-URL guard also refuses whitespace-only
 *   values (F-013) and wrong-instance trap origins — :8888, the client's
 *   silent shared-sidecar default, and :18889, the tenant stack's host map —
 *   via leg-lib forbiddenOrigin (F-003, code base_url_trap); the checked
 *   (normalized) value is the value the client is constructed with.
 * - Rerun-aware (F-025-CLI): a second run against an already-provisioned repo
 *   PUT-upserts the canonical roster [base, base-dev-meta, qds-collective]
 *   via leg-lib rerunAwareProvision instead of letting the resolver treat our
 *   own base bank as a foreign collision and mint base-2 junk — "run twice
 *   creates nothing new" (story AC3 demo). Both lanes (dedicated AND shared)
 *   provision the same roster under the same discipline.
 * - m1-1 round-2 hardening: the pre-provision snapshot fails CLOSED (R2-004 —
 *   a listBanks THROW refuses with code snapshot_failed; an answering EMPTY
 *   roster stays fresh-lane); the rerun lane acquires the provision-family
 *   lock with a heartbeat around the roster upserts (R2-005); the rerun
 *   envelope is normalized to the committed {ok,banks,requestId,mode,
 *   createdInAttempt} shape (+error{code,message} on failure, R2-007) with
 *   onStep lines on stderr (R2-011) and NO bridge-probe POST (the rerun
 *   branch never reads the verdict); the prefix guard validates the id that
 *   will actually be minted (R2-012, safeRepoBase output) and refuses the
 *   fixed collective roster id as a repo slug (R2-021).
 * - m1-1 round-3 hardening: the provision-family lock is taken FIRST and the
 *   fresh-vs-rerun classification snapshots INSIDE the window (R3-003 — the
 *   fork never trusts pre-lock state; the fresh provision runs noLock under
 *   the held lock); the lock is the drivers' hardened variant (R3-006 —
 *   pid-aware holder, lock-dir mkdir inside the try, guarded release); every
 *   path prints ONE envelope built from the ACTUAL result (R3-007/R3-008 —
 *   banks are bankId strings, [] on failure); a failed rerun compensates its
 *   claim-scoped creations and names the rest as residue (R3-004).
 * - On {ok:false} → prints JSON envelope to stdout + exit(1).
 * - On {ok:true} → prints {ok,banks,requestId} JSON + exit(0).
 * - Single JSON object to stdout only (no interleaved log lines — the logger
 *   writes to a separate sink; we route it to stderr to keep stdout clean).
 */

import { basename } from "node:path";
import { homedir } from "node:os";
import { HindsightClient } from "../src/hindsight/index.ts";
import { httpRequest } from "../src/lib/http.ts";
import {
  provisionBanks,
  type BridgeProbe,
  type ProvisionClient,
  type ProvisionOptions,
  type ProvisionResult,
} from "../src/hindsight/bank-provisioner.ts";
import { resolveBankId } from "../src/hindsight/schemas.ts";
import { setLogSink } from "../src/swarmclaw/mcp/stdio-transport.ts";
import { parseValueFlags } from "./lib/cli-args.ts";
import {
  acquireHeartbeatLock,
  COLLECTIVE_BANK_ID,
  extractBankIds,
  forbiddenOrigin,
  LEG_LOCK_STALE_MS,
  rerunAwareProvision,
  safeRepoBase,
  type RerunAwareProvisionResult,
} from "./p0-9/leg-lib.ts";
import { isPidDead } from "../src/lib/file-lock.ts";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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
  /**
   * DD-17 (dedicated Hindsight VPS): skip realBridgeProbe entirely and
   * provision against the always-healthy literal. The /invoke transport is
   * dead on the dedicated instance, so a real probe would fail closed to
   * {registered:false} (-32001) without a SWARMCLAW_MCP_SERVER_ID and block
   * the dedicated topology.
   */
  noBridgeProbe?: boolean;
}

export function parseArgs(argv: string[]): ArgSpec {
  const out: ArgSpec = {};
  // --no-bridge-probe is a bool flag; parseValueFlags owns only value flags
  // (a bare token there would throw "requires a non-empty value"), so the
  // exact token is consumed here before the value-flag walk. F-014: the
  // caller's argv is NEVER mutated — the parameter is rebound to a filtered
  // COPY, and the committed parseValueFlags call below reads that binding.
  // The `=value` form is deliberately left in: parseValueFlags rejects it as
  // an unknown flag, matching the exact-token-only bool grammar of
  // tokenizeArgs.
  const hadBoolFlag = argv.includes("--no-bridge-probe");
  // biome-ignore lint/style/noParameterAssign: rebinding the parameter to a defensive copy IS the F-014 fix (parse must not mutate the caller's argv); the alternative — a local handed to the value-flag walk — would require editing the committed parseValueFlags call line
  argv = argv.filter((token) => token !== "--no-bridge-probe");
  if (hadBoolFlag) out.noBridgeProbe = true;
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
      "  HINDSIGHT_BASE_URL  REQUIRED — no silent default (the client's",
      "                       127.0.0.1:8888 fallback is the tenant sidecar's",
      "                       port on both-stacks boxes); dedicated instance:",
      "                       http://127.0.0.1:18890 host-side (DD-28.22, runbook §6.4)",
      "",
      "Dedicated Hindsight VPS (DD-17): add --no-bridge-probe to skip the",
      "SwarmClaw bridge probe — the /invoke transport is dead on the dedicated",
      "instance, so a real probe would fail closed (-32001) and block the",
      "topology; provisioning proceeds with the always-healthy literal.",
      "",
      "Rerun-safe: a second run against an already-provisioned repo",
      "PUT-upserts the canonical roster and creates nothing new (AC3 demo).",
      "",
      "Bank ids must resolve qds--prefixed (INV-MEM-1): the default slug does",
      "('QDS-Factory' → qds-factory); other --repo-slug values (e.g. myrepo)",
      "are refused with bank_prefix_violation.",
      "",
    ],
  });
  return out;
}

function defaultRepoSlug(): string {
  return process.env.QDS_REPO_SLUG ?? basename(process.cwd());
}

/**
 * INV-MEM-1 guard (story Security Invariants: "every bank id explicit and
 * qds--prefixed"): derive the per-repo bank id exactly as provisionBanks will
 * (resolveBankId) and refuse any slug whose id lacks the `qds-` prefix — the
 * v6a explicit-roster discipline, enforced at the CLI boundary before any
 * client is constructed. The default slug passes (cwd basename "QDS-Factory"
 * → "qds-factory"); `--repo-slug myrepo` resolves to "myrepo" and is refused.
 * The ≤52-char collision disambiguation stays inside provisionBanks — this
 * is the prefix check only.
 */
export function checkBankPrefix(
  repoSlug: string,
):
  | { ok: true; bankId: string }
  | { ok: false; code: "bank_prefix_violation"; message: string } {
  const bankId = resolveBankId(repoSlug);
  if (!bankId.startsWith("qds-")) {
    return {
      ok: false,
      code: "bank_prefix_violation",
      message: `resolved bank id "${bankId}" (from repo slug "${repoSlug}") lacks the qds- prefix required by INV-MEM-1 (every bank id explicit and qds--prefixed)`,
    };
  }
  // R2-021 (added): the fixed collective roster id is not a repo base — as a
  // slug it takes the rerun lane permanently and mints
  // qds-collective-dev-meta junk attributed to a "repo" that is not one.
  if (bankId === COLLECTIVE_BANK_ID) {
    return {
      ok: false,
      code: "bank_prefix_violation",
      message: `repo slug "${repoSlug}" resolves to "${COLLECTIVE_BANK_ID}" — the fixed collective roster id, not a repo base (a rerun lane forever, minting ${COLLECTIVE_BANK_ID}-dev-meta junk); pass a real repo slug`,
    };
  }
  // R2-012 (added): the guard must validate the id provisioning will actually
  // MINT — safeRepoBase's truncate+trim output, not the untruncated
  // resolution. A slug long enough to truncate returns the minted (shorter)
  // id so guard value === minted value.
  if (safeRepoBase(repoSlug) !== bankId) {
    return { ok: true, bankId: safeRepoBase(repoSlug) };
  }
  return { ok: true, bankId };
}

/**
 * Fail-closed base-URL guard: HINDSIGHT_BASE_URL must be set (non-empty,
 * non-whitespace — F-013) and must not be a wrong-instance trap origin
 * (F-003) before a client is constructed. HindsightClient silently defaults
 * to http://127.0.0.1:8888 — on a both-stacks box that is the TENANT
 * sidecar's port, so a dedicated-topology provision with the env unset (or
 * explicitly pointed at :8888 / :18889, the tenant stack's host map) would
 * write qds- banks into the shared tenant instance: the foreign-bank
 * incident class INV-MEM-1 exists to prevent, and the exact wrong-instance
 * path story AC1's negative control fails. Runbook §6.4: always set the
 * variable, nothing may rely on the default. Dedicated instance origin is
 * host-side http://127.0.0.1:18890 (DD-28.22's origin split).
 *
 * The trap table itself is leg-lib's forbiddenOrigin (single source — the
 * same normalization and :8888/:18889 suffix + URL-port matching the six leg
 * drivers gate on), surfaced here as a distinct `base_url_trap` refusal code
 * so operators and tests can tell "you did not set it" apart from "you set
 * it to the wrong instance". Returns the CHECKED (normalized: trimmed,
 * trailing slashes stripped) value — the checked value is the used value
 * (F-013: main threads it into the client construction instead of
 * discarding it and re-reading env). Exported pure so tests cover exactly
 * the decision main() executes.
 */
export function checkHindsightBaseUrl():
  | { ok: true; baseUrl: string }
  | { ok: false; code: "base_url_required" | "base_url_trap"; message: string } {
  const baseUrl = process.env.HINDSIGHT_BASE_URL;
  // whitespace-only is as good as unset (F-013): a blank-looking value must
  // not slip past the fail-closed guard and become the client's silent
  // default.
  if (baseUrl === undefined || baseUrl.trim() === "") {
    return {
      ok: false,
      code: "base_url_required",
      message:
        "HINDSIGHT_BASE_URL is unset/empty/whitespace-only — refusing to provision: HindsightClient would silently default to http://127.0.0.1:8888, the TENANT sidecar's port on a both-stacks box (the foreign-bank write class INV-MEM-1 exists to prevent; runbook §6.4; story AC1 negative control). Set it explicitly — dedicated instance: http://127.0.0.1:18890 host-side (DD-28.22).",
    };
  }
  // F-003: an explicitly-set trap origin is the same wrong-instance write as
  // the silent default — refuse it with its own code. forbiddenOrigin
  // normalizes (trim + trailing slashes) before matching, so padded or
  // slash-suffixed spellings of a trap origin cannot slip through.
  const trap = forbiddenOrigin(baseUrl);
  if (trap !== null) {
    return { ok: false, code: "base_url_trap", message: trap };
  }
  return { ok: true, baseUrl: baseUrl.trim().replace(/\/+$/, "") };
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
  try {
    // 5 s and no retry: a hung SwarmClaw must not hang provisioning, and a
    // probe is safe to simply fail closed. `onHttpError` is deliberately
    // omitted — the STATUS is the answer here, not an error (see below).
    const { res, text } = await httpRequest(
      `${url}/api/mcp-servers/${encodeURIComponent(id)}/test`,
      { method: "POST" },
      { timeoutMs: 5_000, headers },
    );
    if (!res.ok) {
      // 404 is the ONLY "not registered" answer: `handleTestMCPServer` returns
      // it when `store.get(id)` misses. Every other failure means the server
      // WAS found (or the listener never got far enough to look) — 502 for a
      // dead transport or zero enumerated tools, 401/403 for an auth gap — so
      // it is a HEALTH failure (-32002), not a registration failure (-32001).
      // Collapsing those into "not registered" is the same misdiagnosis review
      // R2 removed for 401/403.
      return { registered: res.status !== 404, healthy: false };
    }
    // A 200 proves the id is registered. A failure to PARSE the body is a
    // HEALTH-CHECK failure, not a registration failure, so it must not fall
    // through to the outer {registered:false}.
    try {
      const body: unknown = JSON.parse(text);
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
  }
}

/**
 * Probe decision per topology. The shared (SwarmClaw-bridged) path probes for
 * real; the dedicated Hindsight VPS path (DD-17) has no /invoke bridge, so it
 * short-circuits to the always-healthy literal — realBridgeProbe would fail
 * closed to {registered:false} there (no SWARMCLAW_MCP_SERVER_ID to confirm
 * against) and provisionBanks would -32001-block the dedicated topology.
 * Exported pure so tests cover exactly the decision main() executes.
 */
export async function resolveProbe(
  useDedicated: boolean,
  mcpServerId?: string,
): Promise<BridgeProbe> {
  if (useDedicated) return { registered: true, healthy: true };
  return realBridgeProbe(mcpServerId);
}

/**
 * F-025-CLI lane decision, exported pure so tests cover exactly the fork
 * main() executes: TRUE → the base bank the provisioner's resolver would
 * land on (leg-lib safeRepoBase — same resolveBankId + ≤52-char truncation)
 * is already present in the pre-provision listBanks snapshot, i.e. this is a
 * rerun of a repo this CLI provisioned before → the rerun-aware lane
 * (rerunAwareProvision's PUT-upsert of the canonical roster) instead of
 * provisionBanks' collision loop, which would treat our own base bank as a
 * foreign collision and mint `<base>-2` junk on every rerun. FALSE → fresh
 * path, provisionBanks verbatim. Note a suffixed junk id (`qds-factory-2`)
 * is NOT the base — only the exact base id flips the lane.
 */
export function isRerunProvision(existingBankIds: string[], repoSlug: string): boolean {
  return existingBankIds.includes(safeRepoBase(repoSlug));
}

/**
 * R2-004: the authoritative fail-CLOSED pre-provision snapshot. The legacy
 * best-effort call in main swallows a listBanks failure into an empty
 * snapshot (fresh lane — the R1 assumption was that an unreadable instance
 * fails provisionBanks anyway); a TRANSIENT failure on a healthy instance
 * instead mints `<base>-2` junk off a pretend-empty roster (3-reviewer
 * convergent). main re-asks through this seam whenever the legacy snapshot
 * reads empty: a roster that ANSWERS keeps the (confirmed-empty) fresh lane —
 * emptiness is a classification, not a failure — and a THROW is the
 * snapshot_failed refusal. Exported so tests cover exactly the decision
 * main() executes.
 */
export async function takeRerunSnapshot(
  client: { listBanks(): Promise<unknown> },
): Promise<{ ok: true; bankIds: string[] } | { ok: false; error: string }> {
  try {
    return { ok: true, bankIds: extractBankIds(await client.listBanks()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * R2-007 + R3-007/R3-008: the ONE stdout-envelope builder for every provision
 * path (rerun AND fresh — the print sites used to emit different shapes per
 * lane). `banks` is bankId STRINGS from the ACTUAL result: the rerun lane's
 * confirmed roster (every PUT landed — a failure returns before this claim)
 * and the fresh lane's provisionBanks ids, so a genuine foreign collision's
 * `<base>-2` id is reported honestly instead of the canonical roster; [] on
 * every failure (the roster is a claim, not a fact, once anything failed).
 * `mode` rides the helper's lane label, `createdInAttempt` is the helper's
 * honest figure verbatim, and a rerun failure carries the compensation
 * record (R3-004) when one was taken.
 */
export interface ProvisionEnvelope {
  ok: boolean;
  banks: string[];
  requestId: string;
  /** The helper's lane label; absent on pre-classification refusals (lock, snapshot). */
  mode?: "resolved-fresh" | "reupsert-existing";
  createdInAttempt: string[];
  error?: { code: string; message: string };
  /** Rerun-failure compensation (R3-004): per claimed bank delete outcome. */
  deleteOutcomes?: Record<string, string>;
  /** Rerun-failure compensation (R3-004): bankId → why it still stands ("unclaimed-created" | "delete-failed"). */
  residue?: Record<string, string>;
}

export function buildProvisionEnvelope(
  repoSlug: string,
  requestId: string,
  result: RerunAwareProvisionResult,
  compensation?: RerunCompensation,
): ProvisionEnvelope {
  const base = safeRepoBase(repoSlug);
  const raw = result.raw as {
    roster?: string[];
    banks?: { bankId: string }[];
    error?: unknown;
    thrown?: unknown;
  };
  const banks = result.ok
    ? result.mode === "reupsert-existing"
      ? (raw.roster ?? [base, `${base}-dev-meta`, COLLECTIVE_BANK_ID])
      : (raw.banks ?? []).map((b) => b.bankId)
    : [];
  return {
    ok: result.ok,
    banks,
    requestId,
    mode: result.mode,
    createdInAttempt: result.createdInAttempt,
    ...(!result.ok
      ? { error: { code: "provision_failed", message: failureMessage(raw) } }
      : {}),
    ...(compensation !== undefined
      ? { deleteOutcomes: compensation.deleteOutcomes, residue: compensation.residue }
      : {}),
  };
}

/**
 * The helper's three failure shapes → one message: `thrown` (a fresh-path
 * crash), a bare string (the rerun branch's PUT error), or provisionBanks'
 * `{code,message}` error object (numeric code folded into the message so the
 * envelope's `code` stays the one CLI vocabulary).
 */
function failureMessage(raw: { error?: unknown; thrown?: unknown }): string {
  if (typeof raw.thrown === "string") return raw.thrown;
  if (typeof raw.error === "string") return raw.error;
  if (raw.error !== null && typeof raw.error === "object") {
    const e = raw.error as { code?: unknown; message?: unknown };
    const detail = typeof e.message === "string" ? e.message : JSON.stringify(e);
    return typeof e.code === "number" ? `${e.code}: ${detail}` : detail;
  }
  return "provision roster failed";
}

/**
 * R3-004: rerun-lane failure compensation. The helper's documented contract
 * says failure paths report `createdInAttempt: []` and "the caller's own
 * post∖pre diff is the authority under failure" (leg-lib
 * RerunAwareProvisionResult) — the drivers honor it; the CLI rerun lane used
 * to strand partial upserts unreported.
 *
 * Claim rule (the honest version of the helper's rerun semantics): a bank is
 * THIS attempt's creation iff it is a roster member, ABSENT from the
 * pre-window snapshot, and PRESENT in the post-snapshot — post-presence, not
 * the per-step reports, is the creation evidence under failure (a createBank
 * that lands server-side and then errors still created the bank). Everything
 * else the window gained is residue "unclaimed-created" and is left alone
 * (probe banks of unlocked legs, operator creates — deleting under unknown
 * attribution is the R3-005 inversion). A post-snapshot that itself throws
 * abandons compensation with nothing claimed, mirroring the drivers'
 * no-authority discipline.
 */
export interface RerunCompensation {
  deleteOutcomes: Record<string, string>;
  residue: Record<string, string>;
}

export async function compensateRerunFailure(
  client: { listBanks(): Promise<unknown>; deleteBank(bankId: string): Promise<unknown> },
  repoSlug: string,
  preBankIds: string[],
): Promise<RerunCompensation> {
  const base = safeRepoBase(repoSlug);
  const roster = [base, `${base}-dev-meta`, COLLECTIVE_BANK_ID];
  const post = await takeRerunSnapshot(client);
  if (!post.ok) {
    return { deleteOutcomes: {}, residue: {} };
  }
  const deleteOutcomes: Record<string, string> = {};
  const residue: Record<string, string> = {};
  for (const bankId of post.bankIds) {
    if (preBankIds.includes(bankId)) continue; // pre-window bank — never this attempt's
    if (!roster.includes(bankId)) {
      residue[bankId] = "unclaimed-created";
      continue;
    }
    try {
      deleteOutcomes[bankId] = classifyDelete(await client.deleteBank(bankId));
    } catch {
      deleteOutcomes[bankId] = "failed";
      residue[bankId] = "delete-failed";
    }
  }
  return { deleteOutcomes, residue };
}

/** AC3's per-bank delete vocabulary, mirroring the drivers' deleteOutcome. */
function classifyDelete(r: unknown): string {
  if (r !== null && typeof r === "object" && !Array.isArray(r)) {
    const o = r as { deleted?: unknown; alreadyGone?: unknown; deletedCount?: unknown };
    if (o.deleted === true) return "deleted";
    if (o.alreadyGone === true || o.deletedCount === 0) return "already-gone";
  }
  return "deleted-unknown-shape";
}

/** rerunAwareProvision's structured step (leg-lib RerunAwareProvisionOpts.onStep). */
export type ProvisionStep = {
  label: string;
  mode: "resolved-fresh" | "reupsert-existing";
  ok: boolean;
  detail?: unknown;
};

/** The shared-fresh handoff: classification context + the envelope-returning provision call. */
export interface ProvisionWindowCtx {
  existingBankIds: string[];
  requestId: string;
  onStep: (s: ProvisionStep) => void;
  /**
   * The fresh provision call UNDER the held family lock (R3-003):
   * rerunAwareProvision runs with holdProvisionerLock — noLock:true inside,
   * else provisionBanks' 300s single-flight refuses against ourselves — and
   * the result is normalized through the ONE envelope builder.
   */
  provision: (o: ProvisionOptions) => Promise<ProvisionEnvelope>;
}

export interface ProvisionWindowDeps {
  /** Lock override (tests: tmpdir). Default ~/.hindsight/provision.lock. */
  lockPath?: string;
  /** DD-17 --no-bridge-probe: dedicated topology, always-healthy literal probe. */
  noBridgeProbe?: boolean;
  /** Fresh-lane provision override threaded to rerunAwareProvision (tests pin noLock). */
  provisionImpl?: (opts: ProvisionOptions) => Promise<ProvisionResult>;
}

export type OpenedProvisionWindow =
  | { kind: "settled"; envelope: ProvisionEnvelope; code: number }
  | { kind: "shared-fresh"; ctx: ProvisionWindowCtx; release: () => void };

/**
 * R3-003/R3-006: the lock-first provision window. The provision-family lock
 * (the drivers' hardened variant: lock-dir mkdir inside the try, pid-aware
 * holder — a SIGKILLed family member is stolen at once, not after 900s) is
 * acquired BEFORE anything touches the instance; the fresh-vs-rerun
 * classification snapshots INSIDE the window, so a concurrent family
 * member's compensate-then-release can no longer flip the fork's input
 * between snapshot and dispatch, and the fresh lane runs noLock under the
 * same held lock.
 *
 * Returns "settled" (envelope + exit code, lock already released) for every
 * refusal and for the rerun + dedicated-fresh lanes, or "shared-fresh" —
 * the classification came back fresh on the bridge-probed topology — with
 * the lock STILL HELD and ctx.provision bound, so the caller's fresh lane
 * runs inside the same window and releases via the handed-off release()
 * when done.
 */
export async function openProvisionWindow(
  client: ProvisionClient & { deleteBank(bankId: string): Promise<unknown> },
  repoSlug: string,
  deps: ProvisionWindowDeps = {},
): Promise<OpenedProvisionWindow> {
  const requestId = crypto.randomUUID();
  const lockPath = deps.lockPath ?? join(homedir(), ".hindsight", "provision.lock");
  const refuse = (code: string, message: string): OpenedProvisionWindow => ({
    kind: "settled",
    envelope: { ok: false, banks: [], requestId, createdInAttempt: [], error: { code, message } },
    code: 1,
  });

  let release: (() => void) | null = null;
  try {
    // R2-020/R3-006: the lock-dir mkdir lives INSIDE the try — a file-shaped
    // dirname or EACCES is a refusal envelope, never a bare crash.
    mkdirSync(dirname(lockPath), { recursive: true });
    release = await acquireHeartbeatLock(lockPath, {
      staleMs: LEG_LOCK_STALE_MS,
      // R3-006: the drivers' pid-aware holder, not age-only — a dead or
      // unparsable holder is stale NOW (the age budget only covers
      // live-but-slow windows).
      holder: ({ ageMs, pid }) =>
        ageMs >= LEG_LOCK_STALE_MS || pid === undefined || isPidDead(pid),
    });
  } catch (e) {
    return refuse(
      "provision_lock_error",
      `cannot acquire the provision-family lock at ${lockPath}: ${(e as Error).message}`,
    );
  }
  if (release === null) {
    return refuse(
      "provision_lock_busy",
      `the provision-family lock at ${lockPath} is held by a live holder — provisioning cannot serialize with a concurrent provision-family writer; retry`,
    );
  }
  // R3-006: guarded release — a taken-over lock is a diagnostic, never an
  // outcome (driver pattern; an unguarded throw would crash past the
  // envelope the caller already printed).
  const releaseGuarded = (): void => {
    try {
      release();
    } catch (e) {
      process.stderr.write(
        `${JSON.stringify({ event: "lock-release", outcome: "warn-taken-over", detail: (e as Error).message })}\n`,
      );
    }
  };

  // R2-004: the fail-closed classification snapshot, now INSIDE the window
  // (R3-003) — a THROW is the snapshot_failed refusal; an answering roster
  // (even empty) classifies.
  const gate = await takeRerunSnapshot(client);
  if (!gate.ok) {
    releaseGuarded();
    return refuse(
      "snapshot_failed",
      `pre-provision listBanks failed — fresh-vs-rerun cannot be classified; refusing rather than provision off a pretend-empty roster: ${gate.error}`,
    );
  }
  const existingBankIds = gate.bankIds;
  // R2-011-CLI: one stderr line per provision step (stdout stays envelope-only).
  const onStep = (s: ProvisionStep): void => {
    process.stderr.write(`${JSON.stringify({ event: "provision-step", ...s })}\n`);
  };
  // One attempt seam for both dispatch lanes: the rerun lane passes no
  // bridgeProbe (R2-011 — the rerun branch never reads a verdict, so no POST
  // is fired), the dedicated fresh lane passes the DD-17 literal. Both run
  // under the held family lock (holdProvisionerLock → noLock:true inside).
  const attempt = (bridgeProbe?: BridgeProbe): Promise<RerunAwareProvisionResult> =>
    rerunAwareProvision(client, repoSlug, {
      existingBankIds,
      ...(bridgeProbe !== undefined ? { bridgeProbe } : {}),
      holdProvisionerLock: true,
      requestId,
      onStep,
      provisionImpl: deps.provisionImpl ?? provisionBanks,
    });

  // R3-002: reruns are handled solely by this classified dispatch — one lane, both topologies; the fresh path below never re-forks on rerun.
  const rerun = isRerunProvision(existingBankIds, repoSlug);
  if (rerun || deps.noBridgeProbe === true) {
    const result = await attempt(rerun ? undefined : await resolveProbe(true));
    // R3-004: a failed RERUN owns its partial upserts — post-snapshot, diff,
    // compensate the claim-scoped creations. A fresh failure is
    // provisionBanks' own envelope's to report (banks [] is the honest figure).
    const compensation =
      !result.ok && result.mode === "reupsert-existing"
        ? await compensateRerunFailure(client, repoSlug, existingBankIds)
        : undefined;
    const envelope = buildProvisionEnvelope(repoSlug, requestId, result, compensation);
    releaseGuarded();
    return { kind: "settled", envelope, code: envelope.ok ? 0 : 1 };
  }

  return {
    kind: "shared-fresh",
    ctx: {
      existingBankIds,
      requestId,
      onStep,
      provision: async (o) =>
        buildProvisionEnvelope(repoSlug, requestId, await attempt(o.bridgeProbe)),
    },
    release: releaseGuarded,
  };
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

  // INV-MEM-1 (story Security Invariants: "every bank id explicit and
  // qds--prefixed"): refuse any slug whose resolved bank id lacks the qds-
  // prefix BEFORE a client is constructed. The default slug passes (cwd
  // basename "QDS-Factory" → resolveBankId → "qds-factory"); a caller passing
  // --repo-slug myrepo resolves to "myrepo" and is refused. The ≤52-char
  // collision discipline lives inside provisionBanks — this is the roster
  // boundary check only. Envelope mirrors the bad_args contract above.
  const prefix = checkBankPrefix(repoSlug);
  if (!prefix.ok) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        requestId: crypto.randomUUID(),
        error: { code: prefix.code, message: prefix.message },
      })}\n`,
    );
    return 1;
  }

  // Fail-closed base URL, guarding BOTH lanes (shared AND --no-bridge-probe):
  // the client constructor silently defaults HINDSIGHT_BASE_URL to
  // http://127.0.0.1:8888 — the TENANT sidecar's port on a both-stacks box.
  // A dedicated-topology run against that default writes qds- banks into the
  // shared tenant instance: the foreign-bank class INV-MEM-1 exists to
  // prevent, and the exact wrong-instance path story AC1's negative control
  // fails (runbook §6.4 — always set the variable, nothing may rely on the
  // default; dedicated origin 127.0.0.1:18890 host-side per DD-28.22).
  const baseUrlCheck = checkHindsightBaseUrl();
  if (!baseUrlCheck.ok) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        requestId: crypto.randomUUID(),
        error: { code: baseUrlCheck.code, message: baseUrlCheck.message },
      })}\n`,
    );
    return 1;
  }

  // F-013: the checked value is the used value — write the guard's
  // normalized origin back so the env-sourced client construction below
  // (this diff stays adds-only, so that construction line is untouched)
  // consumes exactly what the guard approved: one source of truth, no
  // discard-and-reread. Process-local: main() exits right after.
  process.env.HINDSIGHT_BASE_URL = baseUrlCheck.baseUrl;

  // INV-HM1: the client constructor reads HINDSIGHT_BEARER_TOKEN (preferred)
  // then HINDSIGHT_API_KEY (legacy) from env, coercing empty strings to
  // undefined. No explicit apiKey here — passing one would re-introduce the
  // empty-string-shadows-fallback hazard the constructor now guards against.
  const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL,
  });

  // R3-003 (round-3): the lock-first provision window — the hardened
  // provision-family lock is acquired, the snapshot/classification/dispatch
  // all run inside it. Every settled path prints the ONE envelope
  // (R3-007/R3-008); the shared fresh lane continues into the committed tail
  // below, INSIDE the still-held window, and releases after printing.
  const opened = await openProvisionWindow(client, repoSlug, {
    noBridgeProbe: args.noBridgeProbe,
  });
  if (opened.kind === "settled") {
    process.stdout.write(`${JSON.stringify(opened.envelope)}\n`);
    return opened.code;
  }
  // R3-003/R3-007: the committed shared-fresh tail below is pinned verbatim
  // by the adds-only gate, so it routes through this LOCAL binding of
  // provisionBanks — ctx.provision runs under the window's held family lock
  // (noLock:true inside, else the inner 300s single-flight refuses against
  // ourselves) and returns the ONE-envelope shape the pinned print emits.
  const provisionBanks = opened.ctx.provision;
  const bridgeProbe = await realBridgeProbe(args.mcpServerId);

  const result = await provisionBanks({ client, repoSlug, bridgeProbe });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  opened.release(); // guarded inside the window (R3-006)
  return result.ok ? 0 : 1;
}

// Only run when invoked directly (not when imported by tests / other scripts).
if (import.meta.main) {
  const code = await main();
  process.exitCode = code;
}
