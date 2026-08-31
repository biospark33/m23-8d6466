# fix-td-provider-tests — PR #150 round 7, wave 2 (T-D)

Files touched (all under `tests/`, no src edits, no commits):
- `tests/providers/exedev/fixtures/fake-exedev.ts`
- `tests/providers/exedev/driver.test.ts`
- `tests/providers/bounded-exec.test.ts`
- `tests/providers/run-record.test.ts` (built on F4/F5 teammate's current state)
- `tests/reverify/approval.test.ts`
- `tests/reverify/runner.test.ts`

Verification: `bun test tests/providers/ tests/reverify/` → **1008 pass / 0 fail** (31 files; the
2-count delta vs 1010 is the expected-fail canary below). `bunx biome check --write` clean on all
six. `bunx tsc --noEmit` clean.

## HIGH

1. **Provisioning target never asserted (driver.test:131)** — FIXED. Both provisioning tests now
   assert the ssh call's argv[1] is the created box (`steer-prov-1.exe.xyz` / the fallback box),
   not merely that some sudo-shaped call exists. A provision aimed at any other host now fails by
   name.
2. **Interceptor miss shells a sudo line to the host (fake-exedev:469)** — FIXED. Two changes:
   the provision dispatch is anchored on the script's root literal
   (`root="${QDS_STEERING_ROOT:-/run/steering}"`) plus the sudo line (a single-substring match
   could hit unrelated text), and any OTHER sudo-bearing remote command is refused by the fake
   with exit 64 and stderr naming "sudo-bearing command matched no simulated handler
   (provision-script drift?)" — it never falls through to `sh -c` on the host. Covered by a new
   canary test that hand-drives the seam and asserts the refusal + that nothing was created.

## MED

3. **Verification as script text (driver.test:147)** — FIXED. The fake's provision success arm now
   MATERIALIZES the channel it stands for (0700 `run/steering` inside the fake box), and the tests
   assert the outcome: mode 700 on the primary arm, existence on the fallback arm — not just the
   script's text.
4. **Provisioning failure behavioral coverage (:129)** — already present and verified against
   source: the `steeringProvisionFails` arm asserts the typed `steering-channel-unprovisionable`
   error AND the VM-still-listable (INV-5) postcondition (:175-193). Retained unchanged; the
   behavioral additions here are the success-arm outcome assertions (item 3) and the target
   assertions (item 1) on both arms.
5. **bounded-exec `>=` vs `toBe` (:81)** — FIXED. Imports `ACKS_READ_CAP_BYTES` from
   `src/fleet/attach.ts` and asserts `EXEC_MAX_OUTPUT_BYTES >= ACKS_READ_CAP_BYTES` (the stated
   inequality) alongside the existing exact pin, so a one-sided bump fails by name.
6. **Lock test proves the throw, not the fail-closed PROPERTY (approval.test:290)** — FIXED as a
   `test.failing` CANARY; **surfaced a real src defect (see Defects)**. The new test drives the
   same stranded-capture setup and then makes a FOLLOW-UP request, asserting it is refused and the
   stranded capture survives untouched. Against current source the follow-up **succeeds**
   ("requested"), so the property test is pinned as `test.failing`: green today means the defect
   is live; the day the gate refuses, the canary flips red and becomes an ordinary test. No
   assertion weakened; no src edited per instructions.
7. **Rebind history unasserted (:355)** — FIXED. The bundle-gone rebind refusal now also asserts
   `supersededReportIds` stays `[]` — the audit trail does not grow on a refused rebind, and the
   live binding survives (previously only `reportId` was checked).
8. **`approval: undefined` may select the mock (runner.test:473, 495)** — FIXED. Both real-gate
   tests now carry self-verifying selection assertions: the rebind test additionally asserts
   `reportId` moved OFF the first report (a mock-selected port would return the mock's verbatim
   "requested" and leave the record pointing at the first report); the resume test's state/id
   assertions are annotated with why only the real gate can produce them (it moves a record the
   TEST planted from `pausing` to `awaiting-approval` while keeping the bound id; the recording
   port writes nothing).
9. **Harness bundle write rewires all tests (runner.test:79)** — FIXED by scoping note (verified,
   not restructured): the bundle lands under the harness's own per-call mkdtemp
   `<repo.dir>/.sandbox/runs`, so it cannot leak across tests; only tests that deliberately delete
   it narrow themselves. A comment now states that so the next reader does not re-litigate it.

## LOW

10. **Substring dispatch (:469-class)** — FIXED. `startsWith("ls")` → exact `"ls <name> --json"`
    equality at 3 sites; `idxNew` anchored on `ssh exe.dev` + `new --name <id> ` with trailing
    space; `idxProv` anchored on the box host.
11. **Stderr not surfaced (:171)** — FIXED. The timeout test plants a pre-kill marker on stderr and
    asserts the driver returns it (a caller diagnosing a timeout reads evidence, not just a
    status). The `sleep` is redirected so the SIGKILL'd `sh` cannot leave the orphan holding the
    output pipes open — the first draft of this hung the read past the test budget and, at load,
    cascaded a 5s `fill` timeout in the adjacent contract suite; both disappear with the redirect.
12. **Loose ls prefix (:160)** — FIXED (same edits as 10).
13. **`as never` inconsistency (run-record:380)** — FIXED. The non-array case now carries the same
    `as never` cast (plus rationale comment) as its two siblings; the patch type refuses all three
    at compile time, the cast is what lets the runtime rejection be asserted.
14. **Error index [0] (:465)** — FIXED as a comment correction. The "not only the FIRST element"
    case asserted only `/key material/`; the source (`assertNoSecret`) deliberately reports
    elements under the FIELD path with no index, so no message match can pin depth — the mixed
    array itself does that. The comment now says exactly that; the assertion is unchanged because
    there is nothing stronger to assert without changing src.
15. **Shape boundary (:409)** — FIXED. The "NOT shape-exempt" blob was 42 chars; it is now
    boundary-exact 40 (3+35+2, mixed class, in charset) with a length self-check, proving the
    `>= 40` rule on the strings field itself rather than assuming it shares the proposal test's.
16. **Comment outcome claim (approval:62)** — FIXED. The comment claimed the outcome's singular
    `supersededReportId` is "derived from" the history array; the gate derives it from the record's
    prior `reportId` (`approval-gate.ts:987`) and skips appending when already present. The comment
    now states the real derivation; the assertion is unchanged.
17. **Hollow bundle case (:339)** — FIXED. New test: an EMPTY `run-1.bundle` passes the wired guard
    and binds — pinning the guard's contract as existence-not-content (content is harvest's
    invariant) so it cannot drift into content sniffing.

