/**
 * Harvest (DF2.5) — ranged bundle → copy down → verify → fetch to
 * refs/sandbox/<run-id>, plus the artifacts tar pull and its validator.
 *
 * Lifted from inkwell's harvest.just (R4 §3.3) — which shipped unrun upstream
 * (R4 §3 flag 4), so nothing inherited from it is treated as proven: the tests
 * in tests/providers/harvest.test.ts are the blocking evidence, and the one
 * behavior inkwell never exercised (the empty-bundle no-op) is classified here
 * per AC4 rather than inherited.
 *
 * The box holds no push credential (D8/INV-1), so commits cross the gap as a
 * RANGED bundle: `<base>..refs/heads/sbx/<run-id>` records the prerequisite
 * "you must already have <base>", and the host's `git bundle verify` refuses a
 * branch that does not descend from the sha FILL pinned — BEFORE any fetch
 * touches the host repo (INV-2). The fetch lands only at refs/sandbox/<run-id>
 * and never at a branch, tag, index or working tree.
 *
 * Harvest writes NOTHING to the run record: the bundle's presence at
 * <runsDir>/<run-id>.bundle is the record, and DF2.1's schema stays closed.
 *
 * In-box staging paths are BOX-ROOT RELATIVE (`harvest.bundle`,
 * `harvest-artifacts.tgz`): the remote scripts run inside <workdir> and write
 * `../harvest.bundle` / `../harvest-artifacts.tgz`, and the copies cross the
 * seam as relative names — a leading `/` is rejected by exedev's path guard,
 * so inkwell's /tmp staging cannot cross this seam unchanged (design.md
 * "Paths"; the seam correction the upstream justfiles never needed because
 * they never ran against a guarded driver).
 */

import { closeSync, createReadStream, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createGunzip } from "node:zlib";

import { log, newRequestId } from "../swarmclaw/log.ts";
import type { ExecResult, ProviderDriver } from "./driver.ts";
import { DEFAULT_RUNS_DIR, type RunRecord, type RunRecordStore } from "./run-record.ts";
import { stepBase, timedLoggedStep, type StepCtx } from "./step-log.ts";

/** Bundle received-bytes cap (INV-3-style bomb defense, host-side). */
export const BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
/** Artifacts tar cap — enforced on received bytes AND summed entry sizes. */
export const TAR_MAX_BYTES = 512 * 1024 * 1024;

/**
 * In-box repo workdir candidates, in probe order. Production fill clones to
 * /home/agent/app (DF2.2's KEY_ENV_FILE contract); /home/agent/src is kept for
 * design.md's spelling; `app` is the box-relative layout the fake substrate
 * and its tests use. An explicit `deps.workdir` replaces the whole list.
 */
const DEFAULT_WORKDIRS = ["/home/agent/app", "/home/agent/src", "app"];

export class HarvestError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "HarvestError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Untrusted box output bounded + credential-redacted before it touches an
 * error message (the message lands in the run log and the operator's
 * terminal). First line only, hard 200-char cap, and any sk-…-style token
 * is replaced — a compromised workload must not be able to exfiltrate the
 * run key through a failure's diagnostics.
 */
function sanitizeBoxOutput(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const capped = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  return capped.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]").trim();
}

/** Injectable host-git runner — tests spy ordering + inject failures. */
export type GitRunner = (argv: readonly string[], cwd: string) => Promise<ExecResult>;

/**
 * Hard ceiling per host-git call — the same bound + signal the seam's
 * sshCommand enforces (transport.ts): a hung host git (gpg agent prompt, wedged
 * fs) must die, not hang harvest forever.
 */
const GIT_TIMEOUT_MS = 120_000;

/** Default GitRunner: Bun.spawn with an argv ARRAY — never a shell string. */
export const bunGitRunner: GitRunner = async (argv, cwd) => {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export interface HarvestDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Propagated from the dispatch that created the run (§5.2). */
  requestId?: string;
  /** Host repo the fetch lands in. Default: process.cwd(). Must be a git repo. */
  gitCwd?: string;
  gitRunner?: GitRunner;
  /** Overrides the runs root (tests). Default: $QDS_RUNS_DIR or .sandbox/runs. */
  runsDir?: string;
  /** In-box repo workdir (see DEFAULT_WORKDIRS). */
  workdir?: string;
}

