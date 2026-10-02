# R1 — v5 Story Template Extraction (for v6 story writers)

**Date:** 2026-10-01 · **Agent:** Research Agent 1 (story-pattern) · **Consumer:** v6 derivation session (charter §9.2 step 2)
**Sources read in full:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md` (981 lines), `df3-8-host-completion-watcher.md` (196 lines), `df1-11-in-box-steering-executor.md` (238 lines).
**Substitution note:** the task named `df1-11-steering-seam.md` — no such file exists. The actual DF1.11 story file is `df1-11-in-box-steering-executor.md` (same story, the steering executor); it was used as the third sample and the substitution is faithful (the charter elsewhere cites DF1.11 as the steering-seam owner, §2.1/D-4).

All three samples share one identical section skeleton. Where the task brief and the observed files differ, both are stated.

---

## 1. Exact section skeleton (writers must follow this order)

```markdown
# <STORY-ID>: <Title>                       ← H1, ID matches filename (df6-1b:1, df3-8:1, df1-11:1)

**Story Points:** <n>                        ← bold header block, immediately after H1
**Sprint:** <vN-Sk (arc/context note)>       ← e.g. "v5-S3 (in-box restoration arc, story 5 of 5 — …)"

> **Optional provenance blockquote**          ← only when load-bearing: split provenance (df6-1b:6-18),
                                                tracked follow-up w/ issue # (df3-8:5-16)

