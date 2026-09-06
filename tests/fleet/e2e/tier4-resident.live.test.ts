/**
 * T4 — DF3.3 resident orchestrator LIVE (PR #135 pre-merge round).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Operator approved spend out of
 * band: ONE key — the run's own, cap 50 000 µ$ — plus 1 box. Worst case
 * ≈ $0.05 model + ~1 box-hour.
 *
 * WHAT IS REAL HERE: `fleet dispatch` provisions a real box, mints a real
 * capped run key, and delivers the STAMPED manifest + run-context.json (the
 * resident's brief witness) onto the box. The DELIVERED pair is then fetched
 * back off the box and fed to the PRODUCTION `scripts/pipeline-run.ts` —
 * the full DF3.3 wiring: resident arming from the witness brief, real host
 * `pi` (0.55.x, --provider openrouter --mode json), REAL OpenRouter steering
 * calls, engine-metered integer-µ$ telemetry, redacted pre-execution
 * artifacts. NO fake pi emulator anywhere in this file — the fake-resident
 * fixture is DF3.3's offline e2e territory.
 *
 * ONE SECRET PER BOX (design §6.2), restored — and THIS FILE was the exhibit.
 *
 * The governing decision is `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`
 * (ACCEPTED, operator decision 2026-08-31), and it names this test by tier: the
 * shipped resident spawns `pi` on the HOST, takes `OPENROUTER_API_KEY` from the
 * host env, "and the TIER-4 live test mints a **second** capped key for it —
 * INV-RES-3 violated in substance (credential surface = two keys, two machines)"
 * (ADR:43-45). So the second key was not merely something AC3's negative control
 * forbids; it was half of a named invariant violation, and the ADR's own remedy
 * is the one applied here: "the capped per-run key is *already* in-box
 * (`$HOME/app/.env`, 0600) and spent there by tier-3 workers; in-box
 * resident/engine uses the same single key — *restoring* §6.2's
 * one-secret-per-box, which the host-side resident (second key, host env)
 * currently violates" (ADR:97-100).
 *
 * The property is ONE SECRET PER BOX, not "no second mint" — which is why this
 * file now reads the run's own key out of `$HOME/app/.env` rather than simply
 * dropping the mint and steering on whatever the host happens to export. The
 * money consequence follows from the same fact: a run's model spend lands on the
 * key the run was ADMITTED under, so the cap the budget ladder computed is the
 * cap the money actually meets. A second key with its own 50 000 µ$ ceiling
 * doubled the run's real exposure while every host-side assertion still read
 * "capped at 50 000".
 *
 * The hygiene that one key needs is `fleet teardown`'s revoke plus the
 * `finally`'s population delta, both of which this file already had; what is
 * gone is a key that existed only because this test made it.
 *
 * WHAT IS *NOT* RESTORED, stated in the test TITLE and not only here (L19a).
 * The ADR's violation is "credential surface = two keys, TWO MACHINES". The
 * second KEY is genuinely gone. The second MACHINE is not: `runLeg` still
 * spawns `bun scripts/pipeline-run.ts` ON THE HOST, and the fix that removed
 * the mint is implemented by `cat`-ing the run's LIVE capped key off the box and
 * handing it to that host child on the environment. In one narrow respect that
 * is WORSE than what it replaced — a key previously confined to the box now
 * lives in a host process's memory and a child's environment across three legs.
 * The compensations are named rather than assumed:
 *   - the title says HOST-SIDE, so this file cannot be read as proof of in-box
 *     execution (that is T3.5's and tier2-in-box-engine's subject);
 *   - `OPENROUTER_API_KEY` must be UNSET in the invoking shell (refused at the
 *     top of the body) and is explicitly unset for the L1 control leg, so "one
 *     secret" is ASSERTED rather than narrated;
 *   - step 3b asserts the key's PROVENANCE — that the file it was read from is
 *     the very `EnvironmentFile=` the in-box unit loads — which is the
 *     regression detector deviation C16 removed with the second-mint exhibit.
 *     Re-host the resident, or move either path without the other, and it fails.
 * Closing the second machine is DF1.11's in-box consumer, not this story's.
 *
 * NOT changed, and the same ADR is why: the `no-ack` / exit-6 PASS shape stays
 * exactly as shipped. "Live tests keep asserting the honest `no-ack` shipped
 * shape until the in-box consumer lands. No interim transport machinery"
 * (ADR:118-119). That consumer is DF1.11's, not this story's.
 *
 * WHY THE PHASE BODIES STILL RUN HOST-SIDE, now that DF1.10's in-box engine
 * exists and T3.5 drives it: this file needs THREE differently-configured legs
 * (control / steered / degraded) off ONE dispatch, and the in-box front door
 * takes only a runId — `qds-run@<runId>` derives every other flag from in-box
 * convention, so it can express none of `--no-resident` or
 * `QDS_RESIDENT_TIMEOUT_MS`. Three in-box legs would be three dispatches (three
 * boxes, three keys, three witnesses outside each other's ±30 min window), and
 * running them by hand on ONE box is refused by design: the engine's AC6 replay
 * guard keys on `runMarkerPath(runId)`, the per-run marker root
 * (/run/qds-run/<runId>/journal/final.json since #217 F-D1), so leg 2 would be
 * turned away as an already-settled run. The in-box
 * walk is T3.5's and tier2-in-box-engine's subject; what THIS test owns is the
 * resident substrate no other tier touches — the delivered brief riding out of a
 * real dispatch, a real model steering a real run on the run's own key, and the
 * full journal/telemetry contract on live replies.
 *
 * THREE LEGS share one dispatch (the S28 witness window is ±30 min):
 *   L1 control    — --no-resident: status "disabled", deterministic run.
 *   L2 steered    — armed: real directives at the three solicitation points;
 *                   AC1b invariants (phase order, evidence-derived verdicts,
 *                   no unearned promotion), telemetry, artifacts, metering.
 *   L3 degraded   — QDS_RESIDENT_TIMEOUT_MS=50: every solicitation dies at
 *                   the timeout, status "degraded", run completes fully
 *                   deterministic, ZERO gates skipped (INV-RES-5 live).
 *
 * Model output is nondeterministic: L2 asserts ENGINE invariants conditional
 * on the directive actions the model actually chose (an abort must land the
 * engine's own fail transition, never a skipped gate), and records the action
 * sequence as evidence. Byte-identity (AC1a) is deliberately NOT asserted
 * live — that is the offline fake-pi e2e's deterministic territory.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { KEY_ENV_FILE, KEY_ENV_VAR } from "../../../src/providers/credentials.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  emittedRunId,
  fleetPartialOutput,
  keyLeakProblems,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  MINTED_RUN_ID_RE,
  preflight,
  runFleet,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
  runIdFor,
  boxHome,
  fetchBoxFile,
} from "./live-harness.ts";

const T4_CAP_MICRO_USD = 50_000;
const T4_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "Quantum-Digital-Solutions/QDS-Factory#46";
const T4_MANIFEST_PATH = "config/rosters/t4.resident.pipeline.json";
/** Round-7 S2-6: timeout discriminator gates on >25 ms; 50 ms is above it and
 * far below any real model latency — every L3 call dies at the timeout. */
