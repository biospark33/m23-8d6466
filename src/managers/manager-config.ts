/**
 * The manager config of record (A1) — one factory Home, the operator as its
 * user owner, and exactly three department-manager bot profiles (Dev, QA,
 * Maintenance), each with a spend ceiling (AC4).
 *
 * Two layers, one file:
 * - the zod schema is the SHAPE contract: `.strict()` so an unknown key —
 *   including a secret-bearing one (INV-MGR-3) — is a validation error, never
 *   a silently dropped field. Same convention as `scripts/corpus/schema.ts`.
 * - `validateManagerConfig` is the POLICY gate: every refusal below is a named
 *   `ManagerConfigError` with a `code` and a `remediation` (the FleetError
 *   contract, minus the exit code — this module is a library, not a CLI).
 *
 * The owner seam admits `{kind:'user'|'org'}` per ADR-RUN-2 D1; org is
 * REFUSED by policy here until the company-bot feature ships (AC1) — the
 * upgrade is a new decision through the normal review flow, never a config
 * flip. Bot ids are `bot-`-prefixed and immutable once provisioned (D1);
 * `default` is Hermes's reserved root alias and can never be a manager bot.
 *
 * This module imports nothing from `src/fleet/` — the config of record sits
 * upstream of every fleet read the composer performs (AC2's allowlist starts
 * empty for it). No token values, provider keys, or approval authority live
 * here or in the shape it accepts (INV-MGR-2/3/4).
 */

import { z } from "zod";

/** The refusal vocabulary — one code per named refusal, never reused. */
export type ManagerConfigErrorCode =
  | "schema-invalid"
  | "home-count"
  | "org-owner-refused"
  | "bot-count"
  | "bot-department"
  | "reserved-default-alias"
  | "bot-id-prefix"
  | "bot-id-duplicate"
  | "spend-ceiling-required"
  | "spend-ceiling-positive"
  | "gateway-url-invalid";

/**
 * A refusal of the config of record. `code` is the stable name callers
 * switch on; `remediation` names the fix. FleetError-style (no exit code —
 * not a CLI surface).
 */
export class ManagerConfigError extends Error {
  constructor(
    public readonly code: ManagerConfigErrorCode,
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
    this.name = "ManagerConfigError";
  }
}

/** Zod issues as `field.path: message` lines — the named-field error contract. */
export function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/**
 * True when `s` parses as a credential-free http(s) URL — the only form a
 * verbatim pin may take (the seam compares it verbatim, so it must never
 * carry a secret: INV-MGR-3 adjacency).
 */
