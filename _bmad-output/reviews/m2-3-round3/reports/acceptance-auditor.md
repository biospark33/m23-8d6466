# M2.3 Acceptance Auditor — Round 3 (confirmation)

Scope: `/tmp/m23-review/full-r3.diff` (~1934 lines, read fully) against the story spec
`_bmad-output/sprint-artifacts/dark-factory-v6/stories/m2-3-combined-memory-live-round.md` (read fully).
Every mechanism below was verified against the repo, not comments. Round-2 dispositioned 12 findings
(11 patched, 1 dismissed) — all 11 patches are present in this diff and were re-verified individually
(§3), including one that does NOT do what it claims (F3-1).

**Mechanical checks run this round:** `bun test tests/scripts/memory-negative-probes.test.ts` → 6 pass / 0 fail;
`bun test tests/fleet/e2e/memory-combined.live.test.ts` (gates unset) → loads clean, 5 todo / 0 pass / 0 fail
(header claim "unset, every leg is todoIf-off and touches nothing" verified);
`requiredBudgetMs()` computed against the round's manifest → 741,000 ms.

---

## 1. Final AC / invariant coverage verdict

| Item | Verdict | Evidence (file:line, mechanism) |
|---|---|---|
| **AC1** full cycle, one round, one box | **COVERED** (pending the live fire itself) | One file, sequential in-file tests sharing `RoundState` (`tests/fleet/e2e/memory-combined.live.test.ts:324-399`); L2/L3 refuse hollow legs when L1 didn't reach dispatch (:714-716, :924-926). Env list matches the story exactly: `SUBSTRATE_ENV` = `QDS_EXEDEV_REPO_URL/SHA/ROSTER`, `OPENROUTER_PROVISIONING_KEY` presence-checked (`live-harness.ts:57-62`, thrown by `liveGate` :71-86); `MEMGATE_ADMIN_KEY`/`QDS_MEMGATE_SIGNING_KEY`/`QDS_MEMGATE_LEDGER`/`QDS_KG_GATEWAY_URL` by `requireMemoryGateEnv` (:265-276); `HINDSIGHT_*` by `requireMemoryEnv` (:279-288). Three leg evidence JSONs written unconditionally in `finally` (:723-736, :929-940, :1134-1145); a refused scrub becomes a problem line → round fails, so a missing leg JSON cannot pass. |
| **AC2** primed dispatch + degrade ladder | **COVERED** | Primed limb: side-channel row asserts `primed===true`, `directive==="kg_context"`, `banks` contains the probe bank, `recalledDocumentIds.length>0`, `chars>0` (:755-764) — the row is written by the same `primeDispatchBrief` call that appends the appendix (`src/hindsight/kg-context.ts:321-432`). Degrade limb (LD leg, :304-352): `HindsightClient({baseUrl:"http://127.0.0.1:1"})` (connection refused, transport-class) → `primed === brief` (same reference), no `kgContext`, row `primed:false`, `directive:"none"` — exactly ladder (b) (`kg-context.ts:12`, `:437`), never `empty` (:424 is the zero-observations branch only). Both AC2 negative-control shapes are structurally enforced: a dispatch that throws on unreachable fails LD (no try/catch around `primeDispatchBrief`); an `EMPTY_KG_DIRECTIVE` on transport failure fails the `directive==="none"` assert. Residual (minor): the appendix text in the on-box brief is not directly asserted — the row is M1.2's landed observability seam for exactly this fact, and this is the accepted seam. |
| **AC3** in-box recall + DD-16-only box env | **COVERED** (with documented observability caveat) | Box-env forensics pre-destroy, box alive (:630-644): `KEY_ENV_FILE` ("app/.env", `src/providers/credentials.ts:100`) fetched via `fetchBoxFile`, memory-family names filtered by `MEMORY_ENV_NAME`, `foreign` must be `[]` AND both DD-16 names present (:643-644) — names only, values never lifted. Ceiling: not host-asserted — correct per story Technical Notes ("KG_RECALL_CHAR_CEILING is IN-BOX ONLY… no host-side ceiling exists"); `kg_recall.truncated` recorded-as-observed (:683, :826). Hygiene: `rawControlChars` checked by code point (:421-425), judged at :688. Call+latency observability: PRIMARY = trace `worker_output` payloads (:712-757, tracer writes them at `src/phase-engine/phases/dispatch-task.ts:817-822`); host-side `latencyMs` rides the L1 row (`RecallRow.latencyMs`, `kg-context.ts:113`); `serverDurationMs: null` / clientMs-absent-on-success recorded with rationale (:692-696) — matches the story's own contract ("absent, not 0") and the filed stderr gap. Caveat is disclosed in-evidence, not hidden. |
| **AC4** revoke-verify before destroy | **COVERED** | `expect(memSkip).toBeNull(); expect(memRevoke).toBe(true); expect(memVerify).toBe(true)` against `'"event":"memgate-revoke"'` / `'"event":"memgate-verify-revoked"'` stderr lines (:846-860), under `QDS_LOG_VERBOSE=1` unmute (log muting verified: `src/swarmclaw/log.ts` `logMuted()` = `NODE_ENV==="test" && !QDS_LOG_VERBOSE`). Ordering from the round's OWN audit rows: `revokeAt < verifyAt < destroyAt` (:871-883) — `AuditLinkRow.hop/event/occurredAt` verified (`src/audit/link-store.ts:104-118`). Verify evidence (timestamps via `rowOrder`) lands in the teardown leg JSON. AC4 negative control (skip-revoke must fail): a skip emits `memgate-skip` and no revoke line → both asserts fail. Structurally enforced; no fault-injection demo exists, which the AC does not require (it requires the round's own assertion to catch it — it does). |
| **AC5** five-probe battery | **COVERED** | Battery in the L3 `finally` on EVERY exit path (:960-989) — a battery that cannot run pushes a problem line, and `settleRun` throws on problems (`live-harness.ts:1711-1743`), so "a probe that cannot run is a FAILED round" holds. `allRefused` demands `refused && reason === EXPECTED_REASONS[probe]` per probe (`scripts/e2e/memory-negative-probes.ts` :1518-1520 of diff; `EXPECTED_REASONS` = no-auth/scope-bank/scope-bank/expired/revoked), reason classified strictly inside the closed 8-member set (`MEMGATE_REFUSAL_REASONS`, `src/memgate/schemas.ts:69-73`; mirrored in the extension's standalone client). no-auth-200 flips to `refused:false` → round fails — proven mechanically by the unit negative control (200 → `allRefused:false`, test file :1828-1836 of diff) and the in-set-code classifier (:1387-1390 of diff). Probe keys driver-minted via `mintRunMemoryKey` (lib, in-process), never the run's key. Battery evidence includes ttl fields and cleanup results. Unit suite 6/6 pass this round. |
| **AC6** live hygiene | **COVERED** | Worst-case spend printed pre-fire twice (L0 :439-446, FIRING banner :656-659); cleanup backstops guarded on individually-armed ids in `finally` (:1063-1096: quiet teardown, quiet destroy, per-bank delete, `keyLeakProblems`); evidence scrub = `scrubDeep` (key regexes + provisioning-key + repo-URL userinfo) → `secretHitsIn` + `mgrun-` gate that THROWS on survivors (:332-348), with the quietly-variant for `finally` callers (:351-364). `payloads are exitCode/stdoutTail/stderrTail house style` — observed throughout. |
| **AC7** digest-stable audit rows | **COVERED** | Exactly one `memory-retain-receipt`/`retain` row after harvest AND after re-harvest, `subjectId === runId` (:756-780); re-harvest stderr asserted free of `divergent` under `QDS_LOG_VERBOSE=1` unmute (:779-781) — the log-only alarm is otherwise invisible to the walk, and the unmute closes the vacuous-pass hole round 2 flagged. Volatile fields: `recallQuery` + `marker` must appear in NO row; `memgate` must appear in NO row (:897-915) — the gateway's key-lifecycle events are named `memgate-*` (`src/memgate/gateway.ts:259-276`), so the substring scan catches exactly the frozen-posture violation INV-M3-4 forbids. Counts revoke/verify-revoked = 1. |
| **INV-M3-1** fleet is the entry path | **COVERED** | The run goes through `runFleet(["dispatch", …])` with a validated brief (:663-678); `ack.state === "ready"` (:695), run id grammar `MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/` matches dispatch's own (`src/fleet/dispatch.ts:129`). Nothing in the round gates code entry. |
| **INV-M3-2** no-auth retirement | **COVERED** | Probe (a) fires with NO Authorization header (:1454-1458 of diff); `allRefused` requires reason `no-auth` (in-set) AND non-2xx (a 200 yields `refused:false` → round fails, :1372-1375 of diff). Unit control proves the 200 shape fails. |
| **INV-M3-3** revoke-verify-before-destroy | **COVERED** | `expect(destroyAt).toBeGreaterThan(verifyAt)` (:883) plus the memgate line asserts — ordering asserted from the round's own rows, not a comment. |
| **INV-M3-4** frozen audit | **COVERED** | `leaked` (rows containing `memgate` or volatile text) must be `[]` (:915); receipt remains the single memory hop with count 1. No new hop written by the round; `AUDIT_HOPS` untouched (no diff hunk touches `src/audit/`). |
| **INV-M3-5** hygiene invariants | **COVERED** | Print-before-fire (:656-659), env-gated operator round, `finally` cleanup on every path, scrubbed evidence (AC6 row). Operator GO is runbook-procedural by nature. |
| **INV-M3-6** secrets never in argv | **COVERED** (by construction + evidence gate) | Probe keys are in-process lib values → fetch headers, never argv; the run's memory key rides the delivery stdin (`src/fleet/dispatch.ts:2216`); `runFleet` passes env, not argv, for credentials; the evidence scrub gate refuses key material (`mgrun-`, key regexes) at write time. No assert names argv directly, but nothing in the diff puts a token in argv and the write gate is the enforcement point the story names. |

**Bottom line:** 7/7 ACs and 6/6 invariants COVERED at the mechanism level — with one exception that is not
a coverage hole but an over-tight seam that will break honest green rounds: **F3-1**. AC2 carries a minor
residual (appendix-on-box asserted via the landed row seam, not brief text); AC3 carries a disclosed
observability caveat that matches the story's own contract language.

---

## 2. Round-2 patches — do they satisfy their findings without weakening an AC?

| R2 finding | Patch present & verified | Verdict |
|---|---|---|
| manifest budget 900k/960k | `runBudgetMs: 900_000` (:435), `--timeout-ms 960000` (:532). Verified numerically against the real gate: `requiredBudgetMs` = Σ(retries+1)(PARSE_FIX_ATTEMPTS+1)·maxDuration + phases·ROUTING_MARGIN_MS (`src/phase-engine/manifest.ts:1020-1027`, `PARSE_FIX_ATTEMPTS=2` `types.ts:27`, `ROUTING_MARGIN_MS=5_000` `types.ts:38`) → **741,000 ms** for this manifest; 741,000 ≤ 900,000 (`manifest.ts:1121`) and 900,000 ≤ callerBudget 960,000 (`manifest.ts:1126`). No AC weakened. | ✅ satisfied |
| sha-bound roster comparison | Real: staged copy sha256-compared against `git cat-file blob SHA:config/rosters/memory-live.roster.yaml` (:469-473), with fail-closed `cat-file -e` pre-checks for the SHA itself and the fixture at the SHA (:459-468). The R1/R2 tautology (comparing a `copyFileSync` output to itself) is gone; working tree ≡ pinned SHA is now genuinely enforced. Firing today (fixture uncommitted) refuses pre-spend with remediation — correct fail-closed. | ✅ satisfied |
| dual-requirement recall seam | Present (marker + `'"documentId":"m23-prime-'`, :743-754) — but the second limb is **unsatisfiable by honest output**. See F3-1. | ❌ **F3-1** |
| divergent-assert unmute | `QDS_LOG_VERBOSE: "1"` on the re-harvest verb (:916) with the correct rationale; muting verified at `src/swarmclaw/log.ts` (`logMuted()`). The divergent assert (:781) is no longer vacuous. | ✅ satisfied |
| roster-check preflight | Wired (:479-488): exit 1 refuses pre-spend; exit 0 green; exit 2 warns, proceeds, records the verdict in evidence. **Does not weaken an AC** (roster-check is a DoD line, not AC1-7) but **deviates from the DoD letter** — see F3-2. | ⚠️ satisfied-with-deviation |
| key-baseline guard | `hashesBefore.size === 0` → `keyProblems = ["key baseline unavailable … UNMEASURED"]` (:947-951) → rides `settleRun` → **throws**. Fail-closed: an unmeasured leak check fails the round, it does not pass silently. No AC weakened. | ✅ satisfied |
| ttl fields in evidence | `ttlExpiresAtMs`/`ttlFiredAtMs` on the ttl outcome (`memory-negative-probes.ts` ProbeOutcome + push site) and mapped into the round evidence (:975-976 of diff). Clock-skew vs expiry-defect is now separable from evidence. | ✅ satisfied |
| composite rethrows | Both L1 (:739-743) and L2 (:941-947): problems lead, failure rides as `cause`; neither masks the other. | ✅ satisfied |
| unparseable-line flagging | Parser records `unparseable` instead of dropping (:282-290); judge side promotes count>0 to an evidence problem (:698-700). Torn control-channel output now fails the leg. | ✅ satisfied |
| roster writes [] | `defaults.writes: []` (:21) and `fixer.writes: []` (:37) + `tools: ["read","grep","bash","kg_recall"]` explicit allowlist (:40). Schema semantics verified: `writes` is required, `[]` = none, `null` = unrestricted (`src/phase-engine/roster/schema.ts:336-343`); the non-null allowlist is also what keeps pi's `--tools` filter from dropping the extension tool (`schema.ts:351-356`). | ✅ satisfied |
| (12th: dismissed with verified cites) | n/a — out of scope for patch verification; no regression observed. | — |

---

## 3. Findings

### F3-1 — HIGH (round-breaking): the dual-requirement seam's second limb is unreachable in honest output

`tests/fleet/e2e/memory-combined.live.test.ts:743-754` requires the worker's trace `worker_output` reply to
contain BOTH the round marker AND the literal `'"documentId":"m23-prime-'`, on the theory that the
extension "frames each returned memory as a JSON line" whose documentId only real kg_recall output can
carry. That theory is false for the landed surface:

1. The gateway's recall response carries `documentId` as a **sibling field** of the text, never inside it —
   `RecallResponseSchema` transform produces `{memoryId, content, score, documentId}` per result
   (`src/hindsight/schemas.ts:210-215`), and `content` is the retained TEXT (`r.text ?? r.content`, :216).
2. The extension's client lifts **only the text** — `r.text ?? r.content`, dropping every other field
   (`pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/client.ts`, memories construction).
3. `frameAsData` JSON-quotes that text (`sanitize.ts:38-41`): the framed line is
   `[0] "m23 kg recall marker …"` — the marker, never a documentId key.
4. The tool returns only the framed text (`kg-recall.ts` execute → `{content:[{type:"text",text}]}`);
   `details` (bank/resultCount/clientMs) carries no documentId either. The `m23-prime-` prefix exists
   NOWHERE on the box: the retain happens host-side; the side-channel row with `recalledDocumentIds`
   stays in the host workspace.

Consequence: `expect(docIdHits.length).toBeGreaterThan(0)` fails **every honest green round**. The likely
"fix" under fire-time pressure — editing the task prompt so the worker emits the token — is worse: the
worker never received `m23-prime-`, so a compliant worker would have to fabricate it, converting the
echo hole round 2 closed into a fabrication hole. (No `_bmad-output/evidence/memory-live/` files exist
yet, so this has not been disproven by a live run — it is refuted from the landed source chain.)

**Fix (one line):** replace the second limb with a token that exists only in genuine tool output and
nowhere in the task prompt — the `frameAsData` header literal `UNTRUSTED RECALLED DATA (kg_recall)`
(`sanitize.ts:38-39`), or the `[0] "` JSON-quoted-line shape — still required alongside the marker. Both
are produced only by a real successful `kg_recall` (the header is not in the prompt; the index+quote
shape is not in the prompt) and are reachable by a worker quoting returned data verbatim.

This does not weaken any AC — it over-strengthens one to impossibility. Round-2's intent (kill the echo
hole) is right; the chosen token is simply not on any wire the worker sees.

