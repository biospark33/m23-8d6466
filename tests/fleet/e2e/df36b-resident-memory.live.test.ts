/**
 * DF3.6b — the story's make-or-break AC1, LIVE and IN-BOX (E2E Slice, NOT
 * the host-side tier4-resident file — every leg there runs pipeline-run.ts
 * on the darwin operator host, where no cgroup exists). TWO legs, TWO
 * dispatches, TWO boxes, ordered Leg A first because its crossing is the
 * cheapest falsifier and a Leg A failure must end the round before Leg B
 * spends a µ$ on a model:
 *
 *   Leg A — the CROSSING (AC1's enforcement clause). A python3 allocator is
 *   staged on the box as that leg's QDS_PI_BIN (appended to $HOME/app/.env,
 *   the unit's mandatory EnvironmentFile — box-local, never image content),
 *   the manifest declares residentRssBytes 134217728 (128 MiB), the run_start
 *   solicitation execs the allocator into its own cgroup v2 leaf through the
 *   shipped fail-closed placement wrapper, the allocator touches ~512 MiB of
 *   anonymous memory, and the KERNEL OOM-kills the leaf (memory.max +
 *   memory.oom.group=1, both shipped writes). The engine issues no signal and
 *   takes no sample; the journal must read resident.exitStatus "overflow"
 *   beside status "stopped" with a watchdog_kill tripwire carrying the peak
 *   and the bound, and the run must STILL settle ok deterministically.
 *   ≈zero model spend: the allocator never calls the model.
 *
 *   Leg B — the ATTACHMENT (AC1's precondition clause + the DoD's baseline
 *   measurement). NO QDS_PI_BIN line and NO residentRssBytes field: the
 *   in-box front door arms the resident under the SHIPPED production default
 *   (loadResidentBounds injects PROVISIONAL_RESIDENT_RSS_BYTES when the
 *   manifest omits the field), real pi solicits run inside real leaves, and
 *   every resident_cgroup line must read oomKilled:false with
 *   rssPeakBytes < bound. The FIRST line's rssPeakBytes is the pi baseline
 *   measurement the story's second live DoD item requires — zero marginal
 *   spend, taken from a solicitation the round already makes. Its falsifiers
 *   are evaluated in evidence: baseline ≥ 32 MiB ⇒ the 64 MiB E2E fixture
 *   bound (used by host-side suites) proves attachment rather than crossing;
 *   ≥ 256 MiB ⇒ the 512 MiB production default has under one doubling of
 *   headroom and must be re-set before DF3.6b ships.
 *
 * The explicit live-only checks the story's NOT-DONE section demands, and
 * where each lands:
 *   (a) the placement actually TOOK — Leg A samples the live leaf's
 *       cgroup.procs over ssh DURING the solicitation window and must see
 *       the child's pid (membership read back on a real kernfs leaf, not
 *       just an exit code);
 *   (b) the allocator MUST NOT exit 97 — it is python3 under a
 *       `#!/usr/bin/python3` shebang and ignores argv entirely; Leg A
 *       additionally asserts no exit-97 / unenforceable classification
 *       anywhere and no arming refusal;
 *   (c) kernel version — `uname -r` is read on EACH box BEFORE anything
 *       else; memory.peak needs 5.19+, cgroup.kill needs 5.14+. Below 5.19
 *       the peak conjunct is skipped per ruling 8 (Leg A) and the baseline
 *       item CANNOT be taken (Leg B fails loudly — a 0 reading is
 *       MEASUREMENT FAILED, never a baseline);
 *   (d) the EBUSY rmdir budget under REAL reap latency — each leg asserts
 *       the leaves are GONE post-run and records cgroup_teardown_ms from
 *       the resident_cgroup line; a leaf that survived its own kill would
 *       stay in the listing and fail the leg;
 *   (e) kernfs rejection modes — while a leaf is live, Leg A's sampler
 *       attempts ONE placement of a nonexistent pid (4194304, the pid-max
 *       ceiling) into the live leaf's cgroup.procs and records the kernel's
 *       answer; real kernfs rejects what the fs-level fake accepts.
 *       Best-effort by design (the window is one ≤60 s solicitation); the
 *       attempt and its outcome are recorded either way, and the leg does
 *       not fail when the window was missed — that residual is stated in
 *       the evidence, not papered over.
 *
 * GATING: `liveGate("2")` under `test.todoIf(liveTodoOff())` — "tier 4" is
 * a roster label, never an env value. Environment:
 *   QDS_E2E_LIVE=1  QDS_E2E_TIER=2  QDS_EXEDEV_REPO_URL=<url>
 *   QDS_EXEDEV_SHA=<pushed sha carrying config/rosters/df36b-leg-*.pipeline.json>
 *   QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml
 * Cost (operator-approved out of band for the 2026-10-01 round): TWO keys
 * at the plan-default 50 000 µ$ cap + TWO boxes; Leg A ≈ zero model spend,
 * Leg B ≈ two real pi solicitations (~25 µ$ each measured in-box) plus ~1
 * box-hour ceiling per leg. Every key revoked in `finally`; every box
 * destroyed in `finally`; `fleetLeftovers` sweeps the e2e- and qds- box
 * name prefixes.
 *
 * NO FAKES: real ssh, real systemd, real cgroupfs, real kernel OOM, real
 * OpenRouter key API, real pi (Leg B). No FakeDriver/FakeKeyApi/fake-pi
 * import anywhere in this file.
 *
 * The HARVEST verb is deliberately NOT used: the tripwire rows this story
 * asserts live in the journal's `resident` block (steering.ts pushes them
 * onto telemetry.tripwires; FileJournal flushes the block whole), and the
 * fd-2 lines live in journald — both are read straight off the box with
 * readBoxFile / journalctl before teardown, so the round needs no scratch
 * clone and no tar. Raw text lands in evidence beside every parsed claim.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runUnitName } from "../../../src/fleet/run.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { redactSecrets } from "../../../src/providers/step-log.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  lastJsonLine,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  revokeQuietly,
  runFleet,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const BOX_HOUR_RATE_MICRO_USD = 230_000;

/** Leg A's manifest: declares the 128 MiB fixture bound explicitly. */
const LEG_A_MANIFEST_PATH = "config/rosters/df36b-leg-a.pipeline.json";
/** Leg B's manifest: NO residentRssBytes — the front door injects the shipped default. */
const LEG_B_MANIFEST_PATH = "config/rosters/df36b-leg-b.pipeline.json";

/** Leg A's fixture bound — mirrors the manifest byte for byte (the numeric
 *  contract: the manifest value IS the memory.max the leaf carries). */
