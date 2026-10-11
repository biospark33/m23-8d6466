/**
 * A5 leaf-1.2 — the best-effort snapshot retain leg, split out of
 * scripts/qds-kpi.ts only for the <500-line file rule. Behavior contract lives
 * in that script's docblock; the load-bearing facts:
 * - Env-gated (HINDSIGHT_BASE_URL + HINDSIGHT_BEARER_TOKEN|HINDSIGHT_API_KEY —
 *   the same pair src/fleet/retain-best-effort.ts gates on). Env absent → one
 *   skip line, no client, no call, the CLI's exit code unchanged.
 * - documentId = `kpi-snapshot-<windowId>-<hash12>` over the pure-function
 *   payload: same window data → same documentId → idempotent replace (AC5);
 *   mutated data → a NEW documentId, so M1.2's divergent-tamper alarm is
 *   unreachable by construction.
 * - `QDS_KPI_RETAIN_CAPTURE=<jsonl>` swaps the network client for a capture
 *   client with the same {listBanks, retain} surface — the test seam, because
 *   a `mode:"mock"` HindsightClient short-circuits with canned bodies and
 *   records nothing the idempotency asserts need. The capture listBanks
 *   synthesizes the bank family provisioning would create for the slug, so
 *   the resolution path (resolveBankId → provisioned-family signature) runs
 *   for real and the recorded bankId is the one the live arm targets.
 * - Wall-capped (retain-best-effort F17): a late rejection surfaces as a skip
 *   line, never an unhandled rejection or a changed exit code.
 */
import { appendFileSync } from "node:fs";

import { extractExistingBankIds, resolveProvisionedRepoBankId } from "../../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../../src/hindsight/client.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";
import { payloadHashHex, stableStringify, type KpiSnapshotPayload } from "../../src/kpi/kpis.ts";

const RETAIN_WALL_MS = 10_000;

export type RetainSkipLine = (code: string, reason: string) => void;

export async function retainSnapshot(
  payload: KpiSnapshotPayload,
  windowId: string,
  repoSlug: string | undefined,
  skipLine: RetainSkipLine,
): Promise<void> {
  const envConfigured =
    Boolean(process.env.HINDSIGHT_BASE_URL) &&
    Boolean(process.env.HINDSIGHT_BEARER_TOKEN || process.env.HINDSIGHT_API_KEY);
  if (!envConfigured) {
    skipLine("retain-skipped", "Hindsight env not configured (HINDSIGHT_BASE_URL + token) — snapshot written, retain skipped");
    return;
  }
  const retainOnce = async (): Promise<void> => {
    try {
      if (repoSlug === undefined || repoSlug.length === 0) {
        skipLine("retain-skipped", "no repo slug resolvable (--repo / $QDS_REPO_SLUG / git remote origin) — the retain's bank is unknown");
        return;
      }
      const documentId = `kpi-snapshot-${windowId}-${payloadHashHex(payload).slice(0, 12)}`;
      const capturePath = process.env.QDS_KPI_RETAIN_CAPTURE;
      const client: Pick<HindsightClient, "listBanks" | "retain"> =
        capturePath !== undefined
          ? {
              listBanks: async () => {
                const base = resolveBankId(repoSlug);
                return { banks: [base, `${base}-dev-meta`] };
              },
              retain: async (bankId, content, metadata) => {
                // `content` is stableStringify(payload) one frame up; hashing
                // `payload` directly is the same bytes (payloadHashHex
                // re-serializes stably) without a JSON round-trip.
                appendFileSync(capturePath, `${JSON.stringify({ bankId, documentId: metadata?.documentId, content_sha256: payloadHashHex(payload), content_bytes: content.length, metadata })}\n`);
                return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
              },
            }
          : new HindsightClient();
      const repoBankId = resolveProvisionedRepoBankId(resolveBankId(repoSlug), extractExistingBankIds(await client.listBanks()));
      if (repoBankId === null) {
        skipLine("retain-skipped", `memory banks are not provisioned for repo ${repoSlug}`);
        return;
      }
      await client.retain(repoBankId, stableStringify(payload), {
        documentId,
        updateMode: "replace",
        kind: "observation",
        source: "agent",
        tags: ["kpi-snapshot", windowId],
      });
    } catch (e) {
      // Best-effort contract: no throw escapes. After the wall cap already
      // surfaced retain-timeout, a late rejection stays swallowed (F17).
      if (!timedOut) skipLine("retain-failed", ((e as Error)?.message ?? String(e)).slice(0, 200) || "the retain call failed");
    }
  };
  let timedOut = false;
  const body = retainOnce();
  body.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          skipLine("retain-timeout", `the retain exceeded its ${RETAIN_WALL_MS}ms wall-clock cap`);
          resolve();
        }, RETAIN_WALL_MS);
      }),
    ]);
  } catch (e) {
    skipLine("retain-failed", ((e as Error)?.message ?? String(e)).slice(0, 200) || "the retain call failed");
  } finally {
    clearTimeout(timer);
  }
}
