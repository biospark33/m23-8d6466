# Blind review — scripts/fleet.ts (chunk-cli-a.diff)

Reviewed the diff alone, no repo context. Line numbers are new-file lines (diff line − 5).

**[MEDIUM]** EPIPE on harvest/teardown completion lines is swallowed → exit 0 with the result line silently lost
- `scripts/fleet.ts:771` (`emit`'s `if (errno === "EPIPE") return;`), `scripts/fleet.ts:813` (`reportCompletion`), `scripts/fleet.ts:1363`/`1454` (harvest/teardown call sites)
- Trigger: `fleet harvest qds-x | head -0` (or any consumer that closes the read end early). `emit` swallows EPIPE, so `reportCompletion` sees success and returns `true` → `code = 0`. The `harvested: N` / `torn down: <id>` line never arrives, yet exit 0 tells the CI script the count was delivered. This is exactly the "work landed but its line did not print" condition the file itself codes as 6 for ENOSPC/EBADF via `reportCompletion`, and as 6 for the dispatch ack's EPIPE at `scripts/fleet.ts:1128` — same information loss, three different outcomes depending on errno and verb. A consumer piping harvest output through an early-exiting filter believes it has the count when it has nothing.

**[MEDIUM]** `--help` on a real verb logs a CC-9 line indistinguishable from a successful execution of that verb
- `scripts/fleet.ts:874-879` (help return path), `scripts/fleet.ts:659-684` (`logVerb`)
- Trigger: `fleet teardown <id> --driver fake --help`. Parsing returns `{help:true, verb:"teardown"}`, and `finish(..., bounded(parsed.verb), undefined, 0)` logs `operation: "fleet.teardown"`, `phase: "complete"`, `status: "ok"`, `exitStatus: "success"`, `exitCode: 0`, `runId: null`. The file's own stated motivation for logging help was that `teardown <id> --help` is "an operator who meant to destroy a box and did not [and] a dashboard … cannot tell that invocation from one that never happened" — but the fix makes it worse than invisible: dashboards keying on operation+status now COUNT it as a successful teardown. Nothing in the line distinguishes help from a real run except the absent runId.

**[MEDIUM]** Refusal envelopes echo unbounded argv-derived strings, defeating the file's own MAX_ECHO/redact discipline
- `scripts/fleet.ts:499` (`unknown verb ${JSON.stringify(verb)}`), `scripts/fleet.ts:507` (`${verb} does not take ${flag}`), `scripts/fleet.ts:462` (`${name} takes no value`), `scripts/fleet.ts:965` (`--port ${JSON.stringify(portRaw)}`), `scripts/fleet.ts:242`/`246` (`--dir ${dir} …`), `scripts/fleet.ts:538` and `643` (`--brief ${briefPath} …`)
- Trigger: `fleet $(head -c 200000 /dev/urandom)` or `fleet dispatch --port $(head -c 200000 /dev/zero | tr '\0' '9')` — the full 200 KB token lands verbatim in the stderr envelope and hence the CI job log. The file explicitly treats this exact shape as a bug it fixed twice ("one refused invocation writing 200 KB into the operator's log stream", `bounded()` at `scripts/fleet.ts:705`; `assertFleetRunId` capping the id echo) — but those bounds cover only log fields and the run-id refusal, while every OTHER argv echo in an exit-2 envelope is uncapped and unredacted. Inconsistent within one file: the same paste is capped to 96 chars in one sink and full-length in another.

**[MEDIUM]** `markRunLockDestructive(lock)` is unguarded — a failed/partial mark write yields exit 1 "transient" plus a released lock, then wedges every retry
- `scripts/fleet.ts:1417` (unguarded call), contrast `scripts/fleet.ts:1436-1447` (sibling `clearRunLockDestructive` guarded → 6)
- Trigger: ENOSPC/EIO while writing the destructive mark just before `teardownSandbox`. The throw escapes before `destructiveInFlight = true`, so the `finally` releases the lock normally and `report` stamps exit 1 = retry-me. But if the mark was partially persisted, the next invocation acquires… nothing: it refuses on the mark (5) forever until an operator rms the lock — precisely the "transient that nothing will ever clear" the exit table exists to prevent, and the reason the CLEAR side of the identical operation got its own guarded 6 path. Asymmetric handling of the two halves of one flag.

**[MEDIUM]** `readBriefFile` classifies transient errnos as permanent usage errors
- `scripts/fleet.ts:573-584` (`openSync`/`readSync` catches → `unreadable()` → FleetError exit 2), same for `statSync` at `scripts/fleet.ts:546`
- Trigger: fd-table exhaustion (`EMFILE`/`ENFILE`) or `EAGAIN` on a non-blocking fd during `fleet dispatch --brief x` → exit 2, code `brief-unreadable`, remediation "point --brief at a readable regular JSON file". The file's own `RETRYABLE_ERRNOS` set (`scripts/fleet.ts:343`) names EMFILE/ENFILE/EAGAIN as substrate failures that must map to exit 1 transient — `asUsage` honors that doctrine, this path bypasses it. Automation reading exit codes treats a momentary fd shortage as a permanently wrong invocation and gives up (or pages someone about a brief that is fine).

**[MEDIUM]** `status` lacks the no-record → exit 4 mapping its sibling verbs have
- `scripts/fleet.ts:1288-1301` (`notFound` defined only in the shared harvest/teardown scope), `scripts/fleet.ts:1232` (status catch goes straight to `report`)
- Trigger (conditional): `fleet status qds-nosuchrun --driver fake --dir <dir>`. Harvest/teardown wrap their record reads in `notFound` so `no-record` becomes FleetError 4; the status branch calls `statusRun(statusDeps, runIdArg)` unwrapped. Unless `statusRun` itself raises a FleetError with exitCode 4 (not visible in this diff), a missing run exits 1 `transient` — "retry me" for an id that will never exist, inconsistent with the header's own table ("4 run-not-found") and with how the other two verbs classify the identical input.

**[LOW]** `invalid-brief` embeds the raw JSON.parse message unredacted — a third foreign-text entry point past the two the file claims are all of them
- `scripts/fleet.ts:1016-1020`
- Trigger: brief whose bytes near a syntax error contain a credential; engine parse-error messages quote local context ("Unexpected token X at position N"), which lands in the exit-2 envelope without `redactSecrets`. The module doc says foreign text enters only via `asUsage` and `report`'s untyped branch; this is a third path, argued away nowhere.

**[LOW]** A brief legitimately containing U+FFFD bypasses the injected-reader byte cap entirely
- `scripts/fleet.ts:999-1009`
- Trigger: embedder-supplied `readBrief` returns text containing a real U+FFFD character and more than 64 KiB — `rawBrief.includes("\u{FFFD}")` is true, so the re-measure is skipped and the oversized brief proceeds. Real stdin/file readers cap raw bytes, so this only widens the seam the comment says the check exists to bound; but the guard silently does not bind for any lossy-or-legit-FFFD decode rather than only corrupt ones (a presence test cannot distinguish them).

**[LOW]** `-h` and `--help` together slip the duplicate-bool guard
- `scripts/fleet.ts:447-451`
- Trigger: `fleet teardown <id> --driver fake -h --help` — the scan compares raw strings, both pass once, normalization merges them into one `--help`, and the invocation is accepted where `--help --help` is refused. Cosmetic inconsistency in a guard whose stated purpose is "a repeated one is exactly the invocation an operator must be sure they typed."

**[LOW]** SIGINT mid-dispatch logs `runId: null` even after dispatch() has minted/persisted the id
- `scripts/fleet.ts:940` (handler logs `dispatchRunId`), `scripts/fleet.ts:1102` (`dispatchRunId` assigned only after `await dispatch(...)` resolves)
- Trigger: Ctrl-C after dispatch() persisted the record but before the await returns → CC-9 line reports `runId: null` for a run that demonstrably exists and holds a live box — the exact gap `runIdFromError` was built to close for the throw path, left open for the signal path.

**[LOW]** Embedded callers get no diagnostics sink: `setLogSink` runs only under `import.meta.main`
- `scripts/fleet.ts:1593-1596`
- Trigger: a test/embedder calls `run(argv, out)` directly → every `logVerb` CC-9 line goes to `src/swarmclaw/log.ts`'s default sink instead of the caller's `err`, breaking the module's own "every diagnostic goes to stderr as JSON lines" contract and possibly polluting whatever the default sink writes to (stdout included).

**[LOW]** Exit 2 doubles as "your flags were wrong" and "the store's record files are corrupt"
- `scripts/fleet.ts:1225-1230` (`records-skipped` → 2)
- Trigger: one unreadable record file under `--dir` → exit 2, the table's "usage/schema" code that consumers treat as fix-the-command-line. Payload distinguishes, but the code taxonomy conflates an operator typo with corrupted state needing repair; the file argues itself into 2 ("permanent") without noting the collision with genuine usage refusals sharing the code.

**[LOW]** `parseValueFlags(..., { help: [HELP] })` passes help PROSE into what reads as a token-list option
- `scripts/fleet.ts:471-481`
- Trigger: unverifiable from the diff — sibling options (`flags`, `valueFlags`, `boolFlags`) are all name lists; `help` receives `[HELP]`, a single-element array containing multi-line prose. Either it is display text (works) or a trigger-token list that can never match (dead config). If the latter ever changes to match by prefix, `-h`/`--help` would hit the helper's documented stdout+`process.exit(0)` behavior — fatal to embedders per the file's own comment.

**[LOW]** `flagNames()` splits a flag declared boolean in one verb and value-taking in another into both grammars
- `scripts/fleet.ts:124-127`
- Trigger (latent): registry adds `--format` as boolean on `status` and valued on `dispatch` → it lands in BOTH `VALUE_FLAGS` and `BOOL_FLAGS`; the tokenizer then treats `--format json` inconsistently per position and the eq-check refuses `--format=json` everywhere even on the verb where the `=` form is legal. No cross-verb type-conflict check exists between the two derived lists.
