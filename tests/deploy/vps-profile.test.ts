/**
 * Z4 deploy-profile contract tests (AC1/AC2/AC3/AC5/AC6/AC7).
 *
 * Parses the REAL deploy/vps/ artifacts from disk and refuses every forbidden
 * shape BY NAME (file + rule — the tests/gitnexus/cli-contract.ts naming
 * discipline). Every negative control is FIXTURE-BASED: violating variants are
 * built as in-test strings/objects and asserted refused — no real
 * deploy/vps/** artifact is ever mutated by any test. No docker daemon, no
 * network, no spend — pure file parsing.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const repoRoot = realpathSync(join(import.meta.dir, "..", ".."));
const vpsDir = join(repoRoot, "deploy", "vps");

const COMPOSE = readFileSync(join(vpsDir, "docker-compose.factory.yml"), "utf8");
const CADDY = readFileSync(join(vpsDir, "Caddyfile.factory.allowlist"), "utf8");
const HINDSIGHT_ENV = readFileSync(join(vpsDir, "env", "hindsight-qds.env.example"), "utf8");
const FACTORY_ENV = readFileSync(join(vpsDir, "env", "factory.env.example"), "utf8");

const PIN =
	"ghcr.io/vectorize-io/hindsight:0.10.0@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b";
const HOST_PUBLISH = "127.0.0.1:18890:8888";
const GATEWAY_UPSTREAM = "m2-gateway:8080";

/** Drop comment lines and trailing unquoted ` #` comments — the non-code text of a file. */
function stripComments(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("#") || trimmed.startsWith("//")) return "";
			const hash = line.indexOf(" #");
			return hash === -1 ? line : line.slice(0, hash);
		})
		.join("\n");
}

// ── AC1/AC2/AC7: compose validator ───────────────────────────────────────────

type Compose = {
	services?: Record<string, { image?: string; ports?: unknown[]; networks?: unknown; restart?: string }>;
	networks?: Record<string, { external?: boolean; name?: string }>;
};

/** Short-syntax port string or long-syntax object → host mapping info, or null (no host side). */
function asHostMap(entry: unknown): { text: string; hostIp: string; hostPort: string } | null {
	if (typeof entry === "string") {
		const parts = entry.split(":");
		if (parts.length === 1) return { text: entry, hostIp: "0.0.0.0", hostPort: parts[0]! };
		if (parts.length === 2) {
			// `host:container` with no host IP — docker defaults the bind to 0.0.0.0.
			return { text: entry, hostIp: "0.0.0.0", hostPort: parts[0]! };
		}
		if (parts.length === 3) return { text: entry, hostIp: parts[0]!, hostPort: parts[1]! };
		return null;
	}
	if (entry && typeof entry === "object") {
		const e = entry as Record<string, unknown>;
		if (e.published === undefined && e.host_port === undefined) return null;
		const port = String(e.published ?? e.host_port ?? "");
		const ip = e.host_ip === undefined ? "0.0.0.0" : String(e.host_ip);
		return { text: `${ip}:${port}:${String(e.target ?? e.container_port ?? "")}`, hostIp: ip, hostPort: port };
	}
	return null;
}

const PERIMETER_SERVICE_NAMES = /^(caddy|nginx|traefik|haproxy|envoy|certbot|tls-)/i;

