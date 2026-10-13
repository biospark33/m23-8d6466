# A6: GitNexus graph-refresh cron on the VPS + staleness alarm (FR-MEM-6)

**Story Points:** 2
**Sprint:** v6a (Epic A — the sole Autonomy-epic story pulled forward pre-E21; Wave 2 authored, VPS-day fired, Live tier: infra)
**Status:** ready-for-dev after Z4 authored (deploy/vps/ exists); fired half rides Z4 fired + ops G1–G7 + operator GO

> **FLEX-CUT (DD-26):** A6's FIRED half is v6a's second named flex-cut — it rides ops and can slip to v6b without breaking v6a's exit evidence (exit evidence = primed T2 green, gateway round-trip, re-pinned CI, M1.3 interim report; A6 appears in none). The AUTHORED half is never cut. Pre-authorized trigger: post-review v6a total > 42.

## Spec Reference

- **Charter:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — Epic A row A6 (§3 v6a table: "GitNexus 4–6h graph-refresh cron on VPS + staleness alarm (FR-MEM-6)"; dep Z4, Live tier: infra); §1 gap 7 (recovered v4 vision); §6 guardrails; §7.5 ops timing.
- **FR-MEM-6 + NFR-OBS-5 verbatim:** `_bmad-output/planning-artifacts/prd-qds-factory-v4.md:380` and `:734` (carried verbatim in R1) — refresh every 4–6h; "staleness = time since the last *completed* analyze, kept ≤8h"; "each refresh cycle logs success/failure, duration, and the indexed HEAD SHA"; atomic-swap-else-advisory-lock clause; threshold "0 agent runs against a graph whose last completed analyze is >8h old".
- **Decision register:** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` — DD-14 (namespace/path); DD-26 (authored/fired split + the v6a flex-cut list, this story's fired leg = cut #2).
- **Canonical reindex:** `scripts/install-gitnexus-plus.sh` — the repo's only sanctioned reindex (repo CLAUDE.md: a bare `gitnexus analyze` skips the transient `.gitnexusignore` negation `!tests/ !__tests__/ !fixtures/`, so `tests/gitnexus/fixtures/` and `graph-queries.test.ts` degrade to `(skip)` silently). The script is idempotent, exits non-zero on failure (cron-usable), stamps `.gitnexus/cli-version.json` (`installedCliVersion`, `expectedCliVersion`, `indexedAt`, `indexedHead`), and honors `GITNEXUS_SKIP_INSTALL=1` for analyze-only runs.
- **Contract ritual riding the refresh:** `tests/gitnexus/contract.test.ts` (strict schemas; `tests/gitnexus/gitnexus-cli-contract.json` `expectedCliVersion`) is the ONE suite meant to fail loudly on CLI drift; `graph-queries.test.ts` is not the alarm. Upgrade ritual per repo CLAUDE.md: upgrade → reindex → contract suite red → adopt schema + pin + reindex stamp in ONE commit.
- **Ancestry disposition:** FR-MEM-6's "runs `gitnexus analyze`" prose is superseded on THIS repo by the canonical-script rule — the carried intent is "a GitNexus reindex"; the bare form would produce a graph that quietly omits tests (AC1's negative control). The atomic-swap half is upstream GitNexus behavior — inherited, not implemented; the advisory-lock fallback IS implemented (AC5). The "Maintenance scheduler must not fire a refresh while a graph-consuming DAG run is active" half has no Maintenance scheduler in v6a (A3 is v6b) — carried as A3's obligation, not dropped.
- **Sibling contracts consumed unmodified:** Z4's deploy profile (`deploy/vps/` host with bun, the factory clone, docker; A6 adds `crontab.factory` there and owns that file); `.gitnexusignore` (transient, negation-carrying — consumed via the script, never edited here); A3 (v6b) consumes the stamp for hotspot sourcing.

## User Story

As the factory, I want the GitNexus graph refreshed on a 4–6h cadence on the VPS with an alarm that fails when the graph goes stale, so that A3's maintenance sweeps traverse a near-current graph and GitNexus CLI drift is caught within one cadence instead of at an evidence round.

## Overview

A host cron entry (in Z4's `deploy/vps/`) invokes a refresh wrapper: staleness check on the PRE-cycle stamp → `flock` → `bash scripts/install-gitnexus-plus.sh` → `bun test tests/gitnexus/contract.test.ts` → one NFR-OBS-5 log line carrying the incoming stamp's age. The staleness check (`scripts/gitnexus-staleness.ts`) runs FIRST, on the incoming stamp, and exits non-zero when its `indexedAt` is older than the 8h ceiling (checked before any work so the alarm describes the incoming state, naming age, ceiling, and stamp path). A non-zero staleness verdict is **recorded, then cured**: the wrapper records the verdict as a `stalenessAlarm` field (age, ceiling, stamp path) on the cycle's single log line, then continues into `flock` and the canonical reindex — aborting before the reindex would leave the graph stale forever (the next cycle's incoming stamp is staler still, so a fail-fast-and-stop alarm self-perpetuates; the check exists to alarm on the incoming state, and the reindex is the recovery). Ordering is DD-28.26(11): running the staleness check after the reindex would be structurally inert — a fresh stamp is the reindex's own output, so the alarm could never fire.

**What this does NOT deliver:** no agent-run gating — the "0 agent runs against a >8h-old graph" threshold lands with its consumers (A3/A1, v6b); no Mac/local-dev scheduling (operator ad hoc); no upstream GitNexus changes; no dispatch-path or fleet code (any `src/` byte moves the box COPY set — none is owed).

## E2E Slice

**Demonstrable behavior (authored):** Given a dev machine with no VPS and no cron, When `bun test tests/gitnexus/staleness.test.ts tests/gitnexus/refresh-cron.test.ts` runs, Then fixture stamps prove: fresh (age < 8h) exits 0; stale (> 8h) exits non-zero naming age, ceiling, and stamp path; a missing stamp fails as "absent, not 0"; the no-bare-analyze scan passes the real wrapper + crontab line and demonstrably fails a bare-form fixture; the lock fixture proves an overlapping tick coalesces as `skipped-overlapping`.

**Demonstrable behavior (fired, operator):** Given VPS day after Z4 fired and explicit GO, When the operator installs the crontab entry, Then one observed cycle produces the structured log line `{ts, cycle, result, durationMs, indexedHeadSha, stampAgeHours, cliInstalled, cliExpected}`, the contract suite is green within the cycle, and the evidence JSON lands in `_bmad-output/evidence/v6-a6-refresh/`.

**Wiring closed:** On completion of the authored half, the refresh + alarm machinery is complete and machine-checked using only files merged by this story. **No stub, no `TODO: cron later`.** The fired half closes using Z4's host (bun, clone, cron availability) plus this story's wrapper — no new code.

**Dependency edges (predecessors):** **Z4 — a direct edge** (the host profile; the fired half additionally rides Z4's fired leg + operator GO). **Not an edge — M1.1:** both wait on VPS day; neither reads the other's outputs. **Not an edge — A3 (v6b):** A3 consumes the stamp this story maintains; nothing here reads A3.

## Acceptance Criteria

1. **[authored] (make-or-break — the reindex command)** Given `scripts/gitnexus-refresh.sh`, When it runs, Then it invokes `bash scripts/install-gitnexus-plus.sh` from the repo root (resolved via `git rev-parse`, the script's own idiom) and NEVER a bare `gitnexus analyze`. *Negative control: **a cron running bare `gitnexus analyze`** builds a graph that silently filters `tests/` via the transient `.gitnexusignore` negation — every downstream query degrades with no failure signal anywhere; the refresh-cron scan refuses any wrapper or crontab line invoking the bare binary and MUST fail this one.*
2. **[authored] (cadence + staleness alarm)** Given `deploy/vps/crontab.factory`, Then it carries the entry `7 */5 * * *` (5h — inside FR-MEM-6's 4–6h window; off the top of the hour) invoking the wrapper by absolute path as the deploy user; and the staleness check exits non-zero naming age, ceiling, and stamp path when `indexedAt` is more than 8h old (NFR-OBS-5 literal — measured from the last COMPLETED analyze, which is what the stamp records; checked on the INCOMING pre-cycle stamp, before the reindex — DD-28.26(11)); the wrapper RECORDS that verdict as the log line's `stalenessAlarm` field (the alarm survives the cure in the record — see Observability Contract) and then proceeds to `flock` + the canonical reindex — the alarm fires on the incoming state and the same cycle performs the recovery, never exiting before the reindex on a staleness result alone. *Negative controls, all MUST fail: **a refresh with no staleness alarm** (the mandated absence — a cron that refreshes and never fails on staleness); a check that treats a missing stamp as age 0 — a wiped `.gitnexus/` would read forever-fresh; and a wrapper that aborts on a stale verdict WITHOUT reindexing — the graph then stays stale at every future tick (a self-perpetuating alarm with no cure path).*
3. **[authored] (the NFR-OBS-5 log line)** Given every cycle, Then exactly one structured line is appended to `.sandbox/refresh-cron.jsonl` carrying success/failure, duration, and the indexed HEAD SHA (`indexedHead` from the stamp, cross-checked against `git rev-parse HEAD` on FULL cycles only — a `skipped-overlapping` line records the stamp's sha with `crossCheck: "n/a"`, no work ran to cross-check; mismatch = failed cycle naming both). *Negative control: a line omitting any of the three fields, or one logging duration `0` on a failed cycle instead of the elapsed attempt time, MUST fail (fixture-asserted).*
4. **[authored] (contract ritual rides the refresh)** Given a completed reindex, Then the wrapper runs `bun test tests/gitnexus/contract.test.ts` and a non-zero result marks the cycle FAILED with the log/alarm naming `cliInstalled` vs `cliExpected` from the stamp. *Negative control: a wrapper reporting success while the contract suite is red — CLI drift would then survive unlimited cadences — MUST fail.*
5. **[authored] (advisory lock — FR-MEM-6 fallback clause)** Given concurrent ticks, Then the wrapper holds `flock` on `<graph-home>/.refresh.lock` — the concrete lock target, resolved through the same `QDS_GITNEXUS_HOME`-aware path the refresh uses — for the whole cycle and a tick arriving mid-cycle exits 0 as `skipped-overlapping` (coalesce, never collide). *Negative control: two overlapping reindexes interleaving writes into the live graph MUST fail — the lock's absence is proven by the test fixture.*
6. **[authored] (boundary — no dispatch gating in v6a)** Given the story's output surface, Then it is exactly the stamp + alarm + log; nothing gates an agent run on graph age, and no `src/` file changes. *Negative control: an implementation adding a graph-age check into the dispatch path expands the autonomy surface as quiet scope growth (standing rule: autonomy expansion enters as new D-numbers through normal review) and MUST fail this one.*
7. **[fired, operator-gated] (deployed and observed)** Given VPS day after Z4 fired, Then: crontab entry installed; one real cycle observed end-to-end with evidence JSON in `_bmad-output/evidence/v6-a6-refresh/` (house style — written by the leg's own driver: `durationMs`, `indexedHeadSha`, stamp state, contract-suite result); zero agent spend. The alarm's failure mode is NOT re-demonstrated on the box — it is proven authored-side by fixtures (AC2); the fired evidence records one healthy cycle.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Graph older than 8h | in-scope — staleness check fails by name | staleness.test fixtures | A3 (v6b) consumes the same stamp |
| GitNexus CLI version drift | in-scope — contract suite fails the cycle; log names installed vs pinned | contract.test (consumed, byte-identical) | the CLAUDE.md upgrade ritual (cron is the alarm, never the adopter) |
| Overlapping refresh ticks | in-scope — flock coalesces | refresh-cron lock fixture | none in v6a.0 |
| Agent run against a stale graph | out-of-scope — v6a has no graph-consuming agent runs; the threshold lands with A3/A1 (v6b) | — | A3 |
| Local/Mac dev graph freshness | out-of-scope — operator ad hoc; the cron is VPS-only | — | none |
| `.gitnexusignore` negation drift | out-of-scope — the canonical script owns it; the no-bare-analyze scan is the tripwire | refresh-cron scan | none |
| Upstream atomic-swap behavior | out-of-scope — inherited from GitNexus; flock is the coded fallback | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| Authored half | none — `bun test tests/gitnexus/` green before start | green before, green after (additive files only; contract + graph-queries suites byte-identical) |
| Z4 host profile | fired half only — bun + factory clone (runbook §2/§6, gate G7), cron available on the box, plus the `gitnexus` CLI + `pi` binary the canonical script requires (runbook §2 installs neither — a fired-leg operator step, surfaced to the register as ops-register row 8, blocking A6-fired) | operator-verified on VPS day |
| Operator GO | fired half only — crontab enable on the box | **zero agent spend; the operator executes — charter §6: ops stay operator-gated until explicit GO** |

> No VPS, no spend, and no cron are prerequisites of the AUTHORED half. The refresh needs no credentials and ships nothing off-box.

## Technical Notes

- **Picked and stated: host cron, not a compose sidecar (DD-26 records the pick).** The refresh is a host command — repo checkout + bun + the gitnexus CLI the runbook §2 installs; a sidecar would bind-mount the checkout and re-install the CLI in-image: two runtimes for one script. The template's own precedent is host-cron (`backup.sh`, 03:15 daily, outside compose). One line of crontab is the whole deployment.
- **Cadence pick: 5h.** Both 4h and 6h satisfy FR-MEM-6; 5h leaves exactly one missed cycle inside the 8h staleness ceiling before the alarm fires, and `7 */5 * * *` stays off the top of the hour. `INDEX_STALENESS_CEILING_HOURS = 8` is a named constant (NFR-OBS-5 literal), not an implied number.
- **Ordering against the contract ritual:** an intentional CLI upgrade lands via the CLAUDE.md ritual (upgrade → reindex → contract suite red → adopt schema + pin + stamp in one commit); the cron then goes green on the next tick. The cron is the drift ALARM — it never adopts.
- **Considered and rejected: a long-running bun-side watcher.** Daemon-shaped; this repo's house shape is the exiting pass — DF3.8's observe sweep (exiting cron pass, no daemon, INV-IBOX-16) is the precedent A6 follows at host scale.
- **Region ownership on shared files:** `scripts/install-gitnexus-plus.sh`, `tests/gitnexus/contract.test.ts`, `tests/gitnexus/graph-queries.test.ts`, `.gitnexusignore`, `.gitnexus/cli-version.json` — all **consumed, not modified** (the stamp is tool-written; the alarm reads it). Zero bytes under `src/` — no COPY-set movement, no re-pin ritual owed.

## Observability Contract

One structured line per cycle to `.sandbox/refresh-cron.jsonl` (the `.sandbox/` log-line home, `dispatch-log.jsonl` precedent): `{ts, cycle, result: success|failed|skipped-overlapping, durationMs, indexedHeadSha, stampAgeHours, cliInstalled, cliExpected, crossCheck: match|mismatch|n/a}` — `crossCheck` values per AC3: `match` / `mismatch` on FULL cycles (the stamp's sha against `git rev-parse HEAD`; a mismatch IS the failed cycle, naming both), `n/a` on `skipped-overlapping` (no work ran to cross-check). Failure lines name the failing stage — `reindex | contract | crossCheck` (staleness is never a *stage*: a stale incoming verdict is recorded as `stalenessAlarm` on the same cycle's line, then cured — `result: success` when the cure lands, `failed` only when a stage actually fails). A missing or unparseable stamp reports `stampAgeHours: null` on the cycle's line whatever the result — **absent, not `0`**: the graph is never treated as fresh because its age is unknown; `result: failed` comes from a failed stage (e.g. a red reindex), never from the age's nullness alone.

> Amendment 2026-10-13 (review round 1, AA-002/AA-003; round 2, AA2-002/AA2-003): this contract originally specified a `staleness` failure stage and `result: failed` for null ages. The landed implementation (PLAN I2, record-then-cure) carries the alarm as `stalenessAlarm {fired, ageHours, ceilingHours, stampPath}` on a `result: success` line, records `stampAgeHours: null` on any verdict, and emits `stage: crossCheck` on the fail-closed sha-mismatch arm; the stage enum above reads `reindex | contract | crossCheck`. Tests `refresh-cron.test.ts:666/:701/:722` pin the landed semantics (record-then-cure / absent-null / unparseable-null; line numbers as of the round-2 fix commit — the amendment cites the test NAMES primarily, lines secondarily). Text reconciled to landed truth; no behavioral change.

## Files to Modify

- `scripts/gitnexus-refresh.sh` — **new**: pre-cycle staleness check on the incoming stamp (DD-28.26(11)) → flock → canonical reindex → contract suite → log line (log carries the incoming stamp's age; log sink + graph home overridable for fixture runs — `QDS_GITNEXUS_HOME` is the stamp override; tests never append to the live `.sandbox/refresh-cron.jsonl`)
- `scripts/gitnexus-staleness.ts` — **new**: stamp-age check; `QDS_GITNEXUS_HOME` override for fixture testing
- `deploy/vps/crontab.factory` — **new**: the `7 */5 * * *` entry (absolute path, deploy user) — A6-owned file in Z4's directory
- `tests/gitnexus/staleness.test.ts` — **new**: fixture stamps (fresh / stale / missing)
- `tests/gitnexus/refresh-cron.test.ts` — **new**: no-bare-analyze scan, log-line vocabulary, lock fixture
- `scripts/install-gitnexus-plus.sh` — **not modified** (consumed; the canonical reindex this wrapper must call)
- `tests/gitnexus/contract.test.ts` — **not modified** (listed to state byte-identical consumption — it is the alarm, not the adopter)
- `.gitnexus/cli-version.json` — **not modified by hand** (tool-stamped; the staleness check's input)

## Security Invariants

- **INV-A6-1 (canonical reindex only):** the cron can never produce a tests-filtered graph and report health — the no-bare-analyze scan makes the regression fail in CI, not on the VPS. What it does not fence, said plainly: an operator hand-running the bare form outside the cron — the stamp + contract suite catch that drift within one cycle.
- **INV-A6-2 (fail-closed freshness):** missing/unparseable stamp = failure, never age 0; a stale graph is reported stale, never silently refreshed-adjacent.
- **INV-A6-3 (no credentials, no egress):** the refresh needs no token, reads none of G3's secret files, and pushes nothing off-box — local analyze + local tests only; the canonical script's extension install is the one egress (an npm fetch, carrying no factory data — fetch, not push); the crontab entry runs as the deploy user with no new secrets.
- **Inherited verbatim:** the repo CLAUDE.md reindex rule ("never a bare `gitnexus analyze`") and the contract-ritual ordering (schema + pin + stamp land in ONE commit — the cron never splits them).

## Definition of Done

- [ ] **Impl [authored]:** wrapper + staleness script + crontab entry landed at the named paths.
- [ ] **Contract:** staleness fixtures green — fresh exits 0; > 8h exits non-zero naming age/ceiling/path; missing stamp fails "absent, not `0`".
- [ ] **Contract:** no-bare-analyze scan green over wrapper + crontab, with a bare-form fixture demonstrably failing.
- [ ] **Contract:** log-line vocabulary fixture-asserted (the three NFR-OBS-5 fields + the `result` enum including `skipped-overlapping`); lock fixture proves overlap coalesces; contract-suite failure marks the cycle FAILED naming installed vs pinned.
- [ ] **Security:** no credentials in wrapper or crontab; `git diff` shows zero byte changes outside `scripts/gitnexus-*`, `deploy/vps/crontab.factory`, `tests/gitnexus/` additions — `src/` untouched, contract + graph-queries suites byte-identical. *(Amended 2026-10-13, AA-004: plus `.claude/skills/gitnexus-cli/SKILL.md` +2 lines — the reindex-ritual refresh the repo CLAUDE.md upgrade ritual mandates on CLI reindex, carried as chore 625e27c6 / PLAN C9a; disclosed, not a scope breach.)*
- [ ] **Integration [fired, operator]:** one observed VPS cycle → evidence JSON in `_bmad-output/evidence/v6-a6-refresh/` (`durationMs`, `indexedHeadSha`, stamp state, contract result); zero agent spend recorded.
- [ ] **Flex-cut (DD-26):** FIRED half pre-authorized as v6a cut #2 (post-review > 42 → slips to v6b alongside Z4's fired leg); AUTHORED half is never cut.
- [ ] **Test (e2e demo — MANDATORY):** the wrapper executed once end-to-end on this repo (the reindex is idempotent) producing a real log line + staleness verdict, with the fixture-override path (`QDS_GITNEXUS_HOME`) demonstrating the stale and missing-stamp verdicts without touching the live graph.
