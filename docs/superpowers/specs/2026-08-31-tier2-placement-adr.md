# ADR — Tier-2 Placement: Restore the Original In-Box Design (2026-08-31)

**Status:** ACCEPTED (operator decision, 2026-08-31)
**Supersedes:** the "option 1" architecture decision in
`_bmad-output/workflow-state/qds-sprint-planning/df1-10-a/HANDOFF.md` §3 (never committed, now marked superseded)
**Evidence:** `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`

## Decision

Tier 2 (resident orchestrator agent + deterministic TS phase engine) will run **inside the
sandbox box**, as the 2026-08-11 architecture design (D2/D4, §5.1) always specified. The
shipped host-side placement (DF3.3 resident via host `Bun.spawn`; engine via host
`scripts/pipeline-run.ts` / `pipeline-run-remote.ts`) is classified as a **silent,
unratified deviation** and will be unwound via a staged, probe-gated restoration arc.
DF1.10 "option 1" (codify host-side + transport-backed steering port) is **rescinded**.

## The record this ADR reconciles (the three-way tear)

1. **`W3C_DEVIATION_load_bearing`** (`_bmad-output/workflow-state/qds-dev/df3-4/state.yaml:626-641`,
   commit `c5ebde3`): "THE ENGINE NEEDS NO DRIVER … no DF1.10 required." — A wiring-mechanics
   argument at one host-side call site, self-scoped "for DF3.4's purposes," recorded in dev
   workflow state, never surfaced to a story deviation ledger, PR body, or operator gate.
   It never addressed D4. **Rejected** as a placement ratification.
2. **Deviation 12 / #181 / #180** (DF3.4 round-10 close-out): the attach→fold→ack round trip
   cannot close because attach writes the box's `/run/steering/inbox.ndjson` while the engine
   drains a host-local inbox. #181's own closing shape — "resident consumes
   /run/steering/inbox.ndjson on-box and writes /run/steering/acks.ndjson" — **restates the
   original design**. **Adopted**, in its literal (on-box) reading.
3. **The measured substrate** (2026-08-31 probe, first real measurements): see below. The
   "in-box is impossible" premise was substantially unmeasured folklore.

## Forensic findings (three independent read-only audits, 2026-08-31)

### The deviation was silent and never ratified
- D4 (`2026-08-11-dark-factory-v5-architecture-design.md:301`): "Tier 2 = resident
  orchestrator agent **per sandbox** … operating a deterministic TS phase engine." §5.1
  (`:315-333`) draws resident + engine + trace store + run record inside
  "TIER 2 — SANDBOX"; tier 1 alone is "(operator machine)". Code-only tier 2 was
  "recommended by analysis, **declined by user**" — in-box tier 2 is the operator's decision.
- DF3.3's own spec placed the resident in-box in three places (Trigger Surface `:108`
  "in-box resident spawn"; Infra Prereqs `:120-123`; INV-RES-3 `:232` "the resident **runs
  inside the box** against the single per-run … key"). The shipped code
  (`src/fleet/resident.ts:446-471`) spawns pi on the **host**; its env allowlist takes
  `OPENROUTER_API_KEY` from the host; the TIER-4 live test mints a **second** capped key for
  it — INV-RES-3 violated in substance (credential surface = two keys, two machines).
- DF3.3's nine-entry deviation ledger records a field-count off-by-one and a stale
  docstring, and **not one word about the component moving tiers**. Seven review rounds
  (~260 findings) missed it: e2e tests ran a fake pi on the host and no AC tested locality.
- Every later acknowledgement is a stopgap owed to a not-yet-chartered DF1.10 —
  `pipeline-run-remote.ts:5-20` HONEST LABEL (2026-08-26), DF3.4 "Sprint-level issue —
  raised, not fixed" (`df3-4…md:445-453`), Deviation 12 "Recorded rather than redesigned;
  DF1.10 owns the round trip." The round-8 auditor had already flagged "DF3.4 is unaffected
  in practice" as wrong for the round trip. Unimplemented DF3.6 still charters in-box
  (`df3-6…md:69-90`). No operator gate was ever asked about placement.

