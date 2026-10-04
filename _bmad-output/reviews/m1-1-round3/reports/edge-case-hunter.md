# Edge Case Hunter — m1-1 round 3 (FINAL gate)

Method: traced code paths only, against /tmp/m1-review-diff-r3.txt plus the landed
collaborators (`scripts/p0-9/leg-lib.ts`, `scripts/p0-9/*.ts`,
`scripts/provision-hindsight-banks.ts`, `src/lib/file-lock.ts`,
`src/hindsight/bank-provisioner.ts`, `src/hindsight/client.ts`,
`scripts/lib/cli-args.ts`). Every regex/URL claim below was executed against the
landed code with `bun -e` before being reported. Findings hunt what the ~47
landed fixes introduced and what survived them.

---

## F-1 — maskTail leaves underscore-compounded credential fields completely unmasked (INV-HM1 breach class)

**HIGH** — `scripts/p0-9/leg-lib.ts:304-345` (`CREDENTIAL_FIELD_WORDS`, `MASK_FIELD_*`, `maskTail`)

Exact unhandled state: R2-014 anchored every field word with `\b…\b`, but `_` is a
word character, so `\b` never fires *inside* an underscore run. Any credential
field name that is a word-char extension of a listed word escapes all rules —
verified live against the landed `maskTail`:

- `X_API_KEY=sk-live-abcdef123` → unchanged (value fully unmasked)
- `access_token=eyJhb.abc.def` → unchanged
- `secret_key=hunter2pass`, `admin_token=root-tok`, `api_token=tok123`,
  `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI`, `private_key=pem-block-data` → unchanged
- query form `?access_token=eyJ.x&next=1` → unchanged
  (`MASK_FIELD_QUERY`'s alternation must match the whole param name after `[?&]`;
  `access_token` is not a listed word)

Concrete failure: `maskTail` output is what lands in closure-dir evidence —
`hindsight-live.ts` stores `rawRetainBody`/`rawRecallBody` as
`maskTail(retain.text)` with **no maxLen** (full body), and every driver stores
masked `bodyTail`/`stderrTail`/`dockerErrTail`. A server response, proxy error,
or docker stderr echoing a credential under any of these extremely common
spellings (`access_token` is *the* OAuth field; `X_API_KEY` a common env name)
lands verbatim in `_bmad-output/evidence/p0-9-closure/`, defeating INV-HM1
("tokens/keys are never logged or recorded") while the doc comment claims
"credential-shaped assignments in ANY field position". The R2-014 test pins
`keyword`/`monkey` survive but never probes an underscore-compounded
credential name, so the suite is green over the gap.

---

## F-2 — CLI stdout envelope contract differs per lane: `banks` strings vs objects, key sets differ, and `buildRerunEnvelope` does not branch on mode

**MEDIUM** — `scripts/provision-hindsight-banks.ts:379-402` (`buildRerunEnvelope`), `:527-573` (rerun gate) vs `:596-604`, `:615-625`, `:627-630` (fresh lanes)

Exact unhandled state: R2-007 normalized only the rerun lane. The three print
sites still emit three different stdout shapes for the "same" command:

- rerun lane: `{ok, banks: string[], requestId, mode, createdInAttempt}`
  (`buildRerunEnvelope` builds `banks: [base, base-dev-meta, qds-collective]`)
- both fresh lanes: `provisionBanks`' `ProvisionResult` verbatim —
  `banks: ProvisionedBank[]` (objects `{bankId, status}`, per
  `src/hindsight/bank-provisioner.ts:70-79`), no `mode`, no `createdInAttempt`
- guard refusals (`bank_prefix_violation`, `base_url_*`, `snapshot_failed`,
  `provision_lock_*`): `{ok:false, requestId, error}` with no `banks`

