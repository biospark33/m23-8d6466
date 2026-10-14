/**
 * M2.2 (DD-16) — the dispatch memory-key provision leg, pinned at the REAL
 * `dispatch()` call site (immediately after the provider-key leg), not a copy
 * of it. The leg under test mints the per-run recall-only memory key through
 * the M2.1 gateway and delivers the DD-28.23 env pair
 * (`QDS_KG_RECALL_KEY` + `QDS_KG_GATEWAY_URL`) by APPENDING it to the
 * PROVIDER key's own env file — the one file the box sources (unit
 * EnvironmentFile → resident CHILD_ENV_ALLOWLIST):
 *   (1) happy path — a per-run ledger row (run_id-bound, recall-only verbs,
 *       24h TTL backstop) plus the pair landed after the provider entry in
 *       that same file (append, not truncate), key material on stdin only —
 *       never argv, never a log line (D8/INV-4 posture);
 *   (2) gateway env absent — ONE `memgate-skip` line, zero ledger rows, zero
 *       delivery, dispatch otherwise untouched (memory is an optional lane at
 *       dispatch; the in-box `no-auth` refusal is the visible failure mode);
 *   (3) delivery failure AFTER a successful mint — INV-MG-2 compensation:
 *       revoke + verify-revoked land, the ORIGINAL error is what dispatch
 *       refuses with, and the provider key had already completed;
 *   (4) ordering — the memory leg runs strictly AFTER the provider-key
 *       delivery and before the fill, inside the suite's record → box → key →
 *       fill → gate chain;
 *   (5) bank-allowlist provenance — the minted claims banks ARE the M1.2
 *       dispatch-time recall fan-out set for this repo, computed here with the
 *       SAME source functions (bank-provisioner's family-signature resolver +
 *       `qds-collective`), never a scheme invented at the mint site.
 *
 * The memgate ledger is REAL (sqlite on a per-suite tmpdir); the bank list is
 * injected through `DispatchDeps.memoryBankList` (no network); the clock is
 * fixed through `deps.clock`. Env save/delete/restore is total: the memgate
 * vars must never leak out of (or into) a test, and HINDSIGHT_* is deleted so
 * no config-present case can fall through to a real client.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/lib/log.ts";
import { FleetError, fakeGate, dispatch, type DispatchDeps } from "../../src/fleet/dispatch.ts";
import { goodLedger } from "./helpers.ts";
import { MemgateLedger } from "../../src/memgate/ledger.ts";
import { DEFAULT_KEY_TTL_BACKSTOP_MS } from "../../src/memgate/schemas.ts";
import {
  COLLECTIVE_BANK_ID,
  extractExistingBankIds,
  resolveProvisionedRepoBankId,
} from "../../src/hindsight/bank-provisioner.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";

/**
 * Every env var the leg touches (read or resolve-through). HINDSIGHT_* is
 * deleted rather than set: a config-present test without an injected bank
 * list must not fall through to a REAL client against the developer's env.
 */
const ENV_KEYS = [
  "MEMGATE_ADMIN_KEY",
  "QDS_MEMGATE_SIGNING_KEY",
  "QDS_KG_GATEWAY_URL",
  "QDS_MEMGATE_LEDGER",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const GATEWAY_URL = "http://127.0.0.1:8099";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "qds-m22-dispatch-memory-")));
const memRoot = realpathSync(mkdtempSync(join(tmpdir(), "qds-m22-memgate-")));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(memRoot, { recursive: true, force: true });
});

/** One captured stdin-bearing `sh -c` delivery (provider or memory). */
interface ShDelivery {
  vm: string;
  argv: string[];
  script: string;
  stdin?: string;
}

