/**
 * DF1.5 — per-role roster config: parse, closed-schema validate, shallow
 * `defaults` merge, and `(provider, model)` slug resolution.
 *
 * Owns the CONFIG half of DF1.5. `validate.ts` owns the dual slug gates and
 * rate resolution. Nothing here touches the network or spawns a process:
 * INV-2 requires the roster to be schema-parsed BEFORE any probe fires, so a
 * malformed roster short-circuits without a single outbound call.
 *
 * Semantics follow R4 §1.5 (SSSF's `MOD/agents.py:33-41`) ported to TS per
 * decision D6:
 *  - the merge is a shallow `setdefault`: a per-role value always wins, and a
 *    per-role list REPLACES the defaults list rather than extending it. There
 *    is no deep merge and no list concatenation anywhere.
 *  - the key set is CLOSED at every level. An unknown key is an error, never
 *    an ignored key — a typo'd `temprature` must not silently mean "default".
 *
 * Deliberate narrowings, recorded because they deviate from a literal reading
 * of the story text:
 *  - `defaults` does NOT accept `name`. A roster-wide role name is incoherent
 *    and would guarantee a duplicate-name error on every multi-role roster.
 *  - `writes` must be declared explicitly (in `defaults` or per role). The
 *    story defines `null` as "unrestricted repo writes"; inferring that from
 *    silence is the one default here with a blast radius, so it is fail-closed.
 *  - `thinking` defaults to `off`, `tools` to `null`, `harness_engineering` to
 *    `[]` when neither layer supplies them. None of the three can widen write
 *    scope, and `off` is the cheapest thinking level.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Thinking levels pi 0.55.0 actually accepts. `max` appears in SSSF's own type
 * (R4 §1.5) but is absent from pi 0.55.0's `--help` (R4 §4.3), so the schema
 * rejects it here rather than shipping a roster that dies at spawn time.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Roster file size ceiling (Technical Notes: guards/limits). */
export const ROSTER_MAX_BYTES = 256 * 1024;

export interface ResolvedRole {
  /** Role key, unique within the roster. */
  name: string;
  /** Model id VERBATIM — it may itself contain `/`. */
  model: string;
  /** Authoritative provider id. */
  provider: string;
  thinking: ThinkingLevel;
  /** Tool allowlist; `null` = every tool usable. */
  tools: string[] | null;
  /** Repo write scope; `null` = unrestricted, `[]` = no repo writes. */
  writes: string[] | null;
  /** `-e` extension paths handed to pi. */
  harness_engineering: string[];
  /** Optional self-compact thresholds, e.g. `{ soft_at: "30%", at: "50%", buffer: "10%" }`. */
  compaction?: { soft_at: string; at: string; buffer: string };
  /** `${provider}/${model}` — the key both gates and `resolveRate` look up. */
  slug: string;
  /** Non-fatal advisories for this role. */
  warnings: string[];
}

export interface ResolvedRoster {
  /** Absolute path the roster was read from, or `"<inline>"` for `parseRoster`. */
  path: string;
  roles: ResolvedRole[];
  /** Every role warning, flattened, in role order. */
  warnings: string[];
}

export interface LoadRosterOptions {
  /** Confinement root for the roster path (INV-2). Defaults to the repo root. */
  repoRoot?: string;
  /** Base a relative roster path resolves against. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Every roster problem, raised once (Technical Notes: fail-fast, collect-all).
 *
 * `code` separates the two failure kinds because they map to different exit
 * codes: a roster that is present but wrong is a rejection (`1`), while a
 * roster that could not be READ is an unavailable control (`2`, INV-4) — a
 * typo'd `--roster` path must not read as "your slugs are bad".
 */
export class RosterError extends Error {
  readonly code: "roster_invalid" | "roster_unreadable";
  readonly problems: readonly string[];

