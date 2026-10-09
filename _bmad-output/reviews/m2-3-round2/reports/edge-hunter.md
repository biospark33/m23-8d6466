# Edge Case Hunter — M2.3 combined memory live round, ROUND 2

Scope: full diff `/tmp/m23-review/full-r2.diff` (~1850 lines), every claim re-verified
against the working tree at `feature/m2-3-combined-memory-live-round`. Primary new
files: `tests/fleet/e2e/memory-combined.live.test.ts` (933 lines),
`scripts/e2e/memory-negative-probes.ts` (451), `tests/scripts/memory-negative-probes.test.ts`
(267), `config/rosters/memory-live.roster.yaml`, plus the round-1 fix seams
(openTraceReader worker_output assertion, git cat-file guard, QDS_LOG_VERBOSE teardown
env, ttl clock evidence, settleRun problems array).

8 findings: 1 BLOCKER, 1 HIGH, 3 MEDIUM, 3 LOW. Every claim below cites diff text and
the repo source it was checked against.

---

## BLOCKER 1 — L1's staged manifest can never pass `loadManifest`: budget arithmetic refused twice over

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:426` (+ `:442`, `:488-491`)
**Severity:** BLOCKER — the round is deterministically refused pre-spend; L1 can never go green.

Diff (manifest body written to `round.workspace/config/rosters/m23-memory.pipeline.json`):

```ts
runBudgetMs: 600_000,
...
maxDurationMs: 240_000,   // the dispatch_task phase (line 442)
retries: 0,
```

and the dispatch verb is fired with NO `--timeout-ms` (line 488-491: only
`--driver/--brief/--dir`).

Repo math — `src/phase-engine/manifest.ts:1022-1027`:

```ts
const attempts = phases.reduce(
  (sum, p) => sum + (p.retries + 1) * (PARSE_FIX_ATTEMPTS + 1) * p.maxDurationMs, 0);
return attempts + phases.length * ROUTING_MARGIN_MS;
```

with `PARSE_FIX_ATTEMPTS = 2` (`src/phase-engine/types.ts:27`) and
`ROUTING_MARGIN_MS = 5_000` (`types.ts:38`):

```
required = 3×1_000 + 3×240_000 + 3×1_000 + 3×5_000 = 741_000 ms
```

Refusal #1 — `manifest.ts:1120-1124`: `required (741_000) > runBudgetMs (600_000)` →
`ManifestError("manifest demands 741000 ms of phase budget but declares runBudgetMs 600000")`,
wrapped by `dispatch.ts:1563-1570` into `exit 2 / "manifest-rejected"`.

Refusal #2 fires even if the first were fixed: `manifest.ts:1126-1129`
(`runBudgetMs > callerBudgetMs`) with `callerBudgetMs = ctx.remaining()`
(`dispatch.ts:1555`) — the dispatch verb's own ceiling, whose default is
600_000 ms (`scripts/fleet.ts:2762` "omit timeoutMs for the 600_000 ms default").
600_000 > remaining(<600_000 once the verb has done any work, and it has: the roster
gate pings models first) → refused again.

The sibling convention proves the intent: `tier2-df212-attribution.live.test.ts:95-96`
spells the exact formula, and `tier2-rig-swarm-mixed.live.test.ts:129-145` reads the
manifest's `runBudgetMs` and passes `--timeout-ms runBudgetMs + BUDGET_HEADROOM_MS`
("runBudgetMs must fit UNDER it with headroom"). This test does neither.

**Why broken:** L1 dies at the loader before the box, key, or bank exists. The failure
is loud (exit 2, pre-spend — good), but the round cannot ever fire, so every AC it
carries is unprovable as written.

**Fix:** raise `runBudgetMs` to ≥ ~750_000 (e.g. 900_000) and pass
`"--timeout-ms", "1_200_000"` (matching the harness `timeoutMs: 1_200_000` already on
line 491) in the dispatch argv, mirroring tier2-rig-swarm-mixed.

---

## HIGH 2 — the roster byte-identity assert is a tautology; it cannot catch the drift it claims to prevent

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:458` (+ the guard at `:383-387`)
**Severity:** HIGH — live-money provenance: the pre-billing gate can validate one roster while the box loads another.

Diff (the assert, line 458):

```ts
// Staged roster ≡ committed fixture (the in-box spec.roster load must
// match the roster this dispatch gate just pre-checked, byte for byte).
expect(sha256Hex(readFileSync(join(rosterDir, "roster.yaml"), "utf8"))).toBe(sha256Hex(readFileSync(fixture, "utf8")));
```

