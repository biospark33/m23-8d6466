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
  assertRegistryAuthDeviation,
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
  writeRatifiedRegistryDeviation,
  type FakeBoxConfig,
  type FakeCommand,
  type FakeExeDev,
} from "./fixtures/fake-exedev.ts";
import { runLocal } from "./helpers.ts";

/** A digest-pinned reference that is NOT the sentinel — the shape we publish. */
const PINNED = `ghcr.io/biospark33/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;
/** The tenant-mirror case: a customer's own registry, same digest (D7 tier). */
const MIRRORED = `harbor.acme.internal/qds/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;

/**
 * Every control-plane `new` argv the seam carried, flattened.
 *
 * THROWS when no create reached the seam rather than returning `[]`: every
 * `expect(newArgv(fake)).not.toContain(x)` below is an ABSENCE claim, and an
 * empty array satisfies all of them at once. A driver that threw before issuing
 * the command would then read as "the flag is correctly absent".
 */
function newArgv(fake: FakeExeDev): string[] {
  const call = fake.calls.find((a) => a[0] === "ssh" && a[1] === "exe.dev" && a[2] === "new");
  if (call === undefined) {
    throw new Error("no `ssh exe.dev new` argv reached the seam — every absence assertion about it would be vacuous");
  }
  return call;
}

/**
 * Run `fn` with the log sink captured; returns every emitted line.
 *
 * RETHROWS unless the caller passes `{ expectThrow: true }`. Swallowing the
 * rejection let a caller that binds only `{ lines }` sail past a `create()`
 * that never ran: the log is then empty or partial, and every assertion after
 * it is vacuously true. A test that wants the error asks for it by name.
 */
async function captureLog<T>(
  fn: () => Promise<T>,
  opts: { expectThrow?: boolean } = {},
): Promise<{ result?: T; error?: unknown; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  // dp:ok test-only widening of the log sink's own event type so emitted
  // lines can be searched for a leaked credential; no production path.
  const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); /* dp:ok test-only widening so emitted lines can be searched for a leaked credential */
  try {
    return { result: await fn(), lines };
  } catch (error) {
    if (opts.expectThrow !== true) throw error;
    return { error, lines };
  } finally {
    restore();
  }
}

/** Capture the lines a SYNCHRONOUS thunk emits (the constructor's own emits). */
function captureLogSync<T>(fn: () => T): { result: T; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); /* dp:ok test-only widening, same reason as captureLog */
  try {
    return { result: fn(), lines };
  } finally {
    restore();
  }
}

