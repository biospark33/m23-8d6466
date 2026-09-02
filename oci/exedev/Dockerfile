# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# THE FRONTEND IS PINNED TOO. BuildKit PULLS AND EXECUTES the image named on the
# line above — it parses this file and drives the whole build, at higher
# privilege than anything below it. A floating `:1` re-resolved that executable
# on every cold build, in a file whose doctrine one paragraph down is
# "digest-pinned, never `:latest`". Resolved 2026-09-01 from `docker/dockerfile:1`
# (multi-arch index digest, image created 2026-07-29), so it still resolves
# per-platform. Re-resolve with `docker buildx imagetools inspect
# docker/dockerfile:1` and copy the top-level `Digest:`; bumping it is a
# reviewed diff like every other pin here. Deleting the line entirely would fall
# back to BuildKit's built-in frontend — a real option, since this file uses no
# frontend-specific feature except `COPY --chmod` — but it would move the
# frontend's version with whatever daemon happened to build, which is the drift
# a pin exists to stop.
#
# QDS-Factory exe.dev sandbox image (story DF2.10) — the substrate every
# factory box boots, built here, pinned by digest, and provable from inside.
#
# This is NOT oci/Dockerfile. That one is D7's enterprise client-VPC image
# (node:22-bookworm-slim, no systemd, USER node, npm pi 0.55.0). This is D8's
# exe.dev sandbox tier: systemd is PID 1, the login user is exedev, and pi is a
# compiled ELF. The two tiers do not converge and neither pins the other.
#
# DERIVE, DO NOT RE-DERIVE. exe.dev's boot contract is six properties:
#   (a) an entrypoint literally named `init`, so exetini execs rather than
#       forks it (inherited CMD ["/usr/local/bin/init"]),
#   (b) systemd reaching multi-user.target,
#   (c) a login user matching the `exe.dev/login-user` label,
#   (d) sshd present with ssh.service/ssh.socket masked and no baked host keys,
#   (e) an EMPTY-not-absent /etc/machine-id — removing it makes systemd treat
#       the boot as first-boot and re-enable every disabled unit,
#   (f) the x-systemd.growfs line in /etc/fstab.
# All six come free from FROM exeuntu. Every one of them is a SILENT boot
# failure if re-derived, "cleaned up", or re-declared here. This file therefore
# declares no CMD, no ENTRYPOINT, no USER, no WORKDIR, no EXPOSE, and touches
# neither /etc/machine-id nor /etc/fstab nor /etc/ssh.
#
# INV-IBOX-1 (no credential in a layer): nothing below declares an ENV or ARG
# holding a secret, writes an .npmrc, or copies a git credential. The per-run
# spend-capped LLM key arrives at RUNTIME at /home/exedev/app/.env, 0600, by
# DF2.3's delivery path. A build-time secret, if one is ever needed, uses a
# BuildKit --mount=type=secret — never an ENV/ARG value, which persists into
# the layer history.
#
# OUT OF SCOPE HERE, owned by DF1.10 (single owner, do not add them):
# the engine binary, the engine build stage, the pi catalog directory
# QDS_PI_CATALOG_DIR names, and cli-anything/scripts/. Adding any of them makes
# this digest un-buildable until the engine exists.
#
# Built for linux/amd64 — exe.dev boxes are x86_64 and the bun artifact below
# is bun-linux-x64. Nothing here reads the host arch; the build script passes
# --platform linux/amd64.

