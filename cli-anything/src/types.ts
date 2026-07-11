import { z } from "zod";

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
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

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
  stdout_excerpt: string;
  env_probe_result: string | null;
}
