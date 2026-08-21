/**
 * Fleet dispatch verb (Story DF3.1) — the factory's front door (D3, DD-1).
 *
 * Tested TypeScript with a schema at its ingress; a tier-1 agent invokes this
 * verb and never composes provider commands itself. The admission gates are
 * owned HERE (C1): driver.ts's `createRun` runs `checkHeadroom(1)` with no
 * skip option, so `{ admitted: true }` (DF3.2's fan-out seam) can only be
 * honoured by composing the lifecycle primitives directly. The post-admission
 * provisioning sequence (record → box) is the SAME `provisionAdmittedRun`
 * body `createRun` composes, so the INV-1 ordering invariant has a single
 * owner in the providers layer. No ceiling or limit is re-derived — DF2.6
 * owns the fleet ceiling, DF2.8 owns the per-issue cap, and this module owns
 * exactly the two call sites (AC7/AC8) plus the mapping of a refusal onto
 * exit 5.
 *
 * Ordering (INV-1/INV-3): validate → resolve → admit → record → box → key →
 * fill → setup gate → expose → ack. Everything that can refuse a brief on its
 * own contents — schema, wall-clock budget, manifest, roster — runs in the
 * validate step, BEFORE an admission is spent or a box exists (INV-2). The
 * public exposure is the LAST step, not part of provisioning: a box made
 * public before the gate proves it is reachable while unproven, and INV-5 then
 * forbids tearing it down.
 *
 * A rejected dispatch provisions nothing (INV-2); a failed gate — and every
 * other post-provision failure — leaves the record OPEN and the box ALIVE with
 * its debug and teardown commands printed (INV-5), because destroying the box
 * would discard the evidence. Every one of those exits takes the same route:
 * a `FleetError` with the exit code, a host-side dispatch-log entry, and one
 * structured log line (`refuse`, below).
 */
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import { appendDispatchFailure } from "../phase-engine/issue-correlation.ts";
import { isValidUuidV4, resolveRunCorrelation } from "../phase-engine/issue-correlation.ts";
import { CorrelationError } from "../phase-engine/issue-correlation.ts";
import { loadManifest, serializeManifest, stampManifestLimit } from "../phase-engine/manifest.ts";
import { fillRun, provisionAdmittedRun, type ProviderDriver } from "../providers/driver.ts";
import { mintRunKey, deliverRunKey, type KeyApi } from "../providers/credentials.ts";
import { assertWithinBudget, OverBudgetError } from "../providers/budget-gate.ts";
import { checkHeadroom, type LoadedQuotaLimits } from "../providers/quota.ts";
import { CostLedgerError } from "../providers/cost-ledger.ts";
import type { AdmissionDecision, CostLedger } from "../providers/cost-ledger.ts";
import { newId, assertValidRunId, type RunRecordStore } from "../providers/run-record.ts";
import { setupGate as realSetupGate, type SetupGateResult } from "../providers/exedev/setup-gate.ts";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "../swarmclaw/log.ts";
import { BriefSchema, extractZodErrorField, type Brief } from "./brief-schema.ts";

/**
 * Host-side dispatch-failure log (DF1.8's appendDispatchFailure target), at the
 * default run-record location. The path dispatch actually writes is derived
 * from `deps.store.dir`, so `--dir` moves the log with the records instead of
 * scattering refusals across an operator's real `.sandbox/`; with the default
 * store the two resolve to the same file.
 */
export const DISPATCH_FAILURE_LOG = ".sandbox/dispatch-log.jsonl";

/** The minted-runId shape — the only form `opts.runId` accepts (AC2). */
const MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

declare const mintedRunIdBrand: unique symbol;

/**
 * A run id that came out of `mintRunId()` — AC2's provenance, enforced by the
 * type system. Nominal, so a hand-written string of the right SHAPE is still not
 * one: `dispatch(brief, deps, { runId: "qds-20260101-abc123" })` does not
 * compile, which is the guarantee AC2 asks for and a regex can never give.
 *
 * The brand is the COMPILE-TIME half only. `MINTED_RUN_ID_RE` below stays,
 * because the callers that matter build their ids at runtime — the CLI from
 * argv, DF3.2's fan-out from its own arms — and a cast past the brand must still
 * be refused. Confined to this boundary on purpose: the providers layer takes
 * plain `string` run ids, and branding down there would spread a fleet concern
 * across every driver.
 */
export type MintedRunId = string & { readonly [mintedRunIdBrand]: true };

/**
 * `LogEntry.requestId` is a required string, but a refusal can fire before the
 * correlation resolves. Minting a UUID there would forge a correlation no other
 * row shares, so the absence is named instead.
 */
