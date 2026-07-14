# P0.1: CLI-Anything Harness Generator + Env Propagation to Warren Run

**Story Points:** 3

## Spec Reference

- PRD §4.4 (per-node env injection); FR-OR-4
- Phase exit gate: PRD §13 Phase-0 clause 5 (env reaches subprocess)

## User Story

As a SwarmClaw protocol operator,
I want the CLI-Anything harness to generate `warren run` commands that propagate per-step environment variables into the Warren subprocess,
so that secrets, model configs, and run-scoped context reach Pi agents inside the burrow (FR-OR-4, G1).

## Overview

The CLI-Anything harness is a manifest-driven generator (`manifest.yaml`) that wraps `warren run` invocations into structured, agent-controllable commands. This story delivers the harness skeleton plus the critical env-propagation path: SwarmClaw protocol step config → CLI-Anything manifest env block → `warren run` subprocess env → Pi agent env. Cuts CLI-Anything layer only (no SwarmClaw protocol, no Pi internals). 3 pts because it is a single concern (env reachability) with one integration seam.

## E2E Slice

**Demonstrable behavior:** A CLI-Anything harness invocation with `env: { QDS_PROBE: "x7" }` in its manifest generates and executes a `warren run` command; the subprocess echoes `$QDS_PROBE` into its stdout, which equals `x7`. A second invocation with no env block still inherits parent-env `$PATH` (non-empty).

**Wiring closed:** On completion of this story, running `cli-anything run --manifest test-env.yaml` produces stdout containing `QDS_PROBE=x7` for the env-bearing manifest and a non-empty `PATH` for the bare manifest, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

1. **(make-or-break)** Given a manifest.yaml with `env: { QDS_PROBE: "x7" }`, When `cli-anything run --manifest test-env.yaml` executes, Then the subprocess stdout contains `QDS_PROBE=x7` (env reaches Warren subprocess).
2. Given a manifest.yaml with no `env` block, When `cli-anything run --manifest test-bare.yaml` executes, Then the subprocess stdout contains a non-empty `PATH` value (parent env inherited, non-regression).
3. Given a manifest.yaml with `env: { PATH: "/evil" }`, When `cli-anything run` executes, Then the subprocess inherits parent `PATH` plus `/evil` appended (merge, not replace).

## Technical Notes

- **Contracts/Schema:** CLI-Anything `manifest.yaml` schema: top-level `name` (string), `command` (string template), `env` (optional `Record<string, string>`), `args` (optional string array). Env block is merged into subprocess env as `{ ...process.env, ...manifest.env }` — never bare assignment (see env-merge safety rule, CORRECTNESS-A).
- **Integration points (each wired & exercised in this story):** manifest.yaml parse → env block extraction → `child_process.spawn` with merged env → Warren subprocess receives env → stdout captured and returned as structured JSON.
- **Files / functions touched:** `cli-anything/src/manifest.ts` (parse), `cli-anything/src/runner.ts` (spawn with env merge), `cli-anything/src/index.ts` (CLI entry).
- **Guards/limits:** Wall-clock timeout on harness invocation (default 10 min); structured JSON output on stdout (exit_class, stdout_excerpt, env_probe_result).

## Files to Modify

- `cli-anything/src/manifest.ts`
- `cli-anything/src/runner.ts`
- `cli-anything/src/index.ts`
- `cli-anything/src/types.ts`
- `cli-anything/package.json`
- `cli-anything/test/manifest.test.ts`
- `cli-anything/test/runner.test.ts`
- `cli-anything/test/fixtures/test-env.yaml`
- `cli-anything/test/fixtures/test-bare.yaml`

## Security Invariants

- **INV-1:** Env injection is a MERGE `{ ...process.env, ...manifest.env }` — a manifest with no `env` block still inherits parent `PATH`/credentials (non-regression). Bare assignment is prohibited at compile time (review checklist).
- **INV-2:** No secret value is written to stdout, logs, or the structured output. Redaction is a HEURISTIC over PARENT-process env values: a value is redacted from `stdout_excerpt`/`env_probe_result` only when its env key matches `SECRET_KEY_RE` (secret-name patterns) AND the value is ≥8 chars. Manifest-supplied env values are operator-trusted input and are NOT redacted — AC1 requires the `QDS_PROBE` value to appear verbatim in stdout. The harness logs key names only, never values.
- **INV-3:** Log output is minimal — env key names only, never values, and capped at 50 key names per log line. The subprocess inherits the full merged env per INV-1 (`{ ...process.env, ...manifest.env }`), but the harness logs only env key names, not values. No wholesale `process.env` dump into log output or structured result.

## Definition of Done

