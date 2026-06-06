# Phase 3 — Wrap-up (Adversarial Auto-Iteration + Domain Checklists)

> **Source of truth.** This file augments the Phase 3 wrap-up described in
> `.claude/commands/skills/qds-sprint-planning.md`. The flat skill file
> references this step file at the **top of Phase 3**, BEFORE any commit
> or PR creation. The wrap-up cannot finish until the loop below exits
> (either by convergence or by surfacing a disposition table to the operator).
>
> See also `_bmad-output/sprint-artifacts/sprint-62/epic-rbac-1-retro-skill-audit-2026-05-13.md` §4.5
> for the failure mode this loop is designed to prevent
> (one-shot manual adversarial review missed structural issues that took
> 50+ subsequent CR/Gemini rounds to surface).

---

## Why this step exists

Epic RBAC-1's planning chain ran `bmad-review-adversarial-general`
**once** — and it caught real structural issues (commit `99cce9d3b`:
"adversarial review fixes — linearize Alembic chain, scope"). But the
manual chain stopped after that single pass, and the next 50+ rounds of
CodeRabbit / Gemini PR feedback caught issues the single adversarial
pass missed.

**Hypothesis:** Adversarial review surfaces a fresh layer of findings
each time it runs against rewritten content. One pass is never enough.
Two-to-three passes converge — and the convergence criterion itself is
a signal that the spec is sound.

**Mechanism:** Auto-iterate `bmad-review-adversarial-general` over the
Phase 2 outputs until findings stabilize OR the iteration cap is hit.
Apply each round's findings as a re-write pass (NOT a separate commit —
integrate into the Phase 2 output before the wrap-up commit).

---

## Inputs

Phase 3 is entered with these artifacts in hand:

- All story files written in Phase 2 (`_bmad-output/sprint-artifacts/sprint-{N}/stories/*.md`)
- Brief epic summaries staged for insertion into `_bmad-output/epics.md`
- Sprint-status entries staged for `_bmad-output/sprint-artifacts/sprint-status.yaml`
- Epic definition block targeted in `_bmad-output/epics.md`

---

## Step 3.0 — Domain-Trigger Detection (load checklists)

Before the first adversarial pass, scan the story files **and** the
epic definition for domain-trigger keywords. For each match, load the
matching checklist from
`.claude/skills/qds-sprint-planning/checklists/<domain>.md` and append
its checklist items to the **also_consider** input passed to
`bmad-review-adversarial-general` in Step 3.1.

| If story-or-epic text matches (case-insensitive) | Load checklist |
|---|---|
| `rls`, `row-level security`, `RLS policy` | `rls-invariants.md` |
| `migration`, `migrations`, `alembic`, `DDL`, `schema change` | `migration-invariants.md` |
| `auth`, `authn`, `authz`, `rbac`, `capability`, `authentication`, `authorization` | `auth-invariants.md` |
| `encryption`, `secret`, `secrets`, `KMS`, `vault` | `secrets-invariants.md` |
| `pii`, `gdpr`, `personal data` | `pii-invariants.md` *(planned — not yet shipped; skip silently if absent)* |
| `payment`, `payments`, `billing`, `financial` | `payments-invariants.md` *(planned — not yet shipped; skip silently if absent)* |
| `upload`, `uploads`, `deserialization`, `file handling` | `input-invariants.md` |
| *(no match)* | *(no domain checklist; core adversarial review only)* |

**Implementation notes:**

- Match against the full text of every story file in the batch + the
  epic header/definition in `epics.md`. Word-boundary match preferred
  (`\brls\b`, not substring), to avoid false-positive matches like
  "carls" or "RBAClist".
- Multiple matches → load multiple checklists. They compose by
  concatenation of their items into the `also_consider` payload.
- Missing checklist file → skip silently and continue (a domain may
  be planned but not yet shipped; see the table above for which are
  intentionally deferred — emitting a warning every Phase 3 run would
  add noise for known-deferred domains).
- Checklist contents are themselves Markdown — pass them verbatim into
  `also_consider`. Do not re-summarize.

**Operator-visible output:**

```
🛡  Domain checklists active: rls-invariants, migration-invariants
   (triggered by: "RLS policy" in story sprint-X/stories/foo.md,
                  "alembic migration" in epic definition)
```

---

## Step 3.1 — Adversarial Iteration Loop (max 3 iterations)

