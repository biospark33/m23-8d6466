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
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SECRET_ENV } from "../../scripts/build-image.ts";
import {
  BuildIdInputsError,
  type BuildIdInputs,
  buildArgList,
  buildIdFileInputs,
  canonicalOutputPath,
  CHECKSUM_ARGS,
  checksumArgProblems,
  classifyRegistryRefusal,
  copyContextSources,
  DEFAULT_TAG,
  deriveBuildId,
  dockerfileArgDefaults,
  judgeCandidateDir,
  type LicenseTableProblems,
  metadataDigests,
  NODE_VERSION,
  nodeModulesRoot,
  OPENRIG_VERSION,
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
  mergeSweeps,
  type ManifestInventory,
  parseManifestRaw,
} from "../../scripts/build-exedev-image.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const REAL_TEXTS = path.join(REPO_ROOT, "oci/license-texts");
/**
 * Read LAZILY, not at import. A module-level `readFileSync` recreated the
 * collection-time failure this file eliminated for the walk (see the
 * `buildIdFileInputs` memoization note below): a missing or renamed
 * `oci/exedev/Dockerfile` / `binary-licenses.json` threw during import and
 * every unrelated describe in this file errored with no test named. Now only
 * the tests that ask for a file share that file's failure.
 */
let realDockerfileCache: string | null = null;
let realTableCache: string | null = null;
const realDockerfile = (): string => {
  if (realDockerfileCache === null) realDockerfileCache = fs.readFileSync(path.join(REPO_ROOT, "oci/exedev/Dockerfile"), "utf8");
  return realDockerfileCache;
};
const realTable = (): string => {
  if (realTableCache === null) realTableCache = fs.readFileSync(path.join(REPO_ROOT, "oci/exedev/binary-licenses.json"), "utf8");
  return realTableCache;
};

/**
 * The environment keys this script's own gates read, minus what a test sets
 * explicitly. The wiring tests used to inherit `...process.env` verbatim, so a
 * CI step that exports `QDS_GIT_SHA=""` (the scenario the set-but-empty test
 * below names) or a stray `SOURCE_DATE_EPOCH`/checksum override died the child
 * at a gate the test did not pin: the COMPLIANCE test got exit 2 from the sha
 * gate, the BUN_SHA256 test got the epoch message. Every misfire was loud but
 * attributed to the wrong gate. `runMain` and the direct spawn below build the
 * child env over `cleanEnv()`, and each test passes only what it pins.
 */
const HOSTILE_GATE_KEYS: ReadonlySet<string> = new Set<string>(["SOURCE_DATE_EPOCH", ...CHECKSUM_ARGS]);
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("QDS_") && !HOSTILE_GATE_KEYS.has(key)),
  );

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

// ───────────────────────────────── deriveBuildId ─────────────────────────────────

