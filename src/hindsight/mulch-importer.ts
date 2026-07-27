/**
 * Mulch expertise importer (P0.9).
 *
 * Reads a directory of `.yaml/.yml/.json/.jsonl` expertise files, parses + validates
 * each entry against `MulchExpertiseSchema`, dedups by SHA-256(domain + NFC-sorted
 * concepts), and retains each as a JSONL line into the target Hindsight bank.
 *
 * Contract: see _bmad-output/sprint-artifacts/phase-0/stories/p0-9-hindsight-banks-mulch.md
 * "Mulch Storage Format Contract" (lines 164-181) + research-brief.md "File plan".
 *
 * Security:
 *  - INV-HM3: each file path is resolved via `fs.realpathSync` and validated to
 *    remain inside the expertise dir's own realpath (which is expected to live
 *    under the project root). Symlinks pointing OUTSIDE are rejected per-file.
 *  - INV-HM4: `verifyTenantIsolation` helper retains a marker into bankA and
 *    asserts it is NOT recallable from bankB. Not called by importMulch —
 *    exported separately for the DoD security test.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync, readdirSync, statSync, readFileSync } from "node:fs";
import { extname, relative, sep as PATH_SEP, resolve as pathResolve } from "node:path";

import { parse } from "yaml";
import { MulchExpertiseSchema, ERR_MULCH_FILE_COUNT, type MulchExpertise } from "./schemas.ts";
import type { HindsightClient } from "./client.ts";
import { log, newRequestId, type LogEntry } from "../swarmclaw/mcp/stdio-transport.ts";

// ---------------------------------------------------------------------------
// Constants (spec contract)
// ---------------------------------------------------------------------------

export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const MAX_CONTENT_BYTES = 102_400; // 100 KB per expertise entry (mirrors RetainPayloadSchema)
const SUPPORTED_EXTS = new Set([".yaml", ".yml", ".json", ".jsonl"]);
const UTF8_BOM = 0xfeff; // U+FEFF — the EF BB BF bytes decode to this single codepoint

// ---------------------------------------------------------------------------
// Typed errors (stable failure-code classification — fix [5])
// ---------------------------------------------------------------------------

/**
 * Raised when a single file exceeds MAX_FILE_BYTES. Classified into the
 * stable failure code `file_too_large`. Replaces message/name sniffing.
 */
export class FileTooLargeError extends Error {
  constructor(message = "file_too_large") {
    super(message);
    this.name = "FileTooLargeError";
  }
}

/**
 * Raised when a symlink's realpath target escapes the expertise dir (either
 * outside the dir entirely, OR into a subdirectory of the dir — INV-HM3
 * "top-level files only"). Stable failure code `symlink_escape`.
 */
export class SymlinkEscapeError extends Error {
  constructor(message = "symlink_escape") {
    super(message);
    this.name = "SymlinkEscapeError";
  }
}

/**
 * Raised when realpath() on a candidate file fails (target missing or
 * unreadable). Stable failure code `symlink_target_unreadable` (mapped to
 * `symlink_escape` in the failure taxonomy since the importer can't trust
 * the target).
 */
export class SymlinkTargetUnreadableError extends Error {
  constructor(message = "symlink_target_unreadable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SymlinkTargetUnreadableError";
  }
}

/**
 * The errno code behind a failed fs call, falling back to its message. Used to
 * keep the stable `error` codes intact while still reporting WHY (#67) — an
 * `expertise_dir_not_found` that was really EACCES is an unfixable support
 * ticket otherwise.
 */
function errnoOf(e: unknown): string {
  const raw = (e as NodeJS.ErrnoException | undefined)?.code;
  const str = raw ?? (e instanceof Error ? e.message : String(e));
  // ponytail: single-line + 200-char cap — a wrapped error's multi-line message
  // or a parser dump must not corrupt the result envelope or log line (#67).
  return (str.split("\n")[0] ?? "").slice(0, 200);
}

/** Stable errno code surfaced when the expertise dir cannot be read. */
export const ERR_EXPERTISE_DIR_UNREADABLE = "expertise_dir_unreadable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportFailure {
  file: string;
  entryIndex?: number;
  error: string;
  /**
   * Underlying cause behind the stable `error` code — an errno (`EACCES`) or a
   * parser message. Optional and purely diagnostic: `error` stays the stable
   * contract callers switch on, this is what makes the support ticket fixable
   * (#67). Never populated with anything caller-controlled beyond the OS/parser
   * message itself.
   */
  cause?: string;
}

