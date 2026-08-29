/**
 * The approver allowlist and decision authentication (Story DF3.4, AC2/AC4).
 *
 * `.factory/approvers.json` maps an `approverId` to a SALTED HASH of that
 * approver's token. It is re-read on every decision — there is no cache and no
 * module-level state — so a rotated or removed entry takes effect on the next
 * invocation rather than on the next restart (INV-APPROVE-2).
 *
 * FAIL CLOSED (INV-APPROVE-3). Absent, unreadable, not a regular file,
 * unparseable, schema-invalid, owned by another account, reached through a
 * group- or world-writable ancestor, outside `hostRoot`, or a mode wider than
 * 0600: every decision is refused. An EMPTY allowlist
 * authorizes NOBODY — the control never degrades to "allow all" and never to
 * "allow the local user". Every arm below returns a refusal; none returns a
 * permissive default, and there is no `?? {}` anywhere in the read path.
 *
 * The PATH guard itself is not here. Containment, the ancestor walk, ownership,
 * the regular-file check, the mode and the read are
 * `src/providers/allowlist-path.ts`'s `readGuardedFile`, shared with
 * `src/pr/repos.ts` — two allowlists that decide things an attacker wants to
 * decide, and that had already drifted apart when each kept its own copy. Only
 * the SCHEMA is this module's, because only this module knows it.
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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readGuardedFile } from "../providers/allowlist-path.ts";

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

/**
 * An approver entry: scrypt, with its OWN cost parameters stored beside the hash.
 *
 * `v: 2`, not 1, because a v1 shape briefly existed during DF3.4's own
 * development: a single-round `sha256(salt ":" token)` with no work factor.
 * It NEVER SHIPPED — this module reached neither `dev` nor `main` before the
 * scrypt form landed — so there is no allowlist anywhere to be compatible with,
 * and the read path accepts exactly ONE shape. A deprecation path for a format
 * that never existed in production is dead code that only ever has to be
 * deleted later. The version number is kept anyway: it costs nothing, and an
 * entry that states which KDF produced it is what makes the NEXT change a
 * migration instead of a guess.
 *
 * The parameters are DATA, not constants read from this file at verify time.
 * That is the whole point of versioning the entry: raising the cost later must
 * not invalidate everything enrolled at the old cost, so verification recomputes
 * with the parameters the entry was written with, and only NEW enrolments pick
 * up the new defaults. A build that hard-coded today's N would silently fail to
 * verify every entry written by tomorrow's.
 *
 * Bounded on both sides. A floor because an entry claiming `N: 2` is a work
 * factor of nothing wearing a v2 label — an attacker who can write the allowlist
 * can already do worse, but an operator hand-editing one should not be able to
 * disable the KDF by accident. A ceiling because `scryptSync` allocates roughly
 * `128 * N * r` bytes: an entry claiming `N: 2^30` is a 137 GB allocation on the
 * verify path, i.e. a denial of service written into a config file.
 */
const V2EntrySchema = z
  .object({
    v: z.literal(2),
    salt: z.string().min(1),
    /** Lower-case hex, 32 bytes — `KEY_LEN` below. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Must be a power of two; `scryptSync` throws otherwise, and a throw on
     * the verify path is a refusal an operator cannot read. */
    N: z
      .number()
      .int()
      .min(1 << 12)
      .max(1 << 20)
      .refine((n) => (n & (n - 1)) === 0, { message: "N must be a power of two" }),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
  })
  .strict();

const EntrySchema = V2EntrySchema;
type ApproverEntry = z.output<typeof EntrySchema>;

const ApproversFileSchema = z
  .object({
    version: z.literal(1),
    /** The KEY is constrained too. `z.string()` bare admits `""`, and an empty
     * id is an id `Object.hasOwn` finds: `{"": {...}}` authenticates a caller
     * that presented no approver at all, and the decision is then written with
     * `approverId: ""`, which DF5.2 refuses forever as `approval-incomplete`.
     * Refusing it at enrollment is where the operator can still fix it. */
    approvers: z.record(z.string().min(1), EntrySchema),
  })
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
 * The v2 cost parameters NEW enrolments are written with (DF3.4 deferred D9).
 *
 * `N = 2^15, r = 8, p = 1` is roughly 100 ms and 32 MiB per verification on a
 * 2026 laptop. The budget is set by what this path actually is: ONE verification
 * per `fleet approve`, invoked by a human. 100 ms is invisible there and is four
 * to five orders of magnitude more expensive per guess than the single sha256
 * round it replaces. It is deliberately NOT tuned for a login endpoint under
 * load, because this is not one — if the allowlist ever answers a remote caller,
 * re-cost it and raise the default, which is exactly the change the per-entry
 * parameters make survivable.
 */
