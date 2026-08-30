# Tech-debt audit — answers to the open questions

Decisions for the eleven questions in `TECH_DEBT_AUDIT.md` § "Open questions for the maintainer"
(audit of commit `f9e828d`, 2026-08-28). Each section records the question, the decision, the
evidence it rests on, and the finding IDs it settles. Tasks in
`docs/superpowers/plans/2026-08-28-tech-debt-remediation.md` cite these anchors.

These were decided by the remediation run itself under a "decide without maintainer interaction"
mandate. Each one is reversible; the cost of a wrong call is noted so it can be overturned cheaply.

Decisions describe the *target* state; the task in
`docs/superpowers/plans/2026-08-28-tech-debt-remediation.md` that lands each is named per section.
Until that task merges, the code is as the audit describes.

## Q1 — Is the DF2.7→ledger bridge deferred or dropped?

**Decision: deferred.** `ingestCostEvent` and its tests stay; Task 1.1 makes `qds-cost` emit a
structured `tokens-ledger-unwired` line whenever the ledger holds zero `kind='tokens'` rows,
stating that per-issue caps count box-hours only. Docstrings and INV-COST-2 are rewritten to
describe the current (box-hours-only) contract.

Evidence: the CLI runner still produces `CostEvent`s (`cli-anything/src/runner.ts`), so the
consumer side is the only missing half; deleting the writer would be throwing away a tested
design to close a docstring lie.

Cost if wrong: one dead-but-tested function stays in the tree. Scopes **F001** — landed by
Task 1.1.

## Q2 — Is SwarmClaw ever reachable off-host?

**Decision: loopback-only.** No document, comment, or config in the tree describes a cross-host
deployment; the "department manager / worker agent" registration model is a process model, not a
network one.

Evidence (current state): `src/swarmclaw/index.ts:35` is a bare `Bun.serve({ port, fetch })` — no
`hostname`, so Bun binds `0.0.0.0` today (this is F002); no `authorization`, `bearer`, or
`timingSafeEqual` appears anywhere in `src/swarmclaw/`. Corroborating evidence for loopback-only:
`src/swarmclaw/store/agent-store.ts:58-65` already SSRF-guards agent endpoints to loopback
(`isLoopbackEndpoint`), and nothing in the tree describes off-host agents.

Decision (target state, Task 2.1): `hostname: process.env.SWARMCLAW_BIND ?? "127.0.0.1"`. The
bearer token (`SWARMCLAW_AUTH_TOKEN`) is **mandatory whenever `SWARMCLAW_BIND` is set to a
non-loopback address** — startup refuses to bind if the token is absent in that case — and stays
**opt-in only for the loopback default**, where it is still checked above the 413 guard with a
timing-safe compare when present. Argv for allowlisted commands is default-deny
(`SWARMCLAW_ARG_POLICY` opts a command in).

Cost if wrong: an off-host deployment must set both `SWARMCLAW_BIND` and the token, and startup
now enforces that pairing instead of silently allowing an unauthenticated non-loopback listener.
Scopes **F002**, **F005** — landed by Task 2.1.

## Q3 — Who assembles the `redaction` map for `openPullRequest` and `reverify`?

**Decision: the shipped CLIs do.** Today `scripts/open-pr.ts:42` calls `openPullRequest(runId)`
with no `deps`, and `scripts/reverify.ts` has no redaction path at all — F007 is open. There is
no unlanded `fleet pr` / `fleet reverify` caller to defer the work to, so the decision is that the
CLIs must assemble the map themselves: Task 2.2 makes `scripts/open-pr.ts` build the map from the
run record (host token, minted key and its hash) and pass it as `deps.redaction`, and does the
same for the `reverify` CLI.

Cost if wrong: a future higher-level caller passes its own map and the CLI's becomes redundant,
not harmful. Scopes **F007** — landed by Task 2.2.

## Q4 — Is `QDS_RUN_ROOT` set inside the box image?

**Decision: no.** `src/phase-engine/journal.ts:33` is authoritative — the variable "exists solely
so the host-side test suite can" relocate the marker root; the production root inside the box is
`/run`. `oci/Dockerfile` does not set it. Therefore `scripts/pipeline-run.ts:709`
(`QDS_RUN_ROOT ?? "/run"`) is correct, `src/phase-engine/journal.ts:38` is correct, and
`src/phase-engine/trace/tracer.ts:292` (absence ⇒ skip the boundary check) is the wrong one: it
disables the INV-1 containment refusal on every real run.

