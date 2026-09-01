#!/usr/bin/env bun
/**
 * Factory-owned exe.dev boot image build (story DF2.10).
 *
 * DF2.9's `build-image.ts` builds the ENTERPRISE image: a `node:22-slim` tree
 * with a real `node_modules` to sweep. This builds the HOSTED-tier boot image:
 * derived `FROM` exeuntu, systemd inside, pi as a compiled ELF, and — by
 * design — no npm tree at all. Same gates, different substrate, so the shape
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
 * Nothing is tagged until every check has passed, so a build that tripped a
 * gate leaves no artifact behind.
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
import { exitWithFailure, parseValueFlags } from "./lib/cli-args.ts";
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

const DEFAULT_TAG = "ghcr.io/biospark33/qds-exedev:local";
const DEFAULT_PLATFORM = "linux/amd64";

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

// ────────────────────────────── reproducibility ──────────────────────────────

/**
 * The build's notion of "now": SOURCE_DATE_EPOCH, honoured from the
 * environment when set and derived from the HEAD COMMIT TIMESTAMP when not.
 *
 * Honouring an externally-set value is the standard's contract, not a
 * convenience — a caller rebuilding an older revision (or a distro rebuilder
 * reproducing our published digest) sets it, and a script that overrode it
 * with its own git read would make that reproduction impossible.
 *
 * The fallback is `git log -1 --format=%ct` rather than `Date.now()` because
 * the value has to be a function of the SOURCE, exactly like the buildId one
 * screen down. Two consequences worth knowing rather than discovering:
 *   * an uncommitted edit keeps the previous commit's epoch. That is correct —
 *     the epoch tracks the revision, and two builds of the same dirty tree
 *     still agree, which is what the digest equality needs;
 *   * a shallow CI checkout still has HEAD, so this works under
 *     `actions/checkout` with the default fetch-depth.
 *
 * No wall-clock fallback exists on purpose. If neither source can answer, the
 * build stops: silently substituting `Date.now()` would produce an image that
 * looks reproducible, passes every gate, and pushes a different digest every
 * time — the precise failure this function exists to remove.
 */
function sourceDateEpoch(): number {
  // 11 digits caps at year 5138 and refuses milliseconds, which is the actual
  // mistake people make here (a JS `Date.now()` pasted into the env reads as a
  // date in the year 58000 and every layer mtime lands there).
  const wellFormed = /^[0-9]{1,11}$/;
  const fromEnv = process.env.SOURCE_DATE_EPOCH?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!wellFormed.test(fromEnv)) {
      die(2, [
        `SOURCE_DATE_EPOCH=${JSON.stringify(fromEnv)} is not a plain UNIX second count`,
        "unset it to fall back to the HEAD commit timestamp, or set it to seconds (not milliseconds)",
      ]);
    }
    return Number(fromEnv);
  }
  const fromGit = tryRun("git", ["-C", REPO_ROOT, "log", "-1", "--format=%ct"]);
  if (fromGit === null || !wellFormed.test(fromGit)) {
    return die(2, [
      "cannot read the HEAD commit timestamp (git log -1 --format=%ct)",
      "the build would not be reproducible without it; set SOURCE_DATE_EPOCH explicitly to proceed",
    ]);
  }
  return Number(fromGit);
}

/**
 * Ensures {@link REPRO_BUILDER} exists and is running, and returns its name.
 *
 * Detect-then-create rather than create-and-ignore-the-error: a `create` that
 * failed for a real reason (no network to pull moby/buildkit, a broken docker
 * context) must say so here, where the message can name it, instead of turning
 * into an unexplained "no builder qds-repro" three commands later.
 *
 * `--bootstrap` on the inspect is load-bearing on a cold host: the builder can
 * exist as a stopped container, and a build against it would otherwise pay the
 * start-up cost inside the step whose duration everyone reads as the build.
 */
