/**
 * Versioned pipeline manifest: beneath-root read, closed validation, admission
 * arithmetic (Story DF1.1).
 *
 * ## Which INV-1 form this ships
 *
 * Neither Node nor Bun exposes per-component relative `openat(O_NOFOLLOW)`, so
 * the literal component walk is not implementable in this stack. The shipped
 * mechanism is the permitted equivalent, in four named steps:
 *
 *   1. `fs.realpathSync` the full candidate path (`resolveBeneathRoot`).
 *   2. **Run-root prefix re-assertion** on the resolved result — a path
 *      resolving outside the root is rejected (`assertBeneath`, call site 1).
 *   3. `fs.openSync(..., O_RDONLY | O_NOFOLLOW)` on the resolved path, then
 *      **post-open fd-path verification**: resolve the fd's *own* path
 *      (`fdRealPath` — `/proc/self/fd/<fd>` on Linux, `fcntl(F_GETPATH)` via
 *      `bun:ffi` on darwin) and re-assert the prefix on it (`assertBeneath`,
 *      call site 2) plus equality with the path we resolved. This is what
 *      closes the resolve-to-open window that prefix re-assertion alone leaves
 *      open: an attacker who swaps an intermediate directory *after* the
 *      `realpath` and *before* the `open` lands the fd on a different file, and
 *      the fd's own path proves it.
 *   4. Every read goes **through that descriptor** (`fs.readFileSync(fd)`); the
 *      path string is never re-opened afterwards.
 *
 * Where step 3's fd-path resolution is unavailable on the running platform, the
 * read is refused (INV-5 fail-closed) — never a degrade to bare `O_NOFOLLOW`,
 * never to `lstat` + `open`.
 */
import { FFIType, dlopen, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_MAX_DURATION_MS,
  MANIFEST_VERSION,
  MAX_MAX_DURATION_MS,
  MAX_RETRIES,
  MIN_PHASES,
  MANIFEST_MAX_BYTES,
  MANIFEST_MAX_DEPTH,
  MIN_RETRIES,
  PARSE_FIX_ATTEMPTS,
  PIPELINE_ID_PATTERN,
  ROUTING_MARGIN_MS,
  type PhaseKind,
  type PipelineManifest,
  descriptionDefect,
  formatZodIssue,
  sanitizeForMessage,
} from "./types.ts";

/** Every load failure is a `ManifestError`; nothing partial escapes the loader. */
export class ManifestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManifestError";
  }
}

/**
 * The invisible set `trim()` cannot see, plus the control characters with no
 * legitimate business in a manifest string (DF1.10 review round 3, C2-2: a
 * phase name or argv element made of ZWSPs satisfied `min(1)` AND the
 * whitespace-only refine, loaded, provisioned a box, and ENOENT'd after spend
 * — the exact after-spend death the blank guard exists to prevent, reached
 * through characters that are not whitespace at all).
 *
 * NARROW, and narrower than brief-schema's `NO_CONTROL_CHARS` doctrine on
 * purpose: this loader refuses only what can HIDE. The three whitespace
 * controls prose legitimately carries (tab, LF, CR — a multi-line
 * description, a `sh -c` argv element) stay admitted; every other C0, DEL,
 * the whole C1 range U+0080-U+009F (whose NEL U+0085 is a line terminator to
 * many log processors — the exact character `sanitizeForMessage`'s own
 * rationale names as escaping duty), and the invisible format characters that
 * defeat review without rendering (SHY, ZWSP, WORD JOINER, BOM, LRM/RLM
 * U+200E/U+200F, U+180E, the invisible math operators U+2061-U+2064, the
 * interlinear annotation marks U+FFF9-U+FFFB, and the Trojan-Source bidi
 * embeddings/overrides U+202A-U+202E, incl. RLO U+202E — invisible AND able
 * to reorder displayed text) are refused outright. Nothing
 * that renders and types is refused, so acceptance narrows by exactly the set
 * no honest manifest can miss.
 *
 * PR #216 round 4 (D2) widened the class: execution-verified review showed the
 * round-3 set still admitted five more families that hide exactly the way C2-2
 * described — LRM/RLM, U+180E, the C1 range (incl. NEL), U+2061-U+2064, and
 * U+FFF9-U+FFFB — and the round-4 widening also takes the Trojan-Source bidi
 * controls U+202A-U+202E from blind review's variant of the finding. The
 * deliberately-admitted tab/LF/CR and the rendering CJK fillers stay out.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const INVISIBLE_OR_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]/;

/**
 * A string with content, not merely length. `z.string().min(1)` accepts `"  "`,
 * so a blank phase `name`, `roster`, `task` or argv element used to load
 * cleanly, be admitted, PROVISION A BOX, and die mid-walk after spend — argv0
 * `"  "` is ENOENT and `loadRoster("   ")` resolves nothing. Same defect class
 * as the empty-positional bug this story fixed in the fake driver: a blank
 * string satisfying a length check and failing at the real boundary. The
 * manifest is the earlier and free boundary.
 *
 * Refuses rather than TRIMS deliberately. `z.string().trim()` is a transform,
 * not a check: it would rewrite the operator's own values (`["  echo"]` →
 * `["echo"]`), turning a manifest that should be refused into one that runs a
 * *different* command — and the loaded manifest is re-serialized and delivered
 * into the box, so the rewrite would travel. Nothing in this loader normalizes
 * manifest content; it only accepts or refuses it.
 */
const nonBlankString = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: "must not be whitespace-only" })
  .refine((s) => !INVISIBLE_OR_CONTROL_RE.test(s), { message: "must not contain control or invisible characters" });

