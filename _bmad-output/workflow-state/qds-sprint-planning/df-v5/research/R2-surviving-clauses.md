# R2 — Surviving-Clause Extraction for the 10 RE-DERIVE Stories

**Agent:** Research Agent 2 (Surviving-Clause Extraction)
**Date:** 2026-08-11
**Authority consulted:** `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` §2 (dead premises) and §3 (per-story survives/dies table)
**Sources read in full:** all 10 RE-DERIVE story files under
`_bmad-output/sprint-artifacts/phase-1/stories/` (repo-relative; local checkout root at time of
writing: `<workspace>` = `/Users/steve/QDS-Factory`)
**Purpose:** give writer agents the exact text to paste, so no successor story re-litigates the
supersession boundary.

---

## 0. CRITICAL FINDING — READ BEFORE USING ANY CLAUSE BELOW

**Audit §3's clause labels are not verbatim citations of the current story files.** I set out to
copy the text behind each named clause and found that, for 8 of the 10 stories, the audit's
`AC<n>` / `INV-<n>` labels do not resolve to the clause the audit describes. Three distinct
failure modes, in increasing severity:

1. **Label drift (recoverable).** The audit names `AC4` but the described substance lives in
   `AC1`, or in an INV, or in a Technical Notes subsection. The text exists; only the pointer is
   wrong. Example: P1.6's step-output schema is **AC1**, not AC3.
2. **Nonexistent labels (must not be cited).** The audit names ACs that do not exist. **P1.6 has
   4 ACs — the audit cites AC5 and AC6. P1.17 has 3 ACs — the audit cites AC4. P1.19 has 4 ACs —
   the audit cites AC5.** Verified by count (`## Acceptance Criteria` block, numbered items).
3. **Phantom clauses (net-new, not surviving).** The audit names requirements whose text appears
   **nowhere in the source story** — and in some cases nowhere in the whole 19-story phase-1 set.
   These cannot "survive verbatim" because there is no verbatim to survive. Full list in §11.

I confirmed mode 3 by grepping the entire current story directory for the audit's own quoted
strings. **Zero hits** for: `SPIKE-3`, `parseTeamEventLine`, `NDJSON`, `QDS_AGENT_TEAM_CONFIG_JSON`,
`micro-dollar`, `unpriced`, `cacheRead`, `qds cost`, `qds audit`, `runId ack`, `prompts persisted`,
`survives restart`, `allowlist`, `force-push`, `exit convention`, `burrow branch`, `git integration`.

Three of these — `SPIKE-3`, `QDS_AGENT_TEAM_CONFIG_JSON`, `parseTeamEventLine` — appear in
`_bmad-output/sprint-artifacts/_research/f6-step0-proof-2026-08-11.json` and nowhere else in
`_bmad-output/`. The audit's line-number citations also do not resolve: audit §2 cites "P1.6 story
lines 78–79" for a `0/1/2/3` exit-code assumption, but `p1-6-pi-team-protocol-step.md:78-79` is the
harness precedence rule. **The most likely explanation is that audit §3 was written against the
step-0 proof artifact and the v5 design's own contract language rather than against the story files
it cites.** I did not investigate further — that is outside my brief — but the derivation owner
should decide whether audit §3 needs a correction pass before writers consume it.

### What this means for writer agents — the operating rule

> **Paste from §2–§11 of THIS document, not from audit §3.** This document quotes the actual
> source text with real labels and real line numbers. Where the audit named something that does
> not exist, I say so explicitly and mark it **NET-NEW**. A NET-NEW item is a legitimate v5
> requirement and probably belongs in the successor story — but it must be authored and reviewed
> as new material, **not** pasted under a "survives verbatim, do not re-litigate" banner. Doing the
> latter would launder an unreviewed requirement through F14's no-re-litigation shield.

### Clause-label accuracy at a glance

| Story | Audit-named clauses | Resolve as named | Label drift | Nonexistent label | Phantom (NET-NEW) |
|---|---|---|---|---|---|
| P1.1 | 5 | 1 | 2 | 0 | 2 |
| P1.4 | 3 | 1 | 1 | 0 | 1 |
| P1.6 | 7 | 1 | 4 | 2 | 2 |
| P1.8 | 2 | 0 | 2 | 0 | 0 |
| P1.10 | 4 | 1 | 2 | 0 | 1 |
| P1.13 | 7 | 1 | 4 | 0 | 4 |
| P1.15 | 5 | 0 | 2 | 0 | 3 |
| P1.16 | 5 | 1 | 2 | 0 | 2 |
| P1.17 | 5 | 0 | 1 | 1 | 3 |
| P1.19 | 5 | 0 | 3 | 1 | 2 |

(Counts overlap where one audit item is part drift, part phantom; the per-story crosswalks below
are authoritative.)

**One substantive contradiction, not just a labelling problem:** audit §3 says P1.13 AC2 carries
"USD as integer **micro-dollars**". The source story defines `costCents: integer` throughout, with
a `500 cents` / `$5.00` default cap. Cents and micro-dollars differ by 10,000×. A writer who pastes
the audit's phrasing while inheriting the source's `500` default silently drops the cap from $5.00
to $0.0005. See §6.

---

## 1. P1.1 — Dev manager registered (hermes_local)

**Source:** `_bmad-output/sprint-artifacts/phase-1/stories/p1-1-dev-manager-a2a.md` (195 lines, 5 ACs, INV-1..INV-5)

**Dies (audit §2/§3):** AC1–AC3's SwarmClaw `/api/agents` + `/api/a2a` + protocol-engine mechanism.
The factory front door is no longer SwarmClaw `/api/a2a` + a `dispatch_task` handler on an unbuilt
protocol engine; v5's front door is tier-1 Claude Code + the tested fleet-dispatcher CLI (D2/D3),
with SwarmClaw demoted to host-side service chassis (§7).

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC4 requestId propagated dispatch→step→response | Technical Notes "Correlation ID propagation (CC-9)" L47–49; Observability Contract (CC-9) L161–169 | **Drift** — real AC4 (L37) is the transport data-flow rule |
| AC5 malformed dispatch → 4xx + no spawn | INV-1 L67, INV-5 L71, AC1 L34 tail, DoD ingress-validation L178, missing-ID rule L48; "no spawn" ≈ DoD L190 | **Drift** — real AC5 (L38) is forward-verification |
| runId ack semantics | — | **NET-NEW.** P1.1 contains no `runId`. Acks carry `requestId` + JSON-RPC `id` |
| CC-1 5-value | L52, L109 | **Resolves** |
| CC-5 correlation | — | **NET-NEW label.** P1.1 has no CC-5; correlation is CC-9. Treat as a typo for CC-9 |

### Verbatim — carry these

**Correlation ID propagation (CC-9)** — `p1-1-dev-manager-a2a.md:47`
```
- **Correlation ID propagation (CC-9):** Every A2A request carries a `requestId` (UUID v4, generated by the caller). The caller should set JSON-RPC envelope `id` and `params.requestId` to the same UUID. If `params.requestId` is absent, SwarmClaw populates it from the envelope `id`. SwarmClaw also emits the `x-request-id` HTTP response header (UUID v4 strict, `src/swarmclaw/index.ts:42-46`) on every A2A response so cross-layer join works at the transport boundary without parsing JSON-RPC. The observability layer uses `requestId` for trace correlation. The requestId propagates through all layers: SwarmClaw A2A router → CLI-Anything harness → Warren → PI agents. The requestId appears in: (1) JSON-RPC request `params.requestId`, (2) JSON-RPC response `result.requestId`, (3) the `x-request-id` HTTP response header, (4) all observability log entries. The requestId is the join key for cross-layer tracing.
```

> Re-aim note for writers: the layer chain `SwarmClaw A2A router → CLI-Anything harness → Warren →
> PI agents` is dead as written. Re-aim to the v5 chain (tier-1 dispatch → fleet dispatcher →
> in-sandbox subprocess tree → phase engine step) and keep the four appearance sites and the
> "join key" sentence intact.

**Missing-ID rule (single canonical rule)** — `p1-1-dev-manager-a2a.md:48-49`
```
  - **Missing-ID behavior (single canonical rule).** The JSON-RPC envelope `id` is **REQUIRED** on ingress: a request whose `id` is absent or `null` is rejected with `-32600` (Invalid Request) and is never delegated — this is the rule the DoD ingress-validation item enforces, and it is the only place a missing id is tolerated at all (the `-32600` response itself carries `error.data.requestId: null`, per the taxonomy below, because there is no id to echo). SwarmClaw therefore **never auto-generates an envelope `id`**.
  - Auto-generation applies to the two *derived* fields only: (a) if `params.requestId` is absent, SwarmClaw populates it from the (mandatory) envelope `id`; (b) if the inbound `x-request-id` HTTP header is absent or is not a strict UUID v4, SwarmClaw generates one for the transport layer (`src/swarmclaw/index.ts:42-46`). The response's top-level `id`, `result.requestId`, and `x-request-id` header are then all populated, so a caller can always correlate a *valid* request to its response.
```

**Schema validation at the boundary — the "4xx + no spawn" substance** — `p1-1-dev-manager-a2a.md:67`, `:71`, `:178`, `:190`
```
- INV-1: A2A calls require valid `targetAgentId` and `requesterAgentId` headers; missing headers result in 400. `requesterAgentId` must reference an agent registered via POST /api/agents (checked at invocation time). Unregistered requesterAgentId values return 422 with error code -32011.
```
```
- INV-5 (P1.1-V1): A2A registration requires both `agentType` and `endpointUrl` to be non-empty strings; missing or empty (zero-length or whitespace-only) → HTTP 400. (Functional behavior is asserted in AC1; this invariant pins it as a security-contract requirement, not an AC-only check.)
```
```
- [ ] **Contract:** A2A JSON-RPC 2.0 envelope validated on ingress (jsonrpc:"2.0", method, id present). Envelope `id` absent OR `null` → `-32600` with `error.data.requestId: null`; the request is NOT delegated and no envelope id is auto-generated (Correlation ID propagation, missing-ID rule).
```
```
- [ ] **Test (agent-not-found):** A2A delegation with targetAgentId for an unregistered agent returns JSON-RPC error code -32011; no HTTP request is made to any endpoint.
```

> The last line is the closest thing in the source to "no spawn": a rejected dispatch performs no
> downstream call at all. In v5 terms this becomes "no box is provisioned and no key is minted" —
> which strengthens the clause, since a spawn now costs a provisioned credential.

