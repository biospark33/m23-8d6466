/**
 * Pure-function tests for the DF2.10 boot-image builder.
 *
 * `scripts/build-exedev-image.ts` decides what the published image CONTAINS
 * (the base it diffs against, the binaries that need attribution) and what
 * identity it CLAIMS (`deriveBuildId`, baked into `/etc/qds-image.json` and
 * enforced in-box by gate B). Both halves were, until this round, exercised
 * only by a ten-QEMU-minute docker build — and gate B's unit assertions are
 * tautologies (the fake's marker imports the same `DEFAULT_IMAGE_BUILD_ID` the
 * driver defaults to, so they compare a constant with itself and hold for any
 * value). Everything below is a string/object function: no docker, no network,
 * no filesystem beyond reading the repo's own committed inputs.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type BuildIdInputs,
  DEFAULT_TAG,
  deriveBuildId,
  dockerfileArgDefault,
  judgeCandidateDir,
  metadataDigests,
  nodeModulesRoot,
  parseBaseRefs,
  PI_VERSION,
  readBunPin,
  resolveRuntimeBaseRef,
  TAG_RE,
  tarUnescape,
  uncoveredBinaries,
  validateBinaryLicenses,
} from "../../scripts/build-exedev-image.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const REAL_TEXTS = path.join(REPO_ROOT, "oci/license-texts");
const REAL_DOCKERFILE = fs.readFileSync(path.join(REPO_ROOT, "oci/exedev/Dockerfile"), "utf8");
const REAL_TABLE = fs.readFileSync(path.join(REPO_ROOT, "oci/exedev/binary-licenses.json"), "utf8");

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

// ───────────────────────────────── deriveBuildId ─────────────────────────────────

/** A complete, realistic input set. Every test below is this ± one field. */
function baseInputs(): BuildIdInputs {
  return {
    baseDigests: [DIGEST_A],
    bunVersion: "1.3.13",
    piVersion: "0.84.4",
    dockerfile: "FROM base@sha256:aa\nRUN true\n",
    systemdFiles: [
      { name: "qds-run@.service", bytes: "[Unit]\nDescription=qds run\n" },
      { name: "qds-steering.conf", bytes: "[Service]\nEnvironment=X=1\n" },
    ],
  };
}

/**
 * `deriveBuildId` runs ONLY at build time, in the build script. The publish
 * workflow's "pushed buildId IS the repo pin" check re-derives NOTHING: it
 * greps the hand-pasted `DEFAULT_IMAGE_BUILD_ID` constant out of driver.ts for
 * one side and reads the baked /etc/qds-image.json marker for the other. So
 * these unit tests are the only place the derivation itself is checked — an
 * input silently dropped from the hash fails no workflow gate (the digest half
 * still moves when bytes move); what it silently breaks is the buildId's
 * MEANING, letting two different substrates claim one identity. That is the
 * single thing the docstring says this value exists to prevent, so the tests
 * are one-field-changed pairs, not smoke checks.
 */
