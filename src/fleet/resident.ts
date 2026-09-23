/**
 * DF3.3 — the resident orchestrator agent, fleet side of the steering pair.
 *
 * `startResident` turns a validated DF3.1 brief into a `ResidentSpawn`: a
 * `ResidentCaller` that runs one synchronous pi solicitation per call over
 * `Bun.spawn` (native timeout + SIGKILL), the slug's DF1.5-resolved rate, and
 * the process-end mapping C3 reports in the journal's `resident.exitStatus`.
 * The agent holds no reference to a gate, the journal, or the manifest — its
 * only egress is the raw reply text returned from an engine-initiated call
 * (INV-RES-1). Parsing/validation of that reply is C1's `steering.ts`.
 *
 * Session continuity is the `--session <path>` FILE (one file per runId), not
 * a long-lived process: each call spawns pi, which resumes the session. A
 * resident that dies mid-run therefore degrades (AC3), never invalidates.
 *
 * Spawn shape adapted from cli-anything/scripts/team-lead-driver.ts runWorkerPi
 * (:542-659); reply/usage come from its exported harvestPiStream (message_end
 * totals only, INV-COST-3). Rates come from resolveRate — never re-derived.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { redactSecrets, SECRET_KEY_RE } from "../../cli-anything/src/redact.ts";
import { harvestPiStream } from "../../cli-anything/scripts/team-lead-driver.ts";
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import { PlacementRefusedError, SOLICIT_TIMEOUT_MS, type ResidentCaller } from "../phase-engine/steering.ts";
import { resolveRate, type RateSources } from "../phase-engine/roster/validate.ts";

/**
 * Provenance default (R5 §6 fact 9). The FULL OpenRouter model id
 * (vendor/model) — the story's "deepseek-v4-flash-0731" is a display name and
 * never resolves as a rate key (canonical key: openrouter/deepseek/…). The
 * runtime rate ALWAYS comes from resolveRate — this constant is configuration,
 * never a price table.
 */
export const DEFAULT_RESIDENT_SLUG = "deepseek/deepseek-v4-flash-0731";

/**
 * The runId lands in file names (`${runId}.resident.jsonl`, artifact names), so
 * anything that escapes the session/persist dirs (path traversal) is refused
 * before it can become a path. Same guard idea as dispatch's
 * `assertValidRunId`, local because the resident's artifact grammar (dots,
 * underscores) is wider than the store's RFC 1123 label.
 */
const RESIDENT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Upper clamp on QDS_RESIDENT_TIMEOUT_MS — 10 min admits no unbounded hang. */
const MAX_RESIDENT_TIMEOUT_MS = 600_000;

/**
 * Hard prompt-size ceiling for the `-p` argv delivery (S2-2). pi 0.55.0's
 * prompt contract IS argv (stdin is "ignore"), so the prompt rides the
 * command line: visible to any local `ps` while the call runs (a known,
 * accepted exposure — the run's own host), and Bun.spawn throws E2BIG above
 * ARG_MAX. 128 KiB sits well under every platform's ARG_MAX and is
 * unreachable via the normal path — steering's PROMPT_CHAR_CEILING is 16 000
 * chars — so hitting this means a caller bug, not a big brief.
 */
const MAX_PROMPT_BYTES = 128 * 1024;

/**
 * Output byte ceilings for the harvest buffers (S2-4, round 7). The prompt
 * guard bounds what goes IN; nothing bounded what comes OUT — a looping pi
 * could fill stdout/stderr faster than any timeout fires and exhaust host
 * memory first. 4 MiB of stdout is ~250× a healthy solicitation's NDJSON; the
 * 1 MiB stderr ceiling matches the redacted-tail diagnostics role (only the
 * last 400 chars are ever read). On cap trip the child is SIGKILLed and
 * classified "logic": a flood is a pi-side fault a retry will not fix — the
 * same conservative default as every unmatched non-zero exit.
 */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

/** Sentinel distinguishing an S2-4 cap trip (we killed the child) from an ordinary stream fault. */
class OutputCapError extends Error {}

/**
 * Bounded replacement for `new Response(stream).text()` (S2-4): accumulate
 * chunks up to `cap` bytes, then throw OutputCapError so the caller can kill
 * the child instead of buffering unboundedly. The error message is byte
 * counts only — no output content ever crosses into it.
 */