const UNRESOLVED_REQUEST_ID = "unresolved";

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

/**
 * Structural slice of CostLedger the budget gate reads — enough for DI fakes,
 * and derived from `CostLedger` itself so a fake cannot drift from the real
 * signatures the gate is compiled against (`as never` erased exactly that).
 */
export type LedgerLike = Pick<CostLedger, "config" | "admitIssue" | "close">;

export interface DispatchDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  /**
   * INV-1 manifest containment root — the trust anchor the brief's
   * `manifestPath` must resolve beneath. Defaults to `process.cwd()`.
   *
   * TRUSTED CONFIGURATION. It is safe here for the same reason `driver`,
   * `store` and `ledgerFactory` are: `DispatchDeps` is the injection surface
   * the CALLER controls, never a channel the brief can reach. No caller may
   * thread brief-derived data into it, directly or transitively — the brief is
   * the untrusted input, and a root computed from it (`dirname(manifestPath)`
   * being the obvious trap) makes every candidate its own root and the
   * beneath-root assertion vacuous.
   *
   * A seam, not a relaxation: the value is handed to the same `loadManifest`
   * check as before, which realpath-resolves it and refuses an unresolvable
   * root outright.
   */
  repoRoot?: string;
  /** Ledger factory — the ONLY way the budget gate touches storage. */
  ledgerFactory: () => LedgerLike;
  quotaLimits?: LoadedQuotaLimits;
  /** App port to expose; omit for none (httpsUrl then comes from create). */
  port?: number;
  /**
   * The already-resolved correlation id (INV-4-bis). The CLI parses the brief,
   * runs `resolveBriefRequestId` over it and builds the run-record store and
   * the driver with the result, so the record's and the driver's log lines
   * carry the SAME id as the ack. Absent ⇒ dispatch resolves it itself.
   */
  requestId?: string;
  /** Wall clock for the 600s ceiling (test seam). */
  clock?: () => number;
  /** Dispatch wall-clock ceiling in ms (default 600_000). */
  timeoutMs?: number;
  /** Host-side dispatch log; defaults beside the run-record dir, so `--dir` moves it. */
  dispatchLogPath?: string;
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
export function mintRunId(): MintedRunId {
  return newId("qds") as MintedRunId;
}

/**
 * The correlation id a parsed brief resolves to, by exactly the rule dispatch
 * applies: a strict UUID v4 `requestId` is honoured, anything else is dropped
 * so the resolver mints a fresh one (AC1 — a malformed id is not a validation
 * failure).
 *
 * Exported for the CLI, which must construct the run-record store and the
 * driver with the SAME id dispatch will report in its ack: minting one before
 * the brief is parsed makes the record's and the driver's log lines carry a
 * different correlation id from the ack (INV-4-bis). The parse is the CLI's;
 * the rule is this module's, and there is one copy of it.
 */