export type HarvestResult =
  | { outcome: "harvested"; count: number; tip: string }
  | { outcome: "none" };

export interface ArtifactsOutcome {
  artifacts: "none" | "pulled";
  files?: number;
}

// ─── observability ───────────────────────────────────────────────────────────

type HarvestStep = "bundle_create" | "transfer" | "verify" | "fetch" | "artifacts";

function stepCtx(deps: HarvestDeps, runId: string): StepCtx {
  return { requestId: deps.requestId ?? newRequestId(), runId, driver: deps.driver.name };
}

/** Harvest's outcome vocabulary for the shared step logger (step-log.ts). */
const STEP_LABELS = { ok: "ok", error: "error", errorCode: "harvest_error" };

/** One timed, logged harvest step — credentials.ts `timed` shape. */
function timedStep<T>(ctx: StepCtx, step: HarvestStep, fn: () => Promise<T>): Promise<T> {
  return timedLoggedStep(ctx, "harvest", step, STEP_LABELS, fn);
}

function logPreflightError(ctx: StepCtx, err: HarvestError): void {
  log({
    ...stepBase(ctx, "harvest", "preflight"),
    duration: 0,
    durationMs: 0,
    status: "error",
    error: { code: err.code, message: err.message },
    remediation: err.remediation,
    outcome: "error",
  });
}

// ─── paths + script assembly ─────────────────────────────────────────────────

