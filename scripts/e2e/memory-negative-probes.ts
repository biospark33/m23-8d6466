#!/usr/bin/env bun
/**
 * M2.3 negative-probe battery (unlazy scope m2-3, leaf 1.1.2) — the five
 * refusal probes fired at the DEPLOYED memory gateway, each refusal reported
 * with its named reason. Dual plane:
 *
 *   1. Mint/revoke plane — M2.1's host surface, in-process library calls
 *      (src/memgate): `memgateDeps` (F-009: env is injected — the CLI reads
 *      process.env ONCE and passes it down; the library never resolves
 *      against process.env here) + `mintRunMemoryKey` / `revokeRunMemoryKey`
 *      against the SHARED gateway ledger (QDS_MEMGATE_LEDGER is REQUIRED —
 *      the shared ledger is pre-spend; the default placement is refused).
 *   2. Probe plane — raw `fetch` at the gateway origin (QDS_KG_GATEWAY_URL),
 *      NO SDK: POST /v1/default/banks/<bank>/memories/recall with
 *      {query, limit:3}. Refusals are classified by the consumer-side wire
 *      contract (pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/
 *      client.ts): a non-2xx JSON body whose error.code is INSIDE the closed
 *      MEMGATE_REFUSAL_REASONS set names the refusal; anything else
 *      (non-JSON, missing code, out-of-set code) is transport-class —
 *      `reason: null`, never a refusal.
 *
 * The five probes (INV-MEM-1 bank names: synthetic, qds- prefixed):
 *   no-auth         no Authorization header at all → `no-auth` AND non-200.
 *                   This is INV-M3-2 (the 0.8.6 danger: a store answering 200
 *                   with no auth) — a 200 here is a ROUND-FAILING defect.
 *   cross-run       keyA (run-a, [bankA]) fired against bankB → `scope-bank`.
 *   bank-allowlist  keyA against a third bank outside its allowlist →
 *                   `scope-bank`.
 *   ttl             short-TTL key (5s) fired only after
 *                   now >= expiresAtMs + skew (poll; wall-clock cap 30s) →
 *                   `expired`. The 5s skew (F-006) is gateway-clock-lag
 *                   tolerance: the probe's expiresAtMs is judged by the
 *                   DEPLOYED gateway's clock, so ttlExpiresAtMs/ttlFiredAtMs
 *                   ride the evidence to separate clock skew from a real
 *                   expiry-ladder defect.
 *   revoked         minted then revoked via the lib, dead key fired →
 *                   `revoked`.
 *
 * The battery makes NO Hindsight writes — the probe banks never need to
 * exist; the gateway's bank check is allowlist-vs-claims only.
 *
 * The leg MEASURES, it does not gate: `allRefused:false` still exits 0 (the
 * evidence VERDICT carries the bad news; auth-retired-check precedent).
 * Exit: 0 leg recorded (whatever it measured) / 1 evidence-write or cleanup
 *       fatal / 2 config refusal (missing env, forbidden origin, typed
 *       mint/verify construction refusal).
 * Run: bun scripts/e2e/memory-negative-probes.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { LogEntry } from "../../src/lib/log.ts";
import {
  MEMGATE_ADMIN_KEY,
  MEMGATE_REFUSAL_REASONS,
  QDS_KG_GATEWAY_URL,
  QDS_MEMGATE_LEDGER,
  QDS_MEMGATE_SIGNING_KEY,
  MemgateError,
  memgateDeps,
  mintRunMemoryKey,
  revokeRunMemoryKey,
  type MemgateDeps,
  type MintedRunKey,
} from "../../src/memgate/index.ts";
import { forbiddenOrigin, legLog, maskTail, rand6, sanitizeOrigin } from "../p0-9/leg-lib.ts";

/** Script slug (evidence filename component + leg log leg id). */
const LEG = "m2-3-memory-negative-probes";

/** Per-probe budget (AbortController) — a stalled gateway must not hang the leg. */
const PROBE_TIMEOUT_MS = 10_000;

/** TTL for every key EXCEPT the ttl probe's own short-lived key: a backstop
 * only (cleanup revokes everything); long enough that a slow live round can
 * never expire a cross-run/allowlist/revoked probe mid-flight. */
const PROBE_TTL_MS = 3_600_000;

/** The ttl probe's mint TTL (contract-fixed) and the post-expiry skew the
 * probe waits for before firing. */
const TTL_PROBE_TTL_MS = 5_000;
const TTL_PROBE_SKEW_MS = 5_000;

/** Capturing log-sink cap (memgate-* events recorded for evidence). */
const LOG_CAP = 200;

/** The one recall body every probe sends. */
const PROBE_QUERY = "m2.3 negative probe (read-only, synthetic)";

