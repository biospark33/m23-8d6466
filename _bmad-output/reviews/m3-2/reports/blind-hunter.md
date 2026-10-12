# Blind Hunter — m3-2 weekly reflect → proposals (diff-only review)

Scope: `_bmad-output/reviews/m3-2/diff.patch` only. No repo access; every finding is judged from the diff text alone.

## HIGH

- **HIGH — Documented exit contract contradicts implemented `ok` semantics; `banks_failed` can exit 0** — `a/scripts/memory-weekly.ts:29-34` vs `a/scripts/memory-weekly.ts:342`, `a/src/learning/weekly-reflect.ts:501`
  The CLI header promises exit 1 for "banks_failed non-empty" and for "a divergent/retain fault", but the driver returns `code: result.ok ? 0 : 1` and `ok = banksOk.length >= 1 && landFaults === 0 && (landed.length >= 1 || composed.length === 0)` never consults `banks_failed`, and `PROPOSAL_DIVERGENT` deliberately does not count as a landing fault (the test at `a/tests/learning/weekly-reflect.test.ts:592` asserts divergence-among-siblings stays `ok: true`). A fresh install with zero evidence and 2-of-3 banks refused exits 0 — the operator's cron alerting on nonzero silently loses bank-failure signal in exactly the fresh-empty posture the module's own header says is expected.

- **HIGH — Same-id store race defeats the C7 divergent guard (check-then-write, no exclusive create on the final path)** — `a/src/learning/weekly-reflect.ts:189-222`
  `writeProposalRecord` does `existsSync(finalPath)` → temp `wx` write → `renameSync(tempPath, finalPath)`. Two concurrent firings with the same week+firedAt (crontab process + schedule-leg process, or cron overlapping a manual re-run) both see `existsSync === false`, both rename, and `renameSync` silently replaces the winner's row: both callers return `"written"`, both retain, both post, and neither logs `PROPOSAL_DIVERGENT`. The stored-row-stands invariant and the receipt's "landed" claim are both silently violated under the concurrency the dual-leg design invites. Sequential retries are safe; the guard is racy exactly where it matters.

## MED

- **MED — AC3 refinement is one-directional: `posted` rows with no matching proposal id pass, and duplicate `proposals` ids pass** — `a/src/learning/proposal-schema.ts:140-154`
  The refinement only iterates `r.proposals` and checks each against `seen`. A receipt with `proposals: []` and `posted: [{proposal_id: "X", carrier: "chat"}]` parses clean — "posting without landing" is exactly the mirror abuse AC3 exists to refuse. Likewise `proposals: ["X","X"]` with one posted row passes (each lookup independently `=== 1`). The negative-control suite tests only the proposals→posted direction.

- **MED — The AC5 "no severity ever emitted" invariant holds only for extracted names; runIds, filename refs, and bank insights flow through verbatim** — `a/src/learning/compose.ts:231-233,260,302`, `a/src/learning/weekly-reflect.ts:128-141`
  `safeName`/`embed` gate KPI names, tier names, shapes, and class labels — but `evidence.routing_log_refs` (routing-log `runId` is `z.string().min(1)`, any content), snapshot/run-record filename refs, and `insights_cited` (raw reflect-LLM summaries from the memory bank) are interpolated unfiltered into the stored record, `composeOperatorText`, and the retain body. A runId or bank insight containing "sever" lands in the receipt path the AC5 e2e test claims is severity-free; the test only exercises benign fixtures.

- **MED — `shape` in the class-probe list fabricates "failure classes" from a non-failure field** — `a/src/learning/compose.ts:44,198-212`
  `RUN_CLASS_FIELDS = ["classification","outcome_class","fixOutcomeClass","shape","status"]` with a first-string-wins probe: two run records carrying only `{"shape":"review"}` (a routing shape, present on every record of the DF2.1 layout the gather header describes) yield class "review", which survives `SUCCESS_CLASS_RE`, and compose a skill-update for a failure class that is not a failure. The round-0 #7 fix filters success spellings, not the structural misuse of `shape` as a fallback.

- **MED — Gather faults abort the whole job with no receipt; the orchestrator's "only config-level input throws" claim is false** — `a/src/learning/weekly-reflect.ts:396-400` (vs header `a/src/learning/weekly-reflect.ts:345-350`), `a/src/learning/gather.ts:141-160,219`
  `gatherEvidence` is called bare: a corrupt mid-file routing line (`routing-log-invalid`), an unparsable snapshot/run record, or a non-ENOENT fs error (EACCES) throws out of `runWeeklyReflect` before any reflect, retain, or receipt. The driver's catch path emits only `{ok:false, code:"WEEKLY_DRIVER_FAULT", message}` — no envelope, no receipt, no `absent_sources`, and the per-bank/per-proposal isolation the header advertises never engages. A data-level fault is documented as impossible ("only config-level invalid input throws"); it is the likeliest real-world failure.

- **MED — The 0700 directory gate is skipped whenever the proposal file already exists** — `a/src/learning/weekly-reflect.ts:190-202`
  `existsSync(finalPath)` short-circuits to `kept-existing`/`divergent` before the `mkdirSync`/`statSync` mode check. A proposals directory provisioned at 0755 with pre-seeded records passes every run with zero warnings — the stated invariant ("records are 0600 and must not sit in a wider-mode directory") is unenforced on precisely the pre-existing path, and no test seeds a wrong-mode dir.

