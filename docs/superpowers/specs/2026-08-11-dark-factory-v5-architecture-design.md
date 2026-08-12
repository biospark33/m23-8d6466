# Dark Factory v5 — Architecture Decision Report & Design

**Date:** 2026-08-11
**Status:** REVISED (r2) — independent adversarial review completed 2026-08-11 in a fresh session against refreshed evidence; 16 findings (F1–F16) incorporated (see §10)
**Authors:** Steve + Claude (Fable 5), synthesized from a 7-agent investigation campaign
**Supersedes (on approval):** the Warren-centric Phase-1 execution plan in
`docs/planning/qds-factory-4-week-execution-and-spike-plan.md` §2 (substrate table) and the
Warren-coupled portions of the Phase-1 story set. Does NOT supersede the Hindsight memory
designs (QDS-MEM-001/002/003) or the phase-0 code assets inventoried in §7.

---

## 1. Executive summary

QDS-Factory ("the Dark Code Factory") is a lights-out software factory: work enters via a
channel and autonomously becomes a reviewed, audited, costed pull request. It will be sold
two ways: hosted for mid-market companies without their own infrastructure, and deployed
into the client's own VPC/on-prem for enterprises and publicly-traded companies, where
security is the paramount purchase criterion.

This report records the outcome of a first-principles re-architecture triggered by two
IndyDevDan (disler) releases — the Super Simple Software Factory (SSSF) and the
"factory in a box" agent-sandbox system — and the question of whether they should replace
**Warren** (jayminwest/warren), the execution harness named in the current plan.

**Headline findings:**

