# Z3 live exit round 19 — handoff update (2026-11-03 ~17:2x UTC)

Status: **attempt 24 (b3fyj30wl-era fire = log `19x`, pid 64181) still draining**
— its tree predates the terminal-verdict fixes, so its park leg is running
wiring-internal retry chains on ONE red verdict (observe #3, bound-kill
~18:05Z; the round self-settles red + cleanup ~18:1xZ, hard round deadline
~19:35Z). **Do not fire attempt 25 until pid 64181 is gone.** Attempt 25 then
fires at HEAD `4e4a676d` per the re-fire procedure below — this is the FIRST
tree where every known red cause is fixed. Green = F4 closeout (bottom).

## The round's remaining failure mode (the only one left)

The reverify gate's full tests/ suite (8 192 tests, ~21 min in a cold
worktree) flakes under park-chain CPU contention: attempt 23 chain 1 = 1
unnamed fail vs chain 2 clean; attempt 24 = 38 then 19 (different counts
across chains at the SAME sha → flake class, not deterministic). Idle
probes: 0-1. Three mitigations just landed (all suite-verified, pushed):

1. `e25acfd6` — driver-level: verdict-red (observe exit 6) = terminal, no
   driver retry.
2. `4e4a676d` — wiring-level: the wiring's internal park retry now also
   skips exit 6. Before this, one red verdict ran up to FOUR observes
   (two wiring chains × driver retry) — attempt 24 burned 2h50m on one
   red verdict.
3. `e25acfd6` — the reverify suite yields the host (`nice -n 10`), cutting
   the 5 s-timeout flake density at the source. Real runs, no mask.

With ONE chain per red verdict + yielding host: a red verdict now costs
~21 min (was 45-170) and the next red NAMES its tests (both-streams 16 kB
capture `e7e25b19`).

## Every red cause this session, fixed on dev (all pushed, all suite-verified)

| # | Attempt | Red at | Cause | Fix |
|---|---|---|---|---|
| 16 | 19p | park: reverify `no-host-plan` (54 ms) | operator `.factory/pipeline.json` missing (gitignored, existed Sep, deleted) | operator config CREATED + validated offline; reverify ceilings 30→45→60 min (`1b5a124e`, `75a8a0bb`) |
| 17 | 19q | round timeout, 113-min stall | local network outage 22:47→00:40Z (ssh `Undefined error: 0`, DNS ENOTFOUND) | environmental; hand-clean |
| 18 | 19r | leg-2 retain | hindsight retain wall 23.7 s > 30 s client bound | `RETAIN_TIMEOUT_MS` 30→120 s (`f5196fde`) |
| 19 | 19s | park: reverify RED 98 | 5 admission tests real regression from 32faf486 (15 s retry settle vs bun 5 s test timeout, cascade via withAdmissionSingleFlight); 14 checkout-name-dependent p0-9 legs (R2-018 basename default); buildId walk stale | `b133ddb7` (thread headroomRetrySettleMs through DispatchDeps+fanout, 3 tests inject 1 ms), `47118e28` (QDS_REPO_SLUG pinned in the 3 leg describes), digest re-pin |
| 20 | 19t | park: reverify RED 66 + tsc | my own unstaged digest fix (`51089e0c`); the decisive find: `verifyEnv` passed the ROUND'S fire.env through — `QDS_E2E_LIVE=1` un-skipped 39 live files → 66 reds | scrub the 8 live-gate vars in `verifyEnv` (`cda77bde`); F-017 rig_swarm daemon port seam `a2b2c294` |
| 21 | 19u | park: reverify RED 1 | buildId digest re-pin ritual missed on 75a8a0bb + cda77bde | `a315c2a4` re-pin = probe's own Received value |
| 22 | 19v | GO gate, 49 s, $0 | GO reviewSet derived at a315c2a4, HEAD moved to d1d9033d before fire | re-derive at fire time, GO 23 |
| 23 | 19w | park: nondeterministic rule (chain 1: 1 unnamed flake; chain 2: 8097/0 all-green) | ~1-in-16k flake; capture too small to name it | capture 16 kB both-streams (`d1d9033d`, `e7e25b19`) |
| 24 | 19x | park: 38 then 19 fails (flake class) | same; and the double retry burned 2h50m | fixes 1+2+3 above; also capture-fix `e7e25b19` |

## Re-fire procedure (identical each attempt)

1. **Wait for round 24 to exit** (`ps -p 64181`; bound-kill ~18:05Z, cleanup
   after; if past ~19:40Z, check children: `ps aux | grep 'fleet.ts observe'`).
