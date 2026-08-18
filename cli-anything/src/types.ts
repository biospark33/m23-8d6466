import { z } from "zod";
import { isSafePathComponent } from "../../pi-vs-claude-code-vendor/coms-core.ts";

/**
 * CLI-Anything manifest schema.
 *
 * Flat, agent-authorable description of a `warren run` invocation:
 *   - name:    human/agent-facing identifier (required)
 *   - command: the payload command warren runs (required)
 *   - args:    optional argv passed after the command
 *   - env:     optional per-step env block, MERGED into the subprocess env
 *              (never a bare assignment — see INV-1 / mergeEnv).
 */
export const ManifestSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * P0.3 team manifest: a 3-agent mixed-model Warren team. Distinguished from
 * the flat single-command manifest by the required `team` block.
 *
 * Role model strings use `provider/model` form (e.g. "anthropic/claude-sonnet-4-5",
 * "openrouter/z-ai/glm-4.7"): split on the FIRST "/" — provider is the pi
 * `--provider` name, the rest is the model id.
 */
export const TeamRoleSchema = z
  .object({
    /** Agent id; becomes the coms cname (`<run-id>-<role>`) AND an artifact
     * filename — must satisfy coms-core's safe-path-component contract
     * (rejects ".", "..", separators). */
    agentId: z.string().trim().min(1).refine((s) => isSafePathComponent(s)),
    /** `provider/model` — split on first "/"; both halves must be non-empty. */
    model: z
      .string()
      .trim()
      .min(1)
      .refine((s) => {
        const idx = s.indexOf("/");
        return idx > 0 && idx < s.length - 1;
      }),
    prompt: z.string().trim().min(1),
    /**
     * DF1.9 — opt-in lean worker profile: spawn pi with `--no-extensions
     * --no-skills`. Absent means today's argv, byte for byte.
     */
    lean: z.boolean().optional(),
    /**
     * Explicit extension paths kept under lean (`--no-extensions` disables
     * discovery only, so these still load). Repo-root-relative; containment
     * is enforced before spawn, not here, because the repo root is a runtime
     * fact. A non-array, or a non-string entry, is a validation error — never
     * a truthy coercion (INV-2).
     */
    extensions: z.array(z.string().trim().min(1)).optional(),
  })
  // Still .strict(): widening with two named optional keys must not make any
  // OTHER unknown key acceptable as a side effect (INV-2).
  .strict();

