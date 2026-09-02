# W2-D test report — `tests/scripts/build-exedev-image.test.ts` (new)

Round 1, PR #184 (DF2.10). **72 tests, all passing.** One new file, nothing else touched.
No commits, no `git add`. `scripts/build-exedev-image.ts` was mutated four times for the
falsifiability proof below and restored **byte-identically** (sha256 verified, see
"Mutation evidence").

Ten of the eleven functions named in the brief now have tests. Every assertion is a fixed
vector or a one-field-changed pair; there is no `toBeDefined()` in the file.

## Coverage per function

### `deriveBuildId` — 15 tests (the HIGH finding)

The identity gate B enforces in-box, previously with zero tests, and with the publish
workflow computing BOTH sides of its "pushed buildId == repo pin" check from this same
function — so a dropped input is invisible to every gate simultaneously.

- **Determinism + shape:** two separately-constructed identical input sets produce the same
  id; the id is `/^[0-9a-f]{16}$/` (this is also what pins the 64-bit truncation).
- **Set-not-sequence:** `baseDigests` and `systemdFiles` handed over in reverse order produce
  the same id. Pins both `.sort()` calls — the filesystem's readdir order must not move the
  identity, or a rebuild on another host reproduces the substrate and fails the pin.
- **One-field-changed, 9 rows, one per input the interface declares:** a base digest; the
  *number* of base digests; the bun version; the pi version; one byte of the Dockerfile; the
  bytes of `qds-run@.service`; the bytes of `qds-steering.conf`; the *name* of a systemd file;
  the *set* of systemd files (one dropped). Each must produce a different id.
- **A guard against a future uncovered input:** one test asserts the exact key set of
  `BuildIdInputs`. A new field added without a mutation row fails at the moment the row is
  cheap to write.