const argv = z.array(nonBlankString).min(1);

/**
 * The kinds `makeBodyFactory` has an executor for — the schema's copy of
 * `PhaseKind`, pinned to it in BOTH directions:
 *
 *   - `satisfies readonly PhaseKind[]` catches a member here that is not a
 *     `PhaseKind`, and
 *   - `_AllKindsExecute` below catches the reverse, which is the direction that
 *     actually bites: a SUBSET always satisfies `readonly PhaseKind[]`, so
 *     adding a third `PhaseKind` with an executor (`makeBodyFactory`'s `never`
 *     check is happy) but forgetting it here would leave `PhaseSpecSchema`
 *     silently REJECTING the new kind at load, with `kindIssueMessage` telling
 *     the operator it is not a kind at all.
 */
const EXECUTING_KINDS = ["code", "dispatch_task"] as const satisfies readonly PhaseKind[];

/** `AssertTrue<false>` is a compile error; `AssertTrue<true>` is inert. */
type AssertTrue<T extends true> = T;
// The tuple wrapper defeats conditional-type distribution, so an empty
// `Exclude` really compares as `never` instead of distributing to it.
// `export`ed for the same reason `envelope-parse.ts` exports its mirror
// tripwire: `noUnusedLocals` deletes an unexported compile-time assertion's
// reason to exist. Absent from `index.ts`, so it is not public surface.
export type _AllKindsExecute = AssertTrue<
  [Exclude<PhaseKind, (typeof EXECUTING_KINDS)[number]>] extends [never] ? true : false
>;

/**
 * DF1.10 C19: what to write INSTEAD of a kind this engine removed.
 *
 * A bare "Invalid enum value. Expected 'code' | 'dispatch_task'" is true and
 * useless — it tells an operator porting an SSSF-shaped manifest that their
 * phase is wrong, not what the replacement is. Both removed kinds have a real
 * destination, and the refusal is the only moment anyone is reading:
 *
 *   - `agent` → `dispatch_task` with a one-role roster. Not a workaround: D5
 *     chose the team runtime over SSSF's single-agent-per-phase model precisely
 *     because roster size 1 is the degenerate case of it.
 *   - `engineer` → nothing in the manifest at all. SSSF's `engineer` phase is a
 *     human-owned provenance log, and human-in-the-loop in QDS is tier-1: the
 *     operator acts on the run from outside it, not by declaring a phase.
 *
 * Anything else is an ordinary closed-set violation and gets the closed set.
 */
const REMOVED_KIND_REMEDIATION: Readonly<Record<string, string>> = {
  agent:
    "kind 'agent' was removed (DF1.10 C19): declare kind 'dispatch_task' with a one-role roster instead — a roster of one is the single-agent case, gated and retried the same way",
  engineer:
    "kind 'engineer' was removed (DF1.10 C19): it was a human-owned provenance log with no executor. Human-in-the-loop is tier-1 and needs no phase — use `fleet approve|reject` after the run, or `fleet attach --message` to steer it mid-run",
};

const KIND_LIST = EXECUTING_KINDS.map((k) => `'${k}'`).join(" | ");

/**
 * The message for a `kind` that IS a string but is not in the closed set.
 *
 * `Object.hasOwn`, not `REMOVED_KIND_REMEDIATION[received] !== undefined`: a
 * plain object literal inherits `Object.prototype`, so `kind: "constructor"`
 * (or `"toString"`, `"valueOf"`, `"hasOwnProperty"`) resolved off the PROTOTYPE
 * and this function returned a **Function** through a `string` return type.
 * Zod then carried it as the issue's `message` and `formatZodIssue`'s
 * `JSON.stringify` of it returned `undefined`, so a load-time refusal escaped
 * the loader as a TypeError rather than as a `ManifestError`.
 */
function kindIssueMessage(received: unknown): string {
  if (typeof received === "string" && Object.hasOwn(REMOVED_KIND_REMEDIATION, received)) {
    return REMOVED_KIND_REMEDIATION[received] as string;
  }
  return `kind must be one of ${KIND_LIST}; got '${sanitizeForMessage(String(received))}'`;
}

