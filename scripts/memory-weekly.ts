#!/usr/bin/env bun
/**
 * M3.2 AC6 — the documented crontab fallback driver for the weekly L4
 * reflect → PROPOSE job. It runs the SAME job module
 * (src/learning/weekly-reflect.ts) through the SAME memgate gateway,
 * authorized by a HOST-class agent token that is injected ENV-ONLY from
 * operator-provisioned secret material on the host. Zero fleet/fork symbols —
 * this file is the whole fallback leg (the fence test scans this source).
 *
 * INV-LEARN-4 compliance: the host agent token exists only as an environment
 * variable read from the operator-provisioned env file — never a crontab
 * `VAR=` line, never a repo file, never an argv value. The documented
 * crontab line below carries the env-file PATH, not its contents.
 *
 * Documented crontab line (verbatim — the operator installs this):
 * ```
 * # Weekly L4 reflect → proposals (M3.2 crontab fallback leg):
 * #   23 6 * * 1 cd /opt/qds-factory && set -a && . /etc/qds/memory-weekly.env && set +a && bun scripts/memory-weekly.ts >> .sandbox/proposals/last-post.log 2>> .sandbox/proposals/last-events.log
 * # /etc/qds/memory-weekly.env is operator-provisioned (0600, root) and holds
 * # QDS_MEMORY_WEEKLY_AGENT_TOKEN + the gateway config vars by NAME — the
 * # crontab line itself carries no secrets. The stdout redirect IS the
 * # crontab leg's operator carrier: every proposal's full text lands in
 * # .sandbox/proposals/last-post.log (the job prints it inside the envelope).
 * # Stderr is redirected SEPARATELY to last-events.log: the JSONL telemetry
 * # (client + gateway events) and any refusal/fault envelope ride stderr, and
 * # a 2>&1 merge would pollute the operator carrier with them.
 * # NOTE: the shell opens the >> redirects BEFORE the job runs — provisioning
 * # must create .sandbox/proposals/ (0700) on the host, or cron no-ops with
 * # "no such file or directory" in the cron mail, never in these logs.
 * ```
 *
 * Exit contract:
 *   0 — every bank reflected, no landing fault occurred, and at least one
 *       proposal landed or none was composed (the job's `ok` — a partial
 *       divergence beside a landing exits 0), or a --help/-h request
 *       answered with the usage text
 *   1 — job failures (any bank_failed, a retain/store fault, or an
 *       unexpected thrown fault), a firing where proposals were composed but
 *       NONE landed — a detected divergence (PROPOSAL_DIVERGENT) fails the
 *       run only when it leaves nothing landed, i.e. when every composed
 *       proposal diverged; a partial divergence beside a landing exits 0 —
 *       or an unreachable bank list at resolution time (BANK_LIST_UNREACHABLE)
 *   2 — config + usage refusals (fail-closed: missing agent token / gateway
 *       config, an invalid OR future-pinned clock/fired-at seam, a malformed
 *       or repeated --week value, a bank override naming no family member, no
 *       provisioned repo bank, or an unknown --flag)
 *
 * Env-var table (names only — values are never logged, never echoed):
 *   QDS_MEMORY_WEEKLY_AGENT_TOKEN  HOST-class agent token material (mgat.…)
 *                                  scoped {reflect, retain}; required,
 *                                  env-only (the distinct name prevents a
 *                                  bot-class token from being cross-wired)
 *   QDS_MEMORY_REPO_SLUG           repo base slug for bank derivation;
 *                                  optional, default "qds-factory"
 *   MEMGATE_ADMIN_KEY              gateway admin credential; required
 *   QDS_MEMGATE_SIGNING_KEY        gateway HMAC signing key; required
 *   QDS_MEMGATE_LEDGER             gateway ledger path; required (fail-closed
 *                                  — the operator pins the ledger on this host)
 *   HINDSIGHT_BASE_URL             server client base URL; required — the
 *                                  client's silent localhost default would aim
 *                                  the whole weekly at the WRONG instance on
 *                                  any box running sidecar stacks (fail-closed)
 *   HINDSIGHT_BEARER_TOKEN         server client bearer token; optional
 *   QDS_WEEKLY_NOW                 clock seam — ISO instant pinning "now"
 *                                  (tests + deterministic re-fires); optional;
 *                                  a typo is a typed refusal
 *   QDS_WEEKLY_FIRED_AT            firing-identity seam — ISO instant carried
 *                                  in every proposal id; optional (defaults to
 *                                  the clock); a typo or a pin more than 5
 *                                  minutes in the future is a typed refusal
 */

