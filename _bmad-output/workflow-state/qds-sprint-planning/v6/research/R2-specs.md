# R2 — Specifications & Dispositions Research (v6 derivation)

**Agent:** Research Agent 2 (specs/dispositions). **Date:** 2026-10-01. **Read-only pass; this file is the only write.**
**Consumer:** v6 story writers. Every fact carries its source path. Quotes are verbatim unless marked [paraphrase].

---

## 1. HANDOFF — `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-17-swarmclaw-kg-integration-HANDOFF.md`

### 1.1 THREE stacked status layers (read in order; newest wins)

1. **2026-09-14 body** (original): v5 mid-sprint snapshot — 33 done / 9 ready-for-dev; Wave-9 campaign state; PR #255 open. Stale in five places per layer 2.
2. **STATUS UPDATE 2026-09-30** (read SECOND): 6 of the 9 DONE (DF3.6a/3.7/3.8/5.3/5.4/6.1a); remaining DF6.1b, DF5.5, DF3.6b. Tier C "NOT approved" **partially superseded by ADR-1** (ACCEPTED, operator-signed 2026-09-30, PR #387): "`external_job` adapter driving `factory_run` is the approved narrow form — fleet CLI stays the substrate, D6 intact, front door unchanged. Full Tier C drift (events→platform UI, reversing D6) is still out." OpenRig program COMPLETE/CLOSED (SC1 protocol-engine fixes swarmclaw PR #644; SC2.6+SC2.7 live green, 11-round evidence `_bmad-output/evidence/openrig-sc2/`; #380 `w:` work-key namespace sanctioned; #382 poller race closed; #388 evidence hardening). DD-7's "dormant-retained" premise stale: "swarmclaw is awake as protocol orchestrator over the factory adapter." GitHub Actions billing outage noted (since verified functional 2026-10-01). Epic S/M sketches (Phase 3) declared stale: "Derivation session writes against THIS reality, not the 09-17 sketch."
3. **SUPERSEDED banner + STATUS UPDATE 2026-10-01** (read FIRST — newest): v5 CLOSED 42/42 / 169/169 (PR #399 → 5feaeec6). Operator ruling: **all remaining ops DEFERRED, documented, not abandoned; zero agent spend** until re-opened: (1) image-pin CI red — two conditions: `base-drift` fires BY DESIGN (upstream exeuntu weekly rebuild, "the job's own output says NOT an incident"); `DEFAULT_IMAGE_REF ee802669…` MANIFEST_UNKNOWN on GHCR = "Real red on every dev push until the full re-pin ritual (re-pin base → rebuild → re-sweep → publish via publish-exedev-image.yml → adopt in driver.ts) or a documented exception." (2) Vultr VPS deploy — plan of record = runbook + closure plan, "box state and every `[OPERATOR-GO]` gate await the operator." (3) G5 pairing round — deferred per `.unlazy/df3-6b/GATES.md` (env needed: `QDS_E2E_FIX_PR` + records dir + `fix-scope.json`).
   **The pivot:** "next program = factory ↔ zeropoint/swarmclaw integration — the factory/OpenRig pieces fired off by swarmclaw DAGs via the CLI/adapter. This BROADENS the already-live narrow form rather than starting from zero."
   **Supersession clause:** "This file's ground-truth seams (§Ground-truth) remain accurate and binding; its Phase-3 epic sketches (Epic S/M) are superseded by the charter's story tables."

### 1.2 Which skeletons are superseded and why

- **Epic S — "SwarmClaw drive+observe" (S1 platform agent skills; S2 heartbeat jobs invoking DF3.8 sweep + DF6.1b CI poll + DF3.7 approval pings; S3 run status into chat/UI), 3–4 stories ~10–13 pts — SUPERSEDED.** Why (per layers 2+3): S2's approval pings + run-status/notify and S3's path now have a LIVE substrate (SC2 protocol branch → `factory_result` artifact → `branch_taken` witness; scrypt-gated `fleet approve` proven end-to-end). Successor = charter Epic Z (Z1/Z2 adapter contract v2 + fork-side triggers; renamed from "S" because S-IDs collide with E21-Sxx namespaces — charter DD-14).
- **Epic M1/M2/M3 sketches — SUPERSEDED by charter Epic M.** M1's `qds-` prefix discipline "has a landed precedent (the `w:` namespace)"; M2's gateway/`kg_recall` shape survives into charter M2.1/M2.2; sketch-M3 (in-box write-back) is PARKED per charter (F10/INV-7 — sanitized write-back via review harvester is the later shape).
- **Epic S total ≈ "8–10 stories / 25–30 pts" estimate — stale;** charter slate is 23 stories / 81 pts across v6a+v6b.
- **P2 fold directive (from layer 2):** "the never-scheduled P2 phase-2 memory epic (13 stories, `_bmad-output/sprint-artifacts/phase-2/README.md`) overlaps the M-ladder — fold or supersede there." → charter DD-15.

### 1.3 Ground-truth seams section — VERBATIM (binding; bracketed notes are mine, not the doc's)

> ### Ground truth (verified, with refs — re-ground here, don't trust memory)
>
> #### What happened to SwarmClaw in v5 (documented, deliberate — 2026-08-11)
> - `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`: DD-7 — "SwarmClaw = host-side service chassis… NOT the factory front door… dormant-retained for step 6"; DD-1 — "operator-CLI-only… the operator is the channel".
> - `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`: D2 (no DAG), D3 (front door = tier-1 Claude Code + fleet CLI), D6 (SSSF-ported TS phase engine), D8 (one-secret-per-box, no push cred in box), §6.3 egress unfenced (exe.dev has no per-VM egress control), §5.3 run flow ends "→ memory capture into Hindsight banks" (step 6).
> - `2026-08-14-df-v5-autonomy-horizon-review.md`: v5.0 stays pull-driven; future autonomy enters "as new D-numbers through the normal review flow — never as quiet scope growth."
> - Phase-2 memory epic (13 stories incl. P2.4 swarmclaw DAG-node capture): authored 2026-06-19, NEVER scheduled/built. `_bmad-output/sprint-artifacts/phase-2/README.md`.
>
> #### Factory seams (what integration plugs into — all verified in code)
> - Front door: `bun scripts/fleet.ts <verb>`; closed registry `src/fleet/verbs.ts:73-431` (dispatch|status|harvest|teardown|fanout|rank|approve|reject|attach|enrol|unlock|run); exit codes 0–6; stdout=output, stderr=JSON.
> - Engine runs IN-BOX: systemd qds-run@\<id\> (transient, Restart=no) → /usr/local/bin/qds-engine → scripts/pipeline-run.ts; terminal marker /run/qds-run/\<id\>/journal/final.json.
> - Resident = prompt oracle (one zod SteeringDirective, src/phase-engine/steering.ts:5-8). Workers = pi subprocesses; TOOL GRANT MECHANISM = pi extensions `-e <path>` + skills (cli-anything/scripts/team-lead-driver.ts:376-401). cli-anything has NO MCP client.
> - Steering: /run/steering tmpfs, host writes inbox.ndjson (8k fold budget), box acks only.
> - Host-side Hindsight REST client EXISTS: src/hindsight/client.ts (bank-scoped retain/recall/reflect/consolidate) — NOT in box image COPY set (Dockerfile:277-305).
> - Hard constraints: one-secret-per-box (D8); INV-IBOX-1 no creds in image layers; assertNoResidentCredentials on briefs (scripts/pipeline-run.ts:1064, called :3225); CHILD_ENV_ALLOWLIST (src/fleet/resident.ts:237-252); F10 nothing in-box trusted at boundary; new box files move deriveBuildId → full re-pin ritual (Dockerfile:53-57).
> - No host daemons/cron/launchd exist. github.ts:199-204 has documented non-keychain stdin fallback (VPS-safe).
>
> #### Platform KG (live-verified 2026-09-14 on operator Mac)
> - Hindsight = self-hosted sidecar ghcr.io/vectorize-io/hindsight:0.8.6, docker-compose.yml:220-230; internal http://hindsight:8888; host 127.0.0.1:18889.
> - **Native streamable-HTTP MCP endpoint: POST http://\<host\>:18889/mcp — 28 tools** (retain/sync_retain/recall/reflect, bank CRUD, entity-graph, mental-models…).
> - DANGER: server answered 200 with NO auth header; bank_id is a per-call arg, NO per-bank auth — any reaching client can stomp tenant banks (2026-08-11 foreign-bank incident precedent). NEVER expose 18889 publicly as-is.
> - Platform agents access in-process (reactive-grounding-extension.ts injects \<kg_context\> from POST .../memories/recall) — pattern to COPY for factory M1.
> - Bank families: solstice-l2-\<tenant\>, solstice-soul-*, solstice-agent-*, solstice-meta, solstice-l3-*. Factory MUST use its own `qds-` prefix, explicit bank_id every call.
> - Config: SOLSTICE_HINDSIGHT_BASE_URL, SOLSTICE_HINDSIGHT_BANK_PREFIX, Bearer HINDSIGHT_API_TENANT_API_KEY (solstice-config/index.ts:284-291), hindsight.env gitignored.

**[Annotation — dated deltas vs the verbatim text above; the charter (§2.1) is current where they differ:]**
- Factory seam list shows **12 verbs**; charter: "**The HANDOFF's '13 verbs' is stale — 16 is current**" (`src/fleet/verbs.ts:73-431` closed registry adds `observe, submit, result, cancel`). Writers cite 16.
- Platform KG section describes the **shared platform Hindsight 0.8.6**; charter D-2 re-pins factory to a **dedicated Hindsight 0.10.0** (`config/hindsight-version.txt` in the fork pins 0.10.0; CI rejects `:latest`). The no-auth danger and 18889-exposure rules still govern; the M2 gateway is the fix-by-topology.
- DF5.5 landed 2026-10-01 (PR #391): "`SWARMCLAW_FACTORY_FLEET_CLI` — swarmclaw never learns QDS's driver grammar; `--driver exedev` lives only in the deployed wrapper" is IN the landed Amendment D blockquote.

---

## 2. ADR-1 — `docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md`

**Status:** ACCEPTED — signed by the operator 2026-09-30; "the program is closed" (closed record — never edited; charter §0 rule).
**Reverses:** DD-7 ("SwarmClaw = host-side service chassis … NOT the factory front door").
**Scope of reversal (verbatim):** exactly the research memo's row — *"SwarmClaw hosts macro processes via `external_job`; the fleet stays the only way code changes enter"* (`docs/planning/2026-09-23-openrig-swarm-integration-research.md:403`). "No further."

### The decision (4 numbered clauses, near-verbatim)

1. "SwarmClaw hosts macro processes via `external_job`." A macro process = swarmclaw protocol whose consequential step(s) are `external_job` steps. Swarmclaw owns process state, scheduling, branching, notification; "the QDS fleet owns provisioning, spend, execution, and the verdict."
2. "The fleet stays the only way code changes enter." Every code-affecting run is a fleet run: brief-validated, budget-gated, box-isolated, harvested, and (until ADR-2) human-approved. "Nothing in swarmclaw executes code changes on the operator's host or merges anything by itself."
3. **The approve gate is the ONE seam this ADR relaxes.** DD-7's front door amended: "the door now also opens through a swarmclaw protocol that ends at the gate. **The gate itself does not move — `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only.**"
4. **Auto-approve is out of scope.** "Relaxing the gate to a policy (factory-run PRs auto-merged by default, QA owned by 24/7 Hermes agents in swarmclaw/zeropoint, consuming `fleet result`'s payload as the QA verdict carrier) is its own future ADR and is explicitly NOT decided by this document." → this is exactly charter G1's ADR-2 DRAFT scope.

### Contract + accepted gaps (Consequences, near-verbatim)

- "`ProtocolExternalJobConfig` shape (repoSlug/repoUrl/commitSha/manifestPath, exactly one of issueId|workId, groupCapUsd, pollTimeoutMs) is the macro-process → factory contract; grammar changes go through both sides' reviews (#380's identity-grammar finding is the live example)." Charter adds fork-verified fields: `commitSha(40-hex)`, `pollTimeoutMs(default 1h)`, `onFailure` (`fork src/types/protocol.ts:148`).
- Accepted gap #380: "headless `workId` briefs not booking spend (#380 — macro work carries a numeric issueId for now)." NOTE vs HANDOFF layer 2 calling `w:` "sanctioned spend booking": the **namespace is sanctioned; the spend-booking path for issueless briefs is the accepted gap.** Writers must not conflate the two.
- #382 poller race — FIXED post-draft (QDS PR #383): "the chain now pre-registers the approval gate BEFORE its teardown closes the record … no poller tick ever reads a pre-approval terminal verdict — the round-5 park mitigation is retired, and the SC2.7 exit test re-ran LIVE GREEN 2026-09-30 with one daemon straight through observe → approve → branch."
- "DD-7's query-surface chassis role stands unchanged; this ADR only adds the `external_job` hosting role on top of it."

### Tier A/B/C taxonomy — FINDING

**ADR-1 never uses the Tier B/Tier C labels.** The taxonomy exists ONLY in the HANDOFF layer 0/1: "Tier B (events→platform UI — DF4.x SSSF visualizer already covers run views), Tier C (factory as SwarmClaw protocol runs — reverses D6, months, full v6 decision only)" and layer 2's partial-supersession note. **No "Tier A" is defined anywhere** in these docs (grep across `docs/` + sprint-artifacts: only the HANDOFF and the charter mention Tier B/C). DD-19/G1 writers must therefore define the tier terms IN the reconciliation note rather than assume a shared taxonomy — and must not invent a "Tier A."
Per charter DD-19: v6 adopts macro hosting, schedules, bot residency, approval/notification surfaces ("partial Tier B via `factory_result` artifacts + chat digests"); **D6 stays unreversed** (in-box engine, host authority, fleet front door); "full Tier C drift remains out."

---

## 3. Jev handoff — `_bmad-output/typesafe-integration/handoff.md`

Created 2026-09-22. "This file is the SOURCE OF TRUTH for this work." Charter D-5: §3 is "the authority for anything it doesn't amend."

### 3.1 §3 LOCKED decisions (verbatim, all 12; #3 is the one D-4 supersedes-refines)

1. **Host-side placement.** In-box rejected: a judgment computed in-box is box output; the host's founding lesson is never trusting box output for control flow (feedback-run.ts INV-7, classifyDiffScope, admission guards). Machine-state-only rejected: leaves nothing semantic to judge.
2. **Budget: infrastructure tier.** No per-run budget admission for Jev calls. They are code-initiated, batched, stage-scoped — cannot spiral (repo's existing line: unmetered key-mgmt vs metered agent spend). Cost observed via envelope usage + one stage-level ceiling (circuit breaker) + monthly bill alarm. At $0.042/Mtok a 19-finding triage ≈ $0.0008 — metering would cost more than a year of spend.
3. **No SDK dependency.** package.json stays `yaml`+`zod`. Build on `src/lib/http.ts` + zod schemas, mirroring `src/hindsight/client.ts` (schemas + mock mode + tests). Avoids SDK/Bun-compat unknowns and re-unifying a wrapper the repo already unified once.
4. **No audit-chain changes.** `AUDIT_HOPS` (src/audit/link-store.ts) is a frozen ten-hop contract; a new hop rewrites `complete` semantics and breaks historical walks. Judgments land in the run-record side channel … All emitted `detail` must be DIGEST-STABLE — store reports `divergent` (tamper alarm) when the same subject re-emits with a different evidence digest; credentials.ts hit this bug class 3×. Volatile fields (answer values, confidence) ride log lines, not store rows.
5. **Recording-only until measured.** gate-runner untouched (its semantics have no home for uncertainty: skip ≠ pass, empty = FAIL). No Jev answer gates anything in waves 0–4.
6. **Model pinned, contract-tested.** Pin `jev-1.13.0` — NEVER the `jev-latest` alias (docs themselves advise pinning; aliases repoint silently). Contract test in the `tests/gitnexus/` pattern: strict schema on response shape + pinned model id, the ONE suite allowed to fail loudly on upstream drift. Re-calibration ritual documented alongside.
7. **Typed egress classes, staged.** `machine-state | finding-text | ac-prose | diff-hunk`. Every seam declares what it ships; config selects max class. Stage 1 = finding-text + ac-prose. Stage 2 (diff hunks) is HARD-GATED on an executed ZDR addendum with defined retention + deletion clauses — the published DPA has none (verified 2026-09-22: only "as long as necessary"). steve owns the vendor email; this work stream NEVER contacts TypeSafe itself.
8. **Redaction designed for the whitelist, not reused.** `redactSecrets` (step-log.ts) is a targeted pattern redactor, NOT a diff scrubber — and is lossy both ways (audit/chain.ts had to stop routing join slugs through it). The choke-point function (§7 Wave 2) validates egress class + redacts per class.
9. **No severity calibration.** Whole triage history has ≈3 positive BLOCKER examples. Calibrated questions: binary `is_real_defect` (noul) + `disposition` (choice: patch/dismiss/gate-action) only. Severity stays with the frontier session.
10. **S1 is a pre-router, not a replacement.** Code-grounded adjudication ("verified against real source by the lead") stays frontier. Jev adds a calibrated prior that routes findings into deep-adjudication vs obvious-dismiss. Cost-replacement claims are retracted; value = routing precision + measured calibration curve.
11. **Corpus capture precedes everything.** … each triage emits `{finding_text, diff_context_ref, label, disposition, labeler, round, created_at}` as schema'd records; backfill of the 16 existing ledgers is best-effort and honestly labeled `agreement-with-claude`.
12. **A/B measurement is part of the mission, not an afterthought.** Same findings flow to BOTH arms every round: arm `frontier` = existing lead triage (as-is, unchanged), arm `jev` = observer. Metrics, defined NOW in the corpus schema: per-finding `latency_ms` (both arms), cost — exact for Jev (response `usage` × $0.042/Mtok), estimated for frontier (documented cost model on session duration — labeled `estimate`, never passed off as metered), performance = agreement-with-lead per question +, as rounds accumulate, outcome-validated precision (`outcome_confirmed`/`outcome_source` fields filled by later rounds). No speed-vs-performance-vs-cost claim ships without this table behind it.

**D-4 supersede-refine of LOCKED #3 (charter D-5, verbatim):** "D-4 supersedes-refines the Jev handoff's LOCKED #3 ('no SDK') wording — **still no SDK, now behind a named seam.** All other Jev LOCKED decisions hold verbatim: host-side placement, recording-only until measured, no severity calibration, thresholds-in-code, stage-2 diff-hunk egress ZDR-gated, ceiling + bill alarm." I.e.: #3's *mechanism* (build directly on http.ts+zod) gains the `JudgmentProvider` adapter seam; the *no-SDK conclusion* is unchanged. Every other LOCKED item holds as written.
**L6 park rationale (charter):** in-box tool-call guardrail hooks conflict LOCKED #1 host-side placement → PARKED DD-21; "re-adjudication = new D-number + evidence of need."

### 3.2 §4 Vendor facts (verified 2026-09-22 — binding)

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`. Request `{model, state, questions}`; questions map of `{type: noul|choice|score, instructions, criteria?}`. Response `{model, answers: {<qid>: {type, noul|choice+probabilities+confidence|score+legend+probabilities+confidence}}, usage}`. Errors 401/422/429/529 — **backoff-retry 429/529**.
- Limits: **64k tokens/request; 32k for state + longest question; 250k tok/s; 1200 req/min. Input-token billing only.**
- **`noul` returns a NUMBER — the probability of yes, 0 (no) to 1 (yes) — NOT a boolean.** (CORRECTED 2026-09-22 live-probe catch; the drift alarm "FIRED AS DESIGNED on its first wire contact"; contract json + schema + mock + 8 test sites fixed in one commit.) Majority-read rule in the report: "p>0.5, no gating use."
- `jev-1.13.0` pinned; `jev-latest`/`jev-preview` alias it today — never pin the alias.
- 1.13 jaggedness to route around: literal reading; unreliable counting/numbers (compute in code); dates as text; indirection cost; context rot on large state (→ small per-finding states, batch across requests); state not treated as hostile (→ explicit criteria + choke-point handling); no arithmetic identities between questions (never compare a noul threshold to a choice probability); **no generation ever.**
- ZDR: offered for enterprise per docs pages, NOT in the published DPA. Subprocessors: trust.typesafe.ai/subprocessors, 15-day objection right.
- Live baseline (jev-live-r1, 2026-09-22): 108/108 findings judged, 88.0% disposition agreement with the human-confirmed lead, $0.00223 exact, mean latency ~220ms. Charter cites: "88% disposition agreement / 108 findings / $0.002, ~220ms."

### 3.3 §8 Guardrails (verbatim list; "violating any = stop and surface")

- `TYPESAFE_API_KEY` never hardcoded, never logged, never enters a box; read via env at client construction only.
- No diff hunks or third-party bot prose shipped to the API in stage 1 (finding text authored by the lead + AC prose only; bot-comment text stays behind the feedback-run INV-7 fence).
- Never edit: `AUDIT_HOPS`, `gate-runner.ts` verdict logic, `classifyRunExit`, `classifyDiffScope`, provider layer (§5 layering rule). New code only + the one capture hookpoint.
- No real API spend without explicit steve go in chat; mock mode is the default everywhere.
- Subagents never commit to `dev`, never push, never open PRs. Orchestrator commits with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Corpus records containing finding text stay in-repo under `_bmad-output/` (already the home of such artifacts).

### 3.4 Layering + DoD facts writers need

- Layer rule (§5): `src/providers/` imports no tier-3 workspace code (R3 §9.2) — "new `src/judgment/` must sit above providers or beside lib." Wave-0 outcome: `src/judgment/` imports ONLY `src/lib/http.ts` + `swarmclaw/log` (hindsight precedent); side-channel emit = side JSON log keyed by requestId, default `_bmad-output/judgment/envelopes/` (provider edit banned).
- §9 DoD item 6: "`arm-thresholds` is explicitly NOT done — it waits for measured calibration + steve sign-off." → charter J2's gate (calibration milestones + explicit operator sign-off AC) is the same bar, now written into the unlock gate (DD-21).
- Bill alarm is OUTSIDE the repo (§10): "owned by steve in the vendor billing console … no story implements it (settled Wave 5, JEV2-V9)."
- Observer flag ritual: live requires `TYPESAFE_API_KEY` + `QDS_LIVE_PROBE_CONFIRMED=1` (refusal observed live, exit 2).

---

## 4. Standing rule — `docs/superpowers/specs/2026-08-14-df-v5-autonomy-horizon-review.md`

**Status:** NOTE — "proposed recommendation, not a decision. Extends D1/D2/D4/DD-1; amends none of them."

- **The standing rule (verbatim, §4.3):** "Any future autonomous trigger follows one pattern, codified as a decision when the first one is adopted: deterministic signal first (code, not an LLM, decides a run is warranted …), graph-bounded diagnosis where investigation is needed, existing gates/budgets/escalation unchanged. **Expansion enters the design doc as new D-numbers through the normal review flow — never as quiet scope growth in a story AC.**"
- §4.1: "v5.0 stays pull-driven. No change to DD-1." (Now extended, not contradicted, by ADR-1's narrow form.)
- Common shape (§3): "code decides a run is warranted; the LLM only ever investigates or executes against a pre-verified signal."
- DF6.1 named "the sole event-driven surface," with its *internal* diagnosis arc flagged unbounded (no deterministic pre-filter; no graph constraint on hypotheses) — the gap "any autonomy expansion would inherit and amplify." Charter J3/J4's L3-scoring and L8 pre-filter legs are the deterministic-signal-layer pattern applied; A-epic stories should cite this pattern, not weaken it.

---

## 5. Terminology trap — `docs/planning/qds-factory-4-week-execution-and-spike-plan.md`

Load-bearing sentences (verbatim, §2 callout):

> ⚠️ **Terminology trap — "Hermes."** The PRD uses "Hermes" for the 24/7 *department-manager* agents (Dev/QA/Maintenance). Operators colloquially also call the **proactive cron agents** (Synthesizer, Meta-Optimizer, Blind-Spot Detector, Review Harvester) "Hermes bots." This document uses **"cron agents"** / **"proactive agents"** for the scheduled memory agents and **"department manager"** for the orchestration managers. **Disambiguate explicitly in any new artifact.**

Also from the reconciliation table (§2): "The sprint stories are ground truth; the PRD/architecture docs are partially stale" — department managers row shows older docs' "Hermes agents (Dev/QA/Maintenance)" vs the (then-)active "Dev Manager via A2A"; the charter revives the department-manager vision as v6b A1/A2/A3 E21 Home bots. Writer consequence: v6 stories must say "department manager (Home bot)" vs "proactive/cron agent" explicitly — the two populations split across v6b A-epic vs PARKED DD-23.

---

## 6. VPS runbook — `_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md`

**Status:** DRAFT — "Nothing in this runbook has been executed"; every `[OPERATOR-GO]` needs explicit operator go. Closes P0.5/P0.9, OQ-4, DD-4 update. Frozen-decision basis: x86_64 Linux dissolves the arm64-mac libpq/openssl wall and the :8888 Jupyter clash.

### G1–G9 gate register (§9, one line each, all operator)

| Gate | What | Kind |
|---|---|---|
| G1 | Vultr instance creation | spend |
| G2 | DNS + firewall | config |
| G3 | `hindsight.env` + `.env.local` placement | credentials |
| G4 | Clerk/Google/Azure OAuth consoles | credentials, external |
| G5 | certbot issuance | DNS/HTTP-01 |
| G6 | swarmclaw clone/branch on box + bring-up | decision (which lineage) |
| G7 | QDS-Factory clone on box + `.env` secrets | credentials |
| G8 | backup timer enable | decision |
| G9 | (deferred) GHCR image publish — "owned by E01-S06, not this runbook" | — |

### Hard rules writers must carry

- **Box shape (§1):** x86_64 (amd64), **Ubuntu LTS 24.04**, ≥8 GB RAM + ≥80 GB NVMe (Hindsight downloads models into `hindsight_hf_cache` on first boot); "~$20–40/mo tier suffices."
- **Firewall (§1.2, verbatim):** "allow 22 + 80 + 443 ONLY. **Never 18889.**"
- **Hindsight secrets:** `hindsight.env` (`env_file`, gitignored, never commit): `HINDSIGHT_API_TENANT_API_KEY`, `HINDSIGHT_API_LLM_API_KEY` (OpenRouter); provider/model pins stay in the committed environment block ("Committed `environment:` wins over `env_file` — do not 'fix' provider/reranker pins in hindsight.env").
- **`.env.local` (§3.2):** `SOLSTICE_PSEUDONYM_KEY`, **`SOLSTICE_TENANT_ID` (required — "fence refuses to boot without the tenant pin", compose :423–426)**, `SOLSTICE_ADJUDICATOR_BEARER`, plus production Clerk/OAuth vars.
- Multi-arch INDEX digest rule (QEMU-on-Apple-Silicon incident); always bring up BOTH compose files (`app-startup.md` rule).
- First boot (§5) is the OQ-4 step: model init up to 1320s healthcheck start_period / `HINDSIGHT_API_MODEL_INIT_TIMEOUT=1200`; assert `curl -s http://127.0.0.1:18889/` answers; boot evidence → `_bmad-output/evidence/p0-9-closure/`.
- Factory on box (§6): `bun scripts/fleet.ts <verb>` front door; GitHub token via **piped stdin** on Linux (`src/pr/github.ts:252–284`; keychain is macOS-only by code); factory `.env` sets `HINDSIGHT_BASE_URL=http://127.0.0.1:8888` (on-box compose network) + `HINDSIGHT_BEARER_TOKEN`/`HINDSIGHT_API_KEY` + `SWARMCLAW_*` allowlists + `QDS_RUNS_DIR`; then `bun scripts/provision-hindsight-banks.ts` (qds- prefix).
- Smoke (§7): all 7 services healthy; TLS on 443; `curl -m 3 http://<box-ip>:18889` fails from outside; one read-only `fleet status` + `fleet approve` dry path (stdin token); then hand off to the closure plan ("the VPS milestones here (set 5: Hindsight up; 6: CLI + banks; 7: smoke) are exactly the milestones that plan's evidence legs consume").
- Charter note (§2.2): the Solstice vultr-deploy template (`/Users/steve/Solstice/.claude/worktrees/vultr-deploy` @ d0c513fa, `deploy/control-plane/{Caddyfile,docker-compose.yml,backup.sh}`) is "intended TEMPLATE for the integrated stack once it lands (do not treat QDS runbook and template as independent deployables)" — charter Z4 extends it.

---

## 7. P0.5/P0.9 closure plan — `_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md`

**Status:** DRAFT; "execution waits on the Vultr VPS milestones in [the runbook] §5–§7. Nothing here runs until the box exists." Issue #51 CLOSED (created the 2026-07-28 `done→in-review` downgrade; no reopening). Targets: `sprint-status.yaml:124` P0.5 → done, `:128` P0.9 → done "with per-item evidence, never by waiver (option B-via-evidence)"; DD-4 updated (OQ-4 confirmed resolved on x86_64 Linux).

### Five P0.9 legs — "all five open items settle on ONE wall (Hindsight never booted)"; precondition = runbook §5 (Hindsight healthy) + §6 (CLI + qds- banks)

| Leg | Evidence file | Proves |
|---|---|---|
| hindsight-live | `…-p0-9-hindsight-live.json` | Hindsight boots on x86_64 Linux — OQ-4 wall gone; health 200 |
| provision-and-import | `…-p0-9-provision-and-import.json` | three qds- banks exist; Mulch imported into `qds-factory-dev-meta` |
| round-trip-via-bridge | `…-p0-9-round-trip-via-bridge.json` | AC1 (make-or-break): retain→recall→reflect→consolidate through SwarmClaw's MCP `/invoke` on `resolveBankId(repoSlug)`; AC2 recall `sparc` from `.mulch/expertise/qds-foundations.yaml` < 5s |
| negative-probes | `…-p0-9-negative-probes.json` | AC3 non-existent bank → `MCPInvokeErrorResponseSchema` 502; AC4 bridge unregistered → -32001, zero banks; AC5 unavailable → -32002, zero banks |
| idempotency-rerun | `…-p0-9-idempotency-rerun.json` | recall idempotent; no partial bank creation on failed provision |

Settles P0.9 DoD 5 (split proof), 7 (recall assertions), 9 (MANDATORY e2e), 10, 11.

**How they ride M1.1 (charter):** M1.1 = "Dedicated Hindsight 0.10.0 on VPS (re-pin), `qds-` bank provisioning, round-trip verify (`src/hindsight/round-trip-verifier.ts`), no-auth danger retired-check. **P0.5/P0.9 closure evidence rides this story's legs**" (dep Z4, live tier infra).
**⚠ M1.1-writer tension to resolve:** the closure plan's round-trip-via-bridge and negative-probes legs are written against the **shared platform Hindsight via SwarmClaw MCP `/invoke`** — a 2026-09-30 premise. Charter D-2 (2026-10-01) moves the factory to a **dedicated** Hindsight behind the M2 gateway. M1.1's spec must re-home the bridge leg's transport onto the dedicated instance (REST `src/hindsight/client.ts` / gateway / `round-trip-verifier.ts`) while keeping the AC semantics (retain→recall→reflect→consolidate; negative probes; idempotent provision), annotating rather than re-litigating — the plan's own discipline ("annotate the AC rather than re-litigate DD-5").

### Three operator flags to settle BEFORE the round (one-line decisions, recorded in the reconciliation update block)

1. AC5 probe semantics — "Hindsight binary not on PATH" wording predates the Docker sidecar; the negative probe stops the CONTAINER (decide + annotate; do not edit the AC).
2. Transport — P0.7/P0.9 contracts assume stdio (`hindsight-local-mcp`); live platform Hindsight is streamable-HTTP `:8888/mcp` (DD-5 records the broken premise). The e2e drives the **HTTP** endpoint; annotate the AC rather than re-litigate DD-5. (Charter DD-17 supersedes DD-5's stdio premise formally.)
3. Bank discipline — shared platform Hindsight has NO auth and NO per-bank auth; pin explicit `qds-` bank IDs; 18889 never public.

### P0.5 open items — "four legs need a live agent substrate, one is editorial"; precondition = runbook §7 box + Pi agent with working LLM auth (OpenRouter key on the box) + gitleaks or trivy installed

| Leg | Settles | Shape |
|---|---|---|
| mode-json agent e2e | DoD 9 (MANDATORY, "never run, LLM auth") + DoD 4 (payload on `--mode json` stdout, not MCP stdio) | Pi agent `--mode json` against a TS file with a planted type error → `lsp_diagnostics` JSON ≥ 1 finding, stable `aw:<hash>` IDs |
| secret-scan emit-block | DoD 6/8 (NFR-SEC-3 + INV-1) — never observed; block derives SOLELY from gitleaks/trivy `sessionSecrets` findings | agent turn over a hardcoded-API-key file → turn-end emit BLOCKED with `secret_detected` |
| python-lsp discovery | DoD 5 (pyright ran as fixture only) | real assertion: pyright LSP discovery on a planted Python type error |
| version pin | DoD 1 — **editorial, no evidence file** | spec says 3.8.47, installed 3.8.71; P1.7 says do not re-pin → amend the spec TEXT to name the floor+observed pair; `[OPERATOR]` sign-off per reconciliation §8 Q4 |

Plan deliberately does NOT: no waiver path; no AC edits on P0.9; "No 18889 exposure, no shared-bank writes outside `qds-` IDs." Evidence house style: one timestamped machine-checkable JSON per leg in `_bmad-output/evidence/p0-5-closure/` + `p0-9-closure/`, `openrig-sc2/` naming, payloads `exitCode/stdoutTail/stderrTail` + structured observability lines; "Each leg JSON is written by the leg's own driver script, not hand-copied."

---

## 8. Architecture D6 + D8 — `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (decision register, :294–307)

### D6 (line 303, verbatim) — the row DD-19 protects

> | D6 | **SDLC pipeline layer: port SSSF's design to TypeScript test-first on cli-anything; adopt SSSF's trace schema + visualizer nearly as-is and harden.** | Design is excellent; Python engine has architectural ceilings (§3.3) and would be a second language; visualizer is low-risk read-only code that buys the observability layer in weeks. | Adopt Python wholesale + harden (permanent two-language split, ceilings); build own engine ignoring SSSF (slower to observability, re-derives solved design). |

Why it matters for DD-19: D6 IS the in-box TS phase engine. "Reversing D6" (HANDOFF Tier C definition) = factory runs orchestrated as platform protocol runs instead of the SSSF-ported engine in-box. ADR-1's narrow form keeps D6 intact — macro processes are HOSTED in swarmclaw, but every consequential step still executes as a fleet run driven by the in-box engine. DD-19 states "D6 stays unreversed (in-box engine, host authority, fleet front door)." Also relevant: §10 verdict line — "architecture direction survives — D5, D6, D8 re-verified sound."

### D8 (line 305, verbatim) — the row DD-16 amends

> | D8 | **Credential architecture = inkwell lifecycle as code**: per-run spend-capped provisioned LLM keys (mint→cap→use→revoke→verify), secrets never in argv, no push credential in any box, git-bundle harvest, host-side PR creation, WIF for client-cloud access, per-box egress policy, central append-only audit log + cost ledger. | This is the sellable security story — spend containment, data containment, and audit are what close enterprise deals; kernel isolation alone is not. Aligns with existing P1.13/P1.16 concepts. | Long-lived keys in boxes; push credentials in boxes; trusting a managed LLM gateway with unanswered logging. |

DD-16 amendment shape (charter, verbatim intent): per-box credential set becomes (1) one provider secret (unchanged) + (2) one per-run **recall-only** memory key — "gateway-issued, runId + bank-allowlist + TTL bound, revoked-and-verified before destroy mirroring `credentials.ts` ordering; no WRITE credential ever enters a box (F10/INV-7 — writes are host-side from harvested evidence); egress scoped to the gateway origin." The HANDOFF's shorthand for the original D8 ("one-secret-per-box") predates this amendment; the amended set is two credentials, one of them new — writers must not regress D8's original clauses (secrets never in argv, no push credential, host-side PR creation) while adding the second.

---

## 9. Charter-contradicting facts / traps surfaced (prominent)

1. **"G5" is overloaded across two registers.** Runbook G5 = certbot issuance (`_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md` §9). The HANDOFF/charter "G5 pairing" = the DF3.6b pairing-round gate (`.unlazy/df3-6b/GATES.md`; env: `QDS_E2E_FIX_PR` + records dir + `fix-scope.json`). The charter uses both in the same ops bullet. Writers must disambiguate ("VPS G1–G9" vs "G5 pairing") or rename one in the ops-dependency register.
2. **Tier taxonomy is not in ADR-1.** Tier B/C are defined only in the HANDOFF Phase-3 note (and only B and C exist — no written "Tier A" anywhere). DD-19/G1 writers must define terms in the reconciliation note itself.
3. **Closure-plan transport premise vs D-2.** P0.9 round-trip/negative-probe legs assume shared-platform Hindsight via swarmclaw MCP `/invoke`; D-2 moved factory to a dedicated Hindsight + M2 gateway. M1.1 must re-home the legs' transport while preserving AC semantics (detail in §7 above).
4. **Image-pin red is current truth post-ritual.** The #396–#398 re-pin ritual completed 2026-09-30 (HANDOFF DF3.6b completion note) — yet the 2026-10-01 layer AND the charter both record `DEFAULT_IMAGE_REF ee802669…` as MANIFEST_UNKNOWN on GHCR today (real red, blocks every T2 round). Not a doc contradiction: a later state. Writers treat the re-pin ritual as wave-0 ops still outstanding.
5. **Verb count.** HANDOFF factory-seam list shows 12 verbs (and its 09-30 layer says "13"); charter: 16 is current (`src/fleet/verbs.ts:73-431`). Cite 16.
6. **`w:` namespace vs spend booking.** HANDOFF layer 2 calls #380 "sanctioned spend booking for issueless macro processes"; ADR-1 records the accepted gap that "headless `workId` briefs not booking spend … macro work carries a numeric issueId for now." Namespace sanctioned; booking gap open. A2/Z2 writers booking spend on `w:` keys (charter DD-20) must state which side of this gap they close.
7. **Runbook §6.3's `HINDSIGHT_BASE_URL=http://127.0.0.1:8888`** describes the shared-sidecar topology; under D-2 the factory points at its own dedicated instance (and M2's gateway origin for egress scoping). Z4/M1.1 reconcile; do not copy the runbook value blind.
8. **No contradictions found with charter D-1…D-5 themselves** — HANDOFF layer 3, ADR-1, and the Jev handoff all align with the charter's account of them (supersession claims, approval doctrine, LOCKED set, vendor facts all verified against source).

---

## 10. Writer bindings — hard facts/wording v6 story writers must not contradict

1. **Approval doctrine (ADR-1 §3, verbatim):** "`fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only." Channel ≠ policy: moving the approval surface to the E21-S05b inbox (ADR-2 DRAFT) never relaxes the gate; scripted approvers are labeled (SC2.7 precedent); approval-gate pre-registration happens BEFORE teardown closes the record (QDS PR #383).
2. **Fleet = only code-entry path (ADR-1 §2):** every code-affecting run is a fleet run — brief-validated, budget-gated, box-isolated, harvested; "Nothing in swarmclaw executes code changes on the operator's host or merges anything by itself." No Jev answer, bot, or schedule gates code entry (charter §6).
3. **Fleet verb registry:** 16 verbs, closed registry `src/fleet/verbs.ts:73-431` — `dispatch, status, harvest, teardown, fanout, rank, approve, reject, attach, enrol, unlock, run, observe, submit, result, cancel`; `--driver` required on all except `rank, approve, reject, enrol, unlock, result`; exits 0–6 (6 = work landed, output/cleanup failed).
4. **`external_job` contract:** `ProtocolExternalJobConfig{repoSlug, repoUrl, commitSha(40-hex), manifestPath, issueId XOR workId, groupCapUsd, pollTimeoutMs(default 1h), onFailure}` (fork `src/types/protocol.ts:148`); grammar changes go through both sides' reviews; boundary: `SWARMCLAW_FACTORY_FLEET_CLI` — "swarmclaw never learns QDS's driver grammar; `--driver exedev` lives only in the deployed wrapper" (landed DF5.5 Amendment D).
5. **Tier wording:** only Tier B (events→platform UI — still out; SSSF visualizer covers run views) and Tier C (factory as SwarmClaw protocol runs — narrow form approved by ADR-1, full drift still out) exist in the record; D6 stays unreversed. No "Tier A."
6. **Jev LOCKED set holds verbatim** except LOCKED #3 (superseded-refined: still no SDK, now behind the named `JudgmentProvider` seam): host-side placement; infrastructure-tier budget + stage ceiling + monthly bill alarm (bill alarm lives in the vendor console, outside the repo — no story implements it); frozen AUDIT_HOPS + digest-stable detail; recording-only until measured; pin `jev-1.13.0`, never `jev-latest`; egress classes `machine-state | finding-text | ac-prose | diff-hunk`, stage-2 diff hunks HARD-GATED on executed ZDR addendum; `redactSecrets` is not a diff scrubber; no severity calibration; S1 is a pre-router; corpus capture first; A/B table behind every claim.
7. **Jev vendor facts:** `noul` returns a NUMBER (probability of yes, 0..1 — not boolean); 64k tokens/request, 32k state+longest-question, 250k tok/s, 1200 req/min; input-token billing only; backoff-retry 429/529; small per-finding states; no generation ever.
8. **Jev §8 guardrails verbatim:** API key never hardcoded/logged/in-box; no diff hunks or third-party bot prose in stage 1 (bot prose stays behind the feedback-run INV-7 fence); never edit `AUDIT_HOPS`, `gate-runner.ts` verdict logic, `classifyRunExit`, `classifyDiffScope`, provider layer; no real spend without explicit steve go; corpus records stay under `_bmad-output/`.
9. **D8 text (original clauses intact):** "per-run spend-capped provisioned LLM keys (mint→cap→use→revoke→verify), secrets never in argv, no push credential in any box, git-bundle harvest, host-side PR creation, WIF for client-cloud access, per-box egress policy, central append-only audit log + cost ledger." DD-16 adds exactly one per-box credential: a recall-only, gateway-issued, runId+bank-allowlist+TTL-bound memory key, revoked-and-verified before destroy mirroring `credentials.ts` ordering; no write credential in-box, ever.
10. **D6 text intact:** SSSF-ported TypeScript phase engine test-first on cli-anything, SSSF trace schema + visualizer adopted and hardened; in-box engine + host authority + fleet front door all stand (ADR-1 "D6 intact"; DD-19 "D6 stays unreversed").
11. **Standing autonomy rule:** "Expansion enters the design doc as new D-numbers through the normal review flow — never as quiet scope growth in a story AC"; deterministic signal first, graph-bounded diagnosis, existing gates/budgets/escalation unchanged. All v6 decisions enter as DD-14+ / new D-numbers / ADR-2 PROPOSED — never quiet growth.
12. **VPS gates:** G1 spend (Vultr box, x86_64 Ubuntu 24.04, ≥8GB/80GB) / G2 DNS+firewall (22/80/443 ONLY, never 18889) / G3 `hindsight.env`+`.env.local` / G4 OAuth consoles / G5 certbot / G6 swarmclaw bring-up / G7 factory clone+`.env` / G8 backup timer / G9 GHCR publish (E01-S06's, deferred). All operator; zero agent spend until explicit GO. `SOLSTICE_TENANT_ID` required — fence refuses to boot without the tenant pin.
13. **KG exposure rules:** Hindsight answered 200 with NO auth at 0.8.6; bank_id per-call, no per-bank auth; NEVER expose 18889/8888 publicly; factory uses explicit `qds-` bank IDs every call; M2 gateway (recall-only keys, revoke-verify-before-destroy, Caddy allowlist from the vultr template) is the only front door (D-2).
14. **P0.9 five legs** (hindsight-live / provision-and-import / round-trip-via-bridge / negative-probes / idempotency-rerun) ride M1.1 — but their transport must be re-homed to the dedicated instance per D-2 (see §7); P0.5 legs: mode-json agent e2e, secret-scan emit-block, python-lsp discovery + one editorial version-pin spec edit (floor+observed pair, operator sign-off); evidence = machine-checked timestamped JSON per leg, written by each leg's own driver; "never by waiver"; annotate ACs, never rewrite them.
15. **Ops items stay operator-gated** (zero agent spend): image re-pin ritual (current `DEFAULT_IMAGE_REF ee802669…` MANIFEST_UNKNOWN = real red, blocks all T2), VPS G1–G9, G5 pairing round env (`QDS_E2E_FIX_PR`, records dir, `fix-scope.json`), P0.5/P0.9 closure.
16. **Terminology discipline:** "Hermes" = 24/7 department-manager agents (Dev/QA/Maintenance) in the PRD; proactive/cron agents (Synthesizer, Meta-Optimizer, Blind-Spot Detector, Review Harvester) are a DIFFERENT population — "Disambiguate explicitly in any new artifact." v6: department managers = v6b A1/A2/A3 Home bots; proactive agents = PARKED DD-23 with dated triggers.
17. **Superseded materials:** HANDOFF Epic S/M skeletons (09-17) are superseded by the charter story tables; P2 phase-2 epic (13 stories, never scheduled) is folded/superseded/parked per DD-15; DD-7 "dormant-retained" premise is dead (swarmclaw is awake as protocol orchestrator); DD-5's stdio premise dies (DD-17 superseded-form). Never edit closed records: ADR-1, the v5 DD register (DD-1…DD-13).
18. **Do not conflate `w:` namespace with spend booking:** namespace sanctioned; headless `workId` briefs not booking spend is ADR-1's accepted gap (macro work carries numeric issueId for now). DD-20 (bot-spend join on workKey+runId+botId) must say which side it closes.
