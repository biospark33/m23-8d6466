/**
 * The A1 manager digest CLI (leaf-1.2.2) — the bounded host-side invocation
 * the operator's crontab fires: read the manager config of record, validate
 * it, compose ONE digest through the real composer, exit. No daemon, no PID
 * file, no --daemon flag, no timer, no watcher: the schedule IS the crontab
 * line (DF3.8's bounded-exiting precedent), and the process runs once and
 * leaves. Secrets never ride argv — this script holds no token material at
 * all (INV-MGR-2/3), and the profile tokens it would ever learn about are
 * names, never values.
 *
 * Operator crontab entry (the A1 story's shape; byte-mirrored on the
 * gitnexus-refresh.sh / deploy/vps/crontab.factory precedent) — kept as line
 * comments because the leading `*` + `/` of the minute field would close a
 * block comment:
 *
 * Crontab coalescing: the digest leg runs under the named run lock
 * `<runsDir>/manager-digest.lock` (runsDir = $QDS_RUNS_DIR ?? .sandbox/runs,
 * via scripts/lib/run-lock.ts — the fleet CLIs' own never-steals lock); a cron
 * firing that lands while a digest is still running exits 0 with one stderr
 * line instead of racing it. An infra failure while claiming that lock (the
 * runs dir uncreatable or unwritable) exits 3 with one diagnostic line — it
 * never races and never crashes.
 */

//   */N * * * * cd /path/to/QDS-Factory && bun scripts/manager-digest.ts --driver exedev

/**
 * Exit contract — mirrors DIGEST_EXIT in src/managers/digest-composer.ts,
 * clamped once to this table before exit (scripts/fleet.ts's report() posture:
 * a code outside the table must never read as success):
 *
 *   0  composed           — the digest fired: snapshot, per-run lines,
 *                           escalation marks, digest-complete, all on the
 *                           composer's `managers.digest` log channel. Also 0
 *                           when coalesced: the digest run lock was held by a
 *                           LIVE digest (one stderr line, no digest run —
 *                           gitnexus-refresh.sh's succeeded-or-coalesced rule)
 *   1  status-unavailable — the observe leg degraded (timeout, non-zero
 *                           `fleet status`, unparseable stdout); the channel
 *                           still hears digest-complete and degraded figures
 *                           stay ABSENT, never 0. Also 1 when the digest
 *                           callback itself rejected (never-throws is proven —
 *                           this is a belt): `manager-digest: digest failed:`
 *                           on stderr, never the pre-flight exit-3 label.
 *   2  config-refused     — the config of record is unreadable or refused by
 *                           validateManagerConfig (org-owner, ceiling, shape —
 *                           the named ManagerConfigError code + remediation go
 *                           to stderr), or usage is wrong: an unknown flag, a
 *                           flag missing its value (a value starting with `--`
 *                           is a missing value), or a --driver other than
 *                           exedev (the composer's observe leg pins exedev —
 *                           silently ignoring a different value would be a lie)
 *   3  pre-flight infra failure — claiming the run lock threw (resolveRunsDir,
 *                           mkdirSync, lock-claim: EACCES/EROFS/ENOENT/ENOSPC
 *                           — anything that is not a RunLockedError), or the
 *                           lock refusal was STALE (the holder is proven dead —
 *                           an uncertain-state lock is operator territory, not
 *                           a success to coalesce): one stderr diagnostic line
 *                           naming the lock and the `rm` that clears it, no
 *                           digest attempt, no crash (gitnexus-refresh.sh's own
 *                           exit 3 = FATAL before-the-cycle posture)
 *
 * Any outcome whose `reason` is a non-empty string (status-unavailable's
 * degraded observe leg, or a composed digest whose result verbs were cut by
 * the total wall-clock budget) also prints `manager-digest: <reason>` to
 * stderr so the cron log carries the diagnostic.
 *
 * Flags:
 *   --driver <name>  the fleet driver; default and only accepted value is
 *                    `exedev` (the story's invocation shape)
 *   --config <path>  the manager config JSON; default config/manager.json
 *
 * Env seams (both unset in production):
 *   QDS_MANAGER_FLEET_ENTRY — path overriding the fleet CLI entry the
 *     invoker runs (default scripts/fleet.ts); how the e2e points the real
 *     binary at a fixture without a live provider.
 *   QDS_COST_LEDGER_FILE — the cost-ledger module's own read-path override
 *     (DF2.11), honored untouched.
 */

