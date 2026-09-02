# edge-buildscript

## [HIGH] The credential gate prints the credential it found into the build log
- **File:line:** `scripts/build-exedev-image.ts:1158` (finding raised), `:1952` (`die(1, scan.findings)` emits it)
- **Trigger:** any build where a token reaches a layer as a build arg. BuildKit renders that layer's `{{.CreatedBy}}` as `|1 NPM_TOKEN=<the actual value> /bin/sh -c …` — `SECRET_ENV` matches, and the whole line, value included, is pushed into `findings` and written to stderr by `exitWithFailure`. In `publish-exedev-image.yml` that stderr is the job log; GitHub only masks values registered as `secrets.*`, so a token that arrived any other way (a `.npmrc` read at build time, a value derived/re-encoded from a secret, a locally-run build) is echoed verbatim. The gate that exists to stop a baked credential from shipping is the thing that discloses it.
- **Evidence:**
  ```ts
  if (secretEnv.test(line)) findings.push(`layer history bakes a secret-shaped value: ${line.trim()}`);
  ```
  and `scripts/build-image.ts:80-84`, whose own docblock states the rendering: "BuildKit renders a build-arg-tainted layer as `|1 NPM_TOKEN=… /bin/sh -c npm install`".
- **Confirmed by:** read `SECRET_ENV` at `scripts/build-image.ts:83` — the regex ends `=\S`, i.e. it matches *because* a value follows, and nothing between the match and the `die` redacts the right-hand side. Every other finding in this file reports a path only (`credential inside /${p}`, `credential in the image: /${entry}`); this is the one that reports content. Same shape as DF2.9's `build-image.ts:184`, so it is inherited rather than introduced — but this file re-implements the loop locally (to strip `g` from the regex) and its CI destination is a workflow whose log is not redacted.

