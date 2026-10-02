[
  {
    "location": "scripts/swarmclaw-fork-pin.ts:70-75,109-127",
    "trigger_condition": "MED: evidence subdirs adopted (walk recurses) — row matching uses basename only, so two files in different subdirs with the same basename each match either's manifest row, and a correctly-listed nested row (sub/foo.json) never matches foo.json",
    "guard_snippet": "const relFile = path.relative(path.join(evidenceDir, dir), entry.full).replace(/\\\\/g,\"/\"); // match on relFile, drop the bare-name disjunct",
    "potential_consequence": "Silent wrong-rev validation across subdir files; every legitimately-listed nested stamped file false-alarms as unmapped"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:121-123,77",
    "trigger_condition": "MED: evidence JSON unparseable (corrupt write, torn read while a live round writes the same file) — catch pushes parsed:undefined, findStampedRevs returns [], file treated as unstamped and skipped",
    "guard_snippet": "catch { failures.push(`evidence file ${rel} unreadable — cannot confirm it is unstamped`); }",
    "potential_consequence": "A file that should carry a stamp silently escapes the drift alarm — 'missing bracket is never assumed' is violated"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:63-67",
    "trigger_condition": "MED: a stampedDirs entry typo'd or renamed (dir absent) — readdirSync throws and continue treats it identically to an intentionally-empty dir",
    "guard_snippet": "catch (e) { if ((e as NodeJS.ErrnoException).code !== \"ENOENT\") throw e; if (!fs.existsSync(evidenceDir)) continue; failures.push(`stamped dir ${dir} missing while ${evidenceDir} exists`); }",
    "potential_consequence": "Entire alarm silently inert with ok:true; typo'd config stays green forever"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:91,32-33",
    "trigger_condition": "LOW: pinnedAt argument not ISO_Z-validated inside validateEvidenceForkRevs — a caller passing a non-Z-form value (offset, milliseconds, unpadded month like 2026-10-2T…) shifts every bracket via lexicographic compare",
    "guard_snippet": "if (!ISO_Z.test(pinnedAt)) throw new Error(`pinnedAt must be ISO-Z, got ${pinnedAt}`);",
    "potential_consequence": "Post-pin drift silently masked (everything classified pre-pin) or false drift verdicts"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:70-75",
    "trigger_condition": "LOW: manifest contains two rows for the same file with different revs/timestamps — find() returns only the first; the second is never read",
    "guard_snippet": "const matches = rows.filter((r) => r.file === entry.file || ...); if (matches.length > 1) failures.push(`duplicate manifest rows for ${rel}`);",
    "potential_consequence": "A benign first row masks drift recorded in the contradictory second row"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:61-103",
    "trigger_condition": "LOW: manifest lists a file that does not exist (typo, deleted evidence, or CI clone lacking untracked evidence JSONs) — loop only walks files→rows, never rows→files",
    "guard_snippet": "for (const r of rows) if (r.file && !stagedFiles.has(r.file)) failures.push(`manifest row ${r.file} has no evidence file`);",
    "potential_consequence": "Manifest silently rots; in CI the real-corpus test green-lights a subset while the manifest claims full coverage"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:56",
    "trigger_condition": "LOW: manifest parses but rounds is absent or non-array — rows=[] is assigned with no failure recorded, unlike the unreadable-manifest catch which does fail",
    "guard_snippet": "if (!Array.isArray(manifest.rounds)) failures.push(`manifest rounds missing or not an array at ${manifestPath}`);",
    "potential_consequence": "Wiped/renamed rounds key silently disarms bracketing until a stamped file happens to appear"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:116-118",
    "trigger_condition": "LOW: evidence file named X.JSON (uppercase ext) is not walked at all; any file named fork-rev-manifest.json in a SUBDIR is excluded by basename even if it carries evidence plus a stamp",
    "guard_snippet": "entry.name.toLowerCase().endsWith(\".json\") && (entry.name !== MANIFEST_FILENAME || depth > 0 === false) // scope the manifest exclusion to the top level only",
    "potential_consequence": "Stamped evidence silently outside alarm scope"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:135-136",
    "trigger_condition": "LOW: stamp key present but value non-string (future structured shape {rev:…}, or a number) — key matches, value is neither pushed nor recursed into",
    "guard_snippet": "if (key === \"swarmclawForkRev\") { if (typeof v === \"string\") out.push(v); else out.push(...findStampedRevs(v)); } else out.push(...findStampedRevs(v));",
    "potential_consequence": "A differently-shaped stamp silently escapes the alarm"
  },
  {
    "location": "tests/fleet/e2e/sc2-harness.ts:366",
    "trigger_condition": "LOW: caller passes an array (or Map) payload — spread reshapes it into a plain object with \"0\",\"1\"… keys plus the stamp; persisted bytes no longer match what the caller passed or what pre-diff writes produced",
    "guard_snippet": "if (payload !== null && typeof payload === \"object\" && !Array.isArray(payload)) payload = { ...payload, swarmclawForkRev: SWARMCLAW_FORK_REV }; else throw new Error(\"evidence payload must be a plain object\");",
    "potential_consequence": "Evidence file schema silently corrupted for array payloads; downstream array consumers break"
  },
  {
    "location": "tests/fleet/e2e/sc2-harness.ts:370-371",
    "trigger_condition": "LOW: two writeEvidence calls in the same millisecond with the same tag and name (concurrent live rounds on one box) — second writeFileSync truncates the first",
    "guard_snippet": "fs.writeFileSync(path.join(dir, `${stamp}-${tag}-${name}.json`), data, { flag: \"wx\" });",
    "potential_consequence": "Evidence silently lost; a manifest row's rev now pins bytes that were overwritten"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:37,85-87",
    "trigger_condition": "LOW: ISO_Z validates shape only — semantically invalid datetimes (2026-13-45T99:99:99Z) pass, and fixed-width string compare brackets them deterministically instead of failing",
    "guard_snippet": "if (Number.isNaN(Date.parse(citing))) failures.push(`citing.timestamp not a real instant for ${rel}`);",
    "potential_consequence": "A typo'd row timestamp brackets as post/pre-pin by string accident instead of erroring"
  }
]