export interface ImportResult {
  ok: boolean;
  totalFiles: number;
  importedFiles: number;
  updatedFiles: number;
  failures: ImportFailure[];
  requestId: string;
  filesProcessed?: number;
  note?: string;
  /** `code` is a numeric MCP-style code (-32004 etc.) OR a stable string code
   *  (`expertise_dir_unreadable`) for the unreadable-dir path (fix [8]). */
  error?: { code: number | string; message: string };
}

export interface ImportOptions {
  client: HindsightClient;
  expertiseDir: string;
  bankId: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// importMulch
// ---------------------------------------------------------------------------

/**
 * Read `expertiseDir` (non-recursive), parse each supported file, validate
 * entries, dedup, and retain as JSONL into `bankId`. Best-effort per-entry:
 * malformed files/entries go to `failures[]`, the rest still import.
 */
export async function importMulch(opts: ImportOptions): Promise<ImportResult> {
  const requestId = opts.requestId ?? newRequestId();
  const start = Date.now();
  const failures: ImportFailure[] = [];
  let importedFiles = 0;
  let updatedFiles = 0;

  // Resolve the expertise dir's own realpath ONCE — every file must live under it.
  let dirReal: string;
  try {
    dirReal = realpathSync(opts.expertiseDir);
  } catch (e) {
    // The code stays `expertise_dir_not_found`, but the message now names the
    // errno: this path also fires on EACCES and ELOOP, and reporting those as
    // "not found" sent operators looking for a missing directory that was
    // actually right there and unreadable (#67).
    const cause = errnoOf(e);
    const result: ImportResult = {
      ok: false,
      totalFiles: 0,
      importedFiles: 0,
      updatedFiles: 0,
      failures: [],
      requestId,
      // Stable string code (consistent with ERR_EXPERTISE_DIR_UNREADABLE for
      // the sibling readdir-failure path). Not a -3200N code: this is an
      // importer-internal surface, not the HTTP bridge surface (CC-W3 (a)).
      error: {
        code: "expertise_dir_not_found",
        message: `expertise dir not found: ${opts.expertiseDir} (${cause})`,
      },
    };
    emitLog(requestId, "import", opts.bankId, start, "error", result.error);
    return result;
  }

  // Non-recursive listing: top-level entries only. readdir with FileCall makes
  // the supported/unsupported split cheap without a stat-per-file.
  let entries: string[];
  try {
    entries = readdirSync(dirReal);
  } catch (e) {
    // ENOENT (or a vanished dir between realpath + readdir) → graceful empty.
    // Anything else (EACCES, EBUSY, ENOTDIR) → real read failure, surface it.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyDirResult(requestId, opts.bankId, start);
    }
    const cause = code ?? "unknown";
    const result: ImportResult = {
      ok: false,
      totalFiles: 0,
      importedFiles: 0,
      updatedFiles: 0,
      failures: [],
      requestId,
      error: { code: ERR_EXPERTISE_DIR_UNREADABLE, message: `expertise dir unreadable: ${opts.expertiseDir} (${cause})` },
    };
    log({
      requestId,
      operation: "import.readdir",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      bankId: opts.bankId,
      level: "error",
      message: `readdirSync failed: errno=${code ?? "unknown"} err=${(e as Error).message}`,
    });
    emitLog(requestId, "import", opts.bankId, start, "error", {
      code: ERR_EXPERTISE_DIR_UNREADABLE,
      message: `expertise dir unreadable: ${opts.expertiseDir} (${cause})`,
    });
    return result;
  }