## [HIGH] A dry-run pin is adopted from a `containerimage.digest` nothing verified
- **File:line:** `scripts/build-exedev-image.ts:1864`
- **Trigger:** `bun scripts/build-exedev-image.ts --tag <ref>` **without** `--push` (the workflow's `DRY_RUN` arm). The solve declares two exporters against one `--metadata-file`; when buildx writes a single flat `containerimage.digest`, `distinct.size === 1` and that value is accepted as `builtDigest` with no evidence it describes the `type=image` exporter rather than the `type=docker` archive. It is then written to the evidence JSON, and `publish-exedev-image.yml:752-758` offers it to a human as the pin to commit ("To adopt it anyway, replace the two constants in $DRIVER with exactly these lines"). On any buildx that attributes the flat key to the first-declared exporter, the operator commits a docker-archive manifest digest as the driver pin and every box then pulls a digest no registry holds.
- **Evidence:**
  ```ts
  const builtDigest = digests.get("image") ?? (distinct.size === 1 ? [...distinct][0]! : null);
  ```
  and the file's own admission two comment-lines above: "on a `--push` run the registry read-back equality below is what PROVES the flat key described the type=image exporter".
- **Confirmed by:** the equality that supplies that proof (`digest !== builtDigest`, line 2030) is inside `if (opts.push)`. Read `publish-exedev-image.yml:506-520` — `--push` is appended only when `DRY_RUN` is empty — and `:725-760`, which prints `actual digest` from the un-pushed run and instructs adoption. There is no dry-path check that the archive and image exporters agree (e.g. no second read of the builder's content store).

## [HIGH] Two temp trees under `os.tmpdir()` — one holding copied credential files — are never swept
- **File:line:** `scripts/build-exedev-image.ts:941` and `:1885` (creation), `:1730-1738` (the only startup sweep)
- **Trigger:** SIGKILL / OOM-kill / SIGHUP / power loss during `scanImage`. The scan buffers the whole `docker export | tar` listing with `maxBuffer: 2048 * 1024 * 1024` plus a 256 MB `find` buffer, so an OOM-kill mid-scan is the realistic instance of exactly the death class the leak-handler docblock names ("SIGKILL and SIGHUP run no handler at all… the deaths no handler can see are why `main()` sweeps stale `run-*` siblings at startup"). That sweep only ever reads `BUILD_DIR`; `/tmp/qds-exedev-scan-XXXXXX` and `/tmp/qds-exedev-tree-XXXXXX` survive forever and accumulate one per uncleanly-died run. The scan dir is the one the file itself describes as "the one temp tree in this script whose contents can be a real private key" (`:942-947`).
- **Evidence:**
  ```ts
  const scratch = makeTempDir(path.join(os.tmpdir(), "qds-exedev-scan-"));
  const treeDir = makeTempDir(path.join(os.tmpdir(), "qds-exedev-tree-"));
  …
  staleEntries = fs.readdirSync(BUILD_DIR);
  for (const entry of staleEntries) { if (!entry.startsWith("run-")) continue; …
  ```
- **Confirmed by:** grepped the whole file for `tmpdir` — exactly two creations, both under `os.tmpdir()`, neither with any corresponding startup sweep. The only self-healing sweep is scoped to `BUILD_DIR` (`oci/.build/exedev`) and matched on the `run-` prefix. `.dockerignore` and `publish-exedev-image.yml` clean nothing under `/tmp` either. `leaked.paths` covers only the in-process exit/SIGINT/SIGTERM paths, which the docblock at `:250-256` already concedes.

## [MEDIUM] A failed registry read silently substitutes the daemon's stale digest for the base
- **File:line:** `scripts/build-exedev-image.ts:669-673`
- **Trigger:** an unpinned `FROM` (a shape this code path exists for — it refuses only `$`-templated refs) plus any registry failure: 401, 403, a ghcr/Docker Hub 429, a DNS blip, an expired login. `tryRun` collapses all of them to `null`, and the very next line accepts `{{index .RepoDigests 0}}` off the local daemon — whatever it last pulled under that floating tag, possibly weeks old. Meanwhile buildx does its own resolution over the network and builds against the *current* tag. Result: `buildId` (the identity gate B asserts in-box, INV-IBOX-2) and `runtimeBasePinned` both name a substrate the build did not use, and AC5's negative control then subtracts the wrong image's executables — the exact "three independent resolutions of one floating tag" failure the `runtimeBasePinned` comment at `:870-874` claims to have closed.
- **Evidence:**
  ```ts
  const viaRegistry = manifestDigest(ref);
  if (viaRegistry !== null) return viaRegistry;
  const local = tryRun("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", ref]);
  const fromLocal = local?.match(/@(sha256:[0-9a-f]{64})$/);
  if (fromLocal) return fromLocal[1]!;
  ```
- **Confirmed by:** `manifestDigest` (`:646-655`) returns `null` for *every* failure mode — `tryRun` discards status and stderr alike — so nothing distinguishes "the registry said X" from "the registry could not be reached and the daemon remembers X". `oci/exedev/Dockerfile:51` is digest-pinned today (`ghcr.io/boldsoftware/exeuntu@sha256:4398…`), so the path is dormant, but nothing in this script requires that: the `die` message at `:674-677` offers pinning only as a remedy after both reads fail.

## [MEDIUM] `--summary` / `--evidence` deletes any repo file outside a five-entry allowlist
- **File:line:** `scripts/build-exedev-image.ts:1658` (the allowlist), `:1677-1689` (the deletion)
- **Trigger:** `bun scripts/build-exedev-image.ts --evidence src/providers/exedev/driver.ts` — a shell-completion slip or a copied command. `driver.ts` is not in `protectedInputs`, so `fs.rmSync(stale, { force: true })` destroys it, `fs.writeFileSync(stale, "")` recreates it empty, and the second `rmSync` removes it again — all before the build, which then runs with `REPO_ROOT` as its context. The file destroyed is the one holding the digest pin this whole script exists to feed. `--summary .env` or `--summary ~/.docker/config.json` is unrecoverable (untracked).
- **Evidence:**
  ```ts
  const protectedInputs = [DOCKERFILE, SYSTEMD_DIR, BINARY_LICENSES, LICENSE_TEXTS, path.join(REPO_ROOT, "package.json")];
  const insideOrEqual = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + path.sep);
  ```
- **Confirmed by:** `parseValueFlags` applies `path.resolve(value)` and nothing else (the comment at `:1652` says so); `TAG_RE` guards only `--tag`. `insideOrEqual` tests only out-inside-input, and there is no containment test against `BUILD_DIR`, no repo-root check, and no `fs.existsSync`/`git ls-files` refusal. The guard's own docblock scopes itself to "the inputs this script actually consumes" — the scoping is deliberate; the resulting deletion of arbitrary tracked and untracked files is not guarded anywhere else.

## [MEDIUM] AC5 binary attribution matches basenames only, so `bun` and `pi` are wildcards
- **File:line:** `scripts/build-exedev-image.ts:1480-1481`
- **Trigger:** `oci/exedev/binary-licenses.json` contains exactly two entries, `"names": ["bun"]` and `"names": ["pi"]`. Any executable this image adds whose *basename* is `bun` or `pi` — at any path, from any project — passes the gate unquestioned. `exeuntu update pi --version` unpacks a release tree (the Dockerfile's own `ARG PI_VERSION` install at `:99`); a bundled helper or second entry point named `pi` anywhere in that tree is auto-attributed to Bold's entry, and a wholly unrelated program dropped at `/opt/x/bun` is attributed to Oven. The negative control was strengthened to catch content-level replacement (`baseBins.get(p) !== sha`) but the coverage lookup that consumes it throws the path away.
- **Evidence:**
  ```ts
  const covered = new Set(entries.flatMap((e) => e.names));
  return added.filter((p) => !covered.has(path.basename(p)));
  ```
- **Confirmed by:** grepped `oci/exedev/binary-licenses.json` — both `names` arrays hold bare basenames. `validateBinaryLicenses` (`:1344`) requires only "at least one binary basename": there is no path field, no anchoring, and no uniqueness or specificity check, so the table cannot express "this entry covers `/usr/local/bin/bun` and nothing else."

## [MEDIUM] `dockerfileArgDefault` reads only the first `ARG NAME=` in the file
- **File:line:** `scripts/build-exedev-image.ts:736`
- **Trigger:** the multi-stage Dockerfile this script's own comments say is coming ("DF1.10 adds an engine build stage to this same file", `:1798-1802`). A Dockerfile `ARG` must be re-declared in every stage that uses it, so `BUN_VERSION`/`PI_VERSION` will exist twice. The `m`-flag `match` returns the first occurrence, so a stale default in the *runtime* stage — the stage that actually installs bun and pi — passes the lockstep check silently. That is precisely the divergence this function exists to catch, and its docblock names the consequence: "a bare `sha256sum -c` mismatch ten QEMU-emulated minutes in, with a bare checksum mismatch that names neither cause."
- **Evidence:**
  ```ts
  const m = dockerfile.match(new RegExp(`^\\s*ARG\\s+${name}=(\\S+)\\s*$`, "m"));
  return m ? m[1]! : null;
  ```
- **Confirmed by:** `m` not `g`, and `String.prototype.match` without `g` returns only the first match. Verified `oci/exedev/Dockerfile` has a single `FROM` (line 51) and one declaration each of `ARG BUN_VERSION=1.3.13` (line 70) and `ARG PI_VERSION=0.84.4` (line 99), so the second declaration cannot exist yet — the check is correct today and silently degrades the moment a stage is added. Also note the regex requires the line to end at the value: `ARG PI_VERSION=0.84.4  # comment` returns `null` and reports "declares no ARG PI_VERSION".

## [LOW] Two unguarded I/O calls on the clean path report a compliance failure (exit 1)
- **File:line:** `scripts/build-exedev-image.ts:1958` and `:1961`
- **Trigger:** ENOSPC (or a `renderNotice` throw) between the writability pre-check at `:1688` and the NOTICE write. By that point the run has extracted an Ubuntu filesystem to `/tmp` and written a ~1.6 GB archive, so filling the disk in the interval is the realistic case. Both calls sit outside any `try`, so the throw propagates out of `main()`, bun exits **1** — the code this file's header reserves for "compliance failure" — and `publish-exedev-image.yml`'s classifier treats 1 as "the gates ran and said no — never the registry", printing a licence diagnosis for a disk fault.
- **Evidence:**
  ```ts
  const notice = renderNotice(sweep, { imageRef: opts.tag, installFlags: "(none — binary image)", sweptAt: builtAt });
  const gaps = verifyNoticeCoverage(notice, sweep.uncovered);
  if (gaps.length > 0) die(1, [`the NOTICE fails to cover: ${gaps.join(", ")}`]);
  fs.writeFileSync(NOTICE_PATH, notice);
  ```
- **Confirmed by:** every other I/O in this file converts to `die(2)` on purpose — `readInput` (`:751`), `makeTempDir` (`:767`), `writeJson` (`:1556`, whose docblock argues this exact point), the stale-artifact loop (`:1690`), the metadata read (`:1841`). The *identical* `renderNotice` call in the failure branch at `:1905` **is** wrapped in `try`/`catch`; the clean-path one is not.

## [LOW] The local tag survives every failure after `docker tag`, contradicting the header
- **File:line:** `scripts/build-exedev-image.ts:1987`
- **Trigger:** `--push` where the registry read-back disagrees. `docker tag imageId opts.tag` runs at `:1987`; the push, the `manifestDigest` failure `die(2)` at `:2019`, the digest-mismatch `die(1)` at `:2030` and both `writeJson` `die(2)`s all follow it, and `die` is `process.exit` — the `finally` never runs, and the tag is not tracked in `leaked`. The header's claim, "Nothing is tagged LOCALLY until every check has passed, so a failed build leaves no local artifact behind," carves out an exception only for the *pushed* digest, not for the local tag.
- **Evidence:**
  ```ts
  run("docker", ["tag", imageId, opts.tag], "docker tag");
  …
  if (digest !== builtDigest) { die(1, [`the pushed digest is not the digest the gates read: …`]); }
  ```
- **Confirmed by:** `sweepLeaks` (`:263-275`) removes only container ids and paths — there is no tag entry and no `docker rmi` on any failure path after `:1987`. Self-limiting in practice: the next run's `docker rmi -f opts.tag` preflight at `:1705` clears it, so the residue only misleads a human who runs `docker push <tag>` by hand after the mismatch.
