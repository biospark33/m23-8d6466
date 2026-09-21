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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  imageMarkerFailure,
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
const PINNED = `ghcr.io/quantum-digital-solutions/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;
/** The tenant-mirror case: a customer's own registry, same digest (D7 tier). */
const MIRRORED = `harbor.acme.internal/qds/qds-exedev@sha256:${"a1b2c3d4".repeat(8)}`;

/**
 * Every control-plane `new` argv the seam carried, flattened.
 *
 * THROWS when no create reached the seam rather than returning `[]`: every
 * `expect(newArgv(fake)).not.toContain(x)` below is an ABSENCE claim, and an
 * empty array satisfies all of them at once. A driver that threw before issuing
 * the command would then read as "the flag is correctly absent".
 *
 * THROWS on more than one, too. `find` returns SOME create, not "the create
 * this test made": every caller today drives exactly one create against its own
 * fake, but a future test that creates twice on a shared fake would silently
 * assert against the wrong argv — the same class of soft failure the empty case
 * above was written to eliminate.
 */
function newArgv(fake: FakeExeDev): string[] {
  const calls = fake.calls.filter((a) => a[0] === "ssh" && a[1] === "exe.dev" && a[2] === "new");
  if (calls.length === 0) {
    throw new Error("no `ssh exe.dev new` argv reached the seam — every absence assertion about it would be vacuous");
  }
  if (calls.length > 1) {
    throw new Error(
      `${calls.length} \`ssh exe.dev new\` argvs reached this fake — newArgv() cannot say which one the caller meant; give the test its own fake or assert on fake.creates`,
    );
  }
  return calls[0] as string[];
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

/**
 * Refusal helper: run `fn`, return the ExeDevDriverError it MUST have thrown.
 *
 * SYNCHRONOUS thunks only, enforced at runtime rather than in the type. `() =>
 * void` would not help — TypeScript's void-return rule accepts a thunk
 * returning anything, promises included. An async thunk leaves `caught`
 * undefined, so the assertion below reports "expected undefined to be an
 * instance of ExeDevDriverError" instead of the real reason, AND its rejection
 * escapes as an unhandled promise rejection that can fail an unrelated later
 * test. Named here instead.
 */
function refusal(fn: () => unknown, why: string): ExeDevDriverError {
  let caught: unknown;
  let returned: unknown;
  try {
    returned = fn();
  } catch (e) {
    caught = e;
  }
  if (returned instanceof Promise) {
    returned.catch(() => {}); // the rejection is this helper's to swallow, not a later test's
    throw new Error(`refusal(${why}) was handed an ASYNC thunk — it asserts synchronous refusals only`);
  }
  expect(caught, why).toBeInstanceOf(ExeDevDriverError);
  return caught as ExeDevDriverError;
}

// ─── AC1 / DoD: the pin is real ─────────────────────────────────────────────

