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
 * `fleet observe --all` sweep (its own documented operator cron, see
 * `fleet observe --help`) — this pass submits and leaves; it is never a second
 * chain and never an approver.
 *
 * Exit contract:
 *   0  complete — the sweep ran (per-brief refusals and graph-leg refusals are
 *      COUNTED outcomes on the `maintenance.sweep` channel, AC4), including an
 *      empty sweep; also 0 when coalesced (another sweep holds the run lock)
 *      or already-swept (this week's report record exists)
 *   1  the pass's own failure — the report record could not be persisted (the
 *      dispatched briefs stand; the record is the wake's handoff)
 *   2  config-refused or usage — unknown flag, a --driver other than exedev,
 *      the config of record unreadable or refused by validateManagerConfig
 *   3  pre-flight infra failure — the runs dir / run lock could not be
 *      claimed, or the lock is stale (holder proven dead: operator territory)
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
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chainVerdict, walkAuditChain } from "../src/audit/chain.ts";
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
import { RunLockedError, withRunLock } from "./lib/run-lock.ts";

const EXIT = { complete: 0, passFailed: 1, configRefused: 2, preflight: 3 } as const;
const SWEEP_LOCK_RUN_ID = "maintenance-sweep";
const GRAPH_LEG_TIMEOUT_MS = 120_000;
/** The submit child outlives the dispatch ceiling it passes, by a margin, so the CLI's own refusal is what reports. */
const SUBMIT_TIMEOUT_MS = MAINT_DISPATCH_CEILING_MS + 300_000;
const SOURCE_ROSTER = "config/rosters/roster.yaml";