async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new OutputCapError(`resident pi ${label} exceeded the ${cap}-byte output cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Transient-fault patterns matched against pi's REDACTED stderr tail (S2-3):
 * provider 429/5xx and network failures heal on retry, so they classify
 * "transient"; every other non-zero exit stays "logic" (a fault retry will
 * not fix). Deliberately conservative — when in doubt, "logic".
 */
const TRANSIENT_STDERR_RE =
  /\b429\b|rate.?limit|too many requests|\b5(?:00|02|03|04)\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i;

// ─── DF3.6b: kernel-enforced memory bound (cgroup v2) ───────────────────────
//
// The engine passes a VALUE (`residentRssBytes`, engine-owned policy validated
// by DF3.6a); this layer supplies the MECHANISM and nothing else — it never
// chooses, defaults or clamps the bound (INV-MEM-1). Nothing here samples: the
// kernel enforces `memory.max` on a per-solicitation leaf that contains only pi
// and its descendants (INV-MEM-2 / AC2), and `memory.peak` is a kernel
// high-water mark a poller could not match.

/** The unified-hierarchy mount point. cgroup v2 only — v1's split hierarchy has
 *  no `memory.max`, and a v1 box classifies unenforceable (INV-MEM-2). */
const CGROUP_MOUNT = "/sys/fs/cgroup";

/** The leaf the engine moves ITSELF into so `+memory` can be enabled on the
 *  delegated root. cgroup v2's no-internal-processes rule forbids enabling a
 *  controller in `cgroup.subtree_control` on a cgroup that directly holds
 *  processes, and the unit's cgroup holds the engine (and, in-box, every
 *  tier-3 `dispatch_task` worker — which is exactly why the bound is rooted at
 *  pi's own leaf and never at the unit, AC2/F064). */
const SUPERVISOR_LEAF = "supervisor";

/**
 * DF3.6b AC3 / INV-MEM-2: the bound cannot be ENFORCED here — no delegation, no
 * `memory` controller, not cgroup v2, an unwritable `memory.max`. The resident
 * is then NOT started; the engine never runs an agent whose memory it cannot
 * bound. Typed so `scripts/pipeline-run.ts` can classify it at the arming
 * boundary beside the rate refusal instead of rethrowing it into a
 * tracer-closed, marker-absent box.
 */
export class CgroupUnenforceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CgroupUnenforceableError";
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** This process's cgroup v2 directory, from the sole `0::` line of
 *  /proc/self/cgroup. Any other shape means no unified hierarchy. */
function selfCgroupDir(): string {
  let raw: string;
  try {
    raw = readFileSync("/proc/self/cgroup", "utf8");
  } catch (err) {
    throw new CgroupUnenforceableError(`/proc/self/cgroup is unreadable: ${errMsg(err)}`);
  }
  const line = raw.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) {
    throw new CgroupUnenforceableError(
      "/proc/self/cgroup carries no unified (`0::`) entry — this box is not on cgroup v2",
    );
  }
  const rel = line.slice("0::".length).trim();
  if (!rel.startsWith("/")) {
    throw new CgroupUnenforceableError(`/proc/self/cgroup unified path ${JSON.stringify(rel)} is not absolute`);
  }
  return join(CGROUP_MOUNT, rel);
}

/** Memoized delegated root — the split is once per ENGINE PROCESS, not once per
 *  solicitation, and re-running it would try to move the engine out of a leaf
 *  it already lives in. */
let delegatedRoot: string | null = null;

/** Test seam (the `_injectRateSources` convention): resets the once-per-process
 *  split memo so a test can drive `ensureDelegatedSubtree` against a fresh
 *  fake hierarchy. Documented private seam — never called in production. */
export function _resetCgroupSplit(): void {
  delegatedRoot = null;
}

/** Test seam: overrides `/proc/self/cgroup` resolution so the host-side suite
 *  can point the mechanism at a temp-dir fake of the delegated tree. Absent in
 *  production, where the real unified hierarchy is the only source. */
let _selfCgroupDirOverride: (() => string) | null = null;
export function _injectSelfCgroupDir(fn: (() => string) | null): void {
  _selfCgroupDirOverride = fn;
  delegatedRoot = null;
}

/**
 * The one-time delegated-subtree split (systemd's documented `Delegate=`
 * pattern), idempotent across engine restarts on the same box: move every
 * process in the delegated root into `supervisor/`, then enable `+memory` on
 * the root so per-solicitation leaves can carry `memory.max`.
 *
 * Idempotence matters twice: a restarted engine finds itself ALREADY in the
 * `supervisor` leaf (so the root is its parent, not itself), and `+memory`
 * already present in `subtree_control` makes the write a no-op success.
 */
function ensureDelegatedSubtree(): string {
  if (delegatedRoot !== null) return delegatedRoot;
  const self = (_selfCgroupDirOverride ?? selfCgroupDir)();
  const root = basename(self) === SUPERVISOR_LEAF ? dirname(self) : self;
  const supervisor = join(root, SUPERVISOR_LEAF);
  // `memory` must be DELEGATED to us before anything else is worth trying —
  // `Delegate=memory` on the unit is what puts it in the root's
  // `cgroup.controllers` and chowns the tree to User=exedev.
  let controllers: string;
  try {
    controllers = readFileSync(join(root, "cgroup.controllers"), "utf8");
  } catch (err) {
    throw new CgroupUnenforceableError(`cgroup.controllers unreadable at ${root}: ${errMsg(err)}`);
  }
  if (!controllers.split(/\s+/).includes("memory")) {
    throw new CgroupUnenforceableError(
      `the memory controller is not delegated to ${root} (controllers: ${controllers.trim() || "<none>"}) — the unit needs Delegate=memory`,
    );
  }
  try {
    mkdirSync(supervisor, { recursive: true });
  } catch (err) {
    throw new CgroupUnenforceableError(`cannot create the supervisor leaf ${supervisor}: ${errMsg(err)}`);
  }
  // No-internal-processes: the root must hold NO processes directly before
  // `+memory` can be enabled in its subtree_control. One pid per write — the
  // kernel accepts a single pid per `cgroup.procs` write and nothing else.
  let pids: string[];
  try {
    pids = readFileSync(join(root, "cgroup.procs"), "utf8").split("\n").filter((p) => p.trim() !== "");
  } catch (err) {
    throw new CgroupUnenforceableError(`cgroup.procs unreadable at ${root}: ${errMsg(err)}`);
  }
  const supervisorProcs = join(supervisor, "cgroup.procs");
  for (const pid of pids) {
    try {
      // APPEND, not truncate. On cgroupfs every write is its own migration and
      // the flag is immaterial; on the fs-level fake the host-side suite drives,
      // a truncating write makes `cgroup.procs` unable to hold more than one pid
      // — so a multi-pid root, which is the whole reason the split exists,
      // could not be tested at all (review round 3).
      appendFileSync(supervisorProcs, `${pid}\n`);
    } catch (err) {
      // ESRCH: the process exited between the read and the write — it is no
      // longer in the root, which is all this loop needs. Anything else means
      // the root still holds a process and `+memory` below would fail EBUSY,
      // so refuse HERE with the cause rather than there without it.
      if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") {
        throw new CgroupUnenforceableError(`cannot move pid ${pid} into ${supervisor}: ${errMsg(err)}`);
      }
    }
  }
  try {
    writeFileSync(join(root, "cgroup.subtree_control"), "+memory");
  } catch (err) {
    throw new CgroupUnenforceableError(`cannot enable +memory on ${root}: ${errMsg(err)}`);
  }
  delegatedRoot = root;
  return root;
}

/**
 * Create one solicitation's leaf and arm it. `memory.oom.group=1` is what makes
 * "the kernel OOM-kills that cgroup" true rather than approximately true: at
 * the kernel default (0) the OOM killer picks a SINGLE task, leaving siblings
 * alive — which leaves the leaf un-`rmdir`-able (EBUSY) and produces exactly
 * the orphaned child AC1 says cannot exist.
 */
function createLeaf(root: string, name: string, bytes: number): string {
  const dir = join(root, name);
  // A leaf surviving from a torn-down predecessor would carry ITS memory.peak
  // into this solicitation's reading. Remove before create — but with a PLAIN
  // `rmdir`, never `removeLeaf`: that helper's first action is a `cgroup.kill`
  // write (round 1, finding 3), which empties a LIVE leaf and then removes it
  // successfully. Using it here would silently SIGKILL whatever process tree
  // occupies a colliding leaf name instead of failing EBUSY — and "a live leaf
  // cannot be rmdir'd, so this never steals one" is exactly the property this
  // pre-clean relies on. An EBUSY here propagates as a placement refusal, which
  // is the correct fail-closed outcome for a name collision.
  try {
    rmdirSync(dir);
  } catch {
    /* absent is the normal case; EBUSY means occupied and mkdir below refuses */
  }
  mkdirSync(dir);
  // UNWIND OUR OWN MKDIR on a partial failure (review round 3). `+memory`
  // disabled in the root's `cgroup.subtree_control` between arming and this
  // solicitation leaves a root that still accepts `mkdir` but a leaf with no
  // `memory.max` to write — ENOENT, mid-create. The caller assigns `leafDir`
  // only on success, so its `finally` teardown never fires and the half-made
  // leaf would survive for the life of the box, breaking AC1's post-run
  // "the solicitation cgroup is removed" check. Round 1 fixed this for the
  // ARMING probe; the per-solicitation path is the same defect and gets the
  // same remedy, here rather than at each call site so it cannot be missed a
  // third time.
  try {
    writeFileSync(join(dir, "memory.max"), String(bytes));
    writeFileSync(join(dir, "memory.oom.group"), "1");
  } catch (err) {
    try {
      removeLeaf(dir);
    } catch {
      /* the create failure is the one worth reporting */
    }
    throw err;
  }
  return dir;
}

/**
 * Remove a leaf. On real cgroupfs a leaf is removed with `rmdir` alone — its
 * control files are kernel-generated and `unlink` on them is EPERM, which is
 * why the unlink pass below is best-effort and its failures are ignored. The
 * pass exists because the same code has to run against the fs-level fake the
 * host-side suite drives, where the control files are ORDINARY files and
 * `rmdir` would fail ENOTEMPTY — a mechanism whose teardown cannot be exercised
 * off a real box is a mechanism whose teardown is untested until production.
 *
 * Nothing here removes a LIVE leaf: a cgroup still holding processes refuses
 * `rmdir` with EBUSY, which is exactly the signal `memory.oom.group=1` exists
 * to make impossible on the kill path.
 */
function removeLeaf(dir: string): void {
  // FINDING 3 (review round 1). `rmdir` on a cgroup that still holds a task is
  // EBUSY, and two ordinary paths leave one:
  //
  //   - the OOM path, briefly: `memory.oom.group=1` SIGKILLs every task in the
  //     leaf, but a task leaves `cgroup.procs` only when it is REAPED, and pi's
  //     descendants are reparented to systemd and reaped asynchronously.
  //     `proc.exited` waits on pi alone, so there is a real window in which the
  //     leaf is un-removable — and AC1's post-run "the cgroup is removed" check
  //     would be intermittently red for a run that was otherwise correct.
  //   - the timeout/stop paths, permanently: the engine's SIGKILL reaches pi
  //     ONLY (`oom.group` governs the kernel's OOM kill, never a signal the
  //     engine sends), so any pi descendant survives, stays in the leaf forever,
  //     and the leaf is never removable. That is a permanent cgroup plus a
  //     permanent orphan per run — R3's group-kill doctrine, which the kernel
  //     discharges on the OOM path, still has to be honoured on these.
  //
  // `cgroup.kill` (cgroup v2, 5.14+ — below this story's other kernel floors)
  // is the one write that covers both: it SIGKILLs the whole subtree, including
  // descendants the engine never learned the pids of. Best-effort, then a
  // bounded retry of the rmdir while the reaps land.
  try {
    writeFileSync(join(dir, "cgroup.kill"), "1");
  } catch {
    /* pre-5.14, or already empty — the retry below is the verdict */
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    /* already gone, or unreadable — rmdir below is the verdict */
  }
  for (const entry of entries) {
    try {
      unlinkSync(join(dir, entry));
    } catch {
      /* cgroupfs: EPERM on a kernel control file, and rmdir does not need it */
    }
  }
  // Bounded, synchronous retry: the reaps that clear `cgroup.procs` land within
  // milliseconds of `cgroup.kill`, and a call is already off the hot path here.
  // Unbounded waiting would trade a leaked cgroup for a wedged run, which is the
  // worse failure — after the last attempt the throw reaches the caller's warn.
  rmdirBounded(dir);
}

/**
 * The bounded EBUSY retry, split out with an INJECTABLE remover for one reason:
 * against the fs-level fake this loop is **unreachable**. The fake's leaf is an
 * ordinary directory that `removeLeaf` has already emptied, so `rmdirSync`
 * always succeeds on the first attempt and the retry — its attempt cap, its
 * errno discrimination and its backoff — was 100% dead code under the whole
 * host-side suite (found by a covering review, 2026-09-20, round 17). It exists
 * for a race only a real kernel produces: `cgroup.kill` SIGKILLs the leaf's
 * tasks and `rmdir` transiently returns EBUSY until the kernel finishes reaping
 * them. A wrong attempt count, an inverted errno check or a backoff too short
 * for real reap latency would all have shipped green.
 *
 * `rmdir` defaults to `rmdirSync`, so production behaviour is unchanged; tests
 * inject a remover that throws the errnos a real cgroupfs would.
 */
export function _rmdirBoundedForTest(dir: string, rmdir: (d: string) => void): void {
  rmdirBounded(dir, rmdir);
}

function rmdirBounded(dir: string, rmdir: (d: string) => void = rmdirSync): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmdir(dir);
      return;
    } catch (err) {
      if (attempt >= LEAF_RMDIR_ATTEMPTS - 1 || (err as NodeJS.ErrnoException)?.code !== "EBUSY") throw err;
      // `Bun.sleepSync`, not `Atomics.wait` on a throwaway SharedArrayBuffer.
      // The swap is READABILITY, and the reason it is worth a re-pin is that
      // the clever form drew a review finding claiming `Atomics.wait` throws
      // `TypeError` on Bun's main thread. It does not — probed on Bun 1.3.13,
      // bare, inside a catch after a real synchronous `fs` throw, and inside a
      // `Worker`: every call returns "timed-out". The finding was declined on
      // that evidence. But the premise was only wrong, not unreasonable (it IS
      // true in browsers), and a sleep spelled as an atomics primitive will
      // draw the same wrong finding again. The consequence the finding
      // described was accurate, which is the part worth keeping: this call is
      // NOT inside its own try, so a throw here would escape `removeLeaf`
      // entirely and abandon the bounded retry — worse than the last-attempt
      // path, which rethrows the original EBUSY deliberately.
      Bun.sleepSync(LEAF_RMDIR_BACKOFF_MS);
    }
  }
}

/**
 * How far below the bound `memory.peak` may sit on a genuine own-limit kill: one
 * failing charge's worth, since the charge that triggers the OOM is rolled back
 * before it reaches the watermark (`page_counter_try_charge()` subtracts and
 * `goto failed` ahead of the `WRITE_ONCE(c->watermark, new)`).
 *
 * SIZED TO THE BATCH PATH, not to a THP fault — corrected after review found
 * the original rationale backwards. `mem_cgroup_oom()` opens with
 * `if (order > PAGE_ALLOC_COSTLY_ORDER) return OOM_SKIPPED;` BEFORE it raises
 * `MEMCG_OOM`, so a failed THP charge (order 9) never produces the `oom` event
 * this predicate requires, and cannot be the failing charge here at all. The
 * charges that CAN raise it are order <= 3 and the `MEMCG_CHARGE_BATCH` path
 * (64 pages, 256 KiB). 2 MiB is therefore ~8x more headroom than the
 * implication needs — kept because the conjunct is a consistency check rather
 * than a discriminator (see `readLeaf`), so the extra margin costs nothing and
 * shrinking it would only move toward false negatives.
 *
 * DO NOT GROW IT "to be safe". This is the one direction in which the peak
 * conjunct can be DISARMED: at 2 MiB against a 64 MiB bound it admits peaks
 * down to 96.9% of the limit, which still rejects the global-OOM victim the
 * conjunct exists to catch (whose peak sits far below). At 16 MiB it would
 * start passing those again, and the false `watchdog_kill` rows come back.
 *
 * SCALE-DEPENDENT, and stated so a sixth door does not rediscover it: the slack
 * is a constant, so it loosens as a fraction as the bound shrinks. A story that
 * lowers `residentRssBytes` below ~32 MiB — where 2 MiB exceeds 6% of it — must
 * revisit this, e.g. as `min(2 MiB, bound / 16)`. Not now, at 512 MiB.
 */
const OOM_PEAK_SLACK_BYTES = 2 * 1024 * 1024;

/** The kernel's account of one solicitation, read BEFORE the leaf is removed.
 *  `memory.peak` is a high-water mark; the OOM verdict is the CONJUNCTION spelled
 *  out in the body — `oom` (this leaf's own limit fired) AND a kill counter AND
 *  the peak having reached the bound. `oom_kill` alone is exactly what that
 *  conjunction exists to reject, and `oom` is what rejects it. The peak conjunct
 *  is NOT a co-equal third discriminator: per story ruling 9 it is IMPLIED by
 *  `oom > 0` and kept as a consistency check. THAT IMPLICATION HOLDS ONLY WHILE
 *  THIS LEAF IS CHILDLESS — `memory.events` aggregates UPWARD, so a child with a
 *  smaller limit could fire `oom` far below THIS bound, and the floor becomes
 *  load-bearing the moment that happens. It is not decorative.
 *  Read the body before reasoning about the verdict from this line. Both files are best-effort reads —
 *  `memory.peak` needs kernel 5.19+, and a missing file must degrade the
 *  TELEMETRY, never the call. */
function readLeaf(dir: string, boundBytes?: number): { peakBytes: number; oomKilled: boolean } {
  let peakBytes = 0;
  try {
    const n = Number(readFileSync(join(dir, "memory.peak"), "utf8").trim());
    if (Number.isFinite(n) && n >= 0) peakBytes = n;
  } catch {
    /* pre-5.19 kernels have no memory.peak — 0 reads as "not measured" */
  }
  let oomKilled = false;
  try {
    const events = readFileSync(join(dir, "memory.events"), "utf8");
    const counter = (name: string): number => {
      const m = new RegExp(`^${name} (\\d+)$`, "m").exec(events);
      return m === null ? 0 : Number(m[1]);
    };
    // THE PREDICATE, stated from first principles rather than patched:
    // "a process in THIS leaf was killed by the kernel BECAUSE THIS leaf hit
    // THIS bound." That is TWO independent facts, and the kernel publishes both
    // — in the counters, never in the exit shape:
    //
    //   `oom`                        this leaf hit ITS OWN `memory.max` and
    //                                could not reclaim. Raised only on the
    //                                own-limit charge path (`mem_cgroup_oom`),
    //                                never for a global or an ancestor's OOM.
    //   `oom_kill` / `oom_group_kill`  a process in this leaf was KILLED by an
    //                                OOM killer — ANY of them, own or global.
    //
    // NEITHER ALONE IS THE PREDICATE, and each one alone has already produced a
    // false `watchdog_kill` here:
    //   - `oom_kill` alone: a `dispatch_task` worker balloons, the box goes into
    //     system-wide OOM, the kernel picks pi. The leaf reads a kill with
    //     `memory.peak` far BELOW the bound.
    //   - `oom_group_kill` alone: same scenario, and it is NOT own-limit-only
    //     either — on a global OOM `oom_domain` is the root, so the kernel walks
    //     up from the victim, finds THIS leaf's `oom.group=1`, group-kills it
    //     and increments `oom_group_kill` HERE.
    //   - `oom` alone: an own-limit event where the allocation failed gracefully
    //     (`-ENOMEM`) and the task survived to exit on its own.
    //
    // THE CONJUNCTION is the predicate, and it needs no exit code at all. The
    // exit shape (`signalCode`, 137, "did we send the SIGKILL") is a proxy for
    // "was it killed" that cannot say BY WHOM — which is the whole
    // discrimination — and every attempt to carry the verdict on it failed from
    // a different door: a global kill, a graceful `-ENOMEM`, an assumed kill in
    // `stop()`, and a `QDS_PI_BIN` free to exit 137 of its own accord. The
    // KERNEL'S OWN RECORD answers every part — these two counters and, below,
    // the peak. The exit shape is consulted nowhere. (Read on: the two counters
    // are not sufficient BY THEMSELVES either. Do not stop at this paragraph
    // break — and note that the NEXT paragraph is the setup, not the answer:
    // the answer is the one after it.)
    //
    // THE CASE THE TWO COUNTERS DO NOT SETTLE, because they are INDEPENDENT and
    // the conjunction alone only NARROWS the global-OOM false positive rather
    // than removing it: pi takes a graceful `-ENOMEM` early in a solicitation
    // (`oom` 1, survives), and later a `dispatch_task` worker drives the box
    // into system-wide OOM and the kernel picks pi (`oom_kill` 1). Both
    // counters are then set on this leaf and nothing in them says the two
    // events are unrelated. That pairing is not exotic — global OOM happens
    // exactly when the box is thrashing, and the near-bound resident is the
    // likeliest victim.
    //
    // WHAT NARROWS IT IS `oom`, NOT THE PEAK — corrected here because an earlier
    // version of this comment credited the peak floor with work it cannot do,
    // and that claim was repeated downstream before it was caught. `oom > 0` is
    // what excludes the plain global victim: `oom` is raised only in
    // `mem_cgroup_oom()`, on the memcg whose OWN `memory.max` a charge was about
    // to exceed, so a resident picked by a system-wide OOM while nowhere near
    // its bound reads `oom` 0 and the predicate is already false without any
    // peak comparison.
    //
    // The peak floor is a CONSISTENCY CHECK, not a discriminator, and on this
    // topology it is strictly implied: `oom > 0` means the failing charge was
    // about to cross the limit, that charge is never added to `memory.current`,
    // and `memory.peak` is a monotonic high-water mark we never reset (the reset
    // API is 6.11+). So `oom > 0` ⟹ `peak >= bound - <failing charge>`, which is
    // exactly the slack below. It is kept because it is free — one read we
    // already do — because it catches a self-contradictory reading, and because
    // it stops being implied the moment this leaf gains children: `memory.events`
    // aggregates UPWARD, so a child with a smaller limit could fire `oom` far
    // below THIS bound, and then the floor is load-bearing.
    //
    // Applied only when both figures are actually available — a pre-5.19 kernel
    // has no `memory.peak` and reads 0 here, and suppressing a real kill on a
    // missing measurement would trade a false positive for a false negative,
    // which is the worse direction.
    //
    // THE RESIDUAL THIS DOES NOT CLOSE, stated because it is irreducible from
    // this interface and the next reader deserves to find it rather than
    // rediscover it: a global OOM that kills a resident whose leaf had ALREADY
    // registered its own `oom` event and survived it (a graceful `-ENOMEM`)
    // presents identically to an own-limit kill — `oom>=1, oom_kill>=1,
    // oom_group_kill>=1, peak≈bound, current≈0`. No readable cgroup v2 file
    // separates them: `memory.events.local` equals `memory.events` on a childless
    // leaf, and `oom_group_kill` is credited to whichever ancestor sets
    // `oom.group`, which for a global OOM is still this leaf. The one true
    // attribution signal is the kernel's own OOM report — `oom_memcg=` versus
    // `global_oom` in `mem_cgroup_print_oom_context()` — and it is unreachable
    // for `User=exedev`: `/dev/kmsg` and `syslog(2)` need `CAP_SYSLOG` under
    // `kernel.dmesg_restrict=1` (the Debian/Ubuntu default), and journald ACLs
    // the kernel journal to groups a service user is not in. Buying it costs an
    // `AmbientCapabilities=CAP_SYSLOG` on the unit plus a log-parsing and
    // time-correlation path, to remove a residual whose cost is a mislabel.
    //
    // The peak comparison carries SLACK because the charge that TRIGGERS the OOM
    // is the one that FAILS: `page_counter_try_charge()` rolls it back and
    // `goto failed` BEFORE the `WRITE_ONCE(c->watermark, new)`, so it never
    // reaches the high-water mark. Committed usage therefore sits below the
    // limit by up to that charge's size at the moment of the event.
    //
    // SIZED TO THE BATCH PATH (64 pages, 256 KiB) and order <= 3 — NOT to a THP
    // fault, which an earlier version of this comment claimed. `mem_cgroup_oom()`
    // returns `OOM_SKIPPED` for `order > PAGE_ALLOC_COSTLY_ORDER` BEFORE raising
    // `MEMCG_OOM`, so a failed THP charge never produces the `oom` event this
    // predicate requires and cannot be the failing charge here. 2 MiB is thus
    // ~8x more headroom than the implication needs; see OOM_PEAK_SLACK_BYTES for
    // why it is kept at that value anyway.
    //
    // (`boundBytes` is what we WROTE; the kernel `PAGE_ALIGN`s `memory.max`
    // upward, which moves the real limit away from the peak — the safe
    // direction, so no adjustment is needed for it.)
    const ownLimit = counter("oom") > 0 && (counter("oom_kill") > 0 || counter("oom_group_kill") > 0);
    const reachedBound =
      peakBytes === 0 || boundBytes === undefined || peakBytes >= boundBytes - OOM_PEAK_SLACK_BYTES;
    oomKilled = ownLimit && reachedBound;
  } catch {
    /* no memory.events means no kill this layer can attest to */
  }
  return { peakBytes, oomKilled };
}

