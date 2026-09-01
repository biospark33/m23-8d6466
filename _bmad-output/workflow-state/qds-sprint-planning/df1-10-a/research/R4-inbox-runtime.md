# R4 — In-box Runtime Constraints (DF1.10: in-box steering executor + channel lifecycle)

Research agent 4, qds-sprint-planning, repo `/Users/steve/QDS-Factory` (branch `dev`). Read-only.
Question: **what actually runs in the box**, how does it get there, and what keeps it alive?

---

## 0. The one structural finding the whole report hangs on

The story phrase *"in-box consumer that drains the inbox, folds steering into the tier-2 resident, and writes acks"* is **internally inconsistent with where the resident lives today**. The DF3.3 resident and the entire steering controller (dedupe, fold, tripwires, gates, rate, telemetry, journal) are **host-side**:

- `src/fleet/resident.ts:5-15` — "a `ResidentCaller` that runs **one synchronous pi solicitation per call** over `Bun.spawn`"; "Session continuity is the `--session <path>` FILE …, not a long-lived process".
- `src/fleet/resident.ts:448-471` — the pi process is `Bun.spawn([...])` in the **host** process (`bin = opts.bin ?? process.env.QDS_PI_BIN ?? "pi"`, `resident.ts:348`).
- `tests/fleet/e2e/tier4-resident.live.test.ts:14-21` — live tier: "real **host** `pi` (0.55.x …)"; "WHY THE PHASE BODIES RUN HOST-SIDE: pipeline-run.ts execs `code` phases where it runs (the in-box executor is proposed story DF1.10 …)".
- The controller wiring is host-side too: `scripts/pipeline-run.ts:1786-1836` constructs `createSteering` with `localSteeringInbox(...)` — plain `fs` on **host-local** paths.

So "fold in-box" would require moving the engine (or the resident) into the box. There are only two coherent closures, and DF1.10 must pick one (§ Recommendation / § Open Questions):

1. **(d) move the drain+ack legs to the host**, over the existing `driver.exec` transport — the box channel stays the source of truth, the fold stays where it is. This is the posture the DF3.4 story itself already recorded as the design assumption: *"a host-side engine plus a `driver.exec` transport is exactly what the injected-port design assumes"* (`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md:451-453`).
2. **(B) move everything in-box** — a compiled executor + an in-box resident; that is recon's "REAL-STORY" (`_bmad-output/workflow-state/code-review/e2e-audit/recon/phase-engine.md:118-130`), far larger than a channel-lifecycle story, and it hits a hard wall on `dispatch_task` (§2.4).

---

## 1. What the shipped docs say is in the box

### 1.1 `scripts/pipeline-run-remote.ts` header (the canonical statement)

`scripts/pipeline-run-remote.ts:1-19`:

> "The honest link that is missing in production today (recon G1–G3): nothing invokes the phase engine after dispatch, and **the box image carries no bun/node**, so `scripts/pipeline-run.ts` cannot run in-box. This shim proves the rest of the chain REAL … the phases execute **ON THE BOX** (`sh -c <cmd>` in `$HOME/src` via `driver.exec`) **orchestrated FROM THE HOST**. … **HONEST LABEL: this is NOT the in-box executor (proposed story DF1.10)** — it is the host-driven substrate proof."

And its refusal arm names us: `scripts/pipeline-run-remote.ts:120` — *"no executor is registered for kind '<kind>' on the remote shim (**the in-box executor is proposed story DF1.10**)"*.

### 1.2 The measured image contract

`_bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md:105-108` (F1, live-measured):

> "**Box image has NO node.** `node --version` → exit 127. Image contract: **python3, curl, git, pi** (all verified live). Any doc/plan assuming node workloads on boxes is wrong."

`_bmad-output/workflow-state/code-review/e2e-audit/recon/phase-engine.md:53` and `:78-80`:

> "Box has NEITHER [bun nor the checkout beside it] … image contract = python3, curl, git, pi"
> "| G1 | No in-box runtime: no bun/node in image | … | G2 | No invocation link anywhere … | G3 | Executor never transported: fill array = pipeline.yaml + run-context.json only |"

