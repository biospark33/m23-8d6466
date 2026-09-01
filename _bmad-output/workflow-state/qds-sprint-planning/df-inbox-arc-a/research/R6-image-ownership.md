# R6 — Image Ownership (factory-owned exe.dev boot image)

Research feed for story **DF2.10 "Factory-owned boot image"**, consequence 1 of
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:105-107`.

**Evidence tags used throughout:**
- **MEASURED** — a live probe in this repo's evidence tree, or a command I ran during this research.
- **VENDOR-DOC** — quoted from exe.dev docs or the open-source exeuntu Dockerfile (fetched 2026-08-31).
- **INFERRED** — my reasoning from the two above. Not a fact. Several INFERRED items below are
  load-bearing enough that the story should carry a probe AC rather than an assumption.

---

## 0. The one-paragraph answer

The exe.dev boot image is a **new, separate image derived from exeuntu** — it is *not*
`oci/Dockerfile` extended, and it must not be. `oci/Dockerfile` is the **enterprise client-VPC
tier** image (D7's second sales segment): `node:22-bookworm-slim`, no systemd, `USER node`, a
`CMD` that runs pi as a coms extension. The exe.dev boot image is the **hosted-tier substrate**:
it must satisfy exe.dev's boot contract (systemd as PID 1 via `/usr/local/bin/init`, an `exedev`
login user, the `exe.dev/login-user` label, exeuntu's masked-ssh arrangement). Nothing in
`oci/Dockerfile` transfers except the *machinery* DF2.9 shipped — the license sweep, the canonical
license texts, and INV-5 — which the new image should reuse **as a gate**, not as a base layer.

---

## 1. exe.dev image mechanics

### 1.1 `new` flags — the authoritative list

**MEASURED** (`ssh exe.dev help new`, run 2026-08-31 during this research; identical to
VENDOR-DOC `https://exe.dev/docs/cli-new.md`, and consistent with the DF1.10 probe's
`image-override-flags` phase at `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json:11`):

```
  --comment       short note about the VM (max 200 bytes)
  --cpu           number of CPUs (default 2; run 'billing plan' for plan limits)
  --disk          disk size (e.g., 20, 20GB, 50G)
  --env           environment variable in KEY=VALUE format (can be specified multiple times)
  --image         container image
  --integration   integration name to attach (can be specified multiple times or comma-separated)
  --json          output in JSON format
  --memory        memory allocation (e.g., 4, 4GB, 8G)
  --name          VM name (auto-generated if not specified)
  --no-email      do not send email notification
  --pool          create the VM in one of your team's pools (see 'pool list')
  --prompt        initial prompt to send to Shelley after VM creation (requires an image with
                  Shelley, like exeuntu); use /dev/stdin to read from stdin
  --registry-auth private container registry credentials as USERNAME:PASSWORD
                  (e.g. octocat:ghp_xxx) for the registry hosting --image
  --setup-script  setup script to run on first boot (max 10KiB); supports \n for newlines;
                  use /dev/stdin to pipe from stdin
  --tag           tag to add to the VM (can be specified multiple times or comma-separated)
```

Example from the same help text: `new --name=b --image=ubuntu:22.04  # custom image and name`.
So a bare Docker Hub reference is accepted; **no example shows a digest reference** (see §4.1).

### 1.2 Setup scripts

**VENDOR-DOC** (`/docs/customization.md`): "The exeuntu image runs `/exe.dev/setup` at first boot,
once." Delivery: `cat setup.sh | ssh exe.dev new --setup-script /dev/stdin`, or inline, or as an
account default via `ssh exe.dev defaults write dev.exe new.setup-script`. Constraint quoted
verbatim: **"Setup scripts have a maximum size. Use indirection."** — quantified by the help text
as **max 10KiB**.

**Mechanism** (VENDOR-DOC, exeuntu Dockerfile): the first-boot hook is a systemd oneshot unit
baked into the image —
```dockerfile
# Create systemd oneshot service for /exe.dev/setup script
COPY exe-setup.service /etc/systemd/system/exe-setup.service
RUN chmod 644 /etc/systemd/system/exe-setup.service && systemctl enable exe-setup.service
```
This confirms the DF1.10 probe's conclusion (evidence file `:45`): *"the `/exe.dev/setup`
first-boot-only limitation is irrelevant, systemd is the boot hook"* — a factory-owned image can
simply bake its own enabled unit and never depend on `--setup-script` for anything that must
survive reboot.

### 1.3 Labels

