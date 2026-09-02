# FIX-LIVE-T1

Fixer scope: `tier1-registry-auth`, `tier1-approval-gate`, `tier1-teardown`,
`tier1-image-contract` (renamed → `tier2-image-contract`). `live-harness.ts` and
every tier2–5 file were READ, never edited.

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| F1 | `tests/fleet/e2e/tier1-registry-auth.live.test.ts:183-198, 320` | `posCreated = true` moved to the line BEFORE `await posDriver.create(posVm)`; the declaration carries the rationale | CONFIRMED. `ExeDevDriver.create` reaches the substrate (`ssh exe.dev new` has already made the box) before three of its own throw sites: `steering-channel-unprovisionable` (driver.ts:791, reached from :753 and :762) and `create-shape-unresolved` (driver.ts:769, message: "the VM may be live and unrecorded"). Setting the flag on the RETURN left all three with nothing destroyed, no `finally-destroy` entry naming the box and an empty `destroyFailures` — a clean-looking cleanup over a box billing indefinitely. Redundant destroy of a never-created box is free: `driver.destroy` (driver.ts:921-942) falls through `rm` to a `list` that comes back empty and returns idempotent success. |
| F3 | same file, `:246-259` (probe) and `:405-420` (sweep) | the `negVm` sweep MOVED into the `finally` and made unconditional; the body keeps only a try/caught `list()` probe for the evidence record | CONFIRMED. `const negListed = (await negDriver.list(negVm)).some(…)` was unguarded: a throw there escaped to the outer catch with `posCreated` false, and the `finally` had no `negVm` branch at all — the box appeared only inside a `test-error` string. `destroyQuietly` never throws (live-harness.ts:497), so the unconditional sweep is free. |
| F4 | `tier1-registry-auth…:441-450`; `tier1-approval-gate…:646-676` and `:920-937`; `tier1-teardown…:230-252` | `expect(...); if (failure !== undefined) throw failure;` replaced by `settleRun(failure, problems)` (+ `fleetCleanupProblems` in registry-auth) | CONFIRMED at all four sites (the two the finding named, plus BOTH remaining tier-1 files it asked me to check). `live-harness.ts:616-648` documents this exact shape as the bug it replaces: when the body failed AND cleanup failed, the `expect` threw its own AssertionError first and the held regression was discarded. |
| F4+ | `tier1-teardown…:160-177` | the bare `ctx.driver.destroy(runId)` inside a `catch {}` replaced with `destroyQuietly` + a `destroyFailures` accumulator | ADJACENT, same class, found while checking F4. That `catch {}` swallowed BOTH the list failure and the destroy failure, so a box still billing left no verdict anywhere and the run reported green. |
| F4+ | `tier2-image-contract…:159, 553-561, 634-651` | the catch now HOLDS the body error (`failure = e`) instead of `throw e`; post-`finally` verdicts routed through `settleRun` | ADJACENT, the mirror of F4. `throw e` in the catch made both post-`finally` verdicts (`destroyError`, `finally-revoke ok:false`) unreachable on the RED path — the path where a leaked box and an unrevoked key are most likely. |
| F7 | `tier1-registry-auth…:104-165` | the anonymous-visibility guard now FOLLOWS ghcr's Bearer challenge: parse `realm`/`service`/`scope`, request an anonymous token, retry the HEAD with it, treat 200 on the retry as "public" | CONFIRMED, and verified live against this repo's own packages (free HTTP, no spend, 2026-09-02): `HEAD https://ghcr.io/v2/biospark33/qds-exedev-private/manifests/<digest>` → **401** with `WWW-Authenticate: Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:biospark33/qds-exedev-private:pull"`; `GET https://ghcr.io/token?…scope=…qds-exedev-private:pull` → **401 UNAUTHORIZED**; the same call for the PUBLIC mirror `…/qds-exedev:pull` → **200 {"token":…}**, and that token then serves the manifest **200**. So the old `anon.status === 200` really was unreachable, and the retried probe really does separate the two. |
| F8 | same file, `:270-296` | added `expect(negCode).toBe("create-failed")` and `expect(negError).toMatch(/ exited [1-9][0-9]*:/)`; the error's typed `code` is captured (`e instanceof ExeDevDriverError`) and recorded in evidence | CONFIRMED that `toBe("threw")` alone was satisfied by any rejection. See Decisions for what I asserted and the half of the suggested fix that is a false positive. |
| F9 | `tier2-image-contract…:93-108` (new `BOX_PROBE_TIMEOUT_MS`), `:196-203` (`probe` helper), 16 call sites, `:652-694` (budget audit + `2_880_000`) | all 16 straight-line probes routed through `ctx.driver.execTimed(vm, argv, 30_000)`; the in-file audit rewritten to price DECLARED CEILINGS; file budget 1 500 s → 2 880 s | CONFIRMED. Exactly 16 `await ctx.driver.exec(vm, [` call sites, each bounded only by `DEFAULT_EXEC_TIMEOUT_MS` (transport.ts:41 = 120 000) — 1 920 s of declared ceiling that the old audit priced at "~30 s" combined. See Decisions for the bound-vs-raise call. |
| F13 | `tier1-registry-auth…:432-439` | `rmSync(workspace, …)` added in a `finally` under the evidence write | CONFIRMED: no `rmSync` appeared anywhere in the file, so every round left a `/tmp/qds-e2e-t1reg-*` directory holding the 0600 posture file. Matches `tmpWorkspace`'s own doc (live-harness.ts:650) and the sibling's `:598`. |
| F14 | `tests/fleet/e2e/tier1-image-contract.live.test.ts` → `tests/fleet/e2e/tier2-image-contract.live.test.ts` (+ header `:32-48`, evidence-name comment `:575-579`) | file renamed to match `liveGate("2")`; header rewritten to explain the old mismatch; the evidence artifact name `t1-image-contract` deliberately UNCHANGED with a comment saying why | CONFIRMED: `liveGate("2")` at `:108` while `liveTodoOff()` keys only on `QDS_E2E_LIVE`, so `QDS_E2E_LIVE=1 QDS_E2E_TIER=1 bun test tests/fleet/e2e/tier1-*.live.test.ts` ran it and threw `QDS_E2E_TIER is "1", not "2"` at the end of a paid round. Rename done with `mv` (no staging, no commit). |

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| F8 (half) | The finding asks for "`create-failed` with a **non-empty substrate stderr**". A non-empty-stderr assertion would FAIL the AC4 leg on the real substrate. The one live AC4 round on record (`_bmad-output/evidence/df3-e2e/2026-09-01-234604-t1-registry-auth.json`) captures the negative-control message verbatim as `"ssh exe.dev new --name e2e-t1regneg-… --image ghcr.io/biospark33/qds-exedev-private@sha256:… exited 1: "` — everything after the colon is EMPTY. exe.dev writes nothing to stderr on an unpullable image, so the "ideally … names an auth/pull refusal" half is also unavailable. I asserted the strongest thing the substrate actually emits (see Decisions). |
| F1 (partial) | The prescription cites `tier1-image-contract.live.test.ts:337` / `:536`; the real lines are `:179` (`vm = runId;`) and `:531` (`if (vm !== "")`). The *shape* is exactly as described — only the line numbers were off. Patched as prescribed. |
| — | No finding was dismissed outright. F1/F3/F4/F7/F9/F13/F14 all reproduced against the source. |

