# HANDOFF — QDS-Factory: finish v5, then SwarmClaw + Knowledge-Graph integration

> Written 2026-09-17 after the SwarmClaw-drop investigation session. Paste the body below
> into a fresh session to resume. Re-sync live state before acting — waves move fast.

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
1. Re-sync: `git -C /Users/steve/QDS-Factory status`, read sprint-status.yaml + latest
   wave HANDOFF in _bmad-output/sprint-artifacts/dark-factory-v5/, check PR #255 state.
2. Report current wave/sprint delta vs. the 2026-09-14 snapshot above.
3. Resume Phase 1 at wherever the campaign actually is (if wave-9 fix mid-flight, continue
   units per handoff; if done, wave-10 verify; if specs converged, dev phase via qds-dev).
4. User may ask for the Phase-3 derivation-session input doc — draft only on request.