Post-dispatch box contents (recon `phase-engine.md:56-59`): `$HOME/pipeline.yaml` (stamped), `$HOME/run-context.json`, `$HOME/app/.env` (run key + `QDS_TEAM_RUNNER=local`, `setup-gate.ts:283-295`), target repo at `$HOME/src`.

### 1.3 `oci/Dockerfile` is a DIFFERENT substrate — do not cite it for live boxes

`oci/Dockerfile:41,49-52,61,70-88` — DF2.9's *enterprise* image: `node:22-bookworm-slim` digest-pinned, `npm install @mariozechner/pi-coding-agent@0.55.0`, `USER node`, `CMD ["node_modules/.bin/pi", "-e", "pi-vs-claude-code-vendor/coms.ts"]`. It ships node + pi 0.55.0 **but it is not what live e2e boxes run** (live boxes are `ssh exe.dev new` stock images; F1 above is measured on them). Any DF1.10 plan must state which substrate it targets — the live stock image today, or the DF2.9 image as a future contract.

### 1.4 pi version drift in the live image

`src/providers/exedev/assertions-in-box.sh:179-186` (F14, measured 2026-08-25): "**the box image drifted — pi 0.84.2** never writes models.json (its registry lives in pi's own store …)". The documented contract says 0.55.0 (`setup-gate.ts:422`). Also measured-bad for long-running use: "**pi's node streaming client stalls nondeterministically on exe.dev boxes** (measured 2026-08-19, runs 9-17: gate D hung or returned cost.total = 0 …)" (`assertions-in-box.sh:138-143`).

---

## 2. Proven in-box capabilities: interpreters, delivery, exec shape

### 2.1 Interpreters PROVEN on the box

| Interpreter/tool | Proof | Notes |
|---|---|---|
| POSIX `sh` (dash-family) | everywhere; `fill.ts:277-287`, `attach.ts:228-236`, `driver.ts:87-92` | the only guaranteed one (`src/providers/driver.ts:959`: "`sh` is the only interpreter every driver's box is guaranteed to have") |
| `python3` | `src/providers/driver.ts:963-966` — `command -v python3 >/dev/null 2>&1 \|\| { echo "fill requires python3 in the box (missing dependency)" >&2; exit 127; }` then `exec python3 -c "$1" "$2"`; `assertions-in-box.sh:47,62,79` | DF2.1's fill moved path-safety to python3 **os.open/dir_fd**: `src/providers/driver.ts:906-953` `FILL_PY` uses `os.open(part, os.O_RDONLY \| os.O_DIRECTORY \| os.O_NOFOLLOW, dir_fd=dirfd)`, `os.mkdir(part, 0o700, dir_fd=dirfd)`, and the final create `os.open(name, os.O_WRONLY \| os.O_CREAT \| os.O_EXCL \| os.O_NOFOLLOW, 0o600, dir_fd=dirfd)`. Header rationale `driver.ts:956-962`: the traversal "needs real syscall control `sh` cannot express (no openat/O_NOFOLLOW), so this hands off to python3 … failing loudly … rather than silently falling back to the unsafe path" |
| `curl` | `assertions-in-box.sh:47,108-111,149-151,235-236` | used for the key/ping/cost probes |
| `git` | `fill.ts:315-343`, gate A `setup-gate.ts:363-370` | |
| `pi` | gate B `setup-gate.ts:420-431` (`sh -c "command -v pi"` then `pi --list-models`, "the image contract requires pi 0.55.0" — actual image is 0.84.x, §1.4) | present on PATH in `$HOME` of the ssh exec user |
| **bun / node** | **ABSENT** (F1, §1.2) | |

### 2.2 How things get onto the box (delivery channels)

