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
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * `setTimeout` clamps a delay past the 32-bit signed max to 1 ms, so a ceiling
 * above this is not a long ceiling — it is the SHORTEST possible one, and the
 * first step times out immediately. A request to lengthen the budget must not
 * invert into the opposite.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * How many times a self-minted run id is re-minted past a record collision.
 * `newId("qds")` is 24 bits per day, so a collision is rare but real, and it
 * lands in exactly the orphaned-reservation-then-EEXIST state the collision
 * guard exists to prevent. Nobody chose the id, so re-minting is the right
 * answer; a bound keeps a saturated run directory from spinning.
 */
const MINT_RETRIES = 4;

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
 * The run-id grammar as an exit-2 refusal — the ONE fleet-side enforcement
 * point (`scripts/fleet.ts`'s verbs and `statusRun` both route through here).
 *
 * The grammar itself is the record store's and is never restated: composing
 * `RUN_ID_RE`/`RUN_ID_MAX` locally gave every entry point its own copy, so
 * tightening the store's rule (it moved to the RFC 1123 label grammar in this
 * story) silently left the CLI accepting a different set of ids than
 * `scripts/sandbox-teardown.ts`, which delegates. `assertValidRunId`'s message
 * already names the pattern and the cap, so the operator loses nothing.
 */
export function assertFleetRunId(runId: unknown): asserts runId is string {
  try {
    assertValidRunId(runId);
  } catch (e) {
    throw new FleetError(2, "invalid-run-id", errorMessage(e), "run ids come from `fleet dispatch`; list them with `fleet status`");
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
 * fragment go entirely, EVERY path segment after the host goes with them, and a
 * host segment of 16+ characters goes too (a long host label is itself a deep
 * link on the substrates the factory uses). Length is not a property of a
 * secret: the previous rule redacted only 16+ character segments, so
 * `https://exe.xyz/vm/abc123token` reached the dispatch log intact. The scheme
 * and host survive because an operator has to recognise WHICH box the line is
 * about; prose around a URL is left alone — an unreadable refusal message is
 * not a security property.
 */
function redactUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    const cut = url.search(/[?#]/);
    const base = cut === -1 ? url : url.slice(0, cut);
    const pathAt = base.indexOf("/", base.indexOf("://") + 3);
    const host = pathAt === -1 ? base : base.slice(0, pathAt);
    const path = pathAt === -1 ? "" : base.slice(pathAt);
    const out = host.replace(/\/[^/]{16,}/g, "/«redacted»") + path.replace(/\/[^/]+/g, "/«redacted»");
    return cut === -1 ? out : `${out}«redacted»`;
  });
}

/**
 * INV-6 over a whole refusal payload: every string leaf, walking arrays and
 * plain objects.
 *
 * Redaction used to be a per-call-site convention — `refuse` redacted only
 * `message`, and each caller was expected to remember `redactUrls` on the
 * strings it put in the payload and on the remediation. A convention a caller
 * has to remember is one a caller eventually forgets, and the ones that forgot
 * (`errorRemediation` on a provider throw, the gate's `debug: … teardown …`
 * string) were exactly the paths carrying third-party free text. Applied once,
 * at the choke point.
 *
 * ponytail: no cycle guard. Every payload in this module is a locally built
 * object literal of primitives, arrays and literals — there is nowhere for a
 * cycle to come from. Add one if a payload ever carries a caller's object.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactUrls(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
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
 * "The command never ran at all", told apart from "the command ran and failed".
 *
 * `ExecResult.exitCode` is DECLARED `number`, but it crosses a driver boundary:
 * a signal-killed child carries Node's `null`, and 127 is `/bin/sh`'s own
 * command-not-found. Folded into the ordinary arms, both were reported as a
 * MANIFEST problem ("manifest unreadable (grep exit 127)") — sending the
 * operator to inspect a file when the box is the thing that is broken. Takes
 * `unknown` because the declared type has no overlap with `null`.
 */
function substrateFailure(exitCode: unknown): string | undefined {
  if (exitCode === null || exitCode === undefined) {
    return "the box did not run the probe (killed by a signal) — a substrate failure, not a manifest one";
  }
  if (exitCode === 127) {
    return "exit 127: `sh` or the probe command is not on the box — the probe never ran";
  }
  return undefined;
}

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
  /**
   * The box's manifest, read ONCE by item B and inspected structurally by B, D
   * and E. `serializeManifest` writes `JSON.stringify(…, null, 2)` under the
   * `.yaml` filename, so the host can parse it rather than grep it — and B/E
   * previously used unanchored, unscoped greps, which AC9a's "refuse if absent"
   * was satisfied by a `limitMicroUsd` inside an env-var name, a comment or a
   * nested object. Anchoring was not available: the writer emits one JSON
   * document, not one key per line.
   */
  let manifest: Record<string, unknown> | undefined;

  const probes: { item: "A" | "B" | "C" | "D" | "E"; note: string; run: () => Promise<{ ok: boolean; detail: string }> }[] = [
    {
      item: "A",
      note: "box reachable (exec true)",
      run: async () => {
        const r = await driver.exec(vm, ["true"]);
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate };
        return { ok: r.exitCode === 0, detail: `exit ${r.exitCode}` };
      },
    },
    {
      item: "B",
      note: "frozen manifest carries a root-level limitMicroUsd (AC9a refuse-if-absent)",
      run: async () => {
        const r = await driver.exec(vm, ["sh", "-c", "cat pipeline.yaml 2>/dev/null"]);
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate };
        const body = (r.stdout ?? "").trim();
        // This probe runs before item D, so it has to name BOTH of its own
        // failures: a manifest that never landed and a manifest that landed
        // unstamped are opposite diagnoses — one sends the operator to the fill
        // step, the other to the stamping step.
        if (body.length === 0) return { ok: false, detail: "pipeline.yaml missing or empty" };
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return { ok: false, detail: `pipeline.yaml is not parseable: ${errorMessage(e)}` };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, detail: "pipeline.yaml is not a manifest object" };
        }
        manifest = parsed as Record<string, unknown>;
        return manifest.limitMicroUsd === undefined
          ? { ok: false, detail: "limitMicroUsd absent" }
          : { ok: true, detail: "stamped" };
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
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate };
        const mode = (r.stdout ?? "").trim();
        return { ok: mode === "600", detail: `mode ${mode || "unknown"}` };
      },
    },
    {
      item: "D",
      // CONTENT, never presence — the dir-box counterpart of DF2.2's item D,
      // which inspects the cost table's content rather than trusting a field
      // name. This item used to re-test "manifest non-empty", which item B's
      // own first arm has already proved by the time D runs: it could not fail,
      // so DF2.2's five-assertion gate was effectively four.
      note: "stamped limitMicroUsd is a spendable positive integer",
      run: async () => {
        const limit = manifest?.limitMicroUsd;
        return Number.isSafeInteger(limit) && (limit as number) > 0
          ? { ok: true, detail: `${limit as number} µ$` }
          : {
              ok: false,
              detail: `limitMicroUsd is ${JSON.stringify(limit)}, not a positive integer of micro-dollars`,
            };
      },
    },
    {
      item: "E",
      note: "manifest declares a non-empty phases list (DF1.1 schema shape)",
      run: async () => {
        const phases = manifest?.phases;
        return Array.isArray(phases) && phases.length > 0
          ? { ok: true, detail: `${phases.length} phases` }
          : { ok: false, detail: "no non-empty root-level phases list" };
      },
    },
  ];
  const assertions: SetupGateResult["assertions"] = [];
  for (const probe of probes) {
    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await probe.run();
    } catch (e) {
      // A rejecting `driver.exec` — SSH transport failure, dead box — used to
      // discard every assertion accumulated so far and escape as a generic
      // exit-1 "dispatch failed after the box was created", costing the
      // operator the per-item evidence the exit-3 envelope carries.
      outcome = { ok: false, detail: errorMessage(e) };
    }
    const { ok, detail } = outcome;
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
 *
 * A type PREDICATE, so the narrowed driver goes into `realSetupGate` as itself.
 * The call site used to launder it through `as never` — the very cast
 * `LedgerLike` was introduced to eliminate — which switched off checking on the
 * gate's driver argument entirely.
 */
