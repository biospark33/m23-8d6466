# Edge Case Hunter — chunk-prov-b (drivers, fake gate, step log, phase-engine)

Scope: `src/providers/driver.ts`, `fake-gate.ts` (new), `fake-driver.ts`, `step-log.ts`, `src/phase-engine/{manifest,types,issue-correlation}.ts`. All line numbers verified against working-tree source on `feature/df3-2-fanout-best-of-n`.

---

**[MEDIUM]** Mid-sequence `store.set` failures escape as raw errno errors, unclassified
- `src/providers/driver.ts:606-613` (vmName/ports write) and `src/providers/driver.ts:649` (httpsUrl confirm)
- Trigger: `driver.create` succeeds → the very next `store.set(opts.runId, {vmName, ports, httpsUrl})` hits EIO/ENOSPC/EACCES → the raw `Error` propagates. Every other failure in this function is reshaped into a `ProvisionRefusedError` (the module's own stated contract: callers classify on `code`/`remediation`, `providerCodePayload` in `src/fleet/dispatch.ts`) — this one reaches the CLI as the unclassified exit-1 "provisioning failed naming no cause" shape the module exists to prevent. State left behind: record OPEN, possibly with NO `vmName` (first write), box live and billing; teardown still reaches it via the runId fallback and prices it (budget was written earlier), but the operator is told nothing actionable.
- Second site (`:649`) is milder: vmName/ports are already recorded, only the address confirm is lost.

**[MEDIUM]** `address()` throws a raw TypeError on a type-violating URL, before vmName is recorded
- `src/providers/driver.ts:408` (`url.trim()` guard), called at `:605` and `:617`
- Trigger: a driver resolves `expose()`/`create()` with `null` (a JS-lie against `Promise<string>` — exactly the boundary class the same file argues for `ExecResult.exitCode` carrying Node's `null`). `null !== undefined` passes the first test, `null.trim()` throws TypeError. It fires BEFORE the vmName write at `:606`, so: box created and billing, record OPEN with no `vmName`, crash is an unclassified TypeError. Secondary nit: when the URL is merely whitespace-padded, the guard trims to TEST but returns the ORIGINAL string — `" https://x "` lands in the record and the return value verbatim.

**[MEDIUM]** `isSubstrateFailure` crashes on a non-array `assertions` from an injected gate
- `src/providers/fake-gate.ts:87-90`
- Trigger: `deps.setupGate` (dispatch-injected, explicitly named in the function's own docstring as a boundary input) returns `{ready:false, assertions:{}}` or `assertions: "boom"`. `(gate.assertions ?? [])` coalesces only null/undefined; `{}.some` / `"boom".some` throws TypeError out of the classifier. The documented fail-closed direction ("unknown ⇒ do not advertise a retry") is defeated by a crash instead of a `false`.

**[MEDIUM]** `substrateFailure` misses negative exit codes — signal-killed probe classified as a manifest verdict
- `src/providers/fake-gate.ts:59-75`
- Trigger: an exec implementation reporting a signaled child as a negative exitCode (Node `spawnSync` convention `-N`; some wrappers normalize `null` to `-15`) falls through every arm: not null/undefined, not 126/127, fails `>128 && <256`. Probe A then reports `ok:false, detail:"exit -15"` with no `SUBSTRATE_MARK` → dispatch maps it to the do-not-retry `logic` arm — the exact misdiagnosis (box broken, sent to inspect the manifest) this function was written to kill.

**[LOW]** `driverListing` fallback puts a prose sentence into `skipped[]`
- `src/providers/driver.ts:266-280` (fallback return), consumed at `:299-310` (`unverifiedVmListingRefusal`)
- Trigger: any driver without `listWithAnomalies` → `skipped.length === 1` where the entry is the sentence "driver X has no listWithAnomalies()…". The refusal then reads "could not account for **1 listing entry** (driver X has no listWithAnomalies…)" and the remediation says "find each entry above from the identifying details it carries" — pointing the operator at prose about the driver, not at a box. Correct fail-closed behavior, misleading count and guidance.

**[LOW]** `displayName` escapes C0/DEL only — Unicode format/bidi controls pass into logs
- `src/providers/fake-driver.ts:47-49`, sinks at `:184`, `:194`, `:234`
- Trigger: a stray directory named with U+202E (RTL override) or U+200B rides verbatim into step-log lines and `skipped` entries — the log-injection class is half-closed (control chars escaped, format chars not). Names come from `readdirSync`, so arbitrary non-`/` bytes are reachable.

**[LOW]** Path exemption's 32-char segment cap over-redacts legitimate long segments
- `src/providers/step-log.ts` (`PATH_TOKEN_RE`, `redactLongToken`)
- Trigger: a ≥40-char path with ANY single segment >32 chars — `node_modules/.pnpm/typescript@5.5.4/node_modules/typescript/lib/typescript.js` style frames, deep CI checkout dirs — fails `PATH_TOKEN_RE` wholesale and comes out fully `«redacted»`, erasing the diagnostic paths these lines exist to carry (unevenly: short-segment siblings survive).

**[LOW]** One bad entry stalls fleet-wide reaping indefinitely
- `src/providers/driver.ts:1150-1157` (any non-ENOENT stat errno → `skipped` → refuse), `:1184-1185` (one untagged box → `reapRuns` refuses), `src/providers/fake-driver.ts:184`
- Trigger: a single `chmod 000` stray directory under the fake boxes root (EACCES on `statSync`) — or one pre-tag-era untagged box — makes every subsequent `reapRuns` AND the DF2.6 sweep (`reaper.ts:320-324`) refuse forever until hand-fixed. Deliberate fail-closed trade, heavily documented; flagged because there is no cap, grace, or aging — one bad directory is a standing DoS on cost reclamation.

**[LOW]** Lock-timeout predicate is a message-string match away from the destructive rollback arm
- `src/providers/driver.ts:391-393` vs throw site `src/providers/run-record.ts:1144`
- Verified matching today. Trigger: any reword of `timed out waiting for the run record lock:` upstream → `isRecordLockTimeout` silently stops matching → a concurrent-writer budget-write failure takes the `rmSync` arm, deleting a record a live writer is about to rename back. Self-flagged with a `ponytail:` comment; needs a two-sided test pinning BOTH the predicate and the throw-site string.

**[LOW]** AC9a stamp check exists only in the fake gate — exedev gate never inspects `limitMicroUsd`
- grep confirms zero `limitMicroUsd` references under `src/providers/exedev/`; fake side enforces it at `src/providers/fake-gate.ts` item B/D
- Trigger: on the real substrate, a fill that delivered an UNSTAMPED manifest passes the setup gate (`ready:true`) and the mismatch surfaces only later inside the box at `scripts/pipeline-run.ts:279-327` (refuses on absent/mismatched witness — that backstop is real and verified). Operator surface diverges per substrate: fake refuses at the gate with per-item evidence; exedev refuses mid-run with less context. Engine is safe either way.

**[LOW]** Canonical slug folding is ASCII-only — non-ASCII case variants remain two budget identities
- `src/phase-engine/issue-correlation.ts:71-73`, applied at `:164` and throughout `src/providers/cost-ledger.ts` (both bind side `:822/:849/:966` and key side `:378`, plus override keys via `canonicalOverrideKey` at `cost-ledger.ts:571`)
- Verified closed for ASCII end-to-end (overrides canonicalized too — mixed-case authored overrides still match). Residual is exactly the self-documented one: `Ünïcode/Repo` vs `ünïcode/repo` hold separate caps; such slugs are already barred from dispatch by `REPO_SLUG_PATTERN`, so exposure is hand-edited ledger rows only.

**[LOW]** Fake-gate item C reports a wrong-type `.env` as a mode mismatch
- `src/providers/fake-gate.ts` item C probe
- Trigger: `.env` present as a DIRECTORY → `stat -c %a` succeeds → detail "mode 755", classified as a delivery-contract miss (do-not-retry). True diagnosis is "fill wrote the wrong thing"; the mode framing sends the operator to chmod rather than re-fill. Race arm (.env vanishing between `-e` and `stat`) is correctly substrate-marked.

## Checked and clean

- `stampManifestLimit` double-call: last-wins overwrite, revalidated, no double-apply; spread of frozen object then `deepFreeze` — no immutability violation; stamp-landed assert closes the optional-schema hole.
- `stripAuthoredLimit`: destructuring copy, no mutation of the frozen original; `resolvedPath` dropped consistently (field made optional at `manifest.ts:495`).
- `serializeManifest`: JSON-only output round-trips through the JSON.parse loader; schema-validated input cannot carry BigInt/circular values.
- `pipeline-run.ts:279-327` reconciles stamped cap vs `run-context.json` witness, refusing on absence AND disagreement — the reader-side hole for the optional field is closed.
- `redactSecrets` ordering (deep-link arm before `keep` park), mark-budget amplification fix, `/g` regexes used only via `.replace` (lastIndex reset), PEM alternation linear-amortized, `asText` guards Symbol/null-prototype — all verified sound. `timedLoggedStep` normalizes `throw null/undefined` (`e ?? {}`, step-log.ts:328) and primitives don't throw on property access.
- FakeDriver lazy root: ENOENT-handled in `listWithAnomalies` (`:145-159`); tests pre-create roots themselves (`tests/providers/fake-driver.test.ts:39,151`); `destroy` force-unlinks — no first-run regression found.
- `reapRuns` partition order (listing → records → ownership → destroy) and the claimed-set semantics (closed records' boxes correctly reaped via the shared owned-predicate).
