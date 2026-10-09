import { describe, expect, test } from "bun:test";
import {
  canonicalRoster,
  ensureManagerMentalModels,
  managerMentalModelId,
  withManagerMentalModels,
  type EnsureMentalModelsOpts,
  type ManagerModelClient,
  type ProvisionEnvelope,
} from "../../scripts/provision-hindsight-banks.ts";
import type { MentalModel } from "../../src/hindsight/schemas.ts";

// ---------------------------------------------------------------------------
// Structural fake client — in-memory model store + controllable op statuses.
// Implements ONLY the surface ensureManagerMentalModels touches; tests drive
// the EXPORTED function (main() stays inert behind import.meta.main).
// ---------------------------------------------------------------------------

type OpStatus = "processing" | "completed" | "failed" | "cancelled";

const BANKS = [
  "qds-factory-dev-meta",
  "qds-factory-qa-meta",
  "qds-factory-maint-meta",
];

function seedModel(bankId: string, trigger: MentalModel["trigger"]): MentalModel {
  const lane = /-(dev|qa|maint)-meta$/.exec(bankId)![1] as "dev" | "qa" | "maint";
  return {
    id: managerMentalModelId(bankId.replace(/-(dev|qa|maint)-meta$/, ""), lane),
    name: `Manager overview (${lane})`,
    source_query: "*",
    trigger,
    bank_id: bankId,
  };
}

interface FakeOpts {
  /** bankId → MMs present before the leg runs. */
  seed?: Record<string, MentalModel[]>;
  /** Fixed status reported for every create operation row. Default "completed". */
  createOpStatus?: OpStatus;
  /** Status progression per listOperations call (last entry sticks). */
  createOpStatusSequence?: OpStatus[];
  /** false → the store IGNORES patches (read-back drift). Default true. */
  applyPatches?: boolean;
}

function makeFakeClient(opts: FakeOpts = {}) {
  const banks = new Map<string, Map<string, MentalModel>>();
  for (const [bankId, models] of Object.entries(opts.seed ?? {})) {
    banks.set(
      bankId,
      new Map(models.map((m) => [m.id, m])),
    );
  }
  const createCalls: Array<{
    bankId: string;
    input: Parameters<ManagerModelClient["createMentalModel"]>[1];
  }> = [];
  const patchCalls: Array<{
    bankId: string;
    mmId: string;
    patch: Parameters<ManagerModelClient["patchMentalModel"]>[2];
  }> = [];
  let opSeq = 0;
  const opIds: string[] = [];
  /** One entry per listOperations call, in call order — the served statuses. */
  const pollStatuses: OpStatus[] = [];
  const fixedStatus = opts.createOpStatus ?? "completed";
  const statusForPoll = (): OpStatus => {
    if (opts.createOpStatusSequence === undefined) return fixedStatus;
    const seq = opts.createOpStatusSequence;
    // F-016: read-then-record — the FIRST poll sees sequence entry 0.
    return seq[Math.min(pollStatuses.length, seq.length - 1)]!;
  };

  const client: ManagerModelClient = {
    listMentalModels: (bankId) => {
      const items = [...(banks.get(bankId)?.values() ?? [])];
      return Promise.resolve({ items, total: items.length, limit: 100, offset: 0 });
    },
    createMentalModel: (bankId, input) => {
      createCalls.push({ bankId, input });
      const opId = `op-${++opSeq}`;
      opIds.push(opId);
      if (fixedStatus === "completed") {
        const m = banks.get(bankId) ?? new Map<string, MentalModel>();
        m.set(input.id!, {
          id: input.id!,
          name: input.name,
          source_query: input.sourceQuery,
          trigger: input.trigger ?? null,
          bank_id: bankId,
        });
        banks.set(bankId, m);
      }
      return Promise.resolve({ mental_model_id: input.id ?? null, operation_id: opId });
    },
    patchMentalModel: (bankId, mmId, patch) => {
      patchCalls.push({ bankId, mmId, patch });
      const m = banks.get(bankId)?.get(mmId);
      if (m !== undefined && opts.applyPatches !== false) {
        if (patch.trigger !== undefined) m.trigger = patch.trigger;
        if (patch.name !== undefined) m.name = patch.name;
      }
      return Promise.resolve(m ?? { id: mmId, name: "", trigger: patch.trigger ?? null });
    },
    listOperations: (bankId) => {
      // F-016: read-then-record — the first poll must return sequence[0].
      const status = statusForPoll();
      pollStatuses.push(status);
      return Promise.resolve({
        bank_id: bankId,
        total: opIds.length,
        limit: 50,
        offset: 0,
        operations: opIds.map((id, i) => ({
          id,
          task_type: "create_mental_model",
          items_count: 0,
          created_at: new Date().toISOString(),
          status: i === opIds.length - 1 ? status : "completed",
          error_message: status === "failed" ? "reflect boom" : null,
        })),
      });
    },
  };
  return { client, banks, createCalls, patchCalls, opIds, pollStatuses };
}

