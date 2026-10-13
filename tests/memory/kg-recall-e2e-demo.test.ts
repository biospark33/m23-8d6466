/**
 * M2.2 mock-tier CHAINED e2e demo (story DoD) — one granted worker's whole
 * recall lifecycle, driven only through landed story code plus M2.1's memgate
 * library:
 *
 *   granted-role spawn (-e pair from the REAL roster through the adapter and
 *   buildWorkerArgv) → dispatch mint+deliver (`mintAndDeliverMemoryKey` inside
 *   dispatch(), REAL ledger + real box env file) → spawn-side key consumption
 *   (the extension entry executed against a REAL localhost Bun.serve gateway
 *   that verifies the delivered bearer material) → ceiling truncation →
 *   run-completion teardown revoke-verify (`teardownMemoryKey` inside
 *   guardedTeardown, fresh read-only isRevoked proof, box-destroy strictly
 *   after the revoke).
 *
 * Stages are SEQUENCED: 2-4 run as one test so the SAME gateway port that
 * dispatch delivered is the one the in-box recall round-trips to (a per-test
 * server would re-port between delivery and read); stage 5 tears down the very
 * row stage 2 minted, keyed by dispatch's own runId. No mock library — the
 * gateway is a real localhost server, the driver/ledger/store are the repo's
 * own fakes-over-real-substrate (R2 §7). Env discipline: every touched var is
 * saved/deleted/restored around every test; every store/ledger lives in a
 * mkdtemp tmpdir; the dispatch clock is fixed.
 *
 * typebox is not a repo dependency (Pi's jiti loader aliases it in the box):
 * mock.module registers the minimal Type shim BEFORE the entry's dynamic
 * import — the same loading technique as kg-recall-extension.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseRoster } from "../../src/phase-engine/roster/schema.ts";
import { rosterRoleToTeamRole } from "../../src/phase-engine/phases/roster-adapter.ts";
import { buildWorkerArgv } from "../../cli-anything/scripts/team-lead-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ExecResult } from "../../src/providers/driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger, useTempAuditStore } from "../fleet/helpers.ts";
import { dispatch, type DispatchDeps } from "../../src/fleet/dispatch.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { observeAndDriveChain, type RunCompletionDeps } from "../../src/fleet/run-completion.ts";
import { MemgateLedger, openReadOnly } from "../../src/memgate/ledger.ts";
import {
	MEMGATE_ADMIN_KEY,
	QDS_KG_GATEWAY_URL,
	QDS_MEMGATE_LEDGER,
	QDS_MEMGATE_SIGNING_KEY,
} from "../../src/memgate/schemas.ts";

mock.module("typebox", () => ({
	Type: {
		String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
		Integer: (options?: Record<string, unknown>) => ({ type: "integer", ...options }),
		Object: (props: Record<string, unknown>, options?: Record<string, unknown>) => ({
			type: "object",
			properties: props,
			...(options ?? {}),
		}),
		Optional: (schema: unknown) => schema,
	},
}));

const ENTRY_PATH = "../../pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/kg-recall.ts";
const ROSTER_PATH = resolve(import.meta.dir, "../../config/rosters/qds-default.roster.yaml");
const KG_RECALL = "pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/kg-recall.ts";
const MARKER = "\n[kg_recall:truncated]";

/** Every env var the chain touches. HINDSIGHT_* is deleted so dispatch's bank
 * list can never fall through to a real client; the injected memoryBankList is
 * the only bank source. */
const ENV_KEYS = [
	MEMGATE_ADMIN_KEY,
	QDS_MEMGATE_SIGNING_KEY,
	QDS_KG_GATEWAY_URL,
	QDS_MEMGATE_LEDGER,
	"QDS_KG_RECALL_KEY",
	"HINDSIGHT_BASE_URL",
	"HINDSIGHT_BEARER_TOKEN",
	"HINDSIGHT_API_KEY",
] as const;

const REQ = "req-m22-e2e-demo";
const ADMIN_KEY = "mgadm-m22-e2e-demo-0001";
const SIGNING_KEY = "mgsgn-m22-e2e-demo-0001";
const FIXED_NOW = 1_800_000_000_000; // dispatch's deterministic clock

const TEARDOWN_MODULE = "../../src/providers/teardown.ts";
const realTeardownModule = await import(TEARDOWN_MODULE);
const realTeardownSandbox = realTeardownModule.teardownSandbox;

