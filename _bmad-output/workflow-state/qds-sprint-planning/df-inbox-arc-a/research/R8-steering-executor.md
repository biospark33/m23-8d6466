# R8 — In-Box Steering Executor + Channel Lifecycle (DF1.11, closes #180 + #181)

Research agent 8, 2026-08-31, repo `/Users/steve/QDS-Factory` @ `feature/df1-10-tier2-placement-adr`, read-only.
Written for the DF1.11 story writer. Supersedes the *placement* assumptions (not the citations) of
`df1-10-a/research/R2-steering-spec.md` and `R3-code-surface.md`, both authored for the RESCINDED
host-side option-1 design.

Authorities: ADR `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED); probe
`_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`; issues #180/#181.

---

## 0. The headline the story must not fight

**With the engine in-box, #181 needs essentially no new steering code.** `localSteeringInbox`
(`src/fleet/attach.ts:658-764`) is already a plain `node:fs` consumer of `/run/steering`, and its own
ack docblock already says *"the engine runs in the box"* (`attach.ts:710-717`). It was never the wrong
implementation — it was running on the wrong machine. Move the engine (DF1.10) and the same function,
the same `readSteeringAckedIds` (`scripts/pipeline-run.ts:155-191`), the same `acks.lock`
(`attach.ts:632-656`) and the same host verb (`attachToRun`, `attach.ts:430-580`) close the round trip
unmodified, because attach already writes and polls **the box's** files.

So DF1.11's real content is:

1. one line added to `STEERING_PROVISION_SCRIPT` (or one file baked into the DF2.10 image) — #180;
2. a runId-provenance contract for whatever launches the in-box engine — the one genuine new failure mode;
3. retirement of the DF1.10 stopgap prose (two of those strings are **pinned by a unit test**);
4. inversion of the live-e2e PASS shapes;
5. an honest reboot-loss contract.

Any design that introduces a transport-backed `SteeringInbox`, a box-side `flock` primitive, a
re-provision state machine, or a second daemon is building for the rescinded architecture. R2 §5.2's
"(b) wide" resolution and R3 gap #2 are both **dead** — there is no daemon question left, because the
engine *is* the in-box process and it drains at DF3.3's three solicitation points as shipped.

---

## 1. R2's C1–C30 under in-box placement

Verdicts: **SURVIVES** (restate as-is) · **FLIPS** (survives with changed form/rationale) ·
**DIES** (no longer applies) · plus new clauses N1–N6 in §1.2.

| # | R2 clause (short) | Verdict | What the writer must say now |
|---|---|---|---|
| C1 | Both legs on the box's `{inbox,acks}.ndjson`; no host-local inbox in production | **SURVIVES — true by construction** | Not a rule to enforce but a consequence: with the engine in-box, `steeringRoot()` (`attach.ts:54-63`) *is* the box path. AC should assert the negative: no production process outside the box opens a steering file. |
| C2 | All box I/O rides `driver.exec`, stdin only; never `copyFile`, no second channel | **FLIPS (narrows)** | Now scoped to the **host leg** (`APPEND_SCRIPT` `attach.ts:228-236`, `ACK_READ_SCRIPT` `attach.ts:291-295`). The engine leg is local `node:fs` and **MUST NOT** take a driver/vm reference — that preserves the engine's barrel boundary (`steering.ts:1-14`, INV-RES-1) which the rescinded transport inbox would have breached. `copyFile` ban (`driver.ts:711-725`) and "no ssh/HTTP/second channel" survive verbatim. |
| C3 | Envelope `{messageId, requestId, runId, message, sentAt}` | **SURVIVES verbatim** | `AttachLine`, `attach.ts:118-124`; written at `:480`. Unchanged. |
| C4 | Text on stdin, never argv | **SURVIVES** (host leg); N/A engine leg | `attach.ts:493-505`. |
| C5 | Both files 0600, exec-user owned, no credential material | **SURVIVES + one addition** | `acks.lock` now also lives in-box inside the 0700 dir (`attach.ts:638`). Dir 0700 / files 0600 unchanged. |
| C6 | One root, host and box may never diverge | **FLIPS (new form of the same split-brain)** | Both resolvers now run **on the box** but in **two different environments**: attach's `BOX_STEERING_ROOT_SH` (`attach.ts:80`) resolves in a non-interactive **ssh session**; the engine's `steeringRoot()` resolves in the **systemd unit** environment. Setting `QDS_STEERING_ROOT` in the unit alone re-creates exactly the failure `attach.ts:39-53` documents. → new clause **N2**. |
| C7 | 30 s ceiling ⇒ `attach-not-acked`, never a silent success or auto-resend | **SURVIVES — and becomes meaningful** | Today an elapsed ceiling is structurally certain; after DF1.10 it is a genuine fault signal. `ATTACH_ACK_CEILING_MS` `attach.ts:91`. |
| C8 | Read caps preserved or tightened | **SURVIVES (pressure drops)** | `INBOX_READ_CAP_BYTES` 1 MiB (`attach.ts:313`), `ACKS_READ_CAP_BYTES` 512 KiB (`attach.ts:266`, drift-guarded `tests/fleet/attach.test.ts:973`). The oldest-line-drop risk is now negligible: the file holds **one run's** traffic (§2.3), not a host-wide log. |
| C9 | Exit-3 / `unreachable` ack classification (AT1s) | **SURVIVES unchanged** | `ACK_READ_SCRIPT` `attach.ts:291-295`, `readAck` `attach.ts:367-400`. Host leg untouched. Do **not** reinterpret exit 3 as "healthy empty" post-reboot (§3.4). |
| C10 | Attach refusals + Deviation 10 fast-refusal posture | **SURVIVES unchanged** | `attach.ts:400-444`. Do not add the approval lock — the docblock at `:420-429` explains why. |
| C11 | Exactly three solicitation points, no fourth | **SURVIVES** | `steering.ts:38`, `:86-140`. |
| C12 | Ack `{messageId, ackedAt, point}`, fold-time point | **SURVIVES** | `attach.ts:732`; fold-time point `steering.ts:758-761`. |
| C13 | `messageId` is the dedupe key, exactly-once per id | **SURVIVES** | `steering.ts:663-678`. |
| C14 | Durable dedupe seeded from the acks log | **SURVIVES with a changed persistence story** | `readSteeringAckedIds` (`pipeline-run.ts:155-191`) becomes a local read of the **same** file attach polls — R3 landmine 11 resolves itself. New requirement: inbox + acks (+ lock) must live on **one** filesystem so a wipe takes both together → **N3**. |
| C15 | `ownRunId` filter never off (round-10 S1) | **SURVIVES as policy; threat model dies; starvation risk promotes** | `/run/steering` is per-box and production runs **one run per box** (each `dispatch` provisions its own box; fan-out arms each call `dispatch` — `fanout-primitive.ts:560-612`; the record binds one `vmName`, `run-record.ts:124`). Cross-run theft is now near-impossible, so keep the filter at zero cost — but the **other** failure mode gets worse: a launcher passing a bare-uuid `--run-id` starves *every* line, and the `steering_ownrun_id_space_mismatch` warn (`pipeline-run.ts:1820-1833`) now goes to in-box stderr/journald where nobody is looking. → **N1**. |
| C16 | Mutual exclusion on both appends (AT3s) | **FLIPS (simplifies) — keep the lock, invent nothing** | Acks writers post-move are a **single in-box engine process**, and the `<pid>:<nonce>` staleness oracle (`src/lib/file-lock.ts:14-16,49-62`) is finally same-namespace: the pid in the lock and the process being probed are on one machine. (It was *never* wrong today either — both host-side; it would have become wrong only under the rescinded design, where a **host** pid was to be stamped into a **box** lock file and `isPidDead` would have judged it against host processes.) The lock is now near-vestigial but costs zero diff and still covers restart overlap — keep it. **No box-side `flock` is needed.** Inbox-side interleaving between two concurrent host attaches remains unlocked and unchanged (`attach.ts:218-227`) — pre-existing, not this story's to fix. |
| C17 | Guidance only; never moves a gate or raises a bound | **SURVIVES** | INV-APPROVE-5. |
| C18 | R9: an ack is a claim, not proof | **SURVIVES — and regains its footing** | The ADR's core argument (`ADR:60-64`): in-box gates emit claims, DF5.1 host re-verify is the independent second layer. Restate that DF5.1 is unchanged and that nothing host-side treats `attach-acked`/an acks line as verification. |
| C19 | `ack-provenance` surfaced on a host CLI | **FLIPS — re-scope or re-defer** | Correction to R3 gap #7: `acksBeforeCall` **is** part of `ResidentTelemetry` (`steering.ts:269, 974-976`) and already reaches the journal file via `{...steering.telemetry}` (`pipeline-run.ts:1897-1901`, `journal.ts:97`). In-box it becomes **harvest-time** rather than live — strictly later, not earlier. Cheapest honest satisfaction: read it from the harvested journal in `fleet status`. Otherwise re-defer **explicitly** (it has now been carried twice: df3-4 `:741`, `:784`). |
| C20 | Agent-phase-retry latency ceiling inherited, not closed | **SURVIVES** | `post_gate_failure` is code-phase-only; three stories forbid a fourth point. |
| C21 | `attach` gate event + `attach_rtt_ms` + `requestId` | **SURVIVES; its re-provision sub-clause dies** | `scripts/fleet.ts:3566-3585`. There are no re-provision events in a declarative design → replaced by C23's boot-id signal. |
| C22 | Re-run the provisioning chain on the first channel-attributable send failure | **DIES** | ADR `:143-146`: the fix becomes declarative. No send-failed trigger, no retry-the-append machinery, no reuse-the-messageId subtlety (R3 landmine 6 evaporates). |
| C23 | Re-provisions counted so a reboot loop is visible | **FLIPS (same intent, new signal)** | Nothing counts a `tmpfiles.d` recreation — it happens at boot with no code involved. The event that actually matters is **"this box rebooted under a live run"**: have the in-box engine emit one trace row at startup carrying `/proc/sys/kernel/random/boot_id` (+ uptime); a changed boot_id mid-run *is* the channel recreation, counted once, harvestable. Sidecar/trace row, **not** the journal `resident` block (closed key set, `journal.ts:87-97`) and **not** `ResidentTelemetry`. |
| C24 | In place, no second box, no cost-ledger key widening | **SURVIVES trivially** | Nothing re-creates anything; `boxHoursEventId` untouched. |
| C25 | Don't widen `ExeDevDriver.exec`'s blast radius | **SURVIVES — and gets easier** | The change is inside the existing fixed literal `STEERING_PROVISION_SCRIPT` (`driver.ts:87-92`); `provisionSteeringChannel` (`driver.ts:308-316`) stays `private` and create-only. No new driver surface, no `steeringSend` seam. |
| C26 | Provisioning failure stays typed and truthful (P2) | **SURVIVES** | The added `tmpfiles.d` write rides the same taxonomy: a sudo refusal is still `steering-channel-unprovisionable` with the 137/255/other diagnosis (`driver.ts:103-144`). Add no new failure arm. |
| C27 | The drain side must survive a wipe too | **SURVIVES — already satisfied by shipped code** | `drain` ENOENT ⇒ `[]` (`attach.ts:663-667`); `ack` ENOENT ⇒ no-op (`attach.ts:710-717`). Residual: if `/run/steering` is gone while `/run` is root-owned 755, the ack's `mkdirSync` (`attach.ts:719`) fails **EACCES**, which is not ENOENT and therefore throws → reported through `onInboxError` as an inbox fault. That is fail-closed and acceptable; it is also the reason for unit ordering → **N4**. |
| C28 | No absorption of DF3.6's three bounds; no re-derived char ceiling | **SURVIVES** | `ATTACH_MESSAGE_CHAR_CEILING` is DF3.3's (`steering.ts:45`), enforced at `attach.ts:460-469` and mirrored `scripts/fleet.ts:3525-3536`. |
| C29 | No edit to DF3.3-owned `steering.ts` lines; no fourth call site | **SURVIVES — now literally zero engine edits** | The consumer contract (`drainInbox` `steering.ts:627-801`) is served as shipped. |
| C30 | No approval-gate mechanics change | **SURVIVES** | The gate stays host-owned by construction (ADR `:93-95`); the bridge is a *different* arc story. |

### 1.2 New clauses the in-box world introduces

- **N1 (MUST) — runId provenance.** Whatever launches the in-box engine MUST pass the record's minted
  fleet run id. It is already on the box: `dispatch` writes `run-context.json` carrying `runId`,
  `requestId`, `pipelineId`, `effectiveCeilingMicros` (`src/fleet/dispatch.ts:2822-2846`), and the
  runner already reads that file for the resident brief (`pipeline-run.ts:632, 1655-1658`). Launching
  with `pipeline-run.ts`'s bare-uuid default silently starves every attach (`MINTED_FLEET_RUN_ID_RE`
  `pipeline-run.ts:132`; warn `:1820-1833`). The warn MUST also ride the trace sidecar, not only
  stderr, or in-box it is invisible. *(If DF1.10 owns the launcher, DF1.11 owns this as a contract
  clause + AC and cross-references it.)*
- **N2 (MUST) — env parity for `QDS_STEERING_ROOT`.** Default: unset in **both** the systemd unit and
  the ssh session, so both resolve `/run/steering`. If it is ever set, it MUST be set where the ssh
  session sees it too (`/etc/environment` via pam_env — **verify, do not assume**). A unit-only
  `Environment=` line re-creates the two-legs-on-different-files defect `attach.ts:39-53` names.
- **N3 (MUST) — co-location.** `inbox.ndjson`, `acks.ndjson` and `acks.lock` live on ONE filesystem.
  Durable dedupe (C14) is correct today only because a tmpfs wipe takes the queue and the ack log
  together; a persistent inbox beside a volatile acks log would re-fold and re-ack everything after a
  reboot.
- **N4 (MUST) — boot ordering.** The engine unit must start after `systemd-tmpfiles-setup.service`
  (implicit for a normal `multi-user.target` service, but it must be stated and tested), otherwise the
  first drain/ack after a reboot hits the EACCES arm in C27.
- **N5 (MUST) — the honest reboot contract** (§3.4): messages queued but not yet folded are **lost**
  with the tmpfs. Attach's exit-6 prose must say so; today it says the opposite ("the message IS queued
  in the box", `scripts/fleet.ts:3673`).
- **N6 (MUST) — retire the stopgap prose in the same story.** Full inventory in §4.3; two of those
  strings are asserted by `tests/fleet/gate-verbs.test.ts:1392-1393`, so leaving them stale fails the
  unit suite, not just an audit.

---

## 2. The ack path in-box

### 2.1 Who writes what, after the move

| File | Writer | Mechanism | Reader |
|---|---|---|---|
| `/run/steering/inbox.ndjson` | host `attachToRun` | `driver.exec` + `APPEND_SCRIPT` on stdin (`attach.ts:228-236, 493-505`) | in-box engine, `readInboxTail` local fs (`attach.ts:315-346`, via `localSteeringInbox.drain`) |
| `/run/steering/acks.ndjson` | in-box engine, `localSteeringInbox.ack` local fs, `"a+"` 0600 + newline guard + `chmodSync` (`attach.ts:710-762`) | host `readAck` → `ACK_READ_SCRIPT` `tail -c 524288` over exec (`attach.ts:291-295, 367-400`) |
| `/run/steering/acks.lock` | in-box engine only (`attach.ts:632-656`) | — |

Both legs cross the machine boundary exactly once, in opposite directions, and neither changes shape.
`attach-acked` is returned solely on the host observing the box's ack line (`attach.ts:531-532`) — the
AC2 wording R2 wrote for the transport design survives word for word.

### 2.2 Dedupe seed becomes trivially correct

`readSteeringAckedIds` (`pipeline-run.ts:155-191`) reads `acksPath()` locally; in-box that resolves to
the same file the host polls, so R3 landmine 11 ("dedupe silently halves") cannot occur. Its docstring
claim *"the log is append-only and host-WIDE — one file shared by every run on the host"* becomes
false and must be corrected to per-box/per-run. The 512 KiB tail window then effectively never
truncates.

### 2.3 One run per box — verified, and what it buys

`dispatch` provisions a box per run (`provisionAdmittedRun`, `driver.ts`); fan-out calls `dispatch`
once per arm with its own minted `runId` (`fanout-primitive.ts:585-587`), and the record carries one
`vmName` (`run-record.ts:124`). So the per-box channel carries exactly one run's traffic. Consequences:
cross-run message theft (round-10 S1's motivation) is structurally out of reach; the read caps stop
being load-bearing; and the ack log's growth is bounded by one run's attaches. **Keep the filter
anyway** (S1 says never off, and it costs nothing) — but rewrite its rationale, and re-point the risk
at starvation (N1).

### 2.4 The double-delivery hole is unchanged — and one flag from closable

A retry after exit 6 mints a fresh `messageId` (`attach.ts:446`, warned at `:487` and
`scripts/fleet.ts:3642`), so the consumer's dedupe cannot see it and the guidance folds twice. In-box
locality does not touch this: the id is minted host-side. Two honest positions for the writer:

- **Inherit it** (R2's posture). It becomes *rarer* — a real consumer means exit 6 stops being the
  default outcome — but strictly more consequential, because a double-folded message is now really
  delivered twice instead of zero times.
- **Close it for one line**: `AttachOptions.messageId` already exists and `attachToRun` already honours
  it (`attach.ts:136, 446`); the CLI simply never passes one (`scripts/fleet.ts:3537`). A
  `--message-id` flag makes an operator retry idempotent. Small, but it is scope the story must claim
  deliberately, and it adds a CLI surface + validation (must be a plain token, must not collide).

Recommendation: inherit, and say so in one sentence with the `--message-id` seam named as the known
upgrade path. Do not invent host-side retry bookkeeping.

### 2.5 Exit-3 / unreachable semantics (AT1s) after the move

Unchanged, and still correct: attach appends *before* it polls, so `inbox.ndjson` exists whenever the
ack read runs, and exit 3 keeps meaning "the channel vanished under us" rather than "healthy empty"
(R3 landmine 16). Post-reboot this is self-healing for **new** messages: `APPEND_SCRIPT`'s `mkdir -p`
+ `cat` recreate the file inside a directory `tmpfiles.d` has already restored.

---

## 3. Channel lifecycle (#180)

### 3.1 Measured premise

`/run` is `tmpfs` (`size=1625112k`, mode 755) and a real reboot leaves `/run/steering` **GONE**
(probe phases `filesystems`, `reboot-persistence`). `$HOME` on `/dev/vda` ext4 survives; enabled
systemd units re-run at boot; detached `nohup` processes do not survive. `sudo -n` is passwordless.

### 3.2 Recommended fix: write the `tmpfiles.d` drop-in at birth, bake it in the image later

The ADR names `/etc/tmpfiles.d/qds-steering.conf` (`d /run/steering 0700 exedev exedev`) baked into the
DF2.10 image. That works, but it makes DF1.11 **hard-depend on the image story**. The cheaper shape,
available today: extend the existing fixed literal `STEERING_PROVISION_SCRIPT` (`driver.ts:87-92`) with
one more `&&` clause that writes the same drop-in via `sudo -n tee`, ids resolved **on the box**
(`$(id -un)`/`$(id -gn)`), no host interpolation — the discipline the docblock at `:76-79` already
demands. `/etc` is on ext4, so the drop-in survives every reboot and `systemd-tmpfiles-setup` recreates
the directory before services start.

Properties: idempotent (same content every time); no new driver surface (C25); same failure taxonomy
(C26); DF2.10 can later bake the identical file and the runtime write becomes a no-op. **Recommend
this as primary, with the image bake as DF2.10 follow-through** — it decouples the two stories and
still satisfies #180 declaratively.

### 3.3 Keep `provisionSteeringChannel`, do not retire it

It is create-only, idempotent, and *verifies after provisioning* (`test -w`, `stat -c %a = 700`,
`driver.ts:87-92`). Post-image it becomes the tripwire that catches an image regression — the cheapest
possible contract check on DF2.10's output, at zero diff. Keep it private, keep it on both `create`
success arms (`driver.ts:275, 284`), and update its docblock (`driver.ts:58-79`) — it currently forward-
references "the (DF1.10) in-box engine" as a future thing.

### 3.4 Reboot mid-run: the honest contract

State it plainly in the story, because the shipped CLI currently says the opposite:

1. `/run/steering` is wiped: inbox, acks and lock die **together** (N3), so the restarted engine sees an
   empty queue and an empty dedupe set — consistent, no re-fold, no re-ack.
2. `tmpfiles.d` recreates the directory at boot, 0700, exec-user owned; the engine unit restarts and
   the channel is live again without any code running.
3. **Messages queued but not yet folded are lost.** Nothing re-sends them. An attach that returned
   `attach-not-acked/no-ack` ("the message IS queued in the box") before a reboot has become false; an
   attach that returned `attach-acked` is unaffected (the fold already happened).
4. Therefore, after a reboot a re-send is *correct*, not a double-delivery — the operator has no way to
   tell the two situations apart from the CLI today. The boot-id trace row (C23) is what makes the
   distinction recoverable at harvest time; live, the honest remediation is "check `fleet status` /
   the box's uptime before deciding".
5. The alternative — moving the channel to persistent `$HOME` — would make the queue survive and #180
   vanish, but it changes the default root on **both** legs, needs `QDS_STEERING_ROOT` visible in the
   ssh session as well as the unit (N2), and re-opens exactly the split-brain `attach.ts:39-53`
   documents. Not worth it for a loss window bounded by one reboot. Record it as the considered
   alternative with that reason.

### 3.5 Telemetry (where the counters go)

`ResidentTelemetry` and the journal `resident` block are closed key sets (`journal.ts:87-97`;
`steering.ts:231-233, 264-268`) — do not widen them. Available surfaces, in ascending cost:
the driver's `emit()` JSONL stream (`driver.ts:221-233`, already carries `steering_provision`), the
runner's trace sidecar `type:"log"` rows (precedent `steeringInboxError` / `residentTripwire`,
`pipeline-run.ts:1841-1872`), and `fleet status` (no steering fields today — `src/fleet/status.ts` has
zero `steering` hits; `approvalRowFields` `:595` is the only extension surface). Recommendation: one
boot-id/uptime trace row at engine startup (C23), nothing on `fleet status`.

---

## 4. Live e2e inversion

### 4.1 `tests/fleet/e2e/tier1-attach-transport.live.test.ts`

| Site | Today | After |
|---|---|---|
| `:24-39` header "THE HONEST NO-ACK" | prose: no in-box engine exists | rewrite: the in-box engine is the consumer; `attach-acked` is the PASS shape |
| `:107` test name | "…honest no-ack (exit 6)…" | "…attach-acked (exit 0)…" |
| `:148-149`, `:193` comments | "no ack on this box", "NO acks file" | acks file exists and carries the messageId |
| `:164`, `:166`, `:172-173`, `:176` | exit 6 · `attach-not-acked` · envelope `reason:"no-ack"` · gate event `outcome:"attach-not-acked", reason:"no-ack"` | exit 0 · `attach-acked` · **no error envelope at all** · gate event `outcome:"attach-acked"` with **no `reason`** (`scripts/fleet.ts:3566-3585` emits `reason` only on not-acked) |
| `:200-210` retry/double-delivery step | second attach also exit 6; two inbox lines, no acks | second attach exit 0; two inbox lines, **two acks** — the double-delivery proof gets *stronger* (the guidance really lands twice) |
| `:227-235` at-ceiling (4 000-char) attach | exit 6 | exit 0, folded **truncated** and acked (round-10 S4; fold budget `ATTACH_FOLD_CHAR_BUDGET` 8 000 / floor 256, `steering.ts:51,63`) |
| `:258` over-ceiling | exit 2 | unchanged |

**Cost inversion to decide:** tier1 is zero-spend today precisely because nothing acks. An ack now
requires a live in-box engine with steering armed — and steering exists only when a resident is armed
(`pipeline-run.ts:1783-1786`: no resident ⇒ no `createSteering` ⇒ no drain ⇒ no ack), so `--no-resident`
or an empty brief cannot produce an ack. The drain does run *before* the caller (`steering.ts:815-846`),
so an ack can precede any model call, but the solicitation that follows will normally spend. Measured
reference: one real pi solicitation cost **$0.000025 / 2.17 s** (probe `pi-stall-recheck`).
Recommendation: let tier1 spend that, assert a real ack, and say so in the header — do not engineer a
degradation path to keep the zero-spend label.

### 4.2 `tests/fleet/e2e/tier5-gate-steering.live.test.ts`

`:18-28` header, `:378-380` step comment, `:391` exit 6→0, `:393` outcome, `:396` envelope assertion
(deleted), `:406-408` "No acks file can exist" → the acks file carries the messageId. `:628-634`
post-approval refusal (exit 5) is unchanged.

Bigger point: tier5's engine leg today is a **hand-rolled in-box pi invocation** (`:311-350`) standing
in for an engine that could not run in-box. After DF1.10 that scaffolding is replaced by the real
in-box engine, which is a genuine no-fakes improvement — call it out in the story rather than letting
the hand-rolled block survive as dead weight. `tests/fleet/e2e/tier4-resident.live.test.ts:19` carries
the same placement caveat and needs the same treatment.

### 4.3 What a full attach → fold → ack live test needs

Preconditions (all owned by DF1.10/DF2.10, so this AC is dependency-gated): a box from the owned image
with bun + the engine unit; the engine started with the record's `runId` (N1); a live phase in progress.
Then: `fleet attach` → line verbatim in `/run/steering/inbox.ndjson` (already proven live today) → the
next solicitation folds it into `promptContext` (`steering.ts:745-756`) → ack line in
`/run/steering/acks.ndjson` → host `attach-acked`, exit 0, `dispatchRequestId` echoed. Evidence per the
`qds-live-e2e` skill; the fold itself is provable from the harvested trace/journal, not only from the
ack (an ack proves consumption, never application — C18).

### 4.4 Non-live sites that flip with them

- `tests/fleet/gate-verbs.test.ts:1392-1393` — asserts the remediation contains `"no in-box executor
  exists yet"` and `"DF1.10"`. **This is the loud failure that forces the prose fix.**
