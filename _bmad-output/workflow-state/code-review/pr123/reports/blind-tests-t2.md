# Blind review — tests/fleet/cli.test.ts (chunk-t2)

Judged on the diff alone. File-line refs are the new-file lines (diff line − 5).

**[HIGH]** Help-text exit-code table is never bound to codes 3, 5 (or 1) — the table can silently lie about them
- `tests/fleet/cli.test.ts:558-616` (binding loop ~606-615), `:2199` (teardown registry check pins only 6)
- Trigger: the test's stated purpose is "the table being TRUE," but `observed` only ever collects {0, 2, 4, 6} and the final assertion pins exactly that set. Exit 3 (setup-gate) and exit 5 (run-locked) are behavior-tested elsewhere but never required to APPEAR on the verb's printed `Exit codes:` line, and nothing asserts the registry arrays contain them either (`:2199` checks only `toContain(6)`). Delete 3 and 5 from `verbs.ts` and every test stays green while DF3.5 generates skill exit-handling from a table that omits two shipped codes — the precise failure this test was written to prevent, for exactly the codes hardest to rediscover.

**[MEDIUM]** `within()` abandons a still-running in-process `run()` — a hang regression poisons subsequent tests via the in-process run lock
- `tests/fleet/cli.test.ts:226-238` (helper), `:1994-1998`, `:1767-1771` (usages)
- Trigger: on timeout the helper rejects but the abandoned `run()` keeps executing in this process. The dangling-symlink case names `while(true)` retry-loop as the mutation it catches — that mutation leaves a teardown spinning forever holding run-lock.ts's `held` map entry, so every LATER test in the file that touches that runId answers `run-lock-reentrant`/`run-locked`, and the background invocation recreates files under a directory `afterEach` already `rmSync`'d. Unrelated tests flip red (or the cascade masks the original failure) exactly when the suite most needs a clean signal.

**[MEDIUM]** OK-arm harvest depends on the developer's GLOBAL git config — classic dev-machine flake
- `tests/fleet/cli.test.ts:1710-1722`
- Trigger: `git init/config/add/commit` run with the ambient global config. A host with `commit.gpgsign=true` (and no agent) fails or hangs the commit; a global `core.hooksPath` can run arbitrary hooks; `init.defaultBranch` warnings pollute nothing but signing alone kills the test. No `-c commit.gpgsign=false` / `--no-gerrit`-style isolation is passed. Fails as an opaque `git commit failed:` error unrelated to the protocol arm under test.

**[MEDIUM]** 40–63-char secret-shaped run ids are an untested band, and the `a`×64 row rides an accidental branch
- `tests/fleet/cli.test.ts:1518-1572`
- Trigger: the truncation branch covers only length 13–39; `a.repeat(64)` falls into the `else` "verbatim echo" branch that its own comment says is for ids "short enough for runIdEcho not to truncate." Whether a 64-char pure-letter id survives `redactSecrets` verbatim (while `Q`×300 is eaten whole per the LONG_ID pin) rests on undocumented classifier details invisible in the diff — a classifier tweak flips this row between pass and fail with no test intent changing. Worse, NO case exercises a 40–63-char MIXED-CLASS (credential-shaped) id, the band where the store's verbatim echo is supposedly eaten by the sink: weaken that rule and a pasted secret of that length rides stderr with this file green.

**[MEDIUM]** `process.chdir(hostRepo)` mutates process-global state with only a `finally` as protection
- `tests/fleet/cli.test.ts:1763-1789`
- Trigger: safe only while the runner executes test files strictly sequentially in one process. Any parallel-file execution mode (or an interleaved async callback from another file landing mid-test) resolves relative paths against the throwaway repo, which the `finally` then deletes — cross-file breakage far from this test. Every other case in the file deliberately avoids chdir (see the `--dir` scoping commentary); this is the one remaining global.

**[LOW]** Live-holder tests have no try/finally around the refusing invocation — failure leaks the `sleep 30` child and skips the lock cleanup
- `tests/fleet/cli.test.ts:1814-1857`, `:1926-1959`
- Trigger: `alive.kill(); await alive.exited` and `rmSync(lock)` sit after `await runCli(...)`. Any assertion failure (or unexpected throw) inside the refused-invocation section leaks a 30-second `sleep` process and leaves the fixture lock on disk (afterEach eventually removes the dir). Ironic exposure on exactly the paths that exist to prove lock hygiene; bounded, hence LOW.