# F: digest-pinned, never `:latest`. Upstream runs a weekly no-cache cron
# rebuild, so the mutable tag re-resolves every OS package, pi, and the boot
# contract itself on any cold build — the exact drift this story exists to
# stop. This is the multi-arch INDEX digest, so it still resolves per-platform.
#
# BUMP PROCEDURE: `docker buildx imagetools inspect ghcr.io/boldsoftware/exeuntu:latest`
# and copy the top-level `Digest:` into the FROM line below. Then rebuild via
# scripts/build-exedev-image.ts — the license sweep re-classifies the new
# filesystem and the build fails if anything left policy. The published digest
# changes, so the repo pin and its buildId pair must be re-recorded together.
# THEN RE-PUSH THE PRIVATE MIRROR: AC4's live leg
# (tests/fleet/e2e/tier1-registry-auth.live.test.ts) derives its ref from the
# repo pin's digest, so `ghcr.io/quantum-digital-solutions/qds-exedev-private` must carry the
# NEW digest's bytes or that test fails "manifest unknown" — a green build with
# a red AC4 and nothing pointing at the missing step. Same for anything else
# pinned to the old digest. (This applies to any edit to THIS FILE or to
# oci/exedev/systemd/*, not only a base bump: both are `deriveBuildId` inputs,
# so their bytes move the buildId the box reports and the marker gate compares.)
FROM ghcr.io/boldsoftware/exeuntu@sha256:bd447a7715e40984673e29d817b73eb3611bdcf834929821ddc9b204fc5ec72a

# Overrides the base's org.opencontainers.image.* provenance, which points at
# boldsoftware/exe. This is our artifact now and must say so. The exe.dev/*
# labels are NOT touched: `exe.dev/login-user=exedev` is boot-contract item (c)
# above, and `exe.dev/install-shelley=true` is KEPT (AC7b) — exe.dev documents
# it as controlling Shelley auto-install and UI affordances only, no evidence
# ties it to boot or ssh, and "unknown" is not a reason to drop a label whose
# removal we have never booted a box without.
#
# `licenses` is NOASSERTION, not MIT. The label is spec'd as the license of the
# CONTAINED SOFTWARE, as a single SPDX expression, and this image contains an
# entire Ubuntu userland (Go toolchain, python3, perl, coreutils — GPL/LGPL)
# plus a bun that statically links LGPL-2.0-or-later JavaScriptCore. The
# attribution table this same story ships says outright that "a single
# identifier cannot honestly carry a static-link graph"; stamping MIT here would
# have contradicted it in the one machine-readable license claim the image
# makes, and a downstream consumer scraping labels for compliance would have
# read MIT and missed the LGPL relink obligation. NOASSERTION is a valid SPDX
# expression meaning exactly "not determinable as one expression". The real
# artifact is oci/exedev/binary-licenses.json and the generated NOTICE — see
# oci/license-texts/ for the canonical texts behind them.
LABEL org.opencontainers.image.title="qds-exedev" \
      org.opencontainers.image.description="QDS-Factory exe.dev sandbox substrate: exeuntu + pinned bun + pinned pi + qds-run supervision assets" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.source="https://github.com/Quantum-Digital-Solutions/QDS-Factory"

# ── bun ─────────────────────────────────────────────────────────────────────
# The repo's OWN pin, not a floating install: package.json `packageManager` is
# bun@1.3.13 and .github/workflows/ci.yml pins 1.3.13 in both jobs. The in-box
# engine must run the runtime the tests ran on. The probe's 1.4.0 was an
# install measurement, not a pin.
ARG BUN_VERSION=1.3.13
# sha256 of bun-linux-x64.zip for the release above, taken from that release's
# SHASUMS256.txt and recorded here so the check is against an in-repo constant
# rather than a file fetched from the same host as the artifact. Re-measure it
# when BUN_VERSION moves; a stale value fails the build loudly, which is the
# point.
ARG BUN_SHA256=79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a
#
# Deliberately NOT `curl https://bun.sh/install | bash`. Two reasons, both
# measured: that script resolves "latest" (unpinned — AC2's negative control),
# and it makes bun reachable only by appending to ~/.bashrc / ~/.zshrc. A
# non-interactive `ssh box "bun --version"` — which is exactly how the setup
# gate and the fleet driver invoke everything — reads NO shell rc file. bun
# must be on the default PATH for a bare non-login ssh command, so it is
# installed to /usr/local/bin, which is already first on the inherited PATH.
RUN cd /tmp \
 && curl -fsSL --retry 3 -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  bun.zip" | sha256sum -c - \
 && unzip -q bun.zip \
 && install -m 0755 -o root -g root bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
 && [ "$(command -v bun)" = "/usr/local/bin/bun" ]

