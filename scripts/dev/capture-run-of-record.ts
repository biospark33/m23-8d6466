/**
 * Freeze a completed run-of-record into an immutable gate fixture (DF5.4
 * leaf-1.1.2).
 *
 * A frozen fixture is what the DF5.4 lights-on gate (and its fixture-hygiene
 * tests) points its seams at — `--runs-dir`, `--reverify-dir`, `--ledger`,
 * `--audit-db`, `--git-dir`, `--pr-body` all name files INSIDE `<out>`, so the
 * gate never reads the developer's live `.sandbox/`. This tool is the only
 * sanctioned bridge between the two. It freezes: the run record, the reverify
 * jsonl (renamed `<runId>.reverify.jsonl`), `audit.db` (plain copy — the link
 * store journals on DELETE, so the live-writer guard is a non-empty `-journal`
 * sibling, re-checked after the copy, and the COPY is quick_check'd so a writer
 * that committed inside the copy window cannot ship a torn image), `cost-ledger.db` (only after a
 * TRUNCATE checkpoint on the REAL ledger; a still-non-empty `-wal` REFUSES —
 * DF2.11 would hot-WAL-refuse that shape forever; the COPY is then converted
 * to DELETE journal mode — see selfContainLedgerCopy), the harvest `<runId>.bundle`
 * (C9's run-bundle hop digest-checks it against the audit link rows), the full artifacts dir,
 * `refs.git/` (bare repo carrying `refs/sandbox/<runId>` AND its objects via a
 * ref-limited `git bundle`, then verified), and `pr-body.txt` (`.sandbox/pr`
 * residue, else ONE live `gh pr view` read, else `file:<path>`; refuses to
 * freeze without a body — C8 audits it).
 *
 * Idempotence: refuses if `--out` exists non-empty — a frozen fixture is immutable; delete it by hand to re-capture. The ONLY writes outside `<out>`
 * are the ledger's own WAL checkpoint (a sqlite-internal fold, not a mutation
 * of logical content) and a temp bundle under `os.tmpdir()`. `--dry-run` does
 * neither and writes nothing. Exit codes per repo CLI convention: 0 success,
 * 1 typed refusal ({code, message, remediation} on stderr), 2 usage/fatal.
 * Exception: `resolveSources` runs BEFORE the dry-run branch, so a missing run
 * record, ledger, bundle, or artifacts dir refuses with its typed payload even
 * under `--dry-run`; the one plain line is `dry-run: NOT ok` for a `file:` PR
 * body that cannot be read (no typed payload — it never began a capture).
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { Database } from "bun:sqlite";

import { DEFAULT_AUDIT_DB_FILE } from "../../src/audit/index.ts";
import { DEFAULT_COST_LEDGER_FILE } from "../../src/providers/cost-ledger.ts";
import { resolveRunsDir } from "../../src/providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR } from "../../src/reverify/report.ts";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, type RunLockHandle } from "../lib/run-lock.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const HELP = [
  "Usage: bun scripts/dev/capture-run-of-record.ts --run-id <id> --out <fixtureDir> [flags]",
  "",
  "  --run-id <id>            the run to freeze (e.g. qds-20260918-cc93a3)",
  "  --out <fixtureDir>       fixture directory to create (must not exist non-empty)",
  "  --runs-dir <dir>         run-record directory (default $QDS_RUNS_DIR or .sandbox/runs)",
  "  --reverify-dir <dir>     reverify records (default .sandbox/reverify)",
  "  --ledger <path>          cost ledger (default $QDS_COST_LEDGER_FILE)",
  "  --audit-db <path>        audit-links store (default $QDS_AUDIT_DB or .sandbox/audit.db)",
  "  --git-dir <repo .git>    host git dir holding refs/sandbox/<runId> (default <repo>/.git)",
  "  --pr-body-source <s>     auto | gh | file:<path> (default auto)",
  "  --dry-run                verify sources + print the freeze plan; write nothing",
  "",
  "  Source defaults are cwd-anchored — run from the repo root the run of record lives in (the same resolution the gate uses for its own seams).",
] as const;

const VALUE_FLAGS = ["--run-id", "--out", "--runs-dir", "--reverify-dir", "--ledger", "--audit-db", "--git-dir", "--pr-body-source"] as const;
const BOOL_FLAGS = ["--dry-run"] as const;

/** Path-traversal guard: a runId is one filename/ref segment, never a slash. */
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

interface Args {
  runId: string;
  out: string;
  runsDir?: string;
  reverifyDir?: string;
  ledger?: string;
  auditDb?: string;
  gitDir?: string;
  prBodySource: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const { flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });
  for (const t of flagTokens) {
    const eq = t.indexOf("=");
    if (eq > 0 && (BOOL_FLAGS as readonly string[]).includes(t.slice(0, eq))) throw new Error(`${t.slice(0, eq)} takes no value`);
  }
  const seen = new Set<string>();
  const a: Partial<Args> = {};
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (seen.has(flag)) throw new Error(`${flag} given more than once`);
      seen.add(flag);
      if (value.startsWith("~")) {
        throw new Error(`${flag}: ~ is not expanded here — pass an absolute path (got ${value})`);
      }
      const key = PATH_FLAGS[flag];
      if (key !== undefined) {
        (a as Record<string, string | undefined>)[key] = resolve(value);
      } else if (flag === "--run-id") {
        if (value === "." || value === ".." || !RUN_ID_RE.test(value)) {
          throw new Error(`--run-id must match ${RUN_ID_RE.source} and not be . or .. (got ${JSON.stringify(value)})`);
        }
        a.runId = value;
      } else if (flag === "--pr-body-source") {
        if (value !== "auto" && value !== "gh" && !value.startsWith("file:")) {
          throw new Error(`--pr-body-source must be auto, gh, or file:<path> (got ${value})`);
        }
        a.prBodySource = value;
      } else {
        throw new Error(`unhandled value flag: ${flag}`);
      }
    },
    help: HELP,
  });
  if (argv.filter((t) => t === "--dry-run").length > 1) throw new Error("--dry-run given more than once");
  if (a.runId === undefined) throw new Error("missing --run-id <id>");
  if (a.out === undefined) throw new Error("missing --out <fixtureDir>");
  return { ...a, prBodySource: a.prBodySource ?? "auto", dryRun: bools.has("--dry-run") } as Args;
}

