# DF3.5 — Track E: Dependency Check (DF3.1 / DF3.2 / DF3.4 interfaces)

Date: 2026-08-31 · Branch: `feature/df3.5` · Author: Track E subagent

## Verdict

**All three dependencies resolve on this branch.** The verb registry
(`src/fleet/verbs.ts`) contains 11 verbs covering DF3.1 (dispatch, status,
harvest, teardown), DF3.2 (fanout, rank), and DF3.4 (approve, reject, attach,
enrol, unlock). `bun scripts/fleet.ts --help` renders all of them and exits 0.
Every verb has test coverage under `tests/fleet/`. All merge commits are
ancestors of HEAD. DF3.5 may proceed against this contract.

## 1. `bun scripts/fleet.ts --help`

- **First attempt: EXIT=1** — `error: Cannot find package 'yaml' from
  'src/phase-engine/roster/schema.ts'` (Bun v1.4.0). The repo's dependencies
  were not installed on this checkout. Fixed with `bun install
  --frozen-lockfile` (234 packages, lockfile untouched — `git status` shows no
  tracked-file change from it).
- **Second attempt: EXIT=0.** Help renders the header `Usage: fleet <verb>
  [options]` and all 11 verbs with per-flag `(valueType, required|optional)`
  lines, `note` suffixes where present, and an `Exit codes:` line per verb. A
  structured JSON log line (`"operation":"fleet.help","exitCode":0`) follows
  on stdout.
- There is **no per-verb help** — `--help`/`-h`/`help` all print this one
  global string (renderHelp comment, verbs.ts:450-455).

## 2. Definitive verb registry inventory (`src/fleet/verbs.ts`, `listVerbs()`)

Shape: `{verb, summary, flags: [{name, required, valueType, note?}],
exitCodes}`. `VerbFlag.note?: string` **exists** (verbs.ts:51) — additive,
optional, used only where `(name, required, valueType)` would mislead.

| verb | flags (name — required?, valueType, note?) | exit codes |
|---|---|---|
| dispatch | `--driver` req string · `--brief` opt path · `--dir` opt path · `--port` opt string · `--help` opt bool | 0,1,2,3,5,6 |
| status | `--driver` req string · `--dir` opt path · `--help` opt bool | 0,1,2,4 |
| harvest | `--driver` req string · `--dir` opt path · `--help` opt bool | 0,1,2,4,5,6 |
| teardown | `--driver` req string · `--dir` opt path · `--no-harvest` opt bool · `--help` opt bool | 0,1,2,4,5,6 |
| fanout | `--driver` req string · `--pattern` req string · `--n` req string · `--pin` opt string · `--roster` opt string · `--cap-micro-usd` opt string · `--brief` opt path · `--fanouts-dir` opt path · `--dir` opt path (F049 deprecated alias of `--fanouts-dir`) · `--help` opt bool | 0,1,2,5,6 |
| rank | `--fanouts-dir` opt path · `--dir` opt path (F049 deprecated alias) · `--steps-json` opt path · `--help` opt bool — **NO `--driver`** | 0,1,2,4,6 |
| approve | `--dir` opt path — note: *"allowlist host root AND runs directory — this verb reads its run record and bundle from this path too"* · `--approver` req string · `--reason` opt string · `--help` opt bool — **NO `--driver`, NO `--token`, NO `--message`** | 0,1,2,4,5,6 |
| reject | identical argv block to approve (same `--dir` note) | 0,1,2,4,5,6 |
| attach | `--driver` req string · `--dir` opt path · `--message` opt string — note: *"the value `-` reads the message from stdin, as does omitting the flag; to send the literal one-character message `-`, pipe it instead"* · `--help` opt bool | 0,1,2,4,5,6 |
| enrol | `--approver` req string · `--dir` opt path — note: *"the allowlist's HOST ROOT — the allowlist half of `approve`'s dual-purpose --dir, whose runs-directory half this verb never touches"* · `--out` opt path — note: *"writes the token JSON here (mode 0600) instead of stdout — use wherever stdout is captured"* · `--rotate` opt bool — note: *"re-mints an already-enrolled approver's token; their current one stops working immediately"* · `--help` opt bool — **NO `--driver`** | 0,1,2,5,6 |
| unlock | `--dir` opt path · `--force` opt bool — note: *"removes the lock even when its holder is still running — only after you have confirmed no reverify is live for this run"* · `--help` opt bool — **NO `--driver`, NO `--approver`** | 0,1,2,5,6 |