export const PhaseSpecSchema = z
  .object({
    name: nonBlankString,
    // The error map, not `superRefine`, carries the remediation: a failed enum
    // parse SKIPS the object-level superRefine entirely, so a check down there
    // would never run for the exact inputs it exists to explain.
    //
    // The two issue codes are NOT the same failure and must not share a
    // message. `invalid_enum_value` carries the offending VALUE, which is what
    // the closed-set/remediation text is about. `invalid_type` carries a zod
    // TYPE NAME, so the old shared path rendered `kind: 7` as "got 'number'"
    // and — worse — an OMITTED `kind` as "got 'undefined'", presenting a
    // missing required field as a closed-set violation.
    kind: z.enum(EXECUTING_KINDS, {
      errorMap: (issue, ctx) => {
        if (issue.code === z.ZodIssueCode.invalid_enum_value) {
          return { message: kindIssueMessage((issue as { received?: unknown }).received) };
        }
        if (issue.code === z.ZodIssueCode.invalid_type) {
          const received = (issue as { received?: unknown }).received;
          return {
            message:
              received === "undefined"
                ? `kind is missing; declare one of ${KIND_LIST}`
                : `kind must be a string, got ${sanitizeForMessage(String(received))}`,
          };
        }
        return { message: ctx.defaultError };
      },
    }),
    description: nonBlankString,
    maxDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_DURATION_MS)
      .default(DEFAULT_MAX_DURATION_MS),
    retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).default(MIN_RETRIES),
    command: argv.optional(),
    /** Optional gate argv — valid only when kind is "code": superRefine
     *  refuses it on every other kind, because only a code phase composes a
     *  commandGate over it (elsewhere it would be silently dead). */
    testCommand: argv.optional(),
    // DF1.6 dispatch_task fields
    roster: nonBlankString.optional(),
    task: nonBlankString.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // `command` is required when kind === "code", forbidden otherwise: it is the
    // only manifest-borne argv source DF1.2's commandGate may use.
    if (spec.kind === "code" && spec.command === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "command is required when kind is 'code'" });
    }
    if (spec.kind !== "code" && spec.command !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `command is forbidden when kind is '${spec.kind}'` });
    }
    // testCommand is optional and valid only when kind === "code" (see its
    // field doc above): elsewhere it is silently dead, so refuse rather than
    // let an author believe it enforced.
    if (spec.kind !== "code" && spec.testCommand !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `testCommand is forbidden when kind is '${spec.kind}'`,
      });
    }
    // DF1.6: roster and task required when kind === "dispatch_task", forbidden otherwise
    if (spec.kind === "dispatch_task") {
      if (spec.roster === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "roster is required when kind is 'dispatch_task'" });
      }
      if (spec.task === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "task is required when kind is 'dispatch_task'" });
      }
    } else {
      if (spec.roster !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `roster is forbidden when kind is '${spec.kind}'` });
      }
      if (spec.task !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task is forbidden when kind is '${spec.kind}'` });
      }
    }
  });

/**
 * `PhaseParams.agent` — the single declared source of the identity DF1.3 keys
 * its session cache on. Closed like the rest of the schema, and enforced at
 * construction rather than left as an interface that erases at runtime.
 */
export const PhaseAgentSchema = z
  .object({
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    contextWindow: z.number().int().positive(),
  })
  .strict();

export const PipelineManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    pipelineId: z.string().regex(PIPELINE_ID_PATTERN, "pipelineId must match ^[a-z][a-z0-9-]{1,63}$"),
    runBudgetMs: z.number().int().positive(),
    // DF3.1 AC9a: stamped by dispatch for box fill. `.max` because
    // `z.number().int()` accepts 1e300 (Number.isInteger is true for it) — a
    // hand-authored manifest could otherwise declare a cap the engine can
    // neither compare against an admitted ceiling nor round-trip as an integer.
    // NOT authoritative to the host, and `loadManifest` deliberately does not
    // strip it: the read path IS the delivery path — the dispatcher stamps,
    // serializes and `fill`s this file into the box, and the in-box engine
    // reads it back through the same loader (round trip pinned by
    // tests/fleet/brief-schema.test.ts). Dropping it on read would make AC9a's
    // delivery a no-op.
    //
    // The enforced ceiling is the DF2.3 key cap recorded as the run record's
    // `limitMicroUsd`; this field is the box's copy of it, never its source.
    // Two readers promote it, and neither takes it on the file's word:
    // `scripts/fleet.ts`'s dispatch calls `stripAuthoredLimit` on the
    // pre-stamp read, and `runContextFrom` in `scripts/pipeline-run.ts` — which
    // turns it into `effectiveCeilingMicros` and so into DF1.6's harness cap —
    // reconciles it against the `effectiveCeilingMicros` dispatch wrote to
    // `run-context.json` beside the manifest, refusing on absence or
    // disagreement. Any future reader owes the same: a stamped cap and an
    // authored one are byte-identical here, so the loader cannot tell them
    // apart and a consumer that skips the reconciliation lets a hand-authored
    // `pipeline.yaml` name its own ceiling.
    limitMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    // DF3.6a: resident bound operands — all five optional BY DESIGN. Hand-
    // authored non-resident manifests omit them; the arm-scoped loader
    // (`loadResidentBounds` in resident-bounds.ts) is the fail-closed
    // required-set check for runs that arm a resident, so a schema default
    // here would make the missing-value refusal unobservable (W14C-PAIR-1): a
    // defaulted operand turns the ordering assertion into a comparison of two
    // constants that can never disagree. The producer side is closed instead —
    // `stampResidentBounds` supplies all four at dispatch fill. No ratio or
    // percentage field exists or may be added (INV-BND-4, R5 §6 fact 12): the
    // ceiling is an absolute integer µ$ value, and `.strict()` below makes an
    // unknown ratio-shaped key a parse rejection, not a tolerated extra.
    // `.max` for the same reason as limitMicroUsd above: `z.number().int()`
    // accepts 1e300, which the engine can neither compare nor round-trip.
    residentSpendCeilingMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    capMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    defaultKeyCapMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    residentRssBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    // 0 is a legal bound (never solicit post_gate_failure); MAX_RETRIES is the
    // structural ceiling the schema already clamps `retries` to, so an
    // iteration bound above it can never fire on a schema-valid manifest.
    maxSteeringIterations: z.number().int().min(0).max(MAX_RETRIES).optional(),
    phases: z.array(PhaseSpecSchema).min(MIN_PHASES, `phaseCount < ${MIN_PHASES}`),
  })
  .strict();

/** INV-4: the manifest carries no credential material. */
const CREDENTIAL_FIELD = /(^|[-_])(api)?(key|token|secret|password|passwd|credential)s?([-_]|$)/i;
const CREDENTIAL_VALUE = [
  // Anchored on a token boundary so ordinary English ("risk-adjusted",
  // "task-local") is not a credential, and case-folded so `bearer` is caught
  // however it happens to be spelled.
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /\bghp_[A-Za-z0-9]{8,}/i,
  /\bbearer\s+\S/i,
  /-----BEGIN [A-Z ]+/,
];

function assertNoCredentials(value: unknown, where = "$", depth = 0): void {
  // A hostile manifest can nest arbitrarily deep; bound the walk rather than let
  // a RangeError escape as something other than a ManifestError.
  if (depth > MANIFEST_MAX_DEPTH) {
    throw new ManifestError(`manifest nests deeper than ${MANIFEST_MAX_DEPTH} levels at ${where}`);
  }
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.some((re) => re.test(value))) {
      throw new ManifestError(`credential-shaped value at ${where} (INV-4)`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentials(v, `${where}[${i}]`, depth + 1));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_FIELD.test(k)) {
        throw new ManifestError(`credential-named field '${sanitizeForMessage(k)}' at ${where} (INV-4)`);
      }
      // Escaped here too, not just at the immediate throw above: `where` is
      // accumulated across the recursion and reused verbatim in every later
      // error message (including the credential-shaped-value throw), so an
      // unescaped key anywhere on the path re-opens the same forging window one
      // level down.
      assertNoCredentials(v, `${where}.${sanitizeForMessage(k)}`, depth + 1);
    }
  }
}

function assertBeneath(rootReal: string, candidate: string, what: string): void {
  const normalized = path.resolve(candidate);
  // A root that already ends in the separator (`/`, or a Windows drive root)
  // would otherwise build a `//` prefix that nothing matches.
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (normalized !== rootReal && !normalized.startsWith(prefix)) {
    throw new ManifestError(`${what} resolves outside the run root: ${normalized} (INV-1)`);
  }
}

