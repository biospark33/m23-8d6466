/**
 * F034 — the ONE box-path validator. Six private copies (credentials.ts,
 * driver.ts, harvest.ts, exedev/{fill,setup-gate,driver}.ts) had already
 * diverged on `a//b`; this pins the STRICTEST union they now all share.
 * Each caller's own error class and message are pinned by its own suite.
 */

import { describe, expect, test } from "bun:test";
import { assertPlainBoxPath } from "../../src/providers/path-guard.ts";

describe("assertPlainBoxPath — rejects", () => {
  test.each([
    ["", "empty"],
    ["a//b", "empty interior segment"],
    ["a/", "trailing slash"],
    ["../x", "leading traversal"],
    ["a/../b", "interior traversal"],
    ["..", "bare traversal"],
    ["a\nb", "newline"],
    ["a b", "space"],
    ["-flag", "leading dash (argv flag)"],
    ["a;rm -rf /", "shell metacharacter"],
    ["$(id)", "command substitution"],
    ["a'b", "single quote"],
    ["a*b", "glob"],
    ["~root/.ssh", "tilde"],
  ])("%p — %s", (p) => {
    expect(() => assertPlainBoxPath("workdir", p)).toThrow();
  });

  test("the message names the label and the offending value", () => {
    expect(() => assertPlainBoxPath("envFile", "a b")).toThrow(/envFile "a b"/);
  });
});

describe("assertPlainBoxPath — accepts", () => {
  test.each([
    "/run/journal/final.json",
    "src",
    "out/report.txt",
    "a/b/c.d-e.f",
    "./relative",
    ".hidden",
    "a.b",
  ])("%p", (p) => {
    expect(() => assertPlainBoxPath("workdir", p)).not.toThrow();
  });
});
