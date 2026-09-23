/**
 * DF1.5 — roster schema, shallow defaults merge, slug resolution.
 *
 * AC2 (shallow merge, list replacement), AC-adjacent Technical Notes
 * (closed key set, `thinking: max` rejected, provider-authoritative slug
 * resolution), INV-2 (schema parse before any probe; path confinement).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRoster,
  parseRoster,
  ROSTER_MAX_BYTES,
  RosterError,
  SELF_COMPACT_EXTENSION,
  THINKING_LEVELS,
} from "../../../src/phase-engine/roster/schema.ts";

function y(strings: TemplateStringsArray, ...v: unknown[]): string {
  return String.raw({ raw: strings }, ...v);
}

const MINIMAL = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: planner
    model: anthropic/claude-haiku-4.5
`;

describe("parseRoster — shape and closed key set", () => {
  test("parses a minimal roster and applies documented field defaults", () => {
    const r = parseRoster(MINIMAL);
    expect(r.roles).toHaveLength(1);
    const role = r.roles[0]!;
    expect(role.name).toBe("planner");
    expect(role.provider).toBe("openrouter");
    expect(role.model).toBe("anthropic/claude-haiku-4.5");
    expect(role.slug).toBe("openrouter/anthropic/claude-haiku-4.5");
    // Documented defaults: thinking off, tools/writes as declared, no extensions.
    expect(role.thinking).toBe("off");
    expect(role.tools).toBeNull();
    expect(role.writes).toEqual([]);
    expect(role.harness_engineering).toEqual([]);
  });

  test("an unknown role key is a validation error (closed schema)", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
    writes: []
    temperature: 0.7
`;
    expect(() => parseRoster(src)).toThrow(RosterError);
    try {
      parseRoster(src);
    } catch (e) {
      expect((e as RosterError).problems.join("\n")).toContain("temperature");
    }
  });

  test("an unknown top-level key and an unknown defaults key are both errors", () => {
    const src = y`
version: 2
defaults:
  provider: openrouter
  writes: []
  nonsense: 1
roles:
  - name: planner
    model: m
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      const msg = (e as RosterError).problems.join("\n");
      expect(msg).toContain("version");
      expect(msg).toContain("nonsense");
    }
  });

  test("collect-all: every problem is reported in one raise", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
    writes: []
    bogus: 1
  - name: planner
    provider: openrouter
    model: n
    writes: []
    thinking: max
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      const problems = (e as RosterError).problems;
      const joined = problems.join("\n");
      expect(joined).toContain("bogus");
      expect(joined).toContain("duplicate role name");
      expect(joined).toContain("max");
      expect(problems.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("`thinking: max` is rejected and the supported set is named", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
    writes: []
    thinking: max
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      const joined = (e as RosterError).problems.join("\n");
      for (const level of THINKING_LEVELS) expect(joined).toContain(level);
      expect(THINKING_LEVELS).not.toContain("max" as never);
    }
  });

  test("`writes` must be declared explicitly (fail-closed write scope)", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect((e as RosterError).problems.join("\n")).toContain("writes");
    }
  });

  test("roles must be a non-empty list", () => {
    expect(() => parseRoster("roles: []")).toThrow(RosterError);
    expect(() => parseRoster("defaults: {}")).toThrow(RosterError);
  });

  test("a non-mapping document is a validation error, not a crash", () => {
    expect(() => parseRoster("- 1\n- 2")).toThrow(RosterError);
    expect(() => parseRoster("")).toThrow(RosterError);
  });

  test("malformed YAML raises RosterError rather than leaking the parser error", () => {
    expect(() => parseRoster("roles: [\n")).toThrow(RosterError);
  });
});

describe("AC2 — shallow defaults merge, per-role value always wins", () => {
  test("per-role `tools` REPLACES the defaults list (no union, no concat)", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
  tools: ["read", "grep"]
roles:
  - name: planner
    model: m
    tools: ["read", "bash"]
  - name: worker
    model: n
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.tools).toEqual(["read", "bash"]);
    // Untouched role still inherits the defaults list verbatim.
    expect(r.roles[1]!.tools).toEqual(["read", "grep"]);
  });

  test("an explicit per-role `null` beats a defaults list (null = all usable)", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: ["src/"]
  tools: ["read", "grep"]
roles:
  - name: planner
    model: m
    tools: null
    writes: null
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.tools).toBeNull();
    expect(r.roles[0]!.writes).toBeNull();
  });

  test("no deep merge: a per-role scalar overrides, siblings are not blended", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
  thinking: high
  harness_engineering: ["ext/a.ts"]
roles:
  - name: planner
    model: m
    thinking: low
    harness_engineering: ["ext/b.ts"]
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.thinking).toBe("low");
    expect(r.roles[0]!.harness_engineering).toEqual(["ext/b.ts"]);
  });

  test("mutating a merged list does not bleed into a sibling role", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
  tools: ["read"]
roles:
  - name: a
    model: m
  - name: b
    model: n
`;
    const r = parseRoster(src);
    (r.roles[0]!.tools as string[]).push("bash");
    expect(r.roles[1]!.tools).toEqual(["read"]);
  });
});

describe("slug resolution — `provider` is authoritative", () => {
  test("provider + a model id containing `/` resolves verbatim (no split)", () => {
    const src = y`
roles:
  - name: flash
    provider: openrouter
    model: deepseek/deepseek-v4-flash-0731
    writes: []
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.provider).toBe("openrouter");
    expect(r.roles[0]!.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(r.roles[0]!.slug).toBe("openrouter/deepseek/deepseek-v4-flash-0731");
  });

  test("a vendor-namespaced gateway slug keeps its prefix (no provider claim)", () => {
    // `anthropic` is a pi provider id AND the vendor half of a real OpenRouter
    // model id. With an explicit `provider` the prefix is part of the model, so
    // this resolves verbatim; a genuine contradiction is caught by the catalog
    // gate in validate.ts, which knows the real (provider, model) pairs.
    const src = y`
roles:
  - name: flash
    provider: openrouter
    model: anthropic/claude-haiku-4.5
    writes: []
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.provider).toBe("openrouter");
    expect(r.roles[0]!.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("a model prefix matching its own provider is accepted and not stripped", () => {
    const src = y`
roles:
  - name: flash
    provider: openrouter
    model: openrouter/some-model
    writes: []
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.slug).toBe("openrouter/openrouter/some-model");
  });

  test("provider absent: model splits on the FIRST `/` only", () => {
    const src = y`
roles:
  - name: flash
    model: openrouter/deepseek/deepseek-v4-flash-0731
    writes: []
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.provider).toBe("openrouter");
    expect(r.roles[0]!.model).toBe("deepseek/deepseek-v4-flash-0731");
  });

  test("provider absent and no `/` in model is an error", () => {
    const src = y`
roles:
  - name: flash
    model: bare-model
    writes: []
`;
    expect(() => parseRoster(src)).toThrow(RosterError);
  });

  test("provider absent and a trailing `/` is an error (empty model half)", () => {
    const src = y`
roles:
  - name: flash
    model: openrouter/
    writes: []
`;
    expect(() => parseRoster(src)).toThrow(RosterError);
  });

  test("provider absent and a leading `/` is an error (empty provider half)", () => {
    const src = y`
roles:
  - name: flash
    model: /m
    writes: []
`;
    expect(() => parseRoster(src)).toThrow(RosterError);
  });
});

describe("silent-tool-filter warning", () => {
  test("harness_engineering + a non-null tools list warns", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
    writes: []
    tools: ["read"]
    harness_engineering: ["ext/tool.ts"]
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.warnings.join("\n")).toMatch(/extension/i);
    expect(r.warnings.length).toBe(1);
  });

  test("harness_engineering with `tools: null` does not warn", () => {
    const src = y`
roles:
  - name: planner
    provider: openrouter
    model: m
    writes: []
    tools: null
    harness_engineering: ["ext/tool.ts"]
`;
    expect(parseRoster(src).roles[0]!.warnings).toEqual([]);
  });
});

describe("loadRoster — INV-2 path confinement and size ceiling", () => {
  test("reads a roster inside the repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-ok-"));
    const p = join(dir, "a.roster.yaml");
    writeFileSync(p, MINIMAL);
    const r = loadRoster(p, { repoRoot: dir });
    expect(r.roles[0]!.name).toBe("planner");
    // The reported path is the DEREFERENCED one — the file actually read.
    expect(r.path).toBe(realpathSync(p));
  });

  test("a path escaping the repo root is refused before any read", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-esc-"));
    const inside = join(dir, "inside");
    mkdirSync(inside);
    writeFileSync(join(dir, "secret.yaml"), MINIMAL);
    expect(() => loadRoster(join(inside, "..", "secret.yaml"), { repoRoot: inside })).toThrow(
      /outside the repo root/,
    );
  });

  test("a SYMLINK inside the root pointing outside it is refused", () => {
    // Lexical confinement alone passes this: the link's own path is inside the
    // root. Only the dereferenced path reveals the escape — and since a parse
    // failure surfaces to stdout, letting it through would be a file-read
    // primitive, not just a confinement bug.
    const dir = mkdtempSync(join(tmpdir(), "roster-link-"));
    const root = join(dir, "repo");
    mkdirSync(root);
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, MINIMAL);
    const link = join(root, "link.roster.yaml");
    symlinkSync(outside, link);
    expect(() => loadRoster(link, { repoRoot: root })).toThrow(/outside the repo root/);
  });

  test("a YAML parse failure never echoes the offending source line", () => {
    // `yaml` appends the offending source line to its message, and the CLI
    // writes that message to stdout.
    const dir = mkdtempSync(join(tmpdir(), "roster-yaml-"));
    const p = join(dir, "bad.roster.yaml");
    writeFileSync(p, "roles:\n  - name: [\n   SUPER_SECRET_LINE\n");
    try {
      loadRoster(p, { repoRoot: dir });
      throw new Error("expected RosterError");
    } catch (e) {
      expect((e as RosterError).problems.join("\n")).not.toContain("SUPER_SECRET_LINE");
      expect((e as RosterError).message).not.toContain("SUPER_SECRET_LINE");
    }
  });

  test("an unreadable roster is coded `roster_unreadable`, a wrong one `roster_invalid`", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-code-"));
    try {
      loadRoster(join(dir, "gone.yaml"), { repoRoot: dir });
      throw new Error("expected RosterError");
    } catch (e) {
      expect((e as RosterError).code).toBe("roster_unreadable");
    }
    const p = join(dir, "bad.roster.yaml");
    writeFileSync(p, "roles:\n  - name: a\n    model: p/m\n    writes: []\n    bogus: 1\n");
    try {
      loadRoster(p, { repoRoot: dir });
      throw new Error("expected RosterError");
    } catch (e) {
      expect((e as RosterError).code).toBe("roster_invalid");
    }
  });

  test("a relative path resolves against the CWD, not the repo root", () => {
    // `--roster ./x.yaml` must mean the file the operator can see from where
    // they typed it, not a different one that happens to sit at the repo root.
    const root = mkdtempSync(join(tmpdir(), "roster-cwd-"));
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, "a.roster.yaml"), MINIMAL);
    writeFileSync(
      join(sub, "a.roster.yaml"),
      MINIMAL.replace("name: planner", "name: from-subdir"),
    );
    expect(loadRoster("a.roster.yaml", { repoRoot: root, cwd: sub }).roles[0]!.name).toBe(
      "from-subdir",
    );
    expect(loadRoster("a.roster.yaml", { repoRoot: root, cwd: root }).roles[0]!.name).toBe(
      "planner",
    );
  });

  test("confinement still applies to a CWD-relative path that escapes", () => {
    const outer = mkdtempSync(join(tmpdir(), "roster-cwd-esc-"));
    const root = join(outer, "repo");
    mkdirSync(root);
    writeFileSync(join(outer, "secret.yaml"), MINIMAL);
    expect(() => loadRoster("../secret.yaml", { repoRoot: root, cwd: root })).toThrow(
      /outside the repo root/,
    );
  });

  test("a directory passed as the roster is refused, not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-dir-"));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(() => loadRoster(sub, { repoRoot: dir })).toThrow(/not a regular file/);
  });

  test("a roster over the 256 KiB ceiling is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-big-"));
    const p = join(dir, "big.roster.yaml");
    writeFileSync(p, `# ${"x".repeat(ROSTER_MAX_BYTES)}\n${MINIMAL}`);
    expect(() => loadRoster(p, { repoRoot: dir })).toThrow(/256/);
  });

  test("a missing roster file raises RosterError, not a raw ENOENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-missing-"));
    expect(() => loadRoster(join(dir, "nope.yaml"), { repoRoot: dir })).toThrow(RosterError);
  });
});

describe("parseRoster — compaction block (self-compact rollout)", () => {
  test("a role without compaction resolves with compaction undefined", () => {
    const r = parseRoster(MINIMAL);
    expect(r.roles[0]!.compaction).toBeUndefined();
  });

  test("compaction 30/50/60 resolves verbatim into the role", () => {
    // The extension list is now REQUIRED alongside compaction (the --compact-*
    // flags only parse when the extension is loaded via -e), so this fixture
    // carries it explicitly.
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    harness_engineering: ["${SELF_COMPACT_EXTENSION}"]
    compaction:
      soft_at: "30%"
      at: "50%"
      buffer: "10%"
`;
    const r = parseRoster(src);
    expect(r.roles[0]!.compaction).toEqual({ soft_at: "30%", at: "50%", buffer: "10%" });
    expect(r.roles[0]!.harness_engineering).toEqual([SELF_COMPACT_EXTENSION]);
  });

  test("a non-percent compaction value is a schema problem naming the role", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    writes: []
    compaction:
      soft_at: "30%"
      at: "30000"
      buffer: "10%"
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      expect((e as RosterError).problems.join("\n")).toContain("30000");
    }
  });

  test("compaction without the self-compact extension in harness_engineering is an error", () => {
    // The roster-adapter maps compaction to `--compact-*` argv flags, which pi
    // only parses when the extension rides `-e`. Caught here, at parse, not at
    // spawn with an unknown-flag error.
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    writes: []
    compaction:
      soft_at: "30%"
      at: "50%"
      buffer: "10%"
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      const joined = (e as RosterError).problems.join("\n");
      expect(joined).toContain("roles[worker]");
      expect(joined).toContain(SELF_COMPACT_EXTENSION);
    }
  });

  test("defaults can supply the extension for a role-level compaction (post-merge check)", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
  harness_engineering: ["${SELF_COMPACT_EXTENSION}"]
roles:
  - name: worker
    model: m
    compaction:
      soft_at: "30%"
      at: "50%"
      buffer: "10%"
`;
    // No error and no warning: tools stays null, so nothing is filtered.
    const r = parseRoster(src);
    expect(r.roles[0]!.harness_engineering).toEqual([SELF_COMPACT_EXTENSION]);
    expect(r.roles[0]!.warnings).toEqual([]);
  });

  test("a compaction percent above the 90% upstream cap is rejected, value echoed", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    writes: []
    harness_engineering: ["${SELF_COMPACT_EXTENSION}"]
    compaction:
      soft_at: "30%"
      at: "95%"
      buffer: "10%"
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      const joined = (e as RosterError).problems.join("\n");
      expect(joined).toContain("≤ 90% (upstream cap)");
      expect(joined).toContain('"95%"');
    }
  });

  test("soft_at at or past at is rejected", () => {
    const src = y`
defaults:
  provider: openrouter
  writes: []
roles:
  - name: worker
    model: m
    writes: []
    harness_engineering: ["${SELF_COMPACT_EXTENSION}"]
    compaction:
      soft_at: "50%"
      at: "50%"
      buffer: "10%"
`;
    try {
      parseRoster(src);
      throw new Error("expected RosterError");
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      const joined = (e as RosterError).problems.join("\n");
      expect(joined).toContain("soft_at must be < at");
      expect(joined).toContain('"50%"');
    }
  });
});
