/**
 * DF2.2 — exe.dev driver tests: DF2.1's contract suite (unmodified), registry
 * resolution, the AC5 response-shape fallback, INV-1 posture attestation, and
 * INV-2 hostname validation.
 *
 * The driver under test is the production ExeDevDriver; only the command seam
 * is swapped for the fake substrate (fixture).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriverContract } from "../driver-contract.test.ts";
import { registeredDrivers, resolveDriver } from "../../../src/providers/index.ts";
import { assertValidRunId, RunRecordStore } from "../../../src/providers/run-record.ts";
import { deliverRunKey, type KeyApi } from "../../../src/providers/credentials.ts";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { ExeDevDriverError } from "../../../src/providers/exedev/transport.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
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
  //
  // listingProvesTag: exedev's `ls --json` reports no tag field at all (a
  // documented KNOWN BLOCKER in driver.ts), so nothing its listing carries can
  // pass isFactoryOwnedVm — the contract's reap step takes the `reap-vms-unowned`
  // refusal arm here and must KEEP taking it (T2-5: declared per driver; a flip
  // to destroying would be a substrate change arriving unannounced).
  runDriverContract({
    driverName: "exedev",
    makeDriver: () => new ExeDevDriver({ run: fake.run, postureFile }),
    listingProvesTag: false,
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
    expect(control.some((a) => a.slice(2).join(" ") === "ls ac5-fallback-1 --json")).toBe(true);
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
      expect(control.some((a) => a.slice(2).join(" ") === "ls ac5-derive-1 --json")).toBe(true);
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

describe("ExeDevDriver — steering-channel provisioning at create (DF3.4 AC6 substrate fix)", () => {
  // The LIVE discovery this pins (T1.8, 2026-08-30): the box exec user is
  // non-root and /run is root-owned, so without create-time provisioning every
  // real `fleet attach` was refused at send time. The fake SIMULATES the
  // provisioning (see its handler — executing it would sudo the HOST /run);
  // what the unit layer owns is the CONTRACT: provisioned after the verified
  // shape, on both arms, resolving the same root attach.ts resolves, strict
  // and typed when the substrate cannot host the channel.

  test("create provisions the steering channel AFTER the verified `new` shape", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create("steer-prov-1");
      const idxNew = fake.calls.findIndex((a) => a[0] === "ssh" && a[1] === "exe.dev" && a.slice(2).join(" ").startsWith("new --name steer-prov-1 "));
      expect(idxNew).toBeGreaterThanOrEqual(0);
      const idxProv = fake.calls.findIndex((a) => a[1] === "steer-prov-1.exe.xyz" && a.some((x) => x.includes("sudo -n install -d -m 700")));
      expect(idxProv).toBeGreaterThan(idxNew);
      // The TARGET is the created box, not whatever host the seam happens to
      // sit on: ssh argv[1] must name the VM the `new` call just made. A
      // provisioning call aimed anywhere else is a sudo line against the wrong
      // substrate — the exact defect the fake's fail-closed sudo guard exists
      // to turn red.
      const provCall = fake.calls[idxProv] ?? [];
      expect(provCall[1]).toBe("steer-prov-1.exe.xyz");
      const script = provCall.filter((x) => x.includes("sudo -n install -d"))[0] ?? "";
      // The SAME root resolution attach.ts's BOX_STEERING_ROOT_SH uses — the
      // provisioned path and the addressed path can never diverge.
      expect(script).toContain('root="${QDS_STEERING_ROOT:-/run/steering}"');
      // The exec user owns it (not root), and provisioning is VERIFIED, not
      // assumed: writable, and 700 as promised.
      expect(script).toContain('install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root"');
      expect(script).toContain('test "$(stat -c %a "$root")" = 700');
      // The script's OUTCOME, not just its text: the fake's success arm
      // materializes the 0700 steering root inside the box it provisioned, so
      // the channel is observable the way a consumer (attach) finds it.
      const st = statSync(join(fake.boxDir("steer-prov-1"), "run", "steering"));
      expect(st.mode & 0o777).toBe(0o700);
    } finally {
      fake.cleanup();
    }
  });

  test("the AC5 ls-shape fallback arm provisions the same target (behavioral: the channel exists)", async () => {
    const fake = fakeExeDev({ newShape: "unrecognized" });
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create("steer-prov-fallback");
      const idxLs = fake.calls.findIndex((a) => a.slice(2).join(" ") === "ls steer-prov-fallback --json");
      expect(idxLs).toBeGreaterThanOrEqual(0);
      const idxProv = fake.calls.findIndex((a) => a.some((x) => x.includes("sudo -n install -d -m 700")));
      expect(idxProv).toBeGreaterThan(idxLs);
      // Same target assertion as the primary arm — the fallback's box is just
      // as much a steering target, and the call must aim at IT.
      const provCall = fake.calls[idxProv] ?? [];
      expect(provCall[1]).toBe("steer-prov-fallback.exe.xyz");
      // Behavioral, not textual: the channel the fallback provisioned exists.
      expect(existsSync(join(fake.boxDir("steer-prov-fallback"), "run", "steering"))).toBe(true);
    } finally {
      fake.cleanup();
    }
  });

  test("unprovisionable channel → typed refusal, VM stays listable (INV-5)", async () => {
    const fake = fakeExeDev({ steeringProvisionFails: true });
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      const err = await driver.create("steer-prov-dead").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ExeDevDriverError);
      expect((err as ExeDevDriverError).code).toBe("steering-channel-unprovisionable");
      expect((err as Error).message).toContain("steer-prov-dead");
      // The `new` already ran at the substrate — the box must remain findable
      // for the reaper, exactly like create-shape-unresolved's posture.
      const ls = await driver.list("steer-prov-dead");
      expect(ls.map((v) => v.name)).toContain("steer-prov-dead");
    } finally {
      fake.cleanup();
    }
  });

  test("a provision script the fake cannot recognize FAILS CLOSED at the seam (interceptor-drift canary)", async () => {
    // The fake must never execute a sudo-bearing line on the HOST it runs on.
    // If the driver's provision literal is edited, the interceptor's substring
    // match stops and the fake answers with a named fake-level error instead
    // of falling through to host-shell execution — which turns every
    // provisioning test red AT THE SEAM and names the drift in stderr.
    const fake = fakeExeDev();
    try {
      // A box must exist first — the seam refuses an unknown host before any
      // command inspection, which is its own (already-covered) refusal.
      fake.boxDir("steer-drift");
      const res = await fake.run([
        "ssh",
        "steer-drift.exe.xyz",
        'sudo -n something-else /run/steering',
      ]);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("sudo-bearing command matched no simulated handler");
      expect(res.stderr).toContain("provision-script drift");
      // And nothing ran on the "box": no steering root was created by the
      // refused line (the only way one appears is a matched provision arm).
      expect(existsSync(join(fake.boxDir("steer-drift"), "run", "steering"))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("the sudo guard is SCOPED to the channel — a sudo command that names no steering path falls through", async () => {
    // The guard used to fire on any command that mentioned `sudo`, replacing
    // whatever handler the command actually needed with the drift refusal. It
    // is scoped to a sudo-bearing AND steering-naming command, so a sudo line
    // about something else reaches real execution. `sudo -n true` is inert and
    // never prompts on any host, which makes it the cheapest probe proving the
    // fall-through happened (exit 0 or 1) rather than the guard firing (64).
    const fake = fakeExeDev();
    try {
      fake.boxDir("steer-guard-scope");
      const res = await fake.run(["ssh", "steer-guard-scope.exe.xyz", "sudo -n true"]);
      expect(res.exitCode).not.toBe(64);
      expect(res.stderr).not.toContain("matched no simulated handler");
    } finally {
      fake.cleanup();
    }
  });

  test("provisioning resolves QDS_STEERING_ROOT the way the script's own order does (P5)", async () => {
    // `root="${QDS_STEERING_ROOT:-/run/steering}"` resolves the env override
    // FIRST. The fake honoring that order is what makes a root-addressing
    // divergence visible at the unit layer: a script (or fake) that
    // provisioned one path while a consumer addressed another would leave the
    // channel unprovisionable at exactly the path attach reads.
    const prev = process.env.QDS_STEERING_ROOT;
    const fake = fakeExeDev();
    try {
      process.env.QDS_STEERING_ROOT = "/srv/steering/alt";
      await new ExeDevDriver({ run: fake.run }).create("steer-root-env");
      // Box-absolute: the override maps INTO the box, at the path the script
      // would have created there, still 0700.
      expect(statSync(join(fake.boxDir("steer-root-env"), "srv", "steering", "alt")).mode & 0o777).toBe(0o700);
      // The override REPLACED the default — nothing landed at it.
      expect(existsSync(join(fake.boxDir("steer-root-env"), "run", "steering"))).toBe(false);

      // A root spelling the default maps to the same box path as no override.
      process.env.QDS_STEERING_ROOT = "/run/steering";
      await new ExeDevDriver({ run: fake.run }).create("steer-root-default-spelling");
      expect(statSync(join(fake.boxDir("steer-root-default-spelling"), "run", "steering")).mode & 0o777).toBe(0o700);

      // Var absent → the script's own default is what lands. Reflect, not the
      // `delete` operator: assigning `undefined` COERCES it to the string
      // "undefined", which the script would then read as a root path.
      Reflect.deleteProperty(process.env, "QDS_STEERING_ROOT");
      await new ExeDevDriver({ run: fake.run }).create("steer-root-unset");
      expect(statSync(join(fake.boxDir("steer-root-unset"), "run", "steering")).mode & 0o777).toBe(0o700);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_STEERING_ROOT");
      else process.env.QDS_STEERING_ROOT = prev;
      fake.cleanup();
    }
  });
});

describe("ExeDevDriver — steering provision failure classification (P2: the exit class picks the diagnosis)", () => {
  /**
   * A seam that fabricates the steering provision exec's RESULT and delegates
   * everything else to the fake. The fixture only models the sudo-less
   * substrate (exit 1); 137 and 255 are exit statuses the provision script can
   * never produce on purpose, so they arrive here as fabricated seam results —
   * the same shape the driver reads off a real box.
   */
  function seamWithProvisionResult(base: FakeExeDev["run"], exitCode: number, stderr: string): FakeExeDev["run"] {
    return async (argv, opts) => {
      const target = argv[1];
      if (typeof target === "string" && target.endsWith(".exe.xyz") && argv.slice(2).join(" ").includes("sudo -n install -d -m 700")) {
        return { stdout: "", stderr, exitCode };
      }
      return base(argv, opts);
    };
  }

  async function refusalFor(arm: { exitCode: number; stderr: string }, execTimeoutMs?: number): Promise<ExeDevDriverError> {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({
        run: seamWithProvisionResult(fake.run, arm.exitCode, arm.stderr),
        ...(execTimeoutMs === undefined ? {} : { execTimeoutMs }),
      });
      return (await driver.create("steer-class").then(
        () => null,
        (e: unknown) => e,
      )) as ExeDevDriverError;
    } finally {
      fake.cleanup();
    }
  }

  test("exit 137 — exec-budget/SIGKILL wording, box-first remediation, never sudo-policy", async () => {
    const err = await refusalFor({ exitCode: 137, stderr: "Killed" }, 1500);
    // The CODE is the decision callers act on and is identical in every arm.
    expect(err.code).toBe("steering-channel-unprovisionable");
    expect(err.message).toContain("never answered its steering-channel provisioning exec");
    // The budget NAMED is the driver's own configured ceiling.
    expect(err.message).toContain("hit the 1500 ms exec budget and was SIGKILLed (exit 137)");
    // The stderr tail rides as evidence an operator can overrule the
    // classification with.
    expect(err.message).toContain("Killed");
    expect(err.remediation).toContain("not a sudo-policy finding");
    expect(err.remediation).toContain("ssh steer-class.exe.xyz true");
    expect(err.remediation).toContain("raise execTimeoutMs");
    expect(err.remediation).not.toContain("passwordless sudo");
  });

  test("exit 255 — transport wording, transport remediation", async () => {
    const err = await refusalFor({ exitCode: 255, stderr: "ssh: connect to host steer-class.exe.xyz port 22: Connection refused" });
    expect(err.code).toBe("steering-channel-unprovisionable");
    expect(err.message).toContain("could not be reached to provision its steering channel");
    expect(err.message).toContain("ssh exited 255");
    expect(err.message).toContain("Connection refused");
    expect(err.remediation).toContain("transport fault, not a sudo-policy finding");
    expect(err.remediation).toContain("confirm the box is up");
    expect(err.remediation).not.toContain("passwordless sudo");
  });

  test("any other non-zero exit — sudo-policy wording (the substrate's permission model)", async () => {
    const err = await refusalFor({ exitCode: 1, stderr: "sudo: a password is required" });
    expect(err.code).toBe("steering-channel-unprovisionable");
    expect(err.message).toContain("came up without a writable steering channel");
    expect(err.message).toContain("sudo: a password is required");
    expect(err.remediation).toContain("passwordless sudo");
    expect(err.remediation).toContain("substrate finding");
  });

  test("every arm tells the operator the send-time consequence, and the tail is capped", async () => {
    // The consequence is the same in all three arms — the channel is dead, so
    // every steering message would be refused at send time.
    for (const arm of [
      { exitCode: 137, stderr: "Killed" },
      { exitCode: 255, stderr: "connection dropped" },
      { exitCode: 1, stderr: "sudo: a password is required" },
    ]) {
      expect((await refusalFor(arm)).message).toContain('attach reason "send-failed"');
    }
    // The tail is a 300-char window, not an unbounded splice of box output.
    const err = await refusalFor({ exitCode: 1, stderr: "x".repeat(400) });
    expect(err.message).toContain("x".repeat(300));
    expect(err.message).not.toContain("x".repeat(301));
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
    // The `sleep` is redirected out of habit, not necessity: the fake takes the
    // whole process group on its deadline (detached child + kill(-pid)), so an
    // unredirected grandchild can no longer outlive `sh` holding the pipes —
    // the un-redirected variant below exists precisely to pin that. stderr is
    // where the pre-kill evidence rides.
    const res = await driver.exec("exec-3", ["sh", "-c", "echo pre-kill-marker >&2; sleep 30 >/dev/null 2>&1"]);
    expect(res.exitCode).not.toBe(0);
    // The kill's evidence surfaces, it is not a bare status: whatever the
    // substrate managed to emit before the SIGKILL rode back on stderr, and
    // the driver returns it — a caller diagnosing a timeout reads that, not
    // just an exit code.
    expect(res.stderr).toContain("pre-kill-marker");
  }, 15_000);

  test("the deadline kills the child's whole process GROUP — an unredirected grandchild cannot wedge the seam", async () => {
    const driver = new ExeDevDriver({ run: fake.run, execTimeoutMs: 500 });
    await driver.create("exec-3g");
    // NO redirect: `sleep 30` inherits `sh`'s stdout and stderr. When the fake
    // killed only the direct child, that grandchild outlived it holding the
    // output pipes, the two `new Response(...).text()` reads below (in the
    // fixture) never settled, and every later exec on the box queued behind a
    // seam that never returned — this test hung past its own budget. Killing
    // the group (`kill(-pid)` against a detached child) is what makes it
    // terminate; drop that and THIS test is the red one.
    const res = await driver.exec("exec-3g", ["sh", "-c", "echo pre-kill-marker >&2; sleep 30"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("pre-kill-marker");
    // The kill did not strand a reader: the box takes another exec.
    const after = await driver.exec("exec-3g", ["echo", "alive"]);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toBe("alive\n");
  }, 15_000);
});