## Spec Reference                            ← FIRST body section, always (see §2)
## User Story                                ← As … / I want … / so that …
## Overview                                  ← what the story builds + explicit "What this does NOT deliver" honesty (df3-8:45-52)
## E2E Slice                                 ← three bold-labelled paragraphs (see §3)
## Acceptance Criteria                       ← numbered, Given/When/Then, named-limb tags + negative controls (see §4)
## Trigger Surface                           ← 4-col table (see §5)
## Infra Prerequisites                       ← 3-col table (see §5)
## Technical Notes                           ← named-subsection bullets (see §6)
## Observability Contract                    ← log/event vocabulary, sub-timings, "absent, not 0" rule
## Files to Modify                           ← bullet list w/ ownership annotations (see §7)
## Security Invariants                       ← INV-numbered bullets (see §8)
## Definition of Done                        ← checkbox list (see §9)
## Dev Agent Record                          ← written at impl time, not at spec time (see §10)
## Review Findings (post-merge)              ← appended by the review campaign, not by the writer
```

Ordering is invariant across all three samples (verified via header grep, all 3 files).

## 2. Mandatory header/field conventions

- **Header block fields (bold, top of file):** `**Story Points:**` and `**Sprint:**` — both present in all three samples (df6-1b:3-4, df3-8:3-4, df1-11:3-4).
- **Spec Reference** is the first H2 *body section*, not a header field — but it is mandatory and heavily cited. Convention: every entry names a real artifact with a section/line anchor, split into four recurring move-classes (observed across all three):
  1. the governing spec (`docs/superpowers/specs/…` with §/line refs — df6-1b:22-24, df3-8:20),
  2. the decision register + specific DD-numbers consumed (df6-1b:26-28),
  3. **ancestry disposition** — which phase-1/phase-2 clauses survive verbatim, which are dropped and why (df6-1b:29-35 "P1.19 RE-DERIVE … `:53`'s webhook-signature clause is **not carried**"),
  4. sibling contracts consumed unmodified vs extended, with the consumed module's exported names and line numbers (df1-11:12-14, df3-8:21-23).
  For v6: add a fifth — the charter decision (D-number) and DD-14+ register entries the story implements.
- Sprint line carries arc context ("story 3 of 5 — the first arc story whose value is a closed round trip", df1-11:4).

## 3. E2E Slice — three labelled paragraphs, always the same three

1. `**Demonstrable behavior:**` — Given/When/Then prose naming the exact CLI verbs, exit codes, record fields, and observable artifacts (df3-8:56-66 names the exact JSON log lines).
2. `**Wiring closed:**` — the no-stub claim: "On completion of this story, <behavior> … using only code merged by this story plus <predecessors>. **No stub, no `TODO: wire later`**." (df6-1b:88-93, df3-8:68-75) — plus the explicit out-of-scope boundary ("The **schedule** is out of scope by construction", df3-8:73-75).
3. `**Dependency edges (predecessors):**` — explicit ID list, direct vs transitive edges distinguished (df3-8:77-81: "DF1.10 is a *direct* edge, not one inherited through DF3.7"). Optional follow-up blockquote: "**Not an edge — <ID>:**" with the reason the tempting edge is refused (df3-8:83-86, df6-1b:98-132).

## 4. AC style — numbered limbs, named tags, negative controls

Format rules observed:
- Numbered ACs; the first is usually tagged `**(make-or-break)**` (df3-8:90, df1-11 heritage) or named by limb: `**(the verdict — was DF6.1 AC3)**` (df6-1b:136).
- Every AC is Given/When/Then with concrete literal values (exact field names, exact counts, exact exit codes).
- Negative controls appear **inside the AC body** in italics: `*Negative control: … MUST fail this one.*` — and in DoD items as italic failure predictions. **Two verbatim examples:**

> df6-1b:182-188 (AC1):
> *Negative controls, all four MUST fail:* an implementation reading `bucket` off
> `statusCheckRollup` finds `undefined` on every entry and can never report green; one treating
> `exitCode !== 0` as a hard failure converts every pending poll into one; one filtering on
> `conclusion === "SUCCESS"` over **all** rollup entries drops the requiredness distinction, so an
> advisory lint going red blocks a fix whose required checks are green; one reading requiredness
> from the repository's branch-protection settings needs a **repo-admin** token scope this loop
> deliberately does not take.

> df3-8:90 (AC1):
> *Negative control: an implementation that inlines its own harvest→teardown→reverify sequence reaches the same state, passes a naive "did it reach awaiting-approval?" test, forks the one chain the arc has, and MUST fail this one.*

- Every quantified bound gets its misreading named and forbidden (df6-1b: "charging only attempts that reached CI", with the *Negative control: an implementation that bounds only charged attempts lets an adversarial review comment be re-attempted indefinitely … it MUST fail*, :289-291).
- v6 writers should also note the P2-era precursor (each p2-* AC block opens "> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.") — v5 relaxed "exactly one" into named-limb tagging; keep the v5 form.

## 5. Trigger Surface and Infra Prerequisites tables

Trigger Surface — exact columns (`df6-1b:315`, `df3-8:100`):

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |

Convention: every *conceivable* trigger is enumerated; out-of-scope triggers get `out-of-scope — <reason>` plus `Follow-Up: none in vN.0` or a named successor (df3-8:106-109). This table is the story's self-declared no-creep contract.

Infra Prerequisites — exact columns (`df6-1b:326`, `df3-8:113`):

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |

Convention: each row names the owning story, the *verified* precondition test command (`bun test tests/…` green **before** this story starts, df3-8:115), and read-only/byte-identical postures where the story consumes but must not modify (df3-8:118 "green before and **byte-identical after**"). A closing blockquote states what is explicitly NOT a prerequisite (df6-1b:335-336: "No box, no LLM key and no model spend are prerequisites of this story.").

## 6. Technical Notes conventions (recurring named subsections)

Observed bullets, usable as a menu (not all appear in every story):
- **`**One invocation, one attempt leg.**` / process-shape rule** — the verb-not-process discipline, with the rejected alternative written out "explicitly so a dev does not re-derive it" (df6-1b:340-355).
- **`**Contracts/Schema — …**`** — the run-record extension surface: which fields are registered (adds-only), by whom, in what `FieldKind`, and what stays closed (df6-1b:400-483; df3-8:122 "this story persists **nothing**").
- **`**Guards/limits**`** — every numeric bound enumerated, each named (`PROVISION_LAG_MARGIN_MS`, `MAX_CANDIDATES_PER_PASS`) with its derivation and "named rather than implied" rule (df3-8:125).
- **`**Ordering against …**`** — interaction with sibling processes, thresholds-not-timers honesty (df3-8:123).
- **`**Region ownership on shared files**`** — per-file ownership statement: who owns it, what this story may do (comment-only / adds-only / read-only), and what image-pin ritual is or is not owed (df3-8:124).
- **`**Considered and rejected: …**`** — the rejected design, why, and the revisit trigger measured-not-hypothesized (df3-8:127, df6-1b:165-169).
- **`**Deviation/assumption (Deviation N, binding on this story)…**`** — spec corrections of record, restated "where an implementer will look" (df3-8:24 + :128).
- Honesty conventions: "cited, not restated" for consumed contracts; "absent, not `0`" for un-run sub-timings; accepted risks get "a named threshold with a **named owner and review point**" (df3-8:150).

## 7. Files to Modify conventions

- Bullet list of repo-relative paths; every file annotated: `new`, `adds only`, `comment-only`, or `<ID>-owned — **not modified**` (df3-8:140 explicitly lists a file under Files-to-Modify to state it is NOT modified).
- Tests included in the list, including the live e2e file with its tier rationale (df3-8:144: "Tier 3 deliberately, and the distinction is stated because tier selection drives real spend").
- README bar for P2-era files: ≤10 Files-to-Modify (phase-2/README.md:6); v5 samples stay at or under ~9.

## 8. Security Invariants conventions

- Numbered invariants (`INV-4`, `INV-5`, `INV-6`, `INV-IBOX-17/18/19`) — **bold name + colon + the mechanism**, each citing its ancestry clause (`p1-19:53`) and often naming the negative space: what the invariant deliberately does NOT fence, said plainly (df3-8:148 "What the lock does not fence, said as plainly as DF3.7 said it").
- Inherited invariants are named "inherited verbatim/untouched" — never silently reworded (df3-8:128).
- v6 must seed these from charter §6 (guardrails: ADR-1 approve gate, INV-IBOX/F10/INV-7, AUDIT_HOPS frozen, gateway authz, Jev handoff §8).

## 9. Definition of Done + atomicity constraints

- Checkbox items tagged by kind: `**Impl:**`, `**Test (<name>):**`, `**Contract:**`, `**Security:**`, `**Integration:**`, ending with `**Test (e2e demo — MANDATORY):**` (df3-8:164) with live-gate details (`liveGate("2")`, gating only `"1" | "2"`, df6-1b:836-837).
- Each item frequently embeds its own negative-control failure prediction in italics.
- **Atomicity constraints (binding):** charter §9.2 step 2 verbatim (`2026-10-01-v6-derivation-session-INPUT.md:160`): "atomicity gate: **normative ≤200 lines, ≤8 SP, DOD ≤10 high-signal**". The team-lead brief adds a **≤185-normative-lines target** (tighter than the charter's 200 cap — treat 185 as target, 200 as hard cap). ≤8 SP is charter law; all three samples are 3–5 SP.
- **Observed-reality caveat (do not replicate):** the sampled v5 files *post-date* review growth — df6-1b is 981 lines / 25 DoD items, df3-8 is 196 lines / 11 DoD items, df1-11 is 238 lines / 10 DoD items. The 196/11 and 238/10 files are close to the gate; the 981-line outlier grew through merge-review waves. v6 writers target the charter numbers (≤185 target / ≤200 cap normative lines, ≤8 SP, ≤10 DoD) and push review growth into the Review Findings section rather than the normative body.

## 10. Dev Agent Record conventions (for the derivation session's awareness)

Written at implementation, not at spec time. Dated entries; `**Route:**` line naming the skill + ledger; **Deviations (what-and-why, per AC)**; **Verification** line (tsc/biome/suite counts); **Live rounds** with evidence file paths and spend; **Watch items** closed with evidence. Post-merge: `## Review Findings` with patched/dismissed triage (df3-8:172-196: "66 raw findings → 39 patches … + 16 verified dismissals").

