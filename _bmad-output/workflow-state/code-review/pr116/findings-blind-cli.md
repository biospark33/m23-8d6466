ort", abortTeam)` at line 394 is NOT removed in `removeSignalHandlers()` (line 308). If the signal aborts after `settled=true` (line 300) but before the event listener is naturally cleaned up by GC, `abortTeam` will fire, call `killTree(child)` (line 385), and attempt to `settle("transient", ...)` again. The `if (settled) return` guard at line 384 prevents double-settle, but the `killTree` call still executes against an already-killed child — undefined behavior (double-kill is unsafe).

### HIGH

**runner.ts:278-280** — partialOutputBuffer can grow beyond PARTIAL_OUTPUT_CAP
- **Why**: The cap check at line 439 (`partialOutputBuffer.length < PARTIAL_OUTPUT_CAP`) guards APPENDS, but `decoded.slice(0, remaining)` at line 441 uses `remaining = PARTIAL_OUTPUT_CAP - partialOutputBuffer.length`. If `partialOutputBuffer.length` is BETWEEN checks (e.g., 9999), and a 10-byte chunk arrives, `remaining` becomes 1, so only 1 byte is appended. Correct. BUT the cap check uses `<` not `<=`, so when `length === 9999`, the condition is TRUE, and `slice(0, 1)` appends 1 byte, making length 10000. Next chunk, `length < 10000` is FALSE, so no more appends. So it caps at 10000 exactly. This is actually correct — the cap is 10000 bytes. NOT A BUG.

**watchdog.ts:779-782** — Watchdog poll loop continues after escalation but before grace timer fires
- **Why**: The `if (running && !escalated)` guard at line 779 prevents re-scheduling AFTER escalation, but if escalation happens at line 736, `escalated` becomes true, and the poll function returns without rescheduling. The grace timer at line 756 fires once after `graceMs`. This is correct — the watchdog should not poll during the grace period. NOT A BUG.

**watchdog.ts:762-763** — SIGKILL checks liveness with `process.kill(-pgidOrGroup, 0)` but ignores result
- **Why**: The `process.kill(-pgidOrGroup, 0)` at line 763 polls whether the process group exists. If it throws (line 771), the group is gone — correct. If it returns, the group exists and we SIGKILL (line 767). But the return value of `process.kill(pid, 0)` is a boolean (true if process exists). The code doesn't check this boolean — it just assumes success means "exists". This is actually correct behavior — the throw means "gone", no throw means "exists". NOT A BUG.

**merger.ts:108-113** — partialOutput truncation does NOT cap at PARTIAL_OUTPUT_CAP
- **Why**: The `truncateWithSuffix(redact(opts.partialOutput), MAX_PARTIAL_OUTPUT_CHARS, "chars")` at line 112 uses `MAX_PARTIAL_OUTPUT_CHARS = 10000` (line 29). But `opts.partialOutput` comes from `collectPartialOutput()` which caps at `PARTIAL_OUTPUT_CAP = 10000` (runner.ts:280). So the input is already capped at 10000, and then we potentially truncate it again (adding suffix). This means `partialOutput` can be UP TO `10000 + suffix.length` bytes. The contract says "≤10000 chars with suffix" (types.ts:545) — this is violated when the input is exactly 10000 and we add a suffix like `[truncated, 10000 chars total]` (28 chars). Actual max: 10028 bytes.

**runner.ts:439-442** — partialOutputBuffer collects decoded UTF-8, but length check is on JS string length
- **Why**: `decoded` is a JS string from `decoder.write(bytes)`. The check `partialOutputBuffer.length < PARTIAL_OUTPUT_CAP` counts UTF-16 code units. For ASCII, 1 byte = 1 code unit. For multi-byte UTF-8 sequences (e.g., emoji), 1 code unit may be 4 bytes in UTF-8. So we're capping UTF-16 code units at 10000, which can be up to 40000 UTF-8 bytes. The contract says "≤10000 chars" — this is ambiguous. If "chars" means UTF-16 code units (JS string length), it's correct. If it means UTF-8 bytes, it's violated. Given the TypeScript context, "chars" likely means JS string length. NOT A BUG per se, but the contract is ambiguous.

