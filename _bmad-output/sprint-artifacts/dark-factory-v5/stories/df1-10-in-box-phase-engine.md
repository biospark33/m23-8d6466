# DF1.10: In-Box Phase Engine — the Deterministic Walk Runs Where the Design Put It

**Story Points:** 8
**Sprint:** v5-S3 (in-box restoration arc, story 2 of 5; unblocked by DF2.10, unblocks DF1.11 and DF3.7)

## Spec Reference

- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED 2026-08-31) — Consequences item 2 (engine runs in-box; records and trace written in-box and harvested per §5.3; DF5.1 host re-verify unchanged) and item 3's **reclaim half** (the systemd unit file and `Restart=` policy ship in DF2.10's image; what a restarted engine does with a half-finished run is this story's)
- Probe evidence (READ-ONLY): `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json` — bun runs typed TS and `bun:sqlite` in-box (`:48-52`); `/run` is tmpfs and a reboot wipes it while ext4 `$HOME` survives (`:28,:41-42`); systemd re-runs enabled units at boot and a `nohup` process does not (`:44-45`); one real in-box pi solicitation, 2.17 s, exit 0, $0.000025 (`:53-56`)
- Design: `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` **D4** (`:301` "Tier 2 = resident orchestrator agent **per sandbox** … operating a deterministic TS phase engine"), §5.1 tier 2, §5.3 trace harvest, §6.2 one-secret-per-box. **Renumbering, stated once:** pre-2026-08-31 references to "DF1.10 owns the round trip" — DF3.4 Deviation 12, issues #180/#181, and the `fleet attach` no-ack remediation string — mean **DF1.11** under the ADR's re-charter; this story is the engine relocation, DF1.11 the steering executor and channel lifecycle
- Engine contracts this story rewires without changing: `src/phase-engine/journal.ts:32-51` (`runMarkerRoot()` — *"`/run` in the box … the box image does not set it, so inside the box this is always `/run`"*: the engine was written to run in the box), `:53` (the terminal marker is the fixed in-box completion signal DF3.2's poller keys on), `:59-62` (`writePhase` always persists `fail`; `promotePhase` is the sole path to success)
- Corrected premises (R7 §0 — written against these, not the folklore): production `fill` clones the **customer's** repo at the brief's `repoUrl`/`commitSha` into `$HOME/src` (`src/fleet/dispatch.ts:2865-2869`, `src/providers/exedev/fill.ts:259-344`), and `QDS_EXEDEV_SHA` is **test-only** with zero occurrences under `src/` or `scripts/` — **engine delivery is net-new, not a re-use of an existing checkout**. `pipeline.yaml` and `run-context.json` resolve against the ssh `$HOME` (`src/providers/driver.ts:857-883` refuses absolute and `..` paths), so today they are siblings of `$HOME/src`, not inside it
- The invariant restored in substance: DF3.3 **INV-RES-3** ("the resident **runs inside the box** against the single per-run key") against `src/fleet/resident.ts:446-471`, which spawns pi on the **host** off a host `OPENROUTER_API_KEY`, with `tier4-resident.live.test.ts:5,:326` minting a **second** capped key. R9 (verified): the phase engine has **never** called the approval gate — there is no gate seam in the engine to relocate and this story invents none; DF3.7 authors the bridge

## User Story

As the factory operator,
I want the deterministic phase walk and its resident to run inside the sandbox they are spending and committing in,
so that a run survives my laptop closing, and the watchdog, the bounds and the one capped key watch a process tree that is actually local.

## Overview

A new `fleet run <run-id>` verb starts `qds-run@<runId>.service` — DF2.10's baked template, `Restart=no` — on a box already dispatched and gate-passed, and
returns; the engine then walks phases in-box under bun, resolving run-root to the checkout so manifest, witness, roster and code-phase `cwd` agree for the
first time. `startResident` moves with its caller and needs no edit: pi is on PATH, the key is the run's own capped key at `$HOME/app/.env`, and the RSS
watchdog finally samples a genuine local subprocess tree. Marker and trace stay on tmpfs `/run` where DF3.2's poller and DF2.5's harvest already look; the
journal, resident session and redacted prompt/reply artifacts go to ext4 `$HOME` because a reboot wipes the former and they are audit evidence. Harvest
carries all of it out before teardown, `fleet status` reads the marker off the box so a live run stops reporting `ready` forever, and a re-invoked engine refuses a run that already carries a marker rather than re-walking it.

## E2E Slice

**Demonstrable behavior:** Given a box dispatched by DF3.1 and booted from the **re-pinned rebuild** carrying this story's engine stage — the stage changes the digest, so the pin is re-issued through DF2.10's own pin ritual rather than DF2.10's exact artifact — When the operator runs
`bun scripts/fleet.ts run <run-id>`, Then the host starts `qds-run@<runId>.service` and returns without holding the run; the in-box engine walks every
phase — including a `dispatch_task` phase, which resolves `file:"bun"` on PATH for the first time — solicits the resident as a local child off the single
capped key, and writes the in-box layout of Technical Notes. Observable artifacts: `fleet status <run-id>` reports `running` then `ok` by reading
`/run/journal/final.json` `{ok:true}` over `readBoxFile`; `fleet harvest` yields a tar carrying `trace.db`, the marker, the journal, the redacted resident
artifacts and the engine log; and no host process executed a phase body.

**Wiring closed:** On completion of this story a run executes end to end inside its sandbox using only code merged by this story plus DF1.1's phase
lifecycle and frozen manifest, DF1.4's trace schema and WAL discipline, DF1.6's `dispatch_task` and `team-lead-driver.ts`, DF2.5's bundle harvest and
tested teardown, DF2.10's image (bun, pinned pi, the `qds-run@.service` template, the `tmpfiles.d` channel entry), and DF3.1's fill and
`dispatch`/`status`/`harvest`/`teardown` verbs. **No stub, no `TODO: wire later`.** The **steering executor** — draining `/run/steering/inbox.ndjson` and appending acks on-box — is **DF1.11's** (single owner): the engine started here finds an empty inbox and the honest live PASS shape stays `no-ack` / exit 6.

**Dependency edges (predecessors):** DF1.1, DF1.4, DF1.6, DF2.5, DF2.10, DF3.1.

> **Not an edge — DF3.3 and DF3.7.** The resident relocates because **its caller** relocates: R7 verified `src/fleet/resident.ts` needs **no code change**
> to run in-box, so this story edits no DF3.3-owned line while restoring INV-RES-3 in substance. R9 verified the engine has never called the approval gate,
> so there is no gate seam here to move; DF3.7 authors the awaiting-marker bridge **after** this story and the gate stays host-owned.

## Acceptance Criteria

1. **(make-or-break — the phase walk executes in the box, and no host process runs a phase body)** Given a dispatched, gate-passed box, When
   `fleet run <run-id>` is invoked, Then the host starts the per-run systemd instance and returns; every phase — `code`, `dispatch_task` and gate kinds
   alike — executes in-box, and `/run/journal/final.json` is written by the in-box engine and read by the host rather than by any host-side journal.
   *Negative control: the shipped shim shape — host walks the phases, `driver.exec`s only `code` kinds and throws for every other kind
   (`pipeline-run-remote.ts:118-120`) — satisfies a naive "the run finished ok" assertion and MUST fail this one.*
2. Engine delivery is net-new and run-root stops being overloaded three ways.
   <br />**(a) delivery, with a pre-agreed fallback:** the engine arrives **by image** — its build stage changes the digest, so the box boots a **re-pinned
   rebuild** inheriting DF2.10's pin ritual (the publish workflow records the digest↔`buildId` pair; gate B still asserts it) — not by `fill`, never from `$HOME/src`,
   which in production is the **customer's** repo. Route B (`bun build --compile --target=bun-linux-x64`, matching pi's compiled-ELF precedent) is the
   intended shape and the image still carries bun and `cli-anything/scripts/` because `buildTeamSpawn` resolves a real path; if `bun:sqlite` inside a
   standalone executable fails on our bun version — unproven today — the story falls back to bun plus a baked engine checkout at a fixed image path
   **without re-opening the story**, and records which shipped.
   <br />**(b) run-root:** `pipeline.yaml` and `run-context.json` move out of `$HOME` into a **`.qds/` dir inside the checkout** — two path literals at
   `src/fleet/dispatch.ts:2823,2825`, placed by `fillRun` (`:2876`) after `fillExeDev`'s clone — silenced by one `/.qds/` line written into
   `.git/info/exclude` at fill, so `--run-root $HOME/src` makes `loadManifest`'s beneath-root walk, `readArtifactBeneathRoot`'s witness read, every code
   phase's `cwd` and `loadRoster`'s relative resolution agree on one root while setup-gate assertion A's `git status --porcelain` stays **honestly clean**
   rather than taught to tolerate dirt. Fill **refuses** rather than overwrites when the target is already tracked at the pinned SHA. *Negative controls,
   both MUST fail: `--run-root $HOME` passes the manifest and witness reads, then hands every code phase `cwd=$HOME` where a roster resolves to nothing;
   and delivery at the checkout root, where `exclude` cannot silence a customer repo that tracks its own `pipeline.yaml` and assertion A hard-fails.*