describe("ExeDevDriver — fill (clone, SHA pin, sbx/<run-id> branch)", () => {
  let fake: FakeExeDev;
  let originDir: string;
  let tempDir: string;
  let shaA: string;
  let shaB: string;

  beforeAll(async () => {
    // Every test here runs REAL git through the seam (host clone, in-box
    // branch), so each one is a handful of real process spawns — a few hundred
    // ms apiece idle, seconds when the box is busy. bun's 5 s per-test default
    // is a load artefact waiting to happen, so these carry explicit budgets.
    // The budgets are not a license to hang: a wedged clone still fails, just
    // at 30 s with the failure named instead of at 5 s as a timeout.
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
  }, 30_000);

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }, 30_000);

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
  }, 30_000);

  test("F4 (2026-08-24): the DEFAULT fill mode is bundle-push — host clone → base64 bundle in → box clones from the LOCAL bundle", async () => {
    // Private repos are the operator requirement: a box has no GitHub creds
    // (INV-CRED-1 — no second secret in a box), so an in-box https clone of a
    // private repo is impossible BY DESIGN. Bundle-push fills from the HOST's
    // own credentials: host fetches the pinned SHA, bundles it, pushes the
    // bundle over exec stdin (base64 — the wire is textual), and the box
    // clones from the LOCAL bundle file. Credentials never cross the wire.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-bundle");
    await driver.fill("fill-bundle", {
      runId: "fill-bundle",
      repoUrl: `file://${originDir}`,
      commitSha: shaB,
      workdir: "work",
    });
    // Same end-state as the remote clone: pinned SHA on sbx/<run-id>.
    const head = await driver.exec("fill-bundle", ["git", "-C", "work", "rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe(shaB);
    const branch = await driver.exec("fill-bundle", ["git", "-C", "work", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("sbx/fill-bundle");
    // And it went THROUGH the bundle, not an in-box origin clone: the box saw
    // a base64 decode landing the bundle, and its clone named the bundle file.
    // (argv words are shQuoted, so match per-token, not across spaces.)
    const sawDecode = fake.calls.some((argv) => argv.join(" ").includes("base64 -d"));
    expect(sawDecode).toBe(true);
    const sawBundleClone = fake.calls.some((argv) => argv.join(" ").includes("clone") && argv.join(" ").includes("work.bundle"));
    expect(sawBundleClone).toBe(true);
    // The in-box clone NEVER named the origin URL — that is the whole point:
    // the box needs zero network credentials for this fill.
    const cloneCalls = fake.calls.filter((argv) => argv.join(" ").includes("clone"));
    expect(cloneCalls.length).toBeGreaterThan(0);
    expect(cloneCalls.every((argv) => !argv.join(" ").includes(originDir))).toBe(true);
    // No bundle litter left in the box.
    const litter = await driver.exec("fill-bundle", ["sh", "-c", "ls work.bundle 2>/dev/null; true"]);
    expect(litter.stdout.trim()).toBe("");
  }, 30_000);

  test("F4: mode 'remote-clone' keeps the legacy in-box https/file clone", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-remote");
    await driver.fill("fill-remote", {
      runId: "fill-remote",
      repoUrl: `file://${originDir}`,
      commitSha: shaB,
      workdir: "work",
      mode: "remote-clone",
    });
    const branch = await driver.exec("fill-remote", ["git", "-C", "work", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("sbx/fill-remote");
    const cloneCalls = fake.calls.filter((argv) => argv.join(" ").includes("clone"));
    expect(cloneCalls.some((argv) => argv.join(" ").includes(originDir))).toBe(true);
  }, 30_000);

  test("F4: a re-fill in bundle-push mode fetches from a fresh bundle and preserves the sandbox branch", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-bundle2");
    await driver.fill("fill-bundle2", {
      runId: "fill-bundle2",
      repoUrl: `file://${originDir}`,
      commitSha: shaB,
      workdir: "work",
    });
    await driver.exec("fill-bundle2", [
      "git",
      "-C",
      "work",
      "-c",
      "user.email=test@qds",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "in-box work",
    ]);
    const before = await driver.exec("fill-bundle2", ["git", "-C", "work", "rev-parse", "sbx/fill-bundle2"]);
    await driver.fill("fill-bundle2", {
      runId: "fill-bundle2",
      repoUrl: `file://${originDir}`,
      commitSha: shaA,
      workdir: "work",
    });
    const after = await driver.exec("fill-bundle2", ["git", "-C", "work", "rev-parse", "sbx/fill-bundle2"]);
    expect(after.stdout.trim()).toBe(before.stdout.trim()); // never reset
    const head = await driver.exec("fill-bundle2", ["git", "-C", "work", "rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe(after.stdout.trim()); // still ON the branch
    // The refill fetched from the BUNDLE, not an origin remote.
    const fetchCalls = fake.calls.filter((argv) => argv.join(" ").includes("fetch"));
    expect(fetchCalls.some((argv) => argv.join(" ").includes("work.bundle"))).toBe(true);
  }, 30_000);

  test("F4: a workdir carrying shell metacharacters or .. is refused before any command runs", async () => {
    // The workdir (and the <workdir>.bundle sibling) reaches sh -c scripts —
    // the validator is the PRIMARY defense, shQuote the belt (credentials.ts
    // assertEnvFileSafe posture). Refused at the boundary, zero seam calls.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-badpath");
    const before = fake.calls.length;
    for (const bad of ["a; rm -rf /", "../escape", "a/../b", "a//b", "trailing/", ""]) {
      await expect(
        driver.fill("fill-badpath", { runId: "fill-badpath", repoUrl: `file://${originDir}`, commitSha: shaB, workdir: bad }),
      ).rejects.toThrow(/workdir/);
    }
    expect(fake.calls.length).toBe(before);
  }, 30_000);

  test("F4: an oversized bundle refuses with a named error before any box mutation", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-toobig");
    let err: unknown;
    try {
      await driver.fill("fill-toobig", {
        runId: "fill-toobig",
        repoUrl: `file://${originDir}`,
        commitSha: shaB,
        workdir: "work",
        bundleMaxBytes: 1, // any real bundle exceeds 1 byte
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("fill-failed");
    expect(String((err as Error).message)).toContain("bundle-too-large");
    // Nothing landed in the box.
    const probe = await driver.exec("fill-toobig", ["sh", "-c", "ls work 2>/dev/null; ls work.bundle 2>/dev/null; true"]);
    expect(probe.stdout.trim()).toBe("");
  }, 30_000);

  test("fill with NO workdir clones into the HOME-relative default 'src' (F3, 2026-08-24)", async () => {
    // The real exe.dev image: ssh user exedev, HOME=/home/exedev, /home
    // root-owned. A default of /home/agent/src made every default fill fail
    // with "Permission denied" (e2e-run-report F3). The default is now
    // RELATIVE — ssh exec lands in $HOME, so "src" resolves image-agnostically
    // and the fake substrate (cwd = box dir) models the same contract.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-default");
    await driver.fill("fill-default", {
      runId: "fill-default",
      repoUrl: `file://${originDir}`,
      commitSha: shaB,
    });
    const branch = await driver.exec("fill-default", ["git", "-C", "src", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.exitCode).toBe(0);
    expect(branch.stdout.trim()).toBe("sbx/fill-default");
  }, 30_000);

  test("key delivery with NO envFile lands in the HOME-relative default app/.env, mode 600 (F3)", async () => {
    // KEY_ENV_FILE shares the fill wall: /home/agent/app/.env is unwritable on
    // the real image. Relative "app/.env" resolves against the ssh HOME (the
    // fake substrate's box dir models it) and stays a SIBLING of the "src"
    // clone dir — the fill.ts separation contract holds.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("deliver-default");
    const unusedKeyApi: KeyApi = {
      createKey: async () => {
        throw new Error("not used by deliverRunKey");
      },
      getKeyEntry: async () => {
        throw new Error("not used by deliverRunKey");
      },
      listAllKeys: async () => {
        throw new Error("not used by deliverRunKey");
      },
      deleteKey: async () => {
        throw new Error("not used by deliverRunKey");
      },
    };
    const store = new RunRecordStore({ dir: join(tempDir, "deliver-runs") });
    await deliverRunKey({ keyApi: unusedKeyApi, driver, store }, "deliver-default", "sk-or-test-not-a-real-key");
    const envPath = join(fake.boxDir("deliver-default"), "app", ".env");
    const st = statSync(envPath);
    expect((st.mode & 0o777).toString(8)).toBe("600");
    expect(readFileSync(envPath, "utf8")).toBe("OPENROUTER_API_KEY=sk-or-test-not-a-real-key\n");
  }, 30_000);

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
  }, 30_000);

  test("fill ACCEPTS a real https clone URL with a path (regression: the grammar once rejected every production URL)", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-https");
    // A path-carrying https URL must pass the GRAMMAR: the failure below is
    // the fetch itself, named "fill host-bundle" (bundle-push is the default
    // mode — the HOST does the fetching), NOT "repo-url-invalid" — that
    // distinction is the regression. The origin is loopback port 9 (discard):
    // connection refused instantly, no DNS, no egress — hermetic in CI.
    await expect(
      driver.fill("fill-https", {
        runId: "fill-https",
        repoUrl: "https://127.0.0.1:9/example/qds-factory.git",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        workdir: "work",
      }),
    ).rejects.toThrow(/fill host-bundle|fill clone exited/);
  }, 30_000);

  test("fill refuses a repo URL that is not a plain public clone source", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-3");
    for (const bad of ["http://insecure.example/repo", "https://user:pass@example.com/repo", "not-a-url"]) {
      await expect(
        driver.fill("fill-3", { runId: "fill-3", repoUrl: bad, commitSha: shaA, workdir: "work" }),
      ).rejects.toThrow(/repo/);
    }
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
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
    // The index anchors the entry, and whatever the row DOES identify itself by
    // rides along — the refusal built on this tells an operator to go find the
    // box, and "vms[1]" alone names nothing findable. These rows carry no other
    // field, so the anomaly says exactly that rather than implying a handle.
    expect(listing.skipped).toEqual([
      "vms[1] (vm_name is not a string; the row carries no other identifying field)",
      "vms[2] (vm_name is not a string; the row carries no other identifying field)",
    ]);
    // A row that DOES carry identifying fields surfaces them: that is the whole
    // difference between a followable remediation and an unfollowable one.
    const withFields = new ExeDevDriver({
      run: async () => ({
        stdout: JSON.stringify({ vms: [{ vm_name: 42, ssh_dest: "root@abc.exe.xyz", tag: "qds-sbx" }] }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect((await withFields.listWithAnomalies()).skipped).toEqual([
      'vms[0] (vm_name is not a string; row fields: ssh_dest="root@abc.exe.xyz" tag="qds-sbx")',
    ]);
    // A READABLE name outside the factory grammar is a STRANGER's box in the
    // same account (`create` only ever names boxes from an assertValidRunId
    // id), and this listing is account-wide. It is EXCLUDED — reporting it
    // would stall the fleet sweep over a box we can never make go away, and
    // passing it through would have `reapOrphans` destroy someone else's box.
    const foreign = new ExeDevDriver({
      run: async () => ({
        stdout: JSON.stringify({ vms: [{ vm_name: "good-box" }, { vm_name: "Someones_Dev_Box" }] }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const foreignListing = await foreign.listWithAnomalies();
    expect(foreignListing.vms.map((v) => v.name)).toEqual(["good-box"]);
    expect(foreignListing.skipped).toEqual([]);
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

  test("a foreign box is excluded SILENTLY from the return value but LOUDLY on the log", async () => {
    // Exclusion is the only option that is not a live hazard — but "not in
    // `vms` and not in `skipped`" is indistinguishable from a box that simply
    // was not there, and an operator staring at `fleet status` deserves to know
    // the account holds boxes this factory does not manage. The log line is the
    // whole of that channel, so it is worth pinning: the box NAME (to go look)
    // and the REASON (so it is not read as a bug in the listing).
    //
    // Contrast with `FakeDriver`, which reports a stray entry as an ANOMALY:
    // `.sandbox/fake-boxes` is our OWN directory, so a name we did not write is
    // suspicious. exe.dev's listing is account-wide, where a stranger's box is
    // ordinary — and reporting it would stall the fleet sweep over a box we can
    // never make go away, while OUR boxes keep billing.
    const foreign = new ExeDevDriver({
      run: async () => ({
        stdout: JSON.stringify({
          vms: [{ vm_name: "good-box" }, { vm_name: "Someones_Dev_Box" }, { vm_name: "another_stranger" }],
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
    let listing: Awaited<ReturnType<ExeDevDriver["listWithAnomalies"]>>;
    try {
      listing = await foreign.listWithAnomalies();
    } finally {
      restore();
    }
    expect(listing.vms.map((v) => v.name)).toEqual(["good-box"]);
    expect(listing.skipped).toEqual([]);

    // ONE line per excluded box — not one per listing, and not one per row.
    const excluded = lines.filter((l) => l.operation === "exedev.list_excluded_foreign_name");
    expect(excluded.map((l) => l.vm)).toEqual(["Someones_Dev_Box", "another_stranger"]);
    expect(excluded[0]?.outcome).toBe("excluded");
    expect(excluded[0]?.reason).toContain("not a box this driver created");
    // The box we DID recognise produces no exclusion line at all.
    expect(lines.filter((l) => l.vm === "good-box" && l.outcome === "excluded")).toEqual([]);
  });

  test("a LEGACY-grammar name is POSSIBLY ours and is LISTED, not excluded (S14)", async () => {
    // `trailing-` ids exist ON DISK by construction from every build before the
    // grammar tightened (run-record.ts's read/write split), so a box named from
    // one may be OURS — an earlier build created it. Excluding it on the strict
    // grammar hid a billed, unreapable box from `fleet status` and the record
    // sweep forever. Ownership stays with `isFactoryOwnedVm` downstream; the
    // listing only refuses to drop what might be ours.
    const legacy = new ExeDevDriver({
      run: async () => ({
        stdout: JSON.stringify({ vms: [{ vm_name: "trailing-" }, { vm_name: "good-box" }] }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const listing = await legacy.listWithAnomalies();
    expect(listing.vms.map((v) => v.name)).toEqual(["trailing-", "good-box"]);
    // Listed operator-visibly is not "skipped": nothing here blocks a reap.
    expect(listing.skipped).toEqual([]);
  });

  test("skipped entries are REDACTED before they leave the driver (S20)", async () => {
    // A malformed row's identifying fields ride the anomaly string verbatim, and
    // that string reaches error messages and log lines. Provider rows carry
    // `https_url`/`ssh_dest` values that can embed credentials (`ghs_…` in a
    // clone URL), so the free text goes through the shared redactor first.
    const leaky = new ExeDevDriver({
      run: async () => ({
        stdout: JSON.stringify({
          vms: [{ vm_name: 42, ssh_dest: "https://x-access-token:ghs_15b9c7e0deadbeef@github.com/o/r" }],
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const listing = await leaky.listWithAnomalies();
    expect(listing.vms).toEqual([]);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]).toContain("«redacted»");
    expect(JSON.stringify(listing.skipped)).not.toContain("ghs_");
    // The identifying SHAPE survives the redaction — still followable.
    expect(listing.skipped[0]).toContain("ssh_dest=");
    expect(listing.skipped[0]).toContain("@github.com/o/r");
  });

  test("destroy re-reads ls when rm reports not-found — idempotent by content", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("destroy-1");
    await driver.destroy("destroy-1");
    await driver.destroy("destroy-1");
    expect((await driver.list("destroy-1"))).toEqual([]);
  });

  test("destroy VERIFIES absence after a successful rm — exit 0 alone is not 'destroyed' (F7, 2026-08-24)", async () => {
    // The live flake shape (e2e-run-report F7): `rm` exited 0, the box stayed
    // listed, teardown walked away "confirmed". rm's exit status is a claim;
    // the listing is the state. One retry, then fail closed.
    let rmCalls = 0;
    const lying = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const sub = argv.slice(2).join(" ");
      if (/^rm /.test(sub)) {
        rmCalls++;
        return { stdout: "removed\n", stderr: "", exitCode: 0 };
      }
      if (/^ls( \S+)? --json$/.test(sub)) {
        return {
          stdout: `${JSON.stringify({ vms: [{ vm_name: "f7-lying", ssh_dest: "f7-lying.exe.xyz" }] })}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (sub === "whoami") return { stdout: "op\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: `unsupported: ${sub}\n`, exitCode: 64 };
    };
    const driver = new ExeDevDriver({ run: lying });
    let err: unknown;
    try {
      await driver.destroy("f7-lying");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    const code = (err as ExeDevDriverError).code;
    expect(code).toBe("rm-failed");
    expect(String((err as Error).message)).toContain("still listed");
    expect(rmCalls).toBe(2); // exactly one retry before failing closed
  });

  test("destroy recovers when the retry clears a stale listing (F7)", async () => {
    // rm exit 0 + still listed once, then the second listing is clean:
    // transient listing lag must not wedge the destroy.
    let rmCalls = 0;
    const lagging = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const sub = argv.slice(2).join(" ");
      if (/^rm /.test(sub)) {
        rmCalls++;
        return { stdout: "removed\n", stderr: "", exitCode: 0 };
      }
      if (/^ls( \S+)? --json$/.test(sub)) {
        const stillListed = rmCalls < 2; // first listing lags, second is clean
        const vms = stillListed ? [{ vm_name: "f7-lag", ssh_dest: "f7-lag.exe.xyz" }] : [];
        return { stdout: `${JSON.stringify({ vms })}\n`, stderr: "", exitCode: 0 };
      }
      if (sub === "whoami") return { stdout: "op\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: `unsupported: ${sub}\n`, exitCode: 64 };
    };
    await new ExeDevDriver({ run: lagging }).destroy("f7-lag");
    expect(rmCalls).toBe(2);
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
