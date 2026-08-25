/**
 * Host-pinned gate plan resolution (Story DF5.1, AC2 / INV-RV-1).
 *
 * A skip-permissions agent controls everything the box emits, so it also
 * controls any judge shipping inside the harvested tree. The plan therefore
 * comes from the OPERATOR's `.factory/pipeline.json`, keyed by the run record's
 * `repoSlug`, and from the DF1.1 manifest that entry names — never from the
 * target repository's checkout and never from harvest output. The tree supplies
 * the code to run; it never supplies the command that judges it.
 */
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

import { loadManifest } from "../phase-engine/manifest.ts";
import { ReverifyError, exec } from "./worktree.ts";

/** Ceiling handed to `loadManifest`, which refuses to assume an upstream one. */
export const HOST_PLAN_BUDGET_MS = 30 * 60_000;

const HostEntrySchema = z
  .object({
    /** Path to the DF1.1 manifest, relative to the operator's checkout; must land beneath `.factory/`. */
    manifest: z.string().min(1),
    /**
     * The repository genuinely has no test suite. The ONLY way
     * `no-tests-executed` is suppressed, and it is declared host-side by the
     * operator — never inferable from the tree, which is the half an agent
     * controls.
     */
    noTestSuite: z.boolean().default(false),
  })
  .strict();

const HostPipelineSchema = z
  .object({ version: z.literal(1), repos: z.record(z.string(), HostEntrySchema) })
  .strict();

export interface GateCommand {
  name: string;
  argv: string[];
}

export interface HostPlan {
  /** argv of the host-pinned test run, or null when `noTestSuite`. */
  testCommand: string[] | null;
  gateCommands: GateCommand[];
  noTestSuite: boolean;
  /** Provenance: the absolute manifest path the plan was read from. */
  manifestPath: string;
}

export interface HostPlanOptions {
  /** The operator's checkout — where `.factory/` lives. */
  hostRoot: string;
  repoSlug: string;
  /** The pinned base the box was filled at; recorded as the plan's pin. */
  baseSha: string;
}

function noHostPlan(message: string, cause?: unknown): ReverifyError {
  return new ReverifyError(
    "no-host-plan",
    message,
    "add an entry for this repoSlug to the operator's .factory/pipeline.json naming a schema-valid DF1.1 manifest; reverify never falls back to the harvested tree's own manifest",
    cause !== undefined ? { cause } : undefined,
  );
}

export function resolveHostPlan(opts: HostPlanOptions): HostPlan {
  const factoryRoot = resolve(opts.hostRoot, ".factory");
  const indexPath = join(factoryRoot, "pipeline.json");

  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch (e) {
    throw noHostPlan(`operator pipeline index ${indexPath} could not be read: ${(e as Error).message}`, e);
  }

  let index: z.output<typeof HostPipelineSchema>;
  try {
    index = HostPipelineSchema.parse(JSON.parse(raw.replace(/^﻿/, "")));
  } catch (e) {
    throw noHostPlan(`operator pipeline index ${indexPath} is not a valid host plan index: ${(e as Error).message}`, e);
  }

  const entry = Object.hasOwn(index.repos, opts.repoSlug) ? index.repos[opts.repoSlug] : undefined;
  if (!entry) {
    throw noHostPlan(`no host plan entry for repoSlug ${opts.repoSlug} in ${indexPath}`);
  }

  // The entry path is relative to the operator's checkout, but must LAND
  // beneath `.factory/`: an entry is operator-authored, yet the index is a
  // config file and config files get edited by scripts. A `../..` escape is
  // refused here as well as by loadManifest's beneath-root walk.
  const manifestPath = resolve(opts.hostRoot, entry.manifest);
  if (manifestPath !== factoryRoot && !manifestPath.startsWith(factoryRoot + sep)) {
    throw noHostPlan(`host manifest path ${entry.manifest} escapes ${factoryRoot}`);
  }

  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(manifestPath, HOST_PLAN_BUDGET_MS, factoryRoot);
  } catch (e) {
    throw noHostPlan(
      `host manifest ${manifestPath} for ${opts.repoSlug} did not schema-validate at ${opts.baseSha}: ${(e as Error).message}`,
      e,
    );
  }

  const phases = loaded.manifest.phases;
  const testPhase = phases.find((p) => p.testCommand !== undefined);
  // The test phase's own `command` is NOT re-run as a gate: the host test run
  // already executed it and its counts are the evidence. Re-running it would
  // double the wall-clock and record the same subprocess twice.
  const gateCommands = phases
    .filter((p) => p !== testPhase)
    .filter((p): p is typeof p & { command: string[] } => p.command !== undefined)
    .map((p) => ({ name: p.name, argv: [...p.command] }));

  // A `noTestSuite` repo's green rests entirely on the non-test phases, so a
  // manifest that has none would let `install`-alone stand in for verification.
  if (entry.noTestSuite && gateCommands.length === 0) {
    throw noHostPlan(
      `host manifest ${manifestPath} sets noTestSuite but declares no non-test phase command — a green would rest on nothing`,
    );
  }

  if (!entry.noTestSuite && testPhase === undefined) {
    throw noHostPlan(
      `host manifest ${manifestPath} declares no testCommand and the entry does not set noTestSuite — reverify has nothing to execute tests with`,
    );
  }

  return {
    testCommand: entry.noTestSuite ? null : [...testPhase!.testCommand!],
    gateCommands,
    noTestSuite: entry.noTestSuite,
    manifestPath,
  };
}

// ─── evidence flags ──────────────────────────────────────────────────────────

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const DEPENDENCY_PATH_RE =
  /(^|\/)(package\.json|bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|uv\.lock|Cargo\.lock|go\.sum)$/;
const MANIFEST_PATH_RE = /(^|\/)(pipeline\.json|bunfig\.toml|\.factory\/)/;

/**
 * Evidence, not blocks. Legitimate stories change tests, so these never fail a
 * verdict — they are the reviewer-visible signal DF5.2 renders into the PR body.
 */
export async function divergenceFlags(gitCwd: string, baseSha: string, headSha: string): Promise<string[]> {
  const res = await exec(["git", "diff", "--name-only", `${baseSha}`, `${headSha}`], { cwd: gitCwd });
  if (res.exitCode !== 0) {
    throw new ReverifyError(
      "diff-failed",
      `git diff --name-only ${baseSha} ${headSha} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
      "confirm both shas are present in the host repository (the harvest fetch must have completed), then re-run",
    );
  }
  const paths = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const flags: string[] = [];
  if (paths.some((p) => TEST_PATH_RE.test(p))) flags.push("test-files-modified");
  if (paths.some((p) => DEPENDENCY_PATH_RE.test(p))) flags.push("dependency-manifest-modified");
  if (paths.some((p) => MANIFEST_PATH_RE.test(p))) flags.push("manifest-divergence");
  return flags;
}
