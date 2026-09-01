# W1-D fix report — `transport.ts`, `setup-gate.ts`, `assertions-in-box.sh`

Files edited (ONLY these three):

- `/Users/steve/QDS-Factory/src/providers/exedev/transport.ts`
- `/Users/steve/QDS-Factory/src/providers/exedev/setup-gate.ts`
- `/Users/steve/QDS-Factory/src/providers/exedev/assertions-in-box.sh`

No commits, no `git add`. `bunx tsc --noEmit` clean, `bunx @biomejs/biome check src` clean,
`sh -n assertions-in-box.sh` clean (shellcheck: only the pre-existing SC2016 info the other
`python3 -c` blocks already carry).

---

## Verdicts

| ID | Verdict | What changed |
|----|---------|--------------|
| D1 | **FIXED** | `setup-gate.ts:466-486` — the `readBoxFile` call is wrapped; a rejection becomes the documented `{item:"B", ok:false}` payload with `code: "image-marker-unreachable"`. |
| D2 | **FIXED** | `BoxFileRead.absent` now carries `probeExit`/`probeStderr`; `imageMarkerFailure` classifies 137/255 as a transport fault with its own code, message and remediation. Still fail-closed. |
| D3 | **FIXED** | `imageMarkerFailure` returns `MarkerFailure {code,message,remediation}`; `SetupGateResult.error` carries it; `debugCommands` gained `cat /etc/qds-image.json`. |
| D4a | **FALSE POSITIVE (documented instead)** | `budgetFree()` floors at 1 000 ms (`setup-gate.ts:355`), so it can never hand `execTimed` a zero or negative timeout. Free phases deliberately have no hard deadline refusal (rounds 4-5 comment); the only SPEND is still refused outright. Posture written into the B0 comment rather than a re-check that would contradict the existing design. |
| D4b | **FALSE POSITIVE** | "B0 burns 2× where every other assertion burns one" — assertion A also makes two `execTimed` calls at `budgetFree()` each (`setup-gate.ts:386-391`), and provisioning makes three (`:359,370,371`). The accounting is one budget **per call**, and `readBoxFile`'s two calls take one budget per call. No change. |
| D4c | **FIXED** | `readBoxFile` now prefers `driver.execTimed(vm, argv, deadlineMs)` over `driver.exec` (hard-coded 120 000 ms), so the budget kills the ssh instead of `withTimeout` abandoning it. `execTimed` is OPTIONAL on the structural type, so `read-box-file.test.ts`'s `driverOf({exec})` fake still satisfies it. |
| D5 | **FIXED** | `dp:ok` suppression rewritten: names BOTH callers and what each does with a rejection. |
| D6 | **FIXED** | The version-conditional refusal is hoisted to a "D-pre" block above assertion C — before the roster pings and before D's own paid provider call. `PI_REVIEWED_SERIES` is marked as the thing that must move with `PI_VERSION`, naming the three other copies and stating that the binding is a test's job. |
| D7 | **FIXED** | Empty `pi --version` gets its own arm ("the box could not report a pi version"). `set -u`-only behaviour preserved and now stated in the comment. |
| D8 | **FIXED** | Both `marker.imageRef` and the two stderr tails go through `JSON.stringify`. |
| D9 | **FIXED** | `Buffer.byteLength(read.content, "utf8")`, and the boundary is now `>=` to match the producer (`Dockerfile: stat -c '%s' … -lt 4096`). Stated in the comment and in the `IMAGE_MARKER_MAX_BYTES` doc. |
| D10 | **FIXED** | `emitGate(…, "gate_b0", …)` — consistent with `gate_a`/`gate_b`/`gate_cde` — and `marker_assert_ms` is emitted explicitly via a new optional `extra` argument, so the Observability Contract's named sub-timing survives the rename. |
| D11 | **FIXED** | 154 → 238 bytes, with the reason (the digest-pinned `imageRef` is most of it). |
| Q-4 | **FIXED (comment)** | The `buildId` mismatch arm now states that `imageRef` is reported and never compared, and why (a D7 tenant mirror keeps the digest and the buildId but not the ref). |
| X1 | **NOT ACTED ON** (confirmed false) | The refusal texts match neither `case` arm (`*"custom registry absent"*`, `*" models priced"`). Both my messages avoid both patterns; the AC2 test's `not.toMatch(/custom registry absent/)` still passes. |
| X3 | **NOT ACTED ON** (confirmed false) | `pi --version` prints bare `0.84.4`; both spellings agree. |

---

