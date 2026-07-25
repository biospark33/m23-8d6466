# Phase-0 Exit Gate Verification Report — Story P0.11

**Story:** P0.11 — Phase-0 exit gate (§13 aggregated assertion check)
**Date:** 2026-07-25
**Host:** darwin arm64, `pi` 0.81.1, node v24.15.0, bun 1.3.13, pi-lens 3.8.71
**Gate script:** `scripts/phase0-exit-gate.ts` (run: `bun scripts/phase0-exit-gate.ts`)
**Runner:** `src/gate/gate-runner.ts`; assertions in `src/gate/assertions/`
**Tests:** `tests/gate/phase0-exit-gate.test.ts` — 45 tests (44 unit + 1 process-contract integration)

---

## 0. Headline

**`PHASE_0_GATE: FAIL` (exit 1). Phase-0 is NOT currently exitable.**

This is the gate working as designed, not a defect in the gate. Three PRD §13
Phase-0 clauses cannot be shown green on any available host today.

The story's make-or-break AC1 reads: *"Given all P0.1–P0.10 stories are fully
implemented **and their systems are running**…"*. That precondition is **not
satisfied** — so AC1 is **undemonstrated**, rather than failed. The gate's
contract (AC2, AC3) is fully demonstrated: it exits 1, prints
`PHASE_0_GATE: FAIL`, and names every blocking assertion with specific error
detail rather than a generic "checks failed".

---

## 1. Result summary (real script output, fully provisioned run)

```text
Totals: 7 pass, 2 fail, 1 skip (unproven), 2 void (clause dropped). 55761ms
PHASE_0_GATE: FAIL
# exit 1
```

Provisioning applied for this run: `pi install npm:pi-lens` (3.8.71),
`PI_LENS_ROOT=~/.pi/agent/npm/node_modules/pi-lens`, and a local SwarmClaw on
:3100 (`SWARMCLAW_PORT=3100 bun src/swarmclaw/index.ts`).

Exit-code semantics: **0** = PASS, **1** = any red/unproven assertion **or no
live assertions at all**, **2** = fatal before any assertion ran.

---

## 2. Clause → assertion map, with disposition

PRD §13 Phase-0 has ten clauses (1, 2, 3, 4, 4b, 5, 6, 7, 7b, 8). They do **not**
map one-to-one onto story numbers, and three predecessor stories were killed by
the Warren decision. Every clause is accounted for; clause 6 is intentionally
split into two assertion entries (Hindsight half live, Telegram half void).

| Clause | Story | Disposition | Result |
|---|---|---|---|
| *(preflight)* — toolchain + repo root | P0.11 | LIVE (fail-fast barrier) | PASS |
| 1 — merged JSON on stdout | P0.3 | LIVE (evidence-of-record) | PASS |
| 2 — ≥2 agents, ≥2 messages | P0.2 | LIVE (evidence-of-record) | PASS |
| 3 — hard cap → non-zero exit | P0.4 *killed* | **STRUCTURAL** | PASS |
| 4 — pi-lens headless | P0.5 | LIVE, scoped to 2nd branch | **SKIP** |
| 4b — LSP diagnostics + navigation | P0.6 | LIVE, **scoped** | PASS |
| 5 — Archon per-node env patch | P0.1 *killed* | **VOID** | — |
| 6 — dashboard + Hindsight plugin | P0.7 | LIVE | **FAIL** |
| 6 — dashboard + Telegram plugin | P0.8 *killed* | **VOID** | — |
| 7 — Hindsight round-trip | P0.9 | LIVE | **FAIL** |
| 7b — gitnexus analyze + queries | P0.10 | LIVE | PASS |
| 8 — OQ-1..6 decisions recorded | P0.2 | LIVE (doc check) | PASS |

### Verdict semantics (deliberate)

- **A SKIP is not a PASS.** An assertion that could not be evaluated makes the
  gate red. "Could not check" is precisely what an exit gate exists to surface;
  Phase-0's history is full of probe-passes that were not acceptance.