## Harness changes I need (but did not make)

None — every primitive I needed (`settleRun`, `fleetCleanupProblems`, `destroyQuietly`, `tmpWorkspace`, `runIdFor`) is already exported from `live-harness.ts` and I used them as-is.

One OBSERVATION for the harness owner, no change requested: `fleetCleanupProblems(destroyFailures, finalBoxes)`'s second argument has no honest counterpart in `tier1-approval-gate` or `tier1-teardown` — neither takes a cleanup-time fleet listing (approval-gate's final-ls is a BODY assertion), and `driver.destroy` already confirms absence with a real `ls` before returning, so `destroyQuietly`'s verdict carries the "is it gone" half. Passing `[]` there would assert a listing that was never taken and passing `undefined` would always report "the final fleet listing FAILED". Those two files therefore call `settleRun` with explicit problem lines and do not call `fleetCleanupProblems`; `tier1-registry-auth` does call it, over a real cleanup-time listing filtered to its own two box names.

## References other fixers must update (F14 rename)

`grep -rn "tier1-image-contract" --include='*.ts' --include='*.md' --include='*.yml' .` (excluding `_bmad-output/evidence/`) returns **no dangling reference in any file I own**. Everything below lives in a file owned by someone else. Only the `scripts/build-exedev-image.ts:2556` entry is a DATA value (it is written into build evidence); the rest are comments/prose.

