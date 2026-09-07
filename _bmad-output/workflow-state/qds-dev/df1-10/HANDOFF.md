# DF1.10 — In-Box Phase Engine: successor handoff

Paste everything below the line into a fresh conversation.

---

You are finishing **DF1.10 — In-Box Phase Engine (8 pts, v5-S3)** in `/Users/steve/QDS-Factory`.
Branch `feature/df1.10`, committed and pushed through `3fa49d11`. PRs target `dev`.

**You have the operator's standing authorization for live E2E on real exe.dev boxes with real spend.**
Print a worst-case estimate before any TIER-2+ run, then proceed.

## Where this stands in one paragraph

The engine runs in-box. Route changed, licence declared, shim retired, image built + pushed + pinned,
branch committed, **tier-1 live is GREEN**, and the first tier-2 in-box round found a real defect that is
now FIXED but NOT YET REBUILT. Thirteen of fourteen leaf ledgers are ALL MET. Your job: re-pin, finish
live tiers 2–5, close the five live gates on `leaf-1.3.1`, and open the PR.

## Read first, in this order

1. `.unlazy/df1-10/PLAN.md` — the contract. **Revision 11.** Read C36–C41 first; they supersede earlier rows.
2. `.unlazy/df1-10/status.log` — the running record. The 2026-09-04 entries carry every live finding.
3. `.unlazy/df1-10/gates/leaf-1.3.1.md` — the only ledger with open gates (7/12).
4. `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED, and it IS the latest ADR).
5. The `qds-live-e2e` skill — **mandatory before any live tier.** It is the operating procedure.

`.unlazy/df1-10/recon/R{1..6}-*.md` is ~5,000 lines of file:line-cited recon. **Do not re-derive it.**

## ⛔ DO THIS FIRST — the pin is STALE

`3fa49d11` changed `oci/exedev/systemd/qds-run@.service`, which is a `deriveBuildId` input. The pin in
`driver.ts` describes the PREVIOUS image. **No live tier is meaningful until you re-pin.**

```bash
gh auth token | docker login ghcr.io -u biospark33 --password-stdin
bun scripts/build-exedev-image.ts --tag "ghcr.io/quantum-digital-solutions/qds-exedev:sha-$(git rev-parse HEAD)" --push
```

Then adopt the new digest + buildId into **three** places (older handoffs said "both" and were wrong):

| site | what |
|---|---|
| `src/providers/exedev/driver.ts:277` | `DEFAULT_IMAGE_REF` digest |
| `src/providers/exedev/driver.ts:324` | `DEFAULT_IMAGE_BUILD_ID` |
| `tests/providers/exedev/image-contract.test.ts:1383-1384` | both buildId assertions |

`tests/scripts/build-exedev-image.test.ts`'s #187 fixture is **NOT** a pin — it is an input to
`buildArgList` and is deliberately `"b".repeat(16)` so a re-pin grep stops returning a false hit. Leave it.

Then re-push the private mirror (`tier1-registry-auth` derives its digest from `DEFAULT_IMAGE_REF`):

```bash
docker buildx imagetools create --tag "ghcr.io/quantum-digital-solutions/qds-exedev-private:sha-$(git rev-parse HEAD)" "<new digest ref>"
```
`imagetools create` wraps the manifest in an index under a NEW digest, but the original OCI manifest is
copied and remains addressable at the pinned digest there. **Verify that explicitly** —
`docker buildx imagetools inspect <private-repo>@<pinned-digest>` must resolve.

**Commit and PUSH before any live tier**: dispatch clones `QDS_EXEDEV_SHA` from the remote, and the image
bakes `gitSha` — an image built on an uncommitted tree stamps `/etc/qds-image.json` with a commit that
cannot reproduce it. Commit precedes push, always.

For the previous values (as a worked example of the ritual, now superseded): digest
`sha256:eb169d40cac7142c6a84f04d2c22e162f9731983aa9c8f7d03fae36fb3be9f46`, buildId `e04144e6f4a86fc6`,
gitSha `237295ac…`.

## Ledger state — 13 of 14 ALL MET, zero leases held

`leaf-1.1.1` 9/9 · `1.1.2` 6/6 · `1.1.3` 7/7 · `1.1.4` 6/6 · `1.1.5` 5/5 · `1.1.6` 5/5 · `1.2.1` 7/7 ·
`1.2.2` 7/7 · `1.2.3` 12/12 · `1.2.4` 14/14 · `1.3.1a` 6/6 · `1.3.1b` 7/7 · `1.3.1c` 7/7.

**`leaf-1.3.1` is 7/12.** The five open gates are exactly the ones needing a paid round:

- **G2** no host process executes a phase body in any live tier (the negative control MUST fail)
- **G8** round-exit hygiene: `ssh exe.dev ls --json` → `{"vms":[]}`, and the key-hash snapshot before ==
  after. **The BEFORE snapshot is already taken: 7 hashes in `.unlazy/df1-10/keyhashes-before-round.json`.**
- **G9** `oci/authprobe` was NEVER pulled with credentials during the round (one authenticated pull warms
  its digest and silently re-opens the AC4 false green it exists to prevent)
- **G10** real spend recorded and in band (~$0.02); anything over $0.10 investigated as a loop, not accepted
- **G12** a record carrying `extensions.approval.state:"live"` is NOT probed and keeps its echoed state,
  on the LIVE path (leaf-1.1.3 proved it only at unit level)

Suite: **5154 pass / 0 fail / 5189 tests / 171 files.** `tsc` 0. `biome` clean, 386 files.
R1 is satisfied OUTRIGHT — the failure set is EMPTY, a strict subset of the baseline's 11. **No per-test
timeout was ever raised.** Five leaves independently refused that shortcut; do not take it now.

## Live round status

**TIER-1: GREEN.** `driver-lifecycle` 1/1, then `provision-status`, `lock`, `fanout-refusal`,
`attach-transport`, `harvest`, `teardown`, `approval-gate` → **7 pass / 0 fail**, fleet `{"vms":[]}` after.
The image was PROVEN booting: evidence `2026-09-04-115819-t1-1-driver-lifecycle.json` stamps
`{"buildId":"e04144e6f4a86fc6","overriddenBy":[],"isRepoPin":true}`.

**TIER-1 registry-auth: BLOCKED**, see below.
**TIER-2/3/4/5: NOT RUN.** Blocked on the re-pin above.

Run order: free checks (tsc, biome) → TIER-1 → paid tiers sequentially. Never run the full `bun test`
suite in parallel with a live tier.

```bash
export QDS_E2E_LIVE=1
export QDS_E2E_TIER=2     # ONLY "1" or "2" — liveGate accepts nothing else
export QDS_EXEDEV_REPO_URL=https://github.com/Quantum-Digital-Solutions/QDS-Factory.git
export QDS_EXEDEV_SHA=$(git rev-parse HEAD)      # MUST be pushed
export QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml
```

**Eight files' prefixes lie.** `tier3-*`, `tier4-resident` and `tier5-gate-steering` all call
`liveGate("2")`. Read the CALL, never the filename: `grep -n 'liveGate(' <file>`.

## ⛔ TWO OPEN ITEMS THAT ARE NOT YET FIXED

**1. `PROVISION_ACTION_TIMEOUT_MS = 60_000` (`src/providers/driver.ts:104`) vs a MEASURED 86 s cold pull.**
Its own comment says the value is "the same 60 s the DF2.6 reaper gives each of its per-unit provider
ops" — but a reaper op destroys or lists, while `create` can include a ~1 GB image pull.
`tier1-registry-auth:28` records "4/4 creates in 2-3 s against an **86 s cold pull** of the same digest".
So the FIRST create after ANY re-pin systematically times out — we hit it live:
`box create timed out after 60000ms — the call was ABANDONED, not cancelled`, which is the orphan-box
shape. **This is production-relevant: the first customer dispatch after every image bump can fail.**
It reproduces on YOUR re-pin, so expect it. Do NOT just raise the shared constant — `create` deserves its
own budget because it is a different operation class from the reaper ops the number was borrowed from.
Decide, fix, and pin it with a test.

**2. `QDS_E2E_REGISTRY_AUTH_FILE` — OPERATOR INPUT.** 0600 file containing `biospark33:<PAT>`, PAT scoped
**`read:packages` ONLY**. `tier1-registry-auth` THROWS (never skips) without it.
**Do NOT substitute a broader token** — not `gh auth token` (it carries `repo`, `workflow`,
`write:packages`). The test hard-codes `scope:"read:packages"` into a ratification record naming
dr.steve as `rotationOwner` (`:330`, `:337`), so a broader credential makes that SECURITY audit record
false. GitHub has no API to mint PATs; it is web-UI only. If the operator declines, record it as a
DELIBERATE, NAMED gap in the round report — do not pass it with a mis-scoped credential.

## What the live round has already found — three real defects, all fixed

**A. `pullArtifacts` sent an empty argv element the real driver refuses** (`f77c9a07`).
`["bash","-s","--",runId,root, boxHome ?? ""]` — the empty `$3` made the in-box script default to the
box's `$HOME`, which is true of the SCRIPT and false of the DRIVER: `ExeDevDriver.exec` rejects empty
elements (`driver.ts:1235` and `:1249`, hardening added AFTER the idiom). One cause, FIVE red tests
(artifacts fail → harvest exits 1 → teardown waives → exits 6 → four callers asserting 0).
**Why 5154 tests missed it, and the reusable lesson:** `FakeDriver.exec` checked only `length === 0`, and
`harvest.test.ts` PINNED the broken shape under the title "production defaults … an EMPTY home". The fake
and the test agreed with each other about a shape the substrate rejects on sight — worse than no
coverage, because it reads as coverage. Fixed on both axes: element omitted (not emptied), and the FAKE
now mirrors the driver's rule verbatim so every existing test guards the class.

**B. The in-box engine could not create its own runtime directories** (`3fa49d11`) — THE core defect.
`EACCES: permission denied, mkdir '/run/trace'`, `ExecMainStatus=2`. `/run` is root-owned tmpfs, the unit
runs as `User=exedev`. The engine could never have completed a single run. Fixed with
`RuntimeDirectory=journal trace` / `Mode=0700` / `Preserve=yes` on the unit — NOT a tmpfiles entry
(steering is boot-scoped and DF2.10 pins its conf as one line; these are run-scoped). `Preserve=yes` is
load-bearing: systemd deletes a RuntimeDirectory at unit stop and the marker must outlive the engine for
`fleet status` and harvest. The Dockerfile now asserts both at build time.

**C. A fixture discriminator that rested on defect A** — `patterns.test.ts` keyed on
`argv.length === 5 && argv[2] === "--"` above a comment claiming artifacts uses plain `bash -s`. False;
only the LENGTH separated them, and artifacts was 6 solely because of the empty element. Now keys on the
stdin script. **This is the handoff's own trap #7, biting in the same place twice.**

## TRAPS — every one of these cost real time

1. **A background command's shell exit is NOT the tool's exit.** `bun … > log; echo "exit=$?" >> log;
   echo started` returns 0 because the trailing `echo` succeeded. A FAILED build was reported as passing.
   Write `EXIT=$?` as the log's LAST line and read that.
2. **Live-gated tests are invisible to every static gate** (#210). Three instances found this session.
3. **A sourcemap read UNDER-REPORTS the module closure.** `bun build` RESOLVES every import and only then
   tree-shakes, so a module must EXIST while contributing no code. Reading `sources` agreed with a FALSE
   Dockerfile comment. Converge by replicating the COPY set in a scratch tree and re-running the probe.
4. **~5000 ms is the load-flake signature — but the SIGNATURE IS NOT THE EVIDENCE.** Re-run in isolation
   to classify. `dispatch.test.ts` measured 137 pass at load 303 and 83 pass / 54 fail at load 490.
   `cli.test.ts` flakes intra-file.
5. **Two gate oracles here had to be REWRITTEN, not the code** (`leaf-1.1.6:G2`, `leaf-1.3.1:G11`). A
   string-absence grep over source that also DOCUMENTS the string cannot tell a claim from its
   explanation; the failure mode is always "delete the explanation to go green". G11 also CONTRADICTED
   its own ledger's G12. Strip comments before matching, and mutation-test the result.
6. **Bisect, do not infer.** The `patterns.test.ts` cause was wrong twice under inference; stashing each
   change alone produced two DIFFERENT failures and that is what separated regression from coincidence.
7. **`gate-check` defaults to 120 s** and SIGKILLs bun mid-suite, reporting `output=(no output)` —
   indistinguishable from a real failure. Always `--timeout 1800`.
8. **`bun test` output needs CR/ANSI stripping** or a plain grep silently reads as "no failures":
   `tr '\r' '\n' < log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)"`