describe("DF2.10 AC1 — the shipped pin", () => {
  test("DoD negative control: the shipped DEFAULT_IMAGE_REF is NOT the unpinned sentinel", () => {
    // This test IS the merge gate: a story that ships `--image` pointing at an
    // all-zeros digest has threaded a flag at an image that does not exist, and
    // every box create would fail at the substrate. It was RED BY DESIGN until
    // `.github/workflows/publish-exedev-image.yml` published the image and
    // wrote the real digest into driver.ts — that day has come (both halves
    // below are real, non-sentinel pins), so the control is green on substance
    // now and its remaining job is to stay red if the pin ever regresses to a
    // sentinel. Never skip, never `todo`, never weaken.
    expect(isUnpinnedImage(DEFAULT_IMAGE_REF)).toBe(false);
    // …and the OTHER half of the pin, which is the half gate B actually keys
    // on. `isUnpinnedImage` covers the reference; nothing covered the buildId,
    // so shipping `DEFAULT_IMAGE_BUILD_ID = "0".repeat(16)` — a shape this very
    // file treats as a plausible buildId in the parse table below — left the
    // whole suite GREEN (every gate-B test derives its expected buildId from
    // that same constant) while every real box failed gate B with
    // `image-marker-mismatch`. That is precisely the "the pin is not real yet"
    // failure the DoD control above exists to catch, on the half it could not
    // see. INV-IBOX-2: the reference and its buildId are ONE pin, so the merge
    // gate is one gate over both.
    expect(DEFAULT_IMAGE_BUILD_ID).not.toMatch(/^0{16}$/);
  });

  test("the shipped reference is a well-formed digest pin and its digest is readable", () => {
    expect(() => assertImageRef(DEFAULT_IMAGE_REF)).not.toThrow();
    expect(imageDigestOf(DEFAULT_IMAGE_REF)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // AC1b: a tag pin is the honest weaker arm, and it reports `null` rather
    // than inventing a digest no reference carries.
    expect(imageDigestOf("ghcr.io/quantum-digital-solutions/qds-exedev:v1")).toBeNull();
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
    expect(isUnpinnedImage("ghcr.io/quantum-digital-solutions/qds-exedev:latest")).toBe(false);
    // The default argument's VERDICT. (The publish workflow does NOT call this
    // predicate — it re-implements the sentinel check in bash — so this pins
    // only the TS spelling other tests and callers use.) The agreement form
    // `isUnpinnedImage() === isUnpinnedImage(DEFAULT_IMAGE_REF)` used to sit
    // above this line and was strictly weaker: the only world where it fails is
    // one where the default IS the sentinel, and then the line below fails one
    // statement later anyway. Every other drift it claimed to guard — a default
    // pointing at a DIFFERENT non-sentinel digest — leaves both sides `false`
    // and the assertion green. There is no observable that distinguishes the
    // default parameter from the constant, so the flat verdict is the honest
    // claim and the only one kept.
    expect(isUnpinnedImage()).toBe(false);
    // A suffix match would call this legal TAG the sentinel: 64 zeros in the
    // tag position are not a digest at all. The predicate parses the digest.
    expect(isUnpinnedImage(`ghcr.io/qds/img:build-${"0".repeat(64)}`)).toBe(false);
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
      "ghcr.io/quantum-digital-solutions/qds-exedev:v1.2.3",
      "registry.example.com:5000/team/img:latest",
      "localhost:5000/dev/img:scratch",
    ]) {
      expect(() => assertImageRef(ref)).not.toThrow();
      expect(new ExeDevDriver({ run: fake.run, image: ref }).image).toBe(ref);
    }
  });

  test("the refusal happens in the CONSTRUCTOR, before any command runs", () => {
    // THE claim, and `refusal()` is what carries it: these tests never call
    // create(), so a throw AT ALL is a throw at construction — an implementation
    // that deferred validation into create() would leave `refusal()` with
    // nothing caught and fail on `toBeInstanceOf`. ssh CONCATENATES argv into a
    // remote command line, so "it threw afterwards" is not a defence.
    //
    // The empty call log below is therefore NOT the timing proof (an earlier
    // comment here claimed it was, backwards: `local.calls` is empty for every
    // implementation that never reaches create(), including one that validates
    // nowhere). It is a narrower tripwire, kept for the one thing it can catch —
    // a CONSTRUCTOR that grew a substrate call of its own (a registry pre-flight,
    // an `ssh exe.dev whoami` probe) on the refusal path.
    //
    // A LOCAL fake, not the describe's shared one: `expect(local.calls).toEqual([])`
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
        // The SUBSTANTIVE thing, not `.length > 0` — a one-character
        // remediation (".") satisfied that, and this file holds every other
        // remediation to a real standard (`toContain("registryAuthDeviation")`,
        // `toContain(IMAGE_MARKER_PATH)`, the whole "the remediation is
        // FOLLOWABLE" test). The template asserted here is the one that test
        // then proves is actually accepted by the validator that printed it.
        expect(err.remediation, why).toMatch(/ghcr\.io\/\S+@sha256:<64 hex>/);
      }
      // Not one command was built, for any of them (see the tripwire note above
      // — this is a claim about the CONSTRUCTOR's own reticence, not the timing
      // proof, which `refusal()` already made).
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
    // Extracted by the template's own shape, not slice-to-end: a slice from the
    // first "ghcr.io" to the end drags any trailing prose (a closing period, a
    // second sentence) into the "example", failing a perfectly followable
    // remediation for a structural rule the title never stated.
    const template = /ghcr\.io\/\S+@sha256:<64 hex>/.exec(example);
    expect(template, "remediation no longer carries a ghcr.io/...@sha256:<64 hex> example").not.toBeNull();
    expect(() => assertImageRef((template?.[0] ?? "").replace("<64 hex>", "a1b2c3d4".repeat(8)))).not.toThrow();
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
      // INSIDE the try: this assertion sat between `fakeExeDev()` and the
      // `try`, so firing it skipped the `finally` — leaking the fake's temp
      // state (and the two env vars, on the arms that set them) for the rest of
      // the run. Every sibling in this describe constructs its fake immediately
      // before the try with nothing in between.
      //
      // Distinct from the default by ASSERTION, not by luck: if a rebuild ever
      // stamps this very value as DEFAULT_IMAGE_BUILD_ID, every env-vs-default
      // assertion below stops being able to tell which side won.
      expect(envBuildId).not.toBe(DEFAULT_IMAGE_BUILD_ID);
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
      // The check runs on the EFFECTIVE halves, same precedence as the merge:
      // a caller COMPLETING an env half through opts is a whole pin, not a
      // refusal…
      expect(
        exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: PINNED }, { run: fake.run, imageBuildId: "abcdef0123456789" })
          .imageBuildId,
      ).toBe("abcdef0123456789");
      // …and a caller SPLITTING the pair through opts alone is exactly the
      // half-pin the guard exists to stop, env clean or not.
      expect(
        refusal(() => exeDevDriverFromEnv({}, { run: fake.run, image: PINNED }), "opts image without buildId").code,
      ).toBe("image-pin-incomplete");
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("the both-or-neither guard is the FACTORY's: a direct `new` may split the pair, and ANNOUNCES it", () => {
    // The asymmetry is DELIBERATE — driver.ts's own guard comment states it
    // ("this guards the factory only; direct `new ExeDevDriver({ image })`
    // remains legal as the documented test seam") — and roughly a dozen tests
    // in this file rely on it, constructing `{ image: PINNED }` with no buildId
    // and asserting success. Nothing pinned the asymmetry itself, so it read as
    // an oversight a future reviewer would "fix" (turning a dozen tests red for
    // a reason none of them state) or as a hole nobody had noticed. Pinned in
    // BOTH directions, together with the thing that makes the seam survivable:
    // a split pin is not SILENT. The consequence of taking it — booting one
    // image while judging the box against the OTHER half's buildId — is proven
    // at gate B by "a SPLIT pin boots one image…" below.
    const fake = fakeExeDev();
    try {
      expect(
        refusal(() => exeDevDriverFromEnv({}, { run: fake.run, image: PINNED }), "factory, split pin").code,
      ).toBe("image-pin-incomplete");

      const split = captureLogSync(() => new ExeDevDriver({ run: fake.run, image: PINNED }));
      expect(split.result.image).toBe(PINNED);
      expect(split.result.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      const announced = split.lines.filter((l) => l.operation === "exedev.image_override");
      expect(announced).toHaveLength(1);
      expect(announced[0]?.imageRef).toBe(PINNED);
      // The half that did NOT move is in the line too: an announcement that
      // named only the reference would leave the reader unable to see that the
      // pair is split, which is the whole finding.
      expect(announced[0]?.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      expect(String(announced[0]?.why)).toMatch(/gate B proves the box against THIS pair/);

      // …and the repo-pinned driver says NOTHING, or the announcement would be
      // noise on every box and an operator would stop reading it.
      const repoPinned = captureLogSync(() => new ExeDevDriver({ run: fake.run }));
      expect(repoPinned.lines.filter((l) => l.operation === "exedev.image_override")).toEqual([]);
      // Either half is enough to fire it — the buildId-only split is the
      // direction the factory cannot see at all.
      const buildIdOnly = captureLogSync(() => new ExeDevDriver({ run: fake.run, imageBuildId: "abcdef0123456789" }));
      expect(buildIdOnly.lines.filter((l) => l.operation === "exedev.image_override")).toHaveLength(1);
    } finally {
      fake.cleanup();
    }
  });

  test("a FACTORY refusal emits — the seam where the first box of a fanout dies is no longer silent", () => {
    // `src/providers/index.ts:138` registers `exeDevDriverFromEnv` as the
    // exedev factory and `resolveDriver` wraps only the RETURNED driver in
    // `instrument()`. So a throw from the factory — or from `new ExeDevDriver`
    // beneath it — happened when no driver existed to call `this.emit` on and
    // no instrumentation was in place: ZERO log lines, and an operator saw a
    // fanout stop on a bare exception with no `exedev.*` line to join it to.
    // That is the identical hole `create()`'s per-create re-assertion closes
    // one layer down, left open at the layer where the FIRST box dies.
    const fake = fakeExeDev();
    try {
      const half = captureLogSync(() => {
        expect(() => exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: PINNED }, { run: fake.run })).toThrow();
      });
      const failed = half.lines.filter((l) => l.operation === "exedev.driver_construct_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("error");
      expect((failed[0]?.error as { code?: string })?.code).toBe("image-pin-incomplete");

      // …and a CONSTRUCTOR refusal underneath the factory is observed too — it
      // is the same silence one frame down.
      const bad = captureLogSync(() => {
        expect(() =>
          exeDevDriverFromEnv(
            { QDS_EXEDEV_IMAGE: PINNED, QDS_EXEDEV_IMAGE_BUILD_ID: "nothex1234567890" },
            { run: fake.run },
          ),
        ).toThrow();
      });
      expect(
        (bad.lines.find((l) => l.operation === "exedev.driver_construct_failed")?.error as { code?: string })?.code,
      ).toBe("image-build-id-invalid");

      // A SUCCESSFUL construction says nothing, or the line is noise on every
      // resolve and an operator stops reading it.
      expect(
        captureLogSync(() => exeDevDriverFromEnv({}, { run: fake.run })).lines.filter(
          (l) => l.operation === "exedev.driver_construct_failed",
        ),
      ).toEqual([]);
      expect(fake.calls).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("the all-zeros SENTINEL as an OVERRIDE is ANNOUNCED — the merge gate only covers the repo pin", () => {
    // `isUnpinnedImage`'s docblock names two enforcement points — this file's
    // DoD control and the publish workflow — and BOTH cover only the repo pin.
    // Nothing consulted the predicate on the runtime path, so
    // `QDS_EXEDEV_IMAGE=…@sha256:000…0` sailed through: a well-formed digest by
    // construction (that is the sentinel's design), satisfying the
    // both-or-neither guard, booting with nothing but the generic override line.
    const fake = fakeExeDev();
    try {
      const sentinel = `ghcr.io/quantum-digital-solutions/qds-exedev@sha256:${"0".repeat(64)}`;
      const booted = captureLogSync(
        () => new ExeDevDriver({ run: fake.run, image: sentinel, imageBuildId: "abcdef0123456789" }),
      );
      expect(booted.result.image).toBe(sentinel);
      const said = booted.lines.filter((l) => l.operation === "exedev.image_sentinel");
      expect(said).toHaveLength(1);
      expect(said[0]?.status).toBe("error");
      expect(said[0]?.imageRef).toBe(sentinel);
      // ANNOUNCED, not refused, and that is `UNPINNED_DIGEST`'s own contract:
      // the sentinel must still CONSTRUCT, because the bootstrap publish run
      // needs exactly that run to build and push.
      const repoPinned = captureLogSync(() => new ExeDevDriver({ run: fake.run }));
      expect(repoPinned.result.image).toBe(DEFAULT_IMAGE_REF);
      expect(repoPinned.lines.filter((l) => l.operation === "exedev.image_sentinel")).toEqual([]);
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
      // The env buildId must DIFFER from the default the arg side pins, or
      // "the argument won" and "the env won" would be indistinguishable.
      expect("abcdef0123456789").not.toBe(DEFAULT_IMAGE_BUILD_ID);
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
          { QDS_EXEDEV_IMAGE: "ghcr.io/quantum-digital-solutions/qds-exedev:latest", QDS_EXEDEV_IMAGE_BUILD_ID: "abcdef0123456789" },
          { run: fake.run },
        ),
      );
      const warned = tagged.lines.filter((l) => l.operation === "exedev.image_not_digest_pinned");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.imageRef).toBe("ghcr.io/quantum-digital-solutions/qds-exedev:latest");
      expect(String(warned[0]?.why)).toMatch(/mutable/i);
      // "Once" means once per DRIVER, not once per box: a warn that moved into
      // (or was duplicated in) create() would put one line on every box create
      // — the log noise the title forbids — and construction-only capture
      // could not see it. So create, and demand silence.
      const created = await captureLog(() => tagged.result.create("df210-tag-once"));
      expect(created.lines.filter((l) => l.operation === "exedev.image_not_digest_pinned")).toEqual([]);
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
        // The BEL is spelled as an ESCAPE, not embedded raw. A raw 0x07 in a
        // source literal survives nothing: an editor normalisation, a lint
        // autofix, a copy-paste through a terminal or a patch round-trip that
        // strips it turns this arm into a legal credential, and it then fails
        // for a reason its title cannot explain.
        ["control character", "qdsbot:bell\u0007here"],
        ["shell metacharacter", "qdsbot:semi;colon"],
        // ≥ 8 bytes on every arm whose SUBJECT is the charset, or the length
        // floor would refuse them first and the rule each one names would go
        // untested. (`qdsbot:$(id)` and `qdsbot:pa#ss` were 5.)
        ["command substitution", "qdsbot:pw-$(id)-x"],
        // Distinctive canaries even where the USERNAME is what fails: with the
        // literal word "password" here, the scrub below forbade refusal
        // messages from ever saying "the password half…" — constraining
        // vocabulary, not scrubbing — while carrying zero leak signal.
        ["username outside charset", "qds bot:pw-LEAKCANARY-BADUSER"],
        ["empty username", ":pw-LEAKCANARY-EMPTYUSER"],
        // `#` is a TRUNCATION, not an injection: ssh concatenates argv into one
        // remote command line, so everything after it — including the trailing
        // `--json` — is commented out, and the create dies as `new-unparseable`
        // pointing the operator at exe.dev's response shape instead of at their
        // password.
        ["comment character", "qdsbot:pa#ssword"],
        // The length ceiling, one byte over. A credential this long is a
        // pasted-file accident, and it rides an ssh command line.
        ["password over 512 bytes", `qdsbot:${"a".repeat(513)}`],
        // The length FLOOR, one byte under. Not a strength rule — it is what
        // keeps `redactRegistryAuth` from splitting a log line on a one- or
        // two-character string and shredding the operator's diagnostic into
        // confetti. No registry PAT alphabet in use is this short.
        ["password under 8 bytes", `qdsbot:${"a".repeat(7)}`],
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
        // Not one of these refusals may echo what it rejected — in the
        // message, in the remediation (the field most tempted to "show what
        // you passed"), or anywhere in the serialized pair. The empty
        // password is skipped rather than special-cased into passing:
        // `includes("")` is true of every string, so asserting it there would
        // be a claim that no implementation could satisfy.
        const secret = value.slice(value.indexOf(":") + 1);
        if (secret.length > 0) {
          expect(err.message.includes(secret), why).toBe(false);
          expect(err.remediation.includes(secret), why).toBe(false);
          expect(JSON.stringify({ message: err.message, remediation: err.remediation }).includes(secret), why).toBe(
            false,
          );
        }
      }
      // Exactly 512 bytes is ACCEPTED — the ceiling is `> 512`, and a boundary
      // that drifted to `>=` would refuse a legal credential at a length no
      // message explains. Exercised through the CONSTRUCTOR, the same trust
      // boundary every rejection case above uses: a constructor that grew its
      // own stricter length check would refuse a legal credential while a
      // bare-function acceptance stayed green.
      expect(
        () => new ExeDevDriver({ run: fake.run, registryAuth: `qdsbot:${"a".repeat(512)}`, postureFile: ratified }),
      ).not.toThrow();
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
    // The canary rides INSIDE the malformed file: V8's JSON.parse SyntaxError
    // quotes a snippet of the input it choked on, so a refusal that relayed
    // the parse error verbatim would put these bytes into a thrown, logged
    // message. Without the canary in the input universe, the scrub assertions
    // below were constant-true — no implementation could have failed them.
    writeFileSync(garbage, `{ not json ${CANARY_SECRET}`, { mode: 0o600 });
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
        // EXCLUSIVITY, not membership (round 2): a multi-scope PAT renders as
        // a token list, and an org-admin grant with read:packages among its
        // scopes is the broader deviation the least-privilege gate refuses.
        // The canary doubles as leak input: the refusal must not echo scope.
        "the scope lists broader grants ALONGSIDE read:packages",
        posture("scope-alongside", {
          registryAuthDeviation: { scope: `repo admin:org read:packages ${CANARY_SECRET}`, expiry: future, rotationOwner: "oncall" },
        }),
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
        // Date.parse would take this in the HOST's local zone, so the same
        // record lapses hours apart on differently-configured machines — a
        // date-time must carry Z or an offset (round-2 strengthening).
        "the expiry is a timezone-less date-time",
        posture("tz-less-expiry", {
          registryAuthDeviation: { scope: "read:packages", expiry: "2099-01-01T12:00:00", rotationOwner: "oncall" },
        }),
      ],
      [
        // Date.parse reads this fine; the ISO-8601 rule the message claims is
        // what refuses it.
        "the expiry is engine-parseable but not ISO-8601",
        posture("non-iso-expiry", {
          registryAuthDeviation: { scope: "read:packages", expiry: "March 1 2099", rotationOwner: "oncall" },
        }),
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

    let canaryArms = 0;
    for (const [why, path] of refused) {
      const err = refusal(() => assertRegistryAuthDeviation(path), why);
      expect(err.code, why).toBe("registry-auth-unratified");
      // Actionable: it names the file to fix and the shape to write there.
      expect(err.message, why).toContain(path);
      expect(err.remediation, why).toContain("registryAuthDeviation");
      // The leak assertions are SCOPED to the arms whose input actually carries
      // the canary — the garbage file's bytes and the broad scope's token list.
      // On the other thirteen the canary is nowhere in the input universe, so
      // no implementation could put it in the output: they were constant-true,
      // and thirteen unfailable green assertions over-credit the scrub coverage
      // to anyone counting them. Derived from the file the arm actually reads,
      // so arming a new case is enough to cover it — no second list to update.
      const input = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (input.includes(CANARY_SECRET)) {
        canaryArms += 1;
        expect(err.message.includes(CANARY_SECRET), why).toBe(false);
        expect(err.remediation.includes(CANARY_SECRET), why).toBe(false);
      }
    }
    // …and the scoping cannot silently degrade to nothing: an edit that dropped
    // the canary out of both armed inputs would leave the loop asserting no
    // leak claim at all, which is the failure mode scoping introduces.
    expect(canaryArms, "the canary must ride at least the malformed-JSON and broad-scope inputs").toBe(2);

    // The complete record is the ONLY thing that passes — and the strict
    // expiry grammar still admits both spellings an operator would write:
    // date-only (spec'd UTC midnight) and an explicit-offset date-time.
    expect(() => assertRegistryAuthDeviation(ratified)).not.toThrow();
    expect(() =>
      assertRegistryAuthDeviation(
        posture("date-only-expiry", {
          registryAuthDeviation: { scope: "read:packages", expiry: "2099-01-01", rotationOwner: "oncall" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertRegistryAuthDeviation(
        posture("offset-expiry", {
          registryAuthDeviation: { scope: "read:packages", expiry: "2099-01-01T00:00:00+02:00", rotationOwner: "oncall" },
        }),
      ),
    ).not.toThrow();

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

  test("QDS_EXEDEV_REGISTRY_AUTH_FILE: the 0600 is ASSERTED, not assumed", async () => {
    // The whole security property the path-not-value indirection buys is "the
    // secret lives in a file only this operator can read". An unchecked claim
    // of it is worth nothing, so a group- or world-readable file is refused
    // before the read rather than described in a remediation and trusted.
    const fake = fakeExeDev();
    try {
      const loose = join(authDir, "auth-0644");
      writeFileSync(loose, `${VALID_AUTH}\n`, { mode: 0o644 });
      // writeFileSync's mode is masked by the process umask: under a hardened
      // runner's umask 077 the "loose" fixture would be born 0600 and the one
      // test proving 0644 is refused would flake red on a correct driver.
      // chmod is what actually pins the mode.
      chmodSync(loose, 0o644);
      const err = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: loose }, { run: fake.run, postureFile: ratified }),
        "0644",
      );
      expect(err.code).toBe("registry-auth-file-mode");
      expect(err.message).toContain("0644"); // the octal mode, named
      expect(err.message.includes(CANARY_SECRET)).toBe(false);

      // RATIFIED posture on this arm too: the deviation gate now runs BEFORE
      // the credential file is opened (so an unratified path never loads the
      // operator's PAT into the process), which means an unratified posture
      // here would refuse for the other reason and the unreadable-file rule
      // would go untested.
      const missing = refusal(
        () =>
          exeDevDriverFromEnv(
            { QDS_EXEDEV_REGISTRY_AUTH_FILE: join(authDir, "no-such-auth") },
            { run: fake.run, postureFile: ratified },
          ),
        "absent",
      );
      expect(missing.code).toBe("registry-auth-unreadable");

      // …and an EMPTY file says so, rather than "found no ':' separator" for a
      // value that is not there — a message the guard then refuses to show.
      const empty = join(authDir, "auth-empty");
      writeFileSync(empty, "\n", { mode: 0o600 });
      chmodSync(empty, 0o600);
      const emptyErr = refusal(
        () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: empty }, { run: fake.run, postureFile: ratified }),
        "empty",
      );
      expect(emptyErr.code).toBe("registry-auth-unreadable");
      expect(emptyErr.message).toMatch(/is empty/);

      // A 0600 file LOADS — and the trailing newline every editor writes is
      // trimmed off rather than travelling into argv.
      const tight = join(authDir, "auth-0600");
      writeFileSync(tight, `${VALID_AUTH}\n`, { mode: 0o600 });
      // chmod for the same reason the loose fixture eighteen lines up needs it,
      // in the one test whose SUBJECT is file mode: umask can only clear bits,
      // so under an exotic umask (0177, 0277) this file is born 0400/0200 and a
      // driver checking `mode & 0o777 === 0o600` would refuse a fixture the test
      // calls acceptable. chmod is what actually pins the mode.
      chmodSync(tight, 0o600);
      // …and the ratification gate still applies to the file-loaded credential:
      // the indirection is not a way around the recorded deviation.
      expect(
        refusal(
          () => exeDevDriverFromEnv({ QDS_EXEDEV_REGISTRY_AUTH_FILE: tight }, { run: fake.run, postureFile: join(authDir, "no-such-posture.json") }),
          "file-loaded, unratified",
        ).code,
      ).toBe("registry-auth-unratified");
      // Nothing above this line was allowed to build a command.
      expect(fake.calls).toEqual([]);

      // The HAPPY path, proven at the only place it is observable: in ARGV.
      // This arm used to assert `not.toThrow()` and nothing else — the sole
      // positive assertion for the whole path-indirection feature — so an
      // implementation that opened the file, checked the mode, validated the
      // contents and then THREW THE VALUE AWAY passed this test and every other
      // test in the file (no other test uses QDS_EXEDEV_REGISTRY_AUTH_FILE).
      // The credential would vanish from argv on a real fleet and boxes would
      // fail to pull a private image with no diagnostic. "It didn't throw" is
      // not evidence; the parsed create is, which is the standard every sibling
      // test in this describe already holds itself to.
      //
      // It also covers the trim claim positively: an untrimmed trailing "\n"
      // would have reached `fake.creates` as part of the credential.
      const loaded = exeDevDriverFromEnv(
        { QDS_EXEDEV_REGISTRY_AUTH_FILE: tight },
        { run: fake.run, postureFile: ratified },
      );
      await loaded.create("df210-auth-file");
      expect(fake.creates).toEqual([
        { name: "df210-auth-file", image: DEFAULT_IMAGE_REF, registryAuth: VALID_AUTH },
      ]);
      expect(newArgv(fake)).toEqual([
        "ssh",
        "exe.dev",
        "new",
        "--name",
        "df210-auth-file",
        "--image",
        DEFAULT_IMAGE_REF,
        "--registry-auth",
        VALID_AUTH,
        "--json",
      ]);
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
        // A LITERAL, not imageDigestOf(PINNED): the driver derives its logged
        // digest with that same helper, so helper-vs-helper here would stay
        // green (undefined === undefined) through a regression that dropped
        // the digest from every create event.
        expect(line.imageDigest).toBe(`sha256:${"a1b2c3d4".repeat(8)}`);
        expect(line.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
        // The Observability Contract names `runId` on every create event, and
        // `emit` defaults it to null for the anomaly events whose subject is
        // not a run of ours. Nothing pinned it here, so every create line
        // joined to null: the contract's own stated purpose — "a boot
        // regression joins to its image digest without a second key" — failed
        // for anyone joining by the field the contract names.
        expect(line.runId).toBe("df210-auth-1");
        expect(line.vm).toBe("df210-auth-1");
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
      // …and the REST of the diagnostic survived, in place. "Secret absent +
      // marker present" is satisfied by an implementation that replaces the
      // whole substrate stderr with the marker whenever a credential is
      // configured — passing all three scrub tests while destroying the only
      // line that says what exe.dev actually refused. The pin is PUBLIC (this
      // file argues so at the assertImageRef arm), so it must still be echoed:
      // the credential is excised, the sentence around it is not.
      expect(err.message).toContain(
        `exe.dev: unknown flag in: new --image ${PINNED} --registry-auth [registry-auth redacted] --json`,
      );
      // The create_failed event carries the boolean, not the credential — and
      // the same image provenance every other create event carries, so a boot
      // regression is attributable from the FAILURE line too.
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
      const failed = lines.find((l) => l.operation === "exedev.create_failed");
      expect(failed?.registryAuthUsed).toBe(true);
      expect(failed?.status).toBe("error");
      // The substrate ANSWERED and refused — a decision, not a silence — so
      // this arm says `false` where the rejection arm says `true`.
      expect(failed?.mayExist).toBe(false);
      expect(failed?.imageRef).toBe(PINNED);
      // Literal for the same reason as the happy-path digest assertion: the
      // helper under test must not be its own oracle.
      expect(failed?.imageDigest).toBe(`sha256:${"a1b2c3d4".repeat(8)}`);
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
      // GUARDED like every sibling absence claim in this describe: `JSON.stringify([])`
      // is "[]" and contains no canary, so the line below went green on a
      // create() that emitted NOTHING — sink never installed, event dropped,
      // throw moved above the emit — while the three message assertions above
      // (which say nothing about logs) kept the test looking covered.
      const failed = lines.find((l) => l.operation === "exedev.create_failed");
      expect(failed?.registryAuthUsed).toBe(true);
      expect(failed?.status).toBe("error");
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("no credential configured ⇒ substrate stderr rides through UNSCRUBBED — the redaction is scoped", async () => {
    // The negative arm the three scrub tests never had. Without it, every one
    // of them is satisfiable by a driver that redacts unconditionally, and the
    // cost lands on the DEFAULT path: a public-image fleet (no credential at
    // all) loses its substrate diagnostic to a scrub for a secret that does not
    // exist. `redactRegistryAuth` returns early when `registryAuth` is
    // undefined; this is the test that says so out loud.
    const fake = fakeExeDev();
    try {
      const substrateSays = `exe.dev: unknown flag in: new --image ${PINNED} --json`;
      const leaky: FakeCommand = async (argv, o) =>
        argv[0] === "ssh" && argv[1] === "exe.dev" && argv[2] === "new"
          ? { stdout: "", stderr: `${substrateSays}\n`, exitCode: 2 }
          : fake.run(argv, o);
      const driver = new ExeDevDriver({ run: leaky, image: PINNED });
      const { error } = await captureLog(() => driver.create("df210-no-auth-scrub"), { expectThrow: true });
      const err = error as ExeDevDriverError;
      expect(err.code).toBe("create-failed");
      expect(err.message).toContain(substrateSays);
      expect(err.message).not.toContain("[registry-auth redacted]");
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
      // …and the field a REAPER can act on. `exitCode: null` alone cannot tell
      // a spawn ENOENT (nothing was ever created) from an exec timeout that
      // landed AFTER exe.dev accepted the `new` (a box is alive and billing).
      // Unknown reports the fail-SAFE reading: sweeping a name that was never
      // created is a no-op, the reverse is an invisible box.
      expect(failed?.mayExist).toBe(true);
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
    // TWO facts, one falsifiable assertion each. The pair used to be
    // `ASSERTION_CODE === ["A"…"E"]` followed by
    // `EVERY_ASSERTION_ITEM === ASSERTION_CODE`, and the second could not fail:
    // the line above had just asserted the right side is exactly A–E, and a
    // failure there aborts the test before the second line runs. It passed for
    // every possible implementation while reading as extra coverage.
    //
    // Derived from `EVERY_ASSERTION_ITEM`, so the record is not merely a
    // compile-time ornament: adding a sixth `AssertionItem` FORCES a sixth key
    // here (`Record<AssertionItem, true>` under `bunx tsc`) and the letter
    // assertion below then fails at runtime too — which is the title's claim.
    const items = Object.keys(EVERY_ASSERTION_ITEM).sort();
    expect(items).toEqual(["A", "B", "C", "D", "E"]);
    // …and DF3.1's production table still agrees with the union. Fails the
    // moment the two disagree in either direction.
    expect(Object.keys(ASSERTION_CODE).sort()).toEqual(items);
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
    // A LITERAL, not `DEFAULT_IMAGE_BUILD_ID`. The fixture INTERPOLATES that
    // constant (`fixtures/fake-exedev.ts:134`), so comparing the two is X === X
    // — unfailable — and this is the ONLY assertion in the file that claims the
    // fixture agrees with the repo pin. Written out, it is falsifiable, and a
    // re-pin has to come past it by hand: that is the point, since the same
    // coupling makes every gate-B happy-path test below pass by CONSTRUCTION
    // rather than by agreement, and this line is what re-checks the
    // construction. Keep it in step with DEFAULT_IMAGE_BUILD_ID on every re-pin.
    // (Adoption 1cc01c55 moved the constant but missed these two lines — this
    // file went red on clean dev until they were brought back in step.)
    //
    // WHAT THIS STILL CANNOT SEE: a STALE pin. Both assertions compare repo
    // constants against a literal, so they catch the fixture disagreeing with
    // the constant and never "an image input moved and nobody re-published".
    // `gatherBuildIdInputs` is unexported and needs registry resolution for the
    // base digests, so no test can recompute the real id offline. The offline
    // half lives in tests/scripts/build-exedev-image.test.ts — "the tracked
    // buildId inputs are the ones the current pin was derived from" — which
    // snapshots the Dockerfile and systemd asset digests. RE-PIN BOTH IN THE
    // SAME COMMIT; that pairing is the whole ritual.
    expect(marker.buildId).toBe("52538541c5430cc5"); // adopted by the fourteenth-pin ritual (gate B run 35537650657 at src_sha 1b653f04 — DF6.1a's four walked inputs: brief-schema, dispatch, dispatch-task (the in-box appendix renderer), run-record); re-pinned here (the pairing the comment above demands)
    expect(DEFAULT_IMAGE_BUILD_ID).toBe("52538541c5430cc5");
    expect(Object.keys(marker).sort()).toEqual(["buildId", "builtAt", "bunVersion", "gitSha", "imageRef", "piVersion"]);
  });

  test("the byte cap is `>=`: exactly IMAGE_MARKER_MAX_BYTES refuses, one byte under passes", () => {
    // The message wording "at or over" promises `>=` semantics; until this
    // test the boundary itself lived only in that English sentence, and a cap
    // drifted to `>` would have refused the far-over case, kept every message
    // honest-sounding, and accepted a marker at exactly the cap. Exercised at
    // the arm that enforces it (`imageMarkerFailure`), padded via gitSha so
    // both documents stay well-formed ASCII (bytes === chars) with the pinned
    // buildId — the ONLY difference between refusal and pass is one byte.
    const padTo = (bytes: number): string => {
      const template = (sha: string) =>
        JSON.stringify({ ...(JSON.parse(DEFAULT_IMAGE_MARKER) as Record<string, unknown>), gitSha: sha });
      return template("c".repeat(bytes - Buffer.byteLength(template(""), "utf8")));
    };
    const atCap = padTo(IMAGE_MARKER_MAX_BYTES);
    expect(Buffer.byteLength(atCap, "utf8")).toBe(IMAGE_MARKER_MAX_BYTES);
    const refusedAtCap = imageMarkerFailure({ kind: "content", content: atCap }, DEFAULT_IMAGE_BUILD_ID);
    expect(refusedAtCap?.code).toBe("image-marker-mismatch");
    expect(refusedAtCap?.message).toMatch(/at or over/);
    const underCap = padTo(IMAGE_MARKER_MAX_BYTES - 1);
    expect(Buffer.byteLength(underCap, "utf8")).toBe(IMAGE_MARKER_MAX_BYTES - 1);
    expect(imageMarkerFailure({ kind: "content", content: underCap }, DEFAULT_IMAGE_BUILD_ID)).toBeNull();
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

  /**
   * create → configure the box's marker (and its read behaviour) → fill.
   *
   * `with` defaults to the describe's repo-pinned driver; a case that needs a
   * DIFFERENTLY-pinned driver (a tenant build, a split pin) passes its own so
   * the create and the fill come from the same driver the gate will judge with.
   */
  async function boxWithMarker(runId: string, patch?: Partial<FakeBoxConfig>, withDriver: ExeDevDriver = driver) {
    await withDriver.create(runId);
    if (patch !== undefined) fake.configure(runId, patch);
    const rosterPath = join(rosterDir, `roster-${runId}.yaml`);
    writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
    await withDriver.fill(runId, { runId, repoUrl: `file://${originDir}`, commitSha: headSha, workdir: "work" });
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

  /**
   * The `sh -c` strings this box was actually sent — ANCHORED before it is
   * handed back.
   *
   * `boxCmds` is a filter on `argv[1]` projecting `argv[2]`, so any drift in
   * that shape (an ssh option ahead of the host, the command landing at
   * `argv[3]`) empties it — and an empty array satisfies every ABSENCE claim
   * built on it while proving nothing. The marker read is the floor: the gate
   * demonstrably asked, so a later "and it did NOT do X" means something.
   */
  function boxCommands(runId: string): string[] {
    const cmds = fake.calls
      .filter((a) => a[1] === `${runId}.exe.xyz`)
      .flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
    expect(cmds.some((c) => c.includes(IMAGE_MARKER_PATH)), `${runId}: the gate never read the marker`).toBe(true);
    return cmds;
  }

  /**
   * BTP-5 (round 6): the positive control every `chat/completions` ABSENCE
   * claim in this file leans on. An absence claim is only as good as the
   * projection it is read through: `boxCommands` filters `calls` on
   * `argv[1]` and projects `argv[2]`, and a projection whose shape drifted
   * (the command landing at `argv[3]`, the host key moving) satisfies every
   * "no spend" assertion while reading NOTHING. The single-case sibling test
   * (df210-marker-ok) proves the anchor CAN see a real spend on the one
   * fixture where gate C genuinely runs; this helper makes the same guarantee
   * hold for the refusal fixtures, where gate C never runs and nothing real
   * could ever prove observability.
   *
   * HOW: plant a benign spend-shaped command into the fake's OWN call log —
   * a recorded string, never executed (the fake only records argv, nothing
   * shells out, no network, no spend) — cloned from a command the gate
   * REALLY issued to THIS fixture, so the planted argv is shape-faithful by
   * construction rather than by a hand-restated copy of the transport's
   * argv layout. Then require the projection to see it. Finally pop the
   * plant: the log must be byte-identical for the absence assertion that
   * follows, or the control would BE the spend it vouches against.
   *
   * Run ONCE PER FIXTURE that carries an absence claim — cheap (in-memory
   * array push), and per-fixture is what makes each claim non-vacuous: a
   * per-class control would leave any fixture whose own argv went blind
   * (a per-fixture host override, a differently-pinned driver) asserting
   * absence through a hole.
   */
  function assertSpendObservable(runId: string): void {
    const shapeDonor = fake.calls.find(
      (a) => a[1] === `${runId}.exe.xyz` && typeof a[2] === "string" && a[2].includes(IMAGE_MARKER_PATH),
    );
    // The donor IS boxCommands' anchor: if this fixture never recorded a
    // marker read, the sibling absence claim was never anchored either, and
    // that is the defect this control exists to name.
    expect(shapeDonor, `${runId}: no marker-read argv recorded — nothing to clone the spend shape from`).toBeDefined();
    // Typed triple, not index-then-forget: the find predicate above proved
    // argv[1] and argv[2] are strings, and the destructure carries that proof
    // into the planted argv's types.
    const [donorArgv0, donorHost] = shapeDonor as [string, string, string];
    fake.calls.push([
      donorArgv0,
      donorHost,
      "sh -c 'curl -fsS -X POST https://openrouter.ai/api/v1/chat/completions -H \"Authorization: Bearer sk-test\" -d @-'",
    ]);
    expect(
      boxCommands(runId).some((c) => c.includes("chat/completions")),
      `${runId}: the spend path is not observable through boxCommands — this fixture's absence assertion would hold for any implementation`,
    ).toBe(true);
    expect(fake.calls.pop()).toBeDefined();
  }

  test("a matching marker passes gate B and the whole gate goes ready", async () => {
    const opts = await boxWithMarker("df210-marker-ok");
    const result = await driver.setup("df210-marker-ok", opts);
    expect(result.ready).toBe(true);
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
    expect(result.assertions.find((a) => a.item === "B")?.ok).toBe(true);
    // The .env leg, end to end: the seeded key file is the SAME file the gate
    // appended the runner line to — the helper's write and the returned
    // `envFile` box-relative path map onto one real file. If either literal
    // drifts, the gate writes QDS_TEAM_RUNNER=local into a file the recipe
    // never seeded and the seeded key line goes missing from what the box
    // actually serves.
    const envOnBox = readFileSync(join(fake.homeDir("df210-marker-ok"), "app", ".env"), "utf8");
    expect(envOnBox).toContain("OPENROUTER_API_KEY=sk-test-0000000000000000000000");
    expect(envOnBox).toContain("QDS_TEAM_RUNNER=local");
    // The gate actually READ the marker — a gate that never asked would pass
    // this test for the wrong reason. (`boxCommands` asserts that anchor.)
    boxCommands("df210-marker-ok");
    // POSITIVE CONTROL for the spend tripwire the refusal tests lean on: they
    // assert `boxCommands(id).some((c) => c.includes("chat/completions")) ===
    // false`, an ABSENCE claim that holds trivially for any projection that
    // never covers the model call. Gate C's completion is issued through the
    // same ssh-exec seam this projection reads, so on this READY run — where
    // C genuinely ran — the marker MUST be visible. This is what makes every
    // sibling "refused before a cent was spent" mean something: the anchor
    // demonstrably CAN observe a spend.
    expect(
      boxCommands("df210-marker-ok").some((c) => c.includes("chat/completions")),
      "the spend path is not observable through boxCommands — the refusal tests' absence assertions would hold for any implementation",
    ).toBe(true);
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
      // …and that is a claim about TRAFFIC, not about bookkeeping. The letter
      // list above is the gate's own record of what it thinks it did: a gate
      // that appended C's model call before recording its assertion row, or ran
      // a warm-up completion during `fill`, leaves it green and still spends.
      // The same anchored projection the single-case sibling uses, run for
      // every arm of the table — "refused before a cent was spent" is this
      // table's load-bearing claim too. BTP-5: the positive control runs for
      // THIS fixture right beside its absence claim, so the claim is
      // non-vacuous per case, not per table.
      expect(boxCommands(c.id).some((d) => d.includes("chat/completions")), c.id).toBe(false);
      assertSpendObservable(c.id);
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
      // …and the READ leg's OTHER transport status, which nothing covered: ssh
      // dropping between a successful `test -f` and the `cat` is the likeliest
      // real fault on this leg (255 was tested only on the probe, 137 only on
      // the read). Classified through the same named pair, so an operator gets
      // "the box never answered" rather than an image finding for a network
      // blip — the exact miscategorisation this whole test exists to prevent.
      { id: "df210-marker-cat255", box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 255 }, why: /exit 255 — ssh connection failed or dropped mid-flight/ },
      // The UNNAMED signal on the read leg, and the reason the rule is now "not
      // exit 1" on both legs rather than a list of statuses. A box shutting
      // down SIGTERMs the `cat` (143) exactly as it SIGTERMs the probe; while
      // the read leg enumerated 137/255 and blamed the image for everything
      // else, that operator was handed `image-marker-mismatch` and audited a
      // pin the evidence is silent about — the miscategorisation the probe leg
      // had already been hardened against, still live one leg over.
      {
        id: "df210-marker-cat143",
        box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 143 },
        why: /read exited 143 — not `cat`'s ordinary refusal \(exit 1\), so the marker was never read/,
      },
    ];
    // Only exit 1 is `test -f`'s clean miss. A probe SIGTERMed by a box
    // shutting down (143) — or any other unnamed exit — proves nothing about
    // the marker, and "did not boot a factory image" would blame the pin for
    // a dying box. Pinned at the arm directly (no gate cycle needed): still
    // fail-closed, classified unreachable, absence explicitly unproven.
    const probe143 = imageMarkerFailure({ kind: "absent", probeExit: 143, probeStderr: "" }, DEFAULT_IMAGE_BUILD_ID);
    expect(probe143?.code).toBe("image-marker-unreachable");
    expect(probe143?.message).toMatch(/probe exited 143/);
    expect(probe143?.message).not.toMatch(/did not boot a factory image/);
    // …while the clean miss keeps the absence finding.
    const probe1 = imageMarkerFailure({ kind: "absent", probeExit: 1, probeStderr: "" }, DEFAULT_IMAGE_BUILD_ID);
    expect(probe1?.code).toBe("image-marker-mismatch");
    expect(probe1?.message).toMatch(/did not boot a factory image/);
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
    // FOUR create→fill→gate cycles now. Budget left at 270 s deliberately
    // rather than scaled to 360: MEASURED at 13.1 s wall for the whole test
    // (all four cycles) on this fake, so the ~20 s/cycle figure the previous
    // row was budgeted against is already the pessimistic loaded number and 270
    // still holds ~3× headroom over it. Raised only when a measurement, not a
    // row count, says it is tight.
  }, 270_000);

  test("a mismatched marker refuses even when the box is otherwise perfect", async () => {
    // The negative control for AC1's own DoD line: a test that asserted only
    // "docker build && docker push exited 0" proves the image exists and
    // nothing about whether exe.dev booted it. THIS is the assertion that
    // distinguishes them — the box below passes A, has pi, has models, has
    // credit, and is still refused, purely on what it says it booted.
    // Distinct from the repo pin by ASSERTION, not by luck — the guard two
    // sibling tests already carry. If a rebuild ever stamps this very value as
    // DEFAULT_IMAGE_BUILD_ID, the box below is no longer mismatched and this
    // test — the file's stated negative control for AC1's own DoD line — starts
    // asserting a PASSING box's behaviour and fails for a reason its title
    // cannot explain.
    const wrongBuild = "0123456789abcdef";
    expect(wrongBuild).not.toBe(DEFAULT_IMAGE_BUILD_ID);
    const opts = await boxWithMarker("df210-marker-perfect", { imageMarker: marker({ buildId: wrongBuild }) });
    const result = await driver.setup("df210-marker-perfect", opts);
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("B");
    expect(result.assertions.find((a) => a.item === "B")?.note).toContain(wrongBuild);
    // No chat/completions ran: the refusal came before a cent was spent.
    // (`boxCommands` anchors the projection first — see its docblock.)
    // BTP-5: and this fixture's own positive control proves the absence claim
    // is read through a projection that can see a spend.
    expect(boxCommands("df210-marker-perfect").some((c) => c.includes("chat/completions"))).toBe(false);
    assertSpendObservable("df210-marker-perfect");
  }, 90_000);

  test("a SPLIT pin boots one image and is refused against the OTHER half's buildId", async () => {
    // The cost of the documented constructor seam (pinned as deliberate by "the
    // both-or-neither guard is the FACTORY's" above), made executable. This
    // driver boots PINNED with no `imageBuildId`, so gate B still compares
    // against DEFAULT_IMAGE_BUILD_ID — and the box below is HONEST: it baked
    // exactly the image it was told to boot and reports that image's own build.
    // It is refused anyway. On a fleet that is every box, and the note reads as
    // "your image is wrong" when the fault is the missing half of a pin.
    // Fail-CLOSED is the right verdict — this test exists so that the seam's
    // price is written down instead of discovered at 20 boxes.
    const splitDriver = new ExeDevDriver({ run: fake.run, image: PINNED });
    const pinnedBuild = "0123456789abcdef";
    expect(pinnedBuild).not.toBe(DEFAULT_IMAGE_BUILD_ID);
    const opts = await boxWithMarker(
      "df210-marker-split",
      { imageMarker: marker({ imageRef: PINNED, buildId: pinnedBuild }) },
      splitDriver,
    );
    const result = await splitDriver.setup("df210-marker-split", opts);
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("B");
    expect(result.error?.code).toBe("image-marker-mismatch");
    // The note names BOTH halves, which is the only thing that lets an operator
    // see this is a split pin rather than a bad image: the box's build, and the
    // repo pin it was compared against.
    const note = result.assertions.find((a) => a.item === "B")?.note ?? "";
    expect(note).toContain(pinnedBuild);
    expect(note).toContain(DEFAULT_IMAGE_BUILD_ID);
    // …and the reference the box booted IS the one the driver asked for — the
    // refusal is about the buildId half alone, not a box that ignored --image.
    expect(fake.creates.find((c) => c.name === "df210-marker-split")?.image).toBe(PINNED);
    expect(note).toContain(PINNED);
  }, 120_000);

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
    // Distinct by ASSERTION, like its siblings: if a rebuild stamps this value
    // as the repo pin, the "strict" run below stops being a mismatch at all and
    // the test's whole claim ("the comparison is real") goes unproven.
    expect(other).not.toBe(DEFAULT_IMAGE_BUILD_ID);
    const tenantDriver = new ExeDevDriver({ run: fake.run, image: MIRRORED, imageBuildId: other });
    // Built through `boxWithMarker` (its `withDriver` parameter exists for
    // exactly this differently-pinned case) rather than a hand-rolled copy of
    // the recipe: the helper's create→configure→roster→fill→.env sequence is
    // the one the sibling tests pin, and a copy here silently misses every
    // future fix to that sequence while staying green.
    const opts = await boxWithMarker(
      "df210-marker-tenant",
      { imageMarker: marker({ buildId: other, imageRef: MIRRORED }) },
      tenantDriver,
    );

    const result = await tenantDriver.setup("df210-marker-tenant", opts);
    expect(result.assertions.find((a) => a.item === "B")?.ok).toBe(true);
    expect(result.ready).toBe(true);

    // And the SAME box refuses the repo-pinned driver: the comparison is real.
    const strict = await driver.setup("df210-marker-tenant", opts);
    expect(strict.ready).toBe(false);
    expect(strict.failedItem).toBe("B");
    // The DISCRIMINATING detail, because this second `setup` reuses the same
    // runId, the same box and the same evidenceDir the first (successful) one
    // already wrote into. If `setup` is not idempotent — consumes a sentinel,
    // refuses to overwrite an existing evidence file, mutates box state during
    // A — then `ready === false` could be true for a reason that has nothing to
    // do with the buildId, and `failedItem === "B"` narrows that without
    // eliminating it. The typed code and the note naming BOTH builds do.
    expect(strict.error?.code).toBe("image-marker-mismatch");
    const strictNote = strict.assertions.find((a) => a.item === "B")?.note ?? "";
    expect(strictNote).toContain(other);
    expect(strictNote).toContain(DEFAULT_IMAGE_BUILD_ID);
  }, 120_000);
});

// ─── fixture contract — the exec deadline clamp (P47) ───────────────────────

describe("fixture contract — fake-exedev exec deadline clamp (P47)", () => {
  test("a NaN timeoutMs behaves as an immediate deadline: the exec is killed promptly, non-zero", async () => {
    // spawnLocal's clamp (`Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs)
    // : 1`) is documented as a TEXTUAL parallel to the drivers' clamps and a
    // behaviour no-op — setTimeout already coerces a NaN delay to ~1 ms by
    // itself. This is the one-line behavioural pin that the comment tells the
    // truth: a `sleep 5` under a NaN budget dies in milliseconds, never runs
    // to completion, and reports a non-zero exit.
    const fake = fakeExeDev();
    try {
      fake.configure("nan-budget-box", {}); // ensureBox, so the ssh arm reaches spawnLocal
      const started = Date.now();
      const res = await fake.run(["ssh", "nan-budget-box.exe.xyz", "sh", "-c", "sleep 5"], {
        timeoutMs: Number.NaN,
      });
      // The child's own budget is the yardstick, not an arbitrary latency
      // ceiling: a `sleep 5` that runs to completion cannot finish in under
      // 5000 ms of wall clock, so anything below proves the kill landed. The
      // old 3 s bound measured spawn+kill LATENCY and could be blown by a
      // loaded runner on a correct driver — a flake with no defect behind it.
      expect(Date.now() - started, "the NaN-budget exec ran to completion — the clamp did not kill it").toBeLessThan(
        5_000,
      );
      expect(res.exitCode).not.toBe(0); // group SIGKILL reports a signal exit
    } finally {
      fake.cleanup();
    }
  }, 10_000);
});
