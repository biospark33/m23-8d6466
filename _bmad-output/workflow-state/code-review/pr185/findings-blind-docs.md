# PR #185 — Blind Review Findings (docs chunk)

Scope: `chunk-docs.diff` only (story file, sprint-status.yaml, guardrail-log.yaml, state.yaml).
No repo exploration performed; anything requiring outside confirmation is tagged `(verify)`.

## [HIGH] Review Findings ledger: count and numbering don't reconcile

- file:line: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-5-tier1-factory-skills.md` (chunk-docs.diff:118-164)
- trigger: Header claims "31 unique findings after dedupe, all resolved", but the patched lists enumerate **32** checkboxes: F1–F13 (13) + F14–F25 (12) + F26 (1) + F29–F34 (6). Numbers F27 and F28 are silently skipped — never listed as patched, dismissed, or deferred. "False positives dismissed: none among patched" does not account for them. If 34 raw deduped to 31 unique, three numbers should be missing, not two; if 32 are listed, the unique count is 32, not 31. Either the count is wrong or two findings were dropped from the record without disposition — in a PR whose entire payload is the audit trail.
- fix: State the raw count, the dedupe count, and explicitly dispose of F27/F28 (merged-into / dismissed-with-reason), or correct the "31 unique" figure to match the listed items.

## [MEDIUM] Contract-test count contradiction: 30 vs 41 inside the same story file

- file:line: story file (chunk-docs.diff:78, 105, 138, 164) and `_bmad-output/workflow-state/qds-dev/df3-5/state.yaml` (chunk-docs.diff:226)
- trigger: Dev Record "Implementation files" says `skill-contract.test.ts` is "41 tests after review round 1"; Review Findings says "30 → 41 tests" and "suite 41/41 green". But the Dev Record "Tests" paragraph still reports "contract suite 30/30 green (was 19 pre-review)" and describes the full suite as including "the 30-test contract suite"; `state.yaml` phase4 comment says "wave1 contract test RED→GREEN (30/30)"; sprint-status.yaml DF3.5 comment says "skill-contract test (30 tests...)". The 30-test figures are pre-PR-review state presented alongside post-review claims with no marker that they are historical.
- fix: Update the Tests paragraph, state.yaml phase4 comment, and sprint-status comment to the final 41-test reality (or explicitly date-stamp the 30/30 figure as the pre-review-round gate).

## [MEDIUM] detect_changes reconciliation math doesn't add up, and is stale vs the final gate

- file:line: story file (chunk-docs.diff:81 vs 105 vs 170-171)
- trigger: The "Count reconciliation" note reconciles "Implementation files (6)" with a 4-file `detect_changes` count by explaining "the four SKILL.md files are markdown and carry no symbols". 6 − 4 markdown = **2** symbol-carrying files (`skill-contract.test.ts`, `cli-contract.ts`), not 4 — the stated explanation cannot produce the reported 4-file count. Separately, the final-round gate reports `detect_changes` as "7 files / 9 symbols" (chunk-docs.diff:171) while the reconciliation note and Tests paragraph still cite "4 files / 7 symbols", with no note that the earlier figure is superseded.
- fix: Explain what the other two symbol-carrying files in the 4-file count are (or correct the count), and annotate the pre-review 4/7 figure as superseded by the final 7/9.

## [MEDIUM] "Full suite 4764 pass / 0 fail" predates the PR-review-round changes; no full-suite green on the final tree

- file:line: story file (chunk-docs.diff:105, 170-171) and `sprint-status.yaml` (chunk-docs.diff:181)
- trigger: The 4764-pass full suite is explicitly the "final re-run, post-review-fixes" of the **pre-PR** round (when the contract suite had 30 tests). The PR #185 review round then added 11 tests (30 → 41), patched four skill files, hardened `cli-contract.ts`, and edited this story file — and its own "Gates (final, this round)" line records only a **focal** run (`bun test tests/fleet/ tests/gitnexus/` 1118 pass). sprint-status.yaml repeats "Full suite 4764 pass / 0 fail" as the current state. No full-suite run over the final committed tree is evidenced anywhere in the diff.
- fix: Re-run the full suite on the final tree and update both records, or annotate the 4764 figure as pre-review-round and name the focal-only final gate in sprint-status.

## [MEDIUM] Story file shows no Status-line update in this diff (verify)

- file:line: story file (whole diff hunk set)
- trigger: sprint-status.yaml flips DF3.5 `ready-for-dev` → `review` and state.yaml records `phase5_verify_pr: done` / "sprint-status flipped to review", but no hunk in this diff touches the story file's own `Status:` line (bmad stories carry one; the DF3.2 entry in this same file's sprint history — chunk-docs.diff:177 — records an earlier instance of exactly this drift shape, "stayed at `review` past the merge and was corrected"). If the story's Status still reads `ready-for-dev`/draft, the three status sources disagree. (verify — the Status line may be outside the changed hunks and already correct.)
- fix: Confirm the story's Status line reads `review`; if not, flip it in this PR.

## [MEDIUM] AC4 demands "match count is zero" while the DoD and tests carve out two allowlisted hits (verify)

- file:line: story file (chunk-docs.diff:18-22 vs 53-59 vs 139)
- trigger: The amended AC4 text visible in the diff says "Then the match count is **zero**" with no exemption language. The DoD lint item says "zero hits **outside the two verbatim `factory-guide` allowlist entries**", and F14 records a "pattern-(f) guide exemption now exact-line verbatim allowlist". As far as the diff shows, the AC and its implementation/DoD contradict: zero means zero, but two deliberate matches are exempted. The exemption may be defined in AC4 text below the hunk (patterns (b)–(f) are off-diff) — (verify).
- fix: Make AC4 itself name the two verbatim allowlist exceptions (or confirm the off-diff AC4 text already does and ignore this).

## [LOW] AC3 and the DoD now prescribe different preflight commands

- file:line: story file (chunk-docs.diff:17 vs 30-31, 86, 129, 159)
- trigger: AC3 (unchanged context line) instructs the agent to "run `fleet --help` and stop"; the amended DoD item, F6, and F32 change the preflight to `bun scripts/fleet.ts --help`. Decision 1 says the bare `fleet` form is "also accepted" by the contract test, so this is tolerated — but the story's AC and DoD now literally name two different commands for the same action.
- fix: Align AC3's wording with the bun-prefixed form (or note in Decision 1 that AC3's bare form is the intentional operator-facing shorthand).

## [LOW] Two different review rounds both labeled "round 1"

- file:line: story file (chunk-docs.diff:79, 107, 118, 121)
- trigger: "Review round 1 (pre-PR adversarial self-review)" (10 findings) and "Review Findings — round 1 (PR #185)" (7-agent wave, 31/32 findings) are distinct rounds with the same ordinal. Line 79's "tightened in review round 1" is unresolvable without guessing which round is meant.
- fix: Rename to "pre-PR self-review" vs "PR review round 1" (or number them round 0 / round 1).

## [LOW] Machine-specific absolute paths baked into story and state records

- file:line: story file (chunk-docs.diff:92, 101) and `state.yaml` (chunk-docs.diff:231)
- trigger: `/Users/steve/reference-repos/{...}` appears as load-bearing evidence in Decision 4, Deviation 2, and state.yaml notes. These paths exist on one host only; the record is non-reproducible for any other reader, and Deviation 2's "verified" claim rests on them.
- fix: Record the upstream repo URLs + commit SHAs as the evidence; keep local paths, if at all, as parenthetical convenience.

## [LOW] guardrail-log `timestamp: 2026-09-01` is an unquoted YAML date scalar (verify)

- file:line: `_bmad-output/workflow-state/qds-dev/df3-5/guardrail-log.yaml` (chunk-docs.diff:192)
- trigger: Bare `2026-09-01` parses as a YAML timestamp, not a string. If whatever consumes this log (or sibling logs in other stories) expects an ISO string, this is a silent type mismatch. No sibling schema is visible in the diff. (verify)
- fix: Quote it (`timestamp: "2026-09-01"`) or confirm the consumer expects a date type.

## [LOW] Claims resting on files outside this PR (verify)

- file:line: story file (chunk-docs.diff:79, 84, 90, 102)
- trigger: Several "done/verified" claims reference artifacts not in this PR and not checkable from it: DF3.4's deferred D2 "already closed 2026-08-28" per `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md:427-536`; "user-approved" GR-002 override (approval itself is asserted, not evidenced); the pre-existing drift claim on dev@7806bbe; "index was stale/corrupted per DF3.4's record". Each may be true — the diff alone cannot show it.
- fix: No change required for the PR itself; reviewers should spot-check the cited plan file and the drift claim before treating Deviation 3 as proven.

---

Clean: both new YAML files parse as valid YAML (no tabs, no duplicate keys, folded scalar in guardrail-log is well-formed, flow-mapping edit in sprint-status.yaml is syntactically sound).
Clean: dates are internally consistent — implemented 2026-09-01, guardrail timestamp 2026-09-01, review round dated 2026-09-01, state.yaml started 2026-08-31, e2e runId `qds-20260901-*` matches.
Clean: sprint-status `status: review` matches an open PR #185, state.yaml `phase5_verify_pr: done`, and `override_count: 1` matches the single GR-002 entry in guardrail-log.yaml.
Clean: skill line counts (133/144/114/91) are consistent between the Implementation files list and F33, and all satisfy the DoD ≤200-line constraint.
Clean: Deviation 1's reasoning is sound — `\ballowlist\b` cannot match "allowlisted", the DoD item is annotated "(literal string substituted — see Deviation 1)", and F30 records exactly that annotation; the AC1 narrative's dropped `(did you mean --fanout?)` matches F34's explanation and the amended AC text.
Clean: branch (`feature/df3.5` cut from dev@7806bbe post-PR-#183) is stated identically in the story Dev Record, sprint-status comment, and state.yaml.
