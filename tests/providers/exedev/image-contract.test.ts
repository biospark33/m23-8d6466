/**
 * DF2.10 — the factory-owned boot image contract.
 *
 * Three claims, one suite:
 *
 *   AC3  `create()` threads `--image` (and, default-off, `--registry-auth`)
 *        through the existing argv literal, and BOTH are validated in the
 *        CONSTRUCTOR — at the trust boundary, before any command exists.
 *   AC4  the registry credential is a separate class: never echoed by the
 *        error that refuses it, never in an emitted line, never in a
 *        provenance field, and scrubbed out of substrate stderr (INV-IBOX-3).
 *   AC1c gate B proves the box's baked `/etc/qds-image.json` against the repo
 *        pin, fail-closed, as a PAYLOAD — and adds no `AssertionItem` letter.
 *
 * Same discipline as its siblings: the driver and the gate under test are the
 * PRODUCTION classes, only the command seam is swapped for the fake substrate,
 * and the substrate is doubled by CONTENT (what `cat /etc/qds-image.json`
 * prints) never by exit status. A box that booted the wrong image answers its
 * marker read successfully — the wrong ANSWER is the entire failure mode, and
 * an exit-status double could not express it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  ExeDevDriver,
  IMAGE_MARKER_MAX_BYTES,
  IMAGE_MARKER_PATH,
  assertImageRef,
  assertRegistryAuth,
  exeDevDriverFromEnv,
  imageDigestOf,
  isUnpinnedImage,
  parseImageMarker,
} from "../../../src/providers/exedev/driver.ts";
import { ExeDevDriverError } from "../../../src/providers/exedev/transport.ts";
import { ASSERTION_CODE, type AssertionItem } from "../../../src/providers/exedev/setup-gate.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
import {
  DEFAULT_IMAGE_MARKER,
  fakeExeDev,
  writePostureAttestation,
  type FakeCommand,
  type FakeExeDev,
} from "./fixtures/fake-exedev.ts";
import { runLocal } from "./helpers.ts";

/** A digest-pinned reference that is NOT the sentinel — the shape we publish. */
const PINNED = `ghcr.io/biospark33/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;
/** The tenant-mirror case: a customer's own registry, same digest (D7 tier). */
const MIRRORED = `harbor.acme.internal/qds/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;

/** Every control-plane `new` argv the seam carried, flattened. */
function newArgv(fake: FakeExeDev): string[] {
  const call = fake.calls.find((a) => a[0] === "ssh" && a[1] === "exe.dev" && a[2] === "new");
  return call ?? [];
}

/** Run `fn` with the log sink captured; returns every emitted line. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  // dp:ok test-only widening of the log sink's own event type so emitted
  // lines can be searched for a leaked credential; no production path.
  const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); /* dp:ok test-only widening so emitted lines can be searched for a leaked credential */
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    restore();
  }
}

// ─── AC1 / DoD: the pin is real ─────────────────────────────────────────────

