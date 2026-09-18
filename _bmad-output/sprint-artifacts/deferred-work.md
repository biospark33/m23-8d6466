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
- **Admission-reservation release API** — `resident-ceiling-unfundable` refuses
  pre-provision but `admitIssue`'s reservation strands the issue's remaining headroom until
  orphan aging (`ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS`); an immediate retry reads
  a misleading `budget-exceeded`. `src/providers/cost-ledger.ts` is DF2.8-owned; the
  compensating release (`admitIssue` gains a release this layer calls on pre-provision
  refusals) is a DF2.8-owned schema/API addition. Interim: the refusal's remediation text
  warns the operator (wait out the window or pick another issue).
- **Sibling workflow-state YAML parse failures (pre-existing)** —
  `_bmad-output/workflow-state/qds-dev/df2-2/state.yaml` and `df3-1/state.yaml` fail
  `yaml.safe_load` with the same plain-scalar colon defect CodeRabbit caught in df3-6a's
  file (fixed there 2026-09-18). Outside PR #263's diff; small chore PR candidate.