3. The resident runs in-box on **one** key and the catalog blocker is closed. Given the unit's `EnvironmentFile=/home/exedev/app/.env`, When the engine solicits,
   Then pi spawns as a local child from PATH against the run's own capped key, no second key is minted anywhere, and the RSS watchdog samples a genuine
   local subprocess tree. `QDS_PI_CATALOG_DIR` **must** be set in-box: pi is a compiled ELF with no sibling `node_modules`, so `findBundledCatalogDir()`
   cannot locate the catalog and `loadBundledCatalog` throws a `RateError` that disables the resident and refuses every `dispatch_task` phase; DF2.10
   installs pi compiled and stages no catalog, so **the catalog directory ships in this story's image build stage** beside the engine. *Negative controls,
   both MUST fail: today's TIER-4 shape mints a second capped key and passes a naive "the resident answered" test; and an image carrying pi but no catalog
   passes DF2.10's own e2e demo, then disables the resident on the first solicitation.*
4. The durability split is explicit and harvest carries all of it out. `/run/journal/final.json` and `/run/trace/` stay on tmpfs — polled live, harvested
   before teardown, MEASURED wiped by a reboot; the journal, resident session and redacted prompt/reply artifacts, and the engine log go to ext4 `$HOME`
   as audit evidence that must survive. `artifactsScript` gains the absolute-path sources via the tar (`TAR_MAX_BYTES` 512 MiB unchanged), re-rooted to
   **relative** entry names because `assertPathSafe` (`harvest.ts:733-738`) refuses an absolute, `..` or backslash name or linkname before a byte is
   extracted and this story does not relax it; the artifacts pull stays teardown's step 2 (`teardown.ts:512`), ahead of revoke and destroy. *Negative
   control: reaching for `/run/trace/trace.db` with `copyFile` (box-relative only, leading `/` refused) or with `exec`+`cat` past the 512 KiB bound passes
   on an empty fixture DB and MUST fail this one.*
5. A live in-box run is observable from the host. Given a run with a live `vmName` and no terminal state, When `fleet status` runs, Then it reads the
   marker with `readBoxFile` and reports `running` / `ok` / `not-ok` / `unknown`, reusing the fanout poller's four verdicts (`absent`, `unreadable`,
   `oversized`, `content`) and its `MARKER_UNUSABLE_TICKS_LIMIT` reclassification verbatim: `absent` is `running`, and an unreadable or oversized marker
   past the tick ceiling is `unknown`, never `ok` (INV-IBOX-7). The per-call deadline is passed explicitly at the call site and never inherited from the
   120 s `execTimeoutMs` default — a test asserts `fleet status` returns inside one deadline against an unreachable box. *Negative control: today's
   behaviour — an in-box run reports `ready` forever — passes every existing status test and MUST fail this one.*
