#!/usr/bin/env bun
/**
 * Visualizer vendoring step for DF4.1 (AC0).
 *
 * Clones the pinned upstream SSSF repo, copies its visualizer app into
 * `visualizer/`, and writes the provenance record + upstream license. The pin
 * is ALWAYS an explicit input (`--repo` / `--sha` flags, or
 * `VENDOR_VISUALIZER_REPO` / `VENDOR_VISUALIZER_SHA` env vars, flags winning)
 * — it is never read back from `visualizer/PROVENANCE.md`, because that file
 * does not exist until this step creates it.
 *
 * This script is a pure copier. Every DF4.1 hardening modification (auth gate,
 * `adw_id` → `request_id` rename, prompts-from-trace, micro-dollar costs) is a
 * tracked diff in this repo applied AFTER vendoring — re-running against the
 * same pin is therefore a true no-op, and modifications are never silently
 * clobbered.
 *
 * Exit codes:
 *   0  vendored, or already vendored at exactly this pin (idempotent no-op)
 *   1  bad input or refusing to clobber — missing pin, non-SHA revision,
 *      existing `visualizer/` with a different or absent provenance record
 *   2  fatal — clone failed, pin not found upstream, source path or upstream
 *      LICENSE missing
 *
 * Usage:
 *   bun scripts/vendor-visualizer.ts --repo <url> --sha <40-hex>
 *   VENDOR_VISUALIZER_REPO=<url> VENDOR_VISUALIZER_SHA=<sha> bun scripts/vendor-visualizer.ts
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exitWithFailure, parseValueFlags } from "./lib/cli-args";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TARGET_DIR = path.join(REPO_ROOT, "visualizer");
const PROVENANCE = path.join(TARGET_DIR, "PROVENANCE.md");
const LICENSE_UPSTREAM = path.join(TARGET_DIR, "LICENSE.upstream");
/** Where the visualizer lives inside the upstream repo. */
const SOURCE_PATH = ".claude/skills/sssf/apps/visualizer";
/** Copied verbatim from the upstream repo root into LICENSE.upstream. */
const UPSTREAM_LICENSE = "LICENSE";
/** Never vendored: root bun.lock governs deps; dist/ is build output. */
const EXCLUDE_FILES = new Set(["bun.lock"]);
const EXCLUDE_DIRS = new Set(["dist", "node_modules"]);

// Function declarations (not arrow consts): TS only narrows unreachability
// through never-returning function declarations/annotated consts, and these
// guards must convince the compiler that every refuseExistingTree path exits.
function fail(lines: readonly string[]): never {
  return exitWithFailure("vendor-visualizer FAILED:", 1, lines);
}
function fatal(lines: readonly string[]): never {
  return exitWithFailure("vendor-visualizer FATAL:", 2, lines);
}

interface Pin {
  repo: string;
  sha: string;
}

function resolvePin(argv: readonly string[]): Pin {
  let repo = process.env.VENDOR_VISUALIZER_REPO ?? "";
  let sha = process.env.VENDOR_VISUALIZER_SHA ?? "";
  parseValueFlags(argv, {
    flags: ["--repo", "--sha"],
    onValue: (flag, value) => {
      if (flag === "--repo") repo = value;
      else sha = value;
    },
    help: [
      "vendor-visualizer — vendor the upstream SSSF visualizer at a pinned commit (DF4.1 AC0)",
      "",
      "  --repo <url>    upstream git repository URL (env: VENDOR_VISUALIZER_REPO; flag wins)",
      "  --sha <commit>  full 40-hex commit SHA to vendor (env: VENDOR_VISUALIZER_SHA; flag wins)",
      "",
      "Re-running with the same pin is a no-op. The pin is an explicit input only —",
      "it is never read back from visualizer/PROVENANCE.md.",
    ],
  });
  if (!repo) fail(["no repo: pass --repo or set VENDOR_VISUALIZER_REPO"]);
  if (!sha) fail(["no sha: pass --sha or set VENDOR_VISUALIZER_SHA"]);
  if (!/^[0-9a-f]{40}$/i.test(sha)) fail([`sha is not a full 40-hex commit SHA: ${sha}`]);
  return { repo, sha: sha.toLowerCase() };
}

/** Read one `key: value` line from an existing PROVENANCE.md, if present. */
function provenanceField(key: string): string | undefined {
  if (!fs.existsSync(PROVENANCE)) return undefined;
  const match = fs
    .readFileSync(PROVENANCE, "utf8")
    .match(new RegExp(`^${key}: (.+)$`, "m"));
  return match?.[1]?.trim();
}

