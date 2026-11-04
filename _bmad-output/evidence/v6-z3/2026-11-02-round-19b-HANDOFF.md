# Z3 live exit round 19 — handoff (2026-11-02 ~14:05 UTC)

Status at stop: **every substrate fix is landed, pushed, attested, and
proven; the round is one GO + one fire away from the finish line.** Eight
attempts ran today; each red was measured, root-caused, fixed, and pushed.
Nothing is owed anywhere except the fire itself (and the closeout it
unlocks). Attempt 9 should be the green one — every failure mode seen today
now has a live fix or an honest contract arm.

## Where things stand (all verified 2026-11-02 13:55-14:05 UTC)

| Artifact | State |
|---|---|
| Factory dev | `fb4d1ee8` — the round's full fix stack + the image pin adopted (`afdcf2ae…`, buildId `2f66ed76`-era — READ IT OFF driver.ts at fire time; publish run 41456956864 publish/attest/attested GREEN) |
| The pin | `ghcr.io/quantum-digital-solutions/qds-exedev@sha256:afdcf2ae51ba7c0958ed8c40c7e9f9138380635d29429640a26327513c56d983` — anonymously pullable again, verify-image-pin `verify (default)` + `verify (dev)` GREEN; `base-drift` red = informational (upstream exeuntu :latest moved; scheduled chore, NOT a blocker) |
| Fork dev | `d8adbd2d5` (#918 merged); container `swarmclaw-swarmclaw-1` on `solstice-swarmclaw:combined-d8adbd2` (built Oct 27, healthy; the daemon lock renews; state ≥ 66,537 B; in-container `reviewSet` grep = 5) |
| fire.env | `_bmad-output/evidence/v6-z3/fire.env` (0600): `SWARMCLAW_FORK_REV=d8adbd2d5ef85f3d98119d1c2ab6e7d5925e426f`, `QDS_EXEDEV_SHA=$(git rev-parse HEAD)` (evaluates at source), all other keys set; memgate token FRESH (minted ~12:0x UTC, 24 h, `.unlazy/z3/token-expires-at` sidecar carries the expiry) |
| GO | NONE on disk — the fire consumes it. Write `_bmad-output/evidence/v6-z3/operator-GO.json` (0600) per OperatorGoSchema + reviewSet = deriveReviewSet(QDS_EXEDEV_SHA at fire time) |
| Substrate | 0 boxes on exe.dev; ledger clean (sweep below); no run locks; hindsight-qds (127.0.0.1:18890) healthy; memgate gateway validating |

## What was fixed today (each measured live, each pushed; all on dev by `fb4d1ee8`)

1. **Cold-pull create kill (exit 137)** — a virgin digest's first boot
   outlives exe.dev's create ceiling; the box wedged in `creating` and the
   leg refused (`submit-intent-corrupt`). Fix: one create retry after a
   30 s GC settle (`0583a5c4`, `createRetrySettleMs`).
2. **Steering provision mid-boot drop (255)** — the steering ssh raced the
   box's boot. Fix: one retry on the transport-drop signature
   (`a7fa61e1`, `steeringRetrySettleMs`).
3. **THE PRIMING GAP (never worked, any round)** — the SC2.5 fence
   (`buildFleetEnv`: PATH/HOME/TMPDIR/LANG) stripped HINDSIGHT_* from the
   fork's fleet-CLI child, so `memoryEnvConfigured()` never held and the
   dispatch recall never ran — round 18's priming evidence shows the SAME
   "directive absent" red. The operator's `.sandbox/z3-gate/hindsight.env`
   (written Oct 26) was read by nothing. Fix: the fleet-gate wrapper sources
   it before every exec path (`c1fc8a2b` + restored #468 suite `114e57ef`),
   live via the `/factory` bind-mount (no fork rebuild). The env file now
   points at `http://host.docker.internal:18890` (the dedicated instance the
   host-side retain writes; reachability + listBanks proven in-container).
4. **Release-before-recallable race** — extraction completes inline at
   retain (7.4 s/doc) yet recallability lags; the code run's dispatch recall
   ran 189 ms after the last retain and surfaced zero round docs, while the
   same bank hours later surfaced 14/19 (NOTE: the recall response carries
   the camelCase `documentId` — a naive `document_id ?? id` read misses
   every hit). Fix: the crash window's release now polls a dispatch-shaped
   recall until ≥1 retained doc id surfaces (bounded 15 min, zero spend
   while waiting; `c9d5fa8b`).
5. **The honest-empty arm** — attempt 7's pin diff was CLEAN: the hunters
   honestly found nothing, the round retained zero findings, and "cites ≥1
   retained finding" is unsatisfiable. Fix: `primingRecallProblems` gains
   the arm — zero retained + directive kg_context + bank surfaces ≥1 doc =
   GREEN (`44433a3a`, dated story amendment included in
   `_bmad-output/sprint-artifacts/dark-factory-v6/stories/z3-cross-repo-live-exit-round.md`).
6. **Image supply chain, twice** — openrig caret floats moved the
   /opt/openrig tree twice in 13 h (rig binary UNCHANGED both times,
   `cc75efdd`); re-pinned (`be94e66d`, `04fe77bb`), adopted twice
   (`4fd79684`, `fb4d1ee8`). The floating caret needs a lockfile for the
   global install — filed in the Dockerfile commentary, NOT done.
7. **Org billing / ghcr package lock (operator-side)** — from ~13:32Z both
   known digests 404'd anonymously (exe.dev create: "not found or not
   accessible"); Actions worked. Steve's billing reset (~13:45Z) unlocked
   the package; the next publish pushed and healed. If creates ever refuse
   with "not found or not accessible" again: check the org's Packages
   billing BEFORE touching anything else.

## Attempt ledger (all 2026-11-02; each consumed one GO)

| # | Time (UTC) | Red at | Cause | Fix commit |
|---|---|---|---|---|
| 1 | 02:11 | pre-spend preflight | hindsight-qds container Exited(137) 2 days prior | `docker start qds-factory-hindsight-qds-1` (not a commit) |
| 1 | 02:26 | leg 1 provision | cold-pull 137 kill | `0583a5c4` |
| 2 | 03:01→03:25 | leg 2 redrive | steering 255 mid-boot | `a7fa61e1` |
| 3 | 03:28→04:00 | QA leg 3 teardown exit 6 | single occurrence; box outlived; hand-cleaned; record settled via `fleet teardown --no-harvest` | retry (no fix) |
| 4 | 04:15→04:52 | priming-recall | directive ABSENT (the fence) | `c1fc8a2b`+`114e57ef` |
| 5 | 05:31→06:07 | priming-recall | directive kg_context ✓, zero citation (release race) | `c9d5fa8b` |
| 6 | 12:13 | gateFire | stale GO review set (the gate working) | GO update |
| 7 | 12:24→13:00 | priming-recall | zero findings retained (clean diff) | `44433a3a` |
| 8 | 13:11→13:33 | QA leg 2 provision | ghcr package locked (billing) | operator billing reset |
| — | 13:52→14:0x | — | publish healed + adopted (`04fe77bb`→`fb4d1ee8`) | ready |

## THE FIRE (attempt 9) — exact procedure

1. `cd /Users/steve/QDS-Factory`; verify: `git log --oneline -1` → `fb4d1ee8`
   (or any later tip whose OWN diff is the review set), `git status -sb` in
   sync with origin/dev, PUSHED (the code-run fill clones QDS_EXEDEV_SHA).
2. Sweep (all green or fix before firing):
   `ssh exe.dev ls --json` → `{"vms":[]}`;
   `bun .unlazy/z3/release-stale-groups.ts` → no RELEASE rows (13 SKIPs are
   pre-existing/intent-submitted, leave them);
   `ls .sandbox/runs/*.lock` → none; `ls .sandbox/fleet.lock` → none;
   hindsight-qds healthy on 127.0.0.1:18890 (`docker ps`, curl /health);
   fork daemon lock age < 120 s:
   `docker exec -w /app swarmclaw-swarmclaw-1 node -e 'const db=require("better-sqlite3")("/var/lib/solstice/swarmclaw-data/swarmclaw.db",{readonly:true});const r=db.prepare("SELECT owner,expires_at,updated_at FROM runtime_locks WHERE name=?").get("daemon-primary");console.log(JSON.stringify({age_s:Math.round((Date.now()-r.updated_at)/1000),ttl_s:Math.round((r.expires_at-Date.now())/1000)}))'`
3. Token: `bun .unlazy/z3/mint-token.ts` → "already carries a minted token"
   = good (the script now validates expiry via the sidecar; if it re-mints,
   also fine).
4. GO: `_bmad-output/evidence/v6-z3/operator-GO.json` (0600), one per fire —
   fields who / when (UTC now) / spendApproved.worstCaseUsd 5.25 /
   swarmclawForkRev `d8adbd2d5ef85f3d98119d1c2ab6e7d5925e426f` /
   reviewSet = `bun -e 'import {deriveReviewSet} from "./scripts/z3/round-plan.ts"; console.log(JSON.stringify(deriveReviewSet(process.env.SHA)))' ` with `SHA=$(git rev-parse HEAD)`.
   who = "Steve (biospark33), chat authorization 2026-11-01/02" + the round
   number + what changed since the last GO.
5. Invoke the `qds-live-e2e` skill FIRST (mandatory). Print the worst case
   ($5.25). `ssh exe.dev whoami` must answer.
6. Pre-fire: no `.sandbox/fleet.lock`, disk, no spinners; then fire IN
   BACKGROUND (unsandboxed shell — gotcha #17):
   `source _bmad-output/evidence/v6-z3/fire.env && bun test tests/fleet/e2e/z3-exit-round.live.test.ts > /tmp/z3-live-fire19i.log 2>&1`
7. Arc ~35-40 min (the release-wait may add ≤15 min): trigger → 3 QA legs
   (closed+retained over the pin's own diff) → crash-window kill/redrive →
   priming-recall (cites a retained finding, or honest-empty green) → park →
   scripted approve → observes → branch_taken. Assert ≥1 `(pass)` in the log
   (hollow-green check). One GO per fire — the test consumes it.
8. If GREEN: skip to "On green" below. If RED: sweep (box list → destroy
   survivors by hand; ledger sweep script; fork cancel; if a record is
   stuck, `bun scripts/fleet.ts --driver exedev teardown --no-harvest <run>`
   after `rm` of the dead-pid lock), classify on the evidence JSON, fix on
   dev, push, new GO, re-fire. Known-still-open watch items: the openrig
   caret floats can refuse a build at any publish (re-pin ritual, same
   commit); the fork-side teardown exit-6 seen once (attempt 3) never
   recurred across attempts 4-8.

## On green — F4 closeout

Commit ALL v6-z3 evidence (rounds 8-19 legs + every consumed GO + both
handoffs), flip Z3 done in `_bmad-output/sprint-artifacts/sprint-status.yaml`
+ `dark-f-repo-live-exit-round.md` (merge shas; #470 stays the remaining
Z3-owned gap, NOT in Z3_UPSTREAM_BLOCKERS), close swarmclaw#913 + QDS#479
with round refs, branch `feature/z3-round-done`, PR → dev, gates:
`bunx tsc --noEmit` 0, `bun run lint` 0, `bun test tests/z3/`.

## Debt named today (NOT round-blockers; owner notes)

- openrig floating caret: second same-day move; lockfile the global install
  (Dockerfile commentary has the design note).
- base-drift: exeuntu upstream :latest moved (weekly rebuild); re-pin both
  FROM digests as its own commit when convenient (2026-10-18 precedent).
- 13 ledger admissions with intent=submitted + record reaped (rounds 8-18
  era, $0.50 each, dead groups): `.unlazy/z3/release-stale-groups.ts`
  refuses them conservatively; release by hand only after confirming the
  runs settled.
- The security-review harness errors on today's commits/pushes (model
  unreadable / network): disclosed per plugin instruction; the diffs were
  suite-verified inline. `/Users/steve/.claude/security/log.txt`.

## Traps paid for today (each cost a fire or a gate — none optional)

- hindsight-qds (port 18890) DIES QUIETLY — check `docker ps` for
  `qds-factory-hindsight-qds-1` before any fire; preflight's ECONNREFUSED
  means THIS container, not the swarmclaw stack's `swarmclaw-hindsight-1`
  (18889 is the wrong-instance trap).
- The dispatch recall row is named by REQUEST id and read by REQUEST id;
  the recall response's ids ride the camelCase `documentId` (the wire is
  snake_case) — naive parses read zero.
- The GO is consumed by the test the moment the round binds (preflight
  failures do NOT consume it; a bound round DOES). One GO per fire.
- The digest test's walked inputs do NOT include `scripts/z3/**` or
  `src/providers/exedev/driver.ts` — verified twice today — so z3 commits
  do not move the pin; oci/** and walked COPY inputs do (ritual is
  same-commit: input change + re-publish + adopt + digest).
- `ssh exe.dev rm` of a box stuck in `creating` fails ("VM not found") —
  the substrate GC reaps it; destroy survivors only when listed as running.
- Bun spawn of `fleet cancel` on an already-destroyed box dies in harvest
  (hostname unresolvable) and HOLDS the lock; use `fleet teardown
  --no-harvest` (cancel takes no --no-harvest).
- The fork container mounts the factory repo at `/factory` read-write —
  wrapper/leg-driver code is LIVE from the host repo without any rebuild.
- Never a bare `bun test` without the log; the tr/perl/perl-grep recipe is
  in CLAUDE.md and matters (bun writes \r + ANSI).
