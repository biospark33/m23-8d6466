# Blind Hunter — Cynical Review, Round 3 (M1.1 dedicated Hindsight VPS)

Input: `/tmp/m1-review-diff-r3.txt` only. Line numbers are hunk-derived new-file
lines (±2); every finding quotes the diff verbatim so it is greppable.

---

## 1. Dead rerun forks in CLI main() — the old unhardened lane is unreachable but left armed, with comments describing pre-gate behavior

**Severity: MEDIUM**
**File: `scripts/provision-hindsight-banks.ts:598, :615` (comments :578-595, :605-614; gate at :527)**

The round-2 consolidated rerun gate returns on every rerun:

```ts
  if (isRerunProvision(existingBankIds, repoSlug)) {
    ...
    return envelope.ok ? 0 : 1;
  }
```

`existingBankIds` and `repoSlug` are never mutated between that gate and the two
later forks, so both remaining rerun branches are dead code:

```ts
  if (args.noBridgeProbe) {
    const bridgeProbe = await resolveProbe(true);
    const dedicated = isRerunProvision(existingBankIds, repoSlug)   // :598 — always false here
      ? await rerunAwareProvision(client, repoSlug, { existingBankIds, bridgeProbe })
      : await provisionBanks({ client, repoSlug, bridgeProbe });
```

```ts
  if (isRerunProvision(existingBankIds, repoSlug)) {               // :615 — always false here
    const shared = await rerunAwareProvision(client, repoSlug, {
      existingBankIds,
      bridgeProbe: await realBridgeProbe(args.mcpServerId),
    });
    process.stdout.write(`${JSON.stringify(shared)}\n`);
```

The gate's own comment admits it ("The legacy lane forks below are now
fresh-only: isRerunProvision is false whenever control reaches them"), yet the
DD-17 comment directly above the dead ternary still narrates the rerun behavior
as live and contradicts the gate:

> "The fork mirrors leg-lib rerunAwareProvision (single source for the roster
> discipline; it re-verifies the base-present check against the same snapshot
> before choosing its branch): base ABSENT → …; base PRESENT (our own earlier
> run created it) → PUT-upsert the canonical roster … The rerun envelope records
> its mode (\"reupsert-existing\") so the second run's output proves the demo"

That is false twice over for this lane: it is unreachable, and if it were
reached it prints `rerunAwareProvision`'s RAW result — exactly the R2-007
stdout-contract violation (no `banks`/`requestId`) the gate was added to fix —
and runs with NO lock (the R2-005 violation). Same for the dead shared-lane
block, which also fires a `realBridgeProbe` POST the gate's comment promises is
never issued on rerun ("R2-011: … NO bridge-probe POST (the rerun branch never
reads the verdict)"). These are load-bearing tripwires: any future reorder of
the gate (or deletion of it) silently reactivates the pre-round-2 bug shape.
The file-header stdout contract ("On {ok:true} → prints {ok,banks,requestId}
JSON + exit(0)") is likewise stale next to the new `{ok,banks,requestId,mode,
createdInAttempt}` envelope.

---

## 2. Rerun/fresh classification reads an UNLOCKED snapshot — the race window mints exactly the `<base>-2` junk F-025 exists to prevent

**Severity: MEDIUM**
**File: `scripts/provision-hindsight-banks.ts:486-498` (snapshot) vs `:527-532` (gate + lock)**

```ts
  let existingBankIds: string[] = [];
  try {
    existingBankIds = extractBankIds(await client.listBanks());     // :488 — NO lock held
  } catch { ... }
  ...
  if (isRerunProvision(existingBankIds, repoSlug)) {                 // :527 — decides the lane
    ...
    releaseRerun = await acquireHeartbeatLock(lockPath, {...});      // :532 — lock taken AFTER
```

Both drivers do it in the opposite, correct order — lock first, snapshot inside
the window (provision-and-import.ts runLeg acquires the lock, then
`provisionWindow` takes its `snapshot-pre`; same in idempotency-rerun), with
the stated purpose "a concurrent CLI/other-caller run fails its own lock
instead of interleaving creates into this attempt's diff (F-005)". The CLI's
classification snapshot sits OUTSIDE that protection. A concurrent
provision-family writer that lands the base bank between `client.listBanks()`
and lock acquisition makes `isRerunProvision` read false → the fresh lane runs
→ `provisionBanks`' resolver sees our own base as a foreign collision and mints
`<base>-2` junk — the precise regression class the whole rerun-aware apparatus
was built to kill. After taking the lock the gate also never re-verifies the
snapshot (`rerunAwareProvision` only re-checks the PASSED array). Narrow
window, but the fix is one moved snapshot.

---

## 3. CLI rerun lane violates rerunAwareProvision's documented failure contract — partial upserts strand unreported with `createdInAttempt: []`

**Severity: MEDIUM**
**File: `scripts/provision-hindsight-banks.ts:560-575` vs `scripts/p0-9/leg-lib.ts:694`**

The helper's contract on failure:

> "Failure paths report [] — the caller's own post∖pre diff is the authority
> under failure." (leg-lib.ts, `RerunAwareProvisionResult.createdInAttempt` doc)

The drivers honor it (they always take a post-snapshot and compensate). The
CLI rerun lane does not — it prints the envelope and exits:

```ts
      const result = await rerunAwareProvision(client, repoSlug, { existingBankIds, requestId, onStep });
      const envelope = buildRerunEnvelope(repoSlug, requestId, result);
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
      return envelope.ok ? 0 : 1;
```

On a mid-roster rerun failure (e.g. the base PUT lands, the recreated
`-dev-meta` PUT 500s), `result.createdInAttempt` is `[]` by design and the CLI
takes no post-snapshot and attempts no compensation — the evidence claims
nothing was created while a recreated roster member is stranded on the
instance. Only the NEXT run's snapshot silently absorbs it. The fresh CLI
lanes are excused (provisionBanks owns its failure envelope); the rerun lane
has no such owner and ignores the documented authority rule.

---

## 4. `releaseRerun()` unwrapped in the gate's finally — a taken-over lock discards the printed envelope's exit path into an unhandled rejection

**Severity: LOW**
**File: `scripts/provision-hindsight-banks.ts:573-575`**

```ts
    } finally {
      releaseRerun();
    }
```

`acquireHeartbeatLock`'s inner `release()` throws on takeover ("Release clears
the interval BEFORE the inner release (also on taken-over paths, where the
inner release throws)" — leg-lib.ts). Both drivers defend against exactly
this:

```ts
  } finally {
    try {
      release();
    } catch (e) {
      rec("lock-release", "warn-taken-over", { detail: (e as Error).message });
    }
  }
```

The CLI does not. If the throw fires, the envelope has already been written to
stdout (promising `exit 0` on a green rerun) but the `finally` throw replaces
the return value and propagates out of `main()` — the process dies on an
unhandled rejection with a nonzero code that contradicts the envelope it just
printed.

---

## 5. `buildRerunEnvelope` claims the full canonical roster as `banks` even on failure

**Severity: LOW**
**File: `scripts/provision-hindsight-banks.ts:379` (buildRerunEnvelope)**

```ts
  return {
    ok: result.ok,
    banks: [base, `${base}-dev-meta`, COLLECTIVE_BANK_ID],
    ...
    ...(failure !== undefined ? { error: { code: "provision_failed", message: failure } } : {}),
  };
