/**
 * Fleet dispatch verb (Story DF3.1) — the factory's front door (D3, DD-1).
 *
 * Tested TypeScript with a schema at its ingress; a tier-1 agent invokes this
 * verb and never composes provider commands itself. The admission gates are
 * owned HERE (C1): driver.ts's `createRun` runs `checkHeadroom(1)` with no
 * skip option, so `{ admitted: true }` (DF3.2's fan-out seam) can only be
 * honoured by composing the lifecycle primitives directly. The post-admission
 * provisioning sequence (record → box) is the SAME `provisionAdmittedRun`
 * body `createRun` composes, so the INV-1 ordering invariant has a single
 * owner in the providers layer. No ceiling or limit is re-derived — DF2.6
 * owns the fleet ceiling, DF2.8 owns the per-issue cap, and this module owns
 * exactly the two call sites (AC7/AC8) plus the mapping of a refusal onto
 * exit 5.
 *
 * Ordering (INV-1/INV-3): validate → resolve → admit → record → box → key →
 * fill → setup gate → expose → ack. Everything that can refuse a brief on its
 * own contents — schema, wall-clock budget, manifest, roster — runs in the
 * validate step, BEFORE an admission is spent or a box exists (INV-2). The
 * public exposure is the LAST step, not part of provisioning: a box made
 * public before the gate proves it is reachable while unproven, and INV-5 then
 * forbids tearing it down.
 *
 * A rejected dispatch provisions nothing (INV-2); a failed gate — and every
 * other post-provision failure — leaves the record OPEN and the box ALIVE with
 * its debug and teardown commands printed (INV-5), because destroying the box
 * would discard the evidence. Every one of those exits takes the same route:
 * a `FleetError` with the exit code, a host-side dispatch-log entry, and one
 * structured log line (`refuse`, below).
 */
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import { appendDispatchFailure } from "../phase-engine/issue-correlation.ts";
import { isValidUuidV4, resolveRunCorrelation } from "../phase-engine/issue-correlation.ts";
import { CorrelationError } from "../phase-engine/issue-correlation.ts";
import {
  loadManifest,
  serializeManifest,
  stampManifestLimit,
  stripAuthoredLimit,
} from "../phase-engine/manifest.ts";
import { fillRun, provisionAdmittedRun, type ProviderDriver } from "../providers/driver.ts";
import { mintRunKey, deliverRunKey, type KeyApi } from "../providers/credentials.ts";
import { assertWithinBudget, OverBudgetError } from "../providers/budget-gate.ts";
import { checkHeadroom, type LoadedQuotaLimits } from "../providers/quota.ts";
import { CostLedgerError } from "../providers/cost-ledger.ts";
import type { AdmissionDecision, CostLedger } from "../providers/cost-ledger.ts";
import { newId, assertValidRunId, InvalidRunIdError, type RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import {
  setupGate as realSetupGate,
  type AssertionResult,
  type SetupGateResult,
} from "../providers/exedev/setup-gate.ts";
import { fakeGate, isSubstrateFailure } from "../providers/fake-gate.ts";
import { parseRoster, ROSTER_MAX_BYTES } from "../phase-engine/roster/schema.ts";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { log } from "../swarmclaw/log.ts";
import { BriefSchema, extractZodErrorField, type Brief } from "./brief-schema.ts";

/**
 * The dir-box setup gate, re-exported from the providers layer where its probe
 * strings live (DoD: no substrate command string under `src/fleet/`). Callers
 * and tests keep importing it from the module that USES it.
 */
export { fakeGate } from "../providers/fake-gate.ts";

/**
 * Host-side dispatch-failure log (DF1.8's appendDispatchFailure target), at the
 * default run-record location. The path dispatch actually writes is derived
 * from `deps.store.dir`, so `--dir` moves the log with the records instead of
 * scattering refusals across an operator's real `.sandbox/`; with the default
 * store the two resolve to the same file.
 */
export const DISPATCH_FAILURE_LOG = ".sandbox/dispatch-log.jsonl";

/** The minted-runId shape — the only form `opts.runId` accepts (AC2). */
const MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * The ids `mintRunId()` has handed out IN THIS PROCESS — the runtime half of
 * AC2's provenance. The brand covers compile time and `MINTED_RUN_ID_RE` covers
 * shape; neither proves the id came from HERE, so a shape-valid string cast in
 * by a misbehaving in-process caller was accepted. Now it is checked against
 * this registry.
 *
 * Memory only, never persisted: a restart forgets every id, and that is correct
 * — a stale id from a dead process has no record this process minted, and the
 * ordinary `run-id-in-use` arbiter (`recordExists` → `store.create` O_EXCL)
 * governs whatever actually exists on disk.
 *
 * ponytail: FIFO-evicted past 4096 mints (DF3.2 fans out tens, so the cap is
 * orders of magnitude above every real batch). Raise it before any caller mints
 * four thousand ids before consuming the first; that caller does not exist.
 */
const MINTED_RUN_IDS_MAX = 4096;
const mintedRunIds = new Set<string>();

function rememberMintedRunId(id: string): void {
  mintedRunIds.add(id);
  if (mintedRunIds.size > MINTED_RUN_IDS_MAX) {
    // Set iteration is insertion order, so the OLDEST mint goes first.
    const oldest = mintedRunIds.values().next().value;
    if (oldest !== undefined) mintedRunIds.delete(oldest);
  }
}

/**
 * Was this FleetError produced by THIS dispatch's own `refuse` — i.e. did the
 * dispatch-log entry, the structured line and the payload already go out with
 * it? Every catch that rethrows an incoming FleetError on the assumption it was
 * refusal-logged rechecks this instead of assuming (see the rethrow arms).
 */
const refusedOnce = new WeakSet<FleetError>();

function alreadyRefused(e: unknown): boolean {
  return e instanceof FleetError && refusedOnce.has(e);
}

/** Prose punctuation a sentence hangs on a link, never part of the host. */
const URL_TRAILING_PUNCT_RE = /[)\]},;.!?'.,]+$/;

/**
 * Upper bound on the `invalid-brief` payload's echoed zod issues. The array
 * scales with the attacker-controlled UNRECOGNIZED-KEY count, so an unbounded
 * echo flooded stderr, the FleetError payload and every consumer of both with
 * one crafted brief. `RUN_ID_ECHO_CHARS` bounds the id the same way.
 */
const MAX_ISSUES_ECHO = 32;

/** A byte ceiling as operator-facing KiB text, derived so it cannot drift. */
function kibLabel(bytes: number): string {
  return `${Math.round((bytes / 1024) * 100) / 100} KiB`;
}

/**
 * The bounded `issues` echo for an `invalid-brief` payload: the first
 * `MAX_ISSUES_ECHO` entries, or a truncation marker as the last element when
 * the caller's array ran longer. A partial list must be visibly partial — the
 * dropped count rides beside it on the payload (`issueCount`).
 */
function cappedIssues(total: number, issues: string[]): string[] {
  if (total <= MAX_ISSUES_ECHO) return issues;
  return [
    ...issues.slice(0, MAX_ISSUES_ECHO),
    `… and ${total - MAX_ISSUES_ECHO} more issue(s) omitted`,
  ];
}

/**
 * The exedev gate's plain-path charset (`assertPathSafe`, `rosterModels`),
 * mirrored so the roster can be refused BEFORE a box is billed rather than as a
 * failed assertion on a live one INV-5 forbids destroying. Deliberately a
 * COPY: the gate's own check stays the backstop, and this one exists purely to
 * move the refusal earlier — it is never allowed to be the looser of the two.
 */
const ROSTER_PATH_CHARSET = /^[A-Za-z0-9._/-]+$/;

/**
 * `setTimeout` clamps a delay past the 32-bit signed max to 1 ms, so a ceiling
 * above this is not a long ceiling — it is the SHORTEST possible one, and the
 * first step times out immediately. A request to lengthen the budget must not
 * invert into the opposite.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * How many times a self-minted run id is re-minted past a record collision.
 * `newId("qds")` is 24 bits per day, so a collision is rare but real, and it
 * lands in exactly the orphaned-reservation-then-EEXIST state the collision
 * guard exists to prevent. Nobody chose the id, so re-minting is the right
 * answer; a bound keeps a saturated run directory from spinning.
 */
const MINT_RETRIES = 4;

declare const mintedRunIdBrand: unique symbol;

/**
 * A run id that came out of `mintRunId()` — AC2's provenance, enforced by the
 * type system. Nominal, so a hand-written string of the right SHAPE is still not
 * one: `dispatch(brief, deps, { runId: "qds-20260101-abc123" })` does not
 * compile, which is the guarantee AC2 asks for and a regex can never give.
 *
 * The brand is the COMPILE-TIME half only. `MINTED_RUN_ID_RE` below stays,
 * because the callers that matter build their ids at runtime — the CLI from
 * argv, DF3.2's fan-out from its own arms — and a cast past the brand must still
 * be refused. Confined to this boundary on purpose: the providers layer takes
 * plain `string` run ids, and branding down there would spread a fleet concern
 * across every driver.
 */
export type MintedRunId = string & { readonly [mintedRunIdBrand]: true };

/**
 * `LogEntry.requestId` is a required string, but a refusal can fire before the
 * correlation resolves. Minting a UUID there would forge a correlation no other
 * row shares, so the absence is named instead.
 */
const UNRESOLVED_REQUEST_ID = "unresolved";

/**
 * Typed refusal surfacing. `src/` throws; the CLI (`scripts/fleet.ts`) maps
 * `exitCode` onto the process exit and prints the payload. One code, one
 * meaning (F3 — this CLI's own table, never P1.6's).
 *
 * The union stops at 5 while `report()` clamps to 6. That asymmetry is
 * DELIBERATE (D5), established against every construction site rather than
 * read off the two declarations: 6 is not a refusal. `scripts/fleet.ts`'s
 * header defines it as "the verb's own work LANDED but the invocation could
 * not finish it or report it", so every real 6 site emits TWO things — the
 * completion line on stdout through `reportCompletion`, which IS the record
 * that the work landed, and a diagnostic on stderr naming the leftover. A
 * throw produces only the second: `report()` renders the error envelope and no
 * path remains on which to print the first, so a thrown 6 would destroy the
 * landed-work record that exit 6 exists to preserve. It is self-contradictory
 * within one frame besides — a function that throws has by definition not
 * completed the work a 6 asserts DID complete.
 *
 * 6 is therefore produced by RETURNING, never by throwing: `finish()` folds
 * `code === 0 && outputIncomplete`, and the verbs return it outright (attach's
 * `attach-not-acked`, teardown's `keyUnattributable || !markCleared ||
 * !reportedLanding`). Widening this union would not unblock a missing case —
 * no construction site wants 6 — it would delete the compile-time guard that
 * keeps the wrong way to signal 6 from compiling.
 *
 * `report()`'s ceiling stays 6 regardless: it takes `unknown`, so it must
 * still refuse a code built by a JS caller or through a cast. Narrowing it to
 * match this union would trade a real runtime defence for a cosmetic symmetry.
 *
 * Narrowing FURTHER is the house pattern wherever a site produces less than
 * the whole table — `refuse` below is this same 1–5, `fanout-primitive.ts`'s
 * is `2 | 5`, `roster/validate.ts`'s is `0 | 1 | 2`.
 */
export class FleetError extends Error {
  constructor(
    public readonly exitCode: 1 | 2 | 3 | 4 | 5,
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FleetError";
  }
}

/**
 * The run-id grammar as an exit-2 refusal — the ONE fleet-side enforcement
 * point (`scripts/fleet.ts`'s verbs and `statusRun` both route through here).
 *
 * The grammar itself is the record store's and is never restated: composing
 * `RUN_ID_RE`/`RUN_ID_MAX` locally gave every entry point its own copy, so
 * tightening the store's rule (it moved to the RFC 1123 label grammar in this
 * story) silently left the CLI accepting a different set of ids than
 * `scripts/sandbox-teardown.ts`, which delegates. `assertValidRunId`'s message
 * already names the pattern and the cap, so the operator loses nothing.
 */
export function assertFleetRunId(runId: unknown): asserts runId is string {
  try {
    assertValidRunId(runId);
  } catch (e) {
    // The store's refusal IS the validation verdict — it throws only on a
    // failed shape check (its body admits no other throw), so anything that
    // escapes as the store's TYPED verdict is an operator error (exit 2).
    // A THROW OUT OF THE CHECK ITSELF — a bug in a future edit, or a store
    // whose assert misbehaves — is NOT that: classifying it as invalid-run-id
    // blamed the operator's id for a programmer error. Discriminate on the
    // store's dedicated `InvalidRunIdError` class, not the message text: a
    // stable typed discriminator survives any rewording of the message, and
    // every other error takes the honest exit-1 route.
    if (!(e instanceof InvalidRunIdError)) {
      throw new FleetError(
        1,
        "run-id-check-failed",
        `the run-id grammar check itself failed: ${errorMessage(e)}`,
        "retry once, then report this — nothing was provisioned",
      );
    }
    // The store's message, echo bounded, redaction composed: see
    // `storeRunIdRefusal` for why neither half alone is enough.
    throw new FleetError(
      2,
      "invalid-run-id",
      storeRunIdRefusal(e, runId),
      "run ids come from `fleet dispatch`; list them with `fleet status`",
    );
  }
}

/** How much of a rejected run id is echoed back. See `runIdEcho`. */
const RUN_ID_ECHO_CHARS = 12;

/**
 * A rejected run id as operator-facing text: bounded, escaped, redacted.
 *
 * The argument is raw argv. Three things are true of it at once and this is the
 * one helper that holds all three:
 *
 *  - it is UNBOUNDED, so echoing it verbatim puts an arbitrary-length copy of
 *    argv into stderr, the dispatch log and the FleetError payload;
 *  - it may be a SECRET — an operator who fat-fingers a provisioning key into
 *    the run-id argument must not have it echoed anywhere, which is why
 *    `redactSecrets` runs over the head and is allowed to eat it whole;
 *  - it may carry CONTROL CHARACTERS, same as every other third-party string
 *    this module renders (`escapeText`).
 *
 * The LENGTH is reported instead of the tail, because "which argument did I get
 * wrong" is answered by a short head plus a length, and neither reconstructs a
 * key. `RUN_ID_ECHO_CHARS` is well under `redactSecrets`' 40-char floor, so the
 * head survives for an ordinary typo and is redacted whole for a known issuer
 * prefix — which is itself the right answer: it tells the operator they pasted a
 * secret without repeating any of it.
 */
function runIdEcho(value: unknown): string {
  if (typeof value !== "string") {
    // Same bounded treatment as the string arms: a non-string's coercion can be
    // an unbounded join, so it gets the LENGTH-bound head plus the count rather
    // than the whole thing. Both callers type-guard today; this arm is the
    // boundary's own defence for the day one stops.
    const text = escapeText(value);
    if (text.length <= RUN_ID_ECHO_CHARS) return `"${redact(text)}"`;
    return `"${redact(text.slice(0, RUN_ID_ECHO_CHARS))}…" (${text.length} chars)`;
  }
  if (value.length <= RUN_ID_ECHO_CHARS) return `"${redact(escapeText(value))}"`;
  return `"${redact(escapeText(value.slice(0, RUN_ID_ECHO_CHARS)))}…" (${value.length} chars)`;
}

/**
 * The `runIdEcho` hint as a SUFFIX to the record store's own refusal.
 *
 * The store's message carries the grammar, the cap AND its own echo, and that
 * echo is exactly what INV-6 eats: `redactSecrets`' long-token arm redacts any
 * ≥40-char run that is not a hex digest, so a mistyped 96-character argument
 * came back as `invalid run id: "«redacted»" (must match … )` — correct, and
 * unactionable. Appended rather than spliced, so the grammar stays the store's
 * single copy (see `assertFleetRunId`).
 *
 * Only for ids too long to survive that arm: a short one is already echoed
 * intact by the store, and repeating it would be noise.
 */
function runIdSupplied(value: unknown): string {
  return typeof value === "string" && value.length > RUN_ID_ECHO_CHARS
    ? ` — supplied: ${runIdEcho(value)}`
    : "";
}

/**
 * The record store's invalid-run-id message with its embedded echo made safe at
 * BOTH ends of the redactor's reach — both call sites that surface it
 * (`assertFleetRunId`, and the step-4 backstop in `dispatch`).
 *
 * The store interpolates `JSON.stringify(id)` verbatim. The bounded form is
 * spliced over that echo UNCONDITIONALLY — there is no length branch left. The
 * old ≥40-char arm assumed `redactSecrets`' long-token floor ate every long
 * echo at the sinks, but the arm EXEMPTS hex digests, so a pasted ≥40-char hex
 * argument survived `redact` verbatim on stderr, in the dispatch log and on the
 * payload while the suffix repeated it in bounded form right next to the leak.
 * Keyed instead on whether the store's echo SURVIVED REDACTION:
 *
 *  - echo still present after `redact` (short ids, hex-digest-exempt ones) ⇒
 *    splice the bounded copy over it — no full-length survivor anywhere;
 *  - echo already gone (the long-token or URL arms ate it) ⇒ keep the redacted
 *    text and let `runIdSupplied` carry the bounded copy — splicing there would
 *    REPLACE information the redactor deliberately kept (a management URL's
 *    scheme and host, which tells the operator which substrate they pasted)
 *    with a twelve-character head.
 *
 * The grammar sentence stays the store's single copy either way (see
 * `assertFleetRunId` for why it is never restated here).
 */
function storeRunIdRefusal(e: unknown, value: unknown): string {
  const raw = errorMessage(e);
  if (typeof value !== "string") return `${redact(raw)}${runIdSupplied(value)}`;
  // A function replacement: `JSON.stringify` output can contain `$`, which a
  // string replacement pattern would expand.
  const storeEcho = JSON.stringify(value);
  const redacted = redact(raw);
  return redacted.includes(storeEcho)
    ? redacted.replace(storeEcho, () => runIdEcho(value))
    : `${redacted}${runIdSupplied(value)}`;
}

/**
 * Structural slice of CostLedger the budget gate reads — enough for DI fakes,
 * and derived from `CostLedger` itself so a fake cannot drift from the real
 * signatures the gate is compiled against (`as never` erased exactly that).
 */
export type LedgerLike = Pick<CostLedger, "config" | "issueBudgetSnapshot" | "admitIssue" | "close">;

