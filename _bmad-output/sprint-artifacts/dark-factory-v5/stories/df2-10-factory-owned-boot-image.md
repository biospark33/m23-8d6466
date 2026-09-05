# DF2.10: Factory-Owned Boot Image — a Digest-Pinned exe.dev Substrate We Own

**Story Points:** 5
**Sprint:** v5-S3 (in-box restoration arc, story 1 of 5; strict predecessor of DF1.10)

## Spec Reference

- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED 2026-08-31) — Consequences item 1 (fork exeuntu, publish, pin by digest, thread `--image`/`--registry-auth` through `create()`; "retires the pi 0.55.0/0.84.x drift") and item 3's **image half** (systemd unit + `Restart=` policy); re-opening criteria `:121-125` name "registry limits, boot regressions" as falsifiers this story must measure
- Probe evidence (READ-ONLY): `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json` — all three flags available on our plan (`:11`); bun absent, installs without root, survives reboot (`:14,:36,:44`); pi is a compiled ELF 0.84.4 (`:16`); systemd is PID 1 and enabled units re-run at boot (`:20-26,:45`); a reboot wipes `/run/steering` (`:41`)
- Driver contract: `src/providers/exedev/driver.ts:249-255` (the `create()` argv literal that passes none of them), `:239-248` (INV-2 trust-boundary validation, the `tag-invalid` precedent — ssh concatenates argv into a remote command line), `:163-175` (`ExeDevDriverOptions`: "Every field is injectable; none is env-magic"), `src/providers/index.ts:131` (the driver is registered with **zero** options, so a default living only in that interface is never set in production)
- Reused as a gate, not as a base layer (DF2.9, done, PR #105): `scripts/lib/license-sweep.ts`, `scripts/generate-notice.ts` exit codes 0/1/2, `oci/license-texts/*.txt`, the content-judging credential scanner in `scripts/build-image.ts`, and **INV-5** (`df2-9-oci-image-contract-licensing.md:201-205`)
- Different tier, deliberately not extended: `oci/Dockerfile` is D7's enterprise client-VPC image (`node:22-bookworm-slim`, no systemd, `USER node`, npm pi 0.55.0 — `:49-50,:81,:88`); D7/D8 at `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md:304-305`. The drift retired here is `src/providers/exedev/setup-gate.ts:422` ("the image contract requires pi 0.55.0") against a measured 0.84.4 box, and the F14 scar at `src/providers/exedev/assertions-in-box.sh:176-187`, where gate D was **weakened** to tolerate an absent `~/.pi/agent/models.json` — read the comment: pi 0.84.x *never writes* that file, so absence is a property of the shipped pi, not of unowned drift

## User Story

As the factory operator,
I want every sandbox to boot an image we built, pinned, and can prove from inside the box,
so that the runtime under a run is a reviewed artifact in git rather than whatever the vendor shipped this week.

## Overview

A new `oci/exedev/Dockerfile`, derived `FROM` exeuntu, adds a pinned bun, a pinned pi, the systemd assets the in-box engine needs, and a baked
`/etc/qds-image.json` identity marker; `scripts/build-exedev-image.ts` builds it, gates it on DF2.9's license sweep and credential scan, and
publishes to ghcr.io. `create()` gains two argv spreads — `--image` (unconditional: the constructor always assigns a pin, decision 3 in the round-1 findings) and `--registry-auth` (conditional, default-off) — each validated in the constructor at
the trust boundary that already refuses a bad `tag`, with a module-level default keeping the reference reviewable in the diff. Gate B then
asserts the box's baked `buildId` against the repo pin, fail-closed: a box that cannot state what it booted is not a factory box. Nothing here runs a phase — this story ships the substrate DF1.10 runs on.

## E2E Slice

**Demonstrable behavior:** Given a published image at `ghcr.io/<org>/qds-exedev@sha256:<digest>`, When a throwaway box is created with
`ssh exe.dev new --name <run-id> --image <ref>@sha256:<digest> --json`, Then it boots (PID 1 = systemd, `systemctl is-system-running` =
`running`), answers ssh as `exedev`, passes every `setupGate` gate, and reports `bun --version` = the pinned `BUN_VERSION`, `pi --version`
= the pinned `PI_VERSION`, and `/etc/qds-image.json` carrying `{ imageRef, buildId, piVersion, bunVersion, builtAt, gitSha }` whose `buildId`
is the one the repo pin pairs with the pinned digest. Observable artifacts: an evidence JSON recording built size and cold-boot time (the
ADR's two named re-opening falsifiers), plus `/run/steering` present after `sudo reboot` from the baked `tmpfiles.d` entry alone.

**Wiring closed:** On completion of this story a factory box boots a factory image on the production path — `registerDriver("exedev", …)` →
`create()` → `--image <pinned digest>` — using only code merged by this story plus DF2.2's driver, setup gate and in-box assertions, and
DF2.9's sweep, license texts and credential scanner run as a gate over the new tree. **No stub, no `TODO: wire later`.** The **engine** that
runs on this substrate is **DF1.10's** (single owner): it adds the engine build stage here and owns engine packaging entirely; this story
ships bun, pi, the unit template and the channel entry, and claims nothing about a phase walk.

**Dependency edges (predecessors):** DF2.2, DF2.9.

> **Not an edge — DF2.3 (credential class):** the registry pull credential is not a per-run OpenRouter mint. It is never minted, capped,
> delivered to a box, or revoked on DF2.3's lifecycle; it is a host operator credential held to DF2.1's `assertNoSecret` and DF2.2's 0600
> env-file standard (INV-IBOX-3). No edge, and no DF2.3 code is touched.

## Acceptance Criteria

1. **(make-or-break — the boot contract survives the fork, and the pin is proven from inside)** Given the published image, When a box is
   created at the pinned reference, Then it boots to `multi-user.target`, answers ssh as the `exe.dev/login-user`, passes every `setupGate`
   gate, and its baked `/etc/qds-image.json` `buildId` **equals** the one the repo pin pairs with the digest that was pulled.
   <br />**(a)** the pin is a digest reference if `--image` accepts one — **unverified today**: the flag is documented only as "container
   image", its sole vendor example is `ubuntu:22.04`, and the probe measured its *existence*, never a custom boot. **(b)** if a digest is
   rejected, the pin is an **immutable tag** the workflow refuses to re-push, digest recorded in-repo and `buildId` verified in-box after boot — weaker but honest; the Dev Agent Record states **which one shipped**.
   <br />**(c)** the assertion extends **gate B** (already the image-contract gate) and adds no `AssertionItem` letter — the A–E union
   (`setup-gate.ts:58`) and the `1|2|3|4` code table `dispatch.ts` keys on are DF3.1-owned. Fail-closed: absent, over a 4 KiB read cap,
   unparseable or mismatched refuses the box with `{ code, message, remediation }` **in the payload** (DF3.1 AC3: an error code is payload,
   never a process exit code). *Negative control: a test asserting only that `docker build` and `docker push` exited 0 proves the image
   exists and nothing about whether exe.dev can boot it, and MUST fail this one.*
2. Runtimes are pinned by build arg and the drift behind them is closed: `ARG BUN_VERSION` = the repo's own pin (`packageManager`
   `bun@1.3.13`; `ci.yml:55,146`), so the in-box engine runs the runtime the tests ran on — the probe's 1.4.0 was an install measurement, not
   a pin — and `ARG PI_VERSION` feeding exeuntu's supported `exeuntu update pi --version`; `setup-gate.ts:422`'s "requires pi 0.55.0" is
   corrected to the owned version. F14's arm at `assertions-in-box.sh:176-187` is **re-aimed, not re-tightened**: its comment records that pi
   0.84.x *never writes* `~/.pi/agent/models.json`, so asserting presence would fail every factory box on day one. Owning the version makes
   the arm **version-conditional** — the observed shape must match the shape the **pinned** pi produces, and a `PI_VERSION` bump landing
   without revisiting it is itself the refusal. *Negative control: an image installing bun and pi unpinned passes a naive "bun exists" test, drifts on the next rebuild, and MUST fail this one.*
3. `create()` threads the flags in the existing argv literal — `--image` unconditionally (the constructor always assigns a pin; a conditional spread's only extra capability would be booting a markerless substrate default that gate B0 refuses anyway — round-1 decision 3), `--registry-auth` conditionally — and validates each **in the constructor**: an image
   grammar assertion (registry host / path / tag or digest, no shell metacharacters) and a `USERNAME:PASSWORD` shape assertion, each refusing
   with a typed `ExeDevDriverError` in the `tag-invalid` **shape** — but not its message, which echoes the offending value (`driver.ts:243`);
   the registry-auth error names the field and the failed rule, never the value. The default reference is a **module-level constant** in
   `driver.ts` (the `STEERING_PROVISION_SCRIPT` precedent at `:87`, spent as a constructor default the way `DEFAULT_EXEC_TIMEOUT_MS` is at
   `:199` — *not* `hostSuffix`, whose default is an inline literal at `:201`) because the
   registry constructs the driver with no options; any override is read at the registry factory under `QDS_*`. *Negative control: an
   implementation reading `process.env` inside `create()` passes every unit test that constructs the driver directly and MUST fail this one.*
4. The image is **public** by default and the `--registry-auth` path ships validated, redacted and **default-off**: with a public image no
   credential reaches the ssh argv at all. Given the operator instead selects a private image, Then the value is read from a 0600 host file,
   is redacted in every `emit()` line, never appears in the `create_shape` provenance record, and the path is refused unless the ratified
   deviation INV-IBOX-3 requires is recorded where this driver already reads operator attestations (`postureFile`, `driver.ts:198`), naming
   the PAT's `read:packages` scope, expiry and rotation owner. *Negative control: an implementation that redacts the auth in logs and calls
   the D8 argv conflict closed passes a grep-the-logs test — a process table is not a log — and MUST fail this one.*
5. The license obligation is discharged for a **binary** image rather than by importing machinery with nothing to walk: the sweep runs over
   the built image's **exported filesystem**, so swept is shipped by construction (DF2.9's round-3 lesson for a build with no deps stage —
   no `ARG DEPS_IMAGE`, no npm tree; the swept package count is recorded as evidence, and a non-zero count on this tree is itself the
   finding — an npm tree crept in unnoticed). The substance is
   `binary-licenses.json`, its coverage set **computed** by diffing the built image's binaries against the base, never hand-listed.
   *Negative control: a test asserting the table covers a list the table itself supplies is tautological, passes on an image carrying an
   unattributed binary, and MUST fail this one.*

   **AMENDMENT (2026-09-05, [#223](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/223)) — AC5 as narrowed by DF1.10 deviation C37.**
   The "no npm tree" clause above shipped as an absolute and no longer is: the live image carries
   **one** npm tree, at `opt/qds-factory/node_modules`, admitted **by exact path**. Reason:
   DF1.10's AC2a unbundled-source route runs the engine as `.ts` in-box, and its closure's only
   bare specifiers — `yaml` and `zod` — must resolve. The narrowing is tight and gated: exactly
   the two packages copied by name (`cp -a node_modules/yaml node_modules/zod …`), installed
   `--frozen-lockfile`, and an in-Dockerfile probe that fails the build if a third ever appears.
   The measured cost behind the choice: a full install is a 264-package / ~243 MB tree — the
   two-package copy is what keeps the image a binary image in substance. The clause therefore
   now reads: **no npm tree except the engine closure's two packages at
   `opt/qds-factory/node_modules`, enforced by exact path and a count probe** — any other tree,
   anywhere, remains the finding the sweep was built to catch. (Round 3 of DF1.10's review added
   the residual to the re-pin bundle: the network-fetched tarball bytes for those two packages
   are not checksum-gated — #217, item R3-a.)
6. The supervision assets ship **in the image** and nothing enables them per-run: a **system** `qds-run@.service` template with
   **`Restart=no`**, `User=exedev`, `After=systemd-tmpfiles-setup.service` and the **literal** `EnvironmentFile=/home/exedev/app/.env` —
   `%h` is refused because in a system unit it is the manager's home, `/root`, not `User=`'s — plus `/etc/tmpfiles.d/qds-steering.conf`
   carrying exactly `d /run/steering 0700 exedev exedev` (the ADR's literal form; DF1.11's re-provision converges on these bytes). Neither
   image nor unit sets `QDS_RUN_ROOT`, `QDS_STEERING_ROOT` or any `QDS_*` path variable: DF1.11's INV-IBOX-13 and DF3.7's AC4 both rest on
   that, and only this story can guarantee it. Given a real `sudo reboot`, Then `/run/steering` returns at 0700 owner `exedev` **with no code
   path having run**. Starting an instance, and what a restarted engine does with a half-finished run, are **DF1.10's reclaim scope**.
   *Negative control: `Restart=on-failure` here passes a naive "the engine comes back" test, re-walks phases whose commits and spend already
   happened, and MUST fail this one.*
7. Three unmeasured premises become recorded measurements, not assumptions: **(a)** whether exeuntu is published as a pullable image — if not
   the build clones `boldsoftware/exeuntu` at a pinned commit, dragging in that Dockerfile's own unpinned network fetches and making our
   digest a pin over a non-reproducible build; record which shape shipped and its cost. **(b)** whether boot succeeds with the
   `exe.dev/install-shelley` label removed (we never solicit Shelley) — the label is **kept** unless a recorded probe shows a box boots and
   answers ssh without it; "unknown" is not a reason to drop it. **(c)** built image size and cold-boot time vs stock exeuntu, in the
   evidence JSON — the ADR's two named re-opening falsifiers, unrecorded meaning unfalsifiable.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `create()` passing `--image` at the pinned reference | in-scope | `tests/providers/exedev/image-contract.test.ts` | — |
| `create()` passing `--registry-auth` (validated, default-off) | in-scope | same | — |
| Setup gate asserting `/etc/qds-image.json`; publish workflow recording the pushed digest | in-scope | same | — |
| Baked `tmpfiles.d` recreating `/run/steering` at boot | in-scope (asset + reboot proof) | live e2e demo | DF1.11 consumes the channel |
| Starting `qds-run@<runId>.service`; reclaim after a restart | out-of-scope — **DF1.10 owns supervision's runtime half**; this story ships the unit file and its `Restart=` policy and starts nothing | — | DF1.10 |
| The engine binary, its build stage in this Dockerfile, and the pi catalog directory staged beside it | out-of-scope — **DF1.10 owns engine packaging, delivery and the catalog surface** (single owner) | — | DF1.10 |
| Converging `oci/Dockerfile`'s npm pi 0.55.0 onto this pin | out-of-scope — different tier (D7); 0.55.0 is what F6 proved end-to-end and what `pi-vs-claude-code-vendor` peer-pins | — | none in v5.0 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| exe.dev plan flags | provider — `--image`, `--registry-auth`, `--setup-script` | MEASURED present on this account (probe `:11`); a plan that rejects `--image` blocks the story and fires the ADR's re-opening criteria |
| exeuntu base | vendor image / open Dockerfile (`boldsoftware/exeuntu`) | AC7a resolves pullable-vs-clone **before** the Dockerfile is written; `FROM exeuntu` satisfies the boot contract for free, and re-deriving from `ubuntu:24.04` is refused as a silent-failure surface |
| ghcr.io publish | GitHub Actions + `ghcr.io` package | the workflow fails if the pushed digest ≠ the repo pin; bad ghcr credentials return **403, not 401**, so the failure message must say so or the first pull failure reads as a missing repo |
| DF2.9 license gate | in-repo `scripts/lib/license-sweep.ts` + `scripts/generate-notice.ts` | `bun test tests/oci/` green before this story starts; a non-zero sweep over the new tree **fails the build**, never warns |
| DF2.2 setup gate | in-repo `src/providers/exedev/setup-gate.ts` | gate B judges pi on **content, never `$?`** — the factory image keeps pi at `/usr/local/bin/pi` where exeuntu places it, or gate B breaks silently |

## Technical Notes

- **Derive, do not re-derive.** exe.dev's boot contract is (a) an entrypoint literally named `init` so exetini `exec`s rather than forks it,
  (b) systemd reaching `multi-user.target`, (c) a login user matching the `exe.dev/login-user` label, (d) sshd present with
  `ssh.service`/`ssh.socket` masked and no baked host keys, (e) an **empty-not-absent** `/etc/machine-id` — removing it makes systemd treat the boot as
  first-boot and re-enable every disabled unit — and (f) the `x-systemd.growfs` fstab line. All six come free from `FROM exeuntu` and each is a silent boot failure if re-derived from `ubuntu:24.04` wrong.
- **The baked marker is the load-bearing design decision, and it cannot carry its own digest.** A box **cannot read the digest it was pulled from**, so without
  `/etc/qds-image.json` no in-box assertion about image identity can exist at all — and it cannot hold that digest either, the digest being the hash of the
  manifest containing the marker, so baking it changes it. It carries a build-generated `buildId`; the publish workflow records the `digest ↔ buildId` pair as
  the repo pin. Host enforces the digest at pull, box proves the `buildId`, and neither drifts from the other without the gate saying so.
- **Region ownership.** The three `src/providers/exedev/` files are **DF2.2-authored** and this story's edits are enumerated in Files to Modify;
  `oci/exedev/Dockerfile` is authored here and **DF1.10 adds only the engine build stage** — which is also where the **pi catalog directory** `QDS_PI_CATALOG_DIR` names is staged, since this story installs pi as a compiled ELF and stages no catalog: that surface is DF1.10-owned inside this image. A change outside your own region belongs in the owning story.
- **`provisionSteeringChannel` becomes redundant-but-idempotent** (`driver.ts:308-316`): the baked `tmpfiles.d` entry creates the channel at
  every boot and `install -d` re-applies the same mode and owner. Leave the call in place — DF1.11 keeps it as an **image-regression tripwire at zero diff**, its verify-after-provision assertions failing loudly on a box whose baked entry did not fire. Neither story retires it.
- **Guards/limits:** `--setup-script`'s 10 KiB cap is irrelevant because systemd is the boot hook; size and cold-boot time are **recorded**,
  never asserted against an invented ceiling; the credential scan judges config files **by content** (a stock base ships npm's own `.npmrc`)
  — DF2.9's round-2/3 hardening reused, not rewritten. pi being a compiled ELF is the recorded `bun build --compile` upgrade path for the engine, but packaging it is DF1.10's and coupling it here makes this digest un-buildable until the engine exists.
- **Deviation/assumption:** publishing **publicly** trades obscurity of the image's composition for the removal of a D8 argv-secret conflict
  and an entire credential lifecycle. INV-5 already guarantees the image holds no secret, so what a public image leaks is a dependency list.
  If the operator disagrees, AC4's private arm is the honest alternative and its cost is a ratified deviation plus PAT minting, rotation and expiry — an expired PAT breaks *every* box create at once.

## Observability Contract

- Every `create()` logs `{ requestId, imageRef, imageDigest, registryAuthUsed }` on events `create_requested | create_shape | create_failed` (the event name rides the `operation` field as `exedev.<event>`). The box name rides as `vm` — which in every fleet flow IS the run id (`driver.create(opts.runId)`), while the log envelope's own `runId` field is `null` at the driver layer; join create events by `vm` (round-2 correction: the original wording promised a populated `runId` the driver never emits). The registry credential never appears, in any field, under any event. A driver constructed over a TAG-pinned image additionally announces `image_not_digest_pinned` once, at construction.
- `requestId` propagates from the caller onto every create event and onto the setup gate's marker assertion, so a boot regression joins to its image digest without a second key; errors carry `{ code, message, remediation }`. Codes on this surface: `image-invalid`, `image-build-id-invalid`, `image-pin-incomplete`, `registry-auth-invalid`, `registry-auth-unratified`, `registry-auth-file-mode`, `registry-auth-unreadable`, `create-failed`, and the marker assertion's `image-marker-mismatch` | `image-marker-unreachable` (the transport-fault arm split out in round 1: ssh 137/255 and non-clean probe exits are a box/transport verdict, never evidence about the image).
- Sub-timings: `create_ms`, `boot_ready_ms`, `marker_assert_ms`. A field never evaluated reports `0`. `boot_ready_ms` rides the `gate_a` log line — gate entry to assertion A settling, clamped ≥ 1 ms on a pass so it can never collide with the 0 sentinel; a gate that throws before A emits no `gate_a` line and therefore no field at all (by design — there is no line to carry it). There is no `image_pull_ms`: the pull happens host-side inside `ssh exe.dev new`, before the box exists, and nothing here can time it.

## Files to Modify

- `oci/exedev/Dockerfile` (new — derived `FROM` exeuntu; **DF1.10 adds only the engine build stage**)
- `oci/exedev/systemd/` (new — `qds-run@.service` with `Restart=no`, and `qds-steering.conf` for `/etc/tmpfiles.d/`; consumed by DF1.10/DF1.11, neither enabled per-run here)
- `oci/exedev/binary-licenses.json` (new — compiled-binary attribution the package sweep cannot derive, coverage computed against the base)
- `scripts/build-exedev-image.ts` (new — build → extract → DF2.9 sweep → credential scan → tag, reusing `license-sweep.ts` and `generate-notice.ts` unchanged)
- `src/providers/exedev/driver.ts`, `setup-gate.ts`, `assertions-in-box.sh` (all authored by DF2.2; this story **adds only** the two argv spreads with their constructor validation and provenance fields, the `/etc/qds-image.json` assertion folded into gate B, the corrected pi message in `setup-gate.ts`, and F14's version-conditional re-aim in `assertions-in-box.sh`)
- `.github/workflows/publish-exedev-image.yml` (new — publishes and fails if the pushed digest ≠ the repo pin)
- `.github/dependabot.yml` (authored by DF2.9; adds a second `docker` directory entry)
- `tests/providers/exedev/image-contract.test.ts`

## Security Invariants

- **INV-IBOX-1 (no credential in the image — DF2.9 INV-5, extended verbatim to the new tree):** the factory image holds no API key, no
  `.npmrc` auth token, no git credential and no registry auth. Build-time secrets, if ever needed, use BuildKit mounts and never `ENV`/`ARG`
  values that persist into a layer. Asserted by scanning the built image's **layer history and filesystem** with DF2.9's content-judging
  scanner, never by reading the Dockerfile. The per-run capped key still arrives only at `$HOME/app/.env`, 0600, by DF2.3's delivery path.
- **INV-IBOX-2 (image identity is asserted in-box, never assumed):** the only way a box can state what it booted is the baked
  `/etc/qds-image.json`, and the only identity it can honestly carry is a build-generated `buildId` — not the digest, which is the hash of
  the manifest containing it. Gate B compares that `buildId` to the one the repo pin pairs with the pulled digest and refuses on absent,
  over-cap, unparseable or mismatched — fail-closed, before any run is dispatched. A host-side pull check proves nothing about the box that
  actually booted, and a marker asserting its own digest would be asserting a value no build can produce.
- **INV-IBOX-3 (the registry credential is a separate class, and argv is a hazard):** the pull credential is never minted, capped, delivered
  into a box, written to `$HOME/app/.env`, or revoked on DF2.3's lifecycle. It is a host operator credential in a 0600 file, covered by
  DF2.1's `assertNoSecret` before anything is persisted, redacted from every emitted line, and **named but never echoed** by the validation
  error that refuses a malformed value — the `tag-invalid` precedent interpolates the value it rejects, which on a credential is the leak.
  Because ssh concatenates argv into a remote
  command line, passing it at all deviates from D8's "secrets never in argv" (DF2.3 INV-CRED-3, *"secrets travel over stdin, never argv"*) —
  redaction covers logs, not the host process table. The default path is a public image carrying no credential; the private path requires a
  **recorded operator-ratified deviation**, an unratified one being the exact failure mode this ADR exists to unwind.

## Definition of Done

- [ ] **Impl:** `oci/exedev/Dockerfile` derived `FROM` exeuntu with `ARG BUN_VERSION`/`ARG PI_VERSION`, the baked `/etc/qds-image.json`, the `qds-run@.service` template (`Restart=no`) and `/etc/tmpfiles.d/qds-steering.conf` — both checked at build by `systemd-analyze verify` and `systemd-tmpfiles --dry-run`, since this story starts neither and a malformed asset would otherwise surface first in DF1.10; the same check asserts the rendered unit and the image environment set **no** `QDS_RUN_ROOT`, `QDS_STEERING_ROOT` or any other `QDS_*` path variable (AC6 — DF1.11's INV-IBOX-13 and DF3.7's AC4 both rest on it).
- [ ] **Impl:** `scripts/build-exedev-image.ts` + the publish workflow; the pushed digest is written back into the repo pin and the workflow fails on mismatch; `.github/dependabot.yml` gains the second `docker` entry.
- [ ] **Contract:** `create()` passes `--image` (and optionally `--registry-auth`) validated in the constructor with typed `ExeDevDriverError`s; the default reference is a module-level constant, never `process.env` inside `create()` (AC3).
- [ ] **Integration:** gate B asserts the baked `buildId` fail-closed, adding no `AssertionItem` letter and no edit to DF3.1's code table; `setup-gate.ts:422`'s pi message is corrected and `assertions-in-box.sh`'s F14 arm made version-conditional against the pinned pi rather than unconditionally tolerant (AC2).
- [ ] **Security:** DF2.9's credential scan green over the built layers and filesystem; no registry credential in any log, provenance field, or persisted record (INV-IBOX-1, INV-IBOX-3).
- [ ] **Test (boot contract, AC1):** a real box created from the pinned reference reaches `multi-user.target`, answers ssh as `exedev` and passes every setup gate; an absent, over-cap, unparseable or mismatched marker refuses with a payload error code; a build-and-push-only test MUST fail.
- [ ] **Test (pins, AC2):** in-box `bun --version` and `pi --version` equal the build args; an unpinned-install image MUST fail.
- [ ] **Test (argv validation, AC3/AC4/INV-IBOX-3):** metacharacter-bearing `--image` and malformed `--registry-auth` refuse before any command runs; the credential appears in no emitted line and no provenance field.
- [ ] **Test (license + binaries, AC5):** the sweep runs over the built image's exported filesystem and its package count is recorded as evidence; `binary-licenses.json`'s coverage set is computed by diffing the built image's binaries against the base, and a test asserting the table against a list the table itself supplies MUST fail.
- [ ] **Test (e2e demo — MANDATORY):** one real box booted from the pinned digest, rebooted with `sudo reboot`, returns with `/run/steering` at 0700 `exedev` from the `tmpfiles.d` entry alone and a marker `buildId` matching the pair the repo pin records; evidence JSON records the pin shape that shipped (digest vs immutable tag), the built image size and the cold-boot time. DF1.10 does not boot this exact digest — it adds its engine stage and re-pins — it inherits the boot contract, the marker mechanism and this pin ritual.

## Dev Agent Record

**Status:** **merged to `dev`.** Implementation complete and live-proven on real substrate. The
story landed across eleven PRs — [#184](https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/184)
(the feature) then #192, #193, #194, #196, #197, #199, #200, #202, #203 and #206 (publish, org
transfer, provenance and live-E2E follow-ups) — merged as `23b0342`, `6d22c56`, `d722db0`,
`26e7663`, `aa7375f`, `496b1f9`, `a761697`, `e4d309a`, `189f318`, `2f4fd14` and `11f9fe8`.
Review round 6 (2026-09-03) is open against `dev` on `fix/df2.10-review-round-6`.

Three claims that stood in this block through round 4 are now **false and struck**:
- *"the workflow has never run at all — the pinned image was built and pushed by hand."* It has
  run; the current pin was **CI-published** and adopted in #199 (`a3eacb3`).
- *"the pinned pair is stale until the image is rebuilt."* It was rebuilt and re-pinned. The live
  pin is `ghcr.io/quantum-digital-solutions/qds-exedev@sha256:92447929…` / `3cf094fb6990ed66`,
  proven by `2026-09-02-221047-t1-image-contract.json` (full gate + reboot) and
  `2026-09-02-215507-t1-registry-auth.json` (AC4 on the same buildId). See *The pin that shipped*.
- *"the bootstrap exception expires 2026-10-15."* Retired in #203 (`b188615`);
  `.github/image-pin-exceptions.json` is `{"exceptions": []}` and the pin now carries verifiable
  cosign provenance.

The `publish-exedev` required-reviewer rule remains **deliberately dropped** — the API returns
`422` on this billing plan (deviation 8). What the environment carries is a deployment **branch
policy** (dev/main only). Round 6 corrected the workflow prose that still claimed otherwise.

### The pin that shipped

**Digest, not the AC1b immutable-tag fallback — now MEASURED on a real box, not inferred.** AC1(a) was open at story time — `--image` is documented only as "container image", its sole vendor example is `ubuntu:22.04`, and a grep of all 9,453 lines of exe.dev's docs returns zero hits for `sha256`/`digest`. It is now answered by publishing and booting one.

| | |
|---|---|
| Reference | `ghcr.io/biospark33/qds-exedev@sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d` |
| Manifest kind | single-platform `linux/amd64` image manifest (57 layers, `created=2026-09-01T01:27:20Z` — the epoch, not a wall clock). Not a multi-arch index: the earlier index existed only because of the provenance attestation, which had to be disabled for reproducibility. A pull by digest resolves one hop sooner; exe.dev's `--image` path is unaffected. |
| Anonymous pull | HTTP **200** — the no-credential production path verified live against the pinned digest |
| `buildId` | `664876fb1a9128ec` (deterministic: sha256 over base digest ‖ BUN_VERSION ‖ PI_VERSION ‖ Dockerfile ‖ both unit files, first 16 hex) |
| Base | `ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d` |
| Swept npm packages | 0 |

The pin is the single-platform amd64 **image manifest** digest (the row above), so exe.dev's host-side pull resolves it directly rather than through an index. It was verified present **in the registry** (`docker buildx imagetools inspect` against ghcr), not merely built locally — the local export digest and the registry digest were compared and matched. *(This sentence previously read "the multi-arch index digest", which was true of the superseded `…3c21d5f9…` pin and false of this one; corrected in the attestation follow-up rather than left to mislead DF1.10's re-pin.)*

**The pin ritual TERMINATES — a correction DF1.10 inherits.** As first written, the publish workflow built at `HEAD` and baked `HEAD` into `/etc/qds-image.json`, so the documented ritual (dispatch → gate fails → paste the pin into `driver.ts` → commit → re-run) could never go green: the pin-adoption commit *is* a new HEAD, so the re-run produced a fourth digest, and a fifth, forever. The workflow now resolves the **image source revision** — `git log -1 -- oci/exedev scripts/build-exedev-image.ts`, kept in lockstep with its own `on.push.paths` — and passes it as `QDS_GIT_SHA` plus the matching `SOURCE_DATE_EPOCH`; `scripts/build-exedev-image.ts` honours both as documented env overrides (`imageSourceSha()`, `sourceDateEpoch()`). A `driver.ts`-only commit does not move that revision, so the re-run rebuilds the exact bytes it was handed. The gate additionally asserts the marker's `gitSha` equals the resolved source revision, so a regression that silently reverts to HEAD goes red *as itself* rather than as "the digest moved again". Two related gate defects were fixed in the same pass: the pin grep was line-oriented while `DEFAULT_IMAGE_REF` is a **two-line** declaration (so it matched nothing and the gate failed closed on every run), and the OIDC/attestation permissions now live in a separate `attest` job so `bun install`'s lifecycle scripts never share an environment with `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.

### AC7's three unmeasured premises, now measured

**(a) exeuntu IS published as a pullable image — the feared arm did not ship.** `ghcr.io/boldsoftware/exeuntu:latest` is public and multi-arch; `docker.io/boldsoftware/exeuntu` does **not** exist (401/denied). So the build does **not** clone the repo at a pinned commit and does **not** inherit that Dockerfile's ten categories of unpinned network fetches (`apt dist-upgrade`, tailscale "stable", `go.dev/dl/?mode=json` latest-resolution, `astral.sh/uv/install.sh` piped to shell, an `fd` "latest" redirect, and `exeuntu update` for four agents). We pin their *built artifact* by digest, which is reproducible for us regardless of how they built it. Upstream runs a **weekly no-cache cron rebuild**, which is exactly why `FROM …:latest` would have re-acquired the disease this story treats.

**(b) `exe.dev/install-shelley` is KEPT.** exe.dev's own docs state the label controls Shelley auto-install and UI affordances only; nothing in 9,453 lines ties it to boot or ssh. Per AC7b, "unknown is not a reason to drop it" — and no box has ever been booted without it. Inherited untouched from `FROM exeuntu`.

**(c) Size and cold-boot time are recorded in the evidence JSON**, never asserted against an invented ceiling (Technical Notes, explicit). Built image 1.60 GB.

**Bonus measurement:** the Infra Prerequisites table predicted ghcr returns **403, not 401** on an insufficient credential. Confirmed empirically — an anonymous manifest GET against the freshly-pushed private package returned exactly 403.

### Registry posture — an operator decision, and why it changed

AC4's default (public image) shipped, but **not** for the reason the story gives, and the reasoning was revised mid-story against the long-term target of running inside customer tenants:

- A private registry does **not** protect engine IP from the people you ship to. DF1.10 adds the engine binary to this same image, and a tenant running it on their own hardware reads it off disk regardless. Registry ACLs were never that control.
- Every enterprise security review mirrors a vendor base image into its own registry (ECR/ACR/GAR/Harbor); boot-time egress to a vendor registry is commonly refused outright and impossible when air-gapped. **A digest is content-addressed, so `crane copy` into a customer's registry preserves it** — this pin and gate B's `buildId` check work unchanged inside a tenant, with zero credential exchanged.
- A private source registry would mean issuing, scoping, rotating and revoking a credential **per tenant, forever** — and ghcr requires a *classic* PAT, which GitHub cannot scope to a single package, so a leak would expose every package the account can read.

Consequence: **no registry credential exists on the production path**, so D8's "secrets never in argv" holds *by construction* rather than by mitigation, and **no INV-IBOX-3 deviation needed ratifying**. `--registry-auth` still ships validated, redacted and default-off — its durable use is the tenant booting from *their own* private mirror, which is what AC4's "validated, redacted and default-off" actually describes.

Measured constraint behind this: exe.dev's `doc private-image` states the boot pull happens **host-side, before the VM exists**, and explicitly says the container-registry *integration* (`<name>.int.exe.xyz`) is **not available to that pull**. So for a private image `--registry-auth` in argv is the only mechanism — there is no stdin form (`/dev/stdin` is documented for `--setup-script` and `--prompt` only). A self-hosted `registry:2` was evaluated and rejected: the vendor's own example passes no credential at all, meaning the registry VM must be publicly reachable — same argv exposure, plus a 24/7 billing VM, TLS/GC/backup ownership, and a single point of failure where registry-down means every box create fails.

### Deviations from the story

1. **43 files touched, not 10 — 50 once round 4 is committed.** (Corrected in round 4, finding H1: this entry read "13 files touched, not 10" from round 1 onward and was never revisited. It was stale by round 2 and badly wrong by round 4.) The atomicity audit flagged DF2.10 as sitting *exactly* at the Files-to-Modify limit; four review rounds have taken it far past. Measured, not estimated: `git diff origin/dev...HEAD --numstat | grep -v '_bmad-output/' | wc -l` → **43** committed paths, plus 7 more modified only in round 4's still-uncommitted working tree, = **50 distinct paths**. The full list, grouped:
   - **CI / supply chain (6):** `.github/workflows/publish-exedev-image.yml`, `.github/workflows/verify-image-pin.yml`, `.github/dependabot.yml`, `.github/image-pin-exceptions.json`, `.dockerignore`, `.claude/skills/qds-live-e2e/SKILL.md`
   - **Image (4):** `oci/exedev/Dockerfile`, `oci/exedev/binary-licenses.json`, `oci/exedev/systemd/qds-run@.service`, `oci/exedev/systemd/qds-steering.conf`
   - **Build script (1):** `scripts/build-exedev-image.ts`
   - **Source (7):** `src/providers/exedev/driver.ts`, `setup-gate.ts`, `transport.ts`, `assertions-in-box.sh`, `src/providers/index.ts`, `src/providers/credentials.ts` (deviation 6), `src/fleet/fanout-primitive.ts` (deviation 7)
   - **Unit / contract tests (9):** `tests/providers/exedev/image-contract.test.ts`, `image-assets.test.ts`, `read-box-file.test.ts`, `setup-gate.test.ts`, `fixtures/fake-exedev.ts`, `tests/providers/credentials.test.ts`, `tests/fleet/patterns.test.ts`, `tests/scripts/build-exedev-image.test.ts`, `tests/scripts/exedev-bun-pin.test.ts`
   - **Live e2e (22 paths / 21 files):** `tests/fleet/e2e/live-harness.ts`, `live-harness.test.ts`, and **all 19** `*.live.test.ts` in the directory — round 4's wave 2 reached the nine `tier1-*` files, six of which no reviewer had opened. The rename `tier1-image-contract.live.test.ts` → `tier2-image-contract.live.test.ts` counts as two paths to `git` and one file in fact.
   - **Contract pin (1):** `tests/gitnexus/cli-contract.ts`

   Three of them cross a gate line for a *design* reason rather than a review-round reason, and were recorded here from round 1:
   - `src/providers/index.ts` — AC3 requires the override be read "at the registry factory", and that factory is here. `create()` stays free of `process.env`, which is AC3's negative control.
   - `tests/providers/exedev/fixtures/fake-exedev.ts` — its `new` matcher is **exact-anchored** (`/^new --name (\S+)( --tag (\S+))? --json$/`), so adding `--image` made every existing `create()` fall through to `exitCode 64`. Extended, still anchored — the anchoring catches argv drift and was kept deliberately.
   - `tests/fleet/e2e/tier2-image-contract.live.test.ts` (renamed from `tier1-image-contract…` in round 4 — see the rename note under *Review Round 4*) — the DoD's MANDATORY e2e demo has no other home.

   **There is no round-3 record in this file, and that is a real gap, not an omission of nothing.** Commit `c52f4d0` is titled *"fix(df2.10): review round 3 — cleanup paths that swallowed the real failure"* and carries thirteen substantive fixes across nine live-fire cleanup blocks (`settleRun`/`fleetCleanupProblems`/`teardownQuietly` in `live-harness.ts`), `fanout-primitive`'s `probeArm` probe-exit discriminator, `credentials.ts`'s post-acceptance store-write compensation, the driver's `runId` on create events, and five `build-exedev-image.ts` defects (declaration-order alias resolution, `--summary`/`--evidence` validated against the build-input set, pre-build writability, the `inspectConfigs` scratch dir registered for the signal sweep, the BUILD_DIR sweep's exit code). The commit message is the only record of that round; nothing was written here. Round 4's ledger picked up two of its consequences directly (deviations 6 and 7 below), which is how the gap surfaced.
2. **`transport.ts` gained the marker contract instead of `driver.ts`.** `setup-gate.ts` holds only `import type { ExeDevDriver }`, so a value import from `driver.ts` would have been a real ESM cycle (`driver.ts` imports `setupGate`). `IMAGE_MARKER_PATH`, `IMAGE_MARKER_MAX_BYTES`, `QdsImageMarker`, `parseImageMarker`, `imageDigestOf` and `imageMarkerFailure` live in `transport.ts` — the LOW module both already import one-way, and where `readBoxFile` already lives — and are **re-exported from `driver.ts`**, so the module's public surface is unchanged. `DEFAULT_IMAGE_REF` stays in `driver.ts` as AC3 requires.
3. **Story anchors corrected.** AC3 cites `tag-invalid` as constructor validation at `driver.ts:239-255`; `tag` is a per-call argument validated *inside* `create()`. The real constructor precedent is `execTimeoutMs`/`hostSuffix` at `:191-196`, which is what `image`/`registryAuth` follow. `DEFAULT_EXEC_TIMEOUT_MS` is module-level in `transport.ts`, not `driver.ts:199` (that line is its constructor default assignment).
4. **`tests/oci/` does not exist.** Infra Prerequisites requires "`bun test tests/oci/` green before this story starts". DF2.9's suite is `tests/scripts/license-sweep.test.ts` (797 lines, 70 tests) — green throughout.
5. **TDD ordering.** The API contract was frozen and runtime-verified before either implementation or tests were written, then tests were authored **independently, by a separate agent, against that frozen spec** — stronger than self-written-after tests, but not literal test-first. Recorded rather than claimed otherwise.
6. **`src/providers/credentials.ts` `mintRunKey`: compensation on a failed record write (DF2.3 code, not in Files to Modify).** (Round-4 finding **D4**; the change itself landed in round 3, `c52f4d0`, and went unrecorded until the acceptance auditor found it.)

   `mintRunKey` gained a compensation path on the `deps.store.set(runId, { keyHash })` failure branch: a throwing store write now calls `revokeAndVerify(deps, res.hash)` before rethrowing the write failure as the reported cause, and emits a `credential.mint_compensation` log event (`outcome: "error"` when the revoke also fails, `outcome: "ok"` when it succeeds). The story states "no DF2.3 code is touched" and `credentials.ts` is not in Files to Modify; this was not among the three recorded deviations.

   It is justified and it stays: the "record the mint BEFORE judging the returned cap" ordering (`credentials.ts:347-351`) protects every refusal that fires *after* `store.set`, but not `store.set` itself. When that write throws, the key is LIVE at the provider and the run record — the only thing a later `revokeRunKey` or `revokeQuietly` can read — was never written, so nothing downstream ever learns the hash. The key survives the run spendable and unreachable: precisely the orphan the credential lifecycle exists to prevent, and the one failure mode DF2.3's own INV-CRED invariants are written against. The path mirrors the pre-existing mint-timeout compensation (`credentials.ts:289-344`) in shape, operation name and best-effort semantics.

   Behavioural surface changed, for the record: (a) new outbound provider traffic (DELETE + verify) on a previously inert failure path — reached ONLY when `store.set` throws, i.e. a disk/record fault; (b) a new log operation name, `credential.mint_compensation`, on this path (the name itself already existed on the mint-timeout path, so no new sink or schema is introduced); (c) the exception surface is UNCHANGED — the original store-write error is still what is thrown, and a failing compensation is swallowed and logged, never substituted for it. Affected callers are every caller of `mintRunKey`, all of which reach it only on the same failure: `runCredentialLifecycle` (`src/providers/credentials.ts:649`), `dispatch` (`src/fleet/dispatch.ts`), `runDispatch` (`scripts/fleet.ts`), and `runCapHitDemo` / `main` (`scripts/cap-hit-demo.ts`). gitnexus `impact({target:"mintRunKey", direction:"upstream"})`: 9 impacted symbols, 4 direct, 5 affected processes, modules Providers + Fleet + Scripts all direct, risk **CRITICAL**.

   Covered by `tests/providers/credentials.test.ts` — *"a store write that fails AFTER the provider accepted the mint revokes the live key instead of orphaning it"*. Round 4 additionally made the **successful** compensation loggable (finding D3b): a run whose live key was minted and immediately taken back used to read in the log as "a live key was minted for it", forever, because the mint line was the last word. Known remaining gap, deliberately not widened here: the sibling `delivery_compensation` path (`credentials.ts:657-686`) still logs only the failed compensation and carries the identical hole — worth an issue, not worth widening a DF2.3 deviation further.
7. **`src/fleet/fanout-primitive.ts` `probeArm` and `src/providers/exedev/transport.ts` `readBoxFile`: the round-2 deferral is no longer accurate.** (Round-4 finding **D5**.)

   Round 2 recorded `probeArm` as DEFERRED — "Out of this PR's clusters; needs a fleet fix or issue". The fix landed in this PR anyway (round 3, `c52f4d0`, completed in round 4), so that deferral text is false and is superseded by this deviation. Two behaviour changes ship to DF3's race path:

   1. **Probe-exit classification and skip accounting (`probeArm` / `runRace`).** `readBoxFile` reports every non-zero presence probe as `{kind:"absent"}` and carries the probe's own exit. `probeArm` consulted neither, so a box answering 255 (ssh never connected) or 137 (SIGKILLed at the per-call budget) read as a CLEAN absence and reset the arm's corruption streak on every tick — the arm could never reach `MARKER_UNUSABLE_TICKS_LIMIT` and the race spun to the full `DEFAULT_FANOUT_CEILING_MS` (1 h) with the fleet lock held, which is the exact spin that limit exists to bound. `probeArm` now returns a distinct `"skip"` verdict for every no-evidence tick (non-clean absence, unreadable `cat`, timeout/transport throw), and `runRace` counts consecutive skips against a new `PROBE_SKIP_TICKS_LIMIT = 6`, abandoning the arm as `armUnknown` with a `probe-unanswered` event. A skip still never resets a genuine corruption streak; a tick that reaches the box still clears the skip streak. Abandoned arms are `armUnknown`, so they are never torn down on a guess (fail-safe for the box, INV-5 preserved). Covered by `tests/fleet/patterns.test.ts` — the ssh-255 discriminator test and the new *"a box that NEVER answers is bounded"* test.
   2. **`readBoxFile` now prefers `driver.execTimed` when the driver exposes it** (`transport.ts:127-143`). `driver.exec` hard-codes `DEFAULT_EXEC_TIMEOUT_MS`, so `withTimeout` expiring only ABANDONED the ssh — the process kept running against the box for up to 120 s with its output discarded, past the very deadline the caller set. `execTimed` passes `deadlineMs` down to the spawn, so the budget KILLS the process. This is a real change in substrate-side process behaviour for every existing `readBoxFile` caller, not just the fan-out race: a probe that exceeds its budget now dies (and surfaces as exit 137) instead of lingering. `execTimed` is optional in the parameter type, so a structural fake exposing only `exec` still satisfies it and keeps the old abandon-only behaviour.

   Existing `readBoxFile` callers affected (full grep, `--include=*.ts`, node_modules excluded):
   - **Production (2, both import it directly from `transport.ts`; it is NOT re-exported by `src/providers/exedev/driver.ts`, `src/providers/driver.ts` or `src/providers/index.ts`, so this is the complete production surface):**
     - `src/fleet/fanout-primitive.ts:31` (import), call at `:761` inside `probeArm` — the DF3 race poller, one call per arm per poll tick.
     - `src/providers/exedev/setup-gate.ts:64` (import), call at `:507` — the DF2.10 image-marker read (`IMAGE_MARKER_PATH`) inside `setupGate`. Its comments at `:484-488` already document the `execTimed` routing and the 137-at-the-budget consequence, so that call site is aligned.
   - **Tests / fixtures (not callers of the production path, but they encode its shape):** `tests/providers/exedev/read-box-file.test.ts` (`:30` asserts the `execTimed`-preferred path, `:52` the truncated-and-137 case) · `tests/providers/exedev/setup-gate.test.ts:866` (accounts for the TWO seam calls) · `tests/providers/exedev/fixtures/fake-exedev.ts:661-663, 725` (models both execs; `:725` refuses an unsimulated verb touching `IMAGE_MARKER_PATH`) · `tests/fleet/patterns.test.ts:135, 1217` (the `RaceFakeDriver.probeExit` seam and the ssh-255 test).

   gitnexus `impact(direction:"upstream")` for the race path: `runRace` — 3 impacted, 1 direct, 3 affected processes (`fanout`, `runFanout`, `run`), risk **HIGH**; `probeArm` — 3 impacted, 1 direct, 2 affected processes (`fanout`, `runFanout`), risk LOW (its real radius is inherited through `runRace`).

8. **The publish second factor is a server-side ORIGIN constraint, not a second human — and the repository moved to an org.** (2026-09-02, during the post-round-4 publish attempt. Measured, not chosen on preference.)

   Round 4 added a step asserting a `required_reviewers` rule on the `publish-exedev` environment, failing closed without one. **That rule cannot be created on this account topology.** Two `PUT` attempts against `/repos/.../environments/publish-exedev` returned:

   ```
   422 Failed to create the environment protection rule.
       Please ensure the billing plan supports the required reviewers protection rule.
   ```

   A `wait_timer`-only probe returned the same 422 naming *the wait timer* — proving it is the whole **deployment protection rule** class that is gated, not required-reviewers specifically. Deployment **branch policies** are a separate feature and *are* available, which is why `branch_policy` is the one rule the environment has ever carried. Both probes were atomic: the environment was re-read after each and was unchanged.

   The repository was transferred `biospark33/QDS-Factory` → `Quantum-Digital-Solutions/QDS-Factory` the same day. Environments, deployment branch policies, the `Default` ruleset and both collaborators survived the transfer intact. The org is on the **free** plan, so the transfer alone does not unlock protection rules either.

   **Operator decision, recorded rather than inferred:** the two write-access accounts (`biospark33` admin, `i3creations` write) develop this together and do not want a publish blocking on the other's approval. The second-human property is therefore **dropped deliberately**, not lost to a bug and not worked around.

   What the step asserts now: the environment **exists**, carries a `branch_policy` rule, and its resolved branch list is **exactly** `dev main` — content, not mere presence, so deleting the environment or widening it to `~ALL` fails loudly instead of silently publishing from anywhere. Still fail-closed on an API read failure. `EXPECTED_REFS` is spelled in the workflow so widening it is a reviewed diff here rather than a click in repository settings.

   **What is lost, named so nobody rederives it:** either write-access actor can now publish to the public package unilaterally. **What is not lost is production** — the pin gate and `verify-image-pin` still mean nothing boots that a reviewed `driver.ts` commit did not name and an attestation did not cover. This step protects the *package*; the pin protects the *boxes*, and only the former was weakened.

   **Reversal:** create an org on GitHub Team (2 seats), restore the `required_reviewers` assertion, and set the rule with `i3creations` as reviewer. Nothing else in the workflow needs to change.

   **AMENDED THE SAME DAY — the re-scoped assert was removed too, and for a different reason than the one above.** It never once evaluated its own condition. `GITHUB_TOKEN` cannot read `/repos/{owner}/{repo}/environments` at all:

   | run | step | result |
   |---|---|---|
   | `33623411880` | round 4's `required_reviewers` assert | `403` |
   | `33634290011` | the re-scoped origin assert | `403` |
   | `33634741595` | after granting `deployments: read` | `403` |

   `gh: Resource not accessible by integration (HTTP 403)`. The endpoint wants the *Environments* permission; there is no `environments:` key in the workflow `permissions:` vocabulary, and `deployments: read` — the only candidate mapping to that surface — does not cover it. A structural limit of the built-in token, settled by measurement because the REST docs decline to name the permission for GitHub Apps.

   **This means round 4's reviewer gate was never reached by its own reviewer check.** The 422 billing wall is real and separately proven, but it was never what those runs were failing on. Two independent defects presenting as one symptom, and the first diagnosis of this round conflated them.

   Removed rather than relaxed. Softening it to warn-on-403 would ship a green publish carrying a line nobody reads. Note also what it could never do: against an actor who edits the workflow file on a branch, the assert falls with the rest of the file — so its real value was catching *accidental or administrative* removal of the branch policy. That is drift detection, and it belongs on a schedule, not in the release path.

   **Replacement, decided rather than defaulted:** a scheduled audit reading the environment through an **org-owned GitHub App** — short-lived per-run installation token, no person-bound PAT, survives personnel change — in the shape of `verify-image-pin.yml`'s `base-drift` job, which is where config drift already lives here. A repo-scoped fine-grained PAT was rejected for the publish path specifically: it would put a long-lived, person-bound credential in the highest-privilege workflow in the repo, expiring at most yearly and failing the *release* closed when it did. The App is also the same mechanism the product will need for multi-repo access at scale, so it is not a one-off. **Until it lands, removal of the branch policy is not detectable from CI** — stated because an undetectable gap nobody wrote down is the one that gets rediscovered as a bug.

   What survives and still enforces: the branch policy itself (server-side, pre-job, uneditable by a branch), the in-file ref refusal (defence in depth), and the pin gate (production). `deployments: read` was granted and then removed in the same session once its only consumer was gone.

   **Also added, closing a larger gap found while analysing this one:** the `Default` ruleset enforced only `deletion` + `non_fast_forward`, on `~DEFAULT_BRANCH` alone — so either write-access account could push unreviewed bytes to `dev` and publish them. Origin controls constrain *where a publish comes from*, never *what it contains*. The ruleset now covers `dev` **and** `main` and requires a pull request with 1 approving review, with `OrganizationAdmin` bypass so the admin's own flow is unchanged. That, not the assert, is the control that makes "published bytes were reviewed" true.

   **AND THE PACKAGE HAD TO MOVE TOO — measured, after the first real publish was refused at the push.** The earlier claim in this deviation that `ghcr.io/biospark33/qds-exedev` "is still user-owned and reachable from here via the package's own Manage Actions access grant" was **wrong**. The grant was set (`QDS-Factory → Write`, confirmed in the UI) and `docker login ghcr.io` succeeded — login succeeds with any token; it is the push that resolves authorization:

   ```
   #18 [auth] biospark33/qds-exedev:pull,push token for ghcr.io
   #17 ERROR: failed to push ghcr.io/biospark33/qds-exedev:sha-a495f22…
       denied: permission_denied: The requested installation does not exist.
   ```

   `GITHUB_TOKEN` is an installation token for the **org's** Actions app. The package is owned by a **personal account**, where that app has no installation — so no *Manage Actions access* entry can bridge it. **An org repo cannot push to a user-owned GHCR package**, and no configuration changes that. Recorded because it is invisible until the push: the grant UI accepts the repository and shows it with `Role: Write`, and the login step goes green.

   The package therefore moves with the repo: `ghcr.io/biospark33/*` → `ghcr.io/quantum-digital-solutions/*` (17 refs, including the private mirror and the Dockerfile's BUMP PROCEDURE, which is a `deriveBuildId` input, so the buildId moves again). Cost is the rename only — no pin had been established for the new bytes yet, which is the one window where a namespace change is free. **Consequence to sequence:** the first push creates the org package **private** (org packages do not inherit public), and the `Assert the package is anonymously pullable` step runs *after* the pin gate — so the package must be flipped to public before the adoption run, or that run fails on AC4's core property.

   Also corrected in the same commit: the `github.repository_owner == 'biospark33'` guard in **both** workflows (3 sites). The publish workflow had *forecast* this exact failure in its own comment — "an org transfer changes the owner and this guard then SKIPS (green-by-silence)" — and the window was real: between the transfer and this commit, every push to `dev` would have skipped the publish job and reported green. The same comment's parenthetical claim that `IMAGE`'s "namespace moves with the owner anyway" was **wrong** and is corrected: a GHCR package is owned independently of the repository that publishes it, so `ghcr.io/biospark33/qds-exedev` stayed put and is reached from the org repo via the package's own *Manage Actions access* grant.

9. **The ungated-push prune had never run once, and the gate's own error text said it had.** (2026-09-02, found by the first real publish that reached the gate — run `33637763742`.)

   ```yaml
   if: steps.gate.outcome == 'failure' && steps.publish.outputs.published == 'true'
   ```

   A step `if:` carrying no status-check function gets an implicit `success()`. By the time the gate has an outcome worth testing, the job is already failing, so the implicit guard skipped this step before its condition was ever considered. Measured: the gate failed on a real push, the step reported `skipped`, and the gate's error text told the reader the image "is being PRUNED by the step below".

   The reasoning that produced it, preserved on the `gate` step's `id:`, was **correct** — key on that one step's outcome rather than bare `failure()`, which is true for any earlier failure including the anonymous-pull check, whose pushed image *passed* the gate and must not be deleted. Dropping every status function to achieve that precision is what made the step unreachable. `always() &&` restores reachability and keeps the precision; the outcome test still does the discriminating.

   A control that has never executed, announced in prose as though it had, is worse than no control: it is a documented safety net that would have caught nothing. Nothing else in either workflow shares the flaw — every other `if:` referencing a step outcome carries `failure()` or `always()`, checked by grep.

   **No stray tag resulted this time, for a reason that is luck rather than design:** the tag is derived from the image SOURCE revision, and the adoption commit touches only `driver.ts`, which is trigger-only and not a source path. So the adoption run re-pushes the identical bytes under the same `sha-9c45324…` tag and the ungated tag becomes the gated one. Had adoption not followed, that tag would have sat in the package unreferenced and unpruned.

10. **Provenance is signed by cosign keyless, not `actions/attest-build-provenance` — and the SLSA predicate is now this repository's own document.** (2026-09-02, after the action was measured unable to sign here at any setting.)

    Artifact attestations require **Enterprise Cloud** for a private repository, and the action files every bundle to GitHub's attestation API unconditionally. Measured, exhaustively, before replacing anything: the workflow step failed `422 Feature not available for the Quantum-Digital-Solutions organization` (run `33644225766` and its re-run after the Team purchase); a direct REST `POST /repos/…/attestations` with a `repo`-scoped PAT returned the identical message, so it is not a `GITHUB_TOKEN` limit; the org's `plan.name` is `team` with 2/2 seats, so Team is not the tier; and `create-storage-record: false` (run `33650222396`) fails **identically** — that input does not gate the API call. The action's failure aborts it before the registry push, so the OCI referrer dies with it: the referrers list for the pinned digest was empty after every attempt. Enterprise (~$42/mo) was declined; the signer was replaced instead.

    **What replaced it, and what was proven before the replacement was written.** `cosign attest` (v3.1.3, keyless): the same `id-token: write` OIDC token, the same Fulcio issuance, the same Rekor transparency entry, the same Sigstore bundle media type (`application/vnd.dev.sigstore.bundle.v0.3+json`) pushed as the same OCI referrer — minus the one call this plan refuses, because cosign never touches GitHub's attestation API. The whole round trip ran against the live pin digest `sha256:92447929…` from a scratch workflow (run `33684476912`, branch and workflow deleted after) before either production file changed: attest, digest provably unmoved, `gh attestation verify --bundle-from-oci` green on the first attempt, and a wrong-identity negative control refused.

    **The verifier loops did NOT move to `cosign verify-attestation`, and that is a decision, not an omission.** The handoff assumed `gh attestation verify` could not consume a cosign-minted bundle; measured otherwise — `gh`'s OCI path (cli/cli `pkg/cmd/attestation/artifact/oci/client.go`) discovers any referrer whose artifactType has the `application/vnd.dev.sigstore.bundle` prefix, and its trusted-root handling accepts the Sigstore Public Good instance cosign signs against. Keeping `gh` preserves, verbatim, every control the loops already argue for: `--repo`, the ref-anchored certificate-identity regex, `--predicate-type https://slsa.dev/provenance/v1`, and `--deny-self-hosted-runners` — which is a **Fulcio certificate-extension check** (OID 1.3.6.1.4.1.57264.1.11, populated by Fulcio from the OIDC token, unforgeable by the workflow and indifferent to which client requested the certificate; cli/cli `pkg/cmd/attestation/verify/policy.go`), not a predicate inspection. A rewrite onto `cosign verify-attestation` would have had to re-implement that check by hand from the certificate. `slsa-github-generator` was rejected for the same anchor: its certificate identity is *its* reusable workflow, which breaks the deliberately ref-anchored `publish-exedev-image.yml@refs/heads/(main|dev)` regex that `verify-image-pin.yml` builds in the consumer precisely so the file under attack cannot loosen it.

    **What is gained:** a working attestation on the current plan; the predicate under this repository's own control (hand-built in the attest job to the action's own buildType schema, `https://actions.github.io/buildtypes/workflow/v1`, from the runner's `GITHUB_*`/`RUNNER_*` environment — the job still checks out no code); and one less dependency that can refuse to sign over billing.

    **What is lost, named so nobody rederives it:** the GitHub attestation store copy (already lost — this plan cannot write it; the loops already check `oci` alone), and predicate generation by a party other than the signer — the predicate is now claims by the same workflow that signs them. The controls do not rest on it: identity, ref, runner environment and repository all bind through the Fulcio certificate, and the predicate's `runner_environment` copy is annotated in the workflow as informational. **Disclosed:** Rekor is a public transparency log; keyless signing publishes the subject digest and the signer identity (repo, workflow path, ref) permanently. Judged acceptable because the package is already public and the image's `org.opencontainers.image.source` label already names this repository.

    **Reversal:** on a plan with artifact attestations (Enterprise Cloud, or this repo made public), restore `actions/attest-build-provenance` with `push-to-registry: true`, drop the two cosign steps, re-grant `attestations: write`, and widen both verify loops back to `for source in github oci` — the loops' comments carry that one-word reversal on purpose.

### Findings surfaced and fixed (none suppressed)

- **An unattributable npm tree in the image (AC5 firing as designed).** Both stock exeuntu and `exeuntu update pi` land `@mariozechner/clipboard@0.3.9` at `/home/exedev/.local/pi/node_modules` — the one package DF2.9 found unattributable (no authoritative license text anywhere in its chain). The enterprise tier survives it via `--omit=optional`; an ELF install has no `--omit`. **Measured safe to delete**: pi's own `package.json` lists it under `optionalDependencies`; the ELF holds exactly one `require("@mariozechner/clipboard")`, inside `loadClipboardNative`, wrapped in `try {} catch {}` and reached only when `DISPLAY`/`WAYLAND_DISPLAY` is set. Eight side-by-side runs (including forced `DISPLAY=:0` and `WAYLAND_DISPLAY`) are byte-identical with the tree present and absent. Removed **in the same RUN** as the install, because a `rm` in a later layer whites the path out while leaving the bytes in this one.
- **A credential-scanner defect that was also a security hole.** 126 findings were `could not read /etc/ssl/certs/<CA>.pem`. The cause was not that `docker cp` fails on a symlink — it exits **0** and writes a **dangling symlink onto the host** holding an *absolute in-container path*, and the `readFileSync` then ENOENTs into the fail-closed branch. That means a config symlinked to `/etc/passwd` would have had the **host's** file read and judged in its place. Fixed with `docker cp -L`, which resolves inside the container. Both fail-closed branches are intact; only *how a file is asked for* changed, never what counts as clean.
- **A gate whose verdict depended on who ran it.** One CA file kept failing: macOS `bsdtar` normalizes `docker export` paths to NFD, while the container stores NFC (`Főtanúsítvány`), so the script asked `docker cp` for a path that does not exist in the container. GNU tar on Linux CI does not normalize — local and CI would have disagreed silently. Fixed by trying both spellings and raising a finding only if every one fails.
- **A trap `-L` alone would have sprung:** three of the 126 "unreadable" entries were symlinks resolving to *real* private keys, so making them readable would have created **new** findings. The `examples` directory deletion takes them with it.
- **Eight inherited private keys** (Go stdlib `crypto/tls` and `crypto/x509` testdata, tornado/twisted test keys, perl/python doc examples) were **deleted, not allowlisted** — an allowlist is precisely the suppression this gate exists to prevent. Honest limit stated in the Dockerfile: the `rm` cannot remove bytes from the *base* layer, but the scan reads the flattened filesystem via `docker export`, which is what a booted box actually sees.
- Findings went **134 → 0** with a negative control that plants four keys across every changed arm (plain file, symlink, NFC non-ASCII name, and a re-plant inside a deleted directory); all four still fire, and the revert is proven byte-for-byte by an unchanged `buildId`.
- **`systemd-analyze verify` exits 0 on an ignorable bad directive** (`Type=bogus` → "Failed to parse service type, ignoring", exit 0). Exit code alone would have let a typo'd supervision directive ship and surface first in DF1.10 on a real box mid-run. The build therefore also requires the verify to be **silent** — a clean unit emits nothing.
- **`systemd-tmpfiles --dry-run` does not exist in systemd 255** (this base ships 255.4; `--dry-run` landed in v256). The build runs the real `--create` in the sandbox, asserts `stat` returns `700 exedev exedev`, then removes it — strictly stronger than a parse check, and `/run` is tmpfs at boot so a baked directory would be masked anyway.
- **`exeuntu update pi` fails on overlayfs** (`rename … invalid cross-device link`) because the stock pi tree lives in a lower layer. Removing the stock install first gives exeuntu its fresh-install path. Fine on a real box's ext4.
- **`docker buildx imagetools inspect --format '{{.Manifest.Digest}}'` silently ignores the template** on Docker 28.4.0 and prints the default human report — a caller trusting it would take a plausible blob for a digest, and that value becomes half the repo pin. `{{json .Manifest}}` is honoured and is what the build script parses, validating `^sha256:[0-9a-f]{64}$`.

### Signed provenance, restored out of band

The reproducibility work bought a stable digest by turning buildx's in-band provenance attestation off (`--provenance=false --sbom=false` — measured necessary, twice), and that left the published image with **no signed provenance at all**. Carried as a "Known limitation" below when the pin shipped; paid here instead. `.github/workflows/publish-exedev-image.yml` now signs the pushed digest with `actions/attest-build-provenance@v4` — sigstore keyless, so there is no key material and no secret anywhere: `id-token: write` mints the short-lived OIDC token Fulcio exchanges for a certificate binding repository, workflow and ref, and `attestations: write` files the resulting bundle. The bundle is stored in **both** GitHub's attestation store and ghcr, the latter as an OCI referrer.

**Why this does not re-acquire the disease it was disabled to cure.** A referrer is a *separate* manifest, under its own `sha256-<digest>` tag, whose `subject` field merely names the image. The image manifest bytes are never rewritten — and the digest is the hash of exactly those bytes. buildx's in-band attestation moved the digest precisely because it *did* rewrite the pushed artifact, into an index.

**Asserted, not argued.** Two steps follow the attestation:

- **"Assert the attestation did not move the image digest"** re-reads **by tag**. Re-reading by digest (`imagetools inspect "$IMAGE@$digest"`) returns the digest it was handed and would be a tautology that passes even if the tag had been rewritten into an index; inspecting `$TAG` asks the only question that matters — what does a puller resolve *now*. It fails on a changed digest **or** on a `mediaType` that is no longer `application/vnd.oci.image.manifest.v1+json`, so the specific historical failure mode is caught by name. Its error text refuses the obvious wrong fix in words: re-pinning to make it pass adopts an artifact no review saw.
- **"Verify the attestation against the published digest"** runs `gh attestation verify` **twice** — once against GitHub's API, once with `--bundle-from-oci` — because the two stores fail independently and serve different consumers: a tenant that mirrored the image into its own registry has the referrer and no GitHub access at all. Identity is pinned as tightly as the flags allow (`--repo`, `--signer-workflow` naming this file by path, `--predicate-type https://slsa.dev/provenance/v1`, `--deny-self-hosted-runners`), because a provenance check that accepts "signed by anything in this org" attests to nothing. Produced is not verified.

**The pinned digest is unmoved — measured, not reasoned.** A worktree detached at `7806bbee` (the revision the published image was built at: the marker's `gitSha`, and the source of its `SOURCE_DATE_EPOCH` 1788226040) with the PR's tree checked out over it, built twice under the published tag `ghcr.io/biospark33/qds-exedev:df2-10`:

| Build | Tree | `builtDigest` |
|---|---|---|
| baseline | the PR as it stood | `sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d` — **equal to the published pin** |
| after | + this follow-up's changes to the workflow, the live-e2e skill, `driver.ts` and `build-exedev-image.ts` | `sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d` — **unchanged**, `buildId` `664876fb1a9128ec` |

The first row carries as much weight as the second: it is an **independent reproduction of the published pin from a clean worktree on a later day**, which is the reproducibility claim above re-proven by someone starting from the repository rather than from a warm builder.

Structural reason the second row could not have gone otherwise, recorded so the measurement is not the only guard: `.dockerignore` excludes `.github`, `.claude`, `src` and `scripts` from the build context **entirely**, none of the four changed files is a `deriveBuildId` input (base digests ‖ `BUN_VERSION` ‖ `PI_VERSION` ‖ Dockerfile ‖ systemd units), and the attestation runs *after* the push, touching no build input at any point.

**What is NOT verified, stated plainly.** The attestation steps have never executed. This workflow has never run at all — it is absent from the default branch, and the pinned image was built and pushed by hand — and its pin gate is satisfiable only when rebuilding *at the pinned revision* (see the reproducibility limitation below), so a dispatch on any newer commit fails the gate **before** reaching the attestation steps. Deliberately not worked around: moving the attestation above the gate would sign an ungated image, and adding a bypass input to the gate is the thing this workflow's header already refuses. So `push-to-registry` against ghcr's referrers API and both `gh attestation verify` legs are verified only as far as static checks reach — `actionlint` clean; `action.yml` at `v4.2.2` confirmed to accept `subject-name` / `subject-digest` / `push-to-registry`; every `gh attestation verify` flag used confirmed present in `gh` 2.93.0. **First real exercise is DF1.10's re-pin**, which runs this workflow end to end; if ghcr's referrers API refuses the push, that run goes red loudly rather than publishing an unsigned image quietly.

### Known limitations

- **The build IS reproducible, and it was proven rather than asserted.** Operator-directed after the first publish. `SOURCE_DATE_EPOCH` comes from the commit timestamp (honouring an externally-set value first, per the standard's contract), `builtAt` is derived from it instead of `new Date()`, and BuildKit runs with `rewrite-timestamp=true` on a `docker-container` driver the script creates if absent. **Two cold builds with the builder cache pruned to `Total: 0B` between them — so the second re-pulled the base and re-executed every step — produced byte-identical digests, matching the registry read-back.**
  A probe pair isolated a second, independent source of drift that `rewrite-timestamp` alone does not fix: buildx's **provenance attestation** embeds build-time data and kept the index digest moving even with mtimes normalized (`ded2fc69…` ≠ `c8042e09…`). With `--provenance=false --sbom=false` the digests matched (`390b728e…` == `390b728e…`). Tradeoff, named rather than hidden: we lose buildx's in-band attestation. **No longer a limitation — see "Signed provenance, restored out of band" above, which shipped on this PR.**
  A second correctness fix fell out of it: the push path re-invokes the same buildx solve with `push=true` rather than `docker push`, because the daemon would otherwise re-gzip layers it loaded from an uncompressed archive — making the published digest depend on the daemon rather than the build. A hard equality now refuses a pushed digest that differs from the gated one.
- **Reproducibility is "same revision → same digest", not "any commit rebuilds to the pinned digest".** `/etc/qds-image.json` bakes `gitSha` and `imageRef`, and the epoch is HEAD's commit time, so all three are build inputs. Measured third data point: the identical tree built under a different tag yields `sha256:1ccee04d…`, differing *only* because the tag string reaches the marker. Consequence for the pin ritual: recording the pin is itself a commit, so re-dispatching the workflow *after* that commit builds a new revision and reports a new digest. The property that matters for supply-chain verification still holds — anyone can rebuild commit X and get digest D — but the workflow's equality gate is satisfiable only when rebuilding **at the pinned revision**. Removing that would mean taking `gitSha`/`imageRef` out of the marker, which is a change to the story-specified six-key marker contract and its tests.
- **GHCR creates packages private on first push**, and flipping to public is a manual UI step no automation can perform. The publish workflow asserts anonymous pullability and fails loudly with the settings URL rather than letting the no-credential path silently become a broken path.
- **The two runtime pins are not equally strong.** `BUN_VERSION` is checksum-pinned against an in-repo `BUN_SHA256` taken from that release's `SHASUMS256.txt`, so a substituted artifact fails the build. `PI_VERSION` is only *version*-pinned, via `exeuntu update pi --version` — there is no content hash, because the vendor updater exposes none. Closing it would mean re-deriving pi's install rather than using the vendor-supported pin point, and the Dockerfile argues explicitly against that (the vendor owns where pi lands and how the `/usr/local/bin/pi` symlink is built; re-deriving it is how gate B breaks silently). So this is vendor trust, scoped to one binary, and named here rather than left implicit in a reproducibility claim that would otherwise read as stronger than it is. Surfaced by the pre-PR adversarial self-review at sub-threshold confidence.
- The unit ships with **no `ExecStart`** (DF1.10's). It is verified at build time against a throwaway copy carrying the contract path, both deleted in the same RUN — no stub binary ships, and the verify is not weakened to accept a unit systemd would refuse to load.

### What DF1.10 inherits

The boot contract, the marker mechanism, and the pin ritual — not this digest. DF1.10 adds its engine stage, the pi catalog directory `QDS_PI_CATALOG_DIR` names, and `cli-anything/scripts/`, then re-pins through this same publish-and-record ritual. None of those three ship here; adding them would make this digest un-buildable until the engine exists. `provisionSteeringChannel` is deliberately left in place at zero diff as DF1.11's image-regression tripwire.

### E2E — live, real box, real spend

`tests/fleet/e2e/tier2-image-contract.live.test.ts`, TIER-2 gated (gates C/D/E make real OpenRouter calls, so labelling it tier-1 would have been a false zero-spend claim). **Renamed from `tier1-image-contract.live.test.ts` in round 4** — the file calls `liveGate("2")` while its prefix said tier 1, so the natural `tier1-*` sweep picked it up and red-failed with `QDS_E2E_TIER is "1", not "2"` at the *end* of a paid round. The **evidence artifact name stays `t1-image-contract`**, deliberately, so every historical evidence JSON below remains joinable to this test. Two live rounds (both under the old filename): the first failed on a test-harness defect having already proven the boot contract; the second passed end to end.

- **PASS:** `_bmad-output/evidence/df3-e2e/2026-09-01-114112-t1-image-contract.json` — `1 pass, 0 fail, 36 expect() calls, 79.00s`, run/vm `e2e-t1img-mtilhvbsc6o9`.
- **First round (boot contract proven, harness defect):** `…-113654-…json`. `store.set()` merges into an existing record rather than creating one, so the first patch died `unreadable run record …: ENOENT` before `fill`. Fixed with `store.create(runId)`. Not a product defect — every product assertion it reached passed, and re-passed identically in the green round.

**AC1(a) is MEASURED-TRUE: `--image` accepts a `@sha256:` digest.** The strong arm shipped; the AC1(b) immutable-tag fallback was not needed. This was the story's largest open premise — exe.dev documents `--image` only as "container image", its sole example is `ubuntu:22.04`, and `sha256`/`digest` appear nowhere in 9,453 lines of its docs. A box was created directly at `ghcr.io/biospark33/qds-exedev@sha256:a70674b2…` and booted.

| Proof | Observed |
|---|---|
| Boots to `multi-user.target` | `ps -p 1 -o comm=` → `systemd`; `systemctl is-system-running` → `running` (not degraded, zero failed units) |
| Answers ssh as the login user | `whoami` → `exedev` |
| Marker present and under cap | `/etc/qds-image.json`, **238 bytes** vs the 4096-byte gate cap |
| Marker `buildId` equals the repo pin | `664876fb1a9128ec` |
| Pins are the build args | `bun --version` → `1.3.13`; `pi --version` → `0.84.4` |
| **Every setup gate passes** | `ready: true`, A–E all ok. C pinged 2/2 roster models; D proved `cost.total 3.4e-05 > 0` — **real spend, so the green is genuine** |
| F14 arm on the owned pi | D's note: "custom registry absent — production-legal … rates proven by provider usage.cost", i.e. the version-conditional tolerance fired for the reviewed `0.84` series |
| **Reboot proof (AC6)** | `sudo -n reboot` exit 0 → boot id changed `94cff9f1…` → `2018dc09…` (6,708 ms, 2 attempts) → `stat -c '%a %U %G' /run/steering` = **`700 exedev exedev`**. `/run` re-read as `tmpfs` on both sides, so the directory did not survive — it was recreated by the baked `tmpfiles.d` entry alone, **with no code path having run**. Passwordless sudo covers `reboot` on the factory image (previously unverified). |

**AC7(c), the ADR's two named re-opening falsifiers — recorded, never asserted against a ceiling:**

| Falsifier | Value |
|---|---|
| Built image size | **1,716,927,372 B** (1.72 GB) vs base 1,587,298,642 B (1.59 GB) — **+129.6 MB** for pinned bun + pinned pi + the supervision assets |
| Cold-boot time | **60,458 ms `createMs` on a cold image pull**; `coldBootMs` (create-returns → first ssh) **1,824 ms** |

Honesty note on that second row: the green round measured `createMs` 5,060 / `coldBootMs` 1,204, four minutes after the first. That is exe.dev's **warm image cache**, not a faster image. The cold-pull figure of ~60 s from the first round is the honest number for the ADR; ~5 s is "second box within minutes of the first". Recording the flattering number alone would have made the falsifier unfalsifiable.

No box leaked (`ssh exe.dev ls --json` → `{"vms":[]}` before and after), and the per-run key was revoked in the `finally`.

One test-harness deviation, taken preemptively rather than after a failure: the file timeout was raised 600 s → 1,500 s because the legs' own declared budgets already summed past 600 s (create ~60 + boot 120 + fill ~120 + gate 300 + reboot 240 ≈ 900 s) and the original ceiling only survived because the gate never ran. A bun test-timeout abort is the one path that skips the `finally` — i.e. the leaked-box path. The run needed 79 s and never approached it.

### Full live round — tiers 2–5 closed out (2026-09-03, dev @ 9b5f3c2 + fix SHA 6179528)

The round the earlier entries left open. Every tier above tier-1 now has a green
run on the final SHA; TIER-1's 12/12 and `tier2-fanout-bestofn` /
`tier2-image-contract` came from the 2026-09-02 session and were not re-run.

**Substrate was probed before any paid attempt**, because the 2026-09-02 session
lost six T2.1 attempts to an exe.dev flap (link 33–68 KB/s, creates hanging
minutes). Healthy: `new` 2.09 s, first ssh 1.78 s, 6 MB pushed in 2.997 s ≈
**2.0 MB/s** — 13× the ~150 KB/s floor below which dispatch dies at its 600 s
budget regardless of #205. Zero attempts were burned against a bad window.

| Test | Evidence (`_bmad-output/evidence/df3-e2e/`) | Result |
|---|---|---|
| T2.1 dispatch-engine | `2026-09-03-120332-t2-1-dispatch-engine.json` | **PASS**, 36 expect, 127.9 s — green on the FIRST attempt after six substrate/#204 failures |
| T3.1 race | `…-120532-t3-1-fanout-race.json` | PASS |
| T3.2 manystories (2 tests) | `…-120539-…probes.json`, `…-120713-…manystories.json` | PASS |
| T3.3 expose-port | `…-120914-t3-3-expose-port.json` | PASS |
| T3.5 remote-phases | `…-121031-t3-5-remote-phases.json` | PASS |
| T3.4 reaper (2 tests) | `…-121651-t3-4a-orphan-expiry.json`, `…-121917-t3-4b-sandbox-reap.json` | PASS |
| T4 resident | `…-124559-t4-resident-live.json` | **PASS** after the manifest fix below (2 prior reds: `…-122226`, `…-123807`) |
| T5.1 gate-steering | `…-124118-t5-1-gate-steering.json` | **PASS** after the tamper-guard fix below (1 prior red: `…-122352`) |

Every green file carries `image.isRepoPin: true` with `overriddenBy: []` — the
round is provably against the repo pin `sha256:92447929…`, not an override. Every
file audited with the `phase === X && ok === false` filter: **zero `ok:false`
phases** in any green run.

**Two latent test defects found and fixed** (PR from `fix/df2.10-t4-t5-live-budget-and-tamper-guard`, commit `6179528`). Both were classified from the round's own
evidence before any code was touched, per the skill's triage protocol:

1. **T4's L2 steered leg overflowed its phase budget.** `build` attempt 1's gate
   failed in 8 ms; the `post_gate_failure` solicitation then blocked 17,972 ms on
   a real model round-trip, settling the phase at `durationMs` 17,982 against
   `maxDurationMs` 15,000 with `exitStatus: "overflow"`. The retry DF1.3 had
   authorized never ran its test command — the leg's counter file read `1` where
   the passing control leg read `2`. **The product was correct**:
   `scripts/pipeline-run.ts:1030-1039` documents the deliberate, fail-closed
   drift from DF1.3 — the code-phase gate loop shares ONE phase timer across
   command + gate + *each solicitation*, where `retry.ts` arms a fresh per-attempt
   timer. The manifest was wrong: a 15,000 ms ceiling cannot contain an in-phase
   solicitation whose own ceiling is `SOLICIT_TIMEOUT_MS` (60,000 ms), so the leg
   was green only while the model happened to answer fast — which is why it
   passed on 2026-08-30 and fails now. Fixed by sizing the budget for the real
   ceiling: `build.maxDurationMs` 15,000 → 75,000, `runBudgetMs` 160,000 →
   500,000 (`requiredBudgetMs` = 490,000), `--budget-ms` 200,000 → 600,000.
   Vindicated by the green run, whose in-phase solicit measured **16,041 ms** —
   the old ceiling would have overflowed a second time.
2. **T5's round-4 tamper guard could never pass, and would not have caught a
   tamper if it had.** Neither seed file is ever `git add`ed (commit-fix stages
   `t5_seed_calc.py` alone, and only *after* the guard), so both land untracked
   and porcelain reports `?? t5_seed_test.py` on every run; the exact-set
   assertion omitted it and red-failed a clean, well-behaved fixer run. The
   deeper defect: a judge the model had rewritten would appear in porcelain
   *identically*, as `??`, so the assertion could not detect the false-green case
   it was written for. Fixed by making the judge body one printf-escaped constant
   used twice — written into the box, then hashed there with `python3` against a
   host-computed sha256. Verified locally both ways before the paid re-run: the
   refactored seed writes byte-identical content, digests match, and a judge
   rewritten to `raise SystemExit(0)` is detected. The porcelain set is kept as
   the second half (nothing *else* moved), corrected to the three entries the box
   actually reports.

**One transient, named not chased.** T4's second red (`…-123807`) was neither of
the above: the run_start solicitation hit exactly **60,011 ms = `SOLICIT_TIMEOUT_MS`**
and the resident degraded `exitStatus: "transient"` — the host-side pi call left a
`solicit-1-prompt.txt` with no reply and no resident journal, i.e. it produced
nothing. The engine degraded fail-closed, correctly. One isolated re-run per
protocol went green with the resident **active**, 3/3 directives accepted, zero
rejections, zero tripwires. L2's exposure to an unbounded model stall is inherent
to the tier, not a regression.

**Round hygiene, all machine-checked:**

- **Spend: 11,908 µ$ = $0.0119** across all 13 evidence files, against a ~$1
  worst-case operator go. Largest single row is T5.1's 8,484 µ$; T4's green
  resident spent 1,696 µ$. Every run within its 50,000 µ$/key cap.
- **Zero boxes** — `ssh exe.dev ls` → "No VMs found" after every single file, and
  at round end. Every `final-ls` phase recorded `fleetBoxes: []`.
- **Zero key leaks** — `keyLeakProblems` runs in the `finally` of all 18 files
  that mint, so each green run already proves it; `key-hash-delta` recorded
  `ok:true, leaked:[]`. Confirmed independently at round end: exactly the 7
  expected operator keys alive (ZeroPointAI, Sift, Holly, Biospark-x-Hermes,
  Hermes-printing-press, QDS_Harness, BiosparkAI), **0 `sbx-qds-*` survivors**.
- `.sandbox/fleet.lock` absent before and after.
- **Full `bun test`: 4944 pass / 8 skip / 26 todo / 4 fail** (164 files, 1182 s).
  All 4 failures are `tests/pr/open-pr.test.ts` at ~5000 ms — bun's default
  timeout under load (measured load average 9–20 from Bitdefender, Docker
  Desktop's VM and a browser, none of them ours). **44/44 green on isolated
  re-run**, which is the real verdict. The 26 todos are the live-gated tests (24
  `todoIf(liveTodoOff())` across the 19 e2e files + 2 `QDS_EXEDEV_LIVE` ones in
  `cap-hit-demo` / `setup-gate`); of the 8 skips, 4 are located —
  `pi-lens-verify` 1, `lsp-verify` 1, `roster-check` 2 (host tool/e2e-readiness
  conditionals), the remainder being other host-conditional `skipIf`s.

### Full live round — every tier re-validated on the round-6 branch (2026-09-03, `fix/df2.10-review-round-6` @ `f52990f`)

The first round to run **all nineteen live files on one SHA**, and the round that
found two defects by running rather than by reading. Round 6 had edited all ten
tier-1 files, so tier-1 was re-run in full rather than inherited from an earlier
session.

**Substrate probed before any paid attempt** (2026-09-02's flap cost six T2.1
attempts): `new` + first ssh **1.1 s**, 6 MB pushed in 7 s ≈ **837 KB/s**, 5.6×
the ~150 KB/s floor. The window was healthy at the start; it degraded mid-round
(see transients below).

| Test | Evidence (`_bmad-output/evidence/df3-e2e/`) | Result |
|---|---|---|
| TIER-1, 12 tests over 9 files | `…-1840xx` → `…-1852xx`, T1.2 re-run `…-193931-t1-2-provision-status.json` | **PASS 12/12** |
| AC4 registry-auth | `…-184246-t1-registry-auth.json` | **PASS** after the probe-image fix below (1 prior red: `…-174826`) |
| T2.1 dispatch-engine | `…-185706-t2-1-dispatch-engine.json` | PASS |
| T2.2 fanout-bestofn | `…-194143-t2-2-fanout-bestofn.json` | **PASS** on isolated re-run (1 transient red: `…-190425`) |
| T2 image-contract | `…-190701-t1-image-contract.json` | PASS — gate B's clean control, see below |
| T3.1 race | `…-191057-t3-1-fanout-race.json` | PASS |
| T3.2 manystories (2 tests) | `…-191106-…probes.json`, `…-191427-…manystories.json` | PASS |
| T3.3 expose-port | `…-191908-t3-3-expose-port.json` | PASS |
| T3.4 reaper (2 tests) | `…-192532-t3-4a-orphan-expiry.json`, `…-192856-t3-4b-sandbox-reap.json` | PASS |
| T3.5 remote-phases | `…-193152-t3-5-remote-phases.json` | PASS |
| T4 resident | `…-193507-t4-resident-live.json` | PASS |
| T5.1 gate-steering | `…-194449-t5-1-gate-steering.json` | **PASS** on isolated re-run (1 red: `…-193705`, model nondeterminism — see below) |

Every green file carries `image.isRepoPin: true` with `overriddenBy: []`, so the
round is provably against the repo pin `sha256:92447929…`. The one exception is
honest and expected: AC4 stamps the **private mirror** ref, so `isRepoPin: false`
— the mirror is digest-identical to the pin but is not the same ref string. Every
green file audited with the `phase === X && ok === false` filter: **zero
`ok:false` phases**.

Because the image was deliberately not rebuilt this round (`oci/exedev/` is
byte-identical to `dev`, and `deriveBuildId` over the tree still derives the
pinned `3cf094fb6990ed66`), **tier2-image-contract's gate B was a clean control**:
it passed, so nothing host-side in this PR broke the image contract.

**Two defects found by running the round. Neither was introduced by PR #207;
both were making live rounds lie.** Fixed in `f52990f`.

1. **AC4's negative control could not fail honestly — it had one cold window per
   re-pin, and had been silently false-red ever since.** `privateRef` is built as
   `DEFAULT_IMAGE_REF.split("@")[1]`, so the private mirror and the PUBLIC pin are
   **the same digest**. exe.dev's host-side pull is content-addressed, so the
   first round to boot the pin warms that digest substrate-wide and every later
   *unauthenticated* create of the "private" ref short-circuits the pull and
   SUCCEEDS with no credential exercised. Measured, not inferred: **4/4
   unauthenticated creates returned a live box in 2–3 s**, against the
   **86,350 ms** cold authenticated pull of the same digest recorded on
   2026-09-02. That round passed only because the pin had moved that morning. The
   test's own comment predicted this exact reading and warned "the third such red
   is the one that gets this leg disabled."
   **Fixed** by giving the negative leg its own private image — `oci/authprobe`, a
   `FROM scratch` image that cannot boot — pinned to an unrelated digest. The fix
   rests on one invariant: **a refused pull caches nothing**, so a probe used only
   where the create must fail never enters the substrate cache and stays honest
   indefinitely. No per-round rebuild, no coupling to DF1.10's re-pin. A guard now
   refuses the run if the two legs ever share a digest again, and the ghcr privacy
   pre-flight is parameterised so **both** packages are vetted (measured: the
   probe repo's token realm answers 401 while the public pin's answers 200).
   The public pin, `DEFAULT_IMAGE_BUILD_ID` and every `deriveBuildId` input are
   untouched — `oci/authprobe/` is not a buildId input. Post-fix evidence shows
   the negative leg `threw` with `code: "create-failed"` and `listed: false`, and
   the positive leg booting the mirror to marker buildId `3cf094fb6990ed66`.
   *Honest limitation:* with the mirror's digest warm, the positive leg proves the
   flag plumbs through and boots byte-identical substrate, but does not by itself
   prove the credential was exercised on that pull. **The negative leg is what
   carries the credential proof**, and it is now the leg that cannot be faked.
2. **Every dispatching tier leaked a box when dispatch failed after creating
   one.** `dispatch` names a box before it can still fail, but all six live tiers
   bound ownership to the parsed success ack, *after* `expect(exitCode).toBe(0)`.
   On a failure `runId` stayed `""`, the `finally`'s teardown fallback is guarded
   on a non-empty runId so it never ran, and `fleetLeftovers` could not match a
   box it was never told it owned — so a **real leak was downgraded to the
   non-failing "not this run's" stray warning**. Observed for real on T3.5 this
   round: `driver.create` timed out after 60,000 ms and box
   `qds-20260903-cefc53` outlived the round (swept by hand). This is the same
   defect class as the AC4 **F1 BLOCKER** (`posCreated` set after `create()`
   returned) and is fixed the same way — **arm ownership before the assertion that
   can throw** — via a new `emittedRunId()` harness helper that reads the id from
   raw output, because the failure envelopes carry it and the ack only exists on
   the happy path. Applied to **all six** dispatching tiers, not only the one that
   failed. The stray/owned split itself is correct and was left alone; what was
   wrong is that a run never claimed what it created.

**Three transients, named not chased.** All three re-ran green in isolation, all
left zero boxes, and none is a product regression:

- **T1.2** — body PASSED; only cleanup's listing died on
  `ssh exe.dev ls exited 255: connect to host exe.dev port 22`. `settleRun`
  refused to ship it green, which is the harness working as designed.
- **T2.2** — `ssh exe.dev ls exited 255: Connection closed by remote host`, whose
  driver-supplied remediation is literally "re-run; exe.dev may be unreachable".
- **T5.1** — **not** a transport flap and **not** the round-6 filter change: the
  real fixer model created an unrequested `result.json`, which the anti-tamper
  "nothing else moved" set caught. `?? result.json` would have matched the OLD
  five-prefix allow-list identically, and `JUDGE_SHA256` matched, so the judge was
  untampered. Model nondeterminism against a deliberately strict guard.

Transport was re-probed mid-round after the second 255 and came back **6/6 clean
at 1–3 s**, i.e. the flaps are intermittent, not a sustained outage.

**Round hygiene, all machine-checked:**

- **Real model spend: 20,130 µ$ = $0.0201** across **two full rounds plus
  retries** (the whole round was re-run from scratch after the harness fix,
  because `live-harness.ts` changed and "green on the final SHA" is the bar).
  Consistent with the previous round's $0.0119 for a single pass. A further
  37,974 µ$ of `boxHours.cost_micro_usd` is the factory's **internal ledger
  estimate** at 230,000 µ$/hr, not an exe.dev invoice. Every run inside its
  50,000 µ$/key cap.
- **Zero boxes** — `ssh exe.dev ls --json` → `{"vms":[]}` after every file and at
  round end.
- **Zero key leaks** — baseline snapshot taken before the round (7 operator keys);
  identical 7 at round end, **0 new hashes**. Note the skill's roster line was
  stale: `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts` returns **17 of
  19**, not 18 — `tier1-fanout-refusal` also lacks it. Neither uncovered file
  mints a key, and the before/after snapshot covers both regardless.
- `.sandbox/fleet.lock` absent before and after.
- **Full `bun test`: 4995 pass / 24 skip / 26 todo / 0 fail** (165 files, 908 s),
  exit 0, run with nothing else in flight. Cleaner than the handoff's own
  baseline for this branch (4282 pass / 24 fail), whose 24 reds were the
  documented ~5000 ms under-load timeout signature in `tests/pr/`,
  `phase-engine/test-results`, `providers/cap-hit-demo` and `reverify/plan` —
  none of them in a DF2.10 file, and none reproduced here.
- `bunx tsc --noEmit` 0 errors and `bunx biome check tests/fleet/e2e/` clean
  after the harness change; GitNexus `detect_changes` reported **risk low, zero
  affected production processes** — every edit is confined to the live-e2e
  harness.

**One prose correction that was requested and turned out not to be needed.** The
handoff flagged "bills until someone notices" language on the leak findings as
inflated. That phrase does not appear in this story or in PR #207. The surviving
wording — "boxes already billing", "leaked billing box", "failed real-money
rounds" — is accurate: leaked boxes accrue metered CPU/memory (~$0.23/hr for
2 CPU/8 GiB), even though exe.dev Personal carries no per-VM marginal cost. No
edit was made rather than inventing one.


### Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | 0 |
| `bunx @biomejs/biome check src scripts tests` | 0 (299 files) |
| `bun test` (full suite) | 4791 tests / 159 files · **4758 pass · 8 skip · 25 todo · 0 fail**, exit 0. The pre-pin run had exactly one failure — the red-by-design sentinel asserting `DEFAULT_IMAGE_REF` is not the all-zeros placeholder — which turned green when the published digest was recorded. Nothing else in the repo regressed, which is the result that matters given `create()`'s measured blast radius below. Re-run after the attestation follow-up: **4758 pass · 0 fail**, exit 0, identical. A first attempt at load average 28–36 (Bitdefender scanning at 83 % CPU alongside a QEMU image build) produced 4 failures — `open-pr`, two gitnexus CLI spawns and a setup-gate chain, every one of them at bun's 5 s default timeout — all green on isolated re-run, and the gitnexus file passed identically with and without this follow-up's edits. That is the environmental class the live-e2e skill's gotcha #5 names, recorded rather than quietly re-run away. |
| GitNexus impact, `ExeDevDriver.create` | **HIGH** — 25 impacted symbols, 6 direct callers, 4 execution flows (`provisionAdmittedRun`, `dispatch`, `scripts/fleet.ts:run`, `scripts/cap-hit-demo.ts`). Edits are additive only (the `--image`/`--registry-auth` argv spreads, constructor validation); no signature change. Every caller now boots through the new pin, which is why AC1's fail-closed marker gate and the live boot proof are the load-bearing checks. |
| `bun scripts/build-exedev-image.ts` | exit 0 — sweep 0 packages, credential scan 0 findings |
| `docker build --platform linux/amd64` | exit 0, 1.60 GB |
| `bun scripts/build-exedev-image.ts` @ `7806bbee`, **before** the attestation follow-up | exit 0 — `builtDigest` = the published pin `sha256:a70674b2…` |
| `bun scripts/build-exedev-image.ts` @ `7806bbee`, **after** it | exit 0 — `builtDigest` **unchanged**, `buildId` `664876fb1a9128ec` |
| `actionlint .github/workflows/publish-exedev-image.yml` | 0 |
| Both new `run:` blocks, extracted from the YAML and exercised offline against stubbed `docker`/`gh` | The digest assertion: matching digest + image manifest → **0**; moved digest → **1**; **unchanged digest but an index `mediaType` → 1**, so the media-type arm is load-bearing on its own rather than a second spelling of the digest check. The verify loop: all-green → 2 `gh` calls (one per store) and exit 0; two transient failures → 4 calls, exit 0; permanent failure → 5 calls, exit 1. The all-green case is the regression test for a bug this follow-up wrote and caught — `[ … ] && args+=(…)` under `set -e` aborts the step on the *false* branch, which would have failed the GitHub-store leg every single run. |
| `zizmor --offline` on the same file | 4 `unpinned-uses` findings, **all pre-existing policy drift**: zizmor's blanket policy wants SHA pins, and every action in this repo is major-tagged (`actions/checkout@v7`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`). The added `actions/attest-build-provenance@v4` follows that convention rather than diverging from it inside one step. No injection, credential-persistence or permissions finding — the new steps take no event-controlled input. |
| In-image, bare non-login `sh -c` | `bun --version` = 1.3.13 · `pi --version` = 0.84.4 |

## Review Findings — round 1 (2026-09-01, PR #184)

Nine parallel reviewers over a chunked diff (4 blind adversarial with zero repo access, 4 edge-case hunters with repo read, 1 acceptance auditor against this file). ~156 raw findings → **118 patched, 9 deferred, 8 dismissed as verified-false** after dedupe. Every dismissal was checked against real source before being dropped; every reviewer line number was re-located in the real file before a fixer acted on it. (Counts follow the triage ledger's grouping — `_bmad-output/workflow-state/code-review/pr184/round1-triage.md`, D-1..D-9 and X1..X8; the prose below also lists half-deferred remainders that live in patch clusters, so enumerating the bullets yields more items than the headline numbers.)

Gates after the round: `bunx tsc --noEmit` 0 · `bunx @biomejs/biome check src scripts tests oci` 0 (307 files) · `actionlint` 0 · `shellcheck -S warning assertions-in-box.sh` 0 · `bun test` **4861 pass / 8 skip / 25 todo / 7 fail** across 162 files, and all 7 are the documented load class — `git`/`gitnexus` subprocess spawns aborting at bun's 5 s default in files this PR does not touch, **133/133 green on isolated re-run**. Net new tests this round: +103.

### The three that were real defects, not polish

- [x] **[Review][Patch] Gate B0 could THROW out of `setupGate`, converting an exit-3 gate refusal into an exit-1 `dispatch-failed`** [`src/providers/exedev/setup-gate.ts` — B0/`readBoxFile`, ~:476-512 after the round-2 edits; :440 in the reviewed diff] — `readBoxFile` bounds its execs with `withTimeout`, which *rejects*; every other assertion uses `execTimed`, which returns a non-zero result and never throws. The module header's "failure RETURNS a payload" claim and the in-code "never a throw" comment were both false for the one step this story added. `dispatch.ts` never received a result object, so `extensions.gate` was never written either — the same regression `dispatch.ts:2911-2917` records having already fixed once for a different unguarded read.
- [x] **[Review][Patch] The AC5 licence gate could pass an unswept npm tree** [`scripts/build-exedev-image.ts` — `extractNodeModules`, ~:1063-1072 after the round-2 edits; :679,683 in the reviewed diff] — `extractNodeModules` used `docker cp` without `-L`, so a symlinked package landed as a dangling symlink, which `scripts/lib/license-sweep.ts` (~:290-300) classifies as `unreadable` rather than an entry; `treePackageCount` then reads 0 and the `> 0` gate passes. The sibling `inspectConfigs` already used `-L` and documented why. Compounding it, `sweep.unreadable` / `unresolved` / `missingTexts` — all three documented by DF2.9 as fail-closed signals — were read nowhere.
- [x] **[Review][Patch] AC4's ratified-deviation gate did not exist** [`src/providers/exedev/driver.ts`] — the private-registry path shipped fully wired and reachable with nothing but a shape check between an operator and a credential in ssh argv. New exported `assertRegistryAuthDeviation(postureFile)` refuses unless a record naming `read:packages` scope, a live expiry and a rotation owner is present, on the same `postureFile` seam `setPublic` already reads. The test suite had *inverted* this AC: a test titled "the ratified D8 deviation" whose comment said the path "requires a recorded ratification" constructed with no attestation and asserted success.

### Patched — by cluster

- [x] **[Review][Patch] CI/workflow — 14 items** [`.github/workflows/publish-exedev-image.yml`, `.github/dependabot.yml`] — the NOTICE was never uploaded (workflow `BUILD_DIR` was `oci/exedev/.build`, the script's is `oci/.build/exedev`; repointing it also dissolved an un-gitignored scratch dir); `package.json` added to both `on.push.paths` and `SOURCE_PATHS` (it is a `deriveBuildId` input via `readBunPin`, so a bun bump moved the digest while stamping a *different* revision's sha into the marker); `driver.ts` added to `on.push.paths` so a re-pin commit can clear a red branch; the pin-read step's `grep|head|sed` died under `set -euo pipefail` before printing the diagnostic it exists to print; the 403 registry explainer fired for sweep/scan/OOM failures and overwrote the real cause; `jq -r`→`jq -er`; the anonymous-pull probe gained `--max-time`/`--retry` and a distinct arm for `code=000`; `IMAGE_PATH` derived rather than duplicated; forks fail in seconds instead of after a full build; a missing marker no longer fails with a bare `cat` error; the sentinel pin is now detected and can never go green.
- [x] **[Review][Patch] Build script — 24 items** (the triage cluster counts 25; its extra item lives in `tests/scripts/exedev-bun-pin.test.ts`, outside this bullet's bracket) [`scripts/build-exedev-image.ts`] — `imageSourceSha()` returned the literal `"unknown"` its own docblock forbids (and the Dockerfile's `-n` guard accepted); `--tag` was spliced unvalidated into buildx's `--output` CSV, where a comma injects exporter attributes including `push=true` into the *pre-gate* build; `runtimeBaseRef` took the last `FROM` and so picked the builder, not the runtime base, for the multi-stage shape DF1.10 adds; `die()` is `process.exit` so every `finally` was skipped, leaking containers, temp trees and a 1.6 GB archive; `containerimage.digest` was read as one flat key from a two-exporter solve; the base digest was resolved three independent times against a floating tag; a pre-existing `qds-repro` on the wrong driver was silently accepted; a stale `RepoDigests` fallback could report a registry read failure as a supply-chain compromise; exit-code contract violations (a missing input or a failed `writeJson` reported as *compliance* failure); plus the `SECRET_ENV` loop, the prose-matched sweep error, `argv.includes` flag parsing, newline-bearing tar paths, hardcoded `/usr/bin/find`, `SOURCE_DATE_EPOCH=0`, and a build-time binding of `PI_VERSION`/`BUN_VERSION` to the Dockerfile's `ARG` defaults so a `packageManager` bump fails in one second rather than ten QEMU-emulated minutes into a `sha256sum` mismatch.
- [x] **[Review][Patch] Driver — 13 items** [`src/providers/exedev/driver.ts`] — a *thrown* (not non-zero) `control()` leaked the registry credential unredacted with no `create_failed` emit; the credential file's 0600 mode was asserted in prose three times and checked nowhere; `QDS_EXEDEV_IMAGE` and `QDS_EXEDEV_IMAGE_BUILD_ID` were read independently, so setting either alone failed *every* box at gate B with a misleading message; `exeDevDriverFromEnv` spread `...opts` first, letting the environment silently beat an explicit caller argument; `redactRegistryAuth` matched only the exact `USER:PASS` pair; `create_failed` — the event a boot regression is diagnosed from — omitted `imageDigest`, the join key; `#` added to the metacharacter denylist (it truncates the remote command line and surfaces as `new-unparseable`); `imageBuildId` validated; a warning event when the effective image is not digest-pinned; and the remediation example lowercased, since its own regex rejected the uppercase it suggested.
- [x] **[Review][Patch] Gate — 11 items** [`transport.ts`, `setup-gate.ts`, `assertions-in-box.sh`] — B0 reported ssh exit 255/137 as "this box did not boot a factory image", a definitive claim about image identity drawn from evidence that cannot support it (the sibling `steeringProvisionFailure` already branches on exactly those codes for exactly this reason); **AC1c** restored — `imageMarkerFailure` now returns `{ code, message, remediation }` instead of a flattened string, so `image-marker-mismatch` reaches a production caller for the first time, and `debugCommands` gained the `cat /etc/qds-image.json` it was missing; `readBoxFile` prefers `execTimed` so the gate budget kills the ssh rather than `withTimeout` abandoning it for 120 s; the unreviewed-pi-series refusal hoisted **above** assertion C and D's paid provider call (it is a pure string comparison that was costing real spend on every box before refusing); a distinct arm for a `pi` that cannot report a version at all; box-controlled marker text `JSON.stringify`d before it reaches a log; the 4 KiB cap counted in bytes rather than UTF-16 code units and its boundary aligned with the Dockerfile that produces it.
- [x] **[Review][Patch] `binary-licenses.json`** — attributed `bunx`, which the Dockerfile never installs (one `install` of a single file, no symlink); and the `$comment`'s "every `spdxId` must resolve to a canonical text" was an overclaim — `validateBinaryLicenses` resolves text for top-level entries only, which is what lets the `bundled[]` LGPL and `NOASSERTION` rows exist with no text checked in. Both corrected; the scope is now stated, along with the fact that `NOASSERTION` is *not* enforced the way `UNVERIFIED` is.

### Test hardening — the suite could not have caught several of these

- [x] **[Review][Patch] `deriveBuildId` had zero tests** [new `tests/scripts/build-exedev-image.test.ts`, 72 tests] — it mints the identity gate B enforces. (Round-2 correction: the workflow does NOT compute either side of its "pushed buildId == repo pin" check with this function — it greps the pasted constant out of driver.ts and reads the baked marker; these unit tests are the only check on the derivation, which is what makes them load-bearing.) Now covered by determinism, set-not-sequence, a one-field-changed row per input, and the length-framing property — **and the coverage is mutation-proven**: dropping `systemdFiles` from the hash reddens 5 tests, dropping the length prefix 1, dropping `baseDigests` 2, dropping the `.sort()`s 1. Five of six exported functions in that 1 200-line file were previously untested.
- [x] **[Review][Patch] AC6's stated negative control had no test** [new `tests/providers/exedev/image-assets.test.ts`] — `grep -rn "qds-run@" tests/ scripts/ src/` returned nothing. `systemd-analyze verify` passes `Restart=on-failure`, `%h/app/.env` and `User=root` cleanly, so the one directive whose wrong value causes double-spend and double-commit was guarded by review alone. Now a real unit parser (fold continuations, section-qualify, last-wins) driven by a 15-row mutation table — including the case a naive `content.includes("Restart=no")` passes: a *later* `Restart=on-failure` that systemd's last-wins semantics make live.
- [x] **[Review][Patch] Vacuous and unfailable assertions across the unit suite** [`image-contract.test.ts`, `fixtures/fake-exedev.ts`] — `captureLog` swallowed the thunk's exception while two tests bound only `{ lines }`, so a `create()` that threw left every remaining assertion vacuously true; `newArgv()` returned `[]` when nothing reached the seam, making every `.not.toContain` absence claim pass on a driver that never ran; `fake.creates[0]?.` optional chaining re-admitted the exact case the array was added to catch; the fake fell through to the **host's** `/etc` for any verb but `test -f`/`cat`; the fail-closed table's `why` regexes were supersets of each other, so one generic note would have passed all six arms; and the fake hand-copied `piVersion`/`bunVersion` beside an imported `buildId`. All closed, and the previously unreachable `unreadable`/`oversized`/transport-fault arms are now reachable and covered.
- [x] **[Review][Patch] Live e2e could leak a real box and a live key** [`tier2-image-contract.live.test.ts`, then named `tier1-image-contract…`] — `revokeQuietly` reads the run record *outside* its own try (`live-harness.ts:484` in the reviewed diff; the read now sits INSIDE the try — round 2, `b45b72f`), so a missing or half-written record threw straight out of the `finally` and `destroyQuietly` never ran; both siblings already guard this and this file was the one that did not. The revoke was gated on a local `mintedHash` rather than on the store, skipping revocation in the window where `mintRunKey` has already persisted a spendable key and then throws. `writeEvidence` throwing in `finally` replaced the real failure; a failed destroy still reported green. Destroy now runs **first** (the box is the uncapped leak; the key is capped at 50 000 µ$), every step is individually guarded, and the full ordered teardown trace is recorded in the round's report.
- [x] **[Review][Patch] The `PI_REVIEWED_SERIES` alarm was deaf** [`setup-gate.test.ts`] — four hand-typed copies of the pinned pi version existed with nothing binding them, and both pi tests re-typed their expected version in their own stub. A bump would leave CI green while every real box refused assertion D — precisely the failure AC2 exists to prevent. `PI_VERSION` is now imported and the shell constant asserted against it, with both shims derived rather than literal.
- [x] **[Review][Patch] Five pre-existing load flakes fixed** [`setup-gate.test.ts`] — reproduced at pristine HEAD (41 pass / 5 fail) and now 50 / 0. The proportional-widening fix was tried first and **failed on its first run**: round-4's condition is `0 < budget − real elapsed < 1000`, so tax and budget cancel and the tolerance stays 1 000 ms wide regardless. The instrument that holds states the condition directly — burn the clock down to a known remaining time — with a guard that fails loudly if a seam call is added or removed ahead of C/D/E.

### Decision-needed — resolved conservatively (fail-safe), listed for ratification

Six ambiguities were resolved without halting, each toward the safer direction. Each is a one-line change if the fleet disagrees.

1. **The tag is a digest input** (`--build-arg QDS_IMAGE_REF=${opts.tag}` reaches the marker, so the digest is a function of `--tag`). Fixing it properly means removing the ref from the marker (#187's direction) — **which invalidates the pin that was live-booted and proven in this PR's e2e round**. Kept the behaviour; the workflow's mismatch message now names the cause so a moved digest is not read as tampering. *This is why the workflow's first real run will fail its gate and require a re-pin — the hand-pushed pin was built under `:df2-10`, the workflow builds under `:sha-<src_sha>`.* (Round-2 correction: the previously-recorded second reversal option — "adding the tag to `deriveBuildId`" — is REJECTED, not merely unchosen: the publish tag is `:sha-<src_sha>`, so folding it in would churn the buildId on every source commit, destroying the "buildId proves substrate, not build" invariant gate B and the D7 mirror posture both depend on.)
2. **The push precedes the gate**, so the gate reports rather than refuses. Kept — but the originally recorded reason ("a digest cannot be compared before it exists") is false by the repo's own machinery: the build script's second exporter exists precisely to measure the manifest digest pre-push, and the pin comment records two local pre-push builds agreeing with the registry read-back. The honest reasons, now in the workflow comment (round 2): pre-push gating buys little (the pin, not the gate, protects production), push-first keeps the bootstrap ritual one-pass, and the post-push REGISTRY read-back is the strongest read. Production is protected by the pin; the *package* accumulates unreferenced per-revision tags.
3. **`--image` is an unconditional spread** where AC3 says "conditional". Kept unconditional: always-pinned is fail-safe, and a conditional spread reintroduces an unpinned boot path. The wording was corrected instead.
4. **Gate B does not compare `marker.imageRef`.** Kept — a D7 tenant mirror keeps the digest and buildId but not the ref. The decision is now executable: a test asserts a mismatched ref with a correct buildId **passes**.
5. **`scripts/build-exedev-image.ts` stays in `SOURCE_PATHS`** despite `.dockerignore` excluding it from the build context, so a comment-only edit re-pins. Its constants are build args; over-triggering is the safe direction. Cost documented.
6. **AC5 coverage tightened from path to path+content** — `added = builtBins \ baseBins` was a path-set difference, so a binary replaced *in place* (which is exactly what `exeuntu update pi` does) never entered `added` and was never attributed. Now a `path+sha256` difference. The failure direction is "more binaries need attributing", never fewer.

   **MEASURED after the round, so this is not left as a warning.** A full local build (`bun scripts/build-exedev-image.ts`, no `--push`) exits **0**: `addedBinaries: ["usr/local/bin/bun"]`, one entry, covered. **No newly-uncovered executables.** The reason is worth recording, because it is not "the change did nothing": the 2026-08-31 probe measured the base exeuntu as already shipping a compiled pi **0.84.4**, and `PI_VERSION` pins that same 0.84.4 — so `exeuntu update pi --version 0.84.4` re-installs byte-identical content and correctly does not register as added. The tightened diff will fire the first time `PI_VERSION` diverges from whatever the base ships, which is precisely the day it should. The `pi` entry in `binary-licenses.json` remains the right attribution to hold (the pin is ours even when the bytes match), and the table's own "Known ceiling" paragraph documents this exact case.

### Deferred — real, with a reason

- [x] **[Review][Defer] Five image-content findings, all blocked on the same fact** — `deriveBuildId` hashes the Dockerfile bytes and the systemd unit bytes, so **any** edit moves the buildId, moves the digest, and invalidates the live-booted pin. DF1.10 adds the engine build stage to this same Dockerfile and re-pins; that is the correct moment. Deferred: pi installs with no checksum while bun is `sha256sum -c`'d · the unit's `After=` is not `Requires=` and `EnvironmentFile=` has no `-` prefix · no cheap systemd hardening (`NoNewPrivileges`, `PrivateTmp`, `TimeoutStopSec`), `%i` unquoted in the `ExecStart` contract comment, and an `[Install]` stanza on a unit systemd currently refuses · AC6's "complete set of surfaces" omits `DefaultEnvironment=`, `/etc/systemd/system.conf.d/` and unit drop-in dirs · dependabot cannot bump a digest-only `FROM` (fix is one token, `exeuntu:latest@sha256:…`). The dependabot **comment** was corrected in-round to say the entry is dormant until then, so "no PR" is not mistaken for "no upstream change". `image-assets.test.ts` guards the AC6 hole rather than the scan, so widening the greps later cannot break a test.
- [x] **[Review][Defer] `uncoveredBinaries` matches on `path.basename`** — a new `/opt/vendor/bash` reads as covered by an entry naming `bash`. Closing it requires `binary-licenses.json`'s `names[]` to become paths, and the real installed paths cannot be enumerated without a build. Pinned by a named `KNOWN CEILING` test so the fix must land at that line.
- [x] **[Review][Defer] `parseBaseRefs` ignores `COPY --from=<external image>`** — a foreign image would contribute bytes to the substrate and nothing to the buildId. No such `COPY` exists today; pinned by a named `KNOWN GAP` test.
- [x] **[Review][Defer] Major-tag action pins, no `environment:` approval on publish, no consumer-side attestation verification** — respectively a repo-wide convention (DF2.9's record documents the v7 downgrade scar), a change that would block the documented bootstrap ritual, and out of DF2.10's scope with no AC behind it.
- [x] **[Review][Defer→DISCHARGED in round 2] `revokeQuietly`/`destroyQuietly` root causes lived in `live-harness.ts`** — fixed on this same branch (`b45b72f` + the round-2 verdict wave): the record read is inside `revokeQuietly`'s try, the three per-caller guards are deleted, `destroyQuietly` returns an assertable verdict, `preflight` builds the production factory's driver, and every live caller now asserts destroy/leak verdicts AFTER its finally. #189 closes with this round.
- [x] **[Review][Defer→DISCHARGED in round 2] `boot_ready_ms`** — emitted at gate A (`setup-gate.ts`, commit `f10880c`), exactly the honest measurement point this bullet named: gate entry to assertion A settling, ≥ 1 ms on a pass, 0 on a failed A. The Observability Contract above records the carrier and semantics.

### Dismissed — verified false against real source

`assertions-in-box.sh`'s new refusal colliding with the pass-matcher (the real `case` arms are `*"custom registry absent"*` and `*" models priced"`; the refusal matches neither) · `pi --version` parsed two contradictory ways (real output is bare `0.84.4`; both spellings agree) · `readFileSync` used with no import (present at `driver.ts:28`) · four SKILL.md claims, all confirmed correct by running the documented greps (`liveGate` checks six env vars and never opens the roster; every tier argument in the table matches) · a dependabot `github-actions` entry claimed missing (it exists) · `remediation.includes(secret)` claimed to be element-equality (`ProviderError.remediation` is `readonly remediation: string`, so `.includes` is substring containment and the original assertion was right — a serialized-form assertion was added beside it anyway) · two `B0` budget findings refuted by `budgetFree()`'s 1 000 ms floor and by assertion A also making two calls per budget.

### Known limitations this round did not change

The publish workflow has still never executed and the pinned image was still pushed by hand — unchanged from the Dev Agent Record's own disclosure. The workflow's first dispatch will fail its gate and force a re-pin (see decision 1), and the ~190-line `attest` job remains the least-exercised code in the PR.

### Deferred work — tracked issues (round 1)

Every deferred item above is now an issue with its own acceptance checklist, so none of it depends on someone re-reading this section. Three of them are discharged by **DF1.10's re-pin** and are cross-referenced from that story's Technical Notes and Definition of Done.

| Issue | Covers | Closes when |
|---|---|---|
| [#186](https://github.com/biospark33/QDS-Factory/issues/186) — re-pin bundle (DF1.10 seam) | pi's missing checksum · `After=` vs `Requires=` · `EnvironmentFile=` `-` prefix · systemd hardening · `TimeoutStopSec`/`KillMode` · unquoted `%i` in the `ExecStart` contract · `[Install]` on a unit systemd refuses · AC6's incomplete surface list · dependabot's dormant digest-only `FROM` | DF1.10 re-pins |
| [#187](https://github.com/biospark33/QDS-Factory/issues/187) — the build tag is a digest input | `imageRef` is baked into the marker and therefore into the digest, while `deriveBuildId` excludes it. The publish workflow's first run cannot match the hand-built pin, and gate B is blind to the difference. Highest-value item in the bundle; `marker.imageRef` is reported and never compared (`transport.ts:360`), so the field costs reproducibility and buys nothing enforceable. | DF1.10 re-pins |
| [#188](https://github.com/biospark33/QDS-Factory/issues/188) — AC5 attribution by basename | `uncoveredBinaries` matches on `path.basename`, so `/opt/vendor/bash` reads as covered by an entry naming `bash`. Needs a build to enumerate real installed paths. Pinned by a `KNOWN CEILING` test so the fix must land at that line. | DF1.10 re-pins |
| [#189](https://github.com/biospark33/QDS-Factory/issues/189) — live-harness teardown | **CLOSED by round 2 on this branch**: `store.get` moved inside `revokeQuietly`'s try (guards deleted), `destroyQuietly` returns an assertable verdict (every live caller now asserts it post-finally), `preflight` builds `exeDevDriverFromEnv()` — the factory production registers — making the repo-pin assertions falsifiable and giving the credential path live coverage. | closed (round 2) |
| [#190](https://github.com/biospark33/QDS-Factory/issues/190) — publish supply-chain posture | Nothing verifies the attestation the `attest` job produces (a genuine future seam — no consumer exists); actions are major-tagged rather than SHA-pinned (repo-wide convention, and DF2.9's record carries a false-premise scar here — **check the release list before acting on any version claim**); `workflow_dispatch` from any branch publishes with no `environment:` approval. Three policy decisions needing an owner. | decision, not code |

### Filed later — from DF1.10's review round 1 (2026-09-04, PR #216)

Two findings from DF1.10's round 1 land on **this** story, because they are properties this story
claimed and no longer holds.

| Issue | Covers | Closes when |
|---|---|---|
| [#223](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/223) — **AC5 amendment** | DF1.10 deviation **C37** narrowed AC5's "no npm tree in the image at all" to "one tree, at `opt/qds-factory/node_modules`, by exact path". The unbundled-source route (DF1.10 AC2a) needs it: `.ts` source in-box has to resolve `yaml` and `zod`. The narrowing is tight — two packages copied by name, `--frozen-lockfile`, and an in-Dockerfile count probe that fails the build on a third — and it is disclosed in DF1.10's Dev Agent Record, but **AC5 above still reads as an absolute**, so anyone auditing the image against this merged story finds an intended violation. | **CLOSED (2026-09-05, DF1.10 round 3.5)**: the amendment now sits on AC5 itself, above |
| [#218](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/218) — **the shipped pin is CI-unproven** | This story's headline property for `DEFAULT_IMAGE_REF` was that it is the first pin the repository did not push by hand. The pin that ships today (`sha256:8cdcfe84…` / `c2b0c0f0531078e1`) was hand-pushed from a developer machine during DF1.10's live rounds — three re-pins in one sitting — so the publish workflow's digest↔buildId equality gate has **never run end to end against the digest that ships**. The property has been given back. | the next CI publish from `dev`/`main` satisfies gate B against the shipping digest (discharges by construction; #187 is the same gate for a different reason) |

Two items were deliberately **not** filed. `parseBaseRefs` ignoring `COPY --from=<image>` is speculative — no such `COPY` exists — and is pinned by a named `KNOWN GAP` test rather than tracked as work. "The workflow has never executed" self-resolves on its first run.

One item was deferred in round 1 for a reason that does not survive scrutiny and is **not** in the table: `boot_ready_ms` (named in the Observability Contract, then present nowhere in the repo). The fixer that owned `driver.ts` correctly refused to invent the measurement there — `create()` returns when the substrate has *named* the VM, strictly before it is bootable — but the honest measurement point is gate A in `setup-gate.ts`, and the item was never routed to the agent that owned that file. That was a gap in how the round was partitioned, not a property of the code — **discharged in round 2** (`f10880c`, gate A emission).

## Review Findings — round 2 (2026-09-01, PR #184) — aimed at round 1's blind spots

Thirteen parallel reviewers, targeted NOT at the original diff but at the places round 1 was most
likely to be wrong: the ~3,900 lines round 1's own fixers wrote (which no reviewer had seen), the
8 dismissals' refutations, the 6 conservative decisions, cross-agent seams, and round 1's story
edits. 6 blind hunters over a re-chunked `41cb8dd..HEAD` diff (22/22 files, every chunk ≤ 1,924
lines), 2 edge-case hunters with repo read, 1 acceptance auditor, 1 dismissal verifier, 1 decision
challenger, 1 seam auditor, 1 docs-integrity reviewer. Full reports:
`_bmad-output/workflow-state/code-review/pr184/round2-reports/` (copied from /tmp).

**Round 1's judgment held where it claimed certainty**: all 8 dismissals' refutations verified
intact (the dismissal verifier checked premises, not findings — several came back *stronger* than
recorded); all 6 conservative decisions RIGHT or RIGHT-BUT-INCOMPLETE, 0 WRONG (the incomplete
parts were doc/comment-level and are corrected in this round, including striking the
tag-into-`deriveBuildId` reversal option as rejected and correcting decision 2's false
"cannot compare pre-push" rationale).

**Where round 1 was genuinely wrong or incomplete — the headline fixes:**

- [x] **#189's fix was one-caller-deep** [seams F1, HIGH] — the harness returned an assertable
  destroy verdict, but 8 untouched live tests discarded it AND their final leak assertions sat
  inside try/catches that swallowed the AssertionError, so a leaked billing box still shipped a
  green test in every paid tier. Every live caller (tier2/3/4/5 + both approval-gate tests) now
  accumulates destroy verdicts and asserts them AFTER its finally, outside every catch; the leak
  expectations were hoisted out of their swallowing catches; tier2-image-contract asserts
  `finally-revoke ok:false` entries; tier3-expose-port's sweep skips record-less boxes so that
  entry stays a real alarm.
- [x] **The publish workflow's gate broke on its own success path** [blind-ci F1, HIGH] — `2>&1`
  fed docker pull chatter into `jq`. Restructured: quiet pull with its own failure arm; stderr
  captured separately; jq sees only stdout.
- [x] **`assertRegistryAuthDeviation` hardened** — scope arm now refuses any scope beside
  `read:packages` (was membership, passing `admin:org, read:packages`); expiry grammar is strict
  ISO-8601 date or offset-carrying date-time (was bare `Date.parse`, host-timezone-dependent);
  the deviation is re-asserted on EVERY `create()` (was construction-only — the "PAT expires
  mid-fleet" case the arm's own comment advertised catching was the one it couldn't); the auth
  file is opened once and judged by fd (`O_NONBLOCK` + `isFile()` + mode + owner — a FIFO used to
  hang the factory forever, and the stat→read swap window is gone); a JSON parse error no longer
  echoes file content into the refusal.
- [x] **Marker/transport classification corrected** — a cap-killed oversized marker no longer
  reads as a retryable transport fault (`truncated` checked before exit code); `absent` requires
  probe exit 1, other exits (143, 126) are transport; B0's catch no longer converts host-side
  code bugs into "re-create the box" and no longer claims a budget timeout it cannot know.
- [x] **Build script** — signal/exit handlers no longer install as import side effects (and the
  docblock now states honestly that a sync main only observes signals between spawns); an
  age-gated startup sweep reclaims `run-*` debris from SIGKILL/OOM deaths; `assertCid`'s failure
  path no longer strands the container it just created; `deriveBuildId` sorts with a
  locale-independent comparator and hashes raw bytes (buildId proven unchanged:
  `664876fb1a9128ec` before and after); the EISDIR carve-out no longer fail-opens the credential
  gate (directories by candidate names are walked and content-judged); `TAG_RE` refuses
  digest-only tags and finally has an accept/reject table; `-push`/positional argv typos are
  refused; `tarUnescape` handles astral code points and dies on unknown escape pairs;
  `fromInstructions` refuses heredocs/continued FROMs until taught them; self-named stages no
  longer report as cycles.
- [x] **Workflow supply-chain honesty** — bootstrap arm no longer claims "nothing was
  compromised" (first-trust is now labeled first-trust, with an out-of-band verification
  instruction); the sentinel spelling is cross-checked against the driver's declaration; pin
  greps are declaration-anchored and count-checked; owner-scoped repo guard; NOTICE upload
  errors instead of warning, with a BUILD_DIR cross-check step; artifact names carry
  `run_attempt`; "re-run" ambiguity in the adoption text resolved (push triggers the healing
  run; re-running the old run fails forever).
- [x] **Test-suite falsifiability** — ~20 unfailable/miscalibrated assertions fixed across the
  unit suites (canary that existed in no input, boolean-agreement instead of identity, helper
  compared to itself, umask-dependent fixture modes, "password" as a scrub secret, tautological
  cross-checks, comment-blind Dockerfile greps, first-match source regexes); the fake now
  mirrors real stderr shapes (a SIGKILLed process writes nothing; `test -f` misses silently) and
  serves truncated markers as unparseable prefixes; its never-fall-through guard throws at the
  seam instead of returning a classifiable exit.
- [x] **Story/text truthfulness** — AC3's three "conditional spread" phrasings corrected; the
  Observability Contract now lists the full emitted code/event surface and the real `vm`-based
  join key; `boot_ready_ms` semantics recorded (≥ 1 ms clamp, gate_a carrier); stale line refs
  and count mismatches reconciled; the DF1.10 cross-reference no longer claims #188 shares
  #186/#187's blocker.

### Ratification additions (round 2) — same fail-safe posture as round 1's six

7. **AC4 scope exclusivity**: the gate refuses a deviation record naming ANY scope besides
   `read:packages` — strictly stronger than AC4's literal "naming" terms. Reversal: relax the
   token check back to membership (one line).
8. **AC4 expiry grammar + liveness**: expiry must be `YYYY-MM-DD` (UTC) or a date-time carrying
   `Z`/offset, machine-parseable, and in the future — round 1 shipped the liveness half without
   listing it here (auditor F2); this entry ratifies all three terms together. Reversal: drop the
   grammar regex / the `<= now` refusal (one line each).
9. **AC4 per-create re-assertion**: the deviation is re-checked on every `create()`, so a
   ratification lapse stops the fleet at the next box create with the typed refusal instead of
   a mid-fleet mystery. Reversal: delete the one call in `create()`.

### Round-2 deferrals (new)

- ~~`src/fleet/fanout-primitive.ts` `probeArm` ignores the new `probeExit` discriminator — an
  ssh-255 probe still resets the corruption streak as if the marker were verified absent
  (edge-src F7, second half). Out of this PR's clusters; needs a fleet fix or issue.~~
  **SUPERSEDED — this deferral is false and is left standing only so the history reads
  correctly.** The fix landed on this PR anyway: round 3 (`c52f4d0`) taught `probeArm` the
  probe-exit discriminator, and round 4 (finding D1) closed the half that made the change deliver
  what its own comment claimed — the skip was classified but never *counted*, so a permanently
  dead arm still spun the race to its 1 h ceiling holding the fleet lock. The full record,
  including the `readBoxFile` `execTimed` change that rides with it and the complete caller
  surface, is **deviation 7** above. Nobody decided to reverse this deferral; a fixer in a
  different cluster edited the file and the deferral text was never revisited — which is exactly
  the failure mode the round-4 acceptance auditor was looking for.
- The weekly-red desensitization of the digest gate (blind-ci F7) is a consequence of the tag/
  epoch being digest inputs — #187 territory; the gate message now says so.
- `exeDevDriverFromEnv(env, { image: undefined })` — an opts key EXPLICITLY set to undefined
  still clobbers the env value via spread (blind-src F8 secondary). Requires deliberate caller
  construction; recorded, not guarded.

### What remains unproven on the substrate (unchanged by this round — the live round is next)

The AC4 private-registry path has never run against real exe.dev (`registry-auth` appears zero
times in live evidence); the publish workflow has never executed (first dispatch fails its gate
by construction — read #187 first); B0's transport-fault arm is proven only through the fake's
knobs; the live e2e never runs in CI.

### Round-2 live round (2026-09-01, real exe.dev, evidence per leg in `_bmad-output/evidence/df3-e2e/`)

- **T1.4 teardown** (free): 2 pass first try — the reworked verdict discipline holds on real substrate.
- **T1.7/D8 approval gate** (free): first run since DF3.4 rounds 6–10 landed, and it caught **two latent
  test defects only live substrate could expose** — the allowlist lived at the pre-C10 root
  (`approver-allowlist-dir-mode` refusal), and the demo paused an unfilled run that INV-APPROVE-6
  makes undecidable by design (`its harvested bundle is gone`). Fixed to the real contracts
  (allowlist under `--dir`; fill → real commit → `harvestRun` → pause with `bundleDir` passed) —
  the demo is now strictly more production-shaped than the one that used to pass. 2 pass / 83
  expects after the fix (`16a2cb5`); both failures were classified from the evidence JSON's own
  refusal envelopes, per the skill's triage protocol.
- **tier2-image-contract** (PAID, TIER-2, operator-approved; the file was still named `tier1-image-contract` when this ran): full re-proof on the round-2 code —
  factory-built driver (env preflight), all five gates ready, real reboot with a changed boot id,
  AC6 negative control now asserting stat's clean-miss exit 1 (the round-2 tightening), destroy
  verified, key revoked. 1 pass / 36 expects, 93 s wall (warm image cache, createMs 4.1 s).
- **verify-image-pin** executed for real on this PR (pull_request trigger) and passed via the
  audited exception register — the attestation consumer is proven, not merely written.
- **Publish workflow first execution**: `workflow_dispatch` requires the file on the DEFAULT
  branch (GitHub's rule), so a pre-merge dispatch is impossible. The first real execution fires
  automatically on merge-to-dev (push trigger, `oci/exedev/**` in the merge) and will go red at
  the digest gate BY CONSTRUCTION (#187) — expected, documented in the gate's own message, and
  routed through the `publish-exedev` environment (server-side branch policy: dev/main only).
- **Final sweep**: `ssh exe.dev ls --json` → zero boxes, zero `e2e-*`/`qds-*` leftovers; every
  minted key revoked with the delta assertions green.
- **AC4 registry-auth** (tier-1, boxes only — the arm that had NEVER touched real exe.dev):
  `tier1-registry-auth.live.test.ts` GREEN (evidence `2026-09-01-234604-t1-registry-auth.json`).
  The negative control answered decision 3's open question: `ssh exe.dev new` on an
  unauthenticated private image THROWS and names no box. The positive leg pulled the private
  mirror through `--registry-auth` via the production env factory with an operator-ratified
  posture record (scope `read:packages` only, 7-day expiry), booted it in 61.7 s, and the box
  proved the pinned buildId — while its marker still names the PUBLIC repo, the live proof that
  a digest-preserving mirror keeps everything gate B enforces. Credential: zero occurrences in
  evidence (scrub verified); PAT revoked post-round. AC4 is no longer fixture-only.

## Review Findings — round 4 (2026-09-02, PR #184) — the widest diff yet, and the tier-1 files no round had opened

Fourteen parallel reviewers over an 11-chunk diff: **6 blind adversarial with zero repo access, 7
edge-case hunters with repo read, 1 acceptance auditor** against this file, covering **11,995 lines
of code diff** (`_bmad-output/` artifacts excluded from the chunking, so no reviewer spent a chunk
reading evidence JSON). **118 raw findings** (3 BLOCKER, 15 HIGH, 62 MEDIUM, 38 LOW) → **94
distinct** after dedupe, dispatched to **13 fixers across two waves**. Ledger at
`/tmp/pr184-r4/triage.md` with per-fixer reports under `/tmp/pr184-r4/fixes/` — **not yet copied
into `_bmad-output/workflow-state/code-review/pr184/` the way rounds 1 and 2 were**, so this section
is currently the only durable record of the round. Classification totals:
84 patch, 8 defer, 1 dismiss, 3 decision-needed resolved fail-safe (the operator pre-authorised the
fail-safe arm).

Two structural facts about this round are worth stating before the list. **First, wave 2 existed
because wave 1's own output needed review** — the fixture/contract/CI/live/docs fixers were aimed
at what wave 1 wrote, and they found real defects in it, including one wave-1 miss
(`tier2-image-contract` was converted to `settleRun` and left without its key-leak verdict).
**Second, most of the `tier1-*` live files had no reviewer.** The wave-2 fixer's report calls all
nine of them "previously unreviewed"; carry the hedge — three (`tier1-registry-auth`,
`tier1-approval-gate`, `tier1-teardown`) *were* in this round's chunking for other findings, so read
it as six genuinely unopened files plus three opened for other reasons. Wave 2 read them all because
F17's roster forced a file-by-file survey, and found nine new defects, several HIGH-and-silent (a
key-leak delta that could not fail, and an F4/F6-shaped cleanup `expect` ahead of the held-error
rethrow). Those are recorded below as **new findings**, not as patched review items, because no
reviewer raised them.

### Patched — by area

**CI / supply chain** (`.github/`) — 15 of the cluster's 17 rows touched (14 fully patched, A12
corrected to the extent it was true), **including three the ledger had deferred** (A13/A15/A16,
moved into scope mid-round), plus one wave-2 follow-through. A14 was declined with evidence and
A17 confirmed dismissed — both below.

- [x] **A1** — an exception entry with a missing or misspelled `expires`/`reason` was a *permanent silent* pin-gate bypass: `jq -r` prints the literal `null`, `[ -n "null" ]` is true and `[ "$today" \> "null" ]` is false on every date.
- [x] **A2** — the provenance identity bound `--signer-workflow` = a path with **no ref**, so a bundle minted from any feature branch verified.
- [x] **A3** — the exception's expiry was never re-evaluated: the gate was `pull_request`-only on three paths, so an expired exception could never fire.
- [x] **A4** — `verify-image-pin.yml` declared `contents: read` only on a **private** repo, so the attestation read could never succeed and every legitimate re-pin was forced into the exception register.
- [x] **A5** — a single-shot `gh attestation verify` against an API the producer's sibling job retries 5× for eventual consistency; a propagation artifact read as "no provenance".
- [x] **A6** — a workflow-scoped `concurrency.group` let a feature-branch dry run **cancel** the prescribed "push to heal" run, and cancelled is not red.
- [x] **A7** *(decision-needed → fail-safe)* — nothing asserted the `publish-exedev` environment exists with required reviewers; a missing rule published with zero human approval, fully green. **The new assertion currently fails closed — see *What a human must do*.**
- [x] **A8** — duplicate digests in the register yielded a multi-line `expires` and an arbitrary verdict.
- [x] **A9** — the consumer gate never read `DEFAULT_IMAGE_BUILD_ID`, which is half the pin. (Scope limit kept and stated in-file: the hex check is skipped on the bootstrap sentinel arm, and no shape check can prove a buildId *belongs to* a digest without a ~1.6 GB pull.)
- [x] **A10** — checkout without `persist-credentials: false` (zizmor `artipacked`), unlike its sibling.
- [x] **A11** — the fork-guard comment described a case `github.repository_owner` cannot select on `pull_request` (comment only; the guard is kept).
- [x] **A12** — the attest job's "unlike the tag-pinned actions" comment (half stale — see False positives).
- [x] **A13** *(was deferred)* — the push precedes the digest/buildId gate, so a mismatch left an unattested, anonymously-pullable `sha-<sha>` tag behind. A prune step now runs on the gate's own failure; **its `DELETE` permission is honestly untested and its failure path is a loud, named manual chore.**
- [x] **A15** *(was deferred)* — the gate was triggered by, and read, the PR that edits it. Now `pull_request_target` with a **data-only** overlay of the PR head's `driver.ts` (fetched via the contents API, `grep`ped, never checked out or executed). Knock-on: a PR that changes this gate no longer exercises its own new version; the `push` leg does that one merge later.
- [x] **A16** *(was deferred)* — the dependabot `docker` entry is inert against a digest-only `FROM`, so **nothing in the repository could see base drift**. New `base-drift` job. **It is already red — see *What a human must do*.**
- [x] **W2-CI** — the publish gate's dry arm read `jq -er .builtDigest`, which under `set -euo pipefail` killed the step *before* the diagnostic it exists to print; and on the fall-through it offered a human `DEFAULT_IMAGE_REF = "ghcr.io/…@"` to commit. Now a split verdict: build gates still pass or fail on their own terms, the pin verdict is *withheld* loudly, and a corrupt non-digest value keeps its hard `exit 1`.

**Build script** (`scripts/build-exedev-image.ts`) — 23 of 24 (B10 refuted):

- [x] **B1** — the credential gate **printed the credential**: `SECRET_ENV` matches *because* a value follows, and the whole layer-history line went to stderr → the CI job log.
- [x] **B2** *(fail-safe)* — a dry run adopted `builtDigest` from an unverified flat `containerimage.digest` (possibly the docker-archive exporter's), and the workflow offered it to a human as the pin. Now `null` + a `builtDigestReason` sentence on non-push runs. **Highest-blast-radius change of the round.**
- [x] **B3** — `os.tmpdir()/qds-exedev-scan-*` and `-tree-*` were swept by nothing; the scan tree is the one the file itself calls "can be a real private key".
- [x] **B4** — `judgeCandidateDir` read *through* symlinks host-side, reopening the hole `-L` was added to close (a config symlinked to an in-container path had the **host's** file judged in its place), and `Dirent.isDirectory()` being false for a link-to-dir produced a phantom fatal finding on clean builds.
- [x] **B5** — `nodeModulesRoot` returned `null` on the first non-boundary hit, missing a real `node_modules/` further right: a **silent green** on exactly the condition the sweep exists to catch.
- [x] **B6** — `parseBaseRefs` registered a stage alias before testing the same instruction's ref, so `FROM x AS x` dropped the base from `baseRefs` and from the buildId.
- [x] **B7** — `resolveBaseDigest` took `RepoDigests[0]` without matching the ref's repository, **and** silently substituted a stale daemon digest for any registry failure (401/429/DNS). An unreachable registry on a non-digest-pinned base is now fatal.
- [x] **B8** — the `$`-template refusal was ordered *after* the digest match, so `FROM ${BASE}@sha256:…` slipped through.
- [x] **B9** — a continuation *into* a `FROM` was not refused, so a phantom FROM became the runtime base (`froms.at(-1)`).
- [x] **B11** — NOTICE was written before the binary-attribution gate, so a failed AC5 build left on disk the artifact the header swears it never leaves.
- [x] **B12** — `leaked.containers.delete(cid)` ran unconditionally after an unchecked `docker rm -f`, so a **failed** removal was erased from the leak registry (two sites, fixed in one shared helper).
- [x] **B13** — the stale-run sweep killed a healthy concurrent run on a vanished sibling (`statSync` ENOENT → `die(2)`), and its directory-mtime age gate could delete a **live** run's dir, because the whole gate phase writes nothing into `runDir`.
- [x] **B14** — `main()`'s `finally` `rmSync` could throw and **replace** the in-flight error, exiting 1 — the code reserved for a compliance failure.
- [x] **B15** — the protected-build-input guard was a case-sensitive compare on a case-insensitive filesystem, so `--evidence OCI/exedev/Dockerfile` deleted the real tracked Dockerfile.
- [x] **B16** — `--summary`/`--evidence` would `rmSync` **any** path outside a five-entry denylist; `--evidence src/providers/exedev/driver.ts` destroyed the pin file. Replaced by a positive constraint (inside `BUILD_DIR` or outside the repo), so the denylist is *gone* rather than extended.
- [x] **B17** — AC5 binary attribution matched **basenames only**: `bun` and `pi` were wildcards at any path. Optional `paths[]` added — see *AC5 attribution* below.
- [x] **B18** — `dockerfileArgDefault` read only the first `ARG NAME=` (silently degrading the moment DF1.10 adds a stage) and returned `null` for a trailing comment.
- [x] **B19** — the docblock's residual-false-negative list omitted the class it most needs: `listExecutables` audits the image **with the image's own `find`/`sha256sum`** (docblock only; the measurement cannot move out of the image without a second toolchain).
- [x] **B20** — the `docker cp -L` docblock credited `-L` with closing a hole that `failClosed` actually closes (docblock only).
- [x] **B21** — `docker cp` stderr was captured and discarded, so a build-stopping INV-IBOX-1 finding named a path and no cause.
- [x] **B22** — nothing checked NOTICE/`--summary`/`--evidence` were three distinct paths; `--summary <NOTICE_PATH>` overwrote the published NOTICE **after** every gate passed.
- [x] **B23** — the clean-path `renderNotice`/`writeFileSync` were unwrapped, so an ENOSPC reported as exit 1, i.e. a compliance failure. (The identical call in the failure branch *was* wrapped.)
- [x] **B24** — the local tag survived every failure after `docker tag`, contradicting the header's "leaves no local artifact behind".
- [x] **H2** *(deferred as a finding, addressed as documentation)* — `coldBootMs: 0` is a documented never-evaluated sentinel, but the uploaded artifact carried a bare `0` that reads as a measurement. Two sibling fields now say so in the JSON itself.

**exedev src** (`src/providers/exedev/`) — all 12, plus two test-hygiene items:

- [x] **C1** — `create()` rethrew `ExeDevDriverError` **before** `redactRegistryAuth`, on the unverified premise "our own typed errors never carry the credential". Scrubbed unconditionally now. (The premise was refuted — see False positives — but the fix was applied anyway on the pre-authorised fail-safe: `this.run` is an injected seam and no assertion at that seam can check it.)
- [x] **C2** — `...opts` spread last defeated the both-or-neither pin guard when a caller passed `{ image: undefined }`: the driver fell back to `DEFAULT_IMAGE_REF` paired with an override buildId — the mismatched pair arriving *through* the guard.
- [x] **C3** — B0 handed **one** `budgetFree()` snapshot to two sequential execs (`test -f` then `cat`), so a hung box cost its caller up to 2× the deadline it stated. One absolute deadline now spans both legs.
- [x] **C4** — the one fail-**OPEN** shape the reviewers found: `expanduser` returns its argument unexpanded when `HOME` is unset and passwd lookup fails, so a literal `~/.pi/agent/models.json` passed the emptiness guard and `[ ! -f "~/…" ]` read a **present, possibly unpriced** registry as the tolerated absence.
- [x] **C5** — a D-pre refusal exits 3 before C runs, leaving an artifact with **no C row at all** — indistinguishable from a gate never asked to run it. New optional `notRun` field; `assertionCode`/`failedItem` deliberately unchanged.
- [x] **C6** *(decision-needed → fail-safe)* — gate B compares against `driver.imageBuildId`, which `QDS_EXEDEV_IMAGE_BUILD_ID` overrides; a digest-shaped override was **silent** (the announce arm fired only for a tag pin). The override stays (AC3 requires it) and is now loud: `exedev.image_override` fires whenever either half differs from the repo pin.
- [x] **C7** — a lapsed ratification threw before `create_requested` and outside the try, so the one new failure mode this PR introduces emitted **no event at all**.
- [x] **C8** — `redactRegistryAuth`'s docblock claimed line-wrap coverage that `split(secret)` cannot provide (comment; the honest coverage paragraph replaces the overclaim, and the guarantee INV-IBOX-3 actually rests on is named).
- [x] **C9** — up to two **unbounded** `pi --version` calls sat ahead of the whole gate, in a block whose own header says pi stalls nondeterministically. One bounded call now. (Degrades to an unbounded call where `timeout` is absent — refusing a box for a missing coreutils utility would be the worse failure.)
- [x] **C10** — the credential file was opened, fstat'd, mode-checked and read even when `opts.registryAuth` would discard it, so a 0644 file the driver had no interest in refused the factory.
- [x] **C11** — no size bound on the credential file read; `stat.size` was in hand and unused, so a mispointed path at a large 0600 file was slurped whole before the 512-byte ceiling applied. New code `registry-auth-file-oversized`.
- [x] **C12** — `marker_assert_ms` had no `>= 1` clamp while its neighbour `boot_ready_ms` does, so a sub-ms B0 read published the never-evaluated sentinel for an assertion that ran.
- [x] **G6** — the frozen clock leaked out of the "MUST STAY LAST IN THIS FILE" test into a whole trailing `describe`, so D10 drove the gate through a budget that **could not run out** — and a previous round raised a timeout instead of restoring the clock.
- [x] **G7** — nothing tested the `grep -xE` exact-line pi-version pass: all three pi doubles print a bare version, so deleting the guard kept every AC2/D7 test green while every banner-printing box refused D. Mutation-verified.

**Fleet + credentials** (`src/fleet/`, `src/providers/credentials.ts`) — all 5, with D3's first half (D3a) refuted:

- [x] **D1** — the round-3 `null` transport skip was **never counted**: `runRace` incremented `unusableTicks` only for `"unusable"`, so a permanently-dead arm still never reached its limit and the race spun to the full 1 h ceiling holding the fleet lock — which is precisely what the change's own comment claimed to fix.
- [x] **D2** — box-controlled `probeStderr` went **raw** into a logged `Error` on the fanout path (log-line forgery), while the sibling gate path `JSON.stringify`s it for exactly that reason. Fixed on the named line **and on its unnamed twin** in the `unreadable` branch.
- [x] **D3b** — a **successful** compensation (live key minted, then revoked) was logged nowhere, so the log's last word was "a live key was minted for this run", forever.
- [x] **D4 / D5** — both recorded as **deviations 6 and 7** above, which is what the finding asked for.

**Image + unit + skill doc** (`oci/`, `.claude/skills/qds-live-e2e/`) — all 14:

- [x] **E1** *(decision-needed → fail-safe)* — `pi` installs over the network with **zero** integrity verification, directly below a bun step that pins an in-repo sha256, and pi is the binary that runs with the per-run LLM key. No upstream checksum exists to pin. The build now **records** the observed `sha256(pi)` into `/etc/qds-image.json`; the Dockerfile states in those words that this is a **record, not a verification**, that nothing refuses on it, and exactly what would upgrade it to a gate.
- [x] **E2** — `org.opencontainers.image.licenses="MIT"` was contradicted by `binary-licenses.json` in the same PR (statically-linked LGPL JavaScriptCore plus a whole GPL userland) → `NOASSERTION` with a pointer to the NOTICE.
- [x] **E3** — `# syntax=docker/dockerfile:1` was the only unpinned upstream in a file whose doctrine is "digest-pinned, never `:latest`" — and it is *executed* as the build frontend at higher privilege than the base. Digest resolved live, not invented; proven by a `docker build --check` that resolved and ran it.
- [x] **E4** — the AC6 `QDS_*` sweep claimed "the complete set" of surfaces and omitted every systemd env surface except the unit file, plus `~/.bashrc`/`/etc/profile`. Both a widened scan and a **deleted over-claim** — the new prose names the five surfaces checked, the `grep -r` symlink ceiling, and a NOT COVERED paragraph for runtime delivery.
- [x] **E5** — `[Install] WantedBy=multi-user.target` on a per-run template is the double-spend `Restart=no` exists to forbid, through a different door: an enabled instance is pulled in on every subsequent boot.
- [x] **E6** — no `TimeoutStopSec=`/`TimeoutStartSec=`, so the 90 s manager default SIGKILLs the cgroup mid-`git push` or mid-model-call on the *routine* teardown path.
- [x] **E7** — `binary-licenses.json`'s `$comment` gave two incompatible rules for a top-level `NOASSERTION`; the executed probe settled which sentence was true and the correction is flagged as a correction.
- [x] **E8** — the Dockerfile BUMP PROCEDURE omitted the private-mirror re-push, so following it verbatim gives a green build and a red AC4 with no pointer to the missing step.
- [x] **E9** — `SKILL.md` told two mutually exclusive stories about roster path resolution. Both turned out to be true on *different call paths*; the file was wrong, not either sentence. One two-row table now, plus the corollary the old text hid: on the dispatch arm a bogus `QDS_EXEDEV_ROSTER` changes nothing and the round goes green, so "I set the env var" is never evidence about which roster the gate read.
- [x] **E10** — `chown -R /home/exedev/.local` put the target of the root-owned `/usr/local/bin/pi` symlink under the login user's control. Narrowed — **and an honest limit added**: narrowing does not make pi tamper-proof, because exedev owns its `$HOME` and can unlink and replace the binary regardless.
- [x] **E11** — the `version` fields in a legal artifact held prose, not versions.
- [x] **E12** — every `licenseUrl` targeted mutable `blob/main/` in a table that argues against exactly that (three of four; see False positives for the fourth).
- [x] **E13** — `EnvironmentFile=` is mandatory-form with `Restart=no` and no ordering on credential delivery, so a missing `.env` surfaced as a generic 203/EXEC. `AssertPathExists=` shipped, **not** the prescribed `ConditionPathExists=` (see False positives).
- [x] **E14** — `After=` with no `Requires=` on the unit's stated hard dependency: ordering only, satisfied vacuously when the dependency never ran or failed.

**Live e2e** (`tests/fleet/e2e/`) — all 17, though the ledger had classified F17 as deferred:

- [x] **F1** *(BLOCKER)* — AC4's positive leg leaked a **billing box**: `posCreated = true` was set *after* `create()`, which has three documented throw sites *after* the box exists at the substrate. The sibling file got this right.
- [x] **F2** *(BLOCKER)* — `teardownQuietly` had been wired into only **2 of 9** `finally` teardowns; the other seven still let a 180 s `runFleet` rejection escape the `finally`, skipping `destroyQuietly`, the leak sweep, `writeEvidence`, the workspace `rmSync` and `settleRun`. Amplified in the fanout tiers, where one arm's timeout skipped every later arm.
- [x] **F3** — the AC4 negative-control box leaked if the unguarded `negDriver.list()` probe threw: the `finally` had no `negVm` branch at all.
- [x] **F4** — three files newly **added** `expect(destroyFailures).toEqual([])` ahead of `if (failure) throw failure` — the exact shape `settleRun` was written to delete. Fixed at the two named sites **and both other tier-1 files**.
- [x] **F5** — T5.1's box-absence verdict was vacuously true when the box name could not be recovered and one un-retried `list()` came back empty inside the 25 s+ substrate lag this repo has measured.
- [x] **F6** — T5.1 was left on the pre-`settleRun` shape, in a diff that edits that exact block.
- [x] **F7** — the "is the mirror actually private?" guard could never fire: GHCR answers 401 with a Bearer challenge for **public** packages too. Now follows the challenge; verified live against both this repo's public and private packages (three free unauthenticated `curl`s, no spend).
- [x] **F8** — the AC4 negative control passed on **any** create failure, not on an auth failure. Now asserts the typed `create-failed` code plus a substrate non-zero exit (see False positives for the half of the prescription that could not be asserted).
- [x] **F9** — the file timeout was budgeted on typical probe latency while the sum of declared ceilings was ~2,900 s, and a bun test-timeout abort is the one path that leaks a box **and** never revokes the key. Both halves done: 16 straight-line probes bounded at 30 s (down from 120 s), *and* the budget raised over a term-by-term declared-ceiling table.
- [x] **F10** — `teardownQuietly` wrote a **failed** teardown into evidence with no `ok` field, invisible to the repo's own `phase === X && ok === false` audit idiom.
- [x] **F11** — an evidence-write failure in the `finally` made `settleRun` unreachable in nine tiers, triggered by exactly the condition (a key leaked into evidence, tripping the scrub refusal) that most needs the verdict.
- [x] **F12** — T3.4a's best-effort in-body residue cleanup had been promoted to a run-failing verdict without the idempotence `destroyQuietly` provides, failing a 1.5 M ms real-money run whose body passed and whose boxes were gone.
- [x] **F13** — the AC4 test never `rmSync`'d its tmp workspace, leaving the 0600 posture file behind every round, while a hoisted `let workspace = ""` read as if cleanup were handled.
- [x] **F14** — a TIER-2-gated test carried a `tier1-` filename. **Renamed** — see the rename note below.
- [x] **F15** — `teardownQuietly`'s `...label` spread *after* `phase`, so a caller could silently rewrite the discriminator every evidence audit keys off.
- [x] **F16** — `preflight`'s image-override warning was stderr-only while the docblock claimed it was "RECORDED", so a round against `QDS_EXEDEV_IMAGE=<other>` produced evidence indistinguishable from a repo-pinned round. Every evidence file is now stamped with the effective `{ref, buildId, overriddenBy, isRepoPin}`.
- [x] **F17** *(the ledger deferred this; it landed anyway)* — seven of nine tiers had no OpenRouter key-hash delta and no `revokeQuietly` fallback, so a teardown that exits 0 **without revoking** passed all seven green. New `keyLeakProblems` helper (revokes a survivor first, then reports as a problem string, never as a bare `expect`), wired across wave 1's tier2–5 bodies and the four minting bodies wave 2 found still uncovered. (Wave 1's report says "11 test bodies" while its own roster table ticks ten; that discrepancy is inside the report and is not resolvable from here — the durable answer is `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts`.) The deferral reasoning ("a test-design change of its own size") was right about the size and wrong about the conclusion; recording it here rather than leaving the ledger and the tree disagreeing.

**Unit / contract tests** — all 16 (G6 and G7 are listed under *exedev src*, where their fixer owned the file):

- [x] **G1** — the password-half leak test's `JSON.stringify(lines)` absence claim was unguarded and passed vacuously on a `create()` that emitted nothing (`JSON.stringify([])` carries no canary). Mutation-proven.
- [x] **G2** — redaction was asserted only as "secret absent + marker present", which a driver that obliterates all of stderr passes; and no test claimed redaction does **not** fire without a credential. Both closed, both mutation-proven.
- [x] **G3** — "not a cent was spent" was an unguarded absence over a filtered array, so argv drift emptied `boxCmds` and the claim went vacuous. Mutation-proven.
- [x] **G4** — INV-IBOX-2's both-or-neither was asserted only at the factory while ~a dozen tests construct the split pin through `new ExeDevDriver` and assert success, with nothing saying whether that is refused or intentionally allowed. It is deliberate; the seam is now pinned, along with the `image_override` announcement that is its price, and the end-to-end consequence through the real gate.
- [x] **G5** — the exit-code taxonomy was half-built: the `cat` leg was never tested for 255, the most likely real transport fault on that leg. Mutation-proven.
- [x] **G8** — "every declared input has a mutation case below" never checked that a mutation case exists, so a field silently dropped from `deriveBuildId`'s hash failed no test.
- [x] **G9** — `imageMarkerTruncated` served `exitCode: 0`, which the production seam cannot produce (a cap breach SIGKILLs → 137 + truncated), leaving the ordering in `transport.ts` unpinned by the fake.
- [x] **G10** — the fake recorded `--image` and then served `DEFAULT_IMAGE_MARKER` regardless, so every box "booted" the pinned image no matter what the driver asked for and a wrong-ref regression passed gate B green. Opt-in `markersByImage` knob, additive by construction, with a proof test.
- [x] **G11** — `expect(fake.calls).toEqual([])` after constructor-only refusals with a rationale comment that inverted the argument. Assertion kept (it is a real, narrower tripwire), comment corrected.
- [x] **G12** — `Object.keys(EVERY_ASSERTION_ITEM)` asserted a literal the test itself wrote; `bun test` does not typecheck, so the compile-time half was not carried at runtime. Derived from the production table instead of deleted.
- [x] **G13** — the canary leak assertions were constant-true on 13 of 15 ratification arms. Scoped to the arms whose input genuinely carries the canary (derived by reading the arm's own file), with `expect(canaryArms).toBe(2)` closing the hole scoping opens.
- [x] **G14** — the 0600 fixture's mode was not pinned by `chmod`, in the one test whose subject is file mode, while the sibling 0644 fixture does chmod with a comment saying why.
- [x] **G15** — "the four copies" of the steering tuple was five: `BOX_STEERING_ROOT_SH` (`attach.ts:80`), the one the box-side scripts actually run, was unguarded.
- [x] **G16** — the tmpfiles negative control exercised `tmpfilesEntries` (a pure `split`), not the assertions it claimed to guard.

### New findings — the `tier1-*` live files, opened because F17's roster forced a survey

None of these came from a reviewer.

| Sev | Where | Finding |
|---|---|---|
| **HIGH** | `tier1-teardown` | The key-leak delta **could not fail the test**: the success arm pushed `{phase:"key-hash-delta", stranded}` with no `ok` key, while the only reader filters on `ok === false`. A non-empty `stranded` — a real live key the run had just failed to revoke — read as clean in the exact filter written to find leaks. |
| **HIGH** | `tier1-provision-status`, `tier1-harvest` ×2 | F2's shape, unguarded `runFleet(["teardown"…])` in a `finally`. |
| **HIGH** | same three | **No box fallback at all** — those `finally`s ran the teardown verb and nothing else, so a refused or timed-out teardown left a real billing box with no `destroyQuietly` anywhere in the file, and the test shipped green. |
| **HIGH** | `tier1-driver-lifecycle`, `tier1-attach-transport` | `destroyQuietly`'s verdict discarded — the #189 defect round 2 removed elsewhere, still live in two files. |
| **HIGH** | `tier1-harvest` ×2 | A cleanup `expect` **inside** the `finally`, strictly worse than the F4/F6 shape this round spent itself deleting: it overwrites the in-flight body error outright. |
| **HIGH** | `tier1-attach-transport` | F4/F6 verbatim, in a file the round never opened. |
| **MED** | `tier1-approval-gate` (D8) | The leak filter narrowed on exactly the path that leaks: a per-hash basis was chosen whenever the mint returned, but the account delta exists for the case where `mintRunKey`'s tail throws after the provider created a live key. |
| **MED** | `tier1-harvest` ×3 | The wrong *reason* recorded for a correct exit set: the comment credited `--no-harvest` for exit 6, which only prints `teardown.harvest_waived`; the real cause is `keyUnattributable` on an open record with a `vmName` and no `keyHash`. A future reader dropping `--no-harvest` would have "fixed" the wrong thing and turned every green round red. |
| **MED / LOW** | 7 files | F11's `writeEvidence`-in-`finally`, swallowing `catch {}` blocks over real cleanups, and an evidence-write failure that was printed and nothing more — in the one file whose whole subject is a private-registry credential. |

### False positives — verified against real source, and why they must not be re-raised

Four findings were checked and refuted outright. Each is recorded with its evidence so the next
round does not spend a reviewer on it again.

- **B10 — `tarUnescape` skipping the trailing surrogate after `codePointAt`.** The compensating
  advance already exists: `scripts/build-exedev-image.ts:1215` reads `if (cp > 0xffff) i += 1;`
  immediately after the push, and it is **already under test** — three assertions in
  `tests/scripts/build-exedev-image.test.ts` each combine an astral character with an escape, so
  they force the loop past the `!entry.includes("\\")` early return. No patch, no new test.
- **D3a — `redactSecrets` handed a non-string rejection.** `redactSecrets(text: unknown, …): string`
  takes `unknown` **by design** and coerces internally through `asText` (`step-log.ts:196-203`),
  itself `try { String(v) } catch { "[unprintable]" }`, with the whole body wrapped in a
  `try/catch` returning `REDACTED`. The `?? e`-not-`?? String(e)` idiom is *mandated* at
  `step-log.ts:383-386` — "`redactSecrets` coerces (and `String` is itself throwable on a
  null-prototype value), so the whole message path is normalized in exactly one place instead of at
  each of the four sinks." The named line is one of three identical sites; "fixing" it would break
  the house rule and **introduce the throw the finding feared** rather than remove it. And
  `[object Object]` is exactly what `String(revErr)` yields, so nothing is gained either.
- **A14 — split the publish job to drop `packages: write` on the dry-run route.** Declined with
  three pieces of evidence. (1) The fix does not address its own threat model: the finding's actor
  is one who edits the workflow on their branch, and such an actor can equally write
  `permissions: packages: write` into whichever job the split creates, or add a new
  push-triggered workflow entirely. (2) On the unmodified dry-run route **no privileged token is
  ever materialised** — every `secrets.GITHUB_TOKEN` reference in the `publish` job sits behind
  `if: env.DRY_RUN == ''`, and the rest are in `attest`, which never runs on a dry run; a
  `permissions:` block declares a scope, it does not place a token in a step's environment.
  (3) It would **weaken A7**, the control this same round hardened: Actions forbids `environment:`
  on a job that calls a reusable workflow — `actionlint` refuses it in as many words — so the
  `publish-exedev` approval would have to move into the callee and become a function of a
  caller-supplied input. Judgement call, not a blocker; the mechanics are clear if the call is
  overruled.
- **FP-1 (W2-LIVE) — a `lint/style/useConst` in `tier3-remote-phases.live.test.ts:73`.** The
  reported lint **does not exist**, and `useConst` is right not to fire: the binding *is*
  reassigned (`:73` declares, `:236` assigns in the `finally`, `:259` reads). `const` would not
  compile. `bunx biome check tests/fleet/e2e/` is exit 0 on the pre-edit tree too. Not patched.

Two more were **partly** right and are recorded that way rather than as wins:

- **A12 (half true).** The comment's claim about "the `publish` job" was false — all three of its
  `uses:` are SHA-pinned. But `ci.yml` **genuinely is tag-pinned** (`actions/checkout@v7` at :41
  and :140, `oven-sh/setup-bun@v2` at :53 and :144, `actions/upload-artifact@v4` at :156). The
  false half was removed; the true half was kept, made concrete, and turned from "we are
  inconsistent on purpose" into "ci.yml is the outlier and should follow, not be followed".
- **E12 / E13 (each half refuted).** E12: the WebKit `url` is **not** a `blob/main/` reference —
  it is a bare repository URL, and it is verbatim what bun's own `LICENSE.md` gives *at the pinned
  tag*; upstream publishes no per-release ref for the WebKit fork, so pinning it would mean
  inventing a ref, which the finding itself forbids. Kept, with the reason recorded in the note;
  the other three URLs were genuine and are fixed. E13: the prescribed `ConditionPathExists=`
  would have been **fail-OPEN** — a failed `Condition…=` marks the unit skipped and the start job
  **succeeds**, turning today's loud 203/EXEC into a silent no-op for DF1.10's caller.
  `AssertPathExists=` shipped instead: same named cause in `systemctl status`, and the job fails.

One finding was dismissed by the reviewers themselves and re-verified: **A17**, the `github-actions`
dependabot ecosystem entry, exists at `.github/dependabot.yml:24-31`.

### Deferred — real, with a reason, and who owns the clock

- **A13's residual and the three orphan versions.** The prune step only ever deletes a version
  *its own run* created; the three untagged versions already in the package
  (`3c21d5f9…`, `b49540a2…`, `d4b9d80c…`) are pre-existing accumulation and remain the manual
  registry chore the workflow header describes.
- **A15's residual** — a PR that changes this gate still does not exercise its own new version.
  Inherent to `pull_request_target`; the `push` leg covers it one merge later.
- **A16's decision, not its detection** — the drift is now detected daily; **adopting** the new
  base is a full re-pin and is DF1.10's to absorb. See *What a human must do*.
- **H2** — AC7(c)'s cold-boot falsifier is a `0` sentinel in the **build** evidence while the real
  number lives only in the live-e2e evidence. Documented sentinel convention (Observability
  Contract: a field never evaluated reports 0); the number exists and is honest, and the JSON now
  says which it is. Recorded, not changed.
- **H3** — the provenance gate cannot fail for the only artifact that ships, because the shipped
  pin *is* the register's single exception — in the same PR as "a gate with a documented bypass is
  not a gate". Self-expiring, reasoned, owner named. **A1 and A3 make the expiry real, which is
  the part that was actually broken**; the exception itself stands until 2026-10-15.
- **[MED] `imageMarkerFailure` classifies the two legs asymmetrically for non-137/255 exits** —
  a SIGTERMed (143) `cat` is reported as `image-marker-mismatch`, i.e. a finding *about the image*,
  while the probe leg's identical 143 correctly falls through to `image-marker-unreachable`. The
  contract fixer deliberately did **not** add a `cat 143` test row, because the only assertion
  writable today would pin the wrong behaviour as correct. Both legs are fail-CLOSED, so this is a
  diagnosis-quality defect, not a hole. **A wave-3 transport fix was in flight when this section
  was written and its report had not landed; if `transport.ts`'s `unreadable` arm now carries the
  same "any exit that is not `cat`'s ordinary refusal is unreachable" fallback the `absent` arm
  has, this item is discharged — read the file, not this paragraph.**
- **`credentials.ts`'s `delivery_compensation` sibling** still logs only the failed compensation
  (deviation 6). Left alone deliberately: it is DF2.3 code this PR should not widen further.
  Worth an issue.

### What a human must do

Four things surfaced this round that **no code change can close**. Items 1 and 2 were closed on
2026-09-02 and are struck through below; 3 and 4 remain open, both pending the same rebuild. They are recorded here rather
than in a fixer report because a fixer report is read once.

1. ~~**BLOCKING — the `publish-exedev` environment has no Required reviewers rule.**~~
   **CLOSED 2026-09-02, by decision — the rule is unobtainable here.** The original finding stands
   as measured (`protection_rules: [{"type":"branch_policy"}]`, `can_admins_bypass: true`), but the
   remedy it prescribed does not exist on this account: creating *any* deployment protection rule
   returns `422 … billing plan`, proven twice (required-reviewers and a wait-timer control probe).
   Deployment protection rules need GitHub Team/Enterprise; the repo has since moved to
   `Quantum-Digital-Solutions`, which is on the **free** plan. The operators develop jointly and
   declined an approval gate. The A7 assertion was re-scoped to the server-side **origin**
   constraint it *can* prove — see **Deviation 8** for the full record, what was lost, and the
   one-step reversal.
2. ~~**The exeuntu base has already drifted.**~~ **CLOSED 2026-09-02 — adopted, not deferred.**
   `FROM` moved to `sha256:bd447a7715e4…` in `f7b5417`, taking `parseBaseRefs`' real-Dockerfile
   assertion with it. Proven closed rather than assumed: `verify-image-pin` was dispatched
   explicitly so the schedule-only `base-drift` job actually ran — **green** (run `33623615040`),
   pinned base now equal to upstream `:latest`. The re-pin that this base bump implies is folded
   into the same rebuild as items 3 and 4 below, so it costs one publish, not two.
3. **The bootstrap exception expires 2026-10-15.** `verify-image-pin` now runs on a daily
   `schedule:` against the default branch, so it **starts failing 2026-10-16** unless an attested
   re-pin has landed by then. That is what an expiry is for — but it is now a dated alarm with an
   owner, rather than a comment nobody re-reads.
4. **The pinned image is STALE as of this round.** Every edit to `oci/exedev/Dockerfile` and
   `oci/exedev/systemd/*` in round 4 (E1, E2, E3, E4, E5, E6, E8, E10, E13, E14) moved a
   `deriveBuildId` input — the hash covers base digests ‖ `BUN_VERSION` ‖ `PI_VERSION` ‖ Dockerfile
   bytes ‖ both unit files. So the `DEFAULT_IMAGE_REF` / `DEFAULT_IMAGE_BUILD_ID` pair in
   `src/providers/exedev/driver.ts` no longer describes what this tree builds. **The image must be
   rebuilt, republished, re-pinned and the private mirror re-pushed** before the live
   `tier2-image-contract` (gate B buildId) and `tier1-registry-auth` (AC4) legs can pass again.
   The coupling is now written into the Dockerfile's own BUMP PROCEDURE (E8) so the next person
   does not rediscover it.

### The `tier1-image-contract` → `tier2-image-contract` rename

`tests/fleet/e2e/tier1-image-contract.live.test.ts` → `tests/fleet/e2e/tier2-image-contract.live.test.ts`
(plain `mv`; nothing staged, nothing committed). The file calls `liveGate("2")` while `liveTodoOff()`
keys only on `QDS_E2E_LIVE`, so a natural `QDS_E2E_LIVE=1 QDS_E2E_TIER=1 bun test tests/fleet/e2e/tier1-*.live.test.ts`
sweep **ran** it and threw `QDS_E2E_TIER is "1", not "2"` — at the *end* of a paid round, after the
money was spent. Nothing resolves the file by path, so the rename cannot break a build; every
remaining reference (three comments and one evidence string in `scripts/build-exedev-image.ts`, four
comments in `live-harness.ts`, three places in `SKILL.md`, and five in this file) was updated by its
owner. **The evidence artifact NAME stays `t1-image-contract`**, deliberately and with an inline
comment at the `writeEvidence` call saying so, so every historical evidence JSON
(`…-114112-t1-image-contract.json` and its siblings) remains joinable to this test. One deliberate
survivor: `SKILL.md:95` still contains the string `tier1-image-contract`, in a dated sentence
recording that the rename happened and why — a historical statement, not a pointer.

### AC5 attribution changed shape — for the next reader

`oci/exedev/binary-licenses.json` entries gained an optional **`paths`** field. Coverage was
basename-only, so any executable called `bun` or `pi`, from any project, at any path, passed
unquestioned. It is now **basename AND in-image path** when `paths` is present: `bun` is scoped to
`usr/local/bin/bun`, `pi` to `home/exedev/.local/bin/pi` + `usr/local/bin/pi`. Absent `paths` is
exactly the old behaviour, so the change is additive; a present-but-empty array, a non-array, or a
leading slash is a validation failure rather than a silent widening. Honest limits, both stated in
the file's own `$comment`: bun's path is **measured** (from this repo's own
`build-evidence.json` — `addedBinaries: ["usr/local/bin/bun"]`, 2026-09-01) while **pi's comes from
the table's notes and is currently unexercised**, because pi's bytes match the base and it never
enters `added`; if that path is wrong it surfaces as a loud fail-closed build stop on the next pi
bump, not a silent pass. Separately, the `$comment`'s "the diff is BY PATH" paragraph asserted the
opposite of what the code does — the *diff* has been by path **and content** since round 1
(`baseBins.get(p) !== sha`); it was always the *coverage* that was by basename. Corrected. Issue
[#188](https://github.com/biospark33/QDS-Factory/issues/188), which tracks the basename ceiling, is
narrowed by this but not closed: an entry with no `paths` still matches a basename anywhere.

### Gates after the round

Every gate below ran **offline**, in the fixer that owned the file, and each is reported with its
attributed failures rather than as a bare green.

| Gate | Result |
|---|---|
| `actionlint` (both workflows, with shellcheck 0.11.0 installed so the shell linting really ran) | 0 |
| `bash -n` over every extracted `run:` block, both workflows, all steps | all OK |
| `docker build --check` on the real Dockerfile | exit 0, no warnings — which also proves the E3 frontend digest resolves and parses the file |
| `systemd-analyze verify` + `systemd-tmpfiles --create` | not runnable on macOS; replicated in a throwaway container at the **same** systemd the base ships (255.4-1ubuntu8.17), verify silent and exit 0, with a negative control proving it is not vacuous, and both new AC6 surfaces proven CAUGHT |
| `bunx tsc --noEmit` | **0 repo-wide**, re-measured at the time this section was written (the last wave-2 report still showed one residual `TS6133` in `tier3-manystories.live.test.ts`; it is gone). Several fixers reported non-zero mid-round; every error was attributed to another fixer's in-flight edit — a `dockerfileArgDefault` → `dockerfileArgDefaults` rename crossing `scripts/` and `tests/scripts/`, and unused-import/rename artifacts in the live tests — and all were resolved by their owners. |
| `bunx biome check` | clean per fixer scope. One reported `useConst` was a false positive (FP-1). |
| `bun test tests/providers/exedev/` | 230 pass / 1 todo / **0 fail** (from 223 pass / 3 fail at the start of wave 2 — the three were the AC6 directive-set assertions the image fixer's unit changes invalidated, handed over with exact replacement values and verified sufficient before the hand-off). `image-contract.test.ts` alone: 38 pass (was 35). |
| `bun test tests/scripts/` | 448 pass / 2 skip / **0 fail** (`build-exedev-image.test.ts` alone: 125 pass) |
| `bun test tests/fleet/` | 1054–1059 pass / 24 todo / **0 fail**. One `patterns.test.ts` failure appeared under concurrent load and was investigated rather than waved off — a 2 s `loserTeardownTimeoutMs` against real host git, 4/4 pass on isolated re-run, structurally independent of the probe budget C3 changed. A separate run launched concurrently with the exedev suite produced 8 failures — seven `patterns.test.ts`, all the same run-lock temp-file ENOENT race under load, and one multi-second KDF test in `approvers.test.ts`; `patterns.test.ts` green in isolation and `approvers.test.ts` 114 pass / 0 fail alone. Recorded rather than quietly re-run away: this is the environmental class the live-e2e skill's gotcha #5 names, and it will bite a busy CI runner. |
| `bun test tests/fleet/e2e/` with `QDS_E2E_LIVE` unset | exit 0, 12 pass / 24 todo / 0 fail |

**Mutation proof, not just green.** The contract fixer proved five of its assertions by mutating
production source, watching the new assertion fail, then restoring and verifying byte-identity by
`diff` **and** sha256 (the working tree carries uncommitted wave-1 changes, so an empty `git diff`
would not have been proof). G1, G2a, G2b, G3 and G5 each went red under their own mutation while
the pre-existing assertions in the same tests stayed green — which is the finding, demonstrated.
G7 and G8 are mutation-proven the same way in their own files.

### What this round did NOT do, stated plainly

- **No live E2E round was run.** Every gate above is offline with `QDS_E2E_LIVE` unset; every live
  body reported `todo`, so no `preflight`, no `driver.create`, no `mintRunKey`, no `runFleet`
  subprocess. **No box was provisioned and no money was spent.** Proven three ways by the fixers
  who own the directory: the todo count matches `grep -c "test.todoIf(liveTodoOff())"` exactly, a
  `todo` body is never invoked by bun at all, and no evidence JSON was written — the newest file in
  `_bmad-output/evidence/df3-e2e/` predates the gate runs by hours. The only network traffic was
  three free unauthenticated `curl`s at ghcr.io to verify F7, plus read-only `gh api` probes.
- **So every live-e2e fix in this round is unexercised on real substrate.** `keyLeakProblems`,
  `writeEvidenceQuietly`, `teardownQuietly`'s `ok` field and `okExitCodes`, the F1/F3 box-leak
  guards, F7's Bearer-challenge probe and F9's bounded probes are all proven only by unit tests
  against fakes and by offline reasoning. The next paid round is their first real exercise — and
  it cannot happen until the image is re-pinned (item 4 above).
- **The key-leak verdict's true coverage.** After wave 2, **every live body that mints a key
  carries a `keyLeakProblems` verdict** — wave 1 wired the minting bodies across the nine tier2–5
  files, and wave 2 wired the four it missed (`tier1-teardown`, `tier1-approval-gate` T1.7 and D8, and
  `tier2-image-contract`, which wave 1 converted to `settleRun` while leaving the key half out).
  The bodies with no verdict are the ones that mint nothing, established per file rather than
  asserted: `tier1-driver-lifecycle`, `tier1-provision-status`, `tier1-harvest` (both legs — its
  "key delivery" is a literal string written to measure file mode, not a mint), `tier1-lock`,
  `tier1-fanout-refusal` and `tier1-attach-transport` construct no `KeyApi` on any path, and
  `tier1-registry-auth` imports no credential module at all. **Two honest qualifications.** First,
  `SKILL.md`'s roster prose was written before the tier-1 wiring landed and therefore *under*-claims
  the coverage; the durable answer it gives —
  `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts` — is correct either way, which is why it
  was written that way. Second, this is a **static wiring claim**: no round has yet executed
  `keyLeakProblems` against a real OpenRouter account.
- **The publish workflow has still never executed and the pinned image was still pushed by hand.**
  Unchanged since round 1's disclosure, and round 4 grew the CI surface substantially — the CI
  fixer's diff alone is `publish-exedev-image.yml +183`, `verify-image-pin.yml +381` (551
  insertions / 26 deletions across three files), including a whole second job (`base-drift`), and
  wave 2 then reworked the dry arm on top. All of it verified only as far as `actionlint`, `bash -n`, extracted
  `run:` blocks against stubbed `docker`/`gh`, and (for A1, A9, A15 and A16) blocks extracted
  **verbatim from the shipped YAML** and executed against real fixtures and the live registry. The
  `attest` job remains the least-exercised code in the PR, and the A13 prune step's `DELETE`
  permission is untested by anything.
- **Round 4's fixes are uncommitted at the time of writing.** The 43-file committed count above is
  the branch as it stands; the round-4 working tree adds seven more paths.

## Review Findings — round 6 (2026-09-03, branch `fix/df2.10-review-round-6`) — the whole story diff, and the round that refused to move the pin

The first round to review **the complete DF2.10 surface**: base `7806bbe` → `dev`, 56 code files,
17,652 diff lines — every PR from #184 through #206, including the eleven follow-ups no round had
ever opened. 18 reviewers over 14 chunks (8 blind, diff-only and repo-blind; 9 edge-case hunters
with targeted repo access; 1 acceptance auditor against the spec). ~180 raw findings → **124 patch
items after dedupe** (2 BLOCKER, 24 HIGH, 51 MED, 47 LOW), 4 dismissed at triage, and a deferral
set that is the most important outcome of the round.

Ledger: `/tmp/df210-review/triage.md`. Reviewer reports and per-fixer reports under
`/tmp/df210-review/{reports,fixes}/`.

### The two BLOCKERs — a credential leak, and the test that could not see it

- **`redactAssignments` leaked any secret whose value contains whitespace.** The redactor is
  `line.replace(/(^|[\s|"'])([A-Za-z0-9_]+)=\S+/g, …)` — `\S+` stops at the first space, so only
  the first word of the value was replaced. EXECUTED against the real functions:
  `SECRET_ENV.test('ENV NPM_TOKEN={"k": "sekrit"}')` → `true`, and
  `redactAssignments(…)` → `ENV NPM_TOKEN=<redacted> "sekrit"}`. That string is pushed into a
  `die(1, …)` finding, i.e. onto stderr and into the GitHub build log, which masks only values
  registered as `secrets.*`. A quoted or JSON build-arg value is the ordinary shape, not a
  contrived one — and this is precisely the failure the function's own docstring says it exists to
  prevent ("printing the credential it had just caught"). Redaction now runs to end-of-line-or-next-
  `NAME=`.
- **The test that claims to close it never imported `SECRET_ENV`.** All four fixture lines had
  space-free values, so the entire class was invisible; the "SUPERSET of the detector's class"
  invariant was asserted against four hand-picked strings rather than against the detector, which
  *is* exported. The assertion is now driven off `SECRET_ENV` over a generated corpus, with a
  quoted space-bearing fixture.

### What the round refused to do — the deferral that matters most

Mid-round, the fix wave began editing `oci/exedev/Dockerfile` and `oci/exedev/systemd/qds-run@.service`
(curl `--proto '=https'` hardening, an `su`-based PATH proxy, `NoNewPrivileges`/`PrivateTmp`/`UMask`,
dropping the inert `TimeoutStartSec`), and adding `platform` plus label-framing to `deriveBuildId`.
Every one of those edits is correct on its own terms. **All of them were reverted.**

`deriveBuildId` hashes `baseDigests · bunVersion · piVersion · Dockerfile bytes · systemd unit bytes`.
Any edit to those files — or to what the function hashes — moves the buildId, moves the manifest
digest, and un-pins `DEFAULT_IMAGE_REF`: the only pin that has ever been live-booted and e2e-proven.
Discharging it costs the full ritual — rebuild → ghcr push → re-pin → **a paid live E2E round** — and
issue **#186** already records that **DF1.10 performs exactly that ritual** when it adds the engine
build stage. A code-review round must not silently trigger a paid re-pin, and eight of the findings
raised here are already unchecked boxes on #186.

Verified after revert: `oci/exedev/` is byte-identical to `dev`, and `deriveBuildId` over the current
tree derives **`3cf094fb6990ed66`** — the live pin, intact.

The work is not lost. It is banked as a 508-line patch at
`/tmp/df210-review/deferred/df1-10-repin-image-content.patch`, and three **tripwire tests** now pin
each deferred defect and are written to go **red the day it is fixed**, so the re-pin is verifiable
rather than remembered:

| tripwire | pins |
|---|---|
| `build-exedev-image.test.ts` — *KNOWN DEFECT (#186): the framing LABEL is NOT length-prefixed* | `{name:"a",bytes:"X"},{name:"b",bytes:""}` and `{name:"a:1\nX\nsystemd/b",bytes:""}` both hash to `10c0ed4ae242e878` — two substrates, one identity |
| `build-exedev-image.test.ts` — *KNOWN DEFECT (#186): `platform` is not a buildId input* | `--platform linux/arm64` builds a different substrate under a byte-identical buildId; gate B's INV-IBOX-2 passes on the wrong architecture |
| `build-exedev-image.test.ts` — COPY-source tripwire over the real Dockerfile | fails the day a `COPY` outside `oci/exedev/systemd/` is added, i.e. an asset the identity does not cover |

`deriveBuildId`'s docblock now carries all three as a numbered `KNOWN GAPS, deliberately NOT closed
here` block naming the re-pin cost and #186.

### Patched — by area

**Supply chain / publish (`publish-exedev-image.yml`)**
- [x] **[HIGH] the SLSA provenance named the wrong source commit.** The predicate attested
  `gitCommit: $GITHUB_SHA` while the image is deliberately built at `steps.src.outputs.source_sha` —
  so on exactly the pin-adoption run the workflow's own recovery text prescribes, the signed,
  Rekor-logged provenance claimed a commit that cannot reproduce the bytes. `source_sha` is now a
  `publish` output feeding `resolvedDependencies[0].digest.gitCommit`; `GITHUB_SHA` is kept as a
  separate named `workflow-revision` entry, and both jq args are `:?`-guarded so a blank value
  refuses to sign.
- [x] **[HIGH] the pin gate never checked WHERE the pin points.** It compared only the substring
  after `@`, so `DEFAULT_IMAGE_REF = "ghcr.io/someone-else/whatever@sha256:<this run's digest>"`
  satisfied the shape check, the digest compare and the buildId compare, and printed
  *"digest and buildId match the pin"*. Production would then pull from a registry this workflow has
  never published to. Now `case "$ref" in "$IMAGE"@*)`, verified by execution against a foreign
  owner, a look-alike package and a glob-bearing pin.
- [x] **[HIGH] a post-gate failure published a pinned image that was never attested**, and
  `verify-image-pin` then failed daily with no recovery path — while the gate's own text says
  *"Do NOT press Re-run on THIS run"*. New final `attested` job (`if: always()`, `permissions: {}`)
  fails the run when `published == 'true' && attest.result != 'success'`, and its message
  distinguishes the post-gate case (re-running IS correct) from the pre-gate one.
- [x] **[HIGH] three `imagetools inspect` reads had no failure arm and no retry** — under
  `set -euo pipefail` a registry blip died *at the assignment*, making every `::error::` arm below
  unreachable on the step most likely to be misread as "the pin is wrong".
- [x] [MED] the prune never fired for a push-then-exit-1, nor on cancel/timeout (`!= 'success'`),
  leaving a public unsigned `sha-<sha>` tag with no verdict; a third `nothing to prune` outcome was
  added so the error is not cried wolf. All five paths executed against a stubbed `gh`.
- [x] [MED] a digest-less dry run skipped the buildId comparison it *could* make.
- [x] [MED] the visibility remedy URL assumed an org-owned package while the header claimed
  user-owned — the file held two beliefs; the package **moved to the org** and both now say so.
- [x] [MED] the anonymous-pull check re-spelled the tag, so a 404 read as *"the package is not
  public"* and sent the operator to flip a switch that was already correct.
- [x] [LOW] ×8 — bare `jq -er` reads with no `::error::`; duplicate cosign attestations (no
  `--replace`); unjustified `contents: read` on the only `id-token: write` job; stale
  "workflow-scoped concurrency", "eventually-consistent GitHub store" and "QEMU rebuild"
  rationales; unguarded `RUNNER_ENVIRONMENT` under `set -u`; one `run:` missing `set -euo pipefail`;
  the header claiming pruning is "not something this workflow does" next to the prune step.

**The pin gate (`verify-image-pin.yml`) — a gate that could not gate what it documented**
- [x] **[HIGH] on a PR the exception register was read from the BASE tree** while the pin was
  overlaid from the head, so a new or malformed entry was never validated pre-merge — the landmine
  went off *after* merge, on `dev`/`main`.
- [x] **[HIGH] and the remediation it prints was unreachable in a single PR.** Adding an exception
  and moving the pin together — the documented bootstrap path — was a dead end on first use. Both
  fixed by overlaying the register at `HEAD_SHA` for validation **and** lookup. The hardening that
  choice required is included: `.reason` is now PR-controlled and reaches one `echo`, so entries
  carrying a codepoint < 32 are rejected (a `\n::error::…` could otherwise forge a workflow command).
- [x] [MED] the daily expiry re-check only ever ran on `main` — but `dev` is this repo's integration
  base and carries the working pin for days between promotes, so *"an exception lapses on a date"*
  held for the wrong branch. Now a matrix leg overlays `dev` as data, preserving "no `ref:` on the
  checkout, ever" as a structural property.
- [x] [MED] the `-e` guard the overlay's comment promised was absent: a 200-with-no-`.content`
  decoded `null` to 3 bytes, passed the `[ ! -s ]` check, and overwrote `driver.ts` with garbage.
- [x] [MED] the header claimed the register carried the bootstrap entry; it is committed empty.
- [x] [MED] `.dockerignore`'s credential patterns were non-recursive and `.sandbox` was unignored —
  three real `.env` files shipped to the build daemon on every build.
- [x] [MED] the `qds-live-e2e` SKILL round-exit checklist named exactly the wrong file set: the grep
  it recommends returns 18 of 19 files, and the one it misses — `tier1-registry-auth` — is the only
  one the parenthetical never named.
- [x] [LOW] ×6 — any-length `sha256:` accepted; the duplicate guard counted lines not declarations;
  the register went unvalidated during the sentinel window; a revert-to-sentinel PR passed green;
  `base-drift`'s guard was bypassed when its own input was unreadable; a vestigial single-element loop.

**Driver / transport / gate**
- [x] **[HIGH] `parseImageMarker` piped a raw V8 `JSON.parse` SyntaxError into a logged gate note.**
  V8 quotes a snippet of the offending input, so a box authoring `/etc/qds-image.json` could put
  newlines and ANSI escapes into `assertions[].note`, `result.error.message`, the evidence artifact
  and the log — forging log lines from the exact machine the gate had just decided not to trust.
  Every sibling path in the same module already scrubbed for this reason.
- [x] **[HIGH] `ready` was computed from "no failed row", never "every row ran".** `notRun` was
  recorded and then ignored, so a gate could report a box **READY** while the paid live pings never
  ran. Now `firstFail === undefined && notRun.length === 0` — fail closed.
- [x] **[HIGH] the file-loaded registry credential was never proven to reach the driver.** The only
  happy-path assertion for the whole `QDS_EXEDEV_REGISTRY_AUTH_FILE` indirection was
  `not.toThrow()`; an implementation that read the file, validated it and threw the value away
  passed every test in the suite.
- [x] **[HIGH] `DEFAULT_IMAGE_BUILD_ID` had no "still a placeholder" merge gate** though gate B keys
  on it, not on `DEFAULT_IMAGE_REF`.
- [x] [MED] the pi-version fallback re-introduced the banner failure the exact-line match was added
  to prevent: `A new version 0.99.0 is available\npi 0.84.4` yielded `0.99`, whose D-pre arm refuses
  **every box in the fleet**. Anchored to the version line.
- [x] [MED] `result.error` was attached without checking the typed refusal belonged to the failing
  assertion; `create()`'s rejection path could not distinguish "no box" from "a box may be live"
  (now `mayExist` + `image_pull_failed`); every factory/constructor refusal emitted zero
  observability (now `driver_construct_failed`).
- [x] [LOW] ×14 — `stat.size` is 0 for procfs so the pre-read ceiling was bypassable; a zero-byte
  credential file refused with the wrong reason; `redactRegistryAuth` guarded a zero-length secret
  but not a one-character one; date-only expiry lapsed at UTC midnight; duplicate exit-status
  constants in two modules; and the marker gate's prose over-claimed — **B0 detects DRIFT, not
  TAMPERING** (the marker is authored by the subject of the assertion, and the `buildId` an attacker
  would forge is printed in the gate's own refusal text). Corrected in both `transport.ts` and
  `setup-gate.ts`.

**Fleet / credentials**
- [x] **[HIGH] a half-set image pin blocked TEARDOWN and REAP.** Moving driver construction to
  `exeDevDriverFromEnv()` (correct, and AC3's own fix) put create-time gates in front of verbs that
  create nothing — so a stray `QDS_EXEDEV_IMAGE` export left an operator unable to clean up boxes
  that were already billing, reported by `asUsage` as exit 2, *"permanently wrong, never retry"*.
  Fixed **without weakening AC3**: the factory and the constructor validation both stay exactly
  where they are; a new `resolveCleanupDriver` degrades a construction refusal for cleanup-only
  verbs, logs it naming what to fix before the next create, and is wired at four call sites in
  `fleet.ts`, `sandbox-teardown.ts` and `sandbox-reap.ts`.
- [x] **[HIGH] a ~30 s host-side blip abandoned every arm of a fan-out and leaked all N boxes.** The
  skip streak is per-arm but a shared fault (wifi, DNS, control-plane) fast-fails in under a second,
  so six ticks is ~25–30 s, not the ~90 s the constant's doc claimed; every arm crossed together,
  `runRace` returned `null`, all in-flight LLM spend was discarded and every box was left for the
  reaper. Now abandonment requires that not *all* undecided arms are skipping.
- [x] [MED] `probeArm`'s catch-all could discard a **won** arm (a `store.mutate` throw after the
  marker was read as a winner); `unreadable` was logged as `probe-unanswered` for a box that
  answered twice; the provider-hash charset guard ran *after* `revokeAndVerify` interpolated it into
  a copy-paste `curl` remediation; the failed-compensation branch — the one that leaves a live,
  unreachable, spendable key — had no test.

**Live E2E — leak prevention and false-red removal**
- [x] **[HIGH] T2.1 and T2.2 file budgets sat BELOW the sum of their own inner ceilings** (1800 s vs
  1800 s; 2400 s vs 3060 s). A bun test-timeout abort **does not run the `finally`**, so every arm
  box and every minted key leaked. Re-budgeted with the arithmetic written into the file.
- [x] **[HIGH] twelve single-shot leak checks against a substrate whose destroy lag is *measured* at
  25 s+** turned a clean cleanup into a failed real-money round. New `fleetLeftovers` harness helper
  carries the bounded-retry poll (5×8 s), destroys owned survivors, and splits account-wide strays
  into a warning that does not fail the run — so one box stranded by a prior round no longer reds
  every test in the next one.
- [x] **[HIGH] the F16 provenance stamp was order-dependent module state** — a file that builds its
  own driver inherited the *previous* file's image and stamped "proven live" for bytes it never
  booted. The stamp is now consumed per write and refuses when unset.
- [x] **[HIGH] cleanup problems reached the thrown error and CI logs unscrubbed**, while every
  sibling path scrubbed — a `fleet teardown` dying while echoing a PAT put up to 200 raw chars into
  a log and a PR comment.
- [x] **[HIGH] T1.5 had no cleanup-time box check at all** — and a fanout that wrongly provisions is
  exactly what it tests for.
- [x] **[HIGH] T3.4a's `finally` wrapped the whole per-run loop**, so one truncated record skipped
  teardown for every remaining run — in the test that SIGKILLs dispatches mid-flight.
- [x] **[HIGH] `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)` could not fail** while its comment
  claimed it was "GENUINELY falsifiable".
- [x] [MED] T3.3 built a `RunRecordStore` without the `workspace !== ""` guard, so a failed
  `tmpWorkspace` pointed it at `$PWD/runs` and **revoked real keys belonging to unrelated runs**;
  T5's tamper guard whitelisted five porcelain prefixes and missed `MM`/`AM`/`R `/`" D"`/`UU`;
  `keyLeakProblems` was made total at the callee, closing seven unguarded `await`s in one move.

### False positives — verified against real source, and why they must not be re-raised

- **`redactAssignments` "misses an assignment preceded by `&`/`;`".** `SECRET_ENV`
  (`scripts/build-image.ts:83`) has the **identical** `(^|[\s|"'])` lead class, so
  `cd /app&&NPM_TOKEN=abc` never becomes a finding and nothing is printed. A detector gap, not a
  redaction leak. The value-extent half *is* real and is the BLOCKER above.
- **`keyLeakProblems` "an unguarded `await` — a 5xx escapes the `finally`".** The named path was
  already guarded: `listOnce()` only ever ran inside a `try` returning `{error}`. A *synchronous*
  throw did escape, so the remedy was adopted and the stated trigger recorded as refuted.
- **`store.get(vm)` is never awaited.** `RunRecordStore.get` is synchronous; the `catch` sees the
  ENOENT.
- **`PI_REVIEWED_SERIES` has "no binding test".** `setup-gate.test.ts:168-183` greps the constant out
  of the shell file and compares it to the series of the imported TS pin. The reviewer was blind to
  the test file. The script comment now names the test.
- **`imageFields`' `runId` overwritten by `emit`'s `runId: null`.** `...fields` spreads *after*, so
  `imageFields` wins — and the merged-shape test the reviewer asked for already exists.
- **`stillRunning()` "does not heartbeat the scan dir".** A directory's mtime moves when a child is
  created, and `inspectConfigs` writes a child on every `docker cp`. The `treeDir` half was real and
  is fixed.
- **`perIssueOverrides` case-sensitivity after the org rename.** `capForIssue` canonicalises both
  sides.
- **T3.1 as the consumer of the fanout blip change.** It plants a real marker; it does not simulate
  transport loss.
- Plus `IMAGE_REF_RE`'s out-of-range port and the round-4 carry-forwards (`B10` `tarUnescape`,
  `D3a` `redactSecrets`, `A14` publish-job split, `FP-1` `useConst`, `A17` dependabot) — none
  re-raised, none re-litigated.

### Deferred — real, with a reason and an owner

- **The #186 re-pin bundle** — everything above under *What the round refused to do*, plus the eight
  image-content items already on that issue (pi checksum, `After=` vs `Requires=`, the
  `EnvironmentFile=` `-` prefix, systemd hardening, `TimeoutStopSec`/`KillMode`, `%i` quoting, the
  `[Install]` stanza, the AC6 `DefaultEnvironment=`/`system.conf`/`.service.d` gap). Owner: **DF1.10**,
  at the re-pin it performs anyway. Patch banked; tripwires in place.
- **The environment branch-policy drift audit.** Still not detectable from CI; the required-reviewer
  rule is unobtainable on this plan (422). Round 6 hardened only the in-file prose.
- **Account-wide `hashesBefore`.** A concurrent operator's key still reads as this round's leak; the
  box half was scoped by R4's owned/strays split, the key half needs per-call-site decisions.

### Story-record corrections (acceptance auditor)

All 7 ACs verified **implemented** — every auditor finding was a truthfulness defect in this Dev
Agent Record, which is what DF1.10 inherits. Struck or corrected: the Status block's three false
claims (above); *The pin that shipped* naming a retired pin while the runs proving the current one
appeared nowhere; *What a human must do* items 3 and 4 written as open after being discharged;
*Signed provenance* describing `actions/attest-build-provenance` and a two-store verification the
code does not have (it is `cosign attest` keyless, one store); two build-script docblocks crediting
the same retired action; the fork-guard comment asserting a user-owned package the same PR refuted;
the `environment:` comment claiming a server-side reviewer rule that was measured unobtainable;
#186's list still deferring items round 4 landed; the marker specified as six keys when it ships
seven (`piSha256`); and round 4's "not yet copied into `_bmad-output/`" caveat.

Also corrected: the *Not an edge — DF2.3* note says "no DF2.3 code is touched", but this story added
the `mintRunKey` compensation block in `src/providers/credentials.ts`. The **claim about the
registry pull credential remains true** — it is a host operator credential, never a per-run mint —
but the sentence as written is now false and is scoped to the credential, not the file.

### Gates after the round

| gate | result |
|---|---|
| `bunx tsc --noEmit` | **0 errors** |
| `bunx biome check src/ scripts/ tests/ .github/ config/` | **clean, 310 files** |
| `bun test tests/` | **4282 pass / 24 fail**, 4352 across 138 files |
| the 24 failures, re-run isolated | **127 pass / 0 fail** — all `~5000 ms` timeouts in `tests/pr/`, `tests/phase-engine/test-results`, `tests/providers/cap-hit-demo`, `tests/reverify/plan`; none in a DF2.10 file. The documented load-flake signature. |
| `deriveBuildId` over the current tree | **`3cf094fb6990ed66`** — matches the repo pin exactly |
| `git status -- oci/exedev/` | **clean** — byte-identical to `dev` |
| `detect_changes` | 125 symbols, 38 processes, 48 files. Blast radius is inside DF2.10's own modules plus the four cleanup call sites the `resolveCleanupDriver` fix required. |

### What this round did NOT do, stated plainly

- **It did not run the live E2E suite.** Every finding here is static. The tier budgets, the
  `fleetLeftovers` poll and the `setEffectiveImage` wiring are the changes most in need of a live
  round, and none has met a real box.
- **It did not touch the image.** By design — see above. The image on ghcr is exactly what round 4
  published and the 2026-09-02 rounds proved.
- **It did not close the environment second-factor gap**, which no code change closes.
- **It did not verify the cosign-era provenance path end-to-end.** `verify-image-pin`'s three
  bindings (Fulcio SAN ref anchor, `slsa.dev/provenance/v1` predicate, `github-hosted` runner
  extension) were proven against the *pre-swap* producer; the round recorded that gap and named the
  single `workflow_dispatch` that closes it, but could not dispatch it.
