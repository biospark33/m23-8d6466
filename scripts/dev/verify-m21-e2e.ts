#!/usr/bin/env bun
/**
 * M2.1 e2e demo verifier (node-1 branch gate).
 *
 * Runs the DoD-mandated mock-mode closed loop with NO network, NO VPS, NO box:
 *   mint → deliver (env file) → scoped recall (mock client) → capture → revoke → verify-refused
 * plus the refusal arms the story pins (scope-bank, scope-verb, unknown-key, expired).
 *
 * Prints `M21 E2E OK` and exits 0 only when every step holds; on any failure it
 * names the step and exits nonzero. Driver artifact — see .unlazy/m2-1/PLAN.md (D5).
 * Gateway ops are SYNC (leaf-1 API: memgateDeps({env, ledgerPath, client, ...});
 * admin/signing keys ride env-by-name). R3-BH-6: the body runs under a bracket
 * so ANY exit path — fail, throw, crash — still closes the ledger and rmSync's
 * the tmpdir (the delivered env file carries key material; never abandoned).
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_KEY = "m21-e2e-admin-sentinel-0123456789abcdef";
const SIGNING_KEY = "m21-e2e-signing-sentinel-0123456789abcdef";
const BANK = "qds-factory-dev-meta";
const OTHER_BANK = "qds-factory-not-this-bank";
const RUN_ID = "00000000-0000-4000-8000-0000000000e2";
const REQUEST_ID = "m21-e2e-req-1";

/** R3-BH-6: fail THROWS — the top-level bracket does the cleanup, not process.exit. */
function fail(step: string, detail: unknown): never {
	throw new Error(`M21 E2E FAIL at ${step}: ${String(detail)}`);
}

