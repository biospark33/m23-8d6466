# Dark Factory v6 — Story Derivation Decision Register

**Date:** 2026-10-02 (derivation session of the 2026-10-01 evening charter)
**Status:** ACTIVE — governs the v6 story derivation
**Derives from:** the program charter
`_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md`
(operator decisions D-1…D-5 LOCKED 2026-10-01 — settled, not re-litigated here)
**Rule honored:** the v5 register (`2026-08-11-v5-story-derivation-decisions.md`) and ADR-1 are
closed records — never edited. Everything v6 decides enters here as DD-14+ and, where
architecture-level, via NEW D-numbers/ADRs. Changes never enter as quiet scope growth
(autonomy-horizon standing rule; research R2 carries it verbatim).
**Sizing/dependency evidence:** `_bmad-output/workflow-state/qds-sprint-planning/v6/research/`
(R1 story-template + P2 crosswalk + v4 clauses · R2 specs/dispositions · R3 factory code facts ·
R4 zeropoint/E21/external facts · R5 dependency/sizing), each fact symbol- or line-cited.

---

## 1. Namespace & layout (SPL-017 collision check: clean)

| Decision | Value |
|---|---|
| Epic codes | **Z** (zeropoint macro-host), **M** (memory ladder), **A** (autonomy, E21-gated), **J** (judgment tier), **G** (governance) |
| S→Z rename rationale | the sketch's "S" epic collided with the E21 `Sxx` story namespace (E21-S02b etc.); renamed to Z (DD-14, charter §4.1). **No bare S-numbers anywhere in v6 artifacts** — E21 references always cite `E21-Sxx` with repo context |
| Historical-collision note | v6's `A`/`A1…A6` IDs echo the retired RFP-Agents-era A-slate in old index prose only — no live rows, no checker rows, separate story directory; no action |
| Story IDs | `Z1–Z5`, `M1.1–M3.2`, `A1, A2, A3, A5, A6` (no A4 — rows authoritative), `J1–J4` (J5 parked, DD-23/DD-21), `G1` |
| Story files | `_bmad-output/sprint-artifacts/dark-factory-v6/stories/{id-kebab}-{kebab-title}.md` |
| Index | `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v6.md` (no slate arithmetic — sprint-status.yaml is the numbers authority) |
| Module roots | memory gateway `src/memgate/` · chassis utilities `src/lib/` (Z5) · rest per existing flat-src domains |

## 2. Slate, arithmetic, horizon

**23 stories / 81 points, two sprints** — v6a "Foundation" (11 stories / 36 pts, THE next
sprint, zero E21 gates, ships standalone) + v6b "Autonomy" (12 / 45: the E21-gated autonomy
stories **plus** the E21-independent lane — in-box memory, judgment tier, KPIs — that
consumes only v6a's substrate). Cut line restated (2026-10-02, supersedes D-1's one-liner):
*v6a ships with no E21 dependency at all; v6b holds everything sequenced after v6a's
substrate — the E21-gated stories AND the E21-independent lane, which proceeds without
waiting on E21.* The charter's "everything requiring E21 Home bots" phrasing is its closed
input and is not edited; the row-derived slate is authoritative here.

> **DD-14a — slate arithmetic re-baseline.** The charter's §3 epic table (Z16 M26 A16 J16 G2
> = 76) is stale against its own story rows, which sum Z=16, M=29, A=18, J=16, G=2 = **81**
> (R5 recount; per-sprint 36 + 45 = 81 ✓). Story rows are the slate authority (v5 doctrine);
> sprint-status.yaml and this register carry the row-derived totals. Charter file itself is
> not edited (input records are closed).

+10–15% review-growth contingency carried per DD-13 precedent (+12 on 111): v6a headroom
→ ~41, v6b → ~52 with named flex-cuts neutralizing (§ DD-26).

## 3. Decisions