function ensureReproBuilder(): string {
  const present = spawnSync("docker", ["buildx", "inspect", "--bootstrap", REPRO_BUILDER], { stdio: "ignore" });
  if (present.status === 0) return REPRO_BUILDER;
  const created = spawnSync(
    "docker",
    ["buildx", "create", "--name", REPRO_BUILDER, "--driver", "docker-container", "--bootstrap"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (created.error || created.status !== 0) {
    die(2, [
      `could not create the "${REPRO_BUILDER}" docker-container builder`,
      "it is required for --output type=image,rewrite-timestamp=true; the default docker driver cannot export it",
      `create it by hand and re-run: docker buildx create --name ${REPRO_BUILDER} --driver docker-container --bootstrap`,
    ]);
  }
  return REPRO_BUILDER;
}

// ───────────────────────────── buildId derivation ─────────────────────────────

export interface BuildIdFile {
  /** Stable name for the file, used as the framing label. */
  name: string;
  bytes: string;
}

export interface BuildIdInputs {
  /** Every base image this Dockerfile derives from, as `sha256:…` digests. */
  baseDigests: readonly string[];
  bunVersion: string;
  piVersion: string;
  dockerfile: string;
  /** The `oci/exedev/systemd/` assets, in any order. */
  systemdFiles: readonly BuildIdFile[];
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
 */
export function deriveBuildId(inputs: BuildIdInputs): string {
  const h = createHash("sha256");
  const field = (label: string, value: string): void => {
    h.update(`${label}:${Buffer.byteLength(value)}\n`);
    h.update(value);
    h.update("\n");
  };
  // Sorted so the hash is a function of the SET of inputs, not of the order the
  // filesystem or the Dockerfile happened to hand them over in.
  for (const d of [...inputs.baseDigests].sort()) field("base", d);
  field("bun", inputs.bunVersion);
  field("pi", inputs.piVersion);
  field("dockerfile", inputs.dockerfile);
  for (const f of [...inputs.systemdFiles].sort((a, b) => a.name.localeCompare(b.name))) {
    field(`systemd/${f.name}`, f.bytes);
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
 */
export function parseBaseRefs(dockerfile: string): string[] {
  const stages = new Set<string>();
  const refs: string[] = [];
  for (const rawLine of dockerfile.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^FROM\s+(.+)$/i);
    if (!m) continue;
    // `--platform=…` and any future FROM flag are dropped; the first remaining
    // token is the reference, and an `AS <name>` suffix declares a stage.
    const tokens = m[1]!.split(/\s+/).filter((t) => !t.startsWith("--"));
    const ref = tokens[0];
    if (!ref) continue;
    const asIdx = tokens.findIndex((t) => /^AS$/i.test(t));
    if (asIdx > 0 && tokens[asIdx + 1]) stages.add(tokens[asIdx + 1]!.toLowerCase());
    if (ref.toLowerCase() === "scratch") continue;
    if (stages.has(ref.toLowerCase())) continue;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * The MANIFEST digest a registry reference resolves to, or null.
 *
 * `--format '{{.Manifest.Digest}}'` looks right and is a trap: on Docker
 * 28.4.0 imagetools SILENTLY IGNORES that template and prints its default
 * multi-line human report instead, so a caller that trusted it would take a
 * plausible-looking blob for a digest. `{{json .Manifest}}` is honoured, and
 * the result is validated against the `sha256:` shape either way — this value
 * becomes half of the repo pin, so a wrong one is worse than none.
 */
function manifestDigest(ref: string): string | null {
  const raw = tryRun("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"]);
  if (raw === null) return null;
  try {
    const digest = (JSON.parse(raw) as { digest?: unknown }).digest; /* dp:ok inside try/catch, and the value is shape-validated before return */
    return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/** `sha256:…` for a reference, from the ref itself or from the registry. */
function resolveBaseDigest(ref: string): string {
  const pinned = ref.match(/@(sha256:[0-9a-f]{64})$/);
  if (pinned) return pinned[1]!;
  // A `${VAR}` in a FROM would make the buildId a hash of a template rather
  // than of a substrate. Refuse rather than resolve something else later.
  if (ref.includes("$")) {
    die(2, [
      `the base reference "${ref}" is not literal; the buildId cannot pin a templated FROM`,
      "pin the base by digest (FROM <ref>@sha256:…) in oci/exedev/Dockerfile",
    ]);
  }
  const viaRegistry = manifestDigest(ref);
  if (viaRegistry !== null) return viaRegistry;
  const local = tryRun("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", ref]);
  const fromLocal = local?.match(/@(sha256:[0-9a-f]{64})$/);
  if (fromLocal) return fromLocal[1]!;
  return die(2, [
    `cannot resolve ${ref} to a digest — the buildId would not be reproducible`,
    "pull the base (or log in to its registry) and re-run, or pin it by digest in the Dockerfile",
  ]);
}

/** The repo's own bun pin (AC2): the runtime the tests ran on, not an install measurement. */
export function readBunPin(pkgJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkgJson); /* dp:ok inside try/catch; the catch below is the handler */
  } catch {
    return die(2, ["package.json is not parseable; cannot read the bun pin"]);
  }
  const pm = (parsed as { packageManager?: unknown }).packageManager;
  const m = typeof pm === "string" ? pm.match(/^bun@(\d[\w.+-]*)$/) : null;
  if (!m) {
    return die(2, [
      `package.json "packageManager" must pin bun (saw ${JSON.stringify(pm)})`,
      "AC2: the in-box engine runs the runtime the tests ran on, so the pin has one source",
    ]);
  }
  return m[1]!;
}

/** Reads every buildId input off disk, failing closed on a missing asset. */
function gatherBuildIdInputs(): { inputs: BuildIdInputs; baseRefs: string[]; runtimeBaseRef: string } {
  if (!fs.existsSync(DOCKERFILE)) {
    die(2, [
      `no Dockerfile at ${path.relative(REPO_ROOT, DOCKERFILE)}`,
      "DF2.10 authors it alongside this script; it is not optional input",
    ]);
  }
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");

  let systemdNames: string[];
  try {
    systemdNames = fs.readdirSync(SYSTEMD_DIR).filter((f) => !f.startsWith(".")).sort();
  } catch {
    return die(2, [`no systemd assets at ${path.relative(REPO_ROOT, SYSTEMD_DIR)}`]);
  }
  if (systemdNames.length === 0) {
    die(2, [`${path.relative(REPO_ROOT, SYSTEMD_DIR)} is empty; the unit template and tmpfiles conf must ship in the image`]);
  }
  const systemdFiles = systemdNames.map((name) => ({
    name,
    bytes: fs.readFileSync(path.join(SYSTEMD_DIR, name), "utf8"),
  }));

  const baseRefs = parseBaseRefs(dockerfile);
  if (baseRefs.length === 0) die(2, ["oci/exedev/Dockerfile declares no FROM the buildId could pin"]);
  const baseDigests = baseRefs.map(resolveBaseDigest);

  return {
    inputs: {
      baseDigests,
      bunVersion: readBunPin(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")),
      piVersion: PI_VERSION,
      dockerfile,
      systemdFiles,
    },
    baseRefs,
    // The LAST non-stage FROM is the runtime base — the image whose executables
    // the added-binary diff subtracts. An earlier stage's binaries that get
    // COPY'd into the runtime SHOULD read as added, and do.
    runtimeBaseRef: baseRefs[baseRefs.length - 1]!,
  };
}

// ─────────────────────────── filesystem + credentials ───────────────────────────

interface ImageScan {
  /** INV-IBOX-1 findings; non-empty means exit 1. */
  findings: string[];
  /** Distinct `…/node_modules` roots observed in the exported filesystem. */
  nodeModulesSites: string[];
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
 * `-L` also CLOSES a hole rather than opening one: the dangling host symlink it
 * replaces was an absolute in-container path, so a config symlinked to
 * `/etc/passwd` would have had the HOST's file read and judged in its place.
 * With `-L` docker resolves the link inside the container, which is the only
 * resolution that answers the question this gate asks. Content judgement is
 * unchanged — `configLooksLikeCredential` still decides, so a public CA cert
 * (`BEGIN CERTIFICATE`) reads clean and a real `BEGIN … PRIVATE KEY` still
 * fires, wherever the link pointed.
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
 * depends on who ran it. Both spellings are tried and the finding is raised
 * only if EVERY one fails, so fail-closed is preserved exactly — this widens
 * how the file is ASKED for, never what counts as clean. Deliberately not an
 * unconditional `.normalize("NFC")`: a name genuinely stored decomposed would
 * then be mangled in the other direction and fail closed on a Linux host.
 */
function inspectConfigs(cid: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qds-exedev-scan-"));
  const findings: string[] = [];
  try {
    for (const [i, p] of paths.entries()) {
      const dest = path.join(scratch, `cfg-${i}`);
      let text: string | null = null;
      // Both Unicode spellings of the same name, deduped so the common
      // all-ASCII case still makes exactly one `docker cp` call.
      for (const variant of new Set([p, p.normalize("NFC")])) {
        const cp = spawnSync("docker", ["cp", "-L", `${cid}:/${variant}`, dest], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (cp.status !== 0) continue;
        try {
          text = fs.readFileSync(dest, "utf8");
          break;
        } catch {
          // Fall through to the next spelling rather than concluding here.
        }
      }
      if (text === null) {
        findings.push(`could not read /${p} to check it for credentials — treating as a finding`);
        continue;
      }
      if (configLooksLikeCredential(text)) findings.push(`credential inside /${p}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return findings;
}

/** The `…/node_modules` root an exported-tar entry sits under, if any. */
export function nodeModulesRoot(entry: string): string | null {
  const idx = entry.indexOf("node_modules/");
  if (idx < 0) return null;
  // Must sit on a path boundary: `my_node_modules/x` is not an npm tree.
  if (idx > 0 && entry[idx - 1] !== "/") return null;
  return entry.slice(0, idx + "node_modules".length);
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
  for (const line of history.split("\n")) {
    if (SECRET_ENV.test(line)) findings.push(`layer history bakes a secret-shaped value: ${line.trim()}`);
  }

  const sites = new Set<string>();
  const cid = run("docker", ["create", imageId], "docker create (scan)").trim();
  try {
    // `docker export` streams the FLATTENED filesystem; tar lists it without
    // unpacking a whole Ubuntu onto the host. Known limit, inherited from
    // DF2.9: a secret written in one RUN and deleted in a later one survives in
    // the layer tarball but is invisible here. The history scan above catches
    // the ENV/ARG shape of that leak.
    // `pipefail` is required — `tar -tf -` exits 0 as soon as it reads an
    // end-of-archive marker, so a failed export would otherwise pass vacuously.
    const listing = spawnSync("bash", ["-c", `set -o pipefail; docker export ${shQuote(cid)} | tar -tf -`], {
      encoding: "utf8",
      maxBuffer: 2048 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (listing.status !== 0) die(2, ["docker export | tar failed while scanning the built filesystem"]);
    // `pipefail` above catches a FAILED export. It does not catch an export
    // that succeeds and yields nothing — and that case is worse, because the
    // loop below would then classify zero paths and INV-IBOX-1 would report
    // clean over an empty set. A vacuous pass on a credential gate is the one
    // outcome that must never look like a green one.
    const entries = (listing.stdout ?? "").split("\n").filter((e) => e.length > 0); /* dp:ok emptiness is fatal immediately below — a vacuous scan cannot pass */
    if (entries.length === 0) {
      die(2, [
        "docker export | tar exited 0 but listed no paths in the built filesystem",
        "no real image has an empty filesystem, so this is a broken probe, not a clean scan",
      ]);
    }
    const inspect: string[] = [];
    for (const entry of entries) {
      if (!entry || entry.endsWith("/")) continue;
      const site = nodeModulesRoot(entry);
      if (site !== null) sites.add(site);
      const verdict = classifyScanPath(entry);
      if (verdict === "credential") findings.push(`credential in the image: /${entry}`);
      else if (verdict === "inspect") inspect.push(entry);
    }
    findings.push(...inspectConfigs(cid, inspect));
  } finally {
    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
  }
  // Only the SHALLOWEST root per tree: nested `node_modules` come along with
  // their parent when it is copied out.
  const roots = [...sites].sort();
  const nodeModulesSites = roots.filter((s) => !roots.some((r) => r !== s && s.startsWith(`${r}/`)));
  return { findings, nodeModulesSites };
}

/** Copies every observed npm tree out of the image so the sweep can read it. */
function extractNodeModules(imageId: string, sites: readonly string[], dest: string): void {
  const cid = run("docker", ["create", imageId], "docker create (tree)").trim();
  try {
    const nm = path.join(dest, "node_modules");
    for (const [i, site] of sites.entries()) {
      if (i === 0) run("docker", ["cp", `${cid}:/${site}`, nm], `docker cp /${site}`);
      // Every further site merges INTO the same directory (`/.` copies contents
      // rather than the directory itself). Name collisions across sites do not
      // matter: any package at all on this image is already the finding.
      else run("docker", ["cp", `${cid}:/${site}/.`, `${nm}/`], `docker cp /${site}`);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
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
 * AC5. The sweep runs over the built image's exported filesystem, so what was
 * swept is what ships — there is no second tree to disagree with, and no
 * `ARG DEPS_IMAGE` binding needed to prove it.
 *
 * On THIS image the expected result is zero packages, and `walkTree` THROWS on
 * an absent tree by design (DF2.9: an absent tree must never read as a
 * vacuously clean sweep). Here that throw is the HEALTHY path, so it is caught
 * narrowly — by the condition, not by swallowing every error — and recorded as
 * a count of 0. Any other failure still propagates.
 */
function sweepImageTree(imageId: string, sites: readonly string[], treeDir: string): SweepResult {
  if (sites.length > 0) extractNodeModules(imageId, sites, treeDir);
  try {
    return sweepTree({ treeRoot: treeDir, licenseTextsDir: LICENSE_TEXTS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nothing to sweep/.test(msg)) return emptySweep();
    return die(2, [`the filesystem sweep could not conclude: ${msg}`]);
  }
}

// ─────────────────────────── compiled-binary attribution ───────────────────────────

interface BinaryEntry {
  names: string[];
  project: string;
  spdxId: string;
  copyright: string;
  licenseUrl: string;
  verifiedHow: string;
  bundled?: { component?: string; spdxId?: string; url?: string; note?: string }[];
}

/**
 * Structural + substantive validation of `binary-licenses.json`. Every entry
 * must name a license this repo can actually reproduce (DF2.9's own resolver
 * against `oci/license-texts/`), and the sentinel `UNVERIFIED` is a FAILURE
 * rather than a warning: it exists so an unestablished license is recorded
 * honestly instead of guessed at, and a guess that ships is worse than a build
 * that stops.
 */
export function validateBinaryLicenses(raw: unknown, licenseTextsDir: string): string[] {
  const problems: string[] = [];
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return ["oci/exedev/binary-licenses.json carries no entries; it cannot attribute anything"];
  }
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  for (const [i, e] of entries.entries()) {
    const at = `entry ${i}`;
    const entry = e as Partial<BinaryEntry>;
    if (!Array.isArray(entry.names) || entry.names.length === 0 || !entry.names.every(nonEmpty)) {
      problems.push(`${at}: "names" must list at least one binary basename`);
    }
    for (const field of ["project", "spdxId", "copyright", "licenseUrl", "verifiedHow"] as const) {
      if (!nonEmpty(entry[field])) problems.push(`${at}: "${field}" is required and must be non-empty`);
    }
    const id = nonEmpty(entry.spdxId) ? entry.spdxId.trim() : null;
    if (id === "UNVERIFIED") {
      problems.push(
        `${at} (${entry.project ?? "?"}): license recorded as UNVERIFIED — establish it upstream before publishing`,
      );
    } else if (id !== null && resolveLicenseText(id, licenseTextsDir) === null) {
      problems.push(`${at} (${entry.project ?? "?"}): no canonical text in oci/license-texts/ for "${id}"`);
    }
    // A bundled disclosure with no pointer is a stub that reads as diligence.
    for (const [j, b] of (entry.bundled ?? []).entries()) {
      if (!nonEmpty(b?.component) || !nonEmpty(b?.url) || !nonEmpty(b?.note)) {
        problems.push(`${at}, bundled ${j}: "component", "url" and "note" are all required`);
      }
    }
  }
  return problems;
}

/**
 * Executables in an image, by absolute path with no leading slash.
 *
 * Read with `find` inside the image rather than by parsing `tar -tv`: the
 * verbose tar listing's column layout differs between GNU tar and bsdtar and
 * shifts again for files older than six months (a year replaces the clock), so
 * a parser over it is a silent-misparse surface — and a scan that silently
 * finds no executables would report "nothing was added" on an image carrying an
 * unattributed binary, which is the exact failure AC5 exists to prevent. An
 * empty result is therefore fatal, not clean.
 */
function listExecutables(ref: string, platform: string): Set<string> {
  const res = spawnSync(
    "docker",
    [
      "run", "--rm", "--platform", platform, "--network", "none", "--user", "0:0",
      // exeuntu's entrypoint is `init` (systemd); overridden because this needs
      // a filesystem listing, not a booted machine.
      "--entrypoint", "/usr/bin/find", ref,
      // `-xdev` keeps /proc, /sys and /dev — separate mounts in a container —
      // out of the listing.
      "/", "-xdev", "-type", "f", "-perm", "-u+x", "-print",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (res.error) die(2, [`docker run find on ${ref}: ${res.error.message}`]);
  const out = (res.stdout ?? "") /* dp:ok emptiness is fatal below: no real image has zero executables */
    .split("\n")
    .map((l) => l.trim().replace(/^\//, ""))
    .filter((l) => l.length > 0);
  if (out.length === 0) {
    die(2, [
      `enumerating executables in ${ref} produced nothing (find exited ${res.status ?? "on a signal"})`,
      "no real Linux image has zero executables, so this is a broken probe, not a clean one",
    ]);
  }
  return new Set(out);
}

/** Added binaries with no entry covering their basename (AC5's failure). */
export function uncoveredBinaries(added: readonly string[], entries: readonly BinaryEntry[]): string[] {
  const covered = new Set(entries.flatMap((e) => e.names));
  return added.filter((p) => !covered.has(path.basename(p)));
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
    push: argv.includes("--push"),
    summary: DEFAULT_SUMMARY,
    evidence: DEFAULT_EVIDENCE,
    keepTree: argv.includes("--keep-tree"),
  };
  try {
    parseValueFlags(
      argv.filter((a) => a !== "--push" && a !== "--keep-tree"),
      {
        flags: ["--tag", "--platform", "--summary", "--evidence"],
        help: [HELP],
        onValue: (flag, value) => {
          if (flag === "--tag") opts.tag = value;
          else if (flag === "--platform") opts.platform = value;
          else if (flag === "--summary") opts.summary = path.resolve(value);
          else opts.evidence = path.resolve(value);
        },
      },
    );
  } catch (err) {
    // A bad invocation is fatal-before-the-gates (exit 2). An uncaught throw
    // would exit 1, which the contract reserves for a compliance failure.
    die(2, [err instanceof Error ? err.message : String(err)]);
  }
  return opts;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
  const tableProblems = validateBinaryLicenses(raw, LICENSE_TEXTS);
  if (tableProblems.length > 0) die(1, tableProblems);
  const table = (raw as { entries: BinaryEntry[] }).entries;

  const { inputs, baseRefs, runtimeBaseRef } = gatherBuildIdInputs();
  const buildId = deriveBuildId(inputs);
  const gitSha = (tryRun("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]) ?? "unknown").trim();
  const epoch = sourceDateEpoch();
  // The marker's `builtAt` is the ISO-8601 rendering of SOURCE_DATE_EPOCH, NOT
  // `new Date()`. It is baked into /etc/qds-image.json, so a wall-clock value
  // here changes a layer's bytes on every rebuild and no amount of timestamp
  // rewriting further down can recover the digest.
  const builtAt = new Date(epoch * 1000).toISOString();

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.rmSync(NOTICE_PATH, { force: true });
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

  const archive = path.join(BUILD_DIR, "exedev.docker.tar");
  const metadataFile = path.join(BUILD_DIR, "build-metadata.json");
  fs.rmSync(archive, { force: true });
  fs.rmSync(metadataFile, { force: true });

  /**
   * Everything but the `--output`s, so the gate build and the publish build are
   * the SAME solve by construction rather than by two argv lists someone has to
   * keep in step. Publishing re-invokes this with a pushing output; BuildKit
   * answers it from cache and exports the bytes the gates already read.
   */
  const buildxArgs = (outputs: readonly string[]): string[] => [
    "buildx", "build", "--builder", builder, "-f", DOCKERFILE,
    "--platform", opts.platform,
    "--build-arg", `BUN_VERSION=${inputs.bunVersion}`,
    "--build-arg", `PI_VERSION=${inputs.piVersion}`,
    "--build-arg", `QDS_IMAGE_REF=${opts.tag}`,
    "--build-arg", `QDS_BUILD_ID=${buildId}`,
    "--build-arg", `QDS_GIT_SHA=${gitSha}`,
    "--build-arg", `QDS_BUILT_AT=${builtAt}`,
    // BuildKit reads this build arg by name: it fixes the config's `created`
    // and is the epoch `rewrite-timestamp` normalises every layer mtime to.
    // Passed explicitly rather than left to the ambient environment so the
    // value is the one this script decided, visible in the command line.
    "--build-arg", `SOURCE_DATE_EPOCH=${epoch}`,
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
  // the same reason `manifestDigest` validates — a plausible-looking blob
  // recorded as a digest is worse than none.
  let builtDigest: string | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    const d = meta["containerimage.digest"];
    if (typeof d === "string" && /^sha256:[0-9a-f]{64}$/.test(d)) builtDigest = d;
  } catch {
    builtDigest = null;
  }
  if (builtDigest === null) die(2, [`the build wrote no usable containerimage.digest to ${metadataFile}`]);

  // `docker load` reports the id it stored; parsed rather than derived, because
  // it differs by image store (config digest on the classic store, manifest
  // digest under containerd) and everything below addresses the image by it.
  const loaded = run("docker", ["load", "-q", "-i", archive], "docker load");
  const imageId = loaded.match(/sha256:[0-9a-f]{64}/)?.[0] ?? null;
  if (imageId === null) die(2, [`docker load reported no image id (output: ${loaded.trim() || "empty"})`]);
  // A 1.6 GB archive that has served its purpose; the image is in the daemon.
  fs.rmSync(archive, { force: true });

  const treeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-exedev-tree-"));
  let sweep: SweepResult;
  try {
    const scan = scanImage(imageId);
    sweep = sweepImageTree(imageId, scan.nodeModulesSites, treeDir);

    // AC5's finding, stated as the story states it: on a binary image with no
    // deps stage, the swept count IS the evidence, and a NON-ZERO count means
    // an npm tree crept in unnoticed. Named, so the next person knows what to
    // remove rather than being told a number.
    if (sweep.treePackageCount > 0) {
      const named = sweep.entries.slice(0, 20).map((e) => `${e.name}@${e.version} at /${e.depPath}`);
      // Coverage gaps enrich the finding when the NOTICE machinery can render
      // this tree at all; a tree that cannot be rendered is already the finding.
      let gaps: string[] = [];
      try {
        const notice = renderNotice(sweep, { imageRef: opts.tag, installFlags: "(none — binary image)", sweptAt: builtAt });
        gaps = verifyNoticeCoverage(notice, sweep.uncovered);
      } catch {
        gaps = [];
      }
      die(1, [
        `the built image carries an npm tree of ${sweep.treePackageCount} installed copies at ${scan.nodeModulesSites.map((s) => `/${s}`).join(", ")}`,
        "this image installs no npm dependencies; a tree here is an unswept surface that crept in",
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

    // The recorded negative evidence for AC5: a NOTICE generated from the
    // actual exported filesystem, saying in DF2.9's own format that this image
    // ships no attributable npm tree. `verifyNoticeCoverage` is the negative
    // control on it and must stay clean for an empty tree.
    const notice = renderNotice(sweep, { imageRef: opts.tag, installFlags: "(none — binary image)", sweptAt: builtAt });
    const gaps = verifyNoticeCoverage(notice, sweep.uncovered);
    if (gaps.length > 0) die(1, [`the NOTICE fails to cover: ${gaps.join(", ")}`]);
    fs.writeFileSync(NOTICE_PATH, notice);

    if (scan.findings.length > 0) die(1, scan.findings);

    // AC5's negative control. The coverage set is COMPUTED here — built image
    // minus base image — and never read from the table it checks.
    const builtBins = listExecutables(imageId, opts.platform);
    const baseBins = listExecutables(runtimeBaseRef, opts.platform);
    const added = [...builtBins].filter((p) => !baseBins.has(p)).sort();
    const uncovered = uncoveredBinaries(added, table);
    if (uncovered.length > 0) {
      die(1, [
        `this image adds ${uncovered.length} executable(s) with no entry in oci/exedev/binary-licenses.json:`,
        ...uncovered.map((p) => `/${p}`),
        "add an entry naming the project, its SPDX identifier and how the license was established",
      ]);
    }

    run("docker", ["tag", imageId, opts.tag], "docker tag");

    let digest: string | null = null;
    if (opts.push) {
      // NOT `docker push` of the loaded image. The daemon would re-compress the
      // layers it loaded from an uncompressed archive, and a digest that
      // depends on which daemon version happened to gzip it is not a digest the
      // publish gate can compare against a checked-in pin. Re-invoking the same
      // solve costs nothing — it is a cache hit — and BuildKit pushes the very
      // blobs it already exported above, so the pushed manifest is the gated
      // manifest and the equality below proves it rather than assuming it.
      run(
        "docker",
        buildxArgs(["--output", `type=image,name=${opts.tag},rewrite-timestamp=true,push=true`]),
        "docker buildx build --push",
      );
      // The pushed MANIFEST digest — the value the repo pin pairs with this
      // buildId, and the value `--image <ref>@sha256:…` would carry. Read back
      // from the registry rather than assumed from the local image id, which is
      // the config digest and is NOT what a pull resolves.
      const fromLocal = tryRun("docker", [
        "image", "inspect", "--format", "{{index .RepoDigests 0}}", opts.tag,
      ])?.match(/@(sha256:[0-9a-f]{64})$/);
      digest = manifestDigest(opts.tag) ?? fromLocal?.[1] ?? null;
      if (digest === null) {
        die(2, [
          `pushed ${opts.tag} but could not read back its manifest digest`,
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
        ]);
      }
    }

    const sizeOf = (ref: string): number => Number(tryRun("docker", ["image", "inspect", "--format", "{{.Size}}", ref]) ?? 0);
    const summary: SweepSummary & { buildId: string; imageDigest: string | null } = {
      ...summarize(
        sweep,
        { imageRef: opts.tag, installFlags: "(none — binary image)", sweptAt: builtAt },
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
      baseImageSizeBytes: sizeOf(runtimeBaseRef),
      // Filled by the live e2e round, which is the only thing that can boot a
      // box. Per the Observability Contract, a field never evaluated reports 0.
      coldBootMs: 0,
      sweptPackageCount: sweep.treePackageCount,
      nodeModulesSites: scan.nodeModulesSites,
      addedBinaries: added,
      attributedBinaries: table.flatMap((e) => e.names),
      credentialFindings: scan.findings.length,
    });

    say(
      `tagged ${opts.tag} (${imageId})\n` +
        `buildId: ${buildId}\n` +
        `digest:  ${builtDigest}${digest === null ? " (built, not pushed)" : " (pushed, registry agrees)"}\n` +
        `epoch:   ${epoch} (${builtAt})\n` +
        `swept:   ${sweep.treePackageCount} npm packages · added binaries: ${added.length}\n` +
        `NOTICE:  ${NOTICE_PATH}\nsummary: ${opts.summary}\nevidence: ${opts.evidence}\n`,
    );
  } finally {
    if (!opts.keepTree) fs.rmSync(treeDir, { recursive: true, force: true });
    else say(`kept extracted tree at ${treeDir}\n`);
  }
}

// Guarded so `deriveBuildId`, `parseBaseRefs`, `readBunPin`, `nodeModulesRoot`,
// `validateBinaryLicenses` and `uncoveredBinaries` can be unit-tested by
// importing this module; running the script directly is unaffected.
if (import.meta.main) main();
