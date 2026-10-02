# A2: QA Department F3 — Post-Merge Hunter-Pack Priming the Next Dev Run

**Story Points:** 5
**Sprint:** v6b-Autonomy (E21-gated; the QA *department manager* as a Home bot — a manager, not a proactive/cron agent)
**Status:** **gated** — spec complete; dev BLOCKED until every gate clears. Gates: **E21 S02b** (bots as profiles + turn principal) and **E21 S03b** (Home provider wiring) merged to fork `origin/dev`; predecessor stories **A1** (manager bot substrate), **M1.2** (host-side retain/recall cycle), **Z2** (fork-side post-merge trigger wiring) done. **No documented crontab fallback exists for this story.** M3.1's fallback works because the M3 gateway is driver-agnostic; A2's actor is a bot turn — a cron substituting for it would be a different, un-chartered surface. If E21 slips, A2 waits.

## Spec Reference

- **F3 vision, verbatim** (`_bmad-output/planning-artifacts/prd-qds-factory-v4.md:111`, via R1 extraction): "A Paperclip event wakes the **Hermes QA manager**, which drives an **Archon** hunter-pack sub-DAG of **Pi** agents (orthogonal lenses, **pi-lens**-driven); findings become **Paperclip issues** + a shared per-repo **Hindsight** bank entry that primes the next Dev implement." Ancestry disposition: the v4 nouns die (Paperclip event → Z2's fork-side post-merge trigger; Archon sub-DAG → a swarmclaw protocol; Paperclip issues → host-side GitHub issues; Pi agents → fleet runs); the four-step shape survives **verbatim**: wake on merge → hunter-pack → findings → shared-bank entry that primes the next Dev implement.
- Charter: D-3 (24/7 agents as E21 Home bots), A2 table row (`2026-10-01-v6-derivation-session-INPUT.md:94`), §5.2 spec-seam fixtures, §5.6 live-round rules, §6 guardrails, DD-20 (bot-spend join keys `workKey + runId + botId`).
- ADR-1 (`docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md`): clause 1 (macro process = protocol whose consequential steps are `external_job`), clause 2 (fleet = only code-entry path), clause 3/4 (gate untouched; auto-approve explicitly out of scope), accepted gap #380 (headless `workId` briefs not booking spend — the `w:` namespace is sanctioned; the booking gap is open).
- Sibling contracts consumed unmodified: A1's bot substrate (no second refusal vocabulary); M1.2's idempotent host-side retain (stable dated `documentId`, `updateMode:"replace"`) and its dispatch-time recall; Z2's post-merge trigger + `factory_observe` step kind; `ProtocolExternalJobConfig` at `fork:src/types/protocol.ts:148` (`issueId XOR workId` — A2 uses the `workId` leg).

## User Story

As the operator, I want a merged PR to wake a QA department manager (Home bot) that drives an orthogonal-lens hunter-pack as real fleet runs, so that findings land as host-side GitHub issues plus a shared-bank entry that primes the NEXT Dev run — closing the F3 loop with humans and gates exactly where they are today.

## Overview

Factory scope: the host-side legs (findings normalization, idempotent retain, issue filing), `w:qa-*` workKey stamping on run records, and the spec-seam fixtures that keep factory CI green with zero E21 code. The protocol definition and trigger config are zeropoint-side work filed in the solstice repo from this same contract text (BUILD-IN-FORK per charter §5.5); factory points cover factory-repo work plus the joint live round.
**What this does NOT deliver:** no in-box `kg_recall` during QA runs (M2.2's lane — the QA box carries no memory key; provider secret only, Deviation 2); no schedule→protocol trigger (Z2's schedule leg / A3); no auto-applied fixes and no approval-gate traffic (A2's outputs are issues + bank entries, nothing else).

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

- [ ] **Impl:** `src/qa/` legs + run-record `workKey` stamp; tsc/biome clean.
- [ ] **Test (fixture):** fake Home-bot/gateway journal suite green with zero E21 code present; factory CI green.
- [ ] **Contract:** `workKey` adds-only; `detect_changes()` shows 0 unexpected affected symbols.
- [ ] **Security:** AC3/AC4/AC7 negative controls demonstrated failing at fixture tier.
- [ ] **Integration:** live Tier-2 round — worst-case spend printed, operator GO recorded, keys/boxes cleaned in `finally`, evidence scrubbed to `_bmad-output/evidence/v6-a2/` (`QDS_E2E_EVIDENCE_DIR` pinned there — live-harness defaults to `df3-e2e`); every evidence JSON stamps `swarmclawForkRev` (Z1's drift alarm covers `v6-a2/`) — the stamp is written by this story's own leg-evidence writer (mirroring Z3's leg drivers; `live-harness.ts` stays un-stamping per Z1 AC7, so the pinning requirement lives in the file this story adds to Files to Modify, not in live-harness); priming round-trip proven (next Dev dispatch `<kg_context>` contains a retained finding).
- [ ] **Test (e2e demo — MANDATORY):** the live round is the demo; the fixture tier additionally demos the full trigger→retain→issue path headlessly.
- [ ] **Integration:** counterpart fork-side story filed in the solstice repo from the same contract text.
- [ ] **Contract:** sprint-status v6 row + epics index updated; `bun test tests/scripts/story-consistency.test.ts` green.
