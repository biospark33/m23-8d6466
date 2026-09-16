/**
 * Harvest (DF2.5) — ranged bundle → copy down → verify → fetch to
 * refs/sandbox/<run-id>, plus the artifacts tar pull and its validator.
 *
 * Lifted from inkwell's harvest.just (R4 §3.3) — which shipped unrun upstream
 * (R4 §3 flag 4), so nothing inherited from it is treated as proven: the tests
 * in tests/providers/harvest.test.ts are the blocking evidence, and the one
 * behavior inkwell never exercised (the empty-bundle no-op) is classified here
 * per AC4 rather than inherited.
 *
 * The box holds no push credential (D8/INV-1), so commits cross the gap as a
 * RANGED bundle: `<base>..refs/heads/sbx/<run-id>` records the prerequisite
 * "you must already have <base>", and the host's `git bundle verify` refuses a
 * branch that does not descend from the sha FILL pinned — BEFORE any fetch
 * touches the host repo (INV-2). The fetch lands only at refs/sandbox/<run-id>
 * and never at a branch, tag, index or working tree.
 *
 * Harvest writes NOTHING to the run record: the bundle's presence at
 * <runsDir>/<run-id>.bundle is the record, and DF2.1's schema stays closed.
 *
 * In-box staging paths are BOX-ROOT RELATIVE on both sides of the seam
 * (`harvest.bundle`, `harvest-artifacts.tgz.<pid>` — the artifacts name is
 * pid-suffixed so concurrent pulls never share one tar, and the chosen name
 * rides the TARBUILT line back), because `copyFile` pulls by a
 * box-relative name and a leading `/` is rejected by exedev's path guard — so
 * inkwell's /tmp staging cannot cross this seam unchanged (design.md "Paths";
 * the seam correction the upstream justfiles never needed because they never
 * ran against a guarded driver). The two scripts get there differently, and
 * the difference matters when reading either one:
 *
 *  - the BUNDLE script (`remoteScript`) `cd`s into `<workdir>` and writes
 *    `../harvest.bundle`, which is the login dir because the workdir is a
 *    child of it;
 *  - the ARTIFACTS script (`artifactsScript`) never `cd`s at all — it reaches
 *    every source through tar's `-C` instead — and writes `$PWD/…tgz`, i.e.
 *    the login dir directly. `$PWD` rather than a bare relative name so the
 *    output path is fixed no matter what `-C` does later, and absolute in the
 *    box while still being pulled back by the relative name `copyFile` needs.
 */

import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createGunzip } from "node:zlib";

import { log, newRequestId } from "../swarmclaw/log.ts";
import { assertRunIdPathComponent } from "../phase-engine/journal.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "./bounded-exec.ts";
import { auditRepoSlug, emitAuditLink, type ExecResult, type ProviderAuditLink, type ProviderDriver } from "./driver.ts";
import {
  assertExistingRunId,
  resolveRunsDir as resolveExportedRunsDir,
  type RunRecord,
  type RunRecordStore,
} from "./run-record.ts";
import { stepBase, timedLoggedStep, type StepCtx } from "./step-log.ts";
import { assertPlainBoxPath } from "./path-guard.ts";
import { ProviderError } from "./errors.ts";

/** Bundle received-bytes cap (INV-3-style bomb defense, host-side). */
export const BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
/** Artifacts tar cap — enforced on received bytes AND summed entry sizes. */
export const TAR_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Independent cap for buffered metadata payloads (pax 'x'/'g' records, GNU
 * 'L'/'K' long names). Metadata never hits disk but DOES buffer whole in
 * memory (chunks + final concat) — without its own cap, a hostile tar could
 * declare a metadata entry up to the full TAR_MAX_BYTES and hold ~1 GiB
 * resident during validation. Real metadata is bytes-to-KBs (it carries a
 * name or a link target); 64 KiB is ~250× a max-length path component.
 */
export const TAR_METADATA_MAX_BYTES = 64 * 1024;

/**
 * In-box repo workdir candidates, in probe order: box-relative names first
 * (the canonical HOME-relative layout since F3 — fill clones to `src`, the
 * key lands `app/.env`), then the legacy absolute spellings as fallbacks for
 * boxes provisioned by earlier builds. An explicit `deps.workdir` replaces
 * the whole list.
 */
// ponytail: relative-first, but the absolute fallbacks can still probe HOST
// dirs when the fake substrate executes scripts on the host and the repo lives
// elsewhere — a substrate-aware probe is the real fix if that ever bites.
const DEFAULT_WORKDIRS = ["app", "src", "/home/agent/app", "/home/agent/src"];
// F3 (2026-08-24): the relative entries are canonical now (HOME-relative
// defaults); the absolute spellings stay as legacy-box fallbacks.

/**
 * DF1.10 AC4 — the tmpfs half of the durability split, and the ONE place the
 * literal lives host-side. It mirrors `runMarkerRoot()`'s in-box default
 * (src/phase-engine/journal.ts): the engine leaves `journal/final.json` and
 * `trace/{trace.db,events.jsonl}` under it, a reboot wipes all three, and this
 * tar is the only thing that carries them off the box.
 *
 * Not imported from journal.ts on purpose: that function answers "where does
 * THIS process write its marker" by reading $QDS_RUN_ROOT off the HOST's env,
 * and the answer harvest needs is "where did the ENGINE write it, in the box".
 * A host that happens to export QDS_RUN_ROOT must not redirect the box probe.
 */
export const BOX_RUN_ROOT = "/run";

/**
 * The run's root INSIDE the box, per-run since #217 F-D1 — the host-side
 * mirror of `journal.ts`'s `runMarkerRoot(runId)` layout
 * (`<BOX_RUN_ROOT>/qds-run/<runId>`), which the unit's
 * `RuntimeDirectory=qds-run/%i/{journal,trace}` creates. Deliberately NOT a
 * call into `runMarkerRoot` itself: that function reads the HOST's
 * `QDS_RUN_ROOT` (a test seam), and the answer here must be where the ENGINE
 * wrote in the box, immune to a host-side export. Same rule, different
 * derivation — `assertRunIdPathComponent` (also journal.ts's) keeps the two
 * honest, and `tests/fleet/fanout-primitive.test.ts` pins the agreement.
 */
export function boxRunRoot(runId: string): string {
  assertRunIdPathComponent(runId);
  return `${BOX_RUN_ROOT}/qds-run/${runId}`;
}

/**
 * DF1.10 AC4 — the ext4 half. Names probed under the box user's `$HOME`, which
 * is resolved IN THE BOX (see artifactsScript's `$3` default) because the host
 * has no business guessing it. `<n>` in the solicit names is the resident's
 * per-call sequence number, so those two are globs and everything else is a
 * literal; each is skipped silently when absent (a run that solicited nothing
 * has no prompt/reply pair, and that is not a harvest failure).
 *
 * Every name is runId-prefixed, which is load-bearing rather than cosmetic:
 * these land as TOP-LEVEL entries beside the checkout's own `run.log` /
 * `trace.db`, and a duplicate entry name makes the host validator reject the
 * whole archive (see the tar validator's duplicate-path check). The prefix is
 * what guarantees they cannot collide.
 *
 * GRAMMAR DEPENDENCY, stated because the glob mechanics are invisible in this
 * list. Only the UNQUOTED `-solicit-*` segment of each word is glob-active:
 * `$runId` sits inside double quotes, and a quoted parameter expansion is not
 * subject to pathname expansion, so a `*`/`?`/`[` arriving VIA the id would be
 * inert even if the grammar allowed it (round 4 corrected this comment — it
 * used to claim the quoted id itself could glob). The runId grammar is still
 * load-bearing for the no-collision invariant this docstring rests on:
 * `assertValidRunId`/`assertExistingRunId` (run-record.ts) bar those
 * characters, and `pullArtifacts` re-asserts the id at the boundary before it
 * becomes argv — defence in depth, because the invariant then holds by
 * construction rather than by quoting, and a future edit that drops the
 * quotes around `$runId` fails closed instead of silently matching other
 * runs' files.
 *
 * Only the solicit sequence number is a glob. The engine log was briefly
 * `<runId>*.log` as insurance against the engine side picking a different
 * spelling; `scripts/pipeline-run.ts` now writes `<runId>.engine.log` and the
 * glob is gone, because it was the ONE name that could collide: with a run
 * literally called `run`, `<runId>*.log` matches `$HOME/run.log` and stores
 * `run.log`, which is already the checkout's own source. Exact suffixes make
 * the no-collision argument a property of the list instead of a case check.
 */
const BOX_HOME_SOURCES = [
  '"$home/$runId".resident.jsonl',
  '"$home/$runId".journal.jsonl',
  '"$home/$runId".engine.log',
  '"$home/$runId"-solicit-*-prompt.txt',
  '"$home/$runId"-solicit-*-reply.txt',
];

