# QDS Factory on Archon — Design Spec

**Date:** 2026-05-10
**Status:** Approved for planning
**Decision:** Pivot from custom factory platform (Overstory + Pi SDK + Factory Core) to Archon-native implementation

---

## The Pivot

The original QDS Factory plan required ~64 stories and ~6,470 LOC of new infrastructure (Overstory fork, Pi SDK integration, Factory Core). This design replaces that with:

- **Archon** as the execution platform (DAG executor, headless CC runner, SSE streaming, web UI — all inherited)
- **`qds-piv-loop.yaml`** — one Archon workflow extending the PIV loop with adversarial review, QA swarm, and dual code-review waves
- **`/qds` skill** — the single entry point; handles both single stories and full epics
- **Self-learning layer** — process improvement + codebase wiki that compound over time

The entire system is workflow YAMLs + skills. No new servers. No new databases. No new runtimes.

---

## 1. Overall Architecture

```
/qds "add rate limiting" | story.md | epic.md
        │
        ▼
┌─────────────────────────────────────────────┐
│  Tier 1: QDS Orchestrator (/qds skill)      │
│  Headless CC session, ralph-loop style      │
│                                             │
│  Single story? → Tier 2 directly            │
│  Epic?         → DECOMPOSE → wave executor  │
│    - Parse input (text / story / epic)      │
│    - Build dep graph (explicit + gitnexus)  │
│    - Compute parallel waves                 │
│    - Human gate: approve wave plan          │
│    - Launch stories into worktrees          │
│    - Poll git + Archon API for completions  │
│    - Unlock dependents as blockers merge    │
└────────────┬────────────────────────────────┘
             │ POST /api/workflows/runs per story
             ▼
┌─────────────────────────────────────────────┐
│  Tier 2: QDS PIV Loop (Archon workflow)     │
│  qds-piv-loop.yaml                          │
│  Runs per story, in isolated git worktree   │
│                                             │
│  gitnexus-check → explore → create-plan     │
│  → refine-plan → implement-setup            │
│  → implement → fix-feedback                 │
│  → adversarial-review → qa-swarm            │
│  → bmad-code-review-1 → fix-wave-1          │
│  → bmad-code-review-2 → fix-wave-2          │
│  → finalize                                 │
└─────────────────────────────────────────────┘
```

**Key properties:**
- Single story: no orchestrator — `/qds` triggers Tier 2 directly via Archon API
- Epic: Tier 1 manages the story DAG; each story gets full Tier 2 treatment
- Archon web UI shows each story run with full SSE streaming
- All coordination via files + git — no new DB, no new server
- State file: `.claude/qds/epic-{slug}/plan.json` — crash-safe, resumable

---

## 2. Integration Points

### GitNexus — Structural Intelligence

| When | What |
|------|------|
| Orchestrator start | `gitnexus analyze` — ensure graph is fresh before Wave 1 |
| DECOMPOSE step 2 | `gitnexus route_map` + `gitnexus impact` per story — blast radius, hidden coupling |
| Explore node | `gitnexus query` — efficient codebase traversal without file reading |
| Create-plan node | `gitnexus impact` — confirm blast radius before committing to a plan |
| Finalize node | `gitnexus analyze` — refresh graph so next wave sees merged work |

Graph = structural knowledge. Wiki = semantic knowledge. Together they form complete codebase intelligence.

### Context7 — Always-Fresh Docs

- Used in **implement nodes only** — when the agent is actually writing code and needs current API signatures
- Not a hook, not mandatory: implement node prompt says "use Context7 when referencing any library API"
- Agent decides when it's worth calling

### Claude-mem — Memory Layer

- **Auto-injected throughout** — no explicit upfront query needed
- Agents are aware of it and know to use `/memory:memory-search` if they need to reach further
- `create-plan` node stores plan decisions and arch choices to mem after writing the plan
- `finalize` node stores "what was built" summary (story id, files changed, PR url, key decisions)
- Cross-story continuity: Wave 2 agents arrive with Wave 1's work already in context

### Superpowers — Quality Gates + Skill Invocations

