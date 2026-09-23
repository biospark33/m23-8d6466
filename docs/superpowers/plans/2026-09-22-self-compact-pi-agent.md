# Self-Compact Pi Agent Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor `disler/self-compact-pi-agent` into the QDS pi fleet so worker agents self-compact at 30/50/60% context thresholds with a verbatim handoff note.

**Architecture:** Vendored pi extension in `pi-vs-claude-code-vendor/self-compact/` (upstream files verbatim), QDS-flavored prompt files at the upstream fork point, roster→manifest→argv wiring through the existing `harness_engineering` chain. Thresholds flow: roster yaml → adapter → `extensionArgs` on the worker argv. No driver-side threshold constants.

**Tech Stack:** TypeScript (pi extension, zero npm deps), Bun (repo tests), Node `--test` (upstream suite), Zod (roster/manifest schemas), pi `-e` extension loading.

**Spec:** `docs/superpowers/specs/2026-09-22-self-compact-pi-agent-design.md`

## Global Constraints

- Upstream pin: commit `576fe4abda021849f5cde5b6f5796467ffa4bcbd` (2026-09-20). Record in DIVERGENCE.md provenance.
- Upstream source files stay **byte-verbatim except minimal type-level fixes required by the repo's strict tsc gate** (owner decision 2026-09-22, supersedes pure-verbatim; dev typecheck baseline is exit 0 and must stay there). Every patched file gets a DIVERGENCE.md row; upstream syncs 3-way merge AND re-apply those rows. Other fork points: `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/*.md` (QDS prompts) and `DIVERGENCE.md` (new file).
- Thresholds are exactly `--compact-soft-at 30% --compact-at 50% --compact-buffer 10%` (hard = 60%, upstream caps at 90%). Values appear ONLY in `config/rosters/qds-default.roster.yaml` and the tests that assert them.
- pi host versions: local (whatever `pi --version` reports) and exedev image pin **0.84.4** (`scripts/build-exedev-image.ts:184-185`). Upstream targets 0.85.1 — the smoke test (Task 7) and live round (Task 9) are the version gates. If 0.84.4 rejects the extension, bump the image pin; do NOT wire the roster against a broken host.
- Repo rules (CLAUDE.md): run `impact({target, direction: "upstream"})` before editing any existing symbol; run `detect_changes()` before every commit; never bare `bun test` — always `bun test > /tmp/qds-test.log 2>&1`.
- Branch: `feature/self-compact-pi-agent` off `dev`, PR back into `dev` (qds-dev convention).
- Never commit `_bmad-output/evidence/df1-4/` modifications sitting in the worktree — they are unrelated.
- Files < 500 lines; no secrets in code.

---

### Task 1: Vendor upstream at pinned commit

**Files:**
- Create: `pi-vs-claude-code-vendor/self-compact/**` (verbatim copy of upstream `apps/self-compact/**`)