**VENDOR-DOC**, both from `/docs/customization.md` and confirmed as the literal last two lines of
the exeuntu Dockerfile:
```dockerfile
LABEL "exe.dev/login-user"="exedev"
LABEL "exe.dev/install-shelley"="true"
CMD ["/usr/local/bin/init"]
```
- `exe.dev/login-user=<user>` — the SSH login user exe.dev connects as.
- `exe.dev/install-shelley=true` — exe.dev installs the Shelley binary into `/usr/local/bin` at VM
  creation. (The *units* are baked in the image: `shelley.socket` / `shelley.service`, socket-activated,
  `systemctl enable shelley.socket`; only the binary is injected at creation.)

**INFERRED, story-relevant:** a factory image can drop `install-shelley` (we never solicit Shelley;
tier-2/tier-3 solicit pi over OpenRouter). Dropping it removes a vendor-controlled binary injection
from the boot path. But `--prompt` stops working, and it is unknown whether any exe.dev-side
health/readiness check keys off Shelley. **Probe before dropping.**

### 1.4 The default exeuntu image — what it actually provides

**VENDOR-DOC:** source is open at `https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile`
(fetched verbatim during this research). Salient contents:

| Element | Detail |
|---|---|
| Base | `ubuntu:24.04`, un-minimized, full `dist-upgrade`, man pages restored |
| Init | `systemd systemd-sysv` installed; `systemctl set-default multi-user.target`; a long mask/disable list; `/etc/systemd/system.conf.d/container-overrides.conf`; journald `Storage=persistent` |
| Entrypoint | `CMD ["/usr/local/bin/init"]` — a copy of `init-wrapper.sh`, with a source comment: *"This is called init so that exetini decides this wrapper script is an init, and exec's it rather than forking it."* |
| SSH | `openssh-server`/`openssh-client` installed; **baked host keys deleted** (`rm -f /etc/ssh/ssh_host_*`); **`ssh.socket` and `ssh.service` are masked** — exe.dev's own layer owns SSH ingress |
| User | `ubuntu` (UID 1000) renamed to `exedev`; home moved to `/home/exedev`; added to `sudo` + `docker`; `exedev ALL=(ALL) NOPASSWD:ALL`; systemd linger enabled |
| Filesystem | `/etc/fstab` = `/dev/vda / ext4 defaults,x-systemd.growfs 0 1` so `systemd-growfs@-.service` resizes root on first boot; `tmpfiles-tmp.conf` stops systemd wiping `/tmp` |
| machine-id | emptied last (`: > /etc/machine-id`) so each VM generates its own; the comment warns that *removing* it makes systemd treat boot as first-boot and **re-enable every disabled unit** |
| Tooling | `git jq sqlite3 curl vim neovim nginx make python3-pip tree build-essential pipx sudo socat unzip rsync docker.io docker-buildx docker-compose-v2 imagemagick ffmpeg bubblewrap mitmproxy tailscale ripgrep`, latest stable Go, `uv`, `gh` (ARG `GH_VERSION`), Chrome via `chromedp/headless-shell` |
| Agents | `exeuntu update claude`, `exeuntu update codex`, `exeuntu update opencode` (root, into `/usr/local/bin`); **pi** via `ARG PI_VERSION` → `exeuntu update pi --home /home/exedev [--version "$PI_VERSION"]` → `/home/exedev/.local/bin/pi`, symlinked `/usr/local/bin/pi` |
| pi extras | `pi-extension/` copied to `~/.pi/agent/extensions/exe-dev/`, catalog fetched from `https://exe.dev/llm-gateway-models.json`; `fd` pre-installed at `~/.pi/agent/bin/fd` |
| Ports | `EXPOSE 8000 9999` |
| **NOT present** | **bun**, **node** (only `python-is-python3`; node is absent — matches the probe) |

The pi install path in the Dockerfile is exactly what the probe measured on a live box
(evidence `:16`): `/usr/local/bin/pi -> /home/exedev/.local/bin/pi, COMPILED ELF STANDALONE
BINARY, version 0.84.4`. The Dockerfile's `ARG PI_VERSION` + `exeuntu update pi --version` is
**the vendor-supported pin point** for pi, and `/docs/upgrade-codex.md` documents the same flag
for a running VM (`exeuntu update pi --version 1.2.3`).

### 1.5 Image constraints

- **Size:** not documented anywhere I could find. **INFERRED:** exeuntu is itself very large
  (un-minimized Ubuntu + Chrome + Go + build-essential + ffmpeg), so a derived image adding bun
  (~100 MB) is not near any plausible ceiling. Still unmeasured — the story should record the
  built size and the observed cold-boot time as evidence rather than assert a limit.
