# harden-dispatch-tests.md — W2a, review round 10, PR 123 (df3-1)

File owned/modified: `tests/fleet/dispatch.test.ts` (only file touched).
Branch: `feature/df3-2-fanout-best-of-n`. No commits made.

Gates: `bunx biome check tests/fleet/dispatch.test.ts` clean · `bunx tsc --noEmit` — zero errors in
dispatch.test.ts (sole remaining repo error is `tests/fleet/verbs.test.ts:1121` "Cannot find name
'inOrder'", a teammate's in-flight file, not mine) · `bun test tests/fleet/dispatch.test.ts`
**123 pass / 0 fail**, 1014 expect() calls, 11.1 s. No INV-2 flake observed; nothing needed a solo
rerun.

Stamp tripwire check: `grep stampManifest|stamp_manifest|manifestLimit tests/fleet/dispatch.test.ts`
→ no hits; confirms fix-manifest's finding. Nothing to flip.

## HIGH

| Item | Disposition |
|---|---|
| forged-runId loop (~:400) | ADDED — `expectSingleRefusalLine("run-id-not-minted")` per iteration |
| absolute manifestPath (~:748) | ADDED — `expectSingleRefusalLine("invalid-brief")` |
| symlink escape (~:775) | ADDED — `expectSingleRefusalLine("manifest-rejected")` |
| repoRoot undefined (~:805) | ADDED — `expectSingleRefusalLine("manifest-rejected")` (test also rewritten, see LOW) |
| expectRosterRefusal six (~:896) | ADDED inside the helper (`expectSingleRefusalLine(code)`), so all seven call sites get it |
| timeout-invalid loop (~:1114) | ADDED per iteration |
| port-invalid loop (~:1171) | ADDED per iteration |
| run-id-in-use sequential + EEXIST loser (~:1198/:1217) | ADDED to both |
| gate undefined/null (~:2321) | ADDED per iteration (`setup-gate-invalid`) |
| expose-no-url + blank-URL loop (~:3952/:4005) | ADDED to both |
| setPublic failure (~:4047) | ADDED (`dispatch-failed`) |

Helper doc at ~:267 updated to state the now-true claim ("every refusal family asserts it — directly,
through the roster helper, or inline"). Deliberately not added where a sibling already asserted it or
where two refusals land in one test by design (AC4 evidence test).

## MEDIUM

- **Mint EXACTLY the cap ⇒ silent**: ADDED — "a provider that mints EXACTLY the request is SILENT".
  Pins request echo, both carriers stamped with the agreed figure, empty `phase:"minted"` filter
  (that phase has exactly one writer), zero refusal lines.
- **Gate item B invalid-JSON arm**: ADDED into the existing item-B probe test — present, non-empty,
  non-JSON manifest → note contains "not parseable", none of the other three B diagnoses.
- **Items A and C via REAL fake-gate path**: ADDED as a pair after the hand-built AC3 fixtures.
  A: intercept `exec ["true"]` → exit 1 → failedItem A / code 1 / executed set stops at A.
  C: let real delivery run, then `chmodSync` the box's `.env` to 0644 before the stat probe →
  failedItem C / code 2, payload shows full executed set `A:ok, B:ok, C:…mode 644`, record open,
  box alive.
- **keyApi.createKey throws mid-provision**: ADDED — exit 1 `key-delivery-failed`, FIXED message
  (provider free text absent from FleetError envelope), `providerCode` omitted, INV-5 posture
  (record open, box alive, commands name THIS run), ledger closed, refusal line filed.
  Free-text absence pinned on dispatch's OWN sinks only (structured lines + persisted dispatch log):
  the providers layer logs its own step line for the failed mint, and that copy is
  `redactSecrets`' jurisdiction — same two-half split the delivery sibling documents. First draft
  asserted whole-sink absence and failed honestly on that providers-side line; scoping corrected.
- **Cross-runId concurrency vs maxVms**: ADDED — two DISTINCT-id dispatches barrier-parked inside
  `checkHeadroom`'s `driver.list`, released together against maxVms=1 ⇒ both admitted, 2 live boxes.
  Pins the DOCUMENTED current behavior (the "FLEET-CEILING half is NOT closed" comment over step 6);
  closing it needs a providers-layer intent record, deliberately out of scope here.
- **Abandoned-step stall margins (four tests)**:
  - abandoned-mint: RESTRUCTURED to a two-stage clock spend — create leaves 30 s (every other
    timer too long for any stall), correlation-stamp write (last sync seam before mint arms)
    spends down to 900 ms so only `mint` holds a short timer.
  - abandoned-setPublic: same scheme — gate leaves 30 s (expose immune), `httpsUrl` record write
    spends down to 900 ms for setPublic alone.
  - abandoned-clone: same scheme — ledgerFactory leaves 30 s, first exec call (key delivery, last
    awaited step before clone arms) spends down to 900 ms.
  - create-timeout: comment CORRECTED — structurally nothing can flip it (advance→arming stretch is
    synchronous; every earlier timer held the full ceiling and was already cleared); margin bumped
    1 s → 2 s as refactor insurance.

## LOW

- **abandonedLine >50 ms second-line defeat**: TIGHTENED — settle ceiling 50 ms → 250 ms, early
  exit unchanged (~10 ms common case). Comment states what the old window lost.
- **FIFO skip visibility**: ADDED always-on companion test whose NAME reports whether mkfifo is
  present ("ACTIVE") or absent ("SKIPPED … why").
- **repoRoot:undefined cwd coupling**: REWRITTEN — manifest now lives at a nonce relative path
  written only beneath `dir` (via `manifestAt`), plus a positive `existsSync(cwd/…)` control. The
  cwd resolution cannot exist regardless of working-tree contents, while the injected root WOULD
  load it — the discriminating power of the original is preserved without depending on repo contents.
- **Record posture on provision-failure**: ADDED — `closedAt` undefined pinned next to the existing
  record-exists assertion.
- **Missing exitCode assertions**: ADDED — `toBe(2)` in management-URL run-id test and in both
  iterations of the hostile-key-name loop.
- **Exactly-at-MAX_BYTES roster ACCEPTED**: ADDED — VALID_ROSTER padded with a YAML comment to
  exactly ROSTER_MAX_BYTES (length asserted), driven past the pre-check to a `provision-failed`
  marker with admission spent; pins the strict `>` in both size checks.
- **Exact expiry boundary (elapsed == ceiling)**: ADDED — advance exactly DEFAULT_TIMEOUT_MS across
  the gate with a port ⇒ post-gate sample sees remaining 0 → exit 1 `dispatch-timeout`,
  step `post-gate`, `gateReady:true`.
- **requestId sequential REUSE**: ADDED — two sequential runs under one supplied id: acks AND
  records carry it, run ids distinct.
- **expectRosterRefusal UnexpectedSuccessError guard**: ADDED — helper now throws
  `UnexpectedSuccessError` when dispatch unexpectedly succeeds instead of failing as
  "expected FleetError, got undefined".
- **Budget spent==cap boundary**: ADDED — inline refused-decision ledger with spent EXACTLY equal
  to cap ⇒ exit 5 `budget-exceeded`, payload carries both equal figures; zero provisioning,
  handle closed.
- **VALID_ROSTER model alias rot**: no model constant is exported from roster/schema.ts (checked:
  only THINKING_LEVELS / ROSTER_MAX_BYTES etc.), so per instruction ADDED a naming comment on
  VALID_ROSTER citing `resolveSlug` and stating that a schema rename must be mirrored by hand.
- **MINT_RETRIES probes count**: `MINT_RETRIES` is unexported in src/fleet/dispatch.ts, so no
  import derivation is possible; replaced bare `expect(probes).toBe(5)` with named local
  `DISPATCH_MINT_RETRIES = 4` and a failure message telling the reader which source constant to
  re-sync when it moves.

## Final counts

- Tests: 123 (was 113) — +10 new tests, all green in one run, no reruns needed.
- Assertions: 1014 expect() calls.
- Gates: biome clean · tsc clean for this file · bun test 123 pass / 0 fail.