## Source defects found (reported, not edited)

**D-TD-1 (approval gate — lock reclaim leaves the path vacant on restore failure).**
`src/fleet/approval-gate.ts`, reclaim path (~:269-345). When a reclaim captures a LIVE
replacement's lock and the restore `linkSync` fails (non-EEXIST), the code correctly throws
"failed to restore" — but the earlier `renameSync` already moved the replacement's lock to the
claim path and nothing puts anything back at `lockPath`. Verified by a scratch probe against
current source: after the throw, `lockPath` does not exist, the `.claim.*` capture persists, and a
follow-up `requestApproval` acquires immediately and returns `{outcome: "requested"}` — writing
`awaiting-approval` while the replacement holder may still be inside its own critical section.
That is the two-in-the-critical-section shape the gate's own comments name as the cardinal sin;
the throw protects one call's acquire loop, not the lock's invariant. Pinned as the `test.failing`
canary in `tests/reverify/approval.test.ts` ("a follow-up request while the stranded capture
persists is REFUSED"). Suggested fix direction (for the src owner): on restore failure, re-poison
`lockPath` (e.g. write a dead-pid marker or re-create the claim content at `lockPath`) before
rethrowing, so the path is never left vacant while a live holder believes it holds the lock.

**Non-defects verified while triaging**
- `stat -c %a` in the provision script is darwin-incompatible but runs ON THE BOX (Linux) and is
  simulated by the fake — no issue.
- The harness's `approval: undefined` in `deps()` does pass the recording port by default; the two
  tests in question override with `undefined` precisely to reach the real gate, and with the new
  self-verifying assertions a mock-selection can no longer pass silently.
- `copyFile is box → host` (contract suite) timed out once at 4-file parallel load (exit 143 =
  fill's own 5s timeout under load); it passed in every other run including the final full sweep,
  and the pipe-hang cause (item 11's first draft) is gone. Baseline (stashed) runs of the same
  combo were green. Classified as load flake, not a change defect.

## Evidence

- `bun test tests/providers/ tests/reverify/` → 1008 pass / 0 fail (final sweep, exit 0).
- `bun test` of the four touched files combined → 113 pass / 0 fail (rerun after the one flake).
- Repeat runs of `driver.test.ts` alone and with `runner.test.ts` (x2 each) → all green.
- `bunx biome check` (after `--write`) → clean, all six files.
- `bunx tsc --noEmit` → clean (one TS18048 found and fixed during the round).
