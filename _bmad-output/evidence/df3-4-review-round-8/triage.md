# PR #150 — Triage Ledger (round 8)

~173 raw findings from 12 reviewers (10 blind, edge-tests-gate, auditor-spec) → deduped to 118 unique → 99 patch / 11 dismiss / 8 doc-deviation patches. `failed_layers`: edge-gate-core, edge-approvers-attach (429 rate-limit kill ×2; blind coverage exists for both chunks).

## DISMISSED (verified against source this session)

| # | Claim | Verdict |
|---|---|---|
| D1 | blind-approvers HIGH: allowlist-lock reclaim `break`s leaving unrepresentable lock, `ownIno=-1` | FALSE. After genuine reclaim (`rmSync(claimPath)`), flow continues to deadline check → sleep → loop-top `writeFileSync(lockPath, wx)` now succeeds and sets `ownIno`. Reviewer misread loop structure (`src/fleet/approvers.ts:515-536, 452-459`). |
| D2 | blind-approvers MED: `attachToRun` dereferences undefined record (`src/fleet/attach.ts:360`) | FALSE. `store.get` never returns undefined — `readRecord` throws a typed errno error for absent runs (`src/providers/run-record.ts:2388-2401`); CLI classifies off the code. |
| D3 | blind-fleet-providers MED: `enrol` resolves allowlist from cwd, silent wrong-root enrolment | Documented design (verbs.ts D9 comment: "a second way to name it is a second thing that can disagree"); success envelope prints absolute `allowlist` path (`scripts/fleet.ts:2929`). Residual risk noted in story. |
| D4 | blind-tests-e2e HIGH: T5.1 phases run `true` → reverify-command regression invisible | Documented test design (`tier5-gate-steering.live.test.ts:390-396`: budget-driven `phaseCount>=2` satisfaction; gate leg IS executed). Residual risk is generic to all e2e, not this PR. |
| D5 | blind-approvers MED: `release()` check-then-unlink race vs reclaimer | Reclaim requires age>10s AND dead pid; live releaser's pid is provably alive → reclaimer cannot rename. Ino+content fence correct. |
| D6 | blind-fleet-providers LOW: approval port "shed its lock" (`src/reverify/approval.ts:76`) | Serialization lives in the gate: `submitDecision`/`pauseRun`/resume all run under `withApprovalLock`. |
| D7 | auditor LOW: bundlePath not carried (AC1(a2)) | Deviation 8 already recorded in story. |
| D8 | auditor LOW: teardown seam unexercised by shipped caller | AC1(b) amendment already records this exact state. |
| D9 | auditor LOW: AC7 derive-only expiry in status | Deviation 9 already recorded. |
| D10 | auditor LOW: `index.ts` untouched, two extra verbs | Additive; no predecessor entry edited. |
| D11 | blind-tests-unit-a LOW: closed-fd fd-reuse race in test | In-process, deterministic-enough; flake risk < value of assertion. Comment note only. |

## DECISION-NEEDED → resolved conservatively (pre-authorized)

| # | Question | Resolution |
|---|---|---|
| DN1 | auditor HIGH AC6: attach host-leg writes box `/run/steering`, engine leg drains host `/run/steering` — two filesystems, round trip cannot close until DF1.10 in-box executor exists | **Document, don't redesign.** Record as Deviation 12 in story; fix the false operator remediation (`scripts/fleet.ts` no-ack arm: "check the resident agent is running" → state plainly no in-box executor exists yet; message IS queued box-side). DF1.10 owns the round trip. |
| DN2 | auditor MED: stranded `pausing` remediation circle (status says awaiting-approval; approve says "re-run once status reports awaiting-approval"; attach says "decide with approve") | **Render pausing distinctly + align remediations.** Status row for `pausing` gains its own label + remediation naming re-run of reverify; approve/attach refusal text for `pausing` names re-run reverify. |
| DN3 | auditor MED: paused run with live billing box renders `live`, hiding the strand INV-APPROVE-6 creates | **Approval-state override wins over box presence** (AC7: "each paused run appears with its state"). Fail-safe direction: surface the strand, keep box fields in row. |
| DN4 | auditor MED: driver hard-fail on no-sudo create / bounded-exec 1 MiB doubling / ledger migration — unrecorded scope expansion | **Record, don't revert** (deliberate commit 377f576 lineage). Story gains deviation entries. |
| DN5 | auditor MED: schemaVersion 2 vs spec-pinned 1; per-run configurable timeout unimplemented; `unlock` outside event set; INV-APPROVE-7 letter (pauseRun reads keyHash core fields) | All four: **record in story** (deviation/amendment notes). v2 + reserved-id already adopted by round 6; per-run timeout = follow-up feature work; unlock event + keyHash-read are letter-vs-intent gaps with intent intact. |

## PATCH CLUSTERS — Wave 1 (source, disjoint)

