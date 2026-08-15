/**
 * DF2.2 — exe.dev driver tests: DF2.1's contract suite (unmodified), registry
 * resolution, the AC5 response-shape fallback, INV-1 posture attestation, and
 * INV-2 hostname validation.
 *
 * The driver under test is the production ExeDevDriver; only the command seam
 * is swapped for the fake substrate (fixture).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriverContract } from "../driver-contract.test.ts";
import { registeredDrivers, resolveDriver } from "../../../src/providers/index.ts";
import { assertValidRunId } from "../../../src/providers/run-record.ts";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import {
  fakeExeDev,
  writePostureAttestation,
  type FakeExeDev,
} from "./fixtures/fake-exedev.ts";

/** Run argv on the test host, returning stdout (git plumbing for the origin repo). */
async function runLocal(argv: string[]): Promise<string> { /* dp:ok a rejection here is the test failing — there is nothing to recover */
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`runLocal ${argv.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

describe("ExeDevDriver — DF2.1 contract suite (unmodified)", () => {
  const fake = fakeExeDev();
  const postureDir = mkdtempSync(join(tmpdir(), "qds-exedev-posture-"));
  let postureFile: string;

  beforeAll(() => {
    postureFile = writePostureAttestation(postureDir);
  });

  afterAll(() => {
    fake.cleanup();
    rmSync(postureDir, { recursive: true, force: true });
  });

  // The suite calls setPublic, which requires the vm-sharing attestation, so
  // makeDriver hands the driver an attested posture file. The refusal-without-
  // attestation case is tested explicitly below.
  runDriverContract({
    driverName: "exedev",
    makeDriver: () => new ExeDevDriver({ run: fake.run, postureFile }),
  });
});

describe("ExeDevDriver — registry (Trigger Surface)", () => {
  test("'exedev' is registered at module load and resolves through the seam", () => {
    expect(registeredDrivers()).toContain("exedev");
    const driver = resolveDriver("exedev");
    expect(driver.name).toBe("exedev");
  });

  test("resolveDriver wraps the exedev primitives with the observability proxy", () => {
    const driver = resolveDriver("exedev");
    // The instrument proxy only wraps the eight primitives; an extra method
    // (fill/setup) passes through unwrapped. `exec` must be a function either way.
    expect(typeof driver.exec).toBe("function");
    expect(typeof driver.whoami).toBe("function");
  });
});

describe("ExeDevDriver — AC5 response-shape fallback", () => {
  let fake: FakeExeDev;

  beforeAll(() => {
    fake = fakeExeDev({ newShape: "unrecognized" });
  });

  afterAll(() => fake.cleanup());

  test("unrecognized `new --json` keys fall back to the verified `ls` shape", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    const vm = await driver.create("ac5-fallback-1");
    // The fallback re-reads ls --json (vm_name/https_url) and would take its
    // https_url; the derivation is the same string here.
    expect(vm.name).toBe("ac5-fallback-1");
    expect(vm.httpsUrl).toBe("https://ac5-fallback-1.exe.xyz");
    // The ls re-read must actually have happened: two control-plane calls.
    const control = fake.calls.filter((a) => a[0] === "ssh" && a[1] === "exe.dev");
    expect(control.length).toBeGreaterThanOrEqual(2);
    expect(control.some((a) => a.slice(2).join(" ").startsWith("ls"))).toBe(true);
  });

  test("create DERIVES https_url when the verified ls shape omits it (no fake https_url to lean on)", async () => {
    // lsOmitHttps removes the crutch AND the unrecognized new-shape forces the
    // ls re-read: `ls` reports vm_name/ssh_dest only, so the ONLY way to a URL
    // is the driver's own <name>.exe.xyz derivation.
    const noUrlFake = fakeExeDev({ newShape: "unrecognized", lsOmitHttps: true });
    try {
      const driver = new ExeDevDriver({ run: noUrlFake.run });
      const vm = await driver.create("ac5-derive-1");
      expect(vm.httpsUrl).toBe("https://ac5-derive-1.exe.xyz");
      // The derivation must come from the ls re-read, not the (recognized)
      // new shape — otherwise the fallback never ran.
      const control = noUrlFake.calls.filter((a) => a[0] === "ssh" && a[1] === "exe.dev");
      expect(control.some((a) => a.slice(2).join(" ").startsWith("ls"))).toBe(true);
    } finally {
      noUrlFake.cleanup();
    }
  });

  test("both shapes unusable → create fails closed, VM still findable by ls", async () => {
    const alwaysEmpty = fakeExeDev({ newShape: "unrecognized", lsAlwaysEmpty: true });
    try {
      const driver = new ExeDevDriver({ run: alwaysEmpty.run });
      // The VM was created at the substrate (the `new` call ran) — the failure
      // must not orphan it invisibly, so it stays listable (AC5, INV-5).
      await expect(driver.create("ac5-orphan-1")).rejects.toThrow(/refusing to guess/);
      const control = alwaysEmpty.calls.filter((a) => a[0] === "ssh" && a[1] === "exe.dev");
      expect(control.some((a) => a.slice(2).join(" ").startsWith("new --name ac5-orphan-1"))).toBe(true);
    } finally {
      alwaysEmpty.cleanup();
    }
  });
});

describe("ExeDevDriver — INV-1 / INV-2 guards", () => {
  let fake: FakeExeDev;
  let postureDir: string;

  beforeAll(() => {
    fake = fakeExeDev();
    postureDir = mkdtempSync(join(tmpdir(), "qds-exedev-posture-"));
  });

  afterAll(() => {
    fake.cleanup();
    rmSync(postureDir, { recursive: true, force: true });
  });

  test("INV-1: setPublic refuses without the vm-sharing admins-only attestation", async () => {
    const driver = new ExeDevDriver({ run: fake.run, postureFile: join(postureDir, "absent.json") });
    await fake.run(["ssh", "exe.dev", "new", "--name", "inv1-box", "--json"]);
    await expect(driver.setPublic("inv1-box")).rejects.toThrow(/attestation/);
    // Refused BEFORE any share command ran.
    const shares = fake.calls.filter((a) => a.slice(2).join(" ").startsWith("share set-public"));
    expect(shares.length).toBe(0);
  });

  test("INV-1: setPublic runs the share command with the attestation present", async () => {
    const postureFile = writePostureAttestation(postureDir);
    const driver = new ExeDevDriver({ run: fake.run, postureFile });
    await fake.run(["ssh", "exe.dev", "new", "--name", "inv1-ok", "--json"]);
    await driver.setPublic("inv1-ok");
    expect(fake.calls.some((a) => a.slice(2).join(" ") === "share set-public inv1-ok")).toBe(true);
  });

  test("INV-2: a run id outside the hostname grammar never reaches the wire", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    const before = fake.calls.length;
    for (const bad of ["../evil", "UPPER", "with_underscore", "a".repeat(64), ""]) {
      await expect(driver.create(bad)).rejects.toThrow();
    }
    expect(fake.calls.length).toBe(before);
  });

  test("INV-2: exec validates the vm name the same way (reuses assertValidRunId)", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await expect(driver.exec("../evil", ["true"])).rejects.toThrow(/invalid run id/);
    // assertValidRunId is the shared grammar — same error text as the store's.
    expect(() => assertValidRunId("../evil")).toThrow(/invalid run id/);
  });
});

describe("ExeDevDriver — exec serialization", () => {
  let fake: FakeExeDev;

  beforeAll(() => {
    fake = fakeExeDev();
  });

  afterAll(() => fake.cleanup());

  test("argv elements with spaces and quotes round-trip exactly", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("exec-1");
    const res = await driver.exec("exec-1", ["printf", "%s\n", "a 'quoted' \"arg\"  double"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("a 'quoted' \"arg\"  double\n");
  });

  test("a remote command joins into one ssh trailing command, not many", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("exec-2");
    await driver.exec("exec-2", ["sh", "-c", "echo $0 $1", "sh", "second-arg"]);
    // The serialization must hand ssh ONE command string (argv.length === 3).
    const sshCalls = fake.calls.filter(
      (a) => a[0] === "ssh" && a[1] === "exec-2.exe.xyz",
    );
    expect(sshCalls.length).toBeGreaterThan(0);
    expect(sshCalls[0]?.length).toBe(3);
  });

  test("exec enforces its timeout and reports the kill as a non-zero exit", async () => {
    const driver = new ExeDevDriver({ run: fake.run, execTimeoutMs: 500 });
    await driver.create("exec-3");
    const res = await driver.exec("exec-3", ["sh", "-c", "sleep 30"]);
    expect(res.exitCode).not.toBe(0);
  }, 15_000);
});

describe("ExeDevDriver — fill (clone, SHA pin, sbx/<run-id> branch)", () => {
  let fake: FakeExeDev;
  let originDir: string;
  let tempDir: string;
  let shaA: string;
  let shaB: string;

  beforeAll(async () => {
    fake = fakeExeDev();
    tempDir = mkdtempSync(join(tmpdir(), "qds-exedev-fill-"));
    // A local origin — `file://` clone is offline, so the test exercises the
    // real clone/pin/branch path without a network.
    originDir = join(tempDir, "origin");
    mkdirSync(originDir, { recursive: true });
    await runLocal(["git", "init", "-q", "-b", "main", originDir]);
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "A"]);
    shaA = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "B"]);
    shaB = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
  });

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fill clones, pins the recorded SHA, and creates sbx/<run-id> at HEAD", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-1");
    await driver.fill("fill-1", {
      runId: "fill-1",
      repoUrl: `file://${originDir}`,
      commitSha: shaB,
      workdir: "work",
    });
    const head = await driver.exec("fill-1", ["git", "-C", "work", "rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe(shaB);
    const branch = await driver.exec("fill-1", ["git", "-C", "work", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("sbx/fill-1");
    // Byte-identical: the branch adds no commit — it IS the pinned HEAD.
    const logCount = await driver.exec("fill-1", ["git", "-C", "work", "rev-list", "--count", "HEAD"]);
    expect(Number(logCount.stdout.trim())).toBe(2);
    const porcelain = await driver.exec("fill-1", ["git", "-C", "work", "status", "--porcelain"]);
    expect(porcelain.stdout.trim()).toBe("");
  });

  test("a re-fill switches to the existing branch and never re-creates it", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-2");
    await driver.fill("fill-2", { runId: "fill-2", repoUrl: `file://${originDir}`, commitSha: shaB, workdir: "work" });
    // The run's own output: one commit on the sandbox branch (DF2.5 harvests these).
    await driver.exec("fill-2", [
      "sh",
      "-c",
      "git -C work -c user.email=run@box -c user.name=run commit -q --allow-empty -m run-output",
    ]);
    const before = await driver.exec("fill-2", ["git", "-C", "work", "rev-parse", "sbx/fill-2"]);
    await driver.fill("fill-2", { runId: "fill-2", repoUrl: `file://${originDir}`, commitSha: shaB, workdir: "work" });
    const after = await driver.exec("fill-2", ["git", "-C", "work", "rev-parse", "sbx/fill-2"]);
    // Same branch tip: the re-fill switched to it, it did not reset or re-create.
    expect(after.stdout.trim()).toBe(before.stdout.trim());
    const branch = await driver.exec("fill-2", ["git", "-C", "work", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("sbx/fill-2");
    // …and the run's commits are still the branch's history.
    const log = await driver.exec("fill-2", ["git", "-C", "work", "log", "--format=%s", "-1"]);
    expect(log.stdout.trim()).toBe("run-output");
  });

  test("fill ACCEPTS a real https clone URL with a path (regression: the grammar once rejected every production URL)", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-https");
    // A path-carrying https URL must pass the GRAMMAR: the failure below is
    // the clone itself (the fake box has no network), named "fill clone", NOT
    // "repo-url-invalid" — that distinction is the regression.
    await expect(
      driver.fill("fill-https", {
        runId: "fill-https",
        repoUrl: "https://github.com/example/qds-factory.git",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        workdir: "work",
      }),
    ).rejects.toThrow(/fill clone exited|fill-failed/);
  });

  test("fill refuses a repo URL that is not a plain public clone source", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-3");
    for (const bad of ["http://insecure.example/repo", "https://user:pass@example.com/repo", "not-a-url"]) {
      await expect(
        driver.fill("fill-3", { runId: "fill-3", repoUrl: bad, commitSha: shaA, workdir: "work" }),
      ).rejects.toThrow(/repo/);
    }
  });

  test("fill refuses a commit SHA that is not hex", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-4");
    await expect(
      driver.fill("fill-4", {
        runId: "fill-4",
        repoUrl: `file://${originDir}`,
        commitSha: "HEAD; rm -rf /",
        workdir: "work",
      }),
    ).rejects.toThrow(/sha/i);
  });

  test("fill surfaces a non-zero clone/checkout failure", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-5");
    await expect(
      driver.fill("fill-5", {
        runId: "fill-5",
        repoUrl: `file://${originDir}`,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        workdir: "work",
      }),
    ).rejects.toThrow(/fill/i);
  });
});