/** Every AC1/AC2/AC7 refusal for a compose document, each naming file + rule. */
function validateCompose(text: string): string[] {
	const refusals: string[] = [];
	const file = "deploy/vps/docker-compose.factory.yml";
	let doc: Compose;
	try {
		doc = YAML.parse(text) as Compose;
	} catch (e) {
		return [`${file}: unparseable compose YAML (${(e as Error).message})`];
	}
	const services = doc.services ?? {};
	const names = Object.keys(services).sort();

	// AC1: exactly two services, exactly these names.
	const expected = ["hindsight-qds", "m2-gateway"];
	if (names.length !== 2 || names.join(",") !== expected.join(",")) {
		refusals.push(`AC1: compose must define exactly the two services ${expected.join(" + ")}, got ${names.join(", ") || "<none>"}`);
	}

	for (const [name, svc] of Object.entries(services)) {
		// AC2: pin discipline on every image ref.
		const image = svc.image ?? "";
		if (!image) refusals.push(`AC2: service ${name} has no image ref`);
		if (image.includes(":latest")) refusals.push(`AC2: service ${name} image ref uses :latest — ${image}`);
		const archSuffixed = /-(?:amd64|arm64|x86_64|aarch64)(?:@sha256:[0-9a-f]{64})?$/.test(image);
		if (archSuffixed) refusals.push(`AC2: service ${name} image ref is arch-suffixed (QEMU incident class) — ${image}`);
		if (name === "hindsight-qds" && image !== PIN) {
			refusals.push(`AC2: hindsight-qds image must be the fork pin byte-exact (${PIN}), got ${image || "<missing>"}`);
		}

		// AC1: ports discipline.
		const maps = (svc.ports ?? []).map(asHostMap).filter((m): m is NonNullable<typeof m> => m !== null);
		if (name === "hindsight-qds") {
			if (maps.length !== 1) {
				refusals.push(`AC1: hindsight-qds must have exactly one host publish, got ${maps.length}`);
			}
			for (const m of maps) {
				if (m.text !== HOST_PUBLISH) {
					refusals.push(`AC1: host publish must be exactly ${HOST_PUBLISH}, got ${m.text}`);
				}
				if (m.hostIp !== "127.0.0.1" && m.hostIp !== "::1") {
					refusals.push(`AC1/INV-Z4-1: host publish must bind loopback, got non-loopback host IP ${m.hostIp} in ${m.text}`);
				}
				if (m.hostPort === "8888" || m.hostPort === "18889") {
					refusals.push(`AC1/INV-Z4-1: host port ${m.hostPort} is forbidden (8888 collides with Hindsight's default; 18889 is the platform tenant stack's map) in ${m.text}`);
				}
			}
		}
		if (name === "m2-gateway" && (svc.ports ?? []).length > 0) {
			refusals.push(`AC1: m2-gateway publishes NO ports (its only public reach is the existing Caddy front door), got ${JSON.stringify(svc.ports)}`);
		}
		if (name === "m2-gateway" && svc.restart !== "no") {
			refusals.push(`AC8: m2-gateway restart must be "no" until M2.1's image is published (never green-by-default), got ${String(svc.restart)}`);
		}

		// AC7: no second perimeter — no proxy/TLS service of any name.
		if (PERIMETER_SERVICE_NAMES.test(name)) {
			refusals.push(`AC7: compose ships a second perimeter service "${name}" — extension of the existing front door, never its own proxy/TLS stack (charter §2.2)`);
		}
		for (const m of maps) {
			if (m.hostPort === "443" || m.hostPort === "80") {
				refusals.push(`AC7: service ${name} publishes perimeter port ${m.hostPort} (${m.text}) — 80/443 belong to the existing control-plane Caddy only`);
			}
		}

		// AC7/INV-Z4-1: hindsight-qds stays OFF the front-door network.
		if (name === "hindsight-qds") {
			const nets = svc.networks;
			const attached = Array.isArray(nets)
				? nets.map(String)
				: nets && typeof nets === "object"
					? Object.keys(nets)
					: [];
			if (attached.includes("front-door")) {
				refusals.push("AC7/INV-Z4-1: hindsight-qds must stay OFF the front-door network — the perimeter reaches the gateway only");
			}
		}
	}

	// AC7: the front-door network must be a declared EXTERNAL join, never created.
	const frontDoor = doc.networks?.["front-door"];
	if (!frontDoor) {
		refusals.push("AC7: compose must declare the front-door network (m2-gateway joins the existing control-plane perimeter)");
	} else {
		if (frontDoor.external !== true) {
			refusals.push("AC7: front-door network must be external: true — this compose creates nothing, it JOINs the existing perimeter");
		}
	}

	return refusals;
}

// ── AC3: Caddy fragment validator (line/regex level) ─────────────────────────

