# QDS on Archon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build QDS Factory on Archon — a coding factory that accepts development stories and produces adversarially-reviewed PRs, running entirely as Archon workflow YAMLs + Claude Code skills.

**Architecture:** Two-tier: `/qds` CC skill (Tier 1 orchestrator, handles single stories and epics) kicks off `qds-piv-loop.yaml` (Tier 2, runs per story in an isolated git worktree via Archon). Per-node `env:` injection in Archon enables cost-optimized model routing (Anthropic Opus for planning, Z.ai/GLM 5.1 for all review/implement nodes). A self-learning layer (claude-mem pattern library + codebase wiki) compounds quality over time.

**Tech Stack:** Bun/TypeScript (Archon core modification), Zod (schema validation), YAML (workflow definition), bash (gitnexus integration + state management), Claude Code skills (markdown), Z.ai API (OpenAI-compatible, Anthropic-format at `https://api.z.ai/api/anthropic`).

---

## File Map

### Archon core changes (upstream)
| File | Action | Responsibility |
|------|--------|---------------|
| `packages/workflows/src/schemas/dag-node.ts` | MODIFY | Add `env?: Record<string, string>` to dagNodeBaseSchema |
| `packages/workflows/src/dag-executor.ts` | MODIFY | Per-node env injection after project-level envVars inject |
| `packages/workflows/src/schemas.test.ts` | MODIFY | Two tests: env field parses, env vars preserved as strings |
| `packages/workflows/src/dag-executor.test.ts` | MODIFY | Two tests: node.env overrides config.envVars, node.env alone sets env |

### Archon workflow
| File | Action | Responsibility |
|------|--------|---------------|
| `.archon/workflows/defaults/qds-piv-loop.yaml` | CREATE | Full 14-node PIV loop with review/QA/fix waves |

### bmad-code-review skill
| File | Action | Responsibility |
|------|--------|---------------|
| `~/.claude/skills/bmad-code-review/workflow.md` | MODIFY | Detect `--autonomous` flag, route to step-autonomous |
| `~/.claude/skills/bmad-code-review/steps/step-autonomous.md` | CREATE | Full review without HITL, outputs structured JSON |

### /qds skill
| File | Action | Responsibility |
|------|--------|---------------|
| `~/.claude/skills/qds/SKILL.md` | CREATE | Entry point — detect input type, dispatch to correct handler |
| `~/.claude/skills/qds/single-story.md` | CREATE | Single-story dispatch (worktree → Archon API → status tail) |
| `~/.claude/skills/qds/orchestrator.md` | CREATE | Epic path: DECOMPOSE pipeline, plan.json write, wave dispatch |
| `~/.claude/skills/qds/wave-executor.md` | CREATE | Ralph-loop wave poller, plan.json state machine |
| `~/.claude/skills/qds/init.md` | CREATE | First-run project initialization (wiki + qds state dirs) |

### Nightly wiki agent
| File | Action | Responsibility |
|------|--------|---------------|
| `~/.claude/skills/qds-wiki-nightly/SKILL.md` | CREATE | Nightly wiki consolidation (git log + mem + gitnexus → rewrite module pages) |

### Environment config
| File | Action | Responsibility |
|------|--------|---------------|
| `/Users/steve/archon/.env.example` | MODIFY | Add ZAI_API_KEY and ARCHON_URL entries with comments |

---

## Task 1: Add `env?` field to dag-node Zod schema

**Files:**
- Modify: `/Users/steve/archon/packages/workflows/src/schemas/dag-node.ts:138`

- [ ] **Step 1.1: Confirm current line 138**

  Run: `sed -n '135,141p' /Users/steve/archon/packages/workflows/src/schemas/dag-node.ts`

  Expected output:
  ```
    fallbackModel: z.string().min(1).optional(),
    betas: z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array").optional(),
    sandbox: sandboxSettingsSchema.optional(),
  });
  
  export type DagNodeBase = z.infer<typeof dagNodeBaseSchema>;
  ```

- [ ] **Step 1.2: Add `env` field to dagNodeBaseSchema**

  In `/Users/steve/archon/packages/workflows/src/schemas/dag-node.ts`, change line 138–139 from:
  ```typescript
    sandbox: sandboxSettingsSchema.optional(),
  });
  ```
  To:
  ```typescript
    sandbox: sandboxSettingsSchema.optional(),
    env: z.record(z.string()).optional(),
  });
  ```

- [ ] **Step 1.3: Run schema tests to verify the field parses**

  Run: `cd /Users/steve/archon/packages/workflows && bun test src/schemas.test.ts 2>&1 | tail -5`

  Expected: All existing tests pass (no new tests yet — added in Task 2).

- [ ] **Step 1.4: Commit**

  ```bash
  cd /Users/steve/archon
  git add packages/workflows/src/schemas/dag-node.ts
  git commit -m "feat(workflows): add per-node env field to dagNodeBaseSchema

  Adds env?: Record<string, string> to dagNodeBaseSchema so workflow YAML
  nodes can declare env var overrides for their Claude subprocess.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2: Schema tests for env field

**Files:**
- Modify: `/Users/steve/archon/packages/workflows/src/schemas.test.ts`

- [ ] **Step 2.1: Write failing tests**

  In `/Users/steve/archon/packages/workflows/src/schemas.test.ts`, find the block ending at approximately the last `test('parses fallbackModel string', ...)` test (around line 387). Add these two tests after it:

  ```typescript
  test('parses env record on prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      env: { ANTHROPIC_AUTH_TOKEN: '${ZAI_API_KEY}', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as PromptNode).env).toEqual({
        ANTHROPIC_AUTH_TOKEN: '${ZAI_API_KEY}',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      });
    }
  });

  test('rejects env with non-string value', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      env: { KEY: 42 },
    });
    expect(result.success).toBe(false);
  });
  ```

- [ ] **Step 2.2: Run to confirm tests pass** (they should pass because Task 1 already added the schema field)

  Run: `cd /Users/steve/archon/packages/workflows && bun test src/schemas.test.ts 2>&1 | tail -10`

  Expected: All tests pass including the two new ones.

- [ ] **Step 2.3: Commit**

  ```bash
  cd /Users/steve/archon
  git add packages/workflows/src/schemas.test.ts
  git commit -m "test(workflows): add schema tests for per-node env field

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3: Add per-node env injection to dag-executor.ts

**Files:**
- Modify: `/Users/steve/archon/packages/workflows/src/dag-executor.ts:601`

- [ ] **Step 3.1: Confirm current lines 597–605**

  Run: `sed -n '597,607p' /Users/steve/archon/packages/workflows/src/dag-executor.ts`

  Expected output:
  ```typescript
    }
    // Inject per-project env vars (config file + DB) into subprocess env
    if (config.envVars && Object.keys(config.envVars).length > 0) {
      claudeOptions.env = config.envVars;
    }

    // Per-node overrides take precedence...
    const effort = node.effort ?? workflowLevelOptions.effort;
  ```

- [ ] **Step 3.2: Add per-node env injection block**

  In `/Users/steve/archon/packages/workflows/src/dag-executor.ts`, change the block from:
  ```typescript
    // Inject per-project env vars (config file + DB) into subprocess env
    if (config.envVars && Object.keys(config.envVars).length > 0) {
      claudeOptions.env = config.envVars;
    }

    // Per-node overrides take precedence over workflow-level defaults; maxBudgetUsd and systemPrompt are per-node only
  ```
  To:
  ```typescript
    // Inject per-project env vars (config file + DB) into subprocess env
    if (config.envVars && Object.keys(config.envVars).length > 0) {
      claudeOptions.env = config.envVars;
    }

    // Per-node env overrides — win over project-level envVars
    if (node.env && Object.keys(node.env).length > 0) {
      const missingVars: string[] = [];
      const expandedNodeEnv = expandEnvVarsInRecord(node.env, missingVars);
      if (missingVars.length > 0) {
        getLog().warn({ nodeId: node.id, missingVars }, 'dag.node_env_vars_missing');
      }
      claudeOptions.env = { ...(claudeOptions.env ?? {}), ...expandedNodeEnv };
    }

    // Per-node overrides take precedence over workflow-level defaults; maxBudgetUsd and systemPrompt are per-node only
  ```

- [ ] **Step 3.3: Run type-check**

  Run: `cd /Users/steve/archon/packages/workflows && bun run typecheck 2>&1 | tail -10`

  Expected: No type errors.

- [ ] **Step 3.4: Commit**

  ```bash
  cd /Users/steve/archon
  git add packages/workflows/src/dag-executor.ts
  git commit -m "feat(workflows): inject per-node env into Claude subprocess

  Per-node env: block in workflow YAML overrides project-level envVars.
  Uses existing expandEnvVarsInRecord to expand \$VAR_NAME references from
  process.env at execution time. Missing vars warn but don't halt the run.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 4: dag-executor tests for per-node env override

**Files:**
- Modify: `/Users/steve/archon/packages/workflows/src/dag-executor.test.ts`

- [ ] **Step 4.1: Find the env var injection describe block**

  Run: `grep -n "executeDagWorkflow -- env var injection" /Users/steve/archon/packages/workflows/src/dag-executor.test.ts`

  Expected: Output shows the line number of `describe('executeDagWorkflow -- env var injection', () => {`

- [ ] **Step 4.2: Write the two new tests**

  In `/Users/steve/archon/packages/workflows/src/dag-executor.test.ts`, find the closing `});` of the `describe('executeDagWorkflow -- env var injection', ...)` block (the one that ends after `it('does not set env on claudeOptions when config.envVars is empty', ...)`). Add these two tests before that closing `});`:

  ```typescript
  it('per-node env overrides config.envVars for that node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-node-env-override',
        nodes: [{ id: 'task', command: 'my-cmd', env: { NODE_ENV: 'test', API_KEY: 'node-level' } }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { API_KEY: 'project-level', OTHER: 'keep' } }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    // Node-level API_KEY wins over project-level
    expect((optionsArg?.env as Record<string, string>)?.API_KEY).toBe('node-level');
    // Project-level OTHER is preserved (merge, not replace)
    expect((optionsArg?.env as Record<string, string>)?.OTHER).toBe('keep');
    // Node-level NODE_ENV is added
    expect((optionsArg?.env as Record<string, string>)?.NODE_ENV).toBe('test');
  });

  it('per-node env sets env even without config.envVars', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-node-env-only',
        nodes: [{ id: 'task', command: 'my-cmd', env: { ZAI_ROUTE: 'enabled' } }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: {} }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect((optionsArg?.env as Record<string, string>)?.ZAI_ROUTE).toBe('enabled');
  });
  ```

- [ ] **Step 4.3: Run executor tests to confirm passing**

  Run: `cd /Users/steve/archon/packages/workflows && bun test src/dag-executor.test.ts 2>&1 | tail -15`

  Expected: All tests pass including the two new ones.

- [ ] **Step 4.4: Run full workflow package test suite**

  Run: `cd /Users/steve/archon/packages/workflows && npm test 2>&1 | tail -20`

  Expected: All tests pass.

- [ ] **Step 4.5: Commit**

  ```bash
  cd /Users/steve/archon
  git add packages/workflows/src/dag-executor.test.ts
  git commit -m "test(workflows): verify per-node env override and merge behavior

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 5: Add autonomous mode to bmad-code-review skill

