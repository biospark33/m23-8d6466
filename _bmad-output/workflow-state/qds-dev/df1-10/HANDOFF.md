# DF1.10 — In-Box Phase Engine: successor handoff

Paste everything below the line into a fresh conversation.

---

You are picking up **DF1.10 — In-Box Phase Engine (8 pts, v5-S3)** in `/Users/steve/QDS-Factory`.
Branch `feature/df1.10`, cut from `dev` @ `0b3acc8`. PRs target `dev`. Nothing is committed yet.

## Read these first, in this order

1. `.unlazy/df1-10/PLAN.md` — the contract. **Contract revision 11.** Read the whole inventory (C1–C39) and
   the section "Ground-truth corrections to the story spec", which is binding and supersedes the story
   where they disagree. **C36–C39 are new this session and supersede earlier rows — read them first.**
2. `.unlazy/df1-10/GATES.md` — root gates R1–R11.
3. `.unlazy/df1-10/gates/leaf-*.md` — nine leaf ledgers. **`leaf-1.2.4.md` is new and is the route change.**
4. `.unlazy/df1-10/recon/R{1..6}-*.md` — ~5,000 lines of file:line-cited recon. **Do not re-derive this.**
5. The story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-phase-engine.md`
6. Governing ADR: `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED)

Method: the `unlazy` skill (`.unlazy/df1-10/` is the scope; keep it untracked).
Story driver: the `qds-dev` skill. Live work: the `qds-live-e2e` skill — **mandatory before any live tier.**

## ⚠ ONE STALE DOCUMENT YOU WILL OTHERWISE TRUST

`.unlazy/df1-10/gates/leaf-1.2.3.md:7` still reads *"the COMPILED route ships"*. **That is now false.**
It was true when written; leaf-1.2.4 superseded it. The ledger is left intact rather than rewritten because
its other 10 gates and its recon are still good — but do not take line 7 as current. `leaf-1.2.4.md` and
PLAN C36 are the authority on the route.

## State: 46 files modified, route and licence both RESOLVED this session

| Leaf | Gates | State |
|---|---|---|
| 1.1.1 engine core | **9/9** | VERIFIED, lease released |
| 1.1.2 `fleet run` verb | **6/6** | VERIFIED, lease released |
| 1.1.3 in-box status (AC5) | **7/7** | VERIFIED, lease released |
| 1.1.4 manifest fixtures | **6/6** | VERIFIED, lease released |
| 1.2.2 harvest + durability (AC4) | **7/7** | VERIFIED, lease released |
| 1.2.1 run-root placement (AC2b) | 6/7 | G3 blocked on machine load only |
| 1.2.3 image / catalog / re-pin | 7/11 | code done; G5–G9 evidence being written; **line 7 is stale** |
| **1.2.4 AC2a route change** | **11/12** | **NEW. G9 is the R1 differential** |
| 1.3.1 shim retirement + live e2e | 0/12 | **NOT STARTED — this is the main remaining work** |

`bunx tsc --noEmit` is **0 errors** repo-wide. `bunx biome check` clean (386 files).

## RESOLVED THIS SESSION — do not reopen either of these

### 1. The route. AC2a's fallback SHIPS; the compiled route is gone.

`bun build --compile` collapses `import.meta.dir` to `/$bunfs/root` for **every** bundled module; a plain
`bun build --target=bun` collapses it to the **output file's directory**. The engine's import closure has
**two** consumers that need **different** bases:

```
src/phase-engine/roster/schema.ts:319   resolve(import.meta.dir,"..","..","..")   three up  → repo root
cli-anything/src/team-events.ts:46      join(import.meta.dir,"..","scripts",…)    one up    → cli-anything
```

No single collapsed value satisfies both, so **no bundling route exists** — and placing a bundle's output
so that one join lands leaves the other wrong. That is the measurement that closes the question; it is not
a preference. **Only unbundled source preserves per-module `import.meta.dir`**, which is what makes
`buildTeamSpawn` correct without modifying it (the story forbids modifying it).

