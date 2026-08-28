# Blind Review — PR135 chunk: src/fleet/resident.ts + src/fleet/index.ts

Reviewer: Blind Hunter (diff-only, no repo context). Lines are diff-relative.

## Findings

### HIGH

- **[HIGH] Unredacted pi session file on disk defeats the redaction design** — `src/fleet/resident.ts:222,253-254`
  The `--session <sessionPath>` file is written by pi itself and will contain the raw prompt and raw reply, unredacted. All the `redact()` plumbing on `persistArtifact` protects only the two `.txt` artifacts; the same content (including any secret that rode in on the brief) sits in `${runId}.resident.jsonl` with pi's default file mode. Mitigation exists (fresh `sessionDir` is created `0o700`, line 223) but is void if `sessionDir` pre-exists with permissive mode. Trigger: brief contains a credential → secret persisted unredacted in the session file, readable by any process that can stat the dir.

- **[MEDIUM] Brief passed as `-p` argv: visible in process list, hard size ceiling** — `src/fleet/resident.ts:255-256`
  The full prompt goes on the command line. (a) Any local user/process can read it via `ps` while the call runs — a confidentiality gap the env-only key delivery (line 88 comment) carefully avoids for keys but not for the payload. (b) A huge brief exceeding `ARG_MAX` (~1 MB on macOS) makes the spawn throw `E2BIG`, recorded as `lastExit = "logic"` (line 271) with no size guard or truncation. Trigger: DF3.1 brief with a large embedded context blob.

- **[MEDIUM] Every non-zero exit is classified "logic"** — `src/fleet/resident.ts:300-301`
  A pi exit 1 caused by an OpenRouter 429/5xx or a transient network failure is journaled as `"logic"` — indistinguishable from a genuine configuration fault, and per the file's own comment (line 269-270) "logic" means "will not heal on retry". Assumption: pi propagates provider failures as non-zero exit rather than signal/timeout. Trigger: rate-limited provider → run journal reports a logic fault and the caller presumably refuses retry.

- **[MEDIUM] Child inherits the entire process environment** — `src/fleet/resident.ts:224,264`
  `env: childEnv` where `childEnv = opts.env ?? process.env` forwards every variable in the orchestrator's environment (cloud credentials, unrelated tokens, CI secrets) to a third-party CLI subprocess. Redaction binds the same env, so leaks into artifacts are covered, but exfiltration by pi itself (or a compromised pi binary) is not scoped. Assumption: pi only needs `OPENROUTER_API_KEY` (+ maybe proxy vars); deliberate-per-comment but unbounded.

- **[MEDIUM] Production module imports a scripts-file, re-exported through the barrel** — `src/fleet/resident.ts:41`; `src/fleet/index.ts:11`
  `harvestPiStream` is imported from `cli-anything/scripts/team-lead-driver.ts` — a driver script, not a library module — and `resident.ts` is `export *`-ed from the fleet barrel. Any top-level side effect in that script (arg parsing, main-guard-less execution, env reads) now runs whenever anything imports `src/fleet`. Assumption: the script has an import-safe main guard; unverifiable from this chunk.

### LOW

- **[LOW] Sequential-call contract not enforced; concurrent calls corrupt state** — `src/fleet/resident.ts:227-229,274`
  `current` and `seq` are single slots. Two overlapping `call()`s spawn two pi processes against the SAME session file (concurrent writers → corruption), the second overwrites `current` so `stop()` kills only the latest, and prompt/reply artifact pairs interleave. Assumption: `ResidentCaller` is documented elsewhere as sequential; nothing here enforces it (no in-flight guard).

- **[LOW] SIGKILL-on-timeout risks a torn session file** — `src/fleet/resident.ts:262-263`
  `killSignal: "SIGKILL"` gives pi no chance to flush/close the `--session` jsonl. A timeout mid-write can leave a truncated final line; every subsequent call resumes that file and may fail parse → resident degraded for the rest of the run. Assumption: pi appends to the session file incrementally rather than writing atomically.

- **[LOW] Timeout death is indistinguishable from external kill or stop()** — `src/fleet/resident.ts:294-297`
  On signal death the error is `resident pi killed by signal SIGKILL before exit` for all three causes (native timeout, `stop()`, stray `kill -9`). The AC3/journal path loses the "solicitation timed out after N ms" fact that the timeout machinery exists to report.

