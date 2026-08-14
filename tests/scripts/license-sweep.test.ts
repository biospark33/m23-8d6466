/**
 * Tests for the DF2.9 license sweep + NOTICE generator.
 *
 * The sweep's whole point is that the NOTICE is COMPUTED from a real
 * post-build tree, never transcribed from a list. So the tests below build
 * throwaway `node_modules` trees on disk and assert the classification,
 * the failure ordering (denylist BEFORE generation, INV-2), the fail-closed
 * behavior on an unmappable SPDX identifier (INV-4), and the Apache-2.0
 * §4(a) obligation (INV-3) — plus the negative control the story calls out:
 * a NOTICE built from a static list must FAIL coverage verification.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyScanPath, configLooksLikeCredential, SECRET_ENV } from "../../scripts/build-image.ts";
import {
  DENIED_PACKAGES,
  PI_CODING_AGENT_PIN,
  readLicenseId,
  renderNotice,
  sweepTree,
  verifyNoticeCoverage,
  walkTree,
} from "../../scripts/lib/license-sweep.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const REAL_TEXTS = path.join(REPO_ROOT, "oci/license-texts");
const GENERATOR = path.join(REPO_ROOT, "scripts/generate-notice.ts");

interface PkgSpec {
  name: string;
  version?: string;
  /** `undefined` omits the field entirely (the `@mistralai/mistralai` shape). */
  license?: unknown;
  author?: unknown;
  /** Extra files written into the package dir, e.g. `{ "LICENSE": "..." }`. */
  files?: Record<string, string>;
  /** Nested `node_modules` children. */
  deps?: PkgSpec[];
}

/** Writes `specs` into `<parent>/node_modules/...`, returning `parent`. */
function writeTree(parent: string, specs: readonly PkgSpec[]): string {
  const nm = path.join(parent, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  for (const spec of specs) {
    const dir = path.join(nm, spec.name);
    fs.mkdirSync(dir, { recursive: true });
    const pkg: Record<string, unknown> = { name: spec.name, version: spec.version ?? "1.0.0" };
    if ("license" in spec) pkg.license = spec.license;
    if ("author" in spec) pkg.author = spec.author;
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    for (const [file, body] of Object.entries(spec.files ?? {})) {
      fs.writeFileSync(path.join(dir, file), body);
    }
    if (spec.deps?.length) writeTree(dir, spec.deps);
  }
  return parent;
}

let tmpCount = 0;
function tmpTree(specs: readonly PkgSpec[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `df29-tree-${tmpCount++}-`));
  return writeTree(root, specs);
}

/** A license-texts dir containing only the given identifiers. */
function tmpTexts(ids: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `df29-texts-${tmpCount++}-`));
  for (const [id, body] of Object.entries(ids)) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), body);
  }
  return dir;
}

const MIT_TEXT = "MIT License\n\nPermission is hereby granted, free of charge...\n";
const APACHE_TEXT = "Apache License\nVersion 2.0, January 2004\n\n1. Definitions...\n";
const ALL_TEXTS = { MIT: MIT_TEXT, "Apache-2.0": APACHE_TEXT };

const META = {
  imageRef: "qds-factory:test",
  installFlags: "--omit=optional",
  sweptAt: "2026-08-13T00:00:00.000Z",
};

// ─────────────────────────────── walkTree ────────────────────────────────

