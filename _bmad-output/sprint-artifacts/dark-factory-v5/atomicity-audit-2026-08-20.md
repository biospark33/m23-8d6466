# Atomicity Audit — dark-factory-v5 DF3 hardening revision — 2026-08-20

**Auditor:** qds-sprint-planning Phase 2.5 (DF3 hardening run)
**Total stories audited:** 6 (DF3.1–DF3.6, post-revision)
**Pass:** 0 / **Warn:** 6 / **Block:** 5 (by the letter of the gate — see Override log)

**Context:** This audit re-runs the eight checks from
`atomicity-audit-2026-08-11.md` against the 2026-08-20 hardening revision
(contracts crosswalked to implemented DF1/DF2 architecture, hardening doctrine
encoded, DF2.8 citations marked contract-cited-pending). Counting method is
identical to the 2026-08-11 audit (total lines minus the Dev Agent Record
block and trailing appendix).

## Story-by-story findings

### DF3.1 — Fleet Dispatcher Core Verbs

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **block** | 318 normative (332 total) |
| total size (≤400) | WARN | pass | 332 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | warn | 11 items |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 10 entries |
| Security Invariants | BLOCK if triggered+absent | pass | triggered (authz/secrets/parse); substantive INVs incl. new INV-4-bis requestId propagation, INV-6 redaction |

### DF3.2 — Fleet Patterns as Code

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **block** | 314 normative (330 total) |
| total size (≤400) | WARN | pass | 330 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | warn | 11 items |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 8 entries |
| Security Invariants | BLOCK if triggered+absent | pass | substantive (fail-closed admission, per-arm guards, finite caps, redaction) |

### DF3.3 — Resident Orchestrator Agent

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **block** | 259 normative (277 total) — 9 over |
| total size (≤400) | WARN | pass | 277 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 9 entries |
| Security Invariants | BLOCK if triggered+absent | pass | substantive (fail-closed reply parsing, bounded solicitation) |

### DF3.4 — Tier-1 Pre-PR Approval Gate + attach Steering

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **block** | 357 normative (370 total) |
| total size (≤400) | WARN | pass | 370 lines |
| SP budget (≤8) | BLOCK | pass | 6 SP |
| DOD count (≤10) | WARN | pass | 10 items (trimmed from 20) |
| title AND connectors | WARN | pass | 1 (`+`) |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | warn | 11 entries (>10 by one) |
| Security Invariants | BLOCK if triggered+absent | pass | substantive (hashed allowlist, no-secret parity, teardown-before-await) |

### DF3.5 — Tier-1 Factory Skills

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | warn | 250 normative (261 total) — WARN-zone ceiling |
| total size (≤400) | WARN | pass | 261 lines |
| SP budget (≤8) | BLOCK | pass | 2 SP |
| DOD count (≤10) | WARN | pass | 10 items |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 5 entries |
| Security Invariants | BLOCK if triggered+absent | pass | substantive |

### DF3.6 — Resident-Agent Bounds

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **block** | 283 normative (301 total) |
| total size (≤400) | WARN | pass | 301 lines |
| SP budget (≤8) | BLOCK | pass | 3 SP |
| DOD count (≤10) | WARN | warn | 11 items |
| title AND connectors | WARN | pass | 1 (`+`) |
| blocker markers (=0) | BLOCK | pass | none |
| Files-to-Modify section | BLOCK if absent | pass | 5 entries |
| Security Invariants | BLOCK if triggered+absent | pass | substantive (fail-safe projection, group-kill parity, µ$ integers) |

## Summary

- **BLOCK-severity violations:** normative-size >250 on DF3.1 (318), DF3.2
  (314), DF3.3 (259), DF3.4 (357), DF3.6 (283).
- **WARN:** DF3.5 at 250 normative; DOD 11 on DF3.1/DF3.2/DF3.6; FTM 11 on DF3.4.
- **Provenance of the overage (load-bearing fact):** the 2026-08-11 audit
  passed DF3.1 at 199 normative / 204 total. Between that audit and commit,
  the Phase-3 adversarial loop grew every story (e.g. DF3.1 204→326 total) —
  the SPL-027 failure mode: no headroom, every review fix inflates. Today's
  hardening revision was **net-zero on lines** (400 insertions / 401 deletions
  across the six stories). The size debt is inherited, not introduced here.

## Override log (operator)

**2026-08-20 — operator decision: override the five normative-size BLOCKs, no distill.**

Rationale: the overage is inherited structural debt from the 2026-08-11→12
Phase-3 adversarial growth (every DF-v5 story shipped past the gate the same
way — DF1/DF2 development proceeded on similarly sized specs without
size-related failures across ~40 review rounds). The 2026-08-20 hardening
revision was net-zero on lines. The gate's purpose — prevent under-specified
atomic stories from spawning 15+ fix rounds — is not implicated by prose
length here; DF3 story splits would damage contract coherence (DF3.1's four
verbs share one boundary; DF3.4's approval mechanics are one invariant set).
WARNs (DOD 11 ×3, FTM 11 ×1) accepted as-is. — recorded by the operator
during the DF3 hardening session.
