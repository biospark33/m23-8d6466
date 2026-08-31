/**
 * DF3.4 W3-B: the approver allowlist and decision authentication (AC2/AC4).
 *
 * Every arm of INV-APPROVE-3 gets its OWN refusal test — absent, unreadable,
 * unparseable, schema-invalid, mode 0644, mode 0640, and an EMPTY allowlist.
 * A mode check with only a happy path never fails, and an allowlist that
 * degrades to "allow all" passes every positive test ever written for it.
 *
 * The stdin half is tested against REAL file descriptors — a character device,
 * a regular file, a fifo, a closed fd — and the socket arm against a real
 * child process, because a socket fd 0 is what a Bun parent spawning with
 * `stdio: "pipe"` actually produces and no fake reproduces that.
 *
 * The fixture `fixtures/approvers.json` is read with readFileSync + JSON.parse,
 * never `import`: bun's module cache would share one mutable object across
 * every suite that touches it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTokenAttached,
  authenticateApprover,
  constantTimeEqual,
  DEFAULT_APPROVERS_FILE,
  enrolApprover,
  MAX_TOKEN_BYTES,
  readCappedToken,
  SCRYPT_ALLOC_CEILING_BYTES,
  SCRYPT_PARAMS,
  TOKEN_STDIN_TIMEOUT_MS,
} from "../../src/fleet/approvers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "approvers.json");
/** The fixture's documented sentinel token. Obviously fake, by construction. */
const FIXTURE_TOKEN = "fake-approver-token-alice";
const FIXTURE_ID = "alice@example.test";

/** The ONE entry shape the allowlist accepts. */
type Entry = { v: 2; salt: string; hash: string; N: number; r: number; p: number };

/**
 * `tests/pr/helpers.ts:105-125`'s `writeAllowlist`, cloned for this file's
 * shape. `entries === null` returns the PATH without creating the file — that
 * is the absent-allowlist arm. `writeFileSync`'s `mode` option is masked by
 * umask, so the chmod is a separate call: it is the only form that lands the
 * mode tightly.
 */
function writeAllowlist(root: string, entries: Record<string, Entry> | null, mode = 0o600): string {
  const dir = join(root, ".factory");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "approvers.json");
  if (entries === null) return path;
  writeFileSync(path, JSON.stringify({ version: 1, approvers: entries }));
  chmodSync(path, mode);
  return path;
}

/** Land arbitrary bytes at the allowlist path, 0600, directory already 0700. */
function writeRaw(root: string, text: string, name = "approvers.json"): string {
  writeAllowlist(root, null);
  const path = join(root, ".factory", name);
  writeFileSync(path, text);
  chmodSync(path, 0o600);
  return path;
}

/**
 * An entry for `token`, hashed by an oracle independent of the source:
 * `scryptSync` is called here directly with the parameters the entry declares,
 * never through `scryptToken`. A helper that called the production function
 * would agree with it even if both were wrong about the KDF.
 *
 * The parameters are DELIBERATELY not `SCRYPT_PARAMS`. N = 2^12 is the schema
 * floor and runs in about a millisecond, so the suite does not pay the
 * production cost per authentication for a property that is about the FORMULA,
 * not the cost — and using a NON-DEFAULT N is itself the assertion that
 * verification reads each entry's own parameters instead of today's constants.
 */
const TEST_SCRYPT = { N: 1 << 12, r: 8, p: 1 } as const;
function entryFor(salt: string, token: string): Entry {
  return {
    v: 2,
    salt,
    hash: scryptSync(token, salt, 32, { ...TEST_SCRYPT, maxmem: 256 * TEST_SCRYPT.N * TEST_SCRYPT.r }).toString("hex"),
    ...TEST_SCRYPT,
  };
}

/** File-local: there is no shared refusal helper, and one file does not need one. */
function refusalOf(result: ReturnType<typeof authenticateApprover>): { code: string; message: string; remediation: string } {
  if (result.ok) throw new Error(`expected a refusal, got approverId ${result.approverId}`);
  return result.refusal;
}

/**
 * One `streamOf` for BOTH bounded-read suites, hoisted out of the describes it
 * used to be duplicated into: two private copies of a fixture builder drift —
 * one gaining an encoding or close-order fix the other never sees — while the
 * suites they serve read as one behavior under test.
 */
const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });

/**
 * `isAlive`'s mirror, at this file's only use of it: signal 0 tests existence,
 * and ESRCH — not any other errno — is the one proof of death. Same discipline
 * as `approvers.ts`' own `isLockHolderDead`, so a lock the source would reclaim
 * is exactly the lock this test judges reclaimable.
 */
function isDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qds-approvers-allowlist-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("approvers.ts — allowlist reading (INV-APPROVE-3 fail-closed)", () => {
  test("an ABSENT allowlist refuses every decision and names the path it looked for", () => {
    const path = writeAllowlist(root, null);
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-allowlist-unreadable");
    expect(refusal.message).toContain(path);
  });

  test("an UNREADABLE allowlist refuses rather than falling through to an empty one", () => {
    // A DIRECTORY at the allowlist's path: statSync succeeds and a 0700 dir
    // passes the mode check, so the refusal can only come from the READ. Chosen
    // over `chmod 000` because that arm silently succeeds when the suite runs
    // as root, which is exactly when a fail-closed test must still fail closed.
    mkdirSync(join(root, ".factory", "approvers.json"), { recursive: true, mode: 0o700 });
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-allowlist-unreadable");
  });

  test("an UNPARSEABLE allowlist refuses and never authorizes anybody", () => {
    const path = writeAllowlist(root, {});
    writeFileSync(path, "{not json");
    chmodSync(path, 0o600);
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-allowlist-invalid");
  });

  test("a SCHEMA-INVALID allowlist (right JSON, wrong shape) refuses", () => {
    const path = writeAllowlist(root, {});
    writeFileSync(path, JSON.stringify({ version: 1, approvers: { alice: { salt: "s" } } }));
    chmodSync(path, 0o600);
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-allowlist-invalid");
  });

  test("mode 0644 refuses, naming the offending mode, without reading a byte", () => {
    // The FIFO case below is the one that OBSERVES non-reading (a read on a
    // writer-less fifo blocks forever); this case cannot, because a read-first
    // implementation produces the identical refusal about valid content. So the
    // ordering claim is made falsifiable directly: the guard must reach its
    // verdict without a single `readFileSync` of the file.
    writeAllowlist(root, { alice: entryFor("s", "tok") }, 0o644);
    let blockedReads = 0;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      // Tripwire AND assertion: `blockedReads` proves the spy ENGAGED — without
      // it, a namespace patch the production module never resolves through (a
      // direct ESM binding, a local alias) would leave this test green while it
      // silently degenerates into its 0640 twin, unguarding the ordering claim
      // that is the reason this case exists.
      blockedReads += 1;
      throw new Error(`readFileSync must not run before the mode guard: ${JSON.stringify(args[0])}`);
    }) as typeof fs.readFileSync);
    let refusal: { code: string; message: string; remediation: string };
    try {
      refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    } finally {
      readSpy.mockRestore();
    }
    expect(refusal.code).toBe("approver-allowlist-mode");
    expect(refusal.message).toContain("644");
    // The guard must also have LOOKED — and never have reached the content
    // read. A spy that fired zero times proves nothing about ordering; the
    // mode stat itself is `statSync` and is deliberately not intercepted.
    expect(blockedReads).toBe(0);
  });

  test("a group- or world-WRITABLE .factory/ refuses, even with a perfect 0600 file", () => {
    // The file-mode check alone is not the control it claims to be. Its own
    // rationale is "an allowlist another account can EXTEND" — and the cheapest
    // way to extend one you cannot write is to replace it wholesale through a
    // writable parent: `mv evil.json .factory/approvers.json` passes the 0600
    // check and the schema, and enrolls the attacker's own {salt, hash}.
    for (const dirMode of [0o777, 0o770, 0o707, 0o720]) {
      writeAllowlist(root, { alice: entryFor("s", "tok") });
      chmodSync(join(root, ".factory"), dirMode);
      const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
      expect(refusal.code).toBe("approver-allowlist-dir-mode");
      // The message must name the DIRECTORY. Naming the file sends the
      // operator to chmod something that is already correct.
      expect(refusal.message).toContain(".factory");
      expect(refusal.message).not.toContain("approvers.json");
      expect(refusal.message).toContain(dirMode.toString(8));
    }
  });

  test("a SYMLINKED allowlist is judged by its TARGET — linking to wide-open bytes refuses", () => {
    // A symlink is the mv-replace attack through one more primitive, and the
    // suite's dir-mode rationale already names replacement as the threat: the
    // guard stats THROUGH the link (`statSync`, not `lstatSync`), so the target's
    // own mode is what fires. Here the target is 0644 attacker-writable JSON —
    // the exact shape `ln -s` puts at the allowlist path when the attacker owns
    // a sibling directory and the allowlist does not exist yet.
    const target = join(root, "wide-open.json");
    writeFileSync(target, JSON.stringify({ version: 1, approvers: { alice: entryFor("s", "tok") } }));
    chmodSync(target, 0o644);
    const dir = join(root, ".factory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    symlinkSync(target, join(dir, "approvers.json"));
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-mode");
    expect(refusal.message).toContain("644");
  });

  test("a SYMLINKED .factory/ is judged by its TARGET's mode — a 0777 behind the name refuses", () => {
    // The same primitive one level up: the directory NAME is 0777-clean (a
    // symlink's own mode is irrelevant), the directory it RESOLVES to is world
    // writable. A guard that lstat'ed the link would pass it; the walk's
    // statSync must see through to the target and refuse.
    const loose = join(root, "loose");
    mkdirSync(loose, { recursive: true, mode: 0o777 });
    chmodSync(loose, 0o777);
    writeAllowlist(loose, { alice: entryFor("s", "tok") });
    symlinkSync(loose, join(root, ".factory"));
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-dir-mode");
    expect(refusal.message).toContain("777");
  });

  test("a writable ancestor ABOVE .factory/ refuses too — a chain is as good as its loosest link", () => {
    // The one-level check was never the control it claimed to be: `mv .factory
    // /tmp/x && mkdir -m 700 .factory && install -m 600 evil.json
    // .factory/approvers.json` needs only a writable grandparent and yields a
    // perfectly 0600 file inside a perfectly 0700 directory. Both the old
    // checks pass, and the planted allowlist authorizes PRs.
    const mid = join(root, "mid");
    mkdirSync(mid, { recursive: true, mode: 0o700 });
    writeAllowlist(mid, { alice: entryFor("s", "tok") });
    const file = join("mid", ".factory", "approvers.json");
    expect(authenticateApprover(root, "alice", "tok", file).ok).toBeTrue();
    for (const midMode of [0o777, 0o770, 0o707, 0o722]) {
      chmodSync(mid, midMode);
      const refusal = refusalOf(authenticateApprover(root, "alice", "tok", file));
      expect(refusal.code).toBe("approver-allowlist-dir-mode");
      // It must name the OFFENDING component — sending the operator to chmod a
      // directory that is already 0700 fixes nothing. Naming the allowlist file
      // UNDER it is allowed (a remediation that names both is more helpful, not
      // less): what is forbidden is naming .factory itself as the thing to fix.
      expect(refusal.message).toContain(mid);
      expect(refusal.message).toContain(midMode.toString(8));
    }
  });

  test("the walk STOPS at hostRoot — a world-writable /tmp above it is not the caller's problem", () => {
    // tmpdir() sits under a 1777 /tmp on most hosts. Walking past hostRoot
    // would refuse every correct temp-rooted invocation, including this repo's
    // own live harness.
    writeAllowlist(root, { alice: entryFor("s", "tok") });
    expect(authenticateApprover(root, "alice", "tok").ok).toBeTrue();
  });

  test("an allowlist path OUTSIDE hostRoot is refused — the caller does not pick its own authority", () => {
    // `resolve(hostRoot, file)` discards hostRoot on an absolute path and
    // honours `../` on a relative one, so without containment the caller
    // supplies the allowlist it is then authenticated against. Both mode
    // checks would pass, truthfully, about a file the attacker owns.
    const outside = mkdtempSync(join(tmpdir(), "qds-approvers-outside-"));
    // The `../` probe must not land on a shared fixed namespace: the refused
    // arm is decided by what the guard can prove about the TARGET, so a file
    // another run or suite left at a stable path changes what this proves.
    // It walks `..` into the SIBLING tmpdir minted above (mkdtemp names are
    // unique per run), so the probe stays about `../` and nothing else — and
    // it names the REAL allowlist file, because a probe at a path that does
    // not exist would fail on `unreadable` and never reach the containment
    // verdict this test exists for. (`basename(root)` here would be wrong:
    // `<parent>/<basename(root)>` IS root.)
    try {
      writeAllowlist(outside, { alice: entryFor("s", "tok") });
      for (const file of [
        join(outside, ".factory", "approvers.json"),
        join("..", basename(outside), ".factory", "approvers.json"),
      ]) {
        const refusal = refusalOf(authenticateApprover(root, "alice", "tok", file));
        expect(refusal.code).toBe("approver-allowlist-path");
        expect(refusal.message).toContain(root);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a FIFO at the allowlist path is REFUSED, never read — a fifo stats as 0600 and blocks forever", () => {
    // Every other malformed-allowlist case refuses; this one parked the
    // process, because statSync reports a fifo's mode as readily as a file's
    // and readFileSync on a writer-less fifo never returns.
    const path = writeAllowlist(root, null);
    const made = Bun.spawnSync(["mkfifo", "-m", "600", path]);
    expect(made.exitCode).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-unreadable");
    expect(refusal.message).toContain("not a regular file");
  });

  test("an allowlist enrolling an EMPTY id is schema-invalid — it would authenticate nobody-in-particular", () => {
    const path = writeAllowlist(root, {});
    writeFileSync(path, JSON.stringify({ version: 1, approvers: { "": entryFor("s", "tok") } }));
    chmodSync(path, 0o600);
    expect(refusalOf(authenticateApprover(root, "", "tok")).code).toBe("approver-id-empty");
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("a READABLE-but-not-writable .factory/ is allowed — 0750 is a legitimate posture", () => {
    // WRITE is the operative bit, not read. Requiring 0700 exactly would refuse
    // ordinary group-readable deployments, and a check that refuses correct
    // setups is one an operator disables — which is strictly worse than one
    // that draws the line at the bit the attack actually needs.
    //
    // 0500 is the other half of the rule the comment states: a directory whose
    // write bits are absent (read-only mount). A whitelist of the four modes
    // below agrees with the mask on every tested mode and diverges EXACTLY
    // here, so the mask is what is pinned — by a mode the whitelist refuses.
    for (const dirMode of [0o700, 0o750, 0o705, 0o755, 0o500]) {
      writeAllowlist(root, { alice: entryFor("s", "tok") });
      chmodSync(join(root, ".factory"), dirMode);
      try {
        const res = authenticateApprover(root, "alice", "tok");
        expect(res.ok).toBeTrue();
      } finally {
        // 0500 has no write bit: afterEach's rmSync of the case tmpdir cannot
        // unlink through it, and the failure would report as ENOTEMPTY teardown
        // noise instead of the assertion. Restore before the loop continues.
        chmodSync(join(root, ".factory"), 0o700);
      }
    }
  });

  test("mode 0640 refuses too — group-readable is still readable by somebody else", () => {
    writeAllowlist(root, { alice: entryFor("s", "tok") }, 0o640);
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-mode");
    expect(refusal.message).toContain("640");
  });

  test("mode 0400 is ACCEPTED — the guard is a mask over the group/world bits, not an exact 0600", () => {
    // The trio 0600/0640/0644 cannot separate "must be exactly 0600" from "no
    // group/world access": the two rules agree on all three and disagree only on
    // a file STRICTER than 0600. The rule is the mask (`& 0o077`), so an
    // operator who locked the file down further is not refused for it.
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") }, 0o400);
    expect(authenticateApprover(root, "alice", "s3kr1t")).toEqual({ ok: true, approverId: "alice" });
  });

  test("an EMPTY allowlist authorizes NOBODY — it never degrades to allow-all", () => {
    writeAllowlist(root, {});
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-unknown");
  });

  test("the FIXTURE WRITER lands 0600-in-0700 — the precondition every case in this describe builds on", () => {
    // This asserts THIS FILE's `writeAllowlist` helper, not production: every
    // allowlist-backed case below inherits its modes from here, so a fixture
    // writer that drifts to 0644 would silently convert every mode-refusal
    // case into a pass-through-the-guard case. The production write-mode
    // guarantee (0600 at birth via openSync "wx") is pinned where the writer
    // actually lives — the `enrolApprover` suite's "0600 from birth" test.
    const path = writeAllowlist(root, { alice: entryFor("s", "tok") });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  test("DEFAULT_APPROVERS_FILE is the story's host-config path", () => {
    expect(DEFAULT_APPROVERS_FILE).toBe(".factory/approvers.json");
  });
});

describe("approvers.ts — authentication (AC2/AC4, INV-APPROVE-2)", () => {
  test("an allowlisted approver presenting the matching token authenticates", () => {
    writeAllowlist(root, { "alice@example.test": entryFor("pepper", "s3kr1t") });
    const result = authenticateApprover(root, "alice@example.test", "s3kr1t");
    expect(result).toEqual({ ok: true, approverId: "alice@example.test" });
  });

  test("an UNKNOWN approverId is refused even when the allowlist is otherwise valid", () => {
    writeAllowlist(root, { "alice@example.test": entryFor("pepper", "s3kr1t") });
    const refusal = refusalOf(authenticateApprover(root, "mallory@example.test", "s3kr1t"));
    expect(refusal.code).toBe("approver-unknown");
  });

  test("a WRONG token for a known approver is refused", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    const refusal = refusalOf(authenticateApprover(root, "alice", "not-the-token"));
    expect(refusal.code).toBe("approver-token-mismatch");
  });

  test("a token matching ANOTHER approver's entry does not authenticate this one", () => {
    writeAllowlist(root, { alice: entryFor("sa", "alice-tok"), bob: entryFor("sb", "bob-tok") });
    const refusal = refusalOf(authenticateApprover(root, "alice", "bob-tok"));
    expect(refusal.code).toBe("approver-token-mismatch");
  });

  test("the salt binds the hash — the same token under another salt is refused", () => {
    // A well-formed entry whose salt does not match the hash it carries: the
    // shape is valid, so this reaches the KDF and is refused as a MISMATCH
    // rather than as a schema fault. That distinction is the test.
    writeAllowlist(root, { alice: { ...entryFor("salt-b", "tok"), salt: "salt-a" } });
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-token-mismatch");
  });

  test("a REMOVED entry takes effect immediately — the allowlist is re-read per decision", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    expect(authenticateApprover(root, "alice", "s3kr1t").ok).toBe(true);
    writeAllowlist(root, {});
    expect(refusalOf(authenticateApprover(root, "alice", "s3kr1t")).code).toBe("approver-unknown");
  });

  test("a ROTATED token takes effect immediately — the old token stops working", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "old-token") });
    expect(authenticateApprover(root, "alice", "old-token").ok).toBe(true);
    writeAllowlist(root, { alice: entryFor("pepper", "new-token") });
    expect(refusalOf(authenticateApprover(root, "alice", "old-token")).code).toBe("approver-token-mismatch");
    expect(authenticateApprover(root, "alice", "new-token").ok).toBe(true);
  });

  test("an EMPTY or whitespace-only approverId names nobody and never authenticates", () => {
    // `Object.hasOwn(approvers, "")` succeeds on an allowlist that carries the
    // key, and the decision is then written with `approverId: ""` — which
    // DF5.2 refuses forever as `approval-incomplete`. The refusal is its own
    // code: "register the approver" is not the remediation for naming none.
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    for (const id of ["", " ", "\t\n"]) {
      const refusal = refusalOf(authenticateApprover(root, id, "s3kr1t"));
      expect(refusal.code).toBe("approver-id-empty");
    }
  });

  test("a presented id is TRIMMED, and the trimmed spelling is what the decision is attributed to", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    expect(authenticateApprover(root, "  alice\n", "s3kr1t")).toEqual({ ok: true, approverId: "alice" });
  });

  test("ids are CASE-SENSITIVE, but a case-only miss says so instead of reading as unknown", () => {
    // Folding would silently merge two deliberately-distinct enrolled ids into
    // one authority. Naming the near-match keeps the refusal diagnosable
    // without making the decision case-insensitive.
    writeAllowlist(root, { Alice: entryFor("pepper", "s3kr1t") });
    const near = refusalOf(authenticateApprover(root, "alice", "s3kr1t"));
    expect(near.code).toBe("approver-unknown");
    expect(near.message).toContain("Alice");
    expect(near.message).toContain("case-sensitive");
    const unknown = refusalOf(authenticateApprover(root, "mallory", "s3kr1t"));
    expect(unknown.code).toBe("approver-unknown");
    expect(unknown.message).not.toContain("case-sensitive");
  });

  test("a prototype key is not an approver — `__proto__` and `constructor` are refused", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    for (const id of ["__proto__", "constructor", "toString"]) {
      expect(refusalOf(authenticateApprover(root, id, "s3kr1t")).code).toBe("approver-unknown");
    }
  });

  test("a literal `__proto__` KEY planted in the FILE is dropped by the record parse — the entry is unreachable", () => {
    // The dangerous shape is the one the twin test above cannot reach: a
    // PRESENTED id of `__proto__` looks up a key the allowlist does not carry,
    // but `JSON.parse` of a file that literally contains
    // `{"approvers":{"__proto__":{…}}}` DOES create a real own property on the
    // parsed record — and a lookup that resolves it (or a writer that
    // spread-merges and re-serializes it) would let file bytes mint an
    // authority and survive every enrolment's read-modify-write. The zod
    // record parse DROPS the key (plain assignment runs the inherited setter),
    // so the entry is unreachable: alice still authenticates from the same
    // file, and the planted id reads as unknown.
    //
    // The payload is assembled as TEXT, never as an object literal: a
    // literal's `__proto__:` shorthand SETS the prototype of the fixture
    // object rather than defining the key, and any downstream
    // `JSON.stringify` then drops the entry — an earlier draft of this test
    // wrote a file with no planted key at all and stayed green. The on-disk
    // readback below proves the key really reached the file, so the refusals
    // above cannot be vacuous.
    const survivors = JSON.stringify({ alice: entryFor("pepper", "s3kr1t") });
    // `survivors.slice(1)` strips the document brace; its trailing `}}` closes
    // alice's entry and the approvers object, and ONE appended `}` closes the
    // document.
    writeRaw(
      root,
      `{"version":1,"approvers":{"__proto__":${JSON.stringify(entryFor("evil", "attacker-token"))},${survivors.slice(1)}}`,
    );
    expect(authenticateApprover(root, "alice", "s3kr1t")).toEqual({ ok: true, approverId: "alice" });
    const refusal = refusalOf(authenticateApprover(root, "__proto__", "attacker-token"));
    expect(refusal.code).toBe("approver-unknown");
    // The file really carries the planted key as an OWN property of the
    // parsed record (`JSON.parse` uses CreateDataProperty, which bypasses the
    // inherited setter; a plain `.accessor` reads the prototype and can never
    // see it). Proving the key is on disk is what keeps the two refusals
    // above honest — the parse dropped a key that was really there.
    const onDisk = JSON.parse(readFileSync(join(root, ".factory", "approvers.json"), "utf8")) as {
      approvers: Record<string, unknown>;
    };
    expect(Object.hasOwn(onDisk.approvers, "__proto__")).toBeTrue();
    expect(onDisk.approvers.__proto__).toEqual(entryFor("evil", "attacker-token"));
    expect(Object.hasOwn(onDisk.approvers, "alice")).toBeTrue();
    // And an enrolment against that same file does not merge the planted key
    // back into what it writes — the rewritten file carries exactly the
    // survivors, read as OWN enumerable keys (the accessor form would again
    // miss an own `__proto__`).
    const res = enrolApprover(root, "bob");
    if (!res.ok) throw new Error(`enrolment should succeed: ${res.refusal.code}`);
    const rewritten = JSON.parse(readFileSync(join(root, ".factory", "approvers.json"), "utf8")) as {
      approvers: Record<string, unknown>;
    };
    expect(Object.hasOwn(rewritten.approvers, "__proto__")).toBeFalse();
    expect(Object.keys(rewritten.approvers).sort()).toEqual(["alice", "bob"]);
  });

  test("no refusal carries the presented token in its message or remediation", () => {
    const token = "tttttoken-that-must-not-appear";
    writeAllowlist(root, { alice: entryFor("pepper", "the-real-one") });
    for (const id of ["alice", "mallory"]) {
      const refusal = refusalOf(authenticateApprover(root, id, token));
      expect(refusal.message).not.toContain(token);
      expect(refusal.remediation).not.toContain(token);
    }
  });

  test("every refusal carries a non-empty code, message and remediation", () => {
    writeAllowlist(root, null);
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code.length).toBeGreaterThan(0);
    expect(refusal.message.length).toBeGreaterThan(0);
    expect(refusal.remediation.length).toBeGreaterThan(0);
  });

  test("the checked-in fixture authenticates its documented sentinel token", () => {
    // readFileSync + JSON.parse, never `import`: the module cache would share
    // one mutable object across every suite that touches this fixture.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { approvers: Record<string, Entry> };
    writeAllowlist(root, fixture.approvers);
    expect(authenticateApprover(root, FIXTURE_ID, FIXTURE_TOKEN)).toEqual({ ok: true, approverId: FIXTURE_ID });
    expect(refusalOf(authenticateApprover(root, FIXTURE_ID, "wrong")).code).toBe("approver-token-mismatch");
    // EVERY entry the fixture ships, not just the one the suites drive: bob's
    // hash can rot away from its salt (a regenerated formula, an edited field)
    // and every suite stays green while the fixture carries a credential that
    // verifies against nothing. `fixtures/approvers.json` documents
    // `fake-approver-token-<local-part>` as the sentinel per id.
    const OTHER_ID = "bob@example.test";
    expect(fixture.approvers[OTHER_ID]).toBeDefined();
    expect(authenticateApprover(root, OTHER_ID, "fake-approver-token-bob")).toEqual({
      ok: true,
      approverId: OTHER_ID,
    });
  });
});

