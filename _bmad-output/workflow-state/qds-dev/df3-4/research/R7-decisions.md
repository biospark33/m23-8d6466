# R7 — DF3.4 contract decisions: re-provision resume path, and `supersededReportIds` as an ordered array

Branch: `feature/df3-4-approval-gate-attach-steering`. Read-only track; this file is the only output.
All line refs are against the tree as read on 2026-08-28.

---

# QUESTION 1 — Is there actually a re-provisioning resume path?

## VERDICT: The BLOCKER is an OVER-READ. There is no re-provisioning resume path in DF3.4.

The prior track's premise ("a resumed run re-provisioned under the same runId") describes an
operation that (a) DF3.4's story never specifies, (b) no DF3.4-scoped verb performs, and
(c) the DF2.1 store **structurally refuses** once the record is closed. The underlying ledger
property it names is real but is a property of DF2.8, unreachable from DF3.4, and it is a
*collision* (silent no-op), not a *loss of a second box's hours* in any path that exists.

Detail below, then the one residual worth naming (§1.6).

---

## 1(a) Every occurrence of "resume" / "resumed" / "resumption" in the DF3.4 story

Source: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md`

| # | Line | Quote | Classification |
|---|------|-------|----------------|
| 1 | :90 | "`pausing` ⇒ no write and no rebind, the record is left exactly as found (DF5.1 flags `approval-pause-in-progress`; **DF3.4's own resume path is what completes the promotion**)." | **complete-a-pause** — explicitly "completes the promotion", i.e. `pausing` → `awaiting-approval` |
| 2 | :106-107 | "A `pausing` extension found at startup **is resumed by re-running teardown (idempotent under DF2.5), then promoting**; it is **never** decidable while `pausing`, so the evidence-first write opens no approval path around teardown." | **complete-a-pause** — the definition itself: re-run teardown, then promote |
| 3 | :125-126 | "an extension in `pausing` is **not** decidable and **is resumed per AC1 (teardown re-run via `teardownSandbox`, then promoted)**." | **complete-a-pause** — same, restated in AC3 |
| 4 | :200 | "**Resume re-provisions nothing**, so the 24h default survives unchanged." | **complete-a-pause**, and an explicit *negative* statement about provisioning |
| 5 | :281-282 | INV-APPROVE-1: "a run paused for approval **cannot be resumed by any mechanism other than a valid approve decision — no bypass, no auto-resume**… Timeout and reject are terminal aborts, never resumptions." | **neither** — this is "resume the RUN's downstream phases", and the invariant *forbids* it except via approve. Nothing here provisions. |

**Result: 0 of 5 occurrences means "restart a run" or "provision a second box".** Four mean
"complete an interrupted pause"; the fifth (INV-APPROVE-1) forbids resumption outright and is
about downstream phases, not infrastructure. Occurrence #4 (`:200`) is the story stating in
plain text exactly what the prior track asserted the opposite of.

---

## 1(b) `boxHoursEventId` / `ingestBoxHours` — what they key on

**`boxHoursEventId`** — `src/providers/cost-ledger.ts:285-289`, verbatim:

```ts
function boxHoursEventId(runId: string, closedAt: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${runId}|box_hours|box_hours|${closedAt}`);
  return h.digest("hex");
}
```

**Call site** — `src/providers/cost-ledger.ts:1095`:

```ts
const eventId = boxHoursEventId(ctx.runId, record.closedAt);
```

…where `record` is `this.readRunRecord(ctx.runId)` (`:1052`) and the method has already refused an
open record (`:1058-1065`):

```ts
if (record.closedAt === undefined) {
  throw new CostLedgerError(
    "box-hours-record-open",
    `run ${ctx.runId} is not closed — the VM lifetime is not final and the destroy is unconfirmed`,
    …
```

**Insert** — `:1101-1112`, `ON CONFLICT(event_id) DO NOTHING`:

```sql
INSERT INTO cost_events (
  event_id, run_id, repo_slug, issue_id, request_id, role, agent_id,
  kind, invocation_seq, cost_micro_usd, unpriced, created_at
) VALUES (?,?,?,?,?, NULL, NULL, 'box_hours', 0, ?, 0, ?)
ON CONFLICT(event_id) DO NOTHING
```

**Lifetime** is `closedAt − createdAt` (`:1085`, `const lifetimeMs = closed - created;`), both read off
the record — not from any per-box measurement.

### Would a SECOND box under the same runId collide or be lost?

**Yes — in the abstract, it would collide and the second row would be silently dropped.** The key
is `(runId, closedAt)` only, and `closedAt` is frozen by first-close-wins
(`src/providers/run-record.ts:1250-1254`):

```ts
close(runId: string, now: Date = new Date()): RunRecord {
  return this.traced(runId, "close", () =>
    this.withLock(runId, () => {
      const current = this.get(runId);
      if (typeof current.closedAt === "string") return current;
```

So a same-runId second box would produce the identical `event_id`, hit `DO NOTHING`, and price 0
extra µ$. (Worse: even if the id differed, the *lifetime* would still be computed from the single
record's `createdAt`/`closedAt`, so the figure would be wrong regardless of the key.)

**But that path is unreachable.** Provisioning a second box under the same runId requires writing
its handle to the record, and the record is closed by then. `setLocked`
(`src/providers/run-record.ts:1239`) refuses:

```ts
if (closed) throw new Error(`record ${runId} is closed; core key not writable: ${key}`);
```

`vmName`, `httpsUrl`, `ports`, `keyHash` are all core fields (`CORE_FIELDS`, `:58-72`). The
provisioning path writes exactly those through `store.set` and treats a refusal as fatal —
`src/providers/driver.ts:723-733, 735-741`:

```ts
const setRecord = (patch: Parameters<RunRecordStore["set"]>[1], what: string): RunRecord => {
  try {
    return store.set(opts.runId, patch);
  } catch (e) {
    …
    throw new ProvisionRefusedError(
      "record-write-failed",
      `the ${what} for run ${opts.runId} could not be written (${detail}) — box ${vm.name} is live and billing and the record is left OPEN`,
```

So a hypothetical second provision under a closed runId does not silently lose money — it
**refuses loudly at `record-write-failed`**, with the box named and a teardown remediation. The
"silent loss" the BLOCKER describes has no reachable entry point.

---

## 1(c) Is `teardownSandbox` genuinely idempotent on re-run?

**Yes — and by a much shorter argument than a step-by-step walk, because the re-run never reaches
the steps at all.**

`src/providers/teardown.ts:331-350` — the closed-record early return, ahead of every step:

```ts
const rec = getRecord(deps, runId);

// Idempotent re-run: first-close-wins already applied — every step skipped.
if (rec.closedAt !== undefined) {
  for (const step of STEPS) skipStep(ctx, step, "record already closed (first-close-wins)");
  // DF2.8 crash-window fix: if store.close succeeded but the process died before ingestBoxHours ran,
  // a re-run would skip everything and the row would never land. Run the hook here — it's
  // idempotent by eventId, so a repeated close is a no-op.
  if (deps.costLedger) {
    try {
      ingestBoxHoursIfAttributed(deps.costLedger, rec, runId, ctx.requestId);
    …
  return;
}
```

So: **a re-run after a COMPLETED teardown is a total no-op plus one idempotent ledger retry.**
That is the fully-idempotent case and it is unconditional.

The case AC1(c) actually needs is the *interrupted* one — crash between the `pausing` write and
the promote, i.e. teardown died part-way, record still OPEN. Step-by-step, on re-run:

| # | Step | Line | Behaviour on re-run | Idempotent? |
|---|------|------|---------------------|-------------|
| 0 | `stopVisualizer` | :356, :160-212 | Deliberately non-aborting; `isNoSuchBox` ⇒ logged skip (`:185-200`), any other throw ⇒ logged `status:"error"` and teardown **continues** (`:202-211`) | **YES** — cannot fail the re-run |
| — | `probeBundleVerify` | :361-363 | Only runs if `vmName \|\| keyHash`; pure host-side probe in a private `mkdtemp` (`:251-269`), touches nothing | **YES** — read-only |
| 1 | `spend` | :389-402 | `captureSpend` on an already-revoked key. Skipped entirely if `!keyed` (`:390`) | **Depends on DF2.3** — see caveat below |
| 2 | `artifacts` | :407 | Routed through `runBoxStep`; box already gone ⇒ `isNoSuchBox` ⇒ **skip, not abort** (`:141-148`) | **YES** |
| 3 | `harvest` | :411-419 | With `{ noHarvest: true }` (DF3.4's call) it is `skipStep(…, "waived by --no-harvest")` at `:412` — never runs at all | **YES, trivially** |
| 4 | `revoke` | :423-429 | `revokeRunKey`; teardown's own comment at `:421-422`: "`"revoked" \| "already-gone"` both OK" | **YES** |
| 5 | `verify` | :432-438 | `verifyRevoked` — list-authoritative; an already-revoked key verifies as revoked | **YES** |
| 6 | `destroy` | :453-464 | `const destroyTarget = rec.vmName ?? runId;` then `deps.driver.destroy(destroyTarget)`. Comment at `:451-452`: "`destroy` is contractually idempotent, so a run that truly never had a box is a no-op" | **YES** — by the driver port's own contract |
| 7 | `close` | :474-494 | `deps.store.close(runId)` — first-close-wins (`run-record.ts:1250-1254`) returns the existing record unchanged; then the `ingestBoxHours` hook, idempotent by `event_id` | **YES** |

**Caveat, named honestly: step 1 (`spend`) is the one step whose re-run idempotency this track did
not verify inside DF2.3.** `captureSpend` reads usage from the provider key and writes
`spendMicroUsd` into the record. Whether it tolerates a key that was already revoked in the
interrupted attempt is a `credentials.ts` question, not a `teardown.ts` one — **not established
here.** Two mitigations already in the shape: (i) if the interrupted attempt got past `revoke`,
the key is gone and the provider's usage read is the failure mode to check; (ii) the DF3.4 caller
knows the run reached the gate, so `keyHash` is present and the step is not skipped. **Recommend
R5-teardown-creds confirm `captureSpend` re-run behaviour before AC1(c) is called proven.**

Everything else above is proven from the code cited. AC1(c)'s "teardown re-run is idempotent under
DF2.5" holds for steps 0, 2, 3, 4, 5, 6, 7.

---

## 1(d) Does anything in DF3.4's scope provision a box?

**Definitive answer: NO.**

DF3.4's Trigger Surface (story `:165-175`) is exactly: `fleet approve`, `fleet reject`,
`fleet attach`, `fleet status`, and the exported `requestApproval` function. Provisioning lives in
`provisionAdmittedRun` / `createRun` (`src/providers/driver.ts`), reached from `fleet dispatch`
(DF3.1) — a verb DF3.4 neither owns nor calls. The story is explicit that this story ships "the
gate, its CLI, and the transport" and that "the **caller** that fires `requestApproval` on a green
re-verify is **DF5.1's**" (`:56-58`).

What each DF3.4 surface does to infrastructure:

- `requestApproval` — registers the extension, then **destroys**: `teardownSandbox(runId, { noHarvest: true })` + `revokeAndVerify(keyHash)` (story `:97-99`). Strictly destructive.
- `approve` / `reject` — write the extension's terminal state. The box is already gone (INV-APPROVE-6, `:301-308`). Nothing to provision.
- `attach` — `driver.exec` / `driver.copyFile` against an *existing* live box (story `:143-149`), refused outright once state is `pausing`/`awaiting-approval` (AC5, `:139-141`).
- `status` — read + lazy expiry sweep (AC7, `:155-161`).
- the resume path — `teardownSandbox` again, then promote. `teardownSandbox` contains no `driver.create` call anywhere in `src/providers/teardown.ts`.

And the structural backstop from 1(b): even if some future code tried, `store.set` refuses core
writes on a closed record and `provisionAdmittedRun` converts that into a loud
`ProvisionRefusedError`.

---

## 1.6 The one residual worth carrying forward (not a blocker, not DF3.4's)

`boxHoursEventId`'s `(runId, closedAt)` key means the ledger can price **at most one box per
runId, ever**. That is correct for today's architecture (one runId ⇒ one box, enforced by the
closed-record core-write refusal), and DF3.4 does not change it. If a future story ever wants
re-provision-under-same-runId, that story must widen the ledger key — DF3.4 should not, and the
DF3.4 spec should not be amended for it.

Nothing to do in DF3.4. Recording it so it is not rediscovered as a "blocker" a third time.

---

# QUESTION 2 — `supersededReportIds` as a true ordered array

## VERDICT: The `"strings"` FieldKind widening is SAFE AND CORRECT — **conditional on one companion hardening that is mandatory, not optional**: `assertNoSecret` must be taught to walk array elements. Today it returns on the first line for any non-string, so widening `ExtensionEntry` without that change opens an UNSCANNED write path for key material.

Secondary recommendation: **do NOT keep both a singular and a plural field.** Keep the plural array
as the single source of truth on the record, and derive DF5.1's singular
`ApprovalOutcome.supersededReportId` from `ids.at(-1)` at the seam. Details in 2(f).

Third finding: **DF5.3 does NOT consume the rebind history** (2(e)). Full ordered history is a
story-intent requirement, not a downstream-consumer requirement. The user has directed story
intent, so we build it — but nobody downstream breaks if it were singular, and that should be on
the record.

---

## 2(a) The three declarations, verbatim

**`FieldKind`** — `src/providers/run-record.ts:47-48`:

```ts
/** Value shapes the core schema admits. */
export type FieldKind = "string" | "int" | "ports";
```

**`assertKind`** — `src/providers/run-record.ts:570-584` (the `ports` arm the team-lead cited as
:581-583 is the trailing fallthrough):

```ts
function assertKind(key: string, kind: FieldKind, value: unknown): void {
  if (kind === "string") {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return;
  }
  if (kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    return;
  }
  if (!Array.isArray(value) || value.some((p) => typeof p !== "number" || !Number.isInteger(p))) {
    throw new Error(`${key} must be an array of integers`);
  }
}
```

Note the shape: `ports` is the **implicit else**, not an explicit `if (kind === "ports")`. Adding
`"strings"` to the union without restructuring would make a `"strings"` field fall into the
array-of-INTEGERS arm and reject every valid value. **The `ports` arm must be made explicit as part
of this change** — a mechanical detail, but one that a naive union widening gets wrong silently at
the type level and loudly at runtime.

**`ExtensionEntry`** — `src/providers/run-record.ts:115-123`:

```ts
export interface ExtensionEntry {
  schemaVersion: number;
  [field: string]: string | number;
}

export type RunRecordExtensions = Record<string, ExtensionEntry>;

/** Extension fields as a caller supplies them — `schemaVersion` is the store's to stamp. */
export type ExtensionPatch = Record<string, Record<string, string | number>>;
```

`ExtensionPatch` (`:123`) must widen too — it is the type on `RunRecordPatch.extensions` (`:133`),
so without it the caller cannot even pass an array in.

---

## 2(b) `assertNoSecret` — DOES IT WALK ARRAY ELEMENTS TODAY?

**DEFINITIVELY: NO. It returns on line 1 for anything that is not a `string`.**

`src/providers/run-record.ts:528-564`, verbatim:

```ts
function assertNoSecret(key: string, value: unknown): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  // Matched at a token boundary, not just at position 0: a credential can ride
  // inside a URL query (`?token=sk-…`). Anchoring only at the start would miss
  // that, and a bare substring test would trip on `task-runner` containing `sk-`.
  for (const p of SECRET_PREFIXES) {
    if (new RegExp(`(^|[^A-Za-z0-9])${p.replace(/[.*+?^\${}()|[\]\\-]/g, "\\$&")}`).test(v)) {
      throw new Error(`refusing to write key material into the run record: ${key}`);
    }
  }
  if (SHAPE_EXEMPT_PATHS.has(key)) {
    …
    if (v.length > 201) throw new Error(`value exceeds the field's grammar bound: ${key}`);
    return;
  }
  // A URL is a long punctuated token by nature and `httpsUrl`/`prUrl` are
  // first-class fields here, so the shape test does not apply to one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return;
  // The charset must cover base64 and PEM-ish payloads (`/`, `+`, `=`, `.`) —
  // an AWS secret access key and a JWT both carry them, and a charset of only
  // `[A-Za-z0-9_-]` would wave both through while catching nothing but tokens
  // that no issuer mints.
  const mixedClass = /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
  if (v.length >= 40 && mixedClass && /^[A-Za-z0-9+/=_.:-]+$/.test(v)) {
    throw new Error(`refusing to write key material into the run record: ${key}`);
  }
}
```

Line 529 — `if (typeof value !== "string") return;` — is the whole answer. The guard was written
when the only non-string value reaching it was a `ports` number array, where the early return is
correct by construction (integers cannot be tokens). Introduce a **string** array and that same
line becomes a hole: `["sk-live-…"]` passes `assertKind("strings", …)`, reaches `assertNoSecret`,
and is written to disk **entirely unscanned**.

This is not theoretical for this field. `supersededReportIds` is caller-supplied, and the caller
chain is DF5.1 → DF3.4 → the record. INV-APPROVE-7 (story `:309-311`) asserts "the approval
extension never carries key material" and cites `assertNoSecret` as the enforcement. With the
widening and without the hardening, **INV-APPROVE-7 would be asserting an enforcement that no
longer runs on the one field this story adds.**

### Required companion hardening (name it, we WILL do it)

```ts
function assertNoSecret(key: string, value: unknown): void {
  if (Array.isArray(value)) {
    // Every element is scanned under the FIELD's path. A `strings` field is
    // caller-supplied text like any scalar, and the early return below exists
    // for `ports` (integers, which cannot be tokens) — not for text.
    for (const el of value) assertNoSecret(key, el);
    return;
  }
  if (typeof value !== "string") return;
  … // unchanged
}
```

Recursion, not a loop over `.filter(isString)`: a mixed array must still have its strings scanned,
and non-strings hit the existing early return one level down. Two lines, no new concepts, and it
keeps the `ports` behaviour byte-identical (numbers → early return).

**Additional hardening this track recommends (enterprise-correct, cheap):**

1. **Element-count and total-length bounds on `"strings"` fields.** `supersededReportIds` grows by
   one on every rebind and nothing caps it — an unbounded record file, read on every `fleet status`
   and every `list()` sweep. The story caps `proposal` at 8_000 and `reason` at 1_000
   (`:243-245`) but says nothing about this array. Propose a bound in `assertKind`'s `"strings"`
   arm (e.g. ≤ 256 elements) so the refusal is a schema rejection at the write, not a disk
   problem later. A `reverifyId` is a fixed-shape id, so a per-element length bound is free too.
2. **`SHAPE_EXEMPT_PATHS` needs no change.** It is keyed on the extension PATH
   (`extPath(ns, field)`, `:513-515`), and the recursion above passes the same `key` down, so an
   exempt path would exempt every element consistently. `supersededReportIds` should **not** be
   exempt — reverify ids are not long mixed-class blobs and the heuristic must keep running on them.

---

## 2(c) Every read site that assumes an extension value is a scalar

Searched `src/`, `scripts/`, `tests/`. Full enumeration:

### Inside `run-record.ts`

| Site | Line | Assumption | Verdict |
|------|------|-----------|---------|
| `validateExtensions` clone of existing | :608 `const merged: RunRecordExtensions = structuredClone(existing ?? {});` | none — `structuredClone` deep-clones arrays natively | **TOLERATES** |
| `validateExtensions` per-namespace merge | :621 `const entry: ExtensionEntry = { ...(merged[ns] ?? {}), schemaVersion: version };` | shallow spread, field-by-field | **TOLERATES** — but note the merge is **per-field replace, never append**. Writing the array means writing the WHOLE new array. See the race note below. |
| `validateExtensions` READ arm | :644 `entry[field] = value as string \| number;` | cast only; no runtime check on the read path | **TOLERATES TODAY.** An array already on disk round-trips unchanged. The cast is a type lie, fixed by the `ExtensionEntry` widening. |
| `validateExtensions` WRITE arm | :649-651 `assertKind(…); assertNoSecret(…); entry[field] = value as …` | `assertKind` rejects arrays for `"string"` kind; `assertNoSecret` silently skips them | **BREAKS (by design) today; becomes the security hole in 2(b) after widening** |
| `assertWellFormed` | :665-668 — routes `extensions` to `validateExtensions(value, undefined, "read")` and never calls `assertKind` on extension fields | read path is lenient by construction (`:638-645`) | **TOLERATES** |
| `serialize` | :2137-2139 `JSON.stringify(rec, null, 2)` | none | **TOLERATES** — arrays serialize/parse cleanly |
| `readRecord` | :2141-2163 `JSON.parse` → `assertWellFormed` | none | **TOLERATES** |
| `setLocked` extensions branch | :1226-1230 `next.extensions = validateExtensions(value, current.extensions);` | delegates entirely | **TOLERATES** |

**JSON round-trip: safe.** Arrays survive `JSON.stringify`/`JSON.parse` and the read path already
accepts them unchanged (`:644`). No migration concern for existing records — the field is new.

### Outside `run-record.ts`

| Site | Line | Code | Verdict |
|------|------|------|---------|
| `scripts/run-record.ts` `applyExt` | :95-114 | `const m = raw.match(/^([A-Za-z0-9]+)\.([A-Za-z0-9]+)=(.*)$/); … let v: string \| number = value; if (kind === "int") { … v = Number(value); } … extensions[ns] = { ...(extensions[ns] ?? {}), [field]: v };` | **TOLERATES, but CANNOT EXPRESS an array.** `--ext approval.supersededReportIds=x` sends the literal string `"x"`; `assertKind("strings", "x")` then rejects it with a named key. That is fail-closed and acceptable. **Decision needed:** either leave the CLI unable to write this field (recommended — it is machine-written, not operator-written), or add a `"strings"` arm that JSON-parses like the existing `--ports` parser at :85-94. Recommend **leave it**; the refusal is honest and the field has no operator use case. |
| `scripts/run-record.ts` coercion table | :46 | `Object.entries(CORE_FIELDS).filter(([, kind]) => kind !== "string")` | **TOLERATES** — CORE_FIELDS only; no core field becomes `"strings"` |
| `src/reverify/approval.ts` | :194 `const supersededReportId = String(existing?.reportId ?? "");` | reads `reportId` (a scalar), not the array | **TOLERATES** — and this is the seam that must change per 2(f) |
| `src/reverify/approval.ts` write | :195-206, :210-226 | writes `supersededReportId` singular | **BREAKS the new contract, not the code** — must be rewritten to append to the array |
| `src/pr/push.ts` | :258-300 | `const approval = record.extensions?.approval;` then `String(approval.approverId ?? "")`, `String(approval.decidedAt ?? "")`, `String(approval.reportId ?? "")`, `String(approval.headSha ?? "")` | **TOLERATES** — every `String(x)` is on a named SCALAR field. It never touches `supersededReportId(s)` and never iterates the entry. |
| `src/pr/open-pr.ts` | :229-247 | `let existing: ExtensionEntry \| undefined; … existing = record.extensions?.pr; … Number(existing.prNumber ?? 0), String(existing.createdAt ?? "")` | **TOLERATES** — named scalar fields of a different namespace (`pr`). Note it is the one site outside `run-record.ts` importing `ExtensionEntry` (`:23`), so it type-checks against the widened index signature; since it only reads named fields with explicit `String()`/`Number()`, the widened union does not break inference. **Worth a `bun run typecheck` confirmation** — it is the single most likely place for a type error to surface. |
| `src/providers/teardown.ts` | :303-322 | `ingestBoxHoursIfAttributed` — `const budget = rec.extensions?.budget; const { repoSlug, issueId } = budget ?? {}; if (typeof repoSlug !== "string") return false;` | **TOLERATES, and is already array-hardened by accident** — its `typeof !== "string"` guards reject an array as "no attribution". Its own comment (:298-301) says it guards against hand-edited non-primitives. |
| `src/reverify/runner.ts` | :267 | `const repoSlug = record.extensions?.budget?.repoSlug;` | **TOLERATES** — scalar field of another namespace |
| `src/fleet/fanout-primitive.ts` | :880-882 | `if (current.extensions?.fanout !== undefined) return; … store.set(runId, { extensions: { fanout: { fanoutId, arm: String(arm) } } });` | **TOLERATES** — writes scalars only |
| `src/fleet/dispatch.ts` | :2611 | writes an extensions patch (gate namespace) | **TOLERATES** — scalars only |
| `src/fleet/status.ts` | — | *(no call site)* | **grep found no `extensions` reference at all.** DF3.4's AC7 join is genuinely NET-NEW here; there is no existing scalar assumption to break. |

### Tests

No test iterates an `ExtensionEntry` generically. The two that come closest both read named scalars:

- `tests/fleet/dispatch.test.ts:2739` — `const failedAt = String(record.extensions?.gate?.failedAt);` — **TOLERATES**
- `tests/fleet/patterns.test.ts:1639` — `expect(runRec.extensions?.fanout).toEqual({ schemaVersion: 1, fanoutId: res.fanoutId, arm: String(i) })` — **TOLERATES** (whole-entry `toEqual`, different namespace)
- `tests/reverify/approval.test.ts:57,62` and `tests/reverify/runner.test.ts:446,450` — assert on `supersededReportId` **singular**. **THESE BREAK** and are the intended, expected churn of the decision. Both are DF5.1-owned test files; per 2(f) they should be updated to assert the derived singular at the seam, keeping DF5.1's published interface byte-compatible.

**Nothing in `src/` or `scripts/` does `Object.entries` / `Object.values` / a `for…in` over an
`ExtensionEntry`.** That is the class of consumer that would have broken, and it does not exist.

### The one non-type hazard: append is not atomic through `store.set` alone

`validateExtensions` merges **per field, replacing the value** (`:621`, `:651`). There is no
append semantics. So "append the displaced id" is a read-modify-write across two calls
(`store.get` → compute array → `store.set`), and **`RunRecordStore`'s PID lock does not span it** —
`withLock` is private (`:1396`) and `set()` takes it internally, after the caller's read.

The story's AC1(a2) says the rebind happens "under the same per-record lock" (`:80-83`); AC1(a)
more accurately says "the store's public patch API, which takes the per-record PID lock
internally" (`:71`). Those are not the same guarantee, and the second is the true one.

**This is already solved in-tree and DF3.4 should reuse it, not reinvent it:** DF5.1's
`withApprovalLock` (`src/reverify/approval.ts:87-174`) is a separate `<runId>.approval.lock` file
that serializes exactly this read-decide-write. Its own docstring says why
(`src/reverify/approval.ts:43-50`):

```
 * `RunRecordStore.set` is atomic on its own, but the AC6 decision is a
 * read-THEN-write: without this an interleaved pair of green verdicts could
 * both read "no record" and both create one. The store's own lock is private
 * and taken inside `set`, so this is a separate file — taking the store's would
 * deadlock.