- `scripts/fleet.ts:3667-3673` — the `no-ack` remediation text (must become: the engine is running but
  did not ack — check the run is live, the fold budget, and whether the box rebooted; see N5).
- `scripts/pipeline-run-remote.ts:18-20` (HONEST LABEL) and `:118-120` (no executor registered for
  non-`code` kinds) — the forward references #181 retires; the story must decide whether the remote
  shim stays at all.
- `src/providers/exedev/driver.ts:63` docblock — "the (DF1.10) in-box engine".
- `src/fleet/attach.ts:39-53` (LOCAL CALLERS ONLY) — still correct, but the rationale now describes two
  environments on one box (N2), not two machines.
- `tests/fleet/attach.test.ts` (24 tests, all FakeDriver on one host filesystem) — **no change needed**,
  and that is the point: the coincidence it relies on (both legs share a filesystem) is what in-box
  placement makes true in production. Say so, instead of deleting coverage.

---

## 5. Inherited invariants to restate

- **INV-APPROVE-1..9** (`df3-4 :295-340`) — all survive untouched; DF1.11 changes no line of
  `approval-gate.ts`/`approvers.ts` (C30). The load-bearing touchpoint is INV-APPROVE-5 (steering
  carries no privilege) and the drain-before-gate ordering (`steering.ts:815-846`): the drain
  deliberately runs before the resident status gate and keeps draining while the resident is degraded
  (`telemetry.status` is a one-way latch — three writers at `steering.ts:866, 888, 905`, nothing writes
  `"active"` back). Any AC that assumes "the channel stops when the resident degrades" is wrong.
  INV-APPROVE-6 (credential containment at pause) is *strengthened*: the gate still tears the box down
  before `awaiting-approval`, and attach still refuses every approval state (`attach.ts:436-444`).
