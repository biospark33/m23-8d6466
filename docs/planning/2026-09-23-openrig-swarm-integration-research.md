# OpenRig × QDS-Factory × SwarmClaw — Integration Research & Plan

**Date:** 2026-09-23
**Status:** Research complete; spike S0 PASSED 2026-09-23 (see §9a) — next: S1
**Author:** Claude Code (Opus 5.5) with operator (steve), from 12 parallel research agents in three waves
**Pinned refs examined:**

| Repo | Ref | Notes |
|---|---|---|
| OpenRig (`github.com/mvschwarz/openrig`) | `c8fca9d5` (v0.5.14, 2026-09-23) | cloned to `/tmp/openrig`, full history |
| QDS-Factory | `6bc089ec` (`dev`) | plus branch `feature/rpc-worker-handoff` |
| SwarmClaw fork (`~/swarmclaw`) | `45d3376b` (`dev`) | |

---

## 0. TL;DR

1. **OpenRig doesn't replace QDS-Factory.** They solve different problems. OpenRig
   is a *local, human-supervised* control room for long-lived Claude Code / Codex /
   Pi sessions in tmux. QDS-Factory is an *unattended* pipeline: work is admitted,
   runs in a throwaway VM under a hard money cap, is re-verified outside the box,
   and ends in a PR.
2. **We don't port our features into OpenRig's code.** Upstream won't accept them,
   a fork costs too much to keep current, and it runs on Node while we run on Bun.
   Instead we **run OpenRig inside the factory box.** The box already provides what
   OpenRig lacks: the VM is the sandbox, capped per-seat keys are the money limit,
   reverify is the trust check, and the approval gate protects the PR.
3. **It fits the three tiers.** OpenRig's lead seat takes the tier-2 role and its
   other seats take tier 3. The local Claude Code cockpit (tier 1) can watch and
   talk to the swarm through `rig mcp serve` over an SSH tunnel, or through
   `fleet attach`.
4. **The SwarmClaw DAG sits above all of it.** A `factory_run` node calls the
   `fleet submit/result/cancel` contract. The manifest picks the mode inside the
   box (`pi-team`, `rig_swarm` or `fanout`). SwarmClaw never needs to know
   OpenRig exists.
5. **Blocking prerequisites before the DAG can run:**
   - four confirmed SwarmClaw protocol-engine bugs;
   - replay-safe `fleet submit` (a replayed or lease-expired call today
     provisions a second box);
   - a cross-process VM quota reservation.
6. **Next step: spike S0.** Prove an OpenRig daemon plus Pi seats boots headless
   in an exe.dev box, with per-seat capped keys and our extensions, drivable
   from the cockpit.

---

## 1. What OpenRig is

### 1.1 Facts

- **Stack:** TypeScript on **Node 20/22/24** (not Bun). Hono HTTP daemon on
  `127.0.0.1:7433`, better-sqlite3 (WAL), tmux, a CLI (`rig`), a TUI, a legacy
  React UI, and an MCP stdio server (`rig mcp serve`). Apache-2.0.
- **Size:** about 478k lines of TS across `packages/{daemon,cli,tui,ui}`. 1,180 test
  files (about 13.4k cases). No `.github/` CI; gating runs through local scripts.
- **Age and cadence:** first commit 2026-03-23. 2,988 commits, 864 of them in the
  last 30 days. 84 SQLite migrations. Releases every 1–5 days.
- **Authorship:** since 2026-08-01, 1,480 of 1,504 commits come from
  `v-openrig-build`, the author's own agent build rig. About 1,270 commits carry
  `Co-Authored-By: Claude`. **Bus factor is 1** (Mike Schwarz). 185 stars and
  about 3.7k npm downloads a month.
- **Intent:** the author's blog frames it as solving "topology loss". The motto is
  "Built for agents, observed by humans". It is human-supervised by design.

### 1.2 Domain model

`Rig ⊃ Pod ⊃ member → Node`, with a live **Session** bound to a tmux pane.
A **Seat** is a stable address such as `dev-owner@first-project`. Its
occupant (the conversation) can be replaced while the seat keeps its
identity. Edges between seats come from a closed set: `delegates_to`,
`spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`.
The types are hand-rolled TS in `packages/daemon/src/domain/types.ts` and the
validator is `rigspec-schema.ts`. There is no JSON Schema or OpenAPI.

### 1.3 Subsystems that matter to us

