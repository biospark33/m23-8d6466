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
 * ── SPEND WARNING — THIS IS A TIER-2 TEST ───────────────────────────────────
 * Setup-gate assertions C, D and E are REAL OpenRouter chat/completions calls
 * from inside the box (`assertions-in-box.sh`), so proving "every setup gate
 * passes" costs real money — a few cents at most, hard-capped by a freshly
 * minted run key at CAP_MICRO_USD. The skill's tier table defines TIER-1 as
 * "boxes only, 0 model spend", so this test gates at **TIER-2**:
 * `liveGate("2")` + `preflight("2")`, i.e. it refuses to run unless the
 * operator has set QDS_E2E_TIER=2 and approved spend out of band. Worst case
 * per run: 1 key × CAP_MICRO_USD + one box for < 10 min.
 *
 * The FILE NAME now matches the gate. It used to read `tier1-` while gating at
 * "2", and `liveTodoOff()` keys only on QDS_E2E_LIVE — so under the natural
 * invocation `QDS_E2E_LIVE=1 QDS_E2E_TIER=1 bun test tests/fleet/e2e/tier1-*`
 * this test RAN and `liveGate` threw `QDS_E2E_TIER is "1", not "2"`: a paid
 * round ending in a red that is not a substrate failure, in a suite whose whole
 * discipline is that a red means something real. The EVIDENCE ARTIFACT NAME is
 * deliberately unchanged (`writeEvidence("t1-image-contract", …)`) so every
 * historical evidence file stays joinable with this test's new rounds.
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
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  revokeQuietly,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
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
/**
 * Per-probe ceiling for the STRAIGHT-LINE in-box reads (`stat`, `cat`, `ps`,
 * `whoami`, `bun --version`, …). `driver.exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS
 * (120 s, transport.ts), and there are SIXTEEN of those calls here — 1 920 s of
 * declared ceiling on probes whose real latency is sub-second, against a file
 * budget of 1 500 s. The in-file audit at the bottom used to price the whole set
 * at "~30 s" combined, i.e. at typical latency rather than at its ceiling, so a
 * degraded-network round where probes are slow but not hung (60–90 s each)
 * overran the file budget — and a bun test-timeout abort is the ONE path where
 * the `finally` below does not execute, which is the path that leaks a billing
 * box AND leaves the minted key unrevoked. Bounding the probes is the fail-safe
 * half of the fix (it keeps that window short); the budget below is raised to
 * cover what remains.
 */
const BOX_PROBE_TIMEOUT_MS = 30_000;
/** systemd's own boot id — a UUID, and the only honest proof a reboot happened. */
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The directory `/etc/tmpfiles.d/qds-steering.conf` promises (AC6). ONE literal:
 * the stat, the negative control and the `rm` that arms it must not drift. */
