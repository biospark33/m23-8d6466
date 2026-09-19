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
 * store journals on DELETE, no sidecars), `cost-ledger.db` (only after a
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
 * The one exception: `--dry-run` over a missing source exits 1 with a plain
 * `dry-run: NOT ok` line (no typed payload — it never began a capture).
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { DEFAULT_AUDIT_DB_FILE } from "../../src/audit/index.ts";
import { DEFAULT_COST_LEDGER_FILE } from "../../src/providers/cost-ledger.ts";
import { resolveRunsDir } from "../../src/providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR } from "../../src/reverify/report.ts";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";

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

/** freezeRefs' refusals INSIDE its tmp-bundle try must throw, not call refuse():
 * refuse() → process.exit() skips the `finally` that removes the temp bundle
 * (C6). The outer catch converts this back to the typed exit after cleanup ran. */
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

/** Resolve + verify EVERY source before any write: a half-frozen fixture is worse than none (the gate would read a fixture silently missing a seam). */
async function resolveSources(args: Args): Promise<Sources> {
  const runId = args.runId;
  const runsDir = args.runsDir ?? resolve(resolveRunsDir());
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
  // The harvest bundle: C9's run-bundle hop digest-checks it against the audit link rows.
  const bundlePath = join(runsDir, `${runId}.bundle`);
  mustExistFile(bundlePath, "bundle-absent", "harvest bundle");
  mustExistFile(ledgerPath, "ledger-absent", "cost ledger");
  mustExistFile(auditDbPath, "audit-db-absent", "audit-links store");
  // audit.db ships as a plain copy — no checkpoint, no sidecar — so a live audit writer would be
  // frozen mid-write (C4).
  const auditWal = `${auditDbPath}-wal`;
  if (existsSync(auditWal) && fileSize(auditWal) > 0) {
    refuse("audit-wal-live", `${auditWal} is non-empty — a live writer holds the audit-links store`, "quiesce the audit writer, confirm the -wal drains, and re-run; the freeze ships the audit store as a plain sidecar-less copy");
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
    refuse("ledger-fixture-unopenable", `cannot open the copied ledger at ${fixtureLedger} for journal conversion (${(e as Error).message})`, "remove the partial fixture dir and re-run");
  }
  try {
    const mode = db.prepare("PRAGMA journal_mode = DELETE;").get() as Record<string, unknown>;
    if (mode?.journal_mode !== "delete") {
      refuse("ledger-fixture-unopenable", `journal_mode = DELETE did not take on ${fixtureLedger} (got ${JSON.stringify(mode?.journal_mode)})`, "remove the partial fixture dir and re-run");
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
    refuse("ledger-fixture-unopenable", `the frozen ledger copy at ${fixtureLedger} fails the read-only open C10 performs (${(e as Error).message})`, "remove the partial fixture dir and re-run");
  }
}

/** Build `<out>/refs.git`: a bare repo carrying exactly the sandbox ref + its reachable objects, via a temp bundle under os.tmpdir(). */
async function freezeRefs(out: string, s: Sources): Promise<string> {
  const refsGit = join(out, "refs.git");
  const init = await run(["git", "init", "--bare", "--quiet", refsGit]);
  if (init.code !== 0) {
    refuse("refs-init-failed", `git init --bare ${refsGit} failed: ${stderrTail(init.stderr)}`, "remove the partial fixture dir and re-run");
  }
  const tmp = mkdtempSync(join(tmpdir(), "df54-capture-"));
  try {
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
  } catch (e) {
    if (e instanceof FreezeRefusal) refuse(e.code, e.message, e.remediation);
    throw e;
  }
  const v = await run(["git", "--git-dir", refsGit, "rev-parse", "--verify", s.ref]);
  if (v.code !== 0 || v.stdout !== s.refSha) {
    refuse("refs-verify-failed", `refs.git verification failed: expected ${s.ref} -> ${s.refSha}, got exit ${v.code} ${v.stdout}`, "the fixture is partial; remove it and re-run");
  }
  const cat = await run(["git", "--git-dir", refsGit, "cat-file", "-e", s.refSha]);
  if (cat.code !== 0) {
    refuse("refs-object-missing", `cat-file -e ${s.refSha} failed in refs.git — the ref resolves but its object did not travel`, "remove the partial fixture dir and re-run");
  }
  return s.refSha;
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
    if (!statSync(full).isFile()) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
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
  if (gh.code !== 0 || gh.stdout.length === 0) {
    refuse("pr-body-unavailable", `gh pr view ${s.prNumber} --repo ${s.repoSlug} failed (exit ${gh.code}): ${stderrTail(gh.stderr)}`, "authenticate gh (its token is read from the environment, never logged here) or pass --pr-body-source file:<path>; the freeze refuses to ship no body");
  }
  // stdoutRaw: the trimmed field would shave meaningful leading/trailing whitespace off the body (C15).
  return { text: gh.stdoutRaw, origin: `gh pr view ${s.prNumber} --repo ${s.repoSlug}` };
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

/** What stands at --out right now — the idempotence guard's whole question. */
function outKind(path: string): "absent" | "file" | "empty" | "non-empty" {
  if (!existsSync(path)) return "absent";
  if (!statSync(path).isDirectory()) return "file";
  return readdirSync(path).length > 0 ? "non-empty" : "empty";
}

// dp:ok (main) — the import.meta.main caller wraps main in the exit-2 catch; a throw here is a fatal usage fault, never a silent crash.
async function main(): Promise<number> { // dp:ok — caller wraps main in the exit-2 catch; a throw is a fatal fault, never a silent crash
  const args = parseArgs(Bun.argv.slice(2));
  const s = await resolveSources(args);

  // Idempotence: a frozen fixture is immutable. Existing-but-EMPTY is allowed (an interrupted earlier attempt may have left the shell behind).
  const out = outKind(args.out);
  if (out === "file") refuse("fixture-exists", `--out ${args.out} exists and is a file, not a directory`, "a frozen fixture is a directory — move the file aside and re-run");
  if (out === "non-empty") refuse("fixture-exists", `--out ${args.out} already exists and is non-empty (possibly a partial from an earlier failed capture)`, "a frozen fixture is immutable — move or delete it by hand, then re-run");

  const wal = `${s.ledgerPath}-wal`;
  const walBytes = existsSync(wal) ? fileSize(wal) : -1;

  if (args.dryRun) {
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
      const present = existsSync(p);
      console.log(`  pr-body file:${p} (${present ? `${fileSize(p)} bytes` : "MISSING"})`);
      if (!present) missing.push(`pr-body file at ${p}`);
    } else {
      // residue is consulted for auto only (resolvePrBody's contract) — gh goes straight to the live read (C2).
      const residue = args.prBodySource === "auto" ? residueBody(join(REPO_ROOT, ".sandbox", "pr"), args.runId) : undefined;
      console.log(residue !== undefined ? `  pr-body residue ${residue.origin} (${residue.text.length} chars)` : `  pr-body would fetch: gh pr view ${s.prNumber} --repo ${s.repoSlug} (not fetched in dry-run)`);
    }
    console.log(`fixture plan (--out ${args.out}; ${out}):`);
    console.log(`  ${args.runId}.json, ${args.runId}.reverify.jsonl, ${args.runId}.bundle, audit.db, cost-ledger.db, pr-body.txt`);
    console.log(`  ${args.runId}-artifacts/ (recursive copy) + refs.git/ (bare, ${s.ref} -> ${s.refSha})`);
    if (missing.length > 0) {
      console.log(`dry-run: NOT ok — ${missing.join("; ")} missing`);
      return 1;
    }
    console.log("dry-run ok: all sources resolved");
    return 0;
  }

  // PR body FIRST: it is the one source that can still refuse (network) — a refusal after the writes would leave a partial fixture the guard then locks.
  const body = await resolvePrBody(args, s);

  checkpointLedger(s.ledgerPath);

  // When --out is absent, create it EXCLUSIVELY so two concurrent captures cannot both proceed:
  // the loser sees EEXIST and refuses instead of interleaving writes into the same fixture (C8).
  // existing-but-empty falls through: the shell left by an interrupted attempt is ours to fill.
  if (out === "absent") {
    mkdirSync(dirname(args.out), { recursive: true });
    try {
      mkdirSync(args.out);
    } catch (e) {
      if ((e as Error & { code?: string }).code === "EEXIST") {
        refuse("capture-in-progress", `${args.out} was created concurrently by another capture`, "let the other capture finish; a frozen fixture is immutable — never delete one to squeeze a second in");
      }
      throw e;
    }
  }

  // Ref-freeze BEFORE any fixture write: a ref-freeze refusal (network/git class) must not lock a
  // partial fixture behind the idempotence guard (C7). freezeRefs creates out/refs.git itself;
  // local-disk copy failures below stay fatal-unusual, covered by the existing remediation text.
  const sha = await freezeRefs(args.out, s);

  copyFileSync(s.recordPath, join(args.out, `${args.runId}.json`));
  copyFileSync(s.reverifyPath, join(args.out, `${args.runId}.reverify.jsonl`));
  copyFileSync(s.bundlePath, join(args.out, `${args.runId}.bundle`));
  copyFileSync(s.auditDbPath, join(args.out, "audit.db"));
  copyFileSync(s.ledgerPath, join(args.out, "cost-ledger.db"));
  selfContainLedgerCopy(join(args.out, "cost-ledger.db"));
  // dereference: a symlink in the harvest becomes a real file in the frozen copy (C14) — links
  // would escape it, and the manifest would undercount.
  cpSync(s.artifactsDir, join(args.out, `${args.runId}-artifacts`), { recursive: true, dereference: true });

  // TOCTOU: a ledger writer may have resumed between checkpointLedger and the copy (C9).
  const ledgerWal = `${s.ledgerPath}-wal`;
  if (existsSync(ledgerWal) && fileSize(ledgerWal) > 0) {
    refuse("ledger-wal-live", `${ledgerWal} is non-empty after the copy — a writer resumed mid-capture; the frozen copy may be stale`, "quiesce writers, remove the partial fixture, re-run");
  }

  writeFileSync(join(args.out, "pr-body.txt"), body.text, { mode: 0o600 });
  // The frozen top-level files are secret-adjacent (ledger, audit links) — 0600 across them too (C16).
  for (const name of [`${args.runId}.json`, `${args.runId}.reverify.jsonl`, `${args.runId}.bundle`, "audit.db", "cost-ledger.db"]) {
    chmodSync(join(args.out, name), 0o600);
  }

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
