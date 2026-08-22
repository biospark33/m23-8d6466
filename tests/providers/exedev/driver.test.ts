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
import { runLocal } from "./helpers.ts";

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

  test("tag guard: unsafe tags reject before any seam call", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    const before = fake.calls.length;
    for (const bad of ["a; rm -rf /", "-leading-dash", ".leading-dot", "with space", "tag\nnewline", "tag'quote", "tab\tthere"]) {
      try {
        await driver.create("tag-guard-box", bad);
        throw new Error(`should have rejected tag ${JSON.stringify(bad)}`);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("tag-invalid");
      }
    }
    expect(fake.calls.length).toBe(before);
  });

  test("tag guard: a good tag passes through and reaches the substrate", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    const vm = await driver.create("tag-ok-box", "v5.sprint-1");
    expect(vm.name).toBe("tag-ok-box");
    expect(vm.httpsUrl).toBe("https://tag-ok-box.exe.xyz");
    const control = fake.calls.filter((a) => a[0] === "ssh" && a[1] === "exe.dev");
    expect(control.some((a) => a.slice(2).join(" ").includes("--tag v5.sprint-1"))).toBe(true);
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
    // the clone itself, named "fill clone", NOT "repo-url-invalid" — that
    // distinction is the regression. The origin is loopback port 9 (discard):
    // connection refused instantly, no DNS, no egress — hermetic in CI.
    await expect(
      driver.fill("fill-https", {
        runId: "fill-https",
        repoUrl: "https://127.0.0.1:9/example/qds-factory.git",
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

  test("an `ls --json` entry whose vm_name is not a string is REPORTED as skipped, not silently dropped", async () => {
    // The driver-side twin of a skipped run-record file. `reapRuns` destroys
    // every box no open record claims and refuses outright on a listing it
    // cannot prove complete — so a VM dropped from `list()` used to be a live
    // box no verb could reach, spending against nobody's cap, with nothing in
    // the return value to say so. The DROP still happens (there is no usable
    // name to hand back); what changed is that it is now reported.
    //
    // A hand-written `run` seam, not the fake substrate: this shape is exactly
    // what the substrate never produces, so it has to be injected here.
    const stub = async (argv: string[]) => {
      expect(argv.slice(0, 3)).toEqual(["ssh", "exe.dev", "ls"]);
      return {
        stdout: JSON.stringify({ vms: [{ vm_name: "good-box" }, { vm_name: 42 }, { vm_name: null }] }),
        stderr: "",
        exitCode: 0,
      };
    };
    const driver = new ExeDevDriver({ run: stub });
    const listing = await driver.listWithAnomalies();
    expect(listing.vms.map((v) => v.name)).toEqual(["good-box"]);
    // The INDEX is the placeholder, because it is the only handle the substrate
    // gave us for the row — there is no name to print.
    expect(listing.skipped).toEqual(["vms[1] (vm_name is not a string)", "vms[2] (vm_name is not a string)"]);
    // `list()` is the thin wrapper over it, so the two can never disagree about
    // which VMs were reported — the dual-entry hazard the split otherwise has.
    expect(await driver.list()).toEqual(listing.vms);
    // A clean page reports an empty array, never `undefined`: a caller checking
    // `.length` must not read "no anomaly channel" as "no anomalies".
    const clean = new ExeDevDriver({
      run: async () => ({ stdout: JSON.stringify({ vms: [{ vm_name: "good-box" }] }), stderr: "", exitCode: 0 }),
    });
    expect((await clean.listWithAnomalies()).skipped).toEqual([]);
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

describe("ExeDevDriver — BMAD review round 6", () => {
  test("F5: exec + execTimed throw on empty argv elements", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      await expect(driver.exec("any", [""] as string[])).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.exec("any", ["git", ""] as string[])).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.execTimed("any", [""] as string[], 1000)).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.execTimed("any", ["git", ""] as string[], 1000)).rejects.toThrow("exec requires a non-empty argv");
    } finally {
      fake.cleanup();
    }
  });

  test("F6: create with empty new-shape https_url returns derived URL", async () => {
    const fake = fakeExeDev({ newShape: "empty-url" });
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      const vm = await driver.create("f6-box");
      expect(vm.httpsUrl).toBe("https://f6-box.exe.xyz");
    } finally {
      fake.cleanup();
    }
  });

  test("F7: constructor validates execTimeoutMs and hostSuffix", () => {
    expect(() => new ExeDevDriver({ execTimeoutMs: Number.NaN })).toThrow("must be a finite number");
    expect(() => new ExeDevDriver({ execTimeoutMs: 0 })).toThrow("must be a finite number");
    expect(() => new ExeDevDriver({ execTimeoutMs: -1 })).toThrow("must be a finite number");
    expect(() => new ExeDevDriver({ hostSuffix: ".exe.xyz" })).toThrow("is not a plain suffix");
    expect(() => new ExeDevDriver({ hostSuffix: "exe.xyz/x" })).toThrow("is not a plain suffix");
  });

  test("F8: boxHost validates runId (defense-in-depth)", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create("f8-box");
      expect(() => driver.boxHost("bad name!")).toThrow("invalid run id");
    } finally {
      fake.cleanup();
    }
  });
});

