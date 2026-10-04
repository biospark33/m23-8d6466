# fix3-cli — round-3 FINAL fix wave, CLI scope (m1-1)

Agent: fix3-cli. Files touched: `scripts/provision-hindsight-banks.ts`,
`tests/provision-hindsight-banks.test.ts`. No commit made. Nothing else.

## R3-002 (MED) — dead armed rerun forks + stale DD-17 comment

**Fix.** Deleted the unreachable `isRerunProvision` ternary in the
`--no-bridge-probe` branch, the dead shared-lane rerun block, the ~19-line
stale DD-17/F-025 comment narrating them as live, and the round-2 snapshot
dance (legacy tolerant snapshot + empty-re-ask) — all round-2 uncommitted
lines. Replaced by ONE comment line at the classified dispatch:
"R3-002: reruns are handled solely by this classified dispatch — one lane,
both topologies; the fresh path below never re-forks on rerun." There is now
exactly one rerun path in the file.

## R3-003 (MED) — lock FIRST, snapshot inside the window, noLock fresh lane

**Fix.** New exported seam `openProvisionWindow(client, repoSlug, deps)` owns
the whole discipline `main()` executes:

1. hardened `acquireHeartbeatLock` (see R3-006) — before anything touches the
   instance;
2. `takeRerunSnapshot` (fail-closed, R2-004) INSIDE the window — the
   fresh-vs-rerun classification never trusts pre-lock state;
3. dispatch: rerun lane (no bridgeProbe — R2-011 no-POST) and dedicated fresh
   lane (DD-17 literal) both call `rerunAwareProvision` with
   `holdProvisionerLock: true` → provisionBanks runs `noLock: true` under the
   held family lock (else its internal 300s single-flight refuses against
   ourselves);
4. shared fresh lane: the window returns `{kind: "shared-fresh", ctx, release}`
   with the lock STILL HELD; `main()`'s committed tail (pinned verbatim by the
   adds-only gate) executes inside the same window via a LOCAL binding
   `const provisionBanks = opened.ctx.provision` — the pinned
   `provisionBanks({client, repoSlug, bridgeProbe})` / print / return lines
   stay live and now emit the ONE envelope under the held lock, with
   `opened.release()` (guarded) between the pinned print and return.

Settled paths (every refusal + rerun + dedicated-fresh) release inside the
window; the shared-fresh handoff releases in main after the pinned tail.

## R3-004 (MED) — rerun-lane failure compensation

**Fix.** New exported `compensateRerunFailure(client, repoSlug, preBankIds)`
honors the helper's documented failure contract ("failure paths report [];
the caller's own post∖pre diff is the authority under failure"). Claim rule:
a bank is this attempt's creation iff roster member ∧ absent-from-pre ∧
present-in-post (post-presence, not step reports, is the creation evidence —
a PUT that lands server-side then 5xxs still created the bank). Claimed
members are deleted with per-bank outcomes (AC3 vocabulary: deleted /
already-gone / deleted-unknown-shape / failed — mirrors the drivers'
`deleteOutcome`). Everything else the window gained → envelope `residue` with
reason `"unclaimed-created"` and left alone (probe banks of unlocked legs,
operator creates — the R3-005 attribution inversion, not repeated here);
failed deletes → outcome `"failed"` + residue `"delete-failed"`. A
post-snapshot that itself throws abandons compensation with nothing claimed
(driver no-authority discipline). Fresh failures are provisionBanks' own
envelope's to report — `banks: []` is the honest figure, no compensation.

## R3-006 (MED) — hardened lock variant

**Fix.** The window's acquisition mirrors the drivers exactly:
`mkdirSync(dirname(lockPath), {recursive:true})` INSIDE the try (R2-020);
pid-aware holder `ageMs >= LEG_LOCK_STALE_MS || pid === undefined ||
isPidDead(pid)` (`isPidDead` imported from `src/lib/file-lock.ts`) — a
SIGKILLed/unparsable holder is stolen at once, not after 900s; guarded
release (`releaseGuarded`) that warns `lock-release/warn-taken-over` on
stderr instead of crashing past a printed envelope. The `provision_lock_busy`
message ("held by a live holder … retry") is now true whenever emitted.

## R3-007 + R3-008 (LOW) — ONE envelope builder

