[
  {
    "location": "scripts/swarmclaw-fork-pin.ts:62-68,174-177",
    "trigger_condition": "[MED] Impossible calendar date (2026-02-30T00:00:00Z) passes ISO_Z and Date.parse via rollover",
    "guard_snippet": "const parsed = Date.parse(t); if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== t) fail(\"not a real instant\");",
    "potential_consequence": "Non-instant pinnedAt/citing accepted; post-pin row bracketed pre-pin, drift passes as legacy"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:136-153,198-206",
    "trigger_condition": "[MED] Two stampedDirs share a relative file key; file present in dir A only",
    "guard_snippet": "walkedFiles.add(`${dir}/${entry.file}`) and look rows up by the same dir-qualified key",
    "potential_consequence": "Z3 extends dirs: dir B file validated against dir A row, B's absence silently covered"
  },
  {
    "location": "tests/fleet/e2e/sc2-harness.ts:373-377",
    "trigger_condition": "[MED] Caller embeds swarmclawForkRev at nested depth; guard checks top level only",
    "guard_snippet": "const hasStampDeep = (v) => v !== null && typeof v === \"object\" && Object.entries(v).some(([k, x]) => k === \"swarmclawForkRev\" || hasStampDeep(x)); if (hasStampDeep(payload)) throw ...",
    "potential_consequence": "findStampedRevs reads any depth as a stamp: legit rev-quoting round fires false drift"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:139-209",
    "trigger_condition": "[LOW] stampedDirs empty or containing duplicates is never validated",
    "guard_snippet": "if (stampedDirs.length === 0) failures.push(\"no stamped dirs — vacuous pass\"); else dedupe-check entries",
    "potential_consequence": "Empty array yields green with zero files walked; duplicates emit doubled drift lines"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:73-79",
    "trigger_condition": "[LOW] evidenceDir exists but is a regular file; isDirectory throw is swallowed by catch",
    "guard_snippet": "const st = fs.statSync(evidenceDir); if (!st.isDirectory()) throw new Error(`evidence dir ${evidenceDir} is not a directory`);",
    "potential_consequence": "Operator chases a nonexistent path; real cause (wrong path type) is hidden"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:233",
    "trigger_condition": "[LOW] Top-level evidence file coincidentally named fork-rev-manifest.json, manifestPath elsewhere",
    "guard_snippet": "if (relPrefix === \"\" && entry.name === MANIFEST_FILENAME && full === manifestPath) continue;",
    "potential_consequence": "That evidence file is silently unwalked — its stamp never checked, no row needed"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:230-231",
    "trigger_condition": "[LOW] Round subdir reached only through a symlink; isDirectory() false for the link",
    "guard_snippet": "if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full).isDirectory())) out.push(...walkJsons(full, rel, failures, dir));",
    "potential_consequence": "Evidence behind symlinked round dir never walked; unstamped gap stays green"
  },
  {
    "location": "scripts/swarmclaw-fork-pin.ts:236-240,144-148,204-205",
    "trigger_condition": "[LOW] Corrupt evidence file or missing stamped dir also holds manifest rows",
    "guard_snippet": "collect known-unwalkable keys in a set during the walk and skip the F-009 ghost check for them",
    "potential_consequence": "One root cause yields 1+N failures (unreadable/missing-dir + every row ghosts) — F-006 spam"
  },
  {
    "location": "tests/fleet/swarmclaw-fork-pin.test.ts:512-519",
    "trigger_condition": "[LOW] Stamp literal survives only inside a comment/string within writeEvidence body",
    "guard_snippet": "const code = src.replace(/\\/\\/[^\\n]*/g, \"\").replace(/\\/\\*[\\s\\S]*?\\*\\//g, \"\"); then indexOf/body-extract on code",
    "potential_consequence": "F-012 lint passes while stamping is dead; unstamped rounds are invisible to the alarm"
  },
  {
    "location": "tests/fleet/q1-contract.test.ts:361-362",
    "trigger_condition": "[LOW] Test name claims every other verb excluded (INV-Z1-2) but asserts only two-verb presence",
    "guard_snippet": "rename to \"both observe verbs present in the registry\" or add an assertion enumerating the non-observe verbs",
    "potential_consequence": "Green test lends false confidence that other registry verbs are provably unreachable"
  }
]