describe("deriveBuildId", () => {
  test("is deterministic and 16 hex chars", () => {
    const id = deriveBuildId(baseInputs());
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveBuildId(baseInputs())).toBe(id);
  });

  test("is a function of the SET of inputs, not of the order they arrived in", () => {
    // The filesystem hands over `oci/exedev/systemd/` in whatever order readdir
    // returns, and the Dockerfile lists its FROMs in its own order. Neither may
    // move the identity, or a rebuild on another host reproduces the substrate
    // and fails the pin.
    const a = baseInputs();
    const b: BuildIdInputs = {
      ...a,
      baseDigests: [DIGEST_B, DIGEST_A],
      systemdFiles: [...a.systemdFiles].reverse(),
    };
    const aTwoBases: BuildIdInputs = { ...a, baseDigests: [DIGEST_A, DIGEST_B] };
    expect(deriveBuildId(b)).toBe(deriveBuildId(aTwoBases));
  });

  test("every declared input has a mutation case below", () => {
    // A new field on BuildIdInputs that nobody adds a row for would be hashed
    // (or NOT hashed) with no test noticing. Two halves. COMPILE-TIME:
    // `allInputs` must list every key of the TYPE — including an OPTIONAL
    // field, which an untouched fixture (and any runtime keys check over it)
    // can never see — so growing the interface refuses to compile until this
    // literal, and a mutation row, are updated. RUNTIME: the fixture below
    // stays in step with that same list.
    const allInputs: Record<keyof BuildIdInputs, 0> = {
      baseDigests: 0,
      bunVersion: 0,
      dockerfile: 0,
      piVersion: 0,
      systemdFiles: 0,
    };
    expect(Object.keys(baseInputs()).sort()).toEqual(Object.keys(allInputs).sort());
  });

  const mutations: [string, (i: BuildIdInputs) => BuildIdInputs][] = [
    ["a base image digest", (i) => ({ ...i, baseDigests: [DIGEST_B] })],
    ["the number of base image digests", (i) => ({ ...i, baseDigests: [...i.baseDigests, DIGEST_B] })],
    ["the bun version", (i) => ({ ...i, bunVersion: "1.3.14" })],
    ["the pi version", (i) => ({ ...i, piVersion: "0.84.5" })],
    ["one byte of the Dockerfile", (i) => ({ ...i, dockerfile: (i.dockerfile as string).replace("RUN true", "RUN fals") })],
    [
      "the bytes of systemd/qds-run@.service",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) => (f.name === "qds-run@.service" ? { ...f, bytes: `${f.bytes}\n` } : f)),
      }),
    ],
    [
      "the bytes of systemd/qds-steering.conf",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) =>
          f.name === "qds-steering.conf" ? { ...f, bytes: (f.bytes as string).replace("X=1", "X=2") } : f,
        ),
      }),
    ],
    [
      "the NAME of a systemd file",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) => (f.name === "qds-steering.conf" ? { ...f, name: "qds-other.conf" } : f)),
      }),
    ],
    ["the set of systemd files (one dropped)", (i) => ({ ...i, systemdFiles: i.systemdFiles.slice(0, 1) })],
  ];

  for (const [what, mutate] of mutations) {
    test(`changing ${what} changes the buildId`, () => {
      expect(deriveBuildId(mutate(baseInputs()))).not.toBe(deriveBuildId(baseInputs()));
    });
  }

  test("length framing keeps adjacent fields from trading characters", () => {
    // The docstring's own example: raw concatenation makes `bun=1.3 pi=13.0`
    // and `bun=1.31 pi=3.0` the same bytes.
    const a: BuildIdInputs = { ...baseInputs(), bunVersion: "1.3", piVersion: "13.0" };
    const b: BuildIdInputs = { ...baseInputs(), bunVersion: "1.31", piVersion: "3.0" };
    expect(deriveBuildId(a)).not.toBe(deriveBuildId(b));
  });

  test("length framing keeps the Dockerfile from absorbing the first systemd unit", () => {
    // The docstring's second example: a Dockerfile ending in the bytes that
    // begin the first unit, against the shifted split.
    const a: BuildIdInputs = {
      ...baseInputs(),
      dockerfile: "FROM x",
      systemdFiles: [{ name: "u.conf", bytes: "AB" }],
    };
    const b: BuildIdInputs = {
      ...baseInputs(),
      dockerfile: "FROM xA",
      systemdFiles: [{ name: "u.conf", bytes: "B" }],
    };
    expect(deriveBuildId(a)).not.toBe(deriveBuildId(b));
  });

  test("the framing is a LENGTH prefix, not merely a trailing newline", () => {
    // Systemd units are newline-separated text, so a newline terminator alone
    // is not a delimiter — a unit whose bytes contain the next unit's framing
    // line reproduces that line exactly. These two collide under
    // `label + ":\n" + value + "\n"` and differ under
    // `label + ":" + byteLength + "\n" + value + "\n"`.
    const two: BuildIdInputs = {
      ...baseInputs(),
      systemdFiles: [
        { name: "a.conf", bytes: "X" },
        { name: "b.conf", bytes: "Y" },
      ],
    };
    const smuggled: BuildIdInputs = {
      ...baseInputs(),
      systemdFiles: [{ name: "a.conf", bytes: "X\nsystemd/b.conf:\nY" }],
    };
    expect(deriveBuildId(two)).not.toBe(deriveBuildId(smuggled));
  });

  test("the length is measured in BYTES, so a multi-byte value cannot shift the split", () => {
    // `Buffer.byteLength` vs `.length`: `ő` is one code unit and two bytes.
    const a: BuildIdInputs = { ...baseInputs(), bunVersion: "1.3.13-ő" };
    const b: BuildIdInputs = { ...baseInputs(), bunVersion: "1.3.13-oo" };
    expect(deriveBuildId(a)).not.toBe(deriveBuildId(b));
    expect(deriveBuildId(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a Buffer input hashes identically to its UTF-8 string form", () => {
    // The build reads its file inputs as raw BYTES (no utf8 round-trip);
    // fixtures here pass strings. Same content, same identity — this is what
    // makes the byte-path change provably not move the shipped buildId.
    const s = baseInputs();
    const b: BuildIdInputs = {
      ...s,
      dockerfile: Buffer.from(s.dockerfile as string, "utf8"),
      systemdFiles: s.systemdFiles.map((f) => ({ ...f, bytes: Buffer.from(f.bytes as string, "utf8") })),
    };
    expect(deriveBuildId(b)).toBe(deriveBuildId(s));
  });

  test("bytes that are NOT valid UTF-8 are hashed as themselves, not as U+FFFD", () => {
    // A lossy decode maps every invalid byte to the same replacement
    // character, so two files differing only in WHICH invalid byte they carry
    // would share an identity. As Buffers they must not.
    const bad1: BuildIdInputs = { ...baseInputs(), dockerfile: Buffer.from([0x46, 0x52, 0x4f, 0x4d, 0xfe]) };
    const bad2: BuildIdInputs = { ...baseInputs(), dockerfile: Buffer.from([0x46, 0x52, 0x4f, 0x4d, 0xff]) };
    expect(deriveBuildId(bad1)).not.toBe(deriveBuildId(bad2));
  });
});

// ─────────────────────────── Dockerfile FROM resolution ───────────────────────────

