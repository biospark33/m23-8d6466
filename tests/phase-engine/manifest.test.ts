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
import {
  loadManifestWithSeams,
  stampManifestLimit,
  stripAuthoredLimit,
} from "../../src/phase-engine/manifest.ts";
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
    // DF1.10 C19: `engineer` was this helper's arbitrary "some valid kind"
    // placeholder and no longer exists. `code` is the one kind that needs no
    // extra fields beyond a command, so it is the cheapest stand-in — the cases
    // that care about kind-specific rules override both fields explicitly.
    kind: "code",
    command: ["true"],
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
    const spec = { name: "plan", kind: "code", command: ["true"], description: "Produce the reviewed plan" };
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
    // PR #216 round 4 (PM4): the same `.min(MIN_PHASES)` message must fire for
    // the EMPTY array and for the key dropped entirely — "one element hits it"
    // was assumed, never pinned, so relaxing min(2) to min(1) or dropping
    // `phases` to optional passed the suite. The absent-key row also pins the
    // required-key refusal itself (zod invalid_type, "Required"), not a
    // phantom closed-set message.
    ["an empty phases array", { phases: [] }, /phases: phaseCount < 2/],
    ["the phases key absent", { phases: undefined }, /phases: Required/],
  ];
  for (const [label, over, pattern] of cases) {
    test(`rejects: ${label}`, () => {
      const root = freshRoot();
      const p = writeManifest(root, manifestObject(over));
      expect(() => loadManifest(p, 10_000_000, root)).toThrow(pattern);
    });
  }

  const phaseCases: [string, Record<string, unknown>, RegExp][] = [
    // Pinned to the ENUM's own text, not a bare /kind/: this helper now defaults
    // `command: ["true"]`, so an unknown kind also trips the command rule, whose
    // message ("command is forbidden when kind is 'wizard'") matches /kind/ just
    // as well. The loose pattern stayed green with the enum check deleted.
    [
      "kind outside the closed set",
      { kind: "wizard" },
      /kind must be one of 'code' \| 'dispatch_task'; got 'wizard'/,
    ],
    // A kind that names an `Object.prototype` member. The remediation table is
    // an object literal, so an ungated `table[received]` resolved off the
    // PROTOTYPE and handed zod a Function as the issue message — the refusal
    // then escaped the loader as a TypeError instead of a ManifestError.
    [
      "a kind that collides with an Object.prototype key",
      { kind: "constructor" },
      /kind must be one of 'code' \| 'dispatch_task'; got 'constructor'/,
    ],
    // The shape an operator most plausibly produces by deleting `kind:
    // "engineer"` from a pre-C19 manifest. An omitted required field is not a
    // closed-set violation and must not be reported as one ("got 'undefined'").
    ["kind absent entirely", { kind: undefined }, /kind is missing; declare one of 'code' \| 'dispatch_task'/],
    ["kind of the wrong type", { kind: 7 }, /kind must be a string, got number/],
    // PR #216 round 4 (PM4): `name` has no custom error map, so a non-string
    // surfaces zod's own invalid_type text — pinned to prove the type check on
    // `name` exists at all (a coercing schema would load this manifest).
    ["a non-string phase name", { name: 7 }, /phases\.0\.name: Expected string, received number/],
    ["unknown phase field", { nope: true }, /unrecognized key|nope/i],
    ["retries above the 0..5 bound", { retries: 6 }, /retries/],
    ["retries below the 0..5 bound", { retries: -1 }, /retries/],
    ["maxDurationMs above the hard bound", { maxDurationMs: 900_001 }, /maxDurationMs/],
    // `undefined` rather than an omitted key: `over` is SPREAD over the helper's
    // defaults, so the only way to unset the default command is to overwrite it
    // — and JSON.stringify then drops the key, which is the manifest shape this
    // case is about.
    ["code phase without command", { command: undefined }, /command is required/],
    // The one remaining non-code kind, named explicitly now that the helper's
    // default IS code. Its own required fields ride along so the refusal under
    // test is the command rule and not a missing roster.
    [
      "non-code phase with command",
      { kind: "dispatch_task", roster: "r.yaml", task: "do it", command: ["echo", "hi"] },
      /command is forbidden/,
    ],
    // DF1.10 C19: the two removed kinds refuse AT LOAD, and the refusal names
    // the replacement rather than reciting the closed set. PR #216 round 4
    // (P26): the old patterns (/dispatch_task/, /fleet approve|fleet attach/)
    // matched the GENERIC closed-set message too — "kind must be one of
    // 'code' | 'dispatch_task'; got 'agent'" contains "dispatch_task" — so
    // they stayed green with the remediation lookup dead. Each row now pins
    // the remediation's own opening clause.
    [
      "the removed `agent` kind, with its remediation",
      { kind: "agent" },
      /kind 'agent' was removed \(DF1\.10 C19\): declare kind 'dispatch_task' with a one-role roster/,
    ],
    [
      "the removed `engineer` kind, with its remediation",
      { kind: "engineer" },
      /kind 'engineer' was removed \(DF1\.10 C19\)/,
    ],
    ["empty description", { description: "" }, /description/],
    // A length check is not a content check. Every one of these used to LOAD,
    // be admitted, provision a box, and die mid-walk after spend: argv0 "  " is
    // ENOENT, `loadRoster("   ")` resolves nothing. Each row pins the message
    // for the field it is about, so a rule deleted elsewhere cannot cover for it.
    ["empty command array", { command: [] }, /phases\.0\.command: Array must contain at least 1 element/],
    [
      "an empty argv element",
      { command: ["", "x"] },
      /phases\.0\.command\.0: String must contain at least 1 character/,
    ],
    ["a whitespace-only argv element", { command: ["  "] }, /phases\.0\.command\.0: must not be whitespace-only/],
    ["a whitespace-only phase name", { name: "   " }, /phases\.0\.name: must not be whitespace-only/],
    [
      "a whitespace-only description",
      { description: " \t " },
      /phases\.0\.description: must not be whitespace-only/,
    ],
    [
      "an empty roster",
      { kind: "dispatch_task", roster: "", task: "t", command: undefined },
      /phases\.0\.roster: String must contain at least 1 character/,
    ],
    [
      "a whitespace-only roster",
      { kind: "dispatch_task", roster: "   ", task: "t", command: undefined },
      /phases\.0\.roster: must not be whitespace-only/,
    ],
    [
      "an empty task",
      { kind: "dispatch_task", roster: "r.yaml", task: "", command: undefined },
      /phases\.0\.task: String must contain at least 1 character/,
    ],
    [
      "a whitespace-only task",
      { kind: "dispatch_task", roster: "r.yaml", task: " ", command: undefined },
      /phases\.0\.task: must not be whitespace-only/,
    ],
    // DF1.10 round 3 (C2-2): invisible-but-not-whitespace. Every one of these
    // satisfied min(1) AND the whitespace-only refine — the manifest loaded,
    // the box was provisioned, argv0 ENOENT'd after spend. The four invisible
    // format characters and the non-tab/LF/CR controls are refused outright
    // now (INVISIBLE_OR_CONTROL_RE, manifest.ts).
    [
      "an invisibly blank argv element (ZWSP)",
      { command: ["\u200b"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element with a leading ZWSP",
      { command: ["\u200becho", "x"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "a phase name carrying a BOM",
      { name: "\ufeffbuild" },
      /phases\.0\.name: must not contain control or invisible characters/,
    ],
    [
      "a task carrying a NUL",
      { kind: "dispatch_task", roster: "r.yaml", task: "a\u0000b", command: undefined },
      /phases\.0\.task: must not contain control or invisible characters/,
    ],
    // PR #216 round 4 (D2): five more families the round-3 class still
    // admitted \u2014 every one renders as nothing (or, in the C1 range,
    // terminates lines downstream) while satisfying `min(1)` and `trim()`, so
    // each reaches the same after-spend death as the ZWSP rows above. Range
    // bounds are pinned at BOTH ends (U+0080/U+009F, U+2061/U+2064,
    // U+FFF9/U+FFFB) so an off-by-one in the class is caught.
    [
      "an argv element of only LRM (U+200E)",
      { command: ["\u200e"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only RLM (U+200F)",
      { command: ["\u200f"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only U+180E (Mongolian vowel separator)",
      { command: ["\u180e"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only C1 NEL (U+0085)",
      { command: ["\u0085"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only the C1 base (U+0080)",
      { command: ["\u0080"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only the C1 apex (U+009F)",
      { command: ["\u009f"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only invisible function application (U+2061)",
      { command: ["\u2061"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only invisible plus (U+2064)",
      { command: ["\u2064"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
    [
      "a phase name of only an interlinear annotation anchor (U+FFF9)",
      { name: "\ufff9" },
      /phases\.0\.name: must not contain control or invisible characters/,
    ],
    [
      "a task of only an interlinear annotation terminator (U+FFFB)",
      { kind: "dispatch_task", roster: "r.yaml", task: "\ufffb", command: undefined },
      /phases\.0\.task: must not contain control or invisible characters/,
    ],
    // Lead decision on blind's D2 variant: the Trojan-Source bidi controls
    // U+202A-U+202E join the refusal set — they render as nothing AND can
    // reorder displayed text, which is "can HIDE" twice over. Both bounds
    // pinned like the ranges above.
    [
      "a phase name of only a bidi embedding LRE (U+202A)",
      { name: "\u202a" },
      /phases\.0\.name: must not contain control or invisible characters/,
    ],
    [
      "an argv element of only RLO (U+202E)",
      { command: ["\u202e"] },
      /phases\.0\.command\.0: must not contain control or invisible characters/,
    ],
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

  // PR #216 round 4 (D2): the widened invisible class narrows ADMISSION, not
  // the alphabet — text that renders and types still loads. The CJK characters
  // are here on purpose: they are the rendering fillers the refusal set
  // deliberately leaves admitted.
  test("visible text carrying none of the refused families still loads", () => {
    const root = freshRoot();
    const p = writeManifest(
      root,
      manifestObject({
        phases: [
          phase({
            name: "plån",
            command: ["echo", "naïve-✓-中文"],
            description: "Ordinary visible text with spaces and punctuation",
          }),
          phase({ name: "build", description: "Apply the reviewed change" }),
        ],
      }),
    );
    const { manifest } = loadManifest(p, 10_000_000, root);
    expect(manifest.phases[0]?.command).toEqual(["echo", "naïve-✓-中文"]);
  });

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
    // Whitespace-only is deliberately NOT in this list any more: the schema's
    // non-blank check refuses it one layer earlier, so it never reaches
    // `descriptionDefect` and carries the schema's message instead of this
    // one's. The `phaseCases` table above pins that refusal.
    for (const description of ["Plan", "..."]) {
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
          // The description restates the name rather than being blank: a blank
          // one is now refused by the schema, whose message quotes the FIELD,
          // not the name — and the name is the value under test here. This
          // description trips `descriptionDefect`, whose message is prefixed
          // with the sanitized name.
          phase({ name: "plan\nFAKE LOG LINE", description: "Plan FAKE LOG LINE" }),
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
    // RE-READ the input, AFTER the strip. Asserting `loaded.manifest
    // .limitMicroUsd` only above proved nothing about aliasing: a
    // `stripAuthoredLimit` that did `delete input.manifest.limitMicroUsd` and
    // returned the same object passes every line here, while the runner-side
    // caller — which holds `loaded`, not `stripped`, and reads the limit back
    // out of it — silently loses its cap and falls to DF1.6's default. A
    // "returns a new value" contract has to be checked on the OLD value.
    expect(loaded.manifest.limitMicroUsd).toBe(999_000_000);
    expect(stripped.manifest).not.toBe(loaded.manifest);
    expect(stripped).not.toBe(loaded);
    // ponytail: the copy is SHALLOW — `phases` is the same array in both — and
    // that is fine as it stands, because nothing on either side mutates a phase
    // list. Not asserted either way: pinning a property the source does not
    // claim would be a test of the implementation rather than the contract. The
    // contract is that the LIMIT survives on the input, which is the line above.
    // Dropped for the same reason `stampManifestLimit` drops it: once a field
    // has been removed the bytes match no file on disk, so carrying the
    // unstripped file's path forward would claim provenance this content has
    // lost. Mirrors tests/fleet/brief-schema.test.ts's stamping sibling.
    expect(loaded.resolvedPath).toBe(fs.realpathSync(p));
    expect(stripped.resolvedPath).toBeUndefined();
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

describe("stampManifestLimit — monotonic ceiling guard", () => {
  /** A loaded, unstamped fixture: the ordinary first-stamp input. */
  function loadUnstamped(): ReturnType<typeof loadManifest> {
    const root = freshRoot();
    return loadManifest(writeManifest(root, manifestObject()), 10_000_000, root);
  }

  test("a first stamp onto an absent limit lands whatever admission granted", () => {
    expect(stampManifestLimit(loadUnstamped(), 500_000).manifest.limitMicroUsd).toBe(500_000);
  });

  test("re-stamping HIGHER than an existing ceiling is refused, naming both values", () => {
    const once = stampManifestLimit(loadUnstamped(), 500_000);
    // Both figures in one message: the operator sees the admitted ceiling and
    // the attempted one without re-running anything.
    expect(() => stampManifestLimit(once, 9_000_000)).toThrow(
      /refusing to raise limitMicroUsd from 500000 to 9000000/,
    );
    // The refusal leaves the granted ceiling intact on the input.
    expect(once.manifest.limitMicroUsd).toBe(500_000);
  });

  test("re-stamping EQUAL passes", () => {
    const once = stampManifestLimit(loadUnstamped(), 500_000);
    expect(stampManifestLimit(once, 500_000).manifest.limitMicroUsd).toBe(500_000);
  });

  test("re-stamping LOWER passes — the ceiling is downward-only", () => {
    // Tightening preserves doctrine: every downstream consumer clamps down, so
    // a lower re-stamp only ever shrinks spend.
    const once = stampManifestLimit(loadUnstamped(), 9_000_000);
    expect(stampManifestLimit(once, 250_000).manifest.limitMicroUsd).toBe(250_000);
  });

  test("the positive-safe-integer validation runs before the guard", () => {
    const once = stampManifestLimit(loadUnstamped(), 500_000);
    expect(() => stampManifestLimit(once, 1.5)).toThrow(/must be a positive integer/);
  });
});