1. **Warren cannot do the job the plan assigns it.** It is a mature, well-tested,
   single-agent-per-run control plane. Re-verified at upstream v0.14.1 by the
   independent review (F1): `CreateRunInput` (`src/client/types.ts:139`) carries
   agent/project/prompt/ref/branch/provider/model/seed/mode/parent — no team and no
   env surface — and the changelog 0.9→0.14.1 has zero team/multi-agent entries.
   (The r1 citation, `SPEC.md:2729`, no longer exists — upstream deleted SPEC.md in
   its "spec retirement," warren #741. Do not cite it.) The plan names Warren
   "Pi-team harness." The team-formation mechanism the stories rely on
   (`extensions/agent-team.ts`) exists only in separate `QDS-engineer*` checkouts,
   is TUI-interactive (blocks on `ctx.ui.select` at `agent-team.ts:580`), and the
   transport that would carry the team roster to a Warren burrow
   (`QDS_AGENT_TEAM_CONFIG_JSON` env var, set at `cli-anything/src/runner.ts:533`
   after the #99 runner split) never crosses the CLI→server HTTP boundary by
   construction.
2. **The only execution path ever proven end-to-end is ours.**
   `cli-anything/scripts/team-lead-driver.ts` (local pi subprocess teams, bidirectional
   coms, mixed providers, identical NDJSON contract) ran live on 2026-07-20:
   claude-sonnet-5 lead + two OpenRouter workers, structured merged JSON, success.
   It sits behind a one-ternary runtime seam (`runner.ts:554`, `QDS_TEAM_RUNNER`).
3. **SSSF is a high-quality reference design shipped as demo-ware.** Zero tests, one
   commit, placeholder quality gates that exit 0, a generator that emits crashing code,
   pi-only, no sandboxing, structurally single-run-per-repo. Its *architecture* (phases,
   gates, envelopes, per-role model rosters) and its *observability layer* (SQLite trace
   schema + visualizer) are excellent and adoptable; its Python engine is not.
4. **The inkwell sandbox repo's credential lifecycle is the best part of either disler
   release.** Per-run spend-capped provisioned keys (mint → cap → use → revoke →
   **verify revocation against the key list**), no git push credential inside the box,
   git-bundle harvest into `refs/sandbox/*`. Production-grade recipes inside a
   video-companion system (best-of-N is a cookbook bash loop, not code; teardown was
   never executed by the author).
5. **exe.dev was re-evaluated from primary sources and rehabilitated on the technical
   axis.** Real Cloud Hypervisor (KVM) VMs, no inter-VM network even within one account,
   HTTP private by default, customer-initiated support access, 9 regions, and correctly
   implemented AWS/GCP Workload Identity Federation. What it lacks is paperwork: no
   SOC 2, no customer-facing DPA, $100 liability cap, no SLA, no audit logs/SAML/SCIM,
   US-only control plane. Verdict: viable substrate for the hosted mid-market tier;
   not passable through Fortune-500 vendor review today.
6. **Orgo (orgo.ai) is the wrong shape** — GUI desktops for computer-use agents, 4-vCPU
   hard ceiling, no public compliance surface, pre-seed vendor. Shelved, with two ideas
   harvested (content-addressed golden snapshots; per-box `egress_policy`).

**Headline decision:** build the factory as a three-tier orchestration system — local
Claude Code cockpit → fleet of provider-pluggable sandboxes, each with a resident
orchestrator agent operating a deterministic TypeScript phase engine → pi agent *teams*
as the workers. Keep the proven QDS code assets; reset the planning superstructure.
Adopt SSSF's design (ported to TS) and its visualizer (hardened in place). Demote Warren
to an optional runtime behind the existing seam. Make the sandbox provider a driver
interface with exe.dev and OCI/self-hosted as the two first-class drivers.

---

## 2. Method

Seven specialized agents across three waves, with adversarial verification:

- **Wave 1 (parallel deep analysis):** Warren-in-plan mapper (QDS plan + live Warren
  server + Warren source), SSSF full-source analyst, inkwell sandbox-layer analyst.
- **Wave 2 (parallel):** adversarial claim verifier (8 decision-critical claims
  independently re-derived from source; 2 refuted/corrected — see §3.7), decision
  analyst (options A–D scored on five criteria).
- **Wave 3 (parallel, after user pushback):** exe.dev enterprise-posture researcher
  (primary docs, ~20 pages), Orgo researcher (full docs dump + external sources).

All load-bearing claims carry file:line citations in the underlying reports. Two claims
from wave 1 were corrected by wave 2 and are recorded corrected here. Facts marked
**[VERIFY]** are flagged for the independent adversarial review (§10).

---

## 3. Findings

### 3.1 Warren (jayminwest/warren, `/Users/steve/warren`, MIT)

**Maturity — genuinely high for a 0.x single-maintainer project.** ~1:1 co-located
test files, 36 acceptance scenarios (nightly in CI since 0.13.1) with an operator
runbook, real CI (lint, typecheck, coverage gates, bundle budgets, per-PR image builds
since 0.13.0), Postgres backend option, Docker/Fly/K8s deployment, heavyweight
changelog. (r1's file counts were measured at 0.8.4 and are retired with the SPEC —
F5.) Release-hygiene caveat (F16): the v0.12.0/v0.12.1 tags were dead — unbuildable
commits reached tagged releases, admitted in their own changelog and closed by
0.13.0's per-PR image CI. Feeds R4.

**Sandboxing — real, and two topologies since v0.10.0 (F2).** Default self-host:
supervisor is the container entrypoint; each run gets a fresh `bwrap`-isolated
workspace ("burrow") under `/data/burrow/`; warren talks to the sandbox runtime
(jayminwest/burrow) over a unix socket with a shared bearer token. Compose requires
`apparmor=unconfined`, `seccomp=unconfined`, `systempaths=unconfined`,
`cap_add: SYS_ADMIN` (still true at v0.14.1) — a hard sell to enterprise security
reviewers. **But** v0.10.0 shipped a `RuntimeProvider` contract
(`src/runtime/contract.ts`) with a `K8sProvider` (`WARREN_RUNTIME=k8s`): one bare pod
per run, no bwrap, no unix socket, none of the unconfined flags
(`docs/RUNBOOK-K8S.md` §0). Add per-run scoped tokens (0.13.0), an
agent-output-terminalization defense and route path-traversal fix (0.13.2), and
event-stream credential scrubbing (0.13.1): Warren's enterprise posture as a
*single-agent* runtime is materially better than r1 credited. This changes D7/D9's
scoring inputs, not the team verdict.

**Structural facts that broke the plan's assumptions:**

| # | Plan assumption | Reality |
|---|---|---|
| 1 | "Warren = Pi-team harness" | Single-agent-per-run by design, re-verified at v0.14.1 (F1): zero team/multi-agent changelog entries 0.9→0.14.1; no team surface in source or `CreateRunInput`. (Historical: the retired SPEC assigned multi-agent to "overstory"; SPEC.md was deleted upstream in #741 — do not cite it.) |
| 2 | `warren run --team pi-pair` (P1.19) | Flag does not exist in any version examined. |
| 3 | Team roster reaches the agent via `QDS_AGENT_TEAM_CONFIG_JSON` | Env var is set on the **local CLI process** (`runner.ts:533` post-#99 — F4); the Warren CLI is a thin HTTP client; `CreateRunInput` has no env field (re-verified at v0.14.1); the agent runs in a server-side burrow (or pod). The variable never crosses the wire. |
| 4 | Harness RSS watchdog (P1.6 INV-3) limits the agent | With a server-based Warren it measures the CLI client — the wrong process. Correct only for a local-subprocess runtime. |
| 5 | Exit-code table 0/1/2/3 → success/logic/transient/overflow | Worse than unpublished (F3): v0.14.1 publishes a stable table (`docs/cli-reference.md` §Exit codes) — 0 success, 1 run-failed, 2 usage-error, 3 server-unreachable, 4 auth-rejected, 130 sigint-detach — which **contradicts** the assumed semantics (no overflow code; 2/3 are not logic/transient). P1.6 as written is doubly invalid; the story itself flagged the assumption (P1.6:78-79). SPIKE-3 never ran. |
| 6 | "warren 0.10.0 installed and CLI-verified on this host" (P0.3 dev record) | Was true nowhere: the local checkout was **0.8.4** (HEAD 2026-06-07); 0.10.0 is a real upstream tag this machine never had; the CLI exists only inside the container, not on host PATH. **Resolved 2026-08-11:** checkout refreshed to v0.14.1 (local mods stashed as "pre-adversarial-review"); the P0.3 dev record was corrected 2026-08-11 (see `2026-08-11-story-disposition-audit.md` §5, disposition table row P0.3). |
| 7 | Warren opens the PR (P1.15) | **Correct** — the one assumption that matched reality. |

**QDS coupling to Warren is ~30 lines** (`buildTeamSpawn`, now `team-events.ts:36`
after the #99 runner split — F4) selected by one ternary (`runner.ts:554`,
`QDS_TEAM_RUNNER`). SwarmClaw↔Warren integration is 0 lines. All Warren
tests run against PATH shims. Sunk cost in Warren is negligible; sunk cost in the
*story contracts written for Warren* is real but largely runtime-agnostic (see §7).

### 3.2 `extensions/agent-team.ts`

Exists (contrary to an initial wave-1 claim): 734-line identical copies in
`/Users/steve/QDS-engineer/pi-vs-claude-code/extensions/` and sibling checkouts, dated
2026-02-24. It is a **TUI-interactive dispatcher**: loads agent definitions from
`agents/*.md`, teams from `.pi/agents/teams.yaml`, blocks on `ctx.ui.select("Select
Team", …)` at boot, renders a grid dashboard, exposes `/agents-team` slash commands. It
does not read `QDS_AGENT_TEAM_CONFIG_JSON` and has no headless mode. Its subprocess
spawn pattern was already extracted (memory obs 18907, Jun 5) into what became
`team-lead-driver.ts`. Adopting it would trade a tested headless derivative for its
untested interactive ancestor. Not vendored into QDS-Factory
(`pi-vs-claude-code-vendor/` holds coms.ts, coms-net.ts, coms-core.ts, themeMap.ts only).

### 3.3 SSSF (disler/super-simple-software-factory, MIT, cloned at `/Users/steve/reference-repos/`)

Single commit (2026-08-02). ~3,632 lines Python (ADW engine), ~4,656 lines TS/Vue
(visualizer), ~2,170 lines Markdown. Ships as a Claude Code skill template stamped into
target repos.

**Adopt (design):**
- **Phase abstraction** — one contextmanager primitive; status defaults to `fail` and
  must be earned; phase descriptions validated for legibility at construction.
- **Envelope adapter pattern** — deterministic subprocess results (test runs, lint) are
  wrapped as envelopes indistinguishable from agent reports, so one repair-loop code
  path serves both agent and code failures. The sharpest idea in the codebase.
- **Gates with evidence** — every check recorded pass *and* fail, so a green gate says
  what it verified; self-consistency checks on review envelopes.
- **Per-role model roster** — YAML config: model/provider/thinking/tools/writes per
  agent role, defaults + shallow merge.
- **Permission fingerprinting** — git change-set snapshot before/after agent run,
  unauthorized changes rolled back; catches reversions, not just writes.
  **DEFERRED for v5.0 (see DD-12):** it guards a concurrent-shared-tree hazard that v5.0's
  one-run-one-box isolation (R8) structurally removes; it re-enters the moment runs ever
  share a working tree.
- **Dual retry discipline** — JSON-parse retries and gate-violation retries separately
  bounded, both re-entering the same agent session; usage accumulated across retries
  while context occupancy is read from the last send only.

**Adopt (code, with hardening): the visualizer + trace schema.** Seven-table SQLite
schema (sessions, phases, events, envelopes, gate_results, processes, agent_sessions),
WAL, additive migrations, rowid-cursor polling; Vue 3 + Bun read-only server with
three drill levels (sessions → swim-lane trace → phase detail with compiled prompts,
gate evidence, cost breakdown). Reference docs verified accurate against the tracer
implementation — rare and valuable. Needs: auth, tests, Bun-API audit.

**Reject (code): the Python ADW engine.** Zero tests/CI; quality-command blocks ship as
`echo` placeholders that exit 0, and `adw_plan_build_test.py` commits when the (never
actually run) suite reports green; `make_adw.py` generates ADWs that crash on success
(references a deliberately removed `run.succeeded`); pi-only (`claude_code` rejected at
config validation); no sandboxing (agents run on the operator machine with every API key
in env); commits to the current branch with `git add -A`; whole-tree permission
fingerprints make it structurally unsafe for concurrent runs in one repo (undisclosed).
The ceilings are architectural, not patchable; hardening it approaches the cost of a
test-first TypeScript port that lands in the factory's one language on the proven
harness.

### 3.4 Inkwell sandbox system (disler/inkwell-agent-sandboxes-and-software-factory, MIT)

Three-tier design nested by *credential*, not code: host holds exe.dev SSH + OpenRouter
provisioning key; each sandbox receives exactly one secret — a per-run `sbx-<id>` key
minted with a $50 cap, delivered via stdin (never argv), revoked at teardown with
revocation verified against the authoritative key list (the single-key endpoint returns
200 for deleted keys — they measured it). Results return as ranged git bundles fetched
into `refs/sandbox/<run-id>`; the box never holds a push credential because it runs an
autonomous agent under `--dangerously-skip-permissions`. Every failure path leaves the
VM alive and prints the next command; run records are O_EXCL-created, atomically
replaced, and unreadable-record-is-a-hard-error.

**Adopt (pattern):** the entire credential lifecycle, the run-record discipline, the
bundle harvest, the five-assertion setup gate (git integrity by content, live model
ping, cost-table loaded, credit remaining), the "visible-and-cheap over
invisible-and-spending" failure ordering.

**Reject (system):** one commit, zero orchestration tests, best-of-N unimplemented
(214-line cookbook + 18-line bash loop an agent adapts), teardown shipped unrun
("written but have NOT been run" — their own cookbook), cookbooks already drifting from
recipes, the vendored 2,242-line exedev CLI abstraction unused by the recipes beside it.
The exe.dev seam is ~6 command shapes across 5 just files (~30 lines) — evidence the
provider-driver interface in §5 is small.

### 3.5 exe.dev (Bold Software, Inc.) — from primary docs

**Technical posture (objections refuted/mitigated):** Cloud Hypervisor (KVM) VMs — own
kernel per tenant, ~2s creation from container images written to block devices; **no
inter-VM network even within one account** (overlay is DIY); HTTPS/SSH terminate at
exe.dev's gateway (the "shared host key" is gateway architecture, github.com-style — not
leaked key material — with the honest reframe that exe.dev is in-path for all traffic);
HTTP proxy private-by-default, one explicitly-shared public port max;
`grant-support-root` is customer-run, per-VM, revocable; 9 regions (incl. FRA, LON,
TYO); bearer API tokens with `exp`/`nbf`/command allowlists; server-side secret
injection for LLM keys (VM can use, never read); **AWS/GCP Workload Identity Federation
correctly implemented** — short-lived OIDC tokens exchanged against IAM roles the
customer controls; revocation lives in the customer's own console.

**Compliance posture (objections standing):** no SOC 2/ISO/trust center; privacy notice
explicitly excludes the data-processor relationship a factory would need; no
customer-facing DPA (they hold DPAs with their own sub-processors: AWS, GCP,
Latitude.sh, NetActuate, ClickHouse); liability cap max(paid, $100); no SLA;
terminate-without-cause; content license includes "and improvement" wording; no audit
logs, SAML, or SCIM; US-only control plane ("lobby") regardless of workload region;
managed-LLM-gateway prompt logging unanswered (ClickHouse is a named log sub-processor —
assume logged until denied in writing). Team sharing defaults open
(`vm-sharing admins-only` must be flipped day one). One published security bulletin —
an authorization bug in the sharing boundary.

**Commercial:** Personal $20/mo (50 VMs), Team $25/user/mo (SSO), Reserved Cloud Pool
$35.84/hr ("thousands of VMs", AWS VPC integration — undocumented, ask), custom scoping
invited. Twelve sales-call questions recorded in §9. Pricing and the absent compliance
surface re-verified 2026-08-11; the technical-posture details above remain
single-sourced from the wave-3 agent — **[VERIFY]** before use in sales collateral
(R11, F15).

### 3.6 Orgo (orgo.ai)

Persistent GUI Linux desktops for computer-use agents (Xfce/VNC/click/type/screenshot;
sub-500ms boot from content-addressed golden snapshots; declarative template spec with
`egress_policy`; live resize). Structurally wrong for headless CPU-bound factory work:
0.5 vCPU base / 4 vCPU hard ceiling per machine, ~46-computer self-serve ceiling, 10MB
upload cap, US-only, monthly-bundle pricing with contradictory on-demand claims, no
public SOC 2/DPA/trust center/privacy policy, pre-seed single-round vendor, self-hosting
= contact sales. **Shelved**; harvest golden-snapshot cloning and `egress_policy` as
design references; keep in mind for future GUI-requiring work (browser QA, visual
verification).

### 3.7 Corrections from adversarial verification (wave 2)

1. "agent-team.ts does not exist anywhere" — **refuted**; exists in `QDS-engineer*`
   trees (§3.2). Severity downgraded from "unbuilt mechanism" to "unvendored,
   needs-headless-adaptation mechanism"; the transport gap (§3.1 #3) stands regardless.
2. "Stories cite a fictional warren 0.10.0" — **refuted**; 0.10.0 is a real upstream
   tag; the local checkout is stale. Consequence: all "Warren can't X" claims were
   re-verified against upstream v0.14.1 (they hold), and the stale checkout is itself a
   finding (P0.3 dev record inaccurate).
3. "SSSF commits on false green" — **narrowed**: a real guard exists
   (`accepted=test.passed`); the exposure is that an unedited placeholder suite exits 0,
   so the commit fires on a suite that never ran. Trap, not absent guard.

### 3.8 QDS-Factory current state

Phase 0 gate-red; Phase 1 all draft. SwarmClaw protocol engine, `/api/a2a`,
dispatch_task handler: unbuilt (SwarmClaw today = agent/MCP registry + hardened HTTP
plumbing, 4 routes). cli-anything: 4,956 lines, 150 test cases (re-measured
2026-08-11 post-#99 — F5), transport-agnostic NDJSON
team contract (`parseTeamEventLine` is the whole runtime interface). Hindsight client:
113 tests passing, mock mode. GitNexus + pi-lens: operational. Eight Phase-1 stories
hardened 2026-07-27 (PR #97) — the hardening at the harness/NDJSON boundary (exitStatus
enum, output schemas, path-traversal defense, observability contract) is
runtime-agnostic and survives this redesign; the Warren-specific surface does not.

---

## 4. Decision register

| ID | Decision | Rationale | Alternatives rejected |
|----|----------|-----------|----------------------|
| D1 | **Keep proven code, reset the planning superstructure.** Carry forward cli-anything, team-lead-driver, Hindsight client, SwarmClaw HTTP plumbing, GitNexus/pi-lens; re-derive stories from this architecture. | Tested assets survive any rebuild on merit (~5 months of hardening); the 30-story superstructure encodes Warren assumptions now known false. | True greenfield (re-pays hardening for nothing); evolve-in-place (inherits planning debt). |
| D2 | **Three-tier orchestration:** local Claude Code cockpit → sandbox fleet → in-box execution. | Matches the operator's mental model and Max-subscription economics at tier 1; isolation and horizontal scale at tier 2; team power at tier 3. | Flat single-orchestrator designs (operator becomes the bottleneck; no isolation). |
| D3 | **Tier 1 = Claude Code (Max subscription) driving a *code* fleet dispatcher via skills.** Dispatcher is tested TS, not prompt-glue. | Frontier intelligence at near-zero marginal cost for the operator; deterministic dispatch (disler's fleet layer is an un-coded bash cookbook — a gap we close with real code). Client deployments provision their own Claude auth. **Review caveat (F8):** commercial/hosted operation cannot rest on a personal Max subscription — consumer terms don't cover running a paid service; tier-1 unit economics must be re-run at API pricing before the hosted tier is priced (pre-derivation gate, §8). | Agent-improvises-fleet-commands (drops measured guards silently — disler's own skill forbids it). |
| D4 | **Tier 2 = resident orchestrator agent per sandbox** (video-style), operating a deterministic TS phase engine. | User decision (flexibility, mid-run steering, matches the three-level model that motivated this redesign). Cost/auditability concerns acknowledged: the phase engine keeps gates and transitions deterministic; the resident agent interprets dispatches and steers. Cost knob: cheap model for the resident agent; BYOK direct-egress on generic infra. **Tripwires (F7) — decided now, evaluated after the first month of run data; any one demotes tier 2 to code-only dispatch:** (a) resident-agent token spend > 15% of run total at p50; (b) any audit finding where the agent bypassed or reordered a phase-engine gate; (c) any steering loop the §5.2 watchdog kills twice for the same cause. | Code-only tier 2 (recommended by analysis, declined by user); hybrid resident-pi-agent. |
| D5 | **Tier 3 = pi teams** via `team-lead-driver.ts` + vendored coms-net, behind the existing `QDS_TEAM_RUNNER` seam and NDJSON contract. Pi-first, runtime-pluggable. | Only proven execution path; the bidirectional-coms team capability is the factory's differentiator — neither Warren (single-agent by design) nor SSSF (single-agent-per-phase) has it. | Warren as team harness (structurally impossible — §3.1); Claude Code workers (loses multi-provider economics; can slot in later through the same seam). |
| D6 | **SDLC pipeline layer: port SSSF's design to TypeScript test-first on cli-anything; adopt SSSF's trace schema + visualizer nearly as-is and harden.** | Design is excellent; Python engine has architectural ceilings (§3.3) and would be a second language; visualizer is low-risk read-only code that buys the observability layer in weeks. | Adopt Python wholesale + harden (permanent two-language split, ceilings); build own engine ignoring SSSF (slower to observability, re-derives solved design). |
| D7 | **Sandbox substrate: provider-driver interface with two first-class drivers — exe.dev (hosted/mid-market tier) and OCI images (client-VPC/enterprise tier, Firecracker/Kata option).** | Two sales segments need two trust models; the entire provider surface is ~30 lines (inkwell evidence); exe.dev's technical posture is strong (§3.5) but its compliance gap means Fortune-500 deploys must run client-side; same factory image serves both. | exe.dev-only (fails enterprise review); OCI-only (forfeits fastest hosted path); Orgo (§3.6); Warren-as-substrate (r1's seccomp rationale is stale — F2: the k8s topology needs none of the unconfined flags; the standing reasons are single-agent-only execution, which forfeits the tier-3 team differentiator, plus a second orchestration brain to operate). |
| D8 | **Credential architecture = inkwell lifecycle as code**: per-run spend-capped provisioned LLM keys (mint→cap→use→revoke→verify), secrets never in argv, no push credential in any box, git-bundle harvest, host-side PR creation, WIF for client-cloud access, per-box egress policy, central append-only audit log + cost ledger. | This is the sellable security story — spend containment, data containment, and audit are what close enterprise deals; kernel isolation alone is not. Aligns with existing P1.13/P1.16 concepts. | Long-lived keys in boxes; push credentials in boxes; trusting a managed LLM gateway with unanswered logging. |
| D9 | **Warren: demoted to optional runtime + design reference.** Keep behind the seam; checkout refreshed to v0.14.1 (2026-08-11); correct the P0.3 dev record. | Zero proven QDS execution through Warren; team dispatch structurally impossible (re-verified at v0.14.1 — F1). Upstream posture as a single-agent runtime *improved* (F2/F3: k8s pod-per-run topology, per-run scoped tokens, published exit-code table) — strengthens the optional-runtime path without changing the demotion. Still valuable as reference (supervisor pattern, RuntimeProvider contract, acceptance-test discipline, event streaming). | Keep as planned (P1.6 as written is unimplementable — its assumed exit codes contradict the published table, F3); delete entirely (loses optionality already paid for — the seam exists). |
| D10 | **SSSF Python engine, inkwell orchestration system, Orgo: not adopted as code.** Ideas harvested per §3.3/§3.4/§3.6. | Enterprise-grade factory cannot be built on zero-test single-commit foundations; MIT licenses make idea harvest free. | "Adopt and harden over months" — evaluated honestly; hardening cost ≈ rewrite cost minus the ceilings. |

---

## 5. Target architecture

### 5.1 Tiers

```text
TIER 1 — COCKPIT (operator machine)
  Claude Code (Max sub) + factory skills
  └─ fleet dispatcher CLI (TS, tested): dispatch | fanout N | status | attach | harvest | teardown
       │  provider-driver interface (create/fill/setup/execute/observe/teardown/reap)
       ├──────────────► exe.dev driver          (hosted tier: mid-market)
       └──────────────► OCI driver              (client-VPC tier: enterprise; Firecracker/Kata option)

TIER 2 — SANDBOX (one per run; N in parallel; fleet patterns: best-of-N, many-stories, race)
  resident orchestrator agent  (interprets dispatch, steers, reports; cheap-model default)
  TS phase engine              (ported SSSF design: phases, gates, envelopes, rosters)
  trace store                  (SSSF SQLite schema) + visualizer (auth-gated port)
  run record                   (inkwell discipline: O_EXCL create, atomic write, closed schema)

TIER 3 — EXECUTION (inside each sandbox)
  dispatch_task phase → team-lead-driver.ts → pi lead + N workers (bidirectional coms-net)
  mixed providers/models per role · pi-lens output gating · NDJSON event contract
  5-value exitStatus: success | transient | overflow | logic | lead_failure
```

### 5.2 Contracts (survive from PR #97 hardening, runtime-agnostic)

- **Team runtime interface:** `{file, argv}` spawn + NDJSON events
  (`cost | coms | worker_output | merged | coms_init_error`) — `parseTeamEventLine` is
  the whole contract. Any future runtime (Claude Code teams, Warren single-agent,
  remote executors) plugs in here.
- **Step output schema:** exitStatus enum (CC-1), `changedFiles`, `testResults`,
  `durationMs`, `mulchPrimed`/`mulchPrimeError`, artifacts — as hardened in P1.6.
- **Security invariants:** two-stage decode-then-check path traversal defense,
  `O_NOFOLLOW` reads, RSS watchdog (now correct — the runtime is a genuine local
  subprocess tree inside the sandbox), maxDurationMs ≤ upstream timeout with routing
  margin. **The resident agent is itself watched (F12):** tier-2's orchestrator gets
  its own bounds — max steering iterations per phase, RSS cap, and a spend ceiling
  below the run key's cap — enforced by the phase engine, not by the agent.
- **Observability:** requestId propagation end-to-end; per-phase sub-timings; every
  prompt persisted pre-execution; per-check gate evidence; token/dollar cost split
  including cache economics (SSSF's UsageBreakdown model).

### 5.3 Data flow (one run)

channel/operator → tier-1 dispatch (mint run-id, mint capped key, create box, fill via
clone + SHA pin, setup gate) → tier-2 resident agent receives brief → phase engine walks
SDLC (plan → build → test → review → document), dispatch_task phases spawn pi teams →
gates validate each envelope; failures re-enter the same session bounded times →
harvest: ranged git bundle + artifacts tar + trace db → tier-1 verifies bundle, fetches
into `refs/sandbox/<run-id>`, **re-verifies out-of-box (F10): tests + gates re-run in
a context that never trusted the box** → opens PR (host-side token; runId in PR
body) → teardown:
spend captured, key revoked + verified, box destroyed, record closed → audit log + cost
ledger updated → memory capture into Hindsight banks.

### 5.4 Memory & code intelligence

Unchanged from existing designs: Hindsight two-tier banks (QDS-MEM-001/002/003), mulch
priming of tier-3 teams (empty bank is not an error), GitNexus + pi-lens for code
intelligence and output gating. Wired after the execution spine is live — the flywheel
needs runs to fill it.

---

## 6. Security architecture (the enterprise pitch)

1. **Isolation:** per-run sandbox (exe.dev KVM VM or client-side OCI/Firecracker);
   no east-west network; one factory workload per box.
2. **Credential containment:** exactly one secret per box — a spend-capped, per-run,
   revocation-verified LLM key. Cloud access (if any) via WIF short-lived tokens the
   client revokes in their own IAM. GitHub tokens never enter a box.
3. **Data containment:** enterprise tier runs entirely inside the client boundary;
   hosted tier uses BYOK with direct provider egress + provider-side ZDR (never a
   third-party managed gateway until logging is contractually answered). Per-box
   egress allowlists are **DEFERRED to the OCI driver (§8 step 7, see DD-11);
   exe.dev exposes no per-VM egress control today**, so for v5.0 the hosted-tier
   guarantee is scoped to direct-provider egress and must not be sold as an
   allowlist. The policy re-enters once the OCI driver owns the network namespace.
4. **Audit:** central append-only run/audit log (host-side, survives box destruction),
   full prompt/envelope/gate-evidence trace per run, cost ledger with per-run
   attribution, PR bodies carrying run correlation ids.
5. **Blast-radius honesty:** sandboxes contain spend and credentials; egress policy
   contains data; agents inside run with skip-permissions *because* the box, not
   instead of it. No claim of containment we can't enforce in code.
6. **Output integrity (F10):** nothing produced inside a box is trusted at the
   boundary. Bundles are re-verified host-side (tests + gates re-run outside the box)
   before a PR opens; in-box trace/gate evidence is treated as claims, not proof —
   by item 5's own logic, a skip-permissions agent controls everything it emits.
7. **Trace confidentiality (F11):** the trace DB carries full compiled prompts —
   i.e., client source code. The visualizer is never the box's one shared public
   port; access is tier-1-tunneled and auth-gated, and harvested traces live inside
   the same data boundary as the repo itself.

---

## 7. Asset disposition

| Asset | Disposition |
|---|---|
| `cli-anything/` (4,956 lines, 150 tests) | **KEEP** — tier-3 harness core |
| `cli-anything/scripts/team-lead-driver.ts` | **PROMOTE** — canonical team runtime |
| `pi-vs-claude-code-vendor/` (coms*.ts) | **KEEP** — vendored coms substrate |
| Hindsight client + tests (113) | **KEEP** — memory layer |
| SwarmClaw HTTP plumbing (body caps, request-id, SIGTERM discipline) | **KEEP** — host-side service chassis |
| GitNexus + pi-lens | **KEEP** |
| PR #97 harness-boundary contracts | **KEEP** (runtime-agnostic parts) |
| 30-story superstructure, Warren-specific contract surface (CC-13/14, SPIKE-3 as written) | **RETIRE** — re-derive stories from this doc |
| Warren (`/Users/steve/warren`) | **OPTIONAL RUNTIME + REFERENCE** — checkout at v0.14.1 (done 2026-08-11; local mods stashed); P0.3 dev record corrected 2026-08-11 (§3.1 row 6) |
| `agent-team.ts` (QDS-engineer trees) | **REFERENCE ONLY** — spawn pattern already extracted |
| SSSF design + visualizer | **ADOPT** (port design to TS; harden visualizer) |
| SSSF Python engine | **REFERENCE ONLY** |
| Inkwell credential/run-record recipes | **ADOPT AS PATTERN** (reimplement in the drivers) |
| Inkwell system, exedev vendored CLI | **REFERENCE ONLY** |
| Orgo | **SHELVED** (golden-snapshot + egress_policy ideas harvested) |
| exe.dev | **SUBSTRATE, HOSTED TIER** — pending sales-call answers (§9) |

---

## 8. Build order

0. **PROOF (½ day, before anything else):** `team-lead-driver.ts` runs a pi team that
   *edits real code and runs tests* (the 2026-07-20 proof was a research task, N=1,
   and pi/coms have had three weeks to drift). Executable definition of done (F6):
   target = a scratch clone of a real QDS repo with a seeded failing test; success =
   lead + ≥2 workers produce a diff that makes the suite green, the NDJSON stream
   parses end-to-end (`parseTeamEventLine`, zero malformed lines), merged JSON
   validates against the step-output schema, and cost events sum to a nonzero total.
   Partial success (edits land, suite still red) = FAIL. Flaky suite = rerun once,
   then FAIL. If this fails, D5's basis collapses and the plan reopens — nothing
   else starts first.
1. **TS phase engine** (SSSF port): phases, gates, envelopes, roster config, trace
   writes. Test-first; the SSSF reference docs double as the spec.
2. **Provider seam + exe.dev driver + credential lifecycle** (inkwell pattern as code:
   mint/cap/revoke/verify, run records, bundle harvest). Teardown gets tests —
   the phase disler shipped unrun. Includes quota accounting (F9): the 50-VM /
   100GB-pooled-disk ceiling tracked host-side, failed teardowns feed a reaper queue,
   dispatch refuses when headroom < N. **Gate: `@mariozechner/*` (pi) redistribution
   licensing (F13) resolves before the OCI image contract is defined here — the
   enterprise tier ships pi + vendored coms into client VPCs.**
3. **Fleet dispatcher + tier-1 skills** (dispatch, fan-out N, status, attach, harvest,
   teardown, reap). Best-of-N becomes code.
4. **Visualizer adoption** (auth, tests, per-box deploy).
5. **Lights-on PR:** channel → fleet → team → gates → bundle → host-side re-verify
   (F10) → PR with audit chain and cost ledger. The factory's P1.15 moment.
6. **Memory wiring** (Hindsight capture/recall, mulch priming, review harvester).
7. **OCI driver** when the first enterprise conversation demands it (image contract
   defined in step 2 so no rework).

**Pre-derivation gates (2026-08-11 review):**

- **Economics (F8):** unit-economics model — per-run cost floor on the proven path
  (resident-agent tokens + team tokens + VM $), tier-1 priced at API rates rather
  than Max-subscription rates — before the hosted tier is priced.
- **Disposition table (F14):** all 30 retired-superstructure stories enumerated
  keep / retire / re-derive, with surviving clauses named, so story authoring does
  not re-litigate the supersession boundary per story.
- **Licensing (F13):** see step 2 gate.
- **Step-0 DoD (F6):** written above; runs first.

Story derivation from this order replaces the retired superstructure; sizing against
the 2-dev/enterprise-rigor throughput baseline (~45–50 pts/4 weeks) happens at story
authoring, not here.

---

## 9. Risks & open items

| # | Risk / open item | Mitigation / owner |
|---|---|---|
| R1 | team-lead-driver unproven for code-editing teams | Build-order step 0 with executable DoD (F6); gate everything on it |
| R2 | exe.dev compliance gap (no SOC 2/DPA/SLA; $100 cap; gateway logging unanswered) | 12 sales-call questions recorded in the exe.dev research report; hosted tier contracts absorb/price the risk; enterprise tier never touches exe.dev |
| R3 | Resident-agent tier 2 cost/auditability | Cheap-model default; deterministic phase engine holds the gates; explicit demotion tripwires in D4 (F7), evaluated after first month of run data |
| R4 | Single-maintainer 0.x dependencies (pi, coms-net, Warren-if-used) | coms already vendored with DIVERGENCE.md; same discipline for anything else adopted; runtime seam limits blast radius |
| R5 | Stale local checkouts (warren 0.8.4 vs 0.14.1; disler repos cloned 2026-08-11 shallow) | **CLOSED 2026-08-11:** warren at v0.14.1; disler repos re-pulled (unchanged); exe.dev re-fetched; version-sensitive claims re-verified (§10) |
| R6 | Claude auth for client-deployed tier-1 (Max sub is operator-personal) | Client onboarding provisions client-owned Claude subscription or API key; architecture unaffected. Widened by F8: hosted-tier *operation* also cannot rest on the operator's personal Max sub (consumer terms exclude running a paid service) — §8 economics gate prices tier-1 at API rates |
| R7 | SSSF/inkwell idea-adoption licensing | MIT both for idea harvest; **`@mariozechner/*` (pi) redistribution check upgraded to a blocker (F13)** gating the OCI image contract (§8 step 2) — the enterprise tier ships pi + vendored coms into client VPCs |
| R8 | Fleet-level concurrency safety (the flaw SSSF has in-repo) | One run = one box = one key = one record; no shared working tree by construction. Extended by F9: host-side quota accounting + reaper for leaked VMs so fan-out can't exhaust the 50-VM / pooled-disk ceiling |
| R9 | In-box evidence forgeable — a compromised or confused skip-permissions agent ships green (F10) | Host-side re-verification before PR (§5.3, §6.6); in-box trace/gate evidence = claims, not proof |
| R10 | Trace DB carries client source (full compiled prompts); visualizer exposure (F11) | §6.7: never the box's shared public port; tier-1-tunneled + auth-gated; traces stay inside the repo's data boundary |
| R11 | Evidence-pipeline error rate — same-family agents, ~25% wave-1 claim error; review found 4 more stale facts (F15) | All load-bearing claims re-anchored to refreshed sources this revision; §3.5 technical details and §3.6 remain single-sourced — [VERIFY] before external use |

---

## 10. Independent adversarial review — record (2026-08-11)

r1 was produced in one long session with one model family and mandated a
fresh-context break-it review before story derivation. That review ran 2026-08-11
in a fresh session against refreshed evidence: warren fetched and checked out at
v0.14.1 (local mods stashed as "pre-adversarial-review"); both disler repos
re-pulled (unchanged, still single-commit); exe.dev pricing/compliance re-fetched
(matched r1 exactly).

**Load-bearing claims re-tested and held:**

- (a) Warren is single-agent-per-run at v0.14.1 — zero team/multi-agent changelog
  entries 0.9→0.14.1; no team surface in source.
- (b) No mechanism carries env/config from the CLI client into a server-side
  burrow — `CreateRunInput` has no env field.
- Also verified clean: `agent-team.ts` behavior (`ctx.ui.select` at `:580`, zero
  reads of `QDS_AGENT_TEAM_CONFIG_JSON`, 734 lines); SSSF placeholder gates
  (`quality.py:11` — "Every block ships as an `echo` that exits 0") and the
  `make_adw.py:55` `run.succeeded` crash (property removed per `runner.py:122`);
  inkwell $50 cap (`create.just:22`), stdin key delivery (`fill.just:147`), and
  teardown "written but have NOT been run" (their cookbook, verbatim); warren
  compose unconfined flags still present at v0.14.1 (burrow topology only);
  exe.dev pricing exact and compliance surface still absent.

**Findings incorporated in r2 (F-numbers referenced throughout this document):**

| # | Finding | Disposition |
|---|---|---|
| F1 | `SPEC.md:2729` citation dead — SPEC deleted upstream (#741) | Re-anchored to source-derived evidence (§1, §3.1) |
| F2 | Warren k8s topology (v0.10.0) invalidated D7's seccomp rationale | D7/D9 rationale rewritten; §3.1 sandboxing updated |
| F3 | v0.14.1 publishes a real exit-code table contradicting P1.6's assumption | §3.1 row 5 rewritten; conclusion strengthened |
| F4 | Line citations stale after the #99 runner split | Corrected: `runner.ts:533`, `runner.ts:554`, `team-events.ts:36` |
| F5 | Metric drift (cli-anything 4,956 lines / 150 tests; warren counts 0.8.4-era) | Re-measured or retired (§3.1, §3.8) |
| F6 | Build step 0 had no definition of done | Executable DoD written (§8.0) |
| F7 | D4 resident agent lacked kill criteria | Demotion tripwires added to D4 |
| F8 | Max-subscription economics unsound for commercial operation | D3 caveat; economics pre-derivation gate (§8); R6 widened |
| F9 | exe.dev quota exhaustion / VM leak unexamined | Quota accounting + reaper (§8 step 2); R8 extended |
| F10 | In-box evidence trusted at harvest — result-integrity gap | Host-side re-verify (§5.3, §6.6, §8.5); new R9 |
| F11 | Visualizer/trace confidentiality understated | §6.7; new R10 |
| F12 | No watchdog on the resident agent itself | §5.2 invariant added |
| F13 | pi redistribution licensing is a blocker, not a footnote | R7 upgraded; gate on §8 step 2 |
| F14 | Supersession boundary undefined across 30 stories | Per-story disposition table required pre-derivation (§8) |
| F15 | Same-family evidence pipeline, ~25% wave-1 claim error rate | New R11; §3.5 technical details marked [VERIFY] |
| F16 | Warren dead-tag release hygiene (v0.12.0/v0.12.1) | Recorded in §3.1 maturity; folds into R4 |

**Verdict:** architecture direction survives — D5, D6, D8 re-verified sound; D7/D9
re-scored on refreshed facts without changing the decisions; D4 stands with
tripwires. Story derivation may begin once the §8 pre-derivation gates close:
F6 (step-0 DoD run), F8 (economics), F13 (licensing), F14 (disposition table).
