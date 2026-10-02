/**
 * The pinned swarmclaw fork rev the factory's SC2 evidence corpus ran against.
 *
 * SWARMCLAW_FORK_REV is metadata ABOUT the fork, not a dependency on it: it is
 * the rev the newest SC2 evidence round bracketed, and it advances ONLY by a
 * deliberate bump PR naming the evidence round that proves the new rev
 * (charter §5.3 — the pin tracks evidence, never fork HEAD; a fork merge with
 * no evidence round leaves the pin untouched). Factory-only rounds
 * (`df3-e2e/`) never move it.
 *
 * Boundary (INV-Z1-1): this module never imports, checks out, or shells out to
 * the fork — it reads evidence JSONs and the fork-rev manifest, nothing else.
 * It cannot detect a fork-side merge and is not trying to.
 *
 * Drift alarm: `validateEvidenceForkRevs` is provenance-scoped, not blindly
 * global. A manifest row is post-pin iff its `citing.timestamp >=
 * SWARMCLAW_FORK_REV_PINNED_AT` (plain ISO-Z string compare, inclusive at the
 * pin): a post-pin stamped rev must equal the pin and its row must record
 * exactly that rev; a pre-pin stamped rev must equal its own manifest row's
 * rev — legitimate older revisions pass. The alarm fails loud on anything it
 * cannot verify: an unreadable evidence file, a symlinked evidence path, a
 * malformed manifest (unparseable or non-object, missing rounds/meta, meta
 * disagreeing with the exported pin), an instant that Date.parse only rolls
 * over (2026-02-30), a duplicate or rev-less row, a post-pin row whose rev
 * contradicts the pin, a row naming a file that no stamped dir holds, a
 * missing stamped dir, or an empty / duplicated / multi stampedDirs list —
 * none of these may pass silently, because the alarm's only product is truth.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// bracketed 2026-09-30 from sc2-7 (timeline bracket of Merge PR #682 —
// bracketed, not field-recorded, per DD-28.26(9); the evidence JSONs record
// no rev themselves, the fork-rev manifest is the record)
export const SWARMCLAW_FORK_REV: string = "cb2e1ca3eac0d80f40de764ab91f17fd29b47c58";

// the instant the pin was adopted (set once at authoring, never recomputed —
// the post-pin boundary must be derivable from this exported value alone)
export const SWARMCLAW_FORK_REV_PINNED_AT: string = "2026-10-02T15:08:06Z";

// evidence directories whose writer stamps `swarmclawForkRev` (Z3 extends)
export const STAMPED_EVIDENCE_DIRS: readonly string[] = ["openrig-sc2"];

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// a real instant, not a Date.parse rollover: 2026-02-30 parses to Mar 2, so
// NaN alone accepts impossible calendar dates — re-serialize through Date and
// require the same ISO-Z seconds form back (toISOString always emits
// milliseconds; strip the `.000` this format forbids)
function isRealInstant(input: string): boolean {
  const parsed = new Date(input);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().replace(/\.000Z$/, "Z") === input
  );
}

// rows come from JSON.parse — shape is asserted, never trusted
type ManifestRow = {
  file?: unknown;
  rev?: unknown;
  citing?: { timestamp?: unknown } | undefined;
};

export function validateEvidenceForkRevs(opts: {
  evidenceDir: string;
  manifestPath: string;
  pin: string;
  pinnedAt: string;
  stampedDirs: readonly string[];
}): { ok: true } | { ok: false; failures: string[] } {
  const failures: string[] = [];
  const { evidenceDir, manifestPath, pin, pinnedAt, stampedDirs } = opts;

  // a non-instant pinnedAt shifts every bracket by string accident (F-003);
  // a Date.parse rollover shifts it by days — hence the roundtrip above
  if (!ISO_Z.test(pinnedAt) || !isRealInstant(pinnedAt)) {
    return {
      ok: false,
      failures: [
        `pinnedAt ${JSON.stringify(pinnedAt)} is not a real ISO-Z instant (YYYY-MM-DDTHH:MM:SSZ) — the post-pin boundary cannot be derived from it`,
      ],
    };
  }

  // empty green-lights nothing; a repeated entry validates one dir twice; a
  // second dir shares one file-key namespace and cross-covers its sibling's
  // rows — none of that is half-supported, the format must grow deliberately
  if (stampedDirs.length === 0) {
    return { ok: false, failures: ["no stamped dirs — the alarm would pass vacuously"] };
  }
  const seenDirs = new Set<string>();
  for (const dir of stampedDirs) {
    if (seenDirs.has(dir)) {
      return {
        ok: false,
        failures: [`duplicate stamped dir ${dir} — it would be validated twice`],
      };
    }
    seenDirs.add(dir);
  }
  if (stampedDirs.length > 1) {
    return {
      ok: false,
      failures: [
        "multi-dir stampedDirs need dir-qualified manifest row keys — extend the manifest format deliberately (Z3)",
      ],
    };
  }

  // evidenceDir is the caller's anchor: absent = misconfigured invocation,
  // not green silence (F-011); present-but-not-a-directory would otherwise
  // surface as ENOTDIR from readdir, hiding the real cause
  let evidenceStat: fs.Stats;
  try {
    evidenceStat = fs.statSync(evidenceDir);
  } catch {
    throw new Error(
      `evidence dir ${evidenceDir} does not exist — misconfigured invocation: STAMPED_EVIDENCE_DIRS must point under an existing evidence dir`,
    );
  }
  if (!evidenceStat.isDirectory()) {
    throw new Error(`evidence dir ${evidenceDir} is not a directory`);
  }

  let manifest: { rounds?: unknown; meta?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    // one failure, full stop — continuing would spam N coverage misses that
    // all share this one root cause (F-006)
    return {
      ok: false,
      failures: [`fork-rev manifest unreadable at ${manifestPath} — no row can be validated`],
    };
  }
  if (manifest === null || typeof manifest !== "object") {
    return {
      ok: false,
      failures: [
        `fork-rev manifest malformed at ${manifestPath}: not a JSON object — no row can be validated`,
      ],
    };
  }
  if (!Array.isArray(manifest.rounds)) {
    return {
      ok: false,
      failures: [`manifest rounds missing or not an array at ${manifestPath}`],
    };
  }
  const rows = manifest.rounds as ManifestRow[];

  // the manifest is the record: its meta must state the same pin the module
  // exports, or the two records have diverged (F-013)
  const meta = manifest.meta;
  if (meta === null || typeof meta !== "object") {
    failures.push(`manifest meta missing — pinRev/pinnedAt coherence is part of the record`);
  } else {
    const m = meta as { pinRev?: unknown; pinnedAt?: unknown };
    if (m.pinRev !== pin) {
      failures.push(
        `manifest meta pinRev ${JSON.stringify(m.pinRev)} disagrees with the exported pin ${pin} — the manifest is the record`,
      );
    }
    if (m.pinnedAt !== pinnedAt) {
      failures.push(
        `manifest meta pinnedAt ${JSON.stringify(m.pinnedAt)} disagrees with the exported pin instant ${pinnedAt} — the manifest is the record`,
      );
    }
  }

  // rows indexed by their subdir-relative file key; duplicates never resolve
  // silently to the first row (F-008)
  const rowsByFile = new Map<string, Array<{ row: ManifestRow; index: number }>>();
  rows.forEach((row, index) => {
    if (row === null || typeof row !== "object") {
      failures.push(`malformed manifest row at index ${index}: not an object — rows must carry {file, rev, citing}`);
      return;
    }
    if (typeof row.file !== "string") {
      failures.push(`malformed manifest row at index ${index}: file missing — rows must name their evidence file`);
      return;
    }
    const bucket = rowsByFile.get(row.file) ?? [];
    bucket.push({ row, index });
    rowsByFile.set(row.file, bucket);
  });

  // every walked file, across all stamped dirs, keyed subdir-relative (F-009/F-010)
  const walkedFiles = new Set<string>();
  const missingDirs = new Set<string>();
  const manifestAbs = path.resolve(manifestPath);

  for (const dir of stampedDirs) {
    const dirPath = path.join(evidenceDir, dir);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      missingDirs.add(dir);
      failures.push(
        `stamped dir ${dir} missing while evidence dir ${evidenceDir} exists — coverage cannot be claimed over an absent corpus`,
      );
      continue;
    }
    for (const entry of walkJsons(dirPath, "", failures, dir, manifestAbs)) {
      walkedFiles.add(entry.file);
      const rel = `${dir}/${entry.file}`;
      const row = rowsByFile.get(entry.file)?.[0]?.row;
      const { stamps, nonStrings } = findStampedRevs(entry.parsed);
      for (let i = 0; i < nonStrings; i++) {
        failures.push(
          `stamp at ${rel} is not a string — structured stamp shapes are not part of the contract (F-021)`,
        );
      }
      if (stamps.length === 0) continue; // unstamped files are not alarm scope
      if (!row) {
        failures.push(
          `unmapped evidence file ${rel}: add its rev from round provenance — never guess`,
        );
        continue;
      }
      const citing = row.citing?.timestamp ?? "";
      if (!ISO_Z.test(citing)) {
        failures.push(
          `malformed manifest row for ${rel}: citing.timestamp missing or not ISO-Z — the file carries swarmclawForkRev but its row cannot be bracketed, and a missing bracket is never assumed`,
        );
        continue;
      }
      if (!isRealInstant(citing)) {
        failures.push(
          `citing.timestamp ${JSON.stringify(citing)} is not a real instant for ${rel} (F-004)`,
        );
        continue;
      }
      const postPin = citing >= pinnedAt;
      if (typeof row.rev !== "string") {
        failures.push(
          `malformed manifest row for ${rel}: rev missing — the ${
            postPin ? "post-pin expected value is the pin" : "pre-pin expected value is its row's rev"
          } (F-007)`,
        );
        continue;
      }
      if (postPin && row.rev !== pin) {
        failures.push(
          `post-pin manifest row for ${rel} records rev ${JSON.stringify(row.rev)} but the pin is ${pin} — the manifest is the record`,
        );
      }
      for (const found of stamps) {
        const expected = postPin ? pin : row.rev;
        if (found !== expected) {
          failures.push(
            `fork-rev drift in ${rel}: evidence=${found} expected=${expected} (${
              postPin ? "post-pin pin" : "pre-pin manifest row"
            })`,
          );
        }
      }
    }
  }

  // rows under a stamped dir that is itself missing are excluded from the
  // ghost check — the missing-dir failure above is the one root-cause line
  for (const [file, bucket] of rowsByFile) {
    if (bucket.length > 1) {
      const indexes = bucket.map((b) => b.index).join(", ");
      failures.push(
        `duplicate manifest rows for ${file} at indexes ${indexes} — contradictory provenance is never resolved silently (F-008)`,
      );
    } else if (missingDirs.size === 0 && !walkedFiles.has(file)) {
      failures.push(`manifest row ${file} has no evidence file (F-009)`);
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * `**` walk of one stamped dir. Returns paths relative to that dir with
 * forward slashes; round subdirs are fully supported — rows are keyed by
 * subdir-relative path, so the same filename in two rounds never collides.
 * The manifest file itself is excluded by resolved path, wherever it sits in
 * the walk; a same-named file that is not the manifest is evidence. A
 * symlinked entry is failed loud and never followed (loop risk — flatten the
 * corpus). An unparseable evidence file is pushed as a failure (never
 * skipped — F-001) and yields no entry.
 */