/**
 * DF1.10 AC4 — names UNDER the tmpfs run root, kept with their `journal/` and
 * `trace/` prefixes deliberately. Flattening `trace/trace.db` to `trace.db`
 * (the obvious reading) would collide with the checkout's own `trace.db`,
 * already one of the five inkwell sources below, and a duplicate path makes
 * the validator reject the ENTIRE archive rather than just that entry — so on
 * any box that has both, harvest would fail outright and take the marker down
 * with it. They are still relative names re-rooted by `-C`; the prefix only
 * namespaces them.
 *
 * `trace.db-wal` rides along because the marker does NOT imply a checkpointed
 * DB. `pipeline-run.ts` writes the per-run `<runRoot>/journal/final.json` (#217 F-D1), then makes
 * a run-end resident solicitation at `:2600` — a real model round trip — and
 * only reaches `tracer.close()`, which runs `PRAGMA wal_checkpoint(TRUNCATE)`,
 * at `:2649`. Anything that harvests on seeing the marker (DF3.7's completion
 * observer) can therefore arrive while the tail of the run is still in
 * `trace.db-wal`; and `tracer.close()` is deliberately guarded so that even a
 * clean exit does not guarantee the checkpoint ran. Taking `trace.db` alone
 * yields a database missing the rows describing how the run ended. Absent
 * sidecars are skipped like any other optional source, so this costs nothing
 * on the checkpointed path.
 *
 * `trace.db-shm` is deliberately NOT here, and its absence is load-bearing
 * rather than an oversight. The shm is a transient shared-memory INDEX into
 * the wal, meant to be rebuilt from the wal on the next open; it carries no
 * rows. The three files are read by tar at three different instants while
 * sqlite may still be writing, so a stale shm archived beside a newer db/wal
 * pair is the one member that can actively MISLEAD recovery rather than merely
 * being incomplete. Shipping db + wal and letting sqlite rebuild the index is
 * strictly safer than shipping a snapshot of the index itself.
 *
 * The script also attempts a best-effort `PRAGMA wal_checkpoint(TRUNCATE)`
 * before tarring (see `artifactsScript`), which narrows the torn-tail window;
 * the wal stays in the list because that attempt is allowed to fail (no
 * sqlite3 on the box, a busy writer) and must not become a harvest failure.
 * The attempt is BOUNDED (`.timeout 3000` in the script): an unbounded
 * checkpoint against a live writer used to hang on the lock until the
 * transport's 120 s exec ceiling killed the whole pull.
 */
const BOX_RUN_SOURCES = [
  "journal/final.json",
  "trace/trace.db",
  "trace/trace.db-wal",
  "trace/events.jsonl",
];

/**
 * The five inkwell sources, relative to the in-box checkout. FIXED NAMES, never
 * a glob — that is what bounds the customer-controlled half of the archive.
 *
 * NO-COLLISION INVARIANT over all three source lists. Two entries with the same
 * name, or a file where another entry needs a directory, makes the host
 * validator reject the WHOLE archive, so this has to hold by construction
 * rather than by luck. Compare FIRST path components:
 *
 *  - checkout → {specs, app_docs, adws, trace.db, run.log}. `specs`/`app_docs`
 *    are directories and everything tar recurses out of them is prefixed
 *    `specs/` or `app_docs/`, so customer content — the only untrusted input
 *    here — can never surface a new top-level name. A customer file called
 *    `journal` or `trace` at the checkout root is simply not in this list.
 *  - run root → {journal, trace}. Disjoint from the above by inspection, and
 *    neither is a checkout FILE name, so the directories they imply cannot hit
 *    the file-vs-directory conflict either (`trace.db` is not `trace`).
 *  - home → `<runId>` + one of {.resident.jsonl, .journal.jsonl, .engine.log,
 *    -solicit-<n>-prompt.txt, -solicit-<n>-reply.txt}. Every one carries a
 *    suffix, so none can equal a bare `specs`/`app_docs`/`adws`/`journal`/
 *    `trace`; no other list member ends in `.jsonl` or `.txt`; and the only
 *    `.log` elsewhere is `run.log`, which `<runId>.engine.log` cannot equal.
 *
 * Adding a source means re-checking those three sets, not just the neighbours.
 */
const BOX_WORKDIR_SOURCES = ["specs", "app_docs", "adws/adw_data/ssmf.db", "trace.db", "run.log"];

export class HarvestError extends ProviderError {
  /**
   * Typed dead-box signal: set by the wrap points that saw the seam's
   * no-such-box marker in RAW driver output — immune to the sanitizer's
   * first-line/200-char shaping of the wrapped message. Teardown branches on
   * this via isNoSuchBox, never on wrapped message text from another module.
   */
  readonly noSuchBox: boolean;

  constructor(code: string, message: string, remediation: string, opts: { noSuchBox?: boolean } = {}) {
    super(code, message, remediation);
    this.name = "HarvestError";
    this.noSuchBox = opts.noSuchBox ?? false;
  }
}

/**
 * Untrusted box output bounded + credential-redacted before it touches an
 * error message (the message lands in the run log and the operator's
 * terminal). First line only, hard 200-char cap, and any sk-…-style token
 * is replaced — a compromised workload must not be able to exfiltrate the
 * run key through a failure's diagnostics.
 */
export function sanitizeBoxOutput(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const capped = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  return capped
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    // ponytail: heuristic entropy redaction, not proof — a ≥40-char token with
    // an upper AND a lower AND a digit stands in for "encoded key". The
    // mixed-class requirement is what keeps plain lowercase-hex git shas
    // visible (AC2 must still name the missing prerequisite).
    // Upgrade trigger: when a secret list reaches this path — match against it
    // and keep this heuristic only as the fallback for unlisted shapes.
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, (tok) =>
      /[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok) ? "[REDACTED]" : tok,
    )
    .trim();
}

/**
 * The seam's only box-gone marker. The driver contract has no structured
 * not-found code (the fake driver throws `no such box: <vm>`; exedev returns
 * a non-zero exit whose stderr embeds it), so raw-text detection at harvest's
 * wrap points IS the seam interpretation — done here, once, while the driver
 * output is still unsanitized.
 */
const NO_SUCH_BOX = "no such box";

const boxGone = (raw: string): boolean => raw.includes(NO_SUCH_BOX);

/**
 * Dead-box detector for teardown's box-step skip. Prefers the typed
 * HarvestError.noSuchBox flag (computed on raw seam output at the wrap point,
 * before sanitizeBoxOutput can truncate the marker out of the message) and
 * falls back to the message only for raw driver throws that never passed
 * through a harvest wrap point.
 */
export function isNoSuchBox(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // A HarvestError is classified SOLELY by its typed flag: every wrap point
  // that embeds driver output computes it on RAW seam text, so a flagged-false
  // HarvestError whose sanitized message merely happens to carry the marker
  // from another context must not route teardown into the box-gone skip
  // (that skip bypasses nothing — but it must reflect the seam, not a quote).
  if (e instanceof HarvestError) return e.noSuchBox;
  return e.message.includes(NO_SUCH_BOX);
}

/**
 * Best-effort cleanup for catch/finally paths, shared with teardown: a
 * cleanup failure must never replace the real error (or a successful
 * return). rmSync's `force` suppresses only ENOENT — EPERM/EACCES/EISDIR
 * still throw, and a bare rmSync in a catch block would mask the typed
 * error and its noSuchBox classification.
 */
export function rmBestEffort(path: string, opts: { recursive?: boolean } = {}): void {
  try {
    rmSync(path, { force: true, ...opts });
  } catch {
    // Cleanup failure is non-fatal — the original error is the story.
  }
}

/**
 * Injectable host-git runner — tests spy ordering + inject failures.
 * An injected gitRunner MUST reproduce bunGitRunner's LC_ALL=C/LANG=C env — the AC2
 * missing-sha extraction matches git's C-locale "error: <sha>" grammar, so a
 * localized runner silently misclassifies missing-prerequisite as bundle-verify-failed.
 */
export type GitRunner = (argv: readonly string[], cwd: string) => Promise<ExecResult>;

/**
 * Hard ceiling per host-git call — the same bound + signal the seam's
 * sshCommand enforces (transport.ts): a hung host git (gpg agent prompt, wedged
 * fs) must die, not hang harvest forever.
 */
const GIT_TIMEOUT_MS = 120_000;

