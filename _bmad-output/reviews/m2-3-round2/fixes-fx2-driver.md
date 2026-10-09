# fx2-driver — round-2 fixes (m2-3)

Files touched (ownership honored): `tests/fleet/e2e/memory-combined.live.test.ts`, `config/rosters/memory-live.roster.yaml`. No commits.

## R2-001 (BLOCKER) — manifest budget vs caller ceiling
- `runBudgetMs: 600_000` → `900_000` in the staged manifest JSON (dispatch's requiredBudgetMs 741,000 exceeded the old value → manifest-rejected pre-spend every run).
- Dispatch argv gains `"--timeout-ms", "960000"` (budget + headroom; dual-role shape from tier2-rig-swarm-mixed.live.test.ts:138-146 — runBudgetMs must fit UNDER the callerBudgetMs ceiling). L1's own `runFleet` `timeoutMs: 1_200_000` unchanged and still covers it.

## R2-002 (HIGH) — tautological staged≡committed assert
- Replaced `sha256Hex(staged) === sha256Hex(fixture-working-tree)` (copyFileSync then hash of the same bytes) with a real tree binding: staged file's sha256Hex vs sha256Hex of `Bun.spawnSync(["git","cat-file","blob",\`${ctx.sha}:${ROSTER_FIXTURE_REL}\"])` stdout, with a distinct throw if the blob read fails. The header/seam comments updated to say "at the pinned SHA".

## R2-003 (HIGH) — worker_output echo hole
- The marker sits verbatim in the task prompt, so the seam now requires BOTH: `markerHits.length > 0` (task compliance) AND `docIdHits.length > 0` where the needle is the extension's frameAsData JSON shape `"documentId":"m23-prime-` (verified in kg-recall sanitize.ts: each returned memory renders as `[i] JSON.stringify(m)`, so only real recall output carries that key+value prefix; the brief renders the record as a citation, never this JSON).
- Evidence fields updated: `quotesRecalledDocumentId: boolean` added alongside `markerCarried`; header comment block updated to describe the dual requirement.

## R2-004 (MED) — muted reharvest stderr
- Re-harvest runFleet env `{ ...env }` → `{ ...env, QDS_LOG_VERBOSE: "1" }` with the same rationale comment as the teardown verb (log sink mutes stderr under NODE_ENV=test; without it the `divergent` assert was vacuous).

## R2-005 (MED) — roster-check preflight wired
- Pre-dispatch (after the R2-002 assert, before the spend print/fire): `Bun.spawnSync(["bun","scripts/roster-check.ts","--roster",<staged roster>], {cwd: REPO_ROOT, stdout:"pipe", stderr:"pipe"})`.
- Exit 1 → refusal naming the roster + captured stdout/stderr tail. Exit 0 → `rosterCheck: "green"` pushed to evidence. Any other exit (2 = unevaluable host: pi binary / OPENROUTER_API_KEY missing — verified against scripts/roster-check.ts's own exit contract) → warning line to stderr and evidence `rosterCheck: "unevaluable on this host (exit N) — pre-fire runbook step stands"`, round proceeds. Exit 1 blocks; exit 2 does not.
- Live-verified the CLI's unreadable-roster path exits 2 (smoke: `bun scripts/roster-check.ts --roster /tmp/does-not-exist.yaml` → exit 2), and confirmed no CLI path confinement blocks the absolute staged path.

## R2-006 (MED) — empty key baseline flags every key as leaked
- L3 finally: if `round.hashesBefore.size === 0` → `keyProblems = ["key baseline unavailable — L1 threw before listedKeyHashes; key-leak check UNMEASURED"]`, `keyLeakProblems` skipped. Otherwise unchanged.

## R2-007 (LOW) — battery evidence drops ttl clock fields
- Mapped outcome objects now carry `ttlExpiresAtMs: o.ttlExpiresAtMs, ttlFiredAtMs: o.ttlFiredAtMs` (fields exist on ProbeOutcome, memory-negative-probes.ts:124-125).

## R2-008 (LOW) — first throw masks evidence problems (L1 + L2)
- Both leg endings now: failure AND problems → `throw new Error(\`${problems.join("; ")} (also failed: ${failure message})\`, { cause: failure })`; only failure → `throw failure`; only problems → throw problems. Applied to both identical endings via one replace.

## R2-009 (LOW) — torn [kg-recall] lines silently dropped from L2 evidence
- `unparseableKgRecallLines: unparseableCount` added to the in-box-recall evidence object; when count > 0, `evidenceProblems` gains "N unparseable [kg-recall] line(s) in the harvested artifacts — torn control-channel output".

## R2-011 (LOW) — fetch problem vs commit problem
- Before `git cat-file -e ${ctx.sha}:${ROSTER_FIXTURE_REL}`, a bare `git cat-file -e ${ctx.sha}` throws the distinct message: "QDS_EXEDEV_SHA <sha> not present locally — fetch or correct the export; cannot verify the fixture at the pinned SHA". The path-level message is unchanged.

## R2-010 (LOW) — fixer writes revoked in the roster
- `config/rosters/memory-live.roster.yaml` fixer `writes: ["src/", "tests/"]` → `writes: []` with a one-line least-privilege comment (the round's task modifies nothing; the box holds a memory credential).

## Focal checks (verbatim)

```
$ env -u QDS_E2E_LIVE -u QDS_E2_TIER bun test tests/fleet/e2e/memory-combined.live.test.ts
bun test v1.4.0 (34cbb9a40)

 0 pass
 5 todo
 0 fail
Ran 5 tests across 1 file. [132.00ms]
exit=0

$ bun test tests/fleet/e2e/live-coupling-sweep.test.ts
 37 pass
 0 fail
 37 expect() calls
Ran 37 tests across 1 file. [32.00ms]
exit=0

$ bunx tsc --noEmit
tsc exit=0

$ bunx @biomejs/biome check tests/fleet/e2e/memory-combined.live.test.ts
Checked 1 file in 11ms. No fixes applied.
biome exit=0

$ bun -e "import {loadRoster} from './src/phase-engine/roster/schema.ts'; ... fixer writes must be [] ..."
roster ok
```

Check 3 (memory-negative-probes.test.ts) is not this fixer's — skipped per brief.