**Files:**
- Modify: `~/.claude/skills/bmad-code-review/workflow.md`
- Create: `~/.claude/skills/bmad-code-review/steps/step-autonomous.md`

- [ ] **Step 5.1: Modify workflow.md to detect autonomous mode**

  In `~/.claude/skills/bmad-code-review/workflow.md`, find the `### 2. First Step Execution` section (near the bottom). Change it from:
  ```markdown
  ### 2. First Step Execution

  Read fully and follow: `./steps/step-01-gather-context.md` to begin the workflow.
  ```
  To:
  ```markdown
  ### 2. First Step Execution

  **Check for autonomous mode first:**

  If the user's message that triggered this skill contains `--autonomous`, OR if the conversation
  context shows this skill was invoked from within an Archon workflow node:
  - Skip all interactive steps
  - Read fully and follow: `./steps/step-autonomous.md`

  Otherwise (standard interactive mode):
  - Read fully and follow: `./steps/step-01-gather-context.md` to begin the workflow.
  ```

- [ ] **Step 5.2: Create step-autonomous.md**

  Create `~/.claude/skills/bmad-code-review/steps/step-autonomous.md` with this content:

  ```markdown
  # Step Autonomous — Non-Interactive Code Review

  ## RULES

  - Do NOT pause for human input at any point.
  - Do NOT emit checkpoints or ask questions.
  - Output ONLY the structured JSON at the end.
  - This step runs in a fresh agent context — there is no prior conversation.

  ## INSTRUCTIONS

  ### 1. Identify the diff

  ```bash
  BASE_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null | sed 's|origin/||' || echo "main")
  git diff ${BASE_BRANCH}..HEAD --stat
  git diff ${BASE_BRANCH}..HEAD
  ```

  If the diff is empty, output:
  ```json
  {"HIGH":[],"MEDIUM":[],"LOW":[],"ERROR":"Empty diff — no changes to review"}
  ```
  Then exit.

  ### 2. Run parallel review layers

  Spawn three review agents in parallel (fresh context, no cross-contamination):

  **Agent 1 — Blind Hunter (logic + correctness):**
  Review the diff for: incorrect logic, off-by-one errors, wrong return values, missed null
  checks, broken error paths, incorrect assumptions about caller behavior. Produce a list of
  `"<file:line> — <issue>"` strings. Be precise — file path and approximate line number required.

  **Agent 2 — Edge Case Hunter (boundaries + inputs):**
  Review the diff for: empty inputs, zero values, max boundary conditions, concurrent
  access, race conditions, unhandled async failures, malformed external data. Same output format.

  **Agent 3 — Security + Trust Boundary Auditor:**
  Review the diff for: unvalidated external input reaching sensitive operations, SQL injection,
  command injection, path traversal, privilege escalation, secrets in logs, insecure defaults,
  missing auth checks. Same output format.

  ### 3. Triage findings by severity

  For each finding from all three agents, assign severity:
  - **HIGH**: could cause data loss, security breach, incorrect behavior in production
  - **MEDIUM**: degrades reliability or maintainability; requires fixing before merge
  - **LOW**: style, minor improvements, optional hardening

  Deduplicate identical findings from multiple agents.

  ### 4. Output structured JSON

  Output ONLY this JSON block — no prose before or after:

  ```json
  {
    "HIGH":   ["<file:line> — <issue description>", ...],
    "MEDIUM": ["<file:line> — <issue description>", ...],
    "LOW":    ["<file:line> — <issue description>", ...]
  }
  ```

  If no findings in a bucket, output an empty array for that key.
  ```

- [ ] **Step 5.3: Verify skill structure**

  Run: `ls ~/.claude/skills/bmad-code-review/steps/`

  Expected: `step-01-gather-context.md  step-02-review.md  step-03-triage.md  step-04-present.md  step-autonomous.md`

