/**
 * T2-SC — the vendored self-compact pi extension
 * (pi-vs-claude-code-vendor/self-compact/extensions/self-compact), live.
 *
 * TWO tests, one file, both behind `liveGate("2")` (the FILE is a paid tier-2
 * round because test 2 spends; test 1 mints nothing but runs in the same paid
 * round, exactly like tier2-reboot-arm's zero-model-spend arm):
 *
 *  SC.1  in-box extension load — the IMAGE's pi (0.84.4) loads the vendored
 *        extension bytes delivered box-side AT QDS_EXEDEV_SHA and registers
 *        all four `--compact-*` flags. Delivery mirrors the production fill
 *        seam for PRIVATE repos (fill.ts F4 bundle-push), MINI: the HOST's
 *        own git credentials fetch the SHA (scratchClone), `git archive`
 *        packs JUST the self-compact subtree (~50 KB gzipped, not a
 *        whole-repo bundle), and the bytes ride ONE exec stdin (base64) into
 *        an in-box untar. An anonymous in-box `git clone` — round 1's defect
 *        (evidence df3-e2e 2026-09-23-114202: `fatal: could not read
 *        Username`) — is remote-clone mode, public repos only. ZERO model
 *        spend: no dispatch, no key, no record — the box is created bare
 *        (`driver.create`, the reboot-arm shape), and
 *        `pi --no-extensions -e <vendored path> --help` (the smoke-test argv,
 *        scripts/self-compact-smoke-test.ts) must exit 0 naming every flag.
 *
 *  SC.2  real worker self-compaction at roster thresholds — a real dispatched
 *        run whose manifest+roster ride the PRODUCTION dispatch path, and a
 *        real deepseek-v4-flash worker whose pi argv carries
 *        `-e pi-vs-claude-code-vendor/self-compact/.../self-compact.ts
 *        --compact-soft-at 30% --compact-at 50% --compact-buffer 10%` because
 *        the ROSTER said so (harness_engineering + compaction → roster-adapter
 *        → TeamRole.extensions/extensionArgs → team-lead-driver
 *        buildWorkerArgv). The worker is driven across the notice and warning
 *        thresholds, writes a note_to_self, calls self_compact, compaction
 *        runs, and the note returns VERBATIM (the contract).
 *
 * ── WHY SC.2's WORKER RUNS ON THE HOST, stated here in full (the tier4 L19a
 *    precedent: a file that lets itself read as more than it proves is a
 *    defect) ────────────────────────────────────────────────────────────────
 *
 *  1. THE IMAGE DOES NOT SHIP THE EXTENSION. The engine's tree at
 *     /opt/qds-factory carries only `pi-vs-claude-code-vendor/{package.json,
 *     coms-core.ts}` (oci/exedev/Dockerfile's enumerated COPY set — a
 *     deriveBuildId input, so widening it is a re-pin ritual, not a test
 *     concern). An in-box `dispatch_task` walk resolves `-e` against the
 *     DRIVER's repo root (team-lead-driver.ts REPO_ROOT), so in-box the
 *     extension path would dangle and the worker would run extensionless — a
 *     hollow green. The host's driver resolves it against THIS checkout, where
 *     the vendored tree lives. SC.1 is the in-box half's proof: the image's
 *     own pi loads the extension bytes from the box-side tree delivered at
 *     QDS_EXEDEV_SHA (the fill bundle-push seam, mirrored).
 *  2. OBSERVABILITY IS A HOST-ONLY SEAM. The worker pi runs `--no-session`
 *     (ephemeral — no session jsonl exists), and the raw NDJSON capture is
 *     written only when QDS_TEAM_RAW_WORKER_DIR is set — an opt-in production
 *     seam (team-lead-driver.ts writeRawWorkerCapture) that the image-baked
 *     unit cannot set (its QDS_* env is allow-listed to exactly two names by
 *     the Dockerfile's AC6 scan). The host leg sets it.
 *
 *    What the BOX still proves in SC.2: the production dispatch verb (DERIVED
 *    roster beside the manifest, host-side roster pre-check, gates A–E with
 *    the roster's real models), the clone at QDS_EXEDEV_SHA (asserted:
 *    `git rev-parse HEAD` in the fill's checkout), and the DELIVERED stamped
 *    manifest pair — the same delivered-pair fetch tier4 performs.
 *
 * ── THE ONE KEY (a deliberate deviation from the task letter, stated) ───────
 *
 *  The task asked for "ONE key via the harness mint helper". The harness's
 *  `mintCappedKey` DISCARDS the plaintext by contract, and this test must hand
 *  a live key to the worker's environment — so a helper-minted key could never
 *  reach the worker. The key that actually carries the round is the run's OWN
 *  dispatch-minted key (cap 200 000 µ$, named by the workspace cost-config),
 *  read off the box's `app/.env` exactly as tier4 does: one secret, one box
 *  (INV-RES-3 / the tier-2 placement ADR's own remedy). A second, test-minted
 *  key would double the round's real exposure while every assertion still read
 *  "capped at 200 000" — the exact defect tier4's C16 change deleted. One key
 *  is minted by dispatch, revoked by `fleet teardown`, and verified gone by
 *  the body's listing plus the finally's population delta.
 *
 * ── SPEND (operator approved out of band) ───────────────────────────────────
 *
 *  SC.1: one box for minutes; two real GETs on /keys ($0).
 *  SC.2: one box for minutes + ONE run key at 200 000 µ$ cap. On that key: the
 *        dispatch setup gate's C/D chat pings (two roster models), the
 *        deepseek-v4-flash worker's compaction run (see SC_BIG_FILE_REL's fill
 *        arithmetic below), and one lead merge turn. Expected spend is
 *        input-dominated ~$0.08–0.12 (v4-flash $0.08/M in, $0.016/M cached —
 *        the sweep bills ~1.5M cumulative input tokens across turns plus the
 *        compaction summary call); worst case bounded by the key cap and the
 *        budget audits at the foot.
 *
 * MODEL OUTPUT IS NONDETERMINISTIC (the tier4 principle): the hard assertions
 * are STRUCTURAL events from the worker's own captured NDJSON stream — the
 * extension's phase entries, the self_compact tool call, the verbatim handoff —
 * never the model's prose. NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { KEY_ENV_FILE, KEY_ENV_VAR } from "../../../src/providers/credentials.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import {
  type LiveCtx,
  REPO_ROOT,
  awaitBoxAbsent,
  awaitWithCeiling,
  boxExec,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  revokeQuietly,
  runFleet,
  runIdFor,
  scratchClone,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

// ─── shared constants ────────────────────────────────────────────────────────

/**
 * 200,000 µ$ = $0.20 worst-case on the run key. Raised from the siblings'
 * 50,000 µ$ figure because the worker is deepseek-v4-flash with a 1M-token
 * window (models.json contextWindow 1,048,576): the thresholds under test sit
 * at 30% notice = 315k, 50% warning = 524k, 60% forced (50%+10% buffer, under
 * the 90% cap) = 629k tokens, so the sweep must ingest ~630k+ real tokens —
 * input-dominated spend ~$0.08–0.12 expected ($0.08/M in, $0.016/M cached),
 * $0.20 covers a no-cache worst case. v4-flash is tier4's proven slug.
 */