- **Length framing, three tests,** pinning what the docstring actually promises:
  1. `bun=1.3 pi=13.0` vs `bun=1.31 pi=3.0` (the docstring's own example);
  2. a Dockerfile ending in the bytes that begin the first unit, vs the shifted split;
  3. **the load-bearing one** — two units `{a:"X"}, {b:"Y"}` vs one unit whose bytes are
     `"X\nsystemd/b.conf:\nY"`. These are byte-identical under `label + ":\n" + value + "\n"`
     and differ only because of the byte-length prefix.
- **Byte-length, not code-unit length:** a `bunVersion` containing `ő`.

Honest note on the three framing tests: only #3 actually depends on the length prefix.
#1 and #2 are already distinguished by the labels and the trailing newline, so they document
the docstring's claims rather than testing the prefix. #3 is the one that goes red when the
prefix is removed (measured — see below).

### `resolveRuntimeBaseRef` (new) — 8 tests

- Real Dockerfile bottoms out at the pinned `ghcr.io/boldsoftware/exeuntu@sha256:…`, and the
  old "last ref" heuristic still agrees on today's single-FROM file.
- **The divergence:** `FROM a AS r / FROM b AS x / FROM r` → `"a"`, asserted *alongside*
  `parseBaseRefs(df).at(-1) === "b"`, so the test states the bug it replaced rather than just
  the new answer. (Diffing against the builder makes every executable the real base ships read
  as "added" — or, with the fatter image on the wrong side, subtracts real added binaries away
  so they ship unattributed. DF1.10 adds exactly this shape.)
- **Dedup collapse:** `FROM base AS build / FROM other AS x / FROM base` → `"base"`, with
  `parseBaseRefs` → `["base","other"]` asserted to show "last" is no longer last.
- Multi-hop chase with mixed-case stage names; `--platform=` flag dropped.
- `null` on: a stage cycle; a `scratch` final stage, both directly and reached through an
  alias; no `FROM` at all.

### `parseBaseRefs` — 7 tests (pinning the "byte-identical refactor" claim)

Real Dockerfile yields exactly one ref (asserted as the literal digest ref, so a base bump
that forgets the buildId is a visible diff here); own-stage exclusion including mixed case;
`scratch` exclusion including `SCRATCH`; dedup preserving first-seen order; `--platform` and
lowercase `from`; commented-out and inline-commented FROMs ignored.

Plus one test named **`KNOWN GAP`**: `COPY --from=busybox:1.36` contributes bytes to the
published substrate and nothing to the buildId, so that foreign image could move under us
without moving the identity. The test asserts today's behaviour (`["alpine"]`) with a comment
saying why it is not fixed here — closing it means resolving those refs to digests, which is a
registry read this function does not do. A fix has to come to this line and change it
deliberately.

### `metadataDigests` (new) — 8 tests

All three shapes (flat → scope `""`; `"<exporter>.containerimage.digest"`; nested
`{ image: { … } }`); the two-exporter gating build disambiguated by `get("image")`; two
exporters reporting the *same* digest (`distinct.size === 1`, nothing to disambiguate); the
**ambiguous** case asserted as exactly the two facts the caller's fatal refusal keys on
(`get("image") === undefined` and `distinct.size === 2`); rejection of a non-digest string,
uppercase hex, a 63-char digest and a number; and a metadata file that carries no digest,
including `containerimage.descriptor` (a similar-looking key that must not be read) and an
array value that must not be treated as an exporter object.

### `tarUnescape` (new) — 6 tests

Plain path untouched; `\n`/`\t`/`\r`; `\\` → one backslash, and `\\n` → backslash-then-`n`
(not a newline); **the byte-decode test** — `etc/ssl/certs/\305\221.pem` → `etc/ssl/certs/ő.pem`,
asserted three ways: equality with the correct string, *inequality* with the per-code-unit
mojibake `Å`, and a length assertion proving one character not two; three-digit octal
taking priority over the C-escape table (`\012` → newline, `\101` → `A`); and unescaped
backslashes kept verbatim, including a trailing one and a two-digit `\30`.

### `dockerfileArgDefault` (new) — 6 tests

Present default with and without surrounding whitespace; `ARG` with no default → `null`;
absent `ARG` → `null`; **no prefix matching** (`"PI"` must not read `ARG PI_VERSION`, which
is what makes the real pairing below meaningful); a default containing whitespace → `null`
(documented, since `(\S+)` means it reads as *missing* rather than silently truncated — and
the caller's divergence check then dies, i.e. fail-closed).

**Lockstep:** `dockerfileArgDefault(realDockerfile, "PI_VERSION") === PI_VERSION`. The
`BUN_VERSION` half stays in `exedev-bun-pin.test.ts`; not duplicated.

### `validateBinaryLicenses` — 10 tests

Accepting shape → `[]`; **the real `oci/exedev/binary-licenses.json` validates clean against
the real `oci/license-texts/`**; totality across `null`, `undefined`, `[]`, `"entries"`, `7`,
`{}`, `{entries:[]}`, `{entries:"x"}` — each returns exactly one "carries no entries" problem
instead of throwing (a throw exits 1, the code the contract reserves for a *compliance*
failure, so a malformed file would have been reported as a licence violation); `names`
rejected as absent / empty / whitespace-only / non-string / a bare string; each of the five
required attribution fields rejected individually by name; `UNVERIFIED` rejected as a failure
rather than a warning; an SPDX id with no canonical text; a `bundled` disclosure missing
`component`/`url`/`note` (including `[{}]` and `[null]`), and a complete one accepted;
per-entry indexing (`entry 1`, `entry 2`) so a table with several problems reports all of them.

One extra lockstep on the file that changed this round: **the table names `bunx` exactly when
the Dockerfile installs it.** Written as an implication over both sides (the Dockerfile
installs one file and creates no symlink), so it fails if either side moves alone — which is
what the entry's own `notes` asks for.

### `uncoveredBinaries` — 5 tests

Covered basenames → `[]`; an uncovered binary reported at its **full path**, not its basename;
an empty table leaves everything uncovered; nothing added → nothing to attribute.

Plus one test named **`KNOWN CEILING`** recording Wave 1's deferral with its stated reason:
`uncoveredBinaries(["opt/vendor/bun"], entries)` → `[]`, because matching is on
`path.basename`. Closing it requires `binary-licenses.json`'s `names[]` to become paths, and
the real installed paths cannot be enumerated without a build — a round-2 item, not a silent
gap. The assertion pins today's behaviour so the fix must land here.

### `nodeModulesRoot` — 4 tests

Root returned for a nested entry and for a top-level one; the **outermost** root for
`a/node_modules/b/node_modules/c` (keying on the inner one would leave the outer packages
unswept); the path boundary (`my_node_modules/x`, `xnode_modules/x` → `null`); no tree → `null`.

### `BunPinError` — 1 test, deliberately non-duplicative

Wave 1's four rejection paths in `exedev-bun-pin.test.ts` assert the *message*. Its one
caller does `die(2, err.lines)`, and `lines` — the property that actually reaches the operator
— was asserted by nothing. One test confirms it is a non-empty array of non-empty strings, so
a refusal cannot print a fatal with no reason. No gap left beyond that.

## Mutation evidence — proof the `deriveBuildId` tests can fail

Four mutations, each applied to `scripts/build-exedev-image.ts`, run, then reverted by copying
back a pre-mutation snapshot. **All red tests are exactly the intended ones; nothing else moved.**

| # | Mutation | Result |
|---|---|---|
| M1 | drop the `systemdFiles` loop from the hash | **5 fail** / 67 pass — both `bytes` rows, the `name` row, the `set` row, and the length-prefix test |
| M2 | `field()` framing → `label + ":\n"` (drop the byte-length prefix) | **1 fail** / 71 pass — `the framing is a LENGTH prefix, not merely a trailing newline` |
| M3 | drop the `baseDigests` loop from the hash | **2 fail** / 70 pass — `a base image digest`, `the number of base image digests` |
| M4 | drop both `.sort()` calls | **1 fail** / 71 pass — `is a function of the SET of inputs, not of the order they arrived in` |

Restore verified after every mutation:
`shasum -a 256 -c` against the pre-mutation digest
`4b6d4f44011f01f341423d424c35509221f37a06af7d31157a781377bdd151d8` → **OK** each time. The
file is back to Wave 1's exact bytes; `git status` still shows it as the single ` M` Wave 1
left, and `git diff --stat` is unchanged at 709 insertions / 107 deletions.

M2 is the reason the length-prefix test is written the way it is: the two examples the
docstring gives are distinguished by the trailing newline alone and survive that mutation.
Only the smuggled-label case actually requires the prefix.

## Defects found — none new

Nothing I could reach with a pure-function test is wrong. The three real limitations I hit are
all already known and are now pinned by named tests rather than left implicit:

1. `parseBaseRefs` ignores `COPY --from=<external image>` (my `KNOWN GAP` test).
2. `uncoveredBinaries` matches on basename (my `KNOWN CEILING` test; Wave 1's stated deferral).
3. `validateBinaryLicenses` does not reject two entries claiming the same name under different
   licences, nor require `names[]` to be basenames rather than paths. Not filed as a defect —
   it is the same shape as (2) and the same fix closes it.

One robustness observation, **not** a defect and not tested (the behaviour is fail-closed):
the caller's disambiguation is `digests.get("image")`, which assumes buildx names the
`type=image` exporter `"image"` in namespaced metadata. If a future buildx names it otherwise,
the two-exporter case becomes `die(2)` before the gates with a message that already says
"build-tooling mismatch, not a supply-chain finding" — the right direction, but it will be a
hard stop rather than a fallback.

## Gate output

- `bun test tests/scripts/build-exedev-image.test.ts` → **exit 0, 72 pass / 0 fail**
  (`/tmp/test-buildscript.log`).
- `bun test tests/scripts/` → **exit 0, 395 pass / 0 fail** (`/tmp/test-buildscript-dir.log`).
  The known `install-gitnexus-plus.sh — EMBEDDINGS_FLAG branch` flake passed on this run.
  395 = Wave 1's 323 + my 72.
- `bunx @biomejs/biome check tests` → **exit 0**, "Checked 164 files in 4s. No fixes applied."
- `bunx tsc --noEmit` → **exit 2, four errors, none in my file and none in any file I touched**
  (all are other waves' in-flight edits, captured at `/tmp/bs-tsc.log`):
  - `tests/fleet/e2e/tier1-image-contract.live.test.ts(130,9)` TS6133 `destroyError` unused
  - `tests/fleet/e2e/tier1-image-contract.live.test.ts(491,15)` TS2304 `destroyQuietly` not found
  - `tests/providers/exedev/image-assets.test.ts(387,35)` TS2769 `string | undefined` argument
  - `tests/providers/exedev/setup-gate.test.ts(17,1)` TS6133 `IMAGE_MARKER_PATH` unused

  The first two look like a half-applied rename in the live-test file (a helper renamed at one
  call site and not defined) — worth flagging to whoever owns `tier1-image-contract.live.test.ts`.
- **No docker build, no network, no filesystem writes.** The only files read are
  `oci/exedev/Dockerfile`, `oci/exedev/binary-licenses.json` and `oci/license-texts/`.