  const supportedFiles: string[] = [];
  for (const name of entries) {
    const full = pathResolve(dirReal, name);
    // Use stat (not lstat) so symlinks-to-files are followed consistently with
    // the realpath validation in parseFile.
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (e) {
      // Still a skip, not a failure — a file that vanished between readdir and
      // stat is not the caller's problem and must not fail the import. But the
      // skip is no longer invisible: a permission-denied file silently dropping
      // out of the count is exactly the unfixable support ticket in #67.
      debugLog(requestId, "import.skip", `skipping ${name}: stat failed (${errnoOf(e)})`);
      continue;
    }
    // Fix 3: skip non-regular files (dirs, FIFOs, sockets, devices). A FIFO or
    // socket named `stream.yaml` would otherwise pass the ext filter, succeed
    // at statSync, then block readFileSync indefinitely. isFile() cleanly
    // rejects dirs AND special files AND symlinks-to-dirs.
    if (!st.isFile()) {
      if (!st.isDirectory()) {
        debugLog(requestId, "import.skip", `skipping non-regular file: ${name}`);
      }
      continue;
    }
    if (SUPPORTED_EXTS.has(extname(name).toLowerCase())) {
      supportedFiles.push(full);
    } else {
      // Unsupported ext → debug log (spec: "skipped with debug-level log").
      debugLog(requestId, "import.skip", `skipping unsupported file: ${name}`);
    }
  }

  // Empty dir → graceful skip.
  if (supportedFiles.length === 0) {
    return emptyDirResult(requestId, opts.bankId, start);
  }

  // 100-file quota (spec: do NOT import on overflow, return -32004).
  if (supportedFiles.length > MAX_FILES) {
    const result: ImportResult = {
      ok: false,
      totalFiles: supportedFiles.length,
      importedFiles: 0,
      updatedFiles: 0,
      failures: [],
      requestId,
      filesProcessed: MAX_FILES,
      error: {
        code: ERR_MULCH_FILE_COUNT,
        message: "File count exceeds maximum (100)",
      },
    };
    emitLog(requestId, "import", opts.bankId, start, "error", result.error);
    return result;
  }

  // Dedup state — across ALL files in this run. Re-import with same domain +
  // concepts (any order) counts as update, not duplicate (idempotent).
  const seenHashes = new Set<string>();

  for (const filePath of supportedFiles) {
    const fileStart = Date.now();
    const relFile = relative(dirReal, filePath);
    let status: "ok" | "error" = "ok";
    let fileErr: { code: string; message: string } | undefined;

    try {
      const entries = parseFile(filePath, dirReal, failures, requestId);
      let fileImported = false;
      let fileUpdated = false;
      for (const { entry, index } of entries) {
        const validated = validateEntry(entry, filePath, dirReal, index, failures);
        if (validated === null) continue; // failure already recorded

        // Canonical JSONL line — stable field order via the schema's shape.
        const jsonl = JSON.stringify({
          id: validated.id,
          domain: validated.domain,
          concepts: validated.concepts,
          expertise: validated.expertise,
          ...(validated.source !== undefined ? { source: validated.source } : {}),
          ...(validated.confidence !== undefined ? { confidence: validated.confidence } : {}),
        });

        // Per-entry content cap is on the WIRE PAYLOAD (the JSONL line actually
        // sent to retain), which mirrors RetainPayloadSchema's 102400-byte cap.
        // Checking `expertise` alone under-reports: expertise near 100KB makes
        // the wrapping JSONL exceed the cap and fail at retain with a confusing
        // retain_failed. (B-2/E-11)
        if (Buffer.byteLength(jsonl, "utf8") > MAX_CONTENT_BYTES) {
          failures.push({ file: relFile, entryIndex: index, error: "content_too_large" });
          continue;
        }

        const hash = dedupHash(validated.domain, validated.concepts);
        const isUpdate = seenHashes.has(hash);

        try {
          const retainRes = await opts.client.retain(opts.bankId, jsonl, {
            source: "mulch-import",
            kind: "expertise",
            tags: validated.concepts,
          });
          // Only mark the hash as seen AFTER a successful retain — otherwise a
          // failed retain poisons the dedup set and a later same-hash entry is
          // silently treated as an update instead of retrying. (B-1)
          seenHashes.add(hash);
          // Fix 2: trust the retain response's own `status` over the in-process
          // seenHashes — on re-import (fresh seenHashes) the bank knows whether
          // the memory was newly created or updated an existing one. Defensive:
          // tolerate clients/fixtures that omit `status`.
          const statusVal = (retainRes as { status?: unknown } | null)?.status;
          if (isUpdate || statusVal === "updated") fileUpdated = true;
          else fileImported = true;
        } catch (e) {
          failures.push({
            file: relFile,
            entryIndex: index,
            error: `retain_failed: ${(e as Error).message}`,
          });
          status = "error";
          fileErr = { code: "retain_failed", message: (e as Error).message };
        }
      }

      if (fileImported) importedFiles++;
      if (fileUpdated) updatedFiles++;
    } catch (e) {
      // Whole-file failure (read/parse). entryIndex omitted per spec.
      // Classification via typed error classes (fix [5]) — robust to
      // message renames, only `instanceof` matters.
      let code: string;
      if (e instanceof FileTooLargeError) code = "file_too_large";
      else if (e instanceof SymlinkEscapeError) code = "symlink_escape";
      else if (e instanceof SymlinkTargetUnreadableError) code = "symlink_escape";
      else code = "parse_failed";
      const msg = (e as Error).message;
      // `error` is the stable code callers switch on; `cause` carries the reason
      // ONLY when it adds information beyond the code itself — otherwise the field
      // is redundant noise (#67).
      const failure: ImportFailure = { file: relFile, error: code };
      if (msg && msg !== code) failure.cause = msg;
      failures.push(failure);
      status = "error";
      fileErr = { code, message: msg };
    }

    emitFileLog(requestId, opts.bankId, fileStart, status, relFile, fileErr);
  }