- [x] **Impl:** CLI-Anything manifest parser extracts `env` block from YAML; runner spawns Warren subprocess with merged env.
- [x] **Impl:** Structured JSON output schema (exit_class, stdout_excerpt, env_probe_result) emitted on harness stdout.
- [x] **Contract:** manifest.yaml TypeScript type with field-level validation (name required, command required, env optional Record<string,string>).
- [x] **Integration:** `cli-anything run --manifest` → Warren subprocess receives merged env → stdout captured — wired and exercised.
- [x] **Security:** Env merge is additive (`...process.env, ...manifest.env`), tested with a bare manifest (non-regression) and an override manifest (merge precedence).
- [x] **Test (unit):** manifest parser validates well-formed and malformed YAML; runner constructs correct spawn options.
- [x] **Test (integration):** `cli-anything run --manifest test-env.yaml` produces stdout containing `QDS_PROBE=x7`.
- [x] **Test (e2e demo — MANDATORY):** Fires `cli-anything run` with env-bearing and bare manifests; asserts `QDS_PROBE=x7` and non-empty `PATH` respectively; proves wiring closed.

## Dev Agent Record

### Review Findings

Code review was run on merged PR #24 (commit 396d386) using the gds-code-review workflow (3 parallel layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor). All ~22 findings, including low severity, were fixed:

- [x] Secret-channel hardening (INV-2/INV-3): secret-like parent env values redacted from `stdout_excerpt`/`env_probe_result`; stdout capture capped at 256KB (`truncated` flag); UTF-8-safe StringDecoder; env-keys log line capped at 50 key names.
- [x] Process-tree timeout kill: `detached` spawn on POSIX, SIGKILL to the process group on timeout; win32 fallback preserved.
- [x] Error handling & exit codes: sync-spawn throw → `spawn_error` (127); double-settle guard; `spawn_error_code`/`signal` surfaced; manifest/usage errors exit 65/64 with clean stderr messages; timeout → 124.
- [x] Edge-case hardening: CRLF probe stripping; empty manifest `PATH` leaves parent PATH unchanged; win32 case-insensitive PATH key; undefined `process.env` values filtered; `--manifest=<path>` form; trim validation on `name`/`command`.
- [x] Test coverage: timeout, spawn_error, empty-PATH, strict-schema, additive-inheritance, truncation tests added; weak INV-2 test replaced with a real echoed-secret assertion; mandatory e2e test (`bun run src/index.ts`) added.

Follow-up adversarial re-review returned two blocking items, both fixed: trailing partial-prefix redaction of secrets cut at the truncation boundary, and `decoder.end()` skipped once truncated so a mid-sequence cut cannot push the excerpt past the cap (new boundary-leak and multi-byte cap tests added).

#### Round 2 — code review of fix/p0-1-code-review-findings (2026-07-14)

3 parallel layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor; all findings classified patch and applied (decision_needed: 0, defer: 0, dismissed: 0):

- [x] Secret-channel/redaction hardening (INV-2/INV-3): boundary-prefix redaction now enforces a minimum prefix length of 8 (no 1-char fragment mangling); the excerpt cap is re-applied after redaction (`[REDACTED:key]` growth cannot exceed the cap); `env_probe_result` is nulled when stdout was truncated (a probe line cut mid-value is never silently reported or leaked); `SECRET_KEY_RE` extended to `SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL`.
- [x] Timeout/process-tree correctness: timer callback guards `child.exitCode !== null || child.killed` (natural exit at the timeout instant is no longer misclassified as 124, and a reused PID/process group is never signaled); `close` prefers the real `code` (`timeout` only when `timedOut && code === null`); win32 timeout now tree-kills via `taskkill /pid <pid> /T /F`; SIGINT/SIGTERM handlers group-kill the active child then re-raise (no orphaned detached children); `child.stdout` `error` settles as `spawn_error` with double-settle guard.
- [x] Cap semantics: `stdout_excerpt` cap documented as UTF-16 code units (matching `String.length`); slicing is surrogate-safe (trailing unpaired surrogate stripped); oversized chunks are bounded to remaining capacity before decode; `timeoutMs` clamped to the setTimeout range (`2^31-1`).
- [x] Env merge win32 correctness: parent PATH key looked up case-insensitively (`Path` vs `PATH`), parent's original key casing preserved, case-variant duplicate keys collapsed; `mergeEnv` takes an optional `platform` param so the win32 branch is unit-testable.
- [x] CLI hardening: Zod/YAML errors sanitized for stderr — field paths + issue codes only, never received manifest values (INV-2); `--timeout-ms` flag added (space and `=` forms); usage text documents both `--manifest` forms and the leading-`-` caveat.
- [x] Result schema: `exit_code: number | null` added to `HarnessResult` and populated from the child's real close code (additive field in the structured JSON output).
- [x] Test coverage: grandchild process-tree kill on timeout; win32 `mergeEnv` via platform param (Path casing preserved, no duplicates, empty-PATH no-op); e2e stderr drained with kill-timeout and guarded JSON.parse (POSIX-only shell fixtures, win32 covered at unit level); `spawn_error_code` asserted `"ENOENT"`; real malformed-manifest fixture (65-path no longer passes vacuously via ENOENT); 50-key log cap, `cleanEnv` filtering, redaction re-cap, min-prefix boundary redaction, probe-on-truncation, timeout-race classification, `exit_code` presence, stderr sanitization, extended `SECRET_KEY_RE` patterns.

