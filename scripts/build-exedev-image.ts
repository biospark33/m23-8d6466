#!/usr/bin/env bun
/**
 * Factory-owned exe.dev boot image build (story DF2.10).
 *
 * DF2.9's `build-image.ts` builds the ENTERPRISE image: a `node:22-slim` tree
 * with a real `node_modules` to sweep. This builds the HOSTED-tier boot image:
 * derived `FROM` exeuntu, systemd inside, pi as a compiled ELF, and exactly ONE
 * npm tree — the engine's own runtime closure at /opt/qds-factory/node_modules,
 * which DF1.10's route change made necessary and which the AC5 gate below admits
 * BY PATH and by nothing else. Same gates, different substrate, so the shape
 * of every check here is deliberately DF2.9's and only its subject changed.
 * Everything importable is imported; nothing is reimplemented.
 *
 * REPRODUCIBLE BY CONSTRUCTION. The publish workflow's gate is "pushed digest
 * == the digest pinned in driver.ts", and that is only a gate if an unchanged
 * tree rebuilds to an unchanged digest — otherwise it is a tripwire that fires
 * on every rebuild and gets bypassed the third time it does. Three things were
 * MEASURED to move the digest between two identical builds, and all three are
 * pinned here (see `sourceDateEpoch`, `ensureReproBuilder` and the `--output`
 * assembly in `main`):
 *
 *   * layer mtimes, stamped with wall-clock build time by BuildKit unless
 *     SOURCE_DATE_EPOCH is set AND `rewrite-timestamp=true` is asked for.
 *     MEASURED on a two-line probe image, both builds --no-cache with the SAME
 *     SOURCE_DATE_EPOCH and no rewrite-timestamp: sha256:5d87dd5b… then
 *     sha256:4d447208…. The epoch alone is not enough; it only sets the config's
 *     `created` field, and the layer tars keep real mtimes;
 *   * `QDS_BUILT_AT`, which used to be `new Date()` — a wall-clock value baked
 *     into /etc/qds-image.json defeats the whole exercise from inside the image;
 *   * the provenance attestation buildx attaches by default, which embeds
 *     build-time data and turns the pushed artifact into an INDEX whose digest
 *     moves even when the image manifest is stable. MEASURED, same probe, with
 *     rewrite-timestamp=true and provenance left at its default: two
 *     `application/vnd.oci.image.index.v1+json` digests, sha256:ded2fc69… then
 *     sha256:c8042e09…. With `--provenance=false --sbom=false` the same probe
 *     built --no-cache twice to sha256:390b728e… BOTH TIMES.
 *
 * The provenance tradeoff is real, is stated rather than hidden, and is PAID:
 * we lose buildx's own attestation manifest, and `publish-exedev-image.yml`
 * signs the pushed digest with `actions/attest-build-provenance` after the pin
 * gate instead. That bundle is an OCI REFERRER — a separate manifest naming
 * this image as its `subject` — so it does not perturb the digest it describes,
 * which the workflow asserts by re-reading the tag rather than assuming. An
 * in-band attestation that makes the artifact unpinnable buys nothing here: the
 * pin IS the supply-chain control on this path.
 *
 * Order, and each step's reason for being where it is:
 *
 *   1. preflight the builder — an absent buildx is fatal BEFORE anything else,
 *      and must name what to install rather than failing three commands later.
 *      `rewrite-timestamp` needs a `docker-container` driver (the default
 *      `docker` driver cannot export `type=image` at all), so a dedicated
 *      builder is ensured here rather than assumed;
 *   2. derive `buildId` deterministically from the substrate's inputs (base
 *      digests ‖ BUN_VERSION ‖ PI_VERSION ‖ Dockerfile bytes ‖ systemd bytes).
 *      This is the value the image bakes into /etc/qds-image.json and gate B
 *      asserts in-box (INV-IBOX-2). It is a pure function of its inputs so a
 *      rebuild is PROVABLY the same substrate — hence no timestamp, no git sha
 *      and no image ref in the hash: those change per build without changing
 *      what booted;
 *   3. build ONCE, exporting twice from that single solve: a docker archive
 *      that is loaded locally so every gate below reads the SHIPPED bytes, and
 *      a `type=image` export whose `--metadata-file` reports the manifest
 *      digest this build would publish — measurable on every run, push or not;
 *   4. sweep the built image's EXPORTED FILESYSTEM (AC5). Swept is shipped by
 *      construction because there is no second tree to disagree with. On THIS
 *      image the expected count is 0 and a NON-ZERO count is itself the
 *      finding: an npm tree crept in unnoticed;
 *   5. credential-scan layer history AND filesystem (INV-IBOX-1), by the
 *      content-judging scanner DF2.9 hardened over two rounds — a stock base
 *      really does ship npm's own `.npmrc`, so a filename-only scan is a scan
 *      that always fires and nobody reads;
 *   6. attribute the compiled binaries the package sweep cannot derive, over a
 *      coverage set COMPUTED by diffing the built image's executables against
 *      the base image's (AC5's negative control). An added binary with no
 *      entry in `oci/exedev/binary-licenses.json` stops the build;
 *   7. only then tag, and push when asked, recording the pushed digest;
 *   8. write the evidence JSON: size and cold-boot time are the ADR's two
 *      named re-opening falsifiers, RECORDED and never asserted against an
 *      invented ceiling (Technical Notes, explicit).
 *
 * Nothing is tagged LOCALLY until every check has passed, so a failed build
 * leaves no local artifact behind. Stated precisely because the `--push` path
 * cannot honour it in the same sense: a manifest digest does not exist until
 * the manifest is pushed, so the push happens first and the digest equality one
 * screen below REPORTS on it rather than gating it. What protects production is
 * the repo PIN — nothing boots a digest a human did not check in — while the
 * package accumulates per-revision tags nothing references.
 *
 * Exit codes match DF2.9's contract: 0 clean, 1 compliance failure, 2 fatal
 * before the gates could conclude (no builder, docker failure, missing input).
 *
 * Usage: bun scripts/build-exedev-image.ts [--tag <ref>] [--platform <p>]
 *          [--push] [--summary <file>] [--evidence <file>] [--keep-tree]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shQuote } from "../src/providers/exedev/transport.ts";
// DF2.9's INV-5 predicates, imported rather than copied. `build-image.ts`
// guards its entry with `if (import.meta.main)`, so importing it runs nothing —
// this is exactly what tests/scripts/license-sweep.test.ts already does.
import { classifyScanPath, configLooksLikeCredential, SECRET_ENV } from "./build-image.ts";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
// `sweepTree` is `walkTree` plus the classification; calling the walk again
// here would just be a second traversal of the same tree with a worse verdict.
import {
  renderNotice,
  resolveLicenseText,
  type SweepResult,
  type SweepSummary,
  summarize,
  sweepTree,
  verifyNoticeCoverage,
} from "./lib/license-sweep.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const IMAGE_DIR = path.join(REPO_ROOT, "oci/exedev");
const DOCKERFILE = path.join(IMAGE_DIR, "Dockerfile");
const SYSTEMD_DIR = path.join(IMAGE_DIR, "systemd");
const BINARY_LICENSES = path.join(IMAGE_DIR, "binary-licenses.json");
const LICENSE_TEXTS = path.join(REPO_ROOT, "oci/license-texts");
const BUILD_DIR = path.join(REPO_ROOT, "oci/.build/exedev");
const NOTICE_PATH = path.join(BUILD_DIR, "NOTICE");
const DEFAULT_SUMMARY = path.join(BUILD_DIR, "sweep-summary.json");
const DEFAULT_EVIDENCE = path.join(BUILD_DIR, "build-evidence.json");

export const DEFAULT_TAG = "ghcr.io/quantum-digital-solutions/qds-exedev:local";
const DEFAULT_PLATFORM = "linux/amd64";

/**
 * `[host[:port]/]path[:tag][@sha256:…]` — a docker reference grammar, enforced
 * on `--tag` before anything acts on it.
 *
 * Not tidiness. `opts.tag` is spliced raw into buildx's COMMA-SEPARATED option
 * CSV (`--output type=image,name=<tag>,rewrite-timestamp=true`), so a comma in
 * the tag is not part of a name — it is an additional exporter attribute, and
 * `push=true` is one of them. `--tag 'ghcr.io/x/y:v1,push=true'` would make the
 * PRE-GATE build publish: the one thing the two-`--output` split above exists
 * to prevent, defeated through the option parser rather than through a shell.
 * The grammar refuses `,` and `=` by construction rather than by a denylist.
 *
 * Enforced in `parseArgs`, which is `main`'s first statement and therefore
 * before the `docker rmi -f ${opts.tag}` further down. What that ordering buys
 * is that a MALFORMED tag cannot reach the removal — NOT that a well-formed one
 * is safe to name. Stated precisely because the previous wording claimed the
 * latter: `--tag ubuntu:22.04` is perfectly valid grammar here, and the
 * pre-build drop then force-removes the operator's local ubuntu image. That is
 * the documented contract of `--tag` (see `--help`: "The tag is DROPPED before
 * the build so that a failed build leaves nothing resolving under it"), and
 * this grammar is not what protects against mistyping it. What the grammar
 * protects against is exporter-attribute injection, which is a different thing.
 *
 * NO `@sha256:` arm, deliberately. A digest reference is valid docker grammar
 * but not a valid `--tag`: `docker tag <id> ref@sha256:…` is refused outright
 * ("refusing to create … a digest reference") and `--output type=image,name=`
 * cannot name an image by digest either — so admitting it here would fail ten
 * QEMU-emulated minutes in with an opaque "docker tag exited 1" instead of at
 * parse. Digest pins belong on the BASE refs in the Dockerfile, not here.
 */
export const TAG_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;

/**
 * The builder this script builds on, created on demand.
 *
 * `--output type=image,…,rewrite-timestamp=true` is not available on buildx's
 * default `docker` driver — that driver can only load into the daemon, and
 * MEASURED here it refuses the export outright. A `docker-container` builder
 * is the supported way to get it, so one is ensured by name rather than the
 * script depending on whatever the caller's default builder happens to be: a
 * reproducibility claim that silently depends on the operator's `buildx use`
 * is not a claim. CI needs no setup step for the same reason — the script
 * creates this builder on the runner if it is not there.
 */
const REPRO_BUILDER = "qds-repro";

/**
 * The pi the factory owns (AC2). NOT the npm pin: DF2.9's
 * `PI_CODING_AGENT_PIN` is 0.55.0 on the enterprise tier and the npm channel
 * stops at 0.73.x, while exeuntu installs a COMPILED ELF through
 * `exeuntu update pi --version` from the upstream release channel. 0.84.4 is
 * the version the DF1.10 box probe measured in-box and the version
 * `setup-gate.ts`'s "requires pi 0.55.0" message is corrected to. Bumping it
 * changes the buildId, which is the point: `assertions-in-box.sh`'s F14 arm is
 * version-conditional against THIS constant, so a bump that lands without
 * revisiting it is itself the refusal.
 */
export const PI_VERSION = "0.84.4";

/**
 * The `Install flags:` line the generated NOTICE carries, in one place because
 * three call sites had the same literal and a compliance reader gets whichever
 * one rendered.
 *
 * The wording is REPRODUCIBILITY, and the previous text was not reproducible:
 * `bun install --frozen-lockfile --production` at the workspace root produces
 * 264 package directories (oci/exedev/Dockerfile measures exactly that), and
 * the image ships TWO of them — `yaml` and `zod`, hand-copied out into the
 * engine's runtime closure. A reader who ran the command as printed and diffed
 * against this NOTICE got a 262-package superset and no way to tell whether
 * the table was under-reporting or their command was wrong. Naming the
 * narrowing, and naming the two packages, is the difference.
 */
const NOTICE_INSTALL_FLAGS =
  "bun install --frozen-lockfile --production, narrowed to the engine's runtime closure (yaml, zod)";

const HELP = [
  "usage: bun scripts/build-exedev-image.ts [options]",
  "",
  "  --tag <ref>       image reference to apply once every check passes",
  `                    [${DEFAULT_TAG}]. The tag is DROPPED before the build so`,
  "                    that a failed build leaves nothing resolving under it.",
  `  --platform <p>    build platform [${DEFAULT_PLATFORM}]. exe.dev boxes are amd64;`,
  "                    building this on an arm64 host runs under QEMU and is slow.",
  "  --push            push the tag after every gate passes, and record the",
  "                    pushed manifest digest in the summary and the evidence.",
  `  --summary <file>  structured sweep summary [${path.relative(REPO_ROOT, DEFAULT_SUMMARY)}]`,
  `  --evidence <file> build evidence JSON [${path.relative(REPO_ROOT, DEFAULT_EVIDENCE)}]`,
  "                    both are created AND DELETED by this run, so each must sit under",
  `                    ${path.relative(REPO_ROOT, BUILD_DIR)}/ or outside the repository, and the two must differ.`,
  "  --keep-tree       keep the extracted filesystem candidates for inspection",
  "",
  "exit: 0 clean · 1 compliance failure · 2 fatal (no builder / docker error)",
  "",
].join("\n");

function die(code: 1 | 2, lines: readonly string[]): never {
  return exitWithFailure("exe.dev image build FAILED:", code, lines);
}

/**
 * `fs.writeSync`, not `process.stdout.write`: on a pipe the async write can
 * still be pending when the process tears down, so a redirected build log loses
 * its last lines. Same reasoning as `exitWithFailure`, applied to stdout.
 */
function say(text: string): void {
  fs.writeSync(1, text);
}

function run(cmd: string, args: readonly string[], label: string): string {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (res.error) die(2, [`${label}: ${res.error.message}`]);
  if (res.status !== 0) die(2, [`${label} exited ${res.status ?? "on a signal"}`]);
  return res.stdout ?? ""; // dp:ok status 0 with encoding:utf8 always yields a string; a non-zero status already died above
}

/** Captured without dying: used where a failure is a fallback, not fatal. */
function tryRun(cmd: string, args: readonly string[]): string | null {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (res.error || res.status !== 0) return null;
  // dp:ok not a silent blank: empty is converted to an explicit null below,
  // which every caller treats as "unknown", never as "absent and fine".
  const out = (res.stdout ?? "").trim(); /* dp:ok converted to an explicit null on the next line — never a blank */
  return out === "" ? null : out;
}

/**
 * Everything this run must remove before the process goes away, whatever kills
 * it. `die` is `process.exit`, which does NOT unwind `finally` — so the
 * `finally` blocks below are correct for a THROW and useless for the ten
 * `die(…)` calls that are this script's actual failure mode. A repeatedly
 * failing build would otherwise accumulate stopped containers holding image
 * references (the very condition the preflight at the top of `main` refuses to
 * run under: "remove the containers holding it"), an extracted Ubuntu
 * filesystem per run under `os.tmpdir()`, and a ~1.6 GB archive.
 *
 * `tags` is the header's "a failed build leaves no local artifact behind",
 * enforced rather than asserted. `docker tag` runs BEFORE the push, before the
 * registry read-back's `die(2)` and before the digest-equality `die(1)` — all
 * three are `process.exit`, so without this the tag survives a failed run and
 * an operator who then pushes by hand publishes bytes a gate refused. The tag
 * is deregistered on the success path only, after the last write.
 *
 * `process.on("exit")` covers `die`, an uncaught throw and a normal return, and
 * runs synchronously — which is why every action here is a `*Sync` call.
 *
 * The signal handlers are a NARROW backstop, stated honestly: "exit" does not
 * fire on SIGINT/SIGTERM, but `main()` is fully synchronous end-to-end, and a
 * signal callback only runs when the event loop turns — so these handlers fire
 * in the gaps BETWEEN sync spawns at best, and a signal delivered mid-`docker
 * buildx build` mostly reaches the foreground child first (whose non-zero exit
 * routes through `run` → `die(2)` → the exit hook). SIGKILL and SIGHUP run no
 * handler at all. The deaths no handler can see are why `main()` sweeps stale
 * `run-*` siblings at startup — that sweep, not these handlers, is what makes
 * the design self-healing.
 *
 * Registered by {@link installLeakHandlers}, which runs ONLY under
 * `import.meta.main`: importing this module for unit tests must not install
 * process-wide exit/signal behaviour into the test runner (the tail comment's
 * import-safety claim, kept true).
 */
const leaked = { containers: new Set<string>(), paths: new Set<string>(), tags: new Set<string>() };

function sweepLeaks(): void {
  // BOUNDED. This runs from `process.on("exit")` and from the SIGINT handler,
  // and a `spawnSync` against a wedged dockerd blocks forever — so an operator
  // who Ctrl-Cs a build against an unresponsive daemon got a process that would
  // not die and never reached `process.exit(130)`. Thirty seconds is far past
  // any real `docker rm`; past it the leak stays for the next run's sweep,
  // which is what that sweep is for.
  const bounded = { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" } as const;
  for (const cid of leaked.containers) spawnSync("docker", ["rm", "-f", cid], bounded);
  leaked.containers.clear();
  for (const tag of leaked.tags) spawnSync("docker", ["rmi", "-f", tag], bounded);
  leaked.tags.clear();
  for (const p of leaked.paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // Best effort by definition: the process is already going away, and a
      // failure to remove a temp path must not mask the real exit code.
    }
  }
  leaked.paths.clear();
}

function installLeakHandlers(): void {
  process.on("exit", sweepLeaks);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      sweepLeaks();
      // 128 + signal number, the shell convention. Not 0: an interrupted build
      // did not conclude, and a caller reading the exit code must not read it
      // as a clean one.
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

// ────────────────────────────── reproducibility ──────────────────────────────

/**
 * The build's notion of "now": SOURCE_DATE_EPOCH, honoured from the
 * environment when set and derived from the IMAGE SOURCE REVISION's commit
 * timestamp when not.
 *
 * Honouring an externally-set value is the standard's contract, not a
 * convenience — a caller rebuilding an older revision (or a distro rebuilder
 * reproducing our published digest) sets it, and a script that overrode it
 * with its own git read would make that reproduction impossible.
 *
 * The fallback is `git log -1 --format=%ct <rev>` rather than `Date.now()`
 * because the value has to be a function of the SOURCE, exactly like the
 * buildId one screen down. `<rev>` is {@link imageSourceSha}'s answer, NOT
 * HEAD, and that is the half that makes the publish workflow's pin gate
 * converge. Both digest inputs have to track the SAME commit: with HEAD here
 * and the image-source revision there, a pin-adoption commit to driver.ts
 * moved HEAD → moved the epoch → `rewrite-timestamp=true` stamped different
 * layer mtimes → a different manifest digest, so the re-run failed the gate
 * again, forever. That is precisely the non-terminating bootstrap
 * `imageSourceSha`'s docblock argues it removed, re-entered through the other
 * input. Two consequences worth knowing rather than discovering:
 *   * an uncommitted edit keeps the previous commit's epoch. That is correct —
 *     the epoch tracks the revision, and two builds of the same dirty tree
 *     still agree, which is what the digest equality needs;
 *   * a shallow CI checkout still has HEAD, so this works under
 *     `actions/checkout` with the default fetch-depth — but a `QDS_GIT_SHA`
 *     naming a commit that checkout did not fetch is fatal here rather than
 *     silently falling back, for the same reason.
 *
 * No wall-clock fallback exists on purpose. If neither source can answer, the
 * build stops: silently substituting `Date.now()` would produce an image that
 * looks reproducible, passes every gate, and pushes a different digest every
 * time — the precise failure this function exists to remove.
 */
function sourceDateEpoch(rev: string): number {
  // 11 digits caps at year 5138 and refuses milliseconds, which is the actual
  // mistake people make here (a JS `Date.now()` pasted into the env reads as a
  // date in the year 58000 and every layer mtime lands there). The leading
  // digit may not be 0, which refuses the OTHER degenerate value people
  // produce: `${SOURCE_DATE_EPOCH:-0}` in a shell wrapper, or a CI expression
  // that evaluated to empty and got defaulted. `0` is well-formed and
  // reproducible and still wrong — it bakes builtAt=1970-01-01 into
  // /etc/qds-image.json, on the one field this function argues must be a
  // function of the source.
  const wellFormed = /^[1-9][0-9]{0,10}$/;
  const fromEnv = process.env.SOURCE_DATE_EPOCH?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!wellFormed.test(fromEnv)) {
      die(2, [
        `SOURCE_DATE_EPOCH=${JSON.stringify(fromEnv)} is not a plain non-zero UNIX second count`,
        "unset it to fall back to the image source revision's commit timestamp, or set it to seconds (not milliseconds, not 0)",
      ]);
    }
    return Number(fromEnv);
  }
  const fromGit = tryRun("git", ["-C", REPO_ROOT, "log", "-1", "--format=%ct", rev]);
  if (fromGit === null || !wellFormed.test(fromGit)) {
    return die(2, [
      `cannot read the commit timestamp of the image source revision ${rev} (git log -1 --format=%ct ${rev})`,
      "the epoch must track the SAME revision as the gitSha the marker bakes, or the two digest inputs move independently and the pin gate cannot converge",
      "fetch that commit (a shallow checkout may not have it) or set SOURCE_DATE_EPOCH explicitly to proceed",
    ]);
  }
  return Number(fromGit);
}

/**
 * The revision baked into `/etc/qds-image.json`'s `gitSha`, honoured from
 * `QDS_GIT_SHA` when set and read from HEAD when not.
 *
 * The env override exists for the same reason SOURCE_DATE_EPOCH's does, and it
 * is what makes the publish workflow's pin gate CONVERGE. The marker is baked
 * into a layer, so the digest is a function of this value; if it were always
 * HEAD, the bootstrapping ritual could never terminate — the gate prints a pin,
 * the operator commits it, and that very commit moves HEAD, so the re-run
 * rebuilds a different image and the gate fails again, forever. CI therefore
 * passes the last revision that touched the IMAGE SOURCE TREE (`oci/exedev/**`
 * plus this script — the same paths the workflow triggers on), which a
 * pin-adoption commit to driver.ts does not move.
 *
 * Validated as 40 hex rather than taken on trust: the value lands in a build
 * arg and then in a JSON field a box reads back as provenance, and "unknown" or
 * a branch name there is a provenance claim that is silently false.
 */
function imageSourceSha(): string {
  const fortyHex = /^[0-9a-f]{40}$/;
  // SET-BUT-EMPTY is the MALFORMED case here, not the unset one, and the
  // asymmetry with `sourceDateEpoch` is deliberate. There, an empty value falls
  // back to git, which is the intended default. Here the fallback is HEAD —
  // the one value this function exists to avoid — and an empty `QDS_GIT_SHA`
  // is exactly what a CI step whose output expression evaluated to nothing
  // exports (a path-filtered `git log` that matched no commit in a shallow
  // checkout). Falling through silently re-opens the non-terminating pin
  // bootstrap the paragraph above describes, with nothing printed.
  const fromEnv = process.env.QDS_GIT_SHA?.trim();
  if (fromEnv !== undefined) {
    if (!fortyHex.test(fromEnv)) {
      die(2, [
        `QDS_GIT_SHA=${JSON.stringify(fromEnv)} is not a 40-hex commit id`,
        ...(fromEnv === ""
          ? ["it is SET but empty — usually a CI expression that evaluated to nothing; that must not silently mean HEAD"]
          : []),
        "unset it entirely to fall back to HEAD, or pass the full sha of the image source revision",
      ]);
    }
    return fromEnv;
  }
  // Held to the SAME 40-hex rule as the env path, and fatal when it cannot be
  // met. The rejected fallback was the literal string `"unknown"`, which the
  // paragraph above names as the forbidden case and which the Dockerfile's
  // `[ -n "${QDS_GIT_SHA}" ]` guard happily accepts — so a build with no git
  // shipped `gitSha:"unknown"` as provenance a box reads back, and silently
  // moved the digest (the marker is a layer) so the pin mismatch that followed
  // named nothing. No git here is a fatal-before-the-gates condition, exactly
  // like `sourceDateEpoch`'s.
  const fromGit = tryRun("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"])?.trim();
  if (fromGit === undefined || !fortyHex.test(fromGit)) {
    return die(2, [
      "cannot read the image source revision (git rev-parse HEAD)",
      "it is baked into /etc/qds-image.json as provenance a box reads back, so it may not be guessed",
      "set QDS_GIT_SHA to the full 40-hex sha of the image source revision to proceed",
    ]);
  }
  return fromGit;
}

/**
 * Ensures {@link REPRO_BUILDER} exists and is running, and returns its name.
 *
 * Detect-then-create rather than create-and-ignore-the-error: a `create` that
 * failed for a real reason (no network to pull moby/buildkit, a broken docker
 * context) must say so here, where the message can name it, instead of turning
 * into an unexplained "no builder qds-repro" three commands later.
 *
 * Bootstrapping happens AFTER the driver check, not as part of the detection.
 * `inspect --bootstrap` on a pre-existing wrong-driver `qds-repro` STARTS it
 * (pulling `moby/buildkit` if needed) and only then is it rejected, leaving a
 * running container the operator has to clean up alongside the builder record
 * the refusal tells them to remove. So the probe is a plain `inspect`, and the
 * bootstrap — still load-bearing on a cold host, where the builder exists as a
 * stopped container and a build against it would otherwise pay the start-up
 * cost inside the step everyone reads as the build — runs only once the driver
 * is accepted.
 *
 * The accept path checks the DRIVER, not just the name. Detecting by name alone
 * reintroduces one level down the exact dependency this function exists to
 * remove: a `qds-repro` that some earlier script (or a person) created on the
 * default `docker` driver inspects clean, and the reproducibility claim then
 * rests on a builder that cannot export `type=image` at all.
 */
