# Z5: Chassis fate — utilities to `src/lib/`, dormant server surface per DD-18

**Status:** DONE (2026-10-14) — branch `feature/z5-chassis-fate`, PR → dev
**Story Points:** 2
**Sprint:** v6a-Foundation (Wave 2 — Zeropoint macro-host epic, zero E21 gates, live tier: none, deps: none)

## Spec Reference

- **Charter:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — v6a table row Z5; §2.1 "In-repo chassis `src/swarmclaw/`" fact (utilities LOAD-BEARING, server surface orphan).
- **Decision register:** DD-18 (chassis fate: extract utilities; server surface dormant-retained pending ADR-2) and DD-14 (v6 namespace/story paths) in `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`.
- **Ancestry disposition:** DD-7's v5 "dormant-retained" premise is DEAD as a chassis-wide claim (ADR-1 ACCEPTED — zeropoint swarmclaw is awake as protocol orchestrator). Z5's "dormant" is the narrower in-repo sense only: the vendored server surface under `src/swarmclaw/` has zero production consumers *in this repo*. The log.ts docblock's dependency-direction rule (providers → log, never providers → transport) is carried verbatim to `src/lib/log.ts`. ADR-1 itself is a closed record — not touched.
- **Code facts:** R3 §6 (`_bmad-output/workflow-state/qds-sprint-planning/v6/research/R3-code-facts.md`) — file census and orphan confirmation, re-verified by grep this session.
- **Consumed unmodified:** `src/lib/http.ts` + `src/lib/file-lock.ts` (the established `src/lib/` home pattern); `oci/exedev/Dockerfile` COPY enumeration (read-only — both `src/lib/` and `src/swarmclaw/` are directory-level COPY entries, ~:277-355); `src/gate/assertions/p0-10-gitnexus.ts:27` (consumed read-only — see Technical Notes).

## User Story

**As** the factory maintainer, **I want** the load-bearing chassis utilities (`log`/`newRequestId`/`maskEnv`) to live in `src/lib/` where every consumer already sits, and the orphan server surface to be explicitly dormant rather than silently rotting, **so that** no factory module reaches into a vendored copy for plumbing and the ADR-2 query-surface question stays answerable without an archaeology dig.

## Overview

A mechanical extraction: `src/swarmclaw/log.ts` moves verbatim to `src/lib/log.ts`; `maskEnv` moves verbatim out of `src/swarmclaw/mcp/tool-bridge.ts` into `src/lib/mask-env.ts`. Every import path is rewritten (27 modules under `src/`, 8 under `scripts/`, 39 test files reference `swarmclaw/log` today). `src/swarmclaw/mcp/stdio-transport.ts` drops its transitional log re-export — hindsight's four modules + `scripts/provision-hindsight-banks.ts` import it only for that re-export, and six test files take `setLogSink`/`LogEntry` through it (`tests/hindsight/` ×5 + `tests/providers/run-record.test.ts`; import lines only). The server surface (`createServer`, `routes/*`, `store/*`, the `src/index.ts` re-export) is **retained byte-identical** behind a dormancy-guard fixture per DD-18. **What this does NOT deliver:** no behavior change in any moved symbol; no deletion or rewrite of the server surface; no decision on ADR-2; no cleanup of stdio-transport's INV-SC2/SC3 allowlist machinery; no new utility consumers.

## E2E Slice

**Demonstrable behavior:** Given the pre-move tree with a green suite (baseline pass-set captured per repo CLAUDE.md tee discipline); when the move lands, `bun test` exits 0 with the same assertion set — no deleted assertions, no new failures — and `bun test tests/swarmclaw/` still exercises the retained server surface through its existing fixture tests. `grep -r "swarmclaw/log" src scripts tests` returns zero files; `maskEnv` is imported only from `src/lib/mask-env.ts`; the new dormancy-guard test is green.

**Wiring closed:** On completion of this story, every production consumer of `log`/`newRequestId`/`maskEnv` resolves through `src/lib/` using only code merged by this story. **No stub, no `TODO: re-home later`, no compat shim.** The dormant surface is retained, not re-wired. The **schedule**, **fleet verbs**, **box image**, and **ADR-2 outcome** are out of scope by construction.

