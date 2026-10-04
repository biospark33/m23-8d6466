# Phase 3 — Wrap-up (Adversarial Auto-Iteration + Domain Checklists)

> **Source of truth.** This file augments the Phase 3 wrap-up described in
> `.claude/commands/skills/qds-sprint-planning.md`. The flat skill file
> references this step file at the **top of Phase 3**, BEFORE any commit
> or PR creation. The wrap-up cannot finish until the loop below exits
> (either by convergence or by surfacing a disposition table to the operator).

---

## Why this step exists

A single adversarial pass catches real structural issues but leaves
others that later surface as many PR review rounds.

**Hypothesis:** Adversarial review surfaces a fresh layer of findings
each time it runs against rewritten content. One pass is never enough.
Two-to-three passes converge — and the convergence criterion itself is
a signal that the spec is sound.

**Mechanism (delegated).** Spawn one self-contained pipeline
subagent per story; each iterates an adversarial review (assume the spec
is wrong; hunt for gaps, contradictions and unstated assumptions) over
its own file(s) until findings stabilize OR the iteration cap is hit, and
`Edit`s the file in place each round (NOT a separate commit — the fixes
land in the Phase 2 output before the wrap-up commit). The orchestrator
passes paths + checklists and collects structured verdicts only; it never
holds story text or re-writes artifacts itself.

---

## Inputs

Phase 3 is entered with these artifacts in hand:

- All story files written in Phase 2 (`_bmad-output/sprint-artifacts/sprint-{N}/stories/*.md`)
- Brief epic summaries staged for insertion into the epic index (`{EPIC_INDEX}`, resolved in Phase 0 — e.g. `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v6.md`)
- Sprint-status entries staged for `_bmad-output/sprint-artifacts/sprint-status.yaml`
- Epic definition block targeted in `{EPIC_INDEX}`

---

## Step 3.0 — Domain-Trigger Detection (load checklists)

Before the first adversarial pass, scan the story files **and** the
epic definition for domain-trigger keywords. For each match, load the
matching checklist from
`.claude/skills/qds-sprint-planning/checklists/<domain>.md` and append
its checklist items to the **also_consider** input passed to
the adversarial review in Step 3.1.

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
  epic header/definition in `{EPIC_INDEX}`. Word-boundary match preferred
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

```text
🛡  Domain checklists active: rls-invariants, migration-invariants
   (triggered by: "RLS policy" in story sprint-X/stories/foo.md,
                  "alembic migration" in epic definition)
```

---

## Step 3.0.5 — Generate `shared_pattern_note` (orchestrator, before 3.1a)

Step 3.1a passes each per-story subagent a `shared_pattern_note` — a ≤10-line digest of the load-bearing patterns every story in this epic must agree on (auth, multi-tenancy, schema keys, event names, file ownership). The orchestrator generates it ONCE, before spawning any 3.1a agent, so every per-story reviewer and the single 3.1b cross-story agent share the same definition of "consistent."

**Procedure:**

1. **Scan the epic definition block** — the project's epic index file (`{EPIC_INDEX}`: the `index:` key in `sprint-status.yaml`, else the matching `_bmad-output/implementation-artifacts/epics-and-stories-*.md`) — for the cross-cutting mandates every story inherits — the auth/capability model, the tenant-binding column, naming conventions, and the audit-event vocabulary. These are epic-level and apply to every story.
2. **Scan each story file's load-bearing headers** for the tokens that must not drift between stories:
   - **Technical Notes → Contracts/Schema**: primary-key convention, tenant-binding column, table names, enum values.
   - **Integration points**: `event_type` vocabulary, `run_id` format, queue/topic names.
   - **Files to Modify**: which story owns which module (file ownership).
   - **Security Invariants**: auth allowlist source, audit-column non-null-FK requirements.
