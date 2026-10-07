# Edge Case Hunter — M1.2 round 2 (diff at `_bmad-output/reviews/m1-2-round2/diff.patch`, final state)

Round-1 findings F1–F22 were re-walked in their fixed form; the findings below are only NEW unhandled edges, most of them gaps the round-1 fixes themselves introduced.

- **[MEDIUM] F11 fixed `emittedRunId` only — the failure-path twin `recoverDispatchIds` still takes the FIRST minted-grammar match over the raw streams, so the `kg-recall` line's `runId` hijacks ownership arming on exactly the path the twin exists for.** `tests/fleet/e2e/live-harness.ts:343-346` runs `MINTED_RUN_ID_RE.exec(combined)` over stdout+stderr with no `operation:"kg-recall"` skip (the fix landed at `tests/fleet/e2e/live-harness.ts:387-405` in `emittedRunId` alone). The seam's line fires during `ingestBriefJson` — before provisioning, before any refusal envelope — and its `runId` is the brief's raw requestId, which `SAFE_RUN_ID` (`src/hindsight/kg-context.ts:241`) admits in a `qds-YYYYMMDD-hex6` shape while `resolveBriefRequestId` (`src/fleet/dispatch.ts:567-570`) demands strict UUID v4 and drops it, minting a fresh id. Trigger: a live-tier dispatch whose brief carries a minted-shaped `requestId`, and the verb fails after ingest (timeout/refusal) → L2's catch arms `round.runId` from `recoverDispatchIds` (`tests/fleet/e2e/memory-cycle.live.test.ts:551-553`) with the seam's id → `teardownQuietly`/`fleetLeftovers` target a nonexistent run, the real run's box falls out of the owned set and is classified as another round's stray. Consequence: the round-1 F5 leak class survives on the failure path despite the triage's "root fix … improves all consumers" claim. Guard sketch: apply the same per-line `operation !== "kg-recall"` skip (or scan from the last match) in `recoverDispatchIds`.

- **[MEDIUM] `buildKgContextXml` can return a ZERO-observation block while the row/log report `directive:"kg_context"` and non-empty `recalledDocumentIds` — the ceiling's drop-whole loop has no post-assembly floor.** `src/hindsight/kg-context.ts:225` skips any observation whose XML line does not fit (`continue`), and `primeDispatchBrief` branches on `fan.observations.length` (`src/hindsight/kg-context.ts:368-374`), never on the assembled `lines.length`. Recall content is unbounded on the wire (`text: z.string().optional()`, `src/hindsight/schemas.ts:~155`), so a bank holding only over-ceiling observations (~7,570+ chars after wrapping vs the ~430 fixed head/tail cost) yields `head + tail` with no `<observation>` elements. Trigger: any dispatch whose repo + collective banks recall exclusively over-ceiling facts. Consequence: the resident receives `CITATION_INSTRUCTION` with nothing to cite; the side-channel row records a grounded cycle (`primed:true, directive:"kg_context", chars>0`) whose `recalledDocumentIds` name documents that never reached the block — M1.3's hit-rate input is skewed and AC2's directive vocabulary lies in the (c)/(d) direction. Guard sketch: after assembly, `if (lines.length === 0) → emit ladder (c)` (EMPTY_KG_DIRECTIVE / "empty"), or derive `recalledDocumentIds` from the INCLUDED observations only.

- **[LOW] Fan-out observations are not deduped across banks — the same fact id (or the same document mirrored into `qds-collective`) produces duplicate `<observation id="X">` lines.** `src/hindsight/kg-context.ts:149-158` flatMaps both banks' results with only the `CITABLE_ID` filter; `recallFanOut` dedups BANKS (`src/hindsight/kg-context.ts:123`) but not observations, and `buildKgContextXml` does not dedup by id or documentId. Trigger: an observation retained to both the repo bank and `qds-collective`, or two banks whose server-minted fact ids collide. Consequence: `[cite:X]` is ambiguous between two contents and the 8,000-char budget is double-spent on one fact. Guard sketch: dedup by `id` (first-seen wins — repo bank is first in the set order) before ranking.

- **[LOW] The box-side drop of a non-well-formed `kgContext` (F2's new arm) is silent — no log line, no marker, nothing distinguishes a tampered witness from an unprimed dispatch.** `scripts/pipeline-run.ts:1631-1633` drops the value when `kgContextIsWellFormed` fails, with no emission of any kind (every sibling line in the function is plain context text; the story's observability contract covers the host legs only). Trigger: a run phase (the workload-writable threat the re-check exists for) rewrites `run-context.json`'s `kgContext` between dispatch and render. Consequence: the resident proceeds unprimed and the guard's firing is unobservable — an operator debugging "why wasn't this run grounded" has no trace that the predicate refused. Guard sketch: emit one stderr/log line (`kg_context dropped: non-well-formed`) on the drop arm before returning.