- **INV-RES-1..5** (`df3-3 :223-245`) — INV-RES-1 (no agent-initiated channel into the engine) is
  preserved precisely by keeping the engine's inbox a local-fs port with no driver reference (C2).
  **INV-RES-3 stops being violated in substance**: the resident/engine run on the box against the
  single per-run capped key already present at `$HOME/app/.env` (ADR `:97-100`), instead of the current
  host process with a second key. INV-RES-4/R9 (claims, not proof) restated per C18.
- **DF3.6 bounds** — the three bounds and `checkBounds(point)` (`steering.ts:339`) are untouched (C28).
- **Round-10 de-facto invariants**: AT1s survives verbatim (§2.5); AT2s (zero ceiling = one look),
  AT8s (ack ENOENT no-op), S4 (over-ceiling folds truncated + acked), R3 (hollow-bundle refusal) all
  survive unchanged; **AT3s** survives but its mechanism simplifies (C16 — keep the existing lock, add
  no box-side primitive); **S1** survives as policy with an inverted risk (C15/N1); **S2** survives with
  the co-location caveat (C14/N3); **P2** survives and now also covers the `tmpfiles.d` write (C26).
  Deviation 4 (exec, not `copyFile`) survives for the host leg; **Deviation 12 is what this story
  closes**.
