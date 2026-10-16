#!/usr/bin/env bun
/**
 * A3 · the weekly maintenance sweep pass — a bounded, EXITING host-side
 * invocation (DF3.8 / A1 manager-digest precedent): read the manager config of
 * record, run ONE sweep through `runSweep`, persist the report record, exit.
 * No daemon, no PID file, no loop flag, no timer (INV-A3-RESIDENT): the
 * schedule IS the documented crontab entry in deploy/vps/crontab.factory, and
 * the only resident is the E21 Maintenance manager bot, which triggers and
 * reports but never runs this script (B3: Home bots cannot exec factory
 * scripts).
 *
 * Crontab entry (A3-owned line in A6's file — kept as a line comment because
 * the minute field's `*` + `/` forms would close a block comment):
 */
//   17 3 * * 1 cd /opt/qds-factory && PATH="$HOME/.bun/bin:/usr/local/bin:$HOME/.local/bin:$PATH" bun scripts/maintenance-sweep.ts >> /var/log/qds/maintenance-sweep.log 2>&1
/**
 * Runs reach the approve gate through DF3.7's chain, driven by DF3.8's
 * `fleet observe --all` sweep — its cron line sits beside this one in
 * deploy/vps/crontab.factory. This pass submits and leaves; it is never a
 * second chain and never an approver.
 *
 * Exit contract:
 *   0  complete — the sweep ran (per-brief refusals and leg refusals are
 *      COUNTED outcomes on the `maintenance.sweep` channel, AC4), including an
 *      empty sweep; also 0 when coalesced (another sweep holds the run lock —
 *      a `sweep-coalesced` line names it) or already-swept (this week's report
 *      delivered or dispatched something)
 *   1  the pass's own failure — the report record could not be persisted (the
 *      dispatched briefs stand; the record is the wake's handoff)
 *   2  config-refused or usage — unknown flag, a --driver other than exedev,
 *      a bad --max-briefs, the config of record unreadable or refused by
 *      validateManagerConfig, or a state dir outside the repo root
 *   3  pre-flight infra failure — not run from the repo root, origin is not a
 *      github.com remote, HEAD is not on any remote branch (a box could not
 *      clone it), the runs dir / run lock could not be claimed, or the lock is
 *      stale (holder proven dead: operator territory)
 * Refusals print ONE `{"error":{code,message,remediation}}` line to stderr.
 *
 * Flags:
 *   --driver <name>  default and only accepted value: exedev
 *   --config <path>  manager config JSON; default config/manager.json
 *   --max-briefs <n> lower the per-sweep cap (1..5; never raises it) — the
 *                    one-box live tier runs at 1
 *   --graph-leg      INTERNAL: the in-lock graph read (run by this script
 *                    under `flock -s -n <graph-home>/.refresh.lock`)
 *
 * Env seams (all unset in production):
 *   QDS_SWEEP_STATE_DIR   pass state home (reports + generated briefs);
 *                         default .sandbox/maintenance — must sit under the
 *                         repo root (dispatch resolves manifestPath there)
 *   QDS_SWEEP_FLEET_ENTRY fleet CLI entry override (default scripts/fleet.ts)
 *   QDS_GITNEXUS_HOME     graph home (A6's own override; lock + stamp)
 *   QDS_GITNEXUS_BIN      gitnexus binary override
 *   QDS_RUNS_DIR / QDS_AUDIT_DB / QDS_COST_LEDGER_FILE — the stores' own overrides
 *   QDS_SWEEP_ALLOW_UNPUSHED=1  TEST SEAM ONLY: skip the pushed-HEAD pre-flight
 *                         (a CI pull_request checkout is a merge commit on no
 *                         remote branch). Production never sets it: an
 *                         unpushed commit is one no box can clone.
 */

import { Database } from "bun:sqlite";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { chainVerdict, walkAuditChain } from "../src/audit/chain.ts";
import { log } from "../src/lib/log.ts";
import { fleetCliInvoker, FleetVerbTimeoutError } from "../src/managers/digest-composer.ts";
import { ManagerConfigError, validateManagerConfig } from "../src/managers/manager-config.ts";
import {
  classifyGraphChild,
  DEFAULT_SWEEP_STATE_DIR,
  decideGraphLeg,
  FAN_IN_CYPHER,
  type GraphLeg,
  MAINT_DISPATCH_CEILING_MS,
  MAX_BRIEFS_PER_SWEEP,
  type RepoIdentity,
  type StalenessVerdict,
  runSweep,
  type SubmitAnswer,
} from "../src/maintenance/sweep-plan.ts";
import { resolveRunsDir, RunRecordStore } from "../src/providers/run-record.ts";
import { killTree } from "./lib/kill-tree.ts";
import { RunLockedError, withRunLock } from "./lib/run-lock.ts";