```

Without it, two concurrent rebinds each read `[a]`, each write `[a, b]` / `[a, c]`, and one
displaced id is lost — which is precisely the DoD test at story `:345-347` ("no finish with
decision against `reportId` absent from both `reportId` and `supersededReportIds`"). **The array
decision makes this lock load-bearing where the singular field arguably tolerated a lost update.**
Flagging as an implementation requirement, not a blocker.

---

## 2(d) GitNexus impact — blast radius

Run with `repo: QDS-Factory`, `direction: upstream`, `includeTests: true`.

| Symbol | impactedCount | direct (d=1) | risk | processes affected |
|--------|--------------|--------------|------|--------------------|
| `assertNoSecret` | 6 | 2 | **CRITICAL** | `teardownRun`, `run` (scripts/fleet.ts), `requestApproval`, `run` (scripts/run-record.ts), `provisionAdmittedRun`, `reapRuns` |
| `assertKind` | 8 | 3 | **CRITICAL** | same six; earliest_broken_step 2 on four of them |
| `validateExtensions` | 7 | 2 | **CRITICAL** | same six |
| `FieldKind` | — | — | — | type-only; not a call-graph node. Its consumers are enumerable by grep and are exactly: `CORE_FIELDS` (:58), `EXTENSION_NAMESPACES` (:142), `assertKind` (:570) — all inside `run-record.ts`. |
| `ExtensionEntry` | — | — | — | type-only. Grep: `run-record.ts` (:112, :115, :120, :621) and **`src/pr/open-pr.ts:23,229` — the single external importer.** |

**Reading the CRITICAL rating honestly:** it reflects that these three functions sit on the write
path of *every* run record, so anything that changes their *behaviour for existing kinds* is
fleet-wide. The proposed change is **purely additive**: a new union member, a new `assertKind` arm,
a widened index signature, and a new recursion branch in `assertNoSecret` that leaves the
number/`ports` path byte-identical. No existing field changes kind. The two mechanical traps are
(i) the implicit-`ports`-else in `assertKind` (§2(a)) and (ii) `src/pr/open-pr.ts`'s
`ExtensionEntry` import type-checking against the widened signature (§2(c)).

`requestApproval` (`src/reverify/approval.ts`) appears as an affected process on **all three**
symbols with `earliest_broken_step: 2` — i.e. GitNexus already sees the DF5.1 approval seam as
directly downstream of the extension validators. That is the expected and intended blast radius of
this decision.

**Mandatory before merge:** `detect_changes({scope: "compare", base_ref: "dev"})` per CLAUDE.md, and
a full `bun test tests/providers/run-record.test.ts tests/reverify/ tests/pr/` — the three suites
that sit directly on the impacted symbols.

---

## 2(e) Does DF5.3's audit chain actually CONSUME the rebind history?

**NO. Not established anywhere in DF5.3, and its hop table says otherwise.**

`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md:120`, the
approval hop, verbatim:

```
  | 8 | run → approval | approver id, decision, `decidedAt` | DF3.4 |
