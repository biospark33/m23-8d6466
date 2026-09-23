[self-compact · WARNING] Context usage is {{used_tokens}} tokens ({{used_percent}}), past the warning threshold of {{warning_tokens}}. Time to compact soon. Hard cutoff at {{forced_tokens}} ({{forced_percent}}): {{remaining_to_forced}} tokens left before every tool except `self_compact` is blocked.

Finish only the current atomic step. Then write your `note_to_self` (max {{note_max_chars}} chars) and call `self_compact` as your only tool call.

QDS note contract — the note MUST contain, verbatim where applicable:
- Goal of the current task and the story/phase ID driving it.
- DONE: exact file paths written/modified, exact commands run, verified test results (name the log, e.g. /tmp/qds-test.log, and the pass/fail counts).
- IN PROGRESS: exactly where you stopped, including the next symbol/file you were about to touch.
- Evidence pointers: every `_bmad-output/` path, evidence DB (`.db`), and JSON artifact this task reads or writes.
- Calibration/config constants in use (e.g. QDS_FRONTIER_USD_PER_MS, QDS_E2E_LIVE tier) with their current values.
- Git state: current branch, open PR number, uncommitted work.
- NEXT ACTION last, as one exact executable step.
