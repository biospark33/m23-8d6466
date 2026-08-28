# R8 — DF3.4 gating checks: captureSpend re-run safety, bundlePath shape

Branch: `feature/df3-4-approval-gate-attach-steering`. READ-ONLY research.
Sources read this round: `src/providers/credentials.ts`, `src/providers/teardown.ts`,
`src/providers/cost-ledger.ts` (ingest block), `src/providers/harvest.ts`,
`src/providers/run-record.ts` (validation + runs-dir block),
`tests/providers/credentials.test.ts`, `tests/providers/cost-ledger.test.ts`.

---

## Q1 — captureSpend re-run idempotency (GATES AC1(c))

### VERDICT: SAFE TO RE-RUN. Double-counting is structurally impossible.

`captureSpend` never touches the cost ledger, and its record write is an
idempotent **overwrite**, not an append. DF3.4 must add **no guard**. Details
below, each clause of the brief answered.

### (a) Signature and body — `src/providers/credentials.ts:401-427`

```ts
export async function captureSpend(deps: CredentialDeps, runId: string): Promise<number> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  const rec = deps.store.get(runId);
  if (!rec.keyHash) return 0; // nothing was ever minted for this run
  ctx.keyHash = rec.keyHash;
  const { entry, truncated } = await timed(ctx, "capture_spend", () =>
    deps.keyApi.getKeyEntry(rec.keyHash as string, MAX_VERIFY_PAGES),
  );
  if (truncated) {
    // Recording 0 here would be an authoritative-looking lie: the run's true
    // spend is unrecoverable after the DELETE, so an unenumerable list is a
    // hard failure, never a zero.
    throw new CredentialLifecycleError(
      "list-unverified",
      `could not enumerate the provider key list to read spend for run ${runId} — refusing to record 0`,
      `re-list by hand with paging: curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  }
  if (entry === null) {
    // The key is absent from a fully-enumerated list (revoked out-of-band): its
    // usage is unobservable, and recording 0 here would be an authoritative-
    // looking lie. Return the last stored spend untouched.
    return rec.spendMicroUsd ?? 0;
  }
  const spendMicroUsd = usdToMicros(entry.usageUsd);
  deps.store.set(runId, { spendMicroUsd });
  return spendMicroUsd;
}
```

Three reads, one conditional write:
- reads `deps.store.get(runId)` for `keyHash` / `spendMicroUsd`;
- reads the **provider** via `deps.keyApi.getKeyEntry(hash, MAX_VERIFY_PAGES)` —
  the authoritative key-list entry, usage in dollars;
- writes `deps.store.set(runId, { spendMicroUsd })` — a **partial record
  merge**, i.e. last-write-wins on one scalar field.

Note the write is reached **only** on the `entry !== null` path.

### (b) Against an ALREADY-REVOKED key: degrades, does not throw

`entry === null` (key absent from a **fully enumerated** list — exactly the
post-revoke state) → returns `rec.spendMicroUsd ?? 0` and **writes nothing**.
That is the second-teardown case verbatim, and it is deliberate: the comment
says recording 0 "would be an authoritative-looking lie".

Pinned by `tests/providers/credentials.test.ts:628-637`:
```ts
  test("captureSpend on a key absent from a fully-enumerated list records nothing, returns last spend", async () => {
    const runId = "df23-absent";
    await makeRun(runId);
    const hash = await mintFor(runId);
    // revoked out-of-band: absent from the list, but the list IS enumerable
    await api.deleteKey(hash);
    const spend = await captureSpend(deps(), runId);
    expect(spend).toBe(0); // nothing was ever stored — no authoritative 0 written
    expect(store.get(runId).spendMicroUsd).toBeUndefined();
  });
```
`expect(store.get(runId).spendMicroUsd).toBeUndefined()` is the exact assertion
AC1(c) needs: a second capture against a revoked key **does not overwrite the
first capture's figure**.

The **one** throwing path is `truncated` — an unenumerable (paging-failed) key
list, refusing to record a false 0. That is a transient provider fault that
throws identically on a FIRST run; it is not a re-run artifact. Fail-closed by
design, pinned at `credentials.test.ts:398`.

There is also a trivial pre-run guard: `if (!rec.keyHash) return 0` — a run that
never minted a key short-circuits before any provider call.

### (c) Ledger double-count — CERTAIN: it cannot happen. captureSpend never writes the ledger.

`captureSpend`'s only write is `deps.store.set` (the RunRecord). It holds no
`CostLedger` reference — `CredentialDeps` is `{ keyApi, driver, store, requestId }`
(teardown.ts:383-384). Confirmed by grep: the only non-test references to
`captureSpend` are `credentials.ts` itself, `teardown.ts:38/400`,
`scripts/cap-hit-demo.ts:30`, and one **comment** in `cost-ledger.ts`.

That comment is the explicit design decision, `src/providers/cost-ledger.ts:1006-1013`:
```
   * The box-hours row: fractional VM lifetime × boxHourRateMicroUsd, in
   * INTEGER µ$ … written at teardown's close step … Never from
   * `captureSpend`: that reads the same token money DF2.7 already priced, and
   * ingesting it would double-count inside the SUM the gate reads.