```

Three fields: `approverId`, the decision (state), `decidedAt`. No `reportId`, no
`supersededReportId(s)`, no rebind history. The neighbouring hop is:

```
  | 7 | run → re-verify | host-side test + gate results that authorized the PR | DF5.1 |
```

— the re-verify link, and it too is about *the* report that authorized the PR, singular.

A grep of the entire DF5.3 story for `superseded`, `rebind`, `reportId`, `reverifyId` and `history`
returns **zero matches**. The only approval-adjacent prose is `:83-85` ("Hop 8 (approval) is …
approval, so an absent approval on a run that has a PR is a broken hop, not an inapplicable one") —
a presence assertion, not a history consumer.

**So DF3.4's own Technical Notes claim at `:206-208`** — "each AC1(a2) rebind appends the displaced
id, so the extension carries its own rebind history **for DF5.3's audit chain**" — **overstates the
downstream requirement.** DF5.3 as written would be satisfied by the singular field, or by no
superseded field at all.

**What this means for the decision:** full ordered history is justified by DF3.4's own story text
(`:83`, `:204`, `:206-208`, and the DoD test at `:345-347`) and by auditability as a first
principle — not by a consumer that would break without it. The user has directed story intent and
"long-term correctness, not cheapest diff", so building the array is the right call and this
finding does not change it. It does mean **nobody downstream is blocked** if the array has to land
in a follow-up, and that should be on the record rather than discovered later.

Note also that the DoD test at story `:345-347` explicitly requires the plural:

> "no finish with decision against `reportId` absent from both `reportId` and `supersededReportIds`."

A singular field cannot satisfy that test after two rebinds. **The story's own DoD is the binding
requirement for the array — not DF5.3.**

---

## 2(f) Would keeping BOTH fields create two sources of truth? — YES. Recommended shape below.

**Keeping both `supersededReportId: "string"` and `supersededReportIds: "strings"` in
`EXTENSION_NAMESPACES.approval` creates a genuine two-sources-of-truth problem**, and the existing
code shows exactly how it goes wrong.

`src/reverify/approval.ts:210-226` — the fresh-request path today has to *explicitly clear* the
singular field, with a five-line comment explaining why:

```ts
        store.set(runId, {
          extensions: {
            approval: {
              state: "awaiting-approval",
              …
              // `set()` deep-merges the namespace field-by-field, so an omitted
              // key retains whatever a prior cycle left there. This is a fresh
              // request, not a rebind — explicitly clear supersededReportId
              // rather than leave a stale value from an earlier rebind visible
              // under this new reportId.
              supersededReportId: "",
            },
          },
        });