**Fix.** `buildRerunEnvelope` replaced by exported
`buildProvisionEnvelope(repoSlug, requestId, result, compensation?)` →
`ProvisionEnvelope`. Used by every path (rerun, dedicated fresh, shared fresh
via ctx.provision, and the window's refusal envelopes). `banks` is bankId
STRINGS from the ACTUAL result: rerun → confirmed roster (raw.roster, all
PUTs landed); fresh → provisionBanks result bankIds, so a genuine foreign
collision's `<base>-2` id is reported honestly; failure → `[]` (R3-008 — the
roster is a claim, not a fact, once anything failed). `mode` rides the
helper's lane label (absent only on pre-classification refusals: lock/
snapshot envelopes `{ok:false, banks:[], requestId, createdInAttempt:[],
error}`); `createdInAttempt` is the helper's honest figure verbatim. Failure
messages map all three helper shapes (rerun string error, fresh
`{code,message}` object — numeric code folded into the message, fresh
`thrown`).

## R3-016 (LOW) — SWARMCLAW_* env leak

**Fix.** Describe-scoped `afterEach` (delete `SWARMCLAW_BASE_URL` +
`SWARMCLAW_MCP_SERVER_ID`) installed in the `--no-bridge-probe (DD-17)`
describe that contains the `resolveProbe(false)` delegation test — house
style, matching the neighboring HINDSIGHT_BASE_URL describes.

## Tests

- Envelope describe rewritten for `buildProvisionEnvelope`: rerun success
  (confirmed roster + honest createdInAttempt), rerun failure (banks [] +
  compensation record attached), fresh success with an honest `-2` collision
  id + R3-009 created-only figure, fresh ProvisionErr (numeric code folded),
  fresh thrown.
- New `compensateRerunFailure` describe: claimed-member-deleted +
  unclaimed-created residue + pre-window banks untouched; failed-PUT-never-
  landed → nothing claimed, `deleteBank` never called (the task's base-PUT-is-
  an-upsert fixture); delete-throws → failed/delete-failed; post-snapshot
  throw → abandoned, no claims.
- New `openProvisionWindow` describe (per-test tmpdir lock under a
  never-existing parent dir — every test also pins the mkdir-inside-try):
  lock held BEFORE listBanks fires + released on settle (call-time
  observation); rerun success envelope/exit 0; rerun failure compensation
  end-to-end (landed-then-threw member claimed + deleted, concurrent stray →
  residue, exit 1); nothing-landed failure → empty compensation; dedicated
  fresh lane pins `noLock: true` + DD-17 literal probe + R3-009 filter;
  shared-fresh handoff pins lock STILL held at handoff and across
  `ctx.provision` (`noLock: true` — the same closure main's pinned tail
  calls), released by `release()`; live-holder lock → `provision_lock_busy`
  before any instance touch, holder's lock untouched; unparsable-holder lock
  stolen at once (pid-aware, not age-only); snapshot failure inside the
  window → `snapshot_failed` refusal with the lock released.

## Adds-only gate + verification (FOUR-PASS)

- `bun test tests/provision-hindsight-banks.test.ts` → exit 0, **69 pass /
  0 fail**.
- `bunx tsc --noEmit` → exit 0 (whole repo).
- `bunx @biomejs/biome check scripts/provision-hindsight-banks.ts
  tests/provision-hindsight-banks.test.ts` → exit 0, no findings.
- `git diff HEAD -- scripts/provision-hindsight-banks.ts | grep -c
  '^-[^-]'` → **0** (HEAD's committed lines — including main()'s shared-fresh
  tail — all survive verbatim; every reworked line was a round-2 uncommitted
  addition).

## Design notes for reviewers

- The shared-fresh lane's local `const provisionBanks = opened.ctx.provision`
  shadow is load-bearing for the adds-only gate: HEAD's committed tail
  (`realBridgeProbe` → `provisionBanks({...})` → print → `return
  result.ok ? 0 : 1`) must stay verbatim, and the shadow routes those exact
  lines through the held-window/noLock/ONE-envelope discipline. The module
  import of `provisionBanks` stays referenced (`provisionImpl:
  deps.provisionImpl ?? provisionBanks` in the window's `attempt` seam) so
  `noUnusedLocals`/biome stay clean.
- Pre-window refusals (bad_args / bank_prefix_violation / base_url_*) keep
  their committed HEAD shapes — they predate the window and never touch the
  instance.
- The window's failure envelopes carry `banks: []` but no `mode`
  (classification never ran); `ProvisionEnvelope.mode` is optional for that
  reason and documented as such.