# ── pi ──────────────────────────────────────────────────────────────────────
# The version measured live on a real exe.dev box on 2026-08-31. Pinning it
# here retires the setup gate's "requires pi 0.55.0" drift against a substrate
# that has shipped 0.84.x for months: the version is now ours, so a bump is a
# reviewed diff rather than whatever the vendor's weekly rebuild pulled in.
ARG PI_VERSION=0.84.4
#
# `exeuntu update pi` is the VENDOR-SUPPORTED pin point (`exeuntu update pi
# --home <dir> --version <v>`). Deliberately not a curl'd pi installer: the
# vendor owns where pi lands and how the /usr/local/bin/pi symlink is built,
# and re-deriving that is how gate B breaks silently.
#
# MEASURED GOTCHA: run as-is on the stock image this fails with
#   move existing pi install aside: rename /home/exedev/.local/pi
#   /home/exedev/.local/pi.old: invalid cross-device link
# That is overlayfs, not exeuntu: the existing pi tree lives in a lower layer,
# and overlayfs cannot rename a whole lower-layer DIRECTORY without redirect_dir.
# It works fine on a real box's ext4. Removing the stock install first gives
# exeuntu its fresh-install path, which has no rename in it. If the update
# fails, the build fails with no pi at all — loudly, never a half-pinned image.
#
# exeuntu writes the new tree as root; the stock one is exedev-owned and pi
# runs as exedev, so ownership is restored — but ONLY over the tree the comment
# is about, /home/exedev/.local/pi. The `-R` used to cover the whole of
# /home/exedev/.local, which is broader than the stated need. HONEST LIMIT: this
# narrowing does NOT make pi tamper-proof against the login user. exedev owns
# its own $HOME, so it can still unlink and replace anything under it —
# including /home/exedev/.local/bin/pi, the real file behind the root-owned
# /usr/local/bin/pi symlink — and exedev is the user that runs agent-authored
# code in-box, so a ROOT-context `pi` would execute bytes an unprivileged user
# could rewrite. Closing that needs pi installed outside $HOME into root-owned
# directories the way bun is (/usr/local/bin), which means not using
# `exeuntu update pi` — the vendor-supported pin point, whose ownership of the
# install layout is the reason gate B does not break silently. Not traded away
# here; recorded as the seam.
#
# The trailing assertions are the real contract: setup-gate.ts gate B does
# `command -v pi` and judges pi on CONTENT, so pi moving off /usr/local/bin
# would break the gate silently.
#
# INTEGRITY, STATED HONESTLY: unlike bun, this install has NO content gate.
# `exeuntu update pi --version` fetches a GitHub release asset, a release
# tag/asset is mutable, and the assertions below check PLACEMENT (`-L`, `-x`,
# `command -v`) and never CONTENT — while the marker's `piVersion` is a
# self-report from the binary in question. pi is the agent binary that runs with
# the per-run LLM key, so this is the highest-value artifact in the image.
# There is no upstream-published checksum to pin, and an `ARG PI_SHA256=""` that
# skips the check when empty is exactly the documented bypass this repo refuses
# elsewhere. So what happens instead is a RECORD, NOT A VERIFICATION: the marker
# RUN below stamps the sha256 of the installed pi binary into
# /etc/qds-image.json, which makes drift between two builds of the same
# PI_VERSION detectable and auditable after the fact. NOTHING REFUSES A BUILD ON
# IT. Upgrading it to a gate needs one thing — an upstream digest for
# pi-linux-x64, pinned in-repo the way BUN_SHA256 was (measured from the
# release's own SHASUMS file, recorded here as a constant) — at which point this
# step gains bun's `sha256sum -c -` refusal and the record becomes the check.
#
# The node_modules removal is DF2.9's `--omit=optional`, applied to a channel
# that has no --omit. Both the stock base and `exeuntu update pi` land exactly
# one package there — @mariozechner/clipboard@0.3.9 — which DF2.9 found
# UNATTRIBUTABLE: no authoritative license text exists anywhere in its chain
# (license-sweep.ts, CLIPBOARD_PREFIX). The enterprise tier survives it because
# `--omit=optional` drops it; here the install is a compiled ELF, so the only
# equivalent is to delete the tree — IN THIS RUN, because a `rm` in a later
# layer whites the path out while leaving the bytes in this one, and the AC5
# sweep reads the image's exported filesystem.
#
# MEASURED (2026-08-31, this image, linux/amd64) that pi does not need it: the
# ELF carries one dynamic `require("@mariozechner/clipboard")`, inside
# `loadClipboardNative`, whose every call is wrapped in `try {} catch {}` and
# which is reached only when `process.env.DISPLAY || process.env.WAYLAND_DISPLAY`
# is set. A factory box is headless, so the branch never runs at all — and with
# DISPLAY forced, `pi --version`, `pi --list-models` and `pi --help` are still
# byte-identical with the tree present and absent. Upstream agrees on the
# classification: pi's own package.json lists it under `optionalDependencies`,
# not `dependencies`. This deletes a 1.6 MB display-only surface, not a
# dependency.
RUN rm -rf /home/exedev/.local/pi /home/exedev/.local/pi.old \
 && exeuntu update pi --home /home/exedev --version "${PI_VERSION}" \
 && rm -rf /home/exedev/.local/pi/node_modules \
 && chown -R exedev:exedev /home/exedev/.local/pi \
 && [ -L /usr/local/bin/pi ] \
 && [ -x "$(readlink -f /usr/local/bin/pi)" ] \
 && [ "$(command -v pi)" = "/usr/local/bin/pi" ]

