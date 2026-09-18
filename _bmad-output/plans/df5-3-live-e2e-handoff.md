# DF5.3 live e2e handoff — walk a real merged factory PR (node-1.2 N6, deferred by operator 2026-09-16)

Fresh-session prompt below. Everything referenced is merged on `dev` by the DF5.3 PR.
Governing procedure: the `qds-live-e2e` skill (read it FIRST — hard rules, spend protocol, gotchas).

---

## The prompt

```
/qds-live-e2e DF5.3 N6 — produce and walk a real merged factory PR.

Context: DF5.3 (audit chain) is merged; `bun scripts/qds-audit.ts` walks a PR back
through ten host-side hops. The DoD's mandatory e2e demo was deferred by the
operator (2026-09-16, plan rev 3 handoff): no factory-produced PR exists yet —
this round creates the FIRST one and walks it.

Target: a NEW scratch repo in the Quantum-Digital-Solutions org (e.g.
`qds-audit-demo`) — create it with `gh repo create`, seed one commit, clone
beside the factory. Do NOT target QDS-Factory itself.

Round shape (production verbs, not a test file):
1. Preflight: `ssh exe.dev whoami` works; `.env` carries
   OPENROUTER_PROVISIONING_KEY; `.sandbox/fleet.lock` absent or holder-dead;
   `uptime` + disk sane (gotcha #5). Print worst-case spend estimate and get
   explicit operator "go" before anything billed.
2. Env (skill §Gating): QDS_E2E_LIVE=1, QDS_E2E_TIER=2,
   QDS_EXEDEV_REPO_URL=<scratch repo>, QDS_EXEDEV_SHA=<pushed dev SHA>,
   roster = the proven T2 pair (config/rosters/roster.yaml) — note dispatch
   derives the roster from dirname(manifest)/roster.yaml, NOT the env var.
3. Manifest: a minimal pipeline manifest whose engine work completes quickly
   (single small phase; budget math per gotcha #7) and whose brief targets
   the scratch repo so the run's commits + PR are scoped to it.
4. `bun scripts/fleet.ts dispatch …` (real box, real OpenRouter). On success:
   `fleet reverify` (host-side green verdict), then the DF3.4 approval gate
   (`fleet approve` / approval-gate verb), then `bun scripts/fleet.ts push`
   (DF5.2's pushVerifiedSha path — with the AC7 strict preflight: decidedAt
   must be STRICTLY after the bound report's completedAt).
5. Merge the PR (`gh pr merge --squash`), confirm merged state.
6. THE DEMO: `time bun scripts/qds-audit.ts <merged-pr-url>` — assert ten
   typed hops, zero nulls, hop 10 void with the OQ-4 reason verbatim, µ$
   cost total + perRole (hasTokenRows true — DF2.12 bridge), exit 0,
   wall < 30 s. Also capture `--json` and assert it parses as ChainReport.
7. Evidence: capture BOTH outputs (human + --json) into
   _bmad-output/evidence/df5-3/ with the run id, PR URL, image stamp, spend
   totals, and the `--json` chain. Run the round's teardown path so
   teardown/reap links exist; a SECOND walk must still be complete (digest
   rows stable, no evidence-mismatch).
8. Also prove the negative: point --audit-db at a missing path → typed
   audit-store-absent, exit 1, file still absent.

Gotchas that will bite (from the skill): #1 cwd drift (absolute paths), #4
fleet lock after bun test, #10 shell-timeout kills leak boxes (foreground,
max timeout), #16 zero-pass green = misconfigured run, #17 unsandboxed shell
required. Record every phase in evidence; end-of-round checklist per the
skill (no leaked boxes/keys, spend within caps).
```

---

Deferred-by authority: operator session 2026-09-16 (unlazy scope `df5-3`,
inventory row C10, node-1.2 N6). Code PR + full offline verification landed
without it; this round is the only thing between the story and its DoD.