6. **Reclaim semantics (this story's half of supervision).** `Restart=no` is a correctness requirement, not a missing hardening: `writePhase` always
   persists `fail`, `promotePhase` is the only path to success, and a crash between them is *deliberately* recorded as failure. Given an engine invoked
   against a run whose marker already exists, Then it **refuses and exits without re-walking** — no phase re-executed, no `fail` row overwritten. The
   window before any marker exists is closed by unit identity, not by this check: `systemctl start qds-run@<runId>.service` on an already-active instance
   is a no-op, so a second `fleet run` starts no second engine. A half-finished run with no marker stays failed and is reclaimed by harvest and teardown,
   never by a silent second attempt; the journal has no attempt column and this story adds none. *Negative control: an auto-restarting engine re-walks phases whose `sbx/<runId>` commits and spend already happened,
   passes a naive "the run recovered" test, and MUST fail this one.*
7. Every load-bearing stopgap self-labelled as owed to this story is retired **here**, not left lying: `scripts/pipeline-run-remote.ts:5-20`'s HONEST LABEL
   and its `:118-120` throw for every non-`code` phase kind, `tests/fleet/e2e/tier3-remote-phases.live.test.ts`, and `tier4-resident.live.test.ts:18-22`'s
   host-side phase bodies. Explicitly **not** flipped here: the `attach-not-acked` / `no-ack` / exit-6 PASS shape and `fleet.ts`'s remediation string, both DF1.11's.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet run <run-id>` starting `qds-run@<runId>.service` | in-scope | `tests/fleet/e2e/tier2-in-box-engine.live.test.ts` | — |
| In-box phase walk incl. `dispatch_task` and the resident; re-invocation against a run that already has a marker (refusal) | in-scope | `tests/phase-engine/in-box-engine.test.ts` | — |
| `fleet status` reading the in-box marker; harvest pulling trace, journal, resident artifacts, engine log | in-scope | same | — |
| Steering inbox drain + on-box acks; the `attach-acked` PASS flip | out-of-scope — **DF1.11 owns the executor and channel lifecycle** (single owner); the engine here reads an empty inbox | — | DF1.11 |
| Approval gate, and the in-box awaiting marker it will poll | out-of-scope — the gate's state must **outlive the box**; R9 verified the engine never called it, so no seam is invented here | — | DF3.7 |
| Host re-verify of in-box claims; PR creation | out-of-scope — DF5.1 is R9's independent second layer and is unchanged; PR creation does not exist yet and needs a push credential no box may hold | — | DF5.1, DF5.2 |
| Key mint/deliver/revoke; orphan reaping; widening DF2.1's run record for in-box telemetry | out-of-scope — the minter is the host's, self-reaping is a contradiction, and the record schema is closed | — | DF2.3, DF2.6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF2.10 image | provider — pinned digest carrying bun, pinned pi, `qds-run@.service`, `/etc/tmpfiles.d/qds-steering.conf` | DF2.10's e2e demo green before this story starts; a box whose `/etc/qds-image.json` does not match the pin is refused by the setup gate before a run reaches it |
| Per-run capped key | DF2.3 delivery — `$HOME/app/.env`, 0600 | the unit's `EnvironmentFile=/home/exedev/app/.env` is the only key path; a missing or unreadable file fails the unit at start and never falls back to a host key |
| pi catalog | in-image catalog directory addressed by `QDS_PI_CATALOG_DIR` — **staged by this story's build stage**, since DF2.10 installs pi as a compiled ELF and stages no catalog | probed in-box **before** this story's ACs are exercised (`pi --list-models` plus a rate resolution for the resident slug); an unlocatable catalog is a hard blocker, not a degradation |
| Trace store | DF1.4 schema over `bun:sqlite`, WAL, at `/run/trace` 0700 | `bun:sqlite` MEASURED working in-box (probe `:50`); AC2a's fallback fires if it fails inside a compiled binary |
| Harvest + teardown | DF2.5 `artifactsScript` / `pullArtifacts` as teardown step 2 | `bun test tests/providers/harvest*` green before this story starts; `artifactsOwnedByCaller` still prevents a double pull |

## Technical Notes

- **Contracts/Schema — the in-box layout, stated once.** tmpfs `/run`: `journal/final.json` (`{ok: boolean}`, temp+rename, DF3.2's poll key) and
  `trace/{trace.db,events.jsonl}` at 0700. Persistent `$HOME`: the journal (**one pretty-printed JSON object** despite its `.jsonl` name),
  `<runId>.resident.jsonl`, `<runId>-solicit-<n>-{prompt,reply}.txt` at 0600 redacted, and the engine's stderr log — redirected to a file rather than left in journald, because the tar is the harvest path. Unit env: `QDS_TEAM_RUNNER=local` (unset makes `dispatch_task` refuse), `QDS_PI_CATALOG_DIR`, `EnvironmentFile=/home/exedev/app/.env` (the **literal** DF2.10 AC6 bakes — `%h` in a *system* unit is the manager's home `/root`, not `User=exedev`'s), and `QDS_RUN_ROOT` deliberately **unset** so `runMarkerRoot()` returns `/run` exactly as its docblock intended.
- **Guards/limits:** the status poll passes its per-call deadline explicitly and never inherits the 120 s `execTimeoutMs` default, reusing the fanout
  poller's unusable-tick ceiling; `EXEC_MAX_OUTPUT_BYTES` (512 KiB) is why a trace DB rides the tar and not `exec`+`cat`; `TAR_MAX_BYTES` (512 MiB), enforced on both received bytes and summed entry sizes, is not raised here.
- **DF2.10 deferred work rides this story's re-pin — #186, #187, #188.** DF2.10's code review (PR #184) deferred a bundle of image-content items it could
  not fix (#186 lists nine sub-items; #187 and #188 ride the same moment). #186 and #187 are blocked on one fact: `deriveBuildId` hashes the Dockerfile
  bytes and both systemd unit bytes, so **any** edit moves the buildId, moves the digest, and invalidates the pin DF2.10 live-booted. #188's blocker is
  different — the real installed paths cannot be enumerated without a build — it merely *closes at* the re-pin because a build happens then. This story is the next time that image is rebuilt and re-pinned, which makes it the cheapest — and the intended —
  moment to discharge them. **#186** (the bundle): pi installs with no checksum while bun is `sha256sum -c`'d; the unit's `After=` is not `Requires=` and its
  `EnvironmentFile=` has no `-` prefix; no `NoNewPrivileges`/`PrivateTmp`/`ProtectSystem`/`TimeoutStopSec`; `%i` unquoted in the `ExecStart` contract **this
  story copies verbatim**; an `[Install]` stanza on a unit systemd currently refuses to load; AC6's "complete set of surfaces" omitting `DefaultEnvironment=`
  and the drop-in dirs that **DF1.11's INV-IBOX-13 and DF3.7's AC4 both rest on**; and a dependabot entry that is dormant until the base `FROM` carries a tag.
  **#187** (highest value): the build tag is baked into the marker and therefore into the digest, while `deriveBuildId` excludes it — so the publish workflow's
  first run cannot match the live-booted pin, and gate B cannot tell the two apart. **#188**: AC5 attributes binaries by basename, not path. Each issue carries
  its own acceptance checklist; close them as this story's re-pin lands. Two of them touch text this story is told to copy (`ExecStart`, `[Install]`) — read
  #186 **before** writing the unit, not after.
- **Supervision, folded in two halves.** DF2.10 ships the `qds-run@.service` file, its `Restart=no` policy and the `tmpfiles.d` channel entry **in the
  image**; this story owns what a restarted or re-invoked engine does with a half-finished run (AC6, INV-IBOX-6). Neither half is complete alone and neither story may quietly assume the other did its part.
- **The `dispatch_task` correction.** `buildTeamSpawn` (`cli-anything/src/team-events.ts:36-48`) returns `file:"bun"` plus a path joined from
  `import.meta.dir` — location-independent from *any* QDS-Factory checkout, but not from `$HOME/src`, the customer's repo. bun in the image makes the bare `"bun"` correct for the first time, and the image must carry `cli-anything/scripts/` even on the compiled route. Leave `buildTeamSpawn` untouched.
- **Region ownership, and measurements over folklore.** `scripts/pipeline-run.ts` is DF1.1's, `dispatch.ts`/`fill.ts`/`status.ts`/`scripts/fleet.ts` are
  DF3.1's, `harvest.ts` is DF2.5's, `oci/exedev/Dockerfile` is DF2.10's; each edit is enumerated in Files to Modify and no line of `src/fleet/resident.ts` or
  `src/phase-engine/steering.ts` is touched. Every substrate claim here traces to the 2026-08-31 probe — the premise this arc unwinds rested on a fabricated citation ("verified live: bun --version passed", when bun had never been probed), so an unmeasured claim is recorded here as an open measurement, never asserted in an AC.
- **Deviation/assumption:** `bun:sqlite` inside a `bun build --compile` standalone is unverified on our version and the trace store depends on it; AC2a
  pre-agrees the fallback so the failure costs a build shape, not a re-charter. The boundary, in one line: *anything whose state must survive the box's
  destruction, or which holds a credential the box may not hold, stays on the host; the deterministic walk, its resident, its journal and its trace move in.*

## Observability Contract

- Every in-box run logs `{ requestId, runId, phaseId, event, ... }` — `event ∈ engine_started | phase_started | phase_settled | resident_solicited | engine_settled | engine_refused_replay`. The capped key never appears in any field.
- `requestId` propagates from DF3.1's dispatch through the unit's environment onto every engine event and onto the host's marker read, so a status row joins an in-box trace row without a second key; errors carry `{ code, message, remediation }`.
- Sub-timings: `engine_start_ms`, `phase_walk_ms`, `marker_read_ms`, `harvest_pull_ms`. A path never evaluated reports `0`.

## Files to Modify

- `src/fleet/run.ts` (new — the `fleet run <run-id>` verb: starts `qds-run@<runId>.service`, returns, never holds the run)
- `scripts/pipeline-run.ts` (authored by DF1.1; **adds only** in-box run-root resolution, the engine-log redirect and AC6's marker-exists refusal — no change to the phase lifecycle, the journal contract, or `runMarkerRoot()`)
- `scripts/fleet.ts` (authored by DF3.1; **registers only** the new verb — the `no-ack` remediation string it also carries is **DF1.11's** line, untouched here)
- `src/fleet/dispatch.ts` + `src/providers/exedev/fill.ts` (both DF3.1's; **the manifest pair's target only** — the two `path:` literals at `dispatch.ts:2823,2825` move under `.qds/` in the checkout, and `fill.ts` writes the `/.qds/` exclude line plus the tracked-path refusal that keep setup-gate assertion A honestly clean)
- `src/providers/harvest.ts` (authored by DF2.5; **extends only** `artifactsScript`'s source set with the absolute in-box paths)
- `src/fleet/status.ts` (authored by DF3.1; **adds only** the in-box marker read for a run with a live `vmName` and no terminal state)
- `oci/exedev/Dockerfile` (authored by DF2.10; **adds only** the engine build stage and its fixed install paths — the engine artifact, the pi catalog directory `QDS_PI_CATALOG_DIR` names, and `cli-anything/scripts/`)
- `scripts/pipeline-run-remote.ts` (retired — the HONEST LABEL and the non-`code` throw go with it)
- `tests/fleet/e2e/tier3-remote-phases.live.test.ts` (**the marker assertion only**: `<recordsDir>/<runId>/journal/final.json` at `:154` holds only because the retired shim set `QDS_RUN_ROOT` in its own process, so retiring it flips the assertion onto `runMarkerPath()`'s in-box path — DF3.7 records the boundary and does not claim this file)
- `tests/phase-engine/in-box-engine.test.ts`
- `tests/fleet/e2e/tier2-in-box-engine.live.test.ts`

## Security Invariants

- **INV-IBOX-4 (one secret, one machine — DF3.3 INV-RES-3 restored in substance):** the resident runs inside the box against the **single** per-run capped
  key already at `$HOME/app/.env`, 0600 (DF2.3 INV-CRED-2). No second key is minted for it and no host key crosses into a box. The key reaches the engine
  by `EnvironmentFile=`, never on argv (DF2.3 INV-CRED-3, *"secrets travel over stdin, never argv"*) and never as a manifest or record field.
- **INV-IBOX-5 (relocation grants the box no new authority):** the box still holds no push credential, no provisioning key and no minter (D8, DF2.3
  INV-CRED-1); work crosses as DF2.5's ranged bundle and PR creation stays host-side. An engine that gained a credential by moving would have traded away the containment the move exists to restore.
- **INV-IBOX-6 (default-fail journal discipline survives relocation, and supervision must not defeat it):** `writePhase` always persists `fail` and
  `promotePhase` is the sole path to success, so a crash between them is recorded as failure by design. The unit is `Restart=no`; an engine started against
  a run that already carries a marker refuses without re-walking. No attempt column is added and no path re-executes a phase already paid for.
- **INV-IBOX-7 (in-box evidence is claims, not proof — R9's two-layer doctrine):** moving the first layer into the box does not make it the second. DF5.1's
  host re-verify is unchanged and nothing the in-box engine writes may be treated as verified downstream. Fail-closed at the boundary: an absent, unreadable or oversized marker is `unknown`, never `ok`.
- **INV-IBOX-8 (durability boundary):** nothing whose loss is unrecoverable lives on tmpfs `/run` past harvest — MEASURED, a reboot wipes it. The journal,
  resident session and redacted prompt/reply artifacts live on ext4 `$HOME` at the modes their authors set (0700/0600), and harvest carries them out **before** teardown destroys the box. DF3.3's redaction is neither widened nor weakened in transit.
- **INV-IBOX-9 (closed records stay closed):** no field is added to DF2.1's run record for in-box telemetry; new counters ride the trace sidecar's
  `type:"log"` rows or the driver's `emit()` JSONL stream. The engine reads no `.sandbox/runs/` path from inside the box, so DF3.6's DoD grep over `src/phase-engine/` stays valid — now for the designed reason rather than by accident.

## Definition of Done

- [ ] **Impl:** `fleet run <run-id>` starts `qds-run@<runId>.service` on the dispatched box and returns; the engine walks every phase kind in-box under bun with run-root resolved to the checkout (AC1, AC2b).
- [ ] **Impl:** engine delivered by DF2.10's pinned image (compiled route, or the pre-agreed bun-plus-checkout fallback), with `QDS_TEAM_RUNNER`, `QDS_PI_CATALOG_DIR` and `EnvironmentFile=/home/exedev/app/.env` set by the unit and `QDS_RUN_ROOT` left unset (AC2a, AC3).
- [ ] **Contract:** the marker at `/run/journal/final.json` remains the completion signal; `runMarkerRoot()`, the journal schema and the phase lifecycle are unchanged; no field added to DF2.1's run record (INV-IBOX-9).
- [ ] **Integration:** `artifactsScript` carries trace DB, marker, journal, resident artifacts and engine log out via the tar before teardown; `fleet status` reports a live in-box run over `readBoxFile` (AC4, AC5).
- [ ] **Security:** one capped key, in-box, delivered by `EnvironmentFile` and never on argv; no second key minted; no push credential or minter in the box; and a test asserts the harvested tar — engine log and resident artifacts included — carries no `sk-or-` material (INV-IBOX-4, INV-IBOX-5, INV-IBOX-8).
- [ ] **Test (in-box walk, AC1):** every phase kind settles in-box and the host runs no phase body; the host-walks-phases shim shape MUST fail.
- [ ] **Test (run-root, AC2b):** manifest, witness, roster and code-phase `cwd` all resolve under one root with `git status --porcelain` clean and no tolerance added; `--run-root $HOME` MUST fail, and so MUST root-level delivery into a fixture repo that already tracks its own `pipeline.yaml`.
- [ ] **Test (single key + catalog, AC3):** the resident answers off `$HOME/app/.env` with no second key minted anywhere in the run; an unset `QDS_PI_CATALOG_DIR` reproduces the `RateError` that disables the resident, proving the blocker is closed deliberately; an image built without the staged catalog MUST fail this test.
- [ ] **Test (reclaim, AC6/INV-IBOX-6):** re-invoking the engine against a run with a terminal marker re-executes no phase and overwrites no `fail` row; a `Restart=on-failure` unit MUST fail this test.
- [ ] **Test (e2e demo — MANDATORY):** one scripted run on a real box booted from the re-pinned rebuild (DF2.10's pin ritual, this story's engine stage) completes in-box, leaves `/run/journal/final.json` `{ok:true}` read by the host over `readBoxFile`, and yields a harvest tar carrying `trace.db`, the journal and the redacted resident artifacts — DF1.11 drains its inbox inside exactly this engine, and DF3.7 polls exactly this marker path.
- [ ] **Inherited from DF2.10's review — discharge at THIS story's re-pin (#186, #187, #188).** See "DF2.10 deferred work rides this story's re-pin" in Technical Notes. These are not optional extras: this story is the next time the image is rebuilt and re-pinned, and every one of them is blocked on exactly that. Closing #186/#187/#188 is part of this story's completion, and each carries its own acceptance checklist.

## Dev Agent Record

Branch `feature/df1.10` → PR into `dev`. Final SHA carries image digest
`sha256:8cdcfe84…` / buildId `c2b0c0f0531078e1`, proven booting on real boxes.

### The route changed, and a measurement is what changed it (AC2a, contract C36)

AC2a pre-agreed a fallback and the fallback SHIPS: **system `bun` + unbundled source at
`/opt/qds-factory` + a two-line `exec` wrapper** at the unchanged `ExecStart` path. Route B
(`bun build --compile`) is NOT what ships, and C17's proof is superseded rather than unmet — the
compiled ELF really did run `bun:sqlite` inside the pinned base (R4), that just turned out not to be
the property that decides the route.

What decides it: `bun build --compile` collapses `import.meta.dir` to `/$bunfs/root` for every
bundled module, and a plain `bun build --target=bun` collapses it to the output file's directory.
The engine's closure has **two consumers needing different bases** —
`src/phase-engine/roster/schema.ts:319` (three levels up) and `cli-anything/src/team-events.ts:46`
(one level up) — so no bundling route can satisfy both and no placement of a bundle's output is
honest. `buildTeamSpawn` is NOT modified, as the story requires.

### Deviations from "Files to Modify"

| deviation | what and why |
|---|---|
| **C19 — `PhaseKind` narrowed** to `"code" \| "dispatch_task"` (`src/phase-engine/types.ts`) | AC1 says every phase kind executes in-box. The enum carried kinds with no executor, so "every kind" was unenforceable; the narrowing makes it a COMPILE-TIME guarantee (`makeBodyFactory`'s `never` exhaustiveness) and a manifest naming a removed kind is refused AT LOAD with a remediation naming `dispatch_task`. Not in the file list; it is what makes AC1 checkable rather than asserted. |
| **C16 — `tier4-resident.live.test.ts` rewritten**, not merely re-pointed | The file minted a SECOND capped key, which is the ADR's own exhibit for the INV-RES-3 deviation (ADR:43-45, 97-100). Removing it restores design §6.2 one-secret-per-box. Live-proven this round: `{"phase":"run-key","source":"/home/exedev/app/.env","provenance":"delivered by dispatch — this test mints no key of its own"}`. |
| **C18 — `deriveBuildId`'s input set closed** (`scripts/build-exedev-image.ts`) | The engine artifact is exactly the "COPY'd asset outside `oci/exedev/systemd/`" that its own docblock warned would change the image without changing its identity. Load-bearing for AC2a, not optional hardening. #187 verified at source with it: `BuildIdInputs` carries base digests, platform, bun/pi versions, Dockerfile bytes and the COPY'd files — **not the tag** — so a validated buildId survives a retag. |
| **C37 — AC5's image sweep NARROWED, not waived** | Forced by C36: unbundled source must resolve `yaml` and `zod` at run time, so the image now ships a `node_modules` where DF2.10's property was "no npm tree at all". The gate admits a tree **at `opt/qds-factory/node_modules` by exact path** and refuses one anywhere else; every other property it enforced is untouched. This is a real change to a MERGED story's property and a reviewer should push on it. Second measurement behind it: `bun install --production` at this workspace root resolves 264 packages / 243 MB, so the builder copies `yaml` and `zod` ONLY, at `--frozen-lockfile` versions, with an in-Dockerfile probe that fails the build naming any third specifier. |
| **C38 — licence declared** | `--push` was blocked without one. QDS-Factory is private, proprietary software: root `LICENSE`, `package.json` `"license": "LicenseRef-QDS-Proprietary"` (alongside `"private": true`), canonical text at `oci/license-texts/`. NOT `NOASSERTION` (it means "could not establish" and would corrupt the two entries using it with that meaning) and not an OSS id. The `UNVERIFIED` pin test is INVERTED rather than deleted. **Not legal advice — the repo LICENSE is a notice, not the commercial grant.** |
| **C39 — a false disclosure removed** | The qds-engine entry disclosed statically linked LGPL JavaScriptCore, correct while a `--compile` binary embedded the bun runtime. Under C36 that path holds a 90-byte shell wrapper, which embeds nothing, so the disclosure became a false claim. Removed from qds-engine, RETAINED on `usr/local/bin/bun`, and both halves pinned by one test — dropping it from bun would be the opposite and worse defect. |
| **AC7 — the shim is gone** | `scripts/pipeline-run-remote.ts` retired with its HONEST LABEL and its non-`code` throw, discharging the ADR:49-51 IOU. C41: `src/fleet/attach.ts:25`'s justification cited a premise that is now dead and was partly folklore — the "no bun/node on the box" measurement had only ever tested **node**, and the "verified bun live" memory record was a fabricated citation. Comments were moved FORWARD to the live reason (this image ships bun 1.3.13) rather than preserving a falsified one. |

### Three real defects the live round found — none reachable by static analysis

1. **`pullArtifacts` sent an empty argv element the real driver refuses** (`f77c9a07`). The in-box
   script reads `home="${3:-$HOME}"`, so an empty `$3` was deliberate and documented — true of the
   SCRIPT, false of the DRIVER: `ExeDevDriver.exec` rejects empty/whitespace elements
   (`driver.ts:1235,1249`, hardening added AFTER the idiom). One cause, FIVE red tests. **Why 5154
   unit tests missed it:** `FakeDriver.exec` checked only `length === 0`, and `harvest.test.ts`
   PINNED the broken shape under the title "production defaults … an EMPTY home". The fake and the
   test agreed with each other about a shape the substrate rejects on sight — worse than no coverage,
   because it reads as coverage. Fixed on both axes.
2. **The in-box engine could not create its own runtime directories** (`3fa49d11`) — the core defect.
   `EACCES: mkdir '/run/trace'`, `ExecMainStatus=2`: `/run` is root-owned tmpfs and the unit runs as
   `User=exedev`, so the engine could never have completed a single run. Fixed with
   `RuntimeDirectory=journal trace` / `Mode=0700` / `Preserve=yes` on the unit — not a tmpfiles entry
   (steering is boot-scoped; these are run-scoped). `Preserve=yes` is load-bearing: systemd deletes a
   RuntimeDirectory at unit stop and the marker must outlive the engine for `fleet status` and
   harvest. **The paths and the code were both correct; only a booted box has permissions.**
3. **A fixture discriminator resting on defect 1** — `patterns.test.ts` keyed on
   `argv.length === 5 && argv[2] === "--"` under a comment claiming artifacts used plain `bash -s`.
   False: only the LENGTH separated them, and artifacts was 6 solely because of the empty element.
   Now keys on the stdin script, which is intrinsic. Diagnosed by BISECTION, not inference.

### One production defect fixed on the way out (`f8955273`)

`PROVISION_ACTION_TIMEOUT_MS = 60_000` gated `driver.create`, borrowed from the DF2.6 reaper's
per-unit ops — but a reaper op lists or destroys an existing box while `create` can carry an **86 s
measured cold pull** of the pinned image. So the first create after ANY image bump timed out, and
`withTimeout` abandons rather than cancels: the orphan-box shape. `create` now has its own
`PROVISION_CREATE_TIMEOUT_MS = 300_000` (the ceiling `tier1-registry-auth` already applied to its own
cold-pull legs); everything else keeps 60 s; an injected `actionTimeoutMs` still governs every step.
Under dispatch the step stays bounded by the run's own deadline. This is a customer-facing bug: the
first dispatch after every image bump could fail.

### Live round (2026-09-04, final SHA, image c2b0c0f0)

TIER-1 8 files / 11 tests · TIER-2 4 files · TIER-3 5 files / 7 tests · TIER-4 · TIER-5 — **0 fail**,
25 evidence files committed, every one stamping `isRepoPin: true`. Model spend **$0.0215** measured
(≤ $0.031 including one abandoned attempt), against a ~$0.02 expectation. Round-exit hygiene: fleet
`{"vms":[]}`, key hashes set-equal to the 7-hash pre-round snapshot, no `fleet.lock`.

`tier2-dispatch-engine` needed a second attempt: its body succeeded end to end and then the HOST's
network dropped during teardown (ssh refused, `openrouter.ai` NXDOMAIN), so the verb exited 6 holding
its lock — the correct fail-closed arm — and one box and one key were destroyed and revoked BY HAND
before the isolated re-run passed. Disclosed rather than smoothed over, because the round's hygiene
claim is worth exactly what its disclosure is.

**`tier1-registry-auth` (DF2.10 AC4) ran GREEN too**, late in the round, once the operator minted a
`read:packages`-only PAT — so **20 of 20 live files are green on the final SHA and no gap remains**.
It was held open rather than forced: substituting `gh auth token` (repo, workflow, write:packages)
would have made the test's own ratification record false, since it hard-codes `scope:"read:packages"`
and names the operator as `rotationOwner`. The supplied token's scope was VERIFIED before use
(`x-oauth-scopes: read:packages`, exactly), not assumed.

Both legs did their job: the unauthenticated negative control was **refused** by the substrate
(`create-failed`, box never listed — and a refused pull caches nothing, so the probe digest stays
cold and the AC4 false-green guard survives), and the authenticated leg created from
`qds-exedev-private@sha256:8cdcfe84…`, **the pinned digest** — the live confirmation that the mirror
re-push landed where `DEFAULT_IMAGE_REF` points rather than at the index digest `imagetools create`
produces. Both boxes destroyed; no credential byte in the evidence.

**Credential hygiene, stated because it is the one unclean thing here:** the PAT was pasted into a
chat transcript, so it is burned by exposure whatever its scope. The 0600 file was deleted after the
run and the token must be revoked at github.com/settings/tokens — GitHub exposes no API to delete
one's own classic PAT, so that step is the operator's.

### Filed, not fixed here

- **#213** `fleet rank --steps-json` has no producer after AC7 retired the shim; `rank` degrades to
  "every arm unscored" and exits 0, shipping green while permanently degraded.
- **#214** the C20 follow-up spec (HITL `kind:"pause"`) is written and filed;
  no implementation in this story.
- **#215** `fleet-lock` F047 r1 is load-flaky by test design (it races a spawned helper against a
  250 ms budget). DF3.2's surface; measured 2-in-3 failures at load ~17 in the fleet+phase-engine
  subset, green in isolation and in the full suite. **Not** fixed by widening the budget.

## Review Findings — round 1 (2026-09-04, PR #216)

Adversarial review of the full PR diff (`origin/dev...HEAD`, 18,343 lines / 116 files) by 15
parallel reviewers across 13 chunks: blind (diff-only, zero repo access) and edge-case hunters on
each source cluster, plus an acceptance auditor reading the story and the tier-2 placement ADR in
full. ~212 raw findings, deduped and triaged, then repaired by 9 fixers in two waves (source
clusters first, test layers second, so test expectations were written against final behaviour).

**Acceptance verdict: all 7 ACs MET.** No AC unmet or contradicted. INV-IBOX-4..9 spot-checked and
holding. Non-goals verified at the byte level — `src/fleet/resident.ts` and
`src/phase-engine/steering.ts` are identical to `dev` (DF1.11's scope untouched, the ADR's Interim
`no-ack`/exit-6 shape intact), the engine contains no `approval` reference (DF3.7's seam not
invented), and `src/providers/run-record.ts` / `scripts/reverify.ts` are absent from the diff
(INV-IBOX-9 and DF5.1 unchanged). `detect_changes` confirms the post-fix blast radius stays inside
this story's own modules.

### Patched — correctness and safety

- [x] **AC6/INV-IBOX-6, the round's top defect.** `markerReplayRefusal` resolved the marker via
      `runMarkerPath()`, which takes no argument — one path per marker ROOT, not per run — and
      parsed the marker body while reading only `.ok`, never comparing the `runId` sitting in the
      same object (`journal.ts:227`). Two independent failure modes: a foreign run's verdict
      mirrored (exit 0 with no phase walked), and `/run` being tmpfs so a reboot erased the guard
      entirely and a re-invocation re-walked phases whose commits and spend had already happened.
      Now refuses a foreign marker with `ENGINE_MARKER_FOREIGN`, and a journal-with-rows-and-no-marker
      with `ENGINE_JOURNAL_ORPHANED` — the durable `$HOME` sentinel closes the reboot hole the
      tmpfs marker cannot. Both refusals precede `new FileJournal`, which also fixes a retry after a
      mid-walk crash silently TRUNCATING the crashed attempt's journal (the constructor flushes an
      empty object over the fixed path; the sibling `--engine-log` is `O_APPEND` for exactly this
      reason). Tests assert the journal is byte-identical after a refused retry.
- [x] **AC5.** `absent → running` collapsed four distinct states — never started, engine dead after
      fork, box rebooted, marker harvested — into the most reassuring one, reproducing the
      "reports `ready` forever" failure AC5's negative control says MUST fail, by a different route.
      An absent marker is now corroborated by `systemctl is-active`, with two new states
      (`engine-failed`, `not-running`); unreadable/oversized still fail closed to `unknown`, never
      `ok`. `fleet run` no longer reports `started` on a bare `systemctl start` exit 0, which for a
      `Type=simple` unit proves only a fork.
- [x] **AC5 was dark in every non-live fixture.** The marker read is gated on `driver.execTimed`,
      which `FakeDriver` did not implement — the story's own confessed failure mode ("the fake and
      the test agreed with each other about a shape the substrate rejects on sight") recurring.
      `FakeDriver` now has `execTimed`; a compile-time assertion makes losing it on `ExeDevDriver` a
      build break rather than a log line. This exposed 38 stale fixtures, all repaired deliberately:
      doubles that intercepted only `exec` now intercept both channels, and `live` expectations were
      re-pointed only where the test's subject is the reported state rather than the record↔box join.
- [x] **`fleet run` started the engine on a gate-FAILED box.** `startRun` refused on approval state,
      `closedAt` and missing `vmName` only; dispatch writes `extensions.gate.outcome:"failed"` and
      then per INV-5 leaves the record open and the box alive, and nothing anywhere read it back.
      New `run-not-startable` / `state:"gate-failed"` refusal, contradicting the story's own
      "already dispatched, gate-passed" premise no longer possible.
- [x] **AC2b fill.** `assertQdsDirFree` ran against the pinned SHA and then `git switch`ed to an
      existing sandbox-branch tip — a different commit — so a tracked `.qds/` on that branch passed
      the guard and `fillRun` wrote over tracked customer files. Now checked on both trees. An
      untracked pre-existing `.qds/` is refused (`qds-dir-present`) instead of written into, and the
      `.git/info/exclude` append no longer corrupts a newline-less file (which silently rewrote the
      customer's last pattern AND left no exclusion, failing setup-gate assertion A).
- [x] **Availability: a workload could pin a billing box open permanently.** A code phase planting
      `ln -s /etc/passwd ~/<runId>-solicit-9-reply.txt` made tar store a link entry, the host
      validator refuse the whole archive, and teardown abort at step 2 BEFORE `destroy` — and the
      aged-record reaper sweep re-aborts through the same path every sweep. Symlinks are now dropped
      in-box, and an artifacts failure no longer blocks revoke+destroy (logged, not fatal).
- [x] **Manifest validation.** `z.string().min(1)` accepts `" "`, so a whitespace-only `command`
      element, `roster` or `task` loaded cleanly, provisioned a box, and died mid-walk after spend.
      Now refused via `.refine` — deliberately NOT `.trim()`, which is a zod *transform* and would
      have silently rewritten an operator's argv (`["  echo"]` → `["echo"]`) all the way into the box.
      Also: the removed-kind remediation lookup walked `Object.prototype`, so `kind:"constructor"`
      returned a Function through a `string` return type and threw a TypeError out of the loader.
- [x] **AC2a/#187 CI.** The publish trigger and `SOURCE_PATHS` missed four COPY sources that are
      buildId inputs (`src/providers/timeout.ts` and three workspace `package.json`s), so editing
      them changed the image and the buildId while triggering no publish and leaving `src_sha`
      unmoved. Both lists corrected and a test now diffs them against `copyContextSources`.
- [x] Plus ~120 further items across engine CLI, fleet verbs, dispatch, providers, build script and
      every test layer, including the full LOW tier: stale comments falsified by their own diff, a
      doc block bound to the wrong symbol, an unbounded marker read, a symlink-following read behind
      an `lstat` guard, unvalidated `requestId`, exhaustiveness gaps, and ~14 assertions that could
      not fail.

### Dismissed — false positives, verified against source

- **`phase_settled` never emitted for a failed phase** (HIGH as filed). `phase.ts:422-427` calls
  `promotePhase(id,"fail",exitStatus)`; it IS the sole settle path, failures included. The port doc's
  "sole path to `success`" constrains which STATUS may be written, not who calls it.
- **Replay mirroring collapses non-zero verdicts to 1.** A run exiting 2 writes no marker at all
  (`writeTerminalMarker` runs inside `finish`), so the mirror cannot lose a verdict.
- **"No marker/journal guard exists at all."** It exists (`pipeline-run.ts:1212`); the reviewer's
  grep pattern could not match a path built by `runMarkerPath()`. Only the tmpfs-durability half of
  that finding was real, and it is fixed above.
- **`startRun` runId injection.** `scripts/fleet.ts:2749` calls `assertFleetRunId` before
  `startRun` and `run-record.ts:513-519` bounds the id. Downgraded to defence-in-depth; the guard
  was added to `startRun` anyway to match `statusRun`.
- **`PhaseKind` narrowing makes a mid-flight run unresumable.** All three `loadManifest` call sites
  read operator-authored or same-dispatch manifests; no resume path exists (grep: zero hits), and a
  removed kind already died mid-walk pre-change.
- **`QDS_BUILT_AT` is wall-clock** (would have meant #187's gate still fails by construction). It is
  `new Date(sourceDateEpoch(gitSha) * 1000)` — commit-derived. Regression guard added.
- **`teardown` drops the new `boxRunRoot`/`boxHome` seams**; it passes its whole `deps` object.
- **`${#arr[@]}` breaks under `set -u` on bash 3.2**; measured on this machine — `empty-ok`, exit 0.
- **`.dockerignore` mirror in `contextFilesUnder`** — the hazard is real but deferred (below), and
  the reviewer's proposed `depPath` prefix filter would have been dead code (`depPath` is a
  dependency CHAIN, not a path).

### Deferred — image-side, must ride the next re-pin

`deriveBuildId` hashes `oci/exedev/Dockerfile` and both systemd unit files, so any edit moves the
buildId, moves the digest, and invalidates the pin `sha256:8cdcfe84…` / `c2b0c0f0531078e1` that this
story's 20-of-20 live round proved on real boxes. Editing the image inside a review round would
trade a proven pin for an unproven one and force a full live re-round. **And a re-pin is not
landable from a feature branch at all**: a real publish is refused unless dispatched from `dev` or
`main` (`.github/workflows/publish-exedev-image.yml:66-70,75-77`), and a feature branch can only
dry-run, which writes nothing to the registry — no digest to pin, nothing to live-test. Fixed in
TypeScript where the same failure is reachable; the rest filed, following this story's own
#186/#187/#188 pattern.

- [ ] **[#217](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/217) — the DF1.10
      re-pin bundle**, nine items with their own acceptance checklist, to land on `dev` after this
      PR merges. Take (mechanical): `EnvironmentFile` applying after systemd's default PATH, so a
      `PATH=` line in `.env` breaks the wrapper's bare `bun` after four build-time `command -v bun`
      assertions passed (F-D5); the `su`-based PATH assertions depending on PAM/`login.defs` with no
      way to tell a PAM regression from a PATH one (F-D6); the AC6 allowlist being grepped out of
      the file it validates, so the unit self-authorises its own `QDS_*` values (F-D7);
      `/opt/qds-factory` shipping the root `package.json` and `bun.lock` to a customer-facing box
      (F-D4, verify bun's own consumption of them first); `contextFilesUnder` mirroring only
      `node_modules` from `.dockerignore`, so a stray `.env.local` under a COPY'd subtree moves the
      buildId **without moving the image** and a dev tree and CI's clean checkout derive different
      buildIds for a byte-identical image (F6); and the unit's `%i` rationale comment, which
      describes `%I` (corrected test-side below — the unit's copy can only be fixed at a re-pin).
      Hold (decisions, not bugs): `RuntimeDirectory=journal trace` using LITERALS in a template
      unit, so every instance shares `/run/journal` and `Preserve=yes` carries run A's terminal
      marker into run B — the image-side amplifier of the top defect, whose exploitable path is
      already closed by the TS runId comparison, and which deserves its own round with its own live
      proof (F-D1, HIGH); `NoNewPrivileges=yes` making `sudo` inert for agent-authored `code`
      phases (F-D3, operator policy call); `PrivateTmp=yes` hiding `/tmp` from every ssh-based host
      operation — harvest verified unaffected, the real exposure being `childEnv`'s `TMPDIR`
      passthrough (F-D2).

### Noted, not fixed

- [ ] **[#218](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/218) — the shipped
      pin is CI-UNPROVEN.** `DEFAULT_IMAGE_REF` was hand-pushed from a developer machine (three
      re-pins in one sitting), so the publish workflow's digest↔`buildId` equality check — what
      AC2a leans on and #187 exists to correct — has never run end to end against the digest that
      ships. DF2.10's "first pin this repository did not push by hand" property has been given back.
      Recorded on the constant; discharged by construction on the first CI publish, which the
      re-pin bundle carries. Cross-linked from DF2.10's story.
- [ ] **[#219](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/219) — INV-RES-3 is
      restored positionally.** The one-key property holds because the CALLER relocated (correct per
      R7), but `resident.ts` still spawns pi off whatever `OPENROUTER_API_KEY` its env carries,
      nothing asserts the key came from the unit's `EnvironmentFile` path, and C16 deleted the
      second-mint exhibit that would have caught a regression. A key-provenance assertion was added
      to the tier-4 live test instead of editing DF3.3's file — real coverage, invisible to every
      static gate (#210). Wired into DF3.3's Security Invariants.
- [ ] **[#220](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/220) — the unit
      couples DF1.11's channel to DF1.10's start.** `qds-run@.service:55`'s
      `AssertPathIsDirectory=/run/steering` means every DF1.10 run **refuses to start** if DF1.11
      relocates the channel, until a re-pin. Ordering is handled (`Requires=systemd-tmpfiles-setup`),
      so the assertion is legitimate image-integrity work; the coupling just has to be known from
      DF1.11's side. Wired into DF1.11's Technical Notes.
- [ ] **[#221](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/221) — a teardown
      artifacts failure is log-only.** This round made it non-fatal so `destroy` always runs (a
      workload-planted symlink could otherwise pin a billing box open forever). Recording the
      failure ON the run record needs a new `EXTENSION_NAMESPACES` entry in
      `src/providers/run-record.ts` — DF2.1's file, and INV-IBOX-9 says the record schema is closed
      to this story. Marked `TODO (cross-cluster)` at `src/providers/teardown.ts:209` and wired into
      DF2.1's Technical Notes.
- [ ] **[#222](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/222) — `fillRun`
      throws bare `Error`s with no `code`** (`src/providers/driver.ts:922,940`), so `dispatch.ts`'s
      classifier cannot discriminate a **path-escape refusal** from an ordinary exec failure and a
      test cannot assert either without matching message text. Blast radius is CRITICAL (14
      impacted, 4 direct, 6 processes) — its own round, not a ride-along.
- [ ] **[#223](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/223) — C37 narrowed
      a MERGED story's property** (DF2.10 AC5, "no npm tree at all" → "a tree at
      `opt/qds-factory/node_modules` by exact path"). Tight and disclosed, but no DF2.10 amendment
      records it. Filed against DF2.10 and wired into its story.
- [ ] **[#224](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/224) — `.qds/` is
      deletable by the workload's own git.** AC2b required moving the manifest pair INTO the
      checkout, so a code phase running `git clean -xdf` deletes `pipeline.yaml` +
      `run-context.json` mid-run — `-x` explicitly ignores the exclude file the design leans on.
      Accepted residual, documented as out-of-contract; the belt-and-braces fix is a fallback copy
      outside the checkout.
- **AC1's negative control is satisfied by deletion**, not by an executable test. A grep-shaped
  assertion that nothing under `src/fleet/`/`scripts/` imports the phase-body executors now covers it.
- **Evidence churn** — a test in `tests/phase-engine/trace/` rewrites committed evidence under
  `_bmad-output/evidence/df1-4/` in place, so every full suite run dirties the tree. Pre-existing,
  not this story's; filed as a comment on **#162** (test-suite hermeticity) rather than as a
  near-duplicate issue. Standing rule until it is fixed: `git checkout -- _bmad-output/evidence/`
  before staging.

### Round 2 — closeout (2026-09-04)

- [x] **F21 landed** (`tests/providers/exedev/image-assets.test.ts`). The `%i`-quoting assertion is
      sound, but its rationale was wrong on both sides of the boundary: `%i` is the instance name
      **as-typed**, and systemd's unit-name grammar admits no whitespace, so `%i` cannot expand to a
      string containing a space. The hazard is `%I`, the C-unescaped form, which maps `-` → `/` —
      and every id `newId` mints is `<slug>-<YYYYMMDD>-<6 hex>`, so `%I` would hand the engine three
      path components where the run root expects one. A one-character edit (`%i` → `%I`) was silent
      under every assertion in the file. Now: the prohibition on `%I` in any directive is asserted
      (same scope discipline as the `%h` test), the runId grammar is proven to round-trip through
      `%i` unchanged, and `%I`'s mangling is pinned as the negative control. The unit's own copy of
      the wrong rationale (`qds-run@.service:213-216`) is an image byte and rides #217.

### Live e2e — round 2 (2026-09-05, real boxes, real spend)

Run per the `qds-live-e2e` skill: free gates, then TIER-1, then the paid tiers sequentially. **19 of
the 20 live files green.** `tier1-registry-auth` was not run — it throws without
`QDS_E2E_REGISTRY_AUTH_FILE`, a 0600 `biospark33:<read:packages PAT>` only the operator can mint;
it was green on the pre-review SHA and nothing in this round touches its subject.

Round-exit hygiene, every pass: fleet listing empty, key hashes set-equal to the pre-round snapshot
(7 → 7, zero leaked), no `.sandbox/fleet.lock`.

#### THE FINDING THAT CHANGES WHAT A MERGE MEANS — [#226](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/226)

**The box runs the engine from the IMAGE, and the pinned image predates review round 1.** DF1.10
ships the engine as unbundled source (AC2a) at `/opt/qds-factory/scripts/pipeline-run.ts`; the
checkout `dispatch` clones at `QDS_EXEDEV_SHA` is the WORKLOAD. So round 1's fixes to that file —
including the round's top defect, AC6/INV-IBOX-6 marker identity — reach no box until a re-pin.

Surfaced by the AC6 durable-half leg, which wiped the tmpfs marker and re-ran: **the engine re-walked
both phases and re-spent**, twice, on two boxes, with both of the guard's inputs verifiably correct
(`journalPhaseRows: 2`, `/run/journal` listing showing the marker genuinely gone). Probed directly:

```
/etc/qds-image.json  gitSha 7ff55b55 (ancestor of HEAD), builtAt 2026-09-04T13:21:35Z
grep -c ENGINE_JOURNAL_ORPHANED /opt/qds-factory/scripts/pipeline-run.ts  → 0
grep -c ENGINE_MARKER_FOREIGN   /opt/qds-factory/scripts/pipeline-run.ts  → 0
grep -c ENGINE_MARKER_PRESENT   /opt/qds-factory/scripts/pipeline-run.ts  → 1
```

The pre-round-1 guard is there; both new ones are not. The same scenario refuses correctly against
this repo's engine locally (exit 2, `ENGINE_JOURNAL_ORPHANED`, no phase started). Consequences:
`DEFAULT_IMAGE_BUILD_ID` is now a **stale literal** (`deriveBuildId` folds in every COPY'd context
file, `build-exedev-image.ts:647-649`, and no static gate recomputes it); the split between what this
round could and could not prove is exactly host-side vs image-side; and a feature branch cannot fix
it, because a real publish is refused off `dev`/`main`.

**So: what this round proves is every HOST-side round-1 fix — `fleet run`'s liveness probe and its
`run-not-startable`/`gate-failed` refusal, AC5's new status vocabulary, the two-tree `.qds` guard and
`qds-dir-present`, harvest availability, teardown continuing past an artifacts failure. What it
cannot prove is any ENGINE-side fix. Those are proven by unit tests and by a local end-to-end
reproduction, and they land on the substrate with the re-pin.**

#### Test defects found and fixed (all three: assertions written in round 1 that had never run live — [#210](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/210)'s shape)

- [x] **The orphan leg asserted the winning side of a race.** `qds-run@.service` is `Type=simple`, so
      systemd calls the unit started at the FORK and `startRun`'s `is-active` probe is all that stands
      between that and a `started` report; the engine must boot bun and read its journal before it can
      know to refuse. Measured: exit 0, verb duration 1958 ms. Its own sibling leg (the
      `ENGINE_MARKER_PRESENT` replay) already had this right. Now accepts 0 or 5, records which
      (`probeWonTheRace`), asserts the exit-5 envelope only on the arm where the probe won, and asserts
      unconditionally what is load-bearing: the in-box refusal, a byte-identical durable journal, and
      `fleet status` settling on `engine-failed`. The ceiling is filed as
      [#225](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/225).
- [x] **The leg now probes WHICH engine the box runs**, reading the entry out of the `qds-engine`
      wrapper the unit execs and grepping it for the guard — recording a loud skip naming #226 when it
      is absent, rather than asserting a refusal the substrate provably cannot make. A red nobody can
      clear until a re-pin lands on `dev` is a red people learn to ignore.
- [x] **The resident session file is `active`'s property, not "not `disabled`"'s.** The file is pi's;
      DF3.3 degrades OPEN at four points and a resident that degrades before pi produces a session
      leaves none. Measured across five live runs on an unchanged build: four `active` with the
      session, one `degraded` without. The status is now held to its closed set, and the degradation
      REASON is lifted onto the evidence from journald — the journal's resident block is a closed key
      set and cannot carry one (`steering.ts:886-888`), and the engine log does not either, which this
      round measured.
- [x] **`teardownQuietly` now records the typed refusal CODE.** A refused verb prints its envelope and
      then `logVerb`'s completion line, which is longer than the 300-char tail the primitive kept — so
      `run-locked`, `fleet-busy` and `no-headroom` all arrived as "exit 5" with the code scrolled off.

#### Flakes, isolated and cleared

- **T3.4a (reaper)** — body PASSED; the harness's belt-and-braces teardown hit a stale `run-locked`
  left by the test's own deliberate SIGKILL. Box destroyed, no key leaked, `final-ls` empty. Green
  alone (2/2). Stale-lock refusal is deliberate design (`scripts/fleet.ts:4196-4213`: never auto-steal
  a lock; print the `rm` that clears it).
- **T5.1 (gate+steering)** — `PI_EXIT=124`, an in-box pi timeout under load. Green alone, 253 s
  against the failing run's 422 s.
- **T4 (resident), on the confirmation pass** — L2's first solicit took **32,579 ms** against the
  30 s ceiling, so the call timed out, the resident degraded, and the later points returned PROCEED
  in 0 ms with `spendMicros: 0`. Green alone, 98.6 s. The same shape as T5.1: two independent
  30-second timeouts against the live provider on one night, neither a code path.

#### Confirmation pass — every file green on the FINAL SHA

Because three of the fixes landed after their files had already run, the whole set was re-run
end to end on `0573cccc`, sequentially, free tiers first:

| Set | Result |
|---|---|
| TIER-1 (8 files) | **11 pass / 0 fail**, 345 s |
| TIER-2 (4 files) | **4 pass / 0 fail**, 403 s |
| TIER-3 (4 files) | **5 pass / 0 fail**, 437 s |
| tier3-reaper | **2 pass / 0 fail**, 517 s |
| tier4-resident | **1 pass / 0 fail**, 99 s (after the timeout flake above) |
| tier5-gate-steering | **1 pass / 0 fail**, 200 s |

**24 tests across 19 files, all green.** Hygiene after: fleet listing empty, no `.sandbox/fleet.lock`,
key hashes set-equal to the pre-round snapshot.

### Gates (post-fix)

`bunx tsc --noEmit` 0 · `bunx biome check .` clean, 687 files · `bun test` **5285 pass / 0 fail /
8 skip / 27 todo** across 172 files (baseline before this round: 5199 pass / 1 fail — the one
pre-existing failure was the timing-flaky `drain backstop` test, green this run) · `detect_changes`
147 changed symbols / 31 affected processes, all inside this story's modules.

**Live e2e was NOT re-run this round.** Wave 2 changed what several live tiers assert — including a
poll that would have failed a healthy run under the new status vocabulary — so the 20-of-20 live
result on the pre-review SHA does not automatically carry. A live round is required before merge.