/** A complete, realistic input set. Every test below is this ± one field. */
function baseInputs(): BuildIdInputs {
  return {
    baseDigests: [DIGEST_A],
    platform: "linux/amd64",
    bunVersion: "1.3.13",
    piVersion: "0.84.4",
    // S1 rig_swarm: REQUIRED fields now (F-038), read by `gatherBuildIdInputs`
    // from the script's own constants. The constants rather than literals, so
    // a version bump fails the canonical-input-tuple pin below — the same
    // "the fixture must move with the substrate" discipline as bunVersion.
    nodeVersion: NODE_VERSION,
    openrigVersion: OPENRIG_VERSION,
    dockerfile: "FROM base@sha256:aa\nRUN true\n",
    // Repo-relative paths, the shape `gatherBuildIdInputs` produces now that
    // the set is derived from the Dockerfile's COPY sources rather than from
    // the systemd directory alone.
    files: [
      { name: "oci/exedev/systemd/qds-run@.service", bytes: "[Unit]\nDescription=qds run\n" },
      { name: "oci/exedev/systemd/qds-steering.conf", bytes: "[Service]\nEnvironment=X=1\n" },
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
      files: [...a.files].reverse(),
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
    // #186's platform gap, now closed. An arm64 build is a different substrate
    // — different ELFs, a different libc — and `resolveBaseDigest` cannot see
    // it, because `{{json .Manifest}}` on a multi-arch tag yields the INDEX
    // digest, identical for every architecture.
    ["platform", "the target platform", (i) => ({ ...i, platform: "linux/arm64" })],
    ["bunVersion", "the bun version", (i) => ({ ...i, bunVersion: "1.3.14" })],
    ["piVersion", "the pi version", (i) => ({ ...i, piVersion: "0.84.5" })],
    // S1 rig_swarm (F-038): an ARG override of NODE_VERSION/OPENRIG_VERSION —
    // or a lockstep-drifting edit of the Dockerfile defaults — installs a
    // different substrate, so it must move the identity exactly like a bun
    // or pi bump does.
    ["nodeVersion", "the node version", (i) => ({ ...i, nodeVersion: "22.19.0" })],
    ["openrigVersion", "the openrig version", (i) => ({ ...i, openrigVersion: "0.5.13" })],
    [
      "dockerfile",
      "one byte of the Dockerfile",
      (i) => ({ ...i, dockerfile: (i.dockerfile as string).replace("RUN true", "RUN fals") }),
    ],
    [
      "files",
      "the bytes of systemd/qds-run@.service",
      (i) => ({
        ...i,
        files: i.files.map((f) => (f.name.endsWith("qds-run@.service") ? { ...f, bytes: `${f.bytes}\n` } : f)),
      }),
    ],
    [
      "files",
      "the bytes of systemd/qds-steering.conf",
      (i) => ({
        ...i,
        files: i.files.map((f) =>
          f.name.endsWith("qds-steering.conf") ? { ...f, bytes: (f.bytes as string).replace("X=1", "X=2") } : f,
        ),
      }),
    ],
    [
      "files",
      "the NAME of a hashed file",
      (i) => ({
        ...i,
        files: i.files.map((f) => (f.name.endsWith("qds-steering.conf") ? { ...f, name: "oci/exedev/systemd/other.conf" } : f)),
      }),
    ],
    ["files", "the set of hashed files (one dropped)", (i) => ({ ...i, files: i.files.slice(0, 1) })],
    [
      "files",
      "one byte of a COPY'd asset outside oci/exedev/systemd/ (#186 KNOWN GAP 3)",
      // The gap that mattered most to DF1.10: the engine binary's sources, the
      // pi catalog and cli-anything/ are all COPY'd from outside the systemd
      // directory, so under the old hand-enumerated set every edit to them
      // shipped a different substrate under an unchanged identity.
      (i) => ({ ...i, files: [...i.files, { name: "cli-anything/src/redact.ts", bytes: "export const x = 1;\n" }] }),
    ],
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
      nodeVersion: 0,
      openrigVersion: 0,
      piVersion: 0,
      platform: 0,
      files: 0,
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
      files: [{ name: "u.conf", bytes: "AB" }],
    };
    const b: BuildIdInputs = {
      ...baseInputs(),
      dockerfile: "FROM xA",
      files: [{ name: "u.conf", bytes: "B" }],
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
      files: [
        { name: "a.conf", bytes: "X" },
        { name: "b.conf", bytes: "Y" },
      ],
    };
    const smuggled: BuildIdInputs = {
      ...baseInputs(),
      files: [{ name: "a.conf", bytes: "X\nfile/b.conf:\nY" }],
    };
    expect(deriveBuildId(two)).not.toBe(deriveBuildId(smuggled));
  });

  test("the framing LABEL is length-prefixed too, so a crafted filename cannot collide (#186, closed)", () => {
    // This was a PINNED DEFECT until DF1.10's re-pin: the framing line was
    // `<label>:<valueBytes>\n`, so the value was framed and the label was not,
    // and a file NAME carrying `:` and `\n` made the encoding reconstructable
    // two ways. The two input sets below hashed IDENTICALLY — executed, both
    // yielded `10c0ed4ae242e878`: two different substrates, one identity, the
    // single thing `deriveBuildId` exists to prevent.
    //
    // It stayed open only because fixing it moves every derived buildId, which
    // costs the full re-pin ritual. DF1.10 performs that ritual anyway, so the
    // framing is now `<labelBytes>:<label>:<valueBytes>\n` and these two differ.
    const pair: BuildIdInputs = {
      ...baseInputs(),
      files: [
        { name: "a", bytes: "X" },
        { name: "b", bytes: "" },
      ],
    };
    const crafted: BuildIdInputs = {
      ...baseInputs(),
      files: [{ name: "a:1\nX\nfile/b", bytes: "" }],
    };
    expect(deriveBuildId(pair)).not.toBe(deriveBuildId(crafted));
  });

  test("no ADVERSARIAL PAIR of single-file sets collides — framing injectivity, searched", () => {
    // The test above pins the HISTORICAL forgery; this one searches for the
    // next one. Short labels over the framing's own delimiters (`:`, digits,
    // newlines, the `file/` prefix, empty) crossed with short values: every
    // distinct single-file input set must get a distinct id. An ambiguous
    // framing maps two different sets to one byte stream — so whatever pair it
    // confuses, if that pair is expressible at this size, it collides HERE
    // rather than shipping. (A 16-hex truncation collision over this many
    // sha256s is not a thing that happens; a framing ambiguity is.)
    const labels = ["a", "b", "a:1", "1:a", "a\nb", "file/a", "a:1\nX\nfile/b", "a:0", "0:a", "file/", ":", ""];
    const values = ["", "X", "\n", "5:a", "0:"];
    const seen = new Map<string, string>();
    for (const name of labels) {
      for (const bytes of values) {
        const id = deriveBuildId({ ...baseInputs(), files: [{ name, bytes }] });
        const clash = seen.get(id);
        expect(
          clash,
          `two single-file sets share buildId ${id}: ${clash} and ${JSON.stringify({ name, bytes })}`,
        ).toBeUndefined();
        seen.set(id, JSON.stringify({ name, bytes }));
      }
    }
    // Non-vacuous: the search really covered the cross product.
    expect(seen.size).toBe(labels.length * values.length);
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
      files: s.files.map((f) => ({ ...f, bytes: Buffer.from(f.bytes as string, "utf8") })),
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

  test("platform spelling is canonicalized (trim + case), a no-op on today's value", () => {
    // `--platform LINUX/AMD64` and `--platform linux/amd64` are ONE substrate
    // via buildx; hashing them as two makes two operators pinning "the same"
    // build diverge on cosmetics. The canonicalization is TRIM+LOWERCASE only
    // — expanding `amd64` shorthand needs the host OS and is not a pure
    // function of the input, so it is not attempted (a multi-platform value
    // still hashes as one opaque string, which over-hashes safely).
    const a = baseInputs(); // platform: "linux/amd64", today's DEFAULT_PLATFORM spelling
    expect(deriveBuildId({ ...a, platform: "LINUX/AMD64" })).toBe(deriveBuildId(a));
    expect(deriveBuildId({ ...a, platform: "  linux/amd64\t" })).toBe(deriveBuildId(a));
    // …and it is canonicalization, not a collapse: a real platform difference
    // still moves the id.
    expect(deriveBuildId({ ...a, platform: "linux/arm64" })).not.toBe(deriveBuildId(a));
  });

  test("the canonical input tuple derives the id it derived before canonicalization", () => {
    // The no-op proof D1-6 owes. `05be4773f08299e9` is what `deriveBuildId`
    // returns for EXACTLY this tuple on the current code — measured on the
    // tree this literal lands with (the S1 re-pin; it was `377bd92f22a95f4b`
    // before F-038 added the required nodeVersion/openrigVersion fields, and
    // `377bd92f…` was itself the PRE-canonicalization value, which is why the
    // tuple kept moving) — so if any part of the derivation moves inputs that
    // were already canonical without a fixture change to match, this fails.
    // It is NOT an image pin: the real `DEFAULT_IMAGE_BUILD_ID` hashes real
    // base digests and real file bytes, and lives in image-contract.test.ts.
    expect(deriveBuildId(baseInputs())).toBe("05be4773f08299e9");
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
    const ref = resolveRuntimeBaseRef(realDockerfile());
    // TAG **AND** DIGEST since DF1.10 (#186 item 9): dependabot's docker
    // updater derives an update stream from the tag and cannot derive one from
    // a bare `@sha256:`, so the entry watching this base opened no PRs. Docker
    // ignores the tag when a digest is present, and `resolveBaseDigest` reads
    // the `@sha256:` suffix, so the pin is unchanged in substance.
    expect(ref).toMatch(/^ghcr\.io\/boldsoftware\/exeuntu:[^@]+@sha256:[0-9a-f]{64}$/);
    // The file is MULTI-STAGE now (the engine builder), and both stages derive
    // from this same ref — so `parseBaseRefs`' case-insensitive dedupe must
    // still yield exactly one base, or the buildId folds one digest in twice.
    expect(parseBaseRefs(realDockerfile())).toEqual([ref as string]);
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
  test("the real Dockerfile yields exactly one pinned base, despite two stages", () => {
    // Both the engine builder and the runtime stage name the same ref. One
    // entry, one registry resolution, one digest in the buildId.
    expect(parseBaseRefs(realDockerfile())).toEqual([
      "ghcr.io/boldsoftware/exeuntu:latest@sha256:ea6c3f5c65d4122408c504d6e6ea6e2afd4ac629557428e2bff1d3dcfe67beb2",
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

// mergeSweeps exists because S1 rig_swarm admitted a SECOND permitted npm
// tree (/opt/openrig/lib/node_modules) whose packages collide BY NAME with
// the engine's (yaml, zod) at different versions — so the sites are swept
// into separate scratch dirs and combined HERE, after the walk. What must
// hold: pure concatenation/summation, no dedup, no reconciliation — the
// NOTICE renders everything it is handed and the fail-closed lists are only
// ever checked for emptiness.
describe("mergeSweeps", () => {
  const mkSweep = (over: Partial<Parameters<typeof mergeSweeps>[0][number]>) =>
    ({
      treePackageCount: 0,
      entries: [],
      denied: [],
      covered: [],
      uncovered: [],
      unresolved: [],
      missingTexts: [],
      upstreamNotices: [],
      unreadable: [],
      pinViolations: [],
      piVersions: {},
      uncommonIds: [],
      licenseTexts: {},
      ...over,
    }) as Parameters<typeof mergeSweeps>[0][number];

  test("concatenates every list field and sums treePackageCount, without dedup", () => {
    const a = mkSweep({
      treePackageCount: 2,
      entries: [{ name: "yaml", version: "2.3.0", depPath: "yaml" }, { name: "zod", version: "3.0.0", depPath: "zod" }] as never,
      unreadable: ["tree-a-unreadable"],
      piVersions: { pi: "0.84.4" },
    });
    // The SAME package name at a DIFFERENT version — the openrig collision
    // mergeSweeps exists to preserve rather than overwrite.
    const b = mkSweep({
      treePackageCount: 15,
      entries: [{ name: "yaml", version: "2.8.3", depPath: "yaml" }] as never,
      unreadable: ["tree-b-unreadable"],
      piVersions: { "another-pkg": "1.0.0" },
    });
    const merged = mergeSweeps([a, b]);
    expect(merged.treePackageCount).toBe(17);
    expect(merged.entries.map((e) => `${e.name}@${e.version}`)).toEqual([
      "yaml@2.3.0",
      "zod@3.0.0",
      "yaml@2.8.3",
    ]);
    expect(merged.unreadable).toEqual(["tree-a-unreadable", "tree-b-unreadable"]);
    expect(merged.piVersions).toEqual({ pi: "0.84.4", "another-pkg": "1.0.0" });
  });

  test("an empty input list is the healthy empty sweep, and single-part is identity", () => {
    const empty = mergeSweeps([]);
    expect(empty.treePackageCount).toBe(0);
    expect(empty.entries).toEqual([]);
    expect(empty.unreadable).toEqual([]);
    const one = mkSweep({ treePackageCount: 3, unreadable: ["x"] });
    expect(mergeSweeps([one])).toEqual(one);
  });

  test("a piVersion seen in both sweeps at DIFFERENT versions JOINS; the same version merges as before (F-044)", () => {
    // The yaml/zod collision S1 rig_swarm admitted is the point of the join: a
    // naive spread kept whichever sweep came LAST, so the NOTICE attributed the
    // openrig tree's yaml@2.8.3 and the engine's yaml@2.3.0 — the version the
    // engine actually runs — shipped with no attribution at all. The join is
    // the same `"a, b"` convention sweepTree applies to same-name collisions
    // WITHIN one tree, so a consumer reading the joined value sees both
    // shipped versions attributed.
    const a = mkSweep({ piVersions: { yaml: "2.3.0", zod: "3.0.0" } });
    const b = mkSweep({ piVersions: { yaml: "2.8.3", zod: "3.0.0" } });
    const merged = mergeSweeps([a, b]);
    expect(merged.piVersions).toEqual({ yaml: "2.3.0, 2.8.3", zod: "3.0.0" });
    // Order-stable in the join, since the sweep order is the traversal order:
    // the reverse pairing joins the other way, so the rendered NOTICE is a
    // function of the input order, not of object-key mood.
    expect(mergeSweeps([b, a]).piVersions).toEqual({ yaml: "2.8.3, 2.3.0", zod: "3.0.0" });
  });

  test("sweeps DISAGREEING on a canonical licence text throw; agreeing sweeps merge (F-044)", () => {
    // licenseTexts is keyed by SPDX id and both sweeps resolve against the ONE
    // canonical oci/license-texts/ directory, so equal keys carry equal text by
    // construction — a differing value means the sweeps disagreed about
    // canonical bytes, and the old last-write-wins spread published whichever
    // NOTICE claim happened to be swept last. Refused, not reconciled.
    const disagree = () =>
      mergeSweeps([
        mkSweep({ licenseTexts: { MIT: "canonical MIT text" } }),
        mkSweep({ licenseTexts: { MIT: "a different MIT text" } }),
      ]);
    expect(disagree).toThrow(/two sweeps disagree on the canonical text for "MIT"/);
    // The refusal is ORDER-SYMMETRIC: whichever sweep is acc sees the other's
    // divergence, so a reordering cannot smuggle the disagreement through.
    expect(() =>
      mergeSweeps([
        mkSweep({ licenseTexts: { MIT: "a different MIT text" } }),
        mkSweep({ licenseTexts: { MIT: "canonical MIT text" } }),
      ]),
    ).toThrow(/disagree on the canonical text/);
    // Equal keys merge as before — the shape every real sweep produces.
    const agreeing = mergeSweeps([
      mkSweep({ licenseTexts: { MIT: "canonical MIT text" } }),
      mkSweep({ licenseTexts: { MIT: "canonical MIT text", Zlib: "zlib text" } }),
    ]);
    expect(agreeing.licenseTexts).toEqual({ MIT: "canonical MIT text", Zlib: "zlib text" });
  });
});

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
    expect(dockerfileArgDefaults(realDockerfile(), "PI_VERSION")).toEqual([PI_VERSION]);
  });

  test("the script's NODE_VERSION / OPENRIG_VERSION constants ARE the Dockerfile's ARG defaults (F-038 lockstep)", () => {
    // The S1 pair under the same discipline as PI_VERSION, with one extra
    // consumer: `validateBinaryLicenses` refuses a binary-licenses.json entry
    // whose version names another release, so a bump here has to move the ARG,
    // the constant AND the table in one change — the gatherBuildIdInputs loop
    // refuses a two-way divergence, and this pins the constant↔Dockerfile half
    // the way the PI_VERSION test above pins its own.
    expect(dockerfileArgDefaults(realDockerfile(), "NODE_VERSION")).toEqual([NODE_VERSION]);
    expect(dockerfileArgDefaults(realDockerfile(), "OPENRIG_VERSION")).toEqual([OPENRIG_VERSION]);
  });
});

// ───────────────────── buildId input-set completeness (COPY) ─────────────────────

/**
 * #186's third buildId gap, CLOSED. The file inputs used to be hand-enumerated
 * — the Dockerfile, plus everything under `oci/exedev/systemd/` — so an asset
 * `COPY`'d from anywhere else shipped bytes the identity did not cover: the
 * Dockerfile bytes moved ONCE when the COPY was added, and from then on every
 * edit to that asset shipped a different substrate under an unchanged buildId.
 * DF1.10's engine sources, pi catalog and `cli-anything/` are all exactly that.
 *
 * What used to be an inlined tripwire asserting "everything is under
 * oci/exedev/systemd/" is now a test of the PRODUCTION scan that feeds
 * `gatherBuildIdInputs`. The invariant it protects moved with it: not "nothing
 * else is copied" but "everything copied is hashed".
 */
describe("copyContextSources", () => {
  test("the real Dockerfile's context COPYs are all resolvable repo paths", () => {
    const sources = copyContextSources(realDockerfile());
    // Not vacuous: this Dockerfile really does COPY, so an empty list would
    // mean the scan broke rather than that the invariant holds.
    expect(sources.length).toBeGreaterThan(0);
    // Every one of them must exist, because every one of them is hashed. A
    // COPY of a path this checkout does not have is a build that fails ten
    // QEMU-emulated minutes later; here it fails in milliseconds.
    for (const src of sources) {
      expect(fs.existsSync(path.join(REPO_ROOT, src)), src).toBe(true);
    }
    // The assets DF1.10 added are in the set — the whole point of closing the
    // gap. Named individually so a COPY silently dropped from the Dockerfile
    // fails here rather than shipping an image with no engine in it.
    expect(sources).toContain("oci/exedev/systemd/qds-run@.service");
    expect(sources).toContain("cli-anything/scripts");
  });

  test("`--from=` copies are excluded: they take no bytes from the build context", () => {
    expect(copyContextSources("FROM a AS b\nCOPY --from=b /out/x /usr/bin/x\n")).toEqual([]);
    expect(copyContextSources("FROM a\nCOPY --from=busybox:1.36 /bin/busybox /bin/\n")).toEqual([]);
  });

  test("flags are not sources and the destination is not a source", () => {
    expect(copyContextSources("FROM a\nCOPY --chmod=0644 src/x.ts dst/y.ts /out/\n")).toEqual(["dst/y.ts", "src/x.ts"]);
  });

  test("trailing slashes and `./` prefixes normalise, so one path is one input", () => {
    expect(copyContextSources("FROM a\nCOPY ./src/ /out/\nCOPY src /out2/\n")).toEqual(["src"]);
  });

  test("comments and ADD are handled like COPY", () => {
    expect(copyContextSources("FROM a\n# COPY not/this /x\nADD src/x /y\n")).toEqual(["src/x"]);
  });

  test("REFUSES a line continuation rather than missing the sources on the next line", () => {
    // The sources may live on a line this one-line-per-instruction scan never
    // reads, and a silently short file set is exactly the gap being closed.
    expect(() => copyContextSources("FROM a\nCOPY \\\n  src/x /y\n")).toThrow(/continues a COPY across lines/);
  });

  test("REFUSES a glob, whose expansion is not knowable from this file", () => {
    expect(() => copyContextSources("FROM a\nCOPY src/*.ts /y/\n")).toThrow(/COPYs a glob/);
  });

  test("REFUSES JSON-form COPY rather than hashing the bracketed tokens verbatim", () => {
    // `COPY ["src/x", "/y"]` split on whitespace yields the token `["src/x",`.
    // The old scan added that string to the file set and `contextFilesUnder`
    // then died on a path with brackets and a quote in it — a fatal error, so
    // fail-closed, but one whose message was about a missing checkout rather
    // than about a Dockerfile shape this parser does not read.
    expect(() => copyContextSources('FROM a\nCOPY ["src/x", "/y"]\n')).toThrow(/JSON-form COPY/);
  });

  test("REFUSES a comment that ends in a continuation: the builder may swallow the next line", () => {
    // D1-3's first shape. BuildKit joins continuations before the comment
    // check, so `# note \` + `COPY src/x /dst` can be ALL comment — docker
    // never executes that COPY. The old scan hashed `src/x` from the second
    // line anyway: a false refusal when the path is absent, a spurious re-pin
    // when it is present, and never the same answer as the builder.
    expect(() => copyContextSources("FROM a\n# note \\\nCOPY src/x /y\n")).toThrow(
      /comment line that ends in a continuation/,
    );
  });

  test("a COPY-looking line that CONTINUES a previous instruction is shell text, not a COPY", () => {
    // D1-3's second shape. `RUN set -e; \` + a continuation line reading
    // `COPY src/x /y` is one RUN instruction; docker runs the second line as
    // shell text. The old scan treated it as a COPY instruction and hashed or
    // refused `src/x` — disagreeing with the builder in both directions.
    expect(copyContextSources("FROM a\nRUN set -e; \\\n  COPY src/x /y\n")).toEqual([]);
    // …and the skip is CONTINUATION-SCOPED: a real COPY after the continued
    // instruction ends is still read. A skip that ate the rest of the file
    // would be a new gap, not a fix.
    expect(copyContextSources("FROM a\nRUN set -e; \\\n  echo done\nCOPY real/z /w\n")).toEqual(["real/z"]);
  });

  test("REFUSES a backslash followed by trailing whitespace, which BuildKit does not continue on", () => {
    // `trimEnd()` made `\ ` at end of line read as a continuation here while
    // BuildKit's lexer does not treat it as one — the COPY on the next line
    // would be hashed-or-skipped as shell text while the builder runs it as
    // a fresh instruction (image bytes change, buildId does not). Refused,
    // the same refuse-don't-guess rule as every other continuation shape.
    expect(() => copyContextSources("FROM a\nRUN set -e; \\ \nCOPY src/x /y\n")).toThrow(
      /continuation backslash followed by trailing whitespace/,
    );
    // A tab after the backslash is the same not-a-continuation.
    expect(() => copyContextSources("FROM a\nCOPY src/x /y \\\t\n")).toThrow(
      /continuation backslash followed by trailing whitespace/,
    );
    // A backslash as the LAST byte still is a continuation — the refusal is
    // on the whitespace, not on the backslash.
    expect(() => copyContextSources("FROM a\nRUN set -e; \\\n  echo done\n")).not.toThrow();
  });

  test("a comment INSIDE a continued instruction does not sever the continuation", () => {
    // The comment blanks the line, which used to reset `continuing` — the
    // continuation's next line was then read as a FRESH instruction and its
    // COPY hashed as real, while the builder runs it as shell text. docker
    // skips the comment; the continuation carries through.
    expect(copyContextSources("FROM a\nRUN set -e; \\\n  # note\n  COPY src/x /y\nCOPY real/z /w\n")).toEqual([
      "real/z",
    ]);
    // A comment that itself ends in a backslash is refused in EITHER state —
    // mid-instruction is the same not-knowable join as at top level.
    expect(() => copyContextSources("FROM a\nRUN set -e; \\\n  # note \\\n  COPY src/x /y\n")).toThrow(
      /comment line that ends in a continuation/,
    );
  });

  test("REFUSES `..` sources, URL sources and the `# escape=` directive by name", () => {
    // Three shapes the token loop used to accept as context paths (D1-4,
    // D1-5, D1-8): a `..` segment walks out of the repository and would hash
    // parent-directory bytes (docker itself refuses it as outside the context);
    // an `ADD <url>` fetches bytes no context file ever held and died with a
    // missing-checkout message that named the wrong problem; and `# escape=`
    // changes the continuation character every `endsWith("\\")` here assumes.
    expect(() => copyContextSources("FROM a\nCOPY ../README.md /y\n")).toThrow(/leaves the build context via \.\./);
    expect(() => copyContextSources("FROM a\nADD https://example.com/certs.pem /etc/certs/\n")).toThrow(
      /ADDs a URL \(https:\/\/example\.com\/certs\.pem\)/,
    );
    expect(() => copyContextSources("# escape=`\nFROM a\nCOPY src/x /y\n")).toThrow(/`# escape=` parser directive/);
    // The URL refusal is on the SCHEME, not on any token containing `:` — a
    // path with a colon is a path.
    expect(copyContextSources("FROM a\nCOPY src/a:b /y/\n")).toEqual(["src/a:b"]);
  });

  test("REFUSES a heredoc, whose body can carry column-0 COPY text", () => {
    // The third continuation-class shape (blind finding, merged into D1-3):
    // a heredoc body line `COPY demo /opt/demo` is shell input, and the
    // line-oriented scan cannot tell it from an instruction. `fromInstructions`
    // refuses heredocs for FROMs; this scan now refuses them for COPYs.
    expect(() => copyContextSources("FROM a\nRUN cat > /opt/x.sh <<'EOF'\nCOPY demo /opt/demo\nEOF\n")).toThrow(
      /opens a heredoc/,
    );
  });

  test("REFUSES a bind-mount RUN, which reads context bytes this scan never hashes", () => {
    // `RUN --mount=type=bind,source=src/x,target=/y` is the one instruction
    // that feeds context bytes to a step WITHOUT a COPY — KNOWN GAP 3 reopened
    // through a grammar the scan does not speak. Refused by name (fail-closed,
    // same doctrine as globs/heredocs/URLs) until the scan learns mounts.
    expect(() =>
      copyContextSources("FROM a\nRUN --mount=type=bind,source=src/lib,target=/x cat /x/y.ts > /z\n"),
    ).toThrow(/mounts a context path into a RUN/);
    // The check is on the LINE, so a mount flag on a CONTINUATION line is
    // refused too — it binds the same bytes as one on the instruction's first
    // line, and a start-line-only check would be a new gap wearing a fix's name.
    expect(() => copyContextSources("FROM a\nRUN set -e; \\\n  --mount=type=bind,source=src/x cat x\n")).toThrow(
      /mounts a context path into a RUN/,
    );
    // `type=secret`/`type=cache` mounts read no context bytes and stay legal.
    expect(copyContextSources("FROM a\nRUN --mount=type=secret,id=k cat /run/secrets/k\nCOPY src/x /y\n")).toEqual([
      "src/x",
    ]);
  });

  test("REFUSES a bare `.` COPY source, which would walk `.git` into the buildId", () => {
    // The walk mirrors only `node_modules` of the `.dockerignore` exclusions,
    // so `COPY . .` hashes `.git` — and the buildId becomes a function of the
    // clone's packfile layout (loose vs packed objects) while docker excludes
    // `.git` from the context entirely. Two checkouts of one commit would hash
    // differently: an identity that is not a function of the tree.
    expect(() => copyContextSources("FROM a\nCOPY . /out/\n")).toThrow(/COPYs "\.", the whole build context/);
    // The `./`-prefixed and trailing-slash spellings normalise to the same
    // walk and are refused by the same rule.
    expect(() => copyContextSources("FROM a\nCOPY ./ /out/\n")).toThrow(/the whole build context/);
    // A `./name` source is a directory like any other — the refusal is on the
    // bare context root, not on the `./` prefix.
    expect(copyContextSources("FROM a\nCOPY ./src /out/\n")).toEqual(["src"]);
  });

  test("a `#` inside a path is a path character, not a comment introducer", () => {
    // Docker only treats `#` as a comment at the START of a line. The old
    // unconditional `raw.replace(/#.*$/, "")` disagreed: this COPY was read as
    // sourcing `src/a`, which is a different file from the one that ships (or
    // no file at all). Both readings fail closed, but only one of them is
    // docker's.
    expect(copyContextSources("FROM a\nCOPY src/a#b /out/\n")).toEqual(["src/a#b"]);
    // …and the leading-`#` case still works, which is the control for the line
    // above not having simply disabled comment handling.
    expect(copyContextSources("FROM a\n  # COPY not/this /x\nADD src/x /y\n")).toEqual(["src/x"]);
  });

  test("a repo path OUTSIDE the COPY set contributes NOTHING — the buildId's negative direction", () => {
    // Every other buildId row proves the id CHANGES. None proved it holds
    // STILL. Now that the file set is derived from the Dockerfile's own COPYs,
    // an over-broad scan would move the pin on unrelated commits and cost a
    // re-pin every time — a failure that is expensive, silent, and in the
    // opposite direction from everything else tested here.
    const sources = copyContextSources(realDockerfile());
    const names = new Set(buildIdFileInputs(realDockerfile()).map((f) => f.name));
    const covers = (src: string, p: string): boolean => src === p || p.startsWith(`${src}/`);
    for (const outside of [
      // The trigger-only asymmetry: the file a pin-adoption commit touches. If
      // this ever became an input the documented re-pin ritual would not
      // converge — the adoption commit would move the very id it adopts.
      "src/providers/exedev/driver.ts",
      // Not COPY'd, and both are large and edited constantly.
      "tests/scripts/build-exedev-image.test.ts",
      "docs",
      ".github/workflows/publish-exedev-image.yml",
      // The build script itself: a SOURCE_PATH (its constants are build args)
      // but deliberately not an image byte and not a buildId input.
      "scripts/build-exedev-image.ts",
    ]) {
      expect(sources.filter((s) => covers(s, outside)), `${outside} is under a COPY source`).toEqual([]);
      expect(names.has(outside), `${outside} is hashed into the buildId`).toBe(false);
    }
  });
});

// ─────────────────── buildId file-set assembly (past the scan) ───────────────

/**
 * What `copyContextSources` returns is a SOURCE LIST; what closes #186 gap 3 is
 * the walk that turns it into per-file inputs. Neither the walk nor the
 * `.dockerignore` input was exported or asserted, so a walk returning `[]` for
 * a directory source — or a lost `.dockerignore` entry — passed every test in
 * the block above while re-opening the gap its section header declares CLOSED.
 */
describe("buildIdFileInputs", () => {
  // Computed LAZILY, not at describe scope. The walk reads the WORKING TREE,
  // so a symlink or FIFO under a COPY'd directory (an editor artifact) threw
  // `BuildIdInputsError` during test COLLECTION — before any test ran — and
  // took the whole 2300-line file with it: every unrelated describe errored
  // with no test named. Here the throw lands inside the first test that asks
  // for the walk, and only the tests that ask share the failure.
  let walked: ReturnType<typeof buildIdFileInputs> | null = null;
  const files = (): ReturnType<typeof buildIdFileInputs> => {
    if (walked === null) walked = buildIdFileInputs(realDockerfile());
    return walked;
  };
  const names = (): string[] => files().map((f) => f.name);

  /**
   * The tracked-set probe for the digest pin at the bottom of this describe.
   * It runs at REGISTRATION time, not inside the test body: the pin used to
   * probe git in-body and `return` on failure, and bun records a returned body
   * as PASSED — so a host without a working git reported "the pin's whole
   * offline reach" as green without the tracked set ever being checked, the
   * one vacuous outcome that test exists to make impossible (its own comment
   * said so, then performed it). `test.skipIf` records a visible SKIP instead.
   * `-z` so a tracked path carrying bytes git would C-quote survives verbatim
   * and keeps moving the digest, rather than being silently dropped from the
   * pin's reach.
   */
  const GIT_LS_FILES = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
  // Truthy check on purpose: bun's `spawnSync` leaves `error` UNDEFINED (not
  // null) on success, so an `!== null` comparison reports success as failure.
  const gitUnavailable = Boolean(GIT_LS_FILES.error) || GIT_LS_FILES.status !== 0;
  const trackedSetDigest = test.skipIf(gitUnavailable);

  test("a DIRECTORY source is walked into its individual files", () => {
    // `cli-anything/scripts` is a directory COPY, and the whole point of the
    // walk is that editing one file under it moves the identity. A source list
    // check cannot see the difference between that and hashing the directory
    // name.
    const under = names().filter((n) => n.startsWith("cli-anything/scripts/"));
    expect(under.length, "cli-anything/scripts walked to nothing").toBeGreaterThan(0);
    expect(under).toContain("cli-anything/scripts/team-lead-driver.ts");
    // The directory itself is NOT an entry — it has no bytes to hash.
    expect(names()).not.toContain("cli-anything/scripts");
  });

  test("`.dockerignore` is an input, because it decides what a directory COPY contains", () => {
    // `contextFilesUnder` skips `node_modules` to mirror `**/node_modules`
    // here. The two exclusion sets have to move together, and hashing the file
    // that decides them is how a divergence becomes visible instead of silent.
    expect(names()).toContain(".dockerignore");
  });

  test("`node_modules` is skipped, and nothing is hashed twice", () => {
    // The invariant the digest needs is ORDER-STABILITY: walked names arrive
    // sorted, so the hash cannot depend on readdir's mood. Pinned against the
    // COMPARATOR-FREE default sort (code-unit order), not a re-spelling of the
    // implementation's comparator — a mirrored comparator would agree with any
    // collation change made in both places, while the pin below fails the
    // moment the walk's output stops being code-unit-sorted (the one ordering
    // that is host-independent and safe to feed a hash).
    expect(names().filter((n) => n.split("/").includes("node_modules"))).toEqual([]);
    expect(names()).toEqual([...names()].sort());
    expect(new Set(names()).size).toBe(names().length);
  });

  test("credential-pattern debris is skipped, mirroring `**/.env*`/`*.pem`/`*.key`", () => {
    // Untracked `.env`/key debris under a COPY'd tree is excluded from the
    // context by .dockerignore's recursive credential patterns; hashing it
    // anyway made the buildId a function of the CHECKOUT — one stray file
    // re-pinned a byte-identical image.
    //
    // The walk anchors at REPO_ROOT, so the fixture has to live inside the
    // repository — but NOT in a source tree any more. It used to plant
    // `.env.creds`/`test-fixture.pem` under the live `cli-anything/scripts/`,
    // where a run killed between the writes and the `finally` left
    // credential-shaped files for secret scanners to trip on and a careless
    // `git add -A` to sweep in. `oci/.build/` is git-ignored (see .gitignore)
    // and only its `exedev/` child is on .dockerignore's exclusion list, so a
    // crashed run here leaves debris git cannot see and no scanner sweeps.
    // The pattern-skip under test is name-based at any depth, so a fixture
    // COPY source exercises the same code the production tree does.
    const fixtureDir = path.join(REPO_ROOT, "oci/.build/qds-walk-fixture");
    const fixtureDockerfile = "FROM a\nCOPY oci/.build/qds-walk-fixture /out/\n";
    try {
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, ".env.creds"), "SECRET=1\n");
      fs.writeFileSync(path.join(fixtureDir, "test-fixture.pem"), "SECRET=1\n");
      // The skip is name-scoped, not extension-paranoid: a sibling file with
      // a clean name still walks.
      fs.writeFileSync(path.join(fixtureDir, "clean-name.txt"), "walked\n");
      const walkedNow = buildIdFileInputs(fixtureDockerfile).map((f) => f.name);
      expect(walkedNow.some((n) => n.endsWith(".env.creds") || n.endsWith("test-fixture.pem"))).toBe(false);
      expect(walkedNow).toContain("oci/.build/qds-walk-fixture/clean-name.txt");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("every entry carries real bytes read off disk", () => {
    // ALL of them, not a sample: the set is sorted and the systemd assets and
    // `.dockerignore` sort after the `cli-anything/` prefix, so a `slice(0, 50)`
    // never reached the entries a DF1.10-shaped change actually moves.
    // Buffer-ness is the claim — an empty file is a legitimate input that
    // `deriveBuildId` hashes as zero bytes, so `length > 0` here was a false
    // failure in the loud direction on a legitimately empty tracked file.
    expect(files().length, "the real input set is far larger than any spot-check").toBeGreaterThan(50);
    for (const f of files()) {
      expect(Buffer.isBuffer(f.bytes), f.name).toBe(true);
    }
  });

  test("a COPY source the checkout lacks THROWS a typed error, not a process exit", () => {
    // D1-1: every refusal on this exported surface used to `die(2)` —
    // `process.exit`, no unwinding — so a fixture that tripped one killed the
    // whole `bun test` run with exit 2 and no test named. The typed error is
    // what makes the fail-closed branches testable at all; `gatherBuildIdInputs`
    // remains the boundary that converts it back to `die(2)` for the CLI.
    expect(() => buildIdFileInputs("FROM a\nCOPY no/such/path/anywhere /out/\n")).toThrow(BuildIdInputsError);
    expect(() => buildIdFileInputs("FROM a\nCOPY no/such/path/anywhere /out/\n")).toThrow(
      /COPYs no\/such\/path\/anywhere, which this checkout does not have/,
    );
    // The same doctrine for the parser refusals the walk reaches.
    expect(() => buildIdFileInputs("FROM a\nCOPY src/*.ts /out/\n")).toThrow(BuildIdInputsError);
    expect(() => buildIdFileInputs("FROM a\nCOPY ../escape /out/\n")).toThrow(BuildIdInputsError);
    expect(() => buildIdFileInputs("FROM a\nADD https://example.com/c.pem /etc/\n")).toThrow(BuildIdInputsError);
    expect(() => buildIdFileInputs("# escape=`\nFROM a\nCOPY src/x /out/\n")).toThrow(BuildIdInputsError);
  });

  /**
   * THE OFFLINE HALF OF THE PIN, and the only thing in this repo that fails
   * LOCALLY when a buildId input moves.
   *
   * `DEFAULT_IMAGE_BUILD_ID` is asserted in exactly one place
   * (image-contract.test.ts) and both of that test's assertions compare repo
   * constants against a hardcoded literal — they catch a fixture disagreeing
   * with the constant, and cannot catch a STALE PIN. The real buildId cannot be
   * recomputed here: `baseDigests` needs registry resolution. So this pins the
   * INPUTS instead, for the subset that is deterministic on every checkout.
   *
   * DETERMINISTIC SUBSET, and the exclusion is not laziness: `buildIdFileInputs`
   * walks the WORKING TREE, so any untracked or git-ignored file under a COPY'd
   * subtree (`src/lib/.env.local`, an editor swap file, coverage output) is
   * hashed here while docker's `.dockerignore` strips it from the image — see
   * the open issue on `contextFilesUnder`. Snapshotting the whole set would
   * make this test fail on a dirty tree for a reason that is not a defect in
   * the change under test. The Dockerfile and the two systemd assets are
   * tracked, small, and are exactly the inputs a DF1.10-shaped change moves.
   *
   * WHEN THIS FAILS: an image input changed, so the published digest and
   * `DEFAULT_IMAGE_BUILD_ID` are both stale. Re-publish, adopt the new pin, and
   * update the digest below IN THE SAME COMMIT — the pairing is the ritual.
   */
  test("the tracked buildId inputs are the ones the current pin was derived from", () => {
    const PINNED: Record<string, string> = {
      // 47e9b084 / 24958f40: DF3.6b. The unit gains `Delegate=memory` (the
      // engine cannot create the resident's cgroup or write its `memory.max`
      // as User=exedev without it) and the Dockerfile gains the positive
      // `^Delegate=memory$` scan that fences it. Both are image inputs, so the
      // published digest and DEFAULT_IMAGE_BUILD_ID are stale until the image
      // is rebuilt and re-published — recorded as OPEN in the story's Dev Agent
      // Record, because this re-pin is the OFFLINE half of DF2.10's ritual and
      // the publish is the other.
      // 9ebe455f: S1 rig_swarm (feature/rig-swarm-phase, 2026-09-23). The
      // Dockerfile gains the node + OpenRig + self-compact runtime-stage
      // section after the engine-assertion RUN — a buildId input like every
      // byte of this file. The image itself is UN-PINNED on this branch by
      // design (NODE_SHA256/OPENRIG_TREE_SHA256 ship as MEASURE-AT-FIRST-
      // BUILD sentinels; no build has run), so this offline half of the pin
      // moves now while the publish/adoption half is the recorded post-merge
      // ritual — same shape as the DF2.10 open pairing the map above documents.
      // 9ebe455f: S1 rig_swarm (feature/rig-swarm-phase, 2026-09-23). The
      // Dockerfile gains the node + OpenRig + self-compact runtime-stage
      // section after the engine-assertion RUN — a buildId input like every
      // byte of this file. The image itself is UN-PINNED on this branch by
      // design (NODE_SHA256/OPENRIG_TREE_SHA256 ship as MEASURE-AT-FIRST-
      // BUILD sentinels; no build has run), so this offline half of the pin
      // moves now while the publish/adoption half is the recorded post-merge
      // ritual — same shape as the DF2.10 open pairing the map above documents.
      // 2b9b437e: PR #284 review round — the F-038/F-039/F-040/F-041/F-042/F-043
      // fixes (script-side NODE_VERSION/OPENRIG_VERSION constants + the two new
      // sentinel checksum ARGs, the pipefail tree-hash pipeline, the rig probe
      // hoisted above the tree measurement, the per-assert `|| exit 1`s). All
      // inside the file whose bytes this entry pins; measured on the final
      // tree, same-commit re-pin per the discipline below.
      //
      // ff2dcbcc: R0 first-build reconciliation (2026-09-24) — the engine
      // COPY set takes the S1 provider closure (credentials/driver/errors/
      // harvest/path-guard/quota/viz-guard; the #284 merge build refused at
      // the stage probe on openrig-swarm.ts:32, `bun build` resolves before
      // it tree-shakes, and the enumeration must carry every RESOLVED file —
      // seven, not the four the import sites alone suggest). Dockerfile
      // bytes only; measured on the final tree, same-commit re-pin.
      //
      // 919341b4: NODE_SHA256 sentinel → pin (same day, run 36031582204's
      // refusal, cross-checked against nodejs.org's SHASUMS256.txt line).
      // OPENRIG_TREE_SHA256 still sentinel — the node gate dies first by
      // Dockerfile order, so the tree measurement is the NEXT refusal.
      // Dockerfile bytes only; same-commit re-pin.
      //
      // a8805e0c: OPENRIG_TREE_SHA256 sentinel → pin (run 36032367862's
      // refusal; no external cross-check exists for an npm-resolved tree —
      // the refusal output IS the measurement). Both sentinels now carry
      // measured values; the un-measured state they guarded is gone.
      // Dockerfile bytes only; same-commit re-pin.
      // eca4a06f: PR #286 review round (feature/r0-image-convergence,
      // 2026-09-24) — comment-only rewording of the sentinel paragraphs in
      // the node + OpenRig sections: both ARGs have carried measured values
      // since a8805e0c (above), so "no build of this file has EVER run" and
      // "SENTINEL, NOT A PIN" had gone false on the page. No COPY, ARG or
      // RUN line moved; Dockerfile bytes only, re-pinned from this test's
      // own failing run. The trackedSetDigest below did not move: the
      // Dockerfile is not a files() entry and no walked COPY source
      // changed.
      //
      // ef691e7f: the repro fix (2026-09-24) — the openrig install RUN now
      // redirects npm's cache and logs to /tmp and ASSERTS /root/.npm absent:
      // cacache's wall-clock index bytes (time, resHeaders.date, etag) moved
      // the digest of every build — publish runs 36048175927 vs 36056831164
      // built the same source revision (identical buildId/builtAt/gitSha/
      // piSha256, license sweep and NOTICE byte-identical) yet landed 12
      // compressed bytes apart, so the pin-adoption healing run could never
      // converge. Dockerfile bytes only, re-pinned from this test's own
      // failing run; trackedSetDigest did not move (not a files() entry).
      //
      // 230ba65b: the R3-c repro fix (2026-09-25) — the same RUN now deletes
      // /tmp/node-compile-cache and ASSERTS it absent: rig --version's node
      // run materializes V8's compilation cache under /tmp, its content
      // varies between builds, and it shipped in the openrig layer (layer 59
      // of runs 36082995077 vs 36084574659: 12,415 blobs, 125,790
      // uncompressed bytes differing, same /opt/openrig tree hash both
      // runs). Dockerfile bytes only, re-pinned from this test's own failing
      // run; trackedSetDigest did not move (not a files() entry).
      // ee802669/26b5ce57 adoption (2026-10-01): #396 re-pinned OPENRIG_TREE_SHA256 —
      // Dockerfile bytes only, measured here; publish run 36876842343 pushed the pair.
      //
      // 056ad71c: m2.3 re-pinned OPENRIG_TREE_SHA256 8074bfe6 → 9f148862 (publish
      // run 37831713339's refusal; hono 4.13.13 + zod 4.6.5 caret floats) — bytes
      // only, so THIS entry moved while trackedSetDigest below did not. The commit
      // left this literal red on purpose ("stays red until the post-merge green
      // publish run"), but the post-merge publish run (37917090552) then refused at
      // the TOFU RUN again — the tree measures fa2284d1…bdb95d now, a third
      // float inside @openrig/cli@0.5.14's dependency range — so the
      // workflow-run-first sequencing deadlocked with the build it was waiting
      // for. Adopted offline from the failing run's Received
      // (adopter section 3b's own derivation: the diff prints the Received pairs).
      // OPEN PAIRING, now with a named next input: whoever adopts fa2284d1 into the
      // ARG moves these bytes again, and section 3b re-adopts this entry from that
      // failing run — the driver REF/BUILD_ID adoption stays owed behind it.
      "oci/exedev/Dockerfile": "def062876a50493e01d6bab1fabb9aa79c73884ddd5ff7ed57f2b87ea874aa37",
      "oci/exedev/systemd/qds-run@.service": "24958f4098d7f31b8efa8f6437744ef8946906ed142967e6d8c3221ffcc78d85",
      "oci/exedev/systemd/qds-steering.conf": "08a4f8b5f3290ef1b339a2e1efb730935b5da7cb6b7a7cbcc77b824d19c41145",
    };
    const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
    // The Dockerfile is its own `BuildIdInputs` field rather than a `files`
    // entry, so it is read here the way `gatherBuildIdInputs` reads it: bytes,
    // no encoding.
    const actual: Record<string, string> = {
      "oci/exedev/Dockerfile": sha(fs.readFileSync(path.join(REPO_ROOT, "oci/exedev/Dockerfile"))),
    };
    for (const f of files()) {
      if (f.name.startsWith("oci/exedev/systemd/")) actual[f.name] = sha(f.bytes);
    }
    // Compared as a MAP, so the failure names which asset moved and both
    // digests — not "a hash differs".
    expect(actual).toEqual(PINNED);
  });

  trackedSetDigest("a single digest over EVERY tracked walked input — the pin's whole offline reach", () => {
    // The three entries above pin the named assets; the walk yields 89
    // inputs (measured 2026-09-19 by calling `buildIdFileInputs` directly; it
    // was ~76 when this docblock was written), and the other 86 (src/**, cli-anything/**, scripts/lib/**,
    // package.json, bun.lock, …) are tracked files whose every edit moves the
    // real buildId — so a stale pin from editing any of them was caught only
    // at the paid publish gate, after a full QEMU build/push. One digest over
    // the sorted name→sha256 map covers them all.
    //
    // FILTERED TO `git ls-files`-tracked paths, which is what makes it
    // deterministic on a dirty tree: the untracked noise the docblock above
    // excludes (a `.env.local`, an editor swap file) is filtered out here
    // rather than excluded from the pin's reach. Working-tree BYTES of the
    // tracked files, because that is what a build from this tree hashes.
    // SKIPPED, never silently passed, on a host with no working git: the probe
    // above registers this body through `test.skipIf`, so the run's output
    // says "skipped" instead of bun recording an unchecked pin as green.
    const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
    const tracked = new Set((GIT_LS_FILES.stdout ?? "").split("\0").filter((l) => l !== ""));
    const hashed: Record<string, string> = {};
    for (const f of files()) {
      if (tracked.has(f.name)) hashed[f.name] = sha(f.bytes);
    }
    // Not vacuous: the tracked subset is the bulk of the walk, and a parser
    // break that emptied it would otherwise pin a digest of nothing.
    expect(Object.keys(hashed).length, "tracked walked inputs").toBeGreaterThan(50);
    const digest = sha(JSON.stringify(Object.keys(hashed).sort().map((k) => [k, hashed[k]])));
    // PAIRING DEBT, re-declared 2026-09-08 (the c120f77e shape). The previous
    // literal (c5a1b9c2…) moved for TWO tracked inputs, both named so the next
    // reader does not have to bisect:
    //
    //   1. `scripts/lib/run-lock.ts` — PR #238 (merged as 386e12d1) escaped the
    //      two raw NUL bytes that made the file read as binary, so `grep`
    //      returned nothing for EVERY pattern while two stories carried
    //      grep-authoritative DoD items over it. `scripts/lib/` is a directory
    //      COPY (Dockerfile :278), so that fix moved the walk — and #238 landed
    //      WITHOUT touching this literal, which left `dev` red. This test caught
    //      it, which is what it is for.
    //   2. `src/fleet/dispatch.ts` — a COMMENT-ONLY correction (`src/fleet/` is a
    //      directory COPY, Dockerfile :279, so comments move the digest too). The
    //      no-ceiling arm's unreachability argument claimed "dispatch never passes
    //      `keyCapMicroUsd`"; it has since DF3.2. The conclusion holds on B1's
    //      bound instead. Carried here deliberately rather than deferred: the
    //      re-pin was already owed by (1), so it cost nothing extra.
    //
    // Moved AGAIN by DF2.11 itself (this literal), by three walked tracked
    // inputs: `scripts/lib/run-lock.ts`, `src/fleet/approval-gate.ts`,
    // `src/fleet/fanout-primitive.ts` (the other DF2.11 edits are not COPY'd
    // walk inputs and do not move it). Moved once more by the DF2.11 review
    // round (same-commit re-pin): `scripts/lib/run-lock.ts` (acquire logging +
    // stranded-lock remediation) and `src/fleet/fanout-primitive.ts`
    // (timeout-arm remediation).
    //
    // ~~THE DEBT: the published image still ships the pre-#238 `run-lock.ts`.
    // The divergence is provenance-only, not behavioural — #238 escaped the
    // bytes rather than removing them, and they are a load-bearing cache-key
    // separator whose runtime value is unchanged. DEFAULT_IMAGE_REF still pins
    // the fourth adoption from gate B of run 34174243205 at src_sha fdb2b755
    // (3746998b… / 6f847d4e69b06b35). Publish → adopt is deferred ON PURPOSE:
    // DF2.11 takes a required `RunLockHandle` and will move
    // `scripts/lib/run-lock.ts` again within days, so one republish after
    // DF2.11 lands settles both. **DF2.11's DoD owns that republish** — this
    // comment is the hand-off, not a wish.~~
    //
    // DEBT SETTLED 2026-09-10 (kept struck-through, not deleted — provenance):
    // DF2.11 landed, its six review rounds re-pinned this literal each time, and
    // the SEVENTH pin adoption (706366c5, gate B of run 34536729175, the first
    // green build off the ea6c3f5c exeuntu base) republished the image with
    // post-#238 + post-DF2.11 `run-lock.ts` aboard. Live boot proof: b896eab4,
    // tier1-driver-lifecycle, isRepoPin:true, buildId a6278c4510cfc539.
    //
    // This literal is the FILE-INPUT hash, never the published image digest — the
    // two coexist unequally by design (4cc6dfcd pinned 54cfc974… here while the
    // pin read 04a9242a…).
    //
    // Moved AGAIN by the DF2-11 round-3 review pass: this round's fixes edited
    // walked COPY inputs in this working tree (`src/fleet/approval-gate.ts`,
    // `src/fleet/fanout-primitive.ts`), and the walk hashes working-tree bytes
    // of tracked files. NOT moved by this file's own `-z` hardening above —
    // that was verified set-neutral before adoption (newline-split and `-z`
    // split yield the identical 1691-entry tracked set here), so the unquoting
    // fix changes the PARSER, not the pin's input set.
    // Moved once more by the round-3 DEFERREDS closure (same-commit re-pin):
    // `src/fleet/verbs.ts` (status's exitCodes widened for A22). The round-3
    // deferred edits in `scripts/fleet.ts` and the test files are NOT walked
    // COPY inputs and do not move it.
    // Moved once more by the round-5 review-fix wave (same-commit re-pin):
    // `scripts/lib/run-lock.ts` (release's throw-safe errno coercion + the
    // reapTtlCache eviction sweeper) and `src/fleet/approval-gate.ts` (the
    // rebind shed arm, its sweptHere discriminator, and the shed-arm warn
    // line). Everything else the wave touched — `scripts/fleet.ts`,
    // `scripts/cap-hit-demo.ts`, `scripts/qds-cost.ts` — is NOT a walked COPY
    // input. PIN MOVES AGAIN with any further walked-input edit in this wave:
    // the close gate must re-run this pin after the last fixer lands.
    //
    // Moved AGAIN by DF2.12's own review rounds 1 and 3 (c1b6379e pinned this
    // literal; 9102b7c9 and 17fe4066 landed after it), both walked inputs:
    // `src/phase-engine/phases/dispatch-task.ts` (emitMoneyLine tee durability
    // + refusal isolation) and `src/phase-engine/steering.ts` (refusal
    // isolation, honest unpriced metering). NOT moved by the same rounds'
    // `src/providers/` edits — `cost-ledger.ts`, `cost-ledger-bridge.ts`,
    // `teardown.ts` are deliberately outside the COPY set (the Dockerfile
    // enumerates only `bounded-exec.ts` and `timeout.ts` from that directory),
    // verified against the live walk before adopting. Re-adopted mid-wave when
    // the engine-cluster fixer's own (uncommitted) edits to those same two
    // walked files moved it again — exactly the "close gate re-runs this pin
    // after the last fixer lands" case the paragraph above declares.
    //
    // THE LIMITATION, NAMED: "same-commit re-pin" is a discipline, not a
    // guarantee. This literal is computed over the WORKING TREE at run time,
    // so it attests the tree it was computed on and never the commit — a
    // walked-input edit landing in the same commit AFTER the literal was
    // computed leaves the author's own run green while the committed tree's
    // true digest differs. Nothing in the test can close that window; the
    // compensating control is procedural — edit walked inputs FIRST, re-pin
    // LAST, and the close gate re-runs this test on the final tree, which is
    // the only run whose green actually binds the commit.

    expect(digest, "a tracked buildId input moved — same ritual as above: re-publish, adopt, update this digest in the same commit").toBe(
      // 0c5509f3: moved from 72d8d83b by the DF2.13/DF2.14 merge (PR #254) —
      // `src/fleet/dispatch.ts` (B1 backstop bound + structuredErrorParts),
      // `src/fleet/fanout-primitive.ts` (invalid-cap ceiling + F15 invariant)
      // and `src/providers/credentials.ts` is COPY-adjacent context the walk
      // already carried.
      //
      // 122c7c0a: moved by DF5.3 (PR #258) and its review round. THIS PIN WAS
      // ALREADY STALE ON THE BRANCH BEFORE THE REVIEW — verified by re-running
      // this test against a clean `HEAD` (dc347863) with the whole working tree
      // stashed: still red. DF5.3 edited walked COPY inputs and never re-pinned,
      // which is exactly the "landed WITHOUT touching this literal, which left
      // `dev` red" failure the run-lock.ts paragraph above records. No reviewer
      // could catch it: this file is not in the PR's diff, so it is invisible to
      // a diff-scoped review. It surfaced only because the review's own close
      // gate runs the suite, which is the control the paragraph above calls
      // "the only run whose green actually binds the commit".
      //
      // The walked inputs DF5.3 moved, all under directory COPYs (`src/audit/`
      // is NEW, `src/fleet/` :279, `src/providers/` enumerated, `scripts/lib/`
      // :278): `src/audit/{chain,link-store,index}.ts` (new module),
      // `src/fleet/{dispatch,fanout-primitive,run-completion}.ts`,
      // `src/providers/{credentials,driver,harvest,reaper,teardown}.ts` and
      // `src/pr/push.ts`. The review round moved it again — same-commit re-pin,
      // adopted AFTER the last fixer landed, per the discipline named above.
      // `scripts/qds-audit.ts` and the test files are NOT walked COPY inputs.
      //
      // ^ CORRECTED, review round 2. That attribution list is WRONG about most
      // of its members, and a provenance note that names the wrong cause sends
      // the next re-pinner to bisect files that cannot move this hash. Verified
      // by calling `buildIdFileInputs(realDockerfile())` directly and testing
      // membership (75 inputs): of the files named above, ONLY
      // `src/fleet/{dispatch,fanout-primitive,run-completion}.ts` are walked.
      // `src/audit/` is NOT a COPY at all (grep the Dockerfile: there is no
      // `COPY src/audit/` line — the new module reaches the box through the
      // engine bundle, not the context), and `src/providers/` contributes
      // exactly `bounded-exec.ts` (:282) and `timeout.ts` (:302) — never
      // `credentials/driver/harvest/reaper/teardown.ts`. `src/pr/push.ts` is
      // not walked either. The `src/fleet/` half of the claim stands and is
      // sufficient to explain the move; the rest was inferred, not measured.
      //
      // 6fe02cde: moved by review round 2, by exactly ONE walked input —
      // `scripts/pipeline-run.ts` (COPY :277), the `witnessCorrelationBeside`
      // refusal for a present non-string `requestId`. Measured, not inferred:
      // every other file this round touched (`scripts/qds-audit.ts`,
      // `scripts/sandbox-{reap,teardown}.ts`, `src/audit/link-store.ts`,
      // `src/providers/{driver,teardown}.ts`, and all test files) was checked
      // against the live walk and is absent from it.
      //
      // f145ef42: moved by review round 3, by exactly TWO walked inputs.
      // Measured the same way (`buildIdFileInputs(realDockerfile())`, membership
      // tested against this round's 48 changed files — 2 hits, 46 misses):
      //   · `scripts/pipeline-run.ts` (COPY :277) — the N1 witness-read split
      //     (an environment fault degrades to a bare session, a malformed
      //     correlation still refuses), the guarded `startSession` fallback, the
      //     number-spelling `issueId` gate, the `issueUrl`-alone refusal, and
      //     the new `witnessEcho` helper that closes INV-RUN-5.
      //   · `src/fleet/dispatch.ts` (COPY :279) — the forwarded store
      //     remediation, the caught transient emit, the `closeAuditStore`
      //     ordering fix, the hoisted `auditSlug` guard, the wrapped setup-gate
      //     emit, the redacted open refusal, and the deleted private
      //     `auditNonEmpty` duplicate.
      // Everything else this round touched is absent from the live walk:
      // `src/audit/{chain,link-store}.ts`, `src/providers/{credentials,driver,
      // harvest,reaper,teardown}.ts`, `src/pr/push.ts`, `scripts/{qds-audit,
      // fleet,cap-hit-demo,sandbox-reap,sandbox-teardown}.ts`, and every test
      // file. Same measurement, same conclusion as the round-2 correction above.
      //
      // Adopted LAST, after the final fixer landed and on the same tree the
      // close gate ran (5,972 pass / 1 fail, the 1 being this pin before the
      // re-adoption) — the discipline the LIMITATION paragraph names.
      //
      // Still the FILE-INPUT hash, never the published image digest: no
      // republish is owed to make this pin honest, and DEFAULT_IMAGE_REF is
      // untouched by this PR. The box-side provenance debt that IS owed — the
      // published image ships the pre-DF5.3 `pipeline-run.ts` — is unchanged in
      // kind from the entries above and settles on the next adoption.
      //
      // 48d3b237: moved by the 2026-09-18 COPY-set convergence (the DF5.3
      // merge's publish refused at the engine stage's resolution probe —
      // `Could not resolve: "../src/providers/step-log.ts"` — because the
      // enumerated provider COPY set had fallen behind the engine's import
      // graph). The Dockerfile gained five COPYs —
      // `src/providers/{step-log,cap-rejection,run-record,fs-atomic}.ts` and
      // `src/swarmclaw/` — so the walk grew from 75 to 87 tracked inputs (the
      // five plus the transitive files under existing directory COPYs they
      // pulled in). Converged by the scratch-tree probe loop this file's own
      // Dockerfile comment documents; measured, not inferred, via
      // `buildIdFileInputs(realDockerfile())` on the tree this literal lands
      // with, same-commit re-pin per the discipline above.
      //
      // e42f4352: moved from 48d3b237 by DF3.6a — the resident spend/iteration
      // bounds. This story's engine-tree edits are all under directory COPYs
      // (`src/phase-engine/steering.ts` — the SEAM check, cause-union widening,
      // meter zero-usage arm, three additive deps, PlacementRefusedError, the
      // pre-correction re-gate; `src/phase-engine/manifest.ts` — the five
      // optional bound fields; NEW `src/phase-engine/resident-bounds.ts` —
      // enters the walk under the engine directory COPY) plus the walked
      // `src/fleet/dispatch.ts` (fill-side bound stamp + the
      // resident-ceiling-unfundable pre-provision refusal). Measured on the
      // FINAL tree (post self-review fixes) via the same failing-run receive
      // this file's discipline prescribes — same-commit re-pin.
      //
      // 5d5b84b6: moved from e42f4352 by DF3.6a's review round — the walked
      // inputs this round edited: `src/phase-engine/steering.ts` (INV-BND-3
      // mixed-shape charge keyed on metered.unpriced, withDeadline-bounded
      // onBoundBreach, below_one_call SEAM twin), `src/phase-engine/
      // resident-bounds.ts` (rate fail-closed validation, fifth-operand
      // validation, spend-wins precedence, projection_ms, runId row,
      // iterations() copy), `src/fleet/dispatch.ts` (link-2
      // resident-cap-above-backstop mirror + unfundable remediation text).
      // Same failing-run receive on the post-fix tree — same-commit re-pin.
      //
      // 8fb0156e: moved from 5d5b84b6 by DF3.8 (PR #265, a3011530) — the
      // walked inputs it edited, measured via `buildIdFileInputs` membership
      // over the merge's changed files (3 hits, every other changed file
      // absent from the live walk): NEW `src/fleet/observe.ts` (enters under
      // the `src/fleet/` directory COPY :279), `src/fleet/verbs.ts` (same
      // COPY), and `scripts/lib/run-lock.ts` (:278, COMMENT-ONLY — the
      // retired ponytail embedder note). The dp-scanner round's annotations
      // and every test file the merge touched are NOT walked inputs.
      // Received from this test's own failing run on the post-merge dev tree;
      // the adoption commit's driver.ts/test edits are outside the walk, so
      // the value the suite received is the value the committed tree hashes.
      //
      // 99af1da0: moved from 8fb0156e by the DF3.8 margin re-derivation
      // (feature/df3-8-margin) — ONE walked input, comment-only:
      // `src/fleet/observe.ts` (PROVISION_LAG_MARGIN_MS's docblock, OPEN
      // MEASUREMENT → RE-DERIVED; the constant's value is unchanged).
      // PAIRING DEBT, declared per the DF1.10 playbook: this moves on the
      // branch tree only; the merge's publish + adoption ritual re-pins the
      // IMAGE pair, and this literal rides that same ritual.
      //
      // b3c30d0c: moved from 99af1da0 — ALREADY STALE ON `dev` BEFORE DF5.4
      // cut its branch, verified the DF5.3 way: the whole working tree
      // stashed, the digest recomputed on the clean dev checkout (7f4854fb)
      // — b3c30d0c, byte-identical to the branch tree's. DF5.4 itself moved
      // NOTHING in the walk (intersection of the branch's 56 changed files
      // with the live `buildIdFileInputs` set: empty; the gate code, fixture,
      // tests, story artifact and `.unlazy/` are all outside the COPY set).
      // The mover is upstream of that branch — the DF3.8 margin merge
      // (#267) landing after the 13th-pin adoption, the same
      // landed-without-touching-this-literal shape #238 and DF5.3 hit. That
      // adoption WAS the same-commit re-pin the ritual names, taken on the
      // branch that happened to run the full suite next; no image republish
      // was owed BY IT (no walked bytes changed there) — a statement about
      // b3c30d0c only, and NOT about the entries below it, every one of which
      // DID move walked bytes. That does not make eight outstanding
      // republishes: the publish is owed per TREE, not per pin — the re-pin
      // happens once per landing tree (see "the re-pin happens LAST, after the
      // final fixer lands, rather than once per round" below) and the debt is
      // discharged once. DF3.6b's seven within-story pins share the single
      // `THE PUBLISH IS STILL OWED` below; DF6.1a declares one `PAIRING DEBT`
      // for 8b670a3d — and THAT ONE IS DISCHARGED. `dev`'s own tip (6ed796c9,
      // the fourteenth pin adoption) is the rebuild -> publish -> adopt it owed:
      // built at src_sha 1b653f04 with DF6.1a already merged in (#273,
      // de5a7509, is an ancestor of it), pushed as sha256:9c8bfe9a… / buildId
      // 52538541c5430cc5 — which is the DEFAULT_IMAGE_BUILD_ID this merge
      // inherits. So exactly ONE debt survives into the merged tree: DF3.6b's
      // four walked inputs are in no published image. A publisher rebuilds THE
      // MERGED TREE; 1e1b54a4 is not the thing they build — it is a digest over
      // walked-input BYTES, not a buildId and not an image digest, and it moves
      // for reasons (comment-only edits) that need no republish at all. It is
      // how you tell whether the tree moved, not what you publish.
      // RESTORED here: DF3.6b's first re-pin (1938e34b) wrote its own entry OVER
      // this paragraph, which left `b3c30d0c` the one value in the chain a reader
      // could not tie to a paragraph — exactly the invariant round 4 finding 3
      // established. The value itself is `origin/dev`'s and is unchanged.
      // COMPLETED by the dev merge: aa66e927 restored the paragraph but not its
      // closing sentences, which 1938e34b had taken with it. They survived on
      // `dev`, so the merge brought them back. Recorded because the shape is
      // ambiguous on inspection — text absent from this branch and present on
      // dev reads as a deliberate deletion, and a reviewer said so. `git log -S`
      // over 1c153883..HEAD says otherwise: the remover was the chain-break
      // commit, not an editorial one, and the repair that followed was partial.
      //
      // 7d44bbda: moved from b3c30d0c by DF3.6b. FOUR walked
      // tracked inputs — `oci/exedev/systemd/qds-run@.service`
      // (+`Delegate=memory`), `src/fleet/resident.ts` (the whole cgroup
      // mechanism), `src/phase-engine/steering.ts` (the OOM writer) and
      // `scripts/pipeline-run.ts` (the bound hand-off and the arming refusal).
      // `oci/exedev/Dockerfile` also changed in this story (the
      // `^Delegate=memory$` unit-scan fence) and is NOT one of them: it is
      // `deriveBuildId`'s own `field("dockerfile", …)`
      // (`scripts/build-exedev-image.ts:652`), while THIS literal is computed
      // strictly over `files()` — `buildIdFileInputs` (`:1544`) returns 89
      // entries and the Dockerfile is absent from all of them. Verified by
      // calling it directly rather than assumed; the grep-line edit added no
      // COPY, so the walk set is unchanged at 89. Named precisely because a
      // provenance note that blames a file which cannot move this hash sends
      // the next re-pinner to bisect files that cannot move it (the same
      // correction this ledger already carries above). Same failing-run
      // receive, same-commit re-pin.
      //
      // MOVED WITHIN THE STORY, twice, by COMMENT-ONLY edits to walked inputs —
      // `src/fleet/resident.ts`, `src/phase-engine/steering.ts` and
      // `scripts/pipeline-run.ts` — made while resolving review rounds 7 and 8.
      // Comment-only still moves this literal (the `99af1da0` entry above is the
      // same case), which is why the re-pin happens LAST, after the final fixer
      // lands, rather than once per round.
      //
      // bb3c3602: moved from 7d44bbda by DF3.6b, review round 12 — another
      // within-story move, COMMENT-ONLY again. ONE walked input changed:
      // `src/fleet/resident.ts` — in THREE places, not two. Two are in
      // `readLeaf()`'s documentation: its JSDoc (which presented the peak floor
      // as a co-equal third discriminator, the framing story ruling 9 denies,
      // and which sits ABOVE the body so none of the body's three
      // self-corrections ever reached it) and the body's setup paragraph (which
      // asserted "A THIRD FACT" twelve lines above its own ruling-9
      // correction). The THIRD is elsewhere in the file entirely —
      // `ResidentSpawnOpts`'s JSDoc for `residentRssBytes`, where "In
      // production it is never absent" was corrected for ruling 3b. Counted
      // exactly because this ledger exists to spare the next re-pinner a
      // bisect, and an entry that says "twice, both in `readLeaf()`" sends them
      // looking in one function for a hash three hunks moved. (Commit
      // `2dfedf49`'s own message makes the same undercount; this entry is the
      // correction, and `git show 2dfedf49 -- src/fleet/resident.ts` shows the
      // three hunk headers.) NOT movers, named so the next
      // re-pinner does not bisect them: `tests/fleet/resident-cgroup.test.ts`
      // (three rows fixed, one added) and the story artifact are outside the
      // walk, and `oci/exedev/Dockerfile` is `deriveBuildId`'s separate
      // `dockerfile` field as the entry above explains. Walk set unchanged at
      // 89 entries. Same failing-run receive, same-commit re-pin.
      //
      // 15effcd0: moved from bb3c3602 by DF3.6b, review round 14 — the first
      // within-story move that is NOT comment-only. ONE walked input changed,
      // `scripts/pipeline-run.ts`, and the edit is REAL: `inBoxFrontDoor` was a
      // module-level `let` set `true` before the in-box re-entry and never
      // reset; it is now a parameter of `main`. A covering review found it and
      // a second reviewer reproduced the leak — two sequential in-process
      // `main()` calls, where the second (host-side) call inherited the first's
      // `true` and was degraded by cgroup machinery it should never have
      // touched. Unreachable in the shipped CLI (one process per invocation),
      // which is why no test moved: the suites pass identically both ways.
      // NOT movers: `_bmad-output/evidence/df3-6b/review-round-14.md` and the
      // story artifact are outside the walk. Walk set unchanged at 89 entries.
      // Same failing-run receive, same-commit re-pin.
      //
      // f3548fdc: moved from 15effcd0 by DF3.6b, review round 15. ONE walked
      // input changed, `scripts/pipeline-run.ts` untouched this time: the
      // `removeLeaf` EBUSY backoff in `src/fleet/resident.ts` swapped
      // `Atomics.wait` on a throwaway SharedArrayBuffer for `Bun.sleepSync`.
      // BEHAVIOURALLY A NO-OP — the review finding that prompted it claimed
      // `Atomics.wait` throws on Bun's main thread, which was probed false on
      // Bun 1.3.13 and declined; the swap is readability, so the clever form
      // stops drawing that same wrong finding. NOT movers: the story artifact,
      // `df3-6a-resident-spend-iteration-bounds.md`,
      // `tests/providers/exedev/image-assets.test.ts` (one negative-control
      // row fixed) and `review-round-15.md` are all outside the walk. Walk set
      // unchanged at 89 entries. Same failing-run receive, same-commit re-pin.
      //
      // 99b541b3: moved from f3548fdc by DF3.6b, review round 16. ONE walked
      // input changed, `src/phase-engine/steering.ts`, COMMENT-ONLY: the
      // `PlacementRefusedError` docstring described the wrapper's failure as
      // `|| exit 97` — the form REJECTED during development — rather than the
      // shipped guard, which keys on membership read back from `cgroup.procs`.
      // It mattered enough to move a pin because that docstring sits on the
      // class a caller implements the contract against, and two prior rounds
      // swept for this wording and missed it. NOT movers: the story artifact
      // (several NOT-DONE consequence statements and a Shipped-table
      // overclaim — "the four AC3 refusals", where one of the four asserts the
      // OPPOSITE) and `review-round-16.md` are outside the walk. Walk set
      // unchanged at 89 entries. Same failing-run receive, same-commit re-pin.
      //
      // 660ae409: moved from 99b541b3 by DF3.6b, review round 17. ONE walked
      // input changed, `src/fleet/resident.ts`, and this one is STRUCTURAL, not
      // comment-only: `removeLeaf`'s bounded EBUSY rmdir retry was extracted
      // into `rmdirBounded(dir, rmdir = rmdirSync)` behind a
      // `_rmdirBoundedForTest` seam. Behaviour is unchanged — the default
      // remover is `rmdirSync` and the loop body is identical, verified by a
      // reviewer against the replaced code. The reason for the change is that
      // the loop was UNREACHABLE under the host-side suite: the fs-level fake
      // empties the leaf before `rmdirSync` runs, so EBUSY never occurs and the
      // attempt cap, errno check and backoff were dead code. Four rows now pin
      // the contract, all mutation-verified. NOT movers: the story artifact,
      // `tests/fleet/resident-cgroup.test.ts` and `review-round-17.md` are
      // outside the walk. Walk set unchanged at 89 entries. Same failing-run
      // receive, same-commit re-pin.
      //
      // THE PUBLISH IS STILL OWED:
      // the unit is baked into a digest-pinned image, so a run against the
      // currently pinned digest boots a unit with NO `Delegate=`, and the
      // resident refuses to start (DF3.6b AC3). Recorded as open in that
      // story's Dev Agent Record.
      //
      // 8b670a3d: moved from b3c30d0c by DF6.1a (feature/df6-1a-fix-loop-append)
      // — FOUR walked inputs, every one an adds-only edit, membership measured
      // against the live `oci/exedev/Dockerfile` COPY enumeration (:277-321):
      // `src/fleet/brief-schema.ts` (the allow-listed fixContext brief key,
      // under `COPY src/fleet/` :279), `src/fleet/dispatch.ts` (the witness
      // fixContext carry-through, same COPY), `src/phase-engine/phases/
      // dispatch-task.ts` (the engine-owned fenced prompt appendix + witness
      // read, under `COPY src/phase-engine/` :281), and
      // `src/providers/run-record.ts` (the three fixLoop registrations, the
      // explicit COPY :319). The branch's OTHER files are outside the walk:
      // `src/fixloop/` and `scripts/fix-run.ts` are host-side only and
      // CORRECTLY absent from the image (no COPY line owed — the in-box
      // renderer is dispatch-task.ts, which is in), `src/pr/`, `src/reverify/`
      // and `config/` name no COPY source. PAIRING DEBT, declared per the
      // DF1.10 playbook: walked bytes changed, so the rebuild → publish →
      // adopt ritual for `DEFAULT_IMAGE_BUILD_ID` (driver.ts:481) is OWED BY
      // THIS BRANCH before any box runs the new engine — DF6.1a's own live
      // e2e round (handoff `_bmad-output/plans/df6-1a-live-e2e-handoff.md`)
      // is the first such box, and the handoff names the republish as a
      // pre-round gate. Received from this test's own failing run on the
      // branch tree (twice: the branch gate's full-suite run and the targeted
      // re-run, byte-identical).
      //
      // 9d788c04: moved from 8b670a3d by feature/self-compact-pi-agent (the
      // self-compact vendoring + roster/extensionArgs wiring). FOUR walked
      // inputs, membership measured against the live `oci/exedev/Dockerfile`
      // COPY enumeration: `src/phase-engine/phases/roster-adapter.ts` and
      // `src/phase-engine/roster/schema.ts` (both under `COPY src/phase-engine/`
      // :281), `cli-anything/scripts/team-lead-driver.ts` (under `COPY
      // cli-anything/scripts/` :323), and `package.json` itself (:228 — the
      // bun-test explicit-dirs script edit, landed in two steps: the dirs
      // alone moved it ddd69531…→9d788c04…, then the required
      // --path-ignore-patterns carve-out — bun's path args are substring
      // filters, so the vendored tests/ dir still matched — moved it once
      // more before adoption). Measured, not inferred: the vendored prompt
      // and tests under `pi-vs-claude-code-vendor/self-compact/` are NOT
      // walked — that subtree contributes only `coms-core.ts` (:324) and
      // `pi-vs-claude-code-vendor/package.json` (:230) — and
      // `.github/workflows/ci.yml` and this test file name no COPY source.
      // Received from this test's own failing run on the final tree, after
      // the last walked-input edit landed (re-pin LAST, per the discipline).
      // Walked bytes changed, so the DEFAULT_IMAGE_BUILD_ID republish ritual
      // is owed by this branch before a box runs the new roster wiring —
      // same shape as the DF1.10/DF6.1a pairing-debt entries above.
      //
      // 9bc74b21: moved from 31f81dda by the final-review hardening pass on
      // the same branch — cli-anything/scripts/team-lead-driver.ts
      // (runWorkerPi argv-build hoist) and src/phase-engine/roster/schema.ts
      // (percent bounds + compaction-requires-extension gate), the only two
      // walked inputs the pass edits. Received from this test's own failing
      // run on the final tree (re-pin LAST; the reviewer's mid-branch
      // 653fa603 was superseded by the pass's own edits and never adopted).
      //
      // 1e1b54a4: MERGE of `dev` into this branch (2026-09-20). Two chains meet here, and
      // NEITHER side's literal survives: both branched from b3c30d0c and both
      // moved walked inputs, so the merged tree carries DF3.6b's four
      // (`qds-run@.service`, `resident.ts`, `steering.ts`, `pipeline-run.ts`)
      // AND DF6.1a's four (`brief-schema.ts`, `dispatch.ts`, `dispatch-task.ts`,
      // `run-record.ts`) at once. That is eight distinct walked inputs relative
      // to b3c30d0c, a tree neither 660ae409 nor 8b670a3d was ever computed
      // over. The value below is RE-DERIVED from the merged tree by this test's
      // own failing run, not carried across from either parent — carrying
      // either one would pin a hash for a tree that does not exist.
      // Both parent paragraphs are kept above so each digest still ties to the
      // change that produced it; this entry is the join, not a replacement.
      //
      // MERGE of `dev` into feature/self-compact-pi-agent (2026-09-23). Two
      // chains meet here and NEITHER parent's literal survives: this branch
      // carries the self-compact chain's walked inputs (`roster-adapter.ts`,
      // `roster/schema.ts`, `team-lead-driver.ts`, `package.json`) while dev
      // carries DF3.6b's four and DF6.1a's four (`qds-run@.service`,
      // `resident.ts`, `steering.ts`, `pipeline-run.ts`, `brief-schema.ts`,
      // `dispatch.ts`, `dispatch-task.ts`, `run-record.ts`) — the joined tree
      // is one neither parent pin was ever computed over. The merge's own
      // edits (`ci.yml` batch-root invocation, this test file) name no COPY
      // source and contribute nothing walked. The value is RE-DERIVED from
      // the joined tree by this test's own failing run. KEPT: every parent
      // paragraph above, per the join, not a replacement.
      //
      // aaa26243: S1 rig_swarm (feature/rig-swarm-phase, 2026-09-23). Moved
      // by the runtime stage's node/OpenRig/self-compact section — the
      // Dockerfile itself (already pinned in the map above) and ONE new
      // walked COPY source (pi-vs-claude-code-vendor/self-compact/extensions/
      // self-compact, added to both publish-workflow lists in the same
      // change). RE-DERIVED from this test's own failing run on the final
      // tree. The image this tree describes is deliberately UN-PINNED until
      // the first real build measures the sentinel ARGs — see the Dockerfile's
      // S1 section and the PR's pairing-debt note.
      //
      // 9321ec75: PR #284 review round (feature/rig-swarm-phase,
      // 2026-09-24) — the wave-1 fixers' walked-input edits plus the F-038
      // Dockerfile bytes this file's map pins above. RE-DERIVED from this
      // test's own failing run on the review tree, adopted LAST after this
      // file's own edits landed (this test file is NOT a walked input, so
      // nothing here moves it). The image remains UN-PINNED per the
      // aaa26243 note — the sentinel measurement / publish / adoption ritual
      // is the recorded post-merge debt.
      //
      // da700724: moved from 9321ec75 by the same review round's LAST edits
      // on walked files — the teardown hybrid-spend composition
      // (src/providers/teardown.ts) and the biome useTemplate rewrites
      // (src/phase-engine/phases/openrig-swarm.ts), both under walked COPY
      // sources. RE-DERIVED from this test's own failing run on the final
      // tree (re-pin LAST, per the discipline). The image stays UN-PINNED
      // per the aaa26243 note.
      //
      // a9f9039e: moved from da700724 by the R0 first-build reconciliation
      // (2026-09-24): the S1 merge itself had ALREADY left this pin stale —
      // verified against a clean HEAD (7957e8a4) with the working tree
      // stashed, still red, the DF5.3 shape again — because the S1 wave
      // edited walked COPY inputs (src/phase-engine/**, src/fleet/dispatch.ts,
      // scripts/pipeline-run.ts, src/providers/{credentials,teardown}.ts) and
      // re-pinned the per-asset Dockerfile map but missed this whole-walk
      // literal. This convergence adds SEVEN walked inputs (the engine COPY
      // set takes credentials/driver/errors/harvest/path-guard/quota/
      // viz-guard, with both workflow lists following) and re-pins both
      // halves. RE-DERIVED from this test's own failing run on the final
      // tree, adopted LAST (this file is NOT a walked input). The image
      // stays UN-PINNED per the aaa26243 note.
      //
      // 4906cc92: moved from a9f9039e on feature/r0-live-swarm-test by the
      // R0.7 live-round fixes (2026-09-25) — three walked-source edits the
      // first ten rounds root-caused: deliverSeatKeys's append arm
      // (src/providers/credentials.ts: mkdir the dirname + own the 0600
      // mode), the gate's seat-key probe seam (host-side only, NOT walked),
      // and pipeline-run.ts's resident arming (a rig_swarm manifest
      // disarms — invariant 2). PAIRING DEBT DECLARED per the DF1.10
      // playbook: this tree's image is intentionally unpublished; the merge
      // triggers the publish, gate B prints the next pin, and the adoption
      // ritual closes the debt. RE-DERIVED from this test's own failing run
      // on this tree.
      //
      // 390104f0: moved from 4906cc92 by the round-11/12 forensics fix —
      // openrig-swarm.ts's materialized rig.yaml/agent.yaml now carry the
      // fields OpenRig 0.5.14's import validator requires (version, pods[]
      // .label, member agent_ref/profile, agent profiles map; the authored
      // shape was refused validation_failed 4.7s into the phase, before any
      // seat launched), and the workdir probe prefers src/ (the repo) over
      // app/ (the env dir). Same playbook: debt declared, the merge
      // publishes, gate B prints the pin, adoption closes it.
      //
      // e04db606: moved from 390104f0 by the round-12 forensics fix — the
      // rig import now retries a refused body (healthz answers while the
      // daemon is still initializing; the phase's first import raced that
      // init ~6s in, the identical yaml imported on replay) and the error
      // carries the last response body instead of discarding stdout.
      // Debt declared; the merge publishes, adoption closes.
      //
      // b424be86: REPLACES e04db606, which was pinned BEFORE the review
      // round's final commit (70c0a9e6, the retry loop's exit/deadline
      // hardening) edited openrig-swarm.ts again — a walked input — and the
      // walk suite was not re-run on that final tree, so #300 merged a
      // stale whole-walk literal. Miss owned: "re-pin LAST" means the LAST
      // commit. RE-DERIVED from this test's own failing run on clean dev
      // (873387db) and adopted on the twentieth-pin branch, whose remaining
      // diffs (exedev driver.ts, image-contract.test.ts) are NOT walked —
      // so this value binds the healing tree too.
      //
      // 04da51d5: moved from b424be86 by the round-14 fix — the import loop
      // now ADOPTS `rig_name_running` as success (invariant 1: on a
      // dedicated per-run box the collision is our own prior attempt's
      // server-side success whose response was lost; round 14 launched both
      // seats then died on the collision). Computed on the FINAL branch
      // tree, after every other edit.
      //
      // 17246e12: moved from 04da51d5 by the review round's ownership arm —
      // adoption additionally requires curl exit 0 AND every expected seat
      // session live in tmux before the collision is treated as ours.
      // Computed on the FINAL branch tree, after every other edit.
      //
      // 43c9600a: moved from 17246e12 by the round-15 fix — the queue-create
      // parser reads the daemon's real id field `qitemId` (queue-repository
      // row mapping; the phase died on `id`/`qid`, keys the daemon never
      // emits). Computed on the FINAL branch tree, after every other edit.
      //
      // 7bd88619: moved from 43c9600a by the round-17 fix — parseQueueShow
      // slices the JSON object out of possibly warning-prefixed stdout (the
      // real daemon emits pretty JSON; four exit-0 polls parsed null on a
      // state field that was demonstrably there), and stale polls now trace
      // their raw output. Computed on the FINAL branch tree.
      //
      // 6ad173cb: moved from 7bd88619 by the round-18 fix — the phase mirrors
      // its swarm_settled + swarm_seat_cost trace rows to STDERR (they are
      // durable in <runId>.engine.log; the tracer's rows live in the
      // pre-settle JSONL stream that the engine's final journal doc replaces,
      // which is why round 18's settled-ok journal held zero swarm rows).
      // Computed on the FINAL branch tree, after every other edit.
      //
      // c3e60c10: moved from 6ad173cb by the review round's guard — the
      // stderr mirror goes through a guarded helper (a failed stderr write
      // must not replace the settled verdict, and the seat-cost mirror sits
      // before teardown). Computed on the FINAL branch tree.
      //
      // 21af9278: moved from c3e60c10 by the round-20 durability fix — the
      // mirror routes through deps.emitMoneyLine (in-box = moneyLineTee =
      // writeAll(2) = the engine-log tee; plain process.stderr.write bypasses
      // the tee and reaches journald only, which is why rounds 19-20 saw no
      // rows in engine.log). Computed on the FINAL branch tree, after every
      // other edit.
      //
      // 9f55e706: the re-landing of a value a834d6e7 DELETED — the
      // twenty-sixth-pin adoption's docs follow-up staged only driver.ts and
      // silently reverted the walk entry the adoption had just committed
      // (exactly the "landed WITHOUT touching this literal" failure the
      // run-lock paragraph above records; #316's healing run stayed green
      // because scripts/fleet.ts is not a SOURCE_PATHS member, hiding the gap
      // until this offline receive). MEASURED TWICE on the post-#317 dev tree
      // (39b66d84): no walked input differs from the tree 9f55e706 was first
      // received on — the #315/#317 deltas (openrig-cost.ts, scripts/
      // fleet.ts, test files) are either already in 9f55e706 or outside the
      // walk — so the dropped value IS the committed tree's digest. First
      // receive attempt read c51554d9 off a tree with unrelated working-tree
      // dirt; the discipline paragraph above is why a second receive, on a
      // verified-clean tree, is the binding one.
      //
      // 6121efeb: the S2 buildout (2026-09-27/28) — coms-core.ts identity
      // fallback (#347), the member-env patch applier + its Dockerfile COPY/
      // RUN + the OPENRIG_TREE_SHA256 re-pin to e2cb427c (#349), and the
      // S2.2-S2.7 engine-source deltas (#348/#350/#351) all move walked
      // inputs. Measured offline over the post-re-pin tree (108 tracked
      // inputs; the value below is the test's own trackedSetDigest oracle's
      // output on that tree, received from its own failing run).
      //
      // a1af12ce: the Q1 service surface (2026-09-28) — submit/result/cancel
      // verbs (src/fleet/submit.ts, result.ts; scripts/fleet.ts arms), the
      // workId identity (brief-schema + issue-correlation + tracer), the
      // budget-group ledger tables, and the quota-intent wiring all move
      // walked inputs. Measured offline over the verified-clean tree. (The
      // post-Q1 CI build refused at the resolution probe BEFORE publishing:
      // quota.ts's import closure gained quota-intents.ts and the engine
      // stage's COPY enumeration lacked it — the run printed no pin.)
      //
      // 23e4a959: the COPY-enumeration repair (Dockerfile engine stage +
      // the workflow's on.push.paths and SOURCE_PATHS lockstep) — the
      // Dockerfile bytes are one walked input, so the enumeration fix moves
      // this digest. Received from this test's own failing run on the
      // post-repair tree; the rebuild adopting THIS value is SC2's
      // prerequisite (the baked engine must match the delivered surface
      // before a live round).
      //
      // c4db474b: the PR #404 CI-debt closeout (2026-10-02) — walked inputs
      // touched were `package.json` (check:coverage run widened: the four
      // hidden-file suites of the reverify/judgment/corpus trees joined it)
      // and `scripts/judgment/live-probe.ts` (main/diffEnvelope exported for
      // the probe-gate suite). The bunfig.coverage.toml and tests/ edits of
      // the same round are NOT walked COPY inputs. Received from this test's
      // own failing run on the final tree, per the re-pin-last ritual above.
      //
      // 90250820: M1.2 (2026-10-06) — walked COPY inputs touched were
      // `src/fleet/brief-schema.ts` (optional kgContext field), and
      // `scripts/pipeline-run.ts` + `src/fleet/run-completion.ts` +
      // `src/fleet/dispatch.ts` (kgContext witness carriage + render). NOT
      // walked: src/hindsight/** (host-only), src/audit/link-store.ts,
      // scripts/fleet.ts, src/providers/teardown.ts (outside the COPY set).
      // The image re-publish half of this ritual is OPS-side and operator-
      // gated (story Technical Notes) — it must run on a tree containing
      // M1.2 BEFORE the next T2 live round fires a box.
      //
      // 02debde5: m2.2 + m2.3 (merged as #416/#418) added FOUR walked COPY
      // inputs and edited none (measured: map-diffed this literal's tree
      // against 69c09821's — 4 added, 0 changed, 0 removed):
      //   · NEW `pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/
      //     {client,kg-recall,sanitize}.ts` — m2.2's in-box kg_recall
      //     extension, COPY'd at Dockerfile :1117;
      //   · NEW `src/fleet/retain-best-effort.ts` — m1.2's CodeRabbit
      //     round-4 (affc88c0), under the `src/fleet/` directory COPY :279,
      //     landed after the 90250820 literal was computed on its branch's
      //     final tree (the LIMITATION window above, at add-a-file
      //     granularity: a new walk member never existed to be re-pinned).
      // NOT walked: everything else m2.2/m2.3 touched — the test files,
      // `src/hindsight/**` (host-only), `scripts/provision-hindsight-banks.ts`,
      // `_bmad-output/**`. The Dockerfile's OPENRIG_TREE_SHA256 re-pin
      // (056ad71c) moved the map entry above, not this digest (own field).
      // Received from this test's own failing run — the adopter's section-3
      // derivation ("not in the gate log — measure by running the test") —
      // on the verified tree; 111 → 115 tracked inputs. The publish/
      // adoption half stays owed: run 37917090552 refused at the TOFU RUN
      // (fa2284d1…bdb95d) before its gate, so no image exists to adopt.
      // 7d4002dc: m3.1 PR #422 coverage-gate repair — the only walked input
      // that moved is `package.json` (the check:coverage run widened:
      // tests/reverify, tests/p0-9, tests/hindsight, tests/memgate and
      // tests/pr join the gate; see bunfig.coverage.toml's 2026-10-09 block
      // for the run-vs-measured root cause). Everything else m3.1 touched is
      // NOT walked (scripts/p0-9/leg-lib.ts, scripts/provision-hindsight-
      // banks.ts, src/hindsight/**, tests/**, _bmad-output/**), per the map
      // above; bun.lock untouched. Received from this test's own failing run
      // on the final tree; the publish/adoption half is unchanged — still no
      // image exists to adopt (37917090552's refusal predates this), so the
      // offline half moves alone, same shape as the open pairing above.
      // f8835759: a5 coverage-gate widening (C9) — again the only walked input
      // that moved is `package.json` (tests/kpi joined the check:coverage run;
      // bunfig.coverage.toml's 2026-10-11 block). src/kpi/**, scripts/qds-kpi.ts
      // and scripts/lib/kpi-retain.ts are NOT walked — none is a COPY'd asset —
      // so the story's no-image-pin claim holds for the feature code; only the
      // gate-scope edit moved the set. Received from this test's own failing run
      // on the final tree; the publish/adoption half is unchanged — still no
      // image exists to adopt, so the offline half moves alone again.
      // e2dc33cd: a5 review-round fix commits (e3756647, 3bf8fd04) moved it
      // again — the walk granularity bit: oci/exedev/Dockerfile COPYs
      // scripts/lib/ as a DIRECTORY (:278), so scripts/lib/kpi-snapshot-write.ts
      // (new, the R2-02 write-leg split) entered the set and kpi-retain.ts's
      // round-1/2 rewrites moved its bytes. src/kpi/** (incl. dimensions.ts)
      // is still NOT walked — no COPY line reaches it. The story's
      // engine-reachability claim holds for the feature code; the
      // scripts/lib/ splits are the walked delta. Received from this test's
      // own failing run on the final tree; publish/adoption still owed
      // operator-side (no image exists to adopt).
            //
            // 91eabeb3: moved from e2dc33cd by Z5 chassis-fate (log/maskEnv
            // relocation to src/lib). Measured via `buildIdFileInputs`
            // membership over the branch's changed tracked files — 21
            // walked-input edits: 20 import-path-line-only re-points plus
            // `src/swarmclaw/mcp/tool-bridge.ts`, whose edit is a re-point
            // AND the mandated 19-line maskEnv block deletion. The 20 pure
            // re-points: `src/fleet/{approval-gate,dispatch,fanout-primitive,
            // fanout,observe,retain-best-effort,run-completion,status,submit}.ts`
            // (9), `src/providers/{credentials,driver,harvest,quota,
            // run-record,step-log}.ts` (6), and five of the six swarmclaw
            // files (`index`, `mcp/stdio-transport`, `routes/agents`,
            // `routes/mcp-servers`, `store/mcp-store`). The walk's
            // COMPOSITION moved too: the origin log module left it (origin
            // deleted) and NEW `src/lib/{log,mask-env}.ts` entered it (both
            // under directory COPYs). Measured on the committed tree
            // (e9321a6c..HEAD = 124 files): 23 walk members among the changed
            // files, the other 101 absent — outside the COPY enumeration
            // entirely: every test file, `scripts/**`, `visualizer/**`, and
            // 22 `src/` files (hindsight ×7, audit ×2, judgment, learning,
            // memgate, reverify, and 9 non-COPY'd providers including the
            // exedev trio). Received
            // from this test's own failing run on the post-wave-3 tree;
            // re-pinned by the driver at integration per the same-commit
            // ritual above.
            //
            // 3fcd0fca: moved from 91eabeb3 on adoption-commit day, recorded
            // EMPIRICALLY per the ritual above: 91eabeb3 was received twice on
            // the uncommitted post-wave-3 working tree; the only content deltas
            // between that tree and the committed one were NON-walked (the
            // scripts/dev portability patch — measured absent from the walk —
            // and this file's own provenance-comment scrub), yet the digest
            // moved on the committed tree. The walk reads the working tree's
            // TRACKED walk set, so the adoption commit itself is the tree this
            // literal binds. Any further walked-input edit moves it again and
            // the close gate re-runs this pin on whatever tree is final then.
            //
            // 25e068ee: moved from 3fcd0fca by the review round 1 fix wave —
            // ONE walked input: `src/swarmclaw/mcp/tool-bridge.ts`'s :2 header
            // scrub (the stale "mask secrets (INV-SC5)" claim replaced with
            // the post-extraction truth, per the blind-hunter finding). The
            // round's other edits are absent from the walk: hindsight/client.ts
            // is not COPY'd, the guard/test files are tests/, the dev scripts
            // are not walked. Adopted LAST, after the wave's final edit landed,
            // on the tree the close gate runs — the discipline above.
            //
            // 2328187: moved from 25e068ee by review round 2 — ONE walked
            // input: `src/swarmclaw/mcp/tool-bridge.ts`'s :3 header completed
            // ("routes AND hindsight import the masking primitive directly" —
            // the blind-hunter half-truth finding). Everything else this round
            // touched is absent from the walk: the dormancy/mask-env test
            // files, the dev scripts, visualizer/server (not COPY'd). Adopted
            // LAST on the final tree, per the discipline above.
            // J3 adopted 2026-10-14: the routing layer's adds-only dispatch/schema/
      // judgment-surface changes moved the walked inputs (deriveBuildId). The
      // IMAGE RE-PUBLISH stays ops-gated (wave-0 ritual: J3 + J4 + A2 + the
      // M2.2 surface, DD-28.26(4)); only the pin adopts here.
      //
      // 9c3d5ba: moved by G1 (ADR-2 verdict + policy). G1's true move is
      // 37e749e -> 9c3d5ba over TWO walked inputs, both priced by the story:
      // `src/fleet/auto-merge-policy.ts` (new — the fail-closed loader,
      // never-auto-merge predicate, QA-verdict consumption pin) and
      // `src/fleet/run-completion.ts` (adds-only ADR-2 consult before gate
      // registration, adds-only — zero deleted lines; the consult region grows
      // with review-round hardening, so read the actual diff, not this prose).
      // Everything else G1 touched
      // is absent from the walk: docs, tests. Image re-publish rides the
      // ops-gated wave-0 ritual with J3/J4.
      //
      // 37e749e: moved by J4 (host-side judgment pack). NOTE: the J3 literal this
      // replaces (285156f) was already stale on origin/dev 5b03a7b7 — J3's CodeRabbit
      // round-3 commit dac6e6c2 edited the walked input src/fleet/dispatch.ts
      // without a re-pin (dev's real digest b34dc6b; dev's own pin test red).
      // J4's true move is b34dc6b -> 37e749e, over TWO walked inputs, both
      // adds-only and priced by the story (AC4): `src/phase-engine/steering.ts`
      // (fifth `compact` member, two POINT_ALLOWLIST entries, the resident-
      // origin refusal, `directiveAllowedAt`, resident-facing rejection text)
      // and `src/fleet/observe.ts` (the budget-aware `onTick` seam, invoked
      // after the run lock is released, deadline clamped to the pass budget). Everything else J4 touched is absent
      // from the walk: src/autonomy/, scripts/fleet.ts, scripts/corpus/, docs,
      // tests. Image re-publish rides the ops-gated wave-0 ritual with J3.
      "9c3d5ba7aa6f72e32657fce285826d834164886b820bcf0f1af2d1b201d306d9",
    );
  });
});

// ───────────── the publish workflow's lists vs the Dockerfile's COPYs ────────

/**
 * The publish workflow keeps TWO enumerations of the image's sources — the
 * `on.push.paths` trigger and `SOURCE_PATHS` in "Resolve the image source
 * revision" — and its own comment claims they are "enumerated to match the
 * Dockerfile's COPY set exactly". They were not: `src/providers/timeout.ts`
 * (added at DF1.10's first real build) and three workspace `package.json`s were
 * COPY sources, hence buildId inputs, hence image bytes, in NEITHER list.
 *
 * The consequence was not a missing CI run. It was that editing one of them
 * changed the image and its identity, triggered no publish, and did not move
 * `src_sha` — so the next publish would bake a `QDS_GIT_SHA` and
 * `SOURCE_DATE_EPOCH` naming a revision that PREDATES the content it shipped,
 * and `/etc/qds-image.json` would describe bytes that revision cannot
 * reproduce.
 *
 * Asserted here rather than left to review, because "keep these three lists in
 * lockstep by hand" is the instruction that already failed once.
 */
describe("publish-exedev-image.yml covers every COPY source", () => {
  // Read lazily, like `realDockerfile()` above: this describe body runs at
  // COLLECTION time, and a module/describe-scope `readFileSync` recreated the
  // import-time failure the file elsewhere eliminates — a missing workflow
  // errored every describe with no test named.
  const realWorkflow = (): string =>
    fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish-exedev-image.yml"), "utf8");

  /** `SOURCE_PATHS=(a b \<newline> c)` → ["a","b","c"]. */
  const sourcePaths = (): string[] => sourcePathsOf(realWorkflow());

  /**
   * `sourcePaths` over arbitrary workflow text, so the shape it parses is
   * pinned on synthetic inputs the real workflow does not carry.
   */
  const sourcePathsOf = (workflow: string): string[] => {
    // Anchored on `SOURCE_PATHS=(`, then a PAREN-DEPTH scan to the `)` that
    // balances it — not a lazy `[\s\S]*?\)…\n` capture, which ended at the
    // FIRST inner `)` that happened to sit at end-of-line or to carry an
    // inline comment: a parenthesized entry (a glob alternation, a subshell)
    // truncated the capture mid-list, every later entry was silently dropped,
    // and the `>5` non-vacuity count below still passed on the shrunken
    // prefix — so "covers every COPY source" validated a list shorter than the
    // Dockerfile's. Depth counting has no first-inner-`)` to stop at: only the
    // `)` balancing the opening one can end the list. Quoted spans and `#`
    // comments are skipped so a paren inside either cannot end it early.
    const open = workflow.indexOf("SOURCE_PATHS=(");
    expect(open, "publish-exedev-image.yml no longer assigns SOURCE_PATHS=( … )").toBeGreaterThan(-1);
    // The scan accumulates the array's TEXT as well as its extent: comment
    // spans are dropped (they sit inside the array, so a later split would
    // otherwise read their words as entries) and quote glyphs are dropped
    // while their content is kept.
    let cleaned = "";
    let depth = 1; // the opening paren is already consumed
    let inQuote: string | null = null;
    let end = -1;
    for (let i = open + "SOURCE_PATHS=(".length; i < workflow.length; i++) {
      const ch = workflow[i]!;
      if (inQuote !== null) {
        if (ch === inQuote) inQuote = null;
        else cleaned += ch;
      } else if (ch === "'" || ch === '"') {
        inQuote = ch;
      } else if (ch === "#") {
        // A shell comment runs to end of line; a `)` in it closes nothing and
        // its words are not entries.
        const nl = workflow.indexOf("\n", i);
        i = nl === -1 ? workflow.length : nl;
        cleaned += " ";
      } else if (ch === "(") {
        depth++;
        cleaned += ch;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
        cleaned += ch;
      } else {
        cleaned += ch;
      }
    }
    expect(end, "SOURCE_PATHS=( is never closed — the depth scan ran off the workflow").toBeGreaterThan(-1);
    // The continuation splice accepts `\r\n` too: a lone `\\\n` splice leaves
    // the backslash in place under CRLF line endings, and a `\`-glued token in
    // the list reads as a parse failure that is really a line-ending one.
    return cleaned
      .replace(/\\\r?\n/g, " ")
      .split(/\s+/)
      .filter((s) => s !== "");
  };

  /** The `on.push.paths:` block, comments dropped, `/**` suffixes stripped. */
  const triggerPaths = (): string[] => triggerPathsOf(realWorkflow());

  /**
   * `triggerPaths` over arbitrary workflow text, so the anchor guard below can
   * be pinned on synthetic shapes the real workflow does not carry.
   */
  const triggerPathsOf = (workflow: string): string[] => {
    const lines = workflow.split("\n");
    // ANCHORED to `push:` (D1-11). The old parser took the FIRST 4-space
    // `paths:` block, so a benign edit adding `pull_request:` with its own
    // `paths:` above it silently swapped which list this suite validates — the
    // two lists commonly diverge, and the wrong one is exactly unguarded. The
    // `push:` key is found at 2-space indent (a top-level `on:` event) and the
    // `paths:` must belong to IT: nothing between the two keys may dedent to
    // another event.
    const push = lines.findIndex((l) => /^ {2}push:\s*(#.*)?$/m.test(l));
    expect(push, "workflow has no 2-space `push:` event under `on:`").toBeGreaterThan(-1);
    const start = lines.findIndex((l, i) => i > push && /^ {4}paths:\s*$/.test(l));
    expect(start, "workflow has no `paths:` block under `push:`").toBeGreaterThan(-1);
    // KEY-SHAPED lines only: content at 0-2 space indent (another `on:` event
    // or a top-level key). The old "anything not 4-space-indented" filter kept
    // the 6-space LIST ITEMS of a block-style sibling (`branches:` with its
    // `- main` entries) and misdiagnosed that benign shape as cross-event
    // contamination — everything at 4-space-or-deeper belongs to `push:`'s own
    // block, so only a dedent below 4 can be another event.
    const between = lines
      .slice(push + 1, start)
      .filter((l) => l.trim() !== "" && !/^\s*#/.test(l) && /^ {0,2}\S/.test(l));
    expect(
      between,
      "a key between `push:` and its `paths:` is another event's — the block being read is not push.paths",
    ).toEqual([]);
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      // Inline comments first (`- src/new/**  # engine`): YAML reads ` #` as a
      // comment start, so stripping it here reads the list the way GitHub
      // does. The old end-anchored item regex missed the entry and the `break`
      // silently dropped it AND every entry after it.
      const bare = line.replace(/\s+#.*$/, "");
      const item = /^ {6}-\s+(\S+)\s*$/.exec(bare);
      if (item) {
        out.push((item[1] ?? "").replace(/\/\*\*$/, ""));
        continue;
      }
      // A line dedented to another key closes the block — that is the list
      // ending, not a parse failure.
      if (/^ {0,4}\S/.test(bare)) break;
      // Anything left is a 6-space line this parser does not read. Fail
      // LOUDLY: silently truncating here read as in-sync trigger coverage
      // while the validated list shrank.
      throw new Error(`unrecognized line in on.push.paths (neither item nor end of block): ${JSON.stringify(line)}`);
    }
    return out;
  };

  /** `list` names `src` itself, or an ancestor directory of it. */
  const covers = (list: readonly string[], src: string): boolean =>
    list.some((p) => p === src || src.startsWith(`${p}/`));

  test("the parsers read something — neither list is silently empty", () => {
    expect(sourcePaths().length).toBeGreaterThan(5);
    expect(triggerPaths().length).toBeGreaterThan(5);
  });

  test("SOURCE_PATHS reads to its CLOSING paren, not its first inner `)`", () => {
    // The hardening above, pinned on the shape that used to truncate it: the
    // old `[^)]*` stopped at the alternation's `)`, dropped every later entry,
    // and still passed the non-vacuity count on the shrunken prefix.
    const wf = [
      "jobs:",
      "  build:",
      "    run: |",
      "      SOURCE_PATHS=(src/a (b|c) src/d \\",
      "        src/e)",
      '      echo "${SOURCE_PATHS[@]}"',
    ].join("\n");
    expect(sourcePathsOf(wf)).toEqual(["src/a", "(b|c)", "src/d", "src/e"]);
  });

  test("a comment riding the closing paren is not read as an entry", () => {
    const wf = "SOURCE_PATHS=(src/a \\\n  src/b)  # keep in lockstep with on.push.paths\nnext: 1\n";
    expect(sourcePathsOf(wf)).toEqual(["src/a", "src/b"]);
  });

  test("an inner `)` closing its own line, or carrying a comment, does not close the list", () => {
    // The RESURRECTING shapes, pinned because the hardening above was itself
    // once a lazy regex and both shapes end a capture early: an inner group
    // whose `)` sits at end-of-line, and an inner `)` trailed by an inline
    // comment, are both `\)`-at-end-of-line as far as such a regex is
    // concerned — every later entry dropped, the non-vacuity count still
    // passing. Depth counting stops only at the balancing paren.
    const ownLine = [
      "jobs:",
      "  build:",
      "    run: |",
      "      SOURCE_PATHS=(src/a \\",
      "        (b|c)",
      "      src/d)",
      '      echo "${SOURCE_PATHS[@]}"',
    ].join("\n");
    expect(sourcePathsOf(ownLine)).toEqual(["src/a", "(b|c)", "src/d"]);

    const commented = "SOURCE_PATHS=(src/a \\\n  (b|c)  # a glob alternation\n  src/d)\nnext: 1\n";
    expect(sourcePathsOf(commented)).toEqual(["src/a", "(b|c)", "src/d"]);
  });

  test("CRLF line endings splice the continuation instead of leaving a `\\` token", () => {
    // A `\r` riding the newline defeats a plain `\\\n` splice — the backslash
    // stays and the list reads as entries it does not have. Normalized before
    // the splice, so a line-ending change cannot masquerade as a list change.
    const wf = "SOURCE_PATHS=(src/a \\\r\n  src/b)\r\nnext: 1\r\n";
    expect(sourcePathsOf(wf)).toEqual(["src/a", "src/b"]);
  });

  test("a block-style sibling between `push:` and its `paths:` is not another event", () => {
    // `branches:` as a LIST — a 4-space key with 6-space items, a benign and
    // common shape the real workflow does not carry today. The old between
    // guard kept every line that was not 4-space-indented content, so those
    // 6-space items read as cross-event contamination and a workflow that
    // merely branched its pushes failed this suite with a diagnosis of the
    // wrong disease. Key-shaped lines at 0-2 space indent are the only things
    // that may trip the guard now.
    const wf = [
      "name: publish",
      "on:",
      "  push:",
      "    branches:",
      "      - main",
      "      - dev",
      "    paths:",
      "      - oci/exedev/**",
      "      - .dockerignore",
      "  pull_request:",
      "    paths:",
      "      - '**'",
      "jobs:",
      "  build:",
    ].join("\n");
    expect(triggerPathsOf(wf)).toEqual(["oci/exedev", ".dockerignore"]);
  });

  test("another event between `push:` and its `paths:` still trips the anchor guard", () => {
    // The tightening above must not have disarmed the guard it tightened: a
    // `pull_request:` KEY between `push:` and a `paths:` block still means the
    // block being read is not push.paths.
    const wf = ["on:", "  push:", "  pull_request:", "    paths:", "      - '**'", "    paths:", "      - oci/**", ""].join(
      "\n",
    );
    expect(() => triggerPathsOf(wf)).toThrow(/another event's/);
  });

  test("every Dockerfile COPY source is covered by BOTH lists", () => {
    const sources = copyContextSources(realDockerfile());
    const trigger = triggerPaths();
    const source = sourcePaths();
    const uncovered = sources.filter((s) => !covers(trigger, s) || !covers(source, s));
    expect(uncovered, "a COPY source in neither `on.push.paths` nor SOURCE_PATHS").toEqual([]);
  });

  test("`.dockerignore` is in both lists — it is a buildId input with no COPY of its own", () => {
    expect(triggerPaths()).toContain(".dockerignore");
    expect(sourcePaths()).toContain(".dockerignore");
  });

  test("SOURCE_PATHS names nothing that is not an image input", () => {
    // The OTHER direction, and the one `scripts` (taken wholesale) failed:
    // editing scripts/fleet.ts — not an image byte, not a buildId input — moved
    // `src_sha`, hence QDS_GIT_SHA and SOURCE_DATE_EPOCH, hence the marker,
    // hence the digest. A forced re-pin with an UNCHANGED buildId, which is
    // precisely the confusing state the gate's failure text warns about.
    //
    // Over-TRIGGERING is safe and `on.push.paths` is deliberately wider (it
    // keeps `scripts/**` and adds driver.ts), so only this list is checked in
    // this direction.
    //
    // Round 6: the predicate only accepts a directory entry as covering its
    // subtree (`s.startsWith(p + "/")`) — a SOURCE_PATH that is a strict
    // SUBFILE of a COPY source can never be stray under the old
    // `p.startsWith(s + "/")` clause, so that clause is gone (no live entry
    // ever needed it). The ancestor clause is sound only for directories
    // COPY'd WHOLE; a partially-COPY'd directory must be argued in EXEMPT.
    const EXEMPT = [
      // Its constants (PI_VERSION) are `--build-arg`s, so it decides image
      // bytes without being any. Argued at length in the workflow.
      "scripts/build-exedev-image.ts",
      // Hashed by `gatherBuildIdInputs`; decides what a directory COPY
      // contains without being COPY'd itself.
      ".dockerignore",
      // PARTIALLY COPY'd: its Dockerfile and systemd/ are buildId inputs, but
      // `binary-licenses.json` under it feeds the host-side NOTICE sweep and
      // is neither an image byte nor a buildId input. Directory granularity
      // is kept DELIBERATELY — any oci/exedev change should re-run publish —
      // so the one known non-input residue is argued HERE rather than by
      // narrowing the workflow's list.
      "oci/exedev",
    ];
    const sources = copyContextSources(realDockerfile());
    const stray = sourcePaths().filter(
      (p) => !EXEMPT.includes(p) && !sources.some((s) => s === p || s.startsWith(`${p}/`)),
    );
    expect(stray, "a SOURCE_PATH that moves the image's recorded revision without being an image input").toEqual([]);
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
  // BOUNDED (round 3): the regression this describe pins is `parseArgs` moving
  // BELOW the builder preflight — the child then reaches for a daemon instead
  // of dying at parse, and an unbounded `spawnSync` let the test block until
  // the suite's global timeout instead of failing with a named diff.
  const SPAWN_TIMEOUT_MS = 30_000;
  const runScript = (args: string[]): { status: number | null; stderr: string } => {
    const res = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
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
    //
    // NORMALIZED PRE-STATE (round 3): the witness read `before === true` on any
    // tree where `oci/.build/exedev` already existed — a developer checkout, an
    // earlier leg of this suite — and `toBe(before)` then passed whether or not
    // the script ran `mkdirSync`. The directory is this script's own
    // git-ignored scratch (`.gitignore`: `oci/.build/`), so removing it first
    // makes the witness unconditional: after a parse-stage refusal it must be
    // ABSENT, not merely "as it was".
    const buildDir = path.join(REPO_ROOT, "oci/.build/exedev");
    // R4-46: the rm below is unconditional, and this path is a developer
    // checkout's REAL build scratch as often as it is this suite's litter —
    // the test must not destroy what it does not own. Snapshot any pre-existing
    // contents to a temp dir, run the witness against a genuinely ABSENT
    // directory as the normalization above requires, then restore the
    // pre-state in a finally (even when an assertion throws mid-test).
    //
    // Snapshot creation lives INSIDE the try: mkdtemp/cpSync before it could
    // throw with no finally entered, leaking the temp dir and leaving the
    // restore never attempted. `scratchSnapshot` is committed only after the
    // copy completes, so a partial copy can never be restored over the
    // pre-state it exists to protect.
    let scratchSnapshot: string | undefined;
    let scratchTmp: string | undefined;
    try {
      if (fs.existsSync(buildDir)) {
        scratchTmp = fs.mkdtempSync(path.join(os.tmpdir(), "qds-build-scratch-"));
        fs.cpSync(buildDir, path.join(scratchTmp, "exedev"), { recursive: true });
        scratchSnapshot = scratchTmp;
      }
      fs.rmSync(buildDir, { recursive: true, force: true });
      const res = spawnSync(
        // `process.execPath`, not the name `bun`: the point of this run is a PATH
        // with no `docker` on it, and a PATH lookup for the runtime would fail too.
        process.execPath,
        [path.join(REPO_ROOT, "scripts/build-exedev-image.ts"), "--tag", "ghcr.io/x/y:v1,push=true"],
        {
          encoding: "utf8",
          timeout: SPAWN_TIMEOUT_MS,
          // The host's `QDS_*`/`SOURCE_DATE_EPOCH`/checksum exports are the
          // hostile-env scrub (`cleanEnv` above): this run pins the PARSE gate,
          // so it must not die at an environment gate for a value the suite
          // never set.
          env: { ...cleanEnv(), PATH: path.join(REPO_ROOT, "oci/license-texts") },
        },
      );
      expect(res.status).toBe(2);
      expect(res.stderr ?? "").toMatch(/not an image reference this script can act on/);
      expect(fs.existsSync(buildDir), "the parse refusal ran after fs.mkdirSync(BUILD_DIR)").toBe(false);
    } finally {
      if (scratchSnapshot !== undefined) {
        // Whatever the child created (it created nothing on a parse refusal,
        // but the restore must not depend on that) goes; the developer's
        // pre-state goes back in its place.
        fs.rmSync(buildDir, { recursive: true, force: true });
        fs.cpSync(path.join(scratchSnapshot, "exedev"), buildDir, { recursive: true });
      }
      // The temp dir goes either way — including when the copy never
      // completed and nothing was restored from it.
      if (scratchTmp !== undefined) fs.rmSync(scratchTmp, { recursive: true, force: true });
    }
  });
});

/**
 * A structurally complete entry; the licence-table tests below remove exactly
 * one thing from it. ONE fixture, shared by the subprocess wiring vehicle and
 * the pure `validateBinaryLicenses` block: two hand-rolled copies meant the
 * wiring tests and the pure tests could silently disagree about what
 * "complete" means, and a new required attribution field had to be remembered
 * in both places.
 */
function goodEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // A PATH, not a basename (#188) — that is what coverage matches on now.
    names: ["usr/local/bin/bun"],
    project: "oven-sh/bun",
    spdxId: "MIT",
    copyright: "Copyright (c) Bun contributors",
    licenseUrl: "https://example.invalid/LICENSE",
    verifiedHow: "fetched the upstream LICENSE",
    ...over,
  };
}

/**
 * F-041: `main()` validates the table against the script's NODE_VERSION /
 * OPENRIG_VERSION constants, and a table with no nodejs/node or
 * mvschwarz/openrig entry — or one whose `version` names another release — is
 * a STRUCTURAL refusal (exit 2). The wiring tests need tables that are
 * structurally clean so the gate under test is the only thing firing; these
 * fixtures carry versions matching the script-side constants, the same source
 * `main` compares against.
 */
const EXPECTED_VERSIONS = { nodeVersion: NODE_VERSION, openrigVersion: OPENRIG_VERSION } as const;

function nodeEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return goodEntry({
    names: ["usr/local/bin/node"],
    project: "nodejs/node",
    spdxId: "MIT",
    copyright: "Copyright Node.js contributors. All rights reserved.",
    licenseUrl: `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`,
    verifiedHow: `fetched the upstream LICENSE at tag v${NODE_VERSION}`,
    version: NODE_VERSION,
    ...over,
  });
}

function openrigEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return goodEntry({
    names: ["opt/openrig/lib/node_modules/@openrig/cli/dist/bin-wrapper.js"],
    project: "mvschwarz/openrig",
    spdxId: "MIT",
    copyright: "Copyright (c) mvschwarz",
    licenseUrl: `https://raw.githubusercontent.com/mvschwarz/openrig/v${OPENRIG_VERSION}/LICENSE`,
    verifiedHow: `fetched the upstream LICENSE at tag v${OPENRIG_VERSION}`,
    version: OPENRIG_VERSION,
    ...over,
  });
}

/** The structurally clean table shape `main()` demands: bun + node + openrig. */
const versionedEntries = (...extra: Record<string, unknown>[]): Record<string, unknown>[] => [
  ...extra,
  nodeEntry(),
  openrigEntry(),
];

/**
 * `main()`'s WIRING, not its pure parts. Two contracts live only between
 * `main`'s statements and were unreachable from here: the checksum-gate call
 * site (`gatherBuildIdInputs` is not exported, and `main` sits behind the
 * buildx preflight, so every subprocess run died at "no OCI builder found"
 * before reaching it) and the licence-table exit-code split (structural → 2,
 * compliance → 1 — the publish workflow's failure classifier branches on
 * exactly this, and `validateBinaryLicenses`' own tests assert the RETURN
 * shape, not what `main` dies with).
 *
 * Both are reached with a `docker` stub on PATH that answers the buildx
 * preflight: `buildx version` → 0, `buildx inspect` → 0 printing
 * `Driver: docker-container`. Everything under test fires BEFORE any registry
 * access and before the build, so the stub answers nothing else.
 */
describe("main() wiring (subprocess, stub docker on PATH)", () => {
  const SCRIPT = path.join(REPO_ROOT, "scripts/build-exedev-image.ts");
  let stubPath: string | undefined;
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    if (stubPath !== undefined) fs.rmSync(path.dirname(stubPath), { recursive: true, force: true });
    stubPath = undefined;
  });

  /**
   * Puts a `docker` stub FIRST on PATH; returns the augmented PATH value.
   * `failGit` puts a failing `git` beside it, driving the no-git arm of the
   * env gates below: `imageSourceSha`'s HEAD fallback becomes `tryRun` → null
   * → `die(2)`, on every host, without removing git from the machine.
   */
  const dockerOnPath = (opts: { failGit?: boolean } = {}): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-docker-stub-"));
    const stub = path.join(dir, "docker");
    fs.writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        'case "$2" in',
        "  version) exit 0 ;;",
        "  inspect) printf 'Name: qds-repro\\nDriver: docker-container\\n'; exit 0 ;;",
        "esac",
        "# Anything else is a shape these tests never reach; 0 keeps a future",
        "# reorder from misreporting the gate under test as a preflight failure.",
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(stub, 0o755);
    if (opts.failGit) {
      const git = path.join(dir, "git");
      fs.writeFileSync(git, "#!/usr/bin/env bash\nexit 1\n");
      fs.chmodSync(git, 0o755);
    }
    stubPath = stub;
    return [dir, process.env.PATH ?? ""].join(path.delimiter);
  };

  // BOUNDED, like the parse rejects: this describe's failure mode is a gate
  // BYPASSED, and a bypassed gate lets the script march past the stub preflight
  // into the build. The timeout converts that drift into a named failure
  // instead of a wedged suite.
  const WIRING_TIMEOUT_MS = 60_000;
  const runMain = (
    env: NodeJS.ProcessEnv,
    script: string = SCRIPT,
    args: string[] = [],
  ): { status: number | null; stderr: string } => {
    // `process.execPath`, not the name `bun`: the stub PATH must decide only
    // the child's `docker` lookup, not which runtime loads the script. The env
    // is built over `cleanEnv()` and the callers pass ONLY what they pin — a
    // CI shell's `QDS_GIT_SHA=""` or a stray `SOURCE_DATE_EPOCH` must not be
    // the thing deciding which gate the child dies at.
    const res = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: WIRING_TIMEOUT_MS,
      env: { ...cleanEnv(), ...env },
    });
    return { status: res.status, stderr: res.stderr ?? "" };
  };

  test("a BUN_SHA256 env override is refused by main(), exit 2, CONTENT GATE", () => {
    // The exposure oci/exedev/Dockerfile names is closed by ONE call —
    // `checksumArgProblems(dockerfile, process.env)` inside
    // `gatherBuildIdInputs`. Its function-level tests pass or fail with that
    // call site intact or deleted; only main() can prove the wiring. The stub
    // preflight gets there: the walk and the ARG lockstep run first (this
    // repo's own tree), then the refusal, all before any registry read.
    const [declared] = dockerfileArgDefaults(realDockerfile(), "BUN_SHA256");
    const override = declared === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const { status, stderr } = runMain({ PATH: dockerOnPath(), BUN_SHA256: override });
    expect(status).toBe(2);
    expect(stderr).toMatch(
      new RegExp(`BUN_SHA256=${override} is set in the environment and is not .*declared default`),
    );
    expect(stderr).toContain("it is a CONTENT GATE");
  });

  /** A minimal tree holding what `main` touches BEFORE the licence gate. */
  const checkoutWithTable = (tableJson: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qds-imgscript-"));
    fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "oci/exedev"), { recursive: true });
    // The script resolves REPO_ROOT from its own location, so the copies (not
    // symlinks) of the script and its scripts/ imports anchor the fake root.
    // Derived from the directory, not hand-enumerated: the two-name list this
    // replaces rotted the moment the script gained its next root-level
    // `scripts/*.ts` import, and every test here failed with a
    // module-resolution error naming nothing about the licence gate they
    // exist to reach.
    const rootScripts = fs
      .readdirSync(path.join(REPO_ROOT, "scripts"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => `scripts/${e.name}`);
    expect(rootScripts, "scripts/ walked to nothing — the copy source moved").not.toEqual([]);
    for (const rel of rootScripts) {
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
    }
    // The WHOLE scripts/lib directory, not a hand-enumerated import manifest:
    // the enumerated list rotted the moment the script gained its next
    // `scripts/lib/*` import, and every test here failed with a
    // module-resolution error naming nothing about the licence gate they
    // exist to reach.
    fs.cpSync(path.join(REPO_ROOT, "scripts/lib"), path.join(root, "scripts/lib"), { recursive: true });
    // Load-time dependencies outside the gate under test: symlinked, not
    // copied (`../src/...` imports resolve to the real tree either way).
    fs.symlinkSync(path.join(REPO_ROOT, "src"), path.join(root, "src"));
    fs.symlinkSync(REAL_TEXTS, path.join(root, "oci", "license-texts"));
    fs.writeFileSync(path.join(root, "oci/exedev/binary-licenses.json"), tableJson);
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return path.join(root, "scripts/build-exedev-image.ts");
  };

  // `goodEntry` is the ONE complete-entry fixture, shared with the pure
  // validateBinaryLicenses block below.

  test("a COMPLIANCE finding exits 1 — the workflow's classifier reads this code", () => {
    // A well-formed table saying something unpublishable (the UNVERIFIED
    // sentinel). `validateBinaryLicenses` tests prove the finding lands in
    // `.compliance`; only main() proves that bucket dies(1) — swap the two
    // `die` codes and every one of those tests stays green while the
    // classifier misdiagnoses a denied licence as a registry/auth essay.
    // The node/openrig entries ride along (F-041) because `main` also runs
    // the version-lockstep check: a bun-only table is STRUCTURALLY refused
    // (exit 2) before the compliance class is ever reached, and the test
    // would then be pinning the wrong gate.
    const { status, stderr } = runMain(
      { PATH: dockerOnPath() },
      checkoutWithTable(JSON.stringify({ entries: versionedEntries(goodEntry({ spdxId: "UNVERIFIED" })) })),
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/UNVERIFIED — establish it upstream/);
  });

  test("a STRUCTURALLY malformed table exits 2, and the message says which class it is", () => {
    // `"names": []` is a JSON typo, not a licence position. It must take the
    // fatal-before-the-gates exit AND be TOLD it is one, or a consumer
    // classifying exit codes reports a bad edit as a licence failure.
    const { status, stderr } = runMain(
      { PATH: dockerOnPath() },
      checkoutWithTable(JSON.stringify({ entries: [goodEntry({ names: [] })] })),
    );
    expect(status).toBe(2);
    expect(stderr).toMatch(/"names" must list at least one in-image binary path/);
    expect(stderr).toMatch(/malformed; that is a bad edit \(exit 2\), not a licence finding \(exit 1\)/);
  });

  // The reproducibility ENV GATES, same vehicle. `sourceDateEpoch` and
  // `imageSourceSha` are unexported functions between `gatherBuildIdInputs`
  // and the solve, so their refusals are reachable only through `main()` — and
  // the run gets there offline because the real Dockerfile's base is
  // DIGEST-PINNED (`resolveBaseDigest` returns the `@sha256:` suffix without
  // any registry read) and the stub answers both preflights. A degenerate
  // epoch or sha that slipped past these gates bakes builtAt=1970 (or a
  // provenance lie) into /etc/qds-image.json AND moves the digest, so the
  // refusal has to fire before the ten-minute build — which only these
  // wiring tests can prove.
  test("SOURCE_DATE_EPOCH=0 is refused by main(), exit 2 — reproducible does not mean 1970", () => {
    // `${SOURCE_DATE_EPOCH:-0}` in a shell wrapper, or a CI expression that
    // evaluated to empty and got defaulted: well-formed enough to reach buildx
    // and bake 1970 layer mtimes into an image that then passes every gate.
    // QDS_GIT_SHA is pinned to a synthetic 40-hex so the run reaches the epoch
    // gate deterministically, with no git read of its own in play.
    const { status, stderr } = runMain({
      PATH: dockerOnPath(),
      QDS_GIT_SHA: "a".repeat(40),
      SOURCE_DATE_EPOCH: "0",
    });
    expect(status).toBe(2);
    expect(stderr).toMatch(/SOURCE_DATE_EPOCH="0" is not a plain non-zero UNIX second count/);
    expect(stderr).toMatch(/set it to seconds \(not milliseconds, not 0\)/);
  });

  test("SOURCE_DATE_EPOCH in MILLISECONDS (13 digits) is refused by main(), exit 2", () => {
    // The OTHER degenerate value: a JS `Date.now()` pasted into the env reads
    // as a date in the year 58000, and every layer mtime lands there — passing
    // every gate while being unreproducible in the other direction.
    const { status, stderr } = runMain({
      PATH: dockerOnPath(),
      QDS_GIT_SHA: "a".repeat(40),
      SOURCE_DATE_EPOCH: "1767225600000",
    });
    expect(status).toBe(2);
    expect(stderr).toMatch(/SOURCE_DATE_EPOCH="1767225600000" is not a plain non-zero UNIX second count/);
  });

  test("QDS_GIT_SHA set-but-empty is refused with the asymmetry diagnostic, exit 2", () => {
    // SET-BUT-EMPTY is the malformed case HERE — deliberately unlike
    // SOURCE_DATE_EPOCH, where empty falls back to git. Here the fallback is
    // HEAD, the one value the override exists to avoid, and an empty
    // QDS_GIT_SHA is exactly what a path-filtered CI step that matched no
    // commit exports. Falling through silently re-opens the non-terminating
    // pin bootstrap; the diagnostic has to NAME that asymmetry.
    const { status, stderr } = runMain({ PATH: dockerOnPath(), QDS_GIT_SHA: "" });
    expect(status).toBe(2);
    expect(stderr).toMatch(/QDS_GIT_SHA="" is not a 40-hex commit id/);
    expect(stderr).toMatch(/it is SET but empty — usually a CI expression that evaluated to nothing/);
    expect(stderr).toMatch(/unset it entirely to fall back to HEAD/);
  });

  test("no git and no QDS_GIT_SHA is refused, exit 2 — provenance may not be guessed", () => {
    // The no-git arm: the fallback is `git rev-parse HEAD`, and its failure is
    // fatal rather than `"unknown"` — the rejected fallback shipped a false
    // provenance claim a box reads back AND silently moved the digest (the
    // marker is a layer). Driven with a failing `git` stub on the stub PATH so
    // the arm runs on every host.
    // `cleanEnv()` already strips QDS_GIT_SHA, so this is the UNSET arm, not
    // the set-but-empty one — no explicit deletion needed.
    const { status, stderr } = runMain({ PATH: dockerOnPath({ failGit: true }) });
    expect(status).toBe(2);
    expect(stderr).toMatch(/cannot read the image source revision \(git rev-parse HEAD\)/);
    expect(stderr).toMatch(/set QDS_GIT_SHA to the full 40-hex sha of the image source revision/);
  });

  test("BEFORE ANY DELETE: a disallowed --summary is refused and the file it names survives", () => {
    // The WIRING half of `outputPathAllowed`, which no pure test can reach:
    // `main` must consult the guard BEFORE the preclean `rmSync` that deletes
    // the same path. The describe below proves the FUNCTION answers `false`
    // for a `~/.npmrc`-shaped path; delete the `outputPathAllowed(out)` call
    // from `main` and every one of those tests stays green while this run
    // deletes the sentinel — the `--summary ~/.ssh/known_hosts` incident,
    // replayed in miniature. The sentinel is a file this test owns, on a path
    // outside both BUILD_DIR and the temp dir, so it names exactly the shape
    // the guard exists to refuse — and the suite's own git-ignored scratch is
    // where it lives, not a directory a user owns (the site comment below).
    //
    // Reached offline the same way the env-gate tests are: a synthetic 40-hex
    // `QDS_GIT_SHA` and a valid epoch pass the gates that precede it, and the
    // refusal fires before any registry read. (The guard runs after
    // `fs.mkdirSync(BUILD_DIR)`, so the build directory may be created here;
    // its pre-state is restored below.)
    //
    // The sentinel's SITE: it must be on a path the guard REFUSES (outside
    // BUILD_DIR and outside the temp dir) yet somewhere this suite owns. The
    // old choice — the real `$HOME` — satisfied the first half by writing into
    // a user-owned directory, which no test should. The temp dir satisfies
    // NEITHER half (it is the guard's allow-land: the preclean would delete
    // the sentinel and the survival pin below would fail by construction).
    // `oci/.build/` is the script's own git-ignored scratch — refused (inside
    // the repo, not under BUILD_DIR), invisible to `git add` and to secret
    // scanners if a run dies before the finally, and this suite's litter to
    // clean up, exactly like the walk fixture above.
    fs.mkdirSync(path.join(REPO_ROOT, "oci/.build"), { recursive: true });
    const sentinel = path.join(REPO_ROOT, "oci/.build", `qds-imgtest-refused-${process.pid}-${Date.now()}`);
    fs.writeFileSync(sentinel, "the guard must keep this file alive\n");
    const buildDir = path.join(REPO_ROOT, "oci/.build/exedev");
    const buildDirBefore = fs.existsSync(buildDir);
    try {
      const { status, stderr } = runMain(
        {
          PATH: dockerOnPath(),
          QDS_GIT_SHA: "a".repeat(40),
          SOURCE_DATE_EPOCH: "1767225600",
        },
        SCRIPT,
        ["--summary", sentinel],
      );
      expect(status).toBe(2);
      expect(stderr).toMatch(/--summary resolves to .*, which is neither under/);
      expect(
        fs.existsSync(sentinel),
        "outputPathAllowed was not consulted before the preclean deleted --summary",
      ).toBe(true);
    } finally {
      fs.rmSync(sentinel, { force: true });
      if (!buildDirBefore) fs.rmSync(buildDir, { recursive: true, force: true });
    }
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
    if (
      process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0)
    ) {
      // Root reads through 0o000, and on win32 `chmodSync(p, 0o000)` does not
      // remove read permission at all — on either host the file stays readable
      // and is judged on content, so the EACCES arm cannot fire. SAID rather
      // than a bare return: a silent skip reports the fail-closed guarantee as
      // proven on a host where it was never exercised.
      console.error(
        `[build-exedev-image.test] ${process.platform}${
          typeof process.getuid === "function" && process.getuid() === 0 ? " as root" : ""
        }: the unreadable-file arm is SKIPPED (this host cannot make a file unreadable)`,
      );
      return;
    }
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
    //
    // BOUNDED (round 3): this gate is called IN-PROCESS, so a regression that
    // re-opens the FIFO would not fail this test — it would block the bun test
    // thread forever (a sync `readFileSync` cannot be interrupted by bun's test
    // timeout) and take the whole suite down as a CI timeout with no
    // diagnostic. A writer holding one byte pending changes the failure mode:
    // the regressed read COMPLETES, returns "x" (not a credential), and the
    // finding assertion below fails by name. On the correct behaviour the
    // writer never connects, and it is killed in the `finally`.
    const dir = makeDir();
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      const fifo = path.join(dir, "credentials");
      const made = spawnSync("mkfifo", [fifo], { timeout: 10_000 });
      if (made.status !== 0) {
        // No mkfifo on this host. SAID rather than a bare return so a skipped
        // FIFO arm is visible in the run's output instead of reading as a
        // pass over the wedge-forever guard.
        console.error(`[build-exedev-image.test] mkfifo exited ${made.status ?? "on a signal"}: the FIFO arm is SKIPPED`);
        return;
      }
      // `exec` so the shell BECOMES printf: without it, a shell that forks
      // instead of exec-ing its last command leaves the killed PID being sh,
      // with the real writer orphaned behind it — blocked forever on the
      // FIFO's open, outliving this test.
      writer = spawn("sh", ["-c", `exec printf x > '${fifo}'`], { stdio: "ignore" });
      expect(judgeCandidateDir(dir, "run/secrets")).toEqual([
        "/run/secrets/credentials is not a regular file (FIFO); this scan cannot read it for credentials — treating as a finding",
      ]);
    } finally {
      writer?.kill("SIGKILL");
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

  test("the repo's own oci/exedev/binary-licenses.json is structurally clean", () => {
    // STRUCTURAL only, and the split is the point. A structural problem is a
    // bad edit (exit 2); this file must never have one.
    expect(validateBinaryLicenses(JSON.parse(realTable()), REAL_TEXTS).structural).toEqual([]);
  });

  test("the repo's own table is COMPLIANCE-clean: every spdxId resolves to a canonical text", () => {
    // Replaces the "PINNED PENDING DECISION" test, which asserted the engine
    // entry was UNVERIFIED and was written to fail the day the owner declared a
    // licence. That day is 2026-09-03: QDS-Factory is declared
    // LicenseRef-QDS-Proprietary, with the canonical text checked in at
    // oci/license-texts/LicenseRef-QDS-Proprietary.txt.
    //
    // The pin is INVERTED rather than merely deleted, because deleting it would
    // have left nothing asserting the state it was guarding. It now fails if any
    // top-level entry regresses to UNVERIFIED, to NOASSERTION, or to an
    // identifier whose text is not checked in — the three ways this table stops
    // being publishable — and it fails HERE rather than on a paid QEMU build.
    //
    // Compliance only. The structural assertion above stays separate: a bad edit
    // must still exit 2, not 1.
    expect(validateBinaryLicenses(JSON.parse(realTable()), REAL_TEXTS).compliance).toEqual([]);
  });

  test("the repo's own table also passes the F-041 version-lockstep check", () => {
    // `main()` validates with the script constants; the two repo-table tests
    // above call the two-arg form, which SKIPS the check. This is the same
    // file through the three-arg door: nodejs/node at NODE_VERSION and
    // mvschwarz/openrig at OPENRIG_VERSION, or this build refuses before it
    // starts.
    expect(validateBinaryLicenses(JSON.parse(realTable()), REAL_TEXTS, EXPECTED_VERSIONS).structural).toEqual([]);
  });

  test("a node/OpenRig entry whose version drifts from the script constants is STRUCTURAL", () => {
    // An ARG bump without the table is stale attribution — the licenseUrl tag
    // names a release the image no longer ships — and a well-formed table
    // saying the wrong thing is a forgotten edit (the "bad edit" class,
    // exit 2), not a licence position (exit 1). Each drift asserted alone, on
    // an otherwise clean table, so the failure names exactly one cause. The
    // drifted entry REPLACES its healthy twin rather than joining it — a
    // second nodejs/node entry would trip the #188 duplicate-claim rule and
    // drown the drift this test is about.
    const nodeDrift = validateBinaryLicenses(
      { entries: [nodeEntry({ version: "22.19.0" }), openrigEntry()] },
      REAL_TEXTS,
      EXPECTED_VERSIONS,
    );
    // The refusal is TWO lines — the finding plus its remediation — so both
    // are pinned.
    expect(nodeDrift.structural).toEqual([
      expect.stringMatching(/entry 0 \(nodejs\/node\): version "22\.19\.0" is not this build's pinned NODE_VERSION 22\.20\.0/),
      expect.stringMatching(/^an ARG bump without the table is stale attribution.*move the entry's version, licenseUrl tag and verifiedHow in the same change/),
    ]);
    expect(nodeDrift.compliance).toEqual([]);

    const openrigDrift = validateBinaryLicenses(
      { entries: [nodeEntry(), openrigEntry({ version: "0.5.13" })] },
      REAL_TEXTS,
      EXPECTED_VERSIONS,
    );
    expect(openrigDrift.structural).toEqual([
      expect.stringMatching(/entry 1 \(mvschwarz\/openrig\): version "0\.5\.13" is not this build's pinned OPENRIG_VERSION 0\.5\.14/),
      expect.stringMatching(/^an ARG bump without the table is stale attribution/),
    ]);
    expect(openrigDrift.compliance).toEqual([]);
  });

  test("a table with no node/OpenRig entry at all is STRUCTURAL — the image ships both unconditionally", () => {
    // Absence is the pre-S1 shape, and the pre-S1 shape is exactly what a
    // forgotten table edit leaves behind. Both absences in one table, in the
    // declaration order the check walks (node first).
    const problems = validateBinaryLicenses({ entries: [goodEntry()] }, REAL_TEXTS, EXPECTED_VERSIONS);
    expect(problems.structural).toEqual([
      expect.stringMatching(/entry -1: no "nodejs\/node" entry — the Dockerfile installs node unconditionally/),
      expect.stringMatching(/entry -1: no "mvschwarz\/openrig" entry — the Dockerfile installs the OpenRig CLI unconditionally/),
    ]);
    expect(problems.compliance).toEqual([]);
  });

  test("omitting expectedVersions skips the lockstep check — the exported surface's opt-in shape", () => {
    // The two-arg form predates F-041 and the pure tests above exercise it
    // with bun-only tables on purpose. Pinned so "the check exists" cannot
    // silently become "the check is unconditional" (or vice versa) without a
    // test noticing which contract moved.
    expect(validateBinaryLicenses({ entries: [goodEntry()] }, REAL_TEXTS).structural).toEqual([]);
  });

  test("the LGPL relink obligation sits on the artifact that carries it, and on no other", () => {
    // The correction most likely to be missed, pinned so it cannot regress in
    // EITHER direction — and both directions are real defects, which is why one
    // assertion would not do.
    //
    // While the engine shipped as a `bun build --compile` executable it embedded
    // the bun runtime, so its entry correctly disclosed statically linked
    // LGPL-2.0-or-later JavaScriptCore and its clause (1) relink requirement.
    // DF1.10 took AC2a's fallback route, so /usr/local/bin/qds-engine is now a
    // two-line shell script that embeds nothing. Leaving the disclosure would
    // attribute to a 90-byte wrapper an obligation it cannot discharge and does
    // not incur — a FALSE CLAIM, and false attribution is not the safe direction
    // merely because it names more licences.
    //
    // The obligation did not go away, it MOVED. bun's own entry is the artifact
    // that actually statically links JavaScriptCore, and dropping it from there
    // would be the opposite and worse defect: a real relink obligation that the
    // generated NOTICE stops mentioning. The two halves were one claim split
    // across two entries, so they are asserted together.
    const table = JSON.parse(realTable()) as {
      entries: { names: string[]; bundled?: { spdxId?: string }[] }[];
    };
    const byPath = (p: string) => table.entries.find((e) => e.names.includes(p));

    const engine = byPath("usr/local/bin/qds-engine");
    expect(engine).toBeDefined();
    // Not merely "no LGPL": the wrapper redistributes nothing at all, so any
    // bundled member on it is a claim about an artifact that embeds nothing.
    expect(engine?.bundled ?? []).toEqual([]);

    // The positive half. Without it the assertion above is satisfiable by
    // deleting the disclosure everywhere, which is the worse defect.
    const bun = byPath("usr/local/bin/bun");
    expect(bun).toBeDefined();
    expect((bun?.bundled ?? []).map((b) => b.spdxId)).toContain("LGPL-2.0-or-later");
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
    expect(problems.structural).toEqual([expect.stringMatching(/"names" must list at least one in-image binary path/)]);
  });

  test("rejects an entry that names no binary", () => {
    for (const names of [undefined, [], ["  "], [1], "bun"]) {
      expect(all(validateBinaryLicenses({ entries: [goodEntry({ names })] }, REAL_TEXTS))).toEqual([
        expect.stringMatching(/"names" must list at least one in-image binary path/),
      ]);
    }
  });

  test("rejects a BASENAME where an in-image path is required (#188)", () => {
    // A bare `bun` validated clean and then attributed NOTHING, because
    // coverage compares against the full paths `listExecutables` produces. The
    // build would have stopped on "no entry in binary-licenses.json" for a
    // binary whose entry was right there — fails closed, at the wrong problem.
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ names: ["bun"] })] }, REAL_TEXTS))).toEqual([
      expect.stringMatching(/is a basename, not an in-image path/),
    ]);
  });

  test("rejects a leading slash: in-image paths are recorded without one", () => {
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ names: ["/usr/local/bin/bun"] })] }, REAL_TEXTS))).toEqual([
      expect.stringMatching(/has a leading slash/),
    ]);
  });

  test("rejects two entries claiming the SAME binary under different licences (#188)", () => {
    // Which of them a `some()` matched was an ordering accident, and the winner
    // decided what the NOTICE said about that file's licence.
    const problems = validateBinaryLicenses(
      { entries: [goodEntry(), goodEntry({ project: "someone-else/bun", spdxId: "Apache-2.0" })] },
      REAL_TEXTS,
    );
    expect(problems.structural).toEqual([
      expect.stringMatching(/"usr\/local\/bin\/bun" is already claimed by entry 0; one binary, one attribution/),
    ]);
  });

  test("rejects a retired `paths` field rather than ignoring it (#188)", () => {
    // It existed to narrow a BASENAME match to a path. Names are paths now, so
    // an entry still carrying one is one nobody re-measured — and silently
    // ignoring it would leave a reader believing a narrowing is in force.
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ paths: ["usr/local/bin/bun"] })] }, REAL_TEXTS))).toEqual([
      expect.stringMatching(/"paths" is no longer a field/),
    ]);
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

  test("a retired `paths` is refused whatever it contains — well-formed or not", () => {
    // It used to be an optional narrowing whose malformed shapes each had their
    // own diagnostic. There is nothing left to narrow, so every shape gets the
    // same answer: fold it into `names` and delete it.
    for (const paths of [["usr/local/bin/bun"], [], ["  "], [1], "usr/local/bin/bun", ["/usr/local/bin/bun"]]) {
      expect(all(validateBinaryLicenses({ entries: [goodEntry({ paths })] }, REAL_TEXTS))).toEqual([
        expect.stringMatching(/"paths" is no longer a field/),
      ]);
    }
  });

  test("accepts a complete bundled disclosure", () => {
    const bundled = [{ component: "zlib", spdxId: "Zlib", url: "https://example.invalid/z", note: "statically linked" }];
    expect(all(validateBinaryLicenses({ entries: [goodEntry({ bundled })] }, REAL_TEXTS))).toEqual([]);
  });

  test("reports problems for every entry, keyed by index, in the right class", () => {
    // Distinct paths per entry: the cross-entry duplicate rule (#188) would
    // otherwise fire on entries 1 and 2 and drown the field problem this test
    // is about.
    const problems = validateBinaryLicenses(
      {
        entries: [
          goodEntry(),
          goodEntry({ names: ["usr/bin/b"], project: "" }),
          goodEntry({ names: ["usr/bin/c"], spdxId: "UNVERIFIED" }),
        ],
      },
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
    const shipsBunx = realDockerfile().split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .some((l) => /\b(?:ln|install|cp|mv)\b[^\n]*\bbunx\b/.test(l));
    const bunEntry = (JSON.parse(realTable()) as { entries: { names: string[] }[] }).entries.find((e) =>
      e.names.includes("usr/local/bin/bun"),
    );
    expect(bunEntry).toBeDefined();
    expect(bunEntry?.names.some((n) => n.endsWith("/bunx"))).toBe(shipsBunx);
  });

  test("the two ARG BUN_SHA256 declarations agree across the stages", () => {
    // `gatherBuildIdInputs` enforces lockstep for BUN_VERSION and PI_VERSION
    // and NOT for BUN_SHA256, which the multi-stage Dockerfile now declares
    // twice (the engine builder compiles with the same pinned bun the runtime
    // ships, so both stages install it). Two disagreeing checksums means one
    // stage silently fails its `sha256sum -c` ten QEMU-emulated minutes in, or
    // — worse — that the bun which COMPILED the engine is not the bun the
    // marker reports.
    expect(dockerfileArgDefaults(realDockerfile(), "BUN_SHA256")).toHaveLength(1);
    expect(dockerfileArgDefaults(realDockerfile(), "BUN_VERSION")).toHaveLength(1);
    // …AND that there really are two of them. `dockerfileArgDefaults` returns a
    // SET of DISTINCT values, so `toHaveLength(1)` is satisfied by one
    // declaration exactly as well as by two agreeing ones: deleting the engine
    // stage's `ARG BUN_SHA256=` left this test green while that stage's
    // `sha256sum -c` fell back to whatever the caller passed. The raw
    // declaration count is the part that says "two stages, both pinned".
    expect((realDockerfile().match(/^\s*ARG BUN_SHA256=/gm) ?? []).length).toBe(2);
    expect((realDockerfile().match(/^\s*ARG BUN_VERSION=/gm) ?? []).length).toBe(2);
  });
});