/** The five probe names, in firing order — leaf 1.1.3 consumes this EXACTLY. */
export const PROBE_NAMES = ["no-auth", "cross-run", "bank-allowlist", "ttl", "revoked"] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

/** Env keys the CLI gates on, by name (F-017: empty string is unset). */
export const REQUIRED_ENV_KEYS = [
  QDS_KG_GATEWAY_URL,
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_SIGNING_KEY,
  QDS_MEMGATE_LEDGER,
] as const;

/** The named refusal each probe MUST produce for `allRefused` to hold. */
const EXPECTED_REASONS: Record<ProbeName, string> = {
  "no-auth": "no-auth",
  "cross-run": "scope-bank",
  "bank-allowlist": "scope-bank",
  ttl: "expired",
  revoked: "revoked",
};

const REFUSAL_SET = new Set<string>(MEMGATE_REFUSAL_REASONS);

export interface ProbeOutcome {
  probe: ProbeName;
  refused: boolean;
  /** In-set error.code from a non-2xx body; null = transport-class (or 2xx). */
  reason: string | null;
  httpStatus: number | null;
  latencyMs: number;
  /** Gateway-clock skew evidence (F-006), ttl probe ONLY: the minted key's
   * expiresAtMs and the test-host wall clock at fire time — a lagging
   * gateway clock shows up here as ttlFiredAtMs - ttlExpiresAtMs still
   * inside the skew window. */
  ttlExpiresAtMs?: number;
  ttlFiredAtMs?: number;
}

export interface ProbeBatteryInput {
  /** Gateway origin, e.g. https://gw.example (no trailing slash needed). */
  origin: string;
  /** Pre-read env (F-009 injection seam) — MEMGATE_ADMIN_KEY,
   * QDS_MEMGATE_SIGNING_KEY, QDS_MEMGATE_LEDGER are required. */
  env: Record<string, string | undefined>;
  /** Ties the leg together (rides every mint/revoke/verify event line). */
  requestId: string;
  /** Injectable clock (default Date.now) — drives mint expiry + the ttl wait. */
  now?: () => number;
  /** Injectable transport (default global fetch). */
  fetchImpl?: typeof fetch;
  /** ttl probe timing knobs (contract defaults: 5000 / 30000 / 250). */
  ttlWait?: { skewMs?: number; capMs?: number; pollMs?: number };
}

export interface CleanupRecord {
  tokenId: string;
  result: "revoked" | "already-gone" | "none" | "failed";
}

export interface ProbeBatteryResult {
  outcomes: ProbeOutcome[];
  allRefused: boolean;
  mintedTokenIds: string[];
  /** Additive (not in the leaf contract): per-key cleanup results for the CLI's
   * exit code + evidence revokedInCleanup. Optional so contract-shaped
   * literals still type-check. */
  cleanup?: CleanupRecord[];
  /** Additive: capped capture of the gateway's memgate-* event lines. */
  gatewayEvents?: LogEntry[];
}

/** Typed config refusal — the CLI maps this (and MemgateError) to exit 2. */
export class ProbeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeConfigError";
  }
}

interface RawProbe {
  refused: boolean;
  reason: string | null;
  status: number | null;
  latencyMs: number;
}

/**
 * One raw HTTP probe. Latency is wall-clock (Date.now) even under an injected
 * clock — the injected `now` drives mint expiry, not measurement.
 */
async function fireProbe(
  f: typeof fetch,
  url: string,
  keyMaterial: string | undefined,
): Promise<RawProbe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let status: number | null = null;
  let text = "";
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(keyMaterial !== undefined ? { authorization: `Bearer ${keyMaterial}` } : {}),
      },
      body: JSON.stringify({ query: PROBE_QUERY, limit: 3 }),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    return { refused: false, reason: null, status: null, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (status >= 200 && status < 300) {
    // INV-M3-2: a 200 is an ANSWER, never a refusal — the probe plane records
    // refused:false and the round verdict carries the defect.
    return { refused: false, reason: null, status, latencyMs };
  }
  // Consumer-side wire contract (kg-recall client.ts): non-2xx JSON whose
  // error.code is in the closed set names the refusal; anything else is
  // transport-class.
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    if (typeof parsed?.error?.code === "string") code = parsed.error.code;
  } catch {
    // non-JSON body — transport-class below
  }
  if (code !== undefined && REFUSAL_SET.has(code)) {
    return { refused: true, reason: code, status, latencyMs };
  }
  return { refused: false, reason: null, status, latencyMs };
}