  constructor(
    problems: readonly string[],
    path: string,
    code: "roster_invalid" | "roster_unreadable" = "roster_invalid",
  ) {
    const headline = code === "roster_unreadable" ? "could not be read" : "is invalid";
    super(`roster ${path} ${headline}:\n  - ${problems.join("\n  - ")}`);
    this.name = "RosterError";
    this.code = code;
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Zod shape (closed at every level)
// ---------------------------------------------------------------------------

const ToolsField = z.array(z.string().min(1)).nullable();
const WritesField = z.array(z.string().min(1)).nullable();

/**
 * A percent string like "30%" or "12.5%". The failure message echoes the
 * offending VALUE, not just "Invalid" — the CLI surfaces these problems to the
 * operator, who needs to see which of their numbers was wrong. (`superRefine`,
 * not `.regex(msg)`: this zod build ignores a params-level `errorMap` for
 * `.regex`, and a static `message` cannot include the value.)
 */
const PercentField = z.string().superRefine((v, ctx) => {
  if (!/^\d+(\.\d+)?%$/.test(v)) {
    ctx.addIssue({
      code: "custom",
      message: `must be a percent like "30%" (got ${JSON.stringify(v)})`,
    });
  }
});

/**
 * Every key is optional at parse time because `defaults` may supply it. What
 * is REQUIRED is checked after the merge, so the error names the role rather
 * than the layer.
 */
const RoleShape = {
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  tools: ToolsField.optional(),
  writes: WritesField.optional(),
  harness_engineering: z.array(z.string().min(1)).optional(),
  compaction: z
    .object({
      soft_at: PercentField,
      at: PercentField,
      buffer: PercentField,
    })
    .optional(),
} as const;

const RoleSchema = z.object({ name: z.string().min(1), ...RoleShape }).strict();
const DefaultsSchema = z.object(RoleShape).strict();
const RosterFileSchema = z
  .object({ defaults: z.unknown().optional(), roles: z.unknown() })
  .strict();

type RoleLayer = z.infer<typeof RoleSchema>;
type DefaultsLayer = z.infer<typeof DefaultsSchema>;

function issues(prefix: string, err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.length > 0 ? `${prefix}.${i.path.join(".")}` : prefix;
    return `${path}: ${i.message}`;
  });
}

// ---------------------------------------------------------------------------
// Merge + slug resolution
// ---------------------------------------------------------------------------

/**
 * Shallow `setdefault`: `role` wins whenever it declared the key at all. An
 * explicit `null` counts as declared, so `tools: null` beats a defaults list.
 * Lists are copied so a merged role never aliases the defaults array.
 */
function pick<K extends keyof DefaultsLayer>(
  role: RoleLayer,
  defaults: DefaultsLayer,
  key: K,
): DefaultsLayer[K] {
  const v = key in role ? (role as DefaultsLayer)[key] : defaults[key];
  return (Array.isArray(v) ? [...v] : v) as DefaultsLayer[K];
}

/**
 * Resolve a role to a concrete `(provider, model)` pair.
 *
 * `provider` is authoritative: when it is set the pair is `(provider, model)`
 * VERBATIM, and an embedded `/` in the model id is not a split point. Only when
 * `provider` is absent is `model` split on its FIRST `/`.
 *
 * Deliberately NOT done here: deciding that a model prefix "contradicts" an
 * explicit `provider` by matching it against pi's provider-id list. On a
 * gateway every real slug looks like that — pi ships provider files for
 * `anthropic` and `deepseek`, yet `openrouter/anthropic/claude-haiku-4.5` and
 * the story's own `openrouter` + `deepseek/deepseek-v4-flash-0731` are both
 * correct. A prefix and a provider id are indistinguishable offline, so the
 * contradiction is caught where the answer is actually knowable — the catalog
 * gate in `validate.ts`, which holds the real `(provider, model)` pairs and
 * names both readings when the declared pair is absent but the split one
 * exists. It is surfaced as a validation error there, never a silent winner.
 */
function resolveSlug(
  name: string,
  model: string,
  provider: string | undefined,
  problems: string[],
): { provider: string; model: string } | null {
  if (provider !== undefined) return { provider, model };

  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    problems.push(
      `roles[${name}].model "${model}" has no provider prefix and no provider: key`,
    );
    return null;
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse + validate + merge roster YAML held in memory. */
export function parseRoster(text: string, path = "<inline>"): ResolvedRoster {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    // Only the first line of the parser's message is kept. `yaml` appends the
    // OFFENDING SOURCE LINE to its message, and this string is written to
    // stdout by the CLI — echoing file content back out is exactly the leak
    // INV-1/INV-2 forbid, and it would turn a mis-pointed roster path into a
    // file-read primitive.
    const raw = e instanceof Error ? e.message : "";
    const first = raw.split("\n", 1)[0] || "malformed YAML";
    throw new RosterError([`YAML parse failed: ${first}`], path);
  }

  const problems: string[] = [];
  const top = RosterFileSchema.safeParse(doc);
  if (!top.success) {
    // Unknown/mistyped top-level keys are collected, not thrown, so a stray
    // `version:` does not hide every problem below it. The raw document is
    // still usable when it is at least a mapping.
    problems.push(...issues("roster", top.error));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new RosterError(problems, path);
    }
  }
  const raw = doc as { defaults?: unknown; roles?: unknown };

  let defaults: DefaultsLayer = {};
  if (raw.defaults !== undefined && raw.defaults !== null) {
    const parsed = DefaultsSchema.safeParse(raw.defaults);
    if (parsed.success) defaults = parsed.data;
    else problems.push(...issues("defaults", parsed.error));
  }