/**
 * The base every AC5 negative control subtracts. Getting it wrong does not
 * fail loudly: with the builder on the wrong side of the diff, every executable
 * the REAL base ships reads as "added" (hundreds of unattributed paths), or —
 * with the fatter image there — genuinely added binaries are subtracted away
 * and ship with no attribution at all. DF1.10 adds a build stage to this same
 * Dockerfile, which is precisely the shape the old "last ref wins" heuristic
 * got wrong.
 */
describe("resolveRuntimeBaseRef", () => {
  test("the real Dockerfile bottoms out at its single pinned base", () => {
    const ref = resolveRuntimeBaseRef(REAL_DOCKERFILE);
    expect(ref).toMatch(/^ghcr\.io\/boldsoftware\/exeuntu@sha256:[0-9a-f]{64}$/);
    // Today's single-FROM file: the heuristic this replaced still agrees.
    expect(parseBaseRefs(REAL_DOCKERFILE)).toEqual([ref as string]);
  });

  test("chases a stage alias instead of taking the last FROM (the builder)", () => {
    const df = "FROM a AS r\nFROM b AS x\nFROM r\n";
    expect(resolveRuntimeBaseRef(df)).toBe("a");
    // The divergence, pinned: "last entry in parseBaseRefs" is the BUILDER here.
    expect(parseBaseRefs(df).at(-1)).toBe("b");
  });

  test("survives the dedup collapse that makes 'last' not last", () => {
    const df = "FROM base AS build\nFROM other AS x\nFROM base\n";
    expect(resolveRuntimeBaseRef(df)).toBe("base");
    expect(parseBaseRefs(df)).toEqual(["base", "other"]);
    expect(parseBaseRefs(df).at(-1)).toBe("other");
  });

  test("chases through several stages, case-insensitively", () => {
    expect(resolveRuntimeBaseRef("FROM alpine AS Base\nFROM base AS Mid\nFROM MID\n")).toBe("alpine");
  });

  test("drops FROM flags", () => {
    expect(resolveRuntimeBaseRef("FROM --platform=linux/amd64 alpine AS a\nFROM a\n")).toBe("alpine");
  });

  test("an alias that shadows an earlier image name is resolved in DECLARATION ORDER, not called a cycle", () => {
    // Legal Docker, and the shape a whole-file alias map gets exactly wrong:
    //   FROM r AS s   → stage `s` from the external IMAGE `r`
    //   FROM s AS r   → stage `r` from the STAGE `s`
    //   FROM r        → the STAGE `r` (declared above), NOT the image
    // Docker resolves each FROM against the stages declared BEFORE it, so this
    // bottoms out at the image `r`. A map built from the whole file made
    // r→s→r a two-node cycle, returned null, and `die(2)`d a valid Dockerfile.
    // Order-bounded lookup also makes a cycle unconstructible: every hop lands
    // on a strictly earlier instruction.
    expect(resolveRuntimeBaseRef("FROM r AS s\nFROM s AS r\nFROM r\n")).toBe("r");
    expect(resolveRuntimeBaseRef("FROM alpine AS s\nFROM s AS alpine\nFROM alpine\n")).toBe("alpine");
    // And the same file is accepted by the buildId path that consumes it: the
    // negative control gets the real base rather than a fatal null.
    expect(parseBaseRefs("FROM alpine AS s\nFROM s AS alpine\nFROM alpine\n")).toEqual(["alpine"]);
  });

  test("a stage named after its own base is one self-hop to the image, not a cycle", () => {
    // `FROM alpine AS alpine` then `FROM alpine` is legal Docker: the later
    // FROM resolves to the STAGE, which derives from the IMAGE of the same
    // name. Reporting it as a cycle would refuse a valid Dockerfile with a
    // suggested fix the file already contains.
    expect(resolveRuntimeBaseRef("FROM alpine AS alpine\nFROM alpine\n")).toBe("alpine");
    expect(resolveRuntimeBaseRef("FROM alpine AS Alpine\nFROM ALPINE\n")).toBe("alpine");
  });

  test("returns null when the final stage is scratch, directly or through an alias", () => {
    expect(resolveRuntimeBaseRef("FROM alpine AS a\nFROM scratch\n")).toBeNull();
    expect(resolveRuntimeBaseRef("FROM scratch AS base\nFROM base\n")).toBeNull();
  });

  test("returns null when there is no FROM at all", () => {
    expect(resolveRuntimeBaseRef("# just a comment\nRUN true\n")).toBeNull();
  });
});

/**
 * Every ref folded into the buildId. The body was refactored onto the shared
 * `fromInstructions` helper this round with a claim of byte-identical
 * behaviour; these pin that claim.
 */
