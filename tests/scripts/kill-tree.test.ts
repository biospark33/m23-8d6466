/**
 * Contract tests for the ONE process-tree kill primitive (F024).
 *
 * Moved verbatim from `tests/scripts/coms-smoke-helpers.test.ts` when the
 * helper was promoted out of that module into `scripts/lib/kill-tree.ts`;
 * the cases that already covered it are the reason this version is the one
 * that got promoted rather than one of the five untested copies.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { killTree } from "../../scripts/lib/kill-tree.ts";
import { McpClient } from "../../scripts/lib/mcp-stdio-client.ts";

// killTree signals the process GROUP on POSIX; these exercise the real thing
// against real detached children.
describe.skipIf(process.platform === "win32")("killTree", () => {
	const waitExit = (proc: { exitCode: number | null; signalCode: string | null }) =>
		new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5000;
			const poll = () => {
				if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
				if (Date.now() > deadline) return reject(new Error("child never exited"));
				setTimeout(poll, 25);
			};
			poll();
		});

	test("kills a detached child", async () => {
		const proc = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		killTree(proc, "SIGKILL");
		await waitExit(proc);
		expect(proc.signalCode ?? proc.exitCode).not.toBeNull();
	});

	test("sweeps GRANDCHILDREN — the whole reason it signals -pid", async () => {
		// A bare proc.kill() would leave the inner `sleep` orphaned and running.
		// The duration doubles as a run-unique marker (it is the grandchild's
		// whole argv) so a leaked sleep from an earlier run can never be
		// mistaken for this run's survivor.
		const marker = `sleep 30000.${process.pid}${Math.floor(Math.random() * 1e6)}`;
		const proc = spawn("sh", ["-c", `${marker} & wait`], { detached: true, stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 300)); // let the grandchild start
		killTree(proc, "SIGKILL");
		await waitExit(proc);
		await new Promise((r) => setTimeout(r, 200));
		const survivors = spawn("pgrep", ["-f", marker], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		survivors.stdout.on("data", (c) => {
			out += String(c);
		});
		await new Promise((r) => survivors.on("close", r));
		expect(out.trim()).toBe("");
	});

	test("is a no-op on a process with no pid", () => {
		expect(() => killTree({ pid: undefined } as never, "SIGKILL")).not.toThrow();
	});

	test("does not throw on an already-dead process", async () => {
		const proc = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		await waitExit(proc);
		expect(() => killTree(proc, "SIGKILL")).not.toThrow();
		expect(() => killTree(proc, "SIGTERM")).not.toThrow();
	});

	test("honors a non-default signal", async () => {
		const proc = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		killTree(proc, "SIGTERM");
		await waitExit(proc);
		expect(proc.signalCode).toBe("SIGTERM");
	});

	// New with the promotion: cli-anything/src/runner.ts called it as
	// `killTree(child)` where `child` is `ChildProcess | null`, and defaulted to
	// SIGKILL. Both are part of the merged contract now.
	test("null child is a no-op, and the signal defaults to SIGKILL", async () => {
		expect(() => killTree(null)).not.toThrow();
		const proc = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		killTree(proc);
		await waitExit(proc);
		expect(proc.signalCode).toBe("SIGKILL");
	});

});

// F023 regression, and the only end-to-end proof that `detached: true` at the
// spawn plus killTree at the escalation actually stop the leak: before the fix
// this asserted 1 survivor, not 0.
describe.skipIf(process.platform === "win32")("McpClient.close sweeps the server's grandchildren (F023)", () => {
	test(
		"a SIGTERM-ignoring server does not leak its 'language server' child",
		async () => {
			// `sleep`'s argument doubles as a run-unique marker, so it has to stay
			// a valid duration — a non-numeric marker makes sleep exit instantly
			// and the test passes vacuously.
			const marker = `3000.${process.pid}${Math.floor(Math.random() * 1e6)}`;
			const dir = mkdtempSync(join(tmpdir(), "qds-mcp-leak-"));
			const server = join(dir, "server.cjs");
			// Shape of pi-lens's MCP server: brokers a real grandchild, and
			// ignores SIGTERM — so close()'s 2 s SIGKILL escalation is the path
			// taken, which is exactly the case that used to leak.
			writeFileSync(
				server,
				[
					'const { spawn } = require("node:child_process");',
					`spawn("sleep", ["${marker}"], { stdio: "ignore" });`,
					"process.on(\"SIGTERM\", () => {});",
					"setInterval(() => {}, 1000);",
				].join("\n"),
			);
			const alive = () =>
				Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim().split("\n").filter(Boolean).length;

			const client = new McpClient(server, dir, process.env);
			try {
				await new Promise((r) => setTimeout(r, 1_200));
				expect(alive()).toBe(1); // non-vacuous: the grandchild really started
				client.close();
				await new Promise((r) => setTimeout(r, 3_500)); // past the 2 s escalation
				expect(alive()).toBe(0);
			} finally {
				Bun.spawnSync(["pkill", "-f", marker]);
			}
		},
		{ timeout: 20_000 },
	);
});