| Subsystem | Behaviour | Relevance |
|---|---|---|
| **HTTP API** (~70 route groups, `server.ts:684-800`) | `/api/rigs/import` (inline YAML + `X-Rig-Root`), `/api/up`, `/api/down`, `/api/queue/*`, `/api/transport/{send,capture}`, `/api/workflow/*`, `/api/events` SSE with `Last-Event-ID` replay | Main integration surface. Not versioned. |
| **MCP** (`packages/cli/src/mcp-server.ts`) | 19 tools (`rig_up/down/ps/send/capture/chatroom_*`, …). No queue or workflow tools. | How the cockpit connects |
| **Queue** (`queue-repository.ts`, 3.5k lines) | Explicit destination, nudge by typing into the pane, agent-asserted completion, wake ladder, stuck sweep, append-only transitions | How work is handed to the lead seat |
| **Workflow engine** (`workflow-runtime.ts`) | Serial-with-branches or DAG (`depends_on`), human or role gates, loop guards. **Every step is an agent turn.** No deterministic or exec steps. Acceptance only checks that fields are present. | Overlaps SwarmClaw. **Don't use it for macro flow.** |
| **Remote hosts** (`domain/hosts/*`) | `hosts.yaml`; `http` transport needed for remote `rig up`; the remote must already run a daemon. No VM provisioning. | Not needed if OpenRig runs *inside* the box |
| **Pi runtime** (`adapters/pi-runner*.ts`) | Pane-hosted runner drives `pi --mode rpc`: typed events, deny-by-default env allowlist, sidecar state, session-file resume | Structured, no screen-scraping. The safe runtime for unattended use. |
| **Claude/Codex runtimes** | Paste into the tmux pane, read the screen back (`capture-pane`, ~22 call sites) | Fragile when nobody is watching (issues #12, #14, #17) |

### 1.4 What OpenRig does not have

- Money caps. Only token and rate-limit telemetry (`usage_samples`, migration 062).
- A sandbox. Permission policies are "advisory and fail-open".
- Output verification.
- Git, worktree or PR orchestration.
- Provisioning of throwaway hosts.
- Authentication on most routes when bound to loopback or Tailscale.
- Replicated state.

### 1.5 Security notes

- It edits `~/.claude.json` (trust and onboarding flags) with a non-atomic
  read-modify-write, and writes `trust_level="trusted"` into `~/.codex/config.toml`.
- YOLO mode (`OPENRIG_YOLO=1`) launches Claude with `--dangerously-skip-permissions`.
- The bearer token is enforced on only about 8 of 67 route modules.
- **Rule for us:** the daemon only ever binds to loopback inside a throwaway box.

### 1.6 Process ideas to borrow (independent of integration)

- A machine-wide test mutex that records host load next to the verdict (`scripts/gate-lane.mjs`).
- `.evidence/` receipts: a red-at-base result pinned to the base SHA, and a
  mini-spec per task with a proof contract.
- Evidence split into **observed** and **unobserved** claims in release notes.
- A pre-publish leak scanner for internal hostnames and paths (`check-substance-gate.mjs`).
- Docker base images pinned by digest.

---

## 2. What QDS-Factory is (as it relates here)

### 2.1 The tiers (v5 spec D2–D5, `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md:299-362`)

```
T1 COCKPIT    local Claude Code (Max) + skills → fleet CLI
              dispatch | fanout | status | attach | observe | approve | teardown
T2 SANDBOX    resident orchestrator agent (steers; bounded) + TS phase engine
              (deterministic gates) + trace store + run record
T3 EXECUTION  dispatch_task → team-lead-driver.ts → pi lead + workers (coms)
```

The cockpit reaches a running box through `fleet attach <run> --message`
(which queues steering for the resident agent and waits for its ack,
`src/fleet/verbs.ts:312`) and through `fleet status`.

### 2.2 What a full run looks like today (5 CLI calls)

1. `fleet dispatch --driver exedev --brief <file>`
   - mints the runId;
   - reserves budget (the `gate_admissions` ledger table);
   - mints a capped OpenRouter key (`credentials.ts:513`);
   - creates and fills the VM, then runs the setup gate.
2. `fleet run <runId>`: starts the `qds-run@<runId>` systemd unit.
3. `fleet observe <runId>`: harvest → teardown → reverify → stops at `awaiting-approval`.
4. `fleet approve <runId> --approver …`: a human decision, authenticated with scrypt.
5. `scripts/open-pr.ts <runId>`: refuses unless reverify is green and the run is approved.

### 2.3 Strengths we keep

- **Hard money caps:** the provider enforces the key `limit`, backed by an
  append-only SQLite cost ledger.
- **Isolation:** throwaway VMs, a reaper, and teardown that verifies the key was revoked.
- **Trust:** out-of-box reverify in a separate worktree. The box's own claims are never trusted.
- **Observability:** a deterministic phase trace (7-table SQLite) and the visualizer.
- **Unattended by design.**

### 2.4 Gaps before the factory can serve as a DAG node

| # | Gap | Evidence |
|---|---|---|
| G1 | There is no single "submit" call; it takes 5 calls | §2.2 |
| G2 | **No replay protection.** The same `requestId` mints a new run and a new box | `cost-ledger.ts:2196-2202`, `dispatch.ts:2520-2561` |
| G3 | No completion signal (no webhook, SSE or `--wait`); only polling | `status.ts`, `observe.ts:107` |
| G4 | No `cancel` verb; `teardown` is used as a stand-in | `verbs.ts` |
| G5 | The VM-headroom check is guarded only within one process, so separate processes can race past it | `dispatch.ts:885-918` |
| G6 | No budget covering a whole DAG run; `fleet dispatch` has no cap flag | `verbs.ts:92-113` |
| G7 | FleetLock is global, so a second concurrent fanout fails with exit 5 | `fanout-primitive.ts:403` |
| G8 | The brief requires `repoSlug+issueId+commitSha+repoUrl`, so non-issue work needs a synthetic ID | `brief-schema.ts:305-478` |

### 2.5 Worker-runtime bugs found on the way (P0, independent of this plan)

These are in `cli-anything/scripts/worker-rpc.ts` on `feature/rpc-worker-handoff`:

1. **A prompt error is ignored.** If pi returns `error(id,"prompt")`, no
   `agent_settled` ever arrives, and the worker hangs until `timeoutMs`.
2. **A failed `get_state` is treated as idle.** Shutdown then proceeds even if a
   compaction is in flight (it fails open).
3. **The spawn-error path skips `finish()`.** Timers leak, and a later SIGKILL can still fire.
4. **Possible:** no re-arm on `compaction_end` or `auto_retry_end` after a failed compaction.

Harden alongside: an env allowlist (workers currently get the whole
`process.env`), a `drainReason` on each result, and an opt-in session file for
resume. Port the patterns from OpenRig's `pi-runner-protocol.ts`, but **not its
`readline` JSONL framing**. That framing is a latent bug: readline also splits on
U+2028 and U+2029, which are legal inside JSON strings.

---

## 3. SwarmClaw's protocol engine: capabilities and confirmed bugs

### 3.1 Capabilities

- **Step kinds:**
  - agent discussion: `present`, `round_robin`, `compare`, `decide`, `summarize`, …;
  - dispatch: `dispatch_task`, `dispatch_delegation`, `a2a_delegate`;
  - control flow: `branch`, `repeat`, `parallel`, `join`, `for_each`, `subflow`,
    `swarm_claim`, `wait`, `complete`.
- **No `code`, `http`, `mcp_call` or `browser` step kinds.** Extensions cannot add step kinds.
- **DAG mode** switches on when any step has `dependsOnStepIds`.
- **Conditions** can only test artifacts, summaries and task counts.
- **`stepOutputs`** has no production writer (`emitStepOutput` has zero callers).
- **Durability:** SQLite, a 120 s runtime lease, and crash-recovery on boot.
  Work done outside the process (the `a2a_delegate` promise) does not survive a crash.
- **Browser automation** exists only as an agent tool (`@playwright/mcp`).
- **Agents** are one-shot `child_process.spawn` calls. No tmux.
- **`src/lib/server/solstice-fleet/`** has nothing to do with the QDS fleet.

### 3.2 Bugs confirmed by executable tests (scratch worktree at `45d3376b`, since removed)

| # | Bug | Evidence | Fix |
|---|---|---|---|
| 0 | `normalizeProtocolRun` drops `phaseState.dispatchedTaskId` (`protocol-normalization.ts:534-547`). **A run with a dispatch step never wakes.** | After a wake the run stayed `waiting` with `d: running` | One line: carry the field through normalization |
| 1 | The wake path advances the run even when the task `failed` or was `cancelled` (`protocol-run-lifecycle.ts:103-129`). The queue only wakes on success (`runtime/queue/core.ts:1690`). | Linear run with a failed task: `completed`, and the downstream step ran | Fail the run or step on a non-completed status; also wake from the queue's failure branches |
| 2 | In DAG mode the wake skips `finishStep` → `currentStepId=null` → `completeProtocolRun`. **The DAG completes early.** | `{"status":"completed","stepState":{"d":"running","dep":"pending"}}` | Wake through `finishPhase`; refuse to complete while any step is running |
| 3 | DAG mode runs only `readyStepIds[0]`, and one waiting step pauses the whole run (`:382-404`) | The `r2` root stayed idle while `r1` waited; the join never ran | Keep the run `running` while other steps are ready; key dispatch state per step |

**Blocking risk found in adversarial review:** the 120 s lease against minutes-long
dispatch. If a step blocks on `fleet dispatch`, the lease expires, recovery
re-runs the step, and a **second box and second key** are created. Fix: persist
the request id *before* submitting, make submit idempotent (G2), and have submit
return its ack immediately.

---

## 4. Target architecture

```
SwarmClaw DAG  (automated tier 1: what runs, when)
 ├─ external_job/factory {mode: pi-team}      ─► box: phase engine + pi lead/workers (coms)
 ├─ external_job/factory {mode: rig_swarm}    ─► box: phase engine + OpenRig lead + seats
 ├─ external_job/factory {mode: fanout, n:3}  ─► N boxes, rank/pick best
 ├─ code / http node (later)                  deterministic, outside the box
 ├─ browser node (later)                      scripted Playwright against the preview deploy
 └─ branch on factory_result artifact → notify / next stage

Claude Code cockpit (human tier 1): watch and steer any box
  pi-team:   fleet status / fleet attach
  rig_swarm: ssh -L 17433:127.0.0.1:7433 box + `rig mcp serve --port 17433`
             (or fleet attach routed to the lead seat's queue)
```

### 4.1 Rules that must hold

1. **The factory is the only way code changes enter.** The DAG never
   provisions boxes, mints keys or opens PRs itself. It only calls
   `fleet submit/result/cancel`.
2. **One tier-2 brain per box.** In `rig_swarm` mode the OpenRig lead seat
   orchestrates and the resident agent is off (`--no-resident`). The phase engine
   keeps gate authority (`testCommand`).
3. **The cockpit talks to agents but never runs box operations.** Box lifecycle,
   keys and PRs stay behind the fleet CLI (v5 D3). The OpenRig MCP is only for
   watching and conversation. Never call `rig_up` or `rig_down` against a factory
   box, because the phase body owns them.
4. **The DAG never approves.** `factory_run` finishes at `awaiting-approval`
   with a `factory_result` artifact. A human runs `fleet approve`. Any
   auto-approve policy would live in QDS next to the gate, under its own ADR.
5. **Money is enforced only in QDS.** A DAG run passes
   `--budget-group <protocolRunId> --group-cap <usd>`, and QDS reserves against
   both the group cap and the per-issue cap in one ledger transaction.
6. **OpenRig's workflow engine is not used for macro flow.** SwarmClaw owns ordering.

### 4.2 Where each step belongs

- **Inside the box, as a `code` phase:** anything that runs on the candidate tree
  before verification (tests, lint, codegen, Playwright against a local dev server).
  It shares the box, the key, the trace and reverify.
- **A separate DAG node:** anything that needs a deployed artifact, an external
  system, parallel execution or a different runtime (browser QA on a preview,
  notifications, data jobs).

---

## 5. Running OpenRig inside the box: findings

### 5.1 Headless boot works

- **Target OS:** Ubuntu 24.04 (tmux 3.4). **Avoid tmux 3.3a** (Debian 12,
  Ubuntu 22.04): issue #12, where tabs in `-F` output become `_`. The session
  and pane paths are fixed; window, client and cursor parsing still split on tabs.
- **Install:** Node 22, `tmux`, `python3 make g++` (as a fallback for
  compiling better-sqlite3), `@openrig/cli@0.5.14` and pi.
- **Skip `rig setup`.** It is macOS/Homebrew-oriented and optional.
- **Start:** `rig daemon start --no-kernel` runs detached and binds
  `127.0.0.1` by default. No token is needed on loopback.
- **No interactive steps** for Pi-only rigs: `--mode rpc` with explicit
  `--approve/--no-approve`.
- **Boot time estimate:** about 2–3 min cold, about 20–40 s from a prebuilt image.
  A Pi seat has **15 s to become ready** (`pi-runtime-adapter.ts:343`), which may
  be tight while extensions compile on first run.

### 5.2 Per-seat keys and our extensions work without patching OpenRig

- Each Pi seat has its own config folder:
  `PI_CODING_AGENT_DIR=$OPENRIG_HOME/state/pi/<pod>-<member>@<rig>/agent`.
  The adapter only creates it if missing (`mkdirp`, `pi-runtime-adapter.ts:222`).
- **Pre-fill it before `rig up`:**
  - `auth.json` → `{"openrouter":{"type":"api_key","key":"<seat key>"}}`.
    Pi reads credentials in the order `--api-key`, then `auth.json`, then env,
    so each seat gets its own capped key.
  - `settings.json` → `{"extensions":[".../self-compact", ".../coms.ts"]}`.
    Pi auto-loads these.
- The daemon-wide env allowlist stays **empty**, so no shared key leaks into seats.
- For Claude Code and Codex seats, the daemon env is shared across all seats. A
  generic OpenRig patch (per-member `env` merged at `node-launcher.ts:132`, about
  5 lines) would be needed for per-seat keys. That comes later.

### 5.3 Messaging: coms is optional

- OpenRig's messaging is `rig send` (paste into the pane; for Pi, the runner
  turns it into an RPC `prompt/steer/follow_up`), the queue (a row plus a nudge),
  and the chatroom (a database log).
