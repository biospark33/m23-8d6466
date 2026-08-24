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

## TIER-2 preamble (awaiting per-run approval)

Estimate per e2e-plan defaults (`capMicroUsd=50000`/key, ≤1h/box): T2.1
dispatch-engine = 1 key × 50,000 µ$ + gate C/D pings (~2 chat calls on
haiku/deepseek ≈ tens of µ$) + 1 box ≤1h ⇒ worst case ≈ 50,000 µ$ model +
$0.23 box. T2.2 fanout N=2 = 2 × 50,000 µ$ + 2 boxes ⇒ worst case ≈ 100,000
µ$ ($0.10) + $0.46. Both BLOCKED on F3 (fill workdir) being fixed or the
workdir seam being acceptable for the live run — a dispatch cannot pass its
gate until the fill/key paths land somewhere writable.
