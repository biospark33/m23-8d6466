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
| F4 private repos impossible (INV-CRED-1) | **FIXED (feature)** | bundle-push is the DEFAULT fill mode: HOST fetches the pinned SHA with host creds → `git bundle` → base64 over exec stdin → box clones from the LOCAL bundle; creds never cross the wire; rejected deploy-token/forwarding designs on secret-surface grounds; workdir path grammar validated before script interpolation (security-review hardening 624c98b) | **T1.3a+b PASS against PRIVATE biospark33/QDS-Factory at pushed SHA 624c98b** — default fill, sbx branch, in-box commit, harvest verb exit 0, host bundle verify 0, quarantine fetch 0 (`2026-08-24-220341/220432`) |
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

## TIER-2 (2026-08-24/25) — T2.1 BROKEN at setup-gate C (F10 fixed, F11 open); T2.2 SKIPPED-BLOCKED

Executor: fresh-context session per handoff. Branch tip `89a44f4` → `1f2830d`
(pushed). Operator approved 280,000 µ$ worst case for T2.1 and 380,000 µ$ for
T2.2. Tests committed: `tier2-dispatch-engine.live.test.ts`,
`tier2-fanout-bestofn.live.test.ts`, harness `preflight(tier)`, manifest
`config/rosters/t2.pipeline.json` + active roster `config/rosters/roster.yaml`
(gate reads it beside the manifest per dispatch.ts roster-beside rule).

### Verdicts

| # | Test | Verdict | What happened on real substrate |
|---|---|---|---|
| T2.1 | dispatch→engine→harvest→teardown | **BROKEN** (3 attempts) | dispatch verb real subprocess: validate→admit(50,000 µ$ config)→record→box→mint→**private-repo fill**→gate A✓ B✓ **C✗ exit 3**, deterministically (3/3). Everything upstream of gate C is now real-proven; the engine/harvest/spend legs never ran |
| T2.2 | fanout best-of-n N=2 + rank | **SKIPPED-BLOCKED** | every arm is a dispatch through the same gate C; running would spend ~$0.15 to re-hit a proven wall. Rank's null-score contract pinned in the committed test, unproven live |

### F10 — HIGH, product, FIXED (commit 1f2830d): gate C ping omitted max_tokens ⇒ guaranteed 402 on capped keys

- File: `src/providers/exedev/assertions-in-box.sh:94` (C block).
- Symptom (verbatim, attempt 1): gate C failed `anthropic/claude-haiku-4.5`;
  host-side repro with a minted 50,000 µ$ key returned
  `402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 50000..."}}`.
- Root cause: no `max_tokens` in C's chat/completions body ⇒ OpenRouter prices
  the request at the model's DEFAULT max output (haiku-4.5 = 64k tokens) ⇒ any
  capped run key whose cap < one theoretical max-output request refuses the
  PING — the gate rejects healthy models on healthy keys. D already sent
  `max_tokens:8`; cap-hit-demo's probe sends `max_tokens:1`; C alone defaulted.
- Fix: `"max_tokens":8` in C's body (D's own figure). impact(setupGate)=LOW,
  focal setup-gate.test.ts 39/39 green.
- Post-fix attempts 2–3 STILL fail C — see F11.

### F11 — HIGH, OPEN: gate C fails through-gate only; slug arrives mangled / empty-200 from box egress

- Signature (verbatim, all 3 attempts):
  `C False | no live answer (content or reasoning) from: a  hropic/claude-haiku-4.5 — roster …roster.yaml; check the box egress and the runtime key`
  — note the model id renders as `a␣␣hropic/…`, i.e. the in-box loop saw the
  slug split into words (`a`, `hropic/claude-haiku-4.5`) OR the note lost
  characters; this mangle appears ONLY inside gate execution.
