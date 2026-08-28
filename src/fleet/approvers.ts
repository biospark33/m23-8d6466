/**
 * The approver allowlist and decision authentication (Story DF3.4, AC2/AC4).
 *
 * `.factory/approvers.json` maps an `approverId` to a SALTED HASH of that
 * approver's token. It is re-read on every decision — there is no cache and no
 * module-level state — so a rotated or removed entry takes effect on the next
 * invocation rather than on the next restart (INV-APPROVE-2).
 *
 * FAIL CLOSED (INV-APPROVE-3). Absent, unreadable, unparseable, schema-invalid,
 * or a mode wider than 0600: every decision is refused. An EMPTY allowlist
 * authorizes NOBODY — the control never degrades to "allow all" and never to
 * "allow the local user". Every arm below returns a refusal; none returns a
 * permissive default, and there is no `?? {}` anywhere in the read path.
 *
 * EVERY refusal this module produces is the CLI's exit **5**: "refused before
 * provisioning, the payload code names the guard, nothing was mutated"
 * (scripts/fleet.ts's header table). Not 2 — 2's default remediation is the
 * verb's flag list, and a flag list is not the remediation for a bad token, an
 * unreadable allowlist or a loose mode. The verb maps it; this module does not
 * import `FleetError`, because `dispatch.ts` owns that class and pulling it in
 * for a value-typed refusal would tie the allowlist to the CLI's error class
 * for nothing.
 *
 * The token comes from STDIN ONLY — never argv (it would show in `ps`, DF2.3
 * INV-CRED-3) and never `process.env` (an env-resident token is inherited by
 * every child the process spawns). It is held for one call and never written
 * anywhere: nothing here logs, and no refusal message or remediation
 * interpolates the presented token.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { fstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_APPROVERS_FILE = ".factory/approvers.json";

/**
 * A token is tens of bytes; 4 KiB covers a long opaque one with room to spare
 * and refuses a runaway producer immediately. The brief cap next door is 64 KiB
 * because a brief is a document — a token is not, and inheriting that constant
 * would mean reading 16× more of whatever is on the other end of the pipe
 * before saying no.
 */
export const MAX_TOKEN_BYTES = 4096;

/**
 * The token is already in the caller's hand when the verb is invoked — pasted,
 * redirected from a file, or piped from a secret manager. The brief reader's
 * 120 s budget exists for a producer STREAMING a document; a writer that has
 * not produced a token within ten seconds is not going to, and the operator
 * should get the refusal rather than a hung terminal.
 */
export const TOKEN_STDIN_TIMEOUT_MS = 10_000;

/** A refusal that names the guard that fired. Never carries the token. */
export interface ApproverRefusal {
  code: string;
  message: string;
  remediation: string;
}

export type ApproverAuth = { ok: true; approverId: string } | { ok: false; refusal: ApproverRefusal };
export type TokenRead = { ok: true; token: string } | { ok: false; refusal: ApproverRefusal };