```

And it is pinned by a test whose NAME is the invariant,
`tests/providers/cost-ledger.test.ts:626-634`:
```ts
  test("the issue SUM equals token rows plus exactly one box row — captureSpend money appears nowhere", () => {
    …
    expect(view.totalMicroUsd).toBe(10_000 + 600_000);
    expect(view.perRole).toEqual({ lead: 10_000, "box-hours": 600_000 });
  });
```

So the money-loss/double-count failure mode the brief is most worried about is
**closed twice over**:
1. captureSpend writes a **scalar field by overwrite**, not an additive row.
   Re-running it with the same provider value is a no-op by value; re-running it
   against a revoked key does not write at all (b).
2. It never reaches the ledger, so it cannot inflate the issue SUM the budget
   gate reads. The ledger's own additive path (`ingestBoxHours`) has separate
   dedupe on `(runId, closedAt)` — **not** DF3.4's concern here, but see the
   carried-over R5D risk below.

### (d) Invocation site — `src/providers/teardown.ts:387-401`

```ts
  // 1. spend — read usage from the live key BEFORE the DELETE makes it
  // unrecoverable (INV-4). captureSpend writes spendMicroUsd itself (DF2.3).
  if (!keyed) {
    skipStep(ctx, "spend", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "spend", async () => {
      if (cred === undefined) {
        throw new TeardownError(
          "provisioning-key-missing",
          `run ${runId} carries a keyHash but deps.keyApi is absent — spend cannot be read before revoke`,
          "run teardown with the provider key API wired (set $OPENROUTER_PROVISIONING_KEY), or revoke the key by hand first",
        );
      }
      await captureSpend(cred, runId);
    });
  }
```

**`runStep`, NOT `runBoxStep` — so it is OUTSIDE the box-gone-skip guard.**
`runBoxStep` (teardown.ts:141-148) is applied only to steps 2 (`artifacts`) and
3 (`harvest`):
```ts
async function runBoxStep(ctx: StepCtx, step: "artifacts" | "harvest", fn: () => Promise<unknown>): Promise<void> {
  try {
    await runStep(ctx, step, fn);
  } catch (e) {
    if (!isNoSuchBox(e)) throw e;
    skipStep(ctx, step, "box already gone — destroyed before this step ran; nothing left to pull");
  }
}
```

That placement is **correct and not a gap**: `captureSpend` makes no box calls
at all (keyApi + store only — teardown.ts:380-381 says so: "captureSpend/
revokeRunKey/verifyRevoked read only keyApi, store and requestId off this —
driver rides along for the interface's shape"). A dead box cannot make step 1
fail, so it has nothing to skip on.

### (e) VERDICT and ownership

**Step 1 is safe to re-run. DF3.4 adds NO guard.** The resume path can call
`teardownSandbox` again unconditionally as far as spend is concerned. Nothing
here belongs to DF2.3/DF2.5 either — there is no defect to hand off.

Two boundary conditions to state in the story rather than code around:
- A re-run against an **unenumerable** key list throws `list-unverified` and
  aborts the resume before revoke. Correct (fail-closed), and identical to
  first-run behavior. The resume is retryable once paging recovers.
- The figure a re-run leaves in the record is the **first successful** capture,
  not a fresher one — because the second pass sees `entry === null`. That is
  the desired semantics (spend is final at revoke), but say so explicitly, since
  "re-running teardown refreshes spend" is the intuitive-but-wrong reading.

**Carried over, NOT re-verified this round and NOT resolved by the above:** the
R5D resume risk in `state.yaml` — a resumed run re-provisioned under the SAME
runId loses its second box's hours because `boxHoursEventId` keys on the frozen
`closedAt`. That is a ledger-side (`ingestBoxHours`) additive-row problem, a
different code path from `captureSpend`, and it remains open. Q1's verdict does
**not** clear it.

---

## Q2 — bundlePath vs assertNoSecret

### VERDICT (a-c): YES, a real bundlePath trips the heuristic — but only on SOME hosts. That host-dependence is the actual danger.

### (a) What the path actually is at runtime

Construction, `src/providers/harvest.ts:435-436`:
```ts
  const runsDir = resolveRunsDir(deps);
  const hostBundle = join(runsDir, `${runId}.bundle`);