- Coms **can** coexist for Pi-to-Pi peer chat. It needs a ~2-line fix so its
  identity falls back to `pi.getSessionName()` (with `@` replaced by `_`),
  because the runner strips `--cname` and the `PI_COMS_*` env vars.
- **Don't aim coms and OpenRig messages at the same seat at once.** Coms treats
  `agent_end` as the reply to every pending inbound message.

### 5.4 Known gaps

- **Seats can't identify themselves.** The Pi child env drops `OPENRIG_*` and
  `TMUX_PANE`, so a seat running `rig queue update` must pass `--session <name>`.
  Tell seats this in their startup prompt.
- **Delivery (#14):** `rig send` can report ok while the text is still an unsent
  draft. Use queue plus nudge.
- **Completion:** it depends on the lead closing its queue item. Fallback: run
  `testCommand` near `maxDurationMs`, then tear down.
- **Scope limits don't carry over:** roster `writes`/`tools` restrictions don't map.
  The out-of-box gates are what constrain output.

### 5.5 Money caps for mixed swarms

| Runtime | Cap mechanism | Hard? | Caveats |
|---|---|---|---|
| Pi | Per-seat OpenRouter key `limit` (in `auth.json`) | Hard (small overshoot possible) | Same mechanism as today |
| Claude Code (API) | `ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN=<seat key>` + `ANTHROPIC_API_KEY=""` | Hard | `[1m]` model slugs; no Fast mode; prompt-cache pass-through unverified; no Anthropic login in images |
| Codex | `model_providers.openrouter` in a per-seat `CODEX_HOME` | Hard | Must be user-level config; Responses API only |
| OpenCode | Built-in `openrouter` provider | Hard | Keep keys out of the shared `auth.json` |
| Claude Max / ChatGPT Pro | Wall-clock, turn caps, rate-window % only | **None in USD** | Third-party use of subscription auth depends on the authentication method and each vendor's current terms (Anthropic and OpenAI differ — verify before relying on it). Independently: no hard USD cap, so **excluded from capped runs** on cap grounds alone. |
| LiteLLM / Portkey / CF AI Gateway | Virtual-key budgets | Partly hard | Extra infrastructure, open enforcement bugs. Not needed. |

The caps are layered. The run cap (budget gate) must be at least the sum of the
seat key limits (enforced by OpenRouter). Below that sits a soft in-box watch
(OpenRig token telemetry) that only warns. As backstops, set a monthly
account-level cap in OpenRouter and turn auto-recharge off.

### 5.6 Changes needed in QDS for `rig_swarm` (~600–800 LOC plus the image)

| File | Change | Size |
|---|---|---|
| `src/phase-engine/types.ts` | Add a `rig_swarm` kind and the `rigSpec`, `objective`, `leadSeat` fields | +15 |
| `src/phase-engine/manifest.ts` | `EXECUTING_KINDS`, `superRefine`, allow `testCommand` | +30 |
| `src/phase-engine/phases/openrig-swarm.ts` (new) | Daemon, import, queue objective, poll, `finally` cleanup, trace `log` rows | ~350 |
| `src/phase-engine/phases/openrig-cost.ts` (new) | Seat session JSONL → `cost_attribution` lines (avoids `unwired` at teardown) | ~150 |
| `src/phase-engine/phases/roster-to-rigspec.ts` (new) | Roster → RigSpec translation plus AgentSpec stubs; also accept a native RigSpec | ~150 |
| `scripts/pipeline-run.ts` | A `makeBodyFactory` branch; extract the code-phase gate loop | +40 |
| `src/providers/credentials.ts`, `run-record.ts`, `teardown.ts` | Per-seat keys: `keys[]` with seat limits summing to at most the run cap, revoke all, capture spend per key | ~150 |
| `src/providers/harvest.ts` | Harvest `$OPENRIG_HOME` (the SQLite db, `state/pi/*/sessions`, transcripts) | +10 |
| `oci/exedev/Dockerfile` + `binary-licenses.json` | Node 22 (sha-pinned), tmux, `/opt/openrig` with a hashed tree | +120 |
| `src/providers/exedev/driver.ts:516` | Re-pin `DEFAULT_IMAGE_BUILD_ID`, **one** re-pin for all image changes | 1 line + the re-pin procedure |

A plain `code` phase is **not** enough for production, for three reasons:
1. `childEnv()` gives it no key, by design (`pipeline-run.ts:274`).
2. It writes no `cost_attribution` lines.
3. On abort, the daemon and tmux escape the process group.

A plain `code` phase is still fine for the spike.

---

## 6. Rejected alternatives

| Option | Why rejected |
|---|---|
| Scrap QDS and adopt OpenRig | Loses caps, isolation, reverify and the PR pipeline. OpenRig is human-supervised and driven through tmux screen-scraping. |
| Take OpenRig as a daemon-level dependency on the host | Unversioned API, 84 migrations in 6 months, bus factor 1 |
| Fork OpenRig and add factory features | `startup.ts` changed 117 times in 3 months. Estimated 0.5–1 engineer-day a week of rebasing. Node vs Bun would force porting 10–15 files. |
| Upstream PRs for budgets and ephemeral hosts | 1 external PR merged in 6 months. The maintainer re-implements outside fixes. The features conflict with his scope. |
| OpenRig's workflow engine as the macro DAG | Agent-turn steps only; no deterministic steps, fan-out or verification |
| Temporal / Restate / Hatchet as the DAG host | Correct but heavy for two people. Kept as an escape hatch (§8). |
| Our resident agent **and** the OpenRig lead both steering | Two tier-2 brains; the steering conflict can't be resolved |

---

## 7. Roadmap

| Stage | Scope | Size | Gate |
|---|---|---|---|
| **S0: spike** | One exe.dev box. A `code` phase or direct ssh runs the boot script. 2 Pi seats with per-seat capped keys and extensions pre-seeded. Objective sent through the queue. Commits harvested. Cockpit attaches via tunnel plus `rig mcp serve`. **Not merged.** | 1–2 days, about $5 cap | §9 exit criteria |
| **P0: worker hardening** | Fix the §2.5 bugs in `worker-rpc.ts`; env allowlist; `drainReason` | ~50 LOC + 5 tests | Unit tests plus one live round |
| **S1: `rig_swarm` phase** | §5.6 table; one image re-pin | 600–800 LOC | A live TIER round passes (qds-live-e2e) |
| **S2: mixed runtimes** | Coms identity fix; Claude and Codex seats via OpenRouter with per-seat keys (needs the OpenRig member `env` patch, or a per-seat `CODEX_HOME`/settings approach) | small | Live round |
| **Q1: factory service surface** | Replay-safe `fleet submit --request-id --budget-group --group-cap --json` (ack returns immediately); versioned `fleet result --json` pinned by a contract test; idempotent `fleet cancel`; cross-process quota intent record | 1–1.5 weeks | Contract tests; replay test (exactly one box) |
| **SC1: SwarmClaw engine** | Tests then fixes for bugs 0–3; scheduler change so a long step doesn't pause the run | 1 week, **2-week hard cap** | Failing tests turn green |
| **SC2: `external_job` step** | Factory adapter: persist the request id, submit, persist the runId; a daemon poller calls `fleet result`; a `factory_result` artifact; an `artifact_field_equals` condition; protocol cancel calls `fleet cancel`; `execFile` with env allowlist and absolute path | ~250 LOC | **Exit test:** a live protocol runs factory_run, branches on the verdict and notifies; kill SwarmClaw mid-submit and confirm exactly one box |
| **ADR** | Reverse DD-7 only as far as "SwarmClaw hosts macro processes via `external_job`; the fleet stays the only way code changes enter" | doc | Operator sign-off |
| Deferred | `code`/`http`/`browser` DAG nodes, auto-approve policy, `openrig_local` adapter, FleetLock replacement | — | Build when a concrete process needs it |

**Order:** S0 first, then P0. Q1 and SC1 can run in parallel with S1, and SC2 comes after all three.

---

## 8. Risks and escape hatches

| Risk | Mitigation |
|---|---|
| OpenRig churn breaks swarm mode | Pin 0.5.14 by a hashed tree in the image and upgrade deliberately. The DAG contract is independent of the mode, so pi-team mode keeps working. |
| tmux on the exeuntu base is 3.3a | S0 checks it. If needed, install tmux 3.4 from source or a PPA in the image. |
| pi 0.84.4 (image pin) is incompatible with OpenRig's RPC runner expectations | S0 checks it. Bump pi in the same re-pin. |
| Seats outlive the phase (their own sessions) | `finally` runs `rig down --force --delete; rig daemon stop; tmux kill-server`. The unit uses `KillMode=mixed`. The key cap is the hard ceiling. |
| Memory: daemon + N node runners + N pi processes | Size the box. The DF3.6b cgroup bound applies only to the resident. |
| The SwarmClaw scheduler fix doesn't fit in 2 weeks | Drop SwarmClaw as the host. Build a ~300-line sequential runner in QDS behind the same `submit/result/cancel` contract (Q1 carries over either way). |
| Tier-1 cockpit on a Max subscription in hosted operation | Existing v5 caveat F8: re-price tier 1 at API rates before selling a hosted tier. |

---

## 9. Spike S0: plan and exit criteria

**Goal:** answer the unknowns that only a real box can answer. Nothing is merged.

**Setup:** one exe.dev box (current image), created and torn down through the
existing driver or the `using-exe-dev` skill, plus one OpenRouter key capped at
about $5 total (or two seat keys at about $2 each). Run under the `qds-live-e2e`
skill rules.

**Steps:**
1. Record the base OS, `tmux -V`, `node -v` and `pi --version` on the stock image.
2. Install Node 22, tmux (at least 3.4 if the base is older), `@openrig/cli@0.5.14`,
   and pi at the image's version. Record the times.
3. Clone a tiny test repo to `/work/repo` and copy the self-compact extension to `/opt/qds/pi-ext`.
4. Create the rig with 2 Pi seats (`lead`, `worker`) using a cheap OpenRouter
   model, pre-seeding each seat's `auth.json` (its own key) and `settings.json`
   (extensions).
5. Run `rig daemon start --no-kernel`, then `POST /api/rigs/import`, and wait
   until both seats are ready. Record the time each seat takes to become ready
   (against the 15 s limit).
6. Send the objective to the lead through `/api/queue/create` (for example: "add a
   `hello()` function plus a test, delegate the test to worker, commit on branch
   `sbx/spike`"). Watch `/api/events`.
7. **Cockpit check:** `ssh -L 17433:127.0.0.1:7433`, then `rig mcp serve --port 17433`
   locally. Call `rig_ps` and `rig_capture`, and send one message to the lead.
8. Check that commits exist on `sbx/spike`, the seat session JSONL contains
   `usage.cost`, and the key's spend is visible through the OpenRouter key API.
9. Tear down: `rig down --force --delete`, `rig daemon stop`, destroy the box,
   **revoke the keys**, and record the final spend.

**Exit criteria (all must pass):**

| # | Criterion |
|---|---|
| E1 | The daemon plus 2 Pi seats boot with zero interactive prompts |
| E2 | Each seat uses its **own** key, confirmed by per-key usage on OpenRouter |
| E3 | The self-compact extension loads in each seat (visible in the session log or the tool list) |
| E4 | The lead received the objective through the queue, and the worker was involved |
| E5 | Commits landed on the branch in `/work/repo` and are harvestable |
| E6 | The cockpit sees and messages the swarm through the tunnel plus the MCP |
| E7 | Teardown leaves no box and no live keys; spend is at or under the cap |
| E8 | Recorded: tmux version, boot times, seat ready time, pi compatibility, memory high-water mark |

If E1–E7 pass, go to S1. If any fail, record why and change the plan (for
example, tmux from source, a pi bump, or a longer launch timeout via patch).

---

## 9a. Spike S0 results (2026-09-23): **all 8 exit criteria passed**

Evidence: `_bmad-output/evidence/openrig-s0/2026-09-23-spike-s0.json`. Harness (not merged): `spikes/openrig-s0/`.
**Total spend $0.41**: lead $0.129, worker $0.284, against a cap of 2 × $0.50.
Box destroyed and keys revoked (confirmed 404).

| # | Result |
|---|---|
| E1 | **PASS.** The pinned image is Ubuntu 24.04.5 with **tmux 3.4 already installed** (so #12 doesn't apply). Node 22 installed in 20 s and OpenRig in 9 s; better-sqlite3 came **prebuilt**. The daemon was healthy in 2.7 s on `127.0.0.1` only. Import plus launch of 2 Pi seats took 3 s. Zero prompts. |
| E2 | **PASS.** Each seat's `auth.json` key was used separately, confirmed by distinct per-key usage on OpenRouter. **Cost attribution remains unverified for S1:** the spike did not harvest the seats' session JSONLs, so the `usage.cost` records that `openrig-cost.ts` (§5.6) will read were never checked; OpenRouter per-key `finalUsageUsd` is a proxy only. |
| E3 | **PASS.** Self-compact loads from the seat's `settings.json`: pi RPC `get_commands` lists `self-compact-info` and `self-compact-now`, and the context bar status is emitted. pi 0.84.4 supports every runner flag, so no pi bump is needed. |
| E4 | **PASS.** The objective went through `/api/queue/create` with a nudge. The lead wrote `hello.js`, `rig send`-ed the test task to the worker, the worker wrote `hello.test.js` and replied, and the lead ran `node --test`, committed, and closed its item `done/no-follow-on`. |
| E5 | **PASS.** A git bundle of `sbx/spike` cloned on the host with `d1ac153 spike: hello + test`. Tests: 1 pass, 0 fail. |
| E6 | **PASS.** Tunnel `ssh -L 17433:127.0.0.1:7433` plus `npx -y -p @openrig/cli@0.5.14 rig mcp serve --port 17433`: `tools/list` (18 tools), `rig_ps`, a `rig_send` steer to the lead, and `rig_capture` read back `COCKPIT-ACK d1ac153`. |
| E7 | **PASS.** `rig down --delete`, daemon stopped, box deleted (`ls` empty), keys revoked. |
| E8 | **PASS.** Memory used with the rig up: about 530 MB (the daemon, 2 pi processes, 2 runner node processes) on an 8 GB box. |

**Findings that change S1:**
1. **A swarm has no natural stop.** After the task, the worker kept polling
   (`git status`, `rig queue list`, `rig capture`). **More than half of the
   worker's spend was idle after completion.** `rig_swarm` must tear down the
   moment the lead closes its item. The per-seat caps held regardless.
2. **Orientation overhead.** OpenRig sends every seat a startup identity prompt
   ("run `rig whoami`"). Seats spend tokens exploring before the task arrives.
   S1 should either send the objective immediately or override the startup
   content through the AgentSpec.
3. **Identity gap confirmed.** `rig whoami` fails in Pi seats. The lead
   recovered on its own with `export OPENRIG_SESSION_NAME=dev-lead@spike`, which
   works. S1 should put this in each seat's startup prompt. Without it, the
   worker's messages show `From: <unknown sender>`.
4. **Cockpit messages sent through MCP carry no sender**, so replies can't route
   back. Read them with `rig_capture`, or have the cockpit send through the queue
   with a `sourceSession`.
5. **The image must bake self-compact.** The current pin predates it; the spike
   copied it in. Include it in the single S1 re-pin, together with Node 22 and
   `/opt/openrig`.
6. `npx` needs the explicit bin: `npx -y -p @openrig/cli@0.5.14 rig mcp serve`.

**Verdict:** go to S1. No blockers were found. The plan in §5.6 stands, with
findings 1–5 added to the `rig_swarm` phase body.

---

## 10. Sources

- OpenRig: `/tmp/openrig` at `c8fca9d5`, with paths cited inline. Also
  esoteric.run/blog/why-i-built-openrig, openrig.dev/specs, and GitHub issues
  #9, #12, #14, #17 and PRs #4, #15, #19.
- QDS: `src/fleet/{dispatch,verbs,brief-schema,fleet-lock,run,run-completion,status,fanout-primitive}.ts`,
  `src/providers/{budget-gate,cost-ledger,credentials,run-record,harvest,teardown,quota}.ts`,
  `src/phase-engine/{manifest,phase,types}.ts`, `scripts/pipeline-run.ts`,
  `oci/exedev/Dockerfile`, and the v5 spec plus DD-7
  (`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md:53`).
- SwarmClaw: `src/lib/server/protocols/*`, `src/types/protocol.ts`, `src/lib/server/dag-validation.ts`.
- Caps: openrouter.ai/docs (Claude Code integration, Codex cookbook, limits,
  key provisioning), docs.litellm.ai, portkey.ai docs, Cloudflare AI Gateway
  spend limits, Anthropic ToS reporting (The Register, 2026-02-20), and
  developers.openai.com/codex/auth/ci-cd-auth.
