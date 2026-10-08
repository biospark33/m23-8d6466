# M2.2 — In-box extension re-pin ritual (runbook — DEFINED, NOT FIRED)

**Status:** defined by M2.2 (`_bmad-output/sprint-artifacts/dark-factory-v6/stories/m2-2-in-box-kg-recall.md`, AC5).
**Fired:** NO. This ritual runs only on explicit **operator GO** — **zero agent spend** before it
(charter §6, "ops stays operator-gated"). Nothing in this runbook is executed by story M2.2's dev legs.
**Blocks:** every T2 round (wave-0 ops), including M2.3's combined memory live round — M2.3's Infra
Prerequisites consume the pin this ritual adopts.

---

## 1. Why a ritual (the one-paragraph version)

`oci/exedev/Dockerfile` enumerates every context path it COPYs, and `deriveBuildId`
(`scripts/build-exedev-image.ts:638`, inputs gathered by `gatherBuildIdInputs` :1698) derives the
buildId **from the Dockerfile's own COPY instructions**. M2.2 adds one COPY line
(`pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall` → `/opt/qds/pi-ext/kg-recall`), so the
buildId moves by construction. The adopted pin (`DEFAULT_IMAGE_REF` / `DEFAULT_IMAGE_BUILD_ID`,
`src/providers/exedev/driver.ts:492-493` and `:600`) then names a digest no image holds until the
tree is rebuilt, published, and re-adopted. Doing that out of order strands T2 boxes behind a pin
that cannot pull — which is why the whole move is one batched, operator-gated procedure.

## 2. Current documented state (at runbook authoring, 2026-10-08)

