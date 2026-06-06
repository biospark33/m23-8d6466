# QDS-Factory PRD v4 — Gap Resolution Handoff

**Purpose:** New session. Fix identified gaps in `prd-qds-factory-v4.md`, incorporate into PRD, maintain full internal/external consistency. Use parallel sub-agents to preserve main context.

**Repo:** `~/QDS-Factory/` — branch `main` (clean, just merged PR #9).
**PRD:** `_bmad-output/planning-artifacts/prd-qds-factory-v4.md` — 946 lines, authoritative artifact.
**Prior analysis session:** PhD-level gap review completed. Findings are in this prompt. Do not re-derive them; act on them.

---

## OPERATING RULES (non-negotiable)

1. **Sub-agent everything investigative.** Main context = synthesis + PRD edits only. Spawn parallel sub-agents (via Agent tool) for every research/investigation task. Each sub-agent returns a structured report; main session decides what to write.
2. **Grep before you cite.** Never assert a file path, function name, table column, or API method without running a grep or read to confirm it exists. State confidence level (HIGH / MODERATE / LOW) per finding.
3. **No invented APIs.** If a capability is unverified, say so. The PRD's ground-truth discipline is the whole point — don't soften corrections.
4. **Additive-only edits to FR/NFR IDs.** Existing IDs are never renumbered, never deleted. New FRs appended at end of their section group with the next available number. New NFRs appended at end of their category.
5. **All edits maintain the cross-reference system.** Every new FR cited by at least one NFR, Risk, or Phase delivery item. Every new Risk has a cross-ref line at bottom of §14.
6. **Layer-B simplification is a deliberate scope reduction, not a bug fix.** When trimming FR-LEARN-1..27 to 5–6 FRs, preserve the *principles* (native-first, token-frugal, no counters in Hindsight) and mark trimmed FRs as "deferred to v5" — do not delete them, replace them with a compact "v5 deferred" placeholder block.
7. **Track all changes.** After all edits, produce a CHANGE LOG section at bottom of this handoff doc listing every section modified, what changed, and why.
8. **Binary exit gate.** Before declaring done, run the consistency checklist at the end of this prompt.

---

## WHAT THE PRD IS (context for sub-agents)

QDS-Factory v4 is a lights-out autonomous code factory. Four-layer stack: Paperclip (control plane) → Hermes (department manager agents) → Archon PIV DAG (workflow engine) → Pi agent teams (in-node execution). Every PR is traced through a single audit chain. Five self-improvement loops. Ground-truth basis: live Phase-0 spikes, file-cited, 2026-06-05.

Key files on disk (verified this session):
- `~/Archon/` — plain upstream `coleam00/Archon@dev`, HEAD `536584db`. No env patch yet.
- `~/boardlensai/paperclip/` — `paperclipai/paperclip@78dc3625`.
- `~/QDS-Engineer/pi-vs-claude-code/` — local, frozen 2026-02-22. `coms.ts` upstream-only.
- Pi `0.55.0`, Seeds `sd 0.2.5`, Mulch `0.6.3`, Hermes `0.15.1`, GitNexus `1.6.3`.
- pi-lens, pi-gitnexus-plus, Telegram plugin, Hindsight Paperclip plugin: **not installed**.

---

## GAP REGISTER (act on every item)

Each gap is tagged: **[SPEC]** = new spec text needed in PRD, **[EDIT]** = existing text needs correction, **[TRIM]** = scope reduction.

> **⚠️ STATUS — this GAP REGISTER is the original input plan (2026-06-06 AM), preserved as the historical record.** Where any item below conflicts with the final outcome, the authoritative records govern: the **CHANGE LOG** and **OPERATOR DECISIONS — RESOLVED** sections at the bottom of this doc, and the PRD itself (`prd-qds-factory-v4.md`). Two items were resolved differently than first drafted and carry inline superseded notes:
> - **OPPORTUNITY-1** (PR-bot fix loop) — **resolved**: committed to **Phase 1** (item 15); the Phase-4 bullet was struck. It is no longer an open decision, and no `[OPERATOR DECISION NEEDED]` callout remains in the PRD.
> - **TRIM-1** (Layer-B FR-LEARN trim) — **superseded**: the v4 foundation uses the next free IDs **`FR-LEARN-28..33`**, not the `FR-LEARN-1..6` repurposing drafted below. The original `FR-LEARN-1..27` are preserved **verbatim with their published IDs unchanged** in PRD §6.10 (v5 deferred scope), and OQ-7..16 / R16..R26 moved to PRD Appendix C. See Operator Decision #2.

---

### GAP-1 [SPEC] — `pi-team-launch.sh` is never specced

The script is referenced ~8 times but never defined. Stories cannot be written without it.

**Required spec content (derive from existing PRD constraints):**
- Signature: what args the script accepts (task description, context path, archetype, budget cap, turn cap, wall-clock cap, model assignments per role)
- Agent identity: how `--cname`/frontmatter `name:` is set per role
- Mulch prime injection: how per-agent system prompts receive Mulch priming context
- Structured output collection: how the lead agent's merged JSON is captured as node output (stdout protocol)
- Partial failure handling: if 1 of 3 agents fails mid-run — does the lead wait? Timeout? Emit a partial result? Fail the node?
- Node-level LSP union: the gate at emit runs `lsp_diagnostics` over the UNION of all files changed by ALL agents in the node — not per-agent. How does the lead collect the full changed-file set from workers before running the gate?
- `response_schema` validation: since `response_schema` is parse-only (not schema-validated, confirmed upstream), the launcher or lead must perform explicit validation. Spec where this lives.
- Hard guard enforcement: budget/turn/time caps enforced by the launcher, not delegated to individual agents.

**Where to add in PRD:** New §4.6 "Launcher Contract (`pi-team-launch.sh`)" immediately after §4.5. Keep it to ~1 page. Reference from FR-EX-1..6, FR-EX-11, and Phase-0 item 3.

**Sub-agent task:** Spawn one agent to draft §4.6 content consistent with existing §4 constraints. Agent must read §4.2 (structural caps), §4.5 (code-intel layers), §7 (archetypes), and FR-EX-1..12 before drafting. Return draft text only — no direct edits.

---

### GAP-2 [SPEC] — Hermes event-loop model during SSE consumption is undefined

FR-MG-4 says manager launches Archon run and "consume[s] its SSE stream." Hermes is a 24/7 tool-loop. If it blocks on SSE, it can't handle concurrent stories or its own cron triggers. If async, how?

**Required spec content:**
- Hermes `delegate_task` (max_concurrent_children=3) is the mechanism for concurrent story management. Confirm it exists at `~/boardlensai/hermes-agent/` (grep before citing).
- SSE consumption model: Hermes spawns a child task per story; the child blocks on SSE; the parent Hermes loop remains unblocked. The child task is identified by Paperclip `runId` and reports back on story completion.
- Implication: at most 3 concurrent active stories (bounded by `max_concurrent_children=3`). Document this as a concurrency ceiling.
- If `delegate_task` does NOT exist or is not wired for SSE consumption, fall back to: Hermes runs stories sequentially in Phase 1, with a documented upgrade path to delegated concurrency in Phase 3.

**Where to add in PRD:** Amend §4.1 architecture diagram description and FR-MG-4 to name the SSE consumption model explicitly. Add one paragraph to §4.1 titled "Hermes concurrency model."

**Sub-agent task:** Spawn one agent to grep `~/boardlensai/hermes-agent/` for `delegate_task`, `max_concurrent`, SSE consumption patterns, and the child-task management mechanism. Agent reads relevant source files and returns: (a) whether `delegate_task` exists and what its signature is, (b) whether there is existing SSE/streaming consumption in Hermes, (c) recommended spec text for FR-MG-4 amendment. Confidence-tagged findings only.

---

### GAP-3 [SPEC] — Seeds→Paperclip sync protocol undefined

FR-MG-3: "mirror those stories to Paperclip issues (authority split: Seeds owns dependencies; Paperclip owns assignment + cost)." No protocol specified.

**Required spec content:**
- **Trigger:** Hermes calls the mirror explicitly after `sd create` succeeds — not event-driven. One directional.
- **Idempotency key:** Paperclip child issue `externalId = seeds_story_id` (or equivalent). If a child issue with that key exists, update status; do not create a duplicate. (Verify whether Paperclip `issues` schema has an `externalId` or `metadata` field — sub-agent must grep `~/boardlensai/paperclip/packages/db/src/schema/issues.ts` before asserting.)
- **Conflict resolution:** Paperclip is authority for assignment + cost. Seeds is authority for deps + status. If they diverge on status (e.g., Seeds = `closed`, Paperclip = `in_progress`), Paperclip wins on assignment/cost; Seeds wins on dep edges. Log divergences.
- **What is NOT mirrored:** Dependency edges from Seeds `blocks[]`/`blockedBy[]` are NOT duplicated to Paperclip's `parentId` (parent = decomposition, not dependency). The audit walk uses both stores separately.

**Where to add in PRD:** New paragraph in FR-MG-3 after current text: "Sync protocol: [spec above]." Add an invariant to §8.2: "Paperclip child issues reference their originating Seeds story id via [field]; the sync is one-directional."

**Sub-agent task:** Spawn one agent to read `~/boardlensai/paperclip/packages/db/src/schema/issues.ts` fully and report: (a) does an `externalId`, `metadata`, or equivalent field exist? If not, what field could serve as the idempotency key? (b) does `parentId` carry semantics that would conflict with using it for dep edges? Return exact field names and line numbers.

---

### GAP-4 [EDIT] — OQ-1 (socket vs subprocess) must gate §7 archetype protocol

The PRD treats OQ-1 as an execution detail. It's an architectural fork that makes §7 archetype specs (TDD Trio with `coms_send`/`response_schema`/`coms_await`) potentially wrong.

**Required edit:**
Add a callout box to §12.2 OQ-1 entry: "**§7 protocol dependency:** if subprocess-RPC is selected, §7's coms verbs (`coms_send`, `coms_await`, `response_schema`) must be rewritten to their subprocess-RPC equivalents before any Phase-0 item 3+ story is authored. A §7 amendment task is the FIRST output of OQ-1 resolution, before story generation." Also add this dependency to Appendix A step 1.

No sub-agent needed. Direct PRD edit.

---

### GAP-5 [SPEC] — Dashboard charting surface not specified

PRD references "the dashboard" rendering yield-curve KPIs, Layer-B panels, trend significance, etc. Paperclip has a dashboard but its custom-charting API is unknown.

**Required investigation:** Does Paperclip's dashboard support custom chart panels? If yes, what's the API? If no, what's the implementation path (Paperclip plugin with a web component? Separate lightweight web app with Paperclip `cost_events` as data source via REST?).

**Where to add in PRD:** New OQ entry: "**OQ-17 (dashboard charting surface).** Question: Does the Paperclip dashboard support custom KPI chart panels natively, or does yield-curve rendering require a plugin or separate app? Spike: read `~/boardlensai/paperclip/` dashboard source for widget/panel extension points. Default: if no native extension, build a minimal read-only web page that queries `cost_events` REST endpoint directly — FR-ACT-3 does not require the chart to live inside the Paperclip dashboard." Add OQ-17 to Appendix A step 1 and the Phase-5 gate in §13.

**Sub-agent task:** Spawn one agent to explore `~/boardlensai/paperclip/` (packages/app or packages/web or similar) for dashboard panel/widget extension points. Return: (a) does a plugin or component API exist for adding custom panels? (b) what is the `cost_events` REST endpoint (grep routes for cost_events or ledger query endpoint)? Confidence-tagged, file:line cited.

---

### GAP-6 [SPEC] — First-story bootstrap / cold-start state

Day 1: Mulch empty, Hindsight banks empty, GitNexus unanalyzed. PRD handles router cold-start (FR-LEARN-7) but not the broader bootstrap.

**Required spec content (brief, one paragraph per system):**
- **Mulch empty:** `mulch prime` with no expertise entries returns an empty string. Agents proceed with base system prompt only. No special handling needed; this is the baseline state.
- **Hindsight recall on empty bank:** returns empty result set. Proceed-unprimed per NFR-PERF-4. State this explicitly in FR-MEM-2: "on empty bank, recall returns empty; the node proceeds unprimed with a logged warning."
- **GitNexus on un-analyzed repo:** `gitnexus_context`/`gitnexus_impact` return an error or empty if no graph exists. Per NFR-PERF-5, agents fall back to grep. Phase-0 item 6 runs the initial `gitnexus analyze` — this must complete before any Phase-1 story executes. Add this as a sequencing constraint to §13 Phase-0 gate item 6.

**Where to add in PRD:** Amend FR-MEM-2 (one sentence). Amend FR-EX-9 (one sentence on empty-graph fallback). Amend §13 Phase-0 gate item 6 to add "initial `gitnexus analyze` must complete to a non-error state."

No sub-agent needed. Direct PRD edits from existing PRD constraints.

---

### GAP-7 [SPEC] — Worktree lifecycle management

PRD says "worktree-isolated per run" (§4.1, FR-OR-5) but never specifies lifecycle.

**Required spec content:**
- **Creator:** Archon creates the worktree at run start (it already does this per FR-OR-5; confirm by reading Archon source).
- **Branch naming:** `qds/{issue-id}/{run-id}` — unique per run, avoids collision.
- **Cleanup:** Archon deletes the worktree on run completion (success or clean failure). On crash/abort: Maintenance manager sweeps orphaned worktrees (age > 2h, no active run) as part of Phase-3 sweep sub-DAG.
- **Concurrent story isolation:** because each run gets its own branch + worktree, concurrent Phase-5 stories cannot collide on the working tree. They MAY collide on merge order — which is the wave-executor problem (deferred to Phase 4).

**Sub-agent task:** Spawn one agent to grep `~/Archon/packages/workflows/src/dag-executor.ts` for worktree creation, branch setup, and cleanup logic. Return: (a) does Archon create worktrees? (b) what branch naming convention does it use? (c) does it clean up on completion? File:line citations required. This informs whether the spec above matches reality or needs to change.

**Where to add in PRD:** New paragraph in FR-OR-5. One sentence in §10 Phase-3 sweep sub-DAG.

---

### GAP-8 [SPEC] — Restart classification mechanism

FR-MG-8/9: restart classified as transient/overflow/logic. Never specifies what signal maps to what class.

**Required spec content:**
A concrete signal→class mapping that Hermes can implement deterministically:

| Signal | Class | Restart action |
|---|---|---|
| Archon run exits with `TIMEOUT` status (wall-clock or turn cap hit) | transient | Resume same run from last successful node checkpoint |
| Archon run exits with node output size > configured threshold or token cap | overflow | Hermes re-scopes the Seeds story (split into smaller Stories) then reruns |
| Archon run exits with a `LOGIC_ERROR` tag emitted by the Pi lead (explicit signal from the Pi team that the task is contradictory/impossible) | logic | Escalate to human gate via Paperclip `executionPolicy` |
| Any other non-zero exit | transient (default) | Resume, count toward ≤8 retry cap |

**Where to add in PRD:** New table in FR-MG-8 text. Reference from NFR-REL-2.

**Sub-agent task (combined with GAP-7 agent):** same agent — also grep Archon for run exit status values/enums to confirm what status strings actually exist. Return confirmed status values at file:line.

---

### CORRECTNESS-A [EDIT] — Archon env patch non-regression test

Phase-0 item 1 exit criterion: "bash node with `env: {FOO: bar}` runs and subprocess echoes `bar`." Missing: non-regression test that existing bash nodes (no `env` field) still work.

**Edit:** Append to Phase-0 item 1 exit criterion: "AND a bash node WITHOUT an `env` field still echoes a variable from Archon's inherited parent env (non-regression: the subprocess must still inherit parent env when `env` field is absent — i.e., passing `env: undefined` must not wipe inherited env; use `Object.assign({}, process.env, nodeEnv)` merge pattern in the executor)."

Direct PRD edit. No sub-agent.

---

### CORRECTNESS-B [EDIT] — `coms_await` timeout must be specified per archetype

Current: default 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000ms`). With ≤1h wall-clock cap (NFR-SAF-2), one hung TDD-Trio agent can burn half the story budget.

**Edit:** Add to NFR-SAF-3: "Recommended starting values per archetype: Solo/Pair = 10 min per await; TDD Trio = 8 min per await; Contract-split Quad = 6 min per await. These are configurable via `PI_COMS_TIMEOUT_MS` override in `pi-team-launch.sh`'s per-node env map (FR-OR-4) and should be tuned downward after the Phase-0 guarded demo reveals actual p99 agent-turn durations." Add OQ-16b to §12.2: "What are the actual p99 agent-turn durations for each archetype at Phase-0 story sizes? Spike: measure in Phase-0 item 3 demo. Default: start at the values above."

Direct PRD edit. No sub-agent.

---

### CORRECTNESS-C [EDIT] — Node-level LSP gate union is unspecced in launcher

FR-EX-11 correctly says the gate runs "over the union of all files changed by any agent in the node." But there is no protocol for how the lead collects that union.

**Edit:** Add to FR-EX-11 after current text: "Collection protocol: each worker agent emits its changed-file list in the `response_schema`'s `changed_files: string[]` field. The lead aggregates these lists into a union set before running `lsp_diagnostics`. The `changed_files` field is mandatory in the response schema; a worker that omits it causes the lead to fail the node (not waive — the collection failure is a logic error, not a diagnostics failure)."

Also add `changed_files: string[]` to the response schema description in GAP-1's §4.6 launcher spec.

Direct PRD edit. No sub-agent.

---

### CORRECTNESS-D [EDIT] — Seeds/Mulch target versions must be named

Phase-0 item 6 says "upgrade/pin Seeds (0.2.5→target) and Mulch (0.6.3→target)" without naming the target.

**Sub-agent task (combine with GAP-3 agent):** same agent — also run `npm show sd versions --json | tail -20` and `npm show mulch versions --json | tail -20` (or check npm registry) to find current stable releases. Return the current stable version of each.

**Edit:** Once confirmed, update Phase-0 item 6 with specific version numbers.

---

### CORRECTNESS-E [EDIT] — `response_schema` parse-only validation gap

FR-EX-2 / R5 correctly note `response_schema` is parse-only. But no FR currently requires explicit lead-side validation.

**Edit:** Add to FR-EX-2: "Because `response_schema` is parse-only (JSON.parse, not schema-validated per the coms contract — §5.2), the lead agent MUST perform explicit schema validation on each worker's `coms_await` result before accepting it. Validation is synchronous in the lead's response handler; a worker whose result fails validation is treated as a logic error (not a coms timeout), and the lead either re-requests or fails the node if retries are exhausted."

Direct PRD edit. No sub-agent.

---

### OPPORTUNITY-1 [SPEC] — PR-bot fix loop should be Phase 1, not Phase 4

> **✅ RESOLVED (Operator Decision #1, below) — historical note.** The "Decision needed" framing and the instruction to add a `[OPERATOR DECISION NEEDED]` callout (this section) are **superseded**. Outcome: the PR-bot fix loop was **committed to Phase 1** (item 15), separable from the make-or-break exit gate; the Phase-4 bullet was **struck** (Phase-1 ~14→~16 stories, Phase-4 ~5→~3). The PRD carries no `[OPERATOR DECISION NEEDED]` callout for this item. Text below is retained as the original rationale.

Current: Phase 4 says "PR-bot fix loop" as a single bullet. The highest-value Phase-1 demo — and the user's actual workflow — is: Telegram → PR → CodeRabbit/Gemini comments → Hermes wakes → Pi addresses comments → PR goes green.

**Decision needed:** Does the user want to move PR-bot fix loop to Phase 1? If yes:
- Add Phase-1 item 15: "PR review-comment fix loop. Exit: a PR opened by Phase-1 item 14 receives ≥1 bot review comment; the QA manager (or Dev manager, Phase-2 QA not yet live) detects the comment via a Paperclip routine polling the PR; dispatches a Pi Pair to read and address the comment; the fix is pushed and the PR moves to green. (FR-CM-5, FR-MG-4, FR-OR-6 reuse.)"
- Adjust Phase-4 scope accordingly.

**Flag this for user decision in the PRD edit.** Add a `[OPERATOR DECISION NEEDED]` callout in Phase-4 "PR-bot fix loop" bullet pointing to Phase-1 item 15.

---

### OPPORTUNITY-2 [SPEC] — OpenRouter usage API resolves OQ-8

OQ-8 asks whether Pi-subprocess spend auto-writes `cost_events` rows. There is a simpler resolution.

**Edit OQ-8 to add:** "Resolution path via OpenRouter API: OpenRouter exposes `GET /api/v1/generation?id={generation_id}` returning exact cost and token counts per generation. `pi-team-launch.sh` can collect generation IDs from the Pi JSON event stream (`model_response` events carry a generation id in the OpenRouter payload), then batch-query OpenRouter post-run to emit `cost_events` rows for each Pi agent's spend. This removes the dependency on Pi internal cost accounting and makes per-agent attribution reliable regardless of how Pi handles its own telemetry. Spike: confirm the `model_response` event carries an OpenRouter-queryable generation id by inspecting the Pi JSON stream in Phase-0 item 3."

This elevates OQ-8's confidence from "unknown" to "likely solvable in Phase 0."

---

### OPPORTUNITY-3 [SPEC] — Hard blast-radius → archetype floor rule

Currently: GitNexus blast-radius bucket is a signature input for the router. It's advisory.

**Add to §7 "Dominating rule" paragraph:** "**Blast-radius floor:** a GitNexus blast-radius bucket of `HIGH` (>50 files affected) mandates at minimum a TDD-Trio (archetype C) — Solo and Pair are illegal arms for that run regardless of other task-shape signals. The router's legal-arm enumeration (FR-LEARN-3) enforces this as a hard constraint, not a preference. Rationale: high blast-radius = high consequence of a wrong contract; the frozen-contract + adversary pattern of Trio is the minimum safe floor."

Add a sentence to FR-LEARN-3: "Arms violating the blast-radius floor (§7) are excluded from the legal-arm catalog identically to the risk-tier exclusion."

---

### TRIM-1 [TRIM] — Layer-B FR-LEARN-1..27 → 5-6 FRs for v4

> **⚠️ SUPERSEDED ID SCHEME (Operator Decision #2, below) — historical note.** Every `FR-LEARN-1..6` / "5-6 FRs" / "replace FR-LEARN-1..27" framing in this section (and the §6.9 draft, sub-agent task, and execution-plan steps that reference it) is **superseded**. Final v4 scheme: the v4 foundation is **6 FRs at the next free IDs, `FR-LEARN-28..33`** (the FR list below maps 1:1 onto 28..33, same content); the original **`FR-LEARN-1..27` are preserved verbatim with their published IDs unchanged** in PRD §6.10 (v5 deferred scope) — **not** repurposed. OQ-7..16 → PRD Appendix C; R16..R26 → Appendix C; R15 kept in §14. Rationale: PR #9 is merged, so FR-LEARN-1..27 are published IDs and immutable. Text below is retained as the original scope rationale.

**This is a scope decision, not a bug fix. The contextual bandit, counterfactual estimator, shadow runs, Mann-Kendall, CUSUM, difficulty normalization, ablation stories, and baseline epochs are correct engineering but v5 work.**

**Target state in PRD:**
- Replace FR-LEARN-1..27 with FR-LEARN-1..6 (v4 scope)
- Move FR-LEARN-7..27 to a new "§6.10 — Self-optimization v5 deferred scope" section with a single paragraph: "The following capabilities are deferred to v5. The v4 implementation produces the native data substrate (§6.9 FR-LEARN-1..6, §9.4.0) from which these can be built. They are preserved here as a forward spec, not a v4 deliverable."
- Move OQ-7..16 to a new appendix "Appendix C — v5 open questions" with a header: "These OQs are not Phase-0/1 blockers. They are pre-researched for v5 planning. Each carries a default so v4 can proceed without them."
- Trim R15..R26 equivalently: keep R15 (Goodhart) as a v4 concern because the 4 KPIs are live in v4; move R16..R26 to Appendix C.

**v4 FR-LEARN set (5 FRs):**
- **FR-LEARN-1:** Record `{task_type, archetype, per_role_model_tier, cost_cents, input/output/cached_tokens, first_pass_accept, retry_count, retry_class, wall_clock_ms}` per run from native recording sites (`cost_events`, `activity_log`, `heartbeat_runs`), keyed on `runId`, idempotent upsert. (Condensed from old FR-LEARN-1/2.)
- **FR-LEARN-2:** The `qds-model-router` selects archetype and per-role model tier from the §7 defaults, the blast-radius floor (§7 dominating rule), and risk-tier constraint (FR-CP-5). Selection is logged with its rationale. (Condensed from old FR-LEARN-3/4/7.)
- **FR-LEARN-3:** A weekly Paperclip cron routine reads the outcome records (FR-LEARN-1) and the `{repo}-*-meta` Hindsight banks, produces a human-readable rationale summary via `reflect`, and proposes (but does not auto-apply) a router config change. An operator reviews and applies manually. (Condensed from old FR-LEARN-5/FR-MG-10.)
- **FR-LEARN-4:** Retained meta-lessons (`{archetype, role_tier_map, cost, outcome, runId}`) to the `*-meta` banks with `document_id=runId` (idempotent upsert). Nightly consolidation promotes durable lessons. (Condensed from old FR-LEARN-16/17.)
- **FR-LEARN-5:** Recall anti-pollution: strict tag-match + `memory_type` filter on meta-recall. Numbers stored in the outcome record table (FR-LEARN-1), not in Hindsight. (Condensed from old FR-LEARN-18, R26 guard.)
- **FR-LEARN-6 (Goodhart guard — keep in v4):** Every yield KPI (§9.2) is displayed with its paired counter-metric: first-pass-accept with escaped-defect rate (Phase-2 QA dependent); cost/story with cost-per-accepted-PR; retry-count with unclassified-restart rate; TDI with pi-lens warning count. No KPI panel renders without its pair. (Condensed from old FR-LEARN-19; R15 mitigation.)

**§9.4 simplification:** Replace §9.4's 11 sub-sections with a single section "§9.4 Layer-B self-optimization (v4 foundation)" describing the 5-FR set and a paragraph explaining that the full contextual-bandit/counterfactual machinery is a v5 deliverable built on top of this substrate. Retain §9.4.0 "native-first, token-frugal" principles verbatim — they govern v4 just as much.

**Sub-agent task for TRIM-1:** Spawn one agent to draft the replacement §6.9 (v4 FR-LEARN-1..6) and §6.10 (v5 deferred placeholder) text, consistent with existing FR/NFR IDs and the cross-references in §6.8, §9, §10, §11, §13, §14. Agent must read: §6.9 (current FR-LEARN-1..27), §6.8 (FR→Phase traceability), §9.1 (five loops table), §9.2 (KPI formulas), §9.4 (Layer-B), §10 (phased delivery), §11 (NFRs mentioning FR-LEARN), §13 (verification gates), §14 (R15..R26). Return: (a) replacement §6.9 text, (b) replacement §9.4 text, (c) list of all cross-references in §6.8/§10/§11/§13/§14 that reference FR-LEARN-7..27 and need updating to either the new IDs or a v5 note, (d) replacement NFR list for NFRs that currently cite FR-LEARN-7..27 (NFR-SAF-5/6, NFR-COST-3, NFR-PERF-7/8, NFR-REL-4, NFR-OBS-6 — agent must check each). Do NOT directly edit the PRD. Return structured report only.

---

## EXECUTION PLAN FOR NEW SESSION

### Phase A — Parallel Investigation (spawn all agents simultaneously)

Send ONE message spawning ALL of the following agents in parallel:

**Agent 1 — Launcher+Restart+Worktree Spec** (GAP-1, GAP-7, GAP-8, CORRECTNESS-A)
Read: `~/Archon/packages/workflows/src/dag-executor.ts` (worktree creation, branch naming, cleanup), `~/Archon/packages/workflows/src/schemas/dag-node.ts` (bash node schema), §4.2/§4.5/§7/FR-EX-1..12 from PRD. Produce: (a) §4.6 launcher spec draft, (b) worktree lifecycle findings (file:line), (c) Archon exit status enum values (file:line), (d) proposed signal→class restart mapping. Confidence-tagged.

**Agent 2 — Hermes Concurrency + Seeds Schema** (GAP-2, GAP-3, CORRECTNESS-D)
Read: `~/boardlensai/hermes-agent/` (grep for `delegate_task`, `max_concurrent`, SSE/streaming); `~/boardlensai/paperclip/packages/db/src/schema/issues.ts` (full file); run `npm show sd versions --json | tail -5`; run `npm show mulch versions --json | tail -5`. Produce: (a) delegate_task signature and SSE model findings, (b) Paperclip issues schema fields for idempotency key, (c) current stable Seeds and Mulch versions.

**Agent 3 — Dashboard + OpenRouter** (GAP-5, OPPORTUNITY-2)
Read: `~/boardlensai/paperclip/` — find dashboard/app source (ls packages/, grep for `dashboard`, `widget`, `panel`, chart library). Also grep routes for `cost_events` query endpoint. Produce: (a) dashboard extension point findings (file:line or absence), (b) cost_events REST endpoint, (c) OQ-17 recommended default based on findings.

**Agent 4 — Layer-B Trim Draft** (TRIM-1)
Read full §6.9, §6.8, §9.1-9.4, §10, relevant §11 NFRs, §13, §14 R15..R26 from the PRD. Produce the structured report described in TRIM-1 sub-agent task above.

### Phase B — Synthesis (main context, sequential)

After all 4 agents return:
1. Validate each finding (grep-verify any file:line citations that seem off).
2. Resolve any conflicts between agent findings and PRD ground truth.
3. For each gap, finalize the exact text to write.
4. Make PRD decisions requiring operator input — flag them clearly as `[OPERATOR DECISION NEEDED]`.

### Phase C — PRD Edits (main context, sequential)

Edit PRD section by section. Order matters (do in this sequence to avoid cross-reference drift):
1. §4.6 new section (GAP-1 launcher spec)
2. §4.1 Hermes concurrency paragraph (GAP-2)
3. FR-MG-3 sync protocol (GAP-3)
4. FR-MEM-2, FR-EX-9, §13 Phase-0 item 6 (GAP-6)
5. FR-OR-5 + §10 Phase-3 (GAP-7)
6. FR-MG-8 restart signal table (GAP-8)
7. Phase-0 item 1 non-regression (CORRECTNESS-A)
8. NFR-SAF-3 timeout values (CORRECTNESS-B)
9. FR-EX-11 union collection protocol (CORRECTNESS-C)
10. Phase-0 item 6 with named versions (CORRECTNESS-D)
11. FR-EX-2 validation requirement (CORRECTNESS-E)
12. §12.2 OQ-1 §7-dependency callout (GAP-4)
13. OQ-17 new entry in §12.2 (GAP-5)
14. OQ-8 OpenRouter path (OPPORTUNITY-2)
15. §7 blast-radius floor rule + FR-LEARN-3 (OPPORTUNITY-3)
16. Phase-1 item 15 / Phase-4 OPERATOR DECISION callout (OPPORTUNITY-1)
17. §6.9 v4 FR-LEARN-1..6 replacement (TRIM-1)
18. §6.10 v5 deferred placeholder (TRIM-1)
19. §9.4 simplified (TRIM-1)
20. OQ-7..16 → Appendix C (TRIM-1)
21. R15 stays in §14; R16..R26 → Appendix C (TRIM-1)
22. All cross-reference updates (§6.8, §10, §11 NFRs, §13, §14 cross-ref line)

### Phase D — Consistency Check

Spawn one final agent to run the consistency checklist below against the updated PRD.

---

## CONSISTENCY CHECKLIST (binary pass/fail)

Run after all edits. All must pass before declaring done.

- [x] Every FR cited in §6.8 FR→Phase traceability exists in §6.1..§6.10 with the same ID.
- [x] Every NFR has a measurable threshold statement.
- [x] Every OQ in §12.2 has: Owner-role, Spike action, Gates (FR IDs), Default/fallback.
- [x] Every Risk in §14 has: Likelihood, Impact, Mitigation, Owner, Trigger-to-watch.
- [x] The cross-reference line at bottom of §14 includes all risks by number.
- [x] Every new FR-LEARN ID in the v4 set (FR-LEARN-28..33 — *renumbered per operator decision #2; the original "FR-LEARN-1..6" framing is superseded*) is referenced by at least one of: §6.8, §9, §10, §11, §13.
- [x] No FR-LEARN-1..27 is *defined* in §6.1..§6.9 (they are defined only in §6.10 v5 deferred scope; §6.9/§9.4 cite the range solely as a deferred-scope pointer). *(Item updated from the original "FR-LEARN-7..27" wording: the renumber kept the full 1..27 set in §6.10.)*
- [x] §13 Phase-0 gate includes OQ-17 and the `gitnexus analyze` sequencing constraint.
- [x] §7 "dominating rule" paragraph includes the blast-radius floor.
- [x] §4.6 launcher spec exists and is cross-referenced from FR-EX-1, FR-EX-6, FR-EX-11, Phase-0 item 3.
- [x] OQ-1 entry in §12.2 includes the §7-dependency callout.
- [x] No `issue.cost` field anywhere in the document (NFR-ACC-3 invariant).
- [x] FR-EX-11 includes the changed-files union collection protocol.
- [x] NFR-SAF-3 includes archetype-specific timeout starting values.
- [x] Phase-0 item 1 exit criterion includes the non-regression test.

---

## WRAP-UP OUTPUTS

1. **Updated PRD** committed to `main` with message: `fix(prd): gap resolution pass — launcher spec, sync protocol, hermes concurrency, layer-b trim, correctness fixes`
2. **Change log** appended to this handoff doc (section below).
3. **Operator decisions flagged** listed explicitly at the top of the PR description.
4. **Post-PR comment** to main requesting CodeRabbitAI review.

---

## CHANGE LOG (completed 2026-06-06)

All edits made against `prd-qds-factory-v4.md`. Four parallel investigation agents grounded every claim to `file:line`; a final consistency agent verified the 15-item checklist (15/15 PASS). Several handoff *assumptions* were corrected by ground truth (flagged ⚠️ below).

| Section | Change | Reason |
|---|---|---|
| §4.6 (new) | Added "Launcher contract — `pi-team-launch.sh`": signature, agent identity (`--cname`→`<run-id>-<role>`), Mulch prime, stdout protocol, parse-only→explicit validation, mandatory `changed_files:string[]` + LSP union, partial-failure (fail-node default), hard-guard enforcement. | GAP-1 — launcher referenced ~8× but never specced. Grounded to `dag-executor.ts:1361-1378`. |
| §4.1 | Added "Hermes concurrency model" paragraph; amended FR-MG-4. | GAP-2. ⚠️ Ground truth: `delegate_task` is a **blocking scatter-gather** (≤3 children, no SSE consumer) — `delegate_tool.py:1918`, `config.py:1230`. Handoff's "child blocks on SSE, parent unblocked" model does not exist → Phase-1 **sequential**, Phase-3 net-new async upgrade. |
| FR-MG-3 + §8.2 | Added one-directional Seeds→Paperclip sync protocol + §8.2 invariant. | GAP-3. ⚠️ No `externalId`/`metadata` field — used the real `originKind`/`originId` triplet (`issues.ts:45-46`) + partial-unique-index idempotency; `parentId` is decomposition-only (`issues.ts:29`); deps→`issue_relations`. |
| FR-MG-8 | Added restart signal→class table. | GAP-8. ⚠️ No `TIMEOUT`/`LOGIC_ERROR` enum on disk — Archon has only `failed`/`cancelled` (`workflow-run.ts:10-32`); class reconstructed from error string/`err.killed`/`cost_events`/launcher `exit_class`. |
| FR-OR-5 + §10 Phase-3 | Added worktree lifecycle. | GAP-7. ⚠️ Archon branch naming is `archon/<type>-<id>` (`worktree.ts:426-444`), not `qds/{issue}/{run}`; cleanup is a 14-day interval sweep (`cleanup-service.ts:36`), not 2h-orphan. Specced reality + flagged the factory's tighter sweep as a **net-new policy**. |
| FR-MEM-2, FR-EX-9, §13 Phase-0 (item 7b) | Cold-start/empty-state behavior + initial-`gitnexus analyze` sequencing gate. | GAP-6. |
| §12.2 OQ-1 + Appendix A step 1 | Added §7-protocol-dependency callout (subprocess-RPC ⇒ rewrite §7/§4.6 coms verbs before story gen). | GAP-4. |
| §12.2 OQ-17 (new) + §13 Phase-5 | Dashboard charting surface. | GAP-5. ⚠️ Largely **resolved**: native `dashboardWidget` slot already mounted (`Dashboard.tsx:309`, `constants.ts:870-887`); default = ship a plugin widget fed by cost REST endpoints (`costs.ts:132-177`). |
| Phase-0 item 1 + §4.4(b) + §13 Phase-0 item 5 | Env-merge non-regression (`{...process.env, ...node.env}`, not bare assignment). | CORRECTNESS-A. Confirmed executor passes no `env` today (`dag-executor.ts:1361-1365`). |
| NFR-SAF-3 + §12.2 OQ-16b (new) | Per-archetype `coms_await` timeouts (10/8/6 min) + calibration spike. | CORRECTNESS-B. |
| FR-EX-11 | Changed-files union collection protocol. | CORRECTNESS-C. |
| §10 Phase-0 item 6 + §12.1 | ⚠️ Seeds/Mulch are **private CLIs, not npm** → **pin** 0.2.5/0.6.3 (no newer public target; blueprint's 0.4.7/0.10.1 unverifiable). | CORRECTNESS-D. |
| FR-EX-2 | Explicit lead-side schema validation (response_schema parse-only). | CORRECTNESS-E. |
| OQ-8 (now Appendix C) | Added OpenRouter `/api/v1/generation` cost-attribution resolution path (spike-to-confirm). | OPPORTUNITY-2. |
| §7 Dominating rule + FR-LEARN-2 | Blast-radius floor (HIGH >50 files → min TDD-Trio; Solo/Pair illegal arms). | OPPORTUNITY-3. |
| §10 Phase-1 item 15 + Phase-4 bullet | `[OPERATOR DECISION NEEDED]` callouts (move PR-bot fix loop to Phase 1?). | OPPORTUNITY-1 — flagged for operator, not auto-decided. |
| §6.9 (rewritten), §6.10 (new), §9.4 (collapsed 11 subsections → v4 foundation + verbatim §9.4.0), §12.3→Appendix C, §14 R16..R26→Appendix C, Appendix C (new) | **Layer-B trim:** FR-LEARN-1..27 reduced to a v4 foundation of **6 new FRs**; OQ-7..16 + R16..R26 moved to Appendix C; R15 kept. 8 NFRs annotated v4-live vs v5-deferred (ACC-4, SAF-5/6, COST-3, PERF-7/8, REL-4, OBS-6). | TRIM-1. §9.4.0 retained verbatim with a note acknowledging its forward-ref to §9.4.7/NFR-COST-3 (v5). |

## OPERATOR DECISIONS — RESOLVED (2nd pass, "best enterprise/long-term, no band-aids")

| Decision | Resolution | Rationale |
|---|---|---|
| **(1) PR-bot fix loop — Phase 1 vs 4 (OPPORTUNITY-1)** | **Committed to Phase 1** (item 15), **separable from the make-or-break exit gate**; Phase-4 bullet struck; Phase-1 ~14→~16 stories, Phase-4 ~5→~3. | It is the operator's real lights-out workflow and a load-bearing capability; de-risk it early while the architecture is malleable, not bolted on at Phase 4. Kept out of the single make-or-break assertion so it can't inflate critical-path risk. |
| **(2) FR-LEARN ID strategy (TRIM-1)** | **Renumbered — IDs never repurposed.** v4 foundation now uses the next free IDs **`FR-LEARN-28..33`**; the original **`FR-LEARN-1..27` are restored verbatim** in §6.10 (this also fixed the earlier lossy "folding" of old FR-LEARN-1..6). All v4 cross-refs updated to 28..33; all v5 refs unchanged. | The PRD is published (PR #9 merged to main), so FR-LEARN-1..27 are published IDs. Silently repurposing published requirement IDs is the band-aid; immutable published IDs is the enterprise long-term-correct stance. The v4 IDs reading higher than the deferred v5 IDs is expected (chronological assignment). |