| ID | Decision |
|---|---|
| **DD-14** | **Namespace + split ratified** per §1–§2 above: epics Z/M/A/J/G; S→Z rename; v6a/v6b cut line restated 2026-10-02 (v6a = zero E21 dependency, ships standalone; v6b = E21-gated stories + the E21-independent lane, which proceeds without E21) — supersedes the charter D-1 one-liner "needs Home bots", which under-counts v6b's independent lane; story paths per §1. |
| **DD-14a** | **Arithmetic re-baseline**: M 26→29, A 16→18, program total 76→81, from the story rows (R5). Rows authoritative. |
| **DD-15** | **P2 fold/supersede register** (13 stories / 44 pts, `_bmad-output/sprint-artifacts/phase-2/README.md`, never scheduled; arithmetic verified exact). Crosswalk-precise (R1 `crosswalk-p2.md`): **FOLD P2.8 → M1.2** — the *mechanism only* (stable dated `documentId` + `updateMode:"replace"`, verbatim p2-8); its Daily-Learnings/qds-product/qds-meta routing surface is NOT folded and dies with its premise. **FOLD P2.4 → Z2 observe artifacts + A5 KPI join** — P2.4's "run tree" was the P2.1 event store (it sat BLOCKED-BY SPIKE-10, never run — the fold retires an unstarted dependency); its `ProtocolRunEvent` vocabulary is the same family ADR-1's `external_job` artifacts speak. **SUPERSEDE** P2.0–P2.3, P2.5–P2.7, P2.12 by named successors: store half of P2.1 → `.sandbox` SQLite trace store (DF1.4, shipped); *recall* half of P2.1 (FTS5/KNN) → the Hindsight KG per D-2's own boundary (the supersession is two-souled and both halves are named); P2.2 → run records; P2.3 → audit chain (DF5.3, shipped); P2.5–P2.7, P2.12 → M3.1 (manager meta banks) and run-record/ledger surfaces as cited per-story. **PARK P2.9–P2.11** (A/B + confirm machinery) with Layer-B — its own park entry in DD-23 (different population from the QDS-MEM agents). **Entry-gate premises superseded**: the P2 entries gate on phase-0/1 plan IDs P0.7, P1.6, P1.15, P1.11 — all four retired premises named here (P1.11's "KEEP" is itself killed by DD-17's transport ruling). |
| **DD-16** | **D8 amendment** (architecture `2026-08-11-dark-factory-v5-architecture-design.md` D8, ~:305): per-box credential set = (1) one provider secret (unchanged) + (2) one per-run **recall-only** memory key — gateway-issued, runId + bank-allowlist + TTL bound, revoked-and-verified before destroy mirroring `src/providers/credentials.ts` ordering (mint→deliver→capture→revoke→verify + revoke-verify compensation on delivery failure; non-POST-only retries). **No WRITE credential ever enters a box** (F10/INV-7 — writes are host-side from harvested evidence); egress scoped to the gateway origin. Implemented by M2.1; consumed in-box by M2.2. |
| **DD-17** | **DD-5 (v5 register) fixed, superseded-form**: the stdio premise dies. The dedicated instance's bank-scoped REST (`src/hindsight/client.ts` — listBanks/createBank/retain/recall/reflect/consolidate) + the M2 gateway replace the local-MCP surface entirely. Side effect recorded by the crosswalk: P2.8's P1.11 "KEEP" premise dies with it. Related transport correction: the P0.9 evidence legs assumed shared-platform Hindsight via MCP `/invoke`; M1.1 re-homes leg transport to the dedicated instance (annotate, don't re-litigate). |
| **DD-18** | **Chassis fate** (`src/swarmclaw/`): utilities `log`/`newRequestId`/`maskEnv` are load-bearing (~50 importers; `maskEnv` in `mcp/tool-bridge.ts`) → extracted to `src/lib/` (Z5), pure move. Server surface (`createServer`/routes/store) is orphan (only `src/index.ts` re-export + tests) → **dormant-retained behind a fixture** pending ADR-2's outcome (an ADR-2 ACCEPT re-opens the query-surface question; REJECT closes it). Z5 implements; a deletion without a named restoration path is refused. |
| **DD-19** | **Tier C vs ADR-1 reconciliation note**: the Tier A/B/C labels previously existed only in the integration HANDOFF — defined now in [ADR-2](../../decisions/2026-10-02-adr-2-autonomy-approval-surface.md) so the terms have one home. v6 adopts: macro hosting (Tier A, already ACCEPTED), schedules, bot residency, and *partial Tier B* — approval/notification surfaces move to platform channels (`factory_result` artifacts + chat digests + ADR-2 proposing the S05b inbox as an override surface) while **policy does not move**. **D6 stays unreversed** (in-box engine, host authority, fleet front door). Full Tier C drift remains out. ADR-2 (auto-merge default + QA-owned verdicts + S05b override) is **PROPOSED** — operator decides via G1; nothing here implements it pre-verdict. |
| **DD-20** | **Bot-spend source of truth**: zeropoint LLM-gateway ledger (E08 budgets) for Home-bot turns; factory cost-ledger (integer micro-USD, DD-9 doctrine) for fleet runs. Join keys = workKey (`w:` namespace) + runId + botId; A5 consumes both. **#380 gap statement**: ADR-1 records headless `workId` briefs NOT booking spend as an accepted gap — v6 does NOT silently close it; the zeropoint side owns booking closure as a follow-up, and until it closes, `w:`-keyed fleet legs print spend from the factory cost-ledger (Z3's live-round evidence does this regardless). |
| **DD-21** | **Jev register**: **L6 in-box tool hooks PARKED** (conflicts the LOCKED host-side placement; re-adjudication = new D-number + evidence of need). D-4 supersedes-refines Jev-handoff LOCKED #3 ("no SDK") — still no SDK, now behind the named `JudgmentProvider` seam; every other LOCKED decision holds verbatim (host-side placement, recording-only until measured, no severity calibration, thresholds-in-code, stage-2 diff-hunk egress ZDR-gated, ceiling + bill alarm; §4 vendor facts binding: noul returns NUMBER, 64k/req limits, input-token billing, jev-1.13.0 pin; `TYPESAFE_MODEL="jev-1.13.0"` literal stays THE drift alarm). **J2 unlock milestones written into its gate**: arm-thresholds unlock requires (a) outcome-confirmed record count threshold, (b) agreement CI, (c) explicit operator sign-off — Goodhart guard against arming on ~3 positives. |
| **DD-22** | **Graphiti successor bar, set NOW**: labeled probe set + hit-rate@k target defined before deep KG dependency (M1.3); decision checkpoint after ~30 M1 cycles — **dated, not sprint-bound** (continues into v6b). The bar pre-agreed so the post-re-pin recall-quality question (0.8.6→0.10.0) is answered by measurement, not vibes. |
| **DD-23** | **Parks with dated triggers.** (a) **Proactive-agent roster — full 8, corrected** (R1: the charter's "8 proactive cron agents (QDS-MEM-001/002)" mis-attributes them to the v4 PRD — they live in `hindsight-memory-master-design.md` (per-project: Synthesizer, Meta-Optimizer, Blind Spot Detector, **Review Harvester**) + `hindsight-factory-tier-design.md` §6 (factory-tier: cross-project-synthesizer, factory-optimizer, portfolio-review-harvester, factory-blind-spot); the charter omitted the two Review Harvesters): PARKED until ≥30 M1 cycles + 4 weeks of outcome records. Epic identity QDS-MEM-003 recorded (never named in the charter). (b) **Layer-B self-optimization**: safe subset = J3 + M3.2 only; P2.9–P2.11 machinery + everything else PARKED with the same trigger. (c) Each park names its trigger; none silently dropped. |
| **DD-24** | **Telegram / OQ-3 unchanged** (v5 register DD-1 stands): channel intake stays parked, BLOCKED-on-creds. Writers must not assume Telegram intake anywhere. |
| **DD-25** | **Substrate-status erratum** (research-corrected facts writers build on; charter file not edited): (1) **E21 S02a is DONE** (fork #699 + parent #531) — only S02b in-flight; S01/S10a story headers stale vs EPIC Wave A (EPIC is authority). (2) **Hindsight MCP = 27 tools per bank at `/mcp/{bank_id}/`** — the charter's "28 tools at POST :18889/mcp" is wrong on count and shape; no bare `/mcp` exists in fork code. (3) **The vultr-deploy control-plane compose holds only control-plane + caddy** — hindsight/postgres live in the fork's tenant compose; Z4 *adds* factory services, inherits none. (4) **`enqueueSystemEvent` is in-memory (cap 20/session)** — durable wake = schedule-repository + watch-job-repository. (5) **E21 D1 `Owner {kind:'org'}` is policy-refused** until company-bot ships — A1 adjudicates the factory Home as owner=operator-as-user. (6) `src/fleet/verbs.ts` registry now ~:87-663 (charter's :73-431 stale); the box image file is `oci/exedev/Dockerfile` (COPY set ~:277-355); verify-image-pin.yml's header prose about a registered exception is stale (register EMPTY — no cushion for the current pin red); driver.ts:466-467 comment cites a superseded buildId. (7) **"G5" is overloaded**: runbook-G5 = certbot; "G5 pairing" = the DF3.6b gate (`.unlazy/df3-6b/GATES.md`) — writers disambiguate; the disambiguation is general — runbook-G1…G9 = ops gates, bare G1 = the governance story. |
| **DD-26** | **Wave-edge adjudications + named flex-cuts** (R5): (1) **M2.1 dev-first is sanctioned** — unit/mock tier; its M1.1 dep is an **acceptance-only edge** (acceptance evidence waits for the VPS; code does not). (2) **Z4 authored/fired split** — "authored" ACs (compose, Caddy allowlist, env templates) have no VPS dep and run early; "fired" ACs (deployed + healthy) gate on the operator's VPS-day GO. This resolves Z4's wave-3 slot vs M1.1's wave-2 dep on it. (3) **v6a named flex-cuts** (v6a had none; two added): first cut = M1.3's *report leg* slips to v6b (the probe set itself stays — DD-22 requires it early); second cut = A6's *fired half* rides ops into v6b. (4) v6b cuts per charter, restated: J4-L9 leg first, then J3 → v7. (5) Ops-gate citations pinned: v6a Z4/M1.1 depend on runbook **G1–G7**; the register tracks the full **G1–G9** + GHCR publish ownership (E01-S06/G9) in §5 below. |
| **DD-27** | **Consistency-gate extension**: `scripts/check-story-consistency.ts` generalized to parse v6 rows (`(DF\|Z\|M\|A\|J\|G)\d+(\.\d+)?[a-z]?`) and check the v6 story directory + v6 index alongside the v5 slate; the gate test's positive control updates with the combined row count. Without this, DD-14a's reconciliation discipline is honor-system — the exact failure the checker exists to prevent. Implementation rides this derivation PR. |

## 4. Writer ground rules (binding on every v6 story)

- Facts writers must not contradict: charter §2 as corrected by **DD-25**; R3 §"Writer bindings";
  R4 §"Writer bindings"; this register.
- Guardrails (charter §6, verbatim intent): fleet = only code-entry path; `fleet approve`
  scrypt/stdin/human-only (ADR-1 §3); INV-IBOX/F10/INV-7 (box prose never trusted at boundary;
  no write credential in-box; `kg_recall` recall-only + sanitized + char-budgeted); Jev
  guardrails per DD-21; **never edit** `AUDIT_HOPS` (`src/audit/link-store.ts` — the
  `memory-retain-receipt` hop already exists with EMPTY vocabulary; M1.2 may WRITE it, nobody
  adds hops), gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`, provider-layer
  import rules (R3 §9.2); `src/providers/` imports no tier-3 workspace code; GitNexus `impact()`
  before editing any symbol, `detect_changes()` before any commit; ops stays operator-gated
  (zero agent spend on re-pin / VPS / G5-pairing until explicit GO).
- Atomicity gate (Phase 2.5): normative ≤200 lines (target ≤185), ≤8 SP, DOD ≤10 high-signal,
  Files-to-Modify mandatory (≤10 owned files; Z5 carries the mechanical-import-rewrite clause),
  Security Invariants substantive when triggered (they trigger on nearly every v6 story).
- Channel ≠ policy stated verbatim wherever a story moves an approval/notification channel.
- exe.dev/vendor claims carry [VERIFY] flags; no AC assumes a compliance artifact exists.

## 5. Ops dependency register (charter §4.13 — operator-gated, zero agent spend until GO)

| # | Item | Blocks | Home |
|---|---|---|---|
| 1 | **Image re-pin ritual** (base re-pin → rebuild → re-sweep → publish via publish-exedev-image.yml → adopt; exception register EMPTY — no cushion; CI verify-image-pin RED: base-drift by design + `ee802669…` MANIFEST_UNKNOWN real) | ALL T2 live rounds (wave-0) | M2.2 carries the ritual spec; charter §2.1 |
| 2 | **Vultr VPS G1–G9** (`_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md`; x86_64 Ubuntu 24.04; firewall 22/80/443 never 18889; hindsight.env; SOLSTICE_TENANT_ID; runbook-G5 = certbot) + **M-ladder deploy** (Z4 fired half) | M1.1, Z4-fired, A6-fired | Z4 + this register |
| 3 | **G5 pairing** (= DF3.6b gate, `.unlazy/df3-6b/GATES.md` — NOT runbook certbot) | deferred by operator arrangement | sprint-status 2026-10-01 note |
| 4 | **P0.5/P0.9 closure** (five P0.9 evidence legs ride M1.1 on the VPS; legs' transport re-homed per DD-17; P0.5 four-legs-one-editorial) | M1.1 acceptance | `_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md` |
| 5 | **GHCR publish ownership** (E01-S06/G9) | image publish leg of re-pin; **M2-gateway image publish + M2_GATEWAY_TAG seeding = same gate, unowned** (surfaced by Z4) | Solstice side |
| 6 | **#380 spend-booking closure** for headless `workId` briefs | A5's bot-side ledger leg (until closed, fleet legs print factory-ledger spend; A5 counts unmatched gateway rows) | zeropoint-side follow-up (DD-20) |
| 7 | **Factory-stack VPS backup** | the runbook's G8 backup covers the zeropoint stack only — factory data (Hindsight volumes, memgate ledger, KPI snapshots) has no backup owner | surfaced by Z4; operator assigns at VPS day |
| 8 | **VPS gitnexus CLI + pi binary install** (canonical-script prerequisites — `scripts/install-gitnexus-plus.sh` / pi-ext) | A6-fired | A6 story + this register |

## 6. Coverage map (charter §1 ten gaps — every gap gets a story, a park, or an ADR home)

| Gap | Home |
|---|---|
| 1. 24/7 department managers | A1 (v6b) |
| 2. QA department F3 | A2 (v6b) |
| 3. Maintenance sweeps F4 | A3 (v6b) |
| 4. L3/L4 learning cadences | M3.1 / M3.2 |
| 5. 7 of 8 proactive agents | PARKED DD-23 (dated triggers) |
| 6. Yield KPIs L5 | A5 |
| 7. GitNexus refresh | A6 (v6a) |
| 8. Layer-B self-optimization | J3 + M3.2 safe subset; rest PARKED DD-23 |
| 9. Telegram/channel intake | PARKED DD-24 (DD-1 v5) |
| 10. P2 memory epic (13/44) | FOLD/SUPERSEDE/PARK register DD-15 |

## 7. PR #400/#401 backfill (charter §4.12 — rides this derivation PR)

No repo doc mentioned the v5 close-out PRs. Recorded by this PR: README v6-program note;
openrig roadmap close-out line (program COMPLETE/CLOSED, SC2 evidence, ADR-1 signed);
sprint-status 2026-10-01 note extended with the two-sprint v6 shape + this register pointer.

## 8. DD-28 — writer-embodiment decisions (batch ratification)

Twenty-three story specs were written against this register; the writers surfaced decisions
the charter did not pin. Each is ratified here (all were surfaced in-story, none silent).
The pre-dev campaign may amend values; the decision-level record is this entry.

**Memory & audit:**
- **DD-28.1 (audit vocabulary activation):** M1.2 WRITES the reserved `memory-retain-receipt`
  hop, which requires populating `HOP_EVENT_VOCABULARY["memory-retain-receipt"] = ["retain"]` —
  an **adds-only edit to `src/audit/link-store.ts`** (empty vocabulary is a hard refusal;
  verified :79-88). The never-edit rule is hereby scoped: the **`AUDIT_HOPS` array stays
  frozen** (no hop added/removed/renamed, ever); **vocabulary population of an existing EMPTY
  hop is the sanctioned activation path**, done once, by the story that owns the hop's first
  writer (M1.2), surfaced in-story. INV-AUDIT-4's by-design reading is amended accordingly.
- **DD-28.2 (image-pin coupling):** `deriveBuildId` hashes copied file bytes, so M1.2
  (`kgContext` brief field — `brief-schema.ts` + render line), J3 (dispatch hook), and J4
  (steering `compact` member) each move the pin. **The wave-0 re-pin ritual runs ONCE on a
  tree containing M1.2 + J3 + J4** (v6b pays once); M1.2's T2 live round waits for the ritual
  on its own tree. Z5 asserts it moves nothing (both its dirs are directory-level COPY
  entries). Z1's fork pin lives at `scripts/swarmclaw-fork-pin.ts` (scripts root is not
  copied into the box image).
- **DD-28.3 (audit-flag vocabulary):** M1.2 lands `documentId = runId` (dated by
  construction — runIds are `qds-YYYYMMDD-*`), `updateMode:"replace"`, payload =
  host-authored structured summary, never raw box prose.
- **DD-28.4 (gateway wire names):** `MEMGATE_ADMIN_KEY`, per-run delivery env
  `QDS_MEMORY_RECALL_KEY`, in-box env `QDS_KG_RECALL_KEY` + `QDS_KG_GATEWAY_URL`,
  `QDS_MEMGATE_LEDGER` (fail-closed), `DEFAULT_KEY_TTL_BACKSTOP_MS = 86_400_000` (24h,
  mirrors approval-gate DEFAULT_TIMEOUT_MS), `AGENT_TOKEN_VERBS =
  ["recall","reflect","consolidate","retain"]` (retain is legal for agent tokens — Home bots
  are not boxes), `KG_RECALL_CHAR_CEILING = 8_000` + `[kg_recall:truncated]` marker,
  `KG_RECALL_TIMEOUT_MS = 10_000`, `QDS_MEMGATE_SIGNING_KEY` (the HMAC signature key —
  operator-rotated env value; rotation fails agent tokens closed, no dual-key window,
  re-grant), HMAC-signed tokens + a revocation ledger (run-record
  storage rejected: keys outlive records), pi-extension install path `/opt/qds/pi-ext/`
  (self-compact precedent), module root `src/memgate/`.

**Cross-repo (Z):**
- **DD-28.5 (contract debt, recorded):** Z1 adds **no status version marker** — `src/fleet/`
  is in the box COPY set, so any byte change moves `deriveBuildId` and demands the ops-gated
  re-pin ritual, violating Z1's none tier. The status surface ships unpinned; the debt rides
  a deliberate grammar bump + re-pin. Driver asymmetry is normative: `fleet status` requires
  `--driver`, `fleet result` does not — **Z4's wrapper supplies the driver flag; the fork
  never passes one.**
- **DD-28.6 (fork-grammar changes):** Z2's fork changes = **two closed unions gain members**:
  `factory_observe` added to `ProtocolStepKind` (`fork:protocol.ts:84-94`) and to the
  artifact-kind union (`fork:protocol.ts:193`) — fork-internal; the factory consumes
  CLI JSON, not fork artifacts. Notify-leg eligibility extends to trigger-sourced runs
  (today `markTerminalOutcomeForOriginSession` notifies session sources only). Post-merge
  trigger = persisted watch-job polling via the existing `type:'http'` member
  (DD-28.26(6) — no new WatchJobType member), **not a webhook** (no new inbound surface).
- **DD-28.7 (Z3 round shape):** `Z3_MAX_FLEET_RUNS = 4`, sequential, exactly-one-box per
  run + mid-submit crash kill + re-drive; the approval-parked run is the protocol's own
  code-affecting run (SC2.7 shape), **not** an A3 sweep — keeps Z3's dep list honest; memory
  legs authenticate via M2.1's long-lived agent tokens (no per-run key — that is M2.2/M2.3's
  lane). Scripted-approver labeling is the standing round rule.
- **DD-28.8 (citation convention):** cross-repo citations carry a `fork:` / `solstice:`
  prefix (contract §0 marker); the consistency checker exempts them from repo-resolution by
  design. Bare cross-repo cites are checker findings.
- **DD-28.9 (Z4 topology):** "fleet CLI" compose element = **host-side deployed wrapper, not
  a container** (no-daemon ground truth + DD-1; the fork execFile's it per verb); compose
  carries exactly hindsight-qds (no host ports — `127.0.0.1:18889` belongs to the tenant
  stack) + the m2-gateway slot; the wrapper may depend on no env beyond what it resolves.
- **DD-28.10 (A6):** host cron `7 */5 * * *` over a compose sidecar (backup.sh precedent);
  staleness ceiling 8h; FR-MEM-6's verbatim "runs `gitnexus analyze`" is dispositioned as
  intent — the canonical script (`install-gitnexus-plus.sh`) is the implementation (repo
  law); the charter's Epic-A row text omitting A6 is stale (A6 is Epic A's sole pre-E21
  member, v6a).

**Judgment (J):**
- **DD-28.11 (J1 mechanism):** the seam is a **closed registry** seeded exactly
  `{jev, mock}` — an open `registerProvider()` was rejected (it would admit untested
  transports); adapters expose **transport only**; neutral-layer policy (egress choke,
  ceiling, strict parse, envelope, provenance) is **non-delegable** — no adapter may bypass it.
- **DD-28.12 (J2 gate values — writer-proposed, operator may amend at review):** 200
  outcome-confirmed jev-arm records; Wilson 95% lower bound ≥ 0.90 on **OUTCOME agreement**
  (not lead-agreement — lead-agreement is circular at the measured 88%) — the interval is
  computed over **independent units, not raw finding records** (amended 2026-10-02): the
  unit is the `(pr, round)` cluster; a cluster agrees iff every confirmed finding in it
  agrees; the Wilson interval and a minimum confirmed-cluster count gate on clusters, the
  200-record count stays the volume floor. Findings within one round share code and
  reviewer dynamics — treating them as independent overstates the effective n; the
  lead-vs-outcome choice remains flagged for operator pin; `MIN_ROUTE_CONFIDENCE = 0.90`,
  DISMISS lane only; arming re-adjudicates `ab-report.ts`'s "no gating use" reading (gated
  use of recorded probabilities above the threshold only); armed authority = review-finding
  routing manifest ONLY — never dispatch/gate/code-entry; `confirm-outcome.ts` is
  deliberately NOT the parked P2.9–P2.11 auto-confirm machinery (DD-15 carve-out).
- **DD-28.13 (J3 reconciliation):** charter row ("L3 composite scoring picks model tier")
  vs D-5 recording-only → **applied tier = deterministic weights-in-code; the Jev answer is
  a recorded recommendation**; the only route a recommendation becomes applied is M3.2
  PROPOSE → operator. `.sandbox/routing-log.jsonl` is the J3-owned decision-log contract
  (M3.2/A5 read-side, no dep edges).
- **DD-28.14 (J4 recording-only + closed union):** `PACK_SIGNALS_ARMED = false` code
  constant — the pack ships recording-only; arming = follow-up PR + register entry +
  named milestones + operator sign-off (env-var arming forbidden). The steering-union
  gains **one adds-only `compact` member** (`SteeringDirectiveSchema`, POINT_ALLOWLIST
  `run_start` + `post_gate_failure` only) — a **register-ratified amendment of DF1.11's
  closed union** (INV-RES-2), never an in-place edit of the closed record. L9 is a
  separable module+test with deterministic fallback (flex-cut seam). A3 consumes no J4 leg.

**Autonomy & governance (A/M3/G):**
- **DD-28.15 (A1):** factory Home owner = **operator-as-user** (`kind:'org'` is
  policy-refused until the company-bot feature ships — E21 ADR run-2 D1; upgrade = new
  decision, not a config flip); the digest is **host-composed** (Bridge deny-lists
  `cli.exec` — bots cannot exec fleet verbs); the digest absorbs fix-loop-runner
  **additively** (`src/fixloop/` byte-identical); `botId` join-key field is deferred (no
  producer until A2's first manager-originated run) — names only, not-an-edge.
- **DD-28.16 (M3.1 semantics):** gated-with-fallback — M2.1 is the hard gate; **A1 gates
  only the platform-schedule leg**; the documented crontab fallback fires the same module
  through the same gateway (driver-agnostic, test-enforced zero-E21-imports). The
  mental-model refresh endpoint: v4's `POST …/mental-models/{id}/refresh` **exists** in
  0.10.0's REST (bank-scoped, + dry-run/clear/history variants — `openapi.json:2340`;
  erratum to this entry's earlier "not enumerated" claim) — the trigger-only choice stands
  on the **closed-verb-set ground** (endpoint mode would need a second verb, `refresh`, in
  `AGENT_TOKEN_VERBS`), not on endpoint non-existence; the refresh rides the
  consolidation-trigger (`trigger.refresh_after_consolidation`, set at provisioning) and a
  trigger-absent consolidate fails loud. **Future-proofing:** widening `AGENT_TOKEN_VERBS`
  with `refresh` makes endpoint mode reachable — this entry is revisited then.
- **DD-28.17 (M3.2 shape):** proposals land in `.sandbox/proposals/` (0600 append-only) +
  idempotent meta-bank retain; **bot = trigger + carrier, never composer**; a proposal
  status machine (PROPOSED→ACCEPTED→APPLIED) is rejected as auto-apply's sibling — operator
  adjudication lives in the operator's own change.
- **DD-28.18 (A2):** QA boxes carry the **original single provider secret** — DD-16's
  second credential applies only where in-box recall lands (M2.2+); `QA_LENS =
  [correctness, secret-hygiene, diff-scope]`, `MAX_QA_LEGS = 4` — thresholds-in-code;
  spend books factory-side per runId with the `w:qa-*` workKey stamped adds-only on the
  run record (DD-20's join needs no schema change); macro-side per-workKey aggregation
  stays DD-20/A5's.
- **DD-28.19 (G1):** fail-closed policy seam — absent `.factory/policy.json` = OFF; ON
  only via an operator-created named setting; "ON while ADR-2 is PROPOSED" is a red
  repo-consistency test (the loader stays dumb — no runtime ADR parsing, docs ≠ runtime
  config); auto-merge wiring = adds-only consult in `run-completion.ts` BEFORE gate
  registration, labeled `policy:adr-2` on the **existing** run-approval hop (no new audit
  hop; label home as amended by DD-28.26(2) — the approval state, not a hop emitter);
  `approval-gate.ts` byte-identical; ADR-2 clause 5's veto-window queue is
  **accepted-not-yet-built** in v6a (unreachable until A2 makes runs eligible — the
  verdict block (ACCEPT or AMENDED) must name it); accepted-not-yet-built does NOT satisfy clause 5 —
  while the queue is absent, auto-merge stays OFF (fail-closed) unless the verdict amends
  clause 5 itself; REJECTED is a valid completion (verdict + DD-18
  closure + zero src/ lines).
- **DD-28.20 (A5):** the gateway-ledger join is mechanical — a strict-schema JSONL import
  artifact at `.sandbox/imports/` (respects the no-zeropoint-import-graph rule); **its
  producer is a solstice-repo counterpart story** (§5 row 6, DD-20). `TDI` → **TDI-proxy** with named
  composition (reverify vetoes + fixloop charged attempts + A2 findings — v4's pi-lens TDI
  has no factory source); escaped-defect counter-metric is absent-not-0 until A2 lands.
- **DD-28.21 (A3 posture):** >8h-stale GitNexus graph = counted `graph-stale` refusal, the
  sweep proceeds audit-chain-only (partial-consumer reading of NFR-OBS-5 — flagged for
  operator sign-off at review).

**Cross-story adjudications (post-pipeline, 2026-10-02):**
- **DD-28.22 (dedicated-instance host reach — adjudicated):** Z4's no-host-ports rule and
  M1.1's host-side legs (host-bun provisioner/round-trip drivers, on-box curl) contradicted —
  on a both-stacks box, loopback 18889 is the TENANT instance's map (the wrong-instance shape
  M1.1's AC1 forbids). **Decision: `hindsight-qds` binds `127.0.0.1:18890:8888` as its one
  host publish** (never 18889); origin split: compose-side consumers use
  `http://hindsight-qds:8888` (factory.env), host-side consumers read
  `HINDSIGHT_BASE_URL=http://127.0.0.1:18890` from hindsight-qds.env (runbook G3 pattern) —
  env-carried, never hardcoded. Firewall stays 22/80/443 (loopback binds are not public).
- **DD-28.23 (gateway wire names, final):** per-run delivery = `QDS_KG_RECALL_KEY` +
  `QDS_KG_GATEWAY_URL` (M2.2's registration of record wins; the concurrent-review drift
  resolved single-named across M2.1/M2.2/M2.3). Amends DD-28.4's provisional
  `QDS_MEMORY_RECALL_KEY`.
- **DD-28.24 (round-cap latent tension, register-pinned):** `Z3_MAX_FLEET_RUNS = 4` assumes
  A2's 3-lens composition (3 QA legs + 1 code-affecting run); A2's `MAX_QA_LEGS = 4`
  headroom would make 5. Both constants are register-ratified; if A2 ever adds a 4th lens,
  the Z3 cap bump is a deliberate, evidence-round-coupled change — never silent.
- **DD-28.25 (ADR-2 status wording):** stories say "PROPOSED (operator decides via G1)" —
  the charter's "DRAFT" phrasing is its own closed input; G1's references to "the draft" as
  an artifact are intact. The load-bearing claim everywhere: it decides nothing until ruled.

## 8a. DD-28.26 — pre-dev campaign adjudications (Wave-5 verification, 2026-10-02)

The qds-story-review campaign's fresh-eyes verification (13 uncoupled verifiers after the
converged 13-agent pipeline) surfaced findings requiring register-level decisions. Applied:

1. **Agent-token `refresh` verb (V6-BLOCKER1, V10-HIGH-2):** M3.1's preferred-leg token
   requested `{consolidate, refresh}`, but `refresh` ∉ M2.1's closed
   `AGENT_TOKEN_VERBS = ["recall","reflect","consolidate","retain"]` — the gateway refuses
   M3.1's own grant by its own negative control. **Decision: option (b) — the bot-held
   token class is `{consolidate}`**; the mental-model refresh rides the consolidation-trigger
   mechanism (DD-28.16 — see its erratum; the endpoint exists and the ground is the closed
   verb set). The closed verb set is NOT widened. M2.1 gains one line naming the
   two agent-token grant classes (host-held `{reflect, retain}`; bot-held `{consolidate}`).
2. **ADR-2 label home (V10-HIGH-1):** G1's chain-authored `policy:adr-2` row in the
   `run-approval` audit hop was unimplementable — that hop is walk-observed-only with a
   fail-loud vocabulary and no emitter by design (`link-store.ts` docblock; DD-28.1's
   EMPTY-only sanction does not apply). **Decision: the label lives in the run record's
   approval state (`approverId: "policy:adr-2"`, the `system:timeout` precedent's home);
   the audit row is the walker's existing first-observation digest. No new emitter; no
   vocabulary extension.**
3. **P2.8 mechanism [VERIFY] (V3-HIGH1):** the folded mechanism (client-supplied
   `documentId` + `updateMode:"replace"` echoed as `memoryId`) is **unverified against
   0.10.0** (`RetainPayloadSchema` carries neither field; the live ecosystem consumer
   routes provenance via tags). M1.2 carries a [VERIFY] flag + an early retain→recall
   echo-assertion leg + the named fallback (host-side retain-identity ledger keyed on
   runId → skip-on-replay). DD-28.3 stands as the design intent, gated on the echo leg.
4. **Re-pin tree gains A2 (V4-H1):** `src/providers/run-record.ts` is COPY-set — A2's
   adds-only `workKey` field moves `deriveBuildId`. DD-28.2's once-only ritual tree is
   **M1.2 + J3 + J4 + A2**; A2's "transitively satisfied" sentence is deleted.
5. **Memory-key fleet wiring ownership (V9-HIGH-2):** M2.2 owns the integration region —
   the dispatch provision leg + the teardown revoke-verify call sites join its
   Files-to-Modify (adds-only, coordinated with J3's dispatch region), so DD-16's
   lifecycle is wired by a named owner.
6. **Z2 post-merge mechanism (V1-H2):** option (a) — the trigger rides the fork's existing
   `type:'http'` watch job (GitHub PR endpoint, `merged:true` condition, named credential
   surface, poll ceiling, merge-identity dedupe); no new WatchJobType member, no Z1
   contract bump. The trigger-suite fake fakes the GitHub leg too.
7. **Z3 cap derivation (V4-M3):** `Z3_MAX_FLEET_RUNS` = actual lens count + 1 (3 + 1 = 4
   today, the ratified value; `MAX_QA_LEGS`'s +1 headroom does not raise the cap) — derived
   from A2's lens count, never restated from a constant alone (a 4th lens raises both by
   edit, never silently).
8. **`scripted: true` provenance (V4-M4):** it is a NEW Z3-round requirement extending
   SC2.7's synthetic-approver-id precedent — the SC2.7 evidence carries no such field.
9. **Z1 manifest provenance (V1-H1):** pre-pin manifest rows are **timeline-bracketed
   inferences** ({file, rev, source:"git-log bracket", citing merge-sha(s) + round
   timestamp}); "citable" = that row shape. The alarm gains field-recorded teeth from the
   first post-pin stamped round (AC7). AC4's equality target = the newest round's
   recorded/bracketed rev.
10. **Cross-repo citation marker:** the `fork:`/`solstice:` prefix convention now lives in
    the contract doc §0 (it was checker-and-DD-28.8-cited but previously unwritten there).
11. **A6 staleness ordering:** the staleness check reads the PRE-cycle stamp (fail fast
    >8h) BEFORE reindex — post-reindex ordering made the alarm structurally inert.
12. **A3 sweep transport (R3-V4-H1≡R3-V7-H1 + R3-V7-M1):** A3's weekly sweep firing is a
    documented `deploy/vps/crontab.factory` line; the E21 schedule / Z2 wake drives only the
    bot's trigger/report turn; Z2's read-only `{status,result}` closure is intact; ADR-1 §1's
    `external_job` macro shape is deliberately not used for the trigger mechanism (ADR-1 §3's
    CLI door stands; consequential work remains direct fleet runs).
13. **`no-auth` refusal token (CodeRabbit round, 2026-10-02):** RATIFIED — `no-auth` joins
    M2.1's `memgate-refused` reason set as the named refusal for a request carrying no auth
    header (the 0.8.6 danger shape). M2.2 Deviation 2 and M2.3 Deviation 2's register flags
    resolve as ACCEPTED: the M2.3 adversarial battery asserts the named token; M2.1's
    observability vocabulary gains the token (its verify-time refusal already exists — only
    the name is new). No other verb or scope change; the closed refusal set gains exactly
    one member.
14. **G1 QA-verdict emission conditionality (R3-V3-M2):** G1 delegates the structured verdict
    producer to A2; A2 emits it only under ACCEPT of ADR-2 clause 2, adds-only to its contract.
15. **DD-18 erratum (V12-L3):** the chassis importer census is 74 files / 78 import lines
    (greppable); DD-18's "~50" was a pre-census approximation, superseded by Z5's count; the
    standing-index gate probe pins the symbol — `src/gate/assertions/p0-10-gitnexus.ts:27`
    probes `createServer` in `src/swarmclaw/index.ts` (NET-NEW vs R3, flagged by Z5), so the
    retained surface is load-bearing twice (ADR-2 restoration path + this probe).
16. **J4 `compact` amendment (DD-28.14 executed, 2026-10-14):** J4 amends DF1.11's closed
    `SteeringDirectiveSchema` union adds-only with a fifth `.strict()` member
    `{action:"compact", note?}`; `POINT_ALLOWLIST` gains it at `run_start` +
    `post_gate_failure` only (`run_end` stays proceed-only; no fourth steering point). The
    resident-facing directive prompt does not advertise it, and origin IS code-enforced:
    `solicit()` refuses a resident reply naming `compact` at every point with the exact pre-J4
    unknown-action rejection (PROCEED, `directivesRejected` +1, `gate_bypass_attempt` row,
    detail `unrecognized action: compact (host-only: …)`). The allowlist entries, read via
    `directiveAllowedAt`, govern only the future host-originated path.
    (a) **buildId:** BOTH `src/phase-engine/steering.ts` and `src/fleet/observe.ts` (the `onTick`
    seam) are COPY-set and move `deriveBuildId`; origin/dev's literal `285156f` was already stale: J3's CodeRabbit round-3 commit `dac6e6c2`
    edited the walked input `src/fleet/dispatch.ts` without a re-pin, so dev's real digest is
    `b34dc6b` and dev's own pin test is red. J4 moves `b34dc6b`→`37e749e` via `steering.ts` +
    `observe.ts` only (and incidentally restores dev's pin test) (DD-28.2 ritual; publish/adopt
    stays operator-gated).
    (b) **Arming PR owes:** a host-to-engine directive path (DF1.11's inbox is context-only, and
    production builds the L7 hook with no steering writer, so arming today only logs
    `no-steering-writer`) plus the box-side `compact` applier (its own re-pin). Both are unowned
    follow-up work that rides the arming PR.
    (c) **Honestly unproven:** the box journal's resident block is refreshed only after
    `run.finish` writes `journal/final.json`, the very marker that makes observe treat the run as
    settled, so in production L7 makes ZERO asks today. RSS/context utilization are not
    host-observable (null). A mid-run resident refresh (box-side engine work) is the
    prerequisite; it is unowned and rides the arming PR.
    (d) **Pre-dispatch sanity leg:** asks a provisional noul `manifest_consistent` question purely
    to emit provenance. It names no disposition values and stays provenance-only until a register
    amendment names its answer pair.

## 8b. DD-29 — SWARMCLAW_FORK_REV adoption ritual (Z1, 2026-10-02)

**DD-29 (fork-rev pin adoption):** `SWARMCLAW_FORK_REV` lives at
`scripts/swarmclaw-fork-pin.ts` (at `scripts/` root — **outside the box COPY set** per
DD-28.2, so adopting or bumping it never moves `deriveBuildId`). The pin advances **ONLY
by a deliberate bump PR naming the evidence round that proves the new rev**
(charter §5.3 — the pin tracks evidence, never fork HEAD; factory-only `df3-e2e` rounds
never move it). The pin instant (`SWARMCLAW_FORK_REV_PINNED_AT`) and every manifest row's
`citing.timestamp` are **ISO-8601 UTC `Z`-suffixed** datetimes — a story-internal
discipline, noted as such (repo-wide convention is unchanged; the drift alarm's
post-pin boundary is a plain string compare over this fixed form, inclusive at the pin).
The drift alarm is **provenance-scoped, not blindly global**: a stamped rev from a
post-pin round must equal the pin; a pre-pin stamped rev validates against its own
manifest row's rev — legitimate older revisions pass. **No adopter script**: the fork
rev is one literal plus one manifest row (unlike the image-pin ritual's five literals
across four files); revisit trigger — the ritual grows a second pinned fork constant.
**Z2 is the consumer, never the editor**: drift found by Z2's fork-side work is fixed by
a Z1 bump PR first (§5.5 — one contract text, both sides).

## 9. Sources

Charter (input, closed) · R1–R5 research reports (paths in header) · ADR-1 + ADR-2 ·
v5 register + v5 architecture (D6/D8) · HANDOFF (3 status layers) · Jev handoff ·
vultr runbook + P0.5/P0.9 closure plan · E21 EPIC + ADR run-2 (fresh worktree) ·
vultr-deploy template @ d0c513fa · P2 README + crosswalk-p2.md.