/** Best-effort revoke of every minted key; faults are recorded, never thrown. */
function revokeAll(deps: MemgateDeps, tokenIds: string[], requestId: string): CleanupRecord[] {
  const out: CleanupRecord[] = [];
  for (const tokenId of new Set(tokenIds)) {
    let result: CleanupRecord["result"];
    try {
      result = revokeRunMemoryKey(deps, { tokenId, requestId });
    } catch {
      result = "failed";
    }
    out.push({ tokenId, result });
  }
  return out;
}

/**
 * The battery body. Config errors (missing env, empty origin) throw a typed
 * ProbeConfigError / MemgateError — the CLI maps them to exit 2. Probe-level
 * failures NEVER throw: they are recorded, and `allRefused` carries the
 * verdict. Every minted key is revoked best-effort in a `finally`, and the
 * ledger this battery opened is closed.
 */
export async function runNegativeProbeBattery(input: ProbeBatteryInput): Promise<ProbeBatteryResult> {
  const origin = input.origin.trim().replace(/\/+$/, "");
  if (origin === "") throw new ProbeConfigError("origin is empty — refusing to probe");
  for (const key of [MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, QDS_MEMGATE_LEDGER]) {
    const v = input.env[key];
    if (v === undefined || v.trim() === "") {
      throw new ProbeConfigError(
        `${key} is unset/empty — refusing: the battery shares the gateway's ledger, it never opens the default placement`,
      );
    }
  }
  const now = input.now ?? ((): number => Date.now());
  const f = input.fetchImpl ?? fetch;
  const events: LogEntry[] = [];
  // F-009: env arrives injected; the capturing sink records memgate-* events
  // (bounded) for the evidence tail — the default global sink is bypassed.
  const deps = memgateDeps({
    env: input.env,
    now,
    log: (entry) => {
      if (events.length < LOG_CAP) events.push(entry);
    },
  });
  const rand = rand6();
  const bankA = `qds-probe-m23-${rand}-a`; // INV-MEM-1: synthetic, qds- prefixed
  const bankB = `qds-probe-m23-${rand}-b`;
  const bankZ = `qds-probe-m23-${rand}-z`;
  const recallUrl = (bank: string) =>
    `${origin}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`;
  const requestId = input.requestId;
  const minted: MintedRunKey[] = [];
  const mint = (runId: string, banks: string[], ttlMs: number = PROBE_TTL_MS): MintedRunKey => {
    const m = mintRunMemoryKey(deps, { runId, banks, ttlMs, requestId });
    minted.push(m);
    return m;
  };
  const outcomes: ProbeOutcome[] = [];
  let cleanup: CleanupRecord[] = [];
  try {
    // (1) no-auth — the 0.8.6 danger (INV-M3-2), measured, never assumed.
    {
      const r = await fireProbe(f, recallUrl(bankA), undefined);
      outcomes.push({ probe: "no-auth", refused: r.refused, reason: r.reason, httpStatus: r.status, latencyMs: r.latencyMs });
    }
    // (2) cross-run — keyA (run-a) against run-b's bank (keyB minted so the
    // scenario is a true two-run overlap, though the refusal itself is
    // allowlist-vs-claims and needs only keyA).
    const keyA = mint("m23-probe-run-a", [bankA]);
    mint("m23-probe-run-b", [bankB]);
    {
      const r = await fireProbe(f, recallUrl(bankB), keyA.keyMaterial);
      outcomes.push({ probe: "cross-run", refused: r.refused, reason: r.reason, httpStatus: r.status, latencyMs: r.latencyMs });
    }
    // (3) bank-allowlist — keyA against a third bank outside its allowlist.
    {
      const r = await fireProbe(f, recallUrl(bankZ), keyA.keyMaterial);
      outcomes.push({ probe: "bank-allowlist", refused: r.refused, reason: r.reason, httpStatus: r.status, latencyMs: r.latencyMs });
    }
    // (4) ttl — fire only past expiry + skew; the cap is WALL-clock (the
    // injected clock may be frozen). On cap expiry the probe fires anyway and
    // the outcome records what the gateway actually said — no invented failure.
    const ttlKey = mint("m23-probe-run-ttl", [bankA], TTL_PROBE_TTL_MS);
    const { skewMs = TTL_PROBE_SKEW_MS, capMs = 30_000, pollMs = 250 } = input.ttlWait ?? {};
    const deadline = ttlKey.expiresAtMs + skewMs;
    const waitStarted = Date.now();
    while (now() < deadline) {
      if (Date.now() - waitStarted > capMs) break;
      await Bun.sleep(pollMs);
    }
    {
      const ttlFiredAtMs = Date.now();
      const r = await fireProbe(f, recallUrl(bankA), ttlKey.keyMaterial);
      outcomes.push({
        probe: "ttl",
        refused: r.refused,
        reason: r.reason,
        httpStatus: r.status,
        latencyMs: r.latencyMs,
        ttlExpiresAtMs: ttlKey.expiresAtMs,
        ttlFiredAtMs,
      });
    }
    // (5) revoked — revoke via the lib FIRST; if the revoke itself faults the
    // probe fires a live key, the 200 records refused:false, and the verdict
    // carries it (the memgate-* event lines are in the captured tail).
    const revKey = mint("m23-probe-run-revoked", [bankA]);
    try {
      revokeRunMemoryKey(deps, { tokenId: revKey.tokenId, requestId });
    } catch {
      // recorded via the probe outcome below — never thrown out of the battery
    }
    {
      const r = await fireProbe(f, recallUrl(bankA), revKey.keyMaterial);
      outcomes.push({ probe: "revoked", refused: r.refused, reason: r.reason, httpStatus: r.status, latencyMs: r.latencyMs });
    }
  } finally {
    cleanup = revokeAll(deps, minted.map((m) => m.tokenId), requestId);
    try {
      deps.ledger.close();
    } catch {
      // best-effort — a faulting close must not mask the outcomes
    }
  }
  const allRefused =
    outcomes.length === PROBE_NAMES.length &&
    outcomes.every((o) => o.refused && o.reason === EXPECTED_REASONS[o.probe]);
  return {
    outcomes,
    allRefused,
    mintedTokenIds: minted.map((m) => m.tokenId),
    cleanup,
    gatewayEvents: events,
  };
}

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

