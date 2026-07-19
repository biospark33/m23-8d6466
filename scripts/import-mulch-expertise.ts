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
  const VALUE_FLAGS = new Set(["--expertise-dir", "--repo-slug", "--bank-id"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Fix 1: accept `--flag=value` syntax (parity with provision script).
    const eqMatch = a.match(/^--([^=]+)=(.*)$/);
    if (eqMatch) {
      const flag = `--${eqMatch[1]!}`;
      const v = eqMatch[2]!;
      if (!VALUE_FLAGS.has(flag)) {
        throw new Error(`unknown flag: ${flag}`);
      }
      if (v.length === 0) {
        throw new Error(`${flag} requires a non-empty value`);
      }
      if (flag === "--expertise-dir") opts.expertiseDir = v;
      else if (flag === "--repo-slug") opts.repoSlug = v;
      else opts.bankId = v;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      // A value flag MUST be followed by a non-empty value. A bare
      // `--expertise-dir` (missing value) is a user typo — error loudly
      // instead of silently importing from the default dir.
      const v = argv[++i];
      if (typeof v !== "string" || v.length === 0 || v.startsWith("--")) {
        throw new Error(`${a} requires a non-empty value`);
      }
      if (a === "--expertise-dir") opts.expertiseDir = v;
      else if (a === "--repo-slug") opts.repoSlug = v;
      else opts.bankId = v;
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
    } else if (a.startsWith("--")) {
      // Fix 2: unknown flag — surface typo loudly rather than silently
      // proceeding with defaults (e.g. `--bankid` vs `--bank-id`).
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    // parseArgs throws on a value flag with no value (user typo). Emit a
    // structured envelope rather than a raw stack trace.
    const requestId = crypto.randomUUID();
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        totalFiles: 0,
        importedFiles: 0,
        updatedFiles: 0,
        failures: [],
        requestId,
        error: { code: "bad_args", message: (e as Error).message },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

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
    process.exitCode = 1;
    return;
  }

  // INV-HM1: the client constructor reads HINDSIGHT_BEARER_TOKEN (preferred)
  // then HINDSIGHT_API_KEY (legacy) from env, coercing empty strings to
  // undefined. No explicit apiKey here — passing one would re-introduce the
  // empty-string-shadows-fallback hazard the constructor now guards against.
  const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL,
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
      error: { code: "import_crashed", message: `import crashed: ${(e as Error).message}` },
    };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  await main();
}