const LEG_A_BOUND_BYTES = 134_217_728;
/** Ruling 8's slack: the peak conjunct admits peaks ≥ bound − 2 MiB. */
const OOM_PEAK_SLACK_BYTES = 2 * 1024 * 1024;
/** The production default the front door injects on Leg B (until the
 *  measured baseline re-sets it — G4 of .unlazy/df3-6b/GATES.md). */
const PROVISIONAL_DEFAULT_BYTES = 536_870_912;
/** Baseline falsifiers from the story DoD (32 MiB fixture / 256 MiB default). */
const BASELINE_FIXTURE_FALSIFIER_BYTES = 32 * 1024 * 1024;
const BASELINE_DEFAULT_FALSIFIER_BYTES = 256 * 1024 * 1024;

/** The dispatched brief pins the manifest the engine walks — delivered from
 *  the repo at QDS_EXEDEV_SHA, never from the local tree. */
const DISPATCH_TIMEOUT_MS = 900_000;
const RUN_VERB_TIMEOUT_MS = 180_000;
const STATUS_VERB_TIMEOUT_MS = 60_000;
const STATUS_ATTEMPTS = 10;
const STATUS_WAIT_MS = 10_000;

/**
 * The live-leaf sampler (Leg A). Started BEFORE `fleet run`, stopped at
 * settle: every tick is one ssh exec bounded at 10 s, and the whole window
 * is priced in the budget audit at each test's foot.
 */
const LEAF_POLL_INTERVAL_MS = 700;
const LEAF_POLL_MAX_MS = 500_000;
const LEAF_POLL_EXEC_DEADLINE_MS = 10_000;

/** kernel floors: memory.peak is 5.19+, cgroup.kill is 5.14+. */
const KERNEL_PEAK_MAJ = 5;
const KERNEL_PEAK_MIN = 19;

const todo = test.todoIf(liveTodoOff());

/**
 * The header's ordering clause, made CODE: bun runs this file's tests in
 * registration order, so Leg A always completes first — but a completed-and-RED
 * Leg A must also END the round, because Leg B's box-hour and key are spend
 * the round must not burn on a round that already failed its cheapest
 * falsifier. Set in Leg A's catch; Leg B checks it BEFORE preflight, so the
 * suppression costs nothing (no box, no key, no verb).
 */
let legAFailed = false;

/**
 * The python3 allocator staged as Leg A's QDS_PI_BIN. python3 is on the
 * image (tier1-harvest exec's it on a real box). It ignores pi's argv
 * entirely, prints its own VmRSS so the round can see the allocator's
 * baseline sit WELL under the bound before the loop crosses it (the
 * attribution guard: a kill during interpreter start would prove the bound
 * was ARMED, not that the staged allocation CROSSED it), touches 512 MiB of
 * anonymous memory in 16 MiB rounds with 200 ms pauses, and never exits 97
 * — check (b). The kernel kills it mid-round on the first failed charge;
 * the ALLOCATOR-ROUND lines stop there, and the gap is the evidence of when.
 */
const ALLOCATOR_PY = [
  "#!/usr/bin/python3",
  "import time",
  "",
  "def rss_kb():",
  "    try:",
  "        with open('/proc/self/status') as f:",
  "            for line in f:",
  "                if line.startswith('VmRSS'):",
  "                    return line.split()[1] + ' kB'",
  "    except Exception:",
  "        pass",
  "    return '?'",
  "",
  'print("ALLOCATOR-START VmRSS=" + rss_kb(), flush=True)',
  "# GROWING allocator: one NEW 16 MiB buffer per round, references kept so",
  "# every round stays resident. The first draft re-touched ONE 16 MiB",
  "# bytearray 32 times — measured live 2026-10-01: the leaf's memory.peak",
  "# flatlined at ~21 MiB (interpreter + the single buffer), the allocator",
  "# exited cleanly, and the run degraded instead of crossing. Round 8 is",
  "# the crossing (8 x 16 = 128 MiB, the manifest bound); the kernel kills",
  "# mid-round on the charge that fails, so ALLOCATOR-ROUND lines stop",
  "# there and the gap is the evidence of when.",
  "kept = []",
  "for rnd in range(32):",
  "    buf = bytearray(16 * 1024 * 1024)",
  "    for i in range(0, len(buf), 4096):",
  "        buf[i] = 1",
  "    kept.append(buf)",
  '    print("ALLOCATOR-ROUND %d VmRSS=%s" % (rnd, rss_kb()), flush=True)',
  "    time.sleep(0.2)",
  'print("ALLOCATOR-DONE", flush=True)',
  "",
].join("\n");

/**
 * Polls `fleet status` until the run's verdict is TERMINAL — "ok"/"not-ok"
 * — or the attempt budget dies. NOT `statusStateSettled`: that helper
 * returns the FIRST parseable row (it breaks on any non-"unknown" state,
 * "running" included), which is a single-read probe, not a settle poll —
 * measured live 2026-10-01: Leg A's first read landed mid-walk, the helper
 * returned "running", and the leg red'd on its own assertion while the
 * engine was still healthy. tier2-in-box-engine wrote its own loop for the
 * same reason. Tolerances mirror its posture: ≤2 verb failures, a 4-tick
 * unknown streak cap, and every seen state recorded.
 */
async function settleToTerminal(
  runId: string,
  recordsDir: string,
  evidence: Record<string, unknown>[],
): Promise<{ state: string; row: Record<string, unknown> }> {
  const settledStates = new Set(["ok", "not-ok"]); // live-mirror: AC5 terminal vocabulary (status.ts InBoxState)
  const seen: string[] = [];
  let exitFailures = 0;
  let unknownStreak = 0;
  let state = "";
  let row: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
    try {
      const res = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: STATUS_VERB_TIMEOUT_MS,
      });
      if (res.exitCode !== 0) {
        exitFailures += 1;
        seen.push(`(exit ${String(res.exitCode)})`);
        if (exitFailures > 2) break;
      } else {
        row = lastJsonLine<Record<string, unknown>>(res.stdout);
        state = typeof row.state === "string" ? row.state : "";
        seen.push(state === "" ? "(unparseable)" : state);
        if (state === "unknown") {
          unknownStreak += 1;
          if (unknownStreak >= 4) break;
        } else {
          unknownStreak = 0;
        }
        if (settledStates.has(state)) break;
      }
    } catch (e) {
      exitFailures += 1;
      seen.push(`(threw: ${(e as Error).message.slice(0, 80)})`);
      if (exitFailures > 2) break;
    }
    if (attempt < STATUS_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_WAIT_MS));
  }
  evidence.push({ phase: "status-poll", finalState: state, seen });
  return { state, row };
}