# ── INV-IBOX-1: inherited base test fixtures carrying private keys ──────────
# These are PRIVATE KEYS the stock exeuntu base ships — Python test suites, the
# Go stdlib's crypto testdata, and Perl/h2 doc examples. They are well-known
# PUBLIC fixtures that grant access to nothing of ours, but they ARE private
# keys and the content-based INV-IBOX-1 scanner is RIGHT to flag them: it judges
# bytes, and it cannot know a `BEGIN … PRIVATE KEY` is a fixture. So they are
# DELETED, not allow-listed. An allowlist is exactly the suppression this gate
# exists to prevent — it would silence this shape of finding permanently, and
# the next real key to land on one of these paths would ship unremarked. A
# factory box runs a phase engine; it has no use for a Python test-suite TLS
# fixture or Go stdlib crypto testdata, so removing them is a genuine reduction
# in attack surface and image size, not a way to quiet a scanner.
#
# HONEST LIMIT: these bytes come from the BASE layer, so this `rm` cannot remove
# them from it — the base layer still holds them and `docker save` would still
# show them there. That is FINE and is why the check is where it is: the AC5/
# INV-IBOX-1 scan reads the FLATTENED filesystem via `docker export`, which is
# precisely what a booted box actually sees, and there the files are gone. The
# removal is effective for the box, which is the thing being secured.
#
# ONE `RUN`, deliberately not merged with anything else: it shares no layer with
# any step above because there is nothing to gain — unlike the pi node_modules
# removal, these bytes were never written by a layer of ours, so there is no
# same-layer requirement to satisfy.
#
# The list is DERIVED from the scanner's own output on this base (2026-08-31,
# linux/amd64), not guessed: 8 `credential inside …` findings plus the three
# h2 example symlinks (curio/localhost.key, tornado/server.key,
# twisted/server.key) that resolve to real keys once the scan follows links.
# Whole fixture DIRECTORIES are removed where the directory is unambiguously
# test/doc material; `platform_root_key.pem` is removed as a single file because
# it sits in the crypto/x509 SOURCE directory rather than a testdata/ one.
# `testdata/` is ignored by the go tool when building, so `go build` is
# unaffected — only the stdlib's own `go test` would miss them.
#
# Deliberately NOT touched: /etc/ssl, the CA trust store, and anything under
# /usr/local/bin. The CA store is public certificates, reads clean on content,
# and is load-bearing for every outbound TLS call the engine makes.
RUN rm -rf \
      /usr/lib/python3/dist-packages/tornado/test \
      /usr/lib/python3/dist-packages/twisted/test \
      /usr/local/go/src/crypto/tls/testdata \
      /usr/local/go/src/crypto/x509/platform_root_key.pem \
      /usr/share/doc/libnet-ssleay-perl/examples \
      /usr/share/doc/python3-h2/examples