function ensureReproBuilder(): string {
  /** The builder if it is present AND usable; null if it is not there at all. Fatal if present on the wrong driver. */
  const acceptExisting = (): string | null => {
    const present = spawnSync("docker", ["buildx", "inspect", REPRO_BUILDER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (present.status !== 0) return null;
    // Read out of the plain report rather than through `--format`: the template
    // flag is not available on every buildx this repo runs on, and a silently
    // ignored template is how `inspectManifest` one screen down got burned.
    const driver = (present.stdout ?? "").match(/^Driver:\s*(\S+)/m)?.[1];
    if (driver !== "docker-container") {
      die(2, [
        `a builder named "${REPRO_BUILDER}" already exists on the "${driver ?? "unknown"}" driver, not docker-container`,
        "--output type=image,rewrite-timestamp=true is not available on it, and the build would fail in the exporter",
        `remove it and re-run so this script can recreate it: docker buildx rm ${REPRO_BUILDER}`,
      ]);
    }
    // Accepted — NOW pay the start-up cost, so a cold host does not pay it
    // inside the build step.
    spawnSync("docker", ["buildx", "inspect", "--bootstrap", REPRO_BUILDER], { stdio: "ignore" });
    return REPRO_BUILDER;
  };
  const existing = acceptExisting();
  if (existing !== null) return existing;
  const created = spawnSync(
    "docker",
    ["buildx", "create", "--name", REPRO_BUILDER, "--driver", "docker-container", "--bootstrap"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (created.error || created.status !== 0) {
    // A CONCURRENT run (the CI matrix this script's `--platform` flag invites)
    // can have created it between the probe above and this create, which buildx
    // reports as `existing instance` — a race, not a fault. Re-probe before
    // refusing; the driver check inside is the same one, so a wrong-driver
    // builder still dies rather than being adopted.
    const raced = acceptExisting();
    if (raced !== null) return raced;
    // "Absent" and "present but broken" fail here identically and need
    // DIFFERENT remedies: a create against an existing record fails with
    // buildx's `existing instance` no matter how many times it is retried, so
    // printing the create command — the one that just failed — sends the
    // operator in a circle. A record whose buildkit container was pruned, or
    // whose docker context is gone, is the CI-runner-cache case.
    const record = spawnSync("docker", ["buildx", "inspect", REPRO_BUILDER], { stdio: "ignore" });
    const create = `docker buildx create --name ${REPRO_BUILDER} --driver docker-container --bootstrap`;
    die(2, [
      `could not create the "${REPRO_BUILDER}" docker-container builder`,
      "it is required for --output type=image,rewrite-timestamp=true; the default docker driver cannot export it",
      ...(record.status === 0
        ? [
            `a builder record named "${REPRO_BUILDER}" exists but could not bootstrap; it must be removed before it can be recreated`,
            `remove it and re-run, or do both by hand: docker buildx rm ${REPRO_BUILDER} && ${create}`,
          ]
        : [`create it by hand and re-run: ${create}`]),
    ]);
  }
  return REPRO_BUILDER;
}

// ───────────────────────────── buildId derivation ─────────────────────────────

export interface BuildIdFile {
  /** Stable name for the file, used as the framing label. */
  name: string;
  /** Raw file bytes. A string is hashed as its UTF-8 encoding. */
  bytes: string | Buffer;
}

export interface BuildIdInputs {
  /** Every base image this Dockerfile derives from, as `sha256:…` digests. */
  baseDigests: readonly string[];
  /** The `--platform` this build targets. A different one is a different substrate. */
  platform: string;
  bunVersion: string;
  piVersion: string;
  /** Raw file bytes. A string is hashed as its UTF-8 encoding. */
  dockerfile: string | Buffer;
  /**
   * Every repo file whose bytes reach the image: the `oci/exedev/systemd/`
   * assets and everything this Dockerfile `COPY`s from the build context, keyed
   * by repo-relative path, in any order.
   */
  files: readonly BuildIdFile[];
}

/**
 * The identity a rebuild must reproduce. Baked into `/etc/qds-image.json` and
 * asserted in-box by gate B against the value the repo pin pairs with the
 * pulled digest (INV-IBOX-2) — the box cannot read the digest it booted from,
 * and the marker cannot carry it either (the digest is the hash of the manifest
 * containing the marker), so this is the only honest identity available.
 *
 * Contributions are LENGTH-FRAMED, never concatenated raw. Without framing,
 * `bun=1.3 pi=13.0` and `bun=1.31 pi=3.0` hash identically, and a Dockerfile
 * ending in the bytes that begin the first systemd unit would collide with the
 * shifted split — a collision here means two different substrates claiming the
 * same identity, which is the one thing this value exists to prevent.
 *
 * Deliberately NOT hashed: builtAt, gitSha, the image ref. All three move
 * between builds that produce the same substrate, and a buildId that changes
 * when the substrate did not is a buildId that proves nothing.
 *
 * THE THREE KNOWN GAPS ARE CLOSED (DF1.10, issue #186). They were deferred
 * together because each one changes the value this function returns, which
 * un-pins `DEFAULT_IMAGE_BUILD_ID` and costs the full re-pin ritual (rebuild →
 * ghcr push → re-pin → a paid live e2e round) — and DF1.10 performs that ritual
 * anyway to add the engine build stage. What each one was, and what closed it:
 *   1. `platform` was not a contribution, so `--platform linux/arm64` produced a
 *      completely different substrate — different ELFs, a different libc — under
 *      a byte-identical buildId. `resolveBaseDigest` does not help:
 *      `{{json .Manifest}}` on a multi-arch tag yields the INDEX digest, the
 *      same for every architecture. It is now a hashed field.
 *   2. The LABEL was not length-framed, only the value was. `${label}:${len}\n`
 *      is reconstructable more than one way when a label can carry `:` or a
 *      newline: an asset named `a:1\nX\nsystemd/b` made `{a:"X"},{b:""}` and
 *      `{"a:1\nX\nsystemd/b":""}` hash identically — EXECUTED, both yielded
 *      `10c0ed4ae242e878`. Repo-owned filenames made it theoretical, and it is
 *      closed anyway because closing it costs nothing at a re-pin that is
 *      already moving every buildId. The label now carries its own byte length.
 *   3. The input set was hand-enumerated, so a Dockerfile-`COPY`'d asset outside
 *      `oci/exedev/systemd/` changed the image without changing its identity —
 *      which DF1.10's engine binary, pi catalog and `cli-anything/` are exactly.
 *      `gatherBuildIdInputs` now derives the file set from the Dockerfile's own
 *      `COPY` instructions, so the enumeration cannot fall behind the file it
 *      describes.
 */
export function deriveBuildId(inputs: BuildIdInputs): string {
  const h = createHash("sha256");
  // Hashed as BYTES. The file inputs arrive as Buffers straight off disk, with
  // no utf8 decode in between — a lossy round-trip would map every invalid
  // byte to U+FFFD, letting two files that differ only in WHICH invalid byte
  // they carry hash to one identity. (For a string, UTF-8 is its byte
  // encoding, so the string and Buffer forms of the same valid-UTF-8 content
  // hash identically.)
  //
  // BOTH sides are length-framed (gap 2). With only the value framed, the
  // label's own delimiters were ambiguous whenever a label could contain `:` or
  // a newline; framing the label makes the encoding injective for any label at
  // all, including the repo-relative paths the file set now uses.
  const field = (label: string, value: string | Buffer): void => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const labelBytes = Buffer.from(label, "utf8");
    h.update(`${labelBytes.length}:`);
    h.update(labelBytes);
    h.update(`:${bytes.length}\n`);
    h.update(bytes);
    h.update("\n");
  };
  // Sorted so the hash is a function of the SET of inputs, not of the order the
  // filesystem or the Dockerfile happened to hand them over in.
  for (const d of [...inputs.baseDigests].sort()) field("base", d);
  // CANONICALIZED, and no more than trim+lowercase. `--platform LINUX/AMD64`
  // and `--platform linux/amd64` are one substrate via buildx but hashed as
  // two, so two operators pinning "the same" build diverge on cosmetics —
  // cost-direction only, but platform was made a first-class identity input
  // (#186 gap 1) precisely to name the substrate, and a value that moves on
  // spelling does not. Expanding shorthand (`amd64` → `linux/amd64`) is
  // DELIBERATELY not attempted: it needs the host OS and is not a pure
  // function of the input. Today's real value ("linux/amd64",
  // DEFAULT_PLATFORM) is already canonical, so the normalization is a no-op on
  // every input the current pin was derived from — pinned by a test.
  field("platform", inputs.platform.trim().toLowerCase());
  field("bun", inputs.bunVersion);
  field("pi", inputs.piVersion);
  field("dockerfile", inputs.dockerfile);
  // Code-unit order, NOT `localeCompare`: bare localeCompare collates by the
  // runtime's locale/ICU tables, which order punctuation and case differently
  // across hosts — a locale-dependent sort feeding a hash that must be
  // host-independent. Same locale-free style as the `.sort()`s above.
  for (const f of [...inputs.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    field(`file/${f.name}`, f.bytes);
  }
  // 16 hex chars = 64 bits. Long enough that an accidental collision across the
  // handful of substrates this factory will ever publish is not a thing that
  // happens, short enough to read out of a box over ssh without wrapping.
  return h.digest("hex").slice(0, 16);
}

/**
 * The base images a Dockerfile derives from, excluding references to its own
 * earlier stages (`FROM builder AS x`) and `scratch`. Every one of them is
 * resolved to a digest and folded into the buildId: a floating base tag that
 * moved under us must change the identity, or the pin proves nothing about the
 * substrate.
 *
 * The ref is tested against the stages declared BEFORE this instruction, which
 * is Docker's own resolution order and the same order `resolveRuntimeBaseRef`
 * uses. Registering this instruction's own alias first made `FROM alpine AS
 * alpine` resolve its ref against the alias it was in the middle of declaring:
 * the base was dropped from `baseRefs` entirely, its digest never entered the
 * buildId, and `gatherBuildIdInputs`' `!baseRefs.includes(runtimeBaseRef)`
 * then killed a valid Dockerfile with a message naming nothing about the cause.
 * The alias is still registered — for the instructions that follow it — which
 * is why it is added rather than skipped along with the `continue`.
 */
export function parseBaseRefs(dockerfile: string): string[] {
  const stages = new Set<string>();
  const refs: string[] = [];
  // Deduped case-INSENSITIVELY (first-seen spelling kept) because the stage
  // lookup one line up already is. `FROM Alpine` / `FROM alpine` otherwise
  // yielded two entries for one image: two registry resolutions, two digests
  // folded into the buildId, and `resolveRuntimeBaseRef` returning only one of
  // them. Docker path components must be lowercase, but the registry HOST
  // segment may be mixed case, so this is reachable through a hostname.
  const seen = new Set<string>();
  for (const { ref, stage } of fromInstructions(dockerfile)) {
    const namesAnEarlierStage = stages.has(ref.toLowerCase());
    if (stage) stages.add(stage);
    if (ref.toLowerCase() === "scratch") continue;
    if (namesAnEarlierStage) continue;
    if (seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    refs.push(ref);
  }
  return refs;
}

/**
 * Every `FROM` in order, as the reference it names and the stage it declares.
 *
 * LINE-BASED, and it refuses input that is not. A heredoc body (`RUN <<EOF`)
 * whose text begins `FROM x`, or a `\`-continued FROM, would mint a phantom
 * FROM here — folded into the buildId, or worse, silently redirecting AC5's
 * negative control at the wrong base. Today's Dockerfile has neither
 * construct; DF1.10's engine build stage is when multi-line RUNs arrive, and
 * it must trip this refusal rather than a silent misparse. Throws (its
 * exported callers are unit-tested); the build boundary converts to `die(2)`.
 *
 * BOTH HALVES of the continuation class, not just the one that starts with
 * FROM. `FROM x \` was refused; `RUN make \` whose CONTINUATION line reads
 * `FROM y` was not — and that phantom is appended LAST, so
 * `resolveRuntimeBaseRef`'s `froms.at(-1)` takes it as the runtime base and
 * AC5's negative control subtracts the wrong image. So a backslash-continued
 * line whose SUCCESSOR looks like a FROM instruction is refused too, by the
 * same shape the loop below matches: anything the parser would read as a FROM
 * inside a continuation is a misparse, never a base.
 */
function fromInstructions(dockerfile: string): { ref: string; stage: string | null }[] {
  // CRLF is stripped FIRST, before any of the three refusals below. Every one
  // of them anchors with `[ \t]*$`, and `\r` is neither space nor tab, so on a
  // CRLF checkout (`core.autocrlf=true`, a Windows contributor, a
  // `.gitattributes` change) none of them matched: the continuation guard was
  // silently disarmed and a `\`-continued FROM misparsed into the buildId.
  // `dockerfileArgDefaults` has the same anchor and the same exposure, which is
  // why its caller normalises too. The BYTES fed to `deriveBuildId` are
  // untouched — this is the decoded parsing view only.
  const lines = dockerfile.replace(/\r\n/g, "\n").split("\n");
  const continued = (line: string): boolean => /\\[ \t]*$/.test(line);
  // Over COMMENT-STRIPPED lines: `# FROM node:22 AS builder \` above a real
  // `FROM exeuntu` is neither a heredoc nor a continuation, and refusing it
  // told the operator to "teach it heredocs" about a file that has none.
  const bare = lines.map((l) => l.replace(/#.*$/, ""));
  const swallowedFrom = bare.some((line, i) => continued(line) && /^\s*FROM\s/i.test(bare[i + 1] ?? ""));
  // A heredoc OPENER (`<<EOF`, `<<-'EOF'`), not the bare digraph.
  // `includes("<<")` killed the build on `RUN echo "shift left (x << 2)"` and
  // on a `<<` inside a comment or a LABEL — a fatal refusal naming a construct
  // the file does not use. No whitespace is allowed between `<<` and the
  // delimiter, which is what separates an opener from a shift or a sentence.
  const heredoc = /<<-?['"]?[A-Za-z_]/.test(bare.join("\n"));
  if (heredoc || bare.some((l) => /^\s*from\s.*\\[ \t]*$/i.test(l)) || swallowedFrom) {
    throw new Error(
      "fromInstructions is line-based; teach it heredocs (and continued FROM lines) before using them in the Dockerfile",
    );
  }
  const out: { ref: string; stage: string | null }[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^FROM\s+(.+)$/i);
    if (!m) continue;
    // `--platform=…` and any future FROM flag are dropped; the first remaining
    // token is the reference, and an `AS <name>` suffix declares a stage.
    const tokens = m[1]!.split(/\s+/).filter((t) => !t.startsWith("--"));
    const ref = tokens[0];
    if (!ref) continue;
    const asIdx = tokens.findIndex((t) => /^AS$/i.test(t));
    const stage = asIdx > 0 ? (tokens[asIdx + 1]?.toLowerCase() ?? null) : null;
    out.push({ ref, stage });
  }
  return out;
}

/**
 * The image the FINAL stage actually derives from — the negative control AC5's
 * added-binary diff subtracts — or null when it cannot be determined.
 *
 * NOT "the last entry in {@link parseBaseRefs}". That heuristic is right only
 * for the single-`FROM` shape this Dockerfile has TODAY, and wrong for two
 * shapes the parser above already supports and DF1.10 is about to introduce
 * when it adds an engine build stage to this same file:
 *
 *   * `FROM exeuntu AS runtime` … `FROM node AS builder` … `FROM runtime` —
 *     the final stage derives from an EARLIER STAGE, contributing no ref of its
 *     own, so "the last ref" is the builder. The diff would then subtract
 *     node's executables from an exeuntu image: every binary the real base
 *     ships reads as added, and the build stops on hundreds of unattributed
 *     paths (or, with the fatter image on the wrong side, real added binaries
 *     are subtracted away and ship unattributed);
 *   * `FROM exeuntu AS build` … `FROM exeuntu` — the dedup in `parseBaseRefs`
 *     collapses the repeat, and "last" is no longer last.
 *
 * So stage aliases are CHASED to the image they bottom out at — IN DECLARATION
 * ORDER, which is Docker's own rule: a `FROM x` resolves `x` against the stages
 * declared BEFORE it, and against nothing declared after. A whole-file alias
 * map read that rule backwards. `FROM alpine AS s` / `FROM s AS alpine` /
 * `FROM alpine` is a valid three-stage Dockerfile whose real base is the image
 * `alpine`, and the map made it a two-node cycle → null → `die(2)`; the same
 * map is what forced the special case for the self-hop `FROM alpine AS alpine`,
 * which order-bounded lookup handles with no special case at all (the alias is
 * not yet declared when its own FROM is resolved, so the reference is the
 * image). Termination is structural rather than a `seen` set: every hop lands
 * on a strictly EARLIER instruction, so a cycle cannot be constructed.
 *
 * A `scratch` final stage or no `FROM` at all returns null, and the caller makes
 * that fatal: a wrong negative control is worse than no build, because it fails
 * in the direction that greens an unattributed binary.
 */
export function resolveRuntimeBaseRef(dockerfile: string): string | null {
  const froms = fromInstructions(dockerfile);
  const last = froms.at(-1);
  if (last === undefined) return null;
  /** The stage `ref` names, searching only instructions declared before `before`. */
  const stageAt = (ref: string, before: number): number => {
    for (let i = before - 1; i >= 0; i--) if (froms[i]!.stage === ref.toLowerCase()) return i;
    return -1;
  };
  let ref = last.ref;
  let at = froms.length - 1;
  for (let hop = stageAt(ref, at); hop !== -1; hop = stageAt(ref, at)) {
    ref = froms[hop]!.ref;
    at = hop;
  }
  return ref.toLowerCase() === "scratch" ? null : ref;
}

/** What the registry said about a reference, and — when it said nothing — why. */
interface ManifestLookup {
  /** The MANIFEST digest, or null when the registry produced no usable one. */
  digest: string | null;
  /**
   * True ONLY when the registry answered and its answer was "this reference
   * does not exist". False for every other empty result, including the one
   * that matters: "the registry could not be reached at all".
   */
  absent: boolean;
  /** The last line of imagetools' stderr, so a refusal can name the cause. */
  detail: string;
}

/**
 * Whether an `imagetools inspect` stderr says the registry DENIED us, answered
 * "absent", or said nothing usable — a pure function of the stderr text, split
 * out of {@link inspectManifest} so the vocabulary itself is unit-testable.
 *
 * The registry's OWN VOCABULARY for "no such reference", and nothing looser.
 * Anything else — a timeout, a 401, a rate limit, a proxy error, docker not
 * running — is SILENCE, and silence must not read as a negative answer.
 *
 * The bare `not found` and `does not exist` alternatives were exactly that
 * looseness and are gone: registries mask 403 as 404 BY DESIGN, so Docker
 * Hub's canonical refusal for a private base — `pull access denied for X,
 * repository does not exist or may require 'docker login'` — matched both,
 * and an AUTH failure licensed `resolveBaseDigest` to substitute whatever the
 * daemon last pulled under a floating tag. Two different substrates, one
 * buildId: the precise outcome the `absent` flag was introduced to prevent.
 * The denial vocabulary is checked FIRST and vetoes, because a single message
 * can carry both spellings.
 */
export function classifyRegistryRefusal(stderr: string): { denied: boolean; absent: boolean } {
  const denied = /denied|unauthorized|forbidden|authentication required|docker login|rate limit|toomanyrequests/i.test(stderr);
  const absent = !denied && /manifest unknown|MANIFEST_UNKNOWN|no such manifest|NAME_UNKNOWN|repository name not known/i.test(stderr);
  return { denied, absent };
}

/**
 * The MANIFEST digest a registry reference resolves to, WITH the reason when
 * there is none.
 *
 * `--format '{{.Manifest.Digest}}'` looks right and is a trap: on Docker
 * 28.4.0 imagetools SILENTLY IGNORES that template and prints its default
 * multi-line human report instead, so a caller that trusted it would take a
 * plausible-looking blob for a digest. `{{json .Manifest}}` is honoured, and
 * the result is validated against the `sha256:` shape either way — this value
 * becomes half of the repo pin, so a wrong one is worse than none.
 *
 * The `absent` flag exists because collapsing every failure into one null is
 * how a 401, a 429 or a DNS blip became "the registry has no such image", and
 * `resolveBaseDigest` then substituted whatever the local daemon last pulled
 * under a floating tag while buildx resolved the CURRENT one over the network.
 * Two different substrates, one buildId. A registry that answers "unknown
 * manifest" is a different fact from a registry that does not answer, and only
 * the first one leaves a local copy as a defensible source.
 */
function inspectManifest(ref: string): ManifestLookup {
  const res = spawnSync("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A registry that accepts the TCP connection and never replies blocks a
    // `spawnSync` forever, and nothing in this file can interrupt one. Five
    // minutes is far past any real manifest read; past it the lookup answers
    // "no digest, and here is why", which every caller already fails closed on.
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
  });
  const stderr = res.stderr ?? (res.error ? res.error.message : "");
  const detail = stderr.split("\n").filter((l) => l.trim() !== "").at(-1)?.trim() ?? "";
  if (!res.error && res.status === 0) {
    try {
      const digest = (JSON.parse(res.stdout ?? "") as { digest?: unknown }).digest; /* dp:ok inside try/catch, and the value is shape-validated before return */
      if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) return { digest, absent: false, detail };
    } catch {
      // Falls through to the "answered, but with nothing usable" result below.
    }
    return { digest: null, absent: false, detail: detail || "imagetools answered with no usable .Manifest.digest" };
  }
  // DENIAL VETOES ABSENT — see {@link classifyRegistryRefusal}, which owns the
  // vocabulary and why it is checked in that order.
  const { absent } = classifyRegistryRefusal(stderr);
  return {
    digest: null,
    absent,
    detail: detail || `docker buildx imagetools inspect exited ${res.status ?? "on a signal"}`,
  };
}

/** The repository half of a docker reference: no tag, no digest. */
export function refRepository(ref: string): string {
  const noDigest = ref.replace(/@sha256:[0-9a-f]{64}$/, "");
  const lastColon = noDigest.lastIndexOf(":");
  // A `:` before the last `/` is a registry PORT, not a tag separator.
  return lastColon > noDigest.lastIndexOf("/") ? noDigest.slice(0, lastColon) : noDigest;
}

/**
 * The `RepoDigests` entry that belongs to `ref`'s own repository, or null.
 *
 * `{{index .RepoDigests 0}}` took whichever entry happened to be first. A
 * mirrored or retagged base carries several (`ghcr.io/x/y@sha256:…` and
 * `mirror.internal/x/y@sha256:…` are different manifests of the same config),
 * so position decided which digest was folded into the buildId — and the
 * `${ref}@${digest}` pair that came out is one the registry named by `ref` does
 * not resolve. AC5's negative control then `docker run`s that pair.
 */
export function repoDigestFor(ref: string, repoDigests: readonly unknown[]): string | null {
  // Docker Hub is spelled four ways for one repository. `FROM
  // docker.io/library/ubuntu:24.04` yields `want = docker.io/library/ubuntu`
  // while dockerd records the RepoDigest as `ubuntu@sha256:…`, so a strict
  // string compare missed an entry sitting right there and the caller died
  // claiming no local entry belongs to the repository. Fails closed either way;
  // the message was the thing that misdirected.
  const canon = (r: string): string => r.replace(/^(?:index\.)?docker\.io\/(?:library\/)?/, "").replace(/^library\//, "");
  const want = canon(refRepository(ref));
  for (const entry of repoDigests) {
    if (typeof entry !== "string") continue;
    const m = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(entry);
    if (m && canon(m[1]!) === want) return m[2]!;
  }
  return null;
}

/** `sha256:…` for a reference, from the ref itself or from the registry. */
function resolveBaseDigest(ref: string): string {
  // FIRST, before the digest match. `FROM ${BASE}@sha256:<64hex>` satisfies the
  // pinned arm below and used to return from it, so a `$`-bearing string got
  // past this refusal and reached docker argv further down, where it failed
  // opaquely. A templated FROM is refused whatever else it looks like.
  if (ref.includes("$")) {
    die(2, [
      `the base reference "${ref}" is not literal; the buildId cannot pin a templated FROM`,
      "pin the base by digest (FROM <ref>@sha256:…) in oci/exedev/Dockerfile",
    ]);
  }
  const pinned = ref.match(/@(sha256:[0-9a-f]{64})$/);
  if (pinned) return pinned[1]!;
  const viaRegistry = inspectManifest(ref);
  if (viaRegistry.digest !== null) return viaRegistry.digest;
  // FAIL-SAFE, and the reason the lookup carries `absent`. An UNREACHABLE
  // registry is fatal here rather than silently answered from the daemon's
  // memory: buildx resolves this floating tag over the network at build time,
  // so a local substitution records a digest for bytes the build will not use.
  // Only a registry that ANSWERED "no such reference" leaves the local copy as
  // the honest last source — a digest-pinned base never reaches this code at
  // all (it returned above), so nothing offline is lost by refusing here.
  if (!viaRegistry.absent) {
    return die(2, [
      `cannot reach the registry to resolve ${ref}: ${viaRegistry.detail}`,
      "the daemon's local record for a floating tag is whatever it last pulled, which need not be what buildx resolves over the network",
      "recording that instead would fold a false provenance claim into the buildId, so this refuses rather than guesses",
      "restore registry access (auth, network, rate limit) and re-run, or pin the base by digest (FROM <ref>@sha256:…) so no registry read is needed",
    ]);
  }
  const local = tryRun("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref]);
  let fromLocal: string | null = null;
  try {
    const parsed = local === null ? null : JSON.parse(local); /* dp:ok inside try/catch; a non-array parse falls to the die below */
    if (Array.isArray(parsed)) fromLocal = repoDigestFor(ref, parsed);
  } catch {
    // Unparseable local metadata is no metadata; the refusal below is right.
  }
  if (fromLocal !== null) return fromLocal;
  return die(2, [
    `cannot resolve ${ref} to a digest — the buildId would not be reproducible`,
    `the registry says it does not exist (${viaRegistry.detail}) and no local RepoDigests entry belongs to ${refRepository(ref)}`,
    "pull the base (or log in to its registry) and re-run, or pin it by digest in the Dockerfile",
  ]);
}

/**
 * Why {@link readBunPin} refused, carrying the lines its caller `die(2, …)`s.
 *
 * It THROWS rather than calling `die` itself, and that is the whole point: `die`
 * is `process.exit`, so a test that tripped a rejection path would take the
 * runner down with it instead of failing — which is why every rejection here
 * went untested. The caller is the one place that knows this is a
 * fatal-before-the-gates condition, and it is the one place that exits.
 */
export class BunPinError extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join(" · "));
    this.name = "BunPinError";
  }
}

/**
 * Why the buildId's FILE INPUTS could not be read, carrying the lines its
 * caller `die(2, …)`s — {@link BunPinError}'s doctrine, applied to the second
 * exported test surface.
 *
 * `buildIdFileInputs` and everything it reaches (`copyContextSources`,
 * `contextFilesUnder`, `readInput`) used to `die(2)` directly, so a test that
 * tripped a fail-closed branch — a fixture COPYing a path the checkout lacks,
 * a symlink under a COPY source — killed the whole `bun test` run with exit 2
 * and no failing test named, which is exactly why those branches went
 * untested. The exported path throws; `gatherBuildIdInputs` is the build
 * boundary — the one place that knows this is fatal-before-the-gates — and it
 * is the one place that exits, with the same lines and the same exit code, so
 * CLI output is byte-identical to what these paths printed before.
 */
export class BuildIdInputsError extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join(" · "));
    this.name = "BuildIdInputsError";
  }
}

/** The repo's own bun pin (AC2): the runtime the tests ran on, not an install measurement. */
export function readBunPin(pkgJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkgJson); /* dp:ok inside try/catch; the catch below is the handler */
  } catch {
    throw new BunPinError(["package.json is not parseable; cannot read the bun pin"]);
  }
  const pm = (parsed as { packageManager?: unknown }).packageManager;
  // Corepack's canonical spelling carries an integrity suffix
  // (`bun@1.3.13+sha512.<hex>`), and the captured value goes straight into the
  // Dockerfile's release URL — `bun-v1.3.13+sha512.…/bun-linux-x64.zip` is a
  // 404, and the in-image `bun --version` equality check one screen further on
  // would never be reached. So the version is captured WITHOUT `+` in its
  // character class and the suffix is matched-and-discarded rather than
  // tolerated by accident.
  //
  // THREE dotted components are REQUIRED, with an optional prerelease tail.
  // "starts with a digit" (`\d[\w.-]*`) accepted `bun@1`, `bun@1.3`,
  // `bun@1.3.13-` and `bun@1_3_13` — every one of which is the same 404 ten
  // QEMU-emulated minutes in that the leading-digit anchor was added to
  // prevent. The repo's own package.json is separately asserted against
  // `/^\d+\.\d+\.\d+/` in tests/scripts/exedev-bun-pin.test.ts, but that
  // guards today's VALUE; this guards the function's CONTRACT.
  const m = typeof pm === "string" ? pm.match(/^bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\+[A-Za-z0-9._-]+)?$/) : null;
  if (!m) {
    throw new BunPinError([
      `package.json "packageManager" must pin bun at a full x.y.z version (saw ${JSON.stringify(pm)})`,
      "the value is interpolated into the bun release URL, so a partial version is a 404 ten QEMU-emulated minutes into the build",
      "AC2: the in-box engine runs the runtime the tests ran on, so the pin has one source",
    ]);
  }
  return m[1]!;
}

