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

1. **13 files touched, not 10.** The atomicity audit flagged DF2.10 as sitting *exactly* at the Files-to-Modify limit, so each of these crosses a gate line and is recorded rather than absorbed:
   - `src/providers/index.ts` — AC3 requires the override be read "at the registry factory", and that factory is here. `create()` stays free of `process.env`, which is AC3's negative control.
   - `tests/providers/exedev/fixtures/fake-exedev.ts` — its `new` matcher is **exact-anchored** (`/^new --name (\S+)( --tag (\S+))? --json$/`), so adding `--image` made every existing `create()` fall through to `exitCode 64`. Extended, still anchored — the anchoring catches argv drift and was kept deliberately.
   - `tests/fleet/e2e/tier1-image-contract.live.test.ts` — the DoD's MANDATORY e2e demo has no other home.
2. **`transport.ts` gained the marker contract instead of `driver.ts`.** `setup-gate.ts` holds only `import type { ExeDevDriver }`, so a value import from `driver.ts` would have been a real ESM cycle (`driver.ts` imports `setupGate`). `IMAGE_MARKER_PATH`, `IMAGE_MARKER_MAX_BYTES`, `QdsImageMarker`, `parseImageMarker`, `imageDigestOf` and `imageMarkerFailure` live in `transport.ts` — the LOW module both already import one-way, and where `readBoxFile` already lives — and are **re-exported from `driver.ts`**, so the module's public surface is unchanged. `DEFAULT_IMAGE_REF` stays in `driver.ts` as AC3 requires.
3. **Story anchors corrected.** AC3 cites `tag-invalid` as constructor validation at `driver.ts:239-255`; `tag` is a per-call argument validated *inside* `create()`. The real constructor precedent is `execTimeoutMs`/`hostSuffix` at `:191-196`, which is what `image`/`registryAuth` follow. `DEFAULT_EXEC_TIMEOUT_MS` is module-level in `transport.ts`, not `driver.ts:199` (that line is its constructor default assignment).
4. **`tests/oci/` does not exist.** Infra Prerequisites requires "`bun test tests/oci/` green before this story starts". DF2.9's suite is `tests/scripts/license-sweep.test.ts` (797 lines, 70 tests) — green throughout.
5. **TDD ordering.** The API contract was frozen and runtime-verified before either implementation or tests were written, then tests were authored **independently, by a separate agent, against that frozen spec** — stronger than self-written-after tests, but not literal test-first. Recorded rather than claimed otherwise.

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

`tests/fleet/e2e/tier1-image-contract.live.test.ts`, TIER-2 gated (gates C/D/E make real OpenRouter calls, so labelling it tier-1 would have been a false zero-spend claim). Two live rounds: the first failed on a test-harness defect having already proven the boot contract; the second passed end to end.

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

### Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | 0 |
| `bunx @biomejs/biome check src scripts tests` | 0 (299 files) |
| `bun test` (full suite) | 4791 tests / 159 files · **4758 pass · 8 skip · 25 todo · 0 fail**, exit 0. The pre-pin run had exactly one failure — the red-by-design sentinel asserting `DEFAULT_IMAGE_REF` is not the all-zeros placeholder — which turned green when the published digest was recorded. Nothing else in the repo regressed, which is the result that matters given `create()`'s measured blast radius below. Re-run after the attestation follow-up: **4758 pass · 0 fail**, exit 0, identical. A first attempt at load average 28–36 (Bitdefender scanning at 83 % CPU alongside a QEMU image build) produced 4 failures — `open-pr`, two gitnexus CLI spawns and a setup-gate chain, every one of them at bun's 5 s default timeout — all green on isolated re-run, and the gitnexus file passed identically with and without this follow-up's edits. That is the environmental class the live-e2e skill's gotcha #5 names, recorded rather than quietly re-run away. |
| GitNexus impact, `ExeDevDriver.create` | **HIGH** — 25 impacted symbols, 6 direct callers, 4 execution flows (`provisionAdmittedRun`, `dispatch`, `scripts/fleet.ts:run`, `scripts/cap-hit-demo.ts`). Edits are additive only (two conditional argv spreads, constructor validation); no signature change. Every caller now boots through the new pin, which is why AC1's fail-closed marker gate and the live boot proof are the load-bearing checks. |
| `bun scripts/build-exedev-image.ts` | exit 0 — sweep 0 packages, credential scan 0 findings |
| `docker build --platform linux/amd64` | exit 0, 1.60 GB |
| `bun scripts/build-exedev-image.ts` @ `7806bbee`, **before** the attestation follow-up | exit 0 — `builtDigest` = the published pin `sha256:a70674b2…` |
| `bun scripts/build-exedev-image.ts` @ `7806bbee`, **after** it | exit 0 — `builtDigest` **unchanged**, `buildId` `664876fb1a9128ec` |
| `actionlint .github/workflows/publish-exedev-image.yml` | 0 |
| Both new `run:` blocks, extracted from the YAML and exercised offline against stubbed `docker`/`gh` | The digest assertion: matching digest + image manifest → **0**; moved digest → **1**; **unchanged digest but an index `mediaType` → 1**, so the media-type arm is load-bearing on its own rather than a second spelling of the digest check. The verify loop: all-green → 2 `gh` calls (one per store) and exit 0; two transient failures → 4 calls, exit 0; permanent failure → 5 calls, exit 1. The all-green case is the regression test for a bug this follow-up wrote and caught — `[ … ] && args+=(…)` under `set -e` aborts the step on the *false* branch, which would have failed the GitHub-store leg every single run. |
| `zizmor --offline` on the same file | 4 `unpinned-uses` findings, **all pre-existing policy drift**: zizmor's blanket policy wants SHA pins, and every action in this repo is major-tagged (`actions/checkout@v7`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`). The added `actions/attest-build-provenance@v4` follows that convention rather than diverging from it inside one step. No injection, credential-persistence or permissions finding — the new steps take no event-controlled input. |
| In-image, bare non-login `sh -c` | `bun --version` = 1.3.13 · `pi --version` = 0.84.4 |
