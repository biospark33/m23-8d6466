# R3 — Code Surface Map for DF1.10 (in-box steering executor + channel lifecycle)

Repo: /Users/steve/QDS-Factory @ `dev`. Method: direct Read/Grep (GitNexus MCP assumed stale per DF3.4).
Scope: #181 (in-box consumer + ack write-back + engine leg through the transport) and #180 (channel provisioned once at birth + idempotent re-provision + telemetry).

---

## 0. The one architectural fact that decides the story

The steering channel has TWO legs implemented today, and they run on DIFFERENT machines:

- **Host leg** — `attachToRun` (`src/fleet/attach.ts:430-580`) talks to the box over `driver.exec`, payload on stdin, ack read by `sh -c cat/tail` (`attach.ts:228-236` APPEND_SCRIPT, `attach.ts:291-295` ACK_READ_SCRIPT). Paths are resolved BY THE BOX (`BOX_STEERING_ROOT_SH`, `attach.ts:80`).
- **"Engine leg"** — `localSteeringInbox` (`attach.ts:658-764`) is plain `node:fs` on `/run/steering` **as a local path**. It is injected into `createSteering` only by `scripts/pipeline-run.ts:1816-1836`, which runs ON THE HOST. `pipeline-run.ts:1789-1793` states this explicitly: "the engine addresses the in-box steering paths as local paths … this runner has no vm."

So today `fleet attach` writes the **box's** `/run/steering/inbox.ndjson` while the only consumer reads the **host's** `/run/steering`. They never meet. That is the documented "HONEST NO-ACK" (`tests/fleet/e2e/tier1-attach-transport.live.test.ts:31-39`, `tier5-gate-steering.live.test.ts:18-28`, `scripts/pipeline-run-remote.ts:18-19`): production acks nothing live. DF1.10 must either (a) run an executor in the box (the box has **no bun/node** — `pipeline-run-remote.ts:6-7`) or (b) implement `SteeringInbox` over `driver.exec` on the host. Both halves of the seam exist as types already (`SteeringInbox`, `src/phase-engine/steering.ts:157-181`); neither has a transport-backed implementation.

---

## 1. SEAM TABLE