### F1 — `src/fleet/approval-gate.ts`
1. [HIGH] `withTeardownClaim` no deadline/max-age — live holder spins forever; recycled-pid claim unrecoverable (:1109-1140)
2. [HIGH] claim reclaim treats unwritten/empty file as dead holder — no age precondition (:1118)
3. [MED] `submitDecision` never `assertBundlePresent` — bundle deleted day 2, approve day 3 still binds (:1178+)
4. [MED] skipped promotion still returns `{outcome:"requested"}` (:1072-1081) — report state truthfully
5. [MED] `awaitDecision` clamps `pollMs` not `waitMs` — NaN/Infinity deadline never fires (:1352)
6. [MED] throw between lock `wx` create and content write strands unrecoverable empty lock (:186-193)
7. [LOW] dead `requestId` re-stamp in fresh-pause write (:990)
8. [LOW] ENOENT `continue` skips the sleep — busy-spin (:1133)
9. [LOW] `HEAD_SHA_RE` rejects uppercase hex — normalize case before validate (:533)
10. [LOW] failed cleanup after `linkSync` restore double-links inode (:278)
11. [LOW] atomic-restore EEXIST window contradicts stated invariant — correct the comment (:280)
12. [LOW] `historyOf` coerces non-strings with `String()` → `[object Object]` in audit trail (:690)

### F2 — `src/fleet/approvers.ts` + `src/fleet/attach.ts`
13. [MED] lock content unparseable → never reclaimable even past stale window (approvers:489-492) — mirror gate's unreadable-holder door
14. [MED] stdin stream error rejects untyped → exit 1 "retry me" for durable fault (approvers:833)
15. [MED] enrol write not fsynced before rename — crash lands zero-length allowlist (approvers:713)
16. [LOW] reclaim arm depends on `readGuardedFile` exposing `path` on failure arm (approvers:666)
17. [LOW] `ceilingMs:0` + unreachable look reports `no-ack` ("message IS queued") (attach:435)
18. [LOW] `readInboxTail` ignores short reads — zero-fill corrupts newest lines (attach:269)
19. [LOW] zod error text interpolated into refusals — content echo (approvers:315, :693)
20. [LOW] `drain()` ignores per-line `runId` — foreign lines consumed as own intent (attach:404, :498)

### F3 — `src/fleet/verbs.ts` + `src/fleet/status.ts` + `src/phase-engine/steering.ts`
21. [MED] `pausing` renders `awaiting-approval`, no countdown, remediation circle (status:509-545) — with DN2
22. [MED] live-box override hides paused strand (status rowForRecord) — with DN3
23. [MED] drain per-call 5s deadline, no aggregate bound — 400 msgs × stall = wedge (steering:527)
24. [LOW] two clock reads in `approvalRowFields` can disagree (status:576)
25. [LOW] `attach-acked` printed for message no resident saw — add provenance note (steering:640)
26. [LOW] `listVerbs` docstring omits `enrol` (verbs:63)

### F4 — `src/providers/run-record.ts` + `src/providers/bounded-exec.ts` + `src/providers/exedev/driver.ts`
27. [MED] shed note echoes raw dropped values to stderr before secret scan (run-record:798, :975)
28. [MED] retired-field migration bypasses assertKind/assertNoSecret → later rebind bricks run (:979)
29. [MED] strings kind admits empty-string elements (:748)
30. [MED] steering provisioned only at create — substrate re-created box never re-provisioned (driver:257) — self-heal retry on send-fail
31. [LOW] shared exec default cap doubled 512KiB→1MiB for all consumers (bounded-exec:42) — restore default if attach passes explicit cap

### F5 — `src/reverify/runner.ts` + `scripts/fleet.ts` + `scripts/pipeline-run.ts` + `scripts/lib/cost-ledger-opts.ts`
32. [MED] approval pre-read sits outside the requestApproval catch (runner:446) — throws past typed outcome
33. [MED] `onInboxError` stringifies Error → `{}` (pipeline-run:1733) — use message
34. [MED] unawaited `tracer.trace` rejection escapes containment (:1727)
35. [MED] `forced` audit flag lies on `changed` unlock outcome (fleet:3039)
36. [MED] attach remediation asserts "box torn down" for unenumerated states (fleet:3183)
37. [MED] catch-all no-ack remediation asserts "IS queued" for unknown reasons (fleet:3219) — merged with DN1 text fix
38. [LOW] `boundState` "absent" claimed on failed read (fleet:2718)
39. [LOW] one throwing sink permanently silences gate events (fleet:2615)
40. [LOW] `...fields` spread can clobber computed truthfulness fields (fleet:2633)
41. [LOW] decided line/gateEvent omit `reason` (INV-APPROVE-4 letter) — add capped reason
42. [LOW] ledger migration failure silent (cost-ledger-opts:272) + shadowed `tmp` (:255)

## Wave 2 — tests (after source settles)

