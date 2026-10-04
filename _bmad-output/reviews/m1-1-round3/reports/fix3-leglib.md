# fix3-leglib — round-3 fix wave A, leg-lib scope (FINAL fix wave, m1-1)

Agent: fix3-leglib. Files touched: `scripts/p0-9/leg-lib.ts`, `tests/p0-9/legs.test.ts`
(leg-lib describe block only). No commit made. No driver-block edits.

## R3-001 (HIGH) — maskTail underscore-compounded credential fields

**Fix.** New `CREDENTIAL_FIELD_NAME` class: a field name is a `[_-]`-separated
compound — `(?:[A-Za-z0-9]+[_-])*(?:CORE)(?:[_-][A-Za-z0-9]+)*` where CORE is the
unchanged R2-014 word list (`api_key|apikey|authorization|bearer|credential|key|
password|secret|token`). Leading `\b` retained; the trailing `\b` is gone — it is
what never fired inside `_` runs (`_` is a word char). No trailing anchor is
needed: after the core word the surrounding rules require `["']?\s*[=:]` (or `=`
in the query rule), which a bare-alpha extension (`keyword=`, `keywords`,
`keynote:`) can never supply, and the optional `[_-]suffix` branch greedily eats
`access_` / `_key` / `AWS_SECRET_ACCESS_` style segments. Applied to all four
field rules: `MASK_FIELD_QUERY`, `MASK_FIELD_QUOTED_DQ/SQ`, `MASK_FIELD_UNQUOTED`.

Both directions verified (prototype run against the landed semantics BEFORE
editing, then pinned as tests):

- Masked: `X_API_KEY=…`, `access_token=…`, `secret_key=…`, `admin_token=…`,
  `api_token=…`, `AWS_SECRET_ACCESS_KEY=…`, `private_key=…`, `client-secret=…`
  (hyphen compound), `?access_token=eyJ.x&next=1`,
  `{"AWS_SECRET_ACCESS_KEY":"wJal"}`.
- Still raw (R2-014 guarantee): `keyword=not-a-secret`, `keywords=…`,
  `monkeys=keynote`, `the monkey sees keynote: none`, `?keyword=v`,
  `GET /v1/default/banks 200 in 41ms`, `token=ab cd` → `token=*** cd`.

**Tests.** New test "maskTail: [_-]-compounded credential fields mask in every
position; bare-alpha overmatch stays dead (R3-001)" — hunter's verified inputs
as a table, both directions.

## R3-010 (LOW) — quoted-value rule leaks past JSON-escaped quotes

**Fix.** `quotedValueRule` value class `[^quote]*` →
`(?:\\.|[^quote\\])*` (non-capturing, so replacement strings `$1***$2` are
unchanged). `"api_key":"ab\"cd"` now masks whole to the closing quote;
single-quote rule handles `\'` symmetrically; unclosed quotes still mask to end
of string.

**Tests.** New test "maskTail: a JSON-escaped quote no longer leaks the quoted
value's tail (R3-010)" — dq escape, sq escape, unclosed.

## R3-011 (LOW) — opaque/misspelled trap origins pass both layers

**Fix.** `forbiddenOrigin` layering reworked around an `authoritative` flag:

1. URL layer decides only when the parse yields an AUTHORITY (`url.host !== ""`)
   — port comparison as before (R2-016 semantics intact).
2. Suffix layer now runs for (a) unparseable input (as before) and (b) OPAQUE
   parses — empty host, i.e. letter-leading scheme-less spellings. Verified in
   bun: `localhost:8888` / `LOCALHOST:8888` / `hindsight-qds:8888` all parse as
   scheme + opaque path with host `""`, port `""` — previously "port is empty →
   pass", now refused. This CLOSES the R2-016-documented opaque residual.
3. Suffix layer strips trailing dots before `endsWith`:
   `http://127.0.0.1:8888.` fails port parsing (port `8888.` is not a number) →
   unparseable → normalized used to end `8888.` and slip; now caught. Rationale:
   this layer only ever sees input the URL layer could not decide, so the dot
   tolerance cannot touch parseable origins.

