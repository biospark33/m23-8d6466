# M3.2 Acceptance Auditor Report

Scope: `_bmad-output/reviews/m3-2/diff.patch` (10 files, all new — verified byte-identical to the working tree) vs `_bmad-output/sprint-artifacts/dark-factory-v6/stories/m3-2-l4-weekly-reflect-propose.md`. Context consulted: M3.1 story (INV-MEM-1..4, seam-fake precedent), `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` (DD-21, DD-23b, DD-28.26), `_bmad-output/typesafe-integration/handoff.md` (LOCKED #9). Suite re-run by auditor: `bun test tests/learning/` → **77 pass / 0 fail**.

## Findings

### F1 (MEDIUM) — Driver's documented exit contract contradicts the job's `ok` semantics: a partial bank failure still exits 0
- **Constraint:** `scripts/memory-weekly.ts:29-31` (self-documented contract): "0 — every bank reflected and every composed proposal landed / 1 — job failures (**banks_failed non-empty**, a divergent/retain fault, …)". Spec E2E slice: "Then it **exits 0** having written one proposal record per finding" (exit 0 is the all-good claim).
- **Evidence:** `src/learning/weekly-reflect.ts:501` — `const ok = banksOk.length >= 1 && landFaults === 0 && (landed.length >= 1 || composed.length === 0);` — bank failures never enter `landFaults`, so 1-of-3 banks failed + proposals landed ⇒ `ok: true`. `scripts/memory-weekly.ts:342` — `code: result.ok ? 0 : 1`. An operator reading exit 0 / `ok:true` in `last-post.log` while a manager bank silently failed to reflect is under-notified, contradicting the driver's own header. (The `weekly-reflect.ts` doc comment at :1077 is accurate — "at least one bank succeeded"; only the driver header overpromises.) No AC letter names exit codes, so this is a docs-vs-behavior contradiction inside the AC6 surface, not an AC failure.

### F2 (LOW) — AC2 negative control half-covered: "a proposal asserted to satisfy J2's sign-off" cannot be refused
- **Constraint (verbatim):** AC2 — "*Negative control: an implementation whose suggestion is indistinguishable from a directive — advisory omitted, **or a proposal asserted to satisfy J2's sign-off** — MUST fail this one.*"
- **Evidence:** `src/learning/proposal-schema.ts:106-113` — the refinement only refuses `j2_gate_note` that is `undefined` or `""`. A note reading "J2's DD-21 gate IS satisfied by this proposal" parses clean (`tests/learning/proposal-schema.test.ts` covers only empty/omitted). Free text cannot be mechanically adjudicated; system-written proposals are safe because compose pins the canonical `J2_GATE_NOTE` constant (`src/learning/compose.ts:443-444`, asserted to contain "DD-21" + "NOT satisfied"). Letter drift, accepted-with-note: the refusal exists for the omitted arm only.

### F3 (LOW) — `advisory: false` on router-tuning and skill-update reads directive-flavored against FR-LEARN-30's ceiling
- **Constraint:** FR-LEARN-30 (spec ref): "proposes (does NOT auto-apply) … The operator reviews and applies the change manually"; proposal-schema.ts's own header: "a proposal is an advisory record the operator applies in their own change — never a directive."
- **Evidence:** `src/learning/compose.ts:250` and `:300` emit `advisory: false`; `tests/learning/compose.test.ts` explicitly pins it ("advisory is NOT forced outside threshold-suggestions"). AC2's letter only mandates `advisory: true` on `threshold-suggestion`, so this is not an AC breach, and every carrier text mitigates it ("Nothing is applied automatically" / "operator applies in their own change"). Flagged because a future consumer filtering on `advisory === false` would misread two of three kinds as directives.

### F4 (LOW) — `documentId` embeds a sanitized stamp, not the raw `<firedAt>` instant
- **Constraint (verbatim):** Technical Notes / E2E slice — "`documentId = "l4-proposal-<week>-<firedAt>-<seq>"` + `updateMode: "replace"`".
- **Evidence:** `src/learning/compose.ts:642-644` — `firedAt.replace(/[:.]/g, "-")` before embedding (`l4-proposal-2026-W41-2026-10-05T06-23-00-000Z-001`). Colons cannot live in filenames/ids; the `fired_at` field carries the raw ISO and tests pin both forms. Firing-identity semantics (retry same-stamp = replace; re-fire new-stamp = new ids) hold exactly as specified.

### F5 (LOW) — "byte-identical retry = rename-over" is actually "kept-existing, no write at all"
- **Constraint (verbatim):** E2E slice — "a byte-identical retry's replace is **a rename-over** the existing `documentId` record, never an in-place rewrite".
- **Evidence:** `src/learning/weekly-reflect.ts` `writeProposalRecord` (~:919-921) — `existsSync` + byte-equality short-circuits to `"kept-existing"` without any rename; the retain still re-sends `replace` (tested: `retainCalls().length === retainsAfterFirst * 2`). The invariant that matters (never an in-place rewrite; retry is a no-op on disk) holds; only the mechanism wording differs.

### F6 (LOW) — Receipt does not separately evidence the store row vs the bank retain
- **Constraint (verbatim):** AC3 — "the posted carrier **plus the store plus the bank** are all present in the receipts."
- **Evidence:** `WeeklyReceiptSchema` (`proposal-schema.ts:120-145`) carries `proposals` (the landed set — store+retain+post all held, gated at `weekly-reflect.ts` before `landed.push`) and `posted` (carrier), but no per-proposal store/bank fields. A retain-failed proposal is excluded from `proposals` while its store row stands (`tests/learning/weekly-reflect.test.ts` "async retain failure": `receipt.proposals === []`, `storeFiles().length === 3`). The direction is conservative — a partial landing never reads as posted — so intent holds; the letter's three-way itemization is two-way.

### F7 (LOW) — Schedule leg is a library-call seam-fake with the host-held token, not M3.1's bot-token wake
- **Constraint (verbatim):** AC6 — "the platform-schedule leg wakes through M3.1's machinery (**agent token scoped per M3.1**)"; E2E slice — "the firing turn's reply carries the posted proposal summary."
- **Evidence:** `tests/learning/weekly-reflect.test.ts` "schedule leg (AC3)" invokes `runWeeklyReflect({leg: "schedule"})` directly; the "turn reply" is the returned `postedTexts`. Sanctioned by the story's own Trigger Surface ("in-scope (seam-fake until A1's fork-side delivery lands)") and identical in degree to how M3.1 landed its schedule leg. The token on this leg is the host-held `{reflect, retain}` class, not M3.1's bot `{consolidate}` — but that split is exactly what M3.2's Technical Notes and INV-LEARN-4 legislate ("the weekly job holds a **host-held** agent token scoped exactly `{reflect, retain}` … the retain verb never enters a bot-held token"), and the class split is test-asserted (bot retain grant refused; bot token refused scope-verb on both weekly paths).

