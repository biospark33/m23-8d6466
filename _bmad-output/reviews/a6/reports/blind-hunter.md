# A6 round-1 review — blind-hunter report

Reviewer: blind-hunter subagent (read-only, no authoring context).
Scope: `git diff dev...HEAD` = c9d03b51 (wrapper, leaf, crontab.factory, two suites) + 625e27c6 (SKILL.md chore).
Method: adversarial correctness hunt over production behavior — exit contracts, JSON emission, env resolution, locking, timing.

## Findings

- **BH-001 · HIGH · scripts/gitnexus-refresh.sh:286-288** — `emit_and_exit` interpolates `stalenessAlarm.stampPath` into the JSON log line RAW (no `json_escape`), unlike every other string field (`indexedHeadSha`, `cliInstalled`, `cliExpected`, `detail`). I1's stampPath is operator/test-controlled via `QDS_GITNEXUS_HOME`; sed capture truncation at `\"` escapes leaves a dangling backslash, and the raw interpolation can swallow the closing quote — producing an unparseable line while the wrapper exits 0.
  Fix: wrap in `json_escape` (same pattern as neighboring fields). Severity HIGH because the emission contract (parseable single-line JSON) is the branch's core observable.

- **BH-002 · MED · scripts/gitnexus-refresh.sh:79-81,175,252,299-303** — `QDS_GITNEXUS_HOME` split-brain: the wrapper pins lock dir + stamp reads + I1 reader to the override home, but the default canonical reindex hardcodes `<repoRoot>/.gitnexus` (install-gitnexus-plus.sh:509-515). With only the home overridden, crossCheck fails every cycle naming `crossCheck`, not the real cause.
  Fix: split-brain guard — home set non-empty while the reindex command is still the production default → pre-cycle FATAL exit 3 naming both vars; header clarification; suite prose fix (refresh-cron.test.ts:196-199) + new fixture test.

- **BH-003 · LOW · scripts/gitnexus-refresh.sh:233-236** — `num_or_null` rejects JSON exponential notation: `JSON.stringify` emits e.g. `2.77e-7` for `|ageHours| < 1e-6` (stamp within ±3.6 ms of the reading clock), silently coercing a measured age to `null` on a fresh verdict.
  Fix: regex accepts optional `[eE][-+]?[0-9]+` + comment citing the producer. No deterministic end-to-end test exists (window ≈3.6 ms; timing cannot reliably hit it) — documented in the comment.

- **BH-004 · LOW · scripts/gitnexus-refresh.sh:22-28 vs 290-293** — sink-append failure inside `emit_and_exit` exits 3, contradicting the header's exit-3 definition (pre-cycle config failure, NO cycle ran). A fully-executed cycle is mislabeled as a config no-op and AC3's exactly-one-line invariant has no trace.
  Fix: exit 1 (a cycle that ran and could not record IS a failed cycle) + FATAL on stderr; header lines updated; new test: `QDS_REFRESH_LOG` under a read-only fixture dir → exit 1, FATAL names the sink, no line anywhere.

- **BH-005 · LOW · scripts/gitnexus-refresh.sh:314-325** — flock error vs refusal conflated: every non-zero `flock -n` exit records `skipped-overlapping` exit 0 — a broken lock (ENOLCK-class) degrades to silent never-refresh with healthy-looking skip lines.
  Fix: portable flock cannot distinguish (exit 1 covers both; no `-E` on macOS brew flock — measured). Honest fix is truth in docs: header + inline comment state the conflation and its observability signature (recurring skip lines with rising stalenessAlarm = broken lock, not contention); behavior unchanged.

- **BH-006 · LOW · deploy/vps/crontab.factory:1-10 vs wrapper:82-84,147-154** — PATH prerequisite documented only in the wrapper header, one hop from the file the operator installs; first fired tick likely FATALs until the operator hand-edits the crontab.
  Fix: covered by the EH-001 fix (wrapper bun-location fallback + crontab header comment).

Sensitivity check: the seeded round-0 finding R0-1 (= BH-001) was independently rediscovered and rated HIGH — sensitivity confirmed.

## Round 2 (2026-10-13, scope: fix commit 12941273)

Verdict: no HIGH/MED in the round-1 fixes. Four LOWs, all in code/comments the fix introduced:
BH2-003 (split-brain guard keys on presence, not coherence — the canonical-writer-spelled-as-override door; = EH2-001),
BH2-001 ($HOME/$PATH unguarded under set -u in the probe; = EH2-002),
BH2-002 (crontab comment self-undermining: root-owned 755 dir blocks the deploy user's log creation),
BH2-004 (waitForLine comment/code drift on newline-termination).
All regression lanes flagged in the round-2 brief verified clean. Full dispositions: round-2-triage.json.
