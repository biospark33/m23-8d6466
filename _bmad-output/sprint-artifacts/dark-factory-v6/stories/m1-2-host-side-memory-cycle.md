# M1.2: Host-side memory cycle — dispatch-time recall, harvest-time idempotent retain

**Story Points:** 5
**Sprint:** v6a (Foundation — memory ladder, story 6 of 11; the first primed-dispatch round trip and v6a's only T2 live round)

> **Provenance:** charter row M1.2 (`2026-10-01-v6-derivation-session-INPUT.md:78`). Folds P2.8's MECHANISM ONLY — stable dated `documentId` + `updateMode:"replace"` with the idempotency contract schema-owned (`_bmad-output/sprint-artifacts/phase-2/stories/p2-8-hindsight-retain-bridge.md:49,:95,:112`); its Daily-Learnings surface, `promotion_runs` bookkeeping, and qds-product/qds-meta routing are NOT carried (DD-15 fold). Copies the zeropoint `<kg_context>` pattern (`reactive/reactive-grounding-extension.ts` beforePromptBuild → `hindsight-context-adapter.ts`); skips its Clerk gate + Presidio (D-2 — no tenant machinery); keeps the directive/citation grammar.

## Spec Reference

- **Charter** `2026-10-01-v6-derivation-session-INPUT.md` — row M1.2 (:78); §6 guardrails (INV-IBOX/F10/INV-7, AUDIT_HOPS frozen, no write credential in-box, ops operator-gated); D-2 (dedicated Hindsight 0.10.0, `qds-` banks, no Presidio); §2.2 KG pattern (:50).
- **DD agenda (new register):** DD-15 (P2.8 fold — this story implements the FOLD leg), DD-16 (D8 amendment: the second per-box credential is recall-only and arrives with M2.2 — M1.2 adds NO box credential; the appendix rides the brief).
- **Substrate:** `src/hindsight/client.ts` — `retain` :166, `recall` :192 (RECALL timeout 10s), mock mode :94-106 (network-only short-circuit), INV-HM1 env-only auth; `src/hindsight/bank-provisioner.ts` — `resolveRepoBankId(baseId, existing)` :184-208 (≤52-char truncate + `-2..-11` collision suffix — the collision/truncation resolver; `resolveBankId` is only the raw slug normalizer feeding it), `COLLECTIVE_BANK_ID = "qds-collective"` :40; `src/audit/link-store.ts` — `AUDIT_HOPS` :52-63, `HOP_EVENT_VOCABULARY` :77-88 (empty vocabulary IS the refusal, INV-AUDIT-4), `linkExists` coalesce dedup.
- **Ancestry disposition:** P2.8's client-extension clause survives verbatim in spirit (idempotency "OWNED + schema-enforced … NOT assumed from passthrough"); its routing/recovery clauses (`retain-routing` precedence, `RetainBridge.recoverStranded`, `retained_at` stamping) are DROPPED — factory replay idempotency comes from the deterministic runId-derived documentId, not a promotions table.
- **Zeropoint grammar (copied symbols):** `EMPTY_KG_DIRECTIVE`, `CITATION_INSTRUCTION` (`[cite:<id>]`), `buildKgContextXml`, fan-out + `mergeFanOutObservations`. `RECALL_MAX_ATTEMPTS=3` NOT copied — dispatch is latency-budgeted, one attempt per bank. **Stated divergence from the zeropoint pattern:** the directive fires on empty-result ONLY — timeout/error emit NO directive (v5 silence), never a fallback directive.
- **Term mapping:** `documentId` (this story's term, inherited from P2.8) is the document identity the substrate carries; recall results surface it as the additive, null-tolerant `documentId` field (AC5), and `recalledDocumentIds` are the recall results' `documentId` values in rank order — the field M1.3's probes key on. Recall results carry DISTINCT `id` (server-minted fact id) and `document_id` (document identity) — `documentId` and the substrate's fact ids are separate identities and are NOT assumed equal; the side channel carries `documentId` in either mode.
- **[VERIFY] (DD-28.26(3), `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` §8a.3):** the folded mechanism — client-supplied `documentId` + `updateMode:"replace"` honored end-to-end (the retained document's `document_id` surfaces in recall results, and a replay retain replaces rather than duplicates) — is UNVERIFIED against the pinned 0.10.0 (`RetainPayloadSchema` carries neither field; zeropoint routes provenance via tags; retain responses carry no `memoryId`, so the echo asserts on `document_id`, AC7). AC7's first leg asserts the echo on the live instance; if 0.10.0 does not honor client-supplied identity, the named fallback engages: a host-side retain-identity ledger keyed on runId → skip-on-replay replaces server-side replace (DD-28.3 stands as design intent, gated on the echo leg).

## User Story

As the factory operator, I want each dispatch primed with what the factory already knows about that repo and each harvest retained idempotently, so that run N+1 starts smarter than run N, a broken KG can only degrade to v5 behavior, and the box never gains a write path to memory.

## Overview

Two host-side legs around the existing run lifecycle, both outside the box: **dispatch-time** — bounded recall over the run's `qds-` banks assembles a `<kg_context>` appendix carried on a new optional typed brief field `kgContext`; **harvest-time** — a bounded, host-authored run-outcome document is retained with `documentId = <runId>` + `updateMode:"replace"`, receipted on the reserved `memory-retain-receipt` audit hop. Degradation ladder: memory env unconfigured → byte-identical v5 dispatch; recall timeout/error → proceed-unprimed (v5 behavior); recall succeeds with zero observations → `EMPTY_KG_DIRECTIVE`; results → full block with citations.

**What this does NOT deliver:** in-box `kg_recall` (M2.2 — no box→KG network path exists here; the appendix rides the brief), the authz gateway (M2.1), bank provisioning (M1.1), the Graphiti decision (M1.3/DD-22), manager meta banks (M3.1), QA findings retain (A2).

## E2E Slice

**Demonstrable behavior:** Given M1.1's banks and one retained observation matching `repoSlug`, When `bun scripts/fleet.ts dispatch … --driver exedev` runs, Then it exits 0, the shipped brief's `kgContext` carries the `<kg_context>` block with `[cite:*]` provenance lines, the box run context renders it, and `_bmad-output/memory/recall/<runId>.json` records `{runId, primed, directive, banks, recalledDocumentIds, chars, latencyMs}` (the Observability Contract shape verbatim). When `fleet harvest` completes, Then the run bank holds one outcome document (`documentId = <runId>`), audit.db holds exactly one `memory-retain-receipt`/`retain` row (subject = documentId), and re-running harvest produces NO second document and NO second receipt row.

**Wiring closed:** On completion of this story, primed dispatch and idempotent harvest retain work using only code merged by this story plus the already-merged `src/hindsight/` modules. **No stub, no `TODO: wire later`.** The M2 gateway, in-box recall, and any scheduling are out of scope by construction.

**Dependency edges (predecessors):** M1.1 is a **direct edge for the live legs only** — the charter's "mock-first dev before VPS" means every mock-tier AC below carries no M1.1 edge (the mock client short-circuits the network). Transitive for the T2 round: Z4 → M1.1 → this story's live legs, plus the wave-0 image re-pin ritual (see Technical Notes — this story's own brief-schema/pipeline-run edits move the pin, so the ritual must run on a tree containing this story).

> **Not an edge — M2.1/M2.2:** host legs call the dedicated instance's REST directly (D-2); the gateway fronts the later IN-BOX surface and does not re-route host retain/recall.

## Acceptance Criteria

1. **(make-or-break) Primed dispatch through ONE seam.** Given memory env configured (`HINDSIGHT_BASE_URL` + host token) and a primed bank, When any dispatch-shaped entry resolves (the dispatch verb; fanout/submit ride the same entry), Then the shipped brief carries `kgContext` assembled by fan-out recall over `{<provision-time repo bank id>, qds-collective}` — the repo bank id pinned to PROVISION-TIME resolution (`resolveRepoBankId` semantics: ≤52-char truncate + `-2..-11` collision suffix; persisted by M1.1's provision leg or resolved at first use against the live bank list — never re-derived from the raw `resolveBankId(repoSlug)` normalization, which can diverge from the provisioned id) — merged, ranked, citation-floored, ≤ `KG_CONTEXT_MAX_CHARS` — and the side-channel row exists. *Negative controls, both MUST fail: an implementation that forks the append into per-verb copies passes the happy path but strands sibling dispatch-shaped callers; one that lets recall latency or failure change dispatch's exit codes (adds a retryable-1 path) violates proceed-unprimed and MUST fail.*

2. **Degradation ladder.** (a) env unconfigured → no recall attempt, brief byte-identical to v5, no side-channel row, no kg log lines; (b) recall timeout (`RECALL_WALL_BUDGET_MS`) or error → proceed-unprimed: no `kgContext`, dispatch exits exactly as v5; (c) recall succeeds, zero observations → `EMPTY_KG_DIRECTIVE` block only; (d) results → full block. *Negative control: an implementation mapping timeout → `EMPTY_KG_DIRECTIVE` conflates "KG says nothing" with "KG unreachable" — the charter's degradation is v5-identical on timeout — MUST fail.*

3. **Bounded assembly, schema-enforced.** Assembly stops at whole-observation granularity at `KG_CONTEXT_MAX_CHARS`; `BriefSchema` refuses any `kgContext` over the ceiling or carrying control chars (fail-loud backstop, never silent truncation past the seam). *Negative controls: unbounded kg_context MUST fail — a brief whose `kgContext` exceeds the ceiling exits 2 at validation; an implementation relying on recall limits alone (no schema ceiling) MUST fail this AC.*

4. **Idempotent harvest retain.** Given a harvested run, When the harvest leg lands (direct `fleet harvest` or the observe chain's harvest), Then exactly one outcome document is retained to the provision-time repo bank id (`resolveRepoBankId` semantics — see AC1) with `documentId = <runId>` (dated by construction — runIds are `qds-YYYYMMDD-*`), `updateMode:"replace"`, payload = host-authored bounded structured outcome (runId, repoSlug, correlation id, exit classification, cost µ$, bundle path; tags) ≤ `RETAIN_PAYLOAD_MAX_BYTES`. Re-invocation retains byte-identical content → replace, no duplicate. *Negative controls: a time-based or random documentId makes replay mint duplicates and MUST fail; retaining raw box prose (untrusted boundary input, F10) MUST fail; a retain path accepting any per-run memory key or write credential MUST fail — DD-16: the host env token (INV-HM1) is the only retain credential.*

5. **Client surface (P2.8 fold).** `retain()` forwards `documentId`/`updateMode`/`tags` through a schema'd, additive extension; mock mode returns a schema-valid canned body through the SAME strict parse (network-only short-circuit, never validation short-circuit). Recall results surface `documentId` as a null-tolerant additive field on the recall-result schema (0.10.0 recall results carry DISTINCT `id` and `document_id` — Hindsight 0.10.0 OpenAPI `RecallResult`; null-tolerant because an item retained without an explicit id gets a server-assigned one) — the typed field M1.3's expected-id matching consumes; the schema touch is coordinated with M1.1's response-schema conformance amendment (both adds-only). *Negative control: an implementation assuming passthrough of the new fields without owning them in the schema/strict parse MUST fail (P2.8: the idempotency contract is OWNED, not assumed).*

6. **Audit receipt on the reserved hop.** After successful retain, one `memory-retain-receipt`/`retain` row: subject = documentId, evidence digest = sha256 over the canonical retain identity (bank + documentId + content digest) — replay dedups via the store's coalesce identity; re-retain with DIFFERENT content fires the divergent tamper alarm BY DESIGN (same documentId, mutated content is exactly the anomaly the alarm exists to surface). `detail` is digest-stable, ≤ 8 KiB, and records the retain identity readably for consumers: the `documentId` (also the row's subject) AND the retain bank id — the receipt's bank field is what makes M1.3's bank-provenance gate decidable per probe (it compares receipt-bank vs the probe's expected bank; M1.3 AC1(ii)); latency rides log lines, never the row. *Negative controls, all MUST fail: appending a hop to `AUDIT_HOPS` (the ten-hop contract is closed); writing the receipt without the vocabulary population (the store refuses `audit-link-invalid` — the empty vocabulary IS the refusal); volatile fields in `detail_json`.*

7. **T2 live round (v6a's only one).** `QDS_E2E_LIVE=1` + `QDS_E2E_TIER=2` with `QDS_EXEDEV_REPO_URL`/`QDS_EXEDEV_SHA`/`QDS_EXEDEV_ROSTER`/`OPENROUTER_PROVISIONING_KEY`: on a real box, **first leg — the [VERIFY] echo (DD-28.26(3)):** retain → recall asserts (a) the recalled results' `document_id` set CONTAINS the retain's `documentId` (recall results carry DISTINCT `id` and `document_id`; the echo keys on `document_id`, never on a fact id), and (b) a replay retain leaves exactly ONE document for that identity — the substrate's `document_id` upsert (Hindsight 0.10.0 retain docs: same `document_id` replaces, no duplicate). If either assertion fails on the pinned digest, the fallback engages (host-side retain-identity ledger keyed on runId → skip-on-replay) and the evidence records fallback mode; then a primed dispatch renders `<kg_context>` in the box run context; harvest retains; a probe recall then returns the outcome document; worst-case spend printed before fire; keys/boxes cleaned in `finally`; evidence scrubbed → `_bmad-output/evidence/`. *Negative control: any mock/stub in the live path (no-fakes rule in `*.live.test.ts`) MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| dispatch, memory configured + bank primed | in-scope | AC1 (mock) / AC7 (T2) | — |
| dispatch, bank reachable but empty | in-scope | AC2(c) | — |
| dispatch, recall timeout/error | in-scope | AC2(b) — proceed-unprimed | — |
| dispatch, memory env unconfigured | in-scope | AC2(a) — v5-identical | — |
| harvest, direct + observe chain | in-scope | AC4/AC6 | — |
| re-harvest / re-retain | in-scope | AC4/AC6 (dedup; divergent alarm on mutated content) | — |
| fanout / submit dispatch-shaped entries | in-scope via the shared dispatch entry | AC1 seam test | none in v6.0 |
| `run` replay, observe/status/result | out-of-scope — replay/read paths; brief fixed at dispatch | — | none in v6.0 |
| in-box `kg_recall` | out-of-scope — M2.2 | — | M2.2 |
| gateway authz / per-run recall keys | out-of-scope — M2.1 | — | M2.1 |
| meta-bank recall (manager lanes) | out-of-scope — M3.1 | — | M3.1 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| HindsightClient (mock) | in-process `src/hindsight/client.ts` | `bun test tests/hindsight/client.test.ts` green before start |
| bank symbols | in-process `src/hindsight/bank-provisioner.ts` | `bun test tests/hindsight/bank-provisioning.test.ts` green; read-only consumer |
| audit store | `.sandbox/audit.db` (`QDS_AUDIT_DB` override in tests) | `bun test tests/audit/` green before AND byte-identical after, except the adds-only vocabulary row |
| M1.1 dedicated Hindsight + `qds-` banks | VPS compose (ops-gated) | AC7 ONLY — M1.1's round-trip legs green before this story's live round |
| image pin | `verify-image-pin` workflow | AC7 ONLY — see Technical Notes pin sequencing |

> Not prerequisites: M2.1 gateway, M2.2 in-box recall, Clerk, Presidio, E21, Graphiti, and no new LLM spend (recall/retain are Hindsight REST calls; the run's own provider secret is unchanged).

## Technical Notes

- **Pin consequence (binding):** `src/fleet/brief-schema.ts` and `scripts/pipeline-run.ts` are in the box COPY set, and `deriveBuildId` hashes copied file BYTES (`scripts/build-exedev-image.ts` `gatherBuildIdInputs`, #186 gap 3) — this story's optional `kgContext` field + its render line MOVE the image pin. The wave-0 re-pin ritual must therefore run on a tree containing this story (or re-run after it); M1.2 itself adopts no pin (ops owns the ritual, operator-gated). Every other file this story touches is outside the COPY set — EXCEPT `src/fleet/teardown.ts` (the post-harvest hook, Files to Modify): `src/fleet/` is COPY-set wholesale (`oci/exedev/Dockerfile:279`), so the hook moves the pin too, covered by the same once-only ritual ops cost above.
- **Guards/limits (all named):** `KG_CONTEXT_MAX_CHARS = 8_000` (half the steering prompt ceiling `PROMPT_CHAR_CEILING = 16_000`, leaving the brief's own prose headroom); `RECALL_WALL_BUDGET_MS = 10_000` (the client's RECALL timeout; one attempt per bank, zero dispatch-path retries — zeropoint's `RECALL_MAX_ATTEMPTS=3` deliberately not copied); `KG_RECALL_LIMIT = 5` (client default k); `RETAIN_PAYLOAD_MAX_BYTES = 4_096`.
- **Fan-out set (deliberate):** exactly `{<provision-time repo bank id>, qds-collective}` — the id `resolveRepoBankId(baseId, existing)` returns at provision/first-use (bank-provisioner.ts:184-208, persisted by M1.1's provision leg or resolved at first use against the live bank list); the `-dev-meta` bank is NOT in the dispatch fan-out (M1.3 seeds its probes from its Mulch-imported content; consuming/consolidating `-dev-meta` is later-ladder material, unnamed in v6a). Per-bank partial failure contributes nothing: a timed-out/errored bank adds no observations and no directive; the directive stays `kg_context` if any bank returned results, and only all-bank failure is ladder (b).
- **Contracts/Schema:** `BriefSchema` gains ONE optional field (`kgContext`: capped, control-char-free string) — adds-only; absent field = v5 byte-identical downstream. No run-record schema change: instrumentation rides the side-channel JSON, not the record.
- **Region ownership:** `src/audit/link-store.ts` — adds-only vocabulary population, a DEVIATION ratified by the derivation register (Deviation 1 below); `AUDIT_HOPS` itself untouched. `scripts/pipeline-run.ts` — adds-only render (absent field = byte-identical). `src/hindsight/client.ts` — adds-only retain surface.
- **Considered and rejected:** appending `<kg_context>` into an existing brief string field — `BriefSchema` is `strictObject` with NO prose field to append to (fields verified :310-533); a typed schema field is the only faithful "brief appendix". Revisit only if a second appendix consumer appears.
- **Deviation 1 (binding on this story): `memory-retain-receipt` first writer.** The guardrail "never edit `src/audit/link-store.ts`" meets the derivation's explicit grant that M1.2 writes the reserved hop. Resolution: `AUDIT_HOPS` stays untouched; `HOP_EVENT_VOCABULARY["memory-retain-receipt"]` gains exactly `["retain"]` — an adds-only row converting INV-AUDIT-4's deliberate refusal into a one-event vocabulary. This enters the DD register as an amendment (not quiet growth); if the register declines it, the receipt leg falls out and the retain leg ships unaudited — surfaced, not silent.

## Observability Contract

- Log vocabulary (swarmclaw/log): `kg-recall` `{runId, directive: "kg_context"|"empty"|"none", banks, chars, recallMs}` on dispatch; `memory-retain` `{runId, documentId, bank, contentDigest}` on harvest. Unconfigured env emits NEITHER line (absent, not 0).
- Side-channel `_bmad-output/memory/recall/<runId>.json` — `{runId, primed, directive, banks, recalledDocumentIds, chars, latencyMs}`; M1.3's input; not digest-stable (not audit). Ladder (b) timeout/error DOES write the row — `{primed: false, directive: "none"}` — plus the `kg-recall` line (M1.3 counts every M1 cycle from these rows); unconfigured env writes neither row nor line.
- Sub-timings: per-bank `recallMs` present only when recall was attempted.
- Audit row: hop `memory-retain-receipt`, event `retain`, subject `documentId`; `detail` digest-stable, ≤ 8 KiB, carrying `documentId` + retain bank id (M1.3's provenance input).

## Files to Modify

- `src/hindsight/kg-context.ts` — new: fan-out recall, degradation ladder, `buildKgContextXml`/`EMPTY_KG_DIRECTIVE`/`CITATION_INSTRUCTION`, ceiling, charset guard
- `src/hindsight/run-retain.ts` — new: idempotent retain payload + receipt emit
- `src/hindsight/client.ts` — adds only: retain surface `documentId`/`updateMode`/`tags` + recall results' additive null-tolerant `documentId` field (AC5; schema touch coordinated with M1.1's response-schema conformance amendment — both adds-only) (+ mock canned bodies)
- `src/fleet/brief-schema.ts` — adds only: optional `kgContext` field + ceiling/charset validators (COPY-set file; moves pin)
- `scripts/pipeline-run.ts` — adds only: render `kgContext` into the box run context when present (COPY-set file; moves pin)
- `scripts/fleet.ts` — the dispatch append seam + the direct-`fleet harvest` retain call site; NOT in the COPY set
- `src/fleet/teardown.ts` — adds only: a post-harvest completion hook on `teardownSandbox`'s harvest step (`runHarvest`, cited by symbol — the hook site is the harvest invocation inside `teardownSandbox`) so the observe chain's harvest (run-completion.ts:385 `observeAndDriveChain` → `teardownSandbox`, whose first internal step IS harvest) retains through the SAME seam as direct `fleet harvest` (COPY-set file; moves pin — see Technical Notes)
- `src/audit/link-store.ts` — adds only: `memory-retain-receipt` vocabulary (Deviation 1)
- `tests/hindsight/kg-context.test.ts` — new (ladder, ceiling, grammar, fan-out merge, per-bank partial failure)
- `tests/hindsight/run-retain.test.ts` — new (documentId determinism, replace dedup, receipt dedup/divergence)
- `tests/fleet/e2e/memory-cycle.live.test.ts` — new; **Tier 2 deliberately** — the priming round-trip needs a real box + real bank, and tier selection drives real spend

## Security Invariants

- **INV-KG-1 (bounded recall):** every recall is ceiling- (`KG_CONTEXT_MAX_CHARS`), time- (`RECALL_WALL_BUDGET_MS`), and rank- (`KG_RECALL_LIMIT`) bounded. What it does not fence: KG content QUALITY — a bank full of noise primes noise; the DD-22 checkpoint is the quality lever, not this invariant.
- **INV-KG-2 (host-side-only writes):** no retain path is reachable in-box; M1.2 adds NO box credential (DD-16's second credential arrives with M2.2 and is recall-only); retain authenticates with the host env token only (INV-HM1 inherited verbatim).
- **INV-KG-3 (boundary payload hygiene):** `kgContext` is charset-guarded + ceiling'd at the schema; the retain payload is host-authored structured summary — raw box prose is never a retain input (F10/INV-7 applied at the memory boundary).
- **INV-KG-4 (audit integrity):** `AUDIT_HOPS` untouched; receipt `detail` digest-stable; divergent re-emit = tamper alarm, by design.
- **Not fenced:** box→KG egress — none exists to fence in M1.2 (the appendix rides the brief); M2.2 owns that fence.

## Definition of Done

- [ ] **Impl:** dispatch seam appends `kgContext` at the single dispatch entry; ladder (a)–(d) implemented as specified; harvest leg retains idempotently; receipt emitted on retain success only, best-effort (an audit-store refusal never fails a landed retain).
- [ ] **Impl:** client retain surface extended additively; mock canned body strict-parsed; `BriefSchema` optional `kgContext` with ceiling + control-char refusal.
- [ ] **Contract:** absent `kgContext` field = v5 byte-identical everywhere downstream (golden brief test).
- [ ] **Security:** negative-control failure predictions proven by test — over-ceiling kgContext brief exits 2; a per-run-key retain path refuses; an `AUDIT_HOPS` append fails the type/vocabulary check; timeout dispatch exits exactly as v5 with no `kgContext`.
- [ ] **Test (unit):** `bun test tests/hindsight/kg-context.test.ts tests/hindsight/run-retain.test.ts` green.
- [ ] **Test (regression):** `bun test tests/fleet/ tests/audit/` green; `src/fleet/dispatch.ts` + `src/fleet/verbs.ts` byte-identical; audit store byte-identical except the vocabulary row.
- [ ] **Integration:** side-channel JSON round-trips into a probe recall query (M1.3's input contract, mock client).
- [ ] **Test (e2e demo — MANDATORY):** AC7 T2 live round — primed dispatch + harvest retain + probe recall on a real box; `QDS_E2E_LIVE=1 QDS_E2E_TIER=2` + the four required env vars; spend printed pre-fire; cleanup in `finally`; scrubbed evidence in `_bmad-output/evidence/`.

## Dev Agent Record

(written at implementation time — not part of this spec)
