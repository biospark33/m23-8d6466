# Blind CLI Review — PR128-r6 chunk-cli

## BLOCKER

- [BLOCKER] path traversal unblocked on --steps-json — scripts/fleet.ts:802 — Operator passes `--steps-json ../../etc/passwd` or `--steps-json ../../../tmp/secrets.txt`. The path passes the `FANOUT_ID_RE` grammar (that check is for the *positional* fanoutId, not the flag value), then `statSync` and `readFileSync` succeed (or read fails and is caught, but still attempted). No path traversal check (`..`) nor resolution-to-absolute nor containment proof. Attacker can probe arbitrary files and read their contents. Fix: resolve to absolute, verify contained within expected directory, ban `..` segments.

## HIGH

- [HIGH] help text lies about --dir semantics — scripts/fleet.ts:479 (comment) — Help says "--dir (producer) the DISPATCH directory" but the flag actually names the FANOUTS directory (consumer semantics) per line 644 `fanoutsFlagDir = injectedFanoutsDir ?? dir` and line 621-625 comment. Operator who passes `--dir` expecting it to point at where dispatch writes run records will be confused. The comment at 621-625 acknowledges the ambiguity: "one flag, one meaning" but the meaning is NOT documented in help. Fix: update help text to clarify --dir names fanouts directory for both producer/consumer.

- [HIGH] unbounded numeric values accepted — scripts/fleet.ts:506-523 — Both --n and --cap-micro-usd use regexes that accept arbitrarily long digit strings (`[1-9][0-9]*` and `[1-9]\d*`) with only upper bound check against FANOUT_MAX_N for --n. No upper bound on --cap-micro-usd at all—operator can pass `--cap-micro-usd 99999999999999999999` which passes the regex and `Number.isSafeInteger` check (it's safe!) then propagates a budget cap that overflows downstream calculations or exhausts SQLite integer range. Fix: add reasonable upper bound (e.g., `Number.MAX_SAFE_INTEGER` or domain-specific max).

## MEDIUM

- [MEDIUM] sync I/O on untrusted input path — scripts/fleet.ts:831 — `readFileSync(stepsPath, "utf8")` blocks the event loop on a file whose size was capped at 1MiB but may still be on slow/network filesystem. Attacker can stall the CLI by pointing at a FIFO or slow file (the `isFile()` check blocks directories but not FIFOs or special files on some platforms). Acceptable for CLI but could be `readFile` async. Fix: use async readFile or explicitly reject non-regular files.

- [MEDIUM] error swallowing on ack write — scripts/fleet.ts:448-453 — When `out()` throws (e.g., stdout pipe closed, full disk), the catch normalizes `(e ?? {})` to read `.message`. A sink that throws with a primitive (e.g., `throw 42`) or object without message will log "42" or "undefined" instead of a useful diagnostic, and the error is redacted but still reported as "ack-unwritable" with reduced diagnostic value. Fix: preserve full error in diagnostic log even if redacted from output.

- [MEDIUM] error swallowing on ledger close — scripts/fleet.ts:942-947, 1006-1012 — Same pattern: `(e ?? {}) as { message?: string }`. A library that throws `throw null` or `throw new Error()` without a message field (rare but possible) produces "undefined" in the error log. The real failure is hidden behind "could not close" with no actionable detail. Fix: log full error object, default message if missing.

- [MEDIUM] race loser ledger close silent on failure — scripts/fleet.ts:750-762 — The loserLedger close() in finally only logs to stderr and sets `fanoutCode = 6` if current code is 0. If an arm already failed (code=1), the close failure is silently swallowed—operator sees "armFailed" and never learns the loser box-hours may not have been priced into the ledger. Money silently unaccounted. Fix: always log close failure regardless of current code.

- [MEDIUM] auto-rank failure degrades silently — scripts/fleet.ts:707-725 — When auto-rank fails (e.g., record unreadable), it catches and logs to stderr then continues. The fanout exits 0 if arms succeeded, and the advisory ranking line is simply missing from stdout. Automation that parses the ranking line gets no indication it's missing—just incomplete output. Fix: exit non-zero or emit a sentinel line indicating rank-failed.

## LOW

- [LOW] roster empty-string handling ambiguous — scripts/fleet.ts:538-546 — `--roster ""` and `--roster ","` both map to `rosterIds = undefined` (empty after split/filter). The operator intent "empty roster" is conflated with "no flag provided". For many-stories this is fine (roster forbidden), but for best-of-n/race an empty list could be a clear error vs. "forgot to pass --roster". Fix: treat empty-list explicitly as error for patterns requiring roster.

- [LOW] steps-json shape guard inconsistent — scripts/fleet.ts:847-861 -- The shape check enforces `testResults` must have integer passed/failed but does NOT enforce that if `testResults` exists, `testsExecuted` must be true. Operator can pass `{testResults: {passed: 3}, testsExecuted: false}` which is logically inconsistent (tests not executed but have results). Validation passes, rank calculates score. Fix: enforce logical consistency between testsExecuted and testResults presence.

- [LOW] MAX_ECHO undefined constant — scripts/fleet.ts:785 — `fanoutId.slice(0, MAX_ECHO)` references `MAX_ECHO` which is not defined in this diff. If it's not imported/defined elsewhere, this throws ReferenceError at runtime when operator passes malformed fanoutId. The slice is used only for error message (truncating long id), so the failure mode is "error message fails to render" not silent corruption—but still a crash. Fix: import or define MAX_ECHO constant.

## INFO

- [INFO] case-sensitive pattern matching — scripts/fleet.ts:568-571 — Pattern validation is case-sensitive: `--pattern BestOfN` throws "unknown pattern". Acceptable (patterns are enum-like), but help text should clarify case-sensitivity if not already stated. Current error message "pattern is one of best-of-n, many-stories, race" implies lowercase but doesn't explicitly say so.

- [INFO] fanout record store chmod side-effect — scripts/fleet.ts:632 — `new RunRecordStore` mkdirs and chmods the directory even for fanout (which writes fan-*.json not run-*.json). The comment at line 621-625 acknowledges fanouts dir is separate but the store still chmods its own dir. Acceptable but means `--dir` pointing at existing dir will re-chmod it. Not a bug but a footgun if operator points at shared directory.
