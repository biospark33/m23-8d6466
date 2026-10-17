import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A2 live-round catch #4 (leg qds-20261017-a5b1e1): the dispatch witness has
 * ALWAYS written the headless identity into `issueId` (`correlation.issueKey`,
 * dispatch.ts) — digits for issue work, `w:<workId>` for headless work — but
 * the in-box reader (`deriveInBoxArgv`) demanded digits and refused the engine
 * start. The reader now routes by shape; this pins the headless shape through
 * the real front door (`qds-engine run <runId>`), HOME anchored on a
 * materialised in-box layout.
 */
describe("the dispatch witness routes headless work identity (A2 live catch #4)", () => {
	test("a `w:<workId>` witness issueId passes the identity gate and fails LATER (the record, not the identity)", () => {
		const home = mkdtempSync(join(tmpdir(), "witness-headless-"));
		const qds = join(home, "src", ".qds");
		mkdirSync(qds, { recursive: true });
		writeFileSync(
			join(qds, "run-context.json"),
			JSON.stringify({
				runId: "qds-20261017-a5b1e1",
				requestId: "d8fd5022-2d36-4315-bf18-2ef11324e639",
				budgetMs: 3599999,
				repoSlug: "quantum-digital-solutions/qds-factory",
				issueId: "w:w:qa-20261017t122025z-correctness",
			}),
		);
		let out = "";
		try {
			execFileSync(
				process.execPath,
				["scripts/pipeline-run.ts", "run", "qds-20261017-a5b1e1"],
				{
					cwd: join(import.meta.dir, "../.."),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 120_000,
					env: { ...process.env, HOME: home },
				},
			);
			expect.unreachable("the headless-tree run cannot fully start in a tmp layout");
		} catch (e) {
			const err = e as { stdout?: Buffer; stderr?: Buffer };
			out = String(err.stdout ?? "") + String(err.stderr ?? "");
		}
		// The IDENTITY gate passes; whatever fails next names the in-box
		// layout, never the witness identity.
		expect(out).not.toContain("malformed issueId");
		expect(out).not.toContain("half a correlation");
		expect(out).not.toContain("INVALID_WORK_ID");
	});
});