describe("M2.2 e2e demo: granted worker recall chain", () => {
	useTempAuditStore(); // dispatch() opens QDS_AUDIT_DB ?? .sandbox/audit.db at CWD — mandatory

	/** The chained facts each stage hands the next (dispatch's own mint). */
	const chain: {
		runId?: string;
		tokenId?: string;
		keyMaterial?: string;
		gatewayUrl?: string;
		ledgerPath?: string;
		banks?: string[];
		bank?: string;
	} = {};

	let savedEnv: Record<string, string | undefined> = {};
	let gateway: Bun.Server<Record<string, never>> | undefined;

	/**
	 * ONE memgate ledger for the whole chained demo: stage 2 mints into it,
	 * stage 5 revokes out of it. Created once at describe scope, removed in
	 * afterAll — a per-test tmpdir would delete the row between the mint and
	 * the teardown that exists to revoke it.
	 */
	const memDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "qds-m22-e2e-mg-")));
	const ledgerPath = join(memDir, "ledger.db");

	beforeEach(() => {
		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const k of ENV_KEYS) delete process.env[k];
	});

	afterEach(() => {
		// no detached listeners: the mock gateway dies with every test it outlived
		gateway?.stop(true);
		gateway = undefined;
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	afterAll(() => {
		rmSync(memDir, { recursive: true, force: true });
	});

	// ── stage 1: grant → argv ─────────────────────────────────────────────────

	test("stage 1: real roster → adapter → buildWorkerArgv carries the -e pair for kg-recall", () => {
		const roster = parseRoster(readFileSync(ROSTER_PATH, "utf8"), ROSTER_PATH);
		const worker = roster.roles.find((r) => r.name === "worker");
		expect(worker).toBeDefined();
		if (!worker) return;

		const teamRole = rosterRoleToTeamRole(worker, { agentId: worker.name, prompt: "demo prompt" });
		expect(teamRole.extensions).toContain(KG_RECALL); // the adapter forwards the grant

		const argv = buildWorkerArgv({
			agentId: teamRole.agentId,
			provider: worker.provider,
			model: worker.model,
			prompt: teamRole.prompt,
			extensions: teamRole.extensions,
		});
		const i = argv.indexOf(KG_RECALL);
		expect(i).toBeGreaterThan(0);
		expect(argv[i - 1]).toBe("-e"); // a -e PAIR, not a bare token
	});

	// ── stages 2-4: mint+deliver → in-box recall (real HTTP) → truncation ─────

	test(
		"stages 2-4: dispatch mint+deliver → extension recalls over real localhost HTTP → truncation",
		async () => {
			const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "qds-m22-e2e-run-")));

			// The mock gateway: records every request, answers from a swappable
			// responder. REAL HTTP on a kernel port — the wire path itself is under test.
			const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
			let respondWith: () => Response = () => Response.json({ results: [] });
			gateway = Bun.serve({
				port: 0,
				fetch: async (req) => {
					seen.push({
						method: req.method,
						path: new URL(req.url).pathname,
						auth: req.headers.get("authorization"),
						body: await req.json(),
					});
					return respondWith();
				},
			});
			const gatewayUrl = `http://127.0.0.1:${gateway.port}`;

			// dispatch reads its memgate config from process.env (the operator's
			// exported env); the gateway URL points at the localhost mock.
			process.env[MEMGATE_ADMIN_KEY] = ADMIN_KEY;
			process.env[QDS_MEMGATE_SIGNING_KEY] = SIGNING_KEY;
			process.env[QDS_MEMGATE_LEDGER] = ledgerPath;
			process.env[QDS_KG_GATEWAY_URL] = gatewayUrl;

			// stderr capture for the extension's structured events (L1 idiom).
			const stderrChunks: string[] = [];
			const savedWrite = process.stderr.write;
			process.stderr.write = ((chunk: unknown) => {
				stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
				return true;
			}) as typeof process.stderr.write;

			// The manifest + brief fixture (dispatch-memory-seam.test.ts's shape).
			const manifestRel = join("manifests", "pipeline.json");
			const manifestPath = join(dir, manifestRel);
			mkdirSync(dirname(manifestPath), { recursive: true });
			writeFileSync(
				manifestPath,
				JSON.stringify({
					version: "1.0.0",
					pipelineId: "demo-pipeline",
					runBudgetMs: 200_000,
					phases: [
						{ name: "plan", kind: "code", description: "Draft", command: ["true"], maxDurationMs: 10_000, retries: 0 },
						{ name: "build", kind: "code", description: "Run the tests", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
					],
				}),
			);
			const brief = {
				repoSlug: "owner/repo",
				issueId: 42,
				commitSha: "a".repeat(40),
				manifestPath: manifestRel,
				repoUrl: "https://github.com/owner/repo",
			};

			const store = new RunRecordStore(join(dir, "runs"));
			const driver = new FakeDriver(join(dir, "boxes"));
			const keyApi = new FakeKeyApi();
			const deliveries: Array<{ argv: string[]; stdin?: string }> = [];
			const originalExec = driver.exec.bind(driver);
			driver.exec = async (vm: string, argv: string[], stdin?: string) => {
				const script = argv[2] ?? "";
				if (argv[0] === "sh" && script.startsWith("umask 077")) deliveries.push({ argv, stdin });
				return originalExec(vm, argv, stdin);
			};

			const deps: DispatchDeps = {
				driver,
				keyApi,
				store,
				ledgerFactory: () => goodLedger(),
				repoRoot: dir,
				clock: () => FIXED_NOW,
				memoryBankList: { listBanks: async () => ({ banks: ["owner-repo", "owner-repo-dev-meta"] }) },
			};

			try {
				// ── stage 2: mint + deliver (the dispatch leg) ────────────────────
				const result = await dispatch(brief, deps);
				expect(result.state).toBe("ready");

				const mem = deliveries.filter((d) => d.stdin?.startsWith("\nQDS_KG_RECALL_KEY="));
				expect(mem).toHaveLength(1);
				const stdin = String(mem[0]!.stdin);
				const lines = stdin.split("\n").filter((l) => l !== "");
				expect(lines).toHaveLength(2); // EXACTLY the DD-28.23 pair
				expect(lines[0]!.startsWith("QDS_KG_RECALL_KEY=mgrun-")).toBe(true);
				expect(lines[1]).toBe(`QDS_KG_GATEWAY_URL=${gatewayUrl}`);
				const keyMaterial = lines[0]!.slice("QDS_KG_RECALL_KEY=".length);

				const ledger = new MemgateLedger(ledgerPath);
				const rows = ledger.listIssued("per-run");
				expect(rows).toHaveLength(1);
				const row = rows[0] as { token_id: string; run_id: string | null; claims_json: string };
				expect(row.run_id).toBe(result.runId); // a LIVE per-run row for THIS run
				expect(ledger.isRevoked(row.token_id)).toBe(false);
				const claims = JSON.parse(row.claims_json) as { banks: string[]; verbs: string[] };
				expect(claims.verbs).toEqual(["recall"]); // recall-only
				expect(claims.banks).toEqual(["owner-repo", "qds-collective"]); // the M1.2 fan-out set

				Object.assign(chain, {
					runId: result.runId,
					tokenId: row.token_id,
					keyMaterial,
					gatewayUrl,
					ledgerPath: ledgerPath,
					banks: claims.banks,
					bank: "owner-repo",
				});

				// ── stage 3: spawn-side key consumption (the box reads the env file) ─
				// The sourcing channel is real: the unit's mandatory EnvironmentFile
				// (qds-run@.service) sources app/.env into the manager env, and the
				// resident's CHILD_ENV_ALLOWLIST passes exactly these two names to
				// pi. The only substituted step here is the systemd one — the values
				// are parsed OUT of the delivered env file itself (the file the box
				// sources, provider key and memory pair side by side), proving
				// deliverer-writes-what-reader-reads.
				const boxEnvFile = join(driver.root, result.vmName, ".env");
				const fileLines = readFileSync(boxEnvFile, "utf8").split("\n").filter((l) => l !== "");
				const recallLine = fileLines.find((l) => l.startsWith("QDS_KG_RECALL_KEY=")) as string;
				const urlLine = fileLines.find((l) => l.startsWith("QDS_KG_GATEWAY_URL=")) as string;
				expect(recallLine).toBe(`QDS_KG_RECALL_KEY=${keyMaterial}`); // file == delivered stdin
				expect(urlLine).toBe(`QDS_KG_GATEWAY_URL=${gatewayUrl}`);
				process.env.QDS_KG_RECALL_KEY = keyMaterial;
				process.env.QDS_KG_GATEWAY_URL = urlLine.slice("QDS_KG_GATEWAY_URL=".length);

				respondWith = () =>
					Response.json({ results: [{ text: "owner-repo memory: ship points live at the bow" }], durationMs: 7 });
				const entry: typeof import("../../pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/kg-recall.ts") =
					await import(ENTRY_PATH);
				const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<any> }> = [];
				entry.default({ registerTool: (t: { name: string }) => tools.push(t as never) });
				const tool = tools.find((t) => t.name === "kg_recall");
				expect(tool).toBeDefined();

				const ok = await tool!.execute("call-1", { query: "ship points", bank: chain.bank }, undefined, undefined, undefined);
				expect(seen).toHaveLength(1); // ONE request, never retried
				expect(seen[0]!.method).toBe("POST");
				expect(seen[0]!.path).toBe(`/v1/default/banks/${chain.bank}/memories/recall`);
				expect(seen[0]!.auth).toBe(`Bearer ${keyMaterial}`); // the DELIVERED material on the wire
				expect(chain.banks).toContain(chain.bank); // the recalled bank is inside the minted allowlist
				expect(ok?.content?.[0]?.text).toContain("ship points live at the bow");

				// ── stage 4: recall → truncate (framed text over the 8 000-char ceiling) ─
				const before = seen.length;
				respondWith = () =>
					Response.json({ results: [{ text: "x".repeat(5_000) }, { text: "y".repeat(5_000) }] });
				const over = await tool!.execute("call-2", { query: "flood", bank: chain.bank }, undefined, undefined, undefined);
				const text = over?.content?.[0]?.text as string;
				expect(text.endsWith("[kg_recall:truncated]")).toBe(true); // the literal closing marker
				expect(text.length).toBeLessThanOrEqual(8_000 + MARKER.length); // ceiling + marker, nothing more
				expect(over?.details?.truncated).toBe(true);
				expect(stderrChunks.join("")).toContain("kg_recall.truncated"); // the structured stderr event
				expect(seen.length).toBe(before + 1); // exactly ONE request for this recall too
			} finally {
				process.stderr.write = savedWrite;
				gateway?.stop(true);
				gateway = undefined;
				rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	// ── stage 5: teardown revoke-verify ───────────────────────────────────────

	test("stage 5: run-completion teardown revokes+verifies the SAME key before the box dies", async () => {
		expect(chain.runId).toBeDefined(); // the sequenced demo: stage 2 must have minted
		if (!chain.runId || !chain.tokenId || !chain.ledgerPath) return;
		const runId = chain.runId;

		const runsDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "qds-m22-e2e-teardown-")));
		const store = new RunRecordStore({ dir: runsDir });
		store.create(runId); // the teardown-side record for dispatch's own runId
		store.set(runId, { vmName: `vm-${runId}`, requestId: REQ } as never);

		// The call-order recorder (kg-recall-teardown.test.ts idiom): every sink
		// line plus the stub's calls, one sequence.
		const order: string[] = [];
		const logs: LogEntry[] = [];
		const restoreLog = setLogSink((entry) => {
			logs.push(entry as LogEntry);
			const event = (entry as { event?: unknown }).event;
			if (typeof event === "string") order.push(`sink:${event}`);
		});
		// The memory-key revoke-verify now lives INSIDE teardownSandbox (the
		// injected memoryKeyTeardown hook, fired just ahead of its step-4
		// provider revoke — teardown.ts owns the firing rules). This stub
		// replaces the whole sequence, so it fires the hook itself the same
		// way: revoke-verify first, destroy last.
		const teardownStub = async (
			td: { memoryKeyTeardown?: (runId: string) => Promise<void> },
			stubRunId: string,
		): Promise<void> => {
			order.push("teardownSandbox");
			await td.memoryKeyTeardown?.(stubRunId);
			order.push("destroy");
		};
		mock.module(TEARDOWN_MODULE, () => ({ ...realTeardownModule, teardownSandbox: teardownStub }));

		// The inline marker fake: the marker settles on tick 1 so the chain drives
		// straight into guardedTeardown.
		class MarkerDriver extends FakeDriver {
			body: Record<string, unknown> | null = { runId, ok: true };

			override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
				return this.intercept(vm, argv, stdin, undefined);
			}

			override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
				return this.intercept(vm, argv, stdin, timeoutMs);
			}

			private async intercept(
				vm: string,
				argv: string[],
				stdin: string | undefined,
				timeoutMs: number | undefined,
			): Promise<ExecResult> {
				const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
				if (cmd.includes("test -f") && BOX_MARKER_PATH_RE.test(cmd)) {
					return this.body === null ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: "", stderr: "", exitCode: 0 };
				}
				if (cmd.includes("cat ") && BOX_MARKER_PATH_RE.test(cmd)) {
					return { stdout: `${JSON.stringify(this.body)}\n`, stderr: "", exitCode: 0 };
				}
				return timeoutMs === undefined ? super.exec(vm, argv, stdin) : super.execTimed(vm, argv, timeoutMs, stdin);
			}
		}

		const deps: RunCompletionDeps = {
			driver: new MarkerDriver(join(runsDir, "boxes")),
			store,
			runsDir,
			hostRoot: realpathSync(tmpdir()), // not a worktree, record has no commitSha: reverify preflight refuses fast
			runLock: join(runsDir, `${runId}.lock`) as RunCompletionDeps["runLock"],
			keyApi: new FakeKeyApi() as RunCompletionDeps["keyApi"],
			requestId: REQ,
			costLedger: { ingestBoxHours: () => undefined } as unknown as RunCompletionDeps["costLedger"],
			recordAuditLink: () => undefined,
			env: {
				[MEMGATE_ADMIN_KEY]: ADMIN_KEY,
				[QDS_MEMGATE_SIGNING_KEY]: SIGNING_KEY,
				[QDS_MEMGATE_LEDGER]: chain.ledgerPath, // the SAME ledger dispatch minted into
			},
		};

		try {
			await observeAndDriveChain(runId, deps);

			// The revoke is proven by a FRESH read-only read, never the write's answer.
			const ro = openReadOnly(chain.ledgerPath);
			try {
				expect(ro.isRevoked(chain.tokenId)).toBe(true);
			} finally {
				ro.close();
			}

			// The gateway's own lifecycle events are the per-token record (L5's
			// final shape: no second vocabulary) — BOTH carry the MINTED tokenId.
			const events = logs.map((l) => (l as Record<string, unknown>).event);
			expect(events).toContain("memgate-revoke");
			expect(events).toContain("memgate-verify-revoked");
			for (const name of ["memgate-revoke", "memgate-verify-revoked"]) {
				expect(
					logs.some(
						(l) => (l as Record<string, unknown>).event === name && (l as Record<string, unknown>).tokenId === chain.tokenId,
					),
				).toBe(true);
			}

			// The verified revoke lands strictly BEFORE the box dies — the hook
			// fires INSIDE the teardown sequence (after it starts, ahead of
			// destroy), INV-M2-4's one ordering.
			const verifyIdx = order.lastIndexOf("sink:memgate-verify-revoked");
			const teardownIdx = order.indexOf("teardownSandbox");
			const destroyIdx = order.indexOf("destroy");
			expect(verifyIdx).toBeGreaterThanOrEqual(0);
			expect(teardownIdx).toBeGreaterThanOrEqual(0);
			expect(destroyIdx).toBeGreaterThan(verifyIdx);
		} finally {
			// PIN the real function (see kg-recall-teardown.test.ts): a bare spread
			// of the live namespace re-restores the stub after bun's write-through.
			mock.module(TEARDOWN_MODULE, () => ({ ...realTeardownModule, teardownSandbox: realTeardownSandbox }));
			restoreLog();
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	// ── stage 6: negative — the un-granted role never even loads the extension ─

	test("stage 6: reviewer (un-granted) argv carries no kg-recall path anywhere", () => {
		const roster = parseRoster(readFileSync(ROSTER_PATH, "utf8"), ROSTER_PATH);
		const reviewer = roster.roles.find((r) => r.name === "reviewer");
		expect(reviewer).toBeDefined();
		if (!reviewer) return;

		const teamRole = rosterRoleToTeamRole(reviewer, { agentId: reviewer.name, prompt: "review prompt" });
		expect(teamRole.extensions).toBeUndefined(); // no grant surfaces at the adapter

		const argv = buildWorkerArgv({
			agentId: teamRole.agentId,
			provider: reviewer.provider,
			model: reviewer.model,
			prompt: teamRole.prompt,
			extensions: teamRole.extensions,
		});
		expect(argv.some((a) => a.includes("kg-recall"))).toBe(false); // no path, anywhere
		expect(argv).not.toContain("-e"); // and no extension loader token at all
	});
});