```

`banks` is unconditional. On a failed rerun (first PUT 500s) the envelope
still lists all three banks as if present — a consumer parsing `banks` on
`ok:false` (or an operator skimming the JSON) is told banks exist that were
never upserted this attempt. The fresh lane's envelope only ever reports banks
provisionBanks actually confirms.

---

## 6. Fresh-path `createdInAttempt` includes pre-existing roster members — R2-019 residue naming overclaims

**Severity: LOW**
**File: `scripts/p0-9/leg-lib.ts:750` (rerunAwareProvision fresh lane) + `scripts/p0-9/provision-and-import.ts:433`**

```ts
        createdInAttempt: result.banks.map((b) => b.bankId),        // fresh: the FULL roster
```

`provisionBanks`' result includes members with `status: "exists"` (the tests'
own fixture returns `{ bankId: COLLECTIVE_BANK_ID, status: "exists" }` in
`result.banks`). That figure is what the R2-019 path publishes as residue when
the post-snapshot dies:

```ts
    ext.residue = attempt.createdInAttempt;
    if (attempt.createdInAttempt.length > 0) {
      ext.residueReason = "unconfirmed-delete: post-snapshot failure stranded the attempt's creations ...";
```

On a fresh attempt where the collective pre-existed, the evidence names a
bank this attempt never created as one of "the attempt's creations". Evidence
accuracy only (no deletes are attempted on that path), but it is the exact
honesty property R2-019 was written for.

---

## 7. CLI rerun lock diverges from the driver lock discipline: no lock-dir mkdir, age-only holder

**Severity: LOW (runtime impact partly SPECULATION)**
**File: `scripts/provision-hindsight-banks.ts:529-532` vs `scripts/p0-9/provision-and-import.ts:584`, `:586-589`**

Both drivers create the lock directory inside the guarded try, with a comment
proving `acquireHeartbeatLock` throws without it:

```ts
    // R2-020: the lock-dir mkdir lives INSIDE the try — a file-shaped dirname
    // or EACCES resolves fatal LegEvidence (writeEvidenceOrStderr), never a
    // bare crash out of runLeg.
    mkdirSync(dirname(lockPath), { recursive: true });
```

The CLI gate calls `acquireHeartbeatLock` directly with no mkdir — on a host
where the base bank exists but `~/.hindsight` was never created (instance
provisioned from a different home/container, dir cleaned), a legitimate rerun
refuses with `provision_lock_error` where a driver run proceeds. The gate also
uses the default age-only holder while drivers use the pid-aware
`ageMs >= staleMs || pid === undefined || isPidDead(pid)` — after a `kill -9`'d
driver the CLI's rerun is refused `provision_lock_busy` for up to the full
900 s staleness budget where a driver would steal immediately. Fail-closed
either way, so LOW; the mkdir asymmetry is provable from the diff, the
ENOENT behavior of `acquireFileLock` is not shown in it (SPECULATION label on
that half).

---

## 8. Test leaks SWARMCLAW_* env vars with no cleanup

**Severity: LOW**
**File: `tests/provision-hindsight-banks.test.ts:300-301`**

```ts
  test("resolveProbe(false, id) still delegates to realBridgeProbe", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
```

No `afterEach`, no `finally` in this describe block (the neighboring
HINDSIGHT_BASE_URL describes each install their own `afterEach` delete). Both
vars stay set for every later test in the same process — any subsequent test
that exercises `realBridgeProbe`/probe-derived code now silently runs against
`http://sw`/`hs-1` instead of the unset-state it was written for.

---

## 9. provision-and-import happy-path tests read the REAL repo corpus — checkout-dependent pass/fail

**Severity: LOW**
**File: `tests/p0-9/legs.test.ts:937-942` (deps for tests A/B/C)**

```ts
      const deps = {
        mode: "mock" as const,
        baseUrl: "http://127.0.0.1:18890",
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
      };
```

No `expertiseDir` — `provisionWindow` falls back to
`DEFAULT_EXPERTISE_DIR` (repo `.mulch/expertise`). Test C asserts
`expect(evC.ok).toBe(true)` on a fully-green run, which holds only while every
real corpus file stays schema-valid and readable; one invalid entry makes
`mint.failures` non-empty → `failed = true` → the test fails on content the
test never pinned. The R2-022 fix did exactly this for the mint-record test
("the mint record is pinned against OUR entries, never the repo's real
.mulch/expertise contents (checkout-independent pass/fail)") but left A/B/C on
the default dir.

---

## 10. auth-retired-check classifies an unmeasured probe as `refused-unclassified`

**Severity: LOW**
**File: `scripts/p0-9/auth-retired-check.ts:390` (unauthenticated classification)**

```ts
      unauthenticated = {
        answered,
        measured: retainProbe.kind !== "error" || recallProbe.kind !== "error",
        ...
        class: answered
          ? "answered-2xx"
          : authRefused && !nonAuthRefused
            ? "refused-auth"
            : nonAuthRefused
              ? "refused-non-auth"
              : "refused-unclassified",
```

When BOTH probes transport-error, `measured` is `false` (correct, and the
containment verdict correctly says "NOT measured … no retirement claim is
made") but `class` still falls through to `"refused-unclassified"` — a
refusal classification for a probe that produced no response at all. This is
the same assert-more-than-observed shape R2-009 was written to remove
("Narrating them as ANSWERED asserted a measurement that did not happen; the
always-present verdict field must never claim more than the probe observed").
The verdict field is clean; the `class` field is not.

---

## Clean dimensions (verified against the diff, no findings)

- **`HindsightClient.deleteBank`** (`src/hindsight/client.ts:204`): 404→already-gone,
  numeric `deleted_count:0`→already-gone, 2xx+`success:false`→502 refusal,
  non-numeric count→absent (deliberately pinned by test), other errors rethrown,
  `assertBankId` 422 before any fetch — mapping is internally consistent and
  test-covered on every branch.
- **`forbiddenOrigin` two-layer ordering (R2-016)**: URL-port verdict first
  (catches `:08888`, userinfo-prefixed, path-suffixed spellings; frees
  `…:18890/prefix:8888`), normalized suffix fallback only for unparseable
  input; the opaque-URL residual (`hindsight-qds:8888`) is documented and not
  fetch-usable as a base.
- **`maskTail` (R2-014)**: `\b`-anchored exact field words (keyword/monkey/keynote
  survive), quoted values mask whole, query values stop at `&` by design,
  double-mask of `Authorization: Bearer x` is documented fail-closed.
- **`acquireHeartbeatLock` (R2-002)**: content-verified touch, cleared+unref'd
  interval, release-before-inner-release; the two lock tests (heartbeat beats a
  100 ms thief; bare lock is stolen and release throws) pin both directions.
- **R2-004 fail-closed snapshot re-ask**: throw→`snapshot_failed` refusal,
  answering-empty roster stays fresh-lane — the transient-failure junk-mint path
  is closed.
- **Driver env discipline**: every driver resolves baseUrl by name
  (`requireBaseUrl`) or normalized deps override, trap-checks before any
  network, threads the checked value into client construction; mock rehearsals
  without injected fetch stay hermetic and record skips (never green).
- **Probe budgets**: AbortController + `clearTimeout` in `finally` on every raw
  call (health, shape probes, down-instance, auth probes).
- **`scanLiveShapePrereq` (R2-001)**: requires `mode:"live"` AND `ok:true`,
  newest-first scan, mock-stamped prereqs rejected.
- **Evidence-dir policy**: mock refuses the closure dir and subdirs
  (separator-aware, realpath'd, case-folded on darwin/win32); rehearsal default
  outside the repo; `writeEvidenceOrStderr` guarantees mutated-run outcomes
  survive a failing write.
- **`parseArgs`**: bool-flag consumed on a filtered copy (argv not mutated,
  pinned by test); `=value` form still rejected by the value-flag grammar.
- **Guard ordering in main()**: prefix guard → base-URL guard → env write-back →
  client construction — every refusal fires before any client/network exists.
