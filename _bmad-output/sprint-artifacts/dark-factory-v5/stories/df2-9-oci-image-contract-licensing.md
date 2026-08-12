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
I want the image build to generate its NOTICE from a sweep of the actual post-build tree and to fail on any uncovered or forbidden package,
so that redistribution compliance is enforced by the build rather than by a hand-maintained list that goes stale the first time a dependency moves.

## Overview

The enterprise tier ships `@mariozechner/*` (pi) and the vendored coms files inside an OCI
image into client VPCs (v5 §8 step 2). F13 cleared that redistribution — no copyleft, no
unlicensed core — subject to three conditions. This story encodes them as a build: a
`scripts/lib/license-sweep.ts` module walks the **built image's** dependency tree, classifies
every package by whether it ships license text, and `scripts/generate-notice.ts` writes a
NOTICE covering the uncovered set into the image. The sweep is also the gate — it exits
nonzero, failing the build, on any package it cannot cover and on any denied package name.
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
   partial or silently-omitted NOTICE entry. The sweep exits nonzero, failing the build, if any
   package in the tree is uncovered.
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
- Every failure names the offending package and its dependency path — never an aggregate count
  alone. `exitCode`: `0` clean, `1` compliance failure (uncovered or denied), `2` fatal before
  the sweep ran (no builder, registry unreachable, missing license text file).
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

- [ ] **Impl:** `scripts/lib/license-sweep.ts` classifies every package in a given tree as covered / uncovered / denied and returns the structured summary
- [ ] **Impl:** `scripts/generate-notice.ts` writes `/usr/share/doc/qds-factory/NOTICE` from the uncovered set with license text, copyright line, and the BlueOak-1.0.0 reviewer note
- [ ] **Impl:** `oci/Dockerfile` installs with `--omit=optional`, pins `@mariozechner/pi-coding-agent@0.55.0`, and runs sweep → generate → tag in that order
- [ ] **Contract:** sweep exit codes 0 / 1 / 2 as specified; failure output names the package and its dependency path
- [ ] **Integration:** `build:image` and `notice:sweep` wired in root `package.json`, `oci` added to the `lint` scope, and the CI image job in `.github/workflows/ci.yml` fails on a nonzero sweep
- [ ] **Security:** denylist runs before NOTICE generation and before tagging (INV-2); unresolvable license → exit 2 (INV-4); layer scan finds no credential-shaped file (INV-5)
- [ ] **Impl (provenance):** `coms.ts:14-15` corrected to `disler/pi-vs-claude-code` `extensions/` @ `0ed11f44`; DIVERGENCE row added; `coms-net.ts` byte-unchanged
- [ ] **Test (uncovered package):** a fixture tree with a license-text-less package absent from NOTICE → sweep exits 1 and names it; a static twelve-package list fails this case
- [ ] **Test (unmapped SPDX identifier, INV-4):** a fixture package reporting a recognized but
      unmapped SPDX identifier (e.g. BSD-3-Clause) with no matching entry in `oci/license-texts/`
      → sweep exits 2 before NOTICE generation, naming the missing identifier; an implementation
      that emits a NOTICE omitting that package's text MUST fail this test
- [ ] **Test (denied package):** `@mariozechner/pi-proxy` injected as a transitive dep → build aborts pre-tag, exit 1, path named; same for `@mariozechner/pi`
- [ ] **Test (pin + NOTICE propagation):** an off-pin `pi-coding-agent` fails the build and names the observed version, while `pi-ai@0.55.4` under a 0.55.0 coding-agent passes (AC2); a covered Apache-2.0 package carrying an upstream NOTICE has that file's bytes present in the generated NOTICE (AC4/INV-3)
- [ ] **Test (e2e demo — MANDATORY):** a real `bun run build:image` produces a tagged image whose `/usr/share/doc/qds-factory/NOTICE` is non-empty, contains the full Apache-2.0 text for the three `@aws-sdk` packages and MIT © 2025 Mario Zechner for the four pi packages, and whose tree contains no `@mariozechner/clipboard` — sweep summary JSON committed as evidence

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