## Blast radius (gitnexus)

The index is **stale** — `.gitnexus/cli-version.json` says `indexedAt 2026-08-29`, `indexedHead
24632ed`, i.e. before this PR. `impact` therefore could not resolve `imageMarkerFailure` (new
in this PR) or `readBoxFile` (`Target not found`). I did not reindex (10 min, and the reindex
is not mine to run mid-wave). Where the index was blind I used verified greps instead, which
for these three symbols is exhaustive — they are module-local exports with a countable set of
importers.

- **`setupGate`** (`Function:src/providers/exedev/setup-gate.ts:setupGate`) — impacted 6,
  **risk HIGH**, epistemic `exact`. Direct: `ExeDevDriver.setup` (`driver.ts`),
  `dispatch` (`src/fleet/dispatch.ts`). Depth 2: `run` (`scripts/fleet.ts`), `runArms`
  (`fanout-primitive.ts`). Depth 3: `fanout`, `scripts/fleet.ts`. Processes: `run`, `fanout`,
  `dispatch`. **HIGH-RISK WARNING RAISED** — mitigated by the change being purely ADDITIVE to
  `SetupGateResult` (a new optional `error` field; `ready`/`failedItem`/`assertionCode`/
  `assertions`/`debugCommands`/`teardownCommand`/`vm` are untouched), so no existing consumer
  reads a field that moved. `dispatch.ts` keys on `failedItem`/`assertionCode` only.
- **`readBoxFile`** — grep-verified callers: `setup-gate.ts:478` (mine) and
  `src/fleet/fanout-primitive.ts:743` (`probeArm`), plus `tests/providers/exedev/read-box-file.test.ts`.
  The return shape change is **additive** (two optional fields on the existing `absent`
  variant), so `probeArm`'s `res.kind === "absent"` branch and the exhaustiveness of its
  remaining branches are unchanged; the driver-parameter change is an added OPTIONAL method,
  so no caller or fake breaks. `fanout-primitive` passes a real `ExeDevDriver`, which HAS
  `execTimed` — its two probe execs are now killed at `deadlineMs` instead of at 120 s. That
  is the deadline the race already believed it had.
- **`imageMarkerFailure`** — grep-verified callers: `setup-gate.ts:479` only, plus a re-export
  at `driver.ts:62`. `tests/providers/exedev/image-contract.test.ts` exercises it through the
  gate, not directly (it calls `parseImageMarker` directly at :464). Return type changed
  `string | null` → `MarkerFailure | null`; the only production caller is updated in the same
  diff.
- **`emitGate`** — module-private (`setup-gate.ts`), no external callers. New parameter is optional.
- **`assertions-in-box.sh`** — read only by `assertionsInBox()` (`setup-gate.ts:131`) and by
  `tests/providers/exedev/setup-gate.test.ts`, which spawns it directly.

---

## Test results

`bun test tests/providers/exedev/` (with my changes): **187 pass, 7 fail**.
`bun test tests/providers/exedev/setup-gate.test.ts` (with my changes): **44 pass, 1 fail**.

I ran the same file at pristine `HEAD` in a throwaway worktree (`git worktree add --detach`,
now removed) to attribute every failure:

| Failure | Attribution | Evidence |
|---|---|---|
| `round-4 regression: C/D/E starting with <1 s remaining …` (`toContain("C")` gets `["A","B"]`) | **PRE-EXISTING at HEAD** | Fails identically in the pristine-HEAD worktree run (`43 pass, 2 fail`). Load-sensitive: `budgetFree()` floors the pi calls at 1 000 ms real time and the fake SIGKILLs the stub at that budget, so a busy machine fails B before C/D/E is reached. |
| `round-5 regression: no time left at C/D/E …` | **PRE-EXISTING at HEAD**, same mechanism | Failed at HEAD in both the isolated `-t` run and the full-file run; **passed** in my full-file run. Same flake family, opposite direction. |
| `round-4 regression: E rejects non-finite …` (60 s timeout) and one `(unnamed)` afterEach hook timeout, seen only in the 5-file run | **flake under load** | Both pass in the single-file run with my changes; the 5-file run was concurrent with the other fix agents' suites (768 s wall). |
| `DF2.10 AC3 negative control: create() reads the DRIVER's field, never process.env` | **NOT MINE — `driver.ts`** | Throws `ExeDevDriverError: image-pin-incomplete` from `exeDevDriverFromEnv (driver.ts:1166)` — the fix-driver agent's C4 fix. |
| `DF2.10 AC4: valid credential: in argv (the ratified D8 deviation) …` | **NOT MINE — `driver.ts`** | Throws `registry-auth-unratified` from `assertRegistryAuthDeviation (driver.ts:376)` via `new ExeDevDriver (driver.ts:495)` — the fix-driver agent's C1/AC4 fix. |
| `DF2.10 AC4: exe.dev stderr echoing the credential is redacted …` | **NOT MINE — `driver.ts`** | Same `registry-auth-unratified` throw, same constructor. |

