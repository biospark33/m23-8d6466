## Review Round 2 — BMAD adversarial review (7 layers, all findings fixed)

**Commit 47a8e8e** — 2 fixer waves, 65 patches, 18 defers, 13 dismissals.
Full ledger: `_bmad-output/workflow-state/code-review/pr135/triage.md` · per-agent reports in `.../pr135/reports/`.

### Method
5 diff chunks (≤630 lines each) → 7 parallel reviewers: 3 blind (chunk-only), 3 edge-case (chunk + repo read), 1 acceptance auditor (spec + arch greps). ~141 raw findings → triage with source-verified dismissals → wave 1 source clusters (steering / resident / runner, disjoint) → wave 2 test hardening after source settled.

### Headline fixes

| Sev | Finding | Fix |
|---|---|---|
| HIGH | Gated retry loop ignored `signal.aborted` — post-settlement zombie loop re-ran command+resident, mutated journal after terminal marker | abort rethrow first in catch (`pipeline-run.ts`) |
| HIGH | `select_roster` fail-open when `ctx.rosterIds` undefined | missing set = empty set, reject fail-closed (`steering.ts`) |
| HIGH | E2E host-coupling: read host `~/.pi/agent/models.json`; TMPDIR-unset wrote counter to `/` (5/6 fail, empirically reproduced); orphaned runner procs; undrained stdout pipe | `QDS_PI_MODELS_JSON` pinned, per-leg `TMPDIR` single-source, `finally` SIGKILL + stdout drain, budget < test timeout |
| HIGH | Arming test had no negative control (could not fail for its named bug) | identity-free witness + requestId → disabled leg added |
| HIGH | `usage.test.ts` whole-file steering exemption weakened the unit invariant | exact count pin: 2 sanctioned divisions |
| MED | `resident_directive` via `writeGateEvent` fabricated a `gate_results` row `passed=0` + event outside closed `TraceEventType` | now `type:"log"` trace row (file's own tripwire precedent) |
| MED | RateError refused the whole run — spec says refuses *the resident* (INV-RES-5) | arming catch → `status:"disabled"` + stderr line, run proceeds deterministic |
| MED | INV-RES-3 gap: credential-shaped brief values never refused at resident boundary | same CREDENTIAL_FIELD/VALUE scan as manifests, refuses naming the field |
| MED | `redact(stderr.slice(-400))` truncated before redacting (repo rule violated) | redact full, then cut |
| MED | meter() unguarded — one NaN poisons `spendMicros` for the run | finite/negative clamp |
| MED | runId unvalidated into file paths (traversal) | grammar-validated at `startResident` |
| MED | manifest strings (`phase.name` is `min(1)` only) entered steering prompt raw — newline injection | `sanitizeForMessage` on all manifest-borne lines |

Plus 53 more: stop()/timeout seams, exitStatus honesty (ENOENT→`logic`, never-ran→`null`), best-effort reply persist (metering survives write faults), prompt truncation now keeps newest context, `model` on solicit observability lines, telemetry deep-snapshot, fixture/test hardening (exact 276 µ$ spend, directive partition, degraded-path leg, redaction probe, session-continuity behavioral test).

### False-positive pushback (dismissed with source evidence — 13)
- **"abort at run_start yields ok:true, exit 0" (CRITICAL)** — false: `journal.finish` computes `ok = rows.length > 0 && every-success && accepted`; a zero-phase run is `ok:false`, exit 1. Verified at `journal.ts:137`.
- **"unbounded retry when retries undefined"** — false: schema defaults `retries` (`manifest.ts:73`).
- Remaining 11: verified-handled guards (types.ts sanitization), spec-mandated fixture shapes, intentional snapshots. Evidence per item in `triage.md`.

### Deferred (18, tracked in story + triage.md)
Notable: point-2 solicitation is code-phase-only (agent-phase seam — recorded as deviation, follow-up story); `select_roster` recorded-not-applied (DF1.6 owns the spawn surface, deviation ledger #3); steering wall-clock absent from `requiredBudgetMs` (DF3.6); journal version bump (cross-story test pins).

### Gates
- `bun test tests/phase-engine/ tests/fleet/` → **1263 pass / 0 fail** (one parallel-load timeout flake, clean ×2 consecutive re-runs)
- `biome check` 14 touched files → clean · `tsc --noEmit` → exit 0
- GitNexus `detect_changes` → MEDIUM, all 13 changed symbols inside the story's own modules; 1 affected process (`main`)

@coderabbitai re-review please — round-2 fixes are in 47a8e8e.
