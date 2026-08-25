# Edge Case Review — run-lock / sandbox-teardown / pipeline-run / cost-ledger-opts

Scope: `_bmad-output/workflow-state/code-review/pr123/chunk-cli-b.diff`, verified against real sources
(`scripts/lib/run-lock.ts`, `scripts/lib/cost-ledger-opts.ts`, `scripts/sandbox-teardown.ts`,
`scripts/pipeline-run.ts`, plus callers in `scripts/fleet.ts`, `scripts/qds-cost.ts`,
`src/providers/run-record.ts`, `src/providers/cost-ledger.ts`, `src/phase-engine/manifest.ts`).

---

## Findings

**[MEDIUM] `releaseRunLock` success path has an unguarded `rmSync` — a successful release reports as a failure**
- `scripts/lib/run-lock.ts:868`
- Trigger: the rename to `.rescue` succeeded and the body verified ours, then `rmSync(claimed, { force: true })` hits EACCES/EIO/EROFS (read-only remount, parent perms tightened mid-run). `force: true` swallows ENOENT only; any other errno throws. The lock file is already gone (release SUCCEEDED), but every caller sees `lock-release-failed` + exit 1 — in `scripts/sandbox-teardown.ts:313-331` that downgrades a completed teardown (`torn down:` already printed) to exit 1, contradicting its own stdout. The orphaned `.rescue` file is permanent litter: `reapStaleTemps` deliberately sweeps only `.tmp`, and the operator-facing remediation ("rm the lock") names a path that no longer exists. Every sibling cleanup in the module is wrapped (`claim`'s finally at :600-605, `restore`'s `discard()` at :747-754); this one call is not.

**[MEDIUM] fleet's F5 closedAt-based auto-release was not ported to sandbox-teardown — the "one implementation" release policy has already drifted**
- `scripts/sandbox-teardown.ts:259-266` + `scripts/sandbox-teardown.ts:311-331`; compare `scripts/fleet.ts:2109-2150`
- Trigger: `teardownSandbox` completes close (box destroyed, key revoked, `closedAt` set) and THEN throws in post-close work (box-hour ingest refusing an unpriced row, ledger trouble). `fleet teardown` asks the record what landed, releases the lock, exits 6, and documents that a re-run is idempotent. `sandbox-teardown` for the identical state holds the lock, exits 1 with `lock-held`, and every subsequent invocation refuses `run-locked` until a human `rm`s it. The module header (`run-lock.ts:7-10`) promises acquire AND release live together "so the semantics cannot drift per CLI" — the release policy drifted anyway, in exactly the direction the F5 fix exists to remove. Money angle: the box is already destroyed, so the wedge is pure availability, but it is the same wedge F5 named (e2e-run-report F5).

**[MEDIUM] The self-pid "provably stale" branch is unsound when the same directory is reachable under two path spellings**
- `scripts/lib/run-lock.ts:691-692` (`held.has(lock)` on the `resolve()`d string) and `scripts/lib/run-lock.ts:430-437` (pid===self ⇒ stale)
- Trigger: one process acquires `<runsDir>/<id>.lock` via path A, then a second acquire in the SAME process arrives via path B where B resolves to the same directory but is not byte-identical after `resolve()` — a symlinked runs dir, or a case-variant `--dir` on macOS/Windows case-insensitive filesystems. `held` is keyed on the raw resolved string, so `held.has(B)` is false, the re-entrant guard does not fire; `claim` gets EEXIST, `claimedByUs` sees a different nonce, and `refuse` reaches the pid===self branch whose comment asserts "No live invocation can hold it: this pid is ours" and marks `stale=true` with remediation "rm <lock>, then re-run". That proof is false — THIS process is the live holder under the other spelling — and the machine-readable `stale` flag (which drives "safe to rm" automation) now advises deleting this process's own live lock mid-destruction: the double-teardown the module exists to prevent, printed as advice. Needs `realpath` (or an inode check) before treating self-pid as proof of deadness.

**[MEDIUM] A malformed or unreadable `cost-config.json` blocks teardown of boxes that are actively billing**
- `scripts/lib/cost-ledger-opts.ts:120-122` (`loadCostConfig` throws) consumed at `scripts/sandbox-teardown.ts:232-249`
- Trigger: operator fat-fingers the JSON (or an EACCES lands on the file) while a run's box is up. Every `sandbox-teardown` of that run now throws `CostConfigError` at ledger construction — after the lock is acquired, before any mutation — and the box keeps accruing hours while the only escape is editing the config or knowing the undocumented `$QDS_COST_CONFIG_FILE` override. The header declares "an unreadable one still throws" deliberate (fail-closed money safety, symmetric with `fleet dispatch`), so this is a known trade, but neither the thrown remediation nor the CLI output points at the env override, and unlike fleet's F5 arm there is no closedAt-based relief for the closed-record subset. At minimum the remediation text should name the override.

