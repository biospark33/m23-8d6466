<!-- gitnexus:start -->
<!-- gitnexus:keep -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **QDS-Factory**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `bash scripts/install-gitnexus-plus.sh` from the project root
> (analyze-only: `GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh`).
> Do **not** run a bare `gitnexus analyze` / `node .gitnexus/run.cjs analyze` — it
> skips the transient `.gitnexusignore` negation (`!tests/ !__tests__/ !fixtures/`),
> so GitNexus's `DEFAULT_IGNORE_LIST` filters out `tests/gitnexus/fixtures/` and
> `tests/gitnexus/graph-queries.test.ts` degrades to `(skip)`.

## Before editing and committing

- Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level). If it returns HIGH or CRITICAL, warn the user before editing.
- Before committing, run `detect_changes({scope: "compare", base_ref: "dev"})` to confirm the change touches only the expected symbols and flows (`dev` is the integration base; see the branch convention below).
- Rename symbols with `rename`, which follows the call graph; find-and-replace misses or over-matches references.
- When exploring unfamiliar code, `query({query: "concept"})` returns process-grouped execution flows ranked by relevance; `context({name: "symbolName"})` gives one symbol's callers, callees, and flows.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/QDS-Factory/context` | Codebase overview, check index freshness |
| `gitnexus://repo/QDS-Factory/clusters` | All functional areas |
| `gitnexus://repo/QDS-Factory/processes` | All execution flows |
| `gitnexus://repo/QDS-Factory/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Running the test suite (ALWAYS capture to a file)

Never run a bare `bun test` — a ~10 min suite whose failure names scroll off is a
second ~10 min run. Always tee to a log you own, then read the failures out of it:

```bash
bun test > /tmp/qds-test.log 2>&1; echo "exit=$?"          # add a path filter as needed
tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" 
```

The `tr`/`perl` step is not optional: bun writes progress with carriage returns and
ANSI colour, so a plain `grep '(fail)'` over the raw log silently matches nothing and
reads as "no failures".

## Static gates (ALWAYS before declaring a round/branch green)

`bun test` does NOT typecheck or lint. CI's `check` job runs `bun run typecheck`
(`tsc --noEmit`) and `bun run lint` (biome, repo-wide) on every PR — a bun-green
branch gate is not merge-green (PR #404 shipped 7 tsc errors + 4 lint errors past
three review rounds that only ran `bun test`). Before any commit you call final:

```bash
bunx tsc --noEmit                                    # 0 errors
bun run lint                                         # exit 0 (repo-wide, matches CI)
```

Scope short-cut only when iterating: `bunx @biomejs/biome check <touched files>` —
but run the full `bun run lint` once before pushing.

## Reindexing (canonical)

`bash scripts/install-gitnexus-plus.sh` — never a bare `gitnexus analyze`. (#46, #47)

## Upgrading the gitnexus CLI (contract ritual)

The repo pins the CLI contract, not the CLI: `tests/gitnexus/gitnexus-cli-contract.json`
records `expectedCliVersion`, `tests/gitnexus/cli-contract.ts` holds strict full-payload
schemas for every tool we consume (query / context / impact resolved+ambiguous / cypher /
list / detect-changes), and `tests/gitnexus/contract.test.ts` is the drift alarm — the ONE
suite meant to fail, loudly naming the drifted fields and both versions. The functional
suite (`graph-queries.test.ts`) asserts only the minimal fields it depends on and tolerates
additive upstream changes; it is not the alarm. Both run under plain `bun test` — never
exclude `tests/gitnexus/` from a gate, or the alarm is disarmed.

Upgrade ritual (in order):

1. Upgrade the CLI, then reindex via the canonical script (above). The script stamps
   `.gitnexus/cli-version.json` (installed version, pinned version, index time, HEAD) and
   warns when installed ≠ pinned.
   It also refreshes `.claude/skills/gitnexus-*/SKILL.md` from the new CLI's bundled
   templates and re-applies this repo's reindex rule to them; commit those files.
2. Run `bun test tests/gitnexus/` — expect the contract suite to fail on real drift.
3. Review the failure: it names every drifted field. Confirm intent against upstream's
   changelog/source; if a drop looks unintentional, file it upstream before adopting.
4. Adopt: update the strict schemas in `cli-contract.ts`, bump `expectedCliVersion` in
   `gitnexus-cli-contract.json`, and adjust the lenient functional assertions only where
   their actual dependencies moved (semantically, not mechanically).
5. Land schema + pin + reindex stamp in the same commit.

Everything above the `gitnexus:end` marker is generated by `gitnexus analyze`. The
`gitnexus:keep` marker on line 2 makes it preserve that block verbatim
(`upsertGitNexusSection` in `gitnexus/dist/cli/ai-context.js`) — without it the
block regenerates with the wrong reindex command. This section sits outside the
markers, which every gitnexus version preserves unconditionally; it is the
backstop if `gitnexus:keep` ever stops being honoured.

qds-dev branch convention: prefix=feature/ base=dev target=dev. Every PR targets `dev`;
the only PR that targets `main` is the periodic `dev` → `main` promote/sync PR.

Live E2E rounds: use the `qds-live-e2e` skill (`.claude/skills/qds-live-e2e/`) whenever
running or building live/no-fakes end-to-end tests (QDS_E2E_LIVE tiers, real boxes,
real spend).
