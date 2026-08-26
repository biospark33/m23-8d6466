---
baseline_commit: 86a4865c54a5436934092b003f0857cd6e1a496f
---

# DF1.2: Gates with Evidence over a Unified Envelope Adapter

**Story Points:** 4
**Sprint:** v5-S1 (track A, engine; after DF1.1)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3 (adopt list: envelope adapter, gates with evidence), §5.2 (observability — per-check gate evidence), §8 step 1
- Decision register: v5 §4 D6 (SSSF design ported to TypeScript test-first), D10 (Python engine reference only)
- Contracts: v5 §5.2 — per-check gate evidence; step output schema (CC-1 `exitStatus`)
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8

## User Story

As a factory engineer,
I want every gate check to record its evidence on pass as well as on fail, and deterministic subprocess results wrapped as envelopes indistinguishable from agent reports,
so that a green gate says what it verified and a failing test run travels back to the builder through exactly the same door a reviewer agent's report uses.

## Overview

A gate is `gate(envelope, run) -> GateReport`. `GateReport.check(item, ok, note)` appends
one `GateCheck` per item examined and returns itself; `violations` and `passed` are
**derived** from those checks and are never authored. `asEnvelope(result, label)` wraps a
deterministic subprocess outcome — a test run, a lint pass, a `git diff` — into the same
`Envelope` type an agent produces, so the repair loop has one code path instead of two.
The gate library is mechanical only: artifact existence, non-emptiness, JSON parse,
diff-matches-claims, review self-consistency, and a `commandGate(argv)` factory that the
existing pi-lens (P0.5), lsp-verify (P0.6), and P1.7 verifiers plug into unchanged. This story
closes the wiring between DF1.1's lifecycle and the evidence a phase must earn to succeed.

## E2E Slice

**Demonstrable behavior:** a **two-phase** manifest, because the two halves of AC4 cannot both be
shown in one phase: a gate that fails throws out of its phase body and DF1.1 AC6 halts the walk
there, so any phase that must *receive* a `previous:` envelope has to run **before** the gate fires.

Phase 1 is a `code` phase whose command is a deliberately failing test script and on which **no
gate is registered**. It produces a `QualityCheckResult` with a non-zero exit code; because a
failing *block* is data, **no `GateReport` is constructed and no `gate_fail` is emitted**, and the
**phase reads `success`** (AC4 first half). `asEnvelope(result, "tests")` wraps that result and the
engine hands it to phase 2 through the identical `previous:` slot that carried the prior agent
report — the envelope's `outputTail` holds the last 4,000 characters of stdout+stderr verbatim and
redacted, and is readable by phase 2's body, which asserts it.

Phase 2 has a `commandGate` registered over that same failing script. The gate examines the one
item it is defined over — the command's exit code — and records exactly **1** `GateCheck`,
`ok: false`, so the `GateReport` derives `violations.length === 1` and `passed: false`. A
`gate_fail` event carrying the full `checks` array and the derived `violations` array is persisted
through DF1.1's `PhaseJournal` port, the gate throws out of the phase body, and the **phase reads
`fail`** (AC4 second half). The walk halts there, which is correct and expected: phase 2 is the
last declared phase, so no phase is skipped by the halt and DF1.1 AC6's absence rule is not in
tension with this slice.

One `commandGate` produces one check, so the slice asserts 1/1 and nothing else: the
multi-item shape AC1 is written against (4 checks, 1 violation) comes from a gate defined over
a set — `artifactsExist` over four declared artifacts — and is a unit test in
`tests/phase-engine/gates.test.ts`, not this slice. Reports are never merged across gates:
each registered gate yields its own `GateReport`, and a phase fails if any of them is
`passed: false`. A `GateReport` is never created implicitly from a bare code command — phase 1
proves it by emitting none.

**Wiring closed:** On completion of this story, gate evidence and the envelope adapter are
real using only code merged by this story plus DF1.1's phase lifecycle. No stub, no
`TODO: wire later`, and no sibling story is required. The repair loop's *retry bounding* is
DF1.3's; this story delivers the envelope that the retry re-sends.

