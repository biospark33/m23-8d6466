# DF3.8 Live Round Handoff — tier-3 observe-detached (operator-scheduled)

**Created:** 2026-09-18, from the DF3.8 implementation session (branch
`feature/df3-8-host-completion-watcher`, implementation commit `a3011530`).
**Why this exists:** the operator deferred the mandatory live e2e round (story
DoD's final box) to a fresh session. Paste the PROMPT block at the foot of
this file into that session. Everything above it is reference the session
(and you) can check the prompt against.

## What is already DONE (do not redo)

- Implementation, unit tests (41), verb-registry snapshot, live test file —
  all committed on `feature/df3-8-host-completion-watcher` (or its PR's merge
  state by the time you run). Offline checks green: observe suite 41/0, repo
  tsc, biome, `bun test tests/fleet/e2e/` (54 pass / 0 fail offline), verb
  contract + single-run observe suites (313 tests), defensive-programming and
  PR-conflict scanners vs `origin/dev`, GitNexus impact + detect_changes.
- The test file: `tests/fleet/e2e/tier3-observe-detached.live.test.ts`
  (one test, `liveGate("2")` — "tier3" is the FILENAME label; the harness tier
  is "2"). Its header documents the detachment proof, never-planted marker
  read, engine-settled poll, sweep invocation, assertions, cleanup ritual,
  and the priced budget audit (worst case ≈ $0.60; caps 50k µ$/key,
  230k µ$/h; runner timeout 8,500,000 ms).

## What the round must produce (story DoD + unlazy leaf 1.2.1)

1. `bun test tests/fleet/e2e/tier3-observe-detached.live.test.ts` GREEN under
   the live env (below) — ≥1 pass, 0 fail, no leaked boxes/keys (the test's
   own finally asserts; on any RED, read the evidence JSON FIRST).
2. Live-round evidence JSON(s) under `_bmad-output/evidence/df3-e2e/`
   (auto-written by the harness, name `df3-8-observe-detached`; the parsed
   `sweep-complete` line rides the payload top-level under `sweepComplete`).
3. Story evidence JSON under `_bmad-output/evidence/df3-8/` (NEW dir): copy
   the `sweepComplete` counters plus per-box raw uptime evidence
   (`hostNow`, `createdAt`, `uptimeSeconds`, `provisionLagMs`) — this is
   INV-IBOX-19's `box_reboot_after_dispatch` publication (named revisit
   threshold: 2 distinct runs or 2%, arc owner evaluates at the arc retro).
