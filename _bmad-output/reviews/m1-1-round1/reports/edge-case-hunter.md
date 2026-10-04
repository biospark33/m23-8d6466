# Edge Case Hunter — M1.1 round 1

Input: `/tmp/m1-review-diff.txt` (read fully, 4844 lines) + repo collaborators traced:
`src/hindsight/client.ts`, `src/hindsight/schemas.ts`, `src/hindsight/bank-provisioner.ts`,
`src/hindsight/mulch-importer.ts`, `src/hindsight/round-trip-verifier.ts`, `src/lib/file-lock.ts`,
`scripts/lib/cli-args.ts`, `scripts/provision-hindsight-banks.ts`, all `scripts/p0-9/*.ts`,
test harnesses in `tests/hindsight/client.test.ts` and `tests/provision-hindsight-banks.test.ts`.

19 findings: 3 HIGH, 6 MEDIUM, 8 LOW, 2 SPECULATION. Every finding cites a code path actually read.

## HIGH

### H1. Trailing slash on HINDSIGHT_BASE_URL bypasses the wrong-instance trap entirely
- **Severity:** HIGH
- **Where:** `scripts/p0-9/leg-lib.ts:103` (`origin.endsWith(":8888")`), `scripts/p0-9/leg-lib.ts:253` (`requireBaseUrl` returns the raw, un-normalized string)
- **Unhandled input:** `HINDSIGHT_BASE_URL=http://127.0.0.1:8888/` (or `…:18889/`)
- **Failure:** `"http://127.0.0.1:8888/".endsWith(":8888")` is false, so `forbiddenOrigin` returns null and every driver proceeds. `HindsightClient`'s constructor strips trailing slashes (`src/hindsight/client.ts:134`), so client calls land exactly on the tenant sidecar `:8888`; raw probes build `${baseUrl}/v1/...` → `http://127.0.0.1:8888//v1/...` — same host. The trailing-slash-tolerant client teaches operators the slash is harmless, and one character defeats the exact negative control (AC1) this diff is built around. No normalization (`new URL(...).port`, or trim + trailing-slash strip) happens anywhere before the suffix test.

### H2. The provisioner CLI's base-URL guard checks only unset — never the trap ports
- **Severity:** HIGH
- **Where:** `scripts/provision-hindsight-banks.ts:161-170` (`checkHindsightBaseUrl`), client built at `:322-324`; no `forbiddenOrigin` anywhere in the file (grep: 0 hits)
- **Unhandled input:** `HINDSIGHT_BASE_URL=http://127.0.0.1:8888` explicitly set (the trap value itself), with or without `--no-bridge-probe`
- **Failure:** The guard only rejects unset/empty. An explicitly-set trap origin passes, `new HindsightClient({ baseUrl: … })` is constructed, and `provisionBanks` writes `qds-` banks into the shared tenant sidecar — the foreign-bank incident class INV-MEM-1 exists to prevent, and the exact "wrong-instance path story AC1's negative control fails" the guard's own comment claims to close. The leg drivers trap-check via `requireBaseUrl`; the CLI does not, despite both lanes sharing the comment "guarding BOTH lanes".

### H3. INV-MEM-1 `qds-` prefix guard exists only in the CLI — none of the leg drivers enforce it
- **Where:** `scripts/p0-9/provision-and-import.ts:458`, `scripts/p0-9/idempotency-rerun.ts:258`, `scripts/p0-9/round-trip-dedicated.ts:184-185`; `provisionBanks` validates only `BankIdSchema` (`src/hindsight/bank-provisioner.ts:371`), which accepts any `^[a-z0-9]…` id
- **Severity:** HIGH
- **Unhandled input:** `QDS_REPO_SLUG=myrepo`, or simply running a driver from a directory whose basename isn't `QDS-*` (e.g. `cd scripts/p0-9 && bun provision-and-import.ts` → cwd basename `p0-9`)
- **Failure:** `resolveBankId("myrepo")` → `"myrepo"` → banks `myrepo`, `myrepo-dev-meta` (+ collective) are created, retained into, and round-tripped — non-`qds-` bank ids on the dedicated instance, leg exits 0. The CLI's `checkBankPrefix` was written precisely because `provisionBanks` doesn't enforce the prefix, but the six new drivers (which provision the same roster through the same function) never call it. Story invariant "every bank id explicit and qds--prefixed" is unenforced on the paths most likely to run on VPS day.

