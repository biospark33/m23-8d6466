/**
 * Cross-process VM-headroom intent tests (Q1.5) — TDD RED phase.
 *
 * G5: the VM-ceiling guard counted only what ONE process's driver listing
 * could see, so two CLI processes dispatching concurrently could both pass a
 * ceiling they each sampled before either box existed (dispatch.ts's own
 * documented open half). The fix is a durable INTENT record at the quota
 * layer: each dispatch claims one O_EXCL file BEFORE its headroom read, and a
 * concurrent `checkHeadroom` counts outstanding intents as live VMs until the
 * box appears (the claim released) or the intent ages out (a crashed writer).
 *
 * Coverage:
 * - claim → counted; release → not counted
 * - the SAME requestId cannot claim twice (the O_EXCL is the arbiter)
 * - an intent older than the TTL is stale: not counted, swept best-effort
 * - checkHeadroom counts intents: a full ceiling with one outstanding intent
 *   refuses the next dispatch (vm-ceiling), cross-process by construction
 * - corrupt intent files are skipped (never counted, never fatal)
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";

// RED: src/providers/quota-intents.ts does not exist yet — this import is the first failure.
import { claimQuotaIntent, releaseQuotaIntent, countQuotaIntents, QUOTA_INTENT_TTL_MS } from "../../src/providers/quota-intents.ts";
// The checkHeadroom intents wiring rides the same change.
import { checkHeadroom } from "../../src/providers/quota.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "q1-quota-intents-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let intentsDir: string;

const REQ_A = "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5";
const REQ_B = "6f6b4d9f-2a3c-4d4e-8b9f-81d2e3f4a5b6";

function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}

beforeEach(() => {
  intentsDir = join(realpathSync(mkdtempSync(join(tmpRoot, "q-"))), "quota-intents");
});

describe("quota intents (Q1.5 cross-process headroom)", () => {
  test("claim → counted; release → not counted; the file lands under the dir", () => {
    expect(countQuotaIntents(intentsDir)).toBe(0);
    expect(claimQuotaIntent(intentsDir, REQ_A)).toBe(true);
    expect(countQuotaIntents(intentsDir)).toBe(1);
    expect(existsSync(join(intentsDir, `${REQ_A}.json`))).toBe(true);
    releaseQuotaIntent(intentsDir, REQ_A);
    expect(countQuotaIntents(intentsDir)).toBe(0);
  });

  test("the SAME requestId cannot claim twice — the O_EXCL is the arbiter", () => {
    expect(claimQuotaIntent(intentsDir, REQ_A)).toBe(true);
    expect(claimQuotaIntent(intentsDir, REQ_A)).toBe(false);
    expect(countQuotaIntents(intentsDir)).toBe(1);
    // Releasing a claim you do not hold is a no-op, never an error.
    releaseQuotaIntent(intentsDir, REQ_B);
    expect(countQuotaIntents(intentsDir)).toBe(1);
  });

  test("an intent older than the TTL is stale: not counted, swept on read", () => {
    expect(claimQuotaIntent(intentsDir, REQ_A, { now: () => 0 })).toBe(true);
    // Just under the TTL: still counted.
    expect(countQuotaIntents(intentsDir, { now: () => QUOTA_INTENT_TTL_MS - 1 })).toBe(1);
    // At/after the TTL: stale. The count reads 0 and the file is swept.
    expect(countQuotaIntents(intentsDir, { now: () => QUOTA_INTENT_TTL_MS })).toBe(0);
    expect(existsSync(join(intentsDir, `${REQ_A}.json`))).toBe(false);
  });

  test("checkHeadroom counts outstanding intents as live VMs — the ceiling closes cross-process", async () => {
    const driver = new FakeDriver(join(tmpRoot, "boxes"));
    // Ceiling 1, empty listing: a lone dispatch admits.
    const alone = await checkHeadroom(driver, 1, limitsWith({ maxVms: 1 }), 5_000, { dir: intentsDir });
    expect(alone.allowed).toBe(true);
    // One outstanding intent from ANOTHER process: the next dispatch refuses.
    expect(claimQuotaIntent(intentsDir, REQ_A)).toBe(true);
    const contested = await checkHeadroom(driver, 1, limitsWith({ maxVms: 1 }), 5_000, { dir: intentsDir });
    expect(contested.allowed).toBe(false);
    expect(contested.reason).toBe("vm-ceiling");
    expect(contested.liveVms).toBe(1);
    // Released: headroom is back.
    releaseQuotaIntent(intentsDir, REQ_A);
    const after = await checkHeadroom(driver, 1, limitsWith({ maxVms: 1 }), 5_000, { dir: intentsDir });
    expect(after.allowed).toBe(true);
  });

  test("a corrupt intent file is skipped — never counted, never fatal", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(intentsDir, { recursive: true });
    writeFileSync(join(intentsDir, `${REQ_A}.json`), "{not json");
    expect(countQuotaIntents(intentsDir)).toBe(0);
  });

  test("an absent intents dir counts zero (a fresh checkout dispatches)", () => {
    expect(countQuotaIntents(join(intentsDir, "does-not-exist"))).toBe(0);
  });
});
