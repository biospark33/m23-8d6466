#!/usr/bin/env bun
/**
 * coms-smoke-test — P0.2 coms viability smoke test (subprocess-RPC + socket-coms).
 *
 * Exercises BOTH Pi agent messaging substrates against pinned `pi@0.55.0`:
 *
 *   Path A — subprocess-RPC (`pi --mode json -p`): spawns a headless pi and
 *            parses its JSON event stream. This is the day-1 default path and
 *            needs NO vendored coms.ts. Transport parse is always verified; the
 *            live model turn is only asserted when pi auth is available (the
 *            harness auto-skips it otherwise — never fabricated).
 *
 *   Path B — socket-coms: verifies the vendored coms.ts extension loads on
 *            pi 0.55.0 (AC3, `pi -e ./coms.ts --list-models`), then exercises
 *            the peer registry contract the extension itself uses
 *            (~/.pi/coms/projects/<project>/agents/<name>.json write → discover)
 *            inside an ISOLATED PI_COMS_DIR so real per-user coms is untouched.
 *
 * Emits a single structured JSON report to stdout: agents registered + messages
 * exchanged per path, plus an AC map. Exit 0 iff every make-or-break check that
 * can run under current auth actually passed.
 *
 * INV-1: no real API keys are read, written, or logged — the live turn uses
 *        whatever auth pi already holds and this script never touches secrets.
 * INV-2: registry writes go to a per-run temp PI_COMS_DIR (0700), so there is
 *        no cross-user leakage and the host's ~/.pi/coms is never mutated.
 *
 * Usage: bun scripts/coms-smoke-test.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const VENDOR_DIR = path.join(import.meta.dir, "..", "pi-vs-claude-code-vendor");
const COMS_EXT = path.join(VENDOR_DIR, "coms.ts");
const PIN = "0.55.0";

type Check = { name: string; ok: boolean; skipped?: string; detail?: string };
const checks: Check[] = [];
const record = (c: Check): Check => {
	checks.push(c);
	return c;
};

// ── pi presence + version pin (AC precondition) ─────────────────────────────
function checkPiVersion(): string | null {
	const r = spawnSync("pi", ["--version"], { encoding: "utf8" });
	const version = (r.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
	record({
		name: "pi_version_pin",
		ok: version === PIN,
		detail: `found "${version}", expected "${PIN}"`,
	});
	return version === PIN ? version : null;
}

// ── AC3: vendored coms.ts loads on pinned pi (`-e ./coms.ts --list-models`) ──
function checkExtensionLoads(): number {
	const r = spawnSync("pi", ["-e", COMS_EXT, "--list-models"], {
		encoding: "utf8",
		cwd: VENDOR_DIR,
	});
	const modelCount = (r.stdout ?? "")
		.split("\n")
		.filter((l) => /^(anthropic|openrouter|openai|google)\s/.test(l)).length;
	record({
		name: "ac3_extension_loads",
		ok: r.status === 0 && modelCount > 0,
		detail: `exit=${r.status}, models_listed=${modelCount}`,
	});
	return r.status === 0 ? modelCount : 0;
}

// ── Path A: subprocess-RPC JSON event stream ────────────────────────────────
function pathSubprocessRpc(): { registered: number; exchanged: number } {
	// A "registered" agent on this path = one spawned pi subprocess whose JSON
	// stream opened (the session header is the RPC handshake). We spawn two.
	let registered = 0;
	let exchanged = 0;
	let liveTurn = false;
	let authAvailable = true;

	for (const cname of ["smoke-rpc-a", "smoke-rpc-b"]) {
		const r = spawnSync(
			"pi",
			["--mode", "json", "-p", `You are ${cname}. Reply with exactly: ok`],
			{ encoding: "utf8", cwd: VENDOR_DIR, timeout: 60_000 },
		);
		const lines = (r.stdout ?? "").split("\n").filter(Boolean);
		const events: Array<{ type?: string }> = [];
		for (const l of lines) {
			try {
				events.push(JSON.parse(l));
			} catch {
				// non-JSON line — ignored, must not crash the parser
			}
		}
		const hasSession = events.some((e) => e.type === "session");
		if (hasSession) registered += 1;
		// A completed round-trip needs a real model turn (agent_end).
		if (events.some((e) => e.type === "agent_end")) {
			exchanged += 1;
			liveTurn = true;
		}
		if (/Authentication failed/i.test(r.stderr ?? "")) authAvailable = false;
	}

	record({
		name: "rpc_stream_parse",
		ok: registered >= 2,
		detail: `${registered}/2 subprocess JSON streams opened & parsed`,
	});

	if (liveTurn) {
		record({
			name: "rpc_live_round_trip",
			ok: exchanged >= 1,
			detail: `${exchanged} agent_end round-trip(s)`,
		});
	} else {
		record({
			name: "rpc_live_round_trip",
			ok: true,
			skipped: authAvailable
				? "TODO(goal): no agent_end observed and no auth error — treated as unavailable"
				: "TODO(goal): pi auth unavailable — live model turn not exercised",
			detail: "transport parse verified; live turn requires pi auth",
		});
	}

	return { registered, exchanged };
}

// ── Path B: socket-coms peer registry contract (isolated PI_COMS_DIR) ────────
interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
}

function pathSocketComs(): { registered: number; exchanged: number } {
	// INV-2: isolate to a per-run temp dir so the host ~/.pi/coms is untouched.
	const comsDir = `${fs.mkdtempSync(path.join(os.tmpdir(), "coms-smoke-"))}/coms`;
	try {
		const project = "smoketest";
		const agentsDir = path.join(comsDir, "projects", project, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.chmodSync(comsDir, 0o700); // per-user scope

		// Write two peers in the exact on-disk shape coms.ts uses (writeRegistryAtomic).
		const mkEntry = (name: string, n: number): RegistryEntry => ({
			session_id: `01SMOKE${n}0000000000000000000`,
			name,
			purpose: `smoke peer ${n}`,
			model: "smoke/none",
			color: "#72F1B8",
			pid: process.pid,
			endpoint: path.join(comsDir, "sockets", `smoke-${n}.sock`),
			cwd: VENDOR_DIR,
			started_at: new Date().toISOString(),
			explicit: false,
			version: 1,
		});
		for (const [i, name] of ["smoke-a", "smoke-b"].entries()) {
			const entry = mkEntry(name, i + 1);
			const final = path.join(agentsDir, `${name}.json`);
			const tmp = `${final}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
			fs.renameSync(tmp, final); // atomic, matches coms.ts
		}

		// Discover peers back the way coms_list does (readAllRegistryEntries).
		const discovered: RegistryEntry[] = [];
		for (const f of fs.readdirSync(agentsDir)) {
			if (!f.endsWith(".json")) continue;
			const parsed = JSON.parse(
				fs.readFileSync(path.join(agentsDir, f), "utf8"),
			) as RegistryEntry;
			if (typeof parsed.session_id === "string") discovered.push(parsed);
		}

		// NOTE: this is registry/envelope-shape coverage only — it builds a
		// prompt envelope in-process and round-trips it through JSON.stringify/
		// parse without ever sending it over a real coms.ts socket to a live
		// peer. It must NOT count as a "message exchanged": only a real
		// coms_send → coms_await exchange between two live peers proves the
		// transport works, and AC1 must not be satisfiable by this fake alone.
		const target = discovered[0];
		const envelope = {
			type: "prompt" as const,
			msg_id: "01SMOKEMSG0000000000000000",
			sender_name: "smoke-a",
			target: target?.name,
			prompt: "ping",
			conversation_id: null,
			response_schema: { type: "object", properties: { ok: { type: "boolean" } } },
			hops: 0,
		};
		const wire = JSON.stringify(envelope);
		const roundTripped = JSON.parse(wire) as typeof envelope;
		// response_schema is parse-only: JSON.parse of a reply, NOT schema-validated.
		const reply = JSON.parse('{"ok":true}') as Record<string, unknown>;
		const shapeOk = roundTripped.target === target?.name && reply.ok === true;

		// INV-2 assertion: nothing leaked outside the isolated dir.
		const leaked = !comsDir.startsWith(os.tmpdir());

		record({
			name: "socket_registry_two_agents",
			ok: discovered.length >= 2,
			detail: `${discovered.length} peers registered & discovered in isolated registry`,
		});
		record({
			name: "socket_envelope_shape_coverage",
			ok: shapeOk,
			detail: `coms_send envelope shape round-tripped through JSON for peer "${target?.name}" ` +
				`(registry/shape coverage only — no live peer exchange, does not count toward messages_exchanged/AC1)`,
		});
		record({
			name: "inv2_per_user_isolation",
			ok: !leaked,
			detail: `registry confined to ${comsDir}`,
		});

		return { registered: discovered.length, exchanged: 0 };
	} finally {
		// comsDir is a subdir of the mkdtempSync root — remove the root so the
		// per-run temp dir doesn't leak on every smoke test run, even on throw.
		fs.rmSync(path.dirname(comsDir), { recursive: true, force: true });
	}
}

// ── Run ─────────────────────────────────────────────────────────────────────
const pinnedVersion = checkPiVersion();
const modelsListed = pinnedVersion ? checkExtensionLoads() : 0;
const rpc = pathSubprocessRpc();
const socket = pathSocketComs();

const totalRegistered = rpc.registered + socket.registered;
const totalExchanged = rpc.exchanged + socket.exchanged;
// Make-or-break (AC1): ≥2 agents registered AND ≥1 message exchanged on ≥1 path.
const acMakeOrBreak = totalRegistered >= 2 && totalExchanged >= 1;

const report = {
	story: "p0-2-coms-vendor-decision",
	pi_version: pinnedVersion ?? "MISMATCH",
	pinned: pinnedVersion === PIN,
	models_listed: modelsListed,
	paths: {
		subprocess_rpc: rpc,
		socket_coms: socket,
	},
	agents_registered: totalRegistered,
	messages_exchanged: totalExchanged,
	ac_map: {
		"AC1_make_or_break_>=2agents_>=1msg": acMakeOrBreak,
		AC3_extension_loads: checks.find((c) => c.name === "ac3_extension_loads")?.ok ?? false,
	},
	checks,
	// hard-fail only on checks that ran (skipped live-turn does not fail the gate)
	pass: checks.every((c) => c.ok || c.skipped) && acMakeOrBreak,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