describe("walkTree", () => {
  test("finds scoped and nested packages and records the dependency path", () => {
    const root = tmpTree([
      { name: "top", license: "MIT", deps: [{ name: "@scope/inner", license: "MIT" }] },
    ]);
    const entries = walkTree(root).entries;
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(["@scope/inner", "top"]);
    expect(byName.get("top")?.depPath).toBe("top");
    expect(byName.get("@scope/inner")?.depPath).toBe("top > @scope/inner");
  });

  test("accepts either a package root or the node_modules dir itself", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    expect(walkTree(path.join(root, "node_modules")).entries.map((e) => e.name)).toEqual(["a"]);
  });

  test("skips dot-entries such as .bin and .package-lock.json", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    expect(walkTree(root).entries.map((e) => e.name)).toEqual(["a"]);
  });

  test("a zero-byte LICENSE does not count as shipped license text", () => {
    const root = tmpTree([{ name: "a", license: "MIT", files: { LICENSE: "" } }]);
    expect(walkTree(root).entries[0]?.licenseFiles).toEqual([]);
  });

  test("LICENSE / LICENCE / LICENSE.md / COPYING all count", () => {
    const root = tmpTree([
      { name: "a", license: "MIT", files: { "LICENSE.md": "x" } },
      { name: "b", license: "MIT", files: { LICENCE: "x" } },
      { name: "c", license: "MIT", files: { COPYING: "x" } },
      { name: "d", license: "MIT", files: { "LICENSE-MIT.txt": "x" } },
    ]);
    for (const e of walkTree(root).entries) {
      expect(e.licenseFiles.length).toBeGreaterThan(0);
    }
  });

  test("a SOURCE file named license.js is not license text", () => {
    const root = tmpTree([
      { name: "a", license: "MIT", files: { "license.js": "module.exports = 1;\n" } },
      { name: "b", license: "MIT", files: { "copying.py": "print(1)\n" } },
      { name: "c", license: "MIT", files: { "license-utils.ts": "export const x = 1;\n" } },
    ]);
    for (const e of walkTree(root).entries) {
      expect(e.licenseFiles).toEqual([]);
    }
  });

  test("a SOURCE file named notice.js is not an upstream NOTICE", () => {
    const root = tmpTree([
      { name: "a", license: "MIT", files: { LICENSE: "x", "notice.js": "module.exports = 1;\n" } },
    ]);
    expect(walkTree(root).entries[0]?.noticeFiles).toEqual([]);
  });

  test("a symlink cycle in node_modules does not hang the walk", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    // node_modules/a/node_modules -> node_modules (the shape npm/pnpm links
    // produce, and the one that would recurse forever without the guard).
    fs.symlinkSync(path.join(root, "node_modules"), path.join(root, "node_modules/a/node_modules"));
    expect(walkTree(root).entries.map((e) => e.name)).toEqual(["a"]);
  });

  test("a corrupt manifest is reported as unreadable, and its subtree is still walked", () => {
    const root = tmpTree([{ name: "broken", license: "MIT", deps: [{ name: "child", license: "MIT" }] }]);
    fs.writeFileSync(path.join(root, "node_modules/broken/package.json"), "{ not json");
    const walked = walkTree(root);
    expect(walked.unreadable.length).toBe(1);
    expect(walked.unreadable[0]).toContain("broken/package.json");
    expect(walked.entries.map((e) => e.name)).toEqual(["child"]);
  });

  test("a manifest-less directory and a dangling symlink are unreadable, not absent", () => {
    const root = tmpTree([{ name: "real", license: "MIT", files: { LICENSE: "x" } }]);
    fs.mkdirSync(path.join(root, "node_modules/stray"));
    fs.symlinkSync("/nonexistent-df29", path.join(root, "node_modules/ghost"));
    const walked = walkTree(root);
    expect(walked.entries.map((e) => e.name)).toEqual(["real"]);
    expect(walked.unreadable.length).toBe(2);
    expect(walked.unreadable.join("\n")).toContain("stray");
    expect(walked.unreadable.join("\n")).toContain("ghost");
  });

  test("a clean tree reports nothing unreadable", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    expect(walkTree(root).unreadable).toEqual([]);
  });

  test("a NOTICE file is recorded separately from license text", () => {
    const root = tmpTree([
      { name: "a", license: "Apache-2.0", files: { LICENSE: "x", NOTICE: "upstream notice" } },
    ]);
    const e = walkTree(root).entries[0]!;
    expect(e.noticeFiles.length).toBe(1);
    expect(e.licenseFiles.length).toBe(1);
  });
});

// ───────────────────────────── readLicenseId ─────────────────────────────

