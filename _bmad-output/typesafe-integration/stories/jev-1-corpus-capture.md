# JEV-1: Triage Corpus Capture — Schema, Sidecar Writer Path, Merge/Backfill CLIs

**Story Points:** 3
**Sprint:** TypeSafe (Jev) integration Wave 2 — branch `feature/jev-corpus-capture` → `dev`
**Source of truth:** `_bmad-output/typesafe-integration/handoff.md` (§3.11/§3.12 LOCKED, §7 Wave 0–1, §11 gate resolutions)

## Spec Reference

- Handoff §1 mission (S-A), §3.11 (corpus capture precedes everything), §3.12 (A/B fields defined NOW in the schema), §7 Wave 1, §8 guardrails
- Handoff §11 Wave 0 gate resolutions — **1 (schema shape)** and **3 (capture mechanism)** are the binding decisions for this story
- R1 recon digest (§11): 13 triage ledgers of 14 dirs (+1 stray file); best backfill `pr184/round4-triage.md` (~90%), `pr123/triage.md` + `pr128-r5` (~85%); disposition histogram PATCH 123 / DEFER 41 / DISMISS 32 / DECISION_NEEDED 14 / POST_MERGE_CHANGED 2 / GATE_ACTION 0 (handoff §5's "pr123 = pure prose" is stale — the file is a parseable table; the §11 R1 digest is correct)
- Upstream sibling: **JEV-2** (`jev-2-judgment-core.md`) — Wave 3's observer writes corpus records with `labeler: jev-1.13.0-observer` through the same schema; this story ships the schema and the CLIs it will call

## User Story

As the factory operator,
I want every code-review triage round to emit schema'd, replayable corpus records — and the existing triage ledgers backfilled where honestly parseable,
so that a calibration set for the Jev observer actually exists instead of verdict-only prose that cannot be re-judged.

## Overview

Zero dependencies, zero vendor (handoff §1). Three pieces, one new directory each:

1. **Schema** — a zod record schema in `scripts/corpus/schema.ts` (single source; both CLIs import it).
2. **Forward capture** — the bmad-code-review triage step's final act writes `<workdir>/triage.json` (unified findings + `pr` + `round`) via the step-02 Write-file contract; `scripts/corpus/merge.ts` validates it with the schema and appends JSONL records to `_bmad-output/judgment/corpus/`.
3. **Backfill** — `scripts/corpus/backfill.ts` parses the existing machine-parseable `triage.md` ledgers into the same records, labeled `agreement-with-claude`, with unbackable fields null.

The skill-instruction edit that makes step-03 write `triage.json` is an **out-of-repo dependency owned by steve**: the skill lives at `~/.claude/skills/bmad-code-review/` (step-03-triage.md) and cannot ride a PR from this repo. The repo ships everything else — schema, both CLIs, docs of the expected sidecar shape. The story is done when a hand-authored `triage.json` shaped exactly as the skill instruction prescribes merges cleanly and the backfill yields ≥1 full ledger's worth of records.

## E2E Slice

**Demonstrable behavior:** `bun scripts/corpus/merge.ts --workdir <dir>` on a valid `<dir>/triage.json` writes one JSONL record per finding to `_bmad-output/judgment/corpus/<pr>-r<round>.jsonl`, each validating against the schema with `created_at` stamped by the merge; re-running the same merge appends nothing (idempotent).

**Wiring closed:** On completion of this story, running `merge.ts` against a `triage.json` produced by the skill's prescribed Write produces valid records end-to-end, and `bun scripts/corpus/backfill.ts --dir _bmad-output/workflow-state/code-review` produces ≥1 fully parseable ledger's worth of records (accept `pr184/round4-triage.md` or `pr123/triage.md`) — using only code merged by this story. No stub, no `TODO: wire later`. The skill edit itself is a dependency edge owned by steve, not unfinished wiring inside this story; the schema file + this spec's sidecar example are the contract both sides implement against.

**Dependency edges (predecessors):** None — standalone. (Steve's `~/.claude/skills/bmad-code-review/step-03-triage.md` edit is an external dependency edge; JEV-2's observer is a downstream consumer, not a predecessor.)

## Acceptance Criteria

1. **(make-or-break)** Given a `<workdir>/triage.json` carrying the skill's prescribed shape (unified findings with `finding_id`, `finding_text`, `diff_context_ref`, `label`, `disposition`, optional `rationale`, plus `pr` and `round`), When `merge.ts` runs against it, Then one JSONL record per finding exists under `_bmad-output/judgment/corpus/`, every record parses with the zod schema, `labeler` is stamped, `created_at` is non-null ISO-8601 — **preserved from the sidecar when the skill supplied one, merge-stamped otherwise** (best-available-timestamp-wins) — and of the six reserved A/B fields, `arm` is stamped `"frontier"`, `latency_ms` is preserved from the sidecar finding when the skill recorded one and `null` otherwise, `cost_estimate_usd` is `duration_ms × QDS_FRONTIER_USD_PER_MS` when both the sidecar's optional top-level `duration_ms` and the env rate are present, `null` otherwise, and the remaining three (`cost_exact_usd`, `outcome_confirmed`, `outcome_source`) are present and `null`.
2. Given the same valid `triage.json` merged twice, When the second merge completes, Then the corpus file is byte-identical to after the first (idempotent on `pr + round + finding_id + labeler`), and no duplicate rows exist. Given the same ledger directory backfilled twice, When the second backfill completes, Then the corpus file is likewise unchanged — one idempotence test exists for **each** writer (`merge.ts` and `backfill.ts`).
3. Given a `triage.json` that is malformed, missing a required field, carries a disposition outside the enum, or carries any unknown key, When `validate.ts` (or `merge.ts`) runs, Then it exits non-zero naming the exact field/zod path and writes nothing.
4. Given every entry under `_bmad-output/workflow-state/code-review/`, When `backfill.ts` runs, Then (a) the excluded bot-prose files — `pr135/pr-comment.md`, `pr135/pr-comment-round7.md`, `pr184/HANDOFF-round2.md` — are skipped, (b) raw pre-triage dirs (`df1-10-r6`, `e2e-audit`, `pr185`) are reported unbackable and skipped, and non-directory entries are reported skipped, never read; (c) at least `pr184/round4-triage.md` or `pr123/triage.md` yields ≥ its full row count in records, (d) every backfill record carries `labeler: "agreement-with-claude"` and `created_at` set to the best available timestamp — a **day-granular** date read from a date stated INSIDE the ledger file when the ledger states one, else `null` — never derived from the directory name and never a fabricated intraday time, and (e) fields that cannot be honestly reconstructed (latency, cost, outcomes) are `null`, never guessed; `arm` is stamped `"frontier"` on every backfill record and `labeler` is always stamped with its provenance class — neither is ever null.
5. Given the Jev observer of Wave 3, When it needs to append a record, Then it can `import { TriageRecordSchema, appendRecord } from scripts/corpus/` without re-declaring the schema — the schema is the shared contract, exported, not private to a CLI. The Wave-3 observer lives under `scripts/` (imports `src/judgment/` + `scripts/corpus/` without tripping JEV-2's two-import fence).

## Trigger Surface

| Trigger | Status | E2E Test |
| --- | --- | --- |
| `bun scripts/corpus/validate.ts <triage.json>` — validate a sidecar, exit code only | in-scope | `tests/scripts/corpus/validate.test.ts` |
| `bun scripts/corpus/merge.ts --workdir <dir>` — sidecar → JSONL records | in-scope | `tests/scripts/corpus/merge.test.ts` |
| `bun scripts/corpus/backfill.ts --dir <ledger root>` — historical ledgers → records | in-scope | `tests/scripts/corpus/backfill.test.ts` |
| Skill writes `<workdir>/triage.json` after triage | external dependency edge — steve's file, `~/.claude/skills/bmad-code-review/` | covered by merge test on a fixture shaped exactly as the skill instruction prescribes |
| Wave-3 observer appends `labeler: jev-1.13.0-observer` records | out-of-scope — JEV-3 consumes this story's exported schema/append | — |
| A/B measurement rendering (§3.12 table) | out-of-scope — Wave 4 V2 | — |

## Technical Notes

- **Contract/Schema — `scripts/corpus/schema.ts`, one zod object, exported:**
  - `finding_id: string` (min 1) · `finding_text: string` (min 1, required — the replayable input) · `diff_context_ref: string` (min 1 — a pointer, e.g. `path@sha`/PR+file ref, never an inlined hunk) · `label: string` (min 1) · `disposition: z.enum(["PATCH","DISMISS","DEFER","DECISION_NEEDED","POST_MERGE_CHANGED","GATE_ACTION"])` (5 historical + the widened GATE_ACTION per §11 resolution 1 — LOCKED, do not narrow) · `rationale: string optional` · `labeler: string` (min 1; forward = the triage lead identity, backfill = `"agreement-with-claude"`) · `pr: number | null` · `round: number | null` · `created_at: string ISO-8601 | null` — merge stamps it non-null; backfill fills it per the one backfill timestamp rule stated under **Sidecar vs record** below.
  - Reserved A/B fields (§3.12), all `.nullish().default(null)`, `arm` is stamped `"frontier"` on every record this story writes (sidecar merges and backfill alike — §3.12 requires the stamp so the agreement-with-lead join has a selectable frontier population), and the remaining five are written by this story as `null` except where the sidecar supplies data (forward path only — backfill never reconstructs them): `arm: "frontier" | "jev" | null`, `latency_ms: number | null` (preserved from the sidecar per finding when the skill recorded it), `cost_exact_usd: number | null` (Jev: response `usage` × $0.042/Mtok), `cost_estimate_usd: number | null` (frontier estimate — `duration_ms × QDS_FRONTIER_USD_PER_MS` when that env var is set, else `null`; never presented as metered), `outcome_confirmed: boolean | null`, `outcome_source: string | null`. The frontier rate is steve-calibrated (his API spend); until it is set the field stays honestly `null`. Sidecars persist durably in `<workdir>/triage.json`, so once a rate is named, re-estimating old rounds = delete that round's corpus file and re-merge from the durable sidecar (idempotence keys make this safe).
  - Schema is `.strict()` — an unknown key in a sidecar or record is a validation error, not silently dropped.
- **Sidecar (`triage.json`) vs record:** `schema.ts` also exports `TriageSidecarSchema` (top-level `pr`/`round`/`findings` plus optional `duration_ms`; per-finding required/optional per Appendix A) — merge validates the sidecar with it before projecting records. The sidecar is the skill's in-session Write (unified findings + pr + round; `created_at` and `latency_ms` **optional per finding** — the session knows the triage moment better than merge time; `duration_ms` **optional at top level** — the input to the §3.12 frontier cost estimate). `merge.ts` applies the best-available rule uniformly: preserve a sidecar-supplied `created_at` / `latency_ms` when present, else stamp merge-time for `created_at` and write `null` for `latency_ms`; a top-level `duration_ms` is converted to `cost_estimate_usd` (documented cost model on session duration, §3.12 — labeled `estimate`, never metered), else `null`. `merge.ts` is the only component that stamps `created_at` and `labeler` defaults, so the record schema is the authority and the sidecar is its input projection. **The one backfill timestamp rule:** backfill sets `created_at` to a day-granular date read from a date stated INSIDE the ledger file when the ledger states one, else `null` — never the directory name, never a fabricated intraday time (R1: intraday reconstruction is a guess).
- **Merge idempotence:** records are keyed `(pr, round, finding_id, labeler)`; merge re-reads the existing JSONL and skips already-present keys. Append-only file, one JSON object per line — no rewrite-in-place of prior lines. `merge.ts` exports `appendRecord` (schema-validated append — the Wave-3 observer's entry point). **Both writers** (`merge.ts` and `backfill.ts`) take `scripts/lib/run-lock.ts` around their read-test-append so two cold-path invocations cannot interleave appends (single-writer discipline via the repo's existing lock helper — no bespoke locking).
- **Backfill honesty is the whole point of `labeler`** (§3.11): historical labels were LLM-lead-generated agreements, not ground truth. `labeler` is always the provenance class (forward = lead identity, backfill = `agreement-with-claude`) — it records WHO labelled, not whether the source named one. Never backfill a field the source file does not state; `disposition` uses the historical vocabulary normalized into the enum. **Completeness baseline:** the R1 histogram in Spec Reference is a reference count, not a hard assertion — the completeness check is the parser's OWN per-encoding counts, published in the backfill yield report on the two named ledgers (`pr123`, `pr184/round4`), so a regression in parsing shows up as a count change, not a false failure.
- **Ledger-cell normalization rule:** strip markdown emphasis (`**PATCH**`, `*PATCH*` → `PATCH`) before matching; a trailing annotation in parentheses (`"X (comment)"`) is split — the code maps to the disposition and the annotation lands in `rationale`; a compound cell (`DN→X`, i.e. disposition changed mid-round) maps to the FINAL state (`X`) with the full compound preserved verbatim in `rationale`; any code that does not match a known alias — including bare `N` as seen in `pr128-r5` — is skipped-with-reason in the yield report, never guessed. Alias table: `P/PATCH→PATCH; D/DEFER→DEFER; X/DISMISS→DISMISS; DN/DECISION_NEEDED→DECISION_NEEDED; POST_MERGE_CHANGED→POST_MERGE_CHANGED; anything else → skipped-with-reason (never guessed)`. Fixtures cover each encoding class: pr123 word forms, pr184 letter + bold + compound cells, pr128-r5 `N`.
- **Jev disposition normalization (Wave-3 seam):** the observer's `choice` answer maps into the enum via `{patch→PATCH, dismiss→DISMISS, gate-action→GATE_ACTION}`; the other enum values are unreachable from the jev arm.
- **Exclusion list is data, not a regex guess:** the three bot-prose files are excluded because they are bot-comment transcripts (feedback-run INV-7 prose, never corpus content — handoff §11 R1). A `--include-excluded` flag for forensics is permitted; default excludes.
- **CLI plumbing:** flag parsing + failure exits come from `scripts/lib/cli-args.ts` (`tokenizeArgs`, `parseValueFlags`, `exitWithFailure`) — no bespoke arg parsing.
- **Files touched:** `scripts/corpus/{schema,validate,merge,backfill,index}.ts` (new, flat CLI style matching `scripts/` conventions; `index.ts` is the public barrel — the import surface AC5 names). Export names are pinned exactly once, in the barrel: `TriageRecordSchema`, `TriageSidecarSchema`, `DISPOSITIONS` (the disposition enum), `appendRecord` — CLIs import from `./schema.ts`/`./merge.ts` internally, but everything crossing the module boundary uses these names. `_bmad-output/judgment/corpus/` (output dir, created on demand); `tests/scripts/corpus/{validate,merge,backfill}.test.ts` + fixtures under `tests/scripts/corpus/fixtures/` (including the per-encoding normalization fixtures). No `src/` file is touched. No package.json dependency changes (yaml+zod stay the whole set, §3.3).
- **Cite symbols, never line numbers** (repo rule). Run `detect_changes()` before commit; expected scope = the four new scripts + tests only.
- Tests tee to a log: `bun test tests/scripts/corpus/ > /tmp/qds-test.log 2>&1`.

## Security Invariants

- INV-C1: **No secret ever enters a record or the corpus** — with its enforcement scope stated honestly: the CLIs enforce this at the SHAPE level only. `TYPESAFE_API_KEY` (or any credential material) is not read, accepted, or stored by any of these CLIs, and `.strict()` schema means a secret-bearing unknown KEY cannot ride in on a sidecar — but strict validation blocks unknown keys, not secret CONTENT inside free text. Exclusion of secret material from `finding_text`/`rationale` is the skill edit's contract (Appendix A), and the per-class redaction of JEV-2 applies at Jev egress only, never to the corpus file.
- INV-C2: **Bot prose stays out of the corpus** (INV-7 fence): the three excluded files are skipped by default and a fixture proving the skip exists.
- INV-C3: **Corpus stays in-repo** under `_bmad-output/judgment/corpus/` (already the home of such artifacts, handoff §8); no CLI writes outside that dir except reading ledgers.
- INV-C4: **Backfill never fabricates** — an unbackable field is `null`, and `labeler` names the provenance class honestly (`agreement-with-claude`), never presented as ground truth.

## Definition of Done

- [ ] **Impl:** `scripts/corpus/index.ts` is the public barrel exporting exactly `TriageRecordSchema`, `TriageSidecarSchema`, `DISPOSITIONS`, `appendRecord` (JEV-3 consumes them).
- [ ] **Impl:** `validate.ts`, `merge.ts` (idempotent, stamps `created_at`), `backfill.ts` (exclusions + honesty rules) exit 0/2 with named-field errors, no stack-dump UX.
- [ ] **Contract:** ≥1 forward record and ≥1 backfill record in `_bmad-output/judgment/corpus/` validate against the schema; `arm` stamped `"frontier"`, remaining reserved A/B fields present and null.
- [ ] **Integration:** merge produces a full round's records from a skill-shaped `triage.json` fixture with no manual editing step.
- [ ] **Observability:** backfill prints a per-file yield report (rows parsed / records emitted / skipped-reason) so the ≥1-ledger acceptance is checkable from its stdout.
- [ ] **Honest limitation:** `merge.ts` prints a per-run summary (records written / skipped / duplicate-skipped); the docs state that `finding_text` provenance is the skill edit's contract — merge validates shape, not authorship — and a negative fixture pins that limitation (no bot-prose sniffing at merge time).
- [ ] **Test:** `tests/scripts/corpus/` green in mock-less mode (no env, no network — this story has none) teed to `/tmp/qds-test.log`.
- [ ] **Test (e2e demo — MANDATORY):** merge + backfill run end-to-end against real repo fixtures; the make-or-break observable holds; wiring closed asserted.
- [ ] **Guard:** non-zero exit + zero writes on any invalid input (AC3), and duplicate-free re-merge (AC2).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

## Appendix A — `<workdir>/triage.json` sidecar contract (for the step-03-triage.md skill edit)

Steve-owned edit in `~/.claude/skills/bmad-code-review/step-03-triage.md` (out-of-repo). The skill's final act Writes this exact shape to `<workdir>/triage.json` after the triage verdicts settle; `scripts/corpus/merge.ts` consumes it. Minimal working example — every required field present, `created_at` shown once as the optional field it is:

```json
{
  "pr": 277,
  "round": 4,
  "duration_ms": 541000,
  "findings": [
    {
      "finding_id": "F-003",
      "finding_text": "Token refresh can race a concurrent dispatch: two runs mint a key against the same issue and one is orphaned at revoke.",
      "diff_context_ref": "src/providers/credentials.ts@6f6bff39",
      "label": "BLOCKER",
      "disposition": "PATCH",
      "rationale": "Real defect; fixed in this wave (commit 2ce6e046).",
      "created_at": "2026-09-22T14:03:00Z",
      "latency_ms": 41000
    },
    {
      "finding_id": "F-004",
      "finding_text": "Retry loop re-reads the ledger without re-taking the lock, so a torn write surfaces as a phantom missing row.",
      "diff_context_ref": "scripts/lib/run-lock.ts@6f6bff39",
      "label": "HIGH",
      "disposition": "DEFER"
    }
  ]
}
```

Contract notes for the skill instruction:

- Top level: `pr` (number), `round` (number), `findings` (array, ≥1); `duration_ms` (number, optional — wall-clock milliseconds the triage session spent reaching these verdicts; the skill's final act records it so merge can derive the §3.12 frontier cost estimate).
- Per finding — required: `finding_id` (stable within the round), `finding_text` (the lead-authored finding statement — replayable input, not a quote of bot prose), `diff_context_ref` (a pointer such as `path@sha`; never an inlined diff hunk), `label`, `disposition` (one of `PATCH | DISMISS | DEFER | DECISION_NEEDED | POST_MERGE_CHANGED | GATE_ACTION`).
- Per finding — optional: `rationale`; `created_at` (ISO-8601); `latency_ms` (number — elapsed time this one finding took to adjudicate; the skill's final act records it per finding). All three follow preserve-or-null: when omitted, merge stamps merge-time for `created_at` and writes `null` for the others; when present, they are preserved (best-available-timestamp-wins).
- No secrets, no diff hunks, no bot-comment text (INV-C1/C2). Everything else the schema rejects as an unknown key (strict). `finding_text` provenance is the skill edit's contract: `merge.ts` validates shape, not authorship.