/**
 * The fail-closed placement wrapper. The CHILD places itself before it becomes
 * pi, and refuses to become pi if the placement fails.
 *
 * WHAT SHIPS IS THE MEMBERSHIP CHECK. An earlier form guarded the redirection
 * itself (`echo $$ > "$1"/cgroup.procs || exit 97; …`) and was REJECTED in
 * review round 1 — the paragraph below says why. It is described here only so
 * the rejection is legible; it is not the shipped guard, and the `|| exit 97`
 * in the script below sits on the membership check, not on the write.
 *
 * The concern that motivated the rejected form still stands and is subsumed: an
 * unconditional `;` sequence would let a failed redirection — leaf removed by a
 * concurrent teardown, `+memory` disabled, EPERM/ENOENT/EBUSY — fall straight
 * through to `exec` and run pi with NO `memory.max`. That is the silent
 * degradation to an unbounded agent INV-MEM-2 forbids, and AC3's check is at
 * arming, once, so nothing else re-checks per solicitation.
 *
 * FINDING 5 (review round 1): the refusal is keyed on VERIFIED MEMBERSHIP, not
 * on the write's exit status. `cgroup.procs` rejects at WRITE time as well as at
 * open time — EBUSY when the target is not a leaf (`+memory` in its
 * `subtree_control`), EOPNOTSUPP, EINVAL — and whether `|| exit 97` fires then
 * depends on the shell propagating a deferred write error: busybox `ash` returns
 * 1, `dash` raises an I/O error and exits 2. A generic non-zero exit is NOT
 * classified `unenforceable` by the engine; it takes the one-way "degraded"
 * latch, which is precisely the misclassification AC4 exists to prevent. Reading
 * `cgroup.procs` back and looking for our own pid is decisive on every shell and
 * every failure mode, and it uses only POSIX shell built-ins (no `grep`, no
 * `awk`) so it cannot depend on what the image happens to stage.
 *
 * INV-MEM-3: pi's argv is passed POSITIONALLY, so a rendered prompt is never
 * interpolated into a shell string, and the per-run key stays env-borne.
 */