### F3-2 — MEDIUM (DoD-letter deviation, honestly ruled): roster-check exit-2-proceed is not "green before fire"

DoD: *"bun scripts/roster-check.ts --roster config/rosters/memory-live.roster.yaml green on the new
roster file before fire."* `scripts/roster-check.ts:13-15` defines exit 2 as **"a gate could not be
evaluated"** — explicitly not a passing verdict (and "`2` dominates `1`"). The patch
(`memory-combined.live.test.ts:479-488`) proceeds on exit 2 with a stderr warning and an evidence record
(`rosterCheck: "unevaluable on this host (exit N) — pre-fire runbook step stands"`).

Ruled against the DoD text: **this deviates from the letter.** A round that fires on exit 2 fired without
a green roster-check; the evidence row records the non-green verdict, but recording is not the same as
the gate passing. It is not an AC violation (roster-check is a DoD item, not AC1-7), and the patch does
keep the load-bearing half — a **rejected** slug (exit 1) still refuses the round pre-spend, which is the
F097-class protection.

Residual risk worth naming: on a firing host lacking the pi binary / `OPENROUTER_API_KEY`, a genuinely
bad slug is first caught by the in-box gate C model ping — after the box is armed and spend has begun.
That is precisely the pre-flight-gate guarantee F097 exists to provide. Either treat exit 2 as refuse on
the firing host, or amend the DoD line to sanction the recorded-unevaluable path explicitly (the honest
middle: "exit 0, or exit 2 with the verdict recorded and the runbook re-run where gates are evaluable").
Do not let this land as an undocumented weakening.