`scripts/pipeline-run-remote.ts:207` sets `process.env.QDS_RUN_ROOT = markerRoot` host-side
(records dir), so on remote runs the tracer boundary resolves to `<records-dir>/<run-id>`; the
ruling above (the box image does not set it) stands.

F030 stays **High**, not Critical: the symlink/TOCTOU pins still run, and the fix makes the
tracer derive the boundary the same way (`runMarkerRoot()`), with an explicit override through
`TracerOptions` for tests.

Cost if wrong (i.e. the image does set it somewhere unseen): the derivation still resolves to
the same root. Scopes **F030** — landed by Task 2.5 + 5.7; shapes **F056**.

## Q5 — Do the 13 `*.live.test.ts` ever run?

**Decision: the live tier is manual, by design, and stays that way.** CI never sets
`QDS_E2E_LIVE`; the TIER-1/2/3 evidence in `sprint-status.yaml` is the record of hand-driven
runs before each merge that touches the substrate. No scheduled workflow is added (it would
spend real money on a timer). The README names this cadence so it does not look like an
oversight.

Cost if wrong: none in code. No finding depends on this.

## Q6 — Does `scripts/lib/run-lock.ts` belong under `src/`?

**Decision: yes, eventually — not in this plan.** `src/fleet/fleet-lock.ts:30` importing from
`scripts/lib/` inverts the layering. Moving 1,166 LOC plus its test suite is a pure relocation
with a large diff and no behaviour change; it is recorded as a follow-up with a `ponytail:`
trigger ("when `oci/` needs to ship the fleet lock, or a second `src/` importer appears").

Cost if wrong: the inversion persists one more plan. No finding depends on this.

## Q7 — `oci/Dockerfile:37` `npm install` with no lockfile

**Decision: out of scope for this plan; recorded as follow-up.** Task 3.4 pins the base image
by digest (F084); pinning pi's transitive tree needs a committed lockfile for the image tree,
which is a build-pipeline change, not a tech-debt fix. Tracked as a `tech-debt` issue.

Cost if wrong: two builds a week apart can ship different `0.55.x` transitive trees, as today.

## Q8 — Is the reused `~/.qds/viz-token` deliberate?

**Decision: keep-and-document.** The reused token is operator convenience (bookmarks and
browser Basic credentials survive a restart). The comments that claim mint-per-start are wrong
and will be corrected and a `rotate` deploy option added in Task 8.6 (no CLI surface exists to
carry a flag — `visualizer/deploy.ts` has no argv parser); rotation is equivalent to removing
the token file.

Cost if wrong: mint-per-start is a one-line change to the same code path. Scopes **F029** —
landed by Task 8.6.

## Q9 — `boxHoursEventId` and after-the-fact re-pricing

**Decision: "stored figure wins, log the divergence" is the intended settlement.** A ledger is
append-only and the stored row is what was actually charged; a re-price is new information, not
a correction of the record. The logged collision is the audit trail. Documented at the digest
site; no code change.

Cost if wrong: a hard-refusal is a one-branch change at the collision log.

## Q10 — Was `check-defensive-programming.sh` meant to gate?

**Decision: it gates.** Task 3.3 lands it in the `check` job on `pull_request`, advisory
(`--warn`, NOT `continue-on-error` — a broken scan must still go red) while the measured
backlog is non-zero, then blocking once clear by dropping `--warn`.
`check-pr-conflicts.sh` follows the same route. Story templates keep recording it, now as a
real CI result.

Cost if wrong: one CI line to delete. Scopes **F095** — landed by Task 3.3.

## Q11 — `FleetError.exitCode` is `1|2|3|4|5` while the verb table declares 6

**Decision: the type is deliberately narrower; 6 is CLI-only by construction.** Exit 6 means
"billable work landed, the CLI's own output/cleanup failed after it" — a condition only the CLI
layer can observe, never a library refusal. `FleetError` stays `1..5`; `report`'s `<= 6` arm is
documented as handling the CLI's own code, not a `FleetError`. Task 4.4 (F019) adds the fanout
EPIPE case at the CLI layer, consistent with this.

Cost if wrong: widen the union in one place. No finding depends on this.

This ruling also resolves the open NOTE at `src/fleet/verbs.ts:71-78` (two definitions of 6): the
unified definition is "billable work landed; the CLI's own output or cleanup failed after it" —
Task 4.4 may delete that NOTE and cite this section.