Ambient throughout all headless CC sessions. Specific explicit invocations:

| Node | Skill invoked |
|------|--------------|
| DECOMPOSE step 1 (free text) | `bmad-create-epics-and-stories` |
| DECOMPOSE steps 3-5 | `bmad-sprint-planning` |
| adversarial-review | `bmad-review-adversarial-general` |
| qa-swarm | `bmad-review-edge-case-hunter` × N parallel |
| finalize (process learning) | `bmad-retrospective` |

---

## 3. Epic Orchestrator — Tier 1

### Input Handling

```
/qds "add rate limiting"     → free text, single story assumed unless decompose finds multiples
/qds story.md                → single story → Tier 2 directly
/qds epic.md                 → epic → full orchestration
/qds                         → prompts for input interactively
```

### DECOMPOSE Pipeline (epic path only)

**Step 1: Parse**
```
BMAD epic.md    → extract stories + explicit deps (structured parsing)
Free text       → bmad-create-epics-and-stories skill → formalize first
Multiple .md    → each file = one story, scan for dep declarations
```

**Step 2: Codebase Intelligence (per story)**
```
For each story:
  a. Agent reads story description + gitnexus graph
  b. gitnexus route_map {entry points} → architectural paths
  c. gitnexus impact {relevant paths} → blast radius
  d. Identifies: files_touched[], modules[], creates[], extends[]
```

No grepping. No file reading by the agent. GitNexus has the graph.

**Step 3: Dep Graph Construction**
```
For each story pair (A, B):
  EXPLICIT:      A.deps contains B → A depends on B
  FILE OVERLAP:  A.blast_radius ∩ B.blast_radius ≠ ∅ → agent checks ordering
  SEMANTIC:      agent reasoning: "B extends model A creates" → B depends on A
  SAFE PARALLEL: no shared files, no semantic link → concurrent

Error: cycle detected → halt, surface to human before continuing
```

**Step 4: Wave Computation**
```
Topological sort → depth buckets:
  Wave 1: stories at depth 0 (no deps)
  Wave N: stories whose deps are all in Waves 1..N-1

Within-wave safety check:
  Two wave-N stories share a file → sequential sub-steps within wave
  Flag to human: "1.2 and 1.4 share src/auth.ts — running sequentially in Wave 2"
```

**Step 5: Human Gate**
```
═══════════════════════════════════════════════
QDS EPIC PLAN — "{epic title}"
Stories: N | Waves: M | Max parallel sessions: K
═══════════════════════════════════════════════

Wave 1 (parallel):
  ● Story 1.1 — Add rate limiting middleware
  ● Story 1.3 — Migrate user schema

Wave 2 (after 1.1 merges):
  ● Story 1.2 — Rate limit dashboarding
    Reason: imports RateLimitEvent from src/middleware/rate-limit.ts (1.1 creates it)

⚠ Story 1.6 deferred: scope unclear — needs splitting

Approve, adjust deps, or ask me to re-examine a story?
═══════════════════════════════════════════════
```

Explicit approval required. Writes `plan.json`. Starts Wave 1.

### Wave Executor (ralph-loop)

Each iteration reads `plan.json` fresh from disk:

```
1. Find stories with status=ready (all deps status=merged)
2. For each ready story:
   - git worktree add .worktrees/{story-id} -b qds/{story-id}
   - POST /api/workflows/runs { workflow: "qds-piv-loop", worktree, story, args }
   - Update plan.json → in_progress
3. Check in_progress stories:
   - GET /api/workflows/runs/{run-id} (Archon API)
   - Merged → status=merged, gitnexus analyze, unlock deps
   - Failed → status=failed, human gate before continuing
4. All merged → completion summary, worktree cleanup, claude-mem store
```

Crash-safe: restart `/qds` on same epic, it reads `plan.json`, resumes from current state.

---

## 4. QDS PIV Loop — Tier 2 (Archon Workflow)

`qds-piv-loop.yaml` extends `archon-piv-loop.yaml`.

### Full Node Sequence

