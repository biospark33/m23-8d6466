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
# THE SLOT DF2.10 RESERVED IS NOW FILLED (DF1.10). The engine build stage, the
# engine binary, the pi catalog directory QDS_PI_CATALOG_DIR names and
# cli-anything/ all land below, above the AC6 scan. Two consequences a reader
# should have before the first FROM:
#   (1) this file is MULTI-STAGE now. `ARG BUN_VERSION` is declared in both
#       stages because an ARG is scoped per stage; scripts/build-exedev-image.ts
#       reads EVERY declaration and refuses a build when two disagree, so the
#       copies cannot drift silently.
#   (2) the buildId's input set is no longer the Dockerfile plus
#       oci/exedev/systemd/* — `deriveBuildId` now hashes every path this file
#       COPYs from the build context, which is what makes the engine's bytes
#       part of the image's identity (#186 item, KNOWN GAP 3 in that function).
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
# filesystem, the INV-IBOX-1 credential scan re-reads it, and the build fails if
# anything left policy. The credential scan finding you get on a base bump is
# most likely a fixture key the block below no longer deletes because the base
# MOVED it: that block asserts every path it removes still exists, so re-derive
# its list from the new scan rather than adding an allowlist. The published digest
# changes, so the repo pin and its buildId pair must be re-recorded together.
# THEN RE-PUSH THE PRIVATE MIRROR: AC4's live leg
# (tests/fleet/e2e/tier1-registry-auth.live.test.ts) derives its ref from the
# repo pin's digest, so `ghcr.io/quantum-digital-solutions/qds-exedev-private` must carry the
# NEW digest's bytes or that test fails "manifest unknown" — a green build with
# a red AC4 and nothing pointing at the missing step. Same for anything else
# pinned to the old digest. (This applies to any edit to THIS FILE, to
# oci/exedev/systemd/*, or to ANY path this file COPYs from the build context:
# all three are `deriveBuildId` inputs, so their bytes move the buildId the box
# reports and the marker gate compares.)
#
# TAG **AND** DIGEST, not the bare digest it used to be (#186 item 9). The
# digest is what pins; the tag is what dependabot's docker updater derives an
# update stream from, and it cannot derive one from a bare `@sha256:`. So the
# `/oci/exedev` entry in .github/dependabot.yml opened no PRs and the base pin
# aged with nothing watching it, while its own comment called it the intended
# early-warning signal for upstream's weekly rebuild. `:latest@sha256:…`
# resolves to exactly the same image — docker ignores the tag when a digest is
# present — so this changes nothing but these bytes, which is precisely why it
# had to ride a re-pin rather than land alone.
#
# ── STAGE 1 of 2: the engine builder. Discarded; only /out/qds-factory (the
# engine's shipped source tree and its node_modules), /out/qds-engine (the exec
# wrapper) and the pi catalog are copied out of it. ───────────────────────────
FROM ghcr.io/boldsoftware/exeuntu:latest@sha256:e10847fc58d2b728393edb21159ae2edd5bc42ea2d7c6fa4a1488235fb52715d AS engine

# THE SAME BUN THE IMAGE SHIPS, and the reason this install is duplicated below
# rather than shared. This stage does not compile anything into the artifact any
# more, but it still RESOLVES the engine's import closure (the probe at the end
# of this stage) and installs the node_modules that ships — both of which bun
# version-dependent. Resolving against one bun and running under another makes
# `/etc/qds-image.json`'s `bunVersion` (observed from /usr/local/bin/bun in the
# runtime stage) a claim about a runtime the check did not use. Same version,
# same checksum, same install line as the runtime stage's.
#
# NOT factored into a shared stage the runtime stage `COPY --from=`s: that
# would rewrite the runtime bun step, whose comment block is the load-bearing
# record of WHY bun is installed to /usr/local/bin rather than through
# bun.sh/install (non-interactive ssh reads no rc file). Two identical
# checksummed installs is the cheaper honesty. BUN_VERSION is kept in step by
# scripts/build-exedev-image.ts, which reads every ARG declaration and refuses
# on disagreement; BUN_SHA256 is kept in step by a test
# (tests/scripts/build-exedev-image.test.ts), because the script pins only the
# version.
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
RUN cd /tmp \
 && curl -fsSL --proto '=https' --proto-redir '=https' --max-time 300 --retry 3 -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  bun.zip" | sha256sum -c - \
 && unzip -q bun.zip \
 && install -m 0755 -o root -g root bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
 && [ "$(bun --version)" = "${BUN_VERSION}" ]

