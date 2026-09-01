# R2 — Normative Specification Research: DF1.10 "in-box steering executor + channel lifecycle"

Research Agent 2 (Specification Research), 2026-08-31, branch `dev`, read-only.
Charter sources: GitHub **#181** (HIGH seam) + **#180** (MED channel lifecycle), both filed at PR #150 round-10 close-out.

## 0. Sources read

| Source | Path / ref | What it gave |
|---|---|---|
| Issue #181 | `gh issue view 181` | The seam: verb writes box `/run/steering/inbox.ndjson`, engine drains a host-local file; closing shape; DF1.10 named owner |
| Issue #180 | `gh issue view 180` | Channel provisioned once at box birth on tmpfs `/run`; reboot wipes it; suggested re-provision + telemetry shape |
| DF3.4 story | `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md` | Envelope schema (:236), transport (:234-253), AC6 (:159-171), INV-APPROVE-1..9 (:295-340), Deviation 4 (:389), Deviation 5 (:390), Deviation 10 (:632), Deviation 12 (:774), round-10 findings (:815-883), sprint-level in-box issue (:444-453), deferred seams (:780-784), ledger ceiling (:437-442) |
| Design doc | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` | D4 + F7 tripwires (§4), §5.1 tier map, §5.2 F12 resident bounds, §6.6/R9 in-box evidence = claims |
| DF3.3 story | `stories/df3-3-resident-orchestrator-agent.md` | Three solicitation points (:150-155), INV-RES-1..5 (:223-245), three-way `steering.ts` ownership (:135-142) |
| DF3.6 story | `stories/df3-6-resident-agent-bounds.md` | The three bounds (:140-143), Trigger table out-of-scope rows (:115-123) |
| Integration specs | `_bmad-output/workflow-state/qds-dev/df3-4/integration-spec.md` (:43-54), `.../df3-1/integration-spec.md` (:491) | `SteeringPoint` closed 3-union at `steering.ts:38`; DF3.6 seam marked `steering.ts:339`; `DIRECTIVE_TEXT_CHAR_CEILING=4000` at `steering.ts:33` |
| Shipped code | `src/fleet/attach.ts`, `src/phase-engine/steering.ts`, `src/providers/exedev/driver.ts:58-142,303-315`, `scripts/pipeline-run.ts:76-135,1697-1734`, `src/fleet/resident.ts:440-470`, `scripts/pipeline-run-remote.ts:1-40` | Actual substrate (below) |
| Live e2e | `tests/fleet/e2e/tier1-attach-transport.live.test.ts`, `tier5-gate-steering.live.test.ts:378-396` | Today's honest PASS shape = exit 6 / `no-ack` |
| Sprint status | `_bmad-output/sprint-artifacts/sprint-status.yaml` :135-146 | DF3.3/DF3.4/DF3.6 ownership + the DF3.6 boundary |

## 1. The shipped substrate (facts the spec must be written against)

- **Two filesystems, no mount.** `fleet attach` appends the message **inside the box** via
  `driver.exec(vm, ["sh","-c",APPEND_SCRIPT], payload+"\n" on stdin)` (`src/fleet/attach.ts:495`);
  the engine's steering leg drains a **HOST**-local inbox — `scripts/pipeline-run.ts:88` imports
  `localSteeringInbox` from `src/fleet/attach.ts`, wired at `pipeline-run.ts:1709-1717`. `attach-acked`
  is therefore reachable only against a fake driver. **[#181], [df3-4 Deviation 12 :774]**
- **Transport is `exec`, both legs — never `copyFile`.** `driver.copyFile` refuses absolute paths on
  both drivers (`assertBoxPathSafe`, `src/providers/exedev/driver.ts:604-614`); the repo's adopted
  fix (dated live measurement `fan-20260826-f04c3c`, `fanout-primitive.ts:688-696`) is `exec` + `cat`.
  Ack read-back is `ACK_READ_SCRIPT` via `driver.exec` (`attach.ts:291,375`). **[df3-4 Deviation 4 :389]**
- **Channel provisioned once at box birth.** `create()` runs the steering provisioning script:
  `sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root"` with
  `root="${QDS_STEERING_ROOT:-/run/steering}"` (`src/providers/exedev/driver.ts:58-142`, emitted at
  `:303-315`, failure typed `steering-channel-unprovisionable`). `/run` is tmpfs — a reboot silently
  wipes the channel and the box regresses to `send-failed` for life. **[#180]**
- **Engine-side steering port.** `src/phase-engine/steering.ts` owns `drainInbox(point, ctx)`
  (`:627`), durable dedupe via `deps.inbox.ackedIds()` (`:671-673`), the `ownRunId` cross-run filter
  (always-on after round-10 S1), and the `ack-provenance` count (acks written before any prompt
  reached the resident) — whose **CLI consumption is recorded as a DF1.10 follow-up**
  [df3-4 :741, :784].
- **Mutual exclusion today is host-side only.** Acks serialize under `join(steeringRoot(),
  "acks.lock")` (`attach.ts:638`) — a **host** file. There is no box-side lock; if DF1.10 puts a
  writer on the box, that lock guards nothing there.
- **The resident is NOT in-box.** `src/fleet/resident.ts:448` is a host-side `Bun.spawn` of a local
  `--provider openrouter --mode json --no-tools` binary. `pipeline-run-remote.ts:5-19` states the box
  image carries **no bun/node**, so `pipeline-run.ts` cannot run in-box; HONEST LABEL: "this is NOT
  the in-box executor (proposed story DF1.10)". **[df3-4 :444-453]**
- **Constants that are now contract** (all in `src/fleet/attach.ts`): `ATTACH_ACK_CEILING_MS`
  30_000, `ATTACH_POLL_INTERVAL_MS` 500, `ATTACH_PER_CALL_TIMEOUT_MS` 10_000,
  `ATTACH_MIN_TICK_MS` 10, `ACK_UNUSABLE_TICKS_LIMIT` 3, `INBOX_READ_CAP_BYTES` 1 MiB (windowed
  tail, short-read-safe), `ACKS_READ_CAP_BYTES` 512 KiB, `DIRECTIVE_TEXT_CHAR_CEILING` 4_000
  (`steering.ts:33`).
- **Today's honest live PASS shape** is `attach-not-acked` / reason `no-ack` / **exit 6**, with the
  inbox line asserted verbatim in-box (`tier1-attach-transport.live.test.ts:31-36,149-176`;
  `tier5-gate-steering.live.test.ts:378-396`). DF1.10 **flips** this shape.

---

## 2. Normative contract for DF1.10

Each clause cites its authority. MUST = binding; SHOULD = strong default the writer must justify
breaking; MUST NOT = hard prohibition.

### 2.1 Channel + transport

- **C1 (MUST)** — After DF1.10, both steering legs operate on the **box's**
  `/run/steering/{inbox,acks}.ndjson`; no host-local inbox file is consulted by any production
  path. *[#181; df3-4 Deviation 12 :774]*
- **C2 (MUST)** — All box I/O rides DF2.1's `driver.exec`: payload on **stdin** only, read-back as
  `sh -c cat`. **MUST NOT** use `driver.copyFile` (refuses absolute paths on both drivers) and
  **MUST NOT** introduce `ssh`, an HTTP port, or any second channel. *[df3-4 :237-243, Deviation 4
  :389; design D8]*
- **C3 (MUST)** — Message envelope stays exactly `{ messageId, requestId, runId, message, sentAt }`,
  one NDJSON line, trailing-newline-guarded. *[df3-4 :236; round-6 trailing-newline patch :571]*
- **C4 (MUST)** — `message.text` (and every envelope field) travels only via `stdin`, never
  interpolated into `argv`; `cat` writes verbatim and parses nothing. *[df3-4 :239-242; AC6 :161-171]*
- **C5 (MUST)** — Both files are mode `0600`, owned by the in-box exec user, and carry **no
  credential material**; a pre-existing lax file is re-chmodded after every append (both legs).
  *[df3-4 :251-252; round-7 acks-mode patch :660]*
- **C6 (MUST)** — `QDS_STEERING_ROOT` is resolved **by the box at exec time**, and host-side and
  box-side resolution may never diverge: one root, one source of truth. *[round-6 patch :572;
  `attach.ts:54-66`]*
- **C7 (MUST)** — `ATTACH_ACK_CEILING_MS` 30_000 without an observed ack returns
  `attach-not-acked` — a reported outcome, never a silent success, never an automatic re-send.
  *[df3-4 :249-251]*
- **C8 (MUST)** — Read caps are preserved or tightened, never raised silently: inbox tail window
  ≤1 MiB, acks window ≤512 KiB, short-read-safe decoding, and the shared-exec cap coupling
  documented. *[round-7 :661; round-8 :732; round-8 providers :747]*
- **C9 (MUST)** — Ack-read classification is preserved: `ACK_READ_SCRIPT` exits 3 on a missing
  inbox; any non-zero exit maps to `unreachable`; **only a clean empty read** earns the "message IS
  queued" claim. *[round-10 AT1s :840]*
- **C10 (MUST)** — Attach refusals are preserved: `run-not-attachable` for `pausing` /
  `awaiting-approval` / closed runs, extension unmutated, plus the `closedAt`/settled-state guard.
  Deviation 10's fast-refusal posture (attach takes no gate lock) is **inherited, not silently
  upgraded** — changing the locking topology is an explicit spec decision. *[df3-4 AC5 :156-158;
  Deviation 10 :626-632; round-6 :569]*

### 2.2 In-box consumption + ack write-back (the new executor)

- **C11 (MUST)** — A message is consumed at **exactly** DF3.3's three solicitation points
  (`run_start` | `post_gate_failure` | `run_end`, `steering.ts:38`); **no fourth point is added**,
  by DF1.10 or by any mechanism it ships. *[df3-3 :150-155; df3-4 :252-253; INV-APPROVE-5; INV-RES-1]*
- **C12 (MUST)** — Ack shape stays `{ messageId, ackedAt, point }`, where `point` is the
  **fold-time** solicitation point, never a later retry's. *[df3-4 :244-249; round-7 ack-point
  patch :666]*
- **C13 (MUST)** — `messageId` remains the dedupe key and delivery is exactly-once per id;
  re-issuing the same `messageId` delivers once across processes and restarts. *[df3-4 :250-251;
  round-10 S2 :851]*
- **C14 (MUST)** — Durable dedupe is preserved: dedupe state seeds from the acks log
  (`ackedIds()`), so a restart **neither re-folds nor re-acks** a delivered message. *[round-10
  S2 :851; `steering.ts:162-180,671-673`]*
- **C15 (MUST)** — The `ownRunId` cross-run filter can never be off: inbox lines carrying another
  run's `runId` are neither folded nor acked; the dropped count is surfaced, the content never is.
  *[round-10 S1 :850; `pipeline-run.ts:128-135`]*
- **C16 (MUST)** — Mutual exclusion on **both** appends wherever the writers live: the existing
  `acks.lock` serialization is inherited, and if DF1.10 adds a box-side writer, box-side appends are
  serialized box-side (interleaved appends glue JSON lines and lose both). *[round-10 AT3s :842]*
- **C17 (MUST)** — The fold remains guidance text only: it can never approve, reject, skip or
  reorder a gate, and never raises a spend ceiling or steering-iteration bound. Approval travels
  tier-1 → host-side gate only, never through the resident. *[INV-APPROVE-5 :313-317; design R9]*
- **C18 (MUST — R9 doctrine)** — The executor's output is **claims, not proof**. An ack proves the
  message was *consumed*, never that guidance was *applied*, never that a gate was satisfied, never
  that a PR is authorized. DF1.10's spec must state what the host still verifies (unchanged):
  DF5.1's host-side out-of-box re-verify owns truth; nothing in the host may treat an
  `attach-acked`, an acks.ndjson line, or any executor emission as verification. *[design §6.6 + R9
  :395-398, :488; INV-RES-4; df3-4 :15 fact 15]*
- **C19 (MUST)** — The engine-side `ack-provenance` count is surfaced on a host CLI surface
  (status or attach envelope) — it is a cross-process fact the attach CLI cannot see today, and it
  was explicitly recorded as this story's follow-up. *[df3-4 :741, :784]*
- **C20 (SHOULD)** — Inherited ceiling, restated honestly: an attach queued during an agent-phase
  retry waits until `run_end` (point 2 is code-phase-only). Closing it needs a fourth solicitation
  point, which three stories forbid. DF1.10 does **not** close it. *[df3-4 :434-437; DF3.3 round-5
  defer :444]*
- **C21 (MUST)** — Observability: `attach` gate event with `attach_rtt_ms` is preserved and
  extended with the re-provision and in-box-consumption outcomes; `requestId` propagates on every
  line. *[df3-4 Observability Contract :269-273]*

### 2.3 Channel lifecycle (re-provision) — issue #180

- **C22 (MUST)** — On the first failed steering send per box attributable to a missing/unwritable
  channel, DF1.10 re-runs the **idempotent** provisioning chain (`install -d` + the existing verify
  chain: `test -w`, `stat` mode/owner) **before** reporting the fault. *[#180; `driver.ts:76-99`]*
- **C23 (MUST)** — Re-provisions are **counted in telemetry** (a counted event per box, visible on
  the attach envelope and/or `fleet status`) so a reboot loop is observable. *[#180]*
- **C24 (MUST)** — Re-provisioning is **in-place on the same box**. **MUST NOT** create a second
  box for a `runId`, and **MUST NOT** widen the cost-ledger key: `boxHoursEventId` keys on
  `(runId, closedAt)` with `closedAt` frozen by first-close-wins; a re-create story would have to
  widen it and DF1.10 must not. *[df3-4 :437-442]*
- **C25 (SHOULD)** — The re-provision seam must not widen the CRITICAL-blast-radius
  `ExeDevDriver.exec` surface (27 symbols across fill/setup/gate/dispatch/fanout — the reason
  round-8 deferred the `steeringSend` seam). Prefer a steering-scoped ensure() in the
  steering/attach module over a driver-wide change. *[#180 "why not patched"; df3-4 :782-783]*
- **C26 (MUST)** — Provisioning failure stays typed and truthful (`steering-channel-unprovisionable`
  with per-exit-code wording incl. 137/255) — DF1.10 adds no new unclassified failure arm.
  *[round-10 P2 :858; `driver.ts:120-142`]*
- **C27 (SHOULD)** — A wipe must also be survivable from the **drain** side, not only attach: an
  engine leg whose channel vanished mid-run degrades fail-closed (skip drain, surface the fault,
  never fold garbage) and re-provisions on the next pass. *(under-specified in #180 — see §5.7)*

### 2.4 Adjacent ownership, restated

- **C28 (MUST NOT)** — DF1.10 does not absorb DF3.6's bounds (`maxSteeringIterations` 8/phase,
  `residentRssBytes` 512 MiB, `residentSpendCeilingMicros` 2e6) and does not re-derive any char
  ceiling: the 4_000 attach cap is DF3.3's `DIRECTIVE_TEXT_CHAR_CEILING`, **not** a DF3.6 bound
  (DF3.6 owns exactly three bounds, none a char cap). *[df3-6 :140-143; df3-4 Deviation 6 :391]*
- **C29 (MUST NOT)** — No edit to a DF3.3-owned line of `src/phase-engine/steering.ts` and no
  fourth solicitation call site; DF1.10 is a successor that adds only, after DF3.4's drain/ack and
  DF3.6's `checkBounds` wrap. *[df3-3 :135-142; df3-4 Files-to-Modify :283-287]*
- **C30 (MUST NOT)** — No approval-gate mechanics change: DF1.10 changes no line of
  `approval-gate.ts` / `approvers.ts`; the gate and the steering channel "share no state". *[df3-4
  :206-209]*

---

## 3. Inherited invariants inventory (respect or extend — never contradict)

### INV-APPROVE-* (DF3.4, `df3-4 :295-340`)
| ID | One line |
|---|---|
| INV-APPROVE-1 | No bypass, no auto-resume: a paused run resumes only via a valid approve decision. |
| INV-APPROVE-2 | Authorization = hashed allowlist `.factory/approvers.json`; unknown id/unauthorized = no state change, security event. |
| INV-APPROVE-3 | Fail-closed authorization: absent/unparseable/wider-than-0600 allowlist refuses **every** decision. |
| INV-APPROVE-4 | Attribution append-only: every decision logged with approverId/timestamp/reason/runId/requestId; `system:timeout` reserved. |
| INV-APPROVE-5 | **Steering carries no privilege** — guidance text only; no gate moved, no bound raised; three solicitation points only. |
| INV-APPROVE-6 | Credential containment at pause: a decidable run never coexists with a live key or box. |
| INV-APPROVE-7 | assertNoSecret parity: the approval extension never carries key material. |
| INV-APPROVE-8 | Fail-closed reads: malformed extensions are typed errors, never defaulted. |
| INV-APPROVE-9 | `fs.writeSync` on CLI exit paths so stderr flushes before `process.exit`. |

### INV-RES-* (DF3.3, `df3-3 :223-245`)
| ID | One line |
|---|---|
| INV-RES-1 | No gate authority — structural: the resident's only egress into the engine is one validated directive from an engine-initiated call (a tool surface / MCP server / writable control file violates it). |
| INV-RES-2 | Validation strictly precedes effect: `.strict()` schema before any engine state; unknown = rejection. |
| INV-RES-3 | Credential containment: exactly one per-run capped key; the brief carries no credential-shaped value. *(letter says "runs inside the box" — contradicted by shipped code, see §5.1)* |
| INV-RES-4 | In-box output is a claim, not proof (F10/R9) — never satisfies a gate, never authorizes a PR. |
| INV-RES-5 | Fail-closed toward determinism: every degradation is *less* agent influence. |

### DF3.6 bounds (engine-enforced, `df3-6 :140-143`)
`maxSteeringIterations` 8/phase · `residentRssBytes` 512 MiB · `residentSpendCeilingMicros`
2,000,000 absolute, with the default ordering `2e6 < 5e6 (budget cap, DD-9) ≤ 5e7 (key cap, DF2.3)`.
Immutable mid-run; `checkBounds(point)` already wraps the three call sites (`steering.ts:339`).

### Standing review artifacts now behaving as invariants (round-10, `df3-4 :839-860`)
AT1s (exit-3 ack classification), AT2s (zero-ceiling = one look), AT3s (acks.lock + `"a+"` fd),
AT8s (ack ENOENT = no-op), S1 (ownRunId always on), S2 (durable dedupe), S4 (over-ceiling folds
truncated + acked; fault only under a 256-char floor), P2 (provisioning exit-code truthfulness),
R3 (hollow-bundle refusal). Also Deviation 4 (exec-not-copyFile), Deviation 5 (ack at drain time),
Deviation 10 (attach fast refusal), Deviation 12 (the seam this story closes).

---

## 4. AC seed list

1. **(make-or-break — in-box consumption, TIER-2 live)** Given a real box with the engine in a live
   phase, When `fleet attach` issues a message, Then the line lands in the box's
   `/run/steering/inbox.ndjson` **and** is consumed on-box within the 30 s ceiling, and the host
   returns `attach-acked` carrying the run's `requestId`. *Negative control: an implementation that
   keeps a host-local inbox as the source of truth passes the old fake-driver test and MUST fail
   this.* [#181; df3-4 AC6 :159-171]
2. **(ack write-back)** The ack appears as `{messageId, ackedAt, point}` in the box's
   `/run/steering/acks.ndjson`, mode `0600`, observed by the host **only** through
   `driver.exec`+`cat`; `attach-acked` is returned solely on that observation, and the ack's `point`
   is the fold-time solicitation point. [df3-4 :244-249; C12]
3. **(engine leg through the transport)** After DF1.10, the production drain leg reads the box
   inbox through `driver.exec` and creates **no host-local steering file**; a test asserts the host
   path is never written. [C1, C2]
4. **(cross-run filter preserved)** A foreign-`runId` line in the box inbox is neither folded nor
   acked; the dropped count is surfaced, its content never printed. [round-10 S1 :850]
5. **(exactly-once across restarts)** Re-issuing the same `messageId` delivers once; an engine or
   consumer restart neither re-folds nor re-acks a settled id (durable dedupe seeded from the acks
   log). [round-10 S2 :851; C13/C14]
6. **(channel re-provision — #180)** Given the box's `/run/steering` wiped out from under it
   (reboot simulation: `rm -rf` / unmount-remount equivalent), When the next steering send fires,
   Then the idempotent provisioning chain re-runs and the message is delivered — not
   `send-failed` for life. [#180]
7. **(re-provision telemetry)** Every re-provision increments a per-box counter visible on the
   attach envelope / `fleet status`, so three re-provisions in an hour read as a reboot loop, not
   as silence. [#180]
8. **(mutual exclusion on both files)** Concurrent attaches against concurrent drain passes never
   interleave or glue NDJSON lines on either file (burst test, box-side writers included).
   [round-10 AT3s :842]
9. **(live TIER-1→2 e2e closes the loop)** On real infrastructure: dispatch → engine → attach
   mid-phase → fold into the next solicitation's prompt context → ack observed → exit 0
   `attach-acked` with `requestId`; the tier1-attach-transport and tier5-gate-steering "honest
   no-ack" PASS shapes are **re-pointed** to this. Zero-fakes per the `qds-live-e2e` skill; no
   fake-driver assertion may be sole evidence. [tier5 :378-396; df3-4 AC6 negative control :169-171]
10. **(R9 evidence discipline)** No host code path treats an ack, an executor emission, or
    `attach-acked` as verification, gate evidence, or PR authorization; the `ack-provenance` count
    (acks written before any prompt reached the resident) is surfaced on a host CLI. [design §6.6/R9;
    df3-4 :741, :784]

---

## 5. Non-goals, boundaries, and contradictions

### 5.1 Non-goals / boundary clauses

- **DF3.6 bounds** (iterations/RSS/spend ceiling) stay DF3.6's, engine-enforced, immutable mid-run;
  DF1.10 neither re-implements nor raises them. The "operator raising a bound mid-run via attach"
  row is DF3.6's explicit out-of-scope → DF3.4, and it is REFUSED there by INV-APPROVE-5 — DF1.10
  must not open it. *[sprint-status.yaml:146; df3-6 :122-123; INV-APPROVE-5]*
- **Approval gate** — `requestApproval`/`submitDecision`/allowlist/timeout are DF3.4's, shipped;
  the gate and the steering channel share no state. *[df3-4 :206-209]*
- **The phase engine does not move in-box.** `pipeline-run-remote.ts`'s honest label names DF1.10
  as the "in-box executor", but closing the steering round trip does not move the engine; the box
  image has no bun/node and DF2.x's image contract is not this story's to change. *(see
  contradiction §5.3)*
- **No fourth solicitation point**; no agent-initiated channel into the engine (INV-RES-1); no
  exposed network port on the box; no second steering transport.
- **No cost-ledger key widening / no box re-creation** (C24). *[df3-4 :437-442]*
- **Fleet-wide bound policy push** (→ DF3.1), **resident spend → cost ledger** (→ DF2.8),
  **bound-breach events on the audit chain** (→ DF5.3), **real teardown wiring into the reverify
  caller** (→ DF5.1-adjacent). *[df3-6 :115-123; df3-4 :782]*
- **Attach-latency-during-agent-phase-retry ceiling** is inherited, not closed (C20).

### 5.2 Contradiction 1 — WHO the in-box consumer is (top issue; writer must resolve)

Three authoritative sources disagree about where the resident runs:
- **#181** says the closing shape is "the **resident** consumes `/run/steering/inbox.ndjson`
  **on-box** and writes `/run/steering/acks.ndjson`".
- **DF3.3's INV-RES-3** (`df3-3 :232`) reads "the resident **runs inside the box** against the
  single per-run key".
- **Shipped code**: the resident is a **host-side** `Bun.spawn` of a local binary
  (`src/fleet/resident.ts:448`), and DF3.4's sprint-level issue states plainly: "Engine, resident
  (`resident.ts:446-471`, `Bun.spawn`) and records are all host-side today" *[df3-4 :444-453]*,
  while the design doc (§5.1, D4) puts tier-2 in the sandbox.

So the literal #181 shape is unbuildable as written: there is no on-box resident to consume
anything. Two resolutions, both spec-worthy:
  - **(a) narrow** — the host engine keeps the fold (prompt context is rendered host-side) and the
    round trip closes by pointing **both legs through the transport**. No new process, no daemon,
    no image change; "in-box" describes the *channel*, not a process. `attach-acked` = host observed
    the box ack. Cheapest closure of #181; leaves `pipeline-run-remote.ts`'s "in-box executor"
    label overclaiming.
  - **(b) wide** — a real on-box consumer process drains + acks box-side (the box has `python3` —
    proven by DF2.1's fill traversal fix moving to `os.open` — and **no** bun/node). Changes ack
    semantics (consumption-time, not fold-time), needs box-side locking, and a lifecycle story.
The spec must pick one and restate what an ack proves (C18) accordingly.

### 5.3 Contradiction 2 — the "in-box executor" name

`pipeline-run-remote.ts:16-18` records DF1.10 as the **in-box engine executor** ("this is NOT the
in-box executor (proposed story DF1.10)"). #181 scopes DF1.10 to the **steering** round trip only.
If DF1.10 ships (a), that comment's forward reference becomes false and must be re-pointed, or the
story title should drop "executor". Writer must decide; leaving both texts as-is guarantees a
future auditor flags the drift.

### 5.4 Under-specification 3 — executor process lifecycle is unspecced

No supervisor exists in-box; `/run` is tmpfs, so any consumer state, pid file or lock placed there
dies with the channel on a reboot. Open questions the spec must answer: daemon vs per-solicitation
short-lived process; who restarts it after a wipe; what happens to in-flight messages. **Note for
the writer:** a per-solicitation consumer invoked through `driver.exec` avoids the daemon question
entirely, reuses the idempotent provisioning chain, and needs no supervisor — the lazy shape.

### 5.5 Under-specification 4 — lock topology if writers move box-side

`acks.lock` is a **host** file (`attach.ts:638`); the round-10 AT3s mutual exclusion covers
host-side appends only. Any box-side writer needs box-side serialization (`flock`/O_EXCL on the
box), which no shipped finding covers. Flag as a MUST clause (C16) with the mechanism left to the
writer.

### 5.6 Contradiction 5 — task/story letter vs shipped transport

The planning brief (and DF3.4's Infra Prerequisites table, `:201`, and AC6 `:165`) name
`driver.copyFile` for the ack read-back. **Deviation 4** (`:389`) records that `copyFile` refuses
absolute paths on both drivers and that **both legs are `exec`** (`APPEND_SCRIPT` stdin append;
`ACK_READ_SCRIPT` `cat` read). The spec must not re-introduce `copyFile`, and should correct the
Infra Prerequisites wording it inherits.

### 5.7 Under-specification 6 — which failures trigger re-provision, and from which side

#180 says "on first `send-failed` per box". But a wipe also surfaces as `box-unreachable` /
`acks-unreadable` (the exit-3 arm), and it blinds the **drain** leg, not just attach. Unspecified:
(a) the full trigger set, (b) whether the engine leg self-heals too (C27), (c) the re-provision
budget/rate limit so a wedged substrate cannot spin provisioning execs. Also see C25's blast-radius
constraint — the seam choice is a real design decision, not a patch site.

### 5.8 Gap 7 — DF1.10 is not in sprint-status.yaml

`sprint-status.yaml` has no DF1.10 line; the df1 band totals "DF1 8/32" (`:33`) and the df3 band
(:135-146) records DF3.3/DF3.4/DF3.6 as done/in-review/ready-for-dev with their dependency edges.
Planning must add the DF1.10 row (points, deps — at minimum DF2.1, DF2.2, DF3.3, DF3.4, and DF3.6
if the `checkBounds` wrap must already be in place), and #180/#181 should be referenced in it.

### 5.9 Carried obligation 8 — ack-provenance CLI consumption

Recorded twice as this story's follow-up (`df3-4 :741`, `:784`): the engine-side `ack-provenance`
count needs DF1.10's executor contract to surface on the CLI. AC 10 picks it up; the writer must
either keep it or re-defer it explicitly.

### 5.10 Smaller notes for the writer

- The attach char ceiling is **DF3.3's** `DIRECTIVE_TEXT_CHAR_CEILING` (4_000), misattributed to
  DF3.6 once already (Deviation 6) — do not repeat.
- `post_gate_failure` is code-phase-only; the retry-waits-until-`run_end` ceiling is inherited
  (C20) and three stories forbid the fix.
- Any new file the executor writes must respect the fail-closed read discipline (INV-APPROVE-8
  analogue) and the secret-scan posture (nothing credential-shaped ever reaches `/run/steering`).