### MEDIUM

**runner.ts:259-261** — forceLocalRunner mutates `env` instead of creating a new object
- **Why**: `env` is created by `mergeEnv(parent, manifest.env)` at line 233. Then `env.QDS_TEAM_RUNNER = "local"` mutates it. If `mergeEnv` returns a reference to `parent` or `manifest.env` (which it does based on typical merge patterns), this mutates the parent process environment or the manifest object. Looking at the diff, `mergeEnv` implementation isn't shown, but the pattern suggests `env` might be a new object. Without seeing `mergeEnv`, this is a potential leak of the `QDS_TEAM_RUNNER=local` override into the caller's environment.

**watchdog.ts:694-711** — handle.stop() clears graceTimer but doesn't prevent it from firing if already scheduled
- **Why**: The `clearTimeout(graceTimer)` at line 709 prevents the grace timer from firing. But if `stop()` is called AFTER the grace timer fires (at line 756) but BEFORE the callback executes, the callback is already in the event queue and will run. The callback checks `if (!running) return` at line 757, so it exits early. But `running` is set to `false` BEFORE `graceTimer` is cleared (lines 700, 709). So the callback is safe. NOT A BUG.

**types.ts:505-513** — EXIT_STATUSES array duplication
- **Why**: The `EXIT_STATUSES` array at lines 505-511 duplicates the union type members. If a new status is added to the union but NOT to the array, a guard checking `EXIT_STATUSES.includes(status)` will return false for the new status. This is a maintenance hazard — the comment at lines 500-503 claims this prevents silent rewrites, but it actually creates a new failure mode: array/union divergence.

**merger.ts:94-97** — summary fallback to `opts.summary` when `result.summary` is not a string
- **Why**: The ternary at line 94-95 chooses `opts.result.summary` if it's a string, otherwise `opts.summary`. But `opts.summary` is NOT in the `BuildMergedOutputOptions` interface shown in the diff (lines 173-22 show the interface, but only up to line 22 is visible in the hunk). If `opts.summary` doesn't exist, this will crash. The JSDoc at line 23 says "Top-level summary (copied from result.summary...)" — there's NO `opts.summary` field documented. This suggests the fallback path is dead code or the interface is incomplete in the diff.

### LOW

**pipeline-run.ts:47-53** — dispatchTask registration uses `rootDir: cwd` but comment says "pins artifact reads to the SAME --run-root"
- **Why**: The comment at lines 49-50 says `rootDir` pins artifact reads to `--run-root`. But the code passes `rootDir: cwd` where `cwd` is the parameter from `makeBodyFactory(cwd, ...)` at line 196. `cwd` might NOT be `--run-root` — it's whatever the factory was created with. The comment claims one thing, the code may do another. Without seeing how `makeBodyFactory` is called and what `cwd` is bound to, this is a potential comment/code mismatch.

**watchdog.ts:664-665** — Linux ps command enumerates ALL processes with `-e`
- **Why**: The `["-o", "pgid=,rss=", "-e"]` array at line 665 enumerates every process on the system (`-e`), then filters by pgid at line 676. For a system with 100k+ processes, this is slow and allocates a huge string. The darwin path uses `-g` for direct pgid filtering (line 664), which is O(1) vs O(N). The Linux path should ideally use `ps -o pgid=,rss= --pid $(pgrep -g <pgid>)` or similar to avoid enumerating the entire process table. This is a performance issue, not correctness.

**runner.ts:352-353** — watchdog is only started on POSIX platforms
- **Why**: The `if (process.platform !== "win32" && child.pid !== undefined)` guard at line 352 skips watchdog on Windows. The `defaultSampler` at watchdog.ts:656 also returns null for Windows. So Windows runs have NO RSS watchdog — they can OOM the host. This is a documented limitation (watchdog.ts:657), but the error path only logs (watchdog.ts:363 `console.error(...)`), it doesn't fail the run. On Windows, a runaway memory leak goes undetected. The contract might not require RSS monitoring on Windows, but if it does, this is a platform gap.
## Blind Code Review Findings

