/**
 * F033 — the one fs-atomic leaf.
 *
 * These pin the contract the four ex-copies in fanout.ts, fleet-lock.ts and
 * run-record.ts relied on. They are the proof this was a delete-N-add-1
 * refactor and not a rewrite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDirMode0700, atomicReplaceFile, fsyncDir, rmQuiet } from "../../src/providers/fs-atomic.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fsyncDir", () => {
  test("opens, fsyncs and closes the directory fd", () => {
    // A leaked fd is observable: closeSync frees the LOWEST free descriptor,
    // so a second open returns the same number only when the first was closed.
    const before = openSync(dir, "r");
    closeSync(before);
    fsyncDir(dir);
    const after = openSync(dir, "r");
    closeSync(after);
    expect(after).toBe(before);
  });

  test("is best-effort: a directory that cannot be opened does not throw", () => {
    expect(() => fsyncDir(join(dir, "nope"))).not.toThrow();
  });
});

describe("rmQuiet", () => {
  test("removes the path and cannot throw on a missing one", () => {
    const p = join(dir, "x");
    writeFileSync(p, "x");
    rmQuiet(p);
    expect(existsSync(p)).toBe(false);
    expect(() => rmQuiet(p)).not.toThrow();
  });
});

describe("assertDirMode0700", () => {
  test("creates the directory at 0700", () => {
    const d = join(dir, "fresh");
    assertDirMode0700(d, (m) => new Error(`bad ${m}`));
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  test("re-permissions an existing 0755 dir to 0700 rather than rejecting it", () => {
    // mkdir's mode is ignored when the dir exists — the chmod is the whole point.
    const d = join(dir, "loose");
    mkdirSync(d, { mode: 0o755 });
    chmodSync(d, 0o755);
    assertDirMode0700(d, (m) => new Error(`bad ${m}`));
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  test("propagates the mkdir errno when the path exists as a file", () => {
    // The reject arm reachable without a filesystem that ignores chmod: the
    // mode-verify throw (chmod succeeded but did not take) needs a mount that
    // drops modes, so it is left unpinned — see the report.
    const f = join(dir, "afile");
    writeFileSync(f, "x");
    expect(() => assertDirMode0700(f, (m) => new Error(`bad ${m}`))).toThrow();
  });
});

describe("atomicReplaceFile", () => {
  test("publishes the bytes and leaves no temp behind", () => {
    const p = join(dir, "r.json");
    atomicReplaceFile(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(["r.json"]);
  });

  test("replaces an existing file in place", () => {
    const p = join(dir, "r.json");
    writeFileSync(p, "old");
    atomicReplaceFile(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["r.json"]);
  });

  test("leaves no temp on a failed rename, and the prior contents survive", () => {
    const p = join(dir, "r.json");
    writeFileSync(p, "old");
    expect(() =>
      atomicReplaceFile(p, "new", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["r.json"]);
  });

  test("the temp carries the pid-stamped 8-hex grammar the stale-temp sweeps admit", () => {
    const p = join(dir, "r.json");
    let tmp = "";
    atomicReplaceFile(p, "x", (t) => {
      tmp = t.slice(dir.length + 1);
    });
    expect(tmp).toMatch(/^r\.json\.[0-9]+\.[0-9a-f]{8}\.tmp$/);
    expect(Number(tmp.split(".").at(-3))).toBe(process.pid);
  });
});
