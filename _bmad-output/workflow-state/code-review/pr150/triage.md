# PR #150 — bmad-code-review round 7 triage (2026-08-29)

Layers: blind ×6 (gate, approvers-attach, cli, engine, tests-gate, tests-gate-verbs), edge ×4 (gate, approvers-attach, cli, engine), auditor ×1. All 11 reported. Raw reports: `reports/*.md`.

Legend: id — severity — title — source(s) — bucket — fix cluster.

## PATCH — source

| # | Sev | Finding | Sources | Cluster |
|---|-----|---------|---------|---------|
| 1 | HIGH | withApprovalLock acquire-side reclaim reintroduces rename-vacancy race (restore branch leaves lockPath vacant; new inode defeats B's fenced release) | blind-gate | A |
| 2 | HIGH | `pausing` resume arm unreachable in production — runner mints fresh reverifyId per retry, gate requires byte-equal reportId → crashed pause strands run forever; resume also never restamps requestedAt/expiresAt and skips assertBundlePresent | blind-gate + edge-gate + edge-engine | A (gate) + G (runner) |
| 3 | MEDIUM | `enrolApprover` read-modify-write race silently drops concurrent enrolment (no lock) | blind-approvers + edge-approvers | B |
| 4 | MEDIUM | scrypt N/r ceilings permit ~4 GiB verify allocation; `scryptSync` throw escapes untyped → classified transient/exit 1 instead of fail-closed refusal | blind-approvers + edge-approvers | B |
| 5 | MEDIUM | `approvalRowFields` re-derives expiry inline instead of using imported `expiredState` (NaN/boundary divergence; the drift class the change claims to eliminate) | blind-cli + edge-cli | F |
| 6 | MEDIUM | approve/reject construct writable store pre-authentication when `--dir` omitted (comment claims post-auth) | blind-cli + edge-cli | F |
| 7 | MEDIUM | `onInboxError` payload `JSON.stringify(e)` = `{}` for real Errors — operational fault invisible | blind-cli | D |
| 8 | MEDIUM | attach length guard checks raw `message.length` vs `DIRECTIVE_TEXT_CHAR_CEILING`; fold truncates post-sanitize at `ATTACH_MESSAGE_CHAR_CEILING` — escape-heavy ≤4000-char messages silently truncated; constants decoupled by design | edge-approvers + edge-engine | C (lib) + F (CLI check scripts/fleet.ts:2905) |
| 9 | MEDIUM | awaited `onInboxError` observer has no deadline — hung async observer wedges serialized solicit chain | edge-engine | D |
| 10 | MEDIUM | fault dedupe latch (`lastPushedFault`) never resets on recovery — same fault after healthy interval never re-reported | blind-engine + edge-engine | D |
| 11 | HIGH | `--rotate` is a dead flag on `fleet enrol` — parsed, never read; rotation impossible; remediations telling user to pass it are unactionable. Seam `FleetDeps.enrol` can't express rotate either | edge-cli | F |
| 12 | MEDIUM | Deviation 8's substitute bundle guard is dead code — no production caller passes `bundleDir`, so `assertBundlePresent` early-returns; Dev Agent Record justification factually wrong | auditor | G (+story text) |
| 13 | LOW | resume path skips `assertBundlePresent` (third unchecked route to decidable state) | blind-gate + edge-gate | A (with #2) |
| 14 | LOW | `reclaimApprovalLock` returns `absent` when a successor replaced the lock under it | blind-gate | A |
| 15 | LOW | EEXIST branch swallows non-`claimed` errors (EACCES/EMFILE) as retry → misattributed "held for over 5000ms" | blind-gate | A |
| 16 | LOW | `awaitDecision` accepts `pollMs: 0`/negative → busy-spin up to 24h default | blind-gate + edge-gate | A |
| 17 | LOW | concurrent same-reportId resumes run `deps.teardown` concurrently; `pullArtifacts` races on fixed shared host paths | edge-gate | A |
| 18 | LOW | persisted timeout `decidedAt` (notice-time) vs derived (`expiresAt`) disagree | edge-gate | A |
| 19 | LOW | `readAck` dereferences parsed row outside try — a literal `null` line throws uncaught TypeError | blind-approvers | C |
| 20 | LOW | over-ceiling message throws bare Error classified transient/exit-1 "retry me" — permanent failure | blind-approvers | C (with #8) |
| 21 | LOW | acks file mode 0o600 applies only at creation; pre-existing lax acks file never chmodded (inbox leg does chmod) | blind-approvers | C |
| 22 | LOW | ack poll re-reads entire ever-growing acks file every 500ms tick, no cap (inbox leg has 1 MiB cap) | edge-approvers | C |
| 23 | LOW | ack retry records the *current* solicitation's SteeringPoint, not the fold-time point | blind-engine | D |
| 24 | LOW | retired-field migration at 256-cap sheds the migrated id itself (drop-oldest = head = legacy scalar) | blind-engine | E |
| 25 | LOW | head-fold ordering inverts under mixed-version writers (rolling upgrade re-creates retired scalar) | blind-engine | E |
| 26 | LOW | `--dir ""` guard is unreachable dead code (parseValueFlags rejects empty values earlier); comment premise false | edge-cli | F |
| 27 | LOW | `GATE_OK_OUTCOMES` gateEvent logs `status:"ok"` for invocations that exit 6 (event fires before reportCompletion result known) | blind-cli | F |

## PATCH — tests (folded into owning cluster)

| # | Sev | Finding | Sources | Cluster |
|---|-----|---------|---------|---------|
| 28 | MEDIUM | EPERM liveness test vacuous as root / user-owned pidns — never asserts the EPERM precondition | blind-tests-gate | A |
| 29 | MEDIUM | `pausing` fixtures omit timestamps; resume promotion never asserts `expiresAt` | blind-tests-gate | A (with #2) |
| 30 | MEDIUM | error-path log lines' field set unpinned (`toMatchObject` tolerates extra keys) — only success line pinned | blind-tests-gate | A |
| 31 | MEDIUM | cross-process rebind race test can't reliably produce its interleaving (no injected yield) | blind-tests-gate | A |
| 32 | LOW | two refusal paths (report-changed, bundle-gone) lack byte-identity assertion their siblings have | blind-tests-gate | A |
| 33 | LOW | `expect(line.duration).toBe(Number(line.durationMs))` near-tautology | blind-tests-gate | A |
| 34 | MEDIUM | needle scan omits persisted run record; comment falsely claims store channel covered | blind-tests-verbs | F |
| 35 | MEDIUM | real-token subprocess streams (D9 enrol/approve) never scanned for the token | blind-tests-verbs | F |
| 36 | LOW | D7 absent-run approve spawns with unread/unasserted stdout | blind-tests-verbs | F |

## DECISION-NEEDED → resolved conservative (pre-authorized)

| # | Finding | Resolution |
|---|---------|-----------|
| 37 | [LOW] `fleet status` shows `pausing` rows as `awaiting-approval` without time-remaining — deviates from AC7's letter (auditor) | **Keep display, document as deviation.** Conservative: no observable-behavior change on a display surface already shipped and live-tested; the code comment's reasoning (pausing never expires, countdown meaningless) is sound. Record as Deviation 11 in story + report. |
| 12 | bundle guard: wire vs correct-the-record | **Wire it** (fail-closed enforcement matches AC1(a2) intent; bundle provably exists after green report). If wiring proves unsafe, fixer falls back to correcting the record text and flags it. |

## DISMISSED (verified against source)

| # | Finding | Evidence |
|---|---------|----------|
| D1 | attachToRun assumes `store.get` never returns undefined (blind-approvers, contingent) | `RunRecordStore.get` throws typed ENOENT on absence (run-record.ts:2417-2430); `assertRunExists` guards before `attachToRun`. False positive. |
| D2 | no TTY guard on token stdin read (blind-cli, contingent) | `assertTokenAttached` refuses TTY/chardev/closed fd 0 with `approver-token-absent` exit 5 (approvers.ts:491-508). False positive. |
| D3 | fold-loop head-of-line blocker if PROMPT_CHAR_CEILING < ~8548 (blind-engine, conditional) | `PROMPT_CHAR_CEILING = 16_000` (steering.ts:21) → fold budget 8,000 > max line ~4,274. Premise false. |
| D4 | token-refusal leak proven only against fake message (blind-tests-verbs HIGH) | Library-level coverage exists: tests/fleet/approvers.test.ts:383-384 asserts production `authenticateApprover` refusal message+remediation never contain the presented token. Residual CLI-relay coverage gap is folded into #35 (real-token subprocess stream scan). |

## Cross-cluster contracts (fixed here so parallel fixers don't diverge)

- **#2 (A+G):** Gate side (A): on resume from `pausing`, restamp `requestedAt`/`expiresAt` fresh, run `assertBundlePresent` before promotion. Runner side (G): when the run record already holds a `pausing` (or `awaiting-approval`) approval extension bound to a `reportId`, re-present that bound reportId instead of minting a fresh reverifyId, so the resume arm is reachable. Add/adjust tests on both sides.
- **#8 (C+F):** C fixes the library guard in attach.ts (measure post-sanitize length against `ATTACH_MESSAGE_CHAR_CEILING`, typed refusal arm). F aligns the CLI pre-check at scripts/fleet.ts:~2905 to the same rule so the CLI refusal message stays truthful.
- **#12 (G):** G wires `bundleDir` in `recordApprovalPort` (`src/reverify/approval.ts`) and updates the story Dev Agent Record Deviation 8 text; fallback = correct record text only.

## Fix clusters (disjoint file sets)

- **A**: `src/fleet/approval-gate.ts`, `tests/fleet/approval-gate.test.ts` — findings 1,2(gate),13,14,15,16,17,18,28-33
- **B**: `src/fleet/approvers.ts`, `tests/fleet/approvers.test.ts` — 3,4 (+ regression test for `__proto__` enrol, edge-approvers LOW folded in: enrolApprover("__proto__") returns ok but writes nothing)
- **C**: `src/fleet/attach.ts`, `tests/fleet/attach.test.ts` — 8(lib),19,20,21,22
- **D**: `src/phase-engine/steering.ts`, `scripts/pipeline-run.ts`, `tests/phase-engine/steering.test.ts` — 7,9,10,23
- **E**: `src/providers/run-record.ts`, `tests/providers/run-record.test.ts` — 24,25
- **F**: `scripts/fleet.ts`, `src/fleet/verbs.ts`, `src/fleet/status.ts`, `tests/fleet/gate-verbs.test.ts`, `tests/fleet/cli.test.ts` — 5,6,8(cli),11,26,27,34,35,36
- **G**: `src/reverify/runner.ts`, `src/reverify/approval.ts`, `tests/reverify/` — 2(runner),12 + story Dev Record text for deviation 8/11

Note: one extra LOW from edge-approvers folded into cluster B: `enrolApprover("__proto__")` silent no-write (assigns through inherited `__proto__` setter; JSON.stringify drops it; verb reports success for an entry that can never authenticate).
