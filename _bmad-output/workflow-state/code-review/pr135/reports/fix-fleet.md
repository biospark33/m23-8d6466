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

---

## Round 7

Fixer: fix-fleet. Branch `feature/df3-3-resident-orchestrator-agent` @ 7f059f2 (+ working-tree edits). No commits, no staging.
Scope honored: only `src/fleet/resident.ts`, `tests/fleet/resident.test.ts`, `tests/fleet/fixtures/fake-pi-resident.ts` touched. (Other files in `git diff --stat` — steering.ts, pipeline-run.ts, fix-engine.md, etc. — belong to the concurrent wave-1 fixers.)
GitNexus: MCP tools unavailable in this subagent; ran the CLI instead — `node .gitnexus/run.cjs impact startResident --repo QDS-Factory` → **risk LOW**, 1 direct caller (`main` in scripts/pipeline-run.ts), 1 affected process. No exported signature changed; blast radius is behavioral only (flagged below).

| # | sev | verdict | verified-at + change |
|---|-----|---------|----------------------|
| S2-1 | HIGH | **PATCHED — BEHAVIOR CHANGE** | Verified: quarantine (`renameSync` to `.torn-<seq>`) lived only inside the `elapsed >= timeoutMs - 25` branch (old `resident.ts:429-433`); stop()/external SIGKILL took the "killed by signal" throw with NO quarantine. Fix: hoisted into `quarantineSession(reason)` helper (`resident.ts:395-404`), now called unconditionally for ANY signal death at `:548` before the timeout discriminator. Timeout ("timed out after N ms") vs stop ("killed by signal …") error text preserved at the two throw sites (`:556-560`). Test pin: stop() test asserts the session jsonl is renamed to `.torn-1` after a stop-kill (`resident.test.ts:561-568`, condition-poll for the fake's startup append — no fixed sleep). |
| S2-2 | MED | **PATCHED** | Verified: `writeFileSync(tmp, body, {mode:0o600})` applies mode on create only (old `:251`). Fix: `rmSync(tmp, {force:true})` before the write (`resident.ts:310`), so every artifact is a fresh 0o600 create; stale lax-mode `.tmp` can no longer be renamed onto the final artifact. |
| S2-3 | MED | **PATCHED — BEHAVIOR CHANGE** | Verified: prompt-too-big path set `lastExit="logic"` (old `:330`) and the spawn-ENOENT catch did too (old `:378`), both with no process ever run. Fix: both leave `lastExit` untouched (busy-path rule) — `resident.ts:425-433` (ceiling) and `:474-481` (spawn catch). Re-pinned: ENOENT test now expects `exitStatus() === null` + `/spawn failed/` (`resident.test.ts:424-441`); NEW pin for ceiling refusal → null + zero spawn (`:443-458`). |
| S2-4 | MED | **PATCHED — BEHAVIOR CHANGE (new failure mode)** | Verified: `new Response(proc.stdout).text()` buffered unboundedly (old `:387-388`). Fix: bounded `collectBounded` reader-loop helper (`resident.ts:83-104`) with ceilings `MAX_STDOUT_BYTES = 4 MiB` / `MAX_STDERR_BYTES = 1 MiB` (`:71-72`, rationale in comment `:62-70`). Cap trip throws the `OutputCapError` sentinel (`:75`); the stream catch kills the child, quarantines the session (mid-append kill, same S2-1 rule), classifies **"logic"** (a flood is a pi-side fault a retry will not fix — documented choice, `:512-520`), and rethrows the content-free cap message. New fixture mode `flood` (~6 MiB stdout, `fake-pi-resident.ts:68-71`) + test pin (`resident.test.ts:604-627`): rejects `/output cap/`, exitStatus "logic", session quarantined. |
| S2-5 | MED | **PATCHED — BEHAVIOR CHANGE** | Verified: nothing stopped two `startResident` instances sharing one `--session` path. Fix: module-level `LIVE_SESSION_PATHS` set (`resident.ts:163`, documented private seam, never exported); second arming for a held path throws at `:353-357`; claim added after dir setup at `:380` (so a throwing mkdir/chmod leaks no claim); `stop()` releases at `:617`. Test pin (`resident.test.ts:824-844`): second start throws `/already held/`; after `stop()`, a fresh resident arms and calls successfully. |
| S2-6 | LOW | **PATCHED** | Verified: `elapsed >= timeoutMs - 25` is true for EVERY signal death when timeoutMs ≤ 25 (clamp floor is 1 ms, old `:425`). Fix: discriminator gated on `timeoutMs > 25` (`resident.ts:556`); tiny timeouts classify as plain signal deaths. Test pin: `QDS_RESIDENT_TIMEOUT_MS=10` + hang → `/killed by signal/`, exitStatus "transient" (`resident.test.ts:629-646`). |
| S2-7 | LOW | **PATCHED** | Verified: the Bun.spawn catch rethrew `err` raw (old `:379`), outside the redact chokepoint. Fix: wrapped — `` `resident pi spawn failed: ${redact(...)}` `` (`resident.ts:478-481`). Pinned via `/spawn failed/` in the ENOENT test (`resident.test.ts:437`). |
| S2-8 | LOW | **PATCHED (doc-only, per triage)** | CC-1 enum cannot widen, so the signal-death site (`resident.ts:539-545`) now carries a comment stating "transient" deliberately includes PLANNED stop() kills, indistinguishable from a genuine transient crash; the human-visible timeout-vs-stop distinction lives in the thrown error text, which the hoisted S2-1 quarantine does not touch. |
| S2-9 | INFO | **PATCHED — BEHAVIOR CHANGE** | Verified: `call("")` passed the byte ceiling and spawned pi with `-p ""`. Fix: empty/whitespace-only prompts refuse pre-spawn (`resident.ts:417-421`), `lastExit` untouched (consistent with S2-3). Test pin: "", "   ", "\n\t" all refuse `/prompt is empty/`, exitStatus null, zero spawn (`resident.test.ts:460-477`). |
| S2-10 | INFO | **PATCHED (code + comment; test pin skipped)** | Fix: signal-death condition now includes `proc.exitCode === 137` (128+SIGKILL) with a comment explaining the Bun-reporting hedge (`resident.ts:532-538`), so a 137/null-signalCode report still classifies "transient" AND quarantines. Test pin **skipped — not cheap**: the fake cannot control how Bun reports a signal death (exitCode-vs-signalCode is Bun internals); simulating it would require mocking `Bun.spawn`, which this suite deliberately avoids. |
| S2-12 | LOW | **PATCHED (test)** | Verified: the "no persistDir" test (old `resident.test.ts:603-616`) asserted only `exitStatus === "success"`. Fix: now asserts `readdirSync(dir).sort()` equals exactly `["record.json", "run-nopersist.resident.jsonl"]` — the fake's own record plus the session jsonl (sessionDir IS the case dir in that test), no prompt/reply artifacts (`resident.test.ts:706-718`). |

### Intentional behavior changes — FLAG for the wave-2 test fixer

1. **S2-1 quarantine-on-stop (highest cross-cluster risk).** ANY signal death now renames the session jsonl to `.torn-<seq>` — including `stop()` kills. `scripts/pipeline-run.ts` calls `residentSpawn.stop()` in its SIGINT/SIGTERM handlers and final cleanup; `tests/phase-engine/resident-e2e.test.ts`'s SIGINT leg may pin the session file's post-stop existence/content — it will now find `.torn-<seq>` instead. Steering tests that kill then re-call the same resident now resume a FRESH session.
2. **S2-3 exitStatus null on pre-spawn refusals.** Prompt-too-big and spawn-ENOENT no longer set `lastExit="logic"` — `exitStatus()` stays null (or the previous call's end). Any e2e/steering leg pinning a journaled `resident.exitStatus` after a spawn failure must re-pin to null.
3. **S2-4 output caps.** New failure mode: stdout > 4 MiB / stderr > 1 MiB → child killed, call throws `/output cap/`, exitStatus "logic", session quarantined. No existing test floods output; no expected breakage.
4. **S2-5 live-session set.** A second `startResident` for the same `sessionDir + runId` now throws `/already held/` until `stop()` is called. Any harness that re-arms a resident for the same run without stopping the old one will now fail at arming.
5. **S2-7 spawn-error text.** Spawn failures now read `resident pi spawn failed: …` (wrapped, redacted) instead of Bun's raw error message — message-substring pins on ENOENT text would break.
6. **S2-9 empty-prompt refusal.** `call("")`/`call("   ")` now throw pre-spawn instead of spawning pi with `-p ""`.
7. **S2-6 tiny-timeout classification.** `timeoutMs ≤ 25` signal deaths now read "killed by signal …", not "timed out …".

### Gates (round 7)

- `bun test tests/fleet/` → **616 pass / 0 fail / 16 todo** (632 tests; resident.test.ts 35/35). One transient failure on the first run — `tests/fleet/cli.test.ts` "fleet-busy race refusal" 20 s timeout under full-suite load — unrelated to this cluster (DF3.1 CLI, no resident import), passes in isolation, and the full-suite re-run is green.
- `bunx biome check src/fleet/resident.ts tests/fleet/resident.test.ts tests/fleet/fixtures/fake-pi-resident.ts` → **clean**.
- `bunx tsc --noEmit` → **clean** (0 errors, whole repo, concurrent fixers' edits included).