### T-A `tests/fleet/approval-gate.test.ts`
- [MED] spinner children leak on failure path (:1815); submitDecision concurrency test can't fail cross-process (:539); EPERM arm skipped on root CI (:967); requestApproval missing-run untested (:86); in-range timeoutMs branch only at floor (:162); withTeardownClaim loop untested; reclaim `changed` branch untested; emitPause raising-sink untested; sweepExpired pausing/absent + awaitDecision absent untested
- [LOW] loose error regexes (:187,376,412,897,1577); JSON round-trip vacuous (:1479); surrogate parity (:1476); empty-bound-id outcome discarded (:1668); duplicate pausing pins (:284/:320); key-set literal duplicated (:2194); ERROR_LINE_KEYS comment (:2000); wall-clock duration (:2058); `lines[0]` before length (:2074); coverage-delegation header (:963); schemaVersion v1 fixtures (:249, :694); readiness poll 4s (:1067); clamp exact boundaries; reject-then-approve; claim release on teardown throw; garbage state string

### T-B `tests/fleet/gate-verbs.test.ts` + `tests/fleet/cli.test.ts`
- [MED] CC-9 no planted needle (:1087); positive control ignores sink/stderr (:290); reject-no-PR zero negative asserts (:371); approve-no-driver assert-only (:102); attach no-dir single-path (:719); decision-line agreement unfalsifiable (:485 — note limitation); D2 stdin success path missing (:1287); no-ack pinned on failed-cat only (:981)
- [LOW] execDriver content-blind (:753); ceiling boundaries (:441); expiry boundary (:572); duplicate exit-code-only (:127,:713); truncation impl-shape (:459); regex-union drops (:1136); D7 layout dup (:1269); flaky-store copy-paste (:521,:839,:1474); /token/i fragile (:283); subprocess inherits repo .env (:1189 — scrub QDS_*); D9 fd leak (:1657); cli.test schemaVersion double (:1540)

### T-C `tests/fleet/approvers.test.ts` + fixtures + `tests/fleet/verbs.test.ts` + `tests/fleet/attach.test.ts`
- [HIGH] enrol absent-`.factory` arm untested + contradicting comment (approvers.test:982); registry snapshot dead data — enrol/unlock unpinned (verbs.test:641); INV-APPROVE-5 negative control can't detect non-delivery (attach.test:335)
- [MED] hash-shape conflation (:629); scrypt exact boundary (:931); BOM invisible (:648); bob fixture unasserted (fixtures/approvers.json); dir-mode write-bit-absent (:257); vacuous cap-guard (test-results:361); argue-here self-violation (verbs.test:1973); attach 20s opaque timeout (attach.test:321); auth-failure exit unobserved (verbs probes); success probes assert stdout not record; FleetError regex non-literal (:272)
- [LOW] 0400 mode; drip bounds (:528); stale-lock pid recycle (:1141); streamOf dup (:491,:694); mode-ordering unfalsifiable (:161); non-default-N vacuous (:903); ancestor message (:205); ARGUED_EXEMPTION proof (:311); ack-window dup constant (attach:569); drift-guard behaviour (:575); async `before` await contract; messageId ceiling boundary (steering.test:1306); fold-budget ratio (:969); ack-retry terminal (:1020); duplicated key-set (verbs:411); kdf pin (:1366); untilQueued bare newline (attach:159)

### T-D `tests/providers/*` + `tests/reverify/*`
- [HIGH] provisioning target never asserted (driver.test:131); interceptor miss shells sudo line to host (fake-exedev:469 — fail closed)
- [MED] verification as script text (:147); provisioning failure no behavioral coverage (:129); bounded-exec title `>=` vs `toBe` (:81); lock test proves throw not property (approval.test:290); rebind history unasserted (:355); `approval: undefined` may select mock (runner.test:473,495); harness bundle rewires all tests (:79)
- [LOW] substring dispatch (:469); stderr not surfaced (:171); loose ls prefix (:160); `as never` inconsistency (run-record:380); error index [0] (:465); shape boundary (:409); comment outcome claim (approval:62); hollow bundle (:339)

### T-E `tests/fleet/e2e/*` + `tests/phase-engine/*`
- [HIGH] D8 `finally` bare `revokeQuietly` (tier1-approval:658) — wrap like T1.7
- [MED] D8 no key-hash delta (:647); T5.1 reverify no timeout + leg-sum overrun (tier5:428); runFleetWithToken drains unbounded (live-harness:242); D6 precondition weaker than requirement (tier1-teardown:199); auth-refusal leg never live (tier1-approval table); T5.1 tamper — porcelain not exact (:281); T5.1 no post-finally box-absence (:567)
- [LOW] envelope bare JSON.parse (:75 etc.); message ceiling allowed side (:207); empty requestId (:221); probe id dead (:144); token chmod unasserted (:173); D6 writeEvidence unguarded (:225); T1.8 four-reasons + double-delivery untested (:37); T5.1 engine retry burns double spend on any failure (:267)

## Doc patches (close, by lead)
- Story: Deviation 12 (AC6 two-filesystem split, DF1.10 owns round trip), schemaVersion-2 note, per-run timeout follow-up, scope-expansion entries (driver sudo gate, bounded-exec cap, ledger migration), `unlock` event addition, INV-APPROVE-7 letter note, enrol cwd residual-risk note.
