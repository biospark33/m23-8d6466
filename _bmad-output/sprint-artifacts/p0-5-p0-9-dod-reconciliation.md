# P0.5 / P0.9 DoD Reconciliation — evidence pack for issue #51

**Date:** 2026-07-26 · **Scope:** evidence gathering only.
**Author constraint:** this document changed **no** `status:` field in
`sprint-status.yaml` and ticked **no** DoD checkbox in any story file. Every
decision below is a *proposal* for the maintainer.

Verification host: darwin arm64, bun 1.3.13, node v24.15.0, pi-lens **3.8.71**
installed at `~/.pi/agent/npm/node_modules/pi-lens`.

---

## Update 2026-07-28 — proposals applied; two findings below are now stale

The reconciliation was carried out. Read this block before §2, §3 and §4.

**Board (`sprint-status.yaml`):** P0.5 and P0.9 both downgraded `done` →
`in-review`, each with the reasoning inline. Clarifying notes added to P0.6
(the downgrade does not cascade), P1.6 and P1.7 (§5's findings).

**Story files:** every DoD box in both stories now carries a state and an inline
citation, using P0.11's `[x]` / `[~]` / `[ ]` convention. Final tallies —
**P0.5: 3 met / 1 partial / 5 not satisfied. P0.9: 6 met / 4 partial / 1 not
satisfied.**

**Stale finding 1 — §4 is fixed.** PR **#84** (issue #55) unified the resolver;
`scripts/lib/pi-lens-harness.ts:57-58` now honours `PI_LENS_ROOT`. The verifier
no longer fatals. Gate clause 4 is unblocked.

**Stale finding 2 — P0.5 DoD 2 is settled, and it is a `[x]`.** §3 called it
UNVERIFIABLE and named the settle condition: *"land issue #55's `PI_LENS_ROOT`
fix, then run `bun scripts/pi-lens-verify.ts --strict` and confirm all three
check families execute."* Both done on 2026-07-28 against pi-lens 3.8.71 →
**exit 0, 3 pass / 0 fail / 1 optional skip**, with AC1 `lsp_diagnostics`
(live TS2322, `stableId: aw:35344075b5`), AC2 secret-scan (live opengrep
detection) and AC3 warning-count proxy all executing. §2's summary table
therefore reads **2 satisfied / 1 unverifiable** for P0.5 where it should now
read **3 satisfied / 0 unverifiable**. Nothing else changed: the emit-block
still does not fire (`gitleaksOnPath:false, trivyOnPath:false`) and
`idObserved` is still `false`.

**Unchanged:** every P0.9 finding, and P0.5's other eight items. The MANDATORY
e2e demos in both stories remain un-run.

**Deliberately not decided here:** §7's P0.9 option A (restore `done` + record
an OQ-4 waiver) versus option B (`in-review`). B was applied because it is the
evidence-only reading — a MANDATORY item that has never executed is not done —
and because it treats P0.5 and P0.9 by the same rule. Granting a waiver is a
policy call (§8 Q2) and remains open to the maintainer.

---

## Update 2026-11-04 — evidence refresh only (no status changed, no box changed)

**Why:** the board and §6/§7 still argue from a wall that no longer exists. This
block records post-reconciliation evidence so the maintainer's policy call is
made on the current picture. It changes nothing else.

### P0.9 — OQ-4 is no longer the wall; 0.10.0 response drift is

Hindsight **did boot**: dedicated instance on qds-alpha (VPS), 2026-10-04, via
M1.1's closure legs (PR #407 dev-half, PR #410 probe fixes; evidence
`_bmad-output/evidence/p0-9-closure/`). Leg outcomes as captured:

| Leg | Outcome | Note |
|---|---|---|
| `hindsight-live` (raw shape probe) | **pass** (3rd run, `…-lbghxg.json`) | boot/health/digest identity + raw retain/recall bodies — the "deciding evidence" issue #408 names for the amendment |
| `provision-and-import` | **fail** 2026-10-04 → **pass** rerun 2026-10-07 (`…-kvdvho.json`) | 3 banks + Mulch import + seed-probe on real instance |
| `idempotency-rerun` | **pass** (`…-hddo6j.json`) | bank IDs + entry counts stable live |
| `round-trip-via-bridge` (**DoD 9, MANDATORY**) | **fail** (`…-euvtm2.json`) | retain response failed the **PRE-transform** strict `RetainResponseSchema` (the PR-#37-era camelCase contract) — 0.10.0 sends no `memoryId`/`bankId`/`status`/`durationMs`. This failure does NOT describe current code: M3.1 (`4b73e1b2`) since landed the adapter-in-schema (measured snake_case wire → `.transform()` legacy view, `src/hindsight/schemas.ts:141-181`), so **DoD 9's current status requires a fresh live round-trip run** against the transformed schema |
| `negative-probes` | **fail** (`…-pisa2e.json`) | nonexistent-bank probe not refused 404 (drift); 2 probe mislabels corrected in README |
| `auth-retired-check` | **inconclusive** | bank-profile endpoint removed in 0.10.0 → HTTP 410; proves nothing about authz |
| `document-id-retain-twice` | **measured** | identical re-retain is a no-op (no duplicate); **changed-content update path unproven** |

Classification shift vs §6: DoD 9 moves from NOT-SATISFIED/BLOCKED-on-env to
**ran-and-failed on schema drift**; DoD 10's live half has positive evidence
(idempotency-rerun pass) though the content-comparison recall clause is still
unasserted; DoD 7's recall half gains M1.3's live hit-rate baseline (canary hit,
2026-10-07) but no per-bank content assertion. The #408 conformance slice has
since **landed** (M3.1, `4b73e1b2`): `src/hindsight/schemas.ts` now parses the
measured 0.10.0 wire and `.transform()`s it into the legacy view — the euvtm2
failure predates it. What remains open is the `memoryId` sub-decision only
(placeholder-in-transform vs `RoundTripOk` type change vs
verifier-modification waiver — the transform currently pins `""` from a
forward-compat `id` field no server emits), and a **fresh live run** of
`round-trip-dedicated.ts` to establish DoD 9's status under the transformed
schema; both operator-owned. Note also README's
redaction note: the 2026-10-07 import file had a revoked key id scrubbed — the
folder's "never edited after capture" rule has one sanctioned deviation.

### P0.5 — the July settle is not reproducible on this host TODAY (host drift)

`pi-lens` is **not installed** anywhere this session can find (checked
`~/.pi/agent/npm/node_modules`, `~/.local/node-arm64` (exists but `bin/` empty,
no `lib/`), `/opt/homebrew/lib/node_modules`, plus a bounded find; `pi-gitnexus-plus`
survives, `pi-lens` does not; `~/.pi/agent/settings.json` no longer lists
`npm:pi-lens`). Consequences measured today:

- `bun scripts/pi-lens-verify.ts --strict` → **exit 2**, the §4 fatal
  (`resolveGlobalPiLens` throws) — NOT the pre-#84 resolver defect; the resolver
  is correct, the package is gone.
- `gitleaks`, `trivy`, `opengrep`, `pyright`, `typescript-language-server` all
  absent from this session's PATH — even secret-scan *detection* (opengrep),
  live in July, is gone.
- Repo side intact: `bun test tests/pi-lens-verify.test.ts tests/lsp-verify.test.ts`
  → **38 pass / 2 skip / 0 fail** (the 2 skips are the live checks).

The DoD 2 "satisfied" settle of 2026-07-28 is therefore host-dependent and
currently un-reproducible without a reinstall (pi-lens 3.8.x per P1.7's pin
line — do not re-pin to 3.8.47). Reinstall is host-changing: operator call.
P0.5's closure legs (mode-json agent e2e, secret-scan emit-block, python-lsp
discovery, version-pin editorial) ride issue #408's window per the closure
plan; the version-pin editorial is the one pure-repo item and could land as a
tiny docs-only PR independent of any window.

---

## 0. TL;DR

- **P0.5 is not done.** Its own evidence artifact — written by the story's own
  review, merged in PR #30 — scores its 9 DoD items **3 met / 4 partial / 2 not
  met** and closes with *"Changes Required / Partially Approved"*. The board says
  `done`. The board is wrong. **Recommend: downgrade P0.5 to `in-review`.**
- **P0.9's code is done; its proof is capped by one environment wall.** 6 of 11
  DoD items are fully backed by merged code and 132 green tests I ran today. Four
  more are blocked on the same single fact — **Hindsight has never booted on any
  available host** (OQ-4, BLOCKED-on-env) — so every recall-based and end-to-end
  assertion is untested, including the MANDATORY e2e demo. One item (DoD 5) is a
  wording gap. **Recommend: needs-human-decision — accept the mock-level proof
  with a recorded OQ-4 waiver, or downgrade to `in-review` until Hindsight boots.**
- **P1.6 / P1.7 are not actually gated on P0.5's open items** — see §5. They are
  gated on other things, and P1.6's declared dependency list is itself stale.

---

## 1. First correction: the issue's checkbox counts conflate three lists

Issue #51 says "P0.5 has 12 unchecked DoD boxes vs 6 checked" and "P0.9 has 11
unchecked vs 41 checked". Those raw counts are right but they merge the DoD
section with unrelated checklists. The real picture is worse for P0.5 and
better-looking-but-misleading for P0.9:

| Story | File | DoD section | DoD checked | Other checked boxes | Where those live |
|---|---|---|---|---|---|
| P0.5 | `phase-0/stories/p0-5-pi-lens-headless-tdi.md` | lines 54–62 (**9 items**) | **0 of 9** | 6 | QA "Improvements Checklist", lines 132–137 |
| P0.9 | `phase-0/stories/p0-9-hindsight-banks-mulch.md` | lines 364–374 (**11 items**) | **0 of 11** | 41 | "Review Findings" rounds 1–3, lines 382–472 |

**Not one DoD box is ticked in either story.** P0.5's other 3 unchecked boxes
(lines 138–140) are QA improvement items, not DoD.

For contrast, P0.11 (`p0-11-phase0-exit-gate.md`) does this honestly — it uses
`[x]`, `[~]` (line 219, partial), and `[ ]` with an inline explanation
(line 221). That is a usable precedent for whatever the maintainer decides here.

---

## 2. Summary table

