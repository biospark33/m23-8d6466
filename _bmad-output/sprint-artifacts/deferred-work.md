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

## Deferred from: code review of 2026-09-23-rig-swarm-phase-s1 (2026-09-24)
- F-024 (LOW): Cost snapshot races live seats: spend between the JSONL read and rig down is never attributed on any exit path (worst on timeout where seats are mid-work).
  - Rationale: Inherent TOCTOU on a filesystem the seats own until teardown; the pre-teardown emission is deliberate (crash-safety, ff39b624). Post-teardown re-read + delta emission doubles ledger semantics for marginal accuracy. DEFER: document the window in a comment; revisit with the live-round data.

## Deferred from: code review of m1-1-dedicated-hindsight-vps (2026-10-04)

- **document_id upsert semantics unverified on 0.10.0** (F-027/R2-026, MED-if-it-bites): the provision-and-import driver mints deterministic `mulch-<hash16>` document_ids on a raw retain, but the consumed mulch-importer never sends document_id — if 0.10.0 keys memory identity on document_id, an operator running `import-mulch-expertise.ts` against a minted bank duplicates the corpus silently. VPS-day probe: retain-twice against the probe bank, diff memory counts; also covers the driver's own re-import idempotency claim.
- **Foreign same-id base bank on the rerun lane** (R2-025, LOW): rerun fork treats base-bank presence as "ours" (no provenance marker exists); a tenant-era or foreign `qds-<slug>` bank would be PUT-upserted and minted into. VPS-day checklist: operator confirms the dedicated instance is fresh (no pre-existing qds- ids) before first provision; pass QDS_REPO_SLUG explicitly.
- **Vendored self-compact parity suite red on BASE dev** (discovered during the M1.1 branch gate, 13-14 fails in `pi-vs-claude-code-vendor/self-compact/tests/parity/extension.test.mjs`): reproduced identically with the M1.1 diff stashed — pre-existing, zero overlap with any M1.1 write-set. Owner: self-compact/vendor track, not M1.1.
- **Z4-region compose item** (C16): `deploy/vps/docker-compose.factory.yml` sets `HINDSIGHT_API_TENANT_API_KEY` without `HINDSIGHT_API_TENANT_EXTENSION`, so 0.10.0's auth extension is off and M1.1's AC4 leg will (honestly) record danger-NOT-retired on VPS day unless the operator adds the extension env. Compose change = Z4 follow-up.

## Deferred from: code review of m2-1-memory-gateway (2026-10-07)
- F-029: the delivered env file retains revoked key material after the lifecycle returns (one dead plaintext `QDS_KG_RECALL_KEY` per completed run accumulates on the host). By-design mirror posture — the file must live through the run it serves; post-run cleanup belongs to box teardown (DF2.5 lineage), outside the gateway module's surface. Actionable in the story that owns box teardown for memory runs.

## Decision-register closure (2026-11-04)
- **openrig stale-ledger SKIPs — CLOSED not-reproducible.** Register item 6 directed
  closure unless steve supplies a pointer. Premise sweep 2026-11-04 found no matching
  artifact anywhere: `_bmad-output/evidence/openrig-{s0,s1,s2,sc2}/` JSONs, suite logs,
  `sprint-status.yaml`, this register, `dark-factory-v6/`, and `.sandbox/runs/` all
  carry no stale openrig ledger SKIP. Sole grep hit was incidental (a "deferred
  docker/image builds" note inside `openrig-sc2/2026-09-28-sc2-1-5-code.json`). If
  steve later supplies a pointer, reopen under a new entry with that pointer cited.

## Deferred from: p0-9 funded window + p1-7 e2e leg (2026-11-06)

- **pi stored auth shadows env and is not_ready** (measured in the p1-7 leg): `pi auth check --provider openrouter` → not_ready, and the stored entry shadows the env key (skill gotcha #2). The leg fixed per-run via explicit --api-key; operator should refresh or delete the stale `~/.pi/agent/auth.json` openrouter entry, or set PI_LENS/PI model defaults so bare `pi -p` works.
- **PI_LENS_ROOT is an operator pin for local gate runs** (p1-7 leg): pi-lens lives only under `~/.pi/agent/npm/node_modules/pi-lens` (3.8.71); `resolvePiLens` probes npm global roots that don't carry it. Local gate consumers need `PI_LENS_ROOT=/Users/steve/.pi/agent/npm/node_modules/pi-lens` exported, or the prod-deps resolver extended. Deferred to the story that attaches gatedBody (P1.7 item 2).
- **Box checkout sits on the PR branch** — `/opt/qds/QDS-Factory` is on feature/p0-9-reflect-wire-slice @ 78f36bb6 after the window; move back to dev after #501 merges (next window's first checklist item, before any leg rerun).
- **solstice-hindsight key stranded at the $0.23 workspace floor** — left in pass-cli (field solstice-hindsight) as a backup; operator may revoke it or top up that workspace. The funded key passed through this session transcript — rotation is the operator's call.
- **The funded key is a main-account key, not a box-lifecycle ephemeral** (operator's stated intent: factory mints ephemeral keys per box). Operator may mint a scoped ephemeral key for the box and swap it in `deploy/vps/hindsight-qds.env`; current key works, hygiene deferred.
