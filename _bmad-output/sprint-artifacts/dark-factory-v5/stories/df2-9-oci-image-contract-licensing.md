# DF2.9: OCI Image Contract + License-Compliance Build

**Story Points:** 5
**Sprint:** v5-S2 (moved from v5-S1 to relieve S1, which was over capacity at 53 pts; sprints are now S1 48 · S2 50 · S3 25 = 123. This story has **no dependency edges**, so it schedules freely and re-sequences nothing — but the surface is a real build: a post-build tree sweep, a Dockerfile, a CI job, and the NOTICE generator, not documentation)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §8 step 2 (image contract defined here so step 7's OCI driver needs no rework), §6.2 (credential containment), §9 R7
- Decision register: v5 §4 D8 (no long-lived secret in a box); derivation register §5 row 1 (**F13 binding conditions**)
- Findings: v5 §10 F13 (redistribution licensing is a blocker, not a footnote)
- Gate conditions discharged: `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §2 conditions 1–3 (+ the verifier's widening from five to fifteen packages)

## User Story

As the enterprise-tier operator shipping pi plus the vendored coms substrate into a client VPC,
I want the image build to generate its NOTICE from a sweep of the actual post-build tree and to fail closed across three distinct classes — attribution failures (an observed SPDX identifier has no canonical license text, or an uncovered package's resolved entry is verified absent from the generated NOTICE), policy failures (it is a forbidden package by name, or pi resolves off its pinned version), and prerequisite failures (an empty swept tree, a missing builder, an unreachable registry, an unreadable package, or an absent license-texts directory) — never merely because a package ships no license text of its own,
so that redistribution compliance is enforced by the build rather than by a hand-maintained list that goes stale the first time a dependency moves.

## Overview

The enterprise tier ships `@mariozechner/*` (pi) and the vendored coms files inside an OCI
image into client VPCs (v5 §8 step 2). F13 cleared that redistribution — no copyleft, no
unlicensed core — subject to three conditions. This story encodes them as a build: a
`scripts/lib/license-sweep.ts` module walks the **built image's** dependency tree, classifies
every package by whether it ships license text, and `scripts/generate-notice.ts` writes a
NOTICE covering the uncovered set into the image. The sweep is also the gate — it exits
nonzero, failing the build, on an attribution failure (an observed SPDX identifier — from a
covered or an uncovered package — has no canonical text, or a NOTICE verified to omit an
uncovered package it should cover), a policy failure (a denied package name or
an off-pin pi version), or a prerequisite failure (an empty tree, a missing builder, an
unreachable registry, an unreadable package, or an absent license-texts directory).
Alongside it: build with `--omit=optional`, pin pi to the vendored peer-pin, and correct the
false pi-mono provenance header in the one vendored file that carries it.

## E2E Slice

**Demonstrable behavior:** Given a clean checkout, When `bun run build:image` runs, Then it
installs with `--omit=optional`, pins `@mariozechner/pi-coding-agent@0.55.0`, sweeps the
resulting tree, writes `/usr/share/doc/qds-factory/NOTICE` covering every license-text-less
package (fifteen in the tree examined 2026-08-11) including the **full Apache-2.0 text** for
the three `@aws-sdk` packages, and tags the image — and When a denied package
(`@mariozechner/pi-proxy`) is injected at any depth, Then the build aborts before tagging and
names the offending path.

**Wiring closed:** On completion of this story, the image contract is real and enforced using
only code merged by this story. The sweep runs against a genuine post-build tree, not a
fixture. No stub, no `TODO: wire later`, and no sibling story is required. Registry push,
image signing, and the exe.dev/OCI **runtime** driver are explicitly not in this story (v5 §8
step 7).

**Dependency edges (predecessors):** none — F13 research is complete (gates report §2).

## Acceptance Criteria

1. **(make-or-break)** Given the image built with `--omit=optional`, When the sweep runs
   against the actual post-build tree, Then every package in that tree that ships no license
   text appears in the generated NOTICE with its license identifier, its copyright line, and
   its full canonical license text for that SPDX identifier — Apache-2.0 packages carrying the
   complete Apache-2.0 text — sourced from a checked-in mapping that covers every SPDX
   identifier the sweep can discover, not only MIT and Apache-2.0; a discovered identifier with
   no canonical text available fails the build at exit `2` before NOTICE generation, never as a
   partial or silently-omitted NOTICE entry. Being *uncovered* — shipping no license text of
   its own — is not by itself a failure: the sweep resolves canonical text and writes a NOTICE
   entry for it. Scoped to attribution behavior for uncovered packages specifically — the sweep
   separately fails closed on policy failures (a denied package name, an off-pin `pi-coding-agent`
   version) and on prerequisite failures (an empty swept tree, a missing builder, an unreachable
   registry, an unreadable package, or an absent license-texts directory), per the Overview's complete failure taxonomy — an
   uncovered package fails the build only when it cannot be attributed this way: no canonical text
   exists for its SPDX identifier (exit `2`, before NOTICE generation), or, as a build-time
   consistency check rather than a distinct compliance state, its resolved entry is verified absent
   from the generated NOTICE (exit `1`).
   *Negative control: an implementation that transcribes the twelve packages named in gates
   report §2 condition 1 into a static list passes a spot check and MUST fail this test,
   because the observed tree holds fifteen and the set shifts with `--omit=optional` and
   provider selection.*
2. Given the build command, When it completes, Then `@mariozechner/clipboard` and its
   platform binary packages are absent from the image tree (asserted by inspecting the tree,
   not by asserting the flag was passed), and `@mariozechner/pi-coding-agent` resolves to
   exactly `0.55.0` — any other version fails the build and names the observed one. Its
   transitive `@mariozechner/pi-{agent-core,ai,tui}` legitimately float inside `0.55.x` (the
   local tree carries **0.55.4** under a 0.55.0 coding-agent); the sweep **records** their
   observed versions in the summary and fails only if one leaves `0.55.x`.
3. Given a tree containing `@mariozechner/pi-proxy` or `@mariozechner/pi` at any depth, When
   the build runs, Then the denylist check aborts it **before** NOTICE generation and before
   any tag is applied, naming the offending dependency path. No image artifact is produced.
4. Given a package that ships its own license text (e.g. `@mariozechner/jiti` 2.6.5, MIT ©
   Pooya Parsa), When the sweep runs, Then it is classified as covered and its license text is
   not duplicated into NOTICE — **except** that a covered package carrying an upstream NOTICE
   file (`openai`, `@google/genai`, `@mistralai/mistralai`, `@aws-sdk/*`,
   `@anthropic-ai/sandbox-runtime`) has that file concatenated verbatim per INV-3. An empty
   uncovered set is a PASS only when the generated NOTICE is non-empty; a zero-byte or absent
   NOTICE is a FAIL, never a vacuous pass.
5. Given the vendored substrate, When the provenance fix lands, Then
   `pi-vs-claude-code-vendor/coms.ts:14-15` attributes the file to `disler/pi-vs-claude-code`
   `extensions/` at commit `0ed11f44`, matching `pi-vs-claude-code-vendor/package.json`
   `_provenance`; a DIVERGENCE row records the edit; and `coms-net.ts` is byte-unchanged
   (asserted — it was already clean).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun run build:image` (local operator build) | in-scope | `tests/scripts/license-sweep.test.ts` + the AC-1 build smoke | — |
| CI image job in `.github/workflows/ci.yml` | in-scope — the sweep's nonzero exit fails the job | same suite, run in CI | — |
| `bun run notice:sweep` against an already-built tree (audit re-run, no rebuild) | in-scope | `tests/scripts/license-sweep.test.ts` | — |
| Registry push / image signing / provenance attestation | out-of-scope | — | v5 §8 step 7 (OCI driver), derived at that step |
| exe.dev VM provisioning from this image | out-of-scope — this story defines the image, not its runtime | — | DF2.2 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| OCI builder (docker buildx or podman) | host toolchain; CI runner image | build script preflight resolves `buildx version` (or podman equivalent) and exits 2 with a named remediation if absent |
| npm registry reachability (packument `license` fields + tarball extraction) | public npm | sweep preflight probes the registry and **fails closed** when unreachable (INV-4) |
| `@mariozechner/pi-coding-agent@0.55.0` published tarball | npm | resolved-version assertion at AC2 runs against the installed tree, not the lockfile |
| Canonical license texts, one per SPDX identifier the sweep can discover in the tree (MIT, Apache-2.0 and BSD/ISC/similar permissive templates), not only the two the tree happened to need on 2026-08-11 | checked in at `oci/license-texts/`, keyed by SPDX identifier | generator asserts a canonical text exists for **every** SPDX identifier the sweep observes and is present and non-empty before writing NOTICE; an observed identifier with no checked-in text fails the build (exit `2`, INV-4) rather than emitting a NOTICE that omits it |

## Technical Notes

- **NOTICE is computed, never transcribed.** The uncovered set is whatever the post-build
  sweep finds. Gates report §2 condition 1 names twelve of the fifteen observed — the four pi
  packages (`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`; MIT © 2025 Mario Zechner,
  monorepo root LICENSE at earendil-works/pi), five LICENSE-less MIT deps
  (`@tokenizer/token`, `data-uri-to-buffer`, `degenerator`, `eastasianwidth`, `netmask`), and
  three Apache-2.0 packages (`@aws-sdk/credential-provider-http`,
  `@aws-sdk/credential-provider-login`, `@aws-sdk/nested-clients`). The gap between twelve
  named and fifteen observed is precisely why the list is derived at build time.
- **Apache-2.0 §4(a) is the strictest obligation in the tree** — an affirmative duty to give
  every recipient a copy of the license. A copyright line alone does not discharge it (INV-3),
  and NOTICE-propagation binds the license-text-shipping Apache deps too (AC4's list).
- **`glob` / `minimatch` are BlueOak-1.0.0** — permissive and OSI-approved. The sweep flags
  them in a reviewer-facing section of NOTICE rather than treating an unfamiliar SPDX id as
  an error, so a proactive disclosure never reads as a discovery.
- **`--omit=optional` drops `@mariozechner/clipboard`** and its native binaries. No
  authoritative license text exists anywhere in its chain — fork and parent repo both
  unlicensed — and it is display-gated, so a headless VPC container never loads it.
- **Denylist, by name, unconditionally:** `@mariozechner/pi-proxy` (no license across all 132
  published versions) and `@mariozechner/pi` (wrong package — a vLLM pods CLI, not the coding
  agent). Neither can be remediated by attribution, so the check runs first (INV-2).
- **Version pin:** the image pins `pi-coding-agent` **0.55.0** — the version F6 proved end to
  end (gates report §1 versions of record) and the version `pi-vs-claude-code-vendor` peer-pins
  — while its pi-lib deps resolve within `0.55.x` (AC2). A bump does not change the license
  verdict (the field is stable across all published versions) but does change the tree, so it
  re-runs the sweep as a matter of course.
- **Vendored-file discipline (`pi-vs-claude-code-vendor/DIVERGENCE.md`, "Rules for
  maintainers"):** the header fix is a local edit to a vendored file, so it takes a DIVERGENCE
  row; upstream syncs must 3-way merge against `0ed11f44` and never overwrite. The vendored
  `LICENSE` (MIT © 2026 IndyDevDan) plus `_provenance` already **exceed** MIT's requirement —
  the header is audit hygiene, not a legal defect, which is why it is AC5 and not AC1.
- **Layout:** new executables in root `scripts/`, shared logic in `scripts/lib/`, tests at
  `tests/scripts/` (R3 §9.1). New top-level `oci/` holds build inputs only — the OCI *runtime*
  driver lands later at `src/providers/oci/` (R3 §9.2) — and must be added to the `lint`
  script's enumerated scope in root `package.json`: that scope is a list, not a glob.

## Observability Contract

- The sweep emits one structured JSON summary per run:
  `{ imageRef, treePackageCount, coveredCount, uncoveredCount, deniedHits[], piVersions, noticeBytes, sweptAt, exitCode }`,
  written next to the build log and echoed to stdout.
- Every package-level failure names the offending package and its dependency path — never an
  aggregate count alone; prerequisite failures (an empty tree, a missing builder, an
  unreachable registry, an absent license-texts directory) have no package path to name.
  `exitCode`: `0` clean (uncovered packages present and fully attributed in NOTICE is a clean
  run, not a failure); `1` a **policy failure** (a denied package, an off-pin version) or a
  **prerequisite/empty-tree failure** (an empty swept tree), or an **attribution failure**
  verified at NOTICE-write time (an uncovered package's entry absent from the generated
  NOTICE); `2` an **attribution failure** caught before the sweep could conclude (an observed
  SPDX identifier — from a covered or an uncovered package — has no canonical text) or a
  **prerequisite failure** (a package could not be read, no builder, registry unreachable,
  license-texts directory absent).
- The generated NOTICE header records the sweep timestamp, the resolved pi version, and the
  install flags used, so an auditor can tell which tree the file describes.

## Files to Modify

- `oci/Dockerfile`
- `oci/license-texts/` (canonical MIT and Apache-2.0 full texts)
- `scripts/generate-notice.ts`
- `scripts/lib/license-sweep.ts`
- `tests/scripts/license-sweep.test.ts`
- `package.json` (adds `build:image` / `notice:sweep`; extends `lint` scope with `oci`)
- `.github/workflows/ci.yml`
- `pi-vs-claude-code-vendor/coms.ts`
- `pi-vs-claude-code-vendor/DIVERGENCE.md`

## Security Invariants

- **INV-1 (redistribution boundary):** no package lacking attributable license text ships in
  the image. Enforcement is the post-build sweep of the real tree — a checked-in list is
  evidence of a past sweep, never a substitute for the current one.
- **INV-2 (denylist ordering):** the forbidden-name check runs **before** NOTICE generation
  and before any tag is applied. A denied package can never be laundered into compliance by
  being written into NOTICE, and no artifact exists for a build that tripped it.
- **INV-3 (Apache-2.0 §4(a)):** every Apache-2.0 package in the tree ships the complete
  license text plus any upstream NOTICE content, verbatim. A copyright line, an SPDX
  identifier, or a URL does not satisfy the duty.
- **INV-4 (fail-closed on unknown):** if the sweep cannot resolve a package's license —
  registry unreachable, metadata absent, SPDX id unrecognized, **or a recognized SPDX id with no
  canonical license text checked in** — the build FAILS with exit 2. Unresolved is never treated
  as permissive and never silently omitted from NOTICE.
- **INV-5 (no credential in a layer):** the image contains no API key, no `.npmrc` auth token,
  and no git credential. The box's single spend-capped LLM key arrives at runtime (v5 §6.2,
  D8); build-time secrets, if ever needed, use BuildKit mounts and never `ENV`/`ARG` values
  that persist into a layer. Asserted by scanning the built image's layer history and
  filesystem for credential-shaped files.

## Definition of Done

- [x] **Impl:** `scripts/lib/license-sweep.ts` classifies every package in a given tree as covered / uncovered / denied and returns the structured summary
- [x] **Impl:** `scripts/generate-notice.ts` writes `/usr/share/doc/qds-factory/NOTICE` from the uncovered set with license text, copyright line, and the BlueOak-1.0.0 reviewer note
- [x] **Impl:** `oci/Dockerfile` installs with `--omit=optional` and pins `@mariozechner/pi-coding-agent@0.55.0`; `scripts/build-image.ts` orchestrates the sweep → generate → tag sequence between the `deps` and `runtime` builds
- [x] **Contract:** sweep exit codes 0 / 1 / 2 as specified; failure output names the package and its dependency path
- [x] **Integration:** `build:image` and `notice:sweep` wired in root `package.json`, `oci` added to the `lint` scope, and the CI image job in `.github/workflows/ci.yml` fails on a nonzero sweep
- [x] **Security:** denylist runs before NOTICE generation and before tagging (INV-2); unresolvable license → exit 2 (INV-4); layer scan finds no credential-shaped file (INV-5)
- [x] **Impl (provenance):** `coms.ts:14-15` corrected to `disler/pi-vs-claude-code` `extensions/` @ `0ed11f44`; DIVERGENCE row added; `coms-net.ts` byte-unchanged
- [x] **Test (uncovered package):** a fixture tree with a license-text-less package absent from NOTICE → sweep exits 1 and names it; a static twelve-package list fails this case
- [x] **Test (unmapped SPDX identifier, INV-4):** a fixture package reporting a recognized but
      unmapped SPDX identifier (e.g. BSD-3-Clause) with no matching entry in `oci/license-texts/`
      → sweep exits 2 before NOTICE generation, naming the missing identifier; an implementation
      that emits a NOTICE omitting that package's text MUST fail this test
- [x] **Test (denied package):** `@mariozechner/pi-proxy` injected as a transitive dep → build aborts pre-tag, exit 1, path named; same for `@mariozechner/pi`
- [x] **Test (pin + NOTICE propagation):** an off-pin `pi-coding-agent` fails the build and names the observed version, while `pi-ai@0.55.4` under a 0.55.0 coding-agent passes (AC2); a covered Apache-2.0 package carrying an upstream NOTICE has that file's bytes present in the generated NOTICE (AC4/INV-3)
- [x] **Test (e2e demo — MANDATORY):** a real `bun run build:image` produces a tagged image whose `/usr/share/doc/qds-factory/NOTICE` is non-empty, contains the full Apache-2.0 text for the three `@aws-sdk` packages and MIT © 2025 Mario Zechner for the four pi packages, and whose tree contains no `@mariozechner/clipboard` — sweep summary JSON committed as evidence

## Dev Agent Record

**Status:** done — PR [#105](https://github.com/biospark33/QDS-Factory/pull/105) squash-merged to
`main` 2026-08-14 (`43ca5e7`). Branch `feature/df2-9-oci-image-contract` (deleted on merge);
implemented 2026-08-13.

**Post-PR review — eight rounds.** CodeRabbit's merge-readiness verdict: *"Yes. Excluding CI/CD
status, I see no remaining non-CI blocker in PR #105. The Round 8 change completes the AC1 failure
taxonomy."*

Code fixes (rounds 1–3):

- **`c18cfca`** — `oci/Dockerfile` `CMD ["node","--version"]` exited immediately with nothing
  running; now runs the vendored extension's documented entrypoint (the reviewer's suggested
  `index.js` does not exist in this repo). `license-sweep.ts` `expressionAtoms()` stripped
  parentheses before splitting on AND/OR, so `MIT AND (Apache-2.0 OR BSD-2-Clause)` evaluated
  wrong — replaced with a recursive-descent parser honouring SPDX precedence. Duplicate `fail`/`die`
  extracted to `exitWithFailure` in the already-shared `cli-args.ts`.
- **`92a17b8`** — `exitWithFailure` switched from `process.stderr.write` to `fs.writeSync(2, ...)`
  before `process.exit`: when stderr is a pipe the write is async and `exit` truncates it, so the
  operator's error message could vanish.
- **`cb81756`** — same flush race fixed at its real site, `emit()` in `generate-notice.ts` (the
  finding named `cli-args.ts`; the unguarded write was elsewhere). Added `persist-credentials:
  false` to both `actions/checkout` steps — zizmor `artipacked`: checkout persists git credentials
  into the workspace by default and neither job needs git auth afterwards.

> **`actions/checkout` version — a correction worth recording.** Round 1 changed `@v7` → `@v4` on
> the premise that v7 did not exist. **That premise was false.** `gh api repos/actions/checkout/releases`
> shows `v7.0.0` published 2026-06-18 and `v7.0.1` on 2026-07-20 — v7 is the current major and
> predates this branch by ~2 months. The original change was a downgrade of a correct choice, and
> two later rounds rejected version suggestions on the same bad premise. Round 5 (`4d57a4b`)
> restored `@v7` on both steps, keeping `persist-credentials: false`. CodeRabbit independently
> withdrew its own finding and recorded a repo learning. Sift subsequently re-raised "v7 does not
> exist" twice more with BUG severity; both were rejected against the release API. **Check the
> release list before acting on a "version does not exist" claim.**

Documentation rounds (4–8) — five passes on this file's failure taxonomy:

- `dfc6ee4` fixed the User Story's "fails on any uncovered or forbidden package"; `8d85c0b`
  corrected the attribution class to cover SPDX ids observed from **both** covered and uncovered
  packages (`license-sweep.ts:546-551` builds `missingTexts` from `[...covered, ...uncovered]`);
  `5d1ea6d` rescoped AC1's "only when" to the attribution subclass; `fa328f7` added "an unreadable
  package" to AC1's prerequisite list.
- **The verified taxonomy** (from `generate-notice.ts` exit paths): *attribution* — an observed SPDX
  id has no canonical text → exit 2 before NOTICE generation, or an uncovered package's entry is
  absent from the written NOTICE → exit 1; *policy* — denied package name or off-pin
  `pi-coding-agent` → exit 1; *prerequisite* — empty swept tree → exit 1; unreadable package,
  missing builder, unreachable registry, absent license-texts dir → exit 2.

> **Why five rounds:** each pass corrected the sentence the reviewer named and left a sibling
> saying something narrower. Round 8 finally enumerated every failure-list occurrence in the file
> as a table. That sweep also showed where a blanket edit would have been *wrong*: the
> Observability Contract's list at lines 160-162 is deliberately scoped to failures with **no
> package path**, so "unreadable" (which has one) is correctly excluded there. Anyone editing this
> taxonomy again should produce the occurrence table first.

> **CI note:** the `check` workflow shows FAILURE, but the job never started — GitHub Actions
> billing ("recent account payments have failed or your spending limit needs to be increased").
> Wave-wide, not a code signal. Local gates at merge: 70 pass / 0 fail focal, `tsc --noEmit` clean,
> biome clean.

> **Non-blocking, deliberately not actioned:** the `die`/`fail` wrapper comments — both are
> one-line delegates to `exitWithFailure`, which CodeRabbit confirmed is not a blocker.

### What shipped

| File | Role |
|------|------|
| `scripts/lib/license-sweep.ts` | walks a tree, classifies covered / uncovered / denied / unresolved, resolves canonical texts, renders NOTICE, verifies coverage |
| `scripts/generate-notice.ts` | CLI — the generator AND the gate; owns exit codes 0/1/2 |
| `scripts/build-image.ts` | orchestrates deps-build → extract → sweep → runtime-build → credential scan → tag |
| `oci/Dockerfile` | two stages; `--omit=optional`, pinned coding agent, NOTICE copied into `/usr/share/doc/qds-factory/NOTICE` |
| `oci/license-texts/*.txt` | 7 canonical texts: MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0 |
| `tests/scripts/license-sweep.test.ts` | 46 tests over on-disk fixture trees + the CLI's exit contract |
| `.github/workflows/ci.yml` | `image` job, `needs: check`, uploads the sweep summary |
| `pi-vs-claude-code-vendor/{coms.ts,DIVERGENCE.md}` | AC5 provenance fix + ledger row |

### Live evidence (2026-08-13, this host)

- `bun run build:image --tag qds-factory:df2.9-test` → **exit 0**, tagged
  `sha256:178f7851…`. Summary committed at
  `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-9-sweep-summary.json`:
  175 packages, 165 covered, **10 uncovered**, NOTICE 44,563 bytes, no denied hits.
- In-image assertions: `/usr/share/doc/qds-factory/NOTICE` is 44,563 bytes and
  carries **three** complete Apache-2.0 texts (one per `@aws-sdk` package —
  `END OF TERMS AND CONDITIONS` × 3) and **four** `Copyright (c) 2025 Mario
  Zechner` lines (the pi packages). `/app/node_modules/@mariozechner/` holds
  jiti, pi-agent-core, pi-ai, pi-coding-agent, pi-tui — **zero** clipboard
  entries, so `--omit=optional` is asserted by inspecting the tree, not the flag.
- AC3 against a real 175-package tree: `@mariozechner/pi-proxy` injected under
  `pi-coding-agent/node_modules/` → **exit 1**, message names
  `"@mariozechner/pi-coding-agent > @mariozechner/pi-proxy"`, and **no NOTICE
  file was written** (checked). Nothing was tagged.
- `bun test` exit 0 · `bunx tsc --noEmit` clean · biome clean over the extended
  scope (now including `oci`).

**The observed tree holds 10 uncovered packages, not the 12 named in gates
report §2 nor the 15 observed on 2026-08-11** — `eastasianwidth` and `netmask`
are not in the 0.55.0 `--omit=optional` tree at all. That drift is the story's
whole thesis and the reason the list is derived at build time; a transcribed
list would have shipped two phantom entries and, on the next bump, missed real
ones.

### Decisions (--yolo; recorded rather than gated)

1. **The sweep runs on the host, between the two image stages** — not inside a
   `RUN` layer. The Dockerfile's `deps` stage produces the tree; `build-image.ts`
   extracts it (`docker create` + `docker cp`), sweeps it, and only then builds
   `runtime`, which copies the NOTICE in. This keeps the required
   sweep → generate → tag ordering (INV-2: nothing is tagged until every check
   passes) without installing bun into the shipped image. `scripts/build-image.ts`
   is therefore a file this story adds beyond the spec's "Files to Modify" list.
2. **No npm-registry preflight probe.** The Infra Prerequisites table asks for
   one, but this sweep reads licenses from the *installed tree*, which is the
   artifact being shipped — it never contacts the registry. `npm install` in the
   `deps` stage already fails closed when the registry is unreachable, and the
   build cannot reach the sweep without it. A probe here would gate nothing;
   asserting otherwise would be theater. INV-4's fail-closed duty is discharged
   against the tree instead.
3. **"Uncovered" is one compliance state, not two — `verifyNoticeCoverage` is a
   safety net over it, not a second state.** A package that ships no license
   text of its own is *uncovered*; that alone passes, because the sweep
   resolves canonical text and writes it into NOTICE. `verifyNoticeCoverage`
   then re-reads the generated NOTICE and fails the build (exit 1) if an
   uncovered package's entry is missing from it — catching a NOTICE-generation
   bug, not classifying a second kind of package. AC1 and the Observability
   Contract now spell out this distinction explicitly (round-3 review); a
   transcribed twelve-entry list still trips the same check, because it omits
   packages the real tree carries and `verifyNoticeCoverage` names them absent.
4. **Canonical texts are required for every identifier the sweep observes,
   including covered packages'.** Strictly more than AC1 demands, and the literal
   reading of "every SPDX identifier the sweep observes". It means a future
   dependency arriving with an exotic-but-textless license fails the build
   instead of slipping past on its own bundled file.
5. **`license` absent + license text present ⇒ covered, not fatal.**
   `@mistralai/mistralai@1.10.0` really is this shape in the 0.55.0 tree: no
   `license` field, a full Apache-2.0 `LICENSE` file. Its redistribution duty is
   discharged by the shipped text, so exit 2 there would fail the build over a
   metadata gap with no legal content. Absent field **and** absent text is still
   exit 2 (INV-4). The package is disclosed by name in the NOTICE's reviewer
   section, so the gap is visible rather than swallowed.
6. **Copyright years are never invented.** npm metadata carries no year, so the
   default line is `Copyright (c) <author>`. The four pi packages get
   `Copyright (c) 2025 Mario Zechner` from a small checked-in override table,
   sourced from the pi monorepo root LICENSE (earendil-works/pi) that the
   per-package tarballs omit — an authoritative source, not a guess.
7. **BlueOak-1.0.0 is disclosed, not flagged.** `glob`/`minimatch` land in a
   reviewer-facing section of NOTICE listing less-common-but-permissive
   identifiers, so a proactive disclosure never reads as a discovery. Its
   canonical text is checked in, so it also satisfies decision 4.
8. **Denylist ordering is enforced by construction and by test.** The CLI checks
   `result.denied` before pins, before the INV-4 checks, and before rendering; a
   dedicated test asserts a denied package beats an unresolvable license (exit 1,
   not 2) and that no NOTICE file exists afterwards.
9. **`.dockerignore` added** (not in the spec's file list) so the build context
   excludes `.git`, `_bmad-output`, `docs` and the test tree. Without it the
   context upload dominates the build.
10. **`oci/.build/` is gitignored**; the generated NOTICE and summary are build
    outputs. The evidence copy of the summary is committed under
    `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/`.

### Three review rounds (all findings fixed, then re-verified live)

Round 1 — the sweep counted a source file named `license.js` as license text
(a package could ship with no attribution at all); NOTICE coverage was verified
by substring, so `glob@1.2.3` could be discharged by an unrelated
`fast-glob@1.2.3` line; `X WITH Y` was split like a disjunction and resolved to
X's text alone. On the image: the credential scan exempted all of
`node_modules` (where npm reads `.npmrc`), anchored on an `ENV`/`ARG` keyword
that BuildKit's build-arg layers do not carry, and piped `docker export` into
`tar` without `pipefail`; CI selected a `docker-container` buildx driver whose
output never reaches the daemon store, which would have broken `docker create`
and `docker tag` on the first CI run; and a failed build left the previous tag
resolving, so a push after a denylist trip would have shipped the older image.

Round 2 — deduping kept one copy's whole record, so an upstream NOTICE on the
complete copy vanished when a partial copy won the tiebreak, and a package
could be called unresolved while a sibling copy named its license. The verdict
still comes from the worst copy; the evidence is now unioned across copies. An
unreadable manifest silently deleted a package *and its whole subtree* from the
sweep while still reporting clean. Name-based credential matching failed on a
stock `node:22` image, which ships npm's own
`/usr/local/lib/node_modules/npm/.npmrc` (holding `prefix=/usr/local`) — config
files are now read and judged by content, which is also what lets the scan
catch a real `.env` or `_authToken`.

Round 3 — **the swept tree was not bound to the shipped tree.** The `deps` and
`runtime` stages were two independent `docker build` invocations, and the
runtime build only reused the swept layer because BuildKit's cache key is the
`RUN` string. There is no lockfile and the pi libs float inside `0.55.x`, so any
cache miss (builder GC, `docker builder prune`, a fresh CI runner) would have
installed a different tree and shipped it with a NOTICE describing the old one —
exit 0, INV-1 void. The Dockerfile now takes `ARG DEPS_IMAGE` and the runtime
stage copies `--from=swept`; `build-image.ts` pins it to the exact image it
swept. Via a throwaway local tag rather than the bare image ID: BuildKit
resolves a `FROM` argument as a repository name, so `FROM sha256:…` goes to the
registry — proven by a build that failed with `pull access denied` before the
fix landed. Round 3 also closed the last fail-open path in the walk (a
manifest-less directory or dangling symlink vanished without being reported)
and widened the INV-5 patterns to `.env.local`/`.env.production`, `*.key`,
`*.jks`, `.docker/config.json` and AWS's spaced `aws_secret_access_key = …`.

### Gaps / follow-ups

- **Registry push, image signing, provenance attestation** — out of scope by the
  story (v5 §8 step 7).
- **The vendored `pi-vs-claude-code-vendor/` tree is copied into the image but is
  not part of the swept `node_modules`.** It ships its own `LICENSE` (MIT ©
  2026 IndyDevDan) plus `_provenance`, so INV-1 holds by inspection rather than
  by the sweep. DF4.1, which consumes this sweep, adds files to that directory:
  if it ever adds a third-party file with separate licensing, the sweep will not
  see it. Widening the sweep to a set of extra directories is the natural
  follow-up at that point.
- **`coms-net.ts` is byte-unchanged** — verifiable from the PR diff, which does
  not list the file. No hash fixture was added; a pinned digest would be churn
  the next legitimate edit has to update.
- **The step ORDER in `build-image.ts` is enforced by structure, not by a
  test.** Moving `docker tag` above the sweep would regress INV-2/AC3 green.
  Testing it needs the orchestration refactored around an injectable `run`;
  the cheap half is done (the sweep's exit code is relayed verbatim and is
  covered, and the CLI's own ordering — denylist before generation — is).
- `bun run notice:sweep` against an arbitrary tree does not assert that a
  `pi-coding-agent` is present; that is AC2's positive half and lives in
  `build-image.ts`, because the audit re-run is deliberately usable against
  trees that are not the image.
- The CI `image` job runs a cold `npm install` plus two image stages (~2–4 min
  on a warm runner). It is `needs: check`, so it never burns runner time on a
  branch that fails lint/typecheck/tests.
