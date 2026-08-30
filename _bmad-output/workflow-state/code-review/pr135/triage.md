# PR 135 (DF3.3) — Review Round 7 Triage Ledger

Diff: origin/dev...HEAD (10 384 lines full; 5 132 code lines in 7 chunks; evidence/research/prior-review artifacts excluded).
Note: rounds 1–6 already landed (see git log; HEAD = `7f059f2` round 6). Every finding below was re-verified against current source; stale ones are reported as already-fixed, not re-patched.
**Ledger state: PRE-FIX SNAPSHOT.** The `class` column is the round-7 PLAN; final per-row outcomes live in `reports/fix-*.md` (round-7 sections) and their gate evidence.
Layers: blind-engine, blind-fleet, blind-pipeline, edge-pipeline, edge-tests-a, edge-tests-b, auditor. 0 failed layers.
Raw findings: 39 → 33 unique after cross-layer dedupe. patch 27 · defer 3 · dismiss 3 (dismissals verified against source before dropping).

## Cluster S1 — src/phase-engine/steering.ts + gates/library.ts (fixer: fix-engine; tests steering.test.ts ride along)

| # | sev | finding | class |
|---|-----|---------|-------|
| S1-1 | HIGH | directives accepted point-agnostically — `retry`/`select_roster`/`abort` pass schema at `run_end` and are returned to the runner (blind-engine) | patch: per-point allowlist before counting (run_end: proceed only, etc.) — FLAG behavior change |
| S1-2 | MED | `gate_ms` rounds the sum while siblings round each term → row can disagree by ±1 (blind-engine) | patch: derive gate_ms from rounded components — FLAG telemetry change |
| S1-3 | LOW | free-text directive fields (guidance/reason/note/rosterId/phase) unbounded — accepted strings ride promptContext for run lifetime (blind-engine) | patch: schema `.max()` ceilings |
| S1-4 | LOW | `renderPrompt` outside try/catch — malformed ctx throws through the "never throws" contract (blind-engine) | patch: wrap solicit body, degrade to PROCEED |
| S1-5 | LOW | `controller.telemetry` is the live mutable instance (blind-engine) | patch: snapshot accessor |
| S1-6 | MED | "accumulated-sum overflow" test actually trips the per-term guard — zero negative control for round-6 sum guard (edge-tests-a) | patch: recomment/rename test honestly; keep sum guard as defense-in-depth |
| S1-7 | INFO | fixture smoke leaves piped stderr undrained (edge-tests-a) | patch: drain stderr in Promise.all |
| S1-8 | LOW | degradation routes leave no countable telemetry trace (blind-engine) | DEFER — resident journal block is a closed key set (AC5); adding a counter is spec drift. Note in story |
| S1-9 | INFO | every schema rejection tripwired as `gate_bypass_attempt` (blind-engine) | DISMISS — documented closed-cause-union constraint; DF3.6 owns widening |
| S1-10 | MED | select_roster finished-phase target (blind-engine) — merged into S3-2 (fix at wiring layer) | see S3-2 |

## Cluster S2 — src/fleet/resident.ts (fixer: fix-fleet; tests/fleet ride along)

| # | sev | finding | class |
|---|-----|---------|-------|
| S2-1 | HIGH | stop()/external-signal SIGKILL skips session quarantine — only timeout branch quarantines; torn session reintroduced via the other signal path (blind-fleet) | patch: hoist quarantine to any signal death |
| S2-2 | MED | persistArtifact renames a pre-existing lax-mode `.tmp` — writeFileSync mode applies on create only (blind-fleet) | patch: rm/chmod tmp before write |
| S2-3 | MED | exitStatus() contract violated on refuse paths — prompt-too-big and spawn-ENOENT set `lastExit` with no process ever run (blind-fleet) | patch: leave lastExit untouched pre-spawn — FLAG behavior change |
| S2-4 | MED | unbounded stdout/stderr buffering — 128 KiB prompt guard only; looping pi exhausts memory before timeout (blind-fleet) | patch: byte cap → kill + classify |
| S2-5 | MED | no once-only enforcement per session path across startResident instances (blind-fleet) | patch: module-level live-session set, refuse second start |
| S2-6 | LOW | timeout discriminator inverts for timeoutMs ≤ 25 — every signal death classified "timed out" (blind-fleet) | patch: branch on timeoutMs > slack |
| S2-7 | LOW | raw Bun.spawn error rethrown outside redact chokepoint (blind-fleet) | patch: wrap message through redact |
| S2-8 | LOW | deliberate stop() recorded as exitStatus "transient" — indistinguishable from crash (blind-fleet) | patch: doc/comment (enum is CC-1, cannot widen) |
| S2-9 | INFO | empty/whitespace prompt spawns pi (blind-fleet) | patch: refuse pre-spawn (fail-safe) |
| S2-10 | INFO | timeout classification hinges on Bun signalCode; exitCode 137/signalCode null would miss quarantine (blind-fleet) | patch: treat 137 as signal death + test pin |
| S2-11 | INFO | child env allowlist omits CA-cert/locale vars (blind-fleet) | DEFER — deliberate minimal allowlist (S2-4 round 5); QDS_RESIDENT_ENV_PASSTHROUGH is the documented escape hatch |
| S2-12 | LOW | "no persistDir → nothing written" test asserts nothing about writes (edge-tests-a) | patch: dir-listing assertion |