**Current (post-2026-07-28 update — reflects PR #84):**

| Story | DoD items | Checked | SATISFIED-UNCHECKED | NOT-SATISFIED | UNVERIFIABLE |
|---|---|---|---|---|---|
| **P0.5** | 9 | **0** | **3** (items 2, 3, 7) | **6** (items 1, 4, 5, 6, 8, 9) | **0** |
| **P0.9** | 11 | **0** | **6** (items 1, 2, 3, 4, 6, 8) | **2** (items 5, 9) | **3** (items 7, 10, 11) |

> **Superseded original (2026-07-26, kept for provenance):** P0.5 read
> `2 satisfied / 1 unverifiable` — item 2 was UNVERIFIABLE because the verifier
> fatalled on this host. PR **#84** landed the `PI_LENS_ROOT` resolver fix and
> the 2026-07-28 live run (`bun scripts/pi-lens-verify.ts --strict` → exit 0,
> 3 pass / 0 fail / 1 optional skip) settled item 2 as **satisfied**. P0.9's
> row is unchanged.

Read the P0.5 row again: **three of nine DoD items are demonstrably met, and two
of those three are documentation items.** Every remaining functional item is
unmet — the verifier now *runs*, but the MANDATORY e2e demo still has not.

(P0.5's 3 extra unchecked QA-improvement boxes, lines 138–140, are all
NOT-SATISFIED and duplicate DoD items 6, 8 and 9. They are not counted above.)

---

## 3. P0.5 — per-item classification

Merged artifacts: PR **#26** (merge commit `0b90a72`, merged 2026-07-11 — adds
`scripts/pi-lens-verify.ts` + `_research/pi-lens-verification-report.md`) and PR
**#30** (merge commit `99dccb2`, merged 2026-07-18 — rewrites both, adds
`tests/pi-lens-verify.test.ts`). Both verified via `gh pr view` and `git log`.

The single most important source is the story's own evidence artifact,
`_bmad-output/sprint-artifacts/_research/pi-lens-verification-report.md` **§7
"DoD traceability (all 9 story checkboxes)"**, lines 434–448. It grades each DoD
item itself. I re-read that table and cross-checked it against the tree. I agree
with it.

### DoD 1 (line 54) — *"pi-lens v3.8.47 installed via `pi install npm:pi-lens`; settings.json contains package entry."*
**NOT-SATISFIED (as literally worded).**
Verified first-hand: `~/.pi/agent/settings.json:8` contains `"npm:pi-lens"` ✅,
but the installed version is **3.8.71**
(`~/.pi/agent/npm/node_modules/pi-lens/package.json`), not 3.8.47. The report
records 3.8.69 at the time and grades this **"Partial (drift)"**
(report line 438). The install half is real; the pinned-version half is false and
has drifted further since. P1.7's story explicitly says *"Do not re-pin to
3.8.47"* (`phase-1/stories/p1-7-lsp-diagnostics-gate.md:61-62`), so the fix is to
amend the pin, not to install 3.8.47.

### DoD 2 (line 55) — *"Verification script exercises `lsp_diagnostics`, secret-scan, and warning-count proxy paths."*
**SATISFIED** (settled 2026-07-28 — see the Update block at the top of this
document). PR **#84** unified the `PI_LENS_ROOT` resolver
(`scripts/lib/pi-lens-harness.ts:57-58`); the settle condition named below was
then executed on this host against pi-lens 3.8.71 →
`bun scripts/pi-lens-verify.ts --strict` **exit 0, 3 pass / 0 fail / 1 optional
skip**, with all three check families executing (AC1 `lsp_diagnostics` live
TS2322 `stableId: aw:35344075b5`, AC2 secret-scan live opengrep detection, AC3
warning-count proxy).