/** Refusal helper: run `fn`, return the ExeDevDriverError it MUST have thrown. */
function refusal(fn: () => unknown, why: string): ExeDevDriverError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, why).toBeInstanceOf(ExeDevDriverError);
  return caught as ExeDevDriverError;
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
    // A TAG is not the sentinel — and this predicate deliberately does not say
    // so. It answers ONE question ("is the pin still the all-zeros
    // placeholder"), and the publish gate keys on it; a tag pin is the weaker
    // arm the constructor announces with `image_not_digest_pinned` instead.
    // Pinned because the two conditions read alike and conflating them would
    // either block a legitimate D7 tenant tag or let a sentinel through.
    expect(isUnpinnedImage("ghcr.io/biospark33/qds-exedev:latest")).toBe(false);
    // The default argument IS the shipped pin — the spelling the publish
    // workflow calls it with, which has no test above.
    expect(isUnpinnedImage()).toBe(isUnpinnedImage(DEFAULT_IMAGE_REF));
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
    //
    // A LOCAL fake, not the describe's shared one: `expect(fake.calls).toEqual([])`
    // is a claim about this test's own drivers, and on the shared fake it was a
    // claim about every test that ran before it in file order.
    const local = fakeExeDev();
    try {
      const refused: Array<[string, string]> = [
        ["bare name, no registry host", "ubuntu:22.04"],
        ["command substitution", "ghcr.io/qds/img:$(id)"],
        ["semicolon", "ghcr.io/qds/img:v1;id"],
        ["space", "ghcr.io/qds/img :v1"],
        ["newline", "ghcr.io/qds/img:v1\nid"],
        ["backtick", "ghcr.io/qds/img:`id`"],
        ["empty", ""],
        ["short digest", "ghcr.io/qds/img@sha256:abc"],
        // UPPERCASE in the PATH: the OCI rule, and the reason assertImageRef's
        // own remediation example is lowercase (a copied example must not be
        // refused by the rule it illustrates).
        ["uppercase path component", `ghcr.io/QDS/img@sha256:${"a1b2c3d4".repeat(8)}`],
        // A dotless host WITH a port (`registry:5000/…`) is legal to docker,
        // which reads the port as the disambiguator. It is refused here, and
        // the strictness is the point: "explicit registry host required" is
        // enforced as "a dotted host, or the literal localhost", so a bare
        // `registry:5000` cannot be confused with a `name:tag`. `localhost:5000`
        // is the admitted exception and is asserted ACCEPTED above.
        ["dotless host with port", "registry:5000/team/img:v1"],
      ];
      for (const [why, ref] of refused) {
        const err = refusal(() => new ExeDevDriver({ run: local.run, image: ref }), why);
        expect(err.code, why).toBe("image-invalid");
        expect(err.remediation.length, why).toBeGreaterThan(0);
      }
      // Not one command was built, for any of them.
      expect(local.calls).toEqual([]);
      expect(local.creates).toEqual([]);
    } finally {
      local.cleanup();
    }
  });

  test("the remediation is FOLLOWABLE: its own example reference is accepted", () => {
    // A remediation that names a shape the validator rejects sends an operator
    // in a circle. The example is uppercase-free for exactly this reason, so
    // the check is: substitute a real digest into the printed example and it
    // must pass the very rule that printed it.
    const example = refusal(() => assertImageRef("nope"), "remediation").remediation;
    expect(example).toContain("ghcr.io/owner/image@sha256:");
    expect(() => assertImageRef(example.slice(example.indexOf("ghcr.io")).replace("<64 hex>", "a1b2c3d4".repeat(8)))).not.toThrow();
  });

  test("imageBuildId is validated in the CONSTRUCTOR too — it is half the same pin", () => {
    const local = fakeExeDev();
    try {
      for (const [why, id] of [
        ["empty", ""],
        ["whitespace only", " "],
        ["not hex", "NOTHEXNOTHEX1234"],
        ["uppercase hex", "ABCDEF0123456789"],
        ["too short", "abcdef012345678"],
        ["too long", "abcdef01234567890"],
      ] as Array<[string, string]>) {
        expect(refusal(() => new ExeDevDriver({ run: local.run, imageBuildId: id }), why).code, why).toBe(
          "image-build-id-invalid",
        );
      }
      expect(new ExeDevDriver({ run: local.run, imageBuildId: "abcdef0123456789" }).imageBuildId).toBe("abcdef0123456789");
      expect(local.calls).toEqual([]);
    } finally {
      local.cleanup();
    }
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
    const beforeBuildId = process.env.QDS_EXEDEV_IMAGE_BUILD_ID;
    const envOnly = "ghcr.io/someone-else/not-ours:v9";
    // The env override is a PAIR (INV-IBOX-2): a reference without its buildId
    // is refused outright by the factory, so half an override cannot be used to
    // express "override the image only".
    const envBuildId = "abcdef0123456789";
    try {
      process.env.QDS_EXEDEV_IMAGE = envOnly;
      process.env.QDS_EXEDEV_IMAGE_BUILD_ID = envBuildId;

      const direct = new ExeDevDriver({ run: fake.run, image: PINNED });
      await direct.create("df210-env-direct");
      expect(direct.image).toBe(PINNED);
      expect(newArgv(fake)).toContain(PINNED);
      expect(newArgv(fake)).not.toContain(envOnly);
      expect(fake.creates).toEqual([{ name: "df210-env-direct", image: PINNED }]);

      // …and the registry factory — the ONE place that may read env — honours it.
      const fromEnv = exeDevDriverFromEnv(
        { QDS_EXEDEV_IMAGE: envOnly, QDS_EXEDEV_IMAGE_BUILD_ID: envBuildId },
        { run: fake.run },
      );
      expect(fromEnv.image).toBe(envOnly);
      expect(fromEnv.imageBuildId).toBe(envBuildId);
      const fromRealEnv = exeDevDriverFromEnv(process.env, { run: fake.run });
      expect(fromRealEnv.image).toBe(envOnly);
      expect(fromRealEnv.imageBuildId).toBe(envBuildId);
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
      if (beforeBuildId === undefined) Reflect.deleteProperty(process.env, "QDS_EXEDEV_IMAGE_BUILD_ID");
      else process.env.QDS_EXEDEV_IMAGE_BUILD_ID = beforeBuildId;
      fake.cleanup();
    }
  });

  test("the env override is BOTH-OR-NEITHER: half a pin is refused, naming the missing half", () => {
    // Half an override is not a partial override, it is a guaranteed fleet-wide
    // gate-B refusal that reads as "your image is wrong" when the fault is one
    // unset variable. Both directions, because the reverse (a buildId with no
    // reference) silently re-points what gate B compares against.
    const fake = fakeExeDev();
    try {
      const refImage = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: PINNED }, { run: fake.run }),
        "image without buildId",
      );
      expect(refImage.code).toBe("image-pin-incomplete");
      expect(refImage.message).toContain("QDS_EXEDEV_IMAGE_BUILD_ID");
      const refBuildId = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE_BUILD_ID: "abcdef0123456789" }, { run: fake.run }),
        "buildId without image",
      );
      expect(refBuildId.code).toBe("image-pin-incomplete");
      expect(refBuildId.message).toContain("QDS_EXEDEV_IMAGE");
      // An EMPTY string is "not set" on both halves — `export QDS_EXEDEV_IMAGE=`
      // is how a shell unsets in practice, and treating it as set would refuse
      // a fleet that overrode nothing.
      expect(exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: "", QDS_EXEDEV_IMAGE_BUILD_ID: "" }, { run: fake.run }).image).toBe(
        DEFAULT_IMAGE_REF,
      );
      // Whitespace is NOT empty, so it reaches the constructor's typo guard.
      expect(
        refusal(
          () => exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: PINNED, QDS_EXEDEV_IMAGE_BUILD_ID: " " }, { run: fake.run }),
          "whitespace buildId",
        ).code,
      ).toBe("image-build-id-invalid");
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("an explicit argument BEATS the environment — the caller is not overruled by a stray var", () => {
    // The reverse precedence let a leftover QDS_EXEDEV_IMAGE silently boot a
    // different image than the code asked for, and this is the seam gate B keys
    // on, so "the explicit argument lost" is an expensive surprise to debug.
    const fake = fakeExeDev();
    try {
      const driver = exeDevDriverFromEnv(
        { QDS_EXEDEV_IMAGE: "ghcr.io/someone-else/not-ours:v9", QDS_EXEDEV_IMAGE_BUILD_ID: "abcdef0123456789" },
        { run: fake.run, image: PINNED, imageBuildId: DEFAULT_IMAGE_BUILD_ID },
      );
      expect(driver.image).toBe(PINNED);
      expect(driver.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
    } finally {
      fake.cleanup();
    }
  });

  test("a TAG-pinned image is admitted and ANNOUNCED once, at the seam the override was taken", async () => {
    // A tag is legal (the D7 tenant mirror needs one) and is also the disease
    // this story treats. `imageDigest: null` on every create event is a silence
    // an operator has to notice; this line is the noise.
    const fake = fakeExeDev();
    try {
      const tagged = captureLogSync(() =>
        exeDevDriverFromEnv(
          { QDS_EXEDEV_IMAGE: "ghcr.io/biospark33/qds-exedev:latest", QDS_EXEDEV_IMAGE_BUILD_ID: "abcdef0123456789" },
          { run: fake.run },
        ),
      );
      const warned = tagged.lines.filter((l) => l.operation === "exedev.image_not_digest_pinned");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.imageRef).toBe("ghcr.io/biospark33/qds-exedev:latest");
      expect(String(warned[0]?.why)).toMatch(/mutable/i);
      // The emit is in the CONSTRUCTOR, not in create(): a digest-pinned driver
      // says nothing, and this only holds if the capture wraps construction.
      const pinned = captureLogSync(() => new ExeDevDriver({ run: fake.run, image: PINNED }));
      expect(pinned.lines.filter((l) => l.operation === "exedev.image_not_digest_pinned")).toEqual([]);
    } finally {
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
      // The whole parsed create, not `creates[0]?.image`: optional chaining on
      // an empty array reports `undefined`, which no assertion here would have
      // distinguished from "the control plane never parsed a create at all".
      expect(fake.creates).toEqual([{ name: "df210-default-1", image: DEFAULT_IMAGE_REF }]);
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

  /** Temp home for posture files and 0600 credential files. */
  let authDir: string;
  /** The posture file that RATIFIES the INV-IBOX-3 deviation (AC4's private arm). */
  let ratified: string;

  beforeAll(() => {
    authDir = mkdtempSync(join(tmpdir(), "qds-df210-auth-"));
    ratified = writeRatifiedRegistryDeviation(authDir);
  });
  afterAll(() => rmSync(authDir, { recursive: true, force: true }));

  /** Write a posture file with an arbitrary `registryAuthDeviation` shape. */
  function posture(name: string, body: unknown): string {
    const path = join(authDir, `posture-${name}.json`);
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    return path;
  }

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
        // `#` is a TRUNCATION, not an injection: ssh concatenates argv into one
        // remote command line, so everything after it — including the trailing
        // `--json` — is commented out, and the create dies as `new-unparseable`
        // pointing the operator at exe.dev's response shape instead of at their
        // password.
        ["comment character", "qdsbot:pa#ss"],
        // The length ceiling, one byte over. A credential this long is a
        // pasted-file accident, and it rides an ssh command line.
        ["password over 512 bytes", `qdsbot:${"a".repeat(513)}`],
      ];
      for (const [why, value] of refused) {
        // Constructed with the RATIFIED posture file so the shape check is what
        // refuses: with an unratified one every case would refuse for the other
        // reason and the shape rules would be untested.
        const err = refusal(
          () => new ExeDevDriver({ run: fake.run, registryAuth: value, postureFile: ratified }),
          why,
        );
        expect(err.code, why).toBe("registry-auth-invalid");
        // Not one of these refusals may echo what it rejected. The empty
        // password is skipped rather than special-cased into passing:
        // `includes("")` is true of every string, so asserting it there would
        // be a claim that no implementation could satisfy.
        const secret = value.slice(value.indexOf(":") + 1);
        if (secret.length > 0) expect(err.message.includes(secret), why).toBe(false);
      }
      // Exactly 512 bytes is ACCEPTED — the ceiling is `> 512`, and a boundary
      // that drifted to `>=` would refuse a legal credential at a length no
      // message explains.
      expect(() => assertRegistryAuth(`qdsbot:${"a".repeat(512)}`)).not.toThrow();
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("AC4: the private path is REFUSED unless the INV-IBOX-3 deviation is RATIFIED", () => {
    // A shape check says the credential is well-formed, never that anyone
    // agreed to use it. Every arm below is a record an operator might believe
    // is consent and is not; refusal is the default and only a COMPLETE record
    // is consent. Asserted against the exported function directly — no driver,
    // no box, no spend.
    const future = "2099-01-01T00:00:00.000Z";
    const garbage = join(authDir, "posture-garbage.json");
    writeFileSync(garbage, "{ not json", { mode: 0o600 });
    const refused: Array<[string, string]> = [
      ["the posture file does not exist", join(authDir, "no-such-posture.json")],
      ["the posture file is not JSON", garbage],
      ["attested, but records no deviation", posture("plain", { vmSharing: "admins-only", attestedBy: "test" })],
      ["the deviation is null", posture("null", { registryAuthDeviation: null })],
      ["the deviation is an array", posture("array", { registryAuthDeviation: [] })],
      [
        "the scope is broader than read:packages",
        posture("scope", { registryAuthDeviation: { scope: "repo", expiry: future, rotationOwner: "oncall" } }),
      ],
      [
        "the scope is not a string",
        posture("scope-type", { registryAuthDeviation: { scope: 7, expiry: future, rotationOwner: "oncall" } }),
      ],
      [
        "no expiry at all",
        posture("no-expiry", { registryAuthDeviation: { scope: "read:packages", rotationOwner: "oncall" } }),
      ],
      [
        "the expiry is not a date",
        posture("bad-expiry", { registryAuthDeviation: { scope: "read:packages", expiry: "soon", rotationOwner: "oncall" } }),
      ],
      [
        // A lapsed ratification is not a ratification: refusing costs one box
        // create, not refusing costs a PAT that expires mid-fleet.
        "the expiry has PASSED",
        posture("lapsed", {
          registryAuthDeviation: { scope: "read:packages", expiry: "2020-01-01T00:00:00.000Z", rotationOwner: "oncall" },
        }),
      ],
      [
        "the rotation owner is blank",
        posture("blank-owner", { registryAuthDeviation: { scope: "read:packages", expiry: future, rotationOwner: "  " } }),
      ],
      [
        "no rotation owner at all",
        posture("no-owner", { registryAuthDeviation: { scope: "read:packages", expiry: future } }),
      ],
    ];

    for (const [why, path] of refused) {
      const err = refusal(() => assertRegistryAuthDeviation(path), why);
      expect(err.code, why).toBe("registry-auth-unratified");
      // Actionable: it names the file to fix and the shape to write there.
      expect(err.message, why).toContain(path);
      expect(err.remediation, why).toContain("registryAuthDeviation");
      // The gate never SEES the credential, and this pins that it stays that
      // way — a future arm that took the credential to explain itself would
      // put a PAT into the message that refuses it.
      expect(err.message.includes(CANARY_SECRET), why).toBe(false);
      expect(err.remediation.includes(CANARY_SECRET), why).toBe(false);
    }

    // The complete record is the ONLY thing that passes.
    expect(() => assertRegistryAuthDeviation(ratified)).not.toThrow();

    // …and it is the same gate the constructor runs, at the same trust boundary.
    const fake = fakeExeDev();
    try {
      const err = refusal(
        () => new ExeDevDriver({ run: fake.run, registryAuth: VALID_AUTH, postureFile: join(authDir, "no-such-posture.json") }),
        "constructor",
      );
      expect(err.code).toBe("registry-auth-unratified");
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      // Default-off means the gate does not fire for the public path.
      expect(() => new ExeDevDriver({ run: fake.run, postureFile: join(authDir, "no-such-posture.json") })).not.toThrow();
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("QDS_EXEDEV_REGISTRY_AUTH_FILE: the 0600 is ASSERTED, not assumed", () => {
    // The whole security property the path-not-value indirection buys is "the
    // secret lives in a file only this operator can read". An unchecked claim
    // of it is worth nothing, so a group- or world-readable file is refused
    // before the read rather than described in a remediation and trusted.
    const fake = fakeExeDev();
    try {
      const loose = join(authDir, "auth-0644");
      writeFileSync(loose, `${VALID_AUTH}\n`, { mode: 0o644 });
      const err = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: loose }, { run: fake.run, postureFile: ratified }),
        "0644",
      );
      expect(err.code).toBe("registry-auth-file-mode");
      expect(err.message).toContain("0644"); // the octal mode, named
      expect(err.message.includes(CANARY_SECRET)).toBe(false);

      const missing = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: join(authDir, "no-such-auth") }, { run: fake.run }),
        "absent",
      );
      expect(missing.code).toBe("registry-auth-unreadable");

      // A 0600 file LOADS — and the trailing newline every editor writes is
      // trimmed off rather than travelling into argv.
      const tight = join(authDir, "auth-0600");
      writeFileSync(tight, `${VALID_AUTH}\n`, { mode: 0o600 });
      expect(() =>
        exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: tight }, { run: fake.run, postureFile: ratified }),
      ).not.toThrow();
      // …and the ratification gate still applies to the file-loaded credential:
      // the indirection is not a way around the recorded deviation.
      expect(
        refusal(
          () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: tight }, { run: fake.run, postureFile: join(authDir, "no-such-posture.json") }),
          "file-loaded, unratified",
        ).code,
      ).toBe("registry-auth-unratified");
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
      // `remediation` is a STRING (src/providers/errors.ts:22), so `.includes`
      // here is substring containment, not array element-equality. Asserted on
      // the serialized error as well, so the claim survives the field becoming
      // a list of steps.
      expect(caught?.remediation.includes(secret)).toBe(false);
      expect(JSON.stringify({ message: caught?.message, remediation: caught?.remediation }).includes(secret)).toBe(false);
      // It still has to be actionable: the field and the failed rule are named.
      expect(caught?.message).toMatch(/registryAuth/);
    }
  });

  test("valid credential: in argv (the ratified D8 deviation) — in NO log line and NO provenance field", async () => {
    const fake = fakeExeDev();
    try {
      // The ratified posture file is what makes this the AC's private arm and
      // not a driver that took the deviation nobody recorded — the title says
      // "ratified", and until this landed the test constructed with no
      // attestation at all and asserted success.
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED, registryAuth: VALID_AUTH, postureFile: ratified });
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
      // The whole parsed create: `creates[0]?.registryAuth` reports `undefined`
      // when NO create happened, which is exactly the case this array was added
      // to catch.
      expect(fake.creates).toEqual([{ name: "df210-auth-1", image: PINNED, registryAuth: VALID_AUTH }]);

      // Logs and provenance: NOTHING. Not the credential, not the password
      // half, not the username-qualified form — every emitted line, every
      // field, stringified whole.
      expect(lines.length).toBeGreaterThan(0);
      const emitted = JSON.stringify(lines);
      expect(emitted.includes(VALID_AUTH)).toBe(false);
      expect(emitted.includes(CANARY_SECRET)).toBe(false);

      // The ONLY thing said about it anywhere, and it is a BOOLEAN — beside the
      // full image provenance set, which every create event carries.
      const creates = lines.filter((l) => String(l.operation).startsWith("exedev.create"));
      expect(creates.length).toBeGreaterThanOrEqual(2); // create_requested + create_shape
      for (const line of creates) {
        expect(line.registryAuthUsed).toBe(true);
        expect(line.imageRef).toBe(PINNED);
        expect(line.imageDigest).toBe(imageDigestOf(PINNED));
        expect(line.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      }
      // A field an event never evaluates reports 0, never a fabricated number:
      // `create_requested` is emitted before the substrate has been asked.
      expect(lines.find((l) => l.operation === "exedev.create_requested")?.create_ms).toBe(0);
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
      // The full argv, not only the absence: `newArgv` now refuses to report an
      // empty array, but a positive shape is what proves the flag is missing
      // from a create that OTHERWISE happened exactly as specified.
      expect(newArgv(fake)).toEqual(["ssh", "exe.dev", "new", "--name", "df210-auth-off", "--image", PINNED, "--json"]);
      expect(fake.creates).toEqual([{ name: "df210-auth-off", image: PINNED }]);
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
      const driver = new ExeDevDriver({ run: leaky, image: PINNED, registryAuth: VALID_AUTH, postureFile: ratified });
      const { error, lines } = await captureLog(() => driver.create("df210-auth-leak"), { expectThrow: true });

      expect(error).toBeInstanceOf(ExeDevDriverError);
      const err = error as ExeDevDriverError;
      expect(err.code).toBe("create-failed");
      expect(err.message.includes(VALID_AUTH)).toBe(false);
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      expect(err.message).toContain("[registry-auth redacted]");
      // The create_failed event carries the boolean, not the credential — and
      // the same image provenance every other create event carries, so a boot
      // regression is attributable from the FAILURE line too.
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
      const failed = lines.find((l) => l.operation === "exedev.create_failed");
      expect(failed?.registryAuthUsed).toBe(true);
      expect(failed?.status).toBe("error");
      expect(failed?.imageRef).toBe(PINNED);
      expect(failed?.imageDigest).toBe(imageDigestOf(PINNED));
      expect(failed?.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
    } finally {
      fake.cleanup();
    }
  });

  test("stderr echoing ONLY the password half is redacted too", async () => {
    // The existing leak test uses the full `USERNAME:PASSWORD` spelling. A
    // control plane that renders the pair quoted, wraps it across a line, or
    // logs only the secret defeats an exact-pair match — and the failure mode
    // of that miss is a credential in a log.
    const fake = fakeExeDev();
    try {
      const leaky: FakeCommand = async (argv, o) =>
        argv[0] === "ssh" && argv[1] === "exe.dev" && argv[2] === "new"
          ? { stdout: "", stderr: `exe.dev: auth rejected for token ${CANARY_SECRET}\n`, exitCode: 2 }
          : fake.run(argv, o);
      const driver = new ExeDevDriver({ run: leaky, image: PINNED, registryAuth: VALID_AUTH, postureFile: ratified });
      const { error, lines } = await captureLog(() => driver.create("df210-auth-half"), { expectThrow: true });
      const err = error as ExeDevDriverError;
      expect(err.code).toBe("create-failed");
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      expect(err.message).toContain("[registry-auth redacted]");
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("a REJECTING substrate call is scrubbed too — the spawn error is not a log-safe string", async () => {
    // A non-zero exit is the measured shape; a spawn that REJECTS is the other
    // one, and its message is whatever the runner built — here, the argv it was
    // trying to run, credential included. Unwrapped, that rejection escapes the
    // driver's own error contract with the secret in it.
    const fake = fakeExeDev();
    try {
      const rejecting: FakeCommand = async (argv, o) => {
        if (argv[0] === "ssh" && argv[1] === "exe.dev" && argv[2] === "new") {
          throw new Error(`spawn ssh new --registry-auth ${VALID_AUTH} failed`);
        }
        return fake.run(argv, o);
      };
      const driver = new ExeDevDriver({ run: rejecting, image: PINNED, registryAuth: VALID_AUTH, postureFile: ratified });
      const { error, lines } = await captureLog(() => driver.create("df210-auth-reject"), { expectThrow: true });

      expect(error).toBeInstanceOf(ExeDevDriverError);
      const err = error as ExeDevDriverError;
      expect(err.code).toBe("create-failed");
      expect(err.message.includes(VALID_AUTH)).toBe(false);
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      expect(err.message).toContain("[registry-auth redacted]");
      // The failure is still OBSERVED — a rejection that produced no event
      // would leave the run record with a create that simply never happened.
      const failed = lines.find((l) => l.operation === "exedev.create_failed");
      expect(failed?.status).toBe("error");
      expect(failed?.registryAuthUsed).toBe(true);
      // No exit code exists on a call that never ran: reported as null, never
      // as a fabricated 1.
      expect(failed?.exitCode).toBeNull();
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
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
    // Created like its two siblings: the gate is handed this path and writes
    // evidence into it, and an absent directory is a failure mode that has
    // nothing to do with the marker under test.
    mkdirSync(evidenceDir, { recursive: true });
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

  /** create → configure the box's marker (and its read behaviour) → fill. */
  async function boxWithMarker(runId: string, patch?: Partial<FakeBoxConfig>) {
    await driver.create(runId);
    if (patch !== undefined) fake.configure(runId, patch);
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

  /**
   * A well-formed marker whose fields are overridable per case.
   *
   * DERIVED from the fixture's own default rather than re-typed: the fixture
   * imports `piVersion`/`bunVersion` from where the build stamps them, and a
   * second hand-written copy here would drift from it silently.
   */
  function marker(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...(JSON.parse(DEFAULT_IMAGE_MARKER) as Record<string, unknown>), ...patch });
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

  test("fail-closed: absent, unreadable, over-cap, unparseable, wrong-type, missing-field and mismatched all refuse", async () => {
    // Each `why` is anchored to ITS OWN arm's sentence. The regexes used to be
    // supersets of one another (`/parseable|JSON/i`, `/cap|bytes/i`), so an
    // implementation that collapsed all seven arms into one generic note passed
    // the whole table — which is the opposite of what a table of distinct
    // refusals is for.
    const cases: Array<{ id: string; box: Partial<FakeBoxConfig>; why: RegExp }> = [
      // A box that cannot state what it booted is not a factory box.
      { id: "df210-marker-absent", box: { imageMarker: null }, why: /is absent — this box did not boot a factory image/ },
      // Present at `test -f`, nonzero at `cat`: a foreign image can ship a
      // root-only 0600 marker, and that is a DIFFERENT finding from absence.
      // Unreachable until the fake grew independent exits for the two commands.
      {
        id: "df210-marker-unreadable",
        box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 1 },
        why: /could not be read \(exit 1\)/,
      },
      // Over the transport read cap: the capture is a PREFIX, refused UNPARSED
      // so a half-written marker cannot parse as a whole one.
      { id: "df210-marker-truncated", box: { imageMarkerTruncated: true }, why: /exceeds the transport read cap — refused unparsed/ },
      // Over the marker's own byte cap, counted in BYTES to match the producer.
      {
        id: "df210-marker-oversized",
        box: { imageMarker: marker({ gitSha: "c".repeat(IMAGE_MARKER_MAX_BYTES + 64) }) },
        why: new RegExp(`is \\d+ bytes, at or over the ${IMAGE_MARKER_MAX_BYTES}-byte cap`),
      },
      { id: "df210-marker-badjson", box: { imageMarker: '{"imageRef": "ghcr.io/x/y:z"' }, why: /is not parseable JSON:/ },
      { id: "df210-marker-wrongtype", box: { imageMarker: '["not","an","object"]' }, why: /is not a JSON object/ },
      {
        id: "df210-marker-missing",
        box: { imageMarker: JSON.stringify({ imageRef: DEFAULT_IMAGE_REF, buildId: DEFAULT_IMAGE_BUILD_ID }) },
        why: /is missing or empty for: piVersion, bunVersion, builtAt, gitSha/,
      },
      { id: "df210-marker-wrongfieldtype", box: { imageMarker: marker({ buildId: 12345 }) }, why: /is missing or empty for: buildId/ },
      // The load-bearing one: well-formed, readable, and WRONG.
      {
        id: "df210-marker-mismatch",
        box: { imageMarker: marker({ buildId: "f".repeat(16) }) },
        why: new RegExp(`buildId "f{16}" != the repo pin "${DEFAULT_IMAGE_BUILD_ID}"`),
      },
    ];

    for (const c of cases) {
      const opts = await boxWithMarker(c.id, c.box);
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
      // AC1c: the refusal is machine-CLASSIFIABLE, not an English string under
      // a generic assertion code. Every arm here is a finding ABOUT THE IMAGE,
      // so every one of them is `image-marker-mismatch` — the transport-fault
      // code is a different test, and that separation is the point.
      expect(result.error?.code, c.id).toBe("image-marker-mismatch");
      expect(result.error?.message, c.id).toBe(b?.note);
      expect(result.error?.remediation, c.id).toContain(IMAGE_MARKER_PATH);
      // Fail-closed BEFORE any spend: A ran, B refused, C/D/E never happened.
      expect(result.assertions.map((a) => a.item), c.id).toEqual(["A", "B"]);
      // INV-5: the VM is alive, and the payload carries the operator's next steps.
      expect((await driver.list(c.id)).map((v) => v.name), c.id).toEqual([c.id]);
      expect(result.teardownCommand, c.id).toContain(`rm ${c.id}`);
      expect(result.debugCommands.length, c.id).toBeGreaterThan(0);
      // The operator can READ the thing that refused them.
      expect(result.debugCommands.some((d) => d.includes(IMAGE_MARKER_PATH)), c.id).toBe(true);
    }
    // Nine create→fill→gate cycles at ~20 s each. The old 180 s was a budget
    // for seven while each single-case sibling got 90 s alone, so a busy
    // machine aborted the loop mid-way and the LAST case — the load-bearing
    // "well-formed and WRONG" mismatch — was the one that never ran.
  }, 600_000);

  test("D1/D2 regression: a box that never ANSWERED is a transport fault, not a finding about the image", async () => {
    // `test -f` and `cat` both exit non-zero when ssh could not connect (255) or
    // the exec budget SIGKILLed the command (137), and neither says anything
    // about what the box booted. Still fail-CLOSED — the box is refused either
    // way — but refused for the RIGHT reason, so the operator checks the
    // network instead of auditing the image pin.
    const cases: Array<{ id: string; box: Partial<FakeBoxConfig>; why: RegExp }> = [
      // ssh never connected: the presence probe itself answers 255.
      { id: "df210-marker-ssh255", box: { imageMarkerProbeExit: 255 }, why: /exit 255 — ssh connection failed or dropped mid-flight/ },
      // The probe answered, the read was SIGKILLed at the budget.
      { id: "df210-marker-kill137", box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 137 }, why: /exit 137 — SIGKILLed at the exec budget/ },
    ];
    for (const c of cases) {
      const opts = await boxWithMarker(c.id, c.box);
      const result = await driver.setup(c.id, opts);
      expect(result.ready, c.id).toBe(false);
      expect(result.failedItem, c.id).toBe("B");
      expect(result.assertionCode, c.id).toBe(ASSERTION_CODE.B);
      expect(result.error?.code, c.id).toBe("image-marker-unreachable");
      expect(result.error?.message, c.id).toMatch(c.why);
      // The distinction IS the finding: never the absence sentence, and never
      // an accusation about the image.
      expect(result.error?.message, c.id).toContain("NOT evidence about the image this box booted");
      expect(result.error?.message, c.id).not.toMatch(/did not boot a factory image/);
      expect(result.error?.remediation, c.id).toMatch(/confirm the box answers at all/);
      expect(result.assertions.map((a) => a.item), c.id).toEqual(["A", "B"]);
    }
  }, 180_000);

  test("a mismatched marker refuses even when the box is otherwise perfect", async () => {
    // The negative control for AC1's own DoD line: a test that asserted only
    // "docker build && docker push exited 0" proves the image exists and
    // nothing about whether exe.dev booted it. THIS is the assertion that
    // distinguishes them — the box below passes A, has pi, has models, has
    // credit, and is still refused, purely on what it says it booted.
    const opts = await boxWithMarker("df210-marker-perfect", { imageMarker: marker({ buildId: "0123456789abcdef" }) });
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

  test("gate B does NOT compare imageRef: a mismatched ref with the right buildId PASSES", async () => {
    // Triage Q-4, made executable. `marker.imageRef` is REPORTED and never
    // compared, deliberately: a D7 tenant mirror (`crane copy` into
    // ECR/Harbor/ACR) pulls the SAME bytes under its OWN reference, so it keeps
    // the digest and the buildId and loses the ref. Comparing it would refuse a
    // legitimate mirror. Nothing recorded the decision, so a future reviewer
    // could "fix" the missing comparison and break the enterprise tier silently
    // — this test is what turns that into a red suite and a conversation.
    const opts = await boxWithMarker("df210-marker-refonly", {
      imageMarker: marker({ imageRef: "harbor.acme.internal/mirror/qds-exedev:tenant-copy" }),
    });
    const result = await driver.setup("df210-marker-refonly", opts);
    expect(result.assertions.find((a) => a.item === "B")?.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.error).toBeUndefined();
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