- **host→box: `driver.exec` stdin, one shot.** Text scripts ride argv-as-constant-literal + payload on stdin (`attach.ts:495` `deps.driver.exec(vm, ["sh","-c",APPEND_SCRIPT], \`${JSON.stringify(line)}\n\`)`; credentials `deliverScript`, `credentials.ts:396-441`). Binary rides base64 on stdin: `fill.ts:241-243` (`umask 077 && rm -f <rel> && base64 -d > <rel>`, then `wc -c` verify :244-251), bundle ceiling 512 MiB pre-inflation (`fill.ts:169`).
- **box→host: `driver.copyFile` only, and it is box-RELATIVE** — `driver.ts:589-602` + `assertBoxPathSafe` `driver.ts:711-725` refuses a leading `/` ("remote path … is not a plain box-relative path"). Reading an ABSOLUTE in-box path through `copyFile` is the exact bug that spun the fan-out race live (`transport.ts:85-95`; `attach.ts:9-16`). Everything absolute is read with `sh -c cat`/`tail -c` instead (`transport.ts:96-130 readBoxFile`; `attach.ts:291-295`).
- There is **no scp host→box path in the driver at all** — `scp` appears only in `copyFile` (box→host). `fill.ts:224-227`: "land the base64'd bundle via exec stdin (**the only host→box content channel** — `copyFile` is box→host by design)".

### 2.3 Every exec is one-shot and bounded

- `transport.ts:39` `DEFAULT_EXEC_TIMEOUT_MS = 120_000`; `transport.ts:60-90` each call is one `Bun.spawn` of `ssh <vm>.exe.xyz <quoted command>` with `timeout` + `SIGKILL`, stdout/stderr capped at `EXEC_MAX_OUTPUT_BYTES = 512 * 1024` (`src/providers/bounded-exec.ts:41`).
- Nothing holds a session open; a long-running in-box process must therefore **detach** (`nohup … &`, pidfile) and be **polled** by later execs. Precedent: `src/providers/driver.ts:1107-1160` `startVisualizer` — `QDS_VIZ_DB='…' QDS_VIZ_PORT='…' nohup bun run server/index.ts >'log' 2>&1 & echo $! > pidfile`, with the reuse check `kill -0 "$(cat pidfile)"` (`driver.ts:1145-1156`) and the dash/`disown` note (`driver.ts:1110-1115`). **That precedent assumes `bun` in-box** — fine for the DF4.2 viz substrate, not for the live stock image.
- Attachment per-call budgets are tighter: `attach.ts:91-110` (30 s ack ceiling, 500 ms ticks, 10 s per-call).

### 2.4 `dispatch_task` cannot move in-box without new work

`cli-anything/src/team-events.ts:36-47` — `buildTeamSpawn` hardcodes `file: "bun"` for the local runner; recon `phase-engine.md:67-69`: it "requir[es] ANTHROPIC/OPENROUTER key in process.env + `QDS_TEAM_RUNNER === "local"` … that executes wherever pipeline-run runs, **not on the box**". Recon option (B) names this explicitly: "plus a decision on dispatch_task-in-box (cannot today: buildTeamSpawn hardcodes `file:"bun"`)" (`phase-engine.md:126-129`).

---

## 3. How DF3.3's resident reaches the box — it doesn't

- **pi runs host-side**, one process per solicitation (`resident.ts:12-15, 446-471`). Binary resolution `resident.ts:348` (`QDS_PI_BIN ?? "pi"`); argv `--provider openrouter --model <id> --mode json --no-tools --session <file> -p <prompt>`; env is a least-privilege allowlist `PATH, HOME, TMPDIR, OPENROUTER_API_KEY, proxy vars, QDS_RESIDENT_TIMEOUT_MS` (`resident.ts:235-247`).
- In-box, the only pi execution today is gate D's one-shot `pi -p --mode json` (`setup-gate.ts` gate D; `assertions-in-box.sh:131-143`), which is measured-flaky in-box (§1.4).
- **User/env in-box**: the ssh exec user is non-root (`exedev`), `/home` is root-owned, `$HOME` is the only writable root (`fill.ts:71-86`). The run key lives in `$HOME/app/.env` mode 0600 (`credentials.ts:59 KEY_ENV_FILE = "app/.env"`, delivery + mode contract `credentials.ts:396-441`; mode verified in-box `assertions-in-box.sh:57-71`) together with `QDS_TEAM_RUNNER=local` (`setup-gate.ts:283-295`) — an env line that "awaits a consumer that was never shipped" (recon `phase-engine.md:71`).
- **tmux/nohup/daemon precedent**: exactly one in-box daemon precedent exists (`startVisualizer`, §2.3) and it needs bun. `grep tmux|nohup|setsid|disown` over src/scripts/cli-anything returns only that one site. **No systemd/cron/supervisor evidence exists anywhere in the repo or evidence tree** (grep over docs/, src/, scripts/, tests/fleet/, e2e-audit/: zero in-box hits).

