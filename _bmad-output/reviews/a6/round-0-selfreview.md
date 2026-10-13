# A6 round-0 — driver self-review (2026-10-13)

Reviewer: driver (this session). Scope: `git diff dev...HEAD` = c9d03b51 (5 files) + 625e27c6 (SKILL.md chore).
Method: full reads of both production files (wrapper 367 lines, staleness 125 lines) plus crontab.factory, targeted
reads of both suites, independent byte-diff, refutation passes, live e2e cycle. Every claim re-measured.

## Findings (driver's own)

| id | where | severity | finding |
|---|---|---|---|
| R0-1 | scripts/gitnexus-refresh.sh:287 | LOW | `stalenessAlarm.stampPath` is interpolated into the log line RAW (no `json_escape`), unlike every other string field. I1's stampPath is operator/test-controlled via QDS_GITNEXUS_HOME; a path carrying `"` or `\` would emit malformed JSON. Low likelihood (self-inflicted config only), trivial fix: wrap in `json_escape`. |
| R0-2 | scripts/gitnexus-refresh.sh:290-293 | LOW | Sink-append failure inside `emit_and_exit` exits 3 — but the header reserves exit 3 for PRE-cycle configuration failure with "no cycle ran". Here a cycle DID run. Behavior is loud-and-failing either way (stderr FATAL), but the exit code contradicts the header's contract. Fix: either document the late-failure exception in the header, or exit 1 (a cycle that ran and could not record is a failed cycle). Prefer exit 1 + header already covers "1 — cycle failed"; but the stage vocabulary has no sink stage. Simplest truthful fix: keep exit 3 and add the late-failure exception to the header's exit-3 line. |
| R0-3 | scripts/gitnexus-refresh.sh:338-339 | NIT | Double blank line between stage [d] and [e]. |
| R0-4 | tests/gitnexus/staleness.test.ts | — | Refutation pass clean (array stamps, future timestamps, ENOTDIR homes, empty env, argv). 13 tests, mutated positives named. |
| R0-5 | deploy/vps/crontab.factory | — | Clean: one entry, absolute path, SHELL set, no credentials, no unescaped %. |

Round-0 dispositions: R0-1 PATCH (round 1), R0-2 PATCH (round 1, header documentation), R0-3 PATCH (trivial).

R0-1 was carried into round 1's hunter input as a seeded known finding to check hunter sensitivity.