/** Typed refusal: exit 1 with {code, message, remediation} on stderr. */
function refuse(code: string, message: string, remediation: string): never {
  exitWithFailure(`capture-run-of-record: ${code}`, 1, [message, `remediation: ${remediation}`]);
}

/** Every fault AFTER `<out>` exists (freezeRefs, ledger self-containment, the
 * copy/TOCTOU phase) must throw, not call refuse(): refuse() → process.exit()
 * skips pending `finally` blocks (C6), and the caller must first remove what
 * this run created so the fixture never locks behind the idempotence guard.
 * main's catch converts the throw back to the typed exit after cleanup ran. */
class FreezeRefusal extends Error {
  constructor(
    readonly code: string,
    readonly remediation: string,
    message: string,
  ) {
    super(message);
  }
}

/** Async-only subprocess (repo rule: no spawnSync). Env inherited verbatim and NEVER echoed — gh's token lives there.
 * A hung gh/git is SIGKILLed at 120s; the null exit code then flows into the caller's `code !== 0`
 * refusal paths, which name the command (C12). `stdout` is trimmed for exit-code/shape checks;
 * `stdoutRaw` preserves meaningful leading/trailing whitespace for bodies (C15). */
async function run(argv: readonly string[]): Promise<{ code: number; stdout: string; stdoutRaw: string; stderr: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" });
  } catch (e) {
    return { code: -1, stdout: "", stdoutRaw: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stdoutRaw: stdout, stderr: stderr.trim() };
}

function stderrTail(s: string, max = 400): string {
  return s.length > max ? `${s.slice(s.length - max)}…` : s;
}

/** A file that must exist and be a regular file. statSync runs first, INSIDE the
 * guard: a typed refusal on ENOENT, and a FIFO (or dir) is refused before the
 * open("r") probe can block on it (C13). The probe never creates — bun:sqlite's
 * `new Database(path)` does, which is why the ledger and audit-db are probed
 * HERE before any sqlite open. */
function mustExistFile(path: string, code: string, what: string): void {
  try {
    const st = statSync(path);
    if (!st.isFile()) refuse(code, `${what} at ${path} is not a regular file`, `point the flag at the real ${what} and re-run`);
  } catch (e) {
    refuse(code, `${what} is missing or unreadable at ${path} (${(e as Error).message})`, `point the flag at the real ${what} and re-run`);
  }
  try {
    closeSync(openSync(path, "r"));
  } catch (e) {
    refuse(code, `${what} at ${path} cannot be opened (${(e as Error).message})`, `point the flag at the real ${what} and re-run`);
  }
}

function mustExistDir(path: string, code: string, what: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    refuse(code, `${what} is missing at ${path} (${(e as Error).message})`, "point the flag at the real directory and re-run");
  }
  if (!st.isDirectory()) refuse(code, `${what} at ${path} is not a directory`, "point the flag at the real directory and re-run");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** Bounded lstat walk of the artifacts tree, run before the dereferencing copy:
 * `cpSync(dereference: true)` would block forever on a symlink→FIFO and fail
 * ELOOP on a symlink cycle, so every entry must be a real directory or a real
 * file (lstat — a symlink counts as irregular even when its target is tame). */
function assertArtifactsWalkable(artifactsDir: string): void {
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      refuse("artifacts-irregular-entry", `cannot list the artifacts directory ${dir} (${(e as Error).message})`, "fix the unreadable artifacts entry and re-run; the freeze refuses to dereference-copy a tree it cannot fully enumerate");
    }
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(dir, e.name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch (err) {
        refuse("artifacts-irregular-entry", `cannot stat artifacts entry ${p} (${(err as Error).message})`, "fix or remove the unreadable artifacts entry and re-run");
      }
      if (st.isDirectory()) visit(p);
      else if (!st.isFile()) {
        refuse("artifacts-irregular-entry", `artifacts entry ${p} is neither a regular file nor a directory (${st.isSymbolicLink() ? "symlink" : st.isFIFO() ? "FIFO" : st.isSocket() ? "socket" : st.isBlockDevice() ? "block device" : st.isCharacterDevice() ? "character device" : "irregular"})`, "remove or replace the irregular artifacts entry and re-run; dereferencing it would hang (FIFO) or loop (symlink cycle) the copy");
      }
    }
  };
  visit(artifactsDir);
}

/** Segment-based containment: is `descendant` inside (or equal to) `ancestor`?
 * A string prefix lies — `/tmp/out` does not contain `/tmp/outfox`.
 * Exported for tests (tests/scripts/capture-run-of-record.test.ts). */
export function pathContains(ancestor: string, descendant: string): boolean {
  const head = relative(ancestor, descendant).split(sep)[0];
  return head !== "..";
}

/** Resolve `path` through every symlink an EXISTING component carries, then
 * re-join the not-yet-created tail lexically. `resolve()` is purely lexical:
 * it never consults the filesystem, so `--out /link/fixture` where `/link`
 * points into the runs directory passes a lexical containment check and then
 * mkdirSync plants the fixture inside live capture evidence. The deepest
 * EXISTING component is the one that redirects the writes, so it is the one
 * that must be resolved; a missing leaf resolves through its existing parent
 * the same way the kernel will when mkdir(2) creates it. A symlink cycle
 * (ELOOP) and every other non-ENOENT stat fault propagate — the caller turns
 * them into a typed refusal. Exported for tests. */
export function realpathThroughAbsent(path: string): string {
  let p = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(p), ...tail);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(p);
      if (parent === p) return p; // the filesystem root — nothing left to climb
      tail.unshift(basename(p));
      p = parent;
    }
  }
}

interface Sources {
  recordPath: string;
  reverifyPath: string;
  artifactsDir: string;
  bundlePath: string;
  ledgerPath: string;
  auditDbPath: string;
  gitDir: string;
  ref: string;
  refSha: string;
  prNumber: number;
  repoSlug: string;
}

/** Path-only value flags → the Args field they fill (table replaces a switch). */
const PATH_FLAGS: Record<string, keyof Args> = { "--out": "out", "--runs-dir": "runsDir", "--reverify-dir": "reverifyDir", "--ledger": "ledger", "--audit-db": "auditDb", "--git-dir": "gitDir" };

/** Resolve + verify EVERY source before any write: a half-frozen fixture is worse than none (the gate would read a fixture silently missing a seam).
 * `runsDir` is threaded in by main so the run lock names the same directory the sources resolve from. */
