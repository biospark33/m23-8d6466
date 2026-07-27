/**
 * Unit tests for the gate's verifier child-process wrapper (issue #61).
 *
 * `runVerifier` is the stdout contract between the Phase-0 exit gate and the
 * per-story verifiers it REUSES rather than re-probing. If it mis-reports, the
 * gate mis-reports — so every test here targets one class of false green:
 *
 *   - a broken/absent verification reported as usable
 *   - a truncated or non-JSON stdout parsed into a verdict anyway
 *   - a non-array `results` certified as a results array
 *   - a non-zero exit whose code never reaches the failure detail
 *
 * The child is spawned for real (temp fixture scripts run under `bun`), because
 * the thing under test IS the spawn/parse boundary; stubbing it out would only
 * restate the implementation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  findCheck,
  runVerifier,
  verifierUnusable,
  type VerifierRun,
} from "../../src/gate/verifier-child.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-child-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** Writes a fixture verifier and runs it exactly the way the gate would. */
function fixture(name: string, body: string): string {
  const p = path.join(tmpRoot, `${name}.ts`);
  fs.writeFileSync(p, body);
  return p;
}

function run(name: string, body: string, timeoutMs = 20_000): Promise<VerifierRun> {
  return runVerifier(fixture(name, body), [], { cwd: tmpRoot, timeoutMs });
}

const VERDICT = `{"results":[{"ac":"AC1","name":"first","status":"pass"}],"summary":{"total":1}}`;

describe("runVerifier — the stdout contract", () => {
  test("valid JSON on stdout is parsed into a verdict", async () => {
    const r = await run("ok", `process.stdout.write(${JSON.stringify(VERDICT)});`);
    expect(r.exitCode).toBe(0);
    expect(r.parseError).toBeUndefined();
    expect(r.spawnError).toBeUndefined();
    expect(r.verdict?.results?.[0]?.ac).toBe("AC1");
    expect(verifierUnusable(r)).toBeUndefined();
  });

  test("argv is forwarded to the child", async () => {
    const p = fixture("argv", "process.stdout.write(JSON.stringify({results:[],argv:Bun.argv.slice(2)}));");
    const r = await runVerifier(p, ["--flag", "x"], { cwd: tmpRoot, timeoutMs: 20_000 });
    expect((r.verdict as { argv?: string[] }).argv).toEqual(["--flag", "x"]);
  });

  test("a non-zero exit is still a verdict, not a spawn failure", async () => {
    const r = await run("exit1", `process.stdout.write(${JSON.stringify(VERDICT)});process.exit(1);`);
    expect(r.exitCode).toBe(1);
    expect(r.spawnError).toBeUndefined();
    expect(r.verdict?.results).toHaveLength(1);
  });

  test("stderr is captured and tail-bounded", async () => {
    const r = await run(
      "noisy",
      `process.stderr.write("x".repeat(5000)+"\\nboom\\n");process.stdout.write(${JSON.stringify(VERDICT)});`,
    );
    expect(r.stderrTail.length).toBe(2000);
  });
});

describe("runVerifier — broken output never becomes a verdict", () => {
  const broken: Array<[string, string, string]> = [
    ["garbage", `process.stdout.write("not json at all");`, "garbage"],
    ["truncated", `process.stdout.write('{"results":[{"ac":"AC1"');`, "truncated JSON"],
    ["empty", `process.stdout.write("");`, "empty stdout"],
    ["null", `process.stdout.write("null");`, "a bare null"],
    ["number", `process.stdout.write("42");`, "a bare number"],
    [
      "prefixed",
      `process.stdout.write("[info] warming up\\n"+${JSON.stringify(VERDICT)});`,
      "a log line before the verdict",
    ],
  ];

  for (const [name, body, label] of broken) {
    test(`${label} yields no verdict and is reported unusable`, async () => {
      const r = await run(`broken-${name}`, body);
      expect(r.verdict?.results).toBeUndefined();
      const why = verifierUnusable(r);
      expect(why).toBeDefined();
      expect(why).toContain("verifier");
      // A broken verification must NEVER read as a pass.
      expect(findCheck(r, "AC1")).toBeUndefined();
    });
  }

  test("a top-level JSON array is not a results array", async () => {
    const r = await run("array", `process.stdout.write('[{"ac":"AC1","status":"pass"}]');`);
    expect(verifierUnusable(r)).toContain("no results array");
    expect(findCheck(r, "AC1")).toBeUndefined();
  });
});

describe("runVerifier — the exit code reaches the detail string", () => {
  test("exit 2 is called out as fatal-before-checks with the leading stderr line", async () => {
    const r = await run(
      "exit2",
      `process.stderr.write("pi-lens could not be resolved\\n    at foo (/x.ts:1:1)\\n");process.exit(2);`,
    );
    expect(r.exitCode).toBe(2);
    const why = verifierUnusable(r);
    expect(why).toContain("exited 2");
    expect(why).toContain("pi-lens could not be resolved");
    expect(why).not.toContain("    at foo");
  });

  test("any other non-zero exit with no verdict names its code", async () => {
    const r = await run("exit3", `process.stderr.write("died\\n");process.exit(3);`);
    expect(r.exitCode).toBe(3);
    expect(verifierUnusable(r)).toContain("exit 3");
  });

  test("a non-zero exit with a results-less verdict names its code too", async () => {
    const r = await run("exit4", `process.stdout.write('{"summary":{}}');process.exit(4);`);
    expect(verifierUnusable(r)).toContain("exit 4");
    expect(verifierUnusable(r)).toContain("no results array");
  });
});