/** Default GitRunner: Bun.spawn with an argv ARRAY — never a shell string. */
export const bunGitRunner: GitRunner = async (argv, cwd) => {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd,
    // C locale or the "error:"-line grammar (AC2's missing-sha extraction) is
    // at the mercy of the host's locale — a localized git spells failures
    // differently and the parse silently misses.
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const kill = () => {
    proc.kill(9);
  };
  const [{ text: stdout }, { text: stderr }, exitCode] = await Promise.all([
    readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
    readBounded(proc.stderr, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export interface HarvestDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Propagated from the dispatch that created the run (§5.2). */
  requestId?: string;
  /** Host repo the fetch lands in. Default: process.cwd(). Must be a git repo. */
  gitCwd?: string;
  gitRunner?: GitRunner;
  /** Overrides the runs root (tests). Default: $QDS_RUNS_DIR or .sandbox/runs. */
  runsDir?: string;
  /** In-box repo workdir (see DEFAULT_WORKDIRS). */
  workdir?: string;
  /**
   * AC4's tmpfs root, in the box. Default BOX_RUN_ROOT ("/run"). A test seam
   * in the same spirit as `workdir`: the fake substrate runs the artifacts
   * script on the HOST, so without it a suite would probe the host's real
   * /run. Production never sets it. Must be ABSOLUTE and non-blank when
   * present — see `assertBoxRootSeam`.
   */
  boxRunRoot?: string;
  /**
   * AC4's persistent root, in the box. Default: unset, which makes the script
   * resolve `$HOME` in the box — the host cannot know the box user's home and
   * must not guess. Overridable for the same fake-substrate reason as
   * `boxRunRoot`. Production never sets it. Must be ABSOLUTE and non-blank
   * when present — see `assertBoxRootSeam`; a blank one is a THROW, never a
   * silent fall-back to the box's own `$HOME`.
   */
  boxHome?: string;
  /**
   * DF5.3: the audit emit seam, required so an unwired construction fails at
   * compile time. `harvestRun` is its own composition surface — its
   * bundle-verify and bundle-fetch emits live HERE, on `HarvestDeps`, and the
   * `TeardownDeps` callers reach it by forwarding their own required field.
   */
  recordAuditLink: (link: ProviderAuditLink) => void;
}

export type HarvestResult =
  | { outcome: "harvested"; count: number; tip: string }
  | { outcome: "none" };

export interface ArtifactsOutcome {
  /** "failed" is a summary-log-only value: pullArtifacts THROWS on failure. */
  artifacts: "none" | "pulled" | "failed";
  files?: number;
}

// ─── observability ───────────────────────────────────────────────────────────

type HarvestStep = "bundle_create" | "transfer" | "verify" | "fetch" | "artifacts";

function stepCtx(deps: HarvestDeps, runId: string): StepCtx {
  return { requestId: deps.requestId ?? newRequestId(), runId, driver: deps.driver.name };
}

/** Harvest's outcome vocabulary for the shared step logger (step-log.ts). */
const STEP_LABELS = { ok: "ok", error: "error", errorCode: "harvest_error" };

/** One timed, logged harvest step — credentials.ts `timed` shape. */
function timedStep<T>(
  ctx: StepCtx,
  step: HarvestStep,
  fn: () => Promise<T>,
  extra?: (durationMs: number) => Record<string, unknown>,
): Promise<T> {
  return timedLoggedStep(ctx, "harvest", step, STEP_LABELS, fn, extra);
}

function logPreflightError(ctx: StepCtx, err: HarvestError): void {
  log({
    ...stepBase(ctx, "harvest", "preflight"),
    duration: 0,
    durationMs: 0,
    status: "error",
    error: { code: err.code, message: err.message },
    remediation: err.remediation,
    outcome: "error",
  });
}

// ─── paths + script assembly ─────────────────────────────────────────────────

function resolveRunsDir(deps: HarvestDeps): string {
  // The store's exported chain, not a restated `?? env ?? default`: the local
  // copy predated the empty-`QDS_RUNS_DIR` fold in resolveRunsDir and would
  // have kept resolving an exported-unset variable to cwd.
  const dir = deps.runsDir ?? resolveExportedRunsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function workdirList(deps: HarvestDeps): readonly string[] {
  const wd = deps.workdir;
  if (wd === undefined) return DEFAULT_WORKDIRS;
  // The workdir is interpolated into a shell script: same grammar as
  // credentials.ts assertEnvFileSafe — fail closed on metacharacters.
  // F034: shared grammar, unchanged message. Newly refused: "a//b", a trailing
  // slash, a leading "-".
  try {
    assertPlainBoxPath("workdir", wd);
  } catch {
    throw new HarvestError(
      "workdir-invalid",
      `workdir ${JSON.stringify(wd)} is not a plain path (charset [A-Za-z0-9._/-], no ".." segments)`,
      "pass an in-box path without shell metacharacters",
    );
  }
  return [wd];
}

/**
 * Step A script (inkwell harvest.just:54-83). $1 = FILL-pinned base sha,
 * $2 = run branch. stdout is EXACTLY one protocol line (OK/NOREPO/NOCOMMITS/
 * BUNDLEFAIL); everything else git prints goes to stderr so untrusted box
 * chatter can never forge or smudge the protocol line. Unknown base in-box
 * makes rev-list fail under `set -euo pipefail` — a real failure, not AC2
 * (which is host-side verify): the script dies, exec exits non-zero.
 */
function remoteScript(workdirs: readonly string[]): string {
  return `
set -euo pipefail
base="$1"; branch="$2"
wd=""
for d in ${workdirs.join(" ")}; do
  if [ -d "$d/.git" ]; then wd="$d"; break; fi
done
if [ -z "$wd" ]; then echo "NOREPO"; exit 0; fi
cd "$wd"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOREPO"; exit 0; }
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 || git branch "$branch" >&2
count=$(git rev-list --count "$base..refs/heads/$branch")
if [ "$count" -eq 0 ]; then echo "NOCOMMITS"; exit 0; fi
git bundle create ../harvest.bundle "$base..refs/heads/$branch" >&2 || { echo "BUNDLEFAIL"; exit 0; }
tip=$(git rev-parse "refs/heads/$branch")
# Byte size of the staged bundle, so the host can refuse an over-cap copy
# before streaming a single byte across the seam. Arithmetic collapses any
# wc padding.
bytes=$(( $(wc -c < ../harvest.bundle) ))
printf 'OK %s %s %s\\n' "$tip" "$count" "$bytes"
`.trim();
}

/**
 * Step E script (inkwell's artifacts set + trace.db, plus DF1.10 AC4's
 * durability sources). Three roots feed one tar:
 *
 *  - the in-box checkout (`$wd`, probed exactly as Step A probes it — `[ -d
 *    "$d/.git" ]`, the SAME `.git`-presence predicate, because
 *    DEFAULT_WORKDIRS probes `app` first and `app/` also exists on every
 *    standard box as the key directory; a bare `[ -d "$d" ]` probe made the
 *    key dir win over the checkout and the five names silently never
 *    collected): the five inkwell names, entry-named bare, unchanged since
 *    DF2.5.
 *  - tmpfs `$runRoot` (`/run`): the terminal marker and the trace sidecar. A
 *    reboot wipes them, so this tar is the only thing that gets them out.
 *  - ext4 `$home`: the durable journal, the resident session, its redacted
 *    prompt/reply artifacts and the engine's stderr log — the audit evidence
 *    INV-IBOX-8 requires to survive the box.
 *
 * EVERY source is handed to tar as a `-C <dir> <relative-name>` pair, never as
 * an absolute path, and that is the whole design. Given an absolute member tar
 * strips the leading "/" itself and stores `run/journal/final.json` /
 * `home/exedev/<runId>.resident.jsonl` — names that pollute the archive layout
 * and can collide with real relative entries. `-C` re-roots each source BEFORE
 * tar writes the header, so the host-side entry-name guard below never has to
 * see an absolute name and is not relaxed to accept one.
 *
 * Portability, stated precisely rather than optimistically: GNU tar and bsdtar
 * both honour REPEATED `-C` POSITIONALLY — each one applies to the members
 * after it — which is the property this depends on. (busybox tar accepts `-C`
 * but treats it as a plain option, so only one would take effect; the image is
 * Ubuntu-derived and ships GNU tar, and the fake-substrate suite exercises the
 * bsdtar path on macOS.) `--transform` would be the GNU-ONLY alternative and
 * is not needed.
 *
 * Repeated `-C` is also CUMULATIVE for a RELATIVE directory: each one chdirs
 * from wherever the previous one left tar, so `-C app -C run` lands in
 * `app/run`, not `run`. The first pair here is `-C "$wd"`, and `$wd` is
 * normally the relative `app`/`src` — so the two that follow it would silently
 * resolve underneath the checkout if they were relative, collect nothing, and
 * read as "the run produced no artifacts". `pullArtifacts` therefore REFUSES a
 * relative `boxRunRoot`/`boxHome` at the boundary (production's `/run` and the
 * box's own `$HOME` are absolute; only the fake-substrate seam could supply a
 * relative one), which is what makes the ordering here free of hazard.
 *
 * Symlinks are DROPPED, not followed and not stored — at the LEAF. Every
 * source test below carries `[ ! -L … ]`, and tar is still invoked without
 * `-h`, so the two halves agree: a workload that plants
 * `$HOME/<runId>.engine.log` (or the checkout's own `run.log`) as a link to
 * `app/.env` neither gets the run key dereferenced into the archive nor gets
 * a link entry stored. SCOPE, stated because the leaf test is all `-L` ever
 * promises: an INTERMEDIATE component of a multi-segment source (`adws` in
 * `adws/adw_data/ssmf.db`) replaced by a directory symlink still traverses —
 * `-L` tests only the final component, so content from outside the checkout
 * can ride in under a whitelisted name. The exfil power of that residual is
 * ~none (the workload can copy anything into a whitelisted leaf directly);
 * it is an honesty limit of this invariant, not a capability gap — the
 * no-dereference guarantee for the run key holds because every run-key path
 * (`app/.env`) would have to appear as a LEAF to be collected.
 *
 * Dropping rather than storing is a DELIBERATE CHANGE from "store the link and
 * let the host validator refuse the whole archive". That refusal was described
 * as loud and fail-closed, and it was — but AC4 made the artifacts pull
 * teardown's step 2, so the refusal aborted teardown BEFORE `destroy` and left
 * a box billing forever, which the aged-record reaper then re-aborted through
 * the same path on every sweep. One workload-authored symlink in the
 * `-solicit-*` globs (the first unbounded, workload-controlled name space in
 * the set) was enough. A dropped source costs one artifact; an undestroyable
 * box costs money without bound.
 *
 * Absence of EVERY source is a no-op (`NOARTIFACTS`), not a failure. Absence
 * of an INDIVIDUAL source is skipped silently — a run that solicited nothing
 * has no prompt/reply pair, a run that never reached the engine has no marker.
 * The two are distinguished on the wire: `NOARTIFACTS` means nothing was
 * collected and no tar exists, `TARBUILT <name> <n>` means one does — `<name>`
 * is THIS pull's unique tar, which the host then copies back by, so concurrent
 * pulls of one runId never share an in-box file. INV-5's
 * fail-closed still applies to real failures — a missing tar binary exits
 * non-zero and IS one.
 *
 * `runId`, `$runRoot` and `$home` arrive as POSITIONAL ARGUMENTS. Nothing
 * caller-controlled is interpolated into this text; the only interpolation is
 * the workdir list, which `workdirList` has already grammar-checked.
 */
function artifactsScript(workdirs: readonly string[]): string {
  return `
set -eu
runId="$1"
runRoot="\${2:-${BOX_RUN_ROOT}}"
# The box user's home, resolved HERE — the host cannot know it.
home="\${3:-$HOME}"
# Absolute, so the archive lands in the login dir whatever -C does later and
# whether or not $wd is one of the legacy ABSOLUTE candidates. UNIQUE PER PULL
# (pid-suffixed): the fixed name made two concurrent pulls of one runId (an
# operator teardown racing a reaper sweep) write ONE shared tar — the in-box
# half of the race P40 closed host-side. The basename rides the TARBUILT line
# so the host copies back by THIS pull's name, which scp resolves against that
# same login dir (P39, round 4: even a $wd that EQUALS $PWD cannot make tar
# read its own growing output — the checkout half's sources are five FIXED
# names and no harvest-artifacts name is ever one of them).
out="$PWD/harvest-artifacts.tgz.$$"
args=()

wd=""
# P32 (round 4): the probe requires "$d/.git", mirroring Step A literally. The
# old directory-existence probe made DEFAULT_WORKDIRS's "app"-first order pick
# the KEY directory (dispatch creates app/ for app/.env) over the checkout
# (src/) on every standard box — the five checkout names were then probed
# under app/, found nothing, and skipped silently while TARBUILT still
# reported success.
for d in ${workdirs.join(" ")}; do
  if [ -d "$d/.git" ]; then wd="$d"; break; fi
done
if [ -n "$wd" ]; then
  names=()
  for n in ${BOX_WORKDIR_SOURCES.join(" ")}; do
    if [ -e "$wd/$n" ] && [ ! -L "$wd/$n" ]; then names+=("$n"); fi
  done
  if [ \${#names[@]} -gt 0 ]; then args+=(-C "$wd" "\${names[@]}"); fi
fi

# Best effort, never fatal: fold the wal back into the DB so the two are read
# by tar in agreement. A box with no sqlite3, a busy writer, or a trace.db that
# is not a database at all must not turn artifact collection into a failure —
# the wal is tarred either way, so a skipped checkpoint costs nothing.
if [ -f "$runRoot/trace/trace.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  # .timeout 3000 (sqlite3's busy_timeout): without a bound, a TRUNCATE
  # checkpoint against a still-writing engine blocks on the lock until the
  # transport's 120 s exec ceiling SIGKILLs the whole script — converting this
  # best-effort fold into a fatal artifacts-failed. 3 s of retry, then the
  # trailing "|| true" gives up and the wal is tarred anyway (BOX_RUN_SOURCES
  # ships it for exactly this window).
  sqlite3 "$runRoot/trace/trace.db" '.timeout 3000
PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
fi

names=()
for n in ${BOX_RUN_SOURCES.join(" ")}; do
  if [ -f "$runRoot/$n" ] && [ ! -L "$runRoot/$n" ]; then names+=("$n"); fi
done
if [ \${#names[@]} -gt 0 ]; then args+=(-C "$runRoot" "\${names[@]}"); fi

names=()
for f in ${BOX_HOME_SOURCES.join(" ")}; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then names+=("\${f##*/}"); fi
done
if [ \${#names[@]} -gt 0 ]; then args+=(-C "$home" "\${names[@]}"); fi

if [ \${#args[@]} -eq 0 ]; then echo "NOARTIFACTS"; exit 0; fi
# P33 (round 4): tar's stderr is captured so the ONE documented concurrent
# window can be tolerated. set -e used to kill the script on any nonzero
# tar exit, and GNU tar exits 1 with "file changed as we read it" when a
# source is appended mid-read (the trace.db-wal tail race BOX_RUN_SOURCES
# documents) — a COMPLETE tarball then sat at $out and was never pulled while
# the run was recorded artifacts-lost and the box destroyed. The grep is
# case-insensitive and alternates spellings: GNU's is measured (the round-4
# regression test prints it), while bsdtar's claimed "file changed size
# during read" could NOT be reproduced on macOS bsdtar 3.5.3 (growth AND
# shrink both archived silently, exit 0; no such string exists in libarchive
# v3.5.3/master sources) — matched on faith as defensive breadth, not
# verified coverage. Tolerated ONLY when the tarball exists AND the stderr
# names that exact condition family; the warning rides stderr so stdout
# stays the exact one-line protocol. Everything else stays fatal
# (fail-closed posture unchanged).
rc=0
tar czf "$out" "\${args[@]}" 2>"$out.$$.err" || rc=$?
if [ "$rc" -ne 0 ]; then
  if [ -s "$out" ] && grep -qiE "file changed (as we read it|size during read)" "$out.$$.err"; then
    echo "TARWARN: tar exited $rc ('file changed as we read it' / 'file changed size during read') — tolerated, the archive may lag a still-appending writer by its last bytes" >&2
  else
    cat "$out.$$.err" >&2
    rm -f "$out.$$.err"
    exit "$rc"
  fi
fi
rm -f "$out.$$.err"
# Name FIRST (this pull's unique tar; basename = the box-relative name
# copyFile needs), bytes SECOND — the host parses both and copies by the name.
echo "TARBUILT \${out##*/} $(( $(wc -c < "$out") ))"
`.trim();
}

// ─── preflight ───────────────────────────────────────────────────────────────

/**
 * sha256 of a file's bytes, streamed in 64 KiB chunks — the bundle can be
 * `BUNDLE_MAX_BYTES` (512 MiB), and hashing it must not buffer the file whole.
 * This is the hop-6 subject digest: the walker recomputes it from the bundle
 * at `<runsDir>/<runId>.bundle` and compares against the `bundle-verify`
 * link's `detail.digest` (story Technical Notes).
 */
function sha256File(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hasher.update(n === chunk.length ? chunk : chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex");
}

/**
 * The DF5.3 bundle link emit (hop 6, run-bundle). The record is the ONLY
 * repoSlug source (DF2.8's budget attribution — never a placeholder); an
 * unattributed run emits nothing, because `audit_links`' columns are NOT NULL
 * and an invented attribution is what INV-AUDIT-4 forbids. `subjectId` is the
 * bundle path, whose presence at `<runsDir>/<runId>.bundle` IS the harvest
 * record (this module's own header).
 */
function emitBundleLink(
  deps: HarvestDeps,
  rec: RunRecord,
  ctx: StepCtx,
  event: string,
  detail: Record<string, unknown>,
): void {
  const repoSlug = auditRepoSlug(rec);
  if (repoSlug === undefined) return;
  emitAuditLink(deps.recordAuditLink, {
    runId: rec.runId,
    repoSlug,
    requestId: rec.requestId ?? ctx.requestId,
    hop: "run-bundle",
    event,
    subjectId: join(resolveRunsDir(deps), `${rec.runId}.bundle`),
    subjectKind: "bundle",
    detail,
  });
}

/**
 * Read a run record with the ONE shared absence/read-failure classification:
 * genuine ENOENT absence → HarvestError "no-record" (+ create-the-run
 * guidance); every other read failure (malformed JSON, EACCES, …) →
 * "record-read-failed" (+ inspect-first guidance — a live box and key may sit
 * behind a record that merely will not parse, and telling the operator to
 * re-create the run would orphan both).
 *
 * Consumed by harvestRun, pullArtifacts, teardownSteps and the CLI's run() —
 * the classification must never drift per call site.
 */
export function getRecord(deps: Pick<HarvestDeps, "store">, runId: string): RunRecord {
  try {
    return deps.store.get(runId);
  } catch (e) {
    // `store.get` throws plain Errors today; normalize anyway — a nullish
    // throw must not escape the classifier as a TypeError.
    const err = e instanceof Error ? e : new Error(String(e));
    // The store signals genuine absence as an errno-annotated unreadable
    // record (readRecord re-attaches the fs error's `code`). Classified by
    // the TYPED code only, never by message text: a malformed record's error
    // message echoes caller-controlled key names ("unknown key: ENOENT"), and
    // a substring match would misroute that present-but-corrupt record into
    // no-record's unsafe create-the-run remediation.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarvestError(
        "no-record",
        `no run record for ${runId}: ${err.message}`,
        "check the run id; records live under $QDS_RUNS_DIR (default .sandbox/runs) — create the run first",
      );
    }
    throw new HarvestError(
      "record-read-failed",
      `run record for ${runId} could not be read: ${err.message}`,
      "inspect the record under $QDS_RUNS_DIR (default .sandbox/runs; permissions, malformed JSON) and repair it in place — a live box and key may sit behind it; do not re-create the run",
    );
  }
}

async function requireHostRepo(gitRunner: GitRunner, gitCwd: string): Promise<void> {
  const res = await gitRunner(["git", "rev-parse", "--show-toplevel"], gitCwd);
  if (res.exitCode !== 0) {
    throw new HarvestError(
      "no-host-repo",
      `${gitCwd} is not a git repository — the quarantine fetch would land nowhere`,
      "run harvest from inside the host git checkout, or point deps.gitCwd at one",
    );
  }
}

// ─── harvest ─────────────────────────────────────────────────────────────────

interface StepA {
  protocol: "OK" | "NOREPO" | "NOCOMMITS";
  tip?: string;
  count?: number;
  /** Box-reported bundle size (pre-copy cap probe; the host stat is authoritative). */
  bytes?: number;
}

export interface HarvestRunOptions {
  /**
   * Ownership signal for the artifact pipeline: teardown pulls artifacts as
   * its own step 2 BEFORE invoking harvestRun, so it passes this to make
   * harvestRun skip its Step E — exactly one artifact pull per successful
   * teardown. Standalone harvestRun calls leave it unset and always pull.
   */
  artifactsOwnedByCaller?: boolean;
}

export async function harvestRun(
  deps: HarvestDeps,
  runId: string,
  opts: HarvestRunOptions = {},
): Promise<HarvestResult> {
  const started = Date.now();
  const ctx = stepCtx(deps, runId);
  const rec = getRecord(deps, runId);
  // inkwell prerequisite: a run that never got a VM has nothing to harvest and
  // no box to pull artifacts from — exit 0 "none", not an error.
  if (!rec.vmName) {
    logSummary(ctx, started, { outcome: "none" }, { artifacts: "none" });
    return { outcome: "none" };
  }
  // A VM without a pinned base (a FILL that died mid-flight) can still hold
  // artifacts: no bundle steps, but Step E runs — the work must not be lost.
  if (!rec.commitSha) {
    const art = opts.artifactsOwnedByCaller ? { artifacts: "none" as const } : await pullArtifacts(deps, runId);
    logSummary(ctx, started, { outcome: "none" }, art);
    return { outcome: "none" };
  }
  const vm = rec.vmName;
  const base = rec.commitSha;
  const branch = `sbx/${runId}`;
  const gitRunner = deps.gitRunner ?? bunGitRunner;
  const gitCwd = deps.gitCwd ?? process.cwd();
  const runsDir = resolveRunsDir(deps);
  const hostBundle = join(runsDir, `${runId}.bundle`);

  try {
    await requireHostRepo(gitRunner, gitCwd);
  } catch (e) {
    const err = e as HarvestError;
    logPreflightError(ctx, err);
    throw err;
  }

  const workdirs = workdirList(deps);

  // Step A — in-box ranged bundle (protocol on stdout).
  const stepA = await timedStep<StepA>(ctx, "bundle_create", async () => {
    const res = await deps.driver.exec(vm, ["bash", "-s", "--", base, branch], remoteScript(workdirs));
    if (res.exitCode !== 0) {
      // rev-list/bundle plumbing died under set -euo pipefail (e.g. the base
      // sha is unknown in-box) — a real failure, box evidence included.
      throw new HarvestError(
        "bundle-create-failed",
        `in-box bundle creation for ${runId} exited ${res.exitCode}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box repo by hand via the driver, then re-run harvest — the box is still alive",
        { noSuchBox: boxGone(res.stderr) },
      );
    }
    const line = res.stdout.trim();
    if (line === "NOREPO" || line === "NOCOMMITS") return { protocol: line };
    if (line === "BUNDLEFAIL") {
      throw new HarvestError(
        "bundle-create-failed",
        `git bundle create failed in-box for ${runId}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box repo by hand via the driver, then re-run harvest — the box is still alive",
      );
    }
    const m = /^OK ([0-9a-f]{40,64}) (\d+) (\d+)$/.exec(line);
    if (!m) {
      // Untrusted box stdout — bounded + redacted first line, never more.
      throw new HarvestError(
        "remote-protocol",
        `unexpected in-box protocol output for ${runId}: ${JSON.stringify(sanitizeBoxOutput(line))}`,
        "inspect the box by hand (stdout broke the harvest protocol), then re-run",
      );
    }
    return { protocol: "OK", tip: m[1] ?? "", count: Number(m[2]), bytes: Number(m[3]) };
  });

  let result: HarvestResult = { outcome: "none" };
  if (stepA.protocol === "OK") {
    // Step B — copy down (box-root-relative remote path; the seam's path guard
    // rejects absolutes on real substrates).
    await timedStep(ctx, "transfer", async () => {
      // Pre-copy size probe: the box reported the bundle's byte count, so a
      // cooperative box never streams an over-cap file at all.
      // F036 closed the exec-output half of this gap: every driver `run` now
      // reads through `readBounded`. What is left is narrower — `copyFile`
      // writes the box's bytes straight to a local PATH, never through our
      // buffers, so the pre-probe bounds cooperative boxes and the post-copy
      // stat bounds hostile ones after the write.
      // ponytail: no cap DURING the copy; a true stream cap needs a
      // driver-seam change (future story), not a reader change.
      if ((stepA.bytes ?? 0) > BUNDLE_MAX_BYTES) {
        throw new HarvestError(
          "bundle-over-cap",
          `box reports harvest.bundle at ${stepA.bytes} bytes, over the ${BUNDLE_MAX_BYTES}-byte cap — refusing the copy`,
          "inspect the bundle in-box via the driver, split the run's work, then re-run harvest",
        );
      }
      try {
        await deps.driver.copyFile(vm, "harvest.bundle", hostBundle);
      } catch (e) {
        // copyFile may reject with a non-Error — coerce, or sanitizeBoxOutput
        // would itself throw on undefined inside this catch.
        rmBestEffort(hostBundle); // partial copy must not linger — the bundle's presence IS the harvest record
        throw new HarvestError(
          "bundle-copy-failed",
          `copying harvest.bundle out of ${vm} failed: ${sanitizeBoxOutput(e instanceof Error ? e.message : String(e))}`,
          "re-run harvest — the box is still alive; if it repeats, copy the bundle out by hand",
          { noSuchBox: boxGone(e instanceof Error ? e.message : String(e)) },
        );
      }
    });

    // Step C — cap, then verify STRICTLY BEFORE FETCH (INV-2). The bundle file
    // is kept on every failure here: it is the only copy of the work.
    await timedStep(ctx, "verify", async () => {
      const size = statSync(hostBundle).size;
      if (size > BUNDLE_MAX_BYTES) {
        throw new HarvestError(
          "bundle-over-cap",
          `bundle ${hostBundle} is ${size} received bytes, over the ${BUNDLE_MAX_BYTES}-byte cap (file kept for inspection)`,
          `inspect ${hostBundle} by hand, split the run's work, then delete it and re-run`,
        );
      }
      const v = await gitRunner(["git", "bundle", "verify", hostBundle], gitCwd);
      if (v.exitCode !== 0) {
        // git names each missing prerequisite on its own "error: <sha>" line
        // (verified against git 2.x): the range IS the integrity check.
        const missing = [...v.stderr.matchAll(/^error: ([0-9a-f]{40,64})/gm)].map((mm) => mm[1] ?? "");
        if (missing.length > 0) {
          throw new HarvestError(
            "missing-prerequisite",
            `host repo lacks prerequisite commit${missing.length > 1 ? "s" : ""} ${missing.join(", ")} required by ${hostBundle} — the box branch does not descend from the FILL-pinned base`,
            "the box branch diverged from the pinned base; inspect refs/sandbox and the box repo by hand before re-running",
          );
        }
        throw new HarvestError(
          "bundle-verify-failed",
          `git bundle verify failed for ${hostBundle}: ${sanitizeBoxOutput(v.stderr)}`,
          `run git bundle verify ${hostBundle} by hand in the host repo, then re-run`,
        );
      }
      // DF5.3: the `bundle-verify` link (hop 6) — emitted the moment the host
      // verify passed. `detail.sha256` is the bundle file's own sha256, the
      // subject the walker re-checks the row against (chain.ts reads
      // `detail_json.sha256` — keep the two names in lockstep).
      emitBundleLink(deps, rec, ctx, "bundle-verify", { sha256: sha256File(hostBundle) });
    }, () => ({ audit: "emitted" }));

    // Step D — fetch into the quarantine namespace ONLY. --force makes a
    // re-harvest update in place instead of failing on non-fast-forward (AC5).
    await timedStep(ctx, "fetch", async () => {
      const f = await gitRunner(
        ["git", "fetch", "--force", hostBundle, `refs/heads/${branch}:refs/sandbox/${runId}`],
        gitCwd,
      );
      if (f.exitCode !== 0) {
        throw new HarvestError(
          "fetch-failed",
          `git fetch from ${hostBundle} into refs/sandbox/${runId} failed: ${sanitizeBoxOutput(f.stderr)}`,
          `run git fetch --force ${hostBundle} refs/heads/${branch}:refs/sandbox/${runId} by hand in the host repo, then re-run`,
        );
      }
      // DF5.3: the `bundle-fetch` link (hop 6) — after the quarantine ref
      // landed. Ordering AC7 asserts is verify ≤ fetch, which this site order
      // guarantees.
      emitBundleLink(deps, rec, ctx, "bundle-fetch", { tip: stepA.tip });
    }, () => ({ audit: "emitted" }));
    result = { outcome: "harvested", count: stepA.count ?? 0, tip: stepA.tip ?? "" };
  } else if (stepA.protocol === "NOCOMMITS") {
    // AC4: an empty range is a successful no-op — no ref, no bundle file left.
    rmSync(hostBundle, { force: true });
  }
  // NOREPO deliberately falls through WITHOUT touching hostBundle: the box
  // holds no repo, but a bundle from an EARLIER harvest is the run's only
  // record (its presence IS the record) and must survive a re-harvest.

  // Step E — artifacts (not gated on commits; runs even when outcome is none).
  // Skipped when the caller (teardown's step 2) already owns the pipeline.
  let art: ArtifactsOutcome;
  try {
    art = opts.artifactsOwnedByCaller
      ? { artifacts: "none" } // the caller's own artifacts step did the pull
      : await pullArtifacts(deps, runId);
  } catch (e) {
    // The fetch already succeeded — the summary must still emit so the run's
    // terminal line exists, mirroring every other terminal path.
    logSummary(ctx, started, result, { artifacts: "failed" });
    throw e;
  }
  logSummary(ctx, started, result, art);
  return result;
}

function logSummary(ctx: StepCtx, started: number, result: HarvestResult, art: ArtifactsOutcome): void {
  const durationMs = Date.now() - started;
  log({
    requestId: ctx.requestId,
    operation: "harvest.summary",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: durationMs,
    status: "ok",
    runId: ctx.runId,
    step: "summary",
    driver: ctx.driver,
    durationMs,
    outcome: "ok",
    harvested: result.outcome === "harvested" ? result.count : "none",
    artifacts: art.artifacts,
  });
}

/**
 * The two AC4 seam roots have to be ABSOLUTE, and the reason is tar's, not a
 * style preference: repeated `-C` is CUMULATIVE for a relative directory (see
 * artifactsScript), and the first `-C` is the normally-RELATIVE `$wd`. A
 * relative `boxRunRoot`/`boxHome` would therefore resolve underneath the
 * checkout, match nothing, and report as "the run produced no artifacts" — a
 * silent total loss of the durability evidence AC4 exists to carry off the box.
 *
 * Blank is refused for the OTHER half of the same asymmetry: the script's
 * `${2:-…}`/`${3:-…}` defaults treat an empty argument as a value (so it does
 * NOT fall back), while the real driver refuses an argv carrying an empty or
 * whitespace-only element outright (`empty-argv`). A seam that was SET must
 * never be silently discarded either — a fake-substrate suite would then probe
 * the host's real `/run` and `$HOME` and pass its assertions against the wrong
 * root. Absent (`undefined`) stays the way to ask for the default.
 *
 * PADDED absolutes (`"/run "`, `"/run\n"`) are refused with them (DF1.10
 * review round 3, C2-1): `trim()`-based blankness is false and the leading
 * "/" is real, so the padded value used to ship VERBATIM as its argv element
 * and the in-box probe matched nothing under a root that does not exist —
 * every source beneath it silently missing from the archive, the same
 * total-loss outcome as a relative root wearing an absolute path.
 *
 * Round 4 (P34) widened the same door: the trim check could only ever see
 * LEADING/TRAILING whitespace, so an INTERIOR space, tab or invisible (ZWSP,
 * SHY, word-joiner — none of which `trim()` removes even at the edges) passed
 * and shipped verbatim, and `..` segments (`/run/../home`) rode the absolute
 * check to probe a root the caller never meant — both through to the same
 * silent-empty archive. The value now goes through `assertPlainBoxPath`'s
 * grammar FIRST (charset `[A-Za-z0-9._/-]` bars every whitespace, invisible
 * and non-ASCII character wherever it sits, and refuses `..` segments), with
 * the absolute-path requirement kept on top of it.
 */
function assertBoxRootSeam(field: "boxRunRoot" | "boxHome", value: string | undefined): void {
  if (value === undefined) return;
  try {
    assertPlainBoxPath(field, value);
  } catch {
    throw new HarvestError(
      "box-root-invalid",
      `${field} ${JSON.stringify(value)} is not a plain box path (charset [A-Za-z0-9._/-], no ".." segments, no whitespace or invisible characters anywhere in it) — an interior space/ZWSP or a ".." hop ships verbatim as argv and probes a root the caller never meant, silently collecting nothing`,
      `pass an absolute in-box path for ${field} drawn from [A-Za-z0-9._/-], or omit it entirely to take the in-box default`,
    );
  }
  if (!value.startsWith("/")) {
    throw new HarvestError(
      "box-root-invalid",
      `${field} ${JSON.stringify(value)} must be ABSOLUTE — tar's repeated -C is cumulative, so a relative root resolves under the workdir and collects nothing, the silent total-loss outcome this guard exists to prevent`,
      `pass an absolute in-box path for ${field}, or omit it entirely to take the in-box default`,
    );
  }
}

/**
 * Artifacts-only pull (teardown's step 2; harvestRun's last step). Validates
 * the tgz before extracting a byte (INV-3) and is idempotent: the destination
 * is rebuilt, never merged, so a re-pull leaves no stale files.
 */
export async function pullArtifacts(deps: HarvestDeps, runId: string): Promise<ArtifactsOutcome> {
  const ctx = stepCtx(deps, runId);
  // P36 (round 4): these three preflight asserts used to throw BEFORE any
  // step wrapper existed, so a bad seam or bad id produced NEITHER an ok nor
  // an error "artifacts" step line — a hole in the step stream that only
  // teardown's artifacts-failed line recorded. They now emit their own error
  // step line (duration 0 — nothing was evaluated, the same convention as the
  // never-evaluated no-box arm below) before re-throwing.
  try {
    assertBoxRootSeam("boxRunRoot", deps.boxRunRoot);
    assertBoxRootSeam("boxHome", deps.boxHome);
    assertExistingRunId(runId);
  } catch (e) {
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    log({
      ...stepBase(ctx, "harvest", "artifacts"),
      duration: 0,
      durationMs: 0,
      status: "error",
      error: { code: err.code ?? "preflight", message: err.message ?? String(e) },
      remediation: err.remediation ?? "fix the seam or run id named above, then re-run",
      outcome: "error",
    });
    throw e;
  }
  // (The `assertExistingRunId` inside that try is the boundary re-assertion
  // documented in BOX_HOME_SOURCES' grammar note: the id reaches a GLOB
  // CONTEXT inside the script, so the grammar is re-proven at the argv
  // boundary — the LEGACY grammar, matching every other read path.)
  const rec = getRecord(deps, runId);
  if (!rec.vmName) {
    // DF1.10 Observability Contract: "A path never evaluated reports 0." No
    // box was ever created, so there is no pull to time — but the step's line
    // still exists and still carries the key a consumer greps, so the missing
    // box is visible in the same stream as a real pull instead of as a hole
    // between the neighbouring step lines.
    log({
      ...stepBase(ctx, "harvest", "artifacts"),
      duration: 0,
      durationMs: 0,
      status: "ok",
      outcome: "ok",
      harvest_pull_ms: 0,
      artifacts: "none",
      reason: "no box was ever created for this run",
    });
    return { artifacts: "none" };
  }
  const vm = rec.vmName;
  const runsDir = resolveRunsDir(deps);
  const dest = join(runsDir, `${runId}-artifacts`);
  // P40 (round 4): the staging tgz is UNIQUE PER CALL. The fixed
  // `<runId>-artifacts.tgz` name made two concurrent pulls of one runId (an
  // operator teardown racing a reaper sweep) interleave bytes into one file —
  // a gzip validator failure on one racer that is really a lost bundle, since
  // teardown's artifacts step is non-fatal and proceeds to destroy. The FINAL
  // dest dir keeps its stable name: that is what teardown and later reads
  // consume, and the rm+rename in validateAndExtractTgz serializes the last
  // writer into a single valid tree. The legacy fixed name is still swept on
  // every terminal arm so a pre-change pull's stale tgz cannot linger.
  const staging = join(runsDir, `${runId}-artifacts-${randomUUID()}.tgz`);
  const legacyStaging = join(runsDir, `${runId}-artifacts.tgz`);

  return timedStep(
    ctx,
    "artifacts",
    async () => {
    // runId/roots ride argv, never the script text (see artifactsScript).
    //
    // THE THIRD ARG IS OMITTED, NOT EMPTIED, and that distinction is a live-only
    // defect this line used to carry. It read `deps.boxHome ?? ""`, with a
    // comment explaining that "the empty third arg is what makes the script
    // resolve `$HOME` in the box" — true of the SCRIPT (`home="${3:-$HOME}"`
    // defaults on an empty value) and false of the DRIVER, which refuses any
    // argv carrying an empty or whitespace-only element:
    //
    //   ExeDevDriverError: exec requires a non-empty argv with no empty or
    //   whitespace-only elements   (code "empty-argv", driver.ts:1235 and :1249)
    //
    // That guard was added in DF2.10's review rounds 6-7 — after this idiom was
    // written — so the two have contradicted each other ever since, and NOTHING
    // static could see it: the FakeDriver every unit test runs against does not
    // implement the check, so 5154 tests pass over an argv the real driver
    // rejects on sight. It surfaced on the first live tier-1 round, where it
    // failed artifact collection and cascaded into four more red tests through
    // `harvest_waived` teardowns (exit 6) that the callers assert as 0.
    //
    // Omitting the element preserves the ORIGINAL intent exactly: `$3` unset
    // makes `${3:-$HOME}` take the box's own `$HOME`, which is the whole point —
    // the host cannot know it. `set -u` is safe here because a `${x:-default}`
    // expansion is defined on an unset parameter.
    //
    // BOTH seams are normalised the same way, and the asymmetry that used to
    // sit here was itself a defect in the same family: `deps.boxRunRoot ??
    // BOX_RUN_ROOT` folded only null/undefined, so a `""` was pushed as argv
    // element 2 and re-created the exact `empty-argv` refusal described above,
    // while the `boxHome` line silently DISCARDED a blank value instead. Both
    // shapes are now refused at the top of this function
    // (`assertBoxRootSeam`), which is why the two lines below can be plain.
    const argv = ["bash", "-s", "--", runId, deps.boxRunRoot ?? boxRunRoot(runId)];
    if (deps.boxHome !== undefined) argv.push(deps.boxHome);
    const res = await deps.driver.exec(vm, argv, artifactsScript(workdirList(deps)));
    if (res.exitCode !== 0) {
      throw new HarvestError(
        "artifacts-failed",
        `in-box artifacts tar for ${runId} exited ${res.exitCode}: ${sanitizeBoxOutput(res.stderr)}`,
        "inspect the box's artifacts by hand via the driver, then re-run harvest — the box is still alive",
        { noSuchBox: boxGone(res.stderr) },
      );
    }
    const line = res.stdout.trim();
    if (line === "NOARTIFACTS") {
      // Absent artifacts: neither the host dir NOR a stale staging tgz from an
      // earlier pull may survive (own unique name + the legacy fixed name).
      // rmBestEffort on the LEGACY sweep: cleanup must never mask the verdict
      // (a pre-change pull's leftover can be anything, including a directory).
      rmSync(dest, { recursive: true, force: true });
      rmSync(staging, { force: true });
      rmBestEffort(legacyStaging);
      return { artifacts: "none" };
    }
    const m = /^TARBUILT (\S+) (\d+)$/.exec(line);
    if (!m) {
      throw new HarvestError(
        "remote-protocol",
        `unexpected in-box artifacts protocol output for ${runId}: ${JSON.stringify(sanitizeBoxOutput(line))}`,
        "inspect the box by hand (stdout broke the harvest protocol), then re-run",
      );
    }
    // The box's chosen tar name (unique per pull — see artifactsScript's
    // `out=`). Box-controlled stdout, so it is sanitized in the messages below
    // exactly like any other untrusted seam text; the copyFile itself is
    // path-guarded at the driver seam (FakeDriver resolves-and-checks, exedev
    // refuses non-plain box paths), which is the one place a box-relative name
    // should be judged.
    const tarName = m[1] ?? "";
    // Pre-copy size probe (see the transfer step's ponytail ceiling note).
    if (Number(m[2]) > TAR_MAX_BYTES) {
      throw new HarvestError(
        "tar-over-cap",
        `box reports ${sanitizeBoxOutput(tarName)} at ${m[2]} bytes, over the ${TAR_MAX_BYTES}-byte cap — refusing the copy`,
        "inspect the tar in-box via the driver before re-running; the box is still alive",
      );
    }
    // try/FINALLY, deliberately not one try/catch: a copy failure keeps its
    // "copying … failed" wrap while a VALIDATE failure keeps its own typed
    // code (tar-invalid / tar-over-cap / tar-unsafe-entry) — a single catch
    // would mislabel every validator refusal as a copy failure. The finally
    // is the staging lifecycle fix: the unique tgz used to be removed only on
    // SUCCESS, so a pull that failed at validate left a capped-tar's worth of
    // runsDir noise behind on every failed pull while teardown marched on to
    // destroy. The legacy-name sweep rides the same finally — every terminal
    // arm of this block owes both cleans, best-effort for the legacy leftover
    // for the same reason as the NOARTIFACTS arm.
    try {
      try {
        await deps.driver.copyFile(vm, tarName, staging);
      } catch (e) {
        throw new HarvestError(
          "artifacts-failed",
          `copying ${sanitizeBoxOutput(tarName)} out of ${vm} failed: ${sanitizeBoxOutput(e instanceof Error ? e.message : String(e))}`,
          "re-run harvest — the box is still alive; if it repeats, copy the tar out by hand",
          { noSuchBox: boxGone(e instanceof Error ? e.message : String(e)) },
        );
      }
      const files = await validateAndExtractTgz(staging, dest);
      return { artifacts: "pulled", files };
    } finally {
      rmSync(staging, { force: true });
      rmBestEffort(legacyStaging);
    }
    },
    // DF1.10 Observability Contract (one of the story's four sub-timing keys;
    // scripts/pipeline-run.ts marks the set CONTRACT-PINNED — a consumer
    // greps these exact keys): the artifacts pull reports its real duration
    // as harvest_pull_ms on this step's line, on BOTH outcome arms. The
    // never-evaluated arm is the early return above, which reports 0.
    (durationMs) => ({ harvest_pull_ms: durationMs }),
  );
}

// ─── tar validator (INV-3) ───────────────────────────────────────────────────

const BLOCK = 512;
const ALLOWED_TYPEFLAGS = new Set(["0", "\0", "5"]);
/**
 * Extended-metadata headers, not extractable entries: pax per-file ('x') and
 * global ('g') records (bsdtar emits them for sub-second mtimes), GNU long
 * name/link ('L'/'K'). They are consumed as data and never written — but the
 * `path=`/long-name override they carry for the NEXT entry is re-validated by
 * the same assertPathSafe as a literal name, so metadata cannot smuggle a
 * traversal past the INV-3 gate. Everything else outside {'0','\0','5'} is
 * rejected outright.
 */
const METADATA_TYPEFLAGS = new Set(["x", "g", "L", "K"]);

export interface TarEntryHeader {
  name: string;
  typeflag: string;
  size: number;
}

interface TarHandlers {
  /** Called per header AFTER it passed validation (pass 2 opens its writer). */
  onEntry(header: TarEntryHeader): void;
  onData(chunk: Buffer): void;
  onEntryEnd(): void;
}

function parseOctal(field: Buffer): number {
  // GNU base-256 sizes (high bit of byte 0 set) decode as ascii-masked NULs
  // below and would silently parse as 0, misframing every later block — fail
  // closed instead.
  if (((field[0] ?? 0) & 0x80) !== 0) return Number.NaN;
  const s = field.toString("ascii").replace(/[\0 ].*$/s, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) return Number.NaN;
  return Number.parseInt(s, 8);
}

function nulStr(field: Buffer): string {
  return field.toString("utf8").replace(/\0.*$/s, "");
}

/**
 * Absolute, ".."-segment, backslash-containing and empty names are refused —
 * linknames too. The name is canonicalized (".", "" and repeated "/" segments
 * dropped) so aliases like "./a" vs "a" or "a//b" vs "a/b" cannot slip past
 * the duplicate/ancestor checks in pass 1 and collide as a raw EEXIST
 * mid-extraction in pass 2 — `join(destDir, name)` normalizes, so the
 * validated name must be canonical. A raw backslash is refused BEFORE
 * normalization: on win32 Node treats it as a separator, so `..\evil` would
 * traverse and `a/b` vs `a\b` would collide past the folded-duplicate gate.
 */
function assertPathSafe(kind: "name" | "linkname", raw: string): string {
  const name = raw.replace(/\/+$/, "").split("/").filter((s) => s !== "" && s !== ".").join("/");
  if (name === "" || raw.includes("\\") || raw.startsWith("/") || raw.split("/").includes("..")) {
    throw new HarvestError(
      "tar-unsafe-entry",
      `artifacts tar ${kind} ${JSON.stringify(raw)} is absolute, empty, contains a backslash, or traverses ".." — refusing to extract`,
      "inspect the staging tar by hand before re-running; the box is still alive",
    );
  }
  return name;
}

/**
 * Ancestor directory paths of a validated name: "a/b/c" → ["a", "a/b"].
 * PRECONDITION: input must already be canonicalized (assertPathSafe output — no trailing slash,
 * no empty segments); on a raw "a/b/" it would wrongly include the full path among its own ancestors.
 */
function ancestorsOf(name: string): string[] {
  const out: string[] = [];
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) out.push(name.slice(0, i));
  return out;
}

/**
 * Fold for the pass-1 collision sets: NFC + lowercase. Applied on ALL platforms
 * so pass-2 `wx` never hits a surprise EEXIST from case or NFD variants.
 * ponytail: over-strict on case-sensitive hosts (two legitimately distinct
 * "a.txt"/"A.txt" are refused) — deterministic cross-platform behavior is
 * worth more than per-filesystem exactness here.
 */
const foldName = (n: string): string => n.normalize("NFC").toLowerCase();

interface ParsedHeader {
  rawName: string;
  rawLinkname: string;
  typeflag: string;
  size: number;
}

function parseHeader(block: Buffer): ParsedHeader {
  if (nulStr(block.subarray(257, 262)) !== "ustar") {
    throw new HarvestError("tar-invalid", "artifacts tar entry has no ustar magic", tarRemediation);
  }
  const stored = parseOctal(block.subarray(148, 156));
  if (!Number.isFinite(stored)) {
    throw new HarvestError("tar-invalid", "artifacts tar entry has an unparseable checksum field", tarRemediation);
  }
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i] ?? 0;
  if (sum !== stored) {
    throw new HarvestError("tar-invalid", "artifacts tar entry failed its header checksum", tarRemediation);
  }
  const size = parseOctal(block.subarray(124, 136));
  if (!Number.isFinite(size)) {
    throw new HarvestError("tar-invalid", "artifacts tar entry has an unparseable size field", tarRemediation);
  }
  const prefix = nulStr(block.subarray(345, 500));
  const rawName = prefix ? `${prefix}/${nulStr(block.subarray(0, 100))}` : nulStr(block.subarray(0, 100));
  return { rawName, rawLinkname: nulStr(block.subarray(157, 257)), typeflag: String.fromCharCode(block[156] ?? 0), size };
}

const tarRemediation =
  "inspect the staging tar by hand (tar tvf) before re-running; the box is still alive";

/**
 * Incremental 512-block parser. Data blocks are consumed as they arrive, so
 * memory stays bounded no matter how large an entry claims to be; the caps
 * (decompressed running total, summed entry sizes) are checked here.
 */
function makeTarParser(handlers: TarHandlers, fail: (e: HarvestError) => void): {
  push(chunk: Buffer): void;
  finish(): void;
} {
  let buf = Buffer.alloc(0);
  let inData = false;
  let remaining = 0;
  let pad = 0;
  let sawEof = false;
  let failed = false;
  let total = 0; // decompressed bytes seen
  let summed = 0; // summed declared entry sizes
  const names = new Set<string>();
  const filePaths = new Set<string>(); // accepted regular-file names
  const dirPaths = new Set<string>(); // '5' entry names + implicit ancestors
  let meta: { kind: string; chunks: Buffer[] } | null = null;
  let pendingName: string | null = null; // next-entry override from 'x'/'L'
  let pendingLinkname: string | null = null; // next-entry override from 'K'
  let globalPath: string | null = null; // 'g' default path

  /** Apply a metadata entry's payload once its data blocks are consumed. */
  function applyMetadata(data: Buffer): void {
    if (meta === null) return;
    if (meta.kind === "x" || meta.kind === "g") {
      const matches = [...data.toString("utf8").matchAll(/(?:^|\n)\d+ path=([^\n]*)/g)];
      const path = matches.at(-1)?.[1];
      if (path !== undefined) {
        if (meta.kind === "g") globalPath = path;
        else pendingName = path;
      }
      return;
    }
    const raw = data.toString("utf8").replace(/\0.*$/s, "");
    if (meta.kind === "L") pendingName = raw;
    else pendingLinkname = raw;
  }

  return {
    push(chunk: Buffer): void {
      if (failed) return;
      if (sawEof) {
        // Once EOF is seen, any subsequent non-zero byte is garbage — zero padding to blocking factor is OK.
        if (chunk.some((b) => b !== 0)) {
          failed = true;
          fail(
            new HarvestError(
              "tar-invalid",
              "artifacts tar has non-zero trailing bytes after the EOF block — refusing to extract",
              tarRemediation,
            ),
          );
        }
        return;
      }
      try {
        total += chunk.length;
        if (total > TAR_MAX_BYTES) {
          failed = true;
          fail(
            new HarvestError(
              "tar-over-cap",
              `artifacts tar decompressed past the ${TAR_MAX_BYTES}-byte cap (${total} bytes) — nothing extracted`,
              tarRemediation,
            ),
          );
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (!inData) {
            if (buf.length < BLOCK) return;
            const block = buf.subarray(0, BLOCK);
            if (block.every((b) => b === 0)) {
              // EOF block found — check the remainder of this chunk for non-zero bytes.
              const remainder = buf.subarray(BLOCK);
              if (remainder.some((b) => b !== 0)) {
                throw new HarvestError(
                  "tar-invalid",
                  "artifacts tar has non-zero trailing bytes after the EOF block — refusing to extract",
                  tarRemediation,
                );
              }
              sawEof = true;
              return;
            }
            const parsed = parseHeader(block);
            summed += parsed.size;
            if (summed > TAR_MAX_BYTES || parsed.size > TAR_MAX_BYTES) {
              throw new HarvestError(
                "tar-over-cap",
                `artifacts tar entry sizes sum past the ${TAR_MAX_BYTES}-byte cap (${summed} declared) — nothing extracted`,
                tarRemediation,
              );
            }
            if (METADATA_TYPEFLAGS.has(parsed.typeflag)) {
              // Header-time check (pass 1, nothing written): the declared
              // size bounds the whole buffer before a single chunk lands.
              if (parsed.size > TAR_METADATA_MAX_BYTES) {
                throw new HarvestError(
                  "tar-over-cap",
                  `artifacts tar metadata entry (${parsed.typeflag}) declares ${parsed.size} bytes, over the ${TAR_METADATA_MAX_BYTES}-byte metadata cap — nothing extracted`,
                  tarRemediation,
                );
              }
              meta = { kind: parsed.typeflag, chunks: [] };
            } else if (ALLOWED_TYPEFLAGS.has(parsed.typeflag)) {
              // The override path (pax 'path=' / GNU longname) replaces the
              // header name wholesale and passes the SAME safety gate.
              const name = assertPathSafe("name", pendingName ?? globalPath ?? parsed.rawName);
              const linkname = pendingLinkname ?? parsed.rawLinkname;
              if (linkname !== "") assertPathSafe("linkname", linkname);
              // Collision sets are keyed by the FOLDED name (see foldName);
              // extraction below still uses the raw canonical name.
              const folded = foldName(name);
              if (names.has(folded)) {
                throw new HarvestError(
                  "tar-unsafe-entry",
                  `artifacts tar lists duplicate path ${JSON.stringify(name)} — no overwrite`,
                  tarRemediation,
                );
              }
              // A file at a path that must be a directory (or the reverse) would fail mid-extraction with a raw errno — reject in pass 1 so nothing is written.
              const isDir = parsed.typeflag === "5";
              const foldedAncestors = ancestorsOf(folded);
              const fileAncestor = foldedAncestors.find((a) => filePaths.has(a));
              if (fileAncestor !== undefined || (isDir ? filePaths : dirPaths).has(folded)) {
                throw new HarvestError(
                  "tar-unsafe-entry",
                  `artifacts tar entry ${JSON.stringify(name)} conflicts with an earlier file at ${JSON.stringify(fileAncestor ?? folded)} — no overwrite`,
                  tarRemediation,
                );
              }
              for (const a of foldedAncestors) dirPaths.add(a);
              (isDir ? dirPaths : filePaths).add(folded);
              names.add(folded);
              handlers.onEntry({ name, typeflag: parsed.typeflag, size: parsed.size });
            } else {
              // Hard links, symlinks, char/block devices, FIFOs, and anything
              // else that is not a regular file or a directory (INV-3).
              throw new HarvestError(
                "tar-unsafe-entry",
                `artifacts tar entry carries disallowed typeflag ${JSON.stringify(parsed.typeflag)}`,
                tarRemediation,
              );
            }
            pendingName = null;
            pendingLinkname = null;
            buf = buf.subarray(BLOCK);
            inData = true;
            remaining = parsed.size;
            pad = (BLOCK - (parsed.size % BLOCK)) % BLOCK;
          } else {
            if (remaining > 0) {
              const take = Math.min(remaining, buf.length);
              if (take > 0) {
                if (meta !== null) meta.chunks.push(buf.subarray(0, take));
                else handlers.onData(buf.subarray(0, take));
                buf = buf.subarray(take);
                remaining -= take;
              }
              if (remaining > 0) return; // need more data
            }
            if (pad > 0) {
              const take = Math.min(pad, buf.length);
              buf = buf.subarray(take);
              pad -= take;
              if (pad > 0) return;
            }
            if (meta !== null) {
              applyMetadata(Buffer.concat(meta.chunks));
              meta = null;
            } else {
              handlers.onEntryEnd();
            }
            inData = false;
          }
        }
      } catch (e) {
        failed = true;
        fail(e as HarvestError);
      }
    },
    finish(): void {
      if (!sawEof) {
        throw new HarvestError(
          "tar-truncated",
          "artifacts tar ended without an all-zero EOF block — nothing extracted",
          tarRemediation,
        );
      }
    },
  };
}

/**
 * Stream a (possibly gzipped) tar through the parser once. Sniffs 1f 8b to
 * pick gunzip vs passthrough. Bun 1.2.22 gotchas (verified in the /tmp POC):
 * `once(em, ["end","close"])` never resolves — await single events; and a
 * stream's `destroy(cb)` callback never fires after natural EOF — use plain
 * `.destroy()`, which is all the bomb-abort path needs.
 */
async function streamTar(tgzPath: string, handlers: TarHandlers): Promise<void> {
  const fd = openSync(tgzPath, "r");
  const head = Buffer.alloc(2);
  let n = 0;
  try {
    n = readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  const isGzip = n === 2 && head[0] === 0x1f && head[1] === 0x8b;

  const src = createReadStream(tgzPath);
  const out = isGzip ? createGunzip() : new PassThrough();
  src.pipe(out);
  let failure: HarvestError | undefined;
  const fail = (e: HarvestError): void => {
    if (!failure) {
      failure = e;
      out.destroy(e);
      src.destroy();
    }
  };
  const parser = makeTarParser(handlers, fail);
  // A read-side error (EIO, file swapped mid-read) must not escape as an
  // unhandled 'error' event on src: route it through fail so out is destroyed
  // and the race below settles with the structured HarvestError.
  src.on("error", (e: Error) => {
    fail(new HarvestError("tar-invalid", `artifacts stream could not be read: ${e.message}`, tarRemediation));
  });
  out.on("data", (c: Buffer) => {
    if (failure === undefined) parser.push(c);
  });
  try {
    await Promise.race([
      once(out, "end"),
      once(out, "error").then((args) => {
        throw args[0];
      }),
    ]);
  } catch (e) {
    if (failure) throw failure;
    throw new HarvestError(
      "tar-invalid",
      `artifacts stream is not a valid ${isGzip ? "gzip" : "tar"} stream: ${(e as Error).message}`,
      tarRemediation,
    );
  }
  if (failure) throw failure;
  parser.finish();
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Pass-2 writer: dirs (explicit + implicit parents) 0700, files wx/0600. */
function extractHandlers(destDir: string): TarHandlers {
  let fd: number | null = null;
  return {
    onEntry(header: TarEntryHeader): void {
      const target = join(destDir, header.name);
      if (header.typeflag === "5") {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        return;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      fd = openSync(target, "wx", 0o600);
    },
    onData(chunk: Buffer): void {
      if (fd === null) return;
      try {
        writeAll(fd, chunk);
      } catch (e) {
        closeSync(fd); // a mid-entry write failure must not leak the fd
        fd = null;
        throw e;
      }
    },
    onEntryEnd(): void {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}

/**
 * Two passes over the staging tgz: pass 1 validates everything (structure,
 * entry types, path safety, duplicates, both caps) and pass 2 extracts into a
 * freshly rebuilt destination. Pass 2 only ever runs after a clean pass 1, so
 * a rejected tar leaves nothing written.
 */
async function validateAndExtractTgz(tgzPath: string, destDir: string): Promise<number> {
  const received = statSync(tgzPath).size;
  if (received > TAR_MAX_BYTES) {
    throw new HarvestError(
      "tar-over-cap",
      `artifacts tar ${tgzPath} is ${received} received bytes, over the ${TAR_MAX_BYTES}-byte cap — nothing extracted`,
      tarRemediation,
    );
  }
  let files = 0;
  await streamTar(tgzPath, {
    // Count regular files only — '5' directory entries are not files.
    onEntry: (header) => {
      if (header.typeflag !== "5") files++;
    },
    onData: () => {},
    onEntryEnd: () => {},
  });
  // Atomic extraction: pass 2 builds a SIBLING and is renamed into place, so
  // process death mid-extraction never leaves a half-written tree at the
  // visible path. (rename over an existing dir fails — clear it first.) The
  // sibling's name is UNIQUE PER CALL (P40, round 4): a fixed `.partial`
  // sibling let a concurrent pull of the same runId `rmSync` the other's
  // mid-extraction tree and surface a spurious HarvestError that, on
  // teardown's non-fatal artifacts step, became a permanently lost bundle.
  // Each racer now extracts into its own tree and the last rename wins with
  // one complete, valid archive.
  const partial = `${destDir}.partial-${randomUUID()}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    await streamTar(tgzPath, extractHandlers(partial));
  } catch (e) {
    rmBestEffort(partial, { recursive: true });
    throw e;
  }
  // The terminal swap, with the SAME cross-process racers in mind: the rm and
  // the rename are adjacent sync statements IN one process, but the other
  // racer is another PROCESS — its rm of the shared dest can interleave
  // between this rm and this rename, and POSIX rename(2) over a non-empty
  // directory fails ENOTEMPTY. An unguarded throw here escapes the extraction
  // try above (whose cleanup already ran), leaking the whole extracted
  // partial AND surfacing as a permanent artifacts-loss once teardown
  // destroys the box. One bounded retry — re-rm, rename again — closes the
  // interleave; anything still failing is a real fault, cleaned up and
  // thrown.
  rmSync(destDir, { recursive: true, force: true });
  try {
    renameSync(partial, destDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOTEMPTY" && (e as NodeJS.ErrnoException)?.code !== "EEXIST") {
      rmBestEffort(partial, { recursive: true });
      throw e;
    }
    rmSync(destDir, { recursive: true, force: true });
    try {
      renameSync(partial, destDir);
    } catch (e2) {
      rmBestEffort(partial, { recursive: true });
      throw e2;
    }
  }
  return files;
}
