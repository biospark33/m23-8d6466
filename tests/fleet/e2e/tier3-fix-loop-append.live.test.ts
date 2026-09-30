/**
 * T6.1a — DF6.1a's MANDATORY live demo (story DoD "Test (e2e demo — MANDATORY)"
 * + "Test (locality is proven, not asserted — same e2e round)", PLAN C22):
 * one bot review comment set on a real factory PR drives ONE bounded fix
 * attempt on a real box, one real operator approval, and one verified append
 * to the PR branch — or a refusal that costs nothing.
 *
 * The shape, verbatim from the DoD:
 *
 *   `bun scripts/fix-run.ts --pr <n>` (inv1) → one fix run IN-BOX → DF3.7's
 *   chain drives harvest → teardown → host-side re-verify green → exit 0
 *   reporting `state:"awaiting-approval"` → `fleet approve <run-id>` records
 *   this attempt's ApprovalRecord → `bun scripts/fix-run.ts --pr <n>` (inv2)
 *   → one appended commit on the PR branch → `fixContext` with `attemptSha`
 *   on the fix run's record, evidenced by the PR on GitHub.
 *
 * THE ROUND RUNS AGAINST A DISPOSABLE REPOSITORY — never QDS-Factory itself,
 * which would point an autonomous fix loop at the factory's own PRs (DoD
 * verbatim). The operator-prepared environment is VERIFIED pre-spend, and the
 * round REFUSES LOUDLY with setup instructions when any leg is absent (the
 * tier1-registry-auth posture: missing substrate THROWS, never skips):
 *
 *   (i)   branch protection marks ≥1 fast check REQUIRED on the disposable
 *         repo's base branch (DF6.1b reuses this environment; at THIS story's
 *         merge point no code reads it, but a round that proves the
 *         environment proves all of it);
 *   (ii)  bot review capability: the PR carries ≥1 review comment from a
 *         Bot-type or [bot]-suffixed author, AND ≥1 of those survives
 *         fetchBotComments' briefability filter (a PR whose only bot comment
 *         is unbriefable makes inv1 a `no-bot-comments` no-op, not a fix run);
 *   (iii) an OPEN PR on the disposable repo, authored by the repos.json
 *         entry's authorLogin, head branch `qds/<runId>` of minted grammar —
 *         the round does NOT produce this PR (producing it via a factory run
 *         would spend a second box; the story's worst case is 1 box + 1 key).
 *         The environment supplies it via QDS_E2E_FIX_PR; absent ⇒ THROW with
 *         the setup recipe;
 *   (iv)  a `.factory/fix-scope.json` entry for the disposable repo's slug,
 *         verified present BEFORE any spend through readFixScope itself — the
 *         same read the CLI's attempt-start probe runs, so the pre-check
 *         cannot drift from the thing it pre-checks.
 *
 * Plus three pre-spend legs the DoD's four do not name, each guarding a
 * guaranteed PAID failure with a free read: the roster the fix manifest names
 * passes AC5's single-fixer guard (assertSingleFixer over the real
 * config/rosters/roster.yaml — a refusal there costs no box, but a round that
 * dies on it proved nothing); `.factory/pipeline.json` keys a host plan for
 * the disposable slug and the plan file exists (the chain's re-verify judges
 * through it AFTER the box billed — a missing plan is a `vetoed`/exit-6 round
 * that spent its box for nothing); and `config/rosters/fix-run.pipeline.json`
 * exists in the checkout AND, when QDS_EXEDEV_SHA resolves locally, inside
 * that commit (the box-side manifest is delivered from the pushed tree — an
 * uncommitted manifest is the classic paid-round death; the PUSHED half of
 * that check is the driver's pre-round checklist, per the qds-live-e2e
 * skill). A sixth read proves the disposable repo carries
 * `config/rosters/roster.yaml` at the PR head (PLAN I13: in-box the roster
 * loads from the box checkout — e2e prep owns pushing it there).
 *
 * WHICH GITHUB CLIENT, and why: the shipped GitHubApi seam (`httpGitHubApi()`)
 * authenticated by `readHostToken()` — the EXACT credential path and client
 * the CLI under test uses, so a green pre-flight proves the token works the
 * way inv1/inv2 will consume it. `gh api` was the alternative and was
 * rejected: it proves gh's OWN auth, leaving the keychain entry
 * `qds-factory-github` — the thing fix-run actually reads — unverified, and
 * adds a binary the harness does not otherwise need. The two reads the seam
 * does not declare (the PR's AUTHOR login — `PullRequestInfo` drops `user` —
 * and branch protection) go through the SAME host token via
 * `src/lib/http.ts`'s httpRequest, mirroring github.ts's own policy (30 s,
 * one retry on 5xx/429, GETs only). One credential path, no new dependency.
 *
 * THE NEGATIVE CONTROL rides the same round and is FREE: with the slug's
 * fix-scope entry absent (a scratch hostRoot whose `.factory/fix-scope.json`
 * carries `scopes: {}` — the OPERATOR'S real `.factory/fix-scope.json` is
 * never mutated; a crash mid-edit there would disarm AC6's enforcement for
 * the whole host), `fix-run --pr <n>` must refuse `fix-scope-missing` exit 5
 * BEFORE any box exists. Proven three ways: the exit code + the typed
 * envelope on stderr, the records dir still holding ONLY the parent record
 * (no dispatch ⇒ no fix-run record), and a driver.list delta with zero new
 * qds-/e2e- prefixed boxes. The scratch hostRoot works because the probe ordering
 * (scripts/fix-run.ts) runs readFixScope(hostRoot) BEFORE the roster load and
 * the dispatch — the refusal needs no other file under hostRoot, and
 * `--repos-file` points at the real `.factory/repos.json` for the join.
 *
 * LOCALITY IS PROVEN, NOT ASSERTED (DoD verbatim), all three legs DURING
 * inv1, because inv1's own chain destroys the box before it returns:
 *   (a) the fix run's terminal marker is read from
 *       `/run/qds-run/<run-id>/journal/final.json` THROUGH `readBoxFile` — a
 *       path that exists only inside the box. The test polls through the same
 *       shipped read/classify primitives the sweep uses (read-only, never a
 *       fleet verb), so the settled reading is the ENGINE's bytes, observed
 *       while the box lives. The poll races the chain's own observer: after
 *       the chain's settled read it still harvests (a bundle fetch) before
 *       teardown, so a 5 s tick lands inside that window on any healthy
 *       round; a round where inv1 exits 0 with the settled reading never
 *       observed fails BY NAME as a lost race, never silently;
 *   (b) `systemctl show qds-run@<run-id>.service -p ExecMainStartTimestamp`
 *       on the box reports a start — the UNIT, not an exec, ran the engine.
 *       Captured per poll tick from the moment the record names a vmName, so
 *       the whole engine walk is the capture window — never a race against
 *       teardown;
 *   (c) no `pi` process on the HOST for the run's duration: `ps -ax -o
 *       command` snapshots before inv1 and after inv2, diffed for any NEW
 *       line whose argv matches `pi ` (word-boundaried, so `api` and
 *       `scripts/pi-lens-verify.ts` cannot trip it) or `--provider`. A
 *       pre-existing operator pi sits in BOTH snapshots and diffs to nothing.
 * An implementation satisfying the chain by exec'ing the worker argv from the
 * host passes every other leg and MUST fail this one — the tier2-placement
 * ADR's own failure mode ("no AC tested locality"), now observable.
 *
 * THE APPROVAL IS IN-HARNESS, T1.7's exact shape: the fix run's pause is
 * decided by a real `fleet approve <fixRunId> --dir <recordsDir>` subprocess
 * with the approver token on fd 0 (a 0600 file, `runFleetWithToken`), against
 * a real `.factory/approvers.json` UNDER THE RECORDS DIR (DF3.4 round-9 C10:
 * `--dir` is the allowlist root), hashed with the one formula the factory
 * verifies against (`scryptToken` + `SCRYPT_PARAMS` — never a hand-computed
 * digest). The token's absence from every captured stream is asserted BEFORE
 * the tails enter evidence.
 *
 * WHERE THINGS RUN, and why REPO_ROOT is inv1/inv2's cwd: fix-run resolves
 * `.factory/fix-scope.json`, `.factory/repos.json`, the roster and the
 * manifest containment root from process.cwd(), its chain harvests
 * `refs/sandbox/<fixRunId>` into the cwd's git (which is also what makes the
 * story's `git merge-base --is-ancestor` check runnable host-side — the
 * harvested tip's ancestry carries the PR head's objects), inv2's
 * `git diff --name-status <pinned>..<approved>` runs against that object
 * store, and `pushVerifiedSha` pushes from it. That IS the production shape —
 * the operator runs this CLI from the factory checkout. The round's own
 * debris there (`refs/sandbox/<fixRunId>`, `.sandbox/reverify/<fixRunId>.jsonl`)
 * is removed in the finally on a FULL-green round and named in evidence as
 * kept forensics on a red one. Records, the bundle, the cost ledger and the
 * approver allowlist all live under the round's own workspace, with the
 * cost-config.json BESIDE the records dir (costLedgerOpts), carrying the
 * per-issue override the ceiling pre-flight demands: parentSpend(0) + 8 ×
 * defaultKeyCapMicroUsd, computed from the imported constant, never a copied
 * literal. The parent run record — the CLI's PR↔run join key — is CONSTRUCTED
 * in that store from GitHub-verified facts (runId off the head branch, PR
 * number/url off the API, slug/issueId the round controls): the story charges
 * the ENVIRONMENT with the PR (iii), and a record built from facts this test
 * just verified against the live API proves more than an operator-placed file
 * the test would have to trust. `issueId` = the PR number: the per-issue
 * ceiling is round-scoped bookkeeping in the round's own throwaway ledger,
 * and the PR number is the one stable integer the environment guarantees.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — `liveGate("2")` throws on a
 * tier mismatch or a half-configured substrate env. The "tier3" FILENAME is
 * the audit-wave label (the host-orchestration shape tier3-race/tier3-
 * observe-detached hold: a host-supervised in-box engine with locality legs),
 * NOT an env value — `liveGate` takes only "1"|"2". Normal `bun test`/CI:
 * todo. Execution of this round is the DF6.1a branch gate, run by the driver
 * (node-2) via the qds-live-e2e skill with the operator's explicit go —
 * never from the authoring leaf.
 *
 * SPEND (the story's only live-spend item; estimate printed to stderr at the
 * top of the body, operator go taken out of band by the driver before the
 * round, e2e budget protocol): ONE fix-run dispatch — 1 box + 1 key. The
 * round's APPROVED envelope is ≤ 50,000 µ$ of model draw (asserted at the
 * record's close-captured spendMicroUsd) + box-hours bounded by
 * T61A_BOX_HOURS_CEILING_MICRO_USD (≈ 393,556 µ$ at the planned window)
 * ≈ $0.45 worst planned. NAMED, not approved as expectation: the key's
 * provider-side hard limit is the CLI's COMPILED ceiling — fix-run passes
 * defaultKeyCapMicroUsd (50,000,000 µ$) as its dispatch cap, so the minted
 * limit is min(50M, the 400M issue headroom) = $50. Nothing in this leaf can
 * lower that without editing the CLI; the 50,000 µ$ assertion below is the
 * story's own budget figure, and a healthy round lands far under it (the fix
 * manifest caps the fix phase at 600 s of two cheap roster models + the
 * setup gate's C/D pings). finally: teardownQuietly/destroyQuietly +
 * keyLeakProblems against the listedKeyHashes baseline + fleetLeftovers
 * final-ls asserting zero owned qds-* boxes — and the chain's own teardown
 * already revoked the key inside inv1, machine-checked in-body too.
 *
 * LIVE-ROUND RUNNER (L16): the whole file is ONE todoIf test — a round that
 * never selected it reports one `(todo)` and a green summary. Name this path
 * EXPLICITLY and check for its evidence JSON
 * (`_bmad-output/evidence/df3-e2e/<date>-*-df6-1a-fix-loop-append-*.json`).
 * Exit 0 with zero `(pass)` is a MISCONFIGURED run (skill gotcha #16), never
 * a pass.
 *
 * NO FAKES of any kind: real ssh exec, real systemd, real OpenRouter key API,
 * real `bun scripts/fix-run.ts` / `bun scripts/fleet.ts` subprocesses, real
 * GitHub API through the shipped seam, real git object store.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The marker path and the classifier come from the shipped constants — never
// an inlined literal — so this file, `fleet status`, the sweep and the chain's
// own observer address one path by construction.
import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
import { runUnitName } from "../../../src/fleet/run.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import type { BoxFileRead } from "../../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// Verb tails are pre-redacted (B24: a tail slice can CUT a credential
// mid-token, which the evidence scrub cannot match but its refusal assert
// hits — a paid round would leave NO evidence file).
import { redactSecrets } from "../../../src/providers/step-log.ts";
import { defaultKeyCapMicroUsd } from "../../../src/providers/credentials.ts";
import { canonicalIssueId } from "../../../src/providers/cost-ledger.ts";
import { canonicalRepoSlug } from "../../../src/phase-engine/issue-correlation.ts";
import { loadRoster } from "../../../src/phase-engine/roster/schema.ts";
import { httpGitHubApi, readHostToken, API_TIMEOUT_MS } from "../../../src/pr/github.ts";
import { resolveRepoEntry } from "../../../src/pr/repos.ts";
import {
  assertSingleFixer,
  buildFixContextPayload,
  fetchBotComments,
  FIX_RUN_MANIFEST_PATH,
  parseFixContext,
  readFixScope,
  type BotCommentSet,
} from "../../../src/fixloop/index.ts";
import { DEFAULT_REVERIFY_DIR } from "../../../src/reverify/report.ts";
import { scryptToken, SCRYPT_PARAMS } from "../../../src/fleet/approvers.ts";
import { httpRequest, retryAfterMs } from "../../../src/lib/http.ts";
import type { LiveCtx, RunFleetResult } from "./live-harness.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitWithCeiling,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  lastJsonLine,
  ledgerRows,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  runFleetWithToken,
  RunFleetTimeoutError,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** The round's APPROVED model draw (e2e-plan default: 50,000 µ$ = $0.05) — asserted at close. */