export const _PLACEMENT_SCRIPT =
  'echo $$ >> "$1"/cgroup.procs 2>/dev/null; ' +
  'ok=0; while IFS= read -r p; do [ "$p" = "$$" ] && ok=1; done < "$1"/cgroup.procs 2>/dev/null; ' +
  '[ "$ok" = 1 ] || exit 97; shift; exec "$@"';

/**
 * The exit code the placement wrapper refuses with. Classified `unenforceable`
 * by the caller and carried to the engine on `PlacementRefusedError`.
 *
 * COLLISION, stated rather than left to be discovered (FINDING 4, review round
 * 1): `sh` `exec`s pi, so the wrapper is gone by the time pi picks an exit code.
 * A pi — or any `QDS_PI_BIN` override — that exits 97 of its own accord is
 * indistinguishable from a placement refusal, and the engine will stop the
 * resident for the rest of the run over an ordinary application exit code. The
 * direction is fail-closed (a resident stopped for the wrong reason never spends
 * and never runs unbounded), which is why it is accepted rather than designed
 * around; the out-of-band alternative is a sentinel on a pre-opened fd.
 * **Consequence for AC1's live Leg A: the synthetic allocator staged as that
 * leg's `QDS_PI_BIN` MUST NOT exit 97, or the leg proves a placement refusal
 * instead of a crossing.**
 */
export const _PLACEMENT_REFUSED_EXIT = 97;

/**
 * The argv of the most recent `Bun.spawn` in `call()`. Documented private test
 * seam (the `_injectRateSources` convention), never read in production.
 *
 * It exists because nothing else can see WHICH argv a bounded call spawns
 * (rebase review, finding 4): an implementation that deletes the wrapper and
 * writes `proc.pid` into `cgroup.procs` from the parent AFTER the spawn passes
 * every other assertion in the suite — the one-pid read-back, the numeric
 * contract, the exit-97 arm (which keys on the exit code and `leafDir`, not on
 * the wrapper) and the INV-MEM-3 argv test (which reads pi's own argv, identical
 * either way) — while re-opening the exact window in which pi runs unbounded
 * that the wrapper exists to close.
 */
let _lastSpawnArgv: readonly string[] = [];
/** How much of the argv the seam retains: `sh -c <script> _ <leaf> <bin>` — the
 *  wrapper shape the tests assert, and nothing after it. The tail is pi's own
 *  argv, which ENDS IN THE RENDERED PROMPT: keeping it alive module-globally
 *  for the process lifetime would be a retained allocation and a heap/core-dump
 *  exposure, in a file that routes every other egress through `redact`. */
const SPAWN_ARGV_SEAM_PREFIX = 6;
export function _lastSpawnArgvForTest(): readonly string[] {
  return _lastSpawnArgv;
}

/** Bounded retry for the leaf `rmdir` while `cgroup.kill`'s reaps land. Four
 *  attempts at 25 ms covers the reap window by two orders of magnitude without
 *  turning a leaked cgroup into a wedged run. */
const LEAF_RMDIR_ATTEMPTS = 4;
const LEAF_RMDIR_BACKOFF_MS = 25;

export interface ResidentSpawn {
  /** Implements ResidentCaller over a pi subprocess (one process per call). */
  caller: ResidentCaller;
  rate: { inputPerMTok: number; outputPerMTok: number };
  /**
   * How the resident process itself ended (CC-1 ExitStatus); null when the
   * resident never ran a call, because there is no process end to report.
   */
  exitStatus(): Promise<ExitStatus | null>;
  /** SIGKILL the in-flight call, if any. DF3.6 decides when; this supplies how. */
  stop(): Promise<void>;
  /**
   * DF3.6b: the last solicitation's cgroup accounting — `memory.peak` and
   * whether the kernel OOM-killed the leaf — read before the leaf is removed.
   * Null when no solicitation has run under a bound (the host-side context,
   * where `residentRssBytes` is absent and no cgroup machinery runs at all).
   * `boundBytes` is the bound that reading was taken against, so the engine can
   * name it in a tripwire without holding the manifest.
   */
  lastMemory(): { peakBytes: number; oomKilled: boolean; boundBytes: number } | null;
}