- **MED — Superseded firings are never retired from the memory bank; re-fires accumulate duplicate proposal documents** — `a/src/learning/compose.ts:235-237`, `a/src/learning/weekly-reflect.ts:323-332`
  `documentId` embeds the firing stamp, so a same-week re-fire retains NEW documents while the old ones stay in the bank; `receipt.superseded` is informational only and nothing in the diff updates or deletes them. The bank accumulates every re-fire's proposal text forever, and later reflects on that bank see N stale copies as distinct content — unbounded growth with no retirement path.

- **MED — `deps.banks` filter can yield `[]` → generic crash instead of a typed refusal** — `a/scripts/memory-weekly.ts:297-300`
  The ops/test seam filters `deps.banks` against the derived family; a wholly-foreign list passes the filter as `[]` and reaches `runWeeklyReflect`, which throws `weekly-banks-empty`, surfacing as an untyped `WEEKLY_DRIVER_FAULT` exit 1 rather than the exit-2 config-refusal family every other bad-input path gets.

## LOW

- **LOW — Zod issue path mis-indexed in the AC3 refinement** — `a/src/learning/proposal-schema.ts:149`
  `path: ["posted", i]` where `i` is the index into `r.proposals`, not `posted` — the reported location can point at an unrelated, correctly-covered posted row.

- **LOW — `capBytes` dead ternary and surrogate-split risk contradict its own comment** — `a/src/learning/weekly-reflect.ts:177-181`, `a/src/learning/compose.ts:127`
  `Buffer.byteLength(s) <= max ? s.length : s.length` is a no-op branch, and the `cut--` walk can stop between a surrogate pair despite "without splitting a code point"; `buildReflectQuery`'s `.slice(0, CAP)` can split a pair the same way.

- **LOW — Week pattern accepts `W00`–`W99`** — `a/src/learning/proposal-schema.ts:31`, `a/scripts/memory-weekly.ts:93`, `a/src/learning/weekly-reflect.ts:68`
  `/^\d{4}-W\d{2}$/` has no 01–53 range check; `--week 2026-W99` is accepted end-to-end and embedded in ids, filenames, and the receipt.

- **LOW — KPI snapshots are read and cited unbounded, with zero shape gate** — `a/src/learning/gather.ts:165-188`, `a/src/learning/compose.ts:176-195`
  Runs are capped at `MAX_RUN_RECORDS = 50` but snapshots are not: every `*.json` in the dir is loaded, cited as evidence, and structurally probed — a stray or hostile `{"kpis":[{name, value:{status:"measured"}, counter:{name, value:5}}]}` file in `kpi-snapshots/` mints an operator-facing threshold proposal citing itself as evidence.

- **LOW — Torn-tail drops and the 50-record run cap are silent** — `a/src/learning/gather.ts:141,199`
  The dropped torn line and the `slice(-50)` truncation change the evidence set but appear nowhere in the receipt or events — the operator cannot tell a line was lost or a window clipped.

- **LOW — Gateway ledger handle is never closed in the driver** — `a/scripts/memory-weekly.ts:318-328`
  `memgateDeps(...)` opens the ledger; neither success, refusal, nor fault paths in `runMemoryWeekly`/`run` close it — the process-exit close is relied on (and the e2e test must call `gw.ledger.close()` manually to make the spawned child's grant visible).

- **LOW — `MemgateError` reused as a generic error type; `run()`'s catch echoes any `.code`** — `a/src/learning/weekly-reflect.ts:197-201`, `a/scripts/memory-weekly.ts:388-394`
  A filesystem-mode policy fault is thrown as a Memgate (gateway) error, and the driver's top-level catch prints `err.code ?? "WEEKLY_DRIVER_FAULT"` — any Node fs error (e.g. `EACCES`) gets its errno echoed as the fault code, and a non-Error throw yields `message: undefined`.

- **LOW — `counterRegressions` is laxer than the query builder and overstates its finding** — `a/src/learning/compose.ts:176-195`
  A "measured" primary with no numeric `value` still fires (buildReflectQuery requires a number), and any positive counter is called "regressing" in operator prose though no baseline or trend was computed.

- **LOW — Duplicated comment block in the e2e test** — `a/tests/learning/weekly-reflect.test.ts:837-840`
  The "retains hit the shim… read AFTER stop()" comment appears twice verbatim with inconsistent indentation — a copy-paste artifact at a load-bearing sequencing point.

- **LOW — Shim child leaks if the port handshake rejects** — `a/tests/learning/weekly-reflect.test.ts:729-737`
  `startShim` spawns node, then awaits the port promise with a 10 s timeout; on rejection the child is never killed (the rejection path has no cleanup), leaving a listening orphan until the test process dies.

## UNCONFIRMED

- **UNCONFIRMED — `parseValueFlags` help semantics** — `a/scripts/memory-weekly.ts:66-77,103`
  The comment says help "writes its own stdout + exits 0" inside `parseValueFlags`. If that is a `process.exit` inside a library parser, calling `runMemoryWeekly` in-process with `--help` kills the caller (including the test process) and `run()`'s sink restore never runs. Settle: read `scripts/lib/cli-args.ts`.

- **UNCONFIRMED — the schedule ("chat") leg has no caller in this diff** — `a/src/learning/weekly-reflect.ts:349-355,1269-1274`
  `leg: "schedule"` and carrier `"chat"` are exercised only by direct `runWeeklyReflect` calls; nothing here shows the bot-side caller, so whether anything confirms actual chat delivery after the receipt records `posted: chat` is not visible from the diff.

- **UNCONFIRMED — hardcoded three-bank family vs the provisioner** — `a/scripts/memory-weekly.ts:294`
  `-dev-meta`/`-qa-meta`/`-maint-meta` are hardcoded; whether the provisioner can define additional meta banks that this job would silently never reflect cannot be seen from the diff.