```
[bash]  gitnexus-check         provider: -      model: -          context: -
[loop]  explore                provider: claude  model: opus       context: persistent, interactive
[agent] create-plan            provider: claude  model: opus       context: fresh
[loop]  refine-plan            provider: claude  model: opus       context: persistent, interactive
[bash]  implement-setup        provider: -      model: -          context: -
[loop]  implement              provider: claude  model: sonnet     context: fresh per iteration
[loop]  fix-feedback           provider: claude  model: sonnet     context: persistent, interactive
[agent] adversarial-review     provider: claude  model: sonnet     context: fresh
[agent] qa-swarm               provider: claude  model: sonnet     context: fresh
[agent] bmad-code-review-1     provider: codex   model: glm-5.1    context: fresh
[agent] fix-wave-1             provider: codex   model: glm-5.1    context: fresh per agent
[agent] bmad-code-review-2     provider: codex   model: glm-5.1    context: fresh
[agent] fix-wave-2             provider: codex   model: glm-5.1    context: fresh per agent
[agent] finalize               provider: codex   model: glm-5.1    context: fresh
```

### Model Allocation Rationale

Archon's `dag-executor` supports per-node `provider: claude | codex` resolution. Four things are silently dropped for `codex` nodes (verified in `dag-executor.ts` lines 402–455):

1. **Hooks** — Superpowers ambient hooks do not fire
2. **MCP tools** — Context7, GitNexus graph tools (`query`, `impact`, `route_map`) unavailable
3. **node.skills** — Archon-level skill preloading ignored
4. **Skill tool** — structural gap: GLM runs in Codex runtime, not Claude Code SDK; the `Skill` tool does not exist there regardless of prompt instructions

All four constraints are satisfied by the current allocation: every node that needs hooks, MCP, or skill invocations is already on Claude. GLM nodes only touch `git`, `gh`, and bash — all CLI, all available to codex.

| Node | Model | Reason |
|------|-------|--------|
| explore, create-plan, refine-plan | **Opus** | Judgment shapes everything downstream; worth the cost |
| implement, fix-feedback | **Sonnet** | Needs post-edit hooks (format, typecheck, tests, lint) |
| adversarial-review, qa-swarm | **Sonnet** | Must invoke Superpowers skills; hooks fire |
| bmad-code-review-1/2 | **GLM 5.1** | Structured JSON output only; no skills, no hooks needed |
| fix-wave-1/2 | **GLM 5.1** | Mechanical targeted fixes — biggest cost lever (up to 6 agents × 2 rounds) |
| finalize | **GLM 5.1** | Scripted git/PR steps; no judgment required |
| Nightly wiki agent | **GLM 5.1** | Mechanical consolidation |
| Weekly process consolidation | **Opus** | Strategic synthesis → proposes prompt improvements |

**Cost lever:** Fix waves are where costs compound most — parallel agents × 2 rounds per story. GLM 5.1 there yields the largest savings while Opus stays on the 3 nodes where architectural judgment shapes all downstream work.

### GLM 5.1 Configuration

GLM uses an OpenAI-compatible API — no Archon code changes required, just config:

```yaml
# Archon config.yaml
assistants:
  codex:
    model: glm-4-plus        # update to glm-5.1 when GA
    baseUrl: https://open.bigmodel.cn/api/paas/v4/
    apiKey: ${GLM_API_KEY}   # in .env, never committed
```

### Key Node Details

**gitnexus-check:**
```bash
LAST_ANALYZE=$(cat .claude/qds/.gitnexus-last-analyze 2>/dev/null || echo 0)
NOW=$(date +%s)
if [ $((NOW - LAST_ANALYZE)) -gt 3600 ]; then
  gitnexus analyze && echo $NOW > .claude/qds/.gitnexus-last-analyze
fi
```

**explore:** Same as archon-piv-loop explore + gitnexus query for codebase traversal. Agent aware of claude-mem (`/memory:memory-search` if needed).

**create-plan:** Same as archon-piv-loop create-plan + gitnexus impact to confirm blast radius + Context7 for any libs in scope + stores plan decisions to claude-mem.

