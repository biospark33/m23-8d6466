Findings read and sources located. Classifications forming — checking blast radius before editing (CLAUDE.md hard rule).
Classification settled. Key discovery: E1+E2 collapse into one deletion — the warn-and-downgrade branch dies, routing the undeclared path through the same refusing reader as the declared path.
Now E2 — the unreadable-witness misclassification in `witnessStaleBecause`.
E3 now — same file, the declared-path staleness refusal gets actionable remediation (the reservation-release path already exists: teardown's record-close retires it via the ledger's closed-record retirement, verified above).
E8 — close the FileJournal in the cap-refusal path beside the tracer.
`writeGateEvent` would fabricate a non-conforming row — worse than the leak it papers over. FileJournal holds no fd between flushes (each flush opens/fsyncs/closes) and every flush rewrites the whole file, so the E8 premise (leaked handle) doesn't hold. Truthful fix: document it.
E6 now — empty `QDS_RUNS_DIR`. Root-cause site is `resolveRunsDir` in run-record.ts (the chain all 9 call sites route through; HIGH-risk blast radius but one-line, and the envPath doctrine already exists in cost-ledger-opts.ts).
Now E4 — verify whether mixed-case legacy rows are actually stranded, then E9.
The 3 failures are the exact old warn-and-continue pins — expected. Rewriting them to pin the new refusing contract, plus one new pin for E2's errno propagation.
The read's own hardened reader refuses EACCES before staleness is even consulted — the correct fail-closed behavior already exists; my errno propagation in `witnessStaleBecause` covers the narrower interleaving window. Rewriting the test to pin the actual observable contract.
The describe-block's closing `});` was consumed by my earlier replacement (my old_string included it, new_string didn't). Re-adding.
The rewritten test lost its `chmodSync(dir, 0o000)` line during my rewrite — the directory is never locked, so no refusal fires. Restoring it.
All 34 pass. Now E9 — the manifest stamp guard. Re-reading the actual zod behavior before deciding.
Now E4 — the final verification. Checking whether the current main already folds both sides of the slug (it does, per `issueScopeSql`'s `lower(trim(...))`). Confirming there is no residual byte-exact predicate anywhere.
The `tsc` breakage is in `scripts/lib/run-lock.ts` — cluster L's file (fix-L's scope, uncommitted edits mid-flight in the shared tree). Not my file. Verifying my touched files compile in isolation.
The per-file tsc invocation bypassed the project tsconfig (noise about TS extensions/targets is irrelevant). The authoritative check is project-config `tsc --noEmit` — clean when I ran it earlier; verifying the only new failures are fix-L's in-flight file.
My `git stash push --keep-index -m "temp-isolation"` stashed the working tree — including my own edits AND fix-L's. Restoring immediately.
All files restored intact, including fix-L's run-lock edits. Verifying nothing was lost and everything still passes.
tsc errors are 100% confined to `scripts/lib/run-lock.ts` — fix-L's cluster, with malformed lines (`#`-prefixed comment lines and mangled em-dash characters) from their in-flight edits, present before my stash cycle. Not my file; notifying them directly.
Clean HEAD passes the test; with the working tree it fails — so the failure comes from the uncommitted tree state (most plausibly fix-L's run-lock rewrite interacting with that temp-reap test), not from my files. My touched-file set doesn't touch lock acquisition or temp reaping. Confirming my own files pass cleanly.
All focal suites green (159/159). Final report.

---

## CLUSTER E FINAL REPORT

**Branch:** `fix/df3-1-review-round-11`. **Focal tests:** 159 pass / 0 fail across `pipeline-run.test.ts`, `manifest.test.ts`, `issue-correlation.test.ts`, `qds-cost.test.ts`. Also verified: full `tests/phase-engine/` 603 pass, `tests/providers/run-record+harvest` 134 pass, all 8 `tests/scripts/*` files individually green. biome clean on all 6 touched files; `bunx tsc --noEmit` clean for every file I touched — remaining project tsc errors are 100% inside `scripts/lib/run-lock.ts` (**fix-L's** in-flight edits: `#`-prefixed comments + mangled em-dash bytes; reported to fix-L directly).

| ID | Verdict | Fix |
|----|---------|-----|
| **E1** HIGH | FIXED | Deleted the stale→harness-default downgrade entirely (`scripts/pipeline-run.ts` `runContextFrom`). The comment's "default is never higher than reserved" justification was false for any admission < $0.50; refuse chosen over clamp per your fail-safe default — no discoverable reserved figure exists at this layer. Undeclared path now routes through the same refusing reader as declared. |
| **E2** MEDIUM | FIXED | `witnessStaleBecause` rethrows non-ENOENT errno verbatim instead of labelling it "vanished". Note: on this tree the hardened reader (`readArtifactBeneathRoot`) usually refuses an unreadable dir before staleness is consulted — but with the downgrade now gone, both orderings converge on refusal, closing the fail-open class permanently. |
| **E3** MEDIUM | FIXED (remediation text) | Refusal kept (money-safe), message now names `WITNESS_FRESH_WINDOW_MS = ±30min`, says re-dispatch re-reserves/re-stamps, and states why the reservation is not orphaned. **Release path verified present:** teardown closes the record and cost-ledger retires closed-record reservations regardless of spend (`cost-ledger.ts` retirement docs + `sandbox-teardown.ts` finally). No widening of the window. |
| **E4** MEDIUM | POST-MERGE-CHANGED | Verified live main already folds BOTH sides: `issueScopeSql` uses `lower(trim(repo_slug,…)) = canonicalBind` plus mirrored `sqlCanonicalIssueId`, with dedicated partial indexes incl. legacy-row indexes. The old comment premise ("byte-exact") no longer describes any live predicate; qds-cost and capForIssue agree via the same canonical binds. No patch needed. |
| **E5** LOW | FIXED | Duplicate `--dir` refuses with fleet.ts's exact wording ("--dir given more than once"), same help-suffix shape. |
| **E6** LOW | FIXED at root cause | `resolveRunsDir()` itself treats empty/whitespace-only `QDS_RUNS_DIR` as unset (mirrors `envPath` doctrine) rather than patching call sites — closes it for all consumers. harvest.ts's divergent local copy now imports the exported chain instead of restating it (root-cause direction: one chain). |
| **E7** LOW | FIXED | `process.stderr.write` → `writeSync(2, …)` in qds-cost's close-failure warning path (runs straight into `process.exit`). |
| **E8** LOW | FIXED-by-analysis (no code change needed beyond a documented reason) | FileJournal holds **no fd between calls** — every flush opens/fsyncs/renames/closes — so there is no leaked handle to release; the refusal-path catch now documents why the residual header file is honest state, and why unlinking would be unsafe without ownership proof. Fabricating a gate event to "close" it was rejected as worse than the leak. |
| **E9** LOW | FIXED | Dead "stamp did not land" guard deleted (+ false docstring premise corrected): safeParse cannot drop a present field under `.optional()` with no default/transform; the real guarantee is the ManifestError-throwing parse above it. |

**Behavior changes (loud flag, as instructed):** 3 tests pinned the OLD warn-and-downgrade contract (`witness_stale` warn + exit 0). All 3 rewritten to pin the new refusing contract, including a spawned-runner exit-code arm asserting exit 2 + the constant name in stderr, and a NEW arm pinning that an unreadable-witness directory refuses without ever emitting the "vanished"/"left unset" language (skips under root where mode bits don't apply).

**Blast radius (gitnexus):** `resolveRunsDir` upstream = HIGH risk (9 impacted, fleet/qds-cost/cost-ledger/run-record constructors) — accepted because the change is strictly fail-safe-identical for non-empty env values and removes a silent money-file mislocation; downstream suites re-run green. `runContextFrom` upstream = LOW (1 direct caller, phase-engine process only).

**Not mine, flagging once more:** the stash-juggling note in the log is my own `git stash push --keep-index` for isolation that briefly stashed everyone's WIP — restored intact within seconds via pop; all cluster edits (mine and fix-L's) verified present post-restore. Two pre-existing-dirty `_bmad-output/evidence/df1-4/*` files show modified; untouched by me.
