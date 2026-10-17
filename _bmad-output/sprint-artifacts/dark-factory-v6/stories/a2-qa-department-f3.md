# A2: QA Department F3 — Post-Merge Hunter-Pack Priming the Next Dev Run

**Story Points:** 5
**Sprint:** v6b-Autonomy (E21-gated; the QA *department manager* as a Home bot — a manager, not a proactive/cron agent)
**Status:** done — factory PR #436 merged to dev 2026-10-17 (merge d061869a) after CodeRabbit review — 3 inline findings verified and fixed (100684e2: full `qds-<repo>` BankIdSchema identity guard on `retainFindings`; UTF-16-bounded surrogate-safe summary trim + full system-message tool-state replay in the vendored pi-1.1.0 harness; 8d43f018: typecheck.sh release pick filters for `dist/` so an incomplete newest release cannot block an older usable one) — and the counterpart swarmclaw PR #801 merged 2026-10-17 (merge 9603c0f0, CodeRabbit full review). 2 pre-PR bmad review rounds (R1 ~35 / R2 ~24 findings; 35 fixed, 5 declined with rulings, stop rule met). Live Tier-2 round = Z2's post-merge trigger on the merged commit, evidence pinned to `_bmad-output/evidence/v6-a2/` (D7). All gates cleared: **E21 S02b** (bots as profiles + turn principal) and **E21 S03b** (Home provider wiring) merged to fork `origin/dev`; predecessors **A1** (manager bot substrate, PR #434), **M1.2** (host-side retain/recall cycle), **Z2** (fork-side post-merge trigger wiring) all done. **No documented crontab fallback exists for this story — by design, keep it that way.** M3.1's fallback works because the M3 gateway is driver-agnostic; A2's actor is a bot turn — a cron substituting for it would be a second, un-chartered write path into the turn system. F3 is event-shaped: Z2's post-merge trigger is THE trigger; a missed-wake sweeper (driver-agnostic, commitSha-deduped reconciliation scan) is a SEPARATE story to charter, never something a dev session improvises here. If E21 slips, A2 waits — fail-closed is correct.

## Spec Reference

