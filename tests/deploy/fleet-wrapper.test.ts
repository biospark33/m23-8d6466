/**
 * fleet-wrapper.sh contract tests (Z4 / DF5.5 Amendment D).
 *
 * deploy/vps/fleet-wrapper.sh is what $SWARMCLAW_FACTORY_FLEET_CLI points at
 * on the VPS: the swarmclaw fork execs it (shell: false, stdin-piped, child
 * env limited to PATH/HOME/TMPDIR/LANG) with [<verb>, ...flags]. AC4: the
 * wrapper appends `--driver exedev` to exactly the ten driver-required verbs
 * from src/fleet/verbs.ts listVerbs(), and passes the other six through
 * byte-untouched — the fork never learns QDS's driver grammar.
 *
 * Technique: a `bun` SHIM on PATH records the exact argv the wrapper would
 * hand to the real CLI; every shim run uses a FOREIGN cwd (proving the
 * checkout resolves from the wrapper's own script location, never cwd) under
 * the fork's exact env allowlist (proving it depends on no other env). One
 * TRUE end-to-end (`result <unknown-id>` → exit 4) proves the bun →
 * scripts/fleet.ts chain actually executes and exit codes propagate. No
 * driver-required verb ever reaches a real driver here — no network, no spend.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listVerbs } from "../../src/fleet/verbs.ts";
import { run } from "../../scripts/fleet.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";

const repoRoot = realpathSync(join(import.meta.dir, "..", ".."));
const wrapperPath = join(repoRoot, "deploy", "vps", "fleet-wrapper.sh");
const fleetTs = join(repoRoot, "scripts", "fleet.ts");
const wrapperSource = readFileSync(wrapperPath, "utf8");

// The registry is the oracle — the verb sets are DERIVED, never hardcoded here
// (hardcoded counts only, as sanity assertions).
const entries = listVerbs();
const hasDriverFlag = (e: (typeof entries)[number]) => e.flags.some((f) => f.name === "--driver");
const driverVerbs = entries.filter(hasDriverFlag).map((e) => e.verb);
const noDriverVerbs = entries.filter((e) => !hasDriverFlag(e)).map((e) => e.verb);

// ── fixtures: bun shim + foreign cwd ────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "z4-fleet-wrapper-"));
const shimDir = join(tmp, "shim");
const foreignDir = join(tmp, "foreign-cwd");
mkdirSync(shimDir);
mkdirSync(foreignDir);

// Shim `bun`: writes the argv it received to argv.txt in ITS cwd, one arg per
// line — shell-internal $PWD, so no env beyond the allowlist is needed — and
// copies its stdin to stdin.txt so the wrapper's passthrough is observable.
// `read` is a builtin (nothing else resolves on the shim-only PATH). The
// post-loop flush catches an UNTERMINATED final line (read returns failure
// but still assigns it); the flush re-adds the newline, so stdin is
// byte-identical for newline-terminated input — the fork's real payload
// shape — and normalized to a trailing newline for unterminated input.
const shimPath = join(shimDir, "bun");
writeFileSync(
  shimPath,
  "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\n: > \"$PWD/stdin.txt\"\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> \"$PWD/stdin.txt\"; done\nif [ -n \"$line\" ]; then printf '%s\\n' \"$line\" >> \"$PWD/stdin.txt\"; fi\n",
);
chmodSync(shimPath, 0o755);

// Exactly the fork's ALLOWED_ENV_KEYS (protocol-factory-exec.ts).
const forkEnv = { PATH: shimDir, HOME: tmp, TMPDIR: tmp, LANG: "C" };

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Run a wrapper script in the fork's exec shape; return its exit code and stderr. */
async function runWrapper(wrapper: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([wrapper, ...args], {
    cwd: foreignDir,
    env: forkEnv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

/** The argv the shim captured, as the wrapper handed it to `bun`. */
function shimArgv(): string[] {
  return readFileSync(join(foreignDir, "argv.txt"), "utf8").split("\n");
}

const PASSTHROUGH_ARGS = ["--dir", "fixtures/runs", "run-z4"];

describe("fleet-wrapper (Z4, DF5.5 Amendment D)", () => {
  it("registry sanity: 16 verbs, 10 with a required --driver, 6 without, disjoint", () => {
    expect(entries).toHaveLength(16);
    expect(driverVerbs).toHaveLength(10);
    expect(noDriverVerbs).toHaveLength(6);
    expect(new Set([...driverVerbs, ...noDriverVerbs]).size).toBe(16);
  });

  it("wrapper is executable — the fork execs it directly, no `sh` prefix", () => {
    expect((statSync(wrapperPath).mode & 0o111) !== 0).toBe(true);
  });

  it("the fixed verb table in the script matches listVerbs() exactly (CI drift alarm)", () => {
    const driverLine = wrapperSource.match(/^driver_verbs='(.*)'$/m)?.[1];
    const noDriverLine = wrapperSource.match(/^no_driver_verbs='(.*)'$/m)?.[1];
    expect(driverLine).toBeDefined();
    expect(noDriverLine).toBeDefined();
    expect(driverLine!.split(" ").sort()).toEqual([...driverVerbs].sort());
    expect(noDriverLine!.split(" ").sort()).toEqual([...noDriverVerbs].sort());
  });

  for (const verb of driverVerbs) {
    it(`appends exactly "--driver exedev" to driver-required verb "${verb}"`, async () => {
      const { code, stderr } = await runWrapper(wrapperPath, [verb, ...PASSTHROUGH_ARGS]);
      expect(code).toBe(0);
      // The exact argv the fork's execFile would deliver to the real CLI
      // (trailing "" is the shim's per-line format, not an argv element).
      expect(shimArgv()).toEqual([fleetTs, verb, ...PASSTHROUGH_ARGS, "--driver", "exedev", ""]);
      // Observability contract: ONE provenance line, to stderr only.
      expect(stderr).toBe(`verb=${verb} driver_injected=true\n`);
    });
  }

  for (const verb of noDriverVerbs) {
    it(`passes no-driver verb "${verb}" through byte-untouched`, async () => {
      const { code, stderr } = await runWrapper(wrapperPath, [verb, ...PASSTHROUGH_ARGS]);
      expect(code).toBe(0);
      expect(shimArgv()).toEqual([fleetTs, verb, ...PASSTHROUGH_ARGS, ""]);
      expect(stderr).toBe(`verb=${verb} driver_injected=false\n`);
    });
  }

  it("AC4 negative control: an unconditional-append wrapper would hand approve an unknown flag", async () => {
    // The bug shape AC4 forbids, built as an in-test fixture: append
    // --driver unconditionally. On `approve` — a verb whose registry flags
    // contain NO --driver — that argv is an unknown flag, which the CLI
    // usage-refuses with exit 2.
    const badPath = join(tmp, "unconditional-append-wrapper.sh");
    writeFileSync(badPath, `#!/bin/sh\nexec bun '${fleetTs}' "$@" --driver exedev\n`);
    chmodSync(badPath, 0o755);

    const bad = await runWrapper(badPath, ["approve", ...PASSTHROUGH_ARGS]);
    expect(bad.code).toBe(0); // the shim accepts anything; the bad shape is in the argv below
    expect(shimArgv()).toContain("--driver");
    expect(shimArgv()).toContain("exedev");

    const real = await runWrapper(wrapperPath, ["approve", ...PASSTHROUGH_ARGS]);
    expect(real.code).toBe(0);
    // The real wrapper refuses this shape by construction: no --driver ever
    // rides along on a no-driver verb.
    expect(shimArgv()).not.toContain("--driver");
    expect(shimArgv()).not.toContain("exedev");
    expect(real.stderr).toBe("verb=approve driver_injected=false\n");

    // Ground the "would exit 2" claim in the registry itself.
    const approveEntry = entries.find((e) => e.verb === "approve");
    expect(approveEntry?.flags.some((f) => f.name === "--driver")).toBe(false);
  });

  it("unknown verb exits 2 (fleet's usage code) and still logs one provenance line", async () => {
    const { code, stderr } = await runWrapper(wrapperPath, ["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("verb=frobnicate driver_injected=false\n");
  });

  it("missing verb exits 2", async () => {
    const { code, stderr } = await runWrapper(wrapperPath, []);
    expect(code).toBe(2);
    expect(stderr).toContain("verb= driver_injected=false\n");
  });

  it("verb containing a newline is refused exit 2 BEFORE the provenance line (exactly one stderr line guard)", async () => {
    // A newline in $verb would split `verb=<v> driver_injected=<bool>` across
    // several stderr lines; the wrapper refuses such a verb before printing
    // provenance, so this exact-equality also proves no provenance line ran.
    const { code, stderr } = await runWrapper(wrapperPath, ["sta\ntus"]);
    expect(code).toBe(2);
    expect(stderr).toBe("fleet-wrapper: verb must not contain a newline\n");
  });

  it("bun missing from PATH exits 127 with a bun diagnostic (the fork's broken-install shape)", async () => {
    // Fork env allowlist intact, but PATH points at an EMPTY dir — no bun
    // anywhere. The wrapper must diagnose before exec, not die with bun's
    // own silent "command not found".
    const emptyPath = join(tmp, "empty-path");
    mkdirSync(emptyPath);
    const proc = Bun.spawn([wrapperPath, "status"], {
      cwd: foreignDir,
      env: { ...forkEnv, PATH: emptyPath },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(127);
    expect(stderr).toMatch(/bun/);
  });

  it("reads no environment beyond the implicit PATH probe exec requires — no QDS_* fallback, no env knob selects the driver", () => {
    // Two env-touch classes are deliberately distinct: CONFIG-env reads (any
    // ${VAR} expansion or named variable reference) are forbidden — the regex
    // below enforces zero of them; the `command -v bun` PATH probe is NOT a
    // config read — it is the minimum resolution work exec itself requires.
    // Positional/expansion params are $0..$9 and $@ — digits and '@', never an
    // uppercase NAME, so ANY match here would be an env read.
    expect(wrapperSource.match(/\$\{?[A-Z_][A-Z0-9_]*\}?/g) ?? []).toEqual([]);
    expect(wrapperSource).not.toContain("QDS_");
    // The flag is not a config surface: exactly ONE non-comment occurrence —
    // the append itself.
    const code = wrapperSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code.split("--driver exedev").length - 1).toBe(1);
    // Provenance must name its owner (story Z4 / DF5.5 Amendment D).
    expect(wrapperSource).toContain("Z4");
    expect(wrapperSource).toContain("DF5.5");
  });

  it("wrapper parses as POSIX shell (sh -n)", () => {
    expect(Bun.spawnSync(["sh", "-n", wrapperPath]).exitCode).toBe(0);
  });

  it("end-to-end through the real CLI: `result <unknown-id>` propagates exit 4", async () => {
    // `result` is poller-safe by registry contract (no box probes, no driver,
    // no spend). Normal env, repo root — the production invocation shape.
    const proc = Bun.spawn([wrapperPath, "result", "z4-wrapper-e2e-no-such-run"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(4); // no such run record — the CLI's code, through the wrapper
    // stdout stays the verb's JSON contract: the provenance line never touches it.
    expect(stdout).toBe("");
  });

  it("piped stdin reaches the child byte-identically (the approve token path)", async () => {
    // The fork pipes the approver token on stdin for approve; a wrapper that
    // consumed or buffered stdin would drop it. Spawned under the fork's exact
    // env allowlist, foreign cwd — the production shape plus a piped fd 0.
    const token = "ghp_z4-wrapper-stdin-token\n";
    const proc = Bun.spawn([wrapperPath, "approve", ...PASSTHROUGH_ARGS], {
      cwd: foreignDir,
      env: forkEnv,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.stdin.write(token);
    proc.stdin.end();
    await proc.exited;
    expect(readFileSync(join(foreignDir, "stdin.txt"), "utf8")).toBe(token);
  });

  it("piped stdin: an UNTERMINATED final line survives the shim (byte-identical modulo the shim's added trailing newline)", async () => {
    // Same production shape as above minus the trailing newline. `read`
    // returns failure on EOF-without-newline but still assigns the partial
    // line, so the loop drops it unless the shim flushes it afterwards — the
    // flush does, and its printf re-adds the newline the payload lacked.
    // That one-byte normalization is the shim's, asserted honestly here.
    const token = "ghp_z4-wrapper-stdin-unterminated";
    const proc = Bun.spawn([wrapperPath, "approve", ...PASSTHROUGH_ARGS], {
      cwd: foreignDir,
      env: forkEnv,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.stdin.write(token);
    proc.stdin.end();
    await proc.exited;
    expect(readFileSync(join(foreignDir, "stdin.txt"), "utf8")).toBe(`${token}\n`);
  });
});

/**
 * The DoD's mandatory real-CLI acceptance leg (round-1 F-009): the shim above
 * proves argv SHAPE; only scripts/fleet.ts's exported run() proves the CLI
 * ACCEPTS the wrapper's argv. These tests call run() with exactly the argv the
 * wrapper hands `bun` for each verb class, with deps INJECTED (FakeDriver +
 * read-mode store) — never the real exedev driver, zero network, zero spend.
 */
describe("fleet-wrapper argv accepted by the real CLI (run() + injected FakeDriver)", () => {
  const e2eDir = mkdtempSync(join(tmpdir(), "z4-wrapper-e2e-"));
  const boxesDir = join(e2eDir, "boxes");
  const runsDir = join(e2eDir, "runs");
  // The read-mode store asserts the directory EXISTS (it never creates one).
  mkdirSync(runsDir);
  const e2eDeps = {
    driver: new FakeDriver(boxesDir),
    store: new RunRecordStore({ dir: runsDir, create: false }),
  };
  const outSink = (): void => {};

  afterAll(() => rmSync(e2eDir, { recursive: true, force: true }));

  it(`accepts a driver verb with the wrapper-appended argv ("status", "--driver", "exedev")`, async () => {
    // Exactly the argv the wrapper appends for a driver-required verb — the
    // flag spelling and trailing position are the acceptance under test, so
    // they are passed verbatim rather than satisfied by deps alone.
    // deps.driver short-circuits driver resolution, so "exedev" never names a
    // real substrate.
    const code = await run(["status", "--driver", "exedev"], outSink, e2eDeps);
    expect(code).toBe(0); // empty fleet is a state, not an error
  });

  it(`accepts the byte-untouched passthrough for "approve" (refusal is post-parse)`, async () => {
    // approve's full happy path needs an existing record, an allowlist entry
    // and a stdin token, so the honest acceptance claim here is: the
    // passthrough argv parses clean — the usage refusal is about the MISSING
    // --approver, never about an unknown flag and never about a missing
    // --driver (approve takes none by registry).
    const errs: string[] = [];
    const code = await run(["approve", "qds-20990101-000000"], outSink, e2eDeps, (s) => errs.push(s));
    expect(code).toBe(2);
    expect(errs.join("")).toContain("requires --approver");
    expect(errs.join("")).not.toContain("unknown flag");
  });

  it(`refuses the unconditional-append shape on "approve" with exit 2 ("approve does not take --driver")`, async () => {
    // The AC4 negative control, EXECUTED against the real CLI rather than
    // grounded in registry metadata: the argv the buggy unconditional-append
    // wrapper would hand `bun` for a no-driver verb is refused by the
    // parser — same verb, same positionals as the accepted passthrough above,
    // only the appended flag differs, and the refusal switches from the
    // approver usage error to the flag refusal (exit 2, usage envelope).
    const errs: string[] = [];
    const code = await run(["approve", "qds-20990101-000000", "--driver", "exedev"], outSink, e2eDeps, (s) =>
      errs.push(s),
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("does not take --driver");
    expect(errs.join("")).not.toContain("requires --approver");
  });

  it(`refuses --driver on "result" with exit 2 before the record read (not a record-not-found 4)`, async () => {
    // The second leg of the AC4 negative: `result` also takes no --driver,
    // and the same unconditional-append argv must die at PARSE time. The
    // injected store holds NO record for this id, so a 4 here would prove
    // the record read ran first — 2 is the parse-order proof.
    const errs: string[] = [];
    const code = await run(["result", "qds-20990101-000000", "--driver", "exedev"], outSink, e2eDeps, (s) =>
      errs.push(s),
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("does not take --driver");
  });
});
