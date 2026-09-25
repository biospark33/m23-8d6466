import { describe, expect, test } from "bun:test";
import { residentArmedFor } from "../../scripts/pipeline-run.ts";

// R0.7 round 10 (run qds-20260925-d60cf1, engine-start-refused): a rig_swarm
// run's unit arms the resident off the dispatch brief alone, and the resident's
// INV-RES-3 key assertion then kills the engine — seat mode delivers NO
// OPENROUTER_API_KEY (the seat keys replace it). Program invariant 2 already
// answers the design question: in rig_swarm mode the OpenRig lead seat
// orchestrates and the resident agent is OFF. The manifest — not argv — is
// what the engine can see at arm time, so a rig_swarm phase disables arming
// exactly the way --no-resident does.

const SWARM_PHASES = [
  { kind: "code", name: "probe" },
  { kind: "rig_swarm", name: "swarm" },
];
const CODE_PHASES = [{ kind: "code", name: "probe" }];
const FULL_BRIEF = { requestId: "req-1", repoSlug: "qds/demo", issueId: 42 };

describe("residentArmedFor (the engine's arming decision)", () => {
  test("a code-phase run with a real brief arms (the pre-existing behavior, unchanged)", () => {
    expect(residentArmedFor(FULL_BRIEF, CODE_PHASES, false)).toBeTrue();
  });

  test("a rig_swarm run never arms — the lead seat is the one tier-2 brain", () => {
    expect(residentArmedFor(FULL_BRIEF, SWARM_PHASES, false)).toBeFalse();
    expect(residentArmedFor(undefined, SWARM_PHASES, false)).toBeFalse();
  });

  test("--no-resident still disarms, on every manifest shape", () => {
    expect(residentArmedFor(FULL_BRIEF, CODE_PHASES, true)).toBeFalse();
    expect(residentArmedFor(FULL_BRIEF, SWARM_PHASES, true)).toBeFalse();
  });

  test("an empty brief still disarms a code run (identity fields decide)", () => {
    expect(residentArmedFor(undefined, CODE_PHASES, false)).toBeFalse();
    expect(residentArmedFor({}, CODE_PHASES, false)).toBeFalse();
    expect(residentArmedFor({ requestId: "" }, CODE_PHASES, false)).toBeFalse();
  });
});
