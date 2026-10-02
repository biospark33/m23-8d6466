# Z1: Adapter contract v2 — the pinned `factory_observe` consumption surface + `SWARMCLAW_FORK_REV` pinning harness

**Story Points:** 3
**Sprint:** v6a (Epic Z — adapter-contract arc, story 1 of 2; Wave 1, zero E21 gates, Live tier: none)
**Status:** ready-for-dev

## Spec Reference

- **Charter:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — Epic Z row Z1 (§3 v6a table); §5.1 contract-as-code ("exact field-set pins, missing AND extra fields fail by name, literal SCHEMA_VERSION, closed status enums, exit-code table"); §5.3 pinned fork revs; §5.4 CI-greenness invariant.
- **Decision register:** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` — DD-14 (Z/M/A/J/G namespace; this file's path) and the SWARMCLAW_FORK_REV adoption-ritual entry this story lands.
- **Ancestry disposition:** the HANDOFF's Epic S skeleton (`_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-17-swarmclaw-kg-integration-HANDOFF.md`, superseded banner) is the ancestor. S1's "platform agent skills" clause is **not carried** — the live ADR-1 substrate replaced it. What survives verbatim is the ground-truth seams section's front-door fact (16-verb closed registry, `listVerbs()` in `src/fleet/verbs.ts` ~:87-663 — the charter's `:73-431` cite is stale line drift; cite by symbol).
- **Sibling contracts consumed unmodified:** `src/fleet/result.ts` (`RESULT_SCHEMA_VERSION = 1`, `RESULT_STATUS_VALUES` closed set, `ResultPayload`), `src/fleet/status.ts` (`StatusRow` + the closed state-vocabulary docblock, `FLEET_ROW_ID`), the `status`/`result` registry rows in `src/fleet/verbs.ts` (exit-code arrays). **Extended:** `tests/fleet/q1-contract.test.ts` (this story's product). `tests/fleet/skill-contract.test.ts` is consumed untouched — its every-wave-appends-no-predecessor-edit property must survive.
- **Ritual precedent:** `scripts/adopt-image-pin.ts` + the #396–#398 image-pin adoption ritual — the fork-rev pin mirrors its *discipline* (one deliberate adopt, provenance stamped, drift alarmed), not its mechanics (an adopter script for one literal is YAGNI; see Technical Notes).
- **Boundary with Z2:** Z1 owns the pinned contract text. Z2 consumes it in-fork and never amends it; drift found by Z2's work is fixed by a Z1 bump PR first (`§5.5` — one contract text, both sides).
- **Boundary with Z3 (v6b) and G1:** Z3 is the live exit round — the only real-behavior assertion in the arc; this story pins the contract Z3 runs against and runs no live round itself. G1's ADR-2 PROPOSED (operator decides via G1) governs auto-merge/verdict-consumption policy; nothing here pre-implements it.

## User Story

As the v6 derivation session, I want the fork↔factory observe contract pinned in factory CI and the swarmclaw fork rev pinned with a drift alarm, so that Z2's BUILD-IN-FORK work codes against a test-enforced surface and cross-repo drift is alarmed at evidence rounds instead of discovered mid-round.

## Overview

This story extends the Q1.8 contract suite to the surface the fork's `factory_observe` step will consume — the read-only `fleet status` and `fleet result` JSON — and lands the `SWARMCLAW_FORK_REV` pin + drift-alarm harness. It writes **no fork code, no new verb, no box, no key, no live spend**.

**What this does NOT deliver:** no fork-side step kind (Z2); no deployed wrapper (Z4); no versioned `status` payload marker (adding one to `src/fleet/status.ts` moves the box image's `deriveBuildId` — `src/fleet/` is in the box COPY set — and trips the ops-gated re-pin ritual this story's `none` tier forbids); no adopter script (the fork rev is one literal adopted by one deliberate PR).

## E2E Slice

**Demonstrable behavior:** Given the factory repo checked out with no fork and no credentials, When `bun test tests/fleet/q1-contract.test.ts` runs, Then the new observe-surface pins pass by driving `run()` argv-in/JSON-out the way the DAG adapter does — `fleet result --json` prints exactly the `ResultPayload` field set (`schemaVersion, runId, requestId, status, terminal, spendMicroUsd?, vmName?, artifacts{bundle?}`), exit 0 on a RUNNING record, exit 4 on a missing one; `fleet status` emits `StatusRow` JSON lines whose `state` words all belong to the closed vocabulary; and `bun test tests/fleet/swarmclaw-fork-pin.test.ts` proves every `swarmclawForkRev` recorded in `_bmad-output/evidence/` against its round's manifest provenance (AC6 semantics, not blind pin-equality): a stamped rev from a post-pin round equals `SWARMCLAW_FORK_REV`, a pre-pin rev equals its manifest row's rev — legitimate older revisions pass. The manifest covers every stamped evidence directory (AC5): `openrig-sc2/` at authorship, growing as rounds stamp new ones.

**Wiring closed:** On completion of this story, the fork-side observe consumer has a complete, test-enforced description of the JSON it may read — using only code merged by this story. **No stub, no `TODO: pin later`.** The fork repo itself is untouched by construction.

**Dependency edges (predecessors):** none — Z1 is a Wave-1 root. **Not an edge — Z2:** Z2 consumes this story's output but nothing here reads Z2; the contract text is written from the already-live SC2 substrate (ADR-1, 11-round evidence). **Not an edge — Z4:** the deployed wrapper's `--driver` ownership is documented as contract *prose*, not implemented here.

## Acceptance Criteria

1. **(make-or-break — the q1-contract extension)** Given the Q1.8 suite, When the observe consumption surface is pinned, Then `fleet result` is pinned with `expectExactFields` (missing AND extra fields fail by name, per the suite's existing idiom), the literal `RESULT_SCHEMA_VERSION === 1`, the closed `RESULT_STATUS_VALUES` set, and the registry exit-code row `[0, 2, 4, 6]` with the doctrine named: 0 covers a RUNNING run — `terminal` is the field a poller branches on. *Negative control: an implementation that pins only "the payload has a `terminal` field" accepts any fat payload, sails through a fork grammar drift, and MUST fail this one.*
2. **(the status listing surface)** Given `fleet status`'s JSON-lines output, When pinned, Then the pin covers the `StatusRow` field set as-observed, the closed `state` vocabulary exactly as enumerated by the module's own docblock ("THE WHOLE VOCABULARY"), `FLEET_ROW_ID`, and the registry exit row `[0, 1, 2, 4, 5, 6]`. The pin asserts **no literal SCHEMA_VERSION exists on this surface and none is added here** — the missing marker is recorded debt whose fix is coupled to a deliberate grammar bump plus the re-pin ritual. *Negative control: an implementation that "fixes" the debt by adding `STATUS_SCHEMA_VERSION` to `src/fleet/status.ts` changes bytes inside the box COPY set, moves `deriveBuildId`, and MUST fail this story's tier constraint (Live tier: none).*
3. **(read-only closure)** Given the contract text, When it names the verbs the fork observe step may invoke, Then it allows exactly `status` and `result`, and asserts from the registry facts that `result` takes no `--driver`, no box probe, and no run lock (poller-safe by construction). *Negative control: an adapter contract that lets the observe step invoke `observe` or `dispatch` reaches a live box from a "read-only" step and MUST fail this one.*
4. **(the fork-rev pin)** Given the adoption discipline, When `scripts/swarmclaw-fork-pin.ts` (new, **outside the box COPY set**) exports `SWARMCLAW_FORK_REV`, Then the constant is 40-hex, equals the rev the manifest's provenance row records for the newest round (AC5 — nothing in the evidence corpus itself records a fork rev; the manifest is the record), and carries a provenance comment naming the round and date, marked *bracketed, not field-recorded* per DD-28.26(9). Beside the pin it exports a second machine-readable constant — `SWARMCLAW_FORK_REV_PINNED_AT`, the ISO-8601 UTC datetime the pin was adopted (`YYYY-MM-DDTHH:MM:SSZ`, `Z`-suffixed) — so AC6's post-pin boundary is derivable from exported values, never from parsing the comment. It advances only by a deliberate bump PR naming the evidence round (charter §5.3). *Negative control: an implementation that sets the pin to fork `origin/dev` HEAD-at-derivation without round provenance pins a floor as if it were proven and MUST fail this one.*
5. **(the manifest)** Given the SC2 evidence corpus under `_bmad-output/evidence/openrig-sc2/` (rounds sc2-1-5 through sc2-7, 2026-09-28 → 2026-09-30 — the file count grows as rounds append, so the manifest enumerates what the directory holds at implementation time; it pins no count), When the sidecar manifest `fork-rev-manifest.json` is authored, Then it maps each JSON evidence leg to the rev its round ran against, each row citing `{file, rev, source: 'git-log bracket', citing: merge-sha(s) + round timestamp}` per DD-28.26(9) — the `citing` timestamp written as an ISO-8601 UTC datetime (`Z`-suffixed), the same form as AC4's `SWARMCLAW_FORK_REV_PINNED_AT`; pre-pin rows are timeline-bracketed inferences, not field-recorded values, and the two `.log` files take no rows (JSON legs only). It never edits the evidence originals. The manifest is one file — per-stamped-directory row sets, never one manifest per directory: Z1 authors only the `openrig-sc2/` rows at authorship; each future evidence directory that stamps `swarmclawForkRev` gains its rows in that same file from the round that produced it (Z3 authors the `v6-z3/` rows). *Negative control: a manifest row whose rev is guessed from the timeline without a citable source — or any diff that touches an evidence JSON — MUST fail this one.*
6. **(the drift alarm — provenance-scoped, not blindly global)** Given `tests/fleet/swarmclaw-fork-pin.test.ts` (new), When it runs, Then every `swarmclawForkRev` field in an evidence JSON is validated **against its round's provenance, not against the pin alone**: a stamped rev from a post-pin round must equal `SWARMCLAW_FORK_REV`, and a stamped rev predating the pin must equal its manifest row's rev — legitimate older revisions pass. The post-pin boundary is machine-derived, never read out of a comment: a manifest row is post-pin iff `citing >= SWARMCLAW_FORK_REV_PINNED_AT` — both ISO-8601 UTC datetimes per AC4/AC5, and a row stamped exactly at the pin instant is post-pin (inclusive at the pin). A mismatch fails naming **both** revs and the offending file (the `tests/gitnexus/cli-contract.ts` discipline: drift names the field and both shapes), and a stamped file with no manifest row is the coverage finding ("add its rev from round provenance — never guess"). *Negative controls, all MUST fail: an implementation that compares the pin against the fork working tree or `origin/dev` needs a fork checkout factory CI does not have and cannot have (charter §5.4) — it passes vacuously in CI and MUST fail this one; an alarm demanding pin-equality from pre-pin historical revs would fail legitimate evidence the moment an older round carries a field-recorded rev — provenance-scoping is what keeps the alarm true; and an implementation with no machine-readable post-pin boundary (the date living only in the provenance comment) misclassifies every row the same way — the alarm is permanently green (nothing is post-pin) or permanently red (everything is) and catches nothing, so it MUST fail this one.*
7. **(arming the next round)** Given `tests/fleet/e2e/sc2-harness.ts` — the writer whose `writeEvidence` produces the `openrig-sc2/` round files (`live-harness.ts` owns the fork-less `df3-e2e/` corpus and stamps nothing), When the evidence writer runs, Then it stamps `swarmclawForkRev` (adds-only) so every post-pin evidence round arms the alarm. *Negative control: a writer that omits the field leaves future rounds unalarmable and the alarm's coverage check silently green — it MUST fail this one.*
8. **(grammar boundary, carried as contract prose)** Given the contract text, When it describes the fork→factory route, Then it names `$SWARMCLAW_FACTORY_FLEET_CLI` as the only route (DF5.5 Amendment D) and states that `--driver exedev` lives only in the deployed wrapper — including for `status`, whose registry row requires the flag the wrapper, never the fork, supplies. *Negative control: contract prose that documents the fork appending a driver flag teaches the fork QDS's grammar and MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| `fleet result` payload drift | in-scope — AC1 pin fires by name | q1-contract field-set pins | none in v6a.0 |
| `fleet status` row/state drift | in-scope — AC2 pin fires by name | q1-contract field-set pins | version marker rides a deliberate grammar bump + re-pin ritual |
| Fork rev advances (fork dev merge) | in-scope — AC4/AC6: alarm fires at the next evidence round until the bump PR | swarmclaw-fork-pin drift alarm | Z3 (and any future sc2-harness round) are the bump occasions; factory-only rounds (df3-e2e) never move the pin |
| New fleet verb / registry change | out-of-scope — `tests/fleet/skill-contract.test.ts` owns the registry surface; q1 re-pins only the two observe verbs | skill-contract (byte-identical this story) | none in v6a.0 |
| Deployed wrapper (`--driver` ownership) | out-of-scope — Z4 implements; this story documents the boundary only | — | Z4 |
| Fork-side observe step | out-of-scope — Z2 | — | Z2 |
| Auto-merge / verdict policy | out-of-scope — ADR-2 PROPOSED (G1); never pre-implemented | — | G1 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| Q1.8 contract suite | none — `bun test tests/fleet/q1-contract.test.ts` green before start | green before, green after (extension is additive) |
| Skill contract | none — `bun test tests/fleet/skill-contract.test.ts` | green before and **byte-identical after** (no verb/flag changes) |
| SC2 evidence corpus | none — `_bmad-output/evidence/openrig-sc2/` read-only | exists (rounds sc2-1-5 → sc2-7, 2026-09-28 → 2026-09-30); annotated by sidecar only |

> No box, no LLM key, no model spend, no fork checkout, and no VPS are prerequisites of this story. No re-pin ritual is owed: the diff must not touch the box COPY set.

## Technical Notes

- **Contracts/Schema — this story persists nothing new in state.** The run-record extension surface is untouched; the only schema work is the contract *text* (test pins + prose).
- **Region ownership on shared files:** `src/fleet/**`, `src/lib/**`, `src/phase-engine/**`, `src/swarmclaw/**`, `scripts/lib/**`, `scripts/pipeline-run.ts`, `cli-anything/**`, `oci/exedev/**` — all **read-only this story** (box COPY set; any byte moves `deriveBuildId`). `scripts/swarmclaw-fork-pin.ts` sits at `scripts/` root, which the COPY set does not include.
- **Guards:** `SWARMCLAW_FORK_REV` shape-checked 40-hex in its own test; the manifest's coverage check fails by name on an evidence file predating the pin ("add its rev from round provenance — never guess").
- **Considered and rejected: an `adopt-fork-rev.ts` script.** The image-pin adopter exists because the ritual hand-edits five literals across four files. The fork rev is one literal plus one manifest row — a script would outlive its need. Revisit trigger: the ritual grows a second pinned fork constant.
- **Considered and rejected: `config/swarmclaw-fork-rev.txt`** (the fork's `config/hindsight-version.txt` precedent). Factory convention is typed constants; a `.txt` still needs a TS reader, so the constant IS the reader — the file is indirection.
- **Ordering against Z2:** Z2's fork PRs merge on fork dev; the factory pin does not track fork HEAD — it tracks evidence. A fork merge with no evidence round leaves the alarm green; the round that proves the merge triggers the bump.

## Observability Contract

The drift alarm's failure names: the pinned rev, the offending evidence file, the rev that file records, and the manifest row to update — one line each, no truncation. The pin module carries its provenance as a comment (`bracketed <date> from <round>` — bracketed, not field-recorded) and exports the pin instant as `SWARMCLAW_FORK_REV_PINNED_AT` (ISO-8601 UTC datetime, AC4) — round + pin instant are the two facts the alarm cites. An evidence file with no manifest row is **absent, not `0`** — the coverage check says "unmapped", never assumes a rev.

## Files to Modify

- `scripts/swarmclaw-fork-pin.ts` — **new**: `SWARMCLAW_FORK_REV` constant + `SWARMCLAW_FORK_REV_PINNED_AT` date + provenance comment (outside box COPY set)
- `tests/fleet/swarmclaw-fork-pin.test.ts` — **new**: drift alarm + coverage check
- `tests/fleet/observe-contract.ts` — **new**: shared assertion helper `assertObserveSurface(run, verb, argv)` — the pin logic q1-contract and Z2's consumer harness both import, so the surface is asserted once
- `tests/fleet/q1-contract.test.ts` — **extends**: observe consumption surface pins (AC1–AC3, AC8), asserting through the `observe-contract.ts` helper
- `tests/fleet/e2e/sc2-harness.ts` — **adds only**: its `writeEvidence` stamps `swarmclawForkRev` (the `openrig-sc2/` writer; not `live-harness.ts`, which owns `df3-e2e/`)
- `_bmad-output/evidence/openrig-sc2/fork-rev-manifest.json` — **new**: sidecar annotation; never edits originals
- `src/fleet/verbs.ts` — **not modified** (listed to state the registry facts are consumed, not re-pinned here)

## Security Invariants

- **INV-Z1-1 (no fork code in the factory import graph — charter §5.4):** the pin and the alarm are metadata *about* the fork; neither imports, shells out to, nor requires a checkout of it. Negative space, said plainly: the alarm reads evidence JSONs and the manifest — it cannot detect a fork-side merge, and is not trying to.
- **INV-Z1-2 (read-only contract closure):** the pinned verb set excludes every driver-required, spend-creating, and approval verb by construction, so a consumer honoring the contract provably cannot provision, spend, or approve. What it does not fence: a fork that ignores the contract — that is Z2's module-level allowlist, not this story's.
- **INV-Z1-3 (evidence integrity):** evidence files are annotate-by-sidecar only; the manifest never rewrites a round record. Inherited verbatim: ADR-1's grammar boundary (`SWARMCLAW_FACTORY_FLEET_CLI` sole route); charter §5.4's coupling rule (CLI JSON contract, pinned-rev fixtures, live evidence files — nothing else).

## Definition of Done

- [ ] **Impl:** `scripts/swarmclaw-fork-pin.ts` exports `SWARMCLAW_FORK_REV` (40-hex, provenance comment; bracketed from the SC2.7 round timeline per DD-28.26(9)) plus `SWARMCLAW_FORK_REV_PINNED_AT` (AC4).
- [ ] **Contract:** q1-contract extension green — `result` field-set/literal-version/enum/exit-row pins and `status` row/enum/exit-row pins, with missing AND extra-field refusals demonstrated by the suite's own failure mode.
- [ ] **Contract:** read-only closure pin green — allowed verbs exactly `status|result`; `result` asserted box-free/lock-free.
- [ ] **Test (drift alarm):** the alarm fails naming both revs + file when a fixture evidence rev ≠ pin (proven by a test fixture, never by editing real evidence).
- [ ] **Security:** `git diff` shows zero byte changes under the box COPY set — no re-pin ritual owed.
- [ ] **Integration:** sc2-harness's `writeEvidence` stamps `swarmclawForkRev`; skill-contract suite byte-identical before/after.
- [ ] **Test (e2e demo — MANDATORY):** the pinned surfaces demonstrated through `run()`'s argv-in/JSON-out against the fake driver — the way the DAG adapter consumes them — including exit-0-on-RUNNING and exit-4-on-missing for `result`.
