# Z3 live exit round — handoff (2026-10-27 ~12:20 UTC)

Status at stop: **the scope-derivation amendment is LANDED on factory dev
(`9290a01c`, PR #483) and PR'd on the fork (#918, branch `feature/z3-review-set`
@ `23eab0196`, awaiting your merge order).** Everything now reduces to four
operator actions and one disciplined fire. No code is owed anywhere until the
images are rebuilt; if a red appears during the round, it is a real substrate
finding, not missing code.

---

## Where things stand (verified 2026-10-27 12:18 UTC)

| Artifact | State |
|---|---|
| Factory dev | `9290a01c` — amendment merged (#483) on top of the #482 fix stack (`fda57e1f`) |
| Fork dev | `e695549ff` — #916 CLI flush merged; #918 NOT yet merged |
| Fork PR #918 | OPEN — required `reviewSet` on `Z3ExitRoundConfig`, instructions+wire carry, persist choke point, A2 adds-only |
| Factory PR #483 | MERGED (`9290a01c`) |
| Branches | factory `feature/z3-scope-derivation` pruned local+remote; fork `feature/z3-review-set` alive (PR open — do not prune) |
| Container | `swarmclaw-swarmclaw-1` up 10 h, healthy, image `solstice-swarmclaw:combined-202ebd6` |
| In-container fork code | PRE-#918: `grep -c reviewSet src/lib/server/why.../protocol-z3-exit-round.ts` → 0 occurrences (verified in-container) |
| CLI flush fix (#916) | live via docker cp; state read 79,531 bytes through a pipe (ceiling was 65,536) |
| fire.env | `_bmad-output/evidence/v6-z3/fire.env` (0600) — `SWARMCLAW_FORK_REV` still `202ebd686…`, must bump after rebuild |
| Suite classification | #483 introduces ZERO new failures. Digest drift + F-017 rig_swarm are pre-existing on dev; self-compact P1/P2/P3 are contention flakes (pass solo) — verdict commented on #483 |
| Full suite log | /tmp/qds-test.log (branch @ af3d635c) |

## The amendment (what merged, one paragraph)

The QA legs' bounded review set was the A2-era static scope constant
(`src/qa scripts/qa tests/qa`) hardcoded in the hunter-pack manifest task
(`config/rosters/qa-hunter-pack.pipeline.json`). Round 18 reached priming with
the whole fix stack proven and red'd there BY CONTRACT: at a pin whose own diff
touches `scripts/z3`+`tests/z3`, that set is empty — hunters honestly found
nothing. The amendment (operator-approved, do not revisit): the review set
derives from the pinned sha's own diff (`git diff --name-only <sha>~1..<sha>`)
at authoring time and pins as a round input. Factory: `deriveReviewSet`
(refuses EMPTY before the GO), `gateFire` requires the GO to NAME the set,
`armedCapsProblems` cross-checks the armed protocolConfig, `driveTrigger`
asserts every fired QA leg's wire-config `reviewSet` equals the pinned set,
pipeline.json task text is dual-mode (pinned set in the brief's `instructions`
IS the bounded review set; otherwise the A2 static command stands). Fork
(#918): `reviewSet` REQUIRED on `Z3ExitRoundConfig` (refused absent/empty/
malformed at arm), folded into the leg instructions (the only carrier the box
reads) and the wire config under the 600-char ceiling (refuse, never truncate),
carried through `normalizeExternalJobConfig` (absent stays absent — A2 rounds
byte-identical; malformed present refuses the whole config). Lenses stay the
three postures over the set. Contract text of record: the story file's dated
amendment section — `_bmad-output/sprint-artifacts/dark-factory-v6/stories/
z3-cross-repo-live-exit-round.md`, "Amendment — the review set is a derived,
pinned round input (2026-10-27)".

---

## The finish line — four gates, in order

### Gate 1 — Merge swarmclaw#918 (Steve order + `--admin`)

```
cd /Users/steve/swarmclawfork && gh pr merge 918 --merge --admin
```

Actually `/Users/steve/swarmclaw-qds`. Merge commit (not squash — preserve the
commit). After merge: fork dev moves past `e695549ff`; prune
`feature/z3-review-set` local+remote (GitHub may auto-delete the remote);
`git -C /Users/steve/swarmclaw-qds checkout dev && git pull`.

### Gate 2 — exe.dev image re-publish + pin adoption + digest, one commit

The digest test (`tests/scripts/build-exedev-image.test.ts:1468`) is red on
dev: #482's `src/phase-engine/findings-sidecar.ts` (the sidecar "none"-arm
zero-fix, COPY'd via `COPY src/phase-engine/`) moved the buildId digest
without the same-commit re-pin ritual. Expected `636b66fd…`, actual
`aa7014aa…`. The ritual (the test's own message): **re-publish the exe.dev
image from merged dev, adopt the new pin, update the digest in the SAME
commit.** This is REQUIRED for the round: the sidecar zero-fix is in-box
engine code; the pinned image predates it, and the "none"-arm model
nondeterminism that red'd round 17 reds a green leg again on the old engine.
This is the same pipeline #467 used: publish/attest/attested green, pin
adopted in the same-commit ritual (#474 TOFU ARGs + #476 driver digest/buildId
style), `verify-image-pin` green. The digest lands as ONE commit on dev (e.g.
`chore(image): re-pin — #482 moved the buildId inputs (sidecar zero-fix)`);
factory dev moves again; QDS_EXEDEV_SHA = that tip.

### Gate 3 — Fork image rebuild + recreate (replaces the docker cp)

The in-container fork code is pre-#918 and OLD `buildZ3ExitRoundSteps`
SILENTLY DROPS `reviewSet` from the arm config → fired legs carry none → host
`driveTrigger` refuses → a red round with real spend. Verified in-container
2026-10-27 12:18 UTC. Build from merged fork dev (incl #918 + #916),
tag `solstice-swarmclaw:combined-<new-short>`. Recreate ONLY if needed, with
ALL THREE files from /Users/steve/Solstice/external/swarmclaw:

```
SOLSTICE_SWARMCLAW_IMAGE=solstice-swarmclaw:combined-<new-short> \
  docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.qa-f3.yml -p swarmclaw up -d swarmclaw
```

`docker-compose.local.yml` is MANDATORY (devlocal stored-text keyring +
original DATA_DIR — without it instrumentation dies: StoredTextKeyringError →
no daemon → schedules never fire). `qa-f3.yml` re-pins DATA_DIR=/var/lib/solstice/swarmclaw-data
(base compose silently moved it to /app/data). After ANY recreate, BEFORE arming:

1. container healthy;
2. `grep "Starting daemon (source=instrumentation" /var/lib/solstice/swarmclaw-data/app.log` — a FRESH line;
3. runtime_locks daemon-primary renewed <120 s (query via docker exec node better-sqlite3 readonly);
4. `docker exec -w /app swarmclaw-swarmclaw-1 sh -c 'npx tsx scripts/solstice/z3-exit-round.ts state | wc -c'` — number ≥ 66,537 through a pipe (flush fix now IN the image, docker cp obsolete);
5. `grep -c reviewSet .../protocol-z3-exit-round.ts` in-container ≥ 3 (#918 landed).

Then bump `SWARMCLAW_FORK_REV` in fire.env to the new merge sha.

### Gate 4 — GH Actions billing

Every check on both repos is cosmetic red ("recent account payments have
failed or your spending limit needs to be increased") until billing is fixed.
Does not block a fire; blocks trustworthy CI on the next PRs (closeout PR).

---

## Fire procedure (after all four gates)

Preflight, in order, refusing on any miss:

1. Factory dev checked out at the digest-re-pin tip, PUSHED. `QDS_EXEDEV_SHA=$(git rev-parse HEAD)` evaluates at source — the code-run fill clones THIS.
2. `bun -e 'import {preflightFork} from "./scripts/z3/live-round-wiring.ts"; console.log(preflightFork())'` → `[]` (CLEAN).
3. Re-mint the memgate token: `bun .unlazy/z3/mint-token.ts` (old expired ~11:52Z 2026-10-27; 24 h validity; it writes fire.env's `Z3_MEMGATE_AGENT_TOKEN` itself; keys at `.factory/memgate.keys`, ledger `.sandbox/memgate-ledger.db`).
4. fire.env: SWARMCLAW_FORK_REV = new fork merge sha (Gate 3); QDS_EXEDEV_SHA evaluates at source. Verify `QDS_REPO_SLUG`, `Z3_QA_GROUP_CAP_USD`, `Z3_CODE_GROUP_CAP_USD`, `Z3_CODE_MANIFEST_PATH`, `Z3_CODE_INSTRUCTIONS`, `Z3_PARTICIPANTS` still set.
5. GO: `_bmad-output/evidence/v6-z3/operator-GO.json` (0600), one per fire, fields per `OperatorGoSchema` + **`reviewSet`** — the set `deriveReviewSet(QDS_EXEDEV_SHA)` returns (order-insensitive; run
   `bun -e 'import {deriveReviewSet} from "./scripts/z3/round-plan.ts"; console.log(JSON.stringify(deriveReviewSet(process.argv[2])))' <sha>`
   and paste). who = Steve chat authorization WITH attribution + round number + what changed; when = UTC now, never future; `spendApproved.worstCaseUsd` 5.25 (composition unchanged: 3 QA + 1 code, caps unchanged); `swarmclawForkRev` = SWARMCLAW_FORK_REV.
6. Invoke the `qds-live-e2e` skill FIRST (mandatory). Pre-fire checks: no stale `.sandbox/fleet.lock`, disk space, no spinners.
7. Fire in background:

```
source _bmad-output/evidence/v6-z3/fire.env && bun test tests/fleet/e2e/z3-exit-round.live.test.ts > /tmp/z3-live-fire19.log 2>&1
```

Expected arc ~25–40 min: trigger → 3 QA legs (closed+retained, now auditing
the REAL pinned-diff review set) → crash-window kill/redrive → priming-recall
(NOW citing real findings) → park → scripted approve → post-approve observes →
branch_taken. Known-good budget ≈ 7 h ceiling. One GO per fire — the test
CONSUMES it (moved to `<stamp>-operator-GO.consumed.json`).

### Sweep after ANY red (every red so far self-swept; verify anyway)

```
ssh exe.dev ls --json                       # want vms: []
sqlite3 .sandbox/cost-ledger.db "SELECT COUNT(*) FROM budget_group_admissions WHERE ..." # unreleased $0
docker exec -w /app swarmclaw-swarmclaw-1 npx tsx scripts/solstice/z3-exit-round.ts state  # schedules archived/completed only
```

(Use the readonly better-sqlite3 pattern — see the wiring's own readonlyRows —
never a writer sqlite3 on the live ledger. If a kill leaves the fork mid-boot,
give it ~3 min before trusting reads.)

### On green — F4 closeout

Commit ALL v6-z3 evidence (rounds 8-N legs + every consumed GO + handoff
docs), flip Z3 done in `_bmad-output/sprint-artifacts/sprint-status.yaml` +
`dark-f-repo-live-exit-round.md` (merge shas; note #470 as the remaining
Z3-owned gap — do NOT add to Z3_UPSTREAM_BLOCKERS), close swarmclaw#913 +
QDS#479 with round refs, branch `feature/z3-round-done`, PR → dev, full gates
(tsc 0, lint 0, bun test tests/z3/).

---

## Traps paid for (each cost a fire or a gate — none optional)

- **Old fork container drops `reviewSet` silently** → host trigger refuses → wasted round. The rebuild (Gate 3) is not optional.
- **Old exe.dev image lacks the sidecar zero-fix** → a "none"-arm nondeterminism event deletes the sidecar → harvest-malformed → green leg reds (round 15/17's class). Gate 2 is not optional.
- **Digest ritual is same-commit**: input change + re-publish + adopt + digest, one commit. #482 broke the order; the red test is the alarm working.
- NEVER force-push a branch a running round pinned (QDS_EXEDEV_SHA is cloned by the code-run fill; unreferenced shas 404). Push follow-ups as new commits.
- Fork fleet-child env allowlist is PATH/HOME/TMPDIR/LANG only (SC2.5 fence) — priming needs the env where the CLI runs.
- In-box worker replies sometimes carry no `findings` key (model nondeterminism) — the zero-fix covers it once the image re-publishes; do not re-flag as a bug.
- `bun scripts/fleet.ts` from repo cwd (bun auto-loads .env from cwd only). Bun.spawnSync needs stdout:"pipe". No `timeout` on macOS — `perl -e 'alarm N; exec @ARGV'`.
- mdfind/find before asking Steve. Never print secret values. ~/.desktop remote is another machine — never prune/push it. `gh pr merge` on protected branches hits REVIEW_REQUIRED — Steve's order + `--admin`.
- The pin re-verify after any recreate (Gate 3 checklist) — instrumentation dying silently is rounds 8/9's whole story.
- Bun.test writes progress with \r and ANSI — always `tr '\r' '\n' | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g'` before grepping a log.

## Known debt, NOT round-blockers (do not fix during the round)

- F-017 rig_swarm retry test (`tests/phase-engine/pipeline-run.test.ts`) — pre-existing on dev, classified 2026-10-27.
- Self-compact P1/P2/P3 — contention flakes, pass solo.
- GH billing (Gate 4) blocks CI trust, not the fire.
