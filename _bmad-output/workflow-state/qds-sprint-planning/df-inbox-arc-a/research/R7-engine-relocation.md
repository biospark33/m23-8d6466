# R7 — Engine Relocation Surface (DF1.10 "In-Box Phase Engine")

Repo `/Users/steve/QDS-Factory` @ `feature/df1-10-tier2-placement-adr`. Method: direct
Read/Grep, every claim carries file:line. Inputs read first: the ADR
(`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`), the probe
(`_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`), and R3
(`.../df1-10-a/research/R3-code-surface.md` — reused claims verified below, one
correction noted in §0).

---

## 0. THREE PREMISE CORRECTIONS BEFORE ANYTHING ELSE

These invalidate load-bearing assumptions in the research brief. The story must be
written against the corrected facts.

**C1 — `fill` does NOT put the engine in the box.** The brief says "fill.ts already
clones repo to `$HOME/src` at `QDS_EXEDEV_SHA`". It clones **the brief's `repoUrl` at the
brief's `commitSha`** — the WORK repo, the one the run is about
(`src/fleet/dispatch.ts:2865-2869` passes `valid.repoUrl` / `valid.commitSha` from the
validated brief; `src/providers/exedev/fill.ts:259-344`). `QDS_EXEDEV_SHA` is a **test-only**
env var: `tests/fleet/e2e/live-harness.ts:43,104`, `tier3-reaper.live.test.ts:163,395`,
`setup-gate.test.ts:554`, `cap-hit-demo.test.ts:990`. It appears in **zero** files under
`src/` or `scripts/`. The e2e suites point it at QDS-Factory because QDS-Factory is the
repo those tests dispatch *against* — a coincidence of the test fixture, not a production
delivery path. **In production `$HOME/src` is the customer's repo and contains no engine.**
Engine delivery is therefore a genuinely new mechanism, not a re-use.

