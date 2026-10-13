#!/usr/bin/env bun
/**
 * A6 · FR-MEM-6 · NFR-OBS-5 · DD-28.26(11) pre-cycle check — GitNexus stamp
 * staleness reader.
 *
 * Reads the reindex stamp `<graph-home>/cli-version.json` and writes exactly
 * ONE line of JSON to stdout (key order is part of the contract):
 *   {"verdict":"fresh"|"stale"|"absent"|"invalid","ageHours":<number>|null,"ceilingHours":8,"stampPath":"<abs path>"}
 * Sole consumer: scripts/gitnexus-refresh.sh captures the line for the cycle's
 * NFR-OBS-5 log record — a staleness verdict NEVER aborts a cycle (the same
 * cycle that alarms performs the reindex: record-then-cure).
 *
 * Env-var table (NAMES only — values are never logged, never echoed):
 *   QDS_GITNEXUS_HOME  absolute directory holding the stamp; fixture/testing
 *                      override. Unset → <repoRoot>/.gitnexus.
 *
 * Exit contract (memory-nightly 0/1/2 precedent):
 *   0 — fresh: ageHours ≤ ceiling, negative ages from clock skew included
 *   1 — stale: ageHours > ceiling (the JSON fields ARE the AC2 naming of
 *       age / ceiling / stamp path)
 *   2 — absent: stamp missing — NEVER age 0, a wiped .gitnexus reads as
 *       unknown, not fresh (INV-A6-2); invalid: unparseable JSON, or
 *       missing/non-string/unparseable `indexedAt` — also never age 0; or
 *       usage: any argv beyond the script path
 *
 * Repo root: `git rev-parse --show-toplevel` first (house idiom —
 * tests/gitnexus/harness.ts); on git failure (stripped cron env, no git on
 * PATH) falls back to scripts/ parent arithmetic.
 */
import { readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** NFR-OBS-5 literal: "kept ≤8h" — named, never an implied number (story
 * Technical Notes). Consumers compare ageHours against ceilingHours from the
 * JSON, never against a re-derived constant. */
const INDEX_STALENESS_CEILING_HOURS = 8;
const MS_PER_HOUR = 3_600_000;
const STAMP_FILE = "cli-version.json";

type Verdict = "fresh" | "stale" | "absent" | "invalid";
type ExitCode = 0 | 1 | 2;

/** writeSync, not process.stdout.write: piped stdout can still be pending
 * when process.exit tears the process down and the verdict is lost (the
 * scripts/run-record.ts measured idiom — the wrapper captures this line). */
function emit(verdict: Verdict, ageHours: number | null, code: ExitCode, stampPath: string): never {
  writeSync(1, `${JSON.stringify({ verdict, ageHours, ceilingHours: INDEX_STALENESS_CEILING_HOURS, stampPath })}\n`);
  process.exit(code);
}

function emitUsage(): never {
  writeSync(
    2,
    "usage: bun scripts/gitnexus-staleness.ts — no arguments accepted; reads " +
      "<graph-home>/cli-version.json and writes one JSON verdict line to stdout " +
      "(exit 0 fresh | 1 stale | 2 absent/invalid/usage)\n",
  );
  process.exit(2);
}

/** Repo root, git-first, cwd pinned to this script's own directory: a cron
 * starts in $HOME, so an unpinned rev-parse could resolve a FOREIGN repo, and
 * the pin also makes worktree/symlink resolution agree with git's own view
 * (tests/gitnexus/harness.ts:20-39). Fallback when git is unavailable
 * (stripped cron env — git absent from PATH): scripts/ parent by
 * import.meta.dir arithmetic. */
function resolveRepoRoot(): string {
  try {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dir,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const top = git.status === 0 ? (git.stdout ?? "").trim().replace(/\/+$/, "") : "";
    if (top !== "") return top;
  } catch {
    // git unspawnable — fall through to the arithmetic fallback.
  }
  return join(import.meta.dir, "..");
}

function main(): void {
  if (process.argv.slice(2).length > 0) emitUsage();

  const home = process.env.QDS_GITNEXUS_HOME
    ? resolve(process.env.QDS_GITNEXUS_HOME)
    : join(resolveRepoRoot(), ".gitnexus");
  const stampPath = join(home, STAMP_FILE);

  let raw: string;
  try {
    raw = readFileSync(stampPath, "utf8");
  } catch (e) {
    // "No stamp at this path" (missing file, missing graph-home dir, or the
    // home path is a file → ENOTDIR) is ABSENT. Present-but-unreadable
    // (EISDIR, EACCES, ...) is INVALID. Both exit 2 with ageHours null —
    // fail-closed either way (INV-A6-2: never age 0).
    const code = (e as NodeJS.ErrnoException).code;
    emit(code === "ENOENT" || code === "ENOTDIR" ? "absent" : "invalid", null, 2, stampPath);
  }

  let stamp: unknown;
  try {
    stamp = JSON.parse(raw);
  } catch {
    emit("invalid", null, 2, stampPath);
  }
  if (typeof stamp !== "object" || stamp === null) emit("invalid", null, 2, stampPath);
  // The real writer (install-gitnexus-plus.sh) emits `date -u +%Y-%m-%dT%H:%M:%SZ`;
  // parseability is the gate, Date.parse NaN is the refusal — anything stricter
  // is format-policing beyond the contract.
  const indexedAt = (stamp as Record<string, unknown>).indexedAt;
  if (typeof indexedAt !== "string") emit("invalid", null, 2, stampPath);
  const t = Date.parse(indexedAt);
  if (Number.isNaN(t)) emit("invalid", null, 2, stampPath);

  // Real wall clock — no freeze env. Negative ages (stamp ahead of the host
  // clock) are FRESH: skew must not alarm; the ceiling alarms on age only.
  const ageHours = (Date.now() - t) / MS_PER_HOUR;
  if (ageHours > INDEX_STALENESS_CEILING_HOURS) emit("stale", ageHours, 1, stampPath);
  emit("fresh", ageHours, 0, stampPath);
}

if (import.meta.main) main();