9. **`timeout` is not on macOS.** Use `ssh -o ConnectTimeout=N`.
10. **The ADR's Consequences item 2 predates the renumbering** — the steering executor is **DF1.11's**.
    ADR:118-119 is operative: `no-ack`/exit-6 stays, and NO interim transport machinery.
11. **Restore `_bmad-output/evidence/df1-4/*` after any suite run** (#138) — must not ride in the PR.

## Already measured — do not re-spend on these

- `ssh exe.dev` OK, region lax. Pre-round key snapshot: **7 hashes**, in
  `.unlazy/df1-10/keyhashes-before-round.json`. Compare at round end for G8.
- **`DefaultTimeoutStartUSec` = 1min 30s**, systemd 255 / Ubuntu 24.04, measured on a real box. That is
  the ceiling `RUN_START_TIMEOUT_MS` (120 s) must strictly exceed.
- **NOT measured: whether systemd sets `$HOME` for a `User=` unit.** No sudo on these boxes; another
  user's `/proc/<pid>/environ` is unreadable. `deriveInBoxArgv` hard-refuses without HOME
  (`pipeline-run.ts:1616`). Mitigated, not assumed: `tier2-in-box-engine` fast-fails the poll when the
  unit has already exited non-zero — it is what turned defect B into an 84-second discovery instead of a
  25-minute one. **Do not launder systemd's docs into a "measurement".**
- Sandbox capability: **bun YES** (our image, 1.3.13). **node NO** (absent on stock exeuntu, `exit 127`;
  we never install it). Local web servers YES. **Browser / agent-clicks-UI NO** — zero
  chromium/playwright/puppeteer/xvfb. That is its own story, not this one.

## Definition of done

1. Re-pin executed and adopted (3 sites), private mirror re-pushed and its pinned digest verified.
2. Every live tier file green at least once **on the final SHA**, with an evidence JSON for each. Any file
   left red is NAMED in the report with its reason — never hidden, never passed by weakening an assertion.
3. `leaf-1.3.1` G2/G8/G9/G10/G12 closed with evidence; re-verify with
   `gate-check.mjs --approve --timeout 1800`.
4. Round-exit hygiene: `ssh exe.dev ls --json` → `{"vms":[]}`; key-hash snapshot equals the 7-hash before;
   `.sandbox/fleet.lock` absent or holder dead.
5. Full `bun test` clean with nothing else running. Name any environmental failures; do not hide them.
6. `detect_changes()` before committing (repo rule). `impact({direction:"upstream"})` before editing any
   symbol; warn on HIGH/CRITICAL.
7. Spend recorded and in band.
8. **PR into `dev`** — not `main`. `dev` is the integration base. Body should carry: the AC2a route change
   and the measurement that forced it, the AC5 narrowing (a real change to a MERGED story's property, and
   a reviewer should push on it), the licence declaration, and the three live-found defects above.
9. Restore `_bmad-output/evidence/df1-4/*`.

## Open issues

**#213 (new)** — `fleet rank --steps-json` has no producer after AC7 retired the shim; `rank` degrades to
"every arm unscored" and exits 0, so it ships green while permanently degraded. Likely answer: derive
from the journal. Deliberately not guessed at inside DF1.10.
Also open: **#186** (REOPENED), **#210**, **#211**, **#212**.

## How to work

- Re-verify every leaf yourself. Do not accept self-reports — a leaf once reported "zero errors in my
  files" while its own file had six.
- Cross-leaf values go in the CONTRACT TABLE, never peer-to-peer messages (C35).
- Keep `.unlazy/` untracked (it is in `.git/info/exclude`).
- **Never raise a per-test timeout to make a suite green.** Five leaves refused that shortcut; the R1
  differential is currently satisfied outright, so there is nothing to buy with it.