### F3-3 — LOW: `QDS_EXEDEV_ROSTER` is enforced-present but never consumed by the round

AC1 lists the var and the story's Files-to-Modify prose says the roster is "consumed via
`QDS_EXEDEV_ROSTER`". Implementation: `liveGate` requires its presence (`live-harness.ts:57-62`) and
`preflight` carries `rosterPath` (:258), but the round's roster reality is the staged fixture (pre-billing
gate) + the in-box `spec.roster` load at the pinned SHA — disclosed in the test header and the fixture
comment. Story-text vs implementation drift, disclosed, no AC harmed; worth one line in the story's
re-visit notes if a fourth round opens.

### F3-4 — LOW: pre-fire worst-case spend is printed but not persisted

The Observability Contract names `memory-live.spend` as "worst-case pre-fire + actual". The persisted
phase carries `spendMicroUsd` + `capMicroUsd` only (:894); the worst-case figure lives only on
stdout/stderr (:439-446, :656-659). INV-M3-5 requires the print (satisfied), but the evidence file is not
self-contained on the worst-case half. One-line fix: add the computed worst case to the spend phase.

### Non-findings (checked, clean)

- Budget refusal cannot recur: 741,000 ≤ 900,000 ≤ 960,000 verified against the shipped gate.
- `runFleet` wrapper timeout (1,200,000) > dispatch ceiling (960,000) — the ceiling, not the wrapper,
  fires first.