/**
 * FIFO-safe realpath: resolves with lstat/readlink only, never open(2).
 *
 * Bun's native `fs.realpathSync` blocks forever on a FIFO planted anywhere on
 * the path (reproduced: macOS, Bun 1.2.22) — the loader's own
 * "refused instead of blocking" promise (the FIFO test) then hangs. This
 * walker is Node's recursive realpath algorithm: parent resolved fully first,
 * symlink targets re-walked from their root, 40-hop ELOOP ceiling.
 */
function realpathNoOpen(input: string): string {
  const walk = (abs: string, depth: number): string => {
    if (depth > 40) {
      throw new Error(`too many levels of symbolic links: ${input}`);
    }
    const parent = path.dirname(abs);
    if (parent === abs) return abs; // reached the filesystem root
    const parentReal = walk(parent, depth);
    const cur = path.join(parentReal, path.basename(abs));
    const st = fs.lstatSync(cur); // ENOENT propagates to the caller's catch
    if (!st.isSymbolicLink()) return cur;
    return walk(path.resolve(parentReal, fs.readlinkSync(cur)), depth + 1);
  };
  return walk(path.resolve(input), 0);
}

/**
 * DF1.2 gate artifact read — the identical four-step walk as the manifest read
 * above (realpath → beneath-root re-assert → `O_NOFOLLOW` open + fd-path
 * verification → read through the descriptor), over any declared artifact
 * beneath the same pinned run root. It lives in this module, beside the
 * primitives it shares (`assertBeneath`, `fdRealPath`), so the gate library
 * never grows a second, weaker resolver (DF1.2 INV-3). `readArtifactBeneathRoot`
 * in `gates/library.ts` is a thin caller; this is the one mechanism.
 *
 * Any refusal — missing artifact, escape outside the root, unavailable
 * fd-path facility — throws; the caller turns that into a failed gate check.
 * Size ceiling reuses `MANIFEST_MAX_BYTES`: gate-examined artifacts are
 * manifests' peers (small JSON evidence), not unbounded logs.
 *
 * F060 — this is the RESOLVER half, and every one of the four steps above
 * completes here, before a single byte is read. Callers that only need the
 * verdict ("does this artifact exist, beneath the root, as a regular file
 * within the ceiling?") stop here and pay nothing for the body;
 * `readArtifactBeneathRoot` below is the thin reader on top.
 *
 * OWNERSHIP: the returned `fd` is OPEN. The caller must `fs.closeSync` it — on
 * every path, including its own throws. Any refusal raised in here closes it
 * first, so a thrown call leaks nothing.
 */