| # | file:line | Current behavior | What DF1.10 changes/adds |
|---|-----------|------------------|--------------------------|
| S1 | `src/fleet/attach.ts:54-63` `steeringRoot()` | Host-resolved root, `QDS_STEERING_ROOT \|\| "/run/steering"` (`\|\|` not `??` — empty must fall through). Docblock 39-53: **LOCAL CALLERS ONLY**; the host leg must never interpolate it. | Unchanged for the host leg; a transport-backed engine leg must keep using `BOX_STEERING_ROOT_SH` resolution in the box, never this value. |
| S2 | `src/fleet/attach.ts:80` `BOX_STEERING_ROOT_SH` | `'root="${QDS_STEERING_ROOT:-/run/steering}"'` — the box resolves its own root; double-quoted so it cannot word-split. | The contract any new transport verb must reuse verbatim. |
| S3 | `src/fleet/attach.ts:82-88` `inboxPath()` / `acksPath()` | `join(root, "inbox.ndjson")` / `"acks.ndjson"`. | The two files a transport read verb must address; `acks.lock` (`attach.ts:638`) is a third. |
| S4 | `src/fleet/attach.ts:228-236` `APPEND_SCRIPT` | Host→box append: `umask 077` first, `mkdir -p`, `tail -c1` newline guard, `cat >>` (stdin payload), `chmod 600`. Payload-free argv. | #181: unchanged as the write half. #180: the `mkdir -p` here **cannot** recreate a root-owned-`/run` directory (measured live: exec user is non-root, `/run` is 755 — `src/providers/exedev/driver.ts:66-72`); it fails as `send-failed`. Re-provision must go through sudo `install -d`, not this script. |
| S5 | `src/fleet/attach.ts:291-295` `ACK_READ_SCRIPT` | `exit 3` if `inbox.ndjson` absent (wiped steering state = fault), `tail -c $ACKS_READ_CAP_BYTES acks.ndjson` if present, silent exit 0 if acks absent. | Consumer-facing: after a wipe+re-provision the inbox file does not exist until the first append creates it; a consumer that drains before any append sees ENOENT (`localSteeringInbox.drain` returns `[]` on ENOENT, `attach.ts:666`) — fine — but the *host* readAck's exit-3 arm fires only when inbox is missing while attach polls, which cannot happen because attach appended first. Keep that ordering invariant. |
| S6 | `src/fleet/attach.ts:367-400` `readAck` | One poll tick: `withTimeout(driver.exec(vm,["sh","-c",ACK_READ_SCRIPT]))`; exit≠0 ⇒ `unreachable`; empty ⇒ `absent`; parse loop skipping torn/`null` lines; `parsedAny ? "absent" : "unusable"`. | #180: no re-provision hook here. #181: unchanged; this is the producer's half of the round trip the new consumer must satisfy. |
| S7 | `src/fleet/attach.ts:430-580` `attachToRun` | Full host verb: refusal gates (436-444: ANY `extensions.approval.state` ⇒ `run-not-attachable`; `closedAt` ⇒ `state:"closed"`; no `vmName` ⇒ `"no-box"`), message minting `crypto.randomUUID()` (446), post-sanitize ceiling guard (460-469), floored opts (472-479), append (493-505) with **no throw on either arm** (`send-failed` result, 503-505), do-while poll (517-564), unusable/unreachable streaks capped at `ACK_UNUSABLE_TICKS_LIMIT`=3 (533-555), no-ack truthfulness guard (576: `no-ack` requires ≥1 clean read else `box-unreachable`). | #180: the natural seam for "on first send-failure, attempt idempotent re-provision then retry the append once" — but note `send-failed` is deliberately a RESULT, not a throw (`attach.ts:482-505`); a re-provision retry must not mint a fresh `messageId` (dedupe rests on the id, `attach.ts:143-146`). |
| S8 | `src/fleet/attach.ts:315-346` `readInboxTail` | Engine leg's bounded TAIL read (1 MiB `INBOX_READ_CAP_BYTES`), drop-first-partial-line. Host-local `fs` only. | #181: this is the read half that must be re-implemented over the transport (or moved in-box). Nothing today reads the box's inbox except tests' `fetchBoxFile`. |
| S9 | `src/fleet/attach.ts:632-656` `appendUnderAcksLock` + `acks.lock` | Host-side serialization via `src/lib/file-lock.ts` (stale ≥5s / dead pid / 2s block, then **best-effort unlocked append**). | #181: a box-side ack writer has NO lockfile helper on the box (`attach.ts:219-222` "the box carries no lockfile helper"). Needs `flock(1)` availability verified, or a lock-free-atomic design, or host-side serialization if the engine leg stays host. |
| S10 | `src/fleet/attach.ts:658-764` `localSteeringInbox` | The `SteeringInbox` impl: `drain()` re-reads inbox in FULL each call, never truncates (666 ENOENT ⇒ `[]`), per-line JSON.parse in try, `ownRunId` filter (684: filter is ON whenever ownRunId given; a line with NO runId counts FOREIGN, 675-687), capped stderr note for skipped foreign lines (699-707); `ack()` (710-762): `mkdirSync(root, 0o700)` then lock, newline-guarded `"a+"` 0o600 append, belt-over-braces `chmodSync 0o600`, ENOENT swallowed. | **The heart of #181.** Either re-home onto the transport (a `TransportSteeringInbox implements SteeringInbox` taking `driver`+`vm`) or run in-box. Its dedupe pair (`delivered`/`acked`) lives in steering.ts, not here. |
| S11 | `src/phase-engine/steering.ts:157-181` `SteeringInbox` port | `drain(point)`, `ack(messageId, point)`, optional `ackedIds()`. Engine never imports fleet/provider (header 1-14, INV-RES-1). | The port a transport impl must satisfy. Note `drain` re-reads in FULL every call (`158-163`) — over ssh that is a per-solicitation `tail -c 1MiB` exec; cost must be accounted. |
| S12 | `src/phase-engine/steering.ts:393-419` `createSteering` deps | `caller`, `rate`, `onTripwire`, optional `inbox`, optional `onInboxError` (awaited, deadline-bound). | Wiring point for the new transport inbox; keep `onInboxError` semantics (sanitized detail, latch dedupe 577-601). |
| S13 | `src/phase-engine/steering.ts:627-801` `drainInbox` | Aggregate `DRAIN_PASS_TIMEOUT_MS`(=60s) bound; `ackedIds` seeded once per pass (671-678); fold-time ack (763); budget floor `ATTACH_FOLD_MIN_BODY_CHARS` (736-743); two remainders counted separately on exhaustion (697-700); recovery resets the fault latch (800). | Unchanged — this is the consumer contract #181's executor must serve. Timeouts: `INBOX_CALL_TIMEOUT_MS`=5s per injected call (71), so a ssh-backed inbox call has a 5 s ceiling per call. |
| S14 | `src/phase-engine/steering.ts:815-856` `solicitSerialized` head | Drain runs BEFORE the status gate, deliberately (820-846: `telemetry.status` is a ONE-WAY latch; three write sites 866/888/905, nothing writes `"active"` back). | Landmine, not a change: any "consumer stopped" diagnosis must not assume the drain stops when the resident degrades — it doesn't; only the CALL stops. |
| S15 | `src/phase-engine/steering.ts:86-140` | Closed 3-point contract (`run_start`/`post_gate_failure`/`run_end`) + `POINT_ALLOWLIST`; closed `.strict()` directive union (96-122). | The solicitation points contract #181's consumer inherits unchanged. |
| S16 | `src/phase-engine/steering.ts:204-269` `ResidentTelemetry`/`SteeringController` | `status/directives/directivesRejected/steeringIterations/spendMicros/exitStatus/tripwires` + `lastDegradationReason`/`lastInboxErrorReason`/`acksBeforeCall`. Metering integer µ$ (445-457). `acksBeforeCall` is **PROCESS-LOCAL** (256-268) — `fleet attach` can never read it. | #180 telemetry must NOT widen `ResidentTelemetry` (journal resident block is a closed key set — `journal.ts:87-97`, `steering.ts:231-233,264-268`). Re-provision telemetry belongs on the driver's `emit()` observability stream (see S20). |
| S17 | `scripts/pipeline-run.ts:155-191` `readSteeringAckedIds` | Durable dedupe half: bounded 512 KiB tail read of the HOST-local `acksPath()`, ENOENT ⇒ `[]`, other errnos throw (engine reports + degrades to in-process dedupe). Host-local `fs`. | #181: if the channel moves in-box/transport, this must move with it (the ack log it reads must be the same file the host leg polls). |
| S18 | `scripts/pipeline-run.ts:1743-1875` | Resident arming + `createSteering` wiring: `startResident` (1747-1754), `inbox: {...localSteeringInbox(MINTED_FLEET_RUN_ID_RE.test(runId) ? {ownRunId: runId} : warn…), ackedIds: readSteeringAckedIds}` (1816-1836), `onInboxError` → `steeringInboxError` trace row (1841-1858), `onTripwire` → `residentTripwire` row (1859-1872). `MINTED_FLEET_RUN_ID_RE` at 132; the bare-uuid warn `steering_ownrun_id_space_mismatch` (1820-1833) — filter is ALWAYS on (1798-1811). | **This is the leg #181 rewires.** Today it binds the host-local impl; DF1.10 binds a driver-aware one. This runner has NO vm/driver in scope (`1789-1793`) — the runner would need `--vm`/driver plumbing, or the executor runs in the box and reads the local fs. |
| S19 | `scripts/pipeline-run.ts:1946-1991` (run_start), `1040-1060` (post_gate_failure via `ResidentHooks`, interface at 730-760), `2072-2093` (run_end) | Directive application: abort ⇒ `residentAborted`; select_roster ⇒ `rosterChoice.pending` + wiring recheck (1964-1983); retry ⇒ guidance into promptContext at the gate-retry seam; run_end reports only. `--no-resident` bool flag at 1260-1267; brief source = `run-context.json` beside the manifest (`readResidentBriefSource`, 632+; read at 1655-1658); resident disabled shape journaled when unarmed (1883-1901). | Unchanged: the three points are where drained attach text lands. `residentContextLines` (1692-1696) seeds `promptContext`. |
| S20 | `src/providers/exedev/driver.ts:87-92` `STEERING_PROVISION_SCRIPT`, `308-316` `provisionSteeringChannel` | `sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root"` + `test -w` + `stat -c %a = 700`. Called from `create()` on BOTH success arms (275, 284). STRICT failure: `ExeDevDriverError("steering-channel-unprovisionable", …)` with 3-way diagnosis (137=SIGKILL/255=ssh/other=sudo policy, 103-144). Telemetry: `emit("steering_provision", …)` (311, 315) on the JSONL observability stream (emit at 221-233). | **#180's provisioning exists exactly once, at birth.** No re-provision path anywhere (verified: grep `provisionSteeringChannel` ⇒ only driver.ts). The `install -d` is already idempotent (docblock 76-79) — #180's work is a *call site + trigger + telemetry*, not a new script. `private` ⇒ must be exposed (public method or an exported ensure-helper). |
| S21 | `src/providers/exedev/driver.ts:544-569` `exec`/`execTimed` | One `ssh <vm>.exe.xyz <quoted-argv>`; argv elements `shQuote`d and joined; `stdin` rides through; per-driver `execTimeoutMs`. | The ONLY transport any in-box work can use. Note ssh concat semantics: `["sh","-c",script]` is the fixed shape every steering script uses. |
| S22 | `src/providers/exedev/driver.ts:589-602` + `711-725` `copyFile`/`assertBoxPathSafe` | Box→host scp only; **box-RELATIVE** (leading `/` refused, `"remote-path-invalid"`). | LANDMINE: reading `/run/steering/acks.ndjson` through `copyFile` is impossible by construction (also `src/providers/exedev/transport.ts:132-134` documents the identical `runMarkerPath` lesson). Use `exec`+`cat`/`tail -c`. |
| S23 | `scripts/pipeline-run-remote.ts:1-120` | Host-driven substrate proof; header 5-19: box image carries no bun/node, phases execute ON THE BOX orchestrated FROM THE HOST; `HONEST LABEL: this is NOT the in-box executor (proposed story DF1.10)` (18-20); `makeRemoteBodyFactory` throws for non-`code` kinds: "no executor is registered for kind '…' on the remote shim (the in-box executor is proposed story DF1.10)" (118-120). `fetchBoxFile` = `exec`+`cat` (52-59); `boxHome` resolved ON the box (68-76). | The template for DF1.10's engine leg + the honest-label that #181 retires. Reuse `fetchBoxFile`/`boxHome`/`shellQuote` (F017, `src/providers/exedev/transport.ts`). |
| S24 | `src/fleet/resident.ts:321-639` `startResident` | **Host-spawned** pi subprocess per call (`Bun.spawn`, argv 448-462: `pi --provider openrouter --model … --mode json --no-tools --session <path> -p <prompt>`); session FILE is the continuity (not a long-lived process); `stdin:"ignore"` — the prompt rides argv (421-432, MAX_PROMPT_BYTES 128 KiB); least-privilege env allowlist (235-260); disabled path `briefIsEmpty` ⇒ `{disabled:true}` (197-202, 322). | DF1.10 does NOT move the resident: the resident is a host process per solicitation. Steering is FOLDED into its context via `ctx.promptContext` (`steering.ts:754`) — there is no on-box resident stdin to feed. An "in-box consumer" therefore means either (a) a host-side executor that drains the box's inbox over the transport, or (b) an on-box pi caller like tier5's (`tests/fleet/e2e/tier5-gate-steering.live.test.ts:328`: `set -a; . "$HOME/app/.env"; … timeout 360 pi --provider openrouter --model … -p "$(cat /tmp/t5-prompt.txt)"`). |
| S25 | `src/fleet/verbs.ts:264-307` + `scripts/fleet.ts:3463-3640` | `attach` CLI: `--driver` REQUIRED, `--message` optional/`-`=stdin; pre-store ceiling mirror (3525-3536); outcome→exit table: `attach-not-acked`=6 (all four reasons), `run-not-attachable`=5, `message-over-ceiling`=usage exit 2, `attach-acked`=0; `gateEvent` emits `event:"attach"` with `reason` only on `attach-not-acked` (3566-3585). | #180: a re-provision attempt must surface here (new reason field or detail) without breaking the exit-code table (`verbs.ts:305` declares `[0,1,2,4,5,6]`). |
| S26 | `src/fleet/approval-gate.ts:1164-1234` (`emitPause`), `src/reverify/runner.ts` (grep: zero `attach`/`steering` hits) | Approval gate touches steering only through the `gateEvent` union (`pause` producer is the gate; `attach` is the CLI's). `requestApproval` runs REAL teardown BEFORE promoting to `awaiting-approval` (`attach.ts:408-418` reads the consequence). | Interaction already handled by attach's refusal arm + the documented, deliberately-accepted race (`attach.ts:420-429`): the state read is a FAST REFUSAL, not an invariant. DF1.10 must not "fix" it with the approval lock (that docblock explains why not). |
| S27 | `src/phase-engine/journal.ts:87-97, 139-153, 169` | `resident?: ResidentTelemetry` optional on the journal file; `writeResident` twice-callable (seed pre-finish 1944, refresh post-finish 2059, final in `finally`); closed key set — no field for a degradation cause or a channel counter. | New DF1.10 telemetry cannot ride here; use the trace sidecar (`type:"log"` rows, pipeline-run.ts:1841-1872 precedent) and/or the driver `emit()` stream. |

---

## 2. GAP INVENTORY (things that do not exist)

1. **The in-box/transport steering consumer.** Nothing anywhere drains the BOX's `/run/steering/inbox.ndjson` in production. `localSteeringInbox` is host-local `fs` (`attach.ts:658`); the only box-side inbox readers are test helpers (`fetchBoxFile`, `pipeline-run-remote.ts:52-59`, `live-harness.ts`).
2. **A transport-backed `SteeringInbox` implementation.** No class/function takes `driver` + `vm` and satisfies the port (`steering.ts:157-181`). Needs: tail read of box inbox (bounded — mirror `readInboxTail`'s 1 MiB + drop-first-partial-line, `attach.ts:313-346`), box-side ack append (newline-guarded, 0600 — mirror `ack()` 710-762), and `ackedIds()` (mirror `readSteeringAckedIds`, `pipeline-run.ts:155-191`).
3. **Any on-box daemon/supervisor mechanism.** Only prior art is `startVisualizer` (`src/providers/driver.ts:1110-1160`): `nohup … &` + pidfile + idempotent REUSED/STARTED — and it runs `bun run`, which the box image does not have. tier5's engine leg (`tier5-gate-steering.live.test.ts:311-350`) is the only proven in-box pi invocation (pi IS on the box; key in `$HOME/app/.env`). There is no systemd/cron/ssh-forced-command story; `approval-gate.ts:2098-2111` states "There is no daemon in this design".
4. **Re-provision trigger.** `provisionSteeringChannel` is `private` and called only from `create()` (`driver.ts:275,284,308`). No `ensure`/`repair` verb, no call from the attach `send-failed` path, no call at any teardown/expiry boundary. `/run` is tmpfs ⇒ a box reboot wipes the channel and nothing notices until attach fails.
5. **Re-provision telemetry.** `emit("steering_provision")` exists for birth (`driver.ts:311,315`); no op name, counter, or record field exists for a re-provision. `ResidentTelemetry`/journal resident block are closed — must not be widened (`journal.ts:87-97`).
6. **Box-side lock primitive.** `acks.lock` locking (`attach.ts:638`) is `src/lib/file-lock.ts` (host pid-file based). The box has no equivalent; `APPEND_SCRIPT` is explicitly single-writer best-effort with no lock (`attach.ts:218-227`).
7. **Operator-facing channel-health surface.** `acksBeforeCall` (`steering.ts:269,523`) is process-local by design; nothing cross-process can print it beside an `attach-acked` line. #181's AC will have to pick a surface (trace row exists: `steeringInboxError`, `pipeline-run.ts:1841-1858`).
8. **Executor registration for non-`code` phase kinds** in the remote path (`pipeline-run-remote.ts:118-120` still throws).

---

## 3. EXACT CONTRACTS AS IMPLEMENTED (verbatim, for the writer)

### 3.1 Inbox line — `AttachLine` (`attach.ts:118-124`)
```ts
export interface AttachLine {
  messageId: string;      // crypto.randomUUID() per attach call (attach.ts:446)
  requestId?: string;     // echoed from the record; JSON.stringify drops when absent
  runId: string;          // MANDATORY on every line the host verb writes
  message: string;        // raw operator text (unsanitized on the wire)
  sentAt: string;         // new Date().toISOString()
}
```
Written as one `JSON.stringify(line) + "\n"` on **stdin** to `APPEND_SCRIPT` (`attach.ts:495`).

### 3.2 APPEND_SCRIPT (`attach.ts:228-236`)
```
umask 077 && root="${QDS_STEERING_ROOT:-/run/steering}" && mkdir -p "$root" \
  && f="$root/inbox.ndjson" \
  && { [ ! -s "$f" ] || [ "$(tail -c1 "$f")" = "" ] || echo >> "$f"; } \
  && cat >> "$f" && chmod 600 "$f"
```

### 3.3 ACK_READ_SCRIPT (`attach.ts:291-295`)
```
root="${QDS_STEERING_ROOT:-/run/steering}" && [ -f "$root/inbox.ndjson" ] || exit 3 \
  ; if [ -f "$root/acks.ndjson" ]; then tail -c 524288 "$root/acks.ndjson"; fi
```
(`ACKS_READ_CAP_BYTES = 512 * 1024`, `attach.ts:266`; must stay ≤ `EXEC_MAX_OUTPUT_BYTES` — drift-guard test `tests/fleet/attach.test.ts:973`.)

### 3.4 Ack line (`attach.ts:732`)
```json
{"messageId":"<uuid>","ackedAt":"<ISO>","point":"run_start|post_gate_failure|run_end"}
```
Appended newline-guarded to `acks.ndjson`, mode 0600 enforced at create AND by `chmodSync` after (`attach.ts:739-756`), under `acks.lock` (stale ≥5 s / dead pid, 2 s block, then unlocked best-effort — `attach.ts:632-656`).

### 3.5 Provision script (`driver.ts:87-92`)
```
root="${QDS_STEERING_ROOT:-/run/steering}" && \
sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root" && \
test -w "$root" && test "$(stat -c %a "$root")" = 700
```
Failure taxonomy: exit 137 ⇒ exec-budget SIGKILL (box/transport fault); exit 255 ⇒ ssh transport fault; anything else ⇒ substrate sudo/permission policy. Code is always `steering-channel-unprovisionable` (`driver.ts:103-144`). **FakeDriver provisions nothing** (`fake-driver.ts:154` `create` has no steering call) — FakeDriver suites exercise steering only through `QDS_STEERING_ROOT`.

### 3.6 Mode bits / ownership summary
- `/run/steering` dir: 0700, exec-user uid/gid (provision).
- `inbox.ndjson`: 0600 from `umask 077` + trailing `chmod 600` (attach.ts:229,235).
- `acks.ndjson`: 0600 at create (`"a+", 0o600`, attach.ts:739) + `chmodSync` belt-over-braces (756).
- Host `steeringRoot()`: created 0700 at ack time (`mkdirSync … mode 0o700`, attach.ts:719).

### 3.7 Ceilings / timers (all engine- or transport-facing)
| Constant | Value | Site |
|---|---|---|
| `ATTACH_MESSAGE_CHAR_CEILING` | 4 000 chars POST-`sanitizeForMessage` | `steering.ts:45`; guarded in `attach.ts:460-469` and mirrored in `scripts/fleet.ts:3525-3536` |
| `ATTACH_ACK_CEILING_MS` | 30 000 | `attach.ts:91` |
| `ATTACH_POLL_INTERVAL_MS` | 500 | `attach.ts:93` |
| `ATTACH_PER_CALL_TIMEOUT_MS` | 10 000 | `attach.ts:95` |
| `ACK_UNUSABLE_TICKS_LIMIT` | 3 consecutive | `attach.ts:102` |
| `ATTACH_MIN_TICK_MS` | 10 (floor on caller ms) | `attach.ts:110,472-479` |
| `ACKS_READ_CAP_BYTES` | 524 288 (= exec cap) | `attach.ts:266` |
| `INBOX_READ_CAP_BYTES` | 1 048 576 | `attach.ts:313` |
| `PROMPT_CHAR_CEILING` | 16 000 | `steering.ts:21` |
| `ATTACH_FOLD_CHAR_BUDGET` | 8 000 (half the prompt) | `steering.ts:51` |
| `ATTACH_FOLD_MIN_BODY_CHARS` | 256 | `steering.ts:63` |
| `INBOX_CALL_TIMEOUT_MS` | 5 000 per injected inbox call | `steering.ts:71` |
| `DRAIN_PASS_TIMEOUT_MS` | = `SOLICIT_TIMEOUT_MS` (60 000) per pass | `steering.ts:84` |
| `MAX_MALFORMED_ATTEMPTS` | 2 | `steering.ts:28` |
| `SOLICIT_TIMEOUT_MS` | 60 000 (clamp 1..600 000 via `QDS_RESIDENT_TIMEOUT_MS`) | `steering.ts:26`; `resident.ts:47-48,174-179` |

### 3.8 Fold line pushed into the prompt (`steering.ts:723-754`)
`operator attach <sanitized messageId ≤256>: <sanitized body ≤4000>` — pushed (never unshifted), budget-clamped with marker `[attach truncated, N chars total]`.

---

## 4. LANDMINES the ACs/tests must guard

1. **`telemetry.status` is a one-way latch.** Written `"degraded"` at `steering.ts:866, 888, 905`; nothing ever writes `"active"` back. The drain deliberately runs BEFORE the gate (`steering.ts:820-846`) so a degraded resident still drains/acks — any test that expects a channel to "stop" when the resident degrades will be wrong, and any AC that promises recovery is unimplementable without widening the latch.
2. **`attach-acked` is an inbox-processing receipt, not a read receipt.** A message can be folded+acked on a solicitation that returns `PROCEED` one line later (no prompt rendered, no caller call) — `steering.ts:833-846`; measurable only via process-local `acksBeforeCall` (`steering.ts:523, 854, 870, 890`).
3. **`run-not-attachable` refusal is a fast read, not an invariant.** `attachToRun` reads the record state without the approval lock (`attach.ts:420-429`); a run entering `pausing` in the window loses one message and nothing else. Do not add the approval lock.
4. **`closedAt` vs approval-state joins.** ANY `extensions.approval.state` value — including unknown ones — refuses (`attach.ts:436-441`); `closedAt` ⇒ `state:"closed"` (442). `status.ts:585-587, 641-643` deliberately keeps `fleet status` consistent with that refusal. A re-provision path must not read these as "box alive".
5. **`copyFile` cannot touch `/run/steering`** (box-relative only, `driver.ts:711-725`; precedent lesson `transport.ts:132-134`). Every new transport read must be `exec` + `cat`/`tail -c`, bounded by `EXEC_MAX_OUTPUT_BYTES` (512 KiB, `src/providers/bounded-exec.ts`).
6. **Retry mints a fresh `messageId` ⇒ double delivery.** `attach.ts:143-146, 485-491`; `send-failed` deliberately returns the ATTEMPTED id (`attach.ts:504`). A re-provision retry must reuse the minted id, not mint again.
7. **Over-ceiling is measured POST-sanitize and is a result arm, not a throw** (`attach.ts:446-469`) — a throw would become exit-1 "retry me" in the CLI. `ATTACH_MESSAGE_CHAR_CEILING` ≠ `DIRECTIVE_TEXT_CHAR_CEILING` by contract even though the numbers coincide today (`steering.ts:36-45`).
8. **`send-failed` may still have landed the line** — `withTimeout` is host-side only, cannot cancel the in-box `cat` (`attach.ts:151-156, 482-491`). Any "retry the append after re-provision" must assume possible duplication and rely on `messageId` dedupe in the consumer.
9. **Foreign-run filter is always on** (`pipeline-run.ts:1798-1834`); a bare-uuid `--run-id` silently starves every fleet-id line plus one `steering_ownrun_id_space_mismatch` warn. A line with NO `runId` counts foreign (`attach.ts:675-687`).
10. **The inbox is never truncated** and drain re-reads it in full every solicitation (`attach.ts:583-596`, `steering.ts:158-163`); a 1 MiB tail cap (`attach.ts:313`) drops the OLDEST lines. Over ssh this becomes a per-solicitation cost inside `INBOX_CALL_TIMEOUT_MS`=5 s / pass budget 60 s (`steering.ts:71,84`).
11. **Durable dedupe depends on the acks file being the SAME file** the host leg polls (`pipeline-run.ts:155-191` reads `acksPath()` host-locally). If the channel moves in-box, this read must move too or dedupe silently halves.
12. **Live e2e assertions are pinned to the CURRENT (broken) shape.** `tests/fleet/e2e/tier1-attach-transport.live.test.ts:31-39` and `tier5-gate-steering.live.test.ts:18-28` assert `attach-not-acked` / reason `no-ack` / exit 6 as the PASS shape "until DF1.10 lands". Landing a real consumer INVERTS these — they are load-bearing and must be updated in the same story, not left lying.
13. **Journal resident block is a closed key set** (`journal.ts:87-97`; `steering.ts:231-233, 264-268`). New counters go to the trace sidecar (`type:"log"` rows) or the driver `emit()` stream, not the telemetry block.
14. **The resident is host-spawned and argv-fed** (`resident.ts:448-471`, `stdin:"ignore"`). There is no on-box resident stdin/IPC to "fold into" — folding happens only through `ctx.promptContext` at a solicitation point.
15. **Box image has no bun/node** (`pipeline-run-remote.ts:6-7`) — an on-box executor must be `sh`/python/pi, and pi needs `$HOME/app/.env` sourced for the key (tier5:328 is the only proven invocation).
16. **Expiry/sweep joins**: orphan-expiry and reap paths destroy boxes without consulting the steering channel; `ACK_READ_SCRIPT`'s exit-3 (inbox missing) and `readAck`'s `unreachable` are how a wiped tmpfs shows up — do not reinterpret exit 3 as "healthy empty".

---

## 5. WIDE BLAST RADIUS (run `impact` on these at dev time)

| Symbol | Why wide |
|---|---|
| `attachToRun` (`attach.ts:430`) | Called by `scripts/fleet.ts:3548` (CLI), `tests/fleet/attach.test.ts` (24 tests), both live e2e tiers, and any #180 re-provision retry. |
| `localSteeringInbox` (`attach.ts:658`) | `pipeline-run.ts:1817` + `tests/fleet/attach.test.ts` (lock/mode/foreign/torn tests) + steering suites via `createSteering`. |
| `SteeringInbox` (port, `steering.ts:157`) | Widening it (e.g. adding a `provision`/`health` member) touches attach.ts, pipeline-run.ts, `tests/phase-engine/steering.test.ts` (1692 lines), `tests/phase-engine/pipeline-run.test.ts:1632-1800`. |
| `createSteering` (`steering.ts:393`) | Every steering test + runner wiring; the drain path is serialized through one promise chain (`steering.ts:808-813`). |
| `ExeDevDriver.create` / `provisionSteeringChannel` (`driver.ts:237,308`) | dispatch provisioning, e2e harnesses (`live-harness.ts`), tier1/tier3/tier4/tier5 live tests; making it public or adding an ensure verb changes the driver's public surface (`src/providers/index.ts`). |
| `STEERING_PROVISION_SCRIPT` (`driver.ts:87`) | Reused verbatim by any re-provision; its failure taxonomy (`steeringProvisionFailure`) is load-bearing for the CLI's remediation text. |
| `ATTACH_MESSAGE_CHAR_CEILING` (`steering.ts:45`) | Three enforcement sites must move together: `attach.ts:460`, `scripts/fleet.ts:3525`, `steering.ts:724`. |
| `EXEC_MAX_OUTPUT_BYTES` (`src/providers/bounded-exec.ts`) | Bound contracts with `ACKS_READ_CAP_BYTES` (`attach.ts:266`) and `readSteeringAckedIds` (`pipeline-run.ts:161`); drift-guard test `attach.test.ts:973`. |
| `readAck` (`attach.ts:367`) | Its verdict union is the truthfulness contract for the CLI's four reasons. |
| `solicitSerialized`/`drainInbox` (`steering.ts:627,815`) | The consumer contract; any change re-opens the DF3.4 round-7/round-10 findings (budget, latch, dedupe). |

---

## 6. Test coverage today (what's pinned, and where the hole is)

| File | Pins |
|---|---|
| `tests/fleet/attach.test.ts` (1015 lines, 24 tests) | FakeDriver round trip w/ metachars (:199); payload never in argv (:230); 0600 on both files (:291); dedupe on re-issued id (:305); no-ack shape (:328); ceiling-0 unreachable ⇒ `box-unreachable` not `no-ack` (:353, :388, :426); send-failed returns ATTEMPTED id (:463); `run-not-attachable` for pausing/awaiting/closed/no-box/unknown state (:511, :530); INV-APPROVE-5 (:573); torn line skip (:605); foreign-run filter + counted drop (:633); acks-unreadable abandon (:668); post-sanitize ceiling (:694, :734); `null` ack lines (:759, :781); lax acks tightened (:803); `acks.lock` serialization (:825, :855, :877); ENOENT-noop ack (:902); bounded ack tail (:934); drift guard vs exec cap (:973); `steeringRoot` override (:1008). **All of it is HOST-leg + HOST-local engine leg.** |
| `tests/phase-engine/steering.test.ts` (1692 lines) | Closed `.strict()` union (:77-130); per-point allowlist (:201); tripwires (:254); degradation (:360); integer-µ$ metering incl. overflow/sum guards (:503-672); prompt ceiling (:672-772); barrel boundary (:773); plus the DF3.4 inbox drain/fold/ack/budget/latch tests further down. |
| `tests/fleet/resident.test.ts` (883 lines) | Disabled-brief (:114); ingress validation (:160); rate (:239); frozen argv shape (:288); harvest (:358); process-end mapping (:402); stop/overlap (:531-703); persistence+redaction (:704); session continuity (:827). |
| `tests/phase-engine/pipeline-run.test.ts` | `steeringInboxError` trace row carries the fault, run exits 0 (:1632-1696); bare-uuid run id folds ONLY its own lines, foreign skipped not acked, warn emitted (:1698-1800). |
| `tests/fleet/e2e/tier1-attach-transport.live.test.ts` | REAL box: append lands verbatim on `/run/steering/inbox.ndjson`, 0600/umask, newline guard, real 30 s ceiling ⇒ **`attach-not-acked`/`no-ack`/exit 6 asserted as the PASS shape** (header 31-39) because no consumer exists. |
| `tests/fleet/e2e/tier5-gate-steering.live.test.ts` | Full chain with real spend; hand-rolled in-box pi engine (311-350); attach asserts the same honest `no-ack` (18-28); post-approval attach refusal. |
| Driver provisioning | NO unit test drives `STEERING_PROVISION_SCRIPT`/`provisionSteeringChannel` (private; only reachable via `create()` with an injected `run` seam). Live proof only (`driver.ts:67` cites `_bmad-output/evidence/df3-e2e/2026-08-30-160742-*`). |

**Test hole DF1.10 must fill:** there is no test anywhere that a message written to a box's inbox is read, folded, and acked on the SAME box — the FakeDriver suites exercise both legs against one host filesystem, which is precisely the coincidence DF1.10 removes.