**exitStatus enum note (CC-1)** — `p1-1-dev-manager-a2a.md:52`
```
- **exitStatus enum note (CC-1):** The canonical exitStatus enum is the 5-value set `success|transient|overflow|logic|lead_failure` (canonical in P0.3, `cli-anything/src/types.ts:78-84`). P0.3 previously used `logic_error` (now corrected). `lead_failure` is harness-classified: it is emitted when the lead process exits before the merged-JSON result can be produced — the `exitCode` field carries the lead process exit code. Any consumer receiving an unknown exitStatus should treat it as `transient`.
```

**Single-source-of-truth import** — `p1-1-dev-manager-a2a.md:179`
```
- [ ] **Impl (N-P1.1-NEW-1):** Import `ExitStatus` from `cli-anything/src/types.ts` (single source of truth; do not re-declare the enum locally).
```

### Notes for writers

- The **A2A Error Code Taxonomy (B2)** table (L132–151) and the `transient` → -32012 retryability
  rule (L147) are not named by the audit but are pure contract surface with no Warren dependency.
  Recommend carrying the retryability *semantics* (transient is retryable; logic/overflow/
  lead_failure are not) even if the JSON-RPC numeric codes go away with the front door.
- **Retry ownership** (L126) resolves a real contradiction and states a single owner. If v5 keeps
  any retry at the dispatch boundary, carry the "single owner, callers MUST NOT add a second retry
  loop" rule verbatim — it is the reason the `timeoutMs * 3 + 3s` ceiling holds.
- P1.1's `runId` gap is worth an explicit decision: v5 dispatch does need a run handle, and the
  audit assumed one exists here. It does not. Whoever writes the successor must define ack
  semantics from scratch (see §11).

---

## 2. P1.4 — qds-factory protocol template

**Source:** `p1-4-protocol-template.md` (182 lines, 7 ACs, INV-1..INV-3)

**Dies (audit §2/§3):** the engine premise — AC1/AC2/AC4 as SwarmClaw-engine behaviors — and CC-3's
binding to the SwarmClaw template registry. That engine was never built; D6 adopts the SSSF-ported
TS phase engine as the executor instead.

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC3 template/step-graph schema versioned + validated at load | AC1 L33 (`version: "1.0.0"`); Registration Contract L128–134; Template versioning L124; guards L123; DoD L168; INV-1 L149 | **Drift** — real AC3 (L35) is graceful degradation |
| AC5 per-step timeout ≤ upstream budget with margin (maxDurationMs discipline) | Not in P1.4. Lives in **P1.6 INV-4** (`p1-6:115`) and P1.1 Timeout Alignment CC-7 (`p1-1:155`) | **NET-NEW to P1.4** — see §3 for the real text |
| recorded compare/decide rationale as a requirement | AC4 L36 (compare) + AC5 L37 (decide) + ComparisonResult/DecisionResult schemas L80, L95 | **Resolves** (this one is genuinely AC5, in part) |

### Verbatim — carry these

**Versioned + validated schema (the AC1 half)** — `p1-4-protocol-template.md:33`
```
1. **(make-or-break)** Given SwarmClaw is running, When the qds-factory protocol template is registered via POST to the template API, Then the response is 201 with `{ "templateId": "qds-factory", "version": "1.0.0", "phaseCount": 5 }`.
```

**Template validation errors on registration** — `p1-4-protocol-template.md:129-134`
```
- **Template validation errors on registration:**
  - branchCount < 2: HTTP 400, -32602, "Parallel phase requires >= 2 branches"
  - branchCount > 8: HTTP 400, -32602, "Parallel phase requires <= 8 branches"
  - invalid phase kind: HTTP 400, -32602, "Invalid phase kind: <kind>"
  - phaseCount < 2: HTTP 400, -32602, "Template must have >= 2 phases"
  - templateId pattern mismatch: HTTP 400, -32602, "templateId must match ^[a-z][a-z0-9-]{1,63}$"
```

**Template versioning / immutability** — `p1-4-protocol-template.md:124`
```
- **Template versioning:** Protocol templates are immutable once registered. Updates require a new templateId or a new version number. In-flight sessions pin the template version at invocation time — the session runs against the version that was current when it started. New invocations after a template update use the new version. Old versions remain retrievable (for debugging) but cannot be invoked for new sessions. Template versions are retrieved via `GET /api/protocol-templates/{id}/versions/{version}`. The response includes the full template definition for debugging.
```

> The "in-flight sessions pin the template version at invocation time" rule is the load-bearing
> half and is runtime-agnostic. The `GET /api/protocol-templates/...` route is SwarmClaw mechanism
> and dies with the registry.

**Recorded compare rationale (AC4)** — `p1-4-protocol-template.md:36`
```
4. Given 3 parallel branches with distinct outputs, When the compare phase executes, Then it produces a `ComparisonResult` with a 3x3 overlap matrix and a recommendation containing ranked preferred branches with rationale.
```

**Recorded decide rationale (AC5)** — `p1-4-protocol-template.md:37`
```
5. Given comparison results where branch A scores 0.85 and branch B scores 0.70, When the decide phase executes, Then it selects branch A as winner with a `DecisionResult` containing scores, breakdown, and rationale (no tie flag since delta > 0.1).
```

**DecisionResult shape + tie rule** — `p1-4-protocol-template.md:94-97`
```
3. If top-2 scores are within 0.1 (tie), flag for human review in the output.
4. Produce a `DecisionResult`: `{ winner: agentId, scores: [{ agentId, score, breakdown: { testPassRate, uniqueFileCoverage, summaryQuality } }], tie: boolean, rationale: string }`.
```
```
**Tie-breaking:** If top-2 scores are within 0.1, the DecisionResult includes `tie: true` and `rationale: "Scores within 0.1 threshold — manual review recommended"`. No automatic tie-breaking — human review is the tie resolution path. The protocol engine pauses the session and emits a `tie_detected` event.
```

**All-branches-failed degradation** — `p1-4-protocol-template.md:88`
```
**Minimum branches for compare:** The compare phase requires >= 1 successful branch output. If all parallel branches fail, the compare phase produces `ComparisonResult` with `branches: []`, `overlapMatrix: []`, and `recommendation: { preferredBranches: [], rationale: "All branches failed" }`. The protocol then proceeds to decide phase, which produces `DecisionResult` with `winner: null`, `tie: false`, and `rationale: "No branches to decide between"`. The summarize phase reports the complete failure. When all branches fail, the protocol engine emits a `no_viable_output` event with payload: `{ sessionId, templateId, failedBranches: [{ branchId, error }] }`.
```

### Notes for writers

- Audit §2 says the graph intent "maps to phase abstraction + best-of-N (step 3)". The compare and
  decide **algorithms** (L76–97) are the concrete best-of-N scoring the audit is pointing at. They
  are pure computation over `changedFiles`/`testResults`/`summary` — no SwarmClaw surface. Strong
  candidate to carry wholesale into the step-3 best-of-N story, not just the "rationale is
  required" one-liner the audit names.
- The **rationale requirement** is the durable clause: a compare/decide step must record *why*,
  not just *what*. Say it as a requirement on the phase-engine gates-with-evidence mechanism, per
  audit §3's parenthetical.
- P1.4's `maxDurationMs` appears only as a `dispatch_task` config field (L108, L114). The timeout
  discipline the audit attributes here is P1.6's. Pull it from §3.

---

## 3. P1.6 — Pi-team run → structured JSON (flagship)

**Source:** `p1-6-pi-team-protocol-step.md` (141 lines, **4 ACs**, INV-1..INV-4)

**Dies (audit §2/§3):** AC1's `warren run` team dispatch (single-agent-per-run at v0.14.1);
`QDS_AGENT_TEAM_CONFIG_JSON` as roster transport (never crosses the CLI→server wire); the 0/1/2/3
exit-code assumption and SPIKE-3 (never ran); CC-13/CC-14; burrow-workspace recording.

> **Label warning.** Audit §3 cites P1.6 AC3, AC4, AC5, AC6. **The story has 4 ACs.** AC5 and AC6
> do not exist. The audit's AC3 content is really AC1; its AC5 content is INV-2; its AC6 content is
> the CC-9 Observability Contract. Its INV-1 and INV-2 attributions are also off by one and two
> respectively. Only **INV-3 (RSS watchdog)** resolves as named.

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC3 step-output schema (5-value exitStatus, changedFiles, testResults, durationMs, mulchPrimed/mulchPrimeError, artifacts) | **AC1** L32 (success schema) + Contracts/Schema L62. Real AC3 (L34) is the *failure* schema | **Drift** |
| AC4 NDJSON events parse via `parseTeamEventLine`, zero malformed lines | Nowhere in P1.6 or any phase-1 story. Real AC4 (L35) is the empty-Mulch-bank clause | **NET-NEW** |
| AC5 two-stage decode-then-check + `O_NOFOLLOW` | **INV-2** L112–113; DoD Security L128; DoD test L129 | **Drift (AC5 does not exist)** |
| AC6 observability (requestId, per-phase sub-timings, prompts persisted pre-execution) | **Observability Contract (CC-9)** L93–98. "prompts persisted pre-execution" appears nowhere | **Drift + partial NET-NEW (AC6 does not exist)** |
| INV-1 no secrets in step output | Nowhere in P1.6. Real INV-1 (L110–111) is the pinned workspace root | **NET-NEW** |
| INV-2 maxDurationMs ≤ upstream timeout minus routing margin | **INV-4** L115 (+ Timeout alignment CC-7 L86) | **Drift** |
| INV-3 RSS watchdog | **INV-3** L114 | **Resolves** |

### Verbatim — carry these

**Step-output schema, success (real AC1)** — `p1-6-pi-team-protocol-step.md:32`
```
1. **(make-or-break)** Given an active protocol session with a dispatch_task step, When the step executes, Then the CLI-Anything harness is invoked with the task payload and invokes `warren run <agent> <project> -p "<prompt>"` (CC-13 canonical surface — no `--config` flag; team/task params carried in the agent-team extension config the harness materializes into the run workspace), and the step output is structured JSON containing `{ exitStatus: "success"|"transient"|"overflow"|"logic"|"lead_failure", changedFiles: string[], testResults: { passed: number, failed: number }, summary: string, durationMs: number, mulchPrimed: boolean, mulchPrimeError?: string, artifacts: Array<{ name: string, path: string }> }`. The canonical exitStatus enum is 5-value (CC-1): `lead_failure` = harness-classified (lead process exits before merged-JSON emit; `exitCode` reflects lead process exit, not a warren exit code).
```

> **Surgery required.** The dispatch half of this AC (`the CLI-Anything harness is invoked ... and
> invokes warren run ...`) is dead. The **schema object** is what survives verbatim. Paste from
> `the step output is structured JSON containing {...}` onward.