Exact spellings confirmed against the rendered `--help` output: `--driver`,
`--brief`, `--dir`, `--port`, `--no-harvest`, `--pattern`, `--n`, `--pin`,
`--roster`, `--cap-micro-usd`, `--fanouts-dir`, `--steps-json`, `--approver`,
`--reason`, `--message`, `--out`, `--rotate`, `--force`, `--help`. All verbs
take a positional `<run-id>` (or fanout id for `rank`) per CLI grammar — **not**
registry flags (verbs.ts:8-9).

### Flags/skills must NOT use

- `--driver` on **rank**, **approve**, **reject**, **enrol**, **unlock** — not
  in the registry; `parseArgv` refuses it as exit 2 (proven:
  `tests/fleet/gate-verbs.test.ts:188` runs approve with `--driver fake` and
  asserts refusal). Omitting `--driver` where required is equally fatal:
  `assertDriverChosen` exits 2 (dispatch/status/harvest/teardown/fanout/attach).
- `--token` on approve/reject — **does not exist by design**; the token rides
  stdin only (DF2.3 INV-CRED-3 / DF3.4 INV-APPROVE-6).
- `--message` on approve/reject — that flag belongs to **attach** only.
- `--dir` as a fanout-records dir on fanout/rank — it is the F049 deprecated
  alias for `--fanouts-dir`, kept one release, warns on stderr; skills should
  emit `--fanouts-dir`. Conversely on enrol `--dir` is the allowlist HOST
  ROOT, not a runs dir; on approve/reject it is dual-purpose (see note).
- Exit codes: each verb's skill must only branch on the declared set above;
  6 ("landed but output/cleanup failed") and 5 ("refused before mutation")
  carry verb-specific remediation (e.g. dispatch 6 ⇒ `fleet teardown <id>`
  immediately).

## 3. Verb → covering test file(s) (`tests/fleet/`)

