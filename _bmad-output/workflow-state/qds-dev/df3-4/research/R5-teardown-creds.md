# R5 — Teardown + Credentials surface for DF3.4 (READ-ONLY research)

Branch: `feature/df3-4-approval-gate-attach-steering`. All line refs against working tree
at time of read (2026-08-28).

---

## 0. Headline findings (read these first)

1. **`noHarvest` EXISTS today.** `TeardownOptions` is `src/providers/teardown.ts:93-96`. DF3.4
   adds nothing. DF2.5 owns the line and already shipped it.
2. **The story's call spelling is WRONG.** DF3.4 writes `teardownSandbox(runId, { noHarvest: true })`.
   The real signature is `teardownSandbox(deps: TeardownDeps, runId: string, opts?: TeardownOptions)`
   — deps FIRST. Every call site in the repo passes deps.
3. **STORY-CRITICAL: `revokeAndVerify(keyHash)` as a separate step is REDUNDANT and the story
   contradicts itself about its position.** `teardownSandbox` ALREADY revokes (step 4,
   `revokeRunKey`) and verifies (step 5, `verifyRevoked`) internally, in the mandated order,
   after capturing spend. DF3.4 line 97-98 says teardown THEN `revokeAndVerify`; DF3.4 line
   303-304 says `captureSpend` → `revokeAndVerify` → `teardownSandbox`. Both are wrong about
   the seam. See §3.4 for the failure mode of the redundant call.
4. **Idempotency: PROVEN**, for both the complete-teardown re-run (closed-record fast path) and
   the crash-mid-teardown re-run (every step individually already-done-tolerant). Evidence in §2.
5. **Lock posture for a pause: mark destructive, then clear on success — same as a normal
   teardown.** A pause IS a destructive teardown; nothing about it is "mid-lifecycle" from the
   lock's point of view. See §5.
6. **Cost-ledger hazard: a resumed/re-provisioned run under the same runId loses its second
   box's hours.** `boxHoursEventId` is `sha256(runId|box_hours|box_hours|closedAt)` and
   `close()` is first-close-wins, so `closedAt` is frozen at the pause. See §6.

---

## 1. `teardownSandbox` — signature and options

`src/providers/teardown.ts:284`

```ts
export async function teardownSandbox(deps: TeardownDeps, runId: string, opts: TeardownOptions = {}): Promise<void> {
  const ctx: StepCtx = { requestId: deps.requestId ?? newRequestId(), runId, driver: deps.driver.name };
  try {
    await teardownSteps(deps, runId, opts, ctx);
  } catch (e) {
    throw asTeardownError(e);
  }
}
```

Options type, verbatim (`teardown.ts:93-96`):

```ts
export interface TeardownOptions {
  /** Waive AC3's harvest gate ONLY — never the AC6/INV-5 fail-closed gates. */
  noHarvest?: boolean;
}
```

**`noHarvest` exists TODAY.** It is the only option. DF3.4 adds no field, no signature change,
no DF2.5 edit. The waiver is narrow and explicitly documented as waiving AC3's harvest gate
only — the AC6/INV-5 fail-closed gates (bundle-verify preflight, confirmed destroy, verified
revoke) all still stand under `noHarvest: true`.

Deps type, verbatim (`teardown.ts:75-91`):

```ts
export interface TeardownDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Required iff the record carries keyHash (fail-closed otherwise, code "provisioning-key-missing"). */
  keyApi?: KeyApi;
  /** Propagated from the dispatch that created the run (§5.2). */
  requestId?: string;
  gitCwd?: string;
  gitRunner?: GitRunner;
  runsDir?: string;
  workdir?: string;
  /**
   * DF2.8: when present, the close step prices this run's box hours into the cost ledger
   * (exactly once — the deterministic event_id makes a repeated close a no-op).
   */
  costLedger?: CostLedgerHook;
}
```

Note the `keyApi` contract: **required iff the record carries `keyHash`.** DF3.4's pause path
must build `openRouterKeyApi()` when `rec.keyHash !== undefined`, exactly as
`scripts/sandbox-teardown.ts:243` and `scripts/fleet.ts:2481-2482` do. Omitting it makes step 1
(spend) throw `provisioning-key-missing` with the box alive and the record open — a pause that
leaves a live billing box.

