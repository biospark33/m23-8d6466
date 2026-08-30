/**
 * `reverify(runId)` — host-side out-of-box re-verification (Story DF5.1).
 *
 * The first host-side step after DF2.5 fetches a run's commits into
 * `refs/sandbox/<run-id>`. It re-runs the tests and the DF1.2 gate library in a
 * fresh process whose inputs are the fetched git objects, the host-pinned
 * manifest and the host toolchain — and nothing else (INV-RV-1). Artifacts the
 * box produced feed `claimed`/`discrepancies` only; deleting every one of them
 * must not move the verdict.
 *
 * On a green verdict it REQUESTS the approval (DF3.4) and returns. It never
 * opens a PR — that is DF5.2's, gated on the verdict this writes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { commandGate } from "../phase-engine/gates/command-gate.ts";
import type { GateCheck } from "../phase-engine/gates/report.ts";
import { RunRecordStore, resolveRunsDir } from "../providers/run-record.ts";
import type { ApprovalPort } from "./approval.ts";
import { recordApprovalPort } from "./approval.ts";
import { divergenceFlags, resolveHostPlan, type HostPlan } from "./plan.ts";
import {
  DEFAULT_REVERIFY_DIR,
  appendReport,
  readReports,
  sealReport,
  type RedactionMap,
  type ReverifyEvidence,
  type ReverifyReport,
} from "./report.ts";
import {
  DEFAULT_RSS_BYTES,
  DEFAULT_WALL_CLOCK_MS,
  ReverifyError,
  exec,
  probeToolchain,
  sandboxRef,
  withGuards,
  withQuarantineWorktree,
} from "./worktree.ts";

export interface ReverifyDeps {
  /** DF2.1's run record store. Defaults to `$QDS_RUNS_DIR` / `.sandbox/runs`. */
  store?: RunRecordStore;
  runsDir?: string;
  /** The operator's checkout — the host git repo AND where `.factory/` lives. */
  hostRoot?: string;
  reverifyDir?: string;
  worktreeRoot?: string;
  /** DF3.4's approval intake. Defaults to the RunRecord-backed adapter. */
  approval?: ApprovalPort;
  /**
   * The run's OWN known-sensitive values (INV-RV-4). Assembled by the caller;
   * never `process.env`, which INV-RV-3 already stripped.
   */
  redaction?: RedactionMap;
  wallClockMs?: number;
  rssBytes?: number;
  now?: () => Date;
  /** Structured step log sink; defaults to stderr NDJSON. */
  log?: (event: Record<string, unknown>) => void;
  /**
   * The host tools the plan needs. Overridden only by the AC4 test that removes
   * a tool from the resolved toolchain — a missing one must yield `error`.
   */
  tools?: readonly { name: string; argv: readonly string[] }[];
}

const REQUIRED_TOOLS = [
  { name: "git", argv: ["git", "--version"] as const },
  { name: "bun", argv: ["bun", "--version"] as const },
] as const;

/** Env keys never handed to the verify process (INV-RV-3). */
const CREDENTIAL_KEY_RE =
  /SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL|SSH|SIGNING|AUTH|[_-]KEY|APPROVER/i;

/**
 * A process environment with no provider key, GitHub token or approver token
 * (INV-RV-3). Built by REMOVING credential-shaped keys rather than by
 * allow-listing three names: the box's own key is minted per run and a new
 * credential added upstream must not silently start reaching this process.
 */
export function verifyEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (typeof value !== "string") continue;
    if (CREDENTIAL_KEY_RE.test(key)) continue;
    env[key] = value;
  }
  // The install must not reach a registry with an ambient token either.
  env.CI = "1";
  return env;
}

/**
 * Test counts from a `bun test` run. A run whose output carries no count line
 * at all yields `{0,0}` — which `deriveVerdict` turns into `no-tests-executed`
 * red, never a vacuous green.
 */
export function parseTestCounts(output: string): { passed: number; failed: number } {
  const pass = /^\s*(\d+)\s+pass\b/m.exec(output);
  const fail = /^\s*(\d+)\s+fail\b/m.exec(output);
  return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0 };
}

/**
 * What the box CLAIMED, recovered from DF2.5's artifacts pull.
 *
 * Matched by SHAPE rather than filename: the merged step output is DF1.6's
 * (`exitStatus`, `changedFiles`, `testResults`) and the harvest tar carries
 * whatever the run's workdir held. Absent, unreadable or unrecognisable all
 * yield `null`, which never blocks a verdict.
 */