2. Sweep: `ssh exe.dev ls --json` → `{"vms":[]}`; no `.sandbox/runs/*.lock`,
   no `.sandbox/fleet.lock` (a DEAD-pid lock: clear per its own remediation);
   hindsight `curl -s http://127.0.0.1:18890/health`; ledger
   `bun .unlazy/z3/release-stale-groups.ts --dry-run` (13 SKIPs stay);
   `bun .unlazy/z3/mint-token.ts` (mint if within 1 h of expiry; sidecar
   `.unlazy/z3/token-expires-at`); fork `docker ps | grep swarmclaw-swarmclaw-1`
   healthy; credits via the credits API vs worst-case $5.25.
3. GO (one per fire): write `_bmad_output→_bmad-output/evidence/v6-z3/operator-GO.json`
   — `reviewSet` MUST equal `deriveReviewSet(git rev-parse HEAD)` computed at
   fire time (attempt 22 refused on a stale one), `worstCaseUsd` 5.25,
   `swarmclawForkRev` `d8adbd2d5ef85f3d98119d1c2ab6e7d5925e426f`, narrative
   naming the previous attempt's red.
4. Fire UNSANDBOXED, background:
   `source _bmad-output/evidence/v6-z3/fire.env && bun test
   tests/fleet/e2e/z3-exit-round.live.test.ts > /tmp/z3-live-fire19y.log 2>&1`
   (suffix letter advances each fire; do NOT append `&` — a detached `&`
   breaks the completion notification).
5. On green: hollow-green check (`grep -c '(pass)'` ≥ 1), then F4 closeout.
   On red: sweep → classify (the 16 kB both-streams tail names failing
   tests now) → fix on dev → suite-verify (tsc/biome/tests) → re-pin the
   buildId digest IN THE SAME COMMIT if src/** moved (test
   `tests/scripts/build-exedev-image.test.ts` is the authority; Received
   value is the truth) → push → new GO from the NEW HEAD → re-fire.

## F4 closeout on green (per the round-19b handoff)

- Commit the round's evidence JSONs (`_bmad-output/evidence/v6-z3/`) on dev,
  push.
- Flip `sprint-status.yaml` for the z3 story.
- Close #913 and #479.
- PR `feature/z3-round-done` → dev.

## Known-open (unchanged unless noted)

- Reverify suite flake density under load: mitigated (nice + single chain),
  not eliminated — if attempt 25 reds, the tail names tests; fix root causes.
- openrig caret floats / base-drift / 13 stale ledger SKIP admissions.
- Security-review hook errored on every push this session (same "model
  unreadable" class, disclosed; `/Users/steve/.claude/security/log.txt`).
- Memgate token minted 00:45Z Nov 3, 24 h — mint-token.ts re-mints within 1 h
  of expiry automatically.

## Fire logs this session (classified, kept)

`/tmp/z3-live-fire19{p,q,r,s,t,u,v,w,x}.log` = attempts 16-24. Evidence JSONs
in `_bmad-output/evidence/v6-z3/` per attempt; reverify jsonl per run under
`.sandbox/reverify/<runId>.jsonl`.

## GREEN — round 19 landed (2026-11-04 ~02:00 UTC)

Attempt 30 (fire `19ad`, GO 30 consumed 01:04:49Z) went GREEN at HEAD
`71680335`: 3306 s, `1 pass / 0 fail`, the full arc — trigger → 3 QA legs →
crash-window-redrive → priming-recall → approval-park → approve → 3×
qa-run-observe → observe-read-only → branch-and-complete (01:59:09Z).
Cleanup machine-checked: `revokeVerify ok:true leaked:[]`, 4 boxes destroyed,
`vms:[]`, `failurePath:false`, spend within the $5.25 GO cap (~$8.5 total
across attempts 25-30). F4 closeout: evidence JSONs + this file committed via
PR `feature/z3-round-done` → dev; sprint-status Z3 flipped done; #913 + #479
closed.

Three fixes landed after 19d was written (this session, all pushed):

- `ca1d2c38` — the vetoed park settles red on observe exit 6 (proven live in
  attempt 29: red settled 35 s after the verdict, no 2 h poll) +
  NOTE_MAX_CHARS 1_000→16_384 so the capture survives the note.
- `81a2ec99` — retriedHindsightCall: the findings-retain + gateway-reflect
  seams retry a TimeoutError transit stall once (attempt 28's red), then fail
  NAMED.
- `71680335` — the reverify capture EXTRACTS (fail) lines from the full body
  (attempt 29's red: 8100/1, the 16 kB tail was 100 % atexit fixture noise).

Host changes: Docker VM 23.4→11.7 GB (host swap was 34.6/35.8 GB — the
park-chain flake class partly lived there), memgate token re-minted 24 h
(mgat-c462941bf8004cd85886633a, expires ~23:13Z Nov 4). Flake density across
the park reverify: 38 → 23 → 1 → 0 (green).
