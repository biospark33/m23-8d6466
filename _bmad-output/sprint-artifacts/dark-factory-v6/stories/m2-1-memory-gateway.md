# M2.1: Memory Gateway — Per-Run Recall-Only Keys on the Credential Lifecycle's Spine

**Story Points:** 5
**Sprint:** v6a (M-arc, story 4 of 4 — the authz layer that makes the dedicated KG safe to approach; wave-1 dev, acceptance pinned on M1.1)

> **Dependency edge, pinned explicitly (R5-F1, register-ratified):** the charter's dep "M1.1" holds for **integration acceptance only** — this story is unit/mock tier and its dev starts in Wave 1 against fixtures, before the VPS lands. Nothing here waits on the box; the live-instance conformance leg is M2.3's combined round.

## Spec Reference

- Charter M2.1 row + **D-2** ("only front door = the M2 memory gateway with real authz; per-run scoped **recall-only** keys via DF2.3 mint/revoke machinery") + §6 guardrail line ("Gateway authz: bank-scoped, recall-only in-box keys, revoke-verify-before-destroy, never public 8888/18889, Caddy allowlist from the vultr template"); **DD-16** — the D8 amendment this story implements — in `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`.
- **D8 original, intact:** `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md:305` — the amendment adds exactly one per-box credential; it regresses none of D8's original clauses (secrets never in argv, no push credential in any box, host-side PR creation, per-box egress policy, append-only audit + cost ledger).
- **The mirror source (consumed, never modified):** `src/providers/credentials.ts` — `mintRunKey` :553 (backstop refusal `cap-invalid` BEFORE `keyApi.createKey`, INV-CAP-1), `revokeRunKey` :978 (`"revoked" | "already-gone" | "none"`), `verifyRevoked` (fail-closed list walk, `MAX_VERIFY_PAGES = 20` :108), `openRouterKeyApi` :1745 (env-by-name provisioning key; transport retries ≤2, 100ms stepped, **non-POST only — the mint POST attempts = 1**; 4xx never retried), `runCredentialLifecycle` :1622-1727 (record → assert delivery target → mint → deliver in try → **revoke-verify compensation** on delivery failure → rethrow the ORIGINAL error → capture-spend → revoke → verify; "a minted key must never outlive a failed delivery"), the ordering invariant :69-75, delivery contract `KEY_ENV_FILE`/`KEY_ENV_VAR` :100-101.
- Upstream client: `src/hindsight/client.ts` (`mode: "live" | "mock"` — the gateway fronts it in both modes; mock short-circuits network, never validation).
- Caddy allowlist idiom: vultr-deploy template `deploy/control-plane/Caddyfile` (deliberate route allowlist; Z4 extends it — the route config is Z4's, the contract is this story's).

## User Story

As the factory, I want a memory gateway that issues per-run recall-only keys and long-lived bank/verb-scoped agent tokens with exactly the mint→deliver→revoke→verify discipline DF2.3 uses for provider keys, so that a box can read the factory KG and nothing more — no write credential ever enters a box, no key outlives its delivery failure, and the only door to Hindsight is one with authz on it.

## Overview

`src/memgate/` (new module root — flat-src convention; NET-NEW name ratified in the register) is the authz gateway over the dedicated Hindsight: a small issuance/verification service plus the per-run key lifecycle that mirrors `runCredentialLifecycle` in ordering, compensation, and retry posture. Per D-2 it is the KG's only front door; per DD-16 the per-run recall-only key is the second credential in a box's set — never a write credential. Long-lived agent tokens (bank/verb-scoped) serve M3.1's manager bots over the same surface; the gateway is driver-agnostic, so M3.1's documented crontab fallback (E21 slip) works unchanged.

