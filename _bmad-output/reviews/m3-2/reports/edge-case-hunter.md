# Edge Case Hunter — m3-2 (weekly reflect → proposals)

Scope: `_bmad-output/reviews/m3-2/diff.patch` (all-new: `src/learning/{proposal-schema,gather,compose,weekly-reflect,index}.ts`, `scripts/memory-weekly.ts`, tests). Method: exhaustive branch/boundary walk; only unhandled paths reported. Dependency behavior verified against `src/memgate/gateway.ts`, `src/hindsight/schemas.ts` (ReflectResponseSchema — `insights` array has **no length cap and no summary cap**), `src/hindsight/bank-provisioner.ts`, `scripts/lib/cli-args.ts`, zod 3.24 (`z.number()` rejects NaN; `z.record(z.number())` accepts negatives).

No HIGH findings: nothing here mutates a consumed store, bypasses the operator-apply ceiling, or corrupts the append-only store on the sequential path.

## MED

### MED-1 — AC5 severity-token leak via raw run-record filenames in the skill-update rationale
- **File:** `src/learning/compose.ts:302`
- **Unhandled edge:** the class name is severity-filtered (`embed(cls)`) but the evidence refs interpolated into the same rationale (`${refs.join(", ")}`) are **raw filenames** from `readdirSync`, never passed through `safeName`/`embed`. `gather.ts:163` admits **any** `*.json` name, not just the `qds-YYYYMMDD-hhmmss` store layout the docblock assumes.
- **Trigger:** `.sandbox/runs/` contains ≥2 records sharing a failure class, one file named e.g. `severity-drift-qds-20261001-000001.json`.
- **What happens:** the string `severity` reaches the proposal rationale → the store row, the retain content, and the operator carrier text — violating compose's own docblock ("No 'severity' token is ever emitted") and the AC5 negative control. One `safeName`/filter pass over `refs` closes it.

### MED-2 — Unbounded reflect insights: quadratic `capBytes` hang + unbounded store rows
- **File:** `src/learning/weekly-reflect.ts:177-181, 324`; `src/learning/compose.ts:231, 263, 287, 309`
- **Unhandled edge:** `ReflectResponseSchema` (`src/hindsight/schemas.ts:222-233`) caps neither the `insights` array length nor each `summary` length. Compose copies them verbatim into `insights_cited` (so the **stored** proposal JSON is unbounded — only the rationale has the 4 000-char ceiling), and `composeOperatorText` (rationale + refs + joined insights) is fed to `capBytes`, whose "linear backoff" is O(n²): it decrements `cut` by one code unit, re-measuring `Buffer.byteLength` of the whole prefix each step.
- **Trigger:** a degenerate/hostile reflect response with a multi-MB insight summary (schema-legal) → a firing that hangs for hours between store-write and retain; even ~100 KB of insights costs ~10¹⁰ char-scans.
- **What happens:** weekly budget guard never fires (it is only checked between loop iterations, and the hang is *inside* one), job wedges mid-firing with store rows already written; store rows bloat with uncapped `insights_cited`.

### MED-3 — `proposalsDir` a regular FILE: raw ENOTDIR throw at receipt time kills the receipt after side effects
- **File:** `src/learning/weekly-reflect.ts:234-237` (`supersededIds`)
- **Unhandled edge:** only `ENOENT` is tolerated when listing the proposals dir. If `.sandbox/proposals` exists as a **file** (exactly the misprovisioning the crontab NOTE in `memory-weekly.ts` warns about), every per-proposal store write faults typed (mkdirSync EEXIST → `PROPOSAL_STORE_FAILED`, handled), but the receipt step then calls `supersededIds(dir, …)` → `readdirSync` throws raw `ENOTDIR`, uncaught.
- **Trigger:** `mkdir .sandbox && touch .sandbox/proposals` then run the job with any evidence.
- **What happens:** runWeeklyReflect throws at step 5 — no receipt, no `weekly-complete` event — after the per-proposal faults were already (correctly) handled. The `ENOENT` branch shows the absent-dir case was handled; its ENOTDIR sibling was not.

