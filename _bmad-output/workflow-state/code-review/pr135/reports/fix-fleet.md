# PR 135 Round 5 — Fixer Report: Cluster S2 (src/fleet/resident.ts + src/fleet/index.ts)

Fixer: fix-fleet. Branch `feature/df3-3-resident-orchestrator-agent` @ d15f0ca (+ working-tree edits).
Scope honored: only `src/fleet/resident.ts`, `src/fleet/index.ts`, `tests/fleet/resident.test.ts` touched. No commits.
GitNexus impact analysis: **skipped** — no GitNexus MCP tools available in this subagent's toolset (per process step 1 fallback).

## Verdict table

| # | sev | verdict | evidence (file:line, current source) |
|---|-----|---------|--------------------------------------|
| S2-1 | HIGH | **PATCHED** | `resident.ts:305` unconditional best-effort `chmodSync(sessionDir, 0o700)` after mkdir (pre-existing lax dirs clamped); `:415` best-effort `chmodSync(sessionPath, 0o600)` after every call; both warn via the redacted `warn` chokepoint (`:299-301`), never throw. Also applied to persistDir in `persistArtifact` (`:230-235`). Smoke-verified: pre-created 0755 dir → 700, session file → 600. |
| S2-2 | MED | **PATCHED** | `MAX_PROMPT_BYTES = 128 * 1024` (`:59`) + guard at `:328-333` refusing BEFORE persist/spawn with `lastExit="logic"` (byte count only, no content). ps-visibility documented at `:50-58`. Delivery mechanism unchanged (argv, stdin "ignore"). Smoke-verified: 129 KiB prompt refused, exitStatus logic. |
| S2-3 | MED | **PATCHED** | `TRANSIENT_STDERR_RE` (`:67-68`: 429, rate-limit, too-many-requests, 500/502/503/504, ECONNRESET/ETIMEDOUT/ECONNREFUSED/ENOTFOUND/EAI_AGAIN, socket hang up, fetch failed) tested against the REDACTED stderr tail at `:446`; default stays "logic". Smoke-verified: 429 stderr exit 1 → `transient`; bare exit 3 (existing test) → `logic`. |
| S2-4 | MED | **PATCHED — BEHAVIOR CHANGE (pre-authorized)** | `CHILD_ENV_ALLOWLIST` (`:179-191`: PATH, HOME, TMPDIR, OPENROUTER_API_KEY, HTTP(S)_PROXY/NO_PROXY both cases, QDS_RESIDENT_TIMEOUT_MS) + `buildChildEnv` (`:193-204`); applied only when `opts.env` absent (`:293`). Redaction binds the same `childEnv` (`:294`). Escape hatch: `QDS_RESIDENT_ENV_PASSTHROUGH` (comma-separated names, read from the base env) — required so the e2e harness can reach its env-scripted fake pi without touching pipeline-run.ts. Verified: without passthrough, `QDS_FAKE_PI_RECORD` did NOT reach the child; with it, it did. |
| S2-5 | LOW | **PATCHED — BEHAVIOR CHANGE** | In-flight guard at `:322-324`: overlapping `call()` throws immediately ("already in flight"). `lastExit` deliberately untouched — no process ends; the in-flight call owns the process-end report. Smoke-verified. Safe against interleaving because `call()` is synchronous through spawn/`current = proc` before its first await. |
| S2-6 | LOW | **PATCHED** | After a timeout-kill, session file renamed to `<path>.torn-<seq>` best-effort (`:429-433`), so the next call starts fresh. Smoke-verified: torn file exists, original gone. |
| S2-7 | LOW | **PATCHED — BEHAVIOR CHANGE (message text)** | Elapsed-time discriminator (`spawnedAt` at `:376`, check at `:428`, 25 ms slack — Bun exposes no timed-out flag). Timeout now throws "resident pi timed out after N ms (SIGKILL on native timeout)" (`:434`); stop()/external kill keeps "killed by signal …". Smoke-verified both messages. |
| S2-8 | LOW | **PATCHED** | Stream-read catch now SIGKILLs the child and awaits exit BEFORE clearing `current`/rethrowing (`:399-406`). |
| S2-9 | LOW | **PATCHED** | `briefIsEmpty` final branch returns `true` (`:145`) — non-string/non-object briefs count as empty (AC4 fail-safe). No existing test passed such briefs; nothing broke. |
| S2-10 | LOW | **PATCHED** (subsumed by S2-14) | The unredacted `console.error` line is gone; reply-persist failure now throws with the message through `redact` (`:474`). Prompt-persist failure message also redacted now (`:341`). |
| S2-11 | LOW | **PATCHED — BEHAVIOR CHANGE** | `harvest.turnCount === 0` (no assistant `message_end`) → `lastExit = "logic"` (`:462`); empty raw still flows to steering's fail-closed reply validation (deliberately NOT a throw, so the malformed-correction attempt path is preserved). E2e demo unaffected: `tests/phase-engine/fixtures/fake-resident.ts:127-129` always emits `message_end`. |
| S2-12 | LOW | **PATCHED** | Non-empty stderr on success → one redacted, tail-bounded (`slice(-400)`) warn line via the chokepoint (`:453-455`). |
| S2-13 | LOW | **PATCHED** | `persistArtifact` writes `${name}.tmp` (mode 0o600) + same-dir `renameSync` (`:237-239`). Stale `.tmp` from a crash is overwritten next call (sequential contract). |
| S2-14 | LOW | **PATCHED — BEHAVIOR CHANGE (pre-authorized)** | Reply-persist failure now THROWS (fail-closed per §5.2, `:465-476`); the reply never reaches steering unpersisted — steering degrades to the deterministic default. `lastExit` stays "success": the process end was clean; the fault is host-side. Matches the prompt path. |
| S2-15 | LOW | **PATCHED** | `src/fleet/index.ts:17-19` comment now says resident.ts imports `../phase-engine/steering.ts` directly. |
| S2-16 | MED | **DISMISSED (verified)** | `cli-anything/scripts/team-lead-driver.ts:824` — `if (import.meta.main) await main();`. Top level contains only pure const declarations (`say`/`log`/`now` :59-66, `ZERO_USAGE` :201, `SAFE_CAPTURE_NAME_RE` :483) and imports; no top-level env reads, no side effects. Import-safe. |
| S2-17 | LOW | **DISMISSED (verified)** | `scripts/pipeline-run.ts:1021` — `let runId: string = crypto.randomUUID();` unique per run by default; the `--run-id` override (`:1062`) is a deliberate operator correlation seam, and the runId regex (`resident.ts:68`) still blocks traversal. |
| S2-18 | LOW | **DISMISSED (verified)** | `_injectRateSources` (`resident.ts:103-106`) is underscore-prefixed with an explicit "injection seam for tests (dispatch-task _injectRunner pattern)" comment; `_resolvedSolicitTimeoutMs` (`:125-131`) docstring opens "Test seam". Documented private seams, matching repo convention. |
| S2-19 | LOW | **DISMISSED (verified)** | `stop()` is called only at terminal cleanup: `scripts/pipeline-run.ts:1359,1374` (signal handlers) and `:1633` (final cleanup). One-shot latch matches the one-shot run lifecycle; no resume path exists. |
| S2-20 | LOW | **DEFERRED** (per triage) | No `cwd` on spawn — speculative pi config resolution; not fixed, noted. |