What ships: system `bun` + **unbundled source baked at `/opt/qds-factory`** + a two-line `exec` wrapper.

```sh
#!/bin/sh
exec bun /opt/qds-factory/scripts/pipeline-run.ts "$@"
```

`ExecStart=/usr/local/bin/qds-engine run "%i"` is **byte-identical**, so DF2.10's unit contract and
leaf-1.1.2's conditional `%i` assertion both survive. **`exec` is not optional** — without it the shell
stays MainPID and `KillMode=mixed` SIGTERMs the shell, silently undoing #186 item 5. The Dockerfile
asserts the `exec` line at build time.

**Two things this forced, both of which are real changes to DF2.10 properties:**

- **The image now ships a `node_modules`.** Unbundled source must resolve `yaml` and `zod`. The AC5 gate
  in `build-exedev-image.ts` used to `die` on `treePackageCount > 0` ("this image installs no npm
  dependencies"). It is **narrowed, not waived**: a tree is admitted at `opt/qds-factory/node_modules` by
  **exact path** and refused anywhere else; complete sweep, zero unreadable/unresolved/missing-text, and
  full NOTICE coverage all still required. `verifyNoticeCoverage` was a structural invariant that could
  not come back dirty and is now a **real control**.
- **`bun install --production` at this workspace root is NOT the engine's closure.** MEASURED: **264
  package dirs, 243 MB**, including vue, typescript, openai, protobufjs, koffi, pi-ai — visualizer's and
  pi-vs-claude-code-vendor's dependencies. The builder copies **`yaml` and `zod` only** (both
  dependency-free, 6.2 MB), at the `--frozen-lockfile` versions. A **resolution probe** in the Dockerfile
  (`bun build --target=bun … --outfile /tmp/resolve-probe.js`, output discarded) resolves the entry's whole
  closure **against the shipped tree at the shipped path**, so a third bare specifier fails the build
  naming it, rather than failing on a paid box.

### 2. The licence. The `--push` blocker is discharged.

QDS-Factory is **private, proprietary** software — operator decision, already made. Declared as
`LicenseRef-QDS-Proprietary` in three places that must move together: root `LICENSE`, `package.json`
`"license"` (**alongside** `"private": true`, not instead of it), and the canonical text at
`oci/license-texts/LicenseRef-QDS-Proprietary.txt`, **byte-identical** to the root file.

Not `NOASSERTION` — that means "could not establish", which is false for first-party code and would
corrupt the two entries that use it with exactly that meaning for third-party artifacts. Not an OSS
identifier. `parseLicenseExpression` treats `LicenseRef-*` as an ordinary atom and the text lookup is
case-insensitive, so **no validator change was needed**.

The `UNVERIFIED` pin test was **inverted, not deleted**: it now fails if any top-level entry regresses to
UNVERIFIED, to NOASSERTION, or to an id with no checked-in text. The structural assertion stays separate,
so a bad edit still exits 2 rather than 1.

**Not legal advice. The repo `LICENSE` is a NOTICE, not the commercial grant** — the agreement you sell
under is a separate EULA/MSA and should face counsel before it faces a customer.

### 3. The LGPL correction — the item that was easiest to miss

The `qds-engine` entry disclosed statically linked **LGPL-2.0-or-later JavaScriptCore**. That was
**correct** while a `--compile` binary embedded the bun runtime. Under the new route that path holds a
two-line shell script, which embeds nothing, so the disclosure became a **false claim** — attributing to a
90-byte wrapper a relink obligation it cannot discharge. Removed from `qds-engine`; **still present on
`usr/local/bin/bun`**, the artifact that actually links it.

Both halves are pinned by **one** test (`"the LGPL relink obligation sits on the artifact that carries
it, and on no other"`), because dropping it from bun would be the opposite and worse defect. False
attribution is not the safe direction merely because it names more licences.

## What REMAINS

