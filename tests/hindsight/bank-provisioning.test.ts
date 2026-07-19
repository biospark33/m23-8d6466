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
  type BridgeProbe,
  type ProvisionClient,
  type ProvisionResult,
} from "../../src/hindsight/bank-provisioner.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";

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
    expect(ids).toEqual(["qds-factory", "qds-factory-dev-meta", COLLECTIVE_BANK_ID]);
    expect(result.banks.every((b) => b.status === "created")).toBe(true);
    expect(client.createBank).toHaveBeenCalledTimes(3);
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
    expect(ids).toEqual(["qds-factory-2", "qds-factory-2-dev-meta", COLLECTIVE_BANK_ID]);
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
    // createBank was still called 3 times (idempotent PUT).
    expect(client.createBank).toHaveBeenCalledTimes(3);
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
    expect(firstCallCount).toBe(3);
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
    expect(result.banks).toHaveLength(3);
    expect(client.createBank).toHaveBeenCalledTimes(3);
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
    expect(result.banks).toHaveLength(3);
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
    expect(provisionLogs.length).toBe(3);
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
    // which the provisioner truncates to 52 (so `-dev-meta` AND a collision
    // suffix both fit). If that 52-char truncated form collides in listBanks,
    // the suffix loop runs and returns `<truncated>-2`, which must itself be
    // schema-valid, and `<truncated>-2-dev-meta` must also be schema-valid.
    const slug64 = "a".repeat(64);
    const truncatedBase = "a".repeat(52);
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
    // createBank was called 3 times with valid ids only.
    expect(client.createBank).toHaveBeenCalledTimes(3);
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
    // Base truncated to 52 chars max so `-dev-meta` (9) + worst-case collision
    // suffix ("-11", 3) both still fit within the 64-char schema cap.
    const repoBankId = result.banks[0]!.bankId;
    const devMetaId = result.banks[1]!.bankId;
    expect(repoBankId.length).toBe(52);
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
    expect(ids).toEqual(["qds-factory", "qds-factory-dev-meta", COLLECTIVE_BANK_ID]);
    // 3 idempotent PUTs.
    expect(client.createBank).toHaveBeenCalledTimes(3);
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
  test("base near cap, collision loop reaches -11 → repoBankId-dev-meta valid", async () => {
    // 60-char slug → truncated to 52 (safeBase). Pre-populate existing banks
    // with safeBase AND safeBase-2..safeBase-10 so the loop falls through to
    // the LAST candidate (safeBase-11). Then `${safeBase}-11-dev-meta` must
    // still satisfy BankIdSchema (52 + "-11" + "-dev-meta" = 64).
    const safeBase = "c".repeat(52);
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
    expect(repoBankId).toBe(`${safeBase}-11`);
    expect(repoBankId.length).toBe(55); // 52 + len("-11")
    expect(devMetaId).toBe(`${repoBankId}-dev-meta`);
    // The load-bearing assertion: dev-meta id is exactly at the 64-char cap
    // and still parses. Pre-fix this overflowed to 65 → createBank 422 mid-loop.
    expect(devMetaId.length).toBe(64);
    expect(BankIdSchema.safeParse(devMetaId).success).toBe(true);
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