---

## 4. The DF3.2 "shim" — closest precedent for "a thing that runs over time"

- `scripts/pipeline-run-remote.ts` IS the shim (T3.5, commit `889e4c1` era; header `:3` "REMOTE pipeline runner (T3.5 small-shim …)"). It is **host-side**, not in-box: it fetches the delivered manifest off the box (`fetchBoxFile`, `:43-50`), resolves `$HOME` **on the box** and substitutes a real absolute path because `cat '$HOME/pipeline.yaml'` reads a literal `$HOME` dir (`boxHome`, `:60-75`; the bug is commit `889e4c1` item 2), loads the manifest with production `loadManifest`/`runContextFrom`, and execs each `code` phase **on the box** via `driver.exec(vm, ["sh","-c", …])` in `$HOME/src` (`makeRemoteBodyFactory`, `:96-140`), with per-arg `shellQuote` (item 3 of the same commit — a bare `cmd.join(" ")` flattened `sh -c` scripts and was reproduced live).
- **Lifecycle**: started by the host test/verb, runs for the duration of one host process, stops when the host stops. Nothing on the box persists between execs. It is the precedent for *host-driven on-box work*, not for *in-box longevity*.
- Live evidence: `_bmad-output/evidence/df3-e2e/2026-08-28-172836-t3-2-manystories.json` — T3.2 arms exec'd on-box work (`arm-work` phases exit 0, harvested SHAs) plus `boxes-live`/`harvest-arm`/`teardown-arm` legs; `tests/fleet/e2e/tier3-remote-phases.live.test.ts:12-27` pins the T3.5 contract ("phases executing ON THE BOX, orchestrated FROM THE HOST").

---

## 5. pi extension / skill route (option c)

- Mechanism in this repo: extensions are loaded by **argv** `-e <path>`; `--no-extensions` disables *discovery only*; `--no-skills` disables discovery **and** loading (`cli-anything/scripts/team-lead-driver.ts:50-59`, `buildWorkerArgv :384-401`, lean worker DF1.9). No `settings.json` packages usage exists anywhere in this repo (grep: zero hits); extension config rides `QDS_AGENT_TEAM_CONFIG_JSON` env (`team-events.ts:14-16`). pi-lens (P0.5) is a **host-side** verifier harness (`scripts/pi-lens-verify.ts`, `src/gate/assertions/p0-5-pi-lens.ts`), not an in-box service.
- **Lifecycle implication is fatal for option (c) as a standalone answer**: a pi extension executes only while a pi process runs. The resident pi never runs in-box; in-box pi runs only as gate D's one-shot. So "make the drainer a pi extension" requires *first* solving "who keeps a pi process alive in-box" (supervision — which does not exist, §3), *and* accepting the measured in-box pi stall family (`assertions-in-box.sh:138-143`), *and* it still would not fold steering into the resident (the resident is host-side, §0). Option (c) is **strictly harder** than (a)/(b) and delivers the same fold-capability: none.

---

## 6. Constraints inventory

### 6.1 `/run` tmpfs and reboot (#180)

