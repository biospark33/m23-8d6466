# DF3.5 Phase-2 Research — Track F: Cross-Track Intelligence + Learnings

Date: 2026-08-31 · Branch: `feature/df3.5` · Researcher: Track F subagent

## 1. Open PRs — conflict scan

`gh pr list --state open --limit 30 --json number,title,headRefName,baseRefName,files`
returned **7 open PRs, all Dependabot, all targeting `dev`**:

| PR | Title | Files touched |
|----|-------|---------------|
| #172 | actions/upload-artifact 4→7 | `.github/workflows/ci.yml` |
| #173 | node 22→26-bookworm-slim (/oci) | `oci/Dockerfile` |
| #174 | @mariozechner/pi-coding-agent 0.55.0→0.73.1 | `pi-vs-claude-code-vendor/package.json` |
| #175 | vite 7.3.6→8.2.2 | `visualizer/package.json` |
| #176 | @types/node 24→26 | `package.json` |
| #177 | zod 3.25.76→4.4.3 | `package.json`, `cli-anything/package.json` |
| #178 | typescript 5.9.3→7.0.2 | `package.json` |

**Verdict: NO CONFLICT.** No open PR touches `.claude/skills/**`, `src/fleet/**`,
`scripts/fleet.ts`, or `tests/fleet/**`. Base-branch convention is being followed
(every open PR targets `dev`, matching the AGENTS.md sentinel). Two watch items,
neither blocking: #177 (zod 3→4 major) and #178 (TS 5→7 major) both mutate
`package.json`; if either merges before DF3.5, DF3.5's branch may see a trivial
lockfile/manifest merge ripple, and zod-4/TS-7 could shift type-check behaviour
under `bun test` / `tsc` — re-run gates after any such merge.

## 2. Learnings

**`.claude/learnings/qds-dev/` DOES NOT EXIST.** The only learnings store is
`.claude/learnings/qds-sprint-planning/` (patterns.yml v1.12, preferences.yml
v1.2, experimental.yml). The "D016-D020 check-defensive-programming patterns"
are NOT in any learnings YAML — they are codified in the header comments of
`scripts/dev/check-defensive-programming.sh` (qds-dev learnings D016-D020 are
cited there as the source). Patterns relevant to DF3.5:

### Defensive programming (auto-applied via the Phase-5 gate; from D016-D020)
- **D016** No `as any` / `as unknown as` casts on added lines (word-boundaried;
  matches the code-only view, not comments/strings).
