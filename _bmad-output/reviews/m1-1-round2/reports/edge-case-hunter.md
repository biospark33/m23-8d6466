# Edge Case Hunter — Round 2 (M1.1 dedicated Hindsight VPS)

Method: walked every branching path and boundary condition in the round-2 diff
(/tmp/m1-review-diff-r2.txt) against the landed collaborators
(src/hindsight/client.ts, src/hindsight/bank-provisioner.ts, src/hindsight/schemas.ts,
src/lib/file-lock.ts, scripts/lib/cli-args.ts, src/hindsight/mulch-importer.ts).
Only unhandled edge cases with traced code paths are reported. Adversarial
inputs on the priority surfaces that turned out HANDLED are listed at the end
(checked, not reported).

---

## HIGH

### E-01. Leg lock (900 s budget) is stolen by any provisionBanks caller at 300 s mid-window — compensation then deletes another process's banks
- Severity: HIGH
- Files: `scripts/p0-9/leg-lib.ts:176` (LEG_LOCK_STALE_MS = 900_000), `scripts/p0-9/provision-and-import.ts:570-576` / `scripts/p0-9/idempotency-rerun.ts:363-369` (acquire with the 900 s predicate), `src/hindsight/bank-provisioner.ts:123` + `:144-148` (LOCK_STALE_MS = 300_000; steal on age alone), `src/lib/file-lock.ts:100-115` (trySteal honors the CALLER's isStale).
- Unhandled state: a leg diff-window alive for >= 300 s — plausible by construction: the mint loop is `corpus entries x 3 roster banks` sequential `client.request("POST", ...)` calls, each with the client's RETAIN_TIMEOUT_MS = 30 s ceiling (src/hindsight/client.ts:44), plus consolidate latency — while a concurrent CLI (or any `provisionBanks` fresh run) starts.
- Traced failure: the CLI's `acquireLock` hits EEXIST, calls `trySteal`; its `isStale({ageMs})` is `ageMs >= 300_000` — TRUE at t=300 s against the leg's LIVE lock; the leg never rewrites the lock body, so the claim's content re-verification matches (`content === raw`), the lock is `rmSync`'d, and the CLI acquires and provisions INSIDE the leg's open diff window. The leg's post-minus-pre diff then attributes the CLI's created banks to itself; if the leg subsequently fails (e.g. a mint failure), its compensation loop deletes exactly that diff — i.e. it deletes the CLI's banks. The leg's own `release()` throws ("taken over") and is only a `warn` diagnostic. The F-005 claim in provision-and-import.ts:24-26 ("a concurrent CLI/other-caller run fails its own lock instead of interleaving creates into this attempt's diff") holds only for the first 300 s of a window the same file budgets at 900 s. The budget fix protected leg-vs-leg only; the provisioner/CLI family member still steals at one third of the window.

### E-02. CLI pre-provision snapshot fails OPEN to the fresh lane — one transient listBanks failure on a rerun mints the `qds-factory-2` junk F-025 exists to prevent
- Severity: HIGH
- File: `scripts/provision-hindsight-banks.ts:398-403`
- Unhandled input: second run of the CLI against an already-provisioned repo whose FIRST listBanks throws once (10 s recall-timeout ceiling on a loaded VPS, momentary 502) and then recovers.
- Traced failure: the `catch { }` resets `existingBankIds = []` "empty snapshot -> fresh lane"; `isRerunProvision([], slug)` is false, so the run takes `provisionBanks` verbatim. Inside provisionBanks the (now-recovered) listBanks sees the existing `qds-factory` base, the resolver treats it as a foreign collision (`resolveRepoBankId`, bank-provisioner.ts:200-207) and mints `qds-factory-2` (+ its `-dev-meta`). The inline comment's justification — "provisionBanks owns the failure envelope (-32002)" — only holds if listBanks fails AGAIN inside provisionBanks; a single blip that recovers provisions "successfully" against junk ids. This is the dual-caller asymmetry: the leg drivers ABANDON the window on snapshot failure (provision-and-import.ts:407-416, fail-closed); the CLI fails open and recreates the exact incident class the fix landed to close, breaking the AC3 "run twice creates nothing new" demo under flake.

## MEDIUM

### E-03. The CLI's rerun lane mutates the roster with NO provision-family lock at all
- Severity: MEDIUM
- Files: `scripts/provision-hindsight-banks.ts:427` and `:444` (rerun lanes pass no `holdProvisionerLock`), `scripts/p0-9/leg-lib.ts:556-565` (rerun branch loops `client.createBank` directly — never routes through provisionBanks' acquireLock).
- Unhandled state: base bank present but `base-dev-meta` absent (an earlier run died mid-roster — exactly the state the -dev-meta suffix discipline anticipates) while a leg driver's locked diff window is in progress.
- Traced failure: the CLI's rerun branch executes unlocked `createBank(base-dev-meta)` inside the leg's serialized window. The leg's post-minus-pre diff picks the CLI's creation up as its own `createdInAttempt`; on any later leg failure its compensation deletes that bank — cross-process deletion of a bank the leg did not create, the precise interleaving F-005's lock family was widened to prevent. (PUT-upserts of already-existing roster ids are benign; the create of a MISSING roster member is not.)

### E-04. hindsight-live's health probe and raw shape probe have no timeout budget — a half-open connection hangs the leg forever, no evidence, no exit
- Severity: MEDIUM
- File: `scripts/p0-9/hindsight-live.ts:225-260` (`rawCall`: plain `await fetchImpl(...)` + `await res.text()`, no AbortController) and `:371-383` (health probe, same shape).
- Unhandled input: an instance that completes TCP + headers and then stalls the body (wedged container, half-open connection) — health answers 2xx first, so the shape probe is issued against the same stalled peer.
- Traced failure: both `await`s are unbounded; the driver never reaches `finalize`, `writeEvidenceOrStderr`, or any exit code. Contrast the sibling legs, which the diff explicitly budgeted: negative-probes.ts `fetchWithBudget` (PROBE_DOWN_TIMEOUT_MS = 5 s) and auth-retired-check.ts `rawCall` (PROBE_TIMEOUT_MS = 10 s). The driver contract "Resolves LegEvidence for EVERY outcome" is broken by an indefinite hang — the VPS-day leg produces nothing at all.

### E-05. auth-retired-check narrates a "refused-unclassified" probe (429/500/503, proxy-rewritten status) as "the unauthenticated probe was ANSWERED"
- Severity: MEDIUM
- Files: `scripts/p0-9/auth-retired-check.ts:388-390` (class falls to `refused-unclassified` when neither 401/403 nor 404/422 was refused), `:510-516` (`dangerRetired = class === "refused-auth"` -> false; `refusedNonAuth = class === "refused-non-auth"` -> false), `:178-198` (`buildContainmentStatement` else-branch).
- Unhandled input: a rate-limiting reverse proxy or an auth filter in front of the instance returning 429 (or any non-{401,403,404,422} status) for the unauthenticated retain/recall; equally, a proxy that rewrites the origin's 401 to a 502.
- Traced failure: `measured` is true, `dangerRetired` false, `refusedNonAuth` false, so `buildContainmentStatement` falls into the final else and the evidence file asserts "the unauthenticated probe was ANSWERED — the 0.8.6 no-auth danger is NOT retired". The probe was REFUSED with an unclassified status, not answered; the always-present containment statement — the field reviewers read for the verdict — states a measurement that did not happen. The F-007 status-class discrimination added 404/422 but left every other refusal status narrating the answered branch.

### E-06. macOS case-insensitive spelling escapes the mock-in-closure-dir refusal when the final path segment does not yet exist
- Severity: MEDIUM
- Files: `scripts/p0-9/leg-lib.ts:245-247` (`realPathIfReachable` falls back to LEXICAL `path.resolve` for nonexistent paths), `:259-264` (`isInsideClosureDir` string prefix compare), `:277-289` (`resolveEvidenceDir` refusal).
- Unhandled input (darwin — this repo's platform; /Users/steve/QDS-Factory and /Users/steve/qds-factory are the same volume): a mock-mode run with `outDir = <repo>/_bmad-output/evidence/P0-9-CLOSURE/sub` — the closure segment misspelled in case AND the final segment (`sub`) not yet existing.
- Traced failure: `realpathSync(outDir)` throws (the path does not exist under any spelling), so the candidate is compared LEXICALLY; the case-different string is not a prefix match on the real closure path, the refusal never fires, and `writeLegEvidence`'s `mkdirSync(dir, {recursive:true})` case-folds onto the existing `p0-9-closure` directory on APFS — the mock-stamped evidence file lands under the real `_bmad-output/evidence/p0-9-closure/`. The F-009 fix's own test comment claims "no spelling escapes the policy"; the escape is exactly the nonexistent-path branch where realpath cannot canonicalize. Defeats the AC2 negative control (mock standing in for live VPS-day evidence).

## LOW

### E-07. LegEvidence.origin (and negative-probes' downOrigin) are recorded UNMASKED — userinfo-bearing origins leak credentials into evidence files
- Severity: LOW
- Files: `scripts/p0-9/leg-lib.ts` (LegEvidence.origin; only `stderrTail` is maskTail'ed in every driver's `finalize`), `scripts/p0-9/hindsight-live.ts:425`, `provision-and-import.ts:607`, `idempotency-rerun.ts:400`, `round-trip-dedicated.ts:197`, `negative-probes.ts:430` (`downOrigin`), `auth-retired-check.ts:534`.
- Unhandled input: `HINDSIGHT_BASE_URL=http://user:pass@host:18890` (or `QDS_PROBE_DOWN_URL` with userinfo) — passes `forbiddenOrigin` (no trap port) and every guard.
- Traced failure: the credential-bearing origin is written verbatim into the `origin` field of every closure-dir evidence JSON while INV-HM1's contract says tokens never land in recorded evidence; `maskTail` is applied to tails only, never to the origin field.

### E-08. forbiddenOrigin layer-1 false positive: a dedicated-origin URL whose PATH tail matches a trap suffix is refused as a trap
- Severity: LOW
- File: `scripts/p0-9/leg-lib.ts:142-160` (normalized `endsWith` runs FIRST and terminates the check before the URL-port layer).
- Unhandled input: `HINDSIGHT_BASE_URL=http://127.0.0.1:18890/prefix:8888` (any origin with a path/query component ending in `:8888` or `:18889`).
- Traced failure: layer 1 matches the string tail and returns `base_url_trap` although layer 2's URL parse (which never runs once layer 1 hits) would report port 18890 — the DEDICATED instance is refused. Fail-closed direction, so not a wrong-instance write, but a legitimate origin shape is unconditionally rejected with a misleading refusal code. (Note: the elision probe `http://127.0.0.1:8888/../x` itself IS caught — by layer 2's URL port — see "checked and handled" below.)

### E-09. round-trip-dedicated's repo-slug default diverges from every other driver — the round trip can verify a bank this environment never provisioned
- Severity: LOW
- File: `scripts/p0-9/round-trip-dedicated.ts:170` (`QDS_REPO_SLUG ?? "qds-factory"` literal) vs `hindsight-live.ts` / `provision-and-import.ts:504` / `idempotency-rerun.ts` (`QDS_REPO_SLUG ?? basename(process.cwd())`).
- Unhandled state: driver run from a checkout whose basename is not `QDS-Factory` with `QDS_REPO_SLUG` unset.
- Traced failure: the provision legs resolve the cwd slug and (correctly) fatal on a non-qds- resolution, while the round-trip leg silently verifies against the hard-coded `qds-factory` — leftover state from an earlier context passes the make-or-break AC1 leg in an environment where provisioning never ran.

### E-10. maskTail's generic value matcher truncates at `&` and whitespace — credential values containing them leak their tail
- Severity: LOW
- File: `scripts/p0-9/leg-lib.ts:206` (value class `[^&\\s"']+`).
- Unhandled input: a response body tail like `{"apiKey":"ab&cd"}` (mask records `{"apiKey":"***&cd"}` — the `&cd` fragment survives) or a space-containing token (`Bearer a b` masks only `a`, leaving ` b`).
- Traced failure: partial credential material lands in evidence tails; INV-HM1's promise is value-complete masking. Contrived value shapes, but the rule's stated contract is the value, not the value-up-to-a-delimiter.

### E-11. provisionWindow's post-snapshot failure abandons compensation but reports `residue: []` while banks created this attempt remain on the instance
- Severity: LOW
- File: `scripts/p0-9/provision-and-import.ts:428-436` (`return false` with `ext.residue` still `[]`; same shape in idempotency-rerun's snapshot failures).
- Unhandled state: provision creates the roster, then the post `listBanks` fails once.
- Traced failure: the evidence JSON carries `ok:false` with empty `residue` and empty `deleteOutcomes` while up to three created banks are actually stranded; only a step-detail string names the abandonment. A closure-round scraper keying on `residue` concludes clean.

### E-12. mkdirSync of the lock directory sits OUTSIDE the lock try — a file-shaped dirname (or EACCES) crashes runLeg before any evidence is written
- Severity: LOW
- Files: `scripts/p0-9/provision-and-import.ts:571`, `scripts/p0-9/idempotency-rerun.ts:364` (`mkdirSync(dirname(lockPath))` precedes the `try` that wraps `acquireFileLock`).
- Unhandled input: `deps.lockPath` whose parent path exists as a FILE, or an unwritable parent (EACCES).
- Traced failure: the throw propagates out of `runLeg` to `main().catch` — exit 2 with a raw stderr line, but `writeEvidenceOrStderr` is never reached, so no evidence file is produced for this fatal class despite the driver contract "Resolves LegEvidence for EVERY outcome including fatal refusals".

### E-13. slug `qds-collective` is the one base the resolver special-cases but the rerun fork does not — it always takes the rerun lane and mints `qds-collective-dev-meta`
- Severity: LOW
- Files: `scripts/provision-hindsight-banks.ts` checkBankPrefix (passes — "qds-" prefix present) -> `isRerunProvision` (`scripts/p0-9/leg-lib.ts:541-544`), rerun roster `leg-lib.ts:556`; contrast `src/hindsight/bank-provisioner.ts:193-199` (`resolveRepoBankId` skips `safeBase === COLLECTIVE_BANK_ID` and would resolve `qds-collective-2`).
- Unhandled input: `--repo-slug qds-collective`.
- Traced failure: `safeRepoBase("qds-collective")` equals the collective id, which exists on any provisioned instance, so the fork is permanently in the rerun lane; the roster upserts `[qds-collective, qds-collective-dev-meta, qds-collective]`, creating the junk `qds-collective-dev-meta` bank and recording a mint attributed to `resolvedFrom: "qds-collective"` — a divergence between the lane fork and the resolution authority for exactly this id.

### E-14. The rerun lane equates "base id present" with "ours" — a foreign bank holding the resolved base id is PUT-upserted and receives the Mulch corpus
- Severity: LOW (SPECULATION on reachability — requires a same-id foreign bank on the dedicated instance)
- File: `scripts/p0-9/leg-lib.ts:541-566` (rerun branch keyed on `existingBankIds.includes(base)` alone; no provenance marker on the bank distinguishes our base from a same-id foreign one).
- Unhandled state: any other writer (another repo using the same slug, pre-existing tenant-era `qds-` ids) already created `qds-factory` on the instance.
- Traced failure: the fresh path's collision loop (`-2..-11`) exists precisely because base may be foreign; the rerun fork removes that protection whenever the id is present — the foreign bank's config is PUT-overwritten and the corpus minted into it. F-025's comment asserts the presence implies "this leg's own earlier run created it"; that is an assumption, not a check.

### E-15. The driver mint sends `document_id` on the raw wire, but the consumed mulch-importer's retain path never does — cross-path idempotency is unproven
- Severity: LOW (SPECULATION — depends on server-side document_id semantics, unverifiable in-repo)
- Files: `scripts/p0-9/provision-and-import.ts:366-374` (raw `client.request` body `{items:[{content, document_id, metadata}]}`) vs `src/hindsight/client.ts` `retain()` (body `{items:[{content, metadata}]}` — no document_id) used by `src/hindsight/mulch-importer.ts:332`.
- Unhandled state: an operator runs `import-mulch-expertise.ts` against a roster bank that `provision-and-import.ts` already minted (the closure-plan table still lists both commands).
- Traced failure: if 0.10.0 keys memory identity on document_id (the premise the driver's "deterministic, re-derivable, idempotent" claim rests on), the importer's document_id-less writes are NEW entries — the same corpus lands twice per bank with no duplicate signal in either envelope.

---

## Checked and handled (priority surfaces verified, no finding)

- IPv6 hosts: `http://[::1]:8888` / `http://[::ffff:127.0.0.1]:18889` are caught by layer-1's suffix match; bracket-only hosts (`http://[::8888]`) carry no port and are not trap targets. Uppercase scheme/host: the port suffix match is case-insensitive in effect (port digits); layer-2 URL port is lowercase. Default-port elision `http://127.0.0.1:8888/../x`: NOT caught by layer 1 but caught by layer 2 (WHATWG URL normalizes the path, port reads 8888). Leading-zero ports (`:08888`): URL normalizes to 8888, layer 2 catches. Userinfo rendering one host while connecting to the trap (`http://safe@127.0.0.1:8888/`): both layers catch. The genuinely connecting-to-trap direction is closed on both layers.
- parseArgs parameter rebind (F-014): filter operates on a copy; `--repo-slug --no-bridge-probe` throws "requires a non-empty value" after the strip; `--no-bridge-probe=true` throws unknown flag; `--repo-slug=--no-bridge-probe` survives parsing but is refused downstream by checkBankPrefix ("no-bridge-probe" resolves without the qds- prefix).
- CLI env writeback (`process.env.HINDSIGHT_BASE_URL = normalized`): module import does not run main (import.meta.main guard), main is single-shot, and the client is constructed after the writeback — no reentrancy or concurrent-read window.
- realBridgeProbe never throws (every path returns a BridgeProbe), so the new CLI lanes cannot crash without a JSON envelope.
- 401/403 vs 404/422 discrimination in auth-retired-check is conservative on mixed refusals (auth + non-auth present => classified refused-non-auth, dangerRetired false); only the fully-unclassified status escapes (E-05).
- Probe-bank create failure mid-auth-leg: recorded as a `probe-create failed` step and the existence confound is honestly absorbed (404 => refused-non-auth => "neither retired nor live" containment).
- deleteBank (client.ts): 2xx + success:false => 502 rethrow (not swallowed into the 404 catch); numeric-0 vs string-"0" deleted_count semantics pinned; guard runs before fetch.
- `resolveBankId` strips trailing hyphens internally, so `--repo-slug qds-` resolves to "qds" and is REFUSED by the prefix gate — no prefix-loss via truncation/trim.
- leg-lib `safeRepoBase` truncation (52 + trailing-hyphen trim) is byte-identical to the provisioner's `truncateForSuffix` — the rerun fork compares against the id the resolver would actually land on.
- Driver mint's `canonicalJsonl` field order matches mulch-importer.ts:309-316 exactly — document ids are derivation-consistent between the two writers.
