# Fix F4 — providers (PR #150 review round 7)

Files: `src/providers/run-record.ts`, `src/providers/bounded-exec.ts`, `src/providers/exedev/driver.ts`
Tests: `bun test tests/providers/` → 916 pass, 0 fail. `bunx biome check` clean. `bunx tsc --noEmit` clean.

## Item 27 [MED] shed note echoes raw dropped values to stderr — FIXED

Verified: `shedStrings` (run-record.ts:797) printed `value.slice(0, dropped).join(", ")` — raw caller text — and the migration head-shed note (run-record.ts:972) printed `history.slice(0, shed).join(", ")`. Both values are `strings`-kind elements subject to `assertNoSecret`; stderr is not scanned.

Fix: both notes now print only lengths and counts (`element lengths 4, 4; 256 survive`). Attribution is by shape; no element content ever reaches stderr. `assertNoSecret` ordering untouched — the notes fire before/around the scans, never instead of them.

Test updated (FLAGGED): `tests/providers/run-record.test.ts:631` — was `toContain("dropping the 1 oldest: rv-0")` (pinned the leak); now asserts `dropping the 1 oldest` + `element lengths 4` + `not.toContain("rv-0")`.

## Item 28 [MED] retired-field migration bypasses assertKind/assertNoSecret — FIXED (secret half), length half already guarded

Verified: the fold (run-record.ts, `retired` loop) assigned straight to `entry[into]` past the field door's `assertKind`/`assertNoSecret` pair. The over-length arm existed (drops loudly, per the pre-existing test at run-record.test.ts:544); the SECRET scan did not — a credential-shaped legacy scalar short enough to pass the 200-char guard landed in the audit array unscanned, and the damage surfaced on the next rebind as a throw naming an array the caller never supplied.

Fix: `assertNoSecret(extPath(ns, into), legacy)` now runs in the fold, before the value can land — keyed on the successor path (`into`), the same key `SHAPE_EXEMPT_PATHS` is keyed by, so the fold scans exactly what the field door would have scanned had the element arrived normally. A poisoned legacy value now refuses at migration time, naming `extensions.approval.supersededReportIds`. (Typed `schema-rejected` code: `assertNoSecret` throws a plain Error by design — its message names the field; widening its throw type was out of scope.)

Test added: `a SECRET-SHAPED legacy supersededReportId refuses at migration time (round 7 item 28)` — also asserts nothing was persisted (legacy scalar still on disk, array never written).

## Item 29 [MED] strings kind admits empty-string elements — FIXED

Verified: `assertKind`'s `strings` branch checked type, count and per-element length — not emptiness. An `""` element landed in an append-only audit history as a stored id that is a hole.

Fix: a `findIndex` for `length === 0` throws `schema-rejected` with the field AND index named (`extensions.approval.supersededReportIds[1] must be a non-empty string`), so a caller supplying the array whole can find the element. Bounds stay part of the kind, so every future `strings` field inherits the rule.

Test added: `an EMPTY string element is rejected with the field and index named (round 7 item 29)`.

## Item 30 [MED] steering provisioned only at create; substrate re-created box never re-provisioned — DEFERRED (blocked, out of file set)

Verified: provisioning runs only in `ExeDevDriver.create`'s two success arms (driver.ts:223, :232). The steering SEND path is `src/fleet/attach.ts:417-428` (`APPEND_SCRIPT` via `deps.driver.exec`) — outside my file set, and attach was explicitly off-limits ("READ attach.ts for evidence; do not edit it" was item 31, but attach.ts is not in my edit list at all).

Why not the conservative fix as specified: the fix's natural home is the send call site in attach.ts. The only in-scope alternative was a retry inside `ExeDevDriver.exec`/`execTimed` — gitnexus impact on `exec` returned **CRITICAL** (27 impacted symbols, 14 direct callers, 10 processes: fill, setup, gate, dispatch, fanout, pipeline, visualizer). A send-failure-shaped retry on that seam would re-execute arbitrary commands (fill/setup/gate payloads), which is exactly the loop/widening the brief forbids. Per the rule "HIGH/CRITICAL spill → conservative fix", no edit was made.

Recommended path for a follow-up: add an explicit `steeringSend(vm, line)` method on `ExeDevDriver` (one re-provision + one retry, reusing `provisionSteeringChannel`, typed refusal on failure) and have attach route its `APPEND_SCRIPT` call through it when the driver exposes it. That keeps the retry off the generic exec seam entirely. Flagged as intentional behavior change candidate — NOT landed here.

## Item 31 [LOW] shared exec default cap doubled 512KiB→1MiB — DEFERRED (attach relies on the doubled default)

Evidence (attach.ts read, not edited): attach passes NO explicit cap. Its `tail -c ACKS_READ_CAP_BYTES` window (`ACK_READ_SCRIPT`, attach.ts:243) rides `driver.exec`, whose transport reads stdout with `readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES)` (exedev/transport.ts:74) — the implicit shared default. `ACKS_READ_CAP_BYTES` is 1 MiB, equal to the current default, and attach's `tail -c` window arriving whole depends on `readBounded`'s strict `bytes > cap` truncation at exactly that size.

Restoring 512 KiB would truncate attach's ack read from the front — dropping the newest acks and turning delivered messages into spurious `attach-not-acked`. Two tests pin the pairing from both sides (`tests/providers/bounded-exec.test.ts:88` pins the 1 MiB literal; `tests/fleet/attach.test.ts:587` pins `ACKS_READ_CAP_BYTES <= EXEC_MAX_OUTPUT_BYTES`).

Action taken: documented the ceiling and the real upgrade path in the constant's comment (bounded-exec.ts): lowering requires attach to pass `ACKS_READ_CAP_BYTES` explicitly at its exec call sites first. Constant unchanged.

## Fallout check

`bun test tests/fleet/` reports 3 failures in `tests/fleet/cli.test.ts` (AC7 `pausing` state mapping). Reproduced with my three files stashed — they come from concurrent fixer edits to `src/fleet/status.ts`/`verbs.ts` (F3 territory), not from F4.

## Impact analysis (GitNexus, run before each edit)

- `shedStrings`, `assertKind`, `validateExtensions`: all CRITICAL, but blast radius is confined to src/providers internals + tests/providers for the deltas made (note text, one added guard, one added throw branch). No HIGH/CRITICAL spill from the actual edits — the edits only narrow accepted values and redact diagnostics.
- `ExeDevDriver.exec`: CRITICAL (27 symbols) — reason item 30 was not fixed at that seam.
