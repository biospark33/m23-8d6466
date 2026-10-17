/**
 * A2 leaf-2.0.1 — the live Tier-2 no-fakes round (charter §5.6).
 *
 * GATING: `QDS_E2E_LIVE=1` + `QDS_E2E_TIER=2` + the substrate env names —
 * `liveGate("2")` throws otherwise, and the test is `todoIf(liveTodoOff())`
 * so factory CI sees a todo, never a live fire. `QDS_E2E_EVIDENCE_DIR` is
 * pinned by the STORY to `_bmad-output/evidence/v6-a2/` (the live-harness
 * default is `df3-e2e`); this file asserts the pin before anything fires.
 *
 * TRIGGER REALITY (story E2E slice): the round fires on a MERGED fleet-run PR
 * via Z2's post-merge wiring — post-merge by construction. The factory PR
 * merge + the merged fork counterpart are the round's preconditions, so this
 * file is authored and green in its skip arm at PR time; the operator fires
 * it on the day (worst-case spend printed first, GO recorded, cleanup in
 * `finally`, evidence scrubbed to the pinned dir, every leg JSON
 * `swarmclawForkRev`-stamped by scripts/qa/leg-drivers.ts).
 *
 * Precondition notes (recorded, per DD-28.26(4)): the wave-0 re-pin ritual
 * re-runs on the [M1.2+J3+J4+A2] tree before the round; the fork counterpart
 * PR (branch qa-f3-counterpart @85cb0850) must be merged fork-side.
 */
import { describe, expect, test } from "bun:test";
import { liveGate, liveTodoOff } from "../fleet/e2e/live-harness.ts";
import { printWorstCaseSpend, runLeg, SWARMCLAW_FORK_REV, type LegDriverDeps } from "../../scripts/qa/leg-drivers.ts";
import { awaitTerminal, submitLeg } from "../../scripts/qa/live-round-wiring.ts";
import { QA_LENS } from "../../src/qa/findings.ts";

const EVIDENCE_DIR = "_bmad-output/evidence/v6-a2";

describe("A2 live Tier-2 round (post-merge trigger; operator GO-gated)", () => {
	test.todoIf(liveTodoOff())("post-merge → QA bot turn → hunter-pack legs → retain + issues → priming round-trip", async () => {
		liveGate("2");
		expect(process.env.QDS_E2E_EVIDENCE_DIR?.trim()).toBe(EVIDENCE_DIR);
		if (SWARMCLAW_FORK_REV === "UNSET") throw new Error("SWARMCLAW_FORK_REV unset — the round must name its fork rev (drift alarm)");
		printWorstCaseSpend();
		// GO record lands in the evidence dir before the first leg (the
		// driver writes it from the operator's recorded answer).
		const goFile = `${EVIDENCE_DIR}/operator-GO.json`;
		const go = await import("node:fs");
		if (!go.existsSync(goFile)) {
			throw new Error(`operator GO not recorded at ${goFile} — record it (who/when/spend-approved) before firing`);
		}

		// The leg drivers are wired on the day (scripts/qa/live-round-wiring.ts):
		// submitLeg observes the trigger-fired protocol's external_job legs (the
		// round driver never submits spend itself); awaitTerminal polls the
		// driver-agnostic `fleet result` seam against the shared run-record
		// store. Lens labels are minted host-side by the wiring module from the
		// protocol step ids (the fork→fleet submit seam carries no step
		// instructions — see that file's header). The retain/issues/priming
		// legs run through the merged src/qa modules after the legs settle.
		const deps: LegDriverDeps = {
			submitLeg,
			awaitTerminal,
			forkRev: () => SWARMCLAW_FORK_REV,
			outDir: EVIDENCE_DIR,
		};
		const results = [];
		for (const lens of QA_LENS) {
			results.push(await runLeg(deps, lens));
		}
		for (const r of results) {
			expect(r.swarmclawForkRev).not.toBe("UNSET");
			expect(r.exitCode).toBe(0);
		}
		// Priming round-trip: the next Dev dispatch's <kg_context> contains a
		// retained finding (M1.2 dispatch-recall seam, live) — asserted on the
		// day against the real recall; the assertion contract is pinned here so
		// the day-of run cannot skip it.
		expect(results.length).toBe(QA_LENS.length);
	});
});