**[LOW]** `readUntilMarker`'s timeout tick strands a queued read that silently steals the next chunk
- `tests/fleet/cli.test.ts:265-293`
- Trigger: after `timedOut`, the loop issues a second `reader.read()` while the first is still pending; the stale request is fulfilled first and its bytes go to the discarded promise, so `acc` permanently misses a chunk. If the marker rode that chunk, the test reports a false `"marker" never appeared` timeout instead of exercising the assertion — a rare but real false-negative on slow/streamed output.

**[LOW]** `LOCK_HOST` probe runs at module scope with bare `expect`s and a real lock acquisition
- `tests/fleet/cli.test.ts:67-88`
- Trigger: a lock-body layout change throws during module evaluation — outside any test — aborting the entire file with an opaque runner error instead of a named failure. The probe also acquires/releases a real lock at import time, before any `beforeEach` env redirection exists. The shape guards inside the probe are excellent; the placement is not.

**[LOW]** Run-id grammar regex hand-duplicated despite `RUN_ID_RE` being imported two hundred lines up
- `tests/fleet/cli.test.ts:2892`, `:3435`
- Trigger: `/^qds-\d{8}-[a-f0-9]{6}$/` re-states the ack-id grammar as literals. A legitimate grammar widening (longer hex suffix) turns both rows into spurious failures — loud, but self-inflicted rot the import exists to prevent.

**[LOW]** Implementation constants re-encoded as string shapes: 96-char log cap, 12-char echo head, 13/40 band edges
- `tests/fleet/cli.test.ts:1552`, `:1564`, `:3706-3723`
- Trigger: `${"b".repeat(96)}…(300 chars)`, `slice(0, 12)`, and the `>12 && <40` band hard-pin derived behavior of constants owned elsewhere. The file's own `MAX_BRIEF_BYTES` commentary argues for pinning the NUMBER, not the composed string; any bound tuning breaks three rows at once with no signal about which constant moved. (Loud, not silent.)

**[LOW]** Orphan `--dir` status row asserts `vmName: runId` — the exact FakeDriver naming convention the ENOSPC test refuses to depend on
- `tests/fleet/cli.test.ts:2764-2770` vs the discipline stated at `:2894-2902`
- Trigger: internal inconsistency. `vmName === runId` is pinned as "a FakeDriver naming convention, not the envelope's promise" in the ack-unwritable case, then leaned on as an assertion in the orphan-row case. A driver-side rename fails the latter spuriously while the actual claim (--dir honoured) is fine.

**[LOW]** Final redaction assertion joins two sinks into one string, contradicting the file's own keep-sinks-separate rule
- `tests/fleet/cli.test.ts:3719`
- Trigger: `` expect(`${JSON.stringify(entries)} ${errCaptured.join("")}`).not.toContain(long) `` merges the log stream and the diagnostics stream for a whole-string scan — the same join the key-leak test explicitly forbids ("the three sinks stay SEPARATE strings"), and unlike that test it uses no fragment sweep (`leakScan`), only whole-string containment. A boundary-split or truncated fragment evades by construction.

**[LOW]** Whole file is POSIX-only with no stated precondition
- `tests/fleet/cli.test.ts` throughout (e.g. `:1187-1207` `sh -c` FIFO/file redirections, `:1115` `/dev/zero`, `:1819` `sleep`, `:3247` newline-in-filename, `:1715` git)
- Trigger: on Windows every out-of-process row fails for reasons unrelated to their subjects. Fine if CI is darwin/linux-only, but the diff nowhere says so; the first Windows CI attempt is a wall of red.

**[LOW]** Coverage gap: injected `deps.driver` with NO `--driver` flag is never exercised
- `tests/fleet/cli.test.ts:996-1011` (guard loop uses `deps({})`); every injected-driver invocation elsewhere also passes `--driver fake`
- Trigger: whether dependency injection satisfies the mandatory-driver guard is unpinned. A guard that ignores injection (demanding the flag even for embedders) or one that ignores the flag entirely when a driver is injected both ship green.

**[LOW]** `--help` byte-equality against `renderHelp(listVerbs())` is circular; only the surrounding pins give it teeth
- `tests/fleet/cli.test.ts:541`
- Trigger: comparing CLI output to the same registry function that renders it verifies delegation, not content. Mitigated by the pinned verb lines, token-boundary flag pins, and the observed-code binding — noting it because the byte-for-byte framing overstates what it proves.

**[LOW]** Four-way race: contention depth is modest and the spin barrier burns CPU
- `tests/fleet/cli.test.ts:2204-2260`
- Trigger: 15 wins per racer with ~1ms critical sections on an unloaded machine may rarely produce genuine overlap pressure (the only positive proof is `acquired > 0`); the 800ms busy-wait barrier spins four cores at launch. The marker-in-critical-section design is sound and the authors measured the alternative; residual risk is a narrowly-interleaved `claim` bug slipping under thin contention.
