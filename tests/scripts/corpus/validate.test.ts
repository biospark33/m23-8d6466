/**
 * JEV-1 — `scripts/corpus/validate.ts`.
 *
 * The sidecar gate: a skill-shaped `triage.json` exits 0; malformed JSON, a
 * missing required field, a disposition outside the enum, or an unknown key
 * exits 2 naming the exact field/zod path (AC3).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, validateSidecarText } from "../../../scripts/corpus/validate.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "sidecar", "triage.json");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

describe("parseArgs", () => {
  test("takes the sidecar path positionally and rejects flags", () => {
    expect(parseArgs([FIXTURE])).toEqual({ path: FIXTURE });
    expect(() => parseArgs([])).toThrow(/sidecar path/i);
    expect(() => parseArgs(["--out", "x"])).toThrow(/unknown flag/);
  });
});

describe("validateSidecarText", () => {
  test("accepts the skill-shaped fixture", async () => {
    expect(validateSidecarText(await Bun.file(FIXTURE).text()).ok).toBe(true);
  });

  test("malformed JSON names the parse failure, not a stack", () => {
    const r = validateSidecarText("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/JSON/i);
  });

  test("missing required field names the zod path", () => {
    const r = validateSidecarText(
      JSON.stringify({ pr: 1, round: 1, findings: [{ finding_id: "F", diff_context_ref: "a", label: "L", disposition: "PATCH" }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("findings.0.finding_text"))).toBe(true);
  });

  test("disposition outside the enum names the field", () => {
    const r = validateSidecarText(
      JSON.stringify({
        pr: 1,
        round: 1,
        findings: [{ finding_id: "F", finding_text: "t", diff_context_ref: "a", label: "L", disposition: "MAYBE" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("disposition"))).toBe(true);
  });

  test("unknown key rejected (strict) and named", () => {
    const r = validateSidecarText(
      JSON.stringify({
        pr: 1,
        round: 1,
        secret_material: "TYPESAFE_API_KEY",
        findings: [{ finding_id: "F", finding_text: "t", diff_context_ref: "a", label: "L", disposition: "PATCH" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("secret_material"))).toBe(true);
  });

  test("created_at must be ISO-8601 when present", () => {
    const finding = { finding_id: "F", finding_text: "t", diff_context_ref: "a", label: "L", disposition: "PATCH" };
    expect(validateSidecarText(JSON.stringify({ pr: 1, round: 1, findings: [{ ...finding, created_at: "yesterday" }] })).ok).toBe(false);
    expect(validateSidecarText(JSON.stringify({ pr: 1, round: 1, findings: [{ ...finding, created_at: "2026-09-22T14:03:00Z" }] })).ok).toBe(true);
  });
});

describe("main — through the real CLI boundary", () => {
  const SCRIPT = join(REPO_ROOT, "scripts", "corpus", "validate.ts");

  function run(args: string[]): { exitCode: number; stderr: string } {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stderr: r.stderr.toString() };
  }

  test("valid sidecar exits 0", () => {
    expect(run([FIXTURE]).exitCode).toBe(0);
  });

  test("invalid sidecar exits 2 naming the field, no stack dump", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-validate-"));
    try {
      const bad = join(dir, "triage.json");
      writeFileSync(bad, '{"pr":1,"round":1,"findings":[{"finding_id":"F"}]}');
      const r = run([bad]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("findings.0.finding_text");
      expect(r.stderr).not.toContain("at ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable path exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-validate-"));
    try {
      expect(run([join(dir, "missing-triage.json")]).exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("resolves 0 on the valid fixture — pinned in-process, because a child process's execution is invisible to the coverage run", async () => {
    // The child-process cases in the `main()` describe below exercise the
    // exitWithFailure arms for real, but coverage instruments only the run's
    // OWN process — a child that exits 2 scores as `main` never called. The
    // success path returns instead of exiting, so it is callable here, and
    // pinning it keeps the gate's per-file floor measuring the CLI assembly
    // rather than a hole shaped like one.
    expect(await main([FIXTURE])).toBe(0);
  });
});
