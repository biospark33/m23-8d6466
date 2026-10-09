# Edge Case Hunter — M2.3 round 3 (confirmation)

Walked the full r3 diff plus the cited sources: `src/phase-engine/manifest.ts` (requiredBudgetMs), `src/phase-engine/phases/dispatch-task.ts` + `team-event-adapter.ts` + `cli-anything/src/team-events.ts` + `cli-anything/scripts/team-lead-driver.ts` (worker_output chain), `pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/{kg-recall,sanitize,client}.ts`, `src/hindsight/{client,schemas,bank-provisioner,kg-context,run-retain}.ts`, `src/memgate/{gateway,schemas,forward}.ts`, `src/phase-engine/roster/schema.ts` + `scripts/roster-check.ts`, `src/fleet/dispatch.ts` + `verbs.ts`, `src/providers/{credentials,teardown}.ts` + `src/fleet/run-completion.ts` + `scripts/fleet.ts` (retain receipt chain), `src/providers/harvest.ts` (trace/trace.db layout), `src/phase-engine/trace/reader.ts`, and `tests/fleet/e2e/live-harness.ts` (runFleet env merge, settleRun, keyLeakProblems, tmpWorkspace, setEffectiveImage, waitForSettledVerdict, lastJsonLine).

Round-2 fixes re-verified clean (see "Confirmed not findings" below). Two findings remain, both round-blocking on the T2 leg.

---

## FINDING 1 — HIGH — L2's primary-seam docId assertion can never pass; every green round fails at L2 after full spend

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:887-898` (DOC_ID_FRAMING + `expect(docIdHits.length).toBeGreaterThan(0)`)

**Evidence chain (every link verified in source):**

1. The round retains the probe observation with `documentId: "m23-prime-<date>"` as **retain metadata** (test line 565) — the documentId is not part of the observation *text*.
2. The gateway forwards `client.recall(...)` verbatim (`src/memgate/gateway.ts:496`, `:515`), and `HindsightClient.recall` returns the **transformed** shape `{ results: [{ memoryId, content, score, documentId }], durationMs }` (`src/hindsight/client.ts:384-397`; the transform at `src/hindsight/schemas.ts:211-218` keeps `documentId` as a field *beside* `content`).
3. The extension client maps each result to `r.text ?? r.content` and **never reads `documentId`** (`pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/client.ts:107-114` — its local result type is `{ text?: unknown; content?: unknown }`).
4. `frameAsData` JSON-stringifies each memory **string** — `[i] <JSON.stringify(content)>` (`sanitize.ts:38-42`) — so even content-internal quotes would be escaped; it emits no object fields.
5. The worker model therefore sees only `[0] "m23 kg recall marker qds-probe-m23-…: the M2.3 combined-memory live round seeds this observation …"`. The substring `"documentId":"m23-prime-` reaches neither the framed tool output, nor the worker's context, nor its reply. The envelope's `output` is the redacted `JSON.stringify(output)` of the worker's parsed reply (`team-event-adapter.ts:238`), and `summary` is the fixed template `` `Worker ${agentId} output` `` (`team-event-adapter.ts:237`) — dead weight; both asserted substrings can only ever ride `output`, and the docId framing cannot be in it.

**Why it matters:** the comment claims this substring is "proof of recall output, not prompt echo" — the author modeled `frameAsData` as emitting the memory as a JSON *object* with a documentId field. It emits a quoted string of the content text. `markerHits` (the marker is inside the content text) still works, so the leg fails precisely and only on the proof-of-recall half: `expect(docIdHits.length).toBeGreaterThan(0)` throws on a genuinely green round — after the box ran, the worker spent, and the trace harvested. Every M2.3 live firing burns the L1+L2 ceiling and red at the primary seam.

**Fix direction:** assert on a substring the model can actually carry: the framed-line shape (e.g. `[0] "` + the marker prefix, which is extension framing only a real tool result produces — the prompt echo carries the bare marker, never the `[i] JSON-quoted` framing), or thread the documentId into the reachable surface (e.g. have the task instruct quoting the `[cite:…]`/framed line and assert the quoted-line prefix). As written the seam proves nothing because it proves too much.

