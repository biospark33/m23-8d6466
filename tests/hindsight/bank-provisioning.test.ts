import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BankIdSchema,
  ERR_BANK_COLLISION,
  ERR_BANK_ID_INVALID,
  ERR_HINDSIGHT_UNAVAILABLE,
  ERR_MCP_BRIDGE_NOT_REGISTERED,
  HindsightHttpError,
} from "../../src/hindsight/index.ts";
import {
  COLLECTIVE_BANK_ID,
  LOCK_STALE_MS,
  provisionBanks,
  resolveProvisionedRepoBankId,
  resolveRepoBankId,
  safeRepoBaseCandidates,
  type BridgeProbe,
  type ProvisionClient,
  type ProvisionResult,
} from "../../src/hindsight/bank-provisioner.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

interface MockClient extends ProvisionClient {
  createBank: ReturnType<typeof mock>;
  listBanks: ReturnType<typeof mock>;
}

function makeMockClient(opts: {
  existingBankIds?: string[];
  createBankThrows?: (bankId: string) => unknown;
} = {}): MockClient {
  const existing = new Set(opts.existingBankIds ?? []);
  return {
    createBank: mock((bankId: string) => {
      if (opts.createBankThrows) {
        const e = opts.createBankThrows(bankId);
        if (e) throw e;
      }
      existing.add(bankId);
      return Promise.resolve({ bank_id: bankId });
    }),
    listBanks: mock(() =>
      Promise.resolve({ banks: [...existing].map((id) => ({ bank_id: id })) }),
    ),
  };
}

const HEALTHY: BridgeProbe = { registered: true, healthy: true };

// ---------------------------------------------------------------------------
// tmpdir lock + log capture
// ---------------------------------------------------------------------------

let tmpDir: string;
let lockPath: string;
let logEntries: LogEntry[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "qds-prov-"));
  lockPath = join(tmpDir, "provision.lock");
  logEntries = [];
  restoreSink = setLogSink((e) => {
    logEntries.push(e);
  });
});

afterEach(() => {
  restoreSink?.();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bank-provisioner: happy path", () => {
  test("creates three banks when none exist", async () => {
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.banks.map((b) => b.bankId);
    expect(ids).toEqual([
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-qa-meta",
      "qds-factory-maint-meta",
      COLLECTIVE_BANK_ID,
    ]);
    expect(result.banks.every((b) => b.status === "created")).toBe(true);
    expect(client.createBank).toHaveBeenCalledTimes(5);
  });

  test("a lock stolen mid-provision is a log line, not a thrown success", async () => {
    // The provisioner overran LOCK_STALE_MS and another holder stole the path.
    // release() then refuses to unlink a foreign lock (file-lock.ts) — and that
    // must NOT escape from the finally and discard {ok:true, banks}.
    const client = makeMockClient();
    client.createBank.mockImplementation((bankId: string) => {
      writeFileSync(lockPath, "99999:b-nonce", { mode: 0o600 });
      return Promise.resolve({ bank_id: bankId });
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });

    expect(result.ok).toBe(true);
    const released = logEntries.find((e) => e.operation === "provision.release");
    expect(released?.level).toBe("warn");
    expect(released?.message).toContain("taken over");
  });

  test("returns requestId matching input", async () => {
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "req-123",
    });
    expect(result.ok).toBe(true);
    expect((result as { requestId: string }).requestId).toBe("req-123");
  });
});

