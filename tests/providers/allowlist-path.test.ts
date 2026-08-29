/**
 * D4 — the shared path guard for security-deciding config files.
 *
 * NO `fs` MOCKING ANYWHERE IN THIS FILE, deliberately and permanently. The
 * property under test IS the filesystem: real `mkdtemp` roots, real `chmod`,
 * real `mkfifo`, real mode bits, real uids. A mock of `statSync` proving a
 * guard that reads `statSync` proves only that the mock was written to agree
 * with the guard. Anyone tempted to reach for one here should instead ask what
 * real object has the property they were about to fake.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGuardedFile, type GuardedFileSpec } from "../../src/providers/allowlist-path.ts";

const SPEC: GuardedFileSpec = {
  codePrefix: "test-allowlist",
  label: "test allowlist",
  defaultFile: ".factory/test.json",
  contentHint: "mapping each id to its entry",
  consequence: "every request is refused",
};

/**
 * Roots are torn down in `afterAll` rather than per-test, because a failing
 * assertion should leave the real modes on disk for an operator to inspect —
 * that is the whole point of testing against a real filesystem.
 */
const roots: string[] = [];
function makeRoot(): string {
  // `mkdtemp` is 0700 by definition, which is what makes the ancestor walk's
  // pass arms meaningful: the root is already correct, so a refusal below is
  // always attributable to the thing the test deliberately loosened.
  const root = mkdtempSync(join(tmpdir(), "d4-guard-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A correctly-provisioned file at `<root>/.factory/test.json`. */
function provision(root: string, body = '{"ok":true}'): string {
  const dir = join(root, ".factory");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const path = join(dir, "test.json");
  writeFileSync(path, body);
  chmodSync(path, 0o600);
  return path;
}

const refusalOf = (r: ReturnType<typeof readGuardedFile>) => {
  if (r.ok) throw new Error(`expected a refusal, got ok with text ${JSON.stringify(r.text)}`);
  return r.refusal;
};

describe("D4 — the happy path, so the hardening is not proven only by its refusals", () => {
  // This is the case that catches an OVER-TIGHT guard. Every refusal test below
  // would still pass if `readGuardedFile` refused unconditionally.
  test("a correctly-provisioned file under a 0700 chain is READ, and the text comes back", () => {
    const root = makeRoot();
    const path = provision(root, '{"version":1,"repos":{}}');
    const read = readGuardedFile(root, ".factory/test.json", SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.path).toBe(path);
    expect(read.text).toBe('{"version":1,"repos":{}}');
  });

  test("an ordinary 0755 ancestor is ACCEPTED — the guard tests WRITE bits, not an exact 0700", () => {
    // 0755 is what `mkdir` under the default 022 umask produces, so a guard
    // that demanded 0700 exactly would refuse the ordinary correct deployment
    // and get switched off. `0755 & 0o022 === 0`.
    const root = makeRoot();
    const mid = join(root, "deploy");
    mkdirSync(mid);
    chmodSync(mid, 0o755);
    const dir = join(mid, ".factory");
    mkdirSync(dir);
    chmodSync(dir, 0o750); // group-READABLE, the ordinary packaged layout
    const path = join(dir, "test.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);
    expect(readGuardedFile(root, "deploy/.factory/test.json", SPEC)).toMatchObject({ ok: true, path });
  });

  test("a file sitting directly in hostRoot is accepted — the walk's first step is also its last", () => {
    const root = makeRoot();
    const path = join(root, "test.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);
    expect(readGuardedFile(root, "test.json", SPEC)).toMatchObject({ ok: true });
  });

  test("a byte-order mark is stripped, so an editor-written config is not read as corruption", () => {
    const root = makeRoot();
    provision(root, '﻿{"version":1}');
    const read = readGuardedFile(root, ".factory/test.json", SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The BOM is GONE, not merely tolerated: the caller's `JSON.parse` is the
    // thing that must not see it.
    expect(read.text).toBe('{"version":1}');
    expect(() => JSON.parse(read.text)).not.toThrow();
  });
});

describe("D4 — containment: a caller cannot point the guard at a file it owns", () => {
  test("a real ABSOLUTE path escapes hostRoot and is refused", () => {
    const root = makeRoot();
    provision(root);
    // A real, correctly-moded file OUTSIDE the root. Every other guard would
    // pass on it truthfully; containment is the only thing that refuses it,
    // which is precisely why its absence was exploitable.
    const elsewhere = makeRoot();
    const planted = provision(elsewhere, '{"evil":true}');
    expect(statSync(planted).mode & 0o777).toBe(0o600);

    const refusal = refusalOf(readGuardedFile(root, planted, SPEC));
    expect(refusal.code).toBe("test-allowlist-path");
    expect(refusal.message).toContain(planted);
    expect(refusal.message).toContain(root);
  });

  test("a real `../` escape is refused", () => {
    const root = makeRoot();
    const refusal = refusalOf(readGuardedFile(root, "../../etc/passwd", SPEC));
    expect(refusal.code).toBe("test-allowlist-path");
    expect(refusal.remediation).toContain(".factory/test.json");
  });

  test("a sibling directory sharing hostRoot's NAME PREFIX is refused — the separator is load-bearing", () => {
    // `/tmp/d4-guard-aaa` vs `/tmp/d4-guard-aaa-evil`: a `startsWith(root)`
    // without the trailing separator would accept the second as "inside" the
    // first. This is the classic prefix-containment bug, tested against real
    // directories rather than reasoned about.
    const root = makeRoot();
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true, mode: 0o700 });
    roots.push(sibling);
    const planted = join(sibling, "test.json");
    writeFileSync(planted, "{}");
    chmodSync(planted, 0o600);

    expect(refusalOf(readGuardedFile(root, planted, SPEC)).code).toBe("test-allowlist-path");
  });

  test("containment is LEXICAL, so a symlink pointing out of hostRoot is judged by its own path", () => {
    // Documenting the deliberate choice, not a defect: the link SITS inside the
    // root, so containment accepts it, and the ancestor walk is what refuses
    // the writable directory such a link would have to be planted in. Here the
    // chain is clean, so the read follows the link — which is why the walk, not
    // `realpathSync`, is the control that matters.
    const root = makeRoot();
    const outside = makeRoot();
    const target = provision(outside, '{"linked":true}');
    const dir = join(root, ".factory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(dir, "test.json"));

    const read = readGuardedFile(root, ".factory/test.json", SPEC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toBe('{"linked":true}');
  });
});

describe("D4 — the ancestor walk: a 0600 file inside a writable directory is not a control", () => {
  test("a real 0777 ancestor ABOVE a correct 0700 directory is refused, and the offender is NAMED", () => {
    const root = makeRoot();
    const loose = join(root, "loose");
    mkdirSync(loose);
    const dir = join(loose, ".factory");
    mkdirSync(dir);
    chmodSync(dir, 0o700); // the file's own directory is perfect …
    const path = join(dir, "test.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600); // … and so is the file
    chmodSync(loose, 0o777); // … but `mv evil.json` one level up replaces both

    const refusal = refusalOf(readGuardedFile(root, "loose/.factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-dir-mode");
    // NAMED: an operator handed "something on the path is wrong" cannot fix it.
    expect(refusal.message).toContain(loose);
    expect(refusal.message).toContain("777");
    expect(refusal.remediation).toContain(`chmod go-w ${loose}`);
    // And it names the LOOSE one, not the innocent 0700 directory below it.
    expect(refusal.message).not.toContain(join(loose, ".factory"));
  });

  test("the file's OWN directory being group-writable is refused (0770)", () => {
    const root = makeRoot();
    const path = provision(root);
    chmodSync(join(root, ".factory"), 0o770);
    const refusal = refusalOf(readGuardedFile(root, ".factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-dir-mode");
    expect(refusal.message).toContain(join(root, ".factory"));
    // The FILE is still perfect. That is the finding in one assertion.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("hostRoot ITSELF is walked — the chain includes its own top", () => {
    // The round-6 defect in `approvers.ts` was a walk that stopped one level
    // short. A writable hostRoot is exactly a CI scratch dir or a /tmp
    // workspace, so this is the common case, not the exotic one.
    const root = makeRoot();
    provision(root);
    chmodSync(root, 0o777);
    const refusal = refusalOf(readGuardedFile(root, ".factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-dir-mode");
    expect(refusal.message).toContain(root);
  });

  test("the walk STOPS at hostRoot — a real 0777 directory ABOVE it does not refuse", () => {
    // Above hostRoot is the operator's own filesystem layout. Refusing because
    // a `/tmp`-like ancestor is world-writable would refuse every correct
    // temp-rooted invocation, so the walk must stop.
    //
    // Built for real rather than relying on the OS's temp dir: on macOS
    // `tmpdir()` is `$TMPDIR`, a 0700 per-user directory, NOT the 1777 `/tmp`
    // — so an assertion about the ambient temp root would prove nothing here
    // and something else on Linux.
    const outer = makeRoot();
    chmodSync(outer, 0o777);
    const host = join(outer, "workspace");
    mkdirSync(host, { mode: 0o700 });
    provision(host);

    expect(statSync(outer).mode & 0o022).not.toBe(0); // genuinely world-writable
    // Refused when `outer` IS the root (it is then ON the chain) …
    expect(refusalOf(readGuardedFile(outer, "workspace/.factory/test.json", SPEC)).code).toBe("test-allowlist-dir-mode");
    // … and accepted when the root is `host`, because the walk stops there.
    expect(readGuardedFile(host, ".factory/test.json", SPEC).ok).toBe(true);
  });

  test("a missing directory on the path refuses with the dir arm, not a bare ENOENT throw", () => {
    const root = makeRoot();
    const refusal = refusalOf(readGuardedFile(root, "absent/.factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-dir-mode");
    expect(refusal.remediation).toContain("mode 0700");
  });
});

describe("D4 — the file's own type and mode", () => {
  test("a real 0644 file is refused before it is read", () => {
    const root = makeRoot();
    provision(root);
    chmodSync(join(root, ".factory", "test.json"), 0o644);
    const refusal = refusalOf(readGuardedFile(root, ".factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-mode");
    expect(refusal.message).toContain("must be 0600");
    expect(refusal.message).toContain("644");
  });

  test("a real DIRECTORY at the path is refused as not-a-regular-file", () => {
    const root = makeRoot();
    const dir = join(root, ".factory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "test.json"), { mode: 0o700 });
    const refusal = refusalOf(readGuardedFile(root, ".factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-unreadable");
    expect(refusal.message).toContain("not a regular file");
  });

  test("an absent file refuses with a remediation naming what to create", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".factory"), { recursive: true, mode: 0o700 });
    const refusal = refusalOf(readGuardedFile(root, ".factory/test.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-unreadable");
    expect(refusal.remediation).toContain("mapping each id to its entry");
    expect(refusal.remediation).toContain("every request is refused");
  });
});

describe("D4 — a real FIFO is refused and does NOT hang", () => {
  /**
   * The ordering `isFile()` BEFORE the mode check is load-bearing, not style: a
   * fifo reports 0600 as readily as a regular file, so a mode-first guard
   * passes and `readFileSync` then blocks in `open(2)` forever waiting for a
   * writer. There is no timeout on that read.
   *
   * Proven in a SUBPROCESS under a real wall-clock deadline rather than
   * in-process, because a synchronous block cannot be raced from the same
   * thread — an in-process version that hung would look identical to a passing
   * test until the runner's own timeout fired, which is the failure mode this
   * assertion exists to rule out.
   */
  test("mkfifo at the path ⇒ refused as not-a-regular-file, well inside a real deadline", async () => {
    const root = makeRoot();
    const dir = join(root, ".factory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "test.json");

    const mk = Bun.spawnSync(["mkfifo", "-m", "600", path]);
    expect(mk.exitCode).toBe(0);
    // A REAL fifo, with a real 0600 mode — the exact shape that fools a
    // mode-only guard. No writer is ever attached, so a read would never return.
    const st = statSync(path);
    expect(st.isFIFO()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.isFile()).toBe(false);

    const script = `
      const { readGuardedFile } = await import(${JSON.stringify(new URL("../../src/providers/allowlist-path.ts", import.meta.url).pathname)});
      const r = readGuardedFile(${JSON.stringify(root)}, ".factory/test.json", ${JSON.stringify(SPEC)});
      process.stdout.write(JSON.stringify(r));
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const DEADLINE_MS = 10_000;
    const timer = setTimeout(() => proc.kill("SIGKILL"), DEADLINE_MS);
    const started = Date.now();
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    const elapsed = Date.now() - started;

    // Exit 0, not a signal: a killed process would report a nonzero/`null`
    // code, so this single assertion is what distinguishes "refused" from
    // "hung and was shot".
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(DEADLINE_MS);
    const parsed = JSON.parse(out) as { ok: boolean; refusal?: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.refusal?.code).toBe("test-allowlist-unreadable");
    expect(parsed.refusal?.message).toContain("not a regular file");
  }, 20_000);
});

/**
 * Ownership, against REAL uids on the real host. Nothing here fabricates a uid
 * or stubs `statSync`; where the host cannot supply a real object with the
 * property, the test SKIPS with the reason stated rather than faking a green.
 */
describe("D4 — ownership, proven against real uids", () => {
  const self = process.getuid?.();

  /** A real directory on this host owned by neither the caller nor root. */
  const foreignDir = (() => {
    if (self === undefined) return null;
    for (const c of ["/var/db/lockdown", "/var/db/locationd", "/var/db/hidd"]) {
      try {
        const st = statSync(c);
        // It must also be clean on the WRITE bits, or the dir-mode arm would
        // fire first and the test would prove the wrong guard.
        if (st.isDirectory() && st.uid !== self && st.uid !== 0 && (st.mode & 0o022) === 0) return { path: c, uid: st.uid };
      } catch {
        /* not on this host */
      }
    }
    return null;
  })();

  /** A real root-owned directory with clean write bits. */
  const rootDir = (() => {
    for (const c of ["/private/etc", "/etc", "/usr"]) {
      try {
        const st = statSync(c);
        if (st.isDirectory() && st.uid === 0 && (st.mode & 0o022) === 0) return c;
      } catch {
        /* not on this host */
      }
    }
    return null;
  })();

  /** A real root-owned 0600 regular file under a root-owned clean directory. */
  const rootFile = (() => {
    for (const c of ["/private/etc/master.passwd", "/etc/master.passwd"]) {
      try {
        const st = statSync(c);
        if (st.isFile() && st.uid === 0 && (st.mode & 0o077) === 0) return c;
      } catch {
        /* not on this host */
      }
    }
    return null;
  })();

  test("SELF-owned is accepted", () => {
    // The whole happy-path block above is this proof; asserted explicitly here
    // so the accepted arm is not merely implied.
    const root = makeRoot();
    const path = provision(root);
    expect(statSync(path).uid).toBe(self ?? statSync(path).uid);
    expect(readGuardedFile(root, ".factory/test.json", SPEC).ok).toBe(true);
  });

  test.skipIf(rootDir === null)("a ROOT-owned directory on the path is accepted, not refused as foreign", () => {
    // A real root-owned directory as hostRoot, with a name that does not exist
    // under it: the walk runs to completion and the refusal that comes back is
    // the FILE arm. If root-owned directories were rejected, the code would be
    // `-owner` and the walk would never have reached the file.
    const refusal = refusalOf(readGuardedFile(rootDir as string, "d4-nonexistent-probe.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-unreadable");
    expect(refusal.code).not.toBe("test-allowlist-owner");
  });

  test.skipIf(rootFile === null)("a ROOT-owned 0600 FILE passes the type, mode and ownership guards", () => {
    // Every guard accepts it; the refusal that remains is EACCES from the real
    // `readFileSync`, because this process is not root. That is the point: the
    // OWNERSHIP arm did not fire on a root-owned file.
    const path = rootFile as string;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const refusal = refusalOf(readGuardedFile(dir, path.slice(dir.length + 1), SPEC));
    expect(refusal.code).toBe("test-allowlist-unreadable");
    expect(refusal.message).toMatch(/EACCES|permission denied/i);
    // Not the owner arm, and not the mode arm — both of which would have fired
    // BEFORE the read if root-ownership or 0600 were mishandled.
    expect(refusal.message).not.toContain("owned by uid");
    expect(refusal.message).not.toContain("must be 0600");
  });

  test.skipIf(foreignDir === null)("a FOREIGN-owned directory on the path is REFUSED, and its uid is named", () => {
    // A real directory owned by a real third uid on this host — no sudo, no
    // fabricated uid, no `fs` stub. This is the arm the tracking doc expected
    // to be unprovable on a single-user host; it is provable because the OS
    // ships service-account-owned directories with clean write bits.
    const { path, uid } = foreignDir as { path: string; uid: number };
    const refusal = refusalOf(readGuardedFile(path, "d4-nonexistent-probe.json", SPEC));
    expect(refusal.code).toBe("test-allowlist-owner");
    expect(refusal.message).toContain(`owned by uid ${uid}`);
    expect(refusal.message).toContain(path);
    expect(refusal.remediation).toContain(`chown ${self}`);
  });
});