describe("parseBaseRefs", () => {
  test("the real Dockerfile yields exactly one pinned base", () => {
    expect(parseBaseRefs(REAL_DOCKERFILE)).toEqual([
      "ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d",
    ]);
  });

  test("excludes references to the Dockerfile's own earlier stages", () => {
    expect(parseBaseRefs("FROM base AS builder\nFROM builder\n")).toEqual(["base"]);
    expect(parseBaseRefs("FROM base AS Builder\nFROM BUILDER\n")).toEqual(["base"]);
  });

  test("excludes scratch", () => {
    expect(parseBaseRefs("FROM scratch\nFROM alpine\n")).toEqual(["alpine"]);
    expect(parseBaseRefs("FROM SCRATCH AS s\n")).toEqual([]);
  });

  test("deduplicates a repeated ref, preserving first-seen order", () => {
    expect(parseBaseRefs("FROM b\nFROM a\nFROM b AS x\n")).toEqual(["b", "a"]);
  });

  test("drops FROM flags and honours lowercase from", () => {
    expect(parseBaseRefs("from --platform=$TARGETPLATFORM alpine:3 AS a\n")).toEqual(["alpine:3"]);
  });

  test("ignores commented-out and inline-commented FROMs", () => {
    expect(parseBaseRefs("# FROM evil\nFROM alpine # FROM evil2\n")).toEqual(["alpine"]);
  });

  test("KNOWN GAP: a COPY --from=<external image> contributes bytes but no buildId input", () => {
    // Bytes copied out of a foreign image land in the published substrate while
    // contributing nothing to the identity, so that image could move under us
    // without moving the buildId. Recorded rather than fixed: closing it means
    // resolving those refs to digests too, which is a build-time registry read
    // this function does not do. Assertion pins TODAY's behaviour so the fix,
    // when it lands, has to come here and change it deliberately.
    expect(parseBaseRefs("FROM alpine\nCOPY --from=busybox:1.36 /bin/busybox /bin/\n")).toEqual(["alpine"]);
  });
});

/**
 * The FROM parser is line-based, and it must SAY so rather than misparse: a
 * heredoc body whose text begins `FROM x` would otherwise mint a phantom FROM
 * — folded into the buildId, or redirecting AC5's negative control — the
 * moment DF1.10's engine build stage brings multi-line RUNs to this
 * Dockerfile. Synthetic strings only; the real Dockerfile has neither
 * construct (and the real-file tests above prove the guard stays quiet on it).
 */
describe("fromInstructions heredoc/continuation refusal", () => {
  test("a heredoc marker anywhere in the Dockerfile is refused, loudly", () => {
    const df = "FROM alpine\nRUN <<EOF\nFROM evil\nEOF\n";
    expect(() => parseBaseRefs(df)).toThrow(/line-based; teach it heredocs/);
    expect(() => resolveRuntimeBaseRef(df)).toThrow(/line-based; teach it heredocs/);
  });

  test("a backslash-continued FROM line is refused, loudly", () => {
    expect(() => parseBaseRefs("FROM alpine \\\n  AS runtime\n")).toThrow(/line-based/);
  });

  test("an ordinary backslash-continued RUN does not trip the guard", () => {
    expect(parseBaseRefs("FROM alpine\nRUN apt-get update \\\n  && apt-get install -y jq\n")).toEqual(["alpine"]);
  });
});

// ─────────────────────────────── ARG defaults ───────────────────────────────

describe("dockerfileArgDefault", () => {
  test("reads a default, with or without surrounding whitespace", () => {
    expect(dockerfileArgDefault("ARG FOO=bar\n", "FOO")).toBe("bar");
    expect(dockerfileArgDefault("  ARG   FOO=bar  \n", "FOO")).toBe("bar");
  });

  test("returns null for an ARG with no default", () => {
    expect(dockerfileArgDefault("ARG FOO\n", "FOO")).toBeNull();
  });

  test("returns null when the ARG is absent", () => {
    expect(dockerfileArgDefault("ARG OTHER=1\nRUN true\n", "FOO")).toBeNull();
  });

  test("does not match a longer ARG name by prefix", () => {
    // Guards the real pairing below: `PI` must not silently read `PI_VERSION`.
    expect(dockerfileArgDefault("ARG PI_VERSION=0.84.4\n", "PI")).toBeNull();
  });

  test("returns null for a default containing whitespace", () => {
    // `(\S+)` by construction. Documented so a future `ARG X=a b` reads as a
    // missing default rather than a silently truncated one.
    expect(dockerfileArgDefault("ARG FOO=a b\n", "FOO")).toBeNull();
  });

  test("the script's PI_VERSION constant IS the Dockerfile's ARG PI_VERSION default", () => {
    // The script always passes `--build-arg PI_VERSION`, so the Dockerfile
    // default is dead code at build time — but the Dockerfile's BYTES are a
    // buildId input, so editing one alone moves the identity without moving the
    // substrate. (`BUN_VERSION`'s half of this pairing lives in
    // tests/scripts/exedev-bun-pin.test.ts.)
    expect(dockerfileArgDefault(REAL_DOCKERFILE, "PI_VERSION")).toBe(PI_VERSION);
  });
});

// ───────────────────────────── buildx metadata ─────────────────────────────