### MED-4 — No per-firing proposal-count bound: detectors fan out one proposal per shape / per (snapshot, KPI) / per class
- **File:** `src/learning/compose.ts:242, 268, 292` (detectors) and `compose.ts:152`
- **Unhandled edge:** `MAX_RUN_RECORDS` bounds only the runs read; nothing bounds the output. `router-tuning` emits one proposal **per distinct shape**, `threshold-suggestion` one **per snapshot × measured KPI with a positive counter** (no dedup across snapshots — 52 weekly snapshots of the same regressing counter ⇒ 52 identical-substance proposals in one firing), `skill-update` one per class. Distinct shape/class counts are attacker/data-controlled.
- **Trigger:** routing log with a few thousand distinct `shape` values (or a snapshots dir accumulated over a year with a persistently positive counter).
- **What happens:** thousands of store files, gateway retains, and operator carrier texts in a single firing (budget checks per iteration only slow it, they don't bound it) — operator spam + unbounded `*-meta` bank growth.

### MED-5 — Future-pinned `QDS_WEEKLY_FIRED_AT` silently poisons supersession forever
- **File:** `scripts/memory-weekly.ts:228` (seam accepts any valid instant, no `firedAt`-vs-now cross-check); `src/learning/weekly-reflect.ts:246` (`stampSeg < stamp`)
- **Unhandled edge:** the supersession design guarantees "a later firing is never superseded by an earlier one" *only* for stamps lexicographically earlier. A year typo in the operator seam (`2206-10-05T06:23:00.000Z` passes `FIRED_AT_RE` + finite-parse) stamps ids in 2206; every subsequent real firing's stamp sorts strictly earlier.
- **Trigger:** one firing with a mistyped `QDS_WEEKLY_FIRED_AT` year.
- **What happens:** the stale 2206 proposal rows are never named in any later receipt's `superseded` (their stamp is "newest forever"), so stale proposals linger authoritative in the store and the retained bank copy is never superseded — the receipt invariant the story's DoD hinges on silently breaks. No validation rejects it; no fault is emitted.

## LOW

### LOW-1 — `ISO_WEEK_PATTERN` accepts non-existent weeks (`W00`, `W99`, year `0000`)
- **File:** `src/learning/proposal-schema.ts:31` (also `weekly-reflect.ts:68`, `memory-weekly.ts:93`)
- **Edge:** `/^\d{4}-W\d{2}$/` is shape-only; `--week 2026-W00` (or `2026-W99`, `0000-W01`) passes every layer and `isoWeekOf` can never emit them.
- **Trigger:** `bun scripts/memory-weekly.ts --week 2026-W00`.
- **What happens:** a full green firing whose ids, store filenames, retains, and receipt are all labeled with a week that does not exist in ISO-8601 — unrecoverable mislabeling in the append-only store. A `1-53` range check on the W component closes it.

### LOW-2 — UTF-8 BOM on `routing-log.jsonl`: hard fault when multi-line, silent drop when single-line
- **File:** `src/learning/gather.ts:124-141`
- **Edge:** `readFileSync(..., "utf8")` keeps `﻿`; line 1 then fails `JSON.parse`. For a multi-line log (i≠lastNonBlank) it throws `routing-log-invalid` — a healthy log becomes a whole-firing fault; for a **single-line** log (i===lastNonBlank) it is silently swallowed as a "torn tail", producing empty evidence and a green run that saw nothing.
- **Trigger:** editor/shell that writes a BOM (`printf '\xEF\xBB\xBF'` + one routing line).
- **What happens:** either an unexplained red on a valid store, or a silently evidence-free reflect. A leading-BOM strip (or excluding BOM from the torn-tail tolerance) closes it.

### LOW-3 — `ENOTDIR` on a consumed-store path escapes the typed-absence law
- **File:** `src/learning/gather.ts:124` (same pattern at `:170`, `:195`)
- **Edge:** the absence law types only `ENOENT`. If `.sandbox` itself is a regular file, `readFileSync(".sandbox/routing-log.jsonl")` throws raw `ENOTDIR` — a store that is, in effect, wholly absent, but treated as present-but-unreadable.
- **Trigger:** `touch .sandbox` (instead of `mkdir .sandbox`) on a host, then run.
- **What happens:** untyped throw out of `gatherEvidence` (library) / `WEEKLY_DRIVER_FAULT` exit 1 (CLI) with none of the typed-absence/fault framing; the store is not cited as `absent` in any receipt because no receipt exists.

### LOW-4 — Non-finite clock mid-run: entry guard only, receipt parse then throws after side effects
- **File:** `src/learning/weekly-reflect.ts:497` (guard exists only at `:371-374`)
- **Edge:** `nowMs` is validated finite once at entry; the end-of-run read feeds `Math.max(0, Math.round(NaN))` = `NaN` into `total_ms`, and zod's `z.number().int().min(0)` rejects NaN → `WeeklyReceiptSchema.parse` throws a raw `ZodError`.
- **Trigger:** a `deps.now` seam that returns a finite value at entry and NaN at completion (faulty injected clock in tests/ops seams).
- **What happens:** stores written, retains sent — then the job crashes with no receipt and no `weekly-complete` event; CLI reports an untyped driver fault.

### LOW-5 — Clock going backwards mid-run: negative per-bank `reflect_ms` recorded unclamped
- **File:** `src/learning/weekly-reflect.ts:426` (and `reflectOneBank`'s `ms` computation)
- **Edge:** `total_ms` is clamped `min(0)` at `:497`, but `reflect_ms_by_bank` is `z.record(z.number())` — no min — and `nowMs(deps) - started` is stored raw.
- **Trigger:** injected clock steps backwards between a bank's start and end reads.
- **What happens:** a receipt asserting bank X reflected in "-3 ms"; inconsistent with the file's own absence-not-zero / clamped-total discipline.

### LOW-6 — Optional milliseconds in `FIRED_AT_RE` breaks the "fixed-width stamp" lexicographic assumption
- **File:** `src/learning/weekly-reflect.ts:69` (`(\.\d{3})?`), `:246`
- **Edge:** the `supersededIds` docblock claims "the stamp is fixed-width ISO", but the regex admits `2026-10-05T06:23:00Z` (no ms) alongside the ms form; within the same second, `…00Z` sorts **after** every `…00-NNNZ` stamp ('Z' > '-').
- **Trigger:** library caller passes `firedAt: "2026-10-05T06:23:00Z"` after a same-second ms-form firing (CLI normalizes via `toISOString`, so this is the `runWeeklyReflect` seam).
- **What happens:** the earlier-pinned no-ms firing labels the *later* ms-firing's ids `superseded` — the exact inversion the docblock says cannot happen.

### LOW-7 — Non-run-record `*.json` files crowd the last-50 recency window
- **File:** `src/learning/gather.ts:163, 199`
- **Edge:** the suffix filter admits any `*.json`; `names.slice(-MAX_RUN_RECORDS)` assumes name order is recency order **over run records only**. Any foreign `.json` (e.g. `zzz-notes.json`, which sorts after all `qds-*`) occupies a window slot.
- **Trigger:** 50+ foreign names lexicographically after the `qds-` range in `.sandbox/runs/`.
- **What happens:** genuine recent run records silently excluded from the evidence the reflect cites.

### LOW-8 — Duplicate `runId`s across routing lines: double-counted means, duplicated citations
- **File:** `src/learning/gather.ts` (`RoutingLogLineSchema`: `runId: z.string().min(1)`, no uniqueness), `src/learning/compose.ts:157` (`g.refs.push(line.runId)`)
- **Edge:** a retried/replayed decision appends a second line with the same `runId`; nothing dedups.
- **Trigger:** routing log containing the same `runId` twice for one shape/tier.
- **What happens:** the tier mean counts the decision twice and `routing_log_refs` lists the same runId twice in the stored proposal — skewed detector arithmetic and duplicated evidence citations.

### LOW-9 — Repeated `--week` flags silently last-win
- **File:** `scripts/memory-weekly.ts:161-162`
- **Edge:** `parseValueFlags` has no repeat policy and `onValue` overwrites `weekArg`; the shared grammar's docblock pins `--flag=value` vs `--flag value` edges but not repeats.
- **Trigger:** `bun scripts/memory-weekly.ts --week 2026-W41 --week 2026-W42`.
- **What happens:** a full firing labeled `2026-W42` with no refusal or warning; an operator fat-fingering a correction ends up minting ids for the wrong week.

### LOW-10 — `existsSync`→`renameSync` TOCTOU: concurrent same-`firedAt` firings overwrite silently instead of `PROPOSAL_DIVERGENT`
- **File:** `src/learning/weekly-reflect.ts:190, 213`
- **Edge:** divergence is detected only if the final path exists *before* the temp write; two concurrent `runWeeklyReflect` calls with the same pinned `firedAt` both see "absent", both write unique temps, both rename.
- **Trigger:** crontab + schedule legs overlapping with an identical `QDS_WEEKLY_FIRED_AT` and differing evidence.
- **What happens:** last rename wins — one proposal row silently replaces the other with no `PROPOSAL_DIVERGENT` fault (the single-writer assumption is nowhere enforced).

### LOW-11 — KPI-snapshots dir read is unbounded (no `MAX_*` analog)
- **File:** `src/learning/gather.ts:163, 171-181`
- **Edge:** runs are bounded to 50 by name, but `readKpiSnapshots` reads and `JSON.parse`s **every** `*.json` in the dir, all retained in memory for the whole firing.
- **Trigger:** a long-lived host with a snapshots file per nightly (years) or a directory bomb of large `*.json`.
- **What happens:** unbounded memory/latency in one firing; the reflect query is char-capped but the gather side is not.

## Handled (verified, not reported as findings)
Byte-identical retry re-retains (`kept-existing` does not short-circuit the retain leg — test-confirmed); empty/absent inputs → typed absences + green; counter exactly 0 → healthy; CRLF tolerated via trim; torn tail only at last non-blank line; `proposalsDir` a file during *store* (typed per-proposal fault); clock backwards on `total_ms` (clamped); budget expiry between banks/proposals (skip-fail-loud, no partial posting); all-banks-failed still composes/posts from evidence with `ok:false`; empty banks array in compose → `[]`; malformed seam instants (`2026-02-30T…`) → typed refusal via finite-parse; duplicate receipt `posted` rows refused; regex patterns are linear (no catastrophic backtracking in `PROPOSAL_FILE_RE`/`ISO_WEEK_*`).