function resolveRunsDir(deps: HarvestDeps): string {
  const dir = deps.runsDir ?? process.env.QDS_RUNS_DIR ?? DEFAULT_RUNS_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function workdirList(deps: HarvestDeps): readonly string[] {
  const wd = deps.workdir;
  if (wd === undefined) return DEFAULT_WORKDIRS;
  // The workdir is interpolated into a shell script: same grammar as
  // credentials.ts assertEnvFileSafe — fail closed on metacharacters.
  if (!/^[A-Za-z0-9._/-]+$/.test(wd) || wd.split("/").includes("..")) {
    throw new HarvestError(
      "workdir-invalid",
      `workdir ${JSON.stringify(wd)} is not a plain path (charset [A-Za-z0-9._/-], no ".." segments)`,
      "pass an in-box path without shell metacharacters",
    );
  }
  return [wd];
}

/**
 * Step A script (inkwell harvest.just:54-83). $1 = FILL-pinned base sha,
 * $2 = run branch. stdout is EXACTLY one protocol line (OK/NOREPO/NOCOMMITS/
 * BUNDLEFAIL); everything else git prints goes to stderr so untrusted box
 * chatter can never forge or smudge the protocol line. Unknown base in-box
 * makes rev-list fail under `set -euo pipefail` — a real failure, not AC2
 * (which is host-side verify): the script dies, exec exits non-zero.
 */
function remoteScript(workdirs: readonly string[]): string {
  return `
set -euo pipefail
base="$1"; branch="$2"
wd=""
for d in ${workdirs.join(" ")}; do
  if [ -d "$d/.git" ]; then wd="$d"; break; fi
done
if [ -z "$wd" ]; then echo "NOREPO"; exit 0; fi
cd "$wd"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOREPO"; exit 0; }
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 || git branch "$branch" >&2
count=$(git rev-list --count "$base..refs/heads/$branch")
if [ "$count" -eq 0 ]; then echo "NOCOMMITS"; exit 0; fi
git bundle create ../harvest.bundle "$base..refs/heads/$branch" >&2 || { echo "BUNDLEFAIL"; exit 0; }
tip=$(git rev-parse "refs/heads/$branch")
printf 'OK %s %s\\n' "$tip" "$count"
`.trim();
}

/**
 * Step E script (inkwell's artifacts set + trace.db). Probes the same workdir
 * candidates as Step A; absence of every artifact is a no-op, not a failure
 * (INV-5's fail-closed applies to real failures — a missing tar binary exits
 * non-zero and IS one).
 */
function artifactsScript(workdirs: readonly string[]): string {
  return `
set -eu
wd=""
for d in ${workdirs.join(" ")}; do
  if [ -d "$d" ]; then wd="$d"; break; fi
done
if [ -z "$wd" ]; then echo "NOARTIFACTS"; exit 0; fi
cd "$wd"
P=$(ls -d specs app_docs adws/adw_data/ssmf.db trace.db run.log 2>/dev/null || true)
if [ -z "$P" ]; then echo "NOARTIFACTS"; exit 0; fi
tar czf ../harvest-artifacts.tgz $P
echo "TARBUILT"
`.trim();
}

// ─── preflight ───────────────────────────────────────────────────────────────

function getRecord(deps: HarvestDeps, runId: string): RunRecord {
  try {
    return deps.store.get(runId);
  } catch (e) {
    throw new HarvestError(
      "no-record",
      `no run record for ${runId}: ${(e as Error).message}`,
      "check the run id; records live under $QDS_RUNS_DIR (default .sandbox/runs) — create the run first",
    );
  }
}

async function requireHostRepo(gitRunner: GitRunner, gitCwd: string): Promise<void> {
  const res = await gitRunner(["git", "rev-parse", "--show-toplevel"], gitCwd);
  if (res.exitCode !== 0) {
    throw new HarvestError(
      "no-host-repo",
      `${gitCwd} is not a git repository — the quarantine fetch would land nowhere`,
      "run harvest from inside the host git checkout, or point deps.gitCwd at one",
    );
  }
}

// ─── harvest ─────────────────────────────────────────────────────────────────

interface StepA {
  protocol: "OK" | "NOREPO" | "NOCOMMITS";
  tip?: string;
  count?: number;
}

export interface HarvestRunOptions {
  /**
   * Ownership signal for the artifact pipeline: teardown pulls artifacts as
   * its own step 2 BEFORE invoking harvestRun, so it passes this to make
   * harvestRun skip its Step E — exactly one artifact pull per successful
   * teardown. Standalone harvestRun calls leave it unset and always pull.
   */
  artifactsOwnedByCaller?: boolean;
}

export async function harvestRun(
  deps: HarvestDeps,
  runId: string,
  opts: HarvestRunOptions = {},
): Promise<HarvestResult> {
  const started = Date.now();
  const ctx = stepCtx(deps, runId);
  const rec = getRecord(deps, runId);
  // inkwell prerequisite: a run that never got a VM has nothing to harvest and
  // no box to pull artifacts from — exit 0 "none", not an error.
  if (!rec.vmName) {
    logSummary(ctx, started, { outcome: "none" }, { artifacts: "none" });
    return { outcome: "none" };
  }
  // A VM without a pinned base (a FILL that died mid-flight) can still hold
  // artifacts: no bundle steps, but Step E runs — the work must not be lost.
  if (!rec.commitSha) {
    const art = opts.artifactsOwnedByCaller ? { artifacts: "none" as const } : await pullArtifacts(deps, runId);
    logSummary(ctx, started, { outcome: "none" }, art);
    return { outcome: "none" };
  }
  const vm = rec.vmName;
  const base = rec.commitSha;
  const branch = `sbx/${runId}`;
  const gitRunner = deps.gitRunner ?? bunGitRunner;
  const gitCwd = deps.gitCwd ?? process.cwd();
  const runsDir = resolveRunsDir(deps);
  const hostBundle = join(runsDir, `${runId}.bundle`);

  try {
    await requireHostRepo(gitRunner, gitCwd);
  } catch (e) {
    const err = e as HarvestError;
    logPreflightError(ctx, err);
    throw err;
  }

  const workdirs = workdirList(deps);

  // Step A — in-box ranged bundle (protocol on stdout).
  const stepA = await timedStep<StepA>(ctx, "bundle_create", async () => {
    const res = await deps.driver.exec(vm, ["bash", "-s", "--", base, branch], remoteScript(workdirs));
    if (res.exitCode !== 0) {
      // rev-list/bundle plumbing died under set -euo pipefail (e.g. the base
      // sha is unknown in-box) — a real failure, box evidence included.
      throw new HarvestError(
        "bundle-create-failed",
        `in-box bundle creation for ${runId} exited ${res.exitCode}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box repo by hand via the driver, then re-run harvest — the box is still alive",
      );
    }
    const line = res.stdout.trim();
    if (line === "NOREPO" || line === "NOCOMMITS") return { protocol: line };
    if (line === "BUNDLEFAIL") {
      throw new HarvestError(
        "bundle-create-failed",
        `git bundle create failed in-box for ${runId}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box repo by hand via the driver, then re-run harvest — the box is still alive",
      );
    }
    const m = /^OK ([0-9a-f]{40,64}) (\d+)$/.exec(line);
    if (!m) {
      // Untrusted box stdout — quote at most the first line, never more.
      throw new HarvestError(
        "remote-protocol",
        `unexpected in-box protocol output for ${runId}: ${JSON.stringify(line.split("\n")[0] ?? "")}`,
        "inspect the box by hand (stdout broke the harvest protocol), then re-run",
      );
    }
    return { protocol: "OK", tip: m[1] ?? "", count: Number(m[2]) };
  });

  let result: HarvestResult = { outcome: "none" };
  if (stepA.protocol === "OK") {
    // Step B — copy down (box-root-relative remote path; the seam's path guard
    // rejects absolutes on real substrates).
    await timedStep(ctx, "transfer", async () => {
      try {
        await deps.driver.copyFile(vm, "harvest.bundle", hostBundle);
      } catch (e) {
        // copyFile may reject with a non-Error — coerce, or sanitizeBoxOutput
        // would itself throw on undefined inside this catch.
        throw new HarvestError(
          "bundle-copy-failed",
          `copying harvest.bundle out of ${vm} failed: ${sanitizeBoxOutput(e instanceof Error ? e.message : String(e))}`,
          "re-run harvest — the box is still alive; if it repeats, copy the bundle out by hand",
        );
      }
    });

    // Step C — cap, then verify STRICTLY BEFORE FETCH (INV-2). The bundle file
    // is kept on every failure here: it is the only copy of the work.
    await timedStep(ctx, "verify", async () => {
      const size = statSync(hostBundle).size;
      if (size > BUNDLE_MAX_BYTES) {
        throw new HarvestError(
          "bundle-over-cap",
          `bundle ${hostBundle} is ${size} received bytes, over the ${BUNDLE_MAX_BYTES}-byte cap (file kept for inspection)`,
          `inspect ${hostBundle} by hand, split the run's work, then delete it and re-run`,
        );
      }
      const v = await gitRunner(["git", "bundle", "verify", hostBundle], gitCwd);
      if (v.exitCode !== 0) {
        // git names each missing prerequisite on its own "error: <sha>" line
        // (verified against git 2.x): the range IS the integrity check.
        const missing = [...v.stderr.matchAll(/^error: ([0-9a-f]{40,64})/gm)].map((mm) => mm[1] ?? "");
        if (missing.length > 0) {
          throw new HarvestError(
            "missing-prerequisite",
            `host repo lacks prerequisite commit${missing.length > 1 ? "s" : ""} ${missing.join(", ")} required by ${hostBundle} — the box branch does not descend from the FILL-pinned base`,
            "the box branch diverged from the pinned base; inspect refs/sandbox and the box repo by hand before re-running",
          );
        }
        throw new HarvestError(
          "bundle-verify-failed",
          `git bundle verify failed for ${hostBundle}: ${v.stderr.trim()}`,
          `run git bundle verify ${hostBundle} by hand in the host repo, then re-run`,
        );
      }
    });

    // Step D — fetch into the quarantine namespace ONLY. --force makes a
    // re-harvest update in place instead of failing on non-fast-forward (AC5).
    await timedStep(ctx, "fetch", async () => {
      const f = await gitRunner(
        ["git", "fetch", "--force", hostBundle, `refs/heads/${branch}:refs/sandbox/${runId}`],
        gitCwd,
      );
      if (f.exitCode !== 0) {
        throw new HarvestError(
          "fetch-failed",
          `git fetch from ${hostBundle} into refs/sandbox/${runId} failed: ${f.stderr.trim()}`,
          `run git fetch --force ${hostBundle} refs/heads/${branch}:refs/sandbox/${runId} by hand in the host repo, then re-run`,
        );
      }
    });
    result = { outcome: "harvested", count: stepA.count ?? 0, tip: stepA.tip ?? "" };
  } else {
    // AC4: an empty range is a successful no-op — no ref, no bundle file left.
    rmSync(hostBundle, { force: true });
  }

  // Step E — artifacts (not gated on commits; runs even when outcome is none).
  // Skipped when the caller (teardown's step 2) already owns the pipeline.
  const art: ArtifactsOutcome = opts.artifactsOwnedByCaller
    ? { artifacts: "none" } // the caller's own artifacts step did the pull
    : await pullArtifacts(deps, runId);
  logSummary(ctx, started, result, art);
  return result;
}

function logSummary(ctx: StepCtx, started: number, result: HarvestResult, art: ArtifactsOutcome): void {
  const durationMs = Date.now() - started;
  log({
    requestId: ctx.requestId,
    operation: "harvest.summary",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: durationMs,
    status: "ok",
    runId: ctx.runId,
    step: "summary",
    driver: ctx.driver,
    durationMs,
    outcome: "ok",
    harvested: result.outcome === "harvested" ? result.count : "none",
    artifacts: art.artifacts,
  });
}

/**
 * Artifacts-only pull (teardown's step 2; harvestRun's last step). Validates
 * the tgz before extracting a byte (INV-3) and is idempotent: the destination
 * is rebuilt, never merged, so a re-pull leaves no stale files.
 */
export async function pullArtifacts(deps: HarvestDeps, runId: string): Promise<ArtifactsOutcome> {
  const ctx = stepCtx(deps, runId);
  const rec = getRecord(deps, runId);
  if (!rec.vmName) return { artifacts: "none" }; // no box was ever created
  const vm = rec.vmName;
  const runsDir = resolveRunsDir(deps);
  const dest = join(runsDir, `${runId}-artifacts`);
  const staging = join(runsDir, `${runId}-artifacts.tgz`);

  return timedStep(ctx, "artifacts", async () => {
    const res = await deps.driver.exec(vm, ["bash", "-s"], artifactsScript(workdirList(deps)));
    if (res.exitCode !== 0) {
      throw new HarvestError(
        "artifacts-failed",
        `in-box artifacts tar for ${runId} exited ${res.exitCode}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box's artifacts by hand via the driver, then re-run harvest — the box is still alive",
      );
    }
    const line = res.stdout.trim();
    if (line === "NOARTIFACTS") {
      // Absent artifacts: the host dir must not exist afterwards.
      rmSync(dest, { recursive: true, force: true });
      return { artifacts: "none" };
    }
    if (line !== "TARBUILT") {
      throw new HarvestError(
        "remote-protocol",
        `unexpected in-box artifacts protocol output for ${runId}: ${JSON.stringify(line.split("\n")[0] ?? "")}`,
        "inspect the box by hand (stdout broke the harvest protocol), then re-run",
      );
    }
    try {
      await deps.driver.copyFile(vm, "harvest-artifacts.tgz", staging);
    } catch (e) {
      throw new HarvestError(
        "artifacts-failed",
        `copying harvest-artifacts.tgz out of ${vm} failed: ${sanitizeBoxOutput(e instanceof Error ? e.message : String(e))}`,
        "re-run harvest — the box is still alive; if it repeats, copy the tar out by hand",
      );
    }
    const files = await validateAndExtractTgz(staging, dest);
    rmSync(staging, { force: true });
    return { artifacts: "pulled", files };
  });
}

// ─── tar validator (INV-3) ───────────────────────────────────────────────────

const BLOCK = 512;
const ALLOWED_TYPEFLAGS = new Set(["0", "\0", "5"]);
/**
 * Extended-metadata headers, not extractable entries: pax per-file ('x') and
 * global ('g') records (bsdtar emits them for sub-second mtimes), GNU long
 * name/link ('L'/'K'). They are consumed as data and never written — but the
 * `path=`/long-name override they carry for the NEXT entry is re-validated by
 * the same assertPathSafe as a literal name, so metadata cannot smuggle a
 * traversal past the INV-3 gate. Everything else outside {'0','\0','5'} is
 * rejected outright.
 */
const METADATA_TYPEFLAGS = new Set(["x", "g", "L", "K"]);

export interface TarEntryHeader {
  name: string;
  typeflag: string;
  size: number;
}

interface TarHandlers {
  /** Called per header AFTER it passed validation (pass 2 opens its writer). */
  onEntry(header: TarEntryHeader): void;
  onData(chunk: Buffer): void;
  onEntryEnd(): void;
}

function parseOctal(field: Buffer): number {
  const s = field.toString("ascii").replace(/[\0 ].*$/s, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) return Number.NaN;
  return Number.parseInt(s, 8);
}

/** Checksum: all 512 bytes summed with the chksum field (148..156) as spaces. */
function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i] ?? 0;
  const stored = parseOctal(block.subarray(148, 156));
  return sum === stored;
}

function nulStr(field: Buffer): string {
  return field.toString("utf8").replace(/\0.*$/s, "");
}

/**
 * Absolute, ".."-segment and empty names are refused — linknames too. The name
 * is canonicalized (".", "" and repeated "/" segments dropped) so aliases like
 * "./a" vs "a" or "a//b" vs "a/b" cannot slip past the duplicate/ancestor
 * checks in pass 1 and collide as a raw EEXIST mid-extraction in pass 2 —
 * `join(destDir, name)` normalizes, so the validated name must be canonical.
 */
function assertPathSafe(kind: "name" | "linkname", raw: string): string {
  const name = raw.replace(/\/+$/, "").split("/").filter((s) => s !== "" && s !== ".").join("/");
  if (name === "" || raw.startsWith("/") || raw.split("/").includes("..")) {
    throw new HarvestError(
      "tar-unsafe-entry",
      `artifacts tar ${kind} ${JSON.stringify(raw)} is absolute, empty, or traverses ".." — refusing to extract`,
      "inspect the staging tar by hand before re-running; the box is still alive",
    );
  }
  return name;
}

/** Ancestor directory paths of a validated name: "a/b/c" → ["a", "a/b"]. */
function ancestorsOf(name: string): string[] {
  const out: string[] = [];
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) out.push(name.slice(0, i));
  return out;
}

interface ParsedHeader {
  rawName: string;
  rawLinkname: string;
  typeflag: string;
  size: number;
}

function parseHeader(block: Buffer): ParsedHeader {
  if (nulStr(block.subarray(257, 262)) !== "ustar") {
    throw new HarvestError("tar-invalid", "artifacts tar entry has no ustar magic", tarRemediation);
  }
  if (!checksumOk(block)) {
    throw new HarvestError("tar-invalid", "artifacts tar entry failed its header checksum", tarRemediation);
  }
  const size = parseOctal(block.subarray(124, 136));
  if (!Number.isFinite(size)) {
    throw new HarvestError("tar-invalid", "artifacts tar entry has an unparseable size field", tarRemediation);
  }
  const prefix = nulStr(block.subarray(345, 500));
  const rawName = prefix ? `${prefix}/${nulStr(block.subarray(0, 100))}` : nulStr(block.subarray(0, 100));
  return { rawName, rawLinkname: nulStr(block.subarray(157, 257)), typeflag: String.fromCharCode(block[156] ?? 0), size };
}

const tarRemediation =
  "inspect the staging tar by hand (tar tvf) before re-running; the box is still alive";

/**
 * Incremental 512-block parser. Data blocks are consumed as they arrive, so
 * memory stays bounded no matter how large an entry claims to be; the caps
 * (decompressed running total, summed entry sizes) are checked here.
 */
function makeTarParser(handlers: TarHandlers, fail: (e: HarvestError) => void): {
  push(chunk: Buffer): void;
  finish(): void;
} {
  let buf = Buffer.alloc(0);
  let inData = false;
  let remaining = 0;
  let pad = 0;
  let sawEof = false;
  let failed = false;
  let total = 0; // decompressed bytes seen
  let summed = 0; // summed declared entry sizes
  const names = new Set<string>();
  const filePaths = new Set<string>(); // accepted regular-file names
  const dirPaths = new Set<string>(); // '5' entry names + implicit ancestors
  let meta: { kind: string; chunks: Buffer[] } | null = null;
  let pendingName: string | null = null; // next-entry override from 'x'/'L'
  let pendingLinkname: string | null = null; // next-entry override from 'K'
  let globalPath: string | null = null; // 'g' default path

  /** Apply a metadata entry's payload once its data blocks are consumed. */
  function applyMetadata(data: Buffer): void {
    if (meta === null) return;
    if (meta.kind === "x" || meta.kind === "g") {
      const matches = [...data.toString("utf8").matchAll(/(?:^|\n)\d+ path=([^\n]*)/g)];
      const path = matches.at(-1)?.[1];
      if (path !== undefined) {
        if (meta.kind === "g") globalPath = path;
        else pendingName = path;
      }
      return;
    }
    const raw = data.toString("utf8").replace(/\0.*$/s, "");
    if (meta.kind === "L") pendingName = raw;
    else pendingLinkname = raw;
  }

  return {
    push(chunk: Buffer): void {
      if (failed || sawEof) return;
      try {
        total += chunk.length;
        if (total > TAR_MAX_BYTES) {
          failed = true;
          fail(
            new HarvestError(
              "tar-over-cap",
              `artifacts tar decompressed past the ${TAR_MAX_BYTES}-byte cap (${total} bytes) — nothing extracted`,
              tarRemediation,
            ),
          );
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (!inData) {
            if (buf.length < BLOCK) return;
            const block = buf.subarray(0, BLOCK);
            if (block.every((b) => b === 0)) {
              sawEof = true; // trailing bytes after the EOF block are ignored
              return;
            }
            const parsed = parseHeader(block);
            summed += parsed.size;
            if (summed > TAR_MAX_BYTES || parsed.size > TAR_MAX_BYTES) {
              throw new HarvestError(
                "tar-over-cap",
                `artifacts tar entry sizes sum past the ${TAR_MAX_BYTES}-byte cap (${summed} declared) — nothing extracted`,
                tarRemediation,
              );
            }
            if (METADATA_TYPEFLAGS.has(parsed.typeflag)) {
              meta = { kind: parsed.typeflag, chunks: [] };
            } else if (ALLOWED_TYPEFLAGS.has(parsed.typeflag)) {
              // The override path (pax 'path=' / GNU longname) replaces the
              // header name wholesale and passes the SAME safety gate.
              const name = assertPathSafe("name", pendingName ?? globalPath ?? parsed.rawName);
              const linkname = pendingLinkname ?? parsed.rawLinkname;
              if (linkname !== "") assertPathSafe("linkname", linkname);
              if (names.has(name)) {
                throw new HarvestError(
                  "tar-unsafe-entry",
                  `artifacts tar lists duplicate path ${JSON.stringify(name)} — no overwrite`,
                  tarRemediation,
                );
              }
              // A file at a path that must be a directory (or the reverse) would fail mid-extraction with a raw errno — reject in pass 1 so nothing is written.
              const isDir = parsed.typeflag === "5";
              const fileAncestor = ancestorsOf(name).find((a) => filePaths.has(a));
              if (fileAncestor !== undefined || (isDir ? filePaths : dirPaths).has(name)) {
                throw new HarvestError(
                  "tar-unsafe-entry",
                  `artifacts tar entry ${JSON.stringify(name)} conflicts with an earlier file at ${JSON.stringify(fileAncestor ?? name)} — no overwrite`,
                  tarRemediation,
                );
              }
              for (const a of ancestorsOf(name)) dirPaths.add(a);
              (isDir ? dirPaths : filePaths).add(name);
              names.add(name);
              handlers.onEntry({ name, typeflag: parsed.typeflag, size: parsed.size });
            } else {
              // Hard links, symlinks, char/block devices, FIFOs, and anything
              // else that is not a regular file or a directory (INV-3).
              throw new HarvestError(
                "tar-unsafe-entry",
                `artifacts tar entry carries disallowed typeflag ${JSON.stringify(parsed.typeflag)}`,
                tarRemediation,
              );
            }
            pendingName = null;
            pendingLinkname = null;
            buf = buf.subarray(BLOCK);
            inData = true;
            remaining = parsed.size;
            pad = (BLOCK - (parsed.size % BLOCK)) % BLOCK;
          } else {
            if (remaining > 0) {
              const take = Math.min(remaining, buf.length);
              if (take > 0) {
                if (meta !== null) meta.chunks.push(buf.subarray(0, take));
                else handlers.onData(buf.subarray(0, take));
                buf = buf.subarray(take);
                remaining -= take;
              }
              if (remaining > 0) return; // need more data
            }
            if (pad > 0) {
              const take = Math.min(pad, buf.length);
              buf = buf.subarray(take);
              pad -= take;
              if (pad > 0) return;
            }
            if (meta !== null) {
              applyMetadata(Buffer.concat(meta.chunks));
              meta = null;
            } else {
              handlers.onEntryEnd();
            }
            inData = false;
          }
        }
      } catch (e) {
        failed = true;
        fail(e as HarvestError);
      }
    },
    finish(): void {
      if (!sawEof) {
        throw new HarvestError(
          "tar-truncated",
          "artifacts tar ended without an all-zero EOF block — nothing extracted",
          tarRemediation,
        );
      }
    },
  };
}

/**
 * Stream a (possibly gzipped) tar through the parser once. Sniffs 1f 8b to
 * pick gunzip vs passthrough. Bun 1.2.22 gotchas (verified in the /tmp POC):
 * `once(em, ["end","close"])` never resolves — await single events; and a
 * stream's `destroy(cb)` callback never fires after natural EOF — use plain
 * `.destroy()`, which is all the bomb-abort path needs.
 */
async function streamTar(tgzPath: string, handlers: TarHandlers): Promise<void> {
  const fd = openSync(tgzPath, "r");
  const head = Buffer.alloc(2);
  const n = readSync(fd, head, 0, 2, 0);
  closeSync(fd);
  const isGzip = n === 2 && head[0] === 0x1f && head[1] === 0x8b;

  const src = createReadStream(tgzPath);
  const out = isGzip ? createGunzip() : new PassThrough();
  src.pipe(out);
  let failure: HarvestError | undefined;
  const fail = (e: HarvestError): void => {
    if (!failure) {
      failure = e;
      out.destroy(e);
      src.destroy();
    }
  };
  const parser = makeTarParser(handlers, fail);
  // A read-side error (EIO, file swapped mid-read) must not escape as an
  // unhandled 'error' event on src: route it through fail so out is destroyed
  // and the race below settles with the structured HarvestError.
  src.on("error", (e: Error) => {
    fail(new HarvestError("tar-invalid", `artifacts stream could not be read: ${e.message}`, tarRemediation));
  });
  out.on("data", (c: Buffer) => {
    if (failure === undefined) parser.push(c);
  });
  try {
    await Promise.race([
      once(out, "end"),
      once(out, "error").then((args) => {
        throw args[0];
      }),
    ]);
  } catch (e) {
    if (failure) throw failure;
    throw new HarvestError(
      "tar-invalid",
      `artifacts stream is not a valid ${isGzip ? "gzip" : "tar"} stream: ${(e as Error).message}`,
      tarRemediation,
    );
  }
  if (failure) throw failure;
  parser.finish();
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Pass-2 writer: dirs (explicit + implicit parents) 0700, files wx/0600. */
function extractHandlers(destDir: string): TarHandlers {
  let fd: number | null = null;
  return {
    onEntry(header: TarEntryHeader): void {
      const target = join(destDir, header.name);
      if (header.typeflag === "5") {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        return;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      fd = openSync(target, "wx", 0o600);
    },
    onData(chunk: Buffer): void {
      if (fd !== null) writeAll(fd, chunk);
    },
    onEntryEnd(): void {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}

/**
 * Two passes over the staging tgz: pass 1 validates everything (structure,
 * entry types, path safety, duplicates, both caps) and pass 2 extracts into a
 * freshly rebuilt destination. Pass 2 only ever runs after a clean pass 1, so
 * a rejected tar leaves nothing written.
 */
async function validateAndExtractTgz(tgzPath: string, destDir: string): Promise<number> {
  const received = statSync(tgzPath).size;
  if (received > TAR_MAX_BYTES) {
    throw new HarvestError(
      "tar-over-cap",
      `artifacts tar ${tgzPath} is ${received} received bytes, over the ${TAR_MAX_BYTES}-byte cap — nothing extracted`,
      tarRemediation,
    );
  }
  let files = 0;
  await streamTar(tgzPath, {
    // Count regular files only — '5' directory entries are not files.
    onEntry: (header) => {
      if (header.typeflag !== "5") files++;
    },
    onData: () => {},
    onEntryEnd: () => {},
  });
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  // Atomic extraction: a failed pass 2 leaves no partial destination.
  try {
    await streamTar(tgzPath, extractHandlers(destDir));
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
  return files;
}