  const result: ImportResult = {
    ok: true,
    totalFiles: supportedFiles.length,
    importedFiles,
    updatedFiles,
    failures,
    requestId,
  };
  emitLog(requestId, "import", opts.bankId, start, "ok");
  return result;
}

// ---------------------------------------------------------------------------
// Parsing — per extension
// ---------------------------------------------------------------------------

interface ParsedEntry {
  id?: string;
  domain: string;
  concepts: string[];
  expertise: string;
  source?: string;
  confidence?: number;
}

/**
 * A parsed entry paired with its original positional index. For `.jsonl` files
 * `index` is the 1-based FILE LINE NUMBER (blank/null/malformed lines count
 * toward it but are skipped from the output); for JSON/YAML arrays it is the
 * 0-based array index. Threading the index through `parseFile` — instead of
 * reconstructing it from the loop position in the consumer — keeps failure
 * `entryIndex` values aligned with the real source position even when earlier
 * lines were skipped (the 0-based array offset desyncs from the file line as
 * soon as a blank/null/malformed line is dropped before the entry).
 */
interface ParsedEntryWithIndex {
  entry: ParsedEntry;
  index: number;
}

/**
 * Read + parse a single file. Throws on read/parse failure (caller records the
 * whole-file failure) EXCEPT for `.jsonl`, where one malformed line is recorded
 * as a per-entry failure and the rest of the file still parses (best-effort per
 * entry, per spec). INV-HM3 path safety enforced here so a symlink escape
 * never even reaches the parser.
 */