// ──────────────────── the two content gates, caller side ────────────────────

describe("checksumArgProblems", () => {
  test("the real Dockerfile with a clean environment is fine", () => {
    expect(checksumArgProblems(realDockerfile(), {})).toEqual([]);
    // Both gates are actually declared — otherwise the line above passes
    // because this function looked at nothing.
    for (const name of CHECKSUM_ARGS) {
      expect(dockerfileArgDefaults(realDockerfile(), name), name).toHaveLength(1);
    }
  });

  test("an environment override that is not the declared default is REFUSED", () => {
    // The exposure oci/exedev/Dockerfile names and asks this script to close.
    // `BUN_SHA256=<hash-of-anything>` repoints the image's only content gate,
    // and `deriveBuildId` hashes the Dockerfile BYTES rather than the effective
    // arg values — so a substituted image carries a byte-identical buildId and
    // gate B still passes it. Silently ignoring the variable (which is what
    // happened before) is the wrong failure: the operator believes it took.
    // BOTH gates (D1-21): a refactor that special-cased one checksum's
    // override check used to leave the other's refusal path untested.
    for (const name of CHECKSUM_ARGS) {
      const [declared] = dockerfileArgDefaults(realDockerfile(), name);
      const override = declared === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      const problems = checksumArgProblems(realDockerfile(), { [name]: override });
      expect(problems[0], name).toMatch(new RegExp(`^${name}=[fe]{64} is set in the environment`));
      expect(problems.join(" "), name).toContain("CONTENT GATE");
    }
  });

  test("an override EQUAL to the declared default passes; an EMPTY one is refused", () => {
    // The false-positive control: refusing the value the Dockerfile already
    // declares would break a CI job that exports it for a sibling step. An
    // empty/whitespace override used to pass silently — but "set yet blank"
    // is not a way to unset the gate, and passing as if unset is the same
    // "does nothing" failure mode the mismatch refusal exists to prevent.
    const [declared] = dockerfileArgDefaults(realDockerfile(), "BUN_SHA256");
    expect(checksumArgProblems(realDockerfile(), { BUN_SHA256: declared })).toEqual([]);
    expect(checksumArgProblems(realDockerfile(), { BUN_SHA256: "  ", PI_AI_SHA256: undefined })[0]).toMatch(
      /^BUN_SHA256 is set in the environment but is empty or whitespace-only/,
    );
    // UPPERCASE hex is the same 32 bytes — an equal-intent spelling is not a
    // refusal, while a genuinely different digest still is (both gates).
    for (const name of CHECKSUM_ARGS) {
      const [d] = dockerfileArgDefaults(realDockerfile(), name);
      expect(checksumArgProblems(realDockerfile(), { [name]: d!.toUpperCase() }), name).toEqual([]);
      expect(checksumArgProblems(realDockerfile(), { [name]: "E".repeat(64) })[0], name).toMatch(
        new RegExp(`^${name}=E{64} is set in the environment`),
      );
    }
  });

  test("two stages declaring DIFFERENT checksums is refused", () => {
    // One stage then verifies an artifact nobody reviewed — or, worse, the bun
    // that COMPILED the engine is not the bun the marker reports.
    const forked = realDockerfile().replace(/ARG BUN_SHA256=\S+/, `ARG BUN_SHA256=${"e".repeat(64)}`);
    expect(forked).not.toBe(realDockerfile());
    expect(checksumArgProblems(forked, {})[0]).toMatch(/declares "ARG BUN_SHA256" with 2 different defaults/);
  });

  test("a MISSING declaration is refused — a gate with no in-repo default is not a gate", () => {
    const stripped = realDockerfile().replace(/^\s*ARG PI_AI_SHA256=.*$/gm, "");
    expect(checksumArgProblems(stripped, {})[0]).toMatch(/declares no "ARG PI_AI_SHA256=<default>"/);
  });

  test("the S1 gates NODE_SHA256 / OPENRIG_TREE_SHA256 answer every refusal the bun gate answers (F-038)", () => {
    // The loops above generalise over CHECKSUM_ARGS, which grew 2 → 4 names —
    // but generality is exactly what a per-name regression hides in: a typo in
    // one array literal drops that gate from every loop silently. Named, so
    // each new gate is asserted on ITS OWN declared default, empty-override,
    // equal-override and missing-declaration arms. Both declared defaults are
    // now MEASURED PINS, and the map below records which refusal measured
    // each: NODE_SHA256 from run 36031582204, cross-checked against
    // nodejs.org's SHASUMS256.txt line; OPENRIG_TREE_SHA256 from run
    // 36032367862 once the node gate stopped dying first, RE-MEASURED
    // 2026-09-26 from run 36251651875 after upstream ^-range drift inside
    // 0.5.14 (543e846b → 41e10c9a, no CLI version change), and again
    // 2026-09-28 from run 36367093271 — OUR OWN S2.2 member-env patch
    // moved it (41e10c9a → e2cb427c, our own S2.2 patch), then again by the S2.6
    // claude CLI install (e2cb427c → 6b60a34b) — the patched+installed bytes
    // being the pinned identity by design — and a FIFTH time on 2026-09-29
    // from run 36611371706's refusal (e035abfa → f8071b8b, upstream ^-range
    // drift again, no CLI version change; the first CI-measured move since
    // billing was restored) — and a SIXTH time on 2026-10-08 from run
    // 37831713339's refusal (8074bfe6 → 9f148862: hono published 4.13.13 on
    // 2026-10-08T05:35Z and zod published 4.6.5 on 2026-10-02 inside
    // @openrig/cli@0.5.14's caret ranges; the CLI bundle itself unchanged).
    // No external
    // cross-check exists for an npm-resolved tree, so the refusal output IS
    // the measurement, and the hash is what freezes ^-range resolution.
    const measuredDefault = (name: "NODE_SHA256" | "OPENRIG_TREE_SHA256"): string => {
      switch (name) {
        case "NODE_SHA256":
          return "eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29";
        case "OPENRIG_TREE_SHA256":
          return "9f1488626ed4a655312cc0151e2cdfda2c135fcdbf4c3e0963a4dadd9a47e031";
      }
    };
    for (const name of ["NODE_SHA256", "OPENRIG_TREE_SHA256"] as const) {
      expect(CHECKSUM_ARGS, `${name} left CHECKSUM_ARGS`).toContain(name);
      const [declared] = dockerfileArgDefaults(realDockerfile(), name);
      expect(declared, name).toBe(measuredDefault(name));
      // An override that is not the declared default is refused, as a CONTENT
      // GATE — the same message shape the bun gate dies with in main().
      const overridden = checksumArgProblems(realDockerfile(), { [name]: "f".repeat(64) });
      expect(overridden[0], name).toMatch(new RegExp(`^${name}=f{64} is set in the environment and is not `));
      expect(overridden.join(" "), name).toContain(`change ARG ${name} in the Dockerfile`);
      // The sentinel default itself passes, and set-but-empty is still a refusal.
      expect(checksumArgProblems(realDockerfile(), { [name]: declared }), name).toEqual([]);
      expect(checksumArgProblems(realDockerfile(), { [name]: "  " })[0], name).toMatch(
        new RegExp(`^${name} is set in the environment but is empty or whitespace-only`),
      );
      // And a gate stripped from the Dockerfile is a missing declaration.
      const stripped = realDockerfile().replace(new RegExp(`^\\s*ARG ${name}=.*$`, "gm"), "");
      expect(stripped, name).not.toBe(realDockerfile());
      expect(checksumArgProblems(stripped, {})[0], name).toMatch(new RegExp(`declares no "ARG ${name}=<default>"`));
    }
  });
});

