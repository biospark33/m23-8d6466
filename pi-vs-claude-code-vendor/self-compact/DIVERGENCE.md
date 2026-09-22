# Divergence ledger — vendored self-compact extension

Vendored from upstream `disler/self-compact-pi-agent` at commit
**`576fe4abda021849f5cde5b6f5796467ffa4bcbd`** (2026-09-20, subtree
`apps/self-compact/**`, pinned in `package.json` `_provenance`).

## Rules for maintainers

- Everything under `extensions/`, `tests/`, and `scripts/` is upstream-verbatim.
  Any future upstream sync MUST 3-way merge against the pinned commit — do not
  overwrite.
- The ONLY local forks are the three prompt files in `.pi/self-compact/` (rows
  below) and this file. New local edits get a row here (what + why, 1–2 lines).

## Divergences

| File | Delta | Why |
|---|---|---|
| `.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md` | QDS note-contract language (evidence paths, calibration constants belong in the note) | QDS factory work loses evidence refs through generic summaries |
| `.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md` | QDS note contract: DONE/IN PROGRESS/evidence pointers/constants/git state/NEXT ACTION | Handoff quality for long-running factory agents |
| `.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | QDS Critical-Context rules (evidence paths, constants, git state, repo conventions) | Same |
