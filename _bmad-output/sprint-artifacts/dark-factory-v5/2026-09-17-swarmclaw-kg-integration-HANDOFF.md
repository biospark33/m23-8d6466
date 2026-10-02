# HANDOFF — QDS-Factory: finish v5, then SwarmClaw + Knowledge-Graph integration

> Written 2026-09-17 after the SwarmClaw-drop investigation session. Paste the body below
> into a fresh session to resume. Re-sync live state before acting — waves move fast.

## STATUS UPDATE 2026-10-01 — read FIRST; operator ruling: v5 closed, ops deferred, pivot to swarmclaw integration

**v5 is CLOSED** — 42/42 stories / 169/169 pts (PR #399 → 5feaeec6; close-out recorded in
`sprint-status.yaml`'s dated header block).

**OPERATOR RULING 2026-10-01 (evening): all remaining ops are DEFERRED, documented, not
abandoned. Zero agent spend on any of these until the operator re-opens them:**

1. **Image-pin CI red** (two conditions, both gathered 2026-10-01):
   - `base-drift` job: pinned exeuntu base `ea6c3f5c…` vs upstream `c811379e…` — fires BY
     DESIGN on upstream's weekly no-cache rebuild; the job's own output says NOT an incident.
   - `verify (default)` job: `DEFAULT_IMAGE_REF` `ee802669…` is MANIFEST_UNKNOWN on GHCR —
     measured in CI (#397) but not visible/published; no provenance, no exception-register
     entry. Real red on every dev push until the full re-pin ritual (re-pin base → rebuild →
     re-sweep → publish via publish-exedev-image.yml → adopt in driver.ts) or a documented
     exception. `scripts/adopt-image-pin.ts` + the #396–#398 precedent are the adoption path.
2. **Vultr VPS deploy** (swarmclaw platform + Hindsight + factory host CLI) — plan of record
   stays `_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md` + companion closure
   plan. No provisioning by agents; box state and every `[OPERATOR-GO]` gate await the
   operator.
3. **G5 pairing round** — DEFERRED-by-operator-arrangement per `.unlazy/df3-6b/GATES.md`
   (env needed from operator: `QDS_E2E_FIX_PR` + records dir + `fix-scope.json`).

**THE PIVOT: next program = factory ↔ zeropoint/swarmclaw integration** — the
factory/OpenRig pieces fired off by swarmclaw DAGs via the CLI/adapter. This BROADENS the
already-live narrow form rather than starting from zero: ADR-1 (PR #387, operator-signed)
approved the SwarmClaw `external_job` adapter driving `factory_run` over the fleet CLI
substrate, and SC2.6/SC2.7 proved it live end-to-end (evidence
`_bmad-output/evidence/openrig-sc2/`). The v6 derivation session (Phase 3 below) is the
entry point — its Epic S re-derivation writes against this exact substrate reality.

**Deployment template note (operator):** once the integration lands, the Solstice
vultr-deploy deployment (`/Users/steve/Solstice/.claude/worktrees/vultr-deploy` @ d0c513fa,
`deploy/control-plane/{Caddyfile,docker-compose.yml,backup.sh}`) is the intended TEMPLATE
for the real-infra deployment of the integrated stack. It informs the deferred VPS work —
do not treat the QDS runbook and that template as independent deployables when the pivot
lands.

## STATUS UPDATE 2026-09-30 — read SECOND; the 2026-09-14 snapshot and the plan below are 13 days stale in five places

**Stale flags (this doc says → what is now true):**

1. "9 ready-for-dev" → **6 of the 9 DONE**: DF3.6a, DF3.7, DF3.8, DF5.3, DF5.4, DF6.1a all merged.
   Remaining: **DF6.1b, DF5.5, DF3.6b**. Both watch items held (DF5.3 shipped lib-separable,
   PR #258; DF3.6b re-pin correctly not batched).
2. "NOT approved now: Tier C" → **partially superseded by ADR-1** (ACCEPTED, operator-signed
   2026-09-30, PR #387): the SwarmClaw `external_job` adapter driving `factory_run` is the
   approved narrow form — fleet CLI stays the substrate, D6 intact, front door unchanged.
   Full Tier C drift (events→platform UI, reversing D6) is still out.
3. The OpenRig integration program (docs/planning/2026-09-24-openrig-integration-roadmap.md)
   is **COMPLETE and CLOSED** — ran between this doc's writing and now: SC1 protocol-engine
   fixes (swarmclaw PR #644), SC2 external_job adapter LIVE GREEN end-to-end (SC2.6 + SC2.7,
   11-round evidence `_bmad-output/evidence/openrig-sc2/`), #380 `w:` work-key namespace
   (sanctioned spend booking for issueless macro processes — ADR-1 shape), #382 poller race
   closed (one daemon straight through observe → approve → branch), SC2.7 evidence
   hardening (PR #388: machine-checked key-count / fleet-empty / delivery artifacts, first
   exercised by the next live round). DD-7's "dormant-retained for step 6" premise is stale:
   swarmclaw is awake as protocol orchestrator over the factory adapter.
4. New blocker: **GitHub Actions billing outage** (2026-09-30 ~15:20Z, repo-wide — "recent
   account payments have failed or your spending limit needs to be increased"; zero steps
   start). Merged PRs #384–#388 rode it via `--admin`. Blocks: all CI, and DF3.6b's image
   publish workflow. Operator fix required.
5. Epic S sketch (Phase 3 below) is stale: S2's approval pings + run-status/notify and S3's
   path now have a LIVE substrate (SC2 protocol branch → `factory_result` artifact →
   `branch_taken` witness; scrypt-gated `fleet approve` proven end-to-end). Epic M1's `qds-`
   prefix discipline has a landed precedent (the `w:` namespace). Derivation session writes
   against THIS reality, not the 09-17 sketch. Also reconcile: the never-scheduled P2
   phase-2 memory epic (13 stories, `_bmad-output/sprint-artifacts/phase-2/README.md`)
   overlaps the M-ladder — fold or supersede there.

**The finish-line checklist:**

Phase 1 — v5 complete (in order):
- [ ] **DF6.1b** fix-loop CI verdict + attempt budget + escalation — UNBLOCKED (DF6.1a ✓,
  DF5.3 ✓), zero box/key/model spend. Dev via qds-dev with /unlazy acceptance gates.
  Cite #383's live-proven approval park in the evidence instead of hedging against it.
  Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md`
- [x] **DF5.5** KEEP-repoint chore — applied LAST per its own spec. PRE-DEV: reconcile its
  own Amendment D (SwarmClaw role line) with ADR-1 + the SC2 external_job reality; candidate
  boundary statement to pin: `SWARMCLAW_FACTORY_FLEET_CLI` — swarmclaw never learns QDS's
  driver grammar; `--driver exedev` lives only in the deployed wrapper. Story:
  `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md`.
  DONE 2026-10-01 — PR #391 squash bbce9b24; Amendment D re-texted per ADR-1 with operator
  approval at the pre-dev gate (the SWARMCLAW_FACTORY_FLEET_CLI boundary is IN the landed
  blockquote); p1-18:50 found pre-discharged by DF6.1a; regression test + e2e demo green.
- [x] **DF3.6b** resident MemoryMax — DONE 2026-10-01. The gates fell in sequence: billing fix
  closed (CI green), the full re-pin ritual completed (#396–#398, 2026-09-30 — the pinned image
  ships `Delegate=memory`), and the live tier round ran GREEN in PR #399 (Leg A
  `qds-20261001-5fb45a`: kernel OOM-kill at peak = the 128 MiB bound to the byte, placement
  membership off real kernfs, deterministic completion; Leg B `qds-20261001-d55b3c`: pi baseline
  126.3 MiB measured, 512 MiB default stands with 4.05× headroom, no re-set, no pin movement).
  v5 slate 42/42. Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/` (df3-6b)
- [x] After each merge: flip the sprint-status.yaml row, prune the branch. v5 DONE when 0 open DF rows.
  DONE 2026-10-01 — PR #399 squash-merged 5feaeec6; DF3.6b row was flipped at close-out (row
  already `done` pre-merge, cross-check ZERO not-done); branch pruned local+remote (G8-OK);
  dev synced to origin/dev @ 5feaeec6. **v5 slate: 42/42 — SPRINT CLOSED.**

Phase 2 — ops, PARALLEL, anytime (operator account-level steps; agents prep/verify only):
- [x] GitHub Actions billing fix (payments / spending limit) — unblocks all CI + DF3.6b.
  VERIFIED FUNCTIONAL 2026-10-01: scheduled + dispatched + push-triggered workflow runs
  execute again (verify-image-pin runs 36867088005 / 36884830294 / 36890064163 all ran
  to completion with logs). Their FAILURE verdicts are a separate, known condition — the
  base-drift watcher firing on the weekly exeuntu rebuild (by design) plus the pin
  provenance check — tracked as the post-v5 image-pin item, not a billing symptom.
- [ ] Vultr VPS deploy: swarmclaw platform + Hindsight sidecar (compose exists) + factory
  host CLI (~1–3 days). Closes P0.5/P0.9 (the two stuck `in-review` rows), confirms OQ-4,
  updates DD-4.
  PLAN OF RECORD 2026-09-30: `_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md`
  (+ companion `_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md`). 2026-10-01:
  plan presented to operator; box state + every `[OPERATOR-GO]` gate in the runbook
  await explicit operator word — nothing provisioned by agents.

Phase 3 — after both:
- [ ] Step-6/v6 derivation session (half-day): Epic S re-derived vs the SC2 substrate,
  Epic M1/M2/M3, Tier C vs ADR-1 reconciliation, P2-vs-M-ladder fold, DD-5 stdio→HTTP fix,
  D8 amendment, in-repo chassis fate. Input doc drafted on request (see bottom of this doc).

## Who you are / where this stands (verified 2026-09-14, re-sync before acting)

Repo: /Users/steve/QDS-Factory (Bun/TS). This session's investigation CLOSED OUT a strategic
question: "did v5 drop the SwarmClaw integration, and what does getting it back cost?"
Answer is settled; do not re-litigate. Full findings + plan below.

**Current status line (re-verify on pickup — waves move fast):**
- Sprint: dark-factory-v5, 42 stories / 169 pts; as of 2026-09-14: 33 done, 9 ready-for-dev,
  0 in dev. Authoritative: `_bmad-output/sprint-artifacts/sprint-status.yaml`
  (note: its meta block was stale — claimed 37/151; live rows recount 42/169; DF5.5's
  DoD gate fails pre-flight until meta fixed).
- Campaign state: Wave 9 fresh-verify DONE, NOT CONVERGED (48 findings: 2B/4H/10M/32L).
  DF3.8 + DF5.5 converged. Next: (3a) Wave-9 fix wave sequential units A→E
  (scope 2B+4H+6C2+11C3), (3b) Wave-10 fresh verify until C4-dominant, (3c) dev the 9.
  Read: `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-14-wave10-HANDOFF.md`
- PR #255 open → dev (wave evidence + tracker). Git user biospark33. Branch convention:
  prefix feature/ base dev target dev.

## Frozen decisions from prior session (user-approved)

1. **The 9 remaining v5 stories ship AS-IS. Zero spec modifications.**
   DF3.6a, DF3.6b, DF3.7, DF3.8, DF5.3, DF5.4, DF5.5, DF6.1a, DF6.1b.
   Rationale: v5's shape (one-shot CLI verbs, disk state, host-side authority) IS the
   integration contract for everything below. Nothing built gets undone.
   Two implementation watch items (NOT spec edits):
   - DF5.3: keep walkAuditChain/recordAuditLink lib-separable (DD-7 wants HTTP wrapping later)
   - DF3.6b image re-pin: M2 (below) triggers another one later; mechanical, don't batch
2. **SwarmClaw = the PLATFORM repo /Users/steve/swarmclaw** (active, full runtime: org-chart
   UI, heartbeats/schedules, delegation, protocol runs, approvals API, 23+ providers).
   NOT the abandoned in-repo chassis QDS-Factory/src/swarmclaw/ (4 routes, in-memory,
   orphaned — only library reuse + gate probe p0-7; decide its fate at derivation: retire
   / gate-fixture / DD-7 query surface).
3. **Factory deploys to a Vultr VPS/VM** (not the operator Mac): SwarmClaw platform +
   Hindsight sidecar + factory host CLI together. This dissolves OQ-4 (Hindsight never
   booted — arm64-mac libpq/openssl wall + local :8888 Jupyter clash; x86_64 Linux is fine)
   and closes P0.5/P0.9 (issue #51, zero live assertions).
4. **Factory agents get the knowledge graph** via the M-ladder below.

## Ground truth (verified, with refs — re-ground here, don't trust memory)

### What happened to SwarmClaw in v5 (documented, deliberate — 2026-08-11)
- `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`: DD-7 — "SwarmClaw =
  host-side service chassis… NOT the factory front door… dormant-retained for step 6";
  DD-1 — "operator-CLI-only… the operator is the channel".
- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`: D2 (no DAG),
  D3 (front door = tier-1 Claude Code + fleet CLI), D6 (SSSF-ported TS phase engine),
  D8 (one-secret-per-box, no push cred in box), §6.3 egress unfenced (exe.dev has no
  per-VM egress control), §5.3 run flow ends "→ memory capture into Hindsight banks" (step 6).
- `2026-08-14-df-v5-autonomy-horizon-review.md`: v5.0 stays pull-driven; future autonomy
  enters "as new D-numbers through the normal review flow — never as quiet scope growth."
- Phase-2 memory epic (13 stories incl. P2.4 swarmclaw DAG-node capture): authored
  2026-06-19, NEVER scheduled/built. `_bmad-output/sprint-artifacts/phase-2/README.md`.

### Factory seams (what integration plugs into — all verified in code)
- Front door: `bun scripts/fleet.ts <verb>`; closed registry `src/fleet/verbs.ts:73-431`
  (dispatch|status|harvest|teardown|fanout|rank|approve|reject|attach|enrol|unlock|run);
  exit codes 0–6; stdout=output, stderr=JSON.
- Engine runs IN-BOX: systemd qds-run@<id> (transient, Restart=no) → /usr/local/bin/qds-engine
  → scripts/pipeline-run.ts; terminal marker /run/qds-run/<id>/journal/final.json.
- Resident = prompt oracle (one zod SteeringDirective, src/phase-engine/steering.ts:5-8).
  Workers = pi subprocesses; TOOL GRANT MECHANISM = pi extensions `-e <path>` + skills
  (cli-anything/scripts/team-lead-driver.ts:376-401). cli-anything has NO MCP client.
- Steering: /run/steering tmpfs, host writes inbox.ndjson (8k fold budget), box acks only.
- Host-side Hindsight REST client EXISTS: src/hindsight/client.ts (bank-scoped
  retain/recall/reflect/consolidate) — NOT in box image COPY set (Dockerfile:277-305).
- Hard constraints: one-secret-per-box (D8); INV-IBOX-1 no creds in image layers;
  assertNoResidentCredentials on briefs (scripts/pipeline-run.ts:1064, called :3225);
  CHILD_ENV_ALLOWLIST (src/fleet/resident.ts:237-252); F10 nothing in-box trusted at
  boundary; new box files move deriveBuildId → full re-pin ritual (Dockerfile:53-57).
- No host daemons/cron/launchd exist. github.ts:199-204 has documented non-keychain
  stdin fallback (VPS-safe).

### Platform KG (live-verified 2026-09-14 on operator Mac)
- Hindsight = self-hosted sidecar ghcr.io/vectorize-io/hindsight:0.8.6,
  docker-compose.yml:220-230; internal http://hindsight:8888; host 127.0.0.1:18889.
- **Native streamable-HTTP MCP endpoint: POST http://<host>:18889/mcp — 28 tools**
  (retain/sync_retain/recall/reflect, bank CRUD, entity-graph, mental-models…).
- DANGER: server answered 200 with NO auth header; bank_id is a per-call arg, NO per-bank
  auth — any reaching client can stomp tenant banks (2026-08-11 foreign-bank incident
  precedent). NEVER expose 18889 publicly as-is.
- Platform agents access in-process (reactive-grounding-extension.ts injects <kg_context>
  from POST .../memories/recall) — pattern to COPY for factory M1.
- Bank families: solstice-l2-<tenant>, solstice-soul-*, solstice-agent-*, solstice-meta,
  solstice-l3-*. Factory MUST use its own `qds-` prefix, explicit bank_id every call.
- Config: SOLSTICE_HINDSIGHT_BASE_URL, SOLSTICE_HINDSIGHT_BANK_PREFIX, Bearer
  HINDSIGHT_API_TENANT_API_KEY (solstice-config/index.ts:284-291), hindsight.env gitignored.

## The plan (order matters)

**Phase 1 — NOW: finish v5, untouched.** Wave-9 fix (A→E) → Wave-10 verify → dev the 9
via qds-dev, dependency order per yaml edges (DF3.6a ≺ DF3.6b, DF6.1a ≺ DF6.1b, DF5.5 LAST;
fix stale yaml meta first). Two watch items above. Nothing else.

**Phase 2 — PARALLEL, anytime (ops, not stories): Vultr deploy.** VM runs SwarmClaw
platform + Hindsight sidecar (compose exists) + factory host CLI. Then: close P0.5/P0.9,
confirm OQ-4 resolved, update DD-4. ~1–3 days env work.

**Phase 3 — AFTER both: step-6/v6 derivation session (~half-day spec work).** Writes,
through the repo's normal adversarial-review pipeline: DD-5 fix (stdio→HTTP), D8 amendment
(one provider secret + one per-run scoped memory key), in-repo chassis fate, and these epics:
- **Epic S — SwarmClaw drive+observe** (3–4 stories, ~10–13 pts): S1 platform agent skills
  over fleet verbs (DF3.5 verb registry = contract); S2 heartbeat jobs invoking DF3.8 sweep
  verb + DF6.1b CI poll + DF3.7 approval pings; S3 run status into chat/UI.
- **Epic M1 — KG priming+capture, host-side, zero in-box change** (2–3 stories, ~6–8 pts):
  qds- bank provisioning (scripts/provision-hindsight-banks.ts exists); dispatch-time recall
  → <kg_context> in brief; harvest-time retain.
- **Epic M2 — live KG in-box** (3 stories, ~11 pts): VPS memory gateway (per-run scoped key
  mint/revoke reusing DF2.3 machinery, pins qds- prefix, injects real auth in-network);
  pi extension kg_recall (thin REST beats MCP — no client exists; sanitized output, char
  budget, F10-treated) + roster grant + image re-pin; D8 amendment doc.
- **M3 — write-back from in-box** (~3–5 pts, later, via review harvester).
Total ≈ 8–10 stories / 25–30 pts (v5 was 42/169 — this is ~⅙).

**NOT approved now:** Tier B (events→platform UI — DF4.x SSSF visualizer already covers run
views), Tier C (factory as SwarmClaw protocol runs — reverses D6, months, full v6 decision
only). Don't drift into them.

## First actions on pickup
1. Re-sync: `git -C /Users/steve/QDS-Factory status`, read sprint-status.yaml (top note +
   live rows), and the STATUS UPDATE 2026-09-30 section above.
2. Report current delta vs. that section (NOT the 2026-09-14 snapshot below).
3. Resume Phase 1 at the first unchecked box (as of 2026-09-30: DF6.1b, unblocked, zero
   spend — dev via qds-dev with /unlazy gates; ops items run in parallel via subagents).
4. User may ask for the Phase-3 derivation-session input doc — draft only on request.