- **[LOW] F7's "same redaction posture both twins" missed the third emitter: `retainRunOutcome`'s receipt-refusal line passes the throwable's message raw and un-stringified.** `src/hindsight/run-retain.ts:234-235` — `message: (e as Error).message` with no `String()`/`redactSecrets`/slice, while both best-effort twins do `redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200)` (`scripts/fleet.ts:~6144`, `src/fleet/run-completion.ts:~4795`). Trigger: the audit store throws a non-Error (message → `undefined`, dropped from the line) or an Error whose message carries a credential-shaped/path-bearing string. Consequence: an unredacted store error lands in the host log, and a non-Error refusal is logged with no message at all. Guard sketch: `message: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200)`.

- **[LOW] F6's refusal check is explicit-false-only: `success:true` with `items_count:0` parses as a fabricated "created" success although nothing landed.** `src/hindsight/client.ts:327` refuses only `success === false`; `RetainWireSchema` (`src/hindsight/schemas.ts:161`) accepts `items_count: 0`, and the transform pins `status:"created"` unconditionally. Trigger: a 0.10.0 response that accepts the request but stores zero items (content filtered / async indexing refusal shaped as success). Consequence: `retainRunOutcome` emits the `memory-retain` ok line and writes the audit receipt for a document the bank does not hold; the idempotency ledger now vouches for nothing. Guard sketch: treat `success === true && items_count === 0` as a refusal (502) alongside the explicit-false arm.

- **[LOW] L2 pushes the seeded bank into `banksWeCreated` AFTER `createBank` resolves — a create that times out after the server created the bank strands it outside the cleanup set.** `tests/fleet/e2e/memory-cycle.live.test.ts:536-537` — `await mem.createBank(repoBankId)` then `round.banksWeCreated.push(repoBankId)`; L1 pushes BEFORE creating (`:788-789`). Trigger: `createBank` exceeds its 30 s ceiling after the server-side create landed (the round-1 F4 scenario applied to the create call). Consequence: L3's finally iterates `banksWeCreated` without the stranded bank → a resolver-fresh repo-named bank persists, and every later round's `resolveRepoBankId` resolves past it to a NEW suffixed bank, accumulating one orphan bank per occurrence. Guard sketch: push the id before `await createBank` (L1's discipline), so a timed-out create is still deleted.

```json
[
  {
    "location": "tests/fleet/e2e/live-harness.ts:343-346",
    "trigger_condition": "failing live dispatch; brief requestId matches qds-YYYYMMDD-hex6",
    "guard_snippet": "if ((JSON.parse(line) as {operation?:unknown}).operation === \"kg-recall\") continue;",
    "potential_consequence": "round.runId armed with the seam's id; real box left billing as a stray"
  },
  {
    "location": "src/hindsight/kg-context.ts:225,368-374",
    "trigger_condition": "every recalled observation's XML line exceeds the 8000-char budget",
    "guard_snippet": "if (lines.length === 0) return emitAndReturn(true, \"empty\", EMPTY_KG_DIRECTIVE, []);",
    "potential_consequence": "kg_context directive with an empty block; recalledDocumentIds name undelivered documents"
  },
  {
    "location": "src/hindsight/kg-context.ts:149-158",
    "trigger_condition": "same fact id or mirrored document recalled from both banks",
    "guard_snippet": "const seen = new Set<string>(); .filter(r => CITABLE_ID.test(r.memoryId) && !seen.has(r.memoryId) && seen.add(r.memoryId))",
    "potential_consequence": "duplicate observation lines; [cite:X] ambiguous; budget double-spent"
  },
  {
    "location": "scripts/pipeline-run.ts:1631-1633",
    "trigger_condition": "run phase rewrites run-context.json kgContext to a non-well-formed value",
    "guard_snippet": "else if (typeof kgContext === \"string\") process.stderr.write(\"kg_context dropped: non-well-formed\\n\");",
    "potential_consequence": "resident silently unprimed; guard firing unobservable"
  },
  {
    "location": "src/hindsight/run-retain.ts:234-235",
    "trigger_condition": "audit store throws a non-Error or a message carrying secrets",
    "guard_snippet": "message: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200)",
    "potential_consequence": "unredacted store error in logs; non-Error refusal logged messageless"
  },
  {
    "location": "src/hindsight/client.ts:327",
    "trigger_condition": "2xx body success:true with items_count:0",
    "guard_snippet": "if ((raw as {items_count?:unknown}).items_count === 0) throw new HindsightHttpError(502, \"retain stored zero items\", requestId);",
    "potential_consequence": "receipt vouches for a document the bank does not hold"
  },
  {
    "location": "tests/fleet/e2e/memory-cycle.live.test.ts:536-537",
    "trigger_condition": "createBank exceeds its 30s ceiling after the server created the bank",
    "guard_snippet": "round.banksWeCreated.push(repoBankId); await mem.createBank(repoBankId);",
    "potential_consequence": "stranded repo-named bank; later rounds accumulate suffixed orphans"
  }
]