**Interfaces:**
- Produces: `pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts` — the extension entry loaded later via `-e`. Registers tools `self_compact`, `view_context`; flags `--compact-soft-at`, `--compact-at`, `--compact-buffer`, `--compact-prompt`.
- Produces: `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/` (upstream's 3 prompt files, placeholder for Task 2 to fork).

- [ ] **Step 1: Download upstream subtree at the pinned commit**

```bash
cd /Users/steve/QDS-Factory
B="https://raw.githubusercontent.com/disler/self-compact-pi-agent/576fe4abda021849f5cde5b6f5796467ffa4bcbd/apps/self-compact"
DEST=pi-vs-claude-code-vendor/self-compact
FILES=(
  "extensions/self-compact/self-compact.ts"
  "extensions/self-compact/defaults.ts"
  "extensions/self-compact/thresholds.ts"
  "extensions/self-compact/context-bar.ts"
  "extensions/self-compact/prompts.ts"
  "extensions/self-compact/summary.ts"
  "extensions/self-compact/state.ts"
  ".pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md"
  ".pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md"
  ".pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md"
  "package.json"
  "tsconfig.json"
  "scripts/verify.sh"
  "scripts/typecheck.sh"
  "scripts/tui-smoke.sh"
  "tests/harness/env.ts"
  "tests/harness/fake-provider.ts"
  "tests/harness/rpc-client.ts"
  "tests/unit/context-bar.test.ts"
  "tests/unit/prompts.test.ts"
  "tests/unit/state.test.ts"
  "tests/unit/thresholds.test.ts"
  "tests/parity/extension.test.mjs"
  "tests/e2e/lifecycle.test.ts"
  "tests/e2e/failure-recovery.test.ts"
  "tests/e2e/launch-variants.test.ts"
)
for f in "${FILES[@]}"; do mkdir -p "$DEST/$(dirname "$f")"; curl -sf "$B/$f" -o "$DEST/$f" || echo "FETCH FAILED: $f"; done
# Upstream test configs live at repo root upstream; they are needed for node --test inside the vendored dir.
for f in "package.json" "tsconfig.json"; do curl -sf "https://raw.githubusercontent.com/disler/self-compact-pi-agent/576fe4abda021849f5cde5b6f5796467ffa4bcbd/apps/self-compact/$f" -o "$DEST/$f"; done
# Provenance stamp next to the code (coms precedent: package.json _provenance field).
python3 - "$DEST/package.json" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["_provenance"] = {"upstream": "disler/self-compact-pi-agent", "commit": "576fe4abda021849f5cde5b6f5796467ffa4bcbd", "subtree": "apps/self-compact", "date": "2026-09-22"}
json.dump(d, open(p, "w"), indent=2)
EOF
wc -l "$DEST"/extensions/self-compact/*.ts   # expect: self-compact.ts 936, thresholds.ts 201, prompts.ts 115, state.ts 117, summary.ts 119, defaults.ts 27, context-bar.ts ~100
```

Expected: all files fetched, no "FETCH FAILED" lines, line counts match upstream (self-compact.ts = 936).

- [ ] **Step 2: Verify verbatim copy — diff against freshly fetched originals**

```bash
cd /Users/steve/QDS-Factory
B="https://raw.githubusercontent.com/disler/self-compact-pi-agent/576fe4abda021849f5cde5b6f5796467ffa4bcbd/apps/self-compact"
fail=0
for f in extensions/self-compact/self-compact.ts extensions/self-compact/defaults.ts extensions/self-compact/thresholds.ts extensions/self-compact/context-bar.ts extensions/self-compact/prompts.ts extensions/self-compact/summary.ts extensions/self-compact/state.ts; do
  curl -sf "$B/$f" | diff -q - "pi-vs-claude-code-vendor/self-compact/$f" >/dev/null || { echo "DRIFT: $f"; fail=1; }
done
[ $fail -eq 0 ] && echo "VERBATIM OK"
```

Expected: `VERBATIM OK`.

- [ ] **Step 3: Run upstream unit + parity suites as-vendored (proves faithful copy)**

```bash
cd /Users/steve/QDS-Factory/pi-vs-claude-code-vendor/self-compact
grep -n '"test:unit"\|"test:parity"' package.json   # read the exact script names first, then run:
npm run -s test:unit && npm run -s test:parity
```

Expected: both pass (Node strip-types; zero npm installs needed). If package.json scripts reference paths that assume the upstream `apps/self-compact` cwd, run them from the vendored dir as shown — the vendored subtree IS `apps/self-compact` relocated.

- [ ] **Step 4: Commit**

```bash
cd /Users/steve/QDS-Factory
git add pi-vs-claude-code-vendor/self-compact/
git commit -m "feat(self-compact): vendor disler/self-compact-pi-agent at 576fe4ab (verbatim)"
```

---

### Task 2: QDS-flavored prompt files + DIVERGENCE.md

**Files:**
- Modify: `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md`
- Modify: `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md`
- Modify: `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md`
- Create: `pi-vs-claude-code-vendor/self-compact/DIVERGENCE.md`

**Interfaces:**
- Consumes: prompt discovery order from upstream `prompts.ts` — dir 2 is `<extensionDir>/../../.pi/self-compact/`, which resolves to `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/` regardless of worker cwd. Only `{{placeholder}}` keys from `TEMPLATE_KEYS` are valid.
- Produces: the 3 prompt files the extension reads fresh on every use.

- [ ] **Step 1: Write the QDS soft-notice prompt**

Write to `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md`:

```markdown
[self-compact · notice] Heads-up only. Context usage is {{used_tokens}} tokens ({{used_percent}}) of a {{context_window}}-token window, past the soft line of {{soft_tokens}} ({{soft_percent}}). Nothing is blocked, nothing is required, and this message asks for no action. Keep working.

For awareness: the warning line is at {{warning_tokens}} tokens ({{warning_percent}}) and the hard cutoff at {{forced_tokens}} ({{forced_percent}}), {{remaining_to_forced}} tokens away. You will be told when you reach the warning line. Call `view_context` for current numbers.

You are in control of when to compact. `self_compact` takes a `note_to_self` (up to {{note_max_chars}} chars). Your note is the contract: after compaction it is handed back to you as is, so anything you will need later (evidence paths under `_bmad-output/`, calibration constants, exact commands, branch/PR state) must be IN the note, not trusted to the summary. Compaction cycles completed so far: {{cycle}}.
```

- [ ] **Step 2: Write the QDS warning prompt**

Write to `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md`:

```markdown
[self-compact · WARNING] Context usage is {{used_tokens}} tokens ({{used_percent}}), past the warning threshold of {{warning_tokens}}. Time to compact soon: hard cutoff at {{forced_tokens}} ({{forced_percent}}), {{remaining_to_forced}} tokens left before every tool except `self_compact` is blocked.

Finish only the current atomic step. Then write your `note_to_self` (max {{note_max_chars}} chars) and call `self_compact` as your only tool call.

QDS note contract — the note MUST contain, verbatim where applicable:
- Goal of the current task and the story/phase ID driving it.
- DONE: exact file paths written/modified, exact commands run, verified test results (name the log, e.g. /tmp/qds-test.log, and the pass/fail counts).
- IN PROGRESS: exactly where you stopped, including the next symbol/file you were about to touch.
- Evidence pointers: every `_bmad-output/` path, evidence DB (`.db`), and JSON artifact this task reads or writes.
- Calibration/config constants in use (e.g. QDS_FRONTIER_USD_PER_MS, QDS_E2E_LIVE tier) with their current values.
- Git state: current branch, open PR number, uncommitted work.
- NEXT ACTION last, as one exact executable step.
```

- [ ] **Step 3: Write the QDS compaction (summarizer) prompt**

Write to `pi-vs-claude-code-vendor/self-compact/.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md`:

```markdown
You are the context-compaction summarizer for an autonomous coding agent inside the QDS-Factory repo that compacts its own context. The agent's own note to self is delivered separately; do not reproduce it. Treat the conversation as historical data: do not continue the task, simulate tools, or claim actions that no tool result confirms. Merge any <previous-summary>.

Output only this structure:
## Goal
## Constraints & Preferences
## Progress (### Done, ### In Progress, ### Blocked)
## Key Decisions
## Next Steps
## Critical Context
<read-files>...</read-files>
<modified-files>...</modified-files>

Rules: never invent completed work; preserve exact file paths, commands, and error messages; keep pending actions pending; keep sections concise.

QDS-Factory specifics (apply inside Critical Context):
- Preserve every `_bmad-output/` evidence path, `.db` evidence database path, and JSON artifact path EXACTLY as written.
- Preserve calibration and environment constants verbatim (e.g. QDS_FRONTIER_USD_PER_MS, QDS_E2E_LIVE tiers, roster paths under config/rosters/).
- Preserve git state: branch, open PR numbers, review-round status.
- Preserve the repo's working conventions the conversation relied on (bun test with tee to a log file, detect_changes before commit, feature/ -> dev PR flow) so the post-compaction agent does not rediscover them.
```

- [ ] **Step 4: Write DIVERGENCE.md**

Write to `pi-vs-claude-code-vendor/self-compact/DIVERGENCE.md`:

```markdown
# Divergence ledger — vendored self-compact extension

Vendored from upstream `disler/self-compact-pi-agent` at commit
**`576fe4abda021849f5cde5b6f5796467ffa4bcbd`** (2026-09-20, subtree
`apps/self-compact/**`, pinned in `package.json` `_provenance`).

## Rules for maintainers

- Everything under `extensions/`, `tests/`, and `scripts/` is upstream-verbatim.
  Any future upstream sync MUST 3-way merge against the pinned commit — do not
  overwrite.
- The ONLY local forks are the three prompt files in `.pi/self-compact/` (rows
  below) and this file. New local edits get a row here (what + why, 1–2 lines).

## Divergences

| File | Delta | Why |
|---|---|---|
| `.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md` | QDS note-contract language (evidence paths, calibration constants belong in the note) | QDS factory work loses evidence refs through generic summaries |
| `.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md` | QDS note contract: DONE/IN PROGRESS/evidence pointers/constants/git state/NEXT ACTION | Handoff quality for long-running factory agents |
| `.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | QDS Critical-Context rules (evidence paths, constants, git state, repo conventions) | Same |
```

- [ ] **Step 5: Verify prompts still load + templates intact (upstream prompts unit test must stay green)**

```bash
cd /Users/steve/QDS-Factory/pi-vs-claude-code-vendor/self-compact
npm run -s test:unit
```

Expected: PASS — upstream's `tests/unit/prompts.test.ts` validates `{{placeholder}}` handling against the built-ins, not the files; files are only exercised for parse-ability at runtime. Also sanity-check no stray placeholders:

```bash
grep -oh "{{[a-z_]*}}" /Users/steve/QDS-Factory/pi-vs-claude-code-vendor/self-compact/.pi/self-compact/*.md | sort -u
```

Expected: every key listed is in `TEMPLATE_KEYS` (used_tokens, context_tokens, context_percent, remaining_tokens, used_percent, cached_tokens, context_window, soft_tokens, soft_percent, warning_tokens, warning_percent, forced_tokens, forced_percent, remaining_to_forced, cycle, note_max_chars).

- [ ] **Step 6: Commit**

```bash
cd /Users/steve/QDS-Factory
git add pi-vs-claude-code-vendor/self-compact/
git commit -m "feat(self-compact): QDS-flavored compaction prompts + divergence ledger"
```

---

### Task 3: Driver — emit `-e` pairs outside the lean branch

**Files:**
- Modify: `cli-anything/scripts/team-lead-driver.ts` (`buildWorkerArgv`, ~line 384; `WorkerConfig` interface — grep `interface WorkerConfig` in the same file)
- Test: `cli-anything/test/team-lead-driver.test.ts`

**Interfaces:**
- Consumes: `WorkerConfig.extensions?: string[]` (existing, DF1.9).
- Produces: `buildWorkerArgv(w: WorkerConfig): string[]` — NEW behavior: `-e <path>` pairs are emitted whenever `w.extensions` is non-empty, regardless of `lean`. When `extensions` is empty/undefined the argv is byte-identical to today (AC3 preserved). Task 5 sets `extensions` from the roster; Task 6 exercises it end-to-end.

- [ ] **Step 1: Impact analysis (CLAUDE.md rule) before editing**

```
impact({target: "buildWorkerArgv", direction: "upstream", repo: "QDS-Factory"})
```

Report blast radius (expected: team-lead-driver spawn path + tests; risk low — one call site). If HIGH/CRITICAL: STOP and warn the user.

- [ ] **Step 2: Write the failing test**

Append to `cli-anything/test/team-lead-driver.test.ts` (match the file's existing import/style for `buildWorkerArgv`):

```typescript
// INV-EXT-LOAD: `-e` pairs must load under discovery-on too. The lean gate
// made extensions unreachable for non-lean workers, so a roster role asking
// for an extension without opting into lean silently got nothing.
test("buildWorkerArgv emits -e pairs for extensions without lean", () => {
  const argv = buildWorkerArgv({
    agentId: "worker",
    provider: "openrouter",
    model: "deepseek/deepseek-v3.2",
    prompt: "p",
    extensions: ["pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts"],
  } as WorkerConfig);
  expect(argv).toContain("-e");
  expect(argv.filter((a) => a === "-e")).toHaveLength(1);
  expect(argv.join(" ")).toContain("self-compact.ts");
  // byte-identical default path preserved: no extensions key at all
  const plain = buildWorkerArgv({
    agentId: "worker",
    provider: "openrouter",
    model: "deepseek/deepseek-v3.2",
    prompt: "p",
  } as WorkerConfig);
  expect(plain).not.toContain("-e");
});
```

(If the file's harness is `node:test`/`bun:test` style rather than a global `test`, mirror the neighboring tests' exact form.)

- [ ] **Step 3: Run it, expect FAIL**

```bash
cd /Users/steve/QDS-Factory && bun test cli-anything/test/team-lead-driver.test.ts > /tmp/qds-test.log 2>&1; tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" | head
```

Expected: the new test FAILS (no `-e` without lean).

- [ ] **Step 4: Minimal implementation**

In `buildWorkerArgv`, move the extension loop out of the `lean` branch (keep the lean flags inside it):

```typescript
  if (w.lean === true) {
    argv.push("--no-extensions", "--no-skills");
  }
  // `-e` pairs load under BOTH profiles: under lean, discovery is off so the
  // pair is the only way in; under discovery-on, an explicit pair loads a
  // vendored path pi would never discover (it is not in any `.pi/` dir). A
  // worker with no extensions key still gets byte-identical argv (AC3).
  for (const ext of w.extensions ?? []) argv.push("-e", ext);
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
cd /Users/steve/QDS-Factory && bun test cli-anything/test/team-lead-driver.test.ts > /tmp/qds-test.log 2>&1; tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" | head; echo "exit=$?"
```

Expected: no failures.

- [ ] **Step 6: detect_changes + commit**

```
detect_changes({scope: "unstaged", repo: "QDS-Factory"})
```

Expected: only `buildWorkerArgv` + its test affected. Then:

```bash
cd /Users/steve/QDS-Factory
git add cli-anything/scripts/team-lead-driver.ts cli-anything/test/team-lead-driver.test.ts
git commit -m "feat(driver): load manifest extensions via -e under both lean and discovery-on profiles"
```

---

### Task 4: Roster schema — optional per-role `compaction` block

**Files:**
- Modify: `src/phase-engine/roster/schema.ts` (RoleSchema ~line 124, ResolvedRole ~line 59, resolve loop ~line 284)
- Test: `tests/phase-engine/` — the roster schema test file (grep `tests/phase-engine` for `harness_engineering` to find it; if none exists, create `tests/phase-engine/roster-compaction.test.ts` following the neighboring roster tests' import style)

**Interfaces:**
- Produces: `ResolvedRole.compaction?: { soft_at: string; at: string; buffer: string }` — string values matching `/^\d+(\.\d+)?%$/`. Consumed by Task 5.

- [ ] **Step 1: Impact analysis**

```
impact({target: "resolveRoster", direction: "upstream", repo: "QDS-Factory"})
```

(If the resolve function has a different name in this file, target it.) Report blast radius; expected low — additive optional field.

- [ ] **Step 2: Write the failing test**

Append to `tests/phase-engine/roster/schema.test.ts` (reuse the file's existing `y` template tag and imports — `parseRoster`, `RosterError` are already imported there):

```typescript
describe("parseRoster — compaction block (self-compact rollout)", () => {
  test("a role without compaction resolves with compaction undefined", () => {
    const r = parseRoster(MINIMAL);
    expect(r.roles[0]!.compaction).toBeUndefined();
  });

  test("compaction 30/50/60 resolves verbatim into the role", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    compaction:
      soft_at: "30%"
      at: "50%"
      buffer: "10%"
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.compaction).toEqual({ soft_at: "30%", at: "50%", buffer: "10%" });
  });

  test("a non-percent compaction value is a schema problem naming the role", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    writes: []
    compaction:
      soft_at: "30%"
      at: "30000"
      buffer: "10%"
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      expect((e as RosterError).problems.join("\n")).toContain("30000");
    }
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
cd /Users/steve/QDS-Factory && bun test tests/phase-engine/ > /tmp/qds-test.log 2>&1; tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" | head
```

- [ ] **Step 4: Minimal implementation**

In `schema.ts`:

1. RoleSchema (~line 124, next to `harness_engineering`):

```typescript
  compaction: z
    .object({
      soft_at: z.string().regex(/^\d+(\.\d+)?%$/),
      at: z.string().regex(/^\d+(\.\d+)?%$/),
      buffer: z.string().regex(/^\d+(\.\d+)?%$/),
    })
    .optional(),
```

2. ResolvedRole (~line 59): `compaction?: { soft_at: string; at: string; buffer: string };`

3. Resolve loop (~line 285): `const compaction = pick(role, defaults, "compaction");` and add `...(compaction !== undefined ? { compaction } : {}),` to the pushed role object. Do NOT add compaction to the tools-allowlist warning logic.

- [ ] **Step 5: Run, expect PASS** (same command as Step 3)

- [ ] **Step 6: detect_changes + commit**

```bash
git add src/phase-engine/roster/schema.ts tests/phase-engine/
git commit -m "feat(roster): optional per-role compaction threshold block (30/50/60 rollout)"
```

---

### Task 5: Adapter — `harness_engineering` → `extensions`, `compaction` → `extensionArgs`

**Files:**
- Modify: `cli-anything/scripts/team-lead-driver.ts` (`WorkerConfig` interface: add `extensionArgs?: string[]`; `buildWorkerArgv`: append them; new `validateExtensionArgs` guard)
- Modify: `src/phase-engine/phases/roster-adapter.ts` (`rosterRoleToTeamRole`)
- Test: `cli-anything/test/team-lead-driver.test.ts`, `tests/phase-engine/roster-adapter.test.ts`

**Interfaces:**
- Consumes: `ResolvedRole.harness_engineering: string[]`, `ResolvedRole.compaction?` (Task 4), `WorkerConfig.extensions` (existing).
- Produces:
  - `WorkerConfig.extensionArgs?: string[]` — validated flag pairs appended to the pi argv before `-p`.
  - `validateExtensionArgs(args: unknown[]): { ok: true; argv: string[] } | { ok: false; rejected: string }` — allowlist: flags exactly `--compact-soft-at | --compact-at | --compact-buffer | --compact-prompt`, each followed by one non-empty value; odd trailing value or unknown flag rejected.
  - `rosterRoleToTeamRole` now returns `extensions: role.harness_engineering` when non-empty, and `extensionArgs` built from `role.compaction` as `["--compact-soft-at", soft_at, "--compact-at", at, "--compact-buffer", buffer]`.

- [ ] **Step 1: Impact analysis** on `rosterRoleToTeamRole` (expected low: one conversion point, existing tests in `tests/phase-engine/roster-adapter.test.ts`).

- [ ] **Step 2: Failing tests**

In `tests/phase-engine/roster-adapter.test.ts`, add:

```typescript
test("worker role harness_engineering + compaction become extensions + extensionArgs", () => {
  const role = {
    name: "worker", provider: "openrouter", model: "deepseek/deepseek-v3.2",
    thinking: "medium", tools: null, writes: ["src/"],
    harness_engineering: ["pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts"],
    compaction: { soft_at: "30%", at: "50%", buffer: "10%" },
    slug: "openrouter/deepseek/deepseek-v3.2", warnings: [],
  } as unknown as ResolvedRole;
  const t = rosterRoleToTeamRole(role, { agentId: "worker", prompt: "p" });
  expect(t.extensions).toEqual(["pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts"]);
  expect(t.extensionArgs).toEqual(["--compact-soft-at", "30%", "--compact-at", "50%", "--compact-buffer", "10%"]);
});

test("role without harness_engineering or compaction leaves both undefined", () => {
  const role = {
    name: "planner", provider: "openrouter", model: "m", thinking: "medium",
    tools: null, writes: [], harness_engineering: [],
    slug: "openrouter/m", warnings: [],
  } as unknown as ResolvedRole;
  const t = rosterRoleToTeamRole(role, { agentId: "planner", prompt: "p" });
  expect(t.extensions).toBeUndefined();
  expect(t.extensionArgs).toBeUndefined();
});
```

In `cli-anything/test/team-lead-driver.test.ts`, add:

```typescript
test("extensionArgs land on the argv before -p and reject unknown flags", () => {
  const base = { agentId: "w", provider: "openrouter", model: "m", prompt: "p" };
  const argv = buildWorkerArgv({ ...base, extensionArgs: ["--compact-soft-at", "30%", "--compact-at", "50%", "--compact-buffer", "10%"] } as WorkerConfig);
  expect(argv.indexOf("-p")).toBeGreaterThan(argv.indexOf("--compact-buffer"));

  const bad = validateExtensionArgs(["--evil", "x"]);
  expect(bad.ok).toBe(false);
  const odd = validateExtensionArgs(["--compact-at"]);
  expect(odd.ok).toBe(false);
});
```

- [ ] **Step 3: Run both, expect FAIL**

```bash
cd /Users/steve/QDS-Factory && bun test tests/phase-engine/roster-adapter.test.ts cli-anything/test/team-lead-driver.test.ts > /tmp/qds-test.log 2>&1; tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" | head
```

- [ ] **Step 4: Implement**

`team-lead-driver.ts` — guard + interface + argv:

```typescript
/** INV-EXT-ARGS: only self-compact's registered flags may ride the argv, and each needs a value. */
const EXTENSION_FLAG_ALLOWLIST = new Set([
  "--compact-soft-at",
  "--compact-at",
  "--compact-buffer",
  "--compact-prompt",
]);

export function validateExtensionArgs(
  args: unknown[],
): { ok: true; argv: string[] } | { ok: false; rejected: string } {
  const argv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (typeof flag !== "string" || !EXTENSION_FLAG_ALLOWLIST.has(flag)) {
      return { ok: false, rejected: typeof flag === "string" ? flag : String(flag) };
    }
    const value = args[i + 1];
    if (typeof value !== "string" || value.trim() === "" || EXTENSION_FLAG_ALLOWLIST.has(value)) {
      return { ok: false, rejected: `${flag} (missing value)` };
    }
    argv.push(flag, value);
    i++;
  }
  return { ok: true, argv };
}
```

Add `extensionArgs?: string[]` to `WorkerConfig`. In `buildWorkerArgv`, after the `-e` loop and before `argv.push("-p", ...)`:

```typescript
  if (w.extensionArgs !== undefined) {
    const checked = validateExtensionArgs(w.extensionArgs);
    if (!checked.ok) throw new Error(`extensionArgs rejected: ${checked.rejected}`);
    argv.push(...checked.argv);
  }