/**
 * The DISTINCT defaults a Dockerfile declares for one `ARG`, in first-seen
 * order, for the two args this script also owns as constants. Read so a
 * DIVERGENCE can be made fatal here rather than shipping.
 *
 * The script always passes `--build-arg`, so the Dockerfile defaults are dead
 * code that nothing exercises — but the Dockerfile's BYTES are a buildId input,
 * so editing one moves the buildId and the digest while the image installed is
 * unchanged: an identity that moved without the substrate moving, which is the
 * one thing `deriveBuildId` exists to prevent. The `BUN_SHA256` pairing has the
 * same shape and worse timing — a `packageManager` bump nobody paired with a
 * re-measured checksum fails inside `sha256sum -c` ten QEMU-emulated minutes
 * in, with a bare checksum mismatch that names neither cause.
 *
 * EVERY declaration, not the first. A Dockerfile `ARG` must be RE-DECLARED in
 * every stage that consumes it, and DF1.10 adds a build stage to this very
 * file — so a single-match read would have compared the script's constant
 * against whichever declaration came first and let a stale default in the
 * RUNTIME stage pass silently, which is exactly the ten-minute checksum
 * mismatch above. Disagreement is the caller's `die`; the caller is the only
 * place that knows this is fatal-before-the-gates.
 *
 * A trailing comment is tolerated (`ARG PI_VERSION=0.84.4  # measured`), which
 * an end-anchored value pattern reported as "declares no ARG" — a refusal that
 * named the wrong problem. A default containing whitespace still reads as
 * absent: `(\S+)` by construction, and `ARG X=a b` is not a value this pairing
 * can compare.
 *
 * A symmetric pair of surrounding quotes is STRIPPED, because docker strips it
 * too. `ARG PI_VERSION="0.84.4"` is a valid Dockerfile installing 0.84.4, and
 * capturing the quotes made the caller die with `PI_VERSION disagrees: this
 * script passes 0.84.4, oci/exedev/Dockerfile defaults to "0.84.4"` — two
 * spellings of one substrate, told to be reconciled.
 *
 * CRLF is normalised by the caller before this sees the text: `[ \t]*$` does
 * not match a trailing `\r`, so on a CRLF checkout every declaration read as
 * absent and the build died with "declares no ARG …" about a correct file.
 */
export function dockerfileArgDefaults(dockerfile: string, name: string): string[] {
  const found = new Set<string>();
  for (const m of dockerfile.replace(/\r\n/g, "\n").matchAll(new RegExp(`^[ \\t]*ARG[ \\t]+${name}=(\\S+)[ \\t]*(?:#.*)?$`, "gm"))) {
    const raw = m[1]!;
    const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0];
    found.add(quoted ? raw.slice(1, -1) : raw);
  }
  return [...found];
}

/**
 * Every read here is guarded and every failure is `die(2)`. The exit-code
 * contract reserves 1 for a COMPLIANCE failure and 2 for "fatal before the
 * gates could conclude (…missing input)"; an unguarded `readFileSync` throws,
 * bun exits 1, and a missing package.json is reported as a licence failure.
 *
 * Returns BYTES, no encoding: these are buildId inputs, and a utf8 round-trip
 * maps every invalid byte to U+FFFD — two on-disk files differing only in
 * which invalid byte they carry would then hash to one identity. Callers that
 * need text decode their own view.
 */
/**
 * Every path this Dockerfile `COPY`s (or `ADD`s) FROM THE BUILD CONTEXT,
 * repo-relative, deduped and sorted.
 *
 * This is what closes KNOWN GAP 3 on {@link deriveBuildId}: the file set is
 * read out of the Dockerfile instead of being listed by hand next to it, so an
 * asset added by a later story becomes a buildId input the moment it is
 * copied, with nobody having to remember a second edit.
 *
 * `--from=` copies are EXCLUDED and that is not an omission: they take bytes
 * from an earlier stage (already covered — the stage's own COPY sources are in
 * this list) or from an external image (not in the context at all, and pinned
 * by `parseBaseRefs`' KNOWN GAP, which stays a tripwire test until such a COPY
 * exists).
 *
 * Refuses rather than guesses on the shapes it cannot resolve statically: a
 * COPY line continuation (the sources may be on a line this scan never sees),
 * a glob (whose expansion depends on the context, not on this file), a
 * `..`-bearing source (which walks out of the repository), a bare `.` source
 * (which would walk `.git` into an identity docker excludes from the context),
 * a URL source (bytes docker fetches, which no context file ever held), a
 * bind-mount RUN (`--mount=type=bind,source=…` feeds context bytes to a step
 * no COPY names) and the `# escape=` directive (which changes the continuation
 * character this scan assumes is `\`). Every refusal throws
 * {@link BuildIdInputsError}, never `die` — this
 * is the exported test surface, and `gatherBuildIdInputs` is the boundary
 * that exits.
 *
 * CONTINUATION CONTEXT, both directions. The old scan checked `endsWith("\\")`
 * on a COPY-looking line only, so two BuildKit-legal shapes silently
 * disagreed with the builder: a `RUN set -e; \` whose CONTINUATION line reads
 * `COPY src/x /dst` is shell text docker never treats as an instruction, but
 * the scan hashed `src/x` from it; and a comment line ending in `\` joins its
 * successor into the comment under BuildKit, so the COPY the scan read there
 * does not execute at all. A line that continues a previous instruction is now
 * skipped (that is docker's own reading of it), and a comment that ends in a
 * continuation is refused outright — whether the builder swallows the next
 * line into the comment is a parser detail this scan cannot second-guess, and
 * over-hashing or false-refusing a Dockerfile that builds is exactly the
 * "silently disagrees with the builder" failure its doctrine forbids.
 *
 * Two more continuation shapes round that out. A backslash followed by
 * TRAILING WHITESPACE is not a continuation to BuildKit's lexer but reads as
 * one after `trimEnd()` — the line after it would be hashed-or-skipped as
 * shell text while the builder starts a fresh instruction there — so the
 * shape is refused rather than guessed at. And a comment line INSIDE a
 * continued instruction does not sever it: docker skips the comment and the
 * instruction keeps consuming lines, so the continuation carries through
 * instead of resetting from the blanked line (which would read the lines
 * after the comment as fresh instructions and hash a COPY the builder ran as
 * shell text).
 */