describe("runVerifier — the child never comes back", () => {
  test("a hung verifier is killed and reported as unusable, not as a pass", async () => {
    const r = await run("hang", "await new Promise(() => {});", 700);
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeDefined();
    expect(verifierUnusable(r)).toContain("could not spawn verifier");
    expect(r.verdict).toBeUndefined();
  });

  test("a verifier that prints a partial verdict then hangs is unusable", async () => {
    const r = await run(
      "hang-partial",
      `process.stdout.write('{"results":[{"ac":"AC1","status":"pass"}');await new Promise(()=>{});`,
      700,
    );
    expect(r.spawnError).toBeDefined();
    expect(findCheck(r, "AC1")).toBeUndefined();
  });

  test("an unspawnable command is a spawn error, not a silent pass", async () => {
    const r = await runVerifier(path.join(tmpRoot, "does-not-exist.ts"), [], {
      cwd: tmpRoot,
      timeoutMs: 20_000,
    });
    expect(r.verdict).toBeUndefined();
    expect(verifierUnusable(r)).toBeDefined();
  });
});

describe("runVerifier — stdout larger than the buffer cap", () => {
  // 16 MB cap; emit past it. execFile KILLS the child on overflow, so without
  // an explicit branch this looked identical to a timeout — and the stdout it
  // hands back is a truncated prefix that must never be parsed.
  test(
    "an over-cap verdict is a hard fail naming the cap, not a timeout and not a truncated parse",
    async () => {
      const r = await run(
        "huge",
        `const pad = "x".repeat(1024*1024);
         process.stdout.write('{"results":[{"ac":"AC1","status":"pass","reason":"');
         for (let i = 0; i < 20; i++) process.stdout.write(pad);
         process.stdout.write('"}]}');`,
        60_000,
      );
      expect(r.verdict).toBeUndefined();
      expect(findCheck(r, "AC1")).toBeUndefined();
      const why = verifierUnusable(r);
      expect(why).toContain("exceeded");
      expect(why).toContain("cap");
      expect(why).not.toContain("budget");
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Pure helpers — the false-green surface, exercised without a child process.
// ---------------------------------------------------------------------------

const base = (verdict: unknown): VerifierRun =>
  ({ exitCode: 0, verdict, stdout: "", stderrTail: "" }) as VerifierRun;

describe("verifierUnusable / findCheck — type-lies in the verdict", () => {
  test("a usable verdict with an empty results array is usable but finds nothing", () => {
    const r = base({ results: [] });
    expect(verifierUnusable(r)).toBeUndefined();
    expect(findCheck(r, "AC1")).toBeUndefined();
  });

  // `results` is only ASSERTED to be an array by the type — JSON.parse will
  // happily hand back an object or a string.
  for (const bad of [{}, "ok", 7, true, { AC1: { status: "pass" } }]) {
    test(`results=${JSON.stringify(bad)} is unusable and does not throw`, () => {
      const r = base({ results: bad });
      expect(verifierUnusable(r)).toContain("no results array");
      expect(() => findCheck(r, "AC1")).not.toThrow();
      expect(findCheck(r, "AC1")).toBeUndefined();
    });
  }

  test("a null entry inside results does not crash the lookup", () => {
    const r = base({ results: [null, { ac: "AC1", name: "n", status: "pass" }] });
    expect(verifierUnusable(r)).toBeUndefined();
    expect(findCheck(r, "AC1")?.status).toBe("pass");
  });

  test("a duplicated ac resolves to the FIRST entry, so a later pass cannot shadow it", () => {
    const r = base({
      results: [
        { ac: "AC1", name: "n", status: "fail", reason: "the real result" },
        { ac: "AC1", name: "n", status: "pass" },
      ],
    });
    expect(findCheck(r, "AC1")?.status).toBe("fail");
  });

  test("findCheck matches on `ac`, not on `name`", () => {
    const r = base({ results: [{ ac: "AC1", name: "AC2", status: "pass" }] });
    expect(findCheck(r, "AC2")).toBeUndefined();
    expect(findCheck(r, "AC1")).toBeDefined();
  });

  test("a spawn error outranks a present verdict", () => {
    const r: VerifierRun = {
      exitCode: null,
      verdict: { results: [{ ac: "AC1", name: "n", status: "pass" }] },
      stdout: "",
      stderrTail: "",
      spawnError: "ENOENT",
    };
    expect(verifierUnusable(r)).toContain("could not spawn verifier");
  });

  test("exit 2 outranks a fully green verdict — no checks actually ran", () => {
    const r: VerifierRun = {
      exitCode: 2,
      verdict: { results: [{ ac: "AC1", name: "n", status: "pass" }] },
      stdout: "",
      stderrTail: "fatal: nothing ran",
      spawnError: undefined,
    };
    expect(verifierUnusable(r)).toContain("exited 2");
  });

  test("stderr of only stack frames still yields a non-empty detail", () => {
    const r: VerifierRun = { exitCode: 2, stdout: "", stderrTail: "    at a (x)\n    at b (y)" };
    expect(verifierUnusable(r)).toContain("at a (x)");
  });

  test("an empty stderr on exit 2 says so rather than reading as blank", () => {
    const r: VerifierRun = { exitCode: 2, stdout: "", stderrTail: "" };
    expect(verifierUnusable(r)).toContain("no stderr");
  });
});