**Step-output schema, failure (real AC3)** — `p1-6-pi-team-protocol-step.md:34`
```
3. Given `warren run` exits with non-zero code, times out, or the lead process exits before merged-JSON emit, When the harness captures the failure, Then the step output is `{ exitStatus: "transient"|"overflow"|"logic"|"lead_failure", error: string, exitCode: number | null, partialOutput: string | null, durationMs: number, mulchPrimed: boolean, mulchPrimeError?: string }` and the protocol engine does not crash. When Warren is killed by a signal, `exitCode` is `null`. `lead_failure` is harness-classified: emitted when the lead process exits **under its own control** before merged-JSON emit, in which case `exitCode` reflects the lead process exit, not a warren exit code. A lead the harness itself killed (RSS watchdog, `userCancel`) is classified by signal origin — `overflow`/`logic` — not `lead_failure`; see the precedence rule in Technical Notes. Consumers must handle `null` exitCode alongside the 5-value exitStatus enum.
```

**Empty-bank non-error rule (real AC4)** — `p1-6-pi-team-protocol-step.md:35`
```
4. Given a fresh repository with no prior Mulch expertise in the specified Hindsight bank, When the dispatch_task step executes with Mulch priming, Then the Pi team runs without primed context (empty context is acceptable), the step output includes `mulchPrimed: false`, and execution succeeds with `exitStatus: "success"` — empty bank is not an error condition.
```

> Not named by the audit, but it is the clause P1.15's predecessor reconciliation leans on
> ("empty Hindsight bank is a non-error condition per P1.6 AC4"). Carry it or P1.15's seam
> argument loses its footing.

**exitStatus taxonomy (CC-1)** — `p1-6-pi-team-protocol-step.md:39`
```
- **exitStatus taxonomy (CC-1, aligned with P0.3):** Previous `status: 'failure'` maps to `exitStatus: 'transient'|'overflow'|'logic'|'lead_failure'`. Consumers must handle all four failure modes. This aligns with P0.3's canonical 5-value taxonomy. `"success"` = normal completion. `"transient"` = retryable failure (network, timeout). `"overflow"` = resource limit exceeded. `"logic"` = task logic error. `"lead_failure"` = harness-classified (lead process exits under its own control before merged-JSON emit — a harness-initiated kill maps to `overflow`/`logic` instead; `exitCode` reflects lead process exit, not a warren exit code). P0.3 previously used `exitStatus: 'logic_error'` (corrected to `'logic'` in Round 8 Wave 5b). The canonical CC-1 value is `'logic'`. Any encounter with `'logic_error'` in other stories should be treated as a typo for `'logic'`.
```

**Precedence rule — how the process died outranks the envelope outranks the exit code** — `p1-6-pi-team-protocol-step.md:78-83`
```
  **Precedence rule (P1.6-R5-1, amended P1.6-R6-2) — the table rows are NOT independent; evaluate in this order:**
  1. **Signal termination → classified by signal origin, never by the envelope.** Harness-initiated: RSS watchdog → `overflow`; `userCancel`/`requestedShutdown` → `logic`. Unknown/external origin (kernel OOM, other processes) → `transient`, the catch-all row's safe retryable default. This is evaluated **first, before the envelope check**, because a kill is itself positive evidence about how the run ended: when the harness killed the lead it *knows why*, and the absent envelope is a consequence of that kill rather than independent evidence. Deferring to the envelope check would collapse every watchdog kill, user cancel, and external signal into `lead_failure` and discard the one authoritative signal the harness has.
  2. **Merged-JSON envelope missing on a process that exited normally → `lead_failure`.** Applies to every non-signalled run and wins over every exit-code row in that case, *including exit code 0*. A lead that exits 0 on its own without emitting the envelope is a `lead_failure`, never a `success`: the protocol surface the harness was told to capture never materialized, so there is no output to call successful. Row `0 | "success"` applies only when the envelope IS present.
  3. **Exit-code row lookup** ({0,1,2,3} then the catch-all row).

  In one line: **how the process died outranks whether it emitted an envelope, which outranks its exit code.** `lead_failure` is reserved for a lead that exited *under its own control* without producing the protocol surface — a killed lead is classified by the kill.
```

> **Careful surgery.** Steps 1 and 2 are runtime-agnostic and survive — they are about *how a
> subprocess died*, which the in-sandbox subprocess tree reproduces exactly. Step 3's `{0,1,2,3}`
> lookup is the dead Warren exit-code assumption (audit §2, F3). Carry steps 1–2 and the one-line
> summary; re-derive step 3 against whatever the sandbox runner actually returns.

**INV-1 — the pinned workspace root (ONE canonical root)** — `p1-6-pi-team-protocol-step.md:110-111`
```
- INV-1: `warren run` scoped to the session's repository via the `repo` field in the SwarmClaw `.canopy/agent.json` agent-config store (CC-14); no cross-repo file access. The harness adapter reads `repo` from the agent-config store and materializes the run workspace accordingly.
  **Canonical root (P1.6-R6-1) — there is exactly ONE.** The directory the harness materializes from `repo` is the **pinned workspace root**, and it is the single canonical root for *both* path validation and every subsequent harness read. "Repo root" and "workspace root" elsewhere in this story are the same directory and are not two distinct roots: the workspace IS the session repository, pinned to a resolved absolute path once at step start and never re-resolved from a string thereafter. Validating `changedFiles` and `artifacts[].path` against one root while reading through another is explicitly forbidden — that split is precisely the traversal hole INV-2's beneath-root walk exists to close, so the walk MUST be rooted at the same pinned handle the validation used.
```

> First sentence dies with CC-14 (`.canopy/agent.json`). The **Canonical root** paragraph survives
> verbatim and is load-bearing for INV-2 below.

