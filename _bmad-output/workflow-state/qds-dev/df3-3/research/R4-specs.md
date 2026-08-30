# R4 — Spec/Architecture Constraints for DF3.3 (Resident Orchestrator Agent)

Sources read in full (cited below as):
- **[STORY]** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-3-resident-orchestrator-agent.md` (primary spec, incl. 2026-08-20 hardening revision)
- **[ARCH]** `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`
- **[DD]** `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
- **[GATES]** `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md`
- **[R5]** `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md` §6 (the binding fact register — 20 numbered facts)
- **[VERDICT-B]** `_bmad-output/workflow-state/qds-sprint-planning/df3-hardening/verdicts/verify-b-df33-36.md` (DF3.3+DF3.6 pair verification, 2026-08-20)
- **[TRACKER]** `_bmad-output/sprint-artifacts/dark-factory-v5/df3-post-hardening-review-tracker-2026-08-20.md`

**Verdict status: all pre-dev review findings closed** — [TRACKER] status line: RESOLVED, 16/16 DONE, Wave 5 converged 0 BLOCKER/HIGH/MEDIUM; [VERDICT-B:190] "Stories are ready for development." DF3.3-specific residual notes are prose-only (DF3.3-V-L1, no action).

---

## A. Solicitation architecture (containment)

1. **MUST solicit at exactly three engine-owned points:** (1) run start, after manifest validated+frozen; (2) post-gate-failure, only *after* DF1.2 computed the verdict *and* DF1.3 authorized attempt N+1; (3) run end, after `finish(accepted)`. [STORY Tech Notes :150-156; VERDICT-B:44-56]
2. **NEVER a fourth solicitation point** — not from DF3.3, not from DF3.4's `attach` (operator messages queue and deliver as prompt context at the next of the three). DOD: "the diff contains no fourth call site." [STORY :150-156, :248; TRACKER:124]
3. **NEVER consult the agent before a decision it could corrupt** — every solicitation happens after the deterministic decision is already made. [STORY :26-28, :150-156]
4. **MUST be engine-initiated calls** (`solicit()` library call from engine code); the agent never calls the engine. [STORY Trigger Surface :109; INV-RES-1]
5. **Point 2 supplies guidance text only** — the directive never supplies the retry decision (DF1.3 owns it). Point 3 is report text only. [STORY :152-156]

## B. Directive contract (closed union)

6. **MUST implement exactly this union** (the only new contract in the story):
   `SteeringDirective = { action:"proceed" } | { action:"retry", guidance } | { action:"select_roster", phase, rosterId } | { action:"abort", reason }`, each with optional `note`. [STORY :128-131]
7. **MUST parse with a `.strict()` zod object** (DF1.1 INV-2 discipline). Unknown fields and unknown actions are **rejections, not warnings**. [STORY :130-131, INV-RES-2]
8. **MUST reject out-of-union actions** (`skip_gate`, `reorder_phases`, `set_status`, `extend_budget`, any unknown field): schema rejects, engine proceeds with deterministic default, and a `residentTripwire` row records `cause:"gate_bypass_attempt"` with the rejected action name. [STORY AC2 :77-81]
9. **Accepted directives have engine-defined effects only:** `abort` → engine's own `fail` transition; `select_roster` → pick from DF1.5's closed id set (id outside set = rejected directive, not a fresh spawn); `retry` → guidance text consumed on an engine-authorized retry. [STORY AC1 :64-67, :157-160]
10. **Asymmetry is normative:** `abort` is the only destructive verb and no directive can move a run toward green; no directive sets a phase status, reorders `phases[]`, or satisfies a gate. [STORY :63-67, :157-160]
11. **A rejected directive has exactly one effect: a telemetry row.** [INV-RES-2 :229-231]

## C. Fail-closed / degradation (R3 discipline)

12. **MUST degrade to `resident.status:"degraded"` on:** unreachable process, solicitation timeout, or two consecutive unparseable replies — run continues fully deterministic; no hang, **no third reparse**, no retry of the underlying phase, no gate skipped. [STORY AC3 :83-88]
13. **NEVER execute a parsed-unchecked directive** — the engine never parses-and-executes an unvalidated reply; an uncommunicative resident is treated as absent. [STORY :86-88, :196-198]
14. **At most one reparse of a malformed reply, then degrade.** [STORY :184]
15. **Empty/absent brief ⇒ resident never spawned, `status:"disabled"`, run completes normally** — explicit non-error path. [STORY AC4 :89-91]
16. **Every degradation path lands on the engine's deterministic default** — degradation is always *less* agent influence: never a skipped gate, a shortened phase, or a raised budget. [INV-RES-5 :241-244]
17. **Deviation is recorded (sync resident):** resident holds no state the engine cannot reconstruct from the journal; a resident dying mid-run degrades rather than invalidating the run. No second channel for a future async resident. [STORY :193-195]

