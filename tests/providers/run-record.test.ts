/**
 * DF2.1 — run-record store + CLI.
 *
 * The tests that matter here are the ones a plausible-but-wrong implementation
 * fails: a check-then-write `create`, a `try/catch`-and-skip `list`, an in-place
 * `set`. Each is called out where it bites.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run as cliRun } from "../../scripts/run-record.ts";
import { setLogSink } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { teardownRun } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import {
  CORE_FIELDS,
  LOCK_TIMEOUT_MS,
  RunRecordStore,
  SETTABLE_FIELDS,
  assertValidRunId,
  newId,
} from "../../src/providers/run-record.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "scripts/run-record.ts");

/**
 * A pid no OS will ever allocate — above PID_MAX on every platform this runs
 * on, so `kill(pid, 0)` is ESRCH and the "dead owner" fixtures are decided by
 * the kernel, not by a race against pid recycling.
 */
const DEAD_PID = 999_999_999;

let dir: string;
let store: RunRecordStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-runs-"));
  store = new RunRecordStore({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, QDS_RUNS_DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function snapshot(id: string): { bytes: string; mtimeMs: number } {
  const p = join(dir, `${id}.json`);
  return { bytes: readFileSync(p, "utf8"), mtimeMs: statSync(p).mtimeMs };
}

// ---------------------------------------------------------------------------
// AC1 / INV-3 — creation is O_EXCL, not a check-then-write
// ---------------------------------------------------------------------------

describe("create (AC1, INV-3)", () => {
  test("first create writes mode 0600; second rejects with EEXIST from open(2)", () => {
    store.create("run-a");
    const before = snapshot("run-a");
    expect(statSync(join(dir, "run-a.json")).mode & 0o777).toBe(0o600);

    let err: NodeJS.ErrnoException | undefined;
    try {
      store.create("run-a");
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    // A check-then-write implementation throws its own Error and has no
    // syscall/errno — this assertion is what makes it fail.
    expect(err?.code).toBe("EEXIST");
    expect(err?.syscall).toBe("open");
    expect(snapshot("run-a")).toEqual(before);
  });

  test("interleaved creates of one id from separate processes: exactly one winner", async () => {
    const id = "race-run";
    const results = await Promise.all(Array.from({ length: 6 }, () => cli(["create", id])));
    const winners = results.filter((r) => r.exitCode === 0);
    const losers = results.filter((r) => r.exitCode !== 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(5);
    for (const l of losers) expect(l.stderr).toContain("EEXIST");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([`${id}.json`]);
  }, 30_000);

  test("the record exists before anything else can (INV-1 handle)", () => {
    const rec = store.create("run-b");
    expect(rec.runId).toBe("run-b");
    expect(typeof rec.createdAt).toBe("string");
    expect(rec.vmName).toBeUndefined();
    expect(store.get("run-b")).toEqual(rec);
  });
});

// ---------------------------------------------------------------------------
// AC2 — closed schema, immutability, extensions, atomic replace
// ---------------------------------------------------------------------------

describe("set (AC2)", () => {
  beforeEach(() => {
    store.create("run-c");
  });

  test("a core key outside the twelve-field schema is rejected naming the key", () => {
    const before = snapshot("run-c");
    expect(() => store.set("run-c", { vmNmae: "typo" } as never)).toThrow(/unknown key: vmNmae/);
    expect(snapshot("run-c")).toEqual(before);
  });

  test("immutable fields are rejected naming the key", () => {
    const before = snapshot("run-c");
    expect(() => store.set("run-c", { runId: "other" } as never)).toThrow(/immutable key: runId/);
    expect(() => store.set("run-c", { createdAt: "2020-01-01" } as never)).toThrow(/immutable key: createdAt/);
    expect(snapshot("run-c")).toEqual(before);
  });

  test("all twelve core fields round-trip with their declared types", () => {
    const rec = store.set("run-c", {
      vmName: "run-c",
      httpsUrl: "https://run-c.example",
      keyHash: "sha256:abc",
      limitMicroUsd: 5_000_000,
      spendMicroUsd: 12,
      sessionId: "sess-1",
      commitSha: "5734129",
      ports: [8080, 9090],
      pid: 4242,
    });
    expect(rec.commitSha).toBe("5734129"); // a string that happens to parse as a number
    expect(rec.ports).toEqual([8080, 9090]);
    expect(store.get("run-c")).toEqual(rec);
  });

  test("wrong value types are rejected", () => {
    expect(() => store.set("run-c", { pid: "4242" } as never)).toThrow(/pid must be an integer/);
    expect(() => store.set("run-c", { limitMicroUsd: 1.5 })).toThrow(/limitMicroUsd must be an integer/);
    expect(() => store.set("run-c", { ports: ["80"] } as never)).toThrow(/ports must be an array of integers/);
    expect(() => store.set("run-c", { vmName: 7 } as never)).toThrow(/vmName must be a string/);
  });

  test("extensions: unregistered namespace rejected, registered sub-keys accepted", () => {
    const before = snapshot("run-c");
    expect(() => store.set("run-c", { extensions: { telemetry: { foo: "bar" } } })).toThrow(
      /unregistered extension namespace: extensions\.telemetry/,
    );
    expect(snapshot("run-c")).toEqual(before);

    const withPr = store.set("run-c", { extensions: { pr: { prUrl: "https://github.com/x/y/pull/1" } } });
    expect(withPr.extensions?.pr).toEqual({ schemaVersion: 1, prUrl: "https://github.com/x/y/pull/1" });

    const withFanout = store.set("run-c", { extensions: { fanout: { fanoutId: "f1", arm: "a" } } });
    expect(withFanout.extensions?.fanout).toEqual({ schemaVersion: 1, fanoutId: "f1", arm: "a" });
    // Merging never drops a previously written namespace.
    expect(withFanout.extensions?.pr?.prUrl).toBe("https://github.com/x/y/pull/1");
  });

  test("an unregistered field inside a registered namespace is rejected naming the key", () => {
    expect(() => store.set("run-c", { extensions: { pr: { prTitle: "x" } } })).toThrow(
      /unknown key: extensions\.pr\.prTitle/,
    );
  });

  test("a top-level key other than the twelve plus extensions is rejected", () => {
    expect(() => store.set("run-c", { notes: "x" } as never)).toThrow(/unknown key: notes/);
  });

  test("INV-2 catches punctuated credential shapes (AWS secret key, JWT)", () => {
    // The high-value shapes all carry `/`, `+`, `=` or `.` — a charset of only
    // [A-Za-z0-9_-] would wave every one of them through.
    const aws = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(() => store.set("run-c", { sessionId: aws })).toThrow(/key material/);
    expect(() => store.set("run-c", { sessionId: jwt })).toThrow(/key material/);
    expect(() => store.set("run-c", { extensions: { fanout: { fanoutId: aws } } })).toThrow(/key material/);
  });

  test("INV-2 catches a credential riding inside a URL, without tripping on lookalike words", () => {
    expect(() => store.set("run-c", { httpsUrl: "https://box.example.com/cb?token=sk-live-abc123" })).toThrow(
      /key material/,
    );
    // `task-runner` contains the literal "sk-"; a substring test would reject it.
    expect(store.set("run-c", { sessionId: "task-runner-session-7" }).sessionId).toBe("task-runner-session-7");
  });

  test("INV-2 does NOT fire on a long URL — httpsUrl and prUrl are first-class fields", () => {
    const url = "https://Box-20260813-a1b2c3.factory.example.com/artifacts/run/9/bundle.tar.gz";
    expect(url.length).toBeGreaterThan(40);
    expect(store.set("run-c", { httpsUrl: url }).httpsUrl).toBe(url);
    const pr = store.set("run-c", { extensions: { pr: { prUrl: `${url}?x=1` } } });
    expect(pr.extensions?.pr?.prUrl).toBe(`${url}?x=1`);
  });

  test("INV-2 does NOT fire on the record's own legal values (40-char SHA, long run id)", () => {
    // A git SHA is 40 lowercase hex chars and a run id is lowercase hostname
    // text — a length-only secret heuristic rejects both, and would do it after
    // the box already exists. These are the fields the record exists to hold.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const longId = `${"a-very-long-but-entirely-legal-run-slug"}-20260813-d60b0a`;
    expect(longId.length).toBeGreaterThan(40);
    const rec = store.set("run-c", { commitSha: sha, vmName: longId, sessionId: `session-${sha}` });
    expect(rec.commitSha).toBe(sha);
    expect(rec.vmName).toBe(longId);
  });

  test("INV-2 does NOT fire on a legal repoSlug — and still fires on a key-shaped value elsewhere", () => {
    // The one that burned budget: `store.create` had already made the record,
    // so refusing the budget write here left an OPEN record with no
    // `extensions.budget` for teardown to price — the ledger's orphan guard
    // never expired the reservation, and every retry burned another one until
    // the issue's cap was gone. 43 chars, mixed case, a digit, and every
    // character inside the heuristic's charset: a repo slug is
    // indistinguishable from a token BY SHAPE, which is why the exemption is
    // keyed on the field path instead.
    const slug = "BiosparkHealth/QDS-Factory-Pipeline-Engine2";
    expect(slug.length).toBe(43);
    expect(slug).toMatch(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/); // BriefSchema's grammar
    const rec = store.set("run-c", {
      extensions: { budget: { repoSlug: slug, issueId: "1234567", admittedCeilingMicroUsd: 500_000 } },
    });
    expect(rec.extensions?.budget?.repoSlug).toBe(slug);

    // The control: the exemption is one path, not a hole. The same value on a
    // non-exempt path is still refused, and so is a real key on the exempt one.
    expect(() => store.set("run-c", { sessionId: slug })).toThrow(/key material/);
    expect(() => store.set("run-c", { extensions: { fanout: { fanoutId: slug } } })).toThrow(/key material/);
    expect(() => store.set("run-c", { extensions: { budget: { repoSlug: "ghp_abcdefghijklmnop" } } })).toThrow(
      /key material/,
    );
  });

  test("closedAt is close()'s to write, never set()'s", () => {
    const before = snapshot("run-c");
    // `as never`: the patch type refuses closedAt at compile time too — this
    // cast is what lets the runtime rejection still be asserted.
    expect(() => store.set("run-c", { closedAt: "" } as never)).toThrow(/closedAt is written by close\(\)/);
    expect(() => store.set("run-c", { closedAt: new Date().toISOString() } as never)).toThrow(/closedAt/);
    expect(snapshot("run-c")).toEqual(before);
  });

  test("SETTABLE_FIELDS is the exact writable set: every listed field set() accepts, every excluded one it rejects", () => {
    // The export is the CLI's flag table, so it must track the store's actual
    // behavior — a field the CLI would offer as a flag but set() rejects (the
    // next operation-managed field added like closedAt) is a command that can
    // only ever fail. The rejected set is the complement of the exported
    // policy, NOT a hardcoded list: a field later added to IMMUTABLE_FIELDS (or
    // rejected like closedAt) must land in one loop or the other, never in a
    // silent gap between them.
    for (const f of SETTABLE_FIELDS) {
      const v = CORE_FIELDS[f] === "int" ? 1 : CORE_FIELDS[f] === "ports" ? [1] : "x";
      expect(() => store.set("run-c", { [f]: v } as never)).not.toThrow();
    }
    const rejected = Object.keys(CORE_FIELDS).filter((k) => !SETTABLE_FIELDS.includes(k));
    expect(rejected.length).toBeGreaterThan(0); // the complement is never empty
    for (const f of rejected) {
      expect(() => store.set("run-c", { [f]: "x" } as never)).toThrow();
    }
  });

  test("INV-2: credential-shaped values are refused, in core fields and in extensions", () => {
    expect(() => store.set("run-c", { sessionId: "sk-livesecrettokenvalue" })).toThrow(/key material/);
    expect(() => store.set("run-c", { extensions: { fixLoop: { fixContext: "ghp_abc123" } } })).toThrow(
      /key material/,
    );
    // keyHash is the sanctioned credential-derived field — a hash is not key
    // material, so only the LENGTH heuristic is waived for it...
    expect(store.set("run-c", { keyHash: "sha256:0f".repeat(20) }).keyHash).toContain("sha256:");
    expect(store.set("run-c", { keyHash: "TWFuIGlzIGRpc3Rpbmd1aXNoZWQsIG5vdCBvbmx5IGJ5aGlz" }).keyHash).toBeString();
    // ...not the prefix scan. `--keyHash <raw key>` is a first-class CLI path,
    // and it is the field an operator is most likely to paste a real key into.
    expect(() => store.set("run-c", { keyHash: "sk-live-abcdefghijklmnop" })).toThrow(/key material/);
    expect(() => store.set("run-c", { keyHash: "-----BEGIN OPENSSH PRIVATE KEY-----" })).toThrow(/key material/);
  });

  test("a failure injected between temp-write and rename leaves the record byte-identical", () => {
    const before = snapshot("run-c");
    const failing = new RunRecordStore({
      dir,
      beforeRename: () => {
        throw new Error("injected");
      },
    });
    expect(() => failing.set("run-c", { vmName: "boom" })).toThrow("injected");
    expect(snapshot("run-c")).toEqual(before);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a SIGKILL between temp-write and rename leaves the record byte-identical; the stale .tmp is cleaned at construction", async () => {
    const before = snapshot("run-c");
    const script = `
      import { RunRecordStore } from ${JSON.stringify(join(REPO_ROOT, "src/providers/run-record.ts"))};
      const s = new RunRecordStore({ dir: ${JSON.stringify(dir)}, beforeRename: () => {
        process.kill(process.pid, "SIGKILL");
        // SIGKILL is not catchable; spin so we never reach the rename.
        for (;;) {}
      }});
      s.set("run-c", { vmName: "never-lands" });
    `;
    const proc = Bun.spawn({ cmd: ["bun", "-e", script], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    expect(snapshot("run-c")).toEqual(before);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length).toBe(1);

    new RunRecordStore({ dir });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(snapshot("run-c")).toEqual(before);
  }, 30_000);
});

describe("close", () => {
  test("first close wins; the second succeeds and keeps closedAt", () => {
    store.create("run-d");
    const first = store.close("run-d");
    expect(first.closedAt).toBeString();
    const second = store.close("run-d", new Date(Date.now() + 60_000));
    expect(second.closedAt).toBe(first.closedAt as string);
    expect(store.get("run-d").closedAt).toBe(first.closedAt as string);
  });

  test("core fields freeze at close; extensions stay writable", () => {
    store.create("run-e");
    store.close("run-e");
    const before = readFileSync(join(dir, "run-e.json"), "utf8");
    expect(() => store.set("run-e", { vmName: "late" })).toThrow(/closed/);
    expect(readFileSync(join(dir, "run-e.json"), "utf8")).toBe(before);
    const rec = store.set("run-e", { extensions: { pr: { prNumber: 12 } } });
    expect(rec.extensions?.pr).toEqual({ schemaVersion: 1, prNumber: 12 });
    expect(rec.closedAt).toBeString();
  });
});

// ---------------------------------------------------------------------------
// AC3 / INV-4 — a bad record is a hard error, never a skipped entry
// ---------------------------------------------------------------------------

describe("list (AC3, INV-4)", () => {
  test("a truncated record makes list throw naming the file — never skip it", () => {
    store.create("run-good");
    writeFileSync(join(dir, "run-bad.json"), '{"runId":"run-bad","created', { mode: 0o600 });
    // A try/catch-and-skip implementation returns [run-good] and fails here.
    expect(() => store.list()).toThrow(/run-bad\.json/);
  });

  test("a schema-invalid record (unknown key) is also a hard error", () => {
    store.create("run-good");
    writeFileSync(join(dir, "run-odd.json"), JSON.stringify({ runId: "run-odd", createdAt: "x", nope: 1 }), {
      mode: 0o600,
    });
    expect(() => store.list()).toThrow(/run-odd\.json.*unknown key: nope/s);
  });

  test("a record whose runId disagrees with its filename is a hard error", () => {
    writeFileSync(join(dir, "run-x.json"), JSON.stringify({ runId: "run-y", createdAt: "x" }), { mode: 0o600 });
    expect(() => store.list()).toThrow(/run-x\.json/);
  });

  test("a record with an unparseable createdAt is a hard error", () => {
    store.create("run-good");
    writeFileSync(join(dir, "run-bad-ts.json"), JSON.stringify({ runId: "run-bad-ts", createdAt: "not-a-timestamp" }), {
      mode: 0o600,
    });
    expect(() => store.list()).toThrow(/malformed run record run-bad-ts\.json.*createdAt/);
  });

  test("a .json whose name is not a valid run id makes list() REFUSE, and is named on the log line", () => {
    // `list()` returns a bare `RunRecord[]` with no channel for "and there was
    // also this". Returning the short list was fail-OPEN, and `reapRuns` builds
    // its claim set from exactly this call: a skipped `.json` holding an open
    // record with a `vmName` drops that box out of `claimed` and the reaper
    // destroys a LIVE box. So the incomplete listing is refused outright, and a
    // caller that can handle the gap asks `listWithAnomalies()` for it instead.
    store.create("run-good");
    writeFileSync(join(dir, "Bad Name.json"), JSON.stringify({ runId: "x", createdAt: "y" }), { mode: 0o600 });
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => {
      lines.push(e as unknown as Record<string, unknown>);
    });
    try {
      expect(() => store.list()).toThrow(/Bad Name\.json/);
    } finally {
      restore();
    }
    expect(lines.some((l) => JSON.stringify(l).includes("Bad Name.json"))).toBe(true);
  });

  test("a skipped file is visible in the RETURN value, not only on the log line", () => {
    // A log line cannot make a caller fail safe. `reapRuns` builds its claim
    // set from these records and destroys every box not in it, so a skipped
    // `.json` holding a valid OPEN record with a `vmName` drops that box out of
    // the claim set and the reaper destroys a live box. The skip has to be
    // readable where the records are read.
    store.create("run-good");
    writeFileSync(join(dir, "Bad Name.json"), JSON.stringify({ runId: "x", createdAt: "y" }), { mode: 0o600 });
    const listing = store.listWithAnomalies();
    expect(listing.records.map((r) => r.runId)).toEqual(["run-good"]);
    expect(listing.skipped).toEqual(["Bad Name.json"]);
    // A clean directory reports an empty array, never `undefined` — a caller
    // guarding on `.length` must not need a null check to be correct.
    rmSync(join(dir, "Bad Name.json"));
    expect(store.listWithAnomalies().skipped).toEqual([]);
  });

  test("an unreadable record is a hard error too, not a skipped entry", () => {
    if (process.getuid?.() === 0) return; // root reads mode-0000 files; nothing to prove
    store.create("run-locked");
    chmodSync(join(dir, "run-locked.json"), 0o000);
    try {
      expect(() => store.list()).toThrow(/unreadable run record run-locked\.json.*EACCES/);
    } finally {
      chmodSync(join(dir, "run-locked.json"), 0o600);
    }
  });

  test("a record written by a NEWER extensions schema still lists", () => {
    // Strict version equality on the read path would make one newer writer (or
    // one rollback) stop the reaper from reaping anything at all.
    store.create("run-future");
    writeFileSync(
      join(dir, "run-future.json"),
      JSON.stringify({
        runId: "run-future",
        createdAt: new Date().toISOString(),
        extensions: { pr: { schemaVersion: 2, prUrl: "https://x/y/pull/1", prState: "merged" } },
      }),
      { mode: 0o600 },
    );
    const listed = store.list();
    expect(listed.map((r) => r.runId)).toEqual(["run-future"]);
    expect(listed[0]?.extensions?.pr).toMatchObject({ schemaVersion: 2, prState: "merged" });
    // An UNREGISTERED namespace is still a hard error — that is accountability,
    // not version skew.
    writeFileSync(
      join(dir, "run-alien.json"),
      JSON.stringify({ runId: "run-alien", createdAt: "x", extensions: { telemetry: { schemaVersion: 1 } } }),
      { mode: 0o600 },
    );
    expect(() => store.list()).toThrow(/run-alien\.json.*telemetry/s);
  });

  test("list() never throws on a VALUE inside a registered namespace", () => {
    // The write-time guards (secret shape, field types) must not fire on read:
    // one such record would throw out of list(), and INV-4 makes that the
    // reaper reaping nothing — the outage the guard exists to prevent.
    writeFileSync(
      join(dir, "run-odd-ext.json"),
      JSON.stringify({
        runId: "run-odd-ext",
        createdAt: new Date().toISOString(),
        extensions: { fixLoop: { schemaVersion: 1, fixContext: "sk-live-looks-like-a-key", fixOutcome: 7 } },
      }),
      { mode: 0o600 },
    );
    expect(store.list().map((r) => r.runId)).toEqual(["run-odd-ext"]);
    // The WRITE path stays exact.
    expect(() => store.set("run-odd-ext", { extensions: { fixLoop: { fixContext: "sk-live-x" } } })).toThrow(
      /key material/,
    );
  });

  test("non-json files are ignored; records come back sorted", () => {
    store.create("run-2");
    store.create("run-1");
    writeFileSync(join(dir, "README.txt"), "not a record");
    expect(store.list().map((r) => r.runId)).toEqual(["run-1", "run-2"]);
  });

  test("an interrupted create's zero-byte record is quarantined, not allowed to kill the listing", () => {
    // A SIGKILL between `openSync(p,"wx")` and the write leaves an empty file.
    // `JSON.parse("")` throws, and one throw out of the sweep is a FLEET-WIDE
    // outage rather than one bad file: `listWithAnomalies()` dies, `list()`
    // dies with it, so `reapRuns` reaps NOTHING and `fleet status` renders
    // NOTHING until an operator deletes the file by hand — while every live box
    // keeps billing.
    store.create("run-good");
    writeFileSync(join(dir, "run-empty.json"), "", { mode: 0o600 });

    const listing = store.listWithAnomalies();
    // The other record still comes back. That is the whole point.
    expect(listing.records.map((r) => r.runId)).toEqual(["run-good"]);
    expect(listing.skipped).toEqual(["run-empty.json"]);
    // The reason rides along, same index — a caller rendering the anomaly has
    // to be able to say WHY without re-reading the file itself.
    expect(listing.skippedReasons).toHaveLength(1);
    expect(listing.skippedReasons[0]).toContain("run-empty.json");
  });

  test.each([
    ["an unknown key", "run-odd", JSON.stringify({ runId: "run-odd", createdAt: "x", nope: 1 }), /nope/],
    [
      "an unparseable createdAt",
      "run-bad-ts",
      JSON.stringify({ runId: "run-bad-ts", createdAt: "not-a-timestamp" }),
      /createdAt/,
    ],
  ])("a body rejected for %s is ONE skipped entry, and list() names the reason", (_label, id, body, reasonRe) => {
    // Quarantined per FILE, not per sweep. The hard-error tests above pin that
    // `list()` still refuses — safety is the default — but they cannot tell a
    // refusal that named the file from one that took the whole listing down
    // with it, because both throw. This is the half that distinguishes them.
    store.create("run-good");
    writeFileSync(join(dir, `${id}.json`), body, { mode: 0o600 });

    const listing = store.listWithAnomalies();
    expect(listing.records.map((r) => r.runId)).toEqual(["run-good"]);
    expect(listing.skipped).toEqual([`${id}.json`]);
    expect(listing.skippedReasons[0]).toMatch(reasonRe);

    // `list()` still throws on a non-empty `skipped` — and its message now
    // carries the reason, not just the filename. A caller handed
    // "run-odd.json could not be read" has to go look; one handed "unknown key:
    // nope" already knows which build wrote it.
    let err: Error | undefined;
    try {
      store.list();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain(`${id}.json`);
    expect(err?.message).toMatch(reasonRe);
  });

  test("an unreadable record is ONE skipped entry too, carrying its errno", () => {
    if (process.getuid?.() === 0) return; // root reads mode-0000 files; nothing to prove
    store.create("run-good");
    store.create("run-locked");
    chmodSync(join(dir, "run-locked.json"), 0o000);
    try {
      // A transient EIO/EACCES on ONE file must not be a fleet-wide outage
      // either — same quarantine as a bad body.
      const listing = store.listWithAnomalies();
      expect(listing.records.map((r) => r.runId)).toEqual(["run-good"]);
      expect(listing.skipped).toEqual(["run-locked.json"]);
      expect(listing.skippedReasons[0]).toContain("EACCES");
      expect(() => store.list()).toThrow(/run-locked\.json.*EACCES/s);
    } finally {
      chmodSync(join(dir, "run-locked.json"), 0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// An interrupted create's zero-byte tombstone must not make the id permanently
// uncreatable — while a SIBLING create's zero-byte window stays untouchable
// ---------------------------------------------------------------------------

describe("create tombstone", () => {
  /**
   * The documented grace is 5s (CREATE_TOMBSTONE_GRACE_MS, not exported). Ten
   * times it, so a modest retune does not turn this into a false failure — the
   * boundary itself is pinned by the in-grace case below, which back-dates by
   * nothing at all.
   */
  const WELL_PAST_GRACE_MS = 50_000;

  test("a stale zero-byte record is cleared, so the run id is reusable", () => {
    // The file is not `.tmp` and not `.probe-`, so `cleanStaleTemps` never
    // sweeps it, and its stem is a perfectly valid run id, so nothing else
    // refuses it either — the id became a permanent EEXIST tombstone only an
    // operator could clear by hand. Removing it loses NOTHING: zero bytes carry
    // no keyHash, no vmName, no createdAt, so there is no key nobody revokes
    // and no box nobody reaps. That is what makes it compatible with INV-3.
    const id = "run-tombstone";
    const p = join(dir, `${id}.json`);
    writeFileSync(p, "", { mode: 0o600 });
    const past = new Date(Date.now() - WELL_PAST_GRACE_MS);
    utimesSync(p, past, past);

    const rec = store.create(id);
    expect(rec.runId).toBe(id);
    // A REAL record now sits at the path, not an empty file.
    expect(statSync(p).size).toBeGreaterThan(0);
    expect(store.get(id).createdAt).toBe(rec.createdAt);
  });

  test("a CONCURRENT create's zero-byte window is NOT cleared — size alone is not enough", () => {
    // A sibling `create()` of the same id is zero-byte too, for the
    // microseconds between its `openSync` and its write. Clearing on size alone
    // would let two creates both believe they own the id, which is INV-3
    // broken by the very guard meant to preserve it. The mtime grace is the
    // separator: written to this instant ⇒ a live writer.
    const id = "run-inflight";
    const p = join(dir, `${id}.json`);
    writeFileSync(p, "", { mode: 0o600 }); // fresh mtime, i.e. inside the grace

    let err: NodeJS.ErrnoException | undefined;
    try {
      store.create(id);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    // The ORIGINAL EEXIST, not a second less recognisable errno.
    expect(err?.code).toBe("EEXIST");
    // And the sibling's in-flight file is still exactly where it left it.
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBe(0);
  });

  test("only ONE retry: a real record at the path is never overwritten", () => {
    // The retry exists for the tombstone and nothing else. A second EEXIST
    // means a real record (or another writer's fresh create) is there, and
    // INV-3's no-overwrite is absolute for those.
    const id = "run-real";
    const first = store.create(id);
    const before = snapshot(id);
    expect(() => store.create(id)).toThrow();
    expect(snapshot(id)).toEqual(before);
    expect(store.get(id).createdAt).toBe(first.createdAt);
  });

  test("a competitor that clears the tombstone first leaves create free to win the retry (ENOENT take)", () => {
    // Two creators can pass the aged-zero-byte check on the SAME tombstone; the
    // removal is therefore a rename-claim (`<p>.tomb.<pid>.<hex>.tmp`) so it has
    // exactly one winner. The loser's rename then finds NOTHING — the winner
    // already took the corpse aside — and that ENOENT means the path is free:
    // surfacing it as a stranger's errno wedged the id behind an error naming
    // nothing, where the single-winner contract says this creator may now run
    // its exclusive create. The injection below vanishes the tombstone between
    // the aged check and the rename — precisely the window the competitor wins.
    const id = "run-tomb-race";
    const p = join(dir, `${id}.json`);
    writeFileSync(p, "", { mode: 0o600 });
    const past = new Date(Date.now() - WELL_PAST_GRACE_MS);
    utimesSync(p, past, past);

    const realRename = nodeFs.renameSync;
    let fired = false;
    const spy = spyOn(nodeFs, "renameSync").mockImplementation(((from: unknown, to: unknown) => {
      if (from === p && String(to).includes(".tomb.")) {
        fired = true;
        spy.mockRestore(); // restore FIRST — the retried create below needs the real fs
        rmSync(p, { force: true }); // the competitor won the take; the corpse is gone
        return realRename(from as string, to as string); // → ENOENT
      }
      return realRename(from as string, to as string);
    }) as typeof nodeFs.renameSync);
    try {
      const rec = store.create(id);
      expect(rec.runId).toBe(id);
      expect(fired).toBe(true); // the ENOENT arm really ran, not a vacuous pass
      // A REAL record sits at the path — no empty file, no stranded .tmp.
      expect(statSync(p).size).toBeGreaterThan(0);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — every verb routes through path(), which validates first
// ---------------------------------------------------------------------------

describe("id validation (AC6)", () => {
  const bad = ["../evil", "A-b", "a".repeat(64), "-lead", "", "run_id", "run/id", "run.id"];
  /**
   * Illegal to CREATE, but legal to reach on a read/write path: any earlier
   * build could name a record this way, and a record no verb can open is a box
   * that keeps billing with no route to teardown.
   */
  const legacyOnly = ["trailing-", "a--"];

  test("path() refuses every illegal id", () => {
    for (const id of bad) expect(() => store.path(id)).toThrow(/invalid run id/);
    // …but not the legacy tail — `path()` is the read/write door.
    for (const id of legacyOnly) expect(() => store.path(id)).not.toThrow();
  });

  test("create/get/set/close all refuse illegal ids and write nothing", () => {
    for (const id of bad) {
      expect(() => store.create(id)).toThrow(/invalid run id/);
      expect(() => store.get(id)).toThrow(/invalid run id/);
      expect(() => store.set(id, { vmName: "x" })).toThrow(/invalid run id/);
      expect(() => store.close(id)).toThrow(/invalid run id/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a legacy-named record is uncreatable but fully readable, writable and closable", () => {
    const id = "trailing-";
    // Creation is strict: no NEW record can be named this way.
    expect(() => store.create(id)).toThrow(/invalid run id/);
    expect(readdirSync(dir)).toEqual([]);
    // One that already exists (any pre-tightening build) stays serviceable —
    // otherwise the run can never be closed and the box keeps billing.
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ runId: id, createdAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    expect(store.get(id).runId).toBe(id);
    expect(store.set(id, { vmName: "box-legacy" }).vmName).toBe("box-legacy");
    expect(typeof store.close(id).closedAt).toBe("string");
    expect(store.list().map((r) => r.runId)).toEqual([id]);
  });

  test("63 chars is legal, 64 is not", () => {
    const ok = "a".repeat(63);
    expect(() => assertValidRunId(ok)).not.toThrow();
    expect(() => assertValidRunId(`${ok}a`)).toThrow(/invalid run id/);
  });

  test("the hyphen rule is the RFC 1123 one: interior only, never either end", () => {
    // A trailing hyphen is not a hostname label, so a box can never be named
    // it. Refusing only the LEADING one deferred that to the provider — after
    // a record existed. Both ends refuse here, before any path is built.
    for (const id of ["trailing-", "a--", "-leading", "-", "--"]) {
      expect(() => assertValidRunId(id)).toThrow(/invalid run id/);
    }
    // Interior hyphens are the whole point of the grammar (`<slug>-<day>-<hex>`),
    // and a single character is a legal label.
    for (const id of ["a", "7", "a-b", "qds-20260821-a1b2c3", `a-${"b".repeat(59)}-c`]) {
      expect(() => assertValidRunId(id)).not.toThrow();
    }
    // The 63-char cap still applies at both ends of the grammar.
    expect(() => assertValidRunId(`a-${"b".repeat(61)}`)).not.toThrow(); // exactly 63
    expect(() => assertValidRunId(`a-${"b".repeat(62)}`)).toThrow(/invalid run id/); // 64
  });

  test("newId generates a validated <slug>-<YYYYMMDD>-<6 hex> id", () => {
    const id = newId("qds", new Date("2026-08-11T10:00:00Z"));
    expect(id).toMatch(/^qds-20260811-[0-9a-f]{6}$/);
    expect(newId("qds")).not.toBe(newId("qds"));
    expect(() => newId("Bad_Slug")).toThrow(/invalid run id/);
    expect(() => newId("a".repeat(60))).toThrow(/invalid run id/);
  });
});

// ---------------------------------------------------------------------------
// INV-5 — fail-closed construction, and the directory contract
// ---------------------------------------------------------------------------

describe("store construction (INV-5)", () => {
  test("creates the records directory at mode 0700", () => {
    const fresh = join(dir, "nested", "runs");
    const s = new RunRecordStore({ dir: fresh });
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
  });

  test("an existing loose-moded directory is tightened to 0700", () => {
    const loose = join(dir, "loose");
    mkdirSync(loose, { mode: 0o777 });
    new RunRecordStore({ dir: loose });
    expect(statSync(loose).mode & 0o777).toBe(0o700);
  });

  test("construction fails loudly when the directory cannot be used", () => {
    const notADir = join(dir, "file");
    writeFileSync(notADir, "x");
    expect(() => new RunRecordStore({ dir: notADir })).toThrow();
  });

  test("create:false touches nothing — no chmod, no probe, no sweep", () => {
    // The whole point of the read mode. `fleet teardown qds-nosuchrun --dir
    // /srv/existing` exits 4 as promised while the probe silently
    // re-permissioned an operator's directory to 0700 — the "mutates nothing"
    // clause broken by the constructor, not by the verb.
    const loose = join(dir, "readonly-probe");
    mkdirSync(loose, { mode: 0o755 });
    const orphanTemp = join(loose, `run-x.json.${DEAD_PID}.dead.tmp`);
    writeFileSync(orphanTemp, "x");
    const s = new RunRecordStore({ dir: loose, create: false });
    expect(statSync(loose).mode & 0o777).toBe(0o755);
    // The stale-temp sweep would have taken this (dead owner) — read mode does not.
    expect(existsSync(orphanTemp)).toBe(true);
    // …and the O_EXCL/link probe left nothing behind either.
    expect(readdirSync(loose)).toEqual([`run-x.json.${DEAD_PID}.dead.tmp`]);
    // Reading still works.
    expect(s.listWithAnomalies().records).toEqual([]);
  });

  test("create:false on a missing directory fails cleanly, with the errno preserved", () => {
    // The caller maps this to its own exit code off the TYPED code; what it
    // must not get is a bare ENOENT stack out of the first readdirSync.
    let err: NodeJS.ErrnoException | undefined;
    try {
      new RunRecordStore({ dir: join(dir, "nope"), create: false });
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err?.code).toBe("ENOENT");
    expect(err?.message).toContain("nope");
    // …and it did not create it on the way past.
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  test("create:false refuses to WRITE — the 0700/O_EXCL proof was skipped, not passed", () => {
    // Otherwise `create: false` is a way to write records into a directory
    // whose posture and platform support were never proven: INV-5 reached by
    // omitting the proof rather than by failing it.
    const s = new RunRecordStore({ dir, create: false });
    expect(() => s.create("run-ro")).toThrow(/read-only/);
    store.create("run-rw");
    expect(() => s.set("run-rw", { vmName: "box" })).toThrow(/read-only/);
    expect(() => s.close("run-rw")).toThrow(/read-only/);
    // …and the record it refused to touch is untouched.
    expect(s.get("run-rw").vmName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLI — AC4 and the e2e demo
// ---------------------------------------------------------------------------

describe("CLI", () => {
  // Most CLI assertions run the command in-process: `run()` returns the exit
  // code and writes through the sink, so a subprocess buys nothing but latency.
  // The cases that genuinely need the process boundary — the exit-1 mapping and
  // the mandatory e2e walk — still spawn.
  const inproc = (args: string[]): { code: number; out: string } => {
    let out = "";
    const code = cliRun(["--dir", dir, ...args], (s) => {
      out += s;
    });
    return { code, out };
  };

  test("get on an unset field exits 0 and prints an empty line (AC4)", () => {
    store.create("run-cli");
    expect(inproc(["get", "run-cli", "vmName"])).toEqual({ code: 0, out: "\n" });
  });

  test("get on a set field prints the value; ports print as JSON", () => {
    store.create("run-cli2");
    store.set("run-cli2", { vmName: "box-1", ports: [8080] });
    expect(inproc(["get", "run-cli2", "vmName"]).out).toBe("box-1\n");
    expect(inproc(["get", "run-cli2", "ports"]).out).toBe("[8080]\n");
  });

  test("get on an unknown field is an error, not an empty line", () => {
    store.create("run-cli3");
    expect(() => inproc(["get", "run-cli3", "vmNmae"])).toThrow(/unknown key: vmNmae/);
  });

  test("an error exits 1 with the message on stderr and nothing on stdout", async () => {
    store.create("run-cli-exit");
    const r = await cli(["get", "run-cli-exit", "vmNmae"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown key: vmNmae");
  });

  test("illegal ids are refused by the CLI too (AC6)", () => {
    for (const id of ["../evil", "A-b", "a".repeat(64)]) {
      expect(() => inproc(["create", id])).toThrow(/invalid run id/);
      expect(() => inproc(["get", id, "vmName"])).toThrow(/invalid run id/);
      expect(() => inproc(["path", id])).toThrow(/invalid run id/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("set coerces per field: ints, ports JSON, everything else string", () => {
    store.create("run-cli4");
    const r = inproc([
      "set",
      "run-cli4",
      "--pid",
      "4242",
      "--limitMicroUsd",
      "5000000",
      "--ports",
      "[8080,9090]",
      "--commitSha",
      "5734129",
    ]);
    expect(r.code).toBe(0);
    const rec = store.get("run-cli4");
    expect(rec.pid).toBe(4242);
    expect(rec.limitMicroUsd).toBe(5_000_000);
    expect(rec.ports).toEqual([8080, 9090]);
    expect(rec.commitSha).toBe("5734129");
  });

  test("set rejects values that do not match the field's declared coercion", () => {
    store.create("run-cli5");
    expect(() => inproc(["set", "run-cli5", "--pid", "abc"])).toThrow(/--pid must be an integer/);
    expect(() => inproc(["set", "run-cli5", "--ports", "8080"])).toThrow(/--ports must be a JSON array/);
    expect(() => inproc(["set", "run-cli5", "--ports", '["80"]'])).toThrow(/--ports must be a JSON array/);
    expect(store.get("run-cli5").pid).toBeUndefined();
  });

  test("--ext writes a registered namespace and refuses an unregistered one", () => {
    store.create("run-cli6");
    expect(inproc(["set", "run-cli6", "--ext", "pr.prNumber=7"]).code).toBe(0);
    expect(store.get("run-cli6").extensions?.pr).toEqual({ schemaVersion: 1, prNumber: 7 });
    expect(() => inproc(["set", "run-cli6", "--ext", "telemetry.foo=bar"])).toThrow(/extensions\.telemetry/);
    expect(() => inproc(["set", "run-cli6", "--ext", "prprUrl=x"])).toThrow(/--ext expects/);
    expect(() => inproc(["set", "run-cli6", "--ext", "pr.prNumber=seven"])).toThrow(/must be an integer/);
  });

  test("unknown flags, unknown commands and missing operands all fail loudly", () => {
    expect(() => inproc(["set", "x-1", "--nope", "1"])).toThrow(/unknown flag: --nope/);
    expect(() => inproc(["frobnicate"])).toThrow(/unknown command: frobnicate/);
    expect(() => inproc([])).toThrow(/missing command/);
    expect(() => inproc(["get", "x-1"])).toThrow(/get requires <field>/);
    expect(() => inproc(["create"])).toThrow(/create requires <id>/);
  });

  test("--dir wins over $QDS_RUNS_DIR", async () => {
    const other = mkdtempSync(join(tmpdir(), "qds-runs-alt-"));
    try {
      const r = await cli(["create", "dir-flag-run", "--dir", other]);
      expect(r.exitCode).toBe(0);
      expect(readdirSync(other)).toEqual(["dir-flag-run.json"]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("e2e: new-id + create + set + close + list walks the record through the real CLI", async () => {
    const idRes = await cli(["new-id", "qds"]);
    expect(idRes.exitCode).toBe(0);
    const id = idRes.stdout.trim();
    expect(id).toMatch(/^qds-\d{8}-[0-9a-f]{6}$/);

    expect((await cli(["create", id])).stdout.trim()).toBe(join(dir, `${id}.json`));
    expect(statSync(join(dir, `${id}.json`)).mode & 0o777).toBe(0o600);
    await cli(["set", id, "--vmName", id, "--httpsUrl", `https://${id}.example`]);
    expect((await cli(["close", id])).exitCode).toBe(0);

    const listed = (await cli(["list"])).stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(listed).toHaveLength(1);
    expect(listed[0].runId).toBe(id);
    expect(listed[0].vmName).toBe(id);
    expect(listed[0].closedAt).toBeString();

    // A second create of the same id fails with EEXIST.
    const again = await cli(["create", id]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("EEXIST");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Stale temp ownership — the sweep must not eat a live writer's in-flight file
// ---------------------------------------------------------------------------

describe("stale temp sweep", () => {
  test("a dead owner's temp is swept; a live owner's temp is left alone", async () => {
    store.create("run-t");
    const live = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      // `DEAD_PID`, not a spawned-and-reaped corpse: a reaped pid can be recycled
      // by a forking CI box between the reap and this write, and the sweep then
      // correctly spares a "stale" temp the assertion demands be gone. It is not
      // 999_999 either — Linux's default pid_max is 4194304, so SIX digits can
      // name a live process, and another user's pid answers kill(0) with EPERM,
      // which reads as alive. DEAD_PID is above pid_max everywhere.
      writeFileSync(join(dir, `run-t.json.${DEAD_PID}.aaaa1111.tmp`), "{}", { mode: 0o600 });
      writeFileSync(join(dir, `run-t.json.${live.pid}.bbbb2222.tmp`), "{}", { mode: 0o600 });

      new RunRecordStore({ dir });

      const temps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(temps).toEqual([`run-t.json.${live.pid}.bbbb2222.tmp`]);
    } finally {
      live.kill();
      await live.exited;
    }
  });

  // The SIX-part lock-aside name (`<runId>.json.lock.<pid>.<hex>.tmp`), not the
  // five-part record temp above. A death between the steal/release `rename` and
  // the `rm` strands a lock generation unless this sweeps, and a sweep that
  // mis-parses the pid the other way deletes a LIVE writer's in-flight claim.
  test("a dead owner's lock-aside temp is swept; a live owner's is left alone", async () => {
    store.create("run-la");
    const live = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      const dead = `run-la.json.lock.${DEAD_PID}.aaaa1111.tmp`;
      const alive = `run-la.json.lock.${live.pid}.bbbb2222.tmp`;
      writeFileSync(join(dir, dead), `${DEAD_PID} deadbeef\n`, { mode: 0o600 });
      writeFileSync(join(dir, alive), `${live.pid} cafebabe\n`, { mode: 0o600 });

      new RunRecordStore({ dir });

      const temps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(temps).toEqual([alive]);
    } finally {
      live.kill();
      await live.exited;
    }
  });
});

// ---------------------------------------------------------------------------
// Observability contract — every mutation logs, failures included
// ---------------------------------------------------------------------------

describe("observability", () => {
  test("create and a failed set both emit one line; the failure carries {code, message}", () => {
    const entries: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => {
      entries.push(e as unknown as Record<string, unknown>);
    });
    try {
      const s = new RunRecordStore({ dir, requestId: "req-1" });
      s.create("run-log");
      expect(() => s.set("run-log", { nope: 1 } as never)).toThrow();
      expect(() => s.create("run-log")).toThrow();
    } finally {
      restore();
    }

    const byVerb = (v: string) => entries.filter((e) => e.verb === v);
    expect(byVerb("create")).toHaveLength(2);
    const [okCreate, dupCreate] = byVerb("create");
    expect(okCreate).toMatchObject({ requestId: "req-1", runId: "run-log", outcome: "ok" });
    expect(typeof okCreate?.record_write_ms).toBe("number");
    expect(dupCreate).toMatchObject({ outcome: "error", error: { code: "EEXIST" } });

    const failedSet = byVerb("set")[0] as { outcome: string; error: { code: string; message: string } };
    expect(failedSet.outcome).toBe("error");
    expect(failedSet.error.message).toContain("unknown key: nope");
  });

  test("a keyHash value never reaches the log stream", () => {
    const entries: unknown[] = [];
    const restore = setLogSink((e) => {
      entries.push(e);
    });
    try {
      const s = new RunRecordStore({ dir });
      s.create("run-secretish");
      s.set("run-secretish", { keyHash: "sha256:deadbeefcafe" });
    } finally {
      restore();
    }
    expect(JSON.stringify(entries)).not.toContain("deadbeefcafe");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle verbs over the seam — the record-side half of the crash windows
// ---------------------------------------------------------------------------

describe("teardownRun", () => {
  test("destroys the box even when the crash beat the vmName write", async () => {
    const id = "crash-window-run";
    const boxes = mkdtempSync(join(tmpdir(), "qds-teardown-boxes-"));
    try {
      const driver = new FakeDriver(boxes);
      store.create(id);
      await driver.create(id); // crash lands here: box alive, vmName unwritten
      expect(store.get(id).vmName).toBeUndefined();

      const closed = await teardownRun(driver, store, id);
      expect(closed.closedAt).toBeString();
      expect(await driver.list(id)).toEqual([]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency — a read-modify-write must not discard another writer's field
// ---------------------------------------------------------------------------

describe("concurrent set", () => {
  test("two processes writing different fields both survive", async () => {
    const id = "lost-update-run";
    store.create(id);
    // DF2.3 mints keyHash while the dispatcher writes vmName — the real pairing.
    const writer = (field: string, value: string) =>
      Bun.spawn({
        cmd: ["bun", CLI, "set", id, `--${field}`, value, "--dir", dir],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
    const procs = [writer("vmName", "box-1"), writer("keyHash", "sha256:abc"), writer("sessionId", "sess-1")];
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0]);

    const rec = store.get(id);
    expect(rec.vmName).toBe("box-1");
    expect(rec.keyHash).toBe("sha256:abc");
    expect(rec.sessionId).toBe("sess-1");
  }, 30_000);

  test("a lock left by a dead process is stolen, not waited on", () => {
    const id = "stale-lock-run";
    store.create(id);
    writeFileSync(store.lockPath(id), `${DEAD_PID}\n`, { mode: 0o600 });
    const started = Date.now();
    expect(store.set(id, { vmName: "box-2" }).vmName).toBe("box-2");
    // Well inside the timeout, expressed against the constant: a steal that
    // started waiting it out is the regression, not a slow fsync.
    expect(Date.now() - started).toBeLessThan(LOCK_TIMEOUT_MS / 2);
    expect(existsSync(store.lockPath(id))).toBe(false);
  });

  test("an unreadable lock body is held, never stolen as junk", () => {
    // The exact state the old two-step claim (create, THEN write the pid)
    // exposed: a contender landing in that window read an empty body, scored
    // the owner as 0, judged the lock junk and stole it from a live holder —
    // and two read-modify-writes then dropped a field. An owner that cannot be
    // proved dead means WAIT, even if that ends in a fail-closed timeout.
    const id = "empty-lock-run";
    store.create(id);
    const lock = store.lockPath(id);
    writeFileSync(lock, "", { mode: 0o600 });
    const started = Date.now();
    expect(() => store.set(id, { vmName: "box-3" })).toThrow(/timed out waiting for the run record lock/);
    // The FULL window, not "a while": the loop only throws once `Date.now()`
    // has passed `start + LOCK_TIMEOUT_MS`, so anything short of it is a
    // shortened fail-closed window, not a fast machine. Derived from the import,
    // so it holds at whatever the timeout is set to — which also means a retune
    // moves this assertion with it. The line below is what notices the retune:
    // shortening the wait shortens the window in which a contender proves an
    // owner dead, and raises the odds two writers overlap.
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS);
    expect(LOCK_TIMEOUT_MS).toBe(5_000);
    expect(existsSync(lock)).toBe(true); // still held by whoever wrote it
    expect(store.get(id).vmName).toBeUndefined();
    rmSync(lock, { force: true });
  }, 15_000);

  test("release never unlinks a lock this process no longer owns", () => {
    // An unconditional `rm` in the finally deletes whatever sits at the path —
    // including the lock a second writer legitimately holds after ours was
    // cleared by hand. That reopens the lost update from the other side.
    const id = "release-proof-run";
    // `store.lockPath(id)`, never a hand-spelled `join(dir, id + ".lock")` —
    // the lock hangs off `path()`, which appends `.json`, so the shorter
    // spelling names a file the lock code never touches and the assertion below
    // would only read back what this test itself wrote.
    const s0 = new RunRecordStore({ dir });
    const lock = s0.lockPath(id);
    // `process.ppid`: a pid that is genuinely alive and genuinely not ours.
    // `process.pid + 1` is frequently a live process too, but only by accident —
    // and it can equally be free, which makes the fixture's premise a coin flip.
    const foreign = `${process.ppid} deadbeefcafe\n`;
    let fired = false;
    const s = new RunRecordStore({
      dir,
      beforeRename: () => {
        fired = true;
        rmSync(lock, { force: true });
        writeFileSync(lock, foreign, { mode: 0o600 });
      },
    });
    s.create(id);
    expect(s.set(id, { vmName: "box-4" }).vmName).toBe("box-4");
    // The seam really ran. Without this a refactor that moves the rename out of
    // `beforeRename`'s reach stops opening the window at all, and the assertion
    // below degrades into an ENOENT instead of naming what broke.
    expect(fired).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(foreign);
    rmSync(lock, { force: true });
  });

  test("a steal never unlinks a lock claimed after the corpse was cleared", () => {
    // The steal-side twin of the test above, and the same lost update through
    // the other door. `stealIfOwnerGone` judges a corpse, then removes it —
    // and in between, the corpse can be cleared (an operator, another store's
    // stale-temp sweep, the dead pid's number coming back) and a NEW writer can
    // legitimately claim the now-free path. A bare `rm` there deletes that live
    // writer's lock and lets two read-modify-writes overlap.
    const id = "steal-proof-run";
    const lock = store.lockPath(id);
    // `process.ppid` is a pid that is genuinely alive and is not ours, so every
    // steal attempt AFTER the swap must judge this lock held and wait it out.
    const live = `${process.ppid} deadbeefcafe\n`;
    let swapped = false;
    const s = new RunRecordStore({
      dir,
      beforeStealTake: () => {
        if (swapped) return; // the claim loop retries; the window opens once
        swapped = true;
        rmSync(lock, { force: true });
        writeFileSync(lock, live, { mode: 0o600 });
      },
    });
    s.create(id);
    writeFileSync(lock, `${DEAD_PID}\n`, { mode: 0o600 }); // the corpse

    // Fail-closed: the live lock is never stolen, so the write times out.
    expect(() => s.set(id, { vmName: "box-5" })).toThrow(/timed out waiting for the run record lock/);
    expect(swapped).toBe(true); // the window really opened
    expect(readFileSync(lock, "utf8")).toBe(live); // the new writer's lock survived
    expect(s.get(id).vmName).toBeUndefined(); // and its record was not overwritten
    rmSync(lock, { force: true });
  }, 15_000);

  // Root reads a mode-000 file, so the fault below cannot be injected there.
  const asRoot = process.getuid?.() === 0;

  test.skipIf(asRoot)("a steal whose taken body cannot be READ puts it back instead of removing it", () => {
    // The read after the take is what proves the taken generation is the corpse
    // that was judged. When it FAILS — EIO on a failing mount, EACCES on a body
    // another user wrote — nothing is proved, and the take races exactly the
    // window the test above covers: the corpse cleared, a live writer's claim
    // landing at the free path, this rename taking THAT. Removing it there
    // unlocks a holder still inside its `fn()`.
    const id = "steal-unreadable-run";
    const lock = store.lockPath(id);
    let injected = false;
    const s = new RunRecordStore({
      dir,
      afterLockTake: (claimed) => {
        if (injected) return; // the claim loop retries; the fault fires once
        injected = true;
        chmodSync(claimed, 0o000);
      },
    });
    s.create(id);
    writeFileSync(lock, `${DEAD_PID}\n`, { mode: 0o600 }); // judged stale, then taken

    // Fail-closed: an unprovable take is HELD, so the write waits it out.
    expect(() => s.set(id, { vmName: "box-6" })).toThrow(/timed out waiting for the run record lock/);
    expect(injected).toBe(true); // the fault really fired
    // The generation is back at the lock path — not deleted, and not stranded
    // under a `.tmp` name only `cleanStaleTemps` would ever find.
    expect(existsSync(lock)).toBe(true);
    chmodSync(lock, 0o600);
    expect(readFileSync(lock, "utf8")).toBe(`${DEAD_PID}\n`);
    expect(s.get(id).vmName).toBeUndefined();
    rmSync(lock, { force: true });
  }, 15_000);

  test.skipIf(asRoot)("a release whose taken body cannot be READ puts it back instead of removing it", () => {
    // `releaseLock`'s take-then-compare has the same hole: between its read and
    // its rename, `stealIfOwnerGone` can retire this lock and a new writer claim
    // the path. A read failure after the take cannot tell that apart from our
    // own body, and removing it deletes the new writer's lock. Leaving the
    // generation on the path strands THIS run's lock — recoverable, and named by
    // every later refusal — which is the fail-closed half of the trade.
    const id = "release-unreadable-run";
    const lock = store.lockPath(id);
    let injected = false;
    const s = new RunRecordStore({
      dir,
      afterLockTake: (claimed) => {
        if (injected) return;
        injected = true;
        chmodSync(claimed, 0o000);
      },
    });
    s.create(id);
    // The write itself completes — the fault is on the release, after the
    // record has already been replaced.
    expect(s.set(id, { vmName: "box-7" }).vmName).toBe("box-7");
    expect(injected).toBe(true);
    expect(existsSync(lock)).toBe(true); // put back, never unlinked
    chmodSync(lock, 0o600);
    expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid}\\s`));
    rmSync(lock, { force: true });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Same-pid lock bodies — two JS threads share process.pid, so the pid alone
// cannot tell a live sibling holder from a sibling that DIED holding its claim
// ---------------------------------------------------------------------------

describe("own-pid lock generations", () => {
  /**
   * The documented grace is OWN_LOCK_GRACE_MS (60s, not exported). Twice it, so
   * a modest retune does not turn this into a false failure.
   */
  const WELL_PAST_LOCK_GRACE_MS = 120_000;

  test("an own-pid body left by a dead sibling thread is stolen once it ages past the grace", () => {
    // Our pid is alive forever, so `isAlive` can never prove this lock dead and
    // no sweep touches locks — before the age bound, a sibling thread that died
    // holding its claim wedged the id for the rest of the PROCESS lifetime: the
    // record was unwritable and unclosable while its box billed. Age is the
    // separator; past the grace, the steal must be as fast as the foreign-pid
    // one above, not waited out.
    const id = "ownpid-aged-run";
    store.create(id);
    const lock = store.lockPath(id);
    writeFileSync(lock, `${process.pid} cafebabe\n`, { mode: 0o600 }); // our pid, a FOREIGN nonce
    const past = new Date(Date.now() - WELL_PAST_LOCK_GRACE_MS);
    utimesSync(lock, past, past);

    const started = Date.now();
    expect(store.set(id, { vmName: "box-8" }).vmName).toBe("box-8");
    // Fast hand-off, expressed against the constant like the dead-pid case.
    expect(Date.now() - started).toBeLessThan(LOCK_TIMEOUT_MS / 2);
    // Released cleanly after the mutation — nothing held aside is stranded.
    expect(existsSync(lock)).toBe(false);
  });

  test("a YOUNG own-pid foreign body is still HELD — it times out the full window, never stolen", () => {
    // Inside the grace the same shape is a live sibling's claim, and stealing
    // one of those lets two setLocked read-modify-writes overlap and drop a
    // field — INV-4's named failure mode. Fail-closed means the FULL window,
    // not "a while": the same bound the unreadable-body case pins below-sibling.
    const id = "ownpid-young-run";
    store.create(id);
    const lock = store.lockPath(id);
    const foreignNonce = `${process.pid} deadbabe\n`;
    writeFileSync(lock, foreignNonce, { mode: 0o600 }); // fresh mtime ⇒ inside the grace

    const started = Date.now();
    expect(() => store.set(id, { vmName: "box-9" })).toThrow(/timed out waiting for the run record lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS);
    // Never taken aside: the sibling's generation is byte-for-byte where it was.
    expect(readFileSync(lock, "utf8")).toBe(foreignNonce);
    expect(store.get(id).vmName).toBeUndefined();
    rmSync(lock, { force: true });
  }, 15_000);

  test("re-entrancy outranks the grace: an AGED outer claim is still reported re-entrant, not stolen", () => {
    // A long enclosing write CAN age past OWN_LOCK_GRACE_MS while an inner,
    // seam-driven set() on the same record waits behind it. Ordering matters:
    // judged by age alone, the inner call would take the outer claim aside
    // mid-write; the per-thread heldLocks check fires FIRST, so the timeout
    // names the real deadlock instead of reporting contention with a phantom
    // sibling writer.
    const id = "reentrant-aged-run";
    const lock = new RunRecordStore({ dir }).lockPath(id);
    let innerErr: Error | undefined;
    const outer = new RunRecordStore({
      dir,
      beforeRename: () => {
        // Backdate the OUTER claim past the grace — without the ordering, the
        // aged body below reads exactly like a dead sibling's leftover.
        const past = new Date(Date.now() - WELL_PAST_LOCK_GRACE_MS);
        utimesSync(lock, past, past);
        try {
          store.set(id, { vmName: "inner" });
        } catch (e) {
          innerErr = e as Error;
        }
        throw new Error("injected"); // abort the enclosing write, byte-identical
      },
    });
    outer.create(id);
    expect(() => outer.set(id, { vmName: "outer" })).toThrow("injected");
    expect(innerErr).toBeDefined();
    expect(innerErr?.message).toMatch(/timed out waiting for the run record lock/);
    expect(innerErr?.message).toContain("re-entrant record write");
    // The enclosing write released its own claim in the finally — no wedge.
    expect(existsSync(lock)).toBe(false);
  }, 20_000);

  test("putBack losing to a competitor parks the taken body as a .orphan. sibling and says so", () => {
    // The EEXIST half of put-back used to DELETE the held-aside bytes — but
    // EEXIST proves only that the PATH carries a newer link, nothing about whose
    // bytes sit at `claimed`. Those bytes can be a live holder's generation, and
    // unlinking them unlocks a holder still inside its fn(): the lost update,
    // entered through the park door. Now they are parked under a unique orphan
    // name and named on stderr instead.
    const id = "orphan-park-run";
    store.create(id);
    const lock = store.lockPath(id);
    const corpse = `${DEAD_PID} aaaa1111\n`; // what the stealer JUDGES stale...
    const takenAside = `${process.ppid} cafebabe\n`; // ...and what it actually TAKES
    const competitor = `${process.ppid} deadbabe\n`; // ...and what reclaims the path
    let swapped = false;
    let injected = false;
    const s = new RunRecordStore({
      dir,
      beforeStealTake: () => {
        if (swapped) return;
        swapped = true;
        // The corpse's bytes change between the judgement read and the take —
        // the take then holds aside a generation that matches NO judgement.
        writeFileSync(lock, takenAside, { mode: 0o600 });
      },
      afterLockTake: () => {
        if (injected || !swapped) return;
        injected = true;
        // A competing writer claims the now-empty path while the take is held:
        // exactly the window put-back races.
        writeFileSync(lock, competitor, { mode: 0o600 });
      },
    });

    const notes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let err: Error | undefined;
    try {
      writeFileSync(lock, corpse, { mode: 0o600 });
      try {
        s.set(id, { vmName: "box-orphan" });
      } catch (e) {
        err = e as Error;
      }
    } finally {
      process.stderr.write = origWrite;
    }
    // Fail-closed: the reclaiming claim is live, so the write waits it out.
    expect(err?.message).toMatch(/timed out waiting for the run record lock/);
    expect(err?.message).toContain("held by a live owner");
    // The taken-aside generation was NOT deleted: it sits under a unique
    // `.orphan.` sibling carrying its original bytes.
    const orphans = readdirSync(dir).filter((f) => f.includes(".orphan.") && f.endsWith(".tmp"));
    expect(orphans).toHaveLength(1);
    const orphan = orphans[0]!;
    expect(readFileSync(join(dir, orphan), "utf8")).toBe(takenAside);
    // …and the path serves the COMPETITOR's claim, not the parked one.
    expect(readFileSync(lock, "utf8")).toBe(competitor);
    // The park is operator-visible: silent stranding was the other failure mode.
    expect(notes.join("")).toContain("parked an unrestorable held-aside lock body at");
    expect(notes.join("")).toContain(orphan);
    rmSync(lock, { force: true });
    rmSync(join(dir, orphan), { force: true });
  }, 15_000);
});