/** The journal's resident block, as DF3.3/DF3.6b shape it. */
interface ResidentBlock {
  status?: string;
  exitStatus?: string | null;
  spendMicros?: number;
  tripwires?: Array<{ runId?: string; requestId?: string; cause?: string; phase?: string; detail?: string }>;
}

/** Crash-path id holder: dispatch may fail AFTER a box exists, and the
 *  finally needs the ids the partial streams carry (tier2's L1 fix). */
interface DispatchIds {
  runId: string;
  vmName: string;
}

/** Reads the box's kernel release and whether memory.peak exists on it (check (c)). */
async function readKernel(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  evidence: Record<string, unknown>[],
): Promise<{ release: string; peakAvailable: boolean }> {
  const probe = await driver.execTimed(
    vmName,
    // `cat`, not `test -f`: proving the file answers beats proving it
    // exists, and the value doubles as evidence. Probed at a NON-ROOT
    // memcg: measured live 2026-10-01 on kernel 6.12.93, the ROOT cgroup
    // exposes no memory.peak while per-cgroup leaves read fine (the leaf's
    // own rssPeakBytes came back 21155840 in the same round) — probing the
    // root would report a missing measurement that the leaves do have.
    ["sh", "-c", "uname -r; cat /sys/fs/cgroup/system.slice/memory.peak 2>/dev/null || echo NO-PEAK"],
    30_000,
  );
  const release = probe.stdout.trim().split("\n")[0]?.trim() ?? "";
  const peakAvailable = !probe.stdout.includes("NO-PEAK");
  evidence.push({ phase: "kernel-probe", release, peakAvailable, rawTail: redactSecrets(probe.stdout.trim().slice(0, 200)) });
  expect(release).not.toBe("");
  const parts = release.split(".").map((p) => Number.parseInt(p, 10));
  const maj = parts[0] ?? 0;
  const min = parts[1] ?? 0;
  expect(maj).toBeGreaterThanOrEqual(KERNEL_PEAK_MAJ);
  if (maj === KERNEL_PEAK_MAJ) {
    expect(min).toBeGreaterThanOrEqual(KERNEL_PEAK_MIN);
  }
  return { release, peakAvailable };
}

/** Dispatches one leg's brief; writes recovered ids into `ids` BEFORE any
 *  expect so the finally can destroy a box the verb left behind. */
async function dispatchLeg(
  evidence: Record<string, unknown>[],
  repoUrl: string,
  sha: string,
  manifestPath: string,
  workspace: string,
  recordsDir: string,
  ids: DispatchIds,
): Promise<void> {
  const briefPath = join(workspace, "brief.json");
  writeFileSync(
    briefPath,
    JSON.stringify({
      repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
      issueId: 46,
      commitSha: sha,
      manifestPath,
      repoUrl,
    }),
  );
  evidence.push({ phase: "setup", ok: true, capMicroUsd: CAP_MICRO_USD, manifestPath });
  let dispatchOut = "";
  let dispatchErr = "";
  const dispatch = await runFleet(
    ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
    { cwd: REPO_ROOT, timeoutMs: DISPATCH_TIMEOUT_MS },
  ).catch((e: unknown) => {
    // The verb's ceiling REJECTS with a real box already billing (tier2 L1
    // fix): recover the partial streams so the finally can name the box.
    const partial = fleetPartialOutput(e);
    dispatchOut = partial.stdout;
    dispatchErr = partial.stderr;
    const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
    if (recovered.runId !== "") ids.runId = recovered.runId;
    if (recovered.vmName !== "") ids.vmName = recovered.vmName;
    evidence.push({
      phase: "dispatch-verb-timeout",
      error: (e as Error).message,
      recoveredIds: recovered,
      recoveredBytes: partial.stdout.length + partial.stderr.length,
    });
    throw e;
  });
  dispatchOut = dispatch.stdout;
  dispatchErr = dispatch.stderr;
  const preAck = recoverDispatchIds(dispatchOut, dispatchErr);
  if (preAck.runId !== "") ids.runId = preAck.runId;
  if (preAck.vmName !== "") ids.vmName = preAck.vmName;
  evidence.push({
    phase: "dispatch-verb",
    exitCode: dispatch.exitCode,
    stdoutTail: redactSecrets(dispatchOut.trim().slice(-400)),
    stderrTail: redactSecrets(dispatchErr.trim().slice(-600)),
  });
  expect(dispatch.exitCode).toBe(0);
  const ack = JSON.parse(
    dispatchOut.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}",
  ) as { runId?: string; vmName?: string; state?: string };
  expect(ack.runId).toBeDefined();
  expect(ack.vmName).toBeDefined();
  expect(ack.state).toBe("ready"); // live-mirror: dispatch ack state vocabulary (dispatch.ts success ack)
  if (ids.runId !== "") expect(ack.runId).toBe(ids.runId);
  ids.runId = ack.runId as string;
  ids.vmName = ack.vmName as string;
  evidence.push({ phase: "ack", runId: ids.runId, vmName: ids.vmName });
}

/**
 * Samples the run unit's resident leaves over real kernfs until `until`
 * settles: leaf existence, cgroup.procs membership (check (a)),
 * memory.peak + memory.events, and — once — one deliberate bad-pid
 * placement against the live leaf (check (e)). The leg unit directory is
 * the system slice path for THIS run's unit; `resident.*` is the shipped
 * leaf name (resident.<runId>.<seq>, ensureDelegatedSubtree's sibling) and
 * never matches the `supervisor` split leaf.
 */