**implement:** Same as archon-piv-loop implement. Prompt includes: "Use Context7 when you need current API signatures for any library you're touching."

**fix-feedback:** Interactive. Human tests the implementation. Same as archon-piv-loop. Runs BEFORE automated review — human sees it first.

**adversarial-review:**
```
context: fresh (no implementation bias)
Invoke bmad-review-adversarial-general skill.
Review ALL git changes since branch creation.
Output: structured findings + overall risk assessment.
No HITL — output and exit.
```

**qa-swarm:**
```
context: fresh
Self-configuring from codebase learnings. No separate lookup node.

Step 1: Read known-issue pattern library from claude-mem       (~500 tokens, one read)
Step 2: gitnexus filter — which patterns intersect this        (graph lookup, no file reads)
        story's blast radius?
        → of N known patterns, K are relevant to this story

Step 3: Spawn in parallel (hard cap: 6 agents total)
  Standard agents (always run):
    Agent 1: concurrency + race conditions
    Agent 2: data integrity + edge inputs
    Agent 3: security boundaries + trust assumptions
  Pattern agents (relevance-filtered from learnings, top K by frequency):
    Agent 4+: each targets one recurring codebase-specific issue
              e.g. "null checks on external API responses (seen 7x)"
              e.g. "pagination empty-array case (seen 4x)"
    ← only spawned if pattern is relevant to this story's blast radius

Step 4: All agents output structured JSON findings
Step 5: Aggregate → pass to bmad-code-review-1
No HITL — output and exit.
```

**bmad-code-review-1 and bmad-code-review-2:**

Modified from `bmad-code-review` skill — review methodology preserved, HITL removed, output is structured JSON:

```
Review all changes using bmad-code-review methodology.
Do NOT pause for human input.
Output ONLY this structure:
{
  "HIGH":   ["<file:line> — <issue description>", ...],
  "MEDIUM": ["<file:line> — <issue description>", ...],
  "LOW":    ["<file:line> — <issue description>", ...]
}
Then exit.
```

Review 2 runs after fix-wave-1 — catches anything missed or newly introduced by fixes.

**fix-wave-1 and fix-wave-2:**
```
Read $bmad-code-review-N.output → parse priority buckets
For each non-empty bucket, spawn in parallel:
  Agent("Fix HIGH priority issues",   [HIGH findings],   fresh context)
  Agent("Fix MEDIUM priority issues", [MEDIUM findings], fresh context)
  Agent("Fix LOW priority issues",    [LOW findings],    fresh context)
All agents commit to same branch. Converge. Pass to next review node.
```

No priority tier skipped. Low gets its own agent.

**finalize:**
```
1. Push branch, create draft PR (gh pr create --draft)
2. gitnexus analyze (refresh graph for next wave)
3. Store to claude-mem: { story_id, files_changed, pr_url, key_decisions, date }
4. Write .claude/qds/runs/{story-id}/status = MERGED
5. Update wiki: changelog entry + affected module pages
6. Run bmad-retrospective on this story's run → store to claude-mem (tag: qds-process)
7. Output completion summary
```

### Per-Story State Files

```
.claude/qds/runs/{story-id}/
  status          ← PENDING | IN_PROGRESS | REVIEW | MERGED | FAILED
  plan.md         ← PIV implementation plan
  progress.txt    ← task-by-task tracking with commit hashes
```

---

## 5. Self-Learning Architecture

### Token Efficiency Principles

Learning loops are only valuable if they don't cost more than they save. Every learning integration follows these rules:

- **Graph before files**: query gitnexus first, read files only when graph isn't enough
- **Relevance filtering**: all pattern libraries pre-filtered by blast radius before agent invocation
- **Structured outputs everywhere**: review nodes output JSON, not prose — compact downstream inputs
- **Fresh context per review agent**: no accumulated cruft, each agent gets only its slice
- **Capped parallelism**: QA swarm hard cap of 6 agents regardless of pattern library size
- **Claude-mem auto-injection**: no re-reading docs already in memory
- **Progressive detail**: explore uses gitnexus summary first, reads files only if needed