### Existing call sites (all of them)

| Site | Line | opts |
|---|---|---|
| `src/providers/reaper.ts` | 625 | none (`teardownSandbox(teardownDeps, unit.id)`) |
| `src/fleet/fanout-primitive.ts` | 816 | none (loser disposal) |
| `scripts/sandbox-teardown.ts` | 286 | `{ noHarvest: parsed.noHarvest }` |
| `scripts/fleet.ts` | 2559 | `{ noHarvest }` |
| `scripts/cap-hit-demo.ts` | 280, 325, 1035 | demo |

DF3.4 would be the third production `noHarvest: true` call site.

---

## 2. The FIXED ORDER, step by step, and the idempotency proof

`teardownSteps` (`teardown.ts:325-495`). Declared step vocabulary (`teardown.ts:100-111`):

```ts
type TeardownStep = "stopVisualizer" | "spend" | "artifacts" | "harvest" | "revoke" | "verify" | "destroy" | "close";
```

### The order as executed

| # | Step | Lines | Behaviour |
|---|---|---|---|
| pre | `getRecord(deps, runId)` | 331 | Shared classifier: ENOENT → `no-record`, other read failure → `record-read-failed`. Before ANY mutation. |
| pre | **closed-record fast path** | 333-350 | `if (rec.closedAt !== undefined)` → every step logged `skipped` ("record already closed (first-close-wins)"), the DF2.8 `ingestBoxHours` hook retried, `return`. **This is the idempotency spine.** |
| 0 | `stopVisualizer` | 356 | DF4.2, prepended. **Non-aborting by design** (`runVizStopStep`, 160-212): a stop failure is logged and teardown CONTINUES. Deliberate carve-out from fail-closed. |
| pre | `probeBundleVerify` | 361-363 | Runs only `if (rec.vmName !== undefined \|\| rec.keyHash !== undefined)`. Functional git-bundle-verify probe in a private mkdtemp. Aborts `bundle-verify-unavailable`, box untouched. |
| — | `noHarvest` waiver log | 367-377 | Logged to the RUN LOG, `outcome: "waived"`. **Never the record** (INV-5). |
| 1 | **spend** | 389-402 | `captureSpend(cred, runId)`. Skipped when `!keyed`. Throws `provisioning-key-missing` if keyed but `deps.keyApi` absent. |
| 2 | **artifacts** | 407 | `pullArtifacts(deps, runId)` via `runBoxStep` — box-already-gone → skip, not abort. Runs even under `noHarvest`. |
| 3 | **harvest** | 411-419 | `harvestRun(deps, runId, { artifactsOwnedByCaller: true })`. Under `noHarvest` → `skipStep(ctx, "harvest", "waived by --no-harvest")`. A throw aborts BEFORE revoke/destroy (AC3). |
| 4 | **revoke** | 423-429 | `revokeRunKey(cred, runId)`. Skipped when `!keyed \|\| cred === undefined`. |
| 5 | **verify** | 431-438 | `verifyRevoked(cred, runId)`. List-authoritative (INV-5). |
| 6 | **destroy** | 453-464 | `deps.driver.destroy(rec.vmName ?? runId)`. **F6 fallback to runId** — a missing `vmName` is NOT proof no box exists (INV-1 crash window). A throw → `destroy-unconfirmed`, record stays open. Never waived. |
| 7 | **close** | 474-494 | `deps.store.close(runId)`, then DF2.8 `ingestBoxHoursIfAttributed`. LAST. |

The relative order of the six DF2.5 steps (spend → artifacts → harvest → revoke → verify →
destroy → close) is the contract; steps may be inserted, never reordered (teardown.ts:9-14 and
DF2.5 Technical Notes, quoted §8).

### Idempotency verdict: **IDEMPOTENT — proven from source, two distinct paths**

**Path A — teardown COMPLETED, record closed.** `teardown.ts:333-350`:

```ts
  // Idempotent re-run: first-close-wins already applied — every step skipped.
  if (rec.closedAt !== undefined) {
    for (const step of STEPS) skipStep(ctx, step, "record already closed (first-close-wins)");
    // DF2.8 crash-window fix: if store.close succeeded but the process died before ingestBoxHours ran,
    // a re-run would skip everything and the row would never land. Run the hook here — it's
    // idempotent by eventId, so a repeated close is a no-op.
    if (deps.costLedger) { ... ingestBoxHoursIfAttributed(...) ... }
    return;
  }
```

Backed by `RunRecordStore.close` first-close-wins (`run-record.ts:1249-1258`):

```ts
  /** First-close-wins: a second close succeeds and keeps the original `closedAt`. */
  close(runId: string, now: Date = new Date()): RunRecord {
    return this.traced(runId, "close", () =>
      this.withLock(runId, () => {
        const current = this.get(runId);
        if (typeof current.closedAt === "string") return current;
        ...
```

**Path B — teardown CRASHED mid-sequence, record still OPEN.** Every step is individually
already-done tolerant:

- *spend* — `captureSpend` (`credentials.ts:419-424`): a key absent from a fully-enumerated list
  returns `rec.spendMicroUsd ?? 0` **without overwriting** the stored figure. The already-captured
  number survives.
- *artifacts / harvest* — `runBoxStep` (`teardown.ts:141-148`): `isNoSuchBox(e)` → `skipStep`,
  "box already gone — destroyed before this step ran; nothing left to pull".
- *revoke* — `revokeHash` (`credentials.ts:476-478`): `status === 404` → `"already-gone"`, not an
  error. The prefix guard is skipped when `entry` is null (`if (entry && !entry.name.startsWith(...))`).
