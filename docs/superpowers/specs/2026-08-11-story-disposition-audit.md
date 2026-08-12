# F14 Pre-Derivation Audit — Per-Story Disposition of the 30-Story Superstructure

**Date:** 2026-08-11
**Gate:** F14 (Dark Factory v5 design §8 pre-derivation gates) — "all 30 retired-superstructure
stories enumerated keep / retire / re-derive, with surviving clauses named, so story authoring
does not re-litigate the supersession boundary per story."
**Against:** `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (r2,
adversarial review completed 2026-08-11, F1–F16 incorporated).
**Evidence base:** all 30 story files read in full; `phase0-gate-report.json` (2026-07-25,
overall FAIL: 7 pass / 2 fail / 1 skip / 2 void); `sprint-status.yaml`; PR #98 / issue #51
P0.5+P0.9 DoD reconciliation (`p0-5-p0-9-dod-reconciliation.md`, commit de61bc7); merged PRs
#92–#100; PR #97 phase-1 pre-dev hardening record.

**Scope guard:** audit only. No story is rewritten here. One factual correction was applied as
mandated by the design (§3.1 row 6, D9): the false P0.3 dev-record claim — see §5.

---

## 1. Disposition definitions

| Disposition | Meaning |
|---|---|
| **DONE-KEEP** | Phase-0 work built, landed, and evidenced by code/tests/gate — cited per row. Caveats flagged inline. |
| **KEEP** | Still valid as written. Dependency-edge repoints (a dep now RE-DERIVE'd) and single-line factual amendments (e.g. 4→5-value enum citation) are allowed under KEEP; anything touching an AC's substance is not. |
| **RE-DERIVE** | Valid intent, dead mechanism. Rewrite against the three-tier architecture; surviving clauses named exactly per row in §3. |
| **RETIRE** | Warren-decision-killed or obsolete premise; no successor story (successor *intent*, where any, noted). |

**Supersession rule applied uniformly (design §3.8, §5.2, §7):** the PR #97 harness/NDJSON-boundary
hardening — exitStatus 5-value enum (CC-1), step-output schemas (changedFiles / testResults /
durationMs / mulchPrimed / mulchPrimeError / artifacts), two-stage decode-then-check +
`O_NOFOLLOW` path-traversal defense, observability contract (requestId propagation, sub-timings,
prompts persisted), maxDurationMs ≤ upstream-timeout margin — is runtime-agnostic and **survives
verbatim**. Anything assuming Warren team dispatch (`warren run` for teams, `--team`),
`QDS_AGENT_TEAM_CONFIG_JSON`-over-the-wire, the assumed 0/1/2/3 exit-code semantics (contradicted
by the published v0.14.1 table — F3), harness-RSS-watchdog-on-the-CLI-client, or CC-13/CC-14
**does not**. SPIKE-3 (never ran) is retired with them.

---

## 2. The 30-row disposition table

Slot = §8 build-order step (0 PROOF · 1 phase engine · 2 provider+credentials · 3 fleet
dispatcher · 4 visualizer · 5 lights-on PR · 6 memory · 7 OCI). "5+" = post-step-5 capability
with **no named §8 step** (see §4).

### Phase 0 (11 stories)

| Story | Title | Board status | Disposition | Dead premise (if any) | Slot |
|---|---|---|---|---|---|
| P0.1 | Archon env-patch productionize | killed | **RETIRE** | Archon DAG as dispatch layer — removed by the v4 Warren pivot; v5 has no DAG either (D2). Kill note itself says "Do NOT resurrect without a DAG." Per-agent env-override *intent* is covered by per-role roster config (D6/SSSF), via P1.5's lineage — not this story's. | — |
| P0.2 | Vendor coms.ts + OQ-1/OQ-5 | done | **DONE-KEEP** | — | 0 (substrate) |
| P0.3 | Mixed-model merged-JSON demo | done | **DONE-KEEP** ⚠ dev record corrected | Dev-record claim "warren 0.10.0 installed and CLI-verified on this host" was false (§3.1 row 6) — corrected 2026-08-11, see §5. The *work* stands: live run used `QDS_TEAM_RUNNER=local`. | 0 (direct ancestor) |
| P0.4 | Hard-guard loopy-prompt kill | killed | **RETIRE** | Killed/absorbed: `budgetCapUsd` + `wallClockCapMs` landed in the cli-anything launcher (KEEP asset; gate clause 3 structural pass, overflow→exit 3). The *live kill demo* (AC3) has **never run** — intent re-attaches to step 2 spend-capped keys + §5.2/F12 watchdogs. Flagged in §4. | (2) |
| P0.5 | pi-lens headless TDI/warnings | in-review | **KEEP** | — (runtime-agnostic; pi-lens is a §7 KEEP asset) | 1 (gates) |
| P0.6 | LSP provision + diagnostics | done | **DONE-KEEP** (scoped) | — | 1 (gates) |
| P0.7 | SwarmClaw agent + MCP + Hindsight bridge | done | **DONE-KEEP** ⚠ AC2 premise broken | AC2 assumed `hindsight-local-mcp` is a stdio JSON-RPC binary on PATH; live it is an HTTP server on `:8888/mcp/` (gate clause 6 fail: "may be unachievable as specified"). Registry/plumbing/persistence halves are fully evidenced. Needs a spec amendment independent of v5. | 6 |
| P0.8 | Telegram verify / OQ-3 + Hermes | killed | **RETIRE** | Deferred by Warren decision; OQ-3 recorded BLOCKED-on-creds + Hermes fallback. Successor intent lives in P1.10's re-derivation, but the *channel layer itself* has no §8 step — hole #1 in §4. | (5+) |
| P0.9 | Seeds/Mulch pin + Hindsight banks | in-review | **KEEP** | — (code done: ~6,300 lines, 132 tests, PR #37; NOT DONE-KEEP because the MANDATORY live round-trip has never executed — every open item traces to the OQ-4 wall: Hindsight has never booted. #98 downgrade stands on evidence.) | 6 |
| P0.10 | GitNexus analyze + graph queries | done | **DONE-KEEP** | — (gate 7b pass; standing stale-index discipline: reindex via `install-gitnexus-plus.sh`) | all (code intel) |
| P0.11 | Phase-0 exit gate (§13) | done | **DONE-KEEP** (artifact) | The §13 clause set it asserts is superseded with the superstructure; the gate *framework* (`scripts/phase0-exit-gate.ts` + `src/gate/*`, 45 tests, per-clause evidence, VOID recording) is a KEEP asset and the natural chassis for P1.17's re-derivation. The FAIL verdict is honest record, not story failure. | 5 (gate chassis) |

**Phase-0 evidence citations (DONE-KEEP rows):**
- **P0.2:** PR #25; `oq-1-smoke-run-2026-07-14.json` (agents=4, messages=3, strict); gate clause 2
  pass; vendored `pi-vs-claude-code-vendor/` + DIVERGENCE.md still under active hardening (PR #100).
- **P0.3:** PRs #40/#41; `_research/p0-3-live-run-2026-07-20.json` (3 distinct models, 6 coms
  entries, single merged JSON, partial=false, exitStatus=success); gate clause 1 pass. Origin of
  the CC-1 **5-value** exitStatus enum (`success | transient | overflow | logic | lead_failure`).
- **P0.6:** PR #42 (cfca40d); harness 7/7 exit 0; warm p95 453ms vs 3000ms budget; MANDATORY
  `--mode json` agent e2e **MET** here (P0.5's is still open). Story-level PARTIALs stand:
  AC1 single-query freshness, AC3 artifact half, AC3a init timeout, AC4 literal-sequential RPCs.
- **P0.7:** PRs #27/#31/#34; 22/22 DoD items; swarmclaw suite 175 pass. Live Hindsight bridge
  never demonstrated (transport mismatch + OQ-4).
- **P0.10:** PR #39; gate: `context` resolved createServer → `src/swarmclaw/index.ts`, `impact`
  impactedCount=2.
- **P0.11:** gate delivered with 2 CRITICAL review fixes (spawnSync event-loop block; budget-expiry
  pool stop); verdict **PHASE_0_GATE: FAIL — PHASE-0 IS NOT EXITABLE** (7/2/1/2).

### Phase 1 (19 stories — all draft)

| Story | Title | Disposition | Dead premise (if any) | Slot |
|---|---|---|---|---|
| P1.1 | Dev manager registered (hermes_local) | **RE-DERIVE** | Factory front door = SwarmClaw `/api/a2a` + `dispatch_task` handler on an unbuilt protocol engine (§3.8: "unbuilt — registry + hardened HTTP plumbing only"). v5 front door = tier-1 Claude Code + tested fleet-dispatcher CLI (D2/D3); SwarmClaw is demoted to host-side service chassis (§7). | 3 |
| P1.2 | /qds intake → one parent issue | **KEEP** | — (host-side, runtime-neutral; dep edge P1.1 repoints to the re-derived dispatcher) | 5 |
| P1.3 | Seeds-decompose → GitHub mirror | **KEEP** | — (dep edges only) | 5 |
| P1.4 | qds-factory protocol template | **RE-DERIVE** | A SwarmClaw protocol engine walks the declarative step graph — that engine was never built, and D6 adopts the SSSF-ported **TS phase engine** as the executor instead. Graph intent (dispatch→parallel→compare→decide→summarize) maps to phase abstraction + best-of-N (step 3). | 1 |
| P1.5 | Model router scored to meta | **KEEP** | — (aligns directly with D6's per-role model roster; derivation aligns CC-4 roster schema with the adopted SSSF roster format — schema alignment, not AC change) | 1 + 6 |
| P1.6 | Pi-team Warren run → structured JSON | **RE-DERIVE** (flagship) | Triply dead: (a) `warren run` team dispatch — single-agent-per-run at v0.14.1, F1/§3.1 rows 1–2; (b) roster via `QDS_AGENT_TEAM_CONFIG_JSON` — env var set on the local CLI process, never crosses the CLI→server wire, `CreateRunInput` has no env field, row 3; (c) self-flagged exit-code assumption (story lines 78–79: "0/1/2/3 → success/logic/transient/overflow, SPIKE-3 must confirm") contradicted by the published v0.14.1 table, row 5/F3 — SPIKE-3 never ran. INV-3 RSS watchdog measured the wrong process under server Warren (row 4) — survives **re-aimed** at the genuine local subprocess tree inside the sandbox (§5.2). CC-13/CC-14 retire with it. | 0→1 |
| P1.7 | Post-edit lsp_diagnostics gate | **KEEP** | — (story text: "runs on the harness host against the harvested workspace regardless of runtime"; dep P1.6 → its re-derivation) | 1 |
| P1.8 | Drive protocol run + capture | **RE-DERIVE** | Same unbuilt-SwarmClaw-engine premise as P1.4. Capture intent is largely **subsumed** by the adopted SSSF trace schema + trace store (D6) — derivation should reconcile, not duplicate. Issue-correlation clauses survive. | 1 (+5) |
| P1.9 | Restart policy (classify + caps) | **KEEP** | — (policy is keyed on the exitStatus *enum*, not raw Warren codes — survives producer swap; derivation reconciles with SSSF dual-retry discipline adopted in step 1 to avoid duplication) | 1 |
| P1.10 | approve/resume via Telegram | **RE-DERIVE** | Pause point "pre-push inside the run" relocates: v5 pushes host-side after bundle harvest + out-of-box re-verify (D8/F10), so the approval gate moves to tier-1 pre-PR; mid-run steering becomes tier-2 resident agent + tier-1 `attach` (D4, step 3). Telegram channel half still OQ-3 BLOCKED-on-creds. | 3 |
| P1.11 | Hindsight prime recall + retain | **KEEP** | — (§5.4: memory designs unchanged; fix stale 4-value enum citation at line 44 → 5-value) | 6 |
| P1.12 | Mulch prime/record | **KEEP** | — (`mulchPrimed`/`mulchPrimeError` are named in the §5.2 surviving contract verbatim) | 6 |
| P1.13 | Cost ledger within budget | **RE-DERIVE** | Enforcement point assumed team-spawn-time only. v5 layers it: per-run spend-capped provisioned key at mint (D8), tier-1 dispatch refusal, quota accounting + reaper (F9). Nearly all clauses survive; scope grows into the credential lifecycle. | 2 |
| P1.14 | Outcome record + router select | **KEEP** | — (fix stale 4-value enum citation at line 29) | 6 |
| P1.15 | Real PR produced | **RE-DERIVE** | The warren-conditional path (line 47: burrow branch pushed by warren's git integration) dies; and the story predates **F10**: v5 inserts bundle harvest → host-side re-verify (tests + gates re-run outside the box) *before* any PR opens. Host-side-credential core survives. This is §8 step 5 by name: "The factory's P1.15 moment." | 5 |
| P1.16 | Audit-chain reconstructable | **RE-DERIVE** | Chain as written stops at issue→run→cost→retain→PR. v5's chain adds links the story couldn't know: key mint/cap/revoke/verify events, bundle verification, out-of-box re-verify evidence, box lifecycle (D8, §6.4). All existing clauses survive; the chain extends. | 5 |
| P1.17 | Phase-1 make-or-break gate | **RE-DERIVE** | Clause set asserts the Warren-era §13 Phase-1 pipeline shape. Gate *pattern* (per-clause evidence, VOID recording, versioned report) survives on the P0.11 chassis; clause set re-derives from §8 step 5. | 5 |
| P1.18 | PR comment-polling detect | **KEEP** | — (host-side GitHub API polling, zero Warren surface; dep P1.15 → its re-derivation). No named §8 step for the feedback loop — hole #2 in §4. | 5+ |
| P1.19 | Pi Pair fix → PR green | **RE-DERIVE** | Dispatch = `warren run --team pi-pair --ref <pr-branch>` — the `--team` flag exists in no Warren version examined (§3.1 row 2); pair "runs in a warren burrow" (line 36); "warren exit code 0 → success… classify per CC-1 mapping" (line 52) contradicted by the published table. Cites CC-13/CC-14 as the dispatch surface — both retired. Intent (feedback → bounded fix run → CI green) is sound and close kin to step 0's DoD. | 5+ |

---

## 3. RE-DERIVE rows — surviving clauses, named exactly

Per F14's requirement, the clauses below survive **verbatim** into the re-derived successors.
Everything not listed for a story is either dead (named in §2) or ordinary rewrite material.

| Story | Survives verbatim | Dies |
|---|---|---|
| **P1.1** | AC4 requestId propagated dispatch→step→response; AC5 malformed dispatch → 4xx + **no spawn** (schema validation at the boundary); runId ack semantics; CC-1 5-value, CC-5 correlation. | AC1–AC3's SwarmClaw `/api/agents` + `/api/a2a` + protocol-engine mechanism. |
| **P1.4** | AC3 template/step-graph schema versioned + validated at load; AC5 per-step timeout ≤ upstream budget with margin (maxDurationMs discipline); recorded compare/decide rationale as a *requirement* (mechanism moves to phase-engine gates-with-evidence). | Engine premise (AC1/AC2/AC4 as SwarmClaw-engine behaviors); CC-3's binding to the SwarmClaw template registry. |
| **P1.6** | AC3 step-output schema — CC-1 5-value exitStatus, changedFiles, testResults, durationMs, mulchPrimed/mulchPrimeError, artifacts; AC4 NDJSON events parse via `parseTeamEventLine`, zero malformed lines; AC5 two-stage decode-then-check + `O_NOFOLLOW` path-traversal defense on artifact paths; AC6 observability (requestId, per-phase sub-timings, prompts persisted pre-execution); INV-1 no secrets in step output; INV-2 maxDurationMs ≤ upstream timeout minus routing margin; INV-3 RSS watchdog **re-aimed** at the in-sandbox local subprocess tree (§5.2 declares it "now correct"). | AC1 `warren run` team dispatch; AC2 `QDS_AGENT_TEAM_CONFIG_JSON` transport; the 0/1/2/3 exit-code assumption + SPIKE-3; CC-13/CC-14; burrow-workspace recording. |
| **P1.8** | AC3 every step output persisted + linked to the GitHub issue; AC4 unbroken requestId chain across all steps. | AC1/AC2 SwarmClaw-engine template walk + envelope capture (subsumed by SSSF trace schema/store). |
| **P1.10** | AC1 approval-required run pauses before the irreversible action; AC3 pause state persisted, survives restart, resumable; AC4 approvers authenticated (allowlist), approve/reject idempotent; INV-1 timeout → auto-**abort**, never auto-approve. | The in-run pre-push pause location (push is now host-side post-re-verify); the assumption that the run process itself brokers the pause. |
| **P1.13** | AC1 exactly-one idempotent runId-keyed ledger record; AC2 tokens in/out + cacheRead/cacheWrite + USD as integer micro-dollars + per-role split; AC3 `qds cost <issue>` cumulative view; AC4 budget cap from config → dispatch refused with explicit error; AC5 cap check precedes spawn; INV-1 append-only; INV-2 malformed cost events → `unpriced` flag, never dropped. | Nothing refuted — the story *extends* (key-cap mint linkage, F9 quota accounting/reaper). Re-derived for scope, not falsity. |
| **P1.15** | AC2 success + green gates → branch pushed, PR opened; AC3 PR body carries runId + issue refs + cost summary; AC4 reviewer-visible artifacts attached; AC5 red gates → **no PR**, failure recorded on issue; INV-1 push credential stays host-side (now doctrine: D8 "no push credential in any box"). | Line 47 warren-git-integration conditional; PR-before-re-verify ordering (F10 inserts host-side re-verify first). |
| **P1.16** | AC1 `qds audit <pr>` resolves runId and walks the chain; AC2 chain includes cost record, outcome record, retain receipt; AC3 missing link → named failure; AC4 chain verification in CI on merged factory PRs; INV-1 immutable link references. | Nothing refuted — chain gains v5 links (credential lifecycle, bundle verify, re-verify evidence). |
| **P1.17** | AC1 per-clause assertion with evidence; AC2 versioned report JSON to sprint-artifacts; AC3 VOID clauses recorded with reason; AC4 red gate blocks the next phase; gate exit convention 0/1/2. Chassis: P0.11's `src/gate/*`. | The §13 Phase-1 clause list itself (Warren-era pipeline shape). |
| **P1.19** | AC2 pair produces commits addressing the feedback; AC3 fix-run output validates against the step-output schema; AC4 CI green → comment resolved/PR updated; AC5 ≤2 fix attempts then human escalation with context; INV-1 no force-push, append-only commits. | AC1's `warren run --team pi-pair` dispatch; burrow execution; line-52 warren-exit-code mapping; CC-13/CC-14 references. |

---

## 4. Summary

### Counts

| Disposition | N | Stories |
|---|---|---|
| DONE-KEEP | 6 | P0.2, P0.3⚠, P0.6, P0.7⚠, P0.10, P0.11 |
| KEEP | 11 | P0.5, P0.9, P1.2, P1.3, P1.5, P1.7, P1.9, P1.11, P1.12, P1.14, P1.18 |
| RE-DERIVE | 10 | P1.1, P1.4, P1.6, P1.8, P1.10, P1.13, P1.15, P1.16, P1.17, P1.19 |
| RETIRE | 3 | P0.1, P0.4, P0.8 |
| **Total** | **30** | |

⚠ = DONE-KEEP with a flagged defect: P0.3 (false dev record — corrected, §5), P0.7 (AC2
stdio-transport premise broken live; bridge never demonstrated).

### Build-order coverage — surviving intent vs. net-new

| §8 step | Covered by surviving story intent | Net-new (no story ancestry) |
|---|---|---|
| 0 PROOF | P0.2/P0.3 substrate + the step-0 DoD (written, **not yet run** — separate gate) | — |
| 1 Phase engine | P1.4, P1.6 (surviving core), P1.7, P1.8, P1.9, P1.5(roster) | **The engine port itself** — stories cover template/gates/retry/trace *fringes*, nobody covers the SSSF→TS core |
| 2 Provider + credentials | P1.13 (ledger/budget); P0.4's never-run live-kill intent | **Credential lifecycle (mint/cap/revoke/verify), provider-driver interface, run records, bundle harvest, quota/reaper** — all net-new |
| 3 Fleet dispatcher | P1.1 (entry/ack/correlation), P1.10 (approve/attach) | **Fan-out N, best-of-N as code, status/harvest/teardown/reap verbs** |
| 4 Visualizer | — | **Entirely net-new** — zero story ancestry |
| 5 Lights-on PR | P1.2, P1.3, P1.15, P1.16, P1.17; P0.11 chassis | Host-side re-verify (F10) — new requirement inside P1.15's re-derivation |
| 6 Memory | P0.9, P1.11, P1.12, P1.14; P0.7's bridge | — (but see OQ-4, hole #4) |
| 7 OCI driver | — | Net-new by design (deferred until enterprise demand; image contract at step 2, F13-gated) |
| **5+ (unslotted)** | P1.18, P1.19, P0.8-successor-intent | See holes #1–#2 |

### What we're getting into — honest estimate

The salvage is better than "retire the superstructure" sounds, and worse than the story count
suggests. **17 of 30 stories (6 DONE-KEEP + 11 KEEP) need no rewrite** — the entire memory
layer, the intake/decompose chain, the gates/router/restart-policy band, and all landed phase-0
code carry over with dependency repoints and two one-line enum fixes. Of the 10 RE-DERIVE rows,
three (P1.13, P1.16, and arguably P1.8) are *extensions* — nothing in them was refuted; they
grow to absorb the credential lifecycle and richer audit chain. The genuinely dead material is
concentrated: P1.6's dispatch half, P1.1's front door, P1.4/P1.8's phantom SwarmClaw engine,
P1.19's dispatch line, P1.15's warren conditional — roughly **5 stories' worth of mechanism
prose across 10 files**, while their contract surfaces (the PR #97 hardening) survive verbatim
and are already enumerated in §3.

The real volume is not the rewrites — it's the **net-new columns**: the TS phase-engine core
(step 1), the entire credential/provider layer (step 2), fleet fan-out (step 3), and the
visualizer (step 4) have no story ancestry at all. Eyeballed against the old sizing, surviving
intent covers roughly the old 68 phase-1 points' *contracts* but only about half their
*mechanism*; the net-new steps 1–4 material is plausibly another 30–45 points of authoring on
top of re-derivation. Expect the derived backlog to be **larger** than the retired one, with the
growth concentrated in steps 1–4 — and remember the throughput baseline (~45–50 pts/4 weeks)
means this is a multi-sprint superstructure, sized properly at story authoring per §8.

---

## 5. P0.3 dev-record correction (applied)

Mandated by design §3.1 row 6 and D9. `p0-3-mixed-model-demo.md:182` claimed "warren server
0.10.0 is installed, healthy, and CLI-verified on this host." False when recorded: the local
checkout was 0.8.4 (HEAD 2026-06-07); 0.10.0 is a real upstream tag this machine never had; the
warren CLI existed only inside the container, never on host PATH. Corrected 2026-08-11 with a
dated strike-through correction (no history rewrite); notes the checkout now sits at v0.14.1
(local mods stashed as "pre-adversarial-review") and that the story's only live evidence is the
`QDS_TEAM_RUNNER=local` subprocess run. CC-2's "verified against warren 0.10.0" amendment
(line 147) was container-side verification and stands as written, with that reading now explicit
in the record.

---

## 6. Coverage holes & surprises (the point of doing this now)

1. **The channel layer has no build-order step.** P0.8 retired, P1.10's Telegram half re-derives
   into tier-1 steering, P1.2 keeps issue creation — but nothing in §8 builds the
   channel↔factory bridge (Telegram/Hermes intake) that step 5's "channel → fleet" and §5.3's
   "channel/operator →" assume exists. OQ-3 is still BLOCKED-on-creds with the Hermes fallback
   only *recorded*, never exercised. Either a step-3/5 sub-story or an explicit "operator-CLI
   only for v5.0" decision is needed.
2. **The PR-feedback fix loop is unslotted.** P1.18 (KEEP) + P1.19 (RE-DERIVE) form the
   "factory maintains its own PRs" capability; §8 ends at step 7 with no home for it. It is also
   the nearest production kin of step 0's DoD (team makes a suite green). Needs a named step or
   an explicit deferral.
3. **The visualizer has zero story ancestry.** Step 4 is a D6 adoption decision with no prior
   acceptance criteria anywhere in the 30 stories — derivation starts from the SSSF reference
   docs + the F11 confidentiality constraints (§6.7) alone.
4. **OQ-4 survives the redesign untouched.** Hindsight has never booted (arm64 libpq/openssl@3;
   port 8888 collides with a local Jupyter). It red-flagged phase-0 (gate clauses 6/7), capped
   P0.9, and step 6 depends on it — no §8 step, gate, or risk row assigns it an owner. The v5
   design's §5.4 "wired after the execution spine is live" defers the *wiring*, not the *wall*.
5. **P0.7's bridge premise needs amending regardless of v5.** `hindsight-local-mcp` is an HTTP
   server, not the stdio binary the AC specifies — gate clause 6 said "may be unachievable as
   specified" and no disposition here fixes that; the step-6 re-wiring inherits it.
6. **Spend containment — the sales story — has never fired live.** D8's pitch is spend
   containment, yet the only cap evidence anywhere is P0.4's structural check ("no live
   loopy-prompt run has ever been executed"). Step 2's credential tests should include a live
   cap-hit kill, or the enterprise pitch rests on an assertion nothing has demonstrated.
7. **SwarmClaw's residual role is undefined.** Engine stories re-derive onto the phase engine;
   §7 keeps SwarmClaw as "host-side service chassis," but no surviving or re-derived story says
   what it *does* in the three-tier world (registry? webhook receiver? nothing?). P0.7's
   DONE-KEEP assets need a stated v5 role or they drift.

---

## 7. Open pre-derivation gates (not this audit's scope)

**Pre-closure snapshot — addendum:** this section records gate status as of this audit's
writing. `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` (written after this
audit) is the authoritative source for current status: F6 CLOSED, F8 CLOSED for derivation (with
two binding conditions before any price sheet), F13 CLEAR-with-conditions, all with a GO verdict.

Per §8: **F6** step-0 DoD run (written, must execute first — nothing else starts),
**F8** unit-economics model at API pricing, **F13** `@mariozechner/*` pi redistribution
licensing (blocks the step-2 OCI image contract). All three remain **OPEN**. This document
closes **F14**.