export function readClaimed(artifactsDir: string): ReverifyEvidence["claimed"] {
  if (!existsSync(artifactsDir)) return null;
  const stack = [artifactsDir];
  let scanned = 0;
  while (stack.length > 0 && scanned < 2_000) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      scanned++;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!name.endsWith(".json") || st.size > 4 * 1024 * 1024) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      const o = parsed as Record<string, unknown> | null;
      if (
        o !== null &&
        typeof o === "object" &&
        typeof o.exitStatus === "string" &&
        Array.isArray(o.changedFiles) &&
        typeof o.testResults === "object" &&
        o.testResults !== null
      ) {
        const tr = o.testResults as Record<string, unknown>;
        if (typeof tr.passed !== "number" || typeof tr.failed !== "number") continue;
        return {
          exitStatus: o.exitStatus,
          testResults: { passed: tr.passed, failed: tr.failed },
          changedFiles: (o.changedFiles as unknown[]).filter((f): f is string => typeof f === "string"),
        };
      }
    }
  }
  return null;
}

/** Count comparisons, in BOTH directions. The verdict is untouched by them. */
function countDiscrepancies(
  claimed: ReverifyEvidence["claimed"],
  host: { passed: number; failed: number },
): string[] {
  if (claimed === null) return [];
  const out: string[] = [];
  if (claimed.testResults.passed !== host.passed) {
    out.push(`testResults.passed: claimed ${claimed.testResults.passed}, host ${host.passed}`);
  }
  if (claimed.testResults.failed !== host.failed) {
    out.push(`testResults.failed: claimed ${claimed.testResults.failed}, host ${host.failed}`);
  }
  return out;
}