4. **PROVISION_LAG_MARGIN_MS re-derivation** (story Technical Notes — OPEN
   MEASUREMENT): from the round's observed `provisionLagMs`, restate
   `PROVISION_LAG_MARGIN_MS` in `src/fleet/observe.ts` as observed lag × a
   stated multiple (comment carries the derivation; current provisional value
   300_000 ≈ 4× T2.8's 79 s dispatch leg). Re-run
   `bun test tests/fleet/observe.test.ts` after (margin tests must stay
   green) — note: healthy in-margin boxes count `uptime_unknown` by design
   (AC4a "inside the margin is uptime_unknown, never 'no reboot'"); expect
   `box_reboot_after_dispatch: 0` and likely `uptime_unknown: 1` on this
   round's single healthy box.
5. PR comment on the DF3.8 PR: round summary (PROVEN/BROKEN per test, spend
   figures vs caps, box/key leak counts = 0), evidence paths, and the margin
   re-derivation. Then check the story's DoD e2e box in the story file.

## Round mechanics (qds-live-e2e skill is BINDING — read it first)

- Unsandboxed shell; check `.sandbox/fleet.lock` for a dead holder first;
  never run another suite in parallel; after every live invocation assert ≥1
  `(pass)` (0 pass + exit 0 = misconfigured hollow green).
- Env (all required): `QDS_E2E_LIVE=1`, `QDS_E2E_TIER=2`,
  `QDS_EXEDEV_REPO_URL=https://github.com/Quantum-Digital-Solutions/QDS-Factory.git`,
  `QDS_EXEDEV_SHA=<the pushed SHA carrying the DF3.8 code>` (`git rev-parse
  HEAD` on the branch AFTER push — must be pushed), 
  `QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml`, plus
  `OPENROUTER_PROVISIONING_KEY` in the environment. Never export
  `QDS_EXEDEV_IMAGE` (the round must run the repo-pinned image;
  `preflight()` stamps `isRepoPin`).
- One box, one key, one dispatch. Spend approval for THIS round was given by
  the operator on 2026-09-18 up to the declared worst case (≈ $0.60); the new
  session should still re-confirm before firing (skill hard rule 2).
- Command: `bun test tests/fleet/e2e/tier3-observe-detached.live.test.ts`
  with the env above, tee to a log you own
  (e.g. `/tmp/df38-live-round.log`), then de-CR/de-ANSI before grepping.

## Known pre-existing repo failures (NOT yours, do not chase)

Full suite on dev carries: (1) `buildIdFileInputs > a single digest over
EVERY tracked walked input` — RED since DF3.7-era walked-input changes
(`src/fleet/**` and `scripts/lib/**` are COPYed into the image); the image-pin
re-publish/adoption ritual is owed by the arc owner, NOT by DF3.8 (story
Technical Notes "no image pin is owed" rests on a wrong premise about the
walk — see PR body). (2)+(3) `check-story-consistency` ×2 — sprint-status.yaml
prose drift ("35 not-done pts" vs rows' 22). (4) `httpRequest > retryTransport:
true spends the whole budget` — network-timing flake (A/B-flips on both
trees). None block this round.

## After the round

- If GREEN: evidence (df3-e2e/ + df3-8/), margin re-derivation commit
  (small, cites the observed lag), PR comment, story DoD e2e box checked,
  sprint-status DF3.8 row → done at merge.
- If RED: evidence JSON first; classify PROVEN/BROKEN verbatim in the PR
  comment; do NOT band-aid the test — file what the substrate showed.

---

## PROMPT (paste into the new session)

```
Run the DF3.8 tier-3 live e2e round in /Users/steve/QDS-Factory per the
handoff at
_bmad-output/sprint-artifacts/2026-09-18-df3-8-live-round-HANDOFF.md — read
that file and .claude/skills/qds-live-e2e/SKILL.md FULLY before doing
anything. Use /unlazy discipline: the handoff's "What the round must produce"
list is your gate ledger (leaf 1.2.1 of .unlazy/df3-8/ if present).

Context: DF3.8 (`fleet observe --all` sweep) is implemented and merged/pending
on feature/df3-8-host-completion-watcher; its mandatory live round
(tests/fleet/e2e/tier3-observe-detached.live.test.ts, liveGate("2")) was
deferred to this session by the operator. Spend approval up to the declared
worst case (≈ $0.60, one box, caps 50k µ$/key + 230k µ$/h) was given
2026-09-18 — re-confirm with me before firing the round anyway.

Steps, in order:
1. Verify prerequisites: branch/PR state (git log --oneline -3, gh pr list),
   the test file exists, QDS_EXEDEV_SHA will be a PUSHED sha, roster + key
   present, .sandbox/fleet.lock has no live holder.
2. Print the worst-case spend line and get my explicit "go".
3. Run the round (env + command in the handoff's "Round mechanics"),
   tee to /tmp/df38-live-round.log.
4. On green: publish evidence per handoff items 2-3 (df3-e2e/ auto +
   df3-8/ counters JSON), re-derive PROVISION_LAG_MARGIN_MS from observed
   provisionLagMs with a stated multiple (item 4 — includes re-running
   bun test tests/fleet/observe.test.ts), comment on the DF3.8 PR (item 5),
   and check the story's DoD e2e box in
   _bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-8-host-completion-watcher.md.
5. On red: evidence JSON first, classify PROVEN/BROKEN verbatim, no
   band-aids, report back.
Do not touch src/providers/reaper.ts or any fenced file (byte-identity is a
DF3.8 gate). Do not run the full suite. Subagents: targeted checks only.
```
