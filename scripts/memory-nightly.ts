#!/usr/bin/env bun
/**
 * M3.1 AC4 — the documented crontab fallback driver for the nightly
 * manager meta-bank consolidate. It runs the SAME job module
 * (src/hindsight/nightly-consolidate.ts) through the SAME memgate gateway,
 * authorized by an agent token that is injected ENV-ONLY from
 * operator-provisioned secret material on the host. Zero fleet/fork symbols —
 * this file is the whole fallback leg.
 *
 * INV-MEM-3 compliance: the agent token exists only as an environment
 * variable read from the operator-provisioned env file — never a crontab
 * `VAR=` line, never a repo file, never an argv value. The documented
 * crontab line below carries the env-file PATH, not its contents.
 *
 * Documented crontab line (verbatim — the operator installs this):
 * ```
 * # Nightly manager meta-bank consolidate (M3.1 crontab fallback leg):
 * #   17 2 * * * cd /opt/qds-factory && set -a && . /etc/qds/memory-nightly.env && set +a && bun scripts/memory-nightly.ts >> /var/log/qds/memory-nightly.log 2>&1
 * # /etc/qds/memory-nightly.env is operator-provisioned (0600, root) and holds
 * # QDS_MEMORY_AGENT_TOKEN + the gateway config vars by NAME — the crontab line
 * # itself carries no secrets.
 * ```
 *
 * Exit contract:
 *   0 — every bank consolidated (or coalesced) with observed refresh evidence
 *   1 — job failures (any per-bank failure) or an unexpected thrown fault
 *   2 — config refusal (fail-closed: never runs unconfigured — missing agent
 *       token, missing gateway config, or no provisioned repo bank)
 *
 * Env-var table (names only — values are never logged, never echoed):
 *   QDS_MEMORY_AGENT_TOKEN    agent token material (mgat.…) for this leg;
 *                             required, env-only (INV-MEM-3)
 *   QDS_MEMORY_REPO_SLUG      repo base slug for bank derivation; optional,
 *                             default "qds-factory"
 *   MEMGATE_ADMIN_KEY         gateway admin credential; required
 *   QDS_MEMGATE_SIGNING_KEY   gateway HMAC signing key; required
 *   QDS_MEMGATE_LEDGER        gateway ledger path; required (fail-closed —
 *                             the operator pins the ledger on this host)
 *   HINDSIGHT_BASE_URL        server client base URL; optional (client default)
 *   HINDSIGHT_BEARER_TOKEN    server client bearer token; optional (client
 *                             env-fallback INV-HM1)
 */

import { writeSync } from "node:fs";
import { HindsightClient } from "../src/hindsight/client.ts";
import { extractExistingBankIds, resolveProvisionedRepoBankId } from "../src/hindsight/bank-provisioner.ts";
import { runNightlyConsolidate, type NightlyFailure, type NightlyReceipt } from "../src/hindsight/nightly-consolidate.ts";
import { resolveBankId } from "../src/hindsight/schemas.ts";
import { memgateDeps } from "../src/memgate/gateway.ts";
import { MEMGATE_ADMIN_KEY, QDS_MEMGATE_LEDGER, QDS_MEMGATE_SIGNING_KEY } from "../src/memgate/schemas.ts";

/** Env-var NAME holding the agent token material for this leg (INV-MEM-3). */
export const QDS_MEMORY_AGENT_TOKEN = "QDS_MEMORY_AGENT_TOKEN";
/** Env-var NAME holding the repo base slug for bank derivation. */
export const QDS_MEMORY_REPO_SLUG = "QDS_MEMORY_REPO_SLUG";
const DEFAULT_REPO_SLUG = "qds-factory";

/** Gateway config vars this driver requires before it will run (fail-closed). */
const REQUIRED_GATEWAY_VARS = [MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, QDS_MEMGATE_LEDGER] as const;

export interface MemoryNightlyDeps {
  env: Record<string, string | undefined>;
  /** Reserved per the injectable-deps shape — the CLI consumes --help before
   * the core runs; nothing else is parsed (no flags, no positional args). */
  argv?: string[];
  now?: () => number;
  log?: (e: unknown) => void;
}