function parseFile(filePath: string, dirReal: string, failures: ImportFailure[], requestId: string): ParsedEntryWithIndex[] {
  // INV-HM3: resolve realpath and require it to stay within dirReal. A symlink
  // whose target is outside the expertise dir resolves to a path NOT prefixed
  // by dirReal → reject with SymlinkEscapeError.
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch (e) {
    // Carry the errno: a dangling symlink (ENOENT) and one whose target is
    // unreadable (EACCES) are the same message otherwise, and only the second
    // is actionable by the operator (#67).
    throw new SymlinkTargetUnreadableError(`symlink_target_unreadable (${errnoOf(e)})`, { cause: e });
  }
  if (resolved !== dirReal && !resolved.startsWith(dirReal + PATH_SEP)) {
    throw new SymlinkEscapeError("symlink_escape");
  }
  // INV-HM3 (subdir): contract is TOP-LEVEL FILES ONLY. A symlink in
  // `.mulch/expertise/` whose target resolves into a SUBDIRECTORY of dirReal
  // (e.g. `.mulch/expertise/subdir/secret`) would expand the read surface
  // beyond top-level. A legitimate top-level regular file's realpath equals
  // its own path — relative-to-dirReal contains no separator. Reject anything
  // whose target's relative path contains a separator (fix [6]).
  const relTarget = relative(dirReal, resolved);
  if (relTarget.includes(PATH_SEP)) {
    throw new SymlinkEscapeError("symlink_escape_subdir");
  }

  // 5 MB per-file cap (before reading the whole body into memory would be a DoS).
  const stat = statSync(resolved);
  if (stat.size > MAX_FILE_BYTES) {
    throw new FileTooLargeError(`file_too_large: ${stat.size} bytes exceeds ${MAX_FILE_BYTES}`);
  }
  // Fix 3 (defense in depth): a FIFO/socket/device that survived the directory
  // listing (e.g. created between listing and parse) would block readFileSync.
  // stat follows symlinks, so this also rejects symlinks-to-dirs consistently
  // with the realpath validation above.
  if (!stat.isFile()) {
    // Name the shape: "unreadable" on a FIFO reads as a permissions problem and
    // sends the operator down the wrong path (#67).
    throw new SymlinkTargetUnreadableError(
      `symlink_target_unreadable (not a regular file: ${stat.isDirectory() ? "directory" : stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket" : "special file"})`,
    );
  }

  const raw = readFileSync(resolved);
  let text = raw.toString("utf8");
  // BOM strip — EF BB BF decodes to U+FEFF at the start of the string.
  if (text.charCodeAt(0) === UTF8_BOM) {
    text = text.slice(1);
  }

  // Fix 5: dispatch on the LINK's extension (filePath), not the target's.
  // A symlink `link.yaml` → `real.json` must be parsed as YAML per the
  // operator's naming. `resolved` is still used for the read + escape check.
  const ext = extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = parse(text);
    return toArray(parsed, "yaml_object_not_array").map((entry, index) => ({ entry, index }));
  }
  if (ext === ".json") {
    const parsed = JSON.parse(text);
    return toArray(parsed, "json_object_not_array").map((entry, index) => ({ entry, index }));
  }
  if (ext === ".jsonl") {
    const relFile = relative(dirReal, filePath);
    const out: ParsedEntryWithIndex[] = [];
    // `lineNo` is the 1-based FILE LINE NUMBER (per spec "JSONL line 3"), not
    // the non-blank ordinal — operators use entryIndex to jump to the line in
    // the source file, so blank lines must count.
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsedLine = JSON.parse(trimmed);
        // Fix 4: `null` JSONL lines are a valid idiomatic tombstone in some
        // tooling (NDJSON / JSON Lines delimiters). They carry no expertise, so
        // skip them silently with a debug log rather than surfacing as a
        // failure (chose conservative: real objects still go to validation;
        // non-object primitives like arrays/numbers still become `not_object`
        // failures downstream — only literal `null` is the graceful skip).
        if (parsedLine === null) {
          debugLog(requestId, "import.skip", `skipping null JSONL line ${lineNo} in ${relFile}`);
          continue;
        }
        out.push({ entry: parsedLine as ParsedEntry, index: lineNo });
      } catch (e) {
        // B-3: one malformed line must NOT drop the whole file as parse_failed.
        // Record the per-entry failure at the line's position and keep parsing.
        // The parser message rides along as `cause` — "invalid_jsonl_line" alone
        // does not tell an operator WHICH character on the line broke it (#67).
        failures.push({
          file: relFile,
          entryIndex: lineNo,
          error: "invalid_jsonl_line",
          cause: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }
  // Unsupported exts are filtered before parseFile; defensive no-op.
  return [];
}

// ---------------------------------------------------------------------------
// Validation + dedup
// ---------------------------------------------------------------------------

function validateEntry(
  raw: unknown,
  filePath: string,
  dirReal: string,
  entryIndex: number,
  failures: ImportFailure[],
): MulchExpertise | null {
  const relFile = relative(dirReal, filePath);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failures.push({ file: relFile, entryIndex, error: "not_object" });
    return null;
  }
  const obj = { ...(raw as Record<string, unknown>) };
  // Auto-generate UUID id when absent (spec).
  if (obj.id === undefined || obj.id === null) {
    obj.id = randomUUID();
  }
  // Auto-record source as relative file path when absent (spec).
  if (obj.source === undefined || obj.source === null) {
    obj.source = relFile;
  }
  const parsed = MulchExpertiseSchema.safeParse(obj);
  if (!parsed.success) {
    failures.push({
      file: relFile,
      entryIndex,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    });
    return null;
  }
  return parsed.data;
}

/**
 * Dedup hash: SHA-256 of canonical JSON of {domain, sorted concepts}, both NFC
 * -normalized. Idempotent across re-imports of the same domain+concepts set.
 *
 * Concepts are deduped via Set BEFORE sort+normalize so `{domain, ["a","a"]}`
 * hashes identically to `{domain, ["a"]}` — otherwise a duplicate concept in a
 * single entry would silently produce a second distinct entry instead of
 * deduplicating.
 */
