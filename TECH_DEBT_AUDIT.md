# Tech Debt Audit — QDS-Factory

Generated: 2026-07-26 · Commit: `208b56c` · Branch: `main`
Scope: 30,524 LOC TypeScript across 73 files, 6 top-level modules. First run (no prior audit).

Tooling run: `bunx tsc --noEmit` (clean), `bunx @biomejs/biome check` (6 errors), `bun test` (582 pass / 3 skip / 2 fail), `git log` churn analysis over 6 months.

**All 28 findings are tracked as GitHub issues [#44–#71](https://github.com/biospark33/QDS-Factory/issues?q=is%3Aissue+label%3Atech-debt), labeled `tech-debt` + `severity:*`.** Finding ID `F0NN` maps to issue `#(43 + NN)` — F001→#44, F028→#71.

---

## Executive summary

1. **There is no CI.** `.github/workflows/` does not exist. A 587-test suite, a typecheck script, and a lint script exist and nothing runs them on any push or PR. Every quality signal in this repo is manual.
2. **The Phase-0 exit gate — the artifact that decides whether the project may advance — is 9 assertion modules deep and only 1 of them has a unit test.** `tests/gate/phase0-exit-gate.test.ts:29` imports from `p0-2-coms.ts` and nothing else. Three false-green bugs were already found in this logic by review; the untested modules are the ones that would hide the next three.
3. **The project's own documented reindex command breaks its own test suite.** `CLAUDE.md:6` / `AGENTS.md:6` tell you to run `node .gitnexus/run.cjs analyze`. That path skips the transient `.gitnexusignore` negation that `scripts/install-gitnexus-plus.sh:137` writes, so test fixtures never index and `tests/gitnexus/graph-queries.test.ts` dies in setup. This was reproduced in this session by following the docs.
4. **`tests/gitnexus/graph-queries.test.ts` (446 lines, 11 commits of churn) currently contributes zero assertions.** It throws at line 238 before any test runs, and Bun reports the whole file as one `(fail) (unnamed)`.
5. **6,262 lines across `coms.ts` + `coms-net.ts` are kept in deliberate manual parity.** 14 symbols are still duplicated after the `coms-core.ts` extraction. These are the two highest-churn files in the repo (37 and 33 commits). `DIVERGENCE.md` documents the burden honestly but does not reduce it.
6. **The sprint board reports `done` for stories whose DoD is unchecked.** P0.5 is `status: done` (`sprint-status.yaml:31`) with 12 unchecked / 6 checked DoD boxes. P0.9 is `done` with 11 unchecked. P1.6 and P1.7 both declare a dependency on P0.5.
7. **Zero human-facing documentation.** No `README.md`. `AGENTS.md` and `CLAUDE.md` are both 100% auto-generated GitNexus blocks. A new contributor has no entry point.
8. **57 environment variables are referenced in code; none are documented in a checked file.** No `.env.example`, no env table. Several gate the security posture (`SWARMCLAW_INTERNAL_SECRET`, `SWARMCLAW_COMMAND_ALLOWLIST`, `HINDSIGHT_BEARER_TOKEN`).
9. **The test suite emits raw JSONL observability logs and full `process.env` key dumps to stdout.** Locating the 2 failures required 11 separate bisecting runs because `grep fail` returns hundreds of unrelated log lines.
10. **`cli-anything/` is a package inside the repo that the root workspace does not claim.** `package.json:7` lists only `pi-vs-claude-code-vendor`. Result: a second `node_modules`, a third `bun.lock`, and a duplicate zod install that can silently drift from the root's.

---

## Architectural mental model

QDS-Factory is a **verification harness pretending to be a product**, and that framing explains most of its debt.

The shipped surface is small: `src/swarmclaw/` is a Bun HTTP server with in-memory agent and MCP-server registries plus a stdio↔HTTP MCP tool bridge; `src/hindsight/` is a typed client for an external Hindsight memory service plus bank-provisioning and Mulch import; `cli-anything/` is a manifest-driven multi-agent CLI runner. Around that core sits a much larger apparatus whose only job is to *prove the core works*: `scripts/lsp-verify.ts` (1,402 LOC), `scripts/coms-smoke-test.ts` (1,478 LOC), `scripts/pi-lens-verify.ts` (637 LOC), and `src/gate/` — a 9-module assertion runner that aggregates the other harnesses into one binary PASS/FAIL verdict for exiting Phase 0. `pi-vs-claude-code-vendor/` is a pinned fork of an upstream Pi extension (two transports, Unix socket and HTTP/SSE) that the harness drives.

Consequently the *evidence-producing* code is bigger, higher-churn, and less tested than the code it produces evidence about. The gate is the load-bearing artifact — it is what a human reads to decide "may we start Phase 1?" — and it is the least-covered module in the tree. That inversion is the single organising fact of this codebase's debt, and findings F001–F004 are all instances of it.

The build discipline is genuinely high inside individual files: `gate-runner.ts` reasons carefully about event-loop blocking (`:66`), timer leaks (`:285`), and vacuous-pass semantics (`:322`); `mcp-store.ts:60` documents its synchronous reserve/finalize race guard precisely. The debt is not sloppy code. It is **process debt** — nothing automatically enforces any of that care, and the bookkeeping that tracks whether work is finished has drifted from the work itself.

This model does not contradict the README, because there is no README.

---

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| F001 | Test debt | `.github/` (absent) | Critical | S | No CI workflow exists. `bun test`, `bunx tsc --noEmit`, and `biome check` are defined in `package.json:9-16` and run only when a human remembers. 43 merged PRs relied entirely on bot review + manual runs. | Add one `.github/workflows/ci.yml` running `bun install`, `bun run typecheck`, `bun run lint`, `bun test` on push + PR. Nothing else. |
| F002 | Test debt | `tests/gate/phase0-exit-gate.test.ts:29` | Critical | M | The only assertion module with unit tests is `p0-2-coms.ts`. `p0-1-env`, `p0-3-mixed-model`, `p0-4-guard`, `p0-5-pi-lens`, `p0-6-lsp`, `p0-7-mcp-bridge`, `p0-9-memory`, `p0-10-gitnexus`, and `verifier-child.ts` have none. These decide whether Phase 0 exits. | Export each module's pure predicate logic (as `p0-2-coms.ts` already did with `auditOqDecisions`) and unit-test the pass/fail/skip boundary per module. Start with `p0-7` and `p0-9` — both had review findings. |
| F003 | Documentation drift | `CLAUDE.md:6`, `AGENTS.md:6` | High | S | Both files instruct `node .gitnexus/run.cjs analyze` to refresh the index. That command does not create the transient `.gitnexusignore` negation, so GitNexus's `DEFAULT_IGNORE_LIST` filters `tests/`/`fixtures/` and the fixture symbol never indexes — breaking `tests/gitnexus/`. Reproduced this session. | Change the generated block to `bash scripts/install-gitnexus-plus.sh`. If the block is machine-written, add the override to the generator config so it survives regeneration. |
| F004 | Test debt | `tests/gitnexus/graph-queries.test.ts:238` | High | M | Throws in module setup when the fixture symbol is missing, collapsing all 446 lines into a single `(fail) (unnamed)`. Currently red on `main`. 11 commits of churn against a file that presently asserts nothing. | Either have the file self-provision the index (invoke the install script in `beforeAll`) or `test.skipIf(!indexed)` with a loud warning, so a missing index degrades to skip rather than a silent total blackout. |
| F005 | Architectural decay | `pi-vs-claude-code-vendor/coms.ts` (2,898 LOC), `coms-net.ts` (3,364 LOC) | High | L | 14 symbols (`nowIso`, `readCliFlags`, `findSystemPromptPath`, `readFrontmatterFromArgv`, `CliFlags`, `AgentCard`, `InboundContext`, `PendingReply`, `MAX_PROMPT_BYTES`, `MAX_RESPONSE_BYTES`, `MAX_RESPONSE_SCHEMA_BYTES`, `INIT_LATCH_TIMEOUT_MS`, `EXIT_DELIVER_SCRIPT`, `pendingExitDispatches`) remain duplicated across the two transports under a manual-parity rule (`DIVERGENCE.md:14`). Highest-churn files in the repo. | Continue the `coms-core.ts` extraction the same way it was started. The four pure functions (`nowIso`, `findSystemPromptPath`, `readFrontmatterFromArgv`, `readCliFlags`) and the four size caps are lift-and-shift with no transport coupling. Leave `pendingExitDispatches` (stateful, per-transport). |
| F006 | Documentation drift | repo root | High | S | No `README.md`. `AGENTS.md` and `CLAUDE.md` contain only the auto-generated `<!-- gitnexus:start -->…<!-- gitnexus:end -->` block — zero prose about what QDS-Factory is, how to run it, or how the modules relate. | Write a 40-line README: what it is, the six modules in one line each, `bun install` → `bun test`, and the gate invocation (`bun scripts/phase0-exit-gate.ts`). |
| F007 | Config debt | 57 vars across `src/`, `scripts/` | High | M | No `.env.example` and no env table anywhere in the repo. Security-relevant vars (`SWARMCLAW_INTERNAL_SECRET`, `SWARMCLAW_COMMAND_ALLOWLIST`, `SWARMCLAW_NPX_PACKAGE_ALLOWLIST`, `SWARMCLAW_ENV_ALLOWLIST`, `HINDSIGHT_BEARER_TOKEN`) are discoverable only by grep. | Add `.env.example` with all non-`FAKE_MCP_*` vars, each with a one-line comment and its default. `src/gate/assertions/p0-1-env.ts:27` already enumerates a subset — use it as the seed list. |
| F008 | Process / bookkeeping | `_bmad-output/sprint-artifacts/sprint-status.yaml:31` | High | S | P0.5 is `status: done` but `p0-5-*.md` has 12 unchecked DoD items against 6 checked. P0.9 (`:35`) is `done` with 11 unchecked. P1.6 and P1.7 (`:48`,`:49`) declare deps on P0.5. | Reconcile before any Phase-1 story starts: either check the boxes with evidence or downgrade the status. A dependency on a story whose DoD is 2/3 unchecked is not a satisfied dependency. |
| F009 | Test debt | `scripts/coms-smoke-test.ts` (1,478 LOC) | High | M | The largest untested file in the repo. 15 commits in 6 months. No test file references it. It owns the secret-redaction logic at `:120-136` — a security-relevant code path with zero coverage. | At minimum, unit-test the redaction helpers (`SECRET_VALUES` construction at `:120`, the `split/join` scrub at `:136`, `win32ShellArgs` at `:260`). Those are pure and trivially testable. |
| F010 | Observability | test suite stdout | Medium | S | `bun test` interleaves raw JSONL observability records and full `process.env` key dumps with test output. Isolating the 2 failures took 11 bisecting runs. | Gate the `log()` sink in `src/swarmclaw/mcp/stdio-transport.ts` on `process.env.NODE_ENV !== "test"` (or a `QDS_LOG_SILENT` flag the test setup sets). |
| F011 | Dependency debt | `package.json:7`, `cli-anything/package.json` | Medium | S | `cli-anything` is a real package (own `package.json`, `bin`, deps) not listed in the root `workspaces` array. Produces a second `node_modules/` and a third `bun.lock`. Both trees currently resolve zod 3.25.76 — nothing keeps them there. | Add `"cli-anything"` to `package.json:7` workspaces, delete `cli-anything/node_modules` and `cli-anything/bun.lock`, re-`bun install`. |
| F012 | Consistency rot | `scripts/pi-lens-verify.ts:70`, `scripts/lsp-verify.ts:181` | Medium | M | Two `resolvePiLens` functions with different signatures and different behaviour. `lsp-verify` honours `PI_LENS_ROOT`; `pi-lens-verify` does not. This divergence is the direct cause of gate clause 4 failing (`phase0-gate-report.md:90`). | Delete `pi-lens-verify.ts`'s wrapper and route it through the `lsp-verify` resolution order, which already delegates to `resolveGlobalPiLens()` as its last step. One resolver, one env contract. |
| F013 | Consistency rot | `scripts/import-mulch-expertise.ts:58`, `scripts/provision-hindsight-banks.ts:41`, `scripts/phase0-exit-gate.ts:75` | Medium | S | Three separate `parseArgs` implementations. All three already import the shared `parseValueFlags` from `scripts/lib/cli-args.ts` — the local wrappers are thin but divergent shells around it. | Fold the flag tables into a single call shape. The shared helper already owns the grammar; the wrappers should be data, not code. |
| F014 | Architectural decay | `src/hindsight/round-trip-verifier.ts:58`, `cli-anything/src/runner.ts:163` | Medium | S | Two `escapeRegex` implementations. | Move one to a shared util. Or use neither — both call sites can likely use `String.prototype.replaceAll` with a string needle. |
| F015 | Architectural decay | `scripts/coms-smoke-test.ts:390`, `cli-anything/src/runner.ts:278` | Medium | S | Two `killTree` implementations with different signatures (one takes a signal, one doesn't). Process-teardown logic that diverges is how zombie children happen. | Consolidate into one, with the signal parameter. |
| F016 | Architectural decay | `scripts/coms-smoke-test.ts:220` | Medium | S | Local `ulid()` duplicating the canonical `ulid()` exported from `pi-vs-claude-code-vendor/coms-core.ts:75` — which `DIVERGENCE.md` explicitly names as the shared home for exactly this helper. | Import from `coms-core.ts`. |
| F017 | Type debt | `pi-vs-claude-code-vendor/coms-net.ts` (76 sites), `coms.ts` (44 sites) | Medium | L | 120 of the repo's 186 `any`/`as any`/`as unknown as` occurrences live in the two vendored transports, concentrated on the envelope/response boundary (`coms.ts:140`, `:191-194`, `:1292`, `:1339`). This is the wire-protocol trust boundary. | Do not boil the ocean. Type `Envelope` and the RPC response shape properly (`coms.ts:1292` already has an `isValidEnvelope` type guard — make its output the real type). Leave the internal `(x as any).unref?.()` idioms alone. |
| F018 | Test debt | `src/gate/verifier-child.ts` (no test) | Medium | M | The child process that the gate spawns to run verifications has no test. If it mis-reports, the gate mis-reports. | Cover its stdout contract: valid JSON in → parsed result out; garbage in → fail, not crash. |
| F019 | Architectural decay | `cli-anything/src/runner.ts` (1,318 LOC) | Medium | L | God file with 20 top-level functions covering spawn, redaction, KMP boundary scanning, process teardown, and manifest execution. 16 commits of churn. | Split the redaction/KMP layer (`escapeRegex`, the boundary helper) out — it is pure and independently testable, and it is where the two prior security fixes landed (`967f47b`, `36b2eeb`). |
| F020 | Architectural decay | `scripts/lsp-verify.ts` (1,402 LOC), `scripts/pi-lens-verify.ts` (637 LOC) | Medium | M | Both carry a near-identical `record(c: Check)` harness scaffold (`:228` and `:188`) plus matching `Status`/`Check` types. The shared `scripts/lib/` dir exists and already holds `harness-notes.ts` (12 lines) and `pi-lens-harness.ts`. | Move the `Check`/`Status`/`record` scaffold into `scripts/lib/harness-notes.ts`, which is where it was clearly heading. |
| F021 | Test debt | `scripts/lib/*.ts` (4 files, 492 LOC) | Medium | M | No test file references `cli-args.ts`, `harness-notes.ts`, `mcp-stdio-client.ts`, or `pi-lens-harness.ts`. `mcp-stdio-client.ts` (219 LOC) is the MCP framing layer both verify harnesses depend on. | Test `parseValueFlags` (pure, 68 lines, trivial) and `mcp-stdio-client`'s frame parsing. |
| F022 | Test debt | `tests/pi-lens-verify.test.ts:57`, `tests/lsp-verify.test.ts:346` | Medium | S | Both suites `test.skip` their live tests when pi-lens is not resolvable. `tests/pi-lens-verify.test.ts` currently yields **0 pass / 1 skip** — the entire file is dark on this host and would be dark in CI too. | Acceptable pattern, but the skip must be loud. Print a `console.warn` naming the missing dependency, and once F001 lands, make CI provision pi-lens so at least one environment exercises them. |
| F023 | Performance | `scripts/lsp-verify.ts:58,649`, `scripts/coms-smoke-test.ts:60,294,330` | Medium | M | `spawnSync` on the harness hot path. `src/gate/gate-runner.ts:66` explicitly documents that a blocking spawn defeats the per-assertion timeout — and this was already fixed once as a CRITICAL in the gate. The same pattern survives in the harnesses the gate invokes. | Where these run under the gate, convert to async spawn. `p0-10-gitnexus.ts:29` already documents the correct pattern to copy. |
| F024 | Error handling | 40+ bare `catch {}` across `src/`, `scripts/` | Medium | M | e.g. `src/hindsight/bank-provisioner.ts:183,197,204,209,219,228` — six silent swallows in one file. Some are justified (`coms.ts:1650` unref best-effort); most in `bank-provisioner` and `mulch-importer` discard information about *why* provisioning failed. | Do not blanket-fix. Audit the ~12 in `bank-provisioner.ts` and `mulch-importer.ts` specifically — those are user-facing setup paths where a swallowed cause becomes an unfixable support ticket. |
| F025 | Lint | `src/gate/assertions/p0-7-mcp-bridge.ts:122-126` (+ 3 more) | Low | S | 6 `biome` errors, all `noUnusedTemplateLiteral` — backtick strings with no interpolation. `bun run lint` is currently red. | `bunx biome check --write`. Trivially fixable; matters only because it means lint has never been enforced (see F001). |
| F026 | Dependency debt | `pi-vs-claude-code-vendor/package.json:19` | Low | S | Declares `@mariozechner/pi-coding-agent` as both peer and dev dependency at `0.55.0`, ships its own `bun.lock`, and has no `node_modules/` — it resolves via root hoisting. The lockfile is decorative. | Either make it a real installed workspace member or drop its `bun.lock`. Right now the pin is unverifiable. |
| F027 | Documentation drift | `scripts/pi-lens-verify.ts:451` | Low | S | An inline `TODO(goal):` embedded inside a user-facing error string — it will be printed to operators. | Move the TODO to a comment; keep the error message operational. |
| F028 | Type debt | `src/gate/assertions/p0-7-mcp-bridge.ts:41,153`, `p0-10-gitnexus.ts:54` | Low | S | `json?: any`, `(t: any)`, `parseJson(): any` inside gate assertion modules — the code path that decides PASS/FAIL parses untyped JSON. | Narrow to `unknown` and validate with the zod already imported at `gate-runner.ts:22`. Small change, directly reduces false-green surface (see F002). |

**Counts:** 2 Critical · 7 High · 15 Medium · 4 Low.

---

## Top 5 — if you fix nothing else

### 1. F001 — Add CI (Small effort, largest payoff by an order of magnitude)

Every other finding in this document is a symptom of nothing enforcing anything. This is ~25 lines:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun test
```

Land F025 (6 lint errors) and F004 (gitnexus suite) first or CI is red on arrival. Consider `continue-on-error: true` on the lint step for one week, then remove it.

### 2. F002 + F028 — Unit-test the gate's own assertion logic

The gate is the project's release decision. Its verdict has already been wrong three times in ways review caught by hand. The fix pattern is proven in-repo: `p0-2-coms.ts` extracted `auditOqDecisions` as a pure function and gained 7 tests that caught two real regex bugs.

Apply the same shape to the remaining eight. Sketch for `p0-7-mcp-bridge.ts`:

```ts
// export the decision, not just the assertion
export function toolsPresent(body: unknown): { pass: boolean; detail: string } { … }

// tests/gate/p0-7-mcp-bridge.test.ts
test("missing tools array is a FAIL, not a skip", () => {
  expect(toolsPresent({}).pass).toBe(false);
});
test("empty tools array is a FAIL, not a vacuous pass", () => {
  expect(toolsPresent({ tools: [] }).pass).toBe(false);
});
```

The empty-array case is exactly the false-green class that `gate-runner.ts:322` already guards at the aggregate level but nothing guards per-assertion.

### 3. F003 + F004 — Make the reindex path correct and the gitnexus suite honest

Two edits:

- `CLAUDE.md:6` / `AGENTS.md:6`: replace `node .gitnexus/run.cjs analyze` with `bash scripts/install-gitnexus-plus.sh`. The current instruction actively breaks a test suite, and it is the first thing any agent reads on session start.
- `tests/gitnexus/graph-queries.test.ts:236`: replace the bare `throw` with a skip-and-warn so a stale index degrades to `(skip)` with a diagnostic instead of vaporising 446 lines of assertions into one anonymous failure.

### 4. F008 — Reconcile the board before Phase 1 starts

P0.5 and P0.9 are marked `done` with two-thirds of their DoD unchecked. P1.6 and P1.7 are queued behind P0.5. Either the boxes are stale (check them, cite the PR) or the stories are not done (downgrade to `in-review`). Both are cheap. Shipping Phase-1 work on top of an unverified dependency is not.

### 5. F005 — Finish the `coms-core.ts` extraction

The hard part is done — `coms-core.ts` exists, `tests/vendor/coms-core.test.ts` covers it, `DIVERGENCE.md` names it as the correct home, and the 3-way-merge rule protects it from re-vendoring. Fourteen symbols remain. Four are pure functions with no transport coupling:

```
nowIso                    coms.ts:264   coms-net.ts:302
findSystemPromptPath      coms.ts:812   coms-net.ts:389
readFrontmatterFromArgv   coms.ts:842   coms-net.ts:416
readCliFlags              coms.ts:327   coms-net.ts:589
```

Plus `MAX_PROMPT_BYTES`, `MAX_RESPONSE_BYTES`, `MAX_RESPONSE_SCHEMA_BYTES`, `INIT_LATCH_TIMEOUT_MS` — four constants already noted as mirrored. That is 8 of 14 as a mechanical lift with an existing test file to extend. Leave `pendingExitDispatches` and the transport-shaped types where they are.

---

## Quick wins

Low effort × Medium-or-higher severity:

- [ ] **F001** — Add `.github/workflows/ci.yml` (25 lines, above).
- [ ] **F025** — `bunx biome check --write` to clear the 6 lint errors.
- [ ] **F003** — Fix the reindex command in `CLAUDE.md:6` and `AGENTS.md:6`.
- [ ] **F006** — Write a 40-line `README.md`.
- [ ] **F007** — Add `.env.example`, seeded from `src/gate/assertions/p0-1-env.ts:27`.
- [ ] **F008** — Reconcile P0.5 / P0.9 board status against their DoD checkboxes.
- [ ] **F010** — Silence the observability sink under `NODE_ENV=test`.
- [ ] **F011** — Add `cli-anything` to root `workspaces`; drop its `node_modules` + `bun.lock`.
- [ ] **F016** — Import `ulid` from `coms-core.ts:75` in `coms-smoke-test.ts:220`.
- [ ] **F027** — Move the `TODO(goal)` out of the operator-facing error string.

---

## Things that look bad but are actually fine

Calls considered and deliberately not flagged:

- **`src/gate/gate-runner.ts:291-301` re-records every assertion as FAIL on budget expiry.** Looks like it clobbers already-passing results. It does not — `record()` at `:160` is write-once (`if (settled[index] === undefined)`). The re-record only fills unsettled slots. Correct as written.

- **`gate-runner.ts:232` builds a worker pool with `Array.from({length: …}, async () => …)` and a shared `cursor++`.** Looks like a data race. JS is single-threaded and `cursor++` is not split across an await point — the increment happens before the `await runOne(item)`. Safe.

- **`mcp-store.ts:60-77` does capacity + name checks without a lock.** Looks like a TOCTOU. The comment at `:59` is right: `reserve()` is fully synchronous with no await between the check and the insert, so the JS event loop *is* the lock. This is the correct pattern for single-process in-memory state, and the reserve/finalize/release split correctly covers the async spawn window.

- **~40 bare `catch {}` blocks.** I flagged only the `bank-provisioner`/`mulch-importer` cluster (F024). Most of the rest are `try { (timer as any).unref?.() } catch {}` (e.g. `coms.ts:1650`, `:1771`, `:2284`) — best-effort calls on a runtime-dependent API where "it didn't work" is the whole handling. Fixing those adds noise, not safety.

- **`tests/gitnexus/fixtures/swarmclaw.ts` is dead code by every static measure** — nothing imports it, nothing calls `registerSwarmClawAgent`. It is not dead: it exists specifically so `gitnexus analyze` has stable symbols to index and query against, independent of what the live tree contains. The comment at `:1-5` says so, and the `ponytail:` marker at `:5` flags it as deliberate. Leave it.

- **`pi-vs-claude-code-vendor/` has 120 `any` sites and would fail any strict-mode audit.** It is vendored third-party code under an explicit 3-way-merge rule (`DIVERGENCE.md:9`). Aggressively retyping it maximises future merge pain for minimal safety gain. F017 deliberately scopes to the envelope boundary only.

- **The heavy comment density (`gate-runner.ts` is ~40% prose, `install-gitnexus-plus.sh:122-152` has 30 lines of comment for 8 lines of shell).** This reads as over-documentation. It is not — these comments encode empirically-discovered failure modes ("Verified empirically: broken symlink → `[ -e ]`=false"). That is exactly the knowledge that gets re-broken when it is not written down.

- **`src/index.ts` is two lines re-exporting one symbol.** Looks like pointless indirection. It is the package entry point and costs nothing. YAGNI cuts both ways.

---

## Open questions for the maintainer

1. **Is the absence of CI deliberate?** Given the bot-review discipline visible in the git history (9 review rounds on PR #43 alone), it is possible CI was consciously deferred in favour of agent review. If so, F001 is still worth doing — bots review diffs, they do not run your test suite.

2. **Is `tests/gitnexus/graph-queries.test.ts` expected to be green on a developer machine, or is it a CI-only/provisioned-environment suite?** The answer changes whether F004's fix is "self-provision" or "skip loudly".

3. **P0.5 and P0.9 are `done` with most DoD boxes unchecked (F008) — is that stale bookkeeping or genuinely incomplete work?** The commit trail suggests real merged work; the checkboxes suggest otherwise. Only you know which artifact is lying.

4. **Is `pi-vs-claude-code-vendor` expected to re-sync from upstream `0ed11f44` ever again?** If yes, F017 (typing) and F005 (extraction) should stay conservative. If the fork is permanent, both become ordinary refactors and the ceiling on F005 disappears.

5. **`scripts/coms-smoke-test.ts` and `scripts/pi-lens-verify.ts` are both harnesses for stories now marked done. Are they living tools or one-shot evidence generators?** If one-shot, F009 (test the 1,478-LOC file) is wasted effort and the right move is to archive them. If living, they need the same coverage as `src/`.

6. **Are the `FAKE_MCP_*` env vars (22 of the 57) intended to stay test-only?** They are the largest single block of env sprawl. If they are strictly test fixtures, F007's `.env.example` should exclude them and say so.
