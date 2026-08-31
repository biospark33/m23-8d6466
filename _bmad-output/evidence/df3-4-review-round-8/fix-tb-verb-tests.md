# fix-tb-verb-tests — T-B (tests/fleet/gate-verbs.test.ts, tests/fleet/cli.test.ts)

Wave 2, PR #150 round 7. All findings verified against source (scripts/fleet.ts,
src/fleet/*) before writing assertions. Final state: **262 pass / 0 fail** across
both files; `bunx tsc --noEmit` clean; `biome check` clean on both.

## MEDs — 8/8 fixed

| # | Finding | Verdict | What was done |
|---|---------|---------|---------------|
| M1 | CC-9 scan has no planted needle | fixed | The "NO log entry carries a token" test now drives a LEAKY auth double returning `{ok, approverId, token: NEEDLE, tokenHash: NEEDLE}`; assertions: no needle, no `"token…":` key shape, `alice` present (proves the sink fired). |
| M2 | approve-no-driver assert-only (:102) | fixed | `authOkNoDriver()` — a Proxy over `ProviderDriver` that throws on ANY primitive get — behind the auth double; plus a registry pin that `approve` declares no `--driver`. |
| M3 | Positive control ignores sink/stderr | fixed | Existing control now also asserts `JSON.stringify(entries)` contains the needle (log channel live). Added a SECOND control: a throwing store read (valid auth, so the deferred pre-auth failure is what reports) proves stderr carries envelope text through `printError`. |
| M4 | reject-no-PR zero negative asserts | fixed | Asserts no `pr` extension namespace, no `prUrl`/`prNumber` on the record (via `not.toHaveProperty`), and neither key on the printed line. |
| M5 | attach no-dir single-path check | fixed | Envelope pinned: names the default path AND `ENOENT` (the read-mode store refusing — stronger than the guessed `--driver` message; measured, see source-defect note 1). Added stray-dir check: chdir to the case tmpdir and assert `<cwd>/.sandbox/runs` was not created. |
| M6 | decision-line agreement unfalsifiable | noted (per instructions) | Limitation comment added at the assertion. Strengthened with a source pin: the decision block must read `outcome: outcome.outcome` and contain NO `outcome: "<literal>"` — so a hardcode on either side turns the static half red. |
| M7 | D2 stdin success path missing | fixed | New out-of-process test: real pipe → real `bun scripts/fleet.ts attach --message -`, `QDS_FAKE_BOXES_DIR`+`QDS_STEERING_ROOT` pointed at the case tmpdir so the REAL driver exec + REAL append script write the inbox; the test plays the engine (writes the ack exactly as `localSteeringInbox.ack` does) and the CLI answers `attach-acked` exit 0; payload compared field-by-field on the parsed inbox line. |
| M8 | no-ack pinned on failed-cat only | fixed | Split into two rows: the common REAL shape (`exitCode: 0, stdout: ""` → clean read → `answered` → `no-ack` with the "IS queued" claim) and the failed-cat shape (`exitCode: 1` → also `no-ack`). The unreachable-from-a-clean-read arms keep their own existing cases. |

## LOWs — 11 fixed, 1 noted

| # | Finding | Verdict | What was done |
|---|---------|---------|---------------|
| L9 | execDriver content-blind | fixed | `execDriver` now records every call; new test: exactly one exec carries stdin, the parsed `AttachLine` carries the full message + runId + messageId, the message appears in NO argv, and the append script carries the `QDS_STEERING_ROOT` expansion clause (the wiring the block installs). |
| L10 | ceiling boundaries | fixed | New: `--reason` at exactly 1000 stored VERBATIM (no ellipsis); `--message` at exactly 4000 chars accepted via a full in-process acked attach (exit 0, empty stderr). |
| L11 | expiry boundary exactly at expiresAt | fixed | New test pins the CLI path: global `Date` subclassed to the exact expiry instant (`nowOf` reads `new Date()`, so `Date.now` stubbing would have missed it — noted in comment); approve at exactly `expiresAt` still DECIDES. |
| L12 | duplicate exit-code-only tests | fixed | approve/reject no-run-id: envelope regex-pinned `^<verb> requires <run-id>$` + no record written. attach unknown-run: `run-not-found` envelope naming the id + empty stdout + no steering inbox created. |
| L13 | truncation pins impl shape | fixed | Contract assertions added (≤ cap, prefix+ellipsis, not `"undefined"`) BEFORE the exact-literal pin, which is retained as the today-shape record. |
| L14 | regex-union drops members | fixed | `literals()` widened to `[a-z0-9_-]+`; new guard pins `declared.size` against the signature's `|`-separator count, so a member the scan can't see fails with counts instead of vanishing. |
| L15 | D7 hard-codes store layout | fixed | Record path derived via `store.path()`; approval-lock suffix derived from the gate source's `join(dir, …)` spelling with an `expect(defined)` guard. |
| L16 | flaky-store copy-paste ×3 | fixed | Extracted `failingStore` / `storeFailingOnNthRead`; the get-is-the-only-seam assumption is now stated ONCE at the helpers (all five sites converted). |
| L17 | `/token/i` fragile | fixed | Narrowed to the leak's KEY shape (`/"token[a-z0-9_]*"\s*:/i`) with a comment distinguishing prose-legitimate "token" from a spread's field name; needle check retained. |
| L18 | subprocess inherits repo .env | fixed | Module-scope `childEnv()` scrubs all `QDS_*` + `QDS_LOG_VERBOSE` + `OPENROUTER_PROVISIONING_KEY` (this repo's `.env` carries a real key — verified); applied to D2, D5, D7, D9 spawns; the M7 test re-adds exactly the two overrides it installs. D7/D9 spawns also get `HOME: host`. |
| L19 | D9 fd leak | fixed | `tokenFd` closed immediately after spawn. |
| L20 | cli.test schemaVersion double | fixed | First AC7 test writes through a REAL store and pins the real stamp (2); the fixture's hand-built 1 is documented as a deliberate recorded difference (comment at `pausedRec`). |

## Deferred (none)

Every finding in the T-B list was either fixed or explicitly noted (M6, per the
lead's instruction not to invent unreachable paths — handled via the source-shape
pin instead).

## Source defects found

1. **(observation, not a bug)** The M5 finding assumed the attach no-dir refusal
   was the `--driver` guard. With a driver injected and no `--dir`, the refusal is
   actually the read-mode `RunRecordStore`'s `assertReadable` ENOENT naming the
   default path — which is BETTER evidence for the test's purpose (the CLI probed
   the default path read-only rather than creating it). The test pins that envelope.
2. **(pre-existing, unrelated to T-B)** `docs`/story note only: the D5 `Date`
   global-patch technique in the new expiry-boundary test relies on `nowOf`'s
   `new Date()` arm; if the gate ever defaults to a monotonic clock the test will
   need `deps.now` injection instead. Comment in the test states this.
3. No product defects were found in scripts/fleet.ts or src/fleet/* while
   strengthening these tests — every strengthened assertion passed against current
   source on the first or second run (the two first-run failures were my own test
   bugs: wrong expected envelope in M5, stderr-muting assumption in M7).

## Files touched

- /Users/steve/QDS-Factory/tests/fleet/gate-verbs.test.ts (+~660 lines net: 8 new tests, helpers, strengthened assertions)
- /Users/steve/QDS-Factory/tests/fleet/cli.test.ts (+~40 lines: schemaVersion reconciliation)

No commits made, per instructions. No src/ or scripts/ edits.