// ─────────────── the proprietary licence, declared in three places ───────────

describe("the LicenseRef-QDS-Proprietary declaration", () => {
  test("the root LICENSE and the image's canonical text are BYTE-identical", () => {
    // `binary-licenses.json`'s qds-engine entry asserts this in prose
    // ("…the canonical text at oci/license-texts/LicenseRef-QDS-Proprietary.txt,
    // which is byte-identical to the root LICENSE") and nothing checked it.
    // `resolveLicenseText` resolves the identifier against the oci/ copy, so
    // editing the root LICENSE for a lawyer's wording leaves the text the IMAGE
    // ships stale and that entry's `verifiedHow` false — in the one artifact
    // whose whole purpose is to be true.
    const root = fs.readFileSync(path.join(REPO_ROOT, "LICENSE"));
    const canonical = fs.readFileSync(path.join(REAL_TEXTS, "LicenseRef-QDS-Proprietary.txt"));
    expect(root.length, "LICENSE is empty").toBeGreaterThan(0);
    expect(canonical.equals(root)).toBe(true);
  });

  test("package.json declares the same identifier the table and the text use", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      license?: string;
      version?: string;
    };
    expect(pkg.license).toBe("LicenseRef-QDS-Proprietary");
    // …and the table's qds-engine entry names it, which is what ties the third
    // copy in. PARSED, not substring-grepped: a regenerated (minified,
    // reordered) table with the same semantics must keep passing.
    const engine = (JSON.parse(realTable()) as { entries: { names: string[]; spdxId: string; version: string }[] })
      .entries.find((e) => e.names.includes("usr/local/bin/qds-engine"));
    expect(engine?.spdxId).toBe("LicenseRef-QDS-Proprietary");
    // The entry's VERSION is a claim about THIS repository's release; it was
    // hand-copied from package.json with nothing tying the two (D1-22). A bump
    // that forgot the table published a licence notice naming a version no
    // tag ever existed at.
    expect(engine?.version, "binary-licenses qds-engine version must track package.json").toBe(pkg.version);
  });
});