**INV-2 — two-stage decode-then-check + beneath-root walk (the audit's "AC5")** — `p1-6-pi-team-protocol-step.md:112-113`
```
- INV-2: changedFiles paths validated against path traversal using decode-then-check in two stages: (1) **Pre-decode:** inspect the raw path for any percent-encoded `..` sequences (e.g. `%2e%2e`, `%2E%2E`) and evidence of double-encoding (e.g. `%252e` or any percent-encoded percent signs) — reject immediately if found. (2) **Post-decode:** URL-decode the path, normalize Unicode (NFC), then reject paths containing literal `..` segments, absolute paths, symlinks, and Unicode-normalized traversal sequences. The pre-decode check catches double-encoded traversals before they survive the first decode; the post-decode literal check catches anything that decoded to `..`. Symlink detection uses two complementary mechanisms: (1) **Path validation** (lstat-based) inspects paths reported by Warren's structured JSON output before the harness processes them. This is best-effort — it detects pre-existing symlinks at validation time but cannot prevent symlink creation between validation and use. (2) **File-read operations** performed by the harness itself (e.g., capturing partial output, reading artifacts) MUST resolve the path **beneath a pinned workspace root**, not merely refuse a final-component symlink. `O_NOFOLLOW` alone is NOT sufficient and MUST NOT be described as eliminating traversal: it only causes the OS to refuse the **last** path component when that component is a symlink. Every *parent* directory in the path is still resolved normally, so an attacker who controls any intermediate directory can replace it with a symlink and redirect the open to a file outside the workspace — `O_NOFOLLOW` does not see that. The required protection is a **beneath-root walk**: open the pinned workspace root once (`fs.opendir` / `O_DIRECTORY`), then walk the path one component at a time with `openat`-style relative opens, each carrying `O_NOFOLLOW`, so **no** component — parent or leaf — can be a symlink out of the root; equivalently, resolve the real path (`fs.realpath`) and re-assert it is a prefix-match under the pinned root **using the resolved handle for the subsequent read**, never re-opening by string (re-opening by path reintroduces the TOCTOU the walk exists to close).
  **Fail closed where the walk is unavailable.** Node exposes no portable `openat`; where a beneath-root walk cannot be performed on the running platform, the harness MUST refuse the read and classify the step `exitStatus: "logic"` with the path reported — it MUST NOT silently degrade to bare `O_NOFOLLOW`, and it MUST NOT degrade to lstat + open, which is a check-then-use pair with a real TOCTOU window and is not presented here as closing one. The lstat-based path-validation TOCTOU remains an accepted limitation for the *validation* pass only (pass (1) above, which inspects paths Warren reports rather than gating the harness's own reads), since the harness does not control Warren's internal file operations — Warren runs inside its own sandbox (burrow) and is responsible for its own path safety.
```

> **Do not shorten this to "`O_NOFOLLOW` path-traversal defense"** the way audit §3 does. The
> clause's entire point is that `O_NOFOLLOW` alone is **insufficient** and must not be described as
> eliminating traversal. Audit §3's own shorthand inverts the finding. Paste the full text.
> Substitute "the run's structured output" for "Warren's structured JSON output" and "the sandbox"
> for "burrow"; everything else is runtime-agnostic.

**Its enforcing test** — `p1-6-pi-team-protocol-step.md:129`
```
- [ ] **Test (parent-symlink traversal, INV-2):** Place a symlink at an *intermediate* directory of an artifact path pointing outside the workspace root → verify the harness read is REJECTED. Assert the rejection comes from the beneath-root walk, not from `O_NOFOLLOW` (a bare-`O_NOFOLLOW` implementation passes this path and MUST fail the test). Assert also that the root the walk is anchored to is the *same* pinned workspace root the `changedFiles` validation used (P1.6-R6-1) — an implementation that validates against one root and reads under another MUST fail this test.
```

**INV-3 — RSS watchdog (the one clause whose label the audit got right)** — `p1-6-pi-team-protocol-step.md:114`
```
- INV-3: Warren process runs with resource limits enforced by the harness-level RSS watchdog (checking memory every 200ms and sending SIGTERM if RSS > 4GB). After sending SIGTERM, the watchdog waits 5 seconds. If the Warren subprocess has not exited, SIGKILL is sent. The exit code maps to `exitStatus: 'overflow'` with `partialOutput` capturing any output received before termination, consistent with the Warren Exit Code Mapping table's treatment of resource-limit violations. **This holds even though the merged-JSON envelope is absent** — a watchdog-killed lead almost never emits one, and precedence step 1 (P1.6-R6-2) evaluates the harness's own kill metadata ahead of the missing-envelope rule, so a watchdog kill is `overflow`, never `lead_failure`. The 200ms interval limits the window in which a fast-allocating process can exceed the cap undetected; it balances enforcement responsiveness against the overhead of reading `/proc/[pid]/statm` (Linux) or `ps` (macOS) at high frequency. Note: `child_process.execFile` does not support a `resourceLimits` option — that option is specific to `worker_threads`. If a future refactor switches to `worker_threads` or a runtime that supports per-process resource limits, `resourceLimits` can be applied then. CPU limiting is advisory (monitoring only) in Phase 1 — the harness logs CPU usage but does not kill for CPU overuse. Full cgroup-based enforcement is a Phase 2 concern when running in container environments.
```

> ### ⚠ MANDATED RE-AIM NOTE (audit §2 P1.6 row 4; §3; design §5.2)
>
> Under server-side Warren this watchdog measured **the wrong process** — it polled the local CLI
> client's RSS while the actual agent work ran server-side, so a runaway agent was invisible to it.
> The invariant survives **re-aimed at the genuine local subprocess tree inside the sandbox**,
> where the harness is the real parent of the real workers and the measurement is finally
> meaningful. Design §5.2 declares it "now correct".
>
> Concretely, the successor must state: the watchdog measures the **aggregate RSS of the
> in-sandbox subprocess tree** (the spawned lead plus its descendants), not a single client PID.
> Everything else — 200ms poll, 4GB threshold, SIGTERM then 5s grace then SIGKILL, mapping to
> `overflow`, `partialOutput` capture, precedence step 1 dominance over the missing-envelope rule,
> CPU advisory-only — carries verbatim. Note the source's own escape hatch: it already anticipates
> "a runtime that supports per-process resource limits", which is exactly what the sandbox offers;
> the successor may cite cgroup enforcement as the now-available mechanism rather than a Phase 2
> deferral.

**INV-4 — maxDurationMs ≤ upstream timeout minus routing margin (the audit's "INV-2")** — `p1-6-pi-team-protocol-step.md:115`
```
- INV-4 (P1.6-N4): `maxDurationMs + 5s routing margin ≤ P1.1 timeoutMs`. The dispatch_task `maxDurationMs` upper bound (600s) plus a 5s routing margin (for SwarmClaw→harness→Warren handoff and capture overhead) must remain within P1.1's `timeoutMs` upper bound (900s post-CC-7 fix). 600s + 5s = 605s < 900s — invariant holds with 295s headroom. Deviations to either bound MUST preserve this invariant; if P1.1's `timeoutMs` is lowered below 605s in a future amendment, P1.6's `maxDurationMs` upper bound must be lowered correspondingly.
```

**Observability Contract CC-9 (the audit's "AC6")** — `p1-6-pi-team-protocol-step.md:93-98`
```
## Observability Contract (CC-9)

- Every dispatch_step logs: `{ requestId, phase, agentId, timestamp, duration, exitStatus }`
- requestId propagates from P1.1 A2A layer
- Errors include: `{ code, message, stack?: string }`
- Sub-timing breakdown: `mulch_prime_ms`, `warren_burrow_ms`, `pi_execution_ms`, `pi_lens_gating_ms`. Note: `warren_burrow_ms` measures Warren's sandbox setup overhead (if any). `pi_execution_ms` measures the agent's execution time inside Warren. These are separate phases within `durationMs`. If Warren does not expose this breakdown, both fields report 0 and `durationMs` remains the authoritative metric. When Mulch priming fails and Warren is not invoked, `warren_burrow_ms`, `pi_execution_ms`, and `pi_lens_gating_ms` are reported as 0. `mulch_prime_ms` records elapsed time until failure.
```

> Sub-timing **names** are Warren-shaped (`warren_burrow_ms`) and should be renamed to the v5
> equivalents (box setup / agent execution / gate validation). The **discipline** — a per-phase
> sub-timing breakdown that sums within `durationMs`, with `durationMs` authoritative when the
> breakdown is unavailable, and zeros when a phase did not run — survives verbatim.
> "Prompts persisted pre-execution" is **not** in this story (see §11).

**durationMs stopwatch semantics** — `p1-6-pi-team-protocol-step.md:89`
```
- **durationMs stopwatch semantics:** `durationMs` measures wall-clock time from `warren run` process spawn to process exit. It excludes Mulch priming time (captured separately as `mulch_prime_ms`).
```

**Summary/partialOutput truncation ceilings** (from Guards/limits) — `p1-6-pi-team-protocol-step.md:65`
```
summary must be <= 2000 characters **including any truncation suffix** — the 2,000 is the schema's hard ceiling on the final stored string, not a budget the suffix is added on top of. When the raw summary exceeds it, the adapter truncates the prose to `2000 - len("[truncated, N chars total]")` and appends the suffix, so `summary.length <= 2000` always holds (reserve the suffix length before cutting; the suffix width varies with N). `partialOutput` follows the same rule at its own ceiling: truncated to 10000 characters total, suffix `[truncated, N bytes total]` included in that 10000.
```

**testsExecuted disambiguation** — `p1-6-pi-team-protocol-step.md:62`
```
**`testsExecuted` (P1.6-R2-5):** optional boolean, declared here so the Guards/limits rule below has a field to attach to — the guard required it but no schema declared it. Semantics: it MUST be present and `false` whenever `testResults.passed + testResults.failed === 0` (disambiguating 'no tests ran' from 'zero tests exist'); it MAY be omitted, or present as `true`, when the sum is > 0. Consumers MUST treat an absent `testsExecuted` as `true` only when the sum is > 0, and MUST reject output where the sum is 0 and the field is absent or `true`.
```

> Not audit-named, but this is exactly the "did the gates actually run?" signal that F10's
> host-side re-verify depends on. Strongly recommend carrying it.

**Hindsight-unreachable priming degradation** — `p1-6-pi-team-protocol-step.md:87`
```
- **Hindsight unreachable during priming:** If Hindsight is unreachable during Mulch priming, the harness logs a warning, sets `mulchPrimed: false`, and proceeds. The step does not fail due to priming unavailability. `mulch_prime_ms` records the elapsed time until failure. The `mulchPrimeError` field contains the error message. Successful priming sets `mulchPrimeError` to undefined/null. `mulchPrimeError` is present in the output schema only when priming failed (optional field).
```

> Named in design §5.2's surviving contract via `mulchPrimed`/`mulchPrimeError`, and it is the
> clause that keeps OQ-4 (Hindsight has never booted) from being a hard blocker on the execution
> spine. Carry verbatim.

---

## 4. P1.8 — Drive protocol run + capture correlated to GitHub issue

**Source:** `p1-8-protocol-run-github.md` (100 lines, 4 ACs, INV-RUN-1, INV-RUN-1b, INV-RUN-2, INV-RUN-3)

**Dies (audit §2/§3):** AC1/AC2's SwarmClaw-engine template walk + envelope capture — subsumed by
the adopted SSSF trace schema and trace store (D6). Audit §2 is explicit: the derivation should
**reconcile with the SSSF trace store, not duplicate it**.

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC3 every step output persisted + linked to the GitHub issue | Real AC3 (L41) persists the **final** output; per-step persistence is AC2 (L40) + `PhaseRecord.output` L54 | **Drift (scope narrower than named)** |
| AC4 unbroken requestId chain across all steps | AC1 L34 + `x-request-id` direction note L36–39 + DoD Integration L92. Real AC4 (L42) is the unreachable-service `runId: null` path | **Drift** |

### Verbatim — carry these

**Issue-correlated state events (real AC1) — the requestId chain the audit means** — `p1-8-protocol-run-github.md:34`
```
1. **(make-or-break)** Given a GitHub issue exists and the dev manager initiates a protocol run with its issue number, When SwarmClaw processes the run, Then each phase transition (dispatch_task → parallel → compare → decide → summarize — canonical 5-phase list) emits a state event containing `runId`, `repoSlug`, `issueId`, `requestId`, `phase`, `status`, and `timestamp` (CC-9 requestId propagation; `repoSlug` per P1.8-R2-8 — issue numbers are repo-scoped).
```

> The named 5-phase list is P1.4-template-specific and dies with the template. The **state-event
> field set** — `runId, repoSlug, issueId, requestId, phase, status, timestamp` — is the surviving
> contract and is exactly the join key the SSSF trace store needs.

**Resolved-requestId rule (the "unbroken chain" mechanic)** — `p1-8-protocol-run-github.md:36-39`
```
   > **`x-request-id` direction (CC-9).** The header is used on BOTH legs and the two must not be conflated:
   > - **Inbound (request header, client → SwarmClaw):** the dev-manager client SHOULD send `x-request-id` on the run-initiation POST to `/api/a2a`. SwarmClaw honours that value **only if it is a strict UUID v4**; otherwise (absent, malformed, or non-v4) SwarmClaw generates a fresh one (`src/swarmclaw/index.ts:42-46`). A client must therefore read the requestId back from the response rather than assume the value it sent was kept.
   > - **Outbound (response header, SwarmClaw → client):** SwarmClaw echoes the resolved value in the `x-request-id` response header on every response, including errors (`src/swarmclaw/index.ts:53`).
   > - **State events:** the `requestId` on every state event is the **resolved** value — i.e. what SwarmClaw returned in the response header, not necessarily what the client sent.
```

> The **resolved-value** rule is the durable insight and survives any transport swap: whatever the
> dispatcher settles on as the correlation id is what every downstream event must carry, and the
> caller must read it back rather than assume its own value stuck.

**Per-step output persistence + repo-scoped query (real AC2)** — `p1-8-protocol-run-github.md:40`
```
2. Given a protocol run is in progress, When the dev manager queries run state by `(repoSlug, issueId)`, Then the response includes current phase, assigned agents, phase outputs so far, and elapsed time — all correlated to that issue in that repository, and runs for the same issue number in a DIFFERENT repository are excluded from the result.
```

**Final output persistence + retrieval (real AC3)** — `p1-8-protocol-run-github.md:41`
```
3. Given a protocol run completes the summarize phase, When the run finishes, Then the final output is persisted with the `(repoSlug, issueId)` correlation and is retrievable by that pair. Retrieval by issue number alone is NOT supported — it is ambiguous across repositories (P1.8-R2-8).
```

**Issue identity is `(repoSlug, issueId)`, never `issueId` alone** — `p1-8-protocol-run-github.md:53`
```
  - **Issue identity is `(repoSlug, issueId)`, never `issueId` alone (P1.8-R2-8).** GitHub issue numbers are unique only *within* a repository — `#42` exists in every repo the factory touches. An earlier draft keyed runs, queries, telemetry, and the uniqueness constraint on `issueId` alone, which lets a run for `#42` in one repository collide with, or be returned alongside, a run for `#42` in another. `repoSlug` (the `owner/name` slug, the same value P1.3 threads through `resolveBankId(repoSlug)`) is therefore a required field on `ProtocolRun`, a required member of every state event payload, a required query parameter on the by-issue route, and part of the uniqueness constraint (INV-RUN-1) and every telemetry record. Run initiation MUST reject a request that omits `repoSlug` with 422 rather than defaulting it — a silently-defaulted repository is exactly the cross-repo mix-up this rule exists to prevent. `runId` remains globally unique on its own, so `GET /api/runs/{runId}` needs no repo scoping.
```

> Not audit-named, and it should be. This is a correctness rule about identity, not about
> SwarmClaw, and a multi-repo fleet (D3 fan-out across N boxes) makes the collision it prevents
> *more* likely, not less. Carry verbatim.

**Append-only phase records** — `p1-8-protocol-run-github.md:80`
```
- INV-RUN-2: Run state events are append-only — no mutation of historical phase records after they are persisted.
```

**Telemetry scoping** — `p1-8-protocol-run-github.md:81`
```
- INV-RUN-3: Run telemetry is scoped to the originating issue — cross-issue data leakage is prohibited.
```

**ExitStatus import discipline** — `p1-8-protocol-run-github.md:91`
```
- [ ] **Impl (N-P1.1/P1.8-NEW-1, P1.8-R2-10):** Import `ExitStatus` from `cli-anything/src/types.ts:79` — the single source of truth. Do NOT re-declare the 5-value union anywhere in this story's modules; a lint/review check that greps the P1.8 files for a literal `'success' | 'transient' | ...` spelling MUST come back empty.
```

**exitCode `number | null` requiredness rule** — `p1-8-protocol-run-github.md:58` (excerpt)
```
    - **`exitCode` is `number | null`, not `number` (P1.8-R5-1).** ... Requiredness, aligned across statuses: `exitCode` is **absent** when `exitStatus` is `success`; it is **present** (possibly `null`) for every failure status, `lead_failure` included — on `lead_failure` it carries the lead process exit code, which is itself `null` when the lead was signalled. Consumers MUST distinguish absent (`undefined` — no process outcome) from `null` (process terminated by signal, no exit code exists); neither may be read as `0`.
```

### Notes for writers

- **Reconcile, don't duplicate (audit §2).** Before authoring, diff this story's `ProtocolRun` /
  `PhaseRecord` / `PhaseOutput` schemas against the adopted SSSF trace schema. Where SSSF already
  carries a field, cite SSSF; carry forward only what SSSF lacks — principally the
  `(repoSlug, issueId)` issue correlation, which is a GitHub-integration concern SSSF has no
  reason to model.
- **Idempotency (INV-RUN-1b, L79) is not audit-named but is worth a hard look.** It states that
  initiation is idempotent on `(repoSlug, requestId)` via an *unfiltered* unique index plus a
  transactional upsert, deliberately outliving run completion. Under D8 an initiation now mints a
  spend-capped credential, so a double-create costs real money — the argument for this invariant is
  stronger in v5 than it was here. Recommend carrying it and saying why.

---

## 5. P1.10 — approve/resume

**Source:** `p1-10-approve-resume-webhook.md` (69 lines, 5 ACs, INV-POLICY-1..5)

**Dies (audit §2/§3):** the in-run pre-push pause **location** (v5 pushes host-side after bundle
harvest + out-of-box re-verify, D8/F10, so the approval gate moves to tier-1 pre-PR), and the
assumption that the run process itself brokers the pause (mid-run steering becomes tier-2 resident
agent + tier-1 `attach`, D4, step 3). The Telegram channel half remains OQ-3 BLOCKED-on-creds.

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC1 approval-required run pauses before the irreversible action | AC1 L29 | **Resolves** (substance; "irreversible action" is the audit's re-framing of "decide phase") |
| AC3 pause state persisted, survives restart, resumable | **Nowhere in P1.10.** Real AC3 (L31) is reject→halt | **NET-NEW** |
| AC4 approvers authenticated (allowlist), approve/reject idempotent | Auth: AC5 L33 + INV-POLICY-1 L52 + INV-POLICY-5 L56. Idempotency: Guards L40 + DoD L66. Real AC4 (L32) is the 24h timeout | **Drift** ("allowlist" wording is the audit's; source says "the run's assigned agent list") |
| INV-1 timeout → auto-abort, never auto-approve | Timeout: **AC4** L32. Never-auto-resume: **INV-POLICY-2** L53. P1.10 has no INV-1 | **Drift** |

### Verbatim — carry these

**Pause before the gated action (AC1)** — `p1-10-approve-resume-webhook.md:29`
```
1. **(make-or-break)** Given a gated issue reaches the `decide` phase during a protocol run, When SwarmClaw evaluates the executionPolicy, Then the run is paused at decide, a webhook notification is sent to the registered callback URL with `runId`, `issueId`, `phase: 'decide'`, and `proposal` payload, and no further phases execute until a decision is received.
```

> Re-aim: `the decide phase` → the v5 irreversible action (PR open, after host-side re-verify).
> `a webhook notification is sent to the registered callback URL` → the tier-1 operator
> notification. The surviving core is the last clause: **no further phases execute until a decision
> is received.**

**Approve resumes, with attribution (AC2)** — `p1-10-approve-resume-webhook.md:30`
```
2. Given a paused run at decide, When the agent sends `approve` via A2A JSON-RPC 2.0 (`method: 'executionPolicy.approve'`, `params: { runId, decision: 'approve', reason: string }`), Then SwarmClaw resumes the run from decide → summarize and logs the approval with `agentId`, `timestamp`, and `reason`.
```

**Reject halts (AC3)** — `p1-10-approve-resume-webhook.md:31`
```
3. Given a paused run at decide, When the agent sends `reject` via A2A JSON-RPC 2.0, Then SwarmClaw halts the run with `status: 'rejected'`, logs the rejection, and no further phases execute.
```

**Timeout auto-halts — never auto-approves (AC4)** — `p1-10-approve-resume-webhook.md:32`
```
4. Given a run is paused at decide, When no decision is received within the policy timeout (default 24h), Then the run auto-halts with `status: 'timed-out'` and a timeout event is logged.
```

> This is the audit's "INV-1 timeout → auto-**abort**, never auto-approve". The source achieves it
> by construction: the only terminal states on timeout are `timed-out`, never `approved`. Note the
> **24h default is now expensive** — under D8 a paused run may hold a live provisioned credential
> and a running box for a day. The successor should either shorten the default or state that the
> box is torn down and the key revoked at pause, with resume re-provisioning. Flag for the
> credential-lifecycle story (step 2).

**Authorization + no-bypass invariants** — `p1-10-approve-resume-webhook.md:52-55`
```
- INV-POLICY-1: Only authorized agents (validated by agentId against the run's assigned agent list) may submit approve/reject decisions.
- INV-POLICY-2: A run paused at decide cannot be resumed by any mechanism other than a valid approve decision — no bypass, no auto-resume.
- INV-POLICY-3: All gate decisions (approve, reject, timeout) are logged to audit trail with `agentId`, `timestamp`, `reason`, `runId`, and `issueId`.
- INV-POLICY-4: Decision requests with invalid `runId` or unauthorized `agentId` are rejected with no state change and the attempt is logged as a security event.
```

> **INV-POLICY-2 is the strongest surviving clause in this story** and the audit did not name it.
> "No bypass, no auto-resume" is precisely the property that must hold when the gate moves to
> tier-1 pre-PR: the whole point of D8 is that the human is the only thing between a green bundle
> and a public PR. Carry verbatim.
> **INV-POLICY-3** is the audit-chain feed — P1.16's chain gains a "who approved this PR" link.

**Decision idempotency** — `p1-10-approve-resume-webhook.md:40` (excerpt)
```
Decision idempotency: duplicate approve/reject for the same `runId` returns the first decision without state change.
```

### Notes for writers

- **"Pause state persisted, survives restart, resumable" is NET-NEW.** The source never says the
  pause survives a process restart — and under the dead model it arguably could not, since the run
  process brokered the pause. In v5 it becomes both *possible* and *necessary* (the pause now spans
  a box teardown), so it is a good requirement. Author it as new, with its own review.

---

## 6. P1.13 — Cost ledger within budget

**Source:** `p1-13-cost-ledger-budget.md` (71 lines, 5 ACs, INV-COST-1..4)

**Dies:** nothing is refuted. Audit §2: *"Enforcement point assumed team-spawn-time only. v5 layers
it: per-run spend-capped provisioned key at mint (D8), tier-1 dispatch refusal, quota accounting +
reaper (F9). Nearly all clauses survive; scope grows into the credential lifecycle."*
**Re-derived for scope, not falsity.**

### Crosswalk — the worst drift of the ten; read carefully

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC1 exactly-one idempotent runId-keyed ledger record | AC1 L29 lists the fields and requires all populated. **No idempotency or exactly-once language anywhere.** Key is `heartbeatRunId` (INV-COST-4 L58), not `runId` | **Drift + NET-NEW (idempotency)** |
| AC2 tokens in/out + cacheRead/cacheWrite + USD as integer micro-dollars + per-role split | Schema L37: `costCents: integer`, `inputTokens`, `outputTokens`. **No cacheRead/cacheWrite. No micro-dollars — cents. No per-role split.** Real AC2 (L30) is the SUM query | **Drift + 3 NET-NEW + unit contradiction** |
| AC3 `qds cost <issue>` cumulative view | No CLI in the story. Cumulative view is AC2's SUM. Real AC3 (L31) is the over-cap halt | **NET-NEW (CLI)** |
| AC4 budget cap from config → dispatch refused with explicit error | **AC3** L31 (halt with `status:'over-budget'`, `reason:'spend-cap-exceeded'`). Real AC4 (L32) is under-cap proceeds | **Drift** |
| AC5 cap check precedes spawn | **INV-COST-3** L57 ("before every protocol step"). Real AC5 (L33) is immutability | **Drift** |
| INV-1 append-only | **INV-COST-1** L55 | **Resolves** |
| INV-2 malformed cost events → `unpriced` flag, never dropped | **Nowhere in P1.13 or any phase-1 story** | **NET-NEW** |

> ### ⚠ UNIT CONTRADICTION — do not paste the audit's phrasing
>
> Audit §3 says "USD as integer **micro-dollars**". The source is **integer cents** throughout:
> `costCents: integer`, `defaultCapCents: 500`, "Budget cap default: 500 cents ($5.00)".
> A successor that adopts micro-dollars while inheriting the source's `500` default silently
> converts a $5.00 cap into $0.0005. **Pick one unit deliberately and restate every threshold in
> it.** My recommendation: micro-dollars is the better unit for v5 (per-token API pricing at
> Anthropic rates rounds badly in cents, and F8's unit-economics model works at sub-cent
> granularity) — but that is a *decision to make*, not a clause to inherit, and every numeric
> default in this story must be rewritten if it is taken.

### Verbatim — carry these

**Ledger record, all fields populated (AC1)** — `p1-13-cost-ledger-budget.md:29`
```
1. **(make-or-break)** Given a Pi agent step completes during a protocol run, When the CLI-Anything harness writes the cost event, Then a `cost_events` row is persisted with `agentId`, `issueId`, `model`, `provider`, `costCents`, `inputTokens`, `outputTokens`, `heartbeatRunId`, and `createdAt` — all fields populated, no nulls.
```

**Derived-on-demand cumulative query (AC2)** — `p1-13-cost-ledger-budget.md:30`
```
2. Given multiple `cost_events` rows exist for an issue, When per-issue spend is queried, Then the result is `SUM(cost_events.costCents) WHERE issueId = :id` and matches the sum of individual step costs exactly. No `issue.cost` column is used.
```

**Over-cap gate refuses (AC3 — the audit's "AC4")** — `p1-13-cost-ledger-budget.md:31`
```
3. Given cumulative per-issue spend exceeds the configured budget cap (default: 500 cents), When the over-cap gate evaluates before the next protocol step, Then the run halts with `status: 'over-budget'`, `reason: 'spend-cap-exceeded'`, and no further steps execute.
```

**Under-cap proceeds, remaining budget logged (AC4)** — `p1-13-cost-ledger-budget.md:32`
```
4. Given cumulative per-issue spend is below the budget cap, When the over-cap gate evaluates, Then the step proceeds and the remaining budget is logged.
```

**Immutability (AC5)** — `p1-13-cost-ledger-budget.md:33`
```
5. Given a `cost_events` row has been written, When any attempt is made to mutate or delete it, Then the operation is rejected — cost events are append-only and immutable.
```

**Schema + cap config** — `p1-13-cost-ledger-budget.md:37`
```
- **Contracts/Schema:** `cost_events { id: UUID, agentId: string, issueId: number, model: string, provider: string, costCents: integer, inputTokens: integer, outputTokens: integer, heartbeatRunId: string, createdAt: ISO8601 }`. Per-issue cost query: `SELECT SUM(costCents) FROM cost_events WHERE issueId = :id`. No `issue.cost` column (NFR-ACC-3). Budget cap config: `{ defaultCapCents: 500, perIssueOverrides?: Record<number, number> }`.
```

**All four invariants** — `p1-13-cost-ledger-budget.md:55-58`
```
- INV-COST-1: `cost_events` rows are append-only and immutable — no UPDATE, no DELETE, no mutation after write.
- INV-COST-2: Per-issue cost is derived via `SUM(cost_events.costCents) WHERE issueId = :id` — no denormalized `issue.cost` column exists (NFR-ACC-3).
- INV-COST-3: Over-cap gate check is atomic and runs before every protocol step — no step can execute if cumulative spend exceeds the cap.
- INV-COST-4: All cost events include `heartbeatRunId` for traceability — every cost is linked to a specific run execution.
```

**Integer discipline + atomic gate** — `p1-13-cost-ledger-budget.md:40`
```
- **Guards/limits:** `costCents` is integer (no floating-point). Append-only: no UPDATE or DELETE on `cost_events`. Gate check is atomic — spend is computed and compared in a single read. Budget cap default: 500 cents ($5.00). Per-issue overrides supported.
```

> **Derivation note (DF2.8 obligation — CodeRabbit R2 finding):** the "single read" SUM comparison
> above is a TOCTOU under concurrent workers — two admissions can each read sub-cap and both commit,
> overshooting. DF2.8 must upgrade INV-COST-3's gate to serialized admission (a transaction, an atomic
> lease/reservation, or `BEGIN IMMEDIATE` over the append + cap check) so no protocol step starts when
> the cap would be exceeded, with an explicit concurrent-admission test.

### ⚠ MANDATED EXTENSION-SCOPE NOTE (audit §2 P1.13 row; §4 step 2)

The audit is explicit that this story **grows** rather than changes. The successor must layer three
new enforcement points on top of the surviving ledger, and the surviving clauses must be restated
to cover them:

1. **Mint-time cap (D8).** The per-run spend-capped provisioned key. INV-COST-3's "before every
   protocol step" becomes the *second* line of defense; the *first* is that the key itself cannot
   overspend. State both — a provider-side cap is not a substitute for the ledger, because the
   ledger is what the audit chain reads.
2. **Tier-1 dispatch refusal.** AC3's halt semantics re-aimed: refusal happens before a box is
   provisioned and a key minted, not between protocol steps.
3. **F9 quota accounting + reaper.** New cost-event sources (box-hours, not just tokens) and a
   reaper that revokes keys / tears down boxes on cap breach. `INV-COST-4`'s `heartbeatRunId`
   traceability should extend to key-lifecycle events so P1.16's chain can join them.

Also carry forward, per audit §6 hole 6: **spend containment has never fired live.** The only cap
evidence in the whole program is P0.4's structural check. Step 2's credential tests should include
a **live cap-hit kill**, or D8's enterprise pitch rests on an assertion nothing has demonstrated.
That belongs in this story's successor DoD as a MANDATORY live test.

---

## 7. P1.15 — Real PR produced

**Source:** `p1-15-real-pr-produced.md` (79 lines, 5 ACs, INV-1..INV-4)

**Dies (audit §2/§3):** the warren-git-integration conditional, and **PR-before-re-verify
ordering**. Audit §2 also notes this story *predates F10*. This is §8 step 5 by name: "The
factory's P1.15 moment."

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC2 success + green gates → branch pushed, PR opened | AC2 L34 covers branch + PR open. **"green gates" precondition appears nowhere** | **Drift + NET-NEW (the gate precondition)** |
| AC3 PR body carries runId + issue refs + cost summary | runId-in-body is **AC2** L34. **Issue refs and cost summary appear nowhere.** Real AC3 (L35) is webhook correlation | **Drift + 2 NET-NEW** |
| AC4 reviewer-visible artifacts attached | **Nowhere.** Real AC4 (L36) is advance-to-summarize | **NET-NEW** |
| AC5 red gates → no PR, failure recorded on issue | Real AC5 (L37) records failure in **protocol state** and forbids hanging/infinite retry. "No PR" and "on issue" appear nowhere | **Drift + NET-NEW** |
| INV-1 push credential stays host-side | Real INV-1 (L57) is webhook HMAC. Credential handling is **INV-4** (L60), and it says env vars — **not** host-side-vs-box | **Drift + NET-NEW** |

> **The credential clause the audit claims survives does not exist in this story — and the story's
> actual model is the opposite of D8.** In P1.15 as written, *Warren* opens the PR from inside the
> burrow (Overview L17, AC2 L34, DoD L66), which means the push credential is **in the box**. D8's
> doctrine — "no push credential in any box" — is a **reversal** of this story, not a continuation
> of it. Writers must not present it as an inherited invariant.

### Verbatim — carry these

**PR branch naming + runId in body (AC2)** — `p1-15-real-pr-produced.md:34`
```
2. Given the protocol is running, When Warren completes the Pi agent run, Then Warren opens a PR via GitHub API with correct branch naming (e.g., `qds/{runId}`), title, and body referencing the runId.
```

> Surviving core: **branch name encodes the runId (`qds/{runId}`), and the PR body references the
> runId.** That is the correlation key P1.16 hop 1 walks. The actor (`Warren ... via GitHub API`)
> dies and becomes the host-side push.

**Webhook correlation to the active run (AC3)** — `p1-15-real-pr-produced.md:35`
```
3. Given Warren has opened the PR, When the GitHub webhook fires, Then SwarmClaw's `/api/webhooks/[id]` endpoint receives the `pull_request.opened` event and correlates it to the active protocol run via the branch name or metadata.
```

**Terminal state on correlation (AC4)** — `p1-15-real-pr-produced.md:36`
```
4. Given SwarmClaw receives the webhook, When correlation succeeds, Then the protocol advances to the summarize phase and the run reaches a terminal state.
```

**Failure recorded, no hang, no infinite retry (AC5)** — `p1-15-real-pr-produced.md:37`
```
5. Given any step in the chain fails (e.g., `warren run` exits non-zero), When the error propagates, Then SwarmClaw records the failure in the protocol state and does not hang or retry indefinitely.
```

**Credential handling (real INV-4)** — `p1-15-real-pr-produced.md:60`
```
- INV-4: GitHub tokens are stored in environment variables, never logged or written to outcome records.
```

> Survives as the **never-logged, never-written-to-outcome-records** half. The "environment
> variables" storage mechanism is superseded by D8's credential lifecycle.

**Registered-repos-only (INV-2)** — `p1-15-real-pr-produced.md:58`
```
- INV-2: SwarmClaw only acts on repos explicitly registered in its configuration — no open-redirect to arbitrary repositories.
```

**Webhook signature validation (INV-1)** — `p1-15-real-pr-produced.md:57`
```
- INV-1: Webhook endpoint validates GitHub webhook signature (HMAC-SHA256) before processing — rejects unauthenticated payloads.
```

**Fail-closed correlation + timeout guard** — `p1-15-real-pr-produced.md:44`
```
- **Guards/limits:** Protocol must have a timeout (default 30 min) to prevent hanging. Warren run must capture stdout/stderr for diagnostics. Webhook correlation must fail closed (reject uncorrelated webhooks, log warning). Sample repo must be a disposable test repository.
```

### ⚠ MANDATED F10 RE-VERIFY-BEFORE-PR ORDERING NOTE (audit §2 P1.15 row; §4 step 5; design D8/F10)

The successor's ordering is **not** the source's ordering. State it explicitly and early, because
it is the single most important structural change in step 5:

```
in-sandbox run completes
  → bundle harvest (artifacts + diff pulled out of the box)
  → bundle verification
  → host-side re-verify: tests AND gates re-run OUTSIDE the box
  → [approval gate — P1.10's successor, tier-1 pre-PR]
  → host-side push (credential never entered any box)
  → PR opened
```

Consequences the writer must encode:

- **Gate results from inside the box are evidence, not authority.** The PR-opening decision is made
  on the host-side re-verify result. This is what audit §3 means by "green gates" in AC2 and "red
  gates → no PR" in AC5 — neither phrase is in the source, both are F10 requirements, and both
  should be authored fresh.
- **No push credential in any box (D8).** The source has Warren pushing from the burrow; the
  successor must invert this. Say so as an explicit supersession note so nobody re-derives the
  burrow push from the old story.
- The webhook-correlation half (AC3/AC4) survives but weakens in importance: when the host opens
  the PR, the host already knows the runId, so correlation is no longer a discovery problem. Keep
  the fail-closed rule for inbound events; drop the "correlate an unknown PR back to a run" framing.

---

## 8. P1.16 — Audit-chain reconstructable

**Source:** `p1-16-audit-chain-pr.md` (72 lines, 4 ACs, INV-1..INV-3)

**Dies:** nothing is refuted. Audit §2: the chain as written stops at issue→run→cost→retain→PR;
**v5's chain adds links the story could not know** — key mint/cap/revoke/verify events, bundle
verification, out-of-box re-verify evidence, box lifecycle (D8, §6.4). *All existing clauses
survive; the chain extends.*

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC1 `qds audit <pr>` resolves runId and walks the chain | AC1 L29 — walker invoked with **PR URL or branch name**; no `qds audit` CLI anywhere | **Drift + NET-NEW (the CLI surface)** |
| AC2 chain includes cost record, outcome record, retain receipt | Cost is hop 3 (L36); memory is hop 8 (L36). "Outcome record" and "retain receipt" are not named as such. Real AC2 (L30) is the non-null/stable-ID rule | **Drift** |
| AC3 missing link → named failure | AC3 L31 | **Resolves** |
| AC4 chain verification in CI on merged factory PRs | **Nowhere.** Real AC4 (L32) is the <30s budget | **NET-NEW** |
| INV-1 immutable link references | Real INV-1 (L51) is repo-scoping. Nearest is the write-at-creation rule (Guards L39, DoD L63) | **Drift** |

### Verbatim — carry these

**Walker resolves all hops (AC1)** — `p1-16-audit-chain-pr.md:29`
```
1. **(make-or-break)** Given a PR produced by P1.15, When the audit chain walker is invoked with the PR URL or branch name, Then the walker returns a complete chain object with all 8 hops resolved: PR→protocol run→issue→cost→decisions→decomposition→Pi team→pi-lens→Hindsight memory.
```

**Every join non-null with a stable ID (AC2)** — `p1-16-audit-chain-pr.md:30`
```
2. Given the audit chain walker result, When each hop is inspected, Then every join resolves to a non-null record with a stable ID (no `null`, `undefined`, or "missing" entries).
```

**Named broken-hop diagnostic, never silent (AC3)** — `p1-16-audit-chain-pr.md:31`
```
3. Given a PR with a broken correlation key (e.g., missing runId in PR body), When the walker is invoked, Then the walker reports the specific broken hop with a diagnostic message rather than failing silently or returning partial results.
```

**Bounded walk (AC4)** — `p1-16-audit-chain-pr.md:32`
```
4. Given the audit chain walker is invoked, When the walk completes, Then total wall-clock time is under 30 seconds (NFR-OBS-4).
```

**The 8 hops, verbatim** — `p1-16-audit-chain-pr.md:36`
```
- **Contracts/Schema:** Audit chain hops (in order): (1) PR→protocol run via PR branch name pattern `qds/{runId}`, (2) run→issue via correlation key `issueId` in protocol state, (3) issue→cost via `SUM(cost_events) WHERE issueId`, (4) issue→decisions via `executionPolicy` stored in protocol state, (5) issue→decomposition via `parentId` tree in Seeds mirror, (6) run→Pi team via step output with agent names/models, (7) Pi team→pi-lens via TDI + stable IDs, (8) run→memory via Hindsight bank query `document_id=runId`.
```

**Write-at-creation rule (the nearest thing to "immutable link references")** — `p1-16-audit-chain-pr.md:39`, `:63`
```
- **Guards/limits:** Walker must timeout after 30s (NFR-OBS-4). Each hop must have a diagnostic message on failure. Correlation keys must be written at the point of creation, not retroactively.
```
```
- [ ] **Integration:** Correlation keys are written at creation time in protocol state (not retroactively).
```

**All three invariants** — `p1-16-audit-chain-pr.md:51-53`
```
- INV-1: Audit walker only queries banks and stores within the same repo scope — no cross-tenant data access.
- INV-2: Walker does not expose internal GitHub tokens or API credentials in diagnostic output.
- INV-3: Cost events in the audit chain show aggregated cents only — never raw token-level billing details that could leak pricing tiers.
```

> INV-2 gains force under D8: the walker now traverses **credential-lifecycle events**, so "does
> not expose tokens" must explicitly cover minted key material, not just the GitHub token. Say so.
> INV-3's "aggregated cents" must be restated if P1.13's successor adopts micro-dollars (§6).

### ⚠ MANDATED CHAIN-EXTENSION NOTE (audit §2 P1.16 row; design D8, §6.4)

The hop list grows from 8. New links the successor must add, per audit §2:

- **Key lifecycle:** mint → cap → revoke → verify events, joined on the run handle.
- **Bundle verification:** the harvested bundle's verification record.
- **Out-of-box re-verify evidence (F10):** the host-side test + gate results that authorized the PR
  — arguably the single most audit-relevant new link, since it is the evidence that the PR was
  earned rather than asserted from inside the box.
- **Box lifecycle:** provision → run → harvest → teardown → reap.

Two source clauses to restate against the longer chain: AC4's **30-second budget** (a longer chain
is slower — either defend the budget or revise it deliberately, do not let it rot) and AC2's
**every-hop-non-null** rule (a hop that is legitimately absent — e.g. no approval was required —
must be modelled as a typed "not applicable" outcome, not a null, or AC2 fails on healthy runs).

---

## 9. P1.17 — Phase-1 make-or-break gate

**Source:** `p1-17-phase1-exit-gate.md` (67 lines, **3 ACs**, INV-1..INV-3)

**Dies (audit §2/§3):** the §13 Phase-1 clause list itself (Warren-era pipeline shape). The gate
*pattern* survives on the P0.11 chassis; the clause set re-derives from §8 step 5.

> **Label warning.** Audit §3 cites AC1–AC4. **The story has 3 ACs.**

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC1 per-clause assertion with evidence | AC2 L30 (assertion ID, expected, actual, diagnostic) + DoD contract schema L58. Real AC1 (L29) is the aggregate PASS | **Drift** |
| AC2 versioned report JSON to sprint-artifacts | **Not in P1.17.** A P0.11 chassis property | **NET-NEW to this story** |
| AC3 VOID clauses recorded with reason | **Not in P1.17.** A P0.11 chassis property | **NET-NEW to this story** |
| AC4 red gate blocks the next phase | No such AC. Overview L17 ("determines Phase 2 readiness") + AC2's FAIL | **Drift (AC4 does not exist)** |
| gate exit convention 0/1/2 | **Not in P1.17.** Lives in the P0.11 chassis (`scripts/phase0-exit-gate.ts` + `src/gate/*`) | **NET-NEW to this story — must be sourced from the chassis** |

> The audit's own §3 row names the chassis: **"Chassis: P0.11's `src/gate/*`."** For the three
> items above, the verbatim text the writer needs is in the **P0.11 gate implementation**, not in
> P1.17. A writer who needs the exact exit-code convention, the VOID-recording semantics, and the
> report JSON shape should read `scripts/phase0-exit-gate.ts` and `src/gate/*` directly. I did not
> extract them — they are outside my assigned file list — but that is where they are, and audit §2
> confirms the chassis shipped with 45 tests and per-clause evidence + VOID recording.

### Verbatim — carry these

**Aggregate PASS (AC1)** — `p1-17-phase1-exit-gate.md:29`
```
1. **(make-or-break)** Given all P1.10, P1.13, P1.14, P1.15, P1.16 predecessors are complete, When the gate script runs, Then all 6 assertion groups pass and the gate returns PASS.
```

**Per-clause FAIL with evidence (AC2 — the audit's "AC1")** — `p1-17-phase1-exit-gate.md:30`
```
2. Given any predecessor assertion fails (e.g., audit chain has a broken hop), When the gate script runs, Then the gate returns FAIL with the specific assertion ID, expected result, actual result, and diagnostic message.
```

**Determinism (AC3)** — `p1-17-phase1-exit-gate.md:31`
```
3. Given the gate script is run multiple times, When the system state has not changed, Then the gate produces identical results (deterministic, no flakiness).
```

> Not audit-named and it should be. A non-deterministic gate is worse than no gate — it converts a
> red into a retry. Carry verbatim.

**Assertion schema** — `p1-17-phase1-exit-gate.md:58`
```
- [ ] **Contract:** Gate assertion schema: `{ id: string, group: string, status: "PASS"|"FAIL", expected: string, actual: string, diagnostic?: string }`.
```

> This is the **per-clause-evidence** shape the audit means. Note it has no VOID status — P0.11's
> chassis added that, and the successor should reconcile to the chassis enum (PASS/FAIL/VOID/SKIP)
> rather than this three-value one.

**Read-only, bounded, non-mutating** — `p1-17-phase1-exit-gate.md:38`, `:48-50`
```
- **Guards/limits:** Gate must complete in under 5 minutes total. Each assertion has a 60-second timeout. Gate result is deterministic — same state produces same result. No mutation of system state during gate run (read-only assertions).
```
```
- INV-1: Gate script runs with read-only access — it inspects state but never mutates protocol state, creates PRs, or writes to banks.
- INV-2: Gate report does not expose secrets, tokens, or PII in assertion diagnostics.
- INV-3: Cost assertion reports total spend against budget — never individual token costs that could leak pricing details.
```

**Non-mutating verification of a stateful capability (the G4 pattern)** — `p1-17-phase1-exit-gate.md:35` (excerpt)
```
(G4) Approve/resume evidence: verify recorded pause/approve/resume events exist in Hindsight or `{repo}-dev-meta` from prior runs (non-mutating read-only check — the gate never simulates policy actions against live state).
```

> A reusable pattern worth carrying: how a **read-only** gate verifies an inherently
> **stateful** capability — by asserting on recorded evidence from prior runs rather than by
> exercising it. Step 5's gate will face the same problem for the credential lifecycle and the
> approval gate.

### Notes for writers

- **The 6 assertion groups (G1–G6) die** — they assert the Warren-era pipeline. The *shape* of an
  assertion group (id, what it queries, what constitutes green) survives; re-derive the set from
  §8 step 5's DoD.
- Carry INV-1's read-only discipline and the 5-minute/60-second budgets. Both are runtime-agnostic
  and both are what make a gate runnable in CI.

---

## 10. P1.19 — Pi Pair fix → PR green

**Source:** `p1-19-pi-pair-fix-green.md` (73 lines, **4 ACs**, INV-1..INV-4)

**Dies (audit §2/§3):** AC1's `warren run --team pi-pair` dispatch (the `--team` flag exists in no
Warren version examined); burrow execution; the line-52 warren-exit-code mapping; CC-13/CC-14
references. Audit §2 notes the intent (feedback → bounded fix run → CI green) is sound and *close
kin to step 0's DoD*.

> **Label warning.** Audit §3 cites AC2–AC5. **The story has 4 ACs.**
> Also note: audit §2 attributes `--team pi-pair` to AC1 — it is actually in Technical Notes
> Integration points (L37) and DoD (L60); AC1 (L29) says only "dispatches a Pi Pair via A2A
> delegation". And audit §2's quoted "line 52" exit-code mapping is not at line 52 (that is INV-2);
> I found **no warren-exit-code mapping text anywhere in P1.19**.

### Crosswalk

| Audit §3 names | Actually lives at | Verdict |
|---|---|---|
| AC2 pair produces commits addressing the feedback | Tail of **AC1** L29 ("reads the comment, implements a fix, and pushes to the PR branch"). Real AC2 (L30) is CI-green | **Drift** |
| AC3 fix-run output validates against the step-output schema | **Nowhere in P1.19.** Real AC3 (L31) is CI-webhook → summarize | **NET-NEW** |
| AC4 CI green → comment resolved/PR updated | CI-green→advance is **AC2+AC3**. **"Comment resolved" appears nowhere** | **Drift + NET-NEW** |
| AC5 ≤2 fix attempts then human escalation with context | **AC4** L32 + INV-4 L54 + Guards L39. "Human escalation" is not stated — the source says "records a failure with diagnostic output" | **Drift (AC5 does not exist) + NET-NEW (escalation)** |
| INV-1 no force-push, append-only commits | **Nowhere — no force-push prohibition in the story.** Real INV-1 (L51) is the burrow clause, which *dies*. Nearest surviving is **INV-2** L52 + Guards L39 | **NET-NEW** |

### Verbatim — carry these

**Pair reads feedback, implements, pushes (AC1 tail — the audit's "AC2")** — `p1-19-pi-pair-fix-green.md:29`
```
1. **(make-or-break)** Given a PR in "review_feedback_detected" state with ≥1 bot review comment, When the dev manager dispatches a Pi Pair via A2A delegation, Then the Pi Pair runs inside Warren, reads the comment, implements a fix, and pushes to the PR branch.
```

> Dispatch half (`via A2A delegation`, `runs inside Warren`) dies. Surviving core: **reads the
> comment, implements a fix, and pushes to the PR branch** — and note that under D8 the push is
> host-side, so this AC must be re-split the same way P1.15's is (§7).

**CI green (AC2)** — `p1-19-pi-pair-fix-green.md:30`
```
2. Given the Pi Pair has pushed the fix, When CI checks run on the PR, Then the PR reaches green status (all required checks pass).
```

**Green → terminal success (AC3)** — `p1-19-pi-pair-fix-green.md:31`
```
3. Given the PR is green after the fix, When SwarmClaw receives the CI status webhook, Then the protocol advances to the summarize phase and the run reaches a terminal success state.
```

**Bounded attempts with diagnostics (AC4 — the audit's "AC5")** — `p1-19-pi-pair-fix-green.md:32`
```
4. Given the Pi Pair fails to produce a passing fix within the retry limit (max 2 attempts), When the retry budget is exhausted, Then the protocol records a failure with diagnostic output (error log, diff attempted, CI failure messages).
```

> **This is the strongest clause in the story.** `(error log, diff attempted, CI failure messages)`
> is exactly the "escalation with context" the audit names — the context is enumerated. What is
> missing is a stated *human* escalation step; the source stops at "records a failure". Add the
> handoff explicitly.

**Branch scoping + retry budget invariants** — `p1-19-pi-pair-fix-green.md:52`, `:54`
```
- INV-2: Fix pushes are scoped to the PR branch only — never to the default branch.
- INV-4: Retry budget (max 2) prevents infinite fix loops on irrecoverable failures.
```

**CI webhook signature validation** — `p1-19-pi-pair-fix-green.md:53`
```
- INV-3: CI status webhook signature is validated before protocol state transition.
```

**Attempt bounds + required-check discipline** — `p1-19-pi-pair-fix-green.md:39`
```
- **Guards/limits:** Max 2 fix attempts per PR. Each attempt has a 15-minute timeout. Push to the same branch (not a new branch). CI check must be a required check (non-required checks ignored). Protocol state tracks attempt count and last error.
```

> "CI check must be a **required** check (non-required checks ignored)" is a small clause doing
> real work — it stops an advisory lint job from holding the loop open forever, and stops a
> green-because-nothing-ran result from counting. Carry it.

### Notes for writers

- **"No force-push, append-only commits" is NET-NEW** and is a good rule, but the source's actual
  guard is different and also worth keeping: *push to the same branch, never the default branch*
  (INV-2 + Guards). State both; they cover different failure modes (INV-2 stops the fix landing on
  `main`; no-force-push stops the fix erasing review history).
- Audit §2 calls this "close kin to step 0's DoD (team makes a suite green)". Before authoring,
  read the step-0 DoD and reuse its green-suite assertion rather than inventing a second one.
- Per audit §6 hole 2, **this capability has no §8 step.** P1.18 (KEEP) + P1.19 form the
  "factory maintains its own PRs" loop and §8 ends at step 7 with no home for it. The writer
  should flag the slot question rather than silently assuming a step.

---

## 11. Consolidated NOT-FOUND list — clauses audit §3 names that do not exist in the source

Every item below was searched for by exact phrase and by concept across all 19 current phase-1
story files. **None of these can be pasted as "surviving verbatim" — there is no source text.**
Each is a legitimate candidate v5 requirement that must be **authored fresh and reviewed as new**.

| # | Story | Audit-named clause | Status |
|---|---|---|---|
| 1 | P1.1 | "runId ack semantics" | No `runId` in P1.1; acks carry `requestId` + JSON-RPC `id` |
| 2 | P1.1 | "CC-5 correlation" | No CC-5 in P1.1; correlation is CC-9. Probable typo |
| 3 | P1.4 | AC5 "per-step timeout ≤ upstream budget with margin" | Belongs to P1.6 INV-4 / P1.1 CC-7 |
| 4 | P1.6 | AC4 "NDJSON events parse via `parseTeamEventLine`, zero malformed lines" | Zero hits for `NDJSON` or `parseTeamEventLine` in any story |
| 5 | P1.6 | AC6 "prompts persisted pre-execution" | Zero hits |
| 6 | P1.6 | INV-1 "no secrets in step output" | Zero hits; P1.6 INV-1 is the pinned workspace root |
| 7 | P1.10 | AC3 "pause state persisted, survives restart, resumable" | Zero hits for restart/persistence of pause state |
| 8 | P1.13 | AC1 "exactly-one idempotent runId-keyed" | No idempotency language; key is `heartbeatRunId` |
| 9 | P1.13 | AC2 "cacheRead/cacheWrite" | Zero hits |
| 10 | P1.13 | AC2 "USD as integer micro-dollars" | Source is `costCents`. **Unit contradiction — see §6** |
| 11 | P1.13 | AC2 "per-role split" | Zero hits |
| 12 | P1.13 | AC3 "`qds cost <issue>`" | No CLI surface in the story |
| 13 | P1.13 | INV-2 "malformed cost events → `unpriced` flag, never dropped" | Zero hits for `unpriced` |
| 14 | P1.15 | AC2 "green gates" precondition | Zero hits — this is the F10 requirement, net-new |
| 15 | P1.15 | AC3 "issue refs + cost summary" in PR body | Zero hits |
| 16 | P1.15 | AC4 "reviewer-visible artifacts attached" | Zero hits |
| 17 | P1.15 | AC5 "red gates → no PR, failure recorded on issue" | Failure is recorded in protocol state, not on the issue |
| 18 | P1.15 | INV-1 "push credential stays host-side" | Source has Warren pushing **from the box** — D8 reverses it |
| 19 | P1.16 | AC1 "`qds audit <pr>`" CLI | Walker takes a PR URL or branch name; no CLI |
| 20 | P1.16 | AC4 "chain verification in CI on merged factory PRs" | Zero hits; real AC4 is the 30s budget |
| 21 | P1.16 | INV-1 "immutable link references" | Nearest is write-at-creation-not-retroactively |
| 22 | P1.17 | AC2 "versioned report JSON to sprint-artifacts" | P0.11 chassis property, not in P1.17 |
| 23 | P1.17 | AC3 "VOID clauses recorded with reason" | P0.11 chassis property, not in P1.17 |
| 24 | P1.17 | "gate exit convention 0/1/2" | P0.11 chassis (`scripts/phase0-exit-gate.ts`, `src/gate/*`) |
| 25 | P1.19 | AC3 "fix-run output validates against the step-output schema" | Zero hits |
| 26 | P1.19 | AC4 "comment resolved" | Zero hits |
| 27 | P1.19 | AC5 "human escalation with context" | Source stops at "records a failure with diagnostic output" |
| 28 | P1.19 | INV-1 "no force-push, append-only commits" | Zero hits for force-push |

**Items 22–24 are recoverable from a known location** — the P0.11 gate chassis. Items 10 and 18 are
**contradictions**, not gaps, and need an explicit decision before authoring. The remaining 23 are
genuine net-new requirements.

---

## 12. Recommendation to the derivation owner

1. **Do not let writer agents consume audit §3 directly.** Point them at §1–§10 of this document.
   The audit's clause map, used as-is, would cause 28 unreviewed requirements to enter the backlog
   under F14's "surviving verbatim, do not re-litigate" shield, and would propagate one 10,000×
   currency-unit error and one inverted security doctrine.
2. **Consider a correction pass on audit §3.** F14 is recorded as closed. Its §3 table is the
   artifact writers were told to trust, and its labels do not resolve. That is worth fixing in the
   audit itself, not only in this downstream document.
3. **Route the 28 NET-NEW items somewhere deliberate.** Most look like good v5 requirements —
   they read as the design's contract language rather than the stories'. They belong in the
   net-new columns audit §4 already identifies (credential lifecycle, phase-engine core, fleet
   dispatcher), where they will get normal review.
4. **Two decisions needed before authoring starts:** the cost unit (cents vs micro-dollars, §6)
   and the explicit statement that D8 reverses P1.15's in-box push (§7).