describe("DF2.10 AC1 — the shipped pin", () => {
  test("DoD negative control: the shipped DEFAULT_IMAGE_REF is NOT the unpinned sentinel", () => {
    // RED BY DESIGN until `.github/workflows/publish-exedev-image.yml` publishes
    // the image and writes the real digest back into driver.ts. This test IS
    // the merge gate: a story that ships `--image` pointing at an all-zeros
    // digest has threaded a flag at an image that does not exist, and every
    // box create would fail at the substrate. Never skip, never `todo`, never
    // weaken — the day it goes green is the day the pin became real.
    expect(isUnpinnedImage(DEFAULT_IMAGE_REF)).toBe(false);
  });

  test("the shipped reference is a well-formed digest pin and its digest is readable", () => {
    expect(() => assertImageRef(DEFAULT_IMAGE_REF)).not.toThrow();
    expect(imageDigestOf(DEFAULT_IMAGE_REF)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // AC1b: a tag pin is the honest weaker arm, and it reports `null` rather
    // than inventing a digest no reference carries.
    expect(imageDigestOf("ghcr.io/biospark33/qds-exedev:v1")).toBeNull();
  });

  test("isUnpinnedImage keys on the digest, not on the repository", () => {
    expect(isUnpinnedImage(`ghcr.io/anyone/anything@sha256:${"0".repeat(64)}`)).toBe(true);
    expect(isUnpinnedImage(PINNED)).toBe(false);
  });
});

// ─── AC3: argv + constructor validation ─────────────────────────────────────

describe("DF2.10 AC3 — image grammar is asserted at the trust boundary", () => {
  let fake: FakeExeDev;

  beforeAll(() => {
    fake = fakeExeDev();
  });
  afterAll(() => fake.cleanup());

  test("digest, tag and tenant-mirror references are accepted", () => {
    for (const ref of [
      PINNED,
      MIRRORED,
      "ghcr.io/biospark33/qds-exedev:v1.2.3",
      "registry.example.com:5000/team/img:latest",
      "localhost:5000/dev/img:scratch",
    ]) {
      expect(() => assertImageRef(ref)).not.toThrow();
      expect(new ExeDevDriver({ run: fake.run, image: ref }).image).toBe(ref);
    }
  });

  test("the refusal happens in the CONSTRUCTOR, before any command runs", () => {
    // THE claim. `expect(...).toThrow()` alone would also pass on an
    // implementation that validated inside create() after issuing the command —
    // the empty call log is what proves nothing reached the wire. ssh
    // CONCATENATES argv into a remote command line, so "it threw afterwards" is
    // not a defence.
    const refused: Array<[string, string]> = [
      ["bare name, no registry host", "ubuntu:22.04"],
      ["command substitution", "ghcr.io/qds/img:$(id)"],
      ["semicolon", "ghcr.io/qds/img:v1;id"],
      ["space", "ghcr.io/qds/img :v1"],
      ["newline", "ghcr.io/qds/img:v1\nid"],
      ["backtick", "ghcr.io/qds/img:`id`"],
      ["empty", ""],
      ["short digest", "ghcr.io/qds/img@sha256:abc"],
    ];
    for (const [why, ref] of refused) {
      let caught: unknown;
      try {
        new ExeDevDriver({ run: fake.run, image: ref });
      } catch (e) {
        caught = e;
      }
      expect(caught, why).toBeInstanceOf(ExeDevDriverError);
      expect((caught as ExeDevDriverError).code, why).toBe("image-invalid");
      expect((caught as ExeDevDriverError).remediation.length, why).toBeGreaterThan(0);
    }
    // Not one command was built, for any of them.
    expect(fake.calls).toEqual([]);
    expect(fake.creates).toEqual([]);
  });

  test("an image reference IS echoed on refusal — it is a public pin, not a credential", () => {
    // The deliberate asymmetry with assertRegistryAuth below: an operator
    // debugging a typo in a pin needs to see what was rejected.
    expect(() => assertImageRef("ghcr.io/qds/img:$(id)")).toThrow(/\$\(id\)/);
  });
});

describe("DF2.10 AC3 — create() argv", () => {
  test("`--image <ref>` rides the literal; `--registry-auth` is ABSENT when unset", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED });
      await driver.create("df210-argv-1");
      expect(newArgv(fake)).toEqual([
        "ssh",
        "exe.dev",
        "new",
        "--name",
        "df210-argv-1",
        "--image",
        PINNED,
        "--json",
      ]);
      // The fake's control plane PARSED it: the anchored matcher accepted the
      // argv rather than falling through to exit 64. Asserting only the argv
      // array would pass on an argv the substrate refuses.
      expect(fake.creates).toEqual([{ name: "df210-argv-1", image: PINNED }]);
    } finally {
      fake.cleanup();
    }
  });

  test("with a tag, `--image` sits after `--tag` and before `--json`", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED });
      await driver.create("df210-argv-2", "qds-run");
      expect(newArgv(fake)).toEqual([
        "ssh",
        "exe.dev",
        "new",
        "--name",
        "df210-argv-2",
        "--tag",
        "qds-run",
        "--image",
        PINNED,
        "--json",
      ]);
      expect(fake.creates).toEqual([{ name: "df210-argv-2", tag: "qds-run", image: PINNED }]);
    } finally {
      fake.cleanup();
    }
  });

  test("AC3 negative control: create() reads the DRIVER's field, never process.env", async () => {
    // An implementation that read `process.env.QDS_EXEDEV_IMAGE` inside create()
    // passes every unit test that constructs the driver directly — none of them
    // set the variable. So SET it, and demand the directly-constructed driver
    // ignore it. The env seam still has to work, or "ignores env" would be
    // satisfiable by an implementation with no override path at all.
    const fake = fakeExeDev();
    const before = process.env.QDS_EXEDEV_IMAGE;
    const envOnly = "ghcr.io/someone-else/not-ours:v9";
    try {
      process.env.QDS_EXEDEV_IMAGE = envOnly;

      const direct = new ExeDevDriver({ run: fake.run, image: PINNED });
      await direct.create("df210-env-direct");
      expect(direct.image).toBe(PINNED);
      expect(newArgv(fake)).toContain(PINNED);
      expect(newArgv(fake)).not.toContain(envOnly);

      // …and the registry factory — the ONE place that may read env — honours it.
      const fromEnv = exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: envOnly }, { run: fake.run });
      expect(fromEnv.image).toBe(envOnly);
      const fromRealEnv = exeDevDriverFromEnv(process.env, { run: fake.run });
      expect(fromRealEnv.image).toBe(envOnly);
      // With no override, the factory falls back to the module-level pin — the
      // registry constructs the driver with no options, so a default living
      // only on the options interface would never be set in production.
      expect(exeDevDriverFromEnv({}, { run: fake.run }).image).toBe(DEFAULT_IMAGE_REF);
    } finally {
      // Reflect.deleteProperty, not `= undefined`: assigning undefined to a
      // process.env key stores the STRING "undefined", which would leave this
      // suite's override in place for every test that runs after it.
      if (before === undefined) Reflect.deleteProperty(process.env, "QDS_EXEDEV_IMAGE");
      else process.env.QDS_EXEDEV_IMAGE = before;
      fake.cleanup();
    }
  });

  test("the default driver pins the module-level constant, unconditionally", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run });
      expect(driver.image).toBe(DEFAULT_IMAGE_REF);
      expect(driver.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      await driver.create("df210-default-1");
      expect(fake.creates[0]?.image).toBe(DEFAULT_IMAGE_REF);
    } finally {
      fake.cleanup();
    }
  });
});

