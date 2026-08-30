/**
 * F041: the eleven `{code, remediation}` provider errors share ONE base.
 *
 * The contract this pins is the acceptance criterion of the refactor: every
 * `instanceof` and `.code` read that existed before still works. Hence both
 * halves of every case — `instanceof ProviderError` (the new, shared reach)
 * AND the subclass's own `name` plus its own `instanceof` (the old, per-class
 * reach that dispatch/teardown/reaper classify on).
 */

import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../src/providers/errors.ts";
import { CostLedgerError } from "../../src/providers/cost-ledger.ts";
import { CredentialLifecycleError } from "../../src/providers/credentials.ts";
import { ProvisionRefusedError } from "../../src/providers/driver.ts";
import { TeardownError } from "../../src/providers/teardown.ts";
import { HarvestError } from "../../src/providers/harvest.ts";
import { SweepError } from "../../src/providers/reaper.ts";
import { QuotaLimitsError } from "../../src/providers/quota.ts";
import { ExeDevDriverError } from "../../src/providers/exedev/transport.ts";
import { VizError } from "../../src/providers/viz-guard.ts";
import { FakeDriverError } from "../../src/providers/fake-driver.ts";
import { OverBudgetError } from "../../src/providers/budget-gate.ts";

/** [display name, construct it, the `code` it must report]. */
const CASES: [string, () => ProviderError, string][] = [
  ["CostLedgerError", () => new CostLedgerError("ledger-busy", "msg", "fix it"), "ledger-busy"],
  [
    "CredentialLifecycleError",
    () => new CredentialLifecycleError("invalid-provider-usage", "msg", "fix it"),
    "invalid-provider-usage",
  ],
  ["ProvisionRefusedError", () => new ProvisionRefusedError("provision-refused", "msg", "fix it"), "provision-refused"],
  ["TeardownError", () => new TeardownError("teardown-failed", "msg", "fix it"), "teardown-failed"],
  ["HarvestError", () => new HarvestError("harvest-failed", "msg", "fix it"), "harvest-failed"],
  ["SweepError", () => new SweepError("list-unverified", "msg", "fix it"), "list-unverified"],
  ["QuotaLimitsError", () => new QuotaLimitsError("quota-limits-invalid", "msg", "fix it"), "quota-limits-invalid"],
  ["ExeDevDriverError", () => new ExeDevDriverError("exec-timeout-invalid", "msg", "fix it"), "exec-timeout-invalid"],
  ["VizError", () => new VizError("VIZ_PORT_PUBLIC", "msg", "fix it"), "VIZ_PORT_PUBLIC"],
  ["FakeDriverError", () => new FakeDriverError("fake-box-missing", "msg", "fix it"), "fake-box-missing"],
  [
    "OverBudgetError",
    () => new OverBudgetError({ capMicroUsd: 1, spentMicroUsd: 2, reservedMicroUsd: 0, unpricedRows: 0 }),
    "over-budget",
  ],
];

describe("ProviderError base (F041)", () => {
  test.each(CASES)("%s carries code and remediation and keeps its own name", (name, make, code) => {
    const e = make();
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe(name);
    expect(e.name).not.toBe("ProviderError");
    expect(e.code).toBe(code);
    expect(typeof e.remediation).toBe("string");
    expect(e.remediation.length).toBeGreaterThan(0);
    // The per-class `instanceof` every consumer already branches on.
    expect(e.constructor.name).toBe(name);
  });

  test("the subclass's own instanceof still discriminates", () => {
    expect(new TeardownError("a", "b", "c")).not.toBeInstanceOf(CostLedgerError);
    expect(new CostLedgerError("a", "b", "c")).not.toBeInstanceOf(TeardownError);
  });

  test("subclass-specific fields survive the reparent", () => {
    expect(new HarvestError("c", "m", "r", { noSuchBox: true }).noSuchBox).toBe(true);
    expect(new HarvestError("c", "m", "r").noSuchBox).toBe(false);
    const over = new OverBudgetError({ capMicroUsd: 7, spentMicroUsd: 9, reservedMicroUsd: 1, unpricedRows: 2 });
    expect(over.status).toBe("over-budget");
    expect(over.reason).toBe("spend-cap-exceeded");
    expect(over.capMicroUsd).toBe(7);
    expect(over.spentMicroUsd).toBe(9);
    expect(over.reservedMicroUsd).toBe(1);
    expect(over.unpricedRows).toBe(2);
  });

  test("a plain Error is NOT a ProviderError — the foreign-error fallbacks still matter", () => {
    expect(new Error("nope")).not.toBeInstanceOf(ProviderError);
    expect(Object.assign(new Error("enoent"), { code: "ENOENT" })).not.toBeInstanceOf(ProviderError);
  });
});
