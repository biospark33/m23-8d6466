/**
 * M1.2 AC4: the ONE best-effort harvest-retain seam, shared by every harvest
 * arm in the factory:
 *   - `fleet harvest`'s direct arm (scripts/fleet.ts runHarvest),
 *   - the teardown/observe verbs' injected `postHarvest` hook
 *     (scripts/fleet.ts runDestructive's TeardownDeps),
 *   - the observe chain's post-harvest hook (src/fleet/run-completion.ts
 *     chainTeardownDeps).
 * Both of the former twins lived here once as copies — scripts/fleet.ts
 * imports src/fleet/run-completion.ts, so a reverse import would have been a
 * cycle and the story's deviation note sanctioned the duplication; this
 * module is the sanctioned fallback retired. It imports neither caller back,
 * so the cycle stays broken in both directions. The seam underneath is still
 * `retainRunOutcome` (src/hindsight/run-retain.ts) — this module only owns
 * the best-effort wrapping every arm shares.
 *
 * Env-gated (AC2a's harvest twin): unconfigured memory means no client, no
 * listBanks, no row, no line — and the harvest exit untouched. Everything
 * else that can throw sits inside the try: a retain failure NEVER changes
 * the harvest exit code (the harvest leg landed either way) — it degrades to
 * one structured error line, the same posture the teardown hook's own wrap
 * takes.
 *
 * The join key is always the RECORD's dispatch stamp, never the invocation's
 * (Observability Contract): the caller's `requestId` is the caller's copy of
 * the same stamp, so the record's own field wins whenever it carries one.
 *
 * The repo bank id is resolved by FAMILY SIGNATURE against the LIVE bank list
 * (F16/G1): `resolveProvisionedRepoBankId` walks the truncation candidates
 * (base, then -2..-11) and returns the first candidate for which BOTH the bank
 * and its `-dev-meta` sibling exist — a pair only `provisionBanks` creates —
 * so the retain targets the SAME provisioned bank the write leg created and
 * the kg-context read leg fans out over: the dispatch→harvest cycle closes
 * against one id instead of naming a bank nothing provisioned. Null means no
 * provisioned family in the list — the banks were never provisioned for this
 * repo, and retaining into an invented id is an opaque 404. A record with no
 * budget.repoSlug refuses to invent one (INV-AUDIT-4 posture) — skipped
 * loudly, since a misprovisioned run must be findable.
 */
import { join } from "node:path";

import { extractExistingBankIds, resolveProvisionedRepoBankId } from "../hindsight/bank-provisioner.ts";
import { HindsightClient } from "../hindsight/client.ts";
import { retainRunOutcome } from "../hindsight/run-retain.ts";
import { resolveBankId } from "../hindsight/schemas.ts";
import type { ProviderAuditLink } from "../providers/driver.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { log } from "../lib/log.ts";

// F17: the retain's wall-clock cap — best-effort never dwells past it on the
// harvest/teardown critical path.
const RETAIN_BEST_EFFORT_WALL_MS = 10_000;

export async function retainRunOutcomeBestEffort(input: {
  store: RunRecordStore;
  runId: string;
  requestId: string;
  outcome: "harvested" | "none";
  count?: number;
  auditRecord: (link: ProviderAuditLink) => void;
}): Promise<void> {
  // Empty strings count as unconfigured — the same coercion kg-context's gate
  // and the client's auth fallback apply (and the same env pair: the host
  // token INV-HM1 is the only retain credential there is, DD-16).
  const envConfigured =
    Boolean(process.env.HINDSIGHT_BASE_URL) &&
    Boolean(process.env.HINDSIGHT_BEARER_TOKEN || process.env.HINDSIGHT_API_KEY);
  if (!envConfigured) return;
  // F9: this line is the helper's LAST resort — its own emission must never
  // throw past it (a raising log sink must not turn a skipped retain into a
  // crashed harvest/teardown path).
  const skipLine = (code: string, reason: string): void => {
    try {
      log({
        requestId: input.requestId,
        operation: "memory-retain",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "error",
        runId: input.runId,
        error: { code, message: reason },
        reason: "harvest retain skipped — the harvest leg landed and its exit is unchanged (M1.2 AC4 best-effort)",
      });
    } catch {
      // Silence is the last resort.
    }
  };
  const retainOnce = async (): Promise<void> => {
    // The RECORD's stamp is the join key whenever it carries one — the same
    // rule run-completion's recordRequestId applies; the invocation's id is
    // only the fallback. (F14: when NEITHER carries one there is no join key
    // at all — a benign skip, not a failure.)
    const rec = input.store.get(input.runId);
    const requestId =
      typeof rec.requestId === "string" && rec.requestId !== "" ? rec.requestId : input.requestId;
    if (requestId.length === 0) {
      skipLine("retain-skipped", `run ${input.runId} carries no requestId — the retain's join key is unknown`);
      return;
    }
    const repoSlug = rec.extensions?.budget?.repoSlug;
    if (typeof repoSlug !== "string" || repoSlug.length === 0) {
      skipLine("retain-skipped", `run ${input.runId} carries no budget.repoSlug — the retain's bank is unknown`);
      return;
    }
    const client = new HindsightClient();
    const existing = extractExistingBankIds(await client.listBanks());
    // G1: only a provisioned FAMILY (bank + `-dev-meta`) is retainable — see
    // the header above.
    const repoBankId = resolveProvisionedRepoBankId(resolveBankId(repoSlug), existing);
    if (repoBankId === null) {
      skipLine("retain-skipped", `run ${input.runId}'s memory banks are not provisioned for this repo`);
      return;
    }
    await retainRunOutcome(
      client,
      // The caller's audit emitter, adapted: retainRunOutcome only ever calls
      // `record`, and the composition root owns the store's lifecycle — the
      // retain never closes another module's handle.
      { record: input.auditRecord, close() {}, path: "" },
      {
        runId: input.runId,
        repoSlug,
        requestId,
        // The harvest LEG landed either way; harvested-with-commits is the
        // only green shape — a harvest that pulled nothing is an unsettled
        // outcome, which is the classification's own meaning. (G7: the bundle
        // IS the harvest's record — harvest writes nothing to the run record —
        // so its path rides along exactly when there is one.)
        exitClassification: input.outcome === "harvested" ? "green" : "unsettled",
        ...(input.outcome === "harvested"
          ? { harvestedCount: input.count ?? 0, bundlePath: join(input.store.dir, `${input.runId}.bundle`) }
          : {}),
        tags: ["factory-run"],
        repoBankId,
      },
    );
  };
  // F17: the whole post-env-gate body rides the wall clock. A body that
  // loses the race keeps running, but its late rejection must not surface as
  // an unhandled rejection — the timeout line is the only witness the cap
  // owes the operator.
  const body = retainOnce();
  body.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          skipLine("retain-timeout", `the retain exceeded its ${RETAIN_BEST_EFFORT_WALL_MS}ms wall-clock cap`);
          resolve();
        }, RETAIN_BEST_EFFORT_WALL_MS);
      }),
    ]);
  } catch (e) {
    // F9: the failure line's own construction (String/redactSecrets over a
    // hostile throwable) is guarded too — the catch never throws past itself.
    try {
      skipLine(
        "retain-failed",
        redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200) || "the retain call failed",
      );
    } catch {
      // Silence — see F9 above.
    }
  } finally {
    clearTimeout(timer);
  }
}
