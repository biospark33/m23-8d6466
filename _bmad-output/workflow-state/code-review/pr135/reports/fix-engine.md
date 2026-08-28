# Fix Report — Cluster S1 (steering.ts + journal.ts), PR 135 round 5

Fixer: fix-engine. Branch: feature/df3-3-resident-orchestrator-agent.
Scope: `src/phase-engine/steering.ts`, `src/phase-engine/journal.ts`, `tests/phase-engine/steering.test.ts` (one re-pin only). No other files touched.

Impact analysis (gitnexus CLI, `node .gitnexus/run.cjs impact <sym> --repo QDS-Factory`, direction upstream):
- `createSteering`: **LOW** — 1 direct caller (`scripts/pipeline-run.ts:main`), 1 affected process.
- `writeResident`: **LOW** — 1 direct caller (`scripts/pipeline-run.ts:main`).
No HIGH/CRITICAL warnings.

## Verdict table

| # | sev | verdict | evidence |
|---|-----|---------|----------|
| S1-1 | MED | **patched** | steering.ts meter rewrite (now ~steering.ts:232-244): rate clamped once at controller creation via `clampTerm` (`typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0`, same style as the old usage clamp); NaN/Infinity/negative rate meters as 0 instead of poisoning `spendMicros`. |
| S1-2 | LOW | **patched** | steering.ts:~290-300 — promise-chain mutex in `createSteering`: `solicit` queues on `chain.then(() => solicitSerialized(...))`; telemetry/status mutations and caller calls can no longer interleave. Chain cannot wedge because solicit never throws (trailing `.catch` is belt-and-braces). |
| S1-3 | LOW | **patched** | steering.ts:~169-187 — `malformedCorrectionPrompt(reason, point, ctx)` now emits `Steering point: <point>.` + tail-truncated `promptContext` + harness-only correction body + restated union. Ceiling intact: header+body+joiner reserved before the cut, same discipline as `renderPrompt`; suffix reserved inside the budget. Model's own reply still never interpolated (INV-2). |
| S1-4 | LOW | **patched** | steering.ts — both degradation writes now `sanitizeForMessage(...)` at write (caller-throw path ~:319, malformed-limit path ~:338); getter simplified to return the stored value, interface doc updated "sanitized at read" → "sanitized at write" (steering.ts:104-113). Existing pin `spawn ENOENT\n` → `"spawn ENOENT\\n"` still passes. |
| S1-5 | MED | **patched** | `SolicitCtx.phaseIds?: readonly string[]` added (steering.ts:70); select_roster phase validated fail-closed exactly like rosterIds: absent = empty set = reject, detail `phase outside closed phase set: <phase>` (steering.ts:~339-347). Field name `phaseIds` per coordination with fix-pipeline, which wires the ctx side. |
| S1-6 | MED | **patched** | steering.ts:355 — `steeringIterations[ctx.phase]` now increments only when `directive.action === "retry" && point === "post_gate_failure" && ctx.phase !== undefined`. A retry accepted at run_start/run_end still counts in `directives` (unchanged) but no longer inflates the per-phase counter (AC5). Telemetry field doc updated (steering.ts:90-92). |
| S1-7 | LOW | **patched** | steering.ts:~197-210 — `rejectionDetail` now returns `action <name> rejected: <issue>` when a KNOWN action carries an unknown field; unknown-action route unchanged (`unrecognized action: <name>`). Both routes sanitize. |
| S1-8 | LOW | **patched** | Named seam comments added inside solicit in the Dev-Agent-Record order: `SEAM DF3.6: checkBounds(point)` pre-render → `SEAM DF3.4: drain inbox` pre-render → render → call → parse → `SEAM DF3.4: ack` pre-return (steering.ts:~304-358). |
| S1-9 | LOW | **patched** | meter now accepts `{ inputTokens?: unknown; outputTokens?: unknown } \| undefined` and clamps non-number/non-finite/negative to 0 — a caller resolving `{raw}` with no `usage` meters zero instead of throwing (steering.ts:~232-244). Never-throws contract holds. |
| S1-10 | LOW | **patched (doc)** | journal.ts:76-86 — `resident?` doc now states the real guarantee: optional on the file (the PhaseJournal port knows nothing about the resident); presence is a pipeline-runner guarantee — seeded (`status:"disabled"` when unarmed) before the terminal marker can exist, refreshed after run-end solicitation. |
| S1-11 | MED | **dismissed (false-positive), doc added** | Double `writeResident` is deliberate by design: `scripts/pipeline-run.ts:1597` seeds pre-finish, `:1639` refreshes post-finish; story patch ledger item (4) records exactly this ("a pre-seed writeResident lands before finish and a final refresh follows the run-end solicitation"). Once-only enforcement would break the seed+refresh design. `writeResident` doc (journal.ts:125-130) now states it is deliberately twice-callable, later call replaces earlier. |
| S1-12 | LOW | **dismissed (false-positive)** | The union is shared with the journal contract by spec: story AC5 (`stories/df3-3-resident-orchestrator-agent.md:92-100`) requires journal `resident.status` ∈ `"active"\|"degraded"\|"disabled"\|"stopped"` with `stopped` written only by DF3.6 and `disabled` seeded by the caller — `scripts/pipeline-run.ts:1573-1583` fabricates exactly that block (`status: "disabled"`, zeroed counters) when no resident is armed. Narrowing the union would break the journal contract. |
| S1-13 | LOW | **dismissed (verified harmless)** | `flush()` (journal.ts:145-180) is the same synchronous temp+fsync+rename full-rewrite every op performs (the premise in the finding). The seed flush is what makes the resident block durable before `finish()`'s terminal marker — load-bearing, not redundant. Noted in the writeResident doc. |
| S1-14 | HIGH | **dismissed (false-positive)** | Rates reaching meter are integer µ$/MTok: `toMicrosPerMTok` (src/phase-engine/roster/validate.ts:214-224) converts at load (DD-9) "so no consumer ever rescales"; story Technical Notes (`df3-3...md:166-168`): "every consumer divides by 1e6 at the projection… the unit is per-MTok precisely so a cheap model's rate does not round to zero". Per-term round is the spec'd arithmetic: story `:267-268` ("round(tokens·ratePerMTok/1e6) per term") and `:299-300` ("spendMicros 276 = 3 × 92 (1000 in / 64 out at 80 000/180 000 µ$/MTok) — exact integer µ$ arithmetic"). The HIGH premise (rates in $/MTok) is false. |

