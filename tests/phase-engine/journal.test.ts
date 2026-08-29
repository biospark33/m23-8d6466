/**
 * F056 — one run-root derivation.
 *
 * The run root used to be derived four ways (journal, pipeline-run, tracer,
 * dispatch-task). These tests pin the single derivation: `runMarkerRoot()`,
 * exported from the phase-engine's public surface, and no consumer reading
 * `QDS_RUN_ROOT` on its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runMarkerRoot } from "../../src/phase-engine/index.ts";

const saved = process.env.QDS_RUN_ROOT;
afterEach(() => {
  // biome-ignore lint/performance/noDelete: unset is the semantic — assignment would leave "undefined" in the env.
  if (saved === undefined) delete process.env.QDS_RUN_ROOT;
  else process.env.QDS_RUN_ROOT = saved;
});

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

describe("runMarkerRoot", () => {
  test("unset QDS_RUN_ROOT resolves to the in-box production root", () => {
    // biome-ignore lint/performance/noDelete: unset is the semantic — assignment would leave "undefined" in the env.
    delete process.env.QDS_RUN_ROOT;
    expect(runMarkerRoot()).toBe("/run");
  });

  test("a set QDS_RUN_ROOT wins", () => {
    process.env.QDS_RUN_ROOT = "/tmp/qds-run-root";
    expect(runMarkerRoot()).toBe("/tmp/qds-run-root");
  });

  // Deferred from Task 2.5: an empty or whitespace-only value is not a root.
  for (const empty of ["", "   ", "\t\n"]) {
    test(`QDS_RUN_ROOT=${JSON.stringify(empty)} is treated as unset`, () => {
      process.env.QDS_RUN_ROOT = empty;
      expect(runMarkerRoot()).toBe("/run");
    });
  }
});

describe("F056: every consumer derives the run root through runMarkerRoot", () => {
  // The three phase-root consumers must not re-implement the fallback; a fresh
  // `process.env.QDS_RUN_ROOT ?? ...` in any of them is the rot coming back.
  for (const rel of [
    "scripts/pipeline-run.ts",
    "src/phase-engine/trace/tracer.ts",
    "src/phase-engine/journal.ts",
  ]) {
    test(`${rel} reads QDS_RUN_ROOT only inside runMarkerRoot`, () => {
      const reads = read(rel).match(/process\.env\.QDS_RUN_ROOT/g) ?? [];
      expect(reads.length).toBe(rel.endsWith("journal.ts") ? 1 : 0);
    });
  }

  test("dispatch-task derives its run root once", () => {
    const src = read("src/phase-engine/phases/dispatch-task.ts");
    expect((src.match(/process\.env\.QDS_RUN_ROOT/g) ?? []).length).toBe(1);
  });
});