describe("dispatch memory-key provision leg (M2.2 / DD-16)", () => {
  let dir: string;
  let memDir: string;
  let ledgerPath: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let entries: LogEntry[] = [];
  let restoreLog: (() => void) | undefined;
  /** Every `umask 077` delivery the driver ran, provider and memory alike. */
  let deliveries: ShDelivery[] = [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    memDir = realpathSync(mkdtempSync(join(memRoot, "ledger-")));
    ledgerPath = join(memDir, "ledger.db");
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    entries = [];
    deliveries = [];
    restoreLog = setLogSink((e) => {
      entries.push(e);
    });
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MEMGATE_ADMIN_KEY = "test-admin-not-a-secret";
    process.env.QDS_MEMGATE_SIGNING_KEY = "test-signing-not-a-secret";
    process.env.QDS_KG_GATEWAY_URL = GATEWAY_URL;
    process.env.QDS_MEMGATE_LEDGER = ledgerPath;
  });

  afterEach(() => {
    restoreLog?.();
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  });

  // ─── fixtures (mirror tests/fleet/dispatch.test.ts) ─────────────────────────

  const MANIFEST_REL = join("manifests", "pipeline.json");

  function validBrief(): Record<string, unknown> {
    const manifestPath = join(dir, MANIFEST_REL);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "code", description: "Draft the approach", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the tests", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );
    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
    };
  }

  /** Fixed wall clock: deterministic ledger timestamps, ceiling never reached. */
  const FIXED_NOW = 1_800_000_000_000;

  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      clock: () => FIXED_NOW,
      // The bank list is injected, never the real client: this suite pins the
      // WIRING, not Hindsight itself.
      memoryBankList: { listBanks: async () => bankListResult() },
      ...overrides,
    };
  }

  /**
   * The live bank list shape the family-signature resolver consumes: the
   * `owner/repo` provision-time pair (base + `-dev-meta` sibling — the pair
   * only the provisioner creates).
   */
  function bankListResult(): unknown {
    return { banks: ["owner-repo", "owner-repo-dev-meta"] };
  }

  /** Tag every stdin-bearing `sh -c` delivery, provider and memory apart. */
  function captureDeliveries(): void {
    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const script = argv[2] ?? "";
      if (argv[0] === "sh" && script.startsWith("umask 077")) {
        deliveries.push({ vm, argv, script, stdin });
      }
      return originalExec(vm, argv, stdin);
    };
  }

  // Both deliveries now write the SAME env file (the provider key's), so the
  // discriminator is the payload: the memory stdin is "\n" + the recall-key
  // entry (the append-fusion guard below), the provider's leads with
  // OPENROUTER_API_KEY.
  const memoryDeliveries = (): ShDelivery[] =>
    deliveries.filter((d) => d.stdin?.startsWith("\nQDS_KG_RECALL_KEY="));
  const providerDeliveries = (): ShDelivery[] =>
    deliveries.filter((d) => !d.stdin?.startsWith("\nQDS_KG_RECALL_KEY="));

  const openLedger = (): MemgateLedger => new MemgateLedger(ledgerPath);

  // ─── (1) happy path ──────────────────────────────────────────────────────────

  test("config present → per-run ledger row + box env file with EXACTLY the DD-28.23 pair, key on stdin only", async () => {
    captureDeliveries();
    const result = await dispatch(validBrief(), deps());
    expect(result.state).toBe("ready");

    // The mint: ONE per-run row, run_id-bound, recall-only, TTL backstop.
    const ledger = openLedger();
    const rows = ledger.listIssued("per-run");
    expect(rows).toHaveLength(1);
    const row = rows[0] as { token_id: string; run_id: string | null; claims_json: string; expires_at_ms: number | null; created_at_ms: number };
    expect(row.run_id).toBe(result.runId);
    const claims = JSON.parse(row.claims_json) as { runId: string; banks: string[]; verbs: string[]; expiresAtMs: number };
    expect(claims.runId).toBe(result.runId);
    expect(claims.verbs).toEqual(["recall"]);
    expect(row.expires_at_ms).not.toBeNull();
    expect((row.expires_at_ms as number) - row.created_at_ms).toBe(DEFAULT_KEY_TTL_BACKSTOP_MS);

    // The delivery: one memory exec AFTER the provider key's, stdin channel.
    expect(memoryDeliveries()).toHaveLength(1);
    expect(providerDeliveries()).toHaveLength(1);
    const mem = memoryDeliveries()[0] as ShDelivery;
    expect(mem.vm).toBe(result.vmName);
    // argv carries ONLY the fixed script — the pair rides stdin (D8).
    expect(mem.argv).toHaveLength(3);
    expect(mem.argv[0]).toBe("sh");
    expect(mem.argv[1]).toBe("-c");

    // EXACTLY the DD-28.23 pair, in the canonical order, nothing else.
    const lines = String(mem.stdin).split("\n");
    expect(lines[lines.length - 1]).toBe(""); // trailing newline
    expect(lines[0]).toBe(""); // LEADING newline: the append must never fuse with the provider payload's last line, even if that payload ever loses its trailing newline (a blank line is ignored by shell sourcing and systemd EnvironmentFile alike)
    const entriesInFile = lines.filter((l) => l !== "");
    expect(entriesInFile.map((l) => l.slice(0, l.indexOf("=")))).toEqual([
      "QDS_KG_RECALL_KEY",
      "QDS_KG_GATEWAY_URL",
    ]);
    const recall = entriesInFile[0] as string;
    expect(recall.startsWith("QDS_KG_RECALL_KEY=mgrun-")).toBe(true);
    expect(entriesInFile[1]).toBe(`QDS_KG_GATEWAY_URL=${GATEWAY_URL}`);

    // The pair LANDED in the PROVIDER key's own env file — the one file the
    // box sources (unit EnvironmentFile → resident allowlist) — APPENDED after
    // the provider entry (a truncate here would have eaten it), mode 600.
    const boxFile = join(driver.root, result.vmName, ".env");
    expect(existsSync(boxFile)).toBe(true);
    const provider = providerDeliveries()[0] as ShDelivery;
    expect(readFileSync(boxFile, "utf8")).toBe(`${String(provider.stdin)}${String(mem.stdin)}`);
    expect((statSync(boxFile).mode & 0o777).toString(8)).toBe("600");

    // Key material NEVER in argv and NEVER in a log line (D8 / INV-4 posture).
    const keyMaterial = recall.slice("QDS_KG_RECALL_KEY=".length);
    for (const d of deliveries) {
      for (const a of d.argv) expect(a.includes(keyMaterial)).toBe(false);
    }
    expect(JSON.stringify(entries).includes(keyMaterial)).toBe(false);
  });

  // ─── (2) config absent ───────────────────────────────────────────────────────

  test("MEMGATE_ADMIN_KEY absent → ONE memgate-skip line, zero rows, zero delivery, dispatch continues", async () => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.MEMGATE_ADMIN_KEY;
    captureDeliveries();
    const result = await dispatch(validBrief(), deps());
    expect(result.state).toBe("ready");

    const skips = entries.filter((e) => e.event === "memgate-skip");
    expect(skips).toHaveLength(1);
    const skip = skips[0] as LogEntry & { reason?: string; runId?: string };
    // F-008: the shared kebab grammar, not the raw var name.
    expect(skip.reason).toBe("env-absent");
    expect(skip.runId).toBe(result.runId);
    expect(skip.requestId).toBe(result.requestId);

    expect(openLedger().listIssued()).toHaveLength(0);
    expect(memoryDeliveries()).toHaveLength(0);
  });

  // ─── (2b) F-005: a pre-mint grammar refusal is a REFUSAL, never a skip ─────

  test("gateway URL with a space → env-file-invalid refusal (NOT a kg-banks-unresolved skip), no ledger row", async () => {
    // F-007/F-008 grammar: a URL whose value could inject env entries. F-005:
    // the config assert is PRE-ADMISSION (beside the manifest/roster
    // validation, review round) AND re-checked pre-mint in the leg, so the
    // refusal fires while NO key exists and — the pre-admission point — BEFORE
    // a billable box is provisioned. It propagates to dispatch's key-failure
    // handling: the same treatment a provider-key delivery failure gets.
    process.env.QDS_KG_GATEWAY_URL = "http://127.0.0.1:8099 /injected=1";
    captureDeliveries();
    let boxesCreated = 0;
    const originalCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      boxesCreated += 1;
      return originalCreate(name, tag);
    };
    let refused: unknown;
    try {
      await dispatch(validBrief(), deps());
      refused = undefined;
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(FleetError);
    expect((refused as FleetError).message).toContain("is not a plain http(s) URL");
    // Never a skip: the refusal pre-dates the banks resolution AND the mint.
    expect(entries.filter((e) => e.event === "memgate-skip")).toHaveLength(0);
    expect(openLedger().listIssued()).toHaveLength(0);
    // Pre-admission: neither delivery ran, and no box was ever created — the
    // position's entire point.
    expect(memoryDeliveries()).toHaveLength(0);
    expect(providerDeliveries()).toHaveLength(0);
    expect(boxesCreated).toBe(0);
  });

  // ─── (3) delivery failure → INV-MG-2 compensation ────────────────────────────

  test("memory delivery throws → revoke+verify land, the ORIGINAL error is what dispatch refuses with", async () => {
    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const script = argv[2] ?? "";
      if (argv[0] === "sh" && script.startsWith("umask 077")) {
        deliveries.push({ vm, argv, script, stdin });
        if (stdin?.startsWith("\nQDS_KG_RECALL_KEY=")) {
          throw new Error("memory delivery exploded (synthetic)");
        }
      }
      return originalExec(vm, argv, stdin);
    };

    let refused: unknown;
    try {
      await dispatch(validBrief(), deps());
      refused = undefined;
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(FleetError);
    // The ORIGINAL delivery error — not a compensation error, not the generic
    // text alone.
    expect((refused as FleetError).message).toContain("memory delivery exploded (synthetic)");
    const refusalLines = entries.filter((e) => e.operation === "fleet.dispatch" && e.phase === "refused");
    expect(refusalLines).toHaveLength(1);

    // The provider key had already completed BEFORE the memory leg failed.
    expect(providerDeliveries()).toHaveLength(1);

    // Compensation ran: the minted row is revoked and PROVEN revoked.
    const ledger = openLedger();
    const rows = ledger.listIssued("per-run");
    expect(rows).toHaveLength(1);
    const row = rows[0] as { token_id: string };
    expect(ledger.isRevoked(row.token_id)).toBe(true);
    const events = entries.map((e) => e.event);
    expect(events).toContain("memgate-revoke");
    expect(events).toContain("memgate-verify-revoked");
  });

  // ─── (4) ordering: after the provider key, before the fill ───────────────────

  test("memory leg runs strictly AFTER the provider-key delivery, before the fill (call-order capture)", async () => {
    const callOrder: string[] = [];
    const originalCreate = store.create.bind(store);
    store.create = (runId: string) => {
      callOrder.push("store.create");
      return originalCreate(runId);
    };
    const originalDriverCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      callOrder.push("driver.create");
      return originalDriverCreate(name, tag);
    };
    const originalMint = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      callOrder.push("mint");
      return originalMint(name, limit);
    };
    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (argv[0] === "sh") {
        const script = argv[2] ?? "";
        if (script.startsWith("umask 077")) {
          callOrder.push(stdin?.startsWith("\nQDS_KG_RECALL_KEY=") ? "memory-deliver" : "deliver");
        } else if (argv.at(-1) === "src/.qds/pipeline.yaml") callOrder.push("fill:pipeline.yaml");
        else if (argv.at(-1) === "src/.qds/run-context.json") callOrder.push("fill:run-context.json");
      }
      return originalExec(vm, argv, stdin);
    };

    await dispatch(
      validBrief(),
      deps({
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    // The INV-1 chain with the memory leg slotted between the provider-key
    // delivery and the manifest fill — an equality, not a subsequence (same
    // discipline as the suite's own ordering pin), truncated at the gate.
    expect(callOrder).toContain("gate");
    expect(callOrder.slice(0, callOrder.indexOf("gate") + 1)).toEqual([
      "store.create",
      "driver.create",
      "mint",
      "deliver",
      "memory-deliver",
      "fill:pipeline.yaml",
      "fill:run-context.json",
      "gate",
    ]);
  });

  // ─── (5) bank-allowlist provenance ───────────────────────────────────────────

  test("minted claims banks ARE the M1.2 fan-out set, derived by the SAME source functions", async () => {
    await dispatch(validBrief(), deps());

    const row = openLedger().listIssued("per-run")[0] as { claims_json: string } | undefined;
    expect(row).toBeDefined();

    // Recomputed HERE with the kg-context source itself (recallFanOut's set:
    // family-signature repo bank + qds-collective) — never a mint-side scheme.
    const existing = extractExistingBankIds(bankListResult());
    const repoBankId = resolveProvisionedRepoBankId(resolveBankId("owner/repo"), existing);
    expect(repoBankId).not.toBe(null); // non-degenerate: the fixture family resolves
    const expected = [...new Set([repoBankId as string, COLLECTIVE_BANK_ID])];
    expect(expected).toEqual(["owner-repo", "qds-collective"]);

    const claims = JSON.parse((row as { claims_json: string }).claims_json) as { banks: string[] };
    expect(claims.banks).toEqual(expected);
  });
});