### BLOCKER

- **watchdog.ts:746-752** — TOCTOU race in watchdog kill attribution. Between escalation decision (line 736) and SIGTERM delivery (line 747), the process group can exit naturally. The catch block (line 749) returns early without setting `killOrigin = "watchdog"`, so natural exit during this window is NOT attributed to watchdog. Natural exit AFTER successful kill (line 748) IS attributed. Same outcome, opposite attribution — the code only handles failed kill, not the race window.

- **runner.ts:453-463** — Watchdog escalation race with overflow check. The `watchdogKilled` flag (line 357) is set asynchronously inside `onEscalate` callback, but the overflow precedence check at line 454 uses it synchronously. If watchdog escalates and the overflow path triggers BEFORE `onEscalate` fires, `watchdogKilled` is still false and run won't settle as overflow. Race between watchdog poll loop and main event loop.

- **runner.ts:382-394** — abortSignal listener not removed, can fire after settle. The `abortSignal.addEventListener("abort", abortTeam)` at line 394 is NOT removed in `removeSignalHandlers()` (line 308). If signal aborts after `settled=true` (line 300) but before GC, `abortTeam` fires, calls `killTree(child)` (line 385), and attempts double-settle. The `if (settled) return` guard (line 384) prevents double-settle but `killTree` still executes against already-killed child.

### HIGH

- **merger.ts:108-113** — partialOutput violates ≤10000 char contract. `opts.partialOutput` comes from `collectPartialOutput()` capped at `PARTIAL_OUTPUT_CAP = 10000` (runner.ts:280). Then `truncateWithSuffix` adds a suffix like `[truncated, 10000 chars total]` (28 chars). Actual max: 10028 bytes, but types.ts:545 promises "≤10000 chars with suffix."

- **runner.ts:259-261** — forceLocalRunner mutates `env` which may alias parent/manifest. `env.QDS_TEAM_RUNNER = "local"` mutates the object returned by `mergeEnv(parent, manifest.env)`. If `mergeEnv` returns a reference to `parent` or `manifest.env` (typical merge pattern), this leaks the `QDS_TEAM_RUNNER=local` override into the caller's environment.

- **types.ts:505-513** — EXIT_STATUSES array is maintenance hazard. Adding a new status to the union type but NOT to the array causes `EXIT_STATUSES.includes(status)` guards to fail. The comment (lines 500-503) claims this prevents silent rewrites, but it creates array/union divergence — a new failure mode where the array silently rejects valid statuses.

- **merger.ts:94-97** — summary fallback to `opts.summary` but field not in interface. The ternary falls back to `opts.summary` when `result.summary` isn't a string, but `BuildMergedOutputOptions` (lines 173-22) doesn't show a `summary` field. JSDoc at line 23 says summary is "copied from result.summary" — no `opts.summary` documented. Either dead code or incomplete interface.

### MEDIUM

- **watchdog.ts:664-665** — Linux `ps -e` enumerates all processes, O(N) vs darwin O(1). The `["-o", "pgid=,rss=", "-e"]` command enumerates every process on the system then filters by pgid. Darwin uses `-g` for direct pgid filtering (line 664). Linux path should use `ps --pid $(pgrep -g <pgid>)` or equivalent to avoid enumerating the entire process table on systems with 100k+ processes.

- **pipeline-run.ts:47-53** — Comment/code mismatch on `rootDir`. Comment says "pins artifact reads to the SAME --run-root" (lines 49-50), but code passes `rootDir: cwd` where `cwd` is the factory parameter. Without seeing how `makeBodyFactory` binds `cwd`, unclear if it's actually `--run-root`. Comment claims one thing, code may do another.

- **runner.ts:352-353** — Windows has no RSS watchdog, can OOM host. The `process.platform !== "win32"` guard (line 352) skips watchdog on Windows. `defaultSampler` (watchdog.ts:656) also returns null for Windows. Windows runs get NO RSS monitoring — a memory leak goes undetected. Documented limitation, but only logs (watchdog.ts:363) without failing. Platform gap if contract expects RSS monitoring everywhere.
