# Z1 R3 — Acceptance Auditor (final)

Branch `feature/z1-adapter-contract-v2` @ dev ff69eab7 (branch has **zero committed changes** vs dev — the entire story delta is the working tree, exactly the 9 files in `z1-r3.diff`: 2026 insertions / 28 deletions).

**Verdict: 1 finding** (unlanded r2 PATCH — driver git action, R2-02). Everything else verified clean.

---

## Finding

**A-1 (HIGH — unlanded r2 PATCH R2-02): the 6 manifest-mapped sc2-7 evidence JSONs are still untracked.**

`git status --porcelain _bmad-output/evidence/openrig-sc2/`:

```
?? 2026-09-30T15-19-10-429Z-sc2-7-kill-and-provision.json
?? 2026-09-30T15-19-13-229Z-sc2-7-box-forensics.json
?? 2026-09-30T15-20-32-951Z-sc2-7-observe.json
?? 2026-09-30T15-20-33-785Z-sc2-7-race-window-closed.json
?? 2026-09-30T15-20-37-791Z-sc2-7-approve.json
?? 2026-09-30T15-20-38-997Z-sc2-7-branch-and-complete.json
```

`git ls-files` confirms exactly 31 tracked files in the directory (30 evidence JSONs + the manifest); the manifest has 36 rows; 36 − 30 = 6 untracked. R2-02's disposition was "stage the 6 evidence JSONs unedited with the branch commit" — the branch commit does not exist yet and the files are not staged. Deterministic consequence in a clean CI clone: `walkJsons` never sees the 6 files, `missingDirs` stays empty, and the F-009 ghost check fires 6 × `manifest row … has no evidence file` → alarm **red in CI, green on this tree** — the exact CI-greenness violation charter §5.4 forbids and the exact defect R2-02 named (re-verified against `scripts/swarmclaw-fork-pin.ts` ghost-check logic). Not a regression: F-009's rows→files check is present and working; the driver git action it motivated was simply not executed. Fix is `git add` of the 6 files (unedited) before the branch commit.

---

## (a) ACs / invariants / DOD — all hold (spot-verified against source)