import { mkdirSync } from "node:fs";
import { CostLedger } from "../src/providers/cost-ledger.ts";
import { resolveRunsDir, RunRecordStore } from "../src/providers/run-record.ts";
import {
  composeDigest,
  DIGEST_EXIT,
  fleetCliInvoker,
  type DigestDeps,
  type DigestOutcome,
} from "../src/managers/digest-composer.ts";
import {
  ManagerConfigError,
  validateManagerConfig,
} from "../src/managers/manager-config.ts";
import { RunLockedError, withRunLock } from "./lib/run-lock.ts";

const DEFAULT_CONFIG_PATH = "config/manager.json";
const DEFAULT_DRIVER = "exedev";
/** The named run lock (P7): `<runsDir>/<this>.lock` coalesces overlapping cron firings. */
const DIGEST_LOCK_RUN_ID = "manager-digest";

// The refuse / configRefused / coalesce / preFlightInfra / staleLock /
// digestFailed helpers all call process.exit IMMEDIATELY: on those paths the
// exit table is the whole observable contract and nothing further is written
// to stdout. The final composed/unavailable exit is the one path that uses
// process.exitCode instead, so the digest channel's stdout can drain before
// the process leaves.

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(DIGEST_EXIT.configRefused);
}

// The coalescing posture: 0 = succeeded or coalesced (the gitnexus-refresh.sh
// rule) — a skipped-overlapping cron firing is not a failure. A STALE lock
// (holder proven dead) never takes this arm — see staleLock below.
function coalesce(): never {
  process.stderr.write("manager-digest: another digest is running — coalesced\n");
  process.exit(DIGEST_EXIT.composed);
}

function configRefused(err: unknown): never {
  if (err instanceof ManagerConfigError) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: err.code, message: err.message, remediation: err.remediation } })}\n`,
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "config-unreadable", message: String((err as Error)?.message ?? err) } })}\n`,
    );
  }
  process.exit(DIGEST_EXIT.configRefused);
}

// Outside DIGEST_EXIT (which the composer owns): this CLI's own FATAL-before-
// the-poll code, mirroring scripts/gitnexus-refresh.sh's 3 = pre-cycle failure.
const PREFLIGHT_INFRA_EXIT = 3;

// A non-RunLockedError throw while claiming the run lock is infrastructure,
// not contention: one diagnostic line for the cron log, no digest attempt, no
// unhandled-rejection stack (the exit table is the whole observable contract).
function preFlightInfra(err: unknown): never {
  process.stderr.write(
    `manager-digest: pre-flight infra failure: ${String((err as Error)?.message ?? err)}\n`,
  );
  process.exit(PREFLIGHT_INFRA_EXIT);
}

// A STALE lock refusal (RunLockedError.stale — the holder is PROVEN dead) is
// not contention to coalesce over: coalescing would report exit 0 for a digest
// that never ran on a lock an operator must clear. It is the pre-flight infra
// lane — one diagnostic naming the lock and the exact `rm`, exit 3.
function staleLock(err: RunLockedError): never {
  process.stderr.write(
    `manager-digest: stale run lock: ${err.message} — ${err.remediation}\n`,
  );
  process.exit(PREFLIGHT_INFRA_EXIT);
}

// The digest callback's own failure lane (belt only — the composer's
// never-throws contract is proven; no test drives this path): one stderr
// diagnostic, exit 1, NEVER the pre-flight exit-3 label on a mid-poll fault.
function digestFailed(err: unknown): never {
  process.stderr.write(
    `manager-digest: digest failed: ${String((err as Error)?.message ?? err)}\n`,
  );
  process.exit(DIGEST_EXIT.statusUnavailable);
}

// ─── argv (minimal, refusing by name) ────────────────────────────────────────

let driver = DEFAULT_DRIVER;
let configPath: string = DEFAULT_CONFIG_PATH;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--driver" || arg === "--config") {
    const value = args[++i];
    // A value that starts with `--` is a MISSING value (a swallowed flag), not
    // a path: `--driver --config x` must refuse, not silently bind "--config".
    if (value === undefined || value.startsWith("--")) {
      refuse(`flag ${arg} requires a value (usage: bun scripts/manager-digest.ts [--driver exedev] [--config <path>])`);
    }
    if (arg === "--driver") driver = value;
    else configPath = value;
  } else {
    // --daemon does not exist and never will (AC3): the crontab line is the
    // schedule, not a resident process.
    refuse(`unknown flag: ${arg} — accepted flags: --driver <name>, --config <path>`);
  }
}
if (driver !== DEFAULT_DRIVER) {
  refuse(
    `--driver ${driver} is refused — the composer's observe leg pins ${DEFAULT_DRIVER}; silently polling a different driver than the one named on argv would be a lie`,
  );
}

