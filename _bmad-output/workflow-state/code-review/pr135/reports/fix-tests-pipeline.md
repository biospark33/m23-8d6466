# fix-tests-pipeline — pipeline-run.test.ts fixer report

## Round 7

Fixer: fix-tests-pipeline (wave 2). Scope: `tests/phase-engine/pipeline-run.test.ts`
only. No commits, no staging. Baseline before any edit: **43 pass / 0 fail** —
wave-1 source fixes landed without breaking any existing expectation, so there
were no failures to reconcile against intentional behavior changes.

Reconciliation sweep against the wave-1 flags (fix-engine S1-1, fix-pipeline
S3-1/S3-2/S3-3/S3-4/S3-7): the only roster/steering leg in this file is the
in-set `select_roster` accept test (`pipeline-run.test.ts:1502`), which already
targets a `dispatch_task` phase (`ship`), uses `proceed` at run_end, and pins
`directivesRejected:0` + empty tripwires — consistent with the narrowed
dispatch-only `phaseIds` set and the run_end proceed-only allowlist. No leg
exercises a code-phase pick, a dup-named dispatch manifest, an off-point
directive, or a mid-solicit signal, so no expectation needed re-pinning and no
wave-1 regression surfaced. One lax pin strengthened (see W2-recon-1 below).

| # | sev | verdict | verified-at → change |
|---|-----|---------|----------------------|
| W2-2 | LOW | **PATCHED** | Verified at old `pipeline-run.test.ts:1373` (witness brief `requestId: crypto.randomUUID()`) vs `:1379` (returned `requestId: crypto.randomUUID()` — a second, unrelated UUID) and the same pattern in the roster-accept leg (old `:1544` brief write vs `:1550` `--request-id` UUID). Fix: `armedWorkspace()` now mints the UUID once, writes it into `run-context.json`, and returns that same UUID (`:1366-1384`); the roster-accept leg hoists `const requestId` above the brief write and uses it in both places (`:1547-1559`). The sibling `resident-e2e.test.ts` deliberately matches the two — this file now agrees with it. |
| W2-recon-1 | INFO | **strengthened pin** | The roster-accept leg's run_end leg asserted only `directiveAction === "proceed"`. Added `expect(solicits[1]?.accepted).toBe(true)` (`:1603`) with a comment pinning the round-7 S1-1 allowlist semantics: proceed is the ONLY accepted run_end action; anything else would surface as a counted rejection + `gate_bypass_attempt` tripwire (already pinned empty at `:1606-1607`). |

### Gate results (round 7)

- `bun test tests/phase-engine/pipeline-run.test.ts` — **43 pass / 0 fail / 295 expect() calls**.
- `bunx biome check tests/phase-engine/pipeline-run.test.ts` — clean, no fixes.
- `bunx tsc --noEmit` — clean (whole repo).

No source files touched; no commits.
