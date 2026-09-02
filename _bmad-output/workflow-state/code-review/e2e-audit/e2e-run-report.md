# DF3 Fleet Live E2E — TIER-1 Run Report

Date: 2026-08-24. Executor: fresh-context session per e2e-plan.md. Branch
`feature/df3-2-fanout-best-of-n`, commit `0349b13` (pushed, PR #128).
Companion: e2e-coverage.md (before-matrix), e2e-plan.md (the plan).

## Headline

**7/7 TIER-1 live tests PROVEN against real exe.dev + real OpenRouter key API,
$0.00 model spend.** Zero leaked boxes at session end. Two HIGH product bugs
found and pinned verbatim (both invisible to the 508 FakeDriver tests — the
audit's thesis confirmed). TIER-2 (dispatch/fanout verbs with real gate C/D
model spend) NOT run: requires per-run spend approval.

## FIX SESSION (2026-08-24, later) — all six actionable findings FIXED, retested LIVE

Fix session on the same branch (commits f3abb96..624c98b, pushed to PR #128).
Every fix: gitnexus impact() before edit (teardownSandbox and deliverRunKey
returned CRITICAL — blast radius stated before proceeding, and it WAS the leak
surface), mutation-verified RED test first, root-cause fix at the shared
function, focal suites green. One commit per fix.

| Finding | Verdict | Fix | Live proof |
|---|---|---|---|
| F3 (HIGH) default fill/key paths unwritable | **FIXED** | `DEFAULT_FILL_WORKDIR="src"`, `KEY_ENV_FILE="app/.env"` — HOME-relative (ssh exec lands in $HOME, the only writable root; image-agnostic, absolute overrides still work); all consumers swept (gate, harvest, dispatch, cap-hit-demo, tests) | T1.3a rewritten from BUG PIN to FIXED PIN: default fill + default env file SUCCEED on a real box (`2026-08-24-220128-t1-3a-fill-default-fixed.json`) |
| F6 (HIGH) teardown leaks box at exit 0 | **FIXED** | destroyTarget = `rec.vmName ?? runId` (the fallback `teardownRun` driver.ts:1099 always promised); idempotent no-op when no box; failure fails closed | unit port of live repro e2e-repro6d (box GONE + record closed); every teardown this session destroyed its box — final ls empty after each test |
| F7 (flake) destroy trusts rm exit 0 | **FIXED** | destroy verifies absence via `list()` after rm exit-0, one retry, then throws (assert-by-real-state) | scripted-seam unit pair (lying rm / stale listing); 10+ live destroys this session, zero survivors |
| F5 (sharp edge) run lock held after destroy+revoke | **FIXED** | finally reads the record: closedAt set ⇒ destroy+revoke+close landed ⇒ lock released with `lock-released-work-landed` note, exit stays 6; record still open ⇒ old lock-held behavior | both arms unit-pinned (RED reproduced the live remediation verbatim); re-invoke reaches the idempotent closed path |
| F8 box-hours 1-hour minimum | **FIXED** | fractional µ$ from wall-clock ms: `ceil(rate × lifetimeMs / 3_600_000)`, integer-safe product check, sub-µ$ rounds UP; DF2.8 story amended in the same commit (whole-hour rows never rewritten) | live T1.4 ledger row `cost_micro_usd: 931` for a ~15s box (was 230,000 = full hour) |
| F4 private repos impossible (INV-CRED-1) | **FIXED (feature)** | bundle-push is the DEFAULT fill mode: HOST fetches the pinned SHA with host creds → `git bundle` → base64 over exec stdin → box clones from the LOCAL bundle; creds never cross the wire; rejected deploy-token/forwarding designs on secret-surface grounds; workdir path grammar validated before script interpolation (security-review hardening 624c98b) | **T1.3a+b PASS against PRIVATE Quantum-Digital-Solutions/QDS-Factory at pushed SHA 624c98b** — default fill, sbx branch, in-box commit, harvest verb exit 0, host bundle verify 0, quarantine fetch 0 (`2026-08-24-220341/220432`) |
| F1 no node in box image | environment fact, no action | documented | — |
| F2 keyHash-less teardown exits 6 | designed, unchanged | — | T1.2/T1.3/T1.6 finallys still 0-or-6 as expected |
| F9 host-load flake family | documented, unchanged | reaper "E2E --yes" + signal-handler + fill-refill tests flake under load-average 250+; ALL pass solo | this session: full suite green at load ≤30 |

Post-fix TIER-1 rerun (each SOLO, real exe.dev, zero model spend, `ssh exe.dev
ls --json` empty after EVERY test): **7/7 PROVEN** — T1.1 (220018), T1.2
(220048), T1.3a+b public (220128/220201), T1.4 (220231), T1.5 (220246), T1.6
(220300), plus the private-repo pair (220341/220432). Full gates:
`bun test tests/fleet/ tests/providers/` **1199 pass / 0 fail / 9 todo**;
biome clean; tsc --noEmit clean; detect_changes 42 symbols / 25 files, every
entry inside the six fix surfaces + tests + the DF2.8 story.

**TIER-2 is unblocked**: the F3+F4 blockers are gone — dispatch can now fill
and deliver keys on a real box, from a private repo, with no workdir seam.

## Per-test verdicts

| # | Test | Verdict | What was proven on real substrate | Evidence (latest) |
|---|---|---|---|---|
| T1.1 | driver lifecycle | **PROVEN** (11 asserts, 17.9s) | whoami answers; create→box in `ls`; exec real commands (python3/git/uname — NOT node, see F1); exec-stdin→file→scp copyFile round-trip byte-exact; destroy→absent from `ls` | `2026-08-24-200507-t1-1-driver-lifecycle.json` |
| T1.2 | provision + status | **PROVEN** (9 asserts, 16.9s) | `createRun` real headroom gate + record→box (INV-1); `status <id>` verb subprocess: state "live", vmName, boxAlive via real provider listing; whole-fleet status exit 0 | `2026-08-24-200419-t1-2-provision-status.json` |
| T1.3a | fill default workdir | **PROVEN (bug pin)** | default fill `/home/agent/src` → `fill-failed`, "Permission denied" — pinned; will fail loudly when fixed, by design of the pin | `2026-08-24-200650…t1-3a…` (latest of 4) |
| T1.3b | harvest verb e2e | **PROVEN** (with fill workdir seam) | real https clone in box at pinned SHA on `sbx/<runId>` branch (relative workdir `src`); real in-box commit; `fleet harvest` verb: in-box `git bundle create` over ssh, scp out, host `git bundle verify` exit 0, quarantine fetch `refs/sandbox/<runId>` = in-box tip | `2026-08-24-200650-t1-3b-harvest-verb.json` |
| T1.4 | teardown verb full chain | **PROVEN** (11 asserts, 22.2s) | real mint POST (cap 5000 µ$); spend-capture GET (0); revoke DELETE + verify; keyHash ABSENT from provider `listAllKeys` after; box ABSENT from `ls`; record closedAt set; **real `cost_events` box_hours row written** (first real fleet ledger write ever); second teardown idempotent exit 0 | `2026-08-24-200453-t1-4-teardown-verb.json` |
| T1.5 | fanout refusal under fleet lock | **PROVEN** | valid `fleet fanout --driver exedev` (schema-valid brief, pin, roster ids) with real FleetLock held → exit 5; provider listing byte-identical before/after; no fan-*.json, no run records (INV-2 "mutates nothing") | `2026-08-24-200435-t1-5-fanout-refusal.json` |
| T1.6 | run lock under concurrency | **PROVEN** | two simultaneous `fleet teardown` subprocesses, same run: winner "torn down" (exit 6 key-unattributable note, box destroyed), loser exit 5 `run-locked` | `2026-08-24-200430-t1-6-run-lock.json` |

Full-suite confirmation: `bun test tests/fleet/e2e/` → 7 pass / 0 fail /
54 expects / 94.7s (2026-08-24 ~20:04). Default-off verified: without env,
7 todo / 0 run.

## Bug list (fix-session input)

### F3 — HIGH, product. Default fill workdir AND key env file are unwritable on the real exe.dev image

- Files: `src/providers/exedev/fill.ts:40` (`DEFAULT_FILL_WORKDIR = "/home/agent/src"`), `src/providers/credentials.ts:51` (`KEY_ENV_FILE = "/home/agent/app/.env"`)
- Symptom (verbatim): `ExeDevDriverError: fill clone exited 128: fatal: could not create leading directories of '/home/agent/src': Permission denied … code: "fill-failed"`
- Root cause: constants assume inkwell-era `/home/agent` user. Real image: ssh user `exedev`, HOME=`/home/exedev`, `/home` root-owned drwxr-xr-x. Neither path can be created. Key delivery (`deliverRunKey` → KEY_ENV_FILE) hits the same wall.
- Impact: `dispatch` verb steps fill AND key-delivery both fail on every real box; the setup gate (which reads the workdir) can never pass. **No dispatch has ever run on a real exe.dev box** — consistent with the audit's 0% real dispatch coverage.
- Repro: `T1.3a` (pinned, deterministic) or by hand: create box, `driver.fill(vm, {runId, repoUrl, commitSha})`.
- Workaround that exists TODAY by design: `FillOptions.workdir` = relative `"src"` (lands `/home/exedev/src`, writable; harvest's `DEFAULT_WORKDIRS` probes relative `app`/`src`, so the verb chain completes — T1.3b proves it).
- Fix direction: default the workdir (and KEY_ENV_FILE) under the ssh HOME (`/home/exedev/...`) or derive from `echo $HOME` at provision time. Constants-only change plus tests.

### F6 — HIGH, product. Teardown verb exits 0 "torn down" while the box LEAKS (record without vmName)

- File: `src/providers/teardown.ts:446-447` — `const vmName = rec.vmName; if (vmName === undefined) { …skip destroy… }`
- Symptom: open record, box live and named after the runId, record has no `vmName` yet (the INV-1 crash window: `store.create` → `driver.create` → crash before `store.set(vmName)`): `fleet teardown <id>` prints `torn down: <id>`, **exit 0**, box still in `ssh exe.dev ls`. Automation reads "nothing left running" — the one thing that is not true.
- Root cause: destroy step has no runId fallback, although `provisionAdmittedRun`'s own comments (driver.ts:558-560, 583-584) promise "teardownRun falls back to the run id, which is what the box is named after". The fallback exists nowhere on this path.
- Repro (deterministic, confirmed twice live + once by hand): create box, write record WITHOUT vmName, run `fleet teardown <id> --driver exedev --no-harvest` → exit 0, box survives. (e2e-repro6d, 2026-08-24 20:02.)
- Live incidents: 3 boxes leaked during early T1.3 iterations (all manually destroyed; `ssh exe.dev ls` empty at session end).
- Fix direction: when record is open and lacks vmName, attempt destroy of the runId-named box (or at minimum refuse nonzero like the key-unattributable note does — exit 0 is the bug, the skip is defensible).

### F7 — UNRESOLVED flake, substrate-suspect. One exit-6 teardown left a box alive (vmName WAS present)

- Incident: 19:36 run `e2e-t13-mt7mz7ps3jq` — teardown verb exit 6 (key-unattributable), record had vmName, box survived; two targeted repro attempts (20:01, 20:02) with identical shape destroyed correctly.
- Suspect: transient in `ssh exe.dev rm` / `ls` (driver.destroy treats "ls no longer names it" as idempotent success — a stale/empty filtered listing would read as already-gone).
- Action for fix session: add post-destroy `list()` verification inside `destroy()` or teardown (assert-by-real-state, the same discipline the tests use).

### F5 — designed-but-sharp. Teardown close-step fail-loud holds the run lock AFTER key+box are already gone

- File: `scripts/fleet.ts:2033-2051` + `cost-ledger.ts` (`box-hour-rate-unconfigured`).
- Symptom (verbatim): `boxHourRateMicroUsd is not configured — an unpriced box hour must surface, not silently cost 0`, then `!! lock-held: … was NOT released — this invocation was interrupted after it began destroying the run`, exit 6. Key already revoked, box already destroyed.
- Cause: attributed run (extensions.budget) + no operator `cost-config.json` beside the records dir. Fail-loud pricing is correct design; the sharp edge is the operator ergonomics (lock file must be rm'd by hand for a run whose billables are already dead) and that box-hours pricing needs a config file nothing prompts you about.
- Test-side resolution: T1.4 supplies `{"boxHourRateMicroUsd": 230000}` and everything goes green.

### F4 — substrate/config requirement. QDS-Factory is PRIVATE; in-box anonymous clone is impossible BY DESIGN

- Box has no GitHub credentials (INV-CRED-1: no second secret in a box) → `git clone` prompts `could not read Username for 'https://github.com'`. Host git "worked" only via local keychain creds — misleading during triage.
- Live fills must point at a PUBLIC repo (prior live runs used `octocat/Hello-World.git`; T1.3 uses it too).
- **Operator requirement on record (2026-08-24): private repos MUST eventually work — customers build proprietary software here.** Design gap to schedule: INV-CRED-1 vs in-box private clone. Candidate designs: (a) host clones + pushes a bundle INTO the box (creds never cross the wire — mirrors harvest in reverse); (b) per-run box-scoped deploy token minted/delivered/revoked through the existing credential lifecycle.

### F2 — designed, verified live. Teardown of a keyHash-less record exits 6 (`key-unattributable`)

`fleet.ts:2051`: `code = keyUnattributable || … ? 6 : 0` with the stderr note "has a box but no keyHash…". Correct fail-loud; T1.2/T1.3/T1.6 finallys expect 0-or-6.

### F1 — environment fact. Box image has NO node

`node --version` → exit 127. Image contract: python3, curl, git, pi (all verified live). Any doc/plan assuming node workloads on boxes is wrong.

### F8 — observation. Box-hours priced at 1-hour minimum

~20s box life priced 230,000 µ$ (= exactly 1h at the configured 230,000 µ$/h). No sub-hour granularity; short-lived boxes overstate by up to 1h each. Matters for cost math at fleet scale.

### F9 — host-load flake (documented family, not a regression)

`tests/providers/reaper.test.ts` "E2E --yes" timed out at 5020ms inside the full suite; solo run: 30/30 pass in 6.2s. No src/ changes from this session touch it.

## Spend

- **Model spend: $0.00.** One key minted at 5000 µ$ cap, spendMicroUsd = 0, revoked + verified. No gate, no engine, no chat call ever ran.
- Box usage: ~13 boxes created across the session (incl. probes/repros), each live 10s–60s, all destroyed; final `ssh exe.dev ls` = empty. exe.dev metering is peak-hourly (CPU $0.05/core-h, mem $0.016/GiB-h) on top of the subscription — session box cost is bounded by roughly one billed hour ≈ $0.23 at the 2CPU/8GiB rate.

## Coverage matrix: before → after (real-substrate e2e)

| Surface | Before (e2e-coverage.md) | After TIER-1 |
|---|---|---|
| ExeDevDriver ssh primitives (whoami/create/list/exec/copyFile/destroy) | 0% | **100% of the 6 primitives + scp** |
| status verb | 0% | **PROVEN** (single + fleet, real listing) |
| harvest verb | 0% | **PROVEN** (fill workdir seam; host verify+fetch real) |
| teardown verb incl. real SQLite ledger WRITE + key revoke/verify | 0% | **PROVEN** |
| dispatch verb (full, with gate) | 0% | 0% — blocked by F3 (+gate spend) → TIER-2 |
| fanout/race/best-of-N arms | 0% | lock-refusal slice PROVEN; arms → TIER-2 |
| rank | 0% | 0% → TIER-2 (needs real fanout records) |
| key API (mint/revoke/verify/list) | 0% | **PROVEN** (mint+list-verify+revoke via T1.4) |

DF3.1 zero-spend surface: majority now real-proven. DF3.2: lock slice only.

## Gates (session)

`bun test tests/fleet/ tests/providers/` → 1183 pass / 9 todo / 1 fail (F9 flake; solo 30/30). `bunx biome check tests/fleet/e2e/` clean. `bunx tsc --noEmit` clean. gitnexus `detect_changes` → 0 changed symbols, risk low (new files only). Commit `0349b13` pushed.

## TIER-2 FINAL (2026-08-25, sessions 2–3) — T2.1 **PROVEN GREEN**, T2.2 **PROVEN GREEN** at HEAD `4804765`

Executor: fresh-context session per handoff, then operator-directed finish.
Fresh spend approval granted in-session (GO for both tests). Branch tip
progression this arc: `1f2830d` → merge origin/main (PR #131 + DF5.1) at
`eaee8bb` → F11 fix `409137d` → F14 fix `ea6dd64` → record-stamp `536c23b`
→ harness commit-fix `94de84a` → T2.2 fixture `ca158fd` → **F15 product fix
`4804765`** (final green SHA for both tests). Tests unchanged in shape;
`config/rosters/t2.pipeline.json` + beside-roster `roster.yaml` as committed.

### Verdicts

| # | Test | Verdict | Final-run evidence (real substrate) |
|---|---|---|---|
| T2.1 | dispatch→engine(seeded-fix)→harvest→teardown | **PROVEN — 37/37 asserts** | evidence `2026-08-25-153706-t2-1-dispatch-engine.json`: dispatch exit 0, ack `{runId qds-20260825-*, vmName, httpsUrl, state:"ready"}`, box LIVE on exe.dev, record carries keyHash + limitMicroUsd=50000 + **commitSha (newly stamped)**, gate **A✓B✓C✓D✓E✓**, delivered manifest stamped limitMicroUsd==effectiveCeilingMicros==50000, seed fails (exit 1) → pi/deepseek-v3.2 fixes add() on the run key (real model spend, attempt-1 warm, no stall retry needed) → seeded test exits 0 → harness commits the verified fix → harvest bundle verifies, tip matches, fix-in-bundle TRUE → teardown exit 0, box gone, keyHash absent post-revoke, ledger box_hours row priced (7,798 µ$), tokens rows = 0 (pre-registered gap), **spend 7,825 ≤ 50,000 µ$ cap** |
| T2.2 | fanout best-of-n N=2 + advisory rank + harvest×2 + teardown×2 | **PROVEN — 52/52 asserts** | evidence `2026-08-25-155131-t2-2-fanout-bestofn.json`: fanout verb exit 0, **both arms outcome "ready"** through full gates on two real boxes, fan-*.json carries both runIds + rosterIds [lead,fixer] + pin==SHA, advisory null-score contract held in-verb AND via `rank` verb exit 0 over the real record (rankedAt stamped, winner stays null), per-arm work products committed distinct on-box, BOTH bundles verify, teardown×2 exit 0, aggregate **spend 146 µ$ ≤ 100,000 µ$ (2×cap)**, final-ls [] |

### Defects found and fixed this arc (all root-caused, RED→GREEN)

- **F11 — CRITICAL, product, FIXED (`409137d`): gate C shredded every slug containing n/t.**
  The round-7 hermetic-parsing line was `IFS=' \t\n'` in SINGLE quotes ⇒ IFS =
  literal {space, backslash, t, n}; C's `for m in $Models` word-split model ids
  ON 'n' AND 't'. Byte-exact local repro (shim curl logging each ping):
  `anthropic/claude-haiku-4.5` pinged as `a`, `""`, `hropic/claude-haiku-4.5`;
  n/t-less `deepseek/deepseek-v3.2` passed intact — exactly why c_fail showed
  only haiku and why the note rendered the two-space mangle
  `from: a  hropic/…` (the empty middle field appends a bare space).
  Explains all three prior gate failures deterministically; the "intermittent
  whitespace-200 egress" hypothesis is DEAD for these failures. Fix builds the
  real three characters POSIX-portably (`IFS="$(printf ' \t\nx')";
  IFS="${IFS%x}"`). First live gate after fix: **C passed 2/2**.
- **F14 — HIGH, product, FIXED (`ea6dd64`): gate D false-fails when pi's models.json is absent.**
  D had NEVER executed live (always behind C). Image drifted to pi 0.84.2,
  which never writes `~/.pi/agent/models.json` (its store ships `{}`). D's
  full-pricing scan hit "unreadable" on a healthy box mid-green-gate
  (qds-20260825-0250b0: A✓B✓C✓ **D✗**). Production `readCustomRegistry`
  treats absence as an EMPTY registry priced by the bundled catalog
  (validate.ts AC5) — the gate was stricter than the code it guards. D now:
  absent ⇒ pass naming AC5, resting on the provider usage.cost proof; PRESENT
  ⇒ unchanged four-key scan. Live result: **D✓E✓** next run.
- **Money-identity gap — MED, product, FIXED (`536c23b`): dispatch never stamped
  record.commitSha.** Gate-passed runs carried vmName but no pinned SHA — no
  audit answer to "which commit is this billable box running?" Stamp lands
  only AFTER the gate passes, best-effort like sibling writes; unit-pinned.
- **F15 — HIGH, product, FIXED (`4804765`): best-of-n arms strangled by the per-issue budget.**
  Both arms share ONE issueId; admitIssue budgets PER ISSUE; with the ceiling
  below n×cap arm 0 admitted (billable box) while arms 1..n-1 were refused
  `budget-exceeded` — measured live ×2 (`fan-20260825-{ff6d64,b37e88}`), then
  reproduced byte-for-byte out-of-test. Per operator direction ("the budget
  goes to whatever the asked work needs"), the PRODUCT now reconciles its
  DECLARED aggregate against the ledger BEFORE minting anything:
  `CostLedger.issueBudgetSnapshot()` exposes the read-only
  {ceiling, spent, reserved} triple admission acts on; fanout requires headroom
  for n×cap pre-mint and refuses exit-5 `issue-ceiling-insufficient` naming the
  exact `perIssueOverrides` line to declare the aggregate. No silent raises —
  the config stays the one place budgets are declared; the failure moved from
  after-arm-0's-meter to before-anything-exists. RED→GREEN pinned
  (patterns.test: refusal-before-provisioning, zero records, zero boxes).
- **Test-side (fixed in-place, same lessons as F12/F13):** T2.1/T2.2 arms must
  COMMIT their verified work products before harvest — harvest counts COMMITS
  on sbx/<runId> and probe manifests commit nothing ("harvested: none", bundle
  never written); the MODEL makes and proves the fix, the HARNESS commits it.
  T2.2 fixture declares the n×per-arm aggregate via perIssueOverrides (now
  also enforced pre-flight by F15).

### Known-residual / not-proven (honest ledger)

- One historical whitespace-only HTTP 200 from OpenRouter over box egress was
  observed once (prior session). C remains single-shot by design; if it ever
  recurs the failure note now self-documents (model list verbatim). Not
  defensive-coded against — no evidence it fires on healthy slugs.
- `tokensRows == 0` asserted and holds (pre-registered gap:
  `CostLedger.ingestCostEvent` has no production caller — documented, not faked).
- Race pattern + reapRuns remain never-proven-live (unchanged from prior
  report) → T3 candidates alongside: cold-box first-call B flake (fresh-box
  `pi --list-models` fetch timeout measured once on the probe box; B has
  passed 6/6 live gate executions).

### Spend (actual vs approved caps)

| Run | Approved worst case | Actual |
|---|---|---|
| T2.1 attempts 1–4 this arc (incl. killed wrong-SHA launch, engine-leg run) | 280,000 µ$ | ≈ 25,000 µ$ (gate pings + fractional boxes + deepseek fixer 1,752 µ$) |
| **T2.1 FINAL green** (`153706`) | included | **7,825 µ$** |
| T2.2 attempts 1–3 (two budget-refused, one harvest-none) + diagnostics | 380,000 µ$ | ≈ 12,000 µ$ (boxes fractionally billed; arms idle at gate pings) |
| **T2.2 FINAL green** (`155131`) | included | **146 µ$** (arms [73, 73]) |
| Diagnostic probe boxes (pi-registry path, argv repro) | — | ≈ 6,000 µ$ |
| Leak remediation (killed-launch box + stale-key sweep: 51 orphaned `sbx-qds-*` keys revoked, verified absent; 0 boxes left) | — | negligible (keys were unspent) |
| **Total TIER-2 arc** | **660,000 µ$ ($0.66)** | **≈ 45–50,000 µ$ (~$0.05)** |

### Coverage matrix delta (after TIER-2 FINAL)

| Surface | Before T2 | After T2 FINAL |
|---|---|---|
| dispatch verb steps 1–8 (validate→admit→record→box→mint→fill private repo→gate entry) | 0% | **real-proven** incl. budget admission at an operator cost-config, bundle-push fill, and post-gate commitSha stamping |
| setup gate A/B on a dispatch-provisioned box | 0% | **PROVEN** (6/6 live executions) |
| setup gate C/D/E | 0% | **PROVEN — C 2/2 roster pings whole, D provider-cost + AC5-absence semantics, E computed credit** |
| expose/ack, delivered stamped manifest read-back | 0% | **PROVEN** (stampedLimit == effectiveCeiling == 50,000 µ$) |
| engine spend on the run key (seeded-fix loop) | 0% | **PROVEN** (deepseek-v3.2 real spend fixes the seeded bug; test exits 0) |
| harvest-of-dispatch-run | 0% | **PROVEN** (bundle verify, tip match, fix-in-bundle) |
| teardown-with-spend | 0% | **PROVEN** (exit 0, box-hours row priced 7,798 µ$, key revoked+verified) |
| fanout best-of-N arms live | lock slice | **PROVEN — both arms ready through full gates on two real boxes** |
| advisory rank over a real fan-out record | 0% | **PROVEN** (null-score steps contract, rankedAt stamped, in-verb + verb paths) |
| race pattern / reapRuns / many-stories | 0% | 0% — T3 candidates |

Fleet demo-readiness verdict: **YES for the money path** — dispatch → gate →
engine → harvest → teardown proven end-to-end on real substrate at capped
cost, and N-arm fan-out + advisory ranking proven above it. Remaining gaps are
adjacent patterns (race, reapRuns, many-stories), not the demonstrated chain.



## TIER-3 FINAL (2026-08-26, sessions 4–5) — **6/6 PROVEN** at HEAD `f8cb500`

Executor: fresh-context sessions per t3-test-plan.md (handoffs
t3-handoff-session3/4.md). Every live run individually GO-approved after
printing keys×cap + boxes×est-hours + worst µ$ and $. Branch tip progression
this arc: `b8da988` (PF-1 F15b grouped arithmetic) → `e586da2` (T3 kit: PF-2
stdout tails + remote phase runner + race/remote live tests) → `cde3f81`/
`86be739` (T3.2 test + probe-fix) → `fc21f8b` (PF-3 exec-cat marker read) →
`6c1064a` (T3.1 gate-outcome read) → `889e4c1` (T3.5 shim: HOME resolution,
argv re-quote, manifest budget 150000) → `7e47279` (T3.3 served-marker
assert) → `2b94456` (reaper costLedger wiring — PRODUCT FIX) → `f8cb500`
(T3.4a hot-spin kill poller). Substrate at session end: **0 boxes, 0 orphan
qds-\*/sbx-qds-\* keys** (swept + verified after every test and at close).

### Verdict matrix

| # | Test | Verdict | What was proven on real substrate | Final-run evidence |
|---|---|---|---|---|
| T3.2 | many-stories + F15 $0 probes | **PROVEN** | fanout `--pattern many-stories --n 2` exit 0; BOTH arms `ready` through full gates; record `pin:null`, arms carry DISTINCT briefHashes recomputed in-test, NO rosterId; per-arm work committed (eeea36d / 1284047); harvest "harvested: 1" ×2, teardown ×2 exit 0; NO auto-rank line; spend **146 µ$ ≤ 100,000** (arms 73+73); box_hours priced 6381+7898 unpriced=0; final-ls []. $0 probes: `--roster` refused, `--pin` refused, brief-count≠n refused, n=1 legal, and **P1 grouped-arithmetic proof** (two briefs, two issues, override only on A → exit 5 naming repo#A needing 100,000 with available 50,000) — the live discharge of PF-1 | `2026-08-26-131544-t3-2-manystories.json` + `114225-t3-2-manystories-probes.json` |
| T3.1 | race pattern | **PROVEN** (att7) | both arms gate-READY (full-field branch); marker planted on lowest-index ready arm via PF-3 exec-cat channel; **winner 0 claimed on real substrate**; exactly one "ready" + one `lostRace` line; loser **destroyed BY THE PRIMITIVE**; loser ledger row through the REAL lazy hook: box_hours **3716 µ$ unpriced=0**; wonEvents=1, crossEvents=0; `rank` verb exit 0 (null-score contract, rankedAt stamped, winner stays 0-not-null semantics per record `winner:0`); teardown winner exit 0; final-ls [] | `2026-08-26-154346-t3-1-fanout-race.json` |
| T3.5 | manifest phases ON the box | **PROVEN** (run9) | dispatch exit 0 → shim runs 3 manifest phases (`t3-probe`/`t3-verify`/`t3-marker`) via `driver.exec` on-box, all exit 0, **PF-2 stdout tail in journal value** ("t3-remote-engine-ran"); money identity delivered==witness==record==50,000 µ$; marker file lands in the **harvest bundle** via `git show refs/sandbox/<runId>` = "t3 phase marker"; teardown exit 0, box gone; final-ls []. Honest label: host-orchestrated shim (`scripts/pipeline-run-remote.ts`) — the in-box executor remains the filed story proposal | `2026-08-26-182443-t3-5-remote-phases.json` |
| T3.3 | expose/port + posture gate | **PROVEN** (run5) | NEGATIVE: posture file absent → dispatch exit 1 `posture-attestation-missing`, port claim RETAINED in record, box ALIVE, anonymous URL = exe.dev login redirect **ECHOING the requested path** (asserted as served-BODY marker absence, never curl exit code). POSITIVE: posture present → unguessable runId-named box serves the unguessable marker ANONYMOUSLY at the derived https URL; teardown → same URL answers the 307 auth redirect (the only retraction proof that exists); both boxes destroyed; final-ls [] | `2026-08-26-185732-t3-3-expose-port.json` |
| T3.4b | active reaper (sandbox-reap) | **PROVEN** (run4) — **product fix proven** | full dispatch to `ready` = abandoned OPEN record + box + key; `staleAfterMs:60000` via the REAL `QDS_QUOTA_LIMITS_FILE` knob; `sandbox-reap --yes` → `stale-record → teardown` action, **box_hours row PRICED 8170 µ$ unpriced=0** (pre-fix: teardown ran but ZERO cost_events rows — the SweepDeps.costLedger wiring gap), record closed, box destroyed, key revoked, exit 0; follow-up dry-run: "nothing to reap" | `2026-08-26-193343-t3-4b-sandbox-reap.json` |
| T3.4a | orphan reservation lazy expiry | **PROVEN** (run7) | hot-spin poller (ONE persistent readonly WAL conn, back-to-back SELECTs, SIGKILL on first row sight) landed the kill **attempt 1 of 12** — admission `qds-20260826-15ff61` committed 20:43:34.014Z, record never created, 0 boxes ever provisioned; young-control dispatch on the same issue REFUSED exit 5 (the orphan's 50k reservation ate the headroom); after the 368.6s window (grace 60s + skew 300s) a fresh dispatch **ADMITTED with reserved:0 remaining:250000** — the lazy sweep inside admitIssue expired the orphan exactly; clean-ENOENT expiry silent by design, numbers are the pass; final-ls [] | `2026-08-26-204954-t3-4a-orphan-expiry.json` |

### Product changes shipped this arc (PR-visible)

1. **PF-1 (`b8da988`)** — F15 pre-flight grouped briefs by (repoSlug, issueId):
   Σ(count×cap) headroom required PER GROUP; refusal names every group's
   override line. Killed the over-refusal AND the under-protection half of the
   F15 bug for multi-issue many-stories briefs. Live proof: T3.2 P1 probe.
2. **PF-2 (`e586da2`)** — code-phase stdout now rides the journal value as a
   bounded tail (was stderr-only, dropped). Live proof: T3.5 steps query.
3. **PF-3 (`fc21f8b`)** — race probeArm reads the marker via exec `cat` on the
   same channel as the presence probe (ExeDevDriver.copyFile is box-relative
   and refused the absolute /run path — the race was UNDECIDABLE pre-fix on
   real substrate). Live proof: T3.1 att7.
4. **Reaper costLedger (`2b94456`)** — SweepDeps.costLedger was missing from
   sandbox-reap's teardown wiring, so reaped runs never priced box_hours and
   their reservations never retired. Live proof: T3.4b 8170 µ$ row.

Test-infra (not product): T3.5 remote shim manifest budget 60000→150000
(requiredBudgetMs = Σ(retries+1)×(PARSE_FIX_ATTEMPTS+1)×maxDuration +
phases×ROUTING_MARGIN), shim `$HOME` resolution + per-element shellQuote
(reproduced live: dash `printf: usage` exit 2, empty marker), T3.3
served-body assert discipline, T3.4a hot-spin poller + 5×CAP ceiling +
fail-fast headroom refusal (`f8cb500`).

### Spend (actual vs approved, EVERY attempt)

| Test | Attempts | Approved worst | Actual |
|---|---|---|---|
| T3.2 | 7 (2 probe-assert bugs $0-5k, 3 design/flake, final green + probes) | 330,000 µ$ | ≈ 25–35,000 µ$ arc; final green run itself **146 µ$** vs 100,000 cap |
| T3.1 | 7 (att1-5 driver/PF-3 debugging ≈150–200k; att6 gate-B flake ≈80–90k, 2 boxes 10.5 min; att7 green) | 560,000 µ$ | att7 ≈ 15,000 µ$ (73 µ$ tokens + 3716 µ$ loser box + fractional winner) |
| T3.5 | 9 (r1 $0 usage-refusal, r2-r7 ≈5k each, debug box ≈12k, r9 green) | 110,000 µ$ | ≈ 42,000 µ$ arc; green run ≈ 5,000 µ$ vs 50,000 cap |
| T3.3 | 5 (r1-r4 incl. gate-B flake + leak-cleaned run; r5 green, 2 dispatches) | 110,000 µ$ | ≈ 40,000 µ$ arc; green run ≈ 12,000 µ$ vs 100,000 (2×cap) |
| T3.4 | 6 (r1-r3 full dispatch legs ≈25k; r4 4b-green+4a ≈12k; r5 $0 usage refusals; r6 6 kill-too-late ≈8k) | ≈ cents claimed, ≈60k realistic | ≈ 45,000 µ$ arc |
| T3.4a final | 1 (run7 hot-spin) | 150,000 µ$ | **≈ 0 µ$** — kill landed pre-provision, 0 boxes ever created, 0 tokens |
| **TIER-3 total** | | **≈ $1.22 envelope** | **≈ 410–500,000 µ$ (~$0.50)**; no test approached its cap aggregate |

### Coverage delta (after TIER-3 FINAL)

| Surface | Before T3 | After T3 FINAL |
|---|---|---|
| race pattern (marker → first-writer claim → primitive-disposes losers) | 0% | **PROVEN** (incl. loser lazy-ledger pricing, the DF2.8 proof unit tests only faked) |
| many-stories wrapper (multi-brief, per-brief manifest/roster) | 0% | **PROVEN** |
| F15 grouped multi-issue budget arithmetic | unit-only | **PROVEN live ($0 probe)** |
| expose/port + posture attestation + anonymous retraction semantics | 0% | **PROVEN** (negative + positive) |
| ledger lazy orphan expiry (grace+skew sweep inside admitIssue) | 0% | **PROVEN** (kill-in-window, young refusal, post-expiry admission) |
| active reaper (sandbox-reap --yes, staleAfterMs knob, priced teardown) | 0% | **PROVEN** (+ product fix it forced) |
| manifest phases executing on-box | 0% | **PROVEN via host-orchestrated shim** — in-box executor = filed story proposal |

Fleet demo-readiness verdict: **YES for every shipped pattern** — dispatch →
gate → engine → harvest → teardown (T2), best-of-n + rank (T2), race,
many-stories, expose/port, orphan expiry, active reaper, on-box phases (T3)
all proven against real exe.dev + real OpenRouter at bounded cost. Remaining
gaps are filed stories (in-box executor, reapRuns delete-or-wire,
ingestCostEvent wiring), not unproven shipped code.

### Findings ledger (T3 arc)

1. **PF-3 — copyFile-vs-marker-path mismatch** (race probe read marker via
   box-relative copyFile; /run absolute refused): FIXED `fc21f8b`, proven live
   att7. Pre-fix the race pattern was structurally undecidable on real
   substrate — the 508 FakeDriver tests could not see it (audit thesis
   confirmed a third time).
2. **/run marker write needs a sudo-capable writer** (root:root 0755, box
   user uid 1000) — in-box executor story input.
3. **Gate-B fresh-box pi-registry init race** (substrate): fresh-box
   `pi --list-models` can still be initializing at gate time ("No models
   available. Use /login") while a sibling box created 2s apart passes A–E.
   Fail-closed by design (DF2.2) → setupFailed exit 3, box ALIVE (INV-5).
   Occurrences this arc: T3.2 12:41 ×2, T3.1 att6 arm 0, T3.3 run3 —
   ~4/16 ≈ 25% per-attempt on 2-arm runs. Possible product hardening
   (PLANNING decision, not audit scope): bounded B-only wait/retry (B itself
   spends nothing).
4. **Reaper teardown never priced box_hours** — SweepDeps.costLedger missing:
   FIXED `2b94456`, proven live (8170 µ$ row, reservation retired).
5. **`reapRuns` dead code** (driver.ts:1201-1282, zero production callers,
   docstring contradicts itself; the ACTIVE reaper is scripts/sandbox-reap.ts)
   — delete-or-wire is a planning decision.
6. **briefHash contract**: sha256 of the Zod-PARSED brief in SCHEMA key
   order (not raw file bytes) — documented for future consumers.
7. **exe.dev proxy semantics**: a private VM answers anonymous requests with
   a login redirect that ECHOES the requested path; a destroyed VM's hostname
   still 307s. Tests must assert served-BODY content, never curl exit codes.
8. **Ledger retirement semantics**: priced spend consumes issue headroom
   FOREVER (the reservation retires; the money does not come back) — T3.4a's
   ceiling sizing and the young-control design both rest on this.
9. **Orphan-window width ~1–3 ms measured** (admission commit → record
   create; runs 1-6: a 5ms-poll caught it 1-in-13). NOT reclassified: the
   hot-spin poller (`f8cb500`) landed it attempt 1-of-12 live. Width stands
   as the measured fact for anyone sizing this window on production-speed
   hosts.

### Not run / honest residuals

- P2 optional probe (overrides {A:100k, B:10k} partial-fanout refusal) —
  declined: P1 already proves the grouped arithmetic live; P2 would spend
  boxes to re-prove the same code path.
- In-box executor (T3.5 story proposal B), reapRuns delete-or-wire,
  ingestCostEvent tokens wiring — planning queue, unchanged.
- Gate-B flake unmitigated in product (finding 3) — planning decision.