export function resolveBriefRequestId(parsedBrief: unknown): string | undefined {
  const supplied = (parsedBrief as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof supplied === "string" && isValidUuidV4(supplied) ? supplied : undefined;
}

/**
 * INV-6: management/deep-link URL parameters are redacted before logging.
 *
 * Redaction is scoped to URLs and applied WHOLE-SEGMENT: the query string and
 * fragment go entirely, and any path or host segment of 16+ characters goes
 * with them. The previous purely length-based rule (`[0-9a-zA-Z%-]{16,}`)
 * excluded `_` and `.` from its charset, so a token containing either was
 * split into sub-16-char pieces and logged raw. Prose around a URL is left
 * alone — an unreadable refusal message is not a security property.
 */
function redactUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    const cut = url.search(/[?#]/);
    const base = (cut === -1 ? url : url.slice(0, cut)).replace(/\/[^/]{16,}/g, "/«redacted»");
    return cut === -1 ? base : `${base}«redacted»`;
  });
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
 *
 * Probing stops at the first failure: `assertions` is the EXECUTED set, and
 * every later probe would report the state of a box already known unready.
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
        // Key-shape, not line-shape: `serializeManifest` emits JSON under the
        // `.yaml` filename (JSON is a YAML subset, and the repo's own loader
        // JSON.parses it), so an anchored `^limitMicroUsd:` matched neither
        // encoding once the writer settled. This matches both.
        const r = await driver.exec(vm, ["sh", "-c", `grep -qE '"?limitMicroUsd"?[[:space:]]*:' pipeline.yaml`]);
        return { ok: r.exitCode === 0, detail: r.exitCode === 0 ? "stamped" : "limitMicroUsd absent" };
      },
    },
    {
      item: "C",
      note: "delivered key env file is mode 600 (DF2.3 delivery contract)",
      run: async () => {
        // GNU stat, then BSD stat, then give up: the previous probe shelled out
        // to python3, so any box without an interpreter failed item C for a
        // reason that has nothing to do with the key's mode. `stat` is in
        // coreutils/BSD base on every substrate the factory targets.
        const r = await driver.exec(
          vm,
          ["sh", "-c", "stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo none"],
        );
        const mode = (r.stdout ?? "").trim();
        return { ok: mode === "600", detail: `mode ${mode || "unknown"}` };
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
        const r = await driver.exec(vm, ["sh", "-c", `grep -qE '"?phases"?[[:space:]]*:' pipeline.yaml`]);
        return { ok: r.exitCode === 0, detail: r.exitCode === 0 ? "present" : "absent" };
      },
    },
  ];
  const assertions: SetupGateResult["assertions"] = [];
  for (const probe of probes) {
    const { ok, detail } = await probe.run();
    assertions.push({ item: probe.item, ok, note: ok ? probe.note : `${probe.note} — ${detail}` });
    if (!ok) break;
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

/**
 * Does this driver carry exedev's `setup` primitive?
 *
 * The SAME predicate has to decide which gate runs AND where the key file
 * lands. Keyed off different things — gate on `setup`, key path on
 * `name === "fake"` — any driver that is neither exedev nor literally named
 * `"fake"` got the dir-box gate probing `.env` while its key went to
 * `/home/agent/.env`, so item C failed for every such driver by construction.
 */
function hasExedevSetup(driver: ProviderDriver): boolean {
  return typeof (driver as ProviderDriver & { setup?: unknown }).setup === "function";
}

/** Dir boxes are plain host dirs — the key lands box-relative, not /home/agent. */
function envFileFor(driver: ProviderDriver): string | undefined {
  return hasExedevSetup(driver) ? undefined : ".env";
}

/**
 * Does a record already exist for this id? `get` is the store's only reader;
 * absence is ENOENT on the typed code, and every other read failure is a real
 * problem that must not be read as "free to reuse".
 */
function recordExists(store: RunRecordStore, runId: string): boolean {
  try {
    store.get(runId);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Typed provider errors carry `code`/`remediation`; a bare throw carries neither. */
function errorCode(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : fallback;
}

function errorRemediation(e: unknown, fallback: string): string {
  const remediation = (e as { remediation?: unknown }).remediation;
  return typeof remediation === "string" ? remediation : fallback;
}

/**
 * Dispatch: validate → resolve → admit → record → box → key → fill → gate →
 * expose → ack.
 *
 * @throws {FleetError} exit 2 schema/correlation/manifest · exit 3 setup gate ·
 *     exit 5 admission refusal · exit 1 wall-clock expiry and post-provision
 *     infrastructure failure.
 */
export async function dispatch(
  brief: unknown,
  deps: DispatchDeps,
  opts: { admitted?: boolean; runId?: MintedRunId } = {},
): Promise<DispatchResult> {
  // One clock, both ends. Differencing an injected clock against a `Date.now()`
  // baseline makes the seam inert for every clock that is not a live-time
  // offset — the baseline has to come from the same source the comparison does.
  const now = (): number => deps.clock?.() ?? Date.now();
  const wallStart = now();
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const dispatchLog = deps.dispatchLogPath ?? join(dirname(deps.store.dir), "dispatch-log.jsonl");
  const timings: Record<string, number> = {};
  const phase = (name: string, ms: number): void => {
    timings[name] = ms;
  };

  // Refusal context: filled in as each fact becomes known. A refusal that fires
  // before a fact exists reports `null` for it — never `""`, never a fabricated
  // id (the observability contract).
  let ctxRequestId: string | null = deps.requestId ?? null;
  let ctxRepoSlug: string | null = null;
  let ctxIssueId: number | null = null;
  let ctxRunId: string | null = null;
  // biome-ignore lint/style/useConst: `refuse` reads this before the box exists
  let ctxVmName: string | undefined;
  let ctxGate: SetupGateResult | undefined;

  /**
   * The one exit path every refusal takes: host-side dispatch log (AC4), one
   * structured log line, and a `FleetError` carrying the operator's next
   * commands. INV-5 is why nothing here destroys anything — once a box exists,
   * a refusal names its teardown command and leaves it alive.
   *
   * INV-6 applies to the free text (`message`, and the issue/assertion detail),
   * not to the ids or the command lists: those are composed here from the run
   * id, and a redacted `teardownCommand` is an unrunnable one.
   */
  const refuse = (
    exitCode: 1 | 2 | 3 | 4 | 5,
    code: string,
    rawMessage: string,
    remediation: string,
    payload: Record<string, unknown> = {},
  ): FleetError => {
    const message = redactUrls(rawMessage);
    try {
      appendDispatchFailure(dispatchLog, {
        repoSlug: ctxRepoSlug,
        issueId: ctxIssueId,
        requestId: ctxRequestId,
        code,
        message,
      });
    } catch (e) {
      // The log must never mask the refusal it records — but swallowing it is
      // how AC4 evidence goes missing, so it is named on stderr (the fallback
      // appendDispatchFailure's own contract documents).
      process.stderr.write(`dispatch-log append to ${dispatchLog} failed (${code}): ${(e as Error).message}\n`);
    }
    const durationMs = now() - wallStart;
    log({
      requestId: ctxRequestId ?? UNRESOLVED_REQUEST_ID,
      operation: "fleet.dispatch",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "error",
      error: { code, message },
      runId: ctxRunId,
      verb: "dispatch",
      phase: "refused",
      // exit 1 is a timeout or a substrate failure — retryable, hence
      // "transient"; every other refusal is the brief's or the budget's own.
      exitStatus: (exitCode === 1 ? "transient" : "logic") as ExitStatus,
      ...timings,
    });
    return new FleetError(exitCode, code, message, remediation, {
      ...payload,
      runId: ctxRunId,
      ...(ctxVmName === undefined ? {} : { vmName: ctxVmName }),
      ...(ctxRunId === null
        ? {}
        : {
            debugCommands: ctxGate?.debugCommands ?? [`bun scripts/fleet.ts status ${ctxRunId}`],
            teardownCommand: ctxGate?.teardownCommand ?? `bun scripts/fleet.ts teardown ${ctxRunId}`,
          }),
    });
  };

  const remaining = (): number => timeoutMs - (now() - wallStart);
  const timedOut = (step: string): FleetError =>
    refuse(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${timeoutMs} ms at ${step}`,
      ctxRunId === null
        ? "raise timeoutMs, or retry when the substrate is responsive"
        : `tear the run down: bun scripts/fleet.ts teardown ${ctxRunId}`,
      { step },
    );

  /**
   * Bound one await against what is LEFT of the dispatch ceiling — sampling the
   * clock only between steps lets a single hung provider call run forever.
   *
   * ponytail: race-and-abandon. The provider seam exposes no AbortSignal, so an
   * expired await is abandoned, not cancelled — which is INV-5's posture
   * anyway (the box stays alive, the operator decides). A real cancel needs a
   * DF2.x driver-interface signal, the same change F2's deferred `driver.list`
   * timeout waits on.
   *
   * Abandoning makes the handler below the ONLY subscriber left on `work`.
   * Every call site evaluates its argument eagerly — `within("gate", gateFn(…))`
   * — so the provider call is already in flight when the deadline is checked,
   * and on the `left <= 0` path nothing ever subscribes to the race. A rejection
   * landing after that point was an UNHANDLED rejection: under the test runner
   * it was attributed to whichever test ran next and kept the process alive.
   *
   * The handler only reports; the timeout stays the thrown error. `abandoned`
   * keeps it silent on the ordinary path, where the race hands the failure to
   * dispatch and a second line would double-report it.
   */
  const within = async <T>(step: string, work: Promise<T>): Promise<T> => {
    let abandoned = false;
    void work.catch((e: unknown) => {
      if (!abandoned) return;
      const durationMs = now() - wallStart;
      try {
        log({
          requestId: ctxRequestId ?? UNRESOLVED_REQUEST_ID,
          operation: "fleet.dispatch",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: durationMs,
          durationMs,
          status: "error",
          // Secondary to the timeout that was already thrown: the abandoned
          // provider call failed too, which is what an operator needs to see
          // when the timeout alone does not explain the run.
          error: { code: "abandoned-step-failed", message: redactUrls((e as Error)?.message ?? String(e)) },
          runId: ctxRunId,
          verb: "dispatch",
          phase: "abandoned",
          step,
          exitStatus: "transient" as ExitStatus,
        });
      } catch {
        // a throwing log sink must not become the unhandled rejection this
        // handler exists to prevent
      }
    });
    const left = remaining();
    if (left <= 0) {
      abandoned = true;
      throw timedOut(step);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            reject(timedOut(step));
          }, left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // ── 1. validate (INV-2: before ANY side effect) ─────────────────────────────
  // The dispatch ceiling is the manifest loader's `callerBudgetMs` and this
  // function's own wall clock; a non-positive one can be satisfied by nothing.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw refuse(
      2,
      "timeout-invalid",
      `timeoutMs must be a positive integer of milliseconds, got ${timeoutMs}`,
      "omit timeoutMs for the 600_000 ms default, or pass a positive integer",
    );
  }
  if (deps.port !== undefined && (!Number.isInteger(deps.port) || deps.port < 1 || deps.port > 65_535)) {
    throw refuse(
      2,
      "port-invalid",
      `port must be an integer in 1..65535, got ${deps.port}`,
      "pass a real TCP port, or omit --port and take the box's own URL",
    );
  }

  const tValidate = now();
  const parsed = BriefSchema.safeParse(brief);
  phase("validate_ms", now() - tValidate);
  if (!parsed.success) {
    const field = extractZodErrorField(parsed.error);
    throw refuse(
      2,
      "invalid-brief",
      `brief rejected: field ${JSON.stringify(field)}`,
      `fix or remove ${field} in the brief JSON`,
      {
        field,
        issues: parsed.error.issues.map((i) =>
          redactUrls(`${i.path.join(".") || "(root)"}: ${i.message}`),
        ),
      },
    );
  }
  const valid: Brief = parsed.data;
  ctxRepoSlug = valid.repoSlug;
  ctxIssueId = valid.issueId;

  // ── 2. resolve correlation (CC-9/AC2: malformed requestId mints fresh) ─────
  // AC1: a non-UUID-v4 requestId is NOT a validation failure — it is dropped so
  // the resolver mints a fresh one; the resolved value is what downstream sees.
  // A caller that already resolved it (the CLI, which needs the id to build the
  // store and the driver) hands it back through deps.requestId, and the
  // resolver still validates it — one id, one shape check, INV-4-bis.
  const { requestId: suppliedRequestId, ...briefRest } = valid;
  const briefIn =
    deps.requestId !== undefined
      ? { ...briefRest, requestId: deps.requestId }
      : suppliedRequestId !== undefined && !isValidUuidV4(suppliedRequestId)
        ? briefRest
        : valid;
  let correlation: ReturnType<typeof resolveRunCorrelation>;
  try {
    correlation = resolveRunCorrelation(briefIn);
  } catch (e) {
    if (e instanceof CorrelationError) {
      throw refuse(2, e.code, e.message, "fix the brief field the code names", { code: e.code });
    }
    throw e;
  }
  const requestId = correlation.requestId;
  ctxRequestId = requestId;
  const resolvedMs = now() - wallStart;
  log({
    requestId,
    operation: "fleet.dispatch",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: resolvedMs,
    durationMs: resolvedMs,
    status: "ok",
    runId: null,
    issueUrl: correlation.issueUrl,
    verb: "dispatch",
    phase: "resolved",
    exitStatus: "success" as ExitStatus,
  });

  // ── 3. manifest + roster (INV-2: pure validation, so it belongs HERE) ──────
  // Loading the manifest at fill time meant a manifest defect was discovered
  // after a box, a key and a URL already existed — every input needed to refuse
  // was available at step 1.
  //
  // The containment root is the REPO, not `dirname(manifestPath)`: a root
  // derived from the candidate path makes every path its own root and the
  // beneath-root assertion vacuous. callerBudgetMs: the dispatch wall clock IS
  // the upstream ceiling — the engine never assumes one, and a manifest whose
  // runBudgetMs exceeds the dispatch ceiling must refuse here, not mid-run.
  //
  // `deps.repoRoot` and nothing else: an ambient `process.cwd()` makes the trust
  // anchor of a security guard depend on where the process happened to start.
  // The default keeps every existing caller (the CLI passes none) on cwd.
  // `loadManifest` realpaths it and refuses an unresolvable root, so no
  // resolution is repeated here — a second copy would be the weaker one
  // (manifest.ts avoids Bun's `realpathSync`, which hangs on a planted FIFO).
  const repoRoot = deps.repoRoot ?? process.cwd();
  const manifestPath = resolve(valid.manifestPath);
  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(manifestPath, timeoutMs, repoRoot);
  } catch (e) {
    throw refuse(
      2,
      "manifest-rejected",
      `manifest rejected: ${(e as Error).message}`,
      `fix the manifest, or point manifestPath at one beneath ${repoRoot}`,
      { manifestPath },
    );
  }
  // The exedev gate reads the ACTIVE roster beside the manifest. Its absence is
  // a defect in the brief, not a gate outcome, so it refuses before a box
  // exists rather than as a failed assertion on a live box (INV-5 would then
  // forbid tearing that box down). Only checked where that gate will actually
  // run: an injected gate and a dir box never read a roster.
  const rosterPath = join(dirname(manifestPath), "roster.yaml");
  if (deps.setupGate === undefined && hasExedevSetup(deps.driver) && !existsSync(rosterPath)) {
    throw refuse(
      2,
      "roster-missing",
      `no roster beside the manifest: ${rosterPath}`,
      "place the active roster at that path, or point manifestPath at a directory that has one",
      { rosterPath },
    );
  }

  // ── 4. runId (dispatcher-owned; AC2 opts.runId only accepts minted ids) ────
  // `MintedRunId` already refuses a caller-invented literal at compile time; the
  // shape check is for the ids that are built at runtime and cast in (the CLI,
  // DF3.2's fan-out), where the brand cannot see them.
  let runId: string;
  if (opts.runId !== undefined) {
    if (!MINTED_RUN_ID_RE.test(opts.runId)) {
      throw refuse(
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
  ctxRunId = runId;
  // A re-dispatch under an id that already has a record books the issue's cap a
  // SECOND time and then dies on a bare EEXIST from store.create — after the
  // reservation is committed. Refuse before the admission, not after it.
  if (opts.runId !== undefined && recordExists(deps.store, runId)) {
    throw refuse(
      2,
      "run-id-in-use",
      `run ${runId} already has a record`,
      `omit runId for a fresh one, or tear the existing run down: bun scripts/fleet.ts teardown ${runId}`,
    );
  }

  // ── 5. admission (AC7/AC8 — both BEFORE store.create/driver.create) ────────
  // AC8: skipped only under { admitted: true } (DF3.2's single checkHeadroom(N)).
  if (opts.admitted !== true) {
    const headroom = await within("headroom", checkHeadroom(deps.driver, 1, deps.quotaLimits));
    if (!headroom.allowed) {
      throw refuse(
        5,
        "no-headroom",
        `refusing dispatch: ${headroom.reason ?? "headroom"} — live ${headroom.liveVms}/${headroom.ceiling}, headroom ${headroom.headroom}`,
        "wait for a slot (fleet status), tear a run down, or raise the ceiling in the quota limits",
        { reason: headroom.reason, liveVms: headroom.liveVms, ceiling: headroom.ceiling, headroom: headroom.headroom },
      );
    }
  }
  // AC7: budget admission always runs (a single dispatch is not exempt). The
  // ledger is constructed INSIDE the try: an unopenable or busy ledger is an
  // admission refusal (exit 5), not an untyped exit 1 (INV-COST-6 — a ledger
  // that cannot be read is never read as zero spend).
  let ledger: LedgerLike | undefined;
  let decision: Extract<AdmissionDecision, { admitted: true }>;
  try {
    ledger = deps.ledgerFactory();
    decision = assertWithinBudget(ledger as CostLedger, {
      repoSlug: valid.repoSlug,
      issueId: String(valid.issueId),
      runId,
      requestId,
    });
  } catch (e) {
    if (e instanceof OverBudgetError) {
      throw refuse(5, "budget-exceeded", e.message, e.remediation, {
        code: e.code,
        capMicroUsd: e.capMicroUsd,
        spentMicroUsd: e.spentMicroUsd,
        reservedMicroUsd: e.reservedMicroUsd,
        unpricedRows: e.unpricedRows,
      });
    }
    if (e instanceof CostLedgerError) {
      throw refuse(5, e.code, e.message, e.remediation);
    }
    throw e;
  } finally {
    try {
      ledger?.close();
    } catch {
      // a close failure must not mask the gate's own outcome
    }
  }
  // AC9b: the ONE ceiling — DF2.8 computed min(keyCap, remaining); propagate.
  const effectiveCeilingMicros = decision.admittedCeilingMicroUsd;
  // A zero ceiling is an admission that buys nothing: the mint refuses a
  // non-positive cap and the manifest stamp rejects 0, so the run would exist,
  // bill box-hours and be unable to spend a micro-dollar. That is a refusal
  // (exit 5), not a provisioning step.
  if (!Number.isInteger(effectiveCeilingMicros) || effectiveCeilingMicros <= 0) {
    throw refuse(
      5,
      "no-ceiling",
      `admitted ceiling is ${effectiveCeilingMicros} µ$ — the run could not spend anything`,
      `raise the cap via .sandbox/cost-config.json perIssueOverrides for ${valid.repoSlug}#${valid.issueId}, or pick another issue`,
      {
        admittedCeilingMicroUsd: effectiveCeilingMicros,
        capMicroUsd: decision.capMicroUsd,
        spentMicroUsd: decision.spentMicroUsd,
        reservedMicroUsd: decision.reservedMicroUsd,
      },
    );
  }

  // ── 6. record → box (INV-3: record → box → key, enforced by construction).
  // The sequence is provisionAdmittedRun — the same body createRun composes —
  // so the record-before-VM invariant cannot drift between the two callers.
  //
  // The gap between the admission above and this call — admitIssue's COMMIT to
  // store.create's rename, two processes with no shared lock — is CLOSED, on
  // the ledger side, by `ADMISSION_GRACE_MS` (cost-ledger.ts): its orphan guard
  // counts an admission younger than the grace window toward `reservedMicroUsd`
  // whether or not the run record resolves yet, so a concurrent dispatch for the
  // same issue sees this reservation from the instant it commits. Two dispatches
  // can no longer both be granted the full remaining headroom. Do not "fix" this
  // with a ledger/store transaction or a global dispatch lock — the first is
  // unnecessary now and the second would serialise DF3.2's N-arm fan-out.
  //
  // Still keep this gap short: the grace window is a floor on how long a
  // genuinely orphaned reservation (store.create failed, so no run can ever
  // report spend) holds the issue's cap. Distinct from the post-provision case
  // below, where the reservation is retained deliberately and for as long as the
  // box lives.
  const tCreate = now();
  const { vm } = await within(
    "create",
    provisionAdmittedRun(deps.driver, deps.store, {
      runId,
      // `port` is deliberately withheld: provisionAdmittedRun exposes and makes
      // the box PUBLIC immediately after create, i.e. before the setup gate has
      // proved anything — and INV-5 then forbids tearing that box down. The
      // expose/setPublic pair runs here instead, after gate.ready (step 10).
      budget: {
        repoSlug: valid.repoSlug,
        issueId: String(valid.issueId),
        capMicroUsd: decision.capMicroUsd,
        spentMicroUsd: decision.spentMicroUsd,
        reservedMicroUsd: decision.reservedMicroUsd,
        admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd,
      },
    }),
  );
  phase("create_ms", now() - tCreate);
  ctxVmName = vm.name;

  // Everything past this point runs with a billable box alive. INV-5: no
  // failure here destroys it — each one is converted into a FleetError that
  // names the debug and teardown commands, logs its dispatch-failure entry and
  // leaves the record OPEN, exactly as the gate failure does.
  //
  // The issue's reservation stays OUTSTANDING on these paths, and that is the
  // correct figure — not a leak, and nothing here should be "fixed" to release
  // it. `admitIssue` counts a reservation until a priced `cost_event` lands for
  // the run (its `NOT EXISTS (… cost_events … unpriced = 0)` clause), and a run
  // that dies past this point still has a LIVE box billing box-hours and — once
  // step 7 has run — a key live at the FULL admitted ceiling, because INV-5
  // keeps both alive so an operator can diagnose the failure. The exposure is
  // real, so the reservation that represents it must stay against the issue's
  // cap; it retires when teardown closes the record and the box-hours row is
  // priced. A compensating release here would under-report live risk and let a
  // second dispatch overcommit the same cap.
  let httpsUrl: string | undefined = vm.httpsUrl;
  try {
    // INV-4-bis: the correlation id is the cross-layer join key, so it has to be
    // ON the record — `fleet status` is the operator's only inspection surface,
    // and a run that dies at the gate is exactly the one whose logs they need to
    // find. First write after provisioning, so every later failure path still
    // leaves a joinable record. Not best-effort: a store that cannot take this
    // write is a real failure, and the catch below turns it into a typed exit 1
    // with the box left alive (INV-5).
    deps.store.set(runId, { requestId });

    // ── 7. key (INV-4: plaintext exists in the mint return and nowhere else) ─
    const tMint = now();
    const credEnvFile = envFileFor(deps.driver);
    const { key } = await within(
      "mint",
      mintRunKey(
        {
          keyApi: deps.keyApi,
          driver: deps.driver,
          store: deps.store,
          requestId,
          capMicroUsd: effectiveCeilingMicros,
          ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
        },
        runId,
      ),
    );
    await within(
      "deliver",
      deliverRunKey(
        {
          keyApi: deps.keyApi,
          driver: deps.driver,
          store: deps.store,
          requestId,
          ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
        },
        vm.name,
        key,
      ),
    );
    phase("mint_ms", now() - tMint);

    // ── 8. fill at the pinned SHA (AC9a: manifest is the cap's only carrier) ─
    const tFill = now();
    const stamped = stampManifestLimit(loaded, effectiveCeilingMicros);
    // AC9: the manifest is the cap's only in-box source (9a); the run context
    // carries the same computed-once ceiling for DF1.6's spawn seam (9b), plus
    // the issue deep link the brief supplied — the box's own back-reference to
    // the issue that authorized it.
    const files = [
      { path: "pipeline.yaml", content: serializeManifest(stamped) },
      {
        path: "run-context.json",
        content: JSON.stringify({
          runId,
          pipelineId: stamped.manifest.pipelineId,
          requestId,
          effectiveCeilingMicros,
          repoSlug: correlation.repoSlug,
          issueId: correlation.issueId,
          ...(correlation.issueUrl === null ? {} : { issueUrl: correlation.issueUrl }),
        }),
      },
    ];
    const exedevFill = (deps.driver as ProviderDriver & { fill?: unknown }).fill;
    if (typeof exedevFill === "function") {
      // exedev: clone the repo at the pinned SHA first, then place the manifest.
      await within(
        "clone",
        (exedevFill as (vm: string, o: Record<string, string>) => Promise<unknown>).call(
          deps.driver,
          vm.name,
          { runId, repoUrl: valid.repoUrl, commitSha: valid.commitSha },
        ),
      );
    }
    await within("fill", fillRun(deps.driver, vm.name, files));
    phase("fill_ms", now() - tFill);

    // ── 9. setup gate (AC3: failure keeps record open, box alive — INV-5) ────
    const tGate = now();
    const gateFn =
      deps.setupGate ??
      ((drv: ProviderDriver, box: string, o: GateOpts) => {
        if (hasExedevSetup(drv)) {
          return realSetupGate(drv as never, box, {
            runId: o.runId,
            rosterPath,
            commitSha: o.commitSha,
          } as Parameters<typeof realSetupGate>[2]);
        }
        return fakeGate(drv, box, o);
      });
    const gate: SetupGateResult = await within(
      "gate",
      gateFn(deps.driver, vm.name, { runId, commitSha: valid.commitSha, requestId }),
    );
    phase("setup_gate_ms", now() - tGate);
    ctxGate = gate;
    if (!gate.ready) {
      // AC3: the refusal is recorded on the RUN RECORD as well as host-side —
      // an operator reading `fleet status` must see why the run is open. The
      // record stays open and the box alive (INV-5); the write is best-effort
      // because the host-side dispatch log inside `refuse` is the authoritative
      // copy and must not be pre-empted by a record-write failure.
      try {
        deps.store.set(runId, {
          extensions: {
            gate: {
              outcome: "failed",
              failedItem: gate.failedItem ?? "unknown",
              assertionCode: gate.assertionCode ?? 0,
              failedAt: new Date().toISOString(),
            },
          },
        });
      } catch (e) {
        process.stderr.write(`gate outcome not recorded on run ${runId}: ${(e as Error).message}\n`);
      }
      throw refuse(
        3,
        "setup-gate-failed",
        `setup gate failed at item ${gate.failedItem ?? "?"}: ${gate.assertions.find((a) => !a.ok)?.note ?? ""}`,
        `debug: ${gate.debugCommands.join("; ")} — teardown when done: ${gate.teardownCommand}`,
        {
          assertionCode: gate.assertionCode,
          failedItem: gate.failedItem,
          assertions: gate.assertions.map((a) => redactUrls(`${a.item}:${a.ok ? "ok" : a.note}`)),
        },
      );
    }
    // The ceiling was never sampled after the gate — the single longest await
    // in the whole dispatch — so a run could ack "ready" well past its budget.
    if (remaining() <= 0) throw timedOut("gate");

    // ── 10. expose (INV-5 ordering: PUBLIC only once the gate has proved it) ─
    if (deps.port !== undefined) {
      httpsUrl = await within("expose", deps.driver.expose(vm.name, deps.port));
      await within("setPublic", deps.driver.setPublic(vm.name));
      deps.store.set(runId, {
        ...(httpsUrl === undefined ? {} : { httpsUrl }),
        ports: [deps.port],
      });
    }
  } catch (e) {
    if (e instanceof FleetError) throw e;
    throw refuse(
      1,
      errorCode(e, "dispatch-failed"),
      `dispatch failed after the box was created: ${(e as Error).message}`,
      errorRemediation(
        e,
        "the run record is OPEN and the box is ALIVE (INV-5) — inspect it, then tear it down",
      ),
    );
  }

  // ── 11. ack (AC2: synchronous, "provisioned", never "succeeded") ───────────
  const durationMs = now() - wallStart;
  log({
    requestId,
    operation: "fleet.dispatch",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: durationMs,
    durationMs,
    status: "ok",
    runId,
    issueUrl: correlation.issueUrl,
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