describe("bank-provisioner: idempotency", () => {
  test("createBank returning 409 → status 'exists'", async () => {
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(409, "already exists", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks.every((b) => b.status === "exists")).toBe(true);
  });

  test("createBank throwing 'already exists' message → status 'exists'", async () => {
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(422, "bank already exists", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks[0]!.status).toBe("exists");
  });

  test("createBank throwing non-conflict error → -32005 envelope (fix E-3)", async () => {
    // Previously: raw HindsightHttpError escaped provisionBanks uncaught,
    // crashing the CLI with NO JSON envelope. Fix E-3 wraps the createBank
    // loop in a try/catch and emits {ok:false, error:{code:-32005, message}}.
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(500, "server boom", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_COLLISION);
    expect(result.error.message).toMatch(/bank provisioning failed/);
    expect(result.error.message).toMatch(/server boom/);
  });

  test("createBank 502 → -32005 envelope AND lock released (fix E-3)", async () => {
    // First call: createBank throws 502 → envelope returned (no throw).
    // Second call (clean client) must proceed normally — proves the lock
    // was released via the outer finally block.
    const failingClient = makeMockClient({
      createBankThrows: () => new HindsightHttpError(502, "boom", "req"),
    });
    const r1 = await provisionBanks({
      client: failingClient,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.code).toBe(ERR_BANK_COLLISION);
    expect(r1.error.message).toMatch(/bank provisioning failed/);

    // Lock must be released — a clean second call proceeds.
    const r2 = await provisionBanks({
      client: makeMockClient(),
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r2.ok).toBe(true);
  });
});

describe("bank-provisioner: AC-4 bridge not registered (-32001)", () => {
  test("registered=false → no createBank calls", async () => {
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: { registered: false, healthy: false },
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_MCP_BRIDGE_NOT_REGISTERED);
    expect(client.createBank).not.toHaveBeenCalled();
    expect(client.listBanks).not.toHaveBeenCalled();
  });
});

describe("bank-provisioner: AC-5 Hindsight unavailable (-32002)", () => {
  test("registered=true, healthy=false → -32002, no bank work", async () => {
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: { registered: true, healthy: false },
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_HINDSIGHT_UNAVAILABLE);
    expect(client.createBank).not.toHaveBeenCalled();
  });
});

describe("bank-provisioner: -32003 bank id invalid (INV-HM2)", () => {
  test("resolveBankId('!!!!') → '' fails BankIdSchema → -32003, no client calls", async () => {
    // Sanity: the foundation's resolver + schema behave as the story assumes.
    expect(BankIdSchema.safeParse("").success).toBe(false);
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "!!!!",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_ID_INVALID);
    expect(client.createBank).not.toHaveBeenCalled();
    expect(client.listBanks).not.toHaveBeenCalled();
  });

  test("path-injection slug is sanitized, not blocked (-32003 only fires on empty/invalid)", async () => {
    // "../../etc/passwd" → "etc-passwd" which IS a valid BankIdSchema value,
    // so the provisioner proceeds (defense-in-depth: no path component can
    // reach the URL — resolveBankId strips all non-[a-z0-9]). This documents
    // that -32003 fires ONLY when resolveBankId yields an invalid id (empty
    // string from all-special-char input), not for path-like slugs.
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "../../etc/passwd",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks[0]!.bankId).toBe("etc-passwd");
    expect(ERR_BANK_ID_INVALID).toBe(-32003);
  });
});

describe("bank-provisioner: -32005 collision unresolvable", () => {
  test("all 11 suffixed bank ids taken → -32005", async () => {
    // Pre-populate with the base id + -2..-11 (all 11 candidates).
    const existing: string[] = ["qds-factory"];
    for (let n = 2; n <= 11; n++) existing.push(`qds-factory-${n}`);
    const client = makeMockClient({ existingBankIds: existing });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_COLLISION);
    expect(result.error.message).toBe("bank_id_collision_unresolvable");
  });

  test("base id collides but -2 free → uses -2", async () => {
    const client = makeMockClient({ existingBankIds: ["qds-factory"] });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.banks.map((b) => b.bankId);
    expect(ids).toEqual([
      "qds-factory-2",
      "qds-factory-2-dev-meta",
      "qds-factory-2-qa-meta",
      "qds-factory-2-maint-meta",
      COLLECTIVE_BANK_ID,
    ]);
  });

  test("existing qds-collective is idempotent, not collision", async () => {
    const client = makeMockClient({ existingBankIds: [COLLECTIVE_BANK_ID] });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // createBank was still called 5 times (idempotent PUT).
    expect(client.createBank).toHaveBeenCalledTimes(5);
  });
});