function stderrLog(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

interface Timings {
  worktree_ms: number;
  install_ms: number;
  tests_ms: number;
  gates_ms: number;
  cleanup_ms: number;
}

export interface ReverifyOutcome {
  report: ReverifyReport;
  /** The AC6 approval decision, or null on a red/error verdict. */
  approval:
    | { outcome: "requested" }
    | { outcome: "rebound"; supersededReportId: string }
    | { outcome: "pause-in-progress" }
    | { outcome: "already-decided"; state: string }
    | null;
}

/**
 * Re-verify one harvested run. Always returns a typed outcome — a host that
 * cannot complete the check yields an `error` REPORT, not a thrown error, so
 * the fail-closed verdict is always on disk (AC4, INV-RV-5).
 */
export async function reverify(runId: string, deps: ReverifyDeps = {}): Promise<ReverifyOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? stderrLog;
  const started = now();
  const startedMs = Date.now();
  const hostRoot = deps.hostRoot ?? process.cwd();
  const runsDir = resolveRunsDir(deps.runsDir);
  const store = deps.store ?? new RunRecordStore({ dir: runsDir, create: false });
  const reverifyDir = deps.reverifyDir ?? join(hostRoot, DEFAULT_REVERIFY_DIR);
  const redaction = deps.redaction ?? {};

  const timings: Timings = { worktree_ms: 0, install_ms: 0, tests_ms: 0, gates_ms: 0, cleanup_ms: 0 };
  // Stamped when the worktree body returns, so `cleanup_ms` measures the prune
  // that follows it and not "everything that was not gates".
  let bodyEndedMs = 0;
  const checks: GateCheck[] = [];
  const flags: string[] = [];
  const discrepancies: string[] = [];
  let testResults = { passed: 0, failed: 0 };
  let toolchain: Record<string, string> = {};
  let claimed: ReverifyEvidence["claimed"] = null;
  let headSha = "";
  let baseSha = "";
  let requestId = "unknown";
  let noTestSuite = false;
  let failure: { code: string; message: string; remediation: string } | undefined;

  // Lowercase and hyphenated on purpose: this id is written into the run
  // record as `extensions.approval.reportId`, and DF2.1's `assertNoSecret`
  // refuses any long mixed-case alphanumeric there as suspected key material.
  const reverifyId =
    `rv-${runId}-${started.toISOString().replace(/[:.]/g, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  const step = (name: string, ms: number, extra: Record<string, unknown> = {}): void =>
    log({ requestId, runId, reverifyId, step: name, timestamp: now().toISOString(), durationMs: ms, ...extra });

  const guards = withGuards({
    ...(deps.wallClockMs !== undefined ? { wallClockMs: deps.wallClockMs } : {}),
    ...(deps.rssBytes !== undefined ? { rssBytes: deps.rssBytes } : {}),
  });

  try {
    // ── preflight: everything that can refuse BEFORE a worktree exists ──
    const record = store.get(runId);
    requestId = record.requestId ?? "unknown";
    if (typeof record.commitSha !== "string" || record.commitSha.length === 0) {
      throw new ReverifyError(
        "no-base-sha",
        `run ${runId} carries no commitSha — the pinned base the box was filled at is unknown`,
        "inspect the run record; a run without a pinned base cannot be re-verified against one",
      );
    }
    baseSha = record.commitSha;

    const repoSlug = record.extensions?.budget?.repoSlug;
    if (typeof repoSlug !== "string" || repoSlug.length === 0) {
      throw new ReverifyError(
        "no-host-plan",
        `run ${runId} carries no extensions.budget.repoSlug — there is no key to look the host plan up by`,
        "dispatch runs through the DF2.8 budget gate so the record carries its repoSlug, then re-run",
      );
    }

    // AC5: zero commits beyond base is `nothing-to-verify` — a normal typed
    // outcome, and NO worktree is created.
    const refProbe = await exec(["git", "rev-parse", "--verify", "--quiet", `${sandboxRef(runId)}^{commit}`], {
      cwd: hostRoot,
    });
    const refSha = refProbe.exitCode === 0 ? refProbe.stdout.trim() : "";
    if (refSha === "" || refSha === baseSha) {
      headSha = refSha === "" ? baseSha : refSha;
      step("preflight", Date.now() - startedMs, { outcome: "nothing-to-verify" });
      const report = seal();
      appendReport(reverifyDir, report);
      return { report, approval: null };
    }
    headSha = refSha;

    const plan: HostPlan = resolveHostPlan({ hostRoot, repoSlug, baseSha });
    noTestSuite = plan.noTestSuite;
    toolchain = await probeRequired();
    flags.push(...(await divergenceFlags(hostRoot, baseSha, headSha)));
    step("preflight", Date.now() - startedMs, { outcome: "ok", manifest: plan.manifestPath });

    // `claimed` is read here and used for NOTHING but the comparison below.
    claimed = readClaimed(join(runsDir, `${runId}-artifacts`));

    const env = verifyEnv();
    const worktreeStart = Date.now();
    await withQuarantineWorktree(
      { gitCwd: hostRoot, runId, signal: guards.signal, ...(deps.worktreeRoot !== undefined ? { root: deps.worktreeRoot } : {}) },
      async (wt) => {
        timings.worktree_ms = Date.now() - worktreeStart;
        step("worktree", timings.worktree_ms, { dir: wt.dir, headSha: wt.headSha });

        // INV-RV-3: no lifecycle scripts, no lockfile drift.
        const installStart = Date.now();
        if (existsSync(join(wt.dir, "package.json"))) {
          const install = await exec(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
            cwd: wt.dir,
            env,
            signal: guards.signal,
          });
          timings.install_ms = Date.now() - installStart;
          checks.push({
            item: "install",
            ok: install.exitCode === 0,
            note:
              install.exitCode === 0
                ? "bun install --frozen-lockfile --ignore-scripts: exit 0"
                : `exit ${install.exitCode}\n${install.stderr || install.stdout}`,
          });
        } else {
          timings.install_ms = Date.now() - installStart;
        }
        step("install", timings.install_ms);

        // The host test run. Counts come from the host's own subprocess output,
        // never from anything the box wrote (INV-RV-1).
        if (plan.testCommand !== null) {
          const testStart = Date.now();
          const res = await exec(plan.testCommand, { cwd: wt.dir, env, signal: guards.signal });
          timings.tests_ms = Date.now() - testStart;
          testResults = parseTestCounts(`${res.stdout}\n${res.stderr}`);
          checks.push({
            item: `tests: ${plan.testCommand.join(" ")}`,
            ok: res.exitCode === 0,
            note:
              res.exitCode === 0
                ? `exit 0, ${testResults.passed} pass, ${testResults.failed} fail`
                : `exit ${res.exitCode}, ${testResults.passed} pass, ${testResults.failed} fail\n${res.stderr || res.stdout}`,
          });
          step("tests", timings.tests_ms, { passed: testResults.passed, failed: testResults.failed });
        }

        // DF1.2's gate library, in-process. No second implementation: the argv
        // comes from the host manifest and the evidence is `commandGate`'s.
        const gateStart = Date.now();
        for (const gate of plan.gateCommands) {
          const report = await commandGate(gate.argv, {
            label: gate.name,
            cwd: wt.dir,
            env,
            signal: guards.signal,
          }).run(undefined, { runRoot: wt.dir, env, signal: guards.signal });
          checks.push(...report.checks.map((c) => ({ item: c.item, ok: c.ok, note: c.note })));
        }
        timings.gates_ms = Date.now() - gateStart;
        step("gates", timings.gates_ms, { gates: plan.gateCommands.length });
        bodyEndedMs = Date.now();
      },
    );

    const tripped = guards.tripped();
    if (tripped !== null) {
      throw new ReverifyError(tripped.code, tripped.message, "raise the bound or reduce the run's work, then re-run");
    }

    discrepancies.push(...countDiscrepancies(claimed, testResults));
  } catch (e) {
    const err =
      e instanceof ReverifyError
        ? e
        : new ReverifyError(
            "reverify-failed",
            e instanceof Error ? e.message : String(e),
            "inspect the error above; reverify never retries a red into a green",
          );
    failure = { code: err.code, message: err.message, remediation: err.remediation };
    step("error", Date.now() - startedMs, { code: err.code });
  } finally {
    guards.dispose();
    timings.cleanup_ms = bodyEndedMs === 0 ? 0 : Math.max(0, Date.now() - bodyEndedMs);
  }

  // Two runs at the same sha that disagree are RED, never retried into green.
  const priorAtSha = readReports(reverifyDir, runId).filter((r) => r.headSha === headSha && r.verdict !== "error");
  const provisional = seal();
  // An `error` is a host failure, not a verdict about the tree: comparing it
  // against a prior green would brand a flaky toolchain probe as the CODE being
  // nondeterministic. Only two real verdicts at one sha can disagree.
  const nondeterministic =
    provisional.verdict !== "error" && priorAtSha.some((r) => r.verdict !== provisional.verdict);
  const report = nondeterministic ? seal(true) : provisional;

  appendReport(reverifyDir, report);
  step("report", Date.now() - startedMs, { verdict: report.verdict, reason: report.reason });

  if (report.verdict !== "green") return { report, approval: null };

  // A writable store: `store` above may be the read-only (`create: false`) one,
  // and the approval write needs a store that can create. `bundleDir` is wired
  // to harvest's own invariant (`harvest.ts:435-436`: the bundle IS
  // `<runsDir>/<runId>.bundle`), so the gate's `assertBundlePresent` actually
  // runs on this path — a green report whose bundle is gone is refused, not
  // bound to nothing.
  const port =
    deps.approval ?? recordApprovalPort(deps.store ?? new RunRecordStore({ dir: runsDir }), { bundleDir: runsDir });
  // The approval request is the LAST thing and it is caught: the green report
  // is already on disk, and a failed request must leave a report that SAYS so
  // rather than throwing past `reverify`'s typed outcome (AC4). DF5.2 gates on
  // the approval state, so no approval means no PR either way.
  //
  // A STRANDED `pausing` extension (a crash between registration and
  // promotion) re-presents the reportId it is already BOUND to, not this
  // report's fresh reverifyId: the gate's resume arm (AC1(c)) compares
  // byte-for-byte, and a fresh id would return `pause-in-progress` on every
  // retry — `pausing` never expires and nothing else promotes it, so the run
  // would be stranded for good. Only `pausing` re-presents: an
  // `awaiting-approval` record keeps the rebind-to-fresh-report semantics it
  // already has, and a terminal record loses to either id.
  const bound = store.get(runId).extensions?.approval;
  const reportId =
    String(bound?.state ?? "") === "pausing" && typeof bound?.reportId === "string" && bound.reportId !== ""
      ? bound.reportId
      : report.reverifyId;
  let approval: ReverifyOutcome["approval"];
  try {
    approval = await port.requestApproval(runId, {
      proposal: `open a PR for run ${runId} at ${report.headSha}`,
      reportId,
      headSha: report.headSha,
    });
  } catch (e) {
    flags.push("approval-request-failed");
    const flagged = seal(nondeterministic);
    appendReport(reverifyDir, flagged);
    step("approval", Date.now() - startedMs, {
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return { report: flagged, approval: null };
  }
  if (approval.outcome === "pause-in-progress" || approval.outcome === "already-decided") {
    // The flag belongs on the report, so re-seal and append the corrected one.
    const flag = approval.outcome === "pause-in-progress" ? "approval-pause-in-progress" : "approval-already-decided";
    flags.push(flag);
    const flagged = seal(nondeterministic);
    appendReport(reverifyDir, flagged);
    step("approval", Date.now() - startedMs, { outcome: approval.outcome });
    return { report: flagged, approval };
  }
  step("approval", Date.now() - startedMs, { outcome: approval.outcome });
  return { report, approval };

  function seal(nondet = false): ReverifyReport {
    const completed = now();
    return sealReport(
      {
        reverifyId,
        runId,
        requestId,
        headSha: headSha || baseSha || "unknown",
        baseSha: baseSha || "unknown",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, Date.now() - startedMs),
        checks,
        testResults,
        flags,
        discrepancies,
        claimed,
        toolchain,
        timings,
        ...(failure !== undefined ? { failure } : {}),
        ...(nondet ? { nondeterministic: true } : {}),
        ...(noTestSuite ? { noTestSuite: true } : {}),
      },
      redaction,
    );
  }

  async function probeRequired(): Promise<Record<string, string>> {
    const tools = deps.tools ?? REQUIRED_TOOLS;
    return probeToolchain(tools.map((t) => ({ name: t.name, argv: [...t.argv] })));
  }
}