function walkJsons(
  dirPath: string,
  relPrefix: string,
  failures: string[],
  dir: string,
  manifestAbs: string,
): Array<{ file: string; parsed: unknown }> {
  const out: Array<{ file: string; parsed: unknown }> = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push(
        `symlinked evidence path ${dir}/${rel} is not walked — flatten the corpus`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      try {
        out.push(...walkJsons(full, rel, failures, dir, manifestAbs));
      } catch {
        failures.push(
          `unreadable evidence directory ${dir}/${rel} — the alarm never skips silently (F-001)`,
        );
      }
    } else if (entry.name.toLowerCase().endsWith(".json")) {
      if (path.resolve(full) === manifestAbs) continue;
      try {
        out.push({ file: rel, parsed: JSON.parse(fs.readFileSync(full, "utf8")) });
      } catch {
        failures.push(
          `unreadable evidence file ${dir}/${rel} — cannot confirm it is unstamped; the alarm never skips silently (F-001)`,
        );
      }
    }
  }
  return out;
}

/**
 * Recursive: collect every `swarmclawForkRev` through nested objects/arrays.
 * String values are stamps; a non-string value under that key is a malformed
 * stamp — counted for the loud failure, never recursed into for extraction.
 *
 * Depth is capped at 10, mirroring the writer's `hasSwarmclawForkRevDeep`
 * guard: the two scans must terminate by the same rule, or a stamp one of
 * them can see becomes a stamp the other cannot (asymmetric blindness).
 */
function findStampedRevs(value: unknown, depth = 0): { stamps: string[]; nonStrings: number } {
  if (depth >= 10 || value === null || typeof value !== "object") return { stamps: [], nonStrings: 0 };
  if (Array.isArray(value)) {
    return value
      .map((v) => findStampedRevs(v, depth + 1))
      .reduce((a, b) => ({ stamps: [...a.stamps, ...b.stamps], nonStrings: a.nonStrings + b.nonStrings }), {
        stamps: [],
        nonStrings: 0,
      });
  }
  const stamps: string[] = [];
  let nonStrings = 0;
  for (const [key, v] of Object.entries(value)) {
    if (key === "swarmclawForkRev") {
      if (typeof v === "string") stamps.push(v);
      else nonStrings++;
    } else {
      const nested = findStampedRevs(v, depth + 1);
      stamps.push(...nested.stamps);
      nonStrings += nested.nonStrings;
    }
  }
  return { stamps, nonStrings };
}
