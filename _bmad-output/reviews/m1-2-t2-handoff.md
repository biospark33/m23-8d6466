# M1.2 T2 live-round handoff (AC7) — 2026-10-07

**Status:** authored, hermetically gated, triple-reviewed — **not fired**. Four operator-gated preconditions are unmet; firing without them would either fail deterministically or bill spend without the charter's required GO (charter §6, per issue #408's standing gate). Recorded as a handoff per the round contract ("precondition failure honestly recorded — never silently skipped"); **AC7 stays open** and `sprint-status.yaml` keeps M1.2 `in-progress`.

## Preconditions to clear (in order)

1. **Image publish (re-pin ritual, ops half).** M1.2 moved walked COPY inputs (`src/fleet/brief-schema.ts`, `scripts/pipeline-run.ts`, `src/fleet/run-completion.ts`, `src/fleet/dispatch.ts`); the repo-side digest is adopted (`90250820…`, `tests/scripts/build-exedev-image.test.ts`). The IMAGE half — publish a boot image built from a tree containing this branch — is the operator-gated publish workflow. Without it the T2 box runs an engine without the `kgContext` render and the round fails on its own assertions.
2. **Memory env.** `HINDSIGHT_BASE_URL` + `HINDSIGHT_BEARER_TOKEN` pointing at the M1.1 dedicated instance (VPS loopback :18890 via tunnel, or on-box). Absent from this host's env/.env.
3. **exe.dev env.** `QDS_EXEDEV_REPO_URL` / `QDS_EXEDEV_SHA` (a pushed scratch repo — prior rounds used a scratch repo, not QDS-Factory itself; see `_bmad-output/plans/df5-3-live-e2e-handoff.md`) + `QDS_EXEDEV_ROSTER` (the proven T2 pair). Absent from this host's env.
4. **Operator GO for spend.** Worst-case (printed by the test before firing): 1 box ≤ 1 h + 1 key capped (T2_CAP_MICRO_USD) + first-boot model init. Realistic < $0.10.

## Then fire

```bash
QDS_E2E_LIVE=1 QDS_E2E_TIER=2 \
QDS_EXEDEV_REPO_URL=… QDS_EXEDEV_SHA=… QDS_EXEDEV_ROSTER=… \
HINDSIGHT_BASE_URL=… HINDSIGHT_BEARER_TOKEN=… \
OPENROUTER_PROVISIONING_KEY=… \
bun test tests/fleet/e2e/memory-cycle.live.test.ts
```

Legs: L1 echo [VERIFY DD-28.26(3)] (retain → recall `documentId` contains; replay upserts to ONE document; honest gated fallback on echo failure); L2 primed dispatch on the probe-slug family (`qds-probe/m12-<rand>` — base + `-dev-meta` seeded; zero production-memory pollution) with `<kg_context>` render + side-channel row assertions; L3 harvest retain (outcome document, exactly one `memory-retain-receipt`/`retain` row, re-harvest dedup). Cleanup (probe banks, box, key, side-channel rows) in `finally`; evidence scrubbed to `_bmad-output/evidence/m1-2/`.

## Known state at handoff

- Branch: `feature/m1-2-host-side-memory-cycle` (3 impl commits + 3 review-fix commits, all gates green — `.unlazy/m1-2/gates/node-1.1.md` ALL MET on the final tree).
- Follow-ups filed: #411 (gitnexus 1.6.12 CLI ritual — pre-existing, not M1.2).
