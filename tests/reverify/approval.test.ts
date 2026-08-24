/**
 * Approval port tests (Story DF5.1, AC6).
 *
 * DF5.1 is the SINGLE OWNER of the `requestApproval` caller. The port is the
 * seam DF3.4 lands behind; the state machine asserted here is the caller-side
 * contract that must hold whichever adapter is plugged in.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { recordApprovalPort } from "../../src/reverify/approval.ts";

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rv-runs-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const req = (reportId: string, headSha = "a".repeat(40)) => ({
  proposal: "open a PR for run-1",
  reportId,
  headSha,
});

describe("recordApprovalPort", () => {
  test("first green verdict registers an awaiting-approval record", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      const out = await port.requestApproval("run-1", req("rv-1"));
      expect(out.outcome).toBe("requested");

      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-1");
    } finally {
      s.cleanup();
    }
  });

  test("a second green verdict REBINDS the awaiting record, creating no second one", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      await port.requestApproval("run-1", req("rv-1", "a".repeat(40)));
      const out = await port.requestApproval("run-1", req("rv-2", "b".repeat(40)));

      expect(out).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-2");
      expect(ext?.headSha).toBe("b".repeat(40));
      expect(ext?.supersededReportId).toBe("rv-1");
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record is left byte-identical and no request is made", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", {
        extensions: {
          approval: { state: "pausing", proposal: "p", reportId: "rv-0", headSha: "c".repeat(40), requestedAt: "t0" },
        },
      });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-9"));
      expect(out).toEqual({ outcome: "pause-in-progress" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test.each([["approved"], ["rejected"], ["timed-out"]] as const)(
    "a terminal record (%s) is not rebound and no request is made",
    async (state: string) => {
      const s = store();
      try {
        s.store.create("run-1");
        s.store.set("run-1", {
          extensions: {
            approval: { state, proposal: "p", reportId: "rv-0", headSha: "c".repeat(40), requestedAt: "t0" },
          },
        });
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");

        const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-9"));
        expect(out).toEqual({ outcome: "already-decided", state });
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        s.cleanup();
      }
    },
  );

  test("works on a CLOSED record — the pause happens after teardown", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.close("run-1");
      const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"));
      expect(out.outcome).toBe("requested");
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("concurrent requests serialize — exactly one binding survives, no second record", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      const outs = await Promise.all([
        port.requestApproval("run-1", req("rv-a")),
        port.requestApproval("run-1", req("rv-b")),
      ]);
      const kinds = outs.map((o) => o.outcome).sort();
      expect(kinds).toEqual(["rebound", "requested"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(["rv-a", "rv-b"]).toContain(String(ext?.reportId));
      expect(ext?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });
});
