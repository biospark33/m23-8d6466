# Blind review — fleet rest chunk (status.ts / brief-schema.ts / verbs.ts / index.ts)

Reviewed `chunk-fleet-rest.diff` alone, no repo access.

## Findings

**[HIGH] Losing side of `Promise.race` can crash the process with an unhandled rejection**
- `src/fleet/status.ts:183-200` (`listWithTimeout`)
- Trigger: `driver.list()` hangs past the timeout. The timer rejects, `listOwnedBoxesOnce`'s catch turns that into `null`, and status proceeds cleanly — but the original `driver.list()` promise is still pending. When the wedged call eventually settles (subprocess killed → error event, socket reset), nobody is attached to it: `Promise.race` does not shield losers and the `finally` only clears the timer. On Node ≥15 the late rejection terminates the process with an untyped non-zero exit — precisely the "never untyped" outcome this module's whole error taxonomy exists to prevent, and it lands *after* classification, so none of the typed exits apply. Same exposure on the retry attempt in `listOwnedBoxes` (`status.ts:269`). Fix is one line: attach a no-op `.catch(() => {})` to the loser (or use `AbortSignal`).

**[HIGH] Brief can attribute attacker-controlled code to a trusted slug's budget (self-documented residual)**
- `src/fleet/brief-schema.ts:395-423` (object-level refine)
- Trigger: `{repoSlug: "trusted/repo", repoUrl: "https://evil.example/trusted/repo"}` — path ties exactly, host untied, so the brief validates. The box clones and runs evil.example's code while ledger, per-issue cap and `run-context.json` all record `trusted/repo`: unattributed/miss-attributed spend plus arbitrary code execution under a trusted identity. The docstring states this plainly and defers to DF5.2's allowlist design, so it is a known, accepted gap — but until DF5.2 lands this refine is advertised as "the only thing tying the code that RUNS to the identity that PAYS", and it does not tie the half that matters. Reported because documented ≠ fixed.

**[MEDIUM] Raw substrate box name interpolated into the `record-read-failed` remediation**
- `src/fleet/status.ts:649-656` (`statusRun`)
- Trigger: corrupt record + a substrate box named `"x\nFLEET teardown ok runId=fake"` answering to the run id. The remediation embeds `box.name` verbatim: `` `The box ${box.name} is STILL LIVE...` ``. Every other substrate-supplied name in this file goes through `safeName` (see `orphanRow`, which sanitizes for exactly this reason), and the file's own docs call the substrate *less* trusted than the brief. This is the forged-log-line threat the file spends hundreds of lines on, surviving in the one string that also instructs an operator to run `fleet teardown`.

**[MEDIUM] Sort tie-break uses `localeCompare` — output order is locale-dependent**
- `src/fleet/status.ts:477` (`byCreatedAtDesc`)
- Trigger: two rows with equal (or absent) `createdAt`, runIds where ICU collation diverges from code-point order (e.g. `-` vs alphanumerics differ across locales/ICU versions). The comparator's own comment bans `localeCompare` for the timestamp half ("ICU collation…orders them by text, not by time") and then uses it for the tie-break. Consumers that diff `fleet status` output get spurious row-order churn across machines/locales. Should be `<`/`>` on UTF-16 code units.

**[MEDIUM] `safeUrl` drops credentials but passes dangerous schemes through to clickable rows**
- `src/fleet/status.ts:157-166` (`safeUrl`)
- Trigger: substrate-supplied `httpsUrl: "javascript:alert(1)"` or `"file:///etc/shadow"` on an orphan row. Parses cleanly, carries no userinfo, so it is sanitized-for-length and emitted as `httpsUrl` — a field the brief-side rules describe as something "an operator clicks". The brief schema refuses non-https schemes at the input boundary for exactly this reason ("`.url()` alone admits `file://` and `javascript:`"); the outbound half of INV-CRED-1 implemented here only reproduces the userinfo arm and silently drops the scheme arm.

**[MEDIUM] `requestId` and `closedAt` reach rows unsanitized while sibling record fields are sanitized**
- `src/fleet/status.ts:312` (base.requestId), `src/fleet/status.ts:337` (closedAt)
- Trigger: hostile/mangled record whose `requestId` contains `\n` (or a lone surrogate). The file establishes that store values are only proven typed, not printable ("parseability is not printability", the `createdAt` comment), sanitizes `createdAt`, `vmName` and `httpsUrl` — then copies `requestId` "straight off the record" and `closedAt` raw. `requestId` is described as the id operators grep across the log stream; a newline in it forges the exact line `NO_CONTROL_CHARS` exists to stop. Inconsistent application of the module's own rule.

**[MEDIUM] `repoSlug` has no length bound at the schema layer**
- `src/fleet/brief-schema.ts:287-290`
- Trigger: a brief with a multi-kilobyte `repoSlug` that satisfies the imported `REPO_SLUG_PATTERN` (charset-valid, unbounded quantifier — pattern not visible from this diff). The length-caps docstring exempts `repoSlug` ("Every string field but repoSlug was uncapped") on the strength of the pattern, but the file's own ledger-key argument ("a 10 MB id in the ledger key", `${slug}#${issueId}`, log correlation lines) applies to the slug identically. If the imported pattern carries no `{n,m}` bound, the strongest-validated identity field is also the longest string in the brief. Cheap insurance: `.max(...)` alongside the regex.

