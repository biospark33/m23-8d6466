All findings located. Key discovery: the guard under T3-1 is unreachable at runtime today (`loadManifest` always sets `resolvedPath`; `main` is module-private), but I can build a discriminating runtime arm another way — route a manifest through a symlink so the argv path's directory and the verified realpath's directory differ, plant a different fresh witness in each, and prove `exit 0` comes only from anchoring on the realpath. Applying the edits now.
Now applying edits. First, pipeline-run.test.ts — T3-1 (runtime arm + retitled regex detector) and T3-2 (just-outside-window arm).
Now the `writeCodeManifestIn` helper — `writeCodeManifest` writes into a flat dir with a seq filename; my runtime test needs a fixed name inside `realDir`. Add it next to the existing helper.
T3-1 runtime arm verified falsifiable (wrong-ceiling probe flips it to fail). Now T3-2 — add the just-outside-window arm next to the existing inner-edge arm.
Now visualizer/test/auth-static.test.ts — T3-3 (negative credential arms on the dist asset path) and T3-4 (cleanup robustness; server DIST_DIR is a hardcoded module constant so full relocation needs src changes — document that).
Now T3-4 — harden the dist fixture against a mid-suite kill. The server's `DIST_DIR` is a module constant resolved from its own file location (`visualizer/server/index.ts:33`), with no option or env override, so pointing it at a mkdtemp is a src change — out of scope per my brief. Harden what's on the test side instead: pre-existing tracked files survive, and add process-exit cleanup so a SIGINT during the suite doesn't leak fixture bytes.
The old afterAll body remnant is left over. Removing it.
14 pass (was 12), no dist leak. Now T3-5 — the doubled `/**` opener in auth.test.ts:711.
Now T3-6 — brief-schema.test.ts. Three changes: assert the message on the bare `.toThrow()`, replace the unfalsifiable prototype-pollution epilogue with a real merge-target assertion, add wrong-type test.each for commitSha/repoSlug/manifestPath/repoUrl.
The merge-dance I wrote is itself convoluted and near-vacuous (`__proto__` via Set semantics wouldn't even register as own-key). Per the task's stated preference — deletion over fake coverage — simplify to removing the epilogue and crediting the already-strict `expectRejected`.
Now the wrong-type test.each. Insert after the null test (near line 320).
That `null === null ? 0 : 0` line is nonsense I typed — cleaning it up, and using `test.each` as the task asked.
All 6 each-rows run (101 = 95 baseline + 6 rows). Now Step 3 — E5 and E6 coverage in qds-cost.test.ts.
The failure: `beforeEach` sets `QDS_COST_LEDGER_FILE`, whose override wins outright and pointed the child at a nonexistent file. And the success output never prints the ledger path — the real discriminator is a decoy ledger at `<cwd>/cost-ledger.db` (the exact file the pre-fix empty-env resolution would read), asserted by TOTAL present + decoy clean. Rewriting the test properly.
Stash cycle restored intact (all 6 touched files present). Now full focal validation.
tsc on clean HEAD is clean — 2 of the 3 errors are other clusters' in-flight files (verbs.test.ts = fix-T1, cost-ledger.test.ts = T2 owner); the qds-cost.test.ts:148 one is mine. Fixing my typing.
All remaining tsc errors are other clusters' in-flight files (fix-T1's `dispatch.test.ts`/`verbs.test.ts`, T2-owner's `cost-ledger.test.ts`) — zero in my five touched files. Sending the final report.
Cluster T3 complete. Report sent to team-lead.

**Summary:**
- **T3-1**: New runtime arm proving the witness anchors on the verified realpath (symlink construct, falsifiability-probed by flipping the witness ceiling); regex pin kept as secondary under a retitled "layout change-detector" name.
- **T3-2**: Added the just-outside-window arm (31-min refused via `utimesSync`); just-inside already existed — pair now pins the window's width.
- **T3-3**: Wrong-same-length + malformed bearer arms against the dist asset path (401).
- **T3-4**: mkdtemp relocation skipped with documentation (server `DIST_DIR` is a hardcoded module constant; relocation needs a src edit). Test-side hardening instead: `process.on("exit")` cleanup of written fixture files so hard kills don't leak into the working tree.
- **T3-5**: Doubled `/**` removed.
- **T3-6**: `.toThrow(/unknownField/)`, unfalsifiable prototype-pollution epilogue deleted, 6-row wrong-type `test.each`.
- **E5/E6**: duplicate-`--dir` refusal and empty-`QDS_RUNS_DIR`→default-dir tests added to qds-cost.test.ts (E6 uses a cwd decoy ledger as discriminator).
- **E7** skipped as disproportionate; **E9** confirmed green.

Validation: focal suites **1081 pass / 0 fail**, biome clean on all touched files, tsc clean for my files (3 residual errors are other agents' in-flight files, verified via stash/pop). No src or script edits, no commits.