```

`resolveRunsDir` local wrapper, `harvest.ts:259-266`, delegates to the store's
exported chain; that chain, `src/providers/run-record.ts:768-773`:
```ts
export function resolveRunsDir(dir?: string): string {
  if (dir !== undefined) return dir;
  const env = process.env.QDS_RUNS_DIR?.trim();
  if (env !== undefined && env !== "") return env;
  return DEFAULT_RUNS_DIR;
}
```
with `export const DEFAULT_RUNS_DIR = ".sandbox/runs";` (`run-record.ts:744`).

**There is no `path.resolve()` anywhere in the chain** — the string is returned
as given. `RunRecordStore` is the same: `this.dir = resolveRunsDir(o.dir)`
(`run-record.ts:805`).

So the answer is **neither, invariably — it is caller-dependent**:
- **Default: RELATIVE** — `.sandbox/runs/<runId>.bundle`.
- **Absolute** whenever `QDS_RUNS_DIR` or an explicit `--dir` / `deps.runsDir` /
  `deps.store.dir` is absolute (e.g. `reaper.ts:592` passes `deps.store.dir`
  straight through). Absolute roots are normal in deployment and in tests using
  `mkdtempSync`.

That variability is exactly what makes the shape test non-deterministic here.

### (b) The predicate, hand-applied to five concrete values

Predicate as it actually executes (`run-record.ts:530-563`): SECRET_PREFIXES
token-boundary scan → `SHAPE_EXEMPT_PATHS` check (with a 201-char ceiling) →
`scheme://` early return → `length >= 40 && mixedClass && /^[A-Za-z0-9+/=_.:-]+$/`.
Executed rather than eyeballed:

| # | Value | len | ≥40 | a-z | A-Z | \d | mixed | charset | RESULT |
|---|-------|-----|-----|-----|-----|----|-------|---------|--------|
| 1 | `.sandbox/runs/df34-a1b2c3.bundle` (default relative, this repo) | 32 | no | ✓ | ✗ | ✓ | **false** | ✓ | passes |
| 2 | `/Users/steve/QDS-Factory/.sandbox/runs/df34-a1b2c3.bundle` (absolute, THIS repo, macOS) | 57 | **yes** | ✓ | ✓ | ✓ | **true** | ✓ | **THROWS** |
| 3 | `/home/ci/qds-factory/.sandbox/runs/df34-a1b2c3.bundle` (absolute, all-lowercase Linux CI) | 53 | yes | ✓ | ✗ | ✓ | **false** | ✓ | passes |
| 4 | `/Users/steve/QDS-Factory/.sandbox/runs/abc.bundle` (absolute uppercase, no digit in runId) | 49 | yes | ✓ | ✓ | ✗ | **false** | ✓ | passes |
| 5 | `.sandbox/runs/ab.bundle` | 23 | no | ✓ | ✗ | ✗ | false | ✓ | passes |

Working, per clause, for the two that matter:

- **#2 THROWS.** Length 57 ≥ 40 ✓. `mixedClass` needs all three: lowercase from
  `sers/steve/…`, **uppercase from `U` in `/Users` and `QDS-F` in the repo name**,
  digits from the runId `df34-a1b2c3`. All three present → true. Charset: the
  path uses only `/`, letters, digits, `.`, `-`, every one of which is inside
  `[A-Za-z0-9+/=_.:-]` → matches. Not a `scheme://` URL. → all four conjuncts
  hold → `throw new Error("refusing to write key material into the run record: extensions.approval.bundlePath")`.
- **#3 passes** for **one reason only**: no uppercase anywhere in
  `/home/ci/qds-factory/.sandbox/runs/df34-a1b2c3.bundle`, so `mixedClass` is
  false. Everything else about it is identical to #2.

