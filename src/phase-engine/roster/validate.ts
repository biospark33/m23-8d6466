/**
 * DF1.5 — dual slug validation + rate resolution.
 *
 * Every resolved slug goes through TWO independent gates before a run starts:
 *
 *   1. pi's merged catalog (`pi --list-models`)
 *   2. the provider's live model list (OpenRouter `GET /api/v1/models`)
 *
 * Neither alone is sufficient: pi's bundled catalog is stale in BOTH directions
 * — it rejects live slugs and still lists delisted ones (R5 §6 fact 13) — so a
 * slug clearing only one gate is rejected with the failing gate named (AC1).
 *
 * Verdicts are `pass | fail | unverified`. `unverified` is the fail-closed
 * answer whenever a gate could not be EVALUATED (missing pi binary, catalog
 * that exits 0 while printing `No models available`, provider API answering
 * non-200). It is never a pass by omission (INV-4), and it never blanks the
 * sibling gate's real verdict — the two gates are independent by construction.
 *
 * Exit codes: `0` all roles pass, `1` at least one slug rejected, `2` a gate
 * could not be evaluated. **`2` dominates `1`** — an unevaluated gate is not a
 * complete verdict — and the report still lists every rejection.
 *
 * INV-1 (credential): this module reads NO API key. OpenRouter's model list is
 * public, so the probe sends no Authorization header, and `readCustomRegistry`
 * extracts only `id` + `cost` from `~/.pi/agent/models.json` — the `apiKey`
 * field is never bound to a variable, let alone emitted. A key that is not in
 * the process is a key no emitter can leak; redaction is a second line, not
 * this one.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../providers/bounded-exec.ts";
import type { ResolvedRole, ResolvedRoster } from "./schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateVerdict = "pass" | "fail" | "unverified";

/** Which of the two rate tables supplied a role's price. */
export type RateSource = "bundled" | "models.json";

/**
 * Native unit a rate table states its numbers in. pi's own consumer divides
 * every `cost` field by 1e6 before multiplying by a token count
 * (`@earendil-works/pi-ai/dist/models.js:540-543`), and it applies that same
 * arithmetic to bundled-catalog entries and `~/.pi/agent/models.json` entries
 * alike — the two share one schema and one consumer. So both tables are
 * `usd-per-mtok`. `usd-per-token` exists because the unit must be *declared*
 * rather than guessed: a 10^6 error reads as a plausible number, so a table
 * whose unit cannot be determined is a rejection (INV-3), not a default.
 */
export type RateUnit = "usd-per-mtok" | "usd-per-token";

/**
 * AC6's contract, in integer MICRO-DOLLARS PER MILLION TOKENS. Per-million is
 * the unit precisely so cheap models survive integer rounding: $0.10/MTok is
 * `100_000` here, a number a ceiling check can act on, where the same rate per
 * token floors to `0` µ$ and silently disarms every downstream cap.
 *
 * Consumers project with `micros = tokens * ratePerMTok / 1_000_000`, dividing
 * at the projection site and nowhere else. This is the sole rate source for
 * DF3.6's pre-flight and DF3.3's resident accounting; neither re-derives rates.
 *
 * `source` is carried alongside the four rates because the Observability
 * Contract requires every per-role record to name the table that priced it,
 * and re-deriving that at the log site would mean running the lookup twice.
 */
export interface ResolvedRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  source: RateSource;
  /** Non-fatal advisories about how this rate resolved; usually empty. */
  warnings: string[];
}