describe("approvers.ts — constant-time comparison", () => {
  // ONE suite, not two: this file used to carry the same five comparisons in
  // two describes, and the file's own header refuses fixture-copy drift — one
  // copy gaining a case the other never sees is the same rot. The
  // full-strength assertions (the 100 KiB near-miss that only a digested
  // compare can survive) live in the D9 suite below, which documents WHY the
  // throw is the observable proxy for the timing property; this describe keeps
  // only the boolean table the read path actually branches on.
  test("the comparison table the hash check branches on", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("approvers.ts — token attachment on fd 0 (INV-CRED-3)", () => {
  let fds: number[];

  beforeEach(() => {
    fds = [];
  });

  afterEach(() => {
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        // already closed by the test that was proving EBADF
      }
    }
  });

  test("a CHARACTER DEVICE (/dev/null, a tty) means no token was attached", () => {
    const fd = openSync("/dev/null", "r");
    fds.push(fd);
    expect(assertTokenAttached(fd)?.code).toBe("approver-token-absent");
  });

  test("a CLOSED fd (EBADF) means no token was attached", () => {
    const fd = openSync("/dev/null", "r");
    closeSync(fd);
    expect(assertTokenAttached(fd)?.code).toBe("approver-token-absent");
  });

  test("a REGULAR FILE is a deliberate attachment and is accepted", () => {
    const path = join(root, "token");
    writeFileSync(path, "s3kr1t");
    chmodSync(path, 0o600);
    const fd = openSync(path, "r");
    fds.push(fd);
    expect(assertTokenAttached(fd)).toBeNull();
  });

  test("a FIFO is a deliberate attachment and is accepted", () => {
    const path = join(root, "token.fifo");
    const made = Bun.spawnSync(["mkfifo", path]);
    expect(made.exitCode).toBe(0);
    // O_NONBLOCK: opening a fifo for read otherwise BLOCKS until a writer
    // appears, and this test deliberately never attaches one.
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    fds.push(fd);
    expect(assertTokenAttached(fd)).toBeNull();
  });

  test("the refusal never suggests passing the token as a flag", () => {
    const fd = openSync("/dev/null", "r");
    fds.push(fd);
    const refusal = assertTokenAttached(fd);
    expect(refusal?.remediation).toContain("stdin");
    expect(refusal?.remediation).not.toContain("--token");
  });
});

describe("approvers.ts — bounded token read", () => {
  test("a token arrives whole, with its trailing newline trimmed", async () => {
    const read = await readCappedToken(streamOf("s3", "kr1t\n"));
    expect(read).toEqual({ ok: true, token: "s3kr1t" });
  });

  test("an EMPTY stdin is refused — it is not an empty token", async () => {
    const read = await readCappedToken(streamOf("", "\n"));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("approver-token-absent");
  });

  test("a token over the cap is refused AS IT STREAMS, never buffered whole", async () => {
    const read = await readCappedToken(streamOf("a".repeat(MAX_TOKEN_BYTES + 1)));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("approver-token-too-large");
  });

  test("a token exactly at the cap is accepted", async () => {
    const read = await readCappedToken(streamOf("a".repeat(MAX_TOKEN_BYTES)));
    expect(read.ok).toBe(true);
  });

  test("a writer that never closes the pipe is refused, not waited on forever", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const read = await readCappedToken(stalled, 25);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("approver-token-stdin-timeout");
  });

  test("a stream that ERRORS mid-read is a typed refusal, never a thrown Error", async () => {
    // A rejected `reader.read()` (fd 0 on EIO, a pipe whose read end died) is
    // a durable fault — it fails the same way every retry — so an untyped
    // throw would reach the CLI's report() as transient/exit-1 "retry me".
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("simulated I/O fault"));
      },
    });
    const read = await readCappedToken(failing, 1_000);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal.code).toBe("approver-token-stdin-error");
      expect(read.refusal.message).toContain("simulated I/O fault");
      expect(read.refusal.remediation).toContain("< token");
    }
  });

  test("a DRIP FEEDER is refused on the overall deadline, not reset by every byte", async () => {
    // The regression: the stall window was recreated per read and cleared on
    // every successful one, so `while :; do printf x; sleep 9; done` never
    // tripped a 10 s idle check — against the 4 KiB cap that is ~10 h of
    // parking, from a writer the docstring claimed was refused.
    let sent = 0;
    const drip = new ReadableStream<Uint8Array>({
      async pull(controller) {
        sent += 1;
        // Each gap is well inside the idle window; the TOTAL is not.
        await Bun.sleep(15);
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const started = Date.now();
    const read = await readCappedToken(drip, 60);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("approver-token-stdin-timeout");
    // The DISCRIMINATING bound: a deadline that resets per byte keeps reading
    // until the CAP, so `sent` at refusal says which budget actually ran out.
    // The line between them has a full order of magnitude of headroom: a
    // correct reader — including one that checks the deadline AFTER a read
    // resolves, or is served one pull ahead of it — admits single digits of
    // pulls in a 60 ms window at 15 ms a pull, while the reset bug needs four
    // THOUSAND of them to reach the cap. Asserting `sent <= 64` (16x the
    // honest count, 64x under the buggy count) discriminates without placing
    // the razor at the exact integer a scheduling hiccup can move by one.
    expect(sent).toBeLessThanOrEqual(64);
    // Never asserted as a hard ceiling: a stalled CI runner can stretch this
    // without the code being wrong. It only has to be orders of magnitude
    // under the ~10 h the reset bug would have parked the verb for.
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  test("the constants are sized for a token, not for a brief", () => {
    expect(MAX_TOKEN_BYTES).toBe(4096);
    expect(TOKEN_STDIN_TIMEOUT_MS).toBe(10_000);
  });
});

describe("approvers.ts — a SOCKET fd 0 and the never-logged rule", () => {
  /**
   * A socket on fd 0 is what a Bun/Node parent spawning with `stdio: "pipe"`
   * produces (scripts/fleet.ts:852-865 established this), and nothing in-process
   * reproduces it — so this arm runs a real child. That is also the shape the
   * live harness and a DF3.5-generated skill use, so this test IS the mandatory
   * approval demo's transport.
   *
   * The child reports only the token's LENGTH, never its bytes: the module is
   * what must not leak it, and a harness that prints it itself would prove
   * nothing. Both streams are then searched for the token.
   */
  test("a socket fd 0 is a deliberate attachment: the token is read end-to-end", async () => {
    const module = join(HERE, "..", "..", "src", "fleet", "approvers.ts");
    const token = "tttttoken-that-must-not-appear";
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(module)});
         const direct = m.assertTokenAttached(0);
         const composed = await m.readTokenFromStdin();
         process.stdout.write(JSON.stringify({
           direct: direct?.code ?? null,
           ok: composed.ok,
           len: composed.ok ? composed.token.length : 0,
           code: composed.ok ? null : composed.refusal.code,
         }));`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(token);
    await child.stdin.end();
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exitCode = await child.exited;
    // The exit code was discarded and `err` never surfaced, so ANY breakage in
    // the child reported here as "Unexpected end of JSON input" — a failure
    // naming neither the cause nor the file it came from.
    if (exitCode !== 0) throw new Error(`child exited ${exitCode}\nstdout: ${out}\nstderr: ${err}`);

    const printed = JSON.parse(out) as { direct: string | null; ok: boolean; len: number; code: string | null };
    expect(printed.direct).toBeNull();
    expect(printed).toMatchObject({ ok: true, len: token.length, code: null });
    expect(out).not.toContain(token);
    expect(err).not.toContain(token);
  });
});

describe("approvers.ts — the allowlist SCHEMA is the enrollment gate", () => {
  test("a version-2 file is refused — an unrecognized schema is not a schema to trust", () => {
    writeRaw(root, JSON.stringify({ version: 2, approvers: { alice: entryFor("s", "tok") } }));
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("an EXTRA top-level key is refused — the file object is .strict()", () => {
    // Not pedantry: an unknown key is either a typo that silently does nothing
    // (`approver`, `approvals`) or a second authority nobody reads.
    writeRaw(root, JSON.stringify({ version: 1, approvers: { alice: entryFor("s", "tok") }, admins: { mallory: {} } }));
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("an EXTRA key on an ENTRY is refused — the entry object is .strict() too", () => {
    // The shape an operator reaches for when they want an exception: a key
    // beside {salt, hash} that this module would never read, quietly enrolling
    // an approver under terms nothing enforces.
    writeRaw(
      root,
      JSON.stringify({ version: 1, approvers: { alice: { ...entryFor("s", "tok"), expiresAt: "2020-01-01" } } }),
    );
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test.each([
    ["a truncated hash", createHash("sha256").update("s:tok", "utf8").digest("hex").slice(0, 32)],
    ["an UPPERCASE hash", createHash("sha256").update("s:tok", "utf8").digest("hex").toUpperCase()],
    ["a base64-shaped hash", createHash("sha256").update("s:tok", "utf8").digest("base64")],
    ["an empty hash", ""],
  ])("%s is a SCHEMA refusal, never a token mismatch", (_name, hash) => {
    // The distinction is the whole point of pinning the regex. Relaxed to
    // `z.string()`, every one of these becomes `approver-token-mismatch` — so
    // the operator is told their TOKEN is wrong and rotates a perfectly good
    // one, while the real fault sits in the file they were not sent to.
    //
    // Built from a COMPLETE entry with only `hash` overridden, never a bare
    // `{salt, hash}`: the schema is v2-only, so every missing field would
    // refuse on its own and the regex under test would never even run — a
    // build that dropped `/^[0-9a-f]{64}$/` passed all four cases.
    writeRaw(
      root,
      JSON.stringify({ version: 1, approvers: { alice: { ...entryFor("s", "tok"), hash } } }),
    );
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("an EMPTY salt is refused — the separator is only load-bearing with something to separate", () => {
    writeRaw(
      root,
      JSON.stringify({ version: 1, approvers: { alice: { ...entryFor("s", "tok"), salt: "" } } }),
    );
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("a BOM-prefixed allowlist still authenticates — an editor's mark is not corruption", () => {
    // A UTF-8 BOM is what a Windows editor or a PowerShell redirect leaves on a
    // config file, and without the strip it is a JSON.parse failure that reads
    // to the operator as a corrupt allowlist.
    const BOM = "﻿";
    // The byte is the load-bearing half of this test and it is invisible: if an
    // editor or a formatter ever strips it, the case degrades to "a plain
    // allowlist authenticates" and the strip's regression goes unguarded. Assert
    // the prefix is really there before asserting the parse survives it.
    expect(new TextEncoder().encode(BOM).byteLength).toBe(3);
    writeRaw(root, `${BOM}${JSON.stringify({ version: 1, approvers: { alice: entryFor("pepper", "s3kr1t") } })}`);
    expect(readFileSync(join(root, ".factory", "approvers.json"), "utf8").startsWith(BOM)).toBeTrue();
    expect(authenticateApprover(root, "alice", "s3kr1t")).toEqual({ ok: true, approverId: "alice" });
  });

  test("a host BEFORE first enrollment has no .factory/ at all and gets a refusal, not a stack trace", () => {
    // Every other absent-allowlist test creates the DIRECTORY and omits only
    // the file. A fresh host has neither — and the directory walk stats
    // `.factory` before anything stats the file, so this lands on a different
    // arm with a different remediation. Without the try/catch there, `fleet
    // approve` dies with an uncaught ENOENT on every host that has never
    // enrolled anybody.
    expect(existsSync(join(root, ".factory"))).toBeFalse();
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-dir-mode");
    expect(refusal.message).toContain(join(root, ".factory"));
    // The remediation must be "create it", not "chmod it" — there is nothing
    // there to chmod.
    expect(refusal.remediation).toContain("create");
    expect(refusal.remediation).toContain("0700");
  });

  test("the `file` parameter chooses the allowlist that is actually read", () => {
    // Ignoring it and hardcoding DEFAULT_APPROVERS_FILE is a silent
    // wrong-allowlist authorization: a caller aiming at a per-tenant or staging
    // allowlist is authenticated against the default one, and every guard
    // passes truthfully about a file the caller never named.
    writeAllowlist(root, { alice: entryFor("s-default", "default-token") });
    writeRaw(
      root,
      JSON.stringify({ version: 1, approvers: { alice: entryFor("s-alt", "alt-token") } }),
      "approvers.alt.json",
    );
    const alt = join(".factory", "approvers.alt.json");

    expect(authenticateApprover(root, "alice", "alt-token", alt)).toEqual({ ok: true, approverId: "alice" });
    expect(refusalOf(authenticateApprover(root, "alice", "default-token", alt)).code).toBe("approver-token-mismatch");
    // ...and the default is still the default when nothing is passed.
    expect(authenticateApprover(root, "alice", "default-token").ok).toBeTrue();
  });
});

describe("approvers.ts — readCappedToken bounds the STREAM, not the chunk", () => {
  test("MANY under-cap chunks that SUM over the cap are refused — the bound is cumulative", async () => {
    // The one-chunk cap tests pass for a per-chunk check too (`if
    // (res.value.byteLength > MAX_TOKEN_BYTES)`), and a per-chunk check buffers
    // an unbounded number of 4 KiB chunks — which is the exact DoS the cap's
    // own title claims it prevents.
    const half = "a".repeat(MAX_TOKEN_BYTES / 2);
    const read = await readCappedToken(streamOf(half, half, "a"));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("approver-token-too-large");
  });

  test("many chunks summing to EXACTLY the cap are accepted — the boundary is not off by one", async () => {
    const quarter = "a".repeat(MAX_TOKEN_BYTES / 4);
    const read = await readCappedToken(streamOf(quarter, quarter, quarter, quarter));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.token.length).toBe(MAX_TOKEN_BYTES);
  });

  test("a MULTI-BYTE chunk is measured in BYTES, not characters", async () => {
    // `byteLength`, not `.length`: 2 048 two-byte characters is exactly the
    // cap, and one more character is over it.
    const twoByte = "é".repeat(MAX_TOKEN_BYTES / 2);
    expect(new TextEncoder().encode(twoByte).byteLength).toBe(MAX_TOKEN_BYTES);
    expect((await readCappedToken(streamOf(twoByte))).ok).toBe(true);
    expect((await readCappedToken(streamOf(twoByte, "é"))).ok).toBe(false);
  });

  test.each([
    ["a CRLF file", "s3kr1t\r\n"],
    ["a heredoc with leading whitespace", "  s3kr1t\n"],
    ["a trailing blank line", "s3kr1t\n\n"],
  ])("%s yields the bare token — trimming is not newline-stripping", async (_name, raw) => {
    // Narrowed to `.replace(/\n$/,"")`, a token out of a CRLF file keeps its
    // `\r`, every hash misses, and the operator is told their correct token is
    // wrong.
    const read = await readCappedToken(streamOf(raw));
    expect(read).toEqual({ ok: true, token: "s3kr1t" });
  });

  test("the reader is CANCELLED on the too-large refusal — no fd left held open", async () => {
    // Documented on `readCappedToken` and asserted nowhere: without the
    // `finally { await reader.cancel() }` an abandoned read keeps fd 0 open
    // behind the refusal, with a pending read on it.
    let cancelled = 0;
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(MAX_TOKEN_BYTES + 1)));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const read = await readCappedToken(flood);
    expect(read.ok).toBe(false);
    expect(cancelled).toBe(1);
  });

  test("the reader is CANCELLED on the stall refusal too", async () => {
    let cancelled = 0;
    const stalled = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled += 1;
      },
    });
    const read = await readCappedToken(stalled, 25);
    expect(read.ok).toBe(false);
    expect(cancelled).toBe(1);
  });
});