export const TeamManifestSchema = z
  .object({
    name: z.string().trim().min(1),
    team: z
      .object({
        lead: TeamRoleSchema,
        workers: z.array(TeamRoleSchema).min(1).max(3),
        /** Warren project id the run executes against. */
        project: z.string().trim().min(1),
        /** Per-team shared budget cap in USD (INV-2). Default 0.50. */
        budgetCapUsd: z.number().positive().max(10).default(0.5),
        /** Turn cap per agent. Default 5. */
        turnCap: z.number().int().positive().max(50).default(5),
        /** Wall-clock cap ms. Default 5 min (INV-2). */
        wallClockCapMs: z.number().int().positive().max(3_600_000).default(300_000),
        /** Per-message coms await timeout ms (Trio override, OQ-16b). */
        comsAwaitTimeoutMs: z.number().int().positive().max(1_800_000).default(240_000),
      })
      .strict(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type TeamManifest = z.infer<typeof TeamManifestSchema>;
export type TeamRole = z.infer<typeof TeamRoleSchema>;

/**
 * Post-pivot exitStatus taxonomy (CC-1, 5-value enum). Single source of truth:
 * the union type AND every runtime membership check derive from this array,
 * so a status added to the type can never fail a guard that still lists the
 * old set (which would silently rewrite a worker's real status).
 */
export const EXIT_STATUSES = [
  "success",
  "transient",
  "overflow",
  "logic",
  "lead_failure",
] as const;

export type ExitStatus = (typeof EXIT_STATUSES)[number];

/** Structured budget/model override — audit-only in Phase 0 (P0.3-S-M5). */
export interface Waiver {
  type: "budget_override" | "model_fallback";
  reason: string;
  approvedBy: string;
}

/** Coms log entry — camelCase on stdout (harness boundary, CC-9). */
export interface ComsLogEntry {
  requestId: string;
  sessionId: string;
  phaseId: string;
  channel: string;
  direction: "send" | "receive";
  senderAgent: string;
  receiverAgent: string;
  payloadSize: number;
  durationMs: number;
  timestamp: string;
}

/**
 * Cost event polled after each LLM turn (CC-9).
 *
 * DF2.7 widens this ADDITIVELY: the four optional numerics carry session-
 * cumulative cache economics and turn accounting for one pi subprocess
 * invocation. `costUsd` keeps its existing USD-float meaning on the wire —
 * the integer micro-dollar unit belongs to the DF2.8 ledger (DD-9), which
 * converts at its own boundary. Producers that predate this widening simply
 * omit the four fields; `parseTeamEventLine` defaults them to 0.
 */
export interface CostEvent {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens for this invocation. 0 when the provider reports none. */
  cacheReadTokens?: number;
  /** Cache-write tokens for this invocation. 0 when the provider reports none. */
  cacheWriteTokens?: number;
  costUsd: number;
  /** Assistant turns observed in this invocation, priced or not. */
  turnCount?: number;
  /**
   * Turns whose usage was missing or malformed. `> 0` means the totals above
   * are a KNOWN-PARTIAL cost record: under-counted, never $0-priced
   * (INV-COST-5).
   */
  unpricedTurns?: number;
  durationMs: number;
  timestamp: string;
}

/** Error payload — mandatory on every non-success path (P0.3-M2). */
export interface MergedError {
  reason: "overflow" | "transient" | "logic" | "lead_failure";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Merged team output emitted on harness stdout (P0.3 contract).
 * Every exit path emits the SAME field set (P0.3-M2): `error` is null
 * (explicit) on success, populated otherwise; `agentOutputs` is `{}` on
 * lead_failure / coms-init transient, never absent.
 *
 * DF1.6: Extended with top-level testResults, testsExecuted, summary,
 * durationMs (moved), mulchPrimed, mulchPrimeError, and artifacts.
 * `result` stays byte-identical; `result.summary` is copied up to top-level
 * `summary` with a 2000-char ceiling including truncation suffix.
 */
export interface MergedOutput {
  result: Record<string, unknown>;
  changedFiles: string[];
  partial: boolean;
  exitStatus: ExitStatus;
  durationMs: number;
  waivers: Waiver[];
  agentOutputs: Record<string, unknown>;
  comsLog: ComsLogEntry[];
  error: MergedError | null;
  /** DF1.6: Test execution results from engine-side test runner. */
  testResults: { passed: number; failed: number };
  /** DF1.6: Must be false when passed+failed===0 (p1-6:62). */
  testsExecuted: boolean;
  /** DF1.6: Copied from result.summary, ≤2000 chars including suffix. */
  summary: string;
  /** DF1.6: Mulch priming success flag. */
  mulchPrimed: boolean;
  /** DF1.6: Mulch priming error (null when priming succeeded or not attempted). */
  mulchPrimeError: string | null;
  /** DF1.6: Artifacts produced by the team. */
  artifacts: Array<{ name: string; path: string }>;
  /** DF1.6: Partial output on failure paths (≤10000 chars with suffix), null on success. */
  partialOutput: string | null;
}

/** A worker's structured reply; `changedFiles` is mandatory (CORRECTNESS-C). */
export interface WorkerOutput {
  agentId: string;
  changedFiles: string[];
  result: Record<string, unknown>;
}

/** Exit classification for the structured harness result. */
export type ExitClass = "ok" | "nonzero" | "timeout" | "spawn_error";

/**
 * Structured JSON emitted on the harness's own stdout.
 *
 * INV-2/INV-3: carries NO secret values. `stdout_excerpt` is the subprocess
 * stdout (the story's demonstrable probe output), `env_probe_result` is the
 * QDS_PROBE value parsed from that stdout for the acceptance assertion — never
 * a dump of the merged env.
 */
export interface HarnessResult {
  exit_class: ExitClass;
  /**
   * Subprocess stdout, capped at MAX_STDOUT_EXCERPT UTF-16 code units
   * (see runner.ts). Secret-looking parent env values are redacted before
   * emission (INV-2), and the cap is re-applied after redaction.
   */
  stdout_excerpt: string;
  env_probe_result: string | null;
  /** True when stdout_excerpt was truncated at the MAX_STDOUT_EXCERPT cap. */
  truncated?: boolean;
  /** OS error code when the spawn itself failed (exit_class "spawn_error"). */
  spawn_error_code?: string | null;
  /** Signal that killed the child, when it died by signal (code === null). */
  signal?: string | null;
  /** Child's real exit code (null when killed by signal or spawn failed). */
  exit_code?: number | null;
}
