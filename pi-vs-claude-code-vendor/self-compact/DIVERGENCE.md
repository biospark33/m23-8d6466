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
| `.gitignore` | vendored from upstream root, paths re-based to subtree root (upstream assumes `apps/self-compact/` layout) | keep generated `tsconfig.tsc.json` / `verification/` out of git |
| `.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md` | QDS note contract: DONE/IN PROGRESS/evidence pointers/constants/git state/NEXT ACTION | Handoff quality for long-running factory agents |
| `.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md` | QDS Critical-Context rules (evidence paths, constants, git state, repo conventions) | Same |
| `extensions/self-compact/self-compact.ts` | typecheck fix: annotate implicit-any callback params `: any` (execute/renderCall/renderResult, message/entry renderers, footer, `pi.on(...)` handlers, filter/some callbacks) and drop the unused `formatTokens` import binding | repo tsc strict gate (dev baseline clean) |
| `extensions/self-compact/summary.ts` | typecheck fix: annotate implicit-any callback params `: any` (messages.map/content.map blocks, compact's summarize callback, response.content.some) | repo tsc strict gate (dev baseline clean) |
| `tests/harness/fake-provider.ts` | typecheck fix: annotate implicit-any callback params `: any` (messages.reduce, slice().filter) | repo tsc strict gate (dev baseline clean) |
| `repo-typecheck-shims.d.ts` | typecheck fix: NEW local ambient declarations for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox` (each imported name typed `any`); invisible to this package's own typecheck.sh (its include is extensions/** + tests/**) | repo tsc strict gate (dev baseline clean) |
| `tests/e2e/launch-variants.test.ts` | model id `anthropic/claude-sonnet-4-5` → `anthropic/claude-fable-5-1` (pi 1.1.0 model registry: sonnet-4-5 is 200k; the DoD's 1M-window case needs a 1M-registered id) | pi 1.1.0 compat (QDS: "newest pi" directive 2026-10-16) |
| `tests/harness/fake-provider.ts` | transcript-aware reads: pi-ai 1.1.0 hands providers a TranscriptContext — `context.tools`/`context.systemPrompt` no longer exist; read toolsAdded/systemPrompt off the leading system message (`transcriptSystem()` helper) | same |
| `extensions/self-compact/summary.ts` | `replaceInstructions` tolerates pi 1.1.0's core-rendered summary input ("# Conversation …"): exact prefix match on OUR serialization still replaces (pi ≤0.55); otherwise a core-rendered `# Conversation` block gets instructions appended + front-trim to budget; anything else still refused | same |
| `tests/parity/extension.test.mjs` | loader resolution: PI_INSTALL_ROOT → pi-managed release layout (~/.pi/agent/install/releases/<v>) → legacy `npm root -g` (pi ≥1.x left the global npm tree); entry path anchored to the test file, not cwd; P2 asserts anchored on the user message (the summary request now leads with the folded system message) | same |
| `extensions/self-compact/summary-splice.ts` | NEW pi-free module: `replaceInstructions` extracted from summary.ts (pure matcher, no pi imports) so the vendored layout can unit-test it (upstream's monorepo resolved the pi graph; the subtree does not) | pi 1.1.0 compat testability |
| `extensions/self-compact/summary.ts` | import the matcher from summary-splice.ts (behavior unchanged) | same |
| `tests/unit/summary-splice.test.ts` | NEW: pins all three matcher branches incl. the refusal arm (5 cases) | same |
| `tests/harness/fake-provider.ts` (2nd) | transcriptSystem throws loudly when the transcript lacks the folded leading system message (layout drift must fail, not silently misclassify every call as a summary) | same |
| `tests/parity/extension.test.mjs` (2nd) | entry anchored with fileURLToPath (raw pathname breaks on encoded/space paths) | same |
| `tests/parity/extension.test.mjs` (3rd) | host() loadExtensions serialized through an in-process promise lock + the load-error assert prints the error text (sporadic jiti-compile race only visible under bun's 300+-file scheduler) | pi 1.1.0 compat follow-through |
| `extensions/self-compact/summary-splice.ts` | trimTail bounded in UTF-16 code units (matching the .length-derived budget) with a surrogate-pair cut adjustment; the core-rendered over-check switched from codepoint count to .length | CodeRabbit review #436 |
| `tests/unit/summary-splice.test.ts` | NEW: astral case pinning the UTF-16-bounded, pair-safe trim | same |
| `tests/harness/fake-provider.ts` (3rd) | transcriptSystem replays the full system-message chain via pi-ai's `getCurrentTools`/`getCurrentSystemPrompt` — later system messages carry `toolsAdded`/`toolsRemoved` deltas, so the leading-message read goes stale once tool state changes mid-transcript | same |
| `repo-typecheck-shims.d.ts` | export the two new pi-ai names (`getCurrentSystemPrompt`, `getCurrentTools`) as `any` | same |
| `scripts/typecheck.sh` | PI_DIR falls back to the pi-managed release layout (`~/.pi/agent/install/releases/<v>/…`, newest first) when the global-npm default is absent — pi ≥1.x left the global npm tree | same |