let dir: string | undefined;
let ledger: { close(): void } | undefined;
try {
	const memgate = await import("../../src/memgate/index.ts").catch((e) =>
		fail("import src/memgate", e),
	);

	dir = mkdtempSync(join(tmpdir(), "qds-m21-e2e-"));
	const ledgerPath = join(dir, "memgate-ledger.db");
	const envFile = join(dir, "app.env");

	// Plain-object structural fake of the HindsightClient surface the gateway
	// forwards to — canned bodies, call recorder, no network anywhere.
	const clientCalls: string[] = [];
	const client = {
		recall: (bankId: string, _query?: string, _limit?: number) => {
			clientCalls.push(`recall:${bankId}`);
			return Promise.resolve({
				results: [{ memoryId: "m1", content: "mock", score: 1, documentId: RUN_ID }],
				durationMs: 1,
			});
		},
		reflect: (bankId: string) => {
			clientCalls.push(`reflect:${bankId}`);
			return Promise.resolve({ bankId, insights: [{ summary: "mock" }], durationMs: 1 });
		},
		consolidate: (bankId: string) => {
			clientCalls.push(`consolidate:${bankId}`);
			return Promise.resolve({ banksConsolidated: 1, memoriesConsolidated: 0, durationMs: 1 });
		},
		retain: (bankId: string) => {
			clientCalls.push(`retain:${bankId}`);
			return Promise.resolve({ success: true, items_count: 1, async: false });
		},
	};

	async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			return fail(name, e);
		}
	}

	const deps = await step("deps", () =>
		memgate.memgateDeps({
			env: {
				MEMGATE_ADMIN_KEY: ADMIN_KEY,
				QDS_MEMGATE_SIGNING_KEY: SIGNING_KEY,
				QDS_MEMGATE_LEDGER: ledgerPath,
			},
			ledgerPath,
			client,
			log: () => {}, // silent; the suites cover log shape
		}),
	);
	ledger = deps.ledger; // R3-BH-6: the finally bracket closes it on every path

	// 1. mint (TTL inside the backstop) — admin-gated op, sync
	const minted = await step("mint", () =>
		memgate.mintRunMemoryKey(deps, { runId: RUN_ID, banks: [BANK], ttlMs: 60_000, requestId: REQUEST_ID }),
	);
	if (!minted.keyMaterial || minted.keyMaterial.length < 16) fail("mint", "no key material");

	// 2. deliver → env file with EXACTLY the two registered wire entries, 0600
	await step("deliver", () => {
		memgate.deliverRunKey(deps, {
			runId: RUN_ID,
			target: envFile,
			keyMaterial: minted.keyMaterial,
			gatewayUrl: "http://127.0.0.1:8080",
			requestId: REQUEST_ID,
		});
	});
	const entries: Record<string, string> = {};
	for (const line of readFileSync(envFile, "utf8").split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) entries[line.slice(0, i)] = line.slice(i + 1);
	}
	if (Object.keys(entries).length !== 2) fail("deliver", `expected 2 entries, got ${Object.keys(entries).length}`);
	if (entries.QDS_KG_RECALL_KEY !== minted.keyMaterial) fail("deliver", "key entry mismatch");
	if (!entries.QDS_KG_GATEWAY_URL) fail("deliver", "gateway url entry missing");
	const mode = statSync(envFile).mode & 0o777;
	if (mode !== 0o600) fail("deliver", `env file mode ${mode.toString(8)}, not 0600`);

	// 3. verify + scoped recall through the mock client (the front-door round trip)
	const recallPath = `/v1/default/banks/${BANK}/memories/recall`;
	const ok = await step("verify(ok arm)", () =>
		memgate.verifyRequest(deps, {
			authHeader: `Bearer ${minted.keyMaterial}`,
			method: "POST",
			path: recallPath,
			requestId: REQUEST_ID,
		}),
	);
	if (!ok.ok) fail("verify(ok arm)", JSON.stringify(ok));
	// F-015: the promise is awaited INSIDE the step framing — a forward fault is a
	// named step failure, not an unhandled rejection past the clientCalls check.
	await step("forwardScoped", () =>
		memgate.forwardScoped(deps, ok.principal, "POST", recallPath, { query: "canary", limit: 5 }, REQUEST_ID),
	);
	if (clientCalls.length !== 1 || clientCalls[0] !== `recall:${BANK}`)
		fail("forwardScoped", `client calls: ${clientCalls.join(",")}`);

	// 4. refusal arms — every one fail-closed with its TYPED reason (R2-F-008);
	// invalid credentials stay inside `no-auth` with authOutcome detail (D3)
	const arms: Array<[string, string | undefined, string, string, string]> = [
		["scope-bank", `Bearer ${minted.keyMaterial}`, "POST", `/v1/default/banks/${OTHER_BANK}/memories/recall`, "scope-bank"],
		["scope-verb-per-run", `Bearer ${minted.keyMaterial}`, "POST", `/v1/default/banks/${BANK}/reflect`, "scope-verb"],
		["unknown-key", "Bearer not-a-real-key-aaaaaaaaaaaaaaaa", "POST", recallPath, "no-auth"],
		["no-auth", undefined, "POST", recallPath, "no-auth"],
	];
	for (const [name, header, method, path, expectedReason] of arms) {
		const r = await step(`refusal ${name}`, () =>
			memgate.verifyRequest(deps, { authHeader: header, method, path, requestId: REQUEST_ID }),
		);
		if (r.ok) fail(`refusal ${name}`, "unexpectedly ok");
		if (r.reason !== expectedReason) fail(`refusal ${name}`, `reason ${r.reason}, expected ${expectedReason}`);
	}

	// 5. capture = the pre-revoke state read (D2): issuance present, not yet revoked
	const before = await step("capture", () => deps.ledger.getIssuance(minted.tokenId));
	if (!before || before.kind !== "per-run") fail("capture", "issuance row missing");
	if (deps.ledger.isRevoked(minted.tokenId)) fail("capture", "already revoked pre-revoke");

	// 6. revoke → verify-refused (revoked), then already-gone on repeat (admin-gated, sync)
	const outcome = await step("revoke", () =>
		memgate.revokeRunMemoryKey(deps, { tokenId: minted.tokenId, requestId: REQUEST_ID }),
	);
	if (outcome !== "revoked") fail("revoke", outcome);
	const after = await step("verify(revoked arm)", () =>
		memgate.verifyRequest(deps, {
			authHeader: `Bearer ${minted.keyMaterial}`,
			method: "POST",
			path: recallPath,
			requestId: REQUEST_ID,
		}),
	);
	if (after.ok) fail("verify(revoked arm)", "unexpectedly ok");
	if (after.reason !== "revoked") fail("verify(revoked arm)", `reason ${after.reason}, expected revoked`);
	const repeat = await step("revoke(repeat)", () =>
		memgate.revokeRunMemoryKey(deps, { tokenId: minted.tokenId, requestId: REQUEST_ID }),
	);
	if (repeat !== "already-gone") fail("revoke(repeat)", repeat);

	// 7. TTL backstop pre-issuance (admin op refused before any state change) —
	// the thrown error must be the TYPED mint refusal, not any random crash (R2-F-004)
	const rowsBefore = deps.ledger.listIssued().length;
	try {
		memgate.mintRunMemoryKey(deps, { runId: `${RUN_ID}-big`, banks: [BANK], ttlMs: 86_400_000 + 1, requestId: REQUEST_ID });
		fail("ttl-backstop", "above-backstop mint unexpectedly accepted");
	} catch (e) {
		if (!(e instanceof memgate.MemgateError)) fail("ttl-backstop", `not a MemgateError: ${String(e)}`);
		if (e.code !== "mint-invalid-ttl") fail("ttl-backstop", `code ${e.code}, expected mint-invalid-ttl`);
	}
	if (deps.ledger.listIssued().length !== rowsBefore) fail("ttl-backstop", "refusal changed state");

	// 8. expiry arm: mint a 1 ms key, let the clock pass it
	const expired = await step("mint(expiry arm)", () =>
		memgate.mintRunMemoryKey(deps, { runId: `${RUN_ID}-x`, banks: [BANK], ttlMs: 1, requestId: REQUEST_ID }),
	);
	await new Promise((r) => setTimeout(r, 5));
	const exp = await step("verify(expired arm)", () =>
		memgate.verifyRequest(deps, {
			authHeader: `Bearer ${expired.keyMaterial}`,
			method: "POST",
			path: recallPath,
			requestId: REQUEST_ID,
		}),
	);
	if (exp.ok) fail("verify(expired arm)", "unexpectedly ok");
	if (exp.reason !== "expired") fail("verify(expired arm)", `reason ${exp.reason}, expected expired`);

	console.log("M21 E2E OK");
} catch (e) {
	console.error(e instanceof Error ? e.message : `M21 E2E FAIL: ${String(e)}`);
	process.exitCode = 1;
} finally {
	try { ledger?.close(); } catch { /* best-effort — cleanup never masks the verdict */ }
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); // R3-BH-6: key material never abandoned
}
