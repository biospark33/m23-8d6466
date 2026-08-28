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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTokenAttached,
  authenticateApprover,
  constantTimeEqual,
  DEFAULT_APPROVERS_FILE,
  hashToken,
  MAX_TOKEN_BYTES,
  readCappedToken,
  TOKEN_STDIN_TIMEOUT_MS,
} from "../../src/fleet/approvers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "approvers.json");
/** The fixture's documented sentinel token. Obviously fake, by construction. */
const FIXTURE_TOKEN = "fake-approver-token-alice";
const FIXTURE_ID = "alice@example.test";

type Entry = { salt: string; hash: string };

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

/** An entry for `token`, hashed by an oracle independent of the source. */
function entryFor(salt: string, token: string): Entry {
  return { salt, hash: createHash("sha256").update(`${salt}:${token}`, "utf8").digest("hex") };
}

/** File-local: there is no shared refusal helper, and one file does not need one. */
function refusalOf(result: ReturnType<typeof authenticateApprover>): { code: string; message: string; remediation: string } {
  if (result.ok) throw new Error(`expected a refusal, got approverId ${result.approverId}`);
  return result.refusal;
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

  test("mode 0644 refuses, naming the offending mode, before the content is read", () => {
    writeAllowlist(root, { alice: entryFor("s", "tok") }, 0o644);
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-mode");
    expect(refusal.message).toContain("644");
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

  test("a READABLE-but-not-writable .factory/ is allowed — 0750 is a legitimate posture", () => {
    // WRITE is the operative bit, not read. Requiring 0700 exactly would refuse
    // ordinary group-readable deployments, and a check that refuses correct
    // setups is one an operator disables — which is strictly worse than one
    // that draws the line at the bit the attack actually needs.
    for (const dirMode of [0o700, 0o750, 0o705, 0o755]) {
      writeAllowlist(root, { alice: entryFor("s", "tok") });
      chmodSync(join(root, ".factory"), dirMode);
      const res = authenticateApprover(root, "alice", "tok");
      expect(res.ok).toBeTrue();
    }
  });

  test("mode 0640 refuses too — group-readable is still readable by somebody else", () => {
    writeAllowlist(root, { alice: entryFor("s", "tok") }, 0o640);
    const refusal = refusalOf(authenticateApprover(root, "alice", "tok"));
    expect(refusal.code).toBe("approver-allowlist-mode");
    expect(refusal.message).toContain("640");
  });

  test("an EMPTY allowlist authorizes NOBODY — it never degrades to allow-all", () => {
    writeAllowlist(root, {});
    const refusal = refusalOf(authenticateApprover(root, "alice", "any-token"));
    expect(refusal.code).toBe("approver-unknown");
  });

  test("the allowlist is written 0600 inside a 0700 directory", () => {
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
    writeAllowlist(root, { alice: { salt: "salt-a", hash: entryFor("salt-b", "tok").hash } });
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

  test("a prototype key is not an approver — `__proto__` and `constructor` are refused", () => {
    writeAllowlist(root, { alice: entryFor("pepper", "s3kr1t") });
    for (const id of ["__proto__", "constructor", "toString"]) {
      expect(refusalOf(authenticateApprover(root, id, "s3kr1t")).code).toBe("approver-unknown");
    }
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
  });
});

describe("approvers.ts — constant-time comparison", () => {
  test("equal strings compare equal", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  });

  test("same-length different strings compare unequal", () => {
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
  });

  test("DIFFERENT-length strings compare unequal WITHOUT throwing", () => {
    // The regression this guards: `timingSafeEqual` over the raw strings throws
    // RangeError on unequal lengths, and an early length-return leaks the
    // length. Digesting both sides first makes every comparison 32 bytes.
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  test("two empty strings compare equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  test("hashToken is salted, hex, and separator-bound", () => {
    expect(hashToken("pepper", "tok")).toBe(entryFor("pepper", "tok").hash);
    expect(hashToken("pepper", "tok")).toMatch(/^[0-9a-f]{64}$/);
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(hashToken("ab", "c")).not.toBe(hashToken("a", "bc"));
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
  const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });

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
        "bun",
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
    await child.exited;

    const printed = JSON.parse(out) as { direct: string | null; ok: boolean; len: number; code: string | null };
    expect(printed.direct).toBeNull();
    expect(printed).toMatchObject({ ok: true, len: token.length, code: null });
    expect(out).not.toContain(token);
    expect(err).not.toContain(token);
  });
});