- *verify* — `verifyHash` (`credentials.ts:510`): absent from the list = pass.
- *destroy* — `driver.destroy` is contractually idempotent; `teardown.ts:450-452` states it
  explicitly ("`destroy` is contractually idempotent, so a run that truly never had a box is a
  no-op and the run still closes").
- *close* — first-close-wins, above.

**Therefore the DF3.4 requirement holds:** a `pausing` extension found at startup IS resumable by
re-running `teardownSandbox(deps, runId, { noHarvest: true })` and then promoting the extension to
`awaiting-approval`. Whether the crash landed before, during, or after the original teardown, the
re-run converges.

### Two idempotency caveats DF3.4 must know

1. **The bundle-verify preflight is NOT waived on a resume.** `teardown.ts:361-363` runs
   `probeBundleVerify` whenever the record carries `vmName` OR `keyHash` — and both survive a
   completed teardown (only `closedAt` is added). BUT the closed-record fast path at line 333
   returns *before* line 361, so a resume after a **completed** teardown never probes. A resume
   after a **partial** teardown does probe, and a host with broken git blocks the resume with
   `bundle-verify-unavailable` even though harvest is waived. Low-probability, real.
2. **`stopVisualizer` runs on every non-closed resume** and is deliberately non-aborting, so it
   cannot wedge a resume.

---

## 3. `revokeAndVerify` — signature, keyHash, failure modes

`src/providers/credentials.ts:447-451`:

```ts
/**
 * Record-free variant for DF2.6's orphan sweep: same DELETE → re-list →
 * assert-absent gate against a hash alone. Writes no record, captures no spend.
 */
export async function revokeAndVerify(deps: CredentialDeps, keyHash: string): Promise<void> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId: null, keyHash };
  await revokeHash(deps, ctx, keyHash);
  await verifyHash(deps, ctx, keyHash);
}
```

Note the doc comment: **"Record-free variant for DF2.6's orphan sweep."** It exists for keys with
no run record behind them. A run that HAS a record uses `revokeRunKey` + `verifyRevoked`, which is
what `teardownSandbox` calls.

### 3.1 What `keyHash` is

The provider-side (OpenRouter) **identifier** of the minted key — not credential material. It is
persisted in the plaintext run record (`run-record.ts:62` `keyHash: "string"` in `CORE_FIELDS`,
`:95` `keyHash?: string` on `RunRecord`) and is in `SENSITIVE`-adjacent handling only insofar as
logs carry `keyHashPrefix` (first 8 chars, `credentials.ts:155-157`). Full hashes DO appear in
remediation strings deliberately (`credentials.ts:224-227`: "a keyHash is a non-secret
provider-side identifier … only the plaintext key is credential material").

Charset is validated at mint (`credentials.ts:320`: `/^[A-Za-z0-9_-]+$/`) as an injection guard,
because it flows into copy-paste shell remediations.

### 3.2 Where the run's keyHash lives

`deps.store.get(runId).keyHash`, or through harvest's shared classifier
`getRecord(deps, runId).keyHash`. Both used in-tree:

- `scripts/sandbox-teardown.ts:232, 243` — `const rec: RunRecord = getRecord({ store }, parsed.runId); ... if (rec.keyHash !== undefined) deps.keyApi = openRouterKeyApi();`
- `scripts/fleet.ts:2451, 2481` — same shape.

Set exactly once, by `mintRunKey` (`credentials.ts:314`: `deps.store.set(runId, { keyHash: res.hash })`),
recorded BEFORE the cap is judged so an unrecorded live key can never exist.

### 3.3 Return type and failure modes

Returns `Promise<void>`. Throws `CredentialLifecycleError { code, remediation }`:

| code | Origin | Meaning |
|---|---|---|
| `list-unverified` | `revokeHash` 462-468, `verifyHash` 502-509 | Provider list not enumerable within `MAX_VERIFY_PAGES` (20). The `sbx-` prefix defense cannot run, or revocation is UNVERIFIED. **Fails closed — never treated as absence.** |
| `prefix-refused` | `revokeHash` 469-475 | Named key lacks the `sbx-` prefix. Refuses to DELETE an operator's personal key. |
| `revoke-failed` | `revokeHash` 479-483 | DELETE returned neither 2xx nor 404. "the key may still be live; VM untouched, record left open". |
| `still-listed` | `verifyHash` 511-515 | Key is STILL in the authoritative list after the DELETE — it is LIVE. |
| `transport` | `http()` 641-645 | Network/provider failure after retries. GET/DELETE retry ≤2; POST never retries. |
| `provider-error` / `response-unparseable` | 707-712 / 669-673 | Non-2xx list, or unparseable body. |

Non-failures: `deleteKey` → 404 is `"already-gone"`, and an entry absent from a fully-enumerated
list passes `verifyHash`. **That is what makes a repeat call safe** — see §3.4.

### 3.4 DF3.1's "key-unattributable teardown printed `torn down:` and exited 0"

`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md:1277`.
Fixed in `scripts/fleet.ts:2480-2498`:

```ts
      let keyUnattributable = false;
      if (rec.keyHash !== undefined) {
        tdeps.keyApi = deps?.keyApi ?? asUsage(() => openRouterKeyApi());
      } else if (rec.vmName !== undefined && rec.closedAt === undefined) {
        // Absence of `keyHash` is NOT proof that no key exists. `dispatch`
        // provisions the box first and persists the keyHash after minting, so a
        // crash in between leaves exactly this record: a box that existed, an
        // open run, and no surviving pointer to a key that is still billing.
        // The teardown below is correct for the box and silent about the key,
        // and `torn down:` + exit 0 reads as "nothing left running".
        keyUnattributable = true;
        printError(note, "key-unattributable", ..., { runId: runIdArg });
      }
```

and the exit code is deliberately NOT 0 on that path (`fleet.ts:2593-2599`).

**Consequence for DF3.4:** the pause path must reproduce this guard. A run being paused with
`vmName` set, `closedAt` unset and `keyHash` UNSET is a run whose key may be live and unfindable.
Promoting such a run to `awaiting-approval` and reporting success would say "the box is down and
nothing is spending" — the one thing not true. **The pause must surface `key-unattributable` the
same way, and must not report a clean pause.** This is a DF3.4 AC gap: the story's AC/DoD
(lines 328-335) says nothing about it.

**And the redundant-call failure mode.** If DF3.4 literally calls `revokeAndVerify(cred, keyHash)`
AFTER `teardownSandbox` (story line 97-98), the sequence is:

- `revokeHash` → `getKeyEntry` → key already gone → `entry: null`, `truncated: false` → prefix guard
  skipped (`if (entry && ...)`) → `deleteKey` → **404** → `"already-gone"` → OK
- `verifyHash` → `listAllKeys` → not present → OK

So it *passes* on the happy path — but it adds **two extra provider round trips per pause**, and
it converts any provider list hiccup into a `list-unverified` **hard failure of a pause whose
teardown already fully succeeded**: box destroyed, key revoked and verified, record closed, and
the pause still throws. That is a fail-closed refusal against nothing. **Recommendation: drop the
separate `revokeAndVerify` call; `teardownSandbox` already discharges DF3.4's revoke+verify
obligation in the mandated order.** If the story insists on the literal seam, it needs an
explicit AC saying the second call's `list-unverified` is non-fatal — which contradicts INV-5.

---

## 4. `captureSpend` — signature and ordering

`credentials.ts:401-428`:

```ts
export async function captureSpend(deps: CredentialDeps, runId: string): Promise<number> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  const rec = deps.store.get(runId);
  if (!rec.keyHash) return 0; // nothing was ever minted for this run
  ctx.keyHash = rec.keyHash;
  const { entry, truncated } = await timed(ctx, "capture_spend", () =>
    deps.keyApi.getKeyEntry(rec.keyHash as string, MAX_VERIFY_PAGES),
  );
  if (truncated) { throw new CredentialLifecycleError("list-unverified", ... "refusing to record 0" ...); }
  if (entry === null) { return rec.spendMicroUsd ?? 0; }
  const spendMicroUsd = usdToMicros(entry.usageUsd);
  deps.store.set(runId, { spendMicroUsd });
  return spendMicroUsd;
}
```

**It writes `spendMicroUsd` into the record itself** — teardown adds no second write
(teardown.ts:29-30, a recorded deviation from the DF2.5 story wording).

**Called from teardown at step 1, line 400** — strictly before revoke (step 4, line 427),
verify (step 5, line 436) and destroy (step 6, line 455).

**Ordering the story asserts (DF3.4 line 185: "spend captured, key revoked, box destroyed") is
CONFIRMED**, and it is enforced by `teardownSandbox` itself, not by the caller. DF3.4 gets it for
free by calling teardown; it does not need to call `captureSpend` directly (story line 303 implies
it should — that is the same seam confusion as §0.3).

The rationale is INV-4 (`teardown.ts:387-388`, `credentials.ts:397-399`): after the DELETE the
usage number is unrecoverable.

---

## 5. Run-lock contract and the correct posture for a pause

`scripts/lib/run-lock.ts`. Relevant exports:

```ts
export function acquireRunLock(runsDir: string, runId: string, holder = "invocation"): string   // :929
export function markRunLockDestructive(lock: string): void                                     // :356
export function clearRunLockDestructive(lock: string): void                                    // :370
export function releaseRunLock(lock: string, opts: { force?: boolean } = {}): void             // :1065
```

The DF3.1 round-6 finding, verbatim (`run-lock.ts:1076-1080`):

```ts
  if (moduleState().destructive.has(lock) && opts.force !== true) {
    throw new Error(
      `refusing to release ${lock}: this invocation was interrupted or failed after it began destroying the run, so the lock is deliberately left in place — check the run's box, key and record before anything else touches it, then rm ${lock} once you know the teardown state`,
    );
  }