export interface ResidentSpawnOpts {
  /** DF3.1 BriefSchema value (already validated at ingress). */
  brief: unknown;
  runId: string;
  /** The `--session <path>` file lives here. */
  sessionDir: string;
  /** Default DEFAULT_RESIDENT_SLUG. */
  slug?: string;
  /** Key delivery — env-borne, never argv. When omitted, the child gets a
   *  least-privilege allowlist of this process's env (CHILD_ENV_ALLOWLIST),
   *  NOT the whole environment; an explicit value passes through unfiltered
   *  (the unit-test seam). */
  env?: NodeJS.ProcessEnv;
  /** pi binary override — test seam (QDS_PI_BIN env fallback). */
  bin?: string;
  /** Prompt/reply artifacts persist here, redacted, when set (§5.2). */
  persistDir?: string;
  /**
   * DF3.6b: the engine-owned RSS bound, read from the frozen manifest and
   * validated by DF3.6a. Fleet applies it as `memory.max` on the
   * per-solicitation cgroup; fleet NEVER chooses or defaults it (INV-MEM-1).
   *
   * OPTIONAL, and the optionality IS the seam (INV-MEM-2 Scope): absent means
   * no cgroup machinery runs at all — the host-side context, where there are
   * no cgroups. That is NOT unit tests only: per story ruling 3b, the
   * `pipeline-run --manifest …` host-side flag shape withholds the bound too,
   * so a production invocation can reach here with the field absent. Only the
   * `run <runId>` in-box FRONT DOOR always supplies it, because DF3.6a refuses
   * the run at manifest load on a missing or non-positive value.
   * Present-but-unenforceable ⇒ the resident is not started (INV-MEM-2), which
   * is `CgroupUnenforceableError` out of `startResident`.
   *
   * Same division of labour as stop(): "DF3.6 decides when; this supplies how".
   */
  residentRssBytes?: number;
}

// ponytail: rate-source injection seam for tests (dispatch-task _injectRunner
// pattern) — lets unit tests pin rates without touching ~/.pi/agent/models.json.
let _rateSources: RateSources | null = null;
export function _injectRateSources(sources: RateSources | null): void {
  _rateSources = sources;
}

/**
 * Once-only enforcement per session FILE across startResident instances
 * (S2-5, round 7): two live residents sharing one `--session` jsonl would
 * interleave appends and collide on artifact seq numbers. A second
 * startResident for a path already in this set throws at arming; stop()
 * releases the path. Documented private seam — module-level, never exported.
 * (Per-call overlap WITHIN one instance is the `current`-slot guard in call().)
 */
const LIVE_SESSION_PATHS = new Set<string>();

/**
 * Per-call timeout. Default SOLICIT_TIMEOUT_MS (the frozen constant); the
 * QDS_RESIDENT_TIMEOUT_MS override is bounds-checked exactly like
 * PI_COMS_TIMEOUT_MS in team-lead-driver.ts:691-697 — only integers in
 * [1, 600_000] count, because `setTimeout(NaN)` fires at ~0 ms, Bun's
 * timeout option would reject a non-positive value outright, and an unclamped
 * upper bound would let a typo hang a run for 2^31-1 ms (~24.8 days).
 * Reads `env` (the spawn seam), falling back to this process's env.
 */
function solicitTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.QDS_RESIDENT_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_RESIDENT_TIMEOUT_MS
    ? raw
    : SOLICIT_TIMEOUT_MS;
}

/**
 * Test seam for the timeout's resolution table (the `_injectRateSources`
 * convention): lets the clamp tests assert the resolved value directly
 * instead of burning the 60 s default on a real hang.
 */
export function _resolvedSolicitTimeoutMs(env: NodeJS.ProcessEnv): number {
  return solicitTimeoutMs(env);
}

/**
 * AC4: absent/empty brief means the resident is NEVER spawned — an explicit
 * non-error path checked before rate resolution, so a rate-less config can
 * never turn "no brief" into a refusal. Fail-safe (S2-9): anything that is
 * not a non-empty string or a non-empty object (0, false, 42, …) counts as
 * EMPTY — a meaningless brief must disable the resident, never spawn it.
 */
function briefIsEmpty(brief: unknown): boolean {
  if (brief === null || brief === undefined) return true;
  if (typeof brief === "string") return brief.trim() === "";
  if (typeof brief === "object") return Object.keys(brief as Record<string, unknown>).length === 0;
  return true;
}

/**
 * Credential-shaped env KEY NAMES bound for redaction. Explicit common names
 * first, then the repo's SECRET_KEY_RE heuristic (cli-anything redact.ts)
 * catches the rest (anything *TOKEN/*SECRET/*KEY-shaped) from the env the
 * child actually receives; empty/whitespace values are excluded.
 */
const SECRET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/**
 * Least-privilege child env (S2-4 — behavior change, round 5): without an
 * explicit `opts.env`, pi receives ONLY this allowlist. pi provably needs
 * PATH (shebang/subprocess resolution), HOME (its ~/.pi config — the rate
 * table lives there), the OpenRouter key (the provider is frozen
 * "openrouter" in argv), and proxy vars to reach the network;
 * QDS_RESIDENT_TIMEOUT_MS is the resident's own knob, read off the child env
 * by solicitTimeoutMs. Everything else in the orchestrator's environment —
 * cloud credentials, unrelated CI tokens — stays OUT of the third-party
 * subprocess. QDS_RESIDENT_ENV_PASSTHROUGH (comma-separated names, read from
 * the BASE env) is the documented escape hatch the e2e harness uses to reach
 * an env-scripted fake pi. `opts.env` bypasses the filter entirely.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "OPENROUTER_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "QDS_RESIDENT_TIMEOUT_MS",
];

function buildChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passthrough = (base.QDS_RESIDENT_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...CHILD_ENV_ALLOWLIST, ...passthrough]) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * #219 / INV-RES-3 — the spawn-seam key assertion. The resident's credential
 * channel is env-borne delivery of the run's ONE minted key: on the box, the
 * unit's `EnvironmentFile` (`KEY_ENV_FILE`, src/providers/credentials.ts —
 * `app/.env` under the exec user's home) puts it into the manager environment
 * before this process starts. The resident CANNOT verify file origin from
 * inside its own environment, so this asserts exactly what is assertable at
 * the seam: the key EXISTS and is NON-BLANK before pi is armed.
 *
 * Fail-closed both ways this class of fault demands: a resident with no key
 * never spawns (it must not mint, borrow, or fall back to a second key — the
 * second-mint prohibition), and the runner's arming policy (pipeline-run.ts)
 * refuses the run on this throw rather than degrade, because an absent key is
 * a credential-CHANNEL fault — the same class as a credential-shaped brief
 * value (DF1.1 INV-4) — not an agent-reachability fault (INV-RES-5's degrade
 * list). Blank counts as absent: bindRedact already treats whitespace-only
 * secrets as "not a key", and a whitespace key would only ever produce
 * provider auth failures one call at a time. Invisible-only keys count the
 * same way — `trim()` cannot see them (see INVISIBLE_KEY_RE), and they arm pi
 * with a non-key to the same one-auth-failure-at-a-time end.
 */
export class ResidentKeyAbsentError extends Error {
  readonly code = "RESIDENT_KEY_ABSENT" as const;
  constructor() {
    super(
      "resident refused: OPENROUTER_API_KEY is absent, blank, or carries invisible characters in the env the resident would hand pi — " +
        "INV-RES-3 (#219): the run's single key must arrive env-borne from the unit's EnvironmentFile " +
        "(app/.env, KEY_ENV_FILE); the resident never mints, borrows, or falls back to a second key",
    );
    this.name = "ResidentKeyAbsentError";
  }
}

/**
 * Invisible/control characters an API key must not carry — manifest.ts's
 * INVISIBLE_OR_CONTROL_RE doctrine (src/phase-engine/manifest.ts:105), same
 * class, applied to the key gate. `trim()` strips only ECMAScript
 * WhiteSpace/LineTerminator: that DOES include U+FEFF (a BOM-only key already
 * fails the blank check above — `"\uFEFF".trim() === ""`), but not ZWSP
 * (U+200B), SHY (U+00AD), WORD JOINER (U+2060), the Trojan-Source bidi
 * embeddings/overrides U+202A-U+202E (manifest's round-4 D2 widening —
 * invisible AND able to reorder displayed text), or manifest's other
 * invisible families, so a key made of them is non-blank to `trim()` and
 * armed pi with a non-key. Refused anywhere in the value, like manifest's
 * refine — the same characters EMBEDDED in a longer key are invisible to
 * every check that ever runs and only ever produce provider auth failures
 * one call at a time.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point (mirrors manifest.ts)
const INVISIBLE_KEY_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]/;

/**
 * INV-RES-3 seam check (throws ResidentKeyAbsentError). Reads the SAME env
 * the child receives (`opts.env` unfiltered, else the allowlist build) — never
 * a second source — so the assertion cannot pass against an env pi never gets.
 */
function assertRunKeyPresent(childEnv: NodeJS.ProcessEnv): void {
  const key = childEnv.OPENROUTER_API_KEY;
  if (typeof key !== "string" || key.trim() === "" || INVISIBLE_KEY_RE.test(key)) {
    throw new ResidentKeyAbsentError();
  }
}

/**
 * Redaction bind (dispatch-task.ts:120-126 pattern): the explicit key set
 * above plus every SECRET_KEY_RE-shaped key from the env the child actually
 * receives. Every persisted artifact and every error message passes through
 * this one chokepoint.
 */
function bindRedact(env: NodeJS.ProcessEnv): (s: string) => string {
  const secretEnv: Record<string, string> = {};
  const add = (key: string, v: string | undefined) => {
    if (v !== undefined && v.trim().length > 0) secretEnv[key] = v;
  };
  for (const key of SECRET_ENV_KEYS) add(key, env[key]);
  for (const [key, v] of Object.entries(env)) {
    if (typeof v === "string" && SECRET_KEY_RE.test(key)) add(key, v);
  }
  return (s: string) => redactSecrets(s, secretEnv);
}

