/**
 * A2 leaf-2.0.1 day-of wiring for the live round's leg-driver deps.
 *
 * Wires the two seams `tests/qa/qa-f3-round.live.test.ts` leaves to "the day":
 *
 *  - submitLeg(lens) polls the fork-side day-of state dump
 *    (`/factory/.unlazy/a2/protocol-state.json`, written by
 *    `.unlazy/a2/qa-f3-day-of.ts state` inside the fork container) until the
 *    protocol run's `qa-leg-<lens>` step is submitted and carries its fleet
 *    runId. The legs are the PROTOCOL's external_job steps — the round driver
 *    never submits spend itself; it only observes the trigger-fired protocol.
 *  - awaitTerminal(runId) polls `fleet result <runId>` (the driver-agnostic
 *    verb) against the run-record store the fork-side wrapper wrote — the fork
 *    container mounts this clone at /factory and its fleet child runs with
 *    cwd=/factory, so both sides read the same `.sandbox/runs` store.
 *
 * Lens attribution: the fork→fleet submit seam carries no step instructions
 * (buildSubmitCall sends requestId/repo/commitSha/manifestPath/workId only), so
 * the box cannot know its lens; the lens is minted HOST-side by this driver
 * from the protocol step ids — exactly what the fixture names ("normalizeHarvest
 * mints the (runId, lens) pair host-side", tests/qa/hunter-pack.test.ts AC2).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const STATE_FILE = `${REPO_ROOT}/.unlazy/a2/protocol-state.json`;
const STATE_POLL_MS = 10_000;

type ProtocolState = {
	jobs: Array<Record<string, unknown>>;
	runs: Array<{
		id: string;
		status: string;
		steps?: Array<{
			id: string;
			externalJobConfig?: { workId?: string };
		}>;
		factoryState?: Record<
			string,
			{ status?: string; runId?: string | null; lastError?: string | null }
		>;
	}>;
	writtenAt: string;
};

export function readProtocolState(): ProtocolState {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ProtocolState;
		} catch (err) {
			if (Date.now() > deadline) {
				throw new Error(`protocol state dump unreadable after 30s (${STATE_FILE}): ${String(err)}`);
			}
			refreshProtocolState();
			const until = Date.now() + 1_000;
			while (Date.now() < until) {} // 1s backoff before the next read
		}
	}
}

/** Refreshes the fork-side state dump (best-effort; a stale dump still parses). */
export function refreshProtocolState(): void {
	try {
		execFileSync(
			"docker",
			["exec", "swarmclaw-swarmclaw-1", "npx", "tsx", "/factory/.unlazy/a2/qa-f3-day-of.ts", "state"],
			{ timeout: 120_000, stdio: "pipe" },
		);
	} catch (err) {
		console.error(`[qa-wiring] state refresh failed (continuing on the last dump): ${String(err)}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function submitLeg(lens: string): Promise<{ workId: string; runId: string }> {
	const stepId = `qa-leg-${lens}`;
	const deadline = Date.now() + 120 * 60_000; // the protocol chains legs; wait it out
	for (;;) {
		refreshProtocolState();
		const state = readProtocolState();
		// The watch job patches result.protocolRunId on a successful fire — the
		// authoritative current-run link. A stale dump may still carry a PREVIOUS
		// fire's run (or its failure); never read a run the jobs list does not
		// name as fired.
		const firedRunId = state.jobs
			.map((j) => String((j.result as { protocolRunId?: string } | undefined)?.protocolRunId ?? ""))
			.filter(Boolean)
			.at(-1);
		const run = firedRunId ? state.runs.find((r) => r.id === firedRunId) : state.runs[0];
		if (!run) {
			if (Date.now() > deadline) throw new Error("the trigger never fired a protocol run within the deadline");
			await sleep(STATE_POLL_MS);
			continue;
		}
		const step = run?.steps?.find((s) => s.id === stepId);
		const fsEntry = run?.factoryState?.[stepId];
		const workId = step?.externalJobConfig?.workId;
		const runId = fsEntry?.runId;
		if (runId && workId) return { workId, runId };
		if (fsEntry?.lastError) throw new Error(`leg ${stepId} errored fork-side: ${fsEntry.lastError}`);
		if (Date.now() > deadline) throw new Error(`leg ${stepId} never reached submitted-with-runId within the deadline`);
		await sleep(STATE_POLL_MS);
	}
}

export async function awaitTerminal(
	runId: string,
): Promise<{ exitCode: number; outcome: string }> {
	const deadline = Date.now() + 75 * 60_000; // pollTimeoutMs is 1h; keep polling past it
	for (;;) {
		const out = execFileSync("bun", ["scripts/fleet.ts", "result", runId, "--json"], {
			cwd: REPO_ROOT,
			timeout: 60_000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop() ?? "{}") as {
			status?: string;
			terminal?: boolean;
		};
		if (parsed.terminal || (parsed.status && ["completed", "failed", "cancelled"].includes(parsed.status))) {
			// D8: the lifecycle closes exit-6 runs as completed — the harvest's
			// presence, not the exit code, is the retain signal.
			return {
				exitCode: parsed.status === "completed" ? 0 : 1,
				outcome: parsed.status ?? "unknown",
			};
		}
		if (Date.now() > deadline) throw new Error(`run ${runId} never reached terminal within the deadline`);
		await sleep(STATE_POLL_MS);
	}
}