## Behavior-change flags for wave 2

1. **S2-4 env allowlist (biggest blast radius).** `scripts/pipeline-run.ts:1442-1449` calls `startResident` WITHOUT `env`, so production AND `tests/phase-engine/resident-e2e.test.ts` now get the allowlist. The e2e scripts its fake pi via runner-env `FAKE_RESIDENT_REPLIES` (:183, :615), `FAKE_RESIDENT_EXIT` (:537), `FAKE_RESIDENT_HANG_AT` (:618) — all now stripped from the child → **those e2e legs will fail until T2 adds** `QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES,FAKE_RESIDENT_USAGE,FAKE_RESIDENT_EXIT,FAKE_RESIDENT_HANG,FAKE_RESIDENT_HANG_AT"` to `spawnRunner`'s env. The redaction-probe leg (:323) survives: the probe rides `OPENROUTER_API_KEY`, which is allowlisted. `QDS_RESIDENT_TIMEOUT_MS` (:621) is allowlisted. Unit tests unaffected (all pass explicit `opts.env`, which bypasses the filter — verified: every `startResident` call in `tests/fleet/resident.test.ts` passes `piEnv(...)`).
2. **S2-14**: reply-persist failure now throws (old B8 test inverted to expect the throw + `exitStatus "success"` — `tests/fleet/resident.test.ts:527-553`).
3. **S2-11**: exit-0/no-`message_end` → `exitStatus "logic"` (garbage test re-pinned, `:345-349`).
4. **S2-7**: timeout error text is now "timed out after N ms" (B4 timeout test re-pinned to `/timed out after 500 ms/`, `:505-507`).
5. **S2-5**: concurrent `call()` throws — T1's planned concurrent-rejection test can assert `/already in flight/` and that `exitStatus` is untouched by the refused call.
6. **S2-3**: non-zero exits whose redacted stderr matches transient patterns classify `transient` — T1's planned secret-in-stderr fake-pi mode should also pin that redaction runs BEFORE the regex (regex sees `[REDACTED:*]`, never the secret).
7. **S2-9**: `briefIsEmpty(0/false/42)` → disabled (no existing pin; new edge tests welcome).

## Gates

- `bun test tests/fleet/resident.test.ts` → **26 pass / 0 fail** (run twice: after edits, and again after an accidental stash/pop cycle — integrity confirmed).
- `bunx biome check src/fleet/resident.ts src/fleet/index.ts` → **clean** (2 useTemplate findings in my new code fixed).
- `bunx tsc --noEmit` → **0 errors in my cluster**; 2 errors remain in `scripts/pipeline-run.ts:1650,1665` (`rosterChoice.pending` type, `ResidentHooks.phaseIds`) caused by the **concurrent S1/S3 fixers' in-flight edits** (neither file nor those symbols are in my cluster; `ResidentHooks` exists only in pipeline-run.ts). Not contention — no re-run needed for my files.
- Smoke verifications (one-off `bun -e`, no repo files touched): S2-1 chmod 700/600 on pre-existing lax dir; S2-2 oversize refusal; S2-3 429→transient; S2-4 allowlist strip + `QDS_RESIDENT_ENV_PASSTHROUGH` restore; S2-5 overlap refusal; S2-6 quarantine; S2-7 timeout message. All as designed.

## Notes / leftovers

- `warn` chokepoint: `console.error("[resident] " + redact(msg).slice(-400))` (`resident.ts:299-301`) — all non-fatal diagnostics (chmod failures, quarantine failure, success-path stderr) flow through it.
- S2-5 guard placement means `seq`/artifacts are untouched by a refused call.
- An aborted mid-write artifact temp file (`<name>.tmp`) may linger after a hard crash; harmless by design (S2-13), not cleaned up.
- Incident note: I mistakenly ran `git stash` on src/scripts mid-task (intending to A/B the tsc errors), immediately `git stash pop`-ed, and re-verified all my diffs + the full test file afterwards (26/26 pass, diff stat intact). No work lost; flagged for transparency.