```

And the reason the mark cannot be inferred (`run-lock.ts:365-369`):

> Called by the CLI on its SUCCESS path only. It is deliberately not something `releaseRunLock`
> can infer: from inside the release, "the caller reached its finally" looks identical whether
> `teardownSandbox` returned or threw, and that is the entire distinction the mark exists to draw.

`{force: true}` is the deliberate operator/caller override for a caller that has judged the state
itself (`run-lock.ts:1074-1075`).

### Correct lock posture for DF3.4's pause

**A pause is a full destructive teardown. Treat it exactly as `fleet teardown` does — nothing
special.** Concretely:

1. `lock = acquireRunLock(store.dir, runId, "<holder name>")` — AFTER the record probe, BEFORE
   any mutation. (`sandbox-teardown.ts:220-226` documents the order: probe the record first so a
   typo'd run id never creates a phantom lock file.)
2. Register the `pausing` extension. **This is inside the lock but BEFORE the mark** — it is a
   pure extension write, nothing destroyed yet; a failure here leaves a clean lock the `finally`
   releases normally.
3. `markRunLockDestructive(lock)` — guarded, and a **failed mark aborts BEFORE teardown**
   (`fleet.ts:2540-2557`). The mark is what makes the destructive window safe to interrupt into.
4. `await teardownSandbox(deps, runId, { noHarvest: true })`.
5. On return (not throw): `clearRunLockDestructive(lock)`.
6. Promote the extension to `awaiting-approval`.
7. `finally`: `releaseRunLock(lock)`, with the F5 "did the work actually land?" check
   (`sandbox-teardown.ts:346-376`, `fleet.ts` twin): if `getRecord(...).closedAt !== undefined`,
   the destroy AND revoke provably ran, so clear the mark and release — the error was the close
   step's leftover, not a half-destroyed run.

**Does the pause need mark/clear? YES.** The story's framing ("DF3.4 pauses a run mid-lifecycle")
is misleading about the lock: from the lock's point of view there is no such thing as a partial
pause. Between step 4's `driver.destroy` and step 7's `store.close` the run is exactly the
half-torn-down state the mark exists to guard. A Ctrl-C there without the mark hands the run to
the next verb with a clean lock.

**Open question for DF3.4 — where does the extension promotion sit relative to step 5?** The
story (line 103-107) requires the `pausing` extension to survive a crash between teardown and
promotion, and to be resumable. That means the promotion (step 6) happens AFTER
`clearRunLockDestructive`, i.e. in the non-destructive tail. If a crash lands between 5 and 6, the
lock releases cleanly, the extension stays `pausing`, and the startup resume re-runs teardown
(closed-record fast path, all steps skipped) then promotes. That converges. **But the resume path
must re-acquire the run lock**, or two resumers race the promotion. The story does not say so.

---

## 6. Cost-ledger interaction at teardown — the double-book / lost-spend hazard

### The mechanism

`teardown.ts:474-494` — the close step calls `deps.store.close(runId)` then
`ingestBoxHoursIfAttributed(deps.costLedger, closedRec, runId, ctx.requestId)`, which requires
`rec.extensions.budget.repoSlug` and `.issueId` to both be **strings** (`teardown.ts:314-315`);
non-string → no row, logged `operation: "teardown.box_hours", outcome: "skipped"`.

`CostLedger.ingestBoxHours` (`cost-ledger.ts:1021+`) prices `closedAt - createdAt` wall-clock ms
× `boxHourRateMicroUsd`, rounded UP, and inserts with
`ON CONFLICT(event_id) DO NOTHING` where:

```ts
function boxHoursEventId(runId: string, closedAt: string): string {   // cost-ledger.ts:285
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${runId}|box_hours|box_hours|${closedAt}`);
  return h.digest("hex");
}
```

It refuses an OPEN record (`box-hours-record-open`, :1046-1052) — teardown never reaches it with
one, by construction.

### Hazard 1 — LOST SPEND on resume-with-a-new-box (real, unaddressed by the story)

`closedAt` is frozen by first-close-wins (`run-record.ts:1249-1258`). `boxHoursEventId` keys on
`(runId, closedAt)`. So if an approved run is later resumed by provisioning a SECOND box under the
**same runId** and torn down again, the second teardown computes the identical `event_id`,
`ON CONFLICT DO NOTHING` fires, and **the second box's hours are silently dropped.** Worse, the
record's `createdAt`/`closedAt` are unchanged, so even the priced figure describes only the first
box's lifetime.

This is not hypothetical for DF3.4: pause → approve → continue is exactly the shape that wants a
second box. Two ways out, and **the story must pick one**:

- **(a) A resumed run is a NEW runId** (new record, new lock, new event_id). Clean; costs the
  approval linkage a pointer field.
- **(b) The approved run never re-provisions under the same runId** (DF3.4 v5.0 scope is pause +
  decide only; continuation is someone else's story). If so, say it explicitly in the story —
  right now nothing forbids (a)'s absence.

**DF3.4 as written says neither.** Flagging as a BLOCKER-class ambiguity.

### Hazard 2 — reservation left open if the ledger is not wired

`costLedgerOpts(store.dir)` (`scripts/lib/cost-ledger-opts.ts:275`) resolves the ledger path and
cost config **from the RECORDS directory**. `sandbox-teardown.ts:244-253` documents the exact bug
that motivated it:

> Constructed with neither, as it was, this CLI fell back to CostLedger's own cwd-relative
> `.sandbox/cost-ledger.db`: `fleet dispatch --dir /srv/runs` reserved in `/srv/cost-ledger.db`
> and `sandbox-teardown --dir /srv/runs <id>` settled the box hours into `./.sandbox/cost-ledger.db`,
> leaving the reservation open forever against the budget cap — and priced them off
> `DEFAULT_COST_CONFIG` rather than the operator's `cost-config.json`.

**DF3.4's pause MUST construct its CostLedger the same way** — `{ ...costLedgerOpts(store.dir),
runsDir: store.dir, readRunRecord: ... }` — and MUST close the handle in a `finally`
(`sandbox-teardown.ts:322-329`). A pause that omits `deps.costLedger` entirely tears the box
down without settling its box hours, leaving the dispatch reservation open against the issue's
budget cap until the orphan-expiry guard collects it.

### Hazard 3 — a close-step ingest throw is NOT a half-destroyed run

`teardown.ts:466-473` states it: the box is already destroyed, the key revoked+verified, the
record closed. Re-running teardown heals it through the closed-record fast path. DF3.4's pause
must therefore adopt the F5 lock-release logic (§5 step 7), or an unconfigured
`boxHourRateMicroUsd` wedges the run's lock on every pause on that host.

---

## 7. How the caller obtains the `vm` handle / box identity

There is **no separate lookup**. Box identity is a field on the run record.

```ts
// run-record.ts:60  CORE_FIELDS
  vmName: "string",
// run-record.ts:93  RunRecord
  vmName?: string;
```

Read via `deps.store.get(runId).vmName`, or through harvest's shared classifier
`getRecord(deps, runId).vmName` (which is what `teardownSteps` does, `teardown.ts:331`).

`teardownSandbox` resolves the destroy target itself and DF3.4 must not second-guess it
(`teardown.ts:445-455`):

```ts
  // F6 (2026-08-24): a missing vmName is NOT proof no box exists. The INV-1
  // crash window (`store.create` → `driver.create` → crash before
  // `store.set(vmName)`) leaves a live, billing box named after the run id
  // with no recorded handle; the old skip let teardown report "torn down"
  // over it (e2e-run-report F6, live-confirmed). Fall back to the run id —
  // `createRun` names the box after it ...
  const destroyTarget = rec.vmName ?? runId;
```

Writes to `vmName` are blocked after close (`run-record.ts:1240`: `if (closed) throw new
Error(...core key not writable...)`), so a paused (= closed) run's box identity is frozen — which
is another argument for Hazard 1 option (a).

---

## 8. DF2.5 story — binding lines on teardown ordering and idempotency

File: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-5-bundle-harvest-teardown.md`

**Ordering (Technical Notes):**

> **Teardown order, fixed:** spend captured → artifacts out → commits harvested → key revoked → box
> destroyed → record closed + key file shredded. Spend must be read before revoke because the number
> is unrecoverable afterwards. A crash between revoke and destroy leaves a dead key and a live box
> (visible, cheap); the reverse leaves a live key nobody can find (invisible, spending) (R4 §3.1).
> **The six steps are a floor, not a closed list — the contract is their relative order.** A later
> story may insert or prepend a step ... without amending this story, provided all six keep their
> relative order. Ordering assertions here are therefore written as **subsequence / relative-order**
> checks over the recorded call order, never equality against a fixed six-element array, so an
> inserted step does not fail a test that is really about ordering.

**Idempotency (Guards/limits, closing clause):**

> ... the untrusted box can otherwise use a hard link or a special entry to affect paths outside the
> extraction directory depending on the extractor; **every step idempotent.**

**Idempotency (Definition of Done, Impl):**

> - [ ] **Impl:** `teardown(runId, {noHarvest})` in the fixed six-step order, every step individually
>       guarded and **idempotent**, printing the next command on any failure

**Fail-closed (INV-5):**

> **INV-5 (fail-closed):** if `git bundle verify` is unavailable, the bundle fails verification, or
> the driver cannot **confirm** box destruction, teardown stops and leaves the record open with the
> failure recorded, so DF2.6's reaper finds it. A run is never marked torn down on an unconfirmed
> destroy, and no failure path silently proceeds to the next step.

**Credential ordering (INV-4):**

> **INV-4 (credential lifecycle ordering):** spend is captured from the live key **before** DF2.3's
> revoke runs, and the key file is shredded only after revocation is verified. Harvest completing is
> a precondition of reaching revoke at all (AC3), so no key is destroyed while work is still only in
> the box.

**Ownership boundary (why DF3.4 must not edit teardown.ts):**

> **`src/providers/teardown.ts` has four claimants and a fixed merge order:** DF2.5 writes it;
> DF4.2 prepends the visualizer stop; DF2.8 adds the `ingestBoxHours` call at close; DF5.3 lands
> last (sprint v5-S3), adding only its single-line `recordAuditLink(...)` emit at the
> already-existing teardown/reap events. Each later claim is additive — no signature change, no
> reordering of the six steps.

**DF3.4 is NOT one of the four claimants.** It must consume `teardownSandbox` as-is. Since
`noHarvest` already exists, that is achievable with zero edits to `teardown.ts` — good.

Note one DF2.5 DoD line that is **already deviated from**, recorded in `teardown.ts:25-31`:
"key file shredded" — no host-side key file exists; destroy IS the shred. DF3.4 inherits that
deviation and should not assert a shred step.

---

## 9. Ambiguities and gaps DF3.4 must resolve (explicit flags)

| # | Flag | Severity |
|---|---|---|
| A | Story spells `teardownSandbox(runId, {...})`; real signature is `(deps, runId, opts)`. | LOW (mechanical) |
| B | Story mandates a separate `revokeAndVerify(keyHash)` call that `teardownSandbox` already performs, and contradicts itself on its position (line 97-98 vs line 303-304). The redundant call converts a provider list hiccup into a hard failure of an already-successful pause. | **HIGH** |
| C | Nothing in the story says what happens to `key-unattributable` runs (box present, no keyHash, record open) at pause. DF3.1 fixed exactly this for `fleet teardown`; the pause path would re-introduce "paused cleanly" over a possibly-live key. | **HIGH** |
| D | Cost ledger: a resumed run re-provisioned under the same runId loses its second box's hours (`boxHoursEventId` keys on frozen `closedAt`). Story does not state whether resume gets a new runId. | **BLOCKER-class** |
| E | Story does not say the pause must wire `costLedger` with `costLedgerOpts(store.dir)`; omitting it strands the dispatch reservation against the issue budget cap. | MEDIUM |
| F | Story does not say the startup resume path must re-acquire the run lock before re-running teardown + promoting. Two resumers race. | MEDIUM |
| G | Story does not say the pause needs `markRunLockDestructive`/`clearRunLockDestructive` + the F5 landed-work release check. Without them a Ctrl-C mid-pause hands a half-torn-down run to the next verb. | MEDIUM |
| H | Pause CLOSES the record (teardown step 7). Extensions stay writable post-close (`run-record.ts:1226-1230`) so the approval namespace still works — but every CORE field (`vmName`, `keyHash`, `spendMicroUsd`) is frozen (`run-record.ts:1240`). The story should state that a paused run's record is closed, since "paused" reads like "open". | MEDIUM |