export const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
/** 32 bytes, matching the sha256 digest width `constantTimeEqual` compares. */
const KEY_LEN = 32;

/**
 * The v2 stored form: `scrypt(token, salt, params)`, lower-case hex.
 *
 * The salt goes in as scrypt's OWN salt parameter rather than being concatenated
 * into the password, which removes a hazard the deleted sha256 form needed a
 * separator to guard against: concatenated bare, `("ab","c")` and `("a","bc")`
 * hash identically, so a chosen approver id could be enrolled with a salt that
 * makes a DIFFERENT approver's token validate. scrypt takes the two as distinct
 * arguments, so that ambiguity is structurally impossible rather than fixed by
 * a `:` somebody has to remember to keep.
 *
 * `scryptSync`, not the callback form: this runs once per decision on a path
 * that is already synchronous end to end, and the async form would make
 * `authenticateApprover` — a pure, synchronous, value-returning function with
 * two callers — infectiously async for no benefit a human-paced verb can
 * observe.
 */
export function scryptToken(salt: string, token: string, params: { N: number; r: number; p: number } = SCRYPT_PARAMS): string {
  // `maxmem` must be raised in step with N·r: node's default is 32 MiB and
  // `128 * N * r` at the defaults is exactly 32 MiB, which the check rejects as
  // "memory limit exceeded" for being at the boundary rather than under it.
  const maxmem = 256 * params.N * params.r;
  return scryptSync(token, salt, KEY_LEN, { ...params, maxmem }).toString("hex");
}

/**
 * Mint an approver token and the entry that verifies it.
 *
 * THIS IS THE ENFORCEMENT, and it is the reason D9's stated remedy ("require a
 * minimum entropy at enrolment") could not be implemented as written: there was
 * no enrolment path at all — nothing in `src/` or `scripts/` ever wrote this
 * file — and a minimum LENGTH check on an operator-supplied token would not have
 * been the property anyway. Length is not entropy: `correct horse battery
 * staple` passes any length rule a human would write and is still guessable.
 * Entropy cannot be measured from a string; it can only be GUARANTEED by
 * generating one. So the factory generates it.
 *
 * 32 bytes from `randomBytes` is 256 bits, rendered base64url so it survives a
 * copy-paste, a shell variable and a heredoc without quoting hazards. The
 * plaintext is RETURNED, never stored, never logged: the caller shows it to the
 * operator exactly once and the allowlist keeps only the scrypt hash.
 */