// ─── the config of record ────────────────────────────────────────────────────

let config: unknown;
try {
  config = JSON.parse(await Bun.file(configPath).text());
} catch (e) {
  configRefused(e);
}
// The policy gate: a refusal (org-owner, ceiling, shape) exits 2 with the
// named code + remediation on stderr, before any fleet read happens.
try {
  validateManagerConfig(config);
} catch (e) {
  configRefused(e);
}

// ─── the digest ──────────────────────────────────────────────────────────────

// The factory cost-ledger's read-only handle. An open refusal (a missing or
// unreadable ledger — DF2.11's own named, logged refusal) degrades to absent
// figures through the composer's absent-not-0 rendering, never a crash and
// never a fabricated 0: a digest with no spend figures is an honest digest.
const costLedger: DigestDeps["costLedger"] = (() => {
  try {
    return CostLedger.openReadOnly();
  } catch {
    return {
      readRunCost: () => {
        throw new Error("cost ledger unavailable — spend figures are absent, never 0");
      },
    };
  }
})();

// Run-record reads (approval-park + fixloop-ladder facts), read-mode: the
// store reads and never creates. An unreadable dir degrades — those facts are
// absent, no escalation mark is fabricated.
const recordStore = (() => {
  try {
    return new RunRecordStore({ create: false });
  } catch {
    return undefined;
  }
})();

const entry = process.env.QDS_MANAGER_FLEET_ENTRY;
const newRequestId = (): string => crypto.randomUUID();

// ── pre-flight: the runs dir the run lock lives in ──
let runsDir: string;
try {
  // This CLI's record store is create:false (read-only), so the lock's runs
  // dir is ensured here — on a fresh deployment it does not exist yet.
  runsDir = resolveRunsDir();
  mkdirSync(runsDir, { recursive: true });
} catch (e) {
  preFlightInfra(e);
}

// ── the digest, under the run lock ──
let outcome: DigestOutcome;
try {
  // P7: ONE digest at a time — a cron firing that lands while a digest is
  // still running coalesces (exit 0, one stderr line) instead of racing it.
  // A STALE lock (holder proven dead) does NOT coalesce: staleLock sends it
  // to the pre-flight infra lane above.
  outcome = await withRunLock(
    runsDir,
    DIGEST_LOCK_RUN_ID,
    "manager-digest",
    () =>
      composeDigest(
        {
          cli: fleetCliInvoker(entry === undefined ? undefined : { entry }),
          costLedger,
          readRecord: (runId) => {
            try {
              return recordStore?.get(runId);
            } catch {
              return undefined; // a damaged record is a record without facts, not a crash
            }
          },
          // A1's gateway-ledger leg (zeropoint E08) is out of factory scope: no USD
          // figure is invented here, so every line renders bot_turn_spend_usd as
          // absent through the composer's own rules.
          botTurnSpendUsd: () => undefined,
          // A1 has no manager-originated run (A2 introduces the first one): the
          // default wiring keeps botId absent-not-null on every line.
          runMeta: () => undefined,
          now: () => new Date(),
          requestId: newRequestId,
        },
        {},
      ),
    { requestId: newRequestId() },
  );
} catch (e) {
  if (e instanceof RunLockedError) {
    if (e.stale) staleLock(e);
    coalesce();
  }
  // Belt-only lane (never-throws is proven): a mid-poll rejection is a digest
  // failure, never a pre-flight infra failure — the exit-3 label is reserved
  // for the pre-flight try above.
  digestFailed(e);
}

// P3: the operator's cron log gets the diagnostic, not just the exit code —
// for a degraded observe leg AND for a composed digest cut by the budget.
if (typeof outcome.reason === "string" && outcome.reason.length > 0) {
  process.stderr.write(`manager-digest: ${outcome.reason}\n`);
}

// Clamped once to the documented table — process.exitCode (not process.exit)
// so the log channel's stdout drains before the process leaves.
process.exitCode =
  Number.isInteger(outcome.exitCode) && outcome.exitCode >= DIGEST_EXIT.composed && outcome.exitCode <= DIGEST_EXIT.configRefused
    ? outcome.exitCode
    : DIGEST_EXIT.configRefused;