```

That hazard **doubles** with two fields: every write path must now keep the scalar and the array
consistent, the deep-merge retains whichever one you forget, and a record where
`supersededReportId === "rv-3"` but `supersededReportIds === ["rv-1","rv-2"]` is unfalsifiable from
the record alone — and it is the *approval audit trail*, the one place a disagreement is worst.

### Recommended clean shape

**On the record: the array only.**

```ts
approval: {
  schemaVersion: 1,
  fields: {
    state: "string",
    proposal: "string",
    reportId: "string",
    headSha: "string",
    bundlePath: "string",        // AC1(a2) — story :84-88, required, re-validated on rebind
    requestId: "string",
    expiresAt: "string",
    requestedAt: "string",
    supersededReportIds: "strings",   // ← replaces supersededReportId
    approverId: "string",
    decidedAt: "string",
    reason: "string",
  },
},
```

**At the DF5.1 seam: derive the singular.** `ApprovalOutcome` (`src/reverify/approval.ts:33-37`)
stays **byte-identical** — no change to the published interface:

```ts
export type ApprovalOutcome =
  | { outcome: "requested" }
  | { outcome: "rebound"; supersededReportId: string }
  | { outcome: "pause-in-progress" }
  | { outcome: "already-decided"; state: string };
```

The adapter derives it instead of storing it. Replacing `:194`:

```ts
// ponytail: the record holds the full ordered history; DF5.1's published
// outcome is the id THIS rebind displaced, which is the one just appended.
const displaced = String(existing?.reportId ?? "");
const priorIds = Array.isArray(existing?.supersededReportIds) ? existing.supersededReportIds : [];
store.set(runId, {
  extensions: {
    approval: {
      state: "awaiting-approval",
      proposal: req.proposal,
      reportId: req.reportId,
      headSha: req.headSha,
      requestedAt,
      supersededReportIds: [...priorIds, displaced],   // ordered oldest-first (story :83)
    },
  },
});
return { outcome: "rebound", supersededReportId: displaced };
```

…and the fresh-request path's explicit-clear becomes `supersededReportIds: []`, which is also the
story's stated registration default (`:206-207`: "`supersededReportIds` defaults to `[]` at
registration").

**Why this is the right shape:**

- One source of truth on disk. No consistency invariant to maintain, no third clear-on-fresh-request trap.
- DF5.1's `ApprovalOutcome` interface is unchanged — the team-lead's byte-compatibility requirement is met **without** a second persisted field.
- The `{ outcome: "rebound", supersededReportId }` value is semantically *"the id this call displaced"*, which is a per-call fact, not a record fact. Deriving it is more correct than storing it.
- `tests/reverify/approval.test.ts:57` (`expect(out).toEqual({ outcome: "rebound", supersededReportId: "rv-1" })`) keeps passing verbatim. Only the record-shape assertions at `:62` and `tests/reverify/runner.test.ts:446,450` need updating — from `ext?.supersededReportId` to `ext?.supersededReportIds`.

**Migration:** none needed. `supersededReportId` is written only by
`src/reverify/approval.ts` (landed for DF5.1); DF3.4 is rewriting that adapter anyway per the
story's own framing (`src/reverify/approval.ts:10-13`: "When DF3.4 lands its own implementation it
replaces the ADAPTER, not the caller"). Any record already carrying the singular field reads back
fine — `validateExtensions`'s read arm (`:638-645`) tolerates unregistered fields inside a
registered namespace — so no record becomes unreadable. Dropping it from the registry only means
no new writes.

---

## 2(g) VERDICT and the required companion hardening, named

**The `"strings"` FieldKind widening is SAFE AND CORRECT, subject to four changes that must land
together in one commit:**

1. **`assertNoSecret` must walk array elements** — REQUIRED, SECURITY. `run-record.ts:529` returns
   for every non-string; without the recursion in §2(b), widening `ExtensionEntry` to admit
   `string[]` creates a path where caller-supplied text is written to a mode-0600 record **entirely
   unscanned by the prefix list and the shape heuristic**, and INV-APPROVE-7 (story `:309-311`)
   becomes a claim about an enforcement that no longer runs on this story's new field. Two lines.
   Non-negotiable.
2. **`assertKind`'s `ports` arm must be made explicit** — REQUIRED, CORRECTNESS. It is currently
   the implicit `else` (`:581-583`). Adding `"strings"` to the union without an explicit
   `if (kind === "ports")` sends every `"strings"` value into the array-of-INTEGERS check, which
   rejects all valid values.
3. **`ExtensionPatch` must widen alongside `ExtensionEntry`** — REQUIRED, PLUMBING.
   `run-record.ts:123` is the type on `RunRecordPatch.extensions` (`:133`); without it the caller
   cannot pass an array in at all.
4. **A bound on `"strings"` element count (and per-element length)** — STRONGLY RECOMMENDED.
   `supersededReportIds` grows one entry per rebind with nothing capping it, and the record is
   re-read on every `fleet status` and every `list()` sweep. The story bounds `proposal` and
   `reason` (`:243-245`) and is silent here. A schema rejection at the write is the right failure.

**Plus two implementation requirements that follow from the decision, not from the store:**

5. **Reuse `withApprovalLock`** (`src/reverify/approval.ts:87-174`) for the read-append-write.
   `store.set`'s PID lock does not span the caller's prior read (§2(c)), and per-field replace has
   no append semantics — two concurrent rebinds lose a displaced id without it, failing the story's
   own DoD test at `:345-347`.
6. **Drop `supersededReportId` singular from `EXTENSION_NAMESPACES`** and derive DF5.1's outcome
   field at the seam (§2(f)). Keeping both is a two-sources-of-truth problem in the approval audit
   trail, and the existing explicit-clear-on-fresh-request comment
   (`src/reverify/approval.ts:218-223`) is the evidence of how that class of bug already bites here
   with only one field.

**Known churn, expected and acceptable:** `tests/reverify/approval.test.ts:62` and
`tests/reverify/runner.test.ts:446,450` assert on the singular record field and must move to the
plural. `tests/reverify/approval.test.ts:57` (the `ApprovalOutcome` assertion) is unchanged.

**Known non-issue:** `scripts/run-record.ts`'s `applyExt` (`:95-114`) cannot express an array and
will fail-closed with a named key. Recommend leaving it that way — the field is machine-written,
and an honest refusal beats a CLI surface nobody needs.

**Verification gate before merge:** `bun run typecheck` (for `src/pr/open-pr.ts:23,229`, the one
external `ExtensionEntry` importer), `bun test tests/providers/run-record.test.ts tests/reverify/
tests/pr/`, and `detect_changes({scope: "compare", base_ref: "dev"})` per CLAUDE.md — all three
touched symbols rate CRITICAL upstream.

---

## Things this track did NOT establish

- **`captureSpend` re-run idempotency (DF2.3).** Teardown steps 0, 2–7 are proven idempotent from
  the code cited; step 1 (`spend`) against an already-revoked key was not traced into
  `src/providers/credentials.ts`. AC1(c)'s resume claim rests on it. Recommend R5-teardown-creds
  confirm.
- **Whether the widened `ExtensionEntry` index signature type-checks cleanly at
  `src/pr/open-pr.ts:229`.** It reads only named scalar fields through explicit `String()`/`Number()`
  so it *should*, but this track did not run `bun run typecheck`.
- **DF3.6's `checkBounds` interaction with the attach path** — out of this track's scope.