3. **Compress to ≤10 lines** — one pattern per line, each tagged with its source so a reviewer can verify the token against the originating story/epic rather than trusting the digest.
4. **Conflict resolution**: if two stories disagree on a token (e.g., Story A binds the tenant on `graph_id`, Story B on `tenant_id`), do NOT silently pick one — surface it as a cross-story HIGH finding for the 3.1b agent. That contradiction is precisely what the cross-story agent catches.

**Sample `shared_pattern_note` (≤10 lines, illustrative):**

```text
shared_pattern_note:
  tenant_key: experiments.graph_id               # source: epic §4.1
  pk_fmt: <table>_id uuid, default gen_random_uuid()   # source: convention
  status_enum: proposed|approved|running|analyzed|deployed|confirming|confirmed|rolled_back|rejected  # P2.9 §C
  event_vocab: event_type='outcome' per transition     # source: P2.1 store
  run_id_fmt: experiment:<id> lifecycle run            # source: P2.9
  authz: QDS_EXP_ACTORS env allowlist → approved_by    # source: P2.9 INV-EXP1
  audit_fk: events.run_id NOT NULL → runs (INV-OM2)    # source: epic invariants
  state_machine_owner: src/experiments/state-machine.ts # source: P2.9 (R10)
  file_owner: src/optimizer/* → P2.10/P2.11            # source: story Files-to-Modify
```

**Pattern-type → source map** (keeps generation consistent across runs):

| Pattern type | Source |
|---|---|
| auth / capability model | Epic block (cross-cutting) + story Security Invariants |
| multi-tenancy / tenant binding | Epic block + story Contracts/Schema (Technical Notes) |
| schema keys (PK/FK/enum) | Story Technical Notes → Contracts/Schema |
| event names / `run_id` format | Story Integration points + epic event vocabulary |
| file ownership (module → story) | Story "Files to Modify" sections |

The note is a **review aid, not a new source of truth** — if it disagrees with a story file, the story file wins and the note is corrected.

**Ground the note in greps, not memory.** Before writing the
note, the orchestrator runs cheap mechanical scans over the story files
for the drift-prone tokens (enum spellings, unit names, verb lists,
ref-path formats, module roots): `grep -ho` + `sort | uniq -c` per
token class. Tokens that scan clean go into the note as verified;
tokens that scan mixed are flagged as suspects for the 3.1a/3.1b agents
("verify, don't assume — contradiction = HIGH"). Costs a few hundred
tokens; catches gross drift before any judgment agent spends a context
window on it.

## Step 3.1 — Per-Story Adversarial Pipeline (delegated, structured)

> **Token contract.** The orchestrator does **NOT** read story
> bodies into its own context and does **NOT** re-write artifacts inline.
> It spawns one **self-contained pipeline subagent per story** (or per
> 2-story writer batch), passes **file paths + the checklist payload**,
> and receives a **structured verdict** — never a re-emitted story body.
> Each subagent owns the full review→fix→verify cycle in its own context
> and `Edit`s the story file **in place**. This replaces the old
> orchestrator-rewrites-in-place loop, which re-emitted every story body
> ×N iterations in the main loop (the dominant token sink — see the
> v1.3.0 changelog). Levers applied: delegate fixes (1), collapse
> review→fix→verify into one agent (2), paths-not-contents (3),
> structured-output verdicts (4).

### 3.1a — Per-story pipeline subagent (one per story / writer batch)

Spawn all per-story pipeline agents **in parallel in a single message**.
Each agent's contract:

```text
INPUTS (paths + data only — NO story bodies in the orchestrator prompt):
  - story_file_path(s): the 1–2 story files this agent owns
  - also_consider: the domain-checklist markdown from Step 3.0 (verbatim)
  - sibling_story_paths: paths (not contents) of the other stories, for
    cross-story awareness of shared patterns
  - shared_pattern_note: ≤10-line summary of load-bearing shared patterns
    (auth, multi-tenancy, schema keys, event names, file ownership)

LOOP (max 3 internal iterations, entirely inside the subagent's context):
  1. Read the owned story file(s).
  2. Adversarially review (assume the spec is wrong; hunt for gaps and
     contradictions — apply the severity heuristics table below +
     also_consider checklists).
  3. if count(HIGH)==0 AND count(MEDIUM)<=3: converged → break.
  4. if iteration < 3: Edit the file IN PLACE to resolve HIGH→MEDIUM
     findings; re-validate spec refs; continue.
     else (iteration 3 did not converge): do NOT edit further — return
     surviving findings for the operator disposition table.

RETURN (structured verdict — JSON, NOT prose, NOT the story body).
**SPL-026: the subagent MUST also `Write` this same JSON to
`_bmad-output/workflow-state/qds-sprint-planning/{epic}-{track}/verdicts/<batch>.json`
BEFORE returning** — a final-text-only verdict is unreachable from the
orchestrator once the background agent completes (idle notifications
carry no content; retrofitting via follow-up messages races completion
and costs a resume round-trip per agent). The disk copy is also what
makes re-aggregation and resume possible without transcripts.
  {
    "schemaVersion": 1,
    "story": "P2.3",
    "owned_story_ids": ["P2.3"],
    "iterations": 3,
    "converged": false,
    "final": { "high": 1, "medium": 1, "low": 4 },
    "applied":   [ { "severity": "HIGH", "line": 88, "summary": "...",
                     "owned_story_ids": ["P2.3"], "affected_story_ids": ["P2.3"],
                     "owner_story_id": "P2.3", "cross_boundary": false } ],
    "surviving": [ { "severity": "HIGH", "line": 140,
                     "summary": "tenant key drifts to P2.9's graph_id",
                     "owned_story_ids": ["P2.3"], "affected_story_ids": ["P2.9"],
                     "owner_story_id": "P2.9", "cross_boundary": true } ],
    "checklists_fired": [ "migration-invariants" ]
  }
  # Finding fields (machine-readable cross-boundary routing):
  #   owned_story_ids    stories whose files the reporting agent owns
  #   affected_story_ids every story whose spec the finding touches
  #   owner_story_id     the single story that OWNS the fix (subsystem owner)
  #   cross_boundary     true iff owner_story_id not in owned_story_ids —
  #                      exactly the 3.1b queue inputs (build the queue from
  #                      these fields, NOT by parsing prose / the singular
  #                      `story` field)
```

The subagent edits files directly, so its fixes are already on disk when
it returns. The orchestrator never holds story text — it aggregates from
the `verdicts/` directory.

### 3.1b — Cross-story consistency agent (one, after 3.1a returns)

After all per-story agents return, spawn **one** cross-story consistency
subagent. It receives the **paths** of all final story files +
`sprint-status.yaml` + the epic block, **plus an explicit work queue built
from the structured 3.1a finding fields: every surviving finding where
`cross_boundary == true` AND `owner_story_id` is NOT in the reporting
agent's `owned_story_ids`** (the queue is selected from
`owned_story_ids` / `affected_story_ids` / `owner_story_id` /
`cross_boundary`, not by parsing finding prose or the singular `story`
field; per-story agents legitimately leave cross-boundary findings as
"surviving", and without the queue handoff they are silently dropped). The cross-story agent **verifies each queue
item's attribution before fixing** — attributions can be wrong; the subsystem's owner wins, but the owner of a
subsystem is not automatically the owner of another story's description
of it. It checks for contradictions in shared patterns (auth,
multi-tenancy, schema keys, naming, file ownership, event names),
`Edit`s any file in place to resolve a contradiction, and returns the
same structured-verdict shape with a `cross_story` finding list —
**also Written to `verdicts/cross-story.json` per the 3.1a rule**. No
story bodies cross the orchestrator.

### 3.1c — Orchestrator aggregation (data only)

