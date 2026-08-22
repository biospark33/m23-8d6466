/**
 * Manifest load tests (Story DF1.1): INV-1 beneath-root read, INV-2 closed
 * validation, INV-4 credential refusal, INV-5 fail-closed, and the admission
 * arithmetic both retry multipliers depend on.
 *
 * The two traversal tests are the load-bearing ones. The first proves the read
 * is not merely `O_NOFOLLOW` on the final component; the second proves the fd is
 * verified *after* it is opened, which is the only thing that closes the
 * resolve-to-open window.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ManifestError,
  PARSE_FIX_ATTEMPTS,
  loadManifest,
  requiredBudgetMs,
} from "../../src/phase-engine/index.ts";
// Imported from the module, not the barrel: the seams can weaken INV-1, so they
// are deliberately absent from the package's public surface.
import { loadManifestWithSeams, stripAuthoredLimit } from "../../src/phase-engine/manifest.ts";
import { sanitizeForMessage } from "../../src/phase-engine/types.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-1-manifest-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
/** A fresh isolated run root per case, so a symlink in one cannot leak into another. */
function freshRoot(): string {
  const dir = path.join(tmpRoot, `root-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function phase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "plan",
    kind: "engineer",
    description: "Produce the reviewed implementation plan",
    maxDurationMs: 10_000,
    retries: 0,
    ...over,
  };
}

function manifestObject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    pipelineId: "demo-pipeline",
    runBudgetMs: 70_000,
    phases: [phase(), phase({ name: "build", description: "Apply the reviewed change" })],
    ...over,
  };
}

function writeManifest(dir: string, body: unknown, name = "pipeline.json"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}

/** Default fixture: 2 phases × 10 s × (0+1) × (2+1) + 2 × 5 s margin = 70 000 ms. */
const DEFAULT_REQUIRED_MS = 70_000;

describe("loadManifest — admission", () => {
  test("loads a well-formed manifest and freezes it", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    const { manifest } = loadManifest(p, 120_000, root);

    expect(manifest.pipelineId).toBe("demo-pipeline");
    expect(manifest.phases).toHaveLength(2);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.phases)).toBe(true);
    expect(Object.isFrozen(manifest.phases[0])).toBe(true);
  });

  test("in-flight pin: a mid-run edit to the file cannot change the loaded value", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    const { manifest } = loadManifest(p, 120_000, root);

    writeManifest(root, manifestObject({ pipelineId: "swapped-pipeline" }));
    expect(manifest.pipelineId).toBe("demo-pipeline");
  });

  test("applies the documented defaults for maxDurationMs and retries", () => {
    const root = freshRoot();
    const spec = { name: "plan", kind: "engineer", description: "Produce the reviewed plan" };
    const p = writeManifest(
      root,
      manifestObject({
        runBudgetMs: 3_610_000,
        phases: [spec, { ...spec, name: "build", description: "Apply the reviewed change" }],
      }),
    );
    const { manifest } = loadManifest(p, 4_000_000, root);
    expect(manifest.phases[0]?.maxDurationMs).toBe(600_000);
    expect(manifest.phases[0]?.retries).toBe(0);
  });

  test("callerBudgetMs is never assumed (AC5)", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    expect(() => loadManifest(p, undefined, root)).toThrow(ManifestError);
    expect(() => loadManifest(p, 0, root)).toThrow(/callerBudgetMs/);
    expect(() => loadManifest(p, 1.5, root)).toThrow(/callerBudgetMs/);
  });

  test("runRoot must be supplied and must be a directory (INV-1)", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    expect(() => loadManifest(p, 120_000, undefined)).toThrow(/runRoot/);
    expect(() => loadManifest(p, 120_000, "")).toThrow(/runRoot/);
    expect(() => loadManifest(p, 120_000, p)).toThrow(/not a directory/);
    expect(() => loadManifest(p, 120_000, path.join(root, "absent"))).toThrow(/not resolvable/);
  });
});

describe("loadManifest — budget boundary (both retry multipliers)", () => {
  test("PARSE_FIX_ATTEMPTS is 2 and is carried by the formula", () => {
    expect(PARSE_FIX_ATTEMPTS).toBe(2);
    expect(requiredBudgetMs([{ retries: 0, maxDurationMs: 10_000 }])).toBe(
      (PARSE_FIX_ATTEMPTS + 1) * 10_000 + 5_000,
    );
  });

  test("retries: 0 — exact fit loads, 1 ms short of callerBudgetMs refuses", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject({ runBudgetMs: DEFAULT_REQUIRED_MS }));
    expect(loadManifest(p, DEFAULT_REQUIRED_MS, root).manifest.runBudgetMs).toBe(DEFAULT_REQUIRED_MS);
    expect(() => loadManifest(p, DEFAULT_REQUIRED_MS - 1, root)).toThrow(/exceeds callerBudgetMs/);
  });

  test("retries: 1 — the retry multiplier cannot be dropped silently", () => {
    const root = freshRoot();
    const phases = [
      phase({ retries: 1 }),
      phase({ name: "build", description: "Apply the reviewed change", retries: 1 }),
    ];
    const required = 2 * 2 * (PARSE_FIX_ATTEMPTS + 1) * 10_000 + 2 * 5_000;
    expect(requiredBudgetMs([
      { retries: 1, maxDurationMs: 10_000 },
      { retries: 1, maxDurationMs: 10_000 },
    ])).toBe(required);

    const tight = writeManifest(root, manifestObject({ phases, runBudgetMs: required - 1 }), "tight.json");
    expect(() => loadManifest(tight, 10_000_000, root)).toThrow(/demands \d+ ms of phase budget/);

    const exact = writeManifest(root, manifestObject({ phases, runBudgetMs: required }), "exact.json");
    expect(loadManifest(exact, required, root).manifest.runBudgetMs).toBe(required);
    expect(() => loadManifest(exact, required - 1, root)).toThrow(/exceeds callerBudgetMs/);
  });

  test("the (PARSE_FIX_ATTEMPTS + 1) factor cannot be dropped silently", () => {
    const root = freshRoot();
    // What the formula would demand if the parse-fix factor were 1.
    const withoutParseFix = 2 * 1 * 1 * 10_000 + 2 * 5_000;
    expect(withoutParseFix).toBeLessThan(DEFAULT_REQUIRED_MS);
    const p = writeManifest(root, manifestObject({ runBudgetMs: withoutParseFix }));
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/demands 70000 ms of phase budget/);
  });
});

describe("loadManifest — closed validation (INV-2)", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["unknown top-level field", { extra: 1 }, /unrecognized key|extra/i],
    ["unsupported version", { version: "2.0.0" }, /version/],
    ["pipelineId shape", { pipelineId: "Bad_Id" }, /pipelineId/],
    ["fewer than 2 phases", { phases: [phase()] }, /phaseCount < 2/],
  ];
  for (const [label, over, pattern] of cases) {
    test(`rejects: ${label}`, () => {
      const root = freshRoot();
      const p = writeManifest(root, manifestObject(over));
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(pattern);
    });
  }

  const phaseCases: [string, Record<string, unknown>, RegExp][] = [
    ["kind outside the closed set", { kind: "wizard" }, /kind/],
    ["unknown phase field", { nope: true }, /unrecognized key|nope/i],
    ["retries above the 0..5 bound", { retries: 6 }, /retries/],
    ["retries below the 0..5 bound", { retries: -1 }, /retries/],
    ["maxDurationMs above the hard bound", { maxDurationMs: 900_001 }, /maxDurationMs/],
    ["code phase without command", { kind: "code" }, /command is required/],
    ["non-code phase with command", { command: ["echo", "hi"] }, /command is forbidden/],
    ["empty description", { description: "" }, /description/],
  ];
  for (const [label, over, pattern] of phaseCases) {
    test(`rejects phase: ${label}`, () => {
      const root = freshRoot();
      const p = writeManifest(
        root,
        manifestObject({ phases: [phase(over), phase({ name: "build", description: "Apply the change" })] }),
      );
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(pattern);
    });
  }

  test("a code phase with a command is accepted", () => {
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({ kind: "code", command: ["echo", "hi"], testCommand: ["bun", "test"] }),
          phase({ name: "build", description: "Apply the reviewed change" }),
        ],
      }),
    );
    const { manifest } = loadManifest(p, 10_000_000, root);
    expect(manifest.phases[0]?.command).toEqual(["echo", "hi"]);
    expect(manifest.phases[0]?.testCommand).toEqual(["bun", "test"]);
    expect(manifest.phases[1]?.testCommand).toBeUndefined();
  });

  test("an illegible phase description is refused at load, not mid-walk", () => {
    const root = freshRoot();
    for (const description of ["Plan", "   ", "..."]) {
      const p = writeManifest(
        root,
        manifestObject({
          phases: [
            phase({ name: "plan", description }),
            phase({ name: "build", description: "Apply the reviewed change" }),
          ],
        }),
        `desc-${description.trim().length}-${seq++}.json`,
      );
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(/phases\.0 \('plan'\)/);
    }
  });

  test("a newline in phase name or description cannot forge extra log lines", () => {
    // PR #104 round-3: `sanitizeForMessage` must cover every manifest-controlled
    // value reaching a message, not just manifest keys — a raw `\n` in `name` or
    // `description` would otherwise inject a fake second line into whatever logs
    // or reports the thrown message.
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({ name: "plan\nFAKE LOG LINE", description: "   " }),
          phase({ name: "build", description: "Apply the reviewed change" }),
        ],
      }),
    );
    let message = "";
    try {
      loadManifest(p, 10_000_000, root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("\\n");
    expect(message.split("\n")).toHaveLength(1);
  });

  test("a newline-bearing unknown key cannot forge extra log lines via the Zod validation-issue path", () => {
    // PR #104 round-4: a non-credential-shaped unknown key survives
    // `assertNoCredentials` (it doesn't match CREDENTIAL_FIELD), then reaches
    // strict Zod validation. `.strict()`'s `unrecognized_keys` issue embeds the
    // raw key inside `issue.message` itself — not only `issue.path` — so the
    // formatter must sanitize the whole issue, not just the path join.
    const root = freshRoot();
    const p = writeManifest(root, manifestObject({ "bogus\nFAKE LOG LINE": 1 }));
    let message = "";
    try {
      loadManifest(p, 10_000_000, root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("\\n");
    expect(message.split("\n")).toHaveLength(1);
  });

  test("a newline-bearing unknown phase key cannot forge extra log lines via the Zod validation-issue path", () => {
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({ "bogus\nFAKE LOG LINE": 1 }),
          phase({ name: "build", description: "Apply the reviewed change" }),
        ],
      }),
    );
    let message = "";
    try {
      loadManifest(p, 10_000_000, root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("\\n");
    expect(message.split("\n")).toHaveLength(1);
  });

  test("malformed JSON is a load error, not a crash", () => {
    const root = freshRoot();
    const p = writeManifest(root, "{ not json");
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/not valid JSON/);
  });
});

describe("sanitizeForMessage — every line-terminating/control character is escaped (PR #104 round-5)", () => {
  // Round 5: CodeRabbit found that `JSON.stringify(...).slice(1, -1)` alone
  // leaves U+2028/U+2029 literal, because they are valid (unescaped) JSON
  // string characters even though many log processors, terminals, and JS
  // parsers treat them as line terminators. An empirical sweep of the C0/C1
  // control ranges found the same gap for U+007F (DEL) and the whole C1 range
  // U+0080-U+009F (which includes U+0085 NEL, itself a line terminator).
  const survivingChars: Record<string, string> = {
    "U+007F DEL": "\x7f",
    "U+0080 C1 PAD": "\x80",
    "U+0085 NEL": "\x85",
    "U+009B CSI": "\x9b",
    "U+009F C1 APC": "\x9f",
    "U+2028 LINE SEPARATOR": " ",
    "U+2029 PARAGRAPH SEPARATOR": " ",
  };

  for (const [label, ch] of Object.entries(survivingChars)) {
    test(`${label} is escaped, not passed through literal`, () => {
      const out = sanitizeForMessage(`x${ch}y`);
      const expectedEscape = `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      expect(out).toContain(expectedEscape);
      expect(out).not.toContain(ch);
    });
  }

  // Characters JSON.stringify already escapes correctly (round-3/4 coverage) —
  // guard against a regression that only re-escapes the newly-added set.
  const alreadyEscapedChars: Record<string, string> = {
    "U+000A LF": "\n",
    "U+000D CR": "\r",
    "U+0009 TAB": "\t",
    "U+0000 NUL": "\x00",
  };

  for (const [label, ch] of Object.entries(alreadyEscapedChars)) {
    test(`${label} remains escaped`, () => {
      const out = sanitizeForMessage(`x${ch}y`);
      expect(out).not.toContain(ch);
    });
  }

  test("an ordinary space is left untouched (not a control/line-terminator character)", () => {
    expect(sanitizeForMessage("x y")).toBe("x y");
  });
});