## Cluster S3 — scripts/pipeline-run.ts (fixer: fix-pipeline; pipeline tests in wave 2)

| # | sev | finding | class |
|---|-----|---------|-------|
| S3-1 | MED | first signal during post-gate solicitation → one zombie retry: respawned command + phantom gate_fail row (blind-pipeline HIGH + edge-pipeline MED, merged; edge verified resolve-on-kill path at pipeline-run.ts:281-283) | patch: re-check bodyCtx.signal.aborted after solicitResident, before looping |
| S3-2 | MED | select_roster acceptable on non-dispatch/finished phases — phaseIds = all manifest phase names; structurally impossible picks counted accepted (blind-pipeline + blind-engine, merged) | patch: advertise only dispatch_task phase names; wiring-level reject — FLAG behavior change |
| S3-3 | LOW | journal resident block stale (zeros) at terminal-marker time for whole run_end window (edge-pipeline, verified) | patch: guarded refresh right after run.finish |
| S3-4 | LOW | thrown solicitation skips the resident_solicit observability line while spend stays counted (blind-pipeline + edge-pipeline, merged) | patch: emit line in catch with accepted:false |
| S3-5 | LOW | array nesting counts depth twice per level — effective cap ~16 not documented 32 (blind-pipeline) | patch: increment once per level |
| S3-6 | LOW | cumulative spendMicros on every resident_solicit line invites double-counting by consumers (blind-pipeline) | patch: document as cumulative (rename would break consumers) |
| S3-7 | LOW | duplicate manifest phase names make roster-pick routing ambiguous (first-match wins silently) (blind-pipeline) | patch: reject duplicate dispatch-phase names at arming — FLAG behavior change (verified: manifest.ts has no dup-name check) |
| S3-8 | INFO | dead try/catch around writeAll(1, banner) — comment contradicts callee-swallows-errors design (blind-pipeline) | patch: drop or fix comment |
| S3-9 | INFO | credential-scan comment overclaims ("armed or not") — --no-resident never reads the brief (blind-pipeline) | patch: qualify comment |
| S3-10 | INFO | stale rationale comment: neither overflow nor run.terminate writes the terminal marker (edge-pipeline, verified) | patch: reword |
| S3-11 | MED | closed-phase validation depends on undeclared excess property phaseIds (blind-pipeline) | DISMISS — verified false: `phaseIds` IS declared on the port at steering.ts:70 (`absent = empty set = reject`, fail-closed) |

## Wave 2 — test hardening (after source settles; fixer: fix-tests)

| # | sev | finding | class |
|---|-----|---------|-------|
| W2-1 | LOW | SIGINT test's kill backstop orphans hung fake-pi grandchild on regression (edge-tests-b) | patch: reap grandchild / kill process group |
| W2-2 | LOW | armedWorkspace mints two different requestIds for one run — contradicts e2e fixture convention (edge-tests-b) | patch: same UUID |
| W2-3 | INFO | toEqual ignores undefined-valued keys — "no resident block" not strictly pinned (edge-tests-b) | patch: closed-key assertion idiom |
| W2-4 | INFO | exit-poll runs before stdout/stderr drains in SIGINT test (edge-tests-b) | patch: start drains before poll |
| W2-5 | LOW | journaled exitStatus never parsed against CC-1 enum in any test (auditor; AC5 DOD) | patch: EXIT_STATUSES.includes assertion in demo/boundary leg |
| W2-6 | INFO | new pipeline-run legs keep "budget 120s > timeout 60s, no kill backstop" (edge-tests-b) | DEFER — pre-existing file-wide convention, not a regression; note in story |

## Story / close-out

| # | sev | finding | class |
|---|-----|---------|-------|
| C-1 | MED | resident slug sourcing is a pinned constant, not roster-driven — DOD bullet half-met, deviation ledger silent (auditor) | patch: deviation-ledger entry in story (SOURCE WINS; wave0-spec.md:129 re-specified the constant) |
| C-2 | INFO | AC1a "byte-identity" tested as deep-equality (auditor) | DISMISS — deliberate round-2 decision, documented in test comment |
| C-3 | — | append Review Findings (round 7) section + Status line to story | close-out step |