/** A `cost` block as the two sources state it, in the table's native unit. */
export interface CostEntry {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RateTable {
  unit: RateUnit;
  /** `${provider}/${model}` → cost block. */
  entries: ReadonlyMap<string, CostEntry>;
}

export interface RateSources {
  bundled: RateTable;
  custom: RateTable;
}

export interface CustomRegistry {
  table: RateTable;
  /** Rejections: the registry is present but wrong (exit `1`). */
  problems: string[];
  /** Unavailable control: the registry could not be READ (exit `2`, INV-4). */
  unavailable: string[];
}

export interface CatalogProbe {
  /** False when the gate could not be EVALUATED (→ every slug `unverified`). */
  ok: boolean;
  /** `${provider}/${model}` pairs pi reports. */
  pairs: ReadonlySet<string>;
  reason?: string;
  /** Non-fatal advisories, e.g. pi drifting off the F13-pinned version line. */
  warnings?: readonly string[];
  durationMs: number;
}

export interface ProviderProbe {
  ok: boolean;
  /** Model ids the provider's live list reports. */
  ids: ReadonlySet<string>;
  reason?: string;
  durationMs: number;
}

/** Per-role observability record (Observability Contract). */
export interface RoleRecord {
  requestId: string;
  role: string;
  slug: string;
  provider: string;
  piCatalog: GateVerdict;
  providerApi: GateVerdict;
  source: RateSource | null;
  rate: ResolvedRate | null;
  /**
   * Time spent on THIS role — verdicts plus rate lookup. It is small by design:
   * both gates are probed once per run and memoized, so probe time belongs to
   * `catalogProbeMs`/`providerProbeMs` and cannot be attributed to a single
   * role. The run record's `durationMs` is the authoritative one.
   */
  durationMs: number;
  problems: string[];
  warnings: string[];
}

export interface RosterReport {
  requestId: string;
  roles: RoleRecord[];
  /** Roster-wide problems (e.g. a partial `models.json` cost block). */
  problems: string[];
  warnings: string[];
  exitCode: 0 | 1 | 2;
  catalogProbeMs: number;
  providerProbeMs: number;
  /** Authoritative run duration. */
  durationMs: number;
}

export interface ValidateDeps {
  probeCatalog?: () => Promise<CatalogProbe>;
  probeProvider?: (provider: string) => Promise<ProviderProbe>;
  /** Rate tables; omitted, they are loaded from pi's install + the host file. */
  rateSources?: RateSources;
  /** Rejections raised while reading the custom registry (AC3) — exit `1`. */
  registryProblems?: readonly string[];
  /** Read failures on the custom registry — unavailable control, exit `2`. */
  registryUnavailable?: readonly string[];
  requestId?: string;
  now?: () => number;
}

export class RateError extends Error {
  readonly code = "rate_unresolved";
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

// ---------------------------------------------------------------------------
// Unit conversion — the ONE place a native rate becomes µ$/MTok
// ---------------------------------------------------------------------------

const EMPTY_TABLE: RateTable = { unit: "usd-per-mtok", entries: new Map() };

/**
 * Plausibility band for a converted rate, in µ$/MTok. A value landing outside it
 * is far more likely a 10^6 UNIT error than a real price — and a unit error
 * reads as a plausible number, which is why the band exists rather than
 * trusting the declared unit alone. `0` is exempt: a genuinely free model is
 * priced `0`, not nearly-zero.
 *
 * The floor is $0.0001/MTok. The cheapest positive rate in pi's real bundled
 * catalog (1220 entries) is `$0.001`/MTok — a cache-read rate — so this leaves
 * 10x headroom under observed data while still catching a per-TOKEN figure read
 * as per-million for anything priced under ~$100/MTok. A floor of `1` µ$ (the
 * round-to-exactly-zero sliver) would NOT catch it: a $3/MTok model stated per
 * token is `0.000003`, which survives as `3` µ$/MTok — 10^6 too low, and every
 * downstream cap silently disarmed.
 */
const MIN_NONZERO_MICROS_PER_MTOK = 100;
const MAX_MICROS_PER_MTOK = 10_000_000_000;

/**
 * Convert a native rate to integer µ$ per MILLION tokens. Converts exactly once
 * at load (DD-9) so no consumer ever rescales.
 *
 * A value that is not a finite, non-negative number — or one outside the
 * plausibility band above — is a rejection rather than a guess: the same
 * fail-closed rule as a missing rate (INV-3).
 */
export function toMicrosPerMTok(value: unknown, unit: RateUnit): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RateError(`rate ${JSON.stringify(value)} is not a finite non-negative number`);
  }
  let micros: number;
  switch (unit) {
    // µ$ = USD * 1e6, and the figure is already per million tokens.
    case "usd-per-mtok":
      micros = Math.round(value * 1_000_000);
      break;
    // USD/token → µ$/MTok is another 1e6: 1e-7 USD/token === 100_000 µ$/MTok.
    case "usd-per-token":
      micros = Math.round(value * 1_000_000_000_000);
      break;
    default:
      throw new RateError(`rate unit could not be determined: ${JSON.stringify(unit)}`);
  }
  if (value > 0 && micros < MIN_NONZERO_MICROS_PER_MTOK) {
    throw new RateError(
      [
        `rate ${value} (${unit}) resolves to ${micros} µ$/MTok, below the plausible`,
        `floor of ${MIN_NONZERO_MICROS_PER_MTOK} — it is almost certainly stated per`,
        "TOKEN rather than per million tokens, and a rate 10^6 too low silently",
        "disarms every downstream spend cap",
      ].join(" "),
    );
  }
  if (micros > MAX_MICROS_PER_MTOK) {
    throw new RateError(
      [
        `rate ${value} (${unit}) resolves to ${micros} µ$/MTok, above the plausible`,
        "ceiling — it is almost certainly stated in a different unit than declared",
      ].join(" "),
    );
  }
  return micros;
}