**Dependency edges (predecessors):** DF1.1. Gate **sources** plug in here without
modification: `scripts/pi-lens-verify.ts` (P0.5, `in-review` per issue #51/PR #98 — this
story needs only the script's exit code), `scripts/lsp-verify.ts` (P0.6), and P1.7's
post-edit `lsp_diagnostics` gate.

## Acceptance Criteria

1. **(make-or-break)** Given a gate that examined 4 items of which 1 failed, When the
   `GateReport` is persisted, Then **both** the full `checks` array (4 entries, each
   `{item, ok, note}` with `note` populated on passes as well as failures) and the derived
   `violations` array (1 entry, `"item: note"`) are written, and `passed` is computed as
   `checks.length > 0 && violations.length === 0` — a report that examined nothing is
   `passed: false` (INV-5), and no API accepts an authored violations list.
2. Given a deterministic subprocess result, When `asEnvelope(result, label)` runs, Then it
   returns the same `Envelope` type an agent report produces, such that a consumer reading
   only the envelope cannot tell which produced it, and the phase call site passes it
   through the identical `previous:` slot.
3. Given a review envelope with `approved: true` that also carries a blocking item, or
   `approved: true` with an unmet `ReviewFinding.met === false`, or `approved: false`
   naming neither a blocking item nor an unmet requirement, When `verdictConsistent` runs,
   Then the envelope is refuted — judged against itself, without reading a line of the diff.
4. Given a `code` block whose command exits non-zero, When the phase completes, Then the
   **phase** status is `success` and the **run** is not accepted (DF1.1 phase-vs-run rule) —
   but given a gate registered on that phase whose report is `passed: false`, Then the gate
   throws out of the phase body and that phase reads `fail`: a failing *block* is data, a
   failing *gate* is a phase failure.
5. Given a gate whose subprocess cannot be executed at all (binary missing, spawn error),
   When the gate runs, Then it records a failed check naming the spawn error and the gate
   report is `passed: false` — an unavailable gate never resolves as pass or as skip.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `Run.phase({gates:[...]})` from DF1.1's lifecycle | in-scope | `tests/phase-engine/gates.test.ts` | — |
| `commandGate(argv)` wrapping `scripts/lsp-verify.ts` (P0.6) | in-scope | `tests/phase-engine/command-gate.test.ts` | — |
| `commandGate(argv)` wrapping `scripts/pi-lens-verify.ts` (P0.5) | in-scope | `tests/phase-engine/command-gate.test.ts` | — |
| P1.7 post-edit `lsp_diagnostics` emit gate | in-scope (registration path only; waiver policy stays P1.7's) | `tests/phase-engine/command-gate.test.ts` | — |
| gate-violation retry bounding | out-of-scope | — | DF1.3 |
| gate evidence rows in the SQLite trace store | out-of-scope | — | DF1.4 |
| host-side re-run of these gates outside the box | out-of-scope | — | DF5.1 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF1.1 phase lifecycle + `PhaseJournal` port | in-repo `src/phase-engine/` | `bun test tests/phase-engine` green before this story starts |
| secret redaction module | existing `cli-anything/src/redact.ts:62` (`redactSecrets`) | imported at module load; redaction unit test runs in this story's suite |
| pi-lens MCP server (P0.5/P0.6 gate sources) | `pi-lens-mcp` over stdio, driven by the existing verifier scripts | `commandGate` spawn smoke test asserts that a verifier binary which cannot be spawned at all (AC5's missing-binary/spawn-error case) is surfaced as a **failed check**, never as a pass or a skip — distinct from a spawned verifier that runs and exits non-zero, which is the ordinary failed-check path |

## Technical Notes

- **Contracts/Schema (new, owned by this story):**
  `GateCheck { item: string, ok: boolean, note: string }`;
  `GateReport { checks: GateCheck[], check(item, ok, note): this, get violations(): string[], get passed(): boolean }` — at `src/phase-engine/gates/report.ts`, a **distinct type** from P0.11's chassis `GateReport` (`src/gate/gate-runner.ts:117`, `overall`/`assertions` shape), which this story does not touch;
  `QualityCheckResult { name, command: string[], exitCode: number, outputTail: string, outputArtifact: string, spawnEnv: Record<string, string> }`;
  `Envelope { kind, label, status: ExitStatus, summary, outputTail?, artifacts?, approved?, blocking?: string[], findings?: ReviewFinding[] }`; `ReviewFinding { requirement: string, met: boolean, note: string }`; DF1.1's `PhaseParams` gains `previous?: Envelope` — the one slot AC2 and AC3 are written against.
  Pattern sources: `MOD/data_types.py:252-283`, `:107-120`, `MOD/quality.py:193-211`,
  `MOD/changes.py:87-103` (`MOD/` = `SSSF/templates/adws/adw_modules/`, R4 §1.3–1.4; D10 —
  read, never vendored). `exitStatus` values import from `cli-anything/src/types.ts:79` (CC-1).
- **`src/phase-engine/types.ts` is shared — region ownership.** DF1.1 creates the file and owns the
  `PhaseSpec`/`PhaseParams` types, the `retries: 0..5` bound, `PARSE_FIX_ATTEMPTS`, and
  `PhaseParams.agent`. This story **adds only** `PhaseParams.previous?: Envelope` and edits none of
  DF1.1's declarations; DF1.3 adds only its retry-loop types, DF1.4 only its trace/event types, and
  DF1.8 only its issue-correlation types. Five stories touch one file; each appends its own region,
  so the merges are additive and no declaration has two authors. (The `Envelope` type itself lives
  in this story's `src/phase-engine/envelopes/types.ts`, not in the shared file.)
- **The adapter invariant, stated once:** agents hand each other typed envelopes; code
  blocks return `QualityCheckResult`. `asEnvelope` is the adapter, so a failing lint or test run
  flows back into the builder through exactly the same door a tester agent's report used to
  — **the pipeline script is the only thing that knows the difference**
  (`MOD/data_types.py:240-244`, `MOD/quality.py:196-199`).
- **`outputTail` is deliberately raw:** it carries the tail of stdout+stderr verbatim and
  unparsed — the next agent cannot open a log file it was never handed, and a generic parser
  over every runner's failure format would be confidently wrong (`MOD/data_types.py:158-163`;
  `TAIL_CHARS = 4_000` at `MOD/quality.py:46`). The 4,000-character ceiling is **inclusive of
  any truncation suffix**: reserve the suffix width before cutting, append `[truncated, N
  chars total]`, so `outputTail.length <= 4000` always holds (suffix-inclusive rule form
  carried from `p1-6-pi-team-protocol-step.md:65`). The full log stays at `outputArtifact`.
- **A failing *block* does not fail the phase; a failing *gate* does** (`MOD/quality.py:216-219`, `MOD/agents.py:163-165`): a non-zero block exit is data — the runner did its job and run acceptance is DF1.1's `finish(accepted)` argument. A registered gate whose report is `passed: false` raises out of the phase body once DF1.3's retry budget is exhausted (unbounded here, so on first failure), landing in DF1.1's `except` branch, which leaves the phase `fail`. Gates are not a reporting side channel.
- **Gate library (all mechanical):** `artifactsExist` (existence, size as evidence),
  `filesNonEmpty`, `jsonParses` (note names the parsed type), `diffMatchesClaims` (every
  file claimed changed exists), `verdictConsistent`, and the `commandGate(argv)` factory —
  exit 0 required, and on failure the last 1,000 characters ride along as the note
  (`MOD/gates.py:27-108`).
- **Design boundary, binding on reviewers of this story:** gates check what is **mechanically
  checkable**; plan quality is a reviewer's job (`MOD/gates.py:8`). A proposal to add a
  semantic-quality gate here belongs in a review phase, not in this library.
- **Gate-source integration is registration, not reimplementation:** P0.5's
  `scripts/pi-lens-verify.ts` (646 lines) and P0.6's `scripts/lsp-verify.ts` (1,418 lines)
  already drive pi-lens MCP over stdio and emit machine-readable results. They plug in as
  `commandGate([...argv])` — exit code as the check, stdout tail as the note. No second copy.
- **Deviation/assumption:** `commandGate` treats a non-zero exit as a failed check for every
  source. P1.7's graceful degradation (`waiverReason: 'no-lsp'` when no LSP server exists for
  a language) stays inside `scripts/lsp-verify.ts`, expressed to the gate as an exit code that
  story already defines. A source needing a third outcome widens `GateCheck` rather than
  adding a skip path — a gate that can resolve as "skip" is how a green report means nothing.

## Observability Contract

- Every gate run emits `gate_pass` / `gate_fail` carrying `{ requestId, phase, attempt, violations, checks }` (`MOD/agents.py:154-158`); at this story they persist through DF1.1's file-backed `PhaseJournal` port — the `gate_results` SQLite rows are DF1.4's
- `requestId` propagates unchanged from DF1.1's phase record; errors include `{ code, message, stack? }`
- Sub-timings: `gate_exec_ms`, `gate_report_ms`. A gate that did not run reports `0`; `durationMs` is authoritative where a breakdown is unavailable.

## Files to Modify

- `src/phase-engine/gates/report.ts`
- `src/phase-engine/gates/library.ts`
- `src/phase-engine/gates/command-gate.ts`
- `src/phase-engine/envelopes/types.ts`
- `src/phase-engine/envelopes/adapter.ts`
- `src/phase-engine/types.ts` (**adds only `PhaseParams.previous`** — see the region-ownership note)
- `src/phase-engine/index.ts`
- `tests/phase-engine/gates.test.ts`
- `tests/phase-engine/envelope-adapter.test.ts`
- `tests/phase-engine/command-gate.test.ts`
- `tests/phase-engine/fixtures/review-envelopes.json`

## Security Invariants

- INV-1: `commandGate` spawns with an explicit **argv array**, never a shell string, and the
  argv originates either from a schema-validated DF1.1 manifest `command` or from repo code
  at the registration site — never from agent output, an envelope field, or a gate note.
- INV-2: `outputTail` passes through `redactSecrets(text, parentEnv)`
  (`cli-anything/src/redact.ts:62`) **before** it enters an envelope, a gate note, or the
  journal — otherwise a printed provider key lands in the next agent's context window and in
  the trace read by the visualizer (DF4.1) and the audit chain (DF5.3). That function is
  **parent-env-derived, not pattern-based**: it masks only values ≥8 chars held under a
  `SECRET_KEY_RE`-matching env name, so the adapter MUST be handed the same env map the
  subprocess was spawned with. Redaction happens at the adapter boundary, once.
- INV-3: Gate reads of declared artifacts (`artifactsExist`, `filesNonEmpty`, `jsonParses`)
  use DF1.1's beneath-root walk anchored at the **same** pinned run root the phase used, and
  read through the resolved handle rather than re-opening by string. Validating against one
  root and reading under another is the traversal hole the walk exists to close
  (`p1-6-pi-team-protocol-step.md:110-113`). This story implements **no** path-resolution
  mechanism of its own: it calls DF1.1's, in whichever of the two permitted forms DF1.1 ships
  (component walk, or `fs.realpath` + run-root prefix re-assertion + read through the resolved
  fd — DF1.1 INV-1). A second, weaker resolver in this diff is a defect.
- INV-4: `violations` and `passed` are derived properties over `checks`. There is no
  setter, no constructor parameter, and no deserialization path that accepts a
  violations array — an agent cannot hand the harness a self-certified clean gate report.
- INV-5: **Fail closed.** An envelope refuted by `verdictConsistent` is refuted regardless
  of its `approved` flag; a gate whose subprocess cannot be spawned records a failed check
  rather than a skip; and a gate report with zero checks is `passed: false`, because a gate
  that examined nothing has verified nothing.
- INV-6: `QualityCheckResult.spawnEnv` is **redaction input only**. It holds the provider
  credentials the subprocess was spawned with, so it is passed to `redactSecrets` and then
  dropped: it is never journaled, never traced, never placed on an `Envelope`, and never
  reaches `JSON.stringify` of a persisted record. A `QualityCheckResult` crossing a
  serialization boundary crosses it without that field.

## Definition of Done

- [x] **Impl:** `GateReport.check()` appends one `GateCheck` per item examined and returns `this`; `note` is populated on passes as evidence, not only on failures.
- [x] **Impl:** `asEnvelope` returns the same `Envelope` type an agent report produces, and the phase call site passes it through the identical `previous:` slot.
- [x] **Impl:** `verdictConsistent` implements all three refutation rules (approved-vs-blocking, approved-vs-unmet-findings, rejection-names-no-problem).
- [x] **Contract:** Six gates shipped (`artifactsExist`, `filesNonEmpty`, `jsonParses`, `diffMatchesClaims`, `verdictConsistent`, `commandGate`); `commandGate` takes an argv array (INV-1).
- [x] **Integration:** `scripts/pi-lens-verify.ts` (P0.5) and `scripts/lsp-verify.ts` (P0.6) register as command gates with zero edits to either script.
- [x] **Security:** `outputTail` is redacted at the adapter boundary and bounded to 4,000 characters including the truncation suffix (INV-2).
- [x] **Test (unit):** A `code` block exiting 1 leaves the phase `success` while the run is not accepted; a gate reporting `passed:false` on that same phase leaves it `fail`. All three assertions in one test so the trio cannot drift.
- [x] **Test (self-consistency, negative control):** An envelope with `approved: true` carrying one blocking item is refuted. A gate implementation that reads only the `approved` flag passes this envelope and MUST fail this test.
- [x] **Test (redaction):** With `ANTHROPIC_API_KEY=sk-ant-<token>` in the spawn env, a subprocess printing that token → the resulting envelope's `outputTail` contains `[REDACTED:ANTHROPIC_API_KEY]` and zero characters of the token; assert against the envelope, not the log file. An adapter that forgets the env argument MUST fail this test. **Additionally:** a secret present **only** in a custom `spawnEnv` (absent from the parent process env) and printed by the subprocess → the token is redacted in `outputTail`; an adapter that redacts from `process.env` instead of the passed `spawnEnv` MUST fail this test.
- [x] **Test (spawnEnv no-persist, negative control — INV-6):** a sentinel value placed in `spawnEnv` under a `SECRET_KEY_RE`-matching name → the persisted `gate_fail` event, the journal row, and the produced `Envelope` contain zero occurrences of the sentinel and no `spawnEnv` key at all. An implementation that serializes `QualityCheckResult` wholesale MUST fail this test.
- [x] **Test (empty gate, negative control):** A `GateReport` on which `check()` was never called is `passed: false` and its `violations` array is empty — an implementation computing `passed` as `violations.length === 0` alone reports this vacuous report as green and MUST fail this test (AC1, INV-5).
- [x] **Test (multi-item evidence, AC1):** `artifactsExist` over four declared artifacts of which one is missing → `checks.length === 4` (each with a populated `note`, passes included), `violations.length === 1`, `passed: false`.
- [x] **Test (e2e demo — MANDATORY):** the two-phase slice end to end. Phase 1 (failing test command, **no gate registered**) reads `success`, emits **no** `gate_fail` and constructs **no** `GateReport`, and its `asEnvelope` result — redacted `outputTail` included — is read out of phase 2's `previous:` slot by phase 2's body. Phase 2 (**`commandGate` registered** over the same command) produces a persisted `gate_fail` event whose `checks` array holds the single exit-code check and whose 1-entry `violations` array is derived from it, and reads `fail`. Both halves of AC4 in one run; a single-phase variant cannot show the `previous:` handoff and MUST NOT be substituted.

## Dev Agent Record

**Status:** done — PR #110 merged 2026-08-15 (`c8c5b26`); local gates green at merge (bun test 1383 pass / 0 fail incl. 42 new DF1.2 tests, tsc clean, biome clean). The PR reference was added in the 2026-08-26 artifact audit.

**Implementation Plan → what shipped:**

- `src/phase-engine/gates/report.ts` — `GateCheck` / `GateReport`. `violations` and `passed` are getters over a private checks array; the only entry is `check()`. There is no constructor parameter, setter, or deserialization path that accepts a violations list (INV-4). Hardening over the SSSF source, per this story's INV-5: `passed = checks.length > 0 && violations.length === 0` — the SSSF original (`MOD/data_types.py:264-283`) passes vacuously on zero checks; that door is closed here.
- `src/phase-engine/gates/library.ts` — `Gate`/`GateContext`, the five mechanical gates (`artifactsExist`, `filesNonEmpty`, `jsonParses`, `diffMatchesClaims`, `verdictConsistent`), `GateFailureError`, and the `gatedBody(journal, gateCtx, gates)` composition wrapper. SSSF note semantics ported verbatim (pass notes carry evidence: `exists, 2.1KB`, `parses, object`, `exit 0`; `verdictConsistent` uses the three fixed item labels). Artifact reads resolve run-root-relative, then go through `readArtifactBeneathRoot` — DF1.1's four-step walk, never a second resolver (INV-3).
- `src/phase-engine/gates/command-gate.ts` — `commandGate(argv, opts)` factory. `Bun.spawn` with an argv array, never a shell string (INV-1). Exit 0 → one passing check; failure → `exit N` + last 1,000 chars of stdout+stderr, redacted with the spawn env (INV-2). A spawn that cannot start at all (missing binary, spawn error) records a failed check naming the error — never a pass, never a skip (AC5).
- `src/phase-engine/envelopes/types.ts` — `Envelope` (single unified type; `kind` deliberately does NOT distinguish deterministic vs agent sources — AC2), `ReviewFinding`, `QualityCheckResult` (`spawnEnv` documented as redaction-input-only, INV-6).
- `src/phase-engine/envelopes/adapter.ts` — `asEnvelope(result, label)` + suffix-inclusive `truncateTail` (ceiling 4,000 including `[truncated, N chars total]`). Redaction runs BEFORE truncation so a token split by the cut can never leak a partial (INV-2); `spawnEnv` never enters the envelope (INV-6).
- `src/phase-engine/types.ts` — DF1.2 region only: `PhaseParams.previous?: Envelope` (type-only import; no cycle — envelopes/types.ts imports ExitStatus directly from cli-anything).
- `src/phase-engine/index.ts` — barrel exports for everything above.
- `src/phase-engine/manifest.ts` — two additions, both documented in place: (1) `readArtifactBeneathRoot` — the same four-step walk parameterized for gate artifact reads, so gates call DF1.1's mechanism rather than grow a second resolver; (2) a darwin `fdRealPath` repair — see Debug Log.

**Wiring decision (deviation, justified):** the story's Trigger Surface says `Run.phase({gates: [...]})`, but Files-to-Modify omits `phase.ts` (DF1.1-owned; five stories already share `types.ts` by region). Resolved in favour of zero phase.ts edits: `gatedBody(journal, gateCtx, gates)(body)` composes gates onto any phase body — the gate throws out of the phase body (AC4 literal), `gate_pass`/`gate_fail` persist through DF1.1's `PhaseJournal.writeGateEvent`, and the call site remains "the only thing that knows the difference" between code and agent envelopes. The E2E slice proves the whole chain.

**Schema addition (deviation, justified):** `Envelope.changedFiles?: string[]` — the story's contract listing omits it, but `diffMatchesClaims` (DoD: "six gates shipped") examines "every file claimed changed"; without the field the gate is dead code. One optional field, additive.

**Integration caveat:** pi-lens (P0.5) and lsp-verify (P0.6) are exercised at the registration path only (both scripts exist unchanged, register as `commandGate([process.execPath, script, "--json"])`). Live spawns were not run in the unit suite — each script has its own verify entry point (`verify:pi-lens`, `verify:lsp`) and takes minutes; `commandGate`'s behaviour over a subprocess exit code is covered exhaustively by the other command-gate tests. Zero edits to either script, as required.

**Debug Log:**

- Three SSSF semantics were hardened per this story's binding text (D10 — port, don't vendor): empty-report vacuous pass → `passed: false` (INV-5); `tests_pass(shell=True)` → argv array (INV-1); raw 4,000-char slice → suffix-inclusive ceiling.
- **Pre-existing DF1.1 defect found and fixed: darwin/arm64 fd-path verification was dead.** `bun:ffi`'s fixed-arity trampoline cannot express `fcntl`'s variadic ABI on arm64 — `F_GETPATH` "succeeds" (rc 0) writing nothing, so `loadDarwinFcntl`'s own probe correctly returned null and every real read failed closed: on this machine `loadManifest` refused ALL manifests, and DF1.1's "the platform fd-path facility really resolves a known fd" test failed on a clean main (verified before any DF1.2 edit). Fix: darwin branch now falls back to `proc_pidfdinfo(PROC_PIDFDVNODEPATHINFO)` — fixed-arity, same fact (the fd's own path), probe-validated at bind time against `/` so an SDK layout change degrades to refusal, never to a wrong path. Layout verified against the SDK's `sys/proc_info.h` and empirically (`sizeof(vnode_fdinfo)` = 176). Linux untouched (`/proc/self/fd`). Impact on `readBeneathRoot` pre-approved LOW via GitNexus (1 direct caller).
- **Pre-existing hang found: Bun 1.2.22 `fs.realpathSync` blocks forever on a FIFO** on the path — the loader's own "a FIFO is refused instead of blocking" test hung the whole phase-engine suite (reproduced on clean main; `sample` showed main thread blocked in `openat` under `realpath`). Fixed with `realpathNoOpen` in `manifest.ts`: Node's recursive lstat/readlink realpath algorithm (parent-first, symlink targets re-walked from root, 40-hop ELOOP ceiling) — never `open(2)`, so a planted FIFO can no longer hang resolution. Both `readBeneathRoot` and `readArtifactBeneathRoot` use it.
- Gate artifact paths were initially resolved against cwd; envelope artifacts are run-root-relative — fixed by resolving against the pinned `runRoot` before the walk (keeps the walk itself unchanged).

**Completion Notes:** All six DoD-negative controls pass: empty-gate (INV-5), approved-flag-only self-consistency, redaction-from-spawnEnv-not-process.env, spawnEnv no-persist (envelope + persisted journal + gate event), shell-metacharacter argv literalness, missing-binary spawn error. The mandatory two-phase E2E slice runs in `tests/phase-engine/gates.test.ts`: phase 1 (failing command, no gate) → `success`, zero gate events, envelope via `asEnvelope`; phase 2 reads `previous:` and carries `commandGate` over the same command → persisted `gate_fail` (1 check, 1 derived violation), phase `fail`, run halted, sentinel absent from the journal. 42 new tests across three files + fixtures.

**Review fixes applied (self-review pass, 2026-08-15):**
1. [INVARIANT] `gatedBody` keyed the throw on `violations.length > 0` — a zero-check report (`passed: false`, empty violations) journaled `gate_fail` and then let the phase succeed. Now keyed on `passed`; a zero-check failure throws with `"<gate>: examined nothing"`. Regression test added (vacuous gate through `gatedBody` → phase `fail`).
2. [SECURITY] `commandGate` truncated the note window BEFORE redacting — a secret straddling the cut leaked its partial suffix into the journal. Now redacts the full output first, then slices the last 1,000 (same order as the adapter).
3. [SECURITY] `jsonParses` note now routes the raw parse-error text through `redactSecrets` (parse errors echo the artifact's own text).
4. [DESIGN] `commandGate` redaction env is now `opts.env ?? ctx.env ?? parent` (it ignored `GateContext.env`, whose doc says it is the redaction input).
5. Signal-death exit (`proc.exited` = null) renders `exit -1` instead of `exit null`.
Reviewer verdict was FIX-FIRST on 1+2; both applied and re-verified. Findings 6-10 (NIT/RISK) accepted as documented trade-offs: read-failure notes keep the SSSF wording (fail-closed holds, cause granularity deferred), `readArtifactBeneathRoot` shares primitives with the manifest walk by living in the same module (structural dedup deferred to avoid reworking DF1.1 seams), `looksLikeEnvelope` duck-check is contained (worst case a fail, never a false pass).

### Review Findings (BMad 3-layer review, 2026-08-15: Blind Hunter + Edge Case Hunter + Acceptance Auditor)

Auditor: 0 findings — all 5 ACs, 6 invariants, 13 DoD items verified satisfied. Blind+edge layers raised 33; triage: 5 patch, 28 dismissed as noise/documented fail-closed designs.

- [x] [Review][Patch] `commandGate` empty argv → explicit failed check "argv is empty" (fail-closed already via spawn error, but evidence should say why) [src/phase-engine/gates/command-gate.ts:50]
- [x] [Review][Patch] Signal death renders `exit -1` without naming the signal — use `proc.signalCode` for truthful evidence + add test [src/phase-engine/gates/command-gate.ts:98]
- [x] [Review][Patch] `filesNonEmpty` passes on impossible-but-corrupt negative `stat.size` (`!== 0` → `> 0`) [src/phase-engine/gates/library.ts:106]
- [x] [Review][Patch] `gate_report_ms` hardcoded 0 though gate ran — measure report derivation [src/phase-engine/gates/library.ts:268]
- [x] [Review][Patch] Fully-redacted command output yields empty diagnostic tail — fall back to "(all output redacted)" [src/phase-engine/gates/command-gate.ts:99]
