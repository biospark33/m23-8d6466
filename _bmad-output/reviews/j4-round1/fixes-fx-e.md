# FX-E fixes (J4 round 1) - L9 repo-sweep triage

Files: `src/autonomy/l9-repo-sweep-triage.ts`, `tests/autonomy/l9-repo-sweep-triage.test.ts`.

- R1-01: mock client with no injected corpusDir writes to `L9_MOCK_CORPUS_DIR` (`<corpus>/mock`, same value as L8, not imported). Tests: no top-level `*.jsonl` after mock writes; default-path probe leaves top-level untouched.
- R1-13: finding_id = `sweep:<path>@<sha256(brief)[:8]>`; existing record (same id + labeler) => no ask, log `l9-triage` miss `already-recorded`. Test: second rank makes zero asks; changed brief re-asked.
- R1-20: truncated paths carry `~<digest of full path>` (distinct ids); non-finite scores are a recorded miss `non-finite-score` (no ask) and sort last in a total order. Tests added.
- R1-21: default walk bounded (MAX_WALK_ENTRIES=5000, MAX_WALK_DEPTH=8), skips node_modules/.git/.hg/.svn, lstat + skips symlinks, unreadable entries skipped. Comment fixed. Tests: tmp tree with broken symlink + node_modules.

Gates: bun test (23 pass), biome clean, tsc no errors in these files.
