# P0.5 / P0.9 Closure Evidence Plan

**Status:** DRAFT — repo-side plan only; execution waits on the Vultr VPS milestones in
`2026-09-30-vultr-vps-deploy-runbook.md` §5–§7. Nothing here runs until the box exists.
**Prep basis:** read-only agent inventory 2026-09-30; evidence pack
`_bmad-output/sprint-artifacts/p0-5-p0-9-dod-reconciliation.md` (§3 P0.5 per-item, §6 P0.9, §7 policy,
§8 open questions); issue #51 is CLOSED (it created the 2026-07-28 `done→in-review` downgrade — no reopening needed).

## Targets

- `sprint-status.yaml:124` P0.5 → `done`, `:128` P0.9 → `done` — with per-item evidence, never
  by waiver (option B-via-evidence; §7's waiver path stays the maintainer's policy call).
- DD-4 (`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md:50`) updated: OQ-4
  confirmed resolved on x86_64 Linux.
- Reconciliation doc gains an "Update 2026-09-XX" block mirroring its existing 2026-07-28 pattern.

## Evidence house style

`_bmad-output/evidence/p0-5-closure/` and `_bmad-output/evidence/p0-9-closure/` — one timestamped
machine-checkable JSON per leg, `openrig-sc2/` naming
(`2026-09-30T…-p0-9-hindsight-live.json`), payloads `exitCode/stdoutTail/stderrTail` + structured
observability lines (`requestId/operation/timestamp/durationMs/status`). Machine-checked > prose
(PR #388 convention). Each leg JSON is written by the leg's own driver script, not hand-copied.

## P0.9 — all five open items settle on ONE wall (Hindsight never booted)

Precondition: runbook §5 (Hindsight healthy on the VPS) + §6 (CLI + qds- banks).

| Leg | Evidence file | What it proves | Command shape |
| --- | --- | --- | --- |
| hindsight-live | `…-p0-9-hindsight-live.json` | Hindsight boots on x86_64 Linux — OQ-4 wall gone; health 200 | `curl` :8888 in-network / :18889 host, `docker compose ps` |
| provision-and-import | `…-p0-9-provision-and-import.json` | three qds- banks exist; Mulch imported into `qds-factory-dev-meta` | `bun scripts/provision-hindsight-banks.ts` + `bun scripts/import-mulch-expertise.ts` |
| round-trip-via-bridge | `…-p0-9-round-trip-via-bridge.json` | AC1 (make-or-break): retain→recall→reflect→consolidate through SwarmClaw's MCP `/invoke` on `resolveBankId(repoSlug)`; AC2 recall `sparc` from `.mulch/expertise/qds-foundations.yaml` < 5 s | one `/invoke` driver script per verb |
| negative-probes | `…-p0-9-negative-probes.json` | AC3 non-existent bank → `MCPInvokeErrorResponseSchema` HTTP 502; AC4 bridge unregistered → `-32001`, zero banks; AC5 unavailable → `-32002`, zero banks | run provisioner probe with bridge deregistered / container stopped |
| idempotency-rerun | `…-p0-9-idempotency-rerun.json` | DoD 10/11: recall idempotent; no partial bank creation on failed provision | re-run provision twice, diff bank lists |

These settle P0.9 DoD 5 (split proof), 7 (recall assertions), 9 (MANDATORY e2e), 10, 11.

**Operator flags to settle BEFORE the round** (one-line decisions, recorded in the reconciliation
update block):
1. AC5 probe semantics — "Hindsight binary not on PATH" wording predates the Docker sidecar; the
   negative probe stops the CONTAINER (decide + annotate; do not edit the AC).
2. Transport — P0.7/P0.9 contracts assume stdio (`hindsight-local-mcp`); live platform Hindsight is
   streamable-HTTP `:8888/mcp` (DD-5 records the broken premise). The e2e drives the **HTTP**
   endpoint; annotate the AC rather than re-litigate DD-5.
3. Bank discipline — shared platform Hindsight has NO auth and NO per-bank auth; pin explicit
   `qds-` bank IDs; 18889 never public.

## P0.5 — four legs need a live agent substrate, one is editorial

Precondition: runbook §7 box + a Pi agent with working LLM auth (OpenRouter key on the box),
plus gitleaks **or** trivy installed.

| Leg | Evidence file | Settles | Shape |
| --- | --- | --- | --- |
| mode-json agent e2e | `…-p0-5-mode-json-agent-e2e.json` | DoD 9 (MANDATORY, "never run, LLM auth") + DoD 4 (payload on `--mode json` stdout, not MCP stdio) | Pi agent `--mode json` against a TS file with a planted type error → `lsp_diagnostics` JSON ≥ 1 finding, stable `aw:<hash>` IDs |
| secret-scan emit-block | `…-p0-5-secret-scan-emit-block.json` | DoD 6/8 (NFR-SEC-3 + INV-1) — never observed; block derives SOLELY from gitleaks/trivy `sessionSecrets` findings | agent turn over a hardcoded-API-key file → turn-end emit BLOCKED with `secret_detected` |
| python-lsp discovery | `…-p0-5-python-lsp-discovery.json` | DoD 5 (pyright ran as fixture only) | real assertion: pyright LSP discovery on a planted Python type error |
| version pin | (spec edit, no evidence file) | DoD 1 — **editorial**: spec says 3.8.47, installed 3.8.71; P1.7 says do not re-pin → amend the spec TEXT to name the floor+observed pair | one-line story/spec edit, `[OPERATOR]` sign-off per reconciliation §8 Q4 |

## Execution order

1. Runbook §1–§7 (operator GOs) → VPS milestones exist.
2. P0.9 legs (they only need the box) → flip P0.9 DoD `[x]` citing artifacts → status `done` →
   reconciliation update block → **DD-4 updated**.
3. P0.5 legs (need agent substrate + scanner on the box) → same flips.
4. Sprint recount + the Phase-3 derivation session picks up from a clean phase-0 board.

## What this plan deliberately does NOT do

- No waiver path (§7 option A stays the maintainer's; this plan is option B-via-evidence).
- No AC edits on P0.9 (flags are annotated, not rewritten).
- No 18889 exposure, no shared-bank writes outside `qds-` IDs.

## M1.1 annotation — transport re-home onto the dedicated instance (2026-10-03, authored; nothing executed)

The M1.1 story (`_bmad-output/sprint-artifacts/dark-factory-v6/stories/m1-1-dedicated-hindsight-vps.md`,
Deviation 1 / AC5) re-homes this plan's P0.9 legs onto Z4's dedicated Hindsight instance. Authored
only — nothing below has been executed on any box; every leg still waits on the runbook's operator
GOs. The plan's ACs above stay byte-identical (INV-MEM-4: annotate, never re-litigate).

**Deviation 1 / DD-17 — round-trip-via-bridge + negative-probes re-homed.** These two legs were
written 2026-09-30 against the SHARED platform Hindsight via SwarmClaw MCP `/invoke` (the leg
table's "through SwarmClaw's MCP `/invoke` on `resolveBankId(repoSlug)`" round-trip cell and the
negative-probes row's `MCPInvokeErrorResponseSchema` cell). Under D-2 the dedicated instance has no
`/invoke` surface to call. The legs' AC SEMANTICS — round-trip order (AC1
retain→recall→reflect→consolidate; AC2 recall `sparc` from
`.mulch/expertise/qds-foundations.yaml` < 5 s), negative refusals with zero banks, idempotent
provision — execute unchanged over the bank-scoped REST the factory client already speaks
(`src/hindsight/client.ts`, `src/hindsight/round-trip-verifier.ts`). The re-homed round-trip leg
writes THIS plan's evidence filename (`…-p0-9-round-trip-via-bridge.json`) so the leg table keeps
resolving; the driver is `scripts/p0-9/round-trip-dedicated.ts`. This records the transport flag's
own decision — "annotate the AC rather than re-litigate DD-5".

**Refusal vocabulary superseded on the REST transport.** The AC text's MCP-era `-3200x` codes
resolve on this transport as follows. `-32001` is `ERR_MCP_BRIDGE_NOT_REGISTERED`
(`src/hindsight/schemas.ts:161`) — the SwarmClaw bridge-registration gate the AC4 probe exercised;
on this transport the bridge itself is gone (DD-17), so that gate resolves as direct instance
availability (the negative-probes health/`listBanks` reach), never as a wire code. A REST 404 for
a non-existent bank (profile/stats reads; recall answers 200-empty — 0.10.0 has no
bank-existence check on the recall path) is recorded as its own REST observation, NOT as a
`-32001` resolution. The `-32002`-class (unavailable instance) → 502 / `fetch_failed` / 408
timeout (`src/hindsight/client.ts:79` shapes). The `-3200x` WIRE refusal codes are superseded
here, with ONE carve-out: the provisioner's internal all-collide envelope (`ERR_BANK_COLLISION`,
`-32005`, `src/hindsight/schemas.ts:165`, emitted at `src/hindsight/bank-provisioner.ts:437`/`:461`)
remains authoritative for the idempotency leg's collision-exhaustion shape.

**§6.3 origin supersession (recorded, not re-edited).** The runbook §6.3
`HINDSIGHT_BASE_URL=http://127.0.0.1:8888` line is superseded by Z4's runbook annotation +
DD-28.22 (dedicated instance host-side = `127.0.0.1:18890`, compose-side `hindsight-qds:8888`).
Recorded here because this plan's drivers read the env by name and resolve neither stale value:
`127.0.0.1:8888` on-host is the shared-sidecar origin — the wrong-instance shape the story's AC1
negative control fails.

**Docker-era wording note.** Where the negative-probes row says "bridge deregistered", the
REST-transport probe stops the CONTAINER (the row's wording predates the compose topology — the
probe-semantics flag's "predates the Docker sidecar" note); the evidence records the
unavailable-instance refusal class either way.

**Driver-to-leg mapping.** Per the house-style rule above (each leg JSON written by the leg's own
driver, never hand-copied), the M1.1 drivers are:

| Leg | Driver |
| --- | --- |
| hindsight-live | `scripts/p0-9/hindsight-live.ts` |
| provision-and-import | `scripts/p0-9/provision-and-import.ts` |
| round-trip-via-bridge | `scripts/p0-9/round-trip-dedicated.ts` |
| negative-probes | `scripts/p0-9/negative-probes.ts` |
| idempotency-rerun | `scripts/p0-9/idempotency-rerun.ts` |
| auth-retired-check (story-added sixth) | `scripts/p0-9/auth-retired-check.ts` |
