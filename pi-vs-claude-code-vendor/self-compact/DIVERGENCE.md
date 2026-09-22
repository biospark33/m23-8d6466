# Divergence ledger — vendored self-compact extension

Vendored from upstream `disler/self-compact-pi-agent` at commit
**`576fe4abda021849f5cde5b6f5796467ffa4bcbd`** (2026-09-20, subtree
`apps/self-compact/**`, pinned in `package.json` `_provenance`).

## Rules for maintainers

- Everything under `extensions/`, `tests/`, and `scripts/` is upstream-verbatim,
  **amended 2026-09-22 to "verbatim except typecheck fixes, every fix logged"**
  (rows below). Upstream syncs MUST 3-way merge against the pinned commit AND
  re-apply these typecheck rows — do not overwrite.
- The ONLY local forks are the three prompt files in `.pi/self-compact/` (rows
  below), the repo typecheck fixes (rows below), and this file. New local edits
  get a row here (what + why, 1–2 lines).

## Divergences

| File | Delta | Why |
|---|---|---|
| `.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md` | QDS note-contract language (evidence paths, calibration constants belong in the note) | QDS factory work loses evidence refs through generic summaries |
| `.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md` | QDS note contract: DONE/IN PROGRESS/evidence pointers/constants/git state/NEXT ACTION | Handoff quality for long-running factory agents |
| `.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | QDS Critical-Context rules (evidence paths, constants, git state, repo conventions) | Same |
| `extensions/self-compact/self-compact.ts` | typecheck fix: annotate implicit-any callback params `: any` (execute/renderCall/renderResult, message/entry renderers, footer, `pi.on(...)` handlers, filter/some callbacks) and drop the unused `formatTokens` import binding | repo tsc strict gate (dev baseline clean) |
| `extensions/self-compact/summary.ts` | typecheck fix: annotate implicit-any callback params `: any` (messages.map/content.map blocks, compact's summarize callback, response.content.some) | repo tsc strict gate (dev baseline clean) |
| `tests/harness/fake-provider.ts` | typecheck fix: annotate implicit-any callback params `: any` (messages.reduce, slice().filter) | repo tsc strict gate (dev baseline clean) |
| `repo-typecheck-shims.d.ts` | typecheck fix: NEW local ambient declarations for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox` (each imported name typed `any`); invisible to this package's own typecheck.sh (its include is extensions/** + tests/**) | repo tsc strict gate (dev baseline clean) |