async function resolveSources(args: Args, runsDir: string): Promise<Sources> {
  const runId = args.runId;
  const reverifyDir = args.reverifyDir ?? resolve(DEFAULT_REVERIFY_DIR);
  const ledgerPath = args.ledger ?? resolve(process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE);
  const auditDbPath = args.auditDb ?? resolve(process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE);
  let gitDir = args.gitDir ?? join(REPO_ROOT, ".git");
  try {
    // A worktree's `.git` is a FILE (`gitdir: <path>`) naming the real git dir — follow the pointer
    // so the ref lookups below hit the store the ref actually lives in (C11). mustExistDir below
    // still refuses a target that ends up not being a directory.
    if (statSync(gitDir).isFile()) {
      const content = readFileSync(gitDir, "utf8").trim();
      if (content.startsWith("gitdir:")) gitDir = resolve(dirname(gitDir), content.slice("gitdir:".length).trim());
    }
  } catch {
    // Missing/unreadable .git — mustExistDir produces the typed refusal below.
  }

  const recordPath = join(runsDir, `${runId}.json`);
  let record: Record<string, unknown>;
  try {
    // dp:ok — guarded: this parse feeds the refusal below (record-unreadable),
    // the scanner's added-line view does not see the enclosing try/catch.
    record = JSON.parse(await Bun.file(recordPath).text()) as Record<string, unknown>; // dp:ok — guarded by the enclosing try/refuse (record-unreadable); the added-line view misses it
  } catch (e) {
    refuse("record-unreadable", `run record at ${recordPath} cannot be read or parsed (${(e as Error).message})`, "confirm the run id and --runs-dir; the record must exist and parse before anything is frozen");
  }
  if (record.runId !== runId) {
    refuse("record-runid-mismatch", `record at ${recordPath} names runId ${JSON.stringify(record.runId)}, not ${JSON.stringify(runId)}`, "pass the --run-id the record itself names");
  }
  const ext = (record.extensions ?? {}) as Record<string, Record<string, unknown>>;
  const prNumber = ext.pr?.prNumber;
  const prUrl = ext.pr?.prUrl;
  const repoSlug = ext.budget?.repoSlug;
  if (typeof prNumber !== "number" || typeof prUrl !== "string" || typeof repoSlug !== "string") {
    refuse("pr-metadata-absent", `record at ${recordPath} lacks extensions.pr.{prNumber,prUrl} + extensions.budget.repoSlug — the PR body fetch has nothing to fetch`, "only a run whose PR was opened and recorded can be frozen; capture the PR metadata first");
  }

  const reverifyPath = join(reverifyDir, `${runId}.jsonl`);
  mustExistFile(reverifyPath, "reverify-absent", "reverify record");
  const artifactsDir = join(runsDir, `${runId}-artifacts`);
  mustExistDir(artifactsDir, "artifacts-absent", "harvested artifacts directory");
  mustExistFile(join(artifactsDir, "trace", "events.jsonl"), "artifacts-incomplete", "trace/events.jsonl");
  mustExistFile(join(artifactsDir, "trace", "trace.db"), "artifacts-incomplete", "trace/trace.db");
  // The artifacts copy is verbatim (cpSync); a hot trace WAL would be frozen mid-write (C5).
  const traceWal = join(artifactsDir, "trace", "trace.db-wal");
  if (existsSync(traceWal) && fileSize(traceWal) > 0) {
    refuse("artifacts-wal-live", `${traceWal} is non-empty — the harvest's trace writer is still live`, "re-run after the harvest's WAL is drained, or capture a quiesced run");
  }
  // The copy dereferences — a FIFO or symlink cycle in the tree would hang or ELOOP it (C-edge#6).
  assertArtifactsWalkable(artifactsDir);
  // The harvest bundle: C9's run-bundle hop digest-checks it against the audit link rows.
  const bundlePath = join(runsDir, `${runId}.bundle`);
  mustExistFile(bundlePath, "bundle-absent", "harvest bundle");
  // SQLite opens a 0-byte or foreign db without complaint; prove the bundle is a real bundle
  // (read-only) before freezing it as C9's digest anchor (C-edge#5). `bundle verify` refuses a
  // bare --git-dir ("need a repository") — the repo must come from -C.
  const bverify = await run(["git", "-C", gitDir, "bundle", "verify", bundlePath]);
  if (bverify.code !== 0) {
    refuse("bundle-unverifiable", `git bundle verify ${bundlePath} failed: ${stderrTail(bverify.stderr)}`, "the harvest bundle is corrupt or truncated — re-harvest to regenerate it, then re-run capture");
  }
  mustExistFile(ledgerPath, "ledger-absent", "cost ledger");
  mustExistFile(auditDbPath, "audit-db-absent", "audit-links store");
  // audit.db ships as a plain copy — no checkpoint, no sidecar — so a live audit writer would be
  // frozen mid-write (C4). The store journals on DELETE (link-store.ts asserts it on open), so
  // the writer's signal is a non-empty `-journal` (removed on commit), not `-wal`.
  const auditWal = `${auditDbPath}-wal`;
  if (existsSync(auditWal) && fileSize(auditWal) > 0) {
    refuse("audit-wal-live", `${auditWal} is non-empty — a live writer holds the audit-links store`, "quiesce the audit writer, confirm the -wal drains, and re-run; the freeze ships the audit store as a plain sidecar-less copy");
  }
  const auditJournal = `${auditDbPath}-journal`;
  if (existsSync(auditJournal) && fileSize(auditJournal) > 0) {
    refuse("audit-journal-live", `${auditJournal} is non-empty — an audit transaction is mid-flight in the store's DELETE journal`, "quiesce the audit writer, confirm the -journal drains, and re-run; the freeze ships the audit store as a plain sidecar-less copy");
  }
  // And prove the store is real before freezing it: a table-less audit.db would freeze as success.
  let auditHasTable: unknown;
  try {
    const adb = new Database(auditDbPath, { readonly: true });
    try {
      auditHasTable = adb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_links'").get();
    } finally {
      adb.close();
    }
  } catch (e) {
    refuse("audit-schema-absent", `cannot open the audit-links store read-only at ${auditDbPath} (${(e as Error).message})`, "check permissions and locks on the store and re-run; the freeze must read its schema before shipping it");
  }
  if (auditHasTable === null || auditHasTable === undefined) {
    refuse("audit-schema-absent", `${auditDbPath} opens but carries no audit_links table — this is not the real audit-links store`, "point --audit-db at the store src/audit/link-store.ts creates and re-run");
  }
  mustExistDir(gitDir, "git-dir-absent", "host git dir");

  const ref = `refs/sandbox/${runId}`;
  const rev = await run(["git", "--git-dir", gitDir, "rev-parse", "--verify", ref]);
  if (rev.code !== 0 || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(rev.stdout)) {
    refuse("sandbox-ref-absent", `refs/sandbox/${runId} does not resolve in ${gitDir}: ${stderrTail(rev.stderr)}`, `run git --git-dir ${gitDir} rev-parse --verify refs/sandbox/${runId} by hand; harvest must have fetched the box branch before capture`);
  }
  return { recordPath, reverifyPath, artifactsDir, bundlePath, ledgerPath, auditDbPath, gitDir, ref, refSha: rev.stdout, prNumber, repoSlug };
}

