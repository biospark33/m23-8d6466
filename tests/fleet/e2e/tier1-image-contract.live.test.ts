/**
 * DF2.10 — the factory boot image contract, proven on a REAL exe.dev box.
 *
 * THIS FILE IS THE ANSWER TO THE STORY'S NAMED NEGATIVE CONTROL.
 * DF2.10's DoD says: "a test asserting only that `docker build` and
 * `docker push` exited 0 proves the image exists and nothing about whether
 * exe.dev can boot it, and MUST fail this one." So nothing here shells to
 * docker, reads a build exit code, or inspects a local image. Every assertion
 * below is made against a BOOTED box, over real ssh:
 *
 *   AC1   systemd is PID 1 and `systemctl is-system-running` is running/degraded
 *   AC1   ssh answers as the `exe.dev/login-user` (`exedev`)
 *   AC2   in-box `bun --version` / `pi --version` == the marker's pinned pair,
 *         AND the in-box bun == the repo's own pin (readBunPin/package.json),
 *         which is the only assertion here the marker cannot satisfy alone
 *   IBOX-2 `/etc/qds-image.json` present, under the 4 KiB cap, six keys non-empty,
 *         and its `buildId` == the repo pin (DEFAULT_IMAGE_BUILD_ID)
 *   AC1   every setup-gate assertion A–E passes on THIS box (real gate, real driver)
 *   AC6   after a real `sudo reboot`, /run/steering returns at 0700 exedev:exedev
 *         with NO code path having run — the baked /etc/tmpfiles.d entry alone,
 *         and a negative control (delete it, exec again, require it to stay
 *         gone) proves `exec` is not the thing that put it there
 *   AC7c  built image size + cold-boot time RECORDED (the ADR's two named
 *         re-opening falsifiers), never asserted against an invented ceiling
 *   AC1a/b which pin shape actually shipped (digest vs immutable tag), recorded
 *
 * The driver DEFAULTS to the repo pin (`DEFAULT_IMAGE_REF`, driver.ts), so
 * `ctx.driver.create(vm)` already boots the factory image. No `--image`
 * override is passed here on purpose: passing one would prove that an override
 * works, not that the PRODUCTION default boots.
 *
 * ── SPEND WARNING — THIS IS A TIER-2 TEST DESPITE THE FILE NAME ─────────────
 * Setup-gate assertions C, D and E are REAL OpenRouter chat/completions calls
 * from inside the box (`assertions-in-box.sh`), so proving "every setup gate
 * passes" costs real money — a few cents at most, hard-capped by a freshly
 * minted run key at CAP_MICRO_USD. The skill's tier table defines TIER-1 as
 * "boxes only, 0 model spend", so this test gates at **TIER-2**:
 * `liveGate("2")` + `preflight("2")`, i.e. it refuses to run unless the
 * operator has set QDS_E2E_TIER=2 and approved spend out of band. The file
 * name and the `t1-image-contract` evidence name are the story's, not a tier
 * claim. Worst case per run: 1 key × CAP_MICRO_USD + one box for < 10 min.
 *
 * NO FAKES: real `ssh exe.dev`, real ExeDevDriver, real OpenRouter key API,
 * real setup gate. The box is destroyed FIRST and the key revoked in `finally`,
 * each step guarded so no cleanup failure can skip a later one or replace the
 * test's own result — and a destroy that FAILED fails the run, because a box
 * still billing is the one outcome this file must never report green.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readBunPin } from "../../../scripts/build-exedev-image.ts";
import { deliverRunKey, mintRunKey, openRouterKeyApi } from "../../../src/providers/credentials.ts";
import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  IMAGE_MARKER_MAX_BYTES,
  IMAGE_MARKER_PATH,
  parseImageMarker,
} from "../../../src/providers/exedev/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  liveGate,
  liveTodoOff,
  preflight,
  revokeQuietly,
  runIdFor,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

/** Same per-key ceiling every other paid tier uses (skill: default 50 000 µ$). */
const CAP_MICRO_USD = 50_000;
/** Where `scripts/build-exedev-image.ts` writes the size half of AC7c. */
const BUILD_EVIDENCE_PATH = join(REPO_ROOT, "oci/.build/exedev/build-evidence.json");
/** First-ssh budget after `create()` returns (the cold-boot measurement). */
const BOOT_BUDGET_MS = 120_000;
/** Post-`sudo reboot` budget: ssh back AND a CHANGED boot id. */
const REBOOT_BUDGET_MS = 240_000;
const POLL_INTERVAL_MS = 5_000;
/**
 * Per-ATTEMPT ssh ceiling inside `pollBootId`. `driver.exec` hard-codes
 * DEFAULT_EXEC_TIMEOUT_MS (120 s) and the poll's loop condition is only
 * evaluated BETWEEN attempts, so without a per-attempt ceiling ONE hung ssh —
 * the routine `sudo reboot` case, where the TCP connection is established but
 * the peer never answers — runs straight past BOOT_BUDGET_MS/REBOOT_BUDGET_MS
 * to the bun file timeout, which is the ONE path that skips the `finally`
 * below and leaks a billing box plus an unrevoked key.
 */