describe("metadataDigests", () => {
  test("reads the flat, single-exporter shape", () => {
    expect([...metadataDigests({ "containerimage.digest": DIGEST_A })]).toEqual([["", DIGEST_A]]);
  });

  test("reads the per-exporter namespaced shape", () => {
    const m = metadataDigests({
      "image.containerimage.digest": DIGEST_A,
      "docker.containerimage.digest": DIGEST_B,
      "containerimage.config.digest": `sha256:${"c".repeat(64)}`,
    });
    expect(m.get("image")).toBe(DIGEST_A);
    expect(m.get("docker")).toBe(DIGEST_B);
    expect(m.size).toBe(2);
  });

  test("reads the nested per-exporter shape", () => {
    const m = metadataDigests({
      image: { "containerimage.digest": DIGEST_A },
      docker: { "containerimage.digest": DIGEST_B },
    });
    expect(m.get("image")).toBe(DIGEST_A);
    expect(m.get("docker")).toBe(DIGEST_B);
  });

  test("the gating two-exporter build is disambiguated by the image exporter", () => {
    // The archive's manifest digest is not a digest any registry resolves;
    // recording it as the pushed digest turns every post-push equality check
    // into a supply-chain-shaped failure report. The caller takes
    // `get("image")` first, and this is the case that makes that necessary.
    const m = metadataDigests({
      "image.containerimage.digest": DIGEST_A,
      "docker.containerimage.digest": DIGEST_B,
    });
    expect(new Set(m.values()).size).toBe(2);
    expect(m.get("image")).toBe(DIGEST_A);
  });

  test("two exporters reporting the SAME digest leave nothing to disambiguate", () => {
    const m = metadataDigests({
      "docker.containerimage.digest": DIGEST_A,
      "oci.containerimage.digest": DIGEST_A,
    });
    expect(m.size).toBe(2);
    expect(new Set(m.values()).size).toBe(1);
  });

  test("ambiguous: several digests and none attributable to the image exporter", () => {
    // Exactly the two facts the caller keys its fatal-before-the-gates refusal
    // on. Neither may become true by accident.
    const m = metadataDigests({
      "docker.containerimage.digest": DIGEST_A,
      "oci.containerimage.digest": DIGEST_B,
    });
    expect(m.get("image")).toBeUndefined();
    expect(new Set(m.values()).size).toBe(2);
  });

  test("refuses values that are not sha256 digests", () => {
    expect(metadataDigests({ "containerimage.digest": "not-a-digest" }).size).toBe(0);
    expect(metadataDigests({ "containerimage.digest": DIGEST_A.toUpperCase() }).size).toBe(0);
    expect(metadataDigests({ "containerimage.digest": `sha256:${"a".repeat(63)}` }).size).toBe(0);
    expect(metadataDigests({ "containerimage.digest": 12 }).size).toBe(0);
  });

  test("finds nothing in metadata that carries no digest", () => {
    expect(metadataDigests({}).size).toBe(0);
    expect(metadataDigests({ "containerimage.descriptor": { digest: DIGEST_A } }).size).toBe(0);
    // An array value is not an exporter object.
    expect(metadataDigests({ image: [{ "containerimage.digest": DIGEST_A }] }).size).toBe(0);
  });
});

// ─────────────────────────────── --tag validation ───────────────────────────────

/**
 * The diff's headline injection guard, finally under test. `opts.tag` is
 * spliced into buildx's COMMA-SEPARATED `--output` CSV, so a comma in the tag
 * is an exporter attribute — `push=true` among them — and the grammar refuses
 * `,` and `=` by construction. A future relaxation that reopens either
 * character class must fail here, not in a registry.
 */
describe("TAG_RE", () => {
  const accepts = [
    DEFAULT_TAG,
    "alpine",
    "alpine:3.19",
    "ghcr.io/biospark33/qds-exedev:local",
    "localhost:5000/qds/img:v1", // host:port
    "registry.example.com/a/b/c:v1.2.3",
    "img:Tag_With-ok.Chars",
  ];
  for (const tag of accepts) {
    test(`accepts ${JSON.stringify(tag)}`, () => {
      expect(TAG_RE.test(tag)).toBe(true);
    });
  }

  const rejects: [string, string][] = [
    ["", "empty"],
    ["ghcr.io/x/y:v1,push=true", "comma — an exporter attribute, the injection the guard exists for"],
    ["ghcr.io/x/y:v1=x", "'='"],
    ["ghcr.io/Biospark33/img", "uppercase path segment"],
    [`ghcr.io/x/y@sha256:${"a".repeat(64)}`, "digest-only — docker refuses to tag or push a digest reference"],
    [`ghcr.io/x/y:v1@sha256:${"a".repeat(64)}`, "tag-and-digest — same refusal"],
    ["ghcr.io/x/y:v1 --push", "embedded whitespace"],
  ];
  for (const [tag, why] of rejects) {
    test(`rejects ${JSON.stringify(tag)} (${why})`, () => {
      expect(TAG_RE.test(tag)).toBe(false);
    });
  }
});

/**
 * The parse gate end-to-end: each rejection exits 2 (fatal-before-the-gates)
 * BEFORE any docker action — `parseArgs` is `main`'s first statement — so
 * these subprocess runs are cheap and touch no daemon. The accept side cannot
 * be driven this way (a valid invocation proceeds to the builder preflight);
 * TAG_RE above covers the accepted grammar.
 */
