/**
 * M2.1 memory gateway — gateway-surface TDD suite (written RED).
 *
 * The six contract describes (PLAN "tests/memgate/gateway.test.ts"):
 * scope-enforcement, admin-auth, agent-tokens, mock-roundtrip, redaction,
 * ledger. The modules under test (src/memgate/{index,gateway,ledger,schemas}.ts)
 * do not exist yet — the static imports below fail at load, which IS the red
 * phase (probe-harness.test.ts:13-14 convention).
 *
 * Mock boundary: the mock-roundtrip forward runs through a REAL HindsightClient
 * in mock mode (`new HindsightClient({ mode: "mock" })` — R2 §2) so the canned
 * bodies pass the same strict zod parse a live response would (client.ts:52-59).
 * No network anywhere; no mock library — plain-object structural fakes (R2 §7).
 *
 * Contract pins this suite fixes for leaf-1 (beyond PLAN's named exports):
 * - `memgateDeps(opts)` resolves admin/signing keys env-by-name and THROWS
 *   admin-key-missing / signing-key-missing BEFORE opening any ledger.
 * - `deps.adminKey` is the PRESENTED admin credential for the call context;
 *   the configured key is read from `deps.env` by name at op time and compared
 *   timing-safe (PLAN's admin-op input shapes carry no presentation channel).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { HindsightClient } from "../../src/hindsight/client.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import { bankOfPath, MAX_RETAIN_CONTENT_CHARS, sha256Hex } from "../../src/memgate/schemas.ts";
import {
  AGENT_GRANT_CLASSES,
  AGENT_TOKEN_VERBS,
  MEMGATE_ADMIN_KEY,
  MEMGATE_REFUSAL_REASONS,
  QDS_KG_GATEWAY_URL,
  QDS_KG_RECALL_KEY,
  QDS_MEMGATE_LEDGER,
  QDS_MEMGATE_SIGNING_KEY,
  MemgateError,
  MemgateLedger,
  deliverRunKey,
  forwardScoped,
  grantAgentToken,
  listAgentTokens,
  matchRoute,
  memgateDeps,
  mintRunMemoryKey,
  openReadOnly,
  parseAgentTokenScope,
  parseRunKeyScope,
  resolveMemgateLedgerPath,
  revokeAgentToken,
  revokeRunMemoryKey,
  verifyRequest,
  type AgentTokenScope,
  type MemgateDeps,
  type RunKeyScope,
} from "../../src/memgate/index.ts";

// ---------------------------------------------------------------------------
// Fixtures — tmpdir layout, env discipline (C-5), deps factory, helpers
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-10-07T10:00:00.000Z");
const ADMIN = "memgate-admin-test-key-0000000000000001";
const SIGNING = "memgate-signing-test-key-0000000000000001";
const BANK = "alpha";
const GATEWAY_URL = "http://127.0.0.1:18890";
const RECALL_PATH = `/v1/default/banks/${BANK}/memories/recall`;
const DEFAULT_LEDGER = ".sandbox/memgate-ledger.db";

/** 32 marked bytes → a 43-char base64url sentinel body for the minted key. */
const SENTINEL_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
const SENTINEL_KEY_MATERIAL = `mgrun-${Buffer.from(SENTINEL_BYTES).toString("base64url")}`;
// (Driver fix, PLAN rev 3 — re-prefixed "mgx-": the old "memgate-" prefix's
// first 8-char window collided with the mandated "memgate-*" event values
// present in every log line, making the leak-scan unsatisfiable.)
const SENTINEL_ADMIN = "mgx-admin-sentinel-0000000000000001";
const SENTINEL_SIGNING = "mgx-signing-sentinel-0000000000000001";

const ENV_KEYS = [
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_SIGNING_KEY,
  QDS_MEMGATE_LEDGER,
  QDS_KG_RECALL_KEY,
  QDS_KG_GATEWAY_URL,
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let logs: LogEntry[] = [];
let restoreLog: (() => void) | undefined;
// R2-F-018: every deps() opens a fresh writable ledger — tracked here so
// afterEach closes them (a leaked sqlite handle pins the tmpdir file open).
let openLedgers: MemgateLedger[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m21-gw-"));
  // C-5: a stray default-path open resolves into the fixture sandbox.
  process.env[QDS_MEMGATE_LEDGER] = join(dir, "default-placement-ledger.db");
  logs = [];
  openLedgers = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  restoreLog?.();
  for (const l of openLedgers) {
    try {
      l.close();
    } catch {
      // a faulting close must not mask the test's own failure
    }
  }
  openLedgers = [];
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const ledgerPath = () => join(dir, "memgate-ledger.db");
const envTarget = () => join(dir, "boxes", "b1", "app", ".env");

/** Track a test-constructed ledger for afterEach close. */
function tracked(l: MemgateLedger): MemgateLedger {
  openLedgers.push(l);
  return l;
}

function deps(overrides: Partial<MemgateDeps> = {}): MemgateDeps {
  const built = memgateDeps({
    env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING },
    ledgerPath: ledgerPath(),
    now: () => NOW_MS,
    client: new HindsightClient({ mode: "mock" }),
  });
  openLedgers.push(built.ledger);
  return { ...built, ...overrides };
}

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
}

/** Code of a thrown MemgateError, or a loud failure when nothing is thrown. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemgateError) return e.code;
    throw e;
  }
  throw new Error("expected MemgateError, none thrown");
}

/** codeOf for async surfaces (forwardScoped). */
async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof MemgateError) return e.code;
    throw e;
  }
  throw new Error("expected MemgateError, none thrown");
}

/** Any >=8-char substring of the secret found in any corpus, else null. */
function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + 8 <= secret.length; i++) {
    const frag = secret.slice(i, i + 8);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
    }
  }
  return null;
}

function parseEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return entries;
}

function minted(d: MemgateDeps = deps(), runId = "run-1"): ReturnType<typeof mintRunMemoryKey> {
  return mintRunMemoryKey(d, { runId, banks: [BANK], ttlMs: 60_000, requestId: "req-mint" });
}

// ---------------------------------------------------------------------------
// scope-enforcement (AC2)
// ---------------------------------------------------------------------------