// ---------------------------------------------------------------------------
// Rate tables
// ---------------------------------------------------------------------------

function costOf(raw: unknown): CostEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const out: CostEntry = {};
  for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof c[k] === "number") out[k] = c[k] as number;
  }
  return out;
}

/**
 * Locate `@earendil-works/pi-ai/dist/providers/data` — pi's bundled catalog,
 * the only place the shipped `cost` blocks live (`pi --list-models` prints no
 * prices). `QDS_PI_CATALOG_DIR` overrides the search.
 */
export function findBundledCatalogDir(): string | null {
  const override = process.env.QDS_PI_CATALOG_DIR;
  if (override) return statSync(override, { throwIfNoEntry: false })?.isDirectory() ? override : null;
  const bin = Bun.which("pi");
  if (!bin) return null;
  let dir: string;
  try {
    dir = dirname(realpathSync(bin));
  } catch {
    return null;
  }
  const suffix = join("node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, suffix);
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read pi's bundled catalog into a `${provider}/${model}` → cost table. The
 * provider id is the file basename; each file is `{ [api]: { [id]: entry } }`.
 * An unreadable or unlocatable catalog is a CONTROL failure, not an empty
 * table — callers surface it as `unverified` / exit 2 (INV-4).
 */
export function loadBundledCatalog(dir?: string): RateTable {
  const root = dir ?? findBundledCatalogDir();
  if (root === null) {
    throw new RateError(
      "pi's bundled model catalog could not be located (set QDS_PI_CATALOG_DIR)",
    );
  }
  const entries = new Map<string, CostEntry>();
  for (const file of readdirSync(root)) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const provider = file.slice(0, -".json".length);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      continue; // one unreadable provider file must not blank the whole table
    }
    if (doc === null || typeof doc !== "object") continue;
    for (const byApi of Object.values(doc as Record<string, unknown>)) {
      if (byApi === null || typeof byApi !== "object") continue;
      for (const [id, entry] of Object.entries(byApi as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object") continue;
        const cost = costOf((entry as { cost?: unknown }).cost);
        if (cost !== null) entries.set(`${provider}/${id}`, cost);
      }
    }
  }
  return { unit: "usd-per-mtok", entries };
}

export function defaultCustomRegistryPath(): string {
  return process.env.QDS_PI_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
}

/**
 * Read `~/.pi/agent/models.json` into a rate table.
 *
 * AC5: a missing file is an EMPTY custom registry, not an error.
 * AC3/INV-3: an entry whose `cost` block omits any of `input`/`output`/
 * `cacheRead`/`cacheWrite` — or omits `cost` entirely — is REJECTED naming the
 * missing keys, and excluded from the table. pi drops the entire roster on a
 * partial block, and a wholly absent block defaults every rate to zero, so the
 * factory would report $0.0000 while genuinely spending.
 *
 * INV-1: only `id` and `cost` are read. `apiKey` is never touched.
 */
export function readCustomRegistry(path = defaultCustomRegistryPath()): CustomRegistry {
  const problems: string[] = [];
  // `unavailable` is a separate channel from `problems` because the two map to
  // different exit codes: a registry that is present but wrong is a rejection
  // (`1`), one that could not be READ is an unavailable control (`2`, INV-4).
  // Collapsing them would report EACCES to the operator as "your slugs are bad"
  // while every gate says `pass`.
  const unavailable: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // AC5: a missing file is an empty custom registry, not an error.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { table: EMPTY_TABLE, problems, unavailable };
    }
    unavailable.push(`${path}: cannot read: ${(e as Error).message}`);
    return { table: EMPTY_TABLE, problems, unavailable };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    problems.push(`${path}: invalid JSON: ${(e as Error).message}`);
    return { table: EMPTY_TABLE, problems, unavailable };
  }

  const providers = (doc as { providers?: unknown } | null)?.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    if (providers !== undefined) problems.push(`${path}: "providers" must be a mapping`);
    return { table: EMPTY_TABLE, problems, unavailable };
  }

  const REQUIRED = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const entries = new Map<string, CostEntry>();
  for (const [providerId, provider] of Object.entries(providers as Record<string, unknown>)) {
    const models = (provider as { models?: unknown } | null)?.models;
    // A provider block with NO `models` key is legitimate — it exists only to
    // override a base URL or credential, and prices nothing. A `models` key of
    // the wrong shape is not: silently skipping it would disable AC3 for every
    // entry under it, a fail-OPEN on the one control that keeps a zero-rate
    // roster from reporting $0.0000 on a spending run.
    if (models === undefined) continue;
    if (!Array.isArray(models)) {
      problems.push(`${path}: providers["${providerId}"].models must be a list`);
      continue;
    }
    for (const model of models) {
      const id = (model as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const slug = `${providerId}/${id}`;
      const cost = costOf((model as { cost?: unknown }).cost);
      if (cost === null) {
        problems.push(
          [
            `${path}: model "${slug}" has no cost block — pi then bills every rate`,
            "at zero and the factory reports $0.0000 while genuinely spending",
          ].join(" "),
        );
        continue;
      }
      const missing = REQUIRED.filter((k) => cost[k] === undefined);
      if (missing.length > 0) {
        problems.push(
          [
            `${path}: model "${slug}" cost block is missing ${missing.join(", ")} —`,
            "pi drops the ENTIRE roster on a partial cost block",
          ].join(" "),
        );
        continue;
      }
      entries.set(slug, cost);
    }
  }
  return { table: { unit: "usd-per-mtok", entries }, problems, unavailable };
}