async function sampleLeaves(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  runId: string,
  until: Promise<unknown>,
  evidence: Record<string, unknown>[],
): Promise<{ samples: number; sawLiveLeaf: boolean; sawProcs: boolean; rejectionProbe?: string }> {
  const unitName = runUnitName(runId);
  // The unit's cgroup dir is DISCOVERED per tick, not assumed: measured live
  // 2026-10-01, this unit's slice on the box is `system-qds\x2drun.slice` —
  // NOT the `system.slice` default a reader would assume — and nothing in
  // the repo sets `Slice=` (image-side systemd config). `find` over the
  // cgroupfs tree (bounded at depth 6 — one nesting level more than the
  // measured layout, so an image-side slice change answers FIND-EMPTY, not
  // a false NO-UNIT) resolves the real root wherever the image puts it; a
  // missing unit dir answers NO-UNIT and the tick is recorded like any
  // other.
  const findUnit = `ud=$(find /sys/fs/cgroup -maxdepth 6 -type d -name ${shellQuote(unitName)} 2>/dev/null | head -1); `;
  const samples: Record<string, unknown>[] = [];
  let sawLiveLeaf = false;
  let sawProcs = false;
  let rejectionProbe: string | undefined;
  let probeAttempted = false;
  const deadline = Date.now() + LEAF_POLL_MAX_MS;
  let done = false;
  void until.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done && Date.now() < deadline) {
    try {
      // The bad-pid probe (check (e)) is built per tick and LATCHED OFF in
      // TypeScript after its first execution — the old script carried it on
      // every tick, so only its RECORDING was once-per-window while the
      // write itself re-fired ~hundreds of times, and on a box where
      // kernel.pid_max had actually allocated 4194304, each re-fire would
      // migrate that LIVE process into the OOM-armed leaf. Once is the
      // contract: the header says ONE placement, and now the shell agrees.
      // The errno capture (`err=$(echo … 2>&1 > file)` — stderr into the
      // substitution, stdout into the file) records the KERNEL's answer
      // beside the boolean: measured live 2026-10-01, the old `2>&1` after
      // `>` routed the write's diagnostic INTO cgroup.procs's failure, so
      // the evidence carried only the literal fallback "PROBE-REJECTED" and
      // the ledger's "ESRCH-variant" wording was asserted, not evidenced.
      const probeSeg = probeAttempted
        ? "true; " // latched off — `:` would lex against the following `done` (round-2 verify catch)
        : `echo "REJECT-PROBE"; err=$(echo 4194304 2>&1 > "$d/cgroup.procs") && echo PROBE-ACCEPTED || echo "PROBE-REJECTED \${err:-?}"; `;
      const script =
        `${findUnit}[ -n "$ud" ] || { echo NO-UNIT; exit 0; }; found=0; for d in "$ud"/resident.*; do [ -d "$d" ] || continue; found=1; echo "LEAF $d"; echo "PROCS"; cat "$d/cgroup.procs" 2>&1; echo "PEAK"; cat "$d/memory.peak" 2>&1; echo "EVENTS"; cat "$d/memory.events" 2>&1; ${probeSeg}done; [ "$found" = 1 ] || echo NO-LEAF`;
      const res = await driver.execTimed(vmName, ["sh", "-c", script], LEAF_POLL_EXEC_DEADLINE_MS);
      const out = res.stdout;
      if (out.includes("LEAF ")) {
        sawLiveLeaf = true;
        if (/PROCS\n[0-9]/.test(out)) sawProcs = true;
        if (!probeAttempted && out.includes("REJECT-PROBE")) {
          probeAttempted = true;
          // Real kernfs ESRCHes a nonexistent pid; the fs-level fake
          // accepts any bytes. Either answer is RECORDED; the expected one
          // is a rejection (check (e)) — the classification is in evidence.
          rejectionProbe = out.includes("PROBE-ACCEPTED")
            ? "accepted (unexpected on real kernfs)"
            : `rejected: ${out.split("REJECT-PROBE\n")[1]?.split("\n")[0] ?? "?"}`;
          evidence.push({ phase: "rejection-probe", outcome: rejectionProbe });
        }
      }
      samples.push({ t: Date.now(), leaf: out.includes("LEAF "), raw: redactSecrets(out.slice(0, 1500)) });
    } catch (e) {
      // One cold multiplex must not end the window (E1-10 shape): record
      // and continue — absence of samples is the failure the assertions
      // name, not a throw the sampler manufactures.
      samples.push({ t: Date.now(), error: (e as Error).message });
    }
    if (!done) await new Promise((r) => setTimeout(r, LEAF_POLL_INTERVAL_MS));
  }
  evidence.push({
    phase: "leaf-samples",
    count: samples.length,
    sawLiveLeaf,
    sawProcs,
    // Raw ticks (bounded): a sampler that saw nothing must say WHAT it saw —
    // all-error ticks and genuinely-absent directories look identical in a
    // count. Measured live 2026-10-01 across two runs where sawLiveLeaf was
    // false with 10 ticks: without these bytes the next debugger is blind.
    // The first 4 ticks AND every leaf-bearing or erroring tick are kept —
    // a first-12 window discarded exactly the live-leaf ticks when the leaf
    // appeared late, which is the blindness this field exists to prevent.
    ticks: [...samples.slice(0, 4), ...samples.filter((s) => s.leaf || s.error).slice(0, 12)].map((s) =>
      JSON.stringify(s).slice(0, 220),
    ),
    ...(rejectionProbe === undefined ? { note: "no live-leaf window hit — the rejection residual is stated, not closed" } : { rejectionProbe }),
  });
  return { samples: samples.length, sawLiveLeaf, sawProcs, rejectionProbe };
}

/** Reads the run journal off the box and parses its resident block. */
async function readJournal(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  home: string,
  runId: string,
  evidence: Record<string, unknown>[],
): Promise<{ ok?: boolean; resident?: ResidentBlock; phases?: unknown }> {
  const journalBoxPath = `${home}/${runId}.journal.jsonl`; // live-mirror: $HOME/<runId>.journal.jsonl (harvest.ts source list, tier2-in-box-engine step 8)
  const read = await readBoxFile(driver, vmName, journalBoxPath, 30_000);
  expect(read.kind).toBe("content"); // live-mirror: BoxFileRead kind union (src/providers/exedev/transport.ts:128)
  const raw = (read as { kind: "content"; content: string }).content;
  evidence.push({ phase: "journal-raw-bytes", bytes: raw.length });
  return JSON.parse(raw) as { ok?: boolean; resident?: ResidentBlock; phases?: unknown };
}