- `sha256Hex` utf8/string symmetry on both compare sides; git blob → string is lossless for a YAML fixture.
- Battery cleanup: every minted key revoked best-effort in `finally`, ledger closed; unit suite proves
  post-battery revoke returns `already-gone` (6/6 pass, run this round).
- Live file loads with all 5 tests todo-off when `QDS_E2E_LIVE` unset — zero-touch claim verified.
- `settleRun` throws on problems alone (:1741-1742 of `live-harness.ts`), so the UNMEASURED key baseline
  and a battery that cannot run both fail the round.

---

## 4. Remaining uncovered acceptance surface

None beyond F3-1..F3-4. Procedural DoD items that are not code and cannot be covered by this diff:
the live fire itself (story is `in-progress`; `_bmad-output/evidence/memory-live/` is empty), the M1.3
handoff pointer, and `detect_changes` before commit. The re-pin/T2 preconditions remain operator-owned
per the story's Infra Prerequisites (image pin un-set by construction until the ritual fires — the
Dockerfile re-pin hunk in this diff is the shared-image refresh, not the M2.3 ritual).

**Recommendation:** patch F3-1 (one line) and either harden or explicitly amend the DoD letter for
F3-2 before firing; F3-3/F3-4 are one-liners that can ride along. With F3-1 fixed, every AC and
invariant is mechanism-covered and the round is honest to fire.