**Dependency edges (predecessors):** none — charter lists Z5 deps: none. Direct edge count zero.

> **Not an edge — Z4/M1.1:** the VPS deploy profile consumes `src/lib/` via the directory COPY that already exists; no coordination needed. **Not an edge — J1:** `src/judgment/client.ts` is in the import-rewrite set, but J1 owns no piece of the move.

## Acceptance Criteria

1. **(make-or-break) Pure move — byte-identical bodies.** Given `src/swarmclaw/log.ts` and the `maskEnv` block of `tool-bridge.ts`; when extracted to `src/lib/log.ts` / `src/lib/mask-env.ts`; then the diff on moved symbols is import-path lines ONLY, and the behavior-pinning tests (CC-9 log shape, INV-SC5 all-values-masked, INV-HM1 hindsight env diagnostics) pass with **unmodified assertion bodies** (their import lines may change).
   *Negative control: an implementation that "improves" while moving — new redaction heuristics in `maskEnv`, changed sink defaults, renamed `LogEntry` fields, a logger that crashes on closed stdout — breaks the pinned assertions and MUST fail this one.*
2. **Dormant retention of the server surface.** Given DD-18's disposition; when the story lands; then `src/swarmclaw/index.ts`, `routes/agents.ts`, `routes/mcp-servers.ts`, `store/agent-store.ts`, `store/mcp-store.ts`, and the `src/index.ts` re-export all still exist with behavior bodies untouched (import-path lines are the ONLY permitted diff in retained files).
   *Negative control: an implementation that deletes the subtree "because nothing imports it" MUST fail this one — DD-18 refuses deletion without a named restoration path, and the p0-10 gate's probe symbol lives here (Technical Notes).*
3. **Complete importer rewrite — no lingering path.** When a repo-wide grep runs for `swarmclaw/log` and for `maskEnv` imported from `tool-bridge`; then zero matches across `src/`, `scripts/`, `tests/`. All four hindsight modules + `provision-hindsight-banks.ts` import `src/lib/log` directly, as do the six re-export test consumers (`tests/hindsight/{bank-provisioning,bridge-round-trip,client,memory-round-trip,mulch-import}.test.ts`, `tests/providers/run-record.test.ts` — import lines only); `routes/mcp-servers.ts` imports `src/lib/mask-env`; `stdio-transport.ts` no longer re-exports the log trio.
   *Negative control: an implementation leaving a re-export shim at `src/swarmclaw/log.ts` (or on `tool-bridge`) so old paths keep resolving MUST fail this one — the two-path end-state is the exact outcome DD-18 shrinks away.*
4. **Dormancy-guard fixture.** Given the retained surface; when a new test runs; then it fails — naming the offending file paths in its failure message — if (a) any module outside `src/swarmclaw/` **other than the dormant re-export barrel `src/index.ts`** imports `createServer`/`routes/*`/`store/*`, or (b) any module anywhere imports a swarmclaw utility path (mechanically: AC3's two greps — `swarmclaw/log` anywhere, or `maskEnv` imported from `tool-bridge`). Green on the moved tree.
   *Carve-out rationale: `src/index.ts` sits outside `src/swarmclaw/` yet re-exports `createServer` by design (the restoration entry point, AC2) — a guard without that exemption is red on the mandated end-state tree.*
5. **Box-image neutrality.** When the story's diff is inspected; then `oci/exedev/Dockerfile`, `scripts/build-exedev-image.ts`, and `src/providers/exedev/driver.ts` pin constants are untouched — both source and destination directories are already directory-level COPY entries, so deriveBuildId inputs do not move and **no re-pin ritual is owed**. (The standing image-pin red is wave-0 ops and is not this story's to fix or worsen.)
   *Negative control: an implementation that edits the Dockerfile COPY enumeration for this move MUST fail — it would shift deriveBuildId for zero benefit.*