**What this does not deliver.** No in-box consumption (M2.2 owns `kg_recall`, the roster grant, and the image re-pin its box files trigger), no live round (M2.3), no host-side wiring of dispatch-time recall or harvest retain — M1.2's host legs go direct per its own spec (INV-KG-2/INV-HM1); gateway consumers = in-box recall (M2.2), the M2.3 battery, M3.1's nightly job, no compose slot or Caddy route (Z4's stack — this story ships the module and the service contract that fills it), no manager banks (M3.1).

## E2E Slice

**Demonstrable behavior:** In mock mode (gateway + mock hindsight client, no network), the full per-run lifecycle runs: record → assert delivery target → mint → deliver → capture → revoke → verify; a delivered key recalls from an allowlisted bank; recall against a non-allowlisted bank, under a write verb (`retain`/`reflect`/`consolidate`), past expiry, or after revocation is refused with a typed reason. On delivery failure the compensation revoke+verify runs BEFORE the original delivery error rethrows, and the key is verifiably dead. Log lines carry `{ event, requestId, runId|tokenId, reason? }` with zero key material.

**Wiring closed:** On completion, the closed unit/mock loop — mint, scope-enforced recall, revoke-verify — works using only code merged by this story plus the consumed `src/hindsight/` client. **No stub, no `TODO: wire later`.** Live-instance conformance is explicitly NOT claimed here (the M1.1 acceptance-only edge; M2.3 proves it live).

**Dependency edges (predecessors):** M1.1 — **acceptance-only** (header blockquote; not a dev blocker). Consumed unchanged: `src/hindsight/client.ts`; mirrored, never modified: `src/providers/credentials.ts`. > **Not an edge — M2.2:** this story ships no box file and moves no image pin; M2.2 consumes the delivered key. **Not an edge — Z4:** the compose slot and Caddy route are Z4's; unit/mock needs no VPS.

## Acceptance Criteria

1. **(make-or-break — the ordering is the mirror, not an inspiration)** `runMemoryKeyLifecycle` follows `runCredentialLifecycle` (:1622-1727) exactly: validate the delivery target → mint → deliver in try → on failure (except a named discrimination case, mirroring `DELIVER_AUDIT_LINK_FAILED` :1651 semantics) run the best-effort revoke+verify compensation with its own events, THEN rethrow the ORIGINAL delivery error → capture → revoke → verify. *Negative controls, both MUST fail: an implementation whose delivery failure strands a live key — the exact hazard the compensation exists to close; and one that retries the mint POST after a timeout, which may have SUCCEEDED server-side and would strand a second live key (credentials.ts :1762-1766).*
2. **(recall-only is the whole point)** A per-run key carries `{runId, bankAllowlist, ttlMs, verbs: ["recall"]}` and nothing else: recall outside the allowlist is refused (`scope-bank`); `retain`/`reflect`/`consolidate` under a per-run key are refused (`scope-verb`); expired is refused (`expired`); revoked is refused (`revoked`). *Negative control: any implementation whose per-run key can complete a retain MUST fail — that credential in a box is precisely what DD-16/F10/INV-7 forbid.* *Live cross-bank probe (exercised in M1.1's auth-retired-check leg — same operator VPS window; the credential rule is pinned here where scope enforcement lives): the probe presents the key from Z4's `hindsight-qds.env` — the DEDICATED instance's own env, the runbook G3 pattern — never the tenant stack's `hindsight.env`, so a refusal is attributable to bank scope; the evidence JSON records the auth-outcome class (`known-key-out-of-scope` vs `unknown-key`) separately.*
3. **(the TTL backstop, at mint, pre-issuance)** `DEFAULT_KEY_TTL_BACKSTOP_MS = 86_400_000` (24h — mirrors approval-gate.ts:852 `DEFAULT_TIMEOUT_MS`; a recall key with no run to serve outliving the gate's own window has no honest purpose) is enforced at mint BEFORE issuance with a typed refusal (the `cap-invalid` pattern, INV-CAP-1), and the ordering invariant `perRunTtlMs ≤ DEFAULT_KEY_TTL_BACKSTOP_MS` is stated beside the constant. *Negative control: a mint that accepts `perRunTtlMs` above the backstop — or enforces the ceiling only after issuance — MUST fail.*
4. **(retry posture, mirrored)** Transport errors retry ≤2 with 100ms stepped backoff for non-POST methods only; the mint POST attempts = 1; a 4xx is a response, never a transport error, and is never retried. *Negative control: an implementation that lets the mint ride the retry loop MUST fail (AC1's stranded-second-key hazard).*
5. **(agent tokens: scoped, closed, never in a box)** Long-lived tokens carry a bank set + a verb subset of the closed vocabulary `AGENT_TOKEN_VERBS = ["recall", "reflect", "consolidate", "retain"]`; wildcards ("all banks", "all verbs") do not exist in the vocabulary; every grant names its consumer class (per-run vs agent), and no agent token has a delivery path into an exedev box — they serve M3.1's manager bots; boxes get per-run keys only. The vocabulary splits into two agent grant classes (DD-28.26 item 1): host-held `{reflect, retain}` and bot-held `{consolidate}`. Each verb maps to exactly one bank-scoped REST operation class the gateway will forward — the published verb→route table (Technical Notes) is part of this AC; a route outside the presented token's mapped set refuses with `scope-verb`. *Negative controls, both MUST fail: a token granted a verb outside the vocabulary; and a grant path that cannot name its consumer class, and so cannot assert where the token may travel.*
6. **(D8 amendment conformance, DD-16 as written)** The gateway's credential surface is exactly two kinds — the per-run recall-only memory key and the long-lived agent token — and the per-run key is the only kind with a delivery path toward a box; `deliverRunKey` writes the seam's registered wire names — the key entry `QDS_KG_RECALL_KEY` plus the non-secret `QDS_KG_GATEWAY_URL` origin entry (M2.2's Contracts/Schema block is the registration of record; the delivery leg is this story's, the in-box side M2.2's) — under the `KEY_ENV_FILE`/`KEY_ENV_VAR` discipline to the delivery target. D8's original clauses are untouched: the admin key is env-only (never argv), no push credential exists here, and the audit chain gains no hop (gateway events are log lines). *Negative control: a third credential kind — e.g., a write-capable box key — MUST fail.*
7. **(admin auth and the single door)** Admin operations (mint, revoke, agent-token grant/list/revoke) require `MEMGATE_ADMIN_KEY`, read env-by-name at construction (the `openRouterKeyApi` `provisioningKeyEnv` pattern); a missing or empty key refuses before any state changes. The gateway fronts exactly the dedicated instance — compose-side `http://hindsight-qds:8888`, host-side origin `127.0.0.1:18890` env-carried per DD-28.22 — and NEVER the tenant stack's 18889 map; it is the only memory route Caddy may expose (allowlist idiom from the vultr template; the route config lands in Z4's compose). *Negative control: an admin op succeeding with no admin key configured — or any code path that would make 8888, 18889, or 18890 publicly routable — MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---|---|---|---|
| per-run key lifecycle (mint→deliver→capture→revoke→verify + compensation) | in-scope | `tests/memgate/lifecycle.test.ts` | — |
| scope enforcement (bank / verb / TTL / revoked) on per-run keys | in-scope | `tests/memgate/gateway.test.ts` | — |
| long-lived agent tokens (grant, verb subset, revoke, revocation check) | in-scope | `tests/memgate/gateway.test.ts` | — |
| admin auth (`MEMGATE_ADMIN_KEY` env-by-name) | in-scope | `tests/memgate/gateway.test.ts` | — |
| mock-mode recall round trip through the hindsight client | in-scope | `tests/memgate/gateway.test.ts` | — |
| live-instance conformance on the VPS | out-of-scope here — the M1.1 acceptance-only edge; exercised by M2.3's combined live round | — | M2.3 |
| in-box `kg_recall` pi extension + roster grant + image re-pin | out-of-scope — M2.2 consumes the delivered key; its box files move deriveBuildId | — | M2.2 |
| dispatch-time recall / harvest-time retain wiring | out-of-scope — M1.2's host legs go direct per its own spec (INV-KG-2/INV-HM1); gateway consumers = in-box recall (M2.2), the M2.3 battery, M3.1's nightly job | — | M1.2 |
| compose service slot + Caddy allowlist route | out-of-scope — Z4's stack; this story ships the module + service contract | — | Z4 |
| manager banks + the schedule that uses agent tokens | out-of-scope — M3.1 | — | M3.1 |
| write-capable credentials of any kind | out-of-scope — forbidden by DD-16/F10/INV-7; writes stay host-side from harvested evidence | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|---|---|---|
| hindsight client (mock) | `src/hindsight/client.ts` | `bun test tests/hindsight/` green before this story starts |
| credential lifecycle (mirror source) | `src/providers/credentials.ts` (DF2.3-owned) | `bun test tests/providers/credentials.test.ts` green before and **byte-identical after** — a diff touching it is the signal the mirror was violated |
| M1.1 dedicated instance | Z4 compose on the VPS | **acceptance-only edge** — NOT required for dev or tests; its conformance leg is M2.3's |

> Not prerequisites: no VPS, no exedev box, no live Hindsight, no model spend, no Caddy route. The whole story is green on a laptop in mock mode — that is what "unit/mock tier" buys and why its dev sits in Wave 1.

## Technical Notes

- **Module layout:** `src/memgate/{index,gateway,ledger,schemas}.ts` — `gateway.ts` holds mint/verify/revoke + agent tokens + `runMemoryKeyLifecycle`; `ledger.ts` the issuance/revocation store; `schemas.ts` the zod scope/token schemas. Four files, flat, per the repo's convention.
- **Ledger:** bun:sqlite at `QDS_MEMGATE_LEDGER ?? ".sandbox/memgate-ledger.db"`, 0600 posture mirroring the run-record store; INSERT-only issuance + revocation rows. **Fail-closed:** a request that cannot read the ledger is refused (`ledger-unreadable`) — the `openAuditStoreForWalk` posture. No money in this ledger; **no `AUDIT_HOPS` change** — gateway events are log lines (the frozen ten-hop contract, INV-AUDIT-4, untouched).
- **Tokens:** HMAC-signed scope claims + ledger-backed revocation checked on every request (fail-closed); TTL checked at verify time; the signature key comes from env — never argv, never logged (`maskEnv` idiom). *(NET-NEW constants named for the register: `DEFAULT_KEY_TTL_BACKSTOP_MS`, `AGENT_TOKEN_VERBS`, `MEMGATE_ADMIN_KEY`, `QDS_MEMGATE_LEDGER`, delivery env `QDS_KG_RECALL_KEY`; `QDS_MEMGATE_SIGNING_KEY` is register-named via DD-28.4 — the HMAC signature key, an operator-rotated env value whose rotation fails agent tokens closed with no dual-key window, re-grant.)*
- **Published verb→route table:** `AGENT_TOKEN_VERBS` is closed AND each verb maps to exactly one bank-scoped REST operation class the gateway forwards; the table is the contract a grant is audited against, pinned to the instance's OpenAPI at impl time:

  | Verb | Gateway-forwards (bank-scoped REST, `/v1/default/banks/{bank_id}/…`) |
  |---|---|
  | `recall` | `POST …/memories/recall` (recall/search reads) |
  | `reflect` | `POST …/reflect` |
  | `consolidate` | `POST …/consolidate` |
  | `retain` | `POST …/memories` + `POST …/files/retain` (bank-write paths; host-held class only — never a box credential) |

  Any route outside the presented token's mapped set refuses with the `scope-verb` refusal token — the mapping is closed with the vocabulary (DD-28.26 item 1); mental-model management (`GET`/`POST …/mental-models`), config, transfer, and every other bank-scoped route are unmapped here and refuse by default until a register amendment maps them.
- **Driver-agnostic by construction:** the gateway speaks to principals, not drivers. M3.1's platform-schedule lane and its documented crontab fallback both present agent tokens to the same surface; nothing here imports fleet, exedev, or E21 vocabulary.
- **Region ownership:** `src/providers/credentials.ts` is DF2.3's and byte-identical after this story — the mirror is a spec, not a shared module; extracting a shared lifecycle abstraction is rejected (two consumers, different credential kinds, and refactoring DF2.3's merged surface buys nothing this story needs). `src/hindsight/` is consumed unchanged. No box image impact: nothing here enters `oci/exedev/Dockerfile`'s enumerated COPY set — no re-pin owed (the charter's "Dockerfile:277-305" cite is `oci/exedev/Dockerfile` ~:277-355; drift noted, the fact unchanged).
- **Considered and rejected: per-run keys living on the run record** (which already carries provider-key fields). Rejected: the gateway also serves agent tokens with no run at all, and reading runs-dir from a network-facing service widens its blast radius for nothing; the ledger stands alone under `.sandbox/`.

## Observability Contract

- Events: `memgate-mint | memgate-deliver | memgate-capture | memgate-revoke | memgate-verify-revoked | memgate-compensate | memgate-refused` — `memgate-refused` carries `reason ∈ {scope-bank, scope-verb, expired, revoked, no-auth, admin-auth, ledger-unreadable, mint-invalid-ttl}` (`no-auth` = request with no auth header — the 0.8.6 danger shape, ratified into the set by DD-28.26(13); the verify-time refusal pre-existed it, only the name is new); lifecycle lines carry the caller's `runId`, token lines its `tokenId`; every line carries `requestId`; durations `mint_ms`/`verify_ms` ride their own events.
- Key material, signature material, and admin keys appear in NO log line, NO argv, NO error message. A refusal reason names the failed CHECK, never the failed credential's contents. `ttlRemainingMs` is **absent, not `0`**, when TTL was not the refusing check.

## Files to Modify

- `src/memgate/index.ts` (new — barrel)
- `src/memgate/gateway.ts` (new — mint/verify/revoke, agent tokens, `runMemoryKeyLifecycle`)
- `src/memgate/ledger.ts` (new — issuance/revocation store, fail-closed reads)
- `src/memgate/schemas.ts` (new — zod key/token scope schemas, refusal reasons)
- `tests/memgate/gateway.test.ts` (new — scope enforcement, admin auth, agent tokens, mock round trip, plus the redaction probe: a minted sentinel key never appears in any emitted line)
- `tests/memgate/lifecycle.test.ts` (new — ordering, compensation on delivery failure, retry posture, TTL backstop)
- `src/providers/credentials.ts` (DF2.3-owned — **not modified**; listed to pin the byte-identity the mirror claims)
- `src/hindsight/client.ts` (consumed — **not modified**; the upstream the gateway fronts in both modes)

## Security Invariants

- **INV-MG-1 (recall-only in-box):** the per-run key's verb set is the literal `["recall"]`; no write verb executes under it; no write credential ever enters a box (DD-16; F10/INV-7 — writes are host-side from harvested evidence; sketch-M3's in-box write-back stays PARKED).
- **INV-MG-2 (revoke-verify-before-destroy):** the lifecycle's compensation runs revoke+verify BEFORE the delivery error rethrows; revocation is verified fail-closed (the `verifyRevoked` posture); a minted key never outlives a failed delivery — and a revoked key never verifies as alive.
- **INV-MG-3 (scope closure):** `{runId, bankAllowlist, ttlMs}` on every per-run key; banks + verb subset on every agent token — all enforced at verify time against the ledger; no wildcard grants exist in the vocabulary.
- **INV-MG-4 (one door):** the gateway is the only route by which anything beyond the box-host reaches the dedicated Hindsight instance — compose-side `hindsight-qds:8888` inside the stack, host-side origin `127.0.0.1:18890` env-carried (DD-28.22; 18889 is the TENANT instance's map and is never addressed); 8888/18889/18890 all stay never-publicly-routable (loopback binds, firewall stays 22/80/443); the Caddy route (Z4's config) exposes the gateway, never the store.
- **INV-MG-5 (credential hygiene):** admin + signature keys env-by-name, never argv (D8 / INV-CRED-3 lineage), never logged; token material never echoed.
- **INV-MG-6 (rotation + at-rest):** the ledger stores key/token digests and scope claims — never material, so no secret persists at rest. `MEMGATE_ADMIN_KEY` and `QDS_MEMGATE_SIGNING_KEY` are operator-rotated env values (rotate = env swap + service restart); per-run keys need no rotation (TTL + the lifecycle's revoke bound their whole existence); agent tokens carry no material, so a signature-key rotation fails their verification closed and the operator re-grants — the dual-key window is deliberately absent. Key material rides headers and the delivery env file, never a URL or query string.
- What these do not fence, said plainly: box egress is unfenced at the substrate (v5 architecture §6.3) — DD-16's "egress scoped to the gateway origin" is enforced by what the KEY can reach, not by a box firewall; agent tokens for Home-bot managers fall under E21's INV-1 regime once they cross into zeropoint.

## Definition of Done

- [ ] **Impl:** `src/memgate/` — lifecycle, scope enforcement, agent tokens, ledger, admin auth — with the five NET-NEW constants named in Technical Notes (AC1–AC7).
- [ ] **Test (make-or-break):** delivery-failure compensation — the revoke+verify events precede the rethrown original error and the key is verifiably dead afterward; the stranded-key shape MUST fail (AC1).
- [ ] **Test (scope):** a per-run key is refused on a non-allowlisted bank, on every write verb, past expiry, and after revocation; a retain under a per-run key is structurally impossible, not merely refused upstream (AC2).
- [ ] **Test (retry + backstop):** the mint POST attempts = 1; non-POST retries ≤2 stepped; TTL above the backstop refused pre-issuance (AC3, AC4).
- [ ] **Test (tokens):** a verb outside `AGENT_TOKEN_VERBS` is refused; a wildcard grant is impossible; every grant names its consumer class (AC5).
- [ ] **Contract:** `src/providers/credentials.ts` byte-identical; zero `AUDIT_HOPS` writes; no new audit hop (INV-MG-2; DF2.3's own fence).
- [ ] **Security:** admin ops refuse with missing/empty `MEMGATE_ADMIN_KEY` before any state change; no key/signature material in logs, argv, or error messages, proven by a sentinel-key redaction test (AC7, INV-MG-5/6).
- [ ] **Integration (e2e demo — MANDATORY):** the mock-mode closed loop — mint → deliver → scoped recall against the mock hindsight client → capture → revoke → verify — green with no network, no VPS, no box (unit/mock tier).
- [ ] **Integration (acceptance-only edge, recorded):** the completion note states the live-instance conformance leg is M2.3's and records the M1.1 edge as acceptance-only — never silently dropped.
- [ ] **Hygiene:** GitNexus `impact()` before shared-symbol edits; `detect_changes()` before commit (new module + tests expected).

## Dev Agent Record (2026-10-07, driver + 7-agent wave campaign on feature/m2-1-memory-gateway @ 9fe11a07)

**Prerequisites (driver-verified at story start):** `bun test tests/hindsight/ tests/providers/credentials.test.ts` → 283 pass / 0 fail; byte-identity baselines captured (credentials.ts `c9a81c04…`, client.ts `9fe27295…`) and re-verified green at branch gate (N4) — the mirror was consumed, never modified.

**Delivery:** `src/memgate/{schemas,forward,ledger,gateway,index}.ts` (475/121/431/500/72 lines at close — D6 split; counts at wave-t land were 340/375/497/72) + `tests/memgate/{lifecycle,gateway}.test.ts` (grown red-first from 19 + 31 to 38 + 47 tests — TDD-red proven against missing modules before implementation, both red proofs load-time `Cannot find module`, 0 pass / 1 fail / 1 error) + `scripts/dev/verify-m21-e2e.ts` (driver integration verifier, see D5). Suite totals 85/85 green; `bunx tsc --noEmit` 0 errors repo-wide; `bunx @biomejs/biome check src/memgate tests/memgate scripts/dev/verify-m21-e2e.ts` clean; mock-mode closed loop e2e (`M21 E2E OK`) covers mint → deliver (exactly the DD-28.23 pair, 0600) → verify → scoped recall through the mock client → capture state read → revoke → verify-refused → already-gone, plus scope-bank / scope-verb / unknown-key / no-auth / expired refusal arms and the TTL-backstop pre-issuance no-state-change assertion. Orchestrated under unlazy scope `m2-1` (PLAN rev 4, ledgers in `.unlazy/m2-1/gates/` — leaf-t, leaf-u, leaf-1 ALL MET with independent parent reverification; wave t = 2 parallel test leaves, wave s = 1 implementation leaf).

**Deviations (all register-noted; intent preserved):**
- **D1 (record step):** credentials' "record" pre-exists the lifecycle (store.get); memgate's record = the issuance row written at mint; lifecycle opens with assertDeliveryTargetSafe (target-before-mint-before-deliver preserved; the ledger-alone design story Technical Notes ratifies).
- **D2 (capture):** no money in this ledger — capture = the pre-revoke lifecycle state read + `memgate-capture` event; the captureSpend ordering slot preserved, spend content honestly absent (not zero-filled).
- **D3 (unknown credential vs the closed 8-member refusal set):** absent auth header → `no-auth` (exact DD-28.26(13) shape); present-but-invalid/unknown credential → refuses fail-closed with `no-auth` + structured log detail `authOutcome: "unknown-key"`; known-and-revoked still refuses `revoked`. ZERO set members added; the detail field gives M2.3's battery the known-key-out-of-scope vs unknown-key split AC2 demands. **Operator flag:** ratify the `authOutcome` detail convention at the register (DD-28.26(13) said the set gains "exactly one member" — this adds a field, not a member).
- **D4 (AC4 retry posture):** Hindsight 0.10.x has NO key-mint API (verified against the instance's own route class table — no /keys route exists), so memgate mint is gateway-LOCAL (HMAC + ledger): "mint POST attempts = 1" is structurally exceeded (ZERO network attempts — the stranded-second-key hazard cannot exist). The posture lands where transport exists: each mapped POST forwards exactly once via the injected HindsightClient (`src/hindsight/client.ts:504-506` "no retries anywhere: a replayed retain is not idempotent" — identical rationale to credentials :1762-1766), and the closed route table maps no non-POST route, so the ≤2-stepped helper has no call site and was not shipped. Tests: mint zero-network (count 0), forward-once (count 1), closed-table POST-only structural assert.
- **D5 (write set):** + `scripts/dev/verify-m21-e2e.ts` (driver-authored; the DoD's mandatory e2e demo, M1.3 committed-verifier precedent). leakScan/at helpers duplicated inline in both test files rather than adding a shared fixtures file.
- **D-vocab (load-bearing register reading, driver ruling):** DD-28.26 item 1's two agent grant classes are EXHAUSTIVE — host-held {reflect, retain}, bot-held {consolidate}. `recall` stays in the closed `AGENT_TOKEN_VERBS` vocabulary (the AC5 negative control stays well-defined; the register-amendment hook is preserved) but NO agent grant class carries it — only per-run keys recall. Grant-time typed refusals: grant-verb-outside-vocabulary / grant-verb-outside-class / grant-consumer-class-required (admin surface, not the closed request-path set). **Operator flag:** if Z3's memory legs ever need agent-recall, that is a register amendment (item 1 as written does not grant it).
- **AC7 correction (driver, wave-s ruling):** `revokeRunMemoryKey` is admin-gated (timing-safe presented-vs-configured compare, `admin-auth` refusal) — AC7's letter names "mint, revoke, agent-token grant/list/revoke".
- **Admin-key seam (wave-t pin):** `memgateDeps(opts)` reads `MEMGATE_ADMIN_KEY` + `QDS_MEMGATE_SIGNING_KEY` env-by-name and refuses BEFORE any ledger open; `deps.adminKey` is the presented key for the call context; configured key read from `deps.env` at op time. No-env wiring = embedded/test mode (presented IS configured) — documented seam, never the prod wiring.

**Wave-t mechanical fixes (driver, leases released — each intent-preserving, none weakens an assertion):** makeClient record-then-delegate wrap (bare spread shadowed the call recorder); no-wildcard assert substring→membership ("recall" contains "all"); sentinels re-prefixed `mgx-` (collided with mandated `memgate-*` event values); two `toEqual`/`toBe` type-param fixes; third-kind `@ts-expect-error` moved to the excess-property line; two MemgateError fixture calls gained the remediation arg (the impl's `(code, message, remediation)` is the ProviderError pattern of record); one no-interpolation template literal → plain string (biome).

**Hygiene receipts:** GitNexus `detect_changes(compare vs dev)` at branch gate: risk LOW, 0 affected processes, 9 changed files — exactly the M2.1 write set + the M1.3 story-record addendum; zero pre-existing symbols touched (greenfield — no `impact()` call owed). GitNexus reindex this session hit an upstream 1.6.9 embedding-pipeline duplicate-PK bug twice (fresh DB after `clean`); worked around with a no-embeddings reindex (25,085 nodes / 51,602 edges @ branch point) behind the canonical script's lock + transient `.gitnexusignore` — **operator flag:** consider filing upstream. **Register note (F-027, review round 1):** `memgate-compensation-failed` and `memgate-grant` are ADDITIVE observability events on top of the story's 7-event list (compensation-failed mirrors credentials' own delivery_compensation error line; grant mirrors the other lifecycle ops); `memgate-forward` remains covered by the rev-3(d) adjudication, and its error line reuses the same name with status "error" — no additional event name. **Register note (D6, review round 2):** module layout is FIVE flat files, not the Technical Notes' four — round-2 hardening pushed schemas.ts past the repo's 500-line pin, so the cohesive forward surface (`VERB_ROUTES`, `bankOfPath`, `matchRoute`, `MAX_RETAIN_CONTENT_CHARS`, `ForwardArgs`, `parseForwardBody`) split into `src/memgate/forward.ts`; `schemas.ts` re-exports every moved symbol verbatim (consumer imports unchanged); five files, each ≤500 lines.

**Integration acceptance edge (recorded, never silently dropped):** the live-instance conformance leg belongs to **M2.3's combined live round**; the M1.1 dependency edge is **acceptance-only** (dev-first sanctioned, DD-26) — this story is unit/mock tier and needed no VPS, no box, no live Hindsight, no spend. Every green gate above ran on a laptop in mock mode.

**Operator flags (all surfaced, none blocking):** D3 `authOutcome` register ratification; D-vocab Z3 agent-recall amendment hook; M3.1's prerequisite names `bun test tests/memory/` where this story ships `tests/memgate/` (naming mismatch already on record from derivation — M2.2's prereq uses the matching name); GitNexus 1.6.9 embedding dedup bug.

### Review Findings (round 1 — 3-layer adversarial: blind 20 / edge 15 / acceptance 5 → 31 unified: 28 patch, 1 defer, 2 dismiss)

- [x] [Review][Patch] F-001 Compensation bracket: throwing sink on compensate-emit skips revocation; compensation-failed emit throw replaces original error [src/memgate/gateway.ts]
- [x] [Review][Patch] F-002 Post-delivery faults (capture/revoke/verify) have no compensation bracket — stranded live delivered key [src/memgate/gateway.ts]
- [x] [Review][Patch] F-003 Post-state-write emits unguarded (mint/capture/revoke/verify-revoked/grant) — throwing sink strands rows/masks results [src/memgate/gateway.ts]
- [x] [Review][Patch] F-004 forwardScoped never rechecks revocation/expiry — verify→forward TOCTOU [src/memgate/gateway.ts]
- [x] [Review][Patch] F-005 listAgentTokens returns revoked tokens ("live" docstring) + one corrupt row aborts listing [src/memgate/gateway.ts]
- [x] [Review][Patch] F-006 Agent tokens immortal — optional admin-supplied expiresAtMs honored at verify [src/memgate/schemas.ts]
- [x] [Review][Patch] F-007 deliverRunKey bypasses assertDeliveryTargetSafe — gate at the write choke point [src/memgate/gateway.ts]
- [x] [Review][Patch] F-008 Env injection via unvalidated gatewayUrl/keyMaterial + missing mgrun- prefix barrier (AC6) [src/memgate/gateway.ts]
- [x] [Review][Patch] F-009 memgateDeps ignores opts.env for ledger resolution — stray-default-open at the seam [src/memgate/gateway.ts]
- [x] [Review][Patch] F-010 Non-string method/path crashes verifyRequest (raw TypeError, not refusal) [src/memgate/gateway.ts]
- [x] [Review][Patch] F-011 Double-revoke race mislabels UNIQUE constraint as ledger-unwritable (→ already-gone) [src/memgate/ledger.ts]
- [x] [Review][Patch] F-012 openReadOnly post-attach inode recheck missing — swap window [src/memgate/ledger.ts]
- [x] [Review][Patch] F-013 Claims shape not re-validated at verify — corrupt verbs row verifies [src/memgate/gateway.ts]
- [x] [Review][Patch] F-014 memgate-refused carries out-of-set reason values (mint-invalid-scope/env-file-invalid/grant-*) — event reason stays closed [src/memgate/gateway.ts]
- [x] [Review][Patch] F-015 Verifier discards forwardScoped promise — unhandled rejection can fake OK [scripts/dev/verify-m21-e2e.ts]
- [x] [Review][Patch] F-016 ttlRemainingMs 0 at exact boundary violates absent-not-0 pin [src/memgate/gateway.ts]
- [x] [Review][Patch] F-017 Empty-string signing/admin keys pass undefined-only checks (forgeable HMAC) [src/memgate/gateway.ts]
- [x] [Review][Patch] F-018 NaN now() mints immortal key [src/memgate/gateway.ts]
- [x] [Review][Patch] F-019 runId unbounded length/charset persisted+logged [src/memgate/gateway.ts]
- [x] [Review][Patch] F-020 Ledger ctor raw fs errors escape closed set (statSync/exclusive-create unguarded) [src/memgate/ledger.ts]
- [x] [Review][Patch] F-021 Failed writable open leaves empty 0600 file behind [src/memgate/ledger.ts]
- [x] [Review][Patch] F-022 recordRevocation clock not injectable (Date.now) [src/memgate/ledger.ts]
- [x] [Review][Patch] F-023 Forward bodies unvalidated (NaN limit, unbounded content, coerced queries) [src/memgate/gateway.ts]
- [x] [Review][Patch] F-024 Forward transport failures emit no memgate-* event [src/memgate/gateway.ts]
- [x] [Review][Patch] F-025 Grant name never persisted; MEMGATE_ENV_FILE unconsumed [src/memgate/schemas.ts]
- [x] [Review][Patch] F-026 revokeAgentToken revokes per-run tokens — no kind check [src/memgate/gateway.ts]
- [x] [Review][Patch] F-027 memgate-compensation-failed/memgate-grant event names unregistered (register note) [src/memgate/gateway.ts]
- [x] [Review][Patch] F-028 Delivery-target remediation text contradicts relative-path discipline [src/memgate/gateway.ts]
- [x] [Review][Defer] F-029 Delivered env file retains revoked key material post-lifecycle — teardown ownership (DF2.5 lineage), outside module surface [src/memgate/gateway.ts] — deferred

### Review Findings (round 2 — 3-layer fresh pass incl. fix-regression hunt: 21 unified, all PATCH; round-1 fixes audited CONFORMANT)

- [x] [Review][Patch] R2-F-001 mgrun- barrier prefix-only — keyMaterial charset gate (base64url) at the choke point [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-002 requireAdmin self-comparison fail-open on unwired env — explicit embedded-mode flag; hand-built deps fail closed [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-003 deliver-state-write-failed carries no tokenId — attach the compensation handle to the thrown error [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-004 Verifier TTL arm swallows wrong error class — assert mint-invalid-ttl [scripts/dev/verify-m21-e2e.ts]
- [x] [Review][Patch] R2-F-005 Retain ceiling bypasses non-string content — refuse forward-body-invalid [src/memgate/schemas.ts]
- [x] [Review][Patch] R2-F-006 Invalid limit coerced to undefined — throw like the sibling query arm [src/memgate/schemas.ts]
- [x] [Review][Patch] R2-F-007 Non-finite clock bypasses verify/forward expiry — fail-closed, ttlRemainingMs absent [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-008 Verifier refusal arms never assert the typed reason [scripts/dev/verify-m21-e2e.ts]
- [x] [Review][Patch] R2-F-009 recordIssuance UNIQUE collision mislabeled ledger-unwritable [src/memgate/ledger.ts]
- [x] [Review][Patch] R2-F-010 Grant accepts born-expired expiresAtMs — compare against now [src/memgate/schemas.ts]
- [x] [Review][Patch] R2-F-011 F-021 cleanup check-then-act — rm only own zero-row skeleton [src/memgate/ledger.ts]
- [x] [Review][Patch] R2-F-012 O_EXCL refusal leaks the probe fd [src/memgate/ledger.ts]
- [x] [Review][Patch] R2-F-013 Corrupt claims (non-object) rides the D3 unknown-key ladder with tokenId, not ledger-unreadable [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-014 forwardScoped client-missing/body-invalid/ledger-recheck arms emit no audit line [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-015 revokeRunMemoryKey drops runId from its emit lines [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-016 listAgentTokens prefers claims.tokenId over the row PK [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-017 Unbounded banks arrays — .max(64) [src/memgate/schemas.ts]
- [x] [Review][Patch] R2-F-018 gateway.test deps() leaks sqlite handles — afterEach close [tests/memgate/gateway.test.ts]
- [x] [Review][Patch] R2-F-019 Dir-mode refusal rewrapped as delivery-failed — hoist config assert [src/memgate/gateway.ts]
- [x] [Review][Patch] R2-F-020 10 round-1 fixes lack named regression pins — test wave adds honest pins [tests/memgate/**]
- [x] [Review][Patch] R2-F-021 Story record line counts stale — update at wave close [story record]

### Review Findings (round 3 — final verification: 11 unified, 1 dismissed-resolved-in-round, 10 PATCH)

- [x] [Review][Patch] R3-F-002 Per-run expiry from validated claims, column cross-checked, divergence fail-closed (+ forward re-check) [src/memgate/gateway.ts]
- [x] [Review][Patch] R3-F-003 parseForwardBody refuses non-object bodies — no silent body-less widening [src/memgate/forward.ts]
- [x] [Review][Patch] R3-F-004 consolidate options validated (field types + size ceiling) [src/memgate/forward.ts]
- [x] [Review][Patch] R3-F-005 retain metadata validated (object-ness + size ceiling) [src/memgate/forward.ts]
- [x] [Review][Patch] R3-F-006 revokeRunMemoryKey kind-gates agent rows (revoke-kind-mismatch) — symmetric with F-026 [src/memgate/gateway.ts]
- [x] [Review][Patch] R3-F-007 listAgentTokens surfaces expiresAtMs + name [src/memgate/gateway.ts]
- [x] [Review][Patch] R3-F-008 Barrel exports MEMGATE_ENV_FILE [src/memgate/index.ts]
- [x] [Review][Patch] R3-F-009 Verifier tmpdir cleaned on every exit path [scripts/dev/verify-m21-e2e.ts]
- [x] [Review][Patch] R3-F-010 grantAgentToken finite-clock guard pre-state [src/memgate/gateway.ts]
- [x] [Review][Patch] R3-F-011 bankOfPath/matchRoute grammar-agreement pin [tests/memgate/gateway.test.ts]
- [x] [Review][Patch] R3-F-001 forward.ts missing from review patch — RESOLVED in-round (staged; reviewed from working tree) — dismissed

### Review Findings (round 5 — CodeRabbit PR review: 2 findings, 1 patch, 1 partial with pushback)

- [x] [Review][Patch] CR-2 runMemoryKeyLifecycle delivers then immediately revokes — no usable live-key window; added optional `run` callback input (invoked after delivery, BEFORE capture/revoke; a fault compensates THEN rethrows the ORIGINAL per INV-MG-2; the window emits nothing so AC1's exact event sequence is untouched; the key is consumed by reading `target`, so mint's return stays the only plaintext handoff) + 2 tests (live-window verify-OK/revoked-after, run-fault compensation) [src/memgate/{schemas,gateway}.ts tests/memgate/lifecycle.test.ts]
- [x] [Review][Patch] CR-1 deliverRunKey delivery boundary — PARTIAL: accepted the boundary ambiguity the finding exposes and fixed the misleading doc (MEMGATE_ENV_FILE's comment claimed the driver-exec-HOME rationale the M2.1 write path does not exercise; now states the write is process-LOCAL and the box-routed leg is M2.2's driver-fill seam, with the target grammar already box-shaped so M2.2 re-points the write, not the input). PUSHBACK on routing the write through the driver's fill primitive now: the ratified M2.1 surface is driver-agnostic mock-mode delivery (no driver dep, no vm handle in the inputs, story ships no box file — M2.2 owns the in-box side), and the CWD-relative default is test-pinned F-025 behavior; a driver seam is a spec-level design change, not a review patch. PUSHBACK on removing the parent 0700 enforcement: forcing the key-file parent to 0700 is the repo-wide fs-atomic contract (INV-5; run-record/fanout/fleet-lock/the ledger all share it) and is the containment guard working, not a hazard. [src/memgate/{schemas,gateway}.ts]
