## Review round 11 — DF3.1 post-merge re-audit

**Context.** PR #123 merged 2026-08-23; since then DF3.2 (#128), DF4, DF5.1/5.2 landed on top plus TIER-2 live-fire e2e. This round re-audited PR 123's full diff (32,543 lines, reconstructed from `f1aa4db^1..f1aa4db^2`) **as it sits on current main**, to confirm the cornerstone still holds.

**Method.** 31 review agents in 3 waves (9 blind cynical, 9 edge-case hunters, 12 test-quality, 1 acceptance auditor) over 25 diff chunks ≤2,056 lines. **130 findings** across 10 clusters → triaged → fixed in 2 waves of parallel fixers on disjoint clusters → full gate.

**Auditor verdict:** every AC/DoD item implemented with evidence, no spec-level CRITICAL/HIGH gaps — implementation consistently stricter than story text (fail-closed direction).

### Key fixes (38 files, +4,116/−615)

| Theme | Fix |
|---|---|
| **Money fail-closed** | stale-witness downgrade deleted (undeclared+stale now REFUSES, was spawning at $0.50 default above reserved ceiling); unreadable witness typed refusal; late box-hours past retirement cutoff warns structurally; malformed issue ids refused (no unnameable full-cap identities); ingest errors carry `ledger-busy` taxonomy |
| **Persistence torn-state** | `create` publishes via temp→fsync→`link(2)` (partial write at final path impossible); publish-EEXIST carries final path → race loser = exit 2 `run-id-in-use`; ownerless aged lock corpses reclaimed; failed releases retry; temp sweep admit-lists own grammar (run-lock claim temps on shared dirs no longer reaped); future-dated mtimes never sweep; fsync probed at construction |
| **Destroy corroboration** | reaper requires tag AND generated-name grammar (or store record) — co-tenant `qds-sbx`-tagged `ci-runner-2` is report-only; `checkHeadroom` reads `listWithAnomalies` — skipped rows refuse headroom (`list-unverified`) instead of undercounting |
| **CLI correctness** | `--brief` accepts pipe/socket stdin (fixes false-refuse for every programmatic caller); SIGHUP envelope (129); interrupted harvest/teardown emit CC-9 line; corrupt records exit 5 `record-read-failed` non-retryable (was exit-1 "transient" forever-retry); permanent errnos exit 2; `fleet help` validates argv; stdin briefs timeout 120s |
| **Locks** | survived-signal rollback restores claims (no lock-less survival mid-teardown); failed release retryable; bijective hostTag; dual-load shared registry; legacy ledger migration for non-default store dirs (copy, never delete — was silently starting an empty ledger) |
| **Provenance/redaction** | process-local minted-runId registry (shape-valid but unminted ids refused; DF3.2 re-supply unaffected); invalid-brief payload escaping + 32-issue cap; URL trailing-punct over-redaction fixed; refusal FleetError WeakSet (no bare rethrows); expose non-string → `expose-no-url`; `listTimeoutMs` 2^31 clamp; empty `debugCommands` gets fallback |

**Tests:** ~25 new + ~40 strengthened — pair-barrier race seam, registry-derived cross-verb flag sweep (91 probes), abandoned-GATE coverage (longest await finally tested), per-driver contract reap pins, 15/15 secret-prefix rows, runtime witness-anchor arm with falsifiability probe.

### False-positive pushback (verified against current main, not patched)
- ~15 findings already fixed by post-merge work (df3-2 single-flight admission, round-10 status sanitization wave, `recordStructurallyAbsent` orphan guard, slug column trim, fake-gate shape guards, run-lock realpath/clock-skew/dead-letter fixes) — dismissed with evidence.
- R3 (60s own-pid lock steal): deliberate, test-pinned design for sibling-thread corpse recovery.
- D6 (fake-driver 63-char cap): `assertExistingRunId` enforces ≤63 — no drift.
- F1 (invalid-brief payload field): `extractZodErrorField` sanitizes at the producer post-merge.

### Deferred (fail-safe option chosen, surfaced)
- Cross-process fleet-ceiling TOCTOU → needs quota-layer intent records (in-process half closed by DF3.2 single-flight); self-documented in source.
- Same-runId loser reservation retirement → ledger-side rule (callers forbidden from releasing).
- Over-mint key above admitted ceiling → evidence already derivable on disk (`limitMicroUsd` vs `extensions.budget`); refusing would break rounding providers.
- `reapRuns` fail-closed throw → story-pinned contract, zero production callers (active reaper is `sandbox-reap.ts` `sweep()`).
- `list()` throw-on-skipped → the reaper's fail-closed population gate; anomaly-tolerant consumers have `listWithAnomalies`.

### Gates
- Full suite: **3,686 pass / 3 fail** — 2 were this round's own checkHeadroom-channel regressions (fixed here, patterns.test 45/45), 1 pre-existing environmental failure (`tests/gitnexus/graph-queries.test.ts`, ZodError resolving `registerSwarmClawAgent` against the external swarmclaw index — no PR-123 file touches it). One intermittent load-flake timeout in the first run passed on re-run.
- `biome check .` clean · `tsc --noEmit` clean · `detect_changes` blast radius confined to PR-123 modules.

Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md` (Review round 11 section appended, Status updated).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