6. **Layer rule preserved.** Given the repo rule that `src/providers/` imports no tier-3 workspace code; when the rewrite lands; then `src/lib/log.ts` and `src/lib/mask-env.ts` import nothing (both moved units are dependency-free today — `log.ts` has zero imports; `maskEnv` is a pure function), so the move cannot create a cycle, and providers/judgment/fleet/hindsight import them from the sanctioned low tier (`src/lib/http.ts` precedent). GitNexus `impact()` ran on `log`/`setLogSink`/`maskEnv` before editing; `detect_changes()` ran before commit.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| `bun test` suite runs | in scope — the demonstration | full suite + `tests/swarmclaw/` | — |
| CI image-pin legs | out-of-scope by construction — no pin inputs touched | none (AC5 asserts the diff) | re-pin ritual stays wave-0 ops |
| Server surface lifecycle (boot/SIGTERM/routes) | out-of-scope — dormant-retained; exercised only by its retained tests | existing `tests/swarmclaw/` fixture | ADR-2 ACCEPT re-opens the query-surface question |
| ADR-2 outcome | out-of-scope — this story implements neither arm | none | ACCEPT → successor ADR/DD on the query surface; REJECT → closure note; both are named restoration-path events, not silent deletions |
| Cron / daemon for this surface | out-of-scope — none exists | — | none in v6.0 |
| New utility consumers (post-move) | out-of-scope for this story | — | they import `src/lib/{log,mask-env}` — enforced by the AC4 guard |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| Test suite | local `bun test` | green **before** this story starts; baseline pass-set captured to a tee'd log per repo CLAUDE.md |
| GitNexus standing index | local `.gitnexus/` | `impact()` on `log`/`setLogSink`/`maskEnv` returns the expected importer fan-out before any edit |

> No box, no LLM key, no Jev spend, no VPS, and no image re-pin are prerequisites of this story. Zero live-tier legs; zero agent spend.

## Technical Notes