R2-016 freedom preserved and pinned: `http://127.0.0.1:18890/prefix:8888`
parses WITH authority → port-only verdict → still allowed;
`http://127.0.0.1:18890.` (non-trap trailing dot) still passes.

**Residual (documented in-code).** The refusal MESSAGE already preserves the raw
+ normalized spelling, so the operator sees exactly what they typed — chosen over
changing `sanitizeOrigin`'s `***` degradation for unparseable values (INV-HM1
outranks diagnostics; trap-shaped values are now refused before being recorded).
Documented in `forbiddenOrigin`'s doc comment.

**Tests.** New test "forbiddenOrigin: opaque and trailing-dot trap
misspellings are refused (R3-011)" — both ports, both misspelling classes, both
directions.

## R3-014 (LOW) — scanLiveShapePrereq accepts an old pass under a newer failure

**Fix.** Newest-first loop: the FIRST `mode:"live"` entry settles the gate —
`ok:true` passes (returns file), otherwise refuse with a reason naming the
newest failed stamp and the remedy ("Re-run scripts/p0-9/hindsight-live.ts").
Non-live stamps `continue` (never settle); unreadable candidates still keep
scanning (unchanged). Documented residual: no digest binding between stamp and
running container — filename recency is the ceiling.

**Tests.** New test "scanLiveShapePrereq: an older PASS cannot satisfy the gate
once a NEWER live stamp failed (R3-014)" — pass-alone passes; pass → newer
failure refuses (reason /newest/, names the re-run); failure → newest pass
recovers (file pinned). Both orders covered. One existing R2-001-test assertion
updated (same block): the [mock, live-fail] case now takes the newest-failed
refusal, so its `reason` pin moved from /ok:true/ to /newest/ — the fall-through
"none stamped ok:true" message still exists for the mock-only/no-live case.

## R3-009 (LOW) — fresh-lane createdInAttempt includes status:"exists" members

**Fix.** `rerunAwareProvision` fresh lane:
`result.banks.map(b => b.bankId)` → `result.banks.filter(b => b.status ===
"created").map(b => b.bankId)`. Interface doc updated: "Fresh (R3-009): the
status:'created' members of provisionBanks' roster". The rerun lane's
absent-from-pre-snapshot logic is untouched.

**Tests.** Existing R2-011 pin updated in-block: fixture returns the collective
as `status:"exists"`, expectation now `["qds-factory", "qds-factory-dev-meta"]`.
Cross-checked the OTHER consumers before editing: driver-block fixtures
(`makeProvisionClient`'s createBank never 409s → all statuses "created") and the
CLI test file (rerun-lane pins only) — neither depends on the old behavior;
`bun test tests/provision-hindsight-banks.test.ts` re-run green as confirmation
(54 pass).

## Verify (four-pass, all green)

| Gate | Command | Result |
|---|---|---|
| Focal | `bun test tests/p0-9/legs.test.ts -t "leg-lib"` | 20 pass, 0 fail (was 16 pre-wave: +4 tests) |
| Full file | `bun test tests/p0-9/legs.test.ts` | 44 pass, 0 fail, exit 0 — NO driver-block pins broke |
| Types | `bunx tsc --noEmit` | 0 errors |
| Lint | `bunx @biomejs/biome check scripts/p0-9/leg-lib.ts tests/p0-9/legs.test.ts` | clean, exit 0 |
| Cross-check (unsanctioned, report-only) | `bun test tests/provision-hindsight-banks.test.ts` | 54 pass, 0 fail — no cross-file breakage from R3-009 |

Notes: impact() on the four edited symbols returned UNKNOWN/not-found (GitNexus
index has no `scripts/p0-9/` symbols) — blast radius mapped by grep instead:
all six drivers, requireBaseUrl, the CLI, and both test files; semantics verified
against every consumer class above. Regex + URL behavior prototyped live in bun
before editing (opaque-parse host `""` detection, trailing-dot port failure,
21-case mask table).