const T61A_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T61A_BOX_HOUR_RATE_MICRO_USD = 230_000;

/**
 * The disposable repository this round runs against (DoD: never QDS-Factory
 * itself). The e2e driver environment's `.factory/repos.json` registers it
 * with `authorLogin: "biospark33"` (both casings — resolveRepoEntry's own
 * discipline); the entry is READ through resolveRepoEntry below, so a
 * deregistered environment fails by name, never by assumption.
 */
const DISPOSABLE_REPO_SLUG = "Quantum-Digital-Solutions/qds-audit-demo";

/**
 * The environment's PR pointer: the OPEN, DF5.2-produced PR on the disposable
 * repo (head branch `qds/<runId>`, a real bot review comment) the round acts
 * on. Required when live — absent, the test THROWS with the setup recipe
 * (missing substrate throws; it never skips).
 */
const FIX_PR_ENV = "QDS_E2E_FIX_PR";

/** The approver the round's allowlist registers. Obviously not a person's real id. */
const APPROVER_ID = "e2e-df61a-operator@example.test";
/** Obviously-fake sentinel; only its SALTED HASH is ever written to disk. */
const APPROVER_TOKEN = "fake-df61a-approver-token-do-not-reuse";
const APPROVER_SALT = "e2e-df61a-salt";

/**
 * The bun runner ceiling for this whole test — the budget audit at the foot of
 * the file prices every inner ceiling up to this total plus margin.
 */
const T61A_RUNNER_TIMEOUT_MS = 9_000_000;

/**
 * The inv1 supervision ceiling — ONE deadline over the whole leg (record-poll
 * + marker-poll + exit-await), priced as: dispatch 900 (box provision + the
 * A–E setup gate, T2.2's figure for the same verb) + credential probe 120 +
 * unit start 180 + engine window 2 100 (the fix manifest's runBudgetMs is
 * 1 900 s; 2 100 covers it plus the marker settle, the degraded-round class)
 * + chain 900 (harvest ~300 + teardown ~180 + reverify, T5.1's measured 420
 * ceiling class, + margin). A ceiling rejection here KILLS the subprocess and
 * the finally recovers the ids from the fix run's RECORD — see the finally.
 */
const T61A_INV1_TIMEOUT_MS = 4_200_000;

/**
 * How long the marker/locality poll runs inside the inv1 leg before it fails
 * by name. Priced above the fix manifest's own runBudgetMs (1 900 000 ms) so
 * an engine that spends its whole declared budget still settles inside the
 * window, with 200 s of margin for the journal's temp+rename publish.
 */
const T61A_ENGINE_WINDOW_MS = 2_100_000;

/** The poll tick — each cycle is one bounded `readBoxFile` (10 s class). */
const T61A_POLL_INTERVAL_MS = 5_000;

/** The negative-control fix-run ceiling: record reads + two GitHub GETs + the refusal — no box leg exists on this path. */
const T61A_NEG_CONTROL_TIMEOUT_MS = 300_000;

/** The approve verb's subprocess ceiling (T1.7's figure). */
const T61A_APPROVE_TIMEOUT_MS = 120_000;

/** The inv2 ceiling: binding + lock + local git diff + scope + a fresh comment read + preflight + a real push + one record write. */
const T61A_INV2_TIMEOUT_MS = 420_000;

/**
 * The PR-settle window: the append's own push precedes the remote read by
 * seconds and GitHub's PR GET can still serve the pre-push head through its
 * cache (measured live 2026-09-21, evidence 2026-09-21-000025's successor), so
 * a minute of re-reads closes the cache. Transient read errors are absorbed to
 * this deadline; a 404 is terminal inside it.
 */
const T61A_PR_SETTLE_WINDOW_MS = 60_000;

/** The PR-settle tick — one cheap GitHub PR GET per cycle. */
const T61A_PR_SETTLE_INTERVAL_MS = 5_000;

/** The post-dispatch positive-control `driver.list()` ceiling (T3.8's T26 shape — a raw driver await gets a named bound). */
const T61A_LIST_CEILING_MS = 120_000;

/** The F17 key-listing ceiling (T3.8's named figure for the same raw HTTP walk). */
const T61A_KEY_LIST_CEILING_MS = 240_000;

/** The cleanup `fleet teardown` ceiling (T2.2's finally figure). */
const T61A_CLEANUP_TEARDOWN_TIMEOUT_MS = 180_000;

/**
 * The poll's consecutive-unreadable fast-fail bound (T3.8's T32 verbatim):
 * ten consecutive rejected reads / `skip` verdicts (≤ ~2.5 min) means the
 * marker is persistently UNREADABLE — the box wedged or already gone — not
 * absent and not slow. Fail then, before the window bills the rest of itself.
 */
const T61A_POLL_UNREADABLE_LIMIT = 10;

/**
 * The PLANNED box-billing window: the box is created inside inv1's dispatch
 * and destroyed by inv1's own chain, so its whole life is inside
 * T61A_INV1_TIMEOUT_MS (4 200 s) — plus the post-destroy tail (destroy-confirm
 * 600 + the fleetLeftovers lag poll 1 360) as headroom, because the
 * substrate's destroy lag means billing realistically stops somewhere inside
 * the poll. = 6 160 s ≈ 1.71 h.
 */
const T61A_BOX_PLANNED_WINDOW_MS = T61A_INV1_TIMEOUT_MS + 600_000 + 1_360_000;

/**
 * The box-hours ceiling: the PLANNED window at the configured rate — 6 160 000
 * ms × 230 000 µ$/h ≈ 393 556 µ$. Derived from the plan, not the runner
 * ceiling (T3.8's T31 lesson: a runner-derived bound can only fire on the
 * abort path where no assertion runs — this one fails a COMPLETED round that
 * out-bills its plan while every other assertion still ran).
 */
const T61A_BOX_HOURS_CEILING_MICRO_USD = Math.ceil((T61A_BOX_PLANNED_WINDOW_MS / 3_600_000) * T61A_BOX_HOUR_RATE_MICRO_USD);

/**
 * The issue-ceiling override the round's cost-config.json declares. The CLI's
 * pre-flight formula (assertFixCeilingCovered) is parentSpend + 8 × cap with
 * cap = defaultKeyCapMicroUsd on this CLI (its compiled constant) — computed
 * from the import so a change to the constant re-prices the round instead of
 * stranding it on a copied literal.
 */
const T61A_ISSUE_CEILING_OVERRIDE_MICRO_USD = 8 * defaultKeyCapMicroUsd;

/**
 * Every `{…}` JSON line a verb wrote on a stream, parsed defensively and
 * REDACTED at parse (T3.8's B24 rule applied to structured lines: a
 * secret-like field inside a parsed line reaches the evidence write raw, and
 * `writeEvidence`'s scrub REFUSAL on it would leave a paid round with no
 * evidence file at all). Lines starting with `{` that do not parse are
 * counted, never dropped silently.
 */
function jsonLines(text: string): { lines: Record<string, unknown>[]; dropped: { count: number; first: string } } {
  const lines: Record<string, unknown>[] = [];
  let droppedCount = 0;
  let firstDropped = "";
  for (const l of text.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(redactSecrets(l)) as Record<string, unknown>);
    } catch {
      droppedCount += 1;
      if (firstDropped === "") firstDropped = redactSecrets(l.trim().slice(0, 300));
    }
  }
  return { lines, dropped: { count: droppedCount, first: firstDropped } };
}

/**
 * A real `bun scripts/fix-run.ts …` subprocess, awaited, with runFleet's
 * whole-drain ceiling semantics (the harness's runFleet is hardcoded to
 * scripts/fleet.ts; this is the same shape pointed at the CLI under test).
 * The ceiling kills the child FIRST and rejects with a RunFleetTimeoutError
 * carrying whatever already landed on the pipes, so `fleetPartialOutput`-style
 * recovery and the evidence tails keep the partial bytes.
 */
async function runFixRun(
  argv: readonly string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunFleetResult> {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fix-run.ts"), ...argv],
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const outDrain = new Response(proc.stdout).text();
  const errDrain = new Response(proc.stderr).text();
  const drained = Promise.all([outDrain, errDrain]);
  drained.catch(() => {}); // dropped, never unhandled, when the ceiling fires
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([proc.exited, drained]).then(([code, [out, err]]) => [code, out, err] as const),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Kill FIRST, then race the drain against a 5 s grace: the kill
          // closes the child's pipe ends, so whatever already landed settles
          // the drain within milliseconds on every real path — the partials
          // are the refusal envelope / ack text the caller's evidence and
          // recovery read, and a ceiling that discarded them would be total
          // amnesia on the one path that needs them (runFleet's L1).
          proc.kill();
          void Promise.race([
            drained,
            new Promise<[string, string]>((r) => setTimeout(() => r(["", ""]), 5_000)),
          ]).then(([out, err]) =>
            reject(new RunFleetTimeoutError(`runFixRun timeout after ${opts.timeoutMs} ms: fix-run ${argv.join(" ")}`, out, err)),
          );
        }, opts.timeoutMs);
      }),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill(); // no-op on an exited process
  }
}

/** `runFixRun` WITHOUT awaiting — the inv1 shape, so the locality legs can observe the box DURING the verb. `output` resolves once BOTH pipes close; read it only after `exited` settles. */
function spawnFixRun(
  argv: readonly string[],
  opts: { cwd: string },
): { exited: Promise<number | null>; output: Promise<{ stdout: string; stderr: string }>; kill: () => void } {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fix-run.ts"), ...argv],
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    output: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
      ([stdout, stderr]) => ({ stdout, stderr }),
    ),
    kill: () => proc.kill(),
  };
}

