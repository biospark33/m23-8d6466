/**
 * M3.1 — the infra-tier live round (story
 * m3-1-manager-meta-banks-l3-consolidate, DoD "Test (e2e demo — MANDATORY)"):
 * the documented crontab fallback drives ONE real consolidate + refresh
 * through the memgate gateway against the dedicated Hindsight 0.10.0
 * instance, the platform-schedule leg is demonstrated at the gateway seam
 * with an agent token (same job module, leg:"schedule"), and the docs-derived
 * bank-dedup claim (v4 PRD :578) is instance-verified by firing TWO
 * CONCURRENT consolidates against ONE bank and counting the operations.
 *
 * INFRA TIER (QDS_E2E_TIER=0): no exe.dev box, no in-box model spend, no
 * factory OpenRouter key — the only spend is the dedicated instance's own
 * configured consolidation-model calls, printed worst-case BEFORE anything
 * fires and gated on an explicit operator GO (QDS_M31_LIVE_GO=1; absence is
 * a refusal, never silence).
 *
 * THE SCRIPT CORE, not a reimplementation: the crontab leg runs
 * runMemoryNightly (scripts/memory-nightly.ts — the crontab line's own
 * driver) with process.env; the schedule + dedup legs run runNightlyConsolidate
 * (src/hindsight/nightly-consolidate.ts — the job module both legs call) over
 * the same memgateDeps shape the script builds. No fakes anywhere: no stubbed
 * fetch, no mock client. Without QDS_E2E_LIVE=1 every test is todoIf-off and
 * pays nothing.
 *
 * Cleanup: deliberately NONE that destroys state — consolidation is
 * idempotent server-side, the manager meta banks persist by design, and the
 * operator's agent token is long-lived until revoked (M2.1 machinery). Token
 * material exists in this file as the ENV NAME only (INV-MEM-3); evidence is
 * scrubbed of the token VALUE before any write.
 *
 * Round shape (one VPS pass):
 *   L0  worst-case spend print (before anything bills) + the GO gate named
 *   T1  crontab leg end-to-end: runMemoryNightly → 3 receipts, each with
 *       refresh.mechanism === "consolidation-trigger" and OBSERVED refresh
 *       evidence (observedVia "operations-list") — trigger read-back alone
 *       never passes (AC2's proof standard)
 *   T2  dedup claim: two concurrent runNightlyConsolidate on ONE bank — at
 *       least one deduplicated:true receipt = coalescing observed = the :578
 *       claim instance-verified; NOT observed = evidence still written, then
 *       the test FAILS LOUD (the story's named-fallback trigger:
 *       scripts/lib/run-lock.ts or operations-polling must be adopted before
 *       merge)
 *   T3  schedule leg at the seam: same job module, leg:"schedule", one bank,
 *       receipt shape identical to the crontab receipts
 *
 * live-harness.ts is not this file's to edit, so the memory-nightly env
 * presence check is LOCAL (liveGate still owns the tier gate).
 */
import { describe, expect, test } from "bun:test";

import { forbiddenOrigin } from "../../../scripts/p0-9/leg-lib.ts";
import {
  extractExistingBankIds,
  resolveProvisionedRepoBankId,
} from "../../../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../../../src/hindsight/client.ts";
import { runNightlyConsolidate } from "../../../src/hindsight/nightly-consolidate.ts";
import { BankIdSchema, resolveBankId } from "../../../src/hindsight/schemas.ts";
import { runMemoryNightly } from "../../../scripts/memory-nightly.ts";
import { ensureManagerMentalModels } from "../../../scripts/provision-hindsight-banks.ts";
import { memgateDeps } from "../../../src/memgate/gateway.ts";
import { MEMGATE_ADMIN_KEY, QDS_MEMGATE_LEDGER, QDS_MEMGATE_SIGNING_KEY } from "../../../src/memgate/schemas.ts";
import { liveGate, liveTodoOff, setEffectiveImage, writeEvidenceQuietly } from "./live-harness.ts";

/** The dedicated instance's own default evidence poll bound — the per-leg
 * ceiling this round's test timeouts are priced above (nightly-consolidate). */
const EVIDENCE_BUDGET_MS = 300_000;
const WALL_BUDGET_MS = 900_000;

/** Env NAMES this round requires (INV-MEM-3: names in code, values never). */
const REQUIRED_M31_ENV = [
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "MEMGATE_ADMIN_KEY",
  "QDS_MEMGATE_SIGNING_KEY",
  "QDS_MEMGATE_LEDGER",
  "QDS_MEMORY_AGENT_TOKEN",
] as const;

/**
 * The memory-nightly env, checked BY NAME before any spend (live-harness is
 * not edited, so this is the local half of the gate). Returns the instance
 * base URL. QDS_MEMORY_REPO_SLUG is optional (default qds-factory).
 */