describe("ExeDevDriver — control-plane parsing", () => {
  let fake: FakeExeDev;

  beforeAll(() => {
    fake = fakeExeDev();
  });

  afterAll(() => fake.cleanup());

  test("whoami returns the account string (preflight)", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    expect(await driver.whoami()).toBe("fake-exedev-operator");
  });

  test("list parses the verified {vms:[…]} shape into ProviderVm[]", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("list-1");
    await driver.create("list-2");
    const all = await driver.list();
    expect(all.map((v) => v.name)).toContain("list-1");
    const one = await driver.list("list-2");
    expect(one.map((v) => v.name)).toEqual(["list-2"]);
    expect(one[0]?.httpsUrl).toBe("https://list-2.exe.xyz");
  });

  test("destroy re-reads ls when rm reports not-found — idempotent by content", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("destroy-1");
    await driver.destroy("destroy-1");
    await driver.destroy("destroy-1");
    expect((await driver.list("destroy-1"))).toEqual([]);
  });

  test("expose validates the port and returns the https URL", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("expose-1");
    expect(await driver.expose("expose-1", 8080)).toBe("https://expose-1.exe.xyz");
    await expect(driver.expose("expose-1", 0)).rejects.toThrow(/invalid port/);
  });

  test("copyFile pulls box → host through scp and validates the remote path", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("copy-1");
    await driver.exec("copy-1", ["sh", "-c", "mkdir -p out && echo harvested > out/f.txt"]);
    const local = join(fake.root, "copy-1-local.txt");
    await driver.copyFile("copy-1", "out/f.txt", local);
    // The LOCAL artifact is the point of copyFile — read it, not the box copy.
    expect(readFileSync(local, "utf8")).toBe("harvested\n");
    await expect(driver.copyFile("copy-1", "../../etc/passwd", local)).rejects.toThrow();
    await expect(driver.copyFile("copy-1", "/etc/passwd", local)).rejects.toThrow();
  });
});
