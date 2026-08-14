#!/usr/bin/env bun
/**
 * Enterprise OCI image build for QDS-Factory (story DF2.9).
 *
 * Orders the four things that must happen in this order and no other:
 *
 *   1. build the `deps` stage — the real dependency tree, installed with
 *      `--omit=optional` and the pinned `@mariozechner/pi-coding-agent`;
 *   2. SWEEP that tree (`scripts/generate-notice.ts`), which is both the
 *      NOTICE generator and the compliance gate — a denied package or an
 *      unattributable license stops the build here (INV-1, INV-2, INV-4);
 *   3. build the `runtime` stage, which copies the generated NOTICE in;
 *   4. scan the built image for credential-shaped files and secret-looking
 *      ENV/ARG layers (INV-5), and only then apply the tag.
 *
 * Nothing is tagged until every check has passed, so a build that tripped the
 * denylist leaves no artifact behind.
 *
 * Exit codes match the sweep's contract: 0 clean, 1 compliance failure,
 * 2 fatal before the sweep could conclude (no builder, docker failure).
 *
 * Usage: bun scripts/build-image.ts [--tag <ref>] [--keep-tree]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exitWithFailure, parseValueFlags } from "./lib/cli-args.ts";
import { PI_CODING_AGENT_PIN } from "./lib/license-sweep.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(REPO_ROOT, "oci/.build");
const NOTICE_PATH = path.join(BUILD_DIR, "NOTICE");
const SUMMARY_PATH = path.join(BUILD_DIR, "sweep-summary.json");
const DOCKERFILE = path.join(REPO_ROOT, "oci/Dockerfile");
const INSTALL_FLAGS = "--omit=optional";

const HELP = [
  "usage: bun scripts/build-image.ts [--tag <ref>] [--keep-tree]",
  "",
  "  --tag <ref>    image reference to apply once every check passes",
  "                 [qds-factory:local]. The tag is DROPPED before the build so",
  "                 that a failed build leaves nothing resolving under it.",
  "  --keep-tree    keep the extracted dependency tree for inspection",
  "",
  "exit: 0 clean · 1 compliance failure · 2 fatal (no builder / docker error)",
  "",
].join("\n");

/**
 * Paths that are a credential by their very nature — a private key, an SSH
 * directory, a git credential store. No content check needed, and no
 * `node_modules` exemption: `/app/node_modules/.ssh/id_rsa` is still a key.
 */
const ALWAYS_CREDENTIAL =
  /(^|\/)(\.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519)$|(^|\/)\.ssh\/|\.p12$/;
/**
 * Config files that MAY carry a secret and usually do not. `node:22` ships
 * `/usr/local/lib/node_modules/npm/.npmrc` — npm's builtin config, holding
 * `prefix=/usr/local` and nothing else. Failing the build on the filename
 * alone would make INV-5 unsatisfiable on a stock base image, and a scan that
 * always fires is a scan nobody reads. These get their CONTENTS inspected.
 */
const CONFIG_CANDIDATE = /(^|\/)(\.npmrc|\.netrc|_netrc)$/;
/**
 * The same, for basenames innocent enough inside a dependency's own test
 * fixtures that they are not worth reading there.
 */
const CONFIG_CANDIDATE_OUTSIDE_DEPS =
  /(^|\/)(credentials|\.env(\.[\w-]+)?)$|\.(pem|key|jks|pfx)$|(^|\/)\.docker\/config\.json$/;
