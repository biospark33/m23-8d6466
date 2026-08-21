/**
 * Fleet dispatch verb (Story DF3.1) — the factory's front door (D3, DD-1).
 *
 * Tested TypeScript with a schema at its ingress; a tier-1 agent invokes this
 * verb and never composes provider commands itself. The sequence below mirrors
 * DF2.1's `createRun` body with the admission gates owned HERE (C1): driver.ts
 * is not editable by this story and its internal `checkHeadroom(1)` has no
 * skip option, so `{ admitted: true }` (DF3.2's fan-out seam) can only be
 * honoured by composing the lifecycle primitives directly. No ceiling or limit
 * is re-derived — DF2.6 owns the fleet ceiling, DF2.8 owns the per-issue cap,
 * and this module owns exactly the two call sites (AC7/AC8) plus the mapping
 * of a refusal onto exit 5.
 *
 * Ordering (INV-1/INV-3): validate → resolve → admit → record → box → key →
 * fill → setup gate → ack. A rejected dispatch provisions nothing (INV-2);
 * a failed gate leaves the record OPEN and the box ALIVE with its debug and
 * teardown commands printed (INV-5) — destroying the box would discard the
 * evidence.
 */
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import { appendDispatchFailure } from "../phase-engine/issue-correlation.ts";
import { isValidUuidV4, resolveRunCorrelation } from "../phase-engine/issue-correlation.ts";
import { CorrelationError } from "../phase-engine/issue-correlation.ts";
import { loadManifest, serializeManifest, stampManifestLimit } from "../phase-engine/manifest.ts";
import { SBX_OWNERSHIP_TAG, fillRun, type ProviderDriver, type ProviderVm } from "../providers/driver.ts";
import { mintRunKey, deliverRunKey, type KeyApi } from "../providers/credentials.ts";
import { assertWithinBudget, OverBudgetError } from "../providers/budget-gate.ts";
import { checkHeadroom, type LoadedQuotaLimits } from "../providers/quota.ts";
import type { AdmissionDecision, CostConfig, CostLedger } from "../providers/cost-ledger.ts";
import { newId, assertValidRunId, type RunRecordStore } from "../providers/run-record.ts";
import { setupGate as realSetupGate, type SetupGateResult } from "../providers/exedev/setup-gate.ts";
import { dirname, join } from "node:path";
import { log } from "../swarmclaw/log.ts";
import { BriefSchema, extractZodErrorField, type Brief } from "./brief-schema.ts";

/** Host-side dispatch-failure log (DF1.8's appendDispatchFailure target). */
export const DISPATCH_FAILURE_LOG = ".sandbox/dispatch-log.jsonl";

/** The minted-runId shape — the only form `opts.runId` accepts (AC2). */
const MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * Typed refusal surfacing. `src/` throws; the CLI (`scripts/fleet.ts`) maps
 * `exitCode` onto the process exit and prints the payload. One code, one
 * meaning (F3 — this CLI's own table, never P1.6's).
 */
export class FleetError extends Error {
  constructor(
    public readonly exitCode: 1 | 2 | 3 | 4 | 5,
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FleetError";
  }
}

/** Structural slice of CostLedger the budget gate reads — enough for DI fakes. */
export interface LedgerLike {
  readonly config: CostConfig;
  admitIssue(
    input: Parameters<CostLedger["admitIssue"]>[0],
    capMicroUsd: number,
    keyCapMicroUsd: number,
  ): AdmissionDecision;
  close(): void;
}

export interface DispatchDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  /** Ledger factory — the ONLY way the budget gate touches storage. */
  ledgerFactory: () => LedgerLike;
  quotaLimits?: LoadedQuotaLimits;
  /** App port to expose; omit for none (httpsUrl then comes from create). */
  port?: number;
  /** Wall clock for the 600s ceiling (test seam). */
  clock?: () => number;
  /** Dispatch wall-clock ceiling in ms (default 600_000). */
  timeoutMs?: number;
  /** Setup-gate seam (test/injection). Default: exedev `.setup`, else fakeGate. */
  setupGate?: (driver: ProviderDriver, vm: string, opts: GateOpts) => Promise<SetupGateResult>;
}

