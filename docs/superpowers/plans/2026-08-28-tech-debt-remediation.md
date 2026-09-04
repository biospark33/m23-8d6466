# Tech Debt Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 122 findings from `TECH_DEBT_AUDIT.md` (3 Critical · 33 High · 65 Medium · 21 Low) in dependency order, leaving `bun test` green, CI honest, the money loop closed, and SwarmClaw authenticated.

**Architecture:** Ten sequential waves. Wave 0 unblocks everything by answering the audit's eleven maintainer questions and fixing the repo map, because four findings' severity and shape depend on those answers. Waves 1–3 are the load-bearing ones (money, security, green CI). Waves 4–9 are correctness, shared primitives, orchestrator splits, performance, and cleanup — each independently shippable. Every wave is one or more PRs; no wave requires a later wave's work.

**Tech Stack:** Bun (runtime, `bun:test`, `bun:sqlite`, `Bun.spawn`, `Bun.serve`), TypeScript strict, Biome + oxlint, Vue 3 + Vite (`visualizer/`), zod, GitHub Actions, Docker (`oci/`).

**Spec:** `TECH_DEBT_AUDIT.md` (2026-08-28, commit `f9e828d`, three review rounds). Every task below cites the finding IDs it closes; read the audit row for the full evidence before editing.

## Global Constraints

- Runtime is **Bun**, not Node. `node:child_process` is unusable here (`test-results.ts:171` documents why). Use `Bun.spawn`, `bun:sqlite`, `bun:test`.
- Branch convention (from `CLAUDE.md`): `prefix=feature/ base=main target=main`.
- **PR authorship (strict):** all PRs for `Quantum-Digital-Solutions/QDS-Factory` are created by the `biospark33` gh account — `biospark33` ONLY for `gh pr create`, switch back to `i3creations` immediately (`source ~/.config/ghswitch.sh && ghswitch i3creations`). Every other git/gh operation runs as `i3creations`.
- Reindex command is `bash scripts/install-gitnexus-plus.sh` — **never** a bare `gitnexus analyze`.
- Before editing any symbol: run `impact({target: "symbolName", direction: "upstream"})`; before committing: `detect_changes()`. Report HIGH/CRITICAL risk to the user before proceeding.
- Verification commands, in this exact form:
  - `bunx tsc --noEmit` — must stay clean.
  - `bunx @biomejs/biome check` — must stay clean (318 files at baseline).
  - `bun test` — the full suite takes **500–563 seconds**, not 35. Budget for it.
  - `bun run --cwd visualizer lint` / `bun run --cwd visualizer typecheck`.
- ~580 message-substring assertions live in `tests/fleet/`. They are the CLI contract, not brittleness. Refactors must keep every message byte-identical unless a task says otherwise.
- No behaviour change is permitted in Wave 6 (orchestrator splits). Those are mechanical extractions; the test suite is the proof.
- The `ponytail:` comment convention is `ponytail: <ceiling>, <upgrade path>`. Any new deliberate simplification gets one; any comment that states a *rationale* rather than an accepted ceiling gets `NOTE:` instead.

---

## File Structure

New files this plan creates:

| File | Responsibility |
|------|----------------|
| `src/lib/file-lock.ts` | The hardened O_EXCL lock (rename-to-claim + content re-verify) with an optional `block` policy. Replaces two divergent copies. |
| `src/lib/http.ts` | One parameterised `fetch` wrapper: `{timeoutMs, retryOn, headers, errorClass}`. Replaces four hand-rolled ones. |
| `src/providers/fs-atomic.ts` | Leaf module: `fsyncDir`, `rmQuiet`, `assertDirMode0700`, `atomicReplaceFile`. Depends on nothing. |
| `src/providers/path-guard.ts` | One `assertPlainBoxPath(label, value)` taking the strictest of six divergent validators. |
| `src/providers/bounded-exec.ts` | One chunked, size-capped child-output reader (`EXEC_MAX_OUTPUT_BYTES`, SIGKILL past the cap, returns truncated text + marker). |
| `scripts/lib/kill-tree.ts` | The tested process-tree kill promoted out of `coms-smoke-helpers.ts`. |
| `visualizer/src/lib/poll.ts` | `usePoller(fn)` composable — the backoff logic three components copy verbatim. |
| `.github/dependabot.yml` | npm at `/`, `/visualizer`, `/cli-anything`, plus `github-actions`. Weekly, grouped. |
| `bunfig.toml` (root) | Coverage floor narrowed to `scripts/lib/**` + `src/providers/**`, set at the measured baseline so it ratchets. |
| `_bmad-output/sprint-artifacts/sprint-status-history.md` | The ~40 lines of superseded header notes moved out of the yaml. |
| `docs/decisions/` (as needed) | ADR-style answers to the audit's open questions, referenced by the code that depends on them. |

Files this plan deletes: `firebase-debug.log`, `cli-anything/node_modules/`, `artifacts/worker-a.json`, `artifacts/worker-b.json`, `config/rosters/df16-e2e.roster.yaml` (or relocated to `tests/fixtures/rosters/`).

---

## WAVE 0 — Answer the questions, fix the map

Nothing else is safe to start until Q2 and Q4 are answered: Q2 sets F002's severity and fix shape, Q4 decides whether F030 is High or Critical. The README work is the cheapest item in the whole audit with the widest blast radius — every human and every agent reads it first.

### Task 0.1: Resolve the eleven open questions

**Files:**
- Create: `docs/decisions/2026-08-tech-debt-answers.md`

**Interfaces:**
- Produces: written answers that Tasks 1.1, 2.1, 2.5, 4.4, 7.5 and 8.6 cite by section anchor.

- [ ] **Step 1: Put the eleven questions to the maintainer**

Ask verbatim from `TECH_DEBT_AUDIT.md` § "Open questions for the maintainer". The six that block code below are:

1. **Q1 (F001)** — is the DF2.7→ledger bridge deferred or dropped? Deferred ⇒ Task 1.1 ships the loud degraded-state assertion; dropped ⇒ Task 1.1 deletes `ingestCostEvent` and its 16 tests.
2. **Q2 (F002)** — is SwarmClaw ever reachable off-host? Loopback-only ⇒ F002 is one `hostname` line; cross-host ⇒ F002+F005 are the top of the backlog and the bearer token is mandatory, not opt-in.
3. **Q4 (F030)** — is `QDS_RUN_ROOT` set inside the box image? `journal.ts:38`, `pipeline-run.ts:709` and `tracer.ts:292` hold three contradictory beliefs; one is wrong.
4. **Q8 (F029)** — is the reused `~/.qds/viz-token` deliberate? Mint-per-start vs. keep-and-document with `--rotate`.
5. **Q6 (run-lock.ts layering)** — does `scripts/lib/run-lock.ts` (1,166 LOC) belong under `src/`? `src/fleet/` imports it from `scripts/`, which inverts the layering.
6. **Q10 (F095)** — was `check-defensive-programming.sh` meant to gate or to be a reviewer's aid?

- [ ] **Step 2: Record the answers**