**This is the dangerous part.** The difference between #2 and #3 is nothing but
the capitalisation of the host's directory names. A test on an all-lowercase
Linux CI path goes **green**; the same code on this repo's own macOS checkout
(`/Users/…/QDS-Factory/…`) **throws** — after the box exists and after harvest
has already succeeded, since this write happens at approval time. A digit-free
runId (#4) flips it back again. Three independent host/run properties silently
decide whether a write succeeds.

### (c) Confirming the fix — YES, and the precedent applies verbatim

`SHAPE_EXEMPT_PATHS` today (`run-record.ts:496-503`) holds `keyHash` plus
`extPath("budget","repoSlug")` / `extPath("budget","issueId")`. Adding
`extPath("approval","bundlePath")` follows that precedent exactly, and `extPath`
(`run-record.ts:513-515`) is the single spelling both the exempt set and
`validateExtensions` (`:648-650`) use, so it cannot drift.

Two caveats the brief was right to flag, both confirmed:

1. **The 201-char ceiling still applies and is a BORROWED bound.** Its comment
   (`run-record.ts:539-551`) derives 201 from `REPO_SLUG_PATTERN`'s "two
   `[A-Za-z0-9._-]{1,100}` segments" — a slug grammar, with no relationship to a
   filesystem path. For typical values (57 chars in #2) it is generous. But it
   is **not** a natural path bound: macOS `PATH_MAX` is 1024 and Linux's is
   4096, and deep CI workspaces, nested git worktrees, or `mkdtemp` roots can
   plausibly exceed 201. The ceiling is **shared**, so it cannot be raised for
   `bundlePath` without loosening it for `budget.repoSlug` too. If a stored
   absolute path is kept, this is a latent refusal on deep-path hosts. It is a
   second, independent argument for (d) below.
2. **The exemption does NOT protect against the prefix scan.** The
   `SECRET_PREFIXES` loop runs at `:534-538`, **before** the exempt check at
   `:539` — as the brief noted. The match is token-boundary anchored
   (`(^|[^A-Za-z0-9])${p}`), and `/` is a non-alphanumeric, so a path segment
   beginning with a prefix string — a repo or directory literally named
   `sk-something`, `ghp_…`, `xoxb-…` — throws **even when exempt**. Unlikely,
   but it is a real landmine and the exemption is not a blanket pass.

### (d) SHOULD a host-absolute path be in a run record at all? — NO. Recommendation: do not store the path.

Answered independently of (a)-(c), and I'd push back on the field existing:

**1. The value is derivable, so storing it adds a second source of truth.**
`hostBundle` is exactly `join(runsDir, `${runId}.bundle`)` — runId is already in
the record and `runsDir` is host configuration resolved through one exported
chain. Storing it persists a computable value that can go stale the moment
`QDS_RUNS_DIR` or `--dir` moves, at which point the record asserts a path that
does not exist while the real bundle sits elsewhere.

**2. DF2.5 already made this exact decision, deliberately.** `harvest.ts:18-19`:
> "Harvest writes NOTHING to the run record: the bundle's presence at
> `<runsDir>/<run-id>.bundle` is the record, and DF2.1's schema stays closed."

Registering `approval.bundlePath` reverses a stated DF2.5 invariant. That is not
DF3.4's call to make silently — if it is made, it should be recorded as a
deviation against DF2.5, not slipped in as a field addition.

**3. Host layout in an audit artifact is a genuine leak.** DF5.3 puts these
records on an audit chain. `/Users/steve/QDS-Factory/…` discloses the operator's
username and local directory structure, is meaningless on any other host, and is
not reproducible — the opposite of what an audit record should contain.

**4. It is the sole cause of the shape problem.** Every failing case in (b) is
failing on the *host prefix*, never on the run-specific tail. Removing the
prefix removes the exemption, the 201-char question, and the host-dependence in
one move.

**Recommended shape, in preference order:**
- **Best — store nothing; re-derive and `statSync` at rebind.** AC1(a2) asks the
  rebind to *re-validate* the bundle; validation is `existsSync(join(resolveRunsDir(deps.runsDir), `${runId}.bundle`))`,
  which is strictly stronger than comparing a stored string, because it proves
  the file is actually there now. No new field, no exemption, no deviation.
- **If a field is required** (e.g. DF5.3 wants it inert in the artifact): store
  the **basename** `<runId>.bundle` only. It is ~20 chars → under 40 → the shape
  heuristic never fires → **no `SHAPE_EXEMPT_PATHS` entry needed at all**,
  portable across hosts, and leaks nothing. The runsDir stays host config where
  it belongs.
- **Only if the team insists on the absolute path:** then yes,
  `SHAPE_EXEMPT_PATHS.add(extPath("approval","bundlePath"))` per the
  `budget.repoSlug` precedent — and accept the 201-char ceiling and the
  prefix-scan landmine above as known ceilings, documented in the story.

I'd take option 1, and option 2 if DF5.3 turns out to need the name in the
artifact. Neither needs a run-record validation change, which is the lazy and
the correct outcome at once.

---

## Verification status

Executed/quoted directly this round: `credentials.ts:401-427`, `:347-358`,
`teardown.ts:141-148/380-401`, `cost-ledger.ts:1006-1013`,
`cost-ledger.test.ts:626-634`, `credentials.test.ts:398/628-637`,
`harvest.ts:18-19/259-266/435-436`, `run-record.ts:496-563/744-773/805`.
The (b) table was produced by running the predicate, not by reading it.

`bundlePath` confirmed **absent** from the registered `approval` namespace
(`run-record.ts:198-211`); repo-wide grep finds it only as a local variable in
`exedev/fill.ts:184` and test helpers, plus the story text at df3-4:73.