describe("readLicenseId", () => {
  test("string, {type}, and legacy licenses[] shapes all resolve", () => {
    expect(readLicenseId({ license: "MIT" })).toBe("MIT");
    expect(readLicenseId({ license: { type: "Apache-2.0" } })).toBe("Apache-2.0");
    expect(readLicenseId({ licenses: [{ type: "MIT" }] })).toBe("MIT");
    expect(readLicenseId({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
  });

  test("an absent, empty, or non-string license field resolves to null", () => {
    expect(readLicenseId({})).toBeNull();
    expect(readLicenseId({ license: "   " })).toBeNull();
    expect(readLicenseId({ license: 42 })).toBeNull();
    expect(readLicenseId({ licenses: [] })).toBeNull();
  });

  test("UNLICENSED is not a license", () => {
    expect(readLicenseId({ license: "UNLICENSED" })).toBeNull();
  });
});

// ─────────────────────────── classification ──────────────────────────────

describe("sweepTree classification", () => {
  test("a package shipping its own license text is covered and never duplicated into NOTICE", () => {
    const root = tmpTree([
      { name: "@mariozechner/jiti", version: "2.6.5", license: "MIT", files: { LICENSE: "MIT (c) Pooya Parsa" } },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.covered.map((e) => e.name)).toEqual(["@mariozechner/jiti"]);
    expect(r.uncovered).toEqual([]);
    const notice = renderNotice(r, META);
    expect(notice).not.toContain("### @mariozechner/jiti@2.6.5");
  });

  test("a license-text-less package is uncovered and lands in NOTICE with id, copyright and full text", () => {
    const root = tmpTree([
      { name: "data-uri-to-buffer", version: "4.0.1", license: "MIT", author: "Nathan Rajlich" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.uncovered.map((e) => e.name)).toEqual(["data-uri-to-buffer"]);
    const notice = renderNotice(r, META);
    expect(notice).toContain("data-uri-to-buffer@4.0.1");
    expect(notice).toContain("SPDX-License-Identifier: MIT");
    expect(notice).toContain("Nathan Rajlich");
    expect(notice).toContain(MIT_TEXT.trim());
  });

  test("INV-3: an uncovered Apache-2.0 package carries the complete Apache-2.0 text", () => {
    const root = tmpTree([
      { name: "@aws-sdk/nested-clients", version: "3.997.42", license: "Apache-2.0" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    const notice = renderNotice(r, META);
    expect(notice).toContain("@aws-sdk/nested-clients@3.997.42");
    expect(notice).toContain(APACHE_TEXT.trim());
  });

  test("INV-3: a COVERED package's upstream NOTICE file is concatenated verbatim", () => {
    const upstream = "AWS SDK for JavaScript\nCopyright 2012-2026 Amazon.com, Inc.\n";
    const root = tmpTree([
      {
        name: "@aws-sdk/client-sts",
        version: "3.0.0",
        license: "Apache-2.0",
        files: { LICENSE: APACHE_TEXT, NOTICE: upstream },
      },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.covered.map((e) => e.name)).toEqual(["@aws-sdk/client-sts"]);
    const notice = renderNotice(r, META);
    expect(notice).toContain(upstream.trim());
    expect(notice).toContain("Upstream NOTICE files");
  });

  test("the same package at two depths is reported once in NOTICE", () => {
    const root = tmpTree([
      { name: "a", license: "MIT", deps: [{ name: "dup", version: "1.2.3", license: "MIT" }] },
      { name: "b", license: "MIT", deps: [{ name: "dup", version: "1.2.3", license: "MIT" }] },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    const notice = renderNotice(r, META);
    const headings = notice.split("\n").filter((l) => l.trim() === "### dup@1.2.3");
    expect(headings.length).toBe(1);
  });

  test("a less-common but permissive identifier is disclosed in a reviewer section, not an error", () => {
    const root = tmpTree([
      { name: "glob", version: "11.0.0", license: "BlueOak-1.0.0", files: { "LICENSE.md": "blue oak" } },
    ]);
    const r = sweepTree({
      treeRoot: root,
      licenseTextsDir: tmpTexts({ ...ALL_TEXTS, "BlueOak-1.0.0": "Blue Oak Model License" }),
    });
    expect(r.missingTexts).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.uncommonIds.map((u) => u.id)).toContain("BlueOak-1.0.0");
    expect(renderNotice(r, META)).toContain("BlueOak-1.0.0");
  });

  test("no license field AND no license text is unresolved (INV-4), never assumed permissive", () => {
    const root = tmpTree([{ name: "mystery", version: "0.1.0" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.unresolved.map((e) => e.name)).toEqual(["mystery"]);
  });

  test("no license field BUT shipped license text is covered by that text", () => {
    const root = tmpTree([
      { name: "@mistralai/mistralai", version: "1.10.0", files: { LICENSE: APACHE_TEXT } },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.unresolved).toEqual([]);
    expect(r.covered.map((e) => e.name)).toEqual(["@mistralai/mistralai"]);
    expect(renderNotice(r, META)).toContain("@mistralai/mistralai");
  });

  test("INV-4: a recognized identifier with no checked-in canonical text is a missingTexts entry", () => {
    const root = tmpTree([{ name: "bsd-pkg", version: "1.0.0", license: "BSD-3-Clause" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.missingTexts.map((m) => m.id)).toEqual(["BSD-3-Clause"]);
    expect(r.missingTexts[0]?.packages).toEqual(["bsd-pkg@1.0.0"]);
  });

  test("a zero-byte canonical text file counts as missing", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts({ MIT: "" }) });
    expect(r.missingTexts.map((m) => m.id)).toEqual(["MIT"]);
  });

  test("a disjunctive expression resolves through any atom that has a checked-in text", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "(MIT OR CC0-1.0)" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.missingTexts).toEqual([]);
    expect(renderNotice(r, META)).toContain(MIT_TEXT.trim());
  });

  test("INV-4: an SPDX exception (`X WITH Y`) is unresolvable, never satisfied by X alone", () => {
    const root = tmpTree([
      { name: "a", version: "1.0.0", license: "GPL-2.0-only WITH Classpath-exception-2.0" },
      { name: "b", version: "1.0.0", license: "MIT WITH Some-exception" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.missingTexts.map((m) => m.id).sort()).toEqual([
      "GPL-2.0-only WITH Classpath-exception-2.0",
      "MIT WITH Some-exception",
    ]);
  });

  test("the same name@version present twice, one copy without license text, is uncovered", () => {
    const root = tmpTree([
      {
        name: "a",
        license: "MIT",
        files: { LICENSE: "x" },
        deps: [{ name: "dup", version: "1.0.0", license: "MIT", files: { LICENSE: "x" } }],
      },
      { name: "b", license: "MIT", files: { LICENSE: "x" }, deps: [{ name: "dup", version: "1.0.0", license: "MIT" }] },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.uncovered.map(({ name }) => name)).toEqual(["dup"]);
    expect(r.covered.map(({ name }) => name)).not.toContain("dup");
  });

  test("INV-3: an upstream NOTICE on ANY copy propagates, even when another copy wins the dedupe", () => {
    const upstream = "AWS SDK for JavaScript\nCopyright 2012-2026 Amazon.com, Inc.\n";
    const root = tmpTree([
      {
        name: "a",
        license: "MIT",
        files: { LICENSE: "x" },
        // The complete copy: license text AND an upstream NOTICE.
        deps: [
          { name: "dup", version: "3.0.0", license: "Apache-2.0", files: { LICENSE: APACHE_TEXT, NOTICE: upstream } },
        ],
      },
      // The partial copy, which wins the dedupe by shipping no license text.
      { name: "b", license: "MIT", files: { LICENSE: "x" }, deps: [{ name: "dup", version: "3.0.0" }] },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.uncovered.map((e) => e.name)).toEqual(["dup"]);
    // The SPDX id came from the sibling copy, so this is NOT an exit-2 package.
    expect(r.unresolved).toEqual([]);
    expect(r.uncovered[0]?.licenseId).toBe("Apache-2.0");
    const notice = renderNotice(r, META);
    expect(notice).toContain(upstream.trim());
  });

  test("a canonical text file of only whitespace counts as missing, not as a blank entry", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts({ MIT: "   \n\n" }) });
    expect(r.missingTexts.map((m) => m.id)).toEqual(["MIT"]);
  });

  test("an SPDX identifier resolves case-insensitively against the checked-in texts", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "mit" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.missingTexts).toEqual([]);
    expect(renderNotice(r, META)).toContain(MIT_TEXT.trim());
  });

  test("renderNotice refuses to emit an entry with no license text rather than degrading", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    const starved = { ...r, licenseTexts: {} };
    expect(() => renderNotice(starved, META)).toThrow("a@1.0.0");
  });

  test("a conjunctive expression needs a text for EVERY atom", () => {
    const root = tmpTree([{ name: "a", version: "1.0.0", license: "MIT AND BSD-3-Clause" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.missingTexts.map((m) => m.id)).toEqual(["MIT AND BSD-3-Clause"]);
  });
});

// ─────────────────────────── denylist + pins ─────────────────────────────

describe("denylist and version pins", () => {
  test("both denied names are unconditional", () => {
    expect([...DENIED_PACKAGES].sort()).toEqual(["@mariozechner/pi", "@mariozechner/pi-proxy"]);
  });

  test("a denied package at depth is reported with its dependency path", () => {
    const root = tmpTree([
      {
        name: "@mariozechner/pi-coding-agent",
        version: PI_CODING_AGENT_PIN,
        license: "MIT",
        deps: [{ name: "@mariozechner/pi-proxy", version: "1.0.0", license: "MIT" }],
      },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.denied.map((e) => e.depPath)).toEqual([
      "@mariozechner/pi-coding-agent > @mariozechner/pi-proxy",
    ]);
  });

  test("`@mariozechner/pi` is denied while `@mariozechner/pi-tui` is not", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi", version: "1.0.0", license: "MIT" },
      { name: "@mariozechner/pi-tui", version: "0.55.4", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.denied.map((e) => e.name)).toEqual(["@mariozechner/pi"]);
  });

  test("an off-pin coding agent fails and names the observed version", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: "0.56.1", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations.join("\n")).toContain("0.56.1");
    expect(r.pinViolations.join("\n")).toContain(PI_CODING_AGENT_PIN);
  });

  test("pi libs float inside 0.55.x under a 0.55.0 coding agent (AC2)", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: PI_CODING_AGENT_PIN, license: "MIT" },
      { name: "@mariozechner/pi-ai", version: "0.55.4", license: "MIT" },
      { name: "@mariozechner/pi-tui", version: "0.55.4", license: "MIT" },
      { name: "@mariozechner/pi-agent-core", version: "0.55.4", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations).toEqual([]);
    expect(r.piVersions["@mariozechner/pi-ai"]).toBe("0.55.4");
  });

  test("a pi lib outside 0.55.x fails", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: PI_CODING_AGENT_PIN, license: "MIT" },
      { name: "@mariozechner/pi-ai", version: "0.56.0", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations.join("\n")).toContain("@mariozechner/pi-ai");
  });

  test("`0.55.40` does not sneak past the 0.55.x check as a prefix match", () => {
    const root = tmpTree([{ name: "@mariozechner/pi-ai", version: "0.550.0", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations.join("\n")).toContain("0.550.0");
  });

  test("AC2: clipboard and its platform binaries must be absent from the tree", () => {
    const root = tmpTree([
      { name: "@mariozechner/clipboard", version: "1.0.0", license: "MIT" },
      { name: "@mariozechner/clipboard-darwin-arm64", version: "1.0.0", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations.join("\n")).toContain("@mariozechner/clipboard");
    expect(r.pinViolations.join("\n")).toContain("@mariozechner/clipboard-darwin-arm64");
  });

  test("an absent coding agent is not a pin violation (the build script asserts presence)", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(r.pinViolations).toEqual([]);
  });
});

// ───────────────────── NOTICE coverage (negative control) ────────────────

describe("verifyNoticeCoverage", () => {
  test("a NOTICE built from a static list fails when the tree moved on", () => {
    const root = tmpTree([
      { name: "known", version: "1.0.0", license: "MIT" },
      { name: "newcomer", version: "2.0.0", license: "MIT" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    // Shaped exactly like a generated NOTICE, but built from a list written
    // when the tree held one package. `newcomer` arrived later.
    const staticNotice = "NOTICE\n\n### known@1.0.0\nSPDX-License-Identifier: MIT\n";
    expect(verifyNoticeCoverage(staticNotice, r.uncovered)).toEqual(["newcomer@2.0.0"]);
  });

  test("a name that merely appears inside another entry does not satisfy coverage", () => {
    const root = tmpTree([{ name: "glob", version: "1.2.3", license: "MIT" }]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    // `glob@1.2.3` is a substring of both of these, and neither is its entry.
    const decoy = "### fast-glob@1.2.3\nDependency path: a > glob@1.2.30\n";
    expect(verifyNoticeCoverage(decoy, r.uncovered)).toEqual(["glob@1.2.3"]);
  });

  test("the generated NOTICE covers everything the sweep found uncovered", () => {
    const root = tmpTree([
      { name: "known", version: "1.0.0", license: "MIT" },
      { name: "newcomer", version: "2.0.0", license: "Apache-2.0" },
    ]);
    const r = sweepTree({ treeRoot: root, licenseTextsDir: tmpTexts(ALL_TEXTS) });
    expect(verifyNoticeCoverage(renderNotice(r, META), r.uncovered)).toEqual([]);
  });
});

// ───────────────────────── generator CLI contract ────────────────────────

function runGenerator(args: readonly string[]) {
  const res = spawnSync("bun", [GENERATOR, ...args], { encoding: "utf8" });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function outPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `df29-out-${tmpCount++}-`)), "NOTICE");
}

describe("generate-notice CLI", () => {
  test("exit 0 on a clean tree and the NOTICE is non-empty", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: PI_CODING_AGENT_PIN, license: "MIT", author: "Mario Zechner" },
    ]);
    const out = outPath();
    const summary = `${out}.summary.json`;
    const { code, out: log } = runGenerator([
      "--tree", root, "--out", out, "--license-texts", REAL_TEXTS, "--summary", summary,
    ]);
    expect(code).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    expect(fs.readFileSync(out, "utf8")).toContain("Mario Zechner");
    const parsed = JSON.parse(fs.readFileSync(summary, "utf8"));
    expect(parsed.exitCode).toBe(0);
    expect(parsed.uncoveredCount).toBe(1);
    expect(parsed.noticeBytes).toBeGreaterThan(0);
    expect(parsed.piVersions["@mariozechner/pi-coding-agent"]).toBe(PI_CODING_AGENT_PIN);
    expect(log).toContain("treePackageCount");
  });

  test("INV-2: a denied package exits 1, names the path, and writes NO NOTICE", () => {
    const root = tmpTree([
      {
        name: "@mariozechner/pi-coding-agent",
        version: PI_CODING_AGENT_PIN,
        license: "MIT",
        deps: [{ name: "@mariozechner/pi-proxy", version: "1.0.0" }],
      },
    ]);
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(1);
    expect(log).toContain("@mariozechner/pi-coding-agent > @mariozechner/pi-proxy");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("INV-2 ordering: a denied package wins over an unresolvable license (exit 1, not 2)", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi", version: "1.0.0" },
      { name: "mystery", version: "1.0.0" },
    ]);
    const out = outPath();
    const { code } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });

  test("INV-4: an unmapped SPDX identifier exits 2 before NOTICE generation and names it", () => {
    const root = tmpTree([{ name: "odd", version: "1.0.0", license: "EUPL-1.2" }]);
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(2);
    expect(log).toContain("EUPL-1.2");
    expect(log).toContain("odd@1.0.0");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("INV-4: an unresolvable license exits 2 and names the package", () => {
    const root = tmpTree([{ name: "mystery", version: "0.1.0" }]);
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(2);
    expect(log).toContain("mystery@0.1.0");
  });

  test("an off-pin coding agent exits 1 and names the observed version", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: "0.56.1", license: "MIT" },
    ]);
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(1);
    expect(log).toContain("0.56.1");
  });

  test("INV-4: a corrupt manifest exits 2 and names it, instead of sweeping around it", () => {
    const root = tmpTree([
      { name: "@mariozechner/pi-coding-agent", version: PI_CODING_AGENT_PIN, license: "MIT" },
      { name: "broken", license: "MIT" },
    ]);
    fs.writeFileSync(path.join(root, "node_modules/broken/package.json"), "{ not json");
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(2);
    expect(log).toContain("broken/package.json");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("a missing tree exits 2 rather than reporting a vacuously clean sweep", () => {
    const { code, out: log } = runGenerator([
      "--tree", path.join(os.tmpdir(), "df29-does-not-exist"),
      "--out", outPath(), "--license-texts", REAL_TEXTS,
    ]);
    expect(code).toBe(2);
    expect(log).toContain("tree");
  });

  test("an empty tree is a FAIL, never a vacuous pass (AC4)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `df29-empty-${tmpCount++}-`));
    fs.mkdirSync(path.join(root, "node_modules"));
    const out = outPath();
    const { code, out: log } = runGenerator(["--tree", root, "--out", out, "--license-texts", REAL_TEXTS]);
    expect(code).toBe(1);
    expect(log.toLowerCase()).toContain("empty");
  });

  test("a missing license-texts dir exits 2", () => {
    const root = tmpTree([{ name: "a", license: "MIT" }]);
    const { code } = runGenerator([
      "--tree", root, "--out", outPath(),
      "--license-texts", path.join(os.tmpdir(), "df29-no-texts"),
    ]);
    expect(code).toBe(2);
  });
});

// ─────────────────────── checked-in canonical texts ──────────────────────

describe("oci/license-texts", () => {
  test("every checked-in canonical text is non-empty and named by SPDX identifier", () => {
    const files = fs.readdirSync(REAL_TEXTS).filter((f) => f.endsWith(".txt"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.statSync(path.join(REAL_TEXTS, f)).size).toBeGreaterThan(100);
    }
    // The identifiers the 0.55.0 tree is known to carry must all be present.
    for (const id of ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0"]) {
      expect(files).toContain(`${id}.txt`);
    }
  });

  test("the Apache-2.0 text is the complete license, not a stub or a URL", () => {
    const text = fs.readFileSync(path.join(REAL_TEXTS, "Apache-2.0.txt"), "utf8");
    expect(text).toContain("Apache License");
    expect(text).toContain("Version 2.0, January 2004");
    expect(text).toContain("4. Redistribution.");
    expect(text).toContain("END OF TERMS AND CONDITIONS");
    // No package-specific copyright leaked in from the source copy.
    expect(text).toContain("Copyright [yyyy] [name of copyright owner]");
  });
});

// ──────────────────── image build contract (INV-5, AC2) ─────────────────

describe("oci/Dockerfile", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "oci/Dockerfile"), "utf8");

  test("installs with --omit=optional and pins the coding agent to the sweep's pin", () => {
    expect(dockerfile).toContain("--omit=optional");
    expect(dockerfile).toContain(`@mariozechner/pi-coding-agent@${PI_CODING_AGENT_PIN}`);
  });

  test("copies the generated NOTICE to the documented path and declares no secret", () => {
    expect(dockerfile).toContain("COPY oci/.build/NOTICE /usr/share/doc/qds-factory/NOTICE");
    expect(dockerfile).not.toMatch(SECRET_ENV);
  });

  test("the runtime stage takes its tree from the pinnable DEPS_IMAGE, not a re-resolved build", () => {
    expect(dockerfile).toContain("ARG DEPS_IMAGE=deps");
    expect(dockerfile).toContain("FROM ${DEPS_IMAGE} AS swept");
    expect(dockerfile).toContain("COPY --from=swept /app/node_modules");
    // The runtime stage must not reach back into the `deps` stage directly —
    // that is the path that re-resolves the tree on a cache miss.
    expect(dockerfile).not.toContain("COPY --from=deps");
  });

  test("build-image pins the runtime build to the image it swept", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "scripts/build-image.ts"), "utf8");
    expect(src).toContain('run("docker", ["tag", depsId, depsTag]');
    expect(src).toContain("DEPS_IMAGE=${depsTag}");
  });
});