| file:line | current text | replacement |
|-----------|--------------|-------------|
| `scripts/build-exedev-image.ts:2556` | `coldBootSource: "tests/fleet/e2e/tier1-image-contract.live.test.ts (live e2e round; it reads this file and boots the pinned digest)",` | `coldBootSource: "tests/fleet/e2e/tier2-image-contract.live.test.ts (live e2e round; it reads this file and boots the pinned digest)",` |
| `scripts/build-exedev-image.ts:2006` | `// \`tier1-image-contract.live.test.ts\` reads that exact default path for AC7c.` | `// \`tier2-image-contract.live.test.ts\` reads that exact default path for AC7c.` |
| `scripts/build-exedev-image.ts:2123` | `// the live-e2e reader (tier1-image-contract) and the publish workflow both` | `// the live-e2e reader (tier2-image-contract) and the publish workflow both` |
| `tests/fleet/e2e/live-harness.ts:100` | `* tier1-image-contract were constant-vs-constant, and the credential-loading` | `* tier2-image-contract were constant-vs-constant, and the credential-loading` |
| `tests/fleet/e2e/live-harness.ts:110` | `// for EVERY live test now, not only tier1-image-contract (which keeps its own` | `// for EVERY live test now, not only tier2-image-contract (which keeps its own` |
| `tests/fleet/e2e/live-harness.ts:131` | `… NOT necessarily the repo pin. tier1-image-contract will refuse; all other tiers proceed against the override.\n` | `… NOT necessarily the repo pin. tier2-image-contract will refuse; all other tiers proceed against the override.\n` |
| `tests/fleet/e2e/live-harness.ts:530` | `* try/finally (the tier1-image-contract pattern), so a failed destroy can` | `* try/finally (the tier2-image-contract pattern), so a failed destroy can` |
| `.claude/skills/qds-live-e2e/SKILL.md:61` | `… (the one caller today is \`tier1-image-contract.live.test.ts\`).` | `… (the one caller today is \`tier2-image-contract.live.test.ts\`).` |
| `.claude/skills/qds-live-e2e/SKILL.md:85` | `\| 2 (misnamed) \| tier1-image-contract, tier5-gate-steering \| both call \`liveGate("2")\` despite the prefix — real OpenRouter calls, spend approval required \| as tier 2 \|` | `\| 2 \| tier2-image-contract \| real OpenRouter calls, spend approval required \| as tier 2 \|` — and tier5-gate-steering moves to its own row, since it is now the ONLY remaining misnamed file |
| `.claude/skills/qds-live-e2e/SKILL.md:90` | `spend money despite their prefixes: \`tier1-image-contract\` (DF2.10's boot` | drop `tier1-image-contract` from the "despite their prefixes" sentence — only `tier5-gate-steering` still qualifies |
| `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md:245, 304, 377, 451, 542` | five prose/path mentions of `tier1-image-contract` | `tier2-image-contract` (path mentions at :245 and :304 are the load-bearing ones) |

Note: the SKILL.md line numbers above are what I measured now (61/85/90), not the finding's (73/78) — that file has already moved under its own fixer.

## Gate output

### 1. `bunx tsc --noEmit` — exit 2, **zero errors in any file I touched**