- **[LOW] Stream-read failure path orphans the child and disarms stop()** — `src/fleet/resident.ts:288-292`
  If `new Response(proc.stdout).text()` rejects while the child is still running, the catch sets `current = null` and rethrows — the process is left alive until the native timeout fires (up to 10 min), and `stop()` can no longer reach it because the handle was dropped.

- **[LOW] Non-string/non-object brief bypasses the empty check** — `src/fleet/resident.ts:133-138`
  `briefIsEmpty(0)`, `briefIsEmpty(false)`, `briefIsEmpty(42)` all return false → resident spawns with a meaningless brief. Assumption: ingress validation (DF3.1 BriefSchema) makes this unreachable, as the comment claims; the function is still the only AC4 gate in this file.

- **[LOW] Reply-persistence failure log line is not redacted** — `src/fleet/resident.ts:318-321`
  `console.error(... err.message ...)` bypasses the `redact` chokepoint the file claims (line 162: "every error message passes through this one chokepoint"). In practice a write error message is path-only, but the invariant stated in the file is false.

- **[LOW] Pre-existing sessionDir keeps its permissions** — `src/fleet/resident.ts:223`
  `mkdirSync(dir, { recursive: true, mode: 0o700 })` applies the mode only to directories it creates. If `sessionDir` already exists as `0755`, the session file (see HIGH above) inherits the lax exposure. Same for `persistDir` at line 184.

- **[LOW] Empty/malformed model output returns as success** — `src/fleet/resident.ts:306-307,324-327`
  Exit 0 with stdout lacking a parseable `message_end` yields `{ raw: "", usage: {0,0} }` and `lastExit = "success"` — a silent empty solicitation is reported as a clean call. Assumption: C1's `steering.ts` validates the reply, per the header comment; the exit status still lies about an empty harvest.

- **[LOW] stderr of a successful call is discarded** — `src/fleet/resident.ts:276-306`
  Warnings/deprecations pi prints on exit 0 are captured into `stderr` and then dropped; the only persistence path for stderr is inside the non-zero-exit error. Diagnosing a degrading provider after the fact has no artifact.

- **[LOW] runId uniqueness across runs not guarded** — `src/fleet/resident.ts:197,222`
  The regex blocks path traversal but two runs with the same `runId` in the same `sessionDir` share one session file — the second run silently resumes the first run's conversation context. Assumption: runId is unique per run by upstream construction; unverifiable here.

- **[LOW] Module-global `_rateSources` test seam exported through the public barrel** — `src/fleet/resident.ts:98-101`; `src/fleet/index.ts:11`
  `_injectRateSources` / `_resolvedSolicitTimeoutMs` ship in the production API surface and mutate module-global state that persists across `startResident` calls in the same process; a test that forgets `_injectRateSources(null)` changes production rate resolution for the process lifetime.

- **[LOW] `stop()` permanently bricks the resident** — `src/fleet/resident.ts:233,337`
  `stopped` is a one-way latch set even when there is no in-flight call (`current === null` early-returns but `stopped` stays true). Any caller that invokes `stop()` as a precaution (e.g., on a run-pause the design later resumes) makes every future `call()` throw. Assumption: DF3.6 semantics intend one-shot stop; if stop is meant as "kill in-flight only", this is a bug.

- **[LOW] Artifact writes are non-atomic** — `src/fleet/resident.ts:183-186`
  `writeFileSync` directly to the final name; a crash mid-write leaves a truncated prompt/reply artifact indistinguishable from a complete one. Write-temp-then-rename would close it; impact is forensic only.

- **[LOW] cwd inherited implicitly by Bun.spawn** — `src/fleet/resident.ts:258-265`
  No `cwd` option: pi runs in whatever directory the orchestrator process happens to occupy. If pi resolves any relative config from cwd (e.g. `~/.pi` vs project-local config), behavior varies with launch context; if the cwd is deleted mid-run the spawn may fail with a misleading error. Speculative on pi's config resolution.

## Notes (checked, not findings)

- stdin is `"ignore"` → no EPIPE surface. stdout/stderr both piped and fully drained in the same `Promise.all` as `proc.exited` → no pipe-buffer deadlock.
- Redact-then-truncate order on the stderr error (line 302-304) is correct.
- Timeout clamp logic (line 112-117) correctly rejects NaN/non-integer/out-of-range.
- Spawn-ENOENT synchronous throw is mapped and rethrown; `lastExit` set before rethrow.