function legOpts(extra: Partial<EnsureMentalModelsOpts> = {}): EnsureMentalModelsOpts {
  return { pollIntervalMs: 1, pollTimeoutMs: 5_000, ...extra };
}

/** Pull the leg's fail-loud error out for field-level assertions. */
async function catchLeg(p: Promise<unknown>): Promise<Error & { code?: string; remediation?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; remediation?: string };
  }
  throw new Error("expected the leg to throw");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureManagerMentalModels: create-if-absent (AC1)", () => {
  test("all three banks absent → three creates with trigger set, ops polled to completed", async () => {
    const { client, banks, createCalls } = makeFakeClient();
    const res = await ensureManagerMentalModels(client, BANKS, legOpts());

    expect(res.models).toHaveLength(3);
    expect(res.models.map((m) => m.action)).toEqual(["created", "created", "created"]);
    expect(res.models.map((m) => m.mentalModelId)).toEqual([
      "qds-factory-dev-mind",
      "qds-factory-qa-mind",
      "qds-factory-maint-mind",
    ]);
    expect(createCalls).toHaveLength(3);
    for (const c of createCalls) {
      expect(c.input.id).toBe(`${c.bankId.replace(/-meta$/, "")}-mind`);
      expect(c.input.sourceQuery).toBe("*");
      expect(c.input.trigger).toEqual({ refresh_after_consolidation: true });
    }
    // Post-state read-back: every created model carries the trigger.
    for (const bankId of BANKS) {
      for (const mm of banks.get(bankId)!.values()) {
        expect(mm.trigger?.refresh_after_consolidation).toBe(true);
      }
    }
  });

  test("create op polled through processing → completed (not a single-shot read)", async () => {
    const { client, opIds, pollStatuses } = makeFakeClient({
      createOpStatusSequence: ["processing", "completed"],
    });
    const res = await ensureManagerMentalModels(client, [BANKS[0]!], legOpts());
    expect(res.models.map((m) => m.action)).toEqual(["created"]);
    expect(opIds).toHaveLength(1);
    // F-016: two polls minimum — one that saw "processing", one "completed";
    // the FIRST poll must be the one that saw "processing" (sequence entry 0
    // is actually served, not skipped by an increment-before-read).
    expect(pollStatuses.length).toBeGreaterThanOrEqual(2);
    expect(pollStatuses[0]).toBe("processing");
    expect(pollStatuses).toContain("completed");
  });
});

describe("ensureManagerMentalModels: re-provision is verify-only", () => {
  test("all present with trigger true → zero creates, zero patches, all 'verified'", async () => {
    const seed = Object.fromEntries(
      BANKS.map((b) => [b, [seedModel(b, { refresh_after_consolidation: true })]]),
    );
    const { client, createCalls, patchCalls } = makeFakeClient({ seed });
    const res = await ensureManagerMentalModels(client, BANKS, legOpts());

    expect(res.models).toHaveLength(3);
    expect(res.models.every((m) => m.action === "verified")).toBe(true);
    expect(createCalls).toHaveLength(0); // never re-attempt create (0.10.0 rejects it)
    expect(patchCalls).toHaveLength(0);
  });
});

describe("ensureManagerMentalModels: PATCH-to-converge", () => {
  test("present with trigger false → patched with the trigger, read-back true", async () => {
    const bankId = "qds-factory-qa-meta";
    const { client, banks, createCalls, patchCalls } = makeFakeClient({
      seed: { [bankId]: [seedModel(bankId, { refresh_after_consolidation: false })] },
    });
    const res = await ensureManagerMentalModels(client, [bankId], legOpts());

    expect(res.models).toEqual([
      { bankId, mentalModelId: "qds-factory-qa-mind", action: "patched" },
    ]);
    expect(createCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.patch).toEqual({ trigger: { refresh_after_consolidation: true } });
    expect(
      banks.get(bankId)!.get("qds-factory-qa-mind")!.trigger?.refresh_after_consolidation,
    ).toBe(true);
  });

  test("PATCH read-back drift (store ignores the patch) → fail loud naming the instance", async () => {
    const bankId = "qds-factory-maint-meta";
    const { client } = makeFakeClient({
      seed: { [bankId]: [seedModel(bankId, { refresh_after_consolidation: false })] },
      applyPatches: false,
    });
    const err = await catchLeg(ensureManagerMentalModels(client, [bankId], legOpts()));
    expect(err.message).toContain(bankId);
    expect(err.message).toContain("remediation");
    expect(err.code).toBe("mental_model_trigger_drift");
  });
});

describe("ensureManagerMentalModels: fail-loud create paths", () => {
  test("create operation failed → throws with the operation id in the message", async () => {
    const bankId = "qds-factory-dev-meta";
    const { client, opIds } = makeFakeClient({ createOpStatus: "failed" });
    const err = await catchLeg(ensureManagerMentalModels(client, [bankId], legOpts()));
    expect(err.message).toContain(opIds[0]!);
    expect(err.message).toContain("failed");
    expect(err.message).toContain(bankId);
    expect(err.code).toBe("mental_model_create_failed");
  });

  test("create operation never reaches terminal → poll timeout throws", async () => {
    const bankId = "qds-factory-qa-meta";
    const { client } = makeFakeClient({ createOpStatus: "processing" });
    const err = await catchLeg(
      ensureManagerMentalModels(
        client,
        [bankId],
        legOpts({ pollIntervalMs: 1, pollTimeoutMs: 20 }),
      ),
    );
    expect(err.message).toContain(bankId);
    expect(err.code).toBe("mental_model_create_timeout");
  });
});

