# Architecture v2.0 — Session 10 Amendment Notes

**Date:** 2026-03-14
**Scope:** 3 ADR amendments, 1 state ownership clarification, 1 design decision ratification
**Applies to:** `_bmad-output/planning-artifacts/architecture-v2.md` v2.0

---

## Amendment 1: ADR-008 — Credential Injection Mechanism Specification

**Section affected:** ADR-008, C4a (line ~522)

**Current text:** "Factory Core holds credentials in-memory. Passes to Pi SDK via constructor/init call"

**Amended text:** "Factory Core holds credentials in-memory. Passes to Pi SDK via the `getApiKey` callback mechanism in Pi SDK's Agent constructor. The `getApiKey` callback is a function that Pi SDK invokes when it needs an API key for a provider. Factory Core registers this callback during Agent construction; the callback's closure captures the key from Factory Core's credential store without exposing it in the Agent constructor's configuration object, overlay text, or `contextAdditions`."

**Rationale:** The pi-mono deep-dive (Session 9b) confirmed that Pi SDK's actual credential mechanism is a `getApiKey` callback function, not a static configuration property or constructor parameter. The original ADR-008 text ("programmatic constructor init") was technically correct but insufficiently specific — it could be misinterpreted as passing keys as constructor arguments, which would expose them in the configuration object. The callback pattern provides lazy evaluation and closure-based isolation, which is a stronger security guarantee.

**Impact on stories:** Story 2.3 (Credential Middleware) AC amended to reference `getApiKey` callback. No other story changes required.

---

## Amendment 2: ADR-013 — Enforcement Metadata Clarification

**Section affected:** ADR-013, S5 (line ~896-901)

**Current text (S5):** "Stage 2 injects enforcement context: skill descriptions (triggering conditions), guard rules, enforcement frontmatter."

**Amended text:** "Stage 2 injects enforcement context: skill `description` fields from YAML frontmatter (which contain triggering conditions and guard rules as natural language). There is no separate `enforcement` field in Superpowers frontmatter — the `description` field IS the enforcement metadata. This is consistent with S1's `SkillMetadata` interface, which defines only `name` and `description` as frontmatter fields. The 3 critical enforcement skills (TDD, verification-before-completion, systematic-debugging) have descriptions that serve as their enforcement rules."

**Additionally, amend S1 documentation comment:** After the `SkillMetadata` interface definition, add:
```
// NOTE (Session 10): `description` is the ONLY enforcement metadata field.
// PRD FR34's reference to a separate `enforcement` field was aspirational
// and contradicts this accepted architecture decision. Factory Core reads
// `description` as enforcement text — no parsing of a structured
// `enforcement` field is required or expected.
```

**Rationale:** The Superpowers deep-dive (Session 9b) confirmed that `extractFrontmatter()` returns only `{ name: string; description: string }`. PRD v2 FR34 says "Superpowers skill files with `enforcement` metadata in YAML frontmatter" — this is a contradiction with ADR-013 S1 which already defined the complete frontmatter interface. The architecture (ADR-013) is correct; the PRD text is aspirational fiction. This amendment makes the architecture's position explicit and unambiguous.

**PRD reconciliation note:** FR34 should be read as: "Superpowers skill files with enforcement metadata *encoded in the `description` field of* YAML frontmatter can be consumed by hook scripts for machine-validated gate enforcement." The FR is not wrong in intent — it is wrong in mechanism. A PRD revision note should be added to FR34 referencing this amendment.

**Impact on stories:** Story 2.5 (Enforcement Middleware) AC rewritten to read `description` field. Story 2.6 (Skill Middleware) unchanged — already reads `description`. No other story changes required.

---

## Amendment 3: State Ownership — Factory Core Migrations vs. Overstory Schema Extensions

**Section affected:** New note, placed after the Component Relationship Model table (line ~41 area) or in the data architecture section.

**New text:**

### Database Migration Ownership Boundaries

| Database | Owner | Migration Pattern | Managed By |
|----------|-------|-------------------|------------|
| `pipeline.db` | Factory Core | Sequential SQL files in `factory-core/src/migrations/`, tracked via `_migrations` table | Story 1.2 (Migration Runner) |
| `attribution.db` | Factory Core | Same sequential SQL runner as pipeline.db | Story 1.2 (Migration Runner) |
| `sessions.db` | Overstory | Overstory's native `PRAGMA table_info` probe-then-alter pattern | Overstory (pre-existing) |
| `mail.db` | Overstory | Overstory's native probe-then-alter pattern | Story 1.6 (Overstory Schema Extensions) for Factory Core-required additions |
| `events.db` | Overstory | Overstory's native probe-then-alter pattern | Story 1.6 (Overstory Schema Extensions) for Factory Core-required additions |
| `metrics.db` | Overstory | Overstory's native probe-then-alter pattern | Overstory (pre-existing) |

**Critical rule:** Factory Core's sequential SQL migration runner (Story 1.2) MUST NOT be applied to Overstory-owned databases. Overstory databases use an idempotent probe-before-alter pattern (`PRAGMA table_info` check before `ALTER TABLE`) that is incompatible with sequential migration tracking. Story 1.6 performs all Factory Core-required Overstory schema extensions using Overstory's native pattern.

**Rationale:** The code-lift deep-dive (Session 9b) identified that Overstory's `SessionStore` uses `bun:sqlite` with a specific `PRAGMA table_info` check before `ALTER TABLE` — an idempotent probe pattern. Factory Core's migration runner (Story 1.2) uses sequential SQL files with a `_migrations` tracking table. Applying the wrong pattern to the wrong database risks breaking idempotency or creating split-brain migration state.

---

## Amendment 4: Design Decision Ratification — BLOCKER-1 Resolution

**Decision:** Option A — `description` as enforcement metadata (NOT Option B — extend Superpowers frontmatter)

**Rationale:**
1. ADR-013 already decided this correctly: "No content validation of skill descriptions — Superpowers owns skill quality. Factory Core consumes frontmatter as-is."
2. The `extractFrontmatter()` function returns `{ name: string; description: string }` — adding a new field requires modifying the Superpowers repo, which violates boundary discipline.
3. The 3 critical enforcement skills (TDD, verification-before-completion, systematic-debugging) already have descriptions that ARE their enforcement rules — the content exists, only the code's interpretation was misspecified.
4. Adding a redundant structured `enforcement` field creates maintenance burden (14 skill files to update) with zero behavioral benefit.

**Status:** RESOLVED. All downstream documents (epics-and-stories.md, code-lift-manifest.md) amended to reflect this decision.

---

## Risk Register Update

| Risk | Severity | Session 9b Status | Session 10 Status |
|------|----------|-------------------|-------------------|
| RISK-1: Superpowers enforcement field fiction | HIGH | OPEN | **RESOLVED** — Option A chosen, all docs amended |
| RISK-2: Missing orchestration loop | HIGH | OPEN | **RESOLVED** — Story 4.0 added |
| RISK-3: Pi SDK credential mechanism misunderstood | MEDIUM | OPEN | **RESOLVED** — ADR-008 amended, Story 2.3 AC rewritten |
| RISK-4: Overstory schema extensions uncovered | MEDIUM | OPEN | **RESOLVED** — Story 1.6 added |
| RISK-5: Migration runner pattern incompatibility | LOW-MEDIUM | OPEN | **RESOLVED** — Story 1.2 AC amended, ownership table added |

All 5 risks from the Session 9b gap analysis are now RESOLVED with explicit document amendments, new stories, and design decisions.

---

*Session 10 Architecture Amendment Notes. These amendments are authoritative and supersede any contradictory text in architecture-v2.md or PRD v2.*