Concrete failure: any consumer parsing the committed `{ok,banks,requestId}`
contract gets a different `banks` element type and key set depending on whether
the run was a first run or a rerun — the exact JSON-drift class the
single-stdout-envelope rule exists to prevent. Latent second half:
`buildRerunEnvelope` ignores `result.mode` — fed a `resolved-fresh` result
(where `provisionBanks` may have minted `base-2`-suffixed ids under a genuine
foreign collision) it would report the *canonical* roster `[base, …]` as
`banks`, lying about what was minted. Unreachable from today's CLI (the gate at
`:527` guarantees base-present), but it is one refactor away.

---

## F-3 — CLI rerun fork is decided on a pre-lock snapshot; the drivers decide under the lock

**MEDIUM** — `scripts/provision-hindsight-banks.ts:488-509` (snapshot), `:527` (fork), `:529-532` (lock acquired *inside* the branch)

Exact unhandled state: the fresh-vs-rerun classification (`isRerunProvision`)
reads `client.listBanks()` at `:488`/`:499`, but the provision-family lock is
only acquired at `:532`, *after* the fork. `rerunAwareProvision` re-checks the
same stale array (`leg-lib.ts:714+`), so the rerun decision is made on data
that predates lock acquisition. Both drivers do it the other way
(`provision-and-import.ts:585` acquires, then `provisionWindow` snapshots at
`:398`).

Concrete failure: CLI A snapshots base-present; concurrently, driver B (holding
the lock) fails mid-window and its compensation **deletes** the base bank;
B releases; A acquires the lock and PUT-upserts the canonical roster —
recreating exactly the banks B just compensated away, after B's evidence
recorded them `deleted`/residue-empty. State contradicts B's accounting and
A's `mode:"reupsert-existing"` claim. The fresh path is self-correcting
(`provisionBanks` re-snapshots under its own lock); only the rerun lane trusts
stale input — the lock serializes the writes but not the fork's input.

---

## F-4 — CLI rerun lane's lock acquisition is the un-hardened variant of the drivers': age-only steal, no lock-dir mkdir, unguarded release

**MEDIUM** — `scripts/provision-hindsight-banks.ts:529-573`

Three concrete divergences from the drivers' R2-002/R2-020 pattern:

1. **Age-only steal predicate** (`:532` passes `{ staleMs: LEG_LOCK_STALE_MS }`
   with no `holder`): a family member that crashed (SIGKILL — no release, no
   heartbeat, frozen mtime, dead pid) leaves a lock the CLI cannot steal until
   900 s elapse — while every other family member would steal it immediately
   (`provision-and-import.ts:587`, `idempotency-rerun.ts:364`, and the
   provisioner itself use `pid === undefined || isPidDead(pid)`). The refusal
   message — "held by a live holder … retry" — is false for a dead holder, and
   retrying cannot succeed inside the 15-minute window.
2. **No lock-dir mkdir**: the drivers put `mkdirSync(dirname(lockPath),
   {recursive:true})` inside the try (R2-020, `provision-and-import.ts:584`,
   `idempotency-rerun.ts:361`); the CLI does not. Normally masked because a
   prior provision implies `~/.hindsight` exists (provisioner's `acquireLock`
   mkdirs), but a HOME change (sudo/cron), a wiped `~/.hindsight`, or a prior
   provision that ran `noLock` leaves the CLI failing with a raw
   `provision_lock_error … ENOENT` envelope instead of provisioning.