import { writeSync } from "node:fs";

import {
  COLLECTIVE_BANK_ID,
  extractExistingBankIds,
  resolveProvisionedRepoBankId,
} from "../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../src/hindsight/client.ts";
import { BankIdSchema, resolveBankId } from "../src/hindsight/schemas.ts";
import {
  isoWeekOf,
  isoWeekStartUtc,
  runWeeklyReflect,
  type WeeklyReceipt,
} from "../src/learning/index.ts";
import { memgateDeps } from "../src/memgate/gateway.ts";
import { setLogSink } from "../src/swarmclaw/log.ts";
import { MEMGATE_ADMIN_KEY, QDS_MEMGATE_LEDGER, QDS_MEMGATE_SIGNING_KEY } from "../src/memgate/schemas.ts";
import { parseValueFlags } from "./lib/cli-args.ts";

/** Env-var NAME holding the HOST-class agent token for this leg (INV-LEARN-4). */
export const QDS_MEMORY_WEEKLY_AGENT_TOKEN = "QDS_MEMORY_WEEKLY_AGENT_TOKEN";
/** Env-var NAME holding the repo base slug for bank derivation. */
export const QDS_MEMORY_REPO_SLUG = "QDS_MEMORY_REPO_SLUG";
/** Clock / firing-identity seams. */
export const QDS_WEEKLY_NOW = "QDS_WEEKLY_NOW";
export const QDS_WEEKLY_FIRED_AT = "QDS_WEEKLY_FIRED_AT";
const DEFAULT_REPO_SLUG = "qds-factory";

/** Gateway config vars this driver requires before it will run (fail-closed). */
const REQUIRED_GATEWAY_VARS = [MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, QDS_MEMGATE_LEDGER] as const;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export interface MemoryWeeklyDeps {
  env: Record<string, string | undefined>;
  /** Optional subset of the derived manager meta banks to reflect this run
   * (foreign names are filtered, never honored). Unset = the whole family. */
  banks?: string[];
  /** CLI seam: `--week <iso-week>` is the only value flag; --help/-h and
   * unknown flags refuse per the exit contract. */
  argv?: string[];
  now?: () => Date;
  log?: (e: unknown) => void;
}

/** Refusals: config (exit 2) — env-var NAMES + seam names only, never values. */
export type MemoryWeeklyEnvelope =
  | { ok: true; code: "help"; leg: "crontab"; usage: string }
  | { ok: false; code: "config-refusal"; leg: "crontab"; missing: string[]; remediation: string }
  | { ok: false; code: "seam-invalid"; leg: "crontab"; seam: string; remediation: string }
  | { ok: false; code: "week-invalid"; leg: "crontab"; remediation: string }
  | { ok: false; code: "usage-refusal"; leg: "crontab"; detail: string; remediation: string }
  | { ok: false; code: "COLLECTIVE_SLUG_REFUSED"; leg: "crontab"; repoSlug: string; remediation: string }
  | { ok: false; code: "bank-resolution-failed"; leg: "crontab"; repoSlug: string; remediation: string }
  | { ok: false; code: "bank-id-overflow"; leg: "crontab"; repoSlug: string; remediation: string }
  | { ok: false; code: "BANK_LIST_UNREACHABLE"; leg: "crontab"; repoSlug: string; detail: string; remediation: string }
  | {
      ok: boolean;
      leg: "crontab";
      week: string;
      banks: string[];
      receipt: WeeklyReceipt;
      /** The crontab carrier payload — every proposal's FULL operator text. */
      proposals: Array<{ proposal_id: string; text: string }>;
      postedTexts: Array<{ proposal_id: string; text: string }>;
      totalMs: number;
    };