- Contradicting evidence (all live, same night, same image, same key shape):
  - manual `driver.execTimed(vm, ["sh","-c", <exact fixed C request>])` on a
    fresh box → HTTP 200, full JSON, answer "ready" (830 bytes);
    qwen3-30b-a3b and deepseek-v3.2 also 200 "ready".
  - one earlier probe of haiku through a box returned **HTTP 200 with a
    whitespace-only body** (empty choices) — intermittent empty-200s from
    OpenRouter over box egress are REAL and would legitimately trip C.
  - host-side identical request → 200 routed via "Amazon Bedrock" (route
    differs by ingress region/pool).
- Suspects (unresolved): (a) models argv delivery into assertions-in-box.sh
  under the gate's exact exec composition (`["sh","-c",script,"sh",roster,env,…models]`)
  mangling despite transport probes passing; (b) provider-side intermittent
  whitespace-only 200s over box egress hitting the FIRST ping while manual
  retries succeed. Gate evidence files:
  `.sandbox/setup-gate/qds-20260825-{ce6e89,b7b338,97451e}.json`.
- Next session: reproduce with the gate's own script file executed verbatim
  in-box with argv tracing (`printf "[%s]" "$@"`), and add a bounded retry +
  response-body echo to C's failure note so the next failure self-documents.

### F12/F13 — test-side defects found by the leaks (both FIXED in the committed tests)

- F12: T2.1/T2.2 finallys parsed runId/vmName only from a SUCCESSFUL ack — a
  gate-refused dispatch (which PROVISIONS, INV-5 keeps box+key alive)
  stranded box + capped key outside the finally. All three attempt boxes
  (`qds-20260825-{ce6e89,b7b338,97451e}`) leaked and their three
  `sbx-qds-*` 50k-cap keys stayed live until operator-session remediation:
  boxes destroyed via `ssh exe.dev rm`, keys revoked via revokeAndVerify and
  confirmed absent from listAllKeys. Tests now recover ids from stdout AND
  stderr refusal payloads before teardown.
- F13: leak check filtered `e2e-*` only; dispatch mints `qds-*` names, so
  final-ls reported false-clean `[]` while boxes billed. Fixed to match both
  prefixes.

### Spend (actual vs approved caps)

| Run | Approved worst case | Actual |
|---|---|---|
| T2.1 attempt 1 (pre-F10) | 280,000 µ$ | ~3,500 µ$: gate A/B only + 2 C pings (~200 µ$) + ~47 s box (~3,000 µ$ fractional) |
| T2.1 attempts 2–3 | included above | ~2×~45 s boxes + handful of pings ≈ ~6,500 µ$ total |
| Diagnostics (4 minted keys, all revoked+verified) | — | ≤ ~1,000 µ$ total (each ping 30–40 µ$, deepseek control ~0) |
| T2.2 | 380,000 µ$ | **0 — not run (blocked)** |
| **Total TIER-2** | **660,000 µ$ ($0.66)** | **≈ 11,000 µ$ ($0.011)** + leaked-box remediation (3 boxes ~2 min total lifetime, billed fractionally post-F8) |

kind='tokens' ledger rows: pre-registered assertion expects ZERO (documented
gap — CostLedger.ingestCostEvent has no production caller), never reached
live because the engine leg is behind gate C.

### Coverage matrix delta (after TIER-2 attempts)

| Surface | Before T2 | After T2 |
|---|---|---|
| dispatch verb steps 1–8 (validate→admit→record→box→mint→fill private repo→gate entry) | 0% | **real-proven** incl. budget admission at an operator cost-config and bundle-push fill inside the verb |
| setup gate A/B on a dispatch-provisioned box | 0% | **PROVEN** |
| setup gate C/D/E | 0% | **BROKEN — F10 fixed, F11 open** |
| expose/ack, delivered stamped manifest read-back, engine spend, harvest-of-dispatch-run, teardown-with-spend | 0% | 0% (behind gate C) |
| fanout best-of-N arms / rank live | 0% | 0% (blocked by same gate) |

Fleet demo-readiness verdict: NOT yet — the money path is provably admitted,
filled and gated up to assertion C on real substrate; one open defect (F11)
blocks every costing surface end-to-end.