```
tests/fleet/e2e/tier2-dispatch-engine.live.test.ts(103,9): error TS6133: 'evidencePath' is declared but its value is never read.
tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts(81,9): error TS6133: 'evidencePath' is declared but its value is never read.
tests/fleet/e2e/tier3-reaper.live.test.ts(464,11): error TS6133: 'hashesBefore' is declared but its value is never read.
tests/fleet/e2e/tier3-reaper.live.test.ts(583,30): error TS2304: Cannot find name 'writeEvidence'.
tests/scripts/build-exedev-image.test.ts(24,3): error TS6133: 'dockerfileArgDefaults' is declared but its value is never read.
tests/scripts/build-exedev-image.test.ts(31,3): error TS6133: 'redactAssignments' is declared but its value is never read.
tests/scripts/build-exedev-image.test.ts(32,3): error TS6133: 'refRepository' is declared but its value is never read.
tests/scripts/build-exedev-image.test.ts(33,3): error TS6133: 'repoDigestFor' is declared but its value is never read.
tests/scripts/build-exedev-image.test.ts(165,76): error TS2769: No overload matches this call. …
tests/scripts/build-exedev-image.test.ts(426,12): error TS2552: Cannot find name 'dockerfileArgDefault'. …
tests/scripts/build-exedev-image.test.ts(427,12): …(431,12)…(435,12)…(440,12)…(446,12)…(455,12): same
tests/scripts/exedev-bun-pin.test.ts(4,23): error TS2724: '"../../scripts/build-exedev-image.ts"' has no exported member named 'dockerfileArgDefault'. …
```

17 errors, **0 mine**. Attribution: `tier2-dispatch-engine`, `tier2-fanout-bestofn` and `tier3-reaper` belong to the parallel live-e2e fixer (mid-edit — `tier3-reaper` is missing a `writeEvidence` import); the `tests/scripts/build-exedev-image*` and `exedev-bun-pin` errors belong to the buildscript fixer (an in-flight `dockerfileArgDefault` → `dockerfileArgDefaults` rename).

### 2. `bunx biome check tests/fleet/e2e/` — exit 1, **one error, not mine**

```
tests/fleet/e2e/tier3-remote-phases.live.test.ts:73:5 lint/style/useConst  FIXABLE
  × This let declares a variable that is only assigned once.
  > 73 │     let keyProblems: string[] = [];
Checked 21 files in 142ms. No fixes applied.
Found 1 error.
```

`tier3-remote-phases.live.test.ts` is the parallel fixer's file. My four are clean.

### 3. `bun test tests/fleet/e2e/` **without `QDS_E2E_LIVE`** — exit 0

```
$ env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test tests/fleet/e2e/ > /tmp/pr184-r4/live-t1.log 2>&1; echo "exit=$?"
exit=0

$ tr '\r' '\n' < /tmp/pr184-r4/live-t1.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
(no matches)

  … tail …
bun test v1.4.0 (34cbb9a40)
[finally-revoke] failed for e2e-missing-abc123: unreadable run record e2e-missing-abc123.json: ENOENT
[finally-destroy] DESTROY FAILED for e2e-leak-abc123: substrate unreachable — remediation: ssh exe.dev rm e2e-leak-abc123

 7 pass
 24 todo
 0 fail
 23 expect() calls
Ran 31 tests across 20 files. [362.00ms]
```

My four files in isolation:

```
$ env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test …/tier1-registry-auth… …/tier1-approval-gate… …/tier1-teardown… …/tier2-image-contract…
 0 pass
 6 todo
 0 fail
Ran 6 tests across 4 files. [1385.00ms]
```

**NO BOX WAS PROVISIONED AND NO MONEY WAS SPENT.** `QDS_E2E_LIVE` was explicitly unset via `env -u` (confirmed `QDS_E2E_LIVE=[unset]` in the same shell), so every live body is `test.todoIf(liveTodoOff())` → todo and never executes: 24 todo across the directory, 6 of them mine, `0 fail`. The two `[finally-revoke]`/`[finally-destroy]` stderr lines in the tail come from `live-harness.test.ts`'s in-process unit coverage of those two primitives against a fake driver (`e2e-missing-abc123` / `e2e-leak-abc123` are its fixtures), not from any substrate call. The only network I made this session was three unauthenticated `curl`s at ghcr.io to verify F7 — free, read-only, no exe.dev, no OpenRouter.

