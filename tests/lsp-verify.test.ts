/**
 * Tests for the LSP provision + diagnostics/navigation harness (Story P0.6).
 *
 * Two layers:
 *  1. Unit tests over the harness's pure helpers — the p95 statistic, the
 *     `external:true` URI-prefix convention (AC2b), the batch per-file keying
 *     (AC4), and version-floor comparison. These run everywhere, no pi-lens.
 *  2. An integration test that spawns `bun scripts/lsp-verify.ts` and asserts
 *     the structured JSON verdict. pi-lens is a provisioned dependency rather
 *     than a repo dep, so the test skips (never fails) when none resolves.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  compareVersions,
  extractBatchByFile,
  extractReportedLines,
  flagExternal,
  p95,
  parseBatchDiagnosticsText,
  parseToolJsonText,
  resolvePiLens,
} from "../scripts/lsp-verify.ts";

const REPO_ROOT = path.join(import.meta.dir, "..");
const HARNESS = path.join(REPO_ROOT, "scripts", "lsp-verify.ts");

// Budget ABOVE the harness's own aggregate worst case, not just above a typical
// run: ~120 s cold call + up to 200 s of warm samples (20 x a 10 s freshness
// window) + 120 s AC4 batch + a 15 s init-timeout probe + an agent turn whose
// own spawnSync deadline is 300 s. At 290 s the child was killed and the test
// went hard-red instead of reporting the harness's own verdict.
const CHILD_TIMEOUT_MS = 870_000;
const TEST_TIMEOUT_MS = 900_000;

describe("p95 (nearest-rank)", () => {
  test("returns undefined for an empty sample set rather than 0", () => {
    expect(p95([])).toBeUndefined();
  });

  test("single sample is its own p95", () => {
    expect(p95([1234])).toBe(1234);
  });

  test("picks the nearest-rank element, not an interpolated value", () => {
    // 20 samples 1..20: ceil(0.95 * 20) = 19 → the 19th smallest.
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(p95(samples)).toBe(19);
  });

  test("is order-independent", () => {
    expect(p95([300, 100, 200])).toBe(p95([100, 200, 300]));
  });

  test("a single outlier in 20 samples sits ABOVE p95 and does not inflate it", () => {
    // Exactly 1/20 = 5% of samples are slow, so nearest-rank p95 (the 19th of
    // 20) is still the fast value. This is the intended NFR-PERF-6 semantic:
    // p95 tolerates the slowest 5%, it does not report the max.
    const samples = [...Array.from({ length: 19 }, () => 100), 9_000];
    expect(p95(samples)).toBe(100);
  });

  test("two slow samples in 20 push the p95 to the slow value", () => {
    // 2/20 = 10% slow → the 19th of 20 is now a slow sample, so a genuinely
    // degraded server cannot hide behind the percentile.
    const samples = [...Array.from({ length: 18 }, () => 100), 9_000, 9_000];
    expect(p95(samples)).toBe(9_000);
  });
});

describe("compareVersions (pi-lens floor check)", () => {
  test("orders by numeric component, not lexically", () => {
    // The lexical trap: "3.8.9" > "3.8.69" as strings, but not as versions.
    expect(compareVersions("3.8.9", "3.8.69")).toBe(-1);
    expect(compareVersions("3.8.71", "3.8.69")).toBe(1);
    expect(compareVersions("3.8.69", "3.8.69")).toBe(0);
  });

  test("treats a missing component as 0", () => {
    expect(compareVersions("3.8", "3.8.0")).toBe(0);
    expect(compareVersions("4", "3.8.69")).toBe(1);
  });

  test("pre-release identifiers compare numerically, not lexically", () => {
    // The lexical trap: "rc.9" > "rc.10" as strings, but rc.9 precedes rc.10.
    expect(compareVersions("3.8.69-rc.9", "3.8.69-rc.10")).toBe(-1);
    expect(compareVersions("3.8.69-rc.10", "3.8.69-rc.9")).toBe(1);
    expect(compareVersions("3.8.69-rc.2", "3.8.69-rc.2")).toBe(0);
    // A numeric identifier ranks below a non-numeric one (semver 11).
    expect(compareVersions("3.8.69-1", "3.8.69-alpha")).toBe(-1);
    // Fewer identifiers sorts lower when the shared ones are equal.
    expect(compareVersions("3.8.69-rc", "3.8.69-rc.1")).toBe(-1);
  });

  test("a pre-release of the floor version ranks BELOW the release", () => {
    // parseInt("69-rc") === 69, so a naive parse would call these equal and let
    // a pre-release silently satisfy the version floor.
    expect(compareVersions("3.8.69-rc.0", "3.8.69")).toBe(-1);
    expect(compareVersions("3.8.69", "3.8.69-rc.0")).toBe(1);
    expect(compareVersions("3.8.70-beta", "3.8.69")).toBe(1);
  });
});

describe("flagExternal (AC2b harness-layer convention)", () => {
  const root = "/tmp/worktree";

  test("a definition inside the worktree is not external", () => {
    const [loc] = flagExternal([{ uri: `file://${root}/lib.ts`, filePath: `${root}/lib.ts` }], root);
    expect(loc?.external).toBe(false);
  });

  test("a definition in node_modules is flagged external", () => {
    const [loc] = flagExternal(
      [{ uri: `file://${root}/node_modules/typescript/lib/lib.dom.d.ts`, filePath: `${root}/node_modules/typescript/lib/lib.dom.d.ts` }],
      root,
    );
    // node_modules lives under the root, so it is NOT external by the
    // prefix rule — the rule is worktree-scoped, and this documents that.
    expect(loc?.external).toBe(false);
  });

  test("a definition outside the worktree root is flagged external", () => {
    const [loc] = flagExternal(
      [{ uri: "file:///usr/lib/node_modules/typescript/lib/lib.es5.d.ts", filePath: "/usr/lib/node_modules/typescript/lib/lib.es5.d.ts" }],
      root,
    );
    expect(loc?.external).toBe(true);
  });

  test("a sibling directory sharing a name prefix is external, not a false local", () => {
    // "/tmp/worktree-other" starts with "/tmp/worktree" as a raw string; the
    // separator-aware check must still call it external.
    const [loc] = flagExternal([{ filePath: "/tmp/worktree-other/lib.ts" }], root);
    expect(loc?.external).toBe(true);
  });

  test("derives filePath from a file: URI when the field is absent", () => {
    const [loc] = flagExternal([{ uri: `file://${root}/app.ts` }], root);
    expect(loc?.external).toBe(false);
  });

  test("an unresolvable location is labeled external rather than assumed local", () => {
    const [loc] = flagExternal([{ uri: "untitled:Untitled-1" }], root);
    expect(loc?.external).toBe(true);
  });

  test("preserves the original location fields", () => {
    const range = { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } };
    const [loc] = flagExternal([{ uri: `file://${root}/lib.ts`, filePath: `${root}/lib.ts`, range }], root);
    expect(loc?.range).toEqual(range);
    expect(loc?.uri).toBe(`file://${root}/lib.ts`);
  });

  test("never coerces a populated result set to empty (AC2b)", () => {
    const out = flagExternal([{ filePath: "/elsewhere/a.ts" }, { filePath: "/elsewhere/b.ts" }], root);
    expect(out).toHaveLength(2);
  });
});

describe("parseBatchDiagnosticsText (AC4 — the batch surface is text-only)", () => {
  // Captured verbatim from pi-lens 3.8.71's batch response.
  const REAL = [
    "Files checked: 3",
    "Total diagnostics: 2",
    "Concurrency: 8",
    "",
    "File errors:",
    "/w/does-not-exist.ts: path not found",
    "",
    "Auxiliary findings (2):",
    "/w/app.ts:3:7: error[typescript] (2322): Type 'number' is not assignable to type 'string'.",
    "/w/app.ts:4:23: error[ast-grep] (unchecked-throwing-call): without try/catch — throws on invalid input",
  ].join("\n");

  test("keys diagnostics and file errors by file, in one pass", () => {
    const { byFile, filesChecked, totalDiagnostics } = parseBatchDiagnosticsText(REAL);
    expect(filesChecked).toBe(3);
    expect(totalDiagnostics).toBe(2);
    expect(byFile["/w/app.ts"]?.diagnostics).toHaveLength(2);
    expect(byFile["/w/does-not-exist.ts"]?.error).toBe("path not found");
  });

  test("the healthy file keeps its findings alongside the failing one (PARTIAL, not atomic)", () => {
    const { byFile } = parseBatchDiagnosticsText(REAL);
    expect(byFile["/w/app.ts"]?.diagnostics[0]).toMatchObject({
      line: 3,
      column: 7,
      severity: "error",
      rule: "typescript:2322",
    });
    expect(byFile["/w/does-not-exist.ts"]?.diagnostics).toHaveLength(0);
  });

  test("an error reason containing ': ' does not corrupt the file key", () => {
    // The lastIndexOf trap: splitting on the LAST ": " would yield the key
    // "/w/a.ts: permission denied" and silently lose the leading cause.
    const { byFile } = parseBatchDiagnosticsText(
      ["File errors:", "/w/a.ts: permission denied: access denied"].join("\n"),
    );
    expect(byFile["/w/a.ts"]?.error).toBe("permission denied: access denied");
  });

  test("a section header ends the File errors block", () => {
    const { byFile } = parseBatchDiagnosticsText(
      [
        "File errors:",
        "/w/bad.ts: not a file",
        "",
        "Auxiliary findings (1):",
        "/w/ok.ts:1:1: warning[typos] (spelling): teh",
      ].join("\n"),
    );
    expect(byFile["/w/bad.ts"]?.error).toBe("not a file");
    expect(byFile["/w/ok.ts"]?.diagnostics).toHaveLength(1);
    // The diagnostic line must NOT have been swallowed as a file-error entry.
    expect(byFile["/w/ok.ts"]?.error).toBeUndefined();
  });

  test("the clean case yields no entries rather than a bogus one", () => {
    const { byFile, totalDiagnostics } = parseBatchDiagnosticsText(
      ["Files checked: 2", "Total diagnostics: 0", "Concurrency: 8", "", "No diagnostics found."].join("\n"),
    );
    expect(totalDiagnostics).toBe(0);
    expect(Object.keys(byFile)).toHaveLength(0);
  });

  test("empty input is handled without throwing", () => {
    expect(parseBatchDiagnosticsText("").byFile).toEqual({});
  });
});

describe("extractReportedLines (AC1 freshness token)", () => {
  test("returns every reported line, not just the first", () => {
    const text = [
      "Primary LSP (typescript): 2 diagnostics.",
      "",
      "L4:23: error[ast-grep] (unchecked-throwing-call): without try/catch",
      "L3:7: error[typescript] (2322): Type 'number' is not assignable to type 'string'.",
    ].join("\n");
    // The TS2322 is rendered SECOND here. Reading only the first match would
    // miss line 3 entirely and never judge the sample fresh.
    expect(extractReportedLines(text)).toEqual([4, 3]);
    expect(extractReportedLines(text)).toContain(3);
  });

  test("returns an empty array when nothing is reported", () => {
    expect(extractReportedLines("Primary LSP (typescript): confirmed clean.")).toEqual([]);
  });

  test("a rule filter excludes the secondary finding that would collide with the next iteration", () => {
    // The freshness loop puts the TS2322 on `expectedLine` and the fixture's
    // ast-grep finding lands on `expectedLine + 1` — which is exactly the NEXT
    // iteration's expectedLine. An unfiltered scan would accept a STALE
    // response as fresh; filtering to the TS2322 rendering prevents that.
    const staleFromPreviousIteration = [
      "Primary LSP (typescript): 2 diagnostics.",
      "",
      "L3:7: error[typescript] (2322): Type 'number' is not assignable to type 'string'.",
      "L4:23: error[ast-grep] (unchecked-throwing-call): without try/catch",
    ].join("\n");
    // This iteration is waiting for line 4.
    expect(extractReportedLines(staleFromPreviousIteration)).toContain(4); // unfiltered: false-fresh
    expect(extractReportedLines(staleFromPreviousIteration, /\(2322\)|typescript:2322/)).toEqual([3]);
    expect(extractReportedLines(staleFromPreviousIteration, /\(2322\)|typescript:2322/)).not.toContain(4);
  });
});

describe("parseToolJsonText (two observed payload shapes)", () => {
  test("parses a fenced ```json block (pilens_analyze)", () => {
    const text = 'app.ts — 1 blocking\n\n```json\n{"diagnostics":[{"rule":"typescript:2322"}]}\n```';
    expect(parseToolJsonText(text)).toMatchObject({ diagnostics: [{ rule: "typescript:2322" }] });
  });

  test("parses a bare JSON envelope (pilens_lsp_navigation)", () => {
    expect(parseToolJsonText('{"tool":"lsp_navigation","resultCount":1}')).toMatchObject({
      tool: "lsp_navigation",
    });
  });

  test("returns undefined for a human-readable line (pilens_lsp_diagnostics)", () => {
    expect(parseToolJsonText("Primary LSP (typescript): confirmed clean.")).toBeUndefined();
  });

  test("does not coerce a bare array into an envelope", () => {
    expect(parseToolJsonText('[{"uri":"file:///a.ts"}]')).toBeUndefined();
  });

  test("returns undefined on malformed JSON instead of throwing", () => {
    expect(parseToolJsonText("{not json")).toBeUndefined();
    expect(parseToolJsonText("")).toBeUndefined();
  });
});

describe("extractBatchByFile (AC4 per-file keying)", () => {
  test("keys entries by filePath", () => {
    const byFile = extractBatchByFile({
      files: [
        { filePath: "/w/app.ts", diagnostics: [{ rule: "typescript:2322" }] },
        { filePath: "/w/lib.ts", diagnostics: [] },
      ],
    });
    expect(Object.keys(byFile ?? {})).toEqual(["/w/app.ts", "/w/lib.ts"]);
  });

  test("falls back to the `path` key when `filePath` is absent", () => {
    const byFile = extractBatchByFile({ files: [{ path: "/w/app.ts", diagnostics: [] }] });
    expect(byFile?.["/w/app.ts"]).toBeDefined();
  });

  test("keeps a failing entry alongside a healthy one (partial, not atomic)", () => {
    const byFile = extractBatchByFile({
      files: [
        { filePath: "/w/app.ts", diagnostics: [{ rule: "typescript:2322" }] },
        { filePath: "/w/missing.ts", error: "ENOENT" },
      ],
    });
    expect(byFile?.["/w/missing.ts"]).toMatchObject({ error: "ENOENT" });
    expect((byFile?.["/w/app.ts"] as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
  });

  test("returns undefined when the response is not a batch envelope", () => {
    expect(extractBatchByFile({ diagnostics: [] })).toBeUndefined();
    expect(extractBatchByFile(undefined)).toBeUndefined();
  });
});

/**
 * Resolve pi-lens via the harness's OWN resolver (imported — main() is guarded
 * by import.meta.main, so importing does not self-execute). Undefined when no
 * install resolves: the resolver throws in that case.
 */