export interface GateOpts {
  runId: string;
  commitSha: string;
  requestId: string;
}

export interface DispatchResult {
  runId: string;
  requestId: string;
  state: "ready";
  vmName: string;
  httpsUrl?: string;
}

/** The dispatcher mints the runId — callers never invent one (AC2, §5.3). */
export function mintRunId(): string {
  return newId("qds");
}

/**
 * INV-6: management/deep-link URL parameters are redacted before logging. The
 * regex is deliberately broad (`[0-9a-zA-Z%-]{16,}`) to cover encoding drift.
 */
function redactUrls(text: string): string {
  return text.replace(/([0-9a-zA-Z%-]{16,})/g, "«redacted»");
}

/** Assertion code table mirrors DF2.2's ASSERTION_CODE (A/B share 1). */
const FAKE_ASSERTION_CODE: Record<"A" | "B" | "C" | "D" | "E", 1 | 2 | 3 | 4> = {
  A: 1,
  B: 1,
  C: 2,
  D: 3,
  E: 4,
};

/**
 * The fake-substrate setup gate: five REAL probes of the box's on-disk state,
 * one per DF2.2 assertion item. Not a simulated pass — every item executes a
 * command in the box and reports what it found. The exedev gate stays the
 * authoritative five-assertion gate; this is its dir-box counterpart.
 * Exported for tests and for any caller that needs the dir-box gate directly.
 */
export async function fakeGate(
  driver: ProviderDriver,
  vm: string,
  opts: GateOpts,
): Promise<SetupGateResult> {
  const probes: { item: "A" | "B" | "C" | "D" | "E"; note: string; run: () => Promise<{ ok: boolean; detail: string }> }[] = [
    {
      item: "A",
      note: "box reachable (exec true)",
      run: async () => {
        const r = await driver.exec(vm, ["true"]);
        return { ok: r.exitCode === 0, detail: `exit ${r.exitCode}` };
      },
    },
    {
      item: "B",
      note: "frozen manifest carries limitMicroUsd (AC9a refuse-if-absent)",
      run: async () => {
        const r = await driver.exec(vm, ["sh", "-c", "grep -q '^limitMicroUsd:' pipeline.yaml"]);
        return { ok: r.exitCode === 0, detail: r.exitCode === 0 ? "stamped" : "limitMicroUsd absent" };
      },
    },
    {
      item: "C",
      note: "delivered key env file is mode 600 (DF2.3 delivery contract)",
      run: async () => {
        const r = await driver.exec(
          vm,
          ["sh", "-c", "python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' .env 2>/dev/null || echo none"],
        );
        const mode = r.stdout.trim();
        return { ok: mode === "600", detail: `mode ${mode}` };
      },
    },
    {
      item: "D",
      note: "manifest content non-empty",
      run: async () => {
        const r = await driver.exec(vm, ["sh", "-c", "test -s pipeline.yaml"]);
        return { ok: r.exitCode === 0, detail: r.exitCode === 0 ? "non-empty" : "empty/missing" };
      },
    },
    {
      item: "E",
      note: "manifest declares a phases list (DF1.1 schema shape)",
      run: async () => {
        const r = await driver.exec(vm, ["sh", "-c", "grep -q '^phases:' pipeline.yaml"]);
        return { ok: r.exitCode === 0, detail: r.exitCode === 0 ? "present" : "absent" };
      },
    },
  ];
  const assertions: SetupGateResult["assertions"] = [];
  for (const probe of probes) {
    const { ok, detail } = await probe.run();
    assertions.push({ item: probe.item, ok, note: ok ? probe.note : `${probe.note} — ${detail}` });
  }
  const firstFail = assertions.find((a) => !a.ok);
  return {
    ready: firstFail === undefined,
    ...(firstFail !== undefined
      ? { failedItem: firstFail.item, assertionCode: FAKE_ASSERTION_CODE[firstFail.item] }
      : {}),
    assertions,
    debugCommands: [`bun scripts/fleet.ts status ${opts.runId}`],
    teardownCommand: `bun scripts/fleet.ts teardown ${opts.runId}`,
    vm,
  };
}