export function copyContextSources(dockerfile: string): string[] {
  const normalised = dockerfile.replace(/\r\n/g, "\n");
  // The `# escape=` parser directive changes the continuation character, which
  // disarms every `endsWith("\\")` assumption below — a COPY continued with
  // the directive's character would read as one line and the scan would
  // silently miss its sources. `parseBaseRefs`' `fromInstructions` hardcodes
  // `\` the same way, so both parsers refuse the directive until taught.
  if (/^#[ \t]*escape[ \t]*=/im.test(normalised)) {
    throw new BuildIdInputsError([
      "oci/exedev/Dockerfile declares a `# escape=` parser directive; this scan assumes `\\` continuations and would misread every continued instruction under another escape character",
    ]);
  }
  // A heredoc body can carry column-0 `COPY …` text that is shell input, not
  // an instruction — `fromInstructions` refuses the same shape for FROMs.
  const bare = normalised
    .split("\n")
    .map((l) => (/^[ \t]*#/.test(l) ? "" : l))
    .join("\n");
  if (/<<-?['"]?[A-Za-z_]/.test(bare)) {
    throw new BuildIdInputsError([
      "oci/exedev/Dockerfile opens a heredoc; its body can carry column-0 COPY text that is not an instruction, and this line-based scan cannot tell the two apart",
    ]);
  }
  const out = new Set<string>();
  // True while the lines being read are CONTINUATIONS of the instruction above
  // them. Their content is arguments to that instruction — a COPY-shaped token
  // there is text, not a COPY.
  let continuing = false;
  for (const raw of normalised.split("\n")) {
    // A `#` introduces a comment only at the START of a line (after leading
    // whitespace) — that is docker's rule, and `raw.replace(/#.*$/, "")` was
    // not it: `COPY src/a#b /out/` lost everything from the `#` onwards and
    // this scan then hashed `src/a`, a path that does not exist, or worse one
    // that does. Docker would COPY the whole `src/a#b`. Matching docker's rule
    // means a trailing `# note` on an instruction line is NOT stripped either,
    // which is also correct: docker treats those tokens as arguments, so the
    // refusals below fire on them instead of this scan quietly agreeing with
    // an interpretation the builder does not share.
    const isComment = /^[ \t]*#/.test(raw);
    const line = isComment ? "" : raw.trimEnd();
    // `RUN --mount=type=bind,source=<context path>` reads context bytes inside
    // a step without a COPY — the one route around this scan's file set, and a
    // reopened KNOWN GAP 3 rather than a narrowing of it. Refused by name until
    // the scan learns the mount grammar (same doctrine as globs/heredocs/URLs).
    // Checked BEFORE the continuation skip: a mount flag on a continued line
    // binds the same bytes as one on the instruction's first line.
    if (line.includes("--mount=type=bind")) {
      throw new BuildIdInputsError([
        `oci/exedev/Dockerfile mounts a context path into a RUN (${JSON.stringify(line.slice(0, 80))}); a bind-mount source reads context bytes this scan never hashes, and it refuses what it cannot hash`,
      ]);
    }
    // A backslash followed by trailing whitespace: `\ ` does not continue a
    // line in BuildKit's lexer, but this scan's `trimEnd()` makes it read as
    // one — every line after it would be skipped as shell text while the
    // builder starts fresh instructions there (a COPY there hashed-or-skipped
    // on a guess). Refused, like every continuation shape this scan cannot
    // read the builder's way.
    if (!isComment && /\\[ \t]+$/.test(raw)) {
      throw new BuildIdInputsError([
        `oci/exedev/Dockerfile ends a line in a continuation backslash followed by trailing whitespace (${JSON.stringify(raw.slice(0, 80))}); BuildKit does not treat "\\"+whitespace as a continuation, so whether the next line is an instruction is not this scan's to guess`,
      ]);
    }
    if (isComment) {
      // A comment ending in a continuation: whether the builder joins the next
      // line into the comment (making a COPY there dead text) or not is not
      // knowable from this file, so the file shape is refused rather than
      // guessed at. Refused mid-instruction too — a comment inside a
      // continuation is the same not-knowable join, not a knowable one.
      if (raw.trimEnd().endsWith("\\")) {
        throw new BuildIdInputsError([
          `oci/exedev/Dockerfile has a comment line that ends in a continuation (${JSON.stringify(raw.trimEnd().slice(0, 80))}); BuildKit may join the next line into the comment, and this scan cannot know which lines that removes`,
        ]);
      }
      // A comment line does not sever a continuation: docker skips it and the
      // instruction above keeps consuming lines. Continuing WITHOUT touching
      // `continuing` is the whole fix — resetting it from the blanked line
      // would read the lines after the comment as fresh instructions.
      continue;
    }
    if (continuing) {
      continuing = line.endsWith("\\");
      continue;
    }
    if (!/^[ \t]*(?:COPY|ADD)[ \t]/i.test(line)) {
      continuing = line.endsWith("\\");
      continue;
    }
    // JSON form — `COPY ["src", "dst"]`. The whitespace split below yields
    // `["src",` as a token and would hash a path with brackets and quotes in
    // it. Refused by name, the way continuations and globs are: this scan
    // decides an IDENTITY, and a shape it cannot read is not a shape it may
    // guess at.
    if (/^[ \t]*(?:COPY|ADD)[ \t]+\[/i.test(line)) {
      throw new BuildIdInputsError([
        `oci/exedev/Dockerfile uses JSON-form COPY (${JSON.stringify(line.trim().slice(0, 80))}); the buildId's file scan reads whitespace-separated sources and would hash the bracketed tokens verbatim`,
      ]);
    }
    if (line.endsWith("\\")) {
      throw new BuildIdInputsError([
        `oci/exedev/Dockerfile continues a COPY across lines (${JSON.stringify(line.slice(0, 80))}); the buildId's file scan reads one line per instruction and would miss the sources on the next`,
      ]);
    }
    const tokens = line.trim().split(/[ \t]+/).slice(1);
    if (tokens.some((t) => /^--from=/i.test(t))) continue;
    // Last token is the destination; flags are not sources.
    for (const t of tokens.slice(0, -1)) {
      if (t.startsWith("--")) continue;
      if (/[*?[\]]/.test(t)) {
        throw new BuildIdInputsError([
          `oci/exedev/Dockerfile COPYs a glob (${t}); the buildId hashes named context paths, and a glob's expansion is not knowable from this file`,
        ]);
      }
      // `COPY ../x` names a path OUTSIDE the build context: docker refuses it
      // ("forbidden path outside the build context"), and a scan that walked it
      // would hash arbitrary parent-directory bytes under an identity that
      // claims to be repo-relative — the same "cannot pin honestly" class as
      // the templated FROM `parseBaseRefs` refuses.
      if (t.split("/").includes("..")) {
        throw new BuildIdInputsError([
          `oci/exedev/Dockerfile COPYs "${t}", which leaves the build context via ..; the buildId hashes repo-relative files and cannot honestly hash a parent-directory path`,
        ]);
      }
      // A bare `.`/`./` source walks the WHOLE repo, and the walk mirrors only
      // `node_modules` and the credential patterns of the `.dockerignore`
      // exclusions — `.git` would be hashed, making the buildId a function of
      // the clone's packfile layout: two checkouts of one commit that hash
      // differently while docker excludes `.git` from the context entirely.
      // `contextFilesUnder` refuses to guess an exclusion set, so the shape is
      // refused here, where the path came straight from the Dockerfile.
      if ([".", ""].includes(t.replace(/^\.\//, "").replace(/\/+$/, ""))) {
        throw new BuildIdInputsError([
          `oci/exedev/Dockerfile COPYs "${t}", the whole build context; the file walk mirrors only node_modules and the credential patterns of .dockerignore, so a bare . hashes .git and makes the buildId a function of the clone's packfile layout, not of the tree`,
        ]);
      }
      // `ADD https://…` is legal Dockerfile and fetches bytes at build time;
      // hashing the token as a context path dies with a missing-file message
      // that names the wrong problem. Network-fetched bytes have no context
      // file to hash, so the shape is refused by name (D1-24 records the
      // checksum-side gap for the two fetches the real Dockerfile does inside
      // RUN).
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t)) {
        throw new BuildIdInputsError([
          `oci/exedev/Dockerfile ADDs a URL (${t}); the buildId hashes context files, and bytes docker fetches over the network are in no context file`,
        ]);
      }
      out.add(t.replace(/^\.\//, "").replace(/\/+$/, ""));
    }
  }
  return [...out].sort();
}

/**
 * Repo-relative files under a context source, sorted. A file is itself; a
 * directory is walked.
 *
 * `node_modules` is skipped to MIRROR `.dockerignore`'s `**\/node_modules`,
 * and the four recursive credential patterns at its bottom (`**\/.env`,
 * `**\/.env.*`, `**\/*.pem`, `**\/*.key`) are mirrored by the same name match:
 * untracked debris matching them never reaches the image (docker excludes it
 * from the context at every depth), so hashing it anyway made the buildId a
 * function of the CHECKOUT — one stray `.env` re-pinned a byte-identical
 * image. Which is why `.dockerignore` is itself hashed as an input below: the
 * two exclusion sets have to move together, and hashing the file that decides
 * them is how a divergence becomes visible instead of silent. Nothing else is
 * filtered — over-hashing moves a buildId for bytes that did not ship, which
 * costs a re-pin; under-hashing ships bytes under an unchanged identity, which
 * is the failure this whole function exists to prevent.
 */
function contextFilesUnder(rel: string): string[] {
  const abs = path.join(REPO_ROOT, rel);
  let st: fs.Stats;
  try {
    // LSTAT, not stat: a top-level COPY source that is a SYMLINK is followed by
    // `statSync`, and the walk would then read through the link and hash bytes
    // from OUTSIDE the repository under an identity that claims to be
    // repo-relative — the same hazard the interior refusal below documents,
    // unfail-closed at the one boundary where the path came straight from the
    // Dockerfile. Docker resolves the link at build time; this hash cannot.
    st = fs.lstatSync(abs);
  } catch (err) {
    throw new BuildIdInputsError([
      `oci/exedev/Dockerfile COPYs ${rel}, which this checkout does not have: ${err instanceof Error ? err.message : String(err)}`,
      "every COPY source is a buildId input; a missing one is a build that would fail ten QEMU minutes later",
    ]);
  }
  if (st.isFile()) return [rel];
  if (st.isSymbolicLink()) {
    throw new BuildIdInputsError([
      `oci/exedev/Dockerfile COPYs ${rel}, which is a symlink`,
      "docker resolves it at build time; this hash cannot, so it refuses rather than following the link and hashing bytes from outside the repository",
    ]);
  }
  if (!st.isDirectory()) {
    throw new BuildIdInputsError([`oci/exedev/Dockerfile COPYs ${rel}, which is neither a file nor a directory`]);
  }
  const out: string[] = [];
  const walk = (dirRel: string): void => {
    const entries = fs
      .readdirSync(path.join(REPO_ROOT, dirRel), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = `${dirRel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(childRel);
      } else if (e.isFile()) {
        // `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key` and — since the #217
        // bundle prefixed them `**/` — `**/*.log` and `**/.DS_Store` (see the
        // docblock): docker excludes these from the context at every depth, so
        // the walk mirrors them or dirty-checkout debris moves the buildId for
        // byte-identical image bytes.
        if (
          e.name === ".env" ||
          e.name.startsWith(".env.") ||
          e.name.endsWith(".pem") ||
          e.name.endsWith(".key") ||
          e.name.endsWith(".log") ||
          e.name === ".DS_Store"
        ) {
          continue;
        }
        out.push(childRel);
      } else {
        throw new BuildIdInputsError([
          `${childRel} is under a COPY source but is neither a file nor a directory (symlink, socket, device)`,
          "docker resolves it at build time; this hash cannot, so it refuses rather than recording an identity that ignores it",
        ]);
      }
    }
  };
  walk(rel);
  return out;
}

function readInput(file: string, why: readonly string[]): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new BuildIdInputsError([
      `cannot read ${path.relative(REPO_ROOT, file)}: ${err instanceof Error ? err.message : String(err)}`,
      ...why,
    ]);
  }
}

/**
 * `mkdtempSync` with the exit-code contract enforced: an EACCES/ENOSPC here is
 * "fatal before the gates could conclude" (exit 2), not the uncaught-throw
 * exit 1 the contract reserves for a compliance failure.
 */
function makeTempDir(prefix: string): string {
  try {
    return fs.mkdtempSync(prefix);
  } catch (err) {
    return die(2, [
      `cannot create a temp directory at ${prefix}…: ${err instanceof Error ? err.message : String(err)}`,
      "a path/disk fault before the gates conclude is fatal (2), not a compliance failure (1)",
    ]);
  }
}

/** The image's two `sha256sum -c` gates, by ARG name. */
export const CHECKSUM_ARGS = ["BUN_SHA256", "PI_AI_SHA256"] as const;

/**
 * Everything wrong with the two CONTENT GATES, as `die(2)` lines. Empty ⇒ fine.
 *
 * This is the caller side of the exposure oci/exedev/Dockerfile names next to
 * `ARG BUN_SHA256`: "Closing it belongs on the caller side: that script should
 * refuse a BUN_SHA256 override that is not this file's default."
 *
 * Both checksums are `ARG`s, so `docker build --build-arg
 * BUN_SHA256=<hash-of-anything>` makes the image's only two content checks
 * verify an attacker-chosen artifact and pass — and {@link deriveBuildId}
 * hashes the Dockerfile BYTES (the DEFAULTS) plus platform/bunVersion/piVersion
 * and never the EFFECTIVE arg values, so the substituted image carries a
 * byte-identical buildId and gate B's in-box assertion still passes. The
 * Dockerfile self-declares this for `BUN_SHA256` and says nothing at all about
 * `PI_AI_SHA256`, which the same change introduced. {@link buildArgList} passes
 * neither, which is what keeps THIS script's own path safe; the two checks
 * below are about the ways that safety is lost anyway.
 *
 * 1. A DECLARATION THAT DISAGREES WITH ITSELF. `BUN_SHA256` is declared in two
 *    stages (the engine builder compiles with the same pinned bun the runtime
 *    ships). Two different values means one stage's `sha256sum -c` is checking
 *    a hash nobody reviewed — or, worse, that the bun which COMPILED the engine
 *    is not the bun the marker reports. The same lockstep reasoning
 *    `gatherBuildIdInputs` applies to BUN_VERSION/PI_VERSION, applied to the
 *    checksums those versions are actually pinned by.
 * 2. AN ENVIRONMENT OVERRIDE. `BUN_SHA256=… bun run build:image` does nothing
 *    today — this script composes its own `--build-arg` list — and "does
 *    nothing" is the wrong failure mode: an operator who set it believes the
 *    build honoured it, and the image they publish is not the image they think
 *    they asked for. Refused loudly instead — and a set-but-EMPTY value is
 *    refused for the same reason: an empty override is not a way to unset the
 *    gate, and passing silently as if unset is the same wrong failure mode.
 *
 * What it does NOT close, stated so nobody reads more into it: a caller
 * invoking `docker build` directly, bypassing this script entirely. That is
 * the image's remaining exposure and closing it needs the checksum out of the
 * `ARG` surface, which moves the Dockerfile bytes and the pin with them.
 *
 * `env` is a parameter rather than a read of `process.env` so the refusal is
 * testable without a docker daemon: `main` reaches this only after a buildx
 * preflight, and the policy is the part worth asserting.
 */
export function checksumArgProblems(dockerfile: string, env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const name of CHECKSUM_ARGS) {
    const declared = dockerfileArgDefaults(dockerfile, name);
    if (declared.length === 0) {
      problems.push(
        `oci/exedev/Dockerfile declares no "ARG ${name}=<default>"`,
        "it is one of the image's two content gates; without an in-repo default the `sha256sum -c` verifies whatever the caller supplies",
      );
      continue;
    }
    if (declared.length > 1) {
      problems.push(
        `oci/exedev/Dockerfile declares "ARG ${name}" with ${declared.length} different defaults: ${declared.join(", ")}`,
        "an ARG is re-declared per stage; disagreeing checksums mean one stage verifies an artifact nobody reviewed",
      );
      continue;
    }
    const override = env[name]?.trim();
    // Set-but-empty: not unset, and not a way to unset the gate either — the
    // operator who exported a blank BUN_SHA256 believes they SET something,
    // and "passes as if unset" is the same silent nothing refusal #2 exists
    // to prevent.
    if (override === "") {
      problems.push(
        `${name} is set in the environment but is empty or whitespace-only`,
        "an empty override is not a way to unset the gate: this script composes its own --build-arg list either way, so a set-but-blank value must refuse loudly rather than pass as if unset",
      );
      continue;
    }
    // Case-insensitive: a sha256 hex digest spelled in UPPERCASE is the same
    // 32 bytes as the declared default, and refusing it would read as "your
    // checksum is wrong" to an operator whose intent was identical. A value
    // that differs in any other way is still refused.
    if (override !== undefined && override.toLowerCase() !== declared[0]!.toLowerCase()) {
      problems.push(
        `${name}=${override} is set in the environment and is not oci/exedev/Dockerfile's declared default (${declared[0]})`,
        "this script does not thread it into the build, so honouring it silently is not on the table; refusing is",
        `it is a CONTENT GATE: change ARG ${name} in the Dockerfile, which moves the buildId and forces a re-pin — that visibility is the point`,
      );
    }
  }
  return problems;
}

/**
 * The NON-REGISTRY half of {@link gatherBuildIdInputs}: every file whose BYTES
 * are a buildId input, read off disk, failing closed on a missing asset.
 *
 * Split out and EXPORTED so a test can assert the input SET offline. Until it
 * was, the only thing standing between "an asset this image ships changed" and
 * a stale `DEFAULT_IMAGE_BUILD_ID` was CI's `verify-image-pin.yml`: the repo's
 * two pin assertions compare a constant against a hardcoded literal, which
 * catches fixture/constant disagreement and cannot catch a MOVED input. The
 * real buildId cannot be recomputed offline — `baseDigests` needs registry
 * resolution — but this half can, and it is the half a repo edit moves.
 *
 * Exporting changes nothing about the derivation: `gatherBuildIdInputs` calls
 * this and hashes what it returns, exactly as it did inline.
 */
export function buildIdFileInputs(dockerfile: string): { name: string; bytes: Buffer }[] {
  let systemdNames: string[];
  try {
    systemdNames = fs.readdirSync(SYSTEMD_DIR).filter((f) => !f.startsWith(".")).sort();
  } catch {
    throw new BuildIdInputsError([`no systemd assets at ${path.relative(REPO_ROOT, SYSTEMD_DIR)}`]);
  }
  if (systemdNames.length === 0) {
    throw new BuildIdInputsError([
      `${path.relative(REPO_ROOT, SYSTEMD_DIR)} is empty; the unit template and tmpfiles conf must ship in the image`,
    ]);
  }

  // KNOWN GAP 3, CLOSED (#186). The file set is the UNION of two enumerations
  // that answer different questions, and both are needed:
  //   - the systemd asset directory, so a file sitting there uncopied is still
  //     an input (it is the one directory whose emptiness is itself a defect,
  //     asserted above);
  //   - every context path the Dockerfile COPYs, derived from the Dockerfile
  //     rather than listed beside it, which is what makes the engine binary's
  //     SOURCES, the cli-anything tree and any future asset part of the image's
  //     identity without a second edit anyone can forget.
  // `.dockerignore` rides along because it decides what a COPY of a directory
  // actually contains — a substrate change with no other file to blame.
  const relNames = new Set<string>(
    systemdNames.map((n) => `${path.relative(REPO_ROOT, SYSTEMD_DIR)}/${n}`),
  );
  // `copyContextSources` throws {@link BuildIdInputsError} on a Dockerfile
  // shape it cannot read; it propagates — this is the exported test surface,
  // and `gatherBuildIdInputs` is the boundary that converts it to `die(2)`.
  const copySources = copyContextSources(dockerfile);
  if (copySources.length === 0) {
    throw new BuildIdInputsError([
      "oci/exedev/Dockerfile COPYs nothing from the build context",
      "it ships the supervision assets and the engine, so an empty scan means this parser broke rather than that the file changed",
    ]);
  }
  for (const src of copySources) for (const f of contextFilesUnder(src)) relNames.add(f);
  if (fs.existsSync(path.join(REPO_ROOT, ".dockerignore"))) relNames.add(".dockerignore");
  return [...relNames].sort().map((name) => ({
    name,
    // Listing a name says nothing about reading it: a dangling symlink, a
    // subdirectory and a permissions failure all land here.
    bytes: readInput(path.join(REPO_ROOT, name), ["it is a buildId input: its bytes reach the image"]),
  }));
}

/** Reads every buildId input off disk, failing closed on a missing asset. */
function gatherBuildIdInputs(platform: string): {
  inputs: BuildIdInputs;
  baseRefs: string[];
  runtimeBaseRef: string;
  /** {@link runtimeBaseRef} pinned to the digest the buildId recorded for it. */
  runtimeBasePinned: string;
} {
  if (!fs.existsSync(DOCKERFILE)) {
    die(2, [
      `no Dockerfile at ${path.relative(REPO_ROOT, DOCKERFILE)}`,
      "DF2.10 authors it alongside this script; it is not optional input",
    ]);
  }
  // THE BUILD BOUNDARY for the exported file-input surface. Everything in the
  // try throws {@link BuildIdInputsError} (or a plain Error from a future
  // edit) so tests can trip these refusals without the runner dying; here —
  // the one place that knows this is fatal-before-the-gates — it is what it
  // always was: `die(2)` with the same lines, same exit code, same output.
  let dockerfileBytes: Buffer;
  let files: { name: string; bytes: Buffer }[];
  let pkgJson: Buffer;
  try {
    dockerfileBytes = readInput(DOCKERFILE, ["DF2.10 authors it alongside this script; it is not optional input"]);
    files = buildIdFileInputs(dockerfileBytes.toString("utf8"));
    pkgJson = readInput(path.join(REPO_ROOT, "package.json"), ["it carries the bun pin the image installs (AC2)"]);
  } catch (err) {
    return die(2, err instanceof BuildIdInputsError ? err.lines : [err instanceof Error ? err.message : String(err)]);
  }
  // The buildId hashes the BYTES above; parsing (FROMs, ARG defaults) reads
  // this decoded view. The Dockerfile is repo-owned ASCII, so the two agree.
  // CRLF is normalised inside each parser rather than here so the exported ones
  // are safe when called directly from a test.
  //
  const dockerfile = dockerfileBytes.toString("utf8");
  let bunVersion: string;
  try {
    bunVersion = readBunPin(pkgJson.toString("utf8"));
  } catch (err) {
    die(2, err instanceof BunPinError ? err.lines : [err instanceof Error ? err.message : String(err)]);
  }

  // The Dockerfile's own `ARG` defaults are dead code (this script always passes
  // `--build-arg`), so a divergence is invisible at build time and shows up as
  // a moved buildId with an unmoved substrate — or, for BUN_VERSION, as a bare
  // `sha256sum -c` mismatch ten QEMU-emulated minutes in. Compared here, before
  // any of those minutes are spent, and named.
  for (const [name, ours] of [["BUN_VERSION", bunVersion], ["PI_VERSION", PI_VERSION]] as const) {
    const declared = dockerfileArgDefaults(dockerfile, name);
    if (declared.length === 0) {
      die(2, [
        `oci/exedev/Dockerfile declares no "ARG ${name}=<default>" for this script to agree with`,
        `this script passes --build-arg ${name}=${ours}; the two must be visibly in lockstep`,
      ]);
    }
    // An ARG must be re-declared in every stage that uses it, so a multi-stage
    // Dockerfile carries several of these. Disagreeing copies mean the lockstep
    // check would pass against one of them while the RUNTIME stage installed
    // the other — the checksum mismatch below, ten QEMU minutes in.
    if (declared.length > 1) {
      die(2, [
        `oci/exedev/Dockerfile declares "ARG ${name}" with ${declared.length} different defaults: ${declared.join(", ")}`,
        "an ARG is re-declared per stage; the copies must agree or the lockstep check only ever tests one of them",
        `this script passes --build-arg ${name}=${ours} to every stage`,
      ]);
    }
    const theirs = declared[0]!;
    if (theirs !== ours) {
      die(2, [
        `${name} disagrees: this script passes ${ours}, oci/exedev/Dockerfile defaults to ${theirs}`,
        ...(name === "BUN_VERSION"
          ? [
              'the version comes from package.json "packageManager"; a bump lands here first',
              "update ARG BUN_VERSION *and* re-measure ARG BUN_SHA256 for the new release, or the build fails inside sha256sum -c",
            ]
          : [`update ARG ${name} in the Dockerfile, or PI_VERSION in this script — they name the same substrate`]),
      ]);
    }
  }

  const checksumProblems = checksumArgProblems(dockerfile, process.env);
  if (checksumProblems.length > 0) die(2, checksumProblems);

  let baseRefs: string[];
  let runtimeBaseRef: string | null;
  try {
    baseRefs = parseBaseRefs(dockerfile);
    // The runtime base is the FINAL stage's base, chased through stage aliases —
    // not "the last ref parsed". See `resolveRuntimeBaseRef`.
    runtimeBaseRef = resolveRuntimeBaseRef(dockerfile);
  } catch (err) {
    // `fromInstructions`' heredoc/continuation refusal. It throws so its
    // exported callers stay unit-testable; here it is what it always was — a
    // fatal-before-the-gates condition.
    return die(2, [err instanceof Error ? err.message : String(err)]);
  }
  if (baseRefs.length === 0) die(2, ["oci/exedev/Dockerfile declares no FROM the buildId could pin"]);
  const baseDigests = baseRefs.map(resolveBaseDigest);
  // The `includes` half is a BELT-AND-BRACES assertion that the two parsers
  // agree, not a live guard: `resolveRuntimeBaseRef` chases until `stageAt`
  // returns -1, and `parseBaseRefs` applies the identical order-bounded
  // `namesAnEarlierStage` test to the identical `fromInstructions` output,
  // skipping only `scratch` (which the `=== null` arm already covers). So it is
  // vacuously true today and the message below only ever describes the `null`
  // case. Kept because the two parsers are separately maintained and a
  // divergence between them silently redirects AC5's negative control.
  if (runtimeBaseRef === null || !baseRefs.includes(runtimeBaseRef)) {
    return die(2, [
      "cannot determine which image the FINAL stage of oci/exedev/Dockerfile derives from",
      "AC5's added-binary diff subtracts that image's executables; a guess there greens an unattributed binary",
      "give the final stage a literal FROM (or an AS-named stage that bottoms out at one)",
    ]);
  }
  // Pinned to the digest the buildId recorded, so the negative control diffs
  // against the SAME BYTES. Unpinned, three independent resolutions of one
  // floating tag are in play — this script's registry read, buildx's own, and
  // whatever the local daemon happens to hold for `docker run <tag>` — and the
  // set difference is only meaningful if they agree, which nothing enforced.
  const runtimeBaseDigest = baseDigests[baseRefs.indexOf(runtimeBaseRef)]!;
  const runtimeBasePinned = runtimeBaseRef.includes("@") ? runtimeBaseRef : `${runtimeBaseRef}@${runtimeBaseDigest}`;

  return {
    // The dockerfile input is the raw BYTES, not the decoded string above —
    // the buildId hashes what is on disk, with no utf8 round-trip in between.
    inputs: { baseDigests, platform, bunVersion, piVersion: PI_VERSION, dockerfile: dockerfileBytes, files },
    baseRefs,
    runtimeBaseRef,
    runtimeBasePinned,
  };
}

// ─────────────────────────── filesystem + credentials ───────────────────────────

interface ImageScan {
  /** INV-IBOX-1 findings; non-empty means exit 1. */
  findings: string[];
  /** Distinct `…/node_modules` roots observed in the exported filesystem. */
  nodeModulesSites: string[];
  /** Layer-history lines the secret detector read. Recorded as falsifiable evidence. */
  historyLinesScanned: number;
  /** Non-directory entries the exported-filesystem listing produced. */
  pathsScanned: number;
  /** Paths `classifyScanPath` nominated for content judgement. */
  pathsInspected: number;
}

/**
 * A candidate file's TEXT, or null when it is not text at all.
 *
 * `readFileSync(dest, "utf8")` was the one fail-OPEN direction left in this
 * gate. `configLooksLikeCredential` is two text regexes with no binary arm, and
 * a lossy utf8 decode maps every non-ASCII byte to U+FFFD — so a DER/PKCS#8
 * key at `/etc/ssl/private/server.key`, a `.p12`, a gzipped `.pem` or any
 * binary `credentials` file read CLEAN and INV-IBOX-1 reported a pass. Every
 * other boundary in this area (unreadable, EISDIR, symlink, NFC/NFD) was
 * hardened to fail closed; this one failed open, on a real credential.
 *
 * "Not text" means a NUL byte (no text config has one) or bytes that do not
 * round-trip through UTF-8, and the caller turns it into a finding in its own
 * right rather than asking a text regex about it.
 */
function decodeCandidate(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : null;
}

/**
 * Reads each candidate config file out of the container and reports the ones
 * that actually carry a secret. A file that cannot be read is reported rather
 * than skipped — INV-IBOX-1 fails closed like everything else here. (DF2.9's
 * `inspectConfigs`, unchanged in substance; it is bound to a container id
 * rather than exported, so it lives here rather than being imported.)
 *
 * `-L` (--follow-link) is load-bearing and NOT a relaxation. A SYMLINKED config
 * must be judged by its TARGET's content — the bytes a booted box would read —
 * and without `-L` this scan could not judge them at all. MEASURED on this
 * image: `docker cp` of `/etc/ssl/certs/ACCVRAIZ1.pem` (a symlink into
 * /usr/share/ca-certificates/mozilla/) EXITS 0 and writes a DANGLING symlink
 * into the host scratch dir, so the failure lands one line down in
 * `readFileSync` — 126 phantom findings that named unreadability, not a
 * credential. Failing closed on genuinely unreadable is right and is KEPT
 * below, both branches intact; a symlink was never unreadable, we were asking
 * wrong.
 *
 * `-L` also closes a hole for the TOP-LEVEL path, and only for that one: the
 * dangling host symlink it replaces was an absolute in-container path, so a
 * config symlinked to `/etc/passwd` would have had the HOST's file read and
 * judged in its place. `docker cp -L` dereferences SRC_PATH — entries INSIDE a
 * copied tree still land as symlinks, which is why {@link judgeCandidateDir}
 * refuses to read through them rather than trusting this flag to have done it.
 * Content judgement is unchanged — `configLooksLikeCredential` still decides,
 * so a public CA cert (`BEGIN CERTIFICATE`) reads clean and a real `BEGIN …
 * PRIVATE KEY` still fires, wherever the link pointed.
 *
 * The NFC retry is the SAME fail-closed defect wearing a second hat, and it is
 * HOST-DEPENDENT, which is why it has to be handled rather than waited for.
 * MEASURED on this image: `/etc/ssl/certs/NetLock_Arany_=Class_Gold=_
 * Főtanúsítvány.pem` is stored NFC (`F c5 91 …`, ő precomposed), but macOS's
 * bsdtar emits the entry NFD (`F o cc 8b …`) when listing the export — the
 * HFS+/APFS convention, applied to a Linux tar stream. `docker cp` is then
 * handed a path that does not exist in the container and the scan fails closed
 * on a file it could perfectly well have read. GNU tar on a Linux CI runner
 * does not normalise, so this fires ONLY on a macOS host: a gate whose verdict
 * depends on who ran it. BOTH normal forms are tried — `[p, NFC(p), NFD(p)]`,
 * deduped, so the common all-ASCII case still makes exactly one `docker cp`
 * call — and the finding is raised only if EVERY one fails, so fail-closed is
 * preserved exactly. This widens how the file is ASKED for, never what counts
 * as clean. `[p, NFC(p)]` alone was the overclaim: when the listing already
 * hands over an NFC name, `p.normalize("NFC")` IS `p`, the Set collapses to one
 * variant, and a path genuinely stored NFD in the container was never asked
 * for. Deliberately not an unconditional `.normalize(…)` in either direction,
 * which would mangle one of the two cases rather than trying both.
 */
function inspectConfigs(cid: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const scratch = makeTempDir(path.join(os.tmpdir(), "qds-exedev-scan-"));
  // Registered for the signal sweep BEFORE the first `docker cp`, and
  // deregistered by the `finally` below. This directory holds the copies of
  // every credential-CANDIDATE file in the image — the one temp tree in this
  // script whose contents can be a real private key — and the local `finally`
  // covers a throw and a normal return but not SIGINT/SIGTERM, which is
  // exactly the signal an operator sends to a scan that is taking too long.
  leaked.paths.add(scratch);
  const findings: string[] = [];
  try {
    for (const [i, p] of paths.entries()) {
      let text: string | null = null;
      let dirAt: string | null = null;
      // Why the copy failed, for the finding. stderr was already being piped
      // and then dropped on the floor, so the operator got a build-stopping
      // INV-IBOX-1 finding naming a path and no cause at all.
      let cpErr = "";
      // Both Unicode spellings of the same name, deduped so the common
      // all-ASCII case still makes exactly one `docker cp` call. Each variant
      // gets its OWN dest: `docker cp` of a file into an EXISTING directory
      // copies INTO it, so a shared dest that a directory-hit had already
      // created would absorb the sibling spelling's genuine credential file
      // and re-read as EISDIR — a silent skip on the one gate that must not
      // have one.
      /** The copy landed, but the bytes are not text this scanner can judge. */
      let unjudgeable: string | null = null;
      for (const [j, variant] of [...new Set([p, p.normalize("NFC"), p.normalize("NFD")])].entries()) {
        const dest = path.join(scratch, `cfg-${i}-${j}`);
        const cp = spawnSync("docker", ["cp", "-L", `${cid}:/${variant}`, dest], {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (cp.status !== 0) {
          const why = (cp.stderr ?? (cp.error ? cp.error.message : "")).split("\n").filter((l) => l.trim() !== "").at(-1);
          if (why !== undefined) cpErr = why.trim();
          continue;
        }
        try {
          // TYPE-CHECKED BEFORE READING. `docker cp` reproduces a FIFO as a
          // FIFO, and `readFileSync` on one with no writer blocks forever —
          // nothing in this file has a timeout, so the gate would wedge with
          // no output and no exit code, concluding neither way. A directory
          // still routes to `judgeCandidateDir` (the EISDIR carve-out, now
          // decided by the stat rather than by catching the throw); anything
          // else that is not a regular file is reported as itself.
          const st = fs.statSync(dest);
          if (st.isDirectory()) {
            // `-L` resolves a symlink-to-DIRECTORY into a directory here, and
            // CONFIG_CANDIDATE_OUTSIDE_DEPS matches the bare basename
            // `credentials` and every `.pem`/`.key`. A directory by one of
            // those names is NOT clean by fiat — it can carry credentials as
            // files inside it — so the copied tree is judged below rather than
            // skipped. Fall through to the next spelling first, in case a
            // sibling spelling names the real file.
            dirAt = dest;
            continue;
          }
          if (!st.isFile()) {
            unjudgeable = `/${p} is not a regular file (${st.isFIFO() ? "FIFO" : st.isSocket() ? "socket" : "device or other"}); this scan cannot read it for credentials — treating as a finding`;
            break;
          }
          const decoded = decodeCandidate(fs.readFileSync(dest));
          if (decoded === null) {
            unjudgeable = `could not judge /${p} as text (binary or non-UTF-8 content); a text credential scan cannot clear it — treating as a finding`;
            break;
          }
          text = decoded;
          break;
        } catch {
          // Fall through to the next spelling rather than concluding here.
        }
      }
      if (text !== null) {
        if (configLooksLikeCredential(text)) findings.push(`credential inside /${p}`);
        continue;
      }
      if (unjudgeable !== null) {
        findings.push(unjudgeable);
        continue;
      }
      if (dirAt !== null) {
        findings.push(...judgeCandidateDir(dirAt, p));
        continue;
      }
      findings.push(
        `could not read /${p} to check it for credentials — treating as a finding${cpErr === "" ? "" : ` (docker cp: ${cpErr})`}`,
      );
    }
  } finally {
    // GUARDED, exactly as `sweepLeaks` guards the identical call. An
    // EPERM/EBUSY/ENOTEMPTY on the scratch tree used to escape the `finally`,
    // DISCARD the findings that were about to be returned, and propagate
    // uncaught — bun exits 1, the code this file's contract reserves for a
    // COMPLIANCE failure. A temp-dir cleanup fault reported as a credential
    // finding. The path stays in `leaked.paths` when the removal fails, where
    // the exit handler retries it.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      leaked.paths.delete(scratch);
    } catch {
      // Left registered on purpose — the exit sweep is the backstop.
    }
  }
  return findings;
}

/**
 * INV-IBOX-1 for a DIRECTORY that landed where a credential-candidate file was
 * expected. A directory named `credentials` (or `foo.pem/`) can absolutely
 * carry credentials — as files inside it, whose own basenames need not match
 * any candidate pattern (`credentials/token` matches nothing). So the tree
 * `docker cp` already copied to the host is walked and every non-directory
 * entry is judged by the same content scanner. Anything that cannot be listed
 * or read is a finding: fail closed, per this file's own doctrine that a
 * vacuous pass on a credential gate must never look like a green one.
 *
 * A SYMLINK INSIDE the tree is REPORTED, never followed, and that is the whole
 * reason this walk uses `isSymbolicLink()` rather than `isDirectory()`.
 * `docker cp -L` dereferences the top-level SRC_PATH only, so entries within a
 * copied tree arrive as links whose targets are absolute IN-CONTAINER paths —
 * and `fs.readFileSync` resolves those against the BUILD HOST. An in-image
 * credential reached through an inner link was therefore judged against
 * whatever the host happened to have at `/etc/…`: a clean host file greening
 * an image secret, which is the failure direction this gate cannot have. The
 * opposite-direction bug was on the same line: `Dirent.isDirectory()` is FALSE
 * for a link to a directory, so such an entry fell into `readFileSync`, threw
 * EISDIR, and failed an otherwise clean build with "could not read". Both go
 * away by classifying links first and naming them — fail closed, but as
 * themselves.
 */
export function judgeCandidateDir(dir: string, label: string): string[] {
  const findings: string[] = [];
  const walk = (d: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      findings.push(`could not list /${label}${rel} to check it for credentials — treating as a finding`);
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      // Before the directory test: `isDirectory()` is false for a link to one,
      // and following either kind resolves an in-container target on the host.
      if (e.isSymbolicLink()) {
        findings.push(
          `/${label}${childRel} is a symlink; its target is an in-image path this scan cannot resolve on the host — treating as a finding`,
        );
        continue;
      }
      if (e.isDirectory()) {
        walk(path.join(d, e.name), childRel);
        continue;
      }
      // Oddities are REPORTED, not read. `readFileSync` on a FIFO with no
      // writer blocks forever and nothing here has a timeout, so a FIFO named
      // inside a credential-candidate directory would wedge the gate with no
      // output and no exit code. "Everything else is a readable file" was the
      // assumption; `docker cp` reproduces a FIFO as a FIFO.
      if (!e.isFile()) {
        findings.push(
          `/${label}${childRel} is not a regular file (${e.isFIFO() ? "FIFO" : e.isSocket() ? "socket" : "device or other"}); this scan cannot read it for credentials — treating as a finding`,
        );
        continue;
      }
      // Judged by content — through BYTES, so a binary secret cannot decode
      // lossily into U+FFFD and read clean. See `decodeCandidate`.
      try {
        const text = decodeCandidate(fs.readFileSync(path.join(d, e.name)));
        if (text === null) {
          findings.push(
            `could not judge /${label}${childRel} as text (binary or non-UTF-8 content); a text credential scan cannot clear it — treating as a finding`,
          );
        } else if (configLooksLikeCredential(text)) {
          findings.push(`credential inside /${label}${childRel}`);
        }
      } catch {
        findings.push(`could not read /${label}${childRel} to check it for credentials — treating as a finding`);
      }
    }
  };
  walk(dir, "");
  return findings;
}

/**
 * The OUTERMOST `…/node_modules` root an exported-tar entry sits under, if any.
 *
 * Keeps scanning past a non-boundary hit rather than giving up on it. The
 * first occurrence of the substring is not necessarily the first npm tree:
 * `usr/lib/my_node_modules/foo/node_modules/pkg/index.js` has a real root to
 * the RIGHT of a false one, and returning null there is a silent green on the
 * exact condition this sweep exists to catch ("expected 0, a NON-ZERO count is
 * itself the finding").
 *
 * The boundary is tested on BOTH sides, not just the left. Requiring the
 * literal `node_modules/` meant a listing that renders directory entries with
 * no trailing separator — the bsdtar fallback path, taken when
 * `--quoting-style=escape` is unsupported — reported 0 sites for an EMPTY
 * `usr/lib/node_modules` root that is really there. The caller filters entries
 * ending in `/` before asking, so a slash-terminated directory entry never
 * reaches here and only the slashless spelling is in play. The cost is that a
 * regular FILE named `node_modules` now reads as a site: fail-closed, and loud
 * (a spurious `die(1)`), which is the direction this gate is required to fail.
 */
export function nodeModulesRoot(entry: string): string | null {
  const seg = "node_modules";
  for (let idx = entry.indexOf(seg); idx >= 0; idx = entry.indexOf(seg, idx + 1)) {
    const after = entry[idx + seg.length];
    if ((idx === 0 || entry[idx - 1] === "/") && (after === undefined || after === "/")) return entry.slice(0, idx + seg.length);
  }
  return null;
}

/**
 * A `docker create` id, or fatal. Every OTHER identifier in this file is shape
 * validated (`manifestDigest`, `builtDigest`, `imageId`, both git values) on the
 * stated grounds that a plausible-looking blob is worse than none — and this one
 * is `shQuote`'d into an export pipeline and interpolated into `docker cp`
 * paths. Any docker build that writes a note to STDOUT on create (a
 * platform-mismatch warning, a deprecation notice, credential-helper chatter)
 * yields a multi-line "id" and an opaque failure two commands later.
 */
function assertCid(raw: string, label: string): string {
  const cid = raw.trim();
  if (!/^[0-9a-f]{64}$/.test(cid)) {
    // The create SUCCEEDED (`run` dies on a non-zero status), so a real
    // container exists — its id merely buried in the polluted stdout. Dying
    // without removing it would strand a container holding the image ref,
    // manufacturing the exact condition the preflight refuses to run under.
    // Best effort: every container-id-shaped token in the raw output is
    // removed before the exit, and the message says whether that was tried.
    const tokens = raw.match(/[0-9a-f]{64}/g) ?? [];
    for (const t of tokens) spawnSync("docker", ["rm", "-f", t], { stdio: "ignore" });
    // A SHAPE SUMMARY, never the bytes. This docblock names credential-helper
    // chatter as a likely cause of the pollution, and a misconfigured helper
    // prints its `{"Username":…,"Secret":…}` blob on stdout — so echoing the
    // first 120 characters put a credential into a public CI build log, from
    // the one message written to explain that docker said something unexpected.
    die(2, [
      `${label} did not print a container id (got ${cid.length} character(s) over ${cid.split("\n").length} line(s)${/[0-9a-fA-F]{32,}/.test(cid) ? ", containing a long hex token" : ""}${/["{}]/.test(cid) ? ", containing JSON punctuation" : ""})`,
      "docker wrote something unexpected to stdout; the id is used to export and copy from the image, so it is not guessed",
      tokens.length > 0
        ? `best-effort removal was attempted for ${tokens.length} container-id-shaped token(s) found in that output`
        : "no container-id-shaped token was found in that output, so the created container could NOT be removed — check docker ps -a",
    ]);
  }
  leaked.containers.add(cid);
  return cid;
}

/**
 * `docker rm -f`, deregistering from {@link leaked} ONLY when the removal
 * actually succeeded.
 *
 * The status was never read and the id was dropped from `leaked.containers`
 * unconditionally — so a FAILED removal left a container holding an image
 * reference with no record of it anywhere, and the exit/signal handlers whose
 * entire job is that retry could no longer see it. A leaked container holding
 * the image ref is precisely the condition `main`'s preflight refuses to run
 * under ("remove the containers holding it"), i.e. the next run fails too.
 */
function removeContainer(cid: string): void {
  if (spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" }).status === 0) leaked.containers.delete(cid);
}

/**
 * One entry of a GNU `tar --quoting-style=escape` listing, decoded.
 *
 * Decoded through BYTES, not code units: under a C locale GNU tar renders every
 * non-ASCII byte as `\NNN` octal, and this image's `/etc/ssl/certs` carries
 * UTF-8 names (the NFC/NFD cert the `inspectConfigs` docblock measured). A
 * per-character `String.fromCharCode` would turn those into mojibake, `docker
 * cp` would miss them, and the gate would raise 126 phantom findings — the
 * exact regression this whole area was fixed out of once already. The
 * pass-through path iterates CODE POINTS for the same reason: indexing code
 * units would split an astral character (an emoji in a path) into lone
 * surrogates, which `Buffer.from(…, "utf8")` encodes as U+FFFD.
 *
 * KNOWN CEILING: a name that is not valid UTF-8 AND passes through this
 * function un-escaped (a UTF-8-locale tar emits raw bytes for its locale's
 * charset) can still mangle in the final `toString("utf8")` — invalid
 * sequences become U+FFFD, and `docker cp` then misses the real file, which
 * fails CLOSED as a "could not read" finding, never as a silent pass. Closing
 * it means carrying bytes (not a JS string) all the way into the `docker cp`
 * argv. Repo-controlled and vendor-base content is ASCII/UTF-8 today; upgrade
 * path is that byte-path plumbing, when a base ever ships such a name.
 */
export function tarUnescape(entry: string): string {
  if (!entry.includes("\\")) return entry;
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]!;
    if (c !== "\\") {
      // The full code point, not `entry[i]` (one code unit): an astral
      // character here is two code units, and each lone surrogate would
      // utf8-encode as U+FFFD.
      const cp = entry.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
      if (cp > 0xffff) i += 1;
      continue;
    }
    const oct = entry.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(Number.parseInt(oct, 8));
      i += 3;
      continue;
    }
    const next = entry[i + 1];
    if (next !== undefined && next in simple) {
      bytes.push(simple[next]!);
      i += 1;
      continue;
    }
    bytes.push(92); // a backslash tar did not escape: keep it verbatim
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * A layer-history line with the VALUE of every `NAME=value` assignment removed.
 *
 * The INV-IBOX-1 history finding used to quote the matched line verbatim, and
 * `die(1, …)` writes findings to stderr — into the build log. `SECRET_ENV`
 * matches `NAME=\S`: it fires BECAUSE a value follows, and BuildKit renders a
 * build-arg-tainted layer as `|1 NPM_TOKEN=<the actual value> /bin/sh -c …`.
 * So the one finding in this file that reported CONTENT rather than a path was
 * printing the credential it had just caught, into a log GitHub masks only for
 * values registered as `secrets.*`. The name and the layer command are what an
 * operator needs; the value is the thing being reported, never the report.
 *
 * Every assignment is redacted, not just the secret-shaped ones: a name that
 * did not match the pattern can still hold the secret that did, and the
 * assignment shape is the whole reason the value is there. Flags keep their
 * values (`--prefix=/usr/local` does not start a NAME), so the layer stays
 * readable. The NAME character class is a SUPERSET of `SECRET_ENV`'s, so
 * nothing it can match can slip through unredacted.
 *
 * The VALUE runs to END-OF-LINE or to the next `NAME=`, NOT to the next
 * whitespace. `\S+` was the leak this function exists to prevent, wearing the
 * costume of the fix: a value with a space in it kept its tail. EXECUTED
 * against the real pair — `SECRET_ENV.test('ENV NPM_TOKEN={"k": "sekrit"}')` is
 * true and the old redaction produced `ENV NPM_TOKEN=<redacted> "sekrit"}`,
 * publishing the credential the gate had just caught. `docker image history
 * --no-trunc` strips the Dockerfile's quoting, so a JSON or quoted build-arg
 * value is the ordinary shape here, not a contrived one.
 *
 * The price is paid deliberately: the layer COMMAND after the assignment
 * (`… /bin/sh -c npm install`) is redacted along with the value, because a
 * value containing a space is indistinguishable from the command that follows
 * it and guessing the boundary is how the tail leaked in the first place. The
 * NAME and the assignments that follow are what an operator needs to find the
 * bake; the rest of the line is not worth a credential.
 */
export function redactAssignments(line: string): string {
  return line.replace(
    /(^|[\s|"'])([A-Za-z0-9_]+)=(?:(?!\s+[A-Za-z0-9_]+=).)*/g,
    (_m, lead: string, name: string) => `${lead}${name}=<redacted>`,
  );
}

/**
 * INV-IBOX-1 over layer history AND the exported filesystem, plus the AC5
 * observation the same listing is already carrying: where, if anywhere, an npm
 * tree exists in the shipped image. One export, two questions — a second export
 * of a multi-gigabyte image to ask the second one would be pure waste.
 */
function scanImage(imageId: string): ImageScan {
  const findings: string[] = [];

  const history = run(
    "docker",
    ["image", "history", "--no-trunc", "--format", "{{.CreatedBy}}", imageId],
    "docker image history",
  );
  // A LOCAL, provably non-global copy of the imported predicate. `SECRET_ENV`
  // is `/…/i` today, so `.test` is stateless — but it is declared one module
  // over, it is called here in a LOOP, and `RegExp.prototype.test` on a `/g`
  // regex advances `lastIndex` and returns false on alternate calls. Adding `g`
  // there is a one-character edit that would silently halve a CREDENTIAL gate's
  // coverage with no test able to see it. Copying the source without `g`/`y`
  // makes that impossible from here rather than depending on it not happening.
  const secretEnv = new RegExp(SECRET_ENV.source, SECRET_ENV.flags.replace(/[gy]/g, ""));
  const historyLinesScanned = history.split("\n").filter((l) => l.length > 0).length;
  for (const line of history.split("\n")) {
    // REDACTED — see `redactAssignments`. The finding goes to stderr and into
    // the build log, and the matched value is the credential itself.
    if (secretEnv.test(line)) {
      findings.push(`layer history bakes a secret-shaped value: ${redactAssignments(line.trim())}`);
    }
  }

  const sites = new Set<string>();
  let pathsScanned = 0;
  let pathsInspected = 0;
  const cid = assertCid(run("docker", ["create", imageId], "docker create (scan)"), "docker create (scan)");
  try {
    // `docker export` streams the FLATTENED filesystem; tar lists it without
    // unpacking a whole Ubuntu onto the host. Known limit, inherited from
    // DF2.9: a secret written in one RUN and deleted in a later one survives in
    // the layer tarball but is invisible here. The history scan above catches
    // the ENV/ARG shape of that leak.
    // `pipefail` is required — `tar -tf -` exits 0 as soon as it reads an
    // end-of-archive marker, so a failed export would otherwise pass vacuously.
    //
    // `--quoting-style=escape` makes the line split honest: a newline is legal
    // in a Linux path, and without it one entry becomes two half-paths that are
    // each classified and each `docker cp`'d, producing a spurious "could not
    // read … — treating as a finding" (exit 1) on a clean image and hiding the
    // real path from `nodeModulesRoot`. GNU tar renders every entry on exactly
    // one line under it. PROBED rather than assumed: bsdtar — the macOS default
    // — has no such option and would fail the whole listing, so this file's own
    // "a gate whose verdict depends on who ran it" problem would just move. On
    // a host without it the split stays as it was, which mis-splits rather than
    // silently passing.
    const escapes = spawnSync("tar", ["--quoting-style=escape", "--version"], { stdio: "ignore" }).status === 0;
    const tar = escapes ? "tar --quoting-style=escape -tf -" : "tar -tf -";
    const listing = spawnSync("bash", ["-c", `set -o pipefail; docker export ${shQuote(cid)} | ${tar}`], {
      encoding: "utf8",
      // 512 MiB, BELOW V8's ~512 MB max string length and not the 2 GiB it was.
      // Between the two limits `spawnSync`'s own utf8 decode throws a RangeError
      // before `listing.status` is ever read, and that uncaught throw exits 1 —
      // the code this file reserves for a COMPLIANCE failure, for a Node string
      // limit. Under the cap, an overrun lands on the ENOBUFS path below, which
      // dies with 2 and names the cause.
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (listing.status !== 0) {
      // `listing.error` carries the real cause when the child was killed rather
      // than exited (ENOBUFS on a listing over the cap, ENOENT when tar is
      // absent) — pointing the operator at docker/tar for a buffer limit is a
      // diagnosis that sends them to the wrong place.
      die(2, [
        `docker export | tar failed while scanning the built filesystem (exit ${listing.status ?? "on a signal"}${listing.signal ? `, signal ${listing.signal}` : ""})`,
        ...(listing.error ? [listing.error.message, "an ENOBUFS here means the listing was larger than the 512 MiB capture cap, not that docker or tar failed"] : []),
      ]);
    }
    // `pipefail` above catches a FAILED export. It does not catch an export
    // that succeeds and yields nothing — and that case is worse, because the
    // loop below would then classify zero paths and INV-IBOX-1 would report
    // clean over an empty set. A vacuous pass on a credential gate is the one
    // outcome that must never look like a green one.
    const entries = (listing.stdout ?? "") /* dp:ok emptiness is fatal immediately below — a vacuous scan cannot pass */
      .split("\n")
      .filter((e) => e.length > 0)
      .map((e) => (escapes ? tarUnescape(e) : e));
    // COUNTED AFTER THE FILE FILTER, not before it. `entries.length > 0` was
    // measured on the wrong collection: an export whose listing yields only
    // `dir/` entries — a stream truncated after tar's directory prologue, a
    // broken exporter — satisfied it, then `classifyScanPath` ran zero times
    // and INV-IBOX-1 reported clean over an EMPTY FILE SET. That is the vacuous
    // pass this guard exists to prevent, three lines above where it was looking.
    const files = entries.filter((e) => e.length > 0 && !e.endsWith("/"));
    if (files.length === 0) {
      die(2, [
        `docker export | tar exited 0 but listed no FILES in the built filesystem (${entries.length} entr(y|ies), all directories or empty)`,
        "no real image has an empty filesystem, so this is a broken probe, not a clean scan",
      ]);
    }
    pathsScanned = files.length;
    const inspect: string[] = [];
    for (const entry of files) {
      const site = nodeModulesRoot(entry);
      if (site !== null) sites.add(site);
      const verdict = classifyScanPath(entry);
      if (verdict === "credential") findings.push(`credential in the image: /${entry}`);
      else if (verdict === "inspect") inspect.push(entry);
    }
    pathsInspected = inspect.length;
    findings.push(...inspectConfigs(cid, inspect));
  } finally {
    removeContainer(cid);
  }
  // Only the SHALLOWEST root per tree: nested `node_modules` come along with
  // their parent when it is copied out.
  const roots = [...sites].sort();
  const nodeModulesSites = roots.filter((s) => !roots.some((r) => r !== s && s.startsWith(`${r}/`)));
  return { findings, nodeModulesSites, historyLinesScanned, pathsScanned, pathsInspected };
}

/**
 * Copies every observed npm tree out of the image so the sweep can read it.
 *
 * `-L` for the same reason `inspectConfigs` uses it: the tree ROOT is copied by
 * value rather than as a link. Stated precisely, because the previous version
 * of this paragraph credited `-L` with closing the whole hole and it does not.
 * `docker cp -L` dereferences SRC_PATH ONLY — a linked package NESTED inside
 * the copied tree (an npm workspace link, a hoisted/linked dep, anything the
 * vendor installer symlinked) still lands in the host scratch dir VERBATIM, as
 * a symlink whose absolute in-container target does not exist. `walkTree`
 * classifies exactly that shape as `unreadable` and NOT as an entry
 * (`license-sweep.ts:288-296` names the case in its own words), so
 * `treePackageCount` is `entries.length` = 0 and `if (sweep.treePackageCount >
 * 0)` alone would pass an image carrying an UNSWEPT npm tree.
 *
 * What actually holds that line is the `failClosed` block in `main`, which
 * makes `sweep.unreadable` a `die(1)`. Deleting it on the belief that `-L`
 * covers this reopens the one failure the AC5 gate exists to catch, as a clean
 * build.
 *
 * Every caller since S1 passes exactly ONE site: the engine's tree and the
 * OpenRig tree are swept into SEPARATE scratch dirs and combined by
 * `mergeSweeps`, because they share package names (yaml, zod) at different
 * versions and the `/.`-merge branch below would overwrite the earlier site's
 * bytes in the scratch copy. The merge branch is retained for a future site
 * that genuinely wants it — with the warning that "name collisions across
 * sites do not matter" stopped being true the day the second permitted site
 * arrived.
 */
function extractNodeModules(imageId: string, sites: readonly string[], dest: string): void {
  const cid = assertCid(run("docker", ["create", imageId], "docker create (tree)"), "docker create (tree)");
  try {
    const nm = path.join(dest, "node_modules");
    for (const [i, site] of sites.entries()) {
      if (i === 0) run("docker", ["cp", "-L", `${cid}:/${site}`, nm], `docker cp /${site}`);
      // Every further site merges INTO the same directory (`/.` copies contents
      // rather than the directory itself). Name collisions across sites do not
      // matter: any package at all on this image is already the finding.
      else run("docker", ["cp", "-L", `${cid}:/${site}/.`, `${nm}/`], `docker cp /${site}`);
    }
  } finally {
    removeContainer(cid);
  }
}

/** A `SweepResult` for a tree that does not exist — the healthy shape here. */
function emptySweep(): SweepResult {
  return {
    treePackageCount: 0,
    entries: [],
    denied: [],
    covered: [],
    uncovered: [],
    unresolved: [],
    missingTexts: [],
    upstreamNotices: [],
    unreadable: [],
    pinViolations: [],
    piVersions: {},
    uncommonIds: [],
    licenseTexts: {},
  };
}

/**
 * Combine the per-site sweep results into the one result the NOTICE and the
 * fail-closed gates read. S1 rig_swarm admitted a SECOND npm tree
 * (/opt/openrig/lib/node_modules), and the trees are swept SEPARATELY rather
 * than merged into one scratch directory because `@openrig/cli` depends on
 * `yaml` and `zod` at versions the engine tree does not ship: an
 * `extractNodeModules` merge would overwrite the engine's copies in the
 * scratch dir and the sweep would attribute bytes the engine never runs.
 * Every field is concatenated or summed — nothing is deduplicated or
 * reconciled, because no downstream consumer reads a package twice for harm:
 * the NOTICE renders every entry it is handed and the fail-closed lists are
 * only ever checked for emptiness.
 */
export function mergeSweeps(parts: readonly SweepResult[]): SweepResult {
  if (parts.length === 0) return emptySweep();
  const first = parts[0];
  if (first === undefined) return emptySweep(); // unreachable past the length guard; keeps noUncheckedIndexedAccess honest
  return parts.slice(1).reduce<SweepResult>((acc, p) => ({
    treePackageCount: acc.treePackageCount + p.treePackageCount,
    entries: [...acc.entries, ...p.entries],
    denied: [...acc.denied, ...p.denied],
    covered: [...acc.covered, ...p.covered],
    uncovered: [...acc.uncovered, ...p.uncovered],
    unresolved: [...acc.unresolved, ...p.unresolved],
    missingTexts: [...acc.missingTexts, ...p.missingTexts],
    upstreamNotices: [...acc.upstreamNotices, ...p.upstreamNotices],
    unreadable: [...acc.unreadable, ...p.unreadable],
    pinViolations: [...acc.pinViolations, ...p.pinViolations],
    piVersions: { ...acc.piVersions, ...p.piVersions },
    uncommonIds: [...acc.uncommonIds, ...p.uncommonIds],
    licenseTexts: { ...acc.licenseTexts, ...p.licenseTexts },
  }), first);
}

/**
 * AC5. The sweep runs over the built image's exported filesystem, so what was
 * swept is what ships — there is no second tree to disagree with, and no
 * `ARG DEPS_IMAGE` binding needed to prove it.
 *
 * On THIS image the expected result is zero packages, and `walkTree` THROWS on
 * an absent tree by design (DF2.9: an absent tree must never read as a
 * vacuously clean sweep). Here that throw is the HEALTHY path — but it is
 * anticipated STRUCTURALLY rather than recognised from its prose. The scan
 * observed no `node_modules` site, so nothing was extracted and there is
 * provably no tree under `treeDir`; that fact is available here without asking
 * another module how it words an error. Matching `/nothing to sweep/` made
 * every clean build on this image depend on a sentence in `license-sweep.ts`,
 * and a reword there would have turned all of them into `die(2)`.
 *
 * With that case taken structurally, a throw from a tree we DID extract is a
 * real failure — a `node_modules` exists in the shipped image and the sweep
 * could not conclude over it — and stays fatal.
 */
function sweepImageTree(imageId: string, sites: readonly string[], treeDir: string): SweepResult {
  if (sites.length === 0) return emptySweep();
  extractNodeModules(imageId, sites, treeDir);
  try {
    return sweepTree({ treeRoot: treeDir, licenseTextsDir: LICENSE_TEXTS });
  } catch (err) {
    // COMPLIANCE (1), not fatal-before-the-gates (2). By the second line's own
    // words this is a state, not a tooling problem: an npm tree shipped in the
    // image and unexplained. Reporting it with the code reserved for "the gates
    // could not conclude" invites a CI classifier that retries or soft-fails 2
    // to turn a licence finding into a flake. The no-tree case never reaches
    // here — `sites.length === 0` returned `emptySweep()` above.
    return die(1, [
      `the filesystem sweep could not conclude: ${err instanceof Error ? err.message : String(err)}`,
      `the image carries node_modules at ${sites.map((s) => `/${s}`).join(", ")}, so this tree is real and must be swept`,
    ]);
  }
}

// ─────────────────────────── compiled-binary attribution ───────────────────────────

interface BinaryEntry {
  /**
   * The in-image paths (no leading slash) this entry attributes — the shape
   * {@link listExecutables} produces, matched whole by {@link uncoveredBinaries}.
   */
  names: string[];
  /**
   * RETIRED (#188). Declared only so {@link validateBinaryLicenses} can REFUSE a
   * table that still carries it rather than ignore it; {@link names} are the
   * paths now.
   */
  paths?: string[];
  project: string;
  spdxId: string;
  copyright: string;
  licenseUrl: string;
  verifiedHow: string;
  bundled?: { component?: string; spdxId?: string; url?: string; note?: string }[];
}

/** Two kinds of problem with `binary-licenses.json`, which exit differently. */
export interface LicenseTableProblems {
  /**
   * The FILE is malformed — a missing field, an empty `names`, a `paths` that
   * is not a non-empty array of relative paths. Fatal-before-the-gates (2),
   * the same code `main`'s shape check uses for the same file: a JSON typo is
   * a bad edit, not a licence violation, and the publish workflow classifies
   * on the exit code.
   */
  structural: string[];
  /**
   * The table is well-formed and says something unacceptable — `UNVERIFIED`,
   * or a licence this repo cannot reproduce the text of. A COMPLIANCE failure
   * (1).
   */
  compliance: string[];
}

/**
 * Structural + substantive validation of `binary-licenses.json`. Every entry
 * must name a license this repo can actually reproduce (DF2.9's own resolver
 * against `oci/license-texts/`), and the sentinel `UNVERIFIED` is a FAILURE
 * rather than a warning: it exists so an unestablished license is recorded
 * honestly instead of guessed at, and a guess that ships is worse than a build
 * that stops.
 *
 * The two classes are returned SEPARATELY because they exit differently. One
 * flat list meant `"names": []` — a JSON typo — exited 1, the code this file's
 * contract reserves for a licence compliance finding, right next to a
 * malformed-top-level check on the same file that correctly exits 2.
 */
export function validateBinaryLicenses(raw: unknown, licenseTextsDir: string): LicenseTableProblems {
  const problems: string[] = [];
  const compliance: string[] = [];
  // `null` is valid JSON, so it reaches here past the parse; a property access
  // on it THROWS, and an uncaught throw exits 1 — the code the contract
  // reserves for a compliance failure. Reported as a problem instead. (`main`
  // makes the same shape check fatal-before-the-gates, which is the honest
  // code for a malformed input file; this guard is what keeps the exported
  // function itself total.)
  const entries = typeof raw === "object" && raw !== null ? (raw as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      structural: ["oci/exedev/binary-licenses.json carries no entries; it cannot attribute anything"],
      compliance: [],
    };
  }
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  // Cross-entry, so two entries cannot claim the same binary under different
  // licences (#188). Which of them a basename-era `some()` happened to match
  // was an ordering accident, and the one that won decided what the NOTICE
  // said about a file's licence.
  const claimed = new Map<string, number>();
  for (const [i, e] of entries.entries()) {
    const at = `entry ${i}`;
    const entry = e as Partial<BinaryEntry>;
    if (!Array.isArray(entry.names) || entry.names.length === 0 || !entry.names.every(nonEmpty)) {
      problems.push(`${at}: "names" must list at least one in-image binary path`);
    } else {
      for (const raw of entry.names) {
        const n = raw.trim();
        // A PATH, not a basename (#188). `uncoveredBinaries` compares against
        // the keys `listExecutables` produces — absolute in-image paths with
        // the leading slash stripped — so a bare `bun` here would attribute
        // nothing at all while validating clean, which is the failure shape
        // the trimmed-compare fix already had to undo once.
        if (!n.includes("/")) {
          problems.push(
            `${at}: "names" entry ${JSON.stringify(raw)} is a basename, not an in-image path — coverage matches on the full path (e.g. "usr/local/bin/bun")`,
          );
        } else if (n.startsWith("/")) {
          problems.push(
            `${at}: "names" entry ${JSON.stringify(raw)} has a leading slash; in-image paths are recorded without one (the shape the executable listing produces)`,
          );
        }
        const first = claimed.get(n);
        if (first !== undefined) {
          problems.push(`${at}: ${JSON.stringify(n)} is already claimed by entry ${first}; one binary, one attribution`);
        } else {
          claimed.set(n, i);
        }
      }
    }
    // GONE, not optional (#188). It existed to narrow a basename match to a
    // path; the names ARE paths now, so an entry still carrying it is one
    // nobody re-measured against the new rule, and silently ignoring it would
    // leave a reader believing a narrowing is in force.
    if (entry.paths !== undefined) {
      problems.push(
        // The STALE-COMMENT clause is not padding. The operator who hits this
        // is, by construction, mid-base-bump and reading
        // oci/exedev/Dockerfile's pi-install block — which still tells them
        // "…so the `chown`, the `rm` and oci/exedev/binary-licenses.json's
        // `paths` can each name the right one", and says it again at the
        // `[ -f … ]` assert. Following that comment and getting a bare "no
        // longer a field" reads as the validator being wrong about the
        // Dockerfile, so it is named as stale here rather than left to be
        // rediscovered. One string, not two: a `problems` entry is one finding.
        `${at}: "paths" is no longer a field — "names" are the in-image paths themselves; fold these into "names" and delete it. (oci/exedev/Dockerfile's pi-install comments still say \`paths\`: they are STALE, not a second contract.)`,
      );
    }
    for (const field of ["project", "spdxId", "copyright", "licenseUrl", "verifiedHow"] as const) {
      if (!nonEmpty(entry[field])) problems.push(`${at}: "${field}" is required and must be non-empty`);
    }
    const id = nonEmpty(entry.spdxId) ? entry.spdxId.trim() : null;
    if (id === "UNVERIFIED") {
      compliance.push(
        `${at} (${entry.project ?? "?"}): license recorded as UNVERIFIED — establish it upstream before publishing`,
      );
    } else if (id !== null && resolveLicenseText(id, licenseTextsDir) === null) {
      compliance.push(`${at} (${entry.project ?? "?"}): no canonical text in oci/license-texts/ for "${id}"`);
    }
    // A bundled disclosure with no pointer is a stub that reads as diligence.
    for (const [j, b] of (entry.bundled ?? []).entries()) {
      if (!nonEmpty(b?.component) || !nonEmpty(b?.url) || !nonEmpty(b?.note)) {
        problems.push(`${at}, bundled ${j}: "component", "url" and "note" are all required`);
      }
    }
  }
  return { structural: problems, compliance };
}

/**
 * Executables in an image: absolute path with no leading slash → sha256 of its
 * CONTENT.
 *
 * The content half is what makes AC5's negative control a control. `added` was
 * a set difference over PATHS, so a binary REPLACED IN PLACE never entered it —
 * and replacement is not a hypothetical here, it is what this Dockerfile does:
 * `exeuntu update pi --version` overwrites the pi tree the base already ships.
 * A vendor installer that landed a different program at an existing path was
 * therefore never asked for attribution, and the entry in
 * `oci/exedev/binary-licenses.json` proved nothing. Hashing costs one pass over
 * a few hundred MB of ELF, twice, and the failure direction of the change is
 * "more binaries need attributing", never fewer.
 *
 * Read with `find` inside the image rather than by parsing `tar -tv`: the
 * verbose tar listing's column layout differs between GNU tar and bsdtar and
 * shifts again for files older than six months (a year replaces the clock), so
 * a parser over it is a silent-misparse surface — and a scan that silently
 * finds no executables would report "nothing was added" on an image carrying an
 * unattributed binary, which is the exact failure AC5 exists to prevent. An
 * empty result is therefore fatal, not clean.
 *
 * `find` is resolved through the container's PATH rather than hardcoded at
 * /usr/bin/find: a base with busybox layout (/bin/find) would otherwise fail to
 * START the container, and the failure was reported as "see the find stderr
 * above" — pointing at output from a process that never ran.
 *
 * KNOWN CEILING — four residual false-negative classes this listing cannot
 * see, so "executables in an image" overstates it slightly: (1) `-type f`
 * excludes SYMLINKS, so an installer that adds an unattributed second entry
 * point as a link to an existing target never enters the built set; (1b)
 * `-perm -u+x` is OWNER-executable, so a file executable only by group or
 * other (mode 0055, or an installer that chowns and drops owner-x) is never
 * enumerated and never needs attribution. `-perm /111` would close it and is
 * NOT used: `find` here is the one inside the image, resolved through its PATH,
 * and `/111` is GNU/BSD syntax a busybox layout need not accept — a hard
 * enumeration failure on a base we do not control is worse than a named
 * ceiling, and both listings being diffed use the same predicate so a base
 * file in this class cancels out; (2) a base binary whose BYTES are unchanged
 * but whose mode flipped (a setuid grant) hashes identically and reads as
 * not-added; (3) THE INSTRUMENT IS THE
 * SUBJECT. `find` and `sha256sum` are the ones inside the image under audit,
 * running as root there — an image that shipped a doctored `find` or
 * `sha256sum` would report whatever it liked about itself. Worse for the
 * negative control specifically: the base run uses the BASE's copies of those
 * two tools, so the two listings being diffed are not produced by one
 * instrument, and a coreutils upgrade between base and built that changed
 * either tool's output shifts the diff for reasons that are not content.
 * Moving the measurement out of the image needs a second, trusted toolchain
 * mounted into both runs (a static busybox/coreutils, or reading the exported
 * tar with a host hasher) — the same #188 seam as (1) and (2), where the
 * upgrade path is listing `-type l` targets and folding the mode into the
 * hashed identity. All of them fail in the direction of "fewer binaries asked
 * about", which is why they are named here rather than assumed away.
 */
function listExecutables(ref: string, platform: string): Map<string, string> {
  const res = spawnSync(
    "docker",
    [
      "run", "--rm", "--platform", platform, "--network", "none", "--user", "0:0",
      // exeuntu's entrypoint is `init` (systemd); overridden because this needs
      // a filesystem listing, not a booted machine.
      "--entrypoint", "/bin/sh", ref,
      // `-xdev` keeps /proc, /sys and /dev — separate mounts in a container —
      // out of the listing. `-exec … +` batches, so this is a handful of
      // sha256sum invocations rather than one per file.
      "-c", "exec find / -xdev -type f -perm -u+x -exec sha256sum {} +",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (res.error) die(2, [`docker run find on ${ref}: ${res.error.message}`]);
  // A non-zero exit is fatal EVEN WITH output on stdout. `find` reports
  // per-path errors (an unreadable directory, a vanished entry) by continuing
  // with the rest of the tree and exiting 1, so a partial listing is the
  // dangerous case, not the empty one: AC5's finding is `added \ base`, and a
  // binary missing from the BUILT image's listing silently drops out of the
  // set that has to be attributed. Fail closed on the exit code and let a real
  // cause be read from the inherited stderr above.
  if (res.status !== 0) {
    // The hint BRANCHES on docker's own exit code. A flat "if the message names
    // /bin/sh or find…" pointed at the base image's layout for what is usually
    // a registry pull, an auth refusal or a missing binfmt handler: this is the
    // run's first DAEMON-side pull of the base (buildx pulled it into the
    // BUILDER's cache, not the daemon's store), so a 401/404/rate-limit lands
    // here, and `--network none` in the neighbourhood invites the wrong theory.
    // Docker distinguishes them: 125 = the daemon could not run the container,
    // 126/127 = the entrypoint is not executable / not found.
    die(2, [
      `enumerating executables in ${ref} exited ${res.status ?? "on a signal"} (see the stderr above)`,
      "a partial listing would under-report added binaries and green an unattributed one — refusing to use it",
      ...(res.status === 126 || res.status === 127
        ? ["exit 126/127: this base does not carry /bin/sh or find where the enumeration expects them"]
        : res.status === 125
          ? [
              "exit 125: the DAEMON could not run the container — this is the first daemon-side pull of this base (buildx pulled it into the builder's cache, not the daemon's store), so a registry auth failure, a 404 or a rate limit lands here",
              `on a cross-architecture build it is also a missing binfmt handler for ${platform}`,
            ]
          : ["--network none is set deliberately; a network error here is the pull that preceded the run, not the find"]),
    ]);
  }
  const out = new Map<string, string>(); /* dp:ok emptiness is fatal below: no real image has zero executables */
  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.length === 0) continue;
    // coreutils' own escaping: a name carrying a backslash or a newline is
    // emitted with a `\` BEFORE the hash and the name backslash-escaped. An
    // unparseable line is fatal for the same reason a partial listing is —
    // dropping it silently removes a binary from the set that must be
    // attributed.
    const m = line.match(/^(\\?)([0-9a-f]{64}) [ *](.*)$/);
    if (!m) {
      die(2, [
        `enumerating executables in ${ref} produced a line that is not "<sha256>  <path>": ${JSON.stringify(line.slice(0, 200))}`,
        "a dropped line would under-report added binaries and green an unattributed one",
      ]);
    }
    const raw = m[3]!;
    // coreutils escapes exactly `\n` and `\\` today, but its repertoire is not
    // frozen (newer releases escape `\r` too). An UNKNOWN pair decoded by
    // guessing would silently rewrite the path into one the image does not
    // contain — a plausible-looking blob, worse than none — so it dies loudly
    // like every other unparseable line here.
    const unescaped = m[1]
      ? raw.replace(/\\(.)/g, (_, c: string) => {
          if (c === "n") return "\n";
          if (c === "\\") return "\\";
          return die(2, [
            `enumerating executables in ${ref} used an escape this decoder does not know: \\${c} in ${JSON.stringify(line.slice(0, 200))}`,
            "coreutils' escaping repertoire grew; teach this decoder the new pair rather than guessing the path",
          ]);
        })
      : raw;
    const p = unescaped.replace(/^\//, "");
    if (p.length > 0) out.set(p, m[2]!);
  }
  if (out.size === 0) {
    die(2, [
      `enumerating executables in ${ref} produced nothing (find exited ${res.status ?? "on a signal"})`,
      "no real Linux image has zero executables, so this is a broken probe, not a clean one",
    ]);
  }
  return out;
}

/**
 * Added binaries no entry covers (AC5's failure).
 *
 * Coverage is by PATH (#188). It used to be by BASENAME, optionally narrowed by
 * an `paths` field, which meant `oci/exedev/binary-licenses.json`'s two entries
 * — `["bun"]` and `["pi"]` — attributed any executable called `bun` or `pi`,
 * from any project, at any path in the image: `/opt/vendor/bun` read as covered
 * by a table that establishes oven-sh/bun at /usr/local/bin. Attribution could
 * be satisfied by a coincidence of names, in a gate whose negative control had
 * just been strengthened to catch content-level replacement.
 *
 * `names` are now the full in-image paths `listExecutables` produces
 * (leading-slash-stripped), and the separate `paths` narrowing is GONE rather
 * than left in place: once a name IS a path, `paths` could only restate it or
 * contradict it, and a field that reads as a safety narrowing while doing
 * nothing is worse than no field. `validateBinaryLicenses` refuses an entry
 * that still carries one.
 */
export function uncoveredBinaries(added: readonly string[], entries: readonly BinaryEntry[]): string[] {
  // Compared TRIMMED, because `validateBinaryLicenses` accepts trimmed
  // (`nonEmpty` trims) and `spdxId` is already used trimmed. `"names": [" bun"]`
  // therefore validated clean and then attributed nothing, so `bun` reported as
  // uncovered with the diagnostic "no entry in oci/exedev/binary-licenses.json"
  // — while the entry was right there. Fails closed, but at the wrong problem.
  const covers = (p: string): boolean => entries.some((e) => e.names.some((n) => n.trim() === p));
  return added.filter((p) => !covers(p));
}

/** What {@link buildArgList} needs; everything the image bakes about itself. */
export interface MarkerInputs {
  bunVersion: string;
  piVersion: string;
  /** The full `--tag`. Only its REPOSITORY reaches the image — see below. */
  tag: string;
  buildId: string;
  gitSha: string;
  builtAt: string;
  epoch: number;
}

/**
 * Every `--build-arg` the solve gets, as one list — which makes the property
 * #187 turns on ASSERTABLE without a build: two invocations differing only in
 * `--tag` must produce IDENTICAL lists, because these args are the only channel
 * by which the tag could reach a layer.
 *
 * #187, CLOSED, by its own option 1. `QDS_IMAGE_REF` used to be `opts.tag`
 * verbatim, which the Dockerfile bakes into `/etc/qds-image.json` — a
 * filesystem layer, therefore part of the manifest, therefore part of the
 * DIGEST. Meanwhile `deriveBuildId` deliberately excludes the tag. So the
 * identical tree published under two tags produced two digests and ONE buildId,
 * the publish workflow's digest gate failed on its first real run by
 * construction, and gate B could not tell the two artifacts apart — the thing
 * that was proven was not the thing that shipped.
 *
 * The marker now carries the REPOSITORY, tag stripped. It still says which
 * repository a box's bytes came from, which is all a human reading a box ever
 * used it for — `transport.ts` reports `imageRef` and never compares it, on
 * purpose, so that a D7 tenant mirror with the same digest and buildId under a
 * different ref still passes. Option 2 (drop the field) would have cost that
 * provenance line and changed the marker's key set; option 3 (hash the tag)
 * was rejected upstream in the issue for making identity depend on how a build
 * was published rather than on what is in it.
 */
export function buildArgList(m: MarkerInputs): string[] {
  return [
    "--build-arg", `BUN_VERSION=${m.bunVersion}`,
    "--build-arg", `PI_VERSION=${m.piVersion}`,
    "--build-arg", `QDS_IMAGE_REF=${refRepository(m.tag)}`,
    "--build-arg", `QDS_BUILD_ID=${m.buildId}`,
    "--build-arg", `QDS_GIT_SHA=${m.gitSha}`,
    "--build-arg", `QDS_BUILT_AT=${m.builtAt}`,
    // BuildKit reads this build arg by name: it fixes the config's `created`
    // and is the epoch `rewrite-timestamp` normalises every layer mtime to.
    // Passed explicitly rather than left to the ambient environment so the
    // value is the one this script decided, visible in the command line.
    "--build-arg", `SOURCE_DATE_EPOCH=${m.epoch}`,
  ];
}

// ──────────────────────────────────── main ────────────────────────────────────

interface Options {
  tag: string;
  platform: string;
  push: boolean;
  summary: string;
  evidence: string;
  keepTree: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    tag: DEFAULT_TAG,
    platform: DEFAULT_PLATFORM,
    push: false,
    summary: DEFAULT_SUMMARY,
    evidence: DEFAULT_EVIDENCE,
    keepTree: false,
  };
  try {
    // `tokenizeArgs` rather than `argv.includes("--push")` plus a filter. The
    // pair mis-parsed in both directions: `--tag --push` set `push` from a
    // token that was the (missing) VALUE of another flag — silently enabling
    // the one option that publishes to a registry — and the same token was then
    // deleted from the array handed to `parseValueFlags`, shifting the
    // flag/value pairing it saw. The shared tokenizer already owns exactly this
    // grammar: a value flag consumes the next token only when that token is not
    // itself a flag.
    const { flagTokens, bools, positionals } = tokenizeArgs(argv, {
      valueFlags: ["--tag", "--platform", "--summary", "--evidence"],
      boolFlags: ["--push", "--keep-tree"],
      // A single-dash typo must not be silently dropped: `-push` running the
      // whole build and publishing NOTHING with exit 0 is exactly the
      // "unacceptable when the command is destructive" case the shared
      // tokenizer documents this option for.
      rejectStraySingleDash: true,
    });
    // This script takes no positionals; a bare `push` would otherwise be
    // silently discarded, with the same build-without-publishing outcome.
    if (positionals.length > 0) {
      throw new Error(`unexpected argument(s): ${positionals.join(" ")} — every option here is a --flag (see --help)`);
    }
    opts.push = bools.has("--push");
    opts.keepTree = bools.has("--keep-tree");
    parseValueFlags(flagTokens, {
      flags: ["--tag", "--platform", "--summary", "--evidence"],
      help: [HELP],
      onValue: (flag, value) => {
        if (flag === "--tag") opts.tag = value;
        else if (flag === "--platform") opts.platform = value;
        else if (flag === "--summary") opts.summary = path.resolve(value);
        else opts.evidence = path.resolve(value);
      },
    });
  } catch (err) {
    // A bad invocation is fatal-before-the-gates (exit 2). An uncaught throw
    // would exit 1, which the contract reserves for a compliance failure.
    die(2, [err instanceof Error ? err.message : String(err)]);
  }
  // Before ANY action is taken on the value — see TAG_RE.
  if (!TAG_RE.test(opts.tag)) {
    die(2, [
      `--tag ${JSON.stringify(opts.tag)} is not an image reference this script can act on`,
      "want [host[:port]/]path[:tag], lowercase path, no commas, no '=' and no @sha256 digest",
      "a digest reference cannot be tagged or pushed (docker refuses to create one), so it fails here rather than after the ten-minute build",
      "the value is spliced into buildx's comma-separated --output options and baked into /etc/qds-image.json as identity",
    ]);
  }
  return opts;
}

function writeJson(file: string, value: unknown): void {
  // A failed write is fatal-before-the-gates (2), never a compliance failure
  // (1). These calls happen AFTER a successful push, so an unwritable
  // `--summary` path would otherwise report a published, fully compliant image
  // as a licence failure — and the publish workflow's gate step would never
  // run.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    die(2, [
      `cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "every gate passed; this is a fatal I/O failure recording the result, not a compliance failure",
    ]);
  }
}

/**
 * Every `containerimage.digest` a buildx `--metadata-file` reports, keyed by the
 * exporter that reported it (`""` for the flat, single-exporter shape).
 *
 * The gating build declares TWO `--output`s against ONE metadata file, and
 * `meta["containerimage.digest"]` assumed a single flat key describing the
 * `type=image` exporter. It describes whichever exporter buildx decided to
 * report — and on a buildx that NAMESPACES per exporter, the flat key is simply
 * absent and the read failed with a message pointing nowhere. A docker-archive
 * manifest digest recorded as the registry digest is worse: the post-push
 * equality then fails on every push, reporting a build-tooling mismatch in the
 * words of a supply-chain compromise.
 */
export function metadataDigests(meta: Record<string, unknown>): Map<string, string> {
  const found = new Map<string, string>();
  // A scope that two DIFFERENT digests claim is DROPPED, not overwritten.
  // `{ "image.containerimage.digest": A, image: { "containerimage.digest": B } }`
  // writes scope "image" twice and the winner was whatever `Object.entries`
  // yielded last — the caller then resolves the ambiguity silently, in favour
  // of an arbitrary digest, on the one value that becomes the repo pin.
  // Dropping it makes `get("image")` undefined, which routes into the caller's
  // existing "several digests and none attributable" refusal. Fail closed.
  const conflicted = new Set<string>();
  const key = "containerimage.digest";
  const take = (scope: string, v: unknown): void => {
    if (!(typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v))) return;
    const prior = found.get(scope);
    if (prior !== undefined && prior !== v) conflicted.add(scope);
    else found.set(scope, v);
  };
  for (const [k, v] of Object.entries(meta)) {
    if (k === key) take("", v);
    else if (k.endsWith(`.${key}`)) take(k.slice(0, -(key.length + 1)), v);
    else if (typeof v === "object" && v !== null && !Array.isArray(v)) take(k, (v as Record<string, unknown>)[key]);
  }
  for (const scope of conflicted) found.delete(scope);
  return found;
}

/**
 * An already-resolved path, canonicalised for COMPARISON against
 * {@link BUILD_DIR} and {@link REPO_ROOT}.
 *
 * `path.resolve` — all `parseValueFlags` applies to `--summary`/`--evidence` —
 * normalises separators and `..` and NOTHING ELSE. Not case, so on APFS/NTFS
 * `OCI/exedev/Dockerfile` walked past a prefix test and was then deleted
 * case-insensitively by `rmSync`. Not symlinks, so a link outside the tree
 * pointing back into it walked past the same test.
 *
 * The DEEPEST EXISTING ANCESTOR is realpath'd, never the leaf: the output need
 * not exist yet, but the directories on the way to it that DO exist resolve.
 * Only the immediate parent was resolved, which broke the common out-of-repo
 * shape — `--evidence /tmp/df210/run7/evidence.json` names two directories that
 * do not exist yet, so nothing resolved and macOS's `/var` → `/private/var`
 * symlink made the literal path fail a comparison against a realpath'd temp
 * root. A prefix that resolves through nothing still falls back to the literal
 * path, which can only refuse more, never less.
 */
export const CASE_INSENSITIVE_FS = ((): boolean => {
  // PROBED, not inferred from `process.platform`. The platform test was wrong in
  // the dangerous direction: Linux CI with the checkout on a case-insensitive
  // mount (ext4 casefold, a CIFS/NTFS bind) took the case-SENSITIVE arm, so
  // `--evidence /Repo/ROOT/src/providers/exedev/driver.ts` did not start with
  // REPO_ROOT as a string, `outputPathAllowed` accepted it as "outside the
  // repository altogether", and the stale-drop `rmSync` deleted the file
  // holding the digest pin this script exists to feed — the exact scenario the
  // docblock below names. Inodes, not realpath: macOS realpath preserves the
  // spelling it was asked with for the leaf.
  const flip = (s: string): string => (s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase());
  const probe = path.join(path.dirname(REPO_ROOT), flip(path.basename(REPO_ROOT)));
  if (probe === REPO_ROOT) return process.platform === "darwin" || process.platform === "win32";
  try {
    return fs.statSync(probe).ino === fs.statSync(REPO_ROOT).ino;
  } catch {
    return false;
  }
})();

export function canonicalOutputPath(p: string, caseInsensitive: boolean = CASE_INSENSITIVE_FS): string {
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  let dir = path.dirname(p);
  const rest = [path.basename(p)];
  for (;;) {
    try {
      return fold(path.join(fs.realpathSync(dir), ...rest));
    } catch {
      const parent = path.dirname(dir);
      // Hit the filesystem root with nothing resolvable; judge the literal path.
      if (parent === dir) return fold(p);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Whether `--summary`/`--evidence`/the NOTICE may point at `resolved`.
 *
 * POSITIVE, not a denylist of the inputs this script happens to read. That
 * list refused `--evidence oci/exedev/Dockerfile` and PASSED `--evidence
 * src/providers/exedev/driver.ts` — which destroys the file holding the very
 * digest pin this script exists to feed — and `--summary .env` with it. Every
 * output path here is created and DELETED by the run, so an output either sits
 * in this script's own build directory or UNDER THE SYSTEM TEMP DIR; anything
 * else in the working tree is somebody's source file.
 *
 * The second arm is the temp dir, not "outside the repository". "Outside" was
 * positive only with respect to the repo, so `--summary ~/.ssh/known_hosts` or
 * `--evidence ~/.npmrc` passed and the preclean `rmSync`'d it before a single
 * layer was built. This paragraph already SAID "a temp dir" — nothing checked
 * for one. Now it does.
 *
 * `publish-exedev-image.yml` passes `$BUILD_DIR/sweep-summary.json` and
 * `$BUILD_DIR/publish-evidence.json`, and that workflow already asserts its
 * `BUILD_DIR` env equals this module's constant — so CI lands inside the first
 * arm by construction.
 */
export function outputPathAllowed(resolved: string, caseInsensitive: boolean = CASE_INSENSITIVE_FS): boolean {
  const insideOrEqual = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + path.sep);
  const canon = (p: string): string => canonicalOutputPath(p, caseInsensitive);
  const c = canon(resolved);
  return insideOrEqual(c, canon(BUILD_DIR)) || insideOrEqual(c, canon(os.tmpdir()));
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  // Preflight: an absent builder is a fatal-before-the-gates condition, and
  // must say what to install rather than failing three commands later.
  const buildx = spawnSync("docker", ["buildx", "version"], { stdio: "ignore" });
  if (buildx.error || buildx.status !== 0) {
    die(2, [
      "no OCI builder found: `docker buildx version` did not succeed",
      "install Docker Desktop / docker-buildx-plugin (or run this on a CI runner that has it)",
    ]);
  }
  // Same preflight, one layer deeper: buildx being installed says nothing about
  // a builder that can export `type=image`. Done here rather than at the build
  // so a cold host pays the ~35s container start where it reads as setup.
  const builder = ensureReproBuilder();

  // The attribution table is read and validated BEFORE the build: a table with
  // an UNVERIFIED license can never produce a publishable image, and spending
  // a QEMU-emulated exeuntu build to discover that is a waste of ten minutes.
  // Read and parse are their own try — `die` exits the process rather than
  // throwing, so a validation failure must not sit inside a catch that would
  // never see it and would only obscure a real read error.
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(BINARY_LICENSES, "utf8"));
  } catch (err) {
    die(2, [
      `cannot read ${path.relative(REPO_ROOT, BINARY_LICENSES)}: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  // A malformed input FILE is fatal-before-the-gates (2), not a compliance
  // failure (1) — the same distinction the read above draws. `null` and `[]`
  // are both valid JSON that parse cleanly and describe no attribution table.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    die(2, [`${path.relative(REPO_ROOT, BINARY_LICENSES)} is not a JSON object; it cannot carry an attribution table`]);
  }
  // Structural problems exit 2 with the malformed-file check above; only a
  // well-formed table saying something unacceptable is a compliance failure.
  const tableProblems = validateBinaryLicenses(raw, LICENSE_TEXTS);
  if (tableProblems.structural.length > 0) {
    die(2, [
      ...tableProblems.structural,
      `${path.relative(REPO_ROOT, BINARY_LICENSES)} is malformed; that is a bad edit (exit 2), not a licence finding (exit 1)`,
    ]);
  }
  if (tableProblems.compliance.length > 0) die(1, tableProblems.compliance);
  const table = (raw as { entries: BinaryEntry[] }).entries;

  const { inputs, baseRefs, runtimeBaseRef, runtimeBasePinned } = gatherBuildIdInputs(opts.platform);
  const buildId = deriveBuildId(inputs);
  const gitSha = imageSourceSha();
  // The epoch tracks the SAME revision as the gitSha the marker bakes. Passing
  // it explicitly is what keeps the two digest inputs from drifting apart —
  // see `sourceDateEpoch`.
  const epoch = sourceDateEpoch(gitSha);
  // The marker's `builtAt` is the ISO-8601 rendering of SOURCE_DATE_EPOCH, NOT
  // `new Date()`. It is baked into /etc/qds-image.json, so a wall-clock value
  // here changes a layer's bytes on every rebuild and no amount of timestamp
  // rewriting further down can recover the digest.
  const builtAt = new Date(epoch * 1000).toISOString();

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  // Every path below is created AND DELETED by this run, so what may be named
  // is constrained POSITIVELY — see `outputPathAllowed`. The NOTICE is in the
  // list for the COLLISION half only (it is always inside BUILD_DIR):
  // `--summary <NOTICE_PATH>` used to overwrite the published NOTICE after
  // every gate had passed and still report success, and `--summary out.json
  // --evidence out.json` silently lost the summary.
  const outputs: [string, string][] = [
    ["the NOTICE", NOTICE_PATH],
    ["--summary", opts.summary],
    ["--evidence", opts.evidence],
  ];
  const seen = new Map<string, string>();
  for (const [flag, out] of outputs) {
    const c = canonicalOutputPath(out);
    if (!outputPathAllowed(out)) {
      die(2, [
        `${flag} resolves to ${out}, which is neither under ${path.relative(REPO_ROOT, BUILD_DIR)} nor under ${os.tmpdir()}`,
        "every output path here is created and DELETED by this run; naming any other file destroys it (--evidence src/providers/exedev/driver.ts would remove the digest pin this script exists to feed, and --summary ~/.npmrc would remove that)",
        `point it under ${path.relative(REPO_ROOT, BUILD_DIR)} (default: ${path.relative(REPO_ROOT, DEFAULT_SUMMARY)} / ${path.relative(REPO_ROOT, DEFAULT_EVIDENCE)}) or under ${os.tmpdir()}`,
      ]);
    }
    const other = seen.get(c);
    if (other !== undefined) {
      die(2, [
        `${flag} and ${other} both resolve to ${out}`,
        "each is written separately, so two sharing a path means one silently overwrites the other — and the run still reports success",
        "give them distinct paths",
      ]);
    }
    seen.set(c, flag);
  }
  // Every artifact this run would write is dropped FIRST, for the reason the
  // header gives: a build that tripped a gate must leave nothing behind. The
  // NOTICE was already dropped; the summary and the evidence were not, so after
  // a failed run `build-evidence.json` still held the PREVIOUS run's buildId,
  // digest and size — for an image that no longer resolves under the tag — and
  // `tier2-image-contract.live.test.ts` reads that exact default path for AC7c.
  for (const stale of [NOTICE_PATH, opts.summary, opts.evidence]) {
    try {
      fs.rmSync(stale, { force: true });
      // WRITABILITY, PROVEN NOW — before the ten-minute build and, decisively,
      // before `--push`. `writeJson` correctly reports an unwritable
      // `--summary` as fatal (2) rather than a compliance failure, but it runs
      // AFTER the image is already in the registry: the operator gets a
      // published image, a failed run, and no evidence file for the gate step
      // that consumes it. A create-and-drop here moves that failure to the one
      // moment where nothing has been published yet.
      //
      // NO `mkdirSync`. The probe used to create the parent tree recursively
      // and then remove only the probe FILE, so every run — including every
      // failed one — left empty directories behind, contradicting the header's
      // "a failed build leaves nothing behind" that this whole block enforces.
      // A path whose parent does not exist yet is probed one level up instead
      // (`writeJson` mkdirs it for real, later); the create-and-drop still runs
      // wherever the directory already exists, which is CI and the default.
      const parent = path.dirname(stale);
      if (fs.existsSync(parent)) {
        fs.writeFileSync(stale, "");
        fs.rmSync(stale, { force: true });
      } else {
        let nearest = parent;
        while (!fs.existsSync(nearest) && path.dirname(nearest) !== nearest) nearest = path.dirname(nearest);
        fs.accessSync(nearest, fs.constants.W_OK);
      }
    } catch (err) {
      // `force` suppresses ENOENT only. A `--summary` pointing at a directory
      // (EISDIR/EPERM) or a disk fault is fatal-before-the-gates (2); an
      // uncaught throw would exit 1, the code reserved for a compliance
      // failure.
      die(2, [
        `cannot write the artifact path ${stale}: ${err instanceof Error ? err.message : String(err)}`,
        "check that --summary/--evidence name writable FILE paths, not directories",
      ]);
    }
  }
  // "No image artifact is produced" has to mean the tag does not RESOLVE after
  // a failed build, not merely that this run declined to move it — otherwise a
  // bump that trips a gate fails the build and `docker push <tag>` still pushes
  // yesterday's image. Dropping the tag never deletes an image tagged elsewhere.
  spawnSync("docker", ["rmi", "-f", opts.tag], { stdio: "ignore" });
  const stillThere = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", opts.tag], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (stillThere.status === 0) {
    die(2, [
      `${opts.tag} still resolves after dropping it; a failed build would leave it pointing at an older image`,
      `remove the containers holding it (docker ps -a --filter ancestor=${opts.tag}) and re-run`,
    ]);
  }

  // Stale trees are the debris of the deaths no handler can see — SIGKILL,
  // OOM-kill, SIGHUP, power loss. THREE of them, not one, because this script
  // mkdtemps in two places: the `run-*` sibling holding a ~1.6 GB archive
  // inside the docker build context, and under `os.tmpdir()` both
  // `qds-exedev-scan-*` (the one temp tree here whose contents can be a real
  // private key) and `qds-exedev-tree-*` (an extracted Ubuntu filesystem).
  // The scan tree is the REALISTIC leak, not the theoretical one: `scanImage`
  // buffers a whole `docker export | tar` listing at maxBuffer 2 GiB, which is
  // exactly when an OOM-kill arrives — and an OOM-kill runs no handler at all,
  // which is the death class the leak-handler docblock names. The per-run
  // `mkdtempSync` never revisits any of them, so they are swept HERE.
  //
  // Age-gated so a genuinely concurrent run's live directory (the matrix case
  // the per-run design exists for) is not deleted out from under it: an hour is
  // several build lengths, and `stillRunning` below keeps the live directory's
  // mtime honest for the phases that write nothing into it.
  const staleAfterMs = 60 * 60 * 1000;
  const staleRoots: [dir: string, prefix: string, fatal: boolean][] = [
    // BUILD_DIR is the docker build context's parent: an unreadable one is a
    // real problem this run is about to hit again, so it stays
    // fatal-before-the-gates (2) rather than throwing uncaught and exiting 1 —
    // the code this file's header reserves for a COMPLIANCE failure.
    [BUILD_DIR, "run-", true],
    // The system temp dir is NOT ours. Another user's directory we cannot stat,
    // or a tmpfs remounted under us, must not fail a build over debris removal.
    [os.tmpdir(), "qds-exedev-scan-", false],
    [os.tmpdir(), "qds-exedev-tree-", false],
  ];
  for (const [dir, prefix, fatal] of staleRoots) {
    let staleEntries: string[];
    try {
      staleEntries = fs.readdirSync(dir);
    } catch (err) {
      if (!fatal) continue;
      die(2, [
        `cannot list ${path.relative(REPO_ROOT, dir)} to sweep stale run directories: ${err instanceof Error ? err.message : String(err)}`,
        "it is the docker build context's parent; fix its permissions and re-run",
      ]);
    }
    for (const entry of staleEntries) {
      if (!entry.startsWith(prefix)) continue;
      const stale = path.join(dir, entry);
      try {
        // `lstatSync`, and a VANISHED entry is not an error. A concurrent run
        // removing its OWN directory between this readdir and this stat is the
        // matrix case the per-run design exists for, and a dangling symlink
        // named `run-x` reads identically — both used to `die(2)` an otherwise
        // healthy build. `lstat` also keeps a symlink from being followed into
        // a recursive removal it does not describe.
        const st = fs.lstatSync(stale);
        if (!st.isDirectory() || Date.now() - st.mtimeMs < staleAfterMs) continue;
        fs.rmSync(stale, { recursive: true, force: true });
        say(`removed stale ${stale} (left by a run that died uncleanly)\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (!fatal) continue;
        die(2, [
          `cannot sweep the stale run directory at ${stale}: ${err instanceof Error ? err.message : String(err)}`,
          "it sits inside the docker build context; remove it by hand and re-run",
        ]);
      }
    }
  }

  // Per-run, not fixed paths. `exedev.docker.tar` and `build-metadata.json`
  // were shared mutable state across every invocation on the host — and
  // `--platform` is a first-class flag that invites exactly the CI matrix that
  // runs two of them at once. Run A reading run B's metadata lands B's digest
  // in the value the pin gate compares, silently. A fresh directory also
  // removes the pre-clean these two needed, and it is registered for teardown
  // so a `die` between the export and the load does not strand ~1.6 GB.
  //
  // HONESTLY PARTIAL: only the archive and the metadata are per-run. The tag
  // preflight (`docker rmi -f` above), the NOTICE, and the DEFAULT summary and
  // evidence paths are still single-flight shared state — two concurrent runs
  // with default flags will still stomp each other there, so a matrix leg must
  // pass its own --tag/--summary/--evidence. Sharper than "stomp": both legs
  // tag the SAME `DEFAULT_TAG`, both register it in `leaked.tags`, and whichever
  // fails first `docker rmi -f`s it out from under the other, so the survivor's
  // "nothing is tagged locally until every check has passed" quietly becomes
  // "nothing is tagged". Not per-run'd now, on purpose: the live-e2e reader
  // (tier2-image-contract) and the publish workflow both address the default
  // evidence path by name. The BUILDER is no longer in this list —
  // `ensureReproBuilder` tolerates a concurrent create rather than sending the
  // loser to `docker buildx rm` the builder the winner is mid-solve on.
  const runDir = makeTempDir(path.join(BUILD_DIR, "run-"));
  leaked.paths.add(runDir);
  const archive = path.join(runDir, "exedev.docker.tar");
  const metadataFile = path.join(runDir, "build-metadata.json");
  // `dest=${archive}` is spliced into buildx's COMMA-SEPARATED `--output` CSV,
  // the same channel `TAG_RE` guards `name=${opts.tag}` against. A checkout
  // whose absolute path contains `,` or `=` makes everything after it a further
  // exporter attribute — buildx errors out ten minutes into the build, or
  // silently accepts a truncated `dest`. Spaces are fine (this is an argv
  // element, not a shell word), so the boundary is exactly those two characters.
  if (/[,=]/.test(archive)) {
    die(2, [
      `the build directory path contains "," or "=" (${runDir})`,
      "it is spliced into buildx's comma-separated --output options, where either character starts a new exporter attribute",
      "check out this repository at a path without those characters",
    ]);
  }

  /**
   * Every temp root this run owns, kept demonstrably ALIVE for the sweep above.
   * Touched at each phase boundary below, and — critically — immediately before
   * the push.
   *
   * The staleness gate reads the DIRECTORY's mtime, and a directory's mtime
   * moves only when a child is created or removed. The entire gate phase after
   * `docker load` — a full-filesystem export, the tar listing, `sweepImageTree`
   * and two `find / -exec sha256sum` passes over a multi-GB image — writes
   * NOTHING into `runDir`. That comment measures build length; the gates are
   * the other half, and a gate phase longer than `staleAfterMs` made a LIVE run
   * look stale to a concurrently starting one, which then deleted it.
   *
   * ALL of them, not just `runDir`. The sweep has three prefixes and only one
   * got the heartbeat: `treeDir` (`qds-exedev-tree-*`) has its mtime bumped
   * only while `extractNodeModules` creates children in it, so a post-extraction
   * phase over `staleAfterMs` left a LIVE extracted filesystem looking stale to
   * a concurrently starting run — which removed it, and `sweepTree` then blamed
   * the IMAGE for another process's deletion. (`qds-exedev-scan-*` needs no
   * entry: `inspectConfigs` writes a `cfg-i-j` child into it on every single
   * `docker cp`, which is what moves a directory's mtime, and it does not
   * outlive that loop.)
   *
   * Touching the directory rather than dropping a heartbeat FILE: it moves the
   * exact value the sweep reads, and there is no second path to create,
   * register for teardown and clean up. Best-effort — a failed touch can only
   * leave the directory looking stale an hour later, which is where it started.
   */
  const liveDirs: string[] = [runDir];
  const stillRunning = (): void => {
    const now = new Date();
    for (const dir of liveDirs) {
      try {
        fs.utimesSync(dir, now, now);
      } catch {
        // Best effort, by construction — see above.
      }
    }
  };

  /**
   * Everything but the `--output`s, so the gate build and the publish build are
   * the SAME solve by construction rather than by two argv lists someone has to
   * keep in step. Publishing re-invokes this with a pushing output; BuildKit
   * answers it from cache and exports the bytes the gates already read.
   */
  const buildxArgs = (outputs: readonly string[]): string[] => [
    "buildx", "build", "--builder", builder, "-f", DOCKERFILE,
    "--platform", opts.platform,
    ...buildArgList({
      bunVersion: inputs.bunVersion,
      piVersion: inputs.piVersion,
      tag: opts.tag,
      buildId,
      gitSha,
      builtAt,
      epoch,
    }),
    // The tradeoff, named where it is taken (see the header): buildx's default
    // provenance attestation embeds build-time data and wraps the artifact in
    // an index whose digest MOVES between identical builds — measured, two
    // index digests from one --no-cache probe pair. Signed attestation at
    // publish time (`actions/attest-build-provenance`, in
    // publish-exedev-image.yml) restores it without perturbing the pinned
    // digest, and that workflow asserts the non-perturbation rather than
    // asserting these two flags are enough.
    "--provenance=false", "--sbom=false",
    "--metadata-file", metadataFile,
    ...outputs,
    // Build context is the REPO ROOT, matching DF2.9's `oci/Dockerfile`, so
    // COPY paths in this Dockerfile are repo-relative (`oci/exedev/systemd/…`).
    // DF1.10 adds an engine build stage to this same file and will need `src/`
    // in the context; narrowing it to oci/exedev now would force that story to
    // change this script, which is not its region.
    REPO_ROOT,
  ];

  run(
    "docker",
    buildxArgs([
      // Two exports, ONE solve. The archive is loaded below so every gate reads
      // the timestamp-rewritten bytes that will actually ship — gating the
      // pre-rewrite image and shipping the rewritten one would mean the sweep
      // and the credential scan judged an artifact nobody publishes.
      // Deliberately NO `name=` on this one: the tag must not resolve until the
      // gates pass, and `docker load` of a named archive would apply it.
      "--output", `type=docker,dest=${archive},rewrite-timestamp=true`,
      // Not pushed — this export exists to make the manifest digest MEASURABLE
      // on every run. It is written into the builder's own content store and
      // reported through --metadata-file, so a local `bun scripts/…` run can
      // prove two builds agree without a registry to push at.
      "--output", `type=image,name=${opts.tag},rewrite-timestamp=true`,
    ]),
    "docker buildx build",
  );

  // The digest this build WOULD publish, read from the export's metadata rather
  // than from the daemon: the local image id is the config digest (or, under
  // the containerd image store, the manifest digest) and neither is guaranteed
  // to be what a registry resolves. Validated against the `sha256:` shape for
  // the same reason `inspectManifest` validates — a plausible-looking blob
  // recorded as a digest is worse than none.
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
  } catch (err) {
    die(2, [
      `cannot read the build metadata at ${metadataFile}: ${err instanceof Error ? err.message : String(err)}`,
      "buildx writes it with --metadata-file; without it there is no digest to gate on",
    ]);
  }
  // TWO exporters, ONE metadata file — so which one a digest describes has to be
  // decided rather than assumed. The `type=image` export is the registry
  // manifest and the only one the pin can be compared against; the docker
  // archive's manifest digest is not a digest any registry resolves. When
  // buildx reports one digest, there is nothing to disambiguate; when it
  // reports several and none is attributable to the image exporter, this is
  // fatal BEFORE the gates rather than a mismatch reported after the push in
  // the language of a compromise.
  //
  // MEASURED (2026-09-01, the recorded oci/.build/exedev/build-metadata.json
  // from this repo's own buildx): the two-output solve writes ONE flat
  // `containerimage.digest` and no per-exporter key — so the flat arm is the
  // live one today, and it is accepted ON A PUSH RUN ONLY.
  //
  // The asymmetry is the whole point and it is not caution for its own sake.
  // On a `--push` run the registry read-back equality below is what PROVES the
  // flat key described the type=image exporter: a buildx that ever populated
  // it from the DOCKER exporter fails that equality loudly rather than pinning
  // a wrong digest. On a run that does not push, nothing proves it — and the
  // value is written into the evidence JSON as `builtDigest`, which
  // `publish-exedev-image.yml`'s dry arm reads and offers to a human as the
  // pin to commit. An unverified docker-archive manifest digest adopted as a
  // registry pin is a pin naming bytes no registry can ever resolve, so a dry
  // run accepts ONLY an explicitly scoped `image` digest and otherwise records
  // null WITH the reason. Fail-safe: no pin beats a wrong pin.
  const digests = metadataDigests(meta);
  const distinct = new Set(digests.values());
  const scoped = digests.get("image") ?? null;
  // `flat` is the UNSCOPED key, never "the only value in the map". A buildx
  // that namespaces per exporter reports `docker.containerimage.digest` — which
  // `metadataDigests` records under scope `"docker"` — and when that is the
  // only digest, `distinct.size === 1` made it "flat" and a `--push` run
  // adopted the DOCKER ARCHIVE's manifest digest as the pin. The registry
  // read-back then disagreed and the run died with exit 1 saying "the swept,
  // scanned and attributed image is not the image now under the tag": a
  // build-tooling mismatch reported in the words of a supply-chain compromise,
  // which the paragraph above says must never happen. A digest POSITIVELY
  // attributed to a non-image exporter is not unattributed; it is attributed to
  // the wrong one, and it is refused below rather than promoted.
  const unscoped = digests.get("") ?? null;
  const flat = unscoped !== null && distinct.size === 1 ? unscoped : null;
  const builtDigest = scoped ?? (opts.push ? flat : null);
  /** Why {@link builtDigest} is null, recorded in the evidence rather than implied. */
  const builtDigestReason =
    builtDigest !== null
      ? null
      : flat !== null
        ? "this buildx reports one flat containerimage.digest for a two-exporter solve and attributes it to no exporter; without a push there is no registry read-back to prove it describes the type=image export rather than the docker archive, so it is not recorded as a pin"
        : digests.size === 0
          ? `the build wrote no usable containerimage.digest to ${metadataFile}`
          : `the build attributed its containerimage.digest to the ${[...digests.keys()].map((k) => k || "(unscoped)").join(", ")} exporter(s) and none to type=image; only the image exporter's digest is a registry manifest digest`;
  // A PUSH cannot proceed without one: the equality below is the gate, and
  // there is nothing to compare the pushed digest against. A dry run continues
  // and records the reason — the digest is evidence there, not a gate.
  if (builtDigest === null && (opts.push || flat === null)) {
    die(2, [
      builtDigestReason ?? "no usable containerimage.digest",
      `metadata keys: ${Object.keys(meta).join(", ") || "(none)"}`,
      "this solve declares a type=docker and a type=image output; only the latter's digest is the registry manifest digest",
      "this is a build-tooling mismatch (a buildx that reports exporter metadata differently), not a supply-chain finding",
    ]);
  }

  // `docker load` reports the id it stored; parsed rather than derived, because
  // it differs by image store (config digest on the classic store, manifest
  // digest under containerd) and everything below addresses the image by it.
  const loaded = run("docker", ["load", "-q", "-i", archive], "docker load");
  const imageId = loaded.match(/sha256:[0-9a-f]{64}/)?.[0] ?? null;
  if (imageId === null) die(2, [`docker load reported no image id (output: ${loaded.trim() || "empty"})`]);
  // A 1.6 GB archive that has served its purpose; the image is in the daemon.
  fs.rmSync(archive, { force: true });

  // A DISTINCT PREFIX under `--keep-tree`. `qds-exedev-tree-` is one of the
  // three the stale sweep at the top of `main` matches, so the tree the flag
  // exists to preserve was removed by the next run an hour later — with the
  // message "left by a run that died uncleanly", which is the one thing it was
  // not. `qds-exedev-keep-` matches no sweep prefix, so it is the operator's to
  // remove.
  const treeDir = makeTempDir(path.join(os.tmpdir(), opts.keepTree ? "qds-exedev-keep-" : "qds-exedev-tree-"));
  // Not registered under `--keep-tree`: the flag exists to leave the extracted
  // filesystem behind for inspection, and a gate failure — a `die`, which the
  // `finally` below never sees — is exactly when someone wants to inspect it.
  if (!opts.keepTree) leaked.paths.add(treeDir);
  // Heartbeated from here on: the phases after extraction write nothing into
  // it, and a concurrently starting run sweeps anything over an hour old.
  liveDirs.push(treeDir);
  // The SECOND scratch dir — the OpenRig tree's own sweep destination (S1
  // rig_swarm; see mergeSweeps for why the sites are NOT merged into treeDir).
  // Same prefix family as treeDir so the stale sweep reaps a crashed run's
  // leftover, same keepTree escape hatch, same leak registration.
  const openrigDir = makeTempDir(path.join(os.tmpdir(), opts.keepTree ? "qds-exedev-keep-" : "qds-exedev-tree-"));
  if (!opts.keepTree) leaked.paths.add(openrigDir);
  liveDirs.push(openrigDir);
  let sweep: SweepResult;
  let engineSweep: SweepResult = emptySweep();
  try {
    stillRunning();
    const scan = scanImage(imageId);
    stillRunning();
    // The ONLY npm trees this image may ship, by literal path: the engine's
    // runtime closure (yaml+zod, asserted below against the swept tree) and —
    // since S1 rig_swarm — the OpenRig CLI's dependency tree. Declared here
    // because the sweep below filters the observed sites against them before
    // the AC5 narrowing re-derives the same literals for its own gate.
    const enginePath = "opt/qds-factory/node_modules";
    const openrigPath = "opt/openrig/lib/node_modules";
    engineSweep = sweepImageTree(
      imageId,
      scan.nodeModulesSites.filter((s) => s === enginePath),
      treeDir,
    );
    stillRunning();
    const openrigSweep = sweepImageTree(
      imageId,
      scan.nodeModulesSites.filter((s) => s === openrigPath),
      openrigDir,
    );
    stillRunning();
    sweep = mergeSweeps([engineSweep, openrigSweep]);

    // AC5's finding, NARROWED at DF1.10's route change rather than removed.
    //
    // It used to read "any tree at all is a finding", which was right while the
    // engine shipped as a `bun build --compile` ELF: nothing in the image needed
    // a resolver, so a `node_modules` could only be something that crept in. The
    // engine now ships as UNBUNDLED SOURCE (see the route note in
    // oci/exedev/Dockerfile — bundling collapses `import.meta.dir` to one value
    // and the closure has two consumers needing different bases), and unbundled
    // source has to resolve `yaml` and `zod` at run time. A tree at the engine's
    // own path is therefore EXPECTED, and a gate that fails on it would be
    // failing on the delivery route the story chose.
    //
    // The narrowing is by PATH and nothing else, and every other property the
    // gate enforced is untouched: an admitted tree still has to sweep
    // completely, still has to carry zero unreadable/unresolved/missing-text
    // findings (the `failClosed` block below, which this branch falls through
    // to), and still has to be covered by the rendered NOTICE. What changed is
    // WHERE a tree may be, not whether it must be explained.
    //
    // A tree ANYWHERE ELSE is the original finding, unchanged. Adding a
    // permitted site means adding it here deliberately, in the same change
    // that ships whatever needs it — which is the point of a literal set
    // rather than a prefix match or a "starts with /opt" rule that would
    // admit the next tree for free. S1 rig_swarm added the second one: the
    // OpenRig CLI's dependency tree at /opt/openrig/lib/node_modules, swept
    // and NOTICE-attributed like the engine's own, but with NO closure
    // enumeration here — its byte identity is frozen by the Dockerfile's own
    // OPENRIG_TREE_SHA256 content gate (a TOFU ARG pinned at the first real
    // build; see that file's S1 section), and re-enumerating its
    // npm-^resolved package list in this script would be a second, driftier
    // copy of the same pin. Every OTHER property the gate enforces applies
    // to it in full, through the merged sweep: complete sweep, zero
    // denied/unresolved/missing-text findings, NOTICE coverage.
    //
    // PRESENCE, not just placement. An image whose swept `node_modules` site
    // list is EMPTY used to pass this whole block vacuously — no unexpected
    // sites, no closure to check, a clean NOTICE describing no tree — with
    // the only thing standing against it the Dockerfile's own `[ -d … ]`
    // asserts, inside the very file a dropped COPY would be edited in. The
    // absence half now moves with THIS gate too: no site at the engine's path
    // is an image whose engine cannot resolve `yaml` on first import, and
    // that is a compliance failure (exit 1), not a notice.
    if (scan.nodeModulesSites.length === 0 || !scan.nodeModulesSites.includes(enginePath)) {
      die(1, [
        `the built image carries no npm tree at /${enginePath}`,
        // When the sweep DID find trees, they are at wrong sites — the other
        // half of this failure. Naming them here is what stops the operator
        // from fixing only the dropped COPY and re-meeting the rogue tree on
        // the next (QEMU-expensive) build.
        ...(scan.nodeModulesSites.length > 0
          ? [`the scan did find npm tree(s) at: ${scan.nodeModulesSites.map((s) => `/${s}`).join(", ")} — none of these is the engine's permitted site`]
          : []),
        "the engine ships as unbundled source that resolves yaml and zod at run time; an absent closure is the route broken end-to-end, not an empty image that happens to be clean",
        "restore the COPY that lands the engine's runtime closure at that exact path — the Dockerfile's own builder asserts cannot see a dropped final COPY",
      ]);
    }
    // The openrig site's absence gets its own refusal for the same reason:
    // a dropped S1 Dockerfile stage is an image without `rig`, which every
    // in-Dockerfile assertion would have caught only if the stage survived
    // far enough to run them. This is the host-side half of that tripwire.
    if (!scan.nodeModulesSites.includes(openrigPath)) {
      die(1, [
        `the built image carries no npm tree at /${openrigPath}`,
        "the S1 rig_swarm stages install the OpenRig CLI there; an absent tree is a dropped Dockerfile stage, not a smaller image",
        ...(scan.nodeModulesSites.length > 0
          ? [`the scan did find npm tree(s) at: ${scan.nodeModulesSites.map((s) => `/${s}`).join(", ")}`]
          : []),
      ]);
    }
    const unexpected = scan.nodeModulesSites.filter((s) => s !== enginePath && s !== openrigPath);
    if (unexpected.length > 0) {
      const named = sweep.entries.slice(0, 20).map((e) => `${e.name}@${e.version} at /${e.depPath}`);
      // Coverage gaps enrich the finding when the NOTICE machinery can render
      // this tree at all; a tree that cannot be rendered is already the finding.
      let gaps: string[] = [];
      try {
        const notice = renderNotice(sweep, { imageRef: opts.tag, installFlags: NOTICE_INSTALL_FLAGS, sweptAt: builtAt });
        gaps = verifyNoticeCoverage(notice, sweep.uncovered);
      } catch {
        gaps = [];
      }
      die(1, [
        `the built image carries an npm tree at an unexpected site: ${unexpected.map((s) => `/${s}`).join(", ")}`,
        `the only trees this image ships are the engine's runtime closure at /${enginePath} and the OpenRig CLI's dependency tree at /${openrigPath}; anything else is an unswept surface that crept in`,
        "if a new tree is legitimate, add its path to the permitted set in this function, in the same change that ships it",
        `for context, the sweep found ${sweep.treePackageCount} installed copies across every site:`,
        ...named,
        ...(sweep.entries.length > 20 ? [`…and ${sweep.entries.length - 20} more`] : []),
        // DF2.9's own verdicts on that tree, relayed rather than re-derived.
        // Without them the finding reads as "a tree exists" when the actual
        // severity may be "a tree exists AND it carries a package no
        // attribution can cover" — which is a different conversation.
        ...sweep.denied.map((e) => `DENIED: ${e.name}@${e.version} at "${e.depPath}"`),
        ...sweep.pinViolations,
        ...(gaps.length > 0 ? [`unattributed after a NOTICE render: ${gaps.join(", ")}`] : []),
      ]);
    }

    // WHAT is at the permitted site, not merely THAT the site is permitted.
    //
    // The check above asks WHERE a tree is and never how big. C37 narrowed a
    // MERGED story's accepted property (DF2.10 AC5) from "no npm tree at all"
    // to "a tree at this exact path", and the narrowness IS the justification:
    // "unbundled source has to resolve `yaml` and `zod` at run time" is an
    // argument for two packages, not for a directory. A future change copying
    // two hundred packages in here would pass the path check unchanged.
    //
    // The only thing holding "exactly yaml and zod" today is the builder's
    // `[ "$(find /out/qds-factory/node_modules -mindepth 1 -maxdepth 1 | wc -l)"
    // -eq 2 ]` — inside the file that would be doing the changing. Stated here
    // too, against the BUILT image's swept tree rather than against the recipe,
    // so the two have to move together.
    //
    // TOP-LEVEL only, and `depPath` is a DEPENDENCY CHAIN rather than a
    // filesystem path (`license-sweep.ts` builds it as `[...chain,
    // name].join(" > ")`), so a root entry is one with no `>` in it.
    //
    // Transitive dependencies are a different, already-swept and
    // already-attributed fact and are deliberately not counted: `yaml` and
    // `zod` have none today, which is why the builder's count is 2, and if
    // that changes the deeper entries must not trip this while the top-level
    // set stays honest.
    //
    // Read from `engineSweep` — the ENGINE site's own sweep — never the
    // merged `sweep`: /opt/openrig's tree legitimately holds `yaml` and `zod`
    // (and a dozen more) as its own top-level roots, and before the per-site
    // split this check would have counted them as the engine's closure.
    const EXPECTED_ENGINE_CLOSURE = ["yaml", "zod"];
    {
      // The presence gate above already refused an absent tree, so this reads
      // unconditionally — a tree at the engine's path is a fact by this line.
      const closure = [...new Set(engineSweep.entries.filter((e) => !e.depPath.includes(" > ")).map((e) => e.name))].sort();
      if (JSON.stringify(closure) !== JSON.stringify(EXPECTED_ENGINE_CLOSURE)) {
        die(1, [
          `/${enginePath} holds ${closure.length} top-level package(s): ${closure.join(", ") || "<none the sweep could read>"}`,
          `the permitted site is admitted for exactly ${EXPECTED_ENGINE_CLOSURE.join(" and ")} — the engine's unbundled-source runtime closure — and for nothing else`,
          "if the closure genuinely grew, update this set AND the builder's `-eq` count in oci/exedev/Dockerfile in the same change, and say in the PR what the new package resolves",
        ]);
      }
    }

    // DF2.9's OTHER fail-closed signals, which this gate read none of. Each is
    // documented in `license-sweep.ts` as a refusal, not a note: `unreadable`
    // is "package dirs the walk could not read — fail closed rather than skip",
    // `unresolved` is "no license metadata AND no shipped text — fail closed
    // (INV-4)", `missingTexts` is an observed identifier with no canonical text
    // checked in. A tree can be simultaneously PRESENT, unreadable and reported
    // clean, because `treePackageCount` counts only what the walk could parse —
    // so gating on the count alone is a gate with a hole exactly the shape of
    // the thing it is looking for.
    const failClosed = [
      ...sweep.unreadable.map((d) => `unreadable inside the shipped npm tree: ${d}`),
      ...sweep.unresolved.map((e) => `no license metadata and no shipped text: ${e.name}@${e.version} at "${e.depPath}"`),
      ...sweep.missingTexts.map((m) => `no canonical text in oci/license-texts/ for "${m.id}" (${m.packages.length} package(s))`),
    ];
    if (failClosed.length > 0) {
      die(1, [
        "the filesystem sweep could not establish licensing for everything it found:",
        ...failClosed.slice(0, 40),
        ...(failClosed.length > 40 ? [`…and ${failClosed.length - 40} more`] : []),
        "the engine's runtime closure is permitted to ship, but only fully explained; an entry the sweep cannot establish is not a licence this build may publish under",
      ]);
    }

    // The credential gate runs BEFORE the NOTICE is rendered or written. The
    // header's claim is that a build which tripped a gate leaves no artifact
    // behind, and `oci/.build/exedev/NOTICE` is an artifact — freshly written,
    // describing an image that then failed INV-IBOX-1.
    if (scan.findings.length > 0) die(1, scan.findings);

    // The recorded evidence for AC5: a NOTICE generated from the actual
    // exported filesystem, in DF2.9's own format, attributing the engine's
    // shipped runtime closure.
    //
    // `verifyNoticeCoverage` IS A REAL CONTROL AGAIN, and that is a change worth
    // naming. It used to be a structural invariant that could not come back
    // dirty: every path reaching this line had `sweep.uncovered === []`, because
    // an empty tree returned `emptySweep()` and any non-empty one had already
    // died two screens up. The comment said so, and said it was kept only
    // against the day a tree-present path reached here. DF1.10's route change IS
    // that day — the engine's own `node_modules` now reaches this line — so
    // `gaps` can be non-empty and the `die` below is reachable rather than
    // decorative. Nothing about the call changed; what changed is that it now
    // measures something.
    //
    // The render is WRAPPED, like the identical call in the failure branch
    // above and unlike this one until now: an uncaught throw exits 1, the code
    // the contract reserves for a COMPLIANCE failure, so a rendering fault (or
    // an ENOSPC on the write below) had `publish-exedev-image.yml`'s classifier
    // printing a licence diagnosis for a disk fault.
    const notice = ((): string => {
      try {
        return renderNotice(sweep, { imageRef: opts.tag, installFlags: NOTICE_INSTALL_FLAGS, sweptAt: builtAt });
      } catch (err) {
        return die(2, [
          `the NOTICE could not be rendered: ${err instanceof Error ? err.message : String(err)}`,
          "the sweep concluded clean above, so this is a rendering fault, not a licence finding",
        ]);
      }
    })();
    const gaps = verifyNoticeCoverage(notice, sweep.uncovered);
    if (gaps.length > 0) die(1, [`the NOTICE fails to cover: ${gaps.join(", ")}`]);
    // The falsifiable half: the artifact has to DESCRIBE THIS IMAGE. A render
    // that silently produced a template — or one keyed on the wrong meta — is
    // an evidence file that proves nothing, and nothing above can see it.
    if (!notice.includes(opts.tag) || !notice.includes(builtAt)) {
      die(2, [
        "the rendered NOTICE names neither this image ref nor this build's epoch",
        `expected to find ${opts.tag} and ${builtAt} in it; this is a rendering fault, not a licence finding`,
      ]);
    }

    // AC5's negative control. The coverage set is COMPUTED here — built image
    // minus base image — and never read from the table it checks.
    const builtBins = listExecutables(imageId, opts.platform);
    stillRunning();
    // The base is addressed BY DIGEST — the same digest the buildId hashed —
    // rather than by the floating tag the Dockerfile names. `docker run <tag>`
    // uses whatever the local daemon happens to hold, which need not be what
    // this script resolved from the registry or what buildx built against; a
    // negative control that subtracts different bytes is not a control.
    const baseBins = listExecutables(runtimeBasePinned, opts.platform);
    stillRunning();
    // Added by PATH **or by CONTENT**: a path present in both whose bytes
    // differ is a binary this image REPLACED, and replacement is how the most
    // likely unattributed project enters this image (`exeuntu update pi`
    // overwrites the stock pi tree in place). A path-only difference never saw
    // it. Fails only in the direction of "more binaries need attributing".
    const added = [...builtBins].filter(([p, sha]) => baseBins.get(p) !== sha).map(([p]) => p).sort();
    const uncovered = uncoveredBinaries(added, table);
    if (uncovered.length > 0) {
      die(1, [
        `this image adds ${uncovered.length} executable(s) with no entry in oci/exedev/binary-licenses.json:`,
        ...uncovered.map((p) => `/${p}`),
        "add an entry naming the project, its SPDX identifier and how the license was established",
      ]);
    }

    // WRITTEN ONLY NOW, after the LAST gate. `die` is `process.exit` and does
    // not unwind the `finally` below — so writing it before the
    // binary-attribution gate left `oci/.build/exedev/NOTICE` on disk
    // describing an image that was never tagged and never pushed: precisely the
    // artifact the credential gate two screens up is ordered to prevent.
    //
    // And REGISTERED in `leaked.paths` the moment it exists, exactly as the tag
    // is. Ordering alone was not enough: everything after this line — the push,
    // the registry read-back `die(2)`, the digest-equality `die(1)`, both
    // `writeJson` failures — is `process.exit`, and each of them left a NOTICE
    // behind describing an image that was never successfully published. Only
    // the NEXT run's stale-artifact preclean removed it. Deregistered on the
    // success path below, beside the tag.
    try {
      fs.writeFileSync(NOTICE_PATH, notice);
      leaked.paths.add(NOTICE_PATH);
    } catch (err) {
      die(2, [
        `cannot write ${NOTICE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
        "every gate passed; this is a fatal I/O failure recording the result, not a compliance failure",
      ]);
    }

    run("docker", ["tag", imageId, opts.tag], "docker tag");
    // Registered for teardown the moment it exists. Everything below — the
    // push, the registry read-back `die(2)`, the digest-equality `die(1)`, both
    // `writeJson` failures — is `process.exit`, and none of them removed the
    // tag, so a failed run left a resolvable local image and the header's "a
    // failed build leaves no local artifact behind" became untrue at exactly
    // the moment it mattered. Deregistered on the success path only, below.
    leaked.tags.add(opts.tag);

    let digest: string | null = null;
    if (opts.push) {
      // NOT `docker push` of the loaded image. The daemon would re-compress the
      // layers it loaded from an uncompressed archive, and a digest that
      // depends on which daemon version happened to gzip it is not a digest the
      // publish gate can compare against a checked-in pin. Re-invoking the same
      // solve costs nothing — it is a cache hit — and BuildKit pushes the very
      // blobs it already exported above, so the pushed manifest is the gated
      // manifest and the equality below proves it rather than assuming it.
      // The last heartbeat was before `baseBins`; a multi-GB push on a slow
      // uplink can exceed `staleAfterMs` on its own, and buildx writes
      // `--metadata-file` into `runDir` when it finishes. A concurrently
      // starting run that swept `runDir` as stale would make that write fail
      // AFTER the image was already in the registry.
      stillRunning();
      run(
        "docker",
        buildxArgs(["--output", `type=image,name=${opts.tag},rewrite-timestamp=true,push=true`]),
        "docker buildx build --push",
      );
      stillRunning();
      // The pushed MANIFEST digest — the value the repo pin pairs with this
      // buildId, and the value `--image <ref>@sha256:…` would carry. Read back
      // from the registry rather than assumed from the local image id, which is
      // the config digest and is NOT what a pull resolves.
      //
      // Read back from the registry with NO local fallback. The rejected
      // fallback was `{{index .RepoDigests 0}}` off the daemon — but the push
      // was performed by BuildKit, not the daemon, so that entry is by
      // definition whatever the daemon last pulled or pushed under this name.
      // A stale-but-present value passes the null check, fails the equality
      // below, and reports "the swept, scanned and attributed image is not the
      // image now under the tag" — a supply-chain accusation whose actual cause
      // was a registry read that failed. Refusing is the honest answer, and it
      // says which thing failed.
      const readBack = inspectManifest(opts.tag);
      digest = readBack.digest;
      if (digest === null) {
        die(2, [
          `pushed ${opts.tag} but the registry read that confirms its manifest digest FAILED`,
          `docker buildx imagetools inspect could not answer: ${readBack.detail}`,
          "this is a registry/auth/tooling failure, not a digest mismatch",
          "the repo pin cannot be updated from this run; do not record a pin without one",
        ]);
      }
      // Swept is shipped, stated as an equality instead of a paragraph. If the
      // registry resolved something other than what the gated export produced,
      // the artifact under the pin is not the artifact every check above read.
      // A compliance failure (exit 1), not a fatal: the gates concluded, and
      // what they concluded no longer describes what was published.
      if (digest !== builtDigest) {
        die(1, [
          `the pushed digest is not the digest the gates read: ${digest} vs ${builtDigest}`,
          "the swept, scanned and attributed image is not the image now under the tag",
          // The push is a THIRD buildx invocation whose "it is a cache hit"
          // premise is not enforced — cache can be evicted, a shared builder
          // pruned between the two calls — so a cache miss on a layer with any
          // residual non-determinism produces this too. Failing closed is
          // right; accusing the operator of substitution when the cause is a
          // rebuild is not.
          "a cache miss on a non-reproducible layer produces this too — re-run and compare builtDigest across two runs before treating it as substitution",
        ]);
      }
      // SAID NOW, before the two `writeJson`s. An ENOSPC on either of them is
      // realistic at exactly this point (this run has since written a ~1.6 GB
      // archive and extracted a whole Ubuntu filesystem), `writeJson` correctly
      // `die(2)`s with only the path and the errno, and the local tag is then
      // reclaimed by the leak handler — leaving the operator with a published
      // image, no evidence file and no digest anywhere. The one value the whole
      // run exists to produce was the one value not reported on that path.
      say(`pushed digest: ${digest}\n`);
    }

    // `null`, never `0`, when the size could not be measured. Image size is one
    // of the ADR's two named re-opening falsifiers, and this very file defines
    // `0` fourteen lines down as "a field never evaluated" — so collapsing a
    // failed `docker image inspect` into 0 records an un-measurement as a
    // legitimate measurement, on the one field whose whole purpose is
    // falsification. `Number(non-numeric)` is NaN, which `JSON.stringify`
    // writes as `null` anyway; this makes that deliberate rather than accidental.
    const sizeOf = (ref: string): number | null => {
      const n = Number(tryRun("docker", ["image", "inspect", "--format", "{{.Size}}", ref]));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const summary: SweepSummary & { buildId: string; imageDigest: string | null } = {
      ...summarize(
        sweep,
        { imageRef: opts.tag, installFlags: NOTICE_INSTALL_FLAGS, sweptAt: builtAt },
        Buffer.byteLength(notice),
        0,
      ),
      buildId,
      imageDigest: digest,
    };
    writeJson(opts.summary, summary);

    writeJson(opts.evidence, {
      story: "DF2.10",
      imageRef: opts.tag,
      buildId,
      gitSha,
      builtAt,
      platform: opts.platform,
      // The reproducibility evidence: the epoch every layer mtime and the
      // marker were pinned to, the builder that exported them, and the manifest
      // digest the build produced BEFORE any push. Two runs of this script that
      // report the same `builtDigest` are the proof; a run that does not record
      // it leaves the claim unfalsifiable.
      sourceDateEpoch: epoch,
      builder,
      builtDigest,
      // WHY there is no `builtDigest`, when there is none. A consumer offering
      // this value to a human as a pin to commit (the dry arm of
      // publish-exedev-image.yml does exactly that) must be able to tell "this
      // buildx does not attribute the digest to an exporter, and nothing
      // proved it without a push" from "the build failed to measure" — null
      // alone says neither. Null on the happy path, a sentence otherwise.
      builtDigestReason,
      // The flat digest a DRY run measured, kept OUT of `builtDigest` and named
      // for what it is. With today's buildx (one flat key, no per-exporter
      // scope) `builtDigest` is null on every non-push run, so the docblock's
      // "two runs of this script that report the same builtDigest are the
      // proof" was unprovable without a registry — the exact reproducibility
      // claim the second `--output` exists to make locally checkable. This
      // field is comparable across two dry runs and is NEVER a pin: nothing
      // proved which exporter it describes.
      unverifiedFlatDigest: builtDigest === null ? flat : null,
      // Which shape the pin actually took (AC1a/AC1b). A run that did not push
      // has no digest to pin, and says so rather than implying one.
      pinShape: digest === null ? "local-tag-only (not published by this run)" : "digest",
      imageDigest: digest,
      baseRefs,
      runtimeBaseRef,
      baseDigests: inputs.baseDigests,
      bunVersion: inputs.bunVersion,
      piVersion: inputs.piVersion,
      // AC7c + the ADR's two named re-opening falsifiers. RECORDED, never
      // asserted against an invented ceiling (Technical Notes, explicit):
      // unrecorded means unfalsifiable, but a made-up ceiling means a build
      // that fails for a reason nobody measured.
      imageSizeBytes: sizeOf(opts.tag),
      baseImageSizeBytes: sizeOf(runtimeBasePinned),
      // The two sizes above are MEASURED here. The cold boot is not, and
      // cannot be: this script builds an image, it cannot boot a box. Per the
      // Observability Contract a field never evaluated reports 0 — but a bare
      // `0` in an artifact the publish workflow UPLOADS reads as a measurement
      // to any consumer that does not know the convention, and the DoD asks
      // this file to record the cold-boot time. So the sentinel says so IN THE
      // ARTIFACT rather than only in this comment, and names where the real
      // number lives. The encoding is unchanged (still 0); what changed is
      // that a reader of the JSON alone can now tell a sentinel from a
      // measurement.
      coldBootMs: 0,
      coldBootMeasuredBy: "not measured here — a build cannot boot a box; 0 is the Observability Contract's never-evaluated sentinel",
      coldBootSource: "tests/fleet/e2e/tier2-image-contract.live.test.ts (live e2e round; it reads this file and boots the pinned digest)",
      // These three are STRUCTURALLY CONSTANT on every path that reaches this
      // write — `treePackageCount > 0` and `findings.length > 0` both `die(1)`
      // above, and a non-empty `nodeModulesSites` implies one of them. They are
      // the gate's verdict, not its evidence, and a reader cannot tell
      // "scanned and found nothing" from "recorded a constant" out of them.
      sweptPackageCount: sweep.treePackageCount,
      nodeModulesSites: scan.nodeModulesSites,
      credentialFindings: scan.findings.length,
      // …so the counts that VARY are recorded beside them. A zero in any of
      // these is a broken probe rather than a clean scan, which is a claim a
      // reader of the JSON alone can now falsify.
      historyLinesScanned: scan.historyLinesScanned,
      filesystemPathsScanned: scan.pathsScanned,
      credentialCandidatesInspected: scan.pathsInspected,
      builtExecutableCount: builtBins.size,
      baseExecutableCount: baseBins.size,
      addedBinaries: added,
      attributedBinaries: table.flatMap((e) => e.names),
    });

    say(
      `tagged ${opts.tag} (${imageId})\n` +
        `buildId: ${buildId}\n` +
        // `builtDigestReason` rather than the literal string `null`: with
        // today's buildx a dry run records no pin, and `digest: null` on stdout
        // with no hint that the evidence explains why reads as a failure.
        `digest:  ${builtDigest ?? `(none — ${builtDigestReason ?? "unrecorded"})`}${digest === null ? " (built, not pushed)" : " (pushed, registry agrees)"}\n` +
        `epoch:   ${epoch} (${builtAt})\n` +
        `swept:   ${sweep.treePackageCount} npm packages · added binaries: ${added.length}\n` +
        `NOTICE:  ${NOTICE_PATH}\nsummary: ${opts.summary}\nevidence: ${opts.evidence}\n`,
    );
    // Every gate passed and every artifact is written: the tag and the NOTICE
    // are the intended OUTPUT now, not leaks. Deregistered here and nowhere
    // else, so every path that does not reach this line still removes them.
    leaked.tags.delete(opts.tag);
    leaked.paths.delete(NOTICE_PATH);
  } finally {
    // NOTHING here may replace the in-flight error. An EACCES/EBUSY/ENOTEMPTY
    // from `rmSync` used to propagate out of the `finally` and REPLACE the
    // exception that was already unwinding — so an operator saw a filesystem
    // error for a licence-gate crash — and an uncaught throw from here exits
    // 1, the code this file reserves for a compliance failure. A path that
    // could not be removed simply stays registered in `leaked.paths`, where
    // the exit handler retries it: the sweep is the backstop, not this.
    const drop = (p: string): void => {
      try {
        fs.rmSync(p, { recursive: true, force: true });
        leaked.paths.delete(p);
      } catch {
        // Left registered on purpose — see above.
      }
    };
    drop(runDir);
    if (!opts.keepTree) {
      drop(treeDir);
      drop(openrigDir);
    } else {
      say(`kept extracted trees at ${treeDir} and ${openrigDir}\n`);
    }
  }
}

// Guarded so `deriveBuildId`, `parseBaseRefs`, `resolveRuntimeBaseRef`,
// `readBunPin`, `dockerfileArgDefaults`, `nodeModulesRoot`, `tarUnescape`,
// `judgeCandidateDir`, `redactAssignments`, `repoDigestFor`, `metadataDigests`,
// `validateBinaryLicenses` and `uncoveredBinaries` can be unit-tested by
// importing this module; running the script directly is unaffected. The leak
// handlers are registered inside the same guard: importing must install NOTHING
// process-wide.
if (import.meta.main) {
  installLeakHandlers();
  main();
}