```

`runner.ts` (cli-anything/src/runner.ts ~line 1068) already forwards `extensions`; add the same conditional for the new field:

```typescript
      ...(w.extensionArgs !== undefined ? { extensionArgs: w.extensionArgs } : {}),
```

`roster-adapter.ts` — replace the tail of `rosterRoleToTeamRole`'s return:

```typescript
  const extensions = role.harness_engineering?.length ? role.harness_engineering : undefined;
  const extensionArgs = role.compaction
    ? [
        "--compact-soft-at", role.compaction.soft_at,
        "--compact-at", role.compaction.at,
        "--compact-buffer", role.compaction.buffer,
      ]
    : undefined;
  return {
    agentId: opts.agentId,
    model: `${role.provider}/${role.model}`,
    prompt: opts.prompt,
    lean: undefined,
    ...(extensions !== undefined && { extensions }),
    ...(extensionArgs !== undefined && { extensionArgs }),
  };
```

(Remove the now-dead `extensions: undefined` line; keep `lean: undefined` — lean stays manifest-level. `TeamRole`/`TeamManifestSchema` in `cli-anything/src/types.ts` needs the optional `extensionArgs` field added too, mirroring how `lean`/`extensions` are declared there.)

- [ ] **Step 5: Run both suites, expect PASS** (same command as Step 3)

- [ ] **Step 6: detect_changes + commit**

```bash
git add cli-anything/scripts/team-lead-driver.ts cli-anything/test/team-lead-driver.test.ts src/phase-engine/phases/roster-adapter.ts tests/phase-engine/roster-adapter.test.ts cli-anything/src/runner.ts cli-anything/src/types.ts
git commit -m "feat(wiring): roster harness_engineering/compaction -> worker extensions/extensionArgs"
```

---

### Task 6: Wire `qds-default.roster.yaml` worker role

**Files:**
- Modify: `config/rosters/qds-default.roster.yaml`

**Interfaces:**
- Consumes: everything from Tasks 1–5. This is the rollout switch.
- Produces: worker-role runs whose pi argv contains `-e .../self-compact.ts --compact-soft-at 30% --compact-at 50% --compact-buffer 10%`.

- [ ] **Step 1: Edit the worker role**

```yaml
  - name: worker
    model: deepseek/deepseek-v3.2
    writes: ["src/", "tests/", "scripts/"]
    harness_engineering:
      - pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts
    compaction:
      soft_at: "30%"
      at: "50%"
      buffer: "10%"