Write `docs/decisions/2026-08-tech-debt-answers.md` with one `## Q<n>` section per question: the question, the decision, and the finding IDs it settles. Tasks below reference these anchors.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/2026-08-tech-debt-answers.md
git commit -m "docs: record maintainer answers to tech-debt audit open questions"
```

### Task 0.2: Fix the repo map (F016, F087, F085, F012, F090)

**Files:**
- Modify: `README.md:6`, `README.md:11-18`, `README.md:30`, `README.md:33`, `README.md:35-40`
- Modify: `.qds-config.yml:7-10`
- Modify: `.env.example`
- Modify: `_bmad-output/sprint-artifacts/sprint-status.yaml`
- Create: `_bmad-output/sprint-artifacts/sprint-status-history.md`

- [ ] **Step 1: Rewrite the README module table (F016)**

The table lists six modules; the tree has twelve. Add the six missing — `src/fleet`, `src/providers`, `src/phase-engine`, `src/pr`, `src/reverify`, `visualizer/` — which are the majority of LOC and 100% of six-month churn. Add one paragraph naming the split the audit's "Architectural mental model" section describes: the **Dark Factory v5 control plane** (`src/fleet` admits work behind a single-operator file lock; `src/providers` owns the exe.dev substrate, minted credentials, cost ledger, harvest/teardown/reaper; `src/phase-engine` runs manifest-driven phases and writes the SQLite trace; `src/pr` + `src/reverify` re-verify and publish; `visualizer/` is the read-only Vue UI) versus the **Phase-0 scaffolding** (`src/gate/`, `src/swarmclaw/`, `src/hindsight/`, `scripts/*-verify.ts`, `cli-anything/`, `pi-vs-claude-code-vendor/`), which is still `gate-red-not-exitable` while 23 of 31 Dark Factory stories have shipped on top of it.

- [ ] **Step 2: Fix the three stale claims (F087)**

- `README.md:30` — "non-clean on main today — 6 pre-existing findings" is false; `bunx @biomejs/biome check` is clean across 318 files. Say so.
- `README.md:33` — the named known-failure `H4c: keep-alive pool survives a 413` passes. The actual failures are `tests/gitnexus/graph-queries.test.ts:352` (every run) and `tests/fleet/cli.test.ts:4968` (2 of 4). Name those, and delete the line once Wave 3 lands.
- `README.md:6` — "there is no build step" sits next to a Vite app whose `build:check` is a CI step. Remove it.
- `README.md:35-40` — the claim that routine observability output is muted under `bun test` is false for two sinks; either fix the claim here or fix the sinks in Task 8.9 (F088) and keep the claim. Do both if Task 8.9 lands first.

- [ ] **Step 3: Point `.qds-config.yml` at the visualizer (F085)**

```yaml
frontend_dir: visualizer
frontend_lang: typescript
```

and align its `lint`/`typecheck` commands with root `package.json:20`, which already includes `visualizer` and `oci`. Today the config's `lint` omits both, so every skill-driven review silently skips the frontend.

- [ ] **Step 4: Add the ten missing env vars to `.env.example` (F012)**

Use the file's existing per-var `(file:line)` citation convention. The ten: `OPENROUTER_PROVISIONING_KEY` (`src/providers/credentials.ts:600`), `QDS_RUNS_DIR`, `QDS_COST_LEDGER_FILE`, `QDS_QUOTA_LIMITS_FILE`, `QDS_FANOUTS_DIR`, `QDS_PI_TIMEOUT_MS`, `QDS_EVIDENCE_DIR`, `QDS_PROVIDER_DRIVER`, `QDS_MODELS_JSON`, `QDS_BENCH_RUNS`. Give `OPENROUTER_PROVISIONING_KEY` an explicit note that it **creates and deletes** API keys.

While here, fix the two stale citations at `.env.example:157,163` — they point at `runner.ts:844`/`:857`; the reads are at `:688`/`:701` (Low).

- [ ] **Step 5: Drain the sprint-status header (F090)**

`_bmad-output/sprint-artifacts/sprint-status.yaml` is the repo's highest-churn file (73 commits in six months) and carries ~40 lines of superseded header notes, at least three of which are self-corrections for status drift the board itself caused. Move the historical notes to `sprint-status-history.md`; keep the yaml at current state plus the newest note.

- [ ] **Step 6: Verify**

Run: `bunx @biomejs/biome check`
Expected: clean.
Read the new README top-to-bottom and check every file path it names exists.

- [ ] **Step 7: Commit**

```bash
git add README.md .qds-config.yml .env.example _bmad-output/sprint-artifacts/
git commit -m "docs: rewrite README module map, fix stale claims, wire .qds-config to visualizer (F016 F087 F085 F012 F090)"
```

---

## WAVE 1 — Close the money loop

F001 + F004 + F032 are one problem in three places, and the only Critical that costs cash rather than trust. Today the per-issue cap enforces *VM lifetime plus whatever the provider itself refuses* — and the thing that makes the provider refuse is not verified.

### Task 1.1: Wire or declare the token ledger (F001)

**Files:**
- Modify: `src/providers/cost-ledger.ts:832` (docstrings), `src/fleet/dispatch.ts` (the `{kind:"cost"}` team-event consumer), `scripts/qds-cost.ts`
- Test: `tests/providers/cost-ledger.test.ts`, `tests/fleet/cli.test.ts`

**Interfaces:**
- Consumes: Task 0.1 § Q1's answer.
- Produces: either a live `ingestCostEvent` call path, or a `tokens-ledger-unwired` degraded-state line that Task 1.3's divergence check can reference.

- [ ] **Step 1: Write the failing test for the branch Q1 chose**

If **deferred** — assert the loud degraded state:

```ts
test("qds-cost reports a degraded ledger when no token rows exist", async () => {
  const ledger = freshLedgerWithOnlyBoxHours();
  const out = await runQdsCost(["--dir", ledger.dir]);
  expect(out).toContain("tokens-ledger-unwired");
  expect(out).toContain("per-issue caps count box-hours only");
});
```

If **wired** — assert the bridge:

```ts
test("a {kind:'cost'} team event lands as a kind='tokens' ledger row", async () => {
  const led = openLedger(tmp);
  await consumeTeamEvent(led, { kind: "cost", runId: "r1", issueId: "i1", microUsd: 1234 });
  expect(led.readIssueCost("i1").rows.filter(r => r.kind === "tokens")).toHaveLength(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/providers/cost-ledger.test.ts -t "tokens"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ingestCostEvent` (`src/providers/cost-ledger.ts:832`) is the only writer of `kind='tokens'` rows and has zero callers outside `tests/`. Nothing bridges the `CostEvent`s that `cli-anything/src/runner.ts:1118` produces into the host ledger, so `admitIssue`'s SUM (`:1551`) and `readIssueCost` see box-hours only (written by `teardown.ts:316` as `kind='box_hours'`).

- **Wired:** call `ingestCostEvent` at the single dispatcher site that consumes the `{kind:"cost"}` team event.
- **Deferred:** emit a structured `tokens-ledger-unwired` line from `qds-cost` whenever the `tokens` row count is 0, stating that per-issue caps count box-hours only.

Either way, **rewrite every docstring in `cost-ledger.ts` that describes the wiring**, and correct INV-COST-2 wherever it is stated. Right now the prose says the opposite of the code.

- [ ] **Step 4: Run the test**

Run: `bun test tests/providers/cost-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/cost-ledger.ts scripts/qds-cost.ts tests/providers/cost-ledger.test.ts
git commit -m "fix(money): close or declare the DF2.7 token-ledger bridge (F001)"
```

### Task 1.2: Refuse an over-granted mint ceiling (F004, F035)

**Files:**
- Modify: `src/providers/credentials.ts:330-340`, `src/providers/credentials.ts:425`, `src/providers/credentials.ts:68`, `src/providers/credentials.ts:725` (`keyEntryOf`)
- Test: `tests/providers/credentials.test.ts` (beside `:361`)

- [ ] **Step 1: Write the two failing tests**

```ts
test("mintRunKey refuses a provider echo above the requested cap", async () => {
  const drv = fakeProvider({ echoLimitUsd: 5 });          // asked for 1 USD
  await expect(mintRunKey({ ...opts, capMicroUsd: 1_000_000 }, drv))
    .rejects.toMatchObject({ code: "mint-ceiling-mismatch" });
});

test("keyEntryOf rejects a non-numeric usage instead of writing NaN", () => {
  expect(() => keyEntryOf({ usage: "n/a" } as never))
    .toThrow(expect.objectContaining({ code: "invalid-provider-usage" }));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test tests/providers/credentials.test.ts -t "ceiling"`
Expected: FAIL — the mint accepts the over-grant; `keyEntryOf` yields `NaN`.

- [ ] **Step 3: Implement the ceiling refusal (F004)**

`budget-gate.ts:104-105` already names this as the enforcement locus — it states the mint "REFUSES a provider echo that does not carry the requested limit". `mintRunKey` checks only finite-and-positive, then persists whatever came back (`:340`). With F001 open, this is the whole enforcement chain.

```ts
// src/providers/credentials.ts:330 — after the existing finite/positive check
if (usdToMicros(res.limitUsd) > capMicroUsd) {
  throw new CredentialLifecycleError(
    "mint-ceiling-mismatch",
    `provider granted ${res.limitUsd} USD against a ${capMicroUsd} micro-USD cap`,
    "revoke the key and fix the provider request",
  );
}
```

Over-grant only — a provider that clamps *down* is fine.

- [ ] **Step 4: Implement the `usdToMicros` guard (F035)**

There is a second, unguarded `usdToMicros` in this file, in the same directory as `cost-ledger.ts:248`'s validating one, and **both files claim to be the single conversion site**. Its input at `:425` is `Number(k.usage ?? 0)` from an unvalidated provider body (`keyEntryOf:725`); a non-numeric `usage` becomes `NaN`, and `store.set` then throws a generic `"spendMicroUsd must be an integer"` out of teardown's *spend* step — aborting **before revoke and leaving the key live**.

Reject non-finite/negative `usage` in `keyEntryOf` with a typed `CredentialLifecycleError`, give this `usdToMicros` the same finite guard, and fix the two contradicting "only" docstrings.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/providers/credentials.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/credentials.ts tests/providers/credentials.test.ts
git commit -m "fix(money): refuse over-granted mint ceilings; guard usage->micros (F004 F035)"
```

### Task 1.3: Make the spend divergence visible (F032, F091)

**Files:**
- Modify: `src/providers/teardown.ts` (close step), `src/fleet/status.ts:349`
- Test: `tests/providers/teardown.test.ts`, `tests/fleet/status.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("teardown emits a divergence line when record and derived spend disagree", async () => {
  const lines = await teardownCapturingStderr({ spendMicroUsd: 900, derivedMicroUsd: 100 });
  expect(lines).toContainEqual(expect.objectContaining({ type: "spend-divergence" }));
});

test("fleet status names both records when two boxes share a name", async () => {
  const out = await fleetStatus(withDuplicateBoxName("box-a"));
  expect(out).toContain("duplicate-box-name");
  expect(out).toContain("run-1"); expect(out).toContain("run-2");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test tests/providers/teardown.test.ts tests/fleet/status.test.ts -t "divergence|duplicate"`
Expected: FAIL.

- [ ] **Step 3: Implement F032**

`captureSpend` writes the provider-authoritative figure as `spendMicroUsd`; `readRunCost(runId)` derives a different figure from DF2.7 events. Nothing compares them — `readRunCost`'s only reader is `src/pr/open-pr.ts:137`; `spendMicroUsd`'s are `cap-hit-demo` and `fleet/status`. Dropped or unpriced events make the cap under-count silently while the true number sits one field away.

At teardown's close step, emit a structured divergence line when the two differ beyond a threshold. **No schema change** — this is what makes F001's gap visible the moment it costs money.

- [ ] **Step 4: Implement F091**

The record→VM join in `src/fleet/status.ts:349` is last-wins on a duplicate `name`, and its `ponytail:` marker says so — the earlier box's row is dropped from `fleet status` output. `name` is the join key across records, driver and teardown, so the hidden row is a **live, billing** box the operator's own status verb will not show.

Do **not** carry `Map<string, ProviderVm[]>` through the join (the marker's own upgrade path — too big). Detect the collision at the join and emit one `duplicate-box-name` line naming both records; keep last-wins for the table. Update the marker to say the collision is now reported.

- [ ] **Step 5: Run the tests, then commit**

Run: `bun test tests/providers/teardown.test.ts tests/fleet/status.test.ts`
Expected: PASS.

```bash
git add src/providers/teardown.ts src/fleet/status.ts tests/providers/teardown.test.ts tests/fleet/status.test.ts
git commit -m "fix(money): report spend divergence at teardown and duplicate box names in status (F032 F091)"
```

---

## WAVE 2 — Put doors on the trust boundaries

Everything else in this repo is fail-closed at its trust boundaries. SwarmClaw is fail-open at both.

### Task 2.1: Bind and authenticate SwarmClaw (F002, F005)

**Files:**
- Modify: `src/swarmclaw/index.ts:35`, `src/swarmclaw/mcp/stdio-transport.ts:255`
- Test: `tests/swarmclaw/index.test.ts`, `tests/swarmclaw/stdio-transport.test.ts`

**Interfaces:**
- Consumes: Task 0.1 § Q2's answer. Loopback-only ⇒ the token may stay opt-in via `SWARMCLAW_AUTH_TOKEN`; cross-host ⇒ the token is required and startup refuses without it.

- [ ] **Step 1: Write the failing tests**

```ts
test("serve binds loopback by default", async () => {
  const s = await startSwarmClaw({ port: 0 });
  expect(s.hostname).toBe("127.0.0.1");
  await s.stop();
});

test("a request without the bearer token is 401 before the 413 guard", async () => {
  const s = await startSwarmClaw({ port: 0, token: "t0ken" });
  const res = await fetch(`${s.url}/api/mcp-servers`, { method: "POST", body: "x".repeat(10_000_000) });
  expect(res.status).toBe(401);
  await s.stop();
});

test("an allowlisted command with no arg validator refuses args", () => {
  expect(() => validateCommand({ command: "hindsight-local-mcp", args: ["--evil"] }))
    .toThrow(/no arg policy/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test tests/swarmclaw/`
Expected: FAIL — no hostname, no auth, no arg policy.

- [ ] **Step 3: Bind and authenticate (F002)**

`Bun.serve({port, fetch})` sets no `hostname` (Bun defaults to `0.0.0.0`) and there is no auth anywhere in the request path — `grep -i "authorization\|bearer"` over `src/swarmclaw/` returns nothing. Four POST routes spawn subprocesses and proxy arbitrary tool calls into them.

```ts
// src/swarmclaw/index.ts:35
const server = Bun.serve({
  port,
  hostname: process.env.SWARMCLAW_BIND ?? "127.0.0.1",   // was: unset → 0.0.0.0
  async fetch(req) {
    const tok = process.env.SWARMCLAW_AUTH_TOKEN;
    if (tok && !timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${tok}`))
      return json(401, { error: { code: "unauthorized" } });
    // …existing 413 guard and route table
```

The 401 goes **above** the 413 guard. Waive the bind only on an explicit, documented sentinel. Use `timingSafeEqual`, not `===`.

Note for the reviewer: every SwarmClaw route already sits behind the single dispatcher at `index.ts:372` (host → CSRF → credential, before the route table at `:452` and the static fallback at `:464`). Adding a route cannot bypass it. That is good design — F002 is that there was no credential to check.

- [ ] **Step 4: Default-deny unvalidated argv (F005)**

`validateCommand` branches on `basename(command)` and validates args only for `node` and `npx`. For `hindsight-local-mcp` — the default allowlist entry at `:25` — no arg validation runs, while `RegisterMCPServerSchema` (`store/mcp-store.ts:18`) accepts **256 args × 4096 chars and 64 env pairs**. With F002 that was full argv + env control from an unauthenticated caller.

```ts
if (base === "node") { /* existing */ }
else if (base === "npx") { /* existing */ }
else if (opts.args.length > 0) throw new Error(`no arg policy for allowlisted command ${base}`);
```

Opt in via `SWARMCLAW_ARG_POLICY` for commands that legitimately need flags.

- [ ] **Step 5: Run the tests, then commit**

Run: `bun test tests/swarmclaw/`
Expected: PASS.

```bash
git add src/swarmclaw/ tests/swarmclaw/
git commit -m "fix(security): bind SwarmClaw to loopback, require bearer auth, default-deny argv (F002 F005)"
```

### Task 2.2: Make PR-body redaction live (F007)

**Files:**
- Modify: `scripts/open-pr.ts:42`
- Test: `tests/pr/open-pr.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the PR body redacts the host token and the minted provider key", async () => {
  const body = await buildPrBodyViaCli({ runId, hostToken: "ghp_SECRET", mintedKey: "sk-or-SECRET" });
  expect(body).not.toContain("ghp_SECRET");
  expect(body).not.toContain("sk-or-SECRET");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test tests/pr/open-pr.test.ts -t "redacts"`
Expected: FAIL — both secrets present.

- [ ] **Step 3: Implement**

`openPullRequest(runId)` passes no `deps`, so `redaction = deps.redaction ?? {}` (`src/pr/open-pr.ts:179`) and `redactSecrets(text, {})` returns text unchanged (`cli-anything/src/redact.ts:69`). The PR body and refusal issue comment carry `git push`/`ls-remote` stderr verbatim (`src/pr/push.ts:362,457,474`) plus agent-authored `claimed.changedFiles`. INV-PR-7 redaction is **inert on the only shipped entry point**.

Build the map in `scripts/open-pr.ts` from the values this run holds — host token, minted provider key and its hash, read from the run record — and pass it as `deps.redaction`. Do the same for the `reverify` CLI if Task 0.1 § Q3 says no unlanded caller was meant to supply it.

- [ ] **Step 4: Run the test, then commit**

```bash
git add scripts/open-pr.ts tests/pr/open-pr.test.ts
git commit -m "fix(security): assemble the redaction map in the open-pr CLI (F007)"
```

### Task 2.3: Fail closed on the smoke-test env allowlist (F013, F014)

**Files:**
- Modify: `scripts/coms-smoke-test.ts:178`, `scripts/coms-smoke-test.ts:207`
- Test: `tests/scripts/coms-smoke-test.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
test("smokeChildEnv fails closed when no provider can be identified", () => {
  expect(() => smokeChildEnv({ PI_SMOKE_MODEL: undefined })).toThrow(/env_scope/);
});

test("smokeChildEnv passes the full env only behind the explicit opt-in", () => {
  const env = smokeChildEnv({ PI_SMOKE_ALLOW_FULL_ENV: "1" });
  expect(env.SOME_AMBIENT_SECRET).toBeDefined();
});
```

These tests cannot even be written today — which is F014.

- [ ] **Step 2: Add the `import.meta.main` guard first (F014)**

The file has no `import.meta.main` guard (16 of the 21 files in `scripts/` have one, 29 repo-wide). `smokeChildEnv()` runs at module load and the report emits at top level, so the file executes on import and nothing can be unit-tested — including `parseEvents:456`, `detectAuthFailure:530` and the F013 allowlist. Wrap the driver in `if (import.meta.main)` and export the four pure helpers.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `bun test tests/scripts/coms-smoke-test.test.ts`
Expected: FAIL — the fallback still returns `{...process.env}`.

- [ ] **Step 4: Implement F013**

`smokeChildEnv()` derives the provider from `PI_SMOKE_MODEL?.split("/")[0]`. With `PI_SMOKE_MODEL` unset — exactly how `package.json:18`'s `smoke:coms` invokes it — `provider` is `""`, `PROVIDER_KEYS[""]` is undefined, and `:180` returns `{...process.env}`. **The default path ships every ambient credential to two spawned `pi` processes**, while the file header presents the allowlist as the INV-1 control.

Require `PI_SMOKE_ALLOW_FULL_ENV=1` for the fallback; otherwise fail closed with the `env_scope` message.

- [ ] **Step 5: Run the tests, then commit**

```bash
git add scripts/coms-smoke-test.ts tests/scripts/coms-smoke-test.test.ts
git commit -m "fix(security): fail closed on the smoke-test env allowlist; make the file importable (F013 F014)"
```

### Task 2.4: Redact and shape-check the remaining outward paths (F020, F065, F058, F067, F079)

**Files:**
- Modify: `src/providers/index.ts:98`, `src/pr/push.ts:365`, `src/phase-engine/phases/dispatch-task.ts:121`, `src/swarmclaw/routes/mcp-servers.ts:299`, `visualizer/server/index.ts:232`
- Test: the matching test file for each

- [ ] **Step 1: Write the failing tests**

```ts
test("registry-proxy errors are redacted", async () => { /* assert no raw key in emit("error") */ });
test("a tip that is not a 40-hex sha is refused before it reaches git", () => {
  expect(() => assertTip("--upload-pack=evil")).toThrow();
});
test("dispatch redaction scrubs a secret that is in the parent env but not the two known keys", () => { … });
test("an oversized MCP result is a 502, not an echoed blob", async () => { … });
test("static responses carry a content-security-policy header", async () => { … });
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement each**