/**
 * The host process table as a SET of full-command lines — locality leg (c)'s
 * snapshot. `ps -ax -o command` (the macOS/Linux-common spelling of the
 * story's `ps -ax -o comm,args`): every process with its argv, header line
 * dropped. The SET is the diff substrate: a line present in both snapshots
 * (a long-lived operator pi, this test's own runner) can never be a hit.
 */
function hostProcessTable(): Set<string> {
  const ps = Bun.spawnSync({ cmd: ["ps", "-ax", "-o", "command"], stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) {
    throw new Error(`ps -ax -o command exited ${ps.exitCode}: ${redactSecrets(ps.stderr.toString().trim().slice(0, 200))} — locality leg (c) cannot render a verdict without a process table`);
  }
  const lines = ps.stdout.toString().split("\n").slice(1).map((l) => l.trim()).filter((l) => l !== "");
  return new Set(lines);
}

/**
 * The story's match vocabulary, verbatim: any argv containing `pi ` or
 * `--provider`. The `pi` arm is word-boundaried on the LEFT and whitespace- or
 * end-terminated on the RIGHT, so `api`, `scripts/pi-lens-verify.ts` and
 * `~/.pi/agent/auth.json` (a path, not a process named pi) cannot trip it —
 * the process the leg exists to catch is a host-spawned `pi …` worker argv.
 */
const PI_ARGV_RE = /(?:^|\s)pi(?:\s|$)|--provider(?:[\s=]|$)/;

function piArgvHits(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const line of after) {
    if (!before.has(line) && PI_ARGV_RE.test(line)) hits.push(redactSecrets(line.slice(0, 300)));
  }
  return hits;
}

/**
 * An authenticated GET against api.github.com through `src/lib/http.ts`,
 * mirroring github.ts's OWN policy (30 s, one retry on 5xx/429, the same
 * headers) — for the two pre-spend reads the GitHubApi seam does not declare:
 * the PR's author login and branch protection. The token rides the
 * authorization header (INV-PR-2: call argument, never module state); the
 * error path never echoes more than 200 chars of an authenticated body.
 */