### In-box placement is load-bearing in the design, not incidental
Five mechanisms depend on it: (1) RSS-watchdog correctness — watching from off-box was the
exact defect that disqualified Warren (§3.1 row 4; §5.2 "now correct — the runtime is a
genuine local subprocess tree inside the sandbox"); (2) F12 engine-enforced resident bounds
(shared process tree); (3) §5.3 trace-DB harvest + §6.7/§8 per-box visualizer; (4) §6.2
one-secret-per-box credential containment; (5) R9's **two-layer** evidence doctrine — R9
exists *because* gates run in-box and emit claims; host re-verify (DF5.1) is the second,
independent layer. Option 1's use of R9 as an argument *for* host-side inverted the
doctrine: moving the first layer host-side collapses both layers into one trust domain.
The word "placement" appears nowhere in the design doc; F7's tripwires govern *demotion*
(delete the resident), not *relocation*. There is no textual basis for "placement is
flexible."

### The substrate (measured 2026-08-31, box `qds-probe-boxenv`, evidence file above)
- `--image` / `--setup-script` / `--registry-auth` available on our exe.dev plan; boxes
  boot OCI images. The driver simply never passes them (`driver.ts:249-255`).
- **systemd is PID 1 and `running`**; enabled units auto-start after reboot. The
  "no supervisor in-box" premise is FALSE (it had never been probed).
- **bun was NEVER previously probed on a box.** The Aug-25 memory record "verified live
  T1.1: bun --version passed" was a fabricated citation; "no bun/node (exit 127)" measured
  only node. Measured now: bun absent from the image, installs in seconds
  (`curl -fsSL https://bun.sh/install | bash`, no root), persists across reboot, runs
  typed TS and `bun:sqlite` in-box.
- pi is a **compiled ELF standalone binary** (0.84.4) — resolves the pi-without-node
  paradox and is the in-image precedent for shipping a compiled TS engine.
- `/run` is tmpfs (first actual measurement) and **a reboot wipes `/run/steering`** —
  #180's premise is now measured true. Home dir (ext4 `/dev/vda`) persists.
- One real in-box pi solicitation over OpenRouter: 2.17 s, exit 0, $0.000025 billed —
  the 2026-08-19 stall family did not reproduce on the current pi build.

### Probe falsification gates — all CLEARED
(1) image/setup-script unavailable AND bun uninstallable → cleared. (2) no init and no
supervision primitive → cleared. (3) pi stall reproduces hard → cleared.

## Why not host-side (the honest counter-arguments, answered)
- **R9/trust:** answered above — the design pairs in-box gates with DF5.1 host re-verify;
  restoration re-establishes the two layers, it does not weaken trust.
- **Approval gate:** stays host-side by construction (state must outlive the box;
  `approval-gate.ts:8-17` pausing → teardown → awaiting-approval). The arc bridges it:
  in-box engine writes an awaiting marker; host polls; gate ownership unchanged.
- **Supervision:** now a systemd unit with `Restart=`, not new ground.
- **Secrets:** the capped per-run key is *already* in-box (`$HOME/app/.env`, 0600) and
  spent there by tier-3 workers; in-box resident/engine uses the same single key —
  *restoring* §6.2's one-secret-per-box, which the host-side resident (second key, host
  env) currently violates.
- What host-side can never deliver — runs that survive host disconnect — is the product
  (Dark Factory = unattended autonomy).

## Consequences (the restoration arc — stories authored via qds-sprint-planning)
1. **Image ownership** — fork exeuntu Dockerfile (bun + pinned pi + tooling), publish, pin
   by digest, thread `--image`/`--registry-auth` through `create()`. Also retires the pi
   0.55.0/0.84.x drift and makes `buildTeamSpawn`'s `file:"bun"` correct in-box.
2. **DF1.10 re-chartered** — in-box engine + steering executor + channel lifecycle: engine
   runs in-box; steering consumer drains the box inbox and writes acks locally (closes
   #181 per its own closing shape); #180 fixed declaratively
   (`/etc/tmpfiles.d/qds-steering.conf` or persistent-disk channel path); live e2e inverts
   to `attach-acked` as PASS; records/trace written in-box and harvested (§5.3); DF5.1
   host re-verify unchanged.
3. **Supervision** — systemd unit + restart policy + reclaim.
4. **Approval-gate bridge** — awaiting marker in-box, host polls; gate stays host-owned.
5. **DF3.6** — its in-box clauses become correct again; re-sequence after the engine story.

Interim: #181/#180 stay open with amendment comments; live tests keep asserting the honest
`no-ack` shipped shape until the in-box consumer lands. No interim transport machinery.

## Re-opening criteria
Image publish/pull proves unworkable on the plan (registry limits, boot regressions);
engine-in-box breaks an invariant DF5.1 cannot re-verify host-side; measured in-box
resident/engine failure modes (e.g. pi stall regression) exceed what the systemd restart
policy can mask. Any of these → re-open against this ADR with evidence.

## Appendix — draft issue comments (operator approves before posting)

**#181 (draft):**
> Update after the 2026-08-31 tier-2 placement audit + box-environment probe
> (`_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`,
> ADR `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`): this issue's closing
> shape is adopted **literally** — the resident/engine consumes `/run/steering/inbox.ndjson`
> on-box and writes `acks.ndjson` on-box. The host-side engine was a silent deviation from
> design D4, now formally unwound via a staged restoration arc (image ownership → in-box
> engine/steering → supervision via systemd (measured: PID 1, units restart at boot) →
> approval-gate bridge). Until the in-box consumer lands, `no-ack`/exit-6 remains the
> honest live PASS shape. Owner: restoration arc (DF1.10 re-chartered).

**#180 (draft):**
> Premise now measured (2026-08-31 probe): `/run` is tmpfs and a reboot **does** wipe
> `/run/steering` (first actual reboot test). Fix rides the restoration arc's
> channel-lifecycle story and becomes declarative rather than reactive: systemd is PID 1
> on the box image, so a `tmpfiles.d` entry (`d /run/steering 0700 exedev exedev`)
> recreates the channel at every boot — no send-failed-triggered re-provision machinery
> needed. Telemetry still counts channel recreations so a reboot loop stays visible.