const STEERING_DIR = "/run/steering"; // live-mirror: steeringRoot() (attach.ts); asserted by qds-run@.service AssertPathIsDirectory (#220)
/** The literal `/etc/tmpfiles.d/qds-steering.conf` promises (AC6). */
const STEERING_STAT_EXPECTED = "700 exedev exedev";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.todoIf(liveTodoOff())(
  "DF2.10 image contract: a real box boots the pinned factory image, proves its marker and pins, passes every setup gate, and re-creates /run/steering across a real reboot", // live-mirror: /run/steering = steeringRoot() (attach.ts) — DF2.10 reboot recreation
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");

    // ── PRECONDITIONS: free, and BEFORE a cent is spent ───────────────────────
    // "No `--image` override is passed here on purpose" is a precondition, not
    // a result: it is checkable the moment `preflight` hands back the driver,
    // so a misconfigured run refuses before a box exists rather than after one
    // has been created and billed.
    // The env loop runs FIRST — before the ref assertions — so ANY exported
    // override fails with a line NAMING THE VARIABLE instead of an anonymous
    // ref diff (with the old order, an override whose value differed from the
    // pin died on the ref assertion below and this diagnostic never fired).
    // An override exported at EXACTLY the repo-pin values is refused too: it
    // proves only that the operator copied the pin, and the env read happens
    // once in `preflight`. QDS_EXEDEV_REGISTRY_AUTH_FILE joins the list for
    // the same reason: the factory-built driver would load and USE the
    // credential, and this test's claim is "the PUBLIC repo pin boots" — an
    // authenticated pull proves a different thing (that is AC4's own live
    // leg, not this one).
    for (const name of ["QDS_EXEDEV_IMAGE", "QDS_EXEDEV_IMAGE_BUILD_ID", "QDS_EXEDEV_REGISTRY_AUTH_FILE"]) {
      expect(`${name}=${process.env[name] ?? ""}`).toBe(`${name}=`);
    }
    // There is deliberately NO `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)`
    // here. It used to sit on this line under a comment claiming it was
    // "GENUINELY falsifiable since #189 … guarding non-env drift too", and that
    // claim was false: `preflight` builds the driver as `exeDevDriverFromEnv()`
    // with NO opts, that factory derives image/buildId solely from the two
    // variables the loop above has just asserted EMPTY, and the constructor
    // then falls back to `opts.image ?? DEFAULT_IMAGE_REF` /
    // `opts.imageBuildId ?? DEFAULT_IMAGE_BUILD_ID` (driver.ts) — the very
    // constants the assertion compared against. Constant-vs-constant cannot
    // fail, and an unfalsifiable line wearing a "genuinely falsifiable" comment
    // is worse than no line: it is read as coverage that does not exist.
    // The falsifiable half is real and lives below —
    // `expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID)`, which only the
    // BOOTED box can satisfy — and `create`'s evidence entry records
    // `ctx.driver.image` verbatim, so the ref this round actually bought is
    // still on the record.

    const runId = runIdFor("t1img");
    let vm = "";
    let store: RunRecordStore | undefined;
    let mintedHash = "";
    let workspace = "";
    let outcome = "pass";
    /** A destroy that FAILED — surfaced after the `finally`, never only in evidence. */
    let destroyError = "";
    /** Cleanup problems raised by the cleanup primitives themselves (the evidence write). */
    const cleanupProblems: string[] = [];
    /** The body's own error, HELD so the cleanup verdicts below the finally run on the red path too. */
    let failure: unknown;
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    /** The F17 key verdict, rendered in the `finally` and settled below it. */
    let keyProblems: string[] = [];
    // The key population BEFORE this run. Snapshotted HERE — after the free
    // precondition checks and before a cent is spent — so a D6 truncation
    // refusal costs no box, and so the delta's baseline predates the mint.
    const hashesBefore = await listedKeyHashes();
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
      /**
       * Every straight-line in-box read below goes through here, never through
       * `ctx.driver.exec`: `execTimed` is the only form that bounds an ssh IN
       * FLIGHT (BOX_PROBE_TIMEOUT_MS above says why the 120 s default is not a
       * budget this file can afford sixteen times over).
       */
      const probe = (argv: string[]) => ctx.driver.execTimed(vm, argv, BOX_PROBE_TIMEOUT_MS);
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
            // outlive the budget it is being polled under — and FLOORED at 1 ms,
            // because wall time elapses between the `left() > 0` check and this
            // call, so the clamp can compute 0 or a negative number at the
            // budget boundary, and a non-positive value must never read as
            // "no timeout". (Verified: execTimed → sshCommand already clamps
            // `Math.max(1, timeoutMs)` at Bun.spawn, transport.ts — the floor
            // here keeps this file's ceiling honest without leaning on that.)
            const r = await ctx.driver.execTimed(vm, ["cat", BOOT_ID_PATH], Math.max(1, Math.min(BOOT_PROBE_TIMEOUT_MS, left())));
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
      const pid1 = await probe(["ps", "-p", "1", "-o", "comm="]);
      evidence.push({ phase: "pid1", exitCode: pid1.exitCode, comm: pid1.stdout.trim() });
      expect(pid1.exitCode).toBe(0);
      expect(pid1.stdout.trim()).toBe("systemd");

      // `systemctl is-system-running` EXITS NON-ZERO on "degraded", so the exit
      // status is not the instrument — the word is (INV-3).
      const sysState = await probe(["systemctl", "is-system-running"]);
      const state = sysState.stdout.trim();
      // `degraded` is ACCEPTED and RECORDED, never failed: a stock exeuntu box
      // can be degraded for units this story neither ships nor touches, and
      // failing on it would be exactly the invented ceiling the Technical Notes
      // forbid. What it is NOT allowed to be is `maintenance`/`starting`/
      // `stopping`/`offline` — those are not `multi-user.target` reached.
      const failedUnits =
        state === "degraded"
          ? (await probe(["systemctl", "--failed", "--no-legend", "--plain"])).stdout.trim().slice(0, 800)
          : "";
      evidence.push({ phase: "is-system-running", state, degraded: state === "degraded", failedUnits });
      expect(["running", "degraded"]).toContain(state);

      // ── AC1: ssh answers as the exe.dev/login-user ────────────────────────
      const who = await probe(["whoami"]);
      evidence.push({ phase: "whoami-in-box", exitCode: who.exitCode, user: who.stdout.trim() });
      expect(who.exitCode).toBe(0);
      expect(who.stdout.trim()).toBe("exedev");

      // ── INV-IBOX-2: the box states what it booted ─────────────────────────
      const markerStat = await probe(["stat", "-c", "%s", IMAGE_MARKER_PATH]);
      const markerBytes = Number(markerStat.stdout.trim());
      evidence.push({ phase: "marker-stat", exitCode: markerStat.exitCode, bytes: markerBytes, cap: IMAGE_MARKER_MAX_BYTES });
      expect(markerStat.exitCode).toBe(0); // present
      // The DIGITS first, then the number: `Number("")` is 0 — finite, and less
      // than the 4 KiB cap — so a `stat` that exits 0 with empty stdout (a
      // truncated ssh read, a busybox stat that printed nothing) sailed through
      // both numeric lines below and was only caught incidentally, later, when
      // `parseImageMarker` refused the empty body.
      expect(markerStat.stdout.trim()).toMatch(/^\d+$/);
      expect(Number.isFinite(markerBytes)).toBeTrue();
      // The cap is EXCLUSIVE and counted in BYTES at all three sites, and this
      // line is the third: the Dockerfile asserts `stat -c '%s' … -lt 4096`,
      // the gate refuses at `Buffer.byteLength(content) >= 4096`
      // (transport.ts), and `stat -c %s` here is the same byte count the
      // Dockerfile used. A marker of EXACTLY 4096 bytes is therefore refused by
      // the build, by the gate and by this assertion — one rule, three places.
      expect(markerBytes).toBeLessThan(IMAGE_MARKER_MAX_BYTES);

      const markerCat = await probe(["cat", IMAGE_MARKER_PATH]);
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
      const bunVer = await probe(["bun", "--version"]);
      const piVer = await probe(["pi", "--version"]);
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
      // `set()` MERGES INTO an existing record (setLocked → get → readRecord),
      // it does not create one — without the `create()` the first patch dies
      // `unreadable run record <runId>.json: ENOENT` and the gate never runs.
      // Same order every other live test uses (tier1-harvest.live.test.ts:53).
      //
      // Published to `store` only AFTER `create()` succeeds: the `finally`
      // gates the revoke on `store !== undefined`, so a `create` that threw
      // (EPERM on the runs dir, a filesystem without O_EXCL link semantics)
      // used to leave a defined store with NO record, `revokeQuietly`'s
      // `store.get` then died ENOENT, and the run was reported with a
      // `finally-revoke ok:false` — a phantom key leak on a run that provably
      // minted nothing. An undefined store is the truthful state there: no
      // record exists, so no key can be attributed, and the account-wide
      // key-hash delta below is still the backstop.
      const opened = new RunRecordStore({ dir: recordsDir });
      opened.create(runId);
      store = opened;
      store.set(runId, { vmName: vm, commitSha: ctx.sha, requestId: ctx.driver.requestId });

      await ctx.driver.fill(vm, { runId, repoUrl: ctx.repoUrl, commitSha: ctx.sha, workdir: "src" });
      evidence.push({ phase: "fill", ok: true, commitSha: ctx.sha, workdir: "src" });

      const creds = { keyApi: openRouterKeyApi(), driver: ctx.driver, store, capMicroUsd: CAP_MICRO_USD, recordAuditLink: () => {} };
      const minted = await mintRunKey(creds, runId);
      mintedHash = minted.hash; // the HASH is an identifier; the plaintext never leaves this scope
      evidence.push({ phase: "mint", keyHash: minted.hash, capMicroUsd: CAP_MICRO_USD });
      await deliverRunKey(creds, runId, vm, minted.key);
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
      const runFsBefore = await probe(["stat", "-f", "-c", "%T", "/run"]);
      const steeringBefore = await probe(["stat", "-c", "%a %U %G", STEERING_DIR]);
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
        const r = await probe(["sudo", "-n", "reboot"]);
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
      // before the kill exits 0, and a thrown exec is the same event. 137 is
      // ACCEPTED-BUT-UNPROVEN: a local SIGKILL can land before the remote
      // `reboot` ever ran, so it does not prove the reboot was issued — only 1
      // ("a password is required") proves it was NOT. That is acceptable
      // because issuance is not the proof anyway: the poll below requires a
      // CHANGED boot id, so a 137 whose reboot never happened fails the poll
      // with the old id in `last seen` — the budget burn is the known cost of
      // not being able to distinguish the two 137s from this side.
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

      const runFsAfter = await probe(["stat", "-f", "-c", "%T", "/run"]);
      const steeringAfter = await probe(["stat", "-c", "%a %U %G", STEERING_DIR]);
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
      const steeringRm = await probe(["sudo", "-n", "rm", "-rf", STEERING_DIR]);
      const afterExec = await probe(["cat", BOOT_ID_PATH]);
      const steeringResurrected = await probe(["stat", "-c", "%a %U %G", STEERING_DIR]);
      evidence.push({
        phase: "ac6-negative-control",
        rmExit: steeringRm.exitCode,
        rmStderr: steeringRm.stderr.trim().slice(0, 200),
        probeExit: afterExec.exitCode,
        statExitAfterProbe: steeringResurrected.exitCode,
        statStderr: steeringResurrected.stderr.trim().slice(0, 200),
        statOutput: steeringResurrected.stdout.trim(),
        note: "the directory must stay gone: a driver exec that re-provisioned it would have invalidated the AC6 proof above",
      });
      // An `rm` that did not run leaves the control INCONCLUSIVE, which must
      // not read as a pass — the same reason the reboot exit is checked.
      expect(steeringRm.exitCode).toBe(0);
      expect(afterExec.exitCode).toBe(0); // the probe genuinely reached the box
      // EXACTLY 1 — stat's clean ENOENT miss (the convention every other stat
      // in this file relies on by expecting 0 on presence). `.not.toBe(0)`
      // also accepted 255, the connection-death code this file itself
      // documents — so a resurrected directory plus one dropped ssh (the
      // post-reboot box is the flakiest window here) certified "exec
      // provisions nothing" on the run where exec provisioned something.
      // A transport death is INCONCLUSIVE, and inconclusive ≠ pass; its
      // stderr is in the evidence entry above.
      expect(steeringResurrected.exitCode).toBe(1);
    } catch (e) {
      outcome = "fail";
      // HELD, not re-thrown (the harness's `settleRun` shape). A `throw` here
      // made every cleanup verdict below the `finally` unreachable on exactly
      // the runs that need them most: on a red run the destroy verdict and the
      // revoke verdict were never read, so a box still billing and an unrevoked
      // key rode out inside a test failure about something else. `settleRun`
      // re-throws THIS error last, with any cleanup problem attached to it
      // rather than thrown over the top of it.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // A minted key outliving the run is a live spend surface; a leaked box
      // bills forever. Both are cleaned up unconditionally, EVERY step is
      // individually guarded so no cleanup failure can skip a later cleanup or
      // replace the test's own result, and the box goes FIRST: it is the
      // expensive leak (it bills until destroyed) while the key is capped at
      // CAP_MICRO_USD. Revoking after the destroy is safe — `revokeRunKey`
      // talks to the provider only and never touches the box.
      if (vm !== "") {
        // The harness's `destroyQuietly` now RETURNS its verdict (#189), so the
        // failure lands in a variable — not only in `evidence`, which nothing
        // reads during the run — and the assertion after this block turns a
        // leaked billing box red instead of green-and-silent. The stderr
        // remediation line is the harness's own.
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyError = destroyed.error;
      }
      // Gated on the STORE ALONE, never on `mintedHash`: `mintRunKey` persists
      // `keyHash` into the run record BEFORE it can still throw (the
      // malformed-hash and uncapped-key refusals in credentials.ts both fire
      // after that `store.set`), so a live spendable key can exist and be
      // recorded while `mintedHash` is still `""`. `revokeQuietly` already
      // no-ops when the record carries no keyHash, so the `mintedHash` half of
      // the old guard bought nothing and cost a live credential.
      if (store !== undefined) {
        // `revokeQuietly` never throws (#189) — an unreadable or half-written
        // record lands as a `finally-revoke ok:false` evidence entry instead of
        // escaping this `finally` and killing the evidence write below.
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      // `hashesBefore` is ACCOUNT-WIDE, so a key minted between the two
      // listings by a CONCURRENT round (a second operator, a parallel tier)
      // lands in this run's delta and is reported as this run's leak — a false
      // red on a clean paid round, and the fallback revoke never clears it
      // because it only revokes THIS run's runIds. So: attribute first. Only
      // the hash this run minted and the hash its record names are provably
      // ours; everything else in the delta is folded into the baseline and
      // RECORDED as a warning — the same report-wide/act-narrow split
      // `fleetLeftovers` applies to stray boxes.
      //
      // Stated cost of that split: a key this run minted whose hash reached
      // neither `mintedHash` nor the record would now warn instead of failing.
      // `mintRunKey` assigns `mintedHash` on return and persists `keyHash` into
      // the record BEFORE its own later refusals can throw (credentials.ts), so
      // the uncovered window is a provider mint whose response never came back.
      let keyBaseline: ReadonlySet<string> = hashesBefore;
      try {
        const ours = new Set<string>();
        if (mintedHash !== "") ours.add(mintedHash);
        try {
          const recorded = store?.get(runId).keyHash;
          if (recorded !== undefined && recorded !== "") ours.add(recorded);
        } catch {
          // unreadable/absent record — its hash stays unattributed, i.e. a warning
        }
        const foreign = [...(await listedKeyHashes())].filter((h) => !hashesBefore.has(h) && !ours.has(h));
        if (foreign.length > 0) {
          evidence.push({
            phase: "key-hash-delta-foreign",
            foreign,
            note: "in the account delta but NOT attributable to this run — WARNING only, does not fail this run",
          });
          keyBaseline = new Set([...hashesBefore, ...foreign]);
        }
      } catch (e) {
        // The attribution listing failed; fall back to the account-wide
        // baseline, which is the fail-CLOSED direction (it can only report
        // more, never less).
        evidence.push({ phase: "key-hash-delta-foreign", ok: false, error: (e as Error).message });
      }
      // The F17 verdict, AFTER the revoke above so it reports what genuinely
      // survived it. `revokeQuietly` answering "already-gone" proves the record
      // named no live key; it proves nothing about the ACCOUNT. Only this diff
      // does — and it revokes any survivor before naming it.
      keyProblems = await keyLeakProblems(
        keyBaseline,
        { driver: ctx.driver, store, runIds: [runId] },
        evidence,
      );
      // The absolute `e2e-|qds-` backstop at cleanup time: `destroyQuietly`
      // above only speaks for the box named in `vm`, and a `create` that stood
      // a box up and then threw leaves `vm === ""` — `runId` is the name
      // `create` was called with either way, so it is what this run OWNS.
      //
      // `fleetLeftovers`, not the single-shot listing this used to be: exe.dev's
      // destroy lag was measured at 25 s+ (`rm` exits 0 while the box stays
      // listed), so one-shot turned a clean cleanup into a failed paid round.
      // The helper polls, destroys what this run owns before reporting it, and
      // demotes every other `e2e-`/`qds-` box in the account to a warning it
      // has already surfaced — do NOT fold `strays` into the verdict. It never
      // throws, hence no try/catch: a failed listing comes back as
      // `owned: undefined`, which `fleetCleanupProblems` renders as a problem.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `t1-image-contract`, not `t2-`: the artifact name is deliberately NOT
      // renamed with the file (header) — every historical evidence file in
      // _bmad-output/evidence/df3-e2e carries it, and joinability is worth
      // more than a matching prefix.
      //
      // `writeEvidenceQuietly` (F11) keeps the promise the hand-rolled catch
      // made — an unwritable dir, a full disk or an unserializable phase must
      // not replace the in-flight AC6 regression — and adds the half it did
      // not: a failed write is now a REPORTED problem, which matters most for
      // the secret-scrub refusal, where the failure IS a leak.
      writeEvidenceQuietly("DF2.10", "t1-image-contract", {
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
      }, cleanupProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The cleanup verdicts are this run's LAST claim, on EVERY path — including
    // the red one, which the old `throw e` in the catch skipped outright.
    //
    //  - the BOX: `destroyQuietly` returns its verdict (#189); a leaked billing
    //    box is the one outcome this file must never report green.
    //  - the KEY: `revokeQuietly` never throws — a failed or unprovable revoke
    //    lands as a `finally-revoke ok:false` evidence entry, and an unread
    //    entry means a minted, spend-capped key could outlive the run. A
    //    HALF-WRITTEN record SHOULD surface here: it cannot prove no key was
    //    minted.
    //
    // Through `settleRun` so that a cleanup problem and a real AC6/gate
    // regression on the SAME run both survive, in that order of importance.
    //  - the FLEET: the cleanup-time `e2e-|qds-` listing, which is the only
    //    check that can see a box `vm` never named.
    //  - the KEY POPULATION (F17): `revokeQuietly` answering "already-gone"
    //    speaks for the RECORD, not for the account; a hash that outlived this
    //    run is revoked by `keyLeakProblems`' fallback and then named, because
    //    needing that fallback is itself the teardown defect.
    //
    // The `finally-revoke ok:false` fold-in is `fleetCleanupProblems`' third
    // argument now, not a hand-rolled filter here — one rendering for all
    // twelve live tests. Doing both would double-report the same failure.
    settleRun(failure, [
      ...fleetCleanupProblems(destroyError === "" ? [] : [`${vm}: ${destroyError}`], finalBoxes, evidence),
      ...cleanupProblems,
      ...keyProblems,
    ]);
  },
  // Budget audit (T5.1's EB6 shape), priced at DECLARED CEILINGS — not at
  // typical latency, which is what made the previous audit wrong. The old note
  // priced all sixteen straight-line probes at "~30 s" COMBINED while each one
  // carried `driver.exec`'s 120 s ceiling, i.e. 1 920 s of declared budget
  // costed at 30. A bun test-timeout abort is the ONE path where the `finally`
  // does not execute — the path that leaks a billing box and leaves the minted
  // key unrevoked — so this arithmetic has to hold at the ceiling, not at the
  // median.
  //
  //   create()          `ssh exe.dev new` (control, 120) + the steering-channel
  //                     provision exec (120)                             240 s
  //   cold-boot poll    BOOT_BUDGET_MS                                   120 s
  //   16 probes         × BOX_PROBE_TIMEOUT_MS 30 (was × 120 = 1 920)    480 s
  //   fill()            five in-box execs at the driver's 120 s (fill.ts) 600 s
  //   mint + deliver    HTTP + one exec                                  180 s
  //   setup gate        DEFAULT_GATE_TIMEOUT_MS (whole-gate budget)      300 s
  //   reboot poll       REBOOT_BUDGET_MS                                 240 s
  //   finally           destroy (up to five control calls at 120: rm/ls
  //                     ×2 plus the confirming ls) + revoke + evidence   660 s
  //   finally, r6       the cleanup the round-6 fixes ADDED to it:
  //                     `fleetLeftovers` 5 × (control ls 120 + 8 s wait)
  //                     + its destroy pass + confirming re-list      ≈   880 s
  //                     the key-attribution listing (the account-wide
  //                     `hashesBefore` fix)                          ≈   120 s
  //                     `keyLeakProblems`: delta list + fallback
  //                     revoke + recheck list                        ≈   360 s
  //                                                                   ────────
  //                                                                   4 180 s
  //
  // Hence 4 320 s. Measured wall time is ~15–25 min; this ceiling is what a
  // fully degraded round is allowed to consume BEFORE the abort that skips the
  // finally, and a higher ceiling is strictly the fail-safe direction for a
  // leak. Bounding the probes is the half that keeps the window short — the
  // budget only covers what this file cannot bound (the driver's and the gate's
  // own ceilings).
  //
  // The two poll legs already honour their budgets: `pollBootId` uses
  // `execTimed` at the remaining budget, so a hung ssh can no longer overshoot
  // BOOT_BUDGET_MS/REBOOT_BUDGET_MS by up to one 120 s attempt each.
  //
  // WHOEVER ADDS A STEP TO THE `finally` MUST ADD ITS CEILING HERE. Every line
  // under "finally" above is work that only runs on the one path where the bun
  // abort has NOT fired; growing it without growing this number is how the
  // abort starts landing mid-cleanup, which is the leak this audit exists to
  // prevent.
  4_320_000,
);