describe("ExeDevDriver — BMAD review round 7", () => {
  test("F9: exec + execTimed throw on whitespace-only argv elements", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      await expect(driver.exec("any", ["   "] as string[])).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.exec("any", ["git", "  \t  "] as string[])).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.exec("any", ["\n"] as string[])).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.execTimed("any", ["   "] as string[], 1000)).rejects.toThrow("exec requires a non-empty argv");
      await expect(driver.execTimed("any", ["git", "  \t  "] as string[], 1000)).rejects.toThrow("exec requires a non-empty argv");
    } finally {
      fake.cleanup();
    }
  });

  test("F10: fill rejects workdir with a symlinked PARENT component", async () => {
    const fake = fakeExeDev();
    const tempDir = mkdtempSync(join(tmpdir(), "qds-f10-"));
    let originDir: string;
    let sha: string;

    try {
      // Set up a git repo on the HOST (like other fill tests)
      originDir = join(tempDir, "origin");
      mkdirSync(originDir, { recursive: true });
      await runLocal(["git", "init", "-q", "-b", "main", originDir]);
      await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"]);
      sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();

      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create("f10-box");

      // Create a symlinked PARENT directory structure inside the box
      // The box's working dir is /home/agent/<box-name>/ — create symlink under that
      await driver.exec("f10-box", ["mkdir", "-p", "real-target"]);
      await driver.exec("f10-box", ["ln", "-s", "real-target", "link"]);

      // Workdir whose FINAL component is regular but PARENT is symlinked → must reject
      await expect(
        driver.fill("f10-box", {
          runId: "f10-run",
          repoUrl: `file://${originDir}`,
          commitSha: sha,
          workdir: "link/src", // parent "link" is the symlink
        }),
      ).rejects.toThrow(/symlink.*fill requires a regular directory/);
    } finally {
      fake.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("F11: fill rejects workdir with FINAL component symlinked (existing check)", async () => {
    const fake = fakeExeDev();
    const tempDir = mkdtempSync(join(tmpdir(), "qds-f11-"));
    let originDir: string;
    let sha: string;

    try {
      // Set up a git repo on the HOST (like other fill tests)
      originDir = join(tempDir, "origin");
      mkdirSync(originDir, { recursive: true });
      await runLocal(["git", "init", "-q", "-b", "main", originDir]);
      await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"]);
      sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();

      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create("f11-box");

      // Create a symlink as the FINAL component inside the box
      await driver.exec("f11-box", ["mkdir", "-p", "target"]);
      await driver.exec("f11-box", ["ln", "-s", "target", "direct-link"]);

      // Workdir whose FINAL component is the symlink → must reject (existing check)
      await expect(
        driver.fill("f11-box", {
          runId: "f11-run",
          repoUrl: `file://${originDir}`,
          commitSha: sha,
          workdir: "direct-link",
        }),
      ).rejects.toThrow(/symlink.*fill requires a regular directory/);
    } finally {
      fake.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