describe("INV-5 credential predicates", () => {
  test("private keys and credential stores are findings on sight, even inside node_modules", () => {
    for (const p of [
      "root/.git-credentials",
      "home/node/.ssh/known_hosts",
      "home/node/id_ed25519",
      "app/node_modules/pkg/.ssh/id_rsa",
      "app/keystore.p12",
    ]) {
      expect(classifyScanPath(p)).toBe("credential");
    }
  });

  test("config files are inspected rather than assumed — including npm's builtin .npmrc", () => {
    expect(classifyScanPath("usr/local/lib/node_modules/npm/.npmrc")).toBe("inspect");
    expect(classifyScanPath("app/.npmrc")).toBe("inspect");
    expect(classifyScanPath("root/.netrc")).toBe("inspect");
    expect(classifyScanPath("app/credentials")).toBe("inspect");
    expect(classifyScanPath("app/.env")).toBe("inspect");
  });

  test("the env/key families are inspected, not just the exact names", () => {
    for (const p of ["app/.env.local", "app/.env.production", "app/tls.key", "app/keystore.jks", "root/.docker/config.json"]) {
      expect(classifyScanPath(p)).toBe("inspect");
    }
  });

  test("innocent dependency fixtures are not even inspected", () => {
    expect(classifyScanPath("app/node_modules/pkg/test/fixtures/credentials")).toBeNull();
    expect(classifyScanPath("app/node_modules/pkg/test/cert.pem")).toBeNull();
    expect(classifyScanPath("app/node_modules/pkg/index.js")).toBeNull();
  });

  test("a config file is a finding only when its contents carry a secret", () => {
    // npm's builtin config, verbatim in shape — the file that made a
    // name-only scan fail on a stock node:22 image.
    expect(configLooksLikeCredential("; builtin config file\nprefix=/usr/local\n")).toBe(false);
    expect(configLooksLikeCredential("registry=https://registry.npmjs.org/\n")).toBe(false);
    expect(configLooksLikeCredential("//registry.npmjs.org/:_authToken=abc123\n")).toBe(true);
    expect(configLooksLikeCredential("machine api.github.com login me password p\n")).toBe(true);
    expect(configLooksLikeCredential("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
    expect(configLooksLikeCredential("-----BEGIN CERTIFICATE-----\n")).toBe(false);
    // A .env carries its secrets as plain NAME=value pairs.
    expect(configLooksLikeCredential("PORT=3000\nANTHROPIC_API_KEY=sk-live-abc\n")).toBe(true);
    expect(configLooksLikeCredential("GITHUB_TOKEN=ghs_abcdefgh\n")).toBe(true);
    expect(configLooksLikeCredential("PORT=3000\nNODE_ENV=production\n")).toBe(false);
    // An AWS shared-credentials file spaces its `=`.
    expect(configLooksLikeCredential("[default]\naws_secret_access_key = abc123\n")).toBe(true);
  });

  test("the layer-history matcher catches the keyword-less BuildKit build-arg shape", () => {
    expect("|1 NPM_TOKEN=abc123 /bin/sh -c npm install").toMatch(SECRET_ENV);
    expect("ENV FOO=1 AWS_SECRET_ACCESS_KEY=abc").toMatch(SECRET_ENV);
    expect("ARG GITHUB_TOKEN=ghp_x").toMatch(SECRET_ENV);
    expect("/bin/sh -c npm install --omit=optional").not.toMatch(SECRET_ENV);
    expect("ENV NODE_VERSION=22.11.0").not.toMatch(SECRET_ENV);
  });
});

// ─────────────────────────── vendored provenance ─────────────────────────

describe("vendored provenance (AC5)", () => {
  const vendor = path.join(REPO_ROOT, "pi-vs-claude-code-vendor");

  test("coms.ts attributes the file to disler/pi-vs-claude-code extensions/ @ 0ed11f44", () => {
    const header = fs.readFileSync(path.join(vendor, "coms.ts"), "utf8").slice(0, 2000);
    expect(header).toContain("disler/pi-vs-claude-code");
    expect(header).toContain("extensions/");
    expect(header).toContain("0ed11f44");
    expect(header).not.toContain("pi-mono coms extension");
  });

  test("the header commit matches package.json _provenance", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(vendor, "package.json"), "utf8"));
    const header = fs.readFileSync(path.join(vendor, "coms.ts"), "utf8").slice(0, 2000);
    expect(pkg._provenance.commit.startsWith("0ed11f44")).toBe(true);
    expect(pkg._provenance.source_repo).toContain("disler/pi-vs-claude-code");
    expect(header).toContain(pkg._provenance.commit.slice(0, 8));
  });

  test("the edit is recorded in DIVERGENCE.md", () => {
    const div = fs.readFileSync(path.join(vendor, "DIVERGENCE.md"), "utf8");
    expect(div).toContain("Provenance header");
  });
});