- `/run` is tmpfs and a reboot wipes the channel: `attach.ts:286-289` ("a wiped steering root (**a reboot** — `/run` is a tmpfs — or a rebuilt box)"), `attach.ts:594`, `attach.ts:713-716`, `src/phase-engine/steering.ts:491`.
- The channel is provisioned **at box birth only**, with passwordless sudo, because the exec user is non-root and `/run` is root-owned 755 (`src/providers/exedev/driver.ts:60-92`, measured 2026-08-30 T1.8): `STEERING_PROVISION_SCRIPT = root="${QDS_STEERING_ROOT:-/run/steering}"; sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root"; test -w "$root"; test "$(stat -c %a "$root")" = 700`. Its only callers are `create()`'s two success arms (`driver.ts:275,284` → `provisionSteeringChannel :308-316`). **No re-provision verb or path exists.**
- `attach`'s append script cannot self-heal a wiped channel: its `mkdir -p "$root"` (`attach.ts:231`) needs to create a directory under root-owned `/run` as a non-root user → EACCES → `send-failed`. Note `driver.ts:87-92`'s script uses `sudo -n install -d` precisely because plain mkdir cannot.
- Who reboots boxes / does exe.dev live-migrate: **no repo evidence either way**. The repo only assumes reboots happen and wipe `/run` (cites above) and that boxes are destroyed by the factory's own teardown/reaper (`driver.ts:443-464`; DF2.6). This is an operator/substrate question to resolve, not a code fact (see Open Questions).

### 6.2 Supervision

None in-box. The only shipped in-box longevity mechanism is `nohup`+pidfile+log (`driver.ts:1145-1156`), bun-dependent. A sh/python3 daemon would have to invent: pidfile convention, stale-pid reclaim, restart-on-reboot (there is **no boot hook** — nothing survives a reboot except the image itself, so a reboot kills the daemon *and* the channel, and only the host can re-provision both).

### 6.3 Shell-hardening precedents from DF2.2's in-box scripts

- `assertions-in-box.sh:24-37`: `set -u`, **IFS built via printf** (`IFS="$(printf ' \t\nx')"; IFS="${IFS%x}"`) because F11 measured that the single-quoted `IFS=' \t\n'` shipped as the *literal* chars and shredded every slug containing n/t; `export LC_ALL=C` for hermetic parsing.
- `fill.ts:277-287`: `IFS=/; set -f; set -- $w` path walk (`-f` so a glob char in a component cannot expand against the filesystem), per-component `-L` symlink refusal.
- Payload discipline: nothing host-supplied is ever interpolated — argv is a constant literal, the payload rides stdin (`attach.ts:196-236`), python source rides as a separate argv element (`driver.ts:878`, `:958-962`).

### 6.4 Concurrency primitives in-box

- **The box carries no lockfile helper** — `attach.ts:219-226`: "this append is SINGLE-WRITER BEST-EFFORT … (the box carries no lockfile helper) … the payload is small enough to leave in one `write(2)` from an O_APPEND fd, which the kernel serialises"; the newline guard `{ [ ! -s "$f" ] || [ "$(tail -c1 "$f")" = "" ] || echo >> "$f"; }` (`attach.ts:233`) stops a torn tail from destroying the next line.
- The host-local leg does take a real lock: `appendUnderAcksLock` (`attach.ts:632-656`) on `join(steeringRoot(), "acks.lock")` with `<pid>:<nonce>` content and staleness `ageMs >= 5_000 || pid === undefined || isPidDead(pid)`; `isPidDead` = `process.kill(pid, 0)` → ESRCH (`src/lib/file-lock.ts:50-62`).
- **Cross-machine hazard**: that staleness machinery is meaningless across the host/box boundary. A box-pid written into a lock the *host* evaluates is compared against *host* pids — `kill(boxpid, 0)` hits an unrelated host process, so the lock reads either falsely live (blocks forever) or falsely dead (stolen mid-write). Any DF1.10 design that lets **both** a host process and an in-box process write the same acks file via this lock inherits a real race with a broken staleness oracle. (Today there is no in-box writer, so the lock is single-machine and correct.)

### 6.5 Read caps that bound any ack/inbox traffic

