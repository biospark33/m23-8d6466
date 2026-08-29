/**
 * The ONE process-tree kill primitive (F024).
 *
 * There used to be six of these with four escalation semantics
 * (`coms-smoke-helpers.ts`, `cli-anything/src/runner.ts`, `pipeline-run.ts`,
 * `mcp-stdio-client.ts`, plus `watchdog.ts` and `fake-driver.ts`). This is the
 * version that had tests (`tests/scripts/kill-tree.test.ts`), promoted out of
 * `coms-smoke-helpers.ts` so every caller shares one contract.
 *
 * Still deliberately NOT routed through here — different contracts, not copies:
 *   - `cli-anything/src/watchdog.ts`: graceful SIGTERM→SIGKILL escalation with
 *     its own grace window and post-kill settle.
 *   - `src/providers/fake-driver.ts`: returns an identity-gated CLOSURE over a
 *     Bun.Subprocess, not a void call on a node ChildProcess.
 *
 * Tests: `tests/scripts/kill-tree.test.ts`.
 */
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

/**
 * Kill the whole process tree. POSIX spawns that pass `detached: true` are
 * group leaders, so signalling the GROUP (`-pid`) sweeps grandchildren (a pi
 * tool call's `sleep`, an LSP server under an MCP broker); on win32 use
 * `taskkill /T /F`. Best-effort by contract — a dead process must never throw,
 * and every failure falls back to the direct child rather than leaving the
 * tree running.
 *
 * `child` accepts null/undefined so callers holding a not-yet-spawned or
 * already-cleared handle can call it unconditionally.
 *
 * A child with no `pid` returns WITHOUT a direct kill. That narrows the old
 * `cli-anything/src/runner.ts` copy, which attempted `child.kill("SIGKILL")`
 * first — a no-op in practice, since a pid-less ChildProcess is one whose
 * spawn failed and there is nothing to signal.
 */
export function killTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!child) return;
	const pid = child.pid;
	if (typeof pid !== "number") return;
	const fallback = (): void => {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	};
	try {
		if (process.platform === "win32") {
			// spawnSync, not execFile: the callers are teardown paths (an abort
			// handler, a `finally`) that must not return before the tree is
			// signalled. taskkill reports failure through a non-zero status
			// rather than a throw, so check it — that is the arm the old
			// runner.ts copy handled via its execFile callback.
			const res = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
			if (res.error || res.status !== 0) fallback();
		} else {
			process.kill(-pid, signal);
		}
	} catch {
		fallback();
	}
}