/** Fake boxes are plain host dirs — the key lands box-relative, not /home/agent. */
function envFileFor(driver: ProviderDriver): string | undefined {
  return driver.name === "fake" ? ".env" : undefined;
}

/**
 * Dispatch: validate → resolve → admit → record → box → key → fill → gate → ack.
 *
 * @throws {FleetError} exit 2 schema/correlation · exit 3 setup gate ·
 *     exit 5 admission refusal · exit 1 wall-clock expiry.
 */
export async function dispatch(
  brief: unknown,
  deps: DispatchDeps,
  opts: { admitted?: boolean; runId?: string } = {},
): Promise<DispatchResult> {
  const wallStart = Date.now();
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const expired = (): boolean => (deps.clock?.() ?? Date.now()) - wallStart >= timeoutMs;
  const timings: Record<string, number> = {};
  const phase = (name: string, ms: number): void => {
    timings[name] = ms;
  };

  // ── 1. validate (INV-2: before ANY side effect) ─────────────────────────────
  const tValidate = Date.now();
  const parsed = BriefSchema.safeParse(brief);
  phase("validate_ms", Date.now() - tValidate);
  let valid: Brief;
  if (!parsed.success) {
    const field = extractZodErrorField(parsed.error);
    throw new FleetError(
      2,
      "invalid-brief",
      `brief rejected: field ${JSON.stringify(field)}`,
      `fix or remove ${field} in the brief JSON`,
      { field, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) },
    );
  }
  valid = parsed.data;

  // ── 2. resolve correlation (CC-9/AC2: malformed requestId mints fresh) ─────
  // AC1: a non-UUID-v4 requestId is NOT a validation failure — it is dropped so
  // the resolver mints a fresh one; the resolved value is what downstream sees.
  const { requestId: suppliedRequestId, ...briefRest } = valid;
  const briefIn =
    suppliedRequestId !== undefined && !isValidUuidV4(suppliedRequestId) ? briefRest : valid;
  let correlation: ReturnType<typeof resolveRunCorrelation>;
  try {
    correlation = resolveRunCorrelation(briefIn);
  } catch (e) {
    if (e instanceof CorrelationError) {
      throw new FleetError(2, e.code, e.message, "fix the brief field the code names", {
        code: e.code,
      });
    }
    throw e;
  }
  const requestId = correlation.requestId;
  log({
    requestId,
    operation: "fleet.dispatch",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: 0,
    status: "ok",
    runId: null,
    verb: "dispatch",
    phase: "resolved",
    exitStatus: "success" as ExitStatus,
  });

  // ── 3. runId (dispatcher-owned; AC2 opts.runId only accepts minted shapes) ─
  let runId: string;
  if (opts.runId !== undefined) {
    if (!MINTED_RUN_ID_RE.test(opts.runId)) {
      throw new FleetError(
        2,
        "run-id-not-minted",
        `opts.runId ${JSON.stringify(opts.runId)} is not a dispatcher-minted id`,
        "omit runId and let dispatch mint one, or pass a value from mintRunId()",
      );
    }
    assertValidRunId(opts.runId);
    runId = opts.runId;
  } else {
    runId = mintRunId();
  }

  // ── 4. admission (AC7/AC8 — both BEFORE store.create/driver.create) ────────
  // AC8: skipped only under { admitted: true } (DF3.2's single checkHeadroom(N)).
  if (opts.admitted !== true) {
    const headroom = await checkHeadroom(deps.driver, 1, deps.quotaLimits);
    if (!headroom.allowed) {
      throw new FleetError(
        5,
        "no-headroom",
        `refusing dispatch: ${headroom.reason ?? "headroom"} — live ${headroom.liveVms}/${headroom.ceiling}, headroom ${headroom.headroom}`,
        "wait for a slot (fleet status), tear a run down, or raise the ceiling in the quota limits",
        { reason: headroom.reason, liveVms: headroom.liveVms, ceiling: headroom.ceiling, headroom: headroom.headroom },
      );
    }
  }
  // AC7: budget admission always runs (a single dispatch is not exempt).
  const ledger = deps.ledgerFactory();
  let decision: { admittedCeilingMicroUsd: number; capMicroUsd: number; spentMicroUsd: number; reservedMicroUsd: number };
  try {
    decision = assertWithinBudget(ledger as never, {
      repoSlug: valid.repoSlug,
      issueId: String(valid.issueId),
      runId,
      requestId,
    });
  } catch (e) {
    if (e instanceof OverBudgetError) {
      throw new FleetError(
        5,
        "budget-exceeded",
        e.message,
        e.remediation,
        {
          code: e.code,
          capMicroUsd: e.capMicroUsd,
          spentMicroUsd: e.spentMicroUsd,
          reservedMicroUsd: e.reservedMicroUsd,
          unpricedRows: e.unpricedRows,
        },
      );
    }
    throw e;
  } finally {
    try {
      ledger.close();
    } catch {
      // a close failure must not mask the gate's own outcome
    }
  }
  // AC9b: the ONE ceiling — DF2.8 computed min(keyCap, remaining); propagate.
  const effectiveCeilingMicros = decision.admittedCeilingMicroUsd;

  // ── 5. record (INV-3: record → box → key, enforced by construction) ────────
  const tMint = Date.now();
  deps.store.create(runId);
  deps.store.set(runId, {
    extensions: {
      budget: {
        repoSlug: valid.repoSlug,
        issueId: String(valid.issueId),
        capMicroUsd: decision.capMicroUsd,
        spentMicroUsd: decision.spentMicroUsd,
        reservedMicroUsd: decision.reservedMicroUsd,
        admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd,
      },
    },
  });
  phase("mint_ms", Date.now() - tMint);

  // ── 6. box ──────────────────────────────────────────────────────────────────
  const tCreate = Date.now();
  const vm: ProviderVm = await deps.driver.create(runId, SBX_OWNERSHIP_TAG);
  phase("create_ms", Date.now() - tCreate);
  if (expired()) {
    throw new FleetError(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${timeoutMs} ms after box creation`,
      `tear the run down: bun scripts/fleet.ts teardown ${runId}`,
      { runId, vmName: vm.name },
    );
  }
  let httpsUrl = vm.httpsUrl;
  const patch: { vmName: string; httpsUrl?: string; ports?: number[] } = { vmName: vm.name };
  if (httpsUrl !== undefined) patch.httpsUrl = httpsUrl;
  if (deps.port !== undefined) {
    httpsUrl = await deps.driver.expose(vm.name, deps.port);
    await deps.driver.setPublic(vm.name);
    patch.httpsUrl = httpsUrl;
    patch.ports = [deps.port];
  }
  deps.store.set(runId, patch);

  // ── 7. key (INV-4: plaintext exists in the mint return and nowhere else) ───
  const credEnvFile = envFileFor(deps.driver);
  const { key } = await mintRunKey(
    {
      keyApi: deps.keyApi,
      driver: deps.driver,
      store: deps.store,
      requestId,
      capMicroUsd: effectiveCeilingMicros,
      ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
    },
    runId,
  );
  await deliverRunKey(
    {
      keyApi: deps.keyApi,
      driver: deps.driver,
      store: deps.store,
      requestId,
      ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
    },
    vm.name,
    key,
  );
  if (expired()) {
    throw new FleetError(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${timeoutMs} ms after key delivery`,
      `tear the run down: bun scripts/fleet.ts teardown ${runId}`,
      { runId, vmName: vm.name },
    );
  }

  // ── 8. fill at the pinned SHA (AC9a: manifest is the cap's only carrier) ──
  const tFill = Date.now();
  // callerBudgetMs: the dispatch wall clock IS the upstream ceiling — the
  // engine never assumes one, and a manifest whose runBudgetMs exceeds the
  // dispatch ceiling must refuse here, not mid-run. runRoot: the manifest's
  // own directory — dispatch reads whatever host path the operator names; the
  // loader's fd-verified beneath-root read is the containment that matters.
  const loaded = loadManifest(valid.manifestPath, timeoutMs, dirname(valid.manifestPath));
  const stamped = stampManifestLimit(loaded, effectiveCeilingMicros);
  // AC9: the manifest is the cap's only in-box source (9a); the run context
  // carries the same computed-once ceiling for DF1.6's spawn seam (9b).
  const files = [
    { path: "pipeline.yaml", content: serializeManifest(stamped) },
    {
      path: "run-context.json",
      content: JSON.stringify({
        runId,
        pipelineId: stamped.manifest.pipelineId,
        requestId,
        effectiveCeilingMicros,
      }),
    },
  ];
  const exedevFill = (deps.driver as ProviderDriver & { fill?: unknown }).fill;
  if (typeof exedevFill === "function") {
    // exedev: clone the repo at the pinned SHA first, then place the manifest.
    await (exedevFill as (vm: string, o: Record<string, string>) => Promise<unknown>).call(
      deps.driver,
      vm.name,
      { runId, repoUrl: valid.repoUrl, commitSha: valid.commitSha },
    );
  }
  await fillRun(deps.driver, vm.name, files);
  phase("fill_ms", Date.now() - tFill);
  if (expired()) {
    throw new FleetError(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${timeoutMs} ms after fill`,
      `tear the run down: bun scripts/fleet.ts teardown ${runId}`,
      { runId, vmName: vm.name },
    );
  }

  // ── 9. setup gate (AC3: failure keeps record open, box alive — INV-5) ──────
  const tGate = Date.now();
  const rosterPath = join(dirname(valid.manifestPath), "roster.yaml");
  const gateFn =
    deps.setupGate ??
    ((drv: ProviderDriver, box: string, o: GateOpts) => {
      const maybeSetup = (drv as ProviderDriver & { setup?: unknown }).setup;
      if (typeof maybeSetup === "function") {
        return realSetupGate(drv as never, box, {
          runId: o.runId,
          rosterPath,
          commitSha: o.commitSha,
        } as Parameters<typeof realSetupGate>[2]);
      }
      return fakeGate(drv, box, o);
    });
  const gate: SetupGateResult = await gateFn(deps.driver, vm.name, {
    runId,
    commitSha: valid.commitSha,
    requestId,
  });
  phase("setup_gate_ms", Date.now() - tGate);
  if (!gate.ready) {
    // Failure recorded host-side (no extensions namespace exists for the gate;
    // the run record stays open and the dispatch log carries the code).
    try {
      appendDispatchFailure(DISPATCH_FAILURE_LOG, {
        repoSlug: valid.repoSlug,
        issueId: valid.issueId,
        requestId,
        code: "setup-gate-failed",
        message: `item ${gate.failedItem ?? "?"} (code ${gate.assertionCode ?? "?"}) — ${redactUrls(gate.assertions.map((a) => `${a.item}:${a.ok ? "ok" : a.note}`).join(" "))}`,
      });
    } catch {
      // the log must never mask the gate's own failure
    }
    log({
      requestId,
      operation: "fleet.dispatch",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: Date.now() - wallStart,
      status: "error",
      error: { code: "setup-gate-failed", message: `item ${gate.failedItem ?? "?"}` },
      runId,
      verb: "dispatch",
      phase: "gate",
      exitStatus: "logic" as ExitStatus,
      ...timings,
    });
    throw new FleetError(
      3,
      "setup-gate-failed",
      `setup gate failed at item ${gate.failedItem ?? "?"}: ${gate.assertions.find((a) => !a.ok)?.note ?? ""}`,
      `debug: ${gate.debugCommands.join("; ")} — teardown when done: ${gate.teardownCommand}`,
      {
        assertionCode: gate.assertionCode,
        failedItem: gate.failedItem,
        runId,
        vmName: vm.name,
        debugCommands: gate.debugCommands,
        teardownCommand: gate.teardownCommand,
      },
    );
  }

  // ── 10. ack (AC2: synchronous, "provisioned", never "succeeded") ───────────
  log({
    requestId,
    operation: "fleet.dispatch",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: Date.now() - wallStart,
    status: "ok",
    runId,
    verb: "dispatch",
    phase: "ready",
    exitStatus: "success" as ExitStatus,
    httpsUrl: httpsUrl === undefined ? undefined : redactUrls(httpsUrl),
    ...timings,
  });
  return {
    runId,
    requestId,
    state: "ready",
    vmName: vm.name,
    ...(httpsUrl === undefined ? {} : { httpsUrl }),
  };
}