- **Ceilings unchanged**: 30 s ack ceiling, 500 ms poll, 10 s per-call, 3 unusable ticks, 1 MiB inbox
  tail, 512 KiB acks tail, 4 000-char attach ceiling, 8 000-char fold budget, 5 s per inbox call,
  60 s drain pass (`attach.ts:91-110, 266, 313`; `steering.ts:21-84`).
- **Envelope**: `{messageId, requestId, runId, message, sentAt}` unchanged (C3).

---

## 6. Fleet-side changes: none of substance — verified

`attachToRun` and its whole host leg need **zero** functional change: it already writes and polls the
box's files, so the arrival of an in-box consumer is transparent to it. Specifically verified: refusal
gates (`attach.ts:436-444`), messageId minting (`:446`), post-sanitize ceiling (`:460-469`), append
(`:493-505`), poll loop and streak caps (`:517-564`), the no-ack truthfulness guard (`:576`), and the
CLI exit table `[0,1,2,4,5,6]` (`src/fleet/verbs.ts:264-307`) all stand. What changes on the fleet side
is **text**: the `no-ack` remediation (`scripts/fleet.ts:3667-3673`) and the docblocks in §4.3. The
status verb gains nothing (§3.5). If the writer wants `--message-id` (§2.4) that is the only new fleet
surface, and it is optional.