function piLensAvailable(): boolean {
  try {
    return resolvePiLens(REPO_ROOT).server.length > 0;
  } catch {
    return false;
  }
}

interface VerifyOutput {
  results: Array<{ ac: string; name: string; status: string }>;
  summary: { piLensVersion: string; pass: number; fail: number; skip: number; optionalSkip: number };
}

const piLensResolves = piLensAvailable();
// Skipped, but never silently (#65): a wholly-dark suite must name the missing
// dependency and the env var that would fix it.
if (!piLensResolves) {
  console.warn(
    "[lsp-verify.test] pi-lens is not resolvable (PI_LENS_ROOT unset/invalid, no repo-local node_modules/pi-lens, no global install) — the P0.6 harness integration test is SKIPPED. Set PI_LENS_ROOT to a pi-lens install root to run it.",
  );
}
const liveTest = piLensResolves ? test : test.skip;

describe("LSP verification harness (P0.6)", () => {
  liveTest(
    "harness exits 0 with all checks passing",
    () => {
      const proc = spawnSync("bun", [HARNESS], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (proc.error) {
        const tail = proc.stderr ? proc.stderr.slice(-2000) : "(no stderr captured)";
        throw new Error(`failed to run harness: ${proc.error.message}\nstderr: ${tail}`);
      }
      const stderrTail = proc.stderr ? proc.stderr.trim().slice(-2000) : "(no stderr captured)";
      expect(proc.status, `harness stderr: ${stderrTail}`).toBe(0);

      let out: VerifyOutput;
      try {
        out = JSON.parse(proc.stdout) as VerifyOutput;
      } catch (err) {
        throw new Error(
          `harness stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}\nstdout: ${proc.stdout.slice(-2000)}`,
        );
      }
      expect(out.summary.fail).toBe(0);
      // Every non-optional AC must have PASSED — six of them (AC1, AC2, AC2b,
      // AC3, AC3a, AC4). A harness that silently skipped its way to green is
      // the failure mode this guards, and `>= 5` still tolerated one such skip.
      expect(out.summary.pass).toBeGreaterThanOrEqual(6);
      // Environment-gated skips (the LLM-auth-dependent agent demo) are fine;
      // a non-optional skip is not.
      expect(out.summary.skip - out.summary.optionalSkip).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
