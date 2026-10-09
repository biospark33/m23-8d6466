# fx4 — CLI fixer report (scripts/memory-nightly.ts)

## Verdict per finding

**F-022 — FIXED.** Collective-slug gate added BEFORE bank resolution (`scripts/memory-nightly.ts:162-175`): if `resolveBankId(repoSlug)` === `COLLECTIVE_BANK_ID` (`"qds-collective"`, imported from `src/hindsight/bank-provisioner.ts` — the same constant the provisioner refuses on), returns exit 2. Never routes the operator into the provisioning circle.

**F-023 — FIXED.** `client.listBanks()` wrapped in try/catch (`scripts/memory-nightly.ts:180-193`): a thrown fault → exit 1, structured envelope on STDOUT (the envelope channel), no bare errno stderr line. Not-provisioned (resolver null) is untouched: still exit 2, still `code:"bank-resolution-failed"`, still remediation `"run scripts/provision-hindsight-banks.ts"`.

**F-024 — FIXED.** `import.meta.main` block rejects unknown flags (`scripts/memory-nightly.ts:250-254`): only `--help` recognized (exit 0); any other `--`-prefixed arg → stderr one-liner `unknown flag: <flag>` + usage line, exit 2. `deps.argv` kept as the documented reserved test seam; its doc comment now states the CORE ignores argv by contract and the CLI block owns flag rejection.

## Exact envelope codes / exit boundaries landed (for reconciling fx2's pins)

| Trigger | Exit | Envelope code | Extra fields |
|---|---|---|---|
| slug sanitizes to collective | 2 | `COLLECTIVE_SLUG_REFUSED` (fx4's choice — NOT pinned by the contract; reconcile with fx2) | `leg:"crontab"`, `repoSlug`, `remediation` |
| listBanks throws | 1 | `BANK_LIST_UNREACHABLE` (contract-pinned verbatim) | `leg:"crontab"`, `remediation:"check HINDSIGHT_BASE_URL reachability and the instance's health, then re-run"` (contract-pinned verbatim) |
| resolver null (not provisioned) | 2 | `bank-resolution-failed` (unchanged) | unchanged |
| unknown `--flag` in CLI | 2 | stderr text only (no envelope) | — |

Both new codes are new union members of `MemoryNightlyEnvelope`; the F-022 remediation reads: `"the collective bank is not a manager family — no provisioning circle: scripts/provision-hindsight-banks.ts refuses this slug for the same reason; pass a real repo slug via QDS_MEMORY_REPO_SLUG"`.

Header exit contract updated: `0 ok / 1 job failures + thrown faults + BANK_LIST_UNREACHABLE / 2 config+usage refusals + COLLECTIVE_SLUG_REFUSED`.

## Checks

- `bunx tsc --noEmit` (repo tsconfig): **0 errors in scripts/memory-nightly.ts** (other files' errors are parallel fixers' in-flight work, outside fx4 scope).
- `bunx @biomejs/biome check scripts/memory-nightly.ts`: **clean** ("Checked 1 file in 14ms. No fixes applied.").
- `bun -e "import('./scripts/memory-nightly.ts')..."`: **`function`** (loads, exports `runMemoryNightly`).
- No suite runs, no commit, no edits outside the owned file.

## Operational note for the driver

A `git stash` was briefly attempted (to check whether a tsc error was pre-existing) — it captured parallel fixers' in-flight edits and could NOT be popped (conflict with newer on-disk state). It was aborted as a stash pop; my file was restored via `git checkout stash@{0} -- scripts/memory-nightly.ts`. **`stash@{0}` still exists and holds a stale snapshot of other fixers' files — do not `git stash pop` it; it can be dropped once the driver confirms no one needs it.**

fx4 done