### F8 (LOW) — AC1's "auto-applied tuning proposal" negative control is proxy-tested, not literally simulated
- **Constraint (verbatim):** AC1 — "*Negative controls, both MUST fail:* **an auto-applied tuning proposal** — any path where a proposed change takes effect…"
- **Evidence:** no test constructs an apply-path and watches it fail. Coverage is by the sanctioned proxies: the transitive-closure writer-import fence (`tests/learning/weekly-reflect.test.ts` "module-graph fences (AC1/AC6)" — `WRITER_PATHS` over managers/fleet/phase-engine/gate, E21/raw-port scans), gateway verb scoping (bot-class refusals), and the schema's status-field refusal (the proposal-status-machine arm of AC1's second negative control — `tests/learning/proposal-schema.test.ts` "status field injected refused"). The DoD's own testable form ("no writer import in the module graph (AC1)") is what was built. Note the fence regex is specifier-text-based (a bare `../gate` import without a trailing slash would slip) — no such import exists in the actual closure (learning/memgate/hindsight/swarmclaw-log only).

### F9 (INFO) — File-list deviation (disclosed) and a 508-line file
- Spec "Files to Modify" names 4 files; the diff adds `gather.ts`, `compose.ts`, `index.ts` and splits tests into 4 suites — disclosed in the Dev Agent Record as PLAN C14, motivated by the 500-line pin. `src/learning/weekly-reflect.ts` lands at **508 lines** (`wc -l`), over both the global "files under 500 lines" pin and the dev's own stated discipline. No AC impact.

### F10 (INFO) — Router-tuning proposals cite all KPI snapshot refs without using them
- `src/learning/compose.ts:667` — `kpi_snapshot_refs: evidence.kpiSnapshots.map((k) => k.ref).sort()` although the router detector consumes only routing lines. AC4's "every proposal cites its evidence" holds (nothing cited is false); the extra refs imply an evidentiary basis the detector did not use. Minor provenance noise.