// ─── AC4 / INV-IBOX-3: the registry credential ──────────────────────────────

describe("DF2.10 AC4 — the registry credential is a separate class", () => {
  /** Distinctive enough that any substring leak is unmistakable. */
  const CANARY_SECRET = "ghp-LEAKCANARY-0000-DF210";
  const VALID_AUTH = `qdsbot:${CANARY_SECRET}`;

  test("malformed credentials are refused in the CONSTRUCTOR, before any command", () => {
    const fake = fakeExeDev();
    try {
      const refused: Array<[string, string]> = [
        ["no ':' separator", "qdsbotghpsomething"],
        ["empty password", "qdsbot:"],
        ["whitespace in password", "qdsbot:two words"],
        ["tab in password", "qdsbot:tab\there"],
        ["control character", "qdsbot:bellhere"],
        ["shell metacharacter", "qdsbot:semi;colon"],
        ["command substitution", "qdsbot:$(id)"],
        ["username outside charset", "qds bot:password"],
        ["empty username", ":password"],
      ];
      for (const [why, value] of refused) {
        let caught: unknown;
        try {
          new ExeDevDriver({ run: fake.run, registryAuth: value });
        } catch (e) {
          caught = e;
        }
        expect(caught, why).toBeInstanceOf(ExeDevDriverError);
        expect((caught as ExeDevDriverError).code, why).toBe("registry-auth-invalid");
      }
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("INV-IBOX-3: the refusal NAMES the field and the rule, and NEVER the value", () => {
    // The `tag-invalid` precedent interpolates the value it rejects
    // (driver.ts's tag check). On a credential that interpolation IS the leak:
    // the message travels into logs, into an operator's terminal, and into
    // whatever captured the exception.
    const secret = "SUPERSECRET-PAT-VALUE-DO-NOT-ECHO";
    for (const value of [`qdsbot:${secret};`, `qdsbot:${secret} x`, `qdsbot ${secret}`, `qdsbot:${secret}$(x)`]) {
      let caught: ExeDevDriverError | undefined;
      try {
        assertRegistryAuth(value);
      } catch (e) {
        caught = e as ExeDevDriverError;
      }
      expect(caught).toBeInstanceOf(ExeDevDriverError);
      expect(caught?.message.includes(secret)).toBe(false);
      expect(caught?.message.includes(value)).toBe(false);
      expect(caught?.remediation.includes(secret)).toBe(false);
      // It still has to be actionable: the field and the failed rule are named.
      expect(caught?.message).toMatch(/registryAuth/);
    }
  });

  test("valid credential: in argv (the ratified D8 deviation) — in NO log line and NO provenance field", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED, registryAuth: VALID_AUTH });
      const { lines } = await captureLog(() => driver.create("df210-auth-1"));

      // argv: the KNOWN deviation. ssh concatenates argv into a remote command
      // line, so this is visible in the host process table — which is exactly
      // why the path is default-off and requires a recorded ratification.
      expect(newArgv(fake)).toEqual([
        "ssh",
        "exe.dev",
        "new",
        "--name",
        "df210-auth-1",
        "--image",
        PINNED,
        "--registry-auth",
        VALID_AUTH,
        "--json",
      ]);
      expect(fake.creates[0]?.registryAuth).toBe(VALID_AUTH);

      // Logs and provenance: NOTHING. Not the credential, not the password
      // half, not the username-qualified form — every emitted line, every
      // field, stringified whole.
      expect(lines.length).toBeGreaterThan(0);
      const emitted = JSON.stringify(lines);
      expect(emitted.includes(VALID_AUTH)).toBe(false);
      expect(emitted.includes(CANARY_SECRET)).toBe(false);

      // The ONLY thing said about it anywhere, and it is a BOOLEAN.
      const creates = lines.filter((l) => String(l.operation).startsWith("exedev.create"));
      expect(creates.length).toBeGreaterThanOrEqual(2); // create_requested + create_shape
      for (const line of creates) {
        expect(line.registryAuthUsed).toBe(true);
        expect(line.imageRef).toBe(PINNED);
      }
      expect(creates.map((l) => l.operation)).toContain("exedev.create_requested");
      expect(creates.map((l) => l.operation)).toContain("exedev.create_shape");
    } finally {
      fake.cleanup();
    }
  });

  test("default-off: no credential ⇒ registryAuthUsed false and no `--registry-auth` in argv", async () => {
    const fake = fakeExeDev();
    try {
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED });
      const { lines } = await captureLog(() => driver.create("df210-auth-off"));
      expect(newArgv(fake)).not.toContain("--registry-auth");
      expect(fake.creates[0]?.registryAuth).toBeUndefined();
      const creates = lines.filter((l) => String(l.operation).startsWith("exedev.create"));
      expect(creates.length).toBeGreaterThan(0);
      for (const line of creates) {
        expect(line.registryAuthUsed).toBe(false);
      }
    } finally {
      fake.cleanup();
    }
  });

  test("exe.dev stderr echoing the credential is redacted before it reaches the thrown error", async () => {
    // The measured hazard: a control plane that echoes the argv it received.
    // The credential then rides res.stderr into an error message that is
    // logged, printed, and captured.
    const fake = fakeExeDev();
    try {
      const leaky: FakeCommand = async (argv, o) => {
        if (argv[0] === "ssh" && argv[1] === "exe.dev" && argv[2] === "new") {
          return {
            stdout: "",
            stderr: `exe.dev: unknown flag in: new --image ${PINNED} --registry-auth ${VALID_AUTH} --json\n`,
            exitCode: 2,
          };
        }
        return fake.run(argv, o);
      };
      const driver = new ExeDevDriver({ run: leaky, image: PINNED, registryAuth: VALID_AUTH });
      const { error, lines } = await captureLog(() => driver.create("df210-auth-leak"));

      expect(error).toBeInstanceOf(ExeDevDriverError);
      const err = error as ExeDevDriverError;
      expect(err.code).toBe("create-failed");
      expect(err.message.includes(VALID_AUTH)).toBe(false);
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      expect(err.message).toContain("[registry-auth redacted]");
      // The create_failed event carries the boolean, not the credential.
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
      const failed = lines.find((l) => l.operation === "exedev.create_failed");
      expect(failed?.registryAuthUsed).toBe(true);
      expect(failed?.status).toBe("error");
    } finally {
      fake.cleanup();
    }
  });
});