async function ghGetJson(token: string, path: string): Promise<unknown> {
  const { text } = await httpRequest(
    `https://api.github.com${path}`,
    { method: "GET" },
    {
      timeoutMs: API_TIMEOUT_MS,
      maxAttempts: 2,
      retryTransport: true,
      retryOn: (r) => r.status >= 500 || r.status === 429,
      retryDelayMs: (r) => (r.status === 429 ? retryAfterMs(r) : 1_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "qds-factory",
      },
      onHttpError: (r, body) => new Error(`GET ${path} failed: ${r.status} ${body.slice(0, 200)}`),
    },
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${path} returned unparseable JSON (${text.length} bytes)`);
  }
}

/** The minted-run-id grammar, anchored for the head-branch join — dispatch's own MINTED_RUN_ID_RE shape. */
const HEAD_BRANCH_RUN_ID_RE = /^qds\/(qds-\d{8}-[a-f0-9]{6})$/;

test.todoIf(liveTodoOff())(
  "T6.1a DF6.1a: fix-scope-missing refuses FREE before any box → inv1 fix run IN-BOX (locality: readBoxFile marker, systemctl unit start, no host pi) → awaiting-approval → fleet approve → inv2 appends the verified commit → fixContext carries attemptSha, differing from placeholders in exactly two fields — real box, real spend ≤ 50,000 µ$ + box-hours",
  async () => {
    liveGate("2");
    // The estimate print (e2e budget protocol hard rule 2) — the operator go
    // itself is taken out of band by the driver before the round; this line is
    // what the round's log shows for what was approved.
    try {
      process.stderr.write(
        `[T6.1a] SPEND ESTIMATE: 1 box + 1 key. Approved envelope: ≤ ${T61A_CAP_MICRO_USD} µ$ model draw + box-hours ≤ ${T61A_BOX_HOURS_CEILING_MICRO_USD} µ$ (planned window ${T61A_BOX_PLANNED_WINDOW_MS} ms at ${T61A_BOX_HOUR_RATE_MICRO_USD} µ$/h). NAMED backstop: the key's provider hard limit is the CLI's compiled ceiling min(defaultKeyCapMicroUsd=${defaultKeyCapMicroUsd}, issue headroom ${T61A_ISSUE_CEILING_OVERRIDE_MICRO_USD}).\n`,
      );
    } catch {
      // dead stderr under an aborting runner — the evidence carries the same figures
    }
    // REFUSED BEFORE ANY SPEND (T2.2's belt-and-braces tripwire class): stray
    // host exports that would silently redirect the round's money or boxes.
    // QDS_RUN_ROOT is a host-side test lever the box never sets; this file and
    // the CLI both address the box through the imported boxMarkerPath, so the
    // refusal is the tripwire for the shell, not a load-bearing guard.
    const hostRunRoot = (process.env.QDS_RUN_ROOT ?? "").trim();
    if (hostRunRoot !== "") {
      throw new Error(
        `QDS_RUN_ROOT is exported host-side as ${JSON.stringify(hostRunRoot)}. It is a HOST-side test lever the box never sets, and no live round should inherit one — unset it and re-run.`,
      );
    }
    // A stray QDS_COST_CONFIG_FILE / QDS_COST_LEDGER_FILE export wins over the
    // cost config this file writes beside its own records dir, so the fix
    // run would admit under a FOREIGN cap and its box-hours would settle into
    // an OUTSIDE ledger — both silently defeating the figures this round is
    // approved for.
    for (const name of ["QDS_COST_CONFIG_FILE", "QDS_COST_LEDGER_FILE"]) {
      const value = (process.env[name] ?? "").trim();
      if (value !== "") {
        throw new Error(
          `${name} is exported host-side as ${JSON.stringify(value)}. This round must admit under the cost config it writes beside its own records and settle box-hours into the ledger inside them — unset it and re-run.`,
        );
      }
    }
    // fix-run resolves its driver from $QDS_PROVIDER_DRIVER ?? "exedev". A
    // stray export would send the round's dispatch to a different provider
    // than the one the spend protocol and the finally's cleanup address.
    const providerDriver = (process.env.QDS_PROVIDER_DRIVER ?? "").trim();
    if (providerDriver !== "") {
      throw new Error(
        `QDS_PROVIDER_DRIVER is exported host-side as ${JSON.stringify(providerDriver)}. fix-run reads it for its driver resolution and this round must use the exedev default — unset it and re-run.`,
      );
    }
    const evidence: Record<string, unknown>[] = [];
    let ctx: LiveCtx | undefined;
    let workspace = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** The fix run's identity — filled from its RECORD the moment dispatch creates it. */
    let fixRunId = "";
    let fixVmName = "";
    /** The parent run's id — off the PR's head branch, the CLI's join key. */
    let parentRunId = "";
    let prNumber = 0;
    /**
     * The out-of-band reaper's handle (T3.8's P11): created BEFORE inv1, armed
     * with {runId, vmName, keyHash} as they become known, tombstoned only when
     * this finally actually finished the recovery it exists to trigger.
     */
    let orphanRecoveryPath = "";
    /** inv1's handle, hoisted so the finally can kill and drain a stranded verb. */
    let inv1: { exited: Promise<number | null>; output: Promise<{ stdout: string; stderr: string }>; kill: () => void } | undefined;
    let inv1Output: { stdout: string; stderr: string } | undefined;
    /** Destroys that FAILED (#189) — asserted AFTER the finally, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /** The F17 key-population verdict, rendered in the finally. */
    let keyProblems: string[] = [];
    /** Key hashes before the run (F17) — snapshotted INSIDE the try (P28). */
    let hashesBefore: Set<string> | undefined;
    try {
      ctx = await preflight("2");
      hashesBefore = await listedKeyHashes();

      // ── 0a. the environment's PR pointer — missing substrate THROWS ──────
      const prRaw = (process.env[FIX_PR_ENV] ?? "").trim();
      if (!/^\d+$/.test(prRaw) || Number(prRaw) <= 0) {
        throw new Error(
          `${FIX_PR_ENV} is ${prRaw === "" ? "unset" : JSON.stringify(prRaw)} — this round acts on the operator-prepared OPEN PR on ${DISPOSABLE_REPO_SLUG} (DF5.2-produced under the repos.json entry's authorLogin, head branch qds/<runId>, carrying ≥1 real bot review comment), and refuses to guess one. Setup: produce the PR through a DF5.2 run against the disposable repo, confirm the review bot answered it, then export ${FIX_PR_ENV}=<number> and re-run. The repo is RETAINED for DF6.1b's demo (story DoD).`,
        );
      }
      prNumber = Number(prRaw);

      workspace = tmpWorkspace("t61a");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      orphanRecoveryPath = join(workspace, "orphan-recovery.json");
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ phase: "pre-dispatch" })}\n`);
      evidence.push({
        phase: "orphan-recovery-file",
        path: orphanRecoveryPath,
        note: "{runId, vmName, keyHash} for an out-of-band reaper if this process dies owning a box or key — kept on failure, removed only on full green success",
      });

      // ── 0b. the host token — the same read the CLI will do ───────────────
      const hostToken = await readHostToken();
      if (hostToken === null || hostToken === "") {
        throw new Error(
          "no host GitHub token is available (keychain entry qds-factory-github empty and stdin not piped) — fix-run would refuse no-host-token at invocation; store the token in the keychain and re-run. The value is never printed, here or by the CLI.",
        );
      }
      const github = httpGitHubApi();

      // ── 0c. the environment, VERIFIED pre-spend (legs i–iv + the paid-     ──
      // ── failure guards the DoD does not name) — every read free ──────────
      const repoEntry = resolveRepoEntry(REPO_ROOT, DISPOSABLE_REPO_SLUG);
      const { owner, repo } = repoEntry;
      evidence.push({ phase: "env-repos-entry", ok: true, slug: DISPOSABLE_REPO_SLUG, baseBranch: repoEntry.baseBranch, authorLogin: repoEntry.authorLogin });

      // (iv) FIRST, because it is the round's runnability gate: the slug's
      // fix-scope entry, read through the CLI's OWN attempt-start probe read.
      // A throw here is readFixScope's own fix-scope-missing refusal — the
      // exact verdict inv1 would render after the join, rendered for free.
      let scopeEntrySummary: Record<string, unknown>;
      try {
        const scope = readFixScope(REPO_ROOT, DISPOSABLE_REPO_SLUG);
        scopeEntrySummary = {
          allowedPathGlobs: scope.allowedPathGlobs,
          deniedGlobs: scope.deniedPathGlobs.map((d) => d.glob),
          permittedActions: scope.permittedActions,
        };
      } catch (e) {
        throw new Error(
          `environment leg (iv) failed pre-spend: ${(e as Error).message} — register ${DISPOSABLE_REPO_SLUG} under "scopes" in .factory/fix-scope.json (the shipped default: allow src/**, tests/**, scripts/** with the verification-surface deny-list) and re-run. No box exists yet; nothing was spent.`,
        );
      }
      evidence.push({ phase: "env-fix-scope", ok: true, slug: DISPOSABLE_REPO_SLUG, ...scopeEntrySummary });

      // The token's identity must BE the entry's authorLogin (DF5.2 AC5's own
      // comparison): the bot reviews PRs by that identity, so this loop's only
      // trigger exists only for PRs by that identity.
      const tokenLogin = await github.authenticatedLogin(hostToken);
      evidence.push({ phase: "env-token-login", ok: tokenLogin === repoEntry.authorLogin, tokenLogin, authorLogin: repoEntry.authorLogin });
      if (tokenLogin !== repoEntry.authorLogin) {
        throw new Error(
          `the host token authenticates as ${JSON.stringify(tokenLogin)}, but the repos.json entry for ${DISPOSABLE_REPO_SLUG} binds authorLogin ${JSON.stringify(repoEntry.authorLogin)} — a PR opened by the wrong identity gets no bot review, so this loop's only trigger never fires (story Infra Prerequisites). Fix the keychain entry qds-factory-github or the allowlist, then re-run.`,
        );
      }

      // (iii) the PR: OPEN, unmerged, head branch qds/<runId> of minted grammar.
      const pr = await github.getPullRequest({ owner, repo, prNumber, token: hostToken });
      if (pr === null) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber} does not exist (404) — ${FIX_PR_ENV} names a PR that is not there. Produce the DF5.2 PR on the disposable repo and re-export ${FIX_PR_ENV}.`,
        );
      }
      if (pr.state !== "open" || pr.merged) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber} is ${pr.merged ? "merged" : pr.state} — the fix loop acts on an OPEN PR (a closed/merged one is a designed no-op, and a no-op proves nothing). Produce a fresh DF5.2 PR and re-export ${FIX_PR_ENV}.`,
        );
      }
      const branchMatch = HEAD_BRANCH_RUN_ID_RE.exec(pr.headRefName);
      if (branchMatch === null) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber}'s head branch ${JSON.stringify(pr.headRefName)} is not qds/<runId> of minted grammar — fix-run would refuse not-a-factory-pr. Point ${FIX_PR_ENV} at a factory-opened PR.`,
        );
      }
      parentRunId = branchMatch[1] as string;
      const prHeadBefore = pr.headSha;
      if (!/^[0-9a-f]{40}$/.test(prHeadBefore)) {
        throw new Error(`${DISPOSABLE_REPO_SLUG}#${prNumber} carries an unreadable head sha ${JSON.stringify(prHeadBefore)} — the attempt's pinned base must be a full sha`);
      }
      // The AUTHOR — the one field the seam's PullRequestInfo drops — through
      // the same token via httpRequest (see the header's client justification).
      const prRawJson = (await ghGetJson(hostToken, `/repos/${owner}/${repo}/pulls/${prNumber}`)) as {
        user?: { login?: unknown } | null;
        html_url?: unknown;
      };
      const prAuthor = typeof prRawJson.user?.login === "string" ? prRawJson.user.login : "";
      const prUrl = typeof prRawJson.html_url === "string" ? prRawJson.html_url : "";
      evidence.push({ phase: "env-pr", ok: prAuthor === repoEntry.authorLogin, prNumber, prUrl, headRefName: pr.headRefName, prHeadBefore, prAuthor, parentRunId });
      if (prAuthor !== repoEntry.authorLogin) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber} was authored by ${JSON.stringify(prAuthor)}, not the allowlist entry's authorLogin ${JSON.stringify(repoEntry.authorLogin)} — leg (iii) requires a DF5.2 PR produced under the bound identity. Produce one and re-export ${FIX_PR_ENV}.`,
        );
      }

      // (ii½) the host repo must ALREADY contain the PR head object: the
      // in-box harvest bundles the box branch against the FILL-pinned base
      // (the PR head), and `git bundle verify` runs in the HOST repo — a
      // factory checkout cannot verify a thin bundle whose prerequisite is
      // another repository's commit (measured live 2026-09-20,
      // evidence 2026-09-20-233107: `missing-prerequisite` aborted the chain
      // after the box billed). A free `git fetch` closes it; verified
      // PRE-spend so the round refuses loudly instead of failing paid.
      {
        const headCheck = Bun.spawnSync({
          cmd: ["git", "-C", REPO_ROOT, "cat-file", "-e", `${pr.headSha}^{commit}`],
          stdout: "pipe",
          stderr: "pipe",
        });
        evidence.push({
          phase: "env-base-object",
          ok: headCheck.exitCode === 0,
          headSha: pr.headSha,
        });
        if (headCheck.exitCode !== 0) {
          // The fetch URL anchors the RIGHT object store — paste-and-run from
          // any cwd lands in the repo the -C names. pr.html_url when it came
          // back a string; otherwise the slug's https form from the owner/repo
          // already in scope (a non-string html_url must not render a blank
          // URL into the command).
          const fetchUrl = prUrl !== "" ? prUrl.replace(/\/pull\/\d+$/, ".git") : `https://github.com/${owner}/${repo}.git`;
          throw new Error(
            `the host repo (${REPO_ROOT}) does not contain the PR head commit ${pr.headSha} — the harvest bundle's prerequisite cannot verify here. Run: git -C ${REPO_ROOT} fetch ${fetchUrl} ${pr.headSha} — then re-run.`,
          );
        }
      }

      // (ii) bot review capability, TWO readings: the RAW bot presence (any
      // Bot-type or [bot]-suffixed author — the capability the leg names) and
      // the KEPT set through the CLI's own fetchBotComments (what inv1 would
      // actually act on — a PR whose bot comments are all unbriefable is a
      // designed no-op, not a fix run). Comment BODIES never enter evidence:
      // third-party prose can quote secret-shaped text; ids/authors/digest
      // are the identity the round needs.
      const rawComments = await github.listPrReviewComments({ owner, repo, prNumber, token: hostToken });
      const rawBotCount = rawComments.filter((c) => c.authorType === "Bot" || c.authorLogin.endsWith("[bot]")).length;
      const commentSet: BotCommentSet = await fetchBotComments(github, { owner, repo, prNumber, token: hostToken });
      evidence.push({
        phase: "env-bot-comments",
        ok: rawBotCount >= 1 && commentSet.botComments.length >= 1,
        rawCount: rawComments.length,
        rawBotCount,
        keptCount: commentSet.botComments.length,
        commentIds: commentSet.commentIds,
        omittedCommentIds: commentSet.omittedCommentIds,
        omittedCount: commentSet.omittedCount,
        commentsDigest: commentSet.commentsDigest,
        authors: [...new Set(commentSet.botComments.map((c) => c.author))],
      });
      if (rawBotCount < 1) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber} carries no review comment from a Bot-type or [bot]-suffixed author (${rawComments.length} review comments total) — leg (ii): the review bot bound to ${repoEntry.authorLogin} must answer the PR. Install/trigger the bot, then re-run.`,
        );
      }
      if (commentSet.botComments.length < 1) {
        throw new Error(
          `${DISPOSABLE_REPO_SLUG}#${prNumber} carries ${rawBotCount} bot review comment(s) but NONE survives fetchBotComments' briefability filter — inv1 would no-op no-bot-comments instead of dispatching. Give the PR a well-formed bot comment, then re-run.`,
        );
      }

      // (i) branch protection: ≥1 REQUIRED check on the base branch. At this
      // story's merge point no code reads it (the DoD says so); the round
      // verifies it because the environment is DF6.1b's substrate too, and a
      // round that proves the environment proves all of it.
      let requiredChecks: string[] = [];
      try {
        const protection = (await ghGetJson(hostToken, `/repos/${owner}/${repo}/branches/${repoEntry.baseBranch}/protection`)) as {
          required_status_checks?: { contexts?: unknown; checks?: unknown } | null;
        };
        const rsc = protection.required_status_checks;
        const contexts = Array.isArray(rsc?.contexts) ? (rsc?.contexts as unknown[]) : [];
        const checks = Array.isArray(rsc?.checks) ? (rsc?.checks as unknown[]) : [];
        requiredChecks = [
          ...contexts.filter((c): c is string => typeof c === "string"),
          ...checks.map((c) => (typeof (c as { context?: unknown })?.context === "string" ? (c as { context: string }).context : "")).filter((c) => c !== ""),
        ];
      } catch (e) {
        throw new Error(
          `environment leg (i) failed: branch protection on ${DISPOSABLE_REPO_SLUG}@${repoEntry.baseBranch} could not be read (${(e as Error).message}) — mark one fast CI check REQUIRED on the base branch (DF6.1b's demo reuses this environment) and re-run.`,
        );
      }
      evidence.push({ phase: "env-branch-protection", ok: requiredChecks.length >= 1, baseBranch: repoEntry.baseBranch, requiredChecks });
      if (requiredChecks.length < 1) {
        throw new Error(
          `branch protection on ${DISPOSABLE_REPO_SLUG}@${repoEntry.baseBranch} names ZERO required checks — leg (i) requires ≥1 fast check marked required. Configure it and re-run.`,
        );
      }

      // The paid-failure guards the DoD does not name. (1) The roster the fix
      // manifest names passes AC5's single-fixer guard — the same call inv1
      // makes, for free.
      const roster = loadRoster(join(REPO_ROOT, "config/rosters/roster.yaml"), { repoRoot: REPO_ROOT });
      try {
        assertSingleFixer(roster.roles);
      } catch (e) {
        throw new Error(
          `the e2e roster config/rosters/roster.yaml fails AC5's single-fixer guard pre-spend: ${(e as Error).message} — the story pins this roster (lead + one write-capable fixer); restore that shape and re-run.`,
        );
      }
      // (2) The host plan the chain's re-verify will judge through, keyed by
      // the disposable slug, and its manifest file — a missing one is a
      // vetoed/exit-6 round that spent its box for nothing.
      const hostPlanIndexPath = join(REPO_ROOT, ".factory", "pipeline.json");
      const hostPlanIndex = JSON.parse(
        readFileUtf8(hostPlanIndexPath, "the re-verify host-plan index .factory/pipeline.json"),
      ) as { repos?: Record<string, { manifest?: unknown }> };
      const hostPlanRel = hostPlanIndex.repos?.[DISPOSABLE_REPO_SLUG]?.manifest ?? hostPlanIndex.repos?.[DISPOSABLE_REPO_SLUG.toLowerCase()]?.manifest;
      if (typeof hostPlanRel !== "string" || !existsSync(join(REPO_ROOT, hostPlanRel))) {
        throw new Error(
          `.factory/pipeline.json has no usable entry for ${DISPOSABLE_REPO_SLUG} (manifest ${JSON.stringify(hostPlanRel)}) — the chain's re-verify would veto the fix run AFTER the box billed. Register the host plan and re-run.`,
        );
      }
      // (3) The fix manifest exists in the checkout AND — when QDS_EXEDEV_SHA
      // resolves locally — inside the commit the box-side delivery clones. An
      // uncommitted manifest is the classic paid-round death; if the commit is
      // not a local object the PUSHED half stays the driver's checklist (the
      // qds-live-e2e skill owns it) and the check records a skip, not a pass.
      if (!existsSync(join(REPO_ROOT, FIX_RUN_MANIFEST_PATH))) {
        throw new Error(`${FIX_RUN_MANIFEST_PATH} is absent from the checkout — the fix brief names it; restore it and re-run`);
      }
      let manifestInSha: boolean | null = null;
      {
        const commitPresent = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "cat-file", "-e", `${ctx.sha}^{commit}`], stdout: "pipe", stderr: "pipe" });
        if (commitPresent.exitCode === 0) {
          const pathPresent = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "cat-file", "-e", `${ctx.sha}:${FIX_RUN_MANIFEST_PATH}`], stdout: "pipe", stderr: "pipe" });
          manifestInSha = pathPresent.exitCode === 0;
        }
      }
      evidence.push({ phase: "env-manifest", ok: manifestInSha !== false, manifestPath: FIX_RUN_MANIFEST_PATH, sha: ctx.sha, manifestInSha });
      if (manifestInSha === false) {
        throw new Error(
          `${FIX_RUN_MANIFEST_PATH} is NOT in ${ctx.sha} — the box-side manifest is delivered from the pushed tree, so inv1's dispatch would die after the box exists. Commit and push the manifest, export the new QDS_EXEDEV_SHA, and re-run.`,
        );
      }
      // (4) PLAN I13: in-box the roster loads from the box checkout, so the
      // DISPOSABLE repo must carry config/rosters/roster.yaml at the PR head.
      {
        let rosterThere = false;
        try {
          const contents = (await ghGetJson(hostToken, `/repos/${owner}/${repo}/contents/config/rosters/roster.yaml?ref=${prHeadBefore}`)) as { type?: unknown };
          rosterThere = contents.type === "file";
        } catch {
          rosterThere = false; // 404 is an answer: the prep push never landed
        }
        evidence.push({ phase: "env-box-roster", ok: rosterThere, path: "config/rosters/roster.yaml", ref: prHeadBefore });
        if (!rosterThere) {
          throw new Error(
            `${DISPOSABLE_REPO_SLUG} does not carry config/rosters/roster.yaml at ${prHeadBefore} — PLAN I13: in-box the roster loads from the box checkout (e2e prep owns pushing it). Push it to the disposable repo and re-run.`,
          );
        }
      }
      evidence.push({ phase: "env-verified", ok: true, note: "legs (i)-(iv) + roster guard + host plan + manifest + box-roster — all pre-spend, all free reads" });

      // ── 0d. the round's own money + the parent record (the CLI's join key) ─
      // The cost config BESIDE the records dir (costLedgerOpts): the per-issue
      // override the ceiling pre-flight demands, keyed by the CANONICAL issue
      // identity through the ledger's own canonicalizers — never a hand-copied
      // key spelling. boxHourRateMicroUsd prices the close's box-hours ingest.
      const issueId = String(prNumber);
      const issueKey = `${canonicalRepoSlug(DISPOSABLE_REPO_SLUG)}#${canonicalIssueId(issueId)}`;
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ boxHourRateMicroUsd: T61A_BOX_HOUR_RATE_MICRO_USD, perIssueOverrides: { [issueKey]: T61A_ISSUE_CEILING_OVERRIDE_MICRO_USD } }),
      );
      evidence.push({ phase: "cost-config", ok: true, issueKey, overrideMicroUsd: T61A_ISSUE_CEILING_OVERRIDE_MICRO_USD, boxHourRateMicroUsd: T61A_BOX_HOUR_RATE_MICRO_USD });

      // The parent record, CONSTRUCTED from the GitHub-verified facts above
      // (see the header for why construction beats trusting an operator-placed
      // file): runId off the head branch, pr extension off the API, budget
      // extension naming the slug and the round's issueId. This is the ONLY
      // record the round starts with — which is what makes "a second record
      // appears" a complete dispatch detector below.
      const store = new RunRecordStore({ dir: recordsDir });
      store.create(parentRunId);
      store.set(parentRunId, {
        extensions: {
          pr: { prUrl, prNumber, createdAt: new Date().toISOString() },
          budget: { repoSlug: DISPOSABLE_REPO_SLUG, issueId },
        },
      });
      evidence.push({ phase: "parent-record", ok: true, parentRunId, prNumber, repoSlug: DISPOSABLE_REPO_SLUG, issueId });

      // Locality leg (c), BEFORE snapshot: taken before the negative control —
      // the whole CLI surface of the round sits inside the window, and a pi
      // spawn ANYWHERE in it is the same defect class.
      const psBefore = hostProcessTable();
      evidence.push({ phase: "host-ps-before", lines: psBefore.size });

      // ── 1. THE FREE NEGATIVE CONTROL, in the same round ──────────────────
      // A scratch hostRoot whose .factory/fix-scope.json parses but carries NO
      // entry for the slug — the operator's real scope file is never touched
      // (a crash mid-edit there would disarm AC6's enforcement host-wide).
      // The probe ordering in scripts/fix-run.ts runs readFixScope BEFORE the
      // roster load and the dispatch, so this hostRoot needs nothing else.
      // The JOIN still needs a repos allowlist, and the CLI's containment
      // guard refuses a --repos-file OUTSIDE the hostRoot ("a file the caller
      // can point anywhere is one the caller writes") — measured live on the
      // first round attempt (evidence 2026-09-20-223933: exit 5 with the
      // `allowlist` envelope, never reaching the scope probe) — so the
      // scratch host carries its own 0600 COPY of the real allowlist.
      const negHost = join(workspace, "neg-host");
      const negFactory = join(negHost, ".factory");
      mkdirSync(negFactory, { recursive: true, mode: 0o700 });
      chmodSync(negFactory, 0o700);
      const negScopePath = join(negFactory, "fix-scope.json");
      writeFileSync(negScopePath, JSON.stringify({ schemaVersion: 1, scopes: {} }));
      chmodSync(negScopePath, 0o600);
      const negReposPath = join(negFactory, "repos.json");
      writeFileSync(negReposPath, readFileSync(join(REPO_ROOT, ".factory", "repos.json")));
      chmodSync(negReposPath, 0o600);
      // macOS: /var is a symlink to /private/var, and the CLI's containment
      // guard compares the realpath'd hostRoot by string prefix — measured
      // live (evidence 2026-09-20-224323: the /var/folders caller path
      // refused against the /private/var/folders hostRoot). Pass the
      // realpath'd form, the same normalization the guard does.
      const negReposRealPath = realpathSync(negReposPath);
      const boxesBeforeNeg = await awaitWithCeiling(ctx.driver.list(), T61A_LIST_CEILING_MS, "t6.1a-neg-pre-list");
      const neg = await runFixRun(
        ["--pr", String(prNumber), "--dir", recordsDir, "--repos-file", negReposRealPath],
        { cwd: negHost, timeoutMs: T61A_NEG_CONTROL_TIMEOUT_MS },
      );
      const boxesAfterNeg = await awaitWithCeiling(ctx.driver.list(), T61A_LIST_CEILING_MS, "t6.1a-neg-post-list");
      const negEnvelope = jsonLines(neg.stderr).lines.find((l) => l.code === "fix-scope-missing");
      const negBoxDelta = boxesAfterNeg.map((b) => b.name).filter((n) => (n.startsWith("qds-") || n.startsWith("e2e-")) && !boxesBeforeNeg.some((b) => b.name === n));
      const recordsAfterNeg = readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
      evidence.push({
        phase: "neg-control",
        exitCode: neg.exitCode,
        envelope: negEnvelope ?? null,
        boxDelta: negBoxDelta,
        recordsAfter: recordsAfterNeg,
        stdoutTail: redactSecrets(neg.stdout.trim().slice(-300)),
        stderrTail: redactSecrets(neg.stderr.trim().slice(-600)),
      });
      expect(neg.exitCode).toBe(5);
      expect(negEnvelope).toBeDefined();
      // The refusal names the MISSING ENTRY arm, not a file-level guard — the
      // file exists and parses; the slug's absence is what refused. The arm's
      // constant phrase (`no fix scope entry for`, feedback-run.ts's
      // missing-entry arm) is the discriminator: a guard-forwarding refusal —
      // an unreadable or mis-moded scratch file — embeds the same path under
      // the same `fix-scope-missing` code but NOT this phrase. The phrase
      // survives redaction (only the slug is blanked: the 41-char mixed-case
      // owner/repo collides with the opaque-token heuristic — measured live,
      // evidence 2026-09-20-224548). The SCRATCH path is kept as the secondary
      // assert, the scratch-host proof: it pins that the probe consulted the
      // scratch host, never the operator's real scope file.
      const negScopeRealPath = realpathSync(negScopePath);
      expect(String(negEnvelope?.message ?? "")).toContain("no fix scope entry for");
      expect(String(negEnvelope?.message ?? "")).toContain(negScopeRealPath);
      // No dispatch ⇒ no fix-run record: the store still holds ONLY the parent.
      expect(recordsAfterNeg).toEqual([`${parentRunId}.json`]);
      // And no box: the delta over the round's own listing is empty.
      expect(negBoxDelta).toEqual([]);
      // The parent record was not mutated — no attempt ledger entry exists.
      expect(store.get(parentRunId).extensions?.fixLoop?.fixAttemptRunIds).toBeUndefined();

      // ── 2. INV1, spawned — the locality legs observe DURING the verb ──────
      // cwd is REPO_ROOT by design (see the header: the CLI's hostRoot
      // resolution IS the production shape). The verb dispatches, probes,
      // starts the unit and drives DF3.7's chain with the lock held; it
      // returns only after the pause — the box lives and dies INSIDE it.
      inv1 = spawnFixRun(["--pr", String(prNumber), "--dir", recordsDir, "--cap-micro-usd", String(T61A_CAP_MICRO_USD)], { cwd: REPO_ROOT });
      let inv1Exit: number | null | undefined;
      inv1.exited.then((c) => {
        inv1Exit = c;
      });
      const inv1Deadline = Date.now() + T61A_INV1_TIMEOUT_MS;

      // 2a. the fix run's RECORD is the dispatch detector: this store started
      // with exactly one record (the parent), so the first new *.json IS the
      // attempt — and it is also the finally's id-recovery path if the verb
      // dies before its ack-shaped result line.
      const recordPollStart = Date.now();
      while (fixRunId === "") {
        if (inv1Exit !== undefined) break;
        if (Date.now() > inv1Deadline) break;
        const others = readdirSync(recordsDir).filter((f) => f.endsWith(".json") && f !== `${parentRunId}.json`);
        if (others.length > 0) {
          fixRunId = (others[0] as string).slice(0, -".json".length);
          try {
            fixVmName = store.get(fixRunId).vmName ?? "";
          } catch {
            fixVmName = "";
          }
        }
        if (fixRunId === "") await new Promise((r) => setTimeout(r, T61A_POLL_INTERVAL_MS));
      }
      evidence.push({ phase: "fix-record-poll", fixRunId, fixVmName, waitedMs: Date.now() - recordPollStart, inv1Exit: inv1Exit ?? null });
      if (fixRunId === "") {
        // The verb is done or wedged WITHOUT a record — collect its output so
        // the assertion below names what actually happened (a pre-dispatch
        // refusal exits 5 with a typed envelope; a wedged dispatch exits never).
        inv1.kill();
        inv1Output = await inv1.output;
        throw new Error(
          `inv1 produced no fix-run record within its window (inv1Exit=${String(inv1Exit ?? "wedged")}) — stdout: ${redactSecrets(inv1Output.stdout.trim().slice(-300))} stderr: ${redactSecrets(inv1Output.stderr.trim().slice(-600))}`,
        );
      }
      // Arm the reaper's file the moment the box's identity is known (P11) —
      // the keyHash joins it after the verb's result, still before any leg
      // whose failure could strand the pair unrecorded.
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ runId: fixRunId, vmName: fixVmName, keyHash: null })}\n`);

      // 2b. LOCALITY LEGS (a) and (b), one poll loop while the box lives.
      // (a) the terminal marker through readBoxFile + the shipped classifier;
      // (b) ExecMainStartTimestamp via systemctl show, captured per tick from
      // now — the whole engine walk is the capture window, never a teardown
      // race. T27/T32: rejected reads and skip verdicts are countable
      // non-settled ticks, fast-failed at T61A_POLL_UNREADABLE_LIMIT.
      const { driver } = ctx; // narrowed here; the closure below cannot keep the outer `let` narrowed
      const pollStartedAt = Date.now();
      const kindCounts: Record<string, number> = {};
      let settledOk: boolean | undefined;
      let unitStartTimestamp = "";
      let unreadableStreak = 0;
      let lastUnreadableWhy = "";
      const unitStartProbe = async (): Promise<void> => {
        if (unitStartTimestamp !== "" || fixVmName === "") return;
        try {
          const show = await driver.execTimed(
            fixVmName,
            ["systemctl", "show", runUnitName(fixRunId), "-p", "ExecMainStartTimestamp", "-p", "ActiveState"],
            30_000,
          );
          const ts = /ExecMainStartTimestamp=(.*)/.exec(show.stdout)?.[1]?.trim() ?? "";
          if (ts !== "" && ts !== "n/a" && ts !== "0") unitStartTimestamp = ts;
        } catch {
          // a probe that cannot answer once is a cold multiplex, not a dead unit — the next tick retries
        }
      };
      for (;;) {
        // The record is created BEFORE any billable infrastructure exists
        // (run-record INV-1), so the discovery read above can catch vmName
        // still empty — re-read until provisioning stamps it, one cheap local
        // read per tick.
        if (fixVmName === "") {
          try {
            fixVmName = store.get(fixRunId).vmName ?? "";
          } catch {
            // unreadable mid-write — the next tick retries
          }
        }
        await unitStartProbe();
        // The discriminated tick: `read === undefined` ⇔ the read REJECTED —
        // TS narrows on it, and the two arms below never disagree.
        const tick = await readBoxFile(driver, fixVmName, boxMarkerPath(fixRunId), DEFAULT_PER_CALL_DEADLINE_MS).then(
          (read): { read: BoxFileRead; rejection?: undefined } => ({ read }),
          (e: unknown): { read: undefined; rejection: string } => ({
            read: undefined,
            rejection: e instanceof Error ? e.message : String(e),
          }),
        );
        if (tick.read === undefined) {
          // Provisioning-pending is NOT an unreadable streak: the record is
          // created before the box exists (run-record INV-1), so there is a
          // long window — measured ~70 s of driver.create — where vmName is
          // still "" and every readBoxFile call rejects on the empty id.
          // Counting those ticks toward T61A_POLL_UNREADABLE_LIMIT failed the
          // leg mid-provisioning (evidence 2026-09-20-230327: 10 rejection
          // ticks at ~45 s, all `invalid run id: ""`). The poll deadline
          // (inv1Deadline / T61A_ENGINE_WINDOW_MS) still bounds this window.
          // falsy, not `=== ""`: an absent vmName FIELD and the empty-string
          // sentinel are the same provisioning-pending signal here.
          if (!fixVmName) {
            kindCounts["(provisioning-pending)"] = (kindCounts["(provisioning-pending)"] ?? 0) + 1;
            lastUnreadableWhy = `provisioning pending (no vmName yet): ${tick.rejection}`;
            // `continue` skips this loop's tail deadline checks, so the
            // provisioning window is bounded here — a wedged provision ends
            // the poll by the same deadlines a settled poll would hit.
            if (inv1Exit !== undefined || Date.now() > inv1Deadline || Date.now() - pollStartedAt > T61A_ENGINE_WINDOW_MS) break;
            await new Promise((r) => setTimeout(r, T61A_POLL_INTERVAL_MS));
            continue;
          }
          kindCounts["(read-rejected)"] = (kindCounts["(read-rejected)"] ?? 0) + 1;
          unreadableStreak += 1;
          lastUnreadableWhy = `readBoxFile rejected: ${tick.rejection}`;
        } else {
          // live-mirror: classifyMarkerRead/MarkerVerdict kinds (src/fleet/fanout-primitive.ts:785) — the shipped classifier's vocabulary, never a local re-spelling
          const verdict = classifyMarkerRead(tick.read, fixRunId);
          kindCounts[verdict.kind] = (kindCounts[verdict.kind] ?? 0) + 1;
          if (verdict.kind === "settled") {
            settledOk = verdict.ok;
            break;
          }
          if (verdict.kind === "unusable") {
            evidence.push({ phase: "locality-marker-poll", ok: false, kindCounts, code: verdict.code, pollMs: Date.now() - pollStartedAt });
            throw new Error(
              `locality leg (a) read an unusable marker (code ${verdict.code}) — present but unjudgeable at ${boxMarkerPath(fixRunId)}; the chain's own observer would refuse it identically`, // live-mirror: boxMarkerPath(runId) (fanout-primitive.ts) — the shipped per-run marker path
            );
          }
          if (verdict.kind === "skip") {
            unreadableStreak += 1;
            lastUnreadableWhy = `${verdict.code}: ${verdict.error instanceof Error ? verdict.error.message : String(verdict.error)}`;
          } else {
            unreadableStreak = 0;
          }
        }
        if (unreadableStreak >= T61A_POLL_UNREADABLE_LIMIT) {
          evidence.push({
            phase: "locality-marker-poll",
            ok: false,
            kindCounts,
            unreadableStreak,
            lastUnreadableWhy: redactSecrets(lastUnreadableWhy.slice(0, 300)),
            pollMs: Date.now() - pollStartedAt,
          });
          throw new Error(
            `locality leg (a): the marker was UNREADABLE for ${unreadableStreak} consecutive ticks (${redactSecrets(lastUnreadableWhy.slice(0, 300))}) — NOT absent and not a slow engine: the reads rejected or the presence probe never answered, so the box is unreachable-or-wedged while it may still be billing. Failing now instead of burning the rest of the window.`,
          );
        }
        if (inv1Exit !== undefined) break; // the verb ended before a settled reading — handled by name below
        if (Date.now() - pollStartedAt > T61A_ENGINE_WINDOW_MS) break;
        if (Date.now() > inv1Deadline) break;
        await new Promise((r) => setTimeout(r, T61A_POLL_INTERVAL_MS));
      }
      const markerPollMs = Date.now() - pollStartedAt;

      // 2c. collect the verb — the chain tail (harvest → teardown → reverify →
      // pause) still runs after the marker settles; what is left of the
      // supervision deadline bounds the wait.
      const remaining = Math.max(30_000, inv1Deadline - Date.now());
      const inv1ExitCode = await awaitWithCeiling(inv1.exited, remaining, "t6.1a-inv1-exit");
      inv1Output = await inv1.output;
      evidence.push({
        phase: "inv1-result",
        exitCode: inv1ExitCode,
        markerPollMs,
        kindCounts,
        settledOk: settledOk ?? null,
        unitStartTimestamp: unitStartTimestamp === "" ? null : unitStartTimestamp,
        stdoutTail: redactSecrets(inv1Output.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(inv1Output.stderr.trim().slice(-600)),
      });
      expect(inv1ExitCode).toBe(0);
      const inv1Line = lastJsonLine<{ state?: string; runId?: string; prNumber?: number; attempt?: number; requestId?: string }>(inv1Output.stdout);
      // live-mirror: ApprovalState union (src/reverify/approval.ts, written by approval-gate.ts — DF6.1a asserts, never writes it)
      expect(inv1Line.state).toBe("awaiting-approval");
      expect(inv1Line.runId).toBe(fixRunId);
      expect(inv1Line.prNumber).toBe(prNumber);
      expect(inv1Line.attempt).toBe(1);

      // 2d. LOCALITY VERDICTS, named per leg. (a) the settled reading through
      // readBoxFile while the box lived; (b) the unit's start timestamp.
      if (settledOk === undefined) {
        throw new Error(
          `locality leg (a) LOST THE RACE: inv1 exited 0 but this test never read the settled marker through readBoxFile — the chain read, harvested and tore the box down inside one ${T61A_POLL_INTERVAL_MS} ms poll interval. This is a test-timing loss, not a product verdict: rerun once; if it repeats, tighten the poll. kindCounts=${JSON.stringify(kindCounts)}`,
        );
      }
      expect(settledOk).toBe(true);
      if (unitStartTimestamp === "") {
        // One bounded post-settle retry band — the box may still be mid-harvest.
        for (let attempt = 0; attempt < 3 && unitStartTimestamp === ""; attempt++) {
          await new Promise((r) => setTimeout(r, 5_000));
          await unitStartProbe();
        }
      }
      evidence.push({ phase: "locality-unit-start", ok: unitStartTimestamp !== "", unit: runUnitName(fixRunId), execMainStartTimestamp: unitStartTimestamp }); // live-mirror: runUnitName (src/fleet/run.ts) — the per-run systemd unit fix-run's startRun started
      if (unitStartTimestamp === "") {
        throw new Error(
          `locality leg (b) failed: systemctl show ${runUnitName(fixRunId)} -p ExecMainStartTimestamp never reported a start while the box was reachable — the unit, not an exec, must have run the engine (the ADR's placement invariant)`,
        );
      }

      // ── 3. the fix run's record and its money, post-chain ────────────────
      const driven = store.get(fixRunId);
      expect(driven.vmName).toBe(fixVmName);
      // live-mirror: ApprovalState union (src/reverify/approval.ts — written by the gate, asserted here)
      expect(driven.extensions?.approval?.state).toBe("awaiting-approval");
      expect(String(driven.extensions?.approval?.reportId ?? "")).not.toBe("");
      expect(String(driven.extensions?.approval?.headSha ?? "")).not.toBe("");
      // C21: the mint marker on the attempt's own record, and the attempt-time
      // ledger append on the parent — both written dispatch-time, so a charged
      // failure keeps them.
      expect(driven.extensions?.fixLoop?.fixRun).toBe("true");
      const parentAfterInv1 = store.get(parentRunId);
      expect(parentAfterInv1.extensions?.fixLoop?.fixAttemptRunIds).toEqual([fixRunId]);
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ runId: fixRunId, vmName: fixVmName, keyHash: driven.keyHash ?? null })}\n`);
      evidence.push({
        phase: "driven-record",
        ok: true,
        closedAt: driven.closedAt,
        approvalJson: redactSecrets(JSON.stringify(driven.extensions?.approval ?? null)),
        spendMicroUsd: driven.spendMicroUsd,
        limitMicroUsd: driven.limitMicroUsd,
        keyHash: driven.keyHash,
      });
      // The minted key's hard limit, RECORDED and bounded by the provider
      // backstop constant — the SPEND block names this figure; it is the CLI's
      // compiled ceiling, not the round's approved draw.
      expect(typeof driven.limitMicroUsd).toBe("number");
      expect(driven.limitMicroUsd ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(defaultKeyCapMicroUsd);
      // TYPE first, then the ceiling (T2.2's L9): a missing spendMicroUsd is a
      // capture defect, not "the run spent nothing". This ceiling is the
      // round's APPROVED model draw (the story's 50,000 µ$ budget figure).
      expect(typeof driven.spendMicroUsd).toBe("number");
      expect(driven.spendMicroUsd ?? 0).toBeLessThanOrEqual(T61A_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T61A_CAP_MICRO_USD, actualMicroUsd: driven.spendMicroUsd });
      // The box-hours half, machine-checked against the PLANNED window (T3.8's
      // T31/T33 shape: non-finite costs on ingested rows are audit defects,
      // never costless boxes).
      const boxHourRows = ledgerRows<{ cost_micro_usd: number | null }>(
        recordsDir,
        "SELECT cost_micro_usd FROM cost_events WHERE run_id = ? AND kind = 'box_hours'",
        fixRunId,
      );
      const nonFiniteCostRows = boxHourRows.filter((r) => !Number.isFinite(r.cost_micro_usd));
      if (nonFiniteCostRows.length > 0) {
        throw new Error(
          `box_hours ledger rows with non-finite cost_micro_usd for ${fixRunId} (${nonFiniteCostRows.length} of ${boxHourRows.length} rows; first: ${JSON.stringify(nonFiniteCostRows[0])}) — a NULL/invalid cost on an ingested row is an audit defect, not a costless box`,
        );
      }
      const boxHoursMicroUsd = boxHourRows.reduce((sum, r) => sum + (r.cost_micro_usd ?? 0), 0);
      evidence.push({
        phase: "box-hours",
        rows: boxHourRows.length,
        rateMicroUsdPerHour: T61A_BOX_HOUR_RATE_MICRO_USD,
        actualMicroUsd: boxHoursMicroUsd,
        ceilingMicroUsd: T61A_BOX_HOURS_CEILING_MICRO_USD,
      });
      expect(boxHourRows.length).toBeGreaterThanOrEqual(1);
      expect(boxHoursMicroUsd).toBeLessThanOrEqual(T61A_BOX_HOURS_CEILING_MICRO_USD);
      // The chain's own teardown revoked the key inside inv1; the
      // machine-checked half (F17), in-body here and as a population delta in
      // the finally. TYPE the hash first (P7): a chain defect that nulled
      // keyHash would otherwise make the `not.toContain` pass vacuously.
      expect(typeof driven.keyHash).toBe("string");
      const postChainKeyHashes = await awaitWithCeiling(listedKeyHashes(), T61A_KEY_LIST_CEILING_MS, "t6.1a-post-chain-key-list");
      expect(postChainKeyHashes).not.toContain(driven.keyHash);

      // ── 4. THE OPERATOR ACT, in-harness: `fleet approve <fixRunId>` ───────
      // T1.7's exact shape: the allowlist UNDER THE RECORDS DIR (C10 parity),
      // hashed with the one formula the factory verifies against, the token on
      // fd 0 from a 0600 file — never argv, never env.
      const factoryDir = join(recordsDir, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      chmodSync(factoryDir, 0o700);
      const allowlistPath = join(factoryDir, "approvers.json");
      writeFileSync(
        allowlistPath,
        JSON.stringify({
          version: 1,
          approvers: {
            [APPROVER_ID]: {
              v: 2,
              salt: APPROVER_SALT,
              hash: scryptToken(APPROVER_SALT, APPROVER_TOKEN),
              ...SCRYPT_PARAMS,
            },
          },
        }),
      );
      chmodSync(allowlistPath, 0o600);
      expect(statSync(allowlistPath).mode & 0o777).toBe(0o600);
      expect(statSync(factoryDir).mode & 0o777).toBe(0o700);
      const tokenPath = join(workspace, "approver.token");
      writeFileSync(tokenPath, `${APPROVER_TOKEN}\n`);
      chmodSync(tokenPath, 0o600);
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      const approve = await runFleetWithToken(
        ["approve", fixRunId, "--approver", APPROVER_ID, "--reason", "df6-1a live e2e: approve the bounded fix attempt", "--dir", recordsDir],
        tokenPath,
        { cwd: workspace, timeoutMs: T61A_APPROVE_TIMEOUT_MS },
      );
      // Secret-absence is asserted BEFORE the tails enter evidence (T1.7's
      // F3 discipline: the finally writes evidence on a failing run too).
      expect(approve.stdout + approve.stderr).not.toContain(APPROVER_TOKEN);
      expect(approve.stdout + approve.stderr).not.toContain("sk-or-");
      evidence.push({
        phase: "approve",
        exitCode: approve.exitCode,
        stdoutTail: redactSecrets(approve.stdout.trim().slice(-300)),
        stderrTail: redactSecrets(approve.stderr.trim().slice(-400)),
      });
      expect(approve.exitCode).toBe(0);
      const approvedRec = store.get(fixRunId);
      expect(approvedRec.extensions?.approval?.state).toBe("approved");
      expect(String(approvedRec.extensions?.approval?.approverId ?? "")).toBe(APPROVER_ID);
      const approvedHeadSha = String(approvedRec.extensions?.approval?.headSha ?? "");
      expect(/^[0-9a-f]{40}$/.test(approvedHeadSha)).toBe(true);

      // ── 5. INV2: bind → diff → scope → preflight → push → one write ───────
      const inv2StartedMs = Date.now();
      const inv2 = await runFixRun(["--pr", String(prNumber), "--dir", recordsDir], { cwd: REPO_ROOT, timeoutMs: T61A_INV2_TIMEOUT_MS });
      evidence.push({
        phase: "inv2-result",
        exitCode: inv2.exitCode,
        stdoutTail: redactSecrets(inv2.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(inv2.stderr.trim().slice(-600)),
      });
      expect(inv2.exitCode).toBe(0);
      const inv2Line = lastJsonLine<{ state?: string; runId?: string; prNumber?: number; attempt?: number; attempts?: number; attemptSha?: string; requestId?: string }>(inv2.stdout);
      // DF6.1b composes the SHA-bound poll into THIS invocation (W6-D-B1): the
      // result line is the VERDICT — green on the disposable repo's fast
      // required check (the env leg (i) substrate). The appended commit is
      // asserted below against the branch API regardless.
      expect(inv2Line.state).toBe("green");
      expect(inv2Line.attempts).toBe(1);
      expect(inv2Line.runId).toBe(fixRunId);
      expect(inv2Line.prNumber).toBe(prNumber);
      const attemptSha = typeof inv2Line.attemptSha === "string" ? inv2Line.attemptSha : "";
      expect(/^[0-9a-f]{40}$/.test(attemptSha)).toBe(true);

      // ── 6. the append, evidenced on GitHub AND in the host object store ──
      // The story's verbatim check: the PR branch carries the appended commit
      // — `git merge-base --is-ancestor` as the fast-forward proof. The host
      // checkout holds the objects: inv1's chain harvested refs/sandbox/<fixRunId>
      // into it, and the harvested tip's ancestry carries the PR head.
      const sandboxTip = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "rev-parse", "--verify", `refs/sandbox/${fixRunId}`], stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "sandbox-tip", exitCode: sandboxTip.exitCode, sha: sandboxTip.stdout.toString().trim() });
      expect(sandboxTip.exitCode).toBe(0);
      expect(sandboxTip.stdout.toString().trim()).toBe(attemptSha);
      for (const sha of [prHeadBefore, attemptSha]) {
        const present = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "cat-file", "-e", `${sha}^{commit}`], stdout: "pipe", stderr: "pipe" });
        if (present.exitCode !== 0) {
          throw new Error(`the host object store at ${REPO_ROOT} does not hold ${sha} — the merge-base check cannot run; the harvest should have delivered the tip's full ancestry`);
        }
      }
      const ancestry = Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "merge-base", "--is-ancestor", prHeadBefore, attemptSha], stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "merge-base", prHeadBefore, attemptSha, isAncestor: ancestry.exitCode === 0, exitCode: ancestry.exitCode });
      expect(ancestry.exitCode).toBe(0);
      // The REMOTE reading through the same seam: the PR's head moved from the
      // pre-round sha to the appended sha, on the same branch, still open.
      // POLLED, not read once: the loop runs past GitHub's read-after-write
      // cache — the append's own push precedes this read by seconds and the
      // PR GET can still serve the pre-push head (measured live 2026-09-21,
      // evidence 2026-09-21-000025's successor: inv2 reported `pushed` +
      // `appended` and the branch API already served the appended sha, while
      // the PR GET still answered the old one). Transient read errors are
      // absorbed to the deadline — a 5xx/rate-limit must not abort the round
      // POST-spend; a 404 is TERMINAL (the disposable repo gone mid-round
      // cannot settle) and breaks immediately.
      let prAfter: { headSha: string; headRefName: string; state: string } | null = null;
      let prReadErrors = 0;
      let prReadLastError = "";
      let prReadSucceeded = false;
      const prSettleDeadline = Date.now() + T61A_PR_SETTLE_WINDOW_MS;
      for (;;) {
        try {
          prAfter = await github.getPullRequest({ owner, repo, prNumber, token: hostToken });
          prReadSucceeded = true;
        } catch (e) {
          // keep the previous reading (null until the first success) and let
          // the deadline — not the exception — decide whether the round ends
          prReadErrors += 1;
          prReadLastError = e instanceof Error ? e.message : String(e);
        }
        // Only a SUCCESSFUL read that answered null is the terminal 404 (the
        // client returns null for a clean 404 and throws everything else). A
        // null still held from before the first successful read is "not yet
        // read" — a thrown poll must keep polling, not break as if 404'd.
        if (prReadSucceeded && prAfter === null) break;
        if (prAfter?.headSha === attemptSha) break;
        if (Date.now() > prSettleDeadline) break;
        await new Promise((r) => setTimeout(r, T61A_PR_SETTLE_INTERVAL_MS));
      }
      evidence.push({ phase: "pr-remote", headSha: prAfter?.headSha ?? null, headRefName: prAfter?.headRefName ?? null, state: prAfter?.state ?? null, expectedAttemptSha: attemptSha });
      // Null with NO successful read ever completing — the null is a leftover
      // placeholder, not a 404 answer and not evidence about the PR — is a
      // read failure: name it before the settles below would misattribute it.
      // (Reaching here null with prReadSucceeded IS the clean-404 arm; the
      // settles assert not-null below and fail the round on it.)
      if (prAfter === null && !prReadSucceeded) {
        throw new Error(
          `the PR-settle poll absorbed ${prReadErrors} read error(s) and never completed one successful read (last: ${redactSecrets(prReadLastError)}) — ${DISPOSABLE_REPO_SLUG}#${prNumber} could not be read post-append, so the round cannot distinguish a transient API failure from the 404 the terminal arm names.`,
        );
      }
      expect(prAfter).not.toBeNull();
      expect(prAfter?.headRefName).toBe(pr.headRefName);
      expect(prAfter?.headSha).toBe(attemptSha);
      expect(prAfter?.state).toBe("open");

      // ── 7. fixContext: real fields, NO prose, exactly two off-placeholder ─
      // INV-7's contract, observable: reconstruct the PRE-FLIGHT encoding from
      // the same comment identity (the placeholders defaulted) and diff — the
      // record's write must differ from it in EXACTLY {attemptSha,
      // pollWindowOpenedAt}, with attemptSha = the pushed sha. The comment
      // identity equality holds because nothing comments on the disposable PR
      // mid-round; a mismatch here means a comment landed between the pre-read
      // and inv2's fresh fetch, and it fails by name with both sets in evidence.
      const fixContextRaw = store.get(fixRunId).extensions?.fixLoop?.fixContext;
      expect(typeof fixContextRaw).toBe("string");
      const actualCtx = parseFixContext(fixContextRaw);
      const placeholderCtx = buildFixContextPayload({
        prNumber,
        prBranch: pr.headRefName,
        commentIds: commentSet.commentIds,
        omittedCommentIds: commentSet.omittedCommentIds,
        omittedCount: commentSet.omittedCount,
        commentsDigest: commentSet.commentsDigest,
      });
      const differingFields = (Object.keys(placeholderCtx) as (keyof typeof placeholderCtx)[]).filter(
        (k) => JSON.stringify(actualCtx[k]) !== JSON.stringify(placeholderCtx[k]),
      );
      evidence.push({ phase: "fixcontext", actual: actualCtx, differingFields, pollWindowAgeMs: Date.parse(actualCtx.pollWindowOpenedAt) - inv2StartedMs });
      expect(differingFields.sort()).toEqual(["attemptSha", "pollWindowOpenedAt"]);
      expect(actualCtx.attemptSha).toBe(attemptSha);
      expect(Number.isFinite(Date.parse(actualCtx.pollWindowOpenedAt))).toBe(true);
      // Written at the push, on the same host clock — 60 s of skew headroom.
      expect(Date.parse(actualCtx.pollWindowOpenedAt)).toBeGreaterThanOrEqual(inv2StartedMs - 60_000);
      expect(actualCtx.prNumber).toBe(prNumber);
      expect(actualCtx.prBranch).toBe(pr.headRefName);
      expect(actualCtx.attempt).toBe(1);
      // NO PROSE: the strict schema's ten keys and nothing else, and none of
      // the kept comments' (redacted) snippet text survives in the encoded
      // field — untrusted third-party prose never enters the closed record.
      expect(Object.keys(actualCtx).sort()).toEqual(
        ["attempt", "attemptSha", "commentIds", "commentsDigest", "omittedCommentIds", "omittedCount", "pollWindowOpenedAt", "prBranch", "prNumber", "schemaVersion"].sort(),
      );
      const encoded = fixContextRaw as string;
      for (const c of commentSet.botComments.slice(0, 3)) {
        if (c.bodySnippet.length >= 16) expect(encoded).not.toContain(c.bodySnippet.slice(0, 16));
      }

      // ── 8. LOCALITY LEG (c): no pi on the host for the run's duration ────
      const psAfter = hostProcessTable();
      const piHits = piArgvHits(psBefore, psAfter);
      evidence.push({
        phase: "host-ps-diff",
        beforeLines: psBefore.size,
        afterLines: psAfter.size,
        hits: piHits,
        note: "argv containing `pi ` (word-boundaried) or `--provider`, present in the after snapshot only — the ADR's host-exec failure mode, observable",
      });
      expect(piHits).toEqual([]);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // A stranded inv1 (the body threw while the verb ran) is killed and
      // drained FIRST — its partial streams are the id-recovery input, and an
      // unread output promise must not linger past the finally.
      if (inv1 !== undefined && inv1Output === undefined) {
        try {
          inv1.kill();
        } catch {
          // already gone — the drain below settles either way
        }
        try {
          inv1Output = await Promise.race([
            inv1.output,
            new Promise<{ stdout: string; stderr: string }>((r) => setTimeout(() => r({ stdout: "", stderr: "" }), 10_000)),
          ]);
          evidence.push({
            phase: "inv1-stranded-drain",
            stdoutTail: redactSecrets(inv1Output.stdout.trim().slice(-300)),
            stderrTail: redactSecrets(inv1Output.stderr.trim().slice(-400)),
          });
        } catch {
          // best-effort; the record-based recovery below does not need the streams
        }
      }
      // Built FIRST, in its own try (FX-E/1): everything below reads it, and
      // the write-mode constructor's refusal must not escape this finally.
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // ID RECOVERY, this CLI's own shape: fix-run's dispatch runs in-process,
      // so a verb that dies mid-dispatch leaves NO ack text for a regex — but
      // its RECORD exists (INV-1: created before any billable infrastructure).
      // The store started with exactly the parent record, so the other *.json
      // is the attempt.
      if (fixRunId === "" && workspace !== "" && parentRunId !== "") {
        try {
          const others = readdirSync(join(workspace, "runs")).filter((f) => f.endsWith(".json") && f !== `${parentRunId}.json`);
          if (others.length > 0) {
            fixRunId = (others[0] as string).slice(0, -".json".length);
            const rec = recordStore?.get(fixRunId) as { vmName?: string; keyHash?: string } | undefined;
            if (rec?.vmName !== undefined && rec.vmName !== "") fixVmName = rec.vmName;
            if (rec?.keyHash !== undefined) {
              writeFileSync(orphanRecoveryPath, `${JSON.stringify({ runId: fixRunId, vmName: fixVmName, keyHash: rec.keyHash })}\n`);
            }
          }
        } catch {
          // no record to recover — the empty-id legs below skip as designed
        }
        evidence.push({ phase: "finally-id-recovery", fixRunId, fixVmName });
      }
      if (fixRunId !== "" && workspace !== "") {
        // `teardownQuietly`, not a bare spawn (F2): a rejection here would
        // escape the finally and replace the body's held error. `--no-harvest`:
        // the chain already harvested on the success path, and a cleanup path
        // is not where a second harvest belongs. A teardown of the
        // already-closed record is idempotent.
        const torn = await teardownQuietly(
          ["teardown", fixRunId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: T61A_CLEANUP_TEARDOWN_TIMEOUT_MS },
          evidence,
          { at: "t6.1a-cleanup", runId: fixRunId },
        );
        if (!torn.ok) destroyFailures.push(`${fixRunId}: ${torn.error}`);
      }
      if (fixVmName !== "" && ctx !== undefined) {
        const destroyed = await destroyQuietly(ctx.driver, fixVmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${fixVmName}: ${destroyed.error}`);
      }
      // `fleetLeftovers` (P127/P128/R4): bounded-retry against the measured
      // destroy lag, a destroy of what this run owns before the verdict, and
      // another round's strays demoted to a warning.
      if (ctx === undefined) {
        // P28 abort path: preflight never returned — nothing was provisioned.
        finalBoxes = [];
        evidence.push({ phase: "final-ls-skipped", ok: true, note: "preflight never returned — nothing was provisioned" });
      } else {
        finalBoxes = (await fleetLeftovers(ctx.driver, [fixRunId, fixVmName], evidence)).owned;
      }
      // GUARDED (E1-5): keyLeakProblems is the one finally leg whose own
      // failure must still be a VERDICT, not an escape from the finally.
      if (hashesBefore === undefined || ctx === undefined) {
        keyProblems = ["the F17 baseline key listing never landed — the key-hash delta is UNVERIFIED for this round"];
        evidence.push({ phase: "key-hash-baseline-missing", ok: false });
      } else {
        try {
          keyProblems = await keyLeakProblems(hashesBefore, { driver: ctx.driver, store: recordStore, runIds: [fixRunId] }, evidence);
        } catch (keyErr) {
          keyProblems = [
            `key-leak sweep itself failed: ${keyErr instanceof Error ? keyErr.message : String(keyErr)} — treat the run key's revocation as UNVERIFIED`,
          ];
          evidence.push({ phase: "key-leak-sweep-failed", ok: false, error: keyProblems[0] });
        }
      }
      // REPO-ROOT HYGIENE (see the header): the round's own debris in the
      // operator checkout — the harvested sandbox ref and the reverify report
      // inv2 needed until now. Removed ONLY on a fully clean cleanup (the same
      // condition that earns the reaper tombstone below); on any other posture
      // they are forensics and the evidence names their paths.
      const repoRootDebris =
        fixRunId === ""
          ? []
          : [`git ref refs/sandbox/${fixRunId} in ${REPO_ROOT}`, join(REPO_ROOT, DEFAULT_REVERIFY_DIR, `${fixRunId}.jsonl`)];
      if (fixRunId !== "" && finalBoxes !== undefined && finalBoxes.length === 0 && keyProblems.length === 0) {
        try {
          Bun.spawnSync({ cmd: ["git", "-C", REPO_ROOT, "update-ref", "-d", `refs/sandbox/${fixRunId}`], stdout: "pipe", stderr: "pipe" });
          rmSync(join(REPO_ROOT, DEFAULT_REVERIFY_DIR, `${fixRunId}.jsonl`), { force: true });
          evidence.push({ phase: "repo-root-hygiene", ok: true, removed: repoRootDebris });
        } catch (e) {
          // best-effort by design: leftover debris costs disk, not resources —
          // recorded, not thrown.
          evidence.push({ phase: "repo-root-hygiene", ok: false, error: e instanceof Error ? e.message : String(e), kept: repoRootDebris });
        }
      } else if (repoRootDebris.length > 0) {
        evidence.push({ phase: "repo-root-hygiene", ok: false, kept: repoRootDebris, reason: "RED round or unverified cleanup — kept for forensics; remove by hand once triaged" });
      }
      // The reaper's tombstone (T3.8's T36): invalidate the recovery file when
      // THIS finally actually finished the recovery it exists to trigger. An
      // UNMEASURED fleet (finalBoxes undefined) does not earn the tombstone.
      if (orphanRecoveryPath !== "" && finalBoxes !== undefined && finalBoxes.length === 0 && keyProblems.length === 0) {
        try {
          writeFileSync(
            orphanRecoveryPath,
            `${JSON.stringify({ phase: "handled", runId: fixRunId, vmName: fixVmName, note: "box destroyed and key revocation verified by this round's finally — nothing left to reap" })}\n`,
          );
          evidence.push({ phase: "orphan-recovery-tombstoned", ok: true, path: orphanRecoveryPath, runId: fixRunId, vmName: fixVmName });
        } catch (e) {
          evidence.push({
            phase: "orphan-recovery-tombstoned",
            ok: false,
            path: orphanRecoveryPath,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // The RED-arm workspace-keep entry rides the serialized payload (T3.8's
      // T24 ordering: pushed BEFORE the write, not after).
      if (workspace !== "" && failure !== undefined) {
        evidence.push({
          phase: "workspace-kept",
          workspace,
          reason: "RED round — forensics kept (records + bundle under runs/)",
        });
      }
      const evidencePath = writeEvidenceQuietly(
        "T6.1a",
        "df6-1a-fix-loop-append",
        {
          test: "T6.1a",
          outcome,
          prNumber,
          repoSlug: DISPOSABLE_REPO_SLUG,
          parentRunId,
          runId: fixRunId,
          capMicroUsd: T61A_CAP_MICRO_USD,
          boxHoursCeilingMicroUsd: T61A_BOX_HOURS_CEILING_MICRO_USD,
          engineWindowMs: T61A_ENGINE_WINDOW_MS,
          evidenceDir: EVIDENCE_DIR,
          phases: evidence,
        },
        destroyFailures,
      );
      // The workspace holds the only host-side copy of the records and bundle
      // once the box is gone — kept on a RED round, and ALSO loud when the
      // evidence write was refused on an otherwise green round (T3.8's P6).
      if (workspace !== "" && failure === undefined && evidencePath === "") {
        evidence.push({
          phase: "workspace-kept",
          workspace,
          reason: "GREEN round but the evidence write was refused — workspace kept (records + bundle under runs/); delete by hand once triaged",
        });
      }
      if (workspace !== "" && (failure !== undefined || evidencePath === "")) {
        try {
          process.stderr.write(
            failure !== undefined
              ? `[T6.1a] RED round: workspace ${workspace} KEPT for forensics; delete by hand once triaged\n`
              : `[T6.1a] EVIDENCE WRITE REFUSED: workspace ${workspace} KEPT (records + bundle under runs/); delete by hand once triaged\n`,
          );
        } catch {
          // dead stderr under an aborting runner — the evidence entry still lands
        }
      }
      if (workspace !== "" && failure === undefined && evidencePath !== "") {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          // best-effort; evidence is already written
        }
      }
    }

    // The post-finally verdict (EB3), in ONE place: a cleanup problem fails a
    // green run, and on a RED one attaches to the body's own error instead of
    // throwing over the top of it.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS, not typical latency (T2.2's
  // rule): a bun test-timeout abort is the ONE path where the finally above
  // does not execute — the one path that leaves a real box billing and a
  // minted key live. Every inner ceiling FIRING is safe (it rejects into the
  // catch and the finally still runs), so the fail-safe direction is UP.
  //
  //   preflight          driver.whoami(), one control exec class          120 s
  //   baseline keys      listedKeyHashes INSIDE the try, first await after
  //                      preflight (P28's placement). Unwrapped by scope,
  //                      not oversight: the round owns nothing yet, so a
  //                      hang costs a dead round, never a leak            240 s
  //   env verification   token + login + PR + author + comments +
  //                      protection + contents reads (≤ 30 s each with one
  //                      retry), roster/manifest/plan local reads         360 s
  //   parent record      local store writes                                 ~0 s
  //   negative control   2 × driver.list (CEILED at
  //                      T61A_LIST_CEILING_MS) + one fix-run spawn at
  //                      T61A_NEG_CONTROL_TIMEOUT_MS (record reads + two
  //                      GitHub GETs + the refusal — no box leg)          540 s
  //   inv1 leg           T61A_INV1_TIMEOUT_MS — ONE deadline over
  //                      record-poll (dispatch 900) + marker/locality poll
  //                      (probe 120 + start 180 inside it, engine window
  //                      2 100 — priced above the fix manifest's own
  //                      runBudgetMs 1 900) + chain-and-exit 900;
  //                      rejected reads and skip verdicts are countable
  //                      non-settled ticks, fast-failed at
  //                      T61A_POLL_UNREADABLE_LIMIT consecutive        4 200 s
  //   post-inv1 keys     listedKeyHashes (revoke verify), CEILED at
  //                      T61A_KEY_LIST_CEILING_MS                          240 s
  //   approve            T61A_APPROVE_TIMEOUT_MS (T1.7's figure)           120 s
  //   inv2               T61A_INV2_TIMEOUT_MS: binding + lock + local git
  //                      diff + scope + a fresh comment read + preflight +
  //                      a real push + one record write                   420 s
  //   post-inv2 reads    PR re-read through the seam + local git           120 s
  //   ps snapshots / git two spawnSyncs, local                              ~0 s
  //                                                            body ────────
  //                                                             6 360 s
  //   teardownQuietly    timeoutMs 180_000                               180 s
  //   destroyQuietly     CODE-WORST: 2 rm + 3 confirming list at the
  //                      DEFAULT_EXEC_TIMEOUT_MS class                      600 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass (code-worst, 600) + the confirming re-list 1 360 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list       360 s
  //   repo-root hygiene  update-ref + rmSync, local                         10 s
  //   evidence + rmSync  local                                              10 s
  //                                                           finally ────────
  //                                                             2 520 s
  //                                                                    ────────
  //                                                             8 880 s
  //
  // Hence T61A_RUNNER_TIMEOUT_MS (9 000 000 ms — 120 s of margin over the
  // audit). Whoever raises an inner ceiling must re-add it HERE, in
  // T61A_BOX_PLANNED_WINDOW_MS (the box-hours ceiling derives from these
  // rows), and the HEADER's box-time line with it.
  T61A_RUNNER_TIMEOUT_MS,
);

/** readFileSync with a named-failure wrapper — the pre-spend host-plan read must fail with the file's PATH, not a bare ENOENT. */
function readFileUtf8(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${label} could not be read at ${path}: ${(e as Error).message} — restore it and re-run; nothing was spent`);
  }
}
