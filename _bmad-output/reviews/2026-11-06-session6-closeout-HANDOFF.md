# Sprint #486-#489 — day 7/8, session 6 close-out (2026-11-07): M2.3 arc

Session 6 executed BOTH operator-gated legs: Z4 AC8 VPS day (COMPLETE, 8/8 gates)
and the M2.3 combined live round (FIRED 13x, deterministic blocker diagnosed,
evidence captured). Companion to 2026-11-06-session7-HANDOFF.md (its STATE stays
authoritative for pre-session-6 facts).

## Z4 AC8 (fired leg) — COMPLETE

- Gateway slot UP + healthy on vultr qds-alpha; GHCR stays PRIVATE (operator
  call); box pulls via gh-token docker login; memgate keys minted+vaulted
  (Proton Pass item: QDS-Factory m2-gateway keys (vultr qds-alpha)) + placed
  0600 on box; shared minting ledger via operator override compose file
  (/opt/qds/memgate <-> /data). Perimeter: nginx row POST /v1/<t>/banks/<b>/
  memories/recall at the E21-S09A main-*.conf include point (operator chose
  nginx); externally verified 401 no-auth / 403 GET / 404 not-forwarded.
  caddyRoute=spliced (nginx mechanism, recorded honestly). Evidence:
  _bmad-output/evidence/v6-z4-vps/2026-11-06-z4-ac8-fired.json.
- Firewall: ssh rule re-issued per operator-IP rotation (rotates; helper
  .unlazy/z4-vps-day/state/fwwindow.sh; one approved temp-detach window used
  during CGNAT recovery + short windows for round control).
- Firing-host setup (NEW, standing recipe): box .env carries
  OPENROUTER_PROVISIONING_KEY, OPENROUTER_API_KEY (solstice-ci),
  QDS_PI_CATALOG_DIR (bun-global pi-ai data dir), HINDSIGHT_BASE_URL
  (127.0.0.1:18890), tenant bearer, QDS_KG_GATEWAY_URL
  (https://qds-alpha.zeropointsignal.com), QDS_MEMGATE_LEDGER
  (/opt/qds/memgate/memgate-ledger.db), exe.dev repo/SHA/roster;
  /root/.pi/agent/models.json = custom rate registry (pi's own bundled rates)
  because the bundled ids are chat:-prefixed and the roster slugs miss.
  pi 1.1.0 installed on box (bun global) + node->bun symlink.

## M2.3 — FIRED 13x, DETERMINISTIC BLOCKER DIAGNOSED

- Preconditions cleared: roster-check green on box (exit 0), exe.dev auth ok,
  gateway reachable (public origin), shared ledger mint plane ok.
- L0 + LD + L1 PASS every fire (dispatch real: box created, key minted
  500000 usd cap, repo filled, engine armed). L2 FAILS identically every
  fire: fixer worker returns an EMPTY coms reply within ~500ms (0 tokens, 0
  turns) - lead exits ok, coms_await deadline verdict: transient. L3 count
  assert then fails. NOT the image (probe: pi 0.84.4 + node + extension +
  exact worker argv + real minted key = WORKS on a forensic exe.dev box,
  deepseek-v3.2 replied).
- Root-cause LAYER (next session's fix): worker stderr discarded at three
  spawn sites - cli-anything/src/runner.ts stdio ['ignore','pipe','ignore']
  x2 (driver stderr ignored, comment line 319), driver line 743 logs worker
  stderr tails to ITS stderr, which the runner ignores. The fixer crash line
  is unobservable on the deployed image. FIX = runner.ts stderr pipe +
  engine forwards -> image rebuild -> publish ritual -> adopt -> refire.
- Second defect: transient restart NEVER EXECUTED (journal: shouldRetry
  true, retriesRemaining 8, wallClock 3.6M ms remaining - engine settled the
  run failed after ONE attempt). Separate investigation.
- Instrumentation branch: feature/m23-run-record-stdout-tail
  (7a6acb9d..33a7c213: run-verb stdoutTail, stderrTail 4000, journal-tail
  fetch on non-ok settle; tsc+lint green per commit). PR it next session.
- Spend: 13 fires x (box-minutes + ~1-4k usd in-box) ~= well under $1 total;
  every fire's finally cleaned (boxes [] every check, keys [] - the only key
  churn was a PRE-EXISTING month-old leak: 46 stale sbx-spike-openrig keys
  from 2026-10-04, swept 2026-11-07 under standing cleanup authority).
- One forensic box (m23-forensic-1) lived ~45 min, hand-destroyed.

## Session gotchas (new, load-bearing)

1. CGNAT ssh flapping: the operator hotspot rotates egress IPs per flow -
   /32 Vultr rules flap. Helper fwwindow.sh + short windows + detached
   rounds (nohup) make control possible; expect poll failure storms.
2. OpenRouter key-create returns the plaintext at TOP-LEVEL 'key', not
   .data.key; the list endpoint paginates and old keys hide behind it.
3. pi's bundled catalog ids are chat:-prefixed; roster slugs miss the rate
   table -> the DESIGNED fix is ~/.pi/agent/models.json (pi custom registry)
   seeded with pi's own rates, not catalog surgery.
4. generator discipline held for every artifact after the corruption streak:
   python lines-lists + checker re-assertions caught 4 corrupt drafts.

## Remaining (next session)

1. Image-side worker-stderr capture -> rebuild/publish/adopt -> refire M2.3
   (GO ask per ROE; worst case $1.06).
2. Restart-not-executed defect.
3. PR feature/m23-run-record-stdout-tail.
4. A3 sign-offs + #408 (M1.1 VPS remainder incl. wrapper install) - untouched.