const EXIT = { complete: 0, passFailed: 1, configRefused: 2, preflight: 3 } as const;
const SWEEP_LOCK_RUN_ID = "maintenance-sweep";
const GRAPH_LEG_TIMEOUT_MS = 120_000;
/** The submit child outlives the dispatch ceiling it passes, by a margin, so the CLI's own refusal is what reports. */
const SUBMIT_TIMEOUT_MS = MAINT_DISPATCH_CEILING_MS + 300_000;
const SOURCE_ROSTER = "config/rosters/roster.yaml";
/**
 * src/audit/link-store.ts DEFAULT_AUDIT_DB_FILE, restated so this CLI imports
 * nothing from the store's writer module (a drift test reads it back).
 */
export const AUDIT_DB_DEFAULT = ".sandbox/audit.db";
/** The repo this script belongs to — the only root it runs against. */
const REPO_ROOT = resolve(import.meta.dir, "..");

/** One structured refusal line on stderr, then exit. */
function die(exit: number, code: string, message: string, remediation: string): never {
  writeSync(2, `${JSON.stringify({ error: { code, message, remediation } })}\n`);
  process.exit(exit);
}

function resolveGitnexusBin(): string | undefined {
  const override = process.env.QDS_GITNEXUS_BIN;
  if (override) return override;
  const onPath = Bun.which("gitnexus");
  if (onPath) return onPath;
  // install-gitnexus-plus.sh's own fallback location.
  const home = process.env.HOME ? join(process.env.HOME, ".local/node-arm64/bin/gitnexus") : "";
  return home !== "" && existsSync(home) ? home : undefined;
}

/** A6's graph-home resolution: QDS_GITNEXUS_HOME, else <repoRoot>/.gitnexus — the same root the staleness reader resolves. */
const graphHome = (): string =>
  process.env.QDS_GITNEXUS_HOME ? resolve(process.env.QDS_GITNEXUS_HOME) : join(REPO_ROOT, ".gitnexus");

/**
 * Parse the staleness reader's one-line verdict (scripts/gitnexus-staleness.ts
 * contract). Lives HERE, not in src/maintenance: A6's AC6 boundary keeps the
 * refresh surface out of src/, and this CLI is the sanctioned A3 consumer.
 */
function parseStalenessVerdict(stdout: string): StalenessVerdict | undefined {
  try {
    const v = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    if (typeof v.verdict !== "string" || typeof v.stampPath !== "string") return undefined;
    const ageHours = typeof v.ageHours === "number" && Number.isFinite(v.ageHours) ? v.ageHours : null;
    return { verdict: v.verdict, ageHours, stampPath: v.stampPath };
  } catch {
    return undefined;
  }
}

