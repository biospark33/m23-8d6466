# Sprint #486-#489 register session, continuation — day 7, 2026-11-06/07. Fifth session.

Read repo CLAUDE.md first and honor it (test suite always teed to a log with the
tr/perl/grep recipe; bunx tsc --noEmit + bun run lint before any final commit;
qds-live-e2e skill for live/no-fakes legs; after capture, corrections are
forward-only; branch convention prefix=feature/ base=dev target=dev; direct
docs-only push allowed (precedent 7d8b7dd9, b3e4b35d, bd504a4a, ec4c0f66) —
anything else goes through a feature/ PR targeting dev; BMad off or degraded to
skip_bmad=1).

## STATE (all verified end-of-session-5)

- dev = origin = ec4c0f66. Local branch = dev only; no stray worktrees. Working
  tree carries ONLY the pre-existing untracked dirs (.unlazy/*,
  _bmad-output/evidence/*, _bmad-output/judgment/*, _bmad-output/memory/*) —
  leave alone.
- FIVE PRs merged this sprint day: #505 (M1.2 AC7 evidence + CR rounds 1-2),
  #506 (m2-gateway HTTP server + publish workflow + CR round), #507 (tier2 T2
  cap 50k→500k µ$), #508 (bun re-pin 1.3.13→1.4.2, whole ritual),
  #509 (memory-combined driver cap 50k→500k µ$). All branches pruned
  local+remote.
- Bun pin UNIFORM at 1.4.2: package.json packageManager, ci.yml (3 jobs),
  publish-exedev-image.yml, Dockerfile ARG BUN_VERSION=1.4.2 +
  BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
  (double-verified). Local bun is 1.4.3 — fine (>= floor). bunfig.toml STAYS
  (worker --config forwarding unreleased as of 1.4.4; re-check stamped in its
  docblock, next at any pin >= 1.4.4).
- Exedev image re-pin ritual COMPLETE: walked-inputs digest 20fd85fe…, Dockerfile
  hash cfd5cd68… (both adopted in #508), publish run 42276921315 gate-failed
  printing the digest, adopted on dev as fd1c3ea8 (DEFAULT_IMAGE_REF
  …@sha256:89c6206b2cda48fa0e48f248ecbf150c0eb714b7d23abc8377b69373f982efff,
  DEFAULT_IMAGE_BUILD_ID e21dd27c0e62afe5), healing publish 42279372181 GREEN,
  verify-image-pin: verify (dev) + verify (default) SUCCESS.
  verify-image-pin's `base-drift` job is RED BY DESIGN (scheduled upstream
  exeuntu drift alarm; pre-existing, register-recorded, operator-owned
  decision) — do not "fix" it, do not confuse it with adoption fallout.
- m2-gateway image PUBLISHED:
  ghcr.io/quantum-digital-solutions/qds-m2-gateway:sha-fd1c3ea87808653c903162d9f2eb5a94c3e230da
  (manifest digest sha256:c128b3d27fa281c2292c6359025cdfad556e7d32085a08b3dbc50d2c20162f60,
  linux/amd64 asserted on registry read-back; run 42279460536 success). Publish
  workflow .github/workflows/publish-m2-gateway-image.yml: dispatch from ANY
  ref + auto on push to dev/main touching src/** or oci/m2-gateway/**; tags are
  EXACTLY sha-<git sha>, never floating. Runbook ops-register row flipped
  UNOWNED→OWNED (2026-11-06, in #506).
- Compose/env (in #506): docker-compose.factory.yml now scopes
  MEMGATE_ADMIN_KEY + QDS_MEMGATE_SIGNING_KEY to the gateway only (hindsight-qds
  service empties both via committed environment: beats env_file);
  deploy/vps/env/hindsight-qds.env.example documents the pair + QDS_MEMGATE_LEDGER
  guidance (leave unset for container-local ledger, or add a compose volume
  mount that shares the host minting ledger — NEVER point it at a host-only
  path; unset → default .sandbox/memgate-ledger.db, pre-created bun-owned in
  the image). src/memgate/server.ts: refusals serialize {error:{code}} ALONE
  (messages can echo limit/path material — INV-MG-5/6), credentials verified
  BEFORE body parse (no-auth precedes JSON refusal), default client key chain
  HINDSIGHT_BEARER_TOKEN → HINDSIGHT_API_KEY → HINDSIGHT_API_TENANT_API_KEY.
  Gateway image built + smoke-booted locally (port 8080 + ledger dir verified).
- T2 caps UNIFORM at 500_000 µ$: tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts
  (#507) AND tests/fleet/e2e/memory-combined.live.test.ts:~97 (#509 — the M2.3
  driver itself; #507 alone had fixed only the tier2 sibling).
- M2.3 handoff (_bmad-output/reviews/m2-3-t2-handoff.md) spend line updated:
  500,000 µ$ key cap → **$1.06 worst case** (commit ec4c0f66).
- M1.2 CR verdicts, for the record: the "server-reported 0.1.0" claim was NOT
  reproducible — measured live: image tag 0.10.0 AND /version api_version
  "0.10.0"; story + handoff now state both labels agree (verified 2026-11-06).

## REMAINING WORK (all operator-gated; in this order)

1. **Z4 AC8 VPS day** (zero agent spend; runbook G1–G7 mostly DONE — box, DNS,
   secrets, hindsight-qds container already up):
   a. Operator seeds in the VPS compose project .env: QDS_FACTORY_OWNER +
      M2_GATEWAY_TAG=sha-fd1c3ea87808653c903162d9f2eb5a94c3e230da (F-006
      fail-late, never :?).
   b. DECIDE GATEWAY PACKAGE VISIBILITY: the GHCR package
      ghcr.io/quantum-digital-solutions/qds-m2-gateway was created PRIVATE on
      first publish. Either flip it public (matches the exedev image's public
      AC4 model) or docker login on the VPS with a packages:read credential —
      otherwise the compose pull 403s.
   c. Place memgate env beside /opt/qds/QDS-Factory/deploy/vps/
      hindsight-qds.env: MEMGATE_ADMIN_KEY + QDS_MEMGATE_SIGNING_KEY (0600,
      operator-held; template now documents both; SIGNING_KEY must MATCH
      whatever mints keys host-side); QDS_MEMGATE_LEDGER per the template's
      guidance (unset = container-local, or mount to share host ledger).
   d. compose up m2-gateway (image now exists; restart: "no" is still set —
      flip to unless-stopped when the slot proves healthy, per the compose
      comment); Caddy splice per runbook (deploy/vps/Caddyfile.factory.*),
      "caddyRoute":"deferred-to-M2.3" marker allowed, field never absent;
      evidence to _bmad-output/evidence/v6-z4-vps/ ({"status":"awaiting-image"}
      rows flip to real states); diff-verify (the wrapper runs in-clone,
      exempt).
2. **M2.3 combined live round** (worst case $1.06; preconditions checklist in
   _bmad-output/reviews/m2-3-t2-handoff.md §"Preconditions to clear" — all five
   now clearable: image pin healed, M1.2 T2 fired green, gateway env = item 1c,
   exe.dev env = the standing fire-env recipe, GO = operator). Assemble the
   exact GO decision and ASK — never fire live spend without explicit GO.
3. Other open operator-gated halves: A3 sign-offs + crontab corpus milestones +
   operator sign-off; issue #408 (M1.1 VPS remainder: schemas.ts conformance
   amendment + P0.5 legs).

## ENVIRONMENT NOUNS (measured this session)

- Local docker daemon healthy; a stale qds-m2-gateway:devtest image exists
  locally from yesterday's session (harmless). Restart Docker Desktop before
  image work if it hangs.
- Gateway smoke recipe that worked: docker build --platform linux/amd64 -t
  qds-m2g-smoke -f oci/m2-gateway/Dockerfile . && docker run with
  MEMGATE_ADMIN_KEY/QDS_MEMGATE_SIGNING_KEY env → nc -z 127.0.0.1 8080 +
  .sandbox/memgate-ledger.db created bun-owned.
- Local hindsight (qds-factory-hindsight-qds-1, image 0.10.0, /health healthy,
  /version api_version 0.10.0) co-binds 127.0.0.1:18890 on this Mac with a
  stale ssh tunnel (macOS allows both). Still unresolved from yesterday: kill
  the stale tunnel AND decide the local container's fate (stop it or move to
  18891 + set HINDSIGHT_BASE_URL accordingly) before any host leg that must
  reach the VPS store. Local docker also has a separate owner of 127.0.0.1:18080
  (unrelated).
- pi gotchas (standing): explicit --api-key + --model;
  anthropic/claude-haiku-4.5; PI_LENS_ROOT=/Users/steve/pi-lens… (3.8.71)
  exported or resolvePiLens throws.
- Local load: Steve's VM pushes load 13-16, bursts 50+. THIS SESSION'S MEASURED
  COROLLARY: never run two gate suites concurrently (two bun test/check:coverage
  runs at once drove load to 78 and produced 30+ timeout-flake fails in
  cap-hit-demo / fanout-race / reaper-GRANDCHILD / maker-reach families — all
  green on low-load rerun). Run gates serially. Known environmental flakes:
  cap-hit-demo family needs --timeout 30000 locally; kill-tree GRANDCHILD sweep
  in reaper; story-consistency spawn budgets 30s; maker-reach repo-walk can
  pass 5s on a slow CI runner (rerun the failed job).
- Long-code generation gotcha ACTIVE this session (bit 4 times): Write/Edit of
  large blocks produced garbage tokens mid-string (invented identifiers,
  mangled comments). Mitigation that works: write in SMALL verifiable pieces,
  re-read the region after each edit, git diff before committing.

## FLAGS (operator calls, standing)

- HINDSIGHT_API_TENANT_EXTENSION still unset in the compose (Z4 defense); do
  not change silently.
- Gateway GHCR package visibility (item 1b) is an operator security decision —
  public mirrors the exedev model but exposes the gateway image source; private
  needs a VPS pull credential.
- verify-image-pin base-drift alarm: upstream exeuntu base moved; re-pinning
  the base is an operator decision with its own ritual; it does NOT block
  anything above.

## RULES OF ENGAGEMENT (unchanged)

Non-gated work first; for every operator-gated leg, assemble the exact GO
decision (worst-case cost + what fires) and ask — never fire live spend without
explicit GO. Static gates before any final commit: bunx tsc --noEmit (0
errors), bun run lint (exit 0), GitNexus detect_changes (compare vs dev).
Register/yaml edits drain per the header rule. Merges: operator approves
(branch protection REVIEW_REQUIRED); gh pr merge --admin works on explicit
operator instruction.

## GOTCHAS DISCOVERED THIS SESSION (new, load-bearing)

1. **A code phase's `command` exit NEVER gates the verdict** — runCommand
   RESOLVES {exitCode, stdoutTail} on nonzero (scripts/pipeline-run.ts:~766);
   ONLY a declared testCommand composes the commandGate that fails the phase
   (DF3.3). Any manifest-authored check that must gate goes in testCommand.
2. **bun install in a worktree flips cli-anything/src/index.ts to 100755** —
   `git checkout cli-anything/src/index.ts` (or chmod 644 + commit) before
   committing anything else; it will otherwise ride your commit.
3. **Suite side-effects**: full `bun test` runs have been observed to dirty
   _bmad-output/evidence/df1-4/* (trace.db/json) — restore before committing.
4. **Phase-engine manifest loader signature**: loadManifest(path,
   callerBudgetMs, runRoot) — callerBudgetMs is REQUIRED (positive int),
   positionally.
5. **Compose list-form env values**: quotes are LITERAL (`KEY=""` sets two
   quote chars); use bare `KEY=` for empty. Committed environment: beats
   env_file per service — the scoping pattern for gateway keys.
6. **CR findings are hypotheses, not facts**: this session one claimed a
   server-reported "0.1.0" that no measurable surface carries (measured:
   0.10.0 twice). Verify each against code/live before editing; fix the valid
   kernel, skip the rest with a reason.