const EntrySchema = z
  .object({
    salt: z.string().min(1),
    /** Lower-case hex sha256. The shape is pinned so a truncated or
     * base64-shaped hash is a schema refusal, not a comparison that can never
     * match and reads as a wrong token. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const ApproversFileSchema = z
  .object({ version: z.literal(1), approvers: z.record(z.string(), EntrySchema) })
  .strict();

/**
 * Constant-time string equality.
 *
 * sha256 BOTH sides, then compare the fixed 32-byte digests — so the length
 * never leaks. `timingSafeEqual` throws `RangeError` on unequal-length buffers,
 * and the obvious repair (return early when the lengths differ) puts the length
 * back into the timing and into the control flow. Digesting first removes the
 * question: every comparison is 32 bytes.
 *
 * Written here rather than imported: the only other copy in the repo is
 * `visualizer/server/auth.ts`'s, and `src/fleet/` importing from `visualizer/`
 * is the wrong dependency direction.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * The stored form of a token: `sha256(salt ":" token)`, lower-case hex.
 *
 * The separator is load-bearing. Concatenated bare, `("ab", "c")` and
 * `("a", "bc")` hash identically, so a chosen approver id could be enrolled
 * with a salt that makes a different approver's token validate.
 *
 * Exported because enrollment and the test fixtures need the ONE formula the
 * factory actually verifies against — a second copy computed by hand is how the
 * stored hashes and the check drift apart.
 */
export function hashToken(salt: string, token: string): string {
  return createHash("sha256").update(`${salt}:${token}`, "utf8").digest("hex");
}

/**
 * Read and validate the allowlist, then authenticate one `approverId` against
 * it. Every failure is the same posture: no decision is authorized.
 *
 * ponytail: an unknown `approverId` short-circuits before any hash is computed,
 * so the refusal is measurably faster than a wrong token's. That is not a leak
 * worth a dummy compare here — the allowlist is host-local and 0600, so anyone
 * who can reach this code path can already `cat` the id list. Add the dummy
 * compare if this ever answers a remote caller.
 */
export function authenticateApprover(
  hostRoot: string,
  approverId: string,
  token: string,
  file = DEFAULT_APPROVERS_FILE,
): ApproverAuth {
  const path = resolve(hostRoot, file);
  const refuse = (code: string, message: string, remediation: string): ApproverAuth => ({
    ok: false,
    refusal: { code, message, remediation },
  });

  // The DIRECTORY is judged first, because a mode check on a file inside an
  // attacker-writable directory proves nothing about the file you will read.
  //
  // The file check below states the threat as "an allowlist another account can
  // EXTEND" — and the cheapest way to extend one you cannot write is to replace
  // it through the parent: `mv evil.json .factory/approvers.json` lands a
  // perfectly 0600, perfectly schema-valid allowlist enrolling the attacker's
  // own {salt, hash}. Both checks below pass and they authorize PRs.
  //
  // WRITE, not read, is the bit that matters (`0o022`, not an exact 0700).
  // Replacement is a write; requiring 0700 exactly would refuse the ordinary
  // group-readable 0750 deployment, and a control that refuses correct setups
  // is one an operator turns off — strictly worse than one drawn at the bit the
  // attack actually needs. The precedent for asserting a directory's posture at
  // all is RunRecordStore's (run-record.ts:818-822), which refuses to start on
  // a directory it cannot prove is 0700.
  //
  // This NARROWS the stat→read TOCTOU below; it does not close it. A directory
  // an attacker can already write is the precondition for swapping the path
  // between the two calls, so removing that removes the ordinary route — but a
  // race against a legitimately-writable directory remains, and closing it
  // would need an fd held across both calls.
  const dir = dirname(path);
  let dirSt: ReturnType<typeof statSync>;
  try {
    dirSt = statSync(dir);
  } catch (e) {
    return refuse(
      "approver-allowlist-dir-mode",
      `the directory holding the approver allowlist (${dir}) could not be read: ${(e as Error).message}`,
      `create ${dir} with mode 0700 — with no readable directory, every decision is refused`,
    );
  }
  if ((dirSt.mode & 0o022) !== 0) {
    return refuse(
      "approver-allowlist-dir-mode",
      `the directory holding the approver allowlist (${dir}) has mode ${(dirSt.mode & 0o777).toString(8)}; it must not be group- or world-writable`,
      `chmod go-w ${dir} and re-run — a writable directory lets another account REPLACE the allowlist wholesale, whatever mode the file itself carries`,
    );
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    return refuse(
      "approver-allowlist-unreadable",
      `approver allowlist ${path} could not be read: ${(e as Error).message}`,
      `create ${path} with mode 0600 mapping each approverId to its {salt, hash} — with no allowlist, every decision is refused`,
    );
  }
  // The mode is checked BEFORE the content is read, exactly as the repo
  // allowlist does it (src/pr/repos.ts:102-109): a world- or group-readable
  // allowlist is one anybody on the host can EXTEND, and reading it first would
  // let an entry planted that way decide who may approve.
  if ((st.mode & 0o077) !== 0) {
    return refuse(
      "approver-allowlist-mode",
      `approver allowlist ${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`,
      `chmod 600 ${path} and re-run — a group- or world-readable allowlist is one another account can extend`,
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
      "approver-allowlist-unreadable",
      `approver allowlist ${path} could not be read: ${(e as Error).message}`,
      `make ${path} a readable regular file with mode 0600 — with no readable allowlist, every decision is refused`,
    );
  }

  let parsed: z.output<typeof ApproversFileSchema>;
  try {
    // The BOM strip mirrors the repo allowlist's: an editor-written config with
    // a byte-order mark is a JSON.parse failure that reads as corruption.
    parsed = ApproversFileSchema.parse(JSON.parse(raw.replace(/^﻿/, "")));
  } catch (e) {
    return refuse(
      "approver-allowlist-invalid",
      `approver allowlist ${path} is not a valid allowlist: ${(e as Error).message}`,
      `fix ${path} — it is {"version":1,"approvers":{"<id>":{"salt":"…","hash":"<64 hex>"}}}`,
    );
  }

  // `Object.hasOwn`, not `parsed.approvers[approverId]`: `__proto__`,
  // `constructor` and `toString` are reachable on any object, and an id lookup
  // that resolves one of them would authenticate against a function.
  const entry = Object.hasOwn(parsed.approvers, approverId) ? parsed.approvers[approverId] : undefined;
  if (entry === undefined) {
    return refuse(
      "approver-unknown",
      `${approverId} is not a registered approver in ${path}`,
      `register the approver in ${path}, or submit the decision as one that is already registered`,
    );
  }

  if (!constantTimeEqual(hashToken(entry.salt, token), entry.hash)) {
    // The token is NOT interpolated — not a prefix, not a length. This refusal
    // is the one an attacker gets to read.
    return refuse(
      "approver-token-mismatch",
      `the token presented for ${approverId} does not match the registered hash`,
      "pipe the correct token on stdin — tokens are never passed as flags or environment variables",
    );
  }

  return { ok: true, approverId };
}

/**
 * Was a token actually ATTACHED to `fd`? `null` when it was.
 *
 * THIS TESTS ATTACHMENT — NOT AUTHORIZATION, AND NOT HUMAN PRESENCE.
 * Authorization is the hashed allowlist plus a token held by a person, and
 * nothing else. The fd type is not an authentication factor: refusing a type
 * stops nobody who holds a valid token, because they pipe it through
 * `cat token |` and get a different type. Nor can any fd type prove a human —
 * `cat token | fleet approve` in a cron job is exactly as unattended as a
 * programmatic spawn. So the only honest question this answers is "did the
 * caller deliberately attach something to read?".
 *
 * ALLOW-LIST over a closed set, so an stdio type nobody has thought of yet is
 * refused by default:
 *
 *  - a fifo (`cat token | fleet approve`), a regular file
 *    (`fleet approve … < token`) and a SOCKET are all deliberate attachments.
 *    A socket is what fd 0 is under a Bun/Node parent spawning with
 *    `stdio: "pipe"`, which is how the live harness drives these verbs and how
 *    a DF3.5-generated skill will — refusing it would mean the mandatory
 *    approval demo could not approve at all. It is also what
 *    `assertOneBriefSource` (scripts/fleet.ts:867-879) already decided on this
 *    same repo's same fd-0 question, for the same reason;
 *  - a CHARACTER DEVICE — `/dev/null` (cron, systemd, containers) or a tty (an
 *    operator who typed the verb and redirected nothing) — is the unattended
 *    default: nothing was attached;
 *  - a closed fd 0, where `fstat` raises EBADF — nothing to read.
 *
 * An attached-but-silent writer is NOT this function's problem: it is accepted
 * here and bounded by `readCappedToken`'s stall window, which refuses with
 * `approver-token-stdin-timeout` rather than parking the verb.
 *
 * The test is fd 0's TYPE, never `isTTY`: a CLI run from cron, systemd or a
 * container has stdin on `/dev/null` and no tty, so an `isTTY` check would call
 * that "attached" and then read nothing.
 */
export function assertTokenAttached(fd = 0): ApproverRefusal | null {
  const absent: ApproverRefusal = {
    code: "approver-token-absent",
    message: "no approver token was attached to stdin",
    remediation:
      "pipe the token on stdin (`cat token | fleet approve …`) or redirect it (`fleet approve … < token`) — it is never a flag and never an environment variable",
  };
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(fd);
  } catch {
    return absent; // EBADF — there is no fd 0 at all
  }
  // Allow-list, not "everything except chardev": an stdio type nobody has
  // thought of yet lands on the `absent` default rather than being read.
  if (st.isFIFO() || st.isFile() || st.isSocket()) return null;
  return absent;
}

/**
 * Read a token off `stream`, refusing AS IT STREAMS.
 *
 * The cap is enforced per chunk rather than after the read, so a producer
 * pointed at this verb cannot buffer unbounded bytes into the process before
 * being refused. Each read — including the FIRST, and the one waiting for EOF
 * after the last chunk — races the stall window, so a writer that holds the
 * pipe open and never closes it is refused instead of parking the verb forever.
 * The reader is CANCELLED on every refusal path: an abandoned read must not
 * keep the stream open behind the refusal.
 */
export async function readCappedToken(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = TOKEN_STDIN_TIMEOUT_MS,
): Promise<TokenRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), timeoutMs);
      });
      let res: Awaited<ReturnType<typeof reader.read>> | "timeout";
      try {
        res = await Promise.race([reader.read(), stall]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (res === "timeout") {
        return {
          ok: false,
          refusal: {
            code: "approver-token-stdin-timeout",
            message: `no approver token arrived on stdin within ${timeoutMs} ms`,
            remediation: "the writer holding this pipe's write end never closed it — close it, or redirect the token from a file",
          },
        };
      }
      if (res.done) break;
      bytes += res.value.byteLength;
      if (bytes > MAX_TOKEN_BYTES) {
        return {
          ok: false,
          refusal: {
            code: "approver-token-too-large",
            message: `the approver token exceeds the ${MAX_TOKEN_BYTES} byte cap`,
            remediation: "stdin is for the token alone — check that a file or a stream was not redirected onto it by mistake",
          },
        };
      }
      chunks.push(res.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  // `.trim()`, the shape `readHostToken` already uses: a redirected file and a
  // heredoc both arrive with a trailing newline, and nobody's token has
  // significant surrounding whitespace.
  const token = new TextDecoder().decode(Buffer.concat(chunks)).trim();
  if (token === "") {
    return {
      ok: false,
      refusal: {
        code: "approver-token-absent",
        message: "stdin was attached but carried no approver token",
        remediation: "write the token to stdin — an empty stdin is not an empty token, it is a missing one",
      },
    };
  }
  return { ok: true, token };
}

/** The two halves above over the real fd 0. */
export async function readTokenFromStdin(): Promise<TokenRead> {
  const absent = assertTokenAttached(0);
  if (absent !== null) return { ok: false, refusal: absent };
  return readCappedToken(Bun.stdin.stream());
}

/**
 * The whole flow a decision verb needs: read the allowlist, read the token off
 * stdin, authenticate. Returns the `approverId` to attribute the decision to,
 * or the one refusal that fired — always exit 5, nothing mutated.
 */
export async function authenticateFromStdin(
  hostRoot: string,
  approverId: string,
  file = DEFAULT_APPROVERS_FILE,
): Promise<ApproverAuth> {
  const read = await readTokenFromStdin();
  if (!read.ok) return { ok: false, refusal: read.refusal };
  return authenticateApprover(hostRoot, approverId, read.token, file);
}