1. **leaf-1.3.1 — shim retirement + live e2e (AC7). Not started.** Ledger: `.unlazy/df1-10/gates/leaf-1.3.1.md`
   (12 gates). Retire `scripts/pipeline-run-remote.ts`; flip tier3's marker assertion; **rewrite
   `tier4-resident.live.test.ts`** (operator-approved, contract C16 — it currently mints a SECOND capped
   key, which AC3's negative control forbids); author `tier2-in-box-engine.live.test.ts`; run the round.
2. **R11 — execute the re-pin ritual. Now blocked ONLY on build + push + live boot.** The licence no longer
   blocks it. Build → push to ghcr → record digest+buildId → update **BOTH** hand-maintained literals
   (`src/providers/exedev/driver.ts:276-277,304` AND `tests/providers/exedev/image-contract.test.ts:1384`)
   → live-boot proof. Pin literals are currently UNTOUCHED, which is correct — no build has run.
   **Note: `package.json` is a `deriveBuildId` input, so this session's licence line already moves the
   buildId.** That is fine and expected, but it means the licence must land in the same commit set as the
   build, never after it.
3. **R1 — the differential suite comparison** (see below). This is also `leaf-1.2.4:G9`.
4. **Re-verify 1.2.1 (G3) and 1.2.3 (G5–G9)**, release their leases, then the branch/root gates.
5. Commit, `detect_changes()`, PR into `dev`.

## THE BASELINE — this overturns the ORIGINAL handoff, do not skip

An early handoff claimed `dev` was **4995 pass / 0 fail** and said "any red is yours." **Not reproducible.**
Measured on a pristine `origin/dev` worktree on a quiet machine (load 31→45):

```
4984 pass / 24 skip / 26 todo / 11 FAIL — 5045 tests, 165 files, 1423s
```

None of the 11 is a code defect. Ten are 5000 ms per-test timeouts in the DF5.2 push/worktree suites
(`AC3` ×2, `AC4` ×2, `AC5`, `INV-PR-6`, `INV-PR-2`, `withQuarantineWorktree` ×3). The eleventh
(`RSS watchdog > samples aggregate RSS from a real process group`, 177 ms — not a timeout) **passes in
isolation**; it samples a real process group and is contention-sensitive by construction.

**Therefore R1 is a DIFFERENTIAL gate, not an absolute one.** Satisfied when the feature branch's failure
SET is a subset of (or equal to) that baseline's, on the same machine under comparable load. Comparing
against zero would either block the story forever or push you to raise per-test budgets — **the one
shortcut all five leaves independently refused. Do not take it.**

## MACHINE LOAD IS A FIRST-CLASS HAZARD HERE

This host hit **load average 738** (Chrome, Docker Desktop's VM, WebKit, Bitdefender). Under it:

- The same command measured **33 s, 47 s and 196 s** in one window. Timing is not reproducible.
- `dispatch.test.ts`: **137 pass / 0 fail** at load 303, **83 pass / 54 fail** at load 490 — every failure
  at exactly ~5000 ms. Higher load once produced a *better* result: stochastic, not monotonic.
- Three separate leaves independently measured this and all three refused to raise timeouts.

**Before trusting any suite number: ask the operator to quit Chrome and pause Docker Desktop.** Then
measure. Re-run a suspicious failure in isolation before calling it real. `gate-check` also has a 120 s
default that SIGKILLs bun mid-suite and reports `output=(no output)` — indistinguishable from a real
failure. Always pass `--timeout 1800` or more.

## TRAPS — each of these cost real time to find

1. **Live-gated e2e tests are invisible to every static gate** (issue #210). `bun test`, `tsc`, `biome` and
   CI all stay green while a live test holds an assertion that contradicts the code; it fails first on a
   PAID box. `leaf-1.3.1:G6` and `:G11` grep the whole live tree for them.
   **A second instance of this shape was found and closed this session:** the three `COPY` lines staging
   `cli-anything` into the image were asserted by **nothing**. They could have been deleted with every
   static gate green, failing first on a paid box at the first `dispatch_task` phase. Now asserted in
   `image-assets.test.ts`. When you touch the Dockerfile, ask what asserts each directive.
2. **Fixture blast radius is invisible to `tsc`** (contract C23). Manifest fixtures are untyped object
   literals going through `JSON.stringify`, so a schema narrowing breaks them only at test RUNTIME.
3. **`bun test` output needs CR/ANSI stripping** or a plain grep silently reads as "no failures":
   `bun test … > /tmp/x.log 2>&1; tr '\r' '\n' < /tmp/x.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)"`
4. **`DOCKERFILE_DIRECTIVES` in `image-assets.test.ts` strips `#` comments, and you want that.** The route
   comment block quotes `--compile` several times while explaining why it is gone; an assertion over raw
   text would read those and fail. Assert over directives, not prose.
5. **GitNexus crash-loops on Node 24.** Use Node 22 (`/Users/steve/.local/bin/node` = v22.22.3) on PATH.
   Reindex ONLY via `bash scripts/install-gitnexus-plus.sh`, never a bare `gitnexus analyze`.
6. **The Bash tool persists working directory.** Use absolute `cd /Users/steve/QDS-Factory && …`.
7. **An overlay attribution harness answers CAUSATION, not OWNERSHIP.** It pins the baseline at a commit,
   so it is structurally blind to concurrent changes. When the harness and the shared tree disagree, that
   difference IS the set of concurrent changes — look there first, not last.
8. **A discriminator that depends on the ABSENCE of something in the other branch is a coincidence, not a
   discriminator.** `argv[2] === "--"` broke at the branch that did not change.
9. **The ADR predates the renumbering.** Its Consequences item 2 lumps the steering executor into DF1.10.
   That is **DF1.11's**. Build to the STORY's scope. `no-ack`/exit-6 stays the honest live PASS shape.
10. **An absence assertion needs a positive control in the same test.** `not.toContain("--compile")` passes
    just as well when the scan reads nothing. The route test pairs it with two positives, and the control
    was **mutation-tested**: re-introducing `--compile` on the real directive line failed it (`0 pass /
    1 fail`), then the Dockerfile was restored byte-exact from backup.

## Open items needing YOUR judgment

- **Two files were modified outside leaf-1.2.3's declared OWNS and were not reported**: `.dockerignore` and
  `.github/workflows/verify-image-pin.yml`. Both look substantively justified (`.dockerignore` is now a
  `deriveBuildId` input at `build-exedev-image.ts:1242`, so C18 required it), but confirm before committing.
- **leaf-1.2.3 narrowed the AC6 QDS_* leak scan** to allow-list `QDS_PI_CATALOG_DIR` and `QDS_TEAM_RUNNER`
  by whole line, read back out of the shipped unit. Tight (a third variable fails; a different VALUE fails)
  and `QDS_RUN_ROOT`/`QDS_STEERING_ROOT` stay refused — but this is a narrowed SECURITY scan and DF1.11's
  INV-IBOX-13 and DF3.7's AC4 both rest on it.
- **The AC5 narrowing is a security-adjacent change to a MERGED story's property.** DF2.10 shipped "no npm
  tree at all"; DF1.10 makes it "one tree, at one path, fully attributed". It is argued in the Dockerfile,
  in `build-exedev-image.ts`, and in PLAN C37 — but it is the kind of change a reviewer should push on, and
  it should not slide through as an implementation detail.
- **Latent coupling with no guard:** `BOX_RUN_ROOT` (harvest, host-side literal) is deliberately NOT
  imported from `journal.ts`. Correct — but if the in-box marker root ever moves, both must move and
  nothing enforces it.
- **Capacity edge:** the engine log is unbounded by design riding a tar capped at `TAR_MAX_BYTES` 512 MiB.
  The cap refuses loudly rather than truncating — the right failure — but a long run with chatty `code`
  phases is the plausible first way it is hit in production.
- **The image grew.** The compiled route shipped one 82 MB ELF; this ships a source tree plus 6.2 MB of
  `node_modules`. Net size has NOT been measured — no build has run. Measure it at R11.
- `_bmad-output/evidence/df1-4/{e2e-two-phase-trace.db,two-page-read.json}` get dirtied by the test suite
  (known issue #138). **Restore them before committing** — they must not ride in the PR.

## Operator decisions already made — do not relitigate

- **Narrow `PhaseKind`, do not implement `engineer`/`agent`.** Design §5.1 names `dispatch_task` as THE
  tier-3 seam; D5 explicitly rejects SSSF's single-agent-per-phase model, which is what `agent` is.
- **`tier4-resident.live.test.ts` IS in scope** and must be rewritten (C16).
- **The route is settled (C36).** R4 proved a compiled `--target=bun-linux-x64` ELF runs and `bun:sqlite`
  works inside the pinned `exeuntu` base at linux/amd64. That proof stands and is simply **not the property
  that decided the route** — C17 is superseded, not failed. R4 was always NARROWER than first recorded: it
  proved the runtime loads, NOT that the engine's dependencies resolve.
- **The licence is declared (C38).** Proprietary. Not OSS, not NOASSERTION.
- **HITL:** spec at `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df-future-hitl-pause-phase.md`
  (373 lines, PROPOSED). Recommends AGAINST a `pause` phase kind — the reaper collects a paused run
  (`reaper.ts:479-489`), so keeping a box alive for a human does not merely cost money, it does not work.
- **The lock race stays WIDE** (issue #212). `markRunLockDestructive` is an in-process `Set`; no
  cross-process signal exists. Documented as wide, accepted on blast radius.

## Issues filed

- **#186** — REOPENED. Auto-closed by `0b3acc8`, whose prose read "nothing else can close: #186"; GitHub
  parsed `close: #186` as a keyword. Zero checklist items were ticked.
- **#210** — live-gated e2e tests invisible to every static gate. **A second instance found this session**
  (the unasserted `cli-anything` COPYs); consider widening the issue to "unasserted build directives".
- **#211** — `runAgentPhase` now formally unreachable; deliberately kept (it holds the ONLY coverage of the
  dual-retry discipline).
- **#212** — lock body carries no holder, so no cross-process check can distinguish teardown from harvest.

## Sandbox capability — asked and MEASURED this session, so it is not re-asked

From the real-box probe (`_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`) and the
Dockerfile:

| | status |
|---|---|
| **bun** | ✅ our image installs it, pinned 1.3.13 at `/usr/local/bin/bun`. Stock exeuntu has **none** (`exit 127`) |
| **node** | ❌ **absent.** Not on the stock box (`exit 127`), and this Dockerfile never installs it |
| **local web server** | ✅ Ubuntu 24.04, systemd PID 1, full userland. Nothing in `qds-run@.service` blocks binding a port |
| **browser / agent clicks a UI** | ❌ **no browser.** Zero hits for chromium/playwright/puppeteer/xvfb in the image |

`pi` runs without node because exe.dev ships it as a compiled ELF — which is why the node absence went
unnoticed for so long. Headless-browser interaction is a real image change (Chromium + deps) and drags a
large attribution surface straight through the AC5 gate; **it deserves its own story**, not a side-effect
of this one. Note the AC5 gate is BUILD-TIME only: an agent running `bun install` or starting a dev server
inside a live box is untouched by it.

## How to work

- **MUST** run gitnexus `impact({target, direction:"upstream"})` before editing any symbol; report blast
  radius; warn on HIGH/CRITICAL. **MUST** run `detect_changes()` before committing.
- Claim leases with `gate-check.mjs --scope df1-10 --leaf <id> --claim` before dispatch.
- **Re-verify every leaf yourself** (`--approve --timeout 1800`). Do not accept self-reports — a leaf
  reported "zero errors in my files" during a window when its own file had six, and evidence written
  charitably by the driver misattributed a real regression to noise.
- Cross-leaf values go in the CONTRACT TABLE, never peer-to-peer messages (C35).