const BOOT_PROBE_TIMEOUT_MS = 30_000;
/** systemd's own boot id — a UUID, and the only honest proof a reboot happened. */
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The directory `/etc/tmpfiles.d/qds-steering.conf` promises (AC6). ONE literal:
 * the stat, the negative control and the `rm` that arms it must not drift. */
const STEERING_DIR = "/run/steering";
/** The literal `/etc/tmpfiles.d/qds-steering.conf` promises (AC6). */
const STEERING_STAT_EXPECTED = "700 exedev exedev";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.todoIf(liveTodoOff())(
  "DF2.10 image contract: a real box boots the pinned factory image, proves its marker and pins, passes every setup gate, and re-creates /run/steering across a real reboot",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");

    // ── PRECONDITIONS: free, and BEFORE a cent is spent ───────────────────────
    // "No `--image` override is passed here on purpose" is a precondition, not
    // a result: it is checkable the moment `preflight` hands back the driver,
    // so a misconfigured run refuses before a box exists rather than after one
    // has been created and billed.
    expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF);
    expect(ctx.driver.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
    // The two above are constants-vs-constants while `preflight` builds the
    // driver with `new ExeDevDriver()` (live-harness.ts) — the constructor
    // reads no environment. THIS is the falsifiable half: production builds the
    // driver with `exeDevDriverFromEnv` (src/providers/index.ts), which DOES
    // read these two vars, so an operator who has one exported is running a
    // test whose box is the repo pin while their production boxes are not —
    // i.e. this file would be proving a different image than the one they ship.
    for (const name of ["QDS_EXEDEV_IMAGE", "QDS_EXEDEV_IMAGE_BUILD_ID"]) {
      expect(`${name}=${process.env[name] ?? ""}`).toBe(`${name}=`);
    }

    const runId = runIdFor("t1img");
    let vm = "";
    let store: RunRecordStore | undefined;
    let mintedHash = "";
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    /** A destroy that FAILED — surfaced after the `finally`, never only in evidence. */
    let destroyError = "";
    // AC7c/AC1a/AC1b are RECORDED, never asserted — the story's Technical Notes
    // forbid an invented ceiling ("size and cold-boot time are recorded, never
    // asserted against an invented ceiling"). They live outside the try so the
    // failure path writes whatever was measured before it died.
    const recorded: Record<string, unknown> = {
      pinnedImageRef: DEFAULT_IMAGE_REF,
      pinnedBuildId: DEFAULT_IMAGE_BUILD_ID,
      // AC1a vs AC1b: the story's open question, and this evidence file is
      // where it gets answered — which shape actually shipped.
      pinShape: DEFAULT_IMAGE_REF.includes("@sha256:") ? "digest" : "immutable-tag",
      createMs: 0,
      coldBootMs: 0,
      imageSizeBytes: 0,
      baseImageSizeBytes: 0,
    };
    try {
      // ── AC7c (size half): read off the build evidence, or record 0 ────────
      // Observability Contract: "a field never evaluated reports 0". An absent
      // build-evidence.json means this host never built the image; that is a
      // recorded 0, not a failure of the BOOTED box this test is about.
      if (existsSync(BUILD_EVIDENCE_PATH)) {
        const be = JSON.parse(readFileSync(BUILD_EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
        if (typeof be.imageSizeBytes === "number") recorded.imageSizeBytes = be.imageSizeBytes;
        if (typeof be.baseImageSizeBytes === "number") recorded.baseImageSizeBytes = be.baseImageSizeBytes;
        recorded.buildEvidenceBuildId = be.buildId ?? null;
        recorded.buildEvidencePinShape = be.pinShape ?? null;
      }
      evidence.push({ phase: "build-evidence", present: existsSync(BUILD_EVIDENCE_PATH), ...recorded });

      // ── create: the PRODUCTION default boots the factory image ────────────
      vm = runId;
      const tCreate = Date.now();
      const created = await ctx.driver.create(vm);
      recorded.createMs = Date.now() - tCreate;
      expect(created.name).toBe(vm);
      evidence.push({
        phase: "create",
        ok: true,
        vm,
        imageRef: ctx.driver.image,
        imageBuildId: ctx.driver.imageBuildId,
        createMs: recorded.createMs,
      });
      // (the repo-pin preconditions are asserted before `create()`, above)

      /**
       * Poll the box's boot id over real ssh until `accept` takes it.
       *
       * One probe, two uses: the cold-boot measurement (any well-formed id) and
       * the reboot proof (an id DIFFERENT from the one before `sudo reboot` —
       * an ssh that merely answers proves the connection came back, not that
       * the machine actually restarted).
       */
      const pollBootId = async (
        accept: (id: string) => boolean,
        budgetMs: number,
      ): Promise<{ bootId: string; waitedMs: number; attempts: number }> => {
        const started = Date.now();
        const left = (): number => budgetMs - (Date.now() - started);
        let last = "";
        let attempts = 0;
        while (left() > 0) {
          attempts += 1;
          try {
            // `execTimed`, NOT `exec`: the budget must bound an attempt IN
            // FLIGHT, not merely the gap between attempts (BOOT_PROBE_TIMEOUT_MS
            // above says why). Clamped to what is left so a probe can never
            // outlive the budget it is being polled under.
            const r = await ctx.driver.execTimed(vm, ["cat", BOOT_ID_PATH], Math.min(BOOT_PROBE_TIMEOUT_MS, left()));
            last = r.stdout.trim();
            if (r.exitCode === 0 && accept(last)) {
              return { bootId: last, waitedMs: Date.now() - started, attempts };
            }
          } catch (e) {
            // A dropped/refused/timed-out ssh during boot is expected, not an outcome.
            last = `exec threw: ${(e as Error).message.slice(0, 200)}`;
          }
          if (left() <= 0) break;
          await sleep(Math.min(POLL_INTERVAL_MS, left()));
        }
        throw new Error(
          `box ${vm} did not answer ssh with an accepted boot id within ${budgetMs} ms across ${attempts} attempt(s) (last seen: ${last || "nothing"})`,
        );
      };

      // ── AC7c (cold-boot half) ─────────────────────────────────────────────
      // Measured exactly as specified: wall time from `create()` RETURNING to
      // the first successful ssh. Honest caveat, recorded rather than hidden:
      // `create()` itself already provisions the steering channel over ssh
      // before it returns (driver.ts provisionSteeringChannel), so this figure
      // is the RESIDUAL to the next successful ssh — the pull-and-boot wall
      // time is inside `createMs`, recorded beside it. Both are recorded; the
      // ADR's falsifier is the pair, and neither is asserted.
      const boot = await pollBootId((id) => BOOT_ID_RE.test(id), BOOT_BUDGET_MS);
      recorded.coldBootMs = boot.waitedMs;
      const bootIdBefore = boot.bootId;
      evidence.push({ phase: "cold-boot", coldBootMs: boot.waitedMs, attempts: boot.attempts, createMs: recorded.createMs });

      // ── AC1: the boot contract survived the fork ──────────────────────────
      const pid1 = await ctx.driver.exec(vm, ["ps", "-p", "1", "-o", "comm="]);
      evidence.push({ phase: "pid1", exitCode: pid1.exitCode, comm: pid1.stdout.trim() });
      expect(pid1.exitCode).toBe(0);
      expect(pid1.stdout.trim()).toBe("systemd");

      // `systemctl is-system-running` EXITS NON-ZERO on "degraded", so the exit
      // status is not the instrument — the word is (INV-3).
      const sysState = await ctx.driver.exec(vm, ["systemctl", "is-system-running"]);
      const state = sysState.stdout.trim();
      // `degraded` is ACCEPTED and RECORDED, never failed: a stock exeuntu box
      // can be degraded for units this story neither ships nor touches, and
      // failing on it would be exactly the invented ceiling the Technical Notes
      // forbid. What it is NOT allowed to be is `maintenance`/`starting`/
      // `stopping`/`offline` — those are not `multi-user.target` reached.
      const failedUnits =
        state === "degraded"
          ? (await ctx.driver.exec(vm, ["systemctl", "--failed", "--no-legend", "--plain"])).stdout.trim().slice(0, 800)
          : "";
      evidence.push({ phase: "is-system-running", state, degraded: state === "degraded", failedUnits });
      expect(["running", "degraded"]).toContain(state);

      // ── AC1: ssh answers as the exe.dev/login-user ────────────────────────
      const who = await ctx.driver.exec(vm, ["whoami"]);
      evidence.push({ phase: "whoami-in-box", exitCode: who.exitCode, user: who.stdout.trim() });
      expect(who.exitCode).toBe(0);
      expect(who.stdout.trim()).toBe("exedev");

      // ── INV-IBOX-2: the box states what it booted ─────────────────────────
      const markerStat = await ctx.driver.exec(vm, ["stat", "-c", "%s", IMAGE_MARKER_PATH]);
      const markerBytes = Number(markerStat.stdout.trim());
      evidence.push({ phase: "marker-stat", exitCode: markerStat.exitCode, bytes: markerBytes, cap: IMAGE_MARKER_MAX_BYTES });
      expect(markerStat.exitCode).toBe(0); // present
      expect(Number.isFinite(markerBytes)).toBeTrue();
      // The cap is EXCLUSIVE and counted in BYTES at all three sites, and this
      // line is the third: the Dockerfile asserts `stat -c '%s' … -lt 4096`,
      // the gate refuses at `Buffer.byteLength(content) >= 4096`
      // (transport.ts), and `stat -c %s` here is the same byte count the
      // Dockerfile used. A marker of EXACTLY 4096 bytes is therefore refused by
      // the build, by the gate and by this assertion — one rule, three places.
      expect(markerBytes).toBeLessThan(IMAGE_MARKER_MAX_BYTES);

      const markerCat = await ctx.driver.exec(vm, ["cat", IMAGE_MARKER_PATH]);
      expect(markerCat.exitCode).toBe(0);
      // The PRODUCTION parser, not a hand-rolled one: it is the thing gate B
      // uses, it fails closed on every arm, and a test that parsed the marker
      // its own way would be proving its own parser.
      const marker = parseImageMarker(markerCat.stdout);
      evidence.push({ phase: "marker", ...marker });
      // NOTHING here re-asserts the marker's SHAPE. `parseImageMarker` returns
      // an object literal of exactly six keys and refuses any input whose six
      // fields are not non-empty strings (transport.ts), so "six keys" and
      // "all six non-empty" are true of every input it does not throw on —
      // unfalsifiable lines on the most expensive test in the repo. The parser's
      // own arms are proven in tests/providers/exedev/image-contract.test.ts;
      // what is asserted HERE is only what the BOX can be wrong about.
      // The pin pairing INV-IBOX-2 rests on: host enforced the digest at pull,
      // the box proves the build-generated id, and the two must agree.
      expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID);

      // ── AC2: the runtimes are the PINNED ones, proven in-box ──────────────
      const bunVer = await ctx.driver.exec(vm, ["bun", "--version"]);
      const piVer = await ctx.driver.exec(vm, ["pi", "--version"]);
      const bunObserved = bunVer.stdout.trim();
      // pi prints more than a bare number; take the semver, the way
      // assertions-in-box.sh's own version read does.
      // dp:ok not a silent blank: an empty value fails the non-empty assertion
      // below, which is the whole point of reading the version at all.
      const piObserved = /[0-9]+\.[0-9]+\.[0-9]+/.exec(piVer.stdout)?.[0] ?? ""; /* dp:ok empty fails the non-empty assertion below, which is the point of reading it */
      evidence.push({
        phase: "pins",
        bunObserved,
        bunPinned: marker.bunVersion,
        piObserved,
        piPinned: marker.piVersion,
        piRaw: piVer.stdout.trim().slice(0, 200),
      });
      expect(bunVer.exitCode).toBe(0);
      expect(piVer.exitCode).toBe(0);
      // The OBSERVED sides non-empty (the marker sides cannot be empty — the
      // parser refuses that, above): `piObserved` is a regex `?.[0] ?? ""` over
      // real output and genuinely can be `""`, and an empty in-box read equal
      // to an empty expectation would satisfy a bare toBe() while proving
      // nothing.
      expect(bunObserved.length).toBeGreaterThan(0);
      expect(piObserved.length).toBeGreaterThan(0);
      expect(bunObserved).toBe(marker.bunVersion);
      expect(piObserved).toBe(marker.piVersion);
      // ── AC2, the half the two lines above CANNOT prove ────────────────────
      // `bunObserved === marker.bunVersion` compares the box to the marker's
      // OWN claim, and the marker is tied to this repo only through `buildId`.
      // A build that ignored the `BUN_VERSION` build arg yields a perfectly
      // self-consistent box — right bun in the marker, same bun on disk — that
      // passes both lines while running a bun nobody pinned. This closes the
      // loop back to the single source: `readBunPin` is the production build
      // script's own reader (scripts/build-exedev-image.ts), not a second
      // parser, so the chain is package.json → build arg → image → THIS box.
      const repoBunPin = readBunPin(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
      evidence.push({ phase: "bun-pin-loop", repoBunPin, bunObserved, markerBunVersion: marker.bunVersion });
      expect(bunObserved).toBe(repoBunPin);

      // ── AC1: EVERY setup gate passes on this box (real gate, REAL SPEND) ──
      // A (git integrity) needs the pinned clone; C/D/E need the 0600 run key
      // at $HOME/app/.env — so the production prerequisites are driven with the
      // production primitives: fill → mint → deliver → setup.
      workspace = tmpWorkspace("t1img");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      store = new RunRecordStore({ dir: recordsDir });
      // `set()` MERGES INTO an existing record (setLocked → get → readRecord),
      // it does not create one — without the `create()` the first patch dies
      // `unreadable run record <runId>.json: ENOENT` and the gate never runs.
      // Same order every other live test uses (tier1-harvest.live.test.ts:53).
      store.create(runId);
      store.set(runId, { vmName: vm, commitSha: ctx.sha, requestId: ctx.driver.requestId });

      await ctx.driver.fill(vm, { runId, repoUrl: ctx.repoUrl, commitSha: ctx.sha, workdir: "src" });
      evidence.push({ phase: "fill", ok: true, commitSha: ctx.sha, workdir: "src" });

      const creds = { keyApi: openRouterKeyApi(), driver: ctx.driver, store, capMicroUsd: CAP_MICRO_USD };
      const minted = await mintRunKey(creds, runId);
      mintedHash = minted.hash; // the HASH is an identifier; the plaintext never leaves this scope
      evidence.push({ phase: "mint", keyHash: minted.hash, capMicroUsd: CAP_MICRO_USD });
      await deliverRunKey(creds, vm, minted.key);
      evidence.push({ phase: "deliver", ok: true });

      const gate = await ctx.driver.setup(vm, {
        runId,
        requestId: ctx.driver.requestId,
        rosterPath: ctx.rosterPath,
        commitSha: ctx.sha,
        workdir: "src",
      });
      evidence.push({
        phase: "setup-gate",
        ready: gate.ready,
        failedItem: gate.failedItem ?? null,
        assertionCode: gate.assertionCode ?? null,
        assertions: gate.assertions,
      });
      expect(gate.ready).toBe(true);
      // Every item A–E EXECUTED and passed — the gate stops at the first
      // failure, so "all ok" without "all five present" is a green on a gate
      // that never reached C/D/E.
      expect(gate.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
      expect(gate.assertions.every((a) => a.ok)).toBe(true);

      // ── AC6: the reboot proof — the load-bearing one ──────────────────────
      // /run is a tmpfs, so the directory CANNOT survive the reboot; whatever
      // is there afterwards was recreated. Recorded so the claim is not taken
      // on faith.
      const runFsBefore = await ctx.driver.exec(vm, ["stat", "-f", "-c", "%T", "/run"]);
      const steeringBefore = await ctx.driver.exec(vm, ["stat", "-c", "%a %U %G", STEERING_DIR]);
      evidence.push({
        phase: "pre-reboot",
        runFsType: runFsBefore.stdout.trim(),
        steeringStat: steeringBefore.stdout.trim(),
        bootIdBefore,
      });
      expect(runFsBefore.stdout.trim()).toBe("tmpfs");

      // NOTHING between here and the post-reboot stat provisions anything:
      // no `create()`, no `provisionSteeringChannel`, no driver method that
      // writes to /run — only `exec` probes. That is the entire point of this
      // block: the baked /etc/tmpfiles.d/qds-steering.conf must fire on its
      // own, from systemd-tmpfiles-setup.service, with no code path of ours
      // having run.
      let rebootExit: number | string;
      let rebootStderr = "";
      try {
        const r = await ctx.driver.exec(vm, ["sudo", "-n", "reboot"]);
        rebootExit = r.exitCode; // the box usually kills the connection first
        rebootStderr = r.stderr.trim().slice(0, 200);
      } catch (e) {
        rebootExit = `exec threw (expected — the connection dies with the box): ${(e as Error).message.slice(0, 200)}`;
      }
      evidence.push({ phase: "reboot-issued", rebootExit, rebootStderr });
      // CHECKED, not merely recorded. If the image ships without passwordless
      // sudo for `exedev`, `sudo -n reboot` exits 1 with "a password is
      // required", the reboot is never issued, and the poll below then burns
      // REBOOT_BUDGET_MS of PAID box time to report "the box did not answer ssh
      // with an accepted boot id" — the opposite diagnosis, four minutes late.
      // The dying connection is the expected shape and is not a failure: ssh
      // exits 255 for a connection that died mid-flight and 137 for the local
      // SIGKILL teardown (the pair transport.ts names), a `reboot` that returns
      // before the kill exits 0, and a thrown exec is the same event.
      if (typeof rebootExit === "number" && ![0, 137, 255].includes(rebootExit)) {
        throw new Error(
          `sudo -n reboot on ${vm} exited ${rebootExit} WITHOUT dropping the connection — the reboot was never issued, so AC6 was never exercised (stderr: ${rebootStderr || "empty"})`,
        );
      }

      // Wait for a DIFFERENT boot id: an ssh that answers proves the transport
      // came back, a changed boot id proves the kernel actually restarted.
      const rebooted = await pollBootId((id) => BOOT_ID_RE.test(id) && id !== bootIdBefore, REBOOT_BUDGET_MS);
      evidence.push({
        phase: "rebooted",
        bootIdBefore,
        bootIdAfter: rebooted.bootId,
        waitedMs: rebooted.waitedMs,
        attempts: rebooted.attempts,
      });
      expect(rebooted.bootId).not.toBe(bootIdBefore);

      const runFsAfter = await ctx.driver.exec(vm, ["stat", "-f", "-c", "%T", "/run"]);
      const steeringAfter = await ctx.driver.exec(vm, ["stat", "-c", "%a %U %G", STEERING_DIR]);
      evidence.push({
        phase: "post-reboot-steering",
        exitCode: steeringAfter.exitCode,
        // The EXACT stat output, verbatim — this line is the AC6 evidence.
        statOutput: steeringAfter.stdout.trim(),
        expected: STEERING_STAT_EXPECTED,
        runFsType: runFsAfter.stdout.trim(),
        provisionedByCode: false,
        note: "recreated by the baked /etc/tmpfiles.d/qds-steering.conf alone — no driver provisioning ran after the reboot",
      });
      expect(runFsAfter.stdout.trim()).toBe("tmpfs"); // it genuinely did not survive
      expect(steeringAfter.exitCode).toBe(0);
      expect(steeringAfter.stdout.trim()).toBe(STEERING_STAT_EXPECTED);

      // ── AC6's NEGATIVE CONTROL: prove `exec` provisions nothing ───────────
      // Everything above rests on one assumption that was, until here, asserted
      // only in a comment: that no driver call between the reboot and the stat
      // recreates the directory. `pollBootId` runs `exec` repeatedly in exactly
      // that window, and the driver ALREADY provisions the steering channel in
      // `create()` — so if `exec` ever acquired lazy per-connection
      // provisioning, this test would report `/etc/tmpfiles.d` working while
      // the driver had quietly done the work, and nothing would notice.
      //
      // So falsify it directly, on a box that is about to be destroyed anyway:
      // delete the directory tmpfiles made, run one more `exec`, and require it
      // to STAY gone. It comes back ⇒ some code path of ours provisions it ⇒
      // every AC6 assertion above proved the driver, not the image.
      const steeringRm = await ctx.driver.exec(vm, ["sudo", "-n", "rm", "-rf", STEERING_DIR]);
      const afterExec = await ctx.driver.exec(vm, ["cat", BOOT_ID_PATH]);
      const steeringResurrected = await ctx.driver.exec(vm, ["stat", "-c", "%a %U %G", STEERING_DIR]);
      evidence.push({
        phase: "ac6-negative-control",
        rmExit: steeringRm.exitCode,
        rmStderr: steeringRm.stderr.trim().slice(0, 200),
        probeExit: afterExec.exitCode,
        statExitAfterProbe: steeringResurrected.exitCode,
        statOutput: steeringResurrected.stdout.trim(),
        note: "the directory must stay gone: a driver exec that re-provisioned it would have invalidated the AC6 proof above",
      });
      // An `rm` that did not run leaves the control INCONCLUSIVE, which must
      // not read as a pass — the same reason the reboot exit is checked.
      expect(steeringRm.exitCode).toBe(0);
      expect(afterExec.exitCode).toBe(0); // the probe genuinely reached the box
      expect(steeringResurrected.exitCode).not.toBe(0);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // A minted key outliving the run is a live spend surface; a leaked box
      // bills forever. Both are cleaned up unconditionally, EVERY step is
      // individually guarded so no cleanup failure can skip a later cleanup or
      // replace the test's own result, and the box goes FIRST: it is the
      // expensive leak (it bills until destroyed) while the key is capped at
      // CAP_MICRO_USD. Revoking after the destroy is safe — `revokeRunKey`
      // talks to the provider only and never touches the box.
      if (vm !== "") {
        try {
          await ctx.driver.destroy(vm);
          evidence.push({ phase: "finally-destroy", vm, ok: true });
        } catch (e) {
          // Recorded in a VARIABLE, not only in `evidence` — nothing reads that
          // array, so the harness's `destroyQuietly` (which can only record)
          // ships a GREEN test on the one outcome this file must never report
          // green and silent: a real box still running, discovered by the bill
          // instead of by the suite. The assertion after this block turns it
          // red; the stderr line reaches an operator who is watching the run.
          destroyError = (e as Error).message;
          process.stderr.write(`[DF2.10] DESTROY FAILED for ${vm}: ${destroyError} — remediation: ssh exe.dev rm ${vm}\n`);
          evidence.push({ phase: "finally-destroy", vm, ok: false, error: destroyError });
        }
      }
      // Gated on the STORE ALONE, never on `mintedHash`: `mintRunKey` persists
      // `keyHash` into the run record BEFORE it can still throw (the
      // malformed-hash and uncapped-key refusals in credentials.ts both fire
      // after that `store.set`), so a live spendable key can exist and be
      // recorded while `mintedHash` is still `""`. `revokeQuietly` already
      // no-ops when the record carries no keyHash, so the `mintedHash` half of
      // the old guard bought nothing and cost a live credential.
      if (store !== undefined) {
        try {
          await revokeQuietly(ctx.driver, store, runId, evidence);
        } catch (e) {
          // `revokeQuietly` reads the run record OUTSIDE its own try
          // (live-harness.ts:484 — `const rec = store.get(runId)` sits before
          // the `try`), so a missing, unreadable or partially-written record
          // throws straight out of this `finally`, killing the evidence write
          // and the workspace cleanup and replacing the test's real error with
          // a record-read one, on the run that most needs the forensic trail.
          // Same guard both sibling live tests carry.
          evidence.push({ phase: "finally-revoke", ok: false, error: (e as Error).message });
        }
      }
      try {
        evidencePath = writeEvidence("t1-image-contract", {
          test: "DF2.10-image-contract",
          tier: 2,
          outcome,
          runId,
          vm: vm || undefined,
          keyHash: mintedHash || undefined,
          capMicroUsd: CAP_MICRO_USD,
          // AC7c + AC1a/AC1b: recorded, never asserted.
          recorded,
          phases: evidence,
        });
        process.stderr.write(`[DF2.10] evidence: ${evidencePath}\n`);
      } catch (e) {
        // An unwritable evidence dir, a full disk, or a phase object that will
        // not serialize must NOT replace the in-flight throw from the `catch`
        // above — the file's own promise is that cleanup "may not mask the
        // test's own result", and an uncaught write here made that false: the
        // operator would read an I/O error where an AC6 regression was, and pay
        // for another ~25-minute run to rediagnose it.
        process.stderr.write(`[DF2.10] evidence write failed: ${(e as Error).message}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }

    // The box verdict is this run's LAST claim, and it is made OUTSIDE the
    // try/finally on purpose: this line is reached only when the body itself
    // passed, so a failed destroy cannot mask a real failure — it can only
    // stop a run that leaked a live box from being reported as green.
    expect(destroyError).toBe("");
  },
  // Budget audit (T5.1's EB6 shape). The 600 s this replaces was BELOW the sum
  // of the legs' OWN declared ceilings — create (~60 s measured) + BOOT_BUDGET_MS
  // 120 + probes ~30 + fill ~120 + mint/deliver ~20 + the gate's own
  // DEFAULT_GATE_TIMEOUT_MS 300 + REBOOT_BUDGET_MS 240 + post-reboot probes and
  // the AC6 negative control ~20 ≈ 910 s, plus ~90 s for the finally's
  // destroy/revoke/evidence write. It was survivable only while the gate leg
  // never ran. A bun test-timeout abort is the ONE path where that finally does
  // not execute, i.e. the path that leaks a billing box — so the ceiling is
  // raised to fit the legs, and no leg budget, assertion or ordering is touched.
  //
  // The two poll legs now honour the budgets named above: `pollBootId` used
  // `driver.exec`, whose ceiling is the driver's own `execTimeoutMs` (120 s),
  // and evaluated its budget only BETWEEN attempts — so a hung ssh could
  // overshoot BOOT_BUDGET_MS/REBOOT_BUDGET_MS by up to one 120 s attempt each,
  // making this arithmetic 240 s optimistic. `execTimed` at the remaining
  // budget closes that gap; the ceiling is unchanged and now has real slack.
  1_500_000,
);
