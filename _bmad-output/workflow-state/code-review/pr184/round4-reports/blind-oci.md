# blind-oci

## [HIGH] `pi` is installed over the network with zero integrity verification, right below a bun step that goes to the wall for a checksum
- **File:line:** `oci/exedev/Dockerfile:141`
- **Trigger:** The bun step pins a version AND an in-repo `sha256`, and refuses the build if the bytes differ. The pi step pins only a version string and hands the fetch to a vendor tool. A GitHub release tag/asset is mutable — a maintainer or a compromised account can delete and re-push `v0.84.4` with different bytes — and every cold build (including the "weekly no-cache rebuild" drift the file's own header says this story exists to stop) will happily bake the new ELF. pi is the agent binary that runs with the per-run LLM key; it is the highest-value artifact in the image and the only unverified one. The trailing assertions check *placement* (`-L`, `-x`, `command -v`), never *content*, and the marker's `piVersion` at line 275 is a self-report from the very binary in question, so it proves nothing about integrity. Note the file's own bun comment says the checksum must be "against an in-repo constant rather than a file fetched from the same host as the artifact" — the pi step does not even have the weaker version of that.
- **Evidence:**
```
 && exeuntu update pi --home /home/exedev --version "${PI_VERSION}" \
```
```
ARG BUN_SHA256=79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a
```

## [HIGH] `org.opencontainers.image.licenses="MIT"` is contradicted by the licence table added in the same PR
- **File:line:** `oci/exedev/Dockerfile:62`
- **Trigger:** `image.licenses` is spec'd as "License(s) under which contained software is distributed, as an SPDX License Expression" — i.e. the whole image, not the repo. This image ships an entire Ubuntu userland (Go toolchain, Python3, Perl, coreutils — GPL/LGPL) plus, per `oci/exedev/binary-licenses.json:44` added in this same diff, a **statically linked LGPL-2.0-or-later JavaScriptCore** inside the bun binary. The JSON is emphatic that "spdxId names the license of the project we redistribute and a single identifier cannot honestly carry a static-link graph" — and then the Dockerfile carries the whole image with a single identifier. Any downstream consumer scraping labels for compliance (the normal use of this label) reads `MIT` and misses the LGPL relink obligation the JSON spends a paragraph discharging. For a story whose AC5 is licence attribution, this is the one machine-readable licence claim the image makes, and it is wrong.
- **Evidence:**
```
      org.opencontainers.image.licenses="MIT" \
```
```
          "spdxId": "LGPL-2.0-or-later",
```

## [MEDIUM] The Dockerfile frontend is the only unpinned upstream in a file whose doctrine is "digest-pinned, never `:latest`"
- **File:line:** `oci/exedev/Dockerfile:1`
- **Trigger:** `docker/dockerfile:1` is a floating tag that BuildKit pulls and **executes** as the build frontend on every cold build. It re-resolves exactly like the mutable base tag the file rejects at line 51, and it sits at a higher privilege than the base: it parses the Dockerfile and drives the build. `FROM` is digest-pinned, `bun` is sha-pinned, `pi` is version-pinned — the frontend is pinned to nothing. Fix is one digest on line 1.
- **Evidence:**
```
# syntax=docker/dockerfile:1
```
```
# F: digest-pinned, never `:latest`. Upstream runs a weekly no-cache cron
```

## [MEDIUM] The AC6 sweep claims to be the "complete set" of QDS_* surfaces and misses the two that actually reach this unit
- **File:line:** `oci/exedev/Dockerfile:308` (claim), `oci/exedev/Dockerfile:313-323` (check)
- **Trigger:** The unit is a **systemd system service**, and systemd does not source `/etc/environment` or `/etc/profile.d/` for system services. The environment a `qds-run@` instance actually gets comes from `DefaultEnvironment=` in `/etc/systemd/system.conf` (and `/etc/systemd/system.conf.d/*.conf`), and from unit drop-ins at `/etc/systemd/system/qds-run@.service.d/*.conf` — neither is checked. A `DefaultEnvironment=QDS_RUN_ROOT=/mnt/whatever` added in a drop-in conf is precisely the substrate-inherited path variable INV-IBOX-13 and DF3.7 AC4 rest on not existing, and it passes all four checks silently. The check also skips `/etc/profile`, `/etc/bash.bashrc`, `/home/exedev/.bashrc` and `.profile` — files this very Dockerfile treats as load-bearing 220 lines earlier, when the bun comment reasons at length about installers appending to `~/.bashrc`. The four checks are fine; the word "complete" is what makes a reviewer stop looking.
- **Evidence:**
```
# The four surfaces checked are the complete set of ways a QDS_* variable
# reaches a booted box from this image: the image environment, the unit, the
# tmpfiles entry, and the login/session env files.
```
```
 && { ! grep -rqE '^[[:space:]]*(export[[:space:]]+)?QDS_' \
        /etc/environment /etc/profile.d/ 2>/dev/null \
```

## [MEDIUM] `[Install] WantedBy=multi-user.target` on a per-run template is the double-spend `Restart=no` exists to forbid
- **File:line:** `oci/exedev/systemd/qds-run@.service:56-57`
- **Trigger:** The unit spends eight lines arguing that re-running an engine is "double-spend and double-commit, not recovery", and sets `Restart=no` to enforce it. It then ships the one section whose *only* function is to make `systemctl enable qds-run@<runId>` work — and an enabled instance is started by `multi-user.target` on **every subsequent boot**, re-walking phases whose git commits and LLM spend already happened. exe.dev boxes reboot (the growfs/tmpfs boot contract at Dockerfile lines 19-20 exists because they do). Nothing in the image enables an instance today, so this is a loaded gun rather than a fired one, and `enable` is the natural next verb for anyone reading an `[Install]` section. There is no `DefaultInstance=` either, so the section does nothing useful for a template that is only ever `start`ed. Deleting `[Install]` makes `enable` fail loudly, which is the behaviour the rest of the file asks for.
- **Evidence:**
```
Restart=no
```
```
[Install]
WantedBy=multi-user.target
```

## [MEDIUM] No `TimeoutStopSec=`: the default 90s SIGKILL lands in the same hazard class the unit is designed around
- **File:line:** `oci/exedev/systemd/qds-run@.service:17-28`
- **Trigger:** `Type=simple` with no `TimeoutStopSec=` takes the manager default (90s), after which systemd sends SIGKILL to the whole control group. A phase engine mid-`git push` or mid-LLM-call gets killed uncleanly at a point where, by this unit's own argument, "the crash is what destroyed that knowledge" about which phases completed. The unit reasons carefully about *restart* being unsafe and not at all about *stop* being abrupt — but `systemctl stop qds-run@<id>` during teardown/reap is the routine path, not the exotic one. Also no `TimeoutStartSec=` and no `KillSignal=`/`FinalKillSignal=` tuning. This is the whole `[Service]` policy the story claims to own.
- **Evidence:**
```
[Service]
Type=simple
User=exedev
```

## [MEDIUM] `binary-licenses.json`'s own `$comment` gives two incompatible rules for a top-level `NOASSERTION`
- **File:line:** `oci/exedev/binary-licenses.json:16-17` vs `:26-27`
- **Trigger:** Rule one says *every* top-level `spdxId` must resolve to a canonical text in `oci/license-texts/`, validated by `resolveLicenseText`. Rule two says `NOASSERTION` at the top level is NOT enforced and will not fail the build. Both cannot hold unless `oci/license-texts/` contains a `NOASSERTION` text — which would itself be nonsense, since NOASSERTION means "no licence determined" and there is no text to check in. So either the first sentence overstates the gate (and an unattributed top-level binary can ship), or the second sentence is wrong and someone following its explicit advice ("do not reach for it at the top level expecting a build failure") gets a build failure they were told not to expect. Which one is false is not determinable from the diff — `validateBinaryLicenses` is not in my world — but the document contradicting itself about when the legal gate fires is determinable, and this is the sentence a future author will rely on.
- **Evidence:**
```
"Every TOP-LEVEL entry's 'spdxId' must resolve to a canonical text in oci/license-texts/ (the",
"build validates this with DF2.9's own resolveLicenseText). 'UNVERIFIED' is a legal value there",
```
```
"'NOASSERTION' is a second spelling of 'we do not know' that, unlike",
"'UNVERIFIED', is NOT enforced — do not reach for it at the top level expecting a build failure."
```

## [MEDIUM] The BUMP PROCEDURE is incomplete against the coupling the skill doc in this same PR documents
- **File:line:** `oci/exedev/Dockerfile:46-50`, contradicted by `.claude/skills/qds-live-e2e/SKILL.md:94-95`
- **Trigger:** The skill doc states that `tier1-registry-auth`'s digest "derives from `DEFAULT_IMAGE_REF`, so a re-pin fails it loudly until the mirror is re-pushed" — i.e. a base bump requires pushing the new digest to `ghcr.io/biospark33/qds-exedev-private`. The BUMP PROCEDURE five files away lists exactly three steps (inspect, copy digest, rebuild) and mentions only re-recording "the repo pin and its buildId pair". Someone following the Dockerfile procedure verbatim — the whole reason it is written down — lands a green build and a red AC4 test with no hint of where the missing step lives. The two texts were written to be read independently and only one knows about the mirror.
- **Evidence:**
```
# BUMP PROCEDURE: `docker buildx imagetools inspect ghcr.io/boldsoftware/exeuntu:latest`
# and copy the top-level `Digest:` into the FROM line below. Then rebuild via
# scripts/build-exedev-image.ts — the license sweep re-classifies the new
```
```
`DEFAULT_IMAGE_REF`, so a re-pin fails it loudly until the mirror is re-pushed.
```

## [MEDIUM] SKILL.md tells two mutually exclusive stories about how the roster path is resolved
- **File:line:** `.claude/skills/qds-live-e2e/SKILL.md:46-48` vs `:59-62`
- **Trigger:** The first sentence says the setup gate reads the roster *beside the dispatch manifest*, `dirname(manifestPath)/roster.yaml` — a derived path that ignores `QDS_EXEDEV_ROSTER` entirely. The paragraph below says a *bogus* `QDS_EXEDEV_ROSTER` "sails through `liveGate()` and dies at setup", which requires the gate to open the env var's path. Both cannot be true. If resolution is dirname-derived, the newly-edited `export QDS_EXEDEV_ROSTER=...` on line 40 is inert and an operator who fixes a roster problem by changing it will chase a variable nothing reads; if it is env-driven, the `dirname(manifestPath)` claim sends them editing the wrong directory. I cannot confirm which without `dispatch.ts` / `setup-gate.ts`, so this is capped at MEDIUM — but the contradiction is entirely inside the added lines. This paragraph exists specifically to stop a stale-path repeat of `df16-e2e.roster.yaml`, which makes an ambiguous replacement worse than none.
- **Evidence:**
```
  setup gate reads BESIDE the dispatch manifest (`dispatch.ts`:
  `dirname(manifestPath)/roster.yaml`), it carries the proven-live T2 pair
```
```
  is opened and parsed by the SETUP GATE (`rosterModels()` in
  `src/providers/exedev/setup-gate.ts`), which throws an unreadable-roster
```

## [LOW] `chown -R` puts the target of a root-owned `/usr/local/bin` symlink under the login user's control
- **File:line:** `oci/exedev/Dockerfile:143`
- **Trigger:** After this line, `/home/exedev/.local/bin/pi` — the real file behind the root-owned `/usr/local/bin/pi` symlink asserted on the next lines — is writable by `exedev`. The login user is also the user that runs agent-authored code in-box. Any root-context invocation of `pi` (or of anything else the recursive chown swept up under `.local`) executes bytes the unprivileged login user can rewrite. The Dockerfile itself does exactly that at line 275 (`pi --version` runs as root); in-build that is the same trust domain, on a booted box it is not. The `-R` is also broader than the stated need — the comment justifies restoring ownership of the *pi tree*, not of everything under `.local`.
- **Evidence:**
```
 && chown -R exedev:exedev /home/exedev/.local \
 && [ -L /usr/local/bin/pi ] \
```

## [LOW] The attribution table's `version` fields contain prose, not versions
- **File:line:** `oci/exedev/binary-licenses.json:34` and `:59`
- **Trigger:** This file is described in its own header as "the legal artifact" whose claims get published (`attributedBinaries`). A NOTICE consumer reading `version` for bun gets the sentence "pinned by the BUN_VERSION build arg (package.json packageManager)" instead of `1.3.13`. That is unresolvable after the fact: `BUN_VERSION`/`PI_VERSION` are plain `ARG`s (Dockerfile:70, 99) and overridable with `--build-arg`, so the pointer does not even identify a fixed value for a given image. The `verifiedHow` fields do name concrete versions (`bun@1.3.13`, `v0.84.4`), which is where the real data ended up — but it is in a free-text provenance note, not the machine-readable field.
- **Evidence:**
```
      "version": "pinned by the BUN_VERSION build arg (package.json packageManager)",
```
```
      "version": "pinned by the PI_VERSION build arg, installed by `exeuntu update pi --version`",
```

## [LOW] `licenseUrl` points at mutable `main` in a table that argues against exactly that
- **File:line:** `oci/exedev/binary-licenses.json:37`, `:45`, `:51`, `:62`
- **Trigger:** Every URL in the table targets `blob/main/...`. `main` moves; the `verifiedAt: 2026-08-31` stamp pins the *observation*, not the *target*, so a reader following the link a year from now sees a LICENSE that may no longer be the one verified — and the pinned artifacts (`bun 1.3.13`, `pi v0.84.4`) are old releases whose licence text is on a tag, not on the tip. This bites hardest on the `NOASSERTION` bundled entry, whose whole defence is "recorded as a pointer, not transcribed… a stale transcription is a worse attribution than a live reference" — the live reference drifts on the next upstream commit with nothing here to notice. `blob/bun-v1.3.13/` and `blob/v0.84.4/` cost nothing and are stable.
- **Evidence:**
```
      "licenseUrl": "https://github.com/oven-sh/bun/blob/main/LICENSE.md",
```
```
          "note": "Enumerated with per-library licenses in bun's own LICENSE.md ... Recorded as a pointer, not transcribed: a transcription drifts on the next bun bump
```

## [LOW] `EnvironmentFile=` is mandatory-form, and `Restart=no` makes a delivery race terminal
- **File:line:** `oci/exedev/systemd/qds-run@.service:35`
- **Trigger:** No `-` prefix means a missing `/home/exedev/app/.env` fails the unit at start. Nothing in the unit orders it after the DF2.3 delivery — there is no `After=`/`Requires=` for it and no `ConditionPathExists=` — so if `fleet run` reaches `systemctl start` before the key file lands, the instance dies immediately and, with `Restart=no`, stays dead with a generic 203/EXEC-class failure rather than a legible "credential not delivered yet". Whether that race is possible depends on DF1.10's start sequencing, which I cannot see, so this is capped at LOW; the fail-closed direction is right, the diagnosability is not. A `ConditionPathExists=/home/exedev/app/.env` would name the actual cause in `systemctl status`.
- **Evidence:**
```
EnvironmentFile=/home/exedev/app/.env
```

## [LOW] `After=` with no `Requires=`/`Wants=` on the unit's stated hard dependency
- **File:line:** `oci/exedev/systemd/qds-run@.service:15`
- **Trigger:** The comment calls `/run/steering` "a real dependency on every boot". `After=` is ordering only — it does not pull the unit in, and it is satisfied vacuously if `systemd-tmpfiles-setup.service` never ran or failed. In practice default dependencies (`Requires=sysinit.target`) cover it, since `systemd-tmpfiles-setup` is `WantedBy=sysinit.target`, which is why this is LOW rather than higher — but if `systemd-tmpfiles-setup` *fails* (a malformed conf dropped in later by any other story), `sysinit.target` still activates and the engine starts against a `/run` with no `steering` directory. Given the whole tmpfiles entry exists so DF1.11's re-provision converges on exact bytes, a `Requires=systemd-tmpfiles-setup.service` makes the stated dependency the one systemd actually enforces.
- **Evidence:**
```
After=systemd-tmpfiles-setup.service
```