describe("parseArgs rejections (subprocess, exit 2 before any action)", () => {
  const SCRIPT = path.join(REPO_ROOT, "scripts/build-exedev-image.ts");
  const runScript = (args: string[]): { status: number | null; stderr: string } => {
    const res = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
    return { status: res.status, stderr: res.stderr ?? "" };
  };

  test("-push (single dash) is refused, not silently dropped", () => {
    // The silent drop ran the whole build and published nothing, with exit 0.
    const { status, stderr } = runScript(["-push"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unknown flag: -push/);
  });

  test("a bare positional is refused, not silently discarded", () => {
    const { status, stderr } = runScript(["push"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unexpected argument\(s\): push/);
  });

  test("a comma in --tag dies at parse, naming the grammar", () => {
    const { status, stderr } = runScript(["--tag", "ghcr.io/x/y:v1,push=true"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/not an image reference this script can act on/);
  });

  test("a digest reference in --tag dies at parse, not after the build", () => {
    const { status, stderr } = runScript(["--tag", `ghcr.io/x/y@sha256:${"a".repeat(64)}`]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/digest reference cannot be tagged or pushed/);
  });
});

// ────────────────────────────── tar listing decode ──────────────────────────────

describe("tarUnescape", () => {
  test("leaves an ordinary path untouched", () => {
    expect(tarUnescape("usr/local/bin/bun")).toBe("usr/local/bin/bun");
  });

  test("decodes the C escapes tar emits", () => {
    expect(tarUnescape("a\\nb")).toBe("a\nb");
    expect(tarUnescape("a\\tb")).toBe("a\tb");
    expect(tarUnescape("a\\rb")).toBe("a\rb");
  });

  test("decodes an escaped backslash to one literal backslash", () => {
    expect(tarUnescape("a\\\\b")).toBe("a\\b");
    // `\\` then `n`: a literal backslash followed by the letter n, NOT a newline.
    expect(tarUnescape("a\\\\nb")).toBe("a\\nb");
  });

  test("decodes octal escapes through BYTES, not code units", () => {
    // GNU tar under a C locale renders every non-ASCII byte as `\NNN`. `ő` is
    // U+0151 = 0xC5 0x91 = \305\221. A per-code-unit `String.fromCharCode`
    // decode yields the two-character mojibake "Å", `docker cp` then
    // misses the file, and the credential gate raises a phantom finding for
    // every UTF-8 name under /etc/ssl/certs — the 126-finding regression this
    // area was fixed out of once already.
    const decoded = tarUnescape("etc/ssl/certs/\\305\\221.pem");
    expect(decoded).toBe("etc/ssl/certs/ő.pem");
    expect(decoded).not.toBe("etc/ssl/certs/Å.pem");
    expect(decoded.length).toBe("etc/ssl/certs/".length + 1 + ".pem".length);
  });

  test("decodes an octal escape that is also a C escape as the octal byte", () => {
    expect(tarUnescape("a\\012b")).toBe("a\nb");
    expect(tarUnescape("\\101")).toBe("A");
  });

  test("keeps a backslash tar did not escape", () => {
    expect(tarUnescape("weird\\")).toBe("weird\\");
    expect(tarUnescape("we\\ird")).toBe("we\\ird");
    // Two digits are not an octal escape; GNU tar always emits three.
    expect(tarUnescape("a\\30b")).toBe("a\\30b");
  });

  test("iterates code points, so an astral character survives alongside an escape", () => {
    // The backslash forces the decoder past its early return; the emoji is
    // TWO UTF-16 code units, and a per-code-unit pass would utf8-encode each
    // lone surrogate as U+FFFD — mojibake, a missed `docker cp`, and a
    // phantom finding on a clean image.
    expect(tarUnescape("usr/share/emoji-📁/a\\tb")).toBe("usr/share/emoji-📁/a\tb");
    expect(tarUnescape("📁\\\\x")).toBe("📁\\x");
    expect(tarUnescape("a\\012📁")).toBe("a\n📁");
  });
});

// ──────────────────────── credential-candidate directories ────────────────────────

/**
 * The EISDIR carve-out's other half: a DIRECTORY by a credential-candidate
 * name (`credentials/`, `foo.pem/`) is not clean by fiat — it can hold
 * credentials as files whose own basenames match no candidate pattern. The
 * copied tree is walked and content-judged; anything unreadable fails CLOSED.
 * Pure host-filesystem function, so it is tested on real temp dirs.
 */
describe("judgeCandidateDir", () => {
  const makeDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "qds-judge-"));

  test("finds a credential in a file whose basename matches no candidate pattern", () => {
    const dir = makeDir();
    try {
      fs.writeFileSync(path.join(dir, "token"), "-----BEGIN RSA PRIVATE KEY-----\nabc\n");
      expect(judgeCandidateDir(dir, "etc/credentials")).toEqual(["credential inside /etc/credentials/token"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks nested directories and keeps the full relative path in the finding", () => {
    const dir = makeDir();
    try {
      fs.mkdirSync(path.join(dir, "inner"));
      fs.writeFileSync(path.join(dir, "inner", "env"), "AWS_SECRET_ACCESS_KEY=abc123\n");
      expect(judgeCandidateDir(dir, "etc/credentials")).toEqual(["credential inside /etc/credentials/inner/env"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clean contents yield no findings — a public cert is not a credential", () => {
    const dir = makeDir();
    try {
      fs.writeFileSync(path.join(dir, "ca.pem"), "-----BEGIN CERTIFICATE-----\npublic\n");
      fs.writeFileSync(path.join(dir, "readme"), "nothing secret here\n");
      expect(judgeCandidateDir(dir, "etc/ssl/things.pem")).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable entry inside fails CLOSED as a finding", () => {
    const dir = makeDir();
    try {
      // A dangling symlink: readFileSync follows and throws, deterministically
      // for any uid (unlike a chmod-000 file, which root reads anyway).
      fs.symlinkSync(path.join(dir, "no-such-target"), path.join(dir, "link.key"));
      expect(judgeCandidateDir(dir, "etc/credentials")).toEqual([
        "could not read /etc/credentials/link.key to check it for credentials — treating as a finding",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that cannot be listed at all is a finding, not a pass", () => {
    expect(judgeCandidateDir(path.join(os.tmpdir(), "qds-judge-definitely-missing"), "etc/credentials")).toEqual([
      "could not list /etc/credentials to check it for credentials — treating as a finding",
    ]);
  });
});

// ───────────────────────────── node_modules siting ─────────────────────────────

describe("nodeModulesRoot", () => {
  test("returns the root an entry sits under", () => {
    expect(nodeModulesRoot("home/exedev/app/node_modules/pi/index.js")).toBe("home/exedev/app/node_modules");
    expect(nodeModulesRoot("node_modules/pi/index.js")).toBe("node_modules");
  });

  test("returns the OUTERMOST root for a nested tree", () => {
    // The sweep extracts a root and walks down; keying on the inner one would
    // leave the outer packages unswept.
    expect(nodeModulesRoot("a/node_modules/b/node_modules/c/x.js")).toBe("a/node_modules");
  });

  test("requires a path boundary before the segment", () => {
    expect(nodeModulesRoot("usr/lib/my_node_modules/x")).toBeNull();
    expect(nodeModulesRoot("xnode_modules/x")).toBeNull();
  });

  test("returns null when there is no node_modules directory", () => {
    expect(nodeModulesRoot("usr/local/bin/bun")).toBeNull();
    // A file named node_modules, not a directory: no trailing slash, no tree.
    expect(nodeModulesRoot("etc/node_modules")).toBeNull();
  });
});

// ─────────────────────────── licence table validation ───────────────────────────

/** A structurally complete entry; tests below remove exactly one thing. */
function goodEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    names: ["bun"],
    project: "oven-sh/bun",
    spdxId: "MIT",
    copyright: "Copyright (c) Bun contributors",
    licenseUrl: "https://example.invalid/LICENSE",
    verifiedHow: "fetched the upstream LICENSE",
    ...over,
  };
}

describe("validateBinaryLicenses", () => {
  test("accepts a complete table", () => {
    expect(validateBinaryLicenses({ entries: [goodEntry()] }, REAL_TEXTS)).toEqual([]);
  });

  test("the repo's own oci/exedev/binary-licenses.json validates clean", () => {
    expect(validateBinaryLicenses(JSON.parse(REAL_TABLE), REAL_TEXTS)).toEqual([]);
  });

  test("is TOTAL: a malformed table returns a problem instead of throwing", () => {
    // `null` is valid JSON and reaches here past the parse; a property access on
    // it throws, an uncaught throw exits 1, and 1 is the code the contract
    // reserves for a COMPLIANCE failure — a parse accident reported as a
    // licence violation.
    for (const raw of [null, undefined, [], "entries", 7, {}, { entries: [] }, { entries: "x" }]) {
      const problems = validateBinaryLicenses(raw, REAL_TEXTS);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/carries no entries/);
    }
  });

  test("rejects an entry that names no binary", () => {
    for (const names of [undefined, [], ["  "], [1], "bun"]) {
      expect(validateBinaryLicenses({ entries: [goodEntry({ names })] }, REAL_TEXTS)).toEqual([
        expect.stringMatching(/"names" must list at least one binary basename/),
      ]);
    }
  });

  test("rejects an entry missing any required attribution field", () => {
    for (const field of ["project", "spdxId", "copyright", "licenseUrl", "verifiedHow"]) {
      const problems = validateBinaryLicenses({ entries: [goodEntry({ [field]: "  " })] }, REAL_TEXTS);
      expect(problems).toContain(`entry 0: "${field}" is required and must be non-empty`);
    }
  });

  test("rejects the UNVERIFIED sentinel rather than warning on it", () => {
    // It exists so an unestablished licence is recorded honestly instead of
    // guessed at; a guess that ships is worse than a build that stops.
    const problems = validateBinaryLicenses({ entries: [goodEntry({ spdxId: "UNVERIFIED" })] }, REAL_TEXTS);
    expect(problems).toEqual([expect.stringMatching(/UNVERIFIED — establish it upstream/)]);
  });

  test("rejects a licence this repo cannot reproduce the text of", () => {
    const problems = validateBinaryLicenses({ entries: [goodEntry({ spdxId: "NoSuchLicense-9.9" })] }, REAL_TEXTS);
    expect(problems).toEqual([expect.stringMatching(/no canonical text in oci\/license-texts\/ for "NoSuchLicense-9.9"/)]);
  });

  test("rejects a bundled disclosure with no pointer", () => {
    // A stub that reads as diligence is worse than an omission.
    for (const bundled of [[{ component: "zlib" }], [{ component: "zlib", url: "u" }], [{}], [null]]) {
      const problems = validateBinaryLicenses({ entries: [goodEntry({ bundled })] }, REAL_TEXTS);
      expect(problems).toEqual([
        expect.stringMatching(/entry 0, bundled 0: "component", "url" and "note" are all required/),
      ]);
    }
  });

  test("accepts a complete bundled disclosure", () => {
    const bundled = [{ component: "zlib", spdxId: "Zlib", url: "https://example.invalid/z", note: "statically linked" }];
    expect(validateBinaryLicenses({ entries: [goodEntry({ bundled })] }, REAL_TEXTS)).toEqual([]);
  });

  test("reports problems for every entry, keyed by index", () => {
    const problems = validateBinaryLicenses(
      { entries: [goodEntry(), goodEntry({ project: "" }), goodEntry({ spdxId: "UNVERIFIED" })] },
      REAL_TEXTS,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^entry 1: /);
    expect(problems[1]).toMatch(/^entry 2 /);
  });

  test("the table names bunx exactly when the Dockerfile installs it", () => {
    // The Dockerfile installs one file (`install … bun-linux-x64/bun
    // /usr/local/bin/bun`) and creates no bunx symlink, so naming bunx claimed
    // attribution for a binary this image does not ship. The coverage direction
    // is inert either way — `uncoveredBinaries` diffs added-against-covered, so
    // a name with no binary matches nothing — but the table is the legal
    // artifact and `attributedBinaries` publishes its claims. This fails if
    // either side moves alone.
    const shipsBunx = REAL_DOCKERFILE.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .some((l) => l.includes("bunx"));
    const bunEntry = (JSON.parse(REAL_TABLE) as { entries: { names: string[] }[] }).entries.find((e) =>
      e.names.includes("bun"),
    );
    expect(bunEntry).toBeDefined();
    expect(bunEntry?.names.includes("bunx")).toBe(shipsBunx);
  });
});

// ───────────────────────────── AC5 coverage diff ─────────────────────────────

describe("uncoveredBinaries", () => {
  const entries = [
    { names: ["bun"], project: "p", spdxId: "MIT", copyright: "c", licenseUrl: "u", verifiedHow: "v" },
    { names: ["pi", "pi-agent"], project: "p", spdxId: "MIT", copyright: "c", licenseUrl: "u", verifiedHow: "v" },
  ];

  test("an added binary whose basename is named is covered", () => {
    expect(uncoveredBinaries(["usr/local/bin/bun", "home/exedev/.local/bin/pi"], entries)).toEqual([]);
  });

  test("an added binary nothing names is reported, at its full path", () => {
    // The path, not the basename: the operator has to go find the thing.
    expect(uncoveredBinaries(["usr/local/bin/bun", "usr/bin/ripgrep"], entries)).toEqual(["usr/bin/ripgrep"]);
  });

  test("every added binary is uncovered when the table names none of them", () => {
    expect(uncoveredBinaries(["usr/bin/a", "usr/bin/b"], [])).toEqual(["usr/bin/a", "usr/bin/b"]);
  });

  test("nothing added is nothing to attribute", () => {
    expect(uncoveredBinaries([], entries)).toEqual([]);
  });

  test("KNOWN CEILING: coverage matches on basename, so a same-named binary at a new path passes", () => {
    // `/opt/vendor/bun` is not the bun this table attributes, and it reads as
    // covered. Deferred with a stated reason, not overlooked: closing it needs
    // `oci/exedev/binary-licenses.json`'s `names[]` to become PATHS, and the
    // real installed paths cannot be enumerated without a build. Round-2 item.
    // This assertion pins today's behaviour so the fix must come here.
    expect(uncoveredBinaries(["opt/vendor/bun"], entries)).toEqual([]);
  });
});

// ───────────────────────────────── BunPinError ─────────────────────────────────

describe("BunPinError", () => {
  test("carries the operator lines its caller exits with", () => {
    // `gatherBuildIdInputs` catches and calls `die(2, err.lines)`. The four
    // rejection paths are covered in tests/scripts/exedev-bun-pin.test.ts
    // through the message; `lines` is the property that actually reaches the
    // operator, and an empty one would print a fatal refusal with no reason.
    let lines: readonly string[] | null = null;
    try {
      readBunPin(JSON.stringify({ packageManager: "pnpm@9.0.0" }));
    } catch (err) {
      lines = (err as { lines?: readonly string[] }).lines ?? null;
    }
    expect(Array.isArray(lines)).toBe(true);
    expect(lines?.length).toBeGreaterThan(0);
    expect(lines?.every((l) => typeof l === "string" && l.trim().length > 0)).toBe(true);
  });
});