| Fact | Value |
| --- | --- |
| Live pin | `DEFAULT_IMAGE_REF = ghcr.io/quantum-digital-solutions/qds-exedev@sha256:ee80266907399d700b33dbe3ed10895187e87c45dfcb56c54db7aba7acc9bcea`, `DEFAULT_IMAGE_BUILD_ID = "26b5ce571e50bfcc"` (the thirty-first pin, adopted by `fd1267de`, #397, 2026-10-01) |
| Verify-image-pin `verify` leg | **RED (real)** — `ee802669…` is `MANIFEST_UNKNOWN` on GHCR: the workflow pruned the ungated push, so between the adoption commit and the healing run the digest names bytes **no registry holds** (root cause recorded at `driver.ts:480-486`). Retired by this ritual's new publish+adopt. |
| `base-drift` leg | **RED BY DESIGN** whenever upstream rebuilt `exeuntu` since the last base re-pin (weekly no-cache cron). Documented expected state, not an incident. |
| `tests/scripts/build-exedev-image.test.ts` | One known-red test: `buildIdFileInputs > a single digest over EVERY tracked walked input` — M1.2's COPY-set edits (merged 2026-10-06, `69c09821`) moved walked inputs; the pin predates them. The ritual's adopt step rewrites this literal. |
| Exception register (`image-pin-exceptions.json`) | **EMPTY — stays empty.** This ritual retires reds; it does not register exceptions. |

## 3. The batching gate (DD-28.26(4) — the once-only ritual tree)

The fire pays ONE rebuild only if the tree already contains **all four** PENDING ritual-tree
members' COPY-set-affecting edits plus M2.2's own COPY line — the trigger this ritual exists
to bake (five table rows below). Re-pin is batched, never serialized per story:

| Member | Edit that moves buildId inputs | Status at authoring | Verify before fire |
| --- | --- | --- | --- |
| M1.2 | `src/fleet/brief-schema.ts` (+43) and `scripts/pipeline-run.ts` (+15) — kgContext render; already inside existing COPY enumeration (`COPY src/fleet/` :279, `COPY scripts/pipeline-run.ts` :277) | **on dev** (69c09821) | `git log dev --oneline -- src/fleet/brief-schema.ts \| head -1` shows the M1.2 commit |
| J3 | adds-only `src/fleet/dispatch.ts` router region (typed dep + hook call) | NOT STARTED (ready-for-dev) | `grep -c "RoutingHook" src/fleet/dispatch.ts` ≥ 1 |
| J4 | adds-only steering `compact` member (`src/phase-engine/steering.ts`) | NOT STARTED (ready-for-dev) | steering.ts contains the `compact` member |
| A2 | adds-only `workKey` field (`src/providers/run-record.ts`) | NOT STARTED (gated) | `grep -c "workKey" src/providers/run-record.ts` ≥ 1 |
| M2.2 | the COPY line itself (`pi-vs-claude-code-vendor/kg-recall/…`) | this tree | the line exists in `oci/exedev/Dockerfile` |

**Rule:** fire only when all five rows verify on the SAME tree. If any member is absent, STOP —
firing now bakes an image without them and forces a second paid rebuild before any T2 round
(AC5's explicit negative control). Re-run this ritual after the last member lands.

## 4. Procedure (execute in order, on the batched tree)

1. **Operator GO** — recorded in the round's evidence notes. No GO, no step 2. **Zero agent spend
   at every step** — this is an ops/build/publish procedure; no agent runs, no model calls.
2. **Batching gate** — §3 checklist all green on the exact tree being built (`git rev-parse HEAD` recorded).
3. **Re-pin the base** — if the `base-drift` leg is red, adopt the upstream base digest deliberately
   (update the FROM digest pin). Red `base-drift` is by design weekly; adopting it is a deliberate
   re-pin, never a silent one-line edit (workflow comment, `verify-image-pin.yml:749-758`).
4. **Rebuild** — run the image build (`scripts/build-exedev-image.ts`), which measures the TOFU ARG
   digests and produces the new 16-hex buildId. Record both.
5. **Re-sweep** — the disclosure sweep must converge: the walked COPY set equals the enumeration
   (the scratch-tree probe precedent; gap-3 closure makes `buildIdFileInputs` parse the Dockerfile,
   so the swept set cannot fall behind the file). The `build-exedev-image` suite's tracked-inputs
   test is expected RED until step 7 writes the new literal.
6. **Publish** — push via `publish-exedev-image.yml` (GHCR + SLSA provenance; the verify leg's
   attestation check pins cert identity to exactly this workflow on `refs/heads/(main|dev)`).
7. **Adopt** — `bun scripts/adopt-image-pin.ts <publish-workflow-run-id>`. The adopter edits the
   **five literal sites across four files** and re-runs both suites:
   1. `src/providers/exedev/driver.ts` — `DEFAULT_IMAGE_REF` + `DEFAULT_IMAGE_BUILD_ID`;
   2. `oci/exedev/Dockerfile` TOFU `ARG NODE_SHA256/OPENRIG_TREE_SHA256` + the `measuredDefault`
      copies in `tests/scripts/build-exedev-image.test.ts`;
   3. the tracked-inputs digest literal in `tests/scripts/build-exedev-image.test.ts` (parsed from
      the failing test's `Received:` under "a tracked buildId input moved");
   4. `tests/providers/exedev/image-contract.test.ts` — `marker.buildId` + `DEFAULT_IMAGE_BUILD_ID`
      literals + the per-file `PINNED` map from the failing diff.
   **Commit every changed file together (the ritual is one commit), then push to `dev`.**
8. **Post-adopt CI expectations:**
   - `verify` leg: **GREEN** on the adopt push (attestation verifies against the fresh publish).
   - `base-drift` leg: **RED BY DESIGN** and ignored as such until the next deliberate base re-pin
     (weekly upstream rebuild). Documented state, not an incident.
   - The `ee802669…` `MANIFEST_UNKNOWN` red is **retired** by the new publish — the old red must not
     reappear on the default branch.
   - **The exception register stays EMPTY** — no `image-pin-exceptions.json` entry is added by this ritual.
9. **Evidence** — record under `_bmad-output/evidence/m2-2/`: HEAD, new REF + buildId, adopt commit,
   verify-leg green run URL, base-drift-by-design note. That evidence artifact is AC5's deliverable.

## 5. What consumes the result

- **M2.3** (combined memory live round): its T2 pin prerequisite is exactly this adopted digest — it
  carries M2.2's in-box extension COPY **and** the M1.2/J3/J4/A2 code its ACs need (DD-28.26(4)'s
  once-only tree).
- **Gate B** (`driver.ts`): box-baked marker vs `DEFAULT_IMAGE_BUILD_ID` — green only after adopt.
- Every later T2 round: pulls the new `DEFAULT_IMAGE_REF`.

## 6. Failure modes (from the register + prior pins)

- **Firing before the batch completes** → second paid rebuild (AC5 negative control). STOP instead.
- **Adopting without publishing** → `MANIFEST_UNKNOWN` redux (the pruned-digest failure mode).
- **Letting the adopt commit touch buildId-fed bytes** (driver.ts code, Dockerfile beyond TOFU ARGs)
  → a third buildId; the gate never converges (the exact "do not keep re-pinning, fix that" failure
  `publish-exedev-image.yml` warns about).
- **Registering an exception instead of re-pinning** → forbidden here; the register stays empty.
- **The dev-push publish fires UNGATED** — `publish-exedev-image.yml` triggers on `push` to `main`/`dev`
  with the COPY-source paths filter, so merging the trigger line to `dev` publishes an image without
  operator GO and (today) from an un-batched tree (J3/J4/A2 pending). That is by design and harmless to
  the PIN — `adopt-image-pin.ts` is the only writer of `DEFAULT_IMAGE_REF`/`DEFAULT_IMAGE_BUILD_ID` and
  stays operator-gated (the ee802669 root cause in §2 was exactly such an ungated push's digest being
  pruned). The ritual's GO governs the batched ADOPT, not the publish. Do not "fix" this by gating the
  publish workflow; gate the adoption.