**[LOW] Default-layout detection by trailing segments misclassifies lookalike store dirs and relocates their ledger**
- `scripts/lib/cost-ledger-opts.ts:110-115`
- Trigger: a deliberate second fleet laid out as `--dir /srv/backups/.sandbox/runs` ends with `/.sandbox/runs`, so it takes the DEFAULT-layout branch: its ledger lands at `/srv/backups/.sandbox/cost-ledger.db` (sibling) instead of inside the store dir, and a stray `touch /srv/backups/.sandbox/cost-config.json` would be picked up as ITS caps. Both CLIs agree (same helper), so no split, but the ledger silently lives one level up from where the non-default rule puts it. The heuristic is documented as "is this the default layout?" — it answers "does the path end in /.sandbox/runs?" instead.

**[LOW] `envPath` rejects whitespace-only overrides but passes padded paths through verbatim**
- `scripts/lib/cost-ledger-opts.ts:92-94`
- Trigger: `export QDS_COST_LEDGER_FILE=" /srv/ledger.db "` (trailing space from quoting) survives the trim guard as a set-but-unusable path → the ledger opens at a filename with literal spaces (creating a second ledger), or for the CONFIG variant ENOENTs into silent defaults. The `loadCostConfig` `cost-config-absent-using-defaults` diagnostic partially mitigates the config half; the LEDGER half fails loudly enough (SQLite open) to be caught. Either trim the returned value or trim-compare and reject.

**[LOW] "Refuse having touched NOTHING" overclaims — the store constructor mutates the directory before the probe**
- `scripts/sandbox-teardown.ts:164` + `scripts/sandbox-teardown.ts:192-198`
- Trigger: `sandbox-teardown --dir /nonexistent typo-run-id` — `new RunRecordStore({create:true})` mkdirs the directory, chmods it 0700, probes exclusivity, and sweeps stale temps BEFORE `getRecord` refuses with `no-record`. The new comment claims the invocation "touched NOTHING"; it created and re-permissioned the records directory. `scripts/qds-cost.ts:209-214` explicitly avoids this for the reporting CLI; for the destructive CLI creation is defensible, but the comment should not promise what line 164 already did. (Side effect: `chmodSync 0700` fires on EVERY construction, silently tightening perms on an operator dir that was intentionally broader.)

