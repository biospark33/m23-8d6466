# edge-tests-assets

## [MEDIUM] `imageMarkerTruncated` serves an ExecResult the production seam cannot produce, so no gate-level test covers a real cap hit

- **File:line:** `tests/providers/exedev/fixtures/fake-exedev.ts:702` (arm ends 711)
- **Trigger:** A real capped marker read is `{ truncated: true, exitCode: 137 }` — `readBounded` calls the `kill` seam on cap breach, SIGKILL, so the exec exits 137 *and* reports truncation. The fake serves `exitCode: 0`. Consequence: the only gate-level consumer of this knob (`tests/providers/exedev/image-contract.test.ts:1183`, asserting `/exceeds the transport read cap — refused unparsed/`) passes identically whether `readBoxFile` checks `read.truncated` before or after `read.exitCode`. Swap those two blocks in `transport.ts` and the gate still classifies the fake's cap hit as `oversized`; against a real box the same read becomes `{kind:"unreadable", exitCode:137}` → `transportFault(137)` → code `image-marker-unreachable` with a "re-create the box" remediation, i.e. the exact misclassification `transport.ts:159-166` documents. Nothing at the gate level asserts a real cap hit lands on `image-marker-mismatch`.
- **Evidence:**
  ```ts
  if (cfg.imageMarkerTruncated) {
    const whole = marker ?? "";
    return {
      stdout: whole.slice(0, Math.floor(whole.length / 2)),
      stderr: "",
      exitCode: 0,
      truncated: true,
    };
  }
  ```
- **Confirmed by:** `src/providers/exedev/transport.ts:70-83` — `readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { kill, exited })` with `killSignal: "SIGKILL"`, so truncation and a 137 exit arrive together; `transport.ts:159-169` states this pair explicitly ("the cap breach KILLS the exec … SIGKILL → exit 137"); `transport.ts:320-322` shows `EXEC_KILLED_EXIT = 137` routing an `unreadable` read to `image-marker-unreachable`. Grep for `imageMarkerTruncated` across `tests/` returns exactly one consumer, `image-contract.test.ts:1183`. The correct ordering is pinned only by the new unit test `tests/providers/exedev/read-box-file.test.ts:46`, which uses `driverOf`, not the fake.

## [MEDIUM] The fake records `--image` but serves the marker independently of it — every box "booted" the pinned image no matter what the driver asked for

- **File:line:** `tests/providers/exedev/fixtures/fake-exedev.ts:537` (the `creates.push` / `ensureBox` arm) with `tests/providers/exedev/fixtures/fake-exedev.ts:670` (the marker the same box then serves)
- **Trigger:** `new --name X --image <ref>` creates a box whose `/etc/qds-image.json` is `DEFAULT_IMAGE_MARKER`, whose `buildId` is `DEFAULT_IMAGE_BUILD_ID` — the same constant gate B compares against (`driver.imageBuildId`, defaulted at `driver.ts:521`). So a driver that threads a *wrong* image ref to `new` (a stale digest, a dropped operator override, or the documented-legal `new ExeDevDriver({ image })` with no matching `imageBuildId`) still produces a box that passes gate B green. Reality does the opposite: a box booted from a different image bakes that image's own `buildId` and gate B refuses. Only the tests that explicitly assert `fake.creates` (`image-contract.test.ts:300, 323, 356, 495, 830, 881`) can see the wrong ref; every provision→gate→run test in the suite is optimistic about it.
- **Evidence:**
  ```ts
  creates.push({ name, ...(m[3] === undefined ? {} : { tag: m[3] }), image: m[4] as string, ... });
  ensureBox(name);          // the image ref is recorded and then discarded
  ...
  const marker = cfg.imageMarker === undefined ? DEFAULT_IMAGE_MARKER : cfg.imageMarker;
  ```
- **Confirmed by:** `src/providers/exedev/driver.ts:519-521` (`this.image = opts.image ?? DEFAULT_IMAGE_REF; this.imageBuildId = opts.imageBuildId ?? DEFAULT_IMAGE_BUILD_ID` — the two halves default independently); `driver.ts:1249-1259` guards the pair only in the factory path and its own comment says "direct `new ExeDevDriver({ image })` remains legal as the documented test seam"; `src/providers/exedev/transport.ts:382-392` compares `marker.buildId` only, `imageRef` is "REPORTED, never compared".

## [LOW] "the four copies" of the steering tuple is five — `BOX_STEERING_ROOT_SH` is not among them

- **File:line:** `tests/providers/exedev/image-assets.test.ts:357` (describe) / `tests/providers/exedev/image-assets.test.ts:363` (the cross-copy test)
- **Trigger:** The suite checks four resolvers of the `/run/steering` default — the tmpfiles drop-in, `STEERING_PROVISION_SCRIPT` (`driver.ts:98`), `steeringRoot()` (`attach.ts:62`) and the Dockerfile assert (`Dockerfile:245`). `src/fleet/attach.ts:80` holds a *fifth*, `BOX_STEERING_ROOT_SH = 'root="${QDS_STEERING_ROOT:-/run/steering}"'`, and it is the one the box-side append/read scripts actually run (`attach.ts:230`, `attach.ts:292`). Drift there — the leg that writes `inbox.ndjson` into the channel the tmpfiles entry provisions — leaves this whole suite green. Its only pin is a hard-coded literal in an unrelated suite, `tests/fleet/gate-verbs.test.ts:1165`; relax or parameterise that literal and the fifth copy becomes unguarded.
- **Evidence:** `test("the drop-in and the driver's provision script cannot silently diverge", ...)` reads `DRIVER_PATH`, `TMPFILES_TEXT`, `steeringRoot()` and `DOCKERFILE_PATH`, and never `src/fleet/attach.ts`'s script constant.
- **Confirmed by:** `grep -rn '/run/steering' src/` returns `driver.ts:98`, `attach.ts:62`, `attach.ts:80`, `oci/exedev/systemd/qds-steering.conf:1`, `oci/exedev/Dockerfile:245`; `grep -rn BOX_STEERING_ROOT_SH src/` shows it consumed at `attach.ts:230` and `attach.ts:292`.

## [LOW] The tmpfiles negative control exercises the splitter, not the assertions it claims to guard

- **File:line:** `tests/providers/exedev/image-assets.test.ts:594` (test body 595-606)
- **Trigger:** The unit mutation table re-runs the real `POLICIES` against each mutated file and asserts *exactly* which ones reject it — that is what proves those policies can fail. The tmpfiles counterpart does not: it runs `tmpfilesEntries` over four strings and asserts the result `.not.toEqual(good)`. `tmpfilesEntries` is a pure `split(/\s+/)`, so those four assertions hold for any implementation that does not literally return `good` for every input. Neither of the two real tmpfiles assertions (`image-assets.test.ts:359`'s exact-shape check, and the cross-copy comparison at 363) is ever run against a mutated entry, so nothing proves the cross-copy test rejects a drifted tuple — only the exact-equality check at 359 does, and it is untested against a mutation.
- **Evidence:**
  ```ts
  const good = [["d", EXPECTED_STEERING_ROOT, "0700", BOX_USER, BOX_USER]];
  for (const [why, text] of wrong) {
    expect(tmpfilesEntries(text), why).not.toEqual(good);
  }
  ```
- **Confirmed by:** `tmpfilesEntries` at `image-assets.test.ts:339-346` is `split("\n").map(trim).filter(…).map(l => l.split(/\s+/))` — no policy logic; contrast `image-assets.test.ts:568-577`, where the unit mutations are fed through `POLICIES.filter(p => p.violations(mutated).length > 0)`.
