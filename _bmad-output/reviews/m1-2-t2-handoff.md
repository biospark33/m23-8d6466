# M1.2 T2 live-round handoff (AC7) — 2026-10-07

**Status:** authored, hermetically gated, triple-reviewed — **FIRED GREEN 2026-11-06** (16 fires; final green 4 pass/0 fail at branch head `17f7699a`; the four authored-expectation defects the first fire exposed are fixed on `feature/m12-live-manifest-fix`; spend story below).

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

Operator notes: the round is self-contained — the probe-family seeding carries its own git `insteadOf` alias (subprocess env only) so `fill` clones the real repo despite the probe slug; the seeded `cost-config.json` pre-bounds the minted key to 50,000 µ$ (the round asserts that bound echoes back). No extra setup beyond the four inputs above.

Legs: L1 echo [VERIFY DD-28.26(3)] (retain → recall `documentId` contains; replay upserts to ONE document; honest gated fallback on echo failure); L2 primed dispatch on the probe-slug family (`qds-probe/m12-<rand>` — base + `-dev-meta` seeded; zero production-memory pollution) with `<kg_context>` render + side-channel row assertions; L3 harvest retain (outcome document, exactly one `memory-retain-receipt`/`retain` row, re-harvest dedup). Cleanup (probe banks, box, key, side-channel rows) in `finally`; evidence scrubbed to `_bmad-output/evidence/m1-2/`.

## Known state at handoff

- Branch: `feature/m1-2-host-side-memory-cycle` (3 impl commits + 3 review-fix commits, all gates green — `.unlazy/m1-2/gates/node-1.1.md` ALL MET on the final tree).
- Follow-ups filed: #411 (gitnexus 1.6.12 CLI ritual — pre-existing, not M1.2).

## Fired 2026-11-06 — the spend + defect story

16 fires today (operator GO per leg, worst-case printed by the round before each). Final green:
4 pass / 0 fail at branch head `17f7699a` — the whole arc green in one fire. Total real spend
across all fires + 3 manual forensics boxes ≈ $0.35 (box-minutes + model calls; every fire's
`finally` cleaned — final-ls `[]`, key leak `[]` — except my two manual forensics boxes, leaked
~45–70 min before hand-destroyed: my cleanup miss against the skill's cleanup discipline,
owned). Four authored-expectation defects vs shipped contracts, all fixed on the branch:

1. **no-commit manifest** — L3 demanded a bundle + solicit artifacts from `t2.pipeline.json`
   (`echo`+`true`); authored the round's own committing+solicit manifest.
2. **budget ceiling** — runBudgetMs 1.9M > dispatch callerBudgetMs default 600k; pre-spend
   refusal (fire 2, $0 spent); adopted m2-3's R2-001 shape (manifest 900k / caller 960k).
3. **key cap under the leg's real spend** — seeded 50,000 µ$ cap refused every in-box model
   call instantly (0 tokens, transient) while a green run spends ~75,812 µ$; raised to 500,000.
4. **pre-twin receipt assert** — one-receipt expectation predates the retain twins; filtered to
   the outcome twin (subjectId = runId).

Two store-side behaviors documented (not defects): hindsight renders retained JSON payloads as
prose facts on recall (paraphrase variance across runs); recall indexing latency is variable
(outcome doc surfaced at poll 1 in fire 11, never in fire 12's ~10s window → polls widened to
10 × 5s). The memory env ran against the local `qds-factory-hindsight-qds-1` container (real
Hindsight 0.1.0 — typed as 0.10.0 image) — not the VPS dedicated instance; the port was
ambiguous all day (stale ssh tunnel + local docker both bound 18890, macOS allows co-binding),
so this must be re-verified against the VPS instance before M2.3's gateway round. Also: the
body teardown's exit-6 acceptance now matches the skill's gotcha #6 exit table.
