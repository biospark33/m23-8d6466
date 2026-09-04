# R4 — Track D: Spec Requirements (Binding Upstream Text) for DF3.2

**Story:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md`
**Date:** 2026-08-23 · **Method:** every passage quoted below was read from the file at the cited path on this host; upstream cookbook anchors verified against the real checkout.

---

## 0. Headline findings

### FLAG 1 (loud) — The story's binding-text provenance pointer is broken, but the binding text itself is intact and verified

The story (lines 20-22) says: *"The excerpts quoted in `R4-external-patterns.md` are the **binding** text for this story; the `INK/` anchors are provenance"* and that the sssf checkout is **"not present on this host"** so the `:line` anchors are unopenable. Both claims are stale:

- `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R4-external-patterns.md` contains **no fan_out_n.md excerpts**. Its only mention is a one-row summary table entry:
  > R4-external-patterns.md:1083 — "Best-of-N unimplemented: 214-line cookbook + a bash loop | 3.4 | ✅ | `cookbooks/fan_out_n.md` = 214 lines"
- The upstream checkout **is on this host**: `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md` (214 lines, confirmed). Only the `INK/` alias path is absent.

Consequence: the story's line anchors are **directly verifiable**, and all of them check out against the real file (details in §1.3). No clause rests on memory.

### FLAG 2 (loud) — Spec internal conflict on `reap`; story resolves it against §8 step 3

Design doc §8 step 3 (`2026-08-11-dark-factory-v5-architecture-design.md:450-451`) lists the fleet dispatcher verbs as **"(dispatch, fan-out N, status, attach, harvest, teardown, reap)"** — including reap. But §5.1 tier 1 (`:318`) omits it: "dispatch | fanout N | status | attach | harvest | teardown". The story's Trigger Surface excludes it explicitly:

> df3-2:176 — "Fleet-wide orphan sweep + failed-teardown queue | out-of-scope — DF2.6's `scripts/sandbox-reap.ts` is the whole surface; no `fleet reap` wrapper in v5.0"

DF2.6 confirms ownership ("Fan-out admission over `checkHeadroom(n)` … out-of-scope → DF3.2" and reap in-scope there, `df2-6-quota-accounting-reaper.md:138-142`). **Story wins** (per review rule); implementers must NOT add a `fleet reap` verb despite §8 step 3's wording.

### FLAG 3 (soft) — DD-1 is cited as authority for single-operator read-then-mint safety, but DD-1 does not say that

Story Technical Notes: "single-operator exclusion is what makes read-then-mint safe (**DD-1**)". DD-1's actual text (derivation-decisions `:46`) decides the channel layer:

> "**DECIDED: operator-CLI-only for v5.0.** Tier 1 is Claude Code + the tested fleet-dispatcher CLI; the operator is the channel."

Single-operator is an *implication* of operator-CLI-only, not stated. The inference is sound but AC8's lock is the mechanism that makes the assumption true regardless — which the story itself says ("AC8 turns that stated assumption into a mechanism"). No action needed; noted for reviewers who chase the citation.

### Non-findings (claims that verify cleanly)

- AC7's re-weighting claim is arithmetically exact (§4 below).
- Every `fan_out_n.md:` anchor in the story resolves to real text with matching semantics (§1.3).
- CC-9, DF2.1 extension namespace, DF2.5 teardown order, DF2.6 headroom shape, DF1.1 marker schema, DF1.6 `testsExecuted`, DF3.1 exit table/mint/admitted flag — all confirmed verbatim (§5).

---

## 1. Design doc — `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`

### 1.1 §5.1 Tier 2 (`:323`) — the three patterns

```text
TIER 2 — SANDBOX (one per run; N in parallel; fleet patterns: best-of-N, many-stories, race)
```
Supports: story Overview pattern list; AC6's degenerate-case framing (spec names the patterns but sets no N bounds — the `N=1` rule is story-authored); §5.1 tier 1 (`:318`) names the verb `fanout N`.

### 1.2 §4 Decision register

- **D3** (`:300`): "**Tier 1 = Claude Code … driving a *code* fleet dispatcher via skills.** Dispatcher is tested TS, not prompt-glue." Rationale column: "deterministic dispatch (disler's fleet layer is an un-coded bash cookbook — a gap we close with real code)." Rejected alternative: "Agent-improvises-fleet-commands (drops measured guards silently — disler's own skill forbids it)." → Supports the make-or-break framing and every negative control.
- **D7** (`:304`): provider-driver interface, exe.dev + OCI drivers → supports Infra table's driver rows and `fake` driver for CI.
- **D8** (`:305`): "Credential architecture = inkwell lifecycle as code… secrets never in argv, no push credential in any box…" → supports INV-4 and R5 fact 17 usage.

### 1.3 §5.3 Data flow (`:353-364`)

> "channel/operator → tier-1 dispatch (mint run-id, mint capped key, create box, fill via clone + SHA pin, setup gate) → … → harvest: ranged git bundle + artifacts tar + trace db → tier-1 verifies bundle … → teardown: spend captured, key revoked + verified, box destroyed, record closed"

Supports: per-arm lifecycle order assumed by AC4/AC5 (teardown harvest-before-destroy), and pin-at-fill (AC7 note / Technical Notes pin control).

### 1.4 §6 Security architecture items 1/2/5

- **Item 1** (`:377-378`): "**Isolation:** per-run sandbox (exe.dev KVM VM or client-side OCI/Firecracker); no east-west network; one factory workload per box." → AC2, INV-1.
- **Item 2** (`:379-381`): "**Credential containment:** exactly one secret per box — a spend-capped, per-run, revocation-verified LLM key… GitHub tokens never enter a box." → INV-3/INV-4.
- **Item 5** (`:392-394`): "**Blast-radius honesty:** sandboxes contain spend and credentials… No claim of containment we can't enforce in code." → AC2's structural (not policed) isolation and every "MUST fail this test" negative control.

### 1.5 §8 step 3 (`:450-451`)

> "**Fleet dispatcher + tier-1 skills** (dispatch, fan-out N, status, attach, harvest, teardown, reap). Best-of-N becomes code."

Supports the story's existence and scope; the trailing "reap" is FLAG 2 above.

### 1.6 §9 risk R8 (`:487`)

> "**Fleet-level concurrency safety (the flaw SSSF has in-repo)** | One run = one box = one key = one record; no shared working tree by construction. Extended by F9: host-side quota accounting + reaper for leaked VMs so fan-out can't exhaust the 50-VM / pooled-disk ceiling"

Supports AC1 (ceiling refusal), AC2 (isolation by construction), AC8 (concurrency safety), INV-1/INV-6.

---

## 2. Derivation decisions — `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`

- **DD-1** (`:46`, full): "**#1 Channel layer has no build-order step** | **DECIDED: operator-CLI-only for v5.0.** Tier 1 is Claude Code + the tested fleet-dispatcher CLI; the operator is the channel. No channel story is derived. OQ-3 stays BLOCKED-on-creds; the Hermes fallback stays recorded-only. Channel↔factory bridge re-enters at a future vX derivation with working credentials, as a DF3-adjacent sub-epic. Writers must not assume Telegram intake anywhere." → See FLAG 3.
- **DD-8** (`:85`, full): "**Writers consume R2 §1–§11, never audit §3 directly.** True surviving clauses paste verbatim from R2's quoted source text (real labels + line numbers). Items R2 marks NET-NEW are authored **fresh** in their mapped successor story, cited to design §5.2 / PR #97 / the gates report — not under the 'survives verbatim, do not re-litigate' banner — and get full adversarial review like any new material."
- **DD-9** (`:86`, full): "**Cost unit = integer micro-dollars (µ$), settling the 10,000× contradiction.** P1.13's source uses `costCents` with a 500-cent ($5.00) default cap; the design says micro-dollars. Micro-dollars win (SPL-018 enterprise-correct): cheap-roster runs cost $0.015 and per-role splits are sub-cent — cents cannot represent them. The default cap is **explicitly restated as 5,000,000 µ$ ($5.00)** in DF2.8; no numeric literal is carried across the unit change." → Supports Technical Notes' "per-arm cap … in integer micro-dollars" and INV-3.
- Also relevant: **DD-12** (`:97`): permission fingerprinting deferred because v5.0's "one-run-one-box isolation (R8) structurally removes" the shared-tree hazard — independent spec confirmation of AC2's structural-isolation reading.

---

## 3. Upstream source pattern — fan_out_n.md

**Actual path on this host:** `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md` (= the story's `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md`). 214 lines. All story anchors verified:

| Story anchor | Actual text (verbatim) |
|---|---|
| `:3-22` isolation argument | `:3-4`: "Best-of-N means **N separate sandboxes**. One run, one VM, one runtime key, one working tree, one git state, one set of ports." `:8-10`: "five agents on one machine fight over one working directory, one dev-server port, and one git state. Running N agents inside a single sandbox **reintroduces exactly that collision**". `:14-17`: "**Spend attribution.** One runtime key per sandbox is what makes … a table you can rank. N agents sharing one key produce one number nobody can decompose. **Blast radius.** `--limit` caps a single arm at its own budget. One key for N arms means one runaway arm can spend all of it." `:18-20`: commit graph unreadable + "the gate … no per-agent version of it". |
| `:26-32` id-mint race | `:26-28`: "Mint the run id yourself and pass it through the phases. **Do not use `just sbx mount` for fan-out**: `mount` recovers the generated id by reading the newest record out of `run_record.py list`, which is correct for one run and a race under concurrency." `:30-31`: "`create` only generates a new id when the argument does not already end in `-<6 hex>`, so an id from `new-id` is used verbatim." |
| `:39/:45/:132` commit pin | `:39`: "PIN=$(git rev-parse HEAD) — one commit for every arm — this is the control variable"; `:45`: "# pin every arm to the same sha or the comparison is noise"; `:130-134`: "**And the control: the commit pin** — `fill <id> <sha>` pins the arm. Hold it constant across arms or the comparison has two variables. `commit_sha` is recorded from what actually got checked out, never from what was asked for, and FILL gates that they match." |
| `:53-55` mint outside parallel section | "`create` is the only phase that mints, so id generation must stay outside the parallel section (it already is), and a gate failure in one arm must not abort the others — run each chain in its own subshell and collect exit codes." |
| `:57-58` failed arm stays up | "**A failed arm stays up.** `setup` never destroys. Read `debug_a_failed_gate.md`, fix, re-run `setup <id>` for that arm only." |
| `:136-140` ranking | "`manage list` gives you state, VM liveness and spend for every run. There is no single ranked table beyond that — harvest each arm and diff the refs against each other with plain git, which is the honest comparison anyway: the code is the artifact, not a score." |
| `:174-207` golden-VM cp failure | `:174`: "**`sync` THEN `cp`. Always.**" `:181-183`: "An unsynced `cp` produced **5,641 zero-byte files and reported no error**… That is precisely why gate A checks `git status --porcelain` rather than that files exist." `:205-207`: "**This whole path is unexercised.** … Treat the first one as an experiment, not an optimization." |

Note `:14-17` also grounds INV-3/AC-per-arm-cap ("One key for N arms means one runaway arm can spend all of it"), matching the story's `:14-17` citation.

---

## 4. P1.4 score formula — `_bmad-output/sprint-artifacts/phase-1/stories/p1-4-protocol-template.md`

**`:92`** (decide phase, weighted scoring):

> "`testPassRate` = `testResults && (testResults.passed + testResults.failed) > 0 ? testResults.passed / (testResults.passed + testResults.failed) : 0.0` … `uniqueFileCoverage` = `totalUniqueFilesChangedAcrossAllBranches > 0 ? (changedFiles ? new Set(changedFiles).size : 0) / totalUniqueFilesChangedAcrossAllBranches : 0.0` … `totalUniqueFilesChangedAcrossAllBranches` is the size of the union of `changedFiles` from all branches … Score each branch: `testPassRate * 0.5 + uniqueFileCoverage * 0.3 + summaryQuality * 0.2`."

**Tie rule `:94` / `:97`:**

> ":94 — If top-2 scores are within 0.1 (tie), flag for human review in the output."
> ":97 — **Tie-breaking:** If top-2 scores are within 0.1, the DecisionResult includes `tie: true` and rationale 'Scores within 0.1 threshold — manual review recommended'. **No automatic tie-breaking** — human review is the tie resolution path."

Verification of AC7's re-weighting claim: original terms are `0.5`/`0.3` (+ dropped `summaryQuality * 0.2`). Renormalizing over `0.8` would give **`0.625`/`0.375`**; the story's `0.6`/`0.4` is indeed a deliberate round choice summing to 1.0, not renormalization — the story's arithmetic statement is exact. Cross-arm union denominator, `[0,1]` bounding via Set-dedup, default-0 guards, and boundary-inclusive `within 0.1 ⇒ tie:true` all match P1.4 verbatim. The only delta: P1.4 guards on `(passed+failed) > 0` while AC7 additionally outer-guards on `testsExecuted` — consistent, because DF1.6 requires `testsExecuted:false` exactly when `passed+failed===0` (`df1-6-dispatch-task-team-runtime.md:58-60`), so the two guards coincide on all producer-valid inputs.

---

## 5. Predecessor contracts cited by the ACs (verified)

- **CC-9 (requestId propagation)** — canonical definition `df3-1-dispatcher-core-verbs.md:186-192`: "Every dispatch carries a `requestId` (UUID v4) that propagates through all layers — tier-1 dispatch → fleet dispatcher → in-sandbox subprocess tree → phase-engine step — appearing in exactly four places: (1) brief's `requestId`, (2) ack's `requestId`, (3) every run-record mutation and driver-call log line, (4) every trace-store row … *The requestId is the join key for cross-layer tracing.*" Origin: `p1-1-dev-manager-a2a.md:47` ("Correlation ID propagation (CC-9)"). DF3.1 `:325` extends it to INV-4-bis. Story's Observability Contract propagates the fan-out `requestId` into each arm's dispatch — compliant.
- **DF2.6 `checkHeadroom`** — signature `df2-6:277`: "returns `{ allowed, liveVms, ceiling, headroom, reason? }` — no lock, no state."; AC2 shape `:96-98` matches AC1's example numbers (48 live / 50 ceiling / requested 3 / headroom 2); trigger-table row `:141`: "one call covering all N, before the first mint | out-of-scope | — | **DF3.2**" — the story's AC1 is literally the named consumer. `list-unverified` fail-closed at `:106`.
- **DF3.1** — exit table `0/1/2/3/4/5` (`:381`); `mintRunId()` = `newId("qds")`, "never a caller-chosen id", optional `runId` param validated (`:231-235`, `:79`); `{ admitted: true }` is DF3.2-only and suppresses only the headroom call, never the budget gate (`:125`, `:220-225`, `:358`); Decision-1 correction (`:386`) explains why dispatch mirrors createRun post-admission rather than routing through `checkHeadroom(driver, 1, ...)`; per-issue budget gate consults reserve via DF2.8 (`gate_admissions` append-only reservations inside `BEGIN IMMEDIATE`, `df2-8-cost-ledger-budget-cap.md:341-348`) — supports the Technical Notes' "N arms place N reservations" aggregate-bound claim; dispatch ceiling 600_000 ms (`:256`).
- **DF2.1** — twelve-field closed record; sole additive key `extensions: { [ns]: { schemaVersion, ...fields } }`, unregistered ns / missing shape rejected (`:59-65`, `:121-134`); `.sandbox/runs/` dir `0700`, records `0600`, `O_EXCL` create (`:55`, `:103`, `:151`); `ProviderDriver` port = `create/list/destroy/expose/setPublic/whoami/exec/copyFile` — **no `observe` method** (`:110-116`), and "lifecycle verbs are host-side, not driver methods… `observe` composes exec/copyFile" — AC5's host-side-composition claim is exactly DF2.1's own doctrine. `copyFile` is **box→host only** (`:112-114`) — matches AC5's read direction.
- **DF2.2 INV-5** (`df2-2-exedev-driver-setup-gate.md:187`): "a failing gate **never destroys the VM** — destroying it throws away…" (`:209`, `:222`, `:256` reinforce). Assertion A catches zero-byte truncation via `git status --porcelain` (`:66-68`, `:126`) — the story's golden-VM deviation note cites this correctly.
- **DF2.5 teardown order** (`df2-5-bundle-harvest-teardown.md:34`, `:118`, `:122`): fixed relative order spend → artifacts → commits → revoke → destroy → close; "six steps are a floor, not a closed list — the contract is their relative order." AC5's loser-teardown language matches.
- **DF1.1 terminal marker** (`df1-1-phase-abstraction-lifecycle.md:87-90`, `:150-153`, `:313`): `/run/journal/final.json` = `{runId, ok, completedAt}`; `RUN_MARKER_ROOT = process.env.QDS_RUN_ROOT ?? "/run"` with QDS_RUN_ROOT host-test-only — matches AC5 and the Infra table verbatim, including the red run (`ok:false`) case.
- **DF1.6 step output** (`df1-6-dispatch-task-team-runtime.md:55-60`): `testResults: {passed, failed}`, `testsExecuted: boolean` required-and-false when sum is 0; no `testsPassed` field exists — AC7's field-name assertions are correct.
- **R5 binding facts** (`_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md:396+`): fact 11 (exe.dev figures vendor-single-origin [VERIFY], never assume compliance artifacts) → deviation note's [VERIFY] clause; fact 15 (in-box evidence is claims-not-proof; nothing opens a PR on in-box evidence alone); fact 17 (no push credential in any box; exactly one secret per box) → INV-4.

---

## 6. Per-AC support matrix

| AC | Supporting passages | Contradiction? |
|----|--------------------|----------------|
| **AC1** refuse before mint, exit 5, one check | design §9 R8+F9 `:487`; §8 step 2 quota accounting `:444-447`; DF2.6 `:96-98`, `:277`, `:141` (row explicitly delegates fan-out admission to DF3.2); DF3.1 exit table `:381`, headroom-refusal exit 5 incl. `list-unverified` `:355`; D3 `:300` | None |
| **AC2** N boxes/N keys/N records | design §6.1 `:377-378`, R8 `:487`, §5.1 tier 2 `:323`; fan_out_n.md `:3-22` (verified, §3); DD-12 `:97` (shared-tree hazard structurally removed) | None |
| **AC3** mint all ids before parallel section, via DF3.1's minter | fan_out_n.md `:26-32`, `:53-55` (verified); DF3.1 `mintRunId()` contract `:231-235`, `:79` | None |
| **AC4** failed arm stops alone, box alive, siblings complete | fan_out_n.md `:57-58` ("A failed arm stays up"), `:54-55`; DF2.2 INV-5 `:187`; DF2.5 order `:34,:118`. Setup-failed-vs-race-lost precedence split (setupFailed ≠ armFailed) is story-authored disambiguation, consistent with both sources | None |
| **AC5** race polling over final.json, host-side composition, winner transition | DF1.1 marker schema + RUN_MARKER_ROOT `:87-90,:150-153,:313`; DF2.1 port has no observe, copyFile box→host only `:110-116`; DF2.5 six-step order `:34,:118,:122`. Poll interval/deadlines/winner-field mechanics story-authored. *Caveat:* R5 fact 15 — in-box `ok:true` may select the winner but must never authorize trust at the boundary; PR still goes through DF5.1 host-side re-verify. Keep ranking/winner advisory | None (boundary condition noted) |
| **AC6** many-stories degenerate N=1; best-of-n/race reject N=1 exit 2 | design §5.1 `:323` names the three patterns without N rules; exit code 2 from DF3.1's table (`:381`, validation class). Degenerate-case requirement is story-authored | None |
| **AC7** rank formula 0.6/0.4, cross-arm union, drop summaryQuality, tie ≤0.1 no auto-break | p1-4 `:92` (formula, union denominator, default-0 guards), `:94`,`:97` (tie rule, no auto break); DF1.6 schema `:55-60` (field names, testsExecuted semantics); fan_out_n.md `:136-140` (ranking advisory, code is the artifact); DD-9 (µ$ units if spend shown) | None — re-weighting arithmetic verified exact (renorm would be 0.625/0.375) |
| **AC8** fleet.lock, two-part reclaim, exit 5 fleet-busy | DD-1 `:46` (soft — see FLAG 3); R8/F9 concurrency-safety `:487`; DF3.1 exit table `:381`. Lock format, pidStartTime identity check, thresholds story-authored mechanism implementing the doctrine | Soft citation only |
| **AC9** fanout record O_EXCL + extensions.fanout with schemaVersion | DF2.1 closed schema + extensions namespace requiring schemaVersion `:59-65,:128,:134`; 0700/0600 + O_EXCL discipline `:55,:103,:151`; CC-9 requestId in record fields | None |

---

## 7. Most load-bearing constraints beyond the story text

1. **fan_out_n.md is directly readable on this host** at `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md` — the "unopenable anchor" premise is void; verification should quote the real file, not reconstruct from the story.
2. **No `fleet reap` verb** despite §8 step 3 listing it — DF2.6 owns the sweep (`scripts/sandbox-reap.ts`); adding a wrapper violates the story's Trigger Surface.
3. **Race-winner selection is advisory, not boundary trust** (R5 fact 15 + fan_out_n.md `:136-140`): `ok:true` picks the arm whose work gets harvested/ranked; it never substitutes for DF5.1 host-side re-verification before any PR.