- **Mechanical-move discipline:** `git mv` semantics for `log.ts`; bodies byte-identical; the ONLY non-import diffs permitted are the two deleted-from blocks (`src/swarmclaw/log.ts` removed outright; the `maskEnv` section removed from `tool-bridge.ts`). The import-rewrite set is enumerated at dev time by grep, not guessed — exact counts at spec time: 27 `src/` modules (providers ×15 incl. `exedev`, fleet ×8, audit ×2, judgment/client, reverify), 8 `scripts/`, 39 test files. Hindsight's four modules + `provision-hindsight-banks.ts` are a SEPARATE rewrite set — they take the log trio through `stdio-transport`'s re-export, not `swarmclaw/log` (AC3) — and `src/gate/` has zero log imports (comment references only).
- **Post-move shape (the DD-18 end-state):** after the rewrite, `src/swarmclaw/` holds ONLY the dormant server cluster — `index.ts`, `routes/`, `store/`, and the two `mcp/` files, whose remaining content (INV-SC2 command allowlist, INV-SC3 env isolation, tool bridge) is the retained surface's own plumbing. R3's "mcp/ is NOT orphan" classification is the PRE-move truth: hindsight reaches `mcp/` today solely for the log re-export and `maskEnv`; this extraction is what severs that coupling. Post-move, the ONLY module outside `src/swarmclaw/` referencing it is the dormant re-export barrel `src/index.ts` (the restoration entry point); zero other production modules import anything under `src/swarmclaw/`.
- **The surface is load-bearing twice — deletion is refused on two grounds:** (a) ADR-2's restoration path (an ACCEPT re-opens the query-surface question; the retained subtree + green fixture tests ARE the restoration); (b) `src/gate/assertions/p0-10-gitnexus.ts:27` uses `createServer` in `src/swarmclaw/index.ts` as the P0.11 sequencing gate's standing-index probe symbol — NET-NEW vs R3, flagged for the DD-18 register entry.
- **Region ownership on shared files:** `stdio-transport.ts` — its docblock's stated contract ("re-exports so existing consumers keep their import paths") is updated to record the re-export's removal; logic untouched. `tool-bridge.ts` — `maskEnv` section deleted; its `./stdio-transport` import splits (log/newRequestId re-pointed to `src/lib/log.ts`; the `StdioTransport` type stays). `src/index.ts` — NOT modified (dormant re-export retained as the restoration entry point).
- **Considered and rejected:** (a) *shim re-exports* — leaves two import paths forever and defeats AC3's negative control; (b) *grandfathering existing importers, rewriting only new code* — same two-path rot, larger long-term surface; (c) *deleting the server surface now* — refused by DD-18 while ADR-2 is PROPOSED, and it would break the p0-10 probe; revisit only through the named ADR path.
- **Dev rules (repo CLAUDE.md, binding):** GitNexus `impact()` before editing any symbol (these three have the repo's widest fan-out); `detect_changes()` before commit; never-edit list untouched (`AUDIT_HOPS`, `classifyRunExit`, `classifyDiffScope`, provider-layer import rules — the rewrite touches provider import *lines*, never the layer rule itself).

## Observability Contract

Log vocabulary unchanged: CC-9 `LogEntry` JSONL shape, `setLogSink` override semantics, and `QDS_LOG_VERBOSE`/NODE_ENV muting behavior are byte-identical — the existing log-shape tests pin them. **Absent, not 0:** this story emits no new metrics, events, or log fields. The dormancy guard's only output is a named test failure listing offending import paths.

## Files to Modify

- `src/lib/log.ts` — **new** (moved verbatim from `src/swarmclaw/log.ts`)
- `src/lib/mask-env.ts` — **new** (`maskEnv` moved verbatim from `tool-bridge.ts`)
- `src/swarmclaw/log.ts` — **deleted** (moved; no shim)
- `src/swarmclaw/mcp/tool-bridge.ts` — `maskEnv` section deleted; import added
- `src/swarmclaw/mcp/stdio-transport.ts` — transitional log re-export removed; own import re-pointed; docblock updated
- `src/swarmclaw/index.ts`, `routes/*`, `store/*`, `src/index.ts` — dormant-retained; **import-path lines only**, bodies untouched
- Import-rewrite set (representative, not exhaustive — enumerated at dev time by grep): `src/providers/*` (15 files), `src/fleet/*` (8), `src/audit/*` (2), `src/judgment/client.ts`, `src/reverify/*`, `src/hindsight/*` (4), `scripts/fleet.ts` + 7 scripts, 39 test files, plus the 6 re-export test consumers (`tests/hindsight/` ×5, `tests/providers/run-record.test.ts`) — **mechanical import-path rewrite only; no assertion bodies change**
- `tests/swarmclaw/dormancy.test.ts` — **new** (the AC4 guard)

The move is mechanical and enumerated at dev time; the listable OWNED set is the 9 items above plus the rewrite clause.

## Security Invariants

- **INV-SC5 (env masking):** `maskEnv` moves verbatim — every env value masked to `***`, key names visible, no heuristic matching. Pinned by the existing routes tests (INV-SC5) now importing from `src/lib/mask-env`.
- **INV-HM1 (hindsight env-only auth + masked diagnostics):** the masking call in `src/hindsight/client.ts:396` routes through the same function body at its new path; auth-fallback logic untouched.
- **CC-9 (structured JSONL logging):** `LogEntry` shape, sink override, and the providers → log dependency direction carried verbatim into `src/lib/log.ts`.
- **Dormant-surface posture (F002):** the retained surface's loopback-bind and bearer refusal paths stay unmodified — they are part of the restoration path any ADR-2 ACCEPT inherits; this story does not re-audit that posture (a fresh security pass is owed if ADR-2 re-opens it — what the dormancy does NOT fence, said plainly).

## Definition of Done

- [ ] **Impl:** `git mv`-equivalent move; `git diff` on every touched file shows import-path-only changes outside the two moved-in/removed blocks. *An implementation with any edited moved body MUST fail AC1.*
- [ ] **Impl:** `src/swarmclaw/log.ts` gone, no shim; `tool-bridge.ts` no longer exports `maskEnv`.
- [ ] **Test (unit):** full `bun test` tee'd to a log per repo CLAUDE.md — green, same assertion set as the captured baseline.
- [ ] **Test (dormancy guard):** `tests/swarmclaw/dormancy.test.ts` green; failure messages name offending paths.
- [ ] **Contract:** `tsc` + biome green; `grep -r "swarmclaw/log" src scripts tests` → 0 files.
- [ ] **Contract:** GitNexus `impact()` recorded for `log`/`setLogSink`/`maskEnv` pre-edit; `detect_changes()` run before commit showing only expected moved symbols.
- [ ] **Security:** CC-9 / INV-SC5 / INV-HM1 behavior tests pass with unmodified assertion bodies.
- [ ] **Integration:** `git diff` empty on `oci/exedev/Dockerfile` + `scripts/build-exedev-image.ts` + `driver.ts` pin constants (AC5).
- [ ] **Test (e2e demo — MANDATORY):** `bun test tests/swarmclaw/` green (retained-surface fixture) and `bun test tests/fleet/skill-contract.test.ts` green (proves the fleet skill contract survived the import rewrite).

## Dev Agent Record

## Dev Agent Record

**Landed 2026-10-14** — branch `feature/z5-chassis-fate` (single commit, amended
through review rounds), PR → dev.

- **Unlazy pipeline:** 8 leaves + node-1.1 (13/13 gates) + root, all VERIFIED
  with machine evidence (`.unlazy/z5/`); ledgers r1→r9 as contract amendments
  landed (owned set 122→128).
- **Round-1 fixes:** see Review Findings (round 1) — all 11 patch groups applied.
- **Round-2 fixes:** 10 applied — tests/ walk under rules 1/2/4 (rule 3
  production-only), star/namespace tightening for rules 2/4, logMuted in
  LOG_CLAUSE, rule-4 resolved-arm pin, formatted-message negative control,
  js-family walk breadth, self-contained header, __proto__ pin; visualizer/
  server/index.ts:399 scrub (C10 amended for that line, r9); tool-bridge header
  completed ("routes AND hindsight").
- **Disclosed deviations (truth):**
  - AC5's "no re-pin owed" premise was EMPIRICALLY WRONG: the move edited 21
    walked COPY inputs and changed the walk's composition (origin out; lib
    log/mask-env in). The buildId literal was re-pinned per the test's own
    same-commit ritual — final value 2328187…, provenance chain in
    `tests/scripts/build-exedev-image.test.ts` (e2dc33cd → 91eabeb3 → 3fcd0fca
    → 25e068ee → 23281874). AC5's letter (frozen Dockerfile/script/driver pins)
    holds; verified by node-1.1:N8.
  - Spec census undercounts (visualizer/ missing; 13 scripts vs 8; ~40 src vs
    27; nine re-export test consumers vs six) — implementation strictly more
    complete than enumerated.
  - Scope amendments: C10's exclusion of visualizer/server/index.ts:399 lifted
    for that one line (r9); fence.test.ts gained an ALLOWED_REPO_TARGETS entry
    (r3); comment allowances 1.1.1/1.1.3 (r8).
  - Deferred: maskEnv `__proto__` key-loss (inherited from origin verbatim;
    pinned in tests, fix → successor story), README old-home section (C10),
    bash-walk automation gap, two-lexer consolidation.