---

## FINDING 2 — HIGH — the DoD roster-check preflight refuses every round pre-spend (staged tmp path is outside loadRoster's repo-root confinement)

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:623-632`

**Evidence chain:**

1. The spawn is `Bun.spawnSync(["bun", "scripts/roster-check.ts", "--roster", join(rosterDir, "roster.yaml")], { cwd: REPO_ROOT, … })` where `rosterDir = join(round.workspace, "config", "rosters")` and `round.workspace = tmpWorkspace("m23")` = `mkdtempSync(join(tmpdir(), …))` (`live-harness.ts:1746-1748`) — an OS temp dir, **outside the repo root** by construction (that is the staging design: "the repo tree is never written").
2. `roster-check.ts:114` calls `loadRoster(args.roster)` with **no options** — the confinement root defaults to the repo root (`src/phase-engine/roster/schema.ts:413`, `defaultRepoRoot()` at `:399`).
3. `loadRoster` realpaths the roster and refuses anything outside the root: `throw new RosterError([…outside the repo root…], abs)` with the **default code `"roster_invalid"`** (`schema.ts:449-452`; the 3-arg constructor defaults to `"roster_invalid"`, `:109`).
4. `roster-check.ts` maps the code: `return e.code === "roster_unreadable" ? 2 : 1;` (`roster-check.ts:152-155`) → **exit 1**.
5. The test treats exit 1 as a hard rejection: `if (rosterCheck.exitCode === 1) throw new Error("roster-check REJECTED … fix the roster before firing")` → **L1 refuses every round before any spend**. The exit-2 "warn + proceed" arm and the exit-0 arm are unreachable for this staged path.

The path-confinement guard is working as designed; the round feeds it a path it can never accept. The gate can never go green in the firing environment (macOS/`/var/folders/...` tmpdir), so the "DoD roster-check preflight (runbook step, wired)" is dead code that actively blocks the story.

**Fix direction:** point `--roster` at the in-repo fixture `join(REPO_ROOT, ROSTER_FIXTURE_REL)` — the round already asserts the staged copy is byte-identical to the fixture **at the pinned SHA** (lines 613-617), so checking the in-repo file checks the same bytes the gate needs; or have roster-check accept a `--repo-root` plumbed to the workspace. One-line fix, first option.

---

## FINDING 3 — LOW — empty-baseline key guard conflates "provider lists zero keys" with "L1 threw", failing a fully green round with a wrong diagnosis

**File:** `tests/fleet/e2e/memory-combined.live.test.ts:1091-1095`

The guard `if (round.hashesBefore.size === 0) { keyProblems = ["key baseline unavailable — L1 threw before listedKeyHashes; key-leak check UNMEASURED"] }` also fires when `listedKeyHashes()` legitimately returned an **empty set** — an exe.dev account with no pre-existing listed keys at baseline (or all keys removed between rounds). In that case a perfectly green round reaches `settleRun(undefined, […keyProblems…])` and throws "the test body passed but cleanup did not: key baseline unavailable — **L1 threw before listedKeyHashes**", which is false — L1 completed and armed the baseline as genuinely empty. Fail-closed direction is correct (unmeasured must not read clean); the cost is a false red plus a message that sends the operator hunting for an L1 failure that never happened. Cheap fix: capture a sentinel (`hashesBefore: ReadonlySet<string> | undefined`) instead of inferring from `size === 0`.

---

## Confirmed not findings (the flagged round-2 fix areas that verify clean)

- **Budget numbers (900,000 / 960,000):** `requiredBudgetMs = Σ (retries+1) × (PARSE_FIX_ATTEMPTS+1) × maxDurationMs + phases × ROUTING_MARGIN_MS` (`manifest.ts:1022-1027`, `PARSE_FIX_ATTEMPTS=2` at `types.ts:27`, `ROUTING_MARGIN_MS=5_000` at `types.ts:38`). Manifest: 3×1000 + 3×240,000 + 3×1000 + 3×5000 = **741,000** ≤ 900,000 ✓, and `callerBudgetMs` = `ctx.remaining()` of the 960,000 wall clock at manifest-load time (pre-provisioning; `dispatch.ts:1545-1560`) leaves ~60s headroom; 960,000 ≤ `MAX_TIMEOUT_MS` (`dispatch.ts:216`). The R2-001 note (600,000 < 741,000 refused) is arithmetically consistent. The test's inline formula comment matches the code exactly.
- **cat-file blob comparison:** `sha256Hex(text: string)` (`link-store.ts:216-218`, `CryptoHasher.update(string)` = utf8); both sides are utf8 strings — `readFileSync(…, "utf8")` and `Buffer.toString()` (default utf8). Byte-identical files hash identically. Correct.
- **Dual worker_output assert — payload shape:** the trace row's `payload_json` is `JSON.stringify(adapted)` of the `WorkerEnvelope` `{ type:"envelope", kind:"generic", label, status, summary, output? }` (`dispatch-task.ts:815-823`, `team-event-adapter.ts:64-72, 223-240`); after the test's `JSON.parse`, `p.summary`/`p.output` exist as the code reads them. Both asserted substrings ride `p.output` (the worker's parsed reply, serialized). The marker half is reachable (task compliance). Only the docId half is broken — Finding 1.
- **Composite rethrow:** `throw new Error(`${problems…} (also failed: …)`, { cause: failure })` preserves the original on `cause`; L3's `settleRun(failure, problems)` appends problems to the held failure and re-throws the original object (`live-harness.ts:1711-1743`, double-append guarded). Neither path masks the other.
- **Roster `writes: []`:** `pick()` honors any declared key, explicit arrays included (`schema.ts:216-223`); the required-field error text itself prescribes `[]` for no repo writes (`:336-343`); `[]` = "no repo writes" (`:67-68`). The dispatch_task worker needs no writes for the modify-nothing task, `tools` names `kg_recall` so the extension tool survives the `--tools` filter (advisory at `:347-356`, M2.2-proven). No break.
- **roster-check cwd:** `scripts/roster-check.ts` is resolved against `cwd: REPO_ROOT` ✓ (the broken part is only the `--roster` path, Finding 2).
- **Empty-baseline × settleRun ordering:** `keyProblems` reaches `settleRun` on the `ctx !== undefined` arm and is (correctly) omitted on the `ctx === undefined` arm; `keyLeakProblems` never throws and tolerates empty `runIds`/missing store (`live-harness.ts:1668-1693`). Only the message conflation remains (Finding 3).
- **Other seams spot-checked clean:** `runFleet` merges `process.env` with overrides (`:646`) so `QDS_LOG_VERBOSE`/Hindsight env reach the verbs; the retain receipt's `subjectId` is `deriveDocumentId(runId)` = the runId itself (`run-retain.ts:203, 243`, docstring `:5`), matching the L2 assert; the receipt lands from `fleet harvest`'s `retainRunOutcomeBestEffort` arm (`scripts/fleet.ts:6101-6113`) with the probe family still alive (deleted only in L3's finally); audit hop/event names all exist (`run-credential`/`revoke` `credentials.ts:1007`, `verify-revoked` `:1081`, `run-box`/`teardown` `teardown.ts:868-869`, `memory-retain-receipt`/`retain` `run-retain.ts:241-243`); harvest layout `trace/trace.db` confirmed (`harvest.ts:232`); trace reader pagination `{rows, hasMore, cursor}` matches the loop (`reader.ts:224-266`); battery mint grammar (`RUN_ID_PATTERN` accepts `m23-probe-run-*`, `BankIdSchema` accepts the `qds-probe-m23-*` ids), `bankOfPath`/`matchRoute` accept the stub's pathname, `verifyRequest`'s refusal ladder yields exactly the five expected reasons; delivered env file is `KEY=value` lines (no `export` prefix, `credentials.ts:852`), so the AC3 name parse reads the DD-16 pair; `MINTED_RUN_ID_RE` matches `dispatch.ts:129` verbatim; dispatch ack `state: "ready"` exists (`dispatch.ts:4361`); `--no-harvest` exists (`verbs.ts:175`).