### Layer 1: Process Learning

**Source:** PIV loop outcomes — fix wave iteration counts, dep graph errors, review finding patterns, node timing.

**Cadence:**
- After each story: `bmad-retrospective` in finalize node → observations to claude-mem (`tag: qds-process`)
- Weekly: consolidation agent reads all `qds-process` observations, clusters patterns, proposes workflow YAML + node prompt updates → human approves → committed

**Signal examples:**
- High fix-wave count → implement node prompt needs tightening
- Repeated dep graph misses on DB migrations → decompose heuristic update
- QA swarm consistently finds what code review missed → ordering worth examining

**Prompt A/B Evolution (item 8):**
When process learning proposes a node prompt improvement, A/B test it: run the new variant on the next 3 stories, compare fix-wave counts and review finding rates. Auto-adopt if measurably better. The workflow YAML evolves itself through evidence, not guesswork. Human reviews proposed changes before they go live.

### Layer 1b: Known-Issue Pattern Library → QA Swarm

Separate concern from general process learning — this is the feedback loop from review findings back into active review.

**How it builds:**
- Every finding from adversarial-review, qa-swarm, and both code-review nodes is tagged and stored
- Tags: `{ codebase: "project-x", file_pattern: "src/api/*", category: "null-safety", severity: "HIGH", occurrences: 7 }`
- Stored to claude-mem (`tag: codebase-issue-patterns`)

**How QA swarm consumes it:**
- At swarm start: pull pattern library, filter by this story's blast radius via gitnexus
- Spawn pattern-specific agents only for top-K relevant patterns (frequency × recency weighted)
- Pattern agents know exactly what to hunt — not general review, targeted prosecution

**Compounding:** after 10 stories the pattern library contains the top recurring issues in this codebase. QA swarm stops re-discovering them and starts catching them on first implementation.

### Layer 1c: Dep Graph Calibration

Track every dep prediction that was wrong — missed dep caused merge conflict, or over-constrained deps that serialized work unnecessarily.

**Storage:** claude-mem (`tag: dep-graph-learnings`)
```
{ story_pair: ["1.2", "1.3"], predicted: "parallel", actual: "conflict",
  reason: "both touched src/db/migrations/ — DB migration stories always
           have implicit deps on model-layer stories" }
```

**Consumption:** DECOMPOSE step 3 reads dep graph learnings before constructing the graph. Learned heuristics apply as prior probability weights on dep inference. Over time, the dep graph gets built right the first time.

### Layer 1d: Hotspot Detection

Track file frequency across blast radii. Files appearing in 70%+ of stories are hotspots.

**Storage:** claude-mem (`tag: codebase-hotspots`)
**Consumption:** adversarial-review and both code-review nodes receive hotspot list — allocate proportionally more scrutiny to hotspot files. The riskiest files in the codebase get the most review automatically, without anyone deciding this manually.

### Layer 1e: Story Complexity Prediction

Track cycle times per story type, per module touched. Learns: "Stories touching auth.ts average 2.3× more fix iterations than average."

**Storage:** claude-mem (`tag: story-complexity`)
**Consumption:** orchestrator surfaces complexity prediction before launching each story:
```
⚡ Complexity signal: this story touches src/auth/ (historical avg: 2.3× fix iterations)
   Consider: splitting into smaller scope, or flagging for extra human attention
```
Human decides — the system just informs.

### Layer 1f: Test Gap Pattern Library

QA swarm logs every test gap found. Becomes: "In this codebase, always verify pagination edge cases, auth token expiry, and concurrent write handling."

**Storage:** claude-mem (`tag: test-gap-patterns`)
**Consumption:** implement node receives test gap library filtered by story blast radius. Before writing tests, agent consults it. Recurring test gaps stop recurring.

### Layer 2: Codebase Wiki

**Structure:**
```
.claude/wiki/
  index.md                    ← module map, navigation entry point
  modules/
    {module}.md               ← what it does, patterns, conventions, gotchas
  patterns/
    error-handling.md
    testing.md
    {pattern}.md
  decisions/
    adr-{N}-{slug}.md         ← architectural decisions with rationale
  changelog/
    {YYYY-MM-DD}.md           ← what changed and why
```