function requireM31Env(): string {
  const missing = REQUIRED_M31_ENV.filter((n) => (process.env[n] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `M3.1 live round env incomplete — ${missing.join(", ")} unset (QDS_MEMORY_REPO_SLUG is optional, default qds-factory)`,
    );
  }
  const base = (process.env.HINDSIGHT_BASE_URL ?? "").trim(); // dp:ok blank already refused by the missing check above
  const trap = forbiddenOrigin(base);
  if (trap !== null) throw new Error(trap);
  return base;
}

/** The explicit operator GO gate — absence throws naming the gate, never proceeds on silence (AC5). */
function requireOperatorGo(): void {
  if (process.env.QDS_M31_LIVE_GO !== "1") {
    throw new Error(
      "operator GO gate: QDS_M31_LIVE_GO=1 is not set — refusing to fire the nightly (worst-case spend was printed by the L0 leg; export QDS_M31_LIVE_GO=1 to proceed)",
    );
  }
}

/**
 * The agent token VALUE scrubbed out of an evidence payload by JSON
 * round-trip — the one credential this round holds, and a shape the harness
 * scrub (sk-/ghp_/github_pat_) is blind to. Receipts never carry it; this
 * guards error messages that might.
 */
function scrubToken(payload: Record<string, unknown>): Record<string, unknown> {
  const token = (process.env.QDS_MEMORY_AGENT_TOKEN ?? "").trim(); // dp:ok absent token = nothing to scrub, not an error
  if (token === "") return payload;
  return JSON.parse(JSON.stringify(payload).split(token).join("[REDACTED-AGENT-TOKEN]")) as Record<string, unknown>;
}

/**
 * The provisioned manager meta family for the round's repo slug — the SAME
 * derivation the crontab driver performs, so T1's envelope.banks and the
 * leg-local derivations cannot drift.
 */
async function managerMetaBanks(client: HindsightClient): Promise<string[]> {
  const slug = (process.env.QDS_MEMORY_REPO_SLUG ?? "").trim() || "qds-factory";
  const base = resolveBankId(slug);
  const repo = resolveProvisionedRepoBankId(base, extractExistingBankIds(await client.listBanks()));
  if (repo === null) {
    throw new Error(`no provisioned repo bank family for slug ${slug} — run scripts/provision-hindsight-banks.ts first`);
  }
  const banks = [`${repo}-dev-meta`, `${repo}-qa-meta`, `${repo}-maint-meta`];
  for (const bank of banks) expect(BankIdSchema.safeParse(bank).success).toBe(true);
  return banks;
}

/** The round's shared gateway deps — the memgateDeps shape the crontab
 * driver builds (config vars passed BY NAME, never whole process.env). */
function m31Gateway(client: HindsightClient, log: (entry: unknown) => void) {
  return memgateDeps({
    env: {
      [MEMGATE_ADMIN_KEY]: process.env[MEMGATE_ADMIN_KEY] as string, // dp:ok requireM31Env refused before this cast runs
      [QDS_MEMGATE_SIGNING_KEY]: process.env[QDS_MEMGATE_SIGNING_KEY] as string, // dp:ok same
      [QDS_MEMGATE_LEDGER]: process.env[QDS_MEMGATE_LEDGER] as string, // dp:ok same
    },
    ledgerPath: process.env[QDS_MEMGATE_LEDGER],
    client,
    log,
  });
}