const SC_CAP_MICRO_USD = 200_000;
/** Box-hour rate from the operator's TIER-1 cost config — the tier2 siblings' figure. */
const SC_BOX_HOUR_RATE_MICRO_USD = 230_000;
/** The fixture dir this test ships (committed at QDS_EXEDEV_SHA — dispatch and the host leg read it from there). */
const FIXTURE_DIR_REL = "tests/fleet/e2e/fixtures/self-compact";
/** The manifest `fleet dispatch` delivers — repo-relative, resolved against the dispatch subprocess cwd (= REPO_ROOT). */
const SC_MANIFEST_REL = `${FIXTURE_DIR_REL}/self-compact.pipeline.json`;
/** The fixture roster: beside the manifest (the dispatch DERIVED pre-check + setup gate) AND the dispatch_task phase's spec.roster. */
const SC_ROSTER_REL = `${FIXTURE_DIR_REL}/roster.yaml`;
/** The vendored extension, as it must appear in the worker's pi argv (`-e <repo-relative path>`). */
const SC_EXT_REL = "pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts";
/** The subtree SC.1 archives host-side and ships in-box — the bundle-push seam's MINI payload (~50 KB gzipped). */
const SC_SUBTREE_REL = "pi-vs-claude-code-vendor/self-compact";
/**
 * The FILL SOURCE (148,281 B / 3,389 lines) — the worker's brief has bash
 * build /tmp/sc-fill.txt from 20 concatenated copies (20 × 148,281 =
 * 2,965,620 B ≈ 2.97 MB), then read it in 600,000-BYTE slices via
 * `tail -c +N | head -c 600000`. Slice-budget arithmetic (the 1M window):
 *   v4-flash window W = 1,048,576 tok (host models.json, verified)
 *   notice 30% = 314,573 tok · warning 50% = 524,288 tok · forced 60% = 629,146 tok
 *   ~4 chars/tok for text ⇒ one 600,000-B read ≈ 150k tok ≈ 14.3% of W
 *   cumulative: R1 150k/14% · R2 300k/29% · R3 450k/43% · R4 600k/57% (past
 *   warning — expected stop) · R5 741k/71% (contingency only). Total budget
 *   2.97 MB ≥ the 2.8-MB floor covers a tokenizer as conservative as
 *   ~4.7 chars/tok (2.97 MB / 629k tok) still crossing forced. Turn shape:
 *   1 generate + 1 baseline view_context + ≤5 × (read + view_context) + 1
 *   note/self_compact + 1 final reply ≈ 14 model calls — sized for the
 *   per-worker 240-s SIGKILL (few big reads, not many small ones; the
 *   view_context turns are cache-hit-cheap).
 */
const SC_BIG_FILE_REL = "pi-vs-claude-code-vendor/coms-net.ts";
/** The four flags a healthy load registers (self-compact.ts registerFlag ×4). */
const SC_FLAGS = ["--compact-soft-at", "--compact-at", "--compact-buffer", "--compact-prompt"] as const;
/** The host pi fixture catalog (tier4's gotcha-#3 seam — provider rates for the worker's model). */
const SC_PI_CATALOG_DIR = join(REPO_ROOT, "tests/phase-engine/fixtures/pi-catalog");

/** The worker's raw NDJSON capture name: `<rawDir>/<agentId>.ndjson` (writeRawWorkerCapture). */
const rawCapturePath = (rawDir: string, agentId: string): string => join(rawDir, `${agentId}.ndjson`);

/** sha256 of a file, hex — the tree-parity bridge between the working tree and the SHA clone. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Parse pi's `--mode json` stream: SPACE-separated JSON objects (pi writes
 * `JSON.stringify(event) + " "` per event — its writeRawStdout). String-aware
 * balanced-brace scan, so a `}` inside a string never splits an object and a
 * torn trailing fragment is skipped rather than thrown on.
 */
function parsePiStream(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            events.push(JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>);
          } catch {
            // a torn fragment is noise; the events that parsed are the record
          }
          start = -1;
        }
      }
    }
  }
  return events;
}

/** One `entry_appended` event's self-compact-phase data, or undefined — the extension's journaled crossings. */
function phaseEntryOf(e: Record<string, unknown>): { level?: unknown; percent?: unknown; text?: unknown } | undefined {
  if (e.type !== "entry_appended") return undefined;
  const entry = e.entry as { customType?: unknown; data?: unknown } | undefined;
  if (entry?.customType !== "self-compact-phase") return undefined;
  return entry.data as { level?: unknown; percent?: unknown; text?: unknown } | undefined;
}

/**
 * Incremental pipe collection (the harness's drainIncrementally shape, inlined
 * because the harness does not export it): `text` resolves only at EOF, so a
 * leg killed at the ceiling keeps whatever `soFar` had landed.
 */