**C2 — `run-context.json` and `pipeline.yaml` land in `$HOME`, not beside the checkout.**
`fillRun` (`src/providers/driver.ts:857-883`) refuses any path starting with `/` or
containing `..` (`:861-863`); the two files are `{path: "pipeline.yaml"}` /
`{path: "run-context.json"}` (`src/fleet/dispatch.ts:2822-2848`), so they resolve against
the ssh HOME. Confirmed by the shim, which fetches `${home}/pipeline.yaml` and
`${home}/run-context.json` (`scripts/pipeline-run-remote.ts:190-191`). They are **siblings
of** `$HOME/src`, not inside it — deliberately, for the same reason `app/.env` is a sibling
(`src/providers/exedev/fill.ts:79-85`: a file inside the clone is untracked and false-fails
setup-gate assertion A's `git status --porcelain`). This creates the run-root conflict in §1.4.

**C3 — the existing OCI image is not a candidate.** `oci/Dockerfile` is DF2.9's
node-22-slim image carrying `@mariozechner/pi-coding-agent@0.55.0` (`:50`) — no bun, and
pinned four minor versions behind the 0.84.4 the boxes actually run (probe
`runtime-inventory`). It is also never used: `ExeDevDriver.create` execs
`ssh exe.dev new --name <name> [--tag <t>] --json` and nothing else
(`src/providers/exedev/driver.ts:250-256`) — no `--image`, no `--setup-script`,
no `--registry-auth`. That thread-through is DF2.10's job (R6), and DF1.10 depends on it.

---

## 1. `scripts/pipeline-run.ts` — the full closure (2 182 lines)

### 1.1 CLI surface
`VALUE_FLAGS` at `:109-119`, parsed at `:1265-1316`, help at `:101-106`:

| Flag | Required | Default | Site |
|---|---|---|---|
| `--manifest <path>` | yes (`:1318`) | — | `:1274` |
| `--budget-ms <n>` | yes (`:1319`) | — | `:1277` |
| `--journal <path>` | yes (`:1320`) | — | `:1285` |
| `--run-root <path>` | no | `process.cwd()` (`:1250`) | `:1288` |
| `--run-id <id>` | no | fresh uuid | `:1291` |
| `--request-id <id>` | no | = runId | `:1304` |
| `--repo-slug` + `--issue` [+ `--issue-url`] | pair-or-neither (`:1344`) | — | `:1295-1301` |
| `--no-resident` | bool | off | `:1265-1267` |

Exit codes: 0 ok / 1 settled-not-ok / 2 unsettleable (`:25-27`).

### 1.2 Env read
Only **two** env vars in this file: `QDS_RUN_ROOT` (`:1405-1406`, via `runMarkerRoot()`)
and `QDS_RESIDENT_TIMEOUT_MS` (`:2071`). The engine package adds `QDS_RUN_ROOT`
(`journal.ts:49`, `tracer.ts:83`, `dispatch-task.ts:336`), `QDS_TEAM_RUNNER`
(`dispatch-task.ts:290-298` — must be exactly `"local"` or the phase refuses),
`QDS_PI_CATALOG_DIR` + `QDS_PI_MODELS_JSON` (`roster/validate.ts:276-279,336-340,859`),
`QDS_PI_TIMEOUT_MS` (`roster/validate.ts:582-585`). `childEnv()` (`:198-206`) hands phase
commands a deliberately narrow env (PATH + …), never credentials (INV-4).

### 1.3 Paths written
| Artifact | Path | Site |
|---|---|---|
| Journal file | `--journal` verbatim (`FileJournal`) | `:1320` |
| Terminal marker | `runMarkerRoot()/journal/final.json` | `journal.ts:54-56`, written `:207` |
| Trace dir (0700, mode-asserted) | `runMarkerRoot()/trace` | `:1405-1412` |
| Trace db + events.jsonl | inside that dir | `tracer.ts:76-77` |
| Resident session jsonl | `dirname(resolve(journalPath))/<runId>.resident.jsonl` | `:1748-1752`, `resident.ts:349` |
| Resident prompt/reply artifacts | same dir, `<runId>-solicit-<n>-{prompt,reply}.txt` 0600 | `:1753`, `resident.ts:294-313,436` |
| Dispatch-failure log | `<markerRoot>/dispatch-failures.log` | `:41-44` |
| Steering acks (read) | `acksPath()` = `steeringRoot()/acks.ndjson` | `:155-191`, `attach.ts:86` |

`runMarkerRoot()` returns `/run` unless `QDS_RUN_ROOT` is a non-blank string
(`journal.ts:48-51`). Its docblock (`:36-42`) already states the design intent: "`/run` in
the box … the box image does not set it, so inside the box this is always `/run`". **The
engine was written to run in the box.** The one production writer of `QDS_RUN_ROOT` is the
host-side shim (`pipeline-run-remote.ts:210`).

### 1.4 What must change to run it ON the box

**(a) Nothing, for the marker/trace.** `--run-root` unset in-box ⇒ marker at
`/run/journal/final.json`, trace at `/run/trace` — exactly the contract
`fanout-primitive.ts:670` and `transport.ts:133-134` already poll for. This is the one
part of relocation that is free.

**(b) The run-root conflict is the real work (consequence of C2).** `--run-root` is
overloaded three ways and in-box the three want different values:
- `loadManifest(manifestPath, budgetMs, runRoot)` (`:1322`) walks beneath-root — the
  manifest must resolve **inside** run-root.
- `run-context.json` is read via `readArtifactBeneathRoot(witnessPathBeside(manifestPath),
  runRoot)` (`:588`, `:643`, `witnessPathBeside` at `:489`) — beside the manifest,
  also beneath run-root.
- **Code phases spawn with `cwd = runRoot`** (`:967`, `:994`, `runCommand` at `:264-270`),
  and `loadRoster(spec.roster, {cwd: runRoot})` (`:783`, `dispatch-task.ts:336,~360`)
  resolves roster/artifact paths against it.

With the delivered pair at `$HOME/*` and the repo at `$HOME/src`, `--run-root $HOME`
satisfies the manifest+witness reads but gives every code phase `cwd=$HOME` (manifest
commands written for a repo cwd break; a roster at `config/rosters/x.json` resolves to
`$HOME/config/…`, absent). `--run-root $HOME/src` inverts it: phases and rosters work, the
manifest is outside run-root and `loadManifest` refuses. Today's shim dodges this entirely
— it uses run-root = a host scratch dir and `cd $HOME/src` per code phase
(`pipeline-run-remote.ts:113`). **Pick one and write it into the story:**
1. deliver the pair into a third sibling (e.g. `$HOME/run/pipeline.yaml`) and run
   `--run-root $HOME/run`, keeping code-phase cwd wrong → still broken;
2. deliver into `$HOME/src` and teach setup-gate assertion A to ignore them (a
   `.git/info/exclude` line, written at fill) → run-root = the checkout, everything
   resolves, gate stays honest;
3. split the overload: add `--phase-cwd` distinct from `--run-root`.
Option 2 is the smallest diff and keeps one root; it touches
`src/providers/exedev/setup-gate.ts:398-407` (porcelain assertion) — name that in the ACs.

**(c) Key sourcing.** The engine itself needs no key, but the resident does
(`OPENROUTER_API_KEY`, `resident.ts:239`), `dispatch_task` refuses without one
(`dispatch-task.ts:~305`: "At least one of ANTHROPIC_API_KEY or OPENROUTER_API_KEY"), and
`validateRoster`'s pi probes spawn pi. In-box the key is at `$HOME/app/.env`, 0600
(`src/providers/credentials.ts:59` `KEY_ENV_FILE = "app/.env"`, `:401-410` delivery script,
`:435-446`). The proven in-box sourcing idiom is tier5's
`set -a; . "$HOME/app/.env"; …` (`tests/fleet/e2e/tier5-gate-steering.live.test.ts:328`);
for a systemd unit the declarative equivalent is `EnvironmentFile=%h/app/.env`.

**(d) `--journal` / records.** Today the resident's session and artifact dirs are
`dirname(--journal)` (`:1748-1753`). In-box that must be a persistent-disk path
(`$HOME/…`), NOT under `/run` — `/run` is tmpfs (probe `filesystems`) and the artifacts are
audit evidence that must survive to harvest. Marker + trace stay under `/run` (they are
polled live and harvested before teardown); the journal + resident artifacts should go to
`$HOME`. **This split is a decision the story owns.**

---

## 2. Engine delivery: checkout vs compiled binary

Two routes, both now proven viable by the probe.

**Route A — bun + a repo checkout of QDS-Factory in the image or at fill.**
- Probe: bun installs in seconds without root, persists across reboot, runs typed TS and
  `bun:sqlite` natively (`bun-capability` phase). DF2.10's image ships it.
- But per C1 the engine checkout does **not** exist in-box today, and `$HOME/src` is the
  customer's repo. So this route needs *either* the engine baked into the image at a pinned
  SHA (a second, engine-owned checkout, e.g. `/opt/qds/engine`) *or* a second fill-like
  push. Baking it into the image is strictly better: it is versioned with the image digest,
  it is not a per-run transfer cost, and DF2.10 is already pinning that digest.
- Cost: the whole `node_modules` tree must ship too (the engine imports zod et al. through
  `src/phase-engine/index.ts` and `cli-anything/src/*`), and the image now carries a second
  copy of the repo.

**Route B — `bun build --compile --target=bun-linux-x64` single binary.**
- Named in the recon as the real-story route
  (`_bmad-output/workflow-state/code-review/e2e-audit/recon/phase-engine.md:116-121`).
- Precedent in-image: **pi itself is a compiled ELF standalone binary** (probe
  `runtime-inventory`: "COMPILED ELF STANDALONE BINARY, version 0.84.4"; this is what
  resolved the pi-runs-without-node paradox). The substrate already ships exactly this shape.
- One binary, no node_modules, no dependency drift between host and box, and the artifact
  is trivially digest-pinnable in the image.
- Known snag: `bun build --compile` + `bun:sqlite` — the trace store
  (`src/phase-engine/trace/tracer.ts`) depends on it. Bun bundles `bun:sqlite` into
  standalone executables, but this is **unverified on our version** and belongs in the
  story's probe list, not its assumptions.

**Recommendation: Route B, baked into the DF2.10 image alongside pi.** It matches the
in-image precedent, sidesteps the node_modules question, and gives one digest that pins
runtime + engine together. Route A's only advantage — editing the engine without rebuilding
the image — is not a production need, and DF2.10 is rebuilding anyway. *Caveat:* if the
`bun:sqlite`-in-standalone probe fails, fall back to Route A (bun + baked checkout) without
re-opening the story.

`dispatch_task` is the exception that argues *for* bun-on-PATH either way — see §5.

---

## 3. Launch + supervision

### 3.1 What exists today
- **Nothing launches the engine.** Recon G2 verified: the only invokers of
  `scripts/pipeline-run.ts` anywhere are tests (`tests/phase-engine/pipeline-run.test.ts:19`,
  `resident-e2e.test.ts:28`, `trace/wiring.test.ts:588,696,782`,
  `tier4-resident.live.test.ts:148`) and `pipeline-run-remote.ts` is a test-driven shim
  (`tier3-remote-phases.live.test.ts:111`). Dispatch's last act is the ack — box up, key
  delivered, gate passed, `state: "ready"` (`src/fleet/dispatch.ts:3090-3130`). Then it stops.
- **The only in-box background-process prior art** is `startVisualizer`
  (`src/providers/driver.ts:1121-1167`): `nohup bun run server/index.ts >log 2>&1 &`,
  `echo $! > pidfile`, idempotent `REUSED`/`STARTED` protocol, `set -a; . envFile; set +a`
  for the token. Note its own comment (`:1112-1116`): no `disown` — `/bin/sh` is dash.
- The probe measured **nohup dies at reboot** (`reboot-persistence`: "nohupProc: DEAD"),
  while an **enabled systemd unit re-ran at boot**. So the visualizer's pattern is the wrong
  one to copy for the engine.

### 3.2 The shape to write
`systemd-run --unit=qds-run-<runId> --collect --property=Restart=no …` from the dispatch
verb, or a transient unit written by fill + `systemctl --user start`. Concretely:

- **Who starts it:** the dispatch verb, as a new step 11 between the gate and the ack (or a
  new `fleet start`/`run` verb — the cleaner boundary, since dispatch's contract is
  explicitly "provisioned, never succeeded", `dispatch.ts:3090-3093`, and starting work
  silently changes that word). **Recommend a separate verb**; it keeps the ack's meaning and
  keeps `--no-resident`-style control at the operator's hand.
- **One engine process per run.** `RunRecordStore` is one record per runId
  (`.sandbox/runs/<id>.json`, `run-record.ts:1135` `DEFAULT_RUNS_DIR`), one box per run,
  one journal. Unit name keyed on runId gives systemd the mutex for free.
- **`Restart=no`, and this is the important one.** Phases are NOT idempotent under restart:
  `writePhase` upserts by phaseId and always persists `fail`; `promotePhase` is the sole
  path to success (`journal.ts:59-62`, header `:8-19`). A crash between the two is
  *deliberately* recorded as failure (INV-5). An auto-restarting engine would re-walk phases
  whose side effects (commits on `sbx/<runId>`, spend against the capped key) already
  happened, and would silently overwrite the `fail` row that recorded the crash. Restart
  belongs to a supervisor that understands attempt discipline; the journal has no attempt
  column. **`Restart=on-failure` here is a correctness bug, not a hardening.** If the story
  wants resilience, it needs an explicit attempt/resume design and that is a separate story.
  (The steering channel's `tmpfiles.d` unit from #180 is the *other* unit and it SHOULD be
  enabled-at-boot; do not conflate the two.)
- **Exit propagation.** systemd holds the exit code (`systemctl show -p ExecMainStatus`),
  but the host must not depend on it: the **terminal marker is the contract**
  (`journal.ts:53` "The fixed in-box completion signal DF3.2's host-side poller keys on
  (AC7)"), and `run.finish()` writes it with temp+rename. Host reads `{ok: boolean}` from
  `/run/journal/final.json`. See §7.
- **stdout/journald.** The engine writes structured JSON lines to stderr (the `writeAll(2, …)`
  sites: `:1841-1858` steering faults, `:1859-1872` tripwires, resident warns via
  `resident.ts:366`, `dispatch-task.ts:56`). Under systemd these land in journald; harvest
  should pull `journalctl -u qds-run-<runId> --no-pager` output or redirect to a file under
  `$HOME`. **Redirect to a file** — journald is not in the artifacts tar's probe set (§6) and
  a file is one fewer moving part.

---

## 4. Resident in-box "for free" — what actually changes

`startResident` (`src/fleet/resident.ts:321-639`) spawns pi per solicitation via `Bun.spawn`
(`:448-471`) with frozen argv `pi --provider openrouter --model <id> --mode json --no-tools
--session <path> -p <prompt>`, `stdin: "ignore"`. It is a **host** process today only because
its caller (`pipeline-run.ts:1747-1754`) is. **Move the caller, the resident moves with it —
no code change to `resident.ts` is required.** Concretely:

| Surface | Today (host) | In-box | Change needed |
|---|---|---|---|
| pi binary | `opts.bin ?? QDS_PI_BIN ?? "pi"` (`resident.ts:348`) | `/usr/local/bin/pi` → `~/.local/bin/pi`, ELF 0.84.4 (probe) | none — it's on PATH |
| `OPENROUTER_API_KEY` | host env, allowlisted at `resident.ts:239` | `$HOME/app/.env`, the **run's own capped key** | source the env file into the engine process (§1.4c). **This is INV-RES-3 restored**: one key, one machine (ADR §"Secrets") — the TIER-4 live test's second minted key (`tier4-resident.live.test.ts:47` mints a separate resident key) becomes unnecessary |
| env allowlist | `CHILD_ENV_ALLOWLIST` `resident.ts:235-247` | unchanged and *more* correct in-box: PATH/HOME/OPENROUTER_API_KEY/proxies/QDS_RESIDENT_TIMEOUT_MS are exactly the box's set | none |
| `QDS_PI_CATALOG_DIR` | `findBundledCatalogDir()` walks up from `realpath(which pi))` looking for `node_modules/@earendil-works/pi-ai/dist/providers/data` (`roster/validate.ts:274-297`) | **BREAKS: pi is a compiled ELF with no node_modules beside it.** `loadBundledCatalog` throws `RateError` when the dir is unlocatable (`:308-312`) | **Must set `QDS_PI_CATALOG_DIR` in-box** (image ships the catalog JSONs at a fixed path, or the DF2.10 image installs pi via npm so the tree exists). This is a hard blocker for `dispatch_task` and for `resolveRate` (which `startResident` calls at `resident.ts:347` — a RateError there disables the resident, `pipeline-run.ts:1765-1785`). **Name it in the ACs.** |
| `QDS_PI_MODELS_JSON` | `~/.pi/agent/models.json`, missing = empty registry (`validate.ts:334-340`) | same, absent in-box | none (AC5: missing is not an error) |
| session file | `dirname(--journal)/<runId>.resident.jsonl` 0700 | must be persistent disk, not `/run` (§1.4d) | choose `$HOME` |
| prompt/reply artifacts | same dir, 0600, redacted (`resident.ts:294-313`) | same; **now harvestable evidence** | include in harvest set (§6) |
| RSS watchdog / F12 bounds | watched from off-box (the Warren defect, ADR §"load-bearing") | genuine local subprocess tree | the mechanism the move exists to restore |

`LIVE_SESSION_PATHS` (`resident.ts:353-357`) refuses a second live resident on one session
path — process-local, so it does not span the host/box boundary either way. No change.

---

## 5. `dispatch_task` in-box

`buildTeamSpawn(manifest, "local")` returns
`{file: "bun", argv: [join(import.meta.dir, "..", "scripts", "team-lead-driver.ts")]}`
(`cli-anything/src/team-events.ts:36-48`). Verified:

- `import.meta.dir` = the directory of `team-events.ts` at runtime, so `../scripts/…`
  resolves to `cli-anything/scripts/team-lead-driver.ts` — the file exists
  (`cli-anything/scripts/team-lead-driver.ts`, 32 905 bytes). **The relative resolution is
  location-independent and works from any checkout of QDS-Factory**, including one baked
  into the image. It does NOT work from `$HOME/src` (that's the customer repo, C1).
- `file: "bun"` is a bare PATH lookup. With DF2.10's image shipping bun this **becomes
  correct in-box** — exactly as the ADR §Consequences-1 predicts. Today it is why
  `pipeline-run-remote.ts:118-120` throws for every non-`code` kind.
- **Route B caveat:** a compiled single-binary engine has no `import.meta.dir` pointing at a
  real `cli-anything/scripts/` on disk, and `file:"bun"` needs a real bun. So **Route B still
  requires bun + the `cli-anything/scripts/` tree in the image** for `dispatch_task` phases.
  Either accept that (image ships bun anyway, per DF2.10) or ship `team-lead-driver.ts` as a
  second compiled binary and make the `"bun"` hardcode configurable. The lazy call: keep bun
  in the image, leave `buildTeamSpawn` untouched.
- Also required for `dispatch_task`: `QDS_TEAM_RUNNER=local` in the engine's env
  (`dispatch-task.ts:290-298` — unset refuses), a provider key present (`:~305`), the roster
  resolvable under run-root (§1.4b), and `QDS_PI_CATALOG_DIR` (§4) because
  `validateRoster`'s dual-gate probes pi's catalog.

---

## 6. Records / trace / harvest

### What is written in-box after the move
`/run/journal/final.json` (marker), `/run/trace/{trace.db,events.jsonl}` (0700),
`$HOME/<…>/journal.jsonl` (the `JournalFile` — note it is ONE pretty-printed JSON object
despite the `.jsonl` name, `tier3-remote-phases.live.test.ts:118-121`), resident session
jsonl + redacted prompt/reply artifacts, engine stderr log.

### What harvest pulls today
`artifactsScript` (`src/providers/harvest.ts:327-342`) `cd`s into the first existing dir of
`["app","src","/home/agent/app","/home/agent/src"]` (`:78`) and tars
`specs app_docs adws/adw_data/ssmf.db trace.db run.log`. Plus the ranged git bundle
(`bundleScript`, `:~300-319`) → `<runsDir>/<runId>.bundle`, verified host-side then fetched
to `refs/sandbox/<runId>` (`:12-16`).

**Note:** `trace.db` IS already in the probe set — but as a **workdir-relative** name
(`$HOME/src/trace.db`), not `/run/trace/trace.db`. It has never matched anything the engine
writes. Recon G5 is confirmed correct.

### Harvest extension the story owns
`artifactsScript` must additionally pull, from absolute paths outside the workdir:
`/run/trace/trace.db` (+ `-wal`/`-shm` if WAL is live — the Tracer opens WAL,
`tracer.ts` open-time WAL refusal is fatal, so the sidecar files exist), `/run/journal/final.json`,
`$HOME/<records>/journal.jsonl`, the resident artifacts, and the engine log. Two constraints:
- the tar is built with `cd "$wd"` and staged at `../harvest-artifacts.tgz`
  (`harvest.ts:337-339`); absolute sources need `tar -C /` or explicit `-P`-free relative
  re-rooting. `TAR_MAX_BYTES` = 512 MiB, enforced on received bytes **and** summed entry
  sizes (`:57`).
- **`copyFile` cannot read `/run/*`** — box-RELATIVE only, leading `/` refused
  (`driver.ts:711-725`; the measured lesson at `transport.ts:132-141`). Everything absolute
  crosses via the tar, or via `exec`+`cat` bounded by `EXEC_MAX_OUTPUT_BYTES` = 512 KiB
  (`bounded-exec.ts:41`). A trace.db will exceed 512 KiB — **it must ride the tar.**
- Harvest must run **before** teardown destroys the box; it already does
  (`teardown.ts:515` `pullArtifacts` as step 2, `artifactsOwnedByCaller` at
  `harvest.ts:405-412` prevents a double pull).

### What stays host-side
The run record `.sandbox/runs/<id>.json` (`run-record.ts:1135`, `resolveRunsDir` `:1159`,
`QDS_RUNS_DIR` override). DF2.1's schema is CLOSED and harvest deliberately writes nothing
to it (`harvest.ts:18-19`: "the bundle's presence at `<runsDir>/<run-id>.bundle` is the
record"). **Do not widen it for in-box telemetry** — same rule as the journal's closed
resident block (`journal.ts:86-97`) and R3 landmine 13. New counters go to the trace
sidecar (`type:"log"` rows, the `steeringInboxError`/`residentTripwire` precedent at
`pipeline-run.ts:1841-1872`) or the driver's `emit()` JSONL stream (`driver.ts:221-233`).

---

## 7. Status / observability of an in-box run

**Today `fleet status` cannot see a run's progress at all.** `statusRun`/`statusAll`
(`src/fleet/status.ts:1025,1140`) read the run record (`:1149`) and `exe.dev ls`
(`listOwnedBoxes`, `:464-501`), and derive rows from `rec.extensions` (approval at `:598`).
There is **no `driver.exec` into the box** in status.ts — no journal read, no marker read.
A run whose engine is running in-box would show `state: "ready"` forever.

**The prior art that already works** is the fanout race poller
(`src/fleet/fanout-primitive.ts:658-700`): it computes `runMarkerPath()` by DIRECT import
(`:670` — "the barrel withholds it (K7)", `phase-engine/index.ts:19-33`) and polls each
box with `readBoxFile(driver, vm, markerPath, deadlineMs)`
(`src/providers/exedev/transport.ts:123-148`) — `test -f` then `cat`, each with its own
deadline, four verdicts (`absent` / `unreadable` / `oversized` / `content`). A marker that
is present-but-unreadable N times running (`MARKER_UNUSABLE_TICKS_LIMIT`) reclassifies the
arm `armUnknown` rather than spinning to the ceiling. This is a **complete, live-proven,
host-observes-in-box poller** and the story should reuse it verbatim rather than invent a
second one.

The other prior art is the shim itself (`scripts/pipeline-run-remote.ts`): `fetchBoxFile`
(`:52-59`) and `boxHome` (`:68-76`, with the measured `$HOME`-survives-shellQuote lesson),
plus the tier3 live test's end-to-end shape (`tier3-remote-phases.live.test.ts:100-140`).
`live-harness.ts:336-360` mirrors all three for tests.

**What the story adds:** a `fleet status` (or `fleet watch`) path that, for a run with a
live `vmName` and no terminal state, reads `/run/journal/final.json` via `readBoxFile` and
reports `running` / `ok` / `not-ok`. Exec cost per poll: one `test -f` + one `cat`, each
bounded by `execTimeoutMs` (default 120 s, `transport.ts:41`) — set a much tighter per-call
deadline as the fanout poller does.

---

## 8. The boundary — what does NOT move

Everything below stays **host-side**, by construction, and the story should say so
explicitly so a later reader does not re-litigate it:

| Component | Site | Why it cannot move |
|---|---|---|
| **Approval gate (DF3.4/DF3.7)** | `src/fleet/approval-gate.ts` (header `:1-30`; `requestApproval` registers `pausing` **before** teardown and promotes to `awaiting-approval` only after, `:11-18`) | The state must **outlive the box** — the gate's whole ordering invariant (INV-APPROVE-6) is that teardown happens inside the pause. An in-box gate would be destroyed by the thing it is gating. DF3.7 owns the bridge: **engine writes an awaiting marker in-box, host polls, gate ownership unchanged** (ADR §"Approval gate", §Consequences-4). |
| **Host re-verify (DF5.1)** | `src/reverify/{runner,approval,plan,report,worktree,redaction}.ts` | It IS the second, independent trust layer. R9's two-layer doctrine (ADR §"load-bearing" item 5): in-box gates emit claims, host re-verify checks them in a different trust domain. Moving it in-box collapses both layers into one. |
| **PR creation (DF5.2)** | **does not exist yet** — no `gh pr create` / `createPullRequest` anywhere under `src/` or `scripts/` | Needs a GitHub push credential; INV-CRED-1 forbids a second secret in a box (`fill.ts:11-17`, `harvest.ts:10-11` "the box holds no push credential (D8/INV-1)" — which is exactly why work crosses as a ranged bundle). |
| **Key mint / deliver / revoke (DF2.3)** | `src/providers/credentials.ts` (`mintRunKey`, `deliverRunKey:435`, `revokeAndVerify`) | The provisioning key is the host's. The box gets exactly one derived, capped key at `app/.env` (`:59`) and never the minter. §6.2's one-secret-per-box. |
| **Reaper / orphan expiry (DF2.6)** | `src/providers/reaper.ts`, `reapRuns` (also `driver.ts`, `status.ts`) | It exists to reclaim boxes whose in-box state is gone or lying. Self-reaping is a contradiction. |
| **Teardown + harvest orchestration (DF2.5)** | `src/providers/teardown.ts:515`, `harvest.ts:415` | Same: it destroys the box. It *reads* in-box artifacts (§6) but runs host-side. |
| **`fleet attach` host leg** | `src/fleet/attach.ts:430-580` `attachToRun` | The operator types it on the host. Only the **consumer** (`localSteeringInbox`, `:658-764`) moves in-box — which is precisely #181's own closing shape and the reason `attach-acked` becomes reachable. |
| **Run record store (DF2.1)** | `src/providers/run-record.ts`, `.sandbox/runs/<id>.json` | Must outlive the box; closed schema. |

**One-line boundary statement for the story:** *anything whose state must survive the box's
destruction, or which holds a credential the box may not hold, stays on the host; the
deterministic phase walk, its resident, its journal and its trace move in.*

---

## 9. Dependency + risk register for the writer

1. **Blocks on DF2.10 (image).** `--image`/`--registry-auth` are not threaded through
   `create()` (`driver.ts:250-256`); bun, a pinned pi, and the engine all arrive by image.
2. **`QDS_PI_CATALOG_DIR` is a hard blocker** for `dispatch_task` and for resident rate
   resolution once pi is a compiled binary with no sibling node_modules (§4). Probe it in
   the image before writing the ACs.
3. **`bun:sqlite` inside `bun build --compile`** is unproven on our version (§2 Route B).
4. **The run-root overload** (§1.4b) is the single largest code change and touches
   setup-gate assertion A. Do not leave it to dev-time discovery.
5. **`Restart=` must be `no`** (§3.2). An auto-restart silently violates the journal's
   default-fail discipline.
6. **Live e2e assertions invert.** `tier1-attach-transport.live.test.ts:29-39` and
   `tier5-gate-steering.live.test.ts:18-28` currently assert `attach-not-acked` / `no-ack` /
   exit 6 as the PASS shape "until DF1.10 lands"; `tier4-resident.live.test.ts:18-22`
   documents host-side phase bodies for the same reason. All three, plus
   `pipeline-run-remote.ts:5-20`'s HONEST LABEL and `:118-120`'s throw, are load-bearing
   comments that must change **in this story**, not be left lying (R3 landmine 12 —
   verified, still true).
7. **`/run` is tmpfs**: nothing durable may live there (§1.4d). The marker and trace are
   deliberately ephemeral-until-harvested; the journal and resident artifacts are not.