describe("scope-enforcement", () => {
  test("recall on a non-allowlisted bank is refused scope-bank — ttlRemainingMs absent, never 0", () => {
    const mint = minted();
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: "/v1/default/banks/beta/memories/recall",
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("scope-bank");
      expect("ttlRemainingMs" in v).toBe(false);
    }
  });

  test("write verbs under a per-run key are refused scope-verb (reflect + memories routes)", () => {
    const mint = minted();
    for (const [method, path] of [
      ["POST", `/v1/default/banks/${BANK}/reflect`],
      ["POST", `/v1/default/banks/${BANK}/memories`],
    ] as const) {
      const v = verifyRequest(deps(), {
        authHeader: `Bearer ${mint.keyMaterial}`,
        method,
        path,
        requestId: "req-v",
      });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("scope-verb");
    }
  });

  test("retain is structurally impossible under a per-run key — literal [\"recall\"] type, parse refusal, runtime scope-verb", () => {
    const live: RunKeyScope = { runId: "r", banks: [BANK], expiresAtMs: NOW_MS + 1_000, verbs: ["recall"] };
    // @ts-expect-error retain is not a per-run verb — the literal tuple admits no second member
    const writeCarrying: RunKeyScope = { runId: "r", banks: [BANK], expiresAtMs: 1, verbs: ["recall", "retain"] };
    expect(live.verbs).toEqual(["recall"]);
    expect<string[]>(writeCarrying.verbs).toEqual(["recall", "retain"]); // types erase at runtime; the parse below is the net (driver fix, PLAN rev 3 — toEqual param types against received)
    expect(
      parseRunKeyScope({ runId: "r", banks: [BANK], expiresAtMs: NOW_MS + 1, verbs: ["recall", "retain"] }).success,
    ).toBe(false);
    expect(parseRunKeyScope({ runId: "r", banks: [BANK], expiresAtMs: NOW_MS + 1, verbs: ["recall"] }).success).toBe(true);
    const mint = minted();
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/files/retain`,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("scope-verb");
  });

  test("expired refusal carries ttlRemainingMs; the ok result and every other refusal never do", () => {
    const mint = minted(); // expiresAtMs = NOW_MS + 60_000
    const late = verifyRequest(deps({ now: () => NOW_MS + 65_000 }), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe("expired");
      expect(late.ttlRemainingMs).toBe(-5_000);
    }
    const live = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(live.ok).toBe(true);
    expect("ttlRemainingMs" in live).toBe(false);
  });

  test("revoked key is refused revoked (ttl absent); second revoke answers already-gone", () => {
    const mint = minted();
    expect(revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" })).toBe("revoked");
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("revoked");
      expect("ttlRemainingMs" in v).toBe(false);
    }
    expect(revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" })).toBe("already-gone");
  });

  test("revoking a never-issued tokenId answers none and emits NO event", () => {
    const before = logs.length;
    expect(revokeRunMemoryKey(deps(), { tokenId: "mg-never-issued", requestId: "req-r" })).toBe("none");
    const related = logs.slice(before).filter((l) => JSON.stringify(l).includes("mg-never-issued"));
    expect(related).toEqual([]);
  });

  test("absent auth header is refused no-auth — the exact DD-28.26(13) shape", () => {
    const v = verifyRequest(deps(), { authHeader: undefined, method: "POST", path: RECALL_PATH, requestId: "req-v" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("no-auth");
      expect("ttlRemainingMs" in v).toBe(false);
    }
  });

  test("present-but-unknown credential is refused no-auth with authOutcome unknown-key (D3)", () => {
    const linesBefore = logs.length;
    const v = verifyRequest(deps(), {
      authHeader: "Bearer mgrun-totally-unknown-material",
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("no-auth");
    const refused = logs.slice(linesBefore).filter((l) => JSON.stringify(l).includes("memgate-refused"));
    expect(refused.length).toBeGreaterThan(0);
    expect(JSON.stringify(refused)).toContain('"authOutcome":"unknown-key"');
  });

  test("F-010: a non-string method or path refuses scope-verb — no TypeError escapes the closed ladder", () => {
    const attempt = (method: unknown, path: unknown): void => {
      const v = verifyRequest(deps(), {
        authHeader: "Bearer mgrun-irrelevant-material",
        method,
        path,
        requestId: "req-v",
      } as unknown as Parameters<typeof verifyRequest>[1]);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("scope-verb");
    };
    attempt(undefined, RECALL_PATH);
    attempt(7, RECALL_PATH);
    attempt("POST", 42);
  });

  test("F-013: a hand-corrupted per-run claims row (verbs [recall, retain]) fails closed at verify — no-auth + unknown-key, never authorized", () => {
    const material = "mgrun-crafted-two-verb-material";
    const tokenId = sha256Hex(material);
    deps().ledger.recordIssuance({
      tokenId,
      kind: "per-run",
      digest: tokenId,
      claimsJson: JSON.stringify({ runId: "run-crafted", banks: [BANK], expiresAtMs: NOW_MS + 60_000, verbs: ["recall", "retain"] }),
      runId: "run-crafted",
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 60_000,
    });
    const linesBefore = logs.length;
    const v = verifyRequest(deps(), { authHeader: `Bearer ${material}`, method: "POST", path: RECALL_PATH, requestId: "req-v" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("no-auth"); // D3: invalid claims stay INSIDE no-auth
      expect("ttlRemainingMs" in v).toBe(false);
    }
    const refusedJson = JSON.stringify(logs.slice(linesBefore));
    expect(refusedJson).toContain('"authOutcome":"unknown-key"');
    expect(refusedJson).toContain(tokenId);
  });

  test("F-016: expiry at the EXACT boundary (now === expiresAtMs) refuses expired with ttlRemainingMs ABSENT, never 0", () => {
    const mint = minted(); // expiresAtMs = NOW_MS + 60_000
    const v = verifyRequest(deps({ now: () => NOW_MS + 60_000 }), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("expired");
      expect("ttlRemainingMs" in v).toBe(false);
    }
  });

  test("F-014 sweep: every captured memgate-refused reason stays in the closed 8-member set across a mixed refusal scenario", () => {
    try {
      mintRunMemoryKey(deps(), { runId: "run-sweep", banks: [BANK], ttlMs: -1, requestId: "req-s" });
    } catch {
      // mint-side TTL refusal under test
    }
    try {
      deliverRunKey(deps(), {
        target: envTarget(),
        keyMaterial: SENTINEL_KEY_MATERIAL,
        gatewayUrl: "http://bad host",
        requestId: "req-s",
      });
    } catch {
      // deliver-side grammar refusal (plain code line) under test
    }
    try {
      grantAgentToken(deps(), { consumerClass: "host", banks: [BANK], verbs: ["recall"], requestId: "req-s" });
    } catch {
      // grant-side class refusal (plain code line) under test
    }
    const mint = minted();
    verifyRequest(deps(), { authHeader: undefined, method: "POST", path: RECALL_PATH, requestId: "req-s" });
    verifyRequest(deps(), { authHeader: "Bearer mgrun-unknown-material", method: "POST", path: RECALL_PATH, requestId: "req-s" });
    verifyRequest(deps(), { authHeader: `Bearer ${mint.keyMaterial}`, method: "POST", path: "/v1/default/banks/beta/memories/recall", requestId: "req-s" });
    verifyRequest(deps(), { authHeader: `Bearer ${mint.keyMaterial}`, method: "POST", path: `/v1/default/banks/${BANK}/reflect`, requestId: "req-s" });
    verifyRequest(deps({ now: () => NOW_MS + 61_000 }), { authHeader: `Bearer ${mint.keyMaterial}`, method: "POST", path: RECALL_PATH, requestId: "req-s" });
    revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-s" });
    verifyRequest(deps(), { authHeader: `Bearer ${mint.keyMaterial}`, method: "POST", path: RECALL_PATH, requestId: "req-s" });

    const refusedLines = logs.filter((l) => (typeof l.event === "string" ? l.event : "") === "memgate-refused");
    expect(refusedLines.length).toBeGreaterThanOrEqual(6);
    const reasons = new Set(refusedLines.map((l) => (typeof l.reason === "string" ? l.reason : "")));
    const allowed: string[] = [...MEMGATE_REFUSAL_REASONS];
    for (const reason of reasons) {
      expect(allowed).toContain(reason);
    }
    // the scenario really produced the breadth it claims
    expect(reasons.has("mint-invalid-ttl")).toBe(true);
    expect(reasons.has("expired")).toBe(true);
    expect(reasons.has("revoked")).toBe(true);
    expect(reasons.has("no-auth")).toBe(true);
  });

  test("F-004: a revocation BETWEEN verify and forwardScoped makes the forward refuse revoked — verify-then-forward re-checks", async () => {
    const d = deps();
    const mint = minted(d);
    const ok = verifyRequest(d, {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    if (!ok.ok) throw new Error("fixture: verify should pass");
    expect(revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" })).toBe("revoked");
    expect(
      await asyncCodeOf(() => forwardScoped(d, ok.principal, "POST", RECALL_PATH, { query: "q", limit: 5 }, "req-f")),
    ).toBe("revoked");
    // the refused forward never reached the client — no memgate-forward line
    expect(logs.some((l) => (typeof l.event === "string" ? l.event : "") === "memgate-forward")).toBe(false);
  });

  test("R2-F-007: a NaN clock fails verify AND forward closed — reason expired, ttlRemainingMs absent, no NaN/null riding any line", async () => {
    const mint = minted();
    const ok = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-finite",
    });
    if (!ok.ok) throw new Error("fixture: verify should pass under a finite clock");
    const v = verifyRequest(deps({ now: () => Number.NaN }), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-nan",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("expired");
      expect("ttlRemainingMs" in v).toBe(false);
    }
    expect(
      await asyncCodeOf(() =>
        forwardScoped(deps({ now: () => Number.NaN }), ok.principal, "POST", RECALL_PATH, { query: "q" }, "req-nan-f"),
      ),
    ).toBe("expired");
    const refused = logs.filter((l) => (typeof l.event === "string" ? l.event : "") === "memgate-refused");
    expect(refused.length).toBeGreaterThan(0);
    for (const line of refused) expect("ttlRemainingMs" in line).toBe(false);
    const json = JSON.stringify(logs);
    expect(json).not.toContain("NaN");
    expect(json).not.toContain("ttlRemainingMs"); // absent everywhere — never null, never -Infinity
  });

  test("R2-F-013: a claims_json = 'null' row fails verify INSIDE no-auth/unknown-key WITH tokenId — never ledger-unreadable", () => {
    const material = "mgrun-null-claims-material";
    const tokenId = sha256Hex(material);
    deps().ledger.recordIssuance({
      tokenId,
      kind: "per-run",
      digest: tokenId,
      claimsJson: "null",
      runId: "run-null-claims",
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 60_000,
    });
    const linesBefore = logs.length;
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${material}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("no-auth"); // a DATA fault folds into D3, not a storage refusal
      expect("ttlRemainingMs" in v).toBe(false);
    }
    const refusedJson = JSON.stringify(logs.slice(linesBefore));
    expect(refusedJson).toContain('"authOutcome":"unknown-key"');
    expect(refusedJson).toContain(tokenId);
    expect(refusedJson).not.toContain('"reason":"ledger-unreadable"');
  });

  test("R2-F-015: revokeRunMemoryKey's emit lines carry the ISSUED ROW's runId — the caller passes only the tokenId", () => {
    const d = deps();
    const mint = minted(d, "run-r15");
    const before = logs.length;
    expect(revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" })).toBe("revoked");
    const revokeLines = logs
      .slice(before)
      .filter((l) => ["memgate-revoke", "memgate-verify-revoked"].includes(typeof l.event === "string" ? l.event : ""));
    expect(revokeLines.length).toBe(2);
    for (const line of revokeLines) {
      expect(typeof line.runId === "string" ? line.runId : "").toBe("run-r15");
    }
  });

  test("bankOfPath and matchRoute agree on the path grammar (R3-F-011 — the bank-check safety argument)", () => {
    // Mapped routes: the bank each parser extracts must be the SAME bank.
    const mapped = [
      "/v1/default/banks/bank-a/memories/recall",
      "/v1/default/banks/qds-factory-dev-meta/reflect",
      "/v1/default/banks/x/memories",
      "/v1/default/banks/y/files/retain",
      "/v1/default/banks/-weird_Bank.7/consolidate",
    ];
    for (const path of mapped) {
      const route = matchRoute("POST", path);
      if (route === null) throw new Error(`fixture: expected ${path} to map`);
      expect(bankOfPath(path)).toBe(route.bankId);
    }
    // Unmapped bank-scoped routes: bankOfPath still extracts the bank (the
    // scope-bank check runs on it) while matchRoute refuses — the two parsers
    // must never disagree about WHERE the bank segment ends.
    const unmapped = [
      "/v1/default/banks/bank-a/mental-models",
      "/v1/default/banks/bank-a/config",
      "/v1/default/banks/bank-a/transfer/export",
      "/v1/default/banks/bank-a/memories/recall/extra/deep",
    ];
    for (const path of unmapped) {
      expect(matchRoute("POST", path)).toBeNull();
      expect(bankOfPath(path)).toBe("bank-a");
    }
    // Degenerate shapes: both parsers refuse together — the bank check can
    // never be skipped while the route matches, or vice versa.
    const degenerate = [
      "/v1/default/banks/",
      "/v1/default/banks//memories/recall",
      "/v1/default/banks",
      "/v1/default/bank/bank-a/memories/recall",
      "",
      "/",
    ];
    for (const path of degenerate) {
      const route = matchRoute("POST", path);
      const bank = bankOfPath(path);
      // Whichever refuses, BOTH leave the request un-authorizable: no bank
      // extracted means the scope-bank check fails; no route means scope-verb.
      if (bank === undefined) expect(route).toBeNull();
    }
    // Non-POST never maps, whatever the bank.
    expect(matchRoute("GET", "/v1/default/banks/bank-a/memories/recall")).toBeNull();
    expect(bankOfPath("/v1/default/banks/bank-a/memories/recall")).toBe("bank-a");
  });
});

// ---------------------------------------------------------------------------
// admin-auth (AC7)
// ---------------------------------------------------------------------------

describe("admin-auth", () => {
  test("missing MEMGATE_ADMIN_KEY refuses admin-key-missing BEFORE any state change — no ledger file", () => {
    expect(() =>
      memgateDeps({ env: { [QDS_MEMGATE_SIGNING_KEY]: SIGNING }, ledgerPath: ledgerPath() }),
    ).toThrow(MemgateError);
    expect(codeOf(() =>
      memgateDeps({ env: { [QDS_MEMGATE_SIGNING_KEY]: SIGNING }, ledgerPath: ledgerPath() }),
    )).toBe("admin-key-missing");
    expect(existsSync(ledgerPath())).toBe(false);
  });

  test("empty-string MEMGATE_ADMIN_KEY is unset — the same pre-state refusal, still no ledger file", () => {
    const build = () =>
      memgateDeps({
        env: { [MEMGATE_ADMIN_KEY]: "", [QDS_MEMGATE_SIGNING_KEY]: SIGNING },
        ledgerPath: ledgerPath(),
      });
    expect(codeOf(build)).toBe("admin-key-missing");
    expect(existsSync(ledgerPath())).toBe(false);
  });

  test("missing and empty QDS_MEMGATE_SIGNING_KEY refuse signing-key-missing", () => {
    for (const signing of [undefined, ""]) {
      expect(
        codeOf(() =>
          memgateDeps({
            env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: signing },
            ledgerPath: ledgerPath(),
          }),
        ),
      ).toBe("signing-key-missing");
    }
    expect(existsSync(ledgerPath())).toBe(false);
  });

  test("wrong presented admin key refuses admin-auth — same-length and different-length alike", () => {
    const mint = (presented: string) =>
      codeOf(() =>
        mintRunMemoryKey(deps({ adminKey: presented }), {
          runId: "run-admin",
          banks: [BANK],
          ttlMs: 60_000,
          requestId: "req-mint",
        }),
      );
    expect(mint("memgate-admin-wrong-key-0000000000001")).toBe("admin-auth"); // same length as ADMIN
    expect(mint("short")).toBe("admin-auth");
    const mint2 = minted(deps({ adminKey: ADMIN }));
    expect(mint2.tokenId).toBeDefined();
  });

  test("absent presented admin key refuses admin-auth", () => {
    expect(
      codeOf(() =>
        mintRunMemoryKey(deps({ adminKey: undefined }), {
          runId: "run-admin",
          banks: [BANK],
          ttlMs: 60_000,
          requestId: "req-mint",
        }),
      ),
    ).toBe("admin-auth");
  });

  test("F-017: empty-string keys refuse — signingKey '' cannot grant, adminKey '' with no env cannot mint, zero state change", () => {
    const rowsBefore = deps().ledger.listIssued().length;
    expect(
      codeOf(() =>
        grantAgentToken(deps({ signingKey: "" }), {
          consumerClass: "bot",
          banks: [BANK],
          verbs: ["consolidate"],
          requestId: "req-g",
        }),
      ),
    ).toBe("signing-key-missing"); // never an HMAC under ""
    expect(
      codeOf(() =>
        mintRunMemoryKey(deps({ adminKey: "", env: undefined }), {
          runId: "run-empty-admin",
          banks: [BANK],
          ttlMs: 60_000,
          requestId: "req-mint",
        }),
      ),
    ).toBe("admin-auth"); // "" vs "" must not authorize
    expect(deps().ledger.listIssued().length).toBe(rowsBefore);
  });

  test("R2-F-002: hand-built deps WITHOUT env fail admin ops CLOSED — the memgateDeps embedded seam still authorizes", () => {
    const bare = tracked(new MemgateLedger(join(dir, "hand-built.db")));
    const handBuilt: MemgateDeps = {
      ledger: bare,
      client: new HindsightClient({ mode: "mock" }),
      now: () => NOW_MS,
      signingKey: SIGNING,
      adminKey: ADMIN, // presented matches configured-in-spirit — but NO env is wired
      // embeddedAdmin is deliberately ABSENT: only memgateDeps sets it
    };
    expect(
      codeOf(() =>
        mintRunMemoryKey(handBuilt, { runId: "run-hb", banks: [BANK], ttlMs: 60_000, requestId: "req-hb" }),
      ),
    ).toBe("admin-auth");
    expect(
      codeOf(() =>
        grantAgentToken(handBuilt, {
          consumerClass: "bot",
          banks: [BANK],
          verbs: ["consolidate"],
          requestId: "req-hb",
        }),
      ),
    ).toBe("admin-auth");
    expect(bare.listIssued().length).toBe(0); // the refusals are pre-state
    // The embedded seam: memgateDeps WITHOUT explicit env reads process.env,
    // flags embeddedAdmin, and its presented admin key authorizes.
    process.env[MEMGATE_ADMIN_KEY] = ADMIN;
    process.env[QDS_MEMGATE_SIGNING_KEY] = SIGNING;
    const embedded = memgateDeps({
      ledgerPath: join(dir, "embedded.db"),
      now: () => NOW_MS,
      client: new HindsightClient({ mode: "mock" }),
    });
    openLedgers.push(embedded.ledger);
    expect(embedded.embeddedAdmin).toBe(true);
    expect(embedded.env).toBe(process.env);
    expect(
      mintRunMemoryKey(embedded, { runId: "run-embedded", banks: [BANK], ttlMs: 60_000, requestId: "req-hb" }).tokenId,
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// agent-tokens (AC5 + DD-28.26 item 1 / D-vocab)
// ---------------------------------------------------------------------------

describe("agent-tokens", () => {
  test("grant classes are exactly host {reflect, retain} / bot {consolidate}; vocabulary closed at 4", () => {
    expect([...AGENT_GRANT_CLASSES.host]).toEqual(["reflect", "retain"]);
    expect([...AGENT_GRANT_CLASSES.bot]).toEqual(["consolidate"]);
    expect([...AGENT_TOKEN_VERBS]).toEqual(["recall", "reflect", "consolidate", "retain"]);
  });

  test("host grant verifies on reflect; bot grant verifies on consolidate", () => {
    const host = grantAgentToken(deps(), {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["reflect", "retain"],
      requestId: "req-g",
    });
    const hostV = verifyRequest(deps(), {
      authHeader: `Bearer ${host.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/reflect`,
      requestId: "req-v",
    });
    expect(hostV.ok).toBe(true);
    const bot = grantAgentToken(deps(), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    const botV = verifyRequest(deps(), {
      authHeader: `Bearer ${bot.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/consolidate`,
      requestId: "req-v",
    });
    expect(botV.ok).toBe(true);
  });

  test("recall is in NO agent grant class — refused grant-verb-outside-class (D-vocab)", () => {
    for (const consumerClass of ["host", "bot"] as const) {
      expect(
        codeOf(() =>
          grantAgentToken(deps(), { consumerClass, banks: [BANK], verbs: ["recall"], requestId: "req-g" }),
        ),
      ).toBe("grant-verb-outside-class");
    }
  });

  test("refresh is outside the closed vocabulary — refused grant-verb-outside-vocabulary", () => {
    expect(
      codeOf(() =>
        grantAgentToken(deps(), { consumerClass: "bot", banks: [BANK], verbs: ["refresh"], requestId: "req-g" }),
      ),
    ).toBe("grant-verb-outside-vocabulary");
  });

  test("wildcard grants are structurally impossible — no sentinel type, min-1 banks, no 'all' anywhere", () => {
    // @ts-expect-error no wildcard sentinel exists — banks is a min-1 BankId array, never a sentinel string
    const wildcardScope: AgentTokenScope = { tokenId: "t-w", consumerClass: "bot", banks: "all-banks", verbs: ["consolidate"] };
    expect(wildcardScope.banks as unknown).toBe("all-banks"); // types erase at runtime (driver fix, PLAN rev 3 — toBe param types against received)
    expect(
      parseAgentTokenScope({ tokenId: "t-w", consumerClass: "bot", banks: [], verbs: ["consolidate"] }).success,
    ).toBe(false); // min-1
    // (Driver fix, PLAN rev 3 — "recall" contains the substring "all"; the
    // no-wildcard fact is membership, not substring.)
    expect((AGENT_TOKEN_VERBS as readonly string[]).includes("all")).toBe(false);
    expect(JSON.stringify(Object.values(AGENT_GRANT_CLASSES))).not.toContain("all");
    expect(() =>
      grantAgentToken(deps(), { consumerClass: "bot", banks: [], verbs: ["consolidate"], requestId: "req-g" }),
    ).toThrow(MemgateError); // the runtime refusal — the closed grant refusal set is NOT widened for it
  });

  test("consumerClass is required — a grant that cannot name its class does not compile (AC5 negative control)", () => {
    type GrantInput = Parameters<typeof grantAgentToken>[1];
    // @ts-expect-error consumerClass is a required field on the grant input
    const unnamed: GrantInput = { banks: [BANK], verbs: ["consolidate"], requestId: "req-g" };
    expect(unnamed.banks).toEqual([BANK]); // types erase at runtime
    expect(parseAgentTokenScope({ tokenId: "t", banks: [BANK], verbs: ["consolidate"] }).success).toBe(false);
    expect(
      codeOf(() =>
        grantAgentToken(deps(), { banks: [BANK], verbs: ["consolidate"], requestId: "req-g" } as GrantInput),
      ),
    ).toBe("grant-consumer-class-required");
  });

  test("route closure: mental-models / config / transfer-export / memory DELETE / bank DELETE refuse scope-verb; matchRoute maps only the 5", () => {
    const token = grantAgentToken(deps(), {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["reflect", "retain"],
      requestId: "req-g",
    });
    const unmapped: ReadonlyArray<readonly [string, string]> = [
      ["POST", `/v1/default/banks/${BANK}/mental-models`],
      ["POST", `/v1/default/banks/${BANK}/config`],
      ["POST", `/v1/default/banks/${BANK}/transfer/export`],
      ["DELETE", `/v1/default/banks/${BANK}/memories/m-1`],
      ["DELETE", `/v1/default/banks/${BANK}`],
    ];
    for (const [method, path] of unmapped) {
      const v = verifyRequest(deps(), {
        authHeader: `Bearer ${token.token}`,
        method,
        path,
        requestId: "req-v",
      });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("scope-verb"); // unmapped → default-refuse
      expect(matchRoute(method, path)).toBeNull();
    }
    const bank = "x";
    expect(matchRoute("POST", `/v1/default/banks/${bank}/memories/recall`)).toEqual({ verb: "recall", bankId: bank });
    expect(matchRoute("POST", `/v1/default/banks/${bank}/memories`)).toEqual({ verb: "retain", bankId: bank });
    expect(matchRoute("POST", `/v1/default/banks/${bank}/files/retain`)).toEqual({ verb: "retain", bankId: bank });
    expect(matchRoute("POST", `/v1/default/banks/${bank}/reflect`)).toEqual({ verb: "reflect", bankId: bank });
    expect(matchRoute("POST", `/v1/default/banks/${bank}/consolidate`)).toEqual({ verb: "consolidate", bankId: bank });
    expect(matchRoute("GET", "/v1/default/banks")).toBeNull(); // non-bank-scoped: outside the table entirely
  });

  test("agent token revoke → verify-refused revoked → second revoke already-gone", () => {
    const granted = grantAgentToken(deps(), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    expect(revokeAgentToken(deps(), { tokenId: granted.tokenId, requestId: "req-r" })).toBe("revoked");
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${granted.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/consolidate`,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("revoked");
    expect(revokeAgentToken(deps(), { tokenId: granted.tokenId, requestId: "req-r" })).toBe("already-gone");
  });

  test("F-006: an expiresAtMs-carrying grant refuses expired once the clock passes; an expiry-less grant stays revocation-bound", () => {
    const bounded = grantAgentToken(deps(), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
      expiresAtMs: NOW_MS + 1_000,
    });
    const now = verifyRequest(deps(), {
      authHeader: `Bearer ${bounded.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/consolidate`,
      requestId: "req-v",
    });
    expect(now.ok).toBe(true);
    const late = verifyRequest(deps({ now: () => NOW_MS + 2_000 }), {
      authHeader: `Bearer ${bounded.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/consolidate`,
      requestId: "req-v",
    });
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe("expired");
      expect(late.ttlRemainingMs).toBe(-1_000);
    }
    const unbounded = grantAgentToken(deps(), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    const farFuture = verifyRequest(deps({ now: () => NOW_MS + 86_400_000 * 365 }), {
      authHeader: `Bearer ${unbounded.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/consolidate`,
      requestId: "req-v",
    });
    expect(farFuture.ok).toBe(true); // no claims ceiling — only revocation can kill it
  });

  test("F-026: revokeAgentToken on a per-run tokenId refuses typed (kind mismatch) — the run key stays live", () => {
    const mint = minted();
    expect(
      codeOf(() => revokeAgentToken(deps(), { tokenId: mint.tokenId, requestId: "req-r" })),
    ).toBe("revoke-kind-mismatch");
    expect(deps().ledger.isRevoked(mint.tokenId)).toBe(false);
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(true); // the refused sweep never killed the run key
  });

  test("F-005: listAgentTokens lists live only — a revoked token is omitted and a corrupt claims row is skipped without aborting", () => {
    const d = deps();
    const live = grantAgentToken(d, {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["reflect"],
      requestId: "req-g",
    });
    const dying = grantAgentToken(d, {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    expect(revokeAgentToken(d, { tokenId: dying.tokenId, requestId: "req-r" })).toBe("revoked");
    d.ledger.recordIssuance({
      tokenId: "mgat-corrupt-row-0001",
      kind: "agent",
      digest: "digest-of-corrupt-row",
      claimsJson: "this is not json",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    const listed = listAgentTokens(d, { requestId: "req-list" });
    expect(listed.map((t) => t.tokenId)).toEqual([live.tokenId]);
  });

  test("R2-F-010: a grant whose expiresAtMs is in the past refuses grant-expiry-in-past — no dead-on-arrival row persists", () => {
    const rowsBefore = deps().ledger.listIssued("agent").length;
    expect(
      codeOf(() =>
        grantAgentToken(deps(), {
          consumerClass: "bot",
          banks: [BANK],
          verbs: ["consolidate"],
          requestId: "req-g",
          expiresAtMs: NOW_MS - 1_000,
        }),
      ),
    ).toBe("grant-expiry-in-past");
    expect(deps().ledger.listIssued("agent").length).toBe(rowsBefore);
  });

  test("R2-F-016: listAgentTokens reports the ROW PK — a claims.tokenId divergent from token_id lists under the PK, which is the revoke handle", () => {
    const d = deps();
    d.ledger.recordIssuance({
      tokenId: "mgat-pk-row-0000000001",
      kind: "agent",
      digest: "digest-of-pk-row",
      claimsJson: JSON.stringify({
        tokenId: "mgat-claims-divergent-1",
        consumerClass: "bot",
        banks: [BANK],
        verbs: ["consolidate"],
      }),
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    expect(listAgentTokens(d, { requestId: "req-list" }).map((t) => t.tokenId)).toEqual(["mgat-pk-row-0000000001"]);
    // the PK is the actionable handle — the claims-borne id names no row
    expect(revokeAgentToken(deps(), { tokenId: "mgat-pk-row-0000000001", requestId: "req-r" })).toBe("revoked");
    expect(revokeAgentToken(deps(), { tokenId: "mgat-claims-divergent-1", requestId: "req-r" })).toBe("none");
  });

  test("F-025: a grant's optional name rides the claims — persisted in the issuance row and still authorizing at verify", () => {
    const granted = grantAgentToken(deps(), {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["reflect"],
      requestId: "req-g",
      name: "ops-runner-alpha",
    });
    const row = deps().ledger.getIssuance(granted.tokenId);
    if (row === undefined) throw new Error("fixture: grant row missing");
    const claims = JSON.parse(row.claims_json) as Record<string, unknown>;
    expect(claims.name).toBe("ops-runner-alpha");
    const v = verifyRequest(deps(), {
      authHeader: `Bearer ${granted.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/reflect`,
      requestId: "req-v",
    });
    expect(v.ok).toBe(true); // the label adds no refusal
  });
});

// ---------------------------------------------------------------------------
// mock-roundtrip — the MANDATORY e2e demo (AC6)
// ---------------------------------------------------------------------------

describe("mock-roundtrip", () => {
  test("closed loop: mint → deliver env pair → verify ok → forward recall (mock strict parse) → pre-revoke state → revoke → refused revoked", async () => {
    const mint = minted();
    expect(mint.keyMaterial.startsWith("mgrun-")).toBe(true);
    expect(mint.expiresAtMs).toBe(NOW_MS + 60_000);

    deliverRunKey(deps(), {
      target: envTarget(),
      keyMaterial: mint.keyMaterial,
      gatewayUrl: GATEWAY_URL,
      requestId: "req-d",
    });
    const file = parseEnvFile(envTarget());
    expect(at([...file.keys()].sort(), 0)).toBe(QDS_KG_GATEWAY_URL);
    expect(at([...file.keys()].sort(), 1)).toBe(QDS_KG_RECALL_KEY);
    expect(file.get(QDS_KG_RECALL_KEY)).toBe(mint.keyMaterial);
    expect(file.get(QDS_KG_GATEWAY_URL)).toBe(GATEWAY_URL);
    expect(statSync(envTarget()).mode & 0o777).toBe(0o600);

    const ok = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect((ok.principal as { verbs?: unknown }).verbs).toEqual(["recall"]);

    const forwarded = await forwardScoped(deps(), ok.principal, "POST", RECALL_PATH, { query: "q", limit: 5 }, "req-f");
    expect(forwarded).toEqual({ results: [], durationMs: 0 }); // canned body through the SAME strict parse

    // capture (D2): the pre-revoke lifecycle-state read — token still live.
    expect(deps().ledger.isRevoked(mint.tokenId)).toBe(false);

    expect(revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" })).toBe("revoked");
    const after = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  test("third-kind: delivery writes exactly the DD-28.23 pair — no third env entry, type-level and runtime", () => {
    type DeliverInput = Parameters<typeof deliverRunKey>[1];
    const third: DeliverInput = {
      target: envTarget(),
      keyMaterial: "mgrun-x",
      gatewayUrl: GATEWAY_URL,
      requestId: "req-t",
      // @ts-expect-error no third credential kind — the deliver input names exactly the DD-28.23 pair (directive at the excess-property line — driver fix, PLAN rev 3)
      QDS_THIRD_KIND: "nope",
    };
    expect(third.requestId).toBe("req-t");
    deliverRunKey(deps(), {
      target: envTarget(),
      keyMaterial: "mgrun-x",
      gatewayUrl: GATEWAY_URL,
      requestId: "req-t",
    });
    expect([...parseEnvFile(envTarget()).keys()].sort()).toEqual([QDS_KG_GATEWAY_URL, QDS_KG_RECALL_KEY]);
  });

  test("F-007: a traversal target is refused typed at the choke point with no file written", () => {
    let caught: unknown;
    try {
      deliverRunKey(deps(), {
        target: "../escaped.env",
        keyMaterial: SENTINEL_KEY_MATERIAL,
        gatewayUrl: GATEWAY_URL,
        requestId: "req-d",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("env-file-invalid");
    expect(existsSync("../escaped.env")).toBe(false);
  });

  test("F-008: a newline-carrying gatewayUrl is refused pre-write; an mgat.-prefixed material has NO delivery path (AC6)", () => {
    let caughtUrl: unknown;
    try {
      deliverRunKey(deps(), {
        target: envTarget(),
        keyMaterial: SENTINEL_KEY_MATERIAL,
        gatewayUrl: `${GATEWAY_URL}\nEVIL_VAR=owned`,
        requestId: "req-d",
      });
    } catch (e) {
      caughtUrl = e;
    }
    expect(caughtUrl).toBeInstanceOf(MemgateError);
    expect((caughtUrl as MemgateError).code).toBe("env-file-invalid");
    expect(existsSync(envTarget())).toBe(false);
    let caughtToken: unknown;
    try {
      deliverRunKey(deps(), {
        target: envTarget(),
        keyMaterial: "mgat.eyJ0b2tlbklkIjoidCJ9.c2ln",
        gatewayUrl: GATEWAY_URL,
        requestId: "req-d",
      });
    } catch (e) {
      caughtToken = e;
    }
    expect(caughtToken).toBeInstanceOf(MemgateError);
    expect((caughtToken as MemgateError).code).toBe("env-file-invalid");
    expect(existsSync(envTarget())).toBe(false);
  });

  test("R2-F-001: the keyMaterial charset gate — an injection-carrying 'mgrun-…' remainder refuses env-file-invalid pre-write", () => {
    let caught: unknown;
    try {
      deliverRunKey(deps(), {
        target: envTarget(),
        keyMaterial: "mgrun-\nEVIL_VAR=1",
        gatewayUrl: GATEWAY_URL,
        requestId: "req-d",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("env-file-invalid");
    expect(existsSync(envTarget())).toBe(false); // the injected line never landed
  });

  test("R2-F-003: deliver-state-write-failed carries .tokenId — the live key's revoke handle rides the error", () => {
    const thrower = (entry: LogEntry): void => {
      logs.push(entry);
      if ((typeof entry.event === "string" ? entry.event : "") === "memgate-deliver") {
        throw new Error("state-emit-boom");
      }
    };
    let caught: unknown;
    try {
      deliverRunKey(deps({ log: thrower }), {
        target: envTarget(),
        keyMaterial: SENTINEL_KEY_MATERIAL,
        gatewayUrl: GATEWAY_URL,
        requestId: "req-d",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    const err = caught as MemgateError;
    expect(err.code).toBe("deliver-state-write-failed");
    expect(err.tokenId).toBe(sha256Hex(SENTINEL_KEY_MATERIAL)); // sha256(material) — the compensation handle
    expect(existsSync(envTarget())).toBe(true); // delivery itself SUCCEEDED
  });

  test("F-023/R2-F-006: a forward body with limit 0 (or 1001) refuses forward-body-invalid — never a silent widening", async () => {
    const mint = minted();
    const ok = verifyRequest(deps(), {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    if (!ok.ok) throw new Error("fixture: verify should pass");
    for (const limit of [0, 1001]) {
      expect(
        await asyncCodeOf(() =>
          forwardScoped(deps(), ok.principal, "POST", RECALL_PATH, { query: "q", limit }, "req-f"),
        ),
      ).toBe("forward-body-invalid");
    }
    // the refusals were audited on the plain code line, F-014 style
    const refusedJson = JSON.stringify(logs);
    expect(refusedJson).toContain("forward-body-invalid");
  });

  test("F-023/R2-F-005: forward retain content must be a STRING under the ceiling — an unmeasurable body never forwards", async () => {
    const granted = grantAgentToken(deps(), {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["retain"],
      requestId: "req-g",
    });
    const ok = verifyRequest(deps(), {
      authHeader: `Bearer ${granted.token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/files/retain`,
      requestId: "req-v",
    });
    if (!ok.ok) throw new Error("fixture: verify should pass");
    const attempt = (content: unknown): Promise<string> =>
      asyncCodeOf(() =>
        forwardScoped(deps(), ok.principal, "POST", `/v1/default/banks/${BANK}/files/retain`, { content }, "req-f"),
      );
    expect(await attempt(42)).toBe("forward-body-invalid"); // non-string → unmeasurable → refused
    expect(await attempt(["a", "b"])).toBe("forward-body-invalid");
    expect(await attempt("x".repeat(MAX_RETAIN_CONTENT_CHARS + 1))).toBe("forward-body-invalid"); // oversized
  });

  test("F-024: a forward transport error emits a memgate-forward line with status 'error', then rethrows the ORIGINAL error", async () => {
    const failing = {
      recall: async () => {
        throw new Error("sentinel-transport-boom");
      },
    };
    const d = deps({ client: failing as unknown as MemgateDeps["client"] });
    const mint = minted(d);
    const ok = verifyRequest(d, {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    if (!ok.ok) throw new Error("fixture: verify should pass");
    let caught: unknown;
    try {
      await forwardScoped(d, ok.principal, "POST", RECALL_PATH, { query: "q", limit: 2 }, "req-f");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("sentinel-transport-boom");
    const forwardLines = logs.filter((l) => (typeof l.event === "string" ? l.event : "") === "memgate-forward");
    expect(forwardLines.length).toBe(1); // the error line, no success line
    const line = at(forwardLines, 0);
    expect(line.status).toBe("error");
    expect(JSON.stringify(line)).toContain("sentinel-transport-boom");
  });
});

// ---------------------------------------------------------------------------
// redaction (INV-MG-5/6)
// ---------------------------------------------------------------------------

describe("redaction", () => {
  test("sentinel leakScan: no >=8-char substring of any sentinel appears in ANY captured line", () => {
    const mintDeps = deps({ randomBytes: () => SENTINEL_BYTES });
    const mint = minted(mintDeps, "run-redact");
    expect(mint.keyMaterial).toBe(SENTINEL_KEY_MATERIAL);
    const token = grantAgentToken(deps({ signingKey: SENTINEL_SIGNING }), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    deliverRunKey(deps(), {
      target: envTarget(),
      keyMaterial: mint.keyMaterial,
      gatewayUrl: GATEWAY_URL,
      requestId: "req-d",
    });
    // Force refusals carrying sentinel-bearing credentials through log + error surfaces.
    verifyRequest(deps({ adminKey: SENTINEL_ADMIN }), {
      authHeader: `Bearer ${mint.keyMaterial}x`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    try {
      grantAgentToken(deps({ adminKey: SENTINEL_ADMIN }), {
        consumerClass: "bot",
        banks: [BANK],
        verbs: ["consolidate"],
        requestId: "req-g",
      });
    } catch {
      // refusal expected; its error surface is scanned below
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const sentinel of [mint.keyMaterial, token.token, SENTINEL_ADMIN, SENTINEL_SIGNING]) {
      for (const line of logs) {
        expect(leakScan(sentinel, JSON.stringify(line))).toBeNull();
      }
    }
  });

  test("error surfaces carry codes + remediation only — no sentinel; remediation names the env var, never the value", () => {
    let caught: MemgateError | undefined;
    try {
      grantAgentToken(deps({ adminKey: SENTINEL_ADMIN }), {
        consumerClass: "bot",
        banks: [BANK],
        verbs: ["consolidate"],
        requestId: "req-g",
      });
    } catch (e) {
      if (e instanceof MemgateError) caught = e;
      else throw e;
    }
    if (!caught) throw new Error("expected MemgateError");
    expect(caught.code).toBe("admin-auth");
    expect(leakScan(SENTINEL_ADMIN, caught.message, caught.remediation)).toBeNull();
    expect(caught.remediation).toContain(MEMGATE_ADMIN_KEY); // env-var NAME reference, never the expanded value
  });

  test("the env file is the ONE sanctioned material sink — positive control for the scan", () => {
    const mint = minted(deps({ randomBytes: () => SENTINEL_BYTES }), "run-sink");
    deliverRunKey(deps(), {
      target: envTarget(),
      keyMaterial: mint.keyMaterial,
      gatewayUrl: GATEWAY_URL,
      requestId: "req-d",
    });
    expect(readFileSync(envTarget(), "utf8")).toContain(mint.keyMaterial); // material existed and landed where sanctioned
    for (const line of logs) expect(leakScan(mint.keyMaterial, JSON.stringify(line))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ledger (bun:sqlite INSERT-only, digest-at-rest, fail-closed)
// ---------------------------------------------------------------------------

describe("ledger", () => {
  test("openReadOnly on an absent path refuses ledger-unreadable and NEVER creates the file", () => {
    const absent = join(dir, "absent-ledger.db");
    expect(codeOf(() => openReadOnly(absent))).toBe("ledger-unreadable");
    expect(existsSync(absent)).toBe(false);
  });

  test("QDS_MEMGATE_LEDGER coercion: explicit arg > env > empty-string-as-unset > default", () => {
    delete process.env[QDS_MEMGATE_LEDGER];
    expect(resolveMemgateLedgerPath()).toBe(DEFAULT_LEDGER);
    process.env[QDS_MEMGATE_LEDGER] = "";
    expect(resolveMemgateLedgerPath()).toBe(DEFAULT_LEDGER); // empty = UNSET, not a path
    process.env[QDS_MEMGATE_LEDGER] = "/env-placed/ledger.db";
    expect(resolveMemgateLedgerPath()).toBe("/env-placed/ledger.db");
    expect(resolveMemgateLedgerPath("/explicit/ledger.db")).toBe("/explicit/ledger.db");
  });

  test("INSERT-only: raw bun:sqlite UPDATE/DELETE on both tables raise (append-only triggers)", () => {
    const ledger = new MemgateLedger(ledgerPath());
    ledger.recordIssuance({
      tokenId: "t-1",
      kind: "per-run",
      digest: "digest-of-t-1",
      claimsJson: "{}",
      runId: "run-ledger",
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 1_000,
    });
    ledger.recordRevocation("t-1", "revoked");
    ledger.close();
    const raw = new Database(ledgerPath());
    try {
      for (const sql of [
        "UPDATE memgate_issuance SET digest = 'x'",
        "DELETE FROM memgate_issuance",
        "UPDATE memgate_revocations SET outcome = 'x'",
        "DELETE FROM memgate_revocations",
      ]) {
        expect(() => raw.prepare(sql).run()).toThrow(/append-only/);
      }
    } finally {
      raw.close();
    }
  });

  test("digest-at-rest: raw ledger bytes carry no key/token material, do carry scope claims", () => {
    const mint = minted(deps({ randomBytes: () => SENTINEL_BYTES }), "run-rest");
    const token = grantAgentToken(deps(), {
      consumerClass: "bot",
      banks: [BANK],
      verbs: ["consolidate"],
      requestId: "req-g",
    });
    revokeRunMemoryKey(deps(), { tokenId: mint.tokenId, requestId: "req-r" });
    const rawBytes = readFileSync(ledgerPath(), "latin1");
    expect(rawBytes).toContain("run-rest"); // positive control: claims ARE at rest
    for (const secret of [mint.keyMaterial, token.token]) {
      expect(leakScan(secret, rawBytes)).toBeNull();
    }
  });

  test("fail-closed revocation: corrupt db and faulting reader refuse ledger-unreadable, never ok", () => {
    const corrupt = join(dir, "corrupt-ledger.db");
    writeFileSync(corrupt, "this is not a sqlite database file");
    expect(codeOf(() => openReadOnly(corrupt))).toBe("ledger-unreadable");

    const mint = minted();
    const faulting = {
      isRevoked: () => {
        // (code, message, remediation) — the ProviderError pattern of record (driver fix, PLAN rev 3)
        throw new MemgateError("ledger-unreadable", "ledger unreadable", "inspect QDS_MEMGATE_LEDGER and point it at the real ledger file");
      },
      getIssuance: () => {
        throw new MemgateError("ledger-unreadable", "ledger unreadable", "inspect QDS_MEMGATE_LEDGER and point it at the real ledger file");
      },
    };
    const v = verifyRequest({ ...deps(), ledger: faulting } as unknown as MemgateDeps, {
      authHeader: `Bearer ${mint.keyMaterial}`,
      method: "POST",
      path: RECALL_PATH,
      requestId: "req-v",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("ledger-unreadable"); // fail-closed, never a false ok
  });

  test("F-022: the injectable ledger clock stamps revoked_at_ms with the injected now", () => {
    const REV_AT = NOW_MS + 543_210;
    const path = join(dir, "clocked-ledger.db");
    const clocked = new MemgateLedger(path, { now: () => REV_AT });
    try {
      clocked.recordIssuance({
        tokenId: "t-clocked",
        kind: "agent",
        digest: "digest-of-t-clocked",
        claimsJson: "{}",
        runId: null,
        createdAtMs: NOW_MS,
        expiresAtMs: null,
      });
      expect(clocked.recordRevocation("t-clocked", "revoked")).toBe("revoked");
    } finally {
      clocked.close();
    }
    const raw = new Database(path);
    try {
      const row = raw.prepare("SELECT revoked_at_ms FROM memgate_revocations WHERE token_id = ?").get(
        "t-clocked",
      ) as { revoked_at_ms: number };
      expect(row.revoked_at_ms).toBe(REV_AT);
    } finally {
      raw.close();
    }
  });

  test("F-009: the INJECTED env carries the ledger path — a process.env value set at the same time never wins", () => {
    const envPlaced = join(dir, "env-carried", "ledger.db");
    const processPlaced = join(dir, "from-process-env.db");
    process.env[QDS_MEMGATE_LEDGER] = processPlaced; // hostile: set BEFORE the injected construction
    const d = memgateDeps({
      env: {
        [MEMGATE_ADMIN_KEY]: ADMIN,
        [QDS_MEMGATE_SIGNING_KEY]: SIGNING,
        [QDS_MEMGATE_LEDGER]: envPlaced,
      },
      now: () => NOW_MS,
    });
    openLedgers.push(d.ledger);
    d.ledger.recordIssuance({
      tokenId: "t-f9",
      kind: "agent",
      digest: "digest-of-t-f9",
      claimsJson: "{}",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    expect(existsSync(envPlaced)).toBe(true);
    expect(existsSync(processPlaced)).toBe(false); // process.env was never consulted
  });

  test("F-011: a revocation that loses the issuance PK race answers already-gone — prior-state semantics, never a fatal mislabeled unwritable", () => {
    const ledger = tracked(new MemgateLedger(join(dir, "race-ledger.db")));
    ledger.recordIssuance({
      tokenId: "t-race",
      kind: "agent",
      digest: "digest-of-t-race",
      claimsJson: "{}",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    // The concurrent writer's INSERT between our SELECT and INSERT, simulated
    // honestly by pre-seeding the revocation set through a raw second handle —
    // both arms (prior-state select and the UNIQUE-catch) return the SAME answer.
    const raw = new Database(join(dir, "race-ledger.db"));
    try {
      raw.prepare("INSERT INTO memgate_revocations (token_id, revoked_at_ms, outcome) VALUES (?,?,?)").run(
        "t-race",
        NOW_MS,
        "revoked",
      );
    } finally {
      raw.close();
    }
    expect(ledger.recordRevocation("t-race", "revoked")).toBe("already-gone");
  });

  test("F-012: a path swapped for a DIFFERENT valid sqlite file (no memgate schema) refuses ledger-unreadable — the post-attach assert", () => {
    const swap = join(dir, "swap-ledger.db");
    const real = tracked(new MemgateLedger(swap));
    real.recordIssuance({
      tokenId: "t-swap",
      kind: "agent",
      digest: "digest-of-t-swap",
      claimsJson: "{}",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    real.close();
    const foreign = new Database(join(dir, "foreign.db"));
    foreign.exec("CREATE TABLE foreign_table (id INTEGER)");
    foreign.close();
    copyFileSync(join(dir, "foreign.db"), swap); // rename-over: the path now holds a valid NON-memgate sqlite file
    expect(codeOf(() => openReadOnly(swap))).toBe("ledger-unreadable");
    expect(existsSync(swap)).toBe(true); // a read refusal never destroys the file
  });

  test("F-020: a ledger open over a hostile path (parent is a regular file) refuses TYPED — never a raw ENOTDIR", () => {
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "a regular file — nothing can live under it\n");
    expect(codeOf(() => new MemgateLedger(join(blocker, "l.db")))).toBe("ledger-unwritable");
    expect(codeOf(() => openReadOnly(join(blocker, "l.db")))).toBe("ledger-unreadable");
  });

  test("F-021: a failed writable open NEVER removes a populated ledger — the refusal is typed and the rows survive", () => {
    const path = join(dir, "populated-ledger.db");
    const populated = tracked(new MemgateLedger(path));
    populated.recordIssuance({
      tokenId: "t-keep",
      kind: "agent",
      digest: "digest-of-t-keep",
      claimsJson: "{}",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    });
    populated.close();
    // Force the append-open failure the public API can produce: the populated
    // file goes unreadable/unwritable, so the "ax" probe AND the plain append
    // open both refuse — createdHere is false, so the constructor must not
    // touch the file at all (the zero-row-skeleton cleanup is for ITS OWN
    // exclusive create only).
    chmodSync(path, 0o000);
    expect(codeOf(() => new MemgateLedger(path))).toBe("ledger-unwritable");
    chmodSync(path, 0o600);
    const reopened = openReadOnly(path);
    try {
      expect(reopened.getIssuance("t-keep")).toBeDefined(); // the populated ledger survived the failed open
    } finally {
      reopened.close();
    }
  });

  test("R2-F-009: an issuance PK collision is a typed token-id-collision — the append-only invariant held, one row remains", () => {
    const ledger = tracked(new MemgateLedger(join(dir, "collision.db")));
    const row = {
      tokenId: "t-collide",
      kind: "agent" as const,
      digest: "digest-of-t-collide",
      claimsJson: "{}",
      runId: null,
      createdAtMs: NOW_MS,
      expiresAtMs: null,
    };
    ledger.recordIssuance(row);
    expect(codeOf(() => ledger.recordIssuance(row))).toBe("token-id-collision");
    expect(ledger.listIssued().length).toBe(1); // not two, not zero — the original row untouched
  });
});