describe("approvers.ts — authenticateFromStdin is the composition production calls", () => {
  /**
   * `authenticateFromStdin` reads the REAL fd 0, so the only honest test of it
   * is a child whose fd 0 this process attaches — the same transport the live
   * harness and a DF3.5-generated skill use. Every other test in this file
   * calls `authenticateApprover` directly with a token string, which leaves the
   * one place the argument wiring lives (`authenticateApprover(hostRoot,
   * approverId, read.token, file)` — four positional args, three of them
   * strings) unexercised: swap the middle two and every decision refuses
   * `approver-unknown` in production with both suites green.
   */
  const MODULE = join(HERE, "..", "..", "src", "fleet", "approvers.ts");

  type AuthResult = { ok: boolean; approverId?: string; code?: string };

  const script = (approverId: string, file?: string): string[] => [
    process.execPath,
    "-e",
    `const m = await import(${JSON.stringify(MODULE)});
     const res = await m.authenticateFromStdin(${JSON.stringify(root)}, ${JSON.stringify(approverId)}, ${
       file === undefined ? "undefined" : JSON.stringify(file)
     });
     process.stdout.write(JSON.stringify(
       res.ok ? { ok: true, approverId: res.approverId } : { ok: false, code: res.refusal.code },
     ));`,
  ];

  async function collect(child: { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> }) {
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exitCode = await child.exited;
    // Surface the real cause: without this a broken child reports as
    // "Unexpected end of JSON input" and the failure names nothing.
    if (exitCode !== 0) throw new Error(`child exited ${exitCode}\nstdout: ${out}\nstderr: ${err}`);
    return JSON.parse(out) as AuthResult;
  }

  async function authViaStdin(opts: { approverId: string; token?: string; file?: string }): Promise<AuthResult> {
    const cmd = script(opts.approverId, opts.file);
    if (opts.token === undefined) {
      // "ignore" is /dev/null — a character device, i.e. NOTHING attached.
      return collect(Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
    }
    const child = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(opts.token);
    await child.stdin.end();
    return collect(child);
  }

  test("the token off stdin authenticates the approver named on the command line", async () => {
    writeAllowlist(root, { "alice@example.test": entryFor("pepper", "s3kr1t") });
    // Swapping the approverId and token arguments makes this `approver-unknown`.
    expect(await authViaStdin({ approverId: "alice@example.test", token: "s3kr1t" })).toEqual({
      ok: true,
      approverId: "alice@example.test",
    });
  });

  test("the token really reaches the hash — a wrong one is a MISMATCH, not an unknown approver", async () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    expect(await authViaStdin({ approverId: "alice", token: "not-the-token" })).toEqual({
      ok: false,
      code: "approver-token-mismatch",
    });
  });

  test("a caller with NO token attached is REFUSED, never authenticated against the empty string", async () => {
    // The fall-through regression: `if (!read.ok) return …` replaced by a
    // continue would call `authenticateApprover(…, "")`. This allowlist enrolls
    // alice with the EMPTY token precisely so that mistake AUTHENTICATES here
    // instead of failing on the hash — the refusal below is the only thing
    // standing between an unattended caller and an authorized decision.
    writeAllowlist(root, { alice: entryFor("pepper", "") });
    expect(authenticateApprover(root, "alice", "").ok).toBeTrue(); // the trap is armed
    expect(await authViaStdin({ approverId: "alice" })).toEqual({ ok: false, code: "approver-token-absent" });
  });

  test("an attached-but-EMPTY stdin is refused — an empty stdin is a missing token", async () => {
    writeAllowlist(root, { alice: entryFor("pepper", "") });
    expect(await authViaStdin({ approverId: "alice", token: "\n" })).toEqual({
      ok: false,
      code: "approver-token-absent",
    });
  });

  test("the `file` argument reaches the allowlist read — the 4th positional is wired", async () => {
    writeAllowlist(root, { alice: entryFor("s-default", "default-token") });
    writeRaw(
      root,
      JSON.stringify({ version: 1, approvers: { alice: entryFor("s-alt", "alt-token") } }),
      "approvers.alt.json",
    );
    const alt = join(".factory", "approvers.alt.json");
    expect(await authViaStdin({ approverId: "alice", token: "alt-token", file: alt })).toEqual({
      ok: true,
      approverId: "alice",
    });
    expect(await authViaStdin({ approverId: "alice", token: "default-token", file: alt })).toEqual({
      ok: false,
      code: "approver-token-mismatch",
    });
  });

  test("an empty --approver is refused before the token is even considered", async () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    expect(await authViaStdin({ approverId: "   ", token: "s3kr1t" })).toEqual({
      ok: false,
      code: "approver-id-empty",
    });
  });
});

