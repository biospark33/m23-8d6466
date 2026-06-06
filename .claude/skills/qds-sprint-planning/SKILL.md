---
name: qds-sprint-planning-resources
description: Phase 3 wrap-up step + pluggable domain-invariant checklists used by the qds-sprint-planning skill. Loaded as references — NOT invoked directly. See `.claude/commands/skills/qds-sprint-planning.md` for the canonical skill definition.
version: 1.2.0
author: biospark33
last_updated: 2026-05-16
---

# qds-sprint-planning — Reference Resources

This directory holds the resources that the canonical qds-sprint-planning
skill loads during Phase 3. The skill itself lives at
`.claude/commands/skills/qds-sprint-planning.md`.

## Contents

```
.claude/skills/qds-sprint-planning/
├── SKILL.md                 # this file (index)
├── steps/
│   └── phase-3-wrap-up.md   # adversarial auto-iteration loop spec
└── checklists/
    ├── rls-invariants.md
    ├── migration-invariants.md
    ├── auth-invariants.md
    ├── secrets-invariants.md
    └── input-invariants.md
    # (pii-invariants.md and payments-invariants.md are planned for a follow-up.)
```

## Phase 3 wrap-up step

`steps/phase-3-wrap-up.md` documents the mandatory adversarial-review
iteration loop that runs BEFORE any commit / PR step in Phase 3. It:

- Scans story files + epic definition for domain-trigger keywords.
- Loads matching checklists from `checklists/` as `also_consider` input
  to `bmad-review-adversarial-general`.
- Iterates up to 3 times until findings converge
  (`HIGH == 0 AND MEDIUM <= 3`).
- Surfaces a disposition table to the operator if convergence fails.

## Domain-invariant checklists

Each file in `checklists/` is a Markdown list of invariants for one
domain. When a story or epic mentions the trigger keywords for that
domain, Phase 3 loads the file verbatim into the `also_consider`
payload passed to the adversarial-review agent. The trigger map lives
in `steps/phase-3-wrap-up.md` §3.0.

| Checklist | Triggers |
|---|---|
| `rls-invariants.md` | `rls`, `row-level security`, `RLS policy` |
| `migration-invariants.md` | `migration`, `migrations`, `alembic`, `DDL`, `schema change` |
| `auth-invariants.md` | `auth`, `authn`, `authz`, `rbac`, `capability`, `authentication`, `authorization` |
| `secrets-invariants.md` | `encryption`, `secret`, `secrets`, `KMS`, `vault` |
| `input-invariants.md` | `upload`, `uploads`, `deserialization`, `file handling` |

## Adding a new checklist

1. Create `checklists/<domain>-invariants.md` with the same shape as
   the existing checklists (per-resource invariants, cross-story
   invariants, test invariants, documentation invariants).
2. Add a row to the trigger table in `steps/phase-3-wrap-up.md` §3.0.
3. Add a row to the table in this file.
4. Run `/reflect` to record the new SPL learning so
   `.claude/learnings/qds-sprint-planning/patterns.yml` is updated
   via the learnings workflow (preserving provenance/metadata).
   Reference the new checklist + the incident that motivated it in
   the reflection.

## Related

- Canonical skill: `.claude/commands/skills/qds-sprint-planning.md`
- Adversarial review skill: `.claude/skills/bmad-review-adversarial-general/SKILL.md`
- Patterns: `.claude/learnings/qds-sprint-planning/patterns.yml` (see SPL-024)
- Origin issue: GitHub #1432
- Source incident: `_bmad-output/sprint-artifacts/sprint-62/epic-rbac-1-retro-skill-audit-2026-05-13.md` §4.5
