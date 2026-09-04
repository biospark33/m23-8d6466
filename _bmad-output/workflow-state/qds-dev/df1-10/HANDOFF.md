# DF1.10 — In-Box Phase Engine: successor handoff

Paste everything below the line into a fresh conversation.

---

You are picking up **DF1.10 — In-Box Phase Engine (8 pts, v5-S3)** in `/Users/steve/QDS-Factory`.
Branch `feature/df1.10`, **committed and pushed** (`237295a`, `debbcd7` + any later). PRs target `dev`.

## The state in one paragraph

The engine now runs in-box. The route was changed, the image was **built and pushed to ghcr**, the pin
was **adopted**, the branch is **committed**, and the **live round is under way**. Every leaf ledger is
ALL MET except the live-round parent. The remaining work is: finish live tiers 2–5, write the round
report, open the PR. One defect found live has been fixed; one credential is still needed from the
operator.

## Read these first, in this order

1. `.unlazy/df1-10/PLAN.md` — the contract. **Revision 11.** Read C36–C41 FIRST; they supersede earlier rows.
2. `.unlazy/df1-10/status.log` — the running record. The 2026-09-04 entries carry the live-round findings.
3. `.unlazy/df1-10/gates/leaf-*.md` — 14 ledgers. All ALL MET except `leaf-1.3.1` (7/12).
4. `.unlazy/df1-10/recon/R{1..6}-*.md` — file:line-cited recon. **Do not re-derive.**
5. Governing ADR: `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED, and it IS the latest).
6. The live-round procedure: the `qds-live-e2e` skill. **Mandatory before any live tier.**

## Ledger state

| Leaf | Gates | State |
|---|---|---|
| 1.1.1 engine core | 9/9 | VERIFIED |
| 1.1.2 `fleet run` verb | 6/6 | VERIFIED |
| 1.1.3 in-box status (AC5) | 7/7 | VERIFIED |
| 1.1.4 manifest fixtures | 6/6 | VERIFIED |
| 1.1.5 R1 regressions | 5/5 | VERIFIED |
| 1.1.6 start deadline | 5/5 | VERIFIED |
| 1.2.1 run-root (AC2b) | 7/7 | VERIFIED |
| 1.2.2 harvest (AC4) | 7/7 | VERIFIED |
| 1.2.3 image/catalog/re-pin | 12/12 | VERIFIED |
| 1.2.4 AC2a route change | 14/14 | VERIFIED |
| 1.3.1a shim retirement | 6/6 | VERIFIED |
| 1.3.1b tier3+tier4 rewire | 7/7 | VERIFIED |
| 1.3.1c tier2 + sweeps | 7/7 | VERIFIED |
| **1.3.1 live-round parent** | **7/12** | **G2, G8, G9, G10, G12 need the paid round** |

**ALL LEASES RELEASED.** `.unlazy/locks/` is empty.

Suite: **5154 pass / 0 fail / 5189 tests / 171 files.** `tsc` 0 errors. `biome` clean, 386 files.
R1 is satisfied OUTRIGHT — the failure set is empty, a strict subset of the baseline's 11. No per-test
timeout was ever raised; the shortcut five leaves refused was never taken.

## The pin — CURRENT, adopted, verified against the registry

```
DEFAULT_IMAGE_REF       ghcr.io/quantum-digital-solutions/qds-exedev@sha256:eb169d40cac7142c6a84f04d2c22e162f9731983aa9c8f7d03fae36fb3be9f46
DEFAULT_IMAGE_BUILD_ID  e04144e6f4a86fc6          (was 3cf094fb6990ed66)
gitSha baked in image   237295aca99b7d2eeacbae2cf459aae8422e5414
```

`--push` re-read the tag from the registry and the registry agreed, so the digest is what ghcr resolves,
not what the local exporter reported. The private mirror `qds-exedev-private` was re-pushed;
`imagetools create` wraps the manifest in an index under a NEW digest, but the original OCI manifest is
copied and **remains addressable as `…eb169d40…` there** — VERIFIED, and that is what
`tier1-registry-auth` pulls.

**PROVEN ON A REAL BOX**: evidence `2026-09-04-115819-t1-1-driver-lifecycle.json` stamps
`{"ref":"…eb169d40…","buildId":"e04144e6f4a86fc6","overriddenBy":[],"isRepoPin":true}` — the box booted
the exact repo pin, no env override.

**A THIRD pin literal exists** that older handoffs did not name (they said "BOTH"):
`tests/scripts/build-exedev-image.test.ts`'s #187 fixture. It is an INPUT to `buildArgList`, NOT a pin —
it is now `"b".repeat(16)` so a re-pin's "did I catch every literal?" grep stops returning a false hit.
The two real sites are `src/providers/exedev/driver.ts:277,324` and
`tests/providers/exedev/image-contract.test.ts:1383-1384`.

## RESOLVED — do not reopen

**The route (C36).** `bun build --compile` collapses `import.meta.dir` to `/$bunfs/root`; a plain
`bun build --target=bun` collapses it to the output file's directory. The closure has TWO consumers
needing DIFFERENT bases — `src/phase-engine/roster/schema.ts:319` (three up) and
`cli-anything/src/team-events.ts:46` (one up) — so NO bundling route exists. Ships: system bun +
unbundled source at `/opt/qds-factory` + a two-line `exec` wrapper. `ExecStart` is byte-identical.
`exec` is load-bearing (without it the shell stays MainPID and `KillMode=mixed` signals the wrapper).

**AC5 narrowed, not waived (C37).** The image now ships a `node_modules`; the gate admits a tree at
`opt/qds-factory/node_modules` BY EXACT PATH and refuses one anywhere else. `bun install --production`
at this workspace root resolves **264 packages / 243 MB**; the engine needs **2**. The builder copies
`yaml` and `zod` only, and an in-stage resolution probe fails the build naming any third specifier.

**Licence (C38).** `LicenseRef-QDS-Proprietary` — root `LICENSE`, `package.json` `license` (alongside
`private: true`), canonical text byte-identical. NOT NOASSERTION. The UNVERIFIED pin test is INVERTED,
not deleted. **Not legal advice; the repo LICENSE is a notice, not the commercial grant.**

**LGPL correction (C39).** The JSC disclosure is off `qds-engine` (a shell script embeds nothing) and
REMAINS on `usr/local/bin/bun`. One test pins both halves.

**ADR alignment (C40) and a falsified premise (C41).** ADR:118-119 is the operative interim rule —
`no-ack`/exit-6 stays, NO interim transport machinery; the steering executor is **DF1.11's** (the ADR's
Consequences item 2 says "DF1.10" but predates the renumbering).

## WHAT REMAINS

1. **Live tiers 2–5.** Tier-1 is green after the fix below. Tier-2 includes the net-new
   `tier2-in-box-engine.live.test.ts` — the test that proves the box did the work while the host started
   a unit and walked away. Then tier3 files, tier4-resident, tier5-gate-steering.
   **`QDS_E2E_TIER` takes ONLY "1" or "2".** Eight files' prefixes lie; read the `liveGate(` call.
2. **`QDS_E2E_REGISTRY_AUTH_FILE` — OPERATOR INPUT, still outstanding.** 0600 file
   `biospark33:<PAT>` where the PAT is **`read:packages` ONLY**. `tier1-registry-auth` THROWS without it.
   Do NOT substitute a broader token (e.g. `gh auth token`, which carries `repo`/`workflow`/
   `write:packages`): the test hard-codes `scope: "read:packages"` into a ratification record naming
   dr.steve as rotationOwner (`:330`, `:337`), so a broader credential makes that SECURITY audit record
   false. GitHub has no API to mint PATs — it is web-UI only. One test of twenty; everything else runs.
3. **Round report + `leaf-1.3.1` G2/G8/G9/G10/G12**, then PR into `dev`.

## THE DEFECT THE LIVE ROUND FOUND — and the lesson, which is the valuable part

`src/providers/harvest.ts` `pullArtifacts` passed an EMPTY third positional so the in-box script's
`home="${3:-$HOME}"` would resolve the box's own `$HOME`. True of the SCRIPT. **False of the DRIVER**:
`ExeDevDriver.exec` refuses any argv with an empty/whitespace-only element (`driver.ts:1235` AND `:1249`,
hardening added in DF2.10 rounds 6-7, AFTER the idiom was written).

Live symptom: `{"harvested":1,"artifacts":"failed"}` → harvest exits 1 → teardown waives harvest and
exits **6** → four more tests asserting `0` go red. **One cause, five red tests.**

**Why 5154 unit tests could never see it — remember this shape:**
1. `FakeDriver.exec` checked only `argv.length === 0`, never the per-element rule. A fake WEAKER than the
   thing it stands in for does not merely miss a bug, it **certifies** it.
2. `tests/providers/harvest.test.ts` **PINNED THE DEFECT** — `expect(seen).toEqual([…,BOX_RUN_ROOT,""])`
   under the title "production defaults … an EMPTY home". It asserted what the code DID while the fake
   underneath did not enforce the real contract, so **the fake and the test agreed with each other about
   a shape the substrate rejects on sight.** That is worse than no coverage; it reads as coverage.

FIXED on both axes: the argv element is OMITTED (not emptied — `$3` unset makes `${3:-$HOME}` work, and
`set -u` is safe on a `${x:-default}` expansion), and the FAKE now mirrors the driver's rule verbatim so
every existing test guards the class. The test asserts the INVARIANT (no empty elements) beside the
literal.

**SECOND-ORDER — handoff trap #7 bit in the same place twice.** Those fixes broke
`tests/fleet/patterns.test.ts`'s race fixture, which keyed on `argv.length === 5 && argv[2] === "--"`
above a comment claiming "artifacts' shape is plain `bash -s`". FALSE — artifacts also execs
`bash -s --`; the ONLY separator was the LENGTH, and artifacts was 6 solely because of the empty element.
The discriminator rested on the bug. Now keys on the STDIN SCRIPT (intrinsic; the artifacts script names
its own tarball). **Diagnosed by BISECTION, not inference** — stashing each change alone produced two
DIFFERENT failures, which is what separated "my regression" from "the fixture's coincidence". Guessing
was wrong twice before measuring.

## TRAPS — each cost real time

1. **Live-gated tests are invisible to every static gate** (#210). Two more instances found this session:
   the unasserted `cli-anything` COPY lines, and the empty-argv defect above.
2. **A background command's shell exit is NOT the tool's exit.** `bun … > log; echo "exit=$?" >> log;
   echo started` reports 0 because the trailing `echo` succeeded. I misread a FAILED build as passing.
   Write `BUILD_EXIT=$?` as the log's LAST line and read that.
3. **A sourcemap read under-reports the module closure.** `bun build` RESOLVES every import and only THEN
   tree-shakes, so a module can be required to EXIST while contributing no code. Reading `sources` agreed
   with a FALSE Dockerfile comment. Converge by replicating the COPY set in a scratch tree and re-running
   the real probe.
4. **`bun test` output needs CR/ANSI stripping** or a plain grep silently reads as "no failures".
5. **Two gate oracles in this scope had to be REWRITTEN, not the code** (`leaf-1.1.6:G2`,
   `leaf-1.3.1:G11`). A string-absence grep over source that also DOCUMENTS the string cannot tell a
   claim from its explanation; the failure mode is always "delete the explanation to go green". G11 also
   CONTRADICTED its own ledger's G12. Strip comments before matching, and mutation-test the result.
6. **Machine load is a first-class hazard.** `dispatch.test.ts` measured 137 pass at load 303 and
   83 pass / 54 fail at load 490, every failure at exactly ~5000 ms. `cli.test.ts` flakes intra-file.
   ~5000 ms is the signature — but the SIGNATURE IS NOT THE EVIDENCE. Re-run in isolation to classify.
7. **`gate-check` has a 120 s default** that SIGKILLs bun mid-suite and reports `output=(no output)`.
   Always `--timeout 1800`.
8. **The ADR predates the renumbering** (see C40).
9. **`timeout` is not on macOS.** Use `ssh -o ConnectTimeout=N`.

## Live-round facts already measured — do not re-spend on these

- `ssh exe.dev` OK, region lax. Pre-round key snapshot: **7 hashes**
  (`.unlazy/df1-10/keyhashes-before-round.json`) — compare at round end.
- **`DefaultTimeoutStartUSec` = 1min 30s**, systemd 255 (Ubuntu 24.04), measured on a real box. That is
  the ceiling `RUN_START_TIMEOUT_MS` (now 120 s) must strictly exceed.
- **NOT measured: whether systemd sets `$HOME` for a `User=` unit.** No sudo on these boxes and another
  user's `/proc/<pid>/environ` is unreadable. `deriveInBoxArgv` hard-refuses without `HOME`
  (`pipeline-run.ts:1616`). Mitigated rather than assumed: `tier2-in-box-engine` fast-fails the status
  poll when the unit has already exited non-zero, turning EVERY early-refusal class from a ~25-minute
  paid discovery into seconds. Do not launder systemd's docs into a "measurement".
- Sandbox capability: **bun YES** (our image, pinned 1.3.13). **node NO** (absent on stock exeuntu,
  `exit 127`; our image never installs it). Local web servers YES. **Browser/agent-clicks-UI NO** — zero
  chromium/playwright/puppeteer/xvfb. That is its own story.

## Issues

**#213 NEW** — `fleet rank --steps-json` has no producer after AC7 retired the shim (the shim was its only
writer). `rank` degrades to "every arm unscored" and exits 0, so it ships green while permanently
degraded. Likely answer: derive from the journal, which the engine already writes and harvest returns —
a design decision, deliberately not guessed at inside DF1.10.
Also open: #186 (REOPENED), #210, #211, #212.

## How to work

- **MUST** run gitnexus `impact({target, direction:"upstream"})` before editing any symbol; warn on
  HIGH/CRITICAL. **MUST** run `detect_changes()` before committing.
- **Re-verify every leaf yourself** (`--approve --timeout 1800`). Do not accept self-reports.
- Cross-leaf values go in the CONTRACT TABLE, never peer-to-peer messages (C35).
- Restore `_bmad-output/evidence/df1-4/*` after any suite run (#138) — they must not ride in the PR.