**Update triggers:**
- **Per story (finalize):** agent writes changelog entry, updates affected module pages
- **Nightly (scheduled via `schedule` skill):**
  1. `git log --since=yesterday --oneline`
  2. claude-mem search: observations from last 24h
  3. `gitnexus analyze`
  4. Rewrite affected module/pattern pages to reflect current state
  5. Consolidate decision log
  6. `git commit -m "wiki: nightly consolidation $(date +%Y-%m-%d)"`

**Integration throughout PIV loop:**
- All nodes: wiki auto-injected via claude-mem
- `create-plan`: "consult wiki/patterns/ before choosing implementation approach"
- `implement`: "consult wiki/modules/{relevant} for conventions before writing"
- `bmad-code-review-1/2`: flag violations of wiki/patterns/ as MEDIUM findings

### Layer 3: Structural Graph (GitNexus)

Already designed — refreshes after each merge. Complements the wiki:
- GitNexus graph = structure (file relationships, call graphs, deps)
- Wiki = meaning (what modules do, why decisions were made)
- Claude-mem = episodes (what happened recently, what was built)

**Compounding effect across all learning layers:**
```
After 10 stories:  QA swarm knows top recurring bugs; dep graph is calibrated;
                   wiki has key modules documented
After 25 stories:  hotspots identified; complexity predictions reliable;
                   test gap library eliminates recurring QA findings
After 50 stories:  pattern library catches issues on first implementation;
                   prompt A/B evolution has tightened the workflow measurably
After 100 stories: the system is a codebase expert — knows this team's blind spots
                   better than any individual developer, and keeps getting better
```

The system measurably improves with every cycle without explicit maintenance.

---

## 6. Modified / New Artifacts

| Artifact | Type | Action | Location |
|----------|------|--------|----------|
| `qds-piv-loop.yaml` | Archon workflow | CREATE | `Archon/.archon/workflows/defaults/` |
| `/qds` | Claude Code skill | CREATE | superpowers or project skills |
| `bmad-code-review` skill | Existing skill | MODIFY | add autonomous mode (structured JSON output, no HITL) |
| `bmad-sprint-planning` skill | Existing skill | USE as-is | DECOMPOSE steps 3-5 |
| `bmad-create-epics-and-stories` skill | Existing skill | USE as-is | DECOMPOSE step 1 |
| `bmad-retrospective` skill | Existing skill | USE as-is | finalize process learning |
| Nightly wiki agent | Scheduled skill | CREATE | via `schedule` skill |
| `.claude/wiki/` | Wiki directory | CREATE | per target project |
| `.claude/qds/` | State directory | CREATE | per target project |

---

## 7. What This Replaces

| Original Plan | Replaced By |
|--------------|-------------|
| Factory Core (Bun/TS, new runtime) | Archon's existing DAG executor |
| Overstory fork (agent lifecycle, mail, SQLite) | Archon's workflow runs + REST API |
| Pi SDK integration (6 packages) | Archon's existing CC SDK integration |
| ~64 stories, ~6,470 LOC | ~3 workflow YAMLs + 2 skills + wiki agent |
| 6-layer enforcement | Superpowers ambient + explicit skill invocations |
| Economic governance (ELO, budget) | Deferred — add later as Archon workflow node |

**Retained from original vision:** adversarial review, QA swarm, context isolation between dev and review agents, dep-aware story ordering, parallel worktree execution, git iron laws.

---

## 8. Open Questions (deferred)

1. **Telegram trigger** — Archon already supports Telegram as a platform adapter. Wire `/qds` as a Telegram command once the core is proven.
2. **Economic governance** — model tier policy (economy/standard/premium per node) can be added as per-node `model:` overrides in the workflow YAML once baseline is working.
3. **Full Option C** (native Archon orchestrator) — once the hybrid orchestrator pattern is proven, evaluate whether to add a "spawn sub-workflow-run" primitive to Archon proper.