```
loaded_checklists = result of Step 3.0
for iteration in 1..3:

  # 1. Invoke adversarial review
  findings = invoke bmad-review-adversarial-general with:
    content =
      - Each story file (reviewed individually)
      - Cross-story consistency review (all story files together —
        check for contradictions in shared patterns: auth, multi-tenancy,
        schema, naming, file ownership, event names)
      - Sprint-status.yaml entries staged for insertion
      - Epic definition block in epics.md targeted for update
    also_consider = concatenation of loaded_checklists (from Step 3.0)

  # 2. Categorize findings by severity
  for finding in findings:
    if finding is STRUCTURAL (e.g. linearizable migration chain broken,
                              dependency cycle, missing AC, missing DOD
                              category, capability/auth bypass risk,
                              cross-story contradiction):
      severity = HIGH
    elif finding is CLARITY (e.g. ambiguous wording, missing spec
                             reference, undefined acronym, contract
                             type mismatch with no security/correctness
                             impact):
      severity = MEDIUM
    else:
      severity = LOW   # typos, style nits, formatting

  # 3. Exit condition (convergence)
  if count(HIGH) == 0 AND count(MEDIUM) <= 3:
    log "✅ Adversarial review converged after iteration {iteration}"
    log f"   HIGH=0  MEDIUM={count(MEDIUM)}  LOW={count(LOW)}"
    break

  # 4. Apply findings as a re-write pass (iterations 1–2 only)
  #    NOT a separate commit. The wrap-up commit will include the
  #    final converged state of the story files / sprint-status /
  #    epic block — re-writes here are integrated into the same
  #    Phase 2 output that Step 3.2+ will commit.
  #
  #    Iteration 3 is RESERVED for surfacing surviving findings to
  #    the operator — the loop does NOT auto-apply fixes on the
  #    third pass. Auto-applying on iteration 3 would mutate the
  #    artifacts before the operator can decide between
  #    [a]pply / [r]e-iterate / [e]dit / [q]uit, which contradicts
  #    the disposition-table semantics in Step 3.2.
  if iteration < 3:
    for finding in findings ordered by severity (HIGH → MEDIUM → LOW):
      re-write the affected artifact in place to address the finding
      re-validate spec references / cross-story consistency
    log f"🔄 Iteration {iteration}: applied {count(findings)} fixes — re-running review"
  else:
    # Iteration 3 did not converge — HALT without applying fixes.
    # The operator chooses the disposition in Step 3.2; only after
    # an explicit [a]pply do the re-writes execute.
    surface_disposition_table_to_operator(findings)
    HALT — wrap-up does NOT proceed to commit until operator decides.
```

### Severity heuristics (for the categorize step)

| Severity | What qualifies | Examples |
|---|---|---|
| **HIGH** | Structural defect that would create a load-bearing regression if shipped | Alembic chain non-linearizable; dependency cycle between stories; missing acceptance criterion for a stated user behavior; missing DOD category; capability/auth gate absent on a write path; cross-story contradiction (e.g., Story 3 uses `graph_id` for tenant binding; Story 5 uses `tenant_id`) |
| **MEDIUM** | Clarity / completeness gap without immediate correctness risk | Ambiguous wording in AC ("system should handle errors"); missing spec reference; undefined acronym; contract field type unspecified but inferable; missing test fixture mention |
| **LOW** | Cosmetic, style, formatting | Typos; inconsistent header levels; trailing whitespace; bullet style |

The thresholds (`HIGH == 0 AND MEDIUM <= 3`) are tuned to converge in
2–3 iterations on a well-researched epic. If you find yourself
consistently hitting iteration 3 with MEDIUMs surviving, that is a
signal Phase 1 research was thin — surface it in the wrap-up summary.

---

## Step 3.2 — Disposition Table (operator surface when loop doesn't converge)

If iteration 3 ends with surviving HIGH findings or > 3 MEDIUM findings,
print this table and HALT:

```
⚠️  Adversarial review did not converge after 3 iterations.

| # | Severity | Artifact | Finding | Proposed Disposition |
|---|---|---|---|---|
| 1 | HIGH   | a7-1-writing-agent.md         | Missing AC for streaming-cancel behavior | Add AC4 / Accept as known gap / Defer to follow-up |
| 2 | HIGH   | sprint-status.yaml             | Story a7-3 lists points but no dependency on a7-1 | Update dep / Confirm independent / Investigate |
| 3 | MEDIUM | epics.md (A7 block)            | Epic header missing total-points field            | Backfill / Defer |
| 4 | MEDIUM | a7-2-qa-agent.md               | Spec reference to §4.2 but section is §4.2.1      | Fix reference / Confirm intentional |
| 5 | MEDIUM | a7-5-tool-spec.md              | Pydantic schema for ToolOutput uses `Any`         | Tighten type / Confirm Any is intentional         |
| 6 | MEDIUM | a7-1-writing-agent.md          | Token-budget claim not benchmarked                | Add benchmark task / Accept claim / Soften wording |

Operator options:
  [a] Apply suggested dispositions and proceed to commit
  [r] Re-run one more adversarial iteration manually
  [e] Edit specific stories and re-run wrap-up
  [q] Abort wrap-up (drops all Phase 2/3 work; revisit Phase 1 research)

Choose [a/r/e/q]:
```

The operator's choice is recorded in the session transcript so
`/reflect` can pick up patterns (e.g. recurrent MEDIUM finding category
→ candidate for promotion to a new domain checklist).

---

## Step 3.3 — Continue with Existing Phase 3 Wrap-up Sequence

After the loop converges (or the operator selects `[a]`), proceed with
the existing Phase 3 sequence already documented in the flat skill file:

1. Individual story files finalized in `sprint-{N}/stories/`
2. `epics.md` brief summaries inserted/updated
3. `sprint-status.yaml` entries written (epic + story status =
   `ready-for-dev`)
4. `CLAUDE.md` current-status line updated
5. Feature branch created (`feature/epic-{EPIC}-stories`)
6. Single commit: `feat(epic-{EPIC}): write enterprise-grade stories`
7. Push + open PR to `dev`
8. Save session transcript for `/reflect`

The adversarial-review iteration log (counts per iteration, dispositions
taken) is appended to the PR body so reviewers can see what was caught
before code review.

---

## Telemetry to capture for `/reflect`

Each Phase 3 run records to the session transcript:

- Iterations executed (1, 2, 3)
- Convergence point (HIGH count, MEDIUM count at exit)
- Domain checklists loaded (which ones, which triggers fired)
- Disposition table emitted? (yes/no; if yes, operator choice)
- Recurring finding categories (for pattern-promotion candidates)

This data is what powers the SPL-024 pattern in `patterns.yml` and
seeds the next round of new domain-checklist authorship.