## D. Journal telemetry & the closed DF2.1 record

18. **`resident.status` closed set:** `"active" | "degraded" | "disabled" | "stopped"`. **NEVER write `"stopped"` from this story's code paths** — DF3.6's bound enforcement alone writes it. [STORY AC5 :92-94]
19. **Journal `resident` block MUST carry:** `spendMicros` (engine-metered, integer µ$), per-phase `steeringIterations`, `directivesRejected`, `exitStatus` (CC-1 enum value describing how the resident process ended; DF3.6's watchdog alone writes `"overflow"` into it), and any `residentTripwire` rows. [STORY AC5 :96-100]
20. **`directives` is a COUNT, not an array** (E2E shape: `directives: 3`). [STORY :42-43]
21. **NEVER add any field to DF2.1's twelve-field closed run record**; its `spendMicroUsd` remains the run total. [STORY AC5 :101-102]
22. **NEVER emit any ratio, percentage, or share-of-run-total field** in the resident journal block or telemetry (R5 §6 fact 12; schema-scan test enforces zero such fields). [STORY AC5 :101-102, DOD :256]
23. **`residentTripwire` rows, exactly three causes,** shape `{ runId, requestId, cause, phase, detail }`: `spend_ceiling_breach` (raised only by DF3.6's absolute ceiling, **never by a ratio**), `gate_bypass_attempt` (this story's, AC2), `watchdog_kill` (DF3.6's, carries `cause` so "killed twice for the same cause" is computable). This story records; evaluation is operator activity. [STORY :187-192]

## E. Cost: integer µ$, naming rule, rate source

24. **Cost unit is integer micro-dollars (µ$)** everywhere; no numeric literal carried across the old cents unit. [DD-9 :86]
25. **µ$ naming rule (binding across DF3.3/DF3.6):** `*MicroUsd` suffix = **persisted** fields (DF2.1 run record, DF2.3 key metadata); `*Micros` suffix = **in-memory/journal** engine-owned values. Explicit one-way mapping: `runRecord.spendMicroUsd :=` run total (DF2.5 writes), `journal.resident.spendMicros :=` engine-metered resident subtotal, `residentSpendCeilingMicros :=` manifest bound (DF3.6's), `runKeyCapMicros := runRecord.limitMicroUsd` (read-only). **NEVER treat the suffixes as synonyms or rename one into the other implicitly.** [STORY :175-181; VERDICT-B:83-95]
26. **Rate source is DF1.5's models.json only:** reads `inputPerMTok`/`outputPerMTok` (integer µ$ per million tokens) — **this story reads those two keys only**, not the cache keys. Every consumer divides by `1e6` at projection. One rate source, DF1.5's key names, no second table. [STORY :119, :164-170]
27. **NEVER quote a rate into code.** The default slug `deepseek-v4-flash-0731` ($0.08/$0.18/MTok, cache read 0.2× — R5 §6 fact 9) is provenance for the *default*, not the runtime source. [STORY :161-170; R5 fact 9 :446-450]
28. **Spend is metered engine-side:** the engine sums the provider's reported usage per reply; the agent never reports its own. (Independent of team-lead-driver's final-turn overwrite, R5 fact 7.) [STORY :171-174]
29. **Bounds are NOT this story's:** iteration cap, RSS cap, absolute spend ceiling are DF3.6's, engine-enforced — do not implement or restate them. DF2.8 budget cap is contract-cited only, "implementation pending" per R5 disposition. [STORY :52-55, :184-186, DOD :251]

## F. Per-call guards

30. **Solicitation prompt ≤ 16,000 characters *including* its truncation suffix** — reserve the suffix width before cutting (DF1.2's rule form). [STORY :182-183]
31. **`maxOutputTokens` = 1,024.** [STORY :183]
32. **Solicitation timeout = 60,000 ms.** [STORY :184]
33. These per-call ceilings are the inputs to DF3.6's worst-case cost projection — changing them breaks the pair contract. [STORY :185-186; VERDICT-B:38]

## G. Security invariants (INV-RES-1..5)

34. **INV-RES-1 (structural no-gate-authority):** the resident holds no reference to a gate, the journal writer, the frozen manifest, or the phase constructor; its only egress is one validated `SteeringDirective` returned from an engine-initiated call. A design where the agent *calls* the engine (tool surface, MCP server, writable control file) violates this however permissioned. Enforced as a module boundary: fleet imports the engine barrel, **never the reverse** (`src/fleet/resident.ts` agent; `src/phase-engine/steering.ts` port). [STORY :147-149, :223-228]
35. **INV-RES-2:** validation strictly precedes effect — parse against `.strict()` schema before any engine state is touched. [STORY :229-231]
36. **INV-RES-3 (credential containment):** resident runs in-box against the single per-run spend-capped revocation-verified key; never the provisioning key, never a push credential (R5 fact 17). **Brief carries no credential material:** a value matching `sk-`, `ghp_`, `Bearer `, `-----BEGIN`, or a field named `key`/`token`/`secret`/`password` refuses the run (DF1.1 INV-4), naming the field, never the value. [STORY :232-236; R5 fact 17 :487-488; ARCH §6.2 :379-381]
37. **INV-RES-4 (claims not proof):** resident report/guidance is agent-authored in-box evidence — recorded, never verification, never able to satisfy a gate or authorize a PR. Host-side re-verify (DF5.1) is the only thing that does. [STORY :237-240; R5 fact 15 :482-484; ARCH §6.6 :395-398]
38. **INV-RES-5:** fail-closed toward determinism (see C above). [STORY :241-244]

## H. Observability contract

39. **Every solicitation logs** `{ requestId, runId, phase, point, model, durationMs, directiveAction, accepted, spendMicros }`. [STORY :202]
40. **`requestId` propagates unchanged** from DF3.1 dispatch through the brief onto every resident log line and telemetry row; errors include `{ code, message, stack? }`. [STORY :203-204; ARCH §5.2 :349-350; R5 fact 5 :426-428]
41. **Every rendered prompt and raw reply persists pre-execution**, redacted through `cli-anything/src/redact.ts:62`. [STORY :205; ARCH §5.2 :350; R5 fact 5 :427]
42. **Sub-timings:** `prompt_render_ms`, `agent_call_ms`, `directive_parse_ms`; a point never reached reports `0`; where a breakdown is unavailable, `durationMs` is authoritative. [STORY :206-207]

## I. Cross-story boundaries (add-only seams)

43. **`src/phase-engine/steering.ts` three-way authorship:** DF3.3 authors the file (port + three points); DF3.4 rebases adding only `attach` drain/ack; DF3.6 rebases last wrapping call sites in `checkBounds(point)`. Successors add only — **never edit a DF3.3-owned line**; conversely DF3.3 must not pre-build DF3.4's inbox or DF3.6's bounds. [STORY :136-141; VERDICT-B:44-56]
44. **`scripts/pipeline-run.ts`:** DF1.8 lands first (run correlation); DF3.3 rebases adding only resident spawn/telemetry hooks around DF1.1's engine call. Actual flags: `--manifest`, `--journal`, `--run-id`, `--repo-slug`, `--issue` — **plus `--no-resident`, which THIS story adds** (the AC1a control leg; DF3.3-M1 fixed the phantom-flag drift by declaring it here). [STORY :142-146, AC1a :69-70; TRACKER:154, :199-201]
45. **NEVER re-declare the brief schema** — consume DF3.1's closed `src/fleet/brief-schema.ts` (validated at ingress); no second schema. [STORY :131-133, DOD :250]
46. **NEVER re-declare `exitStatus`** — import from `cli-anything/src/types.ts:94-185` (CC-1). [STORY :134-135, DOD :250; TRACKER:170]
47. **Manifest fields:** DF3.1 owns `limitMicroUsd`; DF3.6 owns `residentSpendCeilingMicros`/`maxSteeringIterations`/`residentRssBytes`. DF3.3 adds **no** manifest field. [VERDICT-B:60-79]
48. **Dependencies (all merged):** DF1.1, DF1.5, DF1.6, DF2.2, DF3.1. Unknown resident slug or unresolvable rate refuses the run **before spawn** (DF1.5's rule, consumed, never re-derived). [STORY :57-58, :118-119]
49. **Provider must be OpenRouter** for the default (direct-Anthropic blocked on this host; R5 fact 4 — no AC/code path may require direct-Anthropic routing). [STORY :118; R5 fact 4 :417-419; GATES §4.6 :249-250]

## J. Mandated tests (DOD)

50. **AC1a proceed-only equivalence:** all-proceed resident run vs `--no-resident` control ⇒ journals **byte-identical** once `resident.*` and timing fields excluded. [STORY :69-70, DOD :253]
51. **AC1b steered-run invariants:** real directives ⇒ same phase order as control, every gate verdict computed by DF1.2 from real evidence, no status promoted the same evidence would not promote. **NEVER assert byte-identity of a steered run.** Negative control: an implementation letting a directive set status/reorder/satisfy a gate MUST fail this test. [STORY :71-76, DOD :254]
52. **Degradation fail-closed test:** killed mid-run, timeout, and two consecutive malformed replies each ⇒ `status:"degraded"`, completed run, zero skipped gates; unparseable replies never executed. [STORY DOD :255]
53. **Telemetry boundary test:** journal contains `spendMicros`, `steeringIterations`, `directivesRejected`, CC-1-parsing `exitStatus`; schema scan finds zero ratio/percentage/share fields and zero fields added to DF2.1's closed run record. [STORY DOD :256]
54. **E2E demo (MANDATORY):** `tests/phase-engine/fixtures/pipeline.resident.json` via `bun scripts/pipeline-run.ts --manifest <fixture> --journal out.json` — gate failure steered to pass on attempt 2, `resident.steeringIterations.build == 1`, AC1b invariants vs `--no-resident` control; `out.json` is the artifact. [STORY :33-45, DOD :257]
55. **Atomicity:** ≤200 normative lines, DOD ≤10, Files to Modify ≤9 (currently 9). [STORY :278; DD §6 :104-105]

## K. Binding facts restated (R5 §6 — "an AC that contradicts one of these is a defect")

- **Fact 4 (:417-419):** Anthropic OAuth expired on this host (~2026-02-25); **OpenRouter is the working path today**; no AC may require direct-Anthropic routing without an explicit unblock step.
- **Fact 9 (:446-450):** OpenRouter `deepseek-v4-flash-0731` $0.08/$0.18 per MTok, **cache read 0.2×** (not Anthropic's 0.1×).
- **Fact 12 (:462-464):** D4's 15%-of-run-total tripwire is a **ratio trap**, re-specced as an absolute per-run spend ceiling (F12). "**Never write the 15% ratio into an AC.**" (Also GATES §3.3 :211-217: all-cheap roster trips at N=2 steering turns while frontier tolerates 65; DD §5 row 4 :69 encodes the re-spec in DF3.6.)
- **Fact 15 (:482-484):** nothing produced inside a box is trusted at the boundary — in-box trace/gate evidence is **claims, not proof**; no story may open a PR on in-box evidence alone.
- **Fact 17 (:487-488):** no push credential in any box; exactly one secret per box — a spend-capped, per-run, revocation-verified LLM key.

## Background doctrine (why, not new constraints)

- D4 [ARCH :301]: tier 2 = resident agent operating a deterministic TS phase engine; cheap-model default; F7 demotion tripwires evaluated after month-1 run data — any gate bypass/reorder audit finding demotes tier 2 to code-only dispatch. R3 [ARCH :482] is the risk register entry.
- F12 [ARCH §5.2 :346-348]: the resident is itself watched — max steering iterations per phase, RSS cap, spend ceiling below the run key's cap — enforced by the phase engine, not the agent.
- ARCH §5.3 (:353-364): resident receives brief; failures re-enter the same session bounded times; host-side re-verify before PR.
- ARCH §6.5 (:392-394): blast-radius honesty — "No claim of containment we can't enforce in code" (INV-RES-1's structural, not procedural, form).
- DD-8 [:85]: NET-NEW contracts (like `SteeringDirective`) are authored fresh, cited to design §5.2 — not inherited under "survives verbatim."

## Five easiest to get wrong (implementer's shortlist)

1. **`directives` is a count, not an array** — and `spendMicros` vs `spendMicroUsd` naming is load-bearing (journal/engine = `*Micros`; persisted run record = `*MicroUsd`). [C19/E25]
2. **The 16,000-char prompt cap includes the truncation suffix** — the suffix width must be reserved before cutting, not appended after a 16,000-char cut. [F30]
3. **Exactly one reparse** (two malformed attempts total), then degrade — a retry loop of three-plus, or re-running the underlying phase on resident failure, violates AC3. [C12/C14]
4. **This story never writes `status:"stopped"` or `exitStatus:"overflow"`** — those are DF3.6-only writes into fields DF3.3 declares; symmetrical trap: DF3.3 must not add manifest bound fields either. [D18/I47]
5. **Byte-identity only in the proceed-only leg** — asserting it of a steered run is a spec violation; the steered leg asserts order/evidence/no-unearned-promotion invariants instead. [J50/J51]
