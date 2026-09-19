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
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { outKind, pathContains, realpathThroughAbsent } from "../../scripts/dev/capture-run-of-record.ts";

// Root reads any directory it can search, and Windows does not enforce the POSIX
// read bit — the EACCES arm cannot be injected on either.
const CAN_SKIP_DIR_READ = (process.getuid?.() ?? -1) !== 0 && process.platform !== "win32";

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

describe("outKind — the idempotence guard's classification of what stands at --out", () => {
  const mk = (): string => mkdtempSync(join(resolve(import.meta.dir), "capture-kind-"));

  test("absent, file, empty and sentinel-only arms", () => {
    const root = mk();
    try {
      expect(outKind(join(root, "no-such-thing"))).toBe("absent");
      const filePath = join(root, "a-file");
      writeFileSync(filePath, "x");
      expect(outKind(filePath)).toBe("file");
      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(outKind(empty)).toBe("empty");
      const sentinelOnly = join(root, "sentinel");
      mkdirSync(sentinelOnly);
      closeSync(openSync(join(sentinelOnly, "capture-in-progress"), "wx"));
      expect(outKind(sentinelOnly)).toBe("sentinel-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!CAN_SKIP_DIR_READ)("a searchable-but-not-readable directory is its own kind, not a crash", () => {
    const root = mk();
    try {
      const unreadable = join(root, "locked");
      mkdirSync(unreadable);
      chmodSync(unreadable, 0o300); // wx, no r — lstat succeeds, readdirSync EACCES
      expect(outKind(unreadable)).toBe("unreadable");
    } finally {
      // Restore BEFORE cleanup: rmSync must list entries it did not create.
      chmodSync(join(root, "locked"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink at --out is refused as a symlink, read or dangling", () => {
    const root = mk();
    try {
      const target = join(root, "target");
      mkdirSync(target);
      symlinkSync(target, join(root, "live-link"));
      expect(outKind(join(root, "live-link"))).toBe("symlink");
      symlinkSync(join(root, "never-exists"), join(root, "dangling-link"));
      expect(outKind(join(root, "dangling-link"))).toBe("symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