---

## 7. Decisions the writer must make (with a recommendation each)

1. **`tmpfiles.d` at birth vs baked in the image** → do both, birth-write first (§3.2); it removes the
   hard dependency on DF2.10.
2. **Reboot loss: accept or move the channel to `$HOME`** → accept + document (N5, §3.4).
3. **C19 ack-provenance** → satisfy from the harvested journal or re-defer explicitly; do not build a
   live cross-machine counter.
4. **Double delivery** → inherit; name `--message-id` as the known upgrade path (§2.4).
5. **tier1 zero-spend label** → give it up for a real ack at ~$0.000025 (§4.1).
6. **Who owns the launcher's runId contract (N1)** → DF1.11 states it as a clause + AC even if DF1.10
   implements it; it is the one new way this design silently loses every message.
7. **Story title** → "steering executor" is now accurate only if DF1.10 (engine placement) is a stated
   dependency; the executor *is* the engine. Make the dependency explicit rather than re-litigating
   R2 §5.3's naming drift.
8. **sprint-status.yaml** still has no row for any arc story (R2 §5.8 gap stands, verified today) —
   add DF1.11 with deps DF2.1, DF3.3, DF3.4, DF3.6, DF1.10 (engine placement) and DF2.10 (image,
   soft), referencing #180/#181.
