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
 *   AC2   in-box `bun --version` / `pi --version` == the marker's pinned pair
 *   IBOX-2 `/etc/qds-image.json` present, under the 4 KiB cap, six keys non-empty,
 *         and its `buildId` == the repo pin (DEFAULT_IMAGE_BUILD_ID)
 *   AC1   every setup-gate assertion A–E passes on THIS box (real gate, real driver)
 *   AC6   after a real `sudo reboot`, /run/steering returns at 0700 exedev:exedev
 *         with NO code path having run — the baked /etc/tmpfiles.d entry alone
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
 * real setup gate. The box is destroyed and the key revoked in `finally`.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  destroyQuietly,
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
/** systemd's own boot id — a UUID, and the only honest proof a reboot happened. */
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The literal `/etc/tmpfiles.d/qds-steering.conf` promises (AC6). */
const STEERING_STAT_EXPECTED = "700 exedev exedev";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.todoIf(liveTodoOff())(
  "DF2.10 image contract: a real box boots the pinned factory image, proves its marker and pins, passes every setup gate, and re-creates /run/steering across a real reboot",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const runId = runIdFor("t1img");
    let vm = "";
    let store: RunRecordStore | undefined;
    let mintedHash = "";
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
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
      // The driver was constructed with NO image option, so this IS the repo pin.
      expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF);
      expect(ctx.driver.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);

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
        let last = "";
        let attempts = 0;
        while (Date.now() - started < budgetMs) {
          attempts += 1;
          try {
            const r = await ctx.driver.exec(vm, ["cat", BOOT_ID_PATH]);
            last = r.stdout.trim();
            if (r.exitCode === 0 && accept(last)) {
              return { bootId: last, waitedMs: Date.now() - started, attempts };
            }
          } catch (e) {
            // A dropped/refused ssh during boot is expected, not an outcome.
            last = `exec threw: ${(e as Error).message.slice(0, 200)}`;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(
          `box ${vm} did not answer ssh with an accepted boot id within ${budgetMs} ms (last seen: ${last || "nothing"})`,
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
      expect(markerBytes).toBeLessThan(IMAGE_MARKER_MAX_BYTES);

      const markerCat = await ctx.driver.exec(vm, ["cat", IMAGE_MARKER_PATH]);
      expect(markerCat.exitCode).toBe(0);
      // The PRODUCTION parser, not a hand-rolled one: it is the thing gate B
      // uses, it fails closed on every arm, and a test that parsed the marker
      // its own way would be proving its own parser.
      const marker = parseImageMarker(markerCat.stdout);
      evidence.push({ phase: "marker", ...marker });
      // All six keys non-empty. Asserted on `<key>=<value>` so a failure NAMES
      // the empty key instead of reporting an anonymous `0 > 0`.
      for (const [key, value] of Object.entries(marker)) {
        expect(`${key}=${value}`).not.toBe(`${key}=`);
      }
      expect(Object.keys(marker).length).toBe(6);
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
      // BOTH sides non-empty: an empty marker field equal to an empty in-box
      // read would satisfy a bare toBe() while proving nothing.
      expect(marker.bunVersion.length).toBeGreaterThan(0);
      expect(marker.piVersion.length).toBeGreaterThan(0);
      expect(bunObserved.length).toBeGreaterThan(0);
      expect(piObserved.length).toBeGreaterThan(0);
      expect(bunObserved).toBe(marker.bunVersion);
      expect(piObserved).toBe(marker.piVersion);

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
      const steeringBefore = await ctx.driver.exec(vm, ["stat", "-c", "%a %U %G", "/run/steering"]);
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
      try {
        const r = await ctx.driver.exec(vm, ["sudo", "-n", "reboot"]);
        rebootExit = r.exitCode; // the box usually kills the connection first
      } catch (e) {
        rebootExit = `exec threw (expected — the connection dies with the box): ${(e as Error).message.slice(0, 200)}`;
      }
      evidence.push({ phase: "reboot-issued", rebootExit });

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
      const steeringAfter = await ctx.driver.exec(vm, ["stat", "-c", "%a %U %G", "/run/steering"]);
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
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // A minted key outliving the run is a live spend surface; a leaked box
      // bills forever. Both are cleaned up unconditionally, and neither may
      // mask the test's own result.
      if (store !== undefined && mintedHash !== "") {
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      if (vm !== "") {
        await destroyQuietly(ctx.driver, vm, evidence);
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
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  // Budget audit (T5.1's EB6 shape). The 600 s this replaces was BELOW the sum
  // of the legs' OWN declared ceilings — create (~60 s measured) + BOOT_BUDGET_MS
  // 120 + probes ~30 + fill ~120 + mint/deliver ~20 + the gate's own
  // DEFAULT_GATE_TIMEOUT_MS 300 + REBOOT_BUDGET_MS 240 + post-reboot probes ~10
  // ≈ 900 s, plus ~90 s for the finally's revoke/destroy/evidence write. It was
  // survivable only while the gate leg never ran. A bun test-timeout abort is
  // the ONE path where that finally does not execute, i.e. the path that leaks
  // a billing box — so the ceiling is raised to fit the legs, and no leg budget,
  // assertion or ordering is touched.
  1_500_000,
);