/** Every AC3/AC7 refusal for a Caddy fragment, each naming file + rule. */
function validateCaddy(text: string): string[] {
	const refusals: string[] = [];
	const file = "deploy/vps/Caddyfile.factory.allowlist";
	const code = stripComments(text);

	// AC3: exactly one host block; AC7: no second listener — a site address
	// naming :443/:80 or a global-options block would be a deployment, not a fragment.
	const blockLabels = [...code.matchAll(/^([^{}\s#][^{}]*)\{\s*$/gm)].map((m) => m[1]!.trim());
	const hostBlocks = blockLabels.filter((l) => !l.startsWith("@") && !l.startsWith("("));
	if (hostBlocks.length !== 1) {
		refusals.push(`AC3: ${file} must carry exactly ONE host block, got ${hostBlocks.length}: ${hostBlocks.join(", ") || "<none>"}`);
	}
	for (const label of hostBlocks) {
		if (/:(?:443|80)\b/.test(label)) {
			refusals.push(`AC7: host block "${label}" names a listener port — fragments add no listener; 80/443 stay the existing front door's`);
		}
	}

	// Named matcher rows (AC3 idiom) + the handles that consume them.
	const namedHandles = [...code.matchAll(/^[ \t]*handle\s+@(\w[\w-]*)\s*\{\s*$/gm)].map((m) => m[1]!);
	for (const h of namedHandles) {
		const matcher = new RegExp(`^[ \\t]*@${h}\\s*\\{[\\s\\S]*?^[ \\t]*\\}`, "m").exec(code);
		const body = matcher?.[0] ?? "";
		if (!matcher || !/^[ \t]*method\s+\S+/m.test(body) || !/[ \t]path\s+\S+/.test(body)) {
			refusals.push(`AC3: ${file} row @${h} must gate on an explicit method+path matcher (E09-GAP-01b/01c/01d idiom)`);
		}
	}
	const handleBodies = [...code.matchAll(/^[ \t]*handle(?:\s+@(\w[\w-]*))?\s*\{\s*$([\s\S]*?)[ \t]*\}\s*$/gm)];
	for (const [, named, handleBody] of handleBodies) {
		const body = handleBody ?? "";
		const proxies = [...body.matchAll(/^[ \t]*reverse_proxy\s+(\S+)/gm)].map((m) => m[1]!);
		for (const target of proxies) {
			if (target !== GATEWAY_UPSTREAM) {
				refusals.push(`AC3/INV-Z4-1: handle ${named ? `@${named}` : "(catch-all)"} forwards to ${target} — only ${GATEWAY_UPSTREAM} may be forwarded, never a hindsight service`);
			}
		}
		if (!named) {
			// The terminal default-404 tail: everything not listed is 404, not forwarded.
			if (proxies.length > 0 || !/^[ \t]*respond\s+404\s*$/m.test(body)) {
				refusals.push(`AC3: ${file} catch-all handle must \`respond 404\`, never proxy — the route table is NOT exhaustive by design; that is the point`);
			}
		}
	}
	if (!/^[ \t]*handle\s*\{\s*$/m.test(code)) {
		refusals.push(`AC3: ${file} must end in the terminal default-404 \`handle { respond 404 }\``);
	}
	return refusals;
}

// ── AC6: env template validator ──────────────────────────────────────────────

type EnvEntry = { key: string; value: string };
function parseEnv(text: string): EnvEntry[] {
	return [...stripComments(text).matchAll(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({
		key: m[1]!,
		value: (m[2] ?? "").trim(),
	}));
}

/** Placeholder = empty or <…>-wrapped. Anything else on a secret-named key is a literal credential. */
function isPlaceholder(value: string): boolean {
	return value === "" || /^<.*>$/.test(value);
}

const SECRET_NAME = /HINDSIGHT_API_|BEARER_TOKEN|HINDSIGHT_API_KEY/;

/** Every AC6 refusal for an env template; `expectedBase` pins its HINDSIGHT_BASE_URL origin. */
function validateEnvTemplate(text: string, file: string, expectedBase: string): string[] {
	const refusals: string[] = [];
	const entries = parseEnv(text);

	for (const { key, value } of entries) {
		if (SECRET_NAME.test(key) && !isPlaceholder(value)) {
			refusals.push(`AC6/INV-Z4-3: ${file} carries a literal credential value for ${key} — templates carry names, never values`);
		}
		if (key === "SOLSTICE_TENANT_ID") {
			refusals.push(`AC6/G3-G6: ${file} templates SOLSTICE_TENANT_ID — it stays the swarmclaw stack's .env.local item, never a key here`);
		}
		if (key === "HINDSIGHT_BASE_URL" && value !== expectedBase) {
			refusals.push(`AC6: ${file} HINDSIGHT_BASE_URL must be exactly ${expectedBase}, got ${value}`);
		}
	}
	// The annotation may NAME the fence item in a comment; a non-comment occurrence is templating.
	if (/(^|[^#\n])SOLSTICE_TENANT_ID/.test(stripComments(text)) && !entries.some((e) => e.key === "SOLSTICE_TENANT_ID")) {
		// occurrence outside comments but not as a KEY= line (e.g. a bare value) — still a leak
		refusals.push(`AC6/G3-G6: ${file} mentions SOLSTICE_TENANT_ID outside a comment`);
	}
	return refusals;
}

function requireKeys(text: string, file: string, keys: string[]): string[] {
	const present = new Set(parseEnv(text).map((e) => e.key));
	return keys
		.filter((k) => !present.has(k))
		.map((k) => `AC6: ${file} must name ${k}`);
}

// ── AC5: whole-tree driver-grammar scan ──────────────────────────────────────

/** `--driver exedev` occurrences in non-comment text, per file. */
function driverGrammarCounts(text: string): number {
	return stripComments(text).split("--driver exedev").length - 1;
}

function walkTree(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, name.name);
		if (name.isDirectory()) out.push(...walkTree(full));
		else out.push(full);
	}
	return out;
}

/** AC5 refusals over a {relativePath → content} map (real tree or fixtures). */
function scanDriverGrammar(files: Record<string, string>): string[] {
	const refusals: string[] = [];
	for (const [path, content] of Object.entries(files)) {
		const count = driverGrammarCounts(content);
		if (path === "deploy/vps/fleet-wrapper.sh") {
			if (count !== 1) refusals.push(`AC5/INV-Z4-2: fleet-wrapper.sh must hold --driver exedev exactly once (non-comment), got ${count}`);
		} else if (count > 0) {
			refusals.push(`AC5/INV-Z4-2: ${path} carries the --driver exedev grammar — the wrapper is the SOLE holder; swarmclaw never learns QDS's driver grammar (DF5.5 Amendment D)`);
		}
	}
	return refusals;
}

// ── real artifacts: positives ────────────────────────────────────────────────

describe("Z4 compose profile (AC1/AC2/AC7)", () => {
	it("the real compose produces zero refusals", () => {
		expect(validateCompose(COMPOSE)).toEqual([]);
	});

	it("AC1: exactly two services — hindsight-qds + m2-gateway, no others", () => {
		const doc = YAML.parse(COMPOSE) as Compose;
		expect(Object.keys(doc.services ?? {}).sort()).toEqual(["hindsight-qds", "m2-gateway"]);
	});

	it("AC2: hindsight-qds image is the fork pin byte-exact, under a provenance comment", () => {
		expect(COMPOSE).toContain(PIN);
		expect(COMPOSE).toContain("config/hindsight-version.txt");
		expect((YAML.parse(COMPOSE) as Compose).services?.["hindsight-qds"]?.image).toBe(PIN);
	});

	it("AC1: hindsight-qds has exactly one host publish, the loopback map", () => {
		const svc = (YAML.parse(COMPOSE) as Compose).services?.["hindsight-qds"];
		expect(svc?.ports).toEqual([HOST_PUBLISH]);
	});

	it("AC7: front-door network is an external join; hindsight-qds is not attached to it", () => {
		const doc = YAML.parse(COMPOSE) as Compose;
		expect(doc.networks?.["front-door"]).toMatchObject({ external: true });
		expect(doc.services?.["hindsight-qds"]?.networks ?? []).not.toContain("front-door");
		const gwNets = doc.services?.["m2-gateway"]?.networks ?? [];
		expect(gwNets).toContain("front-door");
		// A service naming any network joins ONLY those named — the gateway
		// must stay on `default` too or it loses hindsight-qds:8888.
		expect(gwNets).toContain("default");
	});
});

describe("Z4 Caddy fragment (AC3)", () => {
	it("the real fragment produces zero refusals", () => {
		expect(validateCaddy(CADDY)).toEqual([]);
	});

	it("AC3: exactly one host block with a replace-before-installing placeholder; forwards only POST /v1/recall to m2-gateway", () => {
		expect(CADDY).toMatch(/<[^\s>]+>/); // hostname placeholder — replace before installing
		expect(CADDY).toMatch(/method\s+POST/);
		expect(CADDY).toMatch(/path\s+\/v1\/recall/);
		expect(CADDY).toContain(`reverse_proxy ${GATEWAY_UPSTREAM}`);
		expect(CADDY).toContain("respond 404");
		expect(CADDY).toContain("M2.1"); // M2.1 widens the row set, stated
	});
});

describe("Z4 env templates (AC6)", () => {
	it("both real templates produce zero refusals", () => {
		expect(validateEnvTemplate(HINDSIGHT_ENV, "deploy/vps/env/hindsight-qds.env.example", "http://127.0.0.1:18890")).toEqual([]);
		expect(validateEnvTemplate(FACTORY_ENV, "deploy/vps/env/factory.env.example", "http://hindsight-qds:8888")).toEqual([]);
	});

	it("AC6: hindsight template names the two secret keys + the 18890 host-side origin, and NO provider/model pins", () => {
		const missing = requireKeys(HINDSIGHT_ENV, "hindsight-qds.env.example", [
			"HINDSIGHT_API_TENANT_API_KEY",
			"HINDSIGHT_API_LLM_API_KEY",
			"HINDSIGHT_BASE_URL",
		]);
		expect(missing).toEqual([]);
		expect(HINDSIGHT_ENV).toMatch(/HINDSIGHT_BASE_URL=http:\/\/127\.0\.0\.1:18890\b/);
		expect(HINDSIGHT_ENV).not.toMatch(/^HINDSIGHT_API_LLM_PROVIDER=/m);
		expect(HINDSIGHT_ENV).not.toMatch(/^HINDSIGHT_API_LLM_MODEL=/m);
		expect(HINDSIGHT_ENV).not.toMatch(/^HINDSIGHT_API_RERANKER_PROVIDER=/m);
	});

	it("AC6: factory template carries the dedicated compose-network origin + all required names, never the §6.3 shared-sidecar value", () => {
		const missing = requireKeys(FACTORY_ENV, "factory.env.example", [
			"HINDSIGHT_BASE_URL",
			"HINDSIGHT_BEARER_TOKEN",
			"HINDSIGHT_API_KEY",
			"SWARMCLAW_COMMAND_ALLOWLIST",
			"SWARMCLAW_NPX_PACKAGE_ALLOWLIST",
			"SWARMCLAW_ARG_POLICY",
			"SWARMCLAW_ENV_ALLOWLIST",
			"QDS_RUNS_DIR",
			"QDS_FACTORY_OWNER",
			"M2_GATEWAY_TAG",
			"FACTORY_FRONT_DOOR_NETWORK",
		]);
		expect(missing).toEqual([]);
		expect(FACTORY_ENV).toMatch(/HINDSIGHT_BASE_URL=http:\/\/hindsight-qds:8888\b/);
		// The §6.3 shared-sidecar value never appears; the host-side 18890 origin
		// is annotation-only (comments), never a templated value.
		expect(stripComments(FACTORY_ENV)).not.toContain("127.0.0.1:8888");
		expect(parseEnv(FACTORY_ENV).filter((e) => e.value.includes("18890") || e.value.includes("18889"))).toEqual([]);
	});
});

describe("AC5: driver-grammar tree scan", () => {
	it("the whole deploy/vps tree holds --driver exedev exactly once — in fleet-wrapper.sh", () => {
		const files: Record<string, string> = {};
		for (const abs of walkTree(vpsDir)) {
			files[abs.slice(repoRoot.length + 1)] = readFileSync(abs, "utf8");
		}
		expect(Object.keys(files).length).toBeGreaterThanOrEqual(5);
		expect(Object.keys(files)).toContain("deploy/vps/fleet-wrapper.sh");
		expect(scanDriverGrammar(files)).toEqual([]);
	});

	it("AC5 negative control: a fixture env line exporting the flag to the fork env is refused by name", () => {
		const leaks = scanDriverGrammar({
			"deploy/vps/env/factory.env.example": "SWARMCLAW_FACTORY_FLEET_FLAGS=--driver exedev\n",
		});
		expect(leaks).toHaveLength(1);
		expect(leaks[0]).toContain("deploy/vps/env/factory.env.example");
		expect(leaks[0]).toContain("AC5/INV-Z4-2");
	});
});

// ── negative controls: FIXTURE-BASED, never by editing real files ────────────

/** Minimal valid two-service compose text with a replaceable ports block. */
function baseCompose(ports: string): string {
	return [
			"services:",
			"  hindsight-qds:",
			`    image: ${PIN}`,
			"    ports:",
			ports,
			"  m2-gateway:",
			"    image: ghcr.io/o/qds-m2-gateway:t",
			'    restart: "no"',
			"networks:",
		"  front-door:",
		"    external: true",
	].join("\n");
}

describe("AC1 negative controls (compose fixtures)", () => {
	it("refuses any non-loopback host IP", () => {
		const r = validateCompose(baseCompose('      - "0.0.0.0:18890:8888"'));
		expect(r.some((x) => x.startsWith("AC1/INV-Z4-1: host publish must bind loopback") && x.includes("0.0.0.0"))).toBe(true);
	});

	it("refuses a second host-port mapping beyond the single loopback map", () => {
		const r = validateCompose(baseCompose('      - "127.0.0.1:18890:8888"\n      - "127.0.0.1:9000:8888"'));
		expect(r.some((x) => x.includes("exactly one host publish, got 2"))).toBe(true);
		expect(r.some((x) => x.startsWith("AC1: host publish must be exactly 127.0.0.1:18890:8888") && x.includes("127.0.0.1:9000:8888"))).toBe(true);
	});

	it("refuses ANY mapping on host port 8888 or 18889", () => {
		for (const port of ["8888", "18889"]) {
			const r = validateCompose(baseCompose(`      - "127.0.0.1:${port}:8888"`));
			expect(r.some((x) => x.includes(`host port ${port} is forbidden`)), `port ${port}`).toBe(true);
		}
	});

	it("refuses a public exposure of 18889 end to end (non-loopback AND wrong port, both named)", () => {
		const r = validateCompose(baseCompose('      - "0.0.0.0:18889:8888"'));
		expect(r.some((x) => x.includes("non-loopback host IP 0.0.0.0"))).toBe(true);
		expect(r.some((x) => x.includes("host port 18889 is forbidden"))).toBe(true);
		expect(r.some((x) => x.startsWith("AC1: host publish must be exactly"))).toBe(true);
	});
});

describe("AC2 negative controls (pin fixtures)", () => {
	it("refuses an arch-specific digest ref (the QEMU-on-Apple-Silicon incident class)", () => {
		const archPin =
			"ghcr.io/vectorize-io/hindsight:0.10.0-linux-amd64@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b";
		const r = validateCompose(
			[
				"services:",
				"  hindsight-qds:",
				`    image: ${archPin}`,
				`    ports: ["${HOST_PUBLISH}"]`,
				"  m2-gateway:",
				"    image: ghcr.io/o/qds-m2-gateway:t",
				'    restart: "no"',
				"networks:",
				"  front-door:",
				"    external: true",
			].join("\n"),
		);
		expect(r.some((x) => x.includes("AC2") && x.includes("arch-suffixed"))).toBe(true);
		expect(r.some((x) => x.includes("byte-exact"))).toBe(true);
	});

	it("refuses a :latest ref anywhere in the profile", () => {
		const r = validateCompose([
			"services:",
			"  hindsight-qds:",
			`    image: ${PIN}`,
			`    ports: ["${HOST_PUBLISH}"]`,
			"  m2-gateway:",
			"    image: ghcr.io/o/qds-m2-gateway:latest",
			'    restart: "no"',
			"networks:",
			"  front-door:",
			"    external: true",
		].join("\n"));
		expect(r.some((x) => x.includes("m2-gateway image ref uses :latest"))).toBe(true);
	});
});

describe("AC3 negative controls (Caddy fixtures)", () => {
	it("refuses a row forwarding a hindsight path to a hindsight service", () => {
		const r = validateCaddy(
			[
				"factory.example.com {",
				"	@memories {",
				"		method POST",
				"		path /v1/memories",
				"	}",
				"	handle @memories {",
				"		reverse_proxy hindsight-qds:8888",
				"	}",
				"	handle {",
				"		respond 404",
				"	}",
				"}",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC3/INV-Z4-1") && x.includes("hindsight-qds:8888"))).toBe(true);
	});

	it("refuses a catch-all handle that proxies instead of 404ing", () => {
		const r = validateCaddy(
			[
				"factory.example.com {",
				"	@recall {",
				"		method POST",
				"		path /v1/recall",
				"	}",
				"	handle @recall {",
				`		reverse_proxy ${GATEWAY_UPSTREAM}`,
				"	}",
				"	handle {",
				`		reverse_proxy ${GATEWAY_UPSTREAM}`,
				"	}",
				"}",
			].join("\n"),
		);
		expect(r.some((x) => x.includes("catch-all handle must `respond 404`, never proxy"))).toBe(true);
	});

	it("refuses a second listener (a :443 site address) — fragment, not deployment", () => {
		const r = validateCaddy(
			[
				"factory.example.com:443 {",
				"	handle {",
				"		respond 404",
				"	}",
				"}",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC7") && x.includes("names a listener port"))).toBe(true);
	});
});

describe("AC6 negative controls (env fixtures)", () => {
	it("refuses a template carrying a literal credential value", () => {
		const r = validateEnvTemplate("HINDSIGHT_API_LLM_API_KEY=sk-or-v1-realtoken123\n", "fixture.env", "http://127.0.0.1:18890");
		expect(r).toHaveLength(1);
		expect(r[0]).toContain("AC6/INV-Z4-3");
		expect(r[0]).toContain("HINDSIGHT_API_LLM_API_KEY");
	});

	it("refuses a real bearer-token value", () => {
		const r = validateEnvTemplate("HINDSIGHT_BEARER_TOKEN=real-secret-value\n", "fixture.env", "http://hindsight-qds:8888");
		expect(r[0]).toContain("literal credential value for HINDSIGHT_BEARER_TOKEN");
	});

	it("refuses any templated SOLSTICE_TENANT_ID", () => {
		const r = validateEnvTemplate("SOLSTICE_TENANT_ID=t-123\n", "fixture.env", "http://hindsight-qds:8888");
		expect(r[0]).toContain("AC6/G3-G6");
		expect(r[0]).toContain("SOLSTICE_TENANT_ID");
	});

	it("refuses a host-side origin of anything but http://127.0.0.1:18890 — 18889 and 127.0.0.1:8888 included", () => {
		for (const bad of ["http://127.0.0.1:18889", "http://127.0.0.1:8888", "http://hindsight-qds:8888"]) {
			const r = validateEnvTemplate(`HINDSIGHT_BASE_URL=${bad}\n`, "fixture.env", "http://127.0.0.1:18890");
			expect(r.some((x) => x.includes("must be exactly http://127.0.0.1:18890") && x.includes(bad)), bad).toBe(true);
		}
	});

	it("refuses the factory-side origin pointing at the §6.3 shared-sidecar value (R2 trap #7)", () => {
		const r = validateEnvTemplate("HINDSIGHT_BASE_URL=http://127.0.0.1:8888\n", "fixture.env", "http://hindsight-qds:8888");
		expect(r[0]).toContain("must be exactly http://hindsight-qds:8888");
	});
});

describe("AC7 negative controls (one-perimeter fixtures)", () => {
	it("refuses a third perimeter service (its own caddy)", () => {
		const r = validateCompose(
			[
				"services:",
				"  hindsight-qds:",
				`    image: ${PIN}`,
				`    ports: ["${HOST_PUBLISH}"]`,
				"  m2-gateway:",
				"    image: ghcr.io/o/qds-m2-gateway:t",
				'    restart: "no"',
				"  caddy:",
				"    image: caddy:2-alpine",
				"    ports:",
				'      - "443:443"',
				"networks:",
				"  front-door:",
				"    external: true",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC7") && x.includes('second perimeter service "caddy"'))).toBe(true);
		expect(r.some((x) => x.includes("perimeter port 443"))).toBe(true);
	});

	it("refuses any m2-gateway ports block on an otherwise-valid two-service compose", () => {
		const r = validateCompose(
			[
				"services:",
				"  hindsight-qds:",
				`    image: ${PIN}`,
				`    ports: ["${HOST_PUBLISH}"]`,
				"  m2-gateway:",
				"    image: ghcr.io/o/qds-m2-gateway:t",
				'    restart: "no"',
				"    ports:",
				'      - "127.0.0.1:8443:8080"',
				"networks:",
				"  front-door:",
				"    external: true",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC1") && x.includes("publishes NO ports"))).toBe(true);
	});
});