describe("managerMentalModelId (deterministic custom ids)", () => {
  test("50-char repoBankId → ids ≤64 and schema-shaped", () => {
    const base = "a".repeat(50);
    for (const lane of ["dev", "qa", "maint"] as const) {
      const id = managerMentalModelId(base, lane);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(id).toBe(`${base}-${lane}-mind`);
    }
  });
});

describe("ensureManagerMentalModels: mixed state", () => {
  test("dev verified, qa absent, maint trigger-false → exactly one create, one patch, one verify", async () => {
    const devBank = "qds-factory-dev-meta";
    const maintBank = "qds-factory-maint-meta";
    const { client, createCalls, patchCalls } = makeFakeClient({
      seed: {
        [devBank]: [seedModel(devBank, { refresh_after_consolidation: true })],
        [maintBank]: [seedModel(maintBank, { refresh_after_consolidation: false })],
      },
    });
    const res = await ensureManagerMentalModels(client, BANKS, legOpts());

    expect(res.models.map((m) => [m.bankId, m.action])).toEqual([
      [devBank, "verified"],
      ["qds-factory-qa-meta", "created"],
      [maintBank, "patched"],
    ]);
    expect(createCalls).toHaveLength(1);
    expect(patchCalls).toHaveLength(1);
  });
});

describe("canonicalRoster (rerun-lane family roster)", () => {
  test("five names, order stable, collective last", () => {
    const expected = [
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-qa-meta",
      "qds-factory-maint-meta",
      "qds-collective",
    ];
    expect(canonicalRoster("qds-factory")).toEqual(expected);
    // Order stable across calls — compensation and the envelope fallback rely on it.
    expect(canonicalRoster("qds-factory")).toEqual(canonicalRoster("qds-factory"));
  });
});

describe("withManagerMentalModels (M3.1 envelope fold, F-014)", () => {
  const okEnvelope = (banks: string[]): ProvisionEnvelope => ({
    ok: true,
    banks,
    requestId: "req-test",
    createdInAttempt: [],
  });

  test("success fold — the ok envelope gains mentalModels rows for all three meta banks", async () => {
    const { client, createCalls } = makeFakeClient();
    const out = await withManagerMentalModels(
      client,
      okEnvelope(["qds-factory", "qds-factory-dev-meta", "qds-collective"]),
    );
    expect(out.ok).toBe(true);
    expect(out.mentalModels).toHaveLength(3);
    expect(out.mentalModels!.map((m) => m.action)).toEqual(["created", "created", "created"]);
    expect(out.mentalModels!.map((m) => m.bankId)).toEqual(BANKS);
    expect(createCalls).toHaveLength(3);
  });

  test("failure fold — a leg throw converts to the failure idiom quoting remediation", async () => {
    const bankId = "qds-factory-maint-meta";
    // The failing fake from the drift cases: the store ignores PATCHes, so the
    // leg's read-back check throws (message carries remediation).
    const { client } = makeFakeClient({
      seed: { [bankId]: [seedModel(bankId, { refresh_after_consolidation: false })] },
      applyPatches: false,
    });
    const out = await withManagerMentalModels(
      client,
      okEnvelope(["qds-factory", "qds-factory-dev-meta", "qds-collective"]),
    );
    expect(out.ok).toBe(false);
    expect(out.banks).toEqual([]);
    expect(out.mentalModels).toBeUndefined();
    expect(out.error?.code).toBe("mental_model_provision_failed");
    expect(out.error?.message).toContain("remediation");
  });

  test("passthrough — a non-ok envelope OR empty banks returns unchanged, no MM calls", async () => {
    const { client } = makeFakeClient();
    const calls: string[] = [];
    const spy: ManagerModelClient = {
      listMentalModels: (...a) => {
        calls.push("list");
        return client.listMentalModels(...a);
      },
      createMentalModel: (...a) => {
        calls.push("create");
        return client.createMentalModel(...a);
      },
      patchMentalModel: (...a) => {
        calls.push("patch");
        return client.patchMentalModel(...a);
      },
      listOperations: (...a) => {
        calls.push("ops");
        return client.listOperations(...a);
      },
    };
    const failed: ProvisionEnvelope = {
      ok: false,
      banks: [],
      requestId: "req-failed",
      createdInAttempt: [],
      error: { code: "provision_failed", message: "bank roster failed" },
    };
    expect(await withManagerMentalModels(spy, failed)).toBe(failed);
    const emptyBanks = okEnvelope([]);
    expect(await withManagerMentalModels(spy, emptyBanks)).toBe(emptyBanks);
    expect(calls).toEqual([]); // neither passthrough touched the client
  });
});
