/**
 * Git test fixture for the DF2.5 harvest/teardown suites (and reusable by any
 * later test that needs a throwaway repo).
 *
 * Everything is hermetic: origins live under mkdtemp `qds-df25-` roots and are
 * reached only through `file://` clone URLs, so no network is touched. Roots
 * are returned, never cleaned here — callers rmSync them in `finally`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderDriver } from "../../../src/providers/driver.ts";

/** Runs a host command; non-zero exit throws with the captured stderr. */
export async function runLocal(argv: string[]): Promise<string> { /* dp:ok a rejection here is the test failing — there is nothing to recover */
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`runLocal ${argv.join(" ")} exited ${code}: ${stderr}${stdout ? ` (stdout: ${stdout})` : ""}`);
  return stdout;
}

/** Runs `git` in an arbitrary host dir, returning trimmed stdout. */
export async function hostGit(cwd: string, argv: string[]): Promise<string> {
  return (await runLocal(["git", "-C", cwd, ...argv])).trim();
}

export interface OriginRepo {
  /** Temp root owning everything below — caller cleans this. */
  root: string;
  originDir: string;
  /** HEAD after the commits — the sha a FILL would pin. */
  baseSha: string;
  /** All commit shas, oldest first. */
  shas: string[];
}

/**
 * A fresh origin repo: `git init -b main` plus `commits` empty commits
 * (`--allow-empty`, inline test identity so no global git config is read).
 */
export async function makeOriginRepo(
  opts: { commits?: number; slug?: string } = {},
): Promise<OriginRepo> {
  const commits = opts.commits ?? 3;
  const root = mkdtempSync(join(tmpdir(), "qds-df25-"));
  const slug = opts.slug ?? "origin";
  const originDir = join(root, slug);
  await runLocal(["git", "init", "-q", "-b", "main", originDir]);
  const shas: string[] = [];
  for (let i = 0; i < commits; i++) {
    await runLocal([
      "git",
      "-C",
      originDir,
      "-c",
      "user.email=test@qds",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "--allow-empty",
      // ponytail: slug-prefixed message — same-second identical root commits
      // ("origin" vs "unrelated") otherwise collide into one sha (AC2 flake).
      "-m",
      `${slug}-c${i + 1}`,
    ]);
    shas.push(await hostGit(originDir, ["rev-parse", "HEAD"]));
  }
  const baseSha = await hostGit(originDir, ["rev-parse", "HEAD"]);
  return { root, originDir, baseSha, shas };
}

/**
 * A repo whose history shares no ancestor with `makeOriginRepo`'s — its own
 * mkdtemp root and its own root commit — so a branch built on it cannot
 * descend from a base pinned in the other repo (the AC2 non-descendant case).
 */
export async function makeUnrelatedRepo(): Promise<OriginRepo> {
  return makeOriginRepo({ commits: 1, slug: "unrelated" });
}

/**
 * Clones an origin into a box over `file://` — and nothing else. Branching
 * (`sbx/<run-id>`) is FILL's job; this fixture stays at the clone step so
 * tests can pin whatever base they need.
 */
export async function cloneIntoBox(
  driver: ProviderDriver,
  vm: string,
  originDir: string,
  workdir = "app",
): Promise<void> {
  const res = await driver.exec(vm, ["git", "clone", "-q", `file://${originDir}`, workdir]);
  if (res.exitCode !== 0) {
    throw new Error(`cloneIntoBox(${vm}) exited ${res.exitCode}: ${res.stderr}`);
  }
}