const USAGE = `usage: bun scripts/memory-weekly.ts [--week <iso-week>] [--help]
Runs the weekly L4 reflect → proposal job (crontab fallback leg).
Config comes from env only — see the header of this file for the env table.
`;

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** An ISO-8601 instant seam: canonical UTC form AND a finite parse, or null. */
function parseInstantSeam(v: string | undefined): Date | null {
  if (v === undefined || !ISO_INSTANT_RE.test(v.trim())) return null;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Config resolution → bank derivation → gateway construction → the weekly
 * job. Refusals return an envelope with code 2 (fail-closed); job outcomes
 * carry the receipt verbatim with code 0/1.
 */
export async function runMemoryWeekly(deps: MemoryWeeklyDeps): Promise<{
  code: 0 | 1 | 2;
  envelope: MemoryWeeklyEnvelope;
}> {
  // 0. ARGS — help FIRST (F-013): the shared parser's --help path writes and
  //    process.exit(0)s, which kills an in-process caller and falsifies this
  //    module's every-path-returns contract; intercept the exact tokens here.
  const argv = deps.argv ?? [];
  if (argv.includes("--help") || argv.includes("-h")) {
    return { code: 0, envelope: { ok: true, code: "help", leg: "crontab", usage: USAGE.trimEnd() } };
  }
  let weekArg: string | undefined;
  const seenFlags = new Set<string>();
  try {
    parseValueFlags(argv, {
      flags: ["--week"],
      onValue: (flag, value) => {
        if (seenFlags.has(flag)) throw new Error(`${flag} given more than once — a repeated value flag is a typo, never a silent last-win`); // F-021
        seenFlags.add(flag);
        weekArg = value;
      },
      help: USAGE.split("\n").filter((l) => l.length > 0),
    });
  } catch (e) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "usage-refusal",
        leg: "crontab",
        detail: e instanceof Error ? e.message : String(e),
        remediation: USAGE.split("\n")[0] as string,
      },
    };
  }
  if (weekArg !== undefined) {
    // isoWeekStartUtc is the existence proof: a syntactically-valid label that
    // names a week absent from its year (2027-W53 — a 52-week year) is a typo,
    // not a window — it would misattribute the next year's W01 evidence to it.
    try {
      isoWeekStartUtc(weekArg);
    } catch {
      return {
        code: 2,
        envelope: {
          ok: false,
          code: "week-invalid",
          leg: "crontab",
          remediation: 'pass --week as an existing ISO week label like "2026-W41", or omit it to derive from the clock',
        },
      };
    }
  }

  // 1. CONFIG — fail closed before any bank resolution, seam parse, or gateway state.
  const required = [QDS_MEMORY_WEEKLY_AGENT_TOKEN, "HINDSIGHT_BASE_URL", ...REQUIRED_GATEWAY_VARS];
  const missing = required.filter((name) => !isNonEmpty(deps.env[name]));
  if (missing.length > 0) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "config-refusal",
        leg: "crontab",
        missing,
        remediation:
          `set ${missing.join(", ")} in the operator-provisioned env file (INV-LEARN-4: env-only, never a crontab VAR= line, never a repo file, never argv)`,
      },
    };
  }
  const token = deps.env[QDS_MEMORY_WEEKLY_AGENT_TOKEN] as string;
  const repoSlug = isNonEmpty(deps.env[QDS_MEMORY_REPO_SLUG])
    ? (deps.env[QDS_MEMORY_REPO_SLUG] as string).trim()
    : DEFAULT_REPO_SLUG;

  // 2. SEAMS — clock + firing identity, validated; a typo is a typed refusal.
  //    The clock seam overrides EVERY read (never a frozen run clock); unset
  //    means the injected deps.now or the real clock.
  const injectedNow = deps.now ?? ((): Date => new Date());
  const clockSeam = parseInstantSeam(deps.env[QDS_WEEKLY_NOW]);
  if (deps.env[QDS_WEEKLY_NOW] !== undefined && clockSeam === null) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "seam-invalid",
        leg: "crontab",
        seam: QDS_WEEKLY_NOW,
        remediation: `set ${QDS_WEEKLY_NOW} to a canonical UTC ISO instant (e.g. 2026-10-05T06:23:00.000Z), or unset it for the real clock`,
      },
    };
  }
  const firedAtEnv = parseInstantSeam(deps.env[QDS_WEEKLY_FIRED_AT]);
  if (deps.env[QDS_WEEKLY_FIRED_AT] !== undefined && firedAtEnv === null) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "seam-invalid",
        leg: "crontab",
        seam: QDS_WEEKLY_FIRED_AT,
        remediation: `set ${QDS_WEEKLY_FIRED_AT} to a canonical UTC ISO instant (e.g. 2026-10-05T06:23:00.000Z), or unset it to stamp from the clock`,
      },
    };
  }
  const nowFn = (): Date => clockSeam ?? injectedNow();
  const week = weekArg ?? isoWeekOf(nowFn());
  const firedAt = firedAtEnv?.toISOString() ?? nowFn().toISOString();
  // F-008: a FUTURE-pinned firing is a seam typo, not an operator choice — its stamp would sort AFTER every later
  // real firing, permanently inverting supersession. Refuse anything > 5 min ahead of the validated clock.
  if (firedAtEnv !== null && firedAtEnv.getTime() - nowFn().getTime() > 5 * 60_000) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "seam-invalid",
        leg: "crontab",
        seam: QDS_WEEKLY_FIRED_AT,
        remediation: `${QDS_WEEKLY_FIRED_AT} is more than 5 minutes in the future — a firing identity cannot be pre-dated for a run happening now; unset it or pin at/behind the clock`,
      },
    };
  }

  // 3. BANK DERIVATION — the collective-slug gate FIRST, then resolveBankId,
  //    then the landed read-side resolver against the live bank list.
  const baseId = resolveBankId(repoSlug);
  if (baseId === COLLECTIVE_BANK_ID) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "COLLECTIVE_SLUG_REFUSED",
        leg: "crontab",
        repoSlug,
        remediation:
          "the collective bank is not a manager family — no provisioning circle: scripts/provision-hindsight-banks.ts refuses this slug for the same reason; pass a real repo slug via QDS_MEMORY_REPO_SLUG",
      },
    };
  }
  const client = new HindsightClient({
    baseUrl: deps.env.HINDSIGHT_BASE_URL,
    apiKey: deps.env.HINDSIGHT_BEARER_TOKEN,
  });
  let existing: Set<string>;
  try {
    existing = extractExistingBankIds(await client.listBanks());
  } catch (e) {
    return {
      code: 1,
      envelope: {
        ok: false,
        code: "BANK_LIST_UNREACHABLE",
        leg: "crontab",
        repoSlug,
        detail: e instanceof Error ? e.message : String(e),
        remediation: "check HINDSIGHT_BASE_URL reachability and the instance's health, then re-run",
      },
    };
  }
  const repoBankId = resolveProvisionedRepoBankId(baseId, existing);
  if (repoBankId === null) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "bank-resolution-failed",
        leg: "crontab",
        repoSlug,
        remediation: "run scripts/provision-hindsight-banks.ts",
      },
    };
  }
  const derivedBanks = [`${repoBankId}-dev-meta`, `${repoBankId}-qa-meta`, `${repoBankId}-maint-meta`];
  // deps.banks override (test/ops seam): subsets the derived family to named
  // members — every name must be a member (never a foreign bank).
  const banks =
    deps.banks === undefined
      ? derivedBanks
      : deps.banks.filter((b) => derivedBanks.includes(b));
  if (banks.length === 0) {
    // F-012: a wholly-foreign override must refuse typed HERE — an empty family reaching the job would surface as
    // an untyped WEEKLY_DRIVER_FAULT instead of a fail-closed refusal.
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "bank-resolution-failed",
        leg: "crontab",
        repoSlug,
        remediation: "the bank override names no member of the derived manager meta family (<repo>-{dev,qa,maint}-meta) — pass family members or unset the override",
      },
    };
  }
  // A legacy-era family base can yield meta ids past the 64-char BankIdSchema
  // cap — those banks can never exist, so the weekly would fail them every run.
  const invalidBanks = banks.filter((b) => !BankIdSchema.safeParse(b).success);
  if (invalidBanks.length > 0) {
    return {
      code: 2,
      envelope: {
        ok: false,
        code: "bank-id-overflow",
        leg: "crontab",
        repoSlug,
        remediation: `legacy-era family yields ids over the 64-char cap (${invalidBanks.join(", ")}) — re-provision the family under the 50-char rule with scripts/provision-hindsight-banks.ts`,
      },
    };
  }

  // 4. GATEWAY — config vars passed BY NAME (never whole process.env).
  const gateway = memgateDeps({
    env: {
      [MEMGATE_ADMIN_KEY]: deps.env[MEMGATE_ADMIN_KEY] as string,
      [QDS_MEMGATE_SIGNING_KEY]: deps.env[QDS_MEMGATE_SIGNING_KEY] as string,
      [QDS_MEMGATE_LEDGER]: deps.env[QDS_MEMGATE_LEDGER] as string,
    },
    ledgerPath: deps.env[QDS_MEMGATE_LEDGER],
    now: () => nowFn().getTime(),
    client,
    log: deps.log,
  });

  // 5. THE JOB — same module, same gateway, HOST-class token from env. The
  //    driver owns the gateway's ledger handle (memgateDeps constructs it), so
  //    close it on EVERY exit path (F-023) — a fired cron process must not
  //    leave the sqlite fd open past the envelope write.
  try {
    const result = await runWeeklyReflect({
      gateway,
      token,
      banks,
      leg: "crontab",
      week,
      firedAt,
      now: nowFn,
      log: deps.log,
    });
    return {
      code: result.ok ? 0 : 1,
      envelope: {
        ok: result.ok,
        leg: "crontab",
        week,
        banks,
        receipt: result.receipt,
        // The crontab carrier payload — the full operator text of every posted
        // proposal (this leg's postedTexts ARE the full texts; both fields ride
        // per the envelope contract, the redundancy is load-bearing for readers).
        proposals: result.postedTexts,
        postedTexts: result.postedTexts,
        totalMs: result.totalMs,
      },
    };
  } finally {
    try {
      gateway.ledger.close();
    } catch {
      // the job's own outcome outranks a faulting ledger close
    }
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}