**No test failure in the focal suite is attributable to this cluster's changes.** The
setup-gate file is strictly better with my diff than without it (44/1 vs 43/2).

---

## BEHAVIOUR CHANGES FOR THE TEST WAVE

None of the following broke a test in the current suite — they are the seams a new or
re-pinned test must match. `(no current test)` means nothing asserts it today, so this is a
coverage gap rather than a re-pin.

### 1. `imageMarkerFailure` return type (W2-A owner)

- **Old:** `imageMarkerFailure(read, buildId): string | null`.
- **New:** `MarkerFailure | null`, where `MarkerFailure = { code, message, remediation }`.
  The old string is now `.message`, byte-identical except where listed below.
- Any test calling it directly must read `.message`. `image-contract.test.ts` currently goes
  through the gate, so it did not break.

### 2. `SetupGateResult` gains `error?: {code, message, remediation}` (W2-A / W2-B)

- Present **iff** `!ready` AND the failing assertion carried a typed refusal — today only
  B0's marker assertion. `assertionCode` is unchanged (B stays `1`).
- AC1c should now be pinned on `result.error.code`:
  `"image-marker-mismatch"` for absent / unreadable / oversized / over-cap / unparseable /
  buildId-mismatch, `"image-marker-unreachable"` for a transport fault (see 3).
  `(no current test)` — this is the AC1c gap the auditor's MEDIUM named.

### 3. Transport faults are a DIFFERENT code and a different message (W2-A)

- Probe or `cat` exiting **137** or **255** now yields
  `code: "image-marker-unreachable"` and the message
  `B: /etc/qds-image.json could not be read because the box never answered (exit 255 — ssh connection failed or dropped mid-flight): "<stderr>" — a box/transport fault, NOT evidence about the image this box booted`
  instead of the old
  `B: /etc/qds-image.json is absent — this box did not boot a factory image (INV-IBOX-2 …)`.
- A rejection out of `readBoxFile` (the D1 case) yields the same code with
  `… could not be read within the gate budget: <TimeoutError message> …`.
- The old "absent" wording still applies to a genuine exit-1 `test -f`.
- `(no current test)` — the fake substrate cannot produce 137/255 on the marker path today
  (`fake-exedev.ts:638-651` returns exit 1 for an absent marker). Reaching this arm needs a
  fake knob for the probe's exit code. **This is the D1/D2 regression test the wave should add.**

### 4. `debugCommands` gained a 3rd entry (W2-B)

- **Old (4):** `ssh exe.dev ls --json`, `git … status --porcelain`, `pi --list-models`,
  `python3 -m json.tool ~/.pi/agent/models.json`.
- **New (5):** `ssh <host> 'cat /etc/qds-image.json'` is inserted **third**, between the git
  and pi commands. Any index-based or `toHaveLength(4)` assertion must be re-pinned.

### 5. Gate log line: `marker_assert` → `gate_b0` (W2-B)

- **Old:** `emitGate(… "marker_assert" …)` → `{ item: "marker_assert", marker_assert_ms }`.
- **New:** `{ item: "gate_b0", gate_b0_ms, marker_assert_ms }` — the `gate_*` item name every
  filter uses, and `marker_assert_ms` still present (emitted explicitly) so the Observability
  Contract's named sub-timing survives. A test matching `item === "marker_assert"` must move
  to `"gate_b0"`; a test matching the `marker_assert_ms` FIELD is unaffected.
  `(no current test)` for either.

### 6. Marker cap boundary moved from `> 4096` to `>= 4096`, counted in BYTES (W2-A + W2-C)

- **Old:** refused at `read.content.length > 4096` (UTF-16 code units).
  **New:** refused at `Buffer.byteLength(content) >= 4096`, matching the producer
  (`Dockerfile: [ "$(stat -c '%s' …)" -lt 4096 ]`).
- Message text changed: `is N bytes, over the 4096-byte cap` →
  `is N bytes, at or over the 4096-byte cap`. `image-contract.test.ts:573`'s
  `why: /cap|bytes/i` still matches (verified passing).