## MEDIUM

### M1. Leg lock's 5-minute staleness window can be overrun by the leg's own mint loop
- **Severity:** MEDIUM
- **Where:** `scripts/p0-9/provision-and-import.ts:72` (`LEG_LOCK_STALE_MS = 300_000`), `:558` (`isStale: ageMs >= …` — steals on age alone), mint retains at `:312` (serial per entry per bank, each with the client's 30s per-request budget)
- **Unhandled state:** a healthy-but-slow run (modest corpus × 3 banks × network latency) whose window exceeds 5 minutes
- **Failure:** a second provision-family driver legitimately steals the lock mid-window and opens its own diff window; both run concurrently — exactly the misattribution the lock exists to prevent. Driver A's compensation can then delete banks driver B created (they're in A's `post∖pre`), and A's `release()` merely records `warn-taken-over` after the damage. The 300s constant was derived for "3 banks × consolidate timeout" in the provisioner; the leg's window adds a full corpus import the constant never accounted for.

### M2. The leg lock does not serialize against the provisioner CLI (different lock files)
- **Severity:** MEDIUM
- **Where:** drivers lock `~/.hindsight/provision-leg.lock` (`provision-and-import.ts:552`, `idempotency-rerun.ts:349`); the provisioner CLI locks `~/.hindsight/provision.lock` (`src/hindsight/bank-provisioner.ts:126`)
- **Unhandled state:** an operator runs `bun scripts/provision-hindsight-banks.ts` (the closure plan's own command shape for this leg) while a leg's diff window is open
- **Failure:** the CLI's creates land inside the leg's `post∖pre` diff; if the leg then fails, its compensation deletes the CLI's banks. The lock family comment claims serialization "against EACH OTHER" only — leg-vs-CLI interleaving on the same instance and the same roster ids is unguarded.

### M3. negative-probes' bank extractor accepts only the `{banks:…}` shape — zero-banks proof can be vacuously green
- **Severity:** MEDIUM
- **Where:** `scripts/p0-9/negative-probes.ts:88-108` (handles bare arrays and `raw.banks` only)
- **Unhandled input:** a listBanks payload shaped `{items:[…]}` or `{data:[…]}` — both tolerated by the provisioner (`src/hindsight/bank-provisioner.ts:220`) and by the provision/idempotency drivers' own copies of the extractor
- **Failure:** both before/after snapshots extract to `[]`, `rosterUnchanged` is computed `[] === []` → true, and the "zero banks created" claim is recorded as proven when nothing was actually diffed. The divergence between the three in-file copies of `extractBankIds` is itself the drift that produced this.

### M4. Driver's corpus retain drops the importer's 100KB wire-size guard — one oversized entry fails the whole leg and triggers full rollback
- **Severity:** MEDIUM
- **Where:** `scripts/p0-9/provision-and-import.ts:276-291` (`canonicalJsonl`) and `:312` (raw retain), vs `src/hindsight/mulch-importer.ts:319-327` (the B-2/E-11 fix: entries whose wrapping JSONL exceeds 102,400 bytes are skipped per-entry precisely because this is a real occurrence)
- **Unhandled input:** an expertise entry near/over the 100KB wire cap
- **Failure:** the server rejects the retain, `mintCorpus` records a failure for every remaining bank, `failed = true`, and compensation deletes the entire successfully-provisioned roster. The driver re-implemented the call site one fix behind the importer it says it mirrors.

### M5. `.mulch/expertise` default is cwd-relative — wrong cwd silently yields a green leg with an empty mint
- **Severity:** MEDIUM
- **Where:** `scripts/p0-9/provision-and-import.ts:484` (`expertiseDir ?? ".mulch/expertise"`), `loadCorpus` `:303-306` (absent dir → note, empty arrays, zero failures)
- **Unhandled input:** running the driver from any directory other than the repo root (no `QDS_REPO_SLUG`-style absolute override exists for the corpus dir)
- **Failure:** "expertise dir absent" is recorded only as a note inside the mint step; provision is green, mint arrays are empty, leg exits 0 — hollow closure evidence (M1.3's reader contract has nothing to read) with no non-zero exit to flag it.

### M6. `deps.baseUrl` is never threaded into the constructed client — live-mode runLeg with an injected origin silently falls back to `:8888`
- **Severity:** MEDIUM
- **Where:** `scripts/p0-9/hindsight-live.ts:254`, `provision-and-import.ts:548`, `idempotency-rerun.ts:344` — all construct `new HindsightClient(mode === "live" ? {} : { mode: "mock" })`; `src/hindsight/client.ts:49,134` default to `http://127.0.0.1:8888` when env is unset
- **Unhandled state:** `runLeg({ mode: "live", baseUrl: <checked origin>, … })` with no `deps.client` and `HINDSIGHT_BASE_URL` unset
- **Failure:** the trap-checked `deps.baseUrl` governs only the driver's raw fetches; every client call (createBank/deleteBank/retain/listBanks) goes to the silent default — the tenant sidecar. `round-trip-dedicated.ts:200` threads `baseUrl` into its constructed client correctly, so the hazard is an internal inconsistency, not a policy. Via `main()` this is unreachable (env-sourced), but `runLeg` is the exported contract the story pins.

## LOW

### L1. Driver-local `rand6()` can return fewer than 6 chars — or empty
- **Severity:** LOW
- **Where:** `scripts/p0-9/negative-probes.ts:84`, `scripts/p0-9/auth-retired-check.ts:93` (`Math.random().toString(36).slice(2, 8)`) vs the loop-guarded version at `scripts/p0-9/leg-lib.ts:157-161` (which exists precisely because `slice(2)` output length is unbounded-below)
- **Unhandled input:** a `Math.random()` draw whose base-36 fraction has <6 significant digits (~1e-8/run)
- **Failure:** `qds-does-not-exist-` (trailing hyphen) fails `BankIdSchema`, `assertBankId` throws 422 (`src/hindsight/client.ts:515-528`), the probe is classified `http_422` and the leg fails with the misattributed message "nonexistent-bank probe did not refuse with 404".

### L2. `deleteBank`: a 2xx body without `deleted_count` is reported as `deleted:true`
- **Severity:** LOW
- **Where:** `src/hindsight/client.ts:208-220`
- **Unhandled input:** 200 body `{success:true}` with `deleted_count` absent — optional per the DeleteResponse shape the docstring itself cites (`{success, message?, deleted_count?}`)
- **Failure:** a bank that was not deleted (count absent) is recorded `deleted:true, alreadyGone:false` in every compensation/probe-cleanup outcome vocabulary, overstating what the server confirmed. Only the literal `0` and the 404 map to already-gone.

### L3. auth-retired's raw cleanup fallback maps any 2xx to "deleted" — including the missing-bank 200/`deleted_count:0`
- **Severity:** LOW
- **Where:** `scripts/p0-9/auth-retired-check.ts:191-192` (`404 → already-gone; res.ok → deleted`)
- **Unhandled input:** 200 with `deleted_count:0` — the exact 0.10.0 missing-bank shape the client method itself maps to already-gone (`client.ts:212-214`)
- **Failure:** when `deps.client.deleteBank` is absent (the tests' injected-fetch shape), the evidence records `"deleted"` for a bank that never existed — the two cleanup paths in the same leg disagree on vocabulary.

### L4. `deriveCredential` returns an empty `deps.authHeader` as-is — probes run with `Authorization: ""`
- **Severity:** LOW
- **Where:** `scripts/p0-9/auth-retired-check.ts:97-98` (`if (deps.authHeader !== undefined) return deps.authHeader;`) vs hindsight-live's `authValue` (`hindsight-live.ts:209-212`) which treats `""` as absent
- **Unhandled input:** `deps.authHeader: ""`
- **Failure:** the key-known proof and cross-bank probe send an empty Authorization header and are classified as if a real credential were configured; `credentialSource` records `"deps.authHeader"`.

### L5. CLI base-URL guard accepts whitespace-only values
- **Severity:** LOW
- **Where:** `scripts/provision-hindsight-banks.ts:165` (`if (!baseUrl)`) vs leg-lib's trim check (`leg-lib.ts:244`)
- **Unhandled input:** `HINDSIGHT_BASE_URL="   "` (truthy)
- **Failure:** the guard passes, the client is constructed with baseUrl `" "`, and the first request fails as a URL-parse 502 envelope instead of the self-explanatory `base_url_required` refusal — fail-closed eventually, but via the wrong door and after client construction the guard exists to precede.

### L6. `QDS_HINDSIGHT_CONTAINER=""` is not treated as unset
- **Severity:** LOW
- **Where:** `scripts/p0-9/hindsight-live.ts:164` (`process.env.QDS_HINDSIGHT_CONTAINER ?? "hindsight-qds"`)
- **Unhandled input:** the env var exported empty (the classic `export X=` slip)
- **Failure:** `docker inspect ''` fails; the digest step fails the leg with the confusing tail `docker inspect  failed: exit signal` (`image.status === null` renders as "signal" in `dockerErrTail`) instead of falling back to the default container name.

### L7. `QDS_PROBE_DOWN_URL=""` produces a green "unavailability proof" from a local TypeError
- **Severity:** LOW
- **Where:** `scripts/p0-9/negative-probes.ts:190` (`?? PROBE_DOWN_DEFAULT` — empty string is not nullish), `:337` (any catch ⇒ `downRefused = true`)
- **Unhandled input:** the override env exported empty
- **Failure:** `fetch("")` throws a URL-parse TypeError, the catch classifies it `transport-error` and sets `downRefused = true` — the unavailable-instance probe "passes" without ever targeting an origin. The class string is visible in evidence but nothing distinguishes garbage-URL from genuinely-refused.

### L8. A live run's outcomes (incl. residue names) are lost when the evidence write itself fails
- **Severity:** LOW
- **Where:** `scripts/p0-9/leg-lib.ts:199-201` (`mkdirSync`/`writeFileSync` can throw: unwritable dir, dir-path-is-a-file, ENOSPC), called only in each driver's `main()` *after* `runLeg` resolved
- **Unhandled state:** the instance was already mutated (provisions, compensations, residue) and then the evidence write fails
- **Failure:** `main().catch` prints one stderr line and exits 2 — the steps, `deleteOutcomes`, and `residue` arrays exist only in the discarded `LegEvidence` object. For a story whose deliverable is the evidence file, the failure path records nothing about what needs manual cleanup.

## SPECULATION

### S1. The mint record's idempotency claim rests on server-side `document_id` semantics nothing in the repo verifies
- **Severity:** SPECULATION (MEDIUM if it bites)
- **Where:** `scripts/p0-9/provision-and-import.ts:316` sends `document_id` on a raw retain; the consumed `mulch-importer.ts` never sends `document_id` (its dedup is content-hash + trusting the server's `status: "created" | "updated"`, `mulch-importer.ts:328-345`)
- **Unverified assumption:** Hindsight 0.10.0 treats `document_id` as an upsert key
- **If false:** every rerun appends duplicate corpus entries, and M1.3's "re-derive the ids" reader contract reads back N×K entries. The idempotency-rerun leg proves only *bank*-level idempotency — no leg checks memory-level idempotency after re-import. Worth one live check before the mint record becomes load-bearing.

### S2. Raw probe bodies are recorded into evidence unmasked
- **Severity:** SPECULATION (LOW)
- **Where:** `scripts/p0-9/hindsight-live.ts:290,300` (`ext.rawRetainBody = retain.text` — verbatim by design, no `maskTail`)
- **Unverified assumption:** the server never echoes request headers (incl. `Authorization`) in a response body
- **If false:** a token lands in the closure-dir evidence JSON, violating INV-HM1. `maskTail` is applied to every *tail* but deliberately not to the raw bodies the schema amendment is derived from — a one-line `maskTail` over the raw text would close it without harming the shape evidence.

---
Method note: `parseArgs`' in-place bool-flag splice (`provision-hindsight-banks.ts:62-66`) was walked against `cli-args.ts` grammar (`--no-bridge-probe=true` → unknown-flag throw; `--repo-slug --no-bridge-probe` → same missing-value error with or without the splice; both call sites pass fresh arrays) — no finding. `writeLegEvidence`'s filename collision space (ms timestamp + loop-guarded rand6) and the test files' global fetch restore (`tests/hindsight/client.test.ts:102-104`, `tests/provision-hindsight-banks.test.ts:29-40`) were checked — no finding. The mock-mode negative-probe run failing (exit 1) is documented-intentional ("never silently green"), not reported.