**[LOW] `sanitizeLabel` cap is off-by-one against its own contract**
- `src/fleet/brief-schema.ts:178-181`
- Trigger: input of length `max+1` → output is `max` sliced units **plus** `…` = `max+1` UTF-16 units. Callers/documenters treat `max` as a cap ("Cap on a substrate-supplied box name"); worst-case output exceeds it. Harmless today, but any consumer sizing columns/keys off the constants will be surprised.

**[LOW] `statusAll` element-shape guard admits arrays as "records"**
- `src/fleet/status.ts:507-513`
- Trigger: injected/hostile store returns `records: [[]]`. `typeof [] === "object"` passes the guard; `rowForRecord` then builds a row with `runId: undefined` (`vmName`/`runId` both undefined), which only survives because the comparator's `?? ""` backstop exists. The row is garbage output presented as fleet state rather than the typed `record-store-unreadable` refusal the guard was added to produce.

**[LOW] Over-long parseable `createdAt` is truncated into an unparseable value and mis-sorts**
- `src/fleet/status.ts:122` (`MAX_TIMESTAMP`) + `src/fleet/status.ts:459-471`
- Trigger: record with a valid-but-verbose ISO timestamp >64 chars. Sanitization appends `…`, `Date.parse` of the truncated string is `NaN`, comparator assigns `+Infinity`, and the row jumps to the top with the orphan/failure rows — the visual signal reserved for "unowned spend" is triggered by a formatting quirk.

**[LOW] Two distinct fleet-level rows share `runId: "(fleet)"`**
- `src/fleet/status.ts:427` (`recordsSkippedRow`) + `src/fleet/status.ts:405` (`listUnavailableRow`)
- Trigger: store listing skips files *and* the driver list fails → output contains two rows with identical `runId`, distinguished only by `state`. Any consumer keying rows by `runId` (the natural key for everything else in the file) conflates a completeness caveat with a substrate outage.

**[LOW] Store exception text embedded verbatim in typed-error messages**
- `src/fleet/status.ts:520-521` (`record-store-unreadable`), `src/fleet/status.ts:651` (`record-read-failed`)
- Trigger: a store/parser whose error message quotes record content (JSON.parse-family and validator errors frequently echo input snippets). Those bytes ride into the operator-facing message unsanitized — the same producer-side-sanitization argument the file makes for `extractZodErrorField` and `skippedRecords`, not applied to `$e.message`.

**[LOW] Exit code 6 taxonomy contradiction flagged but left unresolved in the contract registry**
- `src/fleet/verbs.ts:64-71`
- The registry's own NOTE records that `scripts/fleet.ts` defines 6 as "cleanup after success failed" while dispatch uses 6 for `ack-unwritable` ("neither"). The registry is described as the machine-read CONTRACT for DF3.5's skill-contract test; shipping it with a known, unresolved semantic split on one exit code means generated skills reason about 6 from two incompatible definitions.

**[LOW] Duplicate box name collapses to one row via last-wins Map insert (acknowledged ceiling)**
- `src/fleet/status.ts:239-245`
- Trigger: substrate returns two owned boxes sharing a name (already broken addressing, per the inline comment) — the earlier box's spend vanishes from status. Self-documented with an upgrade path; listed for completeness since it is a join that drops driver-side rows.

**[LOW] `driver.list(name)` assumed to be an exact-name filter**
- `src/fleet/status.ts:655` (`statusRun` filter), `src/fleet/status.ts:250` (named first attempt)
- Trigger: a driver whose name argument is prefix/substring matching (common in `ls <pattern>` CLIs). `statusRun` for run `abc-1` then sees box `abc-12` in the map and answers `live`/`orphan` about a box that is not this run's. Nothing in this diff constrains the semantics; if the driver contract is exact-match this is moot.

**[LOW] `statusRun` never surfaces `skippedRecords` on the readable-record path, contra its own interface doc**
- `src/fleet/status.ts:559-561` (interface doc: "Present on … a `statusRun` row whose verdict those files could contradict") vs the sole construction site at `status.ts:614-620` (ENOENT/orphan only)
- Trigger: record readable but the directory listing skipped other files. The row ships with no caveat even though the docstring reserves the field for exactly this condition. Doc/behavior drift in a contract-shaped interface.

## Checked and found sound

- `isWellFormed` surrogate scan and `repairLoneSurrogates` code-point iteration are both correct (pair consumption, high-at-end, low-first, cap-slice-then-repair ordering).
- `NO_CONTROL_CHARS` runs on the raw string before `.url()`, correctly closing the WHATWG tab/LF/CR-stripping bypass the comments describe; `/g` matcher shared across `.replace` calls is safe (lastIndex reset per call).
- Join produces no duplicate rows; claim set covers open + closed records by both `runId` and `vmName`; `boxes === null` degrades every row honestly (`boxUnknown` / `boxAlive` omitted / `listUnavailable`) with no silent empty-fleet exit 0.
- Retry-deadline math in `listOwnedBoxes` is genuinely bounded (no doubled timeout; zero-budget guard is correct about `setTimeout(…, 0)` semantics).
- `extractZodErrorField` preserves the non-empty-label invariant on all three arms, including all-control-char key names.
- `manifestPath` traversal guards (`..` on both separators, absolute/drive/UNC forms, blank, control chars, lone surrogates) hold; deliberate `.` allowance resolves nowhere new.
- Registry exit codes match every `FleetError` thrown in this chunk (status: 1/2/4 all declared).