**[LOW] A throwing `out()` inside the catch block replaces the real error and skips the mapped exit path**
- `scripts/sandbox-teardown.ts:274-279` (catch calls `fail(out, …)`), `scripts/sandbox-teardown.ts:342` (`out` = `writeSync(1, …)`)
- Trigger: stdout is a closed pipe (piped to `head`, CI buffer discarded). `out("torn down: …")` throws EPIPE after `clearRunLockDestructive` (:270-271); the catch then calls `fail(out, …)`, which throws EPIPE again FROM INSIDE the catch — the original error object is lost, `outcome` never assigned, and the EPIPE escapes `run()` to the top-level handler printing a bare "write EPIPE" with none of the `!! code:` diagnostics. The `finally` still releases the lock (correct), but the failure classification is destroyed by the reporter. Guard the reporting writes (or wrap `fail`'s `out` calls) the way `writeStderr` in run-lock does.

**[LOW] Diagnostics for the same condition land on different streams in different formats depending on exit path**
- `scripts/lib/run-lock.ts:307-322` (fd 2, `!! lock-held:` prose) vs `scripts/sandbox-teardown.ts:137-140` + `:320-331` (STDOUT, `!! <code>:` prose) vs `scripts/pipeline-run.ts:299-312` (fd 2, single-line JSON `{level:"warn",event:"witness_stale"}`) vs `scripts/fleet.ts` `printError`
- Trigger: a teardown interrupted by SIGINT after `markRunLockDestructive` prints its lock-held diagnostic to STDERR via `releaseHeldRunLocks`; the same state reached by a thrown error prints to STDOUT via the CLI's `fail`. A JSON consumer tailing stdout sees `!! lock-release-failed` concatenated after `torn down:`; the same consumer watching stderr misses the finally-path version entirely. Exit-code tables also diverge (teardown 0/1 vs fleet 6) — documented in the diff, but automation cannot classify "needs an operator" uniformly across the two destructive verbs.

**[LOW] Future-dated lock bodies defeat the implausible-hold hint forever**
- `scripts/lib/run-lock.ts:395` (`Math.max(0, …)` clamp) + `scripts/lib/run-lock.ts:452-455`
- Trigger: a holder's clock is ahead (VM resume, wrong TZ at mint time), holder dies, pid recycles onto a live stranger. `age` clamps to 0 and grows only as real time passes the future timestamp, so `age > IMPLAUSIBLE_HOLD_S` may not fire for hours-or-days beyond the intended 6h threshold, and the refusal reads "pid N, held 0s — wait for that invocation to finish" with no recycled-pid pointer. Fail-closed (never stale), just a dishonest `held 0s` and a delayed hint; consider clamping on `Date.parse` being in the future by more than a skew bound.

**[LOW] A failed signal re-raise latches `unwinding` and dead-letters every later Ctrl-C in the process**
- `scripts/lib/run-lock.ts:213-227` + latch at `:214`, `:165`
- Trigger: SIGINT arrives while a lock is held; locks are released, listeners stripped, then `process.kill(process.pid, sig)` throws (seccomp/EPERM sandbox, pid-namespace oddity). The `finally` restores the borrowed listeners, but `unwinding` stays `true` and `signalsInstalled` stays `true` for the life of the process: the teardown CONTINUES running mid-flight, and every subsequent SIGINT/SIGTERM is swallowed by the `if (unwinding) return;` no-op — the operator's "press Ctrl-C again to force it" convention is permanently disabled. Exotic environment required; consequence is an unstoppable CLI rather than state corruption.

**[LOW] Hostname change strands existing locks as permanently foreign with no aging signal**
- `scripts/lib/run-lock.ts:102-112` (`lockHost` embeds `hostname()` + pid-ns inode)
- Trigger: laptop renames (DHCP, container recreate with ephemeral hostname) while a shared/EBS-synced runs dir carries locks minted under the old name. Every such lock is foreign forever: never probed, never stale, never reaped — manual `rm` only, which is the designed fail-closed answer. But the foreign-host refusal (`:405-412`) prints `held Ns` without the recycled/stale guidance the same-host branch gets, so an operator staring at `pid 4821 on host old-name, liveness unknown from here, held 172800s` gets no nudge that two days of silence is itself the evidence. Cosmetic remediation-text gap on a deliberate trade.

**[LOW] Declared-cap path validates witness CONTENT before FRESHNESS, so a stale witness is reported with the wrong diagnosis**
- `scripts/pipeline-run.ts:407-437` (`admittedCeilingBeside`: parse/validate at :420-428, staleness check at :430-435) vs the witness-only path `scripts/pipeline-run.ts:290-318` (staleness checked FIRST)
- Trigger: manifest declares `limitMicroUsd`, and the sibling `run-context.json` is BOTH stale (>30 min) and carries garbage (leftover from a crashed write, truncated by the author). The declared path reads and shape-validates first, so the operator gets "carries no positive integer effectiveCeilingMicros" — sending them to inspect witness content — when the actionable truth is "it is stale, this is last run's statement". The witness-only path orders these correctly. Pure error-message precedence, both outcomes refuse.

**[LOW] Witness-only path lstats the witness twice with a TOCTOU gap between presence/staleness and content read**
- `scripts/pipeline-run.ts:296` (`witnessStaleBecause`) then `:318` (`admittedCeilingBeside` re-lstats at `:430` and separately reads bytes at `:419`)
- Trigger: mtime judged fresh, then the file is swapped/re-touched before the content read and second freshness check — content and the mtime that vouched for it can come from different instants (and `readArtifactBeneathRoot`'s hardened read is not the fd the mtime was taken from). The S28 temporal binding is explicitly advisory ("a fresh planted file still reconciles"), so this only widens an acknowledged residual; noting it because the two checks are presented as binding one artifact.

**[LOW] Empty-body refusal's remediation contradicts itself in one sentence**
- `scripts/lib/run-lock.ts:382-389`
- Trigger: `touch <runId>.lock` (or a SIGKILLed creator on a no-hardlink fs). The rendered advice is `"wait for that invocation to finish — or, only if ${who} is gone: rm ${lock}"` immediately followed by the note "…Wait and re-check first; rm it only once you have confirmed no harvest or teardown…". The base template tells the operator to rm once "holder unknown" is "gone" — an unanswerable condition for an unknown holder — and the note then walks it back. Machine-readable `stale` stays false (correct); only the prose fights itself. Consider a dedicated stale-less wording for the empty-body case instead of appending to the contention template.