```text
expected_batches = [ every story/writer-batch dispatched in 3.1a ] + [ "cross-story" ]
found = read_verdict_files(verdicts/*.json)

if found does not have exactly one schema-conforming verdict per expected batch
   (missing file, duplicate batch, or JSON that fails the verdict schema —
   `schemaVersion: 1`, requiring `owned_story_ids`/`affected_story_ids`/
   `owner_story_id`/`cross_boundary` on every finding and `iterations`/
   `converged`/`checklists_fired` at the top level, per 3.1a's shape):
    HALT before commit — report which batch(es) are missing/invalid; do NOT
    aggregate or proceed to Step 3.2/3.3 on a partial verdict set.

verdicts = [ per-story verdicts from 3.1a ] + [ cross-story verdict from 3.1b ]

if any verdict has surviving HIGH OR final.medium > 3 OR a cross-story HIGH:
    surface_disposition_table_to_operator(verdicts)   # Step 3.2
    HALT — wrap-up does NOT proceed to commit until operator decides.
else:
    log "✅ Adversarial review converged (per-story pipeline)"
    log convergence table built from verdicts:
        | story | iters | HIGH | MEDIUM | LOW | checklists |
    proceed to Step 3.3
```

The orchestrator routes **by the structured verdict fields**. It does not
re-summarize prose findings and does not re-emit story content.

### Severity heuristics (for the categorize step)

| Severity | What qualifies | Examples |
|---|---|---|
| **HIGH** | Structural defect that would create a load-bearing regression if shipped | Migration chain non-linearizable; dependency cycle between stories; missing acceptance criterion for a stated user behavior; missing DOD category; capability/auth gate absent on a write path; cross-story contradiction (e.g., Story 3 uses `graph_id` for tenant binding; Story 5 uses `tenant_id`) |
| **MEDIUM** | Clarity / completeness gap without immediate correctness risk | Ambiguous wording in AC ("system should handle errors"); missing spec reference; undefined acronym; contract field type unspecified but inferable; missing test fixture mention |
| **LOW** | Cosmetic, style, formatting | Typos; inconsistent header levels; trailing whitespace; bullet style |

The thresholds (`HIGH == 0 AND MEDIUM <= 3`) are tuned to converge in
2–3 iterations on a well-researched epic. If you find yourself
consistently hitting iteration 3 with MEDIUMs surviving, that is a
signal Phase 1 research was thin — surface it in the wrap-up summary.

---

## Step 3.2 — Disposition Table (operator surface when loop doesn't converge)

If aggregation (Step 3.1c) finds any per-story verdict with surviving
HIGH, `final.medium > 3`, or a cross-story HIGH, print this table —
built from the structured verdict fields, not from re-read story text —
and HALT:

```text
⚠️  Adversarial review did not converge after 3 iterations.

| # | Severity | Artifact | Finding | Proposed Disposition |
|---|---|---|---|---|
| 1 | HIGH   | df4-1-visualizer-port.md       | Missing AC for streaming-cancel behavior | Add AC4 / Accept as known gap / Defer to follow-up |
| 2 | HIGH   | sprint-status.yaml             | Story df4-3 lists points but no dependency on df4-1 | Update dep / Confirm independent / Investigate |
| 3 | MEDIUM | epic index (DF4 block)         | Epic header missing total-points field            | Backfill / Defer |
| 4 | MEDIUM | df4-2-fleet-status-view.md      | Spec reference to §4.2 but section is §4.2.1      | Fix reference / Confirm intentional |
| 5 | MEDIUM | df4-5-run-schema.md            | Zod schema for RunOutput uses `z.any()`           | Tighten type / Confirm any is intentional         |
| 6 | MEDIUM | df4-1-visualizer-port.md        | Token-budget claim not benchmarked                | Add benchmark task / Accept claim / Soften wording |

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
2. Epic index (`{EPIC_INDEX}`) brief summaries inserted/updated
3. `sprint-status.yaml` entries written (epic + story status =
   `ready-for-dev`)
4. Feature branch created (`feature/epic-{EPIC}-stories`)
5. Single commit: `feat(epic-{EPIC}): write enterprise-grade stories`
6. Push + open PR to `dev`
7. Save session transcript for `/reflect`

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
