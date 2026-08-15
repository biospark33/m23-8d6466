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

const argv = z.array(z.string().min(1)).min(1);

export const PhaseSpecSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["engineer", "agent", "code"]),
    description: z.string().min(1),
    maxDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_DURATION_MS)
      .default(DEFAULT_MAX_DURATION_MS),
    retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).default(MIN_RETRIES),
    command: argv.optional(),
    testCommand: argv.optional(),
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
 */
export function readArtifactBeneathRoot(
  artifactPath: string,
  runRoot: string,
): { bytes: Buffer; resolvedPath: string; size: number } {
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
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fd);
    } catch (err) {
      throw new ManifestError(`artifact could not be read: ${fileReal}`, { cause: err });
    }
    if (bytes.byteLength > MANIFEST_MAX_BYTES) {
      throw new ManifestError(
        `artifact read ${bytes.byteLength} bytes, above the ${MANIFEST_MAX_BYTES}-byte ceiling`,
      );
    }
    return { bytes, resolvedPath: fileReal, size: stat.size };
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
      return fs.readlinkSync(`/proc/self/fd/${fd}`);
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
  /** The verified absolute path the manifest was read from. */
  resolvedPath: string;
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