- **VOID clauses are excluded from the verdict** but still printed, so a reader
  can see the clause was dropped deliberately, not forgotten. VOID cannot
  launder a red gate green: a gate with zero live assertions is FAIL, never a
  vacuous PASS (`gate-runner.ts`, covered by test).

---

## 3. Blocking assertions (why Phase-0 cannot exit)

### 3.1 P0.5 — clause 4 — SKIP

```text
verifier exited 2 (fatal before checks ran):
pi-lens-verify fatal: Error: pi-lens not found in any known global node_modules dir
```

**Root cause is a defect in the P0.5 deliverable, not in the environment.**
pi-lens **is** installed on this host (3.8.71). `scripts/lsp-verify.ts` finds it
and passes 7/7, because it honours a `PI_LENS_ROOT` override
(`piLensSource: "PI_LENS_ROOT"`). `scripts/pi-lens-verify.ts` resolves
**global-only** (`resolveGlobalPiLens()` probes
`~/.local/node-{arm64,x64}/lib/node_modules/pi-lens` then `npm root -g`) and has
no override, so it cannot see an install that `pi install` places at
`~/.pi/agent/npm/node_modules/pi-lens`.

**Not fixed in this story** — `scripts/pi-lens-verify.ts` is outside P0.11's
declared Files-to-Modify list, and changing another story's verifier is scope
creep. Recommended follow-up: give `pi-lens-verify.ts` the same `PI_LENS_ROOT`
resolution `lsp-verify.ts` already has.

### 3.2 P0.7 — clause 6 (Hindsight half) — FAIL

```text
POST /api/mcp-servers -> 502:
{"ok":false,"error":"Executable not found in $PATH: \"hindsight-local-mcp\""}
```

Agent registration succeeded (201) against a live SwarmClaw; MCP-server
registration failed. `hindsight-local-mcp` is not on PATH, and per P0.7's own
story the real binary in this environment **is an HTTP server on
`localhost:8888/mcp/`, not a stdio JSON-RPC binary**. Clause 6's literal stdio
registration may therefore be **unachievable as specified**, independent of
provisioning.

### 3.3 P0.9 — clause 7 — FAIL

```text
no reachable Hindsight API at http://127.0.0.1:8888 (listBanks -> HTTP 404);
served by "Jupyter Server" — not Hindsight. OQ-4 records the local stack as
BLOCKED-on-env (arm64 libpq/openssl@3 mismatch).
```

The probe runs **through `HindsightClient.listBanks()`**, not a raw `fetch`, so
it inherits the client's bearer-token injection and base-URL normalization — a
raw probe would answer 401/403 against an authenticated instance and false-red a
healthy service.

Hindsight is not running. **PRD Appendix D already records OQ-4 as
BLOCKED-on-env**: the local stack is embedded-PostgreSQL native processes, and
an arm64 `libpq`/`openssl@3` prefix mismatch prevents boot — *"Round-trip
retain→recall→reflect unproven."* That blocker is **still open**; P0.9 did not
resolve it. Unblock is operator-side: supply arm64 OpenSSL at
`/opt/homebrew/opt/openssl@3`, point `HINDSIGHT_API_DATABASE_URL` at an external
Postgres, or re-fetch a host-matched build.

Note the default `HINDSIGHT_BASE_URL` (`127.0.0.1:8888`) collides with a Jupyter
server on this host. The gate pre-probes and reports that explicitly rather than
surfacing a confusing downstream 502.

---

## 4. Scoping decisions (what is deliberately NOT claimed)

### 4.1 P0.6 (clause 4b) — scoped, per the story's own CAUTION

P0.6's harness reports 7/7 probe passes, but four of its ACs are recorded
**story-level PARTIAL**. The gate asserts only what is actually proven:

- **Asserted:** warm `lsp_diagnostics` reflects an *uncommitted* edit
  (`editUncommitted: true`) within the latency budget
  (`warmP95Ms=422` vs `3000`), and `lsp_navigation` resolves a cross-file
  definition.