// ───────────────────────────── AC5 coverage diff ─────────────────────────────

describe("uncoveredBinaries", () => {
  const entries = [
    { names: ["usr/local/bin/bun"], project: "p", spdxId: "MIT", copyright: "c", licenseUrl: "u", verifiedHow: "v" },
    {
      names: ["home/exedev/.local/bin/pi", "usr/local/bin/pi-agent"],
      project: "p",
      spdxId: "MIT",
      copyright: "c",
      licenseUrl: "u",
      verifiedHow: "v",
    },
  ];

  test("an added binary whose PATH is named is covered", () => {
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

  test("#188, INVERTED: the same basename at a DIFFERENT path is now uncovered", () => {
    // This assertion used to read `.toEqual([])` under a `KNOWN CEILING` title,
    // pinning the defect so the fix had to come to this line deliberately.
    // Basename coverage let any executable called `bun` — from any project, at
    // any path — be attributed by a table that establishes oven-sh/bun at
    // /usr/local/bin, so attribution could be satisfied by a coincidence of
    // names. `/opt/vendor/bun` is not the bun this table establishes.
    expect(uncoveredBinaries(["opt/vendor/bun"], entries)).toEqual(["opt/vendor/bun"]);
  });

  test("one entry may attribute several paths, and covers none it does not name", () => {
    expect(uncoveredBinaries(["usr/local/bin/pi-agent"], entries)).toEqual([]);
    expect(uncoveredBinaries(["usr/local/bin/other"], entries)).toEqual(["usr/local/bin/other"]);
  });

  test("a whitespace-padded name still covers, rather than validating clean and attributing nothing", () => {
    // `nonEmpty` TRIMS during validation, so a padded name passes the table
    // check — while the coverage compare did not trim, so the entry attributed
    // nothing and the binary reported as uncovered with the diagnostic "no
    // entry in oci/exedev/binary-licenses.json". There was an entry. Fails
    // closed, but at a problem that does not exist.
    const padded = [{ ...entries[0]!, names: [" usr/local/bin/bun "] }];
    expect(uncoveredBinaries(["usr/local/bin/bun"], padded)).toEqual([]);
  });

  test("the real table covers the binaries the last real build reported adding", () => {
    // bun is installed by the Dockerfile at /usr/local/bin/bun; pi's real file
    // is the one `find -type f` sees, under /home/exedev/.local. A path that
    // moves without the table moving fails the build — loudly, in the direction
    // of "this binary needs attributing", which is the whole point.
    const table = (JSON.parse(realTable()) as { entries: Parameters<typeof uncoveredBinaries>[1] }).entries;
    expect(uncoveredBinaries(["usr/local/bin/bun"], table)).toEqual([]);
    expect(uncoveredBinaries(["home/exedev/.local/pi/pi"], table)).toEqual([]);
    expect(uncoveredBinaries(["usr/local/bin/qds-engine"], table)).toEqual([]);
    expect(uncoveredBinaries(["opt/vendor/bun"], table)).toEqual(["opt/vendor/bun"]);
  });
});

// ─────────────────── #187: the build tag is not a digest input ───────────────────

describe("QDS_BUILT_AT is commit-derived, not wall-clock", () => {
  test("`builtAt` is the ISO rendering of the epoch and of nothing else", () => {
    // #187 was closed by stripping the TAG out of `QDS_IMAGE_REF`, and the
    // obvious next question is whether the marker's `builtAt` — which reaches
    // /etc/qds-image.json AND, since DF1.10, an image-config LABEL — is still
    // a wall-clock value. It is not: `main` computes it from `epoch`, i.e. from
    // `SOURCE_DATE_EPOCH` or the source commit's timestamp. If it ever went
    // back to `new Date()`, every rebuild of an identical tree would yield a
    // different digest and the reproducibility gate would be failing BY
    // CONSTRUCTION — with the publish workflow's new failure text confidently
    // telling operators the tag is not the cause.
    //
    // Asserted against the source line because the derivation lives inside
    // `main`, which needs a docker daemon to reach. Narrow on purpose: the
    // script's OTHER `new Date()` is the scratch-dir heartbeat touch, which is
    // wall-clock precisely because it must be.
    const src = fs.readFileSync(path.join(REPO_ROOT, "scripts/build-exedev-image.ts"), "utf8");
    expect(src).toContain("const builtAt = new Date(epoch * 1000).toISOString();");
    expect(src).toContain("const epoch = sourceDateEpoch(gitSha);");
    // The negative arms cover the direct spellings of a wall-clock
    // derivation, not just `new Date()` after `const builtAt = ` (D1-20): a
    // REASSIGNMENT (`let builtAt = …; builtAt = new Date()`), spaced parens
    // (`new Date ()`), a bare constructor (`builtAt = new Date;`), or a
    // wrapped clock read (`new Date(Date.now())`). NOT covered, named so the
    // next editor does not trust this further than it goes: an INDIRECT read
    // through an intermediary (`const now = new Date(); builtAt =
    // now.toISOString()`) or a clock source spelled some other way
    // (`performance.now()`, `process.hrtime`) — those need a reader that
    // follows the dataflow, not a regex over the source text. All three arms
    // match the legitimate line above, which reads the epoch, not the clock.
    expect(src).not.toMatch(/\bbuiltAt\s*=[^;\n]*new Date\s*\(\s*\)/);
    expect(src).not.toMatch(/\bbuiltAt\s*=[^;\n]*new Date\s*;/);
    expect(src).not.toMatch(/\bbuiltAt\s*=[^;\n]*Date\.now\(\)/);
  });
});

describe("buildArgList (#187)", () => {
  const base = {
    bunVersion: "1.3.13",
    piVersion: "0.84.4",
    // DELIBERATELY SYNTHETIC, like the `gitSha` beside it. This is an INPUT to
    // `buildArgList`, not the repo pin — #187 asks whether two tags feed
    // BuildKit identical args, and the buildId's VALUE is irrelevant to that.
    // It used to spell the then-current pin (`3cf094fb6990ed66`), which made a
    // re-pin's "did I catch every literal?" grep return this line as a false
    // hit — DF1.10's re-pin hit exactly that and had to read the test to rule
    // it out. A value that cannot be mistaken for a pin costs nothing here.
    buildId: "b".repeat(16),
    gitSha: "a".repeat(40),
    builtAt: "2026-09-03T00:00:00.000Z",
    epoch: 1_756_857_600,
  };

  test("two builds of the same tree under DIFFERENT tags feed BuildKit identical inputs", () => {
    // #187's acceptance item, asserted rather than assumed — and asserted at
    // the only place it CAN be without a registry: the build args are the sole
    // channel by which a `--tag` could reach a layer. `--tag` itself names the
    // local/registry reference and contributes no manifest bytes, and
    // `deriveBuildId` never saw the tag to begin with. So identical arg lists
    // means identical solve inputs means one digest for both tags — which is
    // what unbreaks the publish workflow's first run and re-couples the artifact
    // that was live-booted to the artifact that ships.
    const a = buildArgList({ ...base, tag: "ghcr.io/quantum-digital-solutions/qds-exedev:sha-abc123" });
    const b = buildArgList({ ...base, tag: "ghcr.io/quantum-digital-solutions/qds-exedev:df2-10" });
    expect(a).toEqual(b);
  });

  test("the marker still records WHICH REPOSITORY the bytes came from", () => {
    // Option 2 in the issue (drop `imageRef` entirely) was cleaner for
    // reproducibility and cost this provenance line plus a marker key-set
    // change. Option 1 keeps both.
    expect(buildArgList({ ...base, tag: "ghcr.io/x/qds-exedev:v9" })).toContain(
      "QDS_IMAGE_REF=ghcr.io/x/qds-exedev",
    );
  });

  test("a digest-pinned tag reduces to the same repository as a named one", () => {
    const byTag = buildArgList({ ...base, tag: "ghcr.io/x/y:v1" });
    const byDigest = buildArgList({ ...base, tag: `ghcr.io/x/y@sha256:${"c".repeat(64)}` });
    expect(byTag).toEqual(byDigest);
  });

  test("no build arg carries a tag-shaped value", () => {
    // The generic form of the two cases above: whatever else moves, nothing in
    // this list may contain the `:tag` the caller passed.
    for (const arg of buildArgList({ ...base, tag: "ghcr.io/x/y:some-unique-tag" })) {
      expect(arg).not.toContain("some-unique-tag");
    }
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

// ─────────────────────── registry refusal classification ───────────────────────

/**
 * The denied-vs-absent split `inspectManifest` keys its fail-safe on: only a
 * registry that ANSWERED "no such reference" (`absent`) leaves the daemon's
 * local copy as a defensible digest source; a DENIAL (401/403/rate limit) or
 * SILENCE (timeout, DNS blip, docker down) is fatal, because a local
 * substitution would fold a digest in for bytes buildx will not use. Until this
 * block, the vocabulary had ZERO coverage — and the Hub's private-repo refusal
 * string is quoted in the source as a previously-shipped bug (it matched the
 * old loose "not found"/"does not exist" matchers, licensing exactly that
 * substitution on an AUTH failure).
 *
 * Pure function of stderr text, table-driven so a vocabulary edit fails the ROW
 * it changed rather than the whole class.
 */
describe("classifyRegistryRefusal", () => {
  const rows: [string, boolean, boolean][] = [
    // DENIED — including the Hub's canonical private-repo refusal, which carries
    // an absent-shaped tail ("repository does not exist") that must NOT win: the
    // denial vocabulary is checked first and vetoes. This exact string is the
    // previously-shipped bug the source docblock records.
    [
      "pull access denied for private/base, repository does not exist or may require 'docker login'",
      true,
      false,
    ],
    // Bare 401/403/rate-limit spellings, as registries actually emit them.
    ["unauthorized: authentication required", true, false],
    ["denied: requested access to the resource is denied", true, false],
    ["error pulling image: 403 forbidden", true, false],
    ["toomanyrequests: you have reached your pull rate limit", true, false],
    // ABSENT — the registry answered, and its answer was "no such reference".
    // Only this class may fall back to the daemon's local record.
    ["not found: manifest unknown for linux/amd64", false, true],
    ["MANIFEST_UNKNOWN: manifest unknown", false, true],
    ["no such manifest for ref ghcr.io/x/y:v1", false, true],
    ["NAME_UNKNOWN: repository name not known to registry", false, true],
    // SILENCE — neither fact, and the one that matters most: a timeout, a DNS
    // blip or an empty stderr must not read as a negative answer. The old loose
    // matchers (`not found`, `does not exist`) turned exactly these into
    // "absent" whenever the wording happened to graze them.
    ["", false, false],
    ["error: timed out waiting for the registry to respond", false, false],
    ["proxyconnect tcp: dial tcp: lookup proxy.example.com: no such host", false, false],
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", false, false],
    // The retired loose vocabulary, pinned as GONE: a bare "not found" or
    // "does not exist" with no denial word and no manifest-unknown spelling is
    // silence, not absence.
    ["404 page not found", false, false],
    ["repository does not exist", false, false],
  ];

  for (const [stderr, denied, absent] of rows) {
    test(`${JSON.stringify(stderr.slice(0, 60))} → {denied: ${denied}, absent: ${absent}}`, () => {
      expect(classifyRegistryRefusal(stderr)).toEqual({ denied, absent });
    });
  }

  test("a denial vetoes even when an absent-shaped spelling rides along in the same message", () => {
    // The Hub string above is one instance; this pins the ORDER as a property
    // rather than as one row: every denied-bearing stderr is non-absent however
    // much manifest-unknown text it also carries.
    expect(
      classifyRegistryRefusal("pull access denied for x: manifest unknown (may require 'docker login')"),
    ).toEqual({ denied: true, absent: false });
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

describe("parseManifestRaw", () => {
  // The evidence field the publish workflow uploads on every push run: the
  // pushed manifest's config digest + one row per layer. When two same-source
  // runs diverge (36063335634 vs 36077483206: +48 compressed bytes, unchanged
  // buildId), the DIFFERENCE of two inventories names the moving layer by
  // digest and size — which is the whole reason the field exists. These tests
  // pin the parser's contract: shape-valid manifests parse, and every
  // malformed shape lands in `error` — never in a fabricated inventory.
  const goodLayer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: `sha256:${"a".repeat(64)}`,
    size: 1234,
    ...over,
  });
  const goodManifest = (layers: Record<string, unknown>[] = [goodLayer()]): string =>
    JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${"b".repeat(64)}`, size: 42 }, layers });

  test("a well-formed single-layer manifest parses to config + one row", () => {
    const parsed = parseManifestRaw(goodManifest());
    expect("error" in parsed).toBeFalse();
    const inv = parsed as ManifestInventory;
    expect(inv.config).toBe(`sha256:${"b".repeat(64)}`);
    expect(inv.layers.length).toBe(1);
    expect(inv.layers[0]).toEqual({
      digest: `sha256:${"a".repeat(64)}`,
      size: 1234,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    });
  });

  test("a multi-layer manifest preserves layer order (the inventory maps onto the Dockerfile's RUN sequence)", () => {
    const l1 = goodLayer({ digest: `sha256:${"1".repeat(64)}` });
    const l2 = goodLayer({ digest: `sha256:${"2".repeat(64)}`, size: 2_000_000 });
    const parsed = parseManifestRaw(goodManifest([l1, l2]));
    expect("error" in parsed).toBeFalse();
    expect((parsed as ManifestInventory).layers.map((l) => l.digest.slice(7, 8))).toEqual(["1", "2"]);
  });

  test("a referrer INDEX (the attestation shape) is an error, not an inventory with zero layers", () => {
    const index = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"c".repeat(64)}`, size: 99 }],
    });
    const parsed = parseManifestRaw(index);
    expect("error" in parsed).toBeTrue();
  });

  test("each malformed shape lands in error, never in rows", () => {
    expect("error" in parseManifestRaw("not json at all")).toBeTrue();
    expect("error" in parseManifestRaw(JSON.stringify({ config: { digest: "sha256:short" }, layers: [goodLayer()] }))).toBeTrue();
    expect("error" in parseManifestRaw(JSON.stringify({ config: { digest: `sha256:${"b".repeat(64)}` } }))).toBeTrue();
    expect("error" in parseManifestRaw(goodManifest([goodLayer({ digest: "not-a-digest" })]))).toBeTrue();
    expect("error" in parseManifestRaw(goodManifest([goodLayer({ size: Number.MAX_SAFE_INTEGER + 1 })]))).toBeTrue();
    expect("error" in parseManifestRaw(goodManifest([goodLayer({ mediaType: null })]))).toBeTrue();
    // A negative or non-finite size is a fabricated measurement, not a row:
    // the inventory's whole job is layer-level size diffing, so a row whose
    // size lies poisons the one comparison it exists to serve.
    expect("error" in parseManifestRaw(goodManifest([goodLayer({ size: -1 })]))).toBeTrue();
    // An empty mediaType is the same species: a row that records nothing where
    // a type belongs.
    expect("error" in parseManifestRaw(goodManifest([goodLayer({ mediaType: "" })]))).toBeTrue();
  });
});