describe("bank-provisioner: single-flight (INV-HM6 / CC-10)", () => {
  test("second concurrent provision → provision_in_progress envelope has NO code (fix [2])", async () => {
    const client = makeMockClient();
    // Slow createBank so the first provision holds the lock during the
    // second call.
    let firstCallCount = 0;
    client.createBank.mockImplementation(() => {
      firstCallCount++;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ bank_id: "ok" }), 50);
      });
    });

    // Simulate a concurrent provisioner: the lock is O_EXCL, so while the
    // first (slow) provision holds the lock, a second provisionBanks call
    // immediately returns provision_in_progress without touching createBank.
    const first = provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    // Yield once so the first call has a chance to acquire.
    await new Promise((r) => setTimeout(r, 10));

    const second = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });

    await first;
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // Per spec CC-10/INV-HM6: the single-flight envelope is EXACTLY
    // { ok:false, error:{ message:"provision_in_progress" }, requestId }
    // with NO code field. -32005 is reserved for collision-unresolvable only.
    expect(second.error.message).toBe("provision_in_progress");
    expect(second.error.code).toBeUndefined();
    expect(firstCallCount).toBe(5);
  });

  test("stale lock (old mtime) → recovered and provision succeeds (fix [3])", async () => {
    // Pre-create a stale lock file (old mtime) at lockPath.
    writeFileSync(lockPath, "999999");
    const staleTime = new Date(Date.now() - (LOCK_STALE_MS + 60_000));
    utimesSync(lockPath, staleTime, staleTime);

    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks).toHaveLength(5);
    expect(client.createBank).toHaveBeenCalledTimes(5);
  });

  test("stale lock (dead PID, fresh mtime) → recovered (fix [3])", async () => {
    // PID 999999 is almost certainly not running on any host.
    writeFileSync(lockPath, "999999");
    // Fresh mtime (within LOCK_STALE_MS), so only the dead-PID check fires.
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks).toHaveLength(5);
  });

  test("fresh lock held by live PID → provision_in_progress (no code) (fix [3])", async () => {
    // Write our own PID (always alive) + fresh mtime → not stale → blocked.
    writeFileSync(lockPath, String(process.pid));
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("provision_in_progress");
    expect(result.error.code).toBeUndefined();
    expect(client.createBank).not.toHaveBeenCalled();
  });

  test("lock released after success (next provision proceeds)", async () => {
    const client = makeMockClient();
    const r1 = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r1.ok).toBe(true);
    const r2 = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r2.ok).toBe(true);
  });

  test("lock released after error", async () => {
    // Fix E-3: failed createBank now returns a -32005 envelope (no throw),
    // but the lock must still release — a clean second call proceeds.
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(500, "boom", "r"),
    });
    const r1 = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r1.ok).toBe(false);
    // Lock should be released; a clean second run works.
    const r2 = await provisionBanks({
      client: makeMockClient(),
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(r2.ok).toBe(true);
  });
});

describe("bank-provisioner: observability (CC-9)", () => {
  test("emits provision_ms metric per bank", async () => {
    const client = makeMockClient();
    await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "obs-1",
    });
    const provisionLogs = logEntries.filter(
      (e) => e.operation === "provision" && e.requestId === "obs-1",
    );
    expect(provisionLogs.length).toBe(5);
    for (const e of provisionLogs) {
      expect(typeof e.provision_ms).toBe("number");
      expect(e.provision_ms).toBeGreaterThanOrEqual(0);
      expect(e.status).toBe("ok");
      expect(typeof e.bankId === "string" && e.bankId.length > 0).toBe(true);
    }
  });
});