## Behavior-change flags (for wave-2 test re-pinning)

1. **select_roster now requires `ctx.phaseIds`** containing `directive.phase`; absent `phaseIds` = empty set = reject. Until fix-pipeline wires `phaseIds`, ANY select_roster through the pipeline is rejected even with a valid rosterId. Existing tests unaffected (no accepted-select_roster pipeline test exists — triage T2 lists it as untested); steering.test.ts:135 re-pinned (added `phaseIds: ["build"]`).
2. **Tripwire detail string shape changed** for known-action/unknown-field rejections: now `action <name> rejected: <issue>` (was bare `<issue>`). Contains the old substring, so `toContain("evil")`-style pins still pass.
3. **Correction prompt content changed**: now includes the steering-point header and bounded context. INV-2 pins (no model-reply echo, union restated) still pass.
4. **steeringIterations** no longer increments for retries accepted at run_start/run_end. No existing test covered that case.
5. **Serialization**: concurrent `solicit()` calls now queue. Sequential callers see no change.
6. **Rate clamping**: a non-finite/negative `deps.rate` meters 0 (previously poisoned `spendMicros` with NaN).

## Verification

- `bun test tests/phase-engine/steering.test.ts` — **38 pass, 0 fail**.
- `bun test tests/phase-engine/usage.test.ts` — **12 pass, 0 fail** (the 2-division steering pin holds; meter keeps exactly two `/ 1_000_000` terms).
- `bun test tests/phase-engine/phase-lifecycle.test.ts` — **32 pass, 0 fail** (journal coverage).
- `bun test tests/phase-engine/resident-e2e.test.ts` — **10 pass, 0 fail** (pipeline wiring, including the rejected-select_roster wiring test at :395, unaffected since the rosterId check fires first).
- `bunx tsc --noEmit` — clean.
- `bunx biome check src/phase-engine/steering.ts src/phase-engine/journal.ts` — clean, no fixes.

No commits made.
