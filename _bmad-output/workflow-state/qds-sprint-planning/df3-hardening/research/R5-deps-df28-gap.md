# R5: Dependencies, Sequencing, and DF2.8 Gap Analysis

**Agent:** R5 (dependencies + sequencing analyst)
**Date:** 2026-08-20
**Worktree:** /Users/steve/QDS-Factory-df3 (feature/df3-story-hardening)

---

## Executive Summary

1. **Staleness Correction Required**: DF1.8 (review) and DF2.6 (ready-for-dev) are **both MERGED** to main (PRs #117, #120). Sprint status must be updated to reflect `status: done`.

2. **DF2.8 In-Flight Status**: Actively developed in main worktree on `feature/df2-8-cost-ledger-budget-cap`. Story spec is **complete and stable** with fully defined interface contracts. Implementation code does not yet exist (no `src/providers/cost-ledger.ts` or `budget-gate.ts` files found). The spec itself is citation-ready.

3. **DF3 Dependency Graph (Validated)**:
   ```
   DF3.1 (core verbs) → DF3.2, DF3.3, DF3.4, DF3.5, DF3.6
   DF3.3 (resident) → DF3.4, DF3.6
   DF3.2 (fanout) → DF3.5
   ```
   All dependencies are sound after hardening review.

4. **Recommended Writer Pairing (3 agents × 2 stories)**:
   - **Wave 1**: DF3.1 + DF3.2 (dispatcher foundation + patterns, tight coupling)
   - **Wave 2**: DF3.3 + DF3.6 (resident orchestrator + bounds, tier-2 cohesion)
   - **Wave 3**: DF3.4 + DF3.5 (approval gate + skills, tier-1 documentation)

5. **DF2.8 Disposition Recommendation**: **Option (b)** — cite only the DF2.8 story-spec contract with "contract-cited, implementation pending" marker. The spec is complete, interface-stable, and referenceable. DF2.8 implementation can land independently without blocking DF3 revisions.

---

## 1. Sprint Status Staleness — DF1.8 and DF2.6

### Confirmed Merges (from `git log --oneline main`):

**DF1.8** — `Merge pull request #117 from biospark33/feature/df1-8-run-capture-correlation`
- Status in sprint-status.yaml: `review`
- **Correct status**: `done`
- Impact: DF3.1 dependency on DF1.8's `resolveRunCorrelation` is **satisfied**.

**DF2.6** — `Merge pull request #120 from biospark33/feature/df2-6-quota-accounting-reaper`
- Status in sprint-status.yaml: `ready-for-dev`
- **Correct status**: `done`
- Impact: DF3.1 (AC8) and DF3.2 (AC1) `checkHeadroom()` calls are **live**.

### Correction for Wrap-Up
Update sprint-status.yaml before final commit:
- `df1: DF1.8: { status: done }` (was `review`)
- `df2: DF2.6: { status: done }` (was `ready-for-dev`)

---

## 2. DF2.8 In-Flight Reconnaissance (READ-ONLY)

### Current State

**Branch**: `feature/df2-8-cost-ledger-budget-cap` (checked out in `/Users/steve/QDS-Factory`)

**Development Evidence**:
- Workflow state exists: `_bmad-output/workflow-state/qds-dev/df2-8/state.yaml`
- Story spec is fully authored: `df2-8-cost-ledger-budget-cap.md` (complete, 309 lines)

**Implementation Status**:
- **No source files found** for:
  - `src/providers/cost-ledger.ts`
  - `src/providers/budget-gate.ts`
  - `scripts/qds-cost.ts`
- Interface is **spec-only** at this time.

### Stable Interface Contract (from Story Spec)

The story spec defines a **complete, referenceable interface** that DF3.1 and DF3.6 can safely cite:

**Core Functions**:
```
ingestCostEvent(event: CostEvent, ctx: IngestContext): Promise<void>
assertWithinBudget(repoSlug: string, issueId: string): BudgetDecision
readIssueCost(repoSlug: string, issueId: string): IssueCostView
readRunCost(runId: string): RunCostView
```

**Schema** (Technical Notes, lines 116-142):
```
cost_events {
  event_id PK,
  run_id,
  repo_slug NOT NULL,
  issue_id NOT NULL,
  request_id NOT NULL,
  role,
  agent_id,
  provider,
  model,
  kind NOT NULL,  -- 'tokens' | 'box_hours'
  invocation_seq,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
  turn_count,
  cost_micro_usd NOT NULL,  -- integer µ$
  unpriced DEFAULT 0,
  key_hash,
  key_limit_micro_usd,
  created_at ISO8601
}
```

**Config**:
```
{
  defaultCapMicroUsd: 5_000_000,
  perIssueOverrides?,  // "owner/repo#N" → integer µ$
  boxHourRateMicroUsd
}
```

**Gate Contract** (AC3):
- Returns `{ status: 'over-budget', reason: 'spend-cap-exceeded', capMicroUsd, spentMicroUsd, unpricedRows }`
- Or proceeds with `remainingMicroUsd` logged
- Hands `min(defaultKeyCapMicroUsd, remainingMicroUsd)` to DF2.3's mint

**CLI Contract**:
- `qds cost <owner/repo>#<N>` (bare issue rejected)
- Returns total, per-role split, per-run breakdown, cache tokens, unpriced count

### What DF3.1 Can Safely Cite TODAY

From DF3.1 story spec, AC7 (budget admission):
> "Given a validated brief, When dispatch runs, Then it calls DF2.8's assertWithinBudget(brief.repoSlug, brief.issueRef) before the run record is created"

**Safe Citation Path**:
- Cite DF2.8 story spec by line reference (`df2-8-cost-ledger-budget-cap.md:27-30` for interface, `:69-73` for gate contract)
- Mark with `**[DF2.8 implementation pending — contract-cited from spec]**` in dependency notes
- No code-level import needed — DF3.1's AC7 is a call site declaration, not implementation

### What DF3.6 Can Safely Cite TODAY

From DF3.6 story spec, AC2a (ordering assertion):
> "residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd (DF2.3's configured default key cap, not any run's minted value)"

**Safe Citation Path**:
- The ordering check references **only static configured defaults** (DF2.3 and DF2.8 config)
- Does NOT require `assertWithinBudget` implementation
- Cite DF2.8 spec line 180 (default cap definition) and DF2.3's exported `defaultKeyCapMicroUsd`

---

## 3. Inter-Story Dependency Validation (DF3)

### Validated Dependency Graph

```
DF3.1 (core verbs)
├─ DF1.8 ✓ (MERGED — resolveRunCorrelation live)
├─ DF2.1 ✓ (done — driver port)
├─ DF2.2 ✓ (done — setup gate)
├─ DF2.5 ✓ (done — teardown)
├─ DF2.6 ✓ (MERGED — checkHeadroom live)
└─ DF2.8 ⏳ (in-flight — contract stable, implementation pending)

DF3.2 (fanout patterns)
├─ DF1.1 ✓ (done — phase engine)
├─ DF2.1 ✓ (done — record store)
├─ DF2.6 ✓ (MERGED — headroom admission)
└─ DF3.1 (foundation)

DF3.3 (resident orchestrator)
├─ DF1.1 ✓ (done — lifecycle)
├─ DF1.5 ✓ (done — roster + rate)
├─ DF1.6 ✓ (done — dispatch_task phase)
├─ DF2.2 ✓ (done — box)
└─ DF3.1 (brief → steering)

DF3.4 (approval gate + attach steering)
├─ DF2.1 ✓ (done — driver port for steering transport)
├─ DF2.3 ✓ (done — teardown-at-pause, key revoke)
├─ DF2.5 ✓ (done — teardown guard)
├─ DF3.1 (CLI chassis)
└─ DF3.3 (resident target)

DF3.5 (tier-1 factory skills)
├─ DF3.1 ✓ (verb registry)
├─ DF3.2 (fanout verb)
└─ DF3.4 (approval verbs)

DF3.6 (resident bounds)
├─ DF1.1 ✓ (done — lifecycle)
├─ DF1.5 ✓ (done — resolveRate)
├─ DF2.3 ✓ (done — key cap)
├─ DF2.8 ⏳ (budget cap — contract stable)
└─ DF3.3 (solicitation port)
```

### Findings

**All dependencies are sound** — no stale or missing edges after hardening review.

**No DF3.3 ← DF3.4/DF3.6 reversal**:
- DF3.3 **has no inbound dependency** from DF3.4 or DF3.6
- DF3.3 is a predecessor to both DF3.4 (steering target) and DF3.6 (solicitation port)
- The noted "DF3.3←DF3.4/DF3.6" from the task was a misunderstanding

**DF3.5's DF3.2 dependency is soft**:
- DF3.5 story spec AC1 enforces contract test against `listVerbs()` registry
- If DF3.2 is unmerged, `factory-dispatch` skill documents `dispatch` only
- No skill edit needed on DF3.2 arrival — contract test fails until registry includes `fanout`
- This is **already correctly scoped** in DF3.5's "Sprint-compression note"

**DF3.6 needs DF2.8 for config, not implementation**:
- DF3.6 AC2a validates static config ordering only
- Cites DF2.8's `defaultCapMicroUsd: 5_000_000` (spec line 180)
- No runtime call to `assertWithinBudget` required
- DF2.8 code implementation is **not blocking** for DF3.6 revision

---

## 4. Wave Strategy for Revision Work (3 Writer Agents × 2 Stories)

### Recommended Pairing

**Wave 1: Foundation + Patterns** (Agent A)
- **DF3.1** (Fleet Dispatcher Core Verbs) — 5 pts
- **DF3.2** (Fleet Patterns as Code) — 4 pts
- **Rationale**: DF3.2 is a thin composition over DF3.1's `dispatch` primitive. Both share the DF2.6 headroom admission pattern and the same sequencing notes. Tight coupling suggests same-writer handoff.

**Wave 2: Resident Tier-2** (Agent B)
- **DF3.3** (Resident Orchestrator Agent) — 4 pts
- **DF3.6** (Resident-Agent Bounds) — 3 pts
- **Rationale**: DF3.6 watches DF3.3's resident (same `resident` journal block, same tripwire telemetry, same solicitation port). DF3.6's `checkBounds()` runs immediately before every DF3.3 solicitation. Cohesive tier-2 pair.

**Wave 3: Approval + Documentation** (Agent C)
- **DF3.4** (Tier-1 Pre-PR Approval Gate + attach Steering) — 6 pts
- **DF3.5** (Tier-1 Claude Code Factory Skills) — 2 pts
- **Rationale**: DF3.5's skills document DF3.4's `approve`/`reject`/`attach` verbs. DF3.5's contract test parses `fleet …` commands against DF3.1/DF3.2/DF3.4 registries. Both are tier-1 documentation work over the CLI chassis.

### Revision Order

**Sequential wave order** (each wave produces merged PR before next wave starts):
1. Wave 1 (DF3.1 → DF3.2) — unblocks DF3.3, DF3.4, DF3.5
2. Wave 2 (DF3.3 → DF3.6) — DF3.3 unblocks DF3.4; DF3.6 follows DF3.3
3. Wave 3 (DF3.4 → DF3.5) — DF3.4 approved + DF3.5 skills complete

### Load Balancing

**Story points by wave**:
- Wave 1: 9 pts (DF3.1=5 + DF3.2=4)
- Wave 2: 7 pts (DF3.3=4 + DF3.6=3)
- Wave 3: 8 pts (DF3.4=6 + DF3.5=2)

**Balanced distribution** — no wave exceeds 9 pts. Suitable for 3 parallel writer agents.

---

## 5. DF2.8 Disposition Options for DF3.1/DF3.6 Text

### Options Evaluated

**(a) Keep hard dep + precondition note "DF2.8 must merge first"**
- Pros: Strongest correctness guarantee
- Cons: Blocks DF3 revision work on DF2.8 landing; DF2.8 is v5-S2 and may land outside DF3 sequence
- Risk: DF3 stories wait on DF2.8 implementation timing

**(b) Cite only the DF2.8 story-spec contract with "contract-cited, implementation pending" marker**
- Pros: Unblocks DF3 revision immediately; spec is complete and interface-stable; references are precise (line-citable)
- Cons: Requires marker discipline; DF3.1/DF3.6 must reference spec, not code
- Risk: Low — spec changes would be caught by contract drift; marker makes state explicit

**(c) Re-scope to make DF2.8 a soft dep**
- Pros: Maximum flexibility
- Cons: Loses explicit contract traceability; harder to verify DF3 correctness if DF2.8 shape shifts
- Risk: DF3.1's `assertWithinBudget` call site and DF3.6's ordering check become underspecified

### Recommendation: **Option (b)**

**Rationale**:

1. **DF2.8 spec is complete and interface-stable** — 309 lines with fully defined schemas, function signatures, config contracts, and acceptance criteria. No TBD placeholders.

2. **DF3.1 and DF3.6 citation needs are spec-level, not code-level**:
   - DF3.1 AC7 calls `assertWithinBudget(brief.repoSlug, brief.issueRef)` — function name and parameters are in spec (line 27-30)
   - DF3.6 AC2a validates `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` — `runBudgetCapMicros` is DF2.8's `defaultCapMicroUsd: 5_000_000` (spec line 180)

3. **Marker pattern is already established** for in-flight predecessors:
   - DF2.6 was same-sprint dep for DF3.1/DF3.2 with sequencing notes in both story files
   - DF2.8 can use the same pattern with explicit `**[implementation pending — contract-cited from df2-8 spec]**` markers

4. **No blocking on DF2.8 implementation timing** — DF3 revision can proceed while DF2.8 lands independently. When DF2.8 merges, DF3.1/DF3.6 citations resolve to code. If spec drifts before merge, the marker makes verification tractable.

5. **Low risk** — DF2.8 interface changes would require coordinated DF3.1/DF3.6 updates anyway. Citing the spec makes the contract explicit and reviewable.

### Implementation Guidance for Writers

**DF3.1 writers** (AC7, budget admission):
```
Before the run record is created, dispatch calls DF2.8's
assertWithinBudget(repoSlug, issueId) gate (df2-8:27-30), which
returns either a refusal payload or the remaining budget.

**[DF2.8 implementation pending — contract-cited from df2-8 spec]**
```

**DF3.6 writers** (AC2a, ordering assertion):
```
The load-time assertion validates the static configured defaults:
  residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd
where runBudgetCapMicros is DF2.8's defaultCapMicroUsd: 5_000_000 µ$
(df2-8:180) and defaultKeyCapMicroUsd is DF2.3's exported constant.

**[DF2.8 implementation pending — contract-cited from df2-8 spec]**
```

**Post-DF2.8-merge cleanup** (DF5.5 KEEP-repoint chore can handle):
- Remove `**[implementation pending...]**` markers
- Replace spec citations with code-level references (import paths, function signatures)

---

## 6. Wrap-Up Action Items

### For R5 Wrap-Up (This Report)

1. Update sprint-status.yaml:
   - `df1: DF1.8: { status: done }` (was `review`)
   - `df2: DF2.6: { status: done }` (was `ready-for-dev`)

2. Archive this report for Phase 2 writer agent handoff.

### For Phase 2 Writers (Sequenced Handoff)

1. **Wave 1 agent** (DF3.1 + DF3.2):
   - Cite DF2.8 spec with implementation-pending marker (Option b)
   - Update DF3.1 sequencing notes: DF2.6 is now `done` (MERGED), DF2.8 is `in-flight, contract-cited`
   - DF3.2 sequencing notes: same DF2.6 update

2. **Wave 2 agent** (DF3.3 + DF3.6):
   - DF3.6 ordering assertion: cite DF2.8 spec line 180 with implementation-pending marker
   - Verify no code-level import of `assertWithinBudget` (not needed)

3. **Wave 3 agent** (DF3.4 + DF3.5):
   - Verify DF3.5 contract test covers DF3.4's `approve`/`reject`/`attach` verbs (registered in DF3.4)
   - No DF2.8 citations needed in Wave 3

### For Phase 3 Wrap-Up (DF5.5 Chore)

- Remove all `**[DF2.8 implementation pending...]**` markers
- Replace spec citations with code-level references after DF2.8 merges
- Update sprint-status.yaml DF2.8 entry to `done` when merged

---

## Appendix: Key References

**Story Files**:
- DF2.8: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-8-cost-ledger-budget-cap.md`
- DF3.1: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md`
- DF3.2: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md`
- DF3.3: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-3-resident-orchestrator-agent.md`
- DF3.4: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md`
- DF3.5: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-5-tier1-factory-skills.md`
- DF3.6: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6-resident-agent-bounds.md`

**Sprint Status**:
- `_bmad-output/sprint-artifacts/sprint-status.yaml`

**Git Evidence**:
- DF1.8 merge: `git log main | grep "Merge pull request #117"`
- DF2.6 merge: `git log main | grep "Merge pull request #120"`
- DF2.8 branch: `git -C /Users/steve/QDS-Factory branch --show-current`

**Workflow State**:
- DF2.8 dev state: `/Users/steve/QDS-Factory/_bmad-output/workflow-state/qds-dev/df2-8/state.yaml`

---

**R5 Report Complete**