// ─── AC1c: gate B proves the marker, fail-closed, as a payload ──────────────

/**
 * DF3.1 owns the letter set and the code table; this story extends gate B's
 * MEANING and must extend neither. The type annotation is the compile-time
 * half — a sixth `AssertionItem` makes this object miss a key and `bunx tsc`
 * fails — and the key assertion is the runtime half.
 */
const EVERY_ASSERTION_ITEM: Record<AssertionItem, true> = { A: true, B: true, C: true, D: true, E: true };

describe("DF2.10 AC1c — the marker gate adds no letter and no code", () => {
  test("the AssertionItem union is still exactly A–E", () => {
    expect(Object.keys(EVERY_ASSERTION_ITEM).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(Object.keys(ASSERTION_CODE).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("the code table is still DF3.1's: A/B share 1, C=2, D=3, E=4", () => {
    expect(ASSERTION_CODE).toEqual({ A: 1, B: 1, C: 2, D: 3, E: 4 });
  });
});

describe("DF2.10 AC1c — parseImageMarker fails closed on every malformed shape", () => {
  test("unparseable, non-object and missing-field markers all refuse with image-marker-mismatch", () => {
    const bad: Array<[string, string]> = [
      ["truncated JSON", '{"imageRef": '],
      ["not JSON at all", "<html>404</html>"],
      ["a JSON array", '["not","an","object"]'],
      ["a JSON string", '"just a string"'],
      ["JSON null", "null"],
      ["missing gitSha", JSON.stringify({ imageRef: PINNED, buildId: "0".repeat(16), piVersion: "0.84.4", bunVersion: "1.3.13", builtAt: "x" })],
      ["empty buildId", JSON.stringify({ imageRef: PINNED, buildId: "", piVersion: "a", bunVersion: "b", builtAt: "c", gitSha: "d" })],
      ["numeric buildId", JSON.stringify({ imageRef: PINNED, buildId: 42, piVersion: "a", bunVersion: "b", builtAt: "c", gitSha: "d" })],
    ];
    for (const [why, text] of bad) {
      let caught: unknown;
      try {
        parseImageMarker(text);
      } catch (e) {
        caught = e;
      }
      expect(caught, why).toBeInstanceOf(ExeDevDriverError);
      expect((caught as ExeDevDriverError).code, why).toBe("image-marker-mismatch");
      expect((caught as ExeDevDriverError).remediation, why).toContain(IMAGE_MARKER_PATH);
    }
  });

  test("a well-formed marker parses to the six keys", () => {
    const marker = parseImageMarker(DEFAULT_IMAGE_MARKER);
    expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID);
    expect(Object.keys(marker).sort()).toEqual(["buildId", "builtAt", "bunVersion", "gitSha", "imageRef", "piVersion"]);
  });
});

describe("DF2.10 AC1c — gate B against the fake box (the real setupGate)", () => {
  const ROSTER = `
defaults:
  writes: []
roles:
  - name: architect
    model: openrouter/deepseek/deepseek-v4-flash-0731
    writes: []
`;

  let fake: FakeExeDev;
  let driver: ExeDevDriver;
  let tempDir: string;
  let originDir: string;
  let rosterDir: string;
  let evidenceDir: string;
  let headSha: string;

  beforeAll(async () => {
    fake = fakeExeDev();
    tempDir = mkdtempSync(join(tmpdir(), "qds-df210-marker-"));
    originDir = join(tempDir, "origin");
    rosterDir = join(tempDir, "rosters");
    evidenceDir = join(tempDir, "evidence");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(rosterDir, { recursive: true });
    // The production driver, production-shaped: an attested posture file is
    // what a real operator's driver carries (INV-1).
    driver = new ExeDevDriver({ run: fake.run, postureFile: writePostureAttestation(tempDir) });
    await runLocal(["git", "init", "-q", "-b", "main", originDir]);
    await runLocal([
      "git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test",
      "commit", "-q", "--allow-empty", "-m", "base",
    ]);
    headSha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
  });

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** create → configure the box's marker → fill; returns the gate options. */
  async function boxWithMarker(runId: string, imageMarker?: string | null) {
    await driver.create(runId);
    if (imageMarker !== undefined) fake.configure(runId, { imageMarker });
    const rosterPath = join(rosterDir, `roster-${runId}.yaml`);
    writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
    await driver.fill(runId, { runId, repoUrl: `file://${originDir}`, commitSha: headSha, workdir: "work" });
    // DF2.3 delivered the key before setup (Infra ordering) — planted host-side
    // so it never appears in the seam's argv corpus.
    writeFileSync(join(fake.homeDir(runId), "app", ".env"), "OPENROUTER_API_KEY=sk-test-0000000000000000000000\n", { mode: 0o600 });
    return {
      runId,
      rosterPath,
      commitSha: headSha,
      workdir: "work",
      envFile: "home/app/.env",
      sentinelPath: "tmp/PROVISION_READY",
      evidenceDir,
      assertTimeoutMs: 30_000,
      gateTimeoutMs: 120_000,
    };
  }

  /** A well-formed marker whose fields are overridable per case. */
  function marker(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      imageRef: DEFAULT_IMAGE_REF,
      buildId: DEFAULT_IMAGE_BUILD_ID,
      piVersion: "0.84.4",
      bunVersion: "1.3.13",
      builtAt: "2026-08-31T00:00:00.000Z",
      gitSha: "b".repeat(40),
      ...patch,
    });
  }

  test("a matching marker passes gate B and the whole gate goes ready", async () => {
    const opts = await boxWithMarker("df210-marker-ok");
    const result = await driver.setup("df210-marker-ok", opts);
    expect(result.ready).toBe(true);
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
    expect(result.assertions.find((a) => a.item === "B")?.ok).toBe(true);
    // The gate actually READ the marker — a gate that never asked would pass
    // this test for the wrong reason.
    const boxCmds = fake.calls
      .filter((a) => a[1] === "df210-marker-ok.exe.xyz")
      .flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
    expect(boxCmds.some((c) => c.includes(IMAGE_MARKER_PATH))).toBe(true);
  }, 90_000);

  test("fail-closed: absent, over-cap, unparseable, wrong-type, missing-field and mismatched all refuse", async () => {
    const cases: Array<{ id: string; markerContent: string | null; why: RegExp }> = [
      // A box that cannot state what it booted is not a factory box.
      { id: "df210-marker-absent", markerContent: null, why: /absent/i },
      // Over the read cap: refused UNPARSED — the gate never considers it.
      { id: "df210-marker-oversized", markerContent: marker({ gitSha: "c".repeat(IMAGE_MARKER_MAX_BYTES + 64) }), why: /cap|bytes/i },
      { id: "df210-marker-badjson", markerContent: '{"imageRef": "ghcr.io/x/y:z"', why: /parseable|JSON/i },
      { id: "df210-marker-wrongtype", markerContent: '["not","an","object"]', why: /JSON object/i },
      { id: "df210-marker-missing", markerContent: JSON.stringify({ imageRef: DEFAULT_IMAGE_REF, buildId: DEFAULT_IMAGE_BUILD_ID }), why: /missing or empty/i },
      { id: "df210-marker-wrongfieldtype", markerContent: marker({ buildId: 12345 }), why: /missing or empty/i },
      // The load-bearing one: well-formed, readable, and WRONG.
      { id: "df210-marker-mismatch", markerContent: marker({ buildId: "f".repeat(16) }), why: /buildId|repo pin/i },
    ];

    for (const c of cases) {
      const opts = await boxWithMarker(c.id, c.markerContent);
      const result = await driver.setup(c.id, opts);

      // DF3.1 AC3: the refusal is a PAYLOAD. Not a throw (we got here), not a
      // process exit code, and not a new letter.
      expect(result.ready, c.id).toBe(false);
      expect(result.failedItem, c.id).toBe("B");
      expect(result.assertionCode, c.id).toBe(1);
      expect(result.assertionCode, c.id).toBe(ASSERTION_CODE.B);

      const b = result.assertions.find((a) => a.item === "B");
      expect(b?.ok, c.id).toBe(false);
      expect(b?.note, c.id).toMatch(c.why);
      // Fail-closed BEFORE any spend: A ran, B refused, C/D/E never happened.
      expect(result.assertions.map((a) => a.item), c.id).toEqual(["A", "B"]);
      // INV-5: the VM is alive, and the payload carries the operator's next steps.
      expect((await driver.list(c.id)).map((v) => v.name), c.id).toEqual([c.id]);
      expect(result.teardownCommand, c.id).toContain(`rm ${c.id}`);
      expect(result.debugCommands.length, c.id).toBeGreaterThan(0);
    }
  }, 180_000);

  test("a mismatched marker refuses even when the box is otherwise perfect", async () => {
    // The negative control for AC1's own DoD line: a test that asserted only
    // "docker build && docker push exited 0" proves the image exists and
    // nothing about whether exe.dev booted it. THIS is the assertion that
    // distinguishes them — the box below passes A, has pi, has models, has
    // credit, and is still refused, purely on what it says it booted.
    const opts = await boxWithMarker("df210-marker-perfect", marker({ buildId: "0123456789abcdef" }));
    const result = await driver.setup("df210-marker-perfect", opts);
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("B");
    expect(result.assertions.find((a) => a.item === "B")?.note).toMatch(/0123456789abcdef/);
    // No chat/completions ran: the refusal came before a cent was spent.
    const boxCmds = fake.calls
      .filter((a) => a[1] === "df210-marker-perfect.exe.xyz")
      .flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
    expect(boxCmds.some((c) => c.includes("chat/completions"))).toBe(false);
  }, 90_000);

  test("the driver's imageBuildId is what gate B compares against — injectable, not hard-coded", async () => {
    // A driver pinned to a DIFFERENT build accepts a box baked with that build
    // and only that one. Hard-coding DEFAULT_IMAGE_BUILD_ID inside the gate
    // would make the tenant-mirror case (a customer's own rebuilt image)
    // unrepresentable.
    const other = "abcdef0123456789";
    const tenantDriver = new ExeDevDriver({ run: fake.run, image: MIRRORED, imageBuildId: other });
    await tenantDriver.create("df210-marker-tenant");
    fake.configure("df210-marker-tenant", { imageMarker: marker({ buildId: other, imageRef: MIRRORED }) });
    const rosterPath = join(rosterDir, "roster-df210-marker-tenant.yaml");
    writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
    await tenantDriver.fill("df210-marker-tenant", { runId: "df210-marker-tenant", repoUrl: `file://${originDir}`, commitSha: headSha, workdir: "work" });
    writeFileSync(join(fake.homeDir("df210-marker-tenant"), "app", ".env"), "OPENROUTER_API_KEY=sk-test-0000000000000000000000\n", { mode: 0o600 });

    const result = await tenantDriver.setup("df210-marker-tenant", {
      runId: "df210-marker-tenant", rosterPath, commitSha: headSha, workdir: "work",
      envFile: "home/app/.env", sentinelPath: "tmp/PROVISION_READY", evidenceDir,
      assertTimeoutMs: 30_000, gateTimeoutMs: 120_000,
    });
    expect(result.assertions.find((a) => a.item === "B")?.ok).toBe(true);
    expect(result.ready).toBe(true);

    // And the SAME box refuses the repo-pinned driver: the comparison is real.
    const strict = await driver.setup("df210-marker-tenant", {
      runId: "df210-marker-tenant", rosterPath, commitSha: headSha, workdir: "work",
      envFile: "home/app/.env", sentinelPath: "tmp/PROVISION_READY", evidenceDir,
      assertTimeoutMs: 30_000, gateTimeoutMs: 120_000,
    });
    expect(strict.ready).toBe(false);
    expect(strict.failedItem).toBe("B");
  }, 120_000);
});