export function mintApproverToken(): { token: string; entry: z.output<typeof V2EntrySchema> } {
  const token = randomBytes(32).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  return { token, entry: { v: 2, salt, hash: scryptToken(salt, token), ...SCRYPT_PARAMS } };
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
  const refuse = (code: string, message: string, remediation: string): ApproverAuth => ({
    ok: false,
    refusal: { code, message, remediation },
  });

  // An empty id is refused BEFORE the filesystem is touched, because no arm
  // below can produce a useful answer for it. `""` is a key `Object.hasOwn`
  // finds, so an allowlist carrying one would authenticate a caller that named
  // no approver — and the decision would be written with `approverId: ""`,
  // which DF5.2 refuses forever as `approval-incomplete`. The schema refuses to
  // enrol one; this refuses to present one. Trimmed, because a redirected or
  // shell-expanded `--approver` arrives with whitespace far more often than
  // anybody enrols an id that has some.
  const id = approverId.trim();
  if (id === "") {
    return refuse(
      "approver-id-empty",
      "no approverId was presented — an empty or whitespace-only id names nobody",
      "pass --approver <id> naming an approver registered in the allowlist — a decision must be attributable to somebody",
    );
  }

  // The path guard is `src/providers/allowlist-path.ts`'s, NOT a copy of it.
  // D4 found this module and `src/pr/repos.ts` carrying two guards for one job
  // that had ALREADY diverged — the repo side checked the file's mode and
  // nothing else — so the guard lives in exactly one place and each caller
  // supplies only the words its operator has to read. Containment under
  // `hostRoot`, the ancestor-directory walk, ownership, the regular-file type
  // check, the 0600 mode and the read all happen there, in that order, for the
  // reasons documented at each arm.
  //
  // Every refusal CODE is unchanged by the delegation: the shared callee builds
  // them from `codePrefix`, so `approver-allowlist-path`, `-dir-mode`,
  // `-owner`, `-unreadable` and `-mode` are the same five strings this module
  // emitted before, and `tests/fleet/approvers.test.ts` pins all of them.
  //
  // `approver-allowlist-invalid` stays HERE and is the one guard that could not
  // move: the parse is the caller's, because only this module knows the schema.
  const read = readGuardedFile(hostRoot, file, {
    codePrefix: "approver-allowlist",
    label: "approver allowlist",
    defaultFile: DEFAULT_APPROVERS_FILE,
    contentHint: "mapping each approverId to its {salt, hash}",
    consequence: "every decision is refused",
  });
  if (!read.ok) return { ok: false, refusal: read.refusal };
  // `path` is the RESOLVED, guarded path — the refusals below name the file the
  // guard actually proved, never the caller's unresolved argument.
  const { path, text: raw } = read;

  let parsed: z.output<typeof ApproversFileSchema>;
  try {
    // No BOM strip here: `readGuardedFile` already did it, for both callers, so
    // an editor-written config with a byte-order mark can never reach this
    // parse. A second strip would be a no-op that reads as if it were load-bearing.
    parsed = ApproversFileSchema.parse(JSON.parse(raw));
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
  const entry = Object.hasOwn(parsed.approvers, id) ? parsed.approvers[id] : undefined;
  if (entry === undefined) {
    // Ids are compared CASE-SENSITIVELY. Folding would silently merge `Alice`
    // and `alice` into one authority when an operator deliberately enrolled
    // two, which is a worse failure than a refusal. But an unfolded miss and a
    // genuinely-unknown approver read identically to the operator staring at
    // them, so a near-match is NAMED — the diagnostic, not the decision, is
    // where the case-insensitivity belongs. Disclosing an enrolled id here
    // costs nothing the ponytail note above has not already conceded: anyone on
    // this code path can `cat` the allowlist.
    const near = Object.keys(parsed.approvers).find((k) => k.toLowerCase() === id.toLowerCase());
    return refuse(
      "approver-unknown",
      near === undefined
        ? `${id} is not a registered approver in ${path}`
        : `${id} is not a registered approver in ${path}; ${near} is, and approver ids are compared case-sensitively`,
      `register the approver in ${path}, or submit the decision as one that is already registered`,
    );
  }

  if (!constantTimeEqual(scryptToken(entry.salt, token, { N: entry.N, r: entry.r, p: entry.p }), entry.hash)) {
    // The token is NOT interpolated — not a prefix, not a length. This refusal
    // is the one an attacker gets to read.
    return refuse(
      "approver-token-mismatch",
      `the token presented for ${id} does not match the registered hash`,
      "pipe the correct token on stdin — tokens are never passed as flags or environment variables",
    );
  }

  // The TRIMMED id is what is returned and what the decision is attributed to:
  // it is the one that matched the allowlist, and the caller must not stamp the
  // record with a spelling the allowlist never contained.
  return { ok: true, approverId: id };
}

export type ApproverEnrolment =
  | { ok: true; approverId: string; token: string; path: string; replaced: boolean }
  | { ok: false; refusal: ApproverRefusal };

/**
 * Enrol (or rotate) an approver, minting the token this factory will verify.
 *
 * The WRITER this module never had. D9's finding was that nothing enforced the
 * "tokens are high-entropy and machine-minted" assumption the LOW severity
 * rating depends on — and the reason nothing enforced it is that nothing minted
 * them: the allowlist was hand-authored JSON, so the assumption was a sentence
 * in a comment. It is now a code path.
 *
 * READS THROUGH THE SAME GUARD IT WILL WRITE THROUGH. An enrolment that skipped
 * the ancestor walk would happily merge the attacker's existing entries into the
 * file it then writes back, laundering them through a trusted verb — so the read
 * is `readGuardedFile`'s, exactly as `authenticateApprover`'s is.
 *
 * The ONE arm that is not simply "propagate the refusal" is a file that does not
 * exist yet, which is the first enrolment on a host and must obviously work. It
 * is distinguished by STATTING the resolved path rather than by trusting the
 * code: `-unreadable` also covers EACCES and EIO, and treating those as "absent,
 * start fresh" would silently replace an allowlist this process could not read.
 * The directory guards have already run and passed by the time that arm is
 * reached, so the fresh file lands somewhere the walk approved.
 *
 * The write is ATOMIC and 0600 from birth: `openSync(…, "wx", 0o600)` on a temp
 * in the SAME directory, then `renameSync`. A `writeFileSync` straight onto the
 * live path would leave a window in which the allowlist is truncated — during
 * which every decision on this host is refused — and `mode` on `writeFileSync`
 * is masked by umask, so it can land 0644 on a default-umask host and re-open
 * the exact hole the read-side mode guard exists to close.
 */
export function enrolApprover(
  hostRoot: string,
  approverId: string,
  file = DEFAULT_APPROVERS_FILE,
  opts: { rotate?: boolean } = {},
): ApproverEnrolment {
  const refuse = (code: string, message: string, remediation: string): ApproverEnrolment => ({
    ok: false,
    refusal: { code, message, remediation },
  });
  const id = approverId.trim();
  if (id === "") {
    return refuse(
      "approver-id-empty",
      "no approverId was given — an empty or whitespace-only id names nobody",
      "pass --approver <id> naming the approver to enrol",
    );
  }

  const read = readGuardedFile(hostRoot, file, {
    codePrefix: "approver-allowlist",
    label: "approver allowlist",
    defaultFile: DEFAULT_APPROVERS_FILE,
    contentHint: "mapping each approverId to its {salt, hash}",
    consequence: "every decision is refused",
  });
  let approvers: Record<string, ApproverEntry> = {};
  const path = read.ok ? read.path : read.path;
  if (read.ok) {
    try {
      approvers = { ...ApproversFileSchema.parse(JSON.parse(read.text)).approvers };
    } catch (e) {
      // Deliberately NOT "start fresh". An unparseable allowlist may hold
      // entries this verb cannot see, and overwriting it would silently revoke
      // every approver on the host.
      return refuse(
        "approver-allowlist-invalid",
        `approver allowlist ${path} is not a valid allowlist: ${(e as Error).message}`,
        `fix ${path} by hand before enrolling — it is {"version":1,"approvers":{"<id>":{…}}}, and enrolling into a file this verb cannot parse would drop every entry it cannot see`,
      );
    }
  } else if (!(read.refusal.code === "approver-allowlist-unreadable" && !existsSync(path))) {
    return { ok: false, refusal: read.refusal };
  }

  const replaced = Object.hasOwn(approvers, id);
  if (replaced && opts.rotate !== true) {
    // A silent overwrite would invalidate a working token with no warning, and
    // the operator would discover it the next time a decision was refused.
    return refuse(
      "approver-already-enrolled",
      `${id} is already enrolled in ${path}`,
      "pass --rotate to mint a NEW token for this approver — their current one stops working immediately",
    );
  }

  const { token, entry } = mintApproverToken();
  approvers[id] = entry;
  const dir = dirname(path);
  // The temp rides in the SAME directory, so the rename is atomic (a rename
  // across filesystems is a copy, and a copy is not).
  const tmp = join(dir, `.approvers.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ version: 1, approvers }, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort: the refusal below is the operator-facing outcome
    }
    return refuse(
      "approver-allowlist-unwritable",
      `could not write the approver allowlist ${path}: ${(e as Error).message}`,
      `check that ${dir} exists, is 0700 and is owned by this account — nothing was changed`,
    );
  }
  return { ok: true, approverId: id, token, path, replaced };
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
 *
 * TWO budgets, because the stall window alone bounds only a SILENT writer. It
 * is recreated per read and cleared on every successful one, so a drip feeder
 * resets it with each byte: `while :; do printf x; sleep 9; done | fleet
 * approve` never trips a 10 s idle check, and against a 4 KiB cap that parks
 * the verb for roughly ten hours. The deadline is the same budget measured ONCE
 * from the first read — a token is tens of bytes and arrives in one or two
 * chunks, so nothing legitimate needs longer in TOTAL than it needs BETWEEN
 * chunks. Both expire as the same refusal: the operator's move is identical.
 *
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
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      // Whichever budget runs out first wins: `remaining` is the idle window,
      // clamped to what is left of the overall deadline.
      const remaining = Math.max(0, Math.min(timeoutMs, deadline - Date.now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), remaining);
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
            remediation:
              "the writer holding this pipe's write end never closed it, or is feeding bytes slower than that budget — close it, or redirect the token from a file",
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