const T4_DEGRADE_TIMEOUT_MS = 50;
/**
 * Wall clock per leg. Sized off the manifest, not off taste: `--budget-ms`
 * below must be ≥ the manifest's declared runBudgetMs (500_000), so a leg may
 * legitimately burn ~500 s of engine budget and this ceiling has to sit above
 * it with ssh/spawn overhead. A leg that fires this ceiling kills its child and
 * throws into the BODY's catch, so the `finally` still runs — the failure mode
 * this file must never reach is the RUNNER's own timeout, which aborts the test
 * with the `finally` unexecuted and the resident box (the most expensive one
 * this suite creates) still billing.
 */
const LEG_TIMEOUT_MS = 600_000;
/**
 * Dispatch ceiling. 900_000, down from 1_800_000: T5.1's EB6 audit measured the
 * same verb (box provision + the A–E setup gate, C/D being real roster-model
 * pings) as minutes under 540_000, and 900_000 keeps ~2× that margin for this
 * file's heavier resident manifest. The cut is what makes the budget below fit.
 */
const T4_DISPATCH_TIMEOUT_MS = 900_000;
/**
 * SERIAL WORST CASE vs the `it` timeout, written out because it did not fit
 * before: the per-leg `--budget-ms` was tripled to 600_000 against an unchanged
 * 2_400_000 runner timeout, and 3 × LEG_TIMEOUT_MS alone is 1_800_000 — one
 * dispatch at the old 1_800_000 ceiling put the sum at ~4.2 M, i.e. the runner
 * could abort mid-body and skip the whole `finally`.
 *
 *   dispatch                                                        900_000
 *   boxHome + 3 box reads   4 × 120_000 (DEFAULT_EXEC_TIMEOUT_MS)   480_000
 *                           (manifest, witness, and the run key's env file)
 *   systemctl cat (L19c)    30_000                                   30_000
 *   L1 + L2 + L3            3 × LEG_TIMEOUT_MS                    1_800_000
 *   teardown verb                                                   300_000
 *   box-absence poll (L3)   4 × (control ls 120 s + 10 s wait)      510_000
 *   listedKeyHashes (body) 2 × 240_000 — hashesBefore + step 8's    480_000
 *                           post-teardown listing
 *   finally  teardownQuietly                                        180_000
 *            destroyQuietly (1 control rm at 120 s)                 120_000
 *            fleetLeftovers 5 × (control ls 120 s + 8 s wait)
 *                          + its destroy pass + confirming re-list  880_000
 *            keyLeakProblems delta list + fallback revoke
 *                          + recheck list                            360_000
 *   ─────────────────────────────────────────────────────────────────────────
 *   Σ                                                             6_040_000
 *
 * Round 3 (E3-3): the table used to price the finally at "≈300_000" by costing
 * fleetLeftovers as its 8 s WAITS only (dropping the 120 s control ls each of
 * the 5 attempts carries), omitting keyLeakProblems entirely, and omitting the
 * body's listedKeyHashes call — the same helpers tier3's audit prices at
 * 880 + 360 + 240. Round 4 (LT9): the body makes TWO listings — hashesBefore
 * ahead of the try, plus step 8's post-teardown check — so the term is
 * 2 × 240_000 and the Σ is 6_040_000; 6_200_000 prices that honest sum with a
 * 160_000 margin, which is the REAL one (round 3's apparent 400_000 margin
 * was 240_000 of underpricing in disguise). Raising the
 * runner ceiling costs nothing on a healthy round (it is a ceiling, not a
 * wait) and is the only direction that keeps every leg's own clock intact —
 * cutting LEG_TIMEOUT_MS instead would put the wall clock BELOW the engine
 * budget the manifest declares, and buy false reds with the money it saved.
 */
const T4_TEST_TIMEOUT_MS = 6_200_000;

interface JournalBody {
  version?: string;
  runId?: string;
  ok?: boolean;
  completedAt?: string;
  phases?: Array<{ name?: string; status?: string }>;
  gateEvents?: Array<{ runId?: string; phaseId?: string; type?: string }>;
  resident?: {
    status?: string;
    directives?: number;
    directivesRejected?: number;
    steeringIterations?: Record<string, number>;
    spendMicros?: number;
    exitStatus?: string | null;
    tripwires?: Array<Record<string, unknown>>;
  };
}

interface SolicitLine {
  level?: string;
  event?: string;
  runId?: string;
  requestId?: string | null;
  phase?: string | null;
  point?: string;
  directiveAction?: string;
  model?: string;
  accepted?: boolean;
  spendMicros?: number;
  durationMs?: number;
  error?: string;
}

interface LegResult {
  leg: string;
  runId: string;
  exitCode: number | null;
  journal: JournalBody;
  solicits: SolicitLine[];
  stdoutHead: string;
  stderrTail: string;
  legDir: string;
  artifacts: string[];
  markerOk: boolean | null;
  /** Parse failures on a present-but-torn journal/marker file (LT6) — empty on every healthy leg. */
  parseErrors: string[];
}

/**
 * Run the PRODUCTION pipeline-run.ts against the DELIVERED manifest+witness
 * pair under <workspace>/delivered/. Fresh TMPDIR per leg isolates the build
 * testCommand's state-file counter. The resident's persist/session dir is
 * dirname(--journal) = the leg dir, so artifacts land there directly.
 */