- **NOT asserted:** first-query freshness (9/20 warm samples returned the prior
  revision), the AC3 artifact half (`artifactSignalObserved: false`),
  pi-lens's internal init timeout (AC3a — unreachable), and literal sequential
  per-file RPCs (AC4 — pi-lens uses bounded concurrency).

### 4.2 P0.5 (clause 4) — scoped to the second branch

Clause 4 is an explicit EITHER/OR. OQ-2 established TDI is a **TUI
slash-command** with no headless flag, so Phase-0 took the warning-count proxy
branch. The gate asserts only that branch and does not assert the stable
finding-ID branch, which P0.5 recorded as PARTIAL (`idObserved: false` — the id
is *derived* by the harness, never assigned by pi-lens).

### 4.3 Clause 3 — STRUCTURAL, not live

P0.4 was killed, but the sprint record says the loopy-kill was *"absorbed into
launcher guards"*. Voiding clause 3 would silently retire a budget-runaway
safety property (risk R10), so it is kept live as a **structural** assertion:
the launcher declares `budgetCapUsd` + `wallClockCapMs`, and `overflow` maps to
exit 3 (non-zero). This proves the cap path exists and is correctly wired; it
does **not** prove a live loopy prompt was killed. No such run has ever been
executed in Phase-0. Labelled as STRUCTURAL in the runtime detail string.

### 4.4 Clauses 1 and 2 — evidence-of-record, not re-executed

Both are asserted against frozen runs of record
(`p0-3-live-run-2026-07-20.json`, `oq-1-smoke-run-2026-07-14.json`). These are
recordings of **real live runs**, not mocks — but re-executing them costs real
money (~$0.5 cap, ~3 min) and requires provider keys, and a gate must be safe to
re-run. Every success detail says `evidence-of-record … not re-executed by this
gate` rather than implying a fresh live proof.

---

## 5. Spec-vs-impl discrepancies found

1. **`pi-team-launch.sh` does not exist and never did.** PRD clause 1 names it;
   every reference is planning prose. P0.3 shipped the capability as the
   `cli-anything` team harness. The gate asserts the capability against the
   artifact that implements it and records the naming gap.
2. **Clause 6 names "the Paperclip dashboard".** Paperclip was superseded by
   SwarmClaw. The clause is split: Hindsight half → live SwarmClaw bridge;
   Telegram half → VOID.
3. **There is no PRD clause 9.** P0.7 and P0.9 both cite "clause 7"/"clause 9";
   only clause 7 (Hindsight round-trip) exists. Mapped accordingly.
4. **`_research/…` paths in story files** resolve to
   `_bmad-output/sprint-artifacts/_research/`; there is no repo-root `_research/`.
5. **`provision-hindsight-banks.ts` bridge probe is broken** (pre-existing, not
   touched here): `realBridgeProbe` issues **GET** against
   `/api/mcp-servers` and `/api/mcp-servers/{id}/test`, but all SwarmClaw routes
   are **POST-only** with no GET listing endpoint. Against a live SwarmClaw it
   returns 404 → `registered:false` → `-32001 "MCP bridge not registered"`, so
   that script can never succeed against a real server. Its default base
   (`:3000`) also mismatches SwarmClaw's default port (`:3100`).

---

## 6. Upstream story-status drift (flagged, not changed)

`sprint-status.yaml` marks these `done`; their story files disagree.

| Story | Board | Story file |
|---|---|---|
| P0.5 | `done` | All 9 DoD boxes **unchecked**; status *"Changes Required / Partially Approved"*; net **3 met, 4 partial, 2 not met**; MANDATORY `--mode json` agent e2e **NOT met** |
| P0.9 | `done` | All DoD boxes **unchecked**; round-trip never proven live (OQ-4 blocked) |

Per operator instruction, `sprint-status.yaml` entries for P0.5/P0.9 are **left
unchanged**; this is recorded for the story owner to act on.

