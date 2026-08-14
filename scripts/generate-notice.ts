#!/usr/bin/env bun
/**
 * NOTICE generator + compliance gate for the QDS-Factory enterprise OCI image
 * (story DF2.9).
 *
 * Sweeps a real post-build dependency tree (see `scripts/lib/license-sweep.ts`)
 * and either writes the NOTICE that ships at
 * `/usr/share/doc/qds-factory/NOTICE` or fails the build. It is both the
 * generator and the gate — there is no mode in which it produces a NOTICE it
 * knows to be incomplete.
 *
 * Exit codes (the story's observability contract):
 *   0  clean — NOTICE written and verified to cover every uncovered package
 *   1  compliance failure — denied package, broken version pin, empty tree, or
 *      a NOTICE that fails coverage verification
 *   2  fatal before the sweep could conclude — no tree, no license-texts dir,
 *      an unresolvable license, or an observed SPDX identifier with no
 *      canonical text checked in (INV-4)
 *
 * Ordering is load-bearing (INV-2): the denylist runs before generation, so a
 * forbidden package can never be laundered into compliance by being written
 * into NOTICE, and no NOTICE file exists for a build that tripped it.
 *
 * Usage:
 *   bun scripts/generate-notice.ts --tree <dir> [--out <file>]
 *        [--license-texts <dir>] [--summary <file>] [--image-ref <ref>]
 *        [--install-flags <flags>]
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { exitWithFailure, parseValueFlags } from "./lib/cli-args.ts";
import { renderNotice, summarize, sweepTree, verifyNoticeCoverage } from "./lib/license-sweep.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const HELP = [
  "usage: bun scripts/generate-notice.ts --tree <dir> [options]",
  "",
  "  --tree <dir>           package root (or node_modules dir) to sweep [required]",
  "  --out <file>           NOTICE output path [oci/.build/NOTICE]",
  "  --license-texts <dir>  canonical texts, one <SPDX-id>.txt each [oci/license-texts]",
  "  --summary <file>       write the structured JSON summary here",
  "  --image-ref <ref>      image reference recorded in the NOTICE header",
  "  --install-flags <s>    install flags recorded in the NOTICE header",
  "",
  "exit: 0 clean · 1 compliance failure · 2 fatal before the sweep concluded",
  "",
].join("\n");

interface Options {
  tree: string | null;
  out: string;
  licenseTexts: string;
  summary: string | null;
  imageRef: string;
  installFlags: string;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    tree: null,
    out: path.join(REPO_ROOT, "oci/.build/NOTICE"),
    licenseTexts: path.join(REPO_ROOT, "oci/license-texts"),
    summary: null,
    imageRef: "qds-factory:local",
    installFlags: "--omit=optional",
  };
  parseValueFlags(argv, {
    flags: ["--tree", "--out", "--license-texts", "--summary", "--image-ref", "--install-flags"],
    help: [HELP],
    onValue: (flag, value) => {
      if (flag === "--tree") opts.tree = path.resolve(value);
      else if (flag === "--out") opts.out = path.resolve(value);
      else if (flag === "--license-texts") opts.licenseTexts = path.resolve(value);
      else if (flag === "--summary") opts.summary = path.resolve(value);
      else if (flag === "--image-ref") opts.imageRef = value;
      else opts.installFlags = value;
    },
  });
  return opts;
}

function fail(code: 1 | 2, lines: readonly string[]): never {
  return exitWithFailure("license sweep FAILED:", code, lines);
}

function main(): void {
  // A bad invocation is "fatal before the sweep ran", i.e. exit 2 — not an
  // uncaught throw, whose exit 1 would read as a compliance failure.
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(2, [err instanceof Error ? err.message : String(err)]);
  }
  if (opts.tree === null) fail(2, ["--tree is required (the tree to sweep)"]);
  if (!fs.existsSync(opts.tree)) fail(2, [`tree not found: ${opts.tree}`]);
  if (!fs.existsSync(opts.licenseTexts) || !fs.statSync(opts.licenseTexts).isDirectory()) {
    fail(2, [`license-texts directory not found: ${opts.licenseTexts}`]);
  }

  const meta = {
    imageRef: opts.imageRef,
    installFlags: opts.installFlags,
    sweptAt: new Date().toISOString(),
  };

  let result: ReturnType<typeof sweepTree>;
  try {
    result = sweepTree({ treeRoot: opts.tree, licenseTextsDir: opts.licenseTexts });
  } catch (err) {
    fail(2, [err instanceof Error ? err.message : String(err)]);
  }

  const emit = (exitCode: number, noticeBytes: number): void => {
    const summary = summarize(result, meta, noticeBytes, exitCode);
    const json = JSON.stringify(summary, null, 2);
    // Every failure path calls this and then `fail()`, which exits right
    // after. `process.stdout.write` on a pipe is async — a `process.exit`
    // racing it can drop or truncate this JSON. `fs.writeSync` blocks until
    // the write lands, same fix already applied to `exitWithFailure`'s
    // stderr write (cli-args.ts).
    fs.writeSync(1, `${json}\n`);
    if (opts.summary !== null) {
      fs.mkdirSync(path.dirname(opts.summary), { recursive: true });
      fs.writeFileSync(opts.summary, `${json}\n`);
    }
  };

  // INV-2: the denylist runs FIRST — before generation, before any tag.
  if (result.denied.length > 0) {
    emit(1, 0);
    fail(
      1,
      result.denied.map(
        (e) => `denied package ${e.name}@${e.version} at "${e.depPath}" — it can never be remediated by attribution`,
      ),
    );
  }

  if (result.pinViolations.length > 0) {
    emit(1, 0);
    fail(1, result.pinViolations);
  }

  if (result.treePackageCount === 0) {
    emit(1, 0);
    fail(1, ["the swept tree is empty — an empty sweep is a failure, never a vacuous pass"]);
  }

  // INV-4: fail closed on anything the sweep cannot attribute, BEFORE writing.
  if (result.unresolved.length > 0) {
    emit(2, 0);
    fail(
      2,
      result.unresolved.map(
        (e) => `${e.name}@${e.version} at "${e.depPath}" declares no license and ships no license text`,
      ),
    );
  }
  if (result.unreadable.length > 0) {
    emit(2, 0);
    fail(
      2,
      result.unreadable.map(
        (p) => `could not read ${p} — a package the sweep cannot inspect is never assumed permissive`,
      ),
    );
  }
  if (result.missingTexts.length > 0) {
    emit(2, 0);
    fail(
      2,
      result.missingTexts.map(
        (m) =>
          `no canonical license text checked in for SPDX identifier "${m.id}" (${m.packages.join(", ")}) — add ${m.id}.txt under ${path.relative(REPO_ROOT, opts.licenseTexts) || opts.licenseTexts}`,
      ),
    );
  }

  // Rendering reads upstream NOTICE bytes and refuses to emit an entry with no
  // license text. Either failure happens before the sweep could conclude, so it
  // is exit 2 — an uncaught throw would exit 1 and read as a compliance verdict.
  let notice: string;
  try {
    notice = renderNotice(result, meta);
  } catch (err) {
    emit(2, 0);
    fail(2, [err instanceof Error ? err.message : String(err)]);
  }
  const missing = verifyNoticeCoverage(notice, result.uncovered);
  if (missing.length > 0) {
    emit(1, 0);
    fail(1, missing.map((m) => `${m} ships no license text and is absent from the generated NOTICE`));
  }

  const bytes = Buffer.byteLength(notice, "utf8");
  if (bytes === 0) {
    emit(1, 0);
    fail(1, ["the generated NOTICE is zero bytes"]);
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, notice);
  emit(0, bytes);
}

main();