`ACKS_READ_CAP_BYTES = 512 * 1024` (`attach.ts:266`) — deliberately equal to `EXEC_MAX_OUTPUT_BYTES` (512 KiB, `bounded-exec.ts:41`), pinned by a drift-guard test; `INBOX_READ_CAP_BYTES = 1_048_576` (`attach.ts:313`). `ACK_READ_SCRIPT` exits **3** when the inbox file is missing (wiped channel/reboot) so "box unreachable" is never reported as "no ack yet" (`attach.ts:282-295`, `readAck :367-400`).

---

## 7. How acks get back to the host today (and what DF1.10 changes)

- **Today**: the *only* ack writer is the engine leg `localSteeringInbox().ack` — **host-local** `fs` (`attach.ts:710-762`), under `acks.lock` (§6.4). The host *reads* the box acks over the transport (`ACK_READ_SCRIPT`, `tail -c 512KiB`, exit 3 on missing inbox). On a live remote box **nothing writes acks at all** — measured: `_bmad-output/evidence/df3-e2e/2026-08-30-162345-t1-8-attach-transport.json` — `inbox-after-1 lineCount: 1`, `inbox-after-2 lineCount: 2`, **`acks-file state: ABSENT`**, `fleet attach` exit 6 `no-ack` with the DF1.10 remediation text ("no in-box executor exists yet"). That is Deviation 12 / #181 in one artifact.
- **Absolute-path refusal**: `copyFile` cannot fetch `/run/steering/acks.ndjson` (`driver.ts:711-725`) — every ack read must stay `sh -c` (`attach.ts:291-295`, `transport.ts:96-130`). Any DF1.10 transport reuses that shape; do not reintroduce `copyFile` (the story's original wording; corrected in `attach.ts:23-27` with `pipeline-run-remote.ts:5-19` as the citation).
- **"Push acks via driver.exec appends"**: the box cannot exec *to the host* — there is no box→host-initiated channel. What is achievable is the inverse: the **host engine writes acks into the box** with an APPEND_SCRIPT-shaped exec (constant literal + newline guard + `umask 077`/`chmod 600`), and keeps/derives its dedupe log from the same file. The existing `readSteeringAckedIds` (`scripts/pipeline-run.ts:155-190`) currently reads the **host-local** `acksPath()` with the same 512 KiB tail window — under option (d) that read must move to the transport too (or the engine keeps a second, host-side dedupe log; pick one truth — see Open Questions 3).
- **Mutual exclusion under an in-box writer**: §6.4 — if DF1.10 ever adds a real in-box ack writer, the host-side `<pid>:<nonce>` lock becomes actively harmful (cross-pid-namespace staleness). Either keep exactly one writer per file (recommended), or give the box its own in-box lock convention (new code, no precedent).

---

## 8. RUNTIME OPTIONS

| | (a) POSIX `sh` polling daemon, started at provision | (b) `python3` script (one-shot or daemon) | (c) pi extension/skill | (d) **host-driven poll loop** (no in-box consumer; engine drains the box inbox through `driver.exec`, folds host-side, writes acks over the transport) |
|---|---|---|---|---|
| **Precedent** | `driver.ts:1145-1156` nohup+pidfile (but bun-based); `assertions-in-box.sh` for in-box sh discipline | `driver.ts:906-966` `FILL_PY`/`FILL_SCRIPT` (`python3 -c` with argv-passed source); `assertions-in-box.sh:62-79` python3 for JSON | `team-lead-driver.ts:50-59,384-401` (`-e`, `--no-extensions/--no-skills`); in-box pi only as gate D one-shot (`setup-gate.ts:420-431`) | `attach.ts:228-236` (append exec), `attach.ts:291-295` (ack read exec), `transport.ts:96-130` (`readBoxFile`), `pipeline-run-remote.ts` (host-driven on-box exec of the production engine) |
| **Who starts it** | host, at `create()`/provision (the one chokepoint every box passes: `driver.ts:60-73,308-316`) | host, at provision (same chokepoint) | pi, only when a pi process starts — **nothing starts pi in-box today** | nobody — nothing new runs in-box; the engine's existing solicitation points (`steering.ts:627-763 drainInbox`) gain a transport |
| **Who keeps it alive / restarts it** | nobody can: no supervision in-box (§6.2), no boot hook; a reboot kills it **and** wipes `/run` (§6.1) — it cannot self-heal | same as (a) for daemon form; one-shot form needs no supervision but then it is just (d) with worse latency | pi process lifetime only | host process lifetime; the resident/engine already degrade-not-invalidate when absent (`resident.ts:12-15`, `steering.ts` INV-RES-5) |
| **Failure modes** | silent daemon death (no supervisor); torn NDJSON appends (mitigable, `attach.ts:233`); lock/oracle gaps (§6.4); unreadable on reboot; two writers per file | same as (a) if daemonized; as a one-shot it burns an exec per poll (120 s budget each, `transport.ts:39`) | requires an in-box pi supervisor first; measured pi stall family in-box (`assertions-in-box.sh:138-143`); pi 0.84.x vs 0.55.0 contract drift (§1.4); extension can't fold into a host-side resident at all | per-exec 137/255 transport faults — already classified and remediated (`driver.ts:103-144`, `attach.ts:349-365,542-555`); box-unreachable vs no-ack already truthful; torn lines skipped (`attach.ts:588-594`); foreign-run lines filtered (`attach.ts:684-707`) |
| **Fit for #181's closing shape** | closes "consumed on-box" literally, but folding still can't happen in-box (§0) — it can only *relay*, and the relay target (host) has no inbound channel | same as (a), with a better interpreter | does not close anything | closes the **round trip** (append → drain → fold → ack → `fleet attach` sees the ack) with zero new runtime, zero supervision, and the dedupe/fold/telemetry in the one place that owns them; matches the recorded DF3.4 design posture (`df3-4 story:451-453`) |
| **#180 fit** | worse: more in-box state to re-provision | same | n/a | best: re-provision is a host-side, idempotent re-run of the existing script (§ Recommendation step 2) |

---

## 9. RECOMMENDATION

**Adopt (d) — host-driven steering inbox over the existing `driver.exec` transport — as DF1.10's delivery, and record (a)/(b) as the separate "true in-box executor" story (recon option B) that DF1.10 explicitly does not attempt.**

Reasoning:

1. **The fold cannot move in-box without moving the engine.** Dedupe (`steering.ts:484-509`), fold-at-solicitation-points, tripwires, gates, rate resolution, journal/telemetry and the resident spawn are all host-side and heavily reviewed. An in-box consumer could at best relay lines to a host that has no inbound channel (§2.2) — so "in-box consumer folds into the resident" is unsatisfiable as literally worded. Option (d) is the only shape where every element of #181's round trip is real on a live box.
2. **Every transport primitive already exists and is live-proven**: append with newline guard (`attach.ts:228-236`), tail read with exit-3 unreachable semantics (`attach.ts:291-295`, `:367-400`), `readBoxFile`'s absent/unreadable/oversized taxonomy (`transport.ts:96-130`), host-driven on-box exec of the production engine (`pipeline-run-remote.ts`), and the live T1.8 evidence showing exactly the leg that is missing (acks ABSENT, §7).
3. **#180 fits (d) naturally**: extract the existing `STEERING_PROVISION_SCRIPT` into an exported, idempotent `ensureSteeringChannel(vm)` (the script is already idempotent-by-design, `driver.ts:76-79`) with `create()` as one caller and the transport path as the second — invoked when the channel is found missing (the exit-3 signal, or EACCES on append), so a rebooted box converges without a new substrate verb. Do **not** bolt it into `ExeDevDriver.exec` itself: the DF3.4 review already deferred that as CRITICAL-blast-radius ("steering send-path self-heal … `ExeDevDriver.exec`, whose blast radius is CRITICAL (27 symbols …)" — `df3-4 story` "Deferred" section).
4. **It is the smallest honest diff**: one new `SteeringInbox` implementation (drain/ack over `driver.exec`) injected where `localSteeringInbox` is today (`pipeline-run.ts:1817`), plus the re-provision chokepoint. No new in-box artifact, no supervision story, no compiled binary, no pi-in-box re-measurement.

**Anti-recommendations**: (c) is rejected outright (§5). (a)/(b) as daemons are rejected for DF1.10 (unsupervisable, reboot-amnesic, and they still can't fold) — but note them in the story as the only route to a *literal* "resident consumes on-box", since that requires moving the resident itself (recon option B, `phase-engine.md:118-130`).

---

## 10. OPEN QUESTIONS for the operator / story writer

1. **Does #181's wording require a true in-box process?** The story title says "in-box steering executor"; the sprint's own recorded posture says a host-side engine + `driver.exec` transport is the design (`df3-4 story:451-453`), and Deviation 12's remediation only demands that the *round trip close*. If the operator reads "in-box executor" literally, the story is recon option B (compiled executor + in-box resident), a multi-story effort, and it needs a `dispatch_task`-in-box decision first (§2.4). This is the single decision that sizes DF1.10.
2. **Where does the ack truth live under (d)?** `readSteeringAckedIds` (`pipeline-run.ts:155-190`) reads the **host-local** acks file. If the engine writes acks to the **box** file (so `fleet attach`'s existing poller sees them), the dedupe seed must read the box tail over the transport (one extra exec per solicitation) or the engine must maintain two logs (risk: divergence). Recommend: box file is the only ack surface; dedupe reads it over the transport with the same 512 KiB window.
3. **Single-writer discipline**: confirm DF1.10 keeps exactly one ack writer (the engine). If any in-box writer is ever added, the host `<pid>:<nonce>` staleness oracle becomes cross-namespace-unsafe (§6.4) — that constraint should be written into the story as an invariant.
4. **Driver plumbing**: the engine leg deliberately has no driver reference today ("this runner has no vm", `attach.ts:20-22`; `pipeline-run.ts:1794-1800`). Option (d) must inject a transport (driver + vm name from the record) into `pipeline-run.ts` — a real inversion to design, and `pipeline-run-remote.ts` is the precedent for how a host runner obtains one. How does the local/fake path keep working (`QDS_STEERING_ROOT` host-local, FakeDriver)?
5. **Reboot/substrate facts**: nothing in the repo says whether exe.dev boxes reboot or live-migrate, or whether any boot hook exists. If a box *does* reboot, the channel is gone and (under (d)) only the host can restore it — is the desired post-reboot posture "re-provision on next send/drain" (cheap, recommended) or "fail the run" (current implicit behavior via `exit 3`/`box-unreachable`)?
6. **pi version drift**: gate D proves pi-in-box is 0.84.x while the documented image contract is 0.55.0 (`setup-gate.ts:422` vs `assertions-in-box.sh:179-186`), with a measured stall family. Any option that touches in-box pi must re-measure; (d) avoids pi in-box entirely.
7. **Is `QDS_TEAM_RUNNER=local` in the box env file (`setup-gate.ts:283-295`) claimed by DF1.10, or removed?** Recon flags it as "awaiting a consumer that was never shipped" (`phase-engine.md:71`); it is exactly the seam an in-box executor would use.

---

## 11. Box substrate facts (one-paragraph summary)

Live exe.dev stock box: POSIX `sh`, `python3`, `curl`, `git`, `pi` on PATH; **no bun, no node** (measured exit 127, `e2e-run-report.md:105-108`); non-root ssh exec user, `/home` root-owned, `$HOME` the only writable root (`fill.ts:71-86`); `/run` root-owned 755 + tmpfs, so the steering channel exists only via `sudo -n install -d` at create time (`driver.ts:60-92`) and is wiped by any reboot (`attach.ts:286-289`); no systemd/cron/supervisor evidence and no boot hook; every host interaction is a bounded one-shot `ssh` exec (120 s default, 512 KiB output cap — `transport.ts:39,60-90`, `bounded-exec.ts:41`) or an scp **pull** that refuses absolute paths (`driver.ts:589-602,711-725`); host→box delivery is exec-stdin only (text or base64, `fill.ts:241-251`). `oci/Dockerfile` describes a different, node-22+pi-0.55.0 enterprise substrate (`oci/Dockerfile:41-88`), not the live boxes.
