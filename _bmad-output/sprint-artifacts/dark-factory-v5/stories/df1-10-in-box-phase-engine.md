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

<!-- Empty placeholder — filled during development. -->