Also note **pi version drift (risk R4 materialising):** installed `pi` is
**0.81.1**. OQ-5's recorded decision pins **0.55.0** and states *"re-run the load
smoke-test before adopting any pi ≥ 0.73."* That re-validation has not happened;
every P0 contract verified on 0.55.0 carries an unre-validated assumption.

And **the gitnexus index reports STALE** (surfaced in the clause-7b detail).
Clause 7b requires a non-error state and real data — both true — but FR-EX-9
makes a fresh `gitnexus analyze` a Phase-1 sequencing precondition.

---

## 7. Security invariants

- **No secrets in the report or on stdout.** The preflight assertion prints env
  var **names** only, never values. Bearer tokens are confined to the Hindsight
  client's `Authorization` header and never echoed. HTTP error text is truncated
  service-response body, not credentials.
- **The gate is NOT read-only, and the invariants now say so.** The story's
  original "read-only … never modifies protocol state" wording was **amended
  during this story** — it could not hold alongside clause 6's registration
  sequence (all SwarmClaw routes are POST-only; there is no GET listing) or
  clause 7's memory retain. The effective policy is five invariants: no
  credential writes/persistence/leakage, no destructive operations, probe writes
  identifiable, no secrets in output, and clause-6 probing restricted to a
  disposable SwarmClaw.
- **Probe-record naming differs by resource, deliberately.** The **agent** id is
  stable (`qds-phase0-gate-probe`) — registration tolerates 409, so repeated
  runs reuse one record. The **MCP-server** name is unique per run
  (`qds-phase0-gate-probe-hindsight-<pid>-<ts>`) because a stable name would 409
  with no recoverable id for `/test` and no way to clean up. That asymmetry is
  why the MCP records accumulate and the agent record does not.
- **Clause-6 capacity requirement.** One MCP record per run against
  `MAX_MCP_SERVERS = 32`, with no listing or delete route, means the probe must
  target a **disposable** SwarmClaw (in-memory stores; restart clears them).
  Against a shared long-lived instance it would eventually deny capacity to real
  registrations. The assertion detects `429` and reports capacity exhaustion
  with the remedy named. Permanent fix is an upstream lifecycle endpoint.
- No subprocess is invoked through a shell. The PATH probe inspects the
  filesystem directly rather than shelling out to `command -v`.

---

## 8. Test coverage

45 tests in `tests/gate/phase0-exit-gate.test.ts`:

- **PASS/FAIL rule** — all-green, single-red, skip-is-not-pass, void excluded,
  void check never invoked, empty gate is FAIL, all-void gate is FAIL.
- **Throwing checks** — Error and non-Error throws become red assertions.
- **Per-assertion timeout** — hang cut off, other assertions unaffected,
  duration ≥ budget.
- **Real-subprocess timeouts** (added after review) — a slow *child process* is
  preempted at the budget, `timeout_ms` overrides are honoured, and
  child-spawning checks run concurrently rather than serialised. The mocked hang
  tests could not catch the `spawnSync` event-loop-blocking class of bug; these
  do.
- **Fail-fast preflight** — downstream skipped but still listed, green preflight
  proceeds, preflight ordering independent of input order.
- **Bounded parallelism** — concurrency observed and capped.
- **Total budget** — expiry marks unfinished work without hanging.
- **Schemas** — report validates, assertion schema accepts/rejects, counts.
- **Process contract** — spawns the real gate, asserts exactly one
  `PHASE_0_GATE` marker, exit code agreeing with it, a schema-valid report file,
  and that **every blocking assertion — red *or* skipped/unproven** — is named on
  stdout with non-empty detail. (A SKIP fails the gate, so it must be as
  diagnosable as a FAIL; the assertion is scoped to both statuses, not just
  `fail`.)

Repo-wide: `bun test` → **582 pass, 3 skip, 2 fail**. Both failures are
**pre-existing and unrelated to this story**, each verified by checking out the
`origin/main` tree and reproducing the identical failure:

1. `tests/gitnexus/graph-queries.test.ts` — its fixture symbol
   (`registerSwarmClawAgent`) is filtered out of the standing index by
   gitnexus's default `fixtures/` ignore rule.