---

## v4 vision clauses (verbatim)

Source: `_bmad-output/planning-artifacts/prd-qds-factory-v4.md` (977 lines). Line numbers are from that file as read 2026-10-01.

**⚠ FLAG (NET-NEW / mis-attribution):** the charter (`2026-10-01-v6-derivation-session-INPUT.md:27`) lists "8 proactive cron agents (QDS-MEM-001/002)" among facts recovered from the v4 PRD. **The v4 PRD contains no "proactive" and no "QDS-MEM" string at all** (verified by grep over the full file). The roster lives in the two design docs the charter's §8 sources table names for it: `docs/planning/hindsight-memory-master-design.md` (QDS-MEM-001) and `docs/planning/hindsight-factory-tier-design.md` (QDS-MEM-002). The roster is extracted from those files below, clearly labeled. Everything else in this section resolves verbatim in the PRD.

### FR-MG-1 (PRD:327)
> - **FR-MG-1:** Each department manager (Dev/QA/Maintenance) can run as a 24/7 tool-loop registered as a Paperclip agent under the root org chart with a budget.

Related phase gate (PRD:642): "1. **Dev manager registered.** Dev manager runs as a 24/7 `hermes_local` agent, `reportsTo` root, with a budget. **Exit:** it appears in the org chart and authenticates REST calls with host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`. *(FR-MG-1, FR-CP-11)*"

