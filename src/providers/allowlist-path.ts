/**
 * The path guard every SECURITY-DECIDING config file on this host shares.
 *
 * Two allowlists decide things an attacker wants to decide: `.factory/repos.json`
 * says which repository the factory pushes to and opens a PR against
 * (`src/pr/repos.ts`, INV-PR-3), and `.factory/approvers.json` says who may
 * approve a run (`src/fleet/approvers.ts`, INV-APPROVE-3). Whoever controls
 * either file controls the decision. They had DIFFERENT guards — the approver
 * side was hardened and the repo side checked only the file's mode bits — which
 * is the divergence this module exists to make impossible. The guard lives here
 * ONCE; a caller supplies only the words its operator needs to read.
 *
 * The home is `src/providers/` because it is the neutral one: `src/pr/`
 * importing `src/fleet/` (or the reverse) would be a dependency edge between two
 * peer subsystems for a filesystem check that belongs to neither.
 *
 * FAIL CLOSED. Every arm below is a refusal. Nothing here returns a permissive
 * default, and a caller that receives a refusal must not read the file — the
 * whole point is that the bytes have not been proven trustworthy.
 *
 * WHAT THIS PROVES, and what it does not: it proves that at the moment of the
 * `stat` calls, no account other than the caller (or root) could replace the
 * file or any directory on the path to it. It does NOT close the stat→read
 * TOCTOU. Removing every attacker-writable directory on the chain removes the
 * ordinary route to swapping the path between the two calls, but a race against
 * a legitimately-writable directory remains, and closing it would need an fd
 * held across both calls.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** A refusal that names the guard that fired. Never carries file CONTENT. */
export interface GuardedFileRefusal {
  code: string;
  message: string;
  remediation: string;
}

export type GuardedFileRead =
  | { ok: true; path: string; text: string }
  | { ok: false; path: string; refusal: GuardedFileRefusal };

/**
 * The caller-supplied words. Deliberately prose, not policy: every guard's
 * THRESHOLD is fixed here (0600, no group/world write on any ancestor,
 * self-or-root owned, regular file, under `hostRoot`) so no caller can weaken
 * one. All a caller chooses is what its operator is told.
 */
export interface GuardedFileSpec {
  /**
   * Refusal codes are `${codePrefix}-path|-dir-mode|-owner|-unreadable|-mode`.
   * These are pinned by callers' tests and by operator runbooks — treat a
   * change to one as a breaking change.
   */
  codePrefix: string;
  /** The noun in messages, e.g. `"approver allowlist"`. Lower case, no article. */
  label: string;
  /** Named in the containment remediation so the operator sees the sane value. */
  defaultFile: string;
  /** What a correct file holds, e.g. `"mapping each approverId to its {salt, hash}"`. */
  contentHint: string;
  /** What happens without one, e.g. `"every decision is refused"`. */
  consequence: string;
}

/**
 * Resolve, guard and read a security-deciding file under `hostRoot`.
 *
 * The order is load-bearing at two points and both are documented at the arm.
 * On success the text is returned with any byte-order mark stripped — the
 * caller parses, and a parse failure is the caller's refusal to classify
 * because only the caller knows the schema.
 */