function isHttpUrl(s: string): boolean {
  // A verbatim pin: leading/trailing whitespace would be stripped by the URL
  // parser but compared verbatim downstream, and a query or fragment could
  // carry a secret — both are refusals, never normalizations.
  if (s.trim() !== s) return false;
  try {
    const url = new URL(s);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** The three manager departments — exactly one bot each (AC1). */
export const DEPARTMENTS = ["dev", "qa", "maintenance"] as const;
export type Department = (typeof DEPARTMENTS)[number];

/**
 * The DD-20 workKey namespace: `w:` + a remainder with at least one
 * non-whitespace character and no control characters (U+0000–U+001F, U+007F).
 * First precedent in the repo (`src/kpi/join.ts` only pins min(1)) — the
 * composer consumes this validator so per-run lines can never carry an
 * un-namespaced key (AC5).
 */
export const WorkKeySchema = z
  .string()
  .refine(
    (s) =>
      /^w:\s*\S/.test(s) &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in a DD-20 workKey is the point of this class
      !/[\u0000-\u001F\u007F]/.test(s),
    "must be `w:`-prefixed with a remainder containing at least one non-whitespace character and no control characters (DD-20 workKey namespace)",
  );
export type WorkKey = z.infer<typeof WorkKeySchema>;

/**
 * The ADR-RUN-2 D1 owner seam AS WRITTEN (`kind:'user'|'org'`). `org` parses
 * here and is refused by policy in `validateManagerConfig` — the seam admits
 * the shape, the story refuses it until the company-bot feature ships.
 */
const OwnerSchema = z
  .object({
    kind: z.enum(["user", "org"]),
    id: z.string().min(1),
  })
  .strict();
export type OwnerPrincipal = z.infer<typeof OwnerSchema>;

const HomeSchema = z
  .object({
    owner: OwnerSchema,
    /** The pinned gateway base URL (ADR-RUN-2 D4) — the seam compares it verbatim; policy requires an http(s) URL. */
    gatewayBaseUrl: z.string().min(1),
  })
  .strict();

const BotSchema = z
  .object({
    /** `bot-`-prefixed and immutable once provisioned (ADR-RUN-2 D1). */
    id: z.string().min(1),
    department: z.enum(DEPARTMENTS),
    /** USD ceiling at the gateway (E08 enforces; the factory declares). Optional HERE only so absence hits the named refusal, not a shape error. */
    spendCeilingUsd: z.number().optional(),
  })
  .strict();

export const ManagerConfigSchema = z
  .object({
    /** Exactly ONE factory Home of record — a second entry is a duplicate (AC1). */
    homes: z.array(HomeSchema),
    /** Exactly three bot profiles, one per department (AC1). */
    bots: z.array(BotSchema),
  })
  .strict();

// ===== validated types (what `validateManagerConfig` returns) =====

/** The owner of record after the org refusal: operator-as-user only. */
export type HomeConfig = {
  owner: { kind: "user"; id: string };
  gatewayBaseUrl: string;
};

export type BotConfig = {
  /** The prefix is proven by the policy check, so the type carries it — a non-`bot-` id cannot be a manager bot. */
  id: `bot-${string}`;
  department: Department;
  /** Present and positive after validation — never silently unlimited (AC4). */
  spendCeilingUsd: number;
};

/** Exactly one Home and exactly three bots, encoded in the types themselves. */
export type ManagerConfig = {
  homes: [HomeConfig];
  bots: [BotConfig, BotConfig, BotConfig];
};

// ===== end validated types =====

/**
 * Validate the config of record: shape via the strict schema, then every
 * policy rule in a fixed order, each refusal named. Returns the validated
 * config with counts and the owner kind pinned at the type level.
 */
export function validateManagerConfig(input: unknown): ManagerConfig {
  let parsed: z.infer<typeof ManagerConfigSchema>;
  try {
    parsed = ManagerConfigSchema.parse(input);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ManagerConfigError(
        "schema-invalid",
        zodErrors(e).join("; "),
        "fix the shape errors — unknown keys are validation errors (.strict()), never dropped",
      );
    }
    throw e;
  }

  if (parsed.homes.length !== 1) {
    throw new ManagerConfigError(
      "home-count",
      parsed.homes.length === 0
        ? "no factory Home declared — the config of record is empty"
        : `${parsed.homes.length} factory Homes declared — a second Home entry duplicates the Home of record`,
      "declare exactly ONE factory Home (ADR-RUN-2 D1: one Home per principal)",
    );
  }

  for (const home of parsed.homes) {
    if (home.owner.kind !== "user") {
      throw new ManagerConfigError(
        "org-owner-refused",
        `factory Home owner kind '${home.owner.kind}' is refused by policy (ADR-RUN-2 D1) until the company-bot feature ships`,
        "declare the owner as {kind:'user', id:<operator principal>}; org-owner returns via the company-bot feature upgrade — a new decision through the normal review flow, never a config flip",
      );
    }
    if (!isHttpUrl(home.gatewayBaseUrl)) {
      throw new ManagerConfigError(
        "gateway-url-invalid",
        `gatewayBaseUrl '${home.gatewayBaseUrl}' is not a credential-free http(s) URL — the pinned gateway must be a bare URL (ADR-RUN-2 D4)`,
        "set gatewayBaseUrl to a bare http(s) base URL with no username or password (strip credentials — the seam compares the pin verbatim, so it must never carry a secret), e.g. https://gateway.internal",
      );
    }
  }

  if (parsed.bots.length !== 3) {
    throw new ManagerConfigError(
      "bot-count",
      `${parsed.bots.length} bot profiles declared — the factory Home carries exactly three (the Dev, QA, and Maintenance managers)`,
      "declare exactly three bot profiles, one per department: dev, qa, maintenance",
    );
  }

  const seenIds = new Set<string>();
  const seenDepartments = new Set<Department>();
  for (const bot of parsed.bots) {
    if (bot.id === "default") {
      throw new ManagerConfigError(
        "reserved-default-alias",
        `bot id '${bot.id}' is Hermes's reserved root alias`,
        "profile ids are `bot-`-prefixed (ADR-RUN-2 D1); the `default` profile is Hermes's own and cannot be a manager bot",
      );
    }
    if (!/^bot-.+$/.test(bot.id)) {
      throw new ManagerConfigError(
        "bot-id-prefix",
        `bot id '${bot.id}' is not \`bot-\`-prefixed — profile names derive from the immutable bot id (ADR-RUN-2 D1)`,
        "rename the profile to `bot-<name>` in the config before first provisioning; ids are immutable once provisioned",
      );
    }
    if (seenIds.has(bot.id)) {
      throw new ManagerConfigError(
        "bot-id-duplicate",
        `bot id '${bot.id}' is declared twice`,
        "one immutable id per bot — give each profile its own `bot-`-prefixed id",
      );
    }
    seenIds.add(bot.id);
    if (seenDepartments.has(bot.department)) {
      throw new ManagerConfigError(
        "bot-department",
        `department '${bot.department}' has more than one bot — the three managers are one per department`,
        "map exactly one bot to each of: dev, qa, maintenance",
      );
    }
    seenDepartments.add(bot.department);
    if (bot.spendCeilingUsd === undefined) {
      throw new ManagerConfigError(
        "spend-ceiling-required",
        `bot '${bot.id}' carries no spendCeilingUsd — config without a ceiling refuses provisioning (AC4)`,
        "set a positive spendCeilingUsd (USD, enforced by the E08 gateway budget); there is no unlimited default",
      );
    }
    if (!Number.isFinite(bot.spendCeilingUsd) || !(bot.spendCeilingUsd > 0)) {
      throw new ManagerConfigError(
        "spend-ceiling-positive",
        `bot '${bot.id}' has spendCeilingUsd ${bot.spendCeilingUsd} — a zero or negative ceiling is a refusal, never silently unlimited (AC4)`,
        "set spendCeilingUsd to a positive finite number of USD",
      );
    }
  }

  // Counts (1 home / 3 bots), owner kind, id forms, and ceilings are all
  // proven above — the tuple types are exact, not aspirational.
  return parsed as ManagerConfig;
}
