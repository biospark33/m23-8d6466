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
  existsSync,
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

/** Land arbitrary bytes at the allowlist path, 0600, directory already 0700. */
function writeRaw(root: string, text: string, name = "approvers.json"): string {
  writeAllowlist(root, null);
  const path = join(root, ".factory", name);
  writeFileSync(path, text);
  chmodSync(path, 0o600);
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
      // It must name the OFFENDING component, not .factory — sending the
      // operator to chmod a directory that is already 0700 fixes nothing.
      expect(refusal.message).toContain(mid);
      expect(refusal.message).not.toContain(".factory");
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
    try {
      writeAllowlist(outside, { alice: entryFor("s", "tok") });
      for (const file of [join(outside, ".factory", "approvers.json"), join("..", "evil", "approvers.json")]) {
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
    // It gave up on the deadline, not on the cap: far fewer than 4096 bytes.
    expect(sent).toBeLessThan(MAX_TOKEN_BYTES);
    expect(Date.now() - started).toBeLessThan(2_000);
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
    writeRaw(root, JSON.stringify({ version: 1, approvers: { alice: { salt: "s", hash } } }));
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("an EMPTY salt is refused — the separator is only load-bearing with something to separate", () => {
    writeRaw(root, JSON.stringify({ version: 1, approvers: { alice: { salt: "", hash: entryFor("", "tok").hash } } }));
    expect(refusalOf(authenticateApprover(root, "alice", "tok")).code).toBe("approver-allowlist-invalid");
  });

  test("a BOM-prefixed allowlist still authenticates — an editor's mark is not corruption", () => {
    // A UTF-8 BOM is what a Windows editor or a PowerShell redirect leaves on a
    // config file, and without the strip it is a JSON.parse failure that reads
    // to the operator as a corrupt allowlist.
    writeRaw(root, `﻿${JSON.stringify({ version: 1, approvers: { alice: entryFor("pepper", "s3kr1t") } })}`);
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
  const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });

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
    "bun",
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
