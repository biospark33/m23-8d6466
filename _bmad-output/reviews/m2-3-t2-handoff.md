# M2.3 T2 live-round handoff — 2026-10-09

**Status:** authored, hermetically gated, three full bmad-code-review rounds (waves of fresh reviewers each round: blind hunter + edge case hunter + acceptance auditor) — **not fired**. The operator-gated preconditions are unmet; firing without them would fail deterministically or bill spend without the charter's required GO (§5.6, §6). Recorded as a handoff per the round contract ("precondition failure honestly recorded — never silently skipped"); **the live-fire ACs (AC1's execution, AC5's execution) stay open**, exactly the M1.2 precedent (`_bmad-output/reviews/m1-2-t2-handoff.md`).

## What ships

- `tests/fleet/e2e/memory-combined.live.test.ts` — the round driver: L0 spend print → LD degrade control (real `primeDispatchBrief` vs unreachable origin: silent proceed-unprimed, never `EMPTY_KG_DIRECTIVE`) → L1 primed dispatch (probe-family seam mirror, staged manifest + sha-bound roster, side-channel row `primed:true/directive:"kg_context"`) → L2 in-box recall (settled "ok"; box-env DD-16 forensics pre-destroy; kg_recall verdict via the harvested `trace/trace.db` worker_output seam — marker AND recall witness, both required) → L3 revoke-verified teardown (memgate-revoke + memgate-verify-revoked stderr lines REQUIRED, ordering revoke < verify-revoked < destroy from the round's own audit DB) + the unskippable five-probe battery in `finally` + AC7 audit walk + full cleanup verdicts through `settleRun`.
- `scripts/e2e/memory-negative-probes.ts` — the host-side battery: mint plane via M2.1's library surface (`memgateDeps`/`mintRunMemoryKey`/`revokeRunMemoryKey`, admin-gated, shared-ledger required), probe plane raw HTTP at the gateway origin, five probes (`no-auth|cross-run|bank-allowlist|ttl|revoked`), consumer-side wire contract (`error.code` in-set = named refusal), `mgrun-` scrub self-fail. Unit suite: 6 pass against a stub origin driven by the SHIPPED `verifyRequest` refusal ladder.
- `config/rosters/memory-live.roster.yaml` — proven T2 pair (lead haiku-4.5 / fixer deepseek-v3.2), kg-recall grant on the credential-carrying role, explicit `tools: ["read","grep","bash","kg_recall"]` (never null), `writes: []` (least privilege).

## Preconditions to clear (in order)

1. **CI publish chain repaired.** dev's `Publish exedev boot image` fails its own R3-a TOFU guard: `@openrig/cli@0.5.14`'s caret floats (hono 4.13.13 published 2026-10-08T05:35Z, zod 4.6.5 published 2026-10-02) moved the `/opt/openrig` tree to `9f148862…`; the ARG is re-pinned to the measured value on this branch with full provenance. After merge, the dev publish run should build green; then complete the ritual: `bun scripts/adopt-image-pin.ts <run-id>` on dev (one commit moving `DEFAULT_IMAGE_REF` + `DEFAULT_IMAGE_BUILD_ID` + the walk digests), which also turns the 2 red `buildIdFileInputs` tests green. The `verify-image-pin` red on dev (image at `ee802669…` carries no attestation; `MANIFEST_UNKNOWN` to anonymous pull) clears through the same healed publish + attest.
2. **M1.2's T2 round fired** (story prerequisite: "M1.2's own evidence leg green before the round"). Runbook: `_bmad-output/reviews/m1-2-t2-handoff.md` — its four inputs (image pin, memory env, exe.dev env, GO) are the same inputs this round needs.
3. **Memory gateway env on the firing host:** `QDS_KG_GATEWAY_URL` (the Caddy-fronted m2-gateway origin — never :8888/:18889, `forbiddenOrigin` traps both), `MEMGATE_ADMIN_KEY`, `QDS_MEMGATE_SIGNING_KEY`, and **`QDS_MEMGATE_LEDGER` pointing at the ledger the DEPLOYED gateway reads** — the battery's mint plane must share the gateway's ledger or every authenticated probe comes back `no-auth` (unknown-key) instead of the intended per-class refusals. This co-location is a deployment precondition no code can verify; the round fails loudly (not misleadingly) if it is violated.
4. **exe.dev env:** `QDS_EXEDEV_REPO_URL` (a pushed scratch repo per the df5-3 convention), `QDS_EXEDEV_SHA` = the pushed merge-commit SHA **carrying `config/rosters/memory-live.roster.yaml`** (the in-box `spec.roster` load reads the pushed tree; L1 verifies with `git cat-file` pre-spend), `QDS_EXEDEV_ROSTER` (presence-checked; the dispatch arm derives the roster from the manifest dir).
5. **Operator GO for spend.** Worst case, printed by L0 and persisted in the spend evidence: 1 box, leg-sum ceiling 8.7 Mms ≈ 2.42 h at 230,000 µ$/h + 1 key capped 50,000 µ$ ≈ **$0.61 worst case**; realistic < $0.15.

## Then fire

```bash
QDS_E2E_LIVE=1 QDS_E2E_TIER=2 \
QDS_EXEDEV_REPO_URL=… QDS_EXEDEV_SHA=… QDS_EXEDEV_ROSTER=$PWD/config/rosters/memory-live.roster.yaml \
QDS_KG_GATEWAY_URL=… MEMGATE_ADMIN_KEY=… QDS_MEMGATE_SIGNING_KEY=… QDS_MEMGATE_LEDGER=… \
HINDSIGHT_BASE_URL=… HINDSIGHT_BEARER_TOKEN=… \
OPENROUTER_PROVISIONING_KEY=… \
bun test tests/fleet/e2e/memory-combined.live.test.ts
```

Operator notes: pre-check `.sandbox/fleet.lock` (holder-dead → rm) per the live-e2e gotchas; run in an unsandboxed shell; assert the output has ≥1 `(pass)` (exit 0 with zero passes is a misconfigured run, never green); each leg writes its own scrubbed JSON to `_bmad-output/evidence/memory-live/`; cleanup (box, keys, probe banks, workspaces) is armed in `finally` on the pass/fail paths ONLY — a SIGINT mid-test skips `finally` entirely and requires manual cleanup (`ssh exe.dev ls --json` + destroy survivors by hand; see Known limitations below) — and is machine-checked via `keyLeakProblems`/`fleetCleanupProblems`/`settleRun`.

## Known limitations, recorded honestly

- **AC3's observability sub-claim is met at the evidence level available today**: the in-box kg_recall verdict asserts the worker's structured output quoting BOTH the marker AND the round's recall witness (a token seeded only into the retained memory content — its presence proves real kg_recall output, the marker alone being an echo hole since it sits verbatim in the task prompt). The extension's richer stderr events (`kg_recall.call`, `refused:<reason>` + clientMs, `truncated`) are **unobservable on green rounds** — team-lead-driver discards worker stderr on success. Filed as **#417** (candidates: TLD stderr tee / per-run raw-capture env / NDJSON-native extension events); the driver's stderr scan stays record-only and lights up when #417 lands.
- **Interrupt-path cleanup** (DoD names pass/fail/interrupt): `finally` covers pass/fail; SIGINT mid-test skips it (repo-wide property, memory-cycle identical). Operator mitigation post-interrupt: `ssh exe.dev ls --json` + destroy survivors by hand.
- **roster-check preflight** refuses the round on ANY nonzero exit (DoD letter: green before fire); a host missing the pi binary or `OPENROUTER_API_KEY` cannot fire until fixed.
- **roster-fix drift risk at fire time**: the sha-bound compare proves the working-tree fixture == the pinned-SHA fixture; keep the fixture untouched between merge and fire (or re-fire from a fresh SHA).

## Review ledger

Round 1: 16 findings → 13 patched (incl. 2 BLOCKERs: L2 EISDIR on nested artifact dirs; L3 scratchClone collision killing AC4/AC7) · 1 dismissed · 2 deferred (→ #417 + this doc).
Round 2: 12 findings → 11 patched (incl. BLOCKER: manifest budget 741k > 600k → 900k/960k; HIGH: tautological roster compare → sha-bound; HIGH: marker echo → dual-requirement seam) · 1 dismissed (verified cites).
Round 3: 12 findings → 9 patched (incl. HIGH: documentId limb unreachable → frameAsData header discriminator; HIGH: roster-check staged-path confinement → in-repo fixture + any-nonzero-refuses) · 3 dismissed (verified cites).
Reports: `_bmad-output/reviews/m2-3-round{1,2,3}/` (reports/ + triage.json + fixes-*.md).
