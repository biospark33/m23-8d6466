[self-compact · notice] Heads-up only. Context usage is {{used_tokens}} tokens ({{used_percent}}) of a {{context_window}}-token window, past the soft line of {{soft_tokens}} ({{soft_percent}}). Nothing is blocked, nothing is required, and this message asks for no action. Keep working.

For awareness: the warning line is at {{warning_tokens}} tokens ({{warning_percent}}) and the hard cutoff at {{forced_tokens}} ({{forced_percent}}), {{remaining_to_forced}} tokens away. You will be told when you reach the warning line. Call `view_context` for current numbers.

You are in control of when to compact. `self_compact` takes a `note_to_self` (up to {{note_max_chars}} chars). Your note is the contract: after compaction it is handed back to you as is, so anything you will need later (evidence paths under `_bmad-output/`, calibration constants, exact commands, branch/PR state) must be IN the note, not trusted to the summary. Compaction cycles completed so far: {{cycle}}.