/** Checkpoint the REAL ledger's WAL into the db, then prove it took: a
 * non-empty `-wal` after TRUNCATE means a live writer holds the ledger, and a
 * frozen hot WAL is a shape DF2.11 refuses to read forever (C10-skip).
 * Read-write open ONLY after the existence probe. */
function checkpointLedger(ledgerPath: string): void {
  let db: Database;
  try {
    db = new Database(ledgerPath);
  } catch (e) {
    refuse("ledger-unopenable", `cannot open the cost ledger read-write for checkpoint (${(e as Error).message})`, `the existence probe passed, so check permissions on ${ledgerPath} and re-run`);
  }
  try {
    // A 0-byte or foreign db opens fine — prove it is the real ledger before checkpointing it (C-edge#5).
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cost_events'").get();
    if (table === null || table === undefined) {
      refuse("ledger-schema-absent", `${ledgerPath} opens but carries no cost_events table — this is not the real cost ledger`, "point --ledger at the ledger src/providers/cost-ledger.ts creates and re-run");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // tracer.ts:916 precedent
  } catch (e) {
    refuse("ledger-checkpoint-failed", `PRAGMA wal_checkpoint(TRUNCATE) failed on ${ledgerPath} (${(e as Error).message})`, "stop writers on the ledger and re-run; the freeze refuses to ship an un-checkpointed WAL");
  } finally {
    try {
      db.close();
    } catch {
      // The refusal above is the diagnosis; a close failure must not mask it.
    }
  }
  const wal = `${ledgerPath}-wal`;
  if (existsSync(wal) && fileSize(wal) > 0) {
    refuse("ledger-wal-live", `${wal} is still non-empty after a TRUNCATE checkpoint — a live writer holds the ledger`, "stop the writer(s), confirm the -wal drains, and re-run; DF2.11 would hot-WAL-refuse this fixture forever");
  }
}

/** Make the fixture's ledger COPY self-contained. The source stays WAL (the
 * writer's mode), but a WAL-mode db with no `-shm` beside it is exactly the
 * readonly-open failure DF2.11 classifies `ledger-unopenable` — verified by
 * rehearsal: a plain copy of the checkpointed ledger cannot be read through
 * `new Database(path, {readonly: true})`. Copying the source's `-shm` instead
 * ships nondeterministic bytes and breaks the gate's ×3 file-set snapshot.
 * DELETE mode is the audit.db shape: self-contained, deterministic, no
 * sidecars. Ends with the read-only smoke open C10 performs. */
function selfContainLedgerCopy(fixtureLedger: string): void {
  let db: Database;
  try {
    db = new Database(fixtureLedger);
  } catch (e) {
    throw new FreezeRefusal("ledger-fixture-unopenable", "remove the partial fixture dir and re-run", `cannot open the copied ledger at ${fixtureLedger} for journal conversion (${(e as Error).message})`);
  }
  try {
    const mode = db.prepare("PRAGMA journal_mode = DELETE;").get() as Record<string, unknown>;
    if (mode?.journal_mode !== "delete") {
      throw new FreezeRefusal("ledger-fixture-unopenable", "remove the partial fixture dir and re-run", `journal_mode = DELETE did not take on ${fixtureLedger} (got ${JSON.stringify(mode?.journal_mode)})`);
    }
  } finally {
    try {
      db.close();
    } catch {
      // The refusal above is the diagnosis.
    }
  }
  for (const sidecar of [`${fixtureLedger}-wal`, `${fixtureLedger}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar); // conversion residue inside OUR out, never evidence
  }
  try {
    const ro = new Database(fixtureLedger, { readonly: true });
    ro.query("select count(*) as n from sqlite_master").get();
    ro.close();
  } catch (e) {
    throw new FreezeRefusal("ledger-fixture-unopenable", "remove the partial fixture dir and re-run", `the frozen ledger copy at ${fixtureLedger} fails the read-only open C10 performs (${(e as Error).message})`);
  }
}

/** Build `<out>/refs.git`: a bare repo carrying exactly the sandbox ref + its reachable objects, via a temp bundle under os.tmpdir().
 * Every fault throws FreezeRefusal — main's catch removes what this run created before refusing (C-edge#3). */
async function freezeRefs(out: string, s: Sources): Promise<string> {
  const refsGit = join(out, "refs.git");
  const init = await run(["git", "init", "--bare", "--quiet", refsGit]);
  if (init.code !== 0) {
    throw new FreezeRefusal("refs-init-failed", "remove the partial fixture dir and re-run", `git init --bare ${refsGit} failed: ${stderrTail(init.stderr)}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "df54-capture-"));
  try {
    const bundle = join(tmp, `${s.refSha}.bundle`);
    const create = await run(["git", "--git-dir", s.gitDir, "bundle", "create", bundle, s.ref]);
    if (create.code !== 0) {
      throw new FreezeRefusal("bundle-create-failed", `the ref resolved in ${s.gitDir}; re-run, and if it persists inspect the object store by hand`, `git bundle create for ${s.ref} failed: ${stderrTail(create.stderr)}`);
    }
    const fetch = await run(["git", "--git-dir", refsGit, "fetch", "--quiet", bundle, `${s.ref}:${s.ref}`]);
    if (fetch.code !== 0) {
      throw new FreezeRefusal("refs-fetch-failed", "remove the partial fixture dir and re-run", `fetching the bundle into ${refsGit} failed: ${stderrTail(fetch.stderr)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // cleanup runs even through a refusal (C6)
  }
  const v = await run(["git", "--git-dir", refsGit, "rev-parse", "--verify", s.ref]);
  if (v.code !== 0 || v.stdout !== s.refSha) {
    throw new FreezeRefusal("refs-verify-failed", "the fixture is partial; remove it and re-run", `refs.git verification failed: expected ${s.ref} -> ${s.refSha}, got exit ${v.code} ${v.stdout}`);
  }
  const cat = await run(["git", "--git-dir", refsGit, "cat-file", "-e", s.refSha]);
  if (cat.code !== 0) {
    throw new FreezeRefusal("refs-object-missing", "remove the partial fixture dir and re-run", `cat-file -e ${s.refSha} failed in refs.git — the ref resolves but its object did not travel`);
  }
  return s.refSha;
}

/** Post-copy TOCTOU rechecks: a writer resuming between checkpoint and copy ships a
 * stale/torn db (C9, C-edge#1). These run after `<out>` exists, so they throw for
 * cleanup-first refusing instead of refusing in place. */
function throwIfLedgerWriterResumed(ledgerPath: string): void {
  const wal = `${ledgerPath}-wal`;
  if (existsSync(wal) && fileSize(wal) > 0) {
    throw new FreezeRefusal("ledger-wal-live", "quiesce the ledger writers, remove the partial fixture, re-run", `${wal} is non-empty after the copy — a writer resumed mid-capture; the frozen copy may be stale`);
  }
}

function throwIfAuditWriterResumed(auditDbPath: string): void {
  // Each sidecar keeps the typed code its pre-copy sibling uses (audit-wal-live
  // above for -wal), so a post-copy refusal names the same fault class the
  // operator already learned to look for.
  for (const [suffix, code, what] of [
    ["-journal", "audit-journal-live", "an audit transaction is mid-flight in the DELETE journal"],
    ["-wal", "audit-wal-live", "a live writer holds the audit-links store"],
  ] as const) {
    const sidecar = `${auditDbPath}${suffix}`;
    if (existsSync(sidecar) && fileSize(sidecar) > 0) {
      throw new FreezeRefusal(code, "quiesce the audit writer, remove the partial fixture, re-run", `${sidecar} is non-empty after the copy — ${what}; the plain copy may be torn`);
    }
  }
}

/** The fixture's audit.db copy must be a coherent SQLite image: the post-copy
 * sidecar recheck only catches a transaction STILL mid-flight — a writer that
 * begins and commits entirely inside the copyFileSync window can tear the page
 * mix and drain its own -journal before the recheck looks. quick_check on the
 * COPY (read-only — no sidecars, nothing written into the fixture) is the
 * direct proof the snapshot is a readable, consistent db. */
function assertAuditCopyConsistent(fixtureAuditDb: string): void {
  let db: Database;
  try {
    db = new Database(fixtureAuditDb, { readonly: true });
  } catch (e) {
    throw new FreezeRefusal("audit-copy-unreadable", "remove the partial fixture dir and re-run", `cannot open the copied audit store at ${fixtureAuditDb} for quick_check (${(e as Error).message})`);
  }
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    const verdict = row === undefined ? "no result" : String(Object.values(row)[0] ?? "no result");
    if (verdict !== "ok") {
      throw new FreezeRefusal("audit-copy-torn", "quiesce the audit writer, remove the partial fixture dir, re-run", `quick_check on the copied audit store at ${fixtureAuditDb} reported ${JSON.stringify(verdict)} — the plain copy raced a writer and tore`);
    }
  } finally {
    try {
      db.close();
    } catch {
      // The refusal above is the diagnosis; a close failure must not mask it.
    }
  }
}

/** Remove what THIS run created so the idempotence guard never locks a partial
 * fixture behind `fixture-exists` (C7, C-edge#3): the whole `<out>` when this run
 * made it, else only the refs.git/artifacts subtrees and top-level names the freeze
 * phase writes. Best-effort — the refusal that follows still names the fixture. */
function cleanupPartialFixture(out: string, createdOut: boolean, runId: string): void {
  try {
    if (createdOut) {
      rmSync(out, { recursive: true, force: true });
      return;
    }
    rmSync(join(out, "refs.git"), { recursive: true, force: true });
    rmSync(join(out, `${runId}-artifacts`), { recursive: true, force: true });
    for (const name of [`${runId}.json`, `${runId}.reverify.jsonl`, `${runId}.bundle`, "audit.db", "audit.db-journal", "audit.db-wal", "cost-ledger.db", "cost-ledger.db-wal", "cost-ledger.db-shm", "pr-body.txt"]) {
      rmSync(join(out, name), { force: true });
    }
  } catch {
    // Best-effort: the typed refusal below still tells the operator what to remove by hand.
  }
}

/** 0600 every FILE in the fixture — top level, artifacts, and refs.git — since the
 * ledger/audit rows and the trace are secret-adjacent and copies land world-readable
 * otherwise (C16, C-edge#13). Directory modes stay: git objects read fine for the
 * owning user. */
function chmodFixturePrivate(out: string): void {
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) chmodSync(p, 0o600);
    }
  };
  visit(out);
}

/** `.sandbox/pr` residue scan: a non-refusals file for THIS run carrying a
 * string `body`/`prBody` field on a JSON line. Today the writer only appends
 * refusals, so `auto` falls through to the live `gh` read — the scan exists so
 * a future body residue is preferred the moment one lands. */
function residueBody(prDir: string, runId: string): { text: string; origin: string } | undefined {
  if (!existsSync(prDir)) return undefined;
  for (const f of readdirSync(prDir).sort()) {
    if (!f.startsWith(`${runId}.`) || f.includes(".refusals.") || f.startsWith(".")) continue;
    const full = join(prDir, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (e) {
      refuse("residue-unreadable", `cannot stat .sandbox/pr residue entry ${full} (${(e as Error).message})`, "fix or remove the unreadable residue entry (dangling symlink, chmod-000) and re-run; the scan must prove the residue clean before the freeze falls through to gh");
    }
    if (!st.isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch (e) {
      refuse("residue-unreadable", `cannot read .sandbox/pr residue entry ${full} (${(e as Error).message})`, "fix or remove the unreadable residue entry and re-run; the scan must prove the residue clean before the freeze falls through to gh");
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        const b = o.body ?? o.prBody;
        if (typeof b === "string" && b.length > 0) return { text: b, origin: full };
      } catch {
        // Not JSON — not a body residue.
      }
    }
  }
  return undefined;
}

/** Resolve the PR body: file: → residue (auto only) → one gh read. Refuses to freeze without a body. */
async function resolvePrBody(args: Args, s: Sources): Promise<{ text: string; origin: string }> {
  const source = args.prBodySource;
  if (source.startsWith("file:")) {
    const path = resolve(source.slice("file:".length));
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (e) {
      refuse("pr-body-unavailable", `cannot read --pr-body-source file at ${path} (${(e as Error).message})`, "point file:<path> at an existing PR body file and re-run");
    }
    if (text.trim().length === 0) refuse("pr-body-unavailable", `PR body file at ${path} is empty`, "C8 audits pr-body.txt; an empty body cannot be frozen");
    return { text, origin: path };
  }
  if (source === "auto") {
    const residue = residueBody(join(REPO_ROOT, ".sandbox", "pr"), args.runId);
    if (residue !== undefined) return residue;
  }
  const gh = await run(["gh", "pr", "view", String(s.prNumber), "--json", "body", "-q", ".body", "--repo", s.repoSlug]);
  if (gh.code !== 0) {
    refuse("pr-body-unavailable", `gh pr view ${s.prNumber} --repo ${s.repoSlug} failed (exit ${gh.code}): ${stderrTail(gh.stderr)}`, "authenticate gh (its token is read from the environment, never logged here) or pass --pr-body-source file:<path>; the freeze refuses to ship no body");
  }
  // gh succeeded but the PR genuinely has no body — a distinct fault from a failed fetch (C-edge#12).
  if (gh.stdout.length === 0) {
    refuse("pr-body-empty", `the PR has no body: gh pr view ${s.prNumber} --repo ${s.repoSlug} returned an empty body`, "C8 audits pr-body.txt, so the freeze refuses to ship no body — give the PR a body, or pass --pr-body-source file:<path>");
  }
  // stdoutRaw: the trimmed field would shave meaningful leading/trailing whitespace off the body (C15).
  return { text: gh.stdoutRaw, origin: `gh pr view ${s.prNumber} --repo ${s.repoSlug}` };
}

/** The `--dry-run` plan: verify sources + print what a real freeze would write.
 * Runs BEFORE the lock is taken — a preview writes nothing and must not serialize
 * against a live harvest/teardown. Returns the process exit code (0 ok, 1 not-ok). */
async function printDryRun(args: Args, s: Sources): Promise<number> {
  const wal = `${s.ledgerPath}-wal`;
  const walBytes = existsSync(wal) ? fileSize(wal) : -1;
  console.log("dry-run: nothing will be written (no ledger checkpoint, no fixture files)");
  console.log("sources resolved:");
  console.log(manifestLine(`run-record ${s.recordPath}`, fileSize(s.recordPath)));
  console.log(manifestLine(`reverify ${s.reverifyPath}`, fileSize(s.reverifyPath)));
  console.log(manifestLine(`bundle ${s.bundlePath}`, fileSize(s.bundlePath)));
  console.log(`  artifacts ${s.artifactsDir} (trace/events.jsonl + trace/trace.db present)`);
  console.log(`  ledger ${s.ledgerPath} (${fileSize(s.ledgerPath)} bytes; -wal ${walBytes < 0 ? "absent" : `${walBytes} bytes`} — would PRAGMA wal_checkpoint(TRUNCATE))`);
  console.log(manifestLine(`audit-db ${s.auditDbPath}`, fileSize(s.auditDbPath)));
  console.log(`  ref ${s.ref} -> ${s.refSha} (verified in git-dir ${s.gitDir})`);
  const missing: string[] = [];
  if (args.prBodySource.startsWith("file:")) {
    const p = resolve(args.prBodySource.slice("file:".length));
    // Probe by READING, not existsSync: a dir at the path or an unreadable file must
    // fail the dry-run exactly where the real run would fail (C-edge#4).
    let text: string | undefined;
    try {
      text = await Bun.file(p).text();
    } catch {
      text = undefined;
    }
    console.log(`  pr-body file:${p} (${text === undefined ? "MISSING or unreadable" : `${Buffer.byteLength(text)} bytes`})`);
    if (text === undefined) missing.push(`pr-body file at ${p}`);
  } else {
    // residue is consulted for auto only (resolvePrBody's contract) — gh goes straight to the live read (C2).
    const residue = args.prBodySource === "auto" ? residueBody(join(REPO_ROOT, ".sandbox", "pr"), args.runId) : undefined;
    console.log(residue !== undefined ? `  pr-body residue ${residue.origin} (${residue.text.length} chars)` : `  pr-body will fetch: gh pr view ${s.prNumber} --repo ${s.repoSlug} (not fetched in dry-run)`);
  }
  console.log(`fixture plan (--out ${args.out}):`);
  console.log(`  ${args.runId}.json, ${args.runId}.reverify.jsonl, ${args.runId}.bundle, audit.db, cost-ledger.db, pr-body.txt`);
  console.log(`  ${args.runId}-artifacts/ (recursive copy) + refs.git/ (bare, ${s.ref} -> ${s.refSha})`);
  if (missing.length > 0) {
    console.log(`dry-run: NOT ok — ${missing.join("; ")} missing`);
    return 1;
  }
  console.log("dry-run ok: all sources resolved");
  return 0;
}

function manifestLine(rel: string, bytes: number): string {
  return `  ${rel.padEnd(48)} ${bytes} bytes`;
}

/** Recursive file listing under the frozen artifacts dir (refs.git is carried as one ref→sha manifest line instead — its bytes are git objects). */
function listFrozen(out: string, artifactsName: string): Array<[string, number]> {
  const rows: Array<[string, number]> = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) rows.push([r, statSync(p).size]);
    }
  };
  walk(join(out, artifactsName), artifactsName);
  return rows;
}

/** `--out` must be disjoint from every capture source dir, both directions (C-edge#7):
 * `--out` inside a source dir would self-copy the fixture into live evidence; a source
 * dir inside `--out` would have the freeze read what it is writing. Containment is a
 * relative-segment check, not a string prefix (`/tmp/out` does not contain `/tmp/outfox`).
 *
 * BOTH sides are resolved through their existing components FIRST (realpathThroughAbsent):
 * `resolve()` is lexical, so `--out /link/fixture` over a symlinked runs dir would pass a
 * lexical check and then mkdirSync/sentinel/cpSync would write the fixture into live
 * evidence. Resolving the deepest existing component on each side is what mkdir(2) will
 * actually walk. ponytail ceiling: this is a check-then-act — a component swapped to a
 * symlink AFTER the check and BEFORE the writes still races; the exclusive mkdir on the
 * leaf closes the leaf case (mkdir(2) never follows an existing entry), and the residual
 * intermediate-component race needs O_NOFOLLOW-style openat chains if it ever matters. */
function refuseOutOverlap(out: string, s: Sources): void {
  let realOut: string;
  try {
    realOut = realpathThroughAbsent(out);
  } catch (e) {
    refuse("out-unresolvable", `cannot resolve --out ${out} through the filesystem (${(e as Error).message})`, "replace the symlink cycle or unreadable directory on --out's path with a plain directory and re-run");
  }
  const sourceDirs: Array<[string, string]> = [
    ["--runs-dir", dirname(s.recordPath)],
    ["--reverify-dir", dirname(s.reverifyPath)],
    ["--ledger", dirname(s.ledgerPath)],
    ["--audit-db", dirname(s.auditDbPath)],
    ["--git-dir", s.gitDir],
  ];
  for (const [what, dir] of sourceDirs) {
    let realDir: string;
    try {
      realDir = realpathThroughAbsent(dir);
    } catch (e) {
      refuse("source-unresolvable", `cannot resolve ${what} ${dir} through the filesystem (${(e as Error).message})`, "fix the symlink cycle or unreadable directory on the source's path and re-run; the freeze must know where it reads from");
    }
    if (pathContains(realDir, realOut)) {
      refuse("out-overlaps-source", `--out ${out} resolves to ${realOut}, inside ${what} ${realDir} — the freeze would write the fixture into a live capture source`, "pick an --out outside every capture source directory and re-run");
    }
    if (pathContains(realOut, realDir)) {
      refuse("out-overlaps-source", `${what} ${dir} resolves to ${realDir}, inside --out ${out} (${realOut}) — the freeze would read the fixture it is writing`, "pick an --out outside every capture source directory and re-run");
    }
  }
}

/** What stands at --out right now — the idempotence guard's whole question.
 * A directory holding ONLY a capture-in-progress sentinel is its own kind: it
 * is not a partial frozen fixture (nothing was written yet), so the refusal it
 * earns is the stale-sentinel one, not the immutable-fixture one.
 *
 * lstat, not existsSync+stat: a symlink AT --out (dangling included) is its own
 * kind — existsSync followed it and misread a dangling link as "absent", which
 * sent the exclusive mkdirSync into a guaranteed EEXIST it would have mislabeled
 * as a concurrent capture. The freeze writes a REAL directory and refuses to
 * write through a link, wherever it points.
 *
 * A directory that is searchable but NOT readable (mode x-without-r) lstats fine
 * and then throws EACCES from readdirSync — an environment fault that used to
 * escape to main's exit-2 usage catch. It is its own kind instead; main turns it
 * into the typed out-unreadable refusal. Exported for tests
 * (tests/scripts/capture-run-of-record.test.ts). */
export function outKind(path: string): "absent" | "file" | "symlink" | "unreadable" | "empty" | "sentinel-only" | "non-empty" {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "file";
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return "unreadable";
  }
  if (entries.length === 0) return "empty";
  return entries.length === 1 && entries[0] === "capture-in-progress" ? "sentinel-only" : "non-empty";
}

// dp:ok (main) — the import.meta.main caller wraps main in the exit-2 catch; a throw here is a fatal usage fault, never a silent crash.
async function main(): Promise<number> { // dp:ok — caller wraps main in the exit-2 catch; a throw is a fatal fault, never a silent crash
  const args = parseArgs(Bun.argv.slice(2));
  const runsDir = args.runsDir ?? resolve(resolveRunsDir());

  if (args.dryRun) {
    const s = await resolveSources(args, runsDir);
    refuseOutOverlap(args.out, s);
    return await printDryRun(args, s);
  }

  // The DF2.5 per-run invocation lock — the SAME `<runsDir>/<runId>.lock` the harvest and
  // teardown CLIs acquire caller-side around their verbs (pullArtifacts takes none itself;
  // the acquire has always stayed with the caller). A concurrent re-harvest of this run
  // rm+renames `<runId>-artifacts` into place, so without this lock the tree
  // assertArtifactsWalkable vetted could be swapped out from under cpSync — a fixture
  // mixing two harvested generations. Held from BEFORE source validation through the
  // artifacts copy. Release: explicitly on the success and failure paths below; every
  // refuse() in between process.exit()s, and the lock module's own `process.on("exit")`
  // handler (installed by acquireRunLock) releases any non-destructive claim on the way
  // out — this capture never marks the lock destructive. `--dry-run` writes nothing and
  // deliberately takes no lock (a preview must not serialize against a live verb).
  let lock: RunLockHandle;
  // The lock file lives IN the runs dir, so a missing/unreadable runs dir must refuse
  // HERE, before the acquire turns it into a raw ENOENT — the same typed shape a
  // source-resolution fault gets below.
  mustExistDir(runsDir, "runs-dir-absent", "run-record directory");
  try {
    lock = acquireRunLock(runsDir, args.runId, "capture-run-of-record");
  } catch (e) {
    if (e instanceof RunLockedError) {
      refuse("run-locked", e.message, e.remediation);
    }
    refuse("run-lock-failed", `cannot acquire the per-run lock in ${runsDir} (${e instanceof Error ? e.message : String(e)})`, "fix the filesystem fault named above and re-run; the lock never steals — a held lock means another invocation of this run is live");
  }

  const s = await resolveSources(args, runsDir);
  refuseOutOverlap(args.out, s);

  // Idempotence: a frozen fixture is immutable. Existing-but-EMPTY is allowed (an interrupted earlier attempt may have left the shell behind).
  const out = outKind(args.out);
  if (out === "symlink") refuse("fixture-exists", `--out ${args.out} is a symlink, not a directory`, "the freeze writes a real directory and refuses to write through a link — remove or rename the symlink and re-run");
  if (out === "unreadable") refuse("out-unreadable", `--out ${args.out} is a directory this user cannot list`, "fix the permissions on --out so its entries can be listed, and re-run; the idempotence guard must see what the directory holds before the freeze writes into it");
  if (out === "file") refuse("fixture-exists", `--out ${args.out} exists and is a file, not a directory`, "a frozen fixture is a directory — move the file aside and re-run");
  if (out === "sentinel-only") {
    // Before the non-empty check: a stale sentinel guards an EMPTY shell — it
    // is not a partial fixture, so the honest refusal is the capture-in-progress
    // one with the remove-the-one-file remediation (not "move the fixture").
    refuse("capture-in-progress", `--out ${args.out} holds only a stale capture-in-progress sentinel — an earlier capture died before writing any fixture content`, `if no capture is running, remove that one file (${join(args.out, "capture-in-progress")}) and re-run`);
  }
  if (out === "non-empty") refuse("fixture-exists", `--out ${args.out} already exists and is non-empty (possibly a partial from an earlier failed capture)`, "a frozen fixture is immutable — move or delete it by hand, then re-run");

  // PR body FIRST: it is the one source that can still refuse (network) — a refusal after the writes would leave a partial fixture the guard then locks.
  const body = await resolvePrBody(args, s);

  checkpointLedger(s.ledgerPath);

  // When --out is absent, create it EXCLUSIVELY so two concurrent captures cannot both proceed:
  // the loser sees EEXIST and refuses instead of interleaving writes into the same fixture (C8).
  // existing-but-empty falls through: the shell left by an interrupted attempt is ours to fill.
  const createdOut = out === "absent";
  if (createdOut) {
    mkdirSync(dirname(args.out), { recursive: true });
    try {
      mkdirSync(args.out);
    } catch (e) {
      if ((e as Error & { code?: string }).code === "EEXIST") {
        refuse("capture-in-progress", `${args.out} was created concurrently by another capture`, "let the other capture finish; a frozen fixture is immutable — never delete one to squeeze a second in");
      }
      // Flags parsed long ago — a failure here is environmental, never "usage" (C-edge#2).
      refuse("out-unwritable", `cannot create --out ${args.out} (${(e as Error).message})`, "fix the permissions on the parent directory and re-run");
    }
  }
  // The sentinel is taken in BOTH branches (C-edge#8): a concurrent capture that adopted the same
  // empty shell must lose here too instead of interleaving its writes with ours.
  const sentinel = join(args.out, "capture-in-progress");
  try {
    closeSync(openSync(sentinel, "wx"));
  } catch (e) {
    if ((e as Error & { code?: string }).code === "EEXIST") {
      refuse("capture-in-progress", `another capture holds the exclusive sentinel at ${sentinel}`, "let the other capture finish; if no capture is running (a crashed attempt leaves the sentinel behind), remove that one file and re-run");
    }
    refuse("out-unwritable", `cannot write the capture sentinel in ${args.out} (${(e as Error).message})`, "fix the permissions on --out and re-run");
  }

  // Ref-freeze BEFORE any fixture write: a ref-freeze refusal (network/git class) must not lock a
  // partial fixture behind the idempotence guard (C7). Every fault from here to the final print
  // throws (FreezeRefusal or plain) — the catch removes what this run created, then refuses with
  // a typed payload; the usage prefix is for flag parsing only (C-edge#2, C-edge#3).
  let sha: string;
  try {
    sha = await freezeRefs(args.out, s);

    copyFileSync(s.recordPath, join(args.out, `${args.runId}.json`));
    copyFileSync(s.reverifyPath, join(args.out, `${args.runId}.reverify.jsonl`));
    copyFileSync(s.bundlePath, join(args.out, `${args.runId}.bundle`));
    copyFileSync(s.auditDbPath, join(args.out, "audit.db"));
    copyFileSync(s.ledgerPath, join(args.out, "cost-ledger.db"));
    selfContainLedgerCopy(join(args.out, "cost-ledger.db"));
    // dereference: a symlink in the harvest becomes a real file in the frozen copy (C14) — links
    // would escape it, and the manifest would undercount. assertArtifactsWalkable already
    // refused FIFOs/sockets/symlinks, so the dereference cannot hang or loop.
    cpSync(s.artifactsDir, join(args.out, `${args.runId}-artifacts`), { recursive: true, dereference: true });

    // TOCTOU: a writer may have resumed between checkpoint/open and the copy (C9, C-edge#1).
    throwIfLedgerWriterResumed(s.ledgerPath);
    throwIfAuditWriterResumed(s.auditDbPath);
    // And the audit copy itself must be a coherent SQLite image, not just
    // sidecar-free at the source (a writer can commit and drain its journal
    // inside the copy window): quick_check proves the snapshot tore nowhere.
    assertAuditCopyConsistent(join(args.out, "audit.db"));

    writeFileSync(join(args.out, "pr-body.txt"), body.text, { mode: 0o600 });
    chmodFixturePrivate(args.out);
  } catch (e) {
    // refuse() is process.exit and would skip a finally-based cleanup (C6 precedent), so clean
    // first, then refuse. The run lock releases here too — a failed capture is a
    // non-destructive lock hold, released normally exactly like withRunLock's throw arm
    // (a release failure is swallowed: the lock module's exit handler retries it).
    rmSync(sentinel, { force: true });
    cleanupPartialFixture(args.out, createdOut, args.runId);
    try {
      releaseRunLock(lock);
    } catch {
      // releaseHeldRunLocks retries at exit and reports; this refusal must not be masked.
    }
    if (e instanceof FreezeRefusal) refuse(e.code, e.message, e.remediation);
    refuse("copy-failed", `the freeze/copy phase failed after creating ${args.out} (${e instanceof Error ? e.message : String(e)})`, "clear the environmental fault named in the message (disk full, permissions), then remove the partial fixture directory and re-run; this was not a flag error");
  }
  rmSync(sentinel, { force: true }); // gone before the fixture is declared frozen
  releaseRunLock(lock); // the fixture is frozen — release before the manifest prints

  console.log(`froze fixture at ${args.out}`);
  for (const name of [`${args.runId}.json`, `${args.runId}.reverify.jsonl`, `${args.runId}.bundle`, "audit.db", "cost-ledger.db", "pr-body.txt"]) {
    console.log(manifestLine(name, fileSize(join(args.out, name))));
  }
  for (const [rel, bytes] of listFrozen(args.out, `${args.runId}-artifacts`)) {
    console.log(manifestLine(rel, bytes));
  }
  console.log(`  refs.git/ (bare repo; ${s.ref} -> ${sha}, object verified)`);
  console.log(`  pr-body source: ${body.origin}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (e) {
    // parseArgs throws usage errors; anything else is an unexpected fault before a conclusion — exit 2 per the CLI convention.
    exitWithFailure("capture-run-of-record: usage", 2, [e instanceof Error ? e.message : String(e), "try --help"]);
  }
}
