/**
 * DF4.2 post-test coverage gate. Runs as its own CI step AFTER `bun test
 * --coverage` (preserving that step's own exit status as the first gate),
 * because a `*.test.ts` inside the run cannot read that same run's final
 * lcov.info.
 *
 * lcov.info only carries a record for a file the run actually LOADED — an
 * entirely untested module appears nowhere in it, so an assert that merely
 * iterates lcov records passes vacuously on a module nobody ever imported.
 * The fix: enumerate the files this gate expects to exist FROM THE
 * FILESYSTEM (server/**, src/lib/**, deploy.ts once it exists) and fail
 * loudly on a missing SF: record, not just a low ratio on the ones present.
 *
 * This file itself is outside the gate it enforces: it lives in scripts/,
 * not under server/** or src/lib/**, and bunfig.toml's
 * coveragePathIgnorePatterns explicitly excludes scripts/** (it gets
 * instrumented anyway because check-lcov.test.ts imports it) so it never
 * counts toward the bun-side aggregate either.
 *
 * No lcov npm package — the format this project produces (SF:/FNF:/FNH:/
 * LF:/LH:/end_of_record) is a few lines of string handling.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const LINE_FLOOR = 0.9;
export const FUNCTIONS_FLOOR = 0.9;

export interface FileCoverage {
  fnf: number;
  fnh: number;
  lf: number;
  lh: number;
}

/**
 * Parses an lcov counter (FNF:/FNH:/LF:/LH:) as a finite non-negative
 * integer. `Number()` coerces garbage AND blank/whitespace-only text alike
 * to 0 or NaN — an empty `FNF:` (no value at all) would silently become 0
 * rather than the parse failure it actually is, letting a structurally
 * broken record slip through as vacuously-passing zero coverage. Validate
 * the raw text against a strict decimal-integer shape first; only then
 * convert, with the isSafeInteger/non-negative checks kept as a second
 * line of defense.
 */
function parseCount(line: string, prefix: string): number {
  const raw = line.slice(prefix.length).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid LCOV counter: ${line}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid LCOV counter: ${line}`);
  }
  return value;
}

/** Parses lcov text into per-file records, keyed by absolute path (resolved against `cwd`). */
export function parseLcov(lcovText: string, cwd: string): Map<string, FileCoverage> {
  const records = new Map<string, FileCoverage>();
  let sf: string | null = null;
  let cov: Partial<FileCoverage> = {};

  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = path.resolve(cwd, line.slice(3).trim());
      cov = {};
    } else if (line.startsWith("FNF:")) {
      cov.fnf = parseCount(line, "FNF:");
    } else if (line.startsWith("FNH:")) {
      cov.fnh = parseCount(line, "FNH:");
    } else if (line.startsWith("LF:")) {
      cov.lf = parseCount(line, "LF:");
    } else if (line.startsWith("LH:")) {
      cov.lh = parseCount(line, "LH:");
    } else if (line.startsWith("end_of_record")) {
      if (sf) {
        records.set(sf, {
          fnf: cov.fnf ?? 0,
          fnh: cov.fnh ?? 0,
          lf: cov.lf ?? 0,
          lh: cov.lh ?? 0,
        });
      }
      sf = null;
      cov = {};
    }
  }
  return records;
}

/**
 * Enforces per-file line AND function floors over `expectedFiles` (already
 * absolute paths). A file with no lcov record at all fails loudly by name —
 * that's the case bun's own aggregate threshold can never catch.
 */
export function checkCoverage(
  records: Map<string, FileCoverage>,
  files: string[],
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const file of files) {
    const cov = records.get(file);
    if (!cov) {
      failures.push(`missing coverage record (never loaded by any test): ${file}`);
      continue;
    }

    // LF:0/FNF:0 is a file with nothing instrumented at all — e.g. a pure
    // `export type { ... } from ...` re-export. Nothing to execute, so it
    // cannot be under-covered: pass vacuously.
    if (cov.lf === 0 && cov.fnf === 0) continue;

    // LF:0 with FNF>0 can't happen from a real bun lcov run today, but
    // guard the division anyway and treat it as suspicious rather than a
    // silent 0/0 pass.
    if (cov.lf === 0) {
      failures.push(`${file}: 0 lines instrumented but ${cov.fnf} functions declared (suspicious)`);
      continue;
    }

    const lineRatio = cov.lh / cov.lf;
    const fnRatio = cov.fnf === 0 ? 1 : cov.fnh / cov.fnf;

    if (lineRatio < LINE_FLOOR || fnRatio < FUNCTIONS_FLOOR) {
      failures.push(
        `${file}: lines ${cov.lh}/${cov.lf} (${(lineRatio * 100).toFixed(1)}%), ` +
          `functions ${cov.fnh}/${cov.fnf} (${(fnRatio * 100).toFixed(1)}%) — ` +
          `floor is ${LINE_FLOOR * 100}% lines / ${FUNCTIONS_FLOOR * 100}% functions`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Globs `dir` for `*.ts` files, recursively, returning absolute paths. */
function walkTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The files this gate expects to exist, read from the filesystem (not hardcoded). */
export function expectedFiles(vizDir: string): string[] {
  const files = [...walkTs(path.join(vizDir, "server")), ...walkTs(path.join(vizDir, "src", "lib"))];
  // Another DF4.2 track is adding deploy.ts; include it once it lands
  // instead of hardcoding an assumption that breaks today.
  const deploy = path.join(vizDir, "deploy.ts");
  if (fs.existsSync(deploy)) files.push(deploy);
  return files;
}

if (import.meta.main) {
  const vizDir = path.resolve(import.meta.dir, "..");
  const lcovPath = path.join(vizDir, "coverage", "lcov.info");
  if (!fs.existsSync(lcovPath)) {
    console.error(`check-lcov: no coverage report at ${lcovPath} — run \`bun test --coverage\` first`);
    process.exit(1);
  }
  const lcovText = fs.readFileSync(lcovPath, "utf8");
  const records = parseLcov(lcovText, vizDir);
  const files = expectedFiles(vizDir);
  const result = checkCoverage(records, files);
  if (!result.ok) {
    console.error("check-lcov: per-file coverage gate failed:");
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`check-lcov: all ${files.length} expected files clear the floor`);
}