> **Superseded analysis (2026-07-26), kept for provenance — do not act on it:**
> **UNVERIFIABLE.**
> `scripts/pi-lens-verify.ts` exists (PR #26 +529, PR #30 +520/−207); report line
> 439 grades it **Met**, and the recorded run in report §1 lines 51–63 shows
> `pass:3, fail:0, skip:1, exit 0`. Its unit tests are green here today
> (`bun test tests/pi-lens-verify.test.ts tests/lsp-verify.test.ts` → **36 pass, 2
> skip, 0 fail**).
> **But I cannot re-confirm the claim.** That recorded run came from a different
> host running pi-lens 3.8.69, and the script **fatals before a single check runs
> on this host** (§4). The only evidence that it exercises all three paths is a
> transcript I cannot reproduce.
> **To settle it a human must:** land issue #55's `PI_LENS_ROOT` fix, then run
> `bun scripts/pi-lens-verify.ts --strict` and confirm all three check families
> execute. — *This condition was met on 2026-07-28; see the SATISFIED verdict
> above.*

### DoD 3 (line 56) — *"pi-lens `lsp_diagnostics` structured output format documented."*
**SATISFIED-UNCHECKED.** Report §3 AC1 contract table; graded **Met** at report
line 440.

### DoD 4 (line 57) — *"`--mode json` headless emission confirmed — machine-readable JSON on stdout, no TUI required."*
**NOT-SATISFIED.** Report line 441 grades it **Partial**: only the *session
handshake event* reached stdout before LLM auth failed; no diagnostic payload was
ever seen over `--mode json`. The payload was validated over the MCP stdio
transport instead — a different transport than the DoD names.

### DoD 5 (line 58) — *"LSP server auto-discovery from PATH confirmed for TypeScript and Python."*
**NOT-SATISFIED.** Report line 442 grades it **Partial**: TypeScript live
(`typescript-language-server@5.3.0`, real TS2322); **Python not exercised as a
check** — pyright ran only as a fixture, with no assertion.

### DoD 6 (line 59) — *"Secret-scan blocks emit on hardcoded API key pattern; finding type `secret_detected` confirmed."*
**NOT-SATISFIED.** Report line 443 grades it **"Not met (as literally worded)"**.
Detection is live (opengrep). The *block* was never observed — it requires a
gitleaks/trivy finding in `sessionSecrets`, and neither binary was present. The
finding type `secret_detected` **does not exist** in the installed pi-lens. This
is the NFR-SEC-3 invariant (INV-1); the story's Security Review calls the
emit-block path **"source-verified only"** (story file line 145).

### DoD 7 (line 60) — *"TDI proxy path documented: on-disk artifact read with logged fallback reason (FR-EX-8)."*
**SATISFIED-UNCHECKED.** Report line 444 grades it **Met** — numeric read from
`cache/code-quality-warnings.json` with an explicit `fallbackReason`. The
demonstrated count is a 0-value fallback, reconciled in report §3.

### DoD 8 (line 61) — *"Test (verification): diagnostics parseable with stable IDs; warning count numeric; secret-scan blocks."*
**NOT-SATISFIED.** Report line 445 grades it **Partial**: the stable id is
**derived by the harness, never assigned by pi-lens** (`idObserved:false`), and
the secret-scan block was not observed. Two of three sub-clauses fail.

### DoD 9 (line 62) — *"Test (e2e demo — **MANDATORY**): Pi agent with pi-lens runs in `--mode json` ... secret-scan blocks on secret file."*
**NOT-SATISFIED.** Report line 446 grades it **"NOT met"** — blocked on LLM auth;
no agent turn was ever run. The story's own Final Status (line 169) says the
mandatory demo "remains open".

### The 3 unchecked QA-improvement boxes (lines 138–140)
All **NOT-SATISFIED**, and all restatements of DoD 6, 8 and 9: live emit-block
observation, AC1 observed-id, and the mandatory `--mode json` agent demo.

### P0.5 net
Report §7's own closing line (line 448): **"3 met, 4 partial, 2 not met. The
mandatory e2e demo (item 9) and the literal secret-scan wording (item 6) are the
hard blockers to 'fully done.'"** The story's Final Status line reads *"Changes
Required / Partially Approved"*.

---

## 4. ~~P0.5's deliverable is currently broken on this host~~ — HISTORICAL, FIXED BY PR #84

> **This entire section is superseded and describes a defect that no longer
> exists.** It records the 2026-07-26 state. PR **#84** (issue #55) unified the
> resolver — `scripts/lib/pi-lens-harness.ts:57-58` now honours `PI_LENS_ROOT`
> — and the verifier runs clean on this host as of 2026-07-28 (exit 0,
> 3 pass / 0 fail / 1 optional skip). Gate clause 4 is unblocked. Retained
> below only as the reproduction record that motivated the fix; **do not treat
> it as a current blocker.**

The defect as reproduced on 2026-07-26 (twice):

```
$ bun scripts/pi-lens-verify.ts
pi-lens-verify fatal: Error: pi-lens not found in any known global node_modules dir
    at resolveGlobalPiLens (scripts/lib/pi-lens-harness.ts:60:27)
    at main (scripts/pi-lens-verify.ts:199:14)

$ PI_LENS_ROOT=/Users/i3creations/.pi/agent/npm/node_modules/pi-lens bun scripts/pi-lens-verify.ts
   ... identical fatal, same stack.
```

pi-lens **is** installed (3.8.71). The verifier cannot see it, and setting
`PI_LENS_ROOT` does not help.

- `scripts/pi-lens-verify.ts:70` — `export function resolvePiLens()` delegates
  straight to `resolveGlobalPiLens()`, which takes no arguments and reads no
  override.
- `scripts/lib/pi-lens-harness.ts:32-60` — `resolveGlobalPiLens()` probes only
  `~/.local/node-{arm64,x64}/lib/node_modules/pi-lens` and `npm root -g`, then
  throws. **No `PI_LENS_ROOT` reference exists anywhere in that file** (grep
  confirms zero hits).
- `scripts/lsp-verify.ts:181` — `export function resolvePiLens(repoRoot: string)`
  checks `process.env.PI_LENS_ROOT` first (line 183), then repo-local, then falls
  back to P0.5's global probe. This is why P0.6 passes 7/7 on the same host where
  P0.5 fatals.

The P0.11 story file confirms the reading at line 221: *"clause 4 is a defect in
the P0.5 deliverable, not an environment gap"*, and the gate report says the same
at `_research/phase0-gate-report.md:88` — *"Root cause is a defect in the P0.5
deliverable, not in the environment."* This is why §13 gate clause 4 records
**SKIP**, and a SKIP fails the gate (gate report line 69).

Issue #55 owns the code fix. The assessment asked of me: **P0.5's verifier is not
sound enough to be a Phase-1 foundation in its current state.** It is a harness
that cannot start. Note that P0.6 already worked around it by writing a superset
resolver rather than fixing the shared one — so the *capability* survives; only
P0.5's own entry point is dead.

---

## 5. Are P1.6 and P1.7 safe to start?

**Short answer: P0.5 is not the thing blocking them, and the dependency edges as
written are misleading.**

**P1.7 does not depend on P0.5.** `sprint-status.yaml:49` declares
`deps: [P0.6, P1.6]`. The issue text's claim that P1.7 declares a P0.5 dependency
is incorrect; the link is transitive through P1.6 only. P1.7's own story says
*"P0.6 is DONE (PR #42, merged 2026-07-25)"*
(`phase-1/stories/p1-7-lsp-diagnostics-gate.md:26`) and it consumes P0.6's
`scripts/lsp-verify.ts` + `scripts/lib/*` — the path that **does** honour
`PI_LENS_ROOT`. P1.7 also already absorbs three P0.6 corrections in an inline
warning block (lines 28–67), including "do not re-pin to 3.8.47".

**P1.6's dependency on P0.5 is nearly vacuous.**
`phase-1/stories/p1-6-pi-team-protocol-step.md:59` says it outright:

> *"In this story, 'pi-lens gating' refers to output validation at the harness
> layer (schema validation of the structured JSON output), **not P0.5's TDI
> diagnostic tooling**."*

P1.6 never invokes `pi-lens-verify.ts`, `lsp_diagnostics`, or the secret-scan
path. Every open P0.5 DoD item (mandatory `--mode json` agent demo, secret-scan
emit-block, observed finding IDs, Python LSP discovery) is orthogonal to what
P1.6 builds.

**But P1.6 has real, separate problems the board does not show.** Its own
declared predecessor list (`p1-6-pi-team-protocol-step.md:26`) names **P0.1** and
**P1.4** — both `killed` per `sprint-status.yaml:27` and `:46`. P1.6 is written
against a CLI-Anything harness skeleton and a 14-node DAG protocol template that
the Warren decision deleted. That is a spec problem, not a P0.5 problem, and it
is a bigger blocker than anything in this document.

**Verdict:**
- **Do not block P1.6/P1.7 on P0.5's DoD reconciliation.** Unblocking P0.5 will
  not make P1.6 buildable, and blocking on it will not protect anything.
- **Do block P1.6 on a spec refresh** that removes the killed-P0.1/P1.4
  predecessors. Also note P1.6 declares `deps: [P1.1, P1.2, P1.3]` — all still
  `draft`, so it is not startable today regardless.
- **P1.7 is safe to start once P1.6 lands**, on P0.6's foundation, provided its
  inline P0.6 warning block is honoured.
- One genuine cross-cutting risk survives from P0.5: **NFR-SEC-3 / INV-1 (the
  secret-scan emit-block) has never been observed firing.** Any Phase-1 story
  that assumes secrets cannot escape a turn is assuming an unproven property. That
  belongs on the risk register regardless of what happens to P0.5's status field.

---

## 6. P0.9 — per-item classification

Merged artifact: PR **#37** (merge commit `7dd8cdb`, merged 2026-07-20) — 20
files, ~6,300 lines: `src/hindsight/{client,bank-provisioner,mulch-importer,round-trip-verifier,schemas,index}.ts`,
`scripts/{provision-hindsight-banks,import-mulch-expertise}.ts`,
`scripts/lib/cli-args.ts`, five test files, and `.mulch/expertise/` fixtures.
All verified via `gh pr view 37` and confirmed present in the tree.

**Test evidence run today on this host:**
`bun test tests/hindsight tests/provision-hindsight-banks.test.ts tests/import-mulch-expertise.test.ts`
→ **132 pass, 0 fail, 512 expect() calls, 7 files, 828ms.**

### DoD 1 (line 364) — bank provisioner creates 3 banks, idempotent on re-run
**SATISFIED-UNCHECKED.** `src/hindsight/bank-provisioner.ts` (563 lines, PR #37).
`tests/hindsight/bank-provisioning.test.ts:85` "happy path", `:117` "idempotency",
`:315` "single-flight (INV-HM6 / CC-10)". Green.

### DoD 2 (line 365) — round-trip verifier: retain → recall → reflect → consolidate preserves
**SATISFIED-UNCHECKED.** `src/hindsight/round-trip-verifier.ts` (581 lines).
`tests/hindsight/memory-round-trip.test.ts` — 8 describes covering happy path,
each failure mode, and `:372` "post-consolidation" preservation. Green. Drives a
mocked client, not a live Hindsight.

### DoD 3 (line 366) — Mulch importer reads all four extensions, validates, retains as JSONL
**SATISFIED-UNCHECKED.** `src/hindsight/mulch-importer.ts` (676 lines).
`tests/hindsight/mulch-import.test.ts` — 17 describes including happy path
(`:130`), dedup (`:191`), partial failure (`:262`), quota (`:307`), 5MB cap
(`:340`), BOM (`:360`), empty dir (`:411`). Real fixtures shipped in the same PR:
`.mulch/expertise/qds-foundations.yaml`, `.mulch/expertise/swarmclaw.json`.

### DoD 4 (line 367) — nine named Zod schemas validated on all inputs
**SATISFIED-UNCHECKED.** All nine named schemas plus `BankIdSchema` verified
present in `src/hindsight/schemas.ts` at lines 28, 60, 77, 83, 88, 102, 109, 120,
133, 143. Round-2 review recorded *"all 10 schemas match spec field-for-field"*
(story line 413).

### DoD 5 (line 368) — Hindsight HTTP client wired to SwarmClaw MCP invoke path; all four ops through the bridge
**NOT-SATISFIED (as worded) — and the story knows it.**
The proof is split in two and the halves were never joined:
- `tests/hindsight/bridge-round-trip.test.ts:83` drives the **real** P0.7 route
  handlers through `/invoke` for retain/recall/reflect/consolidate — but against
  `tests/swarmclaw/fixtures/fake-hindsight-mcp.ts`, a bun subprocess fake. Its own
  header (lines 1–16) states this is *"without a live Hindsight binary (which is
  unreachable on this host)"*.
- The round-trip verifier drives `client.ts` **directly**, not through `/invoke`.

The story's Round-1 review dismissed exactly this with reasoning (story line 403:
*"verifier drives client.ts not the /invoke bridge: the bridge proof lives in
tests/hindsight/bridge-round-trip.test.ts"*). That is a deliberate, recorded
decision — but it means the DoD sentence "Hindsight HTTP client wired to
SwarmClaw MCP invoke path" describes something no test performs. The maintainer
may accept the split proof; they should do so knowingly, not by ticking a box.

### DoD 6 (line 369) — INV-HM1..HM6 enforced
**SATISFIED-UNCHECKED, with INV-HM5 source-verified only.**
Named tests: INV-HM1 `tests/hindsight/client.test.ts:348`; INV-HM2
`client.test.ts:329` + `bank-provisioning.test.ts:230,503,652`; INV-HM3
`mulch-import.test.ts:382,601`; INV-HM4 `mulch-import.test.ts:501`; INV-HM6
`bank-provisioning.test.ts:315`. **INV-HM5** (defensive-parse) has no test
carrying its name — it is enforced in `src/hindsight/client.ts:11` and covered
indirectly by the non-JSON/502 error-path tests (`client.test.ts:248` describe).

### DoD 7 (line 370) — provision 3 → retain to each → recall from each, assert content per bank; import Mulch → recall by concept → assert match
**UNVERIFIABLE.** The *provision three banks* half is proven
(`bank-provisioning.test.ts:86` asserts exactly
`["qds-factory","qds-factory-dev-meta","qds-collective"]`). The *retain to each →
recall from each → assert correct content per bank* half and the *recall by
concept → assert match* half are **not**: grepping `recall` across
`tests/hindsight/bank-provisioning.test.ts` returns **zero hits**, and in
`tests/hindsight/mulch-import.test.ts` the only recall usage is the mock plumbing
(lines 20–82) and the tenant-isolation probe (`:501`, `:522`). No test asserts
recalled content per bank or matches an imported concept back out.
**To settle it a human must:** boot Hindsight (OQ-4), run
`bun scripts/provision-hindsight-banks.ts` then
`bun scripts/import-mulch-expertise.ts`, and recall a known concept (e.g. `sparc`
from `.mulch/expertise/qds-foundations.yaml`) from
`qds-factory-dev-meta`, confirming the imported expertise comes back.

### DoD 8 (line 371) — guard tests: invalid bank_id, empty dir, malformed file
**SATISFIED-UNCHECKED.** Invalid bank_id → `bank-provisioning.test.ts:230`
(-32003) and `client.test.ts:329`; empty dir → `mulch-import.test.ts:411`;
malformed → `mulch-import.test.ts:262` (partial failure) and `:713` (malformed
JSONL line is per-entry, not whole-file).

### DoD 9 (line 372) — **Test (e2e demo — MANDATORY)**: run provision → import → retain/recall/reflect via the MCP bridge, all three banks
**NOT-SATISFIED.** This has never run. `_research/phase0-gate-report.md:63`
records §13 clause 7 (P0.9, Hindsight round-trip) as **FAIL**, with the runtime
detail (report lines 119–121):

> `no reachable Hindsight API at http://127.0.0.1:8888 (listBanks -> HTTP 404); served by "Jupyter Server" — not Hindsight. OQ-4 records the local stack as BLOCKED-on-env (arm64 libpq/openssl@3 mismatch).`

And at lines 129–133: *"PRD Appendix D already records OQ-4 as BLOCKED-on-env … P0.9
did not resolve it."* The mandatory demo requires a running Hindsight. There has
never been one.

### DoD 10 (line 373) — idempotency: run twice → bank IDs unchanged, Mulch entry count unchanged, recall with exact-match query returns same result set (content comparison)
**UNVERIFIABLE.** Two of three clauses are proven at mock level: bank IDs
unchanged (`bank-provisioning.test.ts:117` idempotency describe) and entry count
unchanged (`mulch-import.test.ts:191` dedup describe), reinforced by fix R3-9
(story line 465), which made re-import honour `RetainResponse.status ===
"updated"` — the story itself says the prior behaviour was "breaking the DoD
idempotency metric". The dedup-hash contract is spec'd at story line 172.
The third clause — **recall with an exact-match query returns the same result
set, compared by content** — has no test (see DoD 7: no recall assertions exist)
and cannot be shown against a mock, since the mock returns whatever it is told.
**To settle it a human must:** with Hindsight live, run the import twice and diff
the recalled result-set contents.

### DoD 11 (line 374) — dependency failure: bridge unavailable → structured error, no partial bank creation
**UNVERIFIABLE.** The error *codes* are tested against mocks:
`bank-provisioning.test.ts:197` "AC-4 bridge not registered (-32001)" and `:214`
"AC-5 Hindsight unavailable (-32002)", plus
`tests/provision-hindsight-banks.test.ts:29` covering the `realBridgeProbe`
R2-M4/M5 fixes. What is **not** demonstrated is the second half — *"no partial
bank creation"* — because no bank has ever actually been created anywhere. That
clause is only meaningful against a real Hindsight.
**To settle it a human must:** boot Hindsight locally (unblock OQ-4), then run
`bun scripts/provision-hindsight-banks.ts` with SwarmClaw deliberately stopped,
and confirm the CLI emits -32001/-32002 **and** that a subsequent `listBanks`
against a now-running Hindsight shows zero banks created.

---

## 7. Recommendations

### P0.5 → **downgrade `sprint-status.yaml:31` from `done` to `in-review`**

Not a close call. Three independent artifacts, all authored by the P0.5/P0.11
work itself, say the story is not finished:

1. The story's own **Final Status** (line 169): *"Changes Required / Partially
   Approved … the mandatory `--mode json` agent demo remain open."*
2. The evidence report's **§7 net** (line 448): *"3 met, 4 partial, 2 not met."*
3. The §13 gate: **clause 4 SKIP**, root-caused to *"a defect in the P0.5
   deliverable"* — and I reproduced that defect live today (§4).

A story whose MANDATORY e2e item is graded "NOT met" by its own reviewer, and
whose shipped verifier cannot start on the current host, is not `done`. Marking
it `done` on 2026-07-18 was premature — the merge of PR #30 was recorded as
completion, but PR #30 was the *review-fix* PR whose own report concludes the
work is partial. The board conflated "reviewed and merged" with "done".

The unchecked boxes here are **not** stale bookkeeping. They are accurate.

### P0.9 → **needs-human-decision** (my lean: keep `done` with a recorded waiver)

P0.9 is a genuinely different situation from P0.5. Six DoD items are backed by
merged code and 132 green tests I ran myself. Nothing here is unbuilt — ~6,300
lines shipped in PR #37 and three adversarial review rounds recorded *"all DoD
checkboxes backed"* (story line 453).

The five items that are not clean share **one** root cause: **every recall-based
and every end-to-end assertion needs a live Hindsight, and Hindsight has never
booted** (OQ-4, BLOCKED-on-env). DoD 9 (mandatory e2e), 7 and 10 (the recall
halves) and 11 (the "no partial bank creation" half) are all the same wall. DoD 5
is separate and smaller: a wording gap where the bridge proof and the client
proof exist but were never joined.

Two defensible outcomes, and the maintainer must pick:

- **(A) Keep `done` + record a waiver.** Tick DoD 1–4, 6, 8 as `[x]`; mark DoD 5,
  7, 10, 11 as `[~]` with the split-proof / mock-only / recall-untested note;
  leave DoD 9 as `[ ]` with an inline *"BLOCKED-on-env: OQ-4"* explanation. This
  is exactly the convention P0.11 already uses
  (`p0-11-phase0-exit-gate.md:219,221`). Honest, and it does not pretend the e2e
  ran.
- **(B) Downgrade to `in-review`** until Hindsight boots. Consistent with "a
  MANDATORY item is mandatory", but it will sit there indefinitely — OQ-4 has been
  open since before P0.9 started and unblocking is operator-side.

I lean (A): P0.9's *code* is done and provably so; only the *demonstration* is
blocked, on something outside the story. But this is precisely the human judgment
call issue #51 escalated, so I am not choosing.

Either way: **the P0.9 story file must stop showing 0 of 11 DoD boxes ticked
while the board says `done`.** That specific contradiction is what makes the
board untrustworthy.

### Cross-cutting

`sprint-status.yaml:24` already carries the honest epic-level truth:
`status: gate-red-not-exitable`. The per-story `done` values contradict their own
epic header. Whatever is decided per story, the epic line is currently the most
accurate statement in the file.

---

## 8. Open questions for the maintainer

1. **Does a merged review PR mean `done`?** P0.5 was flipped to `done` on
   2026-07-18 citing PR #30 — the very PR whose report concludes "3 met, 4
   partial, 2 not met". Define the rule: `done` requires all DoD ticked, or `done`
   means "merged and reviewed"? The board currently uses the second and reads as
   the first.
2. **Is an env-blocked MANDATORY item waivable?** P0.9 DoD 9 and P0.5 DoD 9 are
   both MANDATORY and both blocked on environment (Hindsight/OQ-4; LLM auth). If
   MANDATORY is waivable, say so and record the waiver; if not, three Phase-0
   stories are `in-review` indefinitely. Same question governs P0.11's own
   unchecked mandatory item (line 221).
3. **Is a mock-backed bridge proof acceptable for P0.9 DoD 5?** The story's
   Round-1 review already dismissed the objection with reasoning (story line 403). Ratify
   that dismissal explicitly, or reword the DoD item to describe what is actually
   proven.
4. **Re-pin pi-lens.** Spec says 3.8.47; installed is 3.8.71; P0.6 ran 3.8.71;
   P1.7 says do not re-pin to 3.8.47. Someone should amend the pin in P0.5's spec
   text so DoD 1 becomes truthful.
5. **P1.6's spec is stale.** Its predecessor list
   (`p1-6-pi-team-protocol-step.md:26`) names P0.1 and P1.4, both killed by the
   Warren decision. Does P1.6 need re-authoring before it can start? This is a
   bigger blocker than P0.5.
6. **Who owns proving NFR-SEC-3?** The secret-scan emit-block (INV-1) has never
   been observed firing on any host — it needs gitleaks or trivy installed. Does it
   stay a P0.5 open item, move to the risk register, or become a Phase-1 story?
7. **OQ-4 unblock owner and date.** Per `phase0-gate-report.md` §3.3 (lines 133–137) the fix is
   operator-side: arm64 OpenSSL at `/opt/homebrew/opt/openssl@3`, or point
   `HINDSIGHT_API_DATABASE_URL` at an external Postgres, or re-fetch a host-matched
   build. Until someone owns this, P0.9 DoD 9, gate clause 7 and gate clause 6 all
   stay red. Also note the default `HINDSIGHT_BASE_URL` port 8888 collides with a
   Jupyter server on this host.

---

## 9. Verification notes on this document

- Every commit SHA (`0b90a72`, `99dccb2`, `7dd8cdb`), PR number
  (#26, #30, #37, #42), and file:line citation above was re-checked against the
  repo or `gh` after first draft.
- Test counts are from runs performed on 2026-07-26 in this worktree, not quoted
  from any report: 132 pass / 0 fail (hindsight suite); 36 pass / 2 skip / 0 fail
  (pi-lens + lsp verify suites).
- The `pi-lens-verify.ts` failure in §4 was executed twice, with and without
  `PI_LENS_ROOT`, and both stack traces reproduced verbatim.
- No `status:` field and no DoD checkbox was modified by this work.

### P0.5 update 2026-11-04/05 (post-CR rounds 1+2) — promotion observed; DoD 6/9 back to partial

Two rounds of CodeRabbit findings on PR #494, each verified against current
code before acting; all four round-2 findings (like both round-1 findings)
were VALID and are applied:

Round 1 corrected two overclaims (observed-id wording; "never runs headless"
→ the MCP transport can run the full lifecycle and leg b5 did, promoting the
verbatim `🔴 STOP — hardcoded secrets detected … slack-access-token [trivy]`).

Round 2 sharpened further, from source and leg evidence:

1. The MCP boot-time auto session-start fires ONLY with
   `PI_LENS_MCP_AUTO_SESSION=1` (`dist/mcp/server.js:134`); leg b5 did NOT
   set it — its trivy scan came from the documented explicit
   `pilens_session_start` tool call recorded in the leg log.
2. What the legs OBSERVE is promotion + delivery to the MCP consumer. NOT
   demonstrated: downstream emission blocking — prevention of a secret
   reaching coms output, merged JSON, or a Hindsight bank (INV-1's
   downstream surfaces).
3. DoD 6 returns to `[~]`: the DoD-named `secret_detected` finding type does
   not exist in installed pi-lens; closing that is a spec amendment (operator
   call), not a behavioral re-reading.
4. DoD 9 returns to `[~]`: no single `--mode json` agent run has shown the
   secret STOP and a warning count in its stdout. A closing attempt (leg9,
   2026-11-05 02:44) warmed the trivy cache under the agent-resolved cwd key
   (`/private/tmp/p05-legs` → `…private-tmp-p05-legs/`, secret verified in
   cache) and ran a real json agent turn — the session's turn-end machinery
   NEVER fired (zero turn_end rows in latency.log at 02:4x; last working
   rows: leg b5's 02:12 `blockers_found`). Recorded as
   attempted-but-unobserved.

Tally: 7 met / 2 partial / 0 not. Row flip to done WITHDRAWN; keep in-review
with the three partials (DoD 6, 8, 9) recorded. Original window record: the
operator window ran; pi-lens@3.8.71 installed via `pi install npm:pi-lens@
3.8.71`; trivy/pyright/typescript-language-server/opengrep installed;
`pi-lens-verify --strict` → exit 0, 3 pass / 0 fail / 1 optional skip. Legs:
mode-json agent e2e (structured lsp_diagnostics TS2322 + pyright warning over
the json transport, real agent), python-lsp discovery with real assertion,
and the secret-scan chain. Reading notes + verbatim logs:
`_bmad-output/evidence/p0-5/legs-2026-11-04/README.md`.
