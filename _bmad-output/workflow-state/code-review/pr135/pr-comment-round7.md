## Review round 7 — bmad-code-review (7-layer adversarial)

7 agents (3 blind / 3 edge-case / 1 spec auditor) reviewed the diff in 7 chunked slices (521–1175 lines each; evidence/research/prior-review artifacts excluded). **39 raw findings → 33 unique after cross-layer dedupe → 27 patched / 3 deferred / 3 dismissed.** Ledger: `_bmad-output/workflow-state/code-review/pr135/triage.md`; per-fixer reports under `.../pr135/reports/`. Landed as `d1b43b0`.

### Fixes

| # | Sev | Fix | Where |
|---|-----|-----|-------|
| S1-1 | HIGH | Per-point directive allowlist — `run_end` is proceed-only, `select_roster` only at run_start, `retry` only at post_gate_failure; off-point kinds fail closed via `reject()` before telemetry counts them | `src/phase-engine/steering.ts` |
| S2-1 | HIGH | Session quarantine hoisted to ANY signal death — stop()/external SIGKILL can tear the session jsonl mid-append too, not just timeout kills | `src/fleet/resident.ts` |
| S3-1 | MED | Abort re-check right after post-gate solicitation — closes the one-zombie-retry window (respawned command + phantom `gate_fail` row after `run.terminate`) | `scripts/pipeline-run.ts` |
| S3-2 | MED | `phaseIds` narrowed to dispatch_task phases + wiring-level recheck — picks naming code/finished phases now fail closed instead of accepted-never-consumed | `scripts/pipeline-run.ts` |
| S2-3 | MED | `exitStatus()` stays `null` on pre-spawn refusals (prompt-too-big, spawn-ENOENT) — no fabricated "logic" for a process that never ran | `src/fleet/resident.ts` |
| S2-4 | MED | Bounded stdout/stderr collectors (4 MiB / 1 MiB) — flood kills child, quarantines session, classifies "logic" | `src/fleet/resident.ts` |
| S2-5 | MED | Once-only session-path enforcement across `startResident` instances (module-level live set) | `src/fleet/resident.ts` |
| S2-2 | MED | `persistArtifact` removes stale lax-mode `.tmp` before write | `src/fleet/resident.ts` |
| S1-2 | MED | `gate_ms` derived from rounded components — row now internally consistent | `src/phase-engine/gates/library.ts` |
| S1-3 | LOW | Directive free-text fields capped (4k text / 256 id), over-ceiling fails closed | `src/phase-engine/steering.ts` |
| S1-4 | LOW | `renderPrompt` throw degrades to PROCEED — never-throws contract now total | `src/phase-engine/steering.ts` |
| S1-5 | LOW | `telemetry` handed out as snapshot, not the live mutable instance | `src/phase-engine/steering.ts` |
| S2-6/7/8/9/10 | LOW/INFO | Timeout discriminator gated on `timeoutMs > 25`; spawn error wrapped through `redact()`; "transient includes planned stop()" documented; empty prompt refused pre-spawn; exitCode 137 treated as signal death | `src/fleet/resident.ts` |
| S3-3/4 | LOW | Resident journal block refreshed right after `run.finish` (marker-time readers see real telemetry); thrown solicitation emits warn-level `resident_solicit` line with error field | `scripts/pipeline-run.ts` |
| S3-5/6/7 | LOW | Credential-scan depth charged once per level (pure-array chains were unguarded); cumulative `spendMicros` documented; duplicate dispatch-phase names disable roster steering fail-safe | `scripts/pipeline-run.ts` |
| S3-8/9/10 | INFO | Three stale/overclaiming comments corrected | `scripts/pipeline-run.ts` |
| S1-6/7, S2-12, W2-1..5 | MED→INFO | Test hardening: honest overflow-test naming, stderr drains, dir-listing assertion, SIGINT grandchild reap, closed-key journal pin, CC-1 enum assertion on journaled exitStatus, single requestId per armed workspace | `tests/` |
| C-1 | MED | Story deviation ledger #9: resident slug is a pinned constant (rate path IS roster-sourced) — story text now honest | story file |

Intentional behavior changes flagged by fixers and reconciled in wave-2 tests: off-point directive rejection, dispatch-only roster phases, quarantine-on-stop, `exitStatus: null` on pre-spawn refusal, ±0/1 `gate_ms` shift, dup-phase roster-steering disable.

### Deferred (3, with rationale)

- Degradation routes get no new telemetry counter — the resident journal block is AC5's closed key set; adding a field is spec drift (recorded in story).
- Child env allowlist stays minimal (no CA-cert/locale vars) — deliberate round-5 posture; `QDS_RESIDENT_ENV_PASSTHROUGH` is the documented escape hatch.
- pipeline-run.test.ts "budget 120s > timeout 60s" pattern — pre-existing file-wide convention, not a regression.

### False-positive pushback (dismissed after source verification)

- **"phaseIds is an undeclared excess property, silently ignored"** — false: it's declared on the port at `steering.ts:70` with `absent = empty set = reject` (fail-closed).
- **"every schema rejection tripwired as gate_bypass_attempt over-reports"** — documented closed-cause-union constraint; DF3.6 owns widening.
- **"AC1a byte-identity is only deep-equality"** — deliberate round-2 decision, documented in the test comment.

### Gates

- `bun test tests/phase-engine tests/fleet` → **1315 pass / 0 fail** / 16 todo (44 files)
- `bunx biome check` on all 9 touched source/test files → clean
- `bunx tsc --noEmit` → exit 0
- GitNexus `detect_changes` → changed symbols confined to this PR's own modules (pipeline-run, steering, resident, gates/library + their tests); no out-of-scope process affected
- Auditor: all 5 ACs implemented and pinned by tests with live negative controls; telemetry boundary intact

@coderabbitai please re-review the changes in `d1b43b0` (round-7 fixes above).