export function resolveArtifactBeneathRoot(
  artifactPath: string,
  runRoot: string,
): { fd: number; resolvedPath: string; size: number } {
  let rootReal: string;
  try {
    rootReal = realpathNoOpen(path.resolve(runRoot));
  } catch (err) {
    throw new ManifestError(`run root is not resolvable: ${runRoot}`, { cause: err });
  }

  let fileReal: string;
  try {
    fileReal = realpathNoOpen(path.resolve(artifactPath));
  } catch (err) {
    throw new ManifestError(`artifact is not resolvable: ${artifactPath}`, { cause: err });
  }
  assertBeneath(rootReal, fileReal, "artifact");

  let fd: number;
  try {
    fd = fs.openSync(
      fileReal,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    throw new ManifestError(`artifact could not be opened: ${fileReal}`, { cause: err });
  }
  let size: number;
  try {
    const openedAs = fdRealPath(fd);
    if (openedAs === null) {
      throw new ManifestError(
        `post-open fd-path verification is unavailable on ${process.platform}; refusing the read (INV-5)`,
      );
    }
    assertBeneath(rootReal, openedAs, "opened artifact descriptor");
    if (path.resolve(openedAs) !== fileReal) {
      throw new ManifestError(
        `artifact path changed between resolution and open: expected ${fileReal}, opened ${openedAs} (INV-1)`,
      );
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ManifestError(`artifact is not a regular file: ${fileReal}`);
    }
    if (stat.size > MANIFEST_MAX_BYTES) {
      throw new ManifestError(
        `artifact is ${stat.size} bytes, above the ${MANIFEST_MAX_BYTES}-byte ceiling`,
      );
    }
    size = stat.size;
  } catch (err) {
    // A refusal owns the descriptor it opened — only a SUCCESSFUL return hands
    // it to the caller.
    fs.closeSync(fd);
    throw err;
  }
  return { fd, resolvedPath: fileReal, size };
}

/**
 * The thin reader on top of `resolveArtifactBeneathRoot`: the whole hardened
 * walk, then the body through the descriptor that walk verified. The path
 * string is never re-opened (INV-1 step 4).
 */
export function readArtifactBeneathRoot(
  artifactPath: string,
  runRoot: string,
): { bytes: Buffer; resolvedPath: string; size: number } {
  const { fd, resolvedPath, size } = resolveArtifactBeneathRoot(artifactPath, runRoot);
  try {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fd);
    } catch (err) {
      throw new ManifestError(`artifact could not be read: ${resolvedPath}`, { cause: err });
    }
    if (bytes.byteLength > MANIFEST_MAX_BYTES) {
      throw new ManifestError(
        `artifact read ${bytes.byteLength} bytes, above the ${MANIFEST_MAX_BYTES}-byte ceiling`,
      );
    }
    return { bytes, resolvedPath, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** darwin `fcntl` command that writes the fd's own path into the supplied buffer. */
const F_GETPATH = 50;

let darwinFcntl: ((fd: number, cmd: number, buf: Uint8Array) => number) | null | undefined;

/**
 * darwin's `proc_pidfdinfo(PROC_PIDFDVNODEPATHINFO)` — the fixed-arity
 * alternative to `fcntl(F_GETPATH)`. `bun:ffi` trampolines are fixed-arity and
 * cannot express `fcntl`'s variadic ABI on arm64 (there the kernel reads the
 * buffer pointer from the variadic save area, which a fixed-arity call never
 * populates, so `F_GETPATH` "succeeds" writing nothing); `proc_pidfdinfo` has
 * no variadic tail and works through the same FFI. Path bytes start at
 * `sizeof(struct vnode_fdinfo)` = 176 in `struct vnode_fdinfowithpath`
 * (verified against the SDK's `sys/proc_info.h`; a probe re-validates the
 * layout at bind time below, so an SDK change degrades to refusal, not to a
 * wrong path).
 */
const PROC_PIDFDVNODEPATHINFO = 2;
const VNODE_PATH_OFFSET = 176;

let darwinProcFdPath:
  | ((pid: number, fd: number, flavor: number, buf: Uint8Array, size: number) => number)
  | null
  | undefined;

/**
 * The fd's own path, or `null` where the running platform cannot supply it.
 * `null` is a refusal (INV-5), never a soft pass.
 */
function fdRealPath(fd: number): string | null {
  if (process.platform === "linux") {
    try {
      const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
      // Linux appends " (deleted)" when the open file has been unlinked; the
      // fd still pins the inode that passed beneath-root verification, so the
      // marker is stripped before the equality/prefix comparisons use the
      // path. A file legitimately NAMED "x (deleted)" that is NOT deleted
      // loses its real suffix to this strip and fails the equality check —
      // a refusal, which is INV-5's fail-closed direction, never a wrong-file
      // pass.
      return link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : link;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const fcntl = loadDarwinFcntl();
    if (fcntl) {
      // The kernel writes a NUL-terminated path of at most PATH_MAX.
      const buf = new Uint8Array(1024);
      try {
        if (fcntl(fd, F_GETPATH, buf) === 0) {
          const end = buf.indexOf(0);
          if (end > 0) return new TextDecoder().decode(buf.subarray(0, end));
        }
      } catch {
        // Fall through to the fixed-arity facility below.
      }
    }
    const procFdPath = loadDarwinProcFdPath();
    if (!procFdPath) return null;
    const buf = new Uint8Array(2048);
    try {
      const rc = procFdPath(process.pid, fd, PROC_PIDFDVNODEPATHINFO, buf, buf.length);
      if (rc <= VNODE_PATH_OFFSET || rc > buf.length) return null;
      const end = buf.indexOf(0, VNODE_PATH_OFFSET);
      if (end <= VNODE_PATH_OFFSET) return null;
      return new TextDecoder().decode(buf.subarray(VNODE_PATH_OFFSET, end));
    } catch {
      return null;
    }
  }
  return null;
}

function loadDarwinFcntl(): ((fd: number, cmd: number, buf: Uint8Array) => number) | null {
  if (darwinFcntl !== undefined) return darwinFcntl;
  try {
    // darwin has no `/proc/self/fd`; `fcntl(fd, F_GETPATH)` is the equivalent
    // facility. If the FFI binding cannot be established the loader fails closed
    // (INV-5) rather than reading through an unverified descriptor.
    const lib = dlopen("libSystem.B.dylib", {
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const bound = (fd: number, cmd: number, buf: Uint8Array) =>
      lib.symbols.fcntl(fd, cmd, ptr(buf)) as number;
    // `fcntl` is variadic, and a fixed-arity FFI trampoline is not the variadic
    // ABI on every architecture (arm64 passes variadic args on the stack). Prove
    // the binding actually works on this machine against a path we already know,
    // rather than trusting whatever bytes come back. A failed probe means the
    // facility is unavailable, which is INV-5's fail-closed case.
    if (probeFcntlPath(bound) !== "/") {
      darwinFcntl = null;
      return null;
    }
    darwinFcntl = bound;
  } catch {
    darwinFcntl = null;
  }
  return darwinFcntl;
}

function probeFcntlPath(bound: (fd: number, cmd: number, buf: Uint8Array) => number): string | null {
  const fd = fs.openSync("/", fs.constants.O_RDONLY);
  try {
    const buf = new Uint8Array(1024);
    if (bound(fd, F_GETPATH, buf) !== 0) return null;
    const end = buf.indexOf(0);
    return end <= 0 ? null : new TextDecoder().decode(buf.subarray(0, end));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function loadDarwinProcFdPath(): ((pid: number, fd: number, flavor: number, buf: Uint8Array, size: number) => number) | null {
  if (darwinProcFdPath !== undefined) return darwinProcFdPath;
  try {
    const lib = dlopen("libSystem.B.dylib", {
      proc_pidfdinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    const bound = (pid: number, fd: number, flavor: number, buf: Uint8Array, size: number) =>
      lib.symbols.proc_pidfdinfo(pid, fd, flavor, ptr(buf), size) as number;
    // Same discipline as the fcntl probe: prove the binding and the struct
    // offset against a path we already know, so a mismatched SDK layout means
    // "facility unavailable" (refusal, INV-5) rather than a wrong path.
    const fd = fs.openSync("/", fs.constants.O_RDONLY);
    try {
      const buf = new Uint8Array(2048);
      const rc = bound(process.pid, fd, PROC_PIDFDVNODEPATHINFO, buf, buf.length);
      if (rc <= VNODE_PATH_OFFSET || rc > buf.length) {
        darwinProcFdPath = null;
        return null;
      }
      const end = buf.indexOf(0, VNODE_PATH_OFFSET);
      if (end <= VNODE_PATH_OFFSET) {
        darwinProcFdPath = null;
        return null;
      }
      const probed = new TextDecoder().decode(buf.subarray(VNODE_PATH_OFFSET, end));
      if (probed !== "/") {
        darwinProcFdPath = null;
        return null;
      }
      darwinProcFdPath = bound;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    darwinProcFdPath = null;
  }
  return darwinProcFdPath;
}

/**
 * Seams the suite needs to exercise INV-1's resolve-to-open window and INV-5's
 * fail-closed branch. Deliberately **not** re-exported from `index.ts`: they can
 * weaken the security invariant, so they must not sit on the package's public
 * surface where any caller could pass them. Tests import this module directly.
 */
export interface ManifestTestSeams {
  /** Replaces the platform fd-path facility. */
  resolveFdPath?: (fd: number) => string | null;
  /** Fired between the `realpath` resolution and the `open`. */
  onResolved?: () => void;
}

export interface LoadedManifest {
  manifest: Readonly<PipelineManifest>;
  /** `manifest_load_ms` for the observability contract. */
  manifestLoadMs: number;
  /**
   * The verified absolute path the manifest was read from — provenance for
   * the exact bytes in `manifest`. Absent when the content was derived in
   * memory rather than read (`stampManifestLimit`), because those bytes match
   * no file on disk.
   */
  resolvedPath?: string;
}

/** Bytes read through a verified descriptor anchored beneath `runRoot`. */
function readBeneathRoot(
  manifestPath: string,
  runRoot: string,
  opts: ManifestTestSeams,
): { text: string; resolvedPath: string } {
  let rootReal: string;
  let rootIsDir: boolean;
  try {
    rootReal = realpathNoOpen(path.resolve(runRoot));
    // Inside the try, so a root deleted mid-resolution still surfaces as a
    // ManifestError — the loader promises nothing else escapes it.
    rootIsDir = fs.statSync(rootReal).isDirectory();
  } catch (err) {
    throw new ManifestError(`run root is not resolvable: ${runRoot}`, { cause: err });
  }
  if (!rootIsDir) {
    throw new ManifestError(`run root is not a directory: ${rootReal}`);
  }

  // Step 1 — resolve the full candidate path.
  let fileReal: string;
  try {
    fileReal = realpathNoOpen(path.resolve(manifestPath));
  } catch (err) {
    throw new ManifestError(`manifest is not resolvable: ${manifestPath}`, { cause: err });
  }
  // Step 2 — run-root prefix re-assertion on the resolved result.
  assertBeneath(rootReal, fileReal, "manifest");

  opts.onResolved?.();

  // Step 3 — open, then verify the descriptor's own path before trusting it.
  // O_NONBLOCK matters: without it, `open` on a FIFO planted beneath the run
  // root blocks the whole (synchronous) loader indefinitely, and the `isFile()`
  // check below — the thing that would reject it — never runs.
  let fd: number;
  try {
    fd = fs.openSync(
      fileReal,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    // ELOOP here is the final-component swap — the attack path INV-1 exists for.
    // It must reach callers as a ManifestError like every other load failure.
    throw new ManifestError(`manifest could not be opened: ${fileReal}`, { cause: err });
  }
  try {
    const openedAs = (opts.resolveFdPath ?? fdRealPath)(fd);
    if (openedAs === null) {
      throw new ManifestError(
        `post-open fd-path verification is unavailable on ${process.platform}; refusing the read (INV-5)`,
      );
    }
    assertBeneath(rootReal, openedAs, "opened manifest descriptor");
    if (path.resolve(openedAs) !== fileReal) {
      throw new ManifestError(
        `manifest path changed between resolution and open: expected ${fileReal}, opened ${openedAs} (INV-1)`,
      );
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ManifestError(`manifest is not a regular file: ${fileReal}`);
    }
    if (stat.size > MANIFEST_MAX_BYTES) {
      throw new ManifestError(
        `manifest is ${stat.size} bytes, above the ${MANIFEST_MAX_BYTES}-byte ceiling`,
      );
    }
    // Step 4 — read through the verified descriptor; never re-open by string.
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fd);
    } catch (err) {
      throw new ManifestError(`manifest could not be read: ${fileReal}`, { cause: err });
    }
    // Re-checked against what was actually read: the `fstat` size is a sample,
    // and a file appended to between the two would otherwise slip past.
    if (bytes.byteLength > MANIFEST_MAX_BYTES) {
      throw new ManifestError(
        `manifest read ${bytes.byteLength} bytes, above the ${MANIFEST_MAX_BYTES}-byte ceiling`,
      );
    }
    return { text: bytes.toString("utf8"), resolvedPath: fileReal };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Total budget a manifest demands: both retry multipliers plus the per-phase
 * routing margin. `maxDurationMs` is per *attempt*, so a retried phase's
 * wall-clock is the sum of its attempts' ceilings.
 */
export function requiredBudgetMs(phases: readonly { retries: number; maxDurationMs: number }[]): number {
  const attempts = phases.reduce(
    (sum, p) => sum + (p.retries + 1) * (PARSE_FIX_ATTEMPTS + 1) * p.maxDurationMs,
    0,
  );
  return attempts + phases.length * ROUTING_MARGIN_MS;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Read, validate and admit a pipeline manifest. Nothing is constructed, spawned
 * or journalled unless this returns.
 *
 * The manifest is read once and frozen: a mid-run edit to the file has no
 * effect, because the run carries the loaded value for its lifetime (in-flight
 * version pin, survives from P1.4).
 */
export function loadManifest(
  manifestPath: string,
  callerBudgetMs: number | undefined,
  runRoot: string | undefined,
): LoadedManifest {
  return loadManifestWithSeams(manifestPath, callerBudgetMs, runRoot, {});
}

/**
 * `loadManifest` with the test seams exposed. Exported from this module only —
 * never from `index.ts` — so the public surface cannot be handed a resolver that
 * defeats INV-1.
 */
export function loadManifestWithSeams(
  manifestPath: string,
  callerBudgetMs: number | undefined,
  runRoot: string | undefined,
  opts: ManifestTestSeams,
): LoadedManifest {
  const started = performance.now();

  // AC5: an upstream ceiling is never assumed.
  if (
    callerBudgetMs === undefined ||
    !Number.isSafeInteger(callerBudgetMs) ||
    callerBudgetMs <= 0
  ) {
    throw new ManifestError(
      "callerBudgetMs must be supplied as a positive integer; the engine never assumes an upstream ceiling",
    );
  }
  if (runRoot === undefined || runRoot === "") {
    throw new ManifestError("runRoot must be supplied; the manifest read is anchored at it (INV-1)");
  }

  const { text, resolvedPath } = readBeneathRoot(manifestPath, runRoot, opts);

  let parsed: unknown;
  try {
    // A BOM is not JSON but is a common artefact of Windows/PowerShell authoring;
    // stripping it keeps the refusal reserved for manifests that are really malformed.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON: ${resolvedPath}`, { cause: err });
  }

  // INV-4 before INV-2: a credential in an otherwise-valid field must not be
  // laundered by a schema that happens to accept the field's type.
  assertNoCredentials(parsed);

  // INV-2: closed validation strictly precedes construction.
  const result = PipelineManifestSchema.safeParse(parsed);
  if (!result.success) {
    // Each issue is sanitized as a whole: `.strict()`'s `unrecognized_keys`
    // issue embeds the raw offending key inside `message`, not just `path`
    // (a bare `\n`-containing unknown key still passes `assertNoCredentials`,
    // then reaches here through strict validation), so `formatZodIssue`
    // escapes both segments before this join, not only the path.
    const detail = result.error.issues.map(formatZodIssue).join("; ");
    throw new ManifestError(`manifest failed validation: ${detail}`);
  }
  const manifest = result.data as PipelineManifest;

  // A description defect is a static property of the manifest, so it is refused
  // here rather than thrown mid-walk, where it would leave a half-journalled run
  // and no terminal marker. `Run.phase` re-checks — a phase may be constructed
  // by a caller that never went through a manifest.
  for (const [i, spec] of manifest.phases.entries()) {
    const defect = descriptionDefect(spec.name, spec.description);
    if (defect !== null) {
      throw new ManifestError(`phases.${i} ('${sanitizeForMessage(spec.name)}'): ${defect}`);
    }
  }

  const required = requiredBudgetMs(manifest.phases);
  if (required > manifest.runBudgetMs) {
    throw new ManifestError(
      `manifest demands ${required} ms of phase budget but declares runBudgetMs ${manifest.runBudgetMs}`,
    );
  }
  if (manifest.runBudgetMs > callerBudgetMs) {
    throw new ManifestError(
      `runBudgetMs ${manifest.runBudgetMs} exceeds callerBudgetMs ${callerBudgetMs}`,
    );
  }

  return {
    manifest: deepFreeze(manifest),
    manifestLoadMs: performance.now() - started,
    resolvedPath,
  };
}

/**
 * DF3.1 AC9a: drop an author-supplied `limitMicroUsd` before stamping.
 *
 * For the DISPATCH-side read only. `loadManifest` is deliberately neutral —
 * it is the reader on BOTH sides of the box boundary, and the runner
 * (`scripts/pipeline-run.ts`) reads the already-stamped `pipeline.yaml` back
 * through it, so stripping there would delete the dispatcher's own ceiling and
 * run the engine uncapped. A stamped cap and an authored cap are byte-identical
 * in the file; the loader cannot tell them apart and must not try.
 *
 * The dispatcher can, because it knows which read is which: it calls this on
 * the pre-stamp host read, then `stampManifestLimit` supplies the admitted
 * ceiling. Harmless even without the strip — `stampManifestLimit` spreads
 * `limitMicroUsd` last, so the stamp already wins — but this closes the path
 * where dispatch does NOT stamp and an authored cap would reach the box.
 *
 * Drops `resolvedPath` for the same reason `stampManifestLimit` does: once a
 * field has been removed the bytes match no file on disk, and carrying the
 * unstripped file's path forward claims provenance the content no longer has.
 */
export function stripAuthoredLimit(loaded: LoadedManifest): LoadedManifest {
  const { limitMicroUsd: _authored, ...rest } = loaded.manifest;
  return {
    manifest: deepFreeze(rest as PipelineManifest),
    manifestLoadMs: loaded.manifestLoadMs,
  };
}

/**
 * DF3.1 AC9a: Stamp limitMicroUsd into a manifest for fill.
 * Returns a frozen copy that validates against the extended schema.
 *
 * The result carries no `resolvedPath`: its bytes exist at no path, and
 * inheriting the unstamped file's would claim provenance the content no
 * longer has.
 *
 * @param manifest — the loaded manifest to stamp
 * @param limitMicroUsd — positive safe integer ceiling (rejects 0, negative,
 *   float, and anything past `Number.MAX_SAFE_INTEGER`)
 * @throws {ManifestError} if the ceiling is not a positive safe integer, if the
 *   requested ceiling would RAISE one already present, or if the stamped
 *   manifest fails schema validation — every failure of this function, so
 *   callers catch one type
 */
export function stampManifestLimit(manifest: LoadedManifest, limitMicroUsd: number): LoadedManifest {
  // `z.number().int()` accepts 1e300 — `Number.isInteger` is true for it — and
  // the value then round-trips through the delivered manifest as `1e+300`,
  // i.e. an in-box cap that is not the ceiling admission actually granted.
  // Bound it here, where the ceiling is still comparable to the admitted one.
  if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd <= 0) {
    throw new ManifestError(
      `limitMicroUsd must be a positive integer <= ${Number.MAX_SAFE_INTEGER}; got ${limitMicroUsd}`,
    );
  }
  // Monotonic guard, fail-closed: a ceiling already present is what admission
  // GRANTED, so the last-wins spread below must never let a second stamp
  // overwrite it upward past the ledger (unreserved headroom). Equal and lower
  // stay legal — downstream clamps are downward-only, so tightening preserves
  // doctrine. An absent field is the ordinary first stamp and is untouched.
  const existing = manifest.manifest.limitMicroUsd;
  if (existing !== undefined && limitMicroUsd > existing) {
    throw new ManifestError(
      `refusing to raise limitMicroUsd from ${existing} to ${limitMicroUsd} above the admitted ceiling`,
    );
  }
  const stamped = { ...manifest.manifest, limitMicroUsd };
  // safeParse, so a schema failure leaves through this module's OWN error type.
  // `parse` threw a raw ZodError, which every caller of this module (dispatch's
  // `manifest-rejected` arm included) handles as an unrecognised throw.
  const result = PipelineManifestSchema.safeParse(stamped);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ManifestError(`stamped manifest failed validation: ${detail}`);
  }
  const validated = result.data as PipelineManifest;
  // `stampManifestLimit` spread `limitMicroUsd` last and safeParse cannot drop
  // a present field (the schema declares it `.optional()` with no default or
  // transform — nothing in zod removes an existing key), so
  // `validated.limitMicroUsd === limitMicroUsd` holds by construction. An old
  // "stamp did not land" check here defended against a schema behaviour that
  // does not exist, while teaching readers that optional fields can silently
  // vanish through validation. The REAL guarantee is the parse above: a stamp
  // that fails validation throws ManifestError there.
  return { manifest: deepFreeze(validated), manifestLoadMs: manifest.manifestLoadMs };
}

/**
 * DF3.1 AC9a: Serialize a manifest for `fill` delivery into the box.
 *
 * Emits **JSON**, despite the `.yaml` filename the dispatcher delivers it
 * under. `loadManifest` above is the authoritative reader of this file and it
 * `JSON.parse`s; JSON is a subset of YAML, so a YAML reader accepts this too,
 * while the reverse does not hold — `YAML.stringify` emits unquoted keys that
 * no JSON parser will take, which made the delivered manifest unreadable by
 * this repo's own loader. Emitting JSON is therefore the only output both
 * accept. It also moots YAML's default `lineWidth: 80` scalar folding, which
 * re-parsed a long phase command as a subtly different string.
 *
 * @param manifest — the loaded manifest (may be stamped)
 * @returns a string suitable for BoxFile delivery, readable by `loadManifest`
 */
export function serializeManifest(manifest: LoadedManifest): string {
  // Trailing newline, deliberately: the delivered `pipeline.yaml` is read by
  // `cat`-style concatenations (tier2 live reads the manifest pair as one
  // stream and locates `run-context.json` by line boundary), and a
  // newline-less JSON document GLUES the next file onto its last line —
  // `}{"runId":…}` — which breaks any line-oriented locate downstream.
  // Whitespace to every JSON parser, including this repo's own loader.
  return `${JSON.stringify(manifest.manifest, null, 2)}\n`;
}