const IN_DEPS = /(^|\/)node_modules\//;
/** Secret-bearing lines in a config file: npm auth, netrc login, a raw key. */
const SECRET_IN_CONFIG =
  /(_auth(Token)?\s*=|_password\s*=|(aws_)?(session_token|secret_access_key)\s*=\s*\S|^\s*password\s+\S|^\s*machine\s+\S+\s+login\s|BEGIN\s+[A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/im;
/**
 * Layer commands that bake a secret into the image history (INV-5). Matched as
 * a NAME=value pair anywhere in the command, not anchored on an ENV/ARG
 * keyword: BuildKit renders a build-arg-tainted layer as
 * `|1 NPM_TOKEN=… /bin/sh -c npm install`, with no keyword to anchor on.
 */
export const SECRET_ENV =
  /(^|[\s|"'])[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)[A-Z0-9_]*=\S/i;

/**
 * How a path inside the image is treated by the INV-5 scan: a credential on
 * sight, a config file whose contents must be read, or nothing.
 */
export function classifyScanPath(entry: string): "credential" | "inspect" | null {
  if (ALWAYS_CREDENTIAL.test(entry)) return "credential";
  if (CONFIG_CANDIDATE.test(entry)) return "inspect";
  if (!IN_DEPS.test(entry) && CONFIG_CANDIDATE_OUTSIDE_DEPS.test(entry)) return "inspect";
  return null;
}

/** True when a config file's contents carry an actual secret. */
export function configLooksLikeCredential(text: string): boolean {
  if (SECRET_IN_CONFIG.test(text)) return true;
  // A `.env` carries its secrets as plain NAME=value pairs, which is exactly
  // the shape SECRET_ENV already recognises in layer history.
  return text.split("\n").some((line) => SECRET_ENV.test(line));
}

function die(code: 1 | 2, lines: readonly string[]): never {
  return exitWithFailure("image build FAILED:", code, lines);
}

function run(cmd: string, args: readonly string[], label: string): string {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (res.error) die(2, [`${label}: ${res.error.message}`]);
  if (res.status !== 0) die(2, [`${label} exited ${res.status ?? "on a signal"}`]);
  return res.stdout ?? "";
}

/** Builds one stage and returns the image ID, without tagging anything. */
function buildStage(target: string, buildArgs: readonly string[] = []): string {
  const iidFile = path.join(BUILD_DIR, `${target}.iid`);
  fs.rmSync(iidFile, { force: true });
  run(
    "docker",
    ["build", "-f", DOCKERFILE, "--target", target, ...buildArgs, "--iidfile", iidFile, REPO_ROOT],
    `docker build --target ${target}`,
  );
  const id = fs.readFileSync(iidFile, "utf8").trim();
  if (!id) die(2, [`docker build --target ${target} produced no image id`]);
  return id;
}

/** Copies the image's dependency tree onto the host so the sweep can read it. */
function extractTree(imageId: string, dest: string): void {
  const cid = run("docker", ["create", imageId], "docker create").trim();
  if (!cid) die(2, ["docker create produced no container id"]);
  try {
    fs.mkdirSync(dest, { recursive: true });
    run("docker", ["cp", `${cid}:/app/node_modules`, path.join(dest, "node_modules")], "docker cp");
  } finally {
    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
  }
}

/**
 * Reads each candidate config file out of the container and reports the ones
 * that actually carry a secret. A file that cannot be read is reported rather
 * than skipped — INV-5 fails closed like everything else here.
 */
function inspectConfigs(cid: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qds-image-scan-"));
  const findings: string[] = [];
  try {
    for (const [i, p] of paths.entries()) {
      const dest = path.join(scratch, `cfg-${i}`);
      const cp = spawnSync("docker", ["cp", `${cid}:/${p}`, dest], { stdio: ["ignore", "ignore", "pipe"] });
      if (cp.status !== 0) {
        findings.push(`could not read /${p} to check it for credentials — treating as a finding`);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(dest, "utf8");
      } catch {
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

/** INV-5: no API key, no .npmrc auth token, no git credential in any layer. */
function scanForCredentials(imageId: string): string[] {
  const findings: string[] = [];

  const history = run(
    "docker",
    ["image", "history", "--no-trunc", "--format", "{{.CreatedBy}}", imageId],
    "docker image history",
  );
  for (const line of history.split("\n")) {
    if (SECRET_ENV.test(line)) findings.push(`layer history bakes a secret-shaped value: ${line.trim()}`);
  }

  const cid = run("docker", ["create", imageId], "docker create (scan)").trim();
  try {
    // `docker export` streams the FLATTENED filesystem; tar lists it without
    // unpacking hundreds of MB onto the host. Known limit: a secret written in
    // one RUN and deleted in a later one survives in the layer tarball but is
    // invisible here. The history scan above catches the ENV/ARG shape of that
    // leak; a full `docker save` layer walk is the upgrade if a build ever
    // needs a real build-time secret.
    // `pipefail` is required — `tar -tf -` exits 0 as soon as it reads an
    // end-of-archive marker, so a failed export would otherwise pass vacuously.
    const listing = spawnSync("bash", ["-c", `set -o pipefail; docker export ${cid} | tar -tf -`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (listing.status !== 0) die(2, ["docker export | tar failed while scanning for credentials"]);
    const inspect: string[] = [];
    for (const entry of (listing.stdout ?? "").split("\n")) {
      if (!entry || entry.endsWith("/")) continue;
      const verdict = classifyScanPath(entry);
      if (verdict === "credential") findings.push(`credential in the image: /${entry}`);
      else if (verdict === "inspect") inspect.push(entry);
    }
    findings.push(...inspectConfigs(cid, inspect));
  } finally {
    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
  }
  return findings;
}

/** The coding-agent version the sweep recorded, or null if it saw none. */
function readSummaryPiVersion(): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));
    const versions = (parsed as { piVersions?: Record<string, string> }).piVersions;
    return versions?.["@mariozechner/pi-coding-agent"] ?? null;
  } catch {
    return null;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const keepTree = argv.includes("--keep-tree");
  let tag = "qds-factory:local";
  try {
    parseValueFlags(
      argv.filter((a) => a !== "--keep-tree"),
      {
        flags: ["--tag"],
        help: [HELP],
        onValue: (_flag, value) => {
          tag = value;
        },
      },
    );
  } catch (err) {
    // A bad invocation is fatal-before-the-sweep (exit 2). An uncaught throw
    // would exit 1, which the contract reserves for a compliance failure.
    die(2, [err instanceof Error ? err.message : String(err)]);
  }

  // Preflight: an absent builder is a fatal-before-the-sweep condition, and
  // must say what to install rather than failing three commands later.
  const buildx = spawnSync("docker", ["buildx", "version"], { stdio: "ignore" });
  if (buildx.error || buildx.status !== 0) {
    die(2, [
      "no OCI builder found: `docker buildx version` did not succeed",
      "install Docker Desktop / docker-buildx-plugin (or run this on a CI runner that has it)",
    ]);
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  // A NOTICE left over from a previous run must never be able to satisfy this
  // one — the runtime stage copies whatever is at this path.
  fs.rmSync(NOTICE_PATH, { force: true });
  // Same reasoning for the tag itself: "no image artifact is produced" (AC3)
  // has to mean the tag does not RESOLVE after a failed build, not merely that
  // this run declined to move it. Otherwise a bump that introduces a denied
  // package fails the build and `docker push <tag>` still pushes yesterday's
  // image. Dropping the tag never deletes an image that is tagged elsewhere.
  spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
  // …and verify it actually went. `docker rmi -f` fails on a tag a container
  // still references, which is an ordinary state on a developer box that just
  // ran the image — and a fire-and-forget rmi would leave the tag resolving to
  // yesterday's build after today's build fails.
  const stillThere = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (stillThere.status === 0) {
    die(2, [
      `${tag} still resolves after dropping it; a failed build would leave it pointing at an older image`,
      `remove the containers holding it (docker ps -a --filter ancestor=${tag}) and re-run`,
    ]);
  }

  const depsId = buildStage("deps");
  const depsTag = `qds-factory-deps:sweep-${process.pid}`;

  const treeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-image-tree-"));
  try {
    extractTree(depsId, treeDir);

    // The sweep owns the compliance verdict; this script only relays its exit
    // code, so `bun run notice:sweep` and the image build cannot disagree.
    const sweep = spawnSync(
      "bun",
      [
        path.join(REPO_ROOT, "scripts/generate-notice.ts"),
        "--tree", treeDir,
        "--out", NOTICE_PATH,
        "--summary", SUMMARY_PATH,
        "--image-ref", tag,
        // The `=` form, because the value itself looks like a flag and the
        // space form of the shared parser rejects those on purpose.
        `--install-flags=${INSTALL_FLAGS}`,
      ],
      { stdio: "inherit" },
    );
    if (sweep.status !== 0) {
      process.stderr.write(`license sweep failed (exit ${sweep.status}) — no image was tagged\n`);
      process.exit(sweep.status ?? 2);
    }
    if (!fs.existsSync(NOTICE_PATH) || fs.statSync(NOTICE_PATH).size === 0) {
      die(1, ["the sweep reported success but produced no NOTICE"]);
    }

    // AC2's positive half. The sweep flags a WRONG version, but a tree with no
    // coding agent at all (a botched install, a bad extraction) has no version
    // to flag — and would otherwise sweep clean and tag.
    const observed = readSummaryPiVersion();
    if (observed !== PI_CODING_AGENT_PIN) {
      die(1, [
        `the image tree must carry @mariozechner/pi-coding-agent@${PI_CODING_AGENT_PIN}; observed ${observed ?? "no copy at all"}`,
      ]);
    }

    // Pin the runtime stage to the EXACT image the sweep classified. Left to
    // re-resolve `deps` itself, a cache miss (builder GC, a pruned CI cache, a
    // second builder) would install a fresh tree — the pi libs float inside
    // 0.55.x and there is no lockfile — and the image would ship a tree no
    // sweep ever saw while still exiting 0 (INV-1).
    //
    // Via a throwaway local tag, not the bare image ID: BuildKit resolves a
    // `FROM` argument as a repository NAME, so `FROM sha256:…` sends it to the
    // registry. This tag is internal plumbing between two stages of one build,
    // never a release artifact, and it is dropped in the `finally` below.
    run("docker", ["tag", depsId, depsTag], "docker tag (deps pin)");
    const runtimeId = buildStage("runtime", ["--build-arg", `DEPS_IMAGE=${depsTag}`]);

    const findings = scanForCredentials(runtimeId);
    if (findings.length > 0) die(1, findings);

    run("docker", ["tag", runtimeId, tag], "docker tag");
    process.stdout.write(`tagged ${tag} (${runtimeId})\nNOTICE: ${NOTICE_PATH}\nsummary: ${SUMMARY_PATH}\n`);
  } finally {
    // Internal plumbing, not an artifact — dropped on success and on failure
    // alike. Untagging never deletes the image itself while the build holds it.
    spawnSync("docker", ["rmi", depsTag], { stdio: "ignore" });
    if (!keepTree) fs.rmSync(treeDir, { recursive: true, force: true });
    else process.stdout.write(`kept extracted tree at ${treeDir}\n`);
  }
}

// Guarded so the INV-5 predicates above can be unit-tested by importing this
// module; running the script directly is unaffected.
if (import.meta.main) main();