export interface DispatchDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  /**
   * INV-1 manifest containment root — the trust anchor the brief's
   * `manifestPath` must resolve beneath. Defaults to `process.cwd()`.
   *
   * TRUSTED CONFIGURATION. It is safe here for the same reason `driver`,
   * `store` and `ledgerFactory` are: `DispatchDeps` is the injection surface
   * the CALLER controls, never a channel the brief can reach. No caller may
   * thread brief-derived data into it, directly or transitively — the brief is
   * the untrusted input, and a root computed from it (`dirname(manifestPath)`
   * being the obvious trap) makes every candidate its own root and the
   * beneath-root assertion vacuous.
   *
   * A seam, not a relaxation: the value is handed to the same `loadManifest`
   * check as before, which realpath-resolves it and refuses an unresolvable
   * root outright.
   */
  repoRoot?: string;
  /** Ledger factory — the ONLY way the budget gate touches storage. */
  ledgerFactory: () => LedgerLike;
  quotaLimits?: LoadedQuotaLimits;
  /** App port to expose; omit for none (httpsUrl then comes from create). */
  port?: number;
  /**
   * The already-resolved correlation id (INV-4-bis). The CLI parses the brief,
   * runs `resolveBriefRequestId` over it and builds the run-record store and
   * the driver with the result, so the record's and the driver's log lines
   * carry the SAME id as the ack. Absent ⇒ dispatch resolves it itself.
   */
  requestId?: string;
  /** Wall clock for the 600s ceiling (test seam). */
  clock?: () => number;
  /** Dispatch wall-clock ceiling in ms (default 600_000). */
  timeoutMs?: number;
  /** Host-side dispatch log; defaults beside the run-record dir, so `--dir` moves it. */
  dispatchLogPath?: string;
  /** Setup-gate seam (test/injection). Default: exedev `.setup`, else fakeGate. */
  setupGate?: (driver: ProviderDriver, vm: string, opts: GateOpts) => Promise<SetupGateResult>;
  /**
   * Per-run key cap in integer micro-dollars (DF3.2/DD-9). Validated at dispatch
   * before reaching the budget gate: if provided, must be a positive integer no
   * greater than `Number.MAX_SAFE_INTEGER`. Flows to the budget gate's
   * `keyCapMicroUsd` — the ceiling it clamps into `admittedCeilingMicroUsd`,
   * which becomes the minted key's provider-side hard USD limit at mintRunKey.
   * Absent/undefined ⇒ the single-run default (`defaultKeyCapMicroUsd`) —
   * behavior identical to pre-DF3.2.
   */
  capMicroUsd?: number;
}

export interface GateOpts {
  runId: string;
  commitSha: string;
  requestId: string;
}

export interface DispatchResult {
  runId: string;
  requestId: string;
  state: "ready";
  vmName: string;
  httpsUrl?: string;
}

/** The dispatcher mints the runId — callers never invent one (AC2, §5.3). */
export function mintRunId(): MintedRunId {
  const id = newId("qds") as MintedRunId;
  rememberMintedRunId(id);
  return id;
}

/**
 * The correlation id a parsed brief resolves to, by exactly the rule dispatch
 * applies: a strict UUID v4 `requestId` is honoured, anything else is dropped
 * so the resolver mints a fresh one (AC1 — a malformed id is not a validation
 * failure).
 *
 * Exported for the CLI, which must construct the run-record store and the
 * driver with the SAME id dispatch will report in its ack: minting one before
 * the brief is parsed makes the record's and the driver's log lines carry a
 * different correlation id from the ack (INV-4-bis). The parse is the CLI's;
 * the rule is this module's, and there is one copy of it.
 */
export function resolveBriefRequestId(parsedBrief: unknown): string | undefined {
  const supplied = (parsedBrief as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof supplied === "string" && isValidUuidV4(supplied) ? supplied : undefined;
}

/** Every URL-shaped run in a piece of free text — the unit both redactors work on. */
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Scheme + host, with the two parts of an origin that are never a locator
 * removed: userinfo ALWAYS (a credential by construction), and any host LABEL
 * of 16+ characters (a long label is itself a deep link on the substrates the
 * factory uses). The rest of the host survives because an operator has to
 * recognise WHICH box the line is about.
 *
 * Parsed, not sliced. The previous rule tested the whole `//host` run against
 * the same 16-char floor, so `https://abcdefghijklmnopq` came out as
 * `https:/«redacted»` — a malformed single-slash URL that loses the very
 * scheme-and-host guarantee the rule exists to keep — while
 * `https://tok@x.io/` kept `tok@x.io` verbatim, because userinfo and host are
 * one segment and length was the only test applied. Length is not a property
 * of a secret; that is the argument the path rule below already makes.
 */
function safeOrigin(url: URL): string {
  const host = url.hostname
    .split(".")
    .map((label) => (label.length >= 16 ? "«redacted»" : label))
    .join(".");
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/**
 * INV-6: management/deep-link URL parameters are redacted before logging.
 *
 * Applied WHOLE-SEGMENT: the query string and fragment go entirely and EVERY
 * path segment after the host goes with them (see `safeOrigin` for what survives
 * of the origin, and why). Prose around a URL is left alone — an unreadable
 * refusal message is not a security property, and the operator-facing paths this
 * module composes (`repoRoot`, `manifestPath`, the dispatch log) are exactly the
 * text a refusal exists to hand over.
 *
 * INV-4 (key material) is enforced here too, by COMPOSING `redactSecrets` — the
 * same helper `src/providers/step-log.ts` applies to every step line, so a
 * message cannot be safe in one layer and unsafe in the other. It was left out
 * on the argument that this also runs over locally composed strings and the
 * long-mixed-token arm eats an ordinary absolute path. That argument protected
 * the wrong thing: three paths carry text this module did not compose — zod
 * issue messages echo the RECEIVED value, `CorrelationError.message` names the
 * offending field, and an exedev gate assertion `note` is box-controlled text —
 * and all three reach the dispatch log, the structured line and the FleetError.
 * A bare `sk-or-v1-…` has no scheme, so the URL rule above never saw it.
 *
 * The cost is real and accepted: a long mixed-case path with a digit in it
 * (`/Users/x/QDS-Factory/pipelines/df3-1/pipeline.yaml`) is redacted out of a
 * refusal message. A path an operator has to reconstruct is a worse refusal; a
 * key in a persisted log is a worse incident.
 *
 * URLs FIRST, secrets second: the whole-segment rule needs the URL intact to
 * parse, and `«redacted»` is inert to both arms of `redactSecrets`.
 */
function redact(text: string): string {
  return redactSecrets(
    text.replace(URL_IN_TEXT_RE, (raw) => {
      // Prose punctuation trailing the match is NOT part of the URL: the
      // charset above stops only at whitespace/quotes/angle brackets, so a
      // sentence-final or parenthesized link (`…host/path).`) handed the
      // trailing punctuation to `new URL`, which threw on it — and the catch
      // below then redacted the ENTIRE match including the scheme and host
      // that tell the operator which box the line is about. Trim it first;
      // what remains is either a parseable URL (kept) or genuinely
      // unparseable (redacted whole — still fail-closed).
      const trimmed = raw.replace(URL_TRAILING_PUNCT_RE, "");
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        // Scheme matched but the rest did not parse: redact whole rather than
        // guess at its structure — fail closed, like every other unverifiable
        // read in this module.
        return "«redacted»";
      }
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/[^/]+/g, "/«redacted»");
      const stripped = url.search === "" && url.hash === "" ? "" : "«redacted»";
      return `${safeOrigin(url)}${path}${stripped}`;
    }),
  );
}

/**
 * A brief-supplied URL as a LOGGABLE link (INV-6, `issueUrl`).
 *
 * `redact` is the wrong tool here: it eats the path, and an issue link with no
 * path is not a link. The schema constrains `issueUrl`'s SCHEME only, so
 * `https://github.example/o/r/issues/1?installation_token=…` reached both
 * structured lines verbatim — on the same line where the box URL was redacted,
 * and INV-6's own docstring names the query string as the first thing to strip.
 * Userinfo, query and fragment always go; the path stays clickable.
 *
 * The path is not kept VERBATIM, though — it goes through `redactSecrets`, so a
 * token parked in a path segment (`/t/ghs_…/o/r/issues/1`) does not ride into
 * both structured lines just because it sits where a link's readable part
 * normally does. The ≥16-char rule `safeOrigin` applies to host labels is
 * deliberately NOT applied here: an ordinary repository name is often that
 * long, and a link whose path is redacted is the thing this helper exists to
 * avoid. Residual, accepted: a short unprefixed path secret still survives —
 * the same shape-alone gap `redactSecrets` documents for its own arm 2.
 */
function linkSafe(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return `${safeOrigin(parsed)}${parsed.pathname === "/" ? "" : redactSecrets(parsed.pathname)}`;
  } catch {
    return "«redacted»";
  }
}

/**
 * Third-party text as ONE line an operator stream can render literally.
 *
 * `redact` is a SECRET redactor; it is not a control-character escaper, and the
 * two are different guarantees. Text this module did not compose reaches stderr,
 * the CLI-printed payload and the dispatch log — and three sources of it are
 * chosen by somebody else: a zod issue echoes the received value,
 * `CorrelationError.message` names the offending brief field, and an exedev gate
 * assertion `note` is box-controlled. A `note` of `"\x1b[2J"` clears the
 * operator's terminal; one of `"\nFLEET dispatch ok runId=fake"` forges a line
 * in a log an operator (or a scraper) reads back.
 *
 * `JSON.stringify` minus its wrapping quotes — the exact escaping the
 * `invalid-brief` path already applies for exactly this reason, factored out so
 * the three sinks cannot drift. The quotes are dropped because every caller here
 * interpolates into prose or into a list ELEMENT that is quoted by its own
 * serializer; a caller that wants them uses `JSON.stringify` directly.
 *
 * Takes `unknown` and never throws, for the same reason `errorMessage` passes
 * its value uncoerced to `redactSecrets`. An assertion `note` is DECLARED
 * `string` (setup-gate.ts) and `deps.setupGate` is an injection seam, which is
 * the whole reason the gate block guards its reads at all — so a `String(note)`
 * at the call site put an unguarded coercion inside the exit-3 refusal path,
 * where a throwing `toString` escapes to the outer catch and downgrades the
 * refusal to exit-1 `dispatch-failed`. Both coercions are guarded HERE, once.
 */
function escapeText(text: unknown): string {
  try {
    return JSON.stringify(typeof text === "string" ? text : String(text)).slice(1, -1);
  } catch {
    return "«unprintable»";
  }
}

/**
 * INV-6 over a whole refusal payload: every string leaf, walking arrays and
 * plain objects.
 *
 * Redaction used to be a per-call-site convention — `refuse` redacted only
 * `message`, and each caller was expected to remember `redact` on the
 * strings it put in the payload and on the remediation. A convention a caller
 * has to remember is one a caller eventually forgets, and the ones that forgot
 * (`errorRemediation` on a provider throw, the gate's `debug: … teardown …`
 * string) were exactly the paths carrying third-party free text. Applied once,
 * at the choke point.
 *
 * ponytail: no cycle guard. Every payload in this module is a locally built
 * object literal of primitives, arrays and literals — there is nowhere for a
 * cycle to come from. Add one if a payload ever carries a caller's object.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/**
 * Is this an exedev box? ONE predicate, every exedev-shaped decision.
 *
 * It has to decide which gate runs, whether the roster is pre-checked, where
 * the key file lands AND whether the repo is cloned at the pinned SHA. Keyed
 * off different things — gate on `.setup`, clone on `.fill`, key path once on
 * `name === "fake"` — a driver carrying one primitive and not the other was
 * handed an incoherent lifecycle: `fill` without `setup` cloned the repo and
 * then ran the DIR-BOX gate over it, while `setup` without `fill` ran the real
 * five-assertion gate against a `commitSha` nothing had ever checked out. Both
 * capabilities, or neither.
 *
 * A type PREDICATE, so the narrowed driver goes into `realSetupGate` and
 * `fillExeDev` as itself. The call sites used to launder it through `as never`
 * / `as (vm, o) => Promise<unknown>` — the very casts `LedgerLike` was
 * introduced to eliminate — which switched off checking on the two calls that
 * most need it.
 */
type ExedevCapable = ProviderDriver &
  Parameters<typeof realSetupGate>[0] & {
    fill(vm: string, opts: { runId: string; repoUrl: string; commitSha: string }): Promise<void>;
  };

function isExedevDriver(driver: ProviderDriver): driver is ExedevCapable {
  const d = driver as ProviderDriver & { setup?: unknown; fill?: unknown };
  return typeof d.setup === "function" && typeof d.fill === "function";
}

/** Dir boxes are plain host dirs — the key lands box-relative beside the box dir root. */
function envFileFor(driver: ProviderDriver): string | undefined {
  return isExedevDriver(driver) ? undefined : ".env";
}

/**
 * Does a record already exist for this id? `get` is the store's only reader;
 * absence is ENOENT on the typed code, and every other read failure is a real
 * problem that must not be read as "free to reuse".
 *
 * The RETURN VALUE is read, not just the absence of a throw. `get` is declared
 * `RunRecord`, so an absence sentinel at the driver boundary is not a modelled
 * outcome — but a store that signalled absence by returning `undefined` OR
 * `null` (the shape a JSON-backed store hands back for "no such file") would
 * have made every mint report "taken", and dispatch bricks with
 * `run-id-unmintable` for a run directory that is in fact empty. Both count as
 * absent.
 */
