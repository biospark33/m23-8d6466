/**
 * Unit tests for the capture-run-of-record containment seam —
 * `pathContains` + `refuseOutOverlap`'s realpath resolution (`realpathThroughAbsent`).
 *
 * The script's refusal flow itself runs `refuse()` → process.exit, which cannot be
 * exercised in-process, so the tests pin the COMPOSITION refuseOutOverlap performs:
 * resolve both sides through their existing (possibly symlinked) components, then
 * segment-contain. That composition is the fix for the lexical-resolution hole where
 * `--out /link/fixture` over a symlinked runs dir passed a `resolve()`-only check and
 * then wrote the fixture into live capture evidence.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { pathContains, realpathThroughAbsent } from "../../scripts/dev/capture-run-of-record.ts";

describe("pathContains — segment containment (the contract refuseOutOverlap composes)", () => {
  test("a string-prefix neighbour is not contained", () => {
    expect(pathContains("/tmp/out", "/tmp/outfox")).toBe(false);
  });

  test("a descendant is contained; equality is containment; a parent is not", () => {
    expect(pathContains("/tmp/out", "/tmp/out/inner/deep")).toBe(true);
    expect(pathContains("/tmp/out", "/tmp/out")).toBe(true);
    expect(pathContains("/tmp/out/inner", "/tmp/out")).toBe(false);
  });
});

describe("realpathThroughAbsent — resolve existing components, keep the absent tail lexical", () => {
  const mk = (): string => mkdtempSync(join(resolve(import.meta.dir), "capture-out-"));

  test("a symlinked ancestor redirects the resolution; absent leaves stay lexical", () => {
    const root = mk();
    try {
      const real = join(root, "real");
      const payload = join(real, "runs");
      mkdirSync(payload, { recursive: true });
      const link = join(root, "link");
      symlinkSync(payload, link);
      // `link/absent-sub/fixture` does not exist — the deepest EXISTING component
      // (`link`) is what mkdir(2) will walk through, and it is what must resolve.
      const got = realpathThroughAbsent(join(link, "absent-sub", "fixture"));
      expect(got).toBe(join(payload, "absent-sub", "fixture"));
      // And the containment refuseOutOverlap performs on it: the resolved out IS
      // inside the real source dir, even though the lexical paths share nothing.
      expect(pathContains(payload, got)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fully-real path round-trips to its resolved form", () => {
    const root = mk();
    try {
      const real = join(root, "real");
      mkdirSync(real, { recursive: true });
      expect(realpathThroughAbsent(real)).toBe(real);
      expect(realpathThroughAbsent(join(real, "not-yet", "leaf"))).toBe(join(real, "not-yet", "leaf"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an intermediate symlink with an existing target resolves through it", () => {
    const root = mk();
    try {
      const target = join(root, "target");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(root, "mid"));
      const got = realpathThroughAbsent(join(root, "mid", "leaf"));
      expect(got).toBe(join(target, "leaf"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink cycle propagates ELOOP — the caller turns it into a typed refusal", () => {
    const root = mk();
    try {
      const loop = join(root, "loop");
      symlinkSync(loop, loop);
      expect(() => realpathThroughAbsent(join(loop, "fixture"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