function refuseExistingTree(pin: Pin): never {
  const recordedRepo = provenanceField("repo");
  const recordedSha = provenanceField("sha");
  if (recordedRepo === undefined && recordedSha === undefined) {
    fail([
      "visualizer/ exists with no parseable PROVENANCE.md — refusing to overwrite a tree of unknown provenance",
      "delete visualizer/ deliberately, then re-run the vendoring step",
    ]);
  }
  if (recordedRepo === pin.repo && recordedSha === pin.sha) {
    // Idempotent no-op: same pin, tree already vendored (local hardening diffs
    // live on top and must not be clobbered).
    console.log(`visualizer/ already vendored from ${pin.repo}@${pin.sha} — no-op`);
    process.exit(0);
  }
  fail([
    `visualizer/ is vendored from a different pin (repo=${recordedRepo ?? "?"} sha=${recordedSha ?? "?"})`,
    `refusing to clobber with ${pin.repo}@${pin.sha}`,
    "local modifications are tracked diffs on top of the vendored tree; re-vendoring at a new pin requires deleting visualizer/ deliberately",
  ]);
}

function git(cwd: string | undefined, ...args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    fatal([`git ${args.join(" ")} failed (exit ${r.status})`, (r.stderr || r.stdout || "").trim()]);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...listFiles(path.join(dir, entry.name), base));
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
  return out.sort();
}

function main(): void {
  const pin = resolvePin(process.argv.slice(2));
  if (fs.existsSync(TARGET_DIR)) refuseExistingTree(pin);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qds-vendor-visualizer-"));
  try {
    git(undefined, "clone", "--filter=blob:none", "--no-checkout", pin.repo, tmp);
    const resolved = git(tmp, "rev-parse", pin.sha).stdout.trim().toLowerCase();
    if (resolved !== pin.sha) {
      fatal([`rev-parse ${pin.sha} resolved to ${resolved} — refusing an aliased pin`]);
    }
    git(tmp, "checkout", "--detach", pin.sha);

    const sourceDir = path.join(tmp, SOURCE_PATH);
    if (!fs.existsSync(path.join(sourceDir, "package.json"))) {
      fatal([`${SOURCE_PATH}/package.json not found at ${pin.repo}@${pin.sha} — upstream layout changed?`]);
    }
    const upstreamLicensePath = path.join(tmp, UPSTREAM_LICENSE);
    if (!fs.existsSync(upstreamLicensePath)) {
      fatal([`upstream ${UPSTREAM_LICENSE} not found — LICENSE.upstream must carry it verbatim`]);
    }

    const files = listFiles(sourceDir);
    if (files.length === 0) fatal([`${SOURCE_PATH} is empty at the pinned tree`]);

    fs.mkdirSync(TARGET_DIR, { recursive: true });
    for (const rel of files) {
      const dest = path.join(TARGET_DIR, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, rel), dest);
    }
    fs.copyFileSync(upstreamLicensePath, LICENSE_UPSTREAM);

    const vendored = new Date().toISOString();
    const provenance = [
      "# Vendored upstream visualizer — provenance record (DF4.1 AC0)",
      "",
      "Written by `scripts/vendor-visualizer.ts` at vendoring time. Never read as",
      "input by the vendoring step itself — the pin is always an explicit input.",
      "",
      `repo: ${pin.repo}`,
      `sha: ${pin.sha}`,
      `vendored: ${vendored}`,
      `source_path: ${SOURCE_PATH}`,
      `files: ${files.length}`,
      "",
      "Files taken (relative to visualizer/):",
      ...files.map((f) => `- ${f}`),
      "",
      "Excluded: `bun.lock` (the repo-root lockfile governs dependencies),",
      "`dist/` and `node_modules/` (build outputs, never vendored).",
      "",
      "All QDS-Factory modifications after this point — the token auth gate,",
      "`adw_id` → `request_id` rename at the port boundary, prompts served from",
      "the trace store, integer micro-dollar costs, loopback bind — are tracked",
      "diffs in this repository, not part of the vendored tree.",
      "",
      "Upstream license: MIT — see LICENSE.upstream (copied verbatim from the upstream repo root).",
      "",
    ].join("\n");
    fs.writeFileSync(PROVENANCE, provenance);

    // Post-copy self-check (AC0: a tree with no LICENSE.upstream or no recorded
    // SHA must fail).
    const shaOk = provenanceField("sha") === pin.sha;
    if (!shaOk || !fs.existsSync(LICENSE_UPSTREAM)) {
      fatal(["post-copy verification failed — PROVENANCE sha or LICENSE.upstream missing"]);
    }
    console.log(`vendored ${files.length} files into visualizer/ from ${pin.repo}@${pin.sha}`);
    console.log(`PROVENANCE.md + LICENSE.upstream written (${vendored})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