#### Round 3 — code review of fix/p0-1-code-review-findings (2026-07-14)

3 parallel layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor; **decision_needed: 0, patch: 18, defer: 0, dismissed: 1**. Dismissed: F1 — manifest-supplied env values are not redacted; this is already the documented INV-2 threat model (operator-trusted manifest input; parent env secrets are redacted by heuristic). All patch findings fixed, including low-severity items.

- [x] **Probe preservation on truncation** (`runner.ts:extractProbe`): `env_probe_result` is now extracted only from *complete* lines; an early `QDS_PROBE=x7` line followed by a large flood is still reported, while a probe cut mid-value remains `null`.
- [x] **Timeout kill hang / process-tree leak**: `killChildTree()` now has `child.kill('SIGKILL')` fallbacks if group kill / `taskkill` fails; an unref'd 5 s watchdog force-settles as `timeout` if `close` never fires (handles daemonizing descendants). `stdout` stream errors also kill the live child before settling.
- [x] **Redaction ordering / tail leaks**: `redactSecrets()` processes parent secret values longest-first so overlapping values cannot leave tails behind.
- [x] **Boundary-prefix leak**: trailing secret fragments shorter than `MIN_BOUNDARY_PREFIX_LEN` are stripped from the end of a truncated excerpt instead of emitted, closing the 1–7 char leak path without noisy mangling.
- [x] **Timeout-race classification**: extracted `classifyExit()`; timer and signal handlers guard on `signalCode`/`settled`/`timedOut` so natural exits at the timeout instant are not misclassified as 124 and reused PIDs/process groups are never signaled; deterministic unit tests replace the vacuous wall-clock test.
- [x] **Signal-handler install window + SIGHUP**: SIGINT/SIGTERM/SIGHUP handlers are installed before `spawn()` via a mutable child holder, removing the orphan window; SIGHUP now reaps the detached tree on terminal close.
- [x] **Log forging (INV-3)**: env key names are sanitized for control characters (`\r\n\x00-\x1f` → `?`) in the key-only log line.
- [x] **JSON contract uniformity**: every settle path now emits `truncated`, `signal`, `spawn_error_code`, and `exit_code` explicitly, eliminating path-dependent absent fields.
- [x] **`env_probe_result` cap**: probe values are capped to 1024 UTF-16 code units, surrogate-safe.
- [x] **Comment accuracy**: corrected the streaming cap invariant comment to note final enforcement at `settle`; narrowed the win32 `mergeEnv` duplicate-collapse comment to PATH-only.
- [x] **win32 correctness in tests**: `mergeEnv` tests use explicit `;` delimiter for the win32 branch; POSIX-only sh/signal tests are `skipIf(process.platform === "win32")` gated.
- [x] **Test hardening**: timeout result asserts `signal: "SIGKILL"`; re-cap test asserts the full `[REDACTED:<key>]` marker, no secret value, and cap invariant; grandchild-kill test passes the PID file path via env instead of shell interpolation.
- [x] **CLI unknown-flag rejection**: `index.ts` rejects unknown/misspelled flags (including `=value` forms) with usage on stderr and exit 64.
- [x] **Strict `--timeout-ms` parsing**: accepts only decimal digits in the range `1..2^31-1`; rejects `1e3`, `0x10`, `0`, negatives, and oversized values.
- [x] **Error classification / INV-2 stderr sanitization**: ENOENT → 66 with the operator-supplied manifest path; YAML syntax errors → 65 with line/column position but no source values; unexpected internal failures → 70; all stderr output stays value-free.
- [x] **Unknown `exit_class` default**: mapping now defaults to 1 with a stderr note instead of silently exiting 0 when `EXIT_CODES[exit_class]` is undefined.
- [x] **spawn_error test isolation**: `PATH` for the missing-binary test is set to a freshly-created empty temp dir, removing host-dependency on whether `/usr/bin/warren` exists.
- [x] **e2e coverage of 124/127/65 paths**: real-binary e2e tests now assert CLI exit codes and structured output for timeout (`124`, `exit_class: timeout`, `signal: SIGKILL`), spawn_error (`127`, `ENOENT`), and manifest validation errors (`65`); kill-timer uses process-group kill and reaps grandchildren.

Final verification after all three waves: **83 pass / 0 fail** in `cli-anything`; root `bun test` pass; `bunx tsc --noEmit` clean.