export function readGuardedFile(hostRoot: string, file: string, spec: GuardedFileSpec): GuardedFileRead {
  const refuse = (path: string, arm: string, message: string, remediation: string): GuardedFileRead => ({
    ok: false,
    path,
    refusal: { code: `${spec.codePrefix}-${arm}`, message, remediation },
  });

  // `resolve(hostRoot, file)` DISCARDS hostRoot when `file` is absolute and
  // honours `../` when it is relative, so without this the caller picks the
  // file it is then trusted against — every guard below would pass, truthfully,
  // about a file the attacker owns. `file` is public API on both callers;
  // containment is the constraint that was never written down.
  //
  // Lexical, not `realpathSync`: the ancestor walk below already refuses the
  // writable directory a hostile symlink would have to be planted in, and
  // resolving would add its own ENOENT/ELOOP failure modes to a check whose
  // whole job is to be unambiguous.
  const root = resolve(hostRoot);
  const path = resolve(root, file);
  const prefix = root.endsWith(sep) ? root : root + sep; // `/` resolves to `/`
  if (!path.startsWith(prefix)) {
    return refuse(
      path,
      "path",
      `the ${spec.label} path ${path} is outside ${root}`,
      `pass a path under ${root} (the default is ${spec.defaultFile}) — a file the caller can point anywhere is one the caller writes`,
    );
  }

  // The DIRECTORIES are judged first, because a mode check on a file inside an
  // attacker-writable directory proves nothing about the file you will read.
  //
  // The file check below states the threat as "a file another account can
  // EXTEND" — and the cheapest way to extend one you cannot write is to replace
  // it through the parent: `mv evil.json .factory/repos.json` lands a perfectly
  // 0600, perfectly schema-valid allowlist naming the attacker's own repository.
  // Both file checks below pass, and they authorize the push.
  //
  // EVERY ancestor up to and including hostRoot, not just `dirname(path)`: the
  // same replacement works one level up and yields an equally perfect file —
  // `mv .factory /tmp/x && mkdir -m 700 .factory && install -m 600 evil.json
  // .factory/repos.json` needs only a writable hostRoot, which is exactly what a
  // CI scratch dir, a /tmp workspace or a 0777 shared directory is. A chain is
  // only as trustworthy as its loosest link. The walk STOPS at hostRoot: above
  // it is the operator's own filesystem layout, and refusing because `/tmp` is
  // 1777 would refuse every correct temp-rooted invocation.
  //
  // WRITE, not read, is the bit that matters (`0o022`, not an exact 0700).
  // Replacement is a write; requiring 0700 exactly would refuse the ordinary
  // group-readable 0750 deployment, and a control that refuses correct setups is
  // one an operator turns off — strictly worse than one drawn at the bit the
  // attack actually needs. The precedent for asserting a directory's posture at
  // all is RunRecordStore's, which refuses to start on a directory it cannot
  // prove is 0700.
  //
  // OWNERSHIP is the other half. Mode bits say who ELSE may write; they say
  // nothing about who does. Running as root — a container entrypoint, a systemd
  // unit — a 0700 directory and a 0600 file wholly owned by an unprivileged
  // local uid read straight through, because root ignores the bits it is being
  // shown. Self-owned or root-owned are both accepted: a 0-owned config read by
  // a non-root process is the ordinary packaged deployment.
  //
  // `process.getuid?.()` rather than `process.getuid()`: on a platform without
  // it the ownership half degrades to mode-only rather than throwing. A guard
  // that crashes the process it protects is not a guard.
  const self = process.getuid?.();
  const ownedElsewhere = (uid: number): boolean => self !== undefined && uid !== self && uid !== 0;
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    let dirSt: ReturnType<typeof statSync>;
    try {
      dirSt = statSync(dir);
    } catch (e) {
      return refuse(
        path,
        "dir-mode",
        `a directory on the path to the ${spec.label} (${dir}) could not be read: ${(e as Error).message}`,
        `create ${dir} with mode 0700 — with no readable directory, ${spec.consequence}`,
      );
    }
    if ((dirSt.mode & 0o022) !== 0) {
      return refuse(
        path,
        "dir-mode",
        `a directory on the path to the ${spec.label} (${dir}) has mode ${(dirSt.mode & 0o777).toString(8)}; it must not be group- or world-writable`,
        `chmod go-w ${dir} and re-run — a writable directory anywhere above the ${spec.label} lets another account REPLACE it wholesale, whatever mode the file itself carries`,
      );
    }
    if (ownedElsewhere(dirSt.uid)) {
      return refuse(
        path,
        "owner",
        `a directory on the path to the ${spec.label} (${dir}) is owned by uid ${dirSt.uid}, not by uid ${self} or root`,
        `chown ${self} ${dir} and re-run — its owner may replace the ${spec.label} at will, and mode bits do not restrain the account that owns the directory`,
      );
    }
    // Containment above guarantees `root` is on this chain; the second arm is
    // the belt-and-braces stop at `/` if that ever stops being true.
    if (dir === root || dirname(dir) === dir) break;
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    return refuse(
      path,
      "unreadable",
      `${spec.label} ${path} could not be read: ${(e as Error).message}`,
      `create ${path} with mode 0600 ${spec.contentHint} — with no readable file, ${spec.consequence}`,
    );
  }
  // The TYPE is checked before the mode, because a mode is the one thing a
  // non-file happily reports: `statSync` on a fifo returns 0600 as readily as a
  // regular file does, the mode guard passes, and `readFileSync` on a fifo with
  // no writer then blocks FOREVER — the one malformed-config case that parks the
  // process instead of refusing. There is no timeout on this read and there
  // should not need to be one. Reordering these two arms reintroduces the hang.
  if (!st.isFile()) {
    return refuse(
      path,
      "unreadable",
      `${spec.label} ${path} is not a regular file`,
      `make ${path} a regular file with mode 0600 — a directory, device or fifo at that path is refused, never read`,
    );
  }
  // The mode is checked BEFORE the content is read: a world- or group-readable
  // file is one anybody on the host can EXTEND, and reading it first would let
  // an entry planted that way decide the outcome.
  if ((st.mode & 0o077) !== 0) {
    return refuse(
      path,
      "mode",
      `${spec.label} ${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`,
      `chmod 600 ${path} and re-run — a group- or world-readable file is one another account can extend`,
    );
  }
  if (ownedElsewhere(st.uid)) {
    return refuse(
      path,
      "owner",
      `${spec.label} ${path} is owned by uid ${st.uid}, not by uid ${self} or root`,
      `chown ${self} ${path} and re-run — 0600 restrains everyone except the file's owner and root, so a file somebody else owns is one somebody else decides`,
    );
  }

  // The READ is separate from the PARSE, because their remediations point
  // somewhere different: an EISDIR/EACCES/EIO here means the file was never
  // read, and "fix the JSON in it" is advice about content nobody has seen.
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return refuse(
      path,
      "unreadable",
      `${spec.label} ${path} could not be read: ${(e as Error).message}`,
      `make ${path} a readable regular file with mode 0600 — with no readable file, ${spec.consequence}`,
    );
  }

  // The BOM strip is here rather than in each caller's parse: an editor-written
  // config with a byte-order mark is a `JSON.parse` failure that reads to an
  // operator as corruption, and both callers had their own identical copy.
  return { ok: true, path, text: raw.replace(/^﻿/, "") };
}