### 4. `grep -rn "tier1-image-contract" …` after the rename

No hit in `tests/fleet/e2e/tier*.live.test.ts` other than the harness's four comments. Full list of remaining hits is the table under *References other fixers must update* above. Nothing resolves a module by that path, so nothing is broken by the rename — the leftovers are comments, one evidence STRING (`scripts/build-exedev-image.ts:2556`) and story prose.

## Decisions taken

**F7 — which way I erred: toward REFUSING.** The guard now follows ghcr's Bearer
challenge and treats a 200 on the retried HEAD as "public → fail". Every branch
that cannot be turned into a retried probe THROWS rather than assuming private:
an unparseable/absent `WWW-Authenticate` realm, a token realm answering anything
that is neither a grant (2xx) nor a refusal (401/403), a 2xx token response with
no `token` field, and a malformed JSON body (the `.json()` rejection simply
escapes). An unprovable visibility is not a private one, and refusing costs
nothing — the whole probe runs before any box exists. The one branch that
PROCEEDS without a retry is a token realm answering 401/403: that is a positive
refusal of anonymous pull, not an inference, and it is the measured behaviour of
the actual private mirror (see the Patched table).

**F8 — the assertion I chose.** `negCode === "create-failed"` plus
`negError` matching `/ exited [1-9][0-9]*:/`. Together these say `ssh exe.dev
new` RAN and the SUBSTRATE REFUSED it. They exclude everything the bare
`toBe("threw")` let through: `create-failed`'s transport-rejection arm carries
"did not complete:" instead of "exited <n>:" (driver.ts:716-720 vs :732-739), and
`create-shape-unresolved` / `steering-channel-unprovisionable` carry their own
codes — and both of those mean the pull SUCCEEDED, the opposite of this leg's
claim. I did NOT assert non-empty stderr or any vendor string: the substrate
emits an empty stderr on this exact path (false-positive table). Residual
ambiguity, stated in the file rather than hidden: a quota/rate refusal that also
exits non-zero would still pass, and the only thing bounding it is the positive
leg creating from the SAME ref moments later.

**F9 — I did BOTH, and here is why bounding alone could not work.** Bounding: all
16 straight-line probes now run through `execTimed` at `BOX_PROBE_TIMEOUT_MS`
30 000 (down from `driver.exec`'s 120 000), cutting 1 920 s of declared ceiling
to 480 s — that is the half that keeps the leak window short, and it is the
preferred half. But the remaining terms are ceilings this file does not own and
cannot bound from here, and they alone exceed the old budget: create 240 s
(`new` 120 + steering-provision exec 120) + `BOOT_BUDGET_MS` 120 + `fill()` 600
(five in-box execs at 120, fill.ts) + mint/deliver 180 + `DEFAULT_GATE_TIMEOUT_MS`
300 + `REBOOT_BUDGET_MS` 240 + the finally's destroy/revoke 660 (`driver.destroy`
can issue up to five control calls at 120 s each) = 2 340 s against a 1 500 s
budget. So the budget is also raised, to 2 880 000 ms over a 2 820 s
declared-ceiling sum, and the in-file audit now prints that table term by term
instead of pricing the probes at typical latency. Measured wall time is unchanged
(~15–25 min); the ceiling only governs how long a fully degraded round may run
BEFORE the abort that skips the `finally` — and a higher ceiling is strictly the
fail-safe direction for a leak, because the abort is the one path where nothing
is destroyed and nothing is revoked.

**F14 — I renamed.** `tier1-image-contract.live.test.ts` →
`tier2-image-contract.live.test.ts` (plain `mv`; nothing staged, nothing
committed). Nothing imports the file by path, so the rename cannot break a
build — gate 4 confirms the only leftovers are comments, story prose and one
evidence string, all in files owned by other fixers and all listed above for
them. The evidence artifact name stays `t1-image-contract`, with an inline
comment at the `writeEvidence` call saying so, and the file header now explains
the old mismatch instead of excusing it.
