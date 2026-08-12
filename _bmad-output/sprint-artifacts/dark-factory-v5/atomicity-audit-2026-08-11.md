# Atomicity Audit — dark-factory-v5 — 2026-08-11

**Auditor:** qds-sprint-planning Phase 2.5
**Total stories audited:** 31
**Pass:** 28 / **Warn:** 3 / **Block:** 0

Method: normative lines counted as every line preceding `## Dev Agent Record` (no story carries an appendix section — all 31 use the identical 13-heading template, so `## Dev Agent Record` is the only excludable block). DOD items were read individually and graded for signal; Security Invariants sections were read in full and graded for substantiveness rather than presence.

## Story-by-story findings

### DF1.1 — Phase Lifecycle Primitive with Versioned Pipeline Manifest

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 192 normative lines (197 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 197 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 9 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.2 — Gates with Evidence over a Unified Envelope Adapter

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 190 normative lines (195 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 195 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 10 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.3 — Dual Retry Discipline — Separately Bounded Parse and Gate Retries

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 182 normative lines (187 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 187 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.4 — SQLite Trace Store (7-Table Schema, WAL, Rowid-Cursor Reads)

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 192 normative lines (197 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 197 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.5 — Per-Role Roster Config + Dual Slug Validation

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 194 normative lines (199 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 199 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, payment/billing, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.6 — dispatch_task Phase Spawns a pi Team via `team-lead-driver.ts`

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 191 normative lines (196 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 196 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 10 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 5 matches R5 §1 slate (5). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF1.8 — Run Capture Correlated to the GitHub Issue (Trace-Store-Backed)

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S2.

### DF1.9 — Lean Worker Profile — Measure the Extension/Skill Overhead

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 195 normative lines (200 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 200 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 9 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF2.1 — Provider-Driver Interface + Run Records

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 189 normative lines (194 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 194 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF2.2 — exe.dev Driver + Five-Assertion Setup Gate

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: authz, secrets/crypto, tenancy; 5 substantive INV clauses |

_Consistency:_ Story Points 5 matches R5 §1 slate (5). Sprint declared: v5-S1.

### DF2.3 — Per-Run Credential Lifecycle — Mint, Cap, Deliver, Revoke, Verify-Against-List

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 186 normative lines (191 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 191 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 5 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S1.

### DF2.4 — Live Cap-Hit Kill Demonstration — Real Key, Real Spend, Recorded Evidence

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 188 normative lines (193 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 193 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 9 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S2.

### DF2.5 — Bundle Harvest + Tested Teardown

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 198 normative lines (203 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 203 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). **Sprint band undeclared** — the story header carries no `Sprint:` line.

### DF2.6 — Host-Side Quota Accounting + Orphan Reaper

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 190 normative lines (195 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 195 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S2.

### DF2.7 — Session-Cumulative Cost Instrumentation in the Team Lead Driver

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 183 normative lines (188 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 188 lines |
| SP budget (≤8) | BLOCK | pass | 2 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, payment/billing, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 2 matches R5 §1 slate (2). Sprint declared: v5-S1.

### DF2.8 — Micro-Dollar Cost Ledger with Budget Cap and Pre-Spawn Dispatch Refusal

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF2.9 — OCI Image Contract + License-Compliance Build

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 190 normative lines (195 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 195 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 9 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S1.

### DF3.1 — Fleet Dispatcher Core Verbs (dispatch, status, harvest, teardown)

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 5 matches R5 §1 slate (5). Sprint declared: v5-S2.

### DF3.2 — Fleet Patterns as Code — fan-out N, best-of-N, race

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF3.3 — Resident Orchestrator Agent — Interprets the Brief, Steers the Engine, Never Holds Gate Authority

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 9 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF3.4 — Tier-1 Pre-PR Approval Gate + `attach` Steering

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, secrets/crypto; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF3.5 — Tier-1 Claude Code Factory Skills over the Tested Fleet CLI

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 187 normative lines (192 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 192 lines |
| SP budget (≤8) | BLOCK | pass | 2 SP |
| DOD count (≤10) | WARN | pass | 9 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 7 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 2 matches R5 §1 slate (2). Sprint declared: v5-S2.

### DF3.6 — Resident-Agent Bounds — Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 194 normative lines (199 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 199 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 5 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, secrets/crypto, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S2.

### DF4.1 — Visualizer Port + Tunneled Auth Gate

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | warn | 10 entries; 1 of 10 entries is a directory (`visualizer/src/`) enumerating 5 Vue files plus `lib/*` — effective path count ~16 |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S3.

### DF4.2 — Visualizer Test Suite from Zero, Bun-API Inventory, Per-Box Deploy

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 194 normative lines (199 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 199 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | warn | 10 entries; 1 of 10 entries is a glob (`visualizer/test/lib/*.test.ts`) — effective path count exceeds 10 |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 5 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S3.

### DF5.1 — Host-Side Out-of-Box Re-Verify Before Any PR

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 193 normative lines (198 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 198 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF5.2 — Host-Side PR Creation from the Quarantine Ref

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 192 normative lines (197 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 197 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, upload/parse; 7 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S2.

### DF5.3 — Audit Chain Extended to Credential, Box, Bundle and Re-Verify Links

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 198 normative lines (203 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 203 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 1 conjunction |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 10 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, payment/billing, tenancy; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S3.

### DF5.4 — Lights-On Exit Gate on the P0.11 Chassis

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 198 normative lines (203 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 203 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto, pii, upload/parse; 5 substantive INV clauses |

_Consistency:_ Story Points 3 matches R5 §1 slate (3). Sprint declared: v5-S3.

### DF5.5 — KEEP-Repoint Chore — Dependency Edges, Boundary Amendments, SwarmClaw Role Line

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 189 normative lines (194 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 194 lines |
| SP budget (≤8) | BLOCK | pass | 2 SP |
| DOD count (≤10) | WARN | pass | 9 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | warn | 9 entries; 2 of 9 entries are brace globs (`p1-{2,3}-*.md`, `p1-{7,11,12}-*.md`) covering 5 files — effective path count ~12 |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: rls/policy, migration/schema, authz, upload/parse; 4 substantive INV clauses |

_Consistency:_ Story Points 2 matches R5 §1 slate (2). Sprint declared: v5-S2.

### DF6.1 — PR Feedback → Bounded Fix Run → CI Green

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 199 normative lines (204 total − Dev Agent Record block) |
| total size (≤400) | WARN | pass | 204 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific; no project-wide CI invariant present |
| title AND connectors | WARN | pass | 0 conjunctions |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 10 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered: migration/schema, authz, secrets/crypto; 6 substantive INV clauses |

_Consistency:_ Story Points 4 matches R5 §1 slate (4). Sprint declared: v5-S3.

## Summary

- **BLOCK-severity violations:** none. All 31 stories clear checks 1, 2, 3, 6 and 8.
- **WARN-severity violations (3 stories, all check 7):**
  - DF4.1 — Files-to-Modify: 1 of 10 entries is a directory (`visualizer/src/`) enumerating 5 Vue files plus `lib/*` — effective path count ~16
  - DF4.2 — Files-to-Modify: 1 of 10 entries is a glob (`visualizer/test/lib/*.test.ts`) — effective path count exceeds 10
  - DF5.5 — Files-to-Modify: 2 of 9 entries are brace globs (`p1-{2,3}-*.md`, `p1-{7,11,12}-*.md`) covering 5 files — effective path count ~12

- **Recommendations:**
  - No `bmad-distillator` run is warranted. Normative content runs 182–199 lines across the slate against a 200-line cap; the tightest margin is 1 line, so any future edit that adds normative prose must remove an equivalent amount or the story crosses into WARN.
  - No splits are warranted. Peak size is 5 SP (DF1.6, DF2.2, DF3.1) against an 8 SP BLOCK threshold, and every title carries at most one conjunction.
  - No `CONTEXT.md` extraction is warranted — every file is roughly half the 400-line total-size limit.
  - For DF4.1, DF4.2 and DF5.5: replace the directory/glob Files-to-Modify entries with explicit paths, or accept that the true edit surface exceeds the declared entry count. This is advisory — the section is present in all three and the declared entry count is within the limit.

### Consistency checks (bonus, non-blocking)

- **Story Points vs R5 slate:** all 31 match `R5-dependency-sizing.md` §1 exactly. Epic totals reconcile: DF1 29, DF2 31, DF3 22, DF4 8, DF5 17, DF6 4 — 111 points across 31 stories.
- **Sprint declaration:** all 31 stories carry a `**Sprint:**` header line. (The nine DF1/DF2 early-band stories — DF1.1, DF1.2, DF1.3, DF1.4, DF1.5, DF1.6, DF1.9, DF2.1, DF2.5 — were backfilled to their R5 §3 band, v5-S1, in the reflect pass; an earlier draft of this audit listed them as missing. The slate now matches R5's 13/13/5 sprint slicing exactly.)

> **Addendum (2026-08-12, post-rebaseline):** the point totals, per-story figures, and the
> 13/13/5 sprint split recorded above (111 points; e.g. DF1.6 at 5 pts) are this audit's
> **historical, pre-rebaseline** snapshot from 2026-08-11. The backlog was subsequently
> re-baselined to **123 points across a 48 / 50 / 25 v5-S1 / v5-S2 / v5-S3 split** (DF1.6 now 8
> pts; DF5.5 moved to v5-S3), per
> `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md` and
> `sprint-status.yaml`, which are authoritative for current totals. This audit's rows are left
> unedited as the point-in-time record they are; do not read 111 / 13-13-5 as current.

## Override log (operator)

_Empty — no BLOCK-severity violation was raised, so no override is required._
