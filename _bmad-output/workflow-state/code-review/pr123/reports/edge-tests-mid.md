# Edge Case Hunter — pr123 chunk-t3 + chunk-t4 (verbs/helpers/issue-correlation, brief-schema/pipeline-run/manifest)

Scope: `_bmad-output/workflow-state/code-review/pr123/chunk-t3.diff` (tests/fleet/helpers.ts, tests/fleet/verbs.test.ts, tests/phase-engine/issue-correlation.test.ts) and `chunk-t4.diff` (tests/fleet/brief-schema.test.ts, tests/phase-engine/pipeline-run.test.ts, tests/phase-engine/manifest.test.ts). Verified against live sources: `src/fleet/verbs.ts`, `src/fleet/status.ts`, `src/fleet/brief-schema.ts`, `src/phase-engine/issue-correlation.ts`, `src/phase-engine/manifest.ts`, `scripts/pipeline-run.ts` (`runContextFrom`), `scripts/lib/run-lock.ts`, `src/providers/driver.ts` (`provisionAdmittedRun`), `tests/helpers.ts`.

Overall: this is an unusually strong edge-case suite. Most boundary claims check out against source exactly (exit-code table [0..6] vs `scripts/fleet.ts:396`; `WITNESS_FRESH_WINDOW_MS` ±30min symmetric via `Math.abs` at `scripts/pipeline-run.ts:384-397`; `lstat` vs `existsSync` for the dangling witness at `:358-365`; `Number.isSafeInteger` stamp bound at `manifest.ts:757`; NO_CONTROL_CHARS class `\p{Cc}\p{Zl}\p{Zp}\p{Cf}` at `brief-schema.ts:88`). Findings below are the residual gaps and fragilities.

---

**[HIGH] Diff's closed-world registry assertions contradict the current source — the diff no longer describes the tree**
- `chunk-t3.diff` verbs.test.ts: "listVerbs returns exactly 4 entries", order pin `["dispatch","status","harvest","teardown"]`, `EXPECTED_FLAGS`/`EXPECTED_EXIT_CODES` for 4 verbs only, and the "--driver required on EVERY verb" sweep.
- Verified: `src/fleet/verbs.ts:44-49` now returns **6** entries (fanout, rank added by df3-2), and `rank` deliberately has **no `--driver` flag** (`verbs.ts:150-174`) — the sweep `entry.flags.find((f) => f.name === "--driver")?.required).toBe(true)` fails on rank outright. The committed `tests/fleet/verbs.test.ts:211` on this branch asserts 6 and was rewritten; the diff under review is the pre-fanout version.
- Trigger: any re-application/rebase of this diff onto a tree containing DF3.2 reds three independent tests ("exactly 4", registry-order pin, driver-required-every-verb). The root weakness is closed-world pinning of an explicitly additive registry — every new verb must edit four separate literals in this file or the suite lies about which grammar it verified.

**[MEDIUM] Excused-exit-code binding test parses cli.test.ts with indentation/format-sensitive text boundaries**
- `chunk-t3.diff` ~line 969-1008 ("every excused exit code names a cli.test.ts case that still ASSERTS it").
- Trigger: boundary is `rest.indexOf('\n  test("')` — assumes every sibling test sits at exactly two-space indent inside one describe, uses a double-quoted string literal first arg, and never template-literal/backtick titles. A coveredBy title that becomes the LAST test in cli.test.ts yields `end < 0` → false "no next-test boundary" failure. Duplicate titles bind to the first occurrence, so a stale copy earlier in the file excuses a rewritten body. Failure mode is loud (good) but includes false positives that train maintainers to loosen it.

**[MEDIUM] DOCUMENTED_EXIT_CODES binding regex takes the FIRST clamp-shaped match anywhere in scripts/fleet.ts**
- `chunk-t3.diff` ~line 320-346, verified against `scripts/fleet.ts:396` (`e.exitCode >= 1 && e.exitCode <= 6 ? ... : 2`) — matches today.
- Trigger: `.exec(cli)` scans the whole file; any second clamp-style expression appearing EARLIER (a helper classifier, a fanout arm) silently re-binds floor/ceiling. If ceiling ever parsed as >6, `DOCUMENTED_EXIT_CODES` grows and every exit-code membership check in the file loosens in the same commit — the meta-test passes while asserting a table the CLI does not have.

**[MEDIUM] Freshness-window exact boundary untested (S28)**
- `chunk-t4.diff` pipeline-run S28 block; source `scripts/pipeline-run.ts:394` uses inclusive `Math.abs(ageMs) <= WITNESS_FRESH_WINDOW_MS`.
- Trigger: all fixtures sit at ±60min, far outside the window. A flip of `<=` to `<`, or a units slip confined to the comparison (not the constant), is invisible. One `utimesSync(now - 30*60_000)` case would pin inclusivity; absent, the boundary is declared but never observed.

**[MEDIUM] Two deliberate tripwire tests certify open money-path hazards green**
- `chunk-t4.diff`: "serializeManifest does NOT require a stamp" and "re-stamping is LAST-WINS and unguarded — a second stamp can RAISE the ceiling". Both honestly labelled KNOWN DEFECT, verified accurate against `manifest.ts:752-762` (spread puts `limitMicroUsd` last; no monotonic guard).
- Trigger: CI-green here means "hazard still open", not "covered". Anyone auditing coverage by test names sees AC9a stamp tests pass and concludes the ceiling path is guarded. Acceptable as pins, but they belong in the review verdict as open defects, not passing checks.