function recordExists(store: RunRecordStore, runId: string): boolean {
  try {
    const record = store.get(runId);
    return record !== undefined && record !== null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * The one way this module turns a caught value into operator-facing text.
 *
 * `throw` takes any value, and a driver, key API or store is third-party code
 * from this module's point of view: `throw null` and `throw "boom"` are both
 * legal. A bare `(e as Error).message` read on those throws a TypeError from
 * inside the catch block, which replaces the real refusal — the diagnosis the
 * operator needs — with an unrelated crash out of the error path itself.
 *
 * INV-4 lives HERE, at that boundary, because this is the only place third-party
 * free text becomes operator-facing text in this module — and key material can
 * only arrive that way. `deliverRunKey` hands the plaintext key to
 * `driver.exec`, and an exec wrapper that reports a failure by echoing its
 * invocation puts the key in the thrown message; `redact` is no help (it matches
 * `https?://…`, and a bare `sk-…` has no scheme). The step-7 catch guards only
 * the path where the RACE is won — when the wall clock wins instead, that catch
 * never sees the provider error at all, and `within`'s abandoned-step handler
 * logs it. Same rule and same helper (`redactSecrets`) as
 * `src/providers/step-log.ts` applies to every step line, so a message cannot be
 * safe in one layer and unsafe in the other.
 *
 * `redact` now composes the same helper, so this is defence in depth rather
 * than the only application of it: this one runs at the point the third-party
 * text is READ, before it can be interpolated into a string a call site forgets
 * to route through `refuse`.
 */
function errorMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  // `e` UNCOERCED on the fallback arm. `String(e)` here raised its TypeError
  // OUTSIDE `redactSecrets` — on `Object.create(null)`, or any throw whose
  // `toString`/`Symbol.toPrimitive` throws — and escaped the catch block this
  // helper exists to keep alive, replacing the refusal with a crash from the
  // error path. `redactSecrets` takes `unknown` and its own `asText` already
  // guards exactly that (step-log.ts), so the pre-coercion was never doing work
  // — only moving the throw somewhere unguarded.
  return redactSecrets(typeof message === "string" ? message : e);
}

/**
 * The provider's own `code`, as a PAYLOAD fragment — never as the FleetError's
 * code.
 *
 * The module header holds "one code, one meaning (F3 — this CLI's own table)".
 * Reading a caught error's `.code` straight into `FleetError.code` broke that:
 * `provision-failed` became `EACCES`/`ECONNRESET`/`SQLITE_BUSY` depending on
 * which infrastructure failed, so an operator grepping the dispatch log for the
 * fleet code missed every real failure of that step. The fleet code stays
 * fixed and the provider's goes here, where it is diagnosis rather than
 * classification. Absent when the throw carried none — an absent code is named
 * by omission, not by a fabricated fallback.
 *
 * Typed provider errors carry `code`/`remediation`; a bare throw carries
 * neither — and a `null`/`undefined` throw carries no properties to read at
 * all, so the access itself is optional (see `errorMessage`).
 */
function providerCodePayload(e: unknown): { providerCode?: string } {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? { providerCode: code } : {};
}

/**
 * The provider's own remediation when it has one. Third-party free text, so it
 * gets the same INV-4 treatment as `errorMessage`; the FALLBACK is composed here
 * and does not (see `redact` on why a path must survive).
 */
function errorRemediation(e: unknown, fallback: string): string {
  const remediation = (e as { remediation?: unknown } | null | undefined)?.remediation;
  return typeof remediation === "string" ? redactSecrets(remediation) : fallback;
}

/**
 * Dispatch: validate → resolve → admit → record → box → key → fill → gate →
 * expose → ack.
 *
 * @throws {FleetError} exit 2 schema/correlation/manifest · exit 3 setup gate ·
 *     exit 5 admission refusal · exit 1 wall-clock expiry and post-provision
 *     infrastructure failure.
 */
/**
 * In-process single-flight over dispatch's admission critical section — DF3.2's
 * closure of the fleet-ceiling TOCTOU the df3-1 round-10 review deferred as
 * finding DF13 (ledger: `_bmad-output/workflow-state/code-review/pr123/
 * triage.md`; handoff: the df3-2 story file).
 *
 * `checkHeadroom` is a READ, not a lock (quota.ts's own docstring), so two
 * in-process dispatches entering step 5 within one `driver.list()` round trip
 * while `liveVms === ceiling - 1` BOTH pass and BOTH create — and the overshoot
 * scales with N the moment fan-out runs arm admissions concurrently. Running
 * headroom-read → decision → box-create through one promise chain closes the
 * in-process half: the queued dispatch re-lists AFTER the holder's box exists
 * and takes the ordinary `vm-ceiling` refusal, exactly as the sequential case
 * always did.
 *
 * Scope is deliberately narrow on BOTH ends:
 * - IN-PROCESS only. Two CLI invocations (separate processes) can still race,
 *   and so can a fan-out's aggregate `checkHeadroom(N)` against a concurrent
 *   plain dispatch's own list. Closing those needs a quota-layer intent record
 *   mirroring cost-ledger's `admitIssue` reserve→create→settle shape, per the
 *   round-10 handoff's follow-up — not this module's call to make.
 * - The section ends the moment the BOX exists. Key mint, setup gate and
 *   expose run OUTSIDE it: a whole-dispatch lock would serialise DF3.2's
 *   N-arm fan-out (the reason this seam was previously left open) — arms
 *   serialize only their record→box moment and still gate concurrently.
 *
 * Promise-chain mutex: `await held` before the section and `release()` in a
 * `finally` hand the section to the next waiter on EVERY exit, refusal throws
 * included. The `finally` is structural, not stylistic — a leaked release
 * would park every future in-process dispatch forever.
 */
let admissionTail: Promise<void> = Promise.resolve();
async function withAdmissionSingleFlight<T>(section: () => Promise<T>): Promise<T> {
  const held = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await held;
  try {
    return await section();
  } finally {
    release();
  }
}

/**
 * The refusal machinery of one `dispatch()` call: the facts a refusal reports
 * (filled in as each becomes known), and the four things every step does with
 * them — `refuse`, `remaining`, `timedOut`, `within`.
 *
 * Extracted verbatim from `dispatch()` (F003). The `ctx*` locals are the fields
 * and the closures are the methods; nothing else moved, and no behaviour did.
 * `timings` is passed by REFERENCE, not owned: `dispatch`'s own `phase()` writes
 * into the same object the refusal and ack lines read.
 */
class DispatchContext {
  constructor(
    readonly now: () => number,
    readonly wallStart: number,
    private readonly timeoutMs: number,
    private readonly dispatchLog: string,
    private readonly timings: Record<string, number>,
  ) {}

  // Refusal context: filled in as each fact becomes known. A refusal that fires
  // before a fact exists reports `null` for it — never `""`, never a fabricated
  // id (the observability contract).
  // NOT seeded from `deps.requestId`: that value is UNVALIDATED until step 2's
  // shape check, and a refusal that fires before it (`timeout-invalid`,
  // `port-invalid`, `invalid-brief`) would stamp an exit-2-worthy string onto
  // the correlation key of an AC4 evidence row. Named `unresolved` until the
  // shape check has passed, like every other fact this context holds.
  requestId: string | null = null;
  repoSlug: string | null = null;
  issueId: number | null = null;
  runId: string | null = null;
  vmName: string | undefined;
  gate: SetupGateResult | undefined;
  /**
   * The box's URL, as soon as one is known. On the refusal payload as well as
   * the ack: a failure between `expose` and the record write leaves a box that
   * is PUBLIC and reachable while the record carries neither `httpsUrl` nor
   * `ports`, and a payload carrying only `vmName` told the operator a public box
   * existed with no way to learn its address.
   */
  httpsUrl: string | undefined;
  /**
   * Has provisioning been ATTEMPTED for `this.runId` — i.e. may a record exist?
   *
   * The remediation commands `refuse` composes used to be gated on
   * `this.runId !== null`, which is set INSIDE the mint-collision loop, before the admission
   * gates and before `store.create`. Every pre-provision refusal after step 4
   * therefore advertised `fleet teardown <id>` for an id with no record — and on
   * the `run-id-unmintable` path the id was the last COLLIDING one, which by
   * definition belongs to someone else's live run, so the payload told a tier-1
   * agent to tear THAT down.
   *
   * Set immediately before `provisionAdmittedRun`, not after it: the step
   * straddles the record (record first, then box), so a throw from either half
   * can leave a real record — teardown is the right advice for both, and it is
   * idempotent over "no record" anyway.
   */
  provisionAttempted = false;

  /** Record one step's wall time — the ack line and every refusal report these. */
  phase(name: string, ms: number): void {
    this.timings[name] = ms;
  }

  /**
   * The one exit path every refusal takes: host-side dispatch log (AC4), one
   * structured log line, and a `FleetError` carrying the operator's next
   * commands. INV-5 is why nothing here destroys anything — once a box exists,
   * a refusal names its teardown command and leaves it alive.
   *
   * INV-6 applies to ALL the free text — `message`, `remediation`, and every
   * string leaf of the caller's payload — and is applied HERE rather than by
   * convention at each call site.
   *
   * The exemption below is narrower than it used to read, and the old wording
   * was the bug. It said the command lists were exempt because "those are built
   * here from the run id" — true of the FALLBACKS and false of the branch
   * actually taken on the path that matters: `this.gate?.debugCommands` and
   * `this.gate?.teardownCommand` come from `realSetupGate`, i.e. from the BOX, and
   * were spread in AFTER `redactDeep` had run over everything else. A gate whose
   * debug command embeds a management URL with a query string therefore reached
   * operator output verbatim, on the same object where every other string leaf
   * was redacted. So:
   *
   *  - ids and the LOCALLY COMPOSED `bun scripts/fleet.ts …` fallbacks stay
   *    verbatim — a redacted teardown command is one the operator cannot use,
   *    and redaction is a no-op on them anyway (no URL, no ≥40-char token);
   *  - `httpsUrl` goes through `redact`, as the ack log line's copy already
   *    did: it is PROVIDER-supplied (`vm.httpsUrl`, `expose`), so the "no URL
   *    in it" assumption behind keeping it verbatim was false for exactly the
   *    values that matter. The run RECORD keeps its full-fidelity copy on
   *    purpose — see the expose-path store write;
   *  - anything the GATE supplied is substrate-controlled text and gets the same
   *    treatment as every other string leaf.
   *
   * That also resolves the contradiction with the gate-failure call site, whose
   * remediation composes the very same strings and IS redacted by the
   * `redact(rawRemediation)` above. One rule now covers both sinks: gate text is
   * redacted wherever it appears, locally composed commands never are.
   */
  refuse(
    // 1–5, and it is the SECOND declaration of that union rather than a
    // reference to `FleetError`'s — see the reasoning there for why 6 is
    // absent from both (D5: 6 asserts landed work and a throw asserts the
    // opposite). Independent on purpose: this helper is narrower in KIND, not
    // merely in range — everything it builds is logged `phase: "refused"`,
    // `status: "error"` below, so a 6 arriving here would be recorded as a
    // refusal of work that had in fact completed. `tests/fleet/verbs.test.ts`
    // binds the two declarations together so they cannot drift apart.
    exitCode: 1 | 2 | 3 | 4 | 5,
    code: string,
    rawMessage: string,
    rawRemediation: string,
    payload: Record<string, unknown> = {},
    /**
     * Override the exit-code-derived retry classification. Exactly one caller
     * needs it: an exit-3 gate refusal whose failing assertion is a SUBSTRATE
     * failure (the probe never ran) is retryable, and the default mapping calls
     * every non-1 exit `logic` — discarding the one distinction `substrateFailure`
     * exists to surface, one layer above where it was computed.
     */
    exitStatusOverride?: ExitStatus,
  ): FleetError {
    const message = redact(rawMessage);
    const remediation = redact(rawRemediation);
    const redactedPayload = redactDeep(payload) as Record<string, unknown>;
    try {
      appendDispatchFailure(this.dispatchLog, {
        repoSlug: this.repoSlug,
        issueId: this.issueId,
        requestId: this.requestId,
        code,
        message,
      });
    } catch (e) {
      // The log must never mask the refusal it records — but swallowing it is
      // how AC4 evidence goes missing, so it is named on stderr (the fallback
      // appendDispatchFailure's own contract documents).
      //
      // GUARDED, for the same reason the `log` call below is: `refuse` runs
      // inside the deadline `setTimeout` callback, and a piped CLI whose reader
      // has exited makes this write throw EPIPE. Thrown from a timer callback
      // that is an uncaughtException — the process dies instead of the race
      // rejecting — and on the gate path it downgrades an exit-3 refusal to a
      // bare exit-1. Redacted like every other free-text sink here.
      try {
        process.stderr.write(
          `dispatch-log append to ${this.dispatchLog} failed (${code}): ${redact(errorMessage(e))}\n`,
        );
      } catch {
        // nothing left to report it on
      }
    }
    let durationMs = 0;
    try {
      // GUARDED: `refuse` runs inside the deadline `setTimeout` callback, so a
      // throwing `deps.clock` here is an uncaughtException that kills the
      // process instead of throwing the exit-code refusal every comment on this
      // function promises is guarded. Zero is a diagnosed absence, same rule as
      // `remaining`'s non-finite arm.
      durationMs = this.now() - this.wallStart;
    } catch {
      durationMs = 0;
    }
    try {
      log({
        requestId: this.requestId ?? UNRESOLVED_REQUEST_ID,
        operation: "fleet.dispatch",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: durationMs,
        durationMs,
        status: "error",
        error: { code, message },
        runId: this.runId,
        verb: "dispatch",
        phase: "refused",
        // exit 1 is a timeout or a substrate failure — retryable, hence
        // "transient"; every other refusal is the brief's or the budget's own,
        // unless the caller KNOWS otherwise (see `exitStatusOverride`).
        exitStatus: exitStatusOverride ?? ((exitCode === 1 ? "transient" : "logic") as ExitStatus),
        // Nested, not spread: `timings` is a `Record<string, number>`, so a
        // spread lets a future `phase("status", …)` overwrite `status`,
        // `runId` or `exitStatus` with a number and no compile error.
        timings: { ...this.timings },
      });
    } catch {
      // `refuse` is called from inside the deadline `setTimeout` callback, where
      // a throwing log sink is an uncaughtException that kills the process
      // instead of rejecting the race — the same reason `within`'s abandoned
      // handler guards its own log call.
    }
    const refused = new FleetError(exitCode, code, message, remediation, {
      ...redactedPayload,
      runId: this.runId,
      ...(this.vmName === undefined ? {} : { vmName: this.vmName }),
      // Redacted like the ack LOG LINE's copy (:redact there too): this payload
      // is operator-facing output, not persistence — the record keeps the only
      // full-fidelity URL on purpose (see the expose-path store write).
      ...(this.httpsUrl === undefined ? {} : { httpsUrl: redact(this.httpsUrl) }),
      // Gated on "a record may exist for this id", NOT on "an id was chosen" —
      // see `this.provisionAttempted`. A pre-provision refusal has nothing to tear
      // down, and naming a teardown for an id this dispatch never provisioned is
      // at best noise and at worst an instruction to destroy another run.
      // SHA-GUARDED, mirroring the gate-failure call site's own guards: the gate
      // is an injection seam, so `teardownCommand` can be ANY truthy non-string
      // and `debugCommands` any truthy non-array. The old reads crashed or
      // mistyped right here INSIDE refuse — a non-string teardownCommand threw
      // out of `redact`'s `.replace`, and that crash escaped the gate refusal,
      // re-crashed in the outer catch's fallback refuse, and left a bare exit 1
      // with every piece of AC4 evidence gone. Non-string ⇒ the locally composed
      // fallback (`errorRemediation`'s rule), array elements ESCAPED
      // (`escapeText`) as well as redacted — the same treatment the remediation
      // string gets, so a newline-bearing command cannot forge a log line here
      // either.
      ...(this.runId === null || !this.provisionAttempted
        ? {}
        : {
            debugCommands:
              Array.isArray(this.gate?.debugCommands) && this.gate.debugCommands.length > 0
                ? this.gate.debugCommands.map((cmd) => redact(escapeText(cmd)))
                : [`bun scripts/fleet.ts status ${this.runId}`],
            teardownCommand:
              typeof this.gate?.teardownCommand === "string"
                ? redact(escapeText(this.gate.teardownCommand))
                : `bun scripts/fleet.ts teardown ${this.runId}`,
          }),
    });
    // Marked HERE, at the choke point every refusal exits through: the
    // FleetError now carries the dispatch-log entry, the structured line and
    // the payload. The rethrow arms downstream check this instead of assuming
    // (see the `alreadyRefused` arms).
    refusedOnce.add(refused);
    return refused;
  }

  /**
   * What is LEFT of the ceiling — never a non-finite number.
   *
   * An injected `deps.clock` returning `NaN` (or any arithmetic that goes
   * non-finite) made `left <= 0` FALSE, so the ceiling reported budget
   * remaining while `setTimeout(…, NaN)` fired ~immediately: the two halves of
   * the same guard disagreed. A budget that cannot be computed is an EXHAUSTED
   * budget — fail-closed, like every other unverifiable read in this layer.
   *
   * ponytail: still `Date.now()`-shaped, so an NTP step forward mid-provision
   * can abort a healthy dispatch. `performance.now()` is the monotonic fix, but
   * it does not compose with the `deps.clock` seam the tests drive; the upgrade
   * is a monotonic seam, not a second clock read.
   *
   * FLOORED, because the consumers require an integer and one of them refuses
   * without it: `loadManifestWithSeams` demands `Number.isSafeInteger` of its
   * `callerBudgetMs`, and dispatch turns that refusal into
   * `refuse(2, "manifest-rejected")` — misdiagnosing a slow substrate as a bad
   * manifest, the exact misdiagnosis the `manifestBudgetMs <= 0` pre-check
   * exists to avoid. `Date.now()` cannot produce a fraction; an injected clock
   * seam can, which is the whole point of a seam. Flooring is the fail-closed
   * direction (a sub-millisecond shave off the budget, never an extension).
   */
  remaining(): number {
    const left = this.timeoutMs - (this.now() - this.wallStart);
    return Number.isFinite(left) ? Math.floor(left) : 0;
  }
  /**
   * What an ABANDONED call of this step can still do to the world AFTER the
   * refusal — as an instruction the operator can follow.
   *
   * G3/DF3.2: `within` ABANDONS rather than cancels (the provider seam exposes
   * no AbortSignal), so a step whose deadline fired is a call still IN FLIGHT,
   * not a call that was stopped. It can materialise its effect seconds after
   * this refusal, i.e. after the operator has concluded nothing happened and
   * moved on. Until the driver takes a signal (DF3.2), the only honest
   * remediation is to say so.
   *
   * STEP-AWARE, because three steps leave something behind and they need
   * different instructions. Gated on `step === "create"` alone, the other two
   * got the generic "tear the run down":
   *
   *  - `mint` resolves a provider key live at the full admitted ceiling. Its id
   *    (`keyHash`) reaches the record only when the abandoned call finally
   *    returns, so an operator who tore down BEFORE that lands cannot revoke it
   *    — they have to be told to look again first.
   *  - `setPublic` makes the box PUBLICLY REACHABLE. "Tear the run down" is the
   *    right action but the wrong description: the operator was told the
   *    dispatch failed and has no reason to believe the box went public.
   *
   * `abandoned` is what separates a call that started from one that never did:
   * `within`'s `left <= 0` pre-check throws BEFORE the thunk runs, and telling
   * that operator to go looking for a box (or a key, or a public port) would be
   * the opposite error. It is passed explicitly rather than inferred from
   * `this.provisionAttempted`, which is set once inside the CREATE thunk and is
   * therefore true for every later step whether or not that step ran.
   */
  lateEffectRemediation(step: string, teardown: string): string | undefined {
    switch (step) {
      case "create":
        return `the create call was ABANDONED, not cancelled: a box may still appear for this run. Re-check \`bun scripts/fleet.ts status\` before assuming nothing was created, then tear it down: ${teardown}`;
      case "mint":
        return `the mint call was ABANDONED, not cancelled: a provider key at the full admitted ceiling may go LIVE for this run after this refusal, and its \`keyHash\` reaches the record only when that call returns. Re-check \`bun scripts/fleet.ts status ${this.runId}\` for a keyHash before assuming no key exists, then revoke it by tearing the run down: ${teardown}`;
      case "expose":
        return `the expose call was ABANDONED, not cancelled: a port may still be opened on this box after this refusal. Re-check \`bun scripts/fleet.ts status ${this.runId}\`, then tear the run down: ${teardown}`;
      case "setPublic":
        return `the setPublic call was ABANDONED, not cancelled: this box may become PUBLICLY REACHABLE after this refusal. Do not assume it stayed private — tear the run down: ${teardown}`;
      // The remaining billable-box steps got the generic fallback (or nothing)
      // even though each can land material in a box that is still billing.
      case "clone":
        return `the clone call was ABANDONED, not cancelled: the repository may still be cloned into the billable box at the pinned SHA after this refusal. Re-check \`bun scripts/fleet.ts status ${this.runId}\`, then tear the run down: ${teardown}`;
      case "fill":
        return `the fill call was ABANDONED, not cancelled: the manifest and run context may still be written into the billable box after this refusal. Re-check \`bun scripts/fleet.ts status ${this.runId}\`, then tear the run down: ${teardown}`;
      case "deliver":
        return `the deliver call was ABANDONED, not cancelled: the provider key may still be written into the billable box after this refusal. Re-check \`bun scripts/fleet.ts status ${this.runId}\`, then tear the run down: ${teardown}`;
      case "gate":
        return `the gate call was ABANDONED, not cancelled: the probe may still finish on the billable box after this refusal, and its outcome reaches no record this dispatch writes — inspect the box directly, then tear the run down: ${teardown}`;
      default:
        return undefined;
    }
  }
  timedOut(
    step: string,
    extra: Record<string, unknown> = {},
    /** Did the step's call actually START? (see `lateEffectRemediation`) */
    abandoned = false,
  ): FleetError {
    return this.refuse(
      1,
      "dispatch-timeout",
      `dispatch exceeded ${this.timeoutMs} ms at ${step}`,
      (abandoned && this.runId !== null && this.provisionAttempted
        ? this.lateEffectRemediation(step, `bun scripts/fleet.ts teardown ${this.runId}`)
        : undefined) ??
        (this.runId === null || !this.provisionAttempted
          ? "raise timeoutMs, or retry when the substrate is responsive"
          : // The POST-GATE sample fires on a run the gate already PROVED: box up,
            // key live at the admitted ceiling, record written. The generic
            // "tear the run down" sent the operator after a healthy run — and
            // tearing it down before acking re-spends the issue's cap on a
            // re-dispatch of work that had SUCCEEDED. Inspect and ack first.
            (step === "post-gate"
              ? `the setup gate PASSED — this run is fully provisioned and proven; inspect it (\`bun scripts/fleet.ts status ${this.runId}\`) and ack manually BEFORE destroying anything, then tear it down only if confirmed dead: bun scripts/fleet.ts teardown ${this.runId}`
              : `tear the run down: bun scripts/fleet.ts teardown ${this.runId}`)),
      { step, ...extra },
    );
  }

  /**
   * Bound one await against what is LEFT of the dispatch ceiling — sampling the
   * clock only between steps lets a single hung provider call run forever.
   *
   * A ceiling on AWAITED steps, and only those. The synchronous work is NOT
   * bounded by it and this list is the whole of it: `loadManifest`,
   * `assertWithinBudget`, and step 3's roster block (`existsSync` + the
   * open/fstat/read of `roster.yaml`, on a brief-derived path). The roster
   * block used to go unnamed here, which mattered because it is the one whose
   * input an untrusted brief steers: it now opens `O_NONBLOCK` and fstats the
   * HANDLE, so a planted FIFO is refused rather than blocking `readFileSync`
   * forever with no timer able to fire. A slow filesystem or a SQLITE_BUSY spin
   * inside any of the three still cannot be interrupted, and `dispatch exceeded
   * ${timeoutMs} ms` is discovered at the NEXT sampling point, not at the
   * deadline. The message overstates what the ceiling can promise; closing the
   * rest of the gap means moving that work off the main thread, which is a
   * bigger change than the guarantee is worth. Sampled either side of each, so
   * the overrun is at least attributed to the right step.
   *
   * ponytail: race-and-abandon. The provider seam exposes no AbortSignal, so an
   * expired await is abandoned, not cancelled — which is INV-5's posture
   * anyway (the box stays alive, the operator decides). A real cancel needs a
   * DF2.x driver-interface signal, the same change F2's deferred `driver.list`
   * timeout waits on.
   *
   * `work` is a THUNK, not a promise. Taking a promise meant every call site
   * evaluated its argument eagerly — `within("create", provisionAdmittedRun(…))`
   * — so on the `left <= 0` path the provider call was already in flight when
   * the deadline was checked: the record and the box got created and billed
   * anyway, `this.vmName` was still `undefined` so the refusal carried no
   * `vmName`, and the box billed until the reaper aged it out. With a thunk,
   * "expired" means "never started", for every step at once.
   *
   * Abandoning makes the handler below the ONLY subscriber left on the work
   * promise. A rejection landing after the race was abandoned was an UNHANDLED
   * rejection: under the test runner it was attributed to whichever test ran
   * next and kept the process alive.
   *
   * BOTH settlements are subscribed, not just the rejection. An abandoned
   * `create` that later RESOLVES is the expensive one: `this.vmName` is assigned
   * after the await, so the refusal named no box, and a billable VM existed with
   * its name recorded nowhere at all — the timeout's own remediation says to go
   * looking for it, and this is the line that says what to look for.
   *
   * WHAT it says is `describeLate`'s, per call site. It used to be duck-typed
   * on `value.vm`, which only the `create` step resolves — so the two OTHER
   * steps whose late success is expensive logged nothing identifying at all: a
   * `mint` resolves `{key, hash}` (a live provider key at the full admitted
   * ceiling, whose `hash` is the only handle to it) and a `setPublic` resolves
   * `void` (a box that just became publicly reachable). `within` is generic
   * over every step and cannot know any of that; the call site can, and says so
   * in the one place the fact is in scope.
   *
   * The handler only reports; the timeout stays the thrown error. `abandoned`
   * keeps it silent on the ordinary path, where the race hands the outcome to
   * dispatch and a second line would double-report it.
   *
   * Every free-text read here is a THUNK evaluated INSIDE `logAbandoned`'s
   * try/catch. Evaluated in argument position — `redact(errorMessage(e))`,
   * `redact(vm.httpsUrl)` — they sat OUTSIDE the guard, which wrapped only the
   * `log` call: a throw from `redactSecrets` on hostile input made this handler
   * reject, and an un-awaited `void running.then(…)` with no further subscriber
   * is exactly the unhandled rejection the handler exists to prevent.
   */
  async within<T>(
    step: string,
    work: () => Promise<T>,
    /**
     * What identifies a LATE result of this step, for the abandoned-success
     * line. Runs inside the guarded region, so it may redact and may read the
     * store; a throw from it costs the extra fields, never the line.
     */
    describeLate?: (value: T) => Record<string, unknown>,
    /**
     * Runs when an ABANDONED call of this step REJECTS — the moment a claim
     * written speculatively before the call (expose's `ports`) is known to be
     * phantom and can be retracted. Guarded like `logAbandoned` by the caller
     * below; a throw from it must not become the unhandled rejection this
     * handler exists to prevent.
     */
    onAbandonedFailure?: (e: unknown) => void,
  ): Promise<T> {
    const left = this.remaining();
    if (left <= 0) throw this.timedOut(step);
    let abandoned = false;
    const running = work();
    const logAbandoned = (
      code: string,
      message: () => string,
      extra: () => Record<string, unknown> = () => ({}),
    ): void => {
      // Guarded, for the same reason the log call below is: a throwing
      // `deps.clock` in this handler would re-create the unhandled rejection it
      // exists to prevent. Zero is a diagnosed absence.
      let durationMs = 0;
      try {
        durationMs = this.now() - this.wallStart;
      } catch {
        durationMs = 0;
      }
      try {
        log({
          requestId: this.requestId ?? UNRESOLVED_REQUEST_ID,
          operation: "fleet.dispatch",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: durationMs,
          durationMs,
          status: "error",
          error: { code, message: message() },
          runId: this.runId,
          verb: "dispatch",
          phase: "abandoned",
          step,
          exitStatus: "transient" as ExitStatus,
          ...extra(),
        });
      } catch {
        // a throwing log sink — or a throwing redactor inside either thunk —
        // must not become the unhandled rejection this handler exists to prevent
      }
    };
    void running.then(
      (value: T) => {
        if (!abandoned) return;
        logAbandoned(
          "abandoned-step-succeeded",
          () =>
            `the abandoned ${step} call COMPLETED after the deadline — whatever it created is live and was not on the refusal`,
          () => describeLate?.(value) ?? {},
        );
      },
      (e: unknown) => {
        // Secondary to the timeout that was already thrown: the abandoned
        // provider call failed too, which is what an operator needs to see when
        // the timeout alone does not explain the run.
        if (!abandoned) return;
        logAbandoned("abandoned-step-failed", () => redact(errorMessage(e)));
        // The rejection SETTLES the question the speculative claim hedged on:
        // whatever this call was going to produce will never land, so a claim
        // written before it can now be retracted (the expose call site's port).
        try {
          onAbandonedFailure?.(e);
        } catch {
          // the refusal has gone out — a failed retraction must not become the
          // unhandled rejection this handler exists to prevent
        }
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            // `true`: this call STARTED and is still in flight, so the
            // remediation names what it can still do (see `timedOut`).
            reject(this.timedOut(step, {}, true));
          }, left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Step 3 — manifest + roster. INV-2: pure validation, so it runs before
 * anything billable exists. Lifted out of `dispatch()` verbatim (F003); the
 * two facts that outlive it are what it returns.
 */
function loadManifestAndRoster(
  ctx: DispatchContext,
  deps: DispatchDeps,
  valid: Brief,
): { loaded: ReturnType<typeof loadManifest>; rosterPath: string } {
  // Loading the manifest at fill time meant a manifest defect was discovered
  // after a box, a key and a URL already existed — every input needed to refuse
  // was available at step 1.
  //
  // The containment root is the REPO, not `dirname(manifestPath)`: a root
  // derived from the candidate path makes every path its own root and the
  // beneath-root assertion vacuous. callerBudgetMs: the dispatch wall clock IS
  // the upstream ceiling — the engine never assumes one, and a manifest whose
  // runBudgetMs exceeds the dispatch ceiling must refuse here, not mid-run. What
  // is passed is what is LEFT of that ceiling, not the whole of it: schema
  // validation and correlation have already spent part, so the full figure
  // admitted a manifest with `runBudgetMs === timeoutMs` that was then
  // guaranteed to overrun.
  //
  // `deps.repoRoot` and nothing else: an ambient `process.cwd()` makes the trust
  // anchor of a security guard depend on where the process happened to start.
  // The default keeps every existing caller (the CLI passes none) on cwd.
  // `loadManifest` realpaths it and refuses an unresolvable root, so no
  // resolution is repeated here — a second copy would be the weaker one
  // (manifest.ts avoids Bun's `realpathSync`, which hangs on a planted FIFO).
  const repoRoot = deps.repoRoot ?? process.cwd();
  // Resolved against the CONTAINMENT ROOT, not the process cwd. A relative
  // `manifestPath` is relative to the repo the brief names — resolving it
  // against wherever the dispatcher happened to be started made an identical
  // brief refuse or resolve depending on the caller's cwd, and made `repoRoot`
  // a seam that moved the guard without moving what the guard measures. An
  // absolute path is unaffected: `resolve` ignores the base for those.
  const manifestPath = resolve(repoRoot, valid.manifestPath);
  const manifestBudgetMs = ctx.remaining();
  // Checked separately so an exhausted ceiling reports as a TIMEOUT rather than
  // as a rejected manifest — the loader would refuse a non-positive budget, and
  // "manifest rejected" is the wrong diagnosis for a slow substrate.
  if (manifestBudgetMs <= 0) throw ctx.timedOut("manifest");
  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(manifestPath, manifestBudgetMs, repoRoot);
  } catch (e) {
    throw ctx.refuse(
      2,
      "manifest-rejected",
      `manifest rejected: ${errorMessage(e)}`,
      `fix the manifest, or point manifestPath at one beneath ${repoRoot}`,
      { manifestPath },
    );
  }
  // C7: the AUTHOR does not get to set the run's money ceiling. AC9a makes the
  // manifest the cap's only in-box carrier, so a hand-authored `limitMicroUsd`
  // in the source manifest is an attempt to name the ceiling the budget gate is
  // supposed to name.
  //
  // Stripped HERE and deliberately NOT inside `loadManifest`:
  // `scripts/pipeline-run.ts` reads the DELIVERED, already-stamped
  // `pipeline.yaml` through that same loader, so a strip down there deletes the
  // dispatcher's own stamp and the engine runs uncapped — the opposite defect.
  // This is the one read of an untrusted, unstamped manifest.
  //
  // NOTE: belt and braces. `stampManifestLimit` below spreads its own value
  // over whatever was there, so the authored one cannot reach the box today;
  // this makes the rule independent of that overwrite staying last.
  //
  // `stripAuthoredLimit`, not a hand-rolled destructure. The two copies had
  // already diverged (the export freezes its result, this did not), and the
  // export had ZERO non-test callers — so deleting these lines would have taken
  // the AC9a money guard with them while manifest.ts's own test stayed green.
  // One rule, one implementation.
  loaded = stripAuthoredLimit(loaded);
  // The exedev gate reads the ACTIVE roster beside the manifest. Its absence is
  // a defect in the brief, not a gate outcome, so it refuses before a box
  // exists rather than as a failed assertion on a live box (INV-5 would then
  // forbid tearing that box down). Only checked where that gate will actually
  // run: an injected gate and a dir box never read a roster.
  const rosterPath = join(dirname(manifestPath), "roster.yaml");
  if (deps.setupGate === undefined && isExedevDriver(deps.driver)) {
    if (!existsSync(rosterPath)) {
      throw ctx.refuse(
        2,
        "roster-missing",
        `no roster beside the manifest: ${rosterPath}`,
        "place the active roster at that path, or point manifestPath at a directory that has one",
        { rosterPath },
      );
    }
    // CHARSET, host-side. `assertPathSafe` (setup-gate.ts) refuses a roster path
    // outside `[A-Za-z0-9._/-]` because it is interpolated into a remote `sh`
    // command — but it runs INSIDE the gate, i.e. after the box exists and is
    // billing, and INV-5 then forbids tearing that box down. A repo checked out
    // under `/Users/x/My Projects/…` or any accented path therefore provisioned,
    // billed, and failed with the record OPEN over a fact knowable at step 1.
    // `rosterPath` is absolute, so `repoRoot` is inside what is tested.
    //
    // The gate keeps its own check — this is the pre-check, not a replacement.
    if (!ROSTER_PATH_CHARSET.test(rosterPath)) {
      throw ctx.refuse(
        2,
        "roster-path-unsafe",
        `roster path ${JSON.stringify(rosterPath)} is outside the setup gate's plain-path charset [A-Za-z0-9._/-]`,
        "check the repository out under a path with no spaces or non-ASCII characters, or pass a gate via deps.setupGate",
        { rosterPath },
      );
    }
    // CONTENT, same argument. The gate reads this file with this same
    // `parseRoster`, so a `roster.yaml` that is a directory (EISDIR — which
    // `existsSync` reports as present), unparseable YAML, a roster that fails
    // the closed schema, or a role slug outside the model-id charset all used to
    // surface at step 9 on a live box. Every one of them is host-side and
    // knowable here.
    let rosterSlugs: string[];
    try {
      // OPEN then FSTAT THE HANDLE, and open non-blocking — not
      // `statSync(path)` followed by `readFileSync(path)`.
      //
      // Two defects in that pair, both on a path an untrusted brief steers
      // (`manifestPath` → `dirname` → `roster.yaml`). It was a TOCTOU: the
      // `isFile()` verdict was about whatever the name pointed at THEN, and the
      // read resolved the name again. And a FIFO planted between the two calls
      // made `readFileSync` block FOREVER — this block runs outside `within`,
      // so no timer can fire and the dispatch hangs before any admission is
      // spent. Line ~1170 above already names that vector as the reason
      // manifest.ts avoids Bun's `realpathSync`; it was reintroduced two blocks
      // later.
      //
      // `O_NONBLOCK` is what makes the ORDER work: opening a FIFO for reading
      // blocks until a writer appears, so the check has to come after an open
      // that cannot block, and it has to be about the handle the read will use.
      // On a regular file the flag changes nothing. A directory (EISDIR, which
      // `existsSync` reports as present) fails the same `isFile()`.
      const fd = openSync(rosterPath, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error(`${rosterPath} is not a regular file`);
        // SIZE, before the read. The read + parseRoster pair is synchronous
        // and runs OUTSIDE every within() deadline — nothing can interrupt it
        // — so an uncapped read let a planted multi-gigabyte roster.yaml hang
        // the dispatch before any admission is spent: the same pre-admission
        // wedge the FIFO guard above exists for, by volume instead of by
        // blocking. The schema's own load path enforces this ceiling (it stats
        // before reading too); this pre-check reads a handle directly, so the
        // check moves with it. Same message shape, so one vocabulary.
        if (st.size > ROSTER_MAX_BYTES) {
          throw new Error(
            `roster is ${st.size} bytes, over the ${ROSTER_MAX_BYTES}-byte (${kibLabel(ROSTER_MAX_BYTES)}) ceiling`,
          );
        }
        // CAPPED READ, not a slurp. A readFileSync here would swallow whatever
        // landed between the size verdict above and the read — synchronously,
        // outside every within() deadline, the same pre-admission wedge the
        // FIFO guard exists for, by volume instead of by blocking. At most
        // ROSTER_MAX_BYTES + 1 bytes ever enter memory, and parseRoster never
        // sees a byte over the ceiling: over-cap refuses HERE, on what was
        // actually read, before any parsing runs.
        const capped = Buffer.alloc(ROSTER_MAX_BYTES + 1);
        let total = 0;
        while (total < capped.length) {
          const n = readSync(fd, capped, total, capped.length - total, null);
          if (n === 0) break;
          total += n;
        }
        // RE-FSTAT AFTER the read. The size verdict above described the file as
        // it stood THEN; a writer still appending shows up ON DISK even when
        // the capped read has already bounded what entered memory. Both figures
        // are checked: what was READ bounds the parse, what is ON DISK catches
        // an append still landing.
        const after = fstatSync(fd);
        if (total > ROSTER_MAX_BYTES || after.size > ROSTER_MAX_BYTES) {
          throw new Error(
            `roster grew past the ${ROSTER_MAX_BYTES}-byte (${kibLabel(ROSTER_MAX_BYTES)}) ceiling while it was read (${total} bytes read, ${after.size} on disk)`,
          );
        }
        rosterSlugs = parseRoster(capped.toString("utf8", 0, total), rosterPath).roles.map((r) => r.slug);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      throw ctx.refuse(
        2,
        "roster-rejected",
        `roster rejected: ${errorMessage(e)}`,
        "fix the roster beside the manifest, or point manifestPath at a directory with a valid one",
        { rosterPath },
      );
    }
    const badSlug = rosterSlugs.find((slug) => !ROSTER_PATH_CHARSET.test(slug));
    if (badSlug !== undefined) {
      throw ctx.refuse(
        2,
        "roster-rejected",
        `roster slug ${JSON.stringify(badSlug)} is outside the model-id charset [A-Za-z0-9._/-]`,
        "fix the roster entry — the slug is interpolated into the gate's in-box ping",
        { rosterPath },
      );
    }
  }
  return { loaded, rosterPath };
}

/**
 * Step 7 — mint the provider key and deliver it into the box (INV-4: the
 * plaintext exists in the mint return and nowhere else). Lifted out of
 * `dispatch()` verbatim (F003).
 *
 * Returns the ceiling the box is actually STAMPED with: the admitted figure,
 * or the provider's own where it minted less. Never more (see AC9 below).
 */
async function mintAndDeliverKey(
  ctx: DispatchContext,
  deps: DispatchDeps,
  args: {
    requestId: string;
    runId: string;
    vm: Awaited<ReturnType<typeof provisionAdmittedRun>>["vm"];
    effectiveCeilingMicros: number;
  },
): Promise<number> {
  const { requestId, runId, vm, effectiveCeilingMicros } = args;
  // ── 7. key (INV-4: plaintext exists in the mint return and nowhere else) ─
  const tMint = ctx.now();
  const credEnvFile = envFileFor(deps.driver);
  // Its OWN catch, with a FIXED message. `deliverRunKey` writes the plaintext
  // key into the box through `driver.exec`, and an exec wrapper that reports a
  // failure by including its argv — the ordinary way such a wrapper reports —
  // puts that key in the thrown message. The generic catch below interpolates
  // a caught message into `dispatch failed after the box was created: …`,
  // which is written to the dispatch log AND the structured line AND the
  // returned FleetError. `redact` now carries `redactSecrets`, so a bare token
  // no longer survives those three — but this catch stays: defence in depth
  // for an issuer whose prefix is not on the list and whose token is too short
  // for the long-token arm. INV-4 says plaintext exists in the mint return and
  // nowhere else, so the provider's free text never reaches a sink here — only
  // its `code`, in the payload.
  try {
    const { key } = await ctx.within(
      "mint",
      () =>
        mintRunKey(
          {
            keyApi: deps.keyApi,
            driver: deps.driver,
            store: deps.store,
            requestId,
            capMicroUsd: effectiveCeilingMicros,
            ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
          },
          runId,
        ),
      // An ABANDONED mint that lands anyway is a live provider key spending
      // against this issue's cap, and `within` cannot cancel it. The refusal
      // has already gone out naming nothing about it, so this line is the only
      // operator-facing pointer that exists until the record write inside
      // `mintRunKey` catches up.
      //
      // `hash`, never `key`: INV-4 says the plaintext exists in the mint
      // return and nowhere else, and this is a log sink. The hash is the
      // provider-side IDENTIFIER (credentials.ts persists it in the plaintext
      // record and keeps it through redaction for exactly this reason) and it
      // is charset-checked before `mintRunKey` returns, so it cannot carry
      // anything into a line an operator pastes. The CAP goes with it because
      // "a key is live" and "it can spend N µ$" are different sizes of
      // incident.
      (minted) => ({ keyHash: minted.hash, capMicroUsd: effectiveCeilingMicros }),
    );
    await ctx.within(
      "deliver",
      () =>
        deliverRunKey(
          {
            keyApi: deps.keyApi,
            driver: deps.driver,
            store: deps.store,
            requestId,
            ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}),
          },
          vm.name,
          key,
        ),
      // Resolves `void`; what a late one means is that the key reached the box
      // AFTER the operator was told the dispatch failed. The box is the fact.
      () => ({ vmName: vm.name, keyDelivered: true }),
    );
  } catch (e) {
    // Rethrow only when `refuse` already logged this one — a FleetError that
    // did NOT pass through `refuse` (a seam throwing one directly) would
    // otherwise escape with no dispatch-log entry, no structured line and no
    // payload: exactly the bare-exit-1 treatment this catch exists to deny.
    if (alreadyRefused(e)) throw e;
    throw ctx.refuse(
      1,
      e instanceof FleetError ? "key-delivery-refused" : "key-delivery-failed",
      e instanceof FleetError
        ? `${e.message} — during key mint or delivery for run ${runId}`
        : `key mint or delivery failed for run ${runId}`,
      e instanceof FleetError && typeof e.remediation === "string"
        ? e.remediation
        : "the run record is OPEN and the box is ALIVE (INV-5) — inspect it, then tear it down",
      {
        ...(e instanceof FleetError && e.code !== undefined ? { code: e.code } : {}),
        ...providerCodePayload(e),
      },
    );
  }
  ctx.phase("mint_ms", ctx.now() - tMint);

  // AC9: what reaches the box is the cap the provider actually MINTED, not the
  // one that was requested. `mintRunKey` refuses a non-positive or non-finite
  // `limitUsd` outright and persists `usdToMicros(res.limitUsd)` on the
  // record, so by the time the fill step runs the record holds the true
  // figure — while `pipeline.yaml` and `run-context.json` were carrying the
  // REQUEST. A manifest that names a ceiling the key does not carry is a run
  // that either dies mid-phase against a provider limit nothing told it about,
  // or (if the provider minted MORE) advertises headroom the ledger never
  // reserved.
  //
  // DOWNWARD ONLY. The paragraph above names the over-mint as a defect ("if
  // the provider minted MORE, advertises headroom the ledger never reserved")
  // and the code then did exactly that: `credentials.ts` persisted
  // `usdToMicros(res.limitUsd)` — the PROVIDER's own answer — checking only
  // that it is non-null, finite and positive, and this read adopted it
  // whenever it was a positive safe integer, with no upper bound. Since F004
  // `mintRunKey` REFUSES an over-granted ceiling at the mint itself, so the
  // `min` below is defence in depth: it still bounds records written before
  // that refusal existed, and any path that reaches this read with one. A key API
  // that rounds up, applies a plan floor, is misconfigured, or is answering
  // for someone else authorized the box to spend above the ceiling the ledger
  // reserved against the issue cap, on the strength of its own reply. The
  // admitted ceiling is the only figure this factory has any claim to, so it
  // is the ceiling: `min` in one direction, never `max` in the other.
  //
  // Falls back to the requested figure if the record cannot be read or holds
  // no usable limit: reading it back is diagnosis, and a failure here must not
  // become the run's failure when the key is already live and delivered.
  let persistedCeilingMicros: number | undefined;
  try {
    const persisted = deps.store.get(runId).limitMicroUsd;
    if (Number.isSafeInteger(persisted) && (persisted as number) > 0) {
      persistedCeilingMicros = persisted as number;
    }
  } catch {
    // see above — the requested ceiling stays the stamp
  }
  const mintedCeilingMicros =
    persistedCeilingMicros === undefined
      ? effectiveCeilingMicros
      : Math.min(effectiveCeilingMicros, persistedCeilingMicros);
  // An over-mint is a MONEY event, not a diagnostic. It used to log
  // `status:"ok"` / `exitStatus:"success"` in both directions, so the one
  // direction that means "the provider tried to hand this run more headroom
  // than it was admitted for" never reached error-based alerting. Under-mint
  // stays informational: the box gets less than it asked for and dies against
  // a limit it was told about, which is the manifest stamp doing its job.
  const overMinted =
    persistedCeilingMicros !== undefined && persistedCeilingMicros > effectiveCeilingMicros;
  if (overMinted || mintedCeilingMicros !== effectiveCeilingMicros) {
    try {
      log({
        requestId,
        operation: "fleet.dispatch",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: ctx.now() - ctx.wallStart,
        durationMs: ctx.now() - ctx.wallStart,
        status: overMinted ? "error" : "ok",
        error: {
          code: overMinted ? "mint-cap-over-request" : "mint-cap-differs",
          message: overMinted
            ? `provider minted ${persistedCeilingMicros} µ$ ABOVE the admitted request of ${effectiveCeilingMicros} µ$ — the box is stamped with the admitted figure and the excess is not honoured`
            : `provider minted ${mintedCeilingMicros} µ$ against a request of ${effectiveCeilingMicros} µ$ — the box is stamped with the minted figure`,
        },
        runId,
        verb: "dispatch",
        phase: "minted",
        // The key itself is live at the provider's figure whatever this module
        // stamps, so an over-mint is a real condition someone has to look at —
        // "transient" is the retry classification, not a claim it is harmless.
        exitStatus: (overMinted ? "transient" : "success") as ExitStatus,
      });
    } catch {
      // see `refuse` — a sink failure is never the run's failure
    }
  }
  return mintedCeilingMicros;
}

/**
 * Step 10 — expose the port and make the box public, in that order and only
 * once the gate has proved the box (INV-5). Lifted out of `dispatch()`
 * verbatim (F003); a no-op when no port was asked for.
 *
 * Writes the box's URL onto the context rather than returning it: `ctx.httpsUrl`
 * is what the refusal payload and the ack both read, and it is set from
 * `vm.httpsUrl` at create time whether or not this step runs.
 */
async function exposeGatedBox(
  ctx: DispatchContext,
  deps: DispatchDeps,
  args: { runId: string; vm: Awaited<ReturnType<typeof provisionAdmittedRun>>["vm"] },
): Promise<void> {
  const { runId, vm } = args;
  // ── 10. expose (INV-5 ordering: PUBLIC only once the gate has proved it) ─
  const port = deps.port;
  if (port !== undefined) {
    // The ceiling was never sampled after the gate — the single longest await
    // in the whole dispatch — so a run could ack "ready" well past its budget.
    //
    // Sampled INSIDE the port branch, i.e. only where there is work left the
    // ceiling can still refuse. Outside it, this line refused a dispatch that
    // was byte-for-byte COMPLETE: with no port, step 10 is a no-op, so a run
    // whose gate went green had its box alive, its key delivered at the full
    // admitted ceiling, its record written and nothing left to do — and was
    // still reported exit 1 with "tear the run down". The ack-log guard at the
    // very bottom of this function names that hazard exactly ("the operator's
    // natural response to that bare failure — tear down, retry — re-spends the
    // issue's cap on a run that had already SUCCEEDED"); this line
    // manufactured it. A deadline is a bound on WORK REMAINING; where none
    // remains there is nothing for it to bound, and refusing a healthy run is
    // the more expensive of the two errors.
    //
    // Labelled "post-gate", not "gate": it fires only once the gate has
    // RETURNED ready, so `dispatch exceeded N ms at gate` accused a gate that
    // had passed all five assertions — and `ctx.gate` is set by then, so the
    // payload's `debugCommands` come from that passing gate. `gateReady` says
    // so on the payload.
    if (ctx.remaining() <= 0) throw ctx.timedOut("post-gate", { gateReady: true });

    // `expose` RESOLVING is the moment the port stops being speculative — the
    // retraction below turns on this and nothing else. It cannot be inferred
    // from `ctx.httpsUrl`, which is already set from `vm.httpsUrl` at create
    // time and so is non-undefined on plenty of runs where `expose` never ran.
    let portOpened = false;
    // Whether the locator write landed — the one state claim still made AFTER
    // a call, so its failure mode needs its own repair path below.
    let httpsUrlPersisted = false;
    try {
      ctx.httpsUrl = await ctx.within(
        "expose",
        () => {
          // Intent marker BEFORE the provider call, but INSIDE the step:
          // `within` pre-checks the budget before invoking its thunk, so a
          // deadline that expires between the post-gate sample above and that
          // pre-check throws before any claim exists. The claim used to sit
          // outside, and a `dispatch-timeout` from a NEVER-STARTED expose was
          // then exempted from the retraction below like an abandoned one —
          // leaving `ports: [port]` on the record for a port nothing opened,
          // visible to `fleet status` and port-keyed reapers until teardown.
          //
          // Written before the driver call either way: `within` ABANDONS
          // rather than cancels (no AbortSignal at the seam), so an expose
          // abandoned at the deadline can still complete seconds later — the
          // box is then publicly reachable while the record must already
          // claim its port, or `fleet status` under-reports a live public box
          // and port-keyed reapers miss it entirely.
          deps.store.set(runId, { ports: [port] });
          return deps.driver.expose(vm.name, port);
        },
        // A late expose opens the port after the refusal; the URL is what the
        // record could not be told.
        (url) => ({ httpsUrl: typeof url === "string" ? redact(url) : undefined, port }),
        // An abandoned expose that then FAILS settles it: the port will never
        // open, so the claim written inside the thunk is now phantom — the
        // same state the synchronous retraction below fixes for an ordinary
        // failure, reachable only here because a `dispatch-timeout` is exempt
        // there (at throw time the call may still land). Retract at the
        // rejection, best-effort exactly like the catch's own.
        () => {
          try {
            deps.store.set(runId, { ports: [] });
          } catch {
            // best-effort: the refusal stands either way
          }
        },
      );
      portOpened = true;
      // The URL was the one state claim still made AFTER the call it describes.
      // Two ways that lost it: a failed — or, by the same abandon-not-cancel
      // reasoning as the `ports` claim above, an ABANDONED — `setPublic` left
      // the record with a port and no URL for a box `expose` had already given
      // one; and a driver that resolved no URL still went on to be made PUBLIC,
      // i.e. publicly reachable with nothing on the record saying where.
      //
      // `expose` is DECLARED `Promise<string>`, so the undefined arm is a
      // driver-boundary guard, not a modelled outcome — and the right answer at
      // that boundary is to refuse before the box is public (INV-5 keeps it
      // alive and diagnosable) rather than to publish a box nobody can name.
      // Blank is the same outcome by another road: driver.ts normalizes
      // whitespace-only URLs to undefined at ITS boundary (`address`), but
      // `""` is a string and is not an address either, so a driver that skips
      // that helper hands one straight through — same refusal, same family.
      // The port claim below is RETAINED: `expose` RESOLVED, so the port is
      // real even where the address is not usable (the retraction's own
      // second case).
      // The MAIN path's read of `expose`'s resolution — the one read with no
      // `typeof` guard (the late-success handler checks, this did not).
      // `expose` is DECLARED `Promise<string>`, but `deps.driver` is an
      // injection seam and a truthy non-string here threw out of `.trim()`,
      // escaping to the outer catch as exit-1 `dispatch-failed` instead of
      // the purpose-built refusal below. The port claim stays real either
      // way (`expose` resolved), and the box is left PRIVATE (INV-5) rather
      // than published with an unusable locator.
      if (
        typeof ctx.httpsUrl !== "string" ||
        ctx.httpsUrl === undefined ||
        ctx.httpsUrl.trim().length === 0
      ) {
        throw ctx.refuse(
          1,
          "expose-no-url",
          `expose returned no URL for run ${runId} on port ${port}`,
          "the run record is OPEN and the box is ALIVE but NOT public (INV-5) — inspect it, then tear it down",
          { port },
        );
      }
      // Verbatim DELIBERATELY, unlike every log-line copy of this field: the
      // record is the persistent locator for a public box (the ack return and
      // this write are its only copies), so a lossy form here — `redact`
      // eats long host labels outright — leaves a live box whose address is
      // recorded nowhere. The operator-facing halves sanitize at their own
      // boundaries instead: the structured lines redact, and `fleet status`'s
      // `safeUrl` drops userinfo-bearing URLs entirely.
      deps.store.set(runId, { httpsUrl: ctx.httpsUrl });
      httpsUrlPersisted = true;
      await ctx.within(
        "setPublic",
        () => deps.driver.setPublic(vm.name),
        // Resolves `void`. What a late one means is the whole of it: this box
        // became PUBLICLY REACHABLE after the operator was told the dispatch
        // failed.
        () => ({ vmName: vm.name, publiclyReachable: true }),
      );
    } catch (e) {
      // The URL write failing after `expose` resolved left a record holding a
      // port with NO locator, permanently — the store merges patches and has
      // no way to remove one. One best-effort repair before the refusal: this
      // is the only moment the URL is known and the write is cheap to repeat.
      // Guarded on the URL actually being usable, so an `expose-no-url`
      // failure does not write garbage over the absence it is refusing for.
      if (
        portOpened &&
        !httpsUrlPersisted &&
        typeof ctx.httpsUrl === "string" &&
        ctx.httpsUrl.trim().length > 0
      ) {
        try {
          deps.store.set(runId, { httpsUrl: ctx.httpsUrl });
        } catch {
          // still unrecorded — vmName and port ride the refusal payload and
          // the box stays alive (INV-5), so the operator can read the
          // address off it directly
        }
      }
      // RETRACT the speculative `ports` claim, but ONLY while it is still
      // speculative. Left standing on a failed `expose`, the record
      // permanently advertised a port on a box where nothing was opened:
      // port-keyed reapers and `fleet status` both read a port the box does
      // not have.
      //
      // Two cases KEEP the claim, and both are ones where the port is real:
      //
      //  - An ABANDONED call, which is what the claim was written for: a
      //    `dispatch-timeout` is precisely the case where the expose may still
      //    land after the refusal. A `dispatch-timeout` can now also mean the
      //    step NEVER started (budget gone before `within` invoked its thunk)
      //    — but then no claim was written either, so exempting it here
      //    retracts nothing and leaves no phantom port behind.
      //  - Anything that failed AFTER `expose` resolved — `expose-no-url` and
      //    every `setPublic` failure. The port is OPEN on those; retracting
      //    left the record denying a port the box is listening on, and
      //    `httpsUrl` (written between the two calls) contradicting the same
      //    record's empty `ports`. That is the inconsistency this retraction
      //    exists to prevent, pointed the other way.
      //
      // `[]` rather than an unset, because the store merges patches and has no
      // way to remove a field — an empty list is "this run claims no port",
      // which is what a reaper and `fleet status` both need to read.
      if (!portOpened && !(e instanceof FleetError && e.code === "dispatch-timeout")) {
        try {
          deps.store.set(runId, { ports: [] });
        } catch {
          // best-effort, exactly like the gate-outcome write: the refusal
          // being reported must not be replaced by a record-write failure
        }
      }
      throw e;
    }
  }
}

// ponytail: 1,191 lines — steps 1-2, 4-6, 8-9 and 11 remain inline. Lift steps
// 5, 8 and 11 next (F003-b); the DispatchContext seam is already in place.
// Upgrade trigger: the next edit to this function — lift the step it touches
// instead of editing in place, or a twelfth lifecycle step lands.
export async function dispatch(
  brief: unknown,
  deps: DispatchDeps,
  opts: { admitted?: boolean; runId?: MintedRunId } = {},
): Promise<DispatchResult> {
  // One clock, both ends. Differencing an injected clock against a `Date.now()`
  // baseline makes the seam inert for every clock that is not a live-time
  // offset — the baseline has to come from the same source the comparison does.
  const now = (): number => deps.clock?.() ?? Date.now();
  const wallStart = now();
  const timeoutMs = deps.timeoutMs ?? 600_000;
  // `resolve` FIRST: `dirname("runs")` is `"."`, so a bare relative store dir
  // (`new RunRecordStore({dir:"runs"})`, or `QDS_RUNS_DIR=runs`) put the AC4
  // refusal evidence in whatever the process cwd happened to be. The basename
  // comes from `DISPATCH_FAILURE_LOG` so the documented default and the
  // computed one cannot drift — the constant was exported and never read.
  //
  // …and the parent must be a directory an ordinary process may write. `--dir
  // /runs` puts it at the filesystem ROOT, where the append is EACCES and the
  // AC4 evidence is lost; the store dir itself is writable by construction, so
  // that is the fallback. `dirname(p) === p` is the root test.
  const storeDir = resolve(deps.store.dir);
  const logDir = dirname(storeDir);
  // `resolve` over the caller's value too: the computed default is absolute, and
  // a RELATIVE `deps.dispatchLogPath` used to stay raw — every append resolved it
  // against the process cwd implicitly anyway (so behavior was cwd-dependent
  // either way), but the stderr fallback and any diagnostic printed the
  // UNRESOLVED form. Same rule as `store.dir` above.
  const dispatchLog = resolve(
    deps.dispatchLogPath ??
      join(dirname(logDir) === logDir ? storeDir : logDir, basename(DISPATCH_FAILURE_LOG)),
  );
  const timings: Record<string, number> = {};

  const ctx = new DispatchContext(now, wallStart, timeoutMs, dispatchLog, timings);
  const phase = ctx.phase.bind(ctx);
  // Aliases, so every step below still reads `refuse(…)` / `within(…)`: this
  // commit moves the machinery and nothing else. `within` is spelled out rather
  // than bound because `bind` drops the generic parameter.
  // NOTE: `refuse` and `ctx.refuse` are the same method — the aliases exist only
  // to keep the moved bodies verbatim, and go when the remaining steps are
  // lifted onto the context (F003-b).
  const refuse = ctx.refuse.bind(ctx);
  const within = <T>(
    step: string,
    work: () => Promise<T>,
    describeLate?: (value: T) => Record<string, unknown>,
    onAbandonedFailure?: (e: unknown) => void,
  ): Promise<T> => ctx.within(step, work, describeLate, onAbandonedFailure);

  // ── 1. validate (INV-2: before ANY side effect) ─────────────────────────────
  // The dispatch ceiling is the manifest loader's `callerBudgetMs` and this
  // function's own wall clock; a non-positive one can be satisfied by nothing.
  //
  // The UPPER bound matters just as much: `setTimeout` clamps a delay past
  // `MAX_TIMEOUT_MS` to 1 ms, so a ceiling above it made the FIRST step time
  // out immediately — a request to lengthen the budget inverting into the
  // shortest one possible, which is the opposite of what the caller asked for.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw refuse(
      2,
      "timeout-invalid",
      `timeoutMs must be a positive integer of milliseconds no greater than ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
      `omit timeoutMs for the 600_000 ms default, or pass a positive integer up to ${MAX_TIMEOUT_MS}`,
    );
  }
  if (deps.port !== undefined && (!Number.isInteger(deps.port) || deps.port < 1 || deps.port > 65_535)) {
    throw refuse(
      2,
      "port-invalid",
      `port must be an integer in 1..65535, got ${deps.port}`,
      "pass a real TCP port, or omit --port and take the box's own URL",
    );
  }

  const tValidate = now();
  const parsed = BriefSchema.safeParse(brief);
  phase("validate_ms", now() - tValidate);
  if (!parsed.success) {
    const field = extractZodErrorField(parsed.error);
    throw refuse(
      2,
      "invalid-brief",
      `brief rejected: field ${JSON.stringify(field)}`,
      // JSON.stringify, not raw. The field NAME is attacker-chosen — an
      // unrecognized key is echoed back verbatim — and `redact` is a secret
      // redactor, not a control-char escaper. A key like "[2J" or
      // "a\nFLEET dispatch ok runId=fake" reached the operator stream intact
      // through this one interpolation while the message above escaped it.
      `fix or remove ${JSON.stringify(field)} in the brief JSON`,
      {
        field,
        // The untruncated count, so a capped `issues` list is visibly partial.
        issueCount: parsed.error.issues.length,
        // zod builds "Unrecognized key(s) in object: '<raw>'" from the same
        // attacker-chosen name, so the issue strings need the same escaping —
        // but NOT the surrounding quotes JSON.stringify adds, because these are
        // already list ELEMENTS. That is `escapeText`, which is now the one
        // implementation the other third-party-text sinks share.
        //
        // CAPPED: the array scales with the attacker-controlled unrecognized-
        // key count, and an unbounded echo flooded stderr, the payload and the
        // dispatch log with one crafted brief. The first issues are the ones
        // `extractZodErrorField` names; the count of the rest is named by
        // omission via the total (below), never silently dropped.
        issues: cappedIssues(parsed.error.issues.length, [
          ...parsed.error.issues.map((i) =>
            redact(escapeText(`${i.path.join(".") || "(root)"}: ${i.message}`)),
          ),
        ]),
      },
    );
  }
  const valid: Brief = parsed.data;
  ctx.repoSlug = valid.repoSlug;
  ctx.issueId = valid.issueId;

  // ── 2. resolve correlation (CC-9/AC2: malformed requestId mints fresh) ─────
  // AC1: a non-UUID-v4 requestId is NOT a validation failure — it is dropped so
  // the resolver mints a fresh one; the resolved value is what downstream sees.
  // A caller that already resolved it (the CLI, which needs the id to build the
  // store and the driver) hands it back through deps.requestId, and the
  // resolver still validates it — one id, one shape check, INV-4-bis.
  //
  // `deps.requestId` gets the SAME shape check the brief's does, and refuses
  // rather than being dropped. Injected unvalidated, a malformed one made the
  // resolver mint a FRESH id — but the CLI had already built the store and the
  // driver with the old one, so the record's and the driver's log lines carried
  // a different correlation id from the ack, with no error anywhere. That
  // cross-layer split is precisely what INV-4-bis exists to prevent, and it is
  // the caller's own bug, so it is exit 2 rather than a silent re-mint.
  if (deps.requestId !== undefined && resolveBriefRequestId(deps) === undefined) {
    throw refuse(
      2,
      "invalid-request-id",
      // `escapeText`, not bare `JSON.stringify`: this is caller-supplied
      // third-party-shaped text reaching three operator sinks, and it is the one
      // such interpolation that skipped the escaper — a newline-bearing value
      // forged a line in the dispatch log.
      `deps.requestId "${escapeText(deps.requestId)}" is not a strict UUID v4`,
      "pass the value resolveBriefRequestId() returned for this brief, or omit it and let dispatch resolve the brief's own",
    );
  }
  // Validated now, so it may seed the refusal context (see `ctx.requestId`).
  ctx.requestId = deps.requestId ?? null;
  // `resolveBriefRequestId` and nothing else: the rule was reimplemented inline
  // here, and the two copies had ALREADY diverged (the helper guards
  // `typeof supplied === "string"`, the inline test did not).
  const { requestId: _briefRequestId, ...briefRest } = valid;
  const briefRequestId = resolveBriefRequestId(valid);
  const suppliedRequestId = deps.requestId ?? briefRequestId;
  // deps WINS — it has to (INV-4-bis: the CLI already built the store and the
  // driver with it) — but a brief whose own valid id is DIFFERENT is a split
  // between what the operator wrote and what the run reports, and it used to be
  // silent. A MALFORMED deps.requestId is exit 2 to prevent exactly this split,
  // so the survivable version of it must at least be visible. Not a refusal:
  // overriding is the documented contract of the parameter.
  if (briefRequestId !== undefined && deps.requestId !== undefined && briefRequestId !== deps.requestId) {
    try {
      // `status: "ok"` / `exitStatus: "success"` made a WARNED run count as a
      // clean one for any consumer tallying successes. The schema admits no
      // "warn", so the non-success state is `"error"` (the anomaly is real and
      // the line already carries its `error` detail) under a dedicated
      // `phase`, and the false `exitStatus: "success"` is simply gone.
      log({
        requestId: deps.requestId,
        operation: "fleet.dispatch",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: now() - wallStart,
        durationMs: now() - wallStart,
        status: "error",
        error: {
          code: "request-id-overridden",
          message: `the brief's requestId ${JSON.stringify(briefRequestId)} was overridden by deps.requestId`,
        },
        runId: null,
        verb: "dispatch",
        phase: "request-id-overridden",
      });
    } catch {
      // see `refuse` — a sink failure is never the run's failure
    }
  }
  const briefIn =
    suppliedRequestId === undefined ? briefRest : { ...briefRest, requestId: suppliedRequestId };
  let correlation: ReturnType<typeof resolveRunCorrelation>;
  try {
    correlation = resolveRunCorrelation(briefIn);
  } catch (e) {
    if (e instanceof CorrelationError) {
      // A FIXED fleet code, with the producer's own in the payload
      // (`providerCodePayload`'s rule, applied here rather than restated).
      // `refuse(2, e.code, …)` wrote `INVALID_REPO_SLUG`/`INVALID_ISSUE_ID`/
      // `INVALID_REQUEST_ID` straight into `FleetError.code`, so this CLI's
      // exit-code table — the one an operator greps the dispatch log with — was
      // defined by `issue-correlation.ts`, and a rename there silently changed
      // it. One code, one meaning (F3, module header).
      //
      // `escapeText`, because `CorrelationError.message` names the offending
      // brief FIELD and that name is attacker-chosen: it reaches stderr, the
      // dispatch log and the CLI-printed payload, and `redact` inside `refuse`
      // is a secret redactor, not a control-char escaper.
      throw refuse(
        2,
        "correlation-rejected",
        escapeText(e.message),
        "fix the brief field the payload's providerCode names",
        providerCodePayload(e),
      );
    }
    // Not a CorrelationError, and still not a bare rethrow: an untyped escape
    // costs the operator the dispatch-log entry (AC4 evidence) and the one
    // structured line every other exit owes them, for a bare CLI exit 1.
    throw refuse(
      1,
      "correlation-failed",
      `correlation could not be resolved: ${errorMessage(e)}`,
      errorRemediation(e, "retry — nothing was provisioned"),
      providerCodePayload(e),
    );
  }
  const requestId = correlation.requestId;
  ctx.requestId = requestId;
  // ONE source for the issue identity from here on. Budget was booked against
  // `valid.repoSlug`/`valid.issueId` while `run-context.json` carried
  // `correlation.*` and the dispatch-log keys read a third copy: the resolver
  // trims the slug, so spend could be attributed to an issue the run does not
  // report, and the per-issue cap bypassed with a pair the resolver rewrites.
  const repoSlug = correlation.repoSlug;
  const issueId = String(correlation.issueId);
  ctx.repoSlug = repoSlug;
  ctx.issueId = correlation.issueId;
  const resolvedMs = now() - wallStart;
  // GUARDED, like every other `log` in this module. A throwing sink must not
  // break the run: unguarded, this one turned a healthy dispatch into a raw
  // non-`FleetError` escaping before the try/catch below exists — no
  // dispatch-log entry (AC4), no `runId` on the payload, bare CLI exit 1.
  try {
    log({
      requestId,
      operation: "fleet.dispatch",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: resolvedMs,
      durationMs: resolvedMs,
      status: "ok",
      runId: null,
      // Query string and userinfo stripped, path kept clickable: the brief
      // constrains `issueUrl`'s scheme only, so `?installation_token=…` would
      // otherwise reach this line verbatim (INV-6 names the query string first).
      issueUrl: linkSafe(correlation.issueUrl),
      verb: "dispatch",
      phase: "resolved",
      exitStatus: "success" as ExitStatus,
    });
  } catch {
    // see `refuse` — a sink failure is never the run's failure
  }

  // ── 3. manifest + roster (INV-2: pure validation, so it belongs HERE) ──────
  const { loaded, rosterPath } = loadManifestAndRoster(ctx, deps, valid);

  // ── 4. runId (dispatcher-owned; AC2 opts.runId only accepts minted ids) ────
  // `MintedRunId` already refuses a caller-invented literal at compile time; the
  // shape check is for the ids that are built at runtime and cast in (the CLI,
  // DF3.2's fan-out), where the brand cannot see them.
  let runId: string;
  if (opts.runId !== undefined) {
    if (!MINTED_RUN_ID_RE.test(opts.runId)) {
      throw refuse(
        2,
        "run-id-not-minted",
        // `runIdEcho`, not `JSON.stringify`: same raw argv, same three hazards
        // (unbounded, possibly a pasted key, possibly control characters).
        `opts.runId ${runIdEcho(opts.runId)} is not a dispatcher-minted id`,
        "omit runId and let dispatch mint one, or pass a value from mintRunId()",
      );
    }
    // PROVENANCE, the runtime half AC2 asks for: the brand proves compile-time
    // literals and the regex above proves shape, but neither proves the id came
    // out of THIS module. A shape-perfect string cast in by a misbehaving
    // in-process caller used to sail through here and claim whatever admission
    // and budget a real run carries. Minted ids ride the process-local
    // registry (`mintRunId` records every hand-out), so a legitimate
    // re-supply — DF3.2's fan-out passing back the very ids it minted, the
    // collision loop's own re-mints — is accepted, and everything else refuses.
    if (!mintedRunIds.has(opts.runId)) {
      throw refuse(
        2,
        "run-id-not-minted",
        `opts.runId ${runIdEcho(opts.runId)} matches the minted shape but was never returned by mintRunId() in this process`,
        "omit runId and let dispatch mint one, or pass a value from mintRunId()",
      );
    }
    // Not a bare `assertValidRunId`: an untyped throw here is a bare CLI exit 1
    // with no dispatch-log entry and no structured line — the exact treatment
    // the collision guard below declares unacceptable, two lines away.
    try {
      assertValidRunId(opts.runId);
    } catch (e) {
      throw refuse(
        2,
        "invalid-run-id",
        // Same helper as `assertFleetRunId`'s: the store's embedded echo reaches
        // this message too, and this is the CLI's other entry point for a
        // caller-supplied id.
        storeRunIdRefusal(e, opts.runId),
        "omit runId and let dispatch mint one, or pass a value from mintRunId()",
      );
    }
    runId = opts.runId;
  } else {
    runId = mintRunId();
  }
  // A re-dispatch under an id that already has a record books the issue's cap a
  // SECOND time and then dies on a bare EEXIST from store.create — after the
  // reservation is committed. Refuse before the admission, not after it.
  //
  // A cheap FAST PATH only. `store.create`'s O_EXCL is the authoritative
  // arbiter (see the provisioning catch below): two concurrent dispatches
  // sharing an explicit `opts.runId` both pass this check and both commit a
  // reservation, so a check-then-create cannot be the guarantee. It still earns
  // its keep — the sequential case refuses here, before an admission is spent.
  //
  // Run for a self-minted id too, not just an explicit one: nothing chose a
  // minted id, so a collision is re-minted rather than refused.
  for (let attempt = 0; ; attempt++) {
    ctx.runId = runId;
    let exists: boolean;
    try {
      exists = recordExists(deps.store, runId);
    } catch (e) {
      // A store that cannot be read is not "free to reuse". It also must not
      // escape as a bare throw: every dispatch exit owes the operator a
      // dispatch-log entry and a structured line, and the CLI turns an untyped
      // throw into a bare exit 1 with neither. Nothing is provisioned here.
      throw refuse(
        1,
        "record-read-failed",
        `cannot read the run record for ${runId}: ${errorMessage(e)}`,
        errorRemediation(e, "fix or move the run-record directory, then retry — nothing was provisioned"),
        providerCodePayload(e),
      );
    }
    if (!exists) break;
    if (opts.runId !== undefined) {
      throw refuse(
        2,
        "run-id-in-use",
        `run ${runId} already has a record`,
        `omit runId for a fresh one, or tear the existing run down: bun scripts/fleet.ts teardown ${runId}`,
      );
    }
    if (attempt >= MINT_RETRIES) {
      // The id in `ctx.runId` is the last COLLIDING one — it belongs to another
      // run's record, not to this dispatch, which never settled on an id at all.
      // Reporting it as this dispatch's `runId` (on the payload and on the
      // structured line) attributes this refusal to someone else's live run.
      ctx.runId = null;
      throw refuse(
        1,
        "run-id-unmintable",
        `${MINT_RETRIES + 1} freshly minted run ids in a row already had records`,
        "the run-record directory is holding a day's worth of ids — reap or move it, then retry",
      );
    }
    runId = mintRunId();
  }

  // ── 5–6 single-flight: the admission critical section (DF3.2, finding DF13) ─
  // Wrapped as one unit — headroom read, budget decision, box create — so that
  // concurrent in-process dispatches (fan-out arms especially) cannot both
  // pass a ceiling they sampled before either box existed. See
  // `withAdmissionSingleFlight`'s doc comment for the scope and the half that
  // deliberately stays open.
  const { provisioned, effectiveCeilingMicros, tCreate } = await withAdmissionSingleFlight(async () => {
    // ── 5. admission (AC7/AC8 — both BEFORE store.create/driver.create) ────────
    // AC8: skipped only under { admitted: true } (DF3.2's single checkHeadroom(N)).
    if (opts.admitted !== true) {
      let headroom: Awaited<ReturnType<typeof checkHeadroom>>;
      try {
        headroom = await within("headroom", () => checkHeadroom(deps.driver, 1, deps.quotaLimits));
      } catch (e) {
        // `within`'s own deadline already refused this one (checked, not
        // assumed: a FleetError that never passed `refuse` gets the typed
        // arm below instead of a bare escape).
        if (alreadyRefused(e)) throw e;
        // `checkHeadroom`'s default parameter is `limits = loadQuotaLimits()`,
        // which throws QuotaLimitsError for malformed JSON, an unknown key, a
        // non-positive value or EACCES (only ENOENT falls back to the defaults) —
        // and the CLI never passes `deps.quotaLimits`. Untyped, a plain
        // configuration defect was exit 1 with no dispatch-log entry and no log
        // line. It is an admission refusal like any other (AC8), and nothing is
        // provisioned at this point.
        throw refuse(
          5,
          "headroom-failed",
          `headroom could not be determined: ${errorMessage(e)}`,
          errorRemediation(e, "fix .sandbox/quota-limits.json, then retry — nothing was provisioned"),
          providerCodePayload(e),
        );
      }
      if (!headroom.allowed) {
        // `list-unverified` is the SUBSTRATE failing to answer (quota.ts
        // fail-closes on any list error or contract violation), not the brief or
        // the budget being wrong — but exit 5 maps to do-not-retry `logic` by
        // default. The override is what tells wave 2's retry logic this one is
        // transient; `vm-ceiling` and `pooled-disk` stay `logic`, since waiting
        // is exactly what their remediations prescribe.
        const listUnverified = headroom.reason === "list-unverified";
        throw refuse(
          5,
          "no-headroom",
          `refusing dispatch: ${headroom.reason ?? "headroom"} — live ${headroom.liveVms}/${headroom.ceiling}, headroom ${headroom.headroom}`,
          "wait for a slot (fleet status), tear a run down, or raise the ceiling in the quota limits",
          { reason: headroom.reason, liveVms: headroom.liveVms, ceiling: headroom.ceiling, headroom: headroom.headroom },
          listUnverified ? ("transient" as ExitStatus) : undefined,
        );
      }
    }
    // AC7: budget admission always runs (a single dispatch is not exempt). The
    // ledger is constructed INSIDE the try: an unopenable or busy ledger is an
    // admission refusal (exit 5), not an untyped exit 1 (INV-COST-6 — a ledger
    // that cannot be read is never read as zero spend).
    //
    // B1 (DEFENSE-IN-DEPTH): validate `capMicroUsd` at the dispatch boundary,
    // before it reaches the budget gate. The gate also validates; this is the
    // early guard that catches bad input before admission work begins.
    // undefined ⇒ default cap path (byte-for-byte pre-DF3.2 behavior).
    if (
      deps.capMicroUsd !== undefined &&
      (!Number.isInteger(deps.capMicroUsd) ||
        deps.capMicroUsd <= 0 ||
        deps.capMicroUsd > Number.MAX_SAFE_INTEGER)
    ) {
      throw refuse(
        2,
        "invalid-cap",
        `capMicroUsd must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER}, got ${deps.capMicroUsd}`,
        "pass a positive integer micro-dollar cap, or omit for the default",
        { capMicroUsd: deps.capMicroUsd },
      );
    }
    let ledger: LedgerLike | undefined;
    let decision: Extract<AdmissionDecision, { admitted: true }>;
    try {
      ledger = deps.ledgerFactory();
      // No cast. `assertWithinBudget` takes `BudgetLedger`, a structural slice
      // of the same class `LedgerLike` is picked from — the widening the old
      // `ledger as CostLedger` here was waiting on has landed in
      // `src/providers/budget-gate.ts`. The cast outlived it, and a cast is
      // exactly the drift the two Pick<>s exist to prevent: it would have let a
      // fake missing a member compile and throw at runtime.
      // Third arg (DF3.2/DD-9): the caller's per-run key cap. Undefined ⇒ the
      // gate's own default — byte-for-byte the pre-DF3.2 behavior.
      decision = assertWithinBudget(
        ledger,
        { repoSlug, issueId, runId, requestId },
        deps.capMicroUsd,
      );
    } catch (e) {
      if (e instanceof OverBudgetError) {
        throw refuse(5, "budget-exceeded", e.message, e.remediation, {
          code: e.code,
          capMicroUsd: e.capMicroUsd,
          spentMicroUsd: e.spentMicroUsd,
          reservedMicroUsd: e.reservedMicroUsd,
          unpricedRows: e.unpricedRows,
        });
      }
      if (e instanceof CostLedgerError) {
        // A FIXED fleet code, with the ledger's own in the payload — the same rule
        // `providerCodePayload` states and the CorrelationError arm above applies.
        // `refuse(5, e.code, …)` made this CLI's exit-code table whatever
        // `cost-ledger.ts` currently emits: an operator greps the dispatch log for
        // a fleet code, and a rename over there silently changed which rows they
        // find. That the ledger's table is first-party and closed does not make it
        // THIS table — it makes it a table two modules would have to be renamed in
        // step, which is the drift the rule exists to prevent.
        //
        // The MESSAGE and the REMEDIATION stay the ledger's: those are diagnosis
        // and the operator's literal next command, and neither is a classification.
        throw refuse(5, "ledger-failed", e.message, e.remediation, providerCodePayload(e));
      }
      // Everything else — a raw bun:sqlite SQLITE_BUSY, ENOENT/EACCES on the
      // ledger file, a TypeError out of a misconfigured `deps.ledgerFactory` — is
      // the SAME refusal the comment above promises for an unopenable or busy
      // ledger, which was only ever true for the two TYPED errors. A bare rethrow
      // bypassed `refuse` entirely: no dispatch-log entry, no structured line, no
      // runId on the payload, bare CLI exit 1.
      throw refuse(
        5,
        "admission-failed",
        `budget admission failed: ${errorMessage(e)}`,
        errorRemediation(e, "fix or move the cost ledger, then retry — nothing was provisioned"),
        providerCodePayload(e),
      );
    } finally {
      try {
        ledger?.close();
      } catch (e) {
        // A close failure must not MASK the gate's own outcome — rethrowing here
        // would replace an OverBudgetError refusal with an IO error, and would
        // turn a successful admission into a failure after the reservation was
        // already committed. But silence is worse than either: `close()` is where
        // the reservation write is flushed, so a throw here (SQLITE_BUSY, IO)
        // means the ledger may hold NO record of the admission just granted — and
        // the next dispatch for this issue then reads a stale `reservedMicroUsd`
        // and overcommits the cap. Named on the structured log so the overcommit
        // is diagnosable after the fact.
        //
        // Deliberately NOT a refusal: dispatch cannot tell a failed flush from a
        // failed release of an already-durable write, and refusing on the second
        // would burn the issue's cap on a reservation the orphan guard then has
        // to age out. Report, proceed, let the ledger's own guard arbitrate.
        const durationMs = now() - wallStart;
        try {
          log({
            requestId,
            operation: "fleet.dispatch",
            agentId: null,
            timestamp: new Date().toISOString(),
            duration: durationMs,
            durationMs,
            status: "error",
            error: { code: "ledger-close-failed", message: redact(errorMessage(e)) },
            runId,
            verb: "dispatch",
            phase: "admitted",
            exitStatus: "transient" as ExitStatus,
          });
        } catch {
          // a throwing sink must not become the failure this handler reports
        }
      }
    }
    // AC9b: the ONE ceiling — DF2.8 computed min(keyCap, remaining); propagate.
    const effectiveCeilingMicros = decision.admittedCeilingMicroUsd;
    // A zero ceiling is an admission that buys nothing: the mint refuses a
    // non-positive cap and the manifest stamp rejects 0, so the run would exist,
    // bill box-hours and be unable to spend a micro-dollar. That is a refusal
    // (exit 5), not a provisioning step.
    //
    // `isSafeInteger`, not `isInteger`: `Number.isInteger(1e300)` is true, so an
    // unsafe ceiling passed this guard, provisioned a box and a key, and only
    // then died in `stampManifestLimit` (which does bound it) — INV-2 in reverse.
    // The same bound is on the manifest schema, so the three agree.
    //
    // ponytail: this refusal fires AFTER `assertWithinBudget` committed the
    // admission, and cannot be moved before it — the ceiling under test IS the
    // decision's own output.
    //
    // It is also, today, UNREACHABLE from this call site, which is why the
    // reservation it would strand is not worth a compensating release:
    // `admitIssue` refuses a non-positive `capMicroUsd` before it writes anything,
    // returns `admitted: false` unless `remainingMicroUsd > 0`, and then computes
    // `min(keyCapMicroUsd, remaining)` — and dispatch never passes
    // `keyCapMicroUsd`, so it is `defaultKeyCapMicroUsd`, a positive literal. The
    // guard stays because it is the one thing standing between a future change to
    // any of those three and a run that bills box-hours it can never spend.
    // The reservation is retired by the ledger's orphan
    // guard: `store.create` never runs on this path, so no record ever resolves
    // for this id and the admission stops counting once it ages past the ledger's
    // orphan window (`ADMISSION_GRACE_MS` + `ADMISSION_SKEW_MARGIN_MS`, the margin
    // added in review round 4 so a reader whose clock runs ahead of the writer's
    // cannot expire a live reservation and grant its headroom twice).
    // Retiring it sooner needs a ledger-side release, which `admitIssue`'s
    // contract deliberately does not offer and this layer holds no handle for.
    //
    // ponytail: the arm is kept UNRELEASED because it is unreachable, and that
    // is a claim about three things outside this file. UPGRADE TRIGGER — the
    // first of these makes it reachable, and a reachable arm strands a real
    // reservation for the whole orphan window and needs the compensating
    // release above instead of this comment:
    //   1. dispatch starts passing `keyCapMicroUsd` to `assertWithinBudget`
    //      (today it never does, so the clamp is a positive literal);
    //   2. `defaultKeyCapMicroUsd` stops being a positive literal;
    //   3. `admitIssue` admits on a non-positive `remainingMicroUsd` or stops
    //      refusing a non-positive `capMicroUsd`.
    // A `no-ceiling` refusal appearing in the dispatch log is the same signal
    // arriving the expensive way.
    if (!Number.isSafeInteger(effectiveCeilingMicros) || effectiveCeilingMicros <= 0) {
      throw refuse(
        5,
        "no-ceiling",
        `admitted ceiling is ${effectiveCeilingMicros} µ$ — the run could not spend anything`,
        `raise the cap via .sandbox/cost-config.json perIssueOverrides for ${repoSlug}#${issueId}, or pick another issue`,
        {
          admittedCeilingMicroUsd: effectiveCeilingMicros,
          capMicroUsd: decision.capMicroUsd,
          spentMicroUsd: decision.spentMicroUsd,
          reservedMicroUsd: decision.reservedMicroUsd,
        },
      );
    }

    // ── 6. record → box (INV-3: record → box → key, enforced by construction).
    // The sequence is provisionAdmittedRun — the same body createRun composes —
    // so the record-before-VM invariant cannot drift between the two callers.
    //
    // The gap between the admission above and this call — admitIssue's COMMIT to
    // store.create's rename, two processes with no shared lock — is closed on the
    // LEDGER side, and only there. The orphan window (cost-ledger.ts,
    // `ADMISSION_GRACE_MS` plus `ADMISSION_SKEW_MARGIN_MS`) makes its orphan guard
    // count an admission younger than that window toward `reservedMicroUsd`
    // whether or not the run record resolves yet, so a concurrent dispatch for the
    // same issue sees this reservation from the instant it commits. Two dispatches
    // can no longer both be granted the full remaining headroom. Do not "fix" that
    // half with a ledger/store transaction or a global dispatch lock — the first is
    // unnecessary now and the second would serialise DF3.2's N-arm fan-out.
    //
    // The FLEET-CEILING half is closed IN-PROCESS and only in-process (DF3.2,
    // finding DF13 from the df3-1 round-10 review): step 5's `checkHeadroom`
    // read, the budget decision and this create all run inside
    // `withAdmissionSingleFlight`, so a second in-process dispatch re-lists
    // after this box exists and refuses on `vm-ceiling` exactly like the
    // sequential case. The orphan-window argument above never reached this
    // half — a ledger reservation is money, not a box — which is why the
    // arbiter here is execution order, not the ledger.
    //
    // What deliberately stays OPEN: two CLI invocations in separate processes,
    // and a fan-out's aggregate `checkHeadroom(N)` racing a concurrent plain
    // dispatch's own list. Both need a RESERVATION at the quota layer — an
    // intent record a concurrent `checkHeadroom` counts as live until the box
    // appears or the intent ages out, the same shape `admitIssue` already has
    // for spend. That is a providers-layer change (DF2.6 owns the fleet
    // ceiling; this module owns only the call site) and the round-10 handoff's
    // documented follow-up. Until it lands, overshoot is bounded by the
    // processes racing inside one list round trip, and the DF2.6 reaper still
    // sees and prices every box.
    //
    // Still keep this gap short: the grace window is a floor on how long a
    // genuinely orphaned reservation (store.create failed, so no run can ever
    // report spend) holds the issue's cap. Distinct from the post-provision case
    // below, where the reservation is retained deliberately and for as long as the
    // box lives.
    const tCreate = now();
    // Wrapped, because this step STRADDLES the record: `provisionAdmittedRun`
    // writes the run record first (INV-1) and only then creates the box, so a
    // throw from the budget-extension write or from `driver.create` leaves a real
    // record on disk. An untyped throw escaping here carries no `runId`, and the
    // CLI's failure line would then report `runId: null` for a run an operator can
    // see in `fleet status` — the one case where they most need the id. `refuse`
    // stamps it (plus the debug/teardown commands) onto the payload, and files the
    // dispatch-log entry that AC4 evidence is read out of.
    let provisioned: Awaited<ReturnType<typeof provisionAdmittedRun>>;
    /**
     * INV-4-bis's join key onto the record, best-effort, from every path that can
     * leave THIS dispatch's own record behind.
     *
     * `store.create` takes only an id, so the correlation can only be WRITTEN once
     * a record exists — but the value has been known since step 2, and the write
     * used to happen only after `provisionAdmittedRun` RETURNED. On the two paths
     * where it does not return, the record survived with no `requestId` and (on
     * the timeout path) no `vmName` either: `fleet status` showed an open run that
     * joins to no log line anywhere, forever. So it is attempted from the create
     * step's own failure path, and again from the abandoned-success handler, which
     * is the moment a record created by a call this dispatch had already given up
     * on is known to exist.
     *
     * NOT from the `run-id-in-use` arm: there the EEXIST names a record this
     * dispatch did not create — the winner's, on the shared-runId race — and
     * stamping would merge this dispatch's `requestId` onto it, inverting the
     * join key. See the provisioning catch.
     *
     * Best-effort by construction: the record may not exist yet (ENOENT, on the
     * pre-check timeout), and a failure to stamp a correlation must never replace
     * the refusal being reported. The authoritative fix is a `store.create` that
     * takes the id and the correlation together — a run-record change, not this
     * layer's.
     */
    const stampCorrelation = (): void => {
      try {
        deps.store.set(runId, { requestId });
      } catch {
        // no record to stamp (or an unwritable one) — the refusal stands either way
      }
    };
    try {
      provisioned = await within(
        "create",
        () => {
          // INSIDE the thunk, so it means "provisioning STARTED", not "provisioning
          // was about to start": `within`'s `left <= 0` pre-check throws before the
          // thunk runs, and that create never touched the store or the driver.
          // `refuse` gates its teardown remediation on this (see the declaration).
          ctx.provisionAttempted = true;
          return provisionAdmittedRun(deps.driver, deps.store, {
            runId,
            // `port` is deliberately withheld: provisionAdmittedRun exposes and makes
            // the box PUBLIC immediately after create, i.e. before the setup gate has
            // proved anything — and INV-5 then forbids tearing that box down. The
            // expose/setPublic pair runs here instead, after gate.ready (step 10).
            budget: {
              repoSlug,
              issueId,
              capMicroUsd: decision.capMicroUsd,
              spentMicroUsd: decision.spentMicroUsd,
              reservedMicroUsd: decision.reservedMicroUsd,
              admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd,
            },
          });
        },
        (p) => {
          // The box exists and this dispatch has already refused, so the record is
          // the only place either fact can still be joined from. `vmName` lands
          // there via `provisionAdmittedRun` itself; the correlation is this
          // layer's, and this is the first instant a record is known to exist.
          stampCorrelation();
          return {
            vmName: p.vm.name,
            ...(p.vm.httpsUrl === undefined ? {} : { httpsUrl: redact(p.vm.httpsUrl) }),
          };
        },
      );
    } catch (e) {
      // Whatever went wrong, a record may exist FOR THIS ID — but whether it is
      // THIS dispatch's own decides whether the correlation may be stamped onto
      // it. INV-1 writes the record before anything billable, so most paths here
      // own whatever record they leave; the exception is the loser of a
      // shared-runId race, whose EEXIST names the WINNER's record file. Stamping
      // unconditionally merged THIS dispatch's requestId onto that record (the
      // store merges patches), inverting INV-4-bis's join key: the winner's log
      // lines then join to the loser's dispatch and vice versa. So — stamp on the
      // timeout arm first (its record, when one exists, was written by this call:
      // `store.create` succeeded before `driver.create` could be in flight), skip
      // it on the run-id-in-use arm below (the record is someone else's), and
      // stamp again past both arms, where the record can only be ours.
      //
      // `timedOut` already produced one (and already refused) — do not
      // double-log it. Checked against the marker, not the class: a FleetError
      // a seam threw WITHOUT refusing takes the typed arms below instead of
      // escaping bare.
      if (alreadyRefused(e)) {
        stampCorrelation();
        throw e;
      }
      // `store.create`'s O_EXCL is the AUTHORITATIVE arbiter of run-id identity;
      // the step-4 check is a fast path. Two concurrent dispatches sharing an
      // explicit `opts.runId` (DF3.2's fan-out shape) both pass that check and
      // both commit a reservation — exactly one wins the create, and the loser
      // must get the SAME exit-2 `run-id-in-use` refusal the sequential case
      // gets, not a generic exit-1 "provisioning failed" naming the wrong cause.
      //
      // The loser's reservation stays outstanding, and this layer cannot retire
      // it: the ledger's orphan guard expires an admission only when NO record
      // resolves for the id, and the winner's record resolves under exactly this
      // id. `admitIssue`'s contract states no caller may release a reservation,
      // and the ledger handle is closed by the `finally` above. Retiring it needs
      // a ledger-side rule for a losing admission — cross-cluster, not here.
      //
      // Scoped to the RECORD half. `within("create", …)` wraps the whole of
      // `provisionAdmittedRun` — `store.create`, the budget `store.set` AND
      // `driver.create` — and `code === "EEXIST"` alone claimed every one of them
      // for `run <id> already has a record`. A dir-box driver whose create does
      // `mkdir` over a leftover box directory (reachable exactly after an
      // abandoned-create timeout left a box named after the run id) therefore came
      // out as exit 2 `logic`, do-not-retry, advising "omit runId for a fresh one"
      // — while the true state was: record created by THIS dispatch, budget
      // written, no box name recorded, and a retryable substrate condition. The
      // operator moves on and this dispatch's record stays open with its
      // reservation outstanding against the issue cap.
      //
      // `path` is what separates them, and Node sets it on every fs error:
      // `store.create` opens `store.path(runId)` with `wx`, so a genuine run-id
      // collision names that exact file and a box-side `mkdir` names the box.
      // A PATHLESS EEXIST no longer takes this arm by elimination: it could be
      // the run-id race, but it could equally be a PROVIDER reporting "box
      // already exists" as a bare errno — and refusing THAT as exit-2
      // do-not-retry "omit runId" sent operators away from a retryable
      // substrate condition while THIS dispatch's record stayed open with its
      // reservation outstanding against the issue cap. The residual is now
      // pointed the cheaper way: a pathless EEXIST gets exit 1 (retryable) via
      // the typed provider-error surface below; only an EEXIST whose PATH
      // matches the record file stays the exit-2 arbiter verdict. Cost: a
      // store whose backend genuinely races without ever setting `path` is
      // reported as provision-failed instead of run-id-in-use — the record is
      // still OPEN either way and nothing was double-booked beyond what the
      // race itself books, so this misclassification is diagnosis-only.
      const errno = e as (NodeJS.ErrnoException & { path?: unknown }) | null | undefined;
      // Compare RESOLVED forms, not raw strings. `store.path(runId)` is absolute;
      // an error's `path` can be the relative form (`runs/<id>.json`) or traverse
      // a symlinked directory, and exact string equality misread both as
      // provision-failed — exit 1, retryable substrate advice, for what is really
      // the run-id race. Basenames as the fallback: the record file's name is
      // `<runId>.json`, which no box-side mkdir collides with by accident.
      const reportedPath = typeof errno?.path === "string" ? errno.path : undefined;
      const recordPath = deps.store.path(runId);
      const pathsMatch =
        reportedPath !== undefined &&
        (resolve(reportedPath) === resolve(recordPath) ||
          basename(reportedPath) === basename(recordPath));
      if (errno?.code === "EEXIST" && pathsMatch) {
        // No stampCorrelation here, deliberately: the EEXIST names a record this
        // dispatch did not create — the winner's, in the race case. See the catch
        // header.
        throw refuse(
          2,
          "run-id-in-use",
          `run ${runId} already has a record`,
          `omit runId for a fresh one, or tear the existing run down: bun scripts/fleet.ts teardown ${runId}`,
        );
      }
      // Past both arms above, any record under this id was created by THIS call
      // (INV-1) and the correlation belongs on it — best-effort exactly as the
      // helper promises: the refusal below must not be replaced by a stamp
      // failure.
      stampCorrelation();
      throw refuse(
        1,
        "provision-failed",
        `provisioning failed for run ${runId}: ${errorMessage(e)}`,
        errorRemediation(
          e,
          // Deliberately not "the box is alive": whether it exists depends on which
          // half of record→box failed. Teardown is idempotent over both.
          `inspect the run, then tear it down: bun scripts/fleet.ts teardown ${runId}`,
        ),
        providerCodePayload(e),
      );
    }
    return { provisioned, effectiveCeilingMicros, tCreate };
  });
  const { vm } = provisioned;
  phase("create_ms", now() - tCreate);
  ctx.vmName = vm.name;

  // Everything past this point runs with a billable box alive. INV-5: no
  // failure here destroys it — each one is converted into a FleetError that
  // names the debug and teardown commands, logs its dispatch-failure entry and
  // leaves the record OPEN, exactly as the gate failure does.
  //
  // The issue's reservation stays OUTSTANDING on these paths, and that is the
  // correct figure — not a leak, and nothing here should be "fixed" to release
  // it. `admitIssue` counts a reservation until a priced `cost_event` lands for
  // the run (its `NOT EXISTS (… cost_events … unpriced = 0)` clause), and a run
  // that dies past this point still has a LIVE box billing box-hours and — once
  // step 7 has run — a key live at the FULL admitted ceiling, because INV-5
  // keeps both alive so an operator can diagnose the failure. The exposure is
  // real, so the reservation that represents it must stay against the issue's
  // cap; it retires when teardown closes the record and the box-hours row is
  // priced. A compensating release here would under-report live risk and let a
  // second dispatch overcommit the same cap.
  ctx.httpsUrl = vm.httpsUrl;
  try {
    // `store.create` takes only an id, so between it and this line the record
    // exists WITHOUT a `requestId` — for the whole of `driver.create()`, which
    // is the longest window in provisioning. A concurrent `fleet status` reads a
    // record it cannot join to anything. Not fixed here: widening `create` to
    // take the id and the correlation together is a run-record change, and it is
    // the right one. Until then this is the first write after provisioning, so
    // the window is as short as this layer can make it — and it is no longer
    // UNBOUNDED on the paths where this line never runs, because the create
    // step's own failure and abandoned-success handlers stamp it too (see
    // `stampCorrelation`). This stays the ordinary path.
    //
    // INV-4-bis: the correlation id is the cross-layer join key, so it has to be
    // ON the record — `fleet status` is the operator's only inspection surface,
    // and a run that dies at the gate is exactly the one whose logs they need to
    // find. First write after provisioning, so every later failure path still
    // leaves a joinable record. Not best-effort HERE, unlike `stampCorrelation`:
    // on the success path a store that cannot take this write is a real failure,
    // and the catch below turns it into a typed exit 1 with the box left alive
    // (INV-5).
    deps.store.set(runId, { requestId });

    const mintedCeilingMicros = await mintAndDeliverKey(ctx, deps, {
      requestId,
      runId,
      vm,
      effectiveCeilingMicros,
    });

    // ── 8. fill at the pinned SHA (AC9a: manifest is the cap's only carrier) ─
    const tFill = now();
    const stamped = stampManifestLimit(loaded, mintedCeilingMicros);
    // AC9: the manifest is the cap's only in-box source (9a); the run context
    // carries the same computed-once ceiling for DF1.6's spawn seam (9b), plus
    // the issue deep link the brief supplied — the box's own back-reference to
    // the issue that authorized it.
    const files = [
      { path: "pipeline.yaml", content: serializeManifest(stamped) },
      {
        path: "run-context.json",
        content: JSON.stringify({
          runId,
          pipelineId: stamped.manifest.pipelineId,
          requestId,
          // The MINTED ceiling, same figure the manifest above is stamped with —
          // 9a and 9b must not name two different numbers.
          effectiveCeilingMicros: mintedCeilingMicros,
          repoSlug,
          // `String`, the same shape the ledger key and the run record carry.
          // One identity in two types is two identities to anything that joins
          // them, and this file is DF1.6's spawn seam.
          issueId,
          // `linkSafe`, not verbatim. Step 10 can make this box PUBLIC, and the
          // schema constrains `issueUrl`'s scheme only — so a brief carrying
          // `?installation_token=ghs_…` wrote that token to disk for every agent
          // in the box, on the one copy of the link that was not redacted. The
          // path stays clickable, which is all the back-reference needs.
          ...(correlation.issueUrl === null
            ? {}
            : { issueUrl: linkSafe(correlation.issueUrl) }),
        }),
      },
    ];
    const exedevDriver = isExedevDriver(deps.driver) ? deps.driver : undefined;
    if (exedevDriver !== undefined) {
      // exedev: clone the repo at the pinned SHA first, then place the manifest.
      // `repoUrl` and `commitSha` reach a git invocation inside a billable box,
      // and the brief schema is what constrains them: `repoUrl` is an
      // `https://`-only, control-char-free, userinfo-free URL (so `file:///etc`,
      // `ssh://` and an `--upload-pack=…` argument are all refused at ingress)
      // and `commitSha` is `/^[0-9a-f]{40}$/`. Nothing is re-derived here — a
      // second copy of a security rule is the one that rots.
      //
      // Gated on the SAME predicate as the gate below (see `isExedevDriver`):
      // keyed on `.fill` alone, a driver with `fill` and no `setup` got its repo
      // cloned and was then handed the dir-box gate, which probes for none of it.
      await within(
        "clone",
        () =>
          exedevDriver.fill(vm.name, {
            runId,
            repoUrl: valid.repoUrl,
            commitSha: valid.commitSha,
          }),
        // Resolves `void`; what a late one means is that the repo landed in the
        // box AFTER the operator was told the dispatch failed. The box is the
        // fact.
        () => ({ vmName: vm.name, clonedLate: true }),
      );
    }
    await within("fill", () => fillRun(deps.driver, vm.name, files));
    phase("fill_ms", now() - tFill);

    // ── 9. setup gate (AC3: failure keeps record open, box alive — INV-5) ────
    const tGate = now();
    const gateFn =
      deps.setupGate ??
      ((drv: ProviderDriver, box: string, o: GateOpts) => {
        if (isExedevDriver(drv)) {
          // No `as never`, no `as Parameters<…>`: `hasExedevSetup` narrows the
          // driver and `SetupGateOptions` accepts this literal on its own. The
          // casts switched off checking on BOTH arguments of the one call that
          // most needs it.
          //
          // `requestId` IS forwarded (INV-4-bis). `SetupGateOptions.requestId`
          // exists for exactly this, and the gate falls back to the DRIVER's own
          // id when it is absent — a different id from the ack whenever the
          // driver was not built by this dispatch, which is precisely the run
          // (one that died at the gate) whose lines an operator most needs to
          // join. Every gate log line carries it.
          return realSetupGate(drv, box, {
            runId: o.runId,
            requestId: o.requestId,
            rosterPath,
            commitSha: o.commitSha,
          });
        }
        return fakeGate(drv, box, o);
      });
    const gateResult: unknown = await within("gate", () =>
      gateFn(deps.driver, vm.name, { runId, commitSha: valid.commitSha, requestId }),
    );
    phase("setup_gate_ms", now() - tGate);
    // The RESULT OBJECT is defended too, not only its fields. `deps.setupGate`
    // is an injection seam, and the "every read of the gate's own result is
    // DEFENDED" claim below covered `assertions`/`debugCommands`/`failedItem`
    // while `gate.ready` itself was an unguarded property read: a gate returning
    // `undefined` or `null` threw a TypeError that escaped to the outer catch and
    // became exit-1 `dispatch-failed`, losing exactly the exit-3 classification
    // the defence exists to keep. Typed `unknown` on the way out of `within` so
    // the declared `SetupGateResult` cannot re-assert what the seam does not
    // guarantee — the same reason the reads below are guarded at all.
    if (gateResult === null || typeof gateResult !== "object") {
      throw refuse(
        3,
        "setup-gate-invalid",
        `the setup gate returned ${gateResult === null ? "null" : typeof gateResult} instead of a result object`,
        "the box is ALIVE and the record is OPEN (INV-5) — inspect it, then fix the gate passed via deps.setupGate",
        { returned: gateResult === null ? "null" : typeof gateResult },
      );
    }
    const gate = gateResult as SetupGateResult;
    ctx.gate = gate;
    // STRICT BOOLEAN. A truthy non-boolean ready (`"no"`, `1`) sailed past this
    // check and dispatched on a gate that never passed — every sibling field of
    // the same seam is defended, and `!gate.ready` was the one read still
    // trusting it. Non-boolean ⇒ invalid gate result, same refusal path as the
    // non-object shape above.
    if (typeof gate.ready !== "boolean") {
      throw refuse(
        3,
        "setup-gate-invalid",
        `the setup gate returned ${typeof gate.ready} for ready instead of a boolean`,
        "the box is ALIVE and the record is OPEN (INV-5) — inspect it, then fix the gate passed via deps.setupGate",
        { returned: typeof gate.ready },
      );
    }
    if (!gate.ready) {
      // AC3: the refusal is recorded on the RUN RECORD as well as host-side —
      // an operator reading `fleet status` must see why the run is open. The
      // record stays open and the box alive (INV-5); the write is best-effort
      // because the host-side dispatch log inside `refuse` is the authoritative
      // copy and must not be pre-empted by a record-write failure.
      try {
        deps.store.set(runId, {
          extensions: {
            gate: {
              outcome: "failed",
              // Omitted when absent, never defaulted: `"unknown"` is outside the
              // "A".."E" table and `0` is outside the 1|2|3|4 assertion-code
              // table, so a sentinel is a value no consumer of this record
              // knows how to read.
              ...(gate.failedItem === undefined ? {} : { failedItem: gate.failedItem }),
              ...(gate.assertionCode === undefined ? {} : { assertionCode: gate.assertionCode }),
              failedAt: new Date().toISOString(),
            },
          },
        });
      } catch (e) {
        // Guarded and redacted for the same reasons as `refuse`'s own stderr
        // fallback: an EPIPE here (a piped CLI whose reader exited) would
        // otherwise downgrade this exit-3 gate refusal to a bare exit-1
        // `dispatch-failed`, which names the wrong cause entirely.
        try {
          process.stderr.write(`gate outcome not recorded on run ${runId}: ${redact(errorMessage(e))}\n`);
        } catch {
          // nothing left to report it on
        }
      }
      // Every read of the gate's own result is DEFENDED, because the gate is an
      // injection seam: `deps.setupGate` is caller-supplied, and one returning
      // `{ready:false, assertions:[]}` threw a TypeError out of the `.join`
      // below, escaped to the outer catch and became an exit-1
      // `dispatch-failed` — losing the exit-3 classification and every piece of
      // assertion evidence this refusal exists to carry. `refuse` already
      // guards the same two reads (`ctx.gate?.debugCommands ?? […]`); this call
      // site did not, and it is the one that names them to the operator.
      //
      // Absence is not the only shape a seam can lie about: a TRUTHY non-array
      // (`{ready:false, debugCommands:"x"}` or `assertions:"x"`) sailed past
      // every `??` here and threw out of `.join`/`.map`/`.find`/`.some`
      // instead — the same downgrade, one call later. Array-ness AND ELEMENT
      // shape are checked here, once: `{assertions:[null]}` passed the
      // array-ness guard and still threw out of the `.find` below, downgrading
      // this exit-3 refusal to exit-1 two lines after its own defence ran.
      const gateAssertions = (
        Array.isArray(gate.assertions) ? (gate.assertions as unknown[]) : []
      ).filter((a): a is AssertionResult => a !== null && typeof a === "object");
      // An EMPTY array counts as absent here exactly as it does in `refuse`'s
      // payload arm: a live box left with zero debug commands is the outcome
      // this fallback exists to prevent, whatever shape the absence took.
      const debugCommands =
        Array.isArray(gate.debugCommands) && gate.debugCommands.length > 0
          ? gate.debugCommands
          : [`bun scripts/fleet.ts status ${runId}`];
      const teardownCommand = gate.teardownCommand ?? `bun scripts/fleet.ts teardown ${runId}`;
      // An empty (or all-passing) `assertions` on a `ready:false` gate yielded
      // `setup gate failed at item ?: ` — a refusal that keeps a billable box
      // alive to explain itself and then explains nothing. Name the absence.
      //
      // `escapeText` over every gate-supplied string. An exedev assertion
      // `note` is whatever the BOX printed, and it lands in three operator-
      // facing sinks (stderr via the dispatch log, the CLI-printed payload, the
      // structured line). `refuse` redacts them — but redaction is about
      // secrets, and a note of `"\x1b[2J"` or `"\nFLEET dispatch ok
      // runId=fake"` is not a secret, it is a terminal escape and a forged log
      // line. The same holds for everything else here the gate chose — the
      // debug/teardown COMMAND strings and the assertion ITEM LABELS come off
      // the same result object the note does — so they get the treatment too;
      // only the locally composed `bun scripts/fleet.ts …` fallbacks are this
      // module's own text. The `invalid-brief` path has escaped its third-party
      // text since it was written; these are the module's other sources of it.
      const failedNote = gateAssertions.find((a) => !a.ok)?.note;
      throw refuse(
        3,
        "setup-gate-failed",
        `setup gate failed at item ${escapeText(gate.failedItem ?? "?")}: ${
          failedNote === undefined
            ? "the gate reported no failing assertion — inspect the box directly"
            : escapeText(failedNote)
        }`,
        `debug: ${debugCommands.map(escapeText).join("; ")} — teardown when done: ${escapeText(teardownCommand)}`,
        {
          assertionCode: gate.assertionCode,
          failedItem: gate.failedItem,
          // `refuse` redacts every string leaf of the payload at the choke
          // point, so nothing here (or at any other call site) repeats THAT.
          // The escaping is a different guarantee and is not at a choke point:
          // item labels come off the gate's result object just like the notes,
          // so they get it too.
          assertions: gateAssertions.map(
            (a) => `${escapeText(a.item)}:${a.ok ? "ok" : escapeText(a.note)}`,
          ),
        },
        // A gate that failed because the PROBE NEVER RAN is a broken box, not a
        // bad brief: retryable. The default exit-code mapping calls every non-1
        // exit `logic` (do-not-retry), which discards the one classification
        // `substrateFailure` is computed to produce.
        //
        // The GATE OBJECT ITSELF is passed — not `{...gate}`. Classification
        // reads a side channel keyed by object identity (the structured
        // replacement for scanning note text), and a spread copy keys as a new
        // object: an unmarked gate, misclassified non-substrate.
        isSubstrateFailure(gate) ? ("transient" as ExitStatus) : undefined,
      );
    }
    // The gate PROVED this box — stamp the money identity on the record: the
    // exact SHA the box was filled to and gated against (T2.1 live 2026-08-25:
    // the ack carried vmName but `fleet status`/audit could not answer "which
    // commit is this billable box running?"). Best-effort like its sibling
    // record writes: a failed stamp must not kill a healthy dispatch.
    try {
      deps.store.set(runId, { commitSha: valid.commitSha });
    } catch (e) {
      try {
        process.stderr.write(`commitSha not recorded on run ${runId}: ${redact(errorMessage(e))}\n`);
      } catch {
        // nothing left to report it on
      }
    }
    await exposeGatedBox(ctx, deps, { runId, vm });
  } catch (e) {
    // Same rule as the key-delivery arm: rethrow only a refusal that ALREADY
    // went out. A FleetError thrown straight past `refuse` (a seam's own
    // construction, not this module's) used to escape bare — no dispatch-log
    // entry, no structured line, no payload on it for the CLI to print.
    if (alreadyRefused(e)) throw e;
    throw refuse(
      1,
      e instanceof FleetError ? "dispatch-refused" : "dispatch-failed",
      e instanceof FleetError
        ? `${e.message} — dispatch failed after the box was created`
        : `dispatch failed after the box was created: ${errorMessage(e)}`,
      errorRemediation(
        e,
        "the run record is OPEN and the box is ALIVE (INV-5) — inspect it, then tear it down",
      ),
      {
        ...(e instanceof FleetError && e.code !== undefined ? { code: e.code } : {}),
        ...providerCodePayload(e),
      },
    );
  }

  // ── 11. ack (AC2: synchronous, "provisioned", never "succeeded") ───────────
  // `state: "ready"` IS the AC's "provisioned": it says the box is up and the
  // gate proved it, not that the run's work finished. `DispatchResult.state`
  // admits no other literal, so there is no "succeeded" for it to be confused
  // with — the AC is met, the wording just differs from the literal.
  const durationMs = now() - wallStart;
  // GUARDED. This is the LAST thing a fully successful dispatch does: the box is
  // alive, the key is delivered at the full admitted ceiling, the gate passed
  // and the record is written — and it runs AFTER the try/catch above has ended,
  // so a throwing sink escaped as a raw non-`FleetError` with no dispatch-log
  // entry and no `runId` on it. The operator's natural response to that bare
  // failure (tear down, retry) re-spends the issue's cap on a run that had
  // already SUCCEEDED. A sink failure is never the run's failure.
  try {
    log({
      requestId,
      operation: "fleet.dispatch",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "ok",
      runId,
      issueUrl: linkSafe(correlation.issueUrl),
      verb: "dispatch",
      phase: "ready",
      exitStatus: "success" as ExitStatus,
      httpsUrl: ctx.httpsUrl === undefined ? undefined : redact(ctx.httpsUrl),
      // Nested, not spread — see `refuse` for why a `Record<string, number>`
      // spread last can silently overwrite `status`/`runId`/`exitStatus`.
      timings: { ...timings },
    });
  } catch {
    // see `refuse`
  }
  return {
    runId,
    requestId,
    state: "ready",
    vmName: vm.name,
    ...(ctx.httpsUrl === undefined ? {} : { httpsUrl: ctx.httpsUrl }),
  };
}