| verb | test files |
|---|---|
| dispatch | `dispatch.test.ts` (419 matches), `verbs.test.ts`, `cli.test.ts`, `brief-schema.test.ts`; live: `e2e/tier2-dispatch-engine.live.test.ts`, `e2e/tier3-expose-port.live.test.ts` |
| status | `verbs.test.ts`, `cli.test.ts`; live: `e2e/tier1-provision-status.live.test.ts` |
| harvest | `verbs.test.ts`, `cli.test.ts`; live: `e2e/tier1-harvest.live.test.ts` |
| teardown | `verbs.test.ts`, `cli.test.ts`, `gate-verbs.test.ts` (teardown-claim section ~:2207), `fleet-lock.test.ts`; live: `e2e/tier1-teardown.live.test.ts`, `e2e/tier1-lock.live.test.ts` |
| fanout | `fanout.test.ts`, `patterns.test.ts`, `verbs.test.ts`, `cli.test.ts`; live: `e2e/tier2-fanout-bestofn.live.test.ts`, `e2e/tier3-race.live.test.ts`, `e2e/tier3-manystories.live.test.ts`, `e2e/tier1-fanout-refusal.live.test.ts` |
| rank | `rank.test.ts`, `verbs.test.ts`; live: `e2e/tier2-fanout-bestofn.live.test.ts` |
| approve | `gate-verbs.test.ts` (~35 `run(["approve",…])` call sites), `approval-gate.test.ts`, `verbs.test.ts`; live: `e2e/tier1-approval-gate.live.test.ts` |
| reject | `gate-verbs.test.ts` (shares approve's `test.each` blocks), `approval-gate.test.ts`, `verbs.test.ts`; live: `e2e/tier1-approval-gate.live.test.ts` |
| attach | `attach.test.ts` (111 matches), `gate-verbs.test.ts` (:900-1047), `verbs.test.ts`; live: `e2e/tier1-attach-transport.live.test.ts`, `e2e/tier5-gate-steering.live.test.ts` |
| enrol | `gate-verbs.test.ts` (:2458-2567 CLI-level), `approvers.test.ts` (enrolApprover module), `cli.test.ts` (:418,433), `verbs.test.ts` |
| unlock | `gate-verbs.test.ts` (:1616, :2276-2379 CLI-level incl. `--force`), `approval-gate.test.ts` (lock-reclaim errors reference `fleet unlock`), `cli.test.ts` (:419,434), `verbs.test.ts` |

`verbs.test.ts` is the registry-contract suite (listVerbs/renderHelp shapes,
per-verb exit-code refusals at :1096+); `cli.test.ts` pins dispatch of all 11
verbs. DoD's "a verb the CLI actually exports and a test actually covers" is
satisfiable for every registry entry.

## 4. Git evidence

`git log --oneline --all --grep="df3-1" --grep="df3-2" --grep="df3-4" -i`
returns extensive history for all three stories. Merge commits, all verified
ancestors of HEAD via `git merge-base --is-ancestor`:

- **DF3.1**: PR #123 `f1aa4db` ("Merge pull request #123 …/feature/df3-1-fleet-dispatcher-core-verbs"), PR #131 `6caffdb` (review round 10), PR #134 `db271dc` (review round 11) — sprint line: `DF3.1 … status: done`.
- **DF3.2**: PR #128 `307cc16` ("Merge pull request #128 …/feature/df3-2-fanout-best-of-n") — **fanout merged, in HEAD**; sprint line records it done 2026-08-26 with TIER-1/2/3 live evidence.
- **DF3.4**: PR #150 `185291e` ("Merge pull request #150 …/feature/df3-4-approval-gate-attach-steering"), sprint-close commit `614a0ae` "fix(sprint): DF3.4 done — PR #150 merged 2026-08-31" — sprint line: done, mandatory live e2e passed.

## 5. `fleet approve` — stdin token delivery (INV-APPROVE-6)

- Registry summary: *"Approve a run paused at the pre-PR gate, releasing it to
  open its PR"*. Flags: `--dir` (opt path, dual-purpose note quoted above),
  `--approver` (req string), `--reason` (opt string), `--help` (opt bool).
- **There is no `--token` and no `--message` flag on approve/reject.**
  Registry comment (verbs.ts:218-219): *"The approver's id; its token arrives
  on STDIN, never argv (DF2.3 INV-CRED-3) — which is why no --token flag
  exists to declare."*
- CLI enforcement (`scripts/fleet.ts:2774-2777`): missing/empty `--approver`
  exits 2 with remediation *"pass the approver id registered in
  .factory/approvers.json; its token arrives on stdin, never as a flag"*.
  Authentication reads stdin between the pre-auth record probe and the
  decision CAS (scripts/fleet.ts:2796-2820 — the deferred-existence ordering
  that closes the run-id enumeration oracle).
- `VerbFlag.note?` **exists** (verbs.ts:51) and is rendered by `renderHelp`
  appended to the flag's own line. On approve it appears only on `--dir`; the
  stdin-sentinel note lives on **attach**'s `--message` (`-` or omission reads
  stdin), not on approve.
- Contrast: `enrol` MINTS the token (printed once, or `--out` mode-0600) and
  never reads it from stdin (scripts/fleet.ts:3145).

## 6. GitNexus

**Not available for this branch.** No GitNexus MCP tools are exposed in this
environment; the CLI binary exists (`gitnexus` 1.6.9 at ~/.local) but the repo
has **no `.gitnexus/` index directory**, and DF3.4's own sprint record states:
*"GitNexus index is stale/corrupted for this branch (new files absent, garbage
symbol names) — impact analysis fell back to grep; reindex owed."* Running
`impact({target: "listVerbs"})` / `query({query: "verb registry fleet help"})`
was therefore not possible; the registry was verified by direct source read +
`--help` + test-file grep instead (grep is what the registry's own contract
suite does anyway). If a reindex is wanted: `bash
scripts/install-gitnexus-plus.sh` (canonical, per AGENTS.md — never a bare
`gitnexus analyze`).

## Environment side effects of this run

- `bun install --frozen-lockfile` populated `node_modules` (untracked; no
  lockfile or tracked-file change). Required because `--help` would not even
  start without it — DF3.5 skill authors should note the CLI needs deps
  installed.
- Pre-existing working-tree state, NOT from this track: `M
  cli-anything/src/index.ts` (mode-only diff, 0 insertions/deletions) and the
  untracked `_bmad-output/workflow-state/qds-dev/df3-5/` tree from sibling
  tracks. This track wrote only `research/trackE-deps.md`.
