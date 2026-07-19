#!/usr/bin/env bun
/**
 * Mulch expertise import CLI (P0.9, surface (b) per CC-W3).
 *
 * Reads `.mulch/expertise/` (or `--expertise-dir`), parses each file, and
 * retains entries as JSONL into the `{resolveBankId(repoSlug)}-dev-meta` bank.
 *
 * Output contract:
 *  - success: JSON `{ok:true, totalFiles, importedFiles, updatedFiles, failures, requestId}` + exit 0
 *  - failure: JSON `{ok:false, error:{code,message}, requestId, ...}` + exit 1
 *
 * P0.9 owns no HTTP listener (CC-W3 surface (b)); the only HTTP surface for
 * Hindsight operations is the P0.7 `/invoke` bridge.
 *
 * INV-HM2 (fix [9]): the derived bank id is `BankIdSchema.safeParse`'d BEFORE
 * any retain call. An invalid id (e.g. repoSlug "!!!!" → "") emits a
 * -32003 envelope + exit(1) without touching the client.
 */

import { basename } from "node:path";
import { HindsightClient } from "../src/hindsight/index.ts";
import { importMulch, type ImportResult } from "../src/hindsight/mulch-importer.ts";
import {
  BankIdSchema,
  ERR_BANK_ID_INVALID,
  resolveBankId,
} from "../src/hindsight/schemas.ts";

export interface Args {
  expertiseDir: string;
  repoSlug: string;
  bankId: string;
}

/**
 * Pure helper: resolve a bank id from (repoSlug | explicit --bank-id) and
 * validate it against BankIdSchema. Returns the validated id, or a structured
 * -32003 envelope on failure. Exported for unit tests (fix [9]).
 */
export function resolveBankIdOrError(
  repoSlug: string,
  explicitBankId: string | undefined,
): { ok: true; bankId: string } | { ok: false; error: { code: number; message: string } } {
  const bankId = explicitBankId && explicitBankId.length > 0
    ? explicitBankId
    : `${resolveBankId(repoSlug)}-dev-meta`;
  const parsed = BankIdSchema.safeParse(bankId);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: ERR_BANK_ID_INVALID, message: "Invalid bank ID derived from repo slug" },
    };
  }
  return { ok: true, bankId: parsed.data };
}

export function parseArgs(argv: string[]): Args {
  const opts: Args = {
    expertiseDir: ".mulch/expertise",
    repoSlug: process.env.QDS_REPO_SLUG ?? basename(process.cwd()),
    bankId: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--expertise-dir") {
      opts.expertiseDir = argv[++i] ?? opts.expertiseDir;
    } else if (a === "--repo-slug") {
      opts.repoSlug = argv[++i] ?? opts.repoSlug;
    } else if (a === "--bank-id") {
      opts.bankId = argv[++i] ?? opts.bankId;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: import-mulch-expertise [--expertise-dir <d>] [--repo-slug <s>] [--bank-id <b>]",
          "",
          "Defaults:",
          "  --expertise-dir  .mulch/expertise",
          "  --repo-slug      QDS_REPO_SLUG env, else cwd basename",
          "  --bank-id        {resolveBankId(repoSlug)}-dev-meta",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // INV-HM2 (fix [9]): validate the bank id BEFORE constructing the client /
  // issuing any retain. Emit a structured -32003 envelope + exit(1).
  const resolved = resolveBankIdOrError(args.repoSlug, args.bankId || undefined);
  if (!resolved.ok) {
    const requestId = crypto.randomUUID();
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        totalFiles: 0,
        importedFiles: 0,
        updatedFiles: 0,
        failures: [],
        requestId,
        error: resolved.error,
      })}\n`,
    );
    process.exit(1);
  }

  const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL,
    apiKey: process.env.HINDSIGHT_API_KEY, // env-only (INV-HM1)
  });

  let result: ImportResult;
  try {
    result = await importMulch({
      client,
      expertiseDir: args.expertiseDir,
      bankId: resolved.bankId,
    });
  } catch (e) {
    // Defensive: importer is best-effort and should not throw, but if it does
    // surface a structured envelope rather than a stack trace.
    result = {
      ok: false,
      totalFiles: 0,
      importedFiles: 0,
      updatedFiles: 0,
      failures: [],
      requestId: crypto.randomUUID(),
      error: { code: -1, message: `import crashed: ${(e as Error).message}` },
    };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  await main();
}
