# PR 135 (DF3.3) — Review Round 5 Triage Ledger

Diff: origin/dev...HEAD (8305 lines, 37 files; evidence/research artifacts excluded).
Note: rounds 2–4 already landed (see git log). Every finding below MUST be re-verified against current source — earlier rounds may already have fixed it. Stale findings are reported as already-fixed, not re-patched.
Layers: blind-engine, blind-fleet, blind-pipeline, edge-pipeline, edge-tests-a, edge-tests-b, auditor. 0 failed layers.
Raw findings: 73 → ~50 unique after dedupe. patch ~35 · defer 1 · dismiss-candidates ~12 (verify-first).

## Cluster S1 — src/phase-engine/steering.ts + journal.ts (fixer: fix-engine)

| # | sev | finding | class |
|---|-----|---------|-------|
| S1-1 | MED | meter(): deps.rate never clamped — NaN/Infinity rate poisons spendMicros | patch |
| S1-2 | LOW | concurrent solicit() races telemetry/status — no serialization | patch (serialize) |
| S1-3 | LOW | malformedCorrectionPrompt drops SteeringPoint + promptContext | patch |
| S1-4 | LOW | lastDegradationReason sanitized read-side only — sanitize at write | patch |
| S1-5 | MED | select_roster.phase never validated — fail-closed hole | patch (closed phase set in ctx; S3 wires it) |
| S1-6 | MED | steeringIterations inflated by run_end retry reply (auditor, AC5) | patch (with S3) |
| S1-7 | LOW | AC2 tripwire detail omits action name for unknown-field rejections | patch |
| S1-8 | LOW | successor seam comments claimed in Dev Agent Record absent in solicit | patch (add seam comments) |
| S1-9 | LOW | meter(reply.usage) outside try — usage-less reply throws vs never-throws contract | patch |
| S1-10 | LOW | journal doc: "present on every settled run" vs optional mechanism | patch (doc) |
| S1-11 | MED | writeResident once-only unenforced | DISMISS? verify seed+refresh is deliberate |
| S1-12 | LOW | ResidentStatus exports states module never produces | DISMISS? verify vs journal contract (disabled fabricated by caller) |
| S1-13 | LOW | flush() in writeResident redundant vs finish() | DISMISS? verify flush semantics |
| S1-14 | HIGH | per-term Math.round "zeroes spend" + µ$-vs-$ unit ambiguity | DISMISS? verify rates are µ$/MTok (toMicrosPerMTok) and per-term round is spec'd exact arithmetic (edge-tests-b grounded: 276 = 3×92 per-term) |

## Cluster S2 — src/fleet/resident.ts (fixer: fix-fleet)

| # | sev | finding | class |
|---|-----|---------|-------|
| S2-1 | HIGH | pi --session jsonl unredacted on disk; pre-existing sessionDir keeps lax perms | patch (chmod dir 0700 unconditionally best-effort + session file 0600 post-call) |
| S2-2 | MED | brief as -p argv: ps-visible, E2BIG unguarded | patch (size guard; doc note) |
| S2-3 | MED | every non-zero exit classified "logic" — transient 429/5xx misclassified | patch (stderr/exit-pattern classification) |
| S2-4 | MED | child inherits entire process.env | patch (minimal allowlist — conservative; FLAG behavior change) |
| S2-5 | LOW | concurrent call() clobbers current, corrupts session file | patch (in-flight guard) |
| S2-6 | LOW | SIGKILL-on-timeout tears session jsonl → later calls degrade | patch (quarantine session file after timeout-kill) |
| S2-7 | LOW | timeout death indistinguishable from stop()/external kill | patch |
| S2-8 | LOW | stream-read failure orphans child, disarms stop() | patch (kill in catch) |
| S2-9 | LOW | briefIsEmpty(0/false/42) → false → spawns | patch (non-string/non-object = empty) |
| S2-10 | LOW | reply-persist failure console.error bypasses redact chokepoint | patch |
| S2-11 | LOW | empty/malformed harvest (exit 0, no message_end) returns "success" | patch (classify non-success; verify demo unaffected) |
| S2-12 | LOW | stderr of successful call discarded | patch (redacted warning line) |
| S2-13 | LOW | non-atomic artifact writes | patch (tmp+rename) |
| S2-14 | LOW | best-effort reply persistence weaker than §5.2 contract | patch — fail-closed: persist failure → throw → steering degrades (FLAG behavior change) |
| S2-15 | LOW | header comment claims barrel import; imports steering.ts directly | patch (comment) |
| S2-16 | MED | harvestPiStream imported from cli-anything/scripts driver via barrel | DISMISS? verify team-lead-driver.ts import-safe main guard |
| S2-17 | LOW | runId uniqueness unguarded | DISMISS? verify runId unique upstream |
| S2-18 | LOW | _rateSources module-global test seam in public API | DISMISS? verify documented private seam |
| S2-19 | LOW | stop() one-way latch even with no in-flight call | DISMISS? verify stop only at terminal cleanup |
| S2-20 | LOW | no cwd on spawn | DEFER (speculative pi config resolution) |