### F3 — Post-merge QA (PRD:111)
> - **F3 — Post-merge QA.** A Paperclip event wakes the **Hermes QA manager**, which drives an **Archon** hunter-pack sub-DAG of **Pi** agents (orthogonal lenses, **pi-lens**-driven); findings become **Paperclip issues** + a shared per-repo **Hindsight** bank entry that primes the next Dev implement.

### F4 — Scheduled maintenance (PRD:112)
> - **F4 — Scheduled maintenance.** A **Paperclip** cron routine (`routine_triggers.cron_expression`) wakes the **Hermes Maintenance manager**; an **Archon** sweep sub-DAG runs **Pi** agents (+ **pi-lens**) and opens a refactor/dep-bump PR.

### §9.1 Five nested loops (PRD:566; table PRD:570-576, rows quoted 572-576)

> | **L1 — per-run** | event: each Pi worker turn (`agent_end`) | the diff under edit + pi-lens scan + **LSP `lsp_diagnostics`** (or ast-grep+tests fallback, FR-EX-12) | in-run autofix applied to the worktree; finding emitted in turn-end report | fewer in-run defects (read-before-edit guard + autofix + post-edit diagnostics gate) |  (:572)
> | **L2 — per-story** | event: Archon run start (`agent.run.started`) → recall; run finish (`agent.run.finished`) → retain | shared per-repo bank `{repo}` (recall by issue title+desc); run output (retain) | recall result injected into the implement node's system prompt; run output **retained** with `document_id = runId` | a QA bug reaches Dev's **next** implement via the shared bank |  (:573)
> | **L3 — nightly** | cron: Paperclip routine (`routine_triggers.cron_expression`) | per-bank world/experience memories accumulated that day + Mulch session records | `POST …/consolidate` → **observations**; then `POST …/mental-models/{id}/refresh` (or `trigger.refresh_after_consolidation`) → refreshed mental model | "mental-model refresh": durable beliefs + curated house-style summaries kept current |  (:574)
> | **L4 — weekly** | cron: Paperclip routine | per-manager `*-meta` banks (`{repo}-dev-meta` / `-qa-meta` / `-maint-meta`) — router decisions scored by cost/quality | `qds-model-router` config (archetype + per-role tier + escalation thresholds) + skill updates | tune which model tier won on cost/quality; evolve skills |  (:575)
> | **L5 — measured** | cron: dashboard refresh (NFR-OBS-4 cadence) | Paperclip `cost_events` + issue status transitions + `heartbeat_runs` + pi-lens TDI series | the four KPI series rendered on the dashboard | the **proof** — the yield curve |  (:576)

Authority note (PRD:578): "consolidation and mental-model refresh are **bank-deduped** server-side (operations.md) — concurrent nightly triggers against the same bank coalesce into one job, so the cron routine may fire idempotently without stacking."

### L3 nightly consolidate — additional grounding (PRD:564, excerpt)
> The nightly L3 loop's "consolidate" and "mental-model refresh" are **real first-class operations**, not invented: `POST …/consolidate` produces **observations** (deduplicated, evidence-grounded beliefs), and `POST …/mental-models/{id}/refresh` re-runs a mental model's `source_query` (operations.md: `consolidation`, `refresh_mental_model`; mental-models.md).

### L4 weekly reflect → PROPOSE (never auto-apply) (PRD:420)
> - **FR-LEARN-30:** A **weekly Paperclip cron routine** reads the outcome records (FR-LEARN-28) and the `{repo}-*-meta` Hindsight banks, produces a human-readable rationale summary via `reflect`, and **proposes (does NOT auto-apply) a `qds-model-router` config change**, recorded to the manager's `*-meta` bank (extends FR-MG-10). The operator reviews and applies the change manually; nothing is promoted to production automatically in v4.

Reinforced (PRD:603): "(3) a **weekly cron rationale summary** that *proposes* (never auto-applies) a router change for operator review (FR-LEARN-30)"; and (PRD:605): "**there is no auto-promotion of any config in v4**; the weekly proposal (FR-LEARN-30) is operator-applied."