describe("bank-provisioner: envelope contract", () => {
  test("ProvisionResult discriminated union shape", async () => {
    const ok = await provisionBanks({
      client: makeMockClient(),
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(ok.ok).toBe(true);
    expect((ok as ProvisionResult).ok === true).toBe(true);

    const err = await provisionBanks({
      client: makeMockClient(),
      repoSlug: "!!!!",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(err.error).toHaveProperty("message");
    expect(typeof err.requestId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Fix [1]: 64-char slug → suffixed candidate overflow protection
// ---------------------------------------------------------------------------

describe("bank-provisioner: fix [1] 64-char slug overflow (INV-HM2)", () => {
  test("64-char repo slug with colliding truncated base → suffixed valid id", async () => {
    // resolveBankId of a 64-char [a-z0-9] slug returns the same 64 chars,
    // which the provisioner truncates to 50 (so `-maint-meta` AND a collision
    // suffix both fit). If that 50-char truncated form collides in listBanks,
    // the suffix loop runs and returns `<truncated>-2`, which must itself be
    // schema-valid, and `<truncated>-2-dev-meta` must also be schema-valid.
    const slug64 = "a".repeat(64);
    const truncatedBase = "a".repeat(50);
    // Sanity: base + suffixed variants are invalid without truncation.
    expect(BankIdSchema.safeParse(`${slug64}-2`).success).toBe(false);
    expect(BankIdSchema.safeParse(`${slug64}-dev-meta`).success).toBe(false);

    // Truncated base collides → suffix loop produces a valid suffixed id.
    const client = makeMockClient({ existingBankIds: [truncatedBase] });
    const result = await provisionBanks({
      client,
      repoSlug: slug64,
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const repoBankId = result.banks[0]!.bankId;
    const devMetaId = result.banks[1]!.bankId;
    // Both MUST be schema-valid (fix [1] core guarantee — ≤64 chars).
    expect(BankIdSchema.safeParse(repoBankId).success).toBe(true);
    expect(BankIdSchema.safeParse(devMetaId).success).toBe(true);
    expect(devMetaId.length).toBeLessThanOrEqual(64);
    // Suffixed form, not the bare truncated base.
    expect(repoBankId).toBe(`${truncatedBase}-2`);
    expect(devMetaId).toBe(`${repoBankId}-dev-meta`);
    // createBank was called 5 times with valid ids only.
    expect(client.createBank).toHaveBeenCalledTimes(5);
    for (const call of client.createBank.mock.calls) {
      const id = call[0] as string;
      expect(BankIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test("64-char slug, base unique → truncated base used (still valid for dev-meta)", async () => {
    const slug64 = "b".repeat(64);
    const client = makeMockClient(); // no existing banks
    const result = await provisionBanks({
      client,
      repoSlug: slug64,
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Base truncated to 50 chars max so `-maint-meta` (11) + worst-case
    // collision suffix ("-11", 3) both still fit within the 64-char schema cap.
    const repoBankId = result.banks[0]!.bankId;
    const devMetaId = result.banks[1]!.bankId;
    expect(repoBankId.length).toBe(50);
    expect(BankIdSchema.safeParse(repoBankId).success).toBe(true);
    expect(BankIdSchema.safeParse(devMetaId).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix [7]: listBanks failure → skip collision loop, fall back to idempotent PUT
// ---------------------------------------------------------------------------

describe("bank-provisioner: fix [7] listBanks failure fallback", () => {
  test("listBanks throws → no collision loop, idempotent PUT succeeds", async () => {
    const client = makeMockClient();
    client.listBanks.mockImplementation(() => Promise.reject(new Error("listBanks boom")));

    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Base id is used as-is (no -2..-11 suffixing, since we can't detect
    // collisions without listBanks).
    const ids = result.banks.map((b) => b.bankId);
    expect(ids).toEqual([
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-qa-meta",
      "qds-factory-maint-meta",
      COLLECTIVE_BANK_ID,
    ]);
    // 5 idempotent PUTs.
    expect(client.createBank).toHaveBeenCalledTimes(5);
    // listBanks was attempted exactly once.
    expect(client.listBanks).toHaveBeenCalledTimes(1);
  });

  test("listBanks throws + createBank returns 409 → still ok via idempotent path", async () => {
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(409, "already exists", "r"),
    });
    client.listBanks.mockImplementation(() => Promise.reject(new Error("net err")));

    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks.every((b) => b.status === "exists")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix [2] + [3] additional: -32005 still reserved for genuine collision
// ---------------------------------------------------------------------------

describe("bank-provisioner: -32005 reserved for collision-unresolvable only", () => {
  test("fresh lock held by live PID never returns -32005 (fix [2] regression guard)", async () => {
    writeFileSync(lockPath, String(process.pid));
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Lock path: NO code field (not -32005).
    expect(result.error.code).toBeUndefined();
    expect(result.error.message).toBe("provision_in_progress");
  });

  test("collision exhaustion still returns -32005 (regression guard)", async () => {
    // All 11 candidates taken → genuine -32005.
    const existing: string[] = ["qds-factory"];
    for (let n = 2; n <= 11; n++) existing.push(`qds-factory-${n}`);
    const client = makeMockClient({ existingBankIds: existing });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_COLLISION);
    expect(result.error.message).toBe("bank_id_collision_unresolvable");
  });
});

// ---------------------------------------------------------------------------
// Fix E-1 (HIGH): worst-case collision "-11" + "-dev-meta" stays ≤64.
// ---------------------------------------------------------------------------

describe("bank-provisioner: fix E-1 worst-case suffix length (INV-HM2)", () => {
  test("base near cap, collision loop reaches -11 → all manager meta banks valid", async () => {
    // 60-char slug → truncated to 50 (safeBase). Pre-populate existing banks
    // with safeBase AND safeBase-2..safeBase-10 so the loop falls through to
    // the LAST candidate (safeBase-11). Then `${safeBase}-11-maint-meta` must
    // still satisfy BankIdSchema: 50 + "-11" (3) + "-maint-meta" (11) = 64 —
    // the longest family suffix lands exactly at the cap, never 65.
    const safeBase = "c".repeat(50);
    const slug = "c".repeat(60);
    const existing = [safeBase];
    for (let n = 2; n <= 10; n++) existing.push(`${safeBase}-${n}`);
    const client = makeMockClient({ existingBankIds: existing });
    const result = await provisionBanks({
      client,
      repoSlug: slug,
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const repoBankId = result.banks[0]!.bankId;
    const devMetaId = result.banks[1]!.bankId;
    const qaMetaId = result.banks[2]!.bankId;
    const maintMetaId = result.banks[3]!.bankId;
    expect(repoBankId).toBe(`${safeBase}-11`);
    expect(repoBankId.length).toBe(53); // 50 + len("-11")
    expect(devMetaId).toBe(`${repoBankId}-dev-meta`);
    expect(qaMetaId).toBe(`${repoBankId}-qa-meta`);
    expect(maintMetaId).toBe(`${repoBankId}-maint-meta`);
    for (const id of [devMetaId, qaMetaId, maintMetaId]) {
      expect(BankIdSchema.safeParse(id).success).toBe(true);
    }
    // The load-bearing assertion: maint-meta (longest suffix) id is exactly at
    // the 64-char cap and still parses. 50 + 3 + 11 = 64, never 65.
    expect(maintMetaId.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Fix B-4 (MEDIUM): failed createBank logs status:"error", not "ok".
// ---------------------------------------------------------------------------

describe("bank-provisioner: fix B-4 failed-provision log status", () => {
  test("non-idempotent createBank failure → provision log status:'error'", async () => {
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(503, "upstream down", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "b4-1",
    });
    expect(result.ok).toBe(false);
    const provisionLogs = logEntries.filter(
      (e) => e.operation === "provision" && e.requestId === "b4-1",
    );
    expect(provisionLogs.length).toBeGreaterThanOrEqual(1);
    for (const e of provisionLogs) {
      // Pre-fix: the failed provision logged status:"ok". Post-fix: "error".
      expect(e.status).toBe("error");
      expect(typeof e.error?.code).toBe("string");
      expect(e.error?.code).toMatch(/^http_/);
    }
  });
});

// ---------------------------------------------------------------------------
// Review R2 (2026-07-19): listBanks-fail dev-meta overflow + lock-throw guard
// ---------------------------------------------------------------------------

describe("bank-provisioner: review R2 fixes", () => {
  test("listBanks fails + long slug → dev-meta still fits BankIdSchema [R2 M1]", async () => {
    // Pre-fix: the listBanks-fail fallback used the untruncated 64-char base
    // id, so `${base}-dev-meta` overflowed to 73 chars and failed inside
    // createBankIdempotent. Post-fix: the fallback truncates to MAX_BASE_LEN
    // (50), so maint-meta = 61 chars and stays schema-valid.
    const longSlug = "a".repeat(64);
    const client = makeMockClient();
    client.listBanks.mockImplementation(() => Promise.reject(new Error("net err")));
    const result = await provisionBanks({
      client,
      repoSlug: longSlug,
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "r2-m1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All five targets still created on the truncated base.
    expect(result.banks).toHaveLength(5);
    expect(result.banks[0]!.bankId.length).toBeLessThanOrEqual(50);
    for (const b of result.banks) {
      expect(BankIdSchema.safeParse(b.bankId).success).toBe(true);
    }
    const devMeta = result.banks.find((b) => b.bankId.endsWith("-dev-meta"));
    expect(devMeta).toBeDefined();
    expect(devMeta!.bankId.length).toBeLessThanOrEqual(64);
  });

  test("uncreatable lock path → structured envelope, no crash [R2 M2]", async () => {
    // lockPath whose parent is a regular file → openSync(wx) throws a non-
    // EEXIST errno (ENOTDIR/EACCES/EISDIR) → the acquireLock wrapper must
    // surface a structured envelope instead of escaping as a raw stack trace.
    writeFileSync(join(tmpDir, "blocker"), "i am a file, not a dir");
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath: join(tmpDir, "blocker", "provision.lock"),
      requestId: "r2-m2",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_COLLISION);
    expect(result.error.message).toMatch(/provision lock unavailable/);
    // No bank work done — the guard short-circuits before any createBank.
    expect(client.createBank).not.toHaveBeenCalled();
  });

  test("extractExistingBankIds ignores display names that aren't valid ids [R2 M8]", async () => {
    // A bank with a human display name "My Repo" (invalid id shape) must NOT
    // pollute the collision set and force a spurious -2 suffix.
    const client = makeMockClient();
    client.listBanks.mockImplementation(() =>
      Promise.resolve({ banks: [{ bank_id: "other-repo", name: "My Repo" }] }),
    );
    const result = await provisionBanks({
      client,
      repoSlug: "my-repo",
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "r2-m8",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "my-repo" is NOT taken (only "other-repo" exists; "My Repo" is a display
    // name, ignored) → no -2 suffix.
    expect(result.banks[0]!.bankId).toBe("my-repo");
  });

  test("bare 422 (not 'already exist') is NOT masked as idempotent exists [R2 M6/M7]", async () => {
    // A 422 whose body does not say "already exist" is a real validation
    // failure → must surface as -32005, not silently "exists".
    const client = makeMockClient({
      createBankThrows: () => new HindsightHttpError(422, "invalid field: options", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
      requestId: "r2-m6",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ERR_BANK_COLLISION);
  });
});

describe("resolveProvisionedRepoBankId (read-side family resolver)", () => {
  test("base + -dev-meta present → base id", () => {
    const existing = new Set(["acme-widget", "acme-widget-dev-meta", COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBe("acme-widget");
  });

  test("collision-provisioned family → the suffixed id the provisioner created", () => {
    // acme-widget exists but is FOREIGN (no -dev-meta sibling); the provisioner
    // created the acme-widget-2 family. Same candidate order as
    // resolveRepoBankId, first family-signature match wins.
    const existing = new Set([
      "acme-widget",
      "acme-widget-2",
      "acme-widget-2-dev-meta",
      COLLECTIVE_BANK_ID,
    ]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBe("acme-widget-2");
  });

  test("fresh state (no banks) → null", () => {
    expect(resolveProvisionedRepoBankId("acme-widget", new Set())).toBeNull();
  });

  test("foreign base without a -dev-meta sibling → null (never the bare base)", () => {
    const existing = new Set(["acme-widget", COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBeNull();
  });

  test("a qa-meta sibling alone does NOT identify the family (strict dev-meta signature)", () => {
    // Only -dev-meta co-presence proves ownership (M1.1 semantics, restored
    // by round-1 fix F-004): qa/maint meta banks are not part of the
    // signature.
    const existing = new Set(["acme-widget", "acme-widget-qa-meta", COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBeNull();
  });

  test("a maint-meta sibling (longest suffix) alone does NOT identify the family", () => {
    const existing = new Set(["acme-widget", "acme-widget-maint-meta", COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBeNull();
  });

  test("suffixed family NOT recognized via a maint-meta sibling without dev-meta", () => {
    const existing = new Set(["acme-widget", "acme-widget-2", "acme-widget-2-maint-meta"]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBeNull();
  });

  test("recognized via dev-meta even when qa/maint siblings also exist", () => {
    const existing = new Set([
      "acme-widget",
      "acme-widget-dev-meta",
      "acme-widget-qa-meta",
      "acme-widget-maint-meta",
      COLLECTIVE_BANK_ID,
    ]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBe("acme-widget");
  });

  test("unrelated sibling (-ops-meta) is NOT a family signature", () => {
    // Only the manager meta banks the provisioner creates carry the signature;
    // an outside sibling like -ops-meta must not make a foreign base ours.
    const existing = new Set(["acme-widget", "acme-widget-ops-meta", COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId("acme-widget", existing)).toBeNull();
  });

  test("legacy 52-max era family (52-char base + dev-meta) recognized read-side", () => {
    // F-002: a family provisioned under the pre-M3.1 52-char cap has its base
    // at 52 chars; the current 50-truncation differs, and without the legacy
    // probe the family would be unfindable (re-provisioning forks a
    // duplicate). 54-char slug → 50-form "qds-" + 46 x, legacy form
    // "qds-" + 48 x.
    const slug = `qds-${"x".repeat(50)}`; // 54 chars
    const legacyBase = `qds-${"x".repeat(48)}`; // 52 chars
    const existing = new Set([legacyBase, `${legacyBase}-dev-meta`, COLLECTIVE_BANK_ID]);
    expect(resolveProvisionedRepoBankId(slug, existing)).toBe(legacyBase);
    expect(safeRepoBaseCandidates(slug)[0].length).toBe(50);
    expect(safeRepoBaseCandidates(slug)[1]).toBe(legacyBase);
  });

  test("legacy family with qa/maint siblings also found via dev-meta (strict predicate, legacy probe)", () => {
    const slug = `qds-${"x".repeat(50)}`;
    const legacyBase = `qds-${"x".repeat(48)}`;
    const existing = new Set([
      legacyBase,
      `${legacyBase}-dev-meta`,
      `${legacyBase}-qa-meta`,
      `${legacyBase}-maint-meta`,
      COLLECTIVE_BANK_ID,
    ]);
    expect(resolveProvisionedRepoBankId(slug, existing)).toBe(legacyBase);
  });

  test("collision loop probes legacy forms too (suffixed legacy family recognized)", () => {
    const slug = `qds-${"x".repeat(50)}`;
    const legacyBase = `qds-${"x".repeat(48)}`;
    const existing = new Set([
      `${legacyBase}-2`,
      `${legacyBase}-2-dev-meta`,
      COLLECTIVE_BANK_ID,
    ]);
    expect(resolveProvisionedRepoBankId(slug, existing)).toBe(`${legacyBase}-2`);
  });

  test("WRITE-side still truncates to 50 for a 52-char slug (no legacy-52 write regression)", () => {
    const slug52 = `qds-${"y".repeat(48)}`; // 52 chars — the legacy cap
    expect(resolveRepoBankId(slug52, new Set())).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// M3.1: manager meta-bank family extended to dev + qa + maint (five targets)
// ---------------------------------------------------------------------------

describe("bank-provisioner: M3.1 five-target roster", () => {
  test("idempotent rerun over existing family → all five 'exists', five PUTs", async () => {
    // Server already has the full family; every PUT comes back 409 → every
    // target lands "exists", and the mock records all five PUT calls.
    const family = [
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-qa-meta",
      "qds-factory-maint-meta",
      COLLECTIVE_BANK_ID,
    ];
    const client = makeMockClient({
      existingBankIds: family,
      createBankThrows: () => new HindsightHttpError(409, "already exists", "r"),
    });
    const result = await provisionBanks({
      client,
      repoSlug: "QDS-Factory",
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks).toHaveLength(5);
    expect(result.banks.every((b) => b.status === "exists")).toBe(true);
    expect(client.createBank).toHaveBeenCalledTimes(5);
    for (const call of client.createBank.mock.calls) {
      expect(BankIdSchema.safeParse(call[0] as string).success).toBe(true);
    }
  });

  test("51-char slug passes the -32003 gate, truncates to 50, all five valid", async () => {
    // The pre-create gate only rejects invalid ids (cap 64); a 51-char base is
    // valid there and is truncated to MAX_BASE_LEN=50 downstream so every
    // manager meta variant stays ≤64.
    const slug51 = "d".repeat(51);
    const client = makeMockClient();
    const result = await provisionBanks({
      client,
      repoSlug: slug51,
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks).toHaveLength(5);
    expect(result.banks[0]!.bankId.length).toBe(50);
    for (const b of result.banks) {
      expect(BankIdSchema.safeParse(b.bankId).success).toBe(true);
    }
    expect(client.createBank).toHaveBeenCalledTimes(5);
  });

  test("MAX_BASE_LEN=50 corner: 50-char base + '-11' + '-maint-meta' = 64 exactly", async () => {
    // Behavior probe for the retuned constant: a 50-char base whose collision
    // loop reaches -11 mints ids of exactly 50+3+11=64 chars — schema-valid,
    // never 65. (MAX_BASE_LEN itself is module-private; this pins it.)
    const base50 = "e".repeat(50);
    const existing = [base50];
    for (let n = 2; n <= 10; n++) existing.push(`${base50}-${n}`);
    const client = makeMockClient({ existingBankIds: existing });
    const result = await provisionBanks({
      client,
      repoSlug: base50,
      bridgeProbe: HEALTHY,
      lockPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.banks[0]!.bankId).toBe(`${base50}-11`);
    expect(result.banks[3]!.bankId).toBe(`${base50}-11-maint-meta`);
    expect(result.banks[3]!.bankId.length).toBe(64);
    for (const b of result.banks) {
      expect(BankIdSchema.safeParse(b.bankId).success).toBe(true);
    }
  });
});