# ── supervision assets (AC6) ────────────────────────────────────────────────
# Shipped IN THE IMAGE, enabled by nothing. DF2.10 starts no instance: there is
# no `systemctl enable`, and the unit has no ExecStart because DF1.10 owns the
# engine. The tmpfiles entry is the one that must fire on its own — DF1.11's
# re-provision converges on its exact bytes and `provisionSteeringChannel`
# stays in the driver as a zero-diff image-regression tripwire.
COPY --chmod=0644 oci/exedev/systemd/qds-run@.service /etc/systemd/system/qds-run@.service
COPY --chmod=0644 oci/exedev/systemd/qds-steering.conf /etc/tmpfiles.d/qds-steering.conf

# DoD (a): a malformed unit would otherwise surface first in DF1.10, on a real
# box, mid-run. Verify it here, at build time, as a hard failure.
#
# The shipped unit has NO ExecStart (DF1.10's), and systemd refuses that
# outright — measured: "Service has no ExecStart=, ExecStop=, or
# SuccessAction=. Refusing." (exit 1). Resolved honestly: verify a THROWAWAY
# copy that appends a second [Service] stanza carrying the ExecStart contract
# path, backed by a throwaway executable, and delete both inside this same RUN
# so neither reaches the layer. systemd merges repeated section headers, so the
# appended stanza lands in [Service] without editing the shipped file. This
# checks every directive DF2.10 actually ships; DF1.10 re-verifies once its
# real ExecStart exists. A stub binary is NOT shipped — the setup gate could
# not tell a stub from an engine, and the verify is not weakened to accept a
# unit systemd would refuse to load.
#
# MEASURED: `systemd-analyze verify` exits NON-ZERO only for the load-refusing
# class. A merely unparseable directive — e.g. `Type=bogus` — is reported as
# "Failed to parse service type, ignoring" and still exits 0, which would let a
# typo'd supervision directive ship and surface first on a real box mid-run.
# So the exit code alone is not the check: verify must also be SILENT. A clean
# unit produces no output at all (measured), so any output is a finding.
RUN cp /etc/systemd/system/qds-run@.service /tmp/qds-verify@.service \
 && printf '%s\n' '[Service]' 'ExecStart=/usr/local/bin/qds-engine run %i' \
      >> /tmp/qds-verify@.service \
 && printf '%s\n' '#!/bin/sh' 'exit 0' > /tmp/qds-engine-throwaway \
 && install -m 0755 /tmp/qds-engine-throwaway /usr/local/bin/qds-engine \
 && verify_out="$(systemd-analyze verify /tmp/qds-verify@.service 2>&1)" \
 && { [ -z "${verify_out}" ] \
      || { echo "unit verify was not clean: ${verify_out}" >&2; exit 1; }; } \
 && rm -f /usr/local/bin/qds-engine /tmp/qds-engine-throwaway /tmp/qds-verify@.service \
 && [ ! -e /usr/local/bin/qds-engine ]

# DoD (b): validate the tmpfiles entry.
#
# MEASURED: `--dry-run` does not exist in systemd 255 (255.4-1ubuntu8.17, what
# this base ships); it landed in v256. So the real `--create` runs here in the
# build sandbox and its result is removed in the same RUN — /run is a tmpfs at
# boot anyway, so a baked directory would be masked and prove nothing. This is
# strictly stronger than a parse check: it asserts the mode and ownership the
# entry actually produces, which is what DF1.11 and the reboot proof depend on.
# Negative control is measured, not assumed: a malformed line exits 65.
RUN systemd-tmpfiles --create /etc/tmpfiles.d/qds-steering.conf \
 && [ "$(stat -c '%a %U %G' /run/steering)" = "700 exedev exedev" ] \
 && rmdir /run/steering