- [ ] **Step 5.4: Commit**

  ```bash
  cd /Users/steve/QDS-Factory
  git add -A -- "$(realpath ~/.claude/skills/bmad-code-review/)" 2>/dev/null || true
  # Note: ~/.claude files are not in this repo — commit to the skills location separately
  # or document the change in a skills-changelog.md
  echo "bmad-code-review: added autonomous mode (step-autonomous.md)" >> docs/skills-changelog.md
  git add docs/skills-changelog.md
  git commit -m "feat(skills): add autonomous mode to bmad-code-review

  Adds --autonomous flag detection in workflow.md and new step-autonomous.md
  for non-interactive structured JSON review output. Used by qds-piv-loop review
  nodes which cannot pause for human input.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 6: Create qds-piv-loop.yaml — skeleton + nodes 1–3

**Files:**
- Create: `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`

- [ ] **Step 6.1: Create the workflow skeleton with gitnexus-check + explore + create-plan**

  Create `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`:

  ```yaml
  name: qds-piv-loop
  description: |
    QDS Factory PIV Loop — Full adversarial coding pipeline for a single story.
    Extends archon-piv-loop with: adversarial review, QA swarm, dual code-review waves,
    and self-learning integration (claude-mem + codebase wiki + gitnexus).

    Use when: A QDS orchestrator (/qds skill) or human triggers a story run.
    Input ($ARGUMENTS): path to story .md file, or free-text story description.
    Working directory: an isolated git worktree at .worktrees/{story-id}.

    NOT for: interactive feature exploration (use archon-piv-loop).
    NOT for: PRD creation (use archon-interactive-prd).

  provider: claude
  interactive: false

  nodes:

    # ═══════════════════════════════════════════════════════════════
    # NODE 1: GITNEXUS-CHECK — ensure graph is fresh (< 1h old)
    # ═══════════════════════════════════════════════════════════════

    - id: gitnexus-check
      bash: |
        set -e
        mkdir -p .claude/qds/runs
        STORY_ARG="$ARGUMENTS"
        # Derive story ID from filename or hash of text
        if [ -f "$STORY_ARG" ]; then
          STORY_ID=$(basename "$STORY_ARG" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
        else
          STORY_ID="story-$(echo "$STORY_ARG" | md5sum | cut -c1-8)"
        fi
        echo "STORY_ID=${STORY_ID}"
        mkdir -p ".claude/qds/runs/${STORY_ID}"
        echo "PENDING" > ".claude/qds/runs/${STORY_ID}/status"

        # Refresh gitnexus graph if stale (> 1 hour)
        LAST=$(cat .claude/qds/.gitnexus-last-analyze 2>/dev/null || echo 0)
        NOW=$(date +%s)
        if [ $((NOW - LAST)) -gt 3600 ]; then
          echo "Refreshing gitnexus graph..."
          gitnexus analyze && echo $NOW > .claude/qds/.gitnexus-last-analyze
        else
          echo "GitNexus graph is fresh (age: $((NOW - LAST))s)"
        fi

        # Check .claude/wiki/ exists; if not, print a reminder
        if [ ! -d ".claude/wiki" ]; then
          echo "WARNING: .claude/wiki/ not found. Run /qds init to scaffold the wiki."
        fi

        echo "STORY_ID=${STORY_ID}"
        echo "GITNEXUS_READY=true"

    # ═══════════════════════════════════════════════════════════════
    # NODE 2: EXPLORE — Understand the story, map the codebase
    # Anthropic Opus (no env override — hits Anthropic directly)
    # ═══════════════════════════════════════════════════════════════

    - id: explore
      depends_on: [gitnexus-check]
      model: opus
      context: shared
      loop:
        prompt: |
          # QDS PIV Loop — Exploration

          You are a senior engineering partner. Your job: deeply understand the story
          before any planning begins. You have full codebase intelligence via GitNexus.

          **Story/request**: $ARGUMENTS
          **Setup context**: $gitnexus-check.output

          ---

          ## On first iteration:

          ### Step 1: Read context
          1. Read CLAUDE.md (project conventions, architecture, constraints)
          2. If $ARGUMENTS is a file path → read the story file in full
          3. Check claude-mem for related past work: use `/memory:memory-search` with
             keywords from the story title. Load top 3 relevant observations.
          4. If .claude/wiki/index.md exists → read it for module map

          ### Step 2: Codebase intelligence via GitNexus (no file reading yet)
          ```bash
          # Map architectural paths relevant to this story
          gitnexus route_map --query "<story keywords>"
          # Find files likely in scope
          gitnexus query --q "<story feature area>"
          # Check hotspots if wiki exists
          cat .claude/qds/.hotspots 2>/dev/null || true
          ```

          ### Step 3: Targeted file reading
          Read only the files GitNexus identifies as entry points or key files for
          this story. Read relevant wiki module pages if they exist:
          `cat .claude/wiki/modules/<relevant-module>.md 2>/dev/null || true`

          ### Step 4: Present understanding
          ```
          ## Story Understanding

          Building: {restated in 2-3 sentences}

          ## Files in Scope (from GitNexus)
          - {file:estimated-line} — {what changes and why}

          ## Codebase Patterns to Follow
          - {pattern from wiki or code reading}

          ## Key Questions
          1. {question about scope/approach}
          2. {question about constraint/dependency}
          ```

          Say "ready" or provide answers to proceed to planning.

          **CRITICAL**: NEVER emit <promise>PLAN_READY</promise> unless the user says
          "ready", "create the plan", "proceed", or equivalent.

        until: PLAN_READY
        max_iterations: 10
        interactive: true
        gate_message: |
          Answer the questions above or say "ready" to proceed to planning.

    # ═══════════════════════════════════════════════════════════════
    # NODE 3: CREATE-PLAN — Structured implementation plan
    # Anthropic Opus (no env override)
    # ═══════════════════════════════════════════════════════════════

    - id: create-plan
      depends_on: [explore]
      model: opus
      context: fresh
      prompt: |
        # QDS PIV Loop — Create Plan

        You are creating a complete implementation plan. This plan is the SOLE GUIDE
        for the implement agent — it must be specific enough for a developer with
        zero context to execute without asking questions.

        **Story**: $ARGUMENTS
        **Exploration summary**: $explore.output
        **Setup context**: $gitnexus-check.output

        Extract the STORY_ID from the setup context output (line: `STORY_ID=...`).

        ---

        ## Step 1: Confirm blast radius with GitNexus
        ```bash
        gitnexus impact --paths "<key files from explore>"
        ```
        Read any files GitNexus flags as HIGH impact that weren't read in explore.
        Consult .claude/wiki/patterns/ for relevant implementation patterns.

        ## Step 2: Check library APIs if needed
        For any external library APIs you'll use: invoke Context7 to get current
        API signatures. Prefer library docs over your training data for API calls.

        ## Step 3: Write the plan
        Save to `.claude/qds/runs/{STORY_ID}/plan.md`

        Plan format (FILL EVERY SECTION — no placeholders):
        ```markdown
        # Story: {title}

        ## Summary
        {1-2 sentences: what changes, why, scope boundary}

        ## Success Criteria
        - [ ] {Specific testable criterion}
        - [ ] All validation passes
        - [ ] No regressions in existing tests

        ## Files
        | File | Action | What changes |
        |------|--------|-------------|
        | `{path}` | CREATE/UPDATE | {exactly what changes} |

        ## Codebase Patterns
        {Actual code snippets from wiki or codebase to mirror}

        ## Architecture Decisions
        - {Decision with rationale}

        ## Task List
        ### Task 1: {ACTION} `{file}`
        **Details**: {Specific enough for zero-context agent}
        **Pattern**: Follow `{source}:{lines}`
        **Validate**: `{command}`

        ## Testing Strategy
        | Test File | Test Cases | Validates |
        |-----------|-----------|-----------|
        | `{path}` | {cases} | {what} |

        ## Validation Commands
        1. {type-check command}
        2. {lint command}
        3. {test command}
        ```

        ## Step 4: Store key decisions to claude-mem
        After saving the plan file, store the key architectural decisions:
        Use the memory tool to store: story ID, key files, main design decisions,
        approach chosen, and any gotchas discovered. Tag: `qds-story-{STORY_ID}`.

        ## Step 5: Report
        ```
        ## Plan Created

        File: .claude/qds/runs/{STORY_ID}/plan.md
        Tasks: {count}
        Files: {count files to change}

        Key decisions:
        - {decision 1}
        - {decision 2}

        Review the plan and provide feedback, or say "approved" to begin implementation.
        ```
  ```

- [ ] **Step 6.2: Verify YAML syntax for the created portion**

  Run: `python3 -c "import yaml; data=yaml.safe_load(open('/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml').read()); print(f'OK — {len(data[\"nodes\"])} nodes parsed')"`

  Expected: `OK — 3 nodes parsed`

- [ ] **Step 6.3: Commit**

  ```bash
  cd /Users/steve/archon
  git add .archon/workflows/defaults/qds-piv-loop.yaml
  git commit -m "feat(workflows): add qds-piv-loop — nodes 1-3 (gitnexus-check, explore, create-plan)

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 7: qds-piv-loop.yaml — nodes 4–6 (refine-plan, implement-setup, implement)

**Files:**
- Modify: `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`

- [ ] **Step 7.1: Append refine-plan + implement-setup + implement nodes**

  Append to `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`:

  ```yaml

    # ═══════════════════════════════════════════════════════════════
    # NODE 4: REFINE-PLAN — Iterative plan review
    # Anthropic Opus (no env override)
    # ═══════════════════════════════════════════════════════════════

    - id: refine-plan
      depends_on: [create-plan]
      model: opus
      context: shared
      loop:
        prompt: |
          # QDS PIV Loop — Plan Refinement

          **User feedback**: $LOOP_USER_INPUT
          **Story**: $ARGUMENTS

          ---

          ## Step 1: Read the plan
          ```bash
          STORY_ARG="$ARGUMENTS"
          if [ -f "$STORY_ARG" ]; then
            STORY_ID=$(basename "$STORY_ARG" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
          else
            STORY_ID="story-$(echo "$STORY_ARG" | md5sum | cut -c1-8)"
          fi
          cat ".claude/qds/runs/${STORY_ID}/plan.md"
          ```

          ## Step 2: Process feedback

          **If no feedback yet (first iteration)**:
          - Present plan summary (tasks + files)
          - Ask user to review and approve or provide feedback

          **If user explicitly approved** ("approved", "looks good", "proceed"):
          - Update status: `echo "PLAN_APPROVED" >> .claude/qds/runs/${STORY_ID}/status`
          - Output: "Plan approved. Starting implementation."
          - Signal: <promise>PLAN_APPROVED</promise>

          **If user provided feedback**:
          - Edit the plan file to incorporate changes
          - Show what changed
          - Ask for further review or approval

          **CRITICAL**: NEVER emit <promise>PLAN_APPROVED</promise> unless the user
          EXPLICITLY says "approved", "looks good", "ship it", or equivalent.

        until: PLAN_APPROVED
        max_iterations: 8
        interactive: true
        gate_message: |
          Review the plan file. Provide feedback or say "approved" to start implementation.

    # ═══════════════════════════════════════════════════════════════
    # NODE 5: IMPLEMENT-SETUP — Prepare environment
    # Bash only — no AI
    # ═══════════════════════════════════════════════════════════════

    - id: implement-setup
      depends_on: [refine-plan]
      bash: |
        set -e
        STORY_ARG="$ARGUMENTS"
        if [ -f "$STORY_ARG" ]; then
          STORY_ID=$(basename "$STORY_ARG" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
        else
          STORY_ID="story-$(echo "$STORY_ARG" | md5sum | cut -c1-8)"
        fi

        PLAN_FILE=".claude/qds/runs/${STORY_ID}/plan.md"
        if [ ! -f "$PLAN_FILE" ]; then
          echo "ERROR: Plan file not found at $PLAN_FILE"
          exit 1
        fi

        # Install dependencies if needed
        if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
          bun install --frozen-lockfile 2>&1 | tail -3
        elif [ -f "package-lock.json" ]; then
          npm ci 2>&1 | tail -3
        fi

        echo "STORY_ID=${STORY_ID}"
        echo "PLAN_FILE=${PLAN_FILE}"
        echo "BRANCH=$(git branch --show-current)"
        echo "GIT_ROOT=$(git rev-parse --show-toplevel)"
        echo ""
        echo "=== PLAN_START ==="
        cat "$PLAN_FILE"
        echo "=== PLAN_END ==="

        TASK_COUNT=$(grep -c "^### Task " "$PLAN_FILE" || true)
        echo "TASK_COUNT=${TASK_COUNT:-0}"
        echo "IN_PROGRESS" > ".claude/qds/runs/${STORY_ID}/status"

    # ═══════════════════════════════════════════════════════════════
    # NODE 6: IMPLEMENT — Task-by-task implementation (ralph pattern)
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # Fresh context each iteration — reads plan from disk
    # ═══════════════════════════════════════════════════════════════

    - id: implement
      depends_on: [implement-setup]
      model: opus
      idle_timeout: 600000
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      loop:
        prompt: |
          # QDS PIV Loop — Implementation Agent

          You are an autonomous coding agent in a FRESH context. No memory of prior iterations.
          Read the plan from disk. Implement ONE task. Validate. Commit. Update progress. Exit.

          **Golden Rule**: Never commit broken code. Fix validation failures before committing.

          Use Context7 when you need current API signatures for any library you're touching.

          ---

          ## Phase 0: Load State

          Setup output: $implement-setup.output

          Extract STORY_ID, PLAN_FILE from setup output.

          Re-read from disk (setup snapshot may be stale from prior iterations):
          1. `cat $PLAN_FILE` — your implementation guide
          2. `cat .claude/qds/runs/$STORY_ID/progress.txt 2>/dev/null` — completed tasks
          3. Read CLAUDE.md — project conventions

          ```bash
          git log --oneline -10
          git status
          ```

          ## Phase 1: Select next task

          Find the lowest-numbered `### Task N:` header not yet in progress.txt.

          **If all tasks complete** → Skip to Phase 5.

          Announce:
          ```
          -- Task Selected -----------------------------------------------
          Task: {N} — {title}
          File: {path}
          ---------------------------------------------------------------
          ```

          ## Phase 2: Implement

          1. Read the file to modify (if it exists)
          2. Read pattern files referenced in the plan
          3. Make changes following the plan exactly
          4. Run type-check after each file change

          ## Phase 3: Validate

          Run the validation commands from the plan's Validation Commands section.

          If validation fails: fix and re-run (up to 3 attempts).
          If unfixable after 3 attempts: note in progress.txt as BLOCKED and exit normally.

          ## Phase 4: Commit

          ```bash
          git add -A
          git diff --cached --stat
          git commit -m "$(cat <<'EOF'
          {type}: {task description}

          QDS Task {N}/{total}: {brief detail}
          EOF
          )"
          ```

          Append to `.claude/qds/runs/$STORY_ID/progress.txt`:
          ```
          Task {N}: {title} — COMPLETED
          Commit: $(git log --oneline -1 | cut -d' ' -f1)
          Files: {comma-separated files changed}
          ---
          ```

          ## Phase 5: Check completion

          If all tasks complete:
          1. Run full validation suite
          2. Signal: <promise>COMPLETE</promise>

          If tasks remain: report task count and exit normally. Loop continues.

        until: COMPLETE
        max_iterations: 15
        fresh_context: true
  ```

- [ ] **Step 7.2: Verify YAML syntax**

  Run: `python3 -c "import yaml; data=yaml.safe_load(open('/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml').read()); print(f'OK — {len(data[\"nodes\"])} nodes parsed')"`

  Expected: `OK — 6 nodes parsed`

- [ ] **Step 7.3: Commit**

  ```bash
  cd /Users/steve/archon
  git add .archon/workflows/defaults/qds-piv-loop.yaml
  git commit -m "feat(workflows): qds-piv-loop nodes 4-6 (refine-plan, implement-setup, implement)

  implement node uses Z.ai per-node env — GLM 5.1 Opus tier for cost optimization.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 8: qds-piv-loop.yaml — nodes 7–9 (fix-feedback, adversarial-review, qa-swarm)

**Files:**
- Modify: `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`

- [ ] **Step 8.1: Append fix-feedback + adversarial-review + qa-swarm nodes**

  Append to `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`:

  ```yaml

    # ═══════════════════════════════════════════════════════════════
    # NODE 7: FIX-FEEDBACK — Human validates implementation
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # Human sees the implementation FIRST before automated review
    # ═══════════════════════════════════════════════════════════════

    - id: fix-feedback
      depends_on: [implement]
      model: opus
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      loop:
        prompt: |
          # QDS PIV Loop — Human Validation & Fixes

          **Human feedback**: $LOOP_USER_INPUT
          **Story**: $ARGUMENTS

          ---

          ## Step 1: Read context
          ```bash
          STORY_ARG="$ARGUMENTS"
          if [ -f "$STORY_ARG" ]; then
            STORY_ID=$(basename "$STORY_ARG" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
          else
            STORY_ID="story-$(echo "$STORY_ARG" | md5sum | cut -c1-8)"
          fi
          cat ".claude/qds/runs/${STORY_ID}/plan.md"
          git log --oneline -10
          git diff $(git merge-base HEAD main)..HEAD --stat
          ```

          ## Step 2: Process feedback

          **If no feedback yet (first iteration)**:
          Present implementation summary:
          - What was built (from progress.txt)
          - Files changed (git diff --stat)
          - How to test: suggest the commands from the plan's validation section
          Ask user to test and provide feedback.

          **If user EXPLICITLY approved** ("approved", "looks good", "ship it"):
          - Signal: <promise>VALIDATED</promise>

          **CRITICAL**: NEVER emit <promise>VALIDATED</promise> unless user EXPLICITLY approves.

          **If user provided feedback**:
          1. Read the relevant files
          2. Understand each issue
          3. Make the fixes
          4. Run validation commands
          5. Commit fixes:
          ```bash
          git add -A
          git commit -m "fix: address human review feedback

          Changes:
          - {fix 1}
          - {fix 2}"
          ```

          ## Step 3: Report
          ```
          ## Feedback Addressed

          Changes: {list}
          Validation: PASS / FAIL with details

          Review again or say "approved" to proceed to automated review.
          ```

        until: VALIDATED
        max_iterations: 10
        interactive: true
        gate_message: |
          Test the implementation. Provide feedback on what needs fixing, or say "approved".

    # ═══════════════════════════════════════════════════════════════
    # NODE 8: ADVERSARIAL-REVIEW — Fresh-context adversarial review
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # No HITL — outputs findings and exits
    # ═══════════════════════════════════════════════════════════════

    - id: adversarial-review
      depends_on: [fix-feedback]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Adversarial Review

        You are a fresh reviewer — NO access to prior conversation context.
        You see only the code changes. Your job: find EVERYTHING that could go wrong.

        **Story**: $ARGUMENTS

        ---

        ## Step 1: Get the full diff

        ```bash
        BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "")
        if [ -z "$BASE" ]; then
          git diff HEAD~1..HEAD --stat
          git diff HEAD~1..HEAD
        else
          git diff ${BASE}..HEAD --stat
          git diff ${BASE}..HEAD
        fi
        ```

        ## Step 2: Check hotspots and wiki

        ```bash
        cat .claude/qds/.hotspots 2>/dev/null || true
        cat .claude/wiki/patterns/error-handling.md 2>/dev/null || true
        cat .claude/wiki/patterns/testing.md 2>/dev/null || true
        ```

        ## Step 3: Invoke adversarial review skill

        Use the `bmad-review-adversarial-general` skill with `--autonomous` flag.
        Review ALL changes since branch creation. Focus on:
        - Logic errors and incorrect assumptions
        - Missing error handling in new paths
        - Data integrity issues
        - Security boundary violations
        - Race conditions in async code
        - Missing tests for edge cases

        Extra scrutiny on hotspot files (files in .claude/qds/.hotspots).

        ## Step 4: Output findings

        Output this structure (no prose before or after):
        ```
        ADVERSARIAL_REVIEW_START
        {findings as bullet points, each on its own line: "• <file:line> — <issue>"}
        RISK: {LOW | MEDIUM | HIGH}
        ADVERSARIAL_REVIEW_END
        ```

    # ═══════════════════════════════════════════════════════════════
    # NODE 9: QA-SWARM — Pattern-targeted parallel QA
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # No HITL — outputs findings and exits
    # ═══════════════════════════════════════════════════════════════

    - id: qa-swarm
      depends_on: [adversarial-review]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — QA Swarm

        Fresh context. You orchestrate parallel QA agents targeting specific issue patterns.
        Max 6 agents total. Hard cap — do not exceed.

        **Story**: $ARGUMENTS

        ---

        ## Step 1: Load pattern library and filter by blast radius

        ```bash
        # Load known issue patterns from claude-mem
        # Use memory tool: search tag:codebase-issue-patterns
        # Then filter: which patterns intersect this story's changed files?
        BASE=$(git merge-base HEAD main 2>/dev/null || echo "HEAD~1")
        CHANGED_FILES=$(git diff ${BASE}..HEAD --name-only)
        echo "$CHANGED_FILES"
        gitnexus impact --paths "$(echo $CHANGED_FILES | tr '\n' ',')" 2>/dev/null || true
        ```

        ## Step 2: Spawn agents in parallel (max 6)

        **Standard agents (always spawn — these 3 are mandatory):**

        Agent 1 — Concurrency + race conditions:
        Review all async code, shared state, concurrent writes, missing mutex/lock patterns,
        promise chains that could interleave incorrectly.

        Agent 2 — Data integrity + edge inputs:
        Empty arrays, null/undefined/zero values, max string lengths, missing validation on
        external data, incorrect type coercions, off-by-one in loops.

        Agent 3 — Security boundaries + trust assumptions:
        Unvalidated input reaching sensitive operations, missing auth checks, path traversal,
        hardcoded secrets, logging of sensitive data, insecure direct object references.

        **Pattern agents (spawn only if pattern is relevant to changed files):**
        Read the filtered patterns from Step 1. For each pattern with ≥3 occurrences that
        touches files in CHANGED_FILES: spawn a targeted agent. Cap total at 6.
        Example pattern agent prompt: "Hunt for null checks on external API responses in
        the changed files — this pattern has caused 7 production issues in this codebase."

        ## Step 3: Aggregate findings

        Collect all agent outputs. Deduplicate. Format:
        ```json
        {
          "HIGH":   ["<file:line> — <issue>", ...],
          "MEDIUM": ["<file:line> — <issue>", ...],
          "LOW":    ["<file:line> — <issue>", ...]
        }
        ```

        ## Step 4: Update test gap pattern library

        For each HIGH finding: store to claude-mem with tag `test-gap-patterns`:
        `{ file_pattern: "<matching pattern>", issue: "<description>", story: "<STORY_ID>" }`

        Output the JSON findings block, then exit.
  ```

- [ ] **Step 8.2: Verify YAML syntax**

  Run: `python3 -c "import yaml; data=yaml.safe_load(open('/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml').read()); print(f'OK — {len(data[\"nodes\"])} nodes parsed')"`

  Expected: `OK — 9 nodes parsed`

- [ ] **Step 8.3: Commit**

  ```bash
  cd /Users/steve/archon
  git add .archon/workflows/defaults/qds-piv-loop.yaml
  git commit -m "feat(workflows): qds-piv-loop nodes 7-9 (fix-feedback, adversarial-review, qa-swarm)

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 9: qds-piv-loop.yaml — nodes 10–14 (review-1, fix-wave-1, review-2, fix-wave-2, finalize)

**Files:**
- Modify: `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`

- [ ] **Step 9.1: Append final five nodes**

  Append to `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`:

  ```yaml

    # ═══════════════════════════════════════════════════════════════
    # NODE 10: BMAD-CODE-REVIEW-1 — First structured code review
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # No HITL — outputs structured JSON
    # ═══════════════════════════════════════════════════════════════

    - id: bmad-code-review-1
      depends_on: [qa-swarm]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Code Review Round 1

        Fresh context. Review all changes using the bmad-code-review methodology.
        Do NOT pause for human input.

        **Prior review context**:
        Adversarial review findings: $adversarial-review.output
        QA swarm findings: $qa-swarm.output

        **Story**: $ARGUMENTS

        ---

        ## Step 1: Get diff and context
        ```bash
        BASE=$(git merge-base HEAD main 2>/dev/null || echo "HEAD~1")
        git diff ${BASE}..HEAD --stat
        git diff ${BASE}..HEAD
        cat .claude/qds/.hotspots 2>/dev/null || true
        cat .claude/wiki/patterns/ 2>/dev/null || true
        ```

        ## Step 2: Run bmad-code-review in autonomous mode
        Invoke the `bmad-code-review` skill with `--autonomous`.

        Also consider:
        - Any wiki/patterns/ violations (flag as MEDIUM)
        - Hotspot files from .claude/qds/.hotspots deserve extra scrutiny
        - Do NOT re-report issues already captured in adversarial or QA swarm findings
          unless you have additional context to add (different file:line, new angle)

        ## Step 3: Merge all findings
        Combine skill output with any additional findings you identified.
        Deduplicate with adversarial-review and qa-swarm outputs.

        ## Step 4: Output ONLY this JSON — no prose

        ```json
        {
          "HIGH":   ["<file:line> — <issue>", ...],
          "MEDIUM": ["<file:line> — <issue>", ...],
          "LOW":    ["<file:line> — <issue>", ...]
        }
        ```

    # ═══════════════════════════════════════════════════════════════
    # NODE 11: FIX-WAVE-1 — Parallel priority-bucketed fixes
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # ═══════════════════════════════════════════════════════════════

    - id: fix-wave-1
      depends_on: [bmad-code-review-1]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Fix Wave 1

        **Code review findings**: $bmad-code-review-1.output
        **Story**: $ARGUMENTS

        ---

        ## Step 1: Parse the findings

        Parse the JSON from bmad-code-review-1 output. Extract HIGH, MEDIUM, LOW buckets.

        If all buckets are empty: output "No fixes needed — wave 1 complete." and exit.

        ## Step 2: Read context
        ```bash
        git log --oneline -5
        git status
        cat CLAUDE.md
        ```

        ## Step 3: Spawn fix agents in parallel (one per non-empty bucket)

        For each non-empty bucket, spawn a focused agent with ONLY that bucket's findings:

        **HIGH-priority agent** (if HIGH is non-empty):
        "Fix these HIGH priority issues from code review. Each issue is in format
        `file:line — description`. Read each file, locate the issue, fix it.
        Run validation after each fix. Commit all HIGH fixes together:
        `git commit -m 'fix(qds): address HIGH priority review findings'`
        HIGH issues: {HIGH array from JSON}"

        **MEDIUM-priority agent** (if MEDIUM is non-empty):
        Same pattern. Commit: `git commit -m 'fix(qds): address MEDIUM priority review findings'`

        **LOW-priority agent** (if LOW is non-empty):
        Same pattern. Commit: `git commit -m 'fix(qds): address LOW priority review findings'`

        ## Step 4: Verify all agents completed
        ```bash
        git log --oneline -10
        git status
        ```
        Ensure working tree is clean. Run validation:
        ```bash
        bun run validate 2>&1 || (bun run typecheck && bun run lint && bun run test)
        ```

        Output: "Fix wave 1 complete. Commits: {list of commit hashes}"

    # ═══════════════════════════════════════════════════════════════
    # NODE 12: BMAD-CODE-REVIEW-2 — Second structured code review
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # Catches anything missed or newly introduced by fix-wave-1
    # ═══════════════════════════════════════════════════════════════

    - id: bmad-code-review-2
      depends_on: [fix-wave-1]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Code Review Round 2

        Fresh context. This is the SECOND code review pass — run after fix-wave-1.
        Focus on: (1) anything not fixed from round 1, (2) new issues introduced by fixes.

        **Round 1 findings** (for context on what was supposed to be fixed):
        $bmad-code-review-1.output

        **Story**: $ARGUMENTS

        ---

        ## Step 1: Get diff
        ```bash
        BASE=$(git merge-base HEAD main 2>/dev/null || echo "HEAD~1")
        git diff ${BASE}..HEAD --stat
        git diff ${BASE}..HEAD
        ```

        ## Step 2: Run bmad-code-review --autonomous

        Invoke `bmad-code-review` skill with `--autonomous`. Concentrate on:
        - Did the fix-wave-1 agents actually fix the round-1 HIGH findings?
        - Did any fixes introduce new issues?
        - Any remaining MEDIUM/LOW issues worth catching?
        - Wiki pattern violations in any new code from the fixes

        ## Step 3: Output ONLY structured JSON

        ```json
        {
          "HIGH":   ["<file:line> — <issue>", ...],
          "MEDIUM": ["<file:line> — <issue>", ...],
          "LOW":    ["<file:line> — <issue>", ...]
        }
        ```

        If everything was fixed and no new issues found: `{"HIGH":[],"MEDIUM":[],"LOW":[]}`

    # ═══════════════════════════════════════════════════════════════
    # NODE 13: FIX-WAVE-2 — Second parallel fix wave
    # Z.ai → GLM 5.1 (Opus tier) via per-node env
    # ═══════════════════════════════════════════════════════════════

    - id: fix-wave-2
      depends_on: [bmad-code-review-2]
      model: opus
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.1
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Fix Wave 2

        **Code review 2 findings**: $bmad-code-review-2.output
        **Story**: $ARGUMENTS

        ---

        Parse the JSON from bmad-code-review-2 output.

        If all buckets empty: output "No fixes needed — fix wave 2 skipped." and exit.

        Otherwise: spawn parallel fix agents per priority bucket (identical pattern to fix-wave-1).

        **HIGH-priority agent** (if HIGH non-empty):
        Fix each HIGH issue. Commit: `git commit -m 'fix(qds): address round-2 HIGH findings'`

        **MEDIUM-priority agent** (if MEDIUM non-empty):
        Commit: `git commit -m 'fix(qds): address round-2 MEDIUM findings'`

        **LOW-priority agent** (if LOW non-empty):
        Commit: `git commit -m 'fix(qds): address round-2 LOW findings'`

        Run final validation after all agents complete:
        ```bash
        bun run validate 2>&1 || (bun run typecheck && bun run lint && bun run test)
        ```

        Output: "Fix wave 2 complete. Branch is ready for PR."

    # ═══════════════════════════════════════════════════════════════
    # NODE 14: FINALIZE — Push, PR, learning, wiki update
    # Z.ai → GLM 5-turbo (Sonnet tier) — scripted operations only
    # ═══════════════════════════════════════════════════════════════

    - id: finalize
      depends_on: [fix-wave-2]
      model: sonnet
      context: fresh
      env:
        ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}
        ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
        ANTHROPIC_DEFAULT_SONNET_MODEL: glm-5-turbo
        API_TIMEOUT_MS: "3000000"
      prompt: |
        # QDS PIV Loop — Finalize

        Scripted finalization — no judgment required. Execute each step in order.

        **Story**: $ARGUMENTS

        ---

        ## Step 1: Derive story ID and read context
        ```bash
        STORY_ARG="$ARGUMENTS"
        if [ -f "$STORY_ARG" ]; then
          STORY_ID=$(basename "$STORY_ARG" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
        else
          STORY_ID="story-$(echo "$STORY_ARG" | md5sum | cut -c1-8)"
        fi
        cat ".claude/qds/runs/${STORY_ID}/plan.md"
        cat ".claude/qds/runs/${STORY_ID}/progress.txt" 2>/dev/null || true
        ```

        ## Step 2: Push branch and create draft PR
        ```bash
        git push -u origin HEAD 2>&1
        BRANCH=$(git branch --show-current)
        PR_URL=$(gh pr view HEAD --json url -q .url 2>/dev/null || echo "")
        if [ -z "$PR_URL" ]; then
          STORY_TITLE=$(head -1 "$STORY_ARG" 2>/dev/null | sed 's/^#\+ //' || echo "$STORY_ID")
          gh pr create --draft --base main \
            --title "qds/${STORY_ID}: ${STORY_TITLE}" \
            --body "$(cat <<'EOF'
        ## Story
        $STORY_ARG

        ## Changes
        $(git diff $(git merge-base HEAD main)..HEAD --stat)

        ## Review completed
        - Adversarial review ✓
        - QA swarm ✓
        - Code review × 2 ✓
        - Fix waves × 2 ✓

        🤖 Generated with QDS Factory on Archon
        EOF
        )"
          PR_URL=$(gh pr view HEAD --json url -q .url)
        fi
        echo "PR_URL=${PR_URL}"
        ```

        ## Step 3: Refresh GitNexus graph
        ```bash
        gitnexus analyze && date +%s > .claude/qds/.gitnexus-last-analyze
        ```

        ## Step 4: Store run summary to claude-mem
        Use the memory tool to store:
        ```
        tag: qds-story-completed
        story_id: {STORY_ID}
        files_changed: {git diff stat summary}
        pr_url: {PR_URL}
        key_decisions: {from plan.md Architecture Decisions section}
        date: 2026-05-10
        ```

        ## Step 5: Update wiki changelog
        ```bash
        mkdir -p .claude/wiki/changelog
        CHANGED=$(git diff $(git merge-base HEAD main)..HEAD --name-only)
        cat >> ".claude/wiki/changelog/$(date +%Y-%m-%d).md" <<EOF

        ## ${STORY_ID} — $(date +%H:%M)
        PR: ${PR_URL}
        Files: $(echo "$CHANGED" | tr '\n' ', ')
        EOF
        git add .claude/wiki/changelog/ && git commit -m "wiki: changelog entry for ${STORY_ID}" 2>/dev/null || true
        ```

        ## Step 6: Run bmad-retrospective for process learning
        Invoke the `bmad-retrospective` skill. Focus on:
        - How many fix-wave iterations were needed?
        - Did the plan underestimate complexity anywhere?
        - What worked well that should be reinforced?
        Store the retrospective summary to claude-mem with tag `qds-process`.

        ## Step 7: Update status and output completion summary
        ```bash
        echo "MERGED" > ".claude/qds/runs/${STORY_ID}/status"
        ```

        Output:
        ```
        ═══════════════════════════════════════════════
        QDS PIV LOOP — COMPLETE
        ═══════════════════════════════════════════════
        Story:  {STORY_ID}
        Branch: {BRANCH}
        PR:     {PR_URL}
        ───────────────────────────────────────────────
        {git log --oneline summary}
        ───────────────────────────────────────────────
        {git diff --stat summary}
        ═══════════════════════════════════════════════
        ```
  ```

- [ ] **Step 9.2: Verify complete YAML parses correctly**

  Run: `python3 -c "import yaml; data=yaml.safe_load(open('/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml').read()); print(f'OK — {len(data[\"nodes\"])} nodes parsed'); [print(f'  node {i+1}: {n[\"id\"]}') for i,n in enumerate(data['nodes'])]"`

  Expected:
  ```
  OK — 14 nodes parsed
    node 1: gitnexus-check
    node 2: explore
    node 3: create-plan
    node 4: refine-plan
    node 5: implement-setup
    node 6: implement
    node 7: fix-feedback
    node 8: adversarial-review
    node 9: qa-swarm
    node 10: bmad-code-review-1
    node 11: fix-wave-1
    node 12: bmad-code-review-2
    node 13: fix-wave-2
    node 14: finalize
  ```

- [ ] **Step 9.3: Commit**

  ```bash
  cd /Users/steve/archon
  git add .archon/workflows/defaults/qds-piv-loop.yaml
  git commit -m "feat(workflows): complete qds-piv-loop — all 14 nodes

  Full adversarial pipeline: explore → plan → implement → fix-feedback →
  adversarial-review → qa-swarm → code-review × 2 → fix-wave × 2 → finalize.
  Planning nodes on Anthropic Opus; all review/implement nodes on Z.ai GLM 5.1.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 10: Validate qds-piv-loop.yaml via Archon loader

**Files:**
- Read: `/Users/steve/archon/.archon/workflows/defaults/qds-piv-loop.yaml`

- [ ] **Step 10.1: Write a one-shot Archon loader validation script**

  ```bash
  cat > /tmp/validate-qds-workflow.ts << 'EOF'
  import { discoverWorkflows } from '/Users/steve/archon/packages/workflows/src/loader';

  const result = await discoverWorkflows('/Users/steve/archon', { loadDefaults: true });
  const qds = result.workflows.find(w => w.name === 'qds-piv-loop');
  if (!qds) {
    console.error('ERROR: qds-piv-loop not found in discovered workflows');
    console.error('Errors:', result.errors);
    process.exit(1);
  }
  console.log(`OK: qds-piv-loop discovered with ${qds.nodes.length} nodes`);
  qds.nodes.forEach((n, i) => console.log(`  ${i + 1}. ${n.id}`));
  EOF
  cd /Users/steve/archon && bun run /tmp/validate-qds-workflow.ts
  ```

  Expected: 14 nodes listed, no errors.

  If errors appear: read the error message, fix the YAML (likely indentation or missing field), re-run.

- [ ] **Step 10.2: Verify env fields are parsed on Z.ai nodes**

  ```bash
  cat > /tmp/check-env-fields.ts << 'EOF'
  import { discoverWorkflows } from '/Users/steve/archon/packages/workflows/src/loader';

  const result = await discoverWorkflows('/Users/steve/archon', { loadDefaults: true });
  const qds = result.workflows.find(w => w.name === 'qds-piv-loop');
  if (!qds) { console.error('Not found'); process.exit(1); }

  const nodesWithEnv = qds.nodes.filter(n => (n as any).env);
  console.log(`Nodes with env override: ${nodesWithEnv.length}`);
  nodesWithEnv.forEach(n => {
    console.log(`  ${n.id}: ANTHROPIC_BASE_URL=${(n as any).env?.ANTHROPIC_BASE_URL ?? 'unset'}`);
  });

  const planningNodes = ['explore', 'create-plan', 'refine-plan'];
  planningNodes.forEach(id => {
    const node = qds.nodes.find(n => n.id === id);
    if ((node as any)?.env) {
      console.error(`ERROR: ${id} has env override — should hit Anthropic directly`);
      process.exit(1);
    }
    console.log(`OK: ${id} has no env override (will hit Anthropic)`);
  });
  EOF
  cd /Users/steve/archon && bun run /tmp/check-env-fields.ts
  ```

  Expected: 11 nodes with env (implement through finalize except the 3 planning nodes). 3 planning nodes confirmed without env.

---

## Task 11: Create /qds skill — SKILL.md and input dispatch

**Files:**
- Create: `~/.claude/skills/qds/SKILL.md`

- [ ] **Step 11.1: Create the skill directory and SKILL.md**

  ```bash
  mkdir -p ~/.claude/skills/qds
  ```

  Create `~/.claude/skills/qds/SKILL.md`:

  ```markdown
  ---
  name: qds
  description: |
    QDS Factory — accepts a story or epic and runs the full adversarial production pipeline.
    Produces a draft PR with adversarial review, QA swarm, and dual code-review waves applied.

    Usage:
      /qds "add rate limiting"       → free text, treated as a single story
      /qds story.md                  → single story file → Tier 2 directly
      /qds epic.md                   → epic file → full orchestration with wave planning
      /qds                           → prompts for input interactively

    Triggers: "qds", "run qds", "factory run", "/qds"
  ---

  # QDS Factory — Entry Point

  ## BEFORE ANYTHING ELSE: Initialize project state

  Check if .claude/qds/ exists in the current working directory:
  ```bash
  ls .claude/qds/ 2>/dev/null || echo "NEEDS_INIT"
  ```

  If output is `NEEDS_INIT`: Read fully and follow `./init.md` before continuing.

  ## Determine input type

  Parse $ARGUMENTS (or prompt if empty):

  1. **Empty input** (`/qds` with no args):
     Ask: "Provide a story description (free text), or path to a story.md or epic.md file."
     Wait for input. Use that as the argument.

  2. **File path ending in `.md`**:
     ```bash
     cat "$ARGUMENTS"
     ```
     Check the file for markers:
     - Contains `## Stories` or `## Epics` header → **Epic path**
     - Contains `## Story` or single story format → **Single story path**
     - Cannot determine → Ask the user: "Is this an epic (multiple stories) or a single story?"

  3. **Free text** (no `.md` extension):
     Assume **Single story path** unless text contains multiple story markers.

  ## Dispatch

  **Single story** → Read fully and follow `./single-story.md`

  **Epic** → Read fully and follow `./orchestrator.md`
  ```

- [ ] **Step 11.2: Verify skill appears in Claude Code skill list**

  Run: `ls ~/.claude/skills/qds/`

  Expected: `SKILL.md`

  Note: Claude Code discovers new skills on next session start. No restart needed during current session — skill is usable via `Skill` tool immediately.

- [ ] **Step 11.3: Commit (in QDS-Factory repo as documentation)**

  ```bash
  cd /Users/steve/QDS-Factory
  echo "qds skill created at ~/.claude/skills/qds/ — 2026-05-10" >> docs/skills-changelog.md
  git add docs/skills-changelog.md
  git commit -m "docs: log qds skill creation in skills-changelog

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 12: /qds skill — single-story.md

**Files:**
- Create: `~/.claude/skills/qds/single-story.md`

- [ ] **Step 12.1: Create single-story.md**

  Create `~/.claude/skills/qds/single-story.md`:

  ```markdown
  # QDS — Single Story Dispatch

  Dispatch a single story to the qds-piv-loop Archon workflow.

  ## Step 1: Prepare the story input

  **If input is a file path**:
  ```bash
  if [ -f "$STORY_INPUT" ]; then
    STORY_FILE="$STORY_INPUT"
    STORY_ID=$(basename "$STORY_INPUT" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  fi
  ```

  **If input is free text**: write it to a temp story file:
  ```bash
  STORY_ID="story-$(date +%s | tail -c6)"
  STORY_FILE=".claude/qds/runs/${STORY_ID}/story.md"
  mkdir -p ".claude/qds/runs/${STORY_ID}"
  cat > "$STORY_FILE" << 'STORY_EOF'
  # Story: {derived title from first sentence of text}

  ## Description
  {full free text as provided}
  STORY_EOF
  ```

  ## Step 2: Verify Archon is running

  ```bash
  ARCHON_URL="${ARCHON_URL:-http://localhost:3000}"
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${ARCHON_URL}/api/health" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" != "200" ]; then
    echo "ERROR: Archon is not running at ${ARCHON_URL}"
    echo "Start Archon first: cd /Users/steve/archon && bun run dev"
    exit 1
  fi
  echo "Archon OK at ${ARCHON_URL}"
  ```

  ## Step 3: Create an isolated git worktree

  ```bash
  BRANCH="qds/${STORY_ID}"
  git worktree add ".worktrees/${STORY_ID}" -b "${BRANCH}" 2>/dev/null || {
    # Branch already exists — resume
    git worktree add ".worktrees/${STORY_ID}" "${BRANCH}"
  }
  echo "Worktree: .worktrees/${STORY_ID} on branch ${BRANCH}"
  ```

  ## Step 4: POST the workflow run to Archon

  ```bash
  CONV_ID="qds-${STORY_ID}-$(date +%s)"
  STORY_CONTENT=$(cat "$STORY_FILE")

  RUN_RESPONSE=$(curl -s -X POST \
    "${ARCHON_URL}/api/workflows/qds-piv-loop/run" \
    -H "Content-Type: application/json" \
    -d "$(cat <<EOF
  {
    "conversationId": "${CONV_ID}",
    "message": "${STORY_FILE}"
  }
  EOF
  )")

  echo "Run response: $RUN_RESPONSE"

  # Extract run status
  STATUS=$(echo "$RUN_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))")
  echo "STATUS=${STATUS}"
  ```

  ## Step 5: Report and tail the run

  ```
  ═══════════════════════════════════════════════
  QDS — Story Dispatched
  ═══════════════════════════════════════════════
  Story:    {STORY_ID}
  Branch:   {BRANCH}
  Worktree: .worktrees/{STORY_ID}
  Archon:   {ARCHON_URL}

  Open the Archon dashboard to follow progress:
  {ARCHON_URL}/runs

  The workflow will:
  1. Explore your codebase and plan the implementation (HITL)
  2. Implement task-by-task with Context7 for current APIs
  3. Present the implementation for your review (HITL)
  4. Run adversarial review, QA swarm, and dual code-review waves
  5. Create a draft PR
  ═══════════════════════════════════════════════
  ```

  If the user wants to wait and monitor from CLI instead of the dashboard:
  ```bash
  # Poll status every 30s
  while true; do
    STATUS=$(cat ".claude/qds/runs/${STORY_ID}/status" 2>/dev/null || echo "UNKNOWN")
    echo "$(date +%H:%M:%S) Status: $STATUS"
    [ "$STATUS" = "MERGED" ] || [ "$STATUS" = "FAILED" ] && break
    sleep 30
  done
  ```
  ```

- [ ] **Step 12.2: Verify file exists**

  Run: `ls ~/.claude/skills/qds/`

  Expected: `SKILL.md  single-story.md`

---

## Task 13: /qds skill — orchestrator.md (DECOMPOSE pipeline)

**Files:**
- Create: `~/.claude/skills/qds/orchestrator.md`

- [ ] **Step 13.1: Create orchestrator.md**

  Create `~/.claude/skills/qds/orchestrator.md`:

  ```markdown
  # QDS — Epic Orchestrator

  Full epic orchestration: DECOMPOSE pipeline → wave plan → human gate → wave executor.

  ## Step 1: Parse epic input

  **If input is an epic.md file**:
  ```bash
  cat "$EPIC_INPUT"
  ```
  Extract stories from `## Stories` section. Each story = one entry. Capture:
  - Story ID (e.g., 1.1, 1.2, or slug)
  - Story title
  - Story description
  - Explicit deps: any `depends_on:` field or text like "requires story 1.1"

  **If input is free text** with multiple features:
  Invoke `bmad-create-epics-and-stories` skill to formalize the input into stories.
  Then continue with the structured output.

  **If multiple .md files**:
  Read each file. Each file = one story. Scan frontmatter for `depends_on:` declarations.

  ## Step 2: Build codebase intelligence per story (GitNexus)

  For each story (run in parallel, max 4 at a time):
  ```bash
  # For story with key words {keywords}:
  gitnexus route_map --query "{keywords}"
  gitnexus impact --paths "{entry points from route_map}"
  ```
  Record for each story: `files_touched[]`, `modules[]`, estimated blast radius.

  ## Step 3: Build dependency graph

  For each pair of stories (A, B):

  **EXPLICIT**: If A.deps contains B → `A depends_on B`

  **FILE OVERLAP**: If `A.blast_radius ∩ B.blast_radius ≠ ∅`:
  - Agent reasoning: "Does B's work need to exist before A can work?"
  - If yes → `A depends_on B`
  - If ordering doesn't matter → safe parallel

  **SEMANTIC**: Agent reasoning: "Does B extend a model/type that A creates?"
  - If yes → `B depends_on A`

  **Cycle check**:
  ```
  if cycle detected: HALT
  Print: "ERROR: Cycle detected: {story A} → {story B} → ... → {story A}"
  Print: "Fix the dependency declaration before continuing."
  EXIT — do not continue until human resolves
  ```

  ## Step 4: Compute wave plan (topological sort)

  ```
  Wave 1: stories with no dependencies (in-degree = 0)
  Wave N: stories whose all deps are in Waves 1..N-1

  Within-wave safety check:
    If story A and story B share a file AND are in the same wave:
      → Run them sequentially within the wave
      → Flag to human in gate output
  ```

  ## Step 5: Human gate — display plan and get approval

  Print:
  ```
  ═══════════════════════════════════════════════
  QDS EPIC PLAN — "{epic title}"
  Stories: {N} | Waves: {M} | Max parallel: {K}
  ═══════════════════════════════════════════════

  {For each wave:}
  Wave {N} ({parallel|sequential}):
    ● Story {id} — {title}
      Files: {key files from blast radius}
      {If sequential within wave:} ⚠ Sequential: shares {file} with {other story}

  {If any deps:}
    Reason: {story X} → because {story Y} creates {type/file} that {story X} imports

  {If any deferred stories:}
  ⚠ Deferred: {story Z} — {reason}

  Approve plan, adjust deps, or ask me to re-examine a story?
  ═══════════════════════════════════════════════
  ```

  HALT. Wait for human approval.

  On approval: write plan.json and continue to wave-executor.md.
  On rejection/adjustment: re-run dep graph with human's corrections.

  ## Step 6: Write plan.json

  ```bash
  EPIC_SLUG=$(echo "{epic title}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | head -c 40)
  mkdir -p ".claude/qds/epic-${EPIC_SLUG}"
  ```

  Write `.claude/qds/epic-{slug}/plan.json`:
  ```json
  {
    "epic_slug": "{slug}",
    "epic_title": "{title}",
    "created_at": "{ISO timestamp}",
    "stories": [
      {
        "id": "{story-id}",
        "title": "{title}",
        "file": "{path to story.md or null}",
        "deps": ["{dep-story-id}", ...],
        "wave": {N},
        "status": "ready",
        "worktree": null,
        "run_id": null,
        "branch": null,
        "pr_url": null
      }
    ]
  }
  ```

  ## Step 7: Dispatch to wave executor

  Read fully and follow `./wave-executor.md`
  ```

- [ ] **Step 13.2: Verify file exists**

  Run: `ls ~/.claude/skills/qds/`

  Expected: `SKILL.md  init.md (if created)  orchestrator.md  single-story.md`

---

## Task 14: /qds skill — wave-executor.md

**Files:**
- Create: `~/.claude/skills/qds/wave-executor.md`

- [ ] **Step 14.1: Create wave-executor.md**

  Create `~/.claude/skills/qds/wave-executor.md`:

  ```markdown
  # QDS — Wave Executor (Ralph Loop)

  Reads plan.json on every iteration. Launches ready stories. Polls in-progress stories.
  Crash-safe: restart /qds on same epic, it reads plan.json and resumes.

  ## Variables (set before entering loop)

  - `PLAN_FILE` — path to the plan.json file (e.g., `.claude/qds/epic-{slug}/plan.json`)
  - `ARCHON_URL` — Archon server URL (default: `http://localhost:7272` or `$ARCHON_URL`)

  ## Loop iteration (repeat until all stories are merged or failed)

  ### Step A: Read current state from disk

  ```bash
  cat "$PLAN_FILE"
  ```

  Parse the JSON. Identify:
  - `ready_stories`: `status == "ready"` AND all deps have `status == "merged"`
  - `in_progress_stories`: `status == "in_progress"`
  - `merged_count`: count of `status == "merged"`
  - `failed_stories`: `status == "failed"`
  - `total_stories`: total count

  ### Step B: Check completion

  If `merged_count + failed_count == total_stories`:
  - If any failed: print summary, list failed stories, ask human what to do
  - If all merged: print completion summary and EXIT the loop

  ### Step C: Launch ready stories

  For each story in `ready_stories`:

  1. Create worktree:
  ```bash
  STORY_BRANCH="qds/${STORY_ID}"
  git worktree add ".worktrees/${STORY_ID}" -b "${STORY_BRANCH}" 2>/dev/null || \
    git worktree add ".worktrees/${STORY_ID}" "${STORY_BRANCH}"
  ```

  2. POST to Archon:
  ```bash
  CONV_ID="qds-${STORY_ID}-$(date +%s)"
  STORY_ARG="${STORY_FILE:-$STORY_DESCRIPTION}"

  RUN_RESPONSE=$(curl -s -X POST \
    "${ARCHON_URL}/api/workflows/qds-piv-loop/run" \
    -H "Content-Type: application/json" \
    -d "{\"conversationId\": \"${CONV_ID}\", \"message\": \"${STORY_ARG}\"}")

  RUN_ID=$(echo "$RUN_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
  echo "Launched ${STORY_ID}: run_id=${RUN_ID}"
  ```

  3. Update plan.json — set story status to `in_progress`, record `worktree`, `branch`, `run_id`.

  ### Step D: Poll in-progress stories

  For each story in `in_progress_stories`:

  ```bash
  RUN_STATUS=$(curl -s "${ARCHON_URL}/api/workflows/runs/${RUN_ID}" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unknown")
  echo "${STORY_ID}: ${RUN_STATUS}"
  ```

  - If `completed` or `status file = MERGED`: update plan.json → `merged`; run gitnexus analyze:
    ```bash
    gitnexus analyze && date +%s > .claude/qds/.gitnexus-last-analyze
    ```
    This ensures the next wave sees the merged work in the graph.

  - If `failed`: update plan.json → `failed`. Human gate:
    ```
    ⚠ Story {STORY_ID} FAILED. Options:
    1. Retry — restart the workflow run for this story
    2. Skip — mark as skipped and unblock dependents (risky)
    3. Abort — stop the epic run
    ```
    HALT and wait for human decision.

  - If still running: no action — will check again next iteration.

  ### Step E: Print progress and sleep

  ```
  ─────────────────────────────────────────────
  Wave progress: {merged_count}/{total_stories} merged
    In progress: {list of in_progress story IDs}
    Waiting:     {list of ready story IDs not yet launched}
    Blocked:     {list of stories whose deps aren't merged yet}
  Next check in 30s.
  ─────────────────────────────────────────────
  ```

  Wait 30 seconds, then repeat from Step A.

  ## On loop completion

  ```
  ═══════════════════════════════════════════════
  QDS EPIC COMPLETE — "{epic_title}"
  Stories merged: {N}
  PRs: {list of PR URLs}
  ═══════════════════════════════════════════════
  ```

  Clean up worktrees:
  ```bash
  git worktree list | grep '.worktrees' | awk '{print $1}' | while read wt; do
    git worktree remove "$wt" --force 2>/dev/null || true
  done
  ```

  Store epic completion summary to claude-mem.
  ```

- [ ] **Step 14.2: Verify all skill files exist**

  Run: `ls -la ~/.claude/skills/qds/`

  Expected:
  ```
  SKILL.md
  orchestrator.md
  single-story.md
  wave-executor.md
  ```

---

## Task 15: /qds skill — init.md (first-run project scaffolding)

**Files:**
- Create: `~/.claude/skills/qds/init.md`

- [ ] **Step 15.1: Create init.md**

  Create `~/.claude/skills/qds/init.md`:

  ```markdown
  # QDS — Project Initialization

  First-run scaffolding. Creates .claude/wiki/ and .claude/qds/ in the current project.
  Run once per project before the first story.

  ## Step 1: Create directory structure

  ```bash
  mkdir -p .claude/qds/runs
  mkdir -p .claude/wiki/modules
  mkdir -p .claude/wiki/patterns
  mkdir -p .claude/wiki/decisions
  mkdir -p .claude/wiki/changelog
  touch .claude/qds/.gitnexus-last-analyze
  echo "0" > .claude/qds/.gitnexus-last-analyze
  ```

  ## Step 2: Create wiki index (module map)

  Read CLAUDE.md and the top-level directory structure:
  ```bash
  cat CLAUDE.md 2>/dev/null || true
  ls -1
  find src -maxdepth 2 -type d 2>/dev/null || true
  ```

  Write `.claude/wiki/index.md`:
  ```markdown
  # Codebase Wiki — {project name}

  Auto-generated by QDS Factory. Updated nightly.
  Last updated: {date}

  ## Module Map
  | Module | Path | Description |
  |--------|------|-------------|
  | {module} | {path} | {one-line description} |

  ## Key Patterns
  - [Error Handling](patterns/error-handling.md)
  - [Testing](patterns/testing.md)

  ## Decisions
  See decisions/ for architectural decision records.
  ```

  ## Step 3: Create starter pattern stubs

  Write `.claude/wiki/patterns/error-handling.md`:
  ```markdown
  # Error Handling Patterns

  QDS agents will populate this file from observed codebase patterns.
  Updated after each story merge.
  ```

  Write `.claude/wiki/patterns/testing.md`:
  ```markdown
  # Testing Patterns

  QDS agents will populate this file from observed codebase patterns.
  Updated after each story merge.
  ```

  ## Step 4: Initialize hotspots file

  ```bash
  touch .claude/qds/.hotspots
  # Will be populated after 5+ stories as files appearing in 70%+ of blast radii
  ```

  ## Step 5: Commit scaffold

  ```bash
  git add .claude/wiki/ .claude/qds/.gitnexus-last-analyze .claude/qds/.hotspots
  git commit -m "chore(qds): initialize QDS Factory scaffold

  Creates .claude/wiki/ (codebase knowledge base) and .claude/qds/ (state directory).
  These will be populated by QDS agents as stories are processed.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

  ## Step 6: Confirm

  ```
  ════════════════════════════════════
  QDS Factory initialized for {project}
  ════════════════════════════════════
  Created:
    .claude/qds/       — story state, run tracking
    .claude/wiki/      — codebase knowledge base

  You're ready. Run /qds to process your first story.
  ════════════════════════════════════
  ```
  ```

- [ ] **Step 15.2: Verify full skill directory**

  Run: `ls -la ~/.claude/skills/qds/`

  Expected: `SKILL.md  init.md  orchestrator.md  single-story.md  wave-executor.md`

---

## Task 16: Nightly wiki agent skill

**Files:**
- Create: `~/.claude/skills/qds-wiki-nightly/SKILL.md`

- [ ] **Step 16.1: Create the nightly wiki skill**

  ```bash
  mkdir -p ~/.claude/skills/qds-wiki-nightly
  ```

  Create `~/.claude/skills/qds-wiki-nightly/SKILL.md`:

  ```markdown
  ---
  name: qds-wiki-nightly
  description: |
    QDS Factory — nightly codebase wiki consolidation agent.
    Runs as a scheduled background job. Updates module pages, pattern docs, and decision log
    to reflect the last 24 hours of changes. No HITL — commits and exits.

    Trigger: scheduled (via 'schedule' skill), or manually: /qds-wiki-nightly
  ---

  # QDS Wiki — Nightly Consolidation

  No human input required. Execute all steps and commit.

  ## Step 1: Gather what changed in the last 24 hours

  ```bash
  git log --since="24 hours ago" --oneline --no-merges
  git diff HEAD~$(git log --since="24 hours ago" --oneline | wc -l | tr -d ' ') --name-only 2>/dev/null || \
    git diff $(git log --since="24 hours ago" --format="%H" | tail -1)..HEAD --name-only
  ```

  ## Step 2: Pull recent observations from claude-mem

  Use memory tool: search for observations from the last 24h (tags: `qds-story-completed`, `qds-process`).
  Collect: story IDs completed, key decisions made, files changed.

  ## Step 3: Refresh GitNexus graph

  ```bash
  gitnexus analyze
  ```

  ## Step 4: Update affected module pages

  For each module whose files appear in the changed file list:
  - Read `.claude/wiki/modules/{module}.md` (or create if missing)
  - Read the changed files in that module
  - Rewrite the module page to reflect current state:
    - What the module does (based on current code)
    - Key patterns and conventions observed
    - Known gotchas (from QA swarm findings stored in claude-mem)
    - Recent changes (from git log + story summaries)

  ## Step 5: Update pattern pages

  For each pattern file in `.claude/wiki/patterns/`:
  - Check if any changed files introduce new patterns or violate existing ones
  - Update the pattern doc if needed

  ## Step 6: Update hotspots file

  Count file frequency across blast radii from the last 10 story runs (from claude-mem).
  Files in 70%+ of stories → hotspot.

  ```bash
  # Overwrite .claude/qds/.hotspots with current hotspot list
  echo "{hotspot file 1}
  {hotspot file 2}" > .claude/qds/.hotspots
  ```

  ## Step 7: Commit

  ```bash
  git add .claude/wiki/ .claude/qds/.hotspots
  git diff --cached --stat
  git commit -m "wiki: nightly consolidation $(date +%Y-%m-%d)

  Updated modules: {list}
  Hotspots updated: {count} files
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

  ## Step 8: Output

  ```
  Wiki consolidation complete: $(date +%Y-%m-%d)
  Modules updated: {list}
  Hotspots: {count}
  Commit: $(git log --oneline -1)
  ```
  ```

- [ ] **Step 16.2: Schedule the nightly wiki agent**

  Use the `schedule` skill to set up the nightly run:

  Invoke: `Skill("schedule")` with prompt:
  ```
  Schedule qds-wiki-nightly to run every day at 2am.
  The skill to run: qds-wiki-nightly
  Working directory: {path to target project}
  ```

  The schedule skill will configure the cron job via Claude Code's scheduling system.

- [ ] **Step 16.3: Verify**

  Run: `ls ~/.claude/skills/qds-wiki-nightly/`

  Expected: `SKILL.md`

---

## Task 17: Environment configuration

**Files:**
- Modify: `/Users/steve/archon/.env.example` (create if missing)

- [ ] **Step 17.1: Check if .env.example exists**

  Run: `ls /Users/steve/archon/.env.example 2>/dev/null || echo "NOT_FOUND"`

- [ ] **Step 17.2: Add QDS environment variables**

  In `/Users/steve/archon/.env.example`, add (or create the file with):

  ```bash
  # ─────────────────────────────────────────────────────────────
  # QDS Factory — Z.ai integration
  # Get API key from https://platform.z.ai
  # ─────────────────────────────────────────────────────────────
  ZAI_API_KEY=your-zai-api-key-here

  # Archon server URL for /qds skill to call (default shown)
  ARCHON_URL=http://localhost:7272
  ```

- [ ] **Step 17.3: Add ZAI_API_KEY to Archon's actual .env**

  **Do NOT commit the actual key.**

  Copy `.env.example` to `.env` if not already present:
  ```bash
  [ -f /Users/steve/archon/.env ] || cp /Users/steve/archon/.env.example /Users/steve/archon/.env
  ```

  Then manually set the real key:
  ```bash
  # Edit /Users/steve/archon/.env and replace:
  #   ZAI_API_KEY=your-zai-api-key-here
  # with the actual Z.ai API key from https://platform.z.ai
  ```

  Verify it's in .gitignore:
  ```bash
  grep "\.env$" /Users/steve/archon/.gitignore || echo ".env" >> /Users/steve/archon/.gitignore
  ```

- [ ] **Step 17.4: Commit .env.example**

  ```bash
  cd /Users/steve/archon
  git add .env.example .gitignore
  git commit -m "chore: add ZAI_API_KEY and ARCHON_URL to .env.example

  Required for QDS Factory Z.ai model routing. ZAI_API_KEY never committed.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 18: End-to-end smoke test — single story

This is a manual validation task. It cannot be fully automated — it requires Archon to be running and a real story to process. Document the validation steps precisely.

- [ ] **Step 18.1: Start Archon**

  ```bash
  cd /Users/steve/archon && bun run dev
  ```

  Wait for: `Archon ready at http://localhost:7272` (or check configured port).

- [ ] **Step 18.2: Verify qds-piv-loop appears in Archon UI**

  Open `http://localhost:7272` in browser. Navigate to Workflows.
  Confirm `qds-piv-loop` appears in the workflow list.

  If not: check `/Users/steve/archon/.archon/workflows/defaults/` contains the YAML.
  Run: `cd /Users/steve/archon && bun run /tmp/validate-qds-workflow.ts`

- [ ] **Step 18.3: Run /qds on a simple story in a test project**

  In a test repository (e.g., any local git repo with a CLAUDE.md):
  ```bash
  # Ensure ZAI_API_KEY is set in your shell for Archon to pick up
  echo $ZAI_API_KEY  # should show key, not empty

  # In a Claude Code session in the test project:
  # 1. Initialize QDS for the project
  # Invoke: Skill("qds")
  # It should detect missing .claude/qds/ and run init.md

  # 2. After init completes, run a simple story
  # Invoke: Skill("qds") with args: "add a hello world endpoint"
  ```

- [ ] **Step 18.4: Verify per-node env injection is working**

  While the workflow runs, check the Archon run logs for the `implement` node.
  The request should show model `glm-5.1` (not `claude-opus-4-7`).

  In Archon web UI → open the run → click `implement` node → check "Model" field.

  Expected: Z.ai endpoint is being called (base URL shows `api.z.ai`).

- [ ] **Step 18.5: Verify planning nodes hit Anthropic directly**

  Check `explore` and `create-plan` node logs.
  Expected: Anthropic endpoint called (no Z.ai override).

- [ ] **Step 18.6: Verify HITL gates work**

  The `explore` loop should pause at the gate message. The workflow should appear as
  "waiting for input" in the Archon UI. Provide a response to unblock it.

  The `fix-feedback` node should pause after implementation for human review.

- [ ] **Step 18.7: Verify finalize creates a draft PR**

  After the workflow completes: check GitHub for a draft PR on branch `qds/{story-id}`.
  ```bash
  gh pr list --draft --head "qds/"
  ```

  Expected: at least one PR created by the workflow run.

---

## Self-Review Checklist

Running spec coverage check against the approved design:

**Section 1 (Architecture):**
- [x] Two-tier: /qds skill (Tier 1) + qds-piv-loop.yaml (Tier 2) — Tasks 6-9, 11-15
- [x] Single story → Tier 2 directly — Task 12 (single-story.md)
- [x] Epic → DECOMPOSE → wave executor — Tasks 13-14
- [x] Crash-safe plan.json — Task 13 (plan.json write) + Task 14 (reads plan.json fresh each iteration)
- [x] Archon web UI streaming — inherited from Archon; no new code needed

**Section 2 (Integration Points):**
- [x] GitNexus at orchestrator start — Task 6 (gitnexus-check node)
- [x] GitNexus route_map + impact in DECOMPOSE — Task 13 (orchestrator.md Step 2)
- [x] GitNexus query in explore — Task 6 (explore node prompt)
- [x] Context7 in implement — Task 7 (implement node prompt)
- [x] Claude-mem auto-injection throughout — inherent in headless CC; explicit stores in create-plan, finalize
- [x] Superpowers skill invocations (adversarial, qa-swarm, retrospective) — Tasks 8, 9

**Section 3 (Epic Orchestrator):**
- [x] Input handling (free text, story.md, epic.md, interactive) — Task 11 (SKILL.md)
- [x] DECOMPOSE Step 1 (parse) — Task 13
- [x] DECOMPOSE Step 2 (gitnexus per story) — Task 13
- [x] DECOMPOSE Step 3 (dep graph) — Task 13
- [x] DECOMPOSE Step 4 (wave computation) — Task 13
- [x] DECOMPOSE Step 5 (human gate) — Task 13
- [x] Wave executor (ralph-loop) — Task 14

**Section 4 (QDS PIV Loop):**
- [x] All 14 nodes — Tasks 6-9
- [x] Per-node env injection (Z.ai routing) — Tasks 1-4 (Archon core), Tasks 6-9 (YAML env blocks)
- [x] Model allocation: Anthropic for planning, Z.ai for everything else — verified in Task 10

**Section 5 (Self-Learning):**
- [x] Process learning (bmad-retrospective in finalize) — Task 9 (finalize node)
- [x] Pattern library storage (adversarial-review, qa-swarm finding storage) — Tasks 8, 9
- [x] Codebase wiki structure — Task 15 (init.md scaffold)
- [x] Wiki per-story update (finalize) — Task 9 (finalize Step 5 and 6)
- [x] Nightly wiki consolidation — Task 16
- [x] Hotspot detection — Task 16 (Step 6) + Task 15 (init creates .hotspots file)
- [x] Dep graph calibration tracking — NOT yet implemented → **Gap found**

**Gap: Dep graph calibration (Section 5, Layer 1c)**
The spec says: "track every dep prediction that was wrong — missed dep caused merge conflict, or over-constrained deps that serialized work unnecessarily." This storage is missing from the wave executor. Adding:

In Task 14 wave-executor.md Step D, add after detecting merge conflict:
```
If git merge conflict detected when merging story branch:
  Store to claude-mem: { tag: "dep-graph-learnings", story_pair: [A, B], predicted: "parallel", actual: "conflict", reason: "shared file detected at merge: {file}" }
```

This is a minor addition to wave-executor.md. Since it's a learning capture (not core functionality), add a note at the end of Task 14 to include this.

**Spec check complete. One gap fixed inline above.**

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-05-10-qds-on-archon.md`.

**Recommended approach: Subagent-Driven** — I dispatch a fresh subagent per task, review between tasks. Invoke `superpowers:subagent-driven-development`.

**Alternative: Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`.

Which approach?