2. `cli-anything/test/runner-integration.test.ts` — the worker-timeout case
   (AC3). Fails 3/3 on this host and reproduces on `origin/main`; this PR
   touches **zero** files under `cli-anything/`.

`bunx tsc --noEmit` clean. `biome check` clean on all new files.

---

## 9. Known limitations

1. Clauses 1 and 2 read frozen artifacts rather than re-running paid live runs.
2. Clause 3 is structural; no live loopy-prompt kill has been demonstrated.
3. Clause 4 (P0.5) cannot run until `pi-lens-verify.ts` learns `PI_LENS_ROOT`.
4. The gate does not start services. If SwarmClaw is down it reports so, with
   the exact command to start it, rather than starting it silently.
5. `pi-lens-verify.ts`/`lsp-verify.ts` are spawned as children (never imported):
   both mutate `PILENS_DATA_DIR` on the current process.
6. **The gate is sensitive to host load.** The P0.6 assertion drives a real LSP
   server (cold start + 20 freshness-gated warm samples) and is budgeted at
   195 s. On a saturated host it legitimately exceeds that and is reported as
   `timed out after 195000ms` — a red assertion, not a hang. Observed on this
   host at load average ~20 (unrelated VM/AV/sync processes): the same gate that
   reports `7 pass / 2 fail / 1 skip / 2 void` on an idle host reports
   `6 pass / 3 fail / 1 skip / 2 void`, with P0.6
   as the extra red. **This is the gate behaving correctly** — "could not verify
   within budget" is not the same as verified — but it means a CI runner should
   be given adequate CPU, and a red P0.6 should be checked against host load
   before being read as an LSP regression. The committed
   `phase0-gate-report.json` is from an idle-host run.
7. **The process-contract test inherits that load sensitivity.** It spawns the
   real gate, so its wall-clock is the gate's: ~20 s for the suite on an idle
   host, but observed at 578 s under load ~10, and one run failed outright when
   the spawned gate exceeded the test's 870 s child budget. That failure surfaces
   as the explicit `expect(run.error).toBeUndefined()` assertion rather than a
   confusing marker mismatch, which is the intended diagnosis path — but it does
   mean the gate suite is not suitable for a CPU-contended CI runner without
   raising the child budget or gating the integration layer behind a
   capability probe (the convention `tests/lsp-verify.test.ts` uses).
8. **The total budget is not a hard ceiling.** Once `totalTimeoutMs` (600 s)
   expires the runner stops the pool claiming new work and reports immediately,
   but an assertion already in flight cannot be cancelled — a JS promise has no
   interrupt. Under the load event above the process ran ~938 s before exiting,
   having already written its report at the budget. A wall-clock guarantee would
   need the whole gate re-parented into a killable subprocess.

---

## 10. Reproduce

**Preconditions:** `bun`, `node`, `git`, `gitnexus` on PATH. Optionally:
pi-lens (`pi install npm:pi-lens`, then export
`PI_LENS_ROOT=~/.pi/agent/npm/node_modules/pi-lens`); SwarmClaw
(`SWARMCLAW_PORT=3100 bun src/swarmclaw/index.ts`); a reachable Hindsight API.

```bash
bun scripts/phase0-exit-gate.ts
# -> per-assertion table, PHASE_0_GATE: PASS|FAIL, exit 0|1
# -> report at _bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json

bun test tests/gate/          # 45 tests
```

**To close the gate**, in dependency order:

1. Unblock OQ-4 / stand up Hindsight → fixes clause 7, and enables clause 6 once
   an MCP-speaking Hindsight endpoint exists.
2. Resolve whether `hindsight-local-mcp` can speak stdio, or amend clause 6 to
   the transport that actually exists → fixes clause 6.
3. Teach `pi-lens-verify.ts` `PI_LENS_ROOT` resolution → fixes clause 4.
4. Re-run `gitnexus analyze` (staleness) and re-validate the pi 0.55.0 → 0.81.1
   drift per OQ-5 before any Phase-1 story executes.
