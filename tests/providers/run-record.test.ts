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
import { liveForeignPid } from "../helpers.ts";
import { setLogSink } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { isRecordLockTimeout, teardownRun } from "../../src/providers/driver.ts";
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

/**
 * T2-11 (round 11): several tests monkeypatch `process.stderr.write` and restore
 * it in a `finally`. A `finally` never runs if THIS file's test is killed by its
 * own timeout mid-call, and the stub then eats bun's reporter output for every
 * later test in the process — order-dependent failures that mislocalize. The
 * original is captured ONCE at patch time (the in-test fixtures already do that)
 * and this guard re-checks after every test, so a leaked stub is repaired even on
 * the kill path. Module-level because the patch leaks across the whole file.
 */
const REAL_STDERR_WRITE = process.stderr.write;
afterEach(() => {
  if (process.stderr.write !== REAL_STDERR_WRITE) {
    console.warn("run-record.test: a stderr monkeypatch survived its test — restored by the file-level guard");
    process.stderr.write = REAL_STDERR_WRITE;
  }
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
    // syscall/errno — this assertion is what makes it fail. The errno now comes
    /// from `link(2)` rather than `open(O_EXCL)`: creation is temp-write-then-
    // link-publish, so the kernel arbitrates ownership at the moment the final
    // path first appears — which also closes the torn-write and stalled-creator
    // windows an in-place O_EXCL write left open (see createUnlogged's
    // docstring). Same guarantee, one primitive later; `link` failing EEXIST on
    // a non-empty destination is exactly what makes overwrite impossible.
    expect(err?.code).toBe("EEXIST");
    expect(err?.syscall).toBe("link");
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

  // ── DF3.4: the "strings" FieldKind ───────────────────────────────────────
  //
  // `supersededReportIds` is the first extension field holding an ARRAY OF
  // TEXT. Every guard in this file was written when the only non-scalar was
  // `ports` — a number array, which cannot be a token — so each one has to be
  // re-proven against text.

  test("a strings field round-trips an ordered array, and the order is preserved", () => {
    // DELIBERATELY not in sorted order, and with a duplicate: the array is a
    // rebind HISTORY ordered oldest-first (df3-4 AC1(a2)), so an
    // implementation that sorted or set-ified it would still satisfy a length
    // check and a sorted fixture. A run CAN legitimately rebind back to a
    // report it displaced earlier, so the duplicate must survive too.
    const ids = ["rv-c", "rv-a", "rv-b", "rv-a"];
    const rec = store.set("run-c", { extensions: { approval: { supersededReportIds: ids } } });
    expect(rec.extensions?.approval?.supersededReportIds).toEqual(["rv-c", "rv-a", "rv-b", "rv-a"]);
    expect(store.get("run-c").extensions?.approval?.supersededReportIds).toEqual(["rv-c", "rv-a", "rv-b", "rv-a"]);
    // The caller's own array is not mutated in place either — sorting it
    // "before" storing would corrupt the value the caller still holds.
    expect(ids).toEqual(["rv-c", "rv-a", "rv-b", "rv-a"]);
    // Empty is the registration default and must not be confused with absent.
    const cleared = store.set("run-c", { extensions: { approval: { supersededReportIds: [] } } });
    expect(cleared.extensions?.approval?.supersededReportIds).toEqual([]);
  });

  test("a strings value is COPIED in, never aliased — the returned record does not share the caller's array", () => {
    // The other direction of the test above, and the one that actually bites.
    // Existing values are structuredCloned into the merge; the INCOMING one
    // used to be stored by reference, so `set()` handed back a record sharing
    // caller-owned mutable state. Every prior extension value was a primitive,
    // so this could not happen until `strings` existed.
    //
    // The failure it causes: DF3.4's rebind builds `[...prior, displaced]` and
    // keeps the local. Any later push to that local silently desynchronizes the
    // in-memory record from the bytes on disk — in an approval audit trail,
    // where "what the record says" is the whole product.
    const ids = ["rv-1"];
    const rec = store.set("run-c", { extensions: { approval: { supersededReportIds: ids } } });
    // IDENTITY, not just equality: deep equality passes on an alias right up
    // until somebody mutates, which is precisely the bug.
    expect(rec.extensions?.approval?.supersededReportIds).not.toBe(ids);
    ids.push("MUTATED-AFTER-WRITE");
    expect(rec.extensions?.approval?.supersededReportIds).toEqual(["rv-1"]);
    expect(store.get("run-c").extensions?.approval?.supersededReportIds).toEqual(["rv-1"]);
    // And the record read back off disk is likewise not shared with the one
    // handed to the caller — two reads must not alias each other either.
    expect(store.get("run-c").extensions?.approval?.supersededReportIds).not.toBe(
      rec.extensions?.approval?.supersededReportIds,
    );
  });

  test("a strings field rejects a non-array and a non-string element, naming the key", () => {
    const before = snapshot("run-c");
    expect(() => store.set("run-c", { extensions: { approval: { supersededReportIds: "rv-a" } } })).toThrow(
      /extensions\.approval\.supersededReportIds must be an array of strings/,
    );
    // `as never`, the same cast the `{ ports: ["80"] }` case above needs: the
    // patch type refuses these at compile time too, and the cast is what lets
    // the RUNTIME rejection still be asserted — dynamic callers (the CLI builds
    // its patch from argv) never went through the type.
    expect(() => store.set("run-c", { extensions: { approval: { supersededReportIds: [1] } } } as never)).toThrow(
      /extensions\.approval\.supersededReportIds must be an array of strings/,
    );
    expect(() =>
      store.set("run-c", { extensions: { approval: { supersededReportIds: ["ok", null] } } } as never),
    ).toThrow(/extensions\.approval\.supersededReportIds must be an array of strings/);
    expect(snapshot("run-c")).toEqual(before);
  });

  test("INV-2 walks INTO a strings array — every element is scanned, at every prefix", () => {
    // THE security regression this whole kind exists behind. `assertNoSecret`
    // opened with `if (typeof value !== "string") return;`, correct while the
    // only array was `ports` (integers are not tokens) and a hole the moment
    // an array of TEXT became writable: the element never reaches the prefix
    // scan or the shape heuristic and lands on disk unread. A `.filter(String)`
    // implementation passes the single-element cases and fails the mixed one.
    for (const prefix of ["sk-", "sk_live_", "ghp_", "ghs_", "github_pat_", "xoxb-", "AKIA", "-----BEGIN"]) {
      expect(() =>
        store.set("run-c", { extensions: { approval: { supersededReportIds: [`${prefix}abcdefghijklmnop`] } } }),
      ).toThrow(/refusing to write key material into the run record: extensions\.approval\.supersededReportIds/);
    }
    // The SHAPE half, not just the prefix half: a 40-char mixed-class blob.
    expect(() =>
      store.set("run-c", {
        extensions: { approval: { supersededReportIds: ["wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"] } },
      }),
    ).toThrow(/key material/);
    // Not only the FIRST element — a scan that stopped at [0] would pass above.
    expect(() =>
      store.set("run-c", { extensions: { approval: { supersededReportIds: ["rv-fine", "ghp_abcdefghijklmnop"] } } }),
    ).toThrow(/key material/);
    // And legal reverify ids still get through, or the guard is just a wall.
    const ok = store.set("run-c", {
      extensions: { approval: { supersededReportIds: ["rv-run-c-2026-08-28t17-00-00-000z-a1b2c3"] } },
    });
    expect(ok.extensions?.approval?.supersededReportIds).toHaveLength(1);
  });

  test("supersededReportIds is NOT shape-exempt — the heuristic keeps running on reverify ids", () => {
    // No approval path is exempt, and this one in particular must stay under
    // the heuristic: it is the field a caller could put arbitrary text into.
    // A reverify id is short and lowercase by construction
    // (src/reverify/runner.ts), so nothing legal is lost by checking it.
    expect(() =>
      store.set("run-c", {
        extensions: { approval: { supersededReportIds: [`Aa1${"b".repeat(37)}C9`] } },
      }),
    ).toThrow(/key material/);
  });

  test("ports still takes integers and still refuses strings — the strings kind did not capture it", () => {
    // `ports` was the IMPLICIT ELSE of assertKind. Adding a kind above it
    // without an explicit branch sends `ports` into the wrong arm, or sends
    // `strings` into the array-of-INTEGERS check. Both directions asserted.
    expect(store.set("run-c", { ports: [8080, 9090] }).ports).toEqual([8080, 9090]);
    expect(() => store.set("run-c", { ports: ["80"] } as never)).toThrow(/ports must be an array of integers/);
    expect(() => store.set("run-c", { ports: [1.5] })).toThrow(/ports must be an array of integers/);
    // An integer array is still waved through assertNoSecret untouched.
    expect(store.set("run-c", { ports: [443] }).ports).toEqual([443]);
  });

  test("a strings field is bounded — the COUNT sheds oldest-first, the element LENGTH is a rejection", () => {
    const before = snapshot("run-c");
    // supersededReportIds grows by one on every AC1(a2) rebind and the record
    // is re-read on every `fleet status` and every list() sweep, so it needs a
    // bound. But the producer only ever APPENDS and no caller can shrink the
    // field, so a THROW at the bound is a brick, not a bound: the 257th rebind
    // fails, and so does every later write for that run — the run is stuck
    // mid-approval with no route forward. The bound sheds instead.
    const shed = store.set("run-c", {
      extensions: { approval: { supersededReportIds: [...Array(256).fill("rv-old"), "rv-new"] } },
    });
    expect(shed.extensions?.approval?.supersededReportIds).toHaveLength(256);
    // The HEAD goes: the history is oldest-first, so the freshest ids — the
    // ones a decision could still be checked against — are what survive.
    expect((shed.extensions?.approval?.supersededReportIds as string[])?.at(-1)).toBe("rv-new");
    // Element LENGTH still throws, and the asymmetry is the point: one bad
    // value is something a caller can fix and resend.
    expect(() =>
      store.set("run-c", { extensions: { approval: { supersededReportIds: ["r".repeat(201)] } } }),
    ).toThrow(/extensions\.approval\.supersededReportIds\[0\] is 201 chars, over the 200 bound/);
    // Both bounds are inclusive on the legal side.
    expect(
      store.set("run-c", { extensions: { approval: { supersededReportIds: Array(256).fill("rv-a") } } }).extensions
        ?.approval?.supersededReportIds,
    ).toHaveLength(256);
    expect(() =>
      store.set("run-c", { extensions: { approval: { supersededReportIds: ["r".repeat(200)] } } }),
    ).not.toThrow();
    expect(snapshot("run-c")).not.toEqual(before); // the shed write LANDED
  });

  test("the approval namespace carries DF3.4's decide-side fields, and no longer the singular", () => {
    const rec = store.set("run-c", {
      extensions: {
        approval: {
          state: "awaiting-approval",
          proposal: "ship it",
          reportId: "rv-1",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          requestId: "req-1",
          expiresAt: "2026-08-29T00:00:00.000Z",
          supersededReportIds: ["rv-0"],
        },
      },
    });
    expect(rec.extensions?.approval).toMatchObject({
      schemaVersion: 2,
      requestId: "req-1",
      expiresAt: "2026-08-29T00:00:00.000Z",
      supersededReportIds: ["rv-0"],
    });
    // The singular is GONE — the array is the single source of truth, and a
    // writer still using the old spelling must fail loudly, not write a second
    // field nothing reads.
    expect(() => store.set("run-c", { extensions: { approval: { supersededReportId: "rv-0" } } })).toThrow(
      /unknown key: extensions\.approval\.supersededReportId/,
    );
  });

  test("a pre-DF3.4 record's singular supersededReportId is FOLDED into the array on the next write", () => {
    // Retiring the scalar from `fields` only stopped new writes. Records paused
    // by the older build still carry it, read mode tolerates it, and the
    // per-namespace merge re-persisted it on every later write — so the record
    // showed `supersededReportId: "rv-a"` beside `supersededReportIds:
    // ["rv-b"]`, which is two disagreeing sources of truth in an approval audit
    // trail. Clearing it by hand was impossible too: `""` is `unknown key`.
    store.create("run-legacy");
    writeFileSync(
      join(dir, "run-legacy.json"),
      JSON.stringify({
        runId: "run-legacy",
        createdAt: new Date().toISOString(),
        extensions: {
          approval: { schemaVersion: 1, state: "awaiting-approval", supersededReportId: "rv-a" },
        },
      }),
      { mode: 0o600 },
    );
    const migrated = store.set("run-legacy", {
      extensions: { approval: { supersededReportIds: ["rv-b"] } },
    }).extensions?.approval;
    // FOLDED, not dropped: the older writer never appended it anywhere, so
    // deleting it alone would lose an id a decision may be checked against.
    // At the HEAD — the scalar predates everything the array writer appended.
    expect(migrated?.supersededReportIds).toEqual(["rv-a", "rv-b"]);
    expect(migrated).not.toHaveProperty("supersededReportId");
    // The bump is the hook a future repair uses to find the records it has not
    // reached yet.
    expect(migrated?.schemaVersion).toBe(2);
    // Idempotent, and never a duplicate: a second write has nothing to fold.
    expect(
      store.set("run-legacy", { extensions: { approval: { state: "approved" } } }).extensions?.approval
        ?.supersededReportIds,
    ).toEqual(["rv-a", "rv-b"]);
  });

  test("an OVER-LENGTH legacy supersededReportId is dropped by the fold, not folded into a brick", () => {
    // The fold crosses kinds. The scalar was a `string` — a kind with NO length
    // check — and it is becoming an element of a `strings`, whose elements are
    // capped at 200. The migration assigns straight to the entry, past the
    // `assertKind` the normal write path runs, so without the guard the
    // over-length value LANDS. The damage is deferred, which is what makes it
    // worth a test: the next rebind appends to this array and DOES go through
    // `assertKind`, that write throws out of `store.set`, and every later write
    // for the run fails identically — no caller can reach in and shorten it.
    store.create("run-legacy-long");
    const overlong = `rv-${"x".repeat(220)}`; // 223 chars, over the 200 bound
    writeFileSync(
      join(dir, "run-legacy-long.json"),
      JSON.stringify({
        runId: "run-legacy-long",
        createdAt: new Date().toISOString(),
        extensions: {
          approval: { schemaVersion: 1, state: "awaiting-approval", supersededReportId: overlong },
        },
      }),
      { mode: 0o600 },
    );
    const migrated = store.set("run-legacy-long", {
      extensions: { approval: { supersededReportIds: ["rv-b"] } },
    }).extensions?.approval;
    // Dropped, and the legacy key is still retired — the record does not keep
    // re-persisting a value no `strings` may hold.
    expect(migrated?.supersededReportIds).toEqual(["rv-b"]);
    expect(migrated).not.toHaveProperty("supersededReportId");
    // THE POINT: the run stays writable. This is the assertion that fails if
    // the guard is removed — the append below is the rebind that bricks.
    expect(
      store.set("run-legacy-long", { extensions: { approval: { supersededReportIds: ["rv-b", "rv-c"] } } })
        .extensions?.approval?.supersededReportIds,
    ).toEqual(["rv-b", "rv-c"]);
  });

  test("a fold at the 256-element bound sheds the oldest HISTORY entry — never the migrated id", () => {
    // `[legacy, ...history]` through shedStrings drops from the HEAD of the
    // combined array — which is where the folded scalar sits. At a full
    // 256-element history the migration shed the very id it exists to
    // preserve. The fold sheds the oldest history entries instead, and the
    // stderr note NAMES what went — "dropping the 1 oldest" without the id is
    // a loss nobody can attribute.
    store.create("run-legacy-full");
    const full = Array.from({ length: 256 }, (_, i) => `rv-${i}`);
    writeFileSync(
      join(dir, "run-legacy-full.json"),
      JSON.stringify({
        runId: "run-legacy-full",
        createdAt: new Date().toISOString(),
        extensions: {
          approval: {
            schemaVersion: 1,
            state: "awaiting-approval",
            supersededReportId: "rv-legacy",
            supersededReportIds: full,
          },
        },
      }),
      { mode: 0o600 },
    );
    const notes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let ids: string[] | undefined;
    try {
      ids = store.set("run-legacy-full", { extensions: { approval: { state: "approved" } } }).extensions?.approval
        ?.supersededReportIds as string[];
    } finally {
      process.stderr.write = origWrite;
    }
    expect(ids).toHaveLength(256);
    // The migrated id SURVIVES at the head; the oldest HISTORY entry is what
    // shed.
    expect(ids?.[0]).toBe("rv-legacy");
    expect(ids).toContain("rv-255");
    expect(ids).not.toContain("rv-0");
    expect(notes.join("")).toContain("dropping the 1 oldest: rv-0");
  });

  test("a scalar RE-CREATED by an older build mid rolling upgrade appends at the tail, not the head", () => {
    // The new build migrated (schemaVersion 2 on disk, scalar gone); an OLD
    // build then re-wrote the retired scalar. Folding it at the head would
    // claim it predates ids it actually postdates — an inverted rebind history
    // in an audit trail whose value is the ordering. The stored schemaVersion
    // proves the migration already ran, so the fold appends instead, loudly:
    // the scalar's true interleave with appends made since the migration is
    // recorded nowhere, and the note says that rather than implying the
    // ordering is known.
    store.create("run-mixed");
    writeFileSync(
      join(dir, "run-mixed.json"),
      JSON.stringify({
        runId: "run-mixed",
        createdAt: new Date().toISOString(),
        extensions: {
          approval: {
            schemaVersion: 2,
            state: "awaiting-approval",
            supersededReportIds: ["rv-a", "rv-b"],
            supersededReportId: "rv-c",
          },
        },
      }),
      { mode: 0o600 },
    );
    const notes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let rec: ReturnType<RunRecordStore["set"]> | undefined;
    try {
      rec = store.set("run-mixed", { extensions: { approval: { state: "approved" } } });
    } finally {
      process.stderr.write = origWrite;
    }
    const migrated = rec?.extensions?.approval;
    expect(migrated?.supersededReportIds).toEqual(["rv-a", "rv-b", "rv-c"]);
    expect(migrated).not.toHaveProperty("supersededReportId");
    expect(notes.join("")).toContain("appending it to the tail");
    expect(notes.join("")).toContain("unrecoverable");
    // Dedupe still wins over position: a re-created scalar that names an id
    // the array already holds folds to nothing, from either version line.
    writeFileSync(
      join(dir, "run-mixed.json"),
      JSON.stringify({
        runId: "run-mixed",
        createdAt: new Date().toISOString(),
        extensions: {
          approval: {
            schemaVersion: 2,
            state: "awaiting-approval",
            supersededReportIds: ["rv-a", "rv-b"],
            supersededReportId: "rv-b",
          },
        },
      }),
      { mode: 0o600 },
    );
    expect(
      store.set("run-mixed", { extensions: { approval: { state: "approved" } } }).extensions?.approval
        ?.supersededReportIds,
    ).toEqual(["rv-a", "rv-b"]);
  });

  test("bundlePath is deliberately NOT a registered approval field", () => {
    // DF2.5 owns this call and made it the other way: "Harvest writes NOTHING
    // to the run record: the bundle's presence at
    // `<runsDir>/<run-id>.bundle` is the record" (harvest.ts:18-19). The path
    // is `join(runsDir, runId + ".bundle")` (harvest.ts:435-436) — a pure
    // function of the run id — so storing it buys a second source of truth and
    // a comparison that can never fail. A rebind re-validates by EXISTENCE.
    //
    // This test exists so re-adding the field is a RED test carrying the
    // reasoning, not a silent "fix" of an omission that looks like a mistake.
    expect(() =>
      store.set("run-c", {
        extensions: { approval: { bundlePath: "/Users/steve/QDS-Factory/.sandbox/runs/run-c.bundle" } },
      }),
    ).toThrow(/unknown key: extensions\.approval\.bundlePath/);
    // And nothing under `approval` is shape-exempt, so were it ever added it
    // would ALSO be host-dependent: this same path throws as suspected key
    // material (uppercase from the repo dir, digits from the run id), while
    // an all-lowercase Linux CI path does not.
    expect(() =>
      store.set("run-c", {
        extensions: { approval: { proposal: "/Users/steve/QDS-Factory/.sandbox/runs/run-c-20260828.bundle" } },
      }),
    ).toThrow(/key material/);
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

  test("TWO skipped files: every reason aligns with its file by index", () => {
    // T2-3 (round 11): with exactly one skipped element, index alignment is
    // unfalsifiable — any scramble of a one-element array against a one-element
    // array is invisible. `list()`'s operator-facing detail is built as
    // `skipped.map((name, i) => … skippedReasons[i])`, so a regression that
    // truncates, reorders or misaligns the reasons array renders the WRONG
    // diagnosis next to each filename — or undefined. Two DISTINCT failure
    // classes make a swap detectable: each reason must name only its own file.
    store.create("run-good");
    writeFileSync(join(dir, "run-empty-one.json"), "", { mode: 0o600 });
    writeFileSync(
      join(dir, "run-bad-key-two.json"),
      JSON.stringify({ runId: "run-bad-key-two", createdAt: new Date().toISOString(), nope: 1 }),
      { mode: 0o600 },
    );

    const listing = store.listWithAnomalies();
    // Same length is the floor; the per-index pairing is the point.
    expect(listing.skipped).toHaveLength(2);
    expect(listing.skippedReasons).toHaveLength(2);
    for (const [i, name] of listing.skipped.entries()) {
      expect(listing.skippedReasons[i]).toBeDefined();
      expect(String(listing.skippedReasons[i])).toContain(name);
    }
    // And the reasons really do differ (empty-body vs unknown-key), so an
    // alignment bug cannot hide behind two identical strings.
    expect(listing.skippedReasons[0]).not.toBe(listing.skippedReasons[1]);
    // list()'s aggregate refusal renders reasons by the same index mapping.
    let err: Error | undefined;
    try {
      store.list();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("run-empty-one.json");
    expect(err?.message).toContain("run-bad-key-two.json");
  });

  test.each([
    ["an unknown key", "run-odd", JSON.stringify({ runId: "run-odd", createdAt: "x", nope: 1 }), /nope/],
    [
      "an unparseable createdAt",
      "run-bad-ts",
      JSON.stringify({ runId: "run-bad-ts", createdAt: "not-a-timestamp" }),
      /createdAt/,
    ],
    [
      // A TRUNCATED body: valid JSON up to the cut, then nothing — the torn
      // write a crash mid-`writeFileSync` leaves. JSON.parse throws a
      // SyntaxError on it, which is the same quarantine routing as any other
      // unparseable body: skipped with its reason, never fleet-wide.
      "a truncated JSON body",
      "run-trunc",
      `{"runId":"run-trunc","createdAt":"${new Date().toISOString()}","keyHash":"sha256:abc`,
      /[Jj][Ss][Oo][Nn]|Expected|Unexpected|EOF/i,
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

  // Root reads a mode-0000 file, so the fault below cannot be injected there —
  // but a silent `return` reported PASS with zero assertions, indistinguishable
  // from verification (T2-10). Visible skip, like the lock tests' `skipIf`.
  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)("an unreadable record is ONE skipped entry too, carrying its errno", () => {
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

  test("the mtime grace boundary is the documented 5s, straddled tightly from both sides", () => {
    // The suite's other arms sit at ~0s (fresh) and 50s (WELL_PAST_GRACE_MS),
    // which passes for any window between them. These two sit ±200ms either
    // side of CREATE_TOMBSTONE_GRACE_MS (5s, module-private in run-record.ts,
    // so named here rather than imported): an in-grace file is still held and
    // one just past it clears. `olderThan` compares `Date.now() - mtimeMs >=
    // ms`, so the exact-equality instant again drifts past while the call
    // runs — what this pins is the window's WIDTH, not its open/closed end.
    const id = "run-tomb-boundary";
    const p = join(dir, `${id}.json`);

    const inside = new Date(Date.now() - 4_800);
    writeFileSync(p, "", { mode: 0o600 });
    utimesSync(p, inside, inside);
    let err: NodeJS.ErrnoException | undefined;
    try {
      store.create(id);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err?.code).toBe("EEXIST"); // still inside the grace ⇒ a live writer
    rmSync(p, { force: true });

    const outside = new Date(Date.now() - 5_200);
    writeFileSync(p, "", { mode: 0o600 });
    utimesSync(p, outside, outside);
    store.create(id); // just past it ⇒ a corpse; create must succeed
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  test("only ONE retry: a real record at the path is never overwritten", () => {
    // The retry exists for the tombstone and nothing else. A second EEXIST
    // means a real record (or another writer's fresh create) is there, and
    // INV-3's no-overwrite is absolute for those.
    const id = "run-real";
    const first = store.create(id);
    const before = snapshot(id);
    // The errno is the contract, not just "it threw": the retry loop and every
    // caller classify on EEXIST. A different failure here (EACCES, ENOSPC)
    // would also throw but means something no retry may survive.
    let err: NodeJS.ErrnoException | undefined;
    try {
      store.create(id);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err?.code).toBe("EEXIST");
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

  test("a THROWING log sink cannot break the listing sweep", () => {
    // listUnlogged emits an anomaly line per skipped file; a raising custom
    // sink turned that emission into a thrown error out of the sweep — the
    // same committed-outcome masking cost-ledger's emit guards against. The
    // listing plus its skips must come back regardless; the stderr note names
    // the operation, never the payload.
    store.create("run-sink-ok");
    writeFileSync(join(dir, "Bad Name.json"), JSON.stringify({ runId: "x", createdAt: "y" }), { mode: 0o600 });
    let threw = false; // flipped by the sink itself, so a silent skip cannot pass
    const restore = setLogSink(() => {
      threw = true;
      throw new Error("sink exploded");
    });
    const notes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let listing: ReturnType<RunRecordStore["listWithAnomalies"]>;
    try {
      listing = store.listWithAnomalies();
    } finally {
      restore();
      process.stderr.write = origWrite;
    }
    expect(threw).toBe(true); // the sink really ran and really raised
    expect(listing.records.map((r) => r.runId)).toEqual(["run-sink-ok"]);
    expect(listing.skipped).toEqual(["Bad Name.json"]);
    expect(listing.skippedReasons[0]).toContain("not a valid run id");
    expect(notes.join("")).toContain("log sink threw for run-record.list.anomaly");
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
    // Upper bound too: the wait must END near the window, not run past it. The
    // loop is bounded by LOCK_TIMEOUT_MS by construction; this catches a
    // regression that waits MULTIPLE windows before giving up. LOCK_TIMEOUT_MS
    // is a module constant with no per-store override, so "shorten via config"
    // is not available — the bound below is derived from it.
    expect(Date.now() - started).toBeLessThan(2 * LOCK_TIMEOUT_MS);
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
    // A pid that is genuinely alive and genuinely not ours — owned by the suite
    // via the shared helper, not guessed: `process.ppid` goes STALE the moment
    // the runner's parent exits mid-suite, which turns this contention fixture
    // into the steal case wearing its clothes.
    const foreign = liveForeignPid();
    const foreignBody = `${foreign.pid} deadbeefcafe\n`;
    let fired = false;
    const s = new RunRecordStore({
      dir,
      beforeRename: () => {
        fired = true;
        rmSync(lock, { force: true });
        writeFileSync(lock, foreignBody, { mode: 0o600 });
      },
    });
    try {
      s.create(id);
      expect(s.set(id, { vmName: "box-4" }).vmName).toBe("box-4");
      // The seam really ran. Without this a refactor that moves the rename out of
      // `beforeRename`'s reach stops opening the window at all, and the assertion
      // below degrades into an ENOENT instead of naming what broke.
      expect(fired).toBe(true);
      expect(readFileSync(lock, "utf8")).toBe(foreignBody);
    } finally {
      foreign.stop();
      rmSync(lock, { force: true });
    }
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
    // A pid that is alive by construction (the shared helper), so every steal
    // attempt AFTER the swap must judge this lock held and wait it out — the
    // same no-guess rule as the release-side twin above.
    const foreign = liveForeignPid();
    const live = `${foreign.pid} deadbeefcafe\n`;
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
    try {
      s.create(id);
      writeFileSync(lock, `${DEAD_PID}\n`, { mode: 0o600 }); // the corpse

      // Fail-closed: the live lock is never stolen, so the write times out.
      expect(() => s.set(id, { vmName: "box-5" })).toThrow(/timed out waiting for the run record lock/);
      expect(swapped).toBe(true); // the window really opened
      expect(readFileSync(lock, "utf8")).toBe(live); // the new writer's lock survived
      expect(s.get(id).vmName).toBeUndefined(); // and its record was not overwritten
    } finally {
      foreign.stop();
      rmSync(lock, { force: true });
    }
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

  test("an rm failure while releasing cannot mask an ALREADY-COMMITTED record write", () => {
    // releaseLock runs in withLock's finally, AFTER setUnlogged has replaced
    // the record. A bare `rmSync(claimed, { force: true })` suppresses only
    // ENOENT: an EACCES/EIO/EPERM escaped that finally, replaced the caller's
    // success with an error, and a retry recomputed from its PRE-COMMIT read —
    // a doubled spend delta on the money path. The cleanup must be as quiet as
    // claimLock's ("nothing this cleanup does may escape").
    const id = "release-rm-eacces-run";
    store.create(id);
    const realRm = nodeFs.rmSync;
    let injected = false;
    let matching = 0;
    const spy = spyOn(nodeFs, "rmSync").mockImplementation(((p: unknown, opts: unknown) => {
      if (typeof p === "string" && p.startsWith(`${store.lockPath(id)}.`)) {
        // Claim-path rms only: claimLock's temp first, the release's held-aside
        // claim second. The fault must land on the SECOND — the release side,
        // which runs after the write has committed.
        matching++;
        if (matching === 2 && !injected) {
          injected = true;
          spy.mockRestore(); // restore FIRST — the assertions below need real fs
          const e = new Error(`EACCES: permission denied, unlink '${p}'`) as NodeJS.ErrnoException;
          e.code = "EACCES";
          throw e;
        }
      }
      return realRm(p as string, opts as Parameters<typeof nodeFs.rmSync>[1]);
    }) as typeof nodeFs.rmSync);
    try {
      expect(store.set(id, { vmName: "box-rm9" }).vmName).toBe("box-rm9"); // outcome returned
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true); // the fault really fired on the release cleanup
    expect(store.get(id).vmName).toBe("box-rm9"); // …and the write stands behind it
  });

  // R2 (round 11): `releaseLock`'s FIRST read used to treat EVERY errno as
  // "already gone" and return silently — leaving a lock on disk naming THIS
  // process's live pid, which later judges score "held by a live owner":
  // unstealable, unwritable and unclosable for the rest of the process lifetime.
  // Now only ENOENT is gone; any other errno falls through to take-then-compare,
  // whose rename retry then fails → the loud stderr note + registration KEPT so
  // a retry actually retries. This pins the loud-note arm via a rename EACCES on
  // exactly that fall-through path.
  test("a non-ENOENT failure while releasing is LOUD: stderr note, not a silent no-op", () => {
    const id = "release-eio-loud-run";
    store.create(id);
    const lockPathStr = store.lockPath(id);
    const realRename = nodeFs.renameSync;
    const notes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    // Declared BEFORE the spy: the mock callback closes over it, and a first
    // invocation ahead of the declaration would be a TDZ throw instead of a
    // counted fault.
    let attempts = 0;
    const spy = spyOn(nodeFs, "renameSync").mockImplementation(((from: unknown, to: unknown) => {
      if (from === lockPathStr && attempts < 2) {
        // Only THIS lock's take-aside — every other rename passes untouched.
        // BOTH release attempts must fail (releaseLock retries once before it
        // reports), and the counter is what keeps every later lifecycle clean.
        attempts += 1;
        if (attempts === 2) spy.mockRestore(); // nothing after the report needs the fault
        const e = new Error(`EIO: i/o error, rename '${String(from)}'`) as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
      return realRename(from as string, to as string);
    }) as typeof nodeFs.renameSync);
    try {
      expect(store.set(id, { vmName: "box-loud" }).vmName).toBe("box-loud"); // committed regardless
    } catch (e) {
      // withLock may surface a loud failure from an unrecoverable release rather
      // than swallow it — either way the commit semantics are pinned below.
      expect((e as Error).message).toMatch(/EIO|lock/);
    } finally {
      // T2-11's file-level guard is the backstop; land the local one too so a
      // note assertion reads a clean buffer regardless of where set() threw.
      process.stderr.write = origWrite;
    }
    expect(attempts).toBe(2); // the retry really ran before the report
    // The wedge must be VISIBLE, not silent: the operator is told THIS process
    // still holds the lock and later writes will time out until it is released.
    expect(notes.join("")).toContain("could not release");
    expect(notes.join("")).toContain("THIS process still holds it");
  });

  test("an rm failure while retiring a PROVEN corpse does not abort the claim", () => {
    // stealIfOwnerGone's take-then-compare proved the taken bytes are the corpse
    // it judged; removing them is pure hygiene. A throwing rm there used to
    // escape out of the claim attempt itself and abort a write whose only fault
    // was a failing unlink of bytes already proven disposable.
    const id = "steal-rm-eacces-run";
    store.create(id);
    const lock = store.lockPath(id);
    writeFileSync(lock, `${DEAD_PID} bbbb2222\n`, { mode: 0o600 }); // the corpse
    const realRm = nodeFs.rmSync;
    let injected = false;
    let matching = 0;
    const spy = spyOn(nodeFs, "rmSync").mockImplementation(((p: unknown, opts: unknown) => {
      if (typeof p === "string" && p.startsWith(`${lock}.`)) {
        // First match is claimLock's failed-attempt temp; second is the steal's
        // proven-corpse claim.
        matching++;
        if (matching === 2 && !injected) {
          injected = true;
          spy.mockRestore();
          const e = new Error(`EACCES: permission denied, unlink '${p}'`) as NodeJS.ErrnoException;
          e.code = "EACCES";
          throw e;
        }
      }
      return realRm(p as string, opts as Parameters<typeof nodeFs.rmSync>[1]);
    }) as typeof nodeFs.rmSync);
    try {
      expect(store.set(id, { vmName: "box-rm10" }).vmName).toBe("box-rm10");
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true); // the fault really fired on the steal cleanup
    // The corpse did not wedge the id: the mutation landed through the steal.
    expect(store.get(id).vmName).toBe("box-rm10");
  });
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
    // …and it ends near the window, not past it (same upper bound as the
    // unreadable-body case above).
    expect(Date.now() - started).toBeLessThan(2 * LOCK_TIMEOUT_MS);
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

  // R7 (round 11): an OWNERLESS body — empty, whitespace, or a non-numeric pid
  // field, the artifact of an O_EXCL-era crash caught mid-write — names no pid,
  // so `isAlive` has nothing to probe and NO sweep matches `.lock`. The young
  // arm below pins the fail-closed side: an unprovable body inside the grace
  // holds the full window, never stolen.
  //
  // R7's residual CLOSED (round-11 re-review): the aged ownerless corpse now
  // falls through to the same take-then-compare reclamation a dead-pid corpse
  // gets, instead of reporting "free" while the file still sat at the path —
  // which spun every retry's claim into EEXIST and the wait into its own
  // timeout, the very wedge the age bound was added to close.
  test("an OWNERLESS lock body: YOUNG one fails closed; an AGED one is reclaimed fast", () => {
    store.create("ownerless-run");
    const lock = store.lockPath("ownerless-run");

    // Young ownerless body ⇒ HELD: fails closed like any unprovable read, for
    // the FULL window — not some shorter guess that invites the lost update.
    writeFileSync(lock, "", { mode: 0o600 });
    const startedYoung = Date.now();
    expect(() => store.set("ownerless-run", { vmName: "box-young" })).toThrow(
      /timed out waiting for the run record lock/,
    );
    expect(Date.now() - startedYoung).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS);
    rmSync(lock, { force: true });

    // Aged ownerless corpse (non-numeric pid field — same "names no pid" shape):
    // acquired well inside the wait budget, with the stale lock file REMOVED —
    // the steal consumed it rather than abandoning it for the operator.
    store.create("ownerless-aged-run");
    const lock2 = store.lockPath("ownerless-aged-run");
    writeFileSync(lock2, "junk cafebabe\n", { mode: 0o600 });
    utimesSync(lock2, new Date(Date.now() - WELL_PAST_LOCK_GRACE_MS), new Date(Date.now() - WELL_PAST_LOCK_GRACE_MS));
    const startedAged = Date.now();
    expect(store.set("ownerless-aged-run", { vmName: "box-aged" }).vmName).toBe("box-aged");
    expect(Date.now() - startedAged).toBeLessThan(LOCK_TIMEOUT_MS / 2);
    expect(existsSync(lock2)).toBe(false);
    rmSync(lock2, { force: true });
  }, 30_000);

  // R4 (round 11): mtime is stamped from the wall clock, so an NTP step FORWARD
  // makes a live sibling's fresh temp read as older-than-the-grace and gets it
  // swept by cleanStaleTemps — the lost mutation the pid+age scheme exists to
  // prevent. Only a MATERIAL future offset counts: sub-ms jitter between the
  // write's clock domains is noise every fresh temp carries.
  test("cleanStaleTemps NEVER sweeps a FUTURE-dated temp — clock steps do not reap in-flight writes", () => {
    store.create("run-future-sweep");
    const livePidTemp = join(dir, `run-future-sweep.json.${process.pid}.cafe1111.tmp`);
    writeFileSync(livePidTemp, "{}", { mode: 0o600 });
    // Two minutes into the future: far past OWN_TEMP_GRACE_MS, far past any
    // jitter, inside what an NTP step actually does.
    const future = new Date(Date.now() + 120_000);
    utimesSync(livePidTemp, future, future);

    new RunRecordStore({ dir }); // construction runs the sweep

    expect(existsSync(livePidTemp)).toBe(true);
    // Control: the SAME shape dated normally is swept once our own grace passes…
    const agedTemp = join(dir, `run-future-sweep.json.${process.pid}.dead2222.tmp`);
    writeFileSync(agedTemp, "{}", { mode: 0o600 });
    const past = new Date(Date.now() - 130_000); // > OWN_TEMP_GRACE_MS (60s)
    utimesSync(agedTemp, past, past);
    new RunRecordStore({ dir });
    expect(existsSync(agedTemp)).toBe(false);
    rmSync(livePidTemp, { force: true });
  });

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
    // Both live bodies use the shared helper's pid: alive by construction, so
    // the reclaiming claim is genuinely held and the fail-closed timeout below
    // is the contention case, not an accidental stale-pid steal.
    const foreign = liveForeignPid();
    const takenAside = `${foreign.pid} cafebabe\n`; // ...and what it actually TAKES
    const competitor = `${foreign.pid} deadbabe\n`; // ...and what reclaims the path
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
    // `.orphan.` sibling carrying its original bytes — with NO `.tmp` suffix,
    // so `cleanStaleTemps` can never destroy evidence an operator was told to
    // restore by hand.
    const orphans = readdirSync(dir).filter((f) => f.includes(".orphan."));
    expect(orphans).toHaveLength(1);
    const orphan = orphans[0]!;
    expect(orphan.endsWith(".tmp")).toBe(false);
    expect(readFileSync(join(dir, orphan), "utf8")).toBe(takenAside);
    // …and the path serves the COMPETITOR's claim, not the parked one.
    expect(readFileSync(lock, "utf8")).toBe(competitor);
    // The park is operator-visible: silent stranding was the other failure mode.
    expect(notes.join("")).toContain("parked an unrestorable held-aside lock body at");
    expect(notes.join("")).toContain(orphan);
    // The park must SURVIVE the next sweep. Aged past the own-pid grace, a
    // `.tmp`-named body would be destroyed by the very next store construction
    // — while `lock.not-restored` is still telling an operator to restore it.
    const aged = new Date(Date.now() - WELL_PAST_LOCK_GRACE_MS); // 2× OWN_LOCK_GRACE_MS
    utimesSync(join(dir, orphan), aged, aged);
    new RunRecordStore({ dir }); // construction runs cleanStaleTemps
    expect(existsSync(join(dir, orphan))).toBe(true);
    foreign.stop();
    rmSync(lock, { force: true });
    rmSync(join(dir, orphan), { force: true });
  }, 15_000);
});

test("FB9 two-sided pin: driver.ts's lock-timeout predicate matches ONLY what this module throws", () => {
  // The predicate (driver.ts isRecordLockTimeout) keys on the MESSAGE TEXT of
  // the lock timeout thrown below, and routes on it: a match refuses loudly, a
  // non-match takes the DESTRUCTIVE rollback arm (rmSync of the record). That
  // makes the string load-bearing in both directions, so BOTH halves are
  // pinned here: if either side rewords, this test fails instead of a
  // concurrent-writer budget-write failure being silently destroyed.
  //
  // Side B — the REAL throw path. An unreadable lock body is held, never
  // stolen, so `set` waits out LOCK_TIMEOUT_MS and throws the exact message
  // shape the predicate matches on.
  const id = "lock-timeout-pin-run";
  store.create(id);
  const lock = store.lockPath(id);
  writeFileSync(lock, "", { mode: 0o600 });
  let thrown: unknown;
  try {
    store.set(id, { vmName: "pin-box" });
  } catch (e) {
    thrown = e;
  } finally {
    rmSync(lock, { force: true });
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message.startsWith("timed out waiting for the run record lock:")).toBe(true);
  // Side A — the predicate accepts exactly that message…
  expect(isRecordLockTimeout(thrown)).toBe(true);
  // …and rejects the rewordings and near-misses that would silently flip the
  // routing (a reworded THROW SITE stops matching ⇒ destructive arm; a reworded
  // PREDICATE would match refusals it was never meant to).
  expect(isRecordLockTimeout(new Error("timed out waiting for the record lock: /x (contended)"))).toBe(false);
  expect(isRecordLockTimeout(new Error("run record lock timed out: /x (contended)"))).toBe(false);
  expect(isRecordLockTimeout(new Error("lock acquisition failed"))).toBe(false);
  // Non-Error values never match, message text notwithstanding (instanceof gate).
  expect(isRecordLockTimeout({ message: "timed out waiting for the run record lock: /x (held)" })).toBe(false);
}, 15_000);

describe("INV-2 — the FALSE-POSITIVE controls: an ordinary proposal must still write", () => {
  // Every accepting `proposal` fixture in this file is `"ship it"` — two words,
  // short enough that no heuristic could reject it, and therefore no evidence
  // that the heuristic is safe on the values this field actually carries. The
  // failure mode is not a leak: `requestApproval` writes the proposal at the
  // `pausing` registration, so a write-time rejection ABORTS the pause and
  // leaves the run unreachable at the gate.
  beforeEach(() => {
    store.create("run-p");
  });

  test("a long, realistic PROSE proposal writes — spaces are what save it, and they must keep saving it", () => {
    const proposal =
      "Open a PR against main: the DF3.4 reverify run is green, 14 tests passed and 0 failed, " +
      "and the harvested bundle is still present. Recommend merge once a second approver signs off.";
    expect(proposal.length).toBeGreaterThan(40);
    // Mixed class AND over the length bound: the ONLY thing standing between
    // this and a rejection is the charset anchor, which spaces fall outside of.
    expect(/[a-z]/.test(proposal) && /[A-Z]/.test(proposal) && /\d/.test(proposal)).toBeTrue();
    expect(store.set("run-p", { extensions: { approval: { proposal } } }).extensions?.approval?.proposal).toBe(proposal);
  });

  test("a multi-line proposal with punctuation and a path writes", () => {
    const proposal = [
      "Summary: DF3.4 W4 — the tier-1 approval gate.",
      "Changed: src/fleet/approval-gate.ts, src/fleet/approvers.ts.",
      "Risk: MEDIUM. The pause is recoverable; a crashed teardown resumes.",
    ].join("\n");
    expect(store.set("run-p", { extensions: { approval: { proposal } } }).extensions?.approval?.proposal).toBe(proposal);
  });

  test("a single-token ALL-LOWERCASE proposal over the length bound writes — mixed class is load-bearing", () => {
    // No spaces, so the charset anchor does NOT save this one: dropping the
    // `mixedClass` requirement rejects it, and it is exactly the shape a
    // reverify id or a run slug takes.
    const proposal = "rv-run-c-2026-08-28t17-00-00-000z-a1b2c3-second-attempt";
    expect(proposal.length).toBeGreaterThan(40);
    expect(store.set("run-p", { extensions: { approval: { proposal } } }).extensions?.approval?.proposal).toBe(proposal);
  });

  test("a decision REASON reads like prose too, and writes", () => {
    const reason = "Approved: the failing e2e was a flake, re-run at 2026-08-28T17:04:00Z came back green.";
    expect(store.set("run-p", { extensions: { approval: { reason } } }).extensions?.approval?.reason).toBe(reason);
  });

  test("...and a genuinely key-shaped proposal is still REFUSED", () => {
    // The other half of the control. Without this pair a heuristic loosened
    // until nothing false-positives is indistinguishable from one deleted.
    const keyish = "gA9kTzQ2mVx7RpL0dYbN4hJ6sW8cE3fU1iO5aZqX";
    expect(keyish.length).toBe(40);
    expect(() => store.set("run-p", { extensions: { approval: { proposal: keyish } } })).toThrow(
      /refusing to write key material into the run record: extensions\.approval\.proposal/,
    );
    expect(() => store.set("run-p", { extensions: { approval: { reason: `sk-live-${keyish}` } } })).toThrow(
      /key material/,
    );
  });

  test("the 40-char length bound is a boundary, not a vibe: 39 writes, 40 refuses", () => {
    const at39 = `Aa1${"b".repeat(34)}C9`; // 39 chars, mixed class, in charset
    expect(at39.length).toBe(39);
    expect(store.set("run-p", { extensions: { approval: { proposal: at39 } } }).extensions?.approval?.proposal).toBe(
      at39,
    );
    expect(() => store.set("run-p", { extensions: { approval: { proposal: `${at39}d` } } })).toThrow(/key material/);
  });
});
