# Deferred work

## Deferred from: code review of story df3-6a-resident-spend-iteration-bounds (2026-09-18)

- **Duplicate phase names share one per-phase iteration budget** — `createBoundsGuard`
  keys its counters by phase NAME; two same-named phases pool their solicitation budgets
  (under-refusal only, fail-closed direction). Clean fix needs a phase ordinal or name-set
  check through the steering↔guard interface — wider than DF3.6a's sanctioned steering edit
  list. S3-7 treats duplicate phase names as config-level. Owner: next engine-bound story
  touching the guard interface (DF3.6b or successor). Recorded as story known-limitation (a).
- **`lastMemory` createSteering dep lands unused** — deliberate: DF3.6a landed it so
  DF3.6b's `exitStatus:"overflow"` writer has its input without two stories editing the
  deps literal (story edit-list item 5). Consumed by DF3.6b AC1.
- **`residentRssBytes` has no behavioral test coverage** — field is validate-and-carry in
  DF3.6a; enforcement (cgroup `memory.max`) is DF3.6b's. Behavioral tests belong there,
  against the enforcing code.
- **Tripwire row lacks the `code`/`bound` keys the DF3.6a Observability Contract names** —
  `ResidentTripwire` is DF3.3's closed type; widening it is a cross-story contract edit.
  The contract sentence is a spec-internal contradiction (the E2E Slice blesses "the full
  shipped shape" which has no such fields). Resolution belongs to the story that next owns
  the tripwire type.
- **~~Admission-reservation release API~~ — RESOLVED 2026-09-18, shipped in PR #263**
  (operator-sanctioned in-round): `CostLedger.releaseAdmission` + append-only
  `gate_admission_releases` table; both pre-provision refusals release best-effort; retry
  after a config fix now admits. Residual kept open below (driver-layer per-cause retirement).
- **Driver-layer reservation retirement (per-cause)** — DF2.8's own 2026-08-20 deferred item:
  `provisionAdmittedRun`'s budget `store.set` failure orphans the admission reservation.
  NOT covered by `releaseAdmission` (different semantics): ordinary write failure wants a
  release but the driver holds no ledger handle; `budget-write-lock-timeout` must NOT release
  (another writer may recreate the record); box-create failure's retirement is
  teardown/close. Needs a per-cause policy + a release callback/handle into the provision
  catch. `src/providers/driver.ts:847-870`.
- **Sibling workflow-state YAML parse failures (pre-existing)** —
  `_bmad-output/workflow-state/qds-dev/df2-2/state.yaml` and `df3-1/state.yaml` fail
  `yaml.safe_load` with the same plain-scalar colon defect CodeRabbit caught in df3-6a's
  file (fixed there 2026-09-18). Outside PR #263's diff; small chore PR candidate.