- **F020** — both registry-proxy `emit("error", …)` arms in `src/providers/index.ts:98` log `(e as Error).message` raw, while every other error sink in the module composes `redactSecrets` (`credentials.ts:196`, `driver.ts:328`, `exedev/driver.ts:310`, `step-log.ts`). The proxy wraps `exec` and `copyFile` — exactly the calls whose rejections carry box stderr and driver argv. `import { redactSecrets } from "./step-log.ts"` and wrap both, matching `timedLoggedStep`'s `redactSecrets(err.message ?? e)` form.
- **F065** — `tip` is whatever `git ls-remote`'s first whitespace token is, and it lands unguarded in `authedGit(["fetch", …, tip])` (`:450`) and `["git","merge-base","--is-ancestor",tip,…]` (`:460`); a value beginning with `-` parses as an option. Guard with `/^[0-9a-f]{40}$/` and refuse otherwise. This module already validates every other value before a git child (`assertPublishableRef`).
- **F058** — `dispatchTask` builds its redaction env from two keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`), and that closure scrubs traced prompts (`:231`), team-event payloads (`:291`) and every refusal message — while `phase.ts:124-128` scrubs the *same records* against the entire `process.env` and `command-gate.ts:100` falls back to `parentEnvStrings()`. Same text, two definitions of "secret". Use the full parent env for the dispatch redaction map; keep the two-key check only for the presence gate at `:143`.
- **F067** — the success payload from an untrusted subprocess is echoed verbatim (`result` passed opaquely out of `stdio-transport.ts:593`), unbounded to the 16 MB frame cap and unshaped, while every *error* path is validated through `MCPInvokeErrorResponseSchema`. Wrap in a permissive `MCPInvokeResultSchema` (`z.unknown()` + a serialized-size cap, e.g. 1 MB) and return 502 on overflow.
- **F079** — `STATIC_HEADERS` sets only `cache-control` and `x-content-type-options`, while the app has five `v-html` sinks (`PhaseDetail.vue:524,650,692,700,704`). The escaping was traced and **holds** — this is a second layer, not a fix. Add:

```
content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'
```

If the Vite build needs script `'unsafe-inline'`, that is itself worth knowing — record it rather than silently widening the policy.

- [ ] **Step 4: Run the affected suites, then commit**

```bash
git add src/providers/index.ts src/pr/push.ts src/phase-engine/phases/dispatch-task.ts src/swarmclaw/routes/mcp-servers.ts visualizer/server/index.ts tests/
git commit -m "fix(security): redact proxy errors, shape-check git tip, widen dispatch redaction, cap MCP results, add CSP (F020 F065 F058 F067 F079)"
```

### Task 2.5: Make the containment boundary actually fire (F030)

**Files:**
- Modify: `src/phase-engine/trace/tracer.ts:292`
- Test: `tests/phase-engine/trace/tracer.test.ts`

**Interfaces:**
- Consumes: Task 0.1 § Q4's answer — it decides whether this is High or Critical.

- [ ] **Step 1: Write the failing test**

```ts
test("a path resolving outside the boundary is refused even with QDS_RUN_ROOT unset", () => {
  delete process.env.QDS_RUN_ROOT;
  expect(() => assertWithinBoundary("/etc/passwd")).toThrow(/boundary/);
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — the function returns immediately.

- [ ] **Step 3: Implement**

`assertWithinBoundary` returns immediately when `QDS_RUN_ROOT` is unset ("test may not always set it"), while `journal.ts:33-35` states the same variable "is never set on a real run". So the INV-1 containment refusal the file header advertises **never fires in production**. The symlink/TOCTOU pins still run; the "resolves outside the boundary" check does not.

Derive the boundary the way `pipeline-run.ts:709` does (`QDS_RUN_ROOT ?? "/run"`) instead of skipping on absence, and pass an explicit boundary through `TracerOptions` in tests. Task 5.7 (F056) then collapses the four competing derivations into one.

- [ ] **Step 4: Run the suite, then commit**

```bash
git add src/phase-engine/trace/tracer.ts tests/phase-engine/trace/tracer.test.ts
git commit -m "fix(security): stop skipping the containment boundary when QDS_RUN_ROOT is unset (F030)"
```

---

## WAVE 3 — Make the suite green and the gates real

`bun test` exits 1 on `main` — four full runs, exit 1 every time. Two written quality gates do not gate. This wave is what makes every later wave's verification trustworthy.

### Task 3.1: Triage the money-invariant race test (F093)

**Files:**
- Investigate: `tests/fleet/cli.test.ts:4968`
- Modify: whichever of the test or `src/fleet/` the triage indicts

**Interfaces:**
- Produces: a written verdict — product bug or budget problem — that Task 3.2 depends on for the CI timeout decision.

- [ ] **Step 1: Reproduce in isolation, ten times**

```bash
for i in $(seq 1 10); do bun test tests/fleet/cli.test.ts -t "NO loser cost ledger" || echo "FAIL $i"; done
```

- [ ] **Step 2: Classify**

This test — "a fleet-busy race refusal creates NO loser cost ledger (INV-2)" — hard-timed-out at 20 s in **2 of 4** full runs. Both failures were `timed out after 20000ms`, not an assertion. It is the **only automated statement that a refused racer leaves no billing artifact**.

- Passes alone, fails under load ⇒ a budget problem; the barrier is timing-dependent under a loaded suite.
- Hangs alone ⇒ **the race does not resolve**, and F093 is a product bug wearing a test's clothes. Fix the product.

**Do not raise the timeout until you know which.** A 20 s timeout on a race test means the barrier is timing-dependent, not that the box is slow.

- [ ] **Step 3: Fix the indicted side, with a test that names the mechanism**

If it is the product: the fix is in `src/fleet/` and the test stays as written. If it is the budget: make the barrier deterministic (explicit rendezvous, not a sleep) rather than lengthening the deadline.

While here, note the related ceiling at `tests/fleet/cli.test.ts:2227` — the lock-retry probe cannot distinguish two attempts from one, a named coverage ceiling on this same money-adjacent path. Give its `ponytail:` marker an upgrade trigger.

- [ ] **Step 4: Verify determinism**

```bash
for i in $(seq 1 20); do bun test tests/fleet/cli.test.ts -t "NO loser cost ledger" || echo "FAIL $i"; done
```
Expected: 20/20 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/fleet/cli.test.ts src/fleet/
git commit -m "fix(fleet): make the INV-2 race refusal deterministic (F093)"
```

### Task 3.2: Widen the gitnexus staleness guard and fix the CI cap (F010, F082)

**Files:**
- Modify: `tests/gitnexus/graph-queries.test.ts:173`
- Modify: `.github/workflows/ci.yml:19`, `.github/workflows/ci.yml` `timeout-minutes`

- [ ] **Step 1: Write the failing test**

```ts
test("a stale index skips rather than fails the impact assertions", () => {
  withStaleIndex(() => {
    expect(indexUnavailableReason()).toMatch(/reindex/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — the guard probes one symbol's `context` status and reports the index available.

- [ ] **Step 3: Implement F010**

The staleness guard probes exactly one symbol's `context` status (`:173`, checked at `:177`), so a **partially** stale index passes the probe and then fails the impact assertions at `:352`. In CI the gitnexus CLI is absent, so the whole describe skips: red for developers, dark in CI — the worst arrangement available.

```ts
// tests/gitnexus/graph-queries.test.ts:173 — in indexUnavailableReason()
const risk = gn(["impact", FIXTURE_SYMBOL, "-r", REPO, "--direction", "upstream"]);
if (!risk || typeof risk.riskLevel !== "string") return "index lacks impact data — reindex";
```

Probe the shape the ACs actually assert.

- [ ] **Step 4: Fix the CI comment and cap (F082)**

`.github/workflows/ci.yml:19` reads "Full local run is ~35s; 15 min caps a hung child process." Measured: **500 s, 563 s, 521 s, 504 s** across four runs — a 15× understatement. The `check` job also runs install + two typechecks + two lints + `bun test` + `test:visualizer` + `check:lcov` + `build:check` inside that cap.

Replace the comment with the measured range and raise `timeout-minutes` to **25**. Also note that `bun test` already picks up `visualizer/test/*` (they appear in the root run), so `test:visualizer` runs them a second time for coverage instrumentation alone — decide whether that second run earns its minutes.

- [ ] **Step 5: Prove the suite is green**

```bash
bun test
```
Expected: exit 0. (Budget ~9 minutes.)

- [ ] **Step 6: Commit**

```bash
git add tests/gitnexus/graph-queries.test.ts .github/workflows/ci.yml
git commit -m "fix(test): widen the gitnexus staleness guard; correct the CI runtime comment and cap (F010 F082)"
```

### Task 3.3: Make the two written gates gate (F094, F095)

**Files:**
- Modify: `visualizer/package.json:12`, `visualizer/.oxlintrc.json`
- Modify: `.github/workflows/ci.yml` (`check` job)

- [ ] **Step 1: Measure the current backlog**

```bash
bun run --cwd visualizer lint            # measured: 20+ warnings, exit 0
scripts/dev/check-defensive-programming.sh --base origin/main
```

- [ ] **Step 2: Implement F094**

`bun run lint:visualizer` runs `oxlint .`, and `visualizer/.oxlintrc.json:7-9` sets `suspicious` and `perf` to `warn` while `rules` sets `typescript/no-explicit-any: warn`. **oxlint exits 0 on warnings without `--deny-warnings`** — so three of the four configured categories, every `any` in the Vue app included, are unenforceable by construction.

Clear or explicitly allow the existing ~20 warnings first (`visualizer/src/lib/models.ts:28` `filter()[0]`, six `Array#sort` mutations across the components), then add `--deny-warnings` to `visualizer/package.json:12`'s `lint` script, or promote `suspicious`/`perf` to `error`.

- [ ] **Step 3: Implement F095**

`scripts/dev/check-defensive-programming.sh` scans added lines for `as any`, `catch {}`, unguarded `JSON.parse` and async-without-try (D016–D020) — and is **invoked by nothing**. No `package.json` script, no CI step. Its only automated consumer is `tests/phase-engine/usage.test.ts:125`, which exercises the `--code-only` blanker, not the gate. Every record of it passing is a human transcribing a hand-run into story prose. Its sibling `check-pr-conflicts.sh` is in the same state. This is F001's shape in shell.

```yaml
- run: scripts/dev/check-defensive-programming.sh --base origin/${{ github.base_ref }}
```

in the `check` job, gated to `pull_request`. Advisory first if the current backlog is non-zero, then flip to blocking. Task 0.1 § Q10's answer decides whether it gates or is retired to a reviewer's aid — if the latter, delete it and stop recording it as a gate result in story templates.

- [ ] **Step 4: Verify both fail on a deliberate violation**

Add `const x = y as any;` to a scratch branch, push, and confirm CI red. Revert.

- [ ] **Step 5: Commit**

```bash
git add visualizer/package.json visualizer/.oxlintrc.json visualizer/src .github/workflows/ci.yml
git commit -m "ci: make the oxlint and defensive-programming gates actually gate (F094 F095)"
```

### Task 3.4: Pin the toolchain and add dependency surveillance (F096, F098, F099, F084, F102)

**Files:**
- Modify: `.github/workflows/ci.yml:26`, `:59`
- Modify: `package.json`, `visualizer/package.json`, `cli-anything/package.json`, `oci/package.json`
- Modify: `oci/Dockerfile:29`, `:48`
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Pin Bun in CI (F096)**

`uses: oven-sh/setup-bun@v2` with **no `bun-version`** at `:26` and `:59` — it defaults to `latest`. This repo is Bun-API-load-bearing (`Bun.spawn`, `bun:sqlite`, `bun:test`, `todoIf`). npm deps are pinned via `bun.lock` + `--frozen-lockfile`; the runtime interpreting them floats on every run, so a Bun point release can turn a green `main` red — or mask a regression — with no repo change. Add `with: bun-version: <exact>` at both call sites.

- [ ] **Step 2: Declare the floors (F098)**

No `engines` and no `packageManager` in any of the four `package.json` files. Add at the root and mirror into the three workspaces:

```json
"engines": { "bun": ">=1.2.0" },
"packageManager": "bun@<exact, matching CI>"
```

- [ ] **Step 3: Pin the base image (F084)**

`FROM node:22-bookworm-slim` at `oci/Dockerfile:29` and `:48` — a mutable tag in an otherwise fanatically pinned build that pins `@mariozechner/pi-coding-agent@0.55.0` exactly and threads the swept image *ID* through `DEPS_IMAGE` so "the tree that ships is provably the tree that was classified" (`:18-22`). Every OS package in the shipped image is outside that. Pin both `FROM` lines to a digest and document the bump procedure beside the existing pin comment at `:33-37`.

- [ ] **Step 4: Add dependabot (F099)**

`.github/` contains only `workflows/`. Every runtime dependency floats on a caret range (`zod ^3.24.0`, `yaml ^2.9.0`, `vue ^3.5.13`, `vite ^7`, `oxlint ^1`, `vue-tsc ^3`) with no automated update or CVE surfacing — while the project ships a `qds-dependabot` skill and a license sweep that fails on a denied package (`ci.yml:46-48`). The policy infrastructure exists; the input that would exercise it does not.

Create `.github/dependabot.yml` covering `npm` at `/`, `/visualizer`, `/cli-anything`, plus `github-actions` for the workflow pins. Weekly, grouped.

- [ ] **Step 5: De-duplicate the toolchain devDeps (F102)**

`typescript`, `@types/bun` and `@types/node` are re-declared in root, `cli-anything` and `visualizer` at different ranges (`typescript ^5.8.0` vs `^5.7.2`). Bun workspace hoisting installs one copy, so the narrower per-workspace ranges are decorative and can drift arbitrarily. Hoist the three to root-only `devDependencies` and delete them from the workspaces.

- [ ] **Step 6: Verify**

```bash
bun install --frozen-lockfile && bunx tsc --noEmit && bun run build:check
```

- [ ] **Step 7: Commit**

```bash
git add .github/ package.json visualizer/package.json cli-anything/package.json oci/
git commit -m "ci: pin bun and the base image, declare engines, add dependabot, hoist toolchain devDeps (F096 F098 F099 F084 F102)"
```

### Task 3.5: Close the remaining CI coverage gaps (F011, F086, F089, F092, F097, F100, F073, F083, F068, F022)

**Files:**
- Modify: `package.json`, `.github/workflows/ci.yml`, `tsconfig.json:17`
- Modify: `scripts/install-gitnexus-plus.sh:112`, `config/rosters/qds-default.roster.yaml:36`, `scripts/lean-worker-benchmark.ts:558`, `.gitignore`
- Modify: `visualizer/bunfig.toml`
- Create: `bunfig.toml` (root), `tests/scripts/cost-ledger-opts.test.ts`
- Modify: `src/gate/assertions/index.ts` (export `buildAssertions`), `tests/gate/assertion-modules.test.ts`
- Delete: `cli-anything/node_modules/`, `artifacts/worker-a.json`, `artifacts/worker-b.json`

- [ ] **Step 1: Typecheck cli-anything (F011)**

Root `tsconfig.json:17` excludes `cli-anything`, and CI runs only `bun run typecheck` (`ci.yml:30`). `cli-anything/package.json:11` defines its own `typecheck` that **nothing invokes** — 3,295 LOC, including `runner.ts`'s budget-kill and watchdog paths, with no compile gate, while the visualizer got a dedicated CI step for exactly this reason.

```json
"typecheck:cli-anything": "bun run --cwd cli-anything typecheck"
```

plus a CI step next to `typecheck:visualizer`.

- [ ] **Step 2: Un-swallow the lint script and fix the workspace comment (F086, F089)**

`package.json:20`'s `lint` pipes through `2>/dev/null ||` — drop the fallback so a lint failure is a failure. And `.github/workflows/ci.yml:27`'s comment says cli-anything is "not a declared workspace, but its deps hoist from the root lockfile — see #54", while `package.json:8` lists it in `workspaces` and `bun.lock:427` records it as a member. Fix the comment and `rm -rf cli-anything/node_modules` (a stale pre-workspace tree carrying yaml, zod, typescript; already git-ignored, versions match today and drift silently tomorrow).

- [ ] **Step 3: Serialize the reindex script (F092)**

`scripts/install-gitnexus-plus.sh:112`'s own CONCURRENT-RUN HAZARD note (`:115-121`): two invocations in one repo race on the transient root `.gitnexusignore` — run A's EXIT trap `rm`s it mid-analyze for run B, silently dropping the negations — and concurrent `gitnexus analyze --force` "can corrupt the graph DB (no file lock)". The comment declares concurrent runs UNSUPPORTED and adds no locking. But `CLAUDE.md` names this script as **the** canonical reindex command, so any CI matrix shard or overlapping story invokes it. Declared-unsupported is not prevented.

Add an `flock` on a repo-root lockfile around the analyze, failing fast with the "serialize across shards" message the comment already writes. ~6 lines; converts a documented hazard into a refusal.

- [ ] **Step 4: Make the roster claim true (F097)**

`config/rosters/qds-default.roster.yaml:36` hardcodes three OpenRouter model slugs, and its header (`:6-8`) states each is "proven live before a run starts" by `bun scripts/roster-check.ts` — which appears in **neither** `.github/workflows/ci.yml` nor `package.json`. A slug deprecated upstream breaks every dispatch, and nothing notices until a run spends money failing.

Add a `check:roster` script plus either a nightly scheduled workflow (needs `OPENROUTER_API_KEY`) or a `dispatch`-time preflight. If the live check genuinely cannot run in CI, **delete the "proven live before a run starts" line** — today it is false.

- [ ] **Step 5: Stop the benchmark polluting `artifacts/` (F100)**

`artifacts/` is a mixed sink: `artifacts/df1-3-e2e-event-stream.json` is tracked evidence, while `scripts/lean-worker-benchmark.ts:558` defaults its output to `join(process.cwd(), "artifacts")` and `artifacts/` is absent from `.gitignore`. The comment at `:555-557` names this exact collision and solves it only for tests, via `QDS_BENCH_ARTIFACTS_DIR`. The working tree carried untracked `artifacts/worker-a.json` and `worker-b.json` while the audit was written; a `git add -A` commits scratch as evidence.

Default `artifactsDir` to `.sandbox/bench/` (already gitignored), keep `QDS_BENCH_ARTIFACTS_DIR` as the override, and delete the two stray files.

- [ ] **Step 6: Add a ratcheting coverage floor where blast radius is (F083, F073)**

There is no root `bunfig.toml`. The visualizer has an aggregate 90% floor *and* per-file line+function floors via `check-lcov.ts`; the 15,740-LOC `scripts/` tree and all of `src/` have **no coverage gate at all** — inverted relative to blast radius, since `run-lock.ts` and `cost-ledger-opts.ts` guard destructive verbs.

Do not gate the whole repo. Add a root `bunfig.toml` narrowed to `scripts/lib/**` + `src/providers/**`, floor set at the **current measured** number so it ratchets.

For F073: do not chase Vue component coverage either. Tasks 5.5 and 5.6 extract the polling and drain logic into `visualizer/src/lib/**`, where the existing gate picks them up automatically. Record the remaining ~2,700 untested component LOC as a **decision** in `visualizer/bunfig.toml` rather than leaving it looking like an oversight.

- [ ] **Step 7: Test the assertion array and the ledger migration (F068, F022)**

- **F068** — the assertion *predicates* are covered (`tests/gate/assertion-modules.test.ts` imports ten), but `grep "Assertions(" tests/` returns nothing: no test constructs an assertion array. `buildAssertions()` is not exported, so its `GateAssertionSchema` validation and duplicate-id check (`:106-117`) run only in production; a wrong `group`, a missing `timeout_ms` on a slow check or a duplicated id surfaces as an exit-2 crash mid-gate. Export it and add one test: the array schema-validates, ids are unique, and the known-slow assertions (P0.6/P0.7/P0.9) declare a `timeout_ms` above the 30 s default.
- **F022** — `scripts/lib/cost-ledger-opts.ts` is 314 LOC wrapping a lockfile acquire with stale reclaim (`:230-243`), a `VACUUM INTO` migration (`:256`) and a `renameSync` publish (`:260`) — **with no test file** — imported by `fleet.ts:90`, `sandbox-teardown.ts:43`, `sandbox-reap.ts:36`, `qds-cost.ts:46`, so it runs on every destructive verb. `catch { return false }` at `:262` silently downgrades a broken migration to "use the legacy path". Add `tests/scripts/cost-ledger-opts.test.ts`: concurrent migration (one wins, no clobber), stale-lock reclaim, and a `VACUUM INTO` failure falling back cleanly without leaving `*.migrating.*.tmp`.

- [ ] **Step 8: Verify and commit**

```bash
bun test && bunx tsc --noEmit && bunx @biomejs/biome check
git add -A
git commit -m "ci: typecheck cli-anything, un-swallow lint, flock reindex, gate roster, ratchet coverage, test the gate array and ledger migration (F011 F086 F089 F092 F097 F100 F073 F083 F068 F022)"
```

---

## WAVE 4 — Correctness and error handling

Small, independent fixes. Each is its own test plus commit; they can be batched into one or two PRs.

### Task 4.1: Report partial import failure honestly (F006)

**Files:**
- Modify: `src/hindsight/mulch-importer.ts:373`, `src/hindsight/mulch-importer.ts:88`
- Test: `tests/hindsight/mulch-importer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("an import where every file failed does not report ok", async () => {
  const env = await importMulch(allFilesFailing);
  expect(env.ok).toBe(false);
  expect(env.failures).toHaveLength(100);
});
```

- [ ] **Step 2: Run and watch it fail** — the envelope is `ok: true` unconditionally.

- [ ] **Step 3: Implement**

The success envelope is built with `ok: true` regardless of `failures.length`, and `scripts/import-mulch-expertise.ts:159` maps `ok` to the exit code — so an import where all 100 files hit `retain_failed` (`:337`) **exits 0 with a green envelope carrying 100 failures**. Set `ok: failures.length === 0`, or state the partial-success rule explicitly in the docstring and encode exactly that.

While in this file, address the `ponytail:` marker at `:88` (first line + 200 chars, so a multi-line wrapped error loses everything after line 1) — either lift the ceiling or give the marker an upgrade trigger.

- [ ] **Step 4: Run the test, commit**

```bash
git commit -am "fix(hindsight): report ok:false when the import had failures (F006)"
```

### Task 4.2: Fix the hindsight bridge probe (F008)

**Files:**
- Modify: `scripts/provision-hindsight-banks.ts:75`, `:77`, `:78`
- Test: `tests/scripts/provision-hindsight-banks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the bridge probe reaches SwarmClaw's actual port and method", async () => {
  const calls = await probeAgainstRecordingServer();
  expect(calls[0]).toMatchObject({ port: 3100, method: "POST", path: /\/api\/mcp-servers\/.+\/test/ });
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

The probe defaults to port **3000** (SwarmClaw's default is **3100**, `src/swarmclaw/index.ts:199`) and issues `GET` against routes that are **POST-only** (`index.ts:85-98`), so it returns `{registered:false}` unconditionally and `provisionBanks` short-circuits to `-32001` on every real invocation. `src/gate/assertions/p0-9-memory.ts:11` documents this defect and **routes around it** rather than fixing it.

Fix the port to 3100 and POST `/api/mcp-servers/{id}/test`, taking the id from `--mcp-server-id`/env since no listing route exists. Or delete `realBridgeProbe` and require the id. Add the bearer header from Task 2.1 — otherwise this now 401s. The 5 s fetch budget marker at `:77` goes away with Task 5.4's shared HTTP client.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "fix(hindsight): point the bridge probe at SwarmClaw's real port and method (F008)"
```

### Task 4.3: Measure recall latency host-side (F009)

**Files:**
- Modify: `src/hindsight/round-trip-verifier.ts:257`, `:320`
- Test: `tests/hindsight/round-trip-verifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("recall latency is measured host-side, not self-reported", async () => {
  const r = await roundTrip({ serverReports: 0, actualDelayMs: 50 });
  expect(r.recallMs).toBeGreaterThanOrEqual(50);
  expect(r.server_recall_ms).toBe(0);
});
```

- [ ] **Step 2: Run and watch it fail** — `recallMs` is 0.

- [ ] **Step 3: Implement**

`recallMs = res.durationMs` — the AC-7 slow-query verdict (`:320`) and every reported latency come from the **server's self-report**. A host-side `const start = Date.now()` exists in each block but is used only for error logs, and `client.ts:58-66`'s `mockBody` returns `durationMs: 0`, making the 5 s target **vacuously green**. Measure host-side with the `start` already in scope; keep the server figure as a separate `server_recall_ms` field.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "fix(hindsight): measure recall latency host-side (F009)"
```

### Task 4.4: One error idiom in the fleet CLI (F018, F019, F048, F050, F057)

**Files:**
- Modify: `scripts/fleet.ts:135`, `:1225`, `src/fleet/fanout-primitive.ts:333`, `scripts/fleet.ts:1532/1744/1755`, `scripts/pipeline-run.ts:649-658`, `scripts/pipeline-run-remote.ts:162`
- Test: `tests/fleet/cli.test.ts`, `tests/scripts/pipeline-run.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("a fan-out arm line lost to EPIPE exits 6, not 0", async () => { … });
test("an unopenable ledger during reconciliation is invalid(5), not a raw throw", async () => { … });
test("an unhandled pipeline-run flag throws instead of overwriting requestId", () => {
  expect(() => parseArgs(["--brand-new-flag", "x"])).toThrow(/unhandled flag/);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement each**

- **F018** — `errText` ends `return String(e)`, while `asUsage` (`:440`) and `report` (`:508`) both carry comments saying `String(e)` is unsafe on a null-prototype throw and deliberately pass the raw value to `redactSecrets`. `redactSecrets(errText(e))` is used at six sites including `ack-unwritable` (`:1666`), whose whole purpose is reporting a **live, billing** box whose runId could not be printed. Return the value uncoerced into `redactSecrets`, or delete `errText` and use the `(e ?? {}) as {message?}` idiom the other five sites already use. **One idiom.**
- **F019** — fan-out arm lines go through `emit(...)` with `failOnEpipe` defaulting to `false` (`:1225`), so `fleet fanout … | head -1` silently drops up to seven runIds of **live billing boxes** and still exits 0. The single-run path treats the identical hazard as exit 6 (`:1658`, `:1665`), and `src/fleet/verbs.ts:149` already declares 6 for fanout. Make it exit 6.
- **F048** — the F15 reconciliation loop calls `deps.ledgerFactory()` then `issueBudgetSnapshot(...)` inside a bare `try/finally` with no `catch`, so a `SQLITE_BUSY` or unopenable ledger escapes as a raw `Error` → CLI exit 1 (`transient`), while every sibling admission failure is `invalid(5, …)` and `dispatch.ts:1950-1956` converts the identical condition to `refuse(5, "admission-failed")`. Wrap in `catch` → `throw invalid(5, "admission-failed", …)`; drop the dead `:334` initialiser and declare `const`.
- **F050** — three spellings of "positive decimal flag": `--port` `/^[1-9]\d{0,4}$/` (`:1532`), `--n` `/^[1-9][0-9]*$/` (`:1744`), `--cap-micro-usd` `/^[1-9]\d*$/` (`:1755`), each with its own range check, `usageError`, and comment re-explaining that `Number()` accepts hex. One `parseDecimalFlag(name, raw, min, max, hint)` in this file; three call sites collapse to three lines.
- **F057** — nine flags are declared (`pipeline-run.ts:649-658`) but **eight `case`s** are written, with `default: requestId = value`. `pipeline-run-remote.ts:162` does the same with `boxSrc`. Adding a tenth flag without a case silently overwrites `requestId` — the correlation key the whole DF1.8 ladder is built on. Give both an explicit `case` per flag and a `default: throw new Error(\`unhandled flag ${flag}\`)`.

- [ ] **Step 4: Run the fleet suite (long), then commit**

```bash
bun test tests/fleet/ tests/scripts/
git commit -am "fix(cli): one error idiom, exit 6 on fanout EPIPE, typed admission failure, shared decimal parser, throwing flag default (F018 F019 F048 F050 F057)"
```

### Task 4.5: Type the store's throws and stop string-matching them (F039, F040)

**Files:**
- Modify: `src/providers/run-record.ts:572`, `:1294`, `:1421`, `src/providers/driver.ts:425`, `:573`
- Test: `tests/providers/run-record.test.ts`, `tests/providers/driver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a lock timeout carries code 'lock-timeout' and never triggers the rmSync arm", async () => {
  const e = await captureThrow(() => withLock(contendedPath, noop, { timeoutMs: 1 }));
  expect((e as { code?: string }).code).toBe("lock-timeout");
  expect(existsSync(store.path(runId))).toBe(true);
});
```

- [ ] **Step 2: Run and watch it fail** — the throw is a bare `Error`.

- [ ] **Step 3: Implement**

The store has exactly one typed error (`InvalidRunIdError:384`); schema rejections (`:572`), the partial-listing refusal (`:1294`) and the lock timeout (`:1421`) are all bare `Error`. That is why `driver.ts` string-matches (F039), why `harvest.ts:363` classifies on a re-attached fs `code`, and why `setRecord` (`:718`) collapses every store failure into one `record-write-failed`.

Attach a `code` to those throws (`"lock-timeout"`, `"schema-rejected"`, `"listing-partial"`) — no new class needed. Then make `isRecordLockTimeout` (`driver.ts:425`) test `e.code === "lock-timeout"` instead of a message prefix. Today, when the match fails, `provisionAdmittedRun` takes the `rmSync(store.path(...))` arm at `:573`, **deleting a record another writer may be about to rename back** — the code says so at `:406-411`, and pinning the string from both sides is mitigation, not a fix.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "fix(providers): give the run-record store typed error codes; stop string-matching lock timeouts (F039 F040)"
```

### Task 4.6: Close the remaining correctness gaps (F038, F045, F046, F066, F075)

**Files:**
- Modify: `src/phase-engine/phases/test-results.ts:231`, `:256`, `:171`
- Modify: `src/providers/quota.ts:112`
- Modify: `src/fleet/rank.ts:157`, `scripts/fleet.ts:2128-2161`
- Modify: `src/reverify/report.ts:319`
- Modify: `visualizer/server/db.ts:241`, `visualizer/src/components/SessionCard.vue:23`, `:221`

- [ ] **Step 1: Write the failing tests** (one per finding, in the matching suite)

```ts
test("abort signals the child directly, not a negative pid", async () => { … });
test("an absent quota-limits file emits an absent-config line", () => { … });
test("the CLI and rank.ts refuse the same step-output shape", () => { … });
test("a malformed reverify report line is skipped, not trusted", () => { … });
test("archive is reversible from the UI", async () => { … });
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement each**

- **F038** — the abort path calls `process.kill(-proc.pid, …)` at `:231` and `:256`, but the spawn at `:182` passes no detach option (the comment at `:171-176` says Bun has none), so the child is not a group leader and `-pid` is not its pgid. Normally ESRCH into the fallback; if some unrelated group holds that id, **the signal lands there**. `pipeline-run.ts:166` does the same call correctly because that spawn *is* `detached: true`. Delete the two negative-pid attempts and call `proc.kill(...)` directly; the comment already documents the limitation.
- **F045** — `loadCostConfig` (`cost-ledger.ts:516`) emits a structured `cost-config-absent-using-defaults` line naming the path, precisely because `--dir`/`$QDS_RUNS_DIR` can silently swap an operator's caps for built-ins. `loadQuotaLimits` has the identical hazard via `$QDS_QUOTA_LIMITS_FILE`, returns defaults **with no line at all**, and gates `createRun`'s headroom check. Copy the `emitGuarded` absent-config line into `quota.ts:112`. Leave the loaders separate — the missing signal is the defect.
- **F046** — step-output validation exists twice and has diverged: `rank.ts:157` refuses `testResults !== undefined && testsExecuted !== true` (absent included); the CLI at `scripts/fleet.ts:2153` refuses only `testsExecuted === false`. A payload passes the CLI's "shape-check at the trust boundary" (`:2120`) and is then refused by the library with a different code. The CLI also omits `rank.ts:143`'s `MAX_SAFE_INTEGER` bound. Export `assertStepOutputShape` from `rank.ts`, call it from the CLI loop, keep only the flag-naming wrapper, delete `fleet.ts:2128-2161`.
- **F066** — `out.push(JSON.parse(line) as ReverifyReport)` with no schema, while `preflight` then decides **whether to hand a credential to git** on `report.verdict`, `report.headSha`, `report.reverifyId`, `report.completedAt` (`src/pr/push.ts:240-299`). `sealReport` validates on the way *in* via `EvidenceSchema`; `repos.json`/`pipeline.json` are zod-parsed both ways. The one file authorizing an outward action is not. Define `ReverifyReportSchema` and `safeParse` each line in `readReports`, skipping non-conforming lines the way torn lines are skipped today.
- **F075** — `sessions()` hard-filters `WHERE COALESCE(archived,0)=0`; `archiveSession(requestId, archived=true)` supports `false` and the server honours it (`index.ts:352`), but the only caller passes no second argument (`SessionCard.vue:23`) and the `×` sits **inside the card's `<a>`** (`:221`). An accidental click is unrecoverable without hand-editing SQLite. Add `?archived=1` plus a "show archived" toggle, or make the archive an undo-able toast calling `archiveSession(id,false)`. **Do not ship a write with no inverse.**

- [ ] **Step 4: Run the affected suites, commit**

```bash
git commit -am "fix: direct child kill, absent-quota-config signal, unified step-output shape, schema'd reverify reports, reversible archive (F038 F045 F046 F066 F075)"
```

---

## WAVE 5 — One copy of each primitive

The audit's second debt shape: helpers that cross a module boundary get re-typed rather than imported, and the copies diverge. Each task here is *delete N, add 1*, and the test is that every former call site still passes.

### Task 5.1: `src/providers/fs-atomic.ts` (F033)

**Files:**
- Create: `src/providers/fs-atomic.ts`
- Modify: `src/fleet/fanout.ts:376`, `:241`, `src/fleet/fleet-lock.ts:820`, `src/providers/run-record.ts:2101`, `:1976`
- Test: `tests/providers/fs-atomic.test.ts`

- [ ] **Step 1: Write the test for the new leaf**

```ts
test("fsyncDir opens, fsyncs and closes the directory fd", async () => { … });
test("atomicReplaceFile leaves no temp on a failed rename", async () => { … });
test("assertDirMode0700 rejects a 0755 dir", async () => { … });
```

- [ ] **Step 2: Run and watch it fail** — the module does not exist.

- [ ] **Step 3: Implement**

`fsyncDir` is identical at `fanout.ts:376`, `fleet-lock.ts:820` and `run-record.ts:2101`; `rmQuiet` duplicates `run-record.ts:1976`; the mkdir-0700 → chmod → stat-verify block repeats in three places; `atomicReplace` (`fanout.ts:241`) mirrors run-record's. `fanout.ts:394` argues against sharing with `fleet-lock.ts` — but the code belongs in **neither**.

Add `src/providers/fs-atomic.ts` exporting `fsyncDir`, `rmQuiet`, `assertDirMode0700`, `atomicReplaceFile`. It depends on nothing, so no cycle. Repoint all five call sites and delete the copies. Also address the `run-record.ts:1807` marker while here (file fsynced, directory entry not) — `fsyncDir` is now one import away.

- [ ] **Step 4: Run the full providers + fleet suites**

Run: `bun test tests/providers/ tests/fleet/`
Expected: PASS, no message changes.

- [ ] **Step 5: Commit**

```bash
git add src/providers/fs-atomic.ts src/fleet/ src/providers/ tests/providers/fs-atomic.test.ts
git commit -m "refactor: one fs-atomic leaf for fsyncDir/rmQuiet/atomicReplace/mode-0700 (F033)"
```

### Task 5.2: `src/providers/path-guard.ts` and one `shellQuote` (F034, F017)

**Files:**
- Create: `src/providers/path-guard.ts`
- Modify: `src/providers/credentials.ts:366`, `driver.ts:1092`, `harvest.ts:273`, `exedev/fill.ts:98`, `exedev/setup-gate.ts:135`, `exedev/driver.ts:604`
- Modify: `src/fleet/fanout-primitive.ts:755`, `:683`, `:697`, `scripts/pipeline-run-remote.ts:50`, `tests/fleet/patterns.test.ts:120`
- Test: `tests/providers/path-guard.test.ts`

- [ ] **Step 1: Write the test that pins the strictest rule**

```ts
test.each(["a//b", "", "../x", "a\nb", "-flag"])("assertPlainBoxPath rejects %p", (p) => {
  expect(() => assertPlainBoxPath("workdir", p)).toThrow();
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement the path guard (F034)**

Six copies of the shell-safe box-path validator: the four that cite each other (`credentials.ts:366` `assertEnvFileSafe`, `driver.ts:1092` `assertShellSafePath`, `harvest.ts:273`, `exedev/fill.ts:98` `assertWorkdirSafe`) plus two that cite nothing (`exedev/setup-gate.ts:135` `assertPathSafe`, `exedev/driver.ts:604` `assertBoxPathSafe`). **Already diverged:** among the four that cite each other only `assertWorkdirSafe` rejects empty interior segments, so the other three accept `a//b` — while `assertBoxPathSafe`, which none of them cite, independently rejects it. Each throws a different error class.

One exported `assertPlainBoxPath(label, value)` taking the **strictest** rule, in a leaf both already import (`step-log.ts` or a 15-line `path-guard.ts`). Each caller keeps its own catch-and-reclassify so error classes stay stable.

- [ ] **Step 4: Implement one `shellQuote` (F017)**

`shellQuote` in `fanout-primitive.ts:755` is byte-identical to `shQuote` (`exedev/transport.ts:83`), to `shellQuote` (`scripts/pipeline-run-remote.ts:50`) and to a fourth copy in `tests/fleet/patterns.test.ts:120` — four hand-written copies differing only in name. It builds `sh -c` strings at `:683`/`:697`, while `src/fleet/dispatch.ts:63-66` states the DoD as "no substrate command string under `src/fleet/`" and re-exports `fakeGate` to honour it. This file breaks it. Not exploitable today (the path is a constant) — which is exactly when the third copy rots.

Export `shellQuote` from `exedev/transport.ts` and import it at both other sites. Move the two race probes behind `readBoxFile(driver, vm, path, deadlineMs)` in the providers layer, restoring the `src/fleet/` DoD.

- [ ] **Step 5: Run providers + fleet, commit**

```bash
git commit -am "refactor: one box-path validator and one shellQuote (F034 F017)"
```

### Task 5.3: `scripts/lib/kill-tree.ts` and detached spawns (F024, F023, F064)

**Files:**
- Create: `scripts/lib/kill-tree.ts`
- Modify: `scripts/lib/coms-smoke-helpers.ts:178`, `scripts/pipeline-run.ts:162`, `cli-anything/src/runner.ts:96`, `scripts/lib/mcp-stdio-client.ts:67`, `:189`, `:203`, `src/reverify/worktree.ts:257`, `:261`
- Test: move `tests/scripts/coms-smoke-helpers.test.ts:434`'s cases to `tests/scripts/kill-tree.test.ts`

- [ ] **Step 1: Move the existing tests to the new module's suite, watch them fail.**

- [ ] **Step 2: Implement F024**

Six process-tree-kill helpers with **four** escalation semantics: `coms-smoke-helpers.ts:178` (signal param, taskkill, fallback), `cli-anything/src/runner.ts:96` (SIGKILL only), `scripts/pipeline-run.ts:162` (inline, negative-pid only, no win32), `src/providers/fake-driver.ts:442` (returns a closure), `cli-anything/src/watchdog.ts:324` (graceful escalation), `mcp-stdio-client.ts:189` (direct child). `runner.ts:96` claims it exists so the team path "reuses the same primitive" — the mandate held inside one package.

Promote the **tested** version (`tests/scripts/coms-smoke-helpers.test.ts:434`) to `scripts/lib/kill-tree.ts`; repoint `pipeline-run.ts` and `runner.ts`. **Leave `watchdog.ts` and `fake-driver.ts`** — different contracts.

- [ ] **Step 3: Implement F023**

`scripts/lib/mcp-stdio-client.ts` spawns at `:67` without `detached`, and `close()` kills the direct child only. The comment at `:190` says the child "is reaping its own LSP grandchildren" — but the 2 s SIGKILL escalation at `:203` fires **precisely when it is not**, and a SIGKILLed parent reaps nothing. Every `lsp-verify`/`pi-lens-verify` run that escalates leaks language servers. Set `detached: true` at `:67` and route the escalation through the shared `killTree`.

- [ ] **Step 4: Implement F064**

`withGuards` (`src/reverify/worktree.ts:261`) snapshots `descendants(table, process.pid)` at trip time and SIGKILLs them 5 s later. The `ponytail:` marker at `:257` covers pid recycling but **not siblings**: in a long-lived host (the fleet daemon, a second concurrent `reverify`, a spawned MCP transport) an RSS or wall-clock trip on one run kills unrelated children of the same parent. Spawn the verify body's children `detached: true` and sweep the group, or thread the pids this `withGuards` actually launched into `descendants()`.

- [ ] **Step 5: Verify no leaked processes**

```bash
bun test tests/scripts/kill-tree.test.ts tests/reverify/
ps -o pid,ppid,command | grep -c '[l]sp'    # before/after an lsp-verify run
```

- [ ] **Step 6: Commit**

```bash
git commit -am "refactor: one killTree; detach the MCP stdio child; scope the reverify guard sweep (F024 F023 F064)"
```

### Task 5.4: `src/lib/http.ts` and `src/lib/file-lock.ts` (F063, F062)

**Files:**
- Create: `src/lib/http.ts`, `src/lib/file-lock.ts`
- Modify: `src/pr/github.ts:90`, `src/hindsight/client.ts:279`, `src/gate/assertions/p0-7-mcp-bridge.ts:107`, `scripts/provision-hindsight-banks.ts:78`
- Modify: `src/reverify/approval.ts:87`, `src/hindsight/bank-provisioner.ts:161`
- Test: `tests/lib/http.test.ts`, `tests/lib/file-lock.test.ts`

- [ ] **Step 1: Write the tests**

```ts
test("request retries once on 429 honouring retry-after", async () => { … });
test("a timeout maps to the caller's error class", async () => { … });
test("two blocking acquirers serialize; the loser does not steal a live lock", async () => { … });
test("a stale lock is stolen by rename-to-claim with content re-verification", async () => { … });
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement F063**

Four hand-rolled `fetch` wrappers with four contracts: `github.ts#request` (30 s, one retry on 5xx/429 with `retry-after`, throws `GitHubApiError`), `client.ts:279` (per-op timeouts, no retry, maps abort→408), `p0-7-mcp-bridge.ts:107` (10 s, never throws, returns `{status:0}`, **sends no auth header**), `provision-hindsight-banks.ts:78` (a fifth AbortController, 5 s). Transient-failure policy differs per module for the same class of call.

Lift `github.ts#request` into `src/lib/http.ts` parameterised on `{timeoutMs, retryOn, headers, errorClass}` and migrate the others as touched. **At minimum give `p0-7#postJson` the bearer header** — after Task 2.1 it will 401 against an authenticated SwarmClaw.

- [ ] **Step 4: Implement F062**

Two independently written O_EXCL locks: `withApprovalLock` writes `pid:nonce`, polls to a 5 s deadline, and steals via an **atomic rename-to-claim with content re-verification**; `acquireLock` (`hindsight/bank-provisioner.ts:161`) writes a bare pid, never blocks, and steals with a plain `unlinkSync` on a pid-or-mtime test — **the exact read-then-delete race the approval version's comments (`:121-126`) explain is unsafe**. The hardening landed in one.

Move the approval implementation to `src/lib/file-lock.ts` with a `block` option; keep both callers' timeout policies as arguments.

- [ ] **Step 5: Run, commit**

```bash
git add src/lib/ src/pr/ src/hindsight/ src/gate/ src/reverify/ scripts/ tests/lib/
git commit -m "refactor: one http client and one hardened file lock (F063 F062)"
```

### Task 5.5: One bounded child-output reader (F036, F037)

**Files:**
- Create: `src/providers/bounded-exec.ts`
- Modify: `src/providers/exedev/transport.ts:74`, `src/providers/fake-driver.ts:376`, `src/providers/harvest.ts:198`, `:489`, `src/pr/github.ts:193`, `src/reverify/worktree.ts:58`, `src/phase-engine/gates/command-gate.ts:86`, `src/phase-engine/roster/validate.ts:614`
- Test: `tests/providers/bounded-exec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a child emitting 100 MB is killed at the cap and returns a truncation marker", async () => {
  const r = await boundedExec(["bash","-c","yes | head -c 100000000"], { maxBytes: 1 << 20 });
  expect(r.text.length).toBeLessThanOrEqual((1 << 20) + 64);
  expect(r.truncated).toBe(true);
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

Seven spawn sites read child output with `new Response(proc.stdout).text()` and **no size ceiling**. `harvest.ts:52` caps bundles at 512 MiB and `:491` explicitly parks the gap — but `exec`, the primitive every gate assertion and setup step uses, has none. **Timeouts bound time, not bytes.**

One shared bounded reader — chunked, SIGKILL past `EXEC_MAX_OUTPUT_BYTES`, returns truncated text plus a marker — at all seven sites. F037 collapses into this: `commandGate` (`:86-87`) and `runPi` (`roster/validate.ts:614`) both buffer unbounded, while `test-results.ts:39,192` already established `MAX_CAPTURE_BYTES = 512 KiB` and a `readCapped` reader for exactly this — and gate output is truncated to 1000 chars anyway (`command-gate.ts:20`). Reuse `readCapped`'s semantics; export from the new leaf and have `test-results.ts` import it too, so the constant has one home. That also removes the hand-copied `512 * 1024` in `tests/phase-engine/test-results.test.ts:571`, which today desyncs silently on a source change.

Update the `harvest.ts:489` marker: it is this finding, and it is now closed.

- [ ] **Step 4: Run, commit**

```bash
git add src/providers/bounded-exec.ts src/ tests/providers/bounded-exec.test.ts
git commit -m "refactor: one bounded child-output reader across seven spawn sites (F036 F037)"
```

### Task 5.6: Visualizer shared lib — poller, drain, typed fetch (F070, F071, F072, F074)

**Files:**
- Create: `visualizer/src/lib/poll.ts`
- Modify: `visualizer/src/lib/api.ts:22`, `:57`, `:115`, `:119`, `:123`
- Modify: `visualizer/src/components/SessionsList.vue:49`, `SessionCard.vue:60-72`, `:82`, `:147`, `SessionTrace.vue:67-80`, `:102`
- Test: `visualizer/test/lib/poll.test.ts`, `visualizer/test/lib/api.test.ts`

- [ ] **Step 1: Write the tests**

```ts
test("usePoller backs off to MAX_POLL_MS after repeated failures and resets on success", () => { … });
test("drainEvents stops at maxPages and returns the advanced cursor", async () => { … });
test("asArray throws a named error when the wire sends a non-array", () => { … });
```

These land inside `src/lib/**`, which is already inside the existing coverage gate — that is the whole point of the extraction (F073).

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement F070**

`POLL_MS`/`MAX_POLL_MS`/`fails`/`startPolling`/`stopPolling` and the identical backoff expression appear verbatim in `SessionsList.vue:49`, `SessionCard.vue:82` and `SessionTrace.vue:102`, **comment included** — three places to fix the next polling bug. Extract `visualizer/src/lib/poll.ts` exporting a `usePoller(fn)` composable returning `{start, stop, onSuccess, onFailure}`; the three keep their own tick bodies.

- [ ] **Step 4: Implement F071**

`SessionCard.vue:60-72` and `SessionTrace.vue:67-80` are the same ~14 lines — same `MAX_PAGES` guard, same cursor advance, same oxlint suppression, same two-sentence comment with only "poll"/"tick" differing. Move to `api.ts` as `drainEvents(requestId, cursor, maxPages)` returning `{rows, cursor}`; both callers keep their own abort/ownership checks.

- [ ] **Step 5: Implement F072**

`fetchSessions` (`:57`), `fetchEnvelopes` (`:119`), `fetchGates` (`:123`) and `fetchPrompts` (`:115`) are bare `as Promise<T>` casts over `unknown`, while `fetchSession` (`:62-67`) and `fetchEvents` (`:82`) do default missing fields. Half the surface trusts the wire and half does not, with no stated rule — and components then add `?? []` guards for fields the server always sends (`SessionCard.vue:147`). Add one `asArray<T>(value, what)` helper, route the four array-returning fetchers through it, delete the now-redundant component guards.

- [ ] **Step 6: Implement F074**

`setToken` is called only from `test/lib/api.test.ts:54`, so `token` is always `null`, the `if (token && …)` branch at `:32` never fires, and the 8-line comment at `:11-18` describes a Bearer mechanism the SPA does not use — it relies entirely on the browser's cached Basic credential. **The test keeps the dead branch above the 90% floor.** Delete `setToken` and `token`, trim `authedFetch` to `fetch(url, {...init, signal})`, rewrite the comment to describe the Basic-only reality (`server/index.ts:444`).

- [ ] **Step 7: Verify and commit**

```bash
bun run --cwd visualizer typecheck && bun run --cwd visualizer lint && bun test tests/../visualizer/test && bun run --cwd visualizer check:lcov
git commit -am "refactor(visualizer): shared poller, drainEvents, typed array fetches; delete the dead token path (F070 F071 F072 F074)"
```

### Task 5.7: One run-root derivation (F056)

**Files:**
- Modify: `src/phase-engine/index.ts:19-24`, `scripts/pipeline-run.ts:709`, `src/phase-engine/trace/tracer.ts:292`, `src/phase-engine/phases/dispatch-task.ts:166`, `:238`
- Test: `tests/phase-engine/journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("every consumer derives the run root through runMarkerRoot", () => {
  expect(runMarkerRoot()).toBe(pipelineRunRoot());
  expect(runMarkerRoot()).toBe(tracerBoundaryRoot());
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

The run root is derived **four** ways: `runMarkerRoot()` (`journal.ts:38`), re-implemented inline at `pipeline-run.ts:709`, read with a third semantic at `tracer.ts:292` (absence = skip — that is F030), and a fourth at `dispatch-task.ts:166`/`:238` (`deps.rootDir ?? env ?? cwd`, duplicated verbatim seventy lines apart). `pipeline-run-remote.ts:207` then *writes* the variable at runtime. `index.ts:19-24` keeps `runMarkerRoot` off the public surface, which is what pushed the runner into re-implementing it.

Export `runMarkerRoot()` from `index.ts`, use it at `pipeline-run.ts:709` and `tracer.ts:292` (completing Task 2.5), and hoist the `dispatch-task.ts` expression to one `const`. Record Task 0.1 § Q4's answer in the exported function's docstring — it is the single place the truth now lives.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "refactor(phase-engine): one exported runMarkerRoot for all four consumers (F056)"
```

### Task 5.8: One provider error base (F041)

**Files:**
- Create or extend a leaf under `src/providers/` with `ProviderError`
- Modify: the eleven error classes and the three structural re-derivers (`teardown.ts:274`, `reaper.ts`, `sandbox-reap.ts:181`)
- Test: `tests/providers/errors.test.ts`

- [ ] **Step 1: Write the test that pins the contract**

```ts
test.each([CostLedgerError, CredentialLifecycleError, TeardownError /* … */])(
  "%p carries code and remediation and keeps its own name", (C) => {
    const e = new C("code", "msg", "fix it");
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.name).not.toBe("ProviderError");
    expect(e.code).toBe("code");
  });
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

Eleven hand-copied `{code, remediation}` error classes (`CostLedgerError`, `CredentialLifecycleError`, `ProvisionRefusedError`, `TeardownError`, `HarvestError`, `SweepError`, `QuotaLimitsError`, `ExeDevDriverError`, `VizError`, `FakeDriverError`, `OverBudgetError`), and consumers then re-derive the shape structurally anyway, each with its own fallbacks. One `ProviderError extends Error {code; remediation}` base in a leaf; the eleven become `extends ProviderError` keeping their `name`. **Every `instanceof` and `.code` read stays valid** — that is the acceptance criterion.

- [ ] **Step 4: Run the whole providers suite, commit**

```bash
git commit -am "refactor(providers): one ProviderError base under eleven classes (F041)"
```

---

## WAVE 6 — Split the orchestrators

Four ~300-line units instead of one 2,175-line one, **no behaviour change**. The ~580 message-substring assertions in `tests/fleet/` are the safety net that makes this cut cheap — they must pass unchanged.

### Task 6.1: Extract `DispatchContext` from `dispatch()` (F003)

**Files:**
- Modify: `src/fleet/dispatch.ts:803-2977`
- Test: `tests/fleet/` (existing, unchanged)

- [ ] **Step 1: Record the baseline**

```bash
bun test tests/fleet/ 2>&1 | tail -5    # note the pass count
```

- [ ] **Step 2: Introduce `DispatchContext` with no call-site changes**

`dispatch()` opens at `:803`; the next top-level `}` is `:2977` — one 2,175-line function holding ~12 closures over 9 mutable `ctx*` variables and the entire 11-step lifecycle. The closure capture set is the de-facto API, so every edit is a whole-function edit.

```ts
class DispatchContext {
  constructor(readonly deadlineMs: number) {}
  repoSlug?: string; issueId?: string; runId?: string; /* … the ctx* set */
  refuse(code: 1|2|3|4|5, kind: string, msg: string): never { … }
  remaining(): number { … }
  timedOut(): boolean { … }
}
```

Move the `ctx*` `let`s into fields and the four closures into methods, in one commit, with the body otherwise untouched.

- [ ] **Step 3: Run the fleet suite**

Expected: identical pass count, zero message changes.

- [ ] **Step 4: Lift the three steps, one commit each**

Mechanically, taking `ctx` as a parameter:

- step 3 — manifest + roster — `dispatch.ts:1529-1721`
- step 7 — key mint — `dispatch.ts:2313-2473`
- step 10 — expose — `dispatch.ts:2726-2911`

Run `bun test tests/fleet/` after each.

- [ ] **Step 5: Address the two markers this exposes**

`dispatch.ts:2008` marks a refusal unreachable from this call site with no upgrade trigger — give it one, or delete the arm. `dispatch.ts:1916`'s `ledger as CostLedger` cast is named by its own comment as the drift `LedgerLike` exists to prevent (Low) — remove the cast.

- [ ] **Step 6: Commit**

```bash
git commit -am "refactor(fleet): extract DispatchContext and lift steps 3, 7, 10 out of dispatch() (F003)"
```

### Task 6.2: Split `scripts/fleet.ts` `run()` into six verb functions (F015, F049)

**Files:**
- Modify: `scripts/fleet.ts:1159-2752`, `:1426`, `:1889-1892`, `:1911`, `:2171`, `:2212`, `:2353`
- Test: `tests/fleet/cli.test.ts` (existing)

- [ ] **Step 1: Record the baseline pass count.**

- [ ] **Step 2: Implement F015**

`run()` spans `:1159-2752` with all six verbs inline as sequential `if (verb === …)` blocks sharing `emit`/`note`/`finish` closures and hoisted `let`s (`lock`, `ledger`, `destructiveInFlight`, `signalListeners`) that only the last block uses but all can see. Keep `run()` as argv parse + sink construction; pass `{emit, note, finish, reportCompletion}` into six `runDispatch`/`runFanout`/… functions in the same file. `run()` already builds that object — this is the easier of the two splits.

- [ ] **Step 3: Implement F049**

`--dir` means the **runs** directory for `status`/`harvest`/`teardown` (`:1426`, `:2212`, `:2353`) and the **fan-outs** directory for `fanout`/`rank` (`:1911`, `:2171`). An operator using the flag consistently writes `fan-*.json` into the runs tree, which `reapRuns` then reports as `malformed_record_name` — the exact failure `:1890-1892` says it avoids. Add `--fanouts-dir` for `fanout`/`rank`; keep `--dir` meaning runs-dir everywhere; accept `--dir` on those two for one release with a stderr deprecation.

- [ ] **Step 4: Run the CLI suite, commit**

```bash
git commit -am "refactor(cli): six verb functions out of run(); disambiguate --dir from --fanouts-dir (F015 F049)"
```

### Task 6.3: Split the remaining god functions (F021, F025, F061, F081, F042)

**Files:**
- Modify: `scripts/cap-hit-demo.ts:227-1179`, `cli-anything/src/runner.ts:642-1426`, `src/phase-engine/phases/dispatch-task.ts:114-489`, `scripts/lsp-verify.ts:772-1410`, `scripts/coms-smoke-test.ts:673`, `src/providers/cost-ledger.ts:1442`
- Test: existing suites, plus new unit tests for the newly pure functions

- [ ] **Step 1: F021 — `runCapHitDemo` (953 lines, `:227-1179`)**

Fifteen numbered inline steps, local closures and nested cancel/race paths, drivable only end-to-end by a 1,094-line test. Cut along the seams the numbered comments already mark: option resolution (`:237-260`), the probe/reprobe pair, artifact assembly. Three module-level functions in the same file. While here, re-prefix the three `NOTE:`-shaped markers at `:163`, `:272`, `:1280` (they mark rationale, not a ceiling).

- [ ] **Step 2: F025 — `runTeamManifest` (785 lines, `:642-1426`)**

Spawn, env assembly, budget accounting, watchdog wiring, stdout capping, team-event parsing and the `finalize`/`close` state machine in one closure with `closed`/`lastExitCode`/`lastTermSignal` mutable across all of it. The reusable parts were already extracted; the god function is what remains. Extract the two seams that already have names — the `finalize(code, signal)` terminal classification, and the team-event/stdout ingest loop — into module-level functions over an explicit state object.

- [ ] **Step 3: F061 — the `dispatchTask` returned function (`:114-489`)**

It runs secret-env assembly, three refusal gates, roster load, dual gate, manifest derivation, prompt tracing, temp write, spawn with a 48-line inline event callback, kill-origin normalization, the test-command step, path validation, three-stage exit reconciliation (`:414-432`, `finalExitStatus` mutated under overlapping conditions) and output merge. Extract **two pure functions with their own tests**: `reconcileExitStatus({classified, runResultStatus, runFacts})` and `buildDispatchOutput(...)`. Leave the spawn/callback structure alone.

```ts
test.each(exitMatrix)("reconcileExitStatus(%j) → %s", (input, expected) => {
  expect(reconcileExitStatus(input)).toBe(expected);
});
```

- [ ] **Step 4: F081 — `lsp-verify main()` (639 lines, `:772-1410`)**

The pure helpers were properly extracted and are covered (`extractReportedLines:172`, `extractDiagnostics:277`, `parseBatchDiagnosticsText:340`, `flagExternal:410`, `scanArtifactsForSignal:437`); every AC's orchestration, fixture setup and teardown is one unbroken function. Split at the AC boundaries the comments already mark — one `async function acN(ctx)` per gate — making the `finally` at `:790` the only shared state. `coms-smoke-test.ts:673`'s `pathSocketComs` is the same shape at 634 lines; apply the same cut.

- [ ] **Step 5: F042 — `admitIssue`'s reservation loop**

`admitIssue` (`cost-ledger.ts:1442`) is ~470 lines mixing validation, canonicalisation, an out-of-lock prefetch, the transaction body, a deferred log queue and the emit. The reservation-row loop (`:1622-1755`) is the part with real branching — young/aged × resolves/throws/absent × closed/open — and cannot be exercised without a live handle and seeded rows. Extract the loop body as a **pure** `classifyReservation(row, record, graceCutoff)`. The transaction stays; the branch matrix becomes testable.

```ts
test.each(reservationMatrix)("classifyReservation(%j) → %s", (row, expected) => {
  expect(classifyReservation(row, record, cutoff)).toBe(expected);
});
```

- [ ] **Step 6: Run everything, commit per finding**

```bash
bun test
git commit -am "refactor: split cap-hit-demo, runTeamManifest, dispatchTask, lsp-verify main, admitIssue's reservation loop (F021 F025 F061 F081 F042)"
```

### Task 6.4: Prove the trace writer and reader agree (F053)

**Files:**
- Modify: `tests/phase-engine/trace/wiring.test.ts:653`
- Test: same

- [ ] **Step 1: Write the failing integration test**

```ts
test("pipeline-run's trace.db reads back through openTraceReader", async () => {
  const db = await runPipelineProducingTrace();
  const r = openTraceReader(db);
  expect(r.readSessions()).not.toHaveLength(0);
  expect(r.readEvents({ limit: 10 }).rows.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run and watch it fail (or pass — either is information).**

- [ ] **Step 3: Implement**

~1,400 LOC of `src/` has no non-test consumer: `openTraceReader`/`TraceReader` (389 LOC + a 1,124-line test) is imported only by tests; the whole gate library surface at `index.ts:59-71` has no production caller (only `commandGate` does, from `src/reverify/runner.ts:352`); `agents/retry.ts`, `agents/session.ts`, `agents/envelope-parse.ts` are not even exported. This is staged for later stories — **do not delete**. Add one integration test walking `pipeline-run.ts` → `openTraceReader` over the produced `trace.db`, extending `wiring.test.ts:653`, so writer/reader drift is caught by the suite.

- [ ] **Step 4: Commit**

```bash
git commit -am "test(phase-engine): pin writer/reader agreement over a real trace.db (F053)"
```

---

## WAVE 7 — Performance

Nothing here changes behaviour. Each task has a measurement before and after.

### Task 7.1: Stop the visualizer drowning on mount (F026, F027, F028, F076, F077)

**Files:**
- Modify: `visualizer/src/components/SessionCard.vue:89`, `:253`, `:60-72`, `SessionTrace.vue:81`, `PhaseDetail.vue:370`, `:524`, `:658`, `:665-693`
- Test: `visualizer/test/lib/` (the extracted logic from Task 5.6)

- [ ] **Step 1: Measure**

Open the list against a 200-session DB; record the network panel's concurrent request count and the main-thread time per poll tick.

- [ ] **Step 2: Implement F026**

`onMounted` calls `pull()` for every card unconditionally, and `pull` loops to `MAX_PAGES=50` × 1000 rows (`:60-72`). `/api/sessions` defaults to `limit=200` (`server/index.ts:271`) and `SessionsList.vue:84` renders every row — so opening the list fires **up to 200 concurrent event drains**. Gate the mount-time `pull()` on `status === 'running'` (finished runs already have their dots from the embedded `phases`), or drop the drain loop and cap the card at one page.

- [ ] **Step 3: Implement F027**

`v-for="dot in row.dots"` has no cap; `rows` (`:159-177`) emits one absolutely-positioned span per colored event — thousands per agent row × up to 200 cards. `PhaseDetail.vue:658` has the same unwindowed `v-for` over `phaseEvents`. Bucket dots by pixel column on the card (collapse same-1%-slot dots, keep worst status); slice `PhaseDetail` to the most recent N with a "show earlier" control. **No virtualization library needed.**

- [ ] **Step 4: Implement F028**

`events.value = [...events.value, ...fresh]` every 500 ms while a run is live — a full array copy that re-triggers `ownerStart` (`:223`), `toolTicks` (`:456`) and `PhaseDetail`'s three derived computeds (`PhaseDetail.vue:45-59`) to rescan the whole history twice a second. Use `events.value.push(...fresh); triggerRef(events)`, and precompute an events-by-phase `Map` once per tick, passing the slice to `PhaseDetail`.

- [ ] **Step 5: Implement F076**

`promptPanels` (`PhaseDetail.vue:370`) calls `renderMarkdown(text)` for every prompt the moment the fetch resolves, but `openPanels` is cleared on every phase change (`:310`) so **every panel starts collapsed**. Compiled prompts are the largest blobs in a trace — the server bounds the read for that reason (`db.ts:503-507`) — and `renderMarkdown` is a synchronous per-line regex scan. Drop `html` from `PromptPanel` and render in the template's open branch (`:524`), or memoize by `event_id` on first open.

- [ ] **Step 6: Implement F077**

`eventLabel(e)` runs twice per row (`PhaseDetail.vue:665`, `:666`), each re-`JSON.parse`ing via `parseToolCall`; the expanded panel calls `richCall(e)` **seven** separate times (`:680, 682, 683, 685, 688, 692, 693`), one of them inside `argsHtml(...)`. All of it re-runs whenever the 500 ms poll replaces the events array (which Task 7.1 Step 4 already stops doing). One `computed` mapping `phaseEvents` to `{event, label, call, durationMs}` rows; the template reads fields instead of calling parsers.

- [ ] **Step 7: Re-measure and record the delta in the commit body.**

```bash
git commit -am "perf(visualizer): gate mount-time drains, bucket dots, push-and-trigger, lazy prompt render, memoized event rows (F026 F027 F028 F076 F077)"
```

### Task 7.2: Memoize the trace writer's statements (F031)

**Files:**
- Modify: `src/phase-engine/trace/tracer.ts:578`, `:634`, `:678`, `:729`, `:755`, `:778`, `:805`, `:842`, `:911`, `close()`
- Test: `tests/phase-engine/trace/tracer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("close() finalizes every prepared statement before db.close()", () => {
  const t = openWriter(tmp); t.trace(evt); t.trace(evt); t.close();
  expect(preparedCount()).toBe(finalizedCount());
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

`trace()` calls `db.prepare(...)` inline on every event, as do the inline prepares in `recordGateResult` (`:634`), `recordEnvelope` (`:678`), `recordProcess` (`:729`), `endProcess` (`:755`), `processesEndAll` (`:778`), `startSession` (`:805`), `finishSession` (`:842`) and `upsertPhase` (`:911`). None are hoisted or finalized, and **bun:sqlite keeps unfinalized statements alive** — one handle per traced event, plus SQL compilation per write. Hoist the nine into lazily-created private fields prepared once after `openWriter`, and finalize them in `close()` before `db.close()`.

- [ ] **Step 4: Measure statements-per-1000-events before/after; commit.**

```bash
git commit -am "perf(trace): hoist and finalize the nine prepared statements (F031)"
```

### Task 7.3: Stop the blocking `ps` storm on the contended lock path (F047)

**Files:**
- Modify: `src/fleet/fleet-lock.ts:571`, `:148`, `:194`, `:431`
- Test: `tests/fleet/fleet-lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("one acquireReapMutex call spawns ps at most twice", async () => {
  const spawns = countExecFileSync(() => acquireReapMutex(contended));
  expect(spawns).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run and watch it fail** — measured ~50.

- [ ] **Step 3: Implement**

`acquireReapMutex` ticks every 10 ms to a 250 ms deadline; each tick runs `stealAbandonedReapMutex` → `stealJudgedReapMutex`, which on darwin does two synchronous `execFileSync("ps", …)` (`:148`, `:194`). Plus one per `ownFleetLockBody` call (`:569`) and one per `acquire` retry (`:431`) — ~50 blocking `fork`/`exec` on the contended path. Cache the observed identity per `(pid, raw-bytes)` for the duration of one `acquireReapMutex` call: the bytes are re-read each tick and **a live pid's start time cannot change**. Drops it to ~2 spawns.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "perf(fleet): cache pid identity within one acquireReapMutex call (F047)"
```

### Task 7.4: Memoize the roster probes across calls (F052, F051)

**Files:**
- Modify: `src/phase-engine/roster/validate.ts:915-925`, `:883`, `:959`, `src/phase-engine/phases/dispatch-task.ts:184`
- Test: `tests/phase-engine/roster/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("three dispatch_task phases probe the pi catalog once", async () => {
  const probes = countProbes(() => runManifestWithThreeDispatchTasks());
  expect(probes).toBe(1);
});

test("gate records carry the run's real requestId", async () => {
  const recs = await dispatchAndReadRoleRecords({ requestId: "req-42" });
  expect(recs.every(r => r.requestId === "req-42")).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement F052**

`validateRoster` memoizes the pi-catalog and provider probes **within one call** (`:915-925`), not across calls, and `dispatchTask` invokes it per phase. A three-`dispatch_task` manifest spawns `pi --list-models` three times and hits the provider endpoint three times; `:164` acknowledges the ~180 s cost. The rate tables *are* process-memoized (`:423`) — the probes are the outlier. Add a process-level memo for `probePiCatalog`/`probeProviderModels` keyed on provider, with a `resetRateSources`-style reset for the resident case.

- [ ] **Step 4: Implement F051**

`dispatchTask` calls `validateRoster(roster, deps.rosterValidateDeps)` with **no `requestId`**, so `validate.ts:883` mints `crypto.randomUUID()` and stamps that fabricated id onto every `RoleRecord` (`:959`) — while the run's real `requestId` is already in scope at `:117`. Every gate record from a dispatch is uncorrelatable to its run: the end-to-end key §5.2 names.

```ts
validateRoster(roster, { ...deps.rosterValidateDeps, requestId })
```

- [ ] **Step 5: Run, commit**

```bash
git commit -am "perf(roster): process-memoize the probes; stamp the real requestId on role records (F052 F051)"
```

### Task 7.5: Stop reading bytes to validate a path, and stop the reports piling up (F060, F043, F044, F069)

**Files:**
- Modify: `src/phase-engine/phases/dispatch-task.ts:597`, `src/phase-engine/manifest.ts:263-296`
- Modify: `src/providers/reaper.ts:826`, `:266`
- Modify: `scripts/sandbox-reap.ts:157`
- Modify: `src/gate/assertions/p0-7-mcp-bridge.ts:177`, `:181`, `src/swarmclaw/routes/mcp-servers.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("validateArtifacts does not read the file body", async () => { … });
test("sweep keeps at most REAP_HISTORY_MAX_REPORTS reports", async () => { … });
test("a dry-run sandbox-reap creates no cost-ledger.db", async () => { … });
test("the p0-7 probe deletes its registered server in a finally", async () => { … });
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement F060**

`validateArtifacts` calls `readArtifactBeneathRoot(...)` purely for its throw and discards the result — but that helper does the hardened walk **and** a `readFileSync` up to `MANIFEST_MAX_BYTES` = 1 MiB (`manifest.ts:296,247`). The comment at `:590` says "the read IS the validation"; in fact the realpath/beneath-root/fd checks (`manifest.ts:263-286`) complete **before any byte is read**. Split into `resolveArtifactBeneathRoot` (walk + fstat + ceiling, returns the verified fd) and a thin reader; call the former here.

- [ ] **Step 4: Implement F043**

`sweep` writes one pretty-printed report per invocation in **both** dry-run and apply mode — one row per VM + key + record — and nothing ever deletes one. `countReapBlocked` (`:266`) then `readdirSync`+`statSync`s the whole directory each sweep before slicing to the newest 200: read cost grows with total history for 200 files of use. After the successful write, unlink everything below `REAP_HISTORY_MAX_REPORTS`; the sorted list is already computed in `countReapBlocked`.

- [ ] **Step 5: Implement F044**

The `CostLedger` is constructed inline in the `sweep(...)` argument list **unconditionally**, including on the default dry-run path. The constructor mkdirs, chmods and opens (creates) `cost-ledger.db` + WAL — so "classify the fleet, delete nothing" leaves new files behind — and there is no `.close()` on any path, unlike `sandbox-teardown.ts:324` and `qds-cost.ts:350`. Hoist to a `let ledger` built only when `parsed.yes`, and `close()` in a `finally` around `sweep`.

- [ ] **Step 6: Implement F069**

The p0-7 probe registers a uniquely-named MCP server every run, and the comment states SwarmClaw exposes **no listing and no delete route** — so nothing can reclaim it, and each leaked record holds a live subprocess until restart, against a 32-slot cap. The mitigation is documentation ("point this at a DISPOSABLE SwarmClaw"); the 429 handler at `:181` exists because the procedure gets forgotten. Add `DELETE /api/mcp-servers/{id}` (the store already has `release`/`shutdownAll`) and delete the probe in a `finally`. Until that lands, **fail loudly on the second run** rather than at slot 32.

- [ ] **Step 7: Run, commit**

```bash
git commit -am "perf/hygiene: validate artifacts without reading them; prune reap reports; no ledger on dry-run; reclaim the p0-7 probe (F060 F043 F044 F069)"
```

---

## WAVE 8 — Types, config, and the long tail

### Task 8.1: Reconcile the trace schema with its migrations (F054)

**Files:**
- Modify: `src/phase-engine/trace/schema.ts:32`, `:103`, `:124`, `migrations.ts:29`, `types.ts:395`, `tracer.ts:438`
- Test: `tests/phase-engine/trace/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a fresh DDL store and a fully migrated store have identical schemas", () => {
  expect(schemaOf(freshFromDDL())).toEqual(schemaOf(migratedFromV1()));
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

`SCHEMA_DDL` declares `archived INTEGER NOT NULL DEFAULT 0`; `MIGRATIONS` declares it **nullable** (`migrations.ts:29`), and `TraceSessionRow.archived` is typed `number | null` (`types.ts:395`) to paper over it. Six migrated columns were back-ported into the base DDL and DF1.8's three were not, while `idx_sessions_repo_request` (`schema.ts:124`) depends on that ordering. `schema.ts:103` also claims the index runs "in the same schema-init step", contradicting `tracer.ts:438`.

Make the two definitions agree, narrow the type once they do, and fix the contradicting comment.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "fix(trace): reconcile SCHEMA_DDL with MIGRATIONS and drop the papering type (F054)"
```

### Task 8.2: Parse at the trace reader boundary (F055)

**Files:**
- Modify: `src/phase-engine/trace/reader.ts:168`, `:200`, `:321`, `:371`, `:109`, `:134`, `:123`
- Test: `tests/phase-engine/trace/reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a drifted store with a NULL phase status is reported, not silently typed non-null", () => {
  expect(() => readPhases(driftedStore)).toThrow(/status/);
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement**

Every read casts through bun:sqlite's generic (`:168`, `:200`, `:321`, `:371`) — compile-time only, nothing validates the shape. `TracePhaseRow.status` is typed non-nullable and relies on a `NOT NULL DEFAULT 'fail'` a drifted store may not have; the `optionalColumn` drift tolerance (`:123`) exists precisely to read such stores. Add a narrow zod parse at the reader boundary for the three row shapes (four `.parse` calls), or at minimum widen `status`.

While here (Low): `hasColumn` uses `!cache.get(key)` at `:109` and `:134`, so a cached `false` re-runs `PRAGMA table_info` — eight per `readEvents` page on a drifted store. Use `cache.has(key)`.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "fix(trace): parse rows at the reader boundary; fix the hasColumn cache miss (F055)"
```

### Task 8.3: Narrow the vendor tool-argument boundary (F080)

**Files:**
- Modify: `pi-vs-claude-code-vendor/coms-net.ts:2244, 2245, 2282, 2356, 2361, 2461, 2462, 2503, 2554, 2586, 2593, 2781`, `coms.ts:2136, 2304, 2305, 2374, 2474`
- Test: `tests/vendor/coms-net.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a tool argument that skips sanitizePeerText is refused by the type-forced check", () => { … });
```

- [ ] **Step 2: Implement**

Issue #60 typed the *wire* boundary (`WireRecord`, `isWireRecord`, `sanitizeCard`) and left the *tool-argument* boundary untouched: 12 `(params as any)`/`(args as any)` reads in `coms-net.ts` and 5 in `coms.ts`. Some funnel through `sanitizePeerText`; **`coms.ts:2304` does not**. TypeBox-schema'd, so risk is low — but the file's own doctrine says a trust boundary reads as `unknown` until narrowed.

Narrow the handler signatures to `WireRecord` and let the compiler force the existing runtime checks — the move #60 already made for SSE. **Leave `httpFetch`'s `any` return (`:736`)**, deferred in DIVERGENCE.md.

While here (Low): `coms.ts:305,327,338` are three identical `try/catch(isDuplicateRegistration)` wrappers, a 5-line generic apart.

- [ ] **Step 3: Run, commit**

```bash
git commit -am "refactor(vendor): narrow the tool-argument boundary to WireRecord (F080)"
```

### Task 8.4: Structure the dispatch-task log lines (F059)

**Files:**
- Modify: `src/phase-engine/phases/dispatch-task.ts:157, 320, 369, 377, 399, 420, 486, 569, 574, 580, 584, 601`, `:485`, `:208`
- Test: `tests/phase-engine/phases/dispatch-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("every line dispatch-task writes to stderr is valid JSON", async () => {
  const lines = await captureStderr(() => runDispatchTaskWithDroppedArtifact());
  for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
});
```

- [ ] **Step 2: Implement**

The engine's contract is **one JSON object per line on stderr** (`phase.ts:158`, `journal-bridge.ts:36`), but `dispatch-task.ts` uses bare `console.warn`/`console.error` at twelve sites — interleaving unstructured lines into the stream a parser reads. Several report dropped artifacts and invalid runner verdicts. Route them through the in-scope `deps.tracer` as `type: "log"` events, or a small `log(line)` dep matching `phase.ts:105`.

The `:485` marker (warn-don't-throw on orphaned manifests) is one of these twelve — resolve it as part of the pass. Give the `:208` marker (the local driver branch ignores `project`) an upgrade trigger: "when a second driver lands".

- [ ] **Step 3: Run, commit**

```bash
git commit -am "fix(phase-engine): route dispatch-task's twelve console sites through the structured log (F059)"
```

### Task 8.5: Tighten root tsconfig; delete dead config and dead code (F103, F104, F078, F101, F088)

**Files:**
- Modify: `tsconfig.json:8`
- Delete: `config/rosters/df16-e2e.roster.yaml` (or move to `tests/fixtures/rosters/`)
- Modify: `visualizer/server/db.ts:52`, `:277`, `tests/phase-engine/trace/tracer.test.ts:19`, `cli-anything/src/index.ts:263`, `visualizer/server/index.ts`

- [ ] **Step 1: Implement F103**

The root project — 68k LOC of money- and containment-bearing code — enables `strict` + `noUncheckedIndexedAccess`. `visualizer/tsconfig.json:11-14` enables those **plus** `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. The read-only UI is typechecked more strictly than the control plane — and `noFallthroughCasesInSwitch` is a correctness flag on a codebase whose demonstrated failure mode (F057's missing `case`s, the unreachable exit-6 arm) is exactly branch drift. Add the correctness-relevant flags to the root `tsconfig.json`; `bunx tsc --noEmit` is already clean, so the delta is bounded and measurable in one run.

- [ ] **Step 2: Implement F104**

`config/rosters/df16-e2e.roster.yaml` has zero references from `src/`, `scripts/`, `tests/`, `cli-anything/` or CI — its only mentions are DF1.6 story prose and evidence JSON from a one-off manual run. It sits beside four rosters that *are* loaded, inside the directory `src/phase-engine/roster/schema.ts:328` reasons about as a trust boundary. Delete it, or move it under `tests/fixtures/rosters/` so `config/rosters/` means "config the product loads".

- [ ] **Step 3: Implement F078**

`phase_count` has no consumer outside `visualizer/test/routes.test.ts:114` — drop it from `SessionSummary` and the `Object.assign` at `db.ts:277`. **Keep `pipeline_name`** (removing it weakens `routes.test.ts:441`) but note at `db.ts:52` that it is served-but-unrendered, so the `DECLARED_OPTIONAL_COLUMN`/`hasColumn`/`optionalColumn` apparatus around it stops looking unmotivated.

- [ ] **Step 4: Implement F101**

`tests/phase-engine/trace/tracer.test.ts:19` says `// ponytail: src/ does not exist yet — this import fails red as expected`, while `src/phase-engine/trace/tracer.ts` exists and the import on the next line resolves. A leftover TDD red-phase note now **asserting something untrue about the tree**. Delete it, then audit the other 19 test markers for the same staleness — the sweep's value depends on a reader trusting every marker it finds.

- [ ] **Step 5: Implement F088**

`README.md:35-40` states that routine observability output is muted under `bun test`. It is not: `cli-anything/src/index.ts:263`'s `console.log(JSON.stringify(result))` is the CLI's stdout contract and tests invoke `main()` in-process, so full JSONL results with expanded `PATH` dumps land in test output — as do the visualizer's `viz_request` lines. `src/swarmclaw/log.ts:30` and `cli-anything/src/env.ts:18` are gated; these two sinks are not. Gate both on the same `NODE_ENV === "test" && !QDS_LOG_VERBOSE` predicate.

- [ ] **Step 6: Verify and commit**

```bash
bunx tsc --noEmit && bun test
git commit -am "chore: tighten root tsconfig, delete dead roster and phase_count, fix the stale marker, mute test-time log sinks (F103 F104 F078 F101 F088)"
```

### Task 8.6: The Low-severity sweep

**Files:** as listed per item.

- [ ] **Step 1: Delete `firebase-debug.log`**

14,920 bytes at the repo root, dated 2026-03-15, with no Firebase dependency, config or code anywhere in the tree. `.gitignore:5`'s `*.log` is why it has been invisible for five months rather than removed.

- [ ] **Step 2: Fleet and rank cleanups**

- `src/fleet/rank.ts:266` — unreachable branch (`arms.length === 0` is refused by `validateFanoutRecord`). Delete or assert.
- `src/fleet/rank.ts:220` — `async` function with no `await`.
- `src/fleet/status.ts:147` vs `scripts/fleet.ts:2252` — two `MAX_SKIPPED_ECHO` constants, 16 and 50, over the same list. One constant.
- `src/fleet/fanout-primitive.ts:793` — three no-op `as` casts on the **destructive** `disposeLosers` path. Delete. (`dispatch.ts:1916`'s `ledger as CostLedger` is handled in Task 6.1.)

- [ ] **Step 3: Trace and gate cleanups**

- `src/phase-engine/trace/schema.ts:40` `phases.owner` and `:53` `events.parent_id` — declared, read and typed but **never written**. Write them or drop them.
- `src/gate/verifier-child.ts:15` vs `p0-10-gitnexus.ts:21` — p0-10 re-creates `promisify(execFile)` instead of importing its sibling's `runVerifier`.
- `src/phase-engine/phases/dispatch-task.ts:72` — `_resetRunner` exported with no consumer.

- [ ] **Step 4: SwarmClaw and visualizer cleanups**

- `src/swarmclaw/store/mcp-store.ts:19` — `url` accepted and never read.
- `visualizer/server/bun-apis.ts:33` — pins `file:line` locations a test asserts **exactly**, so any edit above `index.ts:75` breaks CI; its own header already drifted (`auth.ts:76` is really `:56`). Assert on symbols, not line numbers.
- `visualizer/src/components/SessionTrace.vue:438` — the live-duration expression written seven times with three different fallbacks. One computed.

- [ ] **Step 5: Shell and marker cleanups**

- `scripts/build-image.ts:196` — `docker export ${cid}` interpolated unquoted into `bash -c`. `cid` is `docker create` output so it is not attacker-influenced, but it is the repo's one unvalidated shell interpolation. Quote it with the shared `shellQuote` from Task 5.2.
- `src/providers/credentials.ts:142` — the `envFile` knob on the production `MintOptions` type exists only for the fake substrate, per its own marker: a test seam in a shipped signature. Move it behind the deps object or accept it and give the marker a trigger.
- `cli-anything/src/watchdog.ts:138` — the Linux RSS sampler runs `ps -o pgid=,rss=,pcpu= -e` (whole process table, O(N)) every tick and filters client-side. Its marker already names the `pgrep -g` pre-filter; either take it or leave the marker, which is honest.

- [ ] **Step 6: Fix the ponytail ledger itself**

**Group 3 (10 markers)** — `cap-hit-demo.ts:163,272,1280`, `teardown.ts:358`, `dispatch-task.ts:67`, `test-results.ts:163,207,277`, `fanout-primitive.ts:806`, `dispatch.ts:1586` — mark a **rationale** (why a shape was chosen, a race closed, a cleanup guaranteed), not a ceiling accepted. Good comments, wrong prefix. They inflate the ledger by 36% and train the reader to skim `ponytail:`, which costs exactly when Group 2 needs reading. **Re-prefix them `NOTE:`; leave the text alone.**

**Group 2 (9 markers)** — ceiling named, **no upgrade trigger**. These are the ones that rot. Every one is either closed by a task above or needs a trigger written now:

| Marker | Disposition |
|--------|-------------|
| `install-gitnexus-plus.sh:112` | closed by Task 3.5 (F092) |
| `test-results.ts:171` | blocked, not rotting — `node:child_process` unusable under Bun; Task 4.6 (F038) fixes the other end |
| `harvest.ts:113` | keep — the entropy heuristic is the right call; add the trigger "when a secret list reaches this path" |
| `provision-hindsight-banks.ts:77` | closed by Tasks 4.2 + 5.4 |
| `credentials.ts:142` | Step 5 above |
| `mulch-importer.ts:88` | closed by Task 4.1 |
| `dispatch-task.ts:208` | Task 8.4 |
| `dispatch-task.ts:485` | Task 8.4 |
| `dispatch.ts:2008` | Task 6.1 |

**Group 4 (3 test markers pinning a *product* ceiling)** — the first pass scoped these out by fiat; the ceiling is in shipped code and the test is merely where it got written down:

- `tests/phase-engine/test-results.test.ts:553` — `runTestCommand` does not parse Go test output, so a Go repo's phase reports `testsExecuted: false` (fails closed). This is the **only** place in the repo that fact is written down. Move it into the source docstring and name when a Go parser lands.
- `tests/phase-engine/test-results.test.ts:571` — `MAX_CAPTURE_BYTES = 512 * 1024` hand-copied "from source". Import it (Task 5.5 gives it one home).
- `tests/fleet/cli.test.ts:2227` — the lock-retry probe cannot distinguish two attempts from one; on the same money-adjacent path F093 flags. Handled in Task 3.1.

- [ ] **Step 7: Verify and commit**

```bash
bun test && bunx tsc --noEmit && bunx @biomejs/biome check
grep -rnE '(#|//) ?ponytail:' --include='*.ts' --include='*.sh' | wc -l   # expect the ledger to shrink
git commit -am "chore: low-severity sweep and ponytail ledger hygiene (Lows + marker Groups 2/3/4)"
```

---

## WAVE 9 — Verify and close

### Task 9.1: Full-repo verification

- [ ] **Step 1: Run every gate**

```bash
bunx tsc --noEmit
bunx @biomejs/biome check
bun run typecheck:cli-anything
bun run --cwd visualizer typecheck && bun run --cwd visualizer lint
bun test                                   # expect exit 0, ~500 s
bun run --cwd visualizer check:lcov
bun run build:check
scripts/dev/check-defensive-programming.sh --base origin/main
```

Expected: all green. `bun test` green is the headline — it was red on `main` four runs out of four.

- [ ] **Step 2: Run the money and containment invariants ten times each**

```bash
for i in $(seq 1 10); do bun test tests/fleet/cli.test.ts -t "INV-2" || echo "FAIL $i"; done
```

- [ ] **Step 3: `detect_changes()` against `main`**

```
detect_changes({scope: "compare", base_ref: "main"})
```

Confirm the affected symbol set matches this plan's scope and nothing unexpected moved.

- [ ] **Step 4: Reindex**

```bash
bash scripts/install-gitnexus-plus.sh
```

Never a bare `gitnexus analyze`.

### Task 9.2: Re-audit and close the loop

- [ ] **Step 1: Re-run the audit's own measurements**

- `grep -rnE '(#|//) ?ponytail:'` — record the new ledger count and the Group 2/3 split.
- Largest-function scan — confirm `dispatch()`, `run()`, `runCapHitDemo()`, `runTeamManifest()` and `lsp-verify main()` are all under ~400 lines.
- Duplicate-primitive greps: `killTree`, `shellQuote`, `fsyncDir`, the box-path validator, `usdToMicros` — each should return one definition plus imports.

- [ ] **Step 2: Update `TECH_DEBT_AUDIT.md`**

Mark each finding closed with the commit that closed it. Do not delete rows — the audit is the record of what was true at `f9e828d`.

- [ ] **Step 3: File issues for anything deliberately not done**

Every deferral gets a `tech-debt`-labelled issue and a `ponytail:` marker **with an upgrade trigger**. The audit's own conclusion is that a ceiling with no trigger never gets revisited.

- [ ] **Step 4: Open the PR**

```bash
source ~/.config/ghswitch.sh && ghswitch biospark33
gh pr create --base main --title "tech-debt: close the 2026-08-28 audit" --body "…"
source ~/.config/ghswitch.sh && ghswitch i3creations
```

---

## Finding coverage map

Every finding in the audit, and the task that closes it.

| Wave | Task | Findings |
|------|------|----------|
| 0 | 0.1 | open questions Q1–Q11 |
| 0 | 0.2 | F016, F087, F085, F012, F090 |
| 1 | 1.1 | F001 |
| 1 | 1.2 | F004, F035 |
| 1 | 1.3 | F032, F091 |
| 2 | 2.1 | F002, F005 |
| 2 | 2.2 | F007 |
| 2 | 2.3 | F013, F014 |
| 2 | 2.4 | F020, F065, F058, F067, F079 |
| 2 | 2.5 | F030 |
| 3 | 3.1 | F093 |
| 3 | 3.2 | F010, F082 |
| 3 | 3.3 | F094, F095 |
| 3 | 3.4 | F096, F098, F099, F084, F102 |
| 3 | 3.5 | F011, F086, F089, F092, F097, F100, F073, F083, F068, F022 |
| 4 | 4.1 | F006 |
| 4 | 4.2 | F008 |
| 4 | 4.3 | F009 |
| 4 | 4.4 | F018, F019, F048, F050, F057 |
| 4 | 4.5 | F039, F040 |
| 4 | 4.6 | F038, F045, F046, F066, F075 |
| 5 | 5.1 | F033 |
| 5 | 5.2 | F034, F017 |
| 5 | 5.3 | F024, F023, F064 |
| 5 | 5.4 | F063, F062 |
| 5 | 5.5 | F036, F037 |
| 5 | 5.6 | F070, F071, F072, F074 |
| 5 | 5.7 | F056 |
| 5 | 5.8 | F041 |
| 6 | 6.1 | F003 |
| 6 | 6.2 | F015, F049 |
| 6 | 6.3 | F021, F025, F061, F081, F042 |
| 6 | 6.4 | F053 |
| 7 | 7.1 | F026, F027, F028, F076, F077 |
| 7 | 7.2 | F031 |
| 7 | 7.3 | F047 |
| 7 | 7.4 | F052, F051 |
| 7 | 7.5 | F060, F043, F044, F069 |
| 8 | 8.1 | F054 |
| 8 | 8.2 | F055 |
| 8 | 8.3 | F080 |
| 8 | 8.4 | F059 |
| 8 | 8.5 | F103, F104, F078, F101, F088 |
| 8 | 8.6 | all 21 Lows, ponytail marker Groups 2/3/4 |
| 9 | 9.1, 9.2 | verification and closure |

**104 tabled findings + 21 Lows = 125 rows, all assigned.** No finding is unclaimed.

## What this plan deliberately does not do

From the audit's "Things that look bad but are actually fine" — considered and **not** changed:

- The five `v-html` sinks in `PhaseDetail.vue`. Every path was traced; the escaping holds. F079 adds a second layer, not a fix. **Leave the "Safe:" comments in place** — they are why it is safe.
- SQL string interpolation in three modules. All charset-guarded, frozen-constant, or `?`-bound.
- The nine `parseArgs` functions across `scripts/` — thin wrappers over one shared `parseValueFlags`, 17 importers, one grammar, one test file. Consolidation done right.
- The five separate secret-redaction implementations. Different threat models; `harvest.ts:108`'s entropy heuristic deliberately has no secret list because the run key may never have been in that process's env.
- The vendor fork's manual-parity policy. Re-measured: ~12 duplicated lines remain between two 3,000-line transports. It is paying for itself.
- `biome.json:9` disabling `noExplicitAny`. Vendored files make a global rule noise; issue-tracked work (#60, F080) is the right mechanism.
- ~30 bare `catch {}` in the harness scripts — deliberate fail-open on teardown, each with a comment naming what is swallowed.
- 18 `test.todo` / 7 `test.skip` — all environment-gated, none ever reports as passing.
- `FileJournal.flush()`'s O(n²) rewrite, `withTimeout` abandoning the loser, `journal-bridge.ts:27`'s module-scope stderr handler, the ~580 message-substring assertions, tests opening raw `bun:sqlite` handles, `harness-notes.ts`, `tests/gitnexus/fixtures/swarmclaw.ts`. All correct calls with the reasoning already written down.
