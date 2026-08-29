# DF3.4 — Acceptance Audit (PR #150)

Spec: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md`
Scope: source diffs only (`chunk-fleet-core`, `chunk-fleet-attach`, `chunk-engine`, `chunk-cli`).
Deviations recorded in the story's Dev Agent Record (1–9) and the Scope-Enforcement waiver were
checked and are NOT reported here.

---

### [BLOCKER] Teardown-at-pause is never wired: no shipped path captures spend, revokes the key, or destroys the box before the gate becomes decidable

**Violates:** AC1(b) — "teardown then runs: `teardownSandbox(runId, { noHarvest: true })` (DF2.5 …), then `revokeAndVerify(keyHash)` (DF2.3) — spend captured, key revoked and revocation-verified, box destroyed per INV-APPROVE-6"; INV-APPROVE-6 — "no run is **decidable** while it still holds a live credential … then spend is captured via `captureSpend`, the run key revoked via `revokeAndVerify`, and the box destroyed via `teardownSandbox`; only after all three does the extension become `awaiting-approval`"; DoD *Integration* — "teardown invoked as `teardownSandbox(runId, { noHarvest: true })` (DF2.5) + `revokeAndVerify(keyHash)` (DF2.3) after extension registration".

**Evidence:**
- `chunk-fleet-core.diff:236` — `src/fleet/approval-gate.ts` — `teardown?: (runId, opts) => Promise<void>` is **optional**.
- `chunk-fleet-core.diff:401` — `src/fleet/approval-gate.ts` — `await deps.teardown?.(runId, { noHarvest: true });` — optional-chained, so an absent seam is a no-op, then `:405-408` promotes to `awaiting-approval` unconditionally.
- `chunk-engine.diff:556` — `src/reverify/approval.ts` — `recordApprovalPort(store, opts: Omit<GateDeps,"store"> = {})`; the default is `{}`.
- `src/reverify/runner.ts:406` (repo, unchanged by this PR) — the only production construction: `recordApprovalPort(deps.store ?? new RunRecordStore({ dir: runsDir }))` — no `opts`, therefore no `teardown`.
- Repo-wide `grep -rn "teardown:" src/ scripts/ tests/` returns **zero** GateDeps call sites. `scripts/reverify.ts` is the sole entry point to `reverify()` and orders nothing relative to teardown.

**Gap:** The spec makes teardown the middle of a three-step order and INV-APPROVE-6 makes it a security invariant — the decidable state must never coexist with a live key or a live box. As shipped, `requestApproval` registers `pausing` and promotes straight to `awaiting-approval` with no teardown, no `captureSpend`, and no revoke in any production path; the ordering exists only for an injected double. The gate's own partial guard (`chunk-fleet-core.diff:392-397`) refuses only the `vmName && !keyHash` case — a run with a box **and** a live key pauses and becomes decidable with both still alive. `src/reverify/approval.ts`'s claim that the reverify runner's "box is already gone by the time a host-side verdict is green" is asserted, not enforced by any code in this PR. Deviation 2 covers only the *redundant* `revokeAndVerify` call and Deviation 3 only the `teardownSandbox` signature; neither documents teardown being unwired.

---

### [HIGH] No resume path for a `pausing` extension — a crash mid-teardown leaves a run permanently stuck

**Violates:** AC1(c) — "A `pausing` extension found at startup is resumed by re-running teardown (idempotent under DF2.5), then promoting"; AC1(a2) — "`pausing` ⇒ … DF3.4's own resume path is what completes the promotion"; AC3 — "an extension in `pausing` is **not** decidable and is resumed per AC1 (teardown re-run via `teardownSandbox`, then promoted)".

**Evidence:**
- `chunk-fleet-core.diff:327` — `src/fleet/approval-gate.ts` — `if (state === "pausing") return { outcome: "pause-in-progress" };` — returns before any write; no teardown re-run, no promotion.
- `chunk-fleet-core.diff:405-408` — the only promotion is inside the *same* `requestApproval` call that registered the pause; a process killed before it never runs again.
- `chunk-cli.diff:208-222` — `scripts/fleet.ts` — `approve`/`reject` refuse `pausing` with exit 5 and the remediation "re-run once `fleet status` reports awaiting-approval". Nothing in the PR ever makes `fleet status` report that.
- `chunk-fleet-core.diff:270-272` — `expiredState` returns `pausing` unchanged: "`pausing` does not expire".

**Gap:** AC1's whole negative control is that a crash between (a) and (c) must be **recoverable**; the spec names the recovery mechanism explicitly. The code implements the "not decidable" half and none of the "resumed" half. A `pausing` extension is therefore not decidable, not promotable (a second `requestApproval` short-circuits), and not expirable — permanently stuck, which is the state AC1 exists to prevent. Not listed in the Dev Agent Record's nine deviations.

---

### [MEDIUM] AC1(a2)'s bundle re-validation is opt-in and off in every shipped construction

**Violates:** AC1(a2) — "The rebind call **also carries the new report's `bundlePath`**, and it is validated against the extension's existing `bundlePath` before the replace commits … unequal ⇒ the rebind is refused as a schema/consistency rejection".

**Evidence:**
- `chunk-fleet-core.diff:239-244` — `src/fleet/approval-gate.ts` — `bundleDir?: string` is optional; "Absent ⇒ no bundle claim to check."
- `chunk-fleet-core.diff:334` — the rebind check is guarded: `if (deps.bundleDir !== undefined && !existsSync(join(deps.bundleDir, \`${runId}.bundle\`)))`.
- `chunk-engine.diff:556` + `src/reverify/runner.ts:406` — the only production `recordApprovalPort` call passes no opts, so `bundleDir` is `undefined`.

**Gap:** Deviation 8 documents replacing the (vacuous) path comparison with an existence check and states the replacement flatly — "Rebind re-validates by `existsSync(...)`". It does not document the check being conditional. As shipped, no production rebind validates the bundle at all, so the AC1(a2) consistency refusal can never fire outside tests. The substitution is documented; its optionality is not.

---

### [MEDIUM] AC5's attach refusal is implemented as a best-effort race, documented only in a source comment

**Violates:** AC5 — "given a run in `pausing` or `awaiting-approval` (box gone or going), Then attach is refused `run-not-attachable`, extension unmutated."

**Evidence:** `chunk-fleet-attach.diff:186-196` and `:204-208` — `src/fleet/attach.ts` — "THAT CHECK IS A FAST REFUSAL, NOT AN INVARIANT. The state is read below and the append fires further down under no lock, while the approval gate mutates that same state under `withApprovalLock` — so a run entering `pausing` inside that window gets a message appended to a box that is being torn down. AC5 reads as an invariant and is not one. Left as a race deliberately".

**Gap:** The code states outright that it does not implement AC5 as written. The reasoning may well be right (the loss is one steering message; no state is corrupted and the extension is genuinely untouched), but the Dev Agent Record's deviations table has nine entries and none of them is this one — it is an undocumented deviation from an acceptance criterion, discoverable only by reading the module.

---

### [MEDIUM] Observability contract: the `pause` event is never emitted, and two of the four declared sub-timings do not exist

**Violates:** Observability Contract — "Every gate event logs `{ requestId, runId, event, state, approverId?, durationMs, outcome }` — `event ∈ pause | approve | reject | timeout | refused | attach`"; "Sub-timings: `teardown_at_pause_ms`, `record_write_ms`, `decision_wait_ms`, `attach_rtt_ms`."

**Evidence:**
- `chunk-cli.diff:83` — `scripts/fleet.ts` — `gateEvent` declares the literal union including `"pause"`, but no call site in the PR passes `"pause"` (call sites: `:165` refused, `:181` timeout, `:205`/`:221` refused, `:242` approve/reject, `:253` refused, `:308`/`:347` attach).
- `chunk-fleet-core.diff` (whole file) — `src/fleet/approval-gate.ts` imports no logger and emits no event; `requestApproval` is silent.
- Emitted timings are `decision_wait_ms` (`chunk-cli.diff:246`), `attach_rtt_ms` (`:311`) and an undeclared `expiry_sweep_ms` (`:181`). `teardown_at_pause_ms` and `record_write_ms` appear nowhere.

**Gap:** The pause — the one gate event the story's E2E slice is built around — produces no structured line, and DF5.3 is specified to join approvals on `requestId` across every gate event. Two named sub-timings are absent. (`teardown_at_pause_ms` is unmeasurable given the BLOCKER above; `record_write_ms` has no such excuse.)

---

### [LOW] Expiry is not evaluated on every `fleet` invocation

**Violates:** Technical Notes / Guards & limits — "expiry is evaluated lazily on every `fleet` invocation — no daemon — and **before** that invocation's own decision".

**Evidence:** `chunk-cli.diff:180` — `scripts/fleet.ts` — `sweepExpired` is called only in the `approve`/`reject` block. `chunk-fleet-attach.diff:366-388` — `status.ts`'s `approvalRowFields` derives expiry read-only. No other verb (`harvest`, `teardown`, `dispatch`, `attach`, …) evaluates it.

**Gap:** Deviation 9 documents the status-vs-decision split (virtual derive in `status`, persisted write in `approve`/`reject`) and that split is sound. It does not cover "every `fleet` invocation": the remaining verbs neither derive nor persist expiry. Behaviourally harmless today — the only consumers are `status` and the decision path — but it is a literal departure from the stated rule.

---

### [LOW] `src/fleet/index.ts` listed in Files to Modify but unchanged; the new modules are not exported from it

**Violates:** Files to Modify — "`src/fleet/index.ts`".

**Evidence:** No `src/fleet/index.ts` hunk in any source chunk; `grep -n "approval-gate\|approvers\|attach" src/fleet/index.ts` returns nothing.

**Gap:** `scripts/fleet.ts` imports `approval-gate.ts` / `approvers.ts` / `attach.ts` by path (`chunk-cli.diff:12-14`), so nothing is broken — but the barrel that the story names as the story's public surface does not re-export the gate, and a consumer following the Files list finds nothing there.

---

### [LOW] Truncation suffix does not match the spec's literal string

**Violates:** Guards/limits — "`proposal` caps at 8_000 chars **including** any `[truncated, N chars total]` suffix".

**Evidence:** `chunk-fleet-core.diff:252` — `src/fleet/approval-gate.ts` — ``const suffix = `…[truncated, ${text.length} chars total]`;`` — a leading U+2026 the spec does not declare.

**Gap:** The cap itself is correct (the suffix is counted inside `max`, `:255`). Only the literal marker differs, so any consumer matching the spec's string exactly will miss it. No behavioural effect.

---

### [LOW] Refusal events log a hardcoded `state: "awaiting-approval"` regardless of the run's actual state

**Violates:** Observability Contract — "Every gate event logs `{ requestId, runId, event, state, approverId?, durationMs, outcome }`".

**Evidence:** `chunk-cli.diff:165` — `scripts/fleet.ts` — `gateEvent("refused", runIdArg, { outcome: auth.refusal.code, state: "awaiting-approval" })`, emitted on the authentication-refusal path before any state has been read for this purpose (the run may be `pausing`, terminal, or carry no approval extension at all).

**Gap:** The `state` field is contract-declared; on the AC4 refusal path it reports a state the run may not be in. The other refusal arms (`:205`, `:221`) do pass the real state.

---

## AC coverage

| AC | Met? | Note |
|----|------|------|
| AC1(a) — register `pausing` first, `reportId`/`headSha` required, allow-listed extension patch | yes | `bundlePath` omission is Deviation 8 (documented) |
| AC1(a2) — rebind / refuse / leave alone, `supersededReportIds`, CAS vs terminal | partial | bundle re-validation is opt-in and off in production |
| AC1(b) — `teardownSandbox` + revoke at pause | **no** | no shipped caller wires `teardown`; INV-APPROVE-6 unenforced |
| AC1(c) — promote only after teardown; `pausing` resume | partial | promotion in-call is correct; resume path absent |
| AC2 — authenticated decision, first-decision-wins | yes | |
| AC3 — survives restart; `timed-out` + `system:timeout`; terminal | partial | timeout/restart correct; the "resumed per AC1" clause is unimplemented and `pausing` never expires |
| AC4 — allowlist auth, fail-closed, 0600, no state change, security-event log | yes | dir-mode check is additive hardening |
| AC5 — attach refused while `pausing`/`awaiting-approval` | partial | implemented as a race by design; undocumented deviation |
| AC6 — real transport, stdin-only payload, drain at the three points, dedupe, 30 s not-acked | yes | ack via `exec`+`cat` = Deviation 4; drain-time ack = Deviation 5 |
| AC7 — `fleet status` lists paused runs with state / `reportId` / time remaining, never `boxMissing` | yes | derived (not persisted) expiry = Deviation 9 |
| INV-APPROVE-1 no bypass/auto-resume | yes | |
| INV-APPROVE-2/3 hashed allowlist, fail-closed | yes | |
| INV-APPROVE-4 attribution append-only | yes | |
| INV-APPROVE-5 steering carries no privilege | yes | drained text enters `promptContext` only, never `parseReply` |
| INV-APPROVE-6 credential containment at pause | **no** | see BLOCKER |
| INV-APPROVE-7 `assertNoSecret` parity | yes | arrays now walked (`chunk-engine.diff:285-288`) |
| INV-APPROVE-8 fail-closed reads | yes | |
| INV-APPROVE-9 `fs.writeSync` on exit paths | yes | verified: `scripts/fleet.ts:3084-3098` emit path uses `writeSync` |