- **Boot contract (INFERRED from the Dockerfile, high confidence):** an image must ship
  (a) an entrypoint literally named `init` so exetini `exec`s rather than forks it,
  (b) systemd able to reach `multi-user.target`,
  (c) a login user matching `exe.dev/login-user`,
  (d) sshd present but with `ssh.service`/`ssh.socket` masked and no baked host keys,
  (e) an empty-not-absent `/etc/machine-id`,
  (f) the `x-systemd.growfs` fstab line if the disk is to resize.
  Every one of these is satisfied for free by `FROM exeuntu`. Re-deriving them from `ubuntu:24.04`
  is a large, silent-failure-prone surface. **Recommendation: derive, do not re-derive.**
- **Where exeuntu is published:** the Dockerfile is public; the *published image reference* is
  **not documented** and I did not find one. **This is the single biggest open question in the
  story.** Two shapes follow (§6.2) depending on whether `FROM <published exeuntu>` is possible or
  the repo must be cloned and built locally. **Probe AC required.**

---

## 2. Relationship to DF2.9's OCI image contract

Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-9-oci-image-contract-licensing.md`
(done, PR #105, merged `43ca5e7` 2026-08-14).

### 2.1 They are different images for different tiers — do not merge them

`oci/Dockerfile` is the **enterprise client-VPC** artifact. Concretely
(`oci/Dockerfile:41,61,81,88`):

- `FROM node:22-bookworm-slim@sha256:83f487e0…` (digest-pinned; F084) — Debian slim, **no systemd**
- `USER node` — not `exedev`
- `CMD ["node_modules/.bin/pi", "-e", "pi-vs-claude-code-vendor/coms.ts"]` — pi as a coms extension,
  not an init
- pi arrives as the **npm package** `@mariozechner/pi-coding-agent@0.55.0` (`oci/Dockerfile:49-50`),
  not the compiled ELF exeuntu ships
- no `exe.dev/*` labels, no sshd, no `exedev` user

Design basis for the split: D7 (`…architecture-design.md:304`) — *"provider-driver interface with
two first-class drivers — exe.dev (hosted/mid-market tier) and OCI images (client-VPC/enterprise
tier)"*, with the aspiration *"same factory image serves both."* **INFERRED:** that aspiration does
not survive contact with exe.dev's boot contract. The hosted-tier image must be systemd/exeuntu-
shaped; the enterprise image must be a minimal non-systemd container a client's Kata/Firecracker
runtime accepts. A single image satisfying both would be exeuntu-sized in a client VPC — the exact
opposite of the enterprise pitch. **Two images, one shared gate.**

DF2.9 itself scoped this out explicitly (Trigger Surface `df2-9…md:107`): *"exe.dev VM provisioning
from this image | out-of-scope — this story defines the image, not its runtime."*

### 2.2 What DF2.10 *should* reuse from DF2.9

| Asset | Path | How DF2.10 reuses it |
|---|---|---|
| License sweep engine | `scripts/lib/license-sweep.ts` | Run it against the **new image's** tree. It takes a tree path, so it is already image-agnostic. |
| Generator + gate CLI | `scripts/generate-notice.ts` (owns exit codes 0/1/2) | Same. `--tree`, `--out`, `--license-texts`, `--summary`, `--image-ref`, `--install-flags` (`generate-notice.ts:26,70`) |
| Canonical license texts | `oci/license-texts/*.txt` — 7 texts: MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0 | Shared verbatim. |
| Build orchestration pattern | `scripts/build-image.ts` — deps-build → extract → sweep → runtime-build → credential scan → tag | The DF2.9 round-3 lesson (`df2-9…md:412-425`) applies identically: **bind the swept tree to the shipped tree** via `ARG DEPS_IMAGE`, or the NOTICE describes a tree that was never shipped. |
| INV-5 credential scan | in `build-image.ts` | Non-negotiable for DF2.10 (§5.2). |
| Base-digest bump ritual | `oci/Dockerfile:35-40` + `.github/dependabot.yml` (`docker` ecosystem, directory `/oci`, weekly) | Directly transferable; DF2.10 adds a second directory entry. |

**Sweep applicability caveat (MEASURED, from DF2.9's own follow-ups, `df2-9…md:431-437`):** the
sweep walks a **`node_modules` tree**. The exe.dev image's pi is a **compiled ELF binary with no
`node_modules`**, so the sweep has nothing to walk for it. `bun`'s own redistribution licensing is
likewise outside the sweep's model. This is a real gap the story must decide about, not paper over:
either (a) widen the sweep to a set of extra directories (DF2.9 already names this as the natural
follow-up), or (b) attribute the compiled binaries from a small checked-in override table with an
explicit, tested assertion that the table is non-empty and covers every binary the image adds.
Option (b) is the smaller diff; option (a) is what DF4.1 will want anyway. **Flag as an explicit
story decision with a named owner.**

### 2.3 The pi-version collision (this is the story's sharpest edge)

Three different pins, three different channels, all currently live:

| Where | Channel | Version | Cite |
|---|---|---|---|
| `oci/Dockerfile:50` | npm `@mariozechner/pi-coding-agent` | **0.55.0** (hard-pinned; off-pin fails the build, AC2) | MEASURED |
| `src/providers/exedev/setup-gate.ts:422` | assertion message | *"the image contract requires pi 0.55.0"* | MEASURED |
| Live exe.dev box | exeuntu `exeuntu update pi` | **0.84.4** compiled ELF | MEASURED, probe `:16` |
| `src/providers/exedev/assertions-in-box.sh:179-186` | F14 workaround | *"the box image drifted — pi 0.84.2 never writes models.json"* — gate D was **weakened** to tolerate the absent `~/.pi/agent/models.json` | MEASURED |
| `src/fleet/resident.ts:51,422` | host-side spawn | comments assert *"pi 0.55.0's contract"* for `-p` argv delivery | MEASURED |

F14 is the visible scar: an in-box gate assertion was relaxed because the substrate's pi moved and
the factory's pin did not. The ADR names retiring this drift as a deliverable
(`…tier2-placement-adr.md:107`: *"Also retires the pi 0.55.0/0.84.x drift"*).

**INFERRED recommendation for the story:** own **one** pi version for the exe.dev image, pinned via
exeuntu's supported knob — `--build-arg PI_VERSION=<x.y.z>` feeding
`exeuntu update pi --version` — and then **re-tighten F14**: `assertions-in-box.sh:185-187`'s
"absent is production-legal" arm exists only because the version was unowned. Once the image owns
the version, absence becomes a regression again. Make re-tightening F14 an AC, not a follow-up —
otherwise the story retires the drift and leaves the weakened assertion permanently in place.
Note that `oci/Dockerfile`'s 0.55.0 npm pin is a **separate tier's** pin and should be left alone
unless the story explicitly chooses to converge both; converging is a scope increase (0.55.0 is the
version F6 proved end-to-end and the version `pi-vs-claude-code-vendor` peer-pins).

---

## 3. Driver integration

### 3.1 The exact thread point

`src/providers/exedev/driver.ts:237-296`, `create(name, tag?)`. The argv is built at **`:249-255`**:

```ts
    const res = await this.control([
      "new",
      "--name",
      name,
      ...(tag === undefined ? [] : ["--tag", tag]),
      "--json",
    ]);
```

`control()` (`:216-218`) prefixes `["ssh", "exe.dev", …]` and hands it to the injected
`this.run` seam. `--image` and `--registry-auth` slot in as two more conditional spreads in that
same array literal. The diff is small; the *validation* is the work.

### 3.2 Validation is mandatory here — the existing code says why

`create()` already validates both of its current inputs at this trust boundary, and the comments
state the reason (`driver.ts:239-248`):

```ts
    // INV-2: the name becomes a public hostname; refuse before any command.
    assertValidRunId(name);
    // INV-2 (same trust boundary): tag interpolates into ssh argv, which ssh
    // concatenates into the remote command line — validate before any command.
    if (tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) { … "tag-invalid" … }
```

**ssh concatenates argv into a remote command line.** Any new argv-borne value inherits that
hazard. `--image` therefore needs its own grammar assertion (registry host / path / tag or digest,
no shell metacharacters) with a typed `ExeDevDriverError` in the same shape as `tag-invalid`.
`--registry-auth` needs the same, plus §5.2's secret handling.

### 3.3 Config-surface convention

`ExeDevDriverOptions` (`driver.ts:163-175`) is the convention, and its docstring is explicit:
**"Every field is injectable; none is env-magic."**

```ts
export interface ExeDevDriverOptions {
  run?: ExeCommand;          // command seam; defaults to sshCommand()
  postureFile?: string;      // ".sandbox/exedev-posture.json"
  execTimeoutMs?: number;
  requestId?: string;
  hostSuffix?: string;       // "exe.xyz"
}
```

Each is `opts.X ?? <literal default>` in the constructor (`:197-201`), and the constructor is the
stated validation point (`:190` *"round 6: constructor is the injection point — validate at the
trust boundary"*). So `image?: string` and a registry-auth accessor belong here, validated in the
constructor, **not** read from `process.env` inside `create()`.

**Where the value actually comes from at runtime:** the registry constructs the driver with **no
options at all** — `src/providers/index.ts:131`: `registerDriver("exedev", () => new ExeDevDriver());`.
So a default that only lives in `ExeDevDriverOptions` will never be set in production. The story
must pick one and say so:
1. a module-level default constant in `driver.ts` (mirrors `hostSuffix = "exe.xyz"`, which is
   likewise a substrate fact with a code-literal default) — **recommended**, it keeps the image
   reference reviewable in the diff and pinnable in git; or
2. an env override read **at the registry factory** (`index.ts:131`), keeping `create()` env-free.

`QDS_*` is the env prefix convention if an override is added (35 existing vars; nearest analogues
`QDS_PROVIDER_DRIVER`, `QDS_PI_BIN`, `QDS_STEERING_ROOT`). Note `QDS_STEERING_ROOT` is the exact
precedent for "substrate path with a code default, env-overridable" — see
`STEERING_PROVISION_SCRIPT` at `driver.ts:87-92` (`root="${QDS_STEERING_ROOT:-/run/steering}"`).

### 3.4 Posture convention

`postureFile` defaults to `.sandbox/exedev-posture.json` (`driver.ts:198`) and is described as the
*"`vm-sharing: admins-only` operator attestation (INV-1)"* — a checked-in operator attestation file
read from disk. **INFERRED:** if the story wants the pinned image digest to be operator-attested
rather than code-literal, this is the existing pattern to follow. I lean against it (a digest in
git is more reviewable and diffs cleanly), but it is the honest alternative if the operator wants
image selection outside the code review path.

### 3.5 Downstream that must move with `create()`

- `provisionSteeringChannel()` (`driver.ts:308-316`) runs on **both** create success arms and will
  now run against the new image. Its script needs `sudo -n` and a writable `/run` — exeuntu gives
  `exedev` NOPASSWD sudo, so a derived image inherits it. **But**: the ADR/#180 fix is to make this
  declarative via `/etc/tmpfiles.d/qds-steering.conf` baked into the image. If DF2.10 bakes that
  file, `provisionSteeringChannel` becomes redundant-but-idempotent (`install -d` re-applies
  mode/owner). Decide whether DF2.10 bakes it or leaves it to the channel-lifecycle story; do not
  let both stories assume the other did it.
- `setupGate` gate B (`setup-gate.ts:413-435`) runs `command -v pi` then `pi --list-models` and
  judges on **content, never `$?`** (`:427-429`). A factory image that relocates or renames pi
  breaks gate B. Keep `/usr/local/bin/pi` as exeuntu places it.
- `scripts/pipeline-run-remote.ts:53,69` also constructs `new ExeDevDriver()` bare — same
  default-source question as §3.3.

### 3.6 `buildTeamSpawn` — correcting the ADR's cite

The ADR (`:107`) says the image *"makes `buildTeamSpawn`'s `file:"bun"` correct in-box."* The
symbol is real but it is **not in `src/`** — it lives at **`cli-anything/src/team-events.ts:36-48`**:

```ts
  if (runner === "local") {
    return {
      file: "bun",
      argv: [join(import.meta.dir, "..", "scripts", "team-lead-driver.ts")],
    };
  }
```

Two things follow. First, the claim is correct: this returns a bare `"bun"` for the
`QDS_TEAM_RUNNER=local` path, and `setup-gate.ts:361-373` writes `QDS_TEAM_RUNNER=local` into the
box's env file — so today the local runner names a binary the box does not have. Shipping bun in
the image does fix it. Second, `argv` resolves `scripts/team-lead-driver.ts` **relative to
`import.meta.dir`**, i.e. relative to the checked-out repo, not to any image path. So bun-in-image
is necessary but not sufficient: the in-box clone must also be positioned so that join resolves.
That is the in-box engine story's problem, but DF2.10 should not claim to have closed it.

---

## 4. Pinning

### 4.1 Digest pinning — supported? UNVERIFIED, and it gates the story

The ADR asks to *"publish, pin by digest"* (`:106`). But:
- `--image` is documented only as *"container image"*; the sole example is `ubuntu:22.04`
  (VENDOR-DOC, MEASURED help text). **No documentation or example shows `name@sha256:…`.**
- The probe measured only that `--image` *exists* (evidence `:11`); it never booted a box from a
  custom image, let alone a digest reference.

**This is an unmeasured load-bearing assumption.** The story needs a probe AC: create one throwaway
box with `--image=<ref>@sha256:<digest>`, confirm exit 0 and that the box boots and answers ssh.
If digest references are rejected, the fallback pin is an **immutable tag** (a tag never re-pushed,
enforced by the publish workflow) with the digest recorded in-repo and **verified in-box after
boot** rather than enforced at pull time — a weaker but honest pin. Say which one shipped.

### 4.2 Existing digest-pin precedent in this repo

`oci/Dockerfile:29-41` is the model, and its comment is worth reusing verbatim in spirit:

> F084: digest-pinned, not `node:22-bookworm-slim`. The mutable tag re-resolves on every cold
> build, so every OS package in the shipped image floats outside the pinning this file is otherwise
> fanatical about … BUMP PROCEDURE: `docker buildx imagetools inspect node:22-bookworm-slim` and
> copy the top-level `Digest:` value into BOTH FROM lines below … Dependabot's `docker` ecosystem
> (.github/dependabot.yml) opens the bump PR weekly.

`.github/dependabot.yml` carries the matching entry (`package-ecosystem: docker`, `directory: /oci`,
weekly). **DF2.10 adds a second `docker` entry for the new image's directory** — cheap, and it is
the repo's established answer to "who notices when the base moves."

### 4.3 Where the digest should be *asserted*

Three candidate sites, in increasing strength:

1. **Setup gate assertion (recommended).** `setupGate` already runs per-box, already judges on
   content not exit status, and already has the pi assertion (gate B) that the drift broke. Add an
   assertion that reads the image's own identity marker in-box and compares it to the pinned value.
   Bake the marker into the image — a file like `/etc/qds-image.json` carrying
   `{ imageRef, digest, piVersion, bunVersion, builtAt, gitSha }` — because **a box cannot read the
   digest it was pulled from**; only a baked marker makes the assertion possible in-box. This is the
   single highest-value design decision in the story: without a baked marker, no in-box assertion
   about image identity can exist at all.
2. **Driver-side:** `create()` logs the image reference it passed, alongside the existing
   `create_shape` provenance line (`driver.ts:274`). Cheap, and it makes every run's evidence carry
   the image it ran on. **Do this too** — it is two fields.
3. **Publish-workflow:** the CI job that publishes records the digest into the repo (or fails if
   the checked-in digest does not match what it just pushed). Closes the loop between "what we
   published" and "what we pinned."

Also re-tighten `assertions-in-box.sh:179-186` (F14) as §2.3 argues — a pinned pi makes the
"absent models.json is production-legal" arm obsolete for factory-owned boxes.

---

## 5. Image payload

### 5.1 Must carry

| Item | Why | Evidence |
|---|---|---|
| **bun**, version-pinned | The engine's runtime. Absent from exeuntu. MEASURED installable in seconds without root (`curl -fsSL https://bun.sh/install \| bash` → 1.4.0), persists across reboot, runs typed TS and `bun:sqlite` in-box (4 ms) | probe `:36,:48-52` |
| **pi**, version-pinned | tier-3 workers + resident solicitation. Present in exeuntu but **unpinned by us** — the F14 drift | probe `:16`; exeuntu `ARG PI_VERSION` |
| systemd | supervision (ADR consequence 3) + the `/run/steering` tmpfiles fix (#180) | MEASURED PID 1, `running`, enabled units re-run at boot, probe `:20-26,:45` |
| git, curl, python3, sqlite3, jq | already in exeuntu; `python3` is load-bearing — `assertions-in-box.sh:176+` runs `python3 -c` blocks for the cost/registry scan | exeuntu Dockerfile; `assertions-in-box.sh:165-204` |
| `exedev` user + `exe.dev/login-user` label + `init` entrypoint | boot contract | exeuntu Dockerfile |

**No separate sqlite dependency is needed for the engine** — `bun:sqlite` is a bun builtin and was
MEASURED working in-box (probe `:50`). Do not add a node-sqlite package to satisfy a requirement
bun already meets.

**bun version:** pin it. 1.4.0 is what the probe measured installing; whether that matches the
host's bun is unverified — check `packageManager`/CI's `oven-sh/setup-bun` pin and match, so the
in-box engine runs the runtime the tests ran on. The bun installer honours a version argument, so
`ARG BUN_VERSION` mirrors exeuntu's `ARG PI_VERSION` shape.

**Precedent for a compiled engine instead of bun (worth recording, probably not this story):** pi
itself is *"a COMPILED ELF STANDALONE BINARY"* and the probe explicitly calls this *"the in-image
precedent for shipping a compiled TS engine"* (`:16-17`). `bun build --compile` would remove the
bun runtime from the image entirely. **Do not do it in DF2.10** — it couples image ownership to
engine packaging and the engine does not exist in-box yet. Record it as the upgrade path.

### 5.2 Must NOT carry — D8, and one live conflict

D8 (`…architecture-design.md:305`) verbatim on the anti-pattern side: *"Long-lived keys in boxes;
push credentials in boxes; trusting a managed LLM gateway with unanswered logging"*, and on the
positive side *"secrets never in argv, no push credential in any box."*

DF2.9's **INV-5** (`df2-9…md:203-205`) is the enforceable form and transfers verbatim: *"the image
contains no API key, no `.npmrc` auth token, and no git credential … build-time secrets, if ever
needed, use BuildKit mounts and never `ENV`/`ARG` values that persist into a layer. Asserted by
scanning the built image's layer history and filesystem for credential-shaped files."* DF2.9's
round-2/round-3 hardening widened those patterns to `.env.local`/`.env.production`, `*.key`,
`*.jks`, `.docker/config.json`, and AWS's spaced `aws_secret_access_key = …`, and made the scanner
judge config files **by content**, because a stock `node:22` ships npm's own `.npmrc`
(`df2-9…md:401-425`). Reuse that scanner; do not rewrite it.

**⚠ The conflict the story must resolve, not inherit:** `--registry-auth USERNAME:PASSWORD` is
passed **on the ssh argv** that `create()` builds. D8 says *"secrets never in argv."* On the host,
argv is visible in the process table for the lifetime of the `ssh` invocation. Three options:

1. **Publish the image publicly** — no `--registry-auth` at all, and the conflict disappears.
   **Recommended** (see §6).
2. Private image with `--registry-auth` — then the story owes: a redaction assertion (the driver's
   instrumentation already redacts via `redactSecrets`, `index.ts` header and `driver.ts:31`, but
   that covers *logs*, **not the OS process table**), a narrowly-scoped read-only PAT with an expiry,
   and an explicit, written acceptance that D8's argv clause is being deviated from — with an
   operator gate, because "silent unratified deviation" is precisely the failure mode this whole
   ADR exists to unwind.
3. A pull-through/self-hosted registry on a VM (VENDOR-DOC mentions running `registry:2` on an
   exe.dev VM and referencing it by hostname) — more moving parts than the problem justifies.

**Also note (VENDOR-DOC, `/docs/private-image.md`), and it closes off the elegant option:** *"The
boot image is pulled host-side, before your VM exists — so the integration hostnames described
below (`<name>.int.exe.xyz`) are not available to this pull."* So the `integrations-oci-registries`
token-minting mechanism — which would have kept the credential off our host entirely — **cannot be
used for the boot image**. It only works for `docker pull` *inside* a running VM. `--registry-auth`
or a public image are the only two boot-time paths.

---

## 6. Registry options

### 6.1 ghcr.io specifics

**VENDOR-DOC** (`/docs/private-image.md`):
```
new --image=ghcr.io/OWNER/IMAGE:TAG \
    --registry-auth=USERNAME:TOKEN
```
ghcr.io requires *"a classic Personal Access Token with `read:packages`"*. (Docker Hub: *"a personal
access token with read scope."*) From `/docs/integrations-oci-registries.md`: fine-grained PATs work
for **public** packages; bad credentials are rejected **403, not 401** — worth knowing when the
first pull fails, because 403 reads like "forbidden repo" when it usually means "bad token."

### 6.2 Recommendation: **public ghcr.io image, digest-pinned**

| | Public | Private + `--registry-auth` |
|---|---|---|
| D8 argv-secret conflict | **none** | present; needs an explicit ratified deviation |
| Credential lifecycle | none to manage | PAT minting, rotation, expiry, revocation — new ops surface |
| Failure mode | pull fails loudly and identically for everyone | 403s that look like missing-repo errors; expired PAT breaks *every* box create at once |
| Leak exposure | image contents are public | image contents private |
| What actually leaks | **INV-5 already guarantees no secret is in the image.** The contents are: exeuntu (public), bun (public), pi (public npm/binary), our tooling | — |
| Cost | ghcr.io public is free | free too |

The image is, by INV-5's construction, entirely public software. Making it private buys obscurity
of *composition* and costs a D8 deviation plus a credential lifecycle. **Recommend public.**

Two caveats to state in the story rather than discover later:
- Public means the image ref is discoverable, and anyone can boot our exact substrate. Since the
  image carries no secret and no factory logic beyond runtime pinning, the honest security answer
  is that this leaks a dependency list. If the operator disagrees, that is a legitimate call — but
  it should be *made*, with option 2's costs on the table.
- Keep the `--registry-auth` **plumbing** in the driver even if unused at first: it is two argv
  entries plus validation, and adding it later means re-opening `create()`, which is a
  seven-round-review surface. Ship it validated, secret-scrubbed, and default-off. (This is the one
  place I'd argue *against* strict YAGNI, because the marginal cost is a conditional spread and the
  marginal cost later is another review of the highest-scrutiny function in the driver.)

---

## 7. Open questions the story must convert into probe ACs

1. **Is exeuntu published as a pullable image?** If yes, `FROM <ref>@sha256:…`. If no, the build
   clones `boldsoftware/exeuntu` at a pinned commit and builds it — which drags in that Dockerfile's
   own network fetches (Go from go.dev *unpinned* — `jq -r '.[0].version'` picks latest; `fd` from
   GitHub latest; the exe.dev catalog JSON) and makes our "digest pin" a pin over a
   non-reproducible build. **This materially changes the story's size.** Probe first.
2. **Does `--image` accept a digest reference?** (§4.1)
3. **Does the boot succeed with `exe.dev/install-shelley` removed?** (§1.3)
4. **What is the built image size and cold-boot time vs stock exeuntu?** Record as evidence; the
   ADR's re-opening criteria (`:121-125`) name *"registry limits, boot regressions"* explicitly.
5. **Does the license sweep have anything meaningful to say about a tree with no `node_modules`?**
   (§2.2) — decide (a) widen or (b) override table, and write the test either way.
6. **Does `provisionSteeringChannel` stay, or does the baked `tmpfiles.d` replace it?** (§3.5)

---

## 8. Cite index

| Claim | File:line |
|---|---|
| `create()` argv build point | `src/providers/exedev/driver.ts:249-255` |
| INV-2 trust-boundary validation + `tag-invalid` precedent | `src/providers/exedev/driver.ts:239-248` |
| `ExeDevDriverOptions` — "none is env-magic" | `src/providers/exedev/driver.ts:163-175` |
| Constructor as validation point | `src/providers/exedev/driver.ts:189-202` |
| `control()` ssh prefix | `src/providers/exedev/driver.ts:216-218` |
| Driver registered with zero options | `src/providers/index.ts:131` |
| Steering channel script + `QDS_STEERING_ROOT` default | `src/providers/exedev/driver.ts:87-92`, `:308-316` |
| Gate B: pi on PATH, content-not-`$?`, "requires pi 0.55.0" | `src/providers/exedev/setup-gate.ts:413-435` (msg at `:422`) |
| `QDS_TEAM_RUNNER=local` written into box env | `src/providers/exedev/setup-gate.ts:361-373` |
| F14 weakened models.json assertion | `src/providers/exedev/assertions-in-box.sh:179-193` |
| `buildTeamSpawn` `file:"bun"` (real location) | `cli-anything/src/team-events.ts:36-48` |
| Host-side resident pi spawn; `QDS_PI_BIN` | `src/fleet/resident.ts:348`, `:446-471` |
| Enterprise image: base digest pin + bump procedure (F084) | `oci/Dockerfile:29-41`, `:61` |
| Enterprise image: npm pi 0.55.0, `USER node`, coms CMD | `oci/Dockerfile:49-50`, `:81`, `:88` |
| `ARG DEPS_IMAGE` swept-tree binding | `oci/Dockerfile:17-22`, `:57`; rationale `df2-9…md:412-425` |
| INV-5 no-credential-in-layer | `df2-9…md:203-205`; scanner hardening `:401-425` |
| Sweep does not cover the vendored dir (follow-up) | `df2-9…md:431-437` |
| Dependabot docker ecosystem for `/oci` | `.github/dependabot.yml` |
| D7 two-tier driver decision | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md:304` |
| D8 credential architecture ("secrets never in argv") | same file `:305` |
| Probe: `--image`/`--setup-script`/`--registry-auth` available | `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json:11` |
| Probe: bun absent, installs in seconds, survives reboot | same `:14`, `:36`, `:46` |
| Probe: pi compiled ELF 0.84.4 | same `:16-17` |
| Probe: systemd PID 1, units re-run at boot | same `:20-26`, `:45` |
| Probe: bun runs TS + `bun:sqlite` in-box | same `:48-52` |
| ADR consequence 1 (image ownership) | `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:105-107` |
| ADR re-opening criteria (registry limits, boot regressions) | same `:121-125` |