- **F3 vision, verbatim** (`_bmad-output/planning-artifacts/prd-qds-factory-v4.md:111`, via R1 extraction): "A Paperclip event wakes the **Hermes QA manager**, which drives an **Archon** hunter-pack sub-DAG of **Pi** agents (orthogonal lenses, **pi-lens**-driven); findings become **Paperclip issues** + a shared per-repo **Hindsight** bank entry that primes the next Dev implement." Ancestry disposition: the v4 nouns die (Paperclip event → Z2's fork-side post-merge trigger; Archon sub-DAG → a swarmclaw protocol; Paperclip issues → host-side GitHub issues; Pi agents → fleet runs); the four-step shape survives **verbatim**: wake on merge → hunter-pack → findings → shared-bank entry that primes the next Dev implement.
- Charter: D-3 (24/7 agents as E21 Home bots), A2 table row (`2026-10-01-v6-derivation-session-INPUT.md:94`), §5.2 spec-seam fixtures, §5.6 live-round rules, §6 guardrails, DD-20 (bot-spend join keys `workKey + runId + botId`).
- ADR-1 (`docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md`): clause 1 (macro process = protocol whose consequential steps are `external_job`), clause 2 (fleet = only code-entry path), clause 3/4 (gate untouched; auto-approve explicitly out of scope), accepted gap #380 (headless `workId` briefs not booking spend — the `w:` namespace is sanctioned; the booking gap is open).
- Sibling contracts consumed unmodified: A1's bot substrate (no second refusal vocabulary); M1.2's idempotent host-side retain (stable dated `documentId`, `updateMode:"replace"`) and its dispatch-time recall; Z2's post-merge trigger + `factory_observe` step kind; `ProtocolExternalJobConfig` at `fork:src/types/protocol.ts:148` (`issueId XOR workId` — A2 uses the `workId` leg).

## User Story

As the operator, I want a merged PR to wake a QA department manager (Home bot) that drives an orthogonal-lens hunter-pack as real fleet runs, so that findings land as host-side GitHub issues plus a shared-bank entry that primes the NEXT Dev run — closing the F3 loop with humans and gates exactly where they are today.

## Overview

Factory scope: the host-side legs (findings normalization, idempotent retain, issue filing), `w:qa-*` workKey stamping on run records, and the spec-seam fixtures that keep factory CI green with zero E21 code. The protocol definition and trigger config are zeropoint-side work filed in the solstice repo from this same contract text (BUILD-IN-FORK per charter §5.5); factory points cover factory-repo work plus the joint live round.
**What this does NOT deliver:** no in-box `kg_recall` during QA runs (M2.2's lane — the QA box carries no memory key; provider secret only, Deviation 2); no schedule→protocol trigger (Z2's schedule leg / A3); no auto-applied fixes and no approval-gate traffic (A2's outputs are issues + bank entries, nothing else). If G1's verdict accepts ADR-2 clause 2, a2 additionally emits the structured verdict per G1 AC4 — adds-only to this story's contract.

## E2E Slice

**Demonstrable behavior:** Given a fleet-run PR merges on the watched repo, Z2's post-merge trigger fires and the QA manager bot turns (recorded initiator = operator, per S02b INV-8/`TURN_REFUSALS`). The protocol submits its hunter-pack legs, each an `external_job` step with `workId: "w:qa-<utcstamp>-<lens>"` and complete `ProtocolExternalJobConfig` (repoSlug, repoUrl, commitSha 40-hex, manifestPath, groupCapUsd, pollTimeoutMs default 1h). Each leg is a real fleet run — exit 0 on success, 6 = work landed/cleanup failed — with its own run record. The host normalizes harvest output to findings `{runId, lens, finding_text, diff_context_ref}`, retains them idempotently into the shared `qds-<repo>` bank (metadata `kind:"observation"`, tags `qa-f3`, runId, lens), and files actionable findings as host-side GitHub issues. The NEXT Dev dispatch's recall surfaces ≥1 retained finding inside `<kg_context>`.

**Wiring closed:** On completion of this story, merged-commit → QA manager turn → hunter-pack fleet runs → findings → shared-bank retain + issues → next-Dev priming works end-to-end using only code merged by this story plus A1, M1.2, and Z2 (and the fork-side counterpart story at its pinned rev). **No stub, no `TODO: wire later`.** The **schedule→protocol** trigger and **in-box recall** are out of scope by construction (Z2 and M2.2 own them).

**Dependency edges (predecessors):** **A1** is a direct edge (the bot substrate this manager runs on). **M1.2** is a direct edge (the retain pattern AND the dispatch-recall consumer — both halves of the priming loop). **Z2** is a direct edge (the post-merge trigger consumed here). E21 S02b + S03b are gate lanes inherited through A1's gate (R5 classification; named in this story's Status block because the charter row names them). **Not an edge — M2.1:** the QA box needs no recall-only memory key; priming is host-side dispatch recall (M1.2), not in-box. **Not an edge — M2.2/M2.3:** those prove the in-box lane; this story's priming claim is provable without it. **Not an edge — A3:** sweeps park briefs at `fleet approve`; A2 parks nothing there.

## Acceptance Criteria

1. **(make-or-break)** Given a merged fleet-run PR, when Z2's post-merge trigger fires, then the QA manager bot turns and starts a protocol whose consequential steps are all `external_job` steps carrying `workId` in the `w:qa-*` namespace, and nothing executes a code change outside a fleet run. *Negative controls, all MUST fail: an implementation firing on a non-merge signal (PR-open, CI-start, heartbeat) violates F3's "post-merge" clause; a protocol step that edits files or merges on the host violates ADR-1 clause 2; an implementation synthesizing a numeric `issueId` to route around the `workId` leg conflates the two namespaces (Deviation 1).*
2. Given the hunter-pack runs, then each lens is its own fleet run with its own run record, and every finding is attributable to `(runId, lens)` in the normalized payload. *Negative control: an implementation running all lenses in one merged prompt behind a single run record leaves findings unattributable and MUST fail this one.*
3. Given a leg's harvest lands, then the host retains findings into the shared `qds-<repo>` bank via M1.2's idempotent retain (stable dated `documentId`, `updateMode:"replace"`) — running the retain leg twice on the same harvest leaves one memory, not two — and the next Dev dispatch's recall returns it. *Negative controls, both MUST fail: findings retained from inside a box, or via any write credential in a box (F10/INV-7, DD-16); findings retained into a bank the next Dev dispatch's recall does not read — priming is the point of F3's "shared … bank entry".*
4. Given findings classified actionable, then GitHub issues are filed host-side, the token piped on stdin per the Linux path (`src/pr/github.ts:252-284` posture), never argv/env/box. *Negative control: an implementation filing issues from a box step, or placing a GitHub token in box env, MUST fail this one.*
5. Given no E21 code is merged, factory CI runs the full trigger→turn→legs→retain→issue path against a **fake Home-bot/gateway journal** extending the SC2 fake-CLI-journal pattern, honoring S02b's seams exactly: `TURN_REFUSALS = ['initiator_missing', 'initiator_mismatch', 'no_owner']` as the only refusal vocabulary (CON2-20), `isHomeBackedAgent` as the S02b-owned symbol, and the four `SOLSTICE_*_TOKEN` names per S03b. *Negative control: a fixture inventing a second refusal vocabulary, or asserting an E21 field the spec does not pin, MUST fail this one — the fixture encodes only what E21's spec text commits to.*
6. Given a leg submits, then its `w:qa-*` workKey is stamped on the fleet run record (adds-only field) and leg spend is booked by the normal fleet-run machinery (per-runId cost ledger + `run-cost` audit hop). *Negative control: an implementation claiming macro-side per-workKey spend aggregation inside this story MUST fail — that surface is DD-20's (A1/A5) and #380 stays open here (Deviation 1).*
7. Given the round completes, then A2 has emitted no approval-requiring artifact: no fix PR, no merge, nothing parked at `fleet approve`. *Negative control: an implementation where a QA finding auto-applies as a code change MUST fail — that is A3's human-gated shape, and ADR-2 (PROPOSED, G1) decides nothing — a proposal is not a license.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Post-merge (fleet-run PR merged on watched repo) | in-scope — fires via Z2's wiring | live round | none in v6.0 |
| QA manager heartbeat digest | out-of-scope — A1's duty | — | A1 |
| Schedule→protocol (cron-class) trigger | out-of-scope — Z2's schedule leg / A3 | — | A3 |
| In-box `kg_recall` during a QA run | out-of-scope — M2.2's lane | — | M2.2 |
| QA findings auto-applied as fixes | out-of-scope — ADR-2 PROPOSED (G1), consumed by nothing pre-verdict; A3 is the v6 boundary | — | G1 |
| Operator manually firing the protocol | out-of-scope — none in v6.0 | — | none |

## Infra Prerequisites

| Component | Service | Lifecycle Hook Verified |
| --- | --- | --- |
| A1 manager substrate | factory Home bot profile (E21) | A1's fake-journal suite green before this story starts |
| M1.2 retain/recall | host-side cycle over dedicated Hindsight | M1.2 suites green; consumed read-only, byte-identical after |
| Z2 trigger + `factory_observe` | fork-side wiring at pinned rev | Z2 fake-CLI-journal suite green before start |
| Dedicated Hindsight + `qds-` banks | M1.1 stack (live round only) | round-trip verifier green; re-checked before fire |
| E21 S02b + S03b + fork-rev pin bump | fork `origin/dev` (live round only) | pin bump recorded at this evidence round per charter §5.3 |

> Not prerequisites at fixture tier: no box, no LLM spend, no VPS, no E21 code. The live round needs a real exedev box (standard dispatch) and the M1.1 memory stack. **Pin consequence (DD-28.26(4), mirrors M1.2):** `run-record.ts` is a COPY-set file (`oci/exedev/Dockerfile` COPY enum ~:315); the `workKey` edit moves the pin; the wave-0 re-pin ritual must re-run on a tree containing this story [M1.2 + J3 + J4 + A2] before the live round.

## Technical Notes

- **One wake, one protocol.** The post-merge trigger starts exactly one protocol run per merged commitSha; a re-fire for the same commitSha is refused (idempotent start — the same discipline `fleet run`'s earned exit-1 idempotence uses, not a new mechanism).
- **Hunter-pack shape (named, not implied):** lenses are a code constant `QA_LENS = ["correctness", "secret-hygiene", "diff-scope"]` with `MAX_QA_LEGS = 4` (headroom for one added lens without a config surface — thresholds-in-code doctrine). Per-leg `groupCapUsd` derives from existing dispatch admission; no new budget primitive.
- **Deviation 1 (binding — the #380 disposition).** ADR-1's accepted gap: headless `workId` briefs do not book spend macro-side. **A2 does not close that gap and does not rely on it being closed:** leg spend is booked factory-side per runId (cost ledger + `run-cost` hop — machinery every fleet run already has); the `w:qa-*` workKey rides the brief and the run record so DD-20's join (`workKey + runId + botId`) needs no schema change later. Macro-side per-workKey aggregation is DD-20/A5's surface.
- **Deviation 2 (binding — DD-16 scope note).** The DD-16 amended per-box credential set applies where in-box recall lands (M2.2+). QA boxes here carry the original single provider secret; no memory key is minted for them.
- **Contracts/Schema — run record:** one adds-only field `workKey: string`, registered by this story; no existing field's semantics change; `src/fleet/verbs.ts` untouched (no new verbs); `AUDIT_HOPS` untouched (frozen — `run-cost` already carries leg spend; the `memory-retain-receipt` hop is untouched *here* — M1.2 already activated it, A2 adds no hop). QA-findings retains EMIT `memory-retain-receipt`/retain rows — the vocabulary is already open post-M1.2, zero schema change, free dedup/tamper alarm.
- **Ordering against A1:** the trigger wakes the QA bot directly; it does not pass through A1's heartbeat digest, so a digest backlog never delays a QA round. Durability note: fork-side wake durability comes from the persisted schedule/trigger store — `enqueueSystemEvent` is an in-memory queue (R4 finding) and MUST NOT be the trigger's durability carrier.
- **Considered and rejected: driving the hunter-pack as one host-side `fanout`.** Rejected because ADR-1 clause 1 puts process state (scheduling, branching, notification) in the protocol, and because per-leg run records are what finding attribution and the DD-20 join consume. Revisit only with a new D-number.

## Observability Contract

- Log vocabulary: `qa-protocol-start{commitSha, protocolRunId}`, `qa-leg-submitted{workId, runId}`, `qa-leg-terminal{runId, exitCode}`, `qa-findings-retained{bankId, documentIds}`, `qa-issues-filed{count}`. Absent-not-0: count/array fields are absent when the leg did not run; `0` only when it ran and found/filed none.
- No new audit hop; volatile fields (finding text) ride logs, never digest-stable store rows.

## Files to Modify

- `src/qa/findings.ts` — new (findings schema + harvest-output normalizer)
- `src/qa/retain.ts` — new (idempotent host-side retain, M1.2 pattern, over `src/hindsight/client.ts` unmodified)
- `src/qa/issues.ts` — new (host-side GitHub issue filing)
- `src/qa/index.ts` — new (barrel)
- `src/providers/run-record.ts` — adds only (`workKey` field; provider-layer import rules respected)
- `tests/qa/fake-home-journal.ts` — new (spec-seam fixture extending the fake-CLI-journal pattern)
- `tests/qa/hunter-pack.test.ts` — new (fixture-tier ACs incl. negative controls)
- `tests/qa/qa-f3-round.live.test.ts` — new (**Tier 2** — `*.live.test.ts` no-fakes, flat per house convention; tier selection drives real box + bot-turn spend; pins `QDS_E2E_EVIDENCE_DIR` to `_bmad-output/evidence/v6-a2/` — the live-harness default is `df3-e2e`) — plus its leg-evidence writer (mirroring Z3's leg drivers: each leg JSON — `swarmclawForkRev`-stamped — written by this story's own driver, since `live-harness.ts` stamps nothing per Z1 AC7)
- `_bmad-output/evidence/v6-a2/` — new (committed scrubbed evidence; `QDS_E2E_EVIDENCE_DIR` pinned here for the live round)
- Counterpart (solstice repo, not a factory file): QA protocol definition + post-merge trigger config, BUILD-IN-FORK, same contract text.

## Security Invariants

- **INV-A2-1 (ADR-1 §2):** fleet is the only code-entry path; hunter-pack legs are fleet runs; nothing in the protocol or the host legs mutates code.
- **INV-A2-2 (F10/INV-7/DD-16):** no write credential ever enters a box; retain and issue filing are host-side, from harvested evidence.
- **INV-A2-3 (ADR-1 §3):** the approval gate is untouched — not exercised, not re-channelled; ADR-2 stays PROPOSED (the operator decides via G1).
- **INV-A2-4:** `AUDIT_HOPS` frozen; no new hop; `run-cost` already carries leg spend.
- **INV-A2-5:** GitHub token stdin-piped host-side; never argv, env, or box.
- **INV-A2-6:** explicit `qds-` bank ids every call; never the `solstice-*` families; 8888/18889 never exposed.

## Definition of Done

- [x] **Impl:** `src/qa/` legs + run-record `workKey` stamp; tsc/biome clean.
- [x] **Test (fixture):** fake Home-bot/gateway journal suite green with zero E21 code present; factory CI green.
- [x] **Contract:** `workKey` adds-only; `detect_changes()` shows 0 unexpected affected symbols.
- [x] **Security:** AC3/AC4/AC7 negative controls demonstrated failing at fixture tier.
- [x] **Integration:** live Tier-2 round — worst-case spend printed, operator GO recorded, keys/boxes cleaned in `finally`, evidence scrubbed to `_bmad-output/evidence/v6-a2/` (`QDS_E2E_EVIDENCE_DIR` pinned there — live-harness defaults to `df3-e2e`); every evidence JSON stamps `swarmclawForkRev` (Z1's drift alarm covers `v6-a2/`) — the stamp is written by this story's own leg-evidence writer (mirroring Z3's leg drivers; `live-harness.ts` stays un-stamping per Z1 AC7, so the pinning requirement lives in the file this story adds to Files to Modify, not in live-harness); priming round-trip proven (next Dev dispatch `<kg_context>` contains a retained finding).
- [x] **Test (e2e demo — MANDATORY):** the live round is the demo; the fixture tier additionally demos the full trigger→retain→issue path headlessly.
- [x] **Integration:** counterpart fork-side story filed in the solstice repo from the same contract text.
- [x] **Contract:** sprint-status v6 row + epics index updated; `bun test tests/scripts/story-consistency.test.ts` green.

## Dev Agent Record

### Settlement rulings (binding on this story's implementation)

- **D1 — ADR-2 ACCEPTED, verdict emission in-scope (adds-only).** G1 recorded the operator verdict 2026-10-15 (PR #430); the story Overview's "If G1's verdict accepts" condition fired. A2 = the structured-verdict producer per G1 AC4: consumed shape = `QaVerdictSchema` (`src/fleet/auto-merge-policy.ts`), provenance extras added by A2, audit trail = the producing QA run's record (qaVerdict namespace; no new hop). The story text saying "PROPOSED" is stale on this one point.
- **D2 — Files beyond the story's Files-to-Modify (all adds-only):** `src/fleet/result.ts` (ResultPayload.verdict fold), `tests/fleet/q1-contract.test.ts` (verdict-optional pin), `tests/fleet/observe-contract.ts` (RESULT_OPTIONAL sync), `tests/providers/run-record-qa-workkey.test.ts` (new; file-per-leaf ownership), `tests/scripts/build-exedev-image.test.ts` (tracked-inputs digest adopt, D9). Sanctioned by the unlazy contract (PLAN C8/C15) — factory CI needs these files green with the adds-only seams.
- **D3 — workId vs assertNoSecret:** the contract workId `w:qa-<utcstamp>-<lens>` (≥40 mixed-class) crosses run-record's key-material heuristic; `SHAPE_EXEMPT_PATHS` gains `extPath("qaWorkKey","workKey")` (house pattern: repoSlug/issueId precedents). The prefix scan and ≤201 grammar bound stay live (regression-tested both directions).
- **D4 — Issue filing over REST, not a spawned gh.** `gh` authenticates via GH_TOKEN env or its keyring, never stdin — the original gh-spawn-with-stdin-token path was dead in production (3 review layers concurred). AC4's "stdin posture" = `readHostToken`'s READ posture (keychain → piped stdin into the host process); filing goes through `GitHubApi.createIssue` (Bearer header in-process, no env, no child, no argv body). github.ts gained `createIssue` adds-only (+20/−0).
- **D5 — escalated types across the three seams.** Producer validates boolean; the store pins int; the fold must fail closed. `qaVerdictPatch` is the ONE writer seam (boolean → 1/0); `foldQaVerdict` treats any non-false/non-zero value as escalated=true (consumer doctrine), skips prototype keys; null/status-less blocks fold to NO verdict key on both read seams (presence parity).
- **D6 — Log vocabulary split.** Factory emits `qa-findings-retained` + `qa-issues-filed` host-side; `qa-protocol-start` / `qa-leg-submitted` / `qa-leg-terminal` are emitted by the live-round leg driver (leaf-2.0.1, scripts/qa) and journaled by the fixture as record kinds. Absent-not-0 throughout.
- **D7 — Live round timing.** `tests/qa/qa-f3-round.live.test.ts` + `_bmad-output/evidence/v6-a2/` are leaf-2.0.1, sequenced after branch integration and gated on operator GO (charter §5.6) — not missing, staged.
- **D8 — Exit-6 legs.** Lifecycle status closes exit-6 runs as `completed` (closedAt→completed); the harvest's presence is the retain signal. Pinning test added: a completed-terminal leg with harvest output retains its findings.
- **D9 — Pin consequence.** The tracked-inputs digest was adopted in-branch (same-commit ritual). The publish-side literals (driver REF/BUILD_ID, Dockerfile TOFU ARGs) move only on a real publish — the wave-0 re-pin ritual re-runs on the [M1.2+J3+J4+A2] tree before the live round (C16).
- **D10 — Status agreement.** Sprint row + story header both read `in-progress` mid-flight (the consistency checker requires agreement); both flip to `done` at true close (PR merged).

### Review rounds

- **Round 1 (2026-10-16, pre-PR):** 4 layers (blind hunter, edge-case hunter, verification-gap, acceptance auditor), ~35 findings. Triage: 16 actionable (ALL fixed — incl. the gh-stdin production defect D4, the escalated fail-open D5, retain cap/attribution/partial-failure, fixture one-wake-one-protocol idempotence, surrogate-safe titles, requestId threading, redacted bounded failures), 3 evidence-refuted (D1, D7, D8-mechanism), 1 driver-caused test corruption (a duplicated dp:ok comment briefly commented out a q1-contract assertion — caught by review, repaired, suite re-green). Verification-gap layer found no verification gaps; 72/72 targeted suites green at review time.

### Live round record (2026-10-17, fired post-merge — the honest close-out)

The live Tier-2 round FIRED the same day, on Z2's post-merge trigger, after the substrate was stood up: the trigger config (`createQaPostMergeTrigger`) has no production caller (it is a one-time operator-side config action on a live fork instance — none existed; one was built: the local docker fork rebuilt at fork dev `9603c0f0` carrying #801, the QA-manager bot provisioned, the GitHub PAT credential stored, the Z4 wrapper + a cwd shim wired as `SWARMCLAW_FACTORY_FLEET_CLI`, git credentials mounted for the private-repo fill, `hindsight-qds` (the M1.1 dedicated instance) run from Z4's compose on :18890). The publish chain was healed first (TOFU re-pin `c224c02f`; adoptions `9ae282c9`/`5c541069`; image `f3f1d6cb`/`1d97da49` attested + mirrored; R3-a openrig drift re-pinned twice along the way).

**The first real fire of the whole F3 chain caught TEN shipped-seam defects** — each a live-only failure, each fixed and merged the same day:

| # | Seam | Failure | Fix |
|---|------|---------|-----|
| 1 | workId charset | the contract `w:qa-…` refused at submit (`CorrelationError INVALID_WORK_ID`) | PR #439 (+ CodeRabbit's ledger-grammar mirror) |
| 2 | watch wake gate | `createAgentTaskSession` hard-disables heartbeat; the watch wake rode that gate — the bot never turned | day-of session config; fork follow-up swarmclaw#808 |
| 3 | AC6 stamp | `qaWorkKeyPatch` had no submit-path caller — records born unstamped | PR #440 (birth-hook stamp) |
| 4 | witness identity | the in-box reader demanded digits; dispatch always writes `w:<workId>` for headless work — engine died at argv | PR #441 |
| 5 | fill credentials | the fork container could not fetch the private repo — dispatch died pre-engine | day-of credential mount |
| 6 | roster at cloned sha | the manifest's roster must resolve at the MERGED sha, which predates it | config fix 7163583a (the proven roster) |
| 7 | phase schema cap | 1100s refused (`maxDurationMs ≤ 900000`) | config fix 27974dbb |
| 8 | hunt convergence | two hunts overflowed their caps reviewing the whole 4k-line diff | config fixes 135a87fc/d59fcac3 (bounded review set) |
| 9 | changedFiles contract | the sha-pinned roster's write-capable fixer must declare the field | config fix 66fa0168 |
| 10 | budget guard vs family | the in-box team cap is the roster schema's $0.50 default (INV-2's guard — kept); the release/ledger-family seams filed | day-of ledger sweep; swarmclaw#808 |

**The green round (fire 12, watch `9a848683…`, protocol `61e6cdf5`)**: all three legs settled ok on real boxes (`96bc7a`/`297263`/`d55be2`, image `f3f1d6cb`), spends 118k/301k/211k µ$; leg findings: correctness CLEAN, secret-hygiene 17 findings (1 schema-refused pre-normalization, recorded), diff-scope CLEAN; 16 findings retained (`qa-findings-retained` lines, bankId + documentIds); 16 GitHub issues filed #443–#458 (host-side, per-lens titles, token on the stdin READ path); **priming round-trip PROVEN**: `primeDispatchBrief` on the production seam returned `<kg_context>` 7,929 chars, first entry a retained hunter finding (`qds-20261017-e88f24`). Total program spend: under $2.

**Follow-ups filed**: swarmclaw#808 (the four fork-side seams: wake gate, group-reserve release absent, submit seam carries no lens, `w:w:` double-prefix identity hygiene). Factory-side seam gap #11 (retain's `qds-` prefix guard vs the recall fan-out's `resolveBankId(slug)` family disagree for org-scoped slugs — the priming loop needed both banks) is recorded in `qa-priming-round-trip.json` and owed a story.

**Substrate state after the round**: 0 boxes, both leg keys revoked (verified against `listedKeyHashes`), the QA-manager bot + PAT credential + trigger sessions remain on the local docker fork (the round's standing config), `hindsight-qds` stays up (the M1.1 stack), `hindsight.env`/`fleet.env`/`git-credentials` day-of files stay untracked (0600).

### Review rounds (continued)

- **Round 2 (2026-10-16, pre-PR):** 4 layers over the post-R1 diff (3972 lines, 22 files, incl. the vendored pi-1.1.0 compat). ~24 findings; triaged: **19 fixed** (writer grammar + schema parity with lowercase pin; secret-hygiene redaction on retain payloads, issue bodies/titles and failure errors; filing attribution honesty — per-finding lens titles + runId provenance; same-batch dedup with an explicit cross-restart scope note; failedCount on the log line; minted-shape runId pins; slug-gate ordering; null-entry guard; real-client `createIssue` tests; the vendor compat hardening — splice restricted to the last user block, codepoint-safe trim, loud layout-drift failure, loader fallbacks, refusal-arm + extraction unit tests, fixture workId collision refusal); **5 declined with rulings**: (i) strict (runId,lens) consistency gate on `fileIssues` — multi-lens/multi-runId batches are the hunter-pack's design, per-finding labeling is the attribution fix; (ii) `retainFindings` deriving ran-ness internally — single-caller pattern (normalizeHarvest→retain), fixture covers both arms; interface churn late in the round buys nothing; (iii) registry-derived vendor expectations — vendored frozen-upstream suite stays upstream-shaped; (iv) `workKey` folded into the wire payload — DD-20's join is factory-internal via records; the cross-system contract is the verdict only; (v) vendor suites moved into a gate — the exemption is the repo's documented env-dependent posture (PR #404); proof of record = manual verify runs on this machine (unit 35/0 + parity 13/0 + e2e 10/0). **Round 2 verdict: only Lows/Infos remained after fixes → stopping after round 2 per the operator's stop rule.**