/**
 * DF3.4 deferred item D9 — the work factor, and the minting that makes the
 * entropy assumption TRUE rather than documented.
 *
 * D9's stated remedy was "require a minimum entropy at enrolment". It could not
 * be implemented as written, for two reasons found by reading the code rather
 * than the ticket: there was no enrolment path at all (nothing in `src/` or
 * `scripts/` ever wrote this file), and a minimum LENGTH on an operator-supplied
 * token is not the property anyway — `correct horse battery staple` passes any
 * length rule a human would write and is still guessable. Entropy cannot be
 * measured from a string, only guaranteed by generating one.
 */
describe("approvers.ts — versioned entries and the scrypt work factor (D9)", () => {
  test("a v2 entry authenticates and does NOT report itself legacy", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    expect(authenticateApprover(root, "alice", "s3kr1t")).toEqual({ ok: true, approverId: "alice" });
    expect(refusalOf(authenticateApprover(root, "alice", "wrong")).code).toBe("approver-token-mismatch");
  });

  test("verification uses the ENTRY's OWN parameters, not today's defaults", () => {
    // The property that makes a future cost increase survivable: raising
    // SCRYPT_PARAMS must not invalidate everything enrolled at the old cost.
    // `entryFor` writes N = 2^12 while production mints at 2^15, so this
    // passing at all is the assertion — a verifier hard-coding SCRYPT_PARAMS
    // computes a different hash and reads it as a wrong token.
    const entry = entryFor("pepper", "s3kr1t");
    // Outright, not `"v" in entry ? entry.N : undefined`: the conditional made
    // the premise vacuous — an Entry that lost `N` yielded `undefined`, and
    // `undefined !== SCRYPT_PARAMS.N` passed while the test's subject (the
    // verifier reads per-entry params) had evaporated underneath it.
    expect(entry.N).toBe(TEST_SCRYPT.N);
    expect(entry.N).not.toBe(SCRYPT_PARAMS.N);
    writeAllowlist(root, { alice: entry });
    expect(authenticateApprover(root, "alice", "s3kr1t").ok).toBeTrue();
  });

  test.each([
    ["N below the floor", { N: 1024 }],
    ["N above the ceiling", { N: 1 << 21 }],
    ["N not a power of two", { N: 5000 }],
    ["r above the ceiling", { r: 64 }],
    ["p above the ceiling", { p: 99 }],
  ] as [string, Record<string, number>][])("a v2 entry with %s is a SCHEMA refusal, never a verification attempt", (_label, over) => {
    // An `N: 2^30` entry is a ~137 GB allocation on the verify path — a denial
    // of service written into a config file — and an `N: 2` one is a v2 label
    // over no work factor at all. Both are refused as malformed BEFORE any
    // scrypt call, which is why this asserts the schema code rather than a
    // mismatch or a thrown RangeError.
    writeAllowlist(root, { alice: { ...entryFor("pepper", "s3kr1t"), ...over } as unknown as Entry });
    expect(refusalOf(authenticateApprover(root, "alice", "s3kr1t")).code).toBe("approver-allowlist-invalid");
  });

  test("a v2 entry whose N·r PRODUCT passes both per-field ceilings but exceeds the allocation bound is a SCHEMA refusal", () => {
    // N = 2^20 and r = 32 are each individually legal — and together are a
    // 128 * 2^20 * 32 ≈ 4 GiB allocation per verification, with the computed
    // `maxmem` explicitly authorizing it. The per-field ceilings alone wrote a
    // denial of service into a config file; the product refine is the bound.
    writeAllowlist(root, { alice: { ...entryFor("pepper", "s3kr1t"), N: 1 << 20, r: 32 } as unknown as Entry });
    expect(refusalOf(authenticateApprover(root, "alice", "s3kr1t")).code).toBe("approver-allowlist-invalid");
  });

  test("an N·r product EXACTLY at the allocation ceiling is ACCEPTED — the refine is strict, not >=", () => {
    // 128 * 2^20 * 8 = 2^30 = SCRYPT_ALLOC_CEILING_BYTES precisely. The
    // over-ceiling case above cannot tell `>` from `>=` — both refuse it — and
    // under-ceiling passes either way, so the one discriminating entry is this
    // boundary: whether the ceiling admits or refuses a legal N=2^20, r=8
    // entry must not be decided by an off-by-one nobody pinned. The hash is
    // computed AT the entry's own params, because a boundary-accepted entry
    // goes on to a real scrypt verification.
    expect(128 * (1 << 20) * 8).toBe(SCRYPT_ALLOC_CEILING_BYTES);
    const salt = "pepper";
    const atBoundary = {
      v: 2 as const,
      salt,
      hash: scryptSync("s3kr1t", salt, 32, { N: 1 << 20, r: 8, p: 1, maxmem: 256 * (1 << 20) * 8 }).toString("hex"),
      N: 1 << 20,
      r: 8,
      p: 1,
    };
    writeAllowlist(root, { alice: atBoundary });
    // N = 2^20 is a genuinely heavy verification (~2.5 s on a 2026 laptop) —
    // the cost the ceiling exists to bound. The test pays it once, on purpose.
    expect(authenticateApprover(root, "alice", "s3kr1t").ok).toBeTrue();
  }, 15_000);

  test("a schema-VALID entry the KDF cannot run is a typed refusal, never a thrown Error the CLI reads as transient", () => {
    // node rejects N ≥ 2^(16r) regardless of the product bound, so N = 2^16 at
    // r = 1 parses clean and then throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS
    // inside scryptSync. Before the wrap, that throw escaped
    // `authenticateApprover` as a bare Error — classified transient/exit-1
    // ("retry me") — for an entry that fails the same way every time, where
    // the module header promises fail-closed.
    writeAllowlist(root, { alice: { ...entryFor("pepper", "s3kr1t"), N: 1 << 16, r: 1 } as unknown as Entry });
    const token = "tttttoken-that-must-not-appear";
    const refusal = refusalOf(authenticateApprover(root, "alice", token));
    expect(refusal.code).toBe("approver-entry-unverifiable");
    // The refusal an attacker may get to read never carries the presented token.
    expect(refusal.message).not.toContain(token);
    expect(refusal.remediation).not.toContain(token);
  });

  test("the allocation ceiling bounds the PRODUCT, and the minted defaults sit far under it", () => {
    expect(SCRYPT_ALLOC_CEILING_BYTES).toBe(1 << 30);
    // 32 MiB minted against a 1 GiB ceiling: a future cost increase has
    // headroom, but an entry cannot authorize a multi-GiB verification.
    expect(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r).toBeLessThanOrEqual(SCRYPT_ALLOC_CEILING_BYTES / 8);
  });

  test("constantTimeEqual never leaks a LENGTH — wildly unequal inputs compare without throwing", () => {
    // Round 6 found this asserted only for boolean equality, which any
    // implementation satisfies — including the obvious broken repair
    // (`if (a.length !== b.length) return false`), which puts the length back
    // into both the timing and the control flow. `timingSafeEqual` throws
    // RangeError on unequal-length buffers, so the ONLY way a 1-byte-vs-100 KiB
    // comparison returns `false` instead of throwing is if both sides were
    // digested to a fixed width first. That throw is the observable proxy for
    // the timing property a test cannot measure reliably in CI.
    expect(constantTimeEqual("a", "b".repeat(100_000))).toBeFalse();
    expect(constantTimeEqual("", "x")).toBeFalse();
    expect(constantTimeEqual("", "")).toBeTrue();
    expect(constantTimeEqual("identical", "identical")).toBeTrue();
    // Same length, different content — the case a length check alone passes.
    expect(constantTimeEqual("abcdefgh", "abcdefgi")).toBeFalse();
  });
});