/** run(): the spawned-process contract as a return value — help → 0, refusal
 * → 2, fault → 1, success → 0. The ONE stdout envelope is written here (help
 * prints the usage text through `out` — the in-process help interception in
 * runMemoryWeekly never reaches the lib parser's process.exit path). This
 * process's shared log sink (client telemetry + gateway audit lines) is
 * routed to STDERR for the duration, so the crontab carrier redirect captures
 * exactly the envelope — every event stays JSONL on stderr. */
export async function run(argv: string[], out: (s: string) => void = (s) => writeSync(1, `${s}\n`)): Promise<number> {
  const prevSink = setLogSink((entry) => {
    try {
      writeSync(2, `${JSON.stringify(entry)}\n`);
    } catch {
      // a failing stderr write must never gate the job
    }
  });
  try {
    const { code, envelope } = await runMemoryWeekly({ env: process.env, argv });
    if ("code" in envelope && envelope.code === "help") {
      out(envelope.usage);
      return 0;
    }
    if (code !== 2) {
      writeSync(1, `${JSON.stringify(envelope)}\n`);
    } else {
      // Refusal envelopes go to STDERR: under the documented crontab redirect
      // (stdout >> last-post.log, stderr >> last-events.log) a misprovisioned
      // host must not silently no-op — the refusal names the missing/invalid
      // pieces verbatim.
      writeSync(2, `${JSON.stringify(envelope)}\n`);
    }
    return code;
  } catch (e) {
    const err = e as Error & { code?: string };
    writeSync(
      2,
      `${JSON.stringify({ ok: false, code: err.code ?? "WEEKLY_DRIVER_FAULT", message: err.message })}\n`,
    );
    return 1;
  } finally {
    setLogSink(prevSink);
  }
}