- **Verification at close:** node-1.1 ALL MET 13/13; BG1 pass-set OK
  8030 pass / 12 skip / 15 fail summary, 14 (fail) markers — strict subset of
  the 17-name baseline, ZERO new failures, +25 pass; DoD demos green
  (tests/swarmclaw/ 231 pass incl. the guard; skill-contract 45 pass);
  story-consistency checker OK.

*Written at implementation time, not at spec time.*

### Review Findings (round 1, 2026-10-13 — bmad-code-review, 4 layers, 26 findings)

Triage: 13 grouped patch entries, 4 defer, 9 rejected. All patch + low fixed in round 1 per the standing review contract.

- [x] [Review][Patch] Barrel exemption over-broad: exempts clause (b) too [tests/swarmclaw/dormancy.test.ts:203] — exempt src/index.ts for clause (a) only; a log-origin import under the barrel path must flag
- [x] [Review][Patch] visualizer/ absent from the dormancy walk [tests/swarmclaw/dormancy.test.ts] — this diff proves visualizer is a production consumer; add to walk (stays green: imports lib/log only)
- [x] [Review][Patch] log-via-transport regression unguarded [tests/swarmclaw/dormancy.test.ts] — restored stdio-transport log re-export passes the guard; add rule: stdio-transport specifier + log-symbol clause = violation
- [x] [Review][Patch] origin resurrection via swarmclaw/log.d.ts or log/index.ts unguarded [tests/swarmclaw/dormancy.test.ts] — extend tail alternation + resolved-dir rule
- [x] [Review][Patch] multiline dynamic destructure escapes maskEnv/server-surface rules [tests/swarmclaw/dormancy.test.ts] — enclosingStatement clips to the import( line; extend to the enclosing declaration; pin the multiline shape
- [x] [Review][Patch] template-literal specifier behavior undocumented [tests/swarmclaw/dormancy.test.ts] — declare the lexer ceiling in the docblock and pin the current behavior (house regex-ceiling precedent)
- [x] [Review][Patch] dormancy docblock drift: raw-pass union + rule-3 tail matching undocumented [tests/swarmclaw/dormancy.test.ts] — docblock truth fixes
- [x] [Review][Patch] mask-env.ts ships with zero direct unit tests [src/lib/mask-env.ts] — add tests/swarmclaw/mask-env.test.ts (undefined→{}, every value masked, keys preserved) — new owned path r8
- [x] [Review][Patch] stale docblocks: src/hindsight/client.ts:15-17 (log/maskEnv old homes) and src/swarmclaw/mcp/tool-bridge.ts:2 (claims INV-SC5 masking it no longer holds) — comment scrubs under r8 ledger comment-allowance amendments (1.1.3 G2, 1.1.1 G5)
- [x] [Review][Patch] provenance-note defects (build-exedev-image.test.ts): "deleted deleted" scrub typo; "ALL import-path-line-only" universal false for tool-bridge (block deletion); "98 files = all test files/scripts/visualizer" mischaracterization; "no further tree edits" self-contradiction
- [x] [Review][Patch] portability comment rationale inverted (here-string adds the trailing newline; command substitution strips it); per-instance correction
- [x] [Review][Defer] bash-3.2 read-loop sets verified by no automation [scripts/dev/*] — deferred: verification-gap layer's filed evidence; durable gate-mode check needs a synthetic git fixture disproportionate to the 4-line patch
- [x] [Review][Defer] two divergent hand-rolled import lexers (dormancy guard + fence.test.ts) [tests/] — deferred: consolidation is a separate refactor; fence lexer predates this change
- [x] [Review][Defer] AC5 outcome premise falsified (digest moved; re-pin landed in-branch) — deferred to story-header truth at closure (BG3): spec premise empirically wrong, disclosed r4/r7
- [x] [Review][Defer] spec-text inaccuracies for closure truth: census counts off (visualizer/ missing; 13 scripts vs 8; ~40 src vs 27); INV-SC5 "routes tests now importing from lib/mask-env" describes a pin that doesn't exist (transitive); dev-script portability patch outside owned set (r6, disclosed) — deferred: BG3 story-header truth items, spec-edit rejected per triage rules

Rejected (9): log.ts docblock rewrite ≠ verbatim violation — sanctioned by recorded contract amendment PLAN I1 (r1, the one sanctioned truthfulness sentence; old text would have been false post-move); unpaired-quote mispairing escaping the guard — false: the raw pass runs all four edge regexes quote-pairing-independently, so the union closes the mispair scenario by construction; cli-anything/src unscanned — scope-excluded by story contract (the cli-anything/src/env.ts:15 mention is pre-existing and out of scope; a guard extension there would sit permanently red on an excluded file); AC3-grep-red-on-guard-fixture — adjudicated at r5/N7: the guard is the sanctioned namer, fragment-encoding its plants degrades the test for zero safety gain; spec-census edit requests — rejected per no-spec-edit rule (routed to BG3 truth instead); dev-scripts-as-smuggled-work — disclosed r6, required for N10/N11 to fire on this platform, PR-body disclosure; re-pin-in-branch as "not this story's to fix" — the ritual is the test's own demand, disclosed; DoD process evidence absent from diff — by nature (ledger + story record carry it, BG3); maskEnv-walk-composition claim — verified correct by the acceptance auditor itself.