describe("memory nightly live (M3.1, infra tier)", () => {
  test.todoIf(liveTodoOff())("L0 spend: worst-case printed before anything fires, GO gate named", () => {
    liveGate("0");
    requireM31Env();
    process.stdout.write(
      [
        "M3.1 infra-tier worst-case spend (printed before anything fires):",
        "  crontab leg   = 3 banks x (1 consolidate + 1 consolidation-trigger refresh) = 6 calls",
        "  schedule leg  = 1 bank  x (1 consolidate + 1 refresh)                       = 2 calls",
        "  dedup probe   = 2 concurrent consolidates on ONE bank (up to 2 refreshes)   = 4 calls",
        "  worst case = 6 consolidates + 6 refreshes = 12 instance-side LLM calls.",
        "Per-call cost is the dedicated instance's configured consolidation model",
        "(operator-billed on the instance; this file holds NO factory key, NO box,",
        "NO OpenRouter spend). Firing requires QDS_E2E_LIVE=1, QDS_E2E_TIER=0 and an",
        "explicit operator GO: QDS_M31_LIVE_GO=1 — absence is a refusal, never silence.",
        "",
      ].join("\n"),
    );
  });

  test.todoIf(liveTodoOff())(
    "T1 crontab leg end-to-end: runMemoryNightly — 3 banks, OBSERVED refresh receipts",
    async () => {
      liveGate("0");
      requireM31Env();
      requireOperatorGo();
      setEffectiveImage(null, { note: "M3.1 infra tier — no box; VPS gateway + dedicated Hindsight instance only" });
      let failure: unknown;
      const problems: string[] = [];
      let evidence: Record<string, unknown> = { phase: "m31.crontab-leg" };
      try {
        const mem = new HindsightClient();
        const banks = await managerMetaBanks(mem);
        const provisionEvents: unknown[] = [];
        const provision = await ensureManagerMentalModels(mem, banks, { log: (e) => provisionEvents.push(e) });

        const { code, envelope } = await runMemoryNightly({ env: process.env, argv: [], log: (e) => provisionEvents.push(e) });
        expect(code).toBe(0);
        if (!("receipts" in envelope)) {
          throw new Error(`the crontab driver refused (code ${code}): ${JSON.stringify(envelope)}`);
        }
        // Evidence lands BEFORE the shape asserts, so a failed assert still
        // leaves the receipts on disk (the round's whole point).
        evidence = {
          phase: "m31.crontab-leg",
          envelope: {
            ok: envelope.ok,
            leg: envelope.leg,
            banks: envelope.banks,
            banksOk: envelope.banksOk,
            banksFailed: envelope.banksFailed,
            totalMs: envelope.totalMs,
            receipts: envelope.receipts,
            failures: envelope.failures,
          },
          mentalModels: provision.models,
          eventCount: provisionEvents.length,
        };
        expect(envelope.leg).toBe("crontab");
        expect(envelope.ok).toBe(true);
        expect(envelope.banks).toEqual(banks); // the driver's own derivation matches this file's
        expect(envelope.banksOk).toBe(3);
        expect(envelope.receipts.length).toBe(3);
        expect(envelope.banksFailed).toBe(0);
        for (const receipt of envelope.receipts) {
          expect(receipt.refresh.mechanism).toBe("consolidation-trigger"); // trigger-only per DD-28.16
          expect(receipt.refresh.observedVia).toBe("operations-list"); // OBSERVED evidence, never trigger read-back (AC2)
          expect(receipt.refresh.operationId.length).toBeGreaterThan(0);
        }
      } catch (e) {
        failure = e;
        evidence = { ...evidence, error: e instanceof Error ? e.message : String(e) };
      } finally {
        writeEvidenceQuietly("m31-live", "m31-crontab-leg", scrubToken(evidence), problems);
      }
      if (failure !== undefined) {
        if (problems.length > 0) {
          throw new Error(`${problems.join("; ")} (also failed: ${failure instanceof Error ? failure.message : String(failure)})`, { cause: failure });
        }
        throw failure;
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
    WALL_BUDGET_MS + EVIDENCE_BUDGET_MS,
  );

  test.todoIf(liveTodoOff())(
    "T2 dedup claim instance-verified: two CONCURRENT consolidates on ONE bank — coalescing counted",
    async () => {
      liveGate("0");
      requireM31Env();
      requireOperatorGo();
      setEffectiveImage(null, { note: "M3.1 infra tier — no box; VPS gateway + dedicated Hindsight instance only" });
      let failure: unknown;
      const problems: string[] = [];
      let evidence: Record<string, unknown> = { phase: "m31.dedup-claim" };
      try {
        const mem = new HindsightClient();
        const banks = await managerMetaBanks(mem);
        await ensureManagerMentalModels(mem, banks, { log: () => {} }); // the round provisions if absent
        const bank = banks[0] as string; // dp:ok managerMetaBanks always returns the three-lane family
        const events: unknown[] = [];
        const log = (e: unknown): void => {
          events.push(e);
        };
        const gateway = m31Gateway(mem, log);
        const deps = {
          gateway,
          token: process.env.QDS_MEMORY_AGENT_TOKEN as string, // dp:ok requireM31Env refused before this cast runs
          banks: [bank],
          leg: "schedule" as const,
        };
        const [a, b] = await Promise.all([runNightlyConsolidate(deps), runNightlyConsolidate(deps)]);
        const receipts = [...a.receipts, ...b.receipts];
        const coalesced = receipts.some((r) => r.consolidate.deduplicated === true);
        const verdict = coalesced ? "coalescing-observed" : "NOT-observed";
        // The named caveat (nightly-consolidate header): a re-fire landing after
        // the consolidation left pending yields REFRESH_EVIDENCE_MISSING on the
        // coalesced leg — honest, recorded, not the claim's failure.
        const caveatFailures = [...a.failures, ...b.failures].filter((f) => f.code === "REFRESH_EVIDENCE_MISSING");
        const hardFailures = [...a.failures, ...b.failures].filter((f) => f.code !== "REFRESH_EVIDENCE_MISSING");
        evidence = {
          phase: "m31.dedup-claim",
          bank,
          results: [a, b].map((r) => ({
            ok: r.ok,
            leg: r.leg,
            banksOk: r.banksOk,
            banksFailed: r.banksFailed,
            totalMs: r.totalMs,
            receipts: r.receipts,
            failures: r.failures,
          })),
          receiptCount: receipts.length,
          deduplicatedReceipts: receipts.filter((r) => r.consolidate.deduplicated === true).length,
          distinctOperationIds: [...new Set(receipts.map((r) => r.consolidate.operationId).filter((id) => id !== undefined))],
          caveatFailures: caveatFailures.map((f) => ({ bankId: f.bankId, code: f.code })),
          coalesced,
          verdict,
          eventCount: events.length,
        };
        if (hardFailures.length > 0) {
          throw new Error(`dedup probe hit hard failure(s): ${hardFailures.map((f) => `${f.bankId}:${f.code}`).join(", ")}`);
        }
        if (!coalesced) {
          // The story's named-fallback trigger: evidence FIRST (written in the
          // finally below), then fail loud — :578 is docs-derived until proven.
          throw new Error(
            "dedup claim NOT verified — two concurrent consolidates against one bank produced no deduplicated receipt; " +
              "the v4 :578 coalescing claim fails on this instance and the named fallback (scripts/lib/run-lock.ts or operations-polling) must be adopted before merge",
          );
        }
      } catch (e) {
        failure = e;
        evidence = { ...evidence, error: e instanceof Error ? e.message : String(e) };
      } finally {
        writeEvidenceQuietly("m31-live", "m31-dedup-claim", scrubToken(evidence), problems);
      }
      if (failure !== undefined) {
        if (problems.length > 0) {
          throw new Error(`${problems.join("; ")} (also failed: ${failure instanceof Error ? failure.message : String(failure)})`, { cause: failure });
        }
        throw failure;
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
    EVIDENCE_BUDGET_MS * 2 + 120_000,
  );

  test.todoIf(liveTodoOff())(
    "T3 schedule leg at the gateway seam: same job module, leg schedule, one bank",
    async () => {
      liveGate("0");
      requireM31Env();
      requireOperatorGo();
      setEffectiveImage(null, { note: "M3.1 infra tier — no box; VPS gateway + dedicated Hindsight instance only" });
      let failure: unknown;
      const problems: string[] = [];
      let evidence: Record<string, unknown> = { phase: "m31.schedule-leg" };
      try {
        const mem = new HindsightClient();
        const banks = await managerMetaBanks(mem);
        await ensureManagerMentalModels(mem, banks, { log: () => {} });
        const bank = banks[0] as string; // dp:ok managerMetaBanks always returns the three-lane family
        const events: unknown[] = [];
        const result = await runNightlyConsolidate({
          gateway: m31Gateway(mem, (e) => events.push(e)),
          token: process.env.QDS_MEMORY_AGENT_TOKEN as string, // dp:ok requireM31Env refused before this cast runs
          banks: [bank],
          leg: "schedule",
        });
        // Evidence lands BEFORE the shape asserts, so a failed assert still
        // leaves the receipt on disk.
        evidence = {
          phase: "m31.schedule-leg",
          bank,
          result: {
            ok: result.ok,
            leg: result.leg,
            banksOk: result.banksOk,
            banksFailed: result.banksFailed,
            totalMs: result.totalMs,
            receipts: result.receipts,
            failures: result.failures,
          },
          eventCount: events.length,
        };
        expect(result.ok).toBe(true);
        expect(result.leg).toBe("schedule");
        expect(result.receipts.length).toBe(1);
        const receipt = result.receipts[0] as (typeof result.receipts)[number]; // dp:ok length asserted to 1 directly above
        // Receipt shape IDENTICAL to the crontab receipts (NightlyReceipt): the
        // two legs differ only in the leg label, never in the proof they carry.
        expect(Object.keys(receipt).sort().join(",")).toBe("bankId,consolidate,mentalModelId,refresh");
        expect(Object.keys(receipt.refresh).sort().join(",")).toBe("mechanism,observedVia,operationId,status");
        expect(receipt.refresh.mechanism).toBe("consolidation-trigger");
        expect(receipt.refresh.observedVia).toBe("operations-list");
        expect(receipt.refresh.operationId.length).toBeGreaterThan(0);
      } catch (e) {
        failure = e;
        evidence = { ...evidence, error: e instanceof Error ? e.message : String(e) };
      } finally {
        writeEvidenceQuietly("m31-live", "m31-schedule-leg", scrubToken(evidence), problems);
      }
      if (failure !== undefined) {
        if (problems.length > 0) {
          throw new Error(`${problems.join("; ")} (also failed: ${failure instanceof Error ? failure.message : String(failure)})`, { cause: failure });
        }
        throw failure;
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
    EVIDENCE_BUDGET_MS + 120_000,
  );
});