3. **Unguarded `releaseRerun()` in the `finally`** (`:572-573`): the drivers
   wrap release in try/catch and record `warn-taken-over` ("a diagnostic, never
   an outcome"); the CLI does not. If `releaseOwn` throws "taken over while
   held" (`src/lib/file-lock.ts:147-161`), the exception replaces the return
   value, `main()` rejects at the top level, and the envelope already written
   to `process.stdout.write` (async for pipes — see `exitWithFailure`'s own
   rationale in `scripts/lib/cli-args.ts:189-195`) can be truncated or lost —
   a caller gets a crash dump instead of the JSON contract.

---

## F-5 — Driver compensation deletes ANY bank appearing in the post∖pre diff, including non-family probe banks and manual banks

**MEDIUM** — `scripts/p0-9/provision-and-import.ts:441` (`createdInAttempt = post.filter(…)`), `:462-475` (compensation loop); same shape at `scripts/p0-9/idempotency-rerun.ts:233`, `:245-262`

Exact unhandled state: the diff-window lock serializes the *provision family*
(CLI + the two provision drivers), but `hindsight-live` and `auth-retired-check`
create/delete their disposable probe banks (`qds-probe-shape-<ts>`,
`qds-probe-<ts>`) **without taking the provision-family lock**, and nothing
else on the box is excluded. On any leg failure, compensation iterates the raw
post∖pre diff — which contains every bank created during the window by *anyone*
— and deletes each one.

Concrete failure: provision-and-import fails mid-mint while a rerun of
hindsight-live (its AC1 gate only requires that it ran once *before*) is inside
its probe lifecycle; the compensation deletes hindsight-live's live probe bank
mid-probe, degrading that leg's shape evidence; more damaging, a bank an
operator created by hand (or any future non-family tool) during the window is
deleted and recorded as this attempt's `deleted` compensation — attribution
inversion of the exact class AC3's "never a pre-attempt bank" guard exists for.
SPECULATION (likelihood): the runbook presumably serializes legs by hand; the
code path itself is fully traced and unguarded.

---

## F-6 — maskTail's quoted-value rule leaks the tail past a JSON-escaped quote

**LOW** — `scripts/p0-9/leg-lib.ts:308-312` (`quotedValueRule`)

Exact unhandled state: `[^"]*` stops at the `"` of a `\"` escape. Verified:
`"api_key":"ab\"cd"` → `"api_key":"***"cd"` — everything after the escaped
quote leaks. The R2-014 doc pins quoted values "mask whole, to its closing
quote"; a JSON string value containing an escaped quote is partially masked.
Tokens rarely contain quotes, so impact is narrow, but the invariant is
fail-closed in intent.

---

## F-7 — forbiddenOrigin's documented opaque-URL residual is broader than documented: the likeliest trap misspelling passes

**LOW** — `scripts/p0-9/leg-lib.ts:159-190` (URL-first layering, R2-016)

Exact unhandled state (verified): `localhost:8888` and `LOCALHOST:8888` (no
scheme, letter-leading host) parse as an *opaque* URL — scheme `localhost`,
empty port — so layer 1's port-only verdict passes and layer 2's suffix match
never runs (it is gated on `!parsed`). Likewise `http://127.0.0.1:8888.`
(trailing dot makes the port fail URL parsing → unparseable → normalized string
ends `8888.`, not `:8888`) passes both layers. The doc names only
`hindsight-qds:8888` as the residual, but `localhost:8888` is the *most
likely* human misspelling of the :8888 trap.

Concrete failure: no wrong-instance write (fetch rejects non-http schemes —
the documented safety argument holds), but the operator gets a confusing
`snapshot_failed`/502 refusal deep in the run instead of the actionable
`base_url_trap` refusal the guard exists to give, and `sanitizeOrigin` records
the unparseable spellings as `"***"`, hiding even the diagnostic value.

---

## F-8 — The documented mock "dev rehearsal" invocations can never exit 0

**LOW** — `scripts/p0-9/hindsight-live.ts:404`, `:494`; `scripts/p0-9/negative-probes.ts` (same `main()` shape)

Exact unhandled state: R2-003 made the fetch default live-only. `main()`
builds `deps = { baseUrl: env ?? "", mode }` — there is no env path that
injects `fetchImpl` — so `HINDSIGHT_LEG_MODE=mock bun scripts/p0-9/
hindsight-live.ts` always records `skipped-hermetic` health/probe steps,
`healthOk=false`/`probeOk=false`, and exits 1; negative-probes' hermetic mock
likewise always fails (down-probe unproven, mock-client recall "answers").
Both file headers advertise "HINDSIGHT_LEG_MODE=mock for the dev rehearsal".

Concrete failure: an operator following the header runs the rehearsal and gets
a leg failure with evidence in the tmp rehearsal dir — indistinguishable on
stdout-shape from a real leg failure. Only `auth-retired-check` (records, does
not gate) has a green hermetic path. Deliberate fail-closed posture, but the
advertised command is a trap.

---

## F-9 — Dead rerun forks below the first gate silently carry the old unlocked, un-normalized lane

**LOW** — `scripts/provision-hindsight-banks.ts:598`, `:615`

Exact unhandled state: the R2-005 gate at `:527` returns on every rerun (both
topologies), so `isRerunProvision(...)` inside the `--no-bridge-probe` branch
(`:598`) and the shared lane (`:615`) is provably always false. Those two
dormant branches still call `rerunAwareProvision` **without the lock, without
`onStep`, and print its raw result** (the pre-R2-005/R2-007 behavior the review
rounds fixed). Concrete failure: any future reorder (e.g. moving the
`noBridgeProbe` branch above the gate, or early-returning from the gate on a
new condition) silently resurrects the unlocked rerun lane and the
contract-violating envelope — the dead code is the un-fixed version wearing a
comment that claims the discipline lives "in one place".

---

## F-10 — auth-retired: a mixed retain-transport-error + recall-401 outcome retires the write danger

**LOW** — `scripts/p0-9/auth-retired-check.ts:384-402`, `:521`

Exact unhandled state: `authRefused` is satisfied by *either* probe's 401/403
and `answered` requires a 2xx on either — the retain leg of probe (a) can
transport-error (network flake, 10 s abort) while recall refuses 401; then
`class:"refused-auth"` → `dangerRetired:true`, and the containment statement
asserts "the unauthenticated probe was REFUSED for auth reasons … retired on
this instance by live evidence". The danger being retired is specifically the
unauthenticated **write** (retain) answering 200 (file header, probe (a)); the
write leg of the proof never completed. Fail direction is conservative for a
healthy instance but the headline verdict over-claims from a half-measured
probe pair; `measured` likewise counts the pair as measured when only one leg
responded.

---

## F-11 — scanLiveShapePrereq accepts a pass stamp of any age; newer failed runs are ignored

**LOW** — `scripts/p0-9/leg-lib.ts:827+` (`scanLiveShapePrereq`)

Exact unhandled state: the gate scans candidate files newest-first but returns
on the *first* `mode:"live" && ok:true` anywhere in the directory — a stamp
from any past day satisfies it even when a strictly newer failed shape-check
run exists, and there is no binding between the stamp and the currently running
container digest. Concrete failure: shape check passes Monday; the box is
re-pinned/reprovisioned Wednesday; a failed shape check Wednesday records
`mode:"live", ok:false`; the round-trip leg runs Thursday and passes the AC1
ordering gate on Monday's stamp — consuming an instance whose pin was never
shape-verified. R2-001 closed "ran vs passed"; "passed vs passed-recently" is
still open. (Bounding it — e.g. refusing when the newest live stamp is a
failure — is a one-line policy change in the same loop.)

---

### Verified-not-findings (checked, held)

- `acquireHeartbeatLock` interval lifecycle: unref'd, cleared before inner
  release, cleared on taken-over throws; a stolen lock's old heartbeat no-ops
  on the content mismatch, so no cross-holder refresh; the read→utimes TOCTOU
  can only ever bump a *thief's* mtime (fail-safe direction).
- `forbiddenOrigin` adversarial table (IPv6 brackets, leading-zero ports,
  userinfo, padding, path-tail `:8888` false positives) — all behave as the
  R2-016 tests claim; re-verified live.
- `isInsideClosureDir` darwin case-fold: trailing separators normalized by
  `path.resolve`; non-ASCII lowercasing approximates the case-insensitive FS;
  case-variant existing parents resolve through `realpathSync`.
- `safeRepoBase` (52) vs the provisioner's minted id: `resolveRepoBankId`
  always truncates first (`truncateForSuffix`, same MAX_BASE_LEN), so
  `isRerunProvision`/`checkBankPrefix` compare the id that is actually minted,
  including >52-char slugs.
- `acquireHeartbeatLock`'s post-acquire `readFileSync` throw path is caught by
  every caller (CLI → `provision_lock_error`, drivers → `fatal-lock`).