### FR-LEARN-30 (model routing) — see L4 block above (PRD:420, quoted verbatim).

### FR-LEARN-33 — yield-curve KPIs + Goodhart counter-metrics (PRD:423)
> - **FR-LEARN-33 (Goodhart guard):** Every yield KPI (§9.2) is **displayed with its paired counter-metric** — first-pass-accept with **escaped-defect rate** (Phase-2 QA dependent); cost/story with **cost-per-accepted-PR**; retry-count with **unclassified-restart rate**; TDI with **pi-lens warning count**. **No KPI panel renders without its pair** (NFR-OBS-6; R15 mitigation). *(v4 subset of the v5 FR-LEARN-19 full guard set.)*

The four KPIs with directions (PRD:865): "the yield-curve chart renders all four KPIs with correct direction (TDI ↓, cost/story ↓, first-pass-accept ↑, retry-count ↓), each with its FR-LEARN-33 paired counter-metric". Enforcement (PRD:735, NFR-OBS-6(b)): "*Threshold: 4/4 yield KPIs show a paired counter-metric.*"

### FR-MEM-6 — GitNexus refresh cadence (PRD:380)
> - **FR-MEM-6:** The system can keep the GitNexus knowledge graph current via a scheduled refresh agent that spins up every **4–6h**, runs `gitnexus analyze`, and spins down — so agents always traverse a near-current graph (staleness bounded by NFR-OBS-5). `gitnexus analyze` builds into a **staging index and atomically swaps** the active graph on completion (in-flight agent queries complete against the pre-swap snapshot — no torn reads); if atomic swap is unavailable in the installed GitNexus, the refresh routine instead takes an **advisory lock** and the Maintenance scheduler must not fire a refresh while a graph-consuming DAG run is active for that repo. **[graph refresh routine]**

Threshold (PRD:734, NFR-OBS-5): "The GitNexus knowledge graph is refreshed on a **4–6h cadence** … **staleness = time since the last *completed* analyze**, kept **≤8h** … *Threshold: 0 agent runs against a graph whose last completed analyze is >8h old; each refresh cycle logs success/failure, duration, and the indexed HEAD SHA.*"

### QDS-MEM-001/002 proactive-agent roster — **NOT in the PRD** (see FLAG above)

QDS-MEM-001 per-project fleet — verbatim from `docs/planning/hindsight-memory-master-design.md:34-41`:
> **Four proactive agents** elevate the system from reactive (recall/reflect on demand) to proactive (the system discovers insights without being asked):
>
> | Agent | Function | Schedule | Orthogonal Question |
> |-------|----------|----------|---------------------|
> | **Synthesizer** | Cross-bank pattern mining + drift surveillance | Weekly | "What correlations exist across banks that no human would think to query for?" |
> | **Meta-Optimizer** | Self-improvement feedback loop | Biweekly | "Is our improvement process itself improving?" |
> | **Blind Spot Detector** | Completeness audit via absence detection | Monthly | "What should we know but don't?" |
> | **Review Harvester** | External review mining (CodeRabbit, Gemini Code Assist) | Every 3 days | "What do external reviewers consistently catch that our coding agents consistently miss?" |

QDS-MEM-002 factory-wide fleet — from `docs/planning/hindsight-factory-tier-design.md` §6 (agents at :380, :460, :548, :631; comparison row :1284 "4 per project | 4 factory-wide"):

| Agent | Schedule (from the file) |
|---|---|
| `cross-project-synthesizer` (:384-385) | Weekly Wednesday 03:11 (`11 3 * * 3`) |
| `factory-optimizer` (A/B runner) (:464-465) | Biweekly 2nd and 16th 03:23 (`23 3 2,16 * *`) |
| `portfolio-review-harvester` (:552-553) | Every 3 days 03:31 (`31 3 */3 * *`) |
| `factory-blind-spot` (:631-635) | Monthly 2nd 03:07 (`7 3 2 * *`) |

4 + 4 = the "8 proactive cron agents" the charter's gap-count cites. Charter DD-23 (§4.2 item 10) parks "Synthesizer/Meta-Optimizer/BlindSpot (+ factory-tier four)" with dated triggers — consistent with this roster; the Review Harvesters (both tiers) are the two members DD-23's list does not name explicitly.