describe("loadManifest — credential refusal (INV-4)", () => {
  const values = ["sk-live-abcdef", "ghp_deadbeef", "Bearer abc.def", "-----BEGIN PRIVATE KEY-----"];
  for (const value of values) {
    test(`rejects a credential-shaped value: ${value.slice(0, 12)}`, () => {
      const root = freshRoot();
      const p = writeManifest(
        root,
        manifestObject({
          phases: [phase({ description: `Use ${value} to authenticate` }), phase({ name: "build", description: "Apply the change" })],
        }),
      );
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-shaped value/);
    });
  }

  for (const field of ["key", "token", "secret", "password", "Token", "SECRET"]) {
    test(`rejects a credential-named field: ${field}`, () => {
      const root = freshRoot();
      const p = writeManifest(root, manifestObject({ [field]: "anything" }));
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-named field/);
    });
  }

  test("a credential nested inside a phase is rejected too", () => {
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [phase({ secret: "hunter2" }), phase({ name: "build", description: "Apply the change" })],
      }),
    );
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-named field 'secret'/);
  });

  test("credential shapes that must be caught, and English that must not be", () => {
    const root = freshRoot();
    const rejected = [
      "Send bearer eyJhbGciOi to the API",
      "Use SK-LIVE-abcdefgh12 for the call",
    ];
    for (const description of rejected) {
      const p = writeManifest(
        root,
        manifestObject({
          phases: [phase({ description }), phase({ name: "build", description: "Apply the change" })],
        }),
        `cred-${rejected.indexOf(description)}.json`,
      );
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-shaped value/);
    }

    // Ordinary English containing `sk-` must load: an over-eager scanner that
    // refuses "risk-adjusted" is a refusal engineers learn to work around.
    const ok = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({ description: "Assess risk-adjusted rollout options for the change" }),
          phase({ name: "build", description: "Apply the task-local change" }),
        ],
      }),
      "clean.json",
    );
    expect(loadManifest(ok, 10_000_000, root).manifest.phases).toHaveLength(2);
  });

  test("a credential hidden in a command argv is rejected", () => {
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({ kind: "code", command: ["curl", "-H", "Authorization: Bearer abcd1234"] }),
          phase({ name: "build", description: "Apply the change" }),
        ],
      }),
    );
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-shaped value/);
  });

  test("a credential-named field is caught however it is spelled", () => {
    const root = freshRoot();
    for (const field of ["api_key", "apiKey", "access-token", "db_password"]) {
      const p = writeManifest(root, manifestObject({ [field]: "x" }), `${field}.json`);
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-named field/);
    }
  });

  test("a manifest nested past the depth ceiling is a load error, not a stack overflow", () => {
    const root = freshRoot();
    let nested: unknown = "leaf";
    for (let i = 0; i < 200; i++) nested = [nested];
    const p = writeManifest(root, manifestObject({ deep: nested }));
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/nests deeper than 64 levels/);
  });

  test("the credential scan runs before the closed schema, so it cannot be laundered", () => {
    const root = freshRoot();
    // Also carries an unknown field: the credential message must be the one raised.
    const p = writeManifest(root, manifestObject({ token: "ghp_x", alsoUnknown: 1 }));
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/credential-named field 'token'/);
  });
});