let defaultSources: RateSources | null = null;

/**
 * Load both rate tables once per process (both are pure file reads).
 *
 * A registry problem THROWS here rather than being dropped. This is the path
 * `resolveRate(slug)` takes when a caller supplies no sources — DF3.6's
 * pre-flight and DF3.3's resident accounting — and handing those callers rates
 * from a registry whose broken entries were silently discarded is exactly the
 * fail-open INV-3 forbids. `validateRoster` does not come through here; it
 * reads the tables itself so it can REPORT the problems instead of throwing.
 */
export function loadRateSources(): RateSources {
  if (defaultSources === null) {
    const custom = readCustomRegistry();
    if (custom.problems.length + custom.unavailable.length > 0) {
      throw new RateError(
        `custom model registry is unusable:\n  - ${[...custom.unavailable, ...custom.problems].join("\n  - ")}`,
      );
    }
    defaultSources = { bundled: loadBundledCatalog(), custom: custom.table };
  }
  return defaultSources;
}

/**
 * Drop the memo. The tables are read once per process, which is right for a CLI
 * but wrong for DF3.3's long-lived resident: without this, an operator edit to
 * `~/.pi/agent/models.json` would never take effect in a running orchestrator.
 */
export function resetRateSources(): void {
  defaultSources = null;
}

/**
 * AC6. Resolve a slug's four rates as integer µ$/MTok.
 *
 * `~/.pi/agent/models.json` takes PRECEDENCE when both sources supply the slug
 * — an operator-maintained local override is authoritative over the catalog
 * shipped with pi — and it supplies its COMPLETE rate set. There is never a
 * per-field merge of the two sources.
 *
 * `inputPerMTok`/`outputPerMTok` never default. `cacheReadPerMTok`/
 * `cacheWritePerMTok` absent from a bundled-catalog entry resolve to `0`, which
 * is what the catalog means where it prices no cache. A slug neither source
 * prices is REJECTED naming the slug and both attempted sources — defaulting it
 * to zero would report $0.0000 on a spending run.
 */