describe("enrolApprover — the writer that makes the entropy assumption true (D9)", () => {
  test("enrolling on a host with NO .factory/ refuses as dir-mode with a `create` remediation — it does not mkdir", () => {
    // The FIRST enrolment on a REAL host, where `.factory/` does not exist at
    // all. Every other enrol test in this file pre-creates the directory, so
    // the fresh-host arm was asserted nowhere.
    //
    // PINNED BEHAVIOUR, NOT THE DOCSTRING'S PROMISE: `enrolApprover`'s header
    // says the first enrolment on a host "must obviously work", but the
    // guarded read's ancestor walk stats `.factory` before the absent-FILE arm
    // can be reached, and its ENOENT lands on `dir-mode` — so the verb refuses
    // and the operator must `mkdir -m 700` by hand. This test pins what the
    // code really does (fail closed, naming the fix); if the writer ever
    // learns to create the directory at 0700 itself, THIS is the test that
    // turns red and makes that a reviewed decision rather than a silent one.
    expect(existsSync(join(root, ".factory"))).toBeFalse();
    const res = enrolApprover(root, "alice@example.test");
    expect(res.ok).toBeFalse();
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("approver-allowlist-dir-mode");
    expect(res.refusal.message).toContain(join(root, ".factory"));
    // The remediation is actionable — "create", with the mode — not a chmod of
    // a directory that is not there.
    expect(res.refusal.remediation).toContain("create");
    expect(res.refusal.remediation).toContain("0700");
    // Nothing was written: no directory, no allowlist, no lock.
    expect(existsSync(join(root, ".factory"))).toBeFalse();
  });

  test("enrolling mints a token the verifier accepts, at v2, 0600, on a host with no .factory yet", () => {
    // The FIRST enrolment on a PREPARED host: `.factory/` exists at 0700 and
    // carries no allowlist — the absent-file arm, which the read guard's walk
    // now lets through and the writer cannot simply propagate a refusal from.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const res = enrolApprover(root, "alice@example.test");
    if (!res.ok) throw new Error(`expected an enrolment, got ${res.refusal.code}: ${res.refusal.message}`);
    expect(res.replaced).toBeFalse();
    // 256 bits of base64url. The point is that the OPERATOR never chose it.
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 0600 from birth — `writeFileSync`'s mode is masked by umask, so this is
    // the assertion that the write went through `openSync(…, "wx", 0o600)`.
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    // No staging debris left behind — the property, not a naming convention:
    // the atomic write's temp lives in THIS directory and a failed rename or a
    // crashed successor would leave exactly one entry beside the allowlist.
    // The `.tmp`/`.approvers.` filter is the convention today's writer uses;
    // the strict form is "the directory holds only the allowlist", which is
    // what the concurrent test below asserts at the lock level.
    expect(readdirSync(join(root, ".factory")).filter((f) => f.includes(".tmp") || f.includes(".approvers."))).toEqual(
      [],
    );
    expect(readdirSync(join(root, ".factory"))).toEqual([basename(res.path)]);

    // THE ROUND TRIP: the real verifier accepts the minted token, at v2 (no
    // `legacyHash`), and rejects anything else.
    expect(authenticateApprover(root, "alice@example.test", res.token)).toEqual({
      ok: true,
      approverId: "alice@example.test",
    });
    expect(refusalOf(authenticateApprover(root, "alice@example.test", "not-it")).code).toBe("approver-token-mismatch");
  });

  test("two enrolments of DIFFERENT approvers both survive — the second does not clobber the first", () => {
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const a = enrolApprover(root, "alice");
    const b = enrolApprover(root, "bob");
    if (!a.ok || !b.ok) throw new Error("both enrolments should succeed");
    expect(authenticateApprover(root, "alice", a.token).ok).toBeTrue();
    expect(authenticateApprover(root, "bob", b.token).ok).toBeTrue();
    // …and neither token authenticates the other approver.
    expect(refusalOf(authenticateApprover(root, "alice", b.token)).code).toBe("approver-token-mismatch");
  });

  test("re-enrolling an existing approver is REFUSED without --rotate, and rotating invalidates the old token", () => {
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const first = enrolApprover(root, "alice");
    if (!first.ok) throw new Error("first enrolment should succeed");

    // A silent overwrite would invalidate a working credential with no warning,
    // and the operator would find out the next time a decision was refused.
    const again = enrolApprover(root, "alice");
    expect(again.ok).toBeFalse();
    if (again.ok) throw new Error("unreachable");
    expect(again.refusal.code).toBe("approver-already-enrolled");
    // Nothing was mutated: the original token still works.
    expect(authenticateApprover(root, "alice", first.token).ok).toBeTrue();

    const rotated = enrolApprover(root, "alice", DEFAULT_APPROVERS_FILE, { rotate: true });
    if (!rotated.ok) throw new Error("rotation should succeed");
    expect(rotated.replaced).toBeTrue();
    expect(rotated.token).not.toBe(first.token);
    expect(authenticateApprover(root, "alice", rotated.token).ok).toBeTrue();
    // THE POINT of a rotation: the old credential stops working immediately.
    expect(refusalOf(authenticateApprover(root, "alice", first.token)).code).toBe("approver-token-mismatch");
  });

  test("enrolment reads through the SAME path guard it writes through", () => {
    // An enrolment that skipped the ancestor walk would merge an attacker's
    // existing entries into the file it then writes back, laundering them
    // through a trusted verb.
    writeAllowlist(root, { alice: entryFor("s", "tok") });
    chmodSync(join(root, ".factory"), 0o777);
    const res = enrolApprover(root, "bob");
    expect(res.ok).toBeFalse();
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("approver-allowlist-dir-mode");
    chmodSync(join(root, ".factory"), 0o700);
  });

  test("an UNPARSEABLE allowlist is refused, never replaced — enrolling must not drop entries it cannot see", () => {
    writeRaw(root, "{ this is not json");
    const res = enrolApprover(root, "alice");
    expect(res.ok).toBeFalse();
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("approver-allowlist-invalid");
    // The bytes are untouched: an operator can still recover whatever was there.
    expect(readFileSync(join(root, ".factory", "approvers.json"), "utf8")).toBe("{ this is not json");
  });

  test("an empty approver id is refused before anything is written", () => {
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const res = enrolApprover(root, "   ");
    expect(res.ok).toBeFalse();
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("approver-id-empty");
    expect(existsSync(join(root, ".factory", "approvers.json"))).toBeFalse();
  });

  test("`__proto__` is REFUSED at enrolment — the entry could never authenticate, so ok:true was a lie", () => {
    // The regression: `approvers["__proto__"] = entry` on a spread-built plain
    // object runs the INHERITED setter, so JSON.stringify dropped the entry —
    // the verb reported success for a token that verifies against nothing, and
    // re-enrolment never tripped `approver-already-enrolled`. A safe WRITE
    // would not rescue it either: the schema's record parse drops the key
    // (zod v3 builds records with plain assignment), so the read path could
    // never authenticate it. Refused where the operator can still pick
    // another id.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const res = enrolApprover(root, "__proto__");
    expect(res.ok).toBeFalse();
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("approver-id-reserved");
    expect(existsSync(join(root, ".factory", "approvers.json"))).toBeFalse();
  });

  test("two CONCURRENT enrolments both survive — the read-modify-write is serialized across processes", async () => {
    // The regression: two overlapping `fleet enrol` runs each read the same
    // base file, merged into their own copy and both renameSync'd — last wins,
    // and the other's approver silently vanished while its operator held a
    // token that verifies against nothing. `enrolApprover` is synchronous, so
    // the overlap is real child processes — exactly how two operators' shells
    // collide — started against an ABSENT allowlist so both probe the same
    // empty base.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const MODULE = join(HERE, "..", "..", "src", "fleet", "approvers.ts");
    const ids = ["alice", "bob", "carol", "dave"];
    const children = ids.map((id) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(MODULE)});
           const res = m.enrolApprover(${JSON.stringify(root)}, ${JSON.stringify(id)});
           process.stdout.write(JSON.stringify(res.ok ? { ok: true, token: res.token } : { ok: false, code: res.refusal.code }));`,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      ),
    );
    const results = await Promise.all(
      children.map(async (child, i) => {
        const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(`child ${ids[i]} exited ${exitCode}\nstdout: ${out}\nstderr: ${err}`);
        return JSON.parse(out) as { ok: boolean; token?: string; code?: string };
      }),
    );
    for (const [i, id] of ids.entries()) {
      const res = results[i];
      if (res === undefined || !res.ok) throw new Error(`enrolment of ${id} was refused: ${res?.code}`);
      // EVERY enrolment survived: each minted token authenticates its own approver.
      expect(authenticateApprover(root, id, res.token as string).ok).toBeTrue();
    }
    const written = JSON.parse(readFileSync(join(root, ".factory", "approvers.json"), "utf8")) as {
      approvers: Record<string, unknown>;
    };
    expect(Object.keys(written.approvers).sort()).toEqual([...ids].sort());
    // The lock was released, not stranded.
    expect(readdirSync(join(root, ".factory")).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  test("a STALE dead-pid enrolment lock is claimed and removed atomically — enrolment proceeds", () => {
    // The reclaim moves the judged file onto a private claim path with
    // `rename` (at most one winner) rather than re-read + unlinking the shared
    // path. The observable here is the outcome: the dead lock is gone, the
    // enrolment lands, and neither a lock nor a claim scratch file is left.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const lock = join(root, ".factory", "approvers.json.lock");
    const dead = spawnSync(process.execPath, ["--version"]);
    writeFileSync(lock, `${dead.pid}:stale-nonce`, { mode: 0o600 });
    // A dead pid can be RECYCLED onto a live process between its exit and the
    // reclaim; the lock would then be judged live, the enrolment would wait
    // out its whole timeout and this test would fail as "locked" instead of
    // saying anything about reclaim. That window is wide enough to be worth
    // closing and too narrow to close by construction — so check death ONCE,
    // immediately before the call, and re-mint rather than assert a red that
    // is about the platform and not the code.
    if (!isDeadPid(dead.pid as number)) {
      writeFileSync(lock, `${spawnSync(process.execPath, ["--version"]).pid}:stale-nonce`, { mode: 0o600 });
    }
    if (!isDeadPid(Number(readFileSync(lock, "utf8").split(":", 1)[0]))) {
      throw new Error("could not mint a provably-dead pid for the stale lock; skipping, not misfailing");
    }
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const res = enrolApprover(root, "alice");
    if (!res.ok) throw new Error(`enrolment refused: ${res.refusal.code}`);
    expect(authenticateApprover(root, "alice", res.token).ok).toBeTrue();
    expect(readdirSync(join(root, ".factory")).filter((f) => f.includes(".lock"))).toEqual([]);
  });

  test("a STALE lock whose pid is EMPTY or GARBAGE is reclaimable too — the unreadable-holder door", () => {
    // Mirrors approval-gate.ts's reclaim (`holderPid === undefined || dead`):
    // past the stale window a lock that names no usable pid is a holder nobody
    // can prove alive, and leaving it standing made one crashed write strand
    // every future enrolment on the host until an operator deleted it by hand.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const lock = join(root, ".factory", "approvers.json.lock");
    const old = new Date(Date.now() - 60_000);
    let n = 0;
    for (const raw of ["", ":orphaned-nonce", "not-a-pid:nonce"]) {
      writeFileSync(lock, raw, { mode: 0o600 });
      utimesSync(lock, old, old);
      const id = `reclaim${n}`;
      n += 1;
      const res = enrolApprover(root, id);
      if (!res.ok) throw new Error(`${JSON.stringify(raw)} not reclaimed: ${res.refusal.code}`);
      expect(authenticateApprover(root, id, res.token).ok).toBeTrue();
      expect(fs.readdirSync(join(root, ".factory")).filter((f) => f.includes(".lock"))).toEqual([]);
    }
  });

  test("a replacement lock created mid-reclaim is RESTORED, never unlinked — the live holder's lock survives", () => {
    // The race CodeRabbit flagged: re-read + `rmSync` deleted a competing
    // enrolment's LIVE lock when it replaced the dead one between the
    // comparison and the unlink — the comparison was never conditional at the
    // kernel. The claim protocol renames the judged file away atomically, so
    // the replacement is CAPTURED on a private path instead, and the restore
    // must put the very file back (`link`), leaving the live lock exactly as
    // its holder wrote it.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const lock = join(root, ".factory", "approvers.json.lock");
    const dead = spawnSync(process.execPath, ["--version"]);
    const deadRaw = `${dead.pid}:stale-nonce`;
    writeFileSync(lock, deadRaw, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    // Inject the interleave: the moment the reclaim has judged the dead
    // bytes, a competitor's live lock (this process's pid, provably alive)
    // has taken their place.
    const liveRaw = `${process.pid}:replacement-nonce`;
    const realReadFileSync = fs.readFileSync;
    let injected = false;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const result = realReadFileSync(...args);
      if (!injected && args[0] === lock && result === deadRaw) {
        injected = true;
        fs.writeFileSync(lock, liveRaw, { mode: 0o600 });
      }
      return result;
    }) as typeof fs.readFileSync);
    try {
      // The fresh replacement is below the stale age, so no further reclaim
      // fires: the enrolment waits out its timeout and refuses — and the wait
      // is the price of NEVER deleting a live lock.
      const res = enrolApprover(root, "alice");
      expect(res.ok).toBeFalse();
      if (res.ok) throw new Error("unreachable");
      expect(res.refusal.code).toBe("approver-allowlist-locked");
    } finally {
      readSpy.mockRestore();
    }
    // The live holder's lock survived, byte-identical, and the captured copy
    // was restored rather than left as scratch.
    expect(fs.readFileSync(lock, "utf8")).toBe(liveRaw);
    expect(fs.readdirSync(join(root, ".factory")).filter((f) => f.includes(".claim."))).toEqual([]);
  }, 15_000);

  test("a restore failure after capturing a live lock fails CLOSED — captured file preserved, never retried past", () => {
    // Same interleave, but the restore `link` faults (EIO). The reclaim must
    // throw rather than swallow-and-retry: retrying would spin to the timeout
    // and misreport a filesystem fault as lock contention ("held for over"),
    // and the captured live lock must be left at the claim path for an
    // operator to restore by hand.
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, ".factory"), 0o700);
    const lock = join(root, ".factory", "approvers.json.lock");
    const dead = spawnSync(process.execPath, ["--version"]);
    const deadRaw = `${dead.pid}:stale-nonce`;
    writeFileSync(lock, deadRaw, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const liveRaw = `${process.pid}:replacement-nonce`;
    const realReadFileSync = fs.readFileSync;
    let injected = false;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const result = realReadFileSync(...args);
      if (!injected && args[0] === lock && result === deadRaw) {
        injected = true;
        fs.writeFileSync(lock, liveRaw, { mode: 0o600 });
      }
      return result;
    }) as typeof fs.readFileSync);
    // `linkSync` is called nowhere else on this path, so spying it alone
    // gates the injection to the restore.
    const realLinkSync = fs.linkSync;
    const linkSpy = spyOn(fs, "linkSync").mockImplementation(((
      ...args: Parameters<typeof fs.linkSync>
    ) => {
      if (String(args[0]).includes(".claim.")) {
        const err = new Error("simulated transient I/O error") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return realLinkSync(...args);
    }) as typeof fs.linkSync);
    try {
      expect(() => enrolApprover(root, "alice")).toThrow(/approver allowlist lock reclaim: failed to restore/);
    } finally {
      linkSpy.mockRestore();
      readSpy.mockRestore();
    }
    // Fail closed, not open: no allowlist was written, and the captured live
    // lock is preserved at the claim path for operator recovery.
    expect(existsSync(join(root, ".factory", "approvers.json"))).toBeFalse();
    const leftovers = fs.readdirSync(join(root, ".factory")).filter((f) => f.includes(".claim."));
    expect(leftovers.length).toBe(1);
    expect(fs.readFileSync(join(root, ".factory", leftovers[0]!), "utf8")).toBe(liveRaw);
  });
});
