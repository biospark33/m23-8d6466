/**
 * Z3 AC1–AC7 — fixture tier (no network, no spend). The REAL leg drivers run
 * over an in-memory substrate (tests/z3/fixture.ts) and write through the
 * REAL writer; the round verdict is re-derived from the files on disk.
 *
 * Every AC has a positive control (the green fixture round passes it) and at
 * least one `AC<n> negative control:` test demonstrating the assertion FAILS
 * on bad evidence — either a misbehaving substrate dep (the drivers record
 * what really happened) or an edited/copied/forged file (the evidence lies).
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  assertAc1RoundComplete,
  assertAc2ApproveRecorded,
  assertAc3ExactlyOneBox,
  assertAc4CrashWindow,
  assertAc5HostSideRetain,
  assertAc6ObserveReadOnly,
  assertAc7LiveRules,
  assertZ3Round,
  type LegFile,
  registryFromManifest,
} from "../../scripts/z3/assertions.ts";
import { dashStamp } from "../../scripts/z3/evidence.ts";
import { Z3_LEGS } from "../../scripts/z3/round-plan.ts";
import { CODE_RUN_ID, cleanupFixture, driveFixtureRound, dropLeg, editLeg, type FixtureRound, qaRunId, REV } from "./fixture.ts";

const rounds: FixtureRound[] = [];
afterEach(() => {
  for (const r of rounds.splice(0)) cleanupFixture(r);
});
async function round(overrides: Parameters<typeof driveFixtureRound>[0] = {}, opts: Parameters<typeof driveFixtureRound>[1] = {}): Promise<FixtureRound> {
  const r = await driveFixtureRound(overrides, opts);
  rounds.push(r);
  return r;
}
const some = (problems: string[], re: RegExp) => expect(problems.some((p) => re.test(p))).toBe(true);

describe("positive control: a green fixture round", () => {
  test("drives all 11 legs + cleanup and passes every AC", async () => {
    const r = await round();
    expect(r.outcome.failure).toBeUndefined();
    expect(r.outcome.cleanupProblems).toEqual([]);
    const legs = new Set(r.files.map((f) => f.name.replace(/^.*-z3-/, "").replace(/\.json$/, "")));
    for (const leg of Z3_LEGS) expect(legs.has(leg)).toBe(true);
    expect(legs.has("cleanup")).toBe(true);
    expect(assertZ3Round(r.files, { forkRev: REV, registry: r.registry })).toEqual([]);
    expect(r.world.calls.killed).toBe(1);
    expect(r.world.calls.restarted).toBe(1);
    expect(r.outcome.runIds).toEqual([qaRunId(0), qaRunId(1), qaRunId(2), CODE_RUN_ID]);
  });
});

describe("AC1 — every leg present, each written by its own driver", () => {
  test("AC1 negative control: a missing leg fails", async () => {
    const r = await round();
    some(assertAc1RoundComplete(dropLeg(r.files, "priming-recall"), { forkRev: REV, registry: null }), /leg priming-recall is missing/);
  });

  test("AC1 negative control: a leg JSON hand-copied under another leg's name fails", async () => {
    const r = await round();
    const src = r.files.find((f) => f.name.endsWith("-z3-approve.json")) as LegFile;
    const forged = { name: src.name.replace("-z3-approve.json", "-z3-approval-park.json"), text: src.text };
    const files = [...dropLeg(r.files, "approval-park"), forged];
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: null }), /copied file/);
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: r.registry }), /not what the leg driver wrote/);
  });

  test("AC1 negative control: evidence re-stamped to a later instant (reconstructed post-hoc) fails", async () => {
    const r = await round();
    const src = r.files.find((f) => f.name.endsWith("-z3-trigger.json")) as LegFile;
    const later = dashStamp(new Date("2026-10-20T09:00:00.000Z"));
    const files = [...dropLeg(r.files, "trigger"), { name: `${later}-z3-trigger.json`, text: src.text }];
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: null }), /disagrees with the filename stamp/);
  });

  test("AC1 negative control: a file written by another script (origin) fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "box-forensics", (j) => {
      j.origin = ".unlazy/z3/post-hoc.ts";
    });
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: null }), /not written by its own driver/);
  });

  test("AC1 negative control: bytes edited after the driver wrote them fail the registry check", async () => {
    const r = await round();
    const files = editLeg(r.files, "kill-and-provision", (j) => {
      j.boxCountSamples = [1, 1];
      j.stdoutTail = "re-run by hand";
    });
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: r.registry }), /not what the leg driver wrote/);
  });

  test("AC1 negative control: a red leg, a foreign fork rev, or an open priming round-trip fails the arc", async () => {
    const r = await round();
    some(assertAc1RoundComplete(r.files, { forkRev: "fedcba9", registry: null }), /≠ round rev/);
    const red = await round({ readRecall: () => ({ directive: "kg_context", recalledDocumentIds: ["qds-20261019-ffffff"] }) });
    some(assertAc1RoundComplete(red.files, { forkRev: REV, registry: null }), /priming round-trip open/);
    some(assertAc1RoundComplete(red.files, { forkRev: REV, registry: null }), /exitCode 1/);
  });
});

describe("AC1 — fork contract: one fire's workId stamp, the approved branch case", () => {
  test("AC1 negative control: a fleet run whose workId carries another fire's stamp fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "kill-and-provision", (j) => {
      j.workId = "w:qa-20261018T090000Z-correctness";
    });
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: null }), /not this fire's w:qa-20261019T120000Z-correctness/);
  });

  test("AC1 negative control: a branch that took the 'completed' case (no human decision witnessed) fails", async () => {
    const r = await round({
      awaitProtocolComplete: async () => ({
        runStatus: "completed",
        artifacts: [],
        events: [{ type: "branch_taken", stepId: "z3-branch", data: { caseId: "completed" } }],
      }),
    });
    some(assertAc1RoundComplete(r.files, { forkRev: REV, registry: null }), /took case completed, not approved/);
  });

  test("a rejected code run fails the protocol before the branch — the round is red, not green", async () => {
    const r = await round({
      awaitProtocolComplete: async () => ({ runStatus: "failed", artifacts: [], events: [] }),
    });
    expect(r.outcome.failure).toBeDefined();
    const problems = assertAc1RoundComplete(r.files, { forkRev: REV, registry: null });
    some(problems, /protocol run ended failed/);
    some(problems, /no branch_taken witness/);
  });
});

describe("AC2 — auto-approve fails", () => {
  test("positive control: the scripted approve is labeled, scrypt-verified, stdin, between park and branch", async () => {
    const r = await round();
    expect(assertAc2ApproveRecorded(r.files)).toEqual([]);
  });

  test("AC2 negative control: a round that proceeds past the park without a recorded decision fails", async () => {
    const r = await round();
    some(assertAc2ApproveRecorded(dropLeg(r.files, "approve")), /proceeded past the park undecided/);
  });

  test("AC2 negative control: treating ADR-2 as license to auto-merge while ON is unreachable (no veto-window carrier) fails", async () => {
    const r = await round();
    const policy = editLeg(r.files, "approve", (j) => {
      j.decisionSource = "adr-2-proposed-auto-merge";
    });
    some(assertAc2ApproveRecorded(policy), /ON is structurally unreachable \(the clause-5 veto-window carrier `enqueueVetoWindow` is not in the tree\)/);
    const merged = await round({
      awaitProtocolComplete: async () => ({
        runStatus: "completed",
        artifacts: [],
        events: [{ type: "branch_taken", stepId: "z3-branch" }, { type: "auto_merged" }],
      }),
    });
    some(assertAc2ApproveRecorded(merged.files), /license to auto-merge/);
  });

  test("AC2 negative control: a driver-executed approve without scripted:true, or unverified, fails", async () => {
    const r = await round();
    some(
      assertAc2ApproveRecorded(
        editLeg(r.files, "approve", (j) => {
          j.scripted = false;
        }),
      ),
      /not labeled scripted: true/,
    );
    const unverified = await round({
      approve: async () => ({ exitCode: 3, stdout: "", stderr: "refused", approverId: "z3-e2e-approver", tokenChannel: "stdin" }),
    });
    expect(unverified.outcome.failure).toBeDefined();
    some(assertAc2ApproveRecorded(unverified.files), /not scrypt-verified/);
  });
});

describe("AC3 — exactly one box per fleet run", () => {
  test("positive control", async () => {
    expect(assertAc3ExactlyOneBox((await round()).files)).toEqual([]);
  });

  test("AC3 negative control: two live boxes for one runId fail", async () => {
    let n = 0;
    const r = await round({
      inventory: async () => (n++ === 2 ? [qaRunId(0), qaRunId(0)] : []),
    });
    expect(r.outcome.failure).toBeDefined();
    some(assertAc3ExactlyOneBox(r.files), /did not HOLD/);
  });

  test("AC3 negative control: an unproven box count (no forensics leg) fails", async () => {
    const r = await round();
    some(assertAc3ExactlyOneBox(dropLeg(r.files, "box-forensics")), /box count is unproven/);
  });

  test("AC3 negative control: a box that outlived teardown fails", async () => {
    const r = await round();
    some(
      assertAc3ExactlyOneBox(
        editLeg(r.files, "box-forensics", (j) => {
          j.afterTeardownBoxesForRun = [String(j.runId)];
        }),
      ),
      /teardown did not reap/,
    );
  });

  test("AC3 negative control: a run provisioned while an earlier run's box was live (not sequential) fails", async () => {
    const r = await round();
    some(
      assertAc3ExactlyOneBox(
        editLeg(
          r.files,
          "kill-and-provision",
          (j) => {
            j.inventoryBefore = [qaRunId(0)];
          },
          1,
        ),
      ),
      /not sequential/,
    );
  });
});

describe("AC4 — crash-window idempotency", () => {
  test("positive control", async () => {
    expect(assertAc4CrashWindow((await round()).files)).toEqual([]);
  });

  test("AC4 negative control: a re-drive that provisions a second box for the runId fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.boxCountSamples = [1, 2, 0];
        }),
      ),
      /second box/,
    );
  });

  test("AC4 negative control: a re-drive whose ledger shows two bookings for the runId fails", async () => {
    const r = await round({ ledgerBookings: () => ({ gateAdmissions: 2, groupReservations: 1 }) });
    expect(r.outcome.failure).toBeDefined();
    some(assertAc4CrashWindow(r.files), /double-booked/);
  });

  test("AC4 negative control: a re-drive that recreates the run record fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.recordsForRequestId = [
            { runId: CODE_RUN_ID, createdAt: "2026-10-19T12:00:01.000Z" },
            { runId: "qds-20261019-c0de02", createdAt: "2026-10-19T12:05:00.000Z" },
          ];
        }),
      ),
      /recreated the run record/,
    );
  });

  test("AC4 negative control: a re-drive that mutates the surviving run record fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.recordAtKill = { state: "present", runId: CODE_RUN_ID, createdAt: "2026-10-19T11:59:00.000Z" };
        }),
      ),
      /mutated or recreated/,
    );
  });
});

describe("AC5 — in-box retain fails", () => {
  test("positive control", async () => {
    expect(assertAc5HostSideRetain((await round()).files)).toEqual([]);
  });

  test("AC5 negative control: findings retained from inside a box fail", async () => {
    const r = await round({
      retainFindings: async () => ({
        bank: "qds-factory",
        documentIds: ["qds-20261019-d0c001"],
        traces: [{ side: "box", documentId: "qds-20261019-d0c001" }],
      }),
    });
    some(assertAc5HostSideRetain(r.files), /retained from inside a box/);
  });

  test("AC5 negative control: a write credential issued into the box fails", async () => {
    const r = await round({
      memoryKeys: () => [{ tokenId: "mgrunid-w", kind: "per-run", runId: qaRunId(0), verbs: ["recall", "retain"] }],
    });
    some(assertAc5HostSideRetain(r.files), /write credential existed in the box/);
  });

  test("AC5 negative control: a gateway assertion with no agent-token id or a trap origin fails", async () => {
    const r = await round({ gatewayAssert: async () => ({ origin: "http://127.0.0.1:8888", agentTokenId: "" }) });
    const problems = assertAc5HostSideRetain(r.files);
    some(problems, /trap port/);
    some(problems, /no M2.1 agent-token id/);
  });
});

describe("AC6 — observe consumes Z1's read-only surface", () => {
  test("positive control", async () => {
    expect(assertAc6ObserveReadOnly((await round()).files)).toEqual([]);
  });

  test("AC6 negative control: an observe leg that provisions a box fails", async () => {
    const r = await round();
    some(
      assertAc6ObserveReadOnly(
        editLeg(r.files, "observe-read-only", (j) => {
          j.boxesProvisioned = ["qds-20261019-0b5e01"];
        }),
      ),
      /provisioned a box/,
    );
  });

  test("AC6 negative control: an observe leg that mints a provider or memory key fails", async () => {
    let calls = 0;
    const r = await round({ providerKeyHashes: async () => (calls++ >= 1 ? ["hash-preexisting", "hash-minted"] : ["hash-preexisting"]) });
    some(assertAc6ObserveReadOnly(r.files), /minted a provider key/);
    const r2 = await round();
    some(
      assertAc6ObserveReadOnly(
        editLeg(r2.files, "qa-run-observe", (j) => {
          j.memoryKeysMinted = ["mgat-0000"];
        }),
      ),
      /minted a memory key/,
    );
  });

  test("AC6 negative control: an observe leg that is not a factory_observe step (or unmeasured) fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "qa-run-observe", (j) => {
      j.stepKind = "external_job";
      j.boxesProvisioned = undefined; // JSON.stringify drops it: the field is absent on disk
    });
    some(assertAc6ObserveReadOnly(files), /not factory_observe/);
    some(assertAc6ObserveReadOnly(files), /boxesProvisioned unmeasured/);
  });
});

describe("AC7 — live rules hold", () => {
  test("positive control: green round, and a FAILED round whose finally still revoke-verified and destroyed", async () => {
    expect(assertAc7LiveRules((await round()).files)).toEqual([]);
    const failed = await round({ readRecall: () => null });
    expect(failed.outcome.failure).toBeDefined();
    expect(assertAc7LiveRules(failed.files, { roundFailed: true })).toEqual([]);
    expect(failed.world.calls.revoked).toEqual([[qaRunId(0), qaRunId(1), qaRunId(2), CODE_RUN_ID]]);
    expect(failed.world.calls.destroyed).toEqual([[qaRunId(0), qaRunId(1), qaRunId(2), CODE_RUN_ID]]);
  });

  test("AC7 negative control: an evidence file containing a live credential fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "approve", (j) => {
      j.stdoutTail = "Authorization: Bearer sk-or-v1-0123456789abcdef";
    });
    some(assertAc7LiveRules(files), /live credential in evidence/);
    const url = editLeg(r.files, "trigger", (j) => {
      j.note = "cloned https://bot:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.com/x.git";
    });
    some(assertAc7LiveRules(url), /live credential in evidence/);
  });

  test("AC7 negative control: a finally that skips revoke-verify on the failure path fails", async () => {
    const r = await round({
      readRecall: () => null,
      revokeVerify: async () => {
        throw new Error("provider listing down");
      },
    });
    expect(r.outcome.failure).toBeDefined();
    some(r.outcome.cleanupProblems, /revoke-verify FAILED/);
    some(assertAc7LiveRules(r.files, { roundFailed: true }), /skipped revoke-verify on the failure path/);
  });

  test("AC7 negative control: no cleanup record, or a cleanup that does not record the failure path, fails", async () => {
    const r = await round();
    some(assertAc7LiveRules(dropLeg(r.files, "cleanup")), /no cleanup record/);
    some(assertAc7LiveRules(r.files, { roundFailed: true }), /did not record the failure path/);
  });

  test("AC7 negative control: a box that outlived the round fails", async () => {
    const r = await round({ destroyBoxes: async () => ({ receipts: [], problems: [] }), readRecall: () => null });
    // the code run's box is reaped only by the park, which a failed priming never reached
    some(assertAc7LiveRules(r.files, { roundFailed: true }), /outlived the round/);
  });
});

describe("round sequencing", () => {
  test("a leg failing mid-round still tracks the run it already submitted, so cleanup cancels it", async () => {
    let n = 0;
    const r = await round({ inventory: async () => (n++ === 2 ? [qaRunId(0), qaRunId(0)] : []) });
    expect(r.world.calls.destroyed).toEqual([[qaRunId(0)]]);
    expect(r.files.some((f) => f.name.endsWith("-z3-cleanup.json"))).toBe(true);
  });
});

describe("R1 — provenance survives the round (A-6, B-11)", () => {
  test("positive control: the committed round manifest rebuilds the registry for a later audit", async () => {
    const r = await round();
    const rebuilt = registryFromManifest(r.files);
    expect(rebuilt).not.toBeNull();
    expect(assertAc1RoundComplete(r.files, { forkRev: REV, registry: rebuilt })).toEqual([]);
  });

  test("AC1 negative control: no registry or manifest leaves provenance unproven", async () => {
    const r = await round();
    some(assertAc1RoundComplete(dropLeg(r.files, "round-manifest"), { forkRev: REV, registry: registryFromManifest(dropLeg(r.files, "round-manifest")) }), /provenance is unproven/);
  });

  test("AC1 negative control: a registered leg file deleted from the evidence fails", async () => {
    const r = await round();
    const victim = r.files.find((f) => f.name.endsWith("-z3-kill-and-provision.json")) as LegFile;
    const files = r.files.filter((f) => f !== victim);
    some(assertAc1RoundComplete(files, { forkRev: REV, registry: r.registry }), /registered by the writer but missing/);
  });

  test("AC1 negative control: a leg present fewer times than the round shape implies fails", async () => {
    const r = await round();
    const firstObserve = r.files.find((f) => f.name.endsWith("-z3-qa-run-observe.json")) as LegFile;
    some(assertAc1RoundComplete(r.files.filter((f) => f !== firstObserve), { forkRev: REV, registry: null }), /qa-run-observe appears 2×/);
  });
});

describe("R1 — re-derived verdicts (B-21, B-26, B-5, B-6, A-9, B-8)", () => {
  test("AC2 negative control: a forged scryptVerified flag over a CLI line that never decided fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "approve", (j) => {
      j.scryptVerified = true;
      j.stdoutTail = `${JSON.stringify({ outcome: "refused", state: "awaiting-approval" })}\n`;
    });
    some(assertAc2ApproveRecorded(files), /not scrypt-verified/);
  });

  test("AC2 negative control: an unreadable writtenAt cannot satisfy the decision order", async () => {
    const r = await round();
    some(
      assertAc2ApproveRecorded(
        editLeg(r.files, "branch-and-complete", (j) => {
          j.writtenAt = "not-a-date";
        }),
      ),
      /decision order is unproven/,
    );
  });

  test("AC3 negative control: a box seen once then gone inside the stability window fails", async () => {
    const r = await round();
    some(
      assertAc3ExactlyOneBox(
        editLeg(r.files, "kill-and-provision", (j) => {
          j.boxCountSamples = [1, 0];
        }),
      ),
      /did not HOLD/,
    );
  });

  test("AC4 negative control: a re-drive with no ledger booking (spend escaped the ledger) fails", async () => {
    const r = await round({ ledgerBookings: () => ({ gateAdmissions: 0, groupReservations: 0 }) });
    some(assertAc4CrashWindow(r.files), /spend escaped the ledger/);
  });

  test("AC7 negative control: a revoke-verify receipt reporting a leak fails AC7 itself", async () => {
    const r = await round({
      revokeVerify: async () => ({ receipts: [{ phase: "key-hash-delta", ok: false, leaked: ["h1"] }], problems: [] }),
    });
    some(assertAc7LiveRules(r.files), /revoke-verify reported a leak/);
  });

  test("AC7 negative control: a failed box destroy receipt fails", async () => {
    const r = await round({
      destroyBoxes: async (runIds) => ({ receipts: runIds.map((runId) => ({ runId, exitCode: 1 })), problems: [] }),
    });
    some(assertAc7LiveRules(r.files), /box destroy for .* exited 1/);
  });
});

describe("R1 — the crash window is a witnessed window, not a vacuous pass (B-3, B-4, E-16, A-4)", () => {
  test("positive control: the watcher armed at round start kills inside `submitting`, with an explicit record witness", async () => {
    const r = await round();
    const j = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-crash-window-redrive.json")) as LegFile).text);
    expect(j.stepStatusAtKill).toBe("submitting");
    expect(j.recordAtKill).toEqual({ state: "absent" });
    expect(r.world.calls.killed).toBe(1);
  });

  test("AC4 negative control: a kill outside the submit window fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.stepStatusAtKill = "submitted";
        }),
      ),
      /not inside the submit window/,
    );
  });

  test("AC4 negative control: a missing record-at-kill witness fails (never a vacuous pass)", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.recordAtKill = undefined;
        }),
      ),
      /record-at-kill witness/,
    );
  });

  test("AC4 negative control: a re-drive that recreates the record seen at the kill fails on the DRIVER path", async () => {
    let killed = false;
    const r = await round({
      killFork: async () => {
        killed = true;
      },
      recordsForRequestId: (requestId) => {
        if (requestId !== "req-z3-code-run") {
          // the QA legs' records stay attributable (observe attribution reads them by requestId)
          const i = ["correctness", "secret-hygiene", "diff-scope"].findIndex((l) => requestId === `req-qa-leg-${l}`);
          return i < 0 ? [] : [{ runId: qaRunId(i), createdAt: "2026-10-19T12:00:01.000Z", requestId, vmName: qaRunId(i), keyHash: `key-${qaRunId(i)}` }];
        }
        // at the kill: the record exists; after the re-drive: a different createdAt (recreated)
        return [{ runId: CODE_RUN_ID, createdAt: killed ? "2026-10-19T12:09:00.000Z" : "2026-10-19T12:00:01.000Z", requestId }];
      },
    });
    expect(r.outcome.failure).toBeDefined();
    some(assertAc4CrashWindow(r.files), /mutated or recreated/);
  });

  test("a round that fails before the code run stands the watcher down — no late kill", async () => {
    const r = await round({ retainFindings: async () => Promise.reject(new Error("bank down")) });
    expect(r.outcome.failure).toBeDefined();
    expect(r.world.calls.killed).toBe(0);
  });
});

describe("R1 — observe/retain never false-red a correct round (A-3, E-3, E-4, E-18)", () => {
  test("positive control: the next leg's box, provider key and recall key exist before observe reads — attributed, not charged", async () => {
    const r = await round();
    expect(assertAc6ObserveReadOnly(r.files)).toEqual([]);
    const first = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-qa-run-observe.json")) as LegFile).text);
    expect(first.attributedToRuns).toContain(qaRunId(1));
    const retain = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-findings-retain.json")) as LegFile).text);
    expect(retain.runMemoryKeys).toEqual([{ tokenId: `mgrunid-${qaRunId(0)}`, verbs: ["recall"] }]);
    expect(retain.boxWriteCredentials).toEqual([]);
  });

  test("AC6 negative control: a fresh box no run of the protocol claims stays charged (fail-closed)", async () => {
    const r = await round({ protocolFleet: async () => ({ runIds: [], requestIds: [], submitting: [] }) });
    some(assertAc6ObserveReadOnly(r.files), /provisioned a box/);
  });

  test("AC6 negative control: an observe leg that targets another run fails", async () => {
    const r = await round();
    some(
      assertAc6ObserveReadOnly(
        editLeg(r.files, "qa-run-observe", (j) => {
          j.observedRunId = qaRunId(2);
        }),
      ),
      /observes .* not qa-leg-correctness's run/,
    );
  });
});

describe("R1 — the GO gates the fork's own caps; cleanup stops the fork first (A-2, B-2, B-1, E-5, A-12)", () => {
  test("AC7 negative control: a fired run whose caps differ from the GO-gated worst case fails", async () => {
    const r = await round({
      awaitTrigger: async () => ({
        protocolRunId: "pr-z3-1",
        scheduleId: "sch-z3",
        templateId: "z3_exit_round",
        firedAt: "2026-10-19T12:00:00.000Z",
        stepCaps: [...["correctness", "secret-hygiene", "diff-scope"].map((l) => ({ stepId: `qa-leg-${l}`, groupCapUsd: 25 })), { stepId: "z3-code-run", groupCapUsd: 40 }],
        forkRev: REV,
      }),
    });
    expect(r.outcome.failure).toBeDefined();
    some(assertAc7LiveRules(r.files, { roundFailed: true }), /not the GO-gated worst case/);
    expect(r.world.calls.cancelled).toEqual(["pr-z3-1"]);
  });

  test("a fork reporting another rev than the round stamps fails the trigger", async () => {
    const r = await round({
      awaitTrigger: async () => ({
        protocolRunId: "pr-z3-1",
        scheduleId: "sch-z3",
        templateId: "z3_exit_round",
        firedAt: "2026-10-19T12:00:00.000Z",
        stepCaps: [...["correctness", "secret-hygiene", "diff-scope"].map((l) => ({ stepId: `qa-leg-${l}`, groupCapUsd: 6 })), { stepId: "z3-code-run", groupCapUsd: 8 }],
        forkRev: "fedcba9876543210fedcba9876543210fedcba98",
      }),
    });
    expect(String(r.outcome.failure)).toContain("the running fork reports rev");
  });

  test("a mid-round failure cancels the fork protocol run, then sweeps runs the driver never tracked", async () => {
    // fails at leg 0's observe — the fork has ALREADY provisioned leg 1 (running ahead)
    const r = await round({ protocolFleet: async () => ({ runIds: [qaRunId(0), qaRunId(1)], requestIds: [], submitting: [] }), memoryKeys: () => [{ tokenId: "mgat-x", kind: "agent", runId: null, verbs: ["recall"] }] });
    expect(r.outcome.failure).toBeDefined();
    expect(r.world.calls.cancelled).toEqual(["pr-z3-1"]);
    expect(r.world.calls.destroyed[0]).toEqual([qaRunId(0), qaRunId(1)]);
    expect(r.world.boxes.has(qaRunId(1))).toBe(false);
  });
});

describe("R1 — scrub before truncate (B-9)", () => {
  test("a key straddling the tail cut never lands as a bare key body", async () => {
    const body = "q9w8e7r6t5y4u3i2".repeat(4); // shares no substring with the fixture rev
    const r = await round({
      approve: async (runId) => ({
        exitCode: 0,
        stdout: `${JSON.stringify({ runId, outcome: "decided", state: "approved", approverId: "z3-e2e-approver" })}\n`,
        stderr: `Authorization: Bearer sk-or-v1-${body}${"y".repeat(560)}`,
        approverId: "z3-e2e-approver",
        tokenChannel: "stdin",
      }),
    });
    const approve = (r.files.find((f) => f.name.endsWith("-z3-approve.json")) as LegFile).text;
    expect(approve).not.toContain(body.slice(-24));
  });
});

describe("R1 fork delta — the gate-held crash window and the unmatched case", () => {
  test("positive control: the wrapper held the code submit at the kill, and exactly one exec ran across kill + replay", async () => {
    const r = await round();
    const j = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-crash-window-redrive.json")) as LegFile).text);
    expect(j.heldAtKill).toBe(true);
    expect(j.submitExecs).toBe(1);
    expect(r.world.gate.journal.map((l) => l.phase)).toEqual(["held", "released", "exec"]);
    expect(r.world.gate.aborted).toBe(true); // the finally aborts the gate on every path
  });

  test("AC4 negative control: a kill with no held submit in the wrapper journal fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.heldAtKill = false;
        }),
      ),
      /no held-submit witness/,
    );
  });

  test("AC4 negative control: two fleet-submit execs across the kill + replay fail", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.submitExecs = 2;
        }),
      ),
      /2 fleet-submit execs/,
    );
  });

  test("AC1 negative control: a branch that fell through to the 'unmatched' catch-all fails", async () => {
    const r = await round({
      awaitProtocolComplete: async () => ({
        runStatus: "failed",
        artifacts: [],
        events: [{ type: "branch_taken", stepId: "z3-branch", data: { caseId: "unmatched" } }],
      }),
    });
    some(assertAc1RoundComplete(r.files, { forkRev: REV, registry: null }), /took case unmatched, not approved/);
  });

  test("a fork image label carrying a short form of the stamped rev matches (prefix, not equality)", async () => {
    const r = await round({
      awaitTrigger: async () => ({
        protocolRunId: "pr-z3-1",
        scheduleId: "sch-z3",
        templateId: "z3_exit_round",
        firedAt: "2026-10-19T12:00:00.000Z",
        stepCaps: [...["correctness", "secret-hygiene", "diff-scope"].map((l) => ({ stepId: `qa-leg-${l}`, groupCapUsd: 6 })), { stepId: "z3-code-run", groupCapUsd: 8 }],
        forkRev: REV.slice(0, 12),
      }),
    });
    expect(r.outcome.failure).toBeUndefined();
  });
});

describe("fork rev verification is labelled, never a silent null", () => {
  test("an image with no revision label records 'unverifiable-from-image' and passes; an unlabelled record fails AC7", async () => {
    const r = await round({
      awaitTrigger: async () => ({
        protocolRunId: "pr-z3-1",
        scheduleId: "sch-z3",
        templateId: "z3_exit_round",
        firedAt: "2026-10-19T12:00:00.000Z",
        stepCaps: [...["correctness", "secret-hygiene", "diff-scope"].map((l) => ({ stepId: `qa-leg-${l}`, groupCapUsd: 6 })), { stepId: "z3-code-run", groupCapUsd: 8 }],
        forkRev: null,
      }),
    });
    expect(r.outcome.failure).toBeUndefined();
    const trigger = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-trigger.json")) as LegFile).text);
    expect(trigger.forkRevVerification).toBe("unverifiable-from-image");
    expect(assertAc7LiveRules(r.files)).toEqual([]);
    some(
      assertAc7LiveRules(
        editLeg(r.files, "trigger", (j) => {
          j.forkRevVerification = undefined;
        }),
      ),
      /verification status is unrecorded/,
    );
  });
});

describe("R2 — attribution inside the next leg's submitting window (A-2, B-3, E-5, B-11)", () => {
  test("positive control: the fork-ahead leg's box/key exist BEFORE its record or runId — the observe waits for the ack, not a false red", async () => {
    const r = await round({}, { recordLag: true });
    expect(r.outcome.failure).toBeUndefined();
    expect(assertAc6ObserveReadOnly(r.files)).toEqual([]);
    const first = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-qa-run-observe.json")) as LegFile).text);
    expect(first.settlePolls).toBeGreaterThan(0);
  });

  test("AC6 negative control: a fresh box still unattributable once no sibling is submitting stays charged", async () => {
    const r = await round({ protocolFleet: async () => ({ runIds: [], requestIds: [], submitting: [] }) }, { recordLag: true });
    some(assertAc6ObserveReadOnly(r.files), /provisioned a box/);
  });

  test("AC7 negative control: a fresh box no run of the round claims after cleanup fails — never an excuse", async () => {
    const r = await round({ readRecall: () => null });
    const files = editLeg(r.files, "cleanup", (j) => {
      j.unattributedFreshBoxes = ["qds-20261019-0rph4n"];
    });
    some(assertAc7LiveRules(files, { roundFailed: true }), /no run of this round claims/);
  });

  test("cleanup charges a stray fresh box as a problem", async () => {
    let n = 0;
    const r = await round({ readRecall: () => null, inventory: async () => (n++ === 0 ? [] : ["stray-box"]) });
    some(r.outcome.cleanupProblems, /no run of this round claims: stray-box/);
  });

  test("AC7 negative control: a fleet run the cleanup never covered fails", async () => {
    const r = await round();
    some(
      assertAc7LiveRules(
        editLeg(r.files, "cleanup", (j) => {
          j.runIds = [];
        }),
      ),
      /cleanup never covered fleet run/,
    );
  });
});

describe("R2 — the crash watcher never kills blind, never releases into a stopped round (B-4, E-3, E-4, A-5, B-5)", () => {
  test("positive control: the gate is released only after the LAST retain — the replay's recall cites every lens", async () => {
    const r = await round();
    const p = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-priming-recall.json")) as LegFile).text);
    expect(p.citedLenses).toEqual(["correctness", "secret-hygiene", "diff-scope"]);
    const c = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-crash-window-redrive.json")) as LegFile).text);
    expect(c.releasedAfterRetain).toBe(true);
  });

  test("AC4 negative control: a release that did not wait for the last retain fails", async () => {
    const r = await round();
    some(
      assertAc4CrashWindow(
        editLeg(r.files, "crash-window-redrive", (j) => {
          j.releasedAfterRetain = false;
        }),
      ),
      /priming witness is a race/,
    );
  });

  test("no held line in the wrapper journal: the gate is aborted and the fork is NEVER killed", async () => {
    const r = await round({
      crashGate: { arm: () => {}, release: () => {}, abort: () => {}, journalFor: () => [] },
    });
    expect(r.outcome.failure).toBeDefined();
    expect(r.world.calls.killed).toBe(0);
  });

  test("a failed kill aborts the gate: no release, no restart", async () => {
    let released = false;
    let aborted = false;
    const r = await round({
      killFork: async () => {
        throw new Error("docker kill: no such container");
      },
      crashGate: {
        arm: () => {},
        release: () => {
          released = true;
        },
        abort: () => {
          aborted = true;
        },
        journalFor: (requestId) => [{ verb: "submit", requestId, workId: "w:z3-s-code", phase: "held", at: Date.now() }],
      },
    });
    expect(String(r.outcome.failure)).toContain("the kill failed");
    expect(released).toBe(false);
    expect(aborted).toBe(true);
    expect(r.world.calls.restarted).toBe(0);
  });

  test("a round that stops between the submitting read and the kill never kills or releases", async () => {
    let released = false;
    const r = await round({
      // the QA tail fails AFTER the code window opened (last lens's retain)
      retainFindings: async (lens) => {
        if (lens === "diff-scope") throw new Error("bank down");
        return { bank: "qds-factory", documentIds: [`qds-20261019-d0c00${lens === "correctness" ? 1 : 2}`], traces: [{ side: "host", documentId: `qds-20261019-d0c00${lens === "correctness" ? 1 : 2}` }] };
      },
      crashGate: {
        arm: () => {},
        release: () => {
          released = true;
        },
        abort: () => {},
        journalFor: (requestId) => [{ verb: "submit", requestId, workId: "w:z3-s-code", phase: "held", at: Date.now() }],
      },
    });
    expect(r.outcome.failure).toBeDefined();
    expect(r.world.calls.killed).toBe(0);
    expect(released).toBe(false);
  });
});

describe("R2 — every path disarms; host traces must cover the retain (E-2, A-6, B-6, B-19)", () => {
  test("cleanup disarms the schedule and cancels what it fired, green or red", async () => {
    const green = await round();
    expect(green.world.calls.disarmed).toBe(2); // the disarm + the end-of-cleanup residue re-check
    const red = await round({ awaitTrigger: async () => Promise.reject(new Error("state drifted")) });
    expect(red.world.calls.disarmed).toBe(2);
    expect(red.world.calls.cancelled).toEqual(["pr-z3-1"]); // the run the disarm named, though never bound
  });

  test("AC5 negative control: host traces that do not cover the retained documents fail", async () => {
    const r = await round({
      retainFindings: async () => ({ bank: "qds-factory", documentIds: ["qds-20261019-d0c001"], traces: [] }),
    });
    some(assertAc5HostSideRetain(r.files), /do not cover exactly the retained documents/);
  });

  test("AC7 negative control: a GO dated after the fire fails", async () => {
    const r = await round();
    some(
      assertAc7LiveRules(
        editLeg(r.files, "trigger", (j) => {
          (j.operatorGo as Record<string, unknown>).when = "2026-10-20T00:00:00Z";
        }),
      ),
      /not dated before the fire/,
    );
  });
});

describe("R3 — kill at the hold, retain with the fork down, release after (B-1, E-1, A-2)", () => {
  test("positive control: the kill lands BEFORE the last retain, the release AFTER it — witnesses observed from the journal", async () => {
    // a slow last retain: the kill must not wait for it (the hold only spans poll latency)
    const r = await round({}, { slowLastRetainMs: 100 });
    expect(r.outcome.failure).toBeUndefined();
    const o = r.world.calls.order;
    expect(o.indexOf("kill")).toBeLessThan(o.indexOf("retain:diff-scope"));
    expect(o.indexOf("retain:diff-scope")).toBeLessThan(o.indexOf("release"));
    const c = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-crash-window-redrive.json")) as LegFile).text);
    expect(c.heldAtKill).toBe(true);
    expect(c.releasedAfterRetain).toBe(true);
    expect(c.gateJournal.map((l: { phase: string }) => l.phase)).toEqual(["held", "released", "exec"]);
    expect(typeof c.holdAgeAtKillMs).toBe("number");
    expect(assertAc4CrashWindow(r.files)).toEqual([]);
  });

  test("a hold that EXPIRED before the kill: the watcher stands down with that cause — no kill, red", async () => {
    const r = await round({
      crashGate: {
        arm: () => {},
        release: () => {},
        abort: () => {},
        journalFor: (requestId) => [
          { verb: "submit", requestId, workId: "w:z3-s-code", phase: "held", at: Date.now() - 300_000 },
          { verb: "submit", requestId, workId: "w:z3-s-code", phase: "expired", at: Date.now() - 60_000 },
        ],
      },
    });
    expect(r.outcome.failure).toBeDefined();
    expect(String(r.outcome.failure)).toContain("the hold already ended before the kill (held→expired)");
    expect(r.world.calls.killed).toBe(0);
  });

  test("AC4 negative control: a journal showing the hold expired before the kill fails — the driver's flag is not trusted", async () => {
    const r = await round();
    const files = editLeg(r.files, "crash-window-redrive", (j) => {
      const killed = Date.parse(String(j.killedAt));
      j.gateJournal = [
        { phase: "held", at: killed - 300_000 },
        { phase: "expired", at: killed - 60_000 },
        { phase: "released", at: killed + 60_000 },
        { phase: "exec", at: killed + 60_000 },
      ];
    });
    some(assertAc4CrashWindow(files), /already expired\/aborted\/exec'd before the kill/);
  });

  test("AC4 negative control: a journal whose release predates the last retain fails", async () => {
    const r = await round();
    const files = editLeg(r.files, "crash-window-redrive", (j) => {
      for (const l of j.gateJournal as Array<Record<string, unknown>>) {
        if (l.phase === "released") l.at = Date.parse(String(j.retainDoneAt)) - 10_000;
      }
    });
    some(assertAc4CrashWindow(files), /does not show the release after the last retain/);
  });

  test("the last observe never waits on the held code submit (it is killed, it cannot ack)", async () => {
    const r = await round({}, { recordLag: true });
    const observes = r.files.filter((f) => f.name.endsWith("-z3-qa-run-observe.json")).map((f) => JSON.parse(f.text));
    expect(observes.at(-1)?.settlePolls).toBe(0);
  });
});

describe("R3 — cleanup re-checks the schedule at the end; receipts never block the record (E-5, B-5)", () => {
  test("a schedule that fired AFTER the first disarm is cancelled late and flagged; a still-active schedule is a problem", async () => {
    let n = 0;
    const r = await round({
      readRecall: () => null,
      disarmSchedule: async () =>
        n++ === 0
          ? { disarmed: true, firedRunIds: ["pr-z3-1"], scheduleStatus: "archived" }
          : { disarmed: false, firedRunIds: ["pr-z3-1", "pr-z3-late"], scheduleStatus: "active" },
    });
    expect(r.world.calls.cancelled).toEqual(["pr-z3-1", "pr-z3-late"]);
    some(r.outcome.cleanupProblems, /fired pr-z3-late after the first disarm/);
    some(r.outcome.cleanupProblems, /still active after cleanup/);
  });

  test("a receipt carrying a bare key prefix never costs the cleanup record (bounded + scrubbed, minimal fallback)", async () => {
    const r = await round({
      destroyBoxes: async (runIds) => ({ receipts: runIds.map((runId) => ({ runId, exitCode: 0, stderrTail: "expected key prefix sk-or-\n" })), problems: [] }),
    });
    const cleanup = r.files.find((f) => f.name.endsWith("-z3-cleanup.json"));
    expect(cleanup).toBeDefined();
    expect(assertAc7LiveRules(r.files)).toEqual([]);
  });
});

describe("R3 verification — INV-Z3-2 policy probe, AC4 counts the journal itself (N-4, N-7)", () => {
  test("positive control: the fire records the ADR-2 policy state (absent here) and AC2 accepts it", async () => {
    const r = await round();
    const t = JSON.parse((r.files.find((f) => f.name.endsWith("-z3-trigger.json")) as LegFile).text);
    expect(t.autoMergePolicy).toEqual({ state: "absent" });
    expect(assertAc2ApproveRecorded(r.files)).toEqual([]);
  });

  test("AC2 negative control: an ADR-2 auto-merge policy that reads ON at the fire fails (INV-Z3-2)", async () => {
    const r = await round({ autoMergePolicy: () => ({ state: "on" }) });
    expect(r.outcome.failure).toBeDefined();
    some(assertAc2ApproveRecorded(r.files), /policy read ON at the fire/);
  });

  test("AC2 negative control: an unrecorded policy state, or a decision minted by the policy approver, fails", async () => {
    const r = await round();
    some(
      assertAc2ApproveRecorded(
        editLeg(r.files, "trigger", (j) => {
          j.autoMergePolicy = undefined;
        }),
      ),
      /INV-Z3-2 is unproven/,
    );
    some(
      assertAc2ApproveRecorded(
        editLeg(r.files, "approve", (j) => {
          j.approverId = "policy:adr-2";
        }),
      ),
      /the ADR-2 policy's, not a human's/,
    );
  });

  test("AC4 negative control: a journal with two execs fails even when the driver's submitExecs says 1", async () => {
    const r = await round();
    const files = editLeg(r.files, "crash-window-redrive", (j) => {
      const gj = j.gateJournal as Array<Record<string, unknown>>;
      gj.push({ ...(gj.at(-1) as Record<string, unknown>), phase: "exec" });
    });
    some(assertAc4CrashWindow(files), /gate journal shows 2 fleet-submit execs/);
  });

  test("AC4 negative control: an exec (or expiry) in the kill's own second counts as before it (fail-closed)", async () => {
    const r = await round();
    const files = editLeg(r.files, "crash-window-redrive", (j) => {
      const killed = Math.floor(Date.parse(String(j.killedAt)) / 1000) * 1000;
      j.gateJournal = [
        { phase: "held", at: killed - 5000 },
        { phase: "exec", at: killed },
        { phase: "released", at: killed + 60_000 },
      ];
    });
    some(assertAc4CrashWindow(files), /already expired\/aborted\/exec'd before the kill/);
  });
});