/**
 * Persist one redacted artifact (§5.2). Fail-closed BOTH ways: the caller
 * invokes this BEFORE Bun.spawn for prompts (an unloggable prompt must not
 * execute), and a failed REPLY write also throws (S2-14 — an unpersisted raw
 * reply must never reach steering to be acted on; the throw degrades the
 * resident to the deterministic default).
 *
 * Writes are atomic (S2-13): a same-dir temp file renamed over the final
 * name, so a crash mid-write never leaves a truncated artifact
 * indistinguishable from a complete one. Fresh files get 0o600; the dir is
 * clamped to 0o700 even when it pre-existed, because mkdir's mode applies
 * only to directories it creates (S2-1). The chmod is best-effort via `warn`
 * — a chmod failure must never break a call.
 */
function persistArtifact(
  dir: string,
  name: string,
  body: string,
  warn: (msg: string) => void,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    warn(`chmod 0700 on persist dir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const finalPath = join(dir, name);
  // S2-2 (round 7): writeFileSync's mode applies on CREATE only — a stale
  // lax-mode .tmp would survive truncation and be renamed onto the artifact.
  // Remove first so every artifact is a fresh 0o600 create.
  rmSync(`${finalPath}.tmp`, { force: true });
  writeFileSync(`${finalPath}.tmp`, body, { mode: 0o600 });
  renameSync(`${finalPath}.tmp`, finalPath);
}

/**
 * Start (arm) the resident for one run. Returns `{disabled:true}` for an
 * empty/absent brief without spawning anything (AC4). Throws RateError from
 * resolveRate BEFORE any spawn when the slug has no resolvable rate — the
 * caller refuses the run (DF1.5 rule, consumed here, never re-derived).
 */
export function startResident(opts: ResidentSpawnOpts): ResidentSpawn | { disabled: true } {
  if (briefIsEmpty(opts.brief)) return { disabled: true };

  if (!RESIDENT_RUN_ID_RE.test(opts.runId)) {
    throw new Error(
      `resident refused: runId ${JSON.stringify(opts.runId.slice(0, 32))} is not ` +
        `${RESIDENT_RUN_ID_RE.source} — it becomes file names under the session and persist dirs`,
    );
  }

  // SOURCE-vs-spec drift: resolveRate's tables key `${providerId}/${id}`
  // (validate.ts:396) where id is itself vendor/model — e.g.
  // openrouter/deepseek/deepseek-v4-flash-0731 — so the story's short slug can
  // never resolve. The resident's provider is frozen "openrouter" (argv), so:
  // rateKey is always provider-qualified and --model always carries the bare id.
  const slug = opts.slug ?? DEFAULT_RESIDENT_SLUG;
  const qualified = slug.startsWith("openrouter/");
  const modelArg = qualified ? slug.slice("openrouter/".length) : slug;
  // Slug shape (B10): the remainder must be a non-empty vendor/model id —
  // `openrouter/` alone or a bare "/" is configuration garbage, never a model.
  if (!modelArg.includes("/") || modelArg.split("/").some((part) => part.length === 0)) {
    throw new Error(
      `resident refused: slug ${JSON.stringify(slug.slice(0, 64))} is not a vendor/model id`,
    );
  }
  const rateKey = qualified ? slug : `openrouter/${slug}`;
  const rate = resolveRate(rateKey, _rateSources ?? undefined);
  const bin = opts.bin ?? process.env.QDS_PI_BIN ?? "pi";
  const sessionPath = join(opts.sessionDir, `${opts.runId}.resident.jsonl`);
  // S2-5 (round 7): refuse a second live resident on the same session file —
  // concurrent instances would interleave jsonl appends and collide on
  // artifact seq numbers. Released by stop().
  if (LIVE_SESSION_PATHS.has(sessionPath)) {
    throw new Error(
      `resident refused: session ${sessionPath} is already held by a live startResident instance (stop() it first)`,
    );
  }
  // S2-4: `opts.env` is the test seam and passes through unfiltered; without
  // it the child gets the least-privilege allowlist, NOT this process's whole
  // environment. The redaction bind reads the SAME env the child receives.
  const childEnv = opts.env ?? buildChildEnv(process.env);
  // INV-RES-3 (#219): the key must exist, non-blank, in the env pi would
  // receive — checked BEFORE mkdir/chmod/session-claim so a refusal leaves
  // zero filesystem side effects and no claim to leak (the runId/slug/rate
  // refusals above already ran, so this is the last pre-arm gate).
  assertRunKeyPresent(childEnv);
  // DF3.6b AC3 / INV-MEM-2: arm the kernel bound against a REAL object before
  // anything else exists. Placed after the key gate and BEFORE the session dir
  // and the session claim, so a refusal leaves no session tree and no claim to
  // leak (the INV-RES-3 rule, extended to this gate).
  //
  // The value is the engine's; fleet only refuses garbage it could not apply —
  // a plain Error, not CgroupUnenforceableError: an out-of-range operand is a
  // CALLER fault (DF3.6a's loader refuses it upstream), not a box that cannot
  // enforce, and misclassifying it would disable a resident over a typo.
  let cgroupRoot: string | null = null;
  const boundBytes = opts.residentRssBytes;
  if (boundBytes !== undefined) {
    if (!Number.isSafeInteger(boundBytes) || boundBytes <= 0) {
      throw new Error(
        `resident refused: residentRssBytes ${String(boundBytes)} is not a positive safe integer — the bound is engine-owned policy and fleet never defaults it (INV-MEM-1)`,
      );
    }
    const root = ensureDelegatedSubtree();
    // "Against a real object, not against a process that does not yet exist":
    // create and arm a probe leaf with THIS run's bound, then remove it. A box
    // that cannot do this cannot bound a solicitation either.
    const probe = `resident.${opts.runId}.arm`;
    try {
      // The cleanup is its OWN finally (review round 1, finding 6): a
      // `createLeaf` that throws AFTER its mkdir — the `memory.oom.group` write
      // failing on a kernel that has `memory.max` but not `oom.group`, say —
      // would otherwise leak the probe leaf on a path whose whole point is that
      // it left nothing behind.
      try {
        createLeaf(root, probe, boundBytes);
      } finally {
        try {
          removeLeaf(join(root, probe));
        } catch {
          /* never created, or already gone */
        }
      }
    } catch (err) {
      throw new CgroupUnenforceableError(
        `cannot arm a memory-bounded leaf under ${root} (${probe}): ${errMsg(err)}`,
      );
    }
    cgroupRoot = root;
  }
  const redact = bindRedact(childEnv);
  const timeoutMs = solicitTimeoutMs(childEnv);
  /** The single warn chokepoint: redacted, tail-bounded, never throws. */
  const warn = (msg: string): void => {
    console.error(`[resident] ${redact(msg).slice(-400)}`);
  };
  mkdirSync(opts.sessionDir, { recursive: true, mode: 0o700 });
  // S2-1: clamp the dir even when it pre-existed (mkdir's mode applies only
  // to directories it creates) — pi's own session jsonl holds the RAW prompt
  // and reply, unredacted, so its dir must not keep lax permissions.
  try {
    chmodSync(opts.sessionDir, 0o700);
  } catch (err) {
    warn(`chmod 0700 on session dir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // S2-5: armed — claim the session path (added after the dir setup above, so
  // a throwing mkdir/chmod never leaks a claim for a resident that does not
  // exist; nothing between here and `return` throws).
  LIVE_SESSION_PATHS.add(sessionPath);
  let seq = 0;
  let lastExit: ExitStatus | null = null;
  let current: Bun.Subprocess | null = null;
  let stopped = false;
  /** DF3.6b: the most recent solicitation's kernel accounting. Null until a
   *  bounded solicitation has run — and reset at every leaf create, so a second
   *  solicitation reports ITS OWN memory.peak and never the previous one's. */
  let lastMem: { peakBytes: number; oomKilled: boolean; boundBytes: number } | null = null;
  /** The in-flight solicitation's leaf, visible to stop() (rebase review,
   *  finding 5). `stop()` resolves as soon as `proc.exited` does, while the
   *  interrupted call still has to drain both output streams before its own
   *  `finally` reaches the teardown — so a caller that ends the process on
   *  `await stop()` would leave the leaf in place with `cgroup.kill` never
   *  written. stop() finishes the teardown itself; whichever path gets there
   *  second finds the leaf gone and its ENOENT is swallowed. */
  let currentLeaf: string | null = null;
  /** The in-flight solicitation's cgroup setup cost, reported on the
   *  `resident_cgroup` line by whichever path performs the teardown. */
  let leafSetupMs = 0;

  /**
   * S2-1 (round 7): ANY signal death of the child — the native timeout's
   * SIGKILL, stop()'s SIGKILL, or an external kill — can tear the session
   * jsonl mid-append. Quarantine it (rename aside) so the next call starts a
   * FRESH session instead of resuming a truncated file and degrading every
   * later call. Best-effort via `warn`: a failed rename must never break a
   * call. The timeout-vs-stop ERROR TEXT distinction lives at the throw
   * sites, not here.
   */
  const quarantineSession = (reason: string): void => {
    try {
      if (existsSync(sessionPath)) renameSync(sessionPath, `${sessionPath}.torn-${seq}`);
    } catch (err) {
      warn(
        `session quarantine after ${reason} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * The per-solicitation leaf's end, in one place: read the kernel's account,
   * remove the leaf, emit the observability line. Called by exactly ONE of the
   * two paths that can reach it — the call's own `finally`, or `stop()` when it
   * resumes first — with `currentLeaf` as the ownership handle.
   *
   * The OOM verdict takes no EXIT-SHAPE argument from this layer. The only
   * thing this layer hands `readLeaf` is the BOUND (`readLeaf(dir, boundBytes)`
   * below), which arms the peak floor; the rule itself — two counters plus that
   * floor — lives in `readLeaf` and is spelled out in its comment. An earlier
   * shape ANDed the verdict with "did the process die by signal", which is a
   * proxy for "was it killed" that cannot say BY WHOM — and it counted OUR OWN
   * `stop()` SIGKILL as the kernel's. The kernel's record answers every part;
   * the exit shape answers none.
   *
   * Every step is best-effort: telemetry must never turn a completed call into
   * a throw, and a leaf that outlives its call is a warn, not a failure.
   */
  const teardownLeaf = (dir: string): void => {
    const t1 = performance.now();
    try {
      lastMem = { ...readLeaf(dir, boundBytes), boundBytes: boundBytes ?? 0 };
    } catch (err) {
      warn(`resident cgroup accounting read failed: ${errMsg(err)}`);
    }
    try {
      removeLeaf(dir);
    } catch (err) {
      // EBUSY here means a process survived the call in the leaf — which
      // `memory.oom.group=1` exists to make impossible on the kill path.
      warn(`resident cgroup leaf ${dir} not removed: ${errMsg(err)}`);
    }
    // The Observability Contract's cgroup half, on the FLEET chokepoint — which
    // is where it has to be, and the story's contract is amended to say so
    // (review round 1, finding 6). This layer holds no `requestId` and no
    // `phase`: both are engine-side facts that never cross into fleet (the
    // engine passes a prompt, not a ctx), so a line emitted here structurally
    // cannot carry them, and inventing a channel for them would widen the seam
    // this story's Technical Notes exist to keep narrow. `seq` is the
    // per-resident correlation key it CAN carry, and the engine-side breach
    // line keeps DF3.6a's shape with the join keys. The `[resident] ` prefix is
    // this chokepoint's, on every line it has ever emitted; fd-2 is harvested
    // with the journal either way.
    warn(
      `${JSON.stringify({
        event: "resident_cgroup",
        bound: "rss",
        allowed: !(lastMem?.oomKilled ?? false),
        runId: opts.runId,
        seq,
        residentRssBytes: boundBytes,
        rssPeakBytes: lastMem?.peakBytes ?? 0,
        oomKilled: lastMem?.oomKilled ?? false,
        cgroup_setup_ms: Math.round(leafSetupMs),
        cgroup_teardown_ms: Math.round(performance.now() - t1),
      })}`,
    );
  };

  const call = async (prompt: string) => {
    // DF3.6b (review round 3): the accounting is cleared at the TOP of the
    // call, not at leaf creation. `lastMemory()` must mean "this solicitation's
    // reading, or none" — the engine keys its OOM arm on it for ANY call
    // rejection, including the ones that throw BEFORE a leaf exists (the busy
    // guard, an empty or over-ceiling prompt, a prompt-artifact persist
    // failure). Clearing it later would let a previous solicitation's reading
    // relabel a host-side persistence fault as a `watchdog_kill` with
    // `status:"stopped"` and `exitStatus:"overflow"`.
    lastMem = null;
    if (stopped) throw new Error("resident stopped: stop() was called before this call");
    // S2-5: the ResidentCaller contract is strictly sequential — `current` is
    // a single slot and every call appends the SAME session file, so an
    // overlapping call would clobber the handle stop() kills and interleave
    // writers on the session jsonl. Refuse (logic: a caller-contract
    // violation a retry will not fix). lastExit is deliberately untouched —
    // no process ends here; the in-flight call owns the process-end report.
    if (current !== null) {
      throw new Error("resident busy: a solicitation is already in flight (calls are sequential)");
    }
    // S2-9 (round 7): an empty/whitespace prompt passes the byte ceiling and
    // would spawn pi with `-p ""` — refuse pre-spawn (fail-safe). lastExit
    // stays untouched, matching the busy path: no process ever ran.
    if (prompt.trim().length === 0) {
      throw new Error("resident refused: prompt is empty — nothing to solicit");
    }
    // S2-2: the prompt rides `-p` argv (pi 0.55.0's contract — stdin is
    // "ignore"), so refuse BEFORE persist/spawn rather than dying on E2BIG.
    // Only the byte count is reported, never prompt content. S2-3 (round 7):
    // lastExit stays untouched — no process ever ran, so exitStatus keeps the
    // previous call's end (or null), never a fabricated one.
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `resident refused: prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling`,
      );
    }
    seq += 1;
    if (opts.persistDir !== undefined) {
      try {
        persistArtifact(opts.persistDir, `${opts.runId}-solicit-${seq}-prompt.txt`, redact(prompt), warn);
      } catch (err) {
        throw new Error(
          `resident prompt artifact not persisted (${opts.runId}-solicit-${seq}): ${redact(err instanceof Error ? err.message : String(err))}`,
        );
      }
    }
    // DF3.6b: the per-solicitation leaf. Created here — after every pre-flight
    // refusal and after the prompt artifact, so a refused call makes no cgroup
    // at all — and torn down in the `finally` below on EVERY exit path,
    // including the OOM one. `lastMem` is cleared at create so a second
    // solicitation can never report the previous one's memory.peak.
    let leafDir: string | null = null;

    if (cgroupRoot !== null && boundBytes !== undefined) {
      const t0 = performance.now();
      leafSetupMs = 0;
      try {
        leafDir = createLeaf(cgroupRoot, `resident.${opts.runId}.${seq}`, boundBytes);
        currentLeaf = leafDir;
      } catch (err) {
        // The leaf could not be armed for THIS call, so no bounded call can be
        // issued — the same fail-closed outcome as the wrapper's exit 97, and
        // the engine classifies both through one typed rejection (AC4).
        throw new PlacementRefusedError(
          _PLACEMENT_REFUSED_EXIT,
          `resident cgroup leaf could not be armed: ${redact(errMsg(err))}`,
        );
      }
      leafSetupMs = performance.now() - t0;
    }
    try {
      // Timeout via Bun.spawn native timeout + SIGKILL (exedev/transport.ts:64-77
      // pattern). Bun.spawn THROWS synchronously on a missing binary (ENOENT) —
      // that throw IS DF3.3's AC3 unreachable path.
      //
      // DF3.6b NARROWS THAT, and the narrowing is stated because the comment
      // above is load-bearing documentation (review round 1, finding 6): on the
      // BOUNDED path the child is `sh`, which always exists, so a missing
      // `QDS_PI_BIN` is no longer a synchronous spawn throw — it is `exec`
      // failing inside the wrapper, which exits 127 and classifies through the
      // generic non-zero arm as "logic". Same fail-closed outcome, different
      // diagnostic: the message is pi's own `exec: not found` rather than this
      // file's `resident pi spawn failed`.
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      // `--no-tools` is LOAD-BEARING SECURITY CONFIGURATION for DF3.6b, not a
      // cost knob (INV-MEM-1 as amended in review round 1): pi is `exec`'d into
      // the solicitation leaf as the SAME uid that created it, so the leaf's
      // `memory.max` is a file pi's uid owns. A pi that could run an arbitrary
      // command or write an arbitrary path could raise its own bound, and the
      // engine would not notice — it reads the accounting only after the call.
      // Enabling tools on the resident re-opens that and needs a different
      // containment answer (a second uid for pi), never just this flag's removal.
      const piArgv = [
        bin,
        "--provider",
        "openrouter",
        "--model",
        modelArg,
        "--mode",
        "json",
        "--no-tools",
        "--session",
        sessionPath,
        "-p",
        prompt,
      ];
      // DF3.6b: the CHILD places itself in the leaf before it becomes pi, and
      // refuses to become pi if the placement fails. Writing pi's pid from
      // HERE, after the spawn, would leave a window in which pi runs unbounded.
      // argv is positional (INV-MEM-3): the rendered prompt stays its own argv
      // element and is never interpolated into a shell string.
      const argv = leafDir === null ? piArgv : ["sh", "-c", _PLACEMENT_SCRIPT, "_", leafDir, ...piArgv];
      _lastSpawnArgv = argv.slice(0, SPAWN_ARGV_SEAM_PREFIX);
      try {
        proc = Bun.spawn(
          argv,
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            env: childEnv,
          },
        );
      } catch (err) {
        // Bun.spawn throws synchronously on a missing binary (ENOENT) — a
        // configuration fault (wrong QDS_PI_BIN / pi not installed). S2-3
        // (round 7): no process ever ran, so lastExit stays untouched (the
        // busy-path rule). S2-7 (round 7): the message passes the redact
        // chokepoint like every other error — a spawn error can echo argv or
        // env fragments.
        throw new Error(
          `resident pi spawn failed: ${redact(err instanceof Error ? err.message : String(err))}`,
        );
      }
      current = proc;
      const spawnedAt = performance.now();
      let stdout = "";
      let stderr = "";
      try {
        const [out, errText] = await Promise.all([
          // S2-4 (round 7): bounded collectors — a looping pi hits the byte cap
          // (and is killed) long before it can exhaust host memory; the native
          // timeout bounds TIME, not bytes.
          collectBounded(proc.stdout, MAX_STDOUT_BYTES, "stdout"),
          collectBounded(proc.stderr, MAX_STDERR_BYTES, "stderr"),
          // NOTE: on a signal death `exited` resolves 128+signal (137 for
          // SIGKILL), NOT null — the reliable signals are the post-exit
          // `exitCode`/`signalCode` properties checked below.
          proc.exited,
        ]);
        stdout = out;
        stderr = errText;
      } catch (err) {
        // S2-8: a stream-read failure (or an S2-4 cap trip) must not orphan the
        // child — kill it BEFORE dropping the handle, or it lives until the
        // native timeout and stop() can never reach it again.
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone — the awaited exit below is the truth
        }
        await proc.exited.catch(() => {});
        current = null;
        if (err instanceof OutputCapError) {
          // S2-4: we SIGKILLed the child mid-append, so the session jsonl may
          // be torn — quarantine exactly like any other signal death (S2-1).
          // "logic": a flood is a pi-side fault a retry will not fix. The cap
          // message is byte counts only, so the raw rethrow leaks no content.
          quarantineSession("output cap");
          lastExit = "logic";
          throw err;
        }
        lastExit = "transient";
        throw err;
      }
      current = null;
      // S2-1: pi wrote the session jsonl with its own default mode and it holds
      // the RAW prompt + reply — clamp it after every call. Best-effort: a
      // chmod failure warns through the chokepoint, never breaks the call.
      try {
        if (existsSync(sessionPath)) chmodSync(sessionPath, 0o600);
      } catch (err) {
        warn(`chmod 0600 on session file failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // S2-10 (round 7): Bun reports a signal death as signalCode set /
      // exitCode null, but if it ever reports SIGKILL as exitCode 137
      // (128+SIGKILL) with a null signalCode, treat that as a signal death too —
      // otherwise the kill would fall into the generic non-zero branch and skip
      // both the "transient" classification and the quarantine.
      if (proc.exitCode === null || proc.signalCode !== null || proc.exitCode === 137) {
        // Killed by signal — the native timeout's SIGKILL, stop(), or an
        // external kill. S2-8 (round 7): the CC-1 ExitStatus enum cannot widen,
        // so a PLANNED stop() kill is recorded "transient" here — deliberately
        // indistinguishable from a genuine transient crash; the error text
        // thrown below keeps the timeout-vs-stop distinction for humans.
        lastExit = "transient";
        // S2-1 (round 7): quarantine for ANY signal death, not just the
        // timeout's — a stop()/external SIGKILL can tear the session jsonl
        // mid-append too, and the next call must not resume a truncated file.
        quarantineSession("signal death");
        // S2-7: Bun exposes no timed-out flag, so elapsed time discriminates
        // the native timeout from stop()/external kills (25 ms slack for timer
        // scheduling — a stop() landing inside the slack reads as a timeout).
        // S2-6 (round 7): only trust the discriminator when timeoutMs clears
        // the slack — at timeoutMs <= 25 the clamp floor (1 ms) makes
        // `elapsed >= timeoutMs - 25` true for EVERY signal death, so those
        // classify as plain signal deaths instead.
        if (timeoutMs > 25 && performance.now() - spawnedAt >= timeoutMs - 25) {
          throw new Error(`resident pi timed out after ${timeoutMs} ms (SIGKILL on native timeout)`);
        }
        throw new Error(`resident pi killed by signal ${proc.signalCode ?? "unknown"} before exit`);
      }
      const exitCode = proc.exitCode;
      // DF3.6b AC4: the placement wrapper refused — `cgroup.procs` could not be
      // written, so pi was NEVER `exec`'d and no unbounded call was issued.
      // Classified by TYPE on the ResidentCaller contract so the engine's catch
      // takes its `instanceof` arm instead of the one-way "degraded" latch.
      // `lastExit` stays untouched: pi never ran, so there is no process end to
      // report (the busy/empty-prompt rule).
      if (leafDir !== null && exitCode === _PLACEMENT_REFUSED_EXIT) {
        throw new PlacementRefusedError(
          _PLACEMENT_REFUSED_EXIT,
          `resident cgroup placement refused: the wrapper could not join ${leafDir} and did not exec pi`,
        );
      }
      if (exitCode !== 0) {
        // Redact FULL output, THEN cut (command-gate rule): cutting first can
        // split a secret at the boundary and leak the surviving fragment.
        const detail = redact(stderr).slice(-400);
        // S2-3: provider 429/5xx and network failures are transient (they heal
        // on retry); every other non-zero exit stays "logic". Conservative:
        // unmatched stderr means logic.
        lastExit = TRANSIENT_STDERR_RE.test(detail) ? "transient" : "logic";
        throw new Error(`resident pi exited ${exitCode}: ${detail}`);
      }
      lastExit = "success";
      // S2-12: warnings/deprecations pi prints on a successful call are the
      // only signal of a degrading provider — surface them once (warn redacts
      // and bounds the line).
      if (stderr.trim().length > 0) {
        warn(`pi wrote to stderr on a successful call (${opts.runId} solicit ${seq}): ${stderr.trim()}`);
      }
      const harvest = harvestPiStream(stdout);
      // S2-11: exit 0 with NO harvested message_end is not a success — the
      // solicitation silently produced nothing. Classify the process end
      // "logic" (pi exited clean but its stream is unharvestable, which a
      // retry will not fix); the empty raw still flows to steering, whose
      // reply validation fails closed downstream.
      if (harvest.turnCount === 0) lastExit = "logic";
      if (opts.persistDir !== undefined) {
        // §5.2 is fail-closed for replies too (S2-14): an unpersisted raw reply
        // must NOT flow to steering to be parsed and acted on — throwing here
        // degrades the resident to the deterministic default, matching the
        // prompt path. lastExit stays "success": the fault is host-side
        // persistence, not the process end. The message passes the redact
        // chokepoint like every other error (S2-10).
        try {
          persistArtifact(opts.persistDir, `${opts.runId}-solicit-${seq}-reply.txt`, redact(harvest.text), warn);
        } catch (err) {
          throw new Error(
            `resident reply artifact not persisted (${opts.runId}-solicit-${seq}): ${redact(err instanceof Error ? err.message : String(err))}`,
          );
        }
      }
      return {
        raw: harvest.text,
        usage: { inputTokens: harvest.inputTokens, outputTokens: harvest.outputTokens },
      };
    } finally {
      if (leafDir !== null) {
        // SINGLE OWNER, and the ownership test is the clearing of
        // `currentLeaf` (review round 6): `stop()` can resume before this
        // `finally` does — it waits only on `proc.exited`, while this path
        // additionally drains both output streams — so BOTH sides can reach a
        // teardown for the same leaf. Whoever clears the handle first performs
        // it; the other skips. Racing them instead (the earlier fix) let
        // `stop()` remove the leaf before this side could read it, so a
        // signal-terminated run reported `{peakBytes:0, oomKilled:false}` for a
        // solicitation that may have been OOM-killed, emitted a falsified
        // `resident_cgroup` line, and then warned a spurious ENOENT.
        if (currentLeaf === leafDir) {
          currentLeaf = null;
          teardownLeaf(leafDir);
        }
        leafDir = null;
      }
    }
  };

  return {
    caller: { call },
    rate: { inputPerMTok: rate.inputPerMTok, outputPerMTok: rate.outputPerMTok },
    // null before any call: a never-solicited resident has no process end to
    // report, and "transient" would be a fact about nothing.
    exitStatus: async () => lastExit,
    // DF3.6b: null until a BOUNDED solicitation has run — the host-side context
    // (no `residentRssBytes`) never creates a leaf, so there is nothing to
    // report and the engine's OOM arm can never fire on it.
    lastMemory: () => lastMem,
    stop: async () => {
      stopped = true;
      const proc = current;
      // S2-5: with no process ever spawned there is no exit to wait for —
      // release the claim immediately so a later startResident can arm.
      if (proc === null) {
        LIVE_SESSION_PATHS.delete(sessionPath);
        return;
      }
      try {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone — the awaited exit below is the truth
        }
        // S2-5 (round 8): hold the session-path claim until the child has
        // fully exited — releasing it before this await lets a concurrent
        // startResident arm a second live resident on the same session file
        // while the dying child can still append to it.
        await proc.exited.catch(() => {});
        if (current === proc) current = null;
        // Finish the interrupted call's teardown rather than racing it: the
        // call's own `finally` still has streams to drain, and a caller that
        // exits on `await stop()` must not leave a live leaf behind. Ownership
        // is the clearing of `currentLeaf` — whoever gets there first performs
        // the whole teardown, the other skips.
        const leaf = currentLeaf;
        if (leaf !== null) {
          currentLeaf = null;
          // No exit-shape argument: the kernel's counters decide, and OUR
          // SIGKILL increments none of them. A stop that is not a bound breach
          // therefore reads `oomKilled: false` on its own evidence rather than
          // on a flag this layer has to get right.
          teardownLeaf(leaf);
        }
      } finally {
        LIVE_SESSION_PATHS.delete(sessionPath);
      }
    },
  };
}