The staged copy was created one line earlier (`:452` region, `copyFileSync(fixture,
join(rosterDir, "roster.yaml"))`) from the SAME `fixture` path — both sides of the
`toBe` read the same working-tree bytes, so the assert is true by construction and can
never fail (short of a mid-line TOCTOU).

The drift that actually matters is **working-tree fixture vs fixture-at-ctx.sha**: the
STAGED roster the gate reads is the working tree's bytes; the IN-BOX load
(`spec.roster` = `config/rosters/memory-live.roster.yaml`) resolves against the pushed
tree at `ctx.sha`. The only guard over that boundary is `:383-387`:

```ts
const atSha = Bun.spawnSync(["git", "cat-file", "-e", `${ctx.sha}:${ROSTER_FIXTURE_REL}`], ...)
if (atSha.exitCode !== 0) { throw ... "does not carry <fixture> — commit + push ..." }
```

`git cat-file -e` checks **existence only**. A fixture edited after the SHA was cut
(uncommitted, or committed after the SHA) sails through both the existence guard and
the tautological assert; gate C pre-bills against the edited roster while the box loads
the stale one. The comment's promise — "keeps the staged gate-read roster and the
in-box-loaded one from drifting" — is not delivered by either check.

**Fix:** compare the working-tree bytes against the SHA's copy, e.g. hash
`git show ${ctx.sha}:${ROSTER_FIXTURE_REL}` output (or `git cat-file blob
${ctx.sha}:${ROSTER_FIXTURE_REL}`) against `sha256Hex(readFileSync(fixture))`, and keep
the existence check as the error leg.

---

## MEDIUM 3 — L2's "divergent" stderr assertion cannot see its data (stream is muted)

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:707-711`
**Severity:** MEDIUM — an assertion that can never fail, presented as the AC7 tamper-alarm check.

Diff:

```ts
// AC7: the store's divergent tamper alarm is LOG-ONLY (link-store) — the
// walk cannot see it, so the re-emit leg asserts the verb's own stream is clean.
expect(reharvest.stderr.includes("divergent")).toBe(false);
evidence.push({ phase: "dedup-after-reharvest", receiptCount: receipts.length, divergentInReharvestStderr: reharvest.stderr.includes("divergent") });
```

The reharvest `runFleet` call (line ~700 region) passes `env = { QDS_RUNS_DIR,
QDS_AUDIT_DB }` — no `QDS_LOG_VERBOSE` — and inherits `NODE_ENV=test` from bun test.
Channel walk:

- The divergent alarm is emitted through the global sink:
  `src/audit/link-store.ts:489-503` (`outcome = "divergent"` → `emitLine`) →
  `link-store.ts:366-374` → `log()` from `src/swarmclaw/log.ts`.
- The fleet CLI installs its stderr (fd-2) sink ONLY when not muted:
  `scripts/fleet.ts:2423` — `if (logSink === BOOT_LOG_SINK && !(process.env.NODE_ENV === "test" && !process.env.QDS_LOG_VERBOSE))`.
- The default sink itself mutes: `src/swarmclaw/log.ts:29-31` (`logMuted()` →
  `NODE_ENV === "test" && !QDS_LOG_VERBOSE` → drop).

So the reharvest child writes **zero** log lines to stderr; `stderr.includes("divergent")`
is false whether or not the alarm fired. The assert is vacuous and the evidence field is
a constant `false`. (The real dedup property IS still covered by `receipts.length === 1`
at line 712 — the walk — but the AC7 sentence "asserts the verb's own stream is clean"
is hollow as written.)

**Fix:** pass `QDS_LOG_VERBOSE: "1"` in the reharvest `runFleet` env — the exact seam
the L3 teardown call already uses (and which Round 1 added for that verb).

---

## MEDIUM 4 — an L1 `listedKeyHashes()` failure leaves an EMPTY baseline → every account key is reported as leaked

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:364` (baseline) + `:872` (consumer)
**Severity:** MEDIUM — misleading red-herring verdict attached to any round whose L1 failed at the baseline step.

Diff (`:364`):

```ts
round.ctx = await preflight("2");
const ctx = round.ctx;
round.hashesBefore = await listedKeyHashes(); // F17 key-delta baseline
```

`listedKeyHashes()` is a live paged OpenRouter call; if it throws here, L1 fails with
`hashesBefore` still the empty `Set` the `round` object initialized. L3's finally then
runs (`:872`):