describe("loadManifest — beneath-root walk (INV-1, INV-5)", () => {
  test("an intermediate-directory symlink pointing outside runRoot is rejected", () => {
    const root = freshRoot();
    const outside = path.join(tmpRoot, `outside-${seq++}`);
    fs.mkdirSync(outside, { recursive: true });
    writeManifest(outside, manifestObject({ pipelineId: "attacker-pipeline" }));

    // `escape` is an INTERMEDIATE component: `O_NOFOLLOW` on the final component
    // would not catch this, which is precisely what the prefix re-assertion does.
    fs.symlinkSync(outside, path.join(root, "escape"));
    const viaSymlink = path.join(root, "escape", "pipeline.json");
    expect(fs.existsSync(viaSymlink)).toBe(true);

    expect(() => loadManifest(viaSymlink, 10_000_000, root)).toThrow(
      /manifest resolves outside the run root/,
    );
  });

  test("a symlinked manifest file pointing outside runRoot is rejected", () => {
    const root = freshRoot();
    const outside = path.join(tmpRoot, `outside-${seq++}`);
    fs.mkdirSync(outside, { recursive: true });
    const target = writeManifest(outside, manifestObject({ pipelineId: "attacker-pipeline" }));
    fs.symlinkSync(target, path.join(root, "pipeline.json"));

    expect(() => loadManifest(path.join(root, "pipeline.json"), 10_000_000, root)).toThrow(
      /manifest resolves outside the run root/,
    );
  });

  test("a swap between realpath and open is caught by the post-open fd-path check", () => {
    const root = freshRoot();
    const dir = path.join(root, "dir");
    fs.mkdirSync(dir);
    const good = writeManifest(dir, manifestObject({ pipelineId: "honest-pipeline" }));
    expect(fs.existsSync(good)).toBe(true);

    const outside = path.join(tmpRoot, `outside-${seq++}`);
    fs.mkdirSync(outside, { recursive: true });
    writeManifest(outside, manifestObject({ pipelineId: "attacker-pipeline" }));

    let swapped = 0;
    const onResolved = () => {
      // Fires after the realpath resolution and before the open: replace the
      // resolved path's intermediate directory with a symlink out of the root.
      swapped += 1;
      fs.renameSync(dir, `${dir}.real`);
      fs.symlinkSync(outside, dir);
    };

    // Names its own mechanism: this message can only come from the post-open
    // fd-path check (call site 2), never from the pre-open prefix re-assertion.
    expect(() => loadManifestWithSeams(good, 10_000_000, root, { onResolved })).toThrow(
      /opened manifest descriptor resolves outside the run root/,
    );
    expect(swapped).toBe(1);
  });

  test("without the swap, the same path loads — the check is not vacuous", () => {
    const root = freshRoot();
    const dir = path.join(root, "dir");
    fs.mkdirSync(dir);
    const good = writeManifest(dir, manifestObject({ pipelineId: "honest-pipeline" }));
    expect(loadManifest(good, 10_000_000, root).manifest.pipelineId).toBe("honest-pipeline");
  });

  test("an in-root swap to a different file is caught too", () => {
    const root = freshRoot();
    const dir = path.join(root, "dir");
    const sibling = path.join(root, "sibling");
    fs.mkdirSync(dir);
    fs.mkdirSync(sibling);
    const good = writeManifest(dir, manifestObject({ pipelineId: "honest-pipeline" }));
    writeManifest(sibling, manifestObject({ pipelineId: "other-pipeline" }));

    expect(() =>
      loadManifestWithSeams(good, 10_000_000, root, {
        onResolved: () => {
          fs.renameSync(dir, `${dir}.real`);
          fs.symlinkSync(sibling, dir);
        },
      }),
    ).toThrow(/changed between resolution and open/);
  });

  test("INV-5: where the fd path cannot be resolved, the read is refused", () => {
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    // Stands in for a platform exposing neither /proc/self/fd nor F_GETPATH.
    expect(() => loadManifestWithSeams(p, 10_000_000, root, { resolveFdPath: () => null })).toThrow(
      /post-open fd-path verification is unavailable/,
    );
  });

  test("a FIFO beneath the run root is refused instead of blocking the loader", () => {
    const root = freshRoot();
    const fifo = path.join(root, "pipeline.json");
    const made = Bun.spawnSync({ cmd: ["mkfifo", fifo] });
    expect(made.exitCode).toBe(0);
    // Without O_NONBLOCK this open never returns and the run is neither green
    // nor red — it is absent, which is what the marker poller reads as "still going".
    expect(() => loadManifest(fifo, 10_000_000, root)).toThrow(/not a regular file/);
  });

  test("an oversized manifest is refused before it is parsed", () => {
    const root = freshRoot();
    const p = path.join(root, "pipeline.json");
    fs.writeFileSync(p, `{"pad":"${"x".repeat(1_100_000)}"}`);
    expect(() => loadManifest(p, 10_000_000, root)).toThrow(/above the 1048576-byte ceiling/);
  });

  test("a UTF-8 BOM does not make a valid manifest unloadable", () => {
    const root = freshRoot();
    const p = path.join(root, "pipeline.json");
    fs.writeFileSync(p, `﻿${JSON.stringify(manifestObject())}`);
    expect(loadManifest(p, 10_000_000, root).manifest.pipelineId).toBe("demo-pipeline");
  });

  test("the platform fd-path facility really resolves a known fd", () => {
    // The INV-5 test above stubs the resolver to null; this one proves the real
    // facility works on this machine, so fail-closed is a genuine branch and not
    // the only branch. (On darwin this is the F_GETPATH FFI binding.)
    const root = freshRoot();
    const p = writeManifest(root, manifestObject());
    expect(loadManifest(p, 10_000_000, root).resolvedPath).toBe(fs.realpathSync(p));
  });

  test("loadManifest KEEPS a file's limitMicroUsd; stripAuthoredLimit is what drops it", () => {
    // The loader reads both sides of the box boundary — the runner reads the
    // stamped pipeline.yaml back through it — so it must not strip. The
    // dispatch-side read strips, because only it knows the value is the
    // author's rather than the dispatcher's.
    const root = freshRoot();
    const p = writeManifest(root, { ...manifestObject(), limitMicroUsd: 999_000_000 });
    const loaded = loadManifest(p, 10_000_000, root);
    expect(loaded.manifest.limitMicroUsd).toBe(999_000_000);

    const stripped = stripAuthoredLimit(loaded);
    expect(stripped.manifest.limitMicroUsd).toBeUndefined();
    expect("limitMicroUsd" in stripped.manifest).toBe(false);
    expect(stripped.manifest.pipelineId).toBe(loaded.manifest.pipelineId);
    expect(stripped.manifest.phases).toHaveLength(loaded.manifest.phases.length);
  });

  test("a final-component swap surfaces as a ManifestError, not a raw ELOOP", () => {
    const root = freshRoot();
    const outside = path.join(tmpRoot, `outside-${seq++}`);
    fs.mkdirSync(outside, { recursive: true });
    const target = writeManifest(outside, manifestObject({ pipelineId: "attacker-pipeline" }));
    const good = writeManifest(root, manifestObject());

    let thrown: unknown;
    try {
      loadManifestWithSeams(good, 10_000_000, root, {
        onResolved: () => {
          fs.rmSync(good);
          fs.symlinkSync(target, good);
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManifestError);
  });

  test("a directory handed in as the manifest is refused", () => {
    const root = freshRoot();
    const dir = path.join(root, "dir");
    fs.mkdirSync(dir);
    expect(() => loadManifest(dir, 10_000_000, root)).toThrow(ManifestError);
  });
});
