# Fix report — fixer-drivers (round 1, wave B)

Scope honored: ONLY the six driver files under `scripts/p0-9/` touched
(hindsight-live, provision-and-import, idempotency-rerun, round-trip-dedicated,
negative-probes, auth-retired-check). `leg-lib.ts` read, never edited; zero
test edits; nothing committed (`scripts/p0-9/` is untracked on this branch).

## Per-finding disposition

### F-002 / F-029 — baseUrl threading + empty-string-as-unset — FIXED (all six)
- hindsight-live, provision-and-import, idempotency-rerun: constructed clients
  were `new HindsightClient(mode === "live" ? {} : { mode: "mock" })` — the
  live path carried NO baseUrl (silent-default exposure on the runLeg
  contract). All three now construct `{ baseUrl, mode }` with the resolved
  value. round-trip / negative-probes already threaded it.
- Uniform guard: all six treat `deps.baseUrl === ""` (and whitespace-only) as
  UNSET — the three provision-family drivers already had the trim guard;
  round-trip / negative-probes / auth-retired-check changed from
  `baseUrl === undefined` to `baseUrl === undefined || baseUrl.trim() === ""`.
- Normalization: deps-carried origins now pass a local 3-line
  `normalizeOriginValue` (trim + strip trailing slashes — the same shape
  leg-lib's env path applies) so the threaded value is the checked value.
  Local per instruction ("replicate the smallest local pattern consistently;
  do NOT add to leg-lib").

### F-004 — INV-MEM-1 qds- prefix gate — FIXED
- provision-and-import + idempotency-rerun: `QDS_REPO_SLUG ?? basename(cwd)`
  now routes through leg-lib `assertQdsRepoSlug` in runLeg BEFORE the lock and
  any bank traffic; violation → recorded `repo-slug` fatal step, outcome
  `fatal-bank-prefix-violation`, exit 2.
- round-trip-dedicated: bankId = `assertQdsRepoSlug(QDS_REPO_SLUG ??
  "qds-factory")` (fatal on violation). Note this also makes the bankId
  safe-base (≤52) — matching what provision-and-import actually CREATES, where
  the old `resolveBankId` (≤64) would have mismatched on >52-char slugs.
- hindsight-live + auth-retired-check: probe bank ids are literal-prefixed;
  they now route through `assertQdsRepoSlug(\`qds-probe…-\${ts}\`)` — the
  shared gate validates the resolver-stable, qds-prefixed form; violation is
  fatal (unreachable by construction, but the gate is no longer bypassed).
- negative-probes: no repoSlug use anywhere (missing-bank id is
  qds-prefixed-by-construction) — nothing to gate, per the task's own carve-out.

### F-005 — provisioner's own lock — FIXED (both provision-family drivers)
- Default lock path changed `~/.hindsight/provision-leg.lock` →
  `~/.hindsight/provision.lock` (bank-provisioner.ts `defaultLockPath`), so a
  concurrent CLI/other-caller run fails its own lock
  (`provision_in_progress`) instead of interleaving creates into the leg's
  diff window. `deps.lockPath` override kept.
- Stale window: local `300_000` consts DELETED; now
  `deps.lockStaleMs ?? LEG_LOCK_STALE_MS` (900s — the hoisted edge-case-hunter
  M1 budget that accounts for the full corpus import inside the window).
- No deadlock: provisioning runs with `noLock:true` (provisionImpl branch
  directly; leg-lib path via `holdProvisionerLock: true`).

### F-006 — extractBankIds hoist — FIXED
negative-probes' local (banks/bank_id-only) extractor DELETED; imports
leg-lib's provisioner-tolerance version (bare arrays, `{banks|items|data}`,
`bank_id|bankId|id`, schema-valid `name`). provision-and-import and
idempotency-rerun's divergent Set-based copies also DELETED for the same
import (F-018-completion).

### F-007 — auth-retired-check refusal classification — FIXED
- Probe bank CREATED before probing: `deps.client.createBank` when available
  (step `probe-create` ok/failed); without a client the create is recorded as
  its own skipped-no-client step and the probe proceeds (0.10.0 lazy-create
  path) — the status-class split below still separates the confound.
- Status classes: 401/403 = auth refusal; 404/422 = non-auth
  (existence/validity). `dangerRetired` is now TRUE only on
  `unauthenticated.class === "refused-auth"`; a 404/422 refusal keeps it
  FALSE with `class: "refused-non-auth"` and the containment statement says
  "refused for NON-AUTH reasons … neither confirmed retired nor demonstrably
  live". Unclassified refusals (e.g. 500) also keep dangerRetired false —
  the old `measured && !answered` would have counted a 500 as "retired".
- Known-key cross-bank class split too: 404/422 →
  `known-key-refused-non-auth-http_N` (distinct from the 401/403
  out-of-scope class); answered + proof → `not-applicable-authz-absent`
  unchanged.

### F-008 — measuredCount + hermetic outcome — FIXED
Evidence carries top-level `measuredCount` (of the three probe outcomes);
`measuredCount === 0` on a green leg yields outcome
`pass: all-probes-skipped-hermetic — …` (still exit 0; the leg records, it
does not gate).

### F-010 — memoryResidue — FIXED
On failed mint, evidence records `memoryResidue` = the mint record
(Record<bankId, {resolvedFrom, documentIds retained before failure}>)
alongside `mintFailures` — the partial retains left in canonical banks are
named, not just the bank-level residue.

### F-011 — per-entry 100KB wire guard — FIXED (one interpretation flagged)
mintCorpus now checks `Buffer.byteLength(canonicalJsonl(entry), "utf8") >
MAX_CONTENT_BYTES` (imported from mulch-importer — the exact
mulch-importer.ts:319-327 rule) per-entry and SKIPS oversized entries.
Recording choice: the task said "record in mintNote/mintFailures"; I record
in **mintNote only** (summary string naming kind `oversized-skipped`, count,
bank/documentId/size per entry). Reason: mintFailures is the
`failed = true` path that compensates by deleting the whole roster — putting
skips there would reproduce the exact bug F-011 files ("one oversized entry
fails the leg and rolls back the whole roster"). The triage's own rationale
says "Mirror importer per-entry skip with recorded mintNote". Flagging in
case the reviewer wants a dedicated array instead of the note string.

### F-012 — corpus dir default — FIXED
`DEFAULT_EXPERTISE_DIR = join(import.meta.dir, "..", "..", ".mulch",
"expertise")` — repo-root-relative from the driver file, never cwd. Live
mode + absent/empty corpus (any `loadCorpus` note) → `failed = true` with
named step `mulch-corpus` / `failed-live-corpus-absent-empty`; mock rehearsal
keeps the note and stays green (pinned mint test unaffected — it reads the
same dir today via cwd === repo root).

### F-021 — PROBE_DOWN_URL_DEFAULT — FIXED
negative-probes' local `http://127.0.0.1:9` literal deleted; imports leg-lib's
`PROBE_DOWN_URL_DEFAULT` (env override via QDS_PROBE_DOWN_URL unchanged,
still trap-checked).

### F-022 — live prereq gate — FIXED, with ONE deliberate exclusion (flagged)
provision-and-import, idempotency-rerun, negative-probes, auth-retired-check:
live-mode runLeg now gates on leg-lib `scanLiveShapePrereq` before any
instance traffic (before lock acquisition / client construction / probes);
refusal → recorded `prereq` fatal step, outcome `fatal-live-shape-prereq`,
exit 2. Mock exempt.
round-trip-dedicated: its private byte-mirror scan DELETED, migrated onto the
leg-lib helper (same reason strings, same newest-first scan).
**Exclusion: hindsight-live is NOT gated** — it is the PRODUCER of the very
evidence the gate scans for; gating it would deadlock the first live run
(shape check could never run because no shape-check evidence exists yet).
F-022's own text says the gate protects legs that CONSUME the instance after
the shape check; the producer cannot order after itself. If the reviewer
disagrees, the one-line gate insert is mechanical.

### F-024 — stderrTail from captured legLog lines — FIXED (all six)
hindsight-live / provision-and-import / idempotency-rerun already had the
recorder pattern (steps + logLines → masked stderrTail) — unchanged.
round-trip / negative-probes / auth-retired-check gained the smallest local
capture (`makeLog(leg, logLines)` wrapper around legLib.legLog; every call
site migrated) and now populate `stderrTail: maskTail(logLines.join("\n"),
{ maxLen: 4000 })`. Nothing added to leg-lib, per instruction.

### F-018-completion — hoisted-helper migration — FIXED
Deleted local copies: `extractBankIds` x3 (provision-and-import,
idempotency-rerun, negative-probes), `MAX_BASE_LEN`/`safeRepoBase` x2 (both
provision-family), unguarded `rand6` x2 (negative-probes, auth-retired-check),
`LEG_LOCK_STALE_MS` x2, round-trip's private `LIVE_EVIDENCE_DIR` mirror and
its private `scanLiveShapePrereq`. All now leg-lib imports. round-trip's
node:fs/node:path imports went with them.

### F-025 — rerunAwareProvision migration — FIXED (provision-and-import only, per scope)
`provisionAttempt` keeps the provisionImpl-injection branch verbatim
(injected WINS — the tests' seam), and its local fresh/rerun fork is DELETED
in favor of leg-lib `rerunAwareProvision` (bridgeProbe literal +
`holdProvisionerLock: true` passed through; helper's per-step mode recording
adapted through a `withElapsed` rec adapter so durationMs survives). Roster
derivation: fresh → `createdInAttempt` (the provisionBanks banks);
rerun → `raw.roster`. idempotency-rerun keeps its own `provisionOnce` —
F-025 was scoped to provision-and-import only; it does import leg-lib
`safeRepoBase`/`extractBankIds`/`COLLECTIVE_BANK_ID` (F-018).

### F-028 — raw body masking — FIXED
hindsight-live masks `rawRetainBody`/`rawRecallBody` with `maskTail` (no
truncation) BEFORE storing; `deriveShapeObservations` still runs on the raw
texts, and shape keys survive masking (the pinned
`{"rawMarker":"retain-RAW-7f3a"}` bodies pass through byte-identical — the
tests confirm).

### F-030 — writeEvidenceOrStderr — FIXED (all six mains)
Every main() routes through leg-lib `writeEvidenceOrStderr`; on `fellBack`
the payload has already landed on stderr as one JSON line, the path line is
skipped, and the exit is forced to 2 — outcomes/residue survive the failed
write.

### L3/L4 (auth-retired-check same-file lows) — FIXED
- `deps.authHeader === ""` now counts as absent in `deriveCredential` and in
  the recorded `credentialSource` (falls through to env, header never sent
  empty).
- Raw-cleanup fallback maps 200 + body `deleted_count: 0` → `already-gone`
  (mirroring client.deleteBank's vocabulary; unparseable 2xx bodies still
  count as deleted).

## Per-driver diff summary
(scripts/p0-9/ is untracked on this branch — no git numstat; sizes are the
resulting file line counts)
- **hindsight-live.ts** (446 ln): imports (+assertQdsRepoSlug,
  writeEvidenceOrStderr), local normalizeOriginValue, probe bank id via the
  prefix gate (computed in runLeg, fatal-capable, passed into rawShapeProbe),
  client construction now `{baseUrl, mode}`, F-028 masking on both raw
  bodies, main → writeEvidenceOrStderr. NOT prereq-gated (see F-022 flag).
- **provision-and-import.ts** (629 ln): header doc rewritten for the lock
  change; deleted local extractBankIds/safeRepoBase/MAX_BASE_LEN/
  LEG_LOCK_STALE_MS; provisioning migrated to rerunAwareProvision
  (provisionImpl branch kept); F-004 slug gate, F-022 prereq gate, F-005
  provision.lock + LEG_LOCK_STALE_MS/deps.lockStaleMs, F-010 memoryResidue,
  F-011 wire-size skip (+`oversized` return + mintNote), F-012
  DEFAULT_EXPERTISE_DIR + live-empty-corpus failure, client `{baseUrl,mode}`,
  main → writeEvidenceOrStderr.
- **idempotency-rerun.ts** (421 ln): same shared changes (slug gate, prereq
  gate, lock path/stale, client baseUrl, helper imports, main) — provisionOnce
  body intentionally retained (F-025 scoped to provision-and-import).
- **round-trip-dedicated.ts** (280 ln): private LIVE_EVIDENCE_DIR +
  scanLiveShapePrereq deleted (leg-lib helper), "" ≡ unset guard, deps-origin
  normalization, bankId via assertQdsRepoSlug (fatal), makeLog capture →
  stderrTail on every evidence shape, main → writeEvidenceOrStderr.
- **negative-probes.ts** (457 ln): local PROBE_DOWN_DEFAULT/rand6/
  extractBankIds deleted (leg-lib), "" ≡ unset guard + normalization, live
  prereq gate, makeLog capture → stderrTail (incl. fatal + buildEvidence),
  main → writeEvidenceOrStderr.
- **auth-retired-check.ts** (597 ln): probe bank created before probing
  (client path + skipped-no-client step), status-class refusal classification
  (auth vs non-auth) on the unauth AND known-key probes, dangerRetired only
  on refused-auth, containmentStatement refused-non-auth verdict,
  measuredCount + all-probes-skipped-hermetic outcome, "" authHeader ≡
  absent, raw-cleanup deleted_count:0 → already-gone, bank id via the prefix
  gate, live prereq gate, "" ≡ unset baseUrl guard, makeLog capture →
  stderrTail, main → writeEvidenceOrStderr.

## Gate outputs (focal, per instructions)
- `bun test tests/p0-9/legs.test.ts -t "hindsight-live"` → **7 pass / 0 fail**
- `-t "provision-and-import"` → **4 pass / 0 fail**
- `-t "idempotency-rerun"` → **1 pass / 0 fail**
- `-t "round-trip"` → **5 pass / 0 fail**
- `-t "negative-probes"` → **2 pass / 0 fail**
- `-t "auth-retired"` → **5 pass / 0 fail**
- Unfiltered `bun test tests/p0-9/legs.test.ts` (cross-check) → **29 pass /
  0 fail**
- `bunx tsc --noEmit` → **0 errors in every file I touched**. The ONLY two
  remaining repo errors are in `scripts/provision-hindsight-banks.ts`
  (TS6133 unused extractBankIds/rerunAwareProvision/safeRepoBase) — that file
  carries another wave's uncommitted 234-line edit and is outside my
  six-file scope; I did not touch it.
- `bunx @biomejs/biome check scripts/p0-9/*.ts` (all six drivers) → **clean**
  ("Checked 6 files … No fixes applied").
- `detect_changes()`/`impact()` not usable: `scripts/p0-9/` is untracked, so
  the GitNexus index has no nodes for these files (same as wave A's report).
  Grep blast radius stood in: only tests/p0-9/legs.test.ts imports the
  drivers (dynamic), leg-lib is imported read-only.

## Test-pin conflicts
NONE — no existing test pinned the old behaviors I changed (no stderrTail:""
pins, no provision-leg.lock path pins — tests always inject lockPath, no
client-construction pins, no dangerRetired-on-500 pins). Zero test edits
needed.

## Flagged decisions (for the diff reviewer)
1. **F-022 hindsight-live exclusion** — producer of the prereq evidence;
   gating it deadlocks the first live run (rationale above).
2. **F-011 recorded in mintNote, not mintFailures** — mintFailures trips the
   compensating-delete path; a skip there would recreate the filed bug.
3. **round-trip bankId is now safe-base (≤52) via assertQdsRepoSlug**, not
   raw resolveBankId (≤64) — aligns with what the provision legs actually
   create; differs only for >52-char slugs (none in tests/fixtures).
4. provision-and-import/auth-retired-check exceed the global ≤500-line style
   rule (629/597) — the task's file scope forbids splitting; the F-numbered
   doc comments are load-bearing for the next review waves. Same known
   deviation class as wave A's leg-lib (622).