# pi's MODEL CATALOG (AC3), and it is the one artifact in this image with a
# BETTER integrity story than the binary it belongs to.
#
# WHY IT HAS TO BE STAGED AT ALL: `findBundledCatalogDir()`
# (src/phase-engine/roster/validate.ts) locates the catalog by walking up from
# the resolved `pi` binary looking for
# `node_modules/@earendil-works/pi-ai/dist/providers/data`. That layout exists
# for an npm install of pi. Here pi is a compiled ELF and the runtime stage
# deletes the one node_modules it does ship (DF2.9's unattributable clipboard
# package), so the walk finds nothing, `loadBundledCatalog` throws a RateError,
# the resident is DISABLED and every dispatch_task phase is refused. The
# failure is a refusal, not a degradation, and DF2.10's own e2e demo passes on
# an image without it — which is exactly why AC3 names it.
#
# WHERE IT COMES FROM: the npm package `@earendil-works/pi-ai`, which publishes
# `dist/providers/data/*.json` and — MEASURED 2026-09-03 — publishes version
# 0.84.4, the same version number as the pi release ARG PI_VERSION pins. So the
# catalog is version-matched to the binary by construction rather than by
# hoping. It is fetched as the registry tarball and `sha256sum -c`'d against an
# in-repo constant, the same shape as bun and deliberately unlike pi itself
# (whose install has no content gate at all — see the runtime stage's INTEGRITY
# note). Re-measure PI_AI_SHA256 whenever PI_VERSION moves; a stale value fails
# the build loudly inside sha256sum, which is the point.
#
# `.manifest.json` rides along and is inert: loadBundledCatalog skips every
# file whose name starts with `.`.
ARG PI_VERSION=0.84.4
ARG PI_AI_SHA256=dfd3c929cee5a7387199a0a24dfc1be2096f1ea8f59ffb8285198a0ed01ebf93
RUN cd /tmp \
 && curl -fsSL --proto '=https' --proto-redir '=https' --max-time 300 --retry 3 -o pi-ai.tgz \
      "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${PI_VERSION}.tgz" \
 && echo "${PI_AI_SHA256}  pi-ai.tgz" | sha256sum -c - \
 && mkdir -p /out/pi-catalog \
 && tar -xzf pi-ai.tgz -C /tmp package/dist/providers/data \
 && cp /tmp/package/dist/providers/data/*.json /out/pi-catalog/ \
 && rm -rf /tmp/pi-ai.tgz /tmp/package \
 && [ "$(find /out/pi-catalog -name '*.json' -not -name '.*' | wc -l)" -gt 10 ] \
 && chown -R root:root /out/pi-catalog \
 && chmod 0755 /out/pi-catalog \
 && chmod 0644 /out/pi-catalog/*.json

# THE ENGINE. AC2a's PRE-AGREED FALLBACK: system `bun` plus an UNBUNDLED source
# tree baked at a fixed image path, reached through a thin `exec` wrapper. NOT
# the compiled route, and not a plain bundle either. RECORDED HERE because AC2a
# requires the shipped route to be recorded.
#
# THE MEASUREMENT THAT DECIDES IT. `bun build --compile` collapses
# `import.meta.dir` to the binary's virtual root (`/$bunfs/root`) for every
# bundled module, entry and non-entry alike; a plain `bun build --target=bun`
# collapses it to the OUTPUT FILE's directory. Either way it becomes ONE value
# for the whole bundle — and the engine's import closure has two consumers that
# need DIFFERENT bases:
#
#   src/phase-engine/roster/schema.ts:319   resolve(import.meta.dir,"..","..","..")   three up
#   cli-anything/src/team-events.ts:46      join(import.meta.dir,"..","scripts",…)    one up
#
# No single value satisfies both, so no bundling route is available. Placing a
# bundle's output so that one of those joins happens to land on shipped bytes
# would leave the other wrong, and is the kind of cleverness nobody decodes at
# 3am. Only unbundled source preserves per-module `import.meta.dir`, which is
# what makes `buildTeamSpawn` correct WITHOUT modifying it — and the story
# forbids modifying it.
#
# The concrete failure this avoids: `buildTeamSpawn` returns
# `join(import.meta.dir,"..","scripts","team-lead-driver.ts")` for the
# QDS_TEAM_RUNNER=local runner, and `runTeamManifest` spawns that path as a
# SEPARATE `bun` process which cannot read a parent binary's virtual filesystem.
# Compiled, it computes `/$bunfs/scripts/team-lead-driver.ts` — a path on no
# filesystem — so every `dispatch_task` phase's team runner fails. That is the
# phase kind AC1, AC3 and the mandatory E2E slice all require.
#
# WHAT THIS ROUTE COSTS, stated rather than discovered later: the runtime image
# now carries a `node_modules` (yaml and zod, the engine closure's only bare
# specifiers), where the compiled route carried none. That is a real change to
# DF2.10's "no npm tree at all" property. It is not waved through — the AC5 gate
# in scripts/build-exedev-image.ts is NARROWED rather than removed: a tree is
# admitted only at this engine's known path, must sweep completely, and must
# carry zero denied/unresolved/missing-text findings. A tree anywhere else still
# fails the build.
#
# `bun install` runs against the checked-in lockfile with `--frozen-lockfile`,
# so this stage resolves nothing: a dependency that moved fails the build
# rather than entering the binary. `--production` drops devDependencies (the
# engine needs `yaml` and `zod`; biome and typescript are not shipped).
#
# The node_modules tree this creates DOES reach the published image now, under
# /opt/qds-factory/node_modules, because unbundled source has to resolve `yaml`
# and `zod` at run time. `--production` is therefore load-bearing rather than
# tidy: it is what keeps the shipped tree to the engine's real runtime closure
# instead of also publishing biome and typescript. The AC5 sweep in
# scripts/build-exedev-image.ts now sweeps and attributes this tree rather than
# asserting its absence.
#
# WORKDIR is safe HERE and only here. The header's "declares no WORKDIR" rule
# is about the runtime stage, where re-declaring one is boot-contract risk;
# this stage is discarded and nothing it sets reaches the published image.
WORKDIR /build
COPY package.json bun.lock ./
COPY cli-anything/package.json cli-anything/
COPY pi-vs-claude-code-vendor/package.json pi-vs-claude-code-vendor/
COPY visualizer/package.json visualizer/
RUN bun install --frozen-lockfile --production

# ENUMERATED, NOT `COPY src/`, and the reason is the re-pin ritual rather than
# image size. Every context path this file COPYs is a buildId input now, and
# `src/providers/exedev/driver.ts` is the file the PIN ADOPTION COMMIT edits: if
# its bytes fed the buildId, adopting a digest would move the buildId, the
# rebuild would produce a third one, and the gate could never converge — which
# is the exact "do not keep re-pinning, fix that" failure publish-exedev-image.yml
# warns about. The engine's transitive imports are the subtrees below and reach
# `src/providers` for exactly TWO files — `bounded-exec.ts` and `timeout.ts` —
# so excluding the rest of that directory is honest as well as necessary, and
# deliberately keeps `credentials.ts`, `harvest.ts`, `teardown.ts` and the whole
# `exedev/` driver out of a customer-facing box (verified: none of them is in the
# closure).
#
# CORRECTED at DF1.10's first real build. This comment previously said "MEASURED
# (bun's own module graph, 198 modules) … reach `src/providers` only for
# `bounded-exec.ts`". It named a measurement and was wrong: the build had never
# been run — not on the compiled route either — so the set had never once been
# executed. `timeout.ts` was missing and the stage refused. The word MEASURED is
# removed rather than re-applied to the new number, because what makes the set
# trustworthy is not this sentence but the probe at the end of this stage, which
# re-derives it on every build. An import that escapes this set fails the build
# loudly, naming the unresolved file — which is the right failure for a set that
# has to be maintained by hand.
# NOT `COPY scripts/`, and the narrowing is a DISCLOSURE decision rather than a
# size one. Under the retired compiled route this directory was copied whole and
# it did not matter: `bun build --compile` bundled only the entry's import
# closure into the ELF and this stage was discarded, so the other 18 scripts
# never reached the published image. Unbundled source has no such filter — a
# `cp -a scripts` would ship all of them INTO A CUSTOMER-FACING BOX, including
# `build-exedev-image.ts` (this image's own build, ghcr push and credential-scan
# logic) and `fleet.ts` (the whole host CLI, including key management). None of
# it is reachable from the engine and all of it describes the factory rather than
# the run.
#
# `scripts/lib/` is taken WHOLE rather than file-by-file, and that is deliberate.
# The engine's own entry reaches only `lib/cli-args.ts` and `lib/kill-tree.ts`,
# but `src/` reaches BACK into this directory — `src/fleet/fanout.ts:20` and
# `src/fleet/fleet-lock.ts:20` both import `lib/run-lock.ts`, and
# `cli-anything/src/runner.ts:2` imports `lib/kill-tree.ts`. A hand-picked file
# list would therefore have been wrong on its first day, and would break again
# on the next lib import someone adds. A directory cannot drift that way, and
# the resolution probe at the end of this stage is what proves the set is
# sufficient rather than merely plausible.
COPY scripts/pipeline-run.ts scripts/pipeline-run.ts
COPY scripts/lib/ scripts/lib/
COPY src/fleet/ src/fleet/
COPY src/lib/ src/lib/
COPY src/phase-engine/ src/phase-engine/
COPY src/providers/bounded-exec.ts src/providers/bounded-exec.ts
# `timeout.ts` is here because the FIRST REAL BUILD of this stage refused without
# it, which is the resolution probe below doing exactly its job:
#
#   error: Could not resolve: "../providers/timeout.ts"
#       at /out/qds-factory/src/fleet/attach.ts:49:29
#
# The comment above this COPY block used to claim, as a MEASUREMENT, that the
# engine "reach[es] `src/providers` only for `bounded-exec.ts`". That was false
# and had never been executed — the compiled route was never built either, so
# nothing had ever tested the set. Two files are needed, not one.
#
# WHY A SOURCEMAP READ WOULD HAVE MISSED IT, recorded because it nearly did:
# `bun build` RESOLVES every import and only then tree-shakes, so a module can be
# required to EXIST on disk while contributing no code to the output. Reading the
# bundle's `sources` therefore under-reports what the staged tree must contain —
# it lists what survived, not what had to resolve. `src/fleet/attach.ts` is
# exactly that case. The set below was converged by replicating this stage's COPY
# set in a scratch tree and re-running the probe until it passed, which is the
# only method that measures the same property the build does.
COPY src/providers/timeout.ts src/providers/timeout.ts
# The 2026-09-18 publish (post-DF5.3 merge) refused at this stage's probe the
# same way the timeout precedent above did — `error: Could not resolve:
# "../src/providers/step-log.ts"` — because the engine's provider reach grew
# past the two-file set and no offline check walks this COPY enumeration
# against the import graph (the buildId walk hashes the Dockerfile as ONE
# input; it does not parse its COPY set). Five additions, converged by the
# same scratch-tree probe loop this file already documents:
#   step-log.ts     — redaction/echo primitives; pulled by src/fleet/{verbs,status}
#                     and scripts/pipeline-run.ts itself
#   cap-rejection.ts— sibling import of step-log.ts
#   run-record.ts   — the record store, reached through the src/fleet chain
#   fs-atomic.ts    — sibling import of run-record.ts
#   src/swarmclaw/  — the structured log sink; imported as ../swarmclaw/log.ts
#                     from nine files under src/fleet/
COPY src/providers/step-log.ts src/providers/step-log.ts
COPY src/providers/cap-rejection.ts src/providers/cap-rejection.ts
COPY src/providers/run-record.ts src/providers/run-record.ts
COPY src/providers/fs-atomic.ts src/providers/fs-atomic.ts
# The 2026-09-24 publish (post-#284 rig_swarm S1 merge) refused at this stage's
# probe the same way the 2026-09-18 precedent above did — `error: Could not
# resolve: "../../providers/credentials.ts"` at
# src/phase-engine/phases/openrig-swarm.ts:32 — because S1's two new phase
# bodies import the credentials module into the engine's bundle graph for the
# first time (SWARM_SEAT_KEYS_ENV, usdToMicros), and credentials.ts drags its
# own provider-family closure in with it. Seven additions. This time converged
# WITHOUT the scratch-tree probe loop's iteration: a Bun.build onResolve plugin
# recorded every import edge bun must RESOLVE (sourcemap sources under-report —
# see the tree-shake note above) for both probe entry points, the resolved set
# was diffed against this COPY enumeration, and the scratch-tree probe ran once
# on the completed set:
#   credentials.ts  — imported directly by the S1 phase bodies
#                     (openrig-swarm.ts, openrig-cost.ts)
#   errors.ts       — sibling import of credentials.ts (ProviderError)
#   driver.ts       — sibling import of credentials.ts; provider entry
#   harvest.ts      — reached through the provider chain (evidence harvest)
#   path-guard.ts   — sibling import of credentials.ts (assertPlainBoxPath)
#   quota.ts        — sibling import of driver.ts
#   viz-guard.ts    — sibling import of driver.ts
COPY src/providers/credentials.ts src/providers/credentials.ts
COPY src/providers/errors.ts src/providers/errors.ts
COPY src/providers/driver.ts src/providers/driver.ts
COPY src/providers/harvest.ts src/providers/harvest.ts
COPY src/providers/path-guard.ts src/providers/path-guard.ts
COPY src/providers/quota.ts src/providers/quota.ts
# Q1: quota.ts's import closure gained quota-intents.ts (the cross-process
# VM-headroom intent record) — the resolution probe refused on
# "./quota-intents.ts" at the post-Q1 build until this line landed.
COPY src/providers/quota-intents.ts src/providers/quota-intents.ts
COPY src/providers/viz-guard.ts src/providers/viz-guard.ts
COPY src/swarmclaw/ src/swarmclaw/
COPY cli-anything/src/ cli-anything/src/
COPY cli-anything/scripts/ cli-anything/scripts/
COPY pi-vs-claude-code-vendor/coms-core.ts pi-vs-claude-code-vendor/coms-core.ts
# ASSEMBLE THE SHIPPED TREE, rather than compile or bundle it. The layout under
# /out/qds-factory is the REPO's layout, byte for byte and depth for depth, and
# that is the whole mechanism — see the route note above `COPY scripts/`.
#
# Modes are set HERE, in the discarded stage, for the reason the runtime stage's
# pi-catalog copy already gives: `--chmod` on a directory COPY applies to the
# directory too, and a 0644 directory cannot be traversed. Set once, asserted in
# the runtime stage, so the assertion stays an assertion rather than a chmod
# verifying its own effect.
#
# 0644 FILES, root:root, and no execute bit anywhere in the tree: this is source
# read by an interpreter, never executed directly. `exedev` — the user that runs
# agent-authored code — must not be able to rewrite the engine it runs, which is
# the same ownership argument the runtime stage makes for the bun and pi
# binaries.
#
# TWO PACKAGES, NOT THE INSTALLED TREE, and the difference is 243 MB and 262
# packages. `bun install --production` at a WORKSPACE ROOT resolves every
# workspace's runtime closure, not this entry's: MEASURED at 264 package
# directories including vue, typescript, openai, protobufjs, koffi and pi-ai —
# visualizer's and pi-vs-claude-code-vendor's dependencies, none of which the
# engine imports. Shipping them would put a large third-party surface, and a
# correspondingly large attribution obligation, into a customer-facing box to
# satisfy two imports.
#
# The engine's runtime closure is exactly `yaml` and `zod` (MEASURED: the only
# bare specifiers anywhere in the entry's import graph, 3 and 10 sites), and
# both are dependency-free at the pinned versions, so the copied set is closed
# with no transitive walk to get wrong. The versions still come from the
# `--frozen-lockfile` install above, so this is a NARROWING of that resolution,
# never a second one that could drift from it.
#
# The RESOLUTION PROBE is what makes the narrowing safe rather than a guess, and
# it is the load-bearing line here. `bun build` is NOT a delivery step — its
# output goes to /tmp and is deleted on the next line. It resolves the entry's
# entire import closure against the SHIPPED tree at the SHIPPED path, so a THIRD
# bare specifier added by some future import, a source file left out of the COPY
# set above, or a workspace symlink that did not survive the copy fails the build
# HERE, naming what did not resolve — instead of failing on a paid box at the
# first phase walk. Adding a dependency to the engine is therefore a loud build
# failure that names it, not a silent runtime one.
#
# TWO ENTRIES, NOT ONE, and the second is the one that is easy to forget.
# `team-lead-driver.ts` is never IMPORTED by the engine — `buildTeamSpawn`
# hands its path to a SEPARATE `bun` process — so resolving the engine's graph
# says nothing about it, and a bare specifier added to that file (or to
# `redact.ts`/`env.ts` beneath it) would fail for the first time in a box,
# mid-`dispatch_task`, after spend. Its closure is `node:*` and relative
# imports only today; this line is what keeps that true.
#
# It proves resolution; whether the engine does the right thing is the live
# round's job.
#
# F-D4 (#217): the root package.json and bun.lock are NOT copied. Round 1
# verified no repo code reads them; this re-pin verified BUN does not consult
# them either — measured: `bun <explicit .ts entry>` against a sibling
# node_modules resolves bare specifiers from the directory walk alone (the
# same property the resolution probe below proves against the SHIPPED tree in
# the same RUN). They are INSTALL-TIME inputs, not runtime ones, and shipping
# them to a customer-facing box would hand the workload the factory's whole
# dependency manifest (the exact disclosure argument behind the COPY scripts/
# narrowing). cli-anything's OWN package.json rides inside cli-anything/ and
# is a different fact.
#
# R3-a (#217): the installed yaml+zod tree is CHECKSUM-GATED at the same seam
# BUN_SHA256 gates the bun download — an assert-and-refuse over the aggregate
# of every file under node_modules/{yaml,zod}. The registry (or a mirror, or a
# MITM'd registry) serving different bytes for the same locked version
# therefore refuses the build instead of building a different image under a
# byte-identical buildId: deriveBuildId hashes the Dockerfile and unit bytes,
# never the network-fetched tree. TOFU, stated like BUN_SHA256's: the constant
# was measured from a --frozen-lockfile install of this bun.lock and pinned
# here; an upstream republish that moves a tarball moves this gate loudly.
ARG QDS_ENGINE_TREE_SHA256=fd720c6f44efa661f886991670cc4d42660627f4f05eb6c5653da00347a2fe64
RUN set -e; \
    mkdir -p /out/qds-factory/node_modules; \
    cp -a scripts src cli-anything pi-vs-claude-code-vendor /out/qds-factory/; \
    cp -a node_modules/yaml node_modules/zod /out/qds-factory/node_modules/; \
    [ ! -e /out/qds-factory/package.json ] || { echo "F-D4: the root package.json reached /opt/qds-factory" >&2; exit 1; }; \
    [ ! -e /out/qds-factory/bun.lock ] || { echo "F-D4: the root bun.lock reached /opt/qds-factory" >&2; exit 1; }; \
    tree="$(cd /out/qds-factory/node_modules && find yaml zod -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"; \
    [ "${tree}" = "${QDS_ENGINE_TREE_SHA256}" ] || { echo "R3-a: the installed node_modules/{yaml,zod} tree hashes to ${tree}, not QDS_ENGINE_TREE_SHA256 — registry bytes moved under a locked version" >&2; exit 1; }; \
    [ "$(find /out/qds-factory/node_modules -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ]; \
    chown -R root:root /out/qds-factory; \
    find /out/qds-factory -type d -exec chmod 0755 {} +; \
    find /out/qds-factory -type f -exec chmod 0644 {} +; \
    [ -f /out/qds-factory/scripts/pipeline-run.ts ]; \
    [ -f /out/qds-factory/cli-anything/scripts/team-lead-driver.ts ]; \
    [ -d /out/qds-factory/node_modules/yaml ]; \
    [ -d /out/qds-factory/node_modules/zod ]; \
    cd /out/qds-factory; \
    bun build --target=bun scripts/pipeline-run.ts --outfile /tmp/resolve-probe.js; \
    bun build --target=bun cli-anything/scripts/team-lead-driver.ts --outfile /tmp/resolve-probe-lead.js; \
    rm -f /tmp/resolve-probe.js /tmp/resolve-probe-lead.js

# THE WRAPPER, and `exec` is not decoration. `ExecStart=` names
# /usr/local/bin/qds-engine and stays byte-identical, so DF2.10's unit contract
# and leaf-1.1.2's conditional `%i` assertion both survive a route change they
# never had to know about. Without `exec` the shell remains MainPID, and
# `KillMode=mixed` — which signals the MAIN process only — would SIGTERM the
# shell rather than the engine, silently undoing #186 item 5.
#
# `"$@"` is quoted for the same reason `%i` is quoted in the unit: a runId
# containing whitespace must arrive as one argument, not two.
#
# F-D5 (#217) and R3-b, discharged together: the bun invocation is ABSOLUTE.
# `EnvironmentFile=` is applied AFTER systemd's default PATH, so a `PATH=` line
# in /home/exedev/app/.env would shadow every inherited entry and break a bare
# `bun` here — after ALL FOUR build-time `command -v bun` assertions passed,
# landing at run time as 203/EXEC. The same absolute form discharges R3-b's
# manager-PATH half: neither the manager's `DefaultEnvironment=` nor a
# PAM/`ENV_PATH` regression can move what the wrapper never looks up.
# /usr/local/bin/bun is the exact path the assertions below pin, so the wrapper
# restates a proven fact rather than guessing a layout.
RUN printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/bun /opt/qds-factory/scripts/pipeline-run.ts "$@"' > /out/qds-engine \
 && chmod 0755 /out/qds-engine

# ── STAGE 2 of 2: the image that ships. ──────────────────────────────────────
FROM ghcr.io/boldsoftware/exeuntu:latest@sha256:e10847fc58d2b728393edb21159ae2edd5bc42ea2d7c6fa4a1488235fb52715d

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
# bun@1.4.2 and .github/workflows/ci.yml pins 1.4.2 in both jobs. The in-box
# engine must run the runtime the tests ran on. The probe's 1.4.0 was an
# install measurement, not a pin.
ARG BUN_VERSION=1.4.2
# sha256 of bun-linux-x64.zip for the release above, taken from that release's
# SHASUMS256.txt and recorded here so the check is against an in-repo constant
# rather than a file fetched from the same host as the artifact. Re-measure it
# when BUN_VERSION moves; a stale value fails the build loudly, which is the
# point.
#
# EXPOSURE, named rather than implied: this is an ARG, so `--build-arg
# BUN_SHA256=<anything>` repoints the only content gate in the image (the pi
# step has none, by design, and says so). The paragraph above argues the value
# is an in-repo constant — true of the DEFAULT, not of the effective value. It
# stays an ARG because scripts/build-exedev-image.ts pairs every ARG default it
# passes against this file (`dockerfileArgDefaults`), and a literal inside the
# RUN would drop out of that pairing. Closing it belongs on the caller side:
# that script should refuse a BUN_SHA256 override that is not this file's
# default for the requested BUN_VERSION. Until it does, a CI misconfiguration
# or a copy-pasted override is enough.
ARG BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
#
# Deliberately NOT `curl https://bun.sh/install | bash`. Two reasons, both
# measured: that script resolves "latest" (unpinned — AC2's negative control),
# and it makes bun reachable only by appending to ~/.bashrc / ~/.zshrc. A
# non-interactive `ssh box "bun --version"` — which is exactly how the setup
# gate and the fleet driver invoke everything — reads NO shell rc file. bun
# must be on the default PATH for a bare non-login ssh command, so it is
# installed to /usr/local/bin, which is already first on the inherited PATH.
#
# WHICH PATH IS ACTUALLY ASSERTED. A bare `command -v bun` here resolves
# against the BUILDER's PATH — the image config's, inherited by this
# `/bin/sh -c` — which is not sshd's, so it cannot fail for the reason the
# paragraph above is about and would keep passing after a change that broke the
# ssh path. The `su` form below is the closest proxy the build can run: for a
# non-root target, util-linux `su` resets PATH to `ENV_PATH` from
# /etc/login.defs, the same system default a PAM-mediated non-login ssh session
# gets. Both are asserted, because they are different claims: the first is
# placement, the second is reachability from a session with no rc file.
# CEILING: sshd's own compiled default and any `SetEnv PATH=` in sshd_config
# are only measurable on a booted box; AC6's scan below reads sshd_config for
# the environment surfaces it can see at build time.
#
# `--proto '=https' --proto-redir '=https'` because -L follows redirects and
# nothing else here forbids a redirect to a cleartext scheme; `--max-time`
# because a stalled CDN connection would otherwise hang the build forever
# rather than failing. sha256sum covers content, neither of these.
RUN cd /tmp \
 && curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 300 -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  bun.zip" | sha256sum -c - \
 && unzip -q bun.zip \
 && install -m 0755 -o root -g root bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
 && [ "$(command -v bun)" = "/usr/local/bin/bun" ] \
 && suout="$(su -s /bin/sh exedev -c 'command -v bun')" \
 && { [ "${suout}" = "/usr/local/bin/bun" ] || { echo "su's non-root PATH (ENV_PATH from /etc/login.defs — the PAM-session proxy for a bare ssh command) resolved bun to '${suout:-nothing}'; print its own output so a PAM/login.defs regression is distinguishable from a PATH one (F-D6, #217)" >&2; exit 1; } }

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
# THREE PATHS, TWO DIFFERENT THINGS — and two earlier versions of this file
# read as if one of them were a typo for another. MEASURED, so the `chown`, the
# `rm` and oci/exedev/binary-licenses.json's `names` can each name the right
# one:
#   /home/exedev/.local/pi/       the INSTALL TREE exeuntu manages. It is what
#                                 exeuntu tries to `rename … pi.old` (the
#                                 overlayfs gotcha above is that rename), and it
#                                 is where @mariozechner/clipboard lands, at
#                                 .local/pi/node_modules (story DF2.10's own
#                                 measurement of both the stock base and the
#                                 update).
#   /home/exedev/.local/pi/pi     the ELF ITSELF, a regular file, and the
#                                 target of the root-owned /usr/local/bin/pi
#                                 symlink. THE VENDOR MOVED IT HERE in the base
#                                 re-pinned at ea6c3f5c (upstream's weekly
#                                 no-cache rebuild): measured from publish run
#                                 34534221743's build log, 2026-09-10 —
#                                 `readlink -f /usr/local/bin/pi` resolves to
#                                 this path, and the AC5 added-binary diff
#                                 (`find -type f`) keys on exactly it. The
#                                 2026-08-31 measurement had the ELF at
#                                 /home/exedev/.local/bin/pi (df1-10-probe,
#                                 runtime-inventory).
#   /home/exedev/.local/bin/pi    a LEFTOVER LINK at the old ELF path, still
#                                 present and still `-f`-true THROUGH the link.
#                                 The old tie below (`[ -f .local/bin/pi ]`,
#                                 meant to fail the build if the vendor ever
#                                 moved the ELF) therefore KEPT PASSING through
#                                 the move — the exact silent miss this
#                                 comment's honesty is for. The tie now also
#                                 asserts the real ELF and the symlink's exact
#                                 target; if the vendor moves pi again, the
#                                 build fails here and binary-licenses.json's
#                                 `names` must move in the same change.
#
# exeuntu writes the new tree as root; the stock one is exedev-owned and pi
# runs as exedev, so ownership is restored — over BOTH of the paths above. The
# `-R` used to cover the whole of /home/exedev/.local, which is broader than the
# stated need; narrowing it to .local/pi alone then missed the actual binary,
# which is the defect this states out of existence. HONEST LIMIT: this
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
# BRACKETED BY ASSERTIONS, because `rm -rf` exits 0 on a path that is not there
# and this removal is load-bearing for attribution. The `[ -d … ]` before it
# refuses a build where the tree moved (a green no-op would ship the
# unattributable package under a new depth); the `[ ! -e … ]` and the
# `find … -name node_modules` sweep after it refuse a build where the removal
# did not take, or where a SECOND tree exists that this one line never covered.
# Fail direction is a loud build failure naming the path, never a quiet ship.
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
 && [ -d /home/exedev/.local/pi/node_modules ] \
 && rm -rf /home/exedev/.local/pi/node_modules \
 && [ ! -e /home/exedev/.local/pi/node_modules ] \
 && ! find /home/exedev/.local -type d -name node_modules | grep -q . \
 && [ -f /home/exedev/.local/bin/pi ] \
 && [ -f /home/exedev/.local/pi/pi ] \
 && chown -R exedev:exedev /home/exedev/.local/pi /home/exedev/.local/bin/pi \
 && [ -L /usr/local/bin/pi ] \
 && [ -x "$(readlink -f /usr/local/bin/pi)" ] \
 && [ "$(readlink -f /usr/local/bin/pi)" = "/home/exedev/.local/pi/pi" ] \
 && [ "$(command -v pi)" = "/usr/local/bin/pi" ] \
 && suout="$(su -s /bin/sh exedev -c 'command -v pi')" \
 && { [ "${suout}" = "/usr/local/bin/pi" ] || { echo "su's non-root PATH (ENV_PATH from /etc/login.defs) resolved pi to '${suout:-nothing}' (F-D6, #217)" >&2; exit 1; } }

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
#
# EVERY PATH IS ASSERTED BEFORE AND AFTER, because `rm -rf` exits 0 on a path
# that is not there. Without the pre-check, a base that renamed or moved any of
# these turned this whole RUN into a silent no-op — the one cleanup in this file
# with no post-condition, next to a throwaway-engine step three blocks down that
# does assert its own removal. What that no-op actually produces is a
# CONFUSING failure rather than a shipped key: scripts/build-exedev-image.ts
# runs the INV-IBOX-1 content scan over the built image's filesystem on every
# build and exits 1 on any finding, so a key at a moved path is refused — but
# refused as "credential inside /some/new/path" with nothing pointing at this
# stale list. The pre-check names the drifted path itself; the post-check
# refuses a removal that did not take.
RUN set -e; \
    set -- /usr/lib/python3/dist-packages/tornado/test \
           /usr/lib/python3/dist-packages/twisted/test \
           /usr/local/go/src/crypto/tls/testdata \
           /usr/local/go/src/crypto/x509/platform_root_key.pem \
           /usr/share/doc/libnet-ssleay-perl/examples \
           /usr/share/doc/python3-h2/examples; \
    for p in "$@"; do \
      [ -e "$p" ] || { echo "INV-IBOX-1: $p is not in this base. This list was DERIVED from a scan of a different filesystem; re-run the credential scan against the new base and re-derive it before bumping." >&2; exit 1; }; \
    done; \
    rm -rf "$@"; \
    for p in "$@"; do \
      [ ! -e "$p" ] || { echo "INV-IBOX-1: $p survived its own removal" >&2; exit 1; }; \
    done

# ── supervision assets (AC6) ────────────────────────────────────────────────
# Shipped IN THE IMAGE, enabled by nothing. DF2.10 starts no instance: there is
# no `systemctl enable`, and the unit has no ExecStart because DF1.10 owns the
# engine. The tmpfiles entry is the one that must fire on its own — DF1.11's
# re-provision converges on its exact bytes and `provisionSteeringChannel`
# stays in the driver as a zero-diff image-regression tripwire.
COPY --chmod=0644 oci/exedev/systemd/qds-run@.service /etc/systemd/system/qds-run@.service
COPY --chmod=0644 oci/exedev/systemd/qds-steering.conf /etc/tmpfiles.d/qds-steering.conf

# ── the engine, its catalog, and cli-anything (DF1.10 — AC2a, AC3) ──────────
# ABOVE the AC6 scan, deliberately: that scan is the last RUN in this file and
# anything below it is unchecked, so every path added here is still swept for a
# QDS_* leak.
#
# ROOT-OWNED, and this is the one place this image improves on pi's ownership
# story rather than repeating it. The pi step below/above narrows `chown -R` to
# exedev because `exeuntu update pi` installs into $HOME and the vendor owns
# that layout — with the recorded consequence that exedev, the user that runs
# agent-authored code, can rewrite the very binary it runs. The engine is
# OURS to place, so it is placed the way bun is: root:root under /usr/local,
# 0755, outside any directory the login user owns. Same for the catalog under
# /usr/local/share and cli-anything under /opt.
COPY --from=engine --chmod=0755 /out/qds-engine /usr/local/bin/qds-engine
# NO `--chmod` here either, and for the same reason as the catalog below: this
# is a directory copy, the modes were set in the builder (0755 dirs, 0644 files,
# root:root, no execute bit in the tree), and they are ASSERTED further down.
COPY --from=engine /out/qds-factory/ /opt/qds-factory/
# NO `--chmod` on the DIRECTORY copy: BuildKit applies it to the directory as
# well as its contents, and a 0644 directory has no execute bit — it cannot be
# traversed, so the engine would fail to read a catalog that is demonstrably
# there. The modes are set in the builder stage instead (0755 dir, 0644 files,
# root:root) and ASSERTED below, which also keeps the assertion an assertion
# rather than a chmod that verifies its own effect.
COPY --from=engine /out/pi-catalog/ /usr/local/share/qds/pi-catalog/

# cli-anything is NO LONGER COPIED SEPARATELY. It arrives inside
# /opt/qds-factory above, at the same repo-relative position it occupies in the
# source tree — which is the point rather than a tidy-up.
#
# `buildTeamSpawn` (cli-anything/src/team-events.ts, which DF1.10 is told not to
# touch) returns `{file:"bun", argv:[join(import.meta.dir,"..","scripts",
# "team-lead-driver.ts")]}` for the QDS_TEAM_RUNNER=local runner, and
# `runTeamManifest` spawns that as a SEPARATE bun process reading a real `.ts`
# file off disk. Because the engine ships as unbundled source,
# `import.meta.dir` for that module is the REAL directory
# /opt/qds-factory/cli-anything/src, so the join yields
# /opt/qds-factory/cli-anything/scripts/team-lead-driver.ts — bytes this image
# stages. Under the old separate COPY the destination happened to be the same
# path, but the engine was compiled and computed `/$bunfs/scripts/…` instead, so
# staging was necessary and NOT sufficient. It is sufficient now, and it is
# sufficient BECAUSE the tree is unbundled and whole — not because a path was
# chosen to make one join land.
#
# `bun` on PATH — installed by this image, not by an rc file — is what makes the
# bare "bun" in that spawn correct.

# The three assertions that make the unit file and the image AGREE, rather than
# both stating the same literals and drifting. Every path below is READ OUT OF
# THE SHIPPED UNIT and then required to exist here, so a rename on either side
# fails the build instead of failing a paid live round.
#
# NO `ldd` ANY MORE, and its removal is a consequence of the route rather than a
# dropped check. `ldd` was here to catch a compiled bun executable whose dynamic
# dependencies this image could not satisfy. `/usr/local/bin/qds-engine` is now
# a two-line `/bin/sh` script, which has no shared-library graph of its own —
# running `ldd` on it would report "not a dynamic executable" forever and read
# as a passing check that measures nothing. The linkage that still matters is
# `bun`'s, and `bun --version` in the bun step above already executes it.
#
# WHAT REPLACES IT is stronger, because it follows the wrapper to the thing it
# actually execs: the interpreter is on PATH, the entry the wrapper names is a
# real file, and — the one that would have caught the compiled route's defect —
# the path `buildTeamSpawn` computes from its own module's directory resolves to
# a file this image stages. That last assertion is arithmetic on the shipped
# layout, not a restatement of it: it joins from cli-anything/src the same way
# team-events.ts does, so a tree reshuffle that breaks the spawn fails HERE
# rather than on a paid box at the first dispatch_task phase.
#
# Still not EXECUTING the engine: that would start a phase walk inside a
# builder. Whether the engine does the right thing is the live round's job;
# whether it can be found, read and resolved is this block's.
RUN set -e; \
    unit=/etc/systemd/system/qds-run@.service; \
    exec_path="$(sed -n 's/^ExecStart=\([^ ]*\) .*$/\1/p' "${unit}")"; \
    [ "${exec_path}" = "/usr/local/bin/qds-engine" ] || { echo "the unit's ExecStart names ${exec_path:-nothing}, not the wrapper this stage installs" >&2; exit 1; }; \
    [ -x "${exec_path}" ]; \
    [ "$(command -v qds-engine)" = "/usr/local/bin/qds-engine" ]; \
    { [ "$(su -s /bin/sh exedev -c 'command -v qds-engine')" = "/usr/local/bin/qds-engine" ] || { echo "su's non-root PATH (ENV_PATH from /etc/login.defs) resolved qds-engine to '$(su -s /bin/sh exedev -c 'command -v qds-engine' || true)' (F-D6, #217)" >&2; exit 1; } }; \
    grep -q '^exec /usr/local/bin/bun /opt/qds-factory/scripts/pipeline-run.ts "\$@"$' "${exec_path}" || { echo "the wrapper does not exec /usr/local/bin/bun on the engine entry; without exec the shell stays MainPID and KillMode=mixed signals the wrapper, not the engine, and without the absolute path a PATH override in the EnvironmentFile breaks every start as 203/EXEC (F-D5)" >&2; exit 1; }; \
    [ "$(command -v bun)" = "/usr/local/bin/bun" ]; \
    [ -f /opt/qds-factory/scripts/pipeline-run.ts ]; \
    [ -d /opt/qds-factory/node_modules/yaml ]; \
    [ -d /opt/qds-factory/node_modules/zod ]; \
    [ "$(stat -c '%U %G %a' /opt/qds-factory)" = "root root 755" ]; \
    [ "$(stat -c '%U %G %a' /opt/qds-factory/scripts/pipeline-run.ts)" = "root root 644" ]; \
    [ -z "$(find /opt/qds-factory -type f -perm -u+x -print -quit)" ] || { echo "the engine source tree carries an executable file; it is interpreted source and exedev must not be able to run or replace it directly" >&2; exit 1; }; \
    spawn_target="$(cd /opt/qds-factory/cli-anything/src && cd .. && pwd)/scripts/team-lead-driver.ts"; \
    [ -f "${spawn_target}" ] || { echo "buildTeamSpawn's computed path ${spawn_target} is not a file in this image; every dispatch_task phase's local team runner would fail on a live box" >&2; exit 1; }; \
    catalog="$(sed -n 's/^Environment=QDS_PI_CATALOG_DIR=//p' "${unit}")"; \
    [ -n "${catalog}" ] || { echo "the unit sets no QDS_PI_CATALOG_DIR; the resident would be disabled on the first solicitation" >&2; exit 1; }; \
    [ -d "${catalog}" ] || { echo "the unit points QDS_PI_CATALOG_DIR at ${catalog}, which this image does not stage" >&2; exit 1; }; \
    n="$(find "${catalog}" -maxdepth 1 -name '*.json' -not -name '.*' | wc -l)"; \
    [ "${n}" -gt 10 ] || { echo "the staged pi catalog holds ${n} provider files; that is not a catalog" >&2; exit 1; }; \
    [ "$(stat -c '%U %G %a' "${catalog}")" = "root root 755" ]; \
    [ -f /opt/qds-factory/cli-anything/src/redact.ts ]; \
    for d in journal trace; do \
      grep -qE "^RuntimeDirectory=.*qds-run/%i/${d}\b" "${unit}" || { echo "the unit does not declare RuntimeDirectory=qds-run/%i/${d}; the engine runs as User=exedev and cannot mkdir under root-owned /run (EACCES, first live round), and a non-%i literal would put every instance back on one shared root (#217 F-D1)" >&2; exit 1; }; \
    done; \
    grep -qE '^RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace$' "${unit}" || { echo "the unit's RuntimeDirectory= is not exactly the per-instance pair qds-run/%i/journal qds-run/%i/trace — the engine's runMarkerRoot(runId) derives this exact tree and the two halves must not drift (#217 F-D1)" >&2; exit 1; }; \
    grep -qE '^RuntimeDirectoryPreserve=yes$' "${unit}" || { echo "the unit does not set RuntimeDirectoryPreserve=yes; systemd would delete the per-run tree at unit stop, taking the terminal marker with it at the moment fleet status and harvest need it" >&2; exit 1; }; \
    grep -qE '^Delegate=memory$' "${unit}" || { echo "the unit does not set Delegate=memory; the engine runs as User=exedev and could not create the resident's per-solicitation cgroup or write its memory.max, so DF3.6b's kernel-enforced memory bound is unenforceable and every run would start with the resident DISABLED (INV-MEM-2) instead of failing loudly" >&2; exit 1; }

# ── S1 rig_swarm: node, OpenRig, the self-compact extension, the member-env patch ──
# The rig_swarm phase kind runs an OpenRig swarm inside this box, and needs
# three baked facts the pinned image does not carry: `node` (the image ships
# NONE — the seat gate runs `node --test` and OpenRig's runner is a
# `#!/usr/bin/env node` script), the OpenRig CLI at /opt/openrig, and the
# self-compact extension every seat's settings.json loads by absolute path
# (src/phase-engine/phases/openrig-swarm.ts bakes
# "/opt/qds/pi-ext/self-compact/self-compact.ts" into the settings it writes).
# Three properties this section must not break:
#   (1) /opt/qds-factory/node_modules stays EXACTLY yaml+zod. OpenRig and its
#       dependency tree live at /opt/openrig, never inside the engine's tree;
#       the site gate in scripts/build-exedev-image.ts admits exactly two npm
#       trees by literal path (the engine's and /opt/openrig/lib/node_modules)
#       and sweeps both.
#   (2) npm and corepack are BUILD-TIME TOOLING ONLY. The node tarball ships
#       them at /usr/local/lib/node_modules; they are deleted in the cleanup
#       RUN below rather than shipped.
#   (3) Both content-gate ARGs shipped as the literal sentinel MEASURE-AT-
#       FIRST-BUILD because no build of this file had then run (Docker
#       unavailable on the authoring machine, 2026-09-23): an unpinned tree
#       builds NOTHING, it refuses, and the refusal message carries the
#       measured value to pin. Same TOFU doctrine as BUN_SHA256 and
#       QDS_ENGINE_TREE_SHA256 above. That first build has since run and
#       both ARGs carry measured values (R0.4, 2026-09-24 — the PINNED
#       comments at each ARG name their runs). Sequencing, which the roadmap
#       owns: these pins land FIRST (R0.4), because the publish refuses
#       until they do — and the DEFAULT_IMAGE_REF/DEFAULT_IMAGE_BUILD_ID
#       adoption lands AFTER that first successful publish (R0.5), because
#       the digest it pins does not exist until then. Two commits, in that
#       order; they cannot be one.
ARG NODE_VERSION=22.20.0
# PINNED 2026-09-24 from the first build's own refusal (run 36031582204:
# "hashes to eeaccb03…"), cross-checked byte-identical against the
# nodejs.org SHASUMS256.txt line the sentinel comment below names.
ARG NODE_SHA256=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29
# .tar.gz, NOT the sketch's .tar.xz: gzip is present wherever tar is, while
# xz-utils presence in the base is unmeasurable from here (no local build) and
# a missing `xz` breaks `tar -xJf` before any gate runs. One fewer unmeasured
# assumption riding the first build.
RUN set -e; \
    cd /tmp; \
    curl -fsSL --proto '=https' --proto-redir '=https' --max-time 300 --retry 3 -o node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"; \
    sum="$(sha256sum node.tar.gz | cut -d' ' -f1)"; \
    [ "${sum}" = "${NODE_SHA256}" ] \
      || { echo "R3-a TOFU: node-v${NODE_VERSION}-linux-x64.tar.gz hashes to ${sum}, not NODE_SHA256='${NODE_SHA256}' — pin the measured value into the ARG above (cross-check: the SHASUMS256.txt line at https://nodejs.org/dist/v${NODE_VERSION}/) and rebuild" >&2; exit 1; }; \
    tar -xzf node.tar.gz -C /usr/local --strip-components=1; \
    rm node.tar.gz; \
    [ "$(node --version)" = "v${NODE_VERSION}" ] \
      || { echo "node --version printed '$(node --version 2>&1 || true)', not v${NODE_VERSION} — the tarball's bin/ layout or the --strip-components extraction moved the binary" >&2; exit 1; }; \
    [ "$(command -v node)" = "/usr/local/bin/node" ] \
      || { echo "command -v node resolved to '$(command -v node || true)', not /usr/local/bin/node — the tarball did not land where the phase's bare 'node' lookups expect it" >&2; exit 1; }; \
    suout="$(su -l -s /bin/sh exedev -c 'command -v node')"; \
    [ "${suout}" = "/usr/local/bin/node" ] \
      || { echo "a LOGIN shell as exedev (su -l resets PATH from ENV_PATH in /etc/login.defs — what a bare ssh command as exedev resolves) resolved node to '${suout:-nothing}' (F-D6 pattern, #217)" >&2; exit 1; }
# The extraction above also lands bin/npm, bin/npx, bin/corepack (SYMLINKS into
# /usr/local/lib/node_modules) — required by the OpenRig RUN next, removed by
# the cleanup RUN after it.

# OpenRig 0.5.14 (Apache-2.0; engines node >= 20, satisfied above). Installed
# under --prefix /opt/openrig so its dependency tree sits at
# /opt/openrig/lib/node_modules — a second npm tree the site gate admits BY
# LITERAL PATH and DF2.9's sweep attributes like the engine's own.
#
# The tree hash gates the WHOLE /opt/openrig tree, not just @openrig/cli: npm
# resolved @openrig/cli's ^-ranged dependencies inside this RUN, and this hash
# is the only thing freezing that resolution — an upstream republish inside
# the range moves the measured value and the build refuses, which is the
# point. MEASURED PIN since R0.4 (2026-09-24): the value below came from the
# first build's own refusal message (run 36032367862) — for an npm-resolved
# tree there is no external cross-check, so the refusal output IS the
# measurement.
#
# The hash pipeline is NUL-delimited end to end (`-print0 | sort -z |
# xargs -0`) so a filename carrying a newline or whitespace is one file, not
# a split that silently drops part of the tree from the measurement, and
# pipefail makes a mid-pipeline sha256sum/xargs failure refuse the build
# instead of hashing whatever survived. Residual blindness, stated honestly:
# `-type f` excludes SYMLINKS and the hash covers CONTENT, not MODES — a
# mode-only flip (an +x granted to a data file) or a new symlink entry point
# passes this gate. That is the same named ceiling listExecutables carries;
# the gate's claim is byte identity of the regular files, nothing more.
ARG OPENRIG_VERSION=0.5.14
# PINNED 2026-09-24 from the first build's own refusal (run 36032367862:
# "the /opt/openrig tree hashes to 543e846b…"). Unlike NODE_SHA256 there is
# no external cross-check for an npm-resolved tree — the refusal output IS
# the measurement, which is the TOFU doctrine for this gate: the hash is
# what freezes npm's ^-range resolution inside the pin.
# RE-PINNED 2026-09-26 from run 36251651875's refusal ("the /opt/openrig tree
# hashes to 41e10c9a…"): the 543e846b resolution had held for every build from
# 2026-09-24 through the 14:43Z healing run of the same day, then drifted
# upstream inside @openrig/cli@0.5.14's ^-ranges — no CLI version change. The
# drifted resolution's content snapshot (144 packages, darwin host, platform
# optional-deps excluded) is recorded in the re-pin commit message; from this
# re-pin forward the snapshot is part of the ritual, since a hash-only record
# cannot say WHAT moved.
# RE-PINNED AGAIN 2026-09-28 from run 36370793886.s refusal: the S2.6 claude
# CLI install grew the same tree (e2cb427c → 6b60a34b) — the second measured
# loop of the same ritual, expected when the applier + a new package both land
# inside the scoped tree.
# RE-PINNED A THIRD TIME 2026-09-28, measured LOCALLY (bun
# scripts/build-exedev-image.ts --push): 6b60a34b → e035abfa — upstream
# ^-range drift inside @openrig/cli@0.5.14 struck again ~10h after the CI
# measurement, the known class. PROVENANCE DEVIATION, recorded: GitHub
# Actions billing failed account-wide (runs refuse to start), so the
# measuring build ran on the operator host with the script's own gates —
# the same machine the workflow would have used a runner for. When Actions
# billing is restored, the next push-triggered build re-validates: any
# digest divergence from a CI rebuild refuses at gate B, per the standing
# ritual.
# RE-PINNED 2026-09-28 from run 36367093271's refusal ("the /opt/openrig tree
# hashes to e2cb427c…"): OUR OWN S2.2 patch moved it — the member-env applier
# (oci/exedev/openrig-patches/member-env.mjs) modifies node-launcher.js inside
# the tree-measured RUN, so the patched bytes are the pinned identity by
# design. Nothing upstream drifted: the delta is exactly the patch (2 imports
# + the qdsMemberEnv merge block) plus whatever npm re-resolved identically.
# RE-PINNED 2026-10-08 from publish run 37831713339's refusal ("the /opt/openrig
# tree hashes to 9f1488626ed4a655312cc0151e2cdfda2c135fcdbf4c3e0963a4dadd9a47e031"):
# two caret floats inside @openrig/cli@0.5.14's dependency range since the
# 2026-10-01 pin (c2b09bf5) — hono published 4.13.13 on 2026-10-08T05:35Z and
# zod published 4.6.5 on 2026-10-02T16:52Z (the 2026-09-29→10-01 pin closed over
# hono <=4.13.12; zod's ^4.3.6 floated 4.6.x in the same window). Same class as
# the 2026-10-01 re-pin: openrig's own bundle is untouched at 0.5.14; only the
# caret-resolved transitive deps under it moved. No same-version npm re-publish
# is involved (@openrig/cli@0.5.14's dist.integrity is unchanged).
# RE-PINNED 2026-10-16 from publish run 38983329163's refusal ("the /opt/openrig
# tree hashes to 4340266aaa77f0db4a35736e89ec5aa22d926bb96af397d0eea5bbace2863441"):
# more caret floats inside @openrig/cli@0.5.14's dependency range since the
# 2026-10-08 pin (9f1488626) — same class as both prior re-pins: openrig's own
# bundle is untouched at 0.5.14; only the caret-resolved transitive deps under
# it moved (hono ^4.7.0 / zod ^4.3.6 / tar ^7.5.13 ranges remain open upstream).
# No same-version npm re-publish is involved (@openrig/cli@0.5.14's
# dist.integrity is unchanged).
# RE-PINNED 2026-11-02 from publish run 41371967520's refusal ("the /opt/openrig
# tree hashes to 1f9d6a1dc12ec215733d3a2a572ecd8e3f9bfad3ffe8e91b5e4b640b6de33874"):
# same caret-float class as all prior re-pins — the rig binary is UNTOUCHED
# (rig --version printed 0.5.14 (cc75efdd) in both the failing run 41371967520
# and the last green run 40340198459), and @openrig/cli@0.5.14's dist.integrity
# is unchanged since 2026-09-14; only the caret-resolved transitive deps under
# it moved. No same-version npm re-publish is involved.
# RE-PINNED 2026-11-02 (second same-day pin) from publish run 41454454888's
# refusal ("the /opt/openrig tree hashes to
# 139620d5491a65dd62b7da6ce670ea7f531995938767a1b55130189e27a1a00b"): same
# caret-float class as every prior pin — the rig binary is UNTOUCHED
# (rig --version printed 0.5.14 (cc75efdd) in this run too) and
# @openrig/cli@0.5.14's dist.integrity is unchanged; only the caret-resolved
# transitive deps under it moved again. The floating caret has now moved the
# tree twice within 13 hours, and AGAIN on 2026-11-03/04 (refusal named
# 5c4ae1d1e412bbe5806f84eccd51d20405a2ab9a7c14fd90cb12c4c1653ee798; run
# 41742270947) — pinning the exact versions (npm lockfile for the global
# install) is the standing fix candidate; filed, not done here.
ARG OPENRIG_TREE_SHA256=ab22c448f87bd46984a0c37d6fa2fab4be07273bff3f54738f196d7b8cf321f2
# S2.2/S2.6: the claude CLI, pinned. Installed into the SAME /opt/openrig
# prefix — deliberately: the tree-hash gate above scopes that whole tree, so
# the claude-code install is frozen by the same measurement instead of a
# second gate to forget. The wrapper package's install.cjs copies the
# optionalDependencies' platform binary over its bin placeholder locally
# (no network at that step); the linux-x64 optional dep is what ships.
# License: Anthropic's proprietary terms (SEE LICENSE IN README.md),
# attributed in binary-licenses.json like every other shipped executable.
ARG CLAUDE_CODE_VERSION=2.1.283
# `npm i -g --prefix` is expected to put the bin link at /opt/openrig/bin/rig
# (the package's `bin: {rig: dist/bin-wrapper.js}`); the existence check makes
# that layout assumption fail LOUDLY at the first real build rather than
# shipping a dangling symlink — the same fail-closed spirit as the
# content-gate ARGs. `rig --version` is EXECUTED, not string-compared: its output format is
# unmeasured from here, and executing it still proves the symlink chain and
# the node shebang resolve. It runs BEFORE the tree-hash measurement, not
# after: a CLI that initialises first-run state under /opt/openrig on first
# execution would otherwise mutate the tree AFTER the pin was taken, and the
# gate would pin a tree that is not the one that ships.
#
# THE CACHE IS REDIRECTED, AND ITS ABSENCE IS ASSERTED, BECAUSE DIGEST
# REPRODUCIBILITY DEPENDS ON IT. npm's default cache (/root/.npm/_cacache)
# carries wall-clock bytes in every index entry (`time`, `metadata.time`,
# `resHeaders.date`, etags), and its _logs are a build's whole diary — publish
# runs 36048175927 and 36056831164 built the SAME source revision (identical
# buildId, builtAt, gitSha, piSha256; the license sweep and the NOTICE
# byte-identical) yet produced digests 12 compressed bytes apart. Nothing
# content-gated covers /root/.npm: the tree gate scopes /opt/openrig, the
# sweep counts packages and executables, the buildId hashes SOURCES. So the
# redirect sends cache and logs to /tmp, deleted in the same layer, and the
# assertions below fail the build if npm ever writes them at $HOME again.
# S2.2: the per-seat env delivery patch, applied to the pinned tree INSIDE the
# RUN below — before `rig --version` executes and BEFORE the OPENRIG_TREE_SHA256
# measurement, so the patched bytes ARE the pinned identity (the tree gate then
# freezes them like any other tree content; upstream drift still refuses).
# oci/exedev/openrig-patches/member-env.mjs carries the full evidence trail for
# why a patch is the delivery (no per-seat env surface exists upstream).
COPY oci/exedev/openrig-patches/member-env.mjs /tmp/qds-member-env.mjs
RUN set -e; \
    export npm_config_cache=/tmp/npm-cache npm_config_logs=/tmp/npm-logs; \
    npm i -g --prefix /opt/openrig "@openrig/cli@${OPENRIG_VERSION}"; \
    npm i -g --prefix /opt/openrig "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    [ -e /opt/openrig/bin/claude ] \
      || { echo "S2.2 precondition failed: npm's --prefix install put no claude bin at /opt/openrig/bin/claude — the rig claude-code adapter sends bare 'claude' argv into every claude seat's pane, so a missing binary is a dead seat at run start, not a build error" >&2; exit 1; }; \
    [ -e /opt/openrig/bin/rig ] \
      || { echo "npm's --prefix install put no bin at /opt/openrig/bin/rig; both the /usr/local/bin/rig symlink below and the phase body's bare 'rig' assume it — re-derive the layout from the actual install, do not guess" >&2; exit 1; }; \
    ln -s /opt/openrig/bin/rig /usr/local/bin/rig; \
    [ -f /opt/openrig/lib/node_modules/@openrig/cli/daemon/dist/domain/node-launcher.js ] \
      || { echo "S2.2 patch precondition failed: no node-launcher.js at the pinned 0.5.14 layout — re-derive the path from the actual install before applying the member-env patch" >&2; exit 1; }; \
    node /tmp/qds-member-env.mjs /opt/openrig/lib/node_modules/@openrig/cli; \
    rm -f /tmp/qds-member-env.mjs; \
    rig --version; \
    [ "$(command -v rig)" = "/usr/local/bin/rig" ] \
      || { echo "command -v rig resolved to '$(command -v rig || true)', not /usr/local/bin/rig — the symlink below or npm's bin layout differs from what the phase body's bare 'rig' lookup assumes" >&2; exit 1; }; \
    rm -rf /tmp/npm-cache /tmp/npm-logs; \
    [ ! -e /root/.npm ] \
      || { echo "REPRO R3-a: npm's cache shipped at /root/.npm despite npm_config_cache — cacache index entries carry wall-clock bytes (time, resHeaders.date, etag), so every build of this file would produce a DIFFERENT digest and the pin-adoption healing run could never converge. Reproduce: publish runs 36048175927 vs 36056831164 — identical buildId/builtAt/gitSha/piSha256, 12-byte compressed delta. Find where this cache came from and redirect or delete it; do not delete the assertion." >&2; exit 1; }; \
    [ ! -e /root/.npmrc ] \
      || { echo "REPRO R3-a: /root/.npmrc shipped — npm never needs one here, and INV-IBOX-1 refuses build-time credential files on principle" >&2; exit 1; }; \
    tree="$(cd /opt/openrig && set -o pipefail && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)" \
      || { echo "R3-a TOFU PRECONDITION: hashing /opt/openrig failed (sha256sum/xargs error mid-pipeline) — a partial pipeline must never read as a tree hash" >&2; exit 1; }; \
    [ "${tree}" = "${OPENRIG_TREE_SHA256}" ] \
      || { echo "R3-a TOFU: the /opt/openrig tree hashes to ${tree}, not OPENRIG_TREE_SHA256='${OPENRIG_TREE_SHA256}' — pin the measured value into the ARG above and rebuild" >&2; exit 1; }; \
    rm -rf /tmp/node-compile-cache; \
    [ ! -d /tmp/node-compile-cache ] \
      || { echo "REPRO R3-c: node's V8 compile cache shipped at /tmp/node-compile-cache — every node execution in this RUN (npm i, rig --version) materializes it under /tmp and its content varies between builds, so the layer's tar bytes (rootfs.diff_id) move while every /opt/openrig file hashes identical. MEASURED: layer 59 of publish runs 36082995077 vs 36084574659 — 12,415 cache blobs, 125,790 uncompressed bytes differing, same tree hash both runs. Delete it in the same RUN; do not delete the assertion." >&2; exit 1; }; \
    suout="$(su -l -s /bin/sh exedev -c 'command -v rig')"; \
    [ "${suout}" = "/usr/local/bin/rig" ] \
      || { echo "a LOGIN shell as exedev (su -l resets PATH from ENV_PATH in /etc/login.defs — what a bare ssh command as exedev resolves) resolved rig to '${suout:-nothing}' (F-D6 pattern, #217)" >&2; exit 1; }

# npm and corepack were BUILD-TIME TOOLING for the OpenRig install above; the
# node tarball ships them at /usr/local/lib/node_modules with ~75
# owner-executable files (MEASURED from the v22.20.0 tarball: npm's vendored
# dependency tree carries its bins and node-gyp's python +x). Shipping them
# would (a) add a THIRD npm tree the site gate does not admit, and (b) put
# npm (Artistic-2.0) and its ~70 vendored packages into a customer-facing box
# that never invokes them — the seats run `rig` (shebang node), never npm.
# Deleted, not swept. BRACKETED because `rm -rf` exits 0 on a path that is
# not there (this file's own doctrine). NOT same-layer deletions: npm must
# survive the OpenRig RUN above, so the bytes persist in those two layers —
# every gate here reads the FLATTENED filesystem (docker export / docker run
# find), which is what a booted box sees; `docker save` layer forensics would
# still find them, the same honest limit the INV-IBOX-1 base-fixture removal
# records.
RUN set -e; \
    [ -d /usr/local/lib/node_modules/npm ] || { echo "cleanup precondition failed: /usr/local/lib/node_modules/npm is not a directory — the v${NODE_VERSION} tarball layout changed and this RUN would delete a tree it did not verify" >&2; exit 1; }; \
    [ -d /usr/local/lib/node_modules/corepack ] || { echo "cleanup precondition failed: /usr/local/lib/node_modules/corepack is not a directory (expected from the v${NODE_VERSION} tarball)" >&2; exit 1; }; \
    [ -L /usr/local/bin/npm ] || { echo "cleanup precondition failed: /usr/local/bin/npm is not a symlink (expected: the tarball's bin link)" >&2; exit 1; }; \
    [ -L /usr/local/bin/npx ] || { echo "cleanup precondition failed: /usr/local/bin/npx is not a symlink (expected: the tarball's bin link)" >&2; exit 1; }; \
    [ -L /usr/local/bin/corepack ] || { echo "cleanup precondition failed: /usr/local/bin/corepack is not a symlink (expected: the tarball's bin link)" >&2; exit 1; }; \
    rm -rf /usr/local/lib/node_modules; \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
    [ ! -e /usr/local/lib/node_modules ] || { echo "cleanup failed: /usr/local/lib/node_modules still exists after rm -rf" >&2; exit 1; }; \
    ! find /usr/local -type d -name node_modules | grep -q . || { echo "cleanup failed: a node_modules directory survives under /usr/local — npm's vendored tree would ship as an unswept third npm site" >&2; exit 1; }; \
    node --version >/dev/null || { echo "node does not run after the cleanup RUN — the removal took something node needs" >&2; exit 1; }

# The self-compact extension (vendored) every seat's settings.json loads, and
# the /opt/qds root it lives under. Files 0644 root:root like the engine
# tree: pi reads this as source, and exedev — the user that runs agent-authored
# code — must not be able to rewrite what a seat's settings AUTOLOADS.
#
# /opt/qds/swarm-keys is pre-created EXEDEV-OWNED 0700, and the ownership is
# load-bearing rather than tidy: deliverSeatKeys
# (src/providers/credentials.ts, SWARM_KEYS_DIR) runs
# `install -d -m 700 /opt/qds/swarm-keys` over a bare ssh session AS EXEDEV
# and then writes the seat keys into it — against a root-owned /opt/qds the
# delivery would fail EACCES on every live box after every mock-level test
# passed. /opt/qds itself stays root:root 0755 (exedev cannot plant a
# sibling); only the keys dir is exedev's. The runtime `install -d -m 700`
# re-asserts the mode on the existing dir as its owner.
COPY pi-vs-claude-code-vendor/self-compact/extensions/self-compact /opt/qds/pi-ext/self-compact
# The kg-recall extension (vendored) ROSTER-GRANTED seats load via their -e
# pair (baked here at /opt/qds/pi-ext/kg-recall): one tool, kg_recall —
# recall-only, sanitized, char-budgeted (M2.2). Files 0644 root:root like the
# engine tree: pi reads this as source, and exedev — the user that runs
# agent-authored code — must not be able to rewrite what a seat can load.
COPY pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall /opt/qds/pi-ext/kg-recall
RUN set -e; \
    [ -f /opt/qds/pi-ext/self-compact/self-compact.ts ]; \
    [ -f /opt/qds/pi-ext/kg-recall/kg-recall.ts ]; \
    chown root:root /opt/qds; \
    chmod 0755 /opt/qds; \
    install -d -o exedev -g exedev -m 0700 /opt/qds/swarm-keys; \
    chown -R root:root /opt/qds/pi-ext; \
    find /opt/qds/pi-ext -type d -exec chmod 0755 {} +; \
    find /opt/qds/pi-ext -type f -exec chmod 0644 {} +; \
    [ "$(stat -c '%U %G %a' /opt/qds)" = "root root 755" ]; \
    [ "$(stat -c '%U %G %a' /opt/qds/swarm-keys)" = "exedev exedev 700" ]

# DoD (a): a malformed unit would otherwise surface first in DF1.10, on a real
# box, mid-run. Verify it here, at build time, as a hard failure.
#
# THE SHIPPED UNIT ITSELF, no longer a throwaway copy. DF2.10 verified a
# temporary copy with a synthetic `ExecStart` appended, backed by a stub
# executable, because the unit it shipped had no ExecStart and systemd refuses
# to load one — measured: "Service has no ExecStart=, ExecStop=, or
# SuccessAction=. Refusing." (exit 1). DF1.10's unit has a real ExecStart and
# the stage above installed the real binary it names, so the whole
# copy-append-stub-delete dance is gone and what gets verified is the file that
# ships. That is strictly stronger: the old form could not have caught a
# malformed ExecStart, because the ExecStart it checked was one it wrote
# itself.
#
# MEASURED: `systemd-analyze verify` exits NON-ZERO only for the load-refusing
# class. A merely unparseable directive — e.g. `Type=bogus` — is reported as
# "Failed to parse service type, ignoring" and still exits 0, which would let a
# typo'd supervision directive ship and surface first on a real box mid-run.
# So the exit code alone is not the check: verify must also be SILENT. A clean
# unit produces no output at all (measured), so any output is a finding.
#
# "EMPTY OUTPUT = CLEAN" NEEDS A POSITIVE CONTROL, or it is an oracle nothing
# proves. If a future base ships a systemd that skips template files, or one
# that stopped reporting unparseable directives, the check goes vacuously green
# on every build and the measurement above survives only as a comment. So a
# DELIBERATELY BROKEN copy (`Type=bogus`, the exact case measured) is verified
# FIRST and its output must be NON-EMPTY; then the real one is verified and its
# output must be empty. Both copies die inside this RUN.
#
# THE STATUS IS SPLIT FROM THE OUTPUT. `var="$(cmd)"` takes cmd's status, so in
# the load-refusing class — the serious one — the assignment returned non-zero,
# the `&&` chain short-circuited, and the echo that names the bad directive
# never ran: the build failed with a bare exit code and the diagnostic was
# captured into a variable and discarded. That was the precise failure this step
# exists to make legible.
RUN set -e; \
    cp /etc/systemd/system/qds-run@.service /tmp/qds-verify-broken@.service; \
    printf '%s\n' 'Type=bogus' >> /tmp/qds-verify-broken@.service; \
    broken_out="$(systemd-analyze verify /tmp/qds-verify-broken@.service 2>&1 || true)"; \
    [ -n "${broken_out}" ] || { echo "systemd-analyze verify said NOTHING about a Type=bogus unit: on this systemd, silence is not evidence and this check proves nothing" >&2; exit 1; }; \
    rm -f /tmp/qds-verify-broken@.service; \
    verify_rc=0; \
    verify_out="$(systemd-analyze verify /etc/systemd/system/qds-run@.service 2>&1)" || verify_rc=$?; \
    if [ "${verify_rc}" -ne 0 ] || [ -n "${verify_out}" ]; then \
      echo "unit verify was not clean (exit ${verify_rc}): ${verify_out}" >&2; exit 1; \
    fi

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

# The two provenance labels the LABEL block at the top could not set, because
# these ARGs are not declared until here. `licenses=NOASSERTION` up there is
# aimed at "a downstream consumer scraping labels for compliance"; that same
# consumer had no way to learn WHICH commit or WHEN, since the git sha and the
# buildId live only in /etc/qds-image.json, which requires booting the image.
# `version` is deliberately the buildId and not a semver: this artifact has no
# version series, and the buildId is the identity gate B compares. A LABEL is
# metadata, not an ENV, so none of this reaches a booted box's environment and
# AC6 below is unaffected.
LABEL org.opencontainers.image.revision="${QDS_GIT_SHA}" \
      org.opencontainers.image.created="${QDS_BUILT_AT}" \
      org.opencontainers.image.version="${QDS_BUILD_ID}"
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
# upstream digest. What IS asserted about it is its SHAPE — 64 lowercase hex
# characters. The old `[ -n … ]` could only have fired if `cut` itself
# misbehaved (a failing `sha256sum` already breaks the chain at the assignment),
# so it read as an integrity check standing beside a field this paragraph is at
# pains to say is not one.
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
 && { [ "${#pi_sha256}" -eq 64 ] \
      || { echo "piSha256 is ${#pi_sha256} chars, not a 64-char digest: ${pi_sha256}" >&2; exit 1; }; } \
 && { case "${pi_sha256}" in *[!0-9a-f]*) \
        echo "piSha256 is not lowercase hex: ${pi_sha256}" >&2; exit 1;; esac; } \
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
#
# THE ALLOWLIST, AND WHY AC6 WAS NARROWED (DF1.10). Checks 2 and 3 used to
# refuse EVERY QDS_* directive. The shipped unit now carries two —
# QDS_PI_CATALOG_DIR and QDS_TEAM_RUNNER — and the unit file argues the case at
# length beside them: both describe THIS IMAGE'S LAYOUT AND SUBSTRATE, which is
# the one class of fact the engine cannot resolve for itself, and neither is a
# RUN-scoped path. QDS_RUN_ROOT and QDS_STEERING_ROOT — the two DF1.11's
# INV-IBOX-13 and DF3.7's AC4 actually rest on, and the two `runMarkerRoot()`
# needs unset to return /run in the box — are still refused, by name and by
# construction.
#
# The allowlist is DERIVED FROM THE SHIPPED UNIT, not spelled out here — with
# ONE exception that is F-D7 (#217): `QDS_TEAM_RUNNER=local` is a LITERAL in
# the extraction regex. Without it the unit self-authorised its own value: any
# `QDS_TEAM_RUNNER=<anything>` satisfied an allowlist grepped out of the very
# file it validates, and `local` is not a preference — it is the only runner a
# factory box has, so a moved value is a build-time refusal, not a config knob.
# The remaining consequences, both wanted: the path literal lives in exactly
# one place, and the allowance is by WHOLE LINE, so a drop-in that re-sets QDS_PI_CATALOG_DIR
# to a DIFFERENT value is still a finding — which a name-only allowlist would
# have waved through. A third QDS_* directive in the unit fails check 3.
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
RUN allowed=/tmp/qds-ac6-allowed; \
    grep -xE 'Environment=QDS_PI_CATALOG_DIR=[^ ]+|Environment=QDS_TEAM_RUNNER=local' \
      /etc/systemd/system/qds-run@.service > "${allowed}"; \
    [ "$(wc -l < "${allowed}")" -eq 2 ] \
      || { echo "AC6: the shipped unit declares $(wc -l < "${allowed}") allow-listed QDS_* directives, expected exactly 2 (QDS_PI_CATALOG_DIR, QDS_TEAM_RUNNER)" >&2; exit 1; }; \
    leaked="$(env | sed -n 's/^\(QDS_[A-Za-z0-9_]*\)=.*/\1/p' \
      | grep -vxE 'QDS_IMAGE_REF|QDS_BUILD_ID|QDS_GIT_SHA|QDS_BUILT_AT' || true)" \
 && { [ -z "${leaked}" ] || { echo "AC6: QDS_* set in image env: ${leaked}" >&2; exit 1; }; } \
 && { [ -z "$(grep -rhE '^[[:space:]]*(Default)?Environment=.*QDS_' /etc/systemd/ 2>/dev/null \
        | grep -vxF -f "${allowed}" || true)" ] \
      || { echo "AC6: QDS_* in a systemd environment directive under /etc/systemd that the shipped unit does not declare" >&2; exit 1; }; } \
 && { ! grep -vE '^[[:space:]]*#' /etc/systemd/system/qds-run@.service \
        | grep -vxF -f "${allowed}" \
        | grep -qE 'QDS_[A-Za-z0-9_]*' \
      || { echo "AC6: QDS_* in a qds-run@.service directive outside the two allow-listed ones" >&2; exit 1; }; } \
 && { ! grep -qE 'QDS_[A-Za-z0-9_]*' /etc/tmpfiles.d/qds-steering.conf \
      || { echo "AC6: QDS_* in qds-steering.conf" >&2; exit 1; }; } \
 && { ! grep -rqE '^[[:space:]]*(export[[:space:]]+)?QDS_' \
        /etc/environment /etc/environment.d/ /etc/profile /etc/profile.d/ \
        /etc/bash.bashrc /home/exedev/.profile /home/exedev/.bashrc \
        /home/exedev/.bash_profile /home/exedev/.bash_login 2>/dev/null \
      || { echo "AC6: QDS_* in a login/session env file" >&2; exit 1; }; } \
 && rm -f "${allowed}" \
 && [ ! -e /tmp/qds-ac6-allowed ]