async function runLeg(
  leg: string,
  deliveredDir: string,
  witnessRequestId: string,
  // `string | undefined` so a leg can UNSET a variable rather than only
  // override it (L19b). `Bun.spawn` drops an `undefined` value from the child's
  // environment, which is how the L1 control leg proves "no credential, no
  // call" instead of merely shadowing whatever the host happened to export.
  env: Record<string, string | undefined>,
  extraArgs: readonly string[] = [],
): Promise<LegResult> {
  const legDir = join(deliveredDir, "..", leg);
  mkdirSync(legDir, { recursive: true });
  const tmp = join(legDir, "tmp");
  mkdirSync(tmp, { recursive: true });
  // INV-1 (pipeline-run): the manifest must resolve INSIDE --run-root, so each
  // leg carries its own copy of the delivered pair — the copy's mtime is the
  // fetch moment, fresh inside the S28 ±30 min witness window.
  const legDelivered = join(legDir, "delivered");
  mkdirSync(legDelivered, { recursive: true });
  writeFileSync(join(legDelivered, "pipeline.yaml"), readFileSync(join(deliveredDir, "pipeline.yaml"), "utf8"));
  writeFileSync(join(legDelivered, "run-context.json"), readFileSync(join(deliveredDir, "run-context.json"), "utf8"));
  const runId = runIdFor(`t4-${leg}`);
  const journalPath = join(legDir, "journal.jsonl");
  const proc = Bun.spawn({
    cmd: [
      "bun",
      join(REPO_ROOT, "scripts/pipeline-run.ts"),
      "--manifest",
      join(legDelivered, "pipeline.yaml"),
      "--journal",
      journalPath,
      "--run-id",
      runId,
      "--request-id",
      witnessRequestId,
      // callerBudgetMs: must be >= the manifest's runBudgetMs (500_000 —
      // manifest.ts:740), which is itself sized so `build`'s per-attempt
      // ceiling can absorb one real post_gate_failure solicitation at the
      // SOLICIT_TIMEOUT_MS ceiling. Not the leg's wall clock: LEG_TIMEOUT_MS
      // is that, and it still bounds a run this budget would let hang.
      "--budget-ms",
      "600000",
      "--run-root",
      legDir,
      ...extraArgs,
    ],
    cwd: REPO_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      TMPDIR: tmp,
      QDS_RUN_ROOT: legDir,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [exitCode, stdout, stderr] = await Promise.all([
    Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`leg ${leg} timed out after ${LEG_TIMEOUT_MS} ms`)),
          LEG_TIMEOUT_MS,
        );
      }),
    ]).catch(async (e) => {
      proc.kill();
      throw e;
    }) as Promise<number | null>,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  // Torn-file tolerance (LT6): a child that EXITS (any code, including an
  // OOM-style kill after the streams drained) can leave a half-flushed
  // pretty-printed journal or final marker behind, and a bare JSON.parse
  // threw out of `runLeg` BEFORE LegResult was built — discarding the exit
  // code and both already-drained output streams, so the operator re-spends
  // a round to see "Unexpected token" instead of the real symptom. The
  // fallback is the same {} / null the absent-file cases already used; the
  // parse error rides LegResult as evidence.
  const parseErrors: string[] = [];
  let journal: JournalBody = {};
  if (existsSync(journalPath)) {
    try {
      journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalBody;
    } catch (e) {
      parseErrors.push(`journal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const solicits: SolicitLine[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("resident_solicit")) continue;
    try {
      const parsed = JSON.parse(line) as SolicitLine;
      if (parsed.event === "resident_solicit") solicits.push(parsed);
    } catch {
      // a torn trailing line is noise; the journal block is the record
    }
  }
  const artifacts = existsSync(legDir)
    ? readdirSync(legDir)
        .filter((f) => f.includes("-solicit-"))
        .map((f) => join(legDir, f))
    : [];
  const markerPath = join(legDir, "journal", "final.json");
  let markerOk: boolean | null = null;
  if (existsSync(markerPath)) {
    try {
      markerOk = (JSON.parse(readFileSync(markerPath, "utf8")) as { ok?: boolean }).ok ?? null;
    } catch (e) {
      parseErrors.push(`marker: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    leg,
    runId,
    exitCode,
    journal,
    solicits,
    stdoutHead: stdout.trim().slice(0, 300),
    stderrTail: stderr.trim().slice(-600),
    legDir,
    artifacts,
    markerOk,
    parseErrors,
  };
}

/** Phase (name,status) pairs — the promotion/order projection. */
function promotionOf(j: JournalBody): Array<[string | undefined, string | undefined]> {
  return (j.phases ?? []).map((p) => [p.name, p.status] as [string | undefined, string | undefined]);
}

/** (phase,type) pairs — the evidence-derived gate-verdict sequence. GateEvent
 * phaseIds are attempt-qualified (`<runId>:<attempt>:<phase>`), so the bare
 * phase name is the last colon segment. */
function gateSeqOf(j: JournalBody): Array<[string | undefined, string | undefined]> {
  return (j.gateEvents ?? []).map((e) => [
    typeof e.phaseId === "string" ? e.phaseId.split(":").at(-1) : e.phaseId,
    e.type,
  ] as [string | undefined, string | undefined]);
}

/**
 * Resident calls that died mid-flight: a prompt artifact whose solicit seq has
 * no reply artifact. A successful call persists BOTH (resident.ts persists the
 * prompt before the spawn and the reply after the harvest); a timed-out or
 * unreachable one persists the prompt and throws before the reply write — so
 * the unpaired prompt is the persisted fingerprint of the failed call, and its
 * count is the only MEASURED basis on which the full-walk absolute counts in
 * the L2 arms may relax. On a leg whose every call answered it is 0 and the
 * absolutes keep their full strength.
 */
function failedCallCount(artifacts: readonly string[]): number {
  const seqs = new Map<string, boolean>(); // seq → reply seen?
  for (const a of artifacts) {
    const m = /-solicit-(\d+)-(prompt|reply)\.txt$/.exec(a);
    if (m === null) continue;
    if (m[2] === "reply") seqs.set(m[1] ?? "", true);
    else if (seqs.get(m[1] ?? "") !== true) seqs.set(m[1] ?? "", false);
  }
  return [...seqs.values()].filter((paired) => !paired).length;
}

/**
 * The run's own PERSISTED record of why a resident degraded. The journal's
 * resident block is a closed key set with NO reason field (steering.ts:886 —
 * `lastDegradationReason` is controller-internal and read by nothing), so the
 * evidence is whatever trace the leg actually persisted: tripwire rows (the
 * journal), error-bearing `resident_solicit` warn lines (pipeline-run emits
 * one when the port's never-throws contract breaks), and the unpaired prompt
 * artifacts `failedCallCount` reads. Empty on an "active" resident; an empty
 * result on a "degraded" one is a degradation nothing explains.
 */
function degradationTraces(leg: LegResult): string[] {
  const traces: string[] = [];
  const tripwires = leg.journal.resident?.tripwires ?? [];
  if (tripwires.length > 0) {
    traces.push(`journal tripwires: ${tripwires.map((t) => JSON.stringify(t)).join("; ")}`);
  }
  const solicitErrors = leg.solicits.map((s) => s.error ?? "").filter((e) => e !== "");
  if (solicitErrors.length > 0) traces.push(`resident_solicit error fields: ${solicitErrors.join(" | ")}`);
  const failed = failedCallCount(leg.artifacts);
  if (failed > 0) traces.push(`${failed} resident call(s) died before the reply was persisted (unpaired -solicit-<n>-prompt.txt)`);
  return traces;
}

test.todoIf(liveTodoOff())(
  // The title says HOST-SIDE, and that is L19a rather than pedantry: the ADR's
  // stated violation is "credential surface = two keys, TWO MACHINES", and this
  // file removed the second KEY while keeping the second MACHINE. A title that
  // named only "the delivered brief" let the file read as proof of in-box
  // execution, which is T3.5's and tier2-in-box-engine's subject, not this one's.
  "T4 resident LIVE: dispatch → three HOST-SIDE pipeline-run legs (control/steered/degraded) driven by the delivered brief, on the box's OWN capped key → real OpenRouter steering",
  async () => {
    liveGate("2");
    // REFUSED BEFORE ANY SPEND (L19b). `runLeg` spreads `...process.env`, so a
    // host `OPENROUTER_API_KEY` flowed into the L1 CONTROL leg — which is the
    // one leg whose claim is "no credential, no call" — and was silently
    // SHADOWED rather than refused in L2/L3. "One secret per box" was narrated
    // in the header and asserted nowhere. It is asserted here, at zero cost, on
    // the shell rather than on the leg: the L1 leg additionally unsets the
    // variable explicitly below, so the two together make the claim structural.
    const hostKey = (process.env[KEY_ENV_VAR] ?? "").trim();
    if (hostKey !== "") {
      throw new Error(
        `${KEY_ENV_VAR} is exported host-side. This test's whole claim is ONE SECRET PER BOX (design §6.2, and the tier-2 placement ADR names this file for violating it): the only credential any leg may use is the run's own capped key, read off the box's ${KEY_ENV_FILE}. A host key would ride \`...process.env\` into the L1 control leg — the leg that must prove "no credential, no call" — and would be silently shadowed in L2/L3. Unset it and re-run. (The value is not printed, here or anywhere.)`,
      );
    }
    // HOST-PI PREREQUISITES, refused BEFORE ANY SPEND (LT5) — the same
    // posture as the key refusal above. The armed legs copy the host's
    // `~/.pi/agent/models.json` into the isolated HOME and point
    // QDS_PI_CATALOG_DIR at the fixture catalog, and a host without either
    // used to discover it as a copyFileSync ENOENT (or loadBundledCatalog
    // throw) AFTER dispatch had provisioned the box and minted the key — a
    // full dispatch+teardown cycle spent to learn a precondition that costs
    // nothing to check here.
    const hostModelsJson = join(homedir(), ".pi", "agent", "models.json");
    const piCatalogDir = join(REPO_ROOT, "tests/phase-engine/fixtures/pi-catalog");
    if (!existsSync(hostModelsJson)) {
      throw new Error(
        `host pi models.json missing at ${hostModelsJson}: the armed legs copy it into the isolated HOME because the resident slug resolves only through that custom registry. A leg without it degrades every steering call. Refusing before dispatch spends.`,
      );
    }
    if (!existsSync(piCatalogDir)) {
      throw new Error(
        `pi fixture catalog dir missing at ${piCatalogDir}: QDS_PI_CATALOG_DIR must supply the provider rates (the host's global-npm pi bundles no provider data, and loadBundledCatalog throws BEFORE the custom registry is consulted). Refusing before dispatch spends.`,
      );
    }
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vm = "";
    let store: RunRecordStore | undefined;
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /**
     * The key population BEFORE this run — the F17 delta, rendered in the
     * finally. ONE key exists for this round now (C16): `dispatch` mints it,
     * `fleet teardown` revokes it, and it is on THIS run's record — so the
     * `finally`'s record-backed fallback revoke covers it and the population
     * delta is what proves the revoke actually happened. When this file minted a
     * second key by hand, that key sat on a `<runId>-resident` record the
     * `keyLeakProblems` call below was never told about, so a bespoke revoke was
     * the ONLY thing standing between it and outliving the round.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t4res");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T4_CAP_MICRO_USD,
          boxHourRateMicroUsd: T4_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: T4_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T4_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T4_CAP_MICRO_USD, manifestPath: T4_MANIFEST_PATH });

      // ── 1. dispatch: real box + real capped key + delivered stamped pair ─
      // The `.catch` is the L1 fix PORTED from tier2/tier3 (round 3, E3-1):
      // `runFleet`'s ceiling REJECTS, so `d` is never assigned on that path —
      // and dispatch is precisely the verb that creates a real box before it
      // can still fail. Without the partial-output recovery the `finally`'s
      // ownership legs (`runId`/`vm` still "") are guarded off and
      // `fleetLeftovers` demotes a genuine leak to "another round's stray".
      // `fleetPartialOutput` hands back what the killed child had written,
      // which is where the minted id lives; arming `runId` from it keeps the
      // teardown/revoke legs live before the rethrow lands in the body catch.
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: T4_DISPATCH_TIMEOUT_MS },
      ).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        const partialId = emittedRunId(partial.stdout, partial.stderr);
        if (partialId !== undefined) runId = partialId;
        // THE PRE-ACK HANG: the ack is the FIRST id-bearing line `dispatch`
        // prints, so a ceiling that fires before it leaves the partial streams
        // id-less and `emittedRunId` recovers nothing — runId/vm stay "", the
        // `finally`'s teardown+destroy legs are guarded off, and the resident
        // box (the most expensive one this suite creates) bills until the
        // reaper. But dispatch writes the run record BEFORE the box exists and
        // the fleet names the box `driver.create(runId)`, so the record's FILE
        // NAME is the box's name: the records dir is the one handle this path
        // has left.
        if (runId === "") {
          try {
            const stemRe = new RegExp(`^${MINTED_RUN_ID_RE.source}$`);
            const fromRecords = readdirSync(recordsDir)
              .filter((f) => f.endsWith(".json"))
              .map((f) => f.slice(0, -".json".length))
              .filter((stem) => stemRe.test(stem));
            const first = fromRecords[0];
            if (first !== undefined) runId = first;
          } catch (readErr) {
            evidence.push({
              phase: "dispatch-timeout-records-read-error",
              error: readErr instanceof Error ? readErr.message : String(readErr),
            });
          }
        }
        // The box IS the runId for a dispatch-minted run (`driver.create(runId)`),
        // so arming vm here keeps the finally's destroyQuietly leg live on the
        // timeout path too — not only when the ack happened to arrive.
        if (vm === "" && runId !== "") vm = runId;
        evidence.push({
          phase: "dispatch-verb-timeout",
          error: String((e as Error)?.message ?? e),
          recoveredBytes: partial.stdout.length + partial.stderr.length,
          recoveredRunId: runId,
          runIdSource: partialId !== undefined ? "partial-streams" : runId !== "" ? "records-dir" : "none",
        });
        throw e;
      });
      evidence.push({ phase: "dispatch-verb", exitCode: d.exitCode, stdoutHead: d.stdout.trim().slice(0, 400), stderrTail: d.stderr.trim().slice(-400) });
      // Ownership armed BEFORE the assertion that can throw — `dispatch` names a
      // box before it can still fail, so binding ownership to the success ack
      // below leaves a failure path with a live box nobody owns. See
      // `emittedRunId`.
      const emitted = emittedRunId(d.stdout, d.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(d.exitCode).toBe(0);
      const ack = JSON.parse(d.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as {
        runId: string;
        vmName: string;
        state: string;
      };
      expect(ack.state).toBe("ready");
      runId = ack.runId;
      vm = ack.vmName;
      evidence.push({ phase: "dispatch-ack", ack });

      // ── 2. fetch the DELIVERED stamped pair OFF the box ─────────────────
      // `$HOME/src/.qds/` — INSIDE the checkout (DF1.10 AC2b), not beside it in
      // the ssh HOME where this file used to read them. The move is what gives
      // the in-box engine ONE root that `loadManifest`'s beneath-root walk, the
      // witness read, roster resolution and every code phase's cwd agree on, and
      // reading the old placement here would have failed FIRST on a paid box:
      // the path is only exercised under the live gate, so `bun test`, `tsc` and
      // CI all stay green on a stale one. Both segments come from the exported
      // constants `src/fleet/dispatch.ts` builds the write path from — a literal
      // here would be a second place for the placement to drift.
      const home = await boxHome(ctx.driver, vm);
      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const manifestBytes = await fetchBoxFile(ctx.driver, vm, `${qdsDir}/pipeline.yaml`);
      const witnessBytes = await fetchBoxFile(ctx.driver, vm, `${qdsDir}/run-context.json`);
      const deliveredDir = join(workspace, "delivered");
      mkdirSync(deliveredDir, { recursive: true });
      writeFileSync(join(deliveredDir, "pipeline.yaml"), manifestBytes);
      writeFileSync(join(deliveredDir, "run-context.json"), witnessBytes);
      const witness = JSON.parse(witnessBytes) as {
        requestId?: string;
        effectiveCeilingMicros?: number;
        [k: string]: unknown;
      };
      expect(typeof witness.requestId).toBe("string");
      expect((witness.requestId ?? "").length).not.toBe(0);
      evidence.push({
        phase: "delivered-pair",
        qdsDir,
        witnessRequestId: witness.requestId,
        witnessCeiling: witness.effectiveCeilingMicros,
        deliveredLimit: (JSON.parse(manifestBytes) as { limitMicroUsd?: number }).limitMicroUsd,
        briefKeys: Object.keys(witness).sort(),
      });

      // ── 3. the RUN'S OWN key, read off the box (INV-RES-3, design §6.2) ──
      // `$HOME/app/.env` at mode 0600 is DF2.3's delivery contract, and both
      // halves of the path are the exported constants that contract is written
      // in (`KEY_ENV_FILE`, `KEY_ENV_VAR`) rather than re-spelled here. It is
      // the same file tier-3's in-box workers already spend against, which is
      // the ADR's point: the key was in the box the whole time (ADR:97-100).
      //
      // This is the ONE key of the round — one secret, one box. The armed legs
      // below hand it to `pi` on the environment, so every steering call this
      // test makes meters against the very cap the run was admitted under. Two
      // keys on two machines is the credential surface INV-RES-3 forbids and
      // the ADR cites this file for; it is also what silently doubled the real
      // money ceiling behind assertions that still read "capped at 50 000".
      //
      // FAIL LOUDLY here rather than let the legs discover it: a missing or
      // malformed key does not produce an error downstream, it produces a 401
      // that `pi` exits 0 on with empty content, which the resident correctly
      // fail-closes into `degraded` (INV-RES-5 working as designed). L3 would
      // then PASS for the wrong reason and L2 would fail with a telemetry
      // assertion that names nothing about credentials.
      store = new RunRecordStore({ dir: recordsDir });
      const envBody = await fetchBoxFile(ctx.driver, vm, `${home}/${KEY_ENV_FILE}`);
      const runKey =
        envBody
          .split("\n")
          .find((line) => line.startsWith(`${KEY_ENV_VAR}=`))
          ?.slice(KEY_ENV_VAR.length + 1)
          .trim() ?? "";
      // `.startsWith(...)` folded to a BOOLEAN before it reaches the matcher,
      // never `expect(runKey).toMatch(...)`: bun prints the RECEIVED value in a
      // failure message, and the received value here is a live credential. The
      // evidence entry names the source and says the read succeeded — the key
      // itself never enters `evidence`, and `writeEvidence` would refuse the
      // file if it did.
      // A LENGTH FLOOR beside the prefix (L24). `startsWith("sk-or-")` alone
      // passes on a TRUNCATED read — a half-written `.env`, a `cat` cut at the
      // exec layer's output cap — and a truncated key is exactly the 401 →
      // `degraded` path this check exists to prevent: `pi` exits 0 with empty
      // content, the resident fail-closes to `degraded` (INV-RES-5 working as
      // designed), L3 then PASSES FOR THE WRONG REASON and L2 fails with a
      // telemetry assertion that names nothing about credentials. 40 is well
      // under any real OpenRouter key and well over any prefix fragment. Folded
      // to booleans before the matcher, like every other check on this value:
      // bun prints the RECEIVED value in a failure message, and the received
      // value here is a live credential.
      expect(runKey.startsWith("sk-or-")).toBe(true);
      expect(runKey.length >= 40).toBe(true);
      evidence.push({ phase: "run-key", source: `${home}/${KEY_ENV_FILE}`, envVar: KEY_ENV_VAR, ok: true, keyChars: runKey.length, provenance: "delivered by dispatch — this test mints no key of its own" });

      // ── 3b. PROVENANCE: this file is the unit's own EnvironmentFile (L19c) ─
      // The regression detector that deviation C16 deleted when it removed the
      // second-mint exhibit, restored in the form the acceptance auditor asked
      // for. The legs below run `pipeline-run.ts` on the HOST and hand it the
      // key on the environment, so nothing else in this file ties that key to
      // the in-box engine's own credential. Read the unit and assert they are
      // the SAME PATH: `qds-run@.service` loads `EnvironmentFile=` (mandatory
      // form, no leading `-`) and that is where the in-box engine's
      // `OPENROUTER_API_KEY` comes from. If the resident is ever re-hosted, or
      // the delivery path moves and the unit's does not, this fails LOUDLY
      // instead of the file quietly proving something about a different key.
      //
      // The unit spells the path as a LITERAL (`%h` in a system unit expands to
      // the service MANAGER's home, not `User=`'s), which is exactly why it must
      // be compared against a `$HOME` resolved on the box rather than assumed.
      // `systemctl cat` is a read and needs no sudo.
      //
      // LAST match, not first (round 3, E3-7): `systemctl cat` prints the base
      // unit and then any drop-in, and for duplicated directives systemd keeps
      // the LAST assignment — an override in
      // `/etc/systemd/system/qds-run@.service.d/*.conf` redirecting the engine's
      // credential would leave the FIRST-match read asserting the base's path
      // while the engine consumes the override's. The regression detector is
      // aimed at exactly this drift; it must read the EFFECTIVE value.
      const unitText = await ctx.driver.execTimed(vm, ["systemctl", "cat", "qds-run@.service"], 30_000);
      const unitEnvFile =
        [...unitText.stdout.matchAll(/^EnvironmentFile=(.+)$/gm)].map((m) => m[1]?.trim() ?? "").filter(
          (v) => v !== "",
        ).at(-1) ?? "";
      evidence.push({
        phase: "key-provenance",
        unitEnvFile,
        readFrom: `${home}/${KEY_ENV_FILE}`,
        exitCode: unitText.exitCode,
      });
      expect(unitText.exitCode).toBe(0);
      expect(unitEnvFile).toBe(`${home}/${KEY_ENV_FILE}`);

      // ── 4. L1 CONTROL: --no-resident → disabled, deterministic ─────────
      // `KEY_ENV_VAR: undefined` UNSETS it for this child (L19b). `runLeg`
      // spreads `...process.env`, so the control leg used to inherit whatever
      // the host exported — and this is the leg whose claim is that no resident
      // and no credential means no call. The refusal at the top of this test
      // already proves the shell is clean; this makes it structural rather than
      // dependent on that refusal staying in place.
      const l1 = await runLeg("l1-control", deliveredDir, witness.requestId as string, { [KEY_ENV_VAR]: undefined }, [
        "--no-resident",
      ]);
      evidence.push({
        phase: "l1-control",
        exitCode: l1.exitCode,
        ok: l1.journal.ok,
        markerOk: l1.markerOk,
        phases: promotionOf(l1.journal),
        resident: l1.journal.resident,
        solicits: l1.solicits.length,
        parseErrors: l1.parseErrors,
      });
      expect(l1.exitCode).toBe(0);
      expect(l1.journal.ok).toBe(true);
      expect(l1.markerOk).toBe(true);
      expect(promotionOf(l1.journal)).toEqual([
        ["plan", "success"],
        ["build", "success"],
      ]);
      expect(l1.journal.resident?.status).toBe("disabled");
      expect(l1.solicits).toEqual([]);
      expect(l1.artifacts).toEqual([]);
      // The control run still rides the real gate: fail@1 (counter=1) then
      // pass@2 (counter=2) — evidence-derived verdicts with no resident.
      expect(gateSeqOf(l1.journal)).toEqual([
        ["build", "gate_fail"],
        ["build", "gate_pass"],
      ]);

      // ── 5. L2 STEERED: real pi, real OpenRouter, real directives ───────
      // HOST-PI ISOLATION (proven by live A/B, 2026-08-28): this host's pi
      // resolves auth.json's openrouter entry OVER env OPENROUTER_API_KEY, and
      // that stored key is dead — every call 401s "User not found", pi exits 0
      // with EMPTY content, and steering fail-closed degrades (which is itself
      // INV-RES-5 working as designed). The resident slug additionally exists
      // only through ~/.pi/agent/models.json (custom registry). So the armed
      // legs run pi under an ISOLATED HOME carrying a copy of models.json and
      // NO auth.json: model resolution intact, auth strictly from the env key —
      // which is now the RUN's own key, read off the box above. A/B evidence:
      // isolated-home + an env key → stopReason "stop", 4857 in / 68 out,
      // $0.0004008 real spend.
      // QDS_PI_CATALOG_DIR: the host's global-npm pi ships no bundled provider
      // data either (deviation-ledger #8's seam), and loadBundledCatalog throws
      // BEFORE the custom registry is consulted — the fixture catalog's rates
      // are the host models.json integers (config parity). Usage and spend
      // substrate stay 100% real.
      const piHome = join(workspace, "pi-home");
      mkdirSync(join(piHome, ".pi", "agent"), { recursive: true });
      copyFileSync(hostModelsJson, join(piHome, ".pi", "agent", "models.json"));
      const l2 = await runLeg("l2-steered", deliveredDir, witness.requestId as string, {
        [KEY_ENV_VAR]: runKey,
        QDS_PI_CATALOG_DIR: piCatalogDir,
        HOME: piHome,
      });
      const l2Actions = l2.solicits.map((s) => s.directiveAction);
      const l2Aborted = l2Actions.includes("abort");
      evidence.push({
        phase: "l2-steered",
        exitCode: l2.exitCode,
        ok: l2.journal.ok,
        markerOk: l2.markerOk,
        phases: promotionOf(l2.journal),
        resident: l2.journal.resident,
        solicitPoints: l2.solicits.map((s) => s.point),
        directiveActions: l2Actions,
        acceptedFlags: l2.solicits.map((s) => s.accepted),
        models: l2.solicits.map((s) => s.model),
        durationsMs: l2.solicits.map((s) => s.durationMs),
        cumulativeSpendMicros: l2.solicits.map((s) => s.spendMicros),
        stderrTail: l2.stderrTail,
        parseErrors: l2.parseErrors,
      });
      // Every line carries the run's identity and the armed model.
      for (const s of l2.solicits) {
        expect(s.runId).toBe(l2.runId);
        expect(s.requestId).toBe(witness.requestId);
        expect(s.model).toBe("deepseek/deepseek-v4-flash-0731");
      }
      // AC1b: phase order preserved; every gate verdict evidence-derived
      // (same fail@1 → pass@2 sequence the control produced); promotion no
      // broader than the control's on the same evidence — unless the model
      // legitimately aborted, in which case the engine's OWN fail transition
      // must show (ok:false, never a promoted phase after it).
      expect((l2.journal.phases ?? []).map((p) => p.name)).toEqual(["plan", "build"]);
      const r2 = l2.journal.resident;
      // RESIDENT STATUS SHAPE: `telemetry.status` is a ONE-WAY LATCH — three
      // paths in steering.ts write "degraded" and nothing anywhere writes
      // "active" back — so ONE transient solicitation failure (a 429, a call
      // timeout) degrades the resident for the rest of the run while the walk
      // itself completes deterministically (L3 below is exactly that shape, on
      // purpose). Asserting `toBe("active")` false-reded ~40-minute paid rounds
      // with nothing in the record distinguishing a transient degrade from the
      // regression this test exists to catch. "degraded" is accepted ONLY with
      // the run's own PERSISTED evidence of why (`degradationTraces`); degraded
      // with none of those traces stays red — an unexplained degradation is
      // indistinguishable from regression.
      const l2Traces = r2?.status === "degraded" ? degradationTraces(l2) : [];
      expect(r2?.status === "active" || (r2?.status === "degraded" && l2Traces.length > 0)).toBe(true);
      // Each unpaired prompt artifact is one resident call that died mid-flight.
      // The full-walk absolutes in the arms below relax by exactly that MEASURED
      // count, never by assumption — 0 on every leg whose calls all answered.
      const l2FailedCalls = failedCallCount(l2.artifacts);
      evidence.push({
        phase: "l2-resident-shape",
        status: r2?.status,
        shape: r2?.status === "active" ? "active" : "degraded-with-evidence",
        degradationTraces: l2Traces,
        failedCalls: l2FailedCalls,
        exitStatus: r2?.exitStatus ?? null,
      });
      if (!l2Aborted) {
        expect(l2.exitCode).toBe(0);
        expect(l2.journal.ok).toBe(true);
        expect(l2.markerOk).toBe(true);
        expect(promotionOf(l2.journal)).toEqual(promotionOf(l1.journal));
        expect(gateSeqOf(l2.journal)).toEqual(gateSeqOf(l1.journal));
        // Exactly the three engine-owned solicitation points, in order, and
        // the partition/artifact counts of a FULL walk (LT1). These absolute
        // shapes are legal ONLY when no abort was accepted: an accepted
        // abort stops the walk and `pipeline-run` SKIPS the run_end
        // solicitation (`residentAborted`), so the three-point sequence can
        // never coexist with `l2Aborted` — asserting them unconditionally
        // false-reded a legal abort at this depth, before the arm could
        // render its graceful verdict, on a paid round.
        expect(l2.solicits.map((s) => s.point)).toEqual(["run_start", "post_gate_failure", "run_end"]);
        if (r2?.status === "active") {
          expect(r2.exitStatus).toBe("success");
          expect((r2?.directives ?? 0) + (r2?.directivesRejected ?? 0)).toBe(3);
          // ≥ 2 × points, not ===: the artifact set counts pi CALLS, not
          // solicitation points — a malformed-reply retry redoes the call
          // (seq bumps), so one retry under three points yields 8 and an
          // exact 6 false-reded it. Status "active" guarantees ≥ 2 per
          // solicitation (pre-execution prompt + reply, every call answered).
          expect(l2.artifacts.length).toBeGreaterThanOrEqual(2 * l2.solicits.length);
        } else {
          // The degraded shape: each absolute below relaxes by exactly the
          // MEASURED failed-call count — a failed solicitation still emits
          // its line and persists its prompt, but counts no directive and
          // never gets a reply artifact. `exitStatus` is RECORDED in the
          // shape entry above rather than asserted exact here: what a
          // degraded resident's stop path exits as is L3's contract, not
          // this arm's.
          expect((r2?.directives ?? 0) + (r2?.directivesRejected ?? 0)).toBeGreaterThanOrEqual(3 - l2FailedCalls);
          expect(l2.artifacts.length).toBeGreaterThanOrEqual(2 * l2.solicits.length - l2FailedCalls);
        }
      } else {
        expect(l2.journal.ok).toBe(false);
        // The aborted walk stops AT the accepted abort: run_end is never
        // solicited once `residentAborted` is set, so the observed points
        // are a PROPER PREFIX of the three, and the partition/artifact
        // counts track the solicitations that actually happened (2
        // artifacts per answered call: pre-execution prompt + reply — ≥,
        // because a malformed-reply retry adds a pair; minus the MEASURED
        // failed-call count, 0 whenever the resident stayed healthy).
        const points = l2.solicits.map((s) => s.point);
        expect(points.length).toBeLessThan(3);
        expect(points).toEqual(["run_start", "post_gate_failure", "run_end"].slice(0, points.length));
        expect((r2?.directives ?? 0) + (r2?.directivesRejected ?? 0)).toBe(l2.solicits.length - l2FailedCalls);
        expect(l2.artifacts.length).toBeGreaterThanOrEqual(2 * l2.solicits.length - l2FailedCalls);
        evidence.push({ phase: "l2-abort-observed", note: "model chose abort; engine fail-transition asserted" });
      }
      // Telemetry contract (AC5): integer µ$ > 0 (real metered usage), and
      // the final cumulative observability line reconciles with the journal
      // block. (The directive-partition sum moved into the arms above (LT1):
      // its absolute value 3 is only legal on the full non-aborted walk.)
      expect(Number.isSafeInteger(r2?.spendMicros)).toBe(true);
      expect(r2?.spendMicros ?? 0).toBeGreaterThan(0);
      expect(r2?.spendMicros ?? 0).toBeLessThanOrEqual(T4_CAP_MICRO_USD);
      expect(l2.solicits.at(-1)?.spendMicros).toBe(r2?.spendMicros);
      // steeringIterations only ever counts accepted post_gate_failure
      // retries for a phase that exists (build: 0 or 1 — recorded, both legal).
      const iterKeys = Object.keys(r2?.steeringIterations ?? {});
      for (const k of iterKeys) {
        expect(["plan", "build"]).toContain(k);
        expect(r2?.steeringIterations?.[k]).toBeGreaterThanOrEqual(0);
      }
      // Pre-execution persistence (DOD-Security): one prompt + one reply per
      // solicitation (6 on the full walk — the count itself is asserted in
      // the arms above, LT1), mode 0600, and NO key material in any
      // artifact byte.
      for (const a of l2.artifacts) {
        const st = statSync(a);
        expect(st.mode & 0o077).toBe(0);
        const body = readFileSync(a, "utf8");
        expect(body).not.toContain("sk-or-");
        // Folded to a boolean before the matcher, for the reason the key read
        // above states: `not.toContain(runKey)` prints the EXPECTED substring on
        // failure, and the failure case here is precisely "the key is in a file
        // it should not be in" — copying it into a CI log would compound the
        // leak it is reporting. `.includes` is the same check, silently.
        expect(body.includes(runKey)).toBe(false);
      }
      // The pi session file exists beside the artifacts (per-runId file).
      expect(existsSync(join(l2.legDir, `${l2.runId}.resident.jsonl`))).toBe(true);

      // ── 6. L3 DEGRADED: 50 ms timeout → degraded, deterministic, no
      //       skipped gates (INV-RES-5 live) ──────────────────────────────
      const l3 = await runLeg("l3-degraded", deliveredDir, witness.requestId as string, {
        [KEY_ENV_VAR]: runKey,
        QDS_PI_CATALOG_DIR: piCatalogDir,
        HOME: piHome,
        QDS_RESIDENT_TIMEOUT_MS: `${T4_DEGRADE_TIMEOUT_MS}`,
      });
      evidence.push({
        phase: "l3-degraded",
        exitCode: l3.exitCode,
        ok: l3.journal.ok,
        markerOk: l3.markerOk,
        phases: promotionOf(l3.journal),
        resident: l3.journal.resident,
        solicits: l3.solicits.map((s) => ({ point: s.point, action: s.directiveAction, accepted: s.accepted })),
        parseErrors: l3.parseErrors,
      });
      expect(l3.exitCode).toBe(0);
      expect(l3.journal.ok).toBe(true);
      expect(l3.markerOk).toBe(true);
      expect(l3.journal.resident?.status).toBe("degraded");
      // Deterministic completion: identical promotion AND gate sequence to
      // the control — zero gates skipped, zero phases shortened.
      expect(promotionOf(l3.journal)).toEqual(promotionOf(l1.journal));
      expect(gateSeqOf(l3.journal)).toEqual(gateSeqOf(l1.journal));
      // All three hook points still solicited; none accepted a directive.
      expect(l3.solicits.length).toBe(3);
      expect(l3.solicits.every((s) => s.accepted === false)).toBe(true);
      expect(l3.journal.resident?.directives ?? -1).toBe(0);

      // ── 7. money identity: stamp == witness == record (t3.5 parity) ────
      const deliveredLimit = (JSON.parse(manifestBytes) as { limitMicroUsd?: number }).limitMicroUsd;
      const rec = store.get(runId);
      evidence.push({
        phase: "money-identity",
        deliveredLimit,
        witnessCeiling: witness.effectiveCeilingMicros,
        recordLimit: rec.limitMicroUsd,
        residentSpendMicros: l2.journal.resident?.spendMicros,
      });
      expect(deliveredLimit).toBe(T4_CAP_MICRO_USD);
      expect(witness.effectiveCeilingMicros).toBe(deliveredLimit);
      expect(rec.limitMicroUsd).toBe(deliveredLimit);

      // ── 8. teardown: spend ≤ cap, THE key revoked, box gone ────────────
      // One key, so one revoke — and it is the PRODUCTION verb's, not a
      // hand-rolled one this test performs on a key it minted. `captureSpend`
      // runs before the DELETE, so `spendMicroUsd` now includes the resident's
      // steering calls: the same figure, on the same key, under the same cap.
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { cwd: REPO_ROOT, timeoutMs: 300_000 });
      evidence.push({ phase: "teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
      expect(td.exitCode).toBe(0);
      const closed = store.get(runId);
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T4_CAP_MICRO_USD);
      const hashes = await listedKeyHashes();
      expect(hashes).not.toContain(closed.keyHash);
      // POLLED (L3): the substrate's destroy lag is MEASURED at 25 s+, so a
      // single listing right after `teardown` returned failed a 40-minute
      // real-money round for substrate latency. `awaitBoxAbsent` only looks —
      // unlike `fleetLeftovers` it does not destroy a survivor first, so it
      // cannot report clean for a teardown that destroyed nothing.
      const gone = await awaitBoxAbsent(ctx.driver, vm, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // NO bespoke key revoke here any more, and its absence is the C16 change
      // completing rather than a deleted safety net. What stood here revoked the
      // SECOND key this test used to mint — a key on a `<runId>-resident` record
      // that `keyLeakProblems` below was never told about, so this block was
      // genuinely the only thing between it and outliving the round. There is
      // now one key, it is on THIS run's record, and two things already cover
      // it: `teardownQuietly` runs the production revoke on the failure path
      // exactly as step 8 does on the success path, and `keyLeakProblems`
      // renders the account population delta and fires `revokeQuietly` against
      // `runIds: [runId]` on anything that survived. The hygiene got stronger,
      // not weaker: the fallback is now record-backed rather than dependent on a
      // hash this body had to reach far enough to capture.
      if (runId !== "" && workspace !== "") {
        // `teardownQuietly`, not a bare `runFleet` (F2): the 180 s ceiling
        // REJECTS out of this `finally` at the await, skipping the box destroy
        // below, the leftover sweep, the evidence write and `settleRun` — with
        // a resident box, the most expensive one this suite creates, still up.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
          { at: "teardown", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vm !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // `fleetLeftovers`, not a single-shot `list()`: the substrate's destroy
      // lag is MEASURED at 25 s+ (r7-T-h1), and this site listed exactly once,
      // milliseconds after `destroyQuietly` — a correct cleanup inside the
      // known lag window failed a 40-minute real-money round. The helper polls
      // 5 × 8 s, destroys owned survivors before rendering a verdict, and warns
      // (never fails) on boxes this run cannot prove it owns. It NEVER throws,
      // so no try/catch — one here would swallow the `owned: undefined` that
      // `fleetCleanupProblems` renders as "an unmeasured fleet is never clean".
      finalBoxes = (await fleetLeftovers(ctx.driver, [vm, runId], evidence)).owned;
      // The KEY leak verdict, beside the box one (F17). With one key, on this
      // run's record, this IS the whole check: the delta names anything the
      // account gained across the round, `revokeQuietly` kills what the teardown
      // left behind, and a round that needed the fallback is reported as unclean
      // because needing it is itself the defect.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: store ?? (workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") })),
          runIds: [runId],
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T4", "t4-resident-live", { test: "T4", outcome, runId, capMicroUsd: T4_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM, and this is
      // the LAST statement of the `finally` — a throw here discards the held
      // `failure` and skips `settleRun` entirely.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T4] workspace kept for forensics: ${workspace}\n`);
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run. ────────
    // `evidence` as the third arg folds `finally-revoke ok:false` entries into
    // the verdict — the fold-in T5.1 was doing by hand and every other tier
    // was missing, so a fallback revoke that failed was evidence prose only.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  T4_TEST_TIMEOUT_MS,
);
