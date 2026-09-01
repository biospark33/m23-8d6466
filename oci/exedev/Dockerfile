# syntax=docker/dockerfile:1
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
FROM ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d

# Overrides the base's org.opencontainers.image.* provenance, which points at
# boldsoftware/exe. This is our artifact now and must say so. The exe.dev/*
# labels are NOT touched: `exe.dev/login-user=exedev` is boot-contract item (c)
# above, and `exe.dev/install-shelley=true` is KEPT (AC7b) — exe.dev documents
# it as controlling Shelley auto-install and UI affordances only, no evidence
# ties it to boot or ssh, and "unknown" is not a reason to drop a label whose
# removal we have never booted a box without.
LABEL org.opencontainers.image.title="qds-exedev" \
      org.opencontainers.image.description="QDS-Factory exe.dev sandbox substrate: exeuntu + pinned bun + pinned pi + qds-run supervision assets" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/biospark33/QDS-Factory"

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
# runs as exedev, so ownership is restored. The trailing assertions are the
# real contract: setup-gate.ts gate B does `command -v pi` and judges pi on
# CONTENT, so pi moving off /usr/local/bin would break the gate silently.
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
 && chown -R exedev:exedev /home/exedev/.local \
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
# jq builds the JSON so no value can break quoting, and the size assert holds
# the file under gate B's 4 KiB read cap — a marker the gate refuses to read is
# a marker that fails closed on every box.
RUN [ -n "${QDS_IMAGE_REF}" ] && [ -n "${QDS_BUILD_ID}" ] \
 && [ -n "${QDS_GIT_SHA}" ] && [ -n "${QDS_BUILT_AT}" ] \
 && pi_observed="$(pi --version)" \
 && bun_observed="$(bun --version)" \
 && [ "${pi_observed}" = "${PI_VERSION}" ] \
 && [ "${bun_observed}" = "${BUN_VERSION}" ] \
 && jq -n \
      --arg imageRef  "${QDS_IMAGE_REF}" \
      --arg buildId   "${QDS_BUILD_ID}" \
      --arg piVersion "${pi_observed}" \
      --arg bunVersion "${bun_observed}" \
      --arg builtAt   "${QDS_BUILT_AT}" \
      --arg gitSha    "${QDS_GIT_SHA}" \
      '{imageRef:$imageRef, buildId:$buildId, piVersion:$piVersion, bunVersion:$bunVersion, builtAt:$builtAt, gitSha:$gitSha}' \
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
# The four surfaces checked are the complete set of ways a QDS_* variable
# reaches a booted box from this image: the image environment, the unit, the
# tmpfiles entry, and the login/session env files.
#
# Comment lines are stripped from the unit before grepping because the unit
# documents this very prohibition by naming QDS_RUN_ROOT and QDS_STEERING_ROOT.
# Only directives can set a variable, so only directives are judged.
RUN leaked="$(env | sed -n 's/^\(QDS_[A-Za-z0-9_]*\)=.*/\1/p' \
      | grep -vxE 'QDS_IMAGE_REF|QDS_BUILD_ID|QDS_GIT_SHA|QDS_BUILT_AT' || true)" \
 && { [ -z "${leaked}" ] || { echo "AC6: QDS_* set in image env: ${leaked}" >&2; exit 1; }; } \
 && { ! grep -vE '^[[:space:]]*#' /etc/systemd/system/qds-run@.service \
        | grep -qE 'QDS_[A-Za-z0-9_]*' \
      || { echo "AC6: QDS_* in a qds-run@.service directive" >&2; exit 1; }; } \
 && { ! grep -qE 'QDS_[A-Za-z0-9_]*' /etc/tmpfiles.d/qds-steering.conf \
      || { echo "AC6: QDS_* in qds-steering.conf" >&2; exit 1; }; } \
 && { ! grep -rqE '^[[:space:]]*(export[[:space:]]+)?QDS_' \
        /etc/environment /etc/profile.d/ 2>/dev/null \
      || { echo "AC6: QDS_* in /etc/environment or /etc/profile.d" >&2; exit 1; }; }