/** The JSON object in the cypher CLI's stdout: the first line that BEGINS with `{` (the banner precedes it). */
export function cypherJson(stdout: string): { markdown: string } | { error: string } {
  const m = /^\{/m.exec(stdout);
  if (m === null) return { error: "cypher output carried no JSON object" };
  try {
    const parsed = JSON.parse(stdout.slice(m.index)) as { markdown?: unknown };
    return typeof parsed.markdown === "string" ? { markdown: parsed.markdown } : { error: "cypher result carried no markdown" };
  } catch {
    return { error: "cypher output did not parse" };
  }
}

// ─── INTERNAL: the in-lock graph leg (AC3a/b) ────────────────────────────────
// Runs under the SHARED flock, so the freshness check and the graph read both
// happen while no refresh can hold the exclusive lock. Always prints ONE JSON
// line and exits 0 — the parent tells contention from failure by that shape.

function graphLegChild(): never {
  let leg: GraphLeg;
  try {
    const stale = spawnSync(process.execPath, [join(import.meta.dir, "gitnexus-staleness.ts")], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: process.env,
    });
    leg = decideGraphLeg(parseStalenessVerdict(stale.stdout ?? ""), () => {
      const bin = resolveGitnexusBin();
      if (bin === undefined) return { error: "gitnexus CLI not found (PATH, ~/.local/node-arm64/bin, QDS_GITNEXUS_BIN)" };
      const q = spawnSync(bin, ["cypher", FAN_IN_CYPHER, "-r", REPO_ROOT], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
      if (q.status !== 0) return { error: `gitnexus cypher exited ${q.status}: ${(q.stderr ?? "").trim().slice(0, 200)}` };
      return cypherJson(q.stdout ?? "");
    });
  } catch (e) {
    leg = { status: "graph-unavailable", message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  // writeSync: piped stdout can still be pending when process.exit tears down
  // (the staleness reader's measured idiom).
  writeSync(1, `${JSON.stringify(leg)}\n`);
  process.exit(0);
}

/**
 * A throwaway snapshot of the audit store for the walk (AC3c read-only): the
 * walker appends first-observation baselines to whatever store it opens, so it
 * opens a COPY, made through a read-only connection. undefined = no store to
 * copy (every walk then fails, counted — never a fabricated clean chain).
 */
export function snapshotAuditDb(source: string, into: string): string | undefined {
  if (!existsSync(source)) return undefined;
  const target = join(into, "audit-snapshot.db");
  const db = new Database(source, { readonly: true });
  try {
    db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  return target;
}

async function main(): Promise<void> {
  if (process.argv.includes("--graph-leg")) graphLegChild();

  // ─── argv ──────────────────────────────────────────────────────────────────

  let driver = "exedev";
  let configPath = "config/manager.json";
  let maxBriefs: number | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--max-briefs") {
      const value = args[++i] ?? "";
      const n = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
      if (!(n >= 1 && n <= MAX_BRIEFS_PER_SWEEP)) die(EXIT.configRefused, "usage", `--max-briefs ${JSON.stringify(value)} is not an integer 1..${MAX_BRIEFS_PER_SWEEP}`, "the flag can only lower the per-sweep cap");
      maxBriefs = n;
    } else if (arg === "--driver" || arg === "--config") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) die(EXIT.configRefused, "usage", `flag ${arg} requires a value`, "usage: bun scripts/maintenance-sweep.ts [--driver exedev] [--config <path>] [--max-briefs <n>]");
      if (arg === "--driver") driver = value;
      else configPath = value;
    } else {
      // No --daemon, no --loop, ever: the crontab line is the schedule.
      die(EXIT.configRefused, "usage", `unknown flag: ${arg}`, "accepted flags: --driver <name>, --config <path>, --max-briefs <n>");
    }
  }
  if (driver !== "exedev") die(EXIT.configRefused, "usage", `--driver ${driver} is refused`, "the sweep submits through exedev only");

  // ─── pre-flight: the repo root (dispatch resolves manifests against cwd) ───

  let cwdReal: string;
  let rootReal: string;
  try {
    cwdReal = realpathSync(process.cwd());
    rootReal = realpathSync(REPO_ROOT);
  } catch (e) {
    die(EXIT.preflight, "preflight", String((e as Error)?.message ?? e), "run from the factory checkout");
  }
  if (cwdReal !== rootReal) {
    die(EXIT.preflight, "not-repo-root", `cwd ${cwdReal} is not the repo root ${rootReal}`, "cd to the repo root first (the crontab entry does: cd /opt/qds-factory && …)");
  }

  // ─── the config of record (A1) ─────────────────────────────────────────────

  let homeOwnerId: string;
  let botId: string;
  try {
    const config = validateManagerConfig(JSON.parse(await Bun.file(configPath).text()));
    homeOwnerId = config.homes[0].owner.id;
    const maint = config.bots.find((b) => b.department === "maintenance");
    if (maint === undefined) throw new Error("no maintenance bot in the config of record");
    botId = maint.id;
  } catch (e) {
    if (e instanceof ManagerConfigError) die(EXIT.configRefused, e.code, e.message, e.remediation);
    die(EXIT.configRefused, "config-unreadable", String((e as Error)?.message ?? e), `place A1's manager config of record at ${configPath} (or pass --config)`);
  }

  // ─── the state dir must sit under the repo root (checked BEFORE any write) ─

  const stateDir = resolve(rootReal, process.env.QDS_SWEEP_STATE_DIR ?? DEFAULT_SWEEP_STATE_DIR);
  const inside = (p: string) => p === rootReal || p.startsWith(`${rootReal}${sep}`);
  if (!inside(stateDir)) {
    die(EXIT.configRefused, "state-dir-outside-repo", `state dir ${stateDir} is outside the repo root ${rootReal}`, "dispatch resolves each brief's manifestPath against the repo root — point QDS_SWEEP_STATE_DIR beneath it");
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    if (!inside(realpathSync(stateDir))) throw new Error(`state dir ${stateDir} resolves outside the repo root through a symlink`);
  } catch (e) {
    die(EXIT.configRefused, "state-dir-unusable", String((e as Error)?.message ?? e), "point QDS_SWEEP_STATE_DIR at a writable directory beneath the repo root");
  }

  // ─── repo identity (the brief's repo = this checkout, at a pushed commit) ──

  function git(argv: string[]): string {
    const r = spawnSync("git", argv, { cwd: rootReal, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  }

  let repo: RepoIdentity;
  try {
    const commitSha = git(["rev-parse", "HEAD"]);
    const remote = git(["remote", "get-url", "origin"]);
    // git@github.com:o/r, ssh://git@github.com/o/r, https://github.com/o/r — each
    // with an optional .git and trailing slash. A remote carrying credentials is
    // refused rather than normalized (the brief's repoUrl must never carry one).
    const m = remote.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
    if (m === null || m[1] === undefined) throw new Error(`origin ${remote.replace(/\/\/[^@/]+@/, "//***@")} is not a credential-free github.com remote`);
    if (process.env.QDS_SWEEP_ALLOW_UNPUSHED !== "1" && git(["branch", "-r", "--contains", commitSha]) === "") {
      throw new Error(`HEAD ${commitSha} is on no remote branch — a box could not clone it`);
    }
    repo = { repoSlug: m[1], repoUrl: `https://github.com/${m[1]}`, commitSha };
  } catch (e) {
    die(EXIT.preflight, "repo-identity", String((e as Error)?.message ?? e), "deploy a pushed commit of a github.com checkout (git fetch; git status)");
  }

  // ─── production deps ───────────────────────────────────────────────────────

  const fleetEntry = process.env.QDS_SWEEP_FLEET_ENTRY;
  const submitCli = fleetCliInvoker({ ...(fleetEntry ? { entry: fleetEntry } : {}), timeoutMs: SUBMIT_TIMEOUT_MS });
  const requestId = crypto.randomUUID();

  async function graphLeg(): Promise<GraphLeg> {
    const home = graphHome();
    // No graph home = no stamp: the reader's own `absent` verdict, without
    // creating the consumer-side directory a refresh owns.
    if (!existsSync(home)) return { status: "graph-stale", graphAgeMs: null, verdict: "absent", stampPath: join(home, "cli-version.json") };
    const flock = Bun.which("flock");
    if (flock === null) return { status: "graph-unavailable", message: "flock not found on PATH — the shared refresh lock cannot be taken (AC3b)" };
    // DETACHED: its own process group, so the timeout's killTree reaches the
    // in-lock bun child and its gitnexus grandchild, not just flock — an
    // orphan would keep the shared lock (blocking A6's refresh) and the pipes.
    const proc = Bun.spawn([flock, "-s", "-n", join(home, ".refresh.lock"), process.execPath, import.meta.path, "--graph-leg"], {
      cwd: rootReal,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      detached: true,
    });
    const timer = setTimeout(() => killTree(proc as unknown as ChildProcess), GRAPH_LEG_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return classifyGraphChild({ exitCode, stdout, stderr });
    } finally {
      clearTimeout(timer);
    }
  }

  async function submit(briefPath: string, rid: string): Promise<SubmitAnswer> {
    try {
      return await submitCli(["submit", "--driver", "exedev", "--brief", briefPath, "--request-id", rid, "--timeout-ms", String(MAINT_DISPATCH_CEILING_MS)]);
    } catch (e) {
      if (e instanceof FleetVerbTimeoutError) return { timedOut: true };
      return { failed: String((e as Error)?.message ?? e) };
    }
  }

  // ─── the pass, under the run lock ──────────────────────────────────────────

  let runsDir: string;
  try {
    runsDir = resolveRunsDir();
    mkdirSync(runsDir, { recursive: true });
  } catch (e) {
    die(EXIT.preflight, "runs-dir", String((e as Error)?.message ?? e), "make the runs dir (QDS_RUNS_DIR / .sandbox/runs) creatable by the deploy user");
  }
  // Built AFTER the runs dir exists: a fresh deployment's store opens empty,
  // not absent. A store that still will not open is the audit leg's counted
  // `audit-unavailable` (listRecords throws below), never a silent empty window.
  let store: RunRecordStore | undefined;
  let storeError: string | undefined;
  try {
    store = new RunRecordStore({ create: false });
  } catch (e) {
    storeError = String((e as Error)?.message ?? e);
  }
  let exitCode: number = EXIT.complete;
  try {
    await withRunLock(
      runsDir,
      SWEEP_LOCK_RUN_ID,
      "maintenance-sweep",
      async () => {
        const snapshotDir = mkdtempSync(join(tmpdir(), "a3-audit-snapshot-"));
        try {
          let auditDb: string | undefined;
          let snapshotError: string | undefined;
          try {
            auditDb = snapshotAuditDb(resolve(rootReal, process.env.QDS_AUDIT_DB ?? AUDIT_DB_DEFAULT), snapshotDir);
          } catch (e) {
            snapshotError = String((e as Error)?.message ?? e);
          }
          const result = await runSweep({
            now: () => new Date(),
            requestId,
            stateDir,
            repo,
            botTarget: { homeOwnerId, botId },
            ...(maxBriefs === undefined ? {} : { maxBriefs }),
            graphLeg,
            audit: {
              listRecords: () => {
                if (store === undefined) throw new Error(`run record store unavailable: ${storeError ?? "unknown"}`);
                const l = store.listWithAnomalies();
                return { records: l.records, skipped: l.skipped.length };
              },
              readRecord: (id) => {
                if (store === undefined) throw new Error("run record store unavailable");
                return store.get(id);
              },
              brokenHops: async (runId) => {
                if (auditDb === undefined) throw new Error(`audit store snapshot unavailable${snapshotError ? `: ${snapshotError}` : " (no store)"}`);
                return chainVerdict(await walkAuditChain(runId, { requestId, auditDb })).brokenHops.map((h) => h.hop);
              },
            },
            materialize: (b, manifest) => {
              const dir = join(stateDir, "briefs", b.workId.split("/")[1] ?? "unknown", b.briefId);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, "pipeline.json"), `${JSON.stringify(manifest, null, 2)}\n`);
              // The setup gate reads the ACTIVE roster beside the manifest (dispatch.ts).
              copyFileSync(join(rootReal, SOURCE_ROSTER), join(dir, "roster.yaml"));
              const rel = relative(rootReal, join(dir, "pipeline.json"));
              if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`brief dir ${dir} is outside the repo root`);
              return { briefPath: join(dir, "brief.json"), manifestPath: rel.split(sep).join("/") };
            },
            writeBrief: (briefPath, brief) => writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`),
            submit,
          });
          if (result.outcome === "complete" && !result.reportPersisted) {
            writeSync(2, `${JSON.stringify({ error: { code: "report-persist-failed", message: result.reportError ?? "unknown", remediation: "the dispatched briefs stand; restore the state dir and re-run this week" } })}\n`);
            exitCode = EXIT.passFailed;
          }
        } finally {
          rmSync(snapshotDir, { recursive: true, force: true });
        }
      },
      { requestId },
    );
  } catch (e) {
    if (e instanceof RunLockedError) {
      if (e.stale) die(EXIT.preflight, "stale-run-lock", e.message, e.remediation);
      // Coalesced is exit 0, but never silent: one channel line names it, so a
      // wedged holder that coalesces every week is visible in the log.
      log({
        requestId,
        operation: "maintenance.sweep",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "ok",
        event: "sweep-coalesced",
        message: e.message,
      });
      process.exitCode = EXIT.complete;
      return;
    }
    die(EXIT.passFailed, "sweep-failed", String((e as Error)?.message ?? e), "a defect in the pass itself — the channel lines above show how far it got");
  }

  // process.exitCode, not process.exit: the channel's stdout drains first.
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