/** Pulls the fd-2 `resident_cgroup` + `[resident]` lines off journald. */
async function readFd2Lines(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  runId: string,
  evidence: Record<string, unknown>[],
): Promise<{ cgroupLines: Record<string, unknown>[]; warns: string[] }> {
  const res = await driver.execTimed(
    vmName,
    [
      "sh",
      "-c",
      `journalctl -u ${shellQuote(runUnitName(runId))} --no-pager -o cat 2>&1 | grep -E 'resident_cgroup|\\[resident\\]' | tail -40`,
    ],
    30_000,
  );
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const cgroupLines: Record<string, unknown>[] = [];
  const warns: string[] = [];
  for (const line of lines) {
    if (line.includes("resident_cgroup")) {
      try {
        cgroupLines.push(JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
      } catch {
        warns.push(redactSecrets(line)); // unparseable — keep as raw warn rather than lose it
      }
    } else {
      warns.push(redactSecrets(line));
    }
  }
  evidence.push({ phase: "fd2-lines", cgroupLineCount: cgroupLines.length, warnCount: warns.length, cgroupLines, warns });
  return { cgroupLines, warns };
}

/** Post-run leaf absence: the kill's reap landed inside the shipped bounded
 *  EBUSY budget on THIS box, or removeLeaf threw and the journal would not
 *  read the way the assertions above already proved it does. */
async function assertLeavesGone(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  runId: string,
  evidence: Record<string, unknown>[],
): Promise<void> {
  // Same discovery rule as the sampler: the unit's slice is image-side
  // config this file must not assume (measured 2026-10-01:
  // system-qds\x2drun.slice, not system.slice).
  const res = await driver.execTimed(
    vmName,
    [
      "sh",
      "-c",
      `ud=$(find /sys/fs/cgroup -maxdepth 6 -type d -name ${shellQuote(runUnitName(runId))} 2>/dev/null | head -1); [ -n "$ud" ] || { echo NO-UNIT; exit 0; }; ls -d "$ud"/resident.* 2>/dev/null | wc -l`,
    ],
    30_000,
  );
  evidence.push({ phase: "leaf-removed", count: res.stdout.trim() });
  // "0" = unit dir present, no leaves. "NO-UNIT" = systemd already reaped
  // the unit's cgroup (inactive) — a fortiori no leaves. Both pass; anything
  // else names leaves that survived their own kill (check (d) failing).
  expect(["0", "NO-UNIT"]).toContain(res.stdout.trim());
  // The layout probe: what the slice ACTUALLY holds for this unit — recorded
  // so a sampler that missed the window can be told apart from a cgroup
  // hierarchy that does not look like the sampler's assumption (systemd may
  // also reap the unit's directory once the unit is inactive, which is the
  // benign reading of an empty listing here).
  const layoutProbe = "ls /sys/fs/cgroup/ 2>/dev/null | grep -i qds | head -5; mount | grep -m1 cgroup";
  const layout = await driver.execTimed(vmName, ["sh", "-c", layoutProbe], 30_000);
  evidence.push({ phase: "cgroup-layout", raw: redactSecrets(layout.stdout.slice(0, 500)) });
}

/** The `finally` every leg shares — never throws; returns the problem list
 *  for `settleRun`. Order mirrors tier2-in-box-engine's cleanup. */
async function legFinally(args: {
  driver: Awaited<ReturnType<typeof preflight>>["driver"];
  ids: DispatchIds;
  recordsDir: string;
  workspace: string;
  hashesBefore: Set<string>;
  evidence: Record<string, unknown>[];
  destroyFailures: string[];
  hadFailure: boolean;
}): Promise<string[]> {
  const { driver, ids, recordsDir, workspace, hashesBefore, evidence, destroyFailures, hadFailure } = args;
  if (ids.vmName !== "") {
    const torn = await teardownQuietly(
      ["teardown", ids.runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"],
      { timeoutMs: 180_000 },
      evidence,
      { at: "df36b-cleanup", runId: ids.runId },
    );
    if (!torn.ok) destroyFailures.push(`teardown:${ids.vmName}`);
    const destroyed = await destroyQuietly(driver, ids.vmName, evidence);
    if (!destroyed.ok) destroyFailures.push(`destroy:${ids.vmName}`);
    await awaitBoxAbsent(driver, ids.vmName, evidence, { maxAttempts: 6 });
  }
  if (ids.runId !== "") {
    // The sibling-tier fallback (tier1-approval-gate, tier2-self-compact,
    // tier5-gate-steering all carry it): the teardown verb revokes the run
    // key on the green path, but when that verb failed above — or the run
    // record half-landed — `revokeQuietly` is the record-backed second
    // attempt. It answers "none" when no key was ever minted or the key is
    // already gone, and never throws (#189). Without it, a failed teardown
    // leaves a LIVE key that `keyLeakProblems` below only DETECTS.
    await revokeQuietly(driver, new RunRecordStore({ dir: recordsDir }), ids.runId, evidence);
  }
  const leftovers = await fleetLeftovers(driver, ids.vmName === "" ? [] : [ids.vmName], evidence, { maxAttempts: 5 });
  const keyProblems = await keyLeakProblems(hashesBefore, { driver, runIds: ids.runId === "" ? [] : [ids.runId] }, evidence);
  const cleanup = [...fleetCleanupProblems(destroyFailures, leftovers.owned, evidence), ...keyProblems];
  // RED rounds keep the workspace for forensics (tier2 posture).
  if (!hadFailure) {
    rmSync(workspace, { recursive: true, force: true });
  } else {
    evidence.push({ phase: "workspace-kept", workspace, reason: "RED round — forensics kept" });
  }
  return cleanup;
}

/** Shared post-settle read: journal + fd-2, recorded once per leg. */
async function readRunOutputs(
  driver: Awaited<ReturnType<typeof preflight>>["driver"],
  vmName: string,
  home: string,
  runId: string,
  evidence: Record<string, unknown>[],
): Promise<{
  journal: { ok?: boolean; resident?: ResidentBlock; phases?: unknown };
  fd2: { cgroupLines: Record<string, unknown>[]; warns: string[] };
}> {
  const journal = await readJournal(driver, vmName, home, runId, evidence);
  const fd2 = await readFd2Lines(driver, vmName, runId, evidence);
  return { journal, fd2 };
}

describe("DF3.6b live — the kernel-enforced resident memory bound, in-box", () => {
  todo(
    "Leg A — the crossing: the kernel OOM-kills the allocator's leaf; the run continues deterministic",
    async () => {
      liveGate("2");
      const ctx = await preflight("2");
      const evidence: Record<string, unknown>[] = [];
      let workspace = "";
      const ids: DispatchIds = { runId: "", vmName: "" };
      let outcome = "pass";
      let failure: unknown;
      const destroyFailures: string[] = [];
      const hashesBefore = await listedKeyHashes();
      let kernel: { release: string; peakAvailable: boolean } | undefined;
      let sampler: Awaited<ReturnType<typeof sampleLeaves>> | undefined;
      let outputs: Awaited<ReturnType<typeof readRunOutputs>> | undefined;
      try {
        workspace = tmpWorkspace("df36b-la");
        const recordsDir = join(workspace, "runs");
        mkdirSync(recordsDir, { recursive: true });
        // The operator's cost config sits BESIDE the records dir — without
        // it admission falls back to the $5 default cap (tier2 posture, R4).
        writeFileSync(
          join(workspace, "cost-config.json"),
          JSON.stringify({ defaultCapMicroUsd: CAP_MICRO_USD, boxHourRateMicroUsd: BOX_HOUR_RATE_MICRO_USD }),
        );

        await dispatchLeg(evidence, ctx.repoUrl, ctx.sha, LEG_A_MANIFEST_PATH, workspace, recordsDir, ids);
        const home = await boxHome(ctx.driver, ids.vmName);

        // Check (c) FIRST on the paid box: below 5.19 the peak conjunct is
        // skipped (ruling 8) and the sampler asserts no peak floors.
        kernel = await readKernel(ctx.driver, ids.vmName, evidence);

        // Stage the allocator as QDS_PI_BIN: write the file, then append the
        // env line to the unit's EnvironmentFile — BEFORE `fleet run` loads
        // the unit. The .env is delivered by dispatch with the run key at
        // mode 600; `>>` keeps both.
        const allocPath = `${home}/app/leg-a-allocator.py`;
        const b64 = Buffer.from(ALLOCATOR_PY, "utf8").toString("base64");
        const staged = await ctx.driver.execTimed(
          ids.vmName,
          [
            "sh",
            "-c",
            // live-mirror: $HOME/app/.env (KEY_ENV_FILE, credentials.ts/fill.ts — the unit's EnvironmentFile)
            `umask 077 && mkdir -p app && echo ${b64} | base64 -d > ${shellQuote(allocPath)} && chmod 700 ${shellQuote(allocPath)} && printf 'QDS_PI_BIN=%s\\n' ${shellQuote(allocPath)} >> "$HOME/app/.env" && tail -1 "$HOME/app/.env" | sed 's/=.*/=<set>/'`,
          ],
          30_000,
        );
        expect(staged.exitCode).toBe(0);
        expect(staged.stdout).toContain("QDS_PI_BIN"); // the line landed (value redacted in the same breath)
        evidence.push({ phase: "allocator-staged", path: allocPath });

        // The settle poll and the leaf sampler BOTH arm before the run verb:
        // measured live 2026-10-01 (run qds-20261001-f1de15), the whole
        // crossing is over in ~10 s — the first status poll already read
        // "ok" — so a sampler started after the verb sampled 2 ticks of an
        // already-settled run and missed the leaf entirely. Pre-arming both
        // covers the engine's very first seconds; ticks before the unit
        // exists answer NO-LEAF and are recorded, not skipped.
        const settle = settleToTerminal(ids.runId, recordsDir, evidence);
        const sampled = sampleLeaves(ctx.driver, ids.vmName, ids.runId, settle, evidence);

        const start = await runFleet(["run", ids.runId, "--driver", "exedev", "--dir", recordsDir], {
          cwd: REPO_ROOT,
          timeoutMs: RUN_VERB_TIMEOUT_MS,
        });
        evidence.push({
          phase: "run-verb",
          exitCode: start.exitCode,
          stdout: redactSecrets(start.stdout.trim().slice(0, 300)),
          stderrTail: redactSecrets(start.stderr.trim().slice(-400)),
        });
        expect(start.exitCode).toBe(0);
        expect(start.stdout).toContain(`started: ${ids.runId}`);

        const settled = await settle;
        sampler = await sampled;
        evidence.push({ phase: "settled", state: settled.state });
        // AC1's deterministic-completion clause asserted POSITIVELY: the
        // header, story, and sprint row all say the run "settled ok", and a
        // future regression landing "not-ok" beside an intact phase list
        // would otherwise pass this leg green.
        expect(settled.state).toBe("ok"); // live-mirror: status.ts InBoxState settled vocabulary

        // Post-settle reads BEFORE teardown.
        outputs = await readRunOutputs(ctx.driver, ids.vmName, home, ids.runId, evidence);
        const { journal, fd2 } = outputs;

        // THE journal observable (AC1): stopped + overflow beside each other.
        expect(journal.resident?.status).toBe("stopped"); // live-mirror: ResidentStatus union member (src/phase-engine/steering.ts:240) — AC5's latch write
        expect(journal.resident?.exitStatus).toBe("overflow"); // live-mirror: EXIT_STATUSES member (cli-anything/src/types.ts:99-105) — AC1's make-or-break write
        const kill = journal.resident?.tripwires?.find((t) => t.cause === "watchdog_kill");
        expect(kill).toBeDefined(); // live-mirror: ResidentTripwire["cause"] member (src/phase-engine/steering.ts:244)
        expect(kill?.detail ?? "").toContain("memory.peak");
        expect(kill?.detail ?? "").toContain("residentRssBytes");
        evidence.push({ phase: "tripwire", row: kill });

        // The fleet measurement line: oomKilled + the peak floor (ruling 8) +
        // the bound echo + teardown timing (check (d)). The peak conjunct is
        // UNCONDITIONAL now: `readKernel` already refused any kernel below
        // 5.19, so a `peakAvailable:false` here is a broken probe path on a
        // 5.19+ box — not an old kernel the ruling's skip was written for —
        // and silently skipping the make-or-break floor on exactly the box
        // whose kernfs reads are broken is the wrong fail direction.
        const cg = fd2.cgroupLines.find((l) => l.oomKilled === true);
        expect(cg).toBeDefined(); // live-mirror: resident_cgroup fd-2 line (src/fleet/resident.ts warn chokepoint — ruling 7)
        expect(cg?.residentRssBytes).toBe(LEG_A_BOUND_BYTES);
        expect(kernel.peakAvailable).toBeTrue();
        expect(Number(cg?.rssPeakBytes)).toBeGreaterThanOrEqual(LEG_A_BOUND_BYTES - OOM_PEAK_SLACK_BYTES);
        expect(Number(cg?.cgroup_teardown_ms)).toBeGreaterThan(0);
        evidence.push({ phase: "resident-cgroup-leg-a", line: cg, kernel: kernel.release });

        // The leaf is GONE (check (d)).
        await assertLeavesGone(ctx.driver, ids.vmName, ids.runId, evidence);

        // Placement TOOK (check (a)): the sampler saw a live leaf carrying
        // at least one pid — membership read back from real kernfs.
        expect(sampler.sawLiveLeaf).toBeTrue();
        expect(sampler.sawProcs).toBeTrue();

        // No misclassification (check (b) + AC4's inverse): no exit-97
        // refusal, no arming refusal, and exactly ONE cgroup line — the
        // kill. (`allowed` is `!oomKilled` by the line's own construction,
        // so the kill line reads allowed:false — that is the OOM arm, not a
        // breach; an UNENFORCEABLE path would show oomKilled:false with a
        // 0 peak, or an arming refusal, and neither may exist here.)
        const allWarns = fd2.warns.join("\n");
        expect(allWarns).not.toContain("rss_unenforceable");
        expect(allWarns).not.toContain("resident_disabled");
        expect(allWarns).not.toContain("PlacementRefusedError");
        const killLines = fd2.cgroupLines.filter((l) => l.oomKilled === true);
        expect(killLines.length).toBe(1);
        // …and exactly ONE line TOTAL, allowed or not: the story cites the
        // stop latch's refusal of the post-kill second solicitation as part
        // of what the round proved, and a second ALLOWED line there would
        // have been the latch failing while every kill-shaped assert above
        // still passed. Measured green shape x2ikk3: 1 line.
        expect(fd2.cgroupLines.length).toBe(1);
        const unenforceable = fd2.cgroupLines.filter(
          (l) => l.oomKilled === false && Number(l.rssPeakBytes) === 0,
        );
        expect(unenforceable.length).toBe(0);

        // Deterministic completion (AC1's tail): both phases ran.
        const phaseNames = JSON.stringify(journal.phases ?? []);
        expect(phaseNames).toContain("prep");
        expect(phaseNames).toContain("settle");

        // The allocator, not pi, was the victim — attributed by ARITHMETIC
        // rather than by output markers: the allocator's stdout is collected
        // by the engine's bounded pipe and never reaches journald (measured
        // live 2026-10-01, run g6svtz — the grep came back empty while the
        // kill had fired), so the marker assert's premise was wrong. What
        // cannot lie: the leaf's peak. A bare python3 interpreter sits at
        // ~21 MiB (measured, run d8fbe4's 21,155,840 B read); only the
        // staged 16 MiB-per-round growth reaches the bound. A peak ≥ 64 MiB
        // — 3× the interpreter, ½ the bound — is therefore the staged
        // allocation's signature, and the kill line above already pinned it
        // at the bound itself.
        const killPeak = Number(cg?.rssPeakBytes ?? 0);
        evidence.push({ phase: "allocator-attribution", killPeakBytes: killPeak, interpreterBaselineBytes: 21_155_840 });
        expect(killPeak).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      } catch (e) {
        outcome = "fail";
        failure = e;
        legAFailed = true;
      } finally {
        const problems = await legFinally({
          driver: ctx.driver,
          ids,
          recordsDir: join(workspace, "runs"),
          workspace,
          hashesBefore,
          evidence,
          destroyFailures,
          hadFailure: failure !== undefined,
        });
        await writeEvidenceQuietly(
          "DF3.6b-LA",
          "df36b-leg-a-crossing",
          {
            test: "DF3.6b Leg A",
            outcome,
            runId: ids.runId,
            kernel: kernel?.release,
            capMicroUsd: CAP_MICRO_USD,
            evidenceDir: EVIDENCE_DIR,
            placement: sampler ?? "(sampler never ran)",
            phases: evidence,
            failure:
              failure === undefined
                ? undefined
                : redactSecrets(failure instanceof Error ? failure.message : String(failure)).slice(0, 400), // the one artifact a RED round exists to produce — WHY — in the file itself
          },
          // The WRITE-failure collection, not destroyFailures: this helper
          // pushes "the evidence write FAILED" into the array it is given
          // (the F11 scrub-refusal path), and `problems` is the list
          // settleRun is about to consume. destroyFailures was already
          // folded into problems by legFinally above, so a failure pushed
          // there now would ship a green, file-less round silently — the
          // exact outcome F11 exists to prevent. (CodeRabbit, PR #399.)
          problems,
        );
        await settleRun(failure, problems);
      }
    },
    // Budget audit, priced at DECLARED CEILINGS (tier2-in-box-engine rule):
    // whoever adds a leg, a poll tick class, or a cleanup step re-adds it here.
    // (Recomputed 2026-10-01 review round — the sampler line had priced a
    // shape the loop cannot take: the LEAF_POLL_MAX_MS deadline bounds the
    // window itself, so worst wall is window + one exec, not ticks × exec.)
    //
    //   preflight whoami                          120 s
    //   pre-try listedKeyHashes                   240 s
    //   dispatch verb                             900 s
    //   boxHome                                   120 s
    //   kernel probe                               30 s
    //   allocator stage                            30 s
    //   run verb                                  180 s
    //   status poll 10 × (60 verb + 10 wait)      700 s
    //   leaf sampler: window 500 s + one 10 s exec 510 s
    //   journal + fd-2 + leaves-gone ×2 + layout  120 s
    //   finally: teardown 180 + destroy 600 code-worst
    //            + awaitBoxAbsent 6 × (120 + 8)   768 s
    //            + fleetLeftovers 5 × (120 + 8)   640 s
    //            + revokeQuietly (verb-class)     120 s
    //            + keyLeakProblems                360 s
    //   evidence + workspace rm                    10 s
    //                                            ─────────
    //                                            ≈ 5 630 s
    //
    // Hence 9 000 s — deliberately WELL above the sum: the destroy/teardown
    // ceilings are code-worst, not measured, and this ceiling exists to make
    // unreachable the ONE abort (bun test timeout) that would skip the
    // finally and leak a box. Every inner ceiling firing rejects into the
    // catch and the finally still runs. Fail-safe direction: up.
    9_000_000,
  );

  todo(
    "Leg B — the attachment: real pi runs inside real leaves under the production default; the baseline is measured",
    async () => {
      liveGate("2");
      // The header's ordering clause, ENFORCED (bun runs these in
      // registration order, but a completed-and-RED Leg A is not a reason to
      // spend Leg B's box-hour + key): suppress BEFORE preflight mints
      // anything, with a loud error — a silently-passing leg would read as a
      // green attachment proof in the round list.
      if (legAFailed) {
        throw new Error(
          "Leg A failed earlier in this round — Leg B suppressed before provisioning (the header's ordering clause). Fix Leg A, then re-run the round.",
        );
      }
      const ctx = await preflight("2");
      const evidence: Record<string, unknown>[] = [];
      let workspace = "";
      const ids: DispatchIds = { runId: "", vmName: "" };
      let outcome = "pass";
      let failure: unknown;
      const destroyFailures: string[] = [];
      const hashesBefore = await listedKeyHashes();
      let kernel: { release: string; peakAvailable: boolean } | undefined;
      let outputs: Awaited<ReturnType<typeof readRunOutputs>> | undefined;
      try {
        workspace = tmpWorkspace("df36b-lb");
        const recordsDir = join(workspace, "runs");
        mkdirSync(recordsDir, { recursive: true });
        writeFileSync(
          join(workspace, "cost-config.json"),
          JSON.stringify({ defaultCapMicroUsd: CAP_MICRO_USD, boxHourRateMicroUsd: BOX_HOUR_RATE_MICRO_USD }),
        );

        await dispatchLeg(evidence, ctx.repoUrl, ctx.sha, LEG_B_MANIFEST_PATH, workspace, recordsDir, ids);
        const home = await boxHome(ctx.driver, ids.vmName);
        kernel = await readKernel(ctx.driver, ids.vmName, evidence);
        // The baseline item REQUIRES memory.peak: a 0 reading is MEASUREMENT
        // FAILED (story DoD, round 20) — on a pre-5.19 box the leg stops
        // here, loudly, before a solicitation is paid for and unreadable.
        expect(kernel.peakAvailable).toBeTrue();

        // NO QDS_PI_BIN line, NO bound field on the manifest: real pi arms
        // under the production default the front door injects.
        const start = await runFleet(["run", ids.runId, "--driver", "exedev", "--dir", recordsDir], {
          cwd: REPO_ROOT,
          timeoutMs: RUN_VERB_TIMEOUT_MS,
        });
        evidence.push({
          phase: "run-verb",
          exitCode: start.exitCode,
          stdout: redactSecrets(start.stdout.trim().slice(0, 300)),
        });
        expect(start.exitCode).toBe(0);
        expect(start.stdout).toContain(`started: ${ids.runId}`);
        const settled = await settleToTerminal(ids.runId, recordsDir, evidence);
        evidence.push({ phase: "settled", state: settled.state });
        expect(["ok", "not-ok"]).toContain(settled.state); // live-mirror: AC5 settled vocabulary (status.ts InBoxState)

        outputs = await readRunOutputs(ctx.driver, ids.vmName, home, ids.runId, evidence);
        const { journal, fd2 } = outputs;

        // A journal WITHOUT a resident block would vacuate every negative
        // assert below (`undefined !== "stopped"`, `?? null !== "overflow"`,
        // `?? 0 === 0`) — a journal-write regression shipping as a green
        // attachment proof. The block must EXIST before it is inspected.
        expect(journal.resident).toBeDefined();

        // Attachment, not crossing: the resident armed and stayed healthy —
        // no kill, no tripwire, no breach, and NO "overflow" — the one
        // value only the OOM arm writes. ("success" here is the run-down
        // refresh's process-probe word for a clean resident exit — edit
        // (vii) fills it when the engine wrote nothing; measured live
        // 2026-10-01, run 7317e3, where the first draft wrongly expected
        // null and the shipped refresh had already spoken.)
        expect(journal.resident?.status).not.toBe("stopped"); // live-mirror: ResidentStatus union (src/phase-engine/steering.ts:240) — Leg B asserts absence of AC5's latch
        expect(journal.resident?.exitStatus ?? null).not.toBe("overflow"); // live-mirror: EXIT_STATUSES member (cli-anything/src/types.ts:99-105) — only the OOM arm writes it
        expect(journal.resident?.tripwires?.length ?? 0).toBe(0);
        const kills = fd2.cgroupLines.filter((l) => l.oomKilled === true);
        expect(kills.length).toBe(0);

        // Every armed call ran inside a real leaf and left it removed — and
        // the leg's own claim is TWO solicits (run_start + run_end): exactly
        // two lines, not "at least one" (a refused-then-retried shape would
        // be a different round than the DoD tick describes). Measured green
        // shape naql0w: 2 lines, seqs [1, 2].
        const cgLines = fd2.cgroupLines;
        expect(cgLines.length).toBe(2);
        for (const l of cgLines) {
          expect(l.allowed).toBe(true);
          // The ARMED BOUND is the leg's headline claim: the front door
          // injected the SHIPPED default. `rssPeakBytes < bound` alone
          // would pass any default drift downward; this pins the value the
          // pin contract shipped.
          expect(l.residentRssBytes).toBe(PROVISIONAL_DEFAULT_BYTES);
          expect(Number(l.cgroup_teardown_ms)).toBeGreaterThan(0);
          expect(Number(l.rssPeakBytes)).toBeLessThan(PROVISIONAL_DEFAULT_BYTES);
        }

        // THE BASELINE (the measurement neither the ADR nor the 2026-08-31
        // probe ever took): the FIRST armed solicitation's peak — seq 1, so
        // an unparseable first line silently demoting the baseline to the
        // second solicitation's peak is caught, not absorbed.
        expect(cgLines[0]?.seq).toBe(1);
        const baseline = Number(cgLines[0]?.rssPeakBytes);
        expect(baseline).toBeGreaterThan(0); // 0 on a 5.19+ kernel = MEASUREMENT FAILED
        const falsifiers = {
          baselineBytes: baseline,
          baselineMib: Number((baseline / (1024 * 1024)).toFixed(1)),
          fixtureInvalid: baseline >= BASELINE_FIXTURE_FALSIFIER_BYTES,
          defaultMustReset: baseline >= BASELINE_DEFAULT_FALSIFIER_BYTES,
          bound: cgLines[0]?.residentRssBytes,
        };
        // The story's ship-gate, ENFORCED: baseline ≥ 256 MiB means the
        // shipped default has under one doubling of headroom and "must be
        // re-set before this story ships" (DoD). Recording the boolean let a
        // falsified default go green; the leg now reds and names the re-set.
        expect(falsifiers.defaultMustReset).toBeFalse();
        evidence.push({ phase: "baseline", ...falsifiers });
        // Surface the falsifiers to the operator in the round output too —
        // G4 of the ledger consumes them.
        process.stderr.write(
          `[DF3.6b-LB] pi baseline = ${falsifiers.baselineMib} MiB — fixtureInvalid=${falsifiers.fixtureInvalid} defaultMustReset=${falsifiers.defaultMustReset}\n`,
        );

        // Leaves gone after every call (check (d) on the attachment leg).
        await assertLeavesGone(ctx.driver, ids.vmName, ids.runId, evidence);

        // No misclassification on the healthy leg either.
        const allWarns = fd2.warns.join("\n");
        expect(allWarns).not.toContain("rss_unenforceable");
        expect(allWarns).not.toContain("PlacementRefusedError");
        expect(allWarns).not.toContain("watchdog_kill");
      } catch (e) {
        outcome = "fail";
        failure = e;
      } finally {
        const problems = await legFinally({
          driver: ctx.driver,
          ids,
          recordsDir: join(workspace, "runs"),
          workspace,
          hashesBefore,
          evidence,
          destroyFailures,
          hadFailure: failure !== undefined,
        });
        await writeEvidenceQuietly(
          "DF3.6b-LB",
          "df36b-leg-b-attachment",
          {
            test: "DF3.6b Leg B",
            outcome,
            runId: ids.runId,
            kernel: kernel?.release,
            capMicroUsd: CAP_MICRO_USD,
            evidenceDir: EVIDENCE_DIR,
            phases: evidence,
            failure:
              failure === undefined
                ? undefined
                : redactSecrets(failure instanceof Error ? failure.message : String(failure)).slice(0, 400), // same RED-round contract as Leg A
          },
          // Same contract as Leg A: write failures land in the settleRun list.
          problems,
        );
        await settleRun(failure, problems);
      }
    },
    // Budget audit: Leg A's pricing minus the sampler (−510). ≈ 5 120 s.
    // Hence 6 500 s — the same fail-safe direction, one abort bound on this
    // leg's box.
    6_500_000,
  );
});