/** Refusals: config (exit 2) — env-var NAMES only, never values. */
export type MemoryNightlyEnvelope =
  | {
      ok: false;
      code: "config-refusal";
      leg: "crontab";
      missing: string[];
      remediation: string;
    }
  | {
      ok: false;
      code: "bank-resolution-failed";
      leg: "crontab";
      repoSlug: string;
      remediation: string;
    }
  | {
      ok: boolean;
      leg: "crontab";
      banks: string[];
      receipts: NightlyReceipt[];
      failures: NightlyFailure[];
      totalMs: number;
      banksOk: number;
      banksFailed: number;
    };

const USAGE = `usage: bun scripts/memory-nightly.ts [--help]
Runs the nightly manager meta-bank consolidate (crontab fallback leg).
Config comes from env only — see the header of this file for the env table.
`;

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Config resolution → bank derivation → gateway construction → the nightly
 * job. Refusals return an envelope with code 2 (fail-closed); job outcomes
 * carry the per-bank receipts/failures verbatim with code 0/1.
 */
export async function runMemoryNightly(deps: MemoryNightlyDeps): Promise<{
  code: 0 | 1 | 2;
  envelope: MemoryNightlyEnvelope;
}> {
  // 1. CONFIG — fail closed before any bank resolution or gateway state.
  const required = [QDS_MEMORY_AGENT_TOKEN, ...REQUIRED_GATEWAY_VARS];
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
          `set ${missing.join(", ")} in the operator-provisioned env file (INV-MEM-3: env-only, never a crontab VAR= line, never a repo file, never argv)`,
      },
    };
  }
  const token = deps.env[QDS_MEMORY_AGENT_TOKEN] as string;
  const repoSlug = isNonEmpty(deps.env[QDS_MEMORY_REPO_SLUG])
    ? (deps.env[QDS_MEMORY_REPO_SLUG] as string).trim()
    : DEFAULT_REPO_SLUG;

  // 2. BANK DERIVATION — resolveBankId over the slug, then the landed
  //    read-side resolver against the live bank list.
  const baseId = resolveBankId(repoSlug);
  const client = new HindsightClient({
    baseUrl: deps.env.HINDSIGHT_BASE_URL,
    apiKey: deps.env.HINDSIGHT_BEARER_TOKEN,
  });
  const existing = extractExistingBankIds(await client.listBanks());
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
  const banks = [`${repoBankId}-dev-meta`, `${repoBankId}-qa-meta`, `${repoBankId}-maint-meta`];

  // 3. GATEWAY — config vars passed BY NAME (never whole process.env).
  const gateway = memgateDeps({
    env: {
      [MEMGATE_ADMIN_KEY]: deps.env[MEMGATE_ADMIN_KEY] as string,
      [QDS_MEMGATE_SIGNING_KEY]: deps.env[QDS_MEMGATE_SIGNING_KEY] as string,
      [QDS_MEMGATE_LEDGER]: deps.env[QDS_MEMGATE_LEDGER] as string,
    },
    ledgerPath: deps.env[QDS_MEMGATE_LEDGER],
    now: deps.now,
    client,
    log: deps.log,
  });

  // 4. THE JOB — same module, same gateway, agent token from env.
  const result = await runNightlyConsolidate({
    gateway,
    token,
    banks,
    leg: "crontab",
    now: deps.now,
    log: deps.log,
  });
  return {
    code: result.ok ? 0 : 1,
    envelope: {
      ok: result.ok,
      leg: "crontab",
      banks,
      receipts: result.receipts,
      failures: result.failures,
      totalMs: result.totalMs,
      banksOk: result.banksOk,
      banksFailed: result.banksFailed,
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    writeSync(1, USAGE);
    process.exit(0);
  }
  try {
    const { code, envelope } = await runMemoryNightly({
      env: process.env,
      argv,
      // stderr JSON lines — events flow beside the ONE stdout envelope.
      log: (entry) => writeSync(2, `${JSON.stringify(entry)}\n`),
    });
    writeSync(1, `${JSON.stringify(envelope)}\n`);
    process.exit(code);
  } catch (e) {
    const err = e as Error & { code?: string };
    writeSync(
      2,
      `${JSON.stringify({ ok: false, code: err.code ?? "NIGHTLY_DRIVER_FAULT", message: err.message })}\n`,
    );
    process.exit(1);
  }
}
