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
publishes to ghcr.io. `create()` gains two conditional argv spreads — `--image` and `--registry-auth` — each validated in the constructor at
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
3. `create()` threads both flags as conditional spreads in the existing argv literal and validates each **in the constructor**: an image
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

- Every `create()` logs `{ requestId, runId, event, imageRef, imageDigest, registryAuthUsed }` — `event ∈ create_requested | create_shape | create_failed`. The registry credential never appears, in any field, under any event.
- `requestId` propagates from the caller onto every create event and onto the setup gate's marker assertion, so a boot regression joins to its image digest without a second key; errors carry `{ code, message, remediation }` (`image-invalid`, `registry-auth-invalid`, `image-marker-mismatch`).
- Sub-timings: `create_ms`, `boot_ready_ms`, `marker_assert_ms`. A field never evaluated reports `0`. There is no `image_pull_ms`: the pull happens host-side inside `ssh exe.dev new`, before the box exists, and nothing here can time it.

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

<!-- Empty placeholder — filled during development. -->