- **AC1** — `tests/fleet/observe-contract.ts` pins `result` via `expectExactFields(payload, RESULT_REQUIRED, RESULT_OPTIONAL)`; `expect(RESULT_SCHEMA_VERSION).toBe(1)` matches `src/fleet/result.ts:27`; `RESULT_STATUS_VALUES` sorted equals the 7-word closed set (verified against `result.ts:39`); exit row `[0, 2, 4, 6]` asserted and matches `src/fleet/verbs.ts:636`; RUNNING-doctrine named in the helper docblock and the q1 test name ("exit 0 covers a RUNNING run — … `terminal` the field a poller branches on"). Negative control honored: meta-test demonstrates fat AND short payloads throw naming the field.
- **AC2** — status field set as-observed, `STATUS_VOCABULARY` = 16 words (length===16 asserted), all 16 verified present in `src/fleet/status.ts` (docblock at :80, "THE WHOLE VOCABULARY"); `FLEET_ROW_ID` asserted on the fleet-level row; exit row `[0, 1, 2, 4, 5, 6]` matches `verbs.ts:150`; `"schemaVersion" in rowOut` asserted false on every wire row. **No `STATUS_SCHEMA_VERSION` anywhere** — grep over `src/ tests/ scripts/` returns zero hits. Negative control holds (no bytes in `src/fleet/status.ts`).
- **AC3** — `OBSERVE_VERBS = ["status", "result"]` asserted against `listVerbs()`; result row flags asserted to NOT contain `--driver` (matches `verbs.ts:617` comment + flag list); poisoned-deps probe (F-014): throwing driver Proxy + throwing `ledgerFactory`, same poll exits 0 with identical payload.
- **AC4** — `scripts/swarmclaw-fork-pin.ts`: `SWARMCLAW_FORK_REV = "cb2e1ca3eac0d80f40de764ab91f17fd29b47c58"` (40-hex verified), provenance comment names round (sc2-7), date (2026-09-30), merge (PR #682), and the bracketed-not-field-recorded status per DD-28.26(9); `SWARMCLAW_FORK_REV_PINNED_AT = "2026-10-02T15:08:06Z"` (ISO-8601 UTC, Z-suffixed); pin equals the newest round row's rev (2026-09-30T15:20:38Z row, same SHA) — asserted by the authorship test (passing). Outside the box COPY set.
- **AC5** — manifest: 36 rows, exact bidirectional coverage of the 36 evidence JSONs (verified programmatically: zero files in-dir-not-in-manifest, zero in-manifest-not-in-dir); the two `.log` files take no rows (JSON legs only); every row is `{file, rev, source: "git-log bracket", citing: {merges, timestamp}}` with Z-suffixed timestamps; evidence originals untouched (diff touches only the new sidecar). One file, not per-directory.
- **AC6** — post-pin boundary machine-derived: `citing >= pinnedAt` on exported ISO-Z values, inclusive at the pin (boundary test passes); post-pin rows require `rev === pin` (R2-01, three fixtures: coherent, revless, both-failures); pre-pin revs validate against their own row (legitimate-old-rev test passes); drift failure names file + both revs; unmapped stamped file → coverage finding ("add its rev from round provenance — never guess"); meta coherence (pinRev/pinnedAt vs exports) enforced in the validator itself (F-013).
- **AC7** — `writeEvidence` stamps `swarmclawForkRev` on a copy; F-012 source-lint enforces the stamp on comment-stripped source (R2-12) plus all four guards (plain-object, caller-stamp, nested-deep, `'wx'`) per R2-13; suite passes (39/0).
- **AC8** — helper docblock: `$SWARMCLAW_FACTORY_FLEET_CLI` named as the only route; `--driver exedev` placed only in the deployed wrapper, explicitly "including for `status`"; status row asserted `--driver required: true` (matches `verbs.ts:134`). Nothing teaches the fork the driver grammar.
- **INV-Z1-1** — pin module imports only `node:fs`/`node:path`; alarm reads evidence + manifest only. **INV-Z1-2** — pinned set excludes driver/spend/approval verbs; poison-probe proves the result path touchless. **INV-Z1-3** — no evidence original modified; grammar boundary carried as prose.
- **DOD** — Impl ✓; q1 extension green (**15/0**, exit 0); closure pin ✓; alarm fixtures prove both-revs+file failures without editing real evidence (**39/0**, exit 0); **box COPY set zero-byte** (worktree delta = only the 7 story files + manifest + doc; nothing under `src/fleet`, `src/lib`, `src/phase-engine`, `src/swarmclaw`, `scripts/lib`, `scripts/pipeline-run.ts`, `cli-anything/`, `oci/exedev/`); `tests/fleet/skill-contract.test.ts` absent from the delta (byte-identical); e2e demo present (run() argv-in/JSON-out, exit-0-RUNNING + exit-4-missing in `assertObserveSurface`).

## (b) r2-fix regressions / Observability Contract — none

All 22 r1 PATCH fixes and all 18 r2 PATCH fixes verified present and non-contradictory in the final code (F-001…F-022, R2-01, R2-03…R2-07, R2-10…R2-21). Spot-confirmed the fix interactions: R2-03's roundtrip supersedes F-004's NaN-only check without losing F-003's gate order (pinnedAt → stampedDirs → stat → manifest read, fixture-pinned); R2-12's comment-stripping does not weaken F-012's stamp lint (suite green); R2-01's row-rev check coexists with the F-008 duplicate detection (both-failures fixture shows both lines). Observability Contract: every failure is one actionable line (unreadable manifest/bad pinnedAt early-return exactly one failure; missing-dir defers the 1+N ghosts; null named explicitly; no truncation; unmapped = "unmapped", never an assumed rev).

## (c) DISMISS rationales — all 7 still standing

- **F-023 / R2-08** (alarm fatigue by design): standing — AC6 mandates the coverage finding verbatim (it is the implemented message); DD-29 recorded in the decisions doc (§8b, in this diff) with the revisit trigger.
- **F-024** (harness imports pin module): standing — `tests/` is outside the COPY set; INV-Z1-1 bars fork imports, and the import graph contains none.
- **F-025** (midnight placeholder): standing — `meta.sourceRule` documents timeline-bracketed inference; the row is pre-pin and validated only against its own rev.
- **F-026 / R2-09 / F-027** (q1 store/invocation dedup): standing — premise re-verified false a third time by the passing 15/0 run (beforeEach-fresh store; one helper sweep per verb, four named properties).

No dismissed finding was re-litigated; no DISMISS rationale regressed.