/** `2026-10-07T15-52-32-492Z` — the repo's evidence filename stamp. */
function isoDashTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  // Env read ONCE at entry (F-009): everything downstream takes this object.
  const env: Record<string, string | undefined> = { ...process.env };
  const missing = REQUIRED_ENV_KEYS.filter((k) => env[k] === undefined || env[k].trim() === "");
  if (missing.length > 0) {
    process.stderr.write(
      `${LEG} refusing: missing required env — ${missing.join(", ")} (never spend, never write evidence)\n`,
    );
    process.exitCode = 2;
    return;
  }
  let origin = (env[QDS_KG_GATEWAY_URL] ?? "").trim(); // dp:ok blank is refused by REQUIRED_ENV_KEYS gate above; the trim loop only strips trailing slashes
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  // Wrong-instance trap (house rule, requireBaseUrl idiom): :8888/:18889 are
  // the shared-sidecar/tenant stack — never a legitimate gateway to probe.
  const trap = forbiddenOrigin(origin);
  if (trap !== null) {
    process.stderr.write(`${LEG} refusing: ${trap}\n`);
    process.exitCode = 2;
    return;
  }
  const requestId = `m23-negprobes-${rand6()}`;
  legLog({ leg: LEG, outcome: "start" });
  let result: ProbeBatteryResult;
  try {
    result = await runNegativeProbeBattery({ origin, env, requestId });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LEG} refusing: ${detail}\n`);
    process.exitCode = 2;
    return;
  }
  legLog({ leg: LEG, outcome: result.allRefused ? "all-refused" : "not-all-refused" });
  const payload = {
    writtenAt: new Date().toISOString(),
    origin: sanitizeOrigin(origin),
    requestId,
    outcomes: result.outcomes,
    allRefused: result.allRefused,
    mintedTokenIds: result.mintedTokenIds,
    revokedInCleanup: result.cleanup ?? [],
    gatewayEventsTail: maskTail(
      (result.gatewayEvents ?? []).slice(-20).map((entry) => JSON.stringify(entry)).join("\n"),
      { maxLen: 4000 },
    ),
  };
  // Scrub gate: a mgrun- literal in the payload means key material leaked into
  // evidence — self-fail WITHOUT echoing the payload (the payload IS the leak).
  if (JSON.stringify(payload).includes("mgrun-")) {
    process.stderr.write(`${LEG} fatal: evidence scrub failed (mgrun- literal in payload) — evidence NOT written, payload suppressed\n`);
    process.exitCode = 1;
    return;
  }
  const dir = path.join(import.meta.dir, "..", "..", "_bmad-output", "evidence", "memory-live");
  const file = path.join(dir, `${isoDashTimestamp()}-memory-negative-probes-${rand6()}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stderr.write(`${file}\n`);
  } catch {
    // F-030: the leg already mutated the ledger (mints + revocations) — its
    // outcomes must not be lost to a failing write; dump the scrubbed payload.
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = (result.cleanup ?? []).some((c) => c.result === "failed") ? 1 : 0;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${LEG} fatal: ${err instanceof MemgateError ? `${err.code}: ${err.message}` : err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
  });
}
