# Self-Compaction for the Pi Agent Fleet — Design

**Date:** 2026-09-22
**Status:** Approved design, pending implementation plan
**Upstream:** https://github.com/disler/self-compact-pi-agent (MIT)
**Branch convention:** feature/ branch → `dev` (qds-dev convention)

## Problem

Long-running pi agents in the QDS-Factory fleet have no context management. Today the
only bounds are engine-side prompt char ceilings (`PROMPT_CHAR_CEILING = 16_000` in
`src/phase-engine/steering.ts`); the agents' own conversation contexts grow unbounded
until the model window fills and pi's reactive near-the-wall compaction fires — too
late, with no handoff contract, and after the session has already degraded.

Upstream `self-compact-pi-agent` solves this with proactive, agent-driven compaction:
the agent monitors its own usage and compacts itself at chosen thresholds, carrying a
verbatim handoff note across the compaction boundary.

## Decisions (agreed)

| Decision | Value | Rationale |
|---|---|---|
| Warning model | Phase thresholds (notice / warning / forced), position-based | No per-session state to track; upstream-proven; gauge shows position |
| Cutoffs | soft 30% / warn 50% / hard 60% (warn + 10% buffer) | Uses more of the paid window per cycle than upstream defaults (10/20/30); fewer compaction cycles = fewer full-context summarize calls, fewer cache-miss rebuilds (pi fixed overhead already 78–88% of bill), less compounding summary-fidelity loss. Post-compact headroom is identical regardless of hard position (note-verbatim handoff). Gap of 10% ≈ 13k tokens on a 128k window is enough to react |
| Summary prompts | QDS-flavored | Must preserve evidence refs (`_bmad-output` paths, DB paths), calibration constants, in-flight task state, exact tool-call syntax across compaction |
| Rollout | Worker agents first | Resident spawns `pi --no-tools` (`src/fleet/resident.ts`), so the `self_compact` tool cannot fire there; resident gets its own mechanism later |
| Integration approach | Vendor upstream verbatim + thin config layer | Upstream tests come free, upstream pulls stay diffable, same precedent as the vendored coms extensions. Rewriting in repo style (rejected) costs now and forever; minimal reimplementation (rejected) reimplements the risky recovery paths while dropping the cheap UI |

## Architecture

Vendored extension lives beside the existing coms extensions:

```
pi-vs-claude-code-vendor/self-compact/
  extensions/self-compact/self-compact.ts   # upstream, verbatim
  defaults.ts                                # upstream, verbatim
  thresholds.ts                              # upstream, verbatim
  context-bar.ts                             # upstream, verbatim
  prompts.ts                                 # upstream, verbatim
  summary.ts                                 # upstream, verbatim
  state.ts                                   # upstream, verbatim
  prompts/                                   # QDS-flavored prompt files (the only fork point)
  DIVERGENCE.md                              # documents every delta from upstream
```

Upstream source files remain pristine. All QDS-specific behavior is expressed through
the prompt files (upstream's designed fork point) and `DIVERGENCE.md`. Upstream's own
test suite (`just verify`) continues to run against the vendored copy unmodified.

## Wiring (existing chain, no new seams)

1. `config/rosters/qds-default.roster.yaml` — worker roles gain the extension path in
   `harness_engineering`. The roster is the single source of truth for the threshold
   values (30/50/60); they are never hardcoded in driver code.
2. Manifest build maps `harness_engineering` → `manifest.team.workers[].extensions`
   (repo-root-relative; INV-2 escape guard already enforced in
   `cli-anything/scripts/team-lead-driver.ts`).
3. `buildWorkerArgv` emits `-e <path>` per extension — explicit `-e` pairs load even
   under the `lean` profile (`--no-extensions` only disables discovery).
4. Threshold override mechanism (upstream's `--compact-soft-at` / `--compact-at` /
   `--compact-buffer` argv flags vs an env-var override) is resolved in the
   implementation plan after reading upstream's argument parser. Design constraint:
   values originate in the roster config, flow through the manifest, land on the
   worker argv. No defaults duplicated in driver code.
5. Resident agent is untouched this phase.

## Phase behavior

| Phase | Trigger | Behavior |
|---|---|---|
| notice | context ≥ 30% of model window | Transient hint with live numbers; never persisted |
| warning | context ≥ 50% | "Time to compact soon"; refreshed each call |
| forced | warning + 10% buffer → 60% | All tool calls blocked except `self_compact` |
| handoff | agent calls `self_compact({ note_to_self })` | QDS-flavored summarize runs once idle; note returned verbatim as next message |

The terminal footer gauge ships enabled; workers running in `--mode json` simply do
not render it.

## Error handling and recovery

- Compaction failure → note and lock survive; compaction retries at next idle.
- Recovery commands: `/self-compact-now` and pi's built-in `/compact` (shares the
  same summary override).
- Floor guard: thresholds must stay above pi's `keepRecentTokens` (default 20k) so
  there is always something to cut. At 60% of any supported window this clears
  trivially; the guard is asserted in the smoke test rather than assumed.

## Pi version gate

Upstream targets pi 0.85.1. Repo pins: exedev image pi 0.84.4
(`scripts/build-exedev-image.ts`), local versions vary. A smoke test following the
`coms-smoke-test.ts` pattern (`pi -e <extension> --list-models`) verifies the
extension loads on **both** pinned versions before any roster wiring lands. If
0.84.4 rejects the extension's API surface, the image pin is bumped first — the
roster wiring does not land against a broken host.

## Testing

1. **Upstream suite** — vendored tests run unmodified (`just verify` / Node
   strip-types), proving the vendored copy is faithful.
2. **QDS harness test** — scripted model session asserting: notice at 30%, warning at
   50%, tool block at 60% (non-`self_compact` calls rejected), and the handoff note
   round-trips byte-for-byte.
3. **Load smoke test** — extension loads on pinned pi versions (see version gate).
4. **Live e2e** — one `qds-live-e2e` round on a real exe.dev box with real spend
   before merge, per repo convention.
5. **Repo hygiene** — the only repo `src/` changes are the manifest/driver seam;
   `detect_changes()` runs before commit, and impact analysis precedes edits to any
   symbol touched (CLAUDE.md rules).

## Out of scope (this phase)

- Resident-agent compaction (`--no-tools` blocks the tool; needs its own mechanism).
- Per-agent-class threshold overrides beyond roster defaults (roster roles already
  give per-role config if needed later).
- Count-based warning escalation (rejected in favor of phase thresholds).