export function resolveRate(slug: string, sources: RateSources = loadRateSources()): ResolvedRate {
  const attempted = "pi's bundled catalog and ~/.pi/agent/models.json";
  const custom = sources.custom.entries.get(slug);
  if (custom !== undefined) {
    // INV-3, the case a key-presence check alone misses. A COMPLETE but
    // zero-valued custom cost block is the obvious copy-paste template, and
    // because models.json wins WHOLESALE it silently prices the model at
    // nothing — reporting $0.0000 on a spending run through the ACCEPTED path,
    // at exit 0. Two rejections, both scoped to this slug so an unrelated
    // registry entry never fails somebody else's roster:
    //
    //  (a) input AND output both zero — unconditionally, even with no bundled
    //      counterpart. Restricting this to the overlap case would exempt the
    //      likeliest shape of all: a slug that exists ONLY in models.json,
    //      which is how the host's own custom model was registered.
    //  (b) ANY rate zeroed that the bundled catalog prices non-zero — prompt
    //      cache traffic is a large share of a factory's spend, so a zeroed
    //      cacheRead is the same failure at a smaller scale.
    //
    // Bundled-catalog zeroes are NOT rejected: those are the vendor's published
    // price for a genuinely free model. This asymmetry is the point — an
    // operator-authored zero is a likely mistake, a vendor-published one is not.
    if (custom.input === 0 && custom.output === 0) {
      throw new RateError(
        [
          `"${slug}" is priced at zero by ~/.pi/agent/models.json — refusing it,`,
          "since billing a model at nothing reports $0.0000 on a spending run.",
          "Set real input/output rates, or remove the entry so the bundled",
          "catalog's price is used.",
        ].join(" "),
      );
    }
    const bundledPrice = sources.bundled.entries.get(slug);
    const warnings: string[] = [];
    if (bundledPrice !== undefined) {
      // A half-zeroed override: input or output zeroed while the catalog prices
      // it is the same under-report as (a), just narrower. Hard.
      const zeroed = (["input", "output"] as const).filter(
        (k) => custom[k] === 0 && (bundledPrice[k] ?? 0) > 0,
      );
      if (zeroed.length > 0) {
        throw new RateError(
          [
            `"${slug}" is priced at zero by ~/.pi/agent/models.json for`,
            `${zeroed.join(", ")} but non-zero by pi's bundled catalog — refusing`,
            "the override, since billing those at zero under-reports a spending run.",
          ].join(" "),
        );
      }
      // The cache rates get a WARNING, not a rejection. AC3 requires all four
      // keys, so an operator overriding input/output on a provider that does
      // not bill for cache has no way to say so except `cacheRead: 0` — a hard
      // gate here would make a legitimate config inexpressible, with no escape
      // hatch (pi's own schema rejects a null). Under-reporting cache alone is
      // bounded and deliberate; billing the whole model at nothing is not.
      const zeroedCache = (["cacheRead", "cacheWrite"] as const).filter(
        (k) => custom[k] === 0 && (bundledPrice[k] ?? 0) > 0,
      );
      if (zeroedCache.length > 0) {
        warnings.push(
          [
            `"${slug}": ~/.pi/agent/models.json prices ${zeroedCache.join(", ")} at`,
            "zero where pi's bundled catalog does not — cache traffic will be",
            "reported as free. Remove the entry if that is not deliberate.",
          ].join(" "),
        );
      }
    }
    return {
      inputPerMTok: toMicrosPerMTok(custom.input, sources.custom.unit),
      outputPerMTok: toMicrosPerMTok(custom.output, sources.custom.unit),
      cacheReadPerMTok: toMicrosPerMTok(custom.cacheRead, sources.custom.unit),
      cacheWritePerMTok: toMicrosPerMTok(custom.cacheWrite, sources.custom.unit),
      source: "models.json",
      warnings,
    };
  }
  const bundled = sources.bundled.entries.get(slug);
  if (bundled === undefined || bundled.input === undefined || bundled.output === undefined) {
    throw new RateError(
      `no rate for "${slug}" in ${attempted} — refusing to default it to zero`,
    );
  }
  const unit = sources.bundled.unit;
  return {
    inputPerMTok: toMicrosPerMTok(bundled.input, unit),
    outputPerMTok: toMicrosPerMTok(bundled.output, unit),
    cacheReadPerMTok: toMicrosPerMTok(bundled.cacheRead ?? 0, unit),
    cacheWritePerMTok: toMicrosPerMTok(bundled.cacheWrite ?? 0, unit),
    source: "bundled",
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Gate 1 — pi's merged catalog
// ---------------------------------------------------------------------------

/**
 * pi is slow to start: it refreshes provider catalogs over the network, and
 * `--list-models` measured 32 s on an idle host against 12 s for `--version`.
 * The budget is deliberately several times that, because a timeout here is
 * `unverified` — a tight budget turns a merely BUSY host into exit 2 on every
 * run, which is a false alarm dressed as a safety property. Override with
 * `QDS_PI_TIMEOUT_MS`.
 */
function piTimeoutMs(): number {
  const raw = Number(process.env.QDS_PI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

/** pi version F13 pins. A different one warns; it is not a hard gate. */
export const PI_PINNED_VERSION_PREFIX = "0.55.";

/**
 * Run pi and capture stdout. A timeout is reported as `timedOut`, never as an
 * empty-but-successful read — a killed process yields no rows, which would
 * otherwise be indistinguishable from a genuinely empty catalog.
 */
export interface PiRun {
  code: number;
  stdout: string;
  timedOut: boolean;
  /** stdout outran the capture cap — the table is a prefix, so the catalog is
   * UNEVALUABLE (exit 2), never a partial model set. */
  truncated?: boolean;
}

/** Injection seam so the gate's own logic is testable without a pi install. */
export type PiRunner = (args: string[]) => Promise<PiRun>;

export async function runPi(args: string[]): Promise<PiRun> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, piTimeoutMs());
  try {
    const proc = Bun.spawn(["pi", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      // pi resolves provider credentials from the ambient env; nothing is added
      // here and nothing secret is placed in argv (INV-1).
      signal: controller.signal,
    });
    const { text: stdout, truncated } = await readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, {
      kill: () => {
        proc.kill(9);
      },
      exited: proc.exited,
      signal: controller.signal,
    });
    const code = await proc.exited;
    return { code, stdout, timedOut, ...(truncated ? { truncated: true } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR is the point
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** `provider  model  context  max-out  thinking  images` — six columns. */
const TABLE_COLUMNS = 6;

/**
 * Parse `pi --list-models`' fixed-width table into `${provider}/${model}` pairs.
 * A leading `~` marks an alias row; both the marked and unmarked forms are
 * recorded because either is spawnable.
 *
 * Parsing is ANCHORED on the header row and requires the full column count.
 * "any line with two whitespace-separated tokens" would swallow banner and
 * error lines as models, and — worse — would keep returning a non-empty set if
 * pi ever changed its gutter or emitted colour, so every real slug would be
 * missing and each role would be REJECTED (exit 1) instead of the run reporting
 * `unverified` (exit 2). Failing to find the header returns an empty set, which
 * the caller reads as an unevaluable gate.
 */
export function parsePiModelTable(stdout: string): Set<string> {
  const pairs = new Set<string>();
  let inTable = false;
  for (const raw of stdout.replace(ANSI, "").split("\n")) {
    const trimmed = raw.trim();
    const cols = trimmed.split(/\s{2,}/);
    if (!inTable) {
      inTable = cols.length === TABLE_COLUMNS && cols[0] === "provider" && cols[1] === "model";
      continue;
    }
    // The table ends at the first blank line. Anything after it is prose —
    // a totals line or a hint — and must not become a model pair.
    if (trimmed.length === 0) break;
    // Once anchored, two columns is enough. Demanding the full width drops any
    // row with a blank interior cell (a blank `thinking` cell collapses into
    // the surrounding gutter), which would leave the gate `ok` while a live
    // slug went missing — rejecting that role at exit 1 instead of reporting
    // the gate unevaluable at exit 2. The header anchor, not the column count,
    // is what keeps banner and error lines out.
    if (cols.length < 2 || cols.length > TABLE_COLUMNS) continue;
    const provider = cols[0]!;
    const model = cols[1]!;
    if (provider.length === 0 || model.length === 0) continue;
    if (/\s/.test(provider) || /\s/.test(model)) continue;
    pairs.add(`${provider}/${model}`);
    if (model.startsWith("~")) pairs.add(`${provider}/${model.slice(1)}`);
  }
  return pairs;
}

/**
 * Gate 1. `pi --list-models` EXITS 0 while printing `No models available`
 * (R4 §3.4 assertion B), so the exit code alone is never the signal — a run
 * that parses to zero rows is `unverified`, never an empty-catalog pass.
 */
export async function probePiCatalog(run: PiRunner = runPi): Promise<CatalogProbe> {
  const started = Bun.nanoseconds();
  const ms = () => Math.round((Bun.nanoseconds() - started) / 1e6);
  let warnings: string[] = [];
  // `warnings` is captured by reference so a version-drift advisory survives a
  // later gate failure — it is the diagnostic that explains the exit 2.
  const fail = (reason: string): CatalogProbe => ({
    ok: false,
    pairs: new Set(),
    reason,
    warnings,
    durationMs: 0, // an unevaluated gate reports duration 0
  });

  let version: PiRun;
  try {
    version = await run(["--version"]);
  } catch (e) {
    return fail(`pi binary unavailable: ${(e as Error).message}`);
  }
  if (version.timedOut) return fail(`pi --version timed out after ${piTimeoutMs()}ms`);
  const parsed = version.stdout.trim().match(/^\d+\.\d+\.\d+/);
  if (version.code !== 0 || parsed === null) {
    return fail("pi --version did not report a parseable version");
  }
  // F13 pins pi to 0.55.x. This host runs a later line, and hard-failing on the
  // pinned prefix would brick the validator on every currently-installed pi —
  // exactly the stale-pin failure mode this story exists to catch. The version
  // must PARSE (a missing or broken binary is still `unverified`); a drift off
  // the pin is surfaced as a warning row, not a gate failure.
  warnings = parsed[0].startsWith(PI_PINNED_VERSION_PREFIX)
    ? []
    : [`pi ${parsed[0]} is not the F13-pinned ${PI_PINNED_VERSION_PREFIX}x line`];

  let listed: PiRun;
  try {
    listed = await run(["--list-models"]);
  } catch (e) {
    return fail(`pi --list-models failed: ${(e as Error).message}`);
  }
  if (listed.timedOut) return fail(`pi --list-models timed out after ${piTimeoutMs()}ms`);
  // A prefix of the table is not the table: parsing it would drop real slugs
  // and REJECT their roles (exit 1) instead of reporting the gate unevaluable.
  if (listed.truncated) return fail("pi --list-models output exceeded the capture cap");
  // `pi --list-models` EXITS 0 while printing `No models available`, so the exit
  // code alone is never the signal.
  if (listed.stdout.includes("No models available")) {
    return fail("pi --list-models printed 'No models available'");
  }
  const pairs = parsePiModelTable(listed.stdout);
  if (pairs.size === 0) {
    return fail("pi --list-models returned no model rows");
  }
  return { ok: true, pairs, durationMs: ms(), warnings };
}

// ---------------------------------------------------------------------------
// Gate 2 — the provider's live model list
// ---------------------------------------------------------------------------

const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Providers with a public, unauthenticated model list. Scope is deliberately
 * one entry: OpenRouter is the working provider path on this host (Anthropic
 * OAuth expired ~2026-02-25, R5 §6 fact 4), and a public endpoint means this
 * story reads no credential at all (INV-1). Any other provider is `unverified`
 * — fail-closed, exit 2 — never a pass by omission.
 */
const PROVIDER_MODEL_LIST_URLS: Readonly<Record<string, string>> = {
  openrouter: "https://openrouter.ai/api/v1/models",
};

/**
 * Gate 2. 10 s budget, ONE retry on a network error (not on a non-200 — a
 * server that answered has given its answer). Non-200 or an empty `.data[]`
 * yields `unverified` for every slug (AC4).
 */
/** Injection seam so the gate's own logic is testable without the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function probeProviderModels(
  provider: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderProbe> {
  const started = Bun.nanoseconds();
  const url = PROVIDER_MODEL_LIST_URLS[provider];
  if (url === undefined) {
    return {
      ok: false,
      ids: new Set(),
      reason: `no live model list is configured for provider "${provider}"`,
      durationMs: 0,
    };
  }

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (e) {
      lastError = `network error: ${(e as Error).message}`;
      continue; // the one retry
    }
    if (!res.ok) {
      return {
        ok: false,
        ids: new Set(),
        reason: `${url} answered ${res.status}`,
        durationMs: 0,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return {
        ok: false,
        ids: new Set(),
        reason: `${url} returned unparseable JSON: ${(e as Error).message}`,
        durationMs: 0,
      };
    }
    const data = (body as { data?: unknown } | null)?.data;
    const ids = new Set<string>();
    if (Array.isArray(data)) {
      for (const m of data) {
        const id = (m as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
    }
    if (ids.size === 0) {
      return { ok: false, ids, reason: `${url} returned an empty model list`, durationMs: 0 };
    }
    return { ok: true, ids, durationMs: Math.round((Bun.nanoseconds() - started) / 1e6) };
  }
  return { ok: false, ids: new Set(), reason: lastError, durationMs: 0 };
}

// ---------------------------------------------------------------------------
// validateRoster
// ---------------------------------------------------------------------------

function catalogVerdict(
  role: ResolvedRole,
  probe: CatalogProbe,
  problems: string[],
): GateVerdict {
  if (!probe.ok) {
    problems.push(`pi-catalog gate unverified: ${probe.reason ?? "gate could not be evaluated"}`);
    return "unverified";
  }
  if (probe.pairs.has(role.slug)) return "pass";

  // The contradiction check the schema deliberately defers: offline, a model
  // prefix and a provider id are indistinguishable (`openrouter` +
  // `deepseek/deepseek-v4-flash-0731` is correct, and `deepseek` is also a pi
  // provider). Here the real pairs are known, so a declared pair that is absent
  // while its split reading IS present names both readings rather than letting
  // either win silently.
  const slash = role.model.indexOf("/");
  if (slash > 0) {
    const split = `${role.model.slice(0, slash)}/${role.model.slice(slash + 1)}`;
    if (probe.pairs.has(split)) {
      problems.push(
        [
          `pi-catalog gate rejected "${role.slug}": provider "${role.provider}" does`,
          `not list model "${role.model}", but "${split}" exists — the model prefix`,
          "contradicts the declared provider; fix one of the two",
        ].join(" "),
      );
      return "fail";
    }
  }
  problems.push(`pi-catalog gate rejected "${role.slug}": not in pi's merged catalog`);
  return "fail";
}

function providerVerdict(
  role: ResolvedRole,
  probe: ProviderProbe,
  problems: string[],
): GateVerdict {
  if (!probe.ok) {
    problems.push(
      `provider-API gate unverified: ${probe.reason ?? "gate could not be evaluated"}`,
    );
    return "unverified";
  }
  if (probe.ids.has(role.model)) return "pass";
  problems.push(
    `provider-API gate rejected "${role.slug}": provider "${role.provider}" does not ` +
      `list model "${role.model}"`,
  );
  return "fail";
}

/**
 * Run both gates over every role and resolve each surviving role's rate.
 *
 * Collect-all: every problem across every role is gathered and reported in one
 * pass — the operator fixes the roster once, not once per run.
 */
export async function validateRoster(
  roster: ResolvedRoster,
  deps: ValidateDeps = {},
): Promise<RosterReport> {
  const requestId = deps.requestId ?? crypto.randomUUID();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const probeCatalog = deps.probeCatalog ?? probePiCatalog;
  const probeProvider = deps.probeProvider ?? probeProviderModels;

  const problems: string[] = [...(deps.registryProblems ?? [])];

  // Rate tables are local file reads. An unlocatable bundled catalog or an
  // unreadable custom registry is an unavailable CONTROL (INV-4) — roster-wide
  // `unverified`, exit 2 — not a slug rejection.
  let sources: RateSources | null = deps.rateSources ?? null;
  const unverified: string[] = [...(deps.registryUnavailable ?? [])];
  if (sources === null) {
    const custom = readCustomRegistry();
    problems.push(...custom.problems);
    unverified.push(...custom.unavailable);
    try {
      // An UNREADABLE registry must not fall through to the bundled catalog.
      // `models.json` is authoritative under AC6, so resolving from the loser
      // table would record a definite `source: bundled` rate for a slug whose
      // authoritative price was never read — a correct-looking record built on
      // a control that failed. No rate at all is the honest answer.
      if (custom.unavailable.length === 0) {
        sources = { bundled: loadBundledCatalog(), custom: custom.table };
      }
    } catch (e) {
      unverified.push((e as Error).message);
    }
  }
  const sourcesUnverified = unverified.length > 0 ? unverified.join("; ") : null;

  // Gate 1 runs ONCE per validation run and is memoized, mirroring pi's own
  // lru_cache(1) upstream.
  const catalog = await probeCatalog();

  // Gate 2 is memoized per provider so an N-role roster on one provider makes
  // one request.
  const providerProbes = new Map<string, ProviderProbe>();
  for (const role of roster.roles) {
    if (!providerProbes.has(role.provider)) {
      providerProbes.set(role.provider, await probeProvider(role.provider));
    }
  }
  const providerProbeMs = Math.max(
    0,
    ...[...providerProbes.values()].map((p) => p.durationMs),
  );

  const roles: RoleRecord[] = [];
  for (const role of roster.roles) {
    const roleStarted = now();
    const roleProblems: string[] = [];
    const piCatalog = catalogVerdict(role, catalog, roleProblems);
    const providerApi = providerVerdict(
      role,
      providerProbes.get(role.provider)!,
      roleProblems,
    );

    // A role already rejected by a gate is not priced: the slug is not
    // spawnable, so an "unpriced" line would only bury the real verdict.
    let rate: ResolvedRate | null = null;
    if (piCatalog !== "fail" && providerApi !== "fail") {
      if (sources === null) {
        roleProblems.push(`rate unverified: ${sourcesUnverified}`);
      } else {
        try {
          rate = resolveRate(role.slug, sources);
        } catch (e) {
          roleProblems.push((e as Error).message);
        }
      }
    }

    roles.push({
      requestId,
      role: role.name,
      slug: role.slug,
      provider: role.provider,
      piCatalog,
      providerApi,
      source: rate?.source ?? null,
      rate,
      durationMs: Math.max(0, now() - roleStarted),
      problems: roleProblems,
      warnings: [...role.warnings, ...(rate?.warnings ?? [])],
    });
  }

  if (sourcesUnverified !== null) problems.push(`rate tables unverified: ${sourcesUnverified}`);

  // `2` dominates `1`: an unevaluated gate is not a complete verdict, and the
  // report still lists every rejection.
  const anyUnverified =
    sourcesUnverified !== null ||
    roles.some((r) => r.piCatalog === "unverified" || r.providerApi === "unverified");
  const anyRejected = problems.length > 0 || roles.some((r) => r.problems.length > 0);
  const exitCode: 0 | 1 | 2 = anyUnverified ? 2 : anyRejected ? 1 : 0;

  return {
    requestId,
    roles,
    problems,
    warnings: [
      ...roster.warnings,
      ...(catalog.warnings ?? []),
      ...roles.flatMap((r) => r.rate?.warnings ?? []),
    ],
    exitCode,
    catalogProbeMs: catalog.durationMs,
    providerProbeMs,
    durationMs: Math.max(0, now() - startedAt),
  };
}
