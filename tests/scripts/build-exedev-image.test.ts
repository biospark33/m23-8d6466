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

import { SECRET_ENV } from "../../scripts/build-image.ts";
import {
  type BuildIdInputs,
  canonicalOutputPath,
  DEFAULT_TAG,
  deriveBuildId,
  dockerfileArgDefaults,
  judgeCandidateDir,
  type LicenseTableProblems,
  metadataDigests,
  nodeModulesRoot,
  outputPathAllowed,
  parseBaseRefs,
  PI_VERSION,
  readBunPin,
  redactAssignments,
  refRepository,
  repoDigestFor,
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

  /**
   * Each row is KEYED BY THE FIELD IT MUTATES, not by free-form English, so the
   * "every input has a mutation case" test below can actually check it. With
   * English keys the two existing checks forced `allInputs` and `baseInputs()`
   * to grow with the interface while nothing tied either to this array — add a
   * field, satisfy both checks, forget the row, and if `deriveBuildId` never
   * folded the field into the hash NO test failed. That is precisely the "an
   * input silently dropped from the hash fails no workflow gate" scenario the
   * docstring above says these tests are the only defence against.
   */
  const mutations: [keyof BuildIdInputs, string, (i: BuildIdInputs) => BuildIdInputs][] = [
    ["baseDigests", "a base image digest", (i) => ({ ...i, baseDigests: [DIGEST_B] })],
    ["baseDigests", "the number of base image digests", (i) => ({ ...i, baseDigests: [...i.baseDigests, DIGEST_B] })],
    ["bunVersion", "the bun version", (i) => ({ ...i, bunVersion: "1.3.14" })],
    ["piVersion", "the pi version", (i) => ({ ...i, piVersion: "0.84.5" })],
    [
      "dockerfile",
      "one byte of the Dockerfile",
      (i) => ({ ...i, dockerfile: (i.dockerfile as string).replace("RUN true", "RUN fals") }),
    ],
    [
      "systemdFiles",
      "the bytes of systemd/qds-run@.service",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) => (f.name === "qds-run@.service" ? { ...f, bytes: `${f.bytes}\n` } : f)),
      }),
    ],
    [
      "systemdFiles",
      "the bytes of systemd/qds-steering.conf",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) =>
          f.name === "qds-steering.conf" ? { ...f, bytes: (f.bytes as string).replace("X=1", "X=2") } : f,
        ),
      }),
    ],
    [
      "systemdFiles",
      "the NAME of a systemd file",
      (i) => ({
        ...i,
        systemdFiles: i.systemdFiles.map((f) => (f.name === "qds-steering.conf" ? { ...f, name: "qds-other.conf" } : f)),
      }),
    ],
    ["systemdFiles", "the set of systemd files (one dropped)", (i) => ({ ...i, systemdFiles: i.systemdFiles.slice(0, 1) })],
  ];

  test("every declared input has a mutation case below", () => {
    // A new field on BuildIdInputs that nobody adds a row for would be hashed
    // (or NOT hashed) with no test noticing. THREE halves. COMPILE-TIME:
    // `allInputs` must list every key of the TYPE — including an OPTIONAL
    // field, which an untouched fixture (and any runtime keys check over it)
    // can never see — so growing the interface refuses to compile until this
    // literal, and a mutation row, are updated. RUNTIME: the fixture stays in
    // step with that same list, and so does the MUTATION TABLE, which is the
    // only one of the three that proves the field reaches the hash.
    const allInputs: Record<keyof BuildIdInputs, 0> = {
      baseDigests: 0,
      bunVersion: 0,
      dockerfile: 0,
      piVersion: 0,
      systemdFiles: 0,
    };
    expect(Object.keys(baseInputs()).sort()).toEqual(Object.keys(allInputs).sort());
    expect([...new Set(mutations.map(([field]) => String(field)))].sort()).toEqual(Object.keys(allInputs).sort());
  });

  for (const [field, what, mutate] of mutations) {
    test(`changing ${what} (${field}) changes the buildId`, () => {
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

  test("KNOWN DEFECT (#186): the framing LABEL is NOT length-prefixed, so a crafted filename collides", () => {
    // This test pins a defect that is deliberately UNFIXED, and it is written to
    // fail the moment someone fixes it. Read this before "correcting" it.
    //
    // The framing line is `<label>:<valueBytes>\n` — the value is framed, the
    // LABEL is not. That is reconstructable more than one way, because a systemd
    // FILENAME can carry `:` and `\n`, so the two input sets below hash
    // identically: two different substrates, one identity, which is the single
    // thing `deriveBuildId` exists to prevent.
    //
    // Why it is not fixed here: prefixing the label with its byte length changes
    // EVERY derived buildId, which un-pins `DEFAULT_IMAGE_BUILD_ID` and costs the
    // full re-pin ritual (rebuild → ghcr push → re-pin → a paid live e2e round).
    // Round 6 found it and deferred it onto #186, which DF1.10 discharges when it
    // adds the engine build stage and performs that ritual anyway.
    //
    // WHEN YOU FIX IT (`<labelBytes>:<label>:<valueBytes>\n`): this assertion
    // flips to `.not.toBe`, and the title loses its KNOWN DEFECT prefix. The
    // failure is the reminder — that is the point of pinning it rather than
    // leaving a comment.
    const pair: BuildIdInputs = {
      ...baseInputs(),
      systemdFiles: [
        { name: "a", bytes: "X" },
        { name: "b", bytes: "" },
      ],
    };
    const crafted: BuildIdInputs = {
      ...baseInputs(),
      systemdFiles: [{ name: "a:1\nX\nsystemd/b", bytes: "" }],
    };
    expect(deriveBuildId(pair)).toBe(deriveBuildId(crafted));
  });

  test("KNOWN DEFECT (#186): `platform` is not a buildId input, so two architectures claim one identity", () => {
    // Also deliberately unfixed, also written to fail when fixed. `--platform` is
    // a first-class flag on this script and produces a COMPLETELY different
    // substrate — different ELFs, a different libc. `resolveBaseDigest` does not
    // close the gap: `{{json .Manifest}}` on a multi-arch tag yields the INDEX
    // digest, identical for every architecture. So gate B's in-box INV-IBOX-2
    // assertion passes on an image built for the wrong machine.
    //
    // Adding the field changes every derived buildId — same re-pin cost, same
    // #186 bundle. WHEN YOU FIX IT: add `platform` to `BuildIdInputs`, add a
    // mutation row, and delete this test.
    const inputs = baseInputs();
    expect(deriveBuildId(inputs)).toBe(deriveBuildId({ ...inputs }));
    // The identity carries no architecture term at all: nothing in the hashed
    // set distinguishes an amd64 build from an arm64 one.
    expect(Object.keys(inputs)).not.toContain("platform");
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
      "ghcr.io/boldsoftware/exeuntu@sha256:bd447a7715e40984673e29d817b73eb3611bdcf834929821ddc9b204fc5ec72a",
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

  test("deduplicates case-INSENSITIVELY, keeping the first-seen spelling", () => {
    // The stage lookup one line up is already case-insensitive; the ref dedup
    // was not. `FROM Alpine` / `FROM alpine` yielded TWO entries for one image:
    // two registry digest resolutions, both folded into the buildId, while
    // `resolveRuntimeBaseRef` returns only one of them — so the membership
    // check downstream compares against a list that over-counts. Docker path
    // components must be lowercase, but the registry HOST segment may be mixed
    // case, which is how this is reachable.
    expect(parseBaseRefs("FROM Alpine\nFROM alpine\n")).toEqual(["Alpine"]);
    expect(parseBaseRefs("FROM GHCR.io/x/y:v1\nFROM ghcr.io/x/y:v1\n")).toEqual(["GHCR.io/x/y:v1"]);
  });

  test("a stage named after its own base still contributes that base", () => {
    // Registering this instruction's alias BEFORE testing its ref made
    // `FROM alpine AS alpine` resolve `alpine` against the alias it was in the
    // middle of declaring: the base vanished from the list, its digest never
    // entered the buildId, and `gatherBuildIdInputs`' runtime-base membership
    // check then killed a valid Dockerfile naming nothing about the cause.
    // Docker resolves a ref against the stages declared BEFORE it.
    expect(parseBaseRefs("FROM alpine AS alpine\n")).toEqual(["alpine"]);
    expect(parseBaseRefs("FROM alpine AS alpine\nFROM alpine\n")).toEqual(["alpine"]);
    expect(parseBaseRefs("FROM alpine AS Alpine\nFROM ALPINE\n")).toEqual(["alpine"]);
    // And the pair agrees, which is what the membership check needs.
    expect(parseBaseRefs("FROM alpine AS alpine\nFROM alpine\n")).toContain(
      resolveRuntimeBaseRef("FROM alpine AS alpine\nFROM alpine\n") as string,
    );
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

  test("a bare `<<` that is not a heredoc opener does NOT trip the guard", () => {
    // `dockerfile.includes("<<")` refused any Dockerfile containing the
    // digraph anywhere — a C-style shift in a RUN, a `<<` inside a comment or a
    // quoted LABEL — with a fatal `die(2)` naming a construct the file does not
    // use. EXECUTED against the old implementation:
    // `parseBaseRefs('FROM alpine\nRUN echo "a << b"\n')` THREW. The guard is
    // now anchored on a heredoc OPENER shape.
    expect(parseBaseRefs('FROM alpine\nRUN echo "a << b"\n')).toEqual(["alpine"]);
    expect(parseBaseRefs('FROM alpine\nRUN echo "$((1<<20))"\n')).toEqual(["alpine"]);
    expect(parseBaseRefs("FROM alpine\n# a note about x << y\n")).toEqual(["alpine"]);
  });

  test("every heredoc opener spelling is still refused", () => {
    for (const df of ["FROM a\nRUN <<EOF\ntrue\nEOF\n", "FROM a\nRUN <<-EOF\ntrue\nEOF\n", "FROM a\nRUN <<'EOF'\ntrue\nEOF\n"]) {
      expect(() => parseBaseRefs(df)).toThrow(/line-based/);
    }
  });

  test("a COMMENTED-OUT continuation does not trip the guard", () => {
    // The continuation scan ran over raw lines, so `# FROM node:22 \` above a
    // real FROM died with "teach it heredocs" on a Dockerfile that has neither
    // a heredoc nor a continuation.
    expect(parseBaseRefs("# FROM node:22 AS builder \\\nFROM exeuntu\n")).toEqual(["exeuntu"]);
  });

  test("a CRLF Dockerfile is parsed, and its continuation guard still fires", () => {
    // Every anchor in this parser is `[ \t]*$`, and `\r` is neither space nor
    // tab — so on a CRLF checkout (`core.autocrlf=true`, a Windows
    // contributor) the guard was silently DISARMED and a `\`-continued FROM
    // misparsed straight into the buildId. Both halves pinned: the ordinary
    // file parses, and the continuation is still refused.
    expect(parseBaseRefs("FROM alpine\r\nRUN true\r\n")).toEqual(["alpine"]);
    expect(() => parseBaseRefs("FROM alpine \\\r\n  AS runtime\r\n")).toThrow(/line-based/);
  });

  test("a continuation line that LOOKS like a FROM is refused, not parsed as a base", () => {
    // The guard only ever caught a FROM line that ENDS with a backslash. The
    // other half of the class is a non-FROM instruction whose CONTINUATION
    // reads as a FROM — and that phantom is appended LAST, so
    // `resolveRuntimeBaseRef`'s `froms.at(-1)` takes it as the runtime base and
    // AC5's negative control subtracts the wrong image.
    const df = "FROM alpine\nRUN printf '%s\\n' \\\n  FROM scratch > /tmp/x\n";
    expect(() => parseBaseRefs(df)).toThrow(/line-based/);
    expect(() => resolveRuntimeBaseRef(df)).toThrow(/line-based/);
  });
});

// ─────────────────────────────── ARG defaults ───────────────────────────────

describe("dockerfileArgDefaults", () => {
  test("reads a default, with or without surrounding whitespace", () => {
    expect(dockerfileArgDefaults("ARG FOO=bar\n", "FOO")).toEqual(["bar"]);
    expect(dockerfileArgDefaults("  ARG   FOO=bar  \n", "FOO")).toEqual(["bar"]);
  });

  test("is empty for an ARG with no default", () => {
    expect(dockerfileArgDefaults("ARG FOO\n", "FOO")).toEqual([]);
  });

  test("is empty when the ARG is absent", () => {
    expect(dockerfileArgDefaults("ARG OTHER=1\nRUN true\n", "FOO")).toEqual([]);
  });

  test("does not match a longer ARG name by prefix", () => {
    // Guards the real pairing below: `PI` must not silently read `PI_VERSION`.
    expect(dockerfileArgDefaults("ARG PI_VERSION=0.84.4\n", "PI")).toEqual([]);
  });

  test("is empty for a default containing whitespace", () => {
    // `(\S+)` by construction. Documented so a future `ARG X=a b` reads as a
    // missing default rather than a silently truncated one.
    expect(dockerfileArgDefaults("ARG FOO=a b\n", "FOO")).toEqual([]);
  });

  test("tolerates a trailing comment rather than reporting the ARG as absent", () => {
    // An end-anchored value pattern made `ARG PI_VERSION=0.84.4  # measured`
    // read as "declares no ARG PI_VERSION" — a refusal naming the wrong problem
    // for a Dockerfile that declares it perfectly well.
    expect(dockerfileArgDefaults("ARG PI_VERSION=0.84.4  # measured on a box\n", "PI_VERSION")).toEqual(["0.84.4"]);
  });

  test("collects EVERY declaration, so a per-stage divergence is visible", () => {
    // An ARG must be re-declared in every stage that consumes it, and DF1.10
    // adds a build stage to this Dockerfile. A first-match-only read compared
    // the script's constant against the BUILDER's copy and let a stale default
    // in the RUNTIME stage pass — which surfaces as a bare `sha256sum -c`
    // mismatch ten QEMU-emulated minutes in.
    const df = "FROM a AS build\nARG BUN_VERSION=1.3.13\nFROM b\nARG BUN_VERSION=1.2.0\n";
    expect(dockerfileArgDefaults(df, "BUN_VERSION")).toEqual(["1.3.13", "1.2.0"]);
    // Agreeing copies collapse to one, so the lockstep check stays a simple
    // equality for the multi-stage file that is merely repeating itself.
    expect(dockerfileArgDefaults("ARG X=1\nFROM b\nARG X=1\n", "X")).toEqual(["1"]);
  });

  test("strips a symmetric pair of surrounding quotes, as docker itself does", () => {
    // `ARG PI_VERSION="0.84.4"` is a valid Dockerfile installing 0.84.4.
    // Capturing the quotes made the caller die with `PI_VERSION disagrees: this
    // script passes 0.84.4, oci/exedev/Dockerfile defaults to "0.84.4"` — two
    // spellings of one substrate, told to be reconciled.
    expect(dockerfileArgDefaults('ARG PI_VERSION="0.84.4"\n', "PI_VERSION")).toEqual(["0.84.4"]);
    expect(dockerfileArgDefaults("ARG PI_VERSION='0.84.4'\n", "PI_VERSION")).toEqual(["0.84.4"]);
    // Asymmetric or one-sided quoting is NOT a quoted value; left verbatim so a
    // genuinely odd default still shows up as a disagreement rather than being
    // silently trimmed into agreement.
    expect(dockerfileArgDefaults('ARG FOO="bar\n', "FOO")).toEqual(['"bar']);
    expect(dockerfileArgDefaults(`ARG FOO="bar'\n`, "FOO")).toEqual([`"bar'`]);
  });

  test("reads a CRLF Dockerfile rather than reporting the ARG as absent", () => {
    // `[ \t]*$` does not match a trailing `\r`, so on a CRLF checkout every
    // declaration read as missing and the build died with `declares no "ARG
    // BUN_VERSION=<default>"` about a file that declares it perfectly well.
    expect(dockerfileArgDefaults("ARG BUN_VERSION=1.3.13\r\n", "BUN_VERSION")).toEqual(["1.3.13"]);
  });

  test("the script's PI_VERSION constant IS the Dockerfile's ARG PI_VERSION default", () => {
    // The script always passes `--build-arg PI_VERSION`, so the Dockerfile
    // default is dead code at build time — but the Dockerfile's BYTES are a
    // buildId input, so editing one alone moves the identity without moving the
    // substrate. (`BUN_VERSION`'s half of this pairing lives in
    // tests/scripts/exedev-bun-pin.test.ts.)
    expect(dockerfileArgDefaults(REAL_DOCKERFILE, "PI_VERSION")).toEqual([PI_VERSION]);
  });
});

// ───────────────────── buildId input-set completeness (COPY) ─────────────────────

/**
 * KNOWN DEFECT (#186), third of the three the buildId carries — see the KNOWN
 * GAPS block on `deriveBuildId`. Its FILE inputs are hand-enumerated: the
 * Dockerfile, and everything under `oci/exedev/systemd/`. An asset `COPY`'d
 * from anywhere else in the build context ships bytes the identity does not
 * cover: the Dockerfile bytes move ONCE when the COPY is added, and from then
 * on every edit to that asset ships a different substrate under an unchanged
 * buildId.
 *
 * A build-time refusal for it belongs in the #186 re-pin bundle, not in a
 * review round — so this is a TRIPWIRE instead, and it costs nothing. It fails
 * the day such a COPY is added, which is the moment someone needs to know, and
 * it needs no production code to exist. The scan is inlined rather than
 * importing a helper for exactly that reason.
 */
describe("buildId input-set completeness (COPY sources)", () => {
  test("the real Dockerfile copies only from the hashed systemd directory", () => {
    const sources = REAL_DOCKERFILE.split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      // `--from=` copies take bytes from another stage or image, never from the
      // build context, so they contribute nothing the buildId should cover.
      .filter((l) => /^(?:COPY|ADD)\s/i.test(l) && !/--from=/i.test(l))
      // Last token is the destination; the rest, minus flags, are the sources.
      .flatMap((l) => l.split(/\s+/).slice(1, -1).filter((t) => !t.startsWith("--")));
    // Not vacuous: this Dockerfile really does COPY, so an empty list would
    // mean the scan broke rather than that the invariant holds.
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      // WHEN THIS FAILS: the new asset's bytes are not a buildId input. Either
      // move it under oci/exedev/systemd/, or add it to `gatherBuildIdInputs`
      // and `BuildIdInputs` — which moves every derived buildId and therefore
      // rides the #186 re-pin ritual.
      expect(src.startsWith("oci/exedev/systemd/")).toBe(true);
    }
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

  test("one scope claimed by two DIFFERENT digests is dropped, not silently won", () => {
    // The flat-namespaced and nested shapes can both write scope "image", and
    // the winner used to be whatever `Object.entries` yielded last — the
    // ambiguity resolved silently, in favour of an arbitrary digest, on the one
    // value that becomes the repo pin. Dropping it makes `get("image")`
    // undefined, which routes into the caller's existing "none attributable to
    // the image exporter" refusal. Both orderings, so nothing depends on which
    // key the JSON happened to list first.
    for (const meta of [
      { "image.containerimage.digest": DIGEST_A, image: { "containerimage.digest": DIGEST_B } },
      { image: { "containerimage.digest": DIGEST_B }, "image.containerimage.digest": DIGEST_A },
    ]) {
      expect(metadataDigests(meta).get("image")).toBeUndefined();
    }
  });

  test("one scope claimed twice by the SAME digest is not a conflict", () => {
    const m = metadataDigests({
      "image.containerimage.digest": DIGEST_A,
      image: { "containerimage.digest": DIGEST_A },
    });
    expect(m.get("image")).toBe(DIGEST_A);
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
    "ghcr.io/quantum-digital-solutions/qds-exedev:local",
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

  test("BEFORE ANY ACTION: the refusal touches no daemon and creates no build directory", () => {
    // The half of this describe's own title that nothing checked. The claim is
    // structurally true today (`parseArgs` is `main`'s first statement) but was
    // not pinned: move the call below `ensureReproBuilder()` (a ~35 s container
    // start) or below `fs.mkdirSync(BUILD_DIR)` and every test above stays
    // green. Two independent witnesses — the build directory's existence is
    // unchanged across the run, and the same exit 2 with the same message comes
    // back on a PATH with no `docker` on it at all.
    const buildDir = path.join(REPO_ROOT, "oci/.build/exedev");
    const before = fs.existsSync(buildDir);
    const res = spawnSync(
      // `process.execPath`, not the name `bun`: the point of this run is a PATH
      // with no `docker` on it, and a PATH lookup for the runtime would fail too.
      process.execPath,
      [path.join(REPO_ROOT, "scripts/build-exedev-image.ts"), "--tag", "ghcr.io/x/y:v1,push=true"],
      { encoding: "utf8", env: { ...process.env, PATH: path.join(REPO_ROOT, "oci/license-texts") } },
    );
    expect(res.status).toBe(2);
    expect(res.stderr ?? "").toMatch(/not an image reference this script can act on/);
    expect(fs.existsSync(buildDir)).toBe(before);
  });
});

/**
 * `--summary`/`--evidence` are `path.resolve(value)` and NOTHING ELSE, and the
 * run CREATES AND DELETES what they name. The old guard was a denylist of the
 * five inputs this script reads: it refused `--evidence oci/exedev/Dockerfile`
 * and PASSED `--evidence src/providers/exedev/driver.ts` — the file holding the
 * digest pin this whole script exists to feed — and `--summary .env` with it.
 */
describe("outputPathAllowed", () => {
  const BUILD_DIR = path.join(REPO_ROOT, "oci/.build/exedev");

  test("allows this script's own build directory — the shape CI passes", () => {
    // publish-exedev-image.yml passes "$BUILD_DIR/sweep-summary.json" and
    // "$BUILD_DIR/publish-evidence.json", and asserts its BUILD_DIR env equals
    // the script's constant. Both arms of that are pinned here.
    expect(outputPathAllowed(path.join(BUILD_DIR, "sweep-summary.json"))).toBe(true);
    expect(outputPathAllowed(path.join(BUILD_DIR, "publish-evidence.json"))).toBe(true);
    expect(outputPathAllowed(path.join(BUILD_DIR, "nested", "x.json"))).toBe(true);
  });

  test("allows the system temp dir", () => {
    expect(outputPathAllowed(path.join(os.tmpdir(), "qds-out.json"))).toBe(true);
    expect(outputPathAllowed(path.join(os.tmpdir(), "df210", "run7", "evidence.json"))).toBe(true);
  });

  test("refuses a source file inside the repository", () => {
    for (const p of ["src/providers/exedev/driver.ts", ".env", "package.json", "oci/exedev/Dockerfile", "oci/license-texts"]) {
      expect(outputPathAllowed(path.join(REPO_ROOT, p))).toBe(false);
    }
  });

  test("refuses a path OUTSIDE the repository that is not under the temp dir", () => {
    // The rule was positive only with respect to the repo, so ANY path outside
    // it passed and the preclean `rmSync`'d it before a single layer was built:
    // `--summary ~/.ssh/known_hosts`, `--evidence ~/.npmrc`, or on CI anything
    // under $HOME. The docblock already said "a temp dir" — nothing checked.
    expect(outputPathAllowed(path.join(os.homedir(), ".npmrc"))).toBe(false);
    expect(outputPathAllowed("/etc/hosts")).toBe(false);
    expect(outputPathAllowed(path.join(os.homedir(), ".ssh", "known_hosts"))).toBe(false);
  });

  test("refuses a repo path reached through `..` or through a symlinked parent", () => {
    expect(outputPathAllowed(path.join(BUILD_DIR, "..", "..", "..", "src", "index.ts"))).toBe(false);
    // `path.resolve` does not realpath, so a link OUTSIDE the tree pointing
    // back into it walked straight past a prefix test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-outlink-"));
    try {
      const link = path.join(dir, "into-repo");
      fs.symlinkSync(path.join(REPO_ROOT, "src"), link);
      expect(outputPathAllowed(path.join(link, "driver.ts"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("case is not a way past the guard, in either direction — BOTH arms, on every platform", () => {
    // The denylist this replaced compared `path.resolve` output verbatim, so on
    // APFS/NTFS `OCI/exedev/Dockerfile` walked past it and `rmSync` then
    // resolved it case-insensitively onto the real tracked file. The positive
    // rule refuses a shouted source path on every platform (it is neither under
    // BUILD_DIR nor under the temp dir, whichever way case is folded)…
    for (const insensitive of [true, false]) {
      expect(outputPathAllowed(path.join(REPO_ROOT, "SRC/providers/exedev/driver.ts"), insensitive)).toBe(false);
    }
    // …and under case folding a shouted BUILD_DIR resolves to the real build
    // directory, so it is allowed rather than refused for spelling. The fold
    // used to be keyed on `process.platform`, so this arm — the whole
    // case-insensitivity mechanism — never executed on CI's ubuntu runner,
    // while a Linux checkout on a case-insensitive mount (ext4 casefold, a
    // CIFS/NTFS bind) took the WRONG arm at runtime. `outputPathAllowed` takes
    // the flag explicitly now, so both arms run everywhere.
    //
    // The FOLD ITSELF is asserted on a path whose last segment does not exist
    // in any spelling, deliberately: macOS's `realpath(3)` returns the on-disk
    // canonical casing, so a shouted path that DOES resolve is folded back to
    // the real one before either arm is reached — which would make the
    // assertion platform-dependent all over again, the exact defect being
    // fixed. With nothing to resolve at the leaf, the flag is the only thing
    // deciding.
    const unresolvable = path.join(os.tmpdir(), "QDS-NoSuchDir-CASE", "X.json");
    expect(canonicalOutputPath(unresolvable, true)).toBe(canonicalOutputPath(unresolvable, true).toLowerCase());
    expect(canonicalOutputPath(unresolvable, true)).not.toBe(canonicalOutputPath(unresolvable, false));
    expect(canonicalOutputPath(unresolvable, false)).toContain("QDS-NoSuchDir-CASE");
    // …and the fold reaches the ALLOW decision, not just the string: under it,
    // two spellings of one temp path agree.
    expect(outputPathAllowed(unresolvable, true)).toBe(true);
    // And the case-sensitive arm must not refuse the correctly-spelled path.
    expect(outputPathAllowed(path.join(BUILD_DIR, "x.json"), false)).toBe(true);
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

  test("a symlink inside is REPORTED, never followed onto the host filesystem", () => {
    const dir = makeDir();
    try {
      // `docker cp -L` dereferences the top-level SRC_PATH only, so links
      // INSIDE the copied tree keep absolute IN-CONTAINER targets — and
      // `readFileSync` resolves those against the BUILD HOST. Reading through
      // one judges the host's `/etc/passwd` in place of the image's credential:
      // a clean host file greening an image secret. Both link shapes are named
      // rather than read.
      fs.symlinkSync("/etc/hostname", path.join(dir, "host.key"));
      fs.symlinkSync(path.join(dir, "no-such-target"), path.join(dir, "dangling.key"));
      fs.mkdirSync(path.join(dir, "real-dir"));
      fs.symlinkSync(path.join(dir, "real-dir"), path.join(dir, "dir-link"));
      expect(judgeCandidateDir(dir, "etc/credentials").sort()).toEqual(
        [
          "/etc/credentials/dangling.key is a symlink; its target is an in-image path this scan cannot resolve on the host — treating as a finding",
          "/etc/credentials/dir-link is a symlink; its target is an in-image path this scan cannot resolve on the host — treating as a finding",
          "/etc/credentials/host.key is a symlink; its target is an in-image path this scan cannot resolve on the host — treating as a finding",
        ].sort(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable regular file inside fails CLOSED as a finding", () => {
    // This test used to build a nested DIRECTORY and assert the recursion — a
    // byte-for-byte duplicate of "walks nested directories" above, because
    // `isDirectory()` is classified BEFORE `readFileSync` and the EISDIR the
    // comment described could never be thrown. The `catch` arm — the
    // fail-closed guarantee the docblock sells, that an EACCES file becomes a
    // finding rather than a pass — had ZERO coverage: deleting it kept every
    // test green. This drives it for real.
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads through 0o000
    const dir = makeDir();
    try {
      const p = path.join(dir, "token");
      fs.writeFileSync(p, "-----BEGIN RSA PRIVATE KEY-----\nabc\n");
      fs.chmodSync(p, 0o000);
      expect(judgeCandidateDir(dir, "etc/credentials")).toEqual([
        "could not read /etc/credentials/token to check it for credentials — treating as a finding",
      ]);
    } finally {
      fs.chmodSync(path.join(dir, "token"), 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a BINARY credential is a finding, not a clean read", () => {
    // The one fail-OPEN direction left in this gate. `readFileSync(…, "utf8")`
    // maps every invalid byte to U+FFFD, and `configLooksLikeCredential` is two
    // text regexes with no binary arm — so a DER/PKCS#8 key, a .p12 or a
    // gzipped .pem read CLEAN and INV-IBOX-1 reported a pass on a real
    // credential. Both "not text" shapes: a NUL byte, and bytes that are not
    // valid UTF-8.
    const dir = makeDir();
    try {
      // A DER SEQUENCE header followed by high bytes and a NUL — the shape of a
      // PKCS#8 key, and nothing a text regex can see.
      fs.writeFileSync(path.join(dir, "server.key"), Buffer.from([0x30, 0x82, 0x04, 0xa4, 0x02, 0x01, 0x00, 0x30, 0x0d]));
      fs.writeFileSync(path.join(dir, "blob"), Buffer.from([0xfe, 0xff, 0xfe, 0xff]));
      expect(judgeCandidateDir(dir, "etc/ssl/private").sort()).toEqual(
        [
          "could not judge /etc/ssl/private/blob as text (binary or non-UTF-8 content); a text credential scan cannot clear it — treating as a finding",
          "could not judge /etc/ssl/private/server.key as text (binary or non-UTF-8 content); a text credential scan cannot clear it — treating as a finding",
        ].sort(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid UTF-8 with multi-byte characters is still judged, not called binary", () => {
    // The binary test above must not have made the gate refuse every non-ASCII
    // config: this image's own /etc/ssl/certs carries UTF-8 names and content.
    const dir = makeDir();
    try {
      fs.writeFileSync(path.join(dir, "readme"), "Főtanúsítvány — nothing secret here\n");
      fs.writeFileSync(path.join(dir, "env"), "AWS_SECRET_ACCESS_KEY=ő123\n");
      expect(judgeCandidateDir(dir, "etc/credentials")).toEqual(["credential inside /etc/credentials/env"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a FIFO is REPORTED, never read — reading one would wedge the gate forever", () => {
    // `docker cp` reproduces a FIFO as a FIFO, and `readFileSync` on one with
    // no writer blocks indefinitely. Nothing in the build script has a timeout,
    // so the gate concluded neither way: no output, no exit code, a wedged
    // build. "Everything else — files and oddities — is judged by content" was
    // the assumption; oddities are now named rather than opened.
    const dir = makeDir();
    try {
      const made = spawnSync("mkfifo", [path.join(dir, "credentials")]);
      if (made.status !== 0) return; // no mkfifo on this host; the branch is still covered by the stat
      expect(judgeCandidateDir(dir, "run/secrets")).toEqual([
        "/run/secrets/credentials is not a regular file (FIFO); this scan cannot read it for credentials — treating as a finding",
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

  test("keeps looking past a non-boundary hit instead of giving up on it", () => {
    // `indexOf` finds the FIRST occurrence. Returning null on it hid a REAL
    // tree further right — and the gate is "expected 0, a NON-ZERO count is
    // itself the finding", so the miss is a silent green on exactly the
    // condition the sweep exists to catch.
    expect(nodeModulesRoot("usr/lib/my_node_modules/foo/node_modules/pkg/index.js")).toBe(
      "usr/lib/my_node_modules/foo/node_modules",
    );
    expect(nodeModulesRoot("xnode_modules/a/node_modules/b/i.js")).toBe("xnode_modules/a/node_modules");
  });

  test("returns null when there is no node_modules directory", () => {
    expect(nodeModulesRoot("usr/local/bin/bun")).toBeNull();
    expect(nodeModulesRoot("usr/lib/node_modulesx/a")).toBeNull();
    expect(nodeModulesRoot("usr/lib/anode_modules")).toBeNull();
  });

  test("a slashless `node_modules` entry IS a site — fail closed on an empty root", () => {
    // Requiring the literal `node_modules/` meant a listing that renders
    // directory entries with no trailing separator (the bsdtar fallback, taken
    // when `--quoting-style=escape` is unsupported) reported 0 sites for an
    // EMPTY `usr/lib/node_modules` root that is really there — and the gate is
    // "expected 0, a NON-ZERO count is itself the finding", so the miss is a
    // silent green on exactly what the sweep looks for. The caller filters
    // entries ending in `/` before asking, so only the slashless spelling
    // reaches here. The cost, taken deliberately: a regular FILE named
    // `node_modules` now reads as a site too — a loud, spurious `die(1)`,
    // which is the direction this gate is required to fail in.
    expect(nodeModulesRoot("usr/lib/node_modules")).toBe("usr/lib/node_modules");
    expect(nodeModulesRoot("node_modules")).toBe("node_modules");
    expect(nodeModulesRoot("etc/node_modules")).toBe("etc/node_modules");
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
  /**
   * The two classes exit DIFFERENTLY — structural is a malformed input file
   * (exit 2, fatal-before-the-gates), compliance is a well-formed table saying
   * something unacceptable (exit 1). One flat list meant a JSON typo like
   * `"names": []` exited 1, the code the contract reserves for a licence
   * finding, right beside a malformed-top-level check on the same file that
   * correctly exits 2 — so the publish workflow diagnosed a bad edit as a
   * licence failure. Most assertions below care only that the problem is
   * reported at all; the ones that care WHICH class say so.
   */
  const all = (r: LicenseTableProblems): string[] => [...r.structural, ...r.compliance];

  test("accepts a complete table", () => {
    expect(all(validateBinaryLicenses({ entries: [goodEntry()] }, REAL_TEXTS))).toEqual([]);
  });

  test("the repo's own oci/exedev/binary-licenses.json validates clean", () => {
    expect(all(validateBinaryLicenses(JSON.parse(REAL_TABLE), REAL_TEXTS))).toEqual([]);
  });

  test("is TOTAL: a malformed table returns a problem instead of throwing", () => {
    // `null` is valid JSON and reaches here past the parse; a property access on
    // it throws, an uncaught throw exits 1, and 1 is the code the contract
    // reserves for a COMPLIANCE failure — a parse accident reported as a
    // licence violation.
    for (const raw of [null, undefined, [], "entries", 7, {}, { entries: [] }, { entries: "x" }]) {
      const problems = validateBinaryLicenses(raw, REAL_TEXTS);
      expect(problems.structural).toHaveLength(1);
      expect(problems.compliance).toEqual([]);
      expect(problems.structural[0]).toMatch(/carries no entries/);
    }
  });

  test("a MALFORMED entry is structural (exit 2), not a compliance finding (exit 1)", () => {
    // `"names": []` is a JSON typo. It used to land in the same list as
    // UNVERIFIED and exit 1 — "a licence compliance failure" — so any consumer
    // classifying exit codes (the publish workflow does) diagnosed a bad edit
    // as a licence violation.
    const problems = validateBinaryLicenses({ entries: [goodEntry({ names: [] })] }, REAL_TEXTS);
    expect(problems.compliance).toEqual([]);
    expect(problems.structural).toEqual([expect.stringMatching(/"names" must list at least one binary basename/)]);
  });

  test("rejects an entry that names no binary", () => {
    for (const names of [undefined, [], ["  "], [1], "bun"]) {
      expect(all(validateBinaryLicenses({ entries: [goodEntry({ names })] }, REAL_TEXTS))).toEqual([
        expect.stringMatching(/"names" must list at least one binary basename/),
      ]);
    }
  });

  test("rejects an entry missing any required attribution field", () => {
    for (const field of ["project", "spdxId", "copyright", "licenseUrl", "verifiedHow"]) {
      const problems = validateBinaryLicenses({ entries: [goodEntry({ [field]: "  " })] }, REAL_TEXTS);
      expect(problems.structural).toContain(`entry 0: "${field}" is required and must be non-empty`);
    }
  });

  test("rejects the UNVERIFIED sentinel rather than warning on it", () => {
    // It exists so an unestablished licence is recorded honestly instead of
    // guessed at; a guess that ships is worse than a build that stops. And it
    // is a COMPLIANCE finding: the file is well-formed and says something
    // unpublishable.
    const problems = validateBinaryLicenses({ entries: [goodEntry({ spdxId: "UNVERIFIED" })] }, REAL_TEXTS);
    expect(problems.structural).toEqual([]);
    expect(problems.compliance).toEqual([expect.stringMatching(/UNVERIFIED — establish it upstream/)]);
  });

  test("rejects a licence this repo cannot reproduce the text of", () => {
    const problems = validateBinaryLicenses({ entries: [goodEntry({ spdxId: "NoSuchLicense-9.9" })] }, REAL_TEXTS);
    expect(problems.structural).toEqual([]);
    expect(problems.compliance).toEqual([
      expect.stringMatching(/no canonical text in oci\/license-texts\/ for "NoSuchLicense-9.9"/),
    ]);
  });

  test("rejects a bundled disclosure with no pointer", () => {
    // A stub that reads as diligence is worse than an omission.
    for (const bundled of [[{ component: "zlib" }], [{ component: "zlib", url: "u" }], [{}], [null]]) {
      const problems = validateBinaryLicenses({ entries: [goodEntry({ bundled })] }, REAL_TEXTS);
      expect(all(problems)).toEqual([
        expect.stringMatching(/entry 0, bundled 0: "component", "url" and "note" are all required/),
      ]);
    }
  });

  test("accepts an entry that scopes its names to in-image paths", () => {
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ paths: ["usr/local/bin/bun"] })] }, REAL_TEXTS))).toEqual([]);
  });

  test("rejects a malformed `paths` rather than tolerating it into a silent widening", () => {
    // Absent means "covers this basename anywhere"; present means "only here".
    // A malformed one must not quietly become the first.
    for (const paths of [[], ["  "], [1], "usr/local/bin/bun"]) {
      expect(all(validateBinaryLicenses({ entries: [goodEntry({ paths })] }, REAL_TEXTS))).toEqual([
        expect.stringMatching(/"paths", when present, must list at least one in-image path/),
      ]);
    }
  });

  test("rejects a leading slash on a path, which the executable listing never produces", () => {
    const problems = validateBinaryLicenses({ entries: [goodEntry({ paths: ["/usr/local/bin/bun"] })] }, REAL_TEXTS);
    expect(all(problems)).toEqual([expect.stringMatching(/WITHOUT a leading slash/)]);
  });

  test("accepts a complete bundled disclosure", () => {
    const bundled = [{ component: "zlib", spdxId: "Zlib", url: "https://example.invalid/z", note: "statically linked" }];
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ bundled })] }, REAL_TEXTS))).toEqual([]);
  });

  test("reports problems for every entry, keyed by index, in the right class", () => {
    const problems = validateBinaryLicenses(
      { entries: [goodEntry(), goodEntry({ project: "" }), goodEntry({ spdxId: "UNVERIFIED" })] },
      REAL_TEXTS,
    );
    expect(problems.structural).toEqual([expect.stringMatching(/^entry 1: /)]);
    expect(problems.compliance).toEqual([expect.stringMatching(/^entry 2 /)]);
  });

  test("the table names bunx exactly when the Dockerfile installs it", () => {
    // The Dockerfile installs one file (`install … bun-linux-x64/bun
    // /usr/local/bin/bun`) and creates no bunx symlink, so naming bunx claimed
    // attribution for a binary this image does not ship. The coverage direction
    // is inert either way — `uncoveredBinaries` diffs added-against-covered, so
    // a name with no binary matches nothing — but the table is the legal
    // artifact and `attributedBinaries` publishes its claims. This fails if
    // either side moves alone.
    //
    // Keyed on the INSTALL/LINK instruction shape, not the bare word. Any
    // non-comment line mentioning `bunx` for any reason — an `echo`, a path
    // like `/opt/bunxyz`, a `--exclude bunx` — flipped this true and demanded
    // the table claim attribution for a binary the image does not ship.
    const shipsBunx = REAL_DOCKERFILE.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .some((l) => /\b(?:ln|install|cp|mv)\b[^\n]*\bbunx\b/.test(l));
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

  test("an entry with no `paths` still covers its basenames anywhere (the additive default)", () => {
    // The narrowing is opt-in, so an entry nobody has re-measured behaves
    // exactly as it did before the field existed.
    expect(uncoveredBinaries(["opt/vendor/bun"], entries)).toEqual([]);
  });

  test("an entry that declares `paths` covers its basename ONLY there", () => {
    // Basename-only coverage let any executable called `bun` or `pi`, from any
    // project, at any path, pass unquestioned — while the negative control was
    // being strengthened to catch content-level replacement. `/opt/vendor/bun`
    // is not the bun this table establishes.
    const scoped = [{ ...entries[0]!, paths: ["usr/local/bin/bun"] }, entries[1]!];
    expect(uncoveredBinaries(["usr/local/bin/bun"], scoped)).toEqual([]);
    expect(uncoveredBinaries(["opt/vendor/bun"], scoped)).toEqual(["opt/vendor/bun"]);
    // The basename still has to match: a path listed under the wrong entry
    // covers nothing.
    expect(uncoveredBinaries(["usr/local/bin/other"], scoped)).toEqual(["usr/local/bin/other"]);
  });

  test("a whitespace-padded name still covers, rather than validating clean and attributing nothing", () => {
    // `nonEmpty` TRIMS during validation, so `"names": [" bun"]` passes the
    // table check — while the coverage compare did not trim, so the entry
    // attributed nothing and `bun` reported as uncovered with the diagnostic
    // "no entry in oci/exedev/binary-licenses.json". There was an entry. Fails
    // closed, but at a problem that does not exist.
    const padded = [{ ...entries[0]!, names: [" bun"], paths: [" usr/local/bin/bun "] }];
    expect(uncoveredBinaries(["usr/local/bin/bun"], padded)).toEqual([]);
  });

  test("the real table's paths cover the binaries the last real build reported adding", () => {
    // `oci/exedev/binary-licenses.json` now scopes both entries. bun is
    // installed by the Dockerfile at /usr/local/bin/bun; pi's real file is the
    // one `find -type f` sees, under /home/exedev/.local. A path that moves
    // without the table moving fails the build — loudly, in the direction of
    // "this binary needs attributing", which is the whole point.
    const table = (JSON.parse(REAL_TABLE) as { entries: Parameters<typeof uncoveredBinaries>[1] }).entries;
    expect(uncoveredBinaries(["usr/local/bin/bun"], table)).toEqual([]);
    expect(uncoveredBinaries(["home/exedev/.local/bin/pi"], table)).toEqual([]);
    expect(uncoveredBinaries(["opt/vendor/bun"], table)).toEqual(["opt/vendor/bun"]);
  });
});

// ─────────────────────── registry / daemon digest selection ───────────────────────

describe("refRepository / repoDigestFor", () => {
  test("strips a tag but not a registry port", () => {
    expect(refRepository("ghcr.io/x/y:v1")).toBe("ghcr.io/x/y");
    expect(refRepository("localhost:5000/x/y")).toBe("localhost:5000/x/y");
    expect(refRepository("localhost:5000/x/y:v1")).toBe("localhost:5000/x/y");
    expect(refRepository(`ghcr.io/x/y@sha256:${"a".repeat(64)}`)).toBe("ghcr.io/x/y");
  });

  test("picks the RepoDigests entry belonging to the ref's own repository", () => {
    // `{{index .RepoDigests 0}}` took whichever came first. A mirrored or
    // retagged base carries several, and position decided which digest was
    // folded into the buildId — producing a `${ref}@${digest}` pair the
    // registry named by `ref` does not resolve, which AC5's negative control
    // then `docker run`s.
    const mirrored = [`mirror.internal/x/y@sha256:${"b".repeat(64)}`, `ghcr.io/x/y@sha256:${"a".repeat(64)}`];
    expect(repoDigestFor("ghcr.io/x/y:v1", mirrored)).toBe(`sha256:${"a".repeat(64)}`);
    expect(repoDigestFor("mirror.internal/x/y:v1", mirrored)).toBe(`sha256:${"b".repeat(64)}`);
  });

  test("normalises Docker Hub's four spellings of one repository", () => {
    // `FROM docker.io/library/ubuntu:24.04` yields `want =
    // docker.io/library/ubuntu` while dockerd records the RepoDigest as
    // `ubuntu@sha256:…`. The strict compare missed it, and the caller died with
    // "no local RepoDigests entry belongs to docker.io/library/ubuntu" while
    // the entry sat right there under its short name. Fails closed, but the
    // message actively misdirected.
    const short = [`ubuntu@sha256:${"a".repeat(64)}`];
    for (const ref of ["docker.io/library/ubuntu:24.04", "index.docker.io/library/ubuntu:24.04", "library/ubuntu", "ubuntu"]) {
      expect(repoDigestFor(ref, short)).toBe(`sha256:${"a".repeat(64)}`);
    }
    // And in the other direction: a long-form RepoDigest against a short ref.
    expect(repoDigestFor("ubuntu:24.04", [`docker.io/library/ubuntu@sha256:${"b".repeat(64)}`])).toBe(
      `sha256:${"b".repeat(64)}`,
    );
    // A DIFFERENT Docker Hub repository is still foreign.
    expect(repoDigestFor("ubuntu:24.04", [`docker.io/library/alpine@sha256:${"c".repeat(64)}`])).toBeNull();
  });

  test("returns null rather than a foreign repository's digest", () => {
    expect(repoDigestFor("ghcr.io/x/y:v1", [`other.io/x/y@sha256:${"a".repeat(64)}`])).toBeNull();
    expect(repoDigestFor("ghcr.io/x/y:v1", [])).toBeNull();
    expect(repoDigestFor("ghcr.io/x/y:v1", ["ghcr.io/x/y@notadigest", 7, null])).toBeNull();
  });
});

// ───────────────────────── credential-gate log hygiene ─────────────────────────

describe("redactAssignments", () => {
  test("keeps the variable NAME and the layer, and drops the value", () => {
    // The finding goes to stderr and into the build log. `SECRET_ENV` matches
    // `NAME=\S` — it fires BECAUSE a value follows — and BuildKit renders a
    // build-arg-tainted layer as `|1 NPM_TOKEN=<value> /bin/sh -c …`. GitHub
    // masks only values registered as `secrets.*`, so quoting the line
    // verbatim published the credential the gate had just caught.
    //
    // The value runs to END-OF-LINE or to the next `NAME=`, so the layer
    // command after the assignment goes with it. That is the deliberate price
    // of the fix below: `docker image history --no-trunc` strips the
    // Dockerfile's quoting, so a value with a space in it is indistinguishable
    // from the command that follows it, and guessing the boundary is exactly
    // how the tail used to leak.
    expect(redactAssignments("|1 NPM_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz /bin/sh -c npm install")).toBe(
      "|1 NPM_TOKEN=<redacted>",
    );
    expect(redactAssignments("ENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG")).toBe(
      "ENV AWS_SECRET_ACCESS_KEY=<redacted>",
    );
    // The instruction and the NAME — what an operator needs to find the bake —
    // survive on every shape.
    expect(redactAssignments("|1 NPM_TOKEN=x /bin/sh -c npm install")).toStartWith("|1 NPM_TOKEN=");
  });

  test("a value containing WHITESPACE does not keep its tail", () => {
    // The BLOCKER this function was rewritten for. `\S+` stopped at the first
    // space, so a quoted or JSON value published everything after it — into
    // stderr, into the build log, which GitHub masks only for values registered
    // as `secrets.*`. Both of these were EXECUTED against the old
    // implementation: `SECRET_ENV.test(…)` was true for each and the redaction
    // produced `ENV NPM_TOKEN=<redacted> "sekrit"}` and
    // `|1 API_KEY=<redacted> b c" /bin/sh -c true`. A JSON or quoted build-arg
    // value is the ordinary shape, not a contrived one.
    for (const line of [
      'ENV NPM_TOKEN={"k": "sekrit"}',
      '|1 API_KEY="a sekrit c" /bin/sh -c true',
      "ENV PASSWORD=hunter sekrit two",
      "ARG GH_TOKEN='sekrit with spaces' /bin/sh -c true",
    ]) {
      expect(SECRET_ENV.test(line)).toBe(true);
      expect(redactAssignments(line)).not.toContain("sekrit");
    }
  });

  test("a later assignment on the same line still terminates the redaction", () => {
    // The extent must stop at the next `NAME=`, or one secret-shaped value
    // would swallow every following assignment and the line would lose the
    // names an operator needs.
    expect(redactAssignments("|2 A=one two three TOKEN=four five")).toBe("|2 A=<redacted> TOKEN=<redacted>");
  });

  test("redacts every assignment on the line, not only the secret-shaped one", () => {
    // A name the pattern did not match can still hold the secret that did.
    expect(redactAssignments("ENV A=one TOKEN=two B=three")).toBe("ENV A=<redacted> TOKEN=<redacted> B=<redacted>");
  });

  test("leaves flag values and ordinary layer text alone", () => {
    expect(redactAssignments("/bin/sh -c npm install --prefix=/usr/local")).toBe(
      "/bin/sh -c npm install --prefix=/usr/local",
    );
    expect(redactAssignments("RUN apt-get install -y jq")).toBe("RUN apt-get install -y jq");
  });

  test("nothing SECRET_ENV can match survives unredacted", () => {
    // DRIVEN OFF THE DETECTOR, which is what the comment always claimed and the
    // test never did: four hand-picked space-free literals cannot see a whole
    // failure class, and the file did not even import `SECRET_ENV`. Widen the
    // detector's name class — say it grows `-`, matching `X-TOKEN=v`, which
    // `redactAssignments`' `([A-Za-z0-9_]+)=` cannot anchor on — and all four
    // literals still redacted while the invariant broke. The corpus below
    // crosses every lead character, name shape and VALUE shape (the axis the
    // BLOCKER lived on), and the assertion is conditioned on the detector
    // rather than on the author's eye.
    const values = ["sekrit", '"a sekrit c"', '{"k": "sekrit"}', "sekrit with spaces", "sekrit\ttabbed"];
    const names = ["API_KEY", "1TOKEN", "PASSWD", "CREDENTIALS_FILE", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY"];
    const frames = ["ENV %", "ARG %", "|2 % OTHER=1 /bin/sh -c true", "%", "/bin/sh -c % npm i", 'ENV "%"'];
    const corpus: string[] = [];
    for (const n of names) for (const v of values) for (const f of frames) corpus.push(f.replace("%", `${n}=${v}`));
    // The detector has to actually fire on this corpus, or the loop below is
    // vacuous in the way it exists to stop being.
    const matched = corpus.filter((line) => SECRET_ENV.test(line));
    expect(matched.length).toBeGreaterThan(names.length * values.length);
    for (const line of matched) {
      expect(redactAssignments(line)).not.toContain("sekrit");
    }
  });

  test("the detector fires because a VALUE follows, so a redacted line can never re-trip it on the secret", () => {
    // `SECRET_ENV` matches `NAME=\S`, and `<redacted>` is itself `\S` — so a
    // redacted line still matches the detector, by design. What must be true is
    // that the surviving text carries none of the original value.
    const line = 'ENV NPM_TOKEN={"k": "sekrit"} /bin/sh -c npm i';
    expect(SECRET_ENV.test(line)).toBe(true);
    const redacted = redactAssignments(line);
    for (const fragment of ["sekrit", '{"k"', "npm i"]) expect(redacted).not.toContain(fragment);
    expect(redacted).toBe("ENV NPM_TOKEN=<redacted>");
  });
});

// ───────────────────────────────── BunPinError ─────────────────────────────────

describe("BunPinError", () => {
  /**
   * `gatherBuildIdInputs` catches and calls `die(2, err.lines)`, so `lines` is
   * the property that actually reaches the operator and an empty one would
   * print a fatal refusal with no reason.
   *
   * TABLE-DRIVEN over EVERY rejection path, not one of them. The unparseable
   * arm constructs its own separate `BunPinError`, and a future arm that threw
   * a plain `Error` (no `lines`) would be caught here, set `lines = null`, and
   * fail only the first assertion — naming nothing. Each row is named so a
   * failure says which path lost its lines.
   */
  const rejections: [string, string][] = [
    ["unparseable JSON", "{ not json"],
    ["no packageManager field", JSON.stringify({ name: "qds-factory" })],
    ["packageManager is not a string", JSON.stringify({ packageManager: 1.3 })],
    ["packageManager pins something other than bun", JSON.stringify({ packageManager: "pnpm@9.0.0" })],
    ["the bun version is not a version", JSON.stringify({ packageManager: "bun@latest" })],
    ["the bun version is partial", JSON.stringify({ packageManager: "bun@1.3" })],
  ];

  for (const [what, pkgJson] of rejections) {
    test(`carries the operator lines its caller exits with — ${what}`, () => {
      let lines: readonly string[] | null = null;
      let threw = false;
      try {
        readBunPin(pkgJson);
      } catch (err) {
        threw = true;
        lines = (err as { lines?: readonly string[] }).lines ?? null;
      }
      expect(threw).toBe(true);
      expect(Array.isArray(lines)).toBe(true);
      expect(lines?.length).toBeGreaterThan(0);
      expect(lines?.every((l) => typeof l === "string" && l.trim().length > 0)).toBe(true);
    });
  }
});