function collectStream(stream: ReadableStream<Uint8Array>): { text: Promise<string>; soFar: () => string } {
  const chunks: Uint8Array[] = [];
  const text = (async () => {
    const reader = stream.getReader();
    try {
      let res = await reader.read();
      while (!res.done) {
        if (res.value !== undefined) chunks.push(res.value);
        res = await reader.read();
      }
    } catch {
      // keep whatever landed — the partial IS the payload on this path
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  return { text, soFar: () => Buffer.concat(chunks).toString("utf8") };
}

// ─── SC.1 — in-box extension load (boxes only, ZERO model spend) ────────────

test.todoIf(liveTodoOff())(
  "T2-SC.1 tier1-class: in-box extension load — the image's pi loads the vendored self-compact from a fill-style stdin-pushed tree at QDS_EXEDEV_SHA (boxes only, ZERO model spend — mint nothing)",
  async () => {
    // Tier 2 per the spend protocol: this FILE is a paid round (SC.2 spends),
    // so the gate is the file's tier even though THIS test mints no key and
    // opens no record — the tier2-reboot-arm shape (mint nothing, leak
    // nothing), with the key-population snapshot below standing in for the
    // keyLeakProblems machinery a minting test owes.
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    /** P28: `preflight` can throw — inside the try, and every finally leg guards on it. */
    let ctx: LiveCtx | undefined;
    let vm = "";
    /** The host workspace holding the scratch clone at the SHA ("" = never made). */
    let workspace = "";
    let outcome = "pass";
    /** The body's own error, held so the post-finally verdicts run on the failing path too. */
    let failure: unknown;
    /** Cleanup legs that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    const writeProblems: string[] = [];
    /** Key population BEFORE (stronger than reboot-arm, which skips the delta — this test mints nothing, so nothing may appear). */
    let hashesBefore: Set<string> | undefined;
    /** The snapshot's AFTER-side verdict — a problem line, never a bare expect in the finally (biome/noUnsafeFinally). */
    let keyProblems: string[] = [];
    try {
      ctx = await preflight("2");
      hashesBefore = await listedKeyHashes();
      // ── 1. a box from the PIN, the same driver every dispatch round uses ──
      const boxId = runIdFor("t2sc1");
      await awaitWithCeiling(ctx.driver.create(boxId), 240_000, "sc.1 box create");
      vm = boxId;
      const listed = await awaitWithCeiling(ctx.driver.list(boxId), 120_000, "sc.1 create-confirm ls");
      expect(listed.map((b) => b.name)).toEqual([boxId]);
      evidence.push({ phase: "create", ok: true, vm });

      const home = await boxHome(ctx.driver, vm);
      // NOT a box-side git clone. The repo is PRIVATE: an anonymous in-box
      // `git clone` is fill's remote-clone mode (public repos only) and died
      // `fatal: could not read Username` in round 1 (evidence
      // df3-e2e/2026-09-23-114202). Private repos reach the box the
      // bundle-push way (fill.ts F4): the HOST's own git credentials fetch
      // the SHA, the bytes cross the wire over exec stdin, and the box never
      // holds credentials at all (INV-CRED-1). SC.1 mirrors that seam at MINI
      // scale — one ~50 KB subtree, not a whole-repo bundle.
      const treeDir = `${home}/t2sc-tree`;
      // ── 2. the vendored subtree AT THE PINNED SHA, pushed box-side: host
      //    scratch-clone at the SHA (scratchClone — the same clone fill's
      //    hostBundle legs run host-side), `git archive` of JUST the
      //    self-compact subtree, gzip+base64, then ONE exec stdin into an
      //    in-box untar — the fill pushBundle channel, tier1-driver-lifecycle's
      //    stdin write is the sibling driver.exec precedent.
      workspace = tmpWorkspace("t2sc1");
      const hostClone = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const archive = Bun.spawnSync({
        cmd: ["git", "-C", hostClone, "archive", "--format=tar.gz", ctx.sha, SC_SUBTREE_REL],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (archive.exitCode !== 0) {
        throw new Error(
          `host git archive of ${SC_SUBTREE_REL} at ${ctx.sha} exited ${archive.exitCode}: ${archive.stderr.toString().trim().slice(0, 300)}`,
        );
      }
      const payload = archive.stdout.toString("base64");
      // live-mirror: fill.ts pushBundle — base64 payload over exec stdin (`base64 -d` in-box), the host→box content channel
      const push = await ctx.driver.exec(
        vm,
        [
          "sh",
          "-c",
          `umask 077 && rm -rf ${shellQuote(treeDir)} && mkdir -p ${shellQuote(treeDir)} && base64 -d | tar -xzf - -C ${shellQuote(treeDir)}`,
        ],
        payload,
      );
      evidence.push({
        phase: "subtree-push",
        exitCode: push.exitCode,
        base64Bytes: payload.length,
        stderrTail: push.stderr.trim().slice(-300),
      });
      expect(push.exitCode).toBe(0);

      // ── 3. TREE PARITY — there is no box-side clone HEAD to compare
      //    anymore, so the proof is the digest: the UNTARRed extension file's
      //    sha256 IN THE BOX must equal the HOST-side file's sha256 AT THE
      //    SAME SHA (the scratch clone's copy). Same digest on both ends of
      //    the stdin channel proves the bytes that will load ARE the bytes at
      //    QDS_EXEDEV_SHA. It also proves presence — sha256sum of a missing
      //    file exits non-zero — so the dangling-`-e` guard rides the same
      //    exec (a dangling `-e` could otherwise exit 0 registering nothing).
      const extShaAtPin = sha256File(join(hostClone, SC_EXT_REL));
      // live-mirror: fill.ts pushBundle's post-push size probe — in-box read-back after a stdin push
      const parity = await boxExec(ctx.driver, vm, [
        "sh",
        "-c",
        `sha256sum ${shellQuote(`${treeDir}/${SC_EXT_REL}`)}`,
      ]);
      const boxExtSha = parity.stdout.trim().split(/\s+/)[0] ?? "";
      evidence.push({
        phase: "tree-parity",
        exitCode: parity.exitCode,
        extFile: SC_EXT_REL,
        shaAtPin: extShaAtPin,
        boxSha: boxExtSha,
      });
      expect(parity.exitCode).toBe(0);
      expect(boxExtSha).toBe(extShaAtPin);

      // ── 4. the image's pi VERSION, recorded so the evidence says WHICH pi
      //    loaded the extension (the coordinator verified 0.84.4 locally; this
      //    proves the same binary in-box).
      const ver = await boxExec(ctx.driver, vm, ["sh", "-c", "pi --version 2>&1"]);
      evidence.push({ phase: "pi-version", exitCode: ver.exitCode, stdout: ver.stdout.trim() });

      // ── 5. THE PROBE — the smoke-test argv on the box: `--no-extensions`
      //    kills discovery so the ONLY thing that can register the four
      //    `--compact-*` flags is the vendored extension on `-e`, loaded from
      //    the stdin-pushed tree at the SHA. Exit 0 + all four flags in the
      //    combined streams is the load proof.
      // live-mirror: scripts/self-compact-smoke-test.ts — the same probe argv (pi --no-extensions -e <vendored path> --help)
      const probe = await boxExec(ctx.driver, vm, [
        "sh",
        "-c",
        `cd ${shellQuote(treeDir)} && PI_SKIP_VERSION_CHECK=1 pi --no-extensions -e ${shellQuote(SC_EXT_REL)} --help`,
      ]);
      const combined = `${probe.stdout}\n${probe.stderr}`;
      const distinct = SC_FLAGS.filter((f) => combined.includes(f));
      evidence.push({
        phase: "extension-load-probe",
        exitCode: probe.exitCode,
        distinctFlags: distinct,
        stdoutTail: probe.stdout.trim().slice(-400),
        stderrTail: probe.stderr.trim().slice(-300),
      });
      expect(probe.exitCode).toBe(0);
      expect(distinct).toEqual([...SC_FLAGS]);
      evidence.push({
        phase: "verdict",
        ok: true,
        note: `image pi (${ver.stdout.trim()}) registers all 4 self-compact flags from the box clone at ${ctx.sha}`,
      });
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      if (vm !== "" && ctx !== undefined) {
        // The verdict was READ (#189): a destroy that failed and was only
        // recorded shipped a green test on a box still billing.
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      if (ctx === undefined) {
        // P28 abort path: preflight never returned — nothing was provisioned,
        // so no box this run owns can exist. [] rather than undefined: the
        // listing did not FAIL, it was correctly skipped.
        finalBoxes = [];
        evidence.push({ phase: "final-ls-skipped", ok: true, note: "preflight never returned — nothing was provisioned" });
      } else {
        finalBoxes = (await fleetLeftovers(ctx.driver, [vm], evidence)).owned;
      }
      // No key was minted, so the
      // keyLeakProblems machinery (mint-aware, record-backed) is not owed —
      // but the BEFORE/AFTER population snapshot is, and it is rendered as a
      // verdict, never a bare expect in a finally. "Could not look" is never
      // "nothing leaked" (D6's rule).
      if (ctx !== undefined) {
        try {
          if (hashesBefore === undefined) {
            keyProblems = ["the pre-run key listing never landed — the mint-nothing delta is UNVERIFIED for this test"];
            evidence.push({ phase: "key-hash-delta", ok: false, error: "baseline missing" });
          } else {
            const before = hashesBefore;
            const after = await listedKeyHashes();
            const appeared = [...after].filter((h) => !before.has(h));
            evidence.push({ phase: "key-hash-delta", ok: appeared.length === 0, appeared });
            if (appeared.length > 0) {
              keyProblems = [`key hashes APPEARED during a mint-nothing test: ${appeared.join(", ")} — nothing this test ran may mint`];
            }
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          keyProblems = [`the mint-nothing key delta could not be rendered (${error}) — an unmeasured key population is never a clean one`];
          evidence.push({ phase: "key-hash-delta", ok: false, error });
        }
      }
      writeEvidenceQuietly("T2-SC.1", "t2-self-compact-load", { test: "T2-SC.1", outcome, vm, phases: evidence }, writeProblems);
      // GUARDED (P27, the SC.2 shape): the workspace holds only the
      // disposable host scratch clone — kept on the red path for forensics,
      // removed on the green one; never a bare rmSync over a held failure.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T2-SC.1] workspace kept for forensics: ${workspace}\n`);
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // The box this run owned must be GENUINELY gone, checked on EVERY path.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems, ...writeProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS (the reboot-arm shape):
  //   preflight whoami    1 ssh control at 120                              120 s
  //   baseline key list   listedKeyHashes (the mint-nothing baseline)       240 s
  //   create              control-plane new + steering provision            240 s
  //   create-confirm ls   1 control ls at 120                               120 s
  //   boxHome             1 driver.exec at 120                              120 s
  //   scratchClone        host depth-1 fetch (its own stall switch)         180 s
  //   host git archive    local spawnSync (~50 KB subtree)                  10 s
  //   subtree push+untar  1 driver.exec at 120 (base64 over stdin)          120 s
  //   tree-parity         1 driver.exec at 120 (sha256sum read-back)         60 s
  //   pi version          1 driver.exec at 120                               60 s
  //   load probe          1 driver.exec at 120                               60 s
  //   delta key list      listedKeyHashes                                   240 s
  //                                                            body ────────
  //                                                                  1 570 s
  //   destroyQuietly      rm + confirming list at 120                      240 s
  //   fleetLeftovers      5 × (control ls 120 + 8 s wait) + destroy pass    880 s
  //   delta list (fail)   a second listing on the appeared-key arm          240 s
  //   evidence + rmSync   local                                               10 s
  //                                                           finally ────────
  //                                                                  1 370 s
  //                                                           total ≈ 2 940 s
  // Hence 3_600_000. A bun test-timeout abort is the ONE path where the
  // `finally` does not execute — the fail-safe direction for this number is UP.
  3_600_000,
);

// ─── SC.2 — real worker self-compacts at roster thresholds (spend) ──────────

/** The dispatch verb's ceiling: the tier2 siblings' measured figure for the same verb (provision + fill + A–E gate). */
const SC2_DISPATCH_TIMEOUT_MS = 900_000;
/**
 * The host engine leg's ceiling. Must sit ABOVE the --budget-ms the leg runs
 * (840_000 ≥ the manifest's 825_000 runBudgetMs) with spawn margin, and a
 * firing ceiling kills the child and rejects into the catch → finally — the
 * safe direction. The team's own inner caps bind first: the fill phase's
 * maxDurationMs 270_000 (worker's 240-s per-subprocess SIGKILL + 30 s of lead
 * merge room) and wallClockCapMs 300 s — TeamManifestSchema defaults the
 * roster path cannot raise.
 */
const SC2_LEG_CEILING_MS = 900_000;
/** The body teardown verb's ceiling (artifacts + revoke + destroy on a never-started run). */
const SC2_TEARDOWN_TIMEOUT_MS = 300_000;
/** The worker's roster agentId — the raw capture file is named after it. */
const SC2_WORKER_AGENT = "compactor";

test.todoIf(liveTodoOff())(
  "T2-SC.2 tier2-class: real deepseek-v4-flash worker self-compacts at roster thresholds — dispatch (production path, roster beside the manifest) → delivered pair at QDS_EXEDEV_SHA → HOST-side engine leg whose worker pi argv carries -e <vendored self-compact> 30%/50%/10% → notice, warning, self_compact call, note VERBATIM (spend)",
  async () => {
    liveGate("2");
    // HOST-PI PREREQUISITES, refused BEFORE ANY SPEND (tier4's LT5/L19b shape):
    // a host OPENROUTER_API_KEY would flow into the leg on `...process.env`
    // and shadow the run's own key; the leg copies the host's models.json
    // into an isolated HOME (gotcha #2) and needs the fixture catalog (gotcha #3).
    const hostKey = (process.env[KEY_ENV_VAR] ?? "").trim();
    if (hostKey !== "") {
      throw new Error(
        `${KEY_ENV_VAR} is exported host-side. The leg's only credential is the run's own capped key read off the box (one secret per box — the tier4 C16 shape); a host key would silently shadow it. Unset it and re-run. (The value is not printed, here or anywhere.)`,
      );
    }
    const hostModelsJson = join(homedir(), ".pi", "agent", "models.json");
    if (!existsSync(hostModelsJson)) {
      throw new Error(`host pi models.json missing at ${hostModelsJson}: the leg copies it into the isolated HOME because the worker slug resolves only through that custom registry. Refusing before dispatch spends.`);
    }
    if (!existsSync(SC_PI_CATALOG_DIR)) {
      throw new Error(`pi fixture catalog dir missing at ${SC_PI_CATALOG_DIR}: QDS_PI_CATALOG_DIR must supply the provider rates. Refusing before dispatch spends.`);
    }
    const evidence: Record<string, unknown>[] = [];
    /** P28: preflight inside the try; every finally leg guards on it. */
    let ctx: LiveCtx | undefined;
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, held so the post-finally verdicts render on the red path too (EB3). */
    let failure: unknown;
    /** Cleanup legs that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    let finalBoxes: string[] | undefined;
    const writeProblems: string[] = [];
    /** The key population BEFORE the run (F17) — dispatch mints one; the finally's delta proves the revoke. */
    let hashesBefore: Set<string> | undefined;
    let keyProblems: string[] = [];
    /** F14: the account's box names BEFORE dispatch, so an unparseable dispatch timeout can still name what it created. */
    let boxesBeforeDispatch: ReadonlySet<string> | undefined;
    try {
      ctx = await preflight("2");
      hashesBefore = await listedKeyHashes();
      workspace = tmpWorkspace("t2sc2");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // BESIDE the records dir (costLedgerOpts → dirname(recordsDir)): without
      // it admission falls back to a $5 default cap and the box-hour close
      // fail-louds `box-hour-rate-unconfigured` (the tier2/tier5 shape).
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: SC_CAP_MICRO_USD, boxHourRateMicroUsd: SC_BOX_HOUR_RATE_MICRO_USD }),
      );
      // The frozen brief shape (R3, the siblings'): repoSlug canonically
      // matches repoUrl's path; commitSha = the pinned pushed sha; manifestPath
      // repo-relative, resolved against the dispatch subprocess cwd (= REPO_ROOT).
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: SC_MANIFEST_REL,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: SC_CAP_MICRO_USD, manifestPath: SC_MANIFEST_REL, rosterPath: SC_ROSTER_REL });

      // ── 1. the host clone AT THE SHA — three jobs: prove the SHA is
      //    fetchable (the dispatch fill needs exactly that), source the roster
      //    the engine leg reads (the bytes AT THE SHA, not the working tree's),
      //    and anchor the tree-parity check below.
      const hostClone = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      // TREE PARITY, hard: the working tree must agree with the SHA for every
      // file this round's claims depend on — the fixture roster (dispatch
      // pre-checks the working tree's copy; the leg runs the CLONE's copy),
      // the extension (the host driver loads the WORKING TREE's copy on -e),
      // and the big file (the worker reads the CLONE's copy, cwd-relative). A
      // mismatch means the round would prove working-tree bytes under a
      // SHA-labeled evidence file — refuse before anything is billed.
      const parity = [SC_ROSTER_REL, SC_EXT_REL, SC_BIG_FILE_REL].map((rel) => ({
        rel,
        workingTree: sha256File(join(REPO_ROOT, rel)),
        atSha: sha256File(join(hostClone, rel)),
      }));
      evidence.push({ phase: "tree-parity", ok: parity.every((p) => p.workingTree === p.atSha), files: parity });
      for (const p of parity) {
        expect(p.workingTree).toBe(p.atSha);
      }
      // The engine leg runs with cwd = the SHA clone (the worker's relative
      // reads resolve there), and its bare yaml/zod specifiers resolve through
      // the working tree's node_modules — one symlink into scratch (no git
      // verb runs in the leg; the clone is disposable).
      symlinkSync(join(REPO_ROOT, "node_modules"), join(hostClone, "node_modules"));

      // ── 2. THE DISPATCH — the production path: the DERIVED roster beside
      //    the manifest is host-side pre-checked before a box is billed, the
      //    A–E setup gate pings the roster's real models in-box (C/D — this
      //    round's first spend, on the run key), and the fill leaves the clone
      //    + the STAMPED delivered pair on the box.
      boxesBeforeDispatch = new Set((await ctx.driver.list()).map((b) => b.name));
      evidence.push({ phase: "pre-dispatch-ls", boxes: [...boxesBeforeDispatch] });
      const dispatch = await runFleet(
        // --budget-ms ≥ runBudgetMs (825k): the caller budget defaults to
        // 600k and a manifest above it is manifest-rejected before a box
        // exists (gotcha #7).
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir, "--budget-ms", "900000"],
        // 900 s, the T2.2-measured class for this verb.
        { cwd: REPO_ROOT, timeoutMs: SC2_DISPATCH_TIMEOUT_MS },
      ).catch((e: unknown) => {
        // The L1 fix (tier2/tier3's): the ceiling REJECTS before the ack, so
        // recover the partial streams — they carry the minted id — then rethrow.
        const partial = fleetPartialOutput(e);
        dispatchOut = partial.stdout;
        dispatchErr = partial.stderr;
        evidence.push({ phase: "dispatch-verb-timeout", error: (e as Error).message, recoveredBytes: partial.stdout.length + partial.stderr.length });
        throw e;
      });
      dispatchOut = dispatch.stdout;
      dispatchErr = dispatch.stderr;
      evidence.push({
        phase: "dispatch-verb",
        exitCode: dispatch.exitCode,
        stdoutTail: dispatch.stdout.trim().slice(-400),
        stderrTail: dispatch.stderr.trim().slice(-600),
      });
      // Ownership armed BEFORE the assertion that can throw (dispatch names a
      // box before it can still fail).
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);
      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId?: string; vmName?: string; state?: string };
      // Assign only on non-empty strings (P29): a gate-event tail must not
      // clobber a successfully recovered id with undefined.
      if (typeof ack.runId === "string" && ack.runId !== "") runId = ack.runId;
      if (typeof ack.vmName === "string" && ack.vmName !== "") vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      expect(runId).toMatch(/^qds-/);
      evidence.push({ phase: "ack", runId, vmName });
      // Positive control (attach-transport's shape): the box must be VISIBLE
      // to driver.list() — reachability alone would let a list-blind driver
      // make awaitBoxAbsent/fleetLeftovers vacuously green.
      const listedNow = (await ctx.driver.list()).map((b) => b.name);
      expect(listedNow).toContain(vmName); // live-mirror: post-ack box visibility (fill.ts dispatch)

      // ── 3. the record carries the correlation identity and the ONE key ────
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.keyHash ?? "").not.toBe(""); // dp:ok the ?? "" IS the validation — the assert demands non-blank right here
      expect(rec.limitMicroUsd).toBe(SC_CAP_MICRO_USD);
      expect(typeof rec.requestId).toBe("string");
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd, requestId: rec.requestId });

      // ── 4. the BOX clone is at the SHA, and the delivered pair is there ──
      const home = await boxHome(ctx.driver, vmName);
      // live-mirror: DEFAULT_FILL_WORKDIR ("src") — the dispatch fill's checkout root (fill.ts)
      const checkoutRoot = `${home}/${DEFAULT_FILL_WORKDIR}`;
      const head = await boxExec(ctx.driver, vmName, ["sh", "-c", `git -C ${shellQuote(checkoutRoot)} rev-parse HEAD`]);
      evidence.push({ phase: "box-clone-head", exitCode: head.exitCode, head: head.stdout.trim() });
      expect(head.exitCode).toBe(0);
      expect(head.stdout.trim()).toBe(ctx.sha);
      // live-mirror: DEFAULT_FILL_WORKDIR + QDS_IN_BOX_DIR (fill.ts) — the delivered stamped pair's home
      const qdsDir = `${checkoutRoot}/${QDS_IN_BOX_DIR}`;
      const manifestBytes = await fetchBoxFile(ctx.driver, vmName, `${qdsDir}/pipeline.yaml`); // live-mirror: delivered manifest pair (fill.ts DEFAULT_FILL_WORKDIR/.qds)
      const witnessBytes = await fetchBoxFile(ctx.driver, vmName, `${qdsDir}/run-context.json`);
      const witness = JSON.parse(witnessBytes) as { requestId?: string; effectiveCeilingMicros?: unknown };
      expect(typeof witness.requestId).toBe("string");
      expect((witness.requestId ?? "").length).not.toBe(0);
      const witnessRequestId = witness.requestId as string;
      evidence.push({
        phase: "delivered-pair",
        qdsDir,
        witnessRequestId,
        witnessCeiling: witness.effectiveCeilingMicros,
        deliveredLimit: (JSON.parse(manifestBytes) as { limitMicroUsd?: number }).limitMicroUsd,
      });

      // ── 5. the RUN'S OWN key, read off the box (one secret per box — the
      //    tier4 C16/L19 shape; this file mints no key of its own, see the
      //    header). FAIL LOUDLY here: a truncated key 401s, pi exits 0 with
      //    empty content, and every later assertion would name nothing about
      //    credentials. Folded to booleans before the matcher — bun prints the
      //    RECEIVED value in a failure message, and the received value here is
      //    a live credential.
      const envBody = await fetchBoxFile(ctx.driver, vmName, `${home}/${KEY_ENV_FILE}`);
      const runKey =
        envBody
          .split("\n")
          .find((line) => line.startsWith(`${KEY_ENV_VAR}=`))
          ?.slice(KEY_ENV_VAR.length + 1)
          .trim() ?? "";
      expect(runKey.startsWith("sk-or-")).toBe(true);
      expect(runKey.length >= 40).toBe(true);
      evidence.push({ phase: "run-key", source: `${home}/${KEY_ENV_FILE}`, envVar: KEY_ENV_VAR, ok: true, keyChars: runKey.length, provenance: "delivered by dispatch — this test mints no key of its own" });

      // ── 6. the leg layout (the tier4 delivered-pair pattern; run-root INV-1
      //    respected — the manifest must resolve INSIDE --run-root, so the leg
      //    carries its own copy of the delivered pair, and the roster sits at
      //    its repo-relative path inside the leg root for loadRoster's
      //    beneath-root containment).
      const legDir = join(workspace, "leg");
      const legDelivered = join(legDir, "delivered");
      const rawDir = join(legDir, "raw-workers");
      const legTmp = join(legDir, "tmp");
      mkdirSync(legDelivered, { recursive: true });
      mkdirSync(legTmp, { recursive: true });
      writeFileSync(join(legDelivered, "pipeline.yaml"), manifestBytes); // live-mirror: delivered manifest pair (fill.ts DEFAULT_FILL_WORKDIR/.qds)
      writeFileSync(join(legDelivered, "run-context.json"), witnessBytes);
      const legRosterPath = join(legDir, SC_ROSTER_REL);
      mkdirSync(dirname(legRosterPath), { recursive: true });
      copyFileSync(join(hostClone, SC_ROSTER_REL), legRosterPath);
      // HOST-PI ISOLATION (gotcha #2, proven by tier4's live A/B): the host's
      // pi resolves auth.json OVER the env key and that stored key is dead, so
      // the leg runs pi under an isolated HOME carrying models.json and NO
      // auth.json — model resolution intact, auth strictly from the run's key.
      const piHome = join(workspace, "pi-home");
      mkdirSync(join(piHome, ".pi", "agent"), { recursive: true });
      copyFileSync(hostModelsJson, join(piHome, ".pi", "agent", "models.json"));
      const legRunId = runIdFor("t2sc-leg");

      // ── 7. THE ENGINE LEG — the PRODUCTION dispatch_task path on the host:
      //    pipeline-run walks the DELIVERED manifest, the phase body loads the
      //    roster (the CLONE's bytes at the SHA), roster-adapter maps
      //    harness_engineering/compaction onto the worker's TeamRole, and
      //    team-lead-driver's buildWorkerArgv emits the argv under test —
      //    `-e <vendored path> --compact-soft-at 30% --compact-at 50%
      //    --compact-buffer 10%`. `--no-resident` (a pipeline-run flag, tier4's
      //    L1 shape): the steering resident is tier4/tier5's subject and would
      //    only add spend and nondeterminism here.
      const legProc = Bun.spawn({
        cmd: [
          "bun",
          join(REPO_ROOT, "scripts/pipeline-run.ts"),
          "--manifest",
          join(legDelivered, "pipeline.yaml"), // live-mirror: delivered manifest pair (fill.ts DEFAULT_FILL_WORKDIR/.qds)
          "--journal",
          join(legDir, "journal.jsonl"),
          "--run-id",
          legRunId,
          "--request-id",
          witnessRequestId,
          // must be ≥ the manifest's runBudgetMs (825_000 — see the fixture's budget note)
          "--budget-ms",
          "840000",
          "--run-root",
          legDir,
          "--no-resident",
        ],
        // cwd = the SHA clone: the worker's relative reads resolve against the
        // tree the box also carries; the symlinked node_modules keeps the
        // engine's bare yaml/zod resolvable.
        cwd: hostClone,
        env: {
          ...(process.env as Record<string, string>),
          HOME: piHome,
          TMPDIR: legTmp,
          QDS_RUN_ROOT: legDir,
          QDS_TEAM_RUNNER: "local",
          QDS_TEAM_RAW_WORKER_DIR: rawDir,
          QDS_PI_CATALOG_DIR: SC_PI_CATALOG_DIR,
          [KEY_ENV_VAR]: runKey,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const outDrain = collectStream(legProc.stdout);
      const errDrain = collectStream(legProc.stderr);
      let legExit: number | null = null;
      let legOut = "";
      let legErr = "";
      try {
        const settled = await awaitWithCeiling(
          Promise.all([legProc.exited, outDrain.text, errDrain.text]).then(
            ([code, stdout, stderr]) => ({ code, stdout, stderr }) as const,
          ),
          SC2_LEG_CEILING_MS,
          "self-compact engine leg",
        );
        legExit = settled.code;
        legOut = settled.stdout;
        legErr = settled.stderr;
      } catch (e) {
        // A fired ceiling kills the child FIRST, then records whatever partial
        // streams had landed (the kill closes the child's pipe ends; the grace
        // race only bounds a grandchild holding them open).
        legProc.kill();
        const partial = await Promise.race([
          Promise.all([outDrain.text, errDrain.text]).then(([o, r]) => `${o}\n${r}`),
          new Promise<string>((resolve) => setTimeout(() => resolve(`${outDrain.soFar()}\n${errDrain.soFar()}`), 5_000)),
        ]);
        legErr = partial;
        evidence.push({ phase: "leg-ceiling", error: e instanceof Error ? e.message : String(e), partialBytes: partial.length });
      }
      evidence.push({
        phase: "engine-leg",
        exitCode: legExit,
        stdoutHead: legOut.trim().slice(0, 300),
        stderrTail: legErr.trim().slice(-800),
      });

      // ── 8. THE WORKER'S OWN STREAM — the raw NDJSON capture. Its EXISTENCE
      //    is the hollow-green guard: a phase that refused pre-spawn (env,
      //    roster, containment) writes no capture at all, so the missing file
      //    is the failure that names the refusal, not a skipped assert.
      const capturePath = rawCapturePath(rawDir, SC2_WORKER_AGENT);
      const captureExists = existsSync(capturePath);
      if (!captureExists) {
        evidence.push({ phase: "raw-capture", ok: false, error: `no raw worker capture at ${capturePath} — the worker pi never ran; see engine-leg stderrTail above` });
      }
      expect(captureExists).toBe(true);
      const capture = readFileSync(capturePath, "utf8");
      const events = parsePiStream(capture);
      evidence.push({
        phase: "raw-capture",
        ok: true,
        bytes: capture.length,
        events: events.length,
        truncated: capture.includes("[truncated at "),
      });

      // (a) + (b) — the extension's journaled threshold crossings. Each
      // crossing appends a self-compact-phase entry whose text IS the guidance
      // the model received (pi.appendEntry → entry_appended on the session
      // bus → the json stream), so the assert is on the extension's own
      // record, never on model prose.
      const crossings = events.flatMap((e) => {
        const entry = phaseEntryOf(e);
        return entry === undefined
          ? []
          : [{ level: String(entry.level ?? ""), percent: entry.percent ?? null, text: String(entry.text ?? "") }];
      });
      evidence.push({ phase: "threshold-crossings", crossings });
      const notice = crossings.find((c) => c.level === "notice");
      const warning = crossings.find((c) => c.level === "warning");
      expect(notice !== undefined).toBe(true);
      expect((notice?.text.includes("[self-compact · notice]") ?? false)).toBe(true);
      expect(warning !== undefined).toBe(true);
      expect((warning?.text.includes("[self-compact · WARNING]") ?? false)).toBe(true);

      // (c) — a self_compact tool call occurred AND completed (a start paired
      // with a non-error end on the same toolCallId).
      const toolStarts = events.filter((e) => e.type === "tool_execution_start" && e.toolName === "self_compact");
      const toolEnds = events.filter((e) => e.type === "tool_execution_end" && e.toolName === "self_compact");
      const completed = toolStarts.find((s) => toolEnds.some((e) => e.toolCallId === s.toolCallId && e.isError !== true));
      evidence.push({ phase: "self-compact-tool", starts: toolStarts.length, ends: toolEnds.length, completed: completed !== undefined });
      expect(toolStarts.length).toBeGreaterThan(0);
      expect(completed !== undefined).toBe(true);

      // (d) — the VERBATIM contract: the note handed to self_compact returns
      // byte-for-byte as the handoff message's whole content. Both sides are
      // parsed off the same stream (JSON unescaping applied equally), so the
      // comparison is the exact string the model sent vs the exact string it
      // received back.
      const note = String((completed?.args as { note_to_self?: unknown } | undefined)?.note_to_self ?? "");
      expect(note.trim().length > 20).toBe(true); // dp:ok the boolean IS the assert — a blank/echo note fails right here
      const completedIdx = completed === undefined ? -1 : events.indexOf(completed);
      const handoff = events
        .slice(completedIdx >= 0 ? completedIdx : 0)
        .find(
          (e) =>
            e.type === "message_end" &&
            (e.message as { customType?: unknown } | undefined)?.customType === "self-compact-handoff",
        );
      const handoffContent = handoff === undefined ? undefined : String((handoff.message as { content?: unknown }).content ?? "");
      evidence.push({
        phase: "verbatim-handoff",
        noteChars: note.length,
        handoffFound: handoff !== undefined,
        byteEqual: handoffContent === note,
        notePreview: note.slice(0, 200),
      });
      expect(handoff).toBeDefined();
      expect(handoffContent).toBe(note);
      // Corroborating structure (evidence, not load-bearing): a compaction
      // completed and was not aborted — the machinery (d) rides on.
      const compaction = events.find((e) => e.type === "compaction_end");
      const summaryText = String((compaction?.result as { summary?: unknown } | undefined)?.summary ?? "");
      evidence.push({
        phase: "compaction",
        found: compaction !== undefined,
        aborted: compaction === undefined ? null : String(compaction.aborted),
        summaryChars: summaryText.length,
      });

      // (e) — SOFT (the tier4 conditional principle): IF the forced level was
      // reached, a non-self_compact tool call was refused there. A blocked call
      // surfaces as an errored tool_execution_end whose result carries the
      // extension's block reason. Logged as a level timeline + observed blocks;
      // forced-without-a-refusal is an evidence NOTE, never a red — model path
      // choice is nondeterministic and (a)–(d) are the round's hard claims.
      const blockedToolCalls = events
        .filter(
          (e) =>
            e.type === "tool_execution_end" &&
            e.isError === true &&
            JSON.stringify(e.result ?? "").includes("blocked by self-compact"),
        )
        .map((e) => String(e.toolName ?? ""));
      const viewLevels = events
        .filter((e) => e.type === "tool_execution_end" && e.toolName === "view_context")
        .map((e) => {
          try {
            const parsed = JSON.parse(
              String((e.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "{}"),
            ) as { level?: unknown; used_percent?: unknown };
            return { level: parsed.level ?? null, usedPercent: parsed.used_percent ?? null };
          } catch {
            return { level: null, usedPercent: null };
          }
        });
      const forced = crossings.find((c) => c.level === "forced");
      evidence.push({
        phase: "forced-arm",
        forcedReached: forced !== undefined,
        forcedPercent: forced?.percent ?? null,
        blockedToolCalls,
        viewContextLevels: viewLevels,
        note:
          forced !== undefined && blockedToolCalls.length === 0
            ? "forced level reached but no blocked non-self_compact tool call observed — the model went straight to its note; logged, not failed (model path choice is nondeterministic)"
            : null,
      });

      // ── 9. the journal, torn-tolerant (tier4's LT6 shape): the leg's overall
      //    verdict is EVIDENCE — a wall-clock overflow at the team's 300 s cap
      //    can coexist with everything (a)–(d) above having happened.
      let journal: Record<string, unknown> = {};
      const journalPath = join(legDir, "journal.jsonl");
      if (existsSync(journalPath)) {
        try {
          journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
        } catch (e) {
          evidence.push({ phase: "journal-parse-error", error: e instanceof Error ? e.message : String(e) });
        }
      }
      evidence.push({ phase: "leg-journal", ok: journal.ok ?? null, phases: journal.phases ?? null });

      // ── 10. the production teardown (in the BODY, so the spend and revoke
      //     verdicts assert here): capture spend → revoke → verify → destroy →
      //     close. --no-harvest: this test's proof was read off the box and
      //     the capture in step 8; a harvest would only re-pull them. Exit 6
      //     is harvest_waived SUCCESS (gotcha #6) — 0 and 6 are the PASS pair.
      const td = await runFleet(
        ["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"],
        { cwd: REPO_ROOT, timeoutMs: SC2_TEARDOWN_TIMEOUT_MS },
      );
      evidence.push({ phase: "teardown-verb", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
      expect([0, 6]).toContain(td.exitCode ?? -1);
      const closed = store.get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      // The gate pings alone guarantee > 0; the cap is the round's money claim.
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(SC_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: SC_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });
      // THE key is gone (the finally's F17 delta re-proves it account-wide).
      const hashes = await listedKeyHashes();
      expect([...hashes].includes(closed.keyHash ?? "")).toBe(false);
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // F12: recover ids from BOTH streams so a dispatch that provisioned then
      // refused still cleans up its box.
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      // F14: dispatch RAN but its ids could not be recovered — diff the account
      // against the pre-dispatch baseline and FAIL LOUD on anything fresh
      // (fleetLeftovers would otherwise demote a genuine leak to a stray).
      if ((runId === "" || vmName === "") && (dispatchOut !== "" || dispatchErr !== "") && ctx !== undefined) {
        const baseline = boxesBeforeDispatch ?? new Set<string>();
        const fresh = (await ctx.driver.list())
          .map((b) => b.name)
          .filter((n) => /^(e2e|qds)-/.test(n) && !baseline.has(n));
        evidence.push({ phase: "finally-unrecovered-dispatch", ok: fresh.length === 0, freshBoxes: fresh });
        if (fresh.length > 0) {
          destroyFailures.push(
            `dispatch output could not be parsed for a run id and ${fresh.length} box(es) created this round are UNATTRIBUTED: ${fresh.join(", ")} — sweep by hand (ssh exe.dev rm <name>)`,
          );
        }
      }
      if (runId !== "" && workspace !== "") {
        // okExitCodes [0, 6]: 6 = harvest_waived, a --no-harvest teardown's own
        // SUCCESS shape (gotcha #6); the body's teardown already ran on the
        // green path, and this leg covers the red path.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000, okExitCodes: [0, 6] },
          evidence,
          { at: "t2-sc.2-cleanup", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vmName !== "" && ctx !== undefined) {
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      if (ctx === undefined) {
        finalBoxes = [];
        evidence.push({ phase: "final-ls-skipped", ok: true, note: "preflight never returned — nothing was provisioned" });
      } else {
        finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      }
      let keyStore: RunRecordStore | undefined;
      try {
        keyStore = workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        evidence.push({ phase: "finally-key-store-error", runId, error });
        destroyFailures.push(`the finally's RunRecordStore constructor threw for ${runId}: ${error}`);
      }
      // The belt-and-braces revoke (the tier2-attach-transport shape): the
      // body's teardown already revoked on the green path — `revokeQuietly`
      // answers "none" with no API call when the record carries no keyHash,
      // and it is the only leg that covers a body that died before step 10.
      // It never throws (#189); the guard is for constructor/driver
      // rejections outside that contract.
      if (runId !== "" && keyStore !== undefined && ctx !== undefined) {
        try {
          await revokeQuietly(ctx.driver, keyStore, runId, evidence);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          evidence.push({ phase: "finally-revoke-error", runId, error });
          destroyFailures.push(`finally revoke threw for ${runId}: ${error}`);
        }
      }
      if (hashesBefore === undefined || ctx === undefined) {
        // P28/D6: no baseline, no verdict — "could not look" is never "nothing leaked".
        keyProblems = ["the F17 baseline key listing never landed — the key-hash delta is UNVERIFIED for this round"];
        evidence.push({ phase: "key-hash-baseline-missing", ok: false });
      } else {
        try {
          keyProblems = await keyLeakProblems(hashesBefore, { driver: ctx.driver, store: keyStore, runIds: [runId] }, evidence);
        } catch (keyErr) {
          keyProblems = [
            `key-leak sweep itself failed: ${keyErr instanceof Error ? keyErr.message : String(keyErr)} — treat the run key's revocation as UNVERIFIED`,
          ];
          evidence.push({ phase: "key-leak-sweep-failed", ok: false, error: keyProblems[0] });
        }
      }
      writeEvidenceQuietly("T2-SC.2", "t2-self-compact-worker", { test: "T2-SC.2", outcome, runId, vmName, capMicroUsd: SC_CAP_MICRO_USD, phases: evidence }, writeProblems);
      // GUARDED (P27): the LAST statement of the finally must not throw over
      // the held failure. The workspace is KEPT on the red path for forensics
      // (the raw capture is inside it) — the tier4 shape.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T2-SC.2] workspace kept for forensics: ${workspace}\n`);
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // The post-finally verdict (EB3), in ONE place: `settleRun` fails a green
    // run on a cleanup problem and, on a red one, attaches the problems to the
    // body's own error instead of throwing over the top of it.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems, ...writeProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS — a bun test-timeout abort is the
  // ONE path where the `finally` does not execute, so it is the one path where
  // the box and the key leak. WHOEVER RAISES AN INNER CEILING, LENGTHENS A POLL
  // OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE.
  //
  //   preflight whoami    1 ssh control at 120                              120 s
  //   baseline key list   listedKeyHashes                                   240 s
  //   scratchClone        host depth-1 fetch (its own stall switch)          180 s
  //   pre-dispatch ls     1 control ls at 120 (F14 baseline)                 120 s
  //   dispatch verb       runFleet 900_000 (provision + fill + A–E gate)     900 s
  //   box reads           boxHome + head + pair + key env — 5 × 120          600 s
  //   engine leg          awaitWithCeiling 900_000 (≥ --budget-ms 840_000)   900 s
  //   capture + asserts   local                                               10 s
  //   teardown verb       runFleet 300_000                                   300 s
  //   post-teardown list  listedKeyHashes                                    240 s
  //   box-absent poll     4 × (read + 10 s wait)                              80 s
  //                                                            body ────────
  //                                                                  3 690 s
  //   id recovery ls      1 control ls at 120 (F14 — timeout path only)      120 s
  //   teardownQuietly     fleet teardown at 180                              180 s
  //   destroyQuietly      1 rm + confirming list at 120                     240 s
  //   fleetLeftovers      5 × (control ls 120 + 8 s wait) + destroy pass     880 s
  //   revokeQuietly       verb-class allowance                               120 s
  //   keyLeakProblems     delta list + fallback revoke + recheck list        360 s
  //   evidence + rmSync   local                                               10 s
  //                                                           finally ────────
  //                                                                  1 910 s
  //                                                           total ≈ 5 600 s
  //
  // Hence 5_700_000 (margin over the 5 600 s serial worst case). The task's
  // ~20 min wall-clock bound is the BODY's healthy-round expectation (dispatch
  // ~5 min + leg ~2-15 min + teardown ~1 min); every inner ceiling FIRING
  // rejects into the catch → finally, so the fail-safe direction for this
  // number is UP.
  5_700_000,
);