- **D017** An ADDED async function that awaits must have try/catch **in its own
  body** (function-scoped; a sibling's try does not suppress).
- **D018** No silent empty-string fallbacks (`?? ""` / `|| ''`) on added lines —
  validate instead of blanking (this repo's own record: DF1.5's dead `??`
  fallbacks).
- **D019** No empty `catch {}` blocks.
- **D020** No unguarded `JSON.parse` on non-literal input (must sit inside an
  open try block at the call's source position).
- Escape hatch for all: `// dp:ok <reason>` trailing comment on the flagged line.

### PR creation / branch hygiene
- **AGENTS.md qds-dev sentinel (line ~54): `prefix=feature/ base=dev target=dev`** —
  ALL feature/fix PRs merge into `dev`; `dev`→`main` is a periodic promote only.
  Current branch `feature/df3.5` conforms; DF3.5's PR must target `dev`.
- **SPL-021** (medium): isolate the PR off `origin/dev`; the PR diff must contain
  only the story's files — verify with `git diff --name-only origin/dev..HEAD`.
- **check-pr-conflicts.sh** embodies learning D018 (the other D018 — stacked-PR
  overlap): detect file overlap with other open PRs before push. With only
  dependabot PRs open, expected to print OK.
- **AGENTS.md test discipline**: never bare `bun test`; tee to a log, then
  `tr '\r' '\n' | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"`.
- **AGENTS.md GitNexus rules**: run `impact` before editing any symbol
  (DF3.5 adds files rather than editing symbols — the main exposure is
  consuming `listVerbs()`), and `detect_changes()` before committing; reindex
  only via `bash scripts/install-gitnexus-plus.sh`.

### Review-round conduct
- **SPL-024**: adversarial review auto-iterates until findings stabilize —
  single-shot review is insufficient (RBAC-1 retro: one-shot caught real issues
  but the next 50+ bot rounds found more).
- **SPL-026**: subagent verdicts must be persisted to disk in the original
  prompt (the trap is any agent whose deliverable is a judgment) — applies to
  this research wave itself; this file is that artifact.
- **SPL-027** (medium, story-authoring): target ≤185 normative lines, not the
  200 cap — the adversarial loop needs ~15 lines of slack. Relevant if DF3.5's
  SKILL.md files inherit a line budget (story says each SKILL.md ≤200 lines).

## 3. Phase-5 pre-PR gate scripts

Both exist under `scripts/dev/`:

- **`check-defensive-programming.sh`** (`--base <ref>` default `origin/main`,
  `--warn`): scans **added lines** of changed `.ts` files (merge-base diff,
  `--diff-filter=ACMR`) for D016-D020 above. Uses an awk code-only blanker
  (comments/strings/templates blanked, `${}` interpolation kept visible) shared
  with `tests/phase-engine/usage.test.ts` via `--code-only`. Exit nonzero on
  findings unless `--warn`. Note for DF3.5: default `--base origin/main` — the
  Phase-5 invocation for a `dev`-targeted PR should pass `--base origin/dev`.
- **`check-pr-conflicts.sh`** (`--base`, `--branch`, `--warn`): diffs this
  branch from the merge-base, then for every OTHER open PR (`gh pr diff N
  --name-only`) reports exact-path overlaps as `CONFLICT RISK`. Excludes the
  branch's own PR (`--branch` must be passed explicitly in CI). Tool failures
  stop the script; exit nonzero on overlap unless `--warn`.

## 4. TECH_DEBT_AUDIT.md and plans/

- **`TECH_DEBT_AUDIT.md`: zero mentions** of DF3.5/DF3.6/DF3.7/DF3.8 or any
  factory skill. Nothing owed there.
- **`_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md`** — item **D2
  (`--message -` undeclared sentinel), marked "Blocks: DF3.5", CLOSED
  2026-08-28**: `VerbFlag` in `src/fleet/verbs.ts` now carries an **optional
  `note?: string`**; a flag without one is byte-identical, so a three-column
  contract comparison is unaffected, but DF3.5's skill-contract test must be
  **tolerant of the additive field** (do not exact-match the whole flag object).
  `fleet attach --message -` reads stdin; a generated skill that surfaces
  `note` gets the `-` sentinel right. DF3.5 was confirmed not-implemented at
  closure time, so no coordination debt — just inherit the shape.
- **`_bmad-output/plans/2026-08-12-df-v5-pre-dev-adversarial-review.md`** —
  DF3.5-relevant resolved findings the story already encodes (verify, don't
  rediscover):
  - **DF3-P1-16 / XC-P1-06**: pricing-language/containment lint has a FIXED
    case-insensitive pattern set (six regexes, (a)–(f)) + two verbatim
    allowlisted exceptions in `factory-guide` only: the Commercial Terms §A.1
    sentence (exempts patterns a–e) and the AC7 containment-scope caveat that
    includes the exact `no per-VM` negation (exempts pattern f) — do not invent
    patterns.
  - **XC-P3-06 (DD-11)**: `factory-guide` must state the v5.0 containment scope
    (BYOK direct-provider egress only, no per-VM allowlist; re-enters with the
    OCI driver) and cite DD-11; this is the sixth lint pattern and the second
    allowlist exception.
  - **XC-P1-02**: `listVerbs()`/`src/fleet/verbs.ts` is DF3.1's (shipped,
    PR #123); DF3.5 is a second CONSUMER, never a second source.
  - **XC-P2-18**: "if DF3.2 unmerged, factory-dispatch documents dispatch only"
    — **moot**: DF3.2 merged 2026-08-26 (PR #128); `fanout` is in the registry.

## 5. Sibling stories (sprint-status.yaml)

- **DF3.5** (`sprint-status.yaml:152`): `ready-for-dev`, 2 pts, deps
  [DF3.1, DF3.2, DF3.4] — **all three DONE** (PRs #123/#128/#150). Unblocked.
- **DF3.6** (`:153`): `ready-for-dev`, re-sequenced v5-S2→S3, now depends on
  DF1.10 (not started). Files are engine/manifest bounds — **no
  `.claude/skills/factory/**` or `verbs.ts` ownership**.
- **DF3.7** (`:154`): `ready-for-dev`, S3, deps [DF1.10, DF3.4, DF5.1]. Story
  file states explicit region ownership: `src/fleet/verbs.ts` and the
  `scripts/fleet.ts` dispatch block are DF3.1's; DF3.7 **adds only** the
  `--await-completion` flag + exit mapping. Does not touch skills.
- **DF3.8** (`:155`): `ready-for-dev`, S3, deps [DF1.10, DF2.6, DF3.1, DF3.7].
  **Adds only** an `observe` verb descriptor + flags + exit mapping to
  `verbs.ts` (reusing exit 5); owns net-new `src/fleet/observe.ts`.

**Collision verdict: NO COLLISION.** No sibling touches
`.claude/skills/factory/**` or `tests/fleet/skill-contract.test.ts`. DF3.5's
story explicitly consumes `src/fleet/verbs.ts`/`scripts/fleet.ts` **read-only**
("adds a second consumer of `listVerbs()`, never a second source"), so DF3.7/
DF3.8's additive `verbs.ts` edits cannot file-conflict with DF3.5. Two
ordering notes: (a) DF3.5's contract-test direction is skills→registry
(unknown token in a skill fails), so later registry additions from DF3.7/DF3.8
do not break DF3.5's test; the reverse-coverage question (must every registry
verb be documented by a skill?) is answered NO by the story — e.g. `reap` is
deliberately not a skill verb. (b) DF3.8's new verb is named **`observe`**
while DF3.5 ships a skill named **`factory-observe`** documenting
`status`/`attach` — a naming-adjacency worth a sentence in factory-guide so
operators don't conflate the skill with the verb, but not a blocker. DF3.7/
DF3.8 both sit behind DF1.10 (not started), so they will not land before DF3.5
in practice.

## 6. Branch convention sentinel

AGENTS.md (below the gitnexus block): **"qds-dev branch convention:
prefix=feature/ base=dev target=dev"** — all feature/fix PRs merge into `dev`;
`dev`→`main` is a periodic promote/sync PR only. Current branch
`feature/df3.5` matches the prefix; the DF3.5 PR must set base `dev`.
Caution: both gate scripts default `--base origin/main`; Phase-5 invocations
on this branch should pass `--base origin/dev`.

## Verdicts

- **Open-PR conflict: NONE** (7 dependabot PRs only, all base `dev`; watch
  zod-4/TS-7 majors for gate-behaviour drift).
- **Learnings to apply:** D016-D020 (codified in check-defensive-programming.sh;
  `dp:ok` hatch), branch convention feature/-dev-dev, SPL-021 clean-diff
  isolation, SPL-024 iterative review, SPL-026 verdicts-to-disk, SPL-027 line
  headroom, AGENTS.md test-log + gitnexus rituals. `.claude/learnings/qds-dev/`
  does not exist — D016-D020 live in the gate script, not YAML.
- **Sibling collision: NONE.** DF3.6/7/8 are additive-only on shared files and
  behind unstarted DF1.10; DF3.5 is a read-only consumer of the verb registry.
- **Inherited contract note (must honor):** `VerbFlag.note?: string` from the
  DF3.4 D2 remediation — skill-contract test must tolerate the additive field.
- **Overall: SUCCESS.**