## Cluster S3 — scripts/pipeline-run.ts (+ gates/library.ts) (fixer: fix-pipeline)

| # | sev | finding | class |
|---|-----|---------|-------|
| S3-1 | HIGH | second signal post-settlement exits 2 with marker on disk | patch (runSettled guard) — CHECK round-4 commit first |
| S3-2 | HIGH | resident-block seed after walkPhases — timeout marker precedes block | patch (seed before walkPhases) |
| S3-3 | HIGH | no try/finally: throw orphans pi child, skips block writes; orphan solicitation overlaps run_end | patch (try/finally + abort checks) |
| S3-4 | MED | run_end solicitation on terminated runs; first signal never stops resident | patch — round 4 partially addressed; verify remainder |
| S3-5 | MED | retries share ONE maxDurationMs timer vs DF1.3 per-attempt; "mirrored" comment + wrong path ref | patch (comment/doc + drift note; keep fail-closed shared timer) |
| S3-6 | MED | accepted retry guidance functionally inert; docstring overclaims | patch (docstring fix, execution-neutral) |
| S3-7 | MED | double-retry composition risk body-loop × engine retry; abort overridden | patch VERIFY-FIRST vs agents/retry.ts + walkPhases |
| S3-8 | MED | closedRosterIds role.name vs rosterId identity | patch VERIFY-FIRST vs roster schema |
| S3-9 | MED | --no-resident leg ≠ pre-diff flow for testCommand phases | DISMISS? verify "composition gated" claim |
| S3-10 | MED | select_roster at post_gate/run_end dropped but counted accepted; cross-roster union; phase ignored | patch (rosterIds only at run_start; per-phase match; trace unconsumed) |
| S3-11 | MED | exitStatus() awaited before stop(), unbounded | patch (stop first / bounded) |
| S3-12 | LOW | rosterChoice.pending never consumed/recorded | patch (trace/warn) |
| S3-13 | LOW | trace phaseId keyspace inconsistent | patch |
| S3-14 | LOW | void onSignal — run.terminate throw unhandled | patch (try/catch) |
| S3-15 | LOW | run_end directive + run_start select_roster leave no trace row | patch (trace rows) |
| S3-16 | LOW | writeAll: EAGAIN drops tail; 0-byte write spins | patch (break on 0, bounded, counter) |
| S3-17 | LOW | code-phase gate events lack gate_ms | patch (owning file may be gates/library.ts) |
| S3-18 | LOW | credential scan unbounded recursion → RangeError refusal | patch (depth cap) |
| S3-19 | LOW | credential refusal gated on arming/identity | patch (scan any parsed brief, fail-safe) |
| S3-20 | LOW | run_start abort exit code / Run.finish empty semantics | DISMISS (auditor verified journal.ts ok=false) |
| S3-21 | LOW | tokenizer/parseValueFlags grammar split | DISMISS (edge-pipeline verified parity) |

## Wave 2 — test hardening

### T1 — tests/phase-engine/steering.test.ts + tests/fleet/** (fixer: fix-tests-a)
- MED truncation-boundary tests at exactly 16000/budget±1 + surrogate-cut coverage
- MED stderr redact-then-slice(-400) — add fake-pi secret-in-stderr mode + test
- MED piEnv scrub misses QDS_RESIDENT_TIMEOUT_MS/QDS_PI_BIN
- MED concurrent call() rejection test (after S2-5)
- LOW redundant toBe(2) pin; LOW slug-shape edges (no-slash, 3-part)
- DISMISS: fake-pi NDJSON decoy fidelity (offline-unverifiable; still guards message_end-only rule)
- Re-pin expectations broken by S1/S2 behavior changes (fixers flag them)

### T2 — tests/phase-engine/resident-e2e.test.ts + pipeline-run.test.ts + usage.test.ts + fixtures (fixer: fix-tests-b)
- MED vacuous redaction assertion — fixture must echo probe into artifact content
- MED no e2e abort-directive coverage (both sites)
- LOW usage.test.ts steering pin = bare occurrence count → strengthen
- LOW accepted select_roster path untested (dispatch_task fixture leg)
- LOW SIGINT e2e 15s wall-clock flake → poll-based bound
- LOW fake-resident missing -p falls through → exit immediately
- Re-pins from S3/S2-14 behavior changes

## Decision-needed resolutions (pre-authorized fail-safe/conservative)
- S2-4 env → minimal allowlist (least privilege), wave-2 pins flagged
- S2-14 reply persistence failure → fail-closed (degrade; directive never executed unpersisted) per §5.2
- S3-5 shared timer → keep fail-closed shared timer; fix false "mirrored" comment + story drift note
- S3-6 retry guidance → docstring fix only; no injection into retried command