function hasExedevSetup(
  driver: ProviderDriver,
): driver is ProviderDriver & Parameters<typeof realSetupGate>[0] {
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
    if ((e as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * The one way this module turns a caught value into operator-facing text.
 *
 * `throw` takes any value, and a driver, key API or store is third-party code
 * from this module's point of view: `throw null` and `throw "boom"` are both
 * legal. A bare `(e as Error).message` read on those throws a TypeError from
 * inside the catch block, which replaces the real refusal — the diagnosis the
 * operator needs — with an unrelated crash out of the error path itself.
 */
function errorMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : String(e);
}

/**
 * The provider's own `code`, as a PAYLOAD fragment — never as the FleetError's
 * code.
 *
 * The module header holds "one code, one meaning (F3 — this CLI's own table)".
 * Reading a caught error's `.code` straight into `FleetError.code` broke that:
 * `provision-failed` became `EACCES`/`ECONNRESET`/`SQLITE_BUSY` depending on
 * which infrastructure failed, so an operator grepping the dispatch log for the
 * fleet code missed every real failure of that step. The fleet code stays
 * fixed and the provider's goes here, where it is diagnosis rather than
 * classification. Absent when the throw carried none — an absent code is named
 * by omission, not by a fabricated fallback.
 *
 * Typed provider errors carry `code`/`remediation`; a bare throw carries
 * neither — and a `null`/`undefined` throw carries no properties to read at
 * all, so the access itself is optional (see `errorMessage`).
 */
function providerCodePayload(e: unknown): { providerCode?: string } {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? { providerCode: code } : {};
}

function errorRemediation(e: unknown, fallback: string): string {
  const remediation = (e as { remediation?: unknown } | null | undefined)?.remediation;
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
  // `resolve` FIRST: `dirname("runs")` is `"."`, so a bare relative store dir
  // (`new RunRecordStore({dir:"runs"})`, or `QDS_RUNS_DIR=runs`) put the AC4
  // refusal evidence in whatever the process cwd happened to be. The basename
  // comes from `DISPATCH_FAILURE_LOG` so the documented default and the
  // computed one cannot drift — the constant was exported and never read.
  const dispatchLog =
    deps.dispatchLogPath ?? join(dirname(resolve(deps.store.dir)), basename(DISPATCH_FAILURE_LOG));
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
   * The box's URL, as soon as one is known. On the refusal payload as well as
   * the ack: a failure between `expose` and the record write leaves a box that
   * is PUBLIC and reachable while the record carries neither `httpsUrl` nor
   * `ports`, and a payload carrying only `vmName` told the operator a public box
   * existed with no way to learn its address.
   */
  let ctxHttpsUrl: string | undefined;

  /**
   * The one exit path every refusal takes: host-side dispatch log (AC4), one
   * structured log line, and a `FleetError` carrying the operator's next
   * commands. INV-5 is why nothing here destroys anything — once a box exists,
   * a refusal names its teardown command and leaves it alive.
   *
   * INV-6 applies to ALL the free text — `message`, `remediation`, and every
   * string leaf of the caller's payload — and is applied HERE rather than by
   * convention at each call site. It does not apply to the ids, the box URL or
   * the command lists composed below: those are built here from the run id, and
   * a redacted `teardownCommand` (or `httpsUrl`) is one the operator cannot use.
   */
  const refuse = (
    exitCode: 1 | 2 | 3 | 4 | 5,
    code: string,
    rawMessage: string,
    rawRemediation: string,
    payload: Record<string, unknown> = {},
  ): FleetError => {
    const message = redactUrls(rawMessage);
    const remediation = redactUrls(rawRemediation);
    const redactedPayload = redactDeep(payload) as Record<string, unknown>;
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
      process.stderr.write(`dispatch-log append to ${dispatchLog} failed (${code}): ${errorMessage(e)}\n`);
    }
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
        error: { code, message },
        runId: ctxRunId,
        verb: "dispatch",
        phase: "refused",
        // exit 1 is a timeout or a substrate failure — retryable, hence
        // "transient"; every other refusal is the brief's or the budget's own.
        exitStatus: (exitCode === 1 ? "transient" : "logic") as ExitStatus,
        // Nested, not spread: `timings` is a `Record<string, number>`, so a
        // spread lets a future `phase("status", …)` overwrite `status`,
        // `runId` or `exitStatus` with a number and no compile error.
        timings: { ...timings },
      });
    } catch {
      // `refuse` is called from inside the deadline `setTimeout` callback, where
      // a throwing log sink is an uncaughtException that kills the process
      // instead of rejecting the race — the same reason `within`'s abandoned
      // handler guards its own log call.
    }
    return new FleetError(exitCode, code, message, remediation, {
      ...redactedPayload,
      runId: ctxRunId,
      ...(ctxVmName === undefined ? {} : { vmName: ctxVmName }),
      ...(ctxHttpsUrl === undefined ? {} : { httpsUrl: ctxHttpsUrl }),
      ...(ctxRunId === null
        ? {}
        : {
            debugCommands: ctxGate?.debugCommands ?? [`bun scripts/fleet.ts status ${ctxRunId}`],
            teardownCommand: ctxGate?.teardownCommand ?? `bun scripts/fleet.ts teardown ${ctxRunId}`,
          }),
    });
  };

  /**
   * What is LEFT of the ceiling — never a non-finite number.
   *
   * An injected `deps.clock` returning `NaN` (or any arithmetic that goes
   * non-finite) made `left <= 0` FALSE, so the ceiling reported budget
   * remaining while `setTimeout(…, NaN)` fired ~immediately: the two halves of
   * the same guard disagreed. A budget that cannot be computed is an EXHAUSTED
   * budget — fail-closed, like every other unverifiable read in this layer.
   *
   * ponytail: still `Date.now()`-shaped, so an NTP step forward mid-provision
   * can abort a healthy dispatch. `performance.now()` is the monotonic fix, but
   * it does not compose with the `deps.clock` seam the tests drive; the upgrade
   * is a monotonic seam, not a second clock read.
   */
  const remaining = (): number => {
    const left = timeoutMs - (now() - wallStart);
    return Number.isFinite(left) ? left : 0;
  };
  const timedOut = (step: string, extra: Record<string, unknown> = {}): FleetError =>
    refuse(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${timeoutMs} ms at ${step}`,
      ctxRunId === null
        ? "raise timeoutMs, or retry when the substrate is responsive"
        : `tear the run down: bun scripts/fleet.ts teardown ${ctxRunId}`,
      { step, ...extra },
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
   * `work` is a THUNK, not a promise. Taking a promise meant every call site
   * evaluated its argument eagerly — `within("create", provisionAdmittedRun(…))`
   * — so on the `left <= 0` path the provider call was already in flight when
   * the deadline was checked: the record and the box got created and billed
   * anyway, `ctxVmName` was still `undefined` so the refusal carried no
   * `vmName`, and the box billed until the reaper aged it out. With a thunk,
   * "expired" means "never started", for every step at once.
   *
   * Abandoning makes the handler below the ONLY subscriber left on the work
   * promise. A rejection landing after the race was abandoned was an UNHANDLED
   * rejection: under the test runner it was attributed to whichever test ran
   * next and kept the process alive.
   *
   * The handler only reports; the timeout stays the thrown error. `abandoned`
   * keeps it silent on the ordinary path, where the race hands the failure to
   * dispatch and a second line would double-report it.
   */
  const within = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const left = remaining();
    if (left <= 0) throw timedOut(step);
    let abandoned = false;
    const running = work();
    void running.catch((e: unknown) => {
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
          error: { code: "abandoned-step-failed", message: redactUrls(errorMessage(e)) },
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        running,
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
  //
  // The UPPER bound matters just as much: `setTimeout` clamps a delay past
  // `MAX_TIMEOUT_MS` to 1 ms, so a ceiling above it made the FIRST step time
  // out immediately — a request to lengthen the budget inverting into the
  // shortest one possible, which is the opposite of what the caller asked for.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw refuse(
      2,
      "timeout-invalid",
      `timeoutMs must be a positive integer of milliseconds no greater than ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
      `omit timeoutMs for the 600_000 ms default, or pass a positive integer up to ${MAX_TIMEOUT_MS}`,
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
  //
  // `deps.requestId` gets the SAME shape check the brief's does, and refuses
  // rather than being dropped. Injected unvalidated, a malformed one made the
  // resolver mint a FRESH id — but the CLI had already built the store and the
  // driver with the old one, so the record's and the driver's log lines carried
  // a different correlation id from the ack, with no error anywhere. That
  // cross-layer split is precisely what INV-4-bis exists to prevent, and it is
  // the caller's own bug, so it is exit 2 rather than a silent re-mint.
  if (deps.requestId !== undefined && resolveBriefRequestId(deps) === undefined) {
    throw refuse(
      2,
      "invalid-request-id",
      `deps.requestId ${JSON.stringify(deps.requestId)} is not a strict UUID v4`,
      "pass the value resolveBriefRequestId() returned for this brief, or omit it and let dispatch resolve the brief's own",
    );
  }
  // `resolveBriefRequestId` and nothing else: the rule was reimplemented inline
  // here, and the two copies had ALREADY diverged (the helper guards
  // `typeof supplied === "string"`, the inline test did not).
  const { requestId: _briefRequestId, ...briefRest } = valid;
  const suppliedRequestId = deps.requestId ?? resolveBriefRequestId(valid);
  const briefIn =
    suppliedRequestId === undefined ? briefRest : { ...briefRest, requestId: suppliedRequestId };
  let correlation: ReturnType<typeof resolveRunCorrelation>;
  try {
    correlation = resolveRunCorrelation(briefIn);
  } catch (e) {
    if (e instanceof CorrelationError) {
      throw refuse(2, e.code, e.message, "fix the brief field the code names", { code: e.code });
    }
    // Not a CorrelationError, and still not a bare rethrow: an untyped escape
    // costs the operator the dispatch-log entry (AC4 evidence) and the one
    // structured line every other exit owes them, for a bare CLI exit 1.
    throw refuse(
      1,
      "correlation-failed",
      `correlation could not be resolved: ${errorMessage(e)}`,
      errorRemediation(e, "retry — nothing was provisioned"),
      providerCodePayload(e),
    );
  }
  const requestId = correlation.requestId;
  ctxRequestId = requestId;
  // ONE source for the issue identity from here on. Budget was booked against
  // `valid.repoSlug`/`valid.issueId` while `run-context.json` carried
  // `correlation.*` and the dispatch-log keys read a third copy: the resolver
  // trims the slug, so spend could be attributed to an issue the run does not
  // report, and the per-issue cap bypassed with a pair the resolver rewrites.
  const repoSlug = correlation.repoSlug;
  const issueId = String(correlation.issueId);
  ctxRepoSlug = repoSlug;
  ctxIssueId = correlation.issueId;
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
  // runBudgetMs exceeds the dispatch ceiling must refuse here, not mid-run. What
  // is passed is what is LEFT of that ceiling, not the whole of it: schema
  // validation and correlation have already spent part, so the full figure
  // admitted a manifest with `runBudgetMs === timeoutMs` that was then
  // guaranteed to overrun.
  //
  // `deps.repoRoot` and nothing else: an ambient `process.cwd()` makes the trust
  // anchor of a security guard depend on where the process happened to start.
  // The default keeps every existing caller (the CLI passes none) on cwd.
  // `loadManifest` realpaths it and refuses an unresolvable root, so no
  // resolution is repeated here — a second copy would be the weaker one
  // (manifest.ts avoids Bun's `realpathSync`, which hangs on a planted FIFO).
  const repoRoot = deps.repoRoot ?? process.cwd();
  // Resolved against the CONTAINMENT ROOT, not the process cwd. A relative
  // `manifestPath` is relative to the repo the brief names — resolving it
  // against wherever the dispatcher happened to be started made an identical
  // brief refuse or resolve depending on the caller's cwd, and made `repoRoot`
  // a seam that moved the guard without moving what the guard measures. An
  // absolute path is unaffected: `resolve` ignores the base for those.
  const manifestPath = resolve(repoRoot, valid.manifestPath);
  const manifestBudgetMs = remaining();
  // Checked separately so an exhausted ceiling reports as a TIMEOUT rather than
  // as a rejected manifest — the loader would refuse a non-positive budget, and
  // "manifest rejected" is the wrong diagnosis for a slow substrate.
  if (manifestBudgetMs <= 0) throw timedOut("manifest");
  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(manifestPath, manifestBudgetMs, repoRoot);
  } catch (e) {
    throw refuse(
      2,
      "manifest-rejected",
      `manifest rejected: ${errorMessage(e)}`,
      `fix the manifest, or point manifestPath at one beneath ${repoRoot}`,
      { manifestPath },
    );
  }
  // C7: the AUTHOR does not get to set the run's money ceiling. AC9a makes the
  // manifest the cap's only in-box carrier, so a hand-authored `limitMicroUsd`
  // in the source manifest is an attempt to name the ceiling the budget gate is
  // supposed to name.
  //
  // Stripped HERE and deliberately NOT inside `loadManifest`:
  // `scripts/pipeline-run.ts` reads the DELIVERED, already-stamped
  // `pipeline.yaml` through that same loader, so a strip down there deletes the
  // dispatcher's own stamp and the engine runs uncapped — the opposite defect.
  // This is the one read of an untrusted, unstamped manifest.
  //
  // ponytail: belt and braces. `stampManifestLimit` below spreads its own value
  // over whatever was there, so the authored one cannot reach the box today;
  // this makes the rule independent of that overwrite staying last.
  const { limitMicroUsd: _authoredLimit, ...unstamped } = loaded.manifest;
  loaded = { ...loaded, manifest: unstamped };
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
    // Not a bare `assertValidRunId`: an untyped throw here is a bare CLI exit 1
    // with no dispatch-log entry and no structured line — the exact treatment
    // the collision guard below declares unacceptable, two lines away.
    try {
      assertValidRunId(opts.runId);
    } catch (e) {
      throw refuse(
        2,
        "invalid-run-id",
        errorMessage(e),
        "omit runId and let dispatch mint one, or pass a value from mintRunId()",
      );
    }
    runId = opts.runId;
  } else {
    runId = mintRunId();
  }
  // A re-dispatch under an id that already has a record books the issue's cap a
  // SECOND time and then dies on a bare EEXIST from store.create — after the
  // reservation is committed. Refuse before the admission, not after it.
  //
  // A cheap FAST PATH only. `store.create`'s O_EXCL is the authoritative
  // arbiter (see the provisioning catch below): two concurrent dispatches
  // sharing an explicit `opts.runId` both pass this check and both commit a
  // reservation, so a check-then-create cannot be the guarantee. It still earns
  // its keep — the sequential case refuses here, before an admission is spent.
  //
  // Run for a self-minted id too, not just an explicit one: nothing chose a
  // minted id, so a collision is re-minted rather than refused.
  for (let attempt = 0; ; attempt++) {
    ctxRunId = runId;
    let exists: boolean;
    try {
      exists = recordExists(deps.store, runId);
    } catch (e) {
      // A store that cannot be read is not "free to reuse". It also must not
      // escape as a bare throw: every dispatch exit owes the operator a
      // dispatch-log entry and a structured line, and the CLI turns an untyped
      // throw into a bare exit 1 with neither. Nothing is provisioned here.
      throw refuse(
        1,
        "record-read-failed",
        `cannot read the run record for ${runId}: ${errorMessage(e)}`,
        errorRemediation(e, "fix or move the run-record directory, then retry — nothing was provisioned"),
        providerCodePayload(e),
      );
    }
    if (!exists) break;
    if (opts.runId !== undefined) {
      throw refuse(
        2,
        "run-id-in-use",
        `run ${runId} already has a record`,
        `omit runId for a fresh one, or tear the existing run down: bun scripts/fleet.ts teardown ${runId}`,
      );
    }
    if (attempt >= MINT_RETRIES) {
      throw refuse(
        1,
        "run-id-unmintable",
        `${MINT_RETRIES + 1} freshly minted run ids in a row already had records`,
        "the run-record directory is holding a day's worth of ids — reap or move it, then retry",
      );
    }
    runId = mintRunId();
  }

  // ── 5. admission (AC7/AC8 — both BEFORE store.create/driver.create) ────────
  // AC8: skipped only under { admitted: true } (DF3.2's single checkHeadroom(N)).
  if (opts.admitted !== true) {
    let headroom: Awaited<ReturnType<typeof checkHeadroom>>;
    try {
      headroom = await within("headroom", () => checkHeadroom(deps.driver, 1, deps.quotaLimits));
    } catch (e) {
      // `within`'s own deadline already refused — do not double-log it.
      if (e instanceof FleetError) throw e;
      // `checkHeadroom`'s default parameter is `limits = loadQuotaLimits()`,
      // which throws QuotaLimitsError for malformed JSON, an unknown key, a
      // non-positive value or EACCES (only ENOENT falls back to the defaults) —
      // and the CLI never passes `deps.quotaLimits`. Untyped, a plain
      // configuration defect was exit 1 with no dispatch-log entry and no log
      // line. It is an admission refusal like any other (AC8), and nothing is
      // provisioned at this point.
      throw refuse(
        5,
        "headroom-failed",
        `headroom could not be determined: ${errorMessage(e)}`,
        errorRemediation(e, "fix .sandbox/quota-limits.json, then retry — nothing was provisioned"),
        providerCodePayload(e),
      );
    }
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
    // `as CostLedger`: `assertWithinBudget` takes the concrete class, and
    // `LedgerLike` is the Pick<> that lets a fake exist at all — so this single
    // cast restores exactly the drift the Pick<> was introduced to prevent.
    // Widening the gate's parameter to a structural slice is the real fix and
    // lives in `src/providers/budget-gate.ts`, outside this module.
    decision = assertWithinBudget(ledger as CostLedger, { repoSlug, issueId, runId, requestId });
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
    // Everything else — a raw bun:sqlite SQLITE_BUSY, ENOENT/EACCES on the
    // ledger file, a TypeError out of a misconfigured `deps.ledgerFactory` — is
    // the SAME refusal the comment above promises for an unopenable or busy
    // ledger, which was only ever true for the two TYPED errors. A bare rethrow
    // bypassed `refuse` entirely: no dispatch-log entry, no structured line, no
    // runId on the payload, bare CLI exit 1.
    throw refuse(
      5,
      "admission-failed",
      `budget admission failed: ${errorMessage(e)}`,
      errorRemediation(e, "fix or move the cost ledger, then retry — nothing was provisioned"),
      providerCodePayload(e),
    );
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
  //
  // `isSafeInteger`, not `isInteger`: `Number.isInteger(1e300)` is true, so an
  // unsafe ceiling passed this guard, provisioned a box and a key, and only
  // then died in `stampManifestLimit` (which does bound it) — INV-2 in reverse.
  // The same bound is on the manifest schema, so the three agree.
  //
  // ponytail: this refusal fires AFTER `assertWithinBudget` committed the
  // admission, and cannot be moved before it — the ceiling under test IS the
  // decision's own output. The reservation is retired by the ledger's orphan
  // guard: `store.create` never runs on this path, so no record ever resolves
  // for this id and the admission stops counting after `ADMISSION_GRACE_MS`.
  // Retiring it sooner needs a ledger-side release, which `admitIssue`'s
  // contract deliberately does not offer and this layer holds no handle for.
  if (!Number.isSafeInteger(effectiveCeilingMicros) || effectiveCeilingMicros <= 0) {
    throw refuse(
      5,
      "no-ceiling",
      `admitted ceiling is ${effectiveCeilingMicros} µ$ — the run could not spend anything`,
      `raise the cap via .sandbox/cost-config.json perIssueOverrides for ${repoSlug}#${issueId}, or pick another issue`,
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
  // Wrapped, because this step STRADDLES the record: `provisionAdmittedRun`
  // writes the run record first (INV-1) and only then creates the box, so a
  // throw from the budget-extension write or from `driver.create` leaves a real
  // record on disk. An untyped throw escaping here carries no `runId`, and the
  // CLI's failure line would then report `runId: null` for a run an operator can
  // see in `fleet status` — the one case where they most need the id. `refuse`
  // stamps it (plus the debug/teardown commands) onto the payload, and files the
  // dispatch-log entry that AC4 evidence is read out of.
  let provisioned: Awaited<ReturnType<typeof provisionAdmittedRun>>;
  try {
    provisioned = await within("create", () =>
      provisionAdmittedRun(deps.driver, deps.store, {
        runId,
        // `port` is deliberately withheld: provisionAdmittedRun exposes and makes
        // the box PUBLIC immediately after create, i.e. before the setup gate has
        // proved anything — and INV-5 then forbids tearing that box down. The
        // expose/setPublic pair runs here instead, after gate.ready (step 10).
        budget: {
          repoSlug,
          issueId,
          capMicroUsd: decision.capMicroUsd,
          spentMicroUsd: decision.spentMicroUsd,
          reservedMicroUsd: decision.reservedMicroUsd,
          admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd,
        },
      }),
    );
  } catch (e) {
    // `timedOut` already produced one (and already refused) — do not double-log.
    if (e instanceof FleetError) throw e;
    // `store.create`'s O_EXCL is the AUTHORITATIVE arbiter of run-id identity;
    // the step-4 check is a fast path. Two concurrent dispatches sharing an
    // explicit `opts.runId` (DF3.2's fan-out shape) both pass that check and
    // both commit a reservation — exactly one wins the create, and the loser
    // must get the SAME exit-2 `run-id-in-use` refusal the sequential case
    // gets, not a generic exit-1 "provisioning failed" naming the wrong cause.
    //
    // The loser's reservation stays outstanding, and this layer cannot retire
    // it: the ledger's orphan guard expires an admission only when NO record
    // resolves for the id, and the winner's record resolves under exactly this
    // id. `admitIssue`'s contract states no caller may release a reservation,
    // and the ledger handle is closed by the `finally` above. Retiring it needs
    // a ledger-side rule for a losing admission — cross-cluster, not here.
    if ((e as NodeJS.ErrnoException | null | undefined)?.code === "EEXIST") {
      throw refuse(
        2,
        "run-id-in-use",
        `run ${runId} already has a record`,
        `omit runId for a fresh one, or tear the existing run down: bun scripts/fleet.ts teardown ${runId}`,
      );
    }
    throw refuse(
      1,
      "provision-failed",
      `provisioning failed for run ${runId}: ${errorMessage(e)}`,
      errorRemediation(
        e,
        // Deliberately not "the box is alive": whether it exists depends on which
        // half of record→box failed. Teardown is idempotent over both.
        `inspect the run, then tear it down: bun scripts/fleet.ts teardown ${runId}`,
      ),
      providerCodePayload(e),
    );
  }
  const { vm } = provisioned;
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
  ctxHttpsUrl = vm.httpsUrl;
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
    // Its OWN catch, with a FIXED message. `deliverRunKey` writes the plaintext
    // key into the box through `driver.exec`, and an exec wrapper that reports a
    // failure by including its argv — the ordinary way such a wrapper reports —
    // puts that key in the thrown message. The generic catch below interpolates
    // a caught message into `dispatch failed after the box was created: …`,
    // which is written to the dispatch log AND the structured line AND the
    // returned FleetError; `redactUrls` only matches `https?://…`, so a bare
    // token survives all three. INV-4 says plaintext exists in the mint return
    // and nowhere else, so the provider's free text never reaches a sink here —
    // only its `code`, in the payload.
    try {
      const { key } = await within("mint", () =>
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
      await within("deliver", () =>
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
    } catch (e) {
      if (e instanceof FleetError) throw e;
      throw refuse(
        1,
        "key-delivery-failed",
        `key mint or delivery failed for run ${runId}`,
        "the run record is OPEN and the box is ALIVE (INV-5) — inspect it, then tear it down",
        providerCodePayload(e),
      );
    }
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
          repoSlug,
          issueId: correlation.issueId,
          ...(correlation.issueUrl === null ? {} : { issueUrl: correlation.issueUrl }),
        }),
      },
    ];
    const exedevFill = (deps.driver as ProviderDriver & { fill?: unknown }).fill;
    if (typeof exedevFill === "function") {
      // exedev: clone the repo at the pinned SHA first, then place the manifest.
      // `repoUrl` and `commitSha` reach a git invocation inside a billable box,
      // and the brief schema is what constrains them: `repoUrl` is
      // `z.string().url().startsWith("https://")` (so `file:///etc`, `ssh://`
      // and an `--upload-pack=…` argument are all refused at ingress) and
      // `commitSha` is `/^[0-9a-f]{40}$/`. Nothing is re-derived here — a second
      // copy of a security rule is the one that rots.
      await within("clone", () =>
        (exedevFill as (vm: string, o: Record<string, string>) => Promise<unknown>).call(
          deps.driver,
          vm.name,
          { runId, repoUrl: valid.repoUrl, commitSha: valid.commitSha },
        ),
      );
    }
    await within("fill", () => fillRun(deps.driver, vm.name, files));
    phase("fill_ms", now() - tFill);

    // ── 9. setup gate (AC3: failure keeps record open, box alive — INV-5) ────
    const tGate = now();
    const gateFn =
      deps.setupGate ??
      ((drv: ProviderDriver, box: string, o: GateOpts) => {
        if (hasExedevSetup(drv)) {
          // No `as never`, no `as Parameters<…>`: `hasExedevSetup` narrows the
          // driver and `SetupGateOptions` accepts this literal on its own. The
          // casts switched off checking on BOTH arguments of the one call that
          // most needs it. `o.requestId` is still not forwarded — the gate's
          // options carry no correlation field, so INV-4-bis on its log lines
          // needs a change in `src/providers/exedev/setup-gate.ts`.
          return realSetupGate(drv, box, {
            runId: o.runId,
            rosterPath,
            commitSha: o.commitSha,
          });
        }
        return fakeGate(drv, box, o);
      });
    const gate: SetupGateResult = await within("gate", () =>
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
              // Omitted when absent, never defaulted: `"unknown"` is outside the
              // "A".."E" table and `0` is outside the 1|2|3|4 assertion-code
              // table, so a sentinel is a value no consumer of this record
              // knows how to read.
              ...(gate.failedItem === undefined ? {} : { failedItem: gate.failedItem }),
              ...(gate.assertionCode === undefined ? {} : { assertionCode: gate.assertionCode }),
              failedAt: new Date().toISOString(),
            },
          },
        });
      } catch (e) {
        process.stderr.write(`gate outcome not recorded on run ${runId}: ${errorMessage(e)}\n`);
      }
      throw refuse(
        3,
        "setup-gate-failed",
        `setup gate failed at item ${gate.failedItem ?? "?"}: ${gate.assertions.find((a) => !a.ok)?.note ?? ""}`,
        `debug: ${gate.debugCommands.join("; ")} — teardown when done: ${gate.teardownCommand}`,
        {
          assertionCode: gate.assertionCode,
          failedItem: gate.failedItem,
          // `refuse` redacts every string leaf of the payload at the choke
          // point, so nothing here (or at any other call site) repeats it.
          assertions: gate.assertions.map((a) => `${a.item}:${a.ok ? "ok" : a.note}`),
        },
      );
    }
    // The ceiling was never sampled after the gate — the single longest await
    // in the whole dispatch — so a run could ack "ready" well past its budget.
    //
    // Labelled "post-gate", not "gate": this fires only once the gate has
    // RETURNED ready, so `dispatch exceeded N ms at gate` accused a gate that
    // had passed all five assertions — and `ctxGate` is set by then, so the
    // payload's `debugCommands` come from that passing gate. `gateReady` says
    // so on the payload.
    if (remaining() <= 0) throw timedOut("post-gate", { gateReady: true });

    // ── 10. expose (INV-5 ordering: PUBLIC only once the gate has proved it) ─
    const port = deps.port;
    if (port !== undefined) {
      // Intent marker BEFORE the provider calls. `within` ABANDONS rather than
      // cancels (no AbortSignal at the seam), so an expose/setPublic abandoned
      // at the deadline can still complete seconds later: the box is then
      // publicly reachable while the record carries no `ports`, so `fleet
      // status` under-reports a live public box and port-keyed reapers miss it
      // entirely. The record claims the port before anything can open it.
      deps.store.set(runId, { ports: [port] });
      ctxHttpsUrl = await within("expose", () => deps.driver.expose(vm.name, port));
      await within("setPublic", () => deps.driver.setPublic(vm.name));
      if (ctxHttpsUrl !== undefined) deps.store.set(runId, { httpsUrl: ctxHttpsUrl });
    }
  } catch (e) {
    if (e instanceof FleetError) throw e;
    throw refuse(
      1,
      "dispatch-failed",
      `dispatch failed after the box was created: ${errorMessage(e)}`,
      errorRemediation(
        e,
        "the run record is OPEN and the box is ALIVE (INV-5) — inspect it, then tear it down",
      ),
      providerCodePayload(e),
    );
  }

  // ── 11. ack (AC2: synchronous, "provisioned", never "succeeded") ───────────
  // `state: "ready"` IS the AC's "provisioned": it says the box is up and the
  // gate proved it, not that the run's work finished. `DispatchResult.state`
  // admits no other literal, so there is no "succeeded" for it to be confused
  // with — the AC is met, the wording just differs from the literal.
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
    httpsUrl: ctxHttpsUrl === undefined ? undefined : redactUrls(ctxHttpsUrl),
    // Nested, not spread — see `refuse` for why a `Record<string, number>`
    // spread last can silently overwrite `status`/`runId`/`exitStatus`.
    timings: { ...timings },
  });
  return {
    runId,
    requestId,
    state: "ready",
    vmName: vm.name,
    ...(ctxHttpsUrl === undefined ? {} : { httpsUrl: ctxHttpsUrl }),
  };
}