### F11 (INFO) — Cosmetic: duplicated comment block in the e2e test
- `tests/learning/weekly-reflect.test.ts` (post-`finally` block): the "retains hit the shim… (read AFTER stop())" comment appears twice verbatim. No behavior impact.

## Spec-letter spot-checks requested by the audit brief

| Check | Result |
|---|---|
| "five negative controls" as failing tests | AC1×2 (status-machine refused at schema; auto-apply via writer-fence proxy — F8), AC2×1 (advisory:false / no-adjudicator / empty-note refused), AC3×1 (uncovered or duplicate `posted` id refused; retain-failure excludes from receipt), AC5×1 (severity field / evidence key / area refused; query token + hostile-name filter). The MUST-fail controls named across AC1/2/3/5 all exist as red tests; AC4's two (absence-required, store-write) are covered by the absence-arm green tests and the three-level byte-identity digests |
| Receipt names superseded ids | YES — `supersededIds()` (`weekly-reflect.ts:959-977`) lists strictly-earlier-stamp same-week ids; tested incl. the out-of-order re-fire arm and the spawned e2e (`superseded === [OLD_ID]`) |
| Schedule leg's carrier demonstrated | YES, in-suite — chat summaries in `postedTexts`, `receipt.posted.carrier === "chat"` (seam-fake per spec; see F7) |
| `reflect_ms` absent-not-zero | YES — `reflect_ms_by_bank` optional, omitted when no bank succeeded; budget test asserts `"reflect_ms" in event === false` for skipped banks and the receipt field `undefined` |
| Crontab header matches `>> .sandbox/proposals/last-post.log` | YES — `scripts/memory-weekly.ts:18`, verbatim redirect target; env-file-path-not-contents posture documented (INV-LEARN-4) |
| Host-held token scoped exactly {reflect, retain} | YES — landed registry `host: ["reflect", "retain"]` (`src/memgate/schemas.ts:110`, untouched); rig grants exactly that pair; bot-retain grant refused (`grant-verb-outside-class`); class split test-asserted |
| INV-LEARN-5 frozen surfaces | Diff is 10 new files, zero modifications — `src/hindsight/client.ts`, memgate, gate machinery all zero-diff |
| Severity LOCKED (#9 / DD-21) | No severity field/kind/area anywhere; `SEVERITY_TOKEN` actively strips it from queries and prose; negative tests at schema, query, and hostile-name levels |

## Verdicts

- **AC1: PASS-WITH-NOTE** — only writes are `.sandbox/proposals/` + gateway retains; writer-fence over the transitive closure; status-machine refused. Notes: F8 (auto-apply NC is proxy-tested), F3 (`advisory:false` flavor).
- **AC2: PASS-WITH-NOTE** — advisory:true + operator adjudicator + J2 DD-21-unsatisfied note schema-enforced and end-to-end tested; no writer import asserted by fence. Note: F2 (satisfaction-asserting note unrefusable free text).
- **AC3: PASS-WITH-NOTE** — both carriers demonstrated with leg-appropriate payloads; posted-coverage exactly-once refinement; retain-failure withholds posting. Notes: F6 (store/bank not separately itemized in the receipt), F5/F4 (mechanism wording).
- **AC4: PASS** — absence arms typed and green (routing log deleted, all-absent), citations on every proposal, consumed stores byte-identical at gather/run/spawned-e2e levels. Minor: F10 (over-citation).
- **AC5: PASS** — no severity surface in schema/query/kind; active filtering; all negative schema tests present and passing.
- **AC6: PASS-WITH-NOTE** — crontab line matches the spec redirect verbatim; same job module through the same gateway; E21/raw-port fence asserted by test; schedule leg is the spec-sanctioned seam-fake. Note: F7 (token-class reading), F1 (driver exit-contract contradiction lives on this surface).

Overall: no FAIL. The implementation is spec-faithful on every make-or-break invariant (PROPOSE ceiling, severity lockout, absence discipline, idempotent re-fire with superseded naming, gateway-only posture, class split). The material item to address before merge is F1 (align the driver's documented exit contract with `ok`'s ≥1-bank semantics, or tighten `ok` to require `banks_failed` empty); F2-F3 deserve a one-line disposition; the rest are notes.
