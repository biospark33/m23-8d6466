# PR #150 round-7 remediation — fixer B (approvers)

Files owned: `src/fleet/approvers.ts`, `tests/fleet/approvers.test.ts`. No other files touched. Nothing committed.

## Verdict table

| # | Sev | Finding | Verdict | Evidence |
|---|-----|---------|---------|----------|
| 3 | MEDIUM | `enrolApprover` read-modify-write race silently drops concurrent enrolment (no lock) | **FIXED** | Local sync lock `acquireAllowlistLock` (`src/fleet/approvers.ts:466-548`), pid-fenced file-lock pattern after `approval-gate.ts`'s `withApprovalLock`; enrol body re-reads the allowlist inside the lock and merges onto the fresh base. Concurrency regression test: 4 child processes race into an absent allowlist — all 4 survive and authenticate (`tests/fleet/approvers.test.ts`, "two CONCURRENT enrolments both survive"). Race proof: same 4-child race against a stub copy with the lock removed → 4× `ok:true`, only 2 entries on disk (bob, dave silently lost). |
| 4a | MEDIUM | scrypt N/r bounded independently → `128·N·r` ≈ 4 GiB verify allocation | **FIXED** | Product refine on `V2EntrySchema`: `128 * N * r <= SCRYPT_ALLOC_CEILING_BYTES` (new export, 1 GiB, `src/fleet/approvers.ts:113`); minted defaults 32 MiB = 32× under. Tests: N=2^20·r=32 (both fields individually legal) now refuses `approver-allowlist-invalid`; ceiling + defaults headroom pinned. |
| 4b | MEDIUM | `scryptSync` throw escapes untyped → CLI classifies transient/exit-1 instead of fail-closed | **FIXED** | Verify call wrapped in try/catch → typed refusal `approver-entry-unverifiable`, no token material in message/remediation (`src/fleet/approvers.ts:340-356`). Regression test uses a schema-valid-but-unrunnable entry (N=2^16, r=1 → node throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` since N ≥ 2^(16r); empirically confirmed) → asserts typed refusal + token absence. |
| — | LOW (folded) | `enrolApprover("__proto__")` returns ok:true but silently writes nothing | **FIXED** | Refused at enrolment with typed refusal `approver-id-reserved`, before any filesystem write (`src/fleet/approvers.ts:591-603`). Rationale for refusal-over-safe-write (finding allowed either): the entry is unauthenticatable BY CONSTRUCTION — empirically verified that zod v3's `z.record` parse **drops** `__proto__` (and only that key; `constructor`/`toString`/`hasOwnProperty`/`valueOf` survive), so even a `defineProperty` write would mint a token that verifies against nothing. Refusal is the only fix that makes the verb truthful. Regression test asserts refusal code + no file written. |

## Lock design notes (finding 3)

- `withApprovalLock(dir, runId, body)` was evaluated and rejected as the brief anticipated: it is **async** (`await Bun.sleep`) while `enrolApprover` is synchronous end-to-end (making the function async would change the `FleetDeps.enrol` seam), and its path scheme is `<runsDir>/<runId>.approval.lock` gated by `assertExistingRunId` — not a file beside the allowlist. Importing it would also pull `run-record`/`step-log`/`swarmclaw/log` into this leaf module.
- `FleetLock` (`src/fleet/fleet-lock.ts`) rejected: it `mkdir`s/`chmod`s its directory, throws `FleetError` (this module's header explicitly refuses that dependency), and is a single-operator advisory lock with hour-scale staleness — wrong shape for a per-enrolment mutex.
- `RunRecordStore.withLock` not touched (private; DF5.1 deadlock recorded).
- Implemented locally following the approval-gate fencing pattern: `openSync("wx", 0o600)` acquire; holder records `pid:nonce` + own inode via fstat on the creating fd; reclaim ONLY from a provably-dead holder (`kill(pid,0)` → ESRCH, EPERM ≠ dead) past `ALLOWLIST_LOCK_STALE_MS` (2× the 5 s wait timeout), with conditional removal (re-read and delete only the exact bytes judged); release fenced on inode AND content; release failures are stderr diagnostics, never throws (runs in `finally`). Lock path: `<allowlist>.lock`, same dir (guarded by the same ancestor walk — probe runs before acquire so a guard refusal never creates a lock file).
- Timeout → typed refusal `approver-allowlist-locked`; CLI surfaces any enrol refusal as exit 5 generically (`scripts/fleet.ts:2714-2719`), no CLI change needed.

## GitNexus impact

- `impact enrolApprover --direction upstream` → **"Target not found"** (index predates this PR; same for `scryptToken`). `impact authenticateApprover` → LOW risk, 1 direct caller (`authenticateFromStdin`, same module), 0 processes.
- Grep fallback (caller sweep): `enrolApprover` → `scripts/fleet.ts:2713` via `(deps?.enrol ?? enrolApprover)(...)`; `scryptToken` → `mintApproverToken` + `authenticateApprover` (same module) + tests; `authenticateApprover` → `authenticateFromStdin` + tests. **No signature or result-shape changes** — blast radius confined to the two owned files; new refusal codes flow through the CLI's existing generic refusal→exit-5 mapping.

## Behavior-change flags (intentional)

1. `enrolApprover` now creates/removes a transient `<allowlist>.lock` file (0600) in the allowlist's directory for the duration of the enrolment; a wedged lock from a dead holder is auto-reclaimed after 10 s, and a live holder past 5 s yields refusal `approver-allowlist-locked` (new code, exit 5).
2. The guarded read now runs **twice** per enrolment (probe for path validation/refusal surfacing, then re-read inside the lock) — same refusal codes, same precedence.
3. Schema: entries with `128·N·r` > 1 GiB (previously accepted, e.g. N=2^20·r=32) are now refused as `approver-allowlist-invalid`. All shipped/minted entries (32 MiB) are unaffected; the checked-in fixture (N=2^15, r=8) still passes.
4. A `scryptSync` throw during verification is now refusal `approver-entry-unverifiable` (exit 5) instead of an escaping bare `Error` (exit 1). New code.
5. `enrolApprover("__proto__")` now refuses (`approver-id-reserved`) instead of returning `ok:true` for a phantom entry. New code.

## Verification

- `bun test tests/fleet/approvers.test.ts` → **exit 0, 91 pass / 0 fail** (log: `/tmp/qds-fix-b.log`, ANSI/CR-stripped grep for `(fail)`/`^error` empty).
- Negative control: lock stubbed out in a throwaway copy, 4-process race → only 2 of 4 entries survived → the regression test pins the fix, not a vacuous pass.
- `bunx tsc --noEmit` → **0 errors**.
- `bunx biome check src/fleet/approvers.ts tests/fleet/approvers.test.ts` → **clean**.
- Other-cluster suites not run per wave contract (their files are being edited by parallel fixers); `tsc` covers cross-file type integration.