**[LOW] goodLedger fake hardwires `remainingMicroUsd = ceilingMicroUsd` regardless of cap**
- `chunk-t3.diff` helpers.ts `goodLedger(ceilingMicroUsd, capMicroUsd)` — the docblock correctly separates ceiling from cap, but the returned decision keeps `remainingMicroUsd: ceilingMicroUsd` even when the caller passes `capMicroUsd ≠ ceilingMicroUsd`.
- Trigger: a dispatcher change that derives spend headroom from `decision.remainingMicroUsd` instead of `capMicroUsd` passes every fixture, including the ones whose stated purpose is keeping the two distinguishable.

**[LOW] Module-scope LOCK_HOST probe runs fs I/O at import time with no failure isolation**
- `chunk-t3.diff` ~line 233-240: mkdtemp → acquire → read → release → rm at module load.
- Trigger: any throw (tmpdir perms, run-lock regression) kills the entire suite before a single test reports, with no per-test attribution. Also pays the cost even if the lock probes were removed.

**[LOW] Local `isAlive` copy diverges from run-lock.ts's fail-closed version**
- `chunk-t3.diff` ~line 248-255 vs `scripts/lib/run-lock.ts:140-141`: the real one returns ALIVE for `pid > 0x7fff_ffff`; the test copy answers ESRCH-only. DEAD_PID = 9_999_999 sits safely below the threshold today.
- Trigger: someone "improves" DEAD_PID past 2^31-1 to be extra-dead: run-lock classifies it alive (held branch), while the test's own precondition `expect(isAlive(DEAD_PID)).toBe(false)` still passes — the probe then lands on the contention branch and the remediation assertions red confusingly instead of the precondition catching it.

**[LOW] Empty-fleet status probe never asserts stdout is empty**
- `chunk-t3.diff` PROBES.status entry `{ argv: ["status"], code: 0, before: () => void expect(store.list()).toEqual([]) }`.
- Trigger: a status that prints fabricated rows (or any garbage) over an empty fleet exits 0 and passes; only the later printing probe constrains output shape, and only for a non-empty fleet.

**[LOW] resolveRunCorrelation refusal test uses try/catch sentinel that its own catch swallows**
- `chunk-t3.diff` issue-correlation block: `try { resolveRunCorrelation(...); throw new Error("expected CorrelationError"); } catch (e) { expect((e as CorrelationError).code)... }`.
- Trigger: if correlation unexpectedly succeeds, the sentinel lands in the same catch and the failure surfaces as `code: undefined ≠ "INVALID_REPO_SLUG"` rather than "did not throw". Fails loudly but misattributes cause; the file's own `refusal`/`rejection` pattern exists for exactly this.

**[LOW] Frozen-object assertion covers only the stamped surface; deep freeze is inherited, not tested**
- `chunk-t4.diff` manifest block: `Object.isFrozen(stamped.manifest)` only. Deep freeze holds today only because `loadManifest` deep-freezes and the spread shares nested references (`manifest.ts:600-606, 762`).
- Trigger: a rewrite of `stampManifestLimit` that rebuilds `phases` (map to fresh objects) silently drops frozen-ness on every nested object; no test notices because only the top object is checked.

**[LOW] Tracer-close test asserts environment-coupled WAL byte state and a weak exit predicate**
- `chunk-t4.diff` AC9b "the cap refusal closes the tracer": `expect(exitCode).not.toBe(0)` accepts ANY non-zero failure, and `fs.statSync(traceDb-wal).size === 0` depends on bun:sqlite honoring `PRAGMA wal_checkpoint(TRUNCATE)` leaving a 0-byte sidecar — a SQLite/bun upgrade can red this without any regression in the guarantee being tested.

**[LOW] brief-schema residual gaps: multi-segment slug and duplicate JSON keys**
- No case for a 3-segment repoSlug (`owner/group/repo`) — REPO_SLUG_PATTERN (`issue-correlation.ts:32`) refuses it as two-segment-only, and the schema docblock says GitLab subgroups were never expressible, but nothing pins it. Duplicate-key briefs (`{"issueId":1,"issueId":2}`) are last-wins at `JSON.parse` before zod sees them — untestable at this layer, worth a comment so nobody adds a fake test for it.

**[LOW] issue-correlation additions touch none of the requestId surfaces named in the review brief**
- The chunk-t3 hunk adds only canonicalRepoSlug/canonicalisation cases (all verify clean against `issue-correlation.ts:71-73, 126-168`). requestId collision / absent-id fallback / cross-run bleed coverage lives in earlier hunks of the same file outside this chunk — flagged so the lead knows this chunk neither strengthens nor weakens those.

**[LOW] manifest.test.ts strip hunk asserts phases by length only where the sibling asserts deep equality**
- `chunk-t4.diff` manifest.test.ts hunk: `stripped.manifest.phases).toHaveLength(loaded.manifest.phases.length)` vs the brief-schema sibling's `toEqual`. Phase content drift through strip would pass here; the aliasing half of the contract IS properly double-checked both directions.

Verified-clean highlights (checked against source, no finding): exit-code table/probes match `scripts/fleet.ts` codes incl. `key-unattributable` (:1973), `lock-release-failed` (:2193), `ledger-close-failed` (:2095); `-h` normalization (:482), `argv[0] === "help"` (:1024); status.ts row states/orphan id parenthesisation/boxAlive tri-state/recordsSkipped all match `status.ts` verbatim; provisionAdmittedRollback INV-1 pair matches `driver.ts:496-527` (remove-on-write-failure, open-on-create-failure); runContextFrom reconciliation matrix, dangling-symlink lstat choice, symlinked-manifest beneath-root refusal, and the `resolvedPath === undefined` throw all match `pipeline-run.ts:272-438`; stamp validation matrix (0/neg/float/1e300/MAX_SAFE+2/non-number/MAX_SAFE-inclusive) matches `manifest.ts:757`; hostile-key sanitisation and length cap match `brief-schema.ts:173-181, 445-462`.
