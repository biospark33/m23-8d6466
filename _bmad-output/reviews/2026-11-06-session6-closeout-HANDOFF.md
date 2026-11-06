# Sprint #486-#489 register session - day 7, session 6 close-out handoff (2026-11-06)

Companion to 2026-11-06-session7-HANDOFF.md (session 5's doc; its STATE section stays
authoritative for pre-session-6 facts). This file records session 6's delta only.
Forward-only: nothing above is rewritten.

## What changed this session (all gate-verified, unlazy z4-vps-day 8/8 MET)

- Z4 AC8 fired leg EXECUTED: gateway slot UP + healthy on vultr qds-alpha
  (149.28.248.96). Zero spend, agent-run on operator instruction. Evidence:
  _bmad-output/evidence/v6-z4-vps/2026-11-06-z4-ac8-fired.json
  (ledger .unlazy/z4-vps-day/GATES.md).
- GHCR qds-m2-gateway stays PRIVATE (operator confirmed). Box pulls via docker login
  with the biospark33 gh CLI token (write:packages), token ssh-stdin only. VPS-day
  visibility decision CLOSED.
- Firewall: stale tcp/22 source rule 68.183.152.138/32 (dead IP) removed;
  tcp/22 from 71.58.70.204/32 added. 22/80/443-only stands.
- Box checkout ff to dev 938e749a (token-carried fetch; clone has no credential
  helper). 6 deploy/vps files byte-identical; tracked tree clean.
- Memgate keys minted + placed + vaulted: MEMGATE_ADMIN_KEY +
  QDS_MEMGATE_SIGNING_KEY (fresh, never printed). Pass item
  "QDS-Factory m2-gateway keys (vultr qds-alpha)" (Operating vault). Box file
  /opt/qds/QDS-Factory/deploy/vps/hindsight-qds.env (0600) carries them;
  QDS_MEMGATE_LEDGER absent (container-local ledger).
- Gateway smoke: vps-m2-gateway-1 running healthy; nc 8080 ok in-container;
  .sandbox/memgate-ledger.db created uid 1000; hindsight-qds NOT recreated.
- caddyRoute = deferred-to-M2.3 (field present, never absent): NO Caddy on box -
  front door is solstice-nginx. Row splice (nginx location row vs Caddy install)
  = M2.3-day operator decision.
- Register drained: sprint-status.yaml day-7 note (day-6 cont. note drained to
  history file); Z4 row comment records fired-leg execution.
- Local cleanups: qds-m2-gateway:devtest image removed; stale 18890 tunnel already
  dead (docker-only bind); local hindsight-qds container RETAINED.
- M2.3 preconditions: (1) image pin healed YES; (2) M1.2 T2 fired YES;
  (3) gateway env DONE this session (fire env must carry the SAME
  QDS_MEMGATE_SIGNING_KEY); (4) exe.dev env standing recipe (operator-held);
  (5) GO pending. NEW M2.3-day items: perimeter row (nginx vs Caddy) REQUIRED for
  public reach (gateway publishes no ports); box checkout refetch before fire if
  dev moved.

## Gotchas this session (new, load-bearing)

1. Box fetch needs a token: the box clone has no credential helper; plain git
   fetch fails (could not read Username). Working pattern:
   T=$(gh auth token); printf '%s' "$T" | ssh ... 'T=$(cat); git -c
   credential.helper=!f(){ echo username=biospark33; echo password=$T; };f'
   fetch origin dev'. The http.extraheader variant SILENTLY fails, and piping
   through tail masks the exit - two stacked traps.
2. Generator discipline (standing this session): hand-writing long files
   corrupted tokens 4x (invented identifiers, mutated IPs/tags, junk lines).
   Works: build artifacts from short constants, checker re-asserts load-bearing
   values (G8 caught the corrupted draft). Re-read regions; git diff pre-commit.
3. gate-check CWD anchoring: CHECK commands anchor at the LEDGER dir - use
   absolute script paths in CHECK lines.

## M2.3 perimeter decision line

CADDY-SPLICE: nginx location row vs Caddy install is an operator call; until a
row exists the gateway is compose-network-only (no public reach) and M2.3 cannot
fire without it. forbiddenOrigin traps :8888/:18889 - the origin must be the
fronted URL.