- **W2-C:** `tier1-image-contract.live.test.ts:225` uses `toBeLessThan(IMAGE_MARKER_MAX_BYTES)`,
  which now agrees with the gate exactly. A boundary case at exactly 4096 is the test worth
  adding; it belongs to the test wave.
- A test that asserts a 4096-byte marker PASSES the gate would now fail. None exists today.

### 7. `marker.imageRef` and stderr tails are `JSON.stringify`d in gate notes (W2-A)

- **Old:** `… (imageRef in marker: ghcr.io/…@sha256:…)` and a bare `stderr.trim().slice(0,200)`.
- **New:** the same values wrapped in double quotes with escapes. A regex matching the bare
  ref inside a note now needs to tolerate the surrounding quotes.
  `image-contract.test.ts`'s `why` regexes are supersets and still pass.

### 8. `assertions-in-box.sh` — the unreviewed-series refusal now fires BEFORE C (W2-B)

- **Old order:** C's live pings → D's paid provider call → `pi --version` check → refuse.
  **New order:** `pi --version` check (pure string comparison, no spend) → C → D.
- On refusal the script now emits **only** the `D` line and exits 3, with **no `C` line at
  all**. Host-side this is the `controlled` branch (`setup-gate.ts:544-549`), so
  `failedItem: "D"`, `assertionCode: 3`, and `assertions` contains exactly one entry.
  A test asserting that C ran (or passed) before an unreviewed-series refusal must be re-pinned.
- `setup-gate.test.ts:989-1044` ("DF2.10 AC2 … an unreviewed pi series refuses D") **still
  passes**: it only inspects the `D` line, and the message keeps `UNREVIEWED`, the series
  number, and avoids `custom registry absent`. Verified green.
- The "custom registry absent" tolerated-absence test is unchanged and green: the note text is
  byte-identical, it just comes from the shell now instead of from python.

### 9. NEW arm: an unreportable pi version (W2-B) — `(no current test)`

- When `pi --version` prints nothing parseable AND `~/.pi/agent/models.json` is absent, the
  script now emits
  `the box could not report a pi version (pi --version printed nothing parseable) — the missing-registry tolerance is verified for pi series 0.84 only and cannot be granted to a runtime that will not identify itself`
  and exits 3, instead of the old message blaming a `PI_VERSION` bump.
- Reproduce with a `pi` stub that prints nothing for `--version` (the AC2 test's shim already
  demonstrates the shape; point it at empty output). **This is D7's regression test.**
- NOTE for the wave: `setup-gate.test.ts`'s curl/pi shim currently relies on the pi stub
  answering `--version`; a stub that answers nothing now refuses D *before C*, which is the
  intended new behaviour.

### 10. `PI_REVIEWED_SERIES` binding test (W2-B / W2-D) — `(no current test)`

- I could not bind the shell constant to `PI_VERSION` from inside a shell script. The
  constant is now clearly marked and the three other copies are named in the comment
  (`oci/exedev/Dockerfile` ARG `PI_VERSION`, `scripts/build-exedev-image.ts`
  `export const PI_VERSION`, the test fake). **The test wave owns the binding assertion**:
  read `PI_REVIEWED_SERIES` out of `assertions-in-box.sh` and assert it equals
  `PI_VERSION.split(".").slice(0,2).join(".")`.

### 11. `readBoxFile` now calls `execTimed` when the driver has it (W2-A / fanout tests)

- Fakes that count seam calls are unaffected (same two calls, same command strings).
- Fakes that assert the `timeoutMs` passed to the seam WILL see `deadlineMs` where they
  previously saw `DEFAULT_EXEC_TIMEOUT_MS` (120 000). No current test asserts this.
- `read-box-file.test.ts`'s `driverOf({exec})` still satisfies the parameter type
  (`execTimed` is optional) and still exercises the `exec` path. A test for the `execTimed`
  path is worth adding.

---

## Not fixed, deliberately

- **D4a/D4b** — see the verdict table; both are refuted by the surrounding code, and the
  reasoning is now recorded in the B0 comment so the next reviewer does not re-raise them.
- The **two pre-existing timing-test failures** are load-sensitive and live in
  `setup-gate.test.ts`, which I do not own. They reproduce at pristine HEAD. Worth the wave's
  attention: `budgetFree()`'s 1 000 ms floor is a REAL-time budget the fake enforces with a
  SIGKILL, so those tests fail whenever the machine is busy — they are measuring the host, not
  the gate.