# ── the identity marker (INV-IBOX-2) ────────────────────────────────────────
# A box CANNOT read the digest it was pulled from, so without this file no
# in-box assertion about image identity can exist at all. It also cannot carry
# that digest: the digest is the hash of the manifest containing this file, so
# baking it would change it. It carries a build-generated buildId instead; the
# publish workflow records the digest <-> buildId pair as the repo pin. Host
# enforces the digest at pull, box proves the buildId, and neither drifts from
# the other without gate B saying so.
#
# Build-time only. These are ARG, never ENV: an ENV would persist into the
# image and, for the QDS_-prefixed ones, violate AC6 outright.
ARG QDS_IMAGE_REF
ARG QDS_BUILD_ID
ARG QDS_GIT_SHA
ARG QDS_BUILT_AT
#
# piVersion/bunVersion are the versions OBSERVED IN THE IMAGE, parsed from the
# installed binaries — not the ARG strings echoed back. A marker that repeats
# its own input proves nothing: it would read 1.3.13 on an image where the bun
# install silently no-op'd. The equality assertions are the pin being enforced
# rather than asserted; the values written are the ones the box will actually
# run. Empty-ARG guards keep a build that forgot to pass them from baking a
# marker that identifies nothing.
#
# `piSha256` is the sha256 of the pi binary the symlink actually resolves to —
# a RECORD, not a gate (see the pi step's INTEGRITY note). It is the one field
# here nothing compares against anything: pi is installed with no content check,
# so this is what makes drift between two builds of the same PI_VERSION visible
# at all. It is deliberately NOT asserted equal to a constant — an equality
# against a value measured from the same unverified install would be a check
# that can only ever pass. Readers: `piVersion` is pi's self-report, `piSha256`
# is the bytes; only the second one can be corroborated against a future
# upstream digest.
#
# jq builds the JSON so no value can break quoting, and the size assert holds
# the file under gate B's 4 KiB read cap — a marker the gate refuses to read is
# a marker that fails closed on every box. `parseImageMarker`
# (src/providers/exedev/transport.ts) reads six named keys and ignores the rest,
# so this extra field is additive: it cannot fail a gate that does not know it.
RUN [ -n "${QDS_IMAGE_REF}" ] && [ -n "${QDS_BUILD_ID}" ] \
 && [ -n "${QDS_GIT_SHA}" ] && [ -n "${QDS_BUILT_AT}" ] \
 && pi_observed="$(pi --version)" \
 && bun_observed="$(bun --version)" \
 && [ "${pi_observed}" = "${PI_VERSION}" ] \
 && [ "${bun_observed}" = "${BUN_VERSION}" ] \
 && pi_sha256="$(sha256sum "$(readlink -f /usr/local/bin/pi)" | cut -d' ' -f1)" \
 && [ -n "${pi_sha256}" ] \
 && jq -n \
      --arg imageRef  "${QDS_IMAGE_REF}" \
      --arg buildId   "${QDS_BUILD_ID}" \
      --arg piVersion "${pi_observed}" \
      --arg piSha256  "${pi_sha256}" \
      --arg bunVersion "${bun_observed}" \
      --arg builtAt   "${QDS_BUILT_AT}" \
      --arg gitSha    "${QDS_GIT_SHA}" \
      '{imageRef:$imageRef, buildId:$buildId, piVersion:$piVersion, piSha256:$piSha256, bunVersion:$bunVersion, builtAt:$builtAt, gitSha:$gitSha}' \
      > /etc/qds-image.json \
 && chmod 0644 /etc/qds-image.json \
 && chown root:root /etc/qds-image.json \
 && [ "$(stat -c '%s' /etc/qds-image.json)" -lt 4096 ]