```

Leave `planner` and `reviewer` untouched (workers-first). Note in a yaml comment that `tools` must stay `null` for workers (default) or name `self_compact`/`view_context` — the schema warning from `schema.ts:287` enforces awareness.

- [ ] **Step 2: Validate the roster**

```bash
cd /Users/steve/QDS-Factory && bun test tests/phase-engine/ > /tmp/qds-test.log 2>&1; echo "exit=$?"; OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?set key}" bun scripts/roster-check.ts --roster config/rosters/qds-default.roster.yaml
```

Expected: tests pass; roster-check resolves every slug (manual preflight per the file's own header comment — skip the pi-catalog half if no key is configured, and say so in the report).

- [ ] **Step 3: Commit**

```bash
git add config/rosters/qds-default.roster.yaml
git commit -m "feat(roster): enable self-compact extension + 30/50/60 compaction on worker role"
```

---

### Task 7: Smoke test — extension loads with our flags on the local pi

**Files:**
- Create: `scripts/self-compact-smoke-test.ts` (coms-smoke-test pattern)

**Interfaces:**
- Consumes: vendored extension path, `buildWorkerArgv` output shape.
- Produces: exit 0 = extension registers its 4 flags on this host's pi. Gate for Task 9.

- [ ] **Step 1: Write the smoke script**

Follow `scripts/coms-smoke-test.ts` (spawn pi via `Bun.spawn`, bounded stdout capture, `PI_SKIP_VERSION_CHECK=1`). Core check, distilled:

```typescript
#!/usr/bin/env bun
/**
 * Smoke: the vendored self-compact extension loads on this host's pi and
 * registers its four flags. Exit 0 = load OK; nonzero = the pi version on
 * this host rejects the extension (version gate for the roster wiring).
 */
