# J4 review round 1: fixes by FX-A

Files touched: `src/phase-engine/steering.ts`, `tests/phase-engine/steering.test.ts`,
`docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`. Nothing committed.

## R1-02 (HIGH, PATCH): resident-originated `compact` accepted in-box

- `src/phase-engine/steering.ts:1393-1400`: `solicit()` now refuses a reply whose parsed `action === "compact"` before `SteeringDirectiveSchema.safeParse` runs. The check runs at every point and covers both well-formed and extra-key variants. It goes through the existing `reject()`, which is the same path origin/dev took for an unknown action: it returns PROCEED, adds 1 to `directivesRejected`, leaves `directives` alone, pushes a `gate_bypass_attempt` row and fires `onTripwire`.
- `:175-179`: new export `HOST_ONLY_COMPACT_DETAIL = "unrecognized action: compact (host-only: a resident reply never originates compact)"`. Its prefix is byte-identical to what origin/dev's `rejectionDetail` produced for `{"action":"compact"}`.
- `:168-173`: new export `directiveAllowedAt(point, action)`, a pure read of `POINT_ALLOWLIST`. The fifth schema member and the `run_start`/`post_gate_failure` allowlist entries are kept (AC2). They now govern only the future host path.
- `:137-141`: corrected the schema-member comment. It no longer says the runner treats an accepted compact as proceed-equivalent.
- Tests (`tests/phase-engine/steering.test.ts`, J4 block from about line 1990):
  - Allowlist predicate test: `compact` is allowed at run_start and post_gate_failure and rejected at run_end. Pre-J4 entries are unchanged.
  - The resident compact is rejected at run_start, post_gate_failure and run_end. Each point checks the plain and extra-key replies for: PROCEED, `directives` 0, `directivesRejected` 1, one `gate_bypass_attempt` row with detail `HOST_ONLY_COMPACT_DETAIL`, and the `onTripwire` mirror.
  - Before/after parity test: the full telemetry for a resident compact equals the telemetry for `{"action":"frobnicate"}`, which still takes origin/dev's unchanged unknown-action path. The only field that differs is the tripwire `detail`. That difference is legitimate: the detail gains a host-only suffix, and its prefix `unrecognized action: compact` is still the pre-J4 string.
  - The inbox e2e test now asserts that a compact reply is refused at post_gate_failure while the fold-time ack still lands.
  - Unchanged and still passing: schema strictness, the prompt-never-advertises test and the negative controls.
- Evidence: `bun test tests/phase-engine/steering.test.ts` gave 107 pass, 0 fail (`/tmp/j4-fxa.log`). As a mutation check I disabled the origin guard. That made 5 tests fail (3 per-point, parity, inbox e2e) (`/tmp/j4-fxa-mut.log`), and the guard was then restored.

## R1-23 / R1-03 / R1-11 / R1-12 (doc)

All four are covered by changes to register §8a item 16 (`docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:363-385`):
- The item text now states that origin is code-enforced. It replaces the old "origin is NOT code-enforced" wording.
- (a) R1-23: both `steering.ts` and `observe.ts` (the `onTick` seam) move `deriveBuildId`. The re-pin is 2328187 to 788d9b3, and publish/adopt stays operator-gated.
- (b) R1-11: the arming PR owes a host-to-engine directive path (the inbox is context-only, and there is no production steering writer) plus the box-side applier.
- (c) R1-03: this limb is still unproven. The resident journal block is written only pre-walk and post-run_end, so RSS and context are null. A mid-run refresh is unowned box-side follow-up work that rides the arming PR.
- (d) R1-12: the sanity leg asks a provisional noul `manifest_consistent` question that is provenance-only and names no disposition values.

## Gates

- `bunx @biomejs/biome check` on the two TS files: clean.
- `bunx tsc --noEmit`: 0 errors repo-wide.

## Driver note

This fix edits `src/phase-engine/steering.ts`, which is in the COPY set, so `deriveBuildId` moves again. The `788d9b3` pin in `tests/scripts/build-exedev-image.test.ts` and in register item 16(a) must be re-pinned at integration.