```ts
keyProblems = await keyLeakProblems(round.hashesBefore, { driver: ctx.driver, store, runIds: [runId] }, evidence);
```

with `ctx !== undefined` (preflight succeeded) but an empty `before`. Harness math —
`tests/fleet/e2e/live-harness.ts:1662`:

```ts
const leaked = [...first.hashes].filter((h) => !before.has(h));
```

Every key on the account — all of them older than the round — classifies as "leaked";
and since `runId` is `""` (the round never reached dispatch), the fallback loop at
`live-harness.ts:1668-1671` skips every revoke, so the verdict upgrades to the loud
"key hashes outlived the run … NO record-backed fallback revoke was available … revoke
by hand" (`:1683`) — operator advice to hand-revoke the account's entire key list
because a listing call timed out once. The real L1 error is also thrown (so the round is
red either way), but the verdict text now names a key catastrophe that never happened.

Same shape for a transient failure between L1's `preflight` and the baseline: the
harness's own docstring rule is "'could not look' is never 'nothing leaked'" — but the
inverse is also being violated: "could not baseline" is here read as "everything after
is new".

**Fix:** record a `baselineArmed` flag (or an `armedAt` in `round`), and skip the
`keyProblems` leg (with an explicit evidence entry "baseline never taken — delta not
renderable") when it is false, instead of feeding `keyLeakProblems` an empty set.

---

## LOW-MEDIUM 5 — the ttl clock-skew evidence fields are dropped from L3's battery evidence

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:889-896`
**Severity:** LOW-MEDIUM — the F-006 evidence the battery exists to carry does not ride the M2.3 leg's evidence.

The battery records the skew pair on the ttl outcome
(`scripts/e2e/memory-negative-probes.ts`, ProbeOutcome docblock: "a lagging gateway
clock shows up here as ttlFiredAtMs - ttlExpiresAtMs still inside the skew window";
mint attaches both fields). The standalone CLI writes the full `outcomes` into its
evidence JSON. L3's in-test mapping flattens them away:

```ts
outcomes: battery.outcomes.map((o) => ({
  phase: ...,
  probe: o.probe,
  refused: o.refused,
  reason: o.reason,
  httpStatus: o.httpStatus,
  latencyMs: o.latencyMs,
})),
```

`ttlExpiresAtMs` / `ttlFiredAtMs` are absent, so the round's AC6 artifact cannot
separate "gateway clock lag" from "real expiry-ladder defect" — the exact purpose the
Round-1 ttl-clock-evidence seam introduced. (If a ttl probe fails in the field, the
operator gets `refused(false), reason null, http …` with no skew figures and must
re-run the CLI leg by hand to recover them.)

**Fix:** spread `ttlExpiresAtMs: o.ttlExpiresAtMs, ttlFiredAtMs: o.ttlFiredAtMs` into
the mapped outcome (absent for non-ttl probes, matching ProbeOutcome's optionality).

---

## LOW 6 — "unparseable" `[kg-recall]` artifact lines are silently invisible in evidence despite the comment claiming otherwise

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:284-285` (+ the evidence push at ~613-640)
**Severity:** LOW.

Diff:

```ts
} catch {
  // a torn line is recorded as unparseable below, never silently dropped
  events.push({ event: "unparseable", line: line.slice(0, 120) });
}
```

The entry is pushed into `events`, but every evidence surface derived from `events`
keys on specific `event` values or fields: `calls` (`event === "kg_recall.call"`),
`refusals` (`startsWith("kg_recall.refused")`), `truncations`
(`"kg_recall.truncated"`), and `hygiene` (`rawControlChars !== true`, which unparseable
entries lack entirely). No evidence field surfaces `{ event: "unparseable", line }` — a
torn extension line is dropped from the AC6 artifact exactly as if it had never been
seen. The comment's "never silently dropped" is true of the in-memory array only.

**Fix:** add `unparseableEvents: events.filter((e) => e.event === "unparseable")`
(count or the capped line samples) to the `memory-live.in-box-recall` evidence entry.

---

## LOW 7 — L1/L2 rethrow the body error BEFORE the evidence-write problems, dropping them from the verdict

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:550-551` and `:729-730`
**Severity:** LOW.

Diff (both legs end with):

```ts
if (failure !== undefined) throw failure;
if (evidenceProblems.length > 0) throw new Error(evidenceProblems.join("; "));
```

If the body failed AND the finally's `writeM23EvidenceQuietly` also failed (disk full,
scrub refusal), the evidence-write problem reaches only the best-effort stderr line
(`writeM23EvidenceQuietly` catches and prints) and is absent from the thrown verdict —
while L3 folds the identical class of problem into `settleRun`'s problems list
(`:909-916` → `problems` → settleRun). The asymmetry matters: a failed round is exactly
the round whose AC6 evidence is most needed, and the verdict says nothing about why it
is missing. (The harness's own F11 rule — never throw from cleanup in a finally — is
honored; this is only about which of two held errors survives.)

**Fix:** on the failure path, append the evidence problems to the rethrown error's
message (the same append shape `settleRun` uses at `live-harness.ts:1732`), or route
both legs' verdicts through `settleRun` like L3 does.

---

## LOW 8 — the git cat-file guard misattributes a locally-absent SHA to a missing fixture

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:383-387`
**Severity:** LOW (diagnostic only; it still fails fast pre-spend).

Diff:

```ts
const atSha = Bun.spawnSync(["git", "cat-file", "-e", `${ctx.sha}:${ROSTER_FIXTURE_REL}`], { cwd: REPO_ROOT, stderr: "pipe" });
if (atSha.exitCode !== 0) {
  throw new Error(`the pinned QDS_EXEDEV_SHA (${ctx.sha}) does not carry ${ROSTER_FIXTURE_REL} — the in-box spec.roster load reads the pushed tree; commit + push the fixture before firing`);
}
```

`git cat-file -e <sha>:<path>` exits 128 for BOTH "path absent in that tree" AND "that
rev does not exist in this repo at all" (e.g. `QDS_EXEDEV_SHA` cut from a remote
commit the local clone has not fetched, or a typo'd/partial SHA). In the second case
the remediation — "commit + push the fixture" — sends the operator to fix the fixture
when the actual problem is the local repo not knowing the SHA (and the subsequent
`scratchClone`/bundle path would fail for the same root cause). Guarding locally is the
right seam (fill's bundle-push is built from this checkout), but the two failures
deserve different messages: run `git cat-file -e ${ctx.sha}` first (or branch on
`rev-parse --verify ${ctx.sha}^{commit}`) and name the unfetched-SHA case separately.

---

## Walked clean (what I checked and found sound)

- **openTraceReader primary seam** (`tests/...:660-689` vs `src/phase-engine/trace/reader.ts:224-268`):
  `readEvents(requestId, cursor)` pages by rowid with `hasMore = rows.length === limit`;
  the cursor advances whenever `hasMore` is true (rows non-empty by definition), an
  empty page has `hasMore false` — the `for(;;)` loop cannot spin. `payload_json` is a
  real column selected via `optionalColumn` and survives the zod `.passthrough()`
  schema (`reader.ts:45-54`); `row.type as string | null` cast is required and correct
  (`TraceEventType` at `types.ts:423-434` does not contain `"worker_output"`, the
  tracer's field is loose `string` at `trace/tracer.ts:530-540`, and the reader's zod
  leaves `type` loose). `trace.db` presence: asserted (`:652`) — note harvest's
  `BOX_RUN_SOURCES` (`src/providers/harvest.ts:230-235`) treats `trace/trace.db` as an
  OPTIONAL tar member (absent sources skipped), so the explicit existsSync assert is
  the required-set; a corrupt db throws out of `ensureDb` on first read (the
  constructor's swallow at `reader.ts:129-135` is re-raised lazily — loud). WAL: the
  harvested `trace.db-wal` replays on the readonly open in the writable artifacts dir
  (reader's crash-case note, `reader.ts:122-128`), so a torn tail is not silent.
- **worker_output payload structure** (`dispatch-task.ts:815-823` →
  `team-event-adapter.ts:223-240`): the traced `payload_json` is the envelope with
  `summary` = boilerplate (`"Worker <agentId> output"`) and `output` = the redacted
  serialized worker output string — so `payloadText = [p.summary, p.output].join("\n")`
  finds the marker via `p.output` ✓ (the seam holds, though note the worker's reply
  rides INSIDE the serialized `output` string, not `summary`).
- **Zero rows / parse failures**: zero `worker_output` rows → `workerOutputCount: 0`
  recorded in evidence before the expect; torn `payload_json` pushed as
  `unparseable-worker-output-payload` and counted — both fail loudly, neither masked.
- **QDS_LOG_VERBOSE teardown env** (`:796-810` region): verified CORRECT end to end —
  `emit` → `deps.log ?? log()` (`src/memgate/schemas.ts:174-183`); run-completion's
  `memgateDeps({ env, ledgerPath })` (`run-completion.ts:311`) injects no log → global
  sink; with `NODE_ENV=test` + `QDS_LOG_VERBOSE=1` the fleet CLI installs its fd-2 sink
  (`fleet.ts:2423-2425`) and `logMuted()` is false; `'"event":"memgate-revoke"'` /
  `'"event":"memgate-verify-revoked"'` are exact JSON substrings of the emitted entries
  (`gateway.ts:227,232`). The skip shape (`memgate-skip`) is asserted null ✓
  (`run-completion.ts:281,292,308`).
- **settleRun problems array** (`live-harness.ts:1711-1743`): signature
  `(failure, problems)` matches both L3 arms; `ctx === undefined` arm omits
  `finalBoxes`/`keyProblems` correctly (both are never populated in that case);
  original failure re-thrown with cleanup appended ✓.
- **Audit ordering asserts** (`:761-777`): `linksForRun` orders by `occurred_at, then
  link_id` (`link-store.ts:130-131`) — a same-millisecond revoke/verify tie still
  preserves insertion order, so `verifyAt > revokeAt > … > destroyAt` via `findIndex`
  is tie-safe. Hop/event literals verified
  (`link-store.ts:87` `"memory-retain-receipt": ["retain"]`; `credentials.ts:1081,1604-1611`
  revoke/verify-revoked with empty detail — no "memgate" string in any row, so the
  `leaked` filter cannot false-positive; `teardown.ts:868` run-box teardown).
  Re-teardown of a closed run is first-close-wins idempotent (`teardown.ts:914-916`),
  so the L3 backstop cannot spurious-fail after a body throw past `bodyTeardownOk`;
  `driver.destroy` is idempotent-tolerant on an absent box (`exedev/driver.ts:1453-1454`).
- **cost-config placement**: `costLedgerOpts(recordsDir)` reads
  `join(dirname(dir), "cost-config.json")` (`scripts/lib/cost-ledger-opts.ts:495-499`) —
  dirname(`<workspace>/runs`) = workspace, exactly where the test writes it (`:369`)
  ✓ (verified precisely because this looked wrong; it isn't).
- **Battery**: `MEMGATE_REFUSAL_REASONS` closed set contains all five
  `EXPECTED_REASONS` (`schemas.ts:69-72`); ttl mints within the backstop ceiling
  (`gateway.ts:87-91`, backstop 86_400_000 at `schemas.ts:26` — 5_000 and 3_600_000
  both legal); `revokeRunMemoryKey` is synchronous returning
  `"revoked" | "already-gone" | "none"` (`gateway.ts:239-248`) matching CleanupRecord;
  frozen-injected-clock ttl loop bounded by wall `capMs`; `fireProbe` classifies
  exactly per the client contract (2xx = answer-not-refusal; non-set code / non-JSON /
  transport = `reason: null`); minted `mgrun-` material never enters the evidence
  payload (only sha digests ride events). The unit suite's node:test `{timeout}`
  options object is native to `node:test` (the vendor file imports `node:test`) and
  bun applies it too — sound.
- **Other seams**: `runFleet` merges `process.env` (`live-harness.ts:646`) so
  `env = {QDS_RUNS_DIR, QDS_AUDIT_DB}` keeps PATH; dispatch ack `state: "ready"`
  (`dispatch.ts:579`); test-local `MINTED_RUN_ID` is byte-identical to dispatch's
  (`dispatch.ts:129`); `emittedRunId` correctly skips the kg-recall seam's own line;
  `primeDispatchBrief` ladder (b) returns the SAME reference with
  `directive: "none"`, row at `recallDir/<uuid>.json` (`kg-context.ts:383, 396-401,
  433-438`) — the LD degrade leg's asserts match the real ladder; `RecallRow` shape and
  `DEFAULT_RECALL_DIR` join for both LD and L1; `resolveBankId` maps the probe slug's
  `/` to `-` so BankIdSchema holds; manifest phase schema (`.strict()`) accepts every
  authored field; roster schema admits `tools: ["read","grep","bash","kg_recall"]`
  (open string list; lead's absent tools → null = unrestricted, with the
  harness_engineering-vs-tools advisory satisfied); `KEY_ENV_FILE = "app/.env"`
  (`credentials.ts:100`) and the DD-16 name filter match `deliverRunKey`'s writer
  shape (`gateway.ts:145`); `link-store` exports used (`openAuditStoreForWalk`,
  `linksForRun`, `AuditLinkRow`, `sha256Hex`) all exist.