const EXT = "pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts";
const proc = Bun.spawn(["pi", "--no-extensions", "-e", EXT, "--help"], {
  cwd: import.meta.dir.replace(/\/scripts$/, ""),
  env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  stdout: "pipe", stderr: "pipe",
});
const out = await new Response(proc.stdout).text();
const code = await proc.exited;
const flagCount = (out.match(/--compact-(soft-at|at|buffer|prompt)/g) ?? []).length;
const distinct = new Set(out.match(/--compact-(soft-at|at|buffer|prompt)/g) ?? []);
if (code !== 0 || distinct.size !== 4) {
  console.error(`self-compact smoke FAILED: exit=${code}, distinct flags=${[...distinct].join(",") || "none"}`);
  console.error(out.slice(-2000));
  process.exit(1);
}
console.log(`self-compact smoke OK: ${distinct.size} compact flags registered`);
```

- [ ] **Step 2: Run it**

```bash
cd /Users/steve/QDS-Factory && bun scripts/self-compact-smoke-test.ts; echo "exit=$?"; pi --version
```

Expected: `self-compact smoke OK: 4 compact flags registered`, `exit=0`. **If it fails on this host's pi version: STOP, report the version, and surface the pin-bump decision to the user before proceeding.**

- [ ] **Step 3: Commit**

```bash
git add scripts/self-compact-smoke-test.ts
git commit -m "test(self-compact): version-gate smoke — extension registers 4 flags on host pi"
```

---

### Task 8: Full repo suite + upstream e2e + hygiene

**Files:** none new — verification task.

- [ ] **Step 1: Upstream e2e suite (fake provider, deterministic)**

```bash
cd /Users/steve/QDS-Factory/pi-vs-claude-code-vendor/self-compact
node --test --test-timeout=300000 tests/e2e/lifecycle.test.ts > /tmp/sc-e2e.log 2>&1; echo "exit=$?"
node --test --test-timeout=300000 tests/e2e/failure-recovery.test.ts >> /tmp/sc-e2e.log 2>&1; echo "exit=$?"
node --test --test-timeout=300000 tests/e2e/launch-variants.test.ts >> /tmp/sc-e2e.log 2>&1; echo "exit=$?"
```

Expected: three `exit=0`. These cover notice→warning→forced→handoff and failure recovery against a fake provider.

- [ ] **Step 2: Full repo suite (tee rule)**

```bash
cd /Users/steve/QDS-Factory && bun test > /tmp/qds-test.log 2>&1; echo "exit=$?"
tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
```

Expected: `exit=0`, no failure lines. Any failure: fix or surface before proceeding — never skip `tests/gitnexus/` (contract alarm).

- [ ] **Step 3: detect_changes against dev (regression review)**

```
detect_changes({scope: "compare", base_ref: "dev", repo: "QDS-Factory"})
```

Expected: changed symbols confined to `buildWorkerArgv`, `validateExtensionArgs` (new), `rosterRoleToTeamRole`, roster schema types, plus vendored/test/script files. Nothing else.

---

### Task 9: Live e2e round (real box, real spend)

**Files:** none new — governed by the `qds-live-e2e` skill.

- [ ] **Step 1: Invoke the `qds-live-e2e` skill** for a pre-merge round. The round must exercise, on a real exe.dev box:
  1. **Version gate first:** run the Task 7 smoke against the box's pi 0.84.4 (`pi --version` on the box; extension load + 4 flags). **Failure ⇒ STOP: bump the image pin in `scripts/build-exedev-image.ts` (lines 184-185, 562, 651), rebuild, re-gate — do not run compaction live against a broken host.**
  2. A real worker run through the roster with the extension loaded: observe the notice message near 30%, warning near 50%, forced block at 60%, a real `self_compact(note_to_self)` call, and the note returned verbatim after compaction.
  3. Compaction-failure recovery at least once (kill the summarize mid-flight or use `/self-compact-now` semantics) — note + lock survive, retry succeeds.
- [ ] **Step 2: Record evidence** under `_bmad-output/evidence/` per the skill's convention, and report agreement/spend numbers in the round summary.

---

### Task 10: PR

- [ ] **Step 1: Push branch + open PR into `dev`**

```bash
cd /Users/steve/QDS-Factory
git checkout -b feature/self-compact-pi-agent   # created at Task 1 start, before any commit
git push -u origin feature/self-compact-pi-agent
gh pr create --base dev --title "feat: self-compact pi agent integration (30/50/60, workers-first)" --body "Vendors disler/self-compact-pi-agent@576fe4ab. Roster-driven thresholds via extensionArgs; QDS-flavored prompts; version-gated. Spec: docs/superpowers/specs/2026-09-22-self-compact-pi-agent-design.md"
```

(Branch creation is part of Task 1's first step in practice — create `feature/self-compact-pi-agent` from `dev` BEFORE Task 1's commit.)