function die(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
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

const graphHome = (): string =>
  process.env.QDS_GITNEXUS_HOME ? resolve(process.env.QDS_GITNEXUS_HOME) : join(process.cwd(), ".gitnexus");

// ─── INTERNAL: the in-lock graph leg (AC3a/b) ────────────────────────────────
// Runs under the SHARED flock, so the freshness check and the graph read both
// happen while no refresh can hold the exclusive lock. Always prints ONE JSON
// line and exits 0 — the parent tells contention from failure by that shape.

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

function graphLegChild(): never {
  let leg: GraphLeg;
  try {
    const stale = spawnSync(process.execPath, [join(import.meta.dir, "gitnexus-staleness.ts")], {
      encoding: "utf8",
      timeout: 30_000,
      env: process.env,
    });
    leg = decideGraphLeg(parseStalenessVerdict(stale.stdout ?? ""), () => {
      const bin = resolveGitnexusBin();
      if (bin === undefined) return { error: "gitnexus CLI not found (PATH, ~/.local/node-arm64/bin, QDS_GITNEXUS_BIN)" };
      const q = spawnSync(bin, ["cypher", FAN_IN_CYPHER, "-r", process.cwd()], { encoding: "utf8", timeout: 60_000 });
      if (q.status !== 0) return { error: `gitnexus cypher exited ${q.status}: ${(q.stderr ?? "").trim().slice(0, 200)}` };
      // The CLI prints a banner before its JSON object; take the object.
      const out = q.stdout ?? "";
      const start = out.indexOf("{");
      try {
        const parsed = JSON.parse(out.slice(start)) as { markdown?: unknown };
        return typeof parsed.markdown === "string" ? { markdown: parsed.markdown } : { error: "cypher result carried no markdown" };
      } catch {
        return { error: "cypher output did not parse" };
      }
    });
  } catch (e) {
    leg = { status: "graph-unavailable", message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(leg)}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--graph-leg")) graphLegChild();

  // ─── argv ────────────────────────────────────────────────────────────────────

  let driver = "exedev";
  let configPath = "config/manager.json";
  let maxBriefs: number | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--max-briefs") {
      const value = args[++i] ?? "";
      const n = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
      if (!(n >= 1 && n <= MAX_BRIEFS_PER_SWEEP)) die(EXIT.configRefused, `--max-briefs must be an integer 1..${MAX_BRIEFS_PER_SWEEP} (it can only lower the cap)`);
      maxBriefs = n;
    } else if (arg === "--driver" || arg === "--config") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) die(EXIT.configRefused, `flag ${arg} requires a value`);
      if (arg === "--driver") driver = value;
      else configPath = value;
    } else {
      // No --daemon, no --loop, ever: the crontab line is the schedule.
      die(EXIT.configRefused, `unknown flag: ${arg} — accepted flags: --driver <name>, --config <path>, --max-briefs <n>`);
    }
  }
  if (driver !== "exedev") die(EXIT.configRefused, `--driver ${driver} is refused — the sweep submits through exedev only`);

  // ─── the config of record (A1) ───────────────────────────────────────────────

  let homeOwnerId: string;
  let botId: string;
  try {
    const config = validateManagerConfig(JSON.parse(await Bun.file(configPath).text()));
    homeOwnerId = config.homes[0].owner.id;
    const maint = config.bots.find((b) => b.department === "maintenance");
    if (maint === undefined) throw new Error("no maintenance bot in the config of record");
    botId = maint.id;
  } catch (e) {
    const err =
      e instanceof ManagerConfigError
        ? { code: e.code, message: e.message, remediation: e.remediation }
        : { code: "config-unreadable", message: String((e as Error)?.message ?? e) };
    die(EXIT.configRefused, JSON.stringify({ error: err }));
  }

  // ─── repo identity (the brief's repo = this checkout) ────────────────────────

  function git(argv: string[]): string {
    const r = spawnSync("git", argv, { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  }

  let repo: RepoIdentity;
  try {
    const commitSha = git(["rev-parse", "HEAD"]);
    const remote = git(["remote", "get-url", "origin"]);
    // git@github.com:o/r(.git) and https://github.com/o/r(.git) both normalize to the https form.
    const m = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/);
    if (m === null || m[1] === undefined) throw new Error(`origin ${remote} is not a github.com remote`);
    repo = { repoSlug: m[1], repoUrl: `https://github.com/${m[1]}`, commitSha };
  } catch (e) {
    die(EXIT.preflight, `maintenance-sweep: pre-flight: ${String((e as Error)?.message ?? e)}`);
  }

  // ─── production deps ─────────────────────────────────────────────────────────

  const repoRoot = process.cwd();
  const stateDir = resolve(process.env.QDS_SWEEP_STATE_DIR ?? DEFAULT_SWEEP_STATE_DIR);
  const fleetEntry = process.env.QDS_SWEEP_FLEET_ENTRY;
  const submitCli = fleetCliInvoker({ ...(fleetEntry ? { entry: fleetEntry } : {}), timeoutMs: SUBMIT_TIMEOUT_MS });
  const resultCli = fleetCliInvoker(fleetEntry ? { entry: fleetEntry } : undefined);
  const requestId = crypto.randomUUID();

  async function graphLeg(): Promise<GraphLeg> {
    const home = graphHome();
    // No graph home = no stamp: the reader's own `absent` verdict, without
    // creating the consumer-side directory a refresh owns.
    if (!existsSync(home)) return { status: "graph-stale", graphAgeMs: null, verdict: "absent", stampPath: join(home, "cli-version.json") };
    const flock = Bun.which("flock");
    if (flock === null) return { status: "graph-unavailable", message: "flock not found on PATH — the shared refresh lock cannot be taken (AC3b)" };
    const proc = Bun.spawn([flock, "-s", "-n", join(home, ".refresh.lock"), process.execPath, import.meta.path, "--graph-leg"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), GRAPH_LEG_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return classifyGraphChild({ exitCode, stdout, stderr });
    } finally {
      clearTimeout(timer);
    }
  }

  const store = (() => {
    try {
      return new RunRecordStore({ create: false });
    } catch {
      return undefined;
    }
  })();

  async function submit(briefPath: string, rid: string): Promise<SubmitAnswer> {
    try {
      return await submitCli(["submit", "--driver", "exedev", "--brief", briefPath, "--request-id", rid, "--timeout-ms", String(MAINT_DISPATCH_CEILING_MS)]);
    } catch (e) {
      if (e instanceof FleetVerbTimeoutError) return { timedOut: true };
      return { failed: String((e as Error)?.message ?? e) };
    }
  }

  // ─── the pass, under the run lock ────────────────────────────────────────────

  let runsDir: string;
  try {
    runsDir = resolveRunsDir();
    mkdirSync(runsDir, { recursive: true });
  } catch (e) {
    die(EXIT.preflight, `maintenance-sweep: pre-flight infra failure: ${String((e as Error)?.message ?? e)}`);
  }

  let exitCode: number = EXIT.complete;
  try {
    await withRunLock(
      runsDir,
      SWEEP_LOCK_RUN_ID,
      "maintenance-sweep",
      async () => {
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
              if (store === undefined) return { records: [], skipped: 0 };
              const l = store.listWithAnomalies();
              return { records: l.records, skipped: l.skipped.length };
            },
            readRecord: (id) => {
              if (store === undefined) throw new Error("run record store unavailable");
              return store.get(id);
            },
            brokenHops: async (runId) => chainVerdict(await walkAuditChain(runId, { requestId })).brokenHops.map((h) => h.hop),
            resultExit: async (runId) => {
              try {
                return (await resultCli(["result", runId])).exitCode;
              } catch {
                return undefined;
              }
            },
          },
          materialize: (b, manifest) => {
            const dir = join(stateDir, "briefs", b.workId.split("/")[1] ?? "unknown", b.briefId);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "pipeline.json"), `${JSON.stringify(manifest, null, 2)}\n`);
            // The setup gate reads the ACTIVE roster beside the manifest (dispatch.ts).
            copyFileSync(join(repoRoot, SOURCE_ROSTER), join(dir, "roster.yaml"));
            const rel = relative(repoRoot, join(dir, "pipeline.json"));
            if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`state dir ${stateDir} is outside the repo root — dispatch cannot resolve the manifest`);
            return { briefPath: join(dir, "brief.json"), manifestPath: rel.split("\\").join("/") };
          },
          writeBrief: (briefPath, brief) => writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`),
          submit,
        });
        if (result.outcome === "complete" && !result.reportPersisted) {
          process.stderr.write(`maintenance-sweep: report persist failed: ${result.reportError ?? "unknown"}\n`);
          exitCode = EXIT.passFailed;
        }
      },
      { requestId },
    );
  } catch (e) {
    if (e instanceof RunLockedError) {
      if (e.stale) die(EXIT.preflight, `maintenance-sweep: stale run lock: ${e.message} — ${e.remediation}`);
      die(EXIT.complete, "maintenance-sweep: another sweep is running — coalesced");
    }
    die(EXIT.passFailed, `maintenance-sweep: sweep failed: ${String((e as Error)?.message ?? e)}`);
  }

  // process.exitCode, not process.exit: the channel's stdout drains first.
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