# ── AC6: no QDS_* path variable anywhere the box can inherit one ────────────
# DF1.11's INV-IBOX-13 and DF3.7's AC4 both rest on the engine resolving its
# own run root and steering root rather than inheriting them from the
# substrate, and ONLY the story that builds the image can guarantee that.
#
# This is the LAST RUN in the file on purpose. Build ARGs appear in a RUN's
# environment exactly as an ENV would, so the four QDS_* build args above are
# allow-listed by name and everything else matching ^QDS_ fails the build —
# which is precisely how an accidental `ENV QDS_RUN_ROOT=...` added anywhere
# above this line gets caught. Anything added BELOW this line is unchecked, so
# nothing goes below it.
#
# WHAT IS AND IS NOT COVERED. An earlier version of this comment claimed four
# surfaces were "the complete set of ways a QDS_* variable reaches a booted box
# from this image". They were not, and the two it missed are the ones that
# actually reach a `qds-run@` INSTANCE: systemd sources neither /etc/environment
# nor /etc/profile.d for a system service. What a booted unit inherits comes
# from the manager's own configuration and its drop-in directory (a manager-wide
# default environment reaches EVERY unit) and from per-unit drop-in directories,
# which systemd merges into qds-run@.service at load time — DF1.10 adding
# `Environment=QDS_RUN_ROOT=…` in a drop-in is the concrete case, and the
# shipped unit points at this build-time assertion as its only enforcement.
# So the checks below are:
#
#   1. the image environment (a stray ENV, or a build ARG that is not one of the
#      four marker args);
#   2. /etc/systemd/ RECURSIVELY, for any Environment-family DIRECTIVE naming a
#      QDS_ variable. One recursive pass covers the manager configuration, its
#      drop-in directory, and every per-unit drop-in directory, without this
#      file having to enumerate paths that would then drift. Anchored on the
#      directive rather than on the bare token so the shipped unit's OWN
#      comments — which name QDS_RUN_ROOT and QDS_STEERING_ROOT while forbidding
#      them — are not findings. Ceiling: `grep -r` does not follow symlinks it
#      meets during recursion, so an enable-symlink into /usr/lib is not read;
#      those are vendor units this image does not write;
#   3. the shipped unit FILE, comment-stripped, for ANY QDS_ token in a
#      directive — stricter than (2), and the reason (2) does not replace it;
#   4. the tmpfiles entry;
#   5. the login/session files. This is not systemd's path, it is ssh's: bash
#      sources ~/.bashrc for a NON-INTERACTIVE `ssh box cmd`, which is exactly
#      how the setup gate and the fleet driver invoke everything — the same fact
#      the bun step above relies on when it argues bun must be on the default
#      PATH. So /etc/environment, /etc/profile, /etc/profile.d/, /etc/bash.bashrc
#      and the exedev user's own dotfiles are all read.
#
# NOT COVERED, stated rather than implied: a QDS_* variable delivered at RUNTIME
# — through the unit's EnvironmentFile= (DF2.3 writes that file on a live box),
# through a drop-in written after boot, or through `ssh box QDS_X=… cmd`. A
# build-time scan asserts what the IMAGE ships, never what a running box can be
# handed; DF1.11's INV-IBOX-13 and DF3.7's AC4 rest on the engine resolving its
# own roots, which is the invariant that survives all three.
RUN leaked="$(env | sed -n 's/^\(QDS_[A-Za-z0-9_]*\)=.*/\1/p' \
      | grep -vxE 'QDS_IMAGE_REF|QDS_BUILD_ID|QDS_GIT_SHA|QDS_BUILT_AT' || true)" \
 && { [ -z "${leaked}" ] || { echo "AC6: QDS_* set in image env: ${leaked}" >&2; exit 1; }; } \
 && { ! grep -rqE '^[[:space:]]*(Default)?Environment=.*QDS_' /etc/systemd/ 2>/dev/null \
      || { echo "AC6: QDS_* in a systemd environment directive under /etc/systemd" >&2; exit 1; }; } \
 && { ! grep -vE '^[[:space:]]*#' /etc/systemd/system/qds-run@.service \
        | grep -qE 'QDS_[A-Za-z0-9_]*' \
      || { echo "AC6: QDS_* in a qds-run@.service directive" >&2; exit 1; }; } \
 && { ! grep -qE 'QDS_[A-Za-z0-9_]*' /etc/tmpfiles.d/qds-steering.conf \
      || { echo "AC6: QDS_* in qds-steering.conf" >&2; exit 1; }; } \
 && { ! grep -rqE '^[[:space:]]*(export[[:space:]]+)?QDS_' \
        /etc/environment /etc/environment.d/ /etc/profile /etc/profile.d/ \
        /etc/bash.bashrc /home/exedev/.profile /home/exedev/.bashrc \
        /home/exedev/.bash_profile /home/exedev/.bash_login 2>/dev/null \
      || { echo "AC6: QDS_* in a login/session env file" >&2; exit 1; }; }