export function dedupHash(domain: string, concepts: string[]): string {
  const normalized = {
    domain: domain.normalize("NFC"),
    concepts: [...new Set(concepts.map((c) => c.normalize("NFC")))].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function toArray(parsed: unknown, errMsg: string): ParsedEntry[] {
  if (Array.isArray(parsed)) return parsed as ParsedEntry[];
  // Spec ambiguity: "if a YAML file is a single object not an array, treat as
  // one entry OR report failure". We treat a single OBJECT shaped like an
  // expertise entry as a one-element array (lenient — better than dropping a
  // valid seed). Anything else (string/number/null) → not_array failure.
  if (parsed !== null && typeof parsed === "object") {
    return [parsed as ParsedEntry];
  }
  throw new Error(errMsg);
}

// ---------------------------------------------------------------------------
// INV-HM4: tenant isolation verifier (separate export, for the DoD test)
// ---------------------------------------------------------------------------

export interface TenantIsolationOptions {
  client: HindsightClient;
  bankA: string;
  bankB: string;
  requestId?: string;
}

export interface TenantIsolationResult {
  ok: boolean;
  bankA: string;
  bankB: string;
  marker: string;
  requestId: string;
  error?: { code: string; message: string };
}

/**
 * Retains a unique marker into bankA, then recalls it from bankB. Asserts the
 * marker does NOT appear in bankB's results. Passes only if the client
 * actually isolates tenants (mock or real).
 */
export async function verifyTenantIsolation(
  opts: TenantIsolationOptions,
): Promise<TenantIsolationResult> {
  const requestId = opts.requestId ?? newRequestId();
  const marker = `tenant-isolation-probe-${randomUUID()}`;
  const start = Date.now();

  try {
    await opts.client.retain(opts.bankA, marker, {
      source: "mulch-import",
      kind: "expertise",
      tags: ["tenant-isolation-probe"],
    });
  } catch (e) {
    const error = { code: "retain_failed", message: (e as Error).message };
    emitLog(requestId, "tenant_isolation", opts.bankA, start, "error", error);
    return { ok: false, bankA: opts.bankA, bankB: opts.bankB, marker, requestId, error };
  }

  let leaked: boolean;
  try {
    const recall = await opts.client.recall(opts.bankB, marker, 10);
    leaked = recall.results.some((r) => r.content.includes(marker));
  } catch (e) {
    const error = { code: "recall_failed", message: (e as Error).message };
    emitLog(requestId, "tenant_isolation", opts.bankB, start, "error", error);
    return { ok: false, bankA: opts.bankA, bankB: opts.bankB, marker, requestId, error };
  }
  const status = leaked ? "error" : "ok";
  emitLog(requestId, "tenant_isolation", opts.bankB, start, status);
  return {
    ok: !leaked,
    bankA: opts.bankA,
    bankB: opts.bankB,
    marker,
    requestId,
    ...(leaked ? { error: { code: "tenant_leak", message: "marker from bankA found in bankB" } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Logging helpers (CC-9)
// ---------------------------------------------------------------------------

function emitLog(
  requestId: string,
  operation: string,
  bankId: string,
  start: number,
  status: "ok" | "error",
  error?: { code: number | string; message: string },
): void {
  const entry: LogEntry = {
    requestId,
    operation,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: Date.now() - start,
    status,
    bankId,
    ...(error ? { error: { code: String(error.code), message: error.message } } : {}),
  };
  log(entry);
}

function emitFileLog(
  requestId: string,
  bankId: string,
  start: number,
  status: "ok" | "error",
  file: string,
  error?: { code: string; message: string },
): void {
  const entry: LogEntry = {
    requestId,
    operation: "import.file",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: Date.now() - start,
    status,
    bankId,
    file,
    import_ms: Date.now() - start,
    ...(error ? { error } : {}),
  };
  log(entry);
}

function debugLog(requestId: string, operation: string, message: string): void {
  const entry: LogEntry = {
    requestId,
    operation,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: 0,
    status: "ok",
    bankId: "",
    level: "debug",
    message,
  };
  log(entry);
}

function emptyDirResult(requestId: string, bankId: string, start: number): ImportResult {
  const result: ImportResult = {
    ok: true,
    totalFiles: 0,
    importedFiles: 0,
    updatedFiles: 0,
    failures: [],
    requestId,
    note: "empty expertise dir",
  };
  emitLog(requestId, "import", bankId, start, "ok");
  return result;
}