  const rawRoles = raw.roles;
  if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
    problems.push("roles: must be a non-empty list");
    throw new RosterError(problems, path);
  }

  const roles: ResolvedRole[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawRoles.length; i++) {
    // Claim the name from the RAW entry first: name uniqueness must be reported
    // even for a role that also fails schema validation, otherwise one typo'd
    // key hides the duplicate underneath it.
    const rawName = (rawRoles[i] as { name?: unknown } | null)?.name;
    const label = typeof rawName === "string" && rawName.length > 0 ? rawName : `#${i}`;
    const duplicate = seen.has(label);
    if (duplicate) problems.push(`roles[${i}]: duplicate role name "${label}"`);
    seen.add(label);

    // A duplicate is still schema-checked, so its OWN problems are reported in
    // the same pass rather than surfacing only after the name is fixed.
    const parsed = RoleSchema.safeParse(rawRoles[i]);
    if (!parsed.success) {
      problems.push(...issues(`roles[${i}]`, parsed.error));
      continue;
    }
    if (duplicate) continue;
    const role = parsed.data;

    const model = pick(role, defaults, "model");
    const provider = pick(role, defaults, "provider");
    const writes = pick(role, defaults, "writes");
    if (model === undefined) {
      problems.push(`roles[${label}]: model is required (set it here or in defaults)`);
      continue;
    }
    if (writes === undefined) {
      problems.push(
        [
          `roles[${label}]: writes is required — declare [] for no repo writes`,
          "or null for unrestricted (set it here or in defaults)",
        ].join(" "),
      );
      continue;
    }
    const pair = resolveSlug(label, model, provider, problems);
    if (pair === null) continue;

    const tools = pick(role, defaults, "tools") ?? null;
    const harness = pick(role, defaults, "harness_engineering") ?? [];
    const compaction = pick(role, defaults, "compaction");
    const warnings: string[] = [];
    if (harness.length > 0 && tools !== null) {
      // `--tools` filters extension tools too (R4 §1.5, sssf.config.yaml:9-11):
      // a tool an extension registers is silently dropped unless the role's own
      // allowlist names it.
      warnings.push(
        [
          `roles[${label}]: harness_engineering extensions are loaded but tools is a`,
          "non-null allowlist — any tool an extension registers is silently filtered",
          "out unless named in tools",
        ].join(" "),
      );
    }

    roles.push({
      name: label,
      model: pair.model,
      provider: pair.provider,
      thinking: pick(role, defaults, "thinking") ?? "off",
      tools,
      writes,
      harness_engineering: harness,
      ...(compaction !== undefined ? { compaction } : {}),
      slug: `${pair.provider}/${pair.model}`,
      warnings,
    });
  }

  if (problems.length > 0) throw new RosterError(problems, path);
  return { path, roles, warnings: roles.flatMap((r) => r.warnings) };
}

/** Repo root = two levels above `src/phase-engine/roster/`. */
function defaultRepoRoot(): string {
  return resolve(import.meta.dir, "..", "..", "..");
}

/**
 * Read + parse a roster from disk. The path is resolved, DEREFERENCED, and
 * confined to the repo root BEFORE the read (INV-2), and the file is size-capped
 * before it is handed to the YAML parser.
 *
 * The confinement check runs on the REAL path. Comparing the lexical path alone
 * lets a symlink living inside `config/rosters/` point anywhere on the host and
 * be read — and since a parse failure surfaces to stdout, that would be a file
 * read primitive, not merely a confinement bug.
 */
export function loadRoster(rosterPath: string, opts: LoadRosterOptions = {}): ResolvedRoster {
  const lexicalRoot = resolve(opts.repoRoot ?? defaultRepoRoot());
  // A relative path resolves against the CWD — the operator typed it into a
  // shell, so `--roster ./x.yaml` must mean the `./x.yaml` they can see, not a
  // different file that happens to sit at the repo root. Confinement then
  // applies to whatever that resolves to.
  const base = resolve(opts.cwd ?? process.cwd());
  const lexical = isAbsolute(rosterPath) ? resolve(rosterPath) : resolve(base, rosterPath);

  let root: string;
  try {
    root = realpathSync(lexicalRoot);
  } catch (e) {
    throw new RosterError(
      [`repo root is not readable: ${(e as Error).message}`],
      lexicalRoot,
      "roster_unreadable",
    );
  }

  let abs: string;
  let size: number;
  try {
    // realpath first: it also fails closed on a missing file, a dangling
    // symlink, and a directory component that is not traversable.
    abs = realpathSync(lexical);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error("not a regular file");
    size = st.size;
  } catch (e) {
    throw new RosterError(
      [`cannot read roster: ${(e as Error).message}`],
      lexical,
      "roster_unreadable",
    );
  }

  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RosterError([`roster path is outside the repo root: ${abs}`], abs);
  }

  if (size > ROSTER_MAX_BYTES) {
    throw new RosterError(
      [`roster is ${size} bytes, over the ${ROSTER_MAX_BYTES}-byte (256 KiB) ceiling`],
      abs,
    );
  }

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    throw new RosterError(
      [`cannot read roster: ${(e as Error).message}`],
      abs,
      "roster_unreadable",
    );
  }
  return parseRoster(text, abs);
}
