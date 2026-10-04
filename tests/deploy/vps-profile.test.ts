/**
 * Z4 deploy-profile contract tests (AC1/AC2/AC3/AC5/AC6/AC7).
 *
 * Parses the REAL deploy/vps/ artifacts from disk and refuses every forbidden
 * shape BY NAME (file + line + rule — the tests/gitnexus/cli-contract.ts
 * naming discipline; the story's Observability Contract). Every negative
 * control is FIXTURE-BASED: violating variants are built as in-test
 * strings/objects and asserted refused — no real deploy/vps/** artifact is
 * ever mutated by any test. No docker daemon, no network, no spend — pure
 * file parsing.
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
// F-002: the runbook joins the positive AC5 scan map (repo-root-relative).
const RUNBOOK_PATH = "_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md";

const PIN =
	"ghcr.io/vectorize-io/hindsight:0.10.0@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b";
const HOST_PUBLISH = "127.0.0.1:18890:8888";
const GATEWAY_UPSTREAM = "m2-gateway:8080";

// ── per-grammar comment stripping (F-025) ────────────────────────────────────
// Docker env_file / compose env_file values do NOT support inline comments
// (full-line `#` only), while sh and Caddyfile do. Stripping ` #` from env
// values truncated legitimate data — false refusals, or worse, false
// cleanliness in the leak scan.

/** sh grammar: full-line `#`/`//` comments AND trailing unquoted ` #` (F-015:
 * `\s#` — a TAB-# comment strips too, not just space-#). */
function stripShComments(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("#") || trimmed.startsWith("//")) return "";
			const hash = line.search(/\s#/);
			return hash === -1 ? line : line.slice(0, hash);
		})
		.join("\n");
}

/** Caddy grammar: the same comment rules as sh (leading `#`, trailing ` #`). */
const stripCaddyComments = stripShComments;

/** env_file grammar: full-line `#` ONLY — a ` #` inside a VALUE is data. */
function stripEnvComments(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trimStart().startsWith("#") ? "" : line))
		.join("\n");
}

/** 1-based first line of `text` containing `needle`, else 0 (F-014). */
function lineOf(text: string, needle: string): number {
	const idx = text.indexOf(needle);
	return idx === -1 ? 0 : text.slice(0, idx).split("\n").length;
}

/** `(file:line)` refusal suffix; line omitted when no offending line is
 * identifiable. F-003: the line is computed from the GRAMMAR-STRIPPED text
 * (stripByGrammar, hoisted) — the same text the check ran on — so a comment
 * mentioning the key can never outrank the offending key line. */
function at(file: string, text: string, needle?: string): string {
	const line = needle === undefined ? 0 : lineOf(stripByGrammar(file, text), needle);
	return ` (${file}${line > 0 ? `:${line}` : ""})`;
}

// ── AC1/AC2/AC7: compose validator ───────────────────────────────────────────

type Compose = {
	services?: Record<string, { image?: string; ports?: unknown; networks?: unknown; restart?: string; env_file?: unknown }>;
	networks?: Record<string, { external?: boolean; name?: string }>;
};

type HostMap = { text: string; hostIp: string; hostPort: string };

/** Short-syntax port string or long-syntax object → host mapping info, a named
 * refusal for an unparseable shape (F-014: bare-IPv6 4/5-part splits are never
 * silently dropped), or null (no host side). */
function asHostMap(entry: unknown): HostMap | { refusal: string } | null {
	if (typeof entry === "string") {
		// F-014: bracket form `[::1]:18890:8888` — the IPv6 literal's own
		// colons must not feed the naive split; peel the bracket first.
		const bracket = /^\[([^\]]+)\]:(\d+):(\d+)$/.exec(entry);
		if (bracket) return { text: entry, hostIp: bracket[1]!, hostPort: bracket[2]! };
		const parts = entry.split(":");
		if (parts.length === 1) return { text: entry, hostIp: "0.0.0.0", hostPort: parts[0]! };
		if (parts.length === 2) {
			// `host:container` with no host IP — docker defaults the bind to 0.0.0.0.
			return { text: entry, hostIp: "0.0.0.0", hostPort: parts[0]! };
		}
		if (parts.length === 3) {
			// F-014: `[::1]:18890:8888` bracket form — strip the brackets so the
			// loopback check sees the bare IPv6 literal.
			const hostIp =
				parts[0]!.startsWith("[") && parts[0]!.endsWith("]") ? parts[0]!.slice(1, -1) : parts[0]!;
			return { text: entry, hostIp, hostPort: parts[1]! };
		}
		// F-014: a 4-or-5-part colon split is a bare-IPv6 publish (or a mangled
		// 4-field entry) — refused BY NAME, never filtered as null.
		return { refusal: `AC1: unparseable ports entry (possible bare IPv6) — use the exact ${HOST_PUBLISH} map, got ${entry}` };
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

/** env_file entries, short (string) or list syntax. */
function envFileNames(v: unknown): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.map(String);
	return [];
}

/** Every AC1/AC2/AC6/AC7/AC8 refusal for a compose document, each naming file + line + rule. */
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
		refusals.push(`AC1: compose must define exactly the two services ${expected.join(" + ")}, got ${names.join(", ") || "<none>"}${at(file, text)}`);
	}

	for (const [name, svcRaw] of Object.entries(services)) {
		// F-018: malformed shapes produce NAMED refusals, never TypeErrors —
		// a null/missing service body is `{}`, ports normalize (array kept,
		// scalar wrapped, null/absent → []).
		const svc = svcRaw ?? {};
		let ports: unknown[];
		if (Array.isArray(svc.ports)) ports = svc.ports;
		else if (svc.ports == null) ports = [];
		else {
			refusals.push(`AC1: service ${name} ports must be a list, got ${JSON.stringify(svc.ports)}${at(file, text)}`);
			ports = [svc.ports];
		}

		// AC2: pin discipline on every image ref.
		const image = svc.image ?? "";
		if (!image) refusals.push(`AC2: service ${name} has no image ref${at(file, text)}`);
		if (image.includes(":latest")) refusals.push(`AC2: service ${name} image ref uses :latest — ${image}${at(file, text, image)}`);
		// F-016: `_`-separated and UPPERCASE arch tokens are the same QEMU
		// incident class as `-`/`:`-separated lowercase ones.
		const archSuffixed = /(?:-|:|_)(?:amd64|arm64|x86_64|aarch64)(?:@sha256:[0-9a-f]{64})?$/i.test(image);
		if (archSuffixed) refusals.push(`AC2: service ${name} image ref is arch-suffixed (QEMU incident class) — ${image}${at(file, text, image)}`);
		if (name === "hindsight-qds" && image !== PIN) {
			refusals.push(`AC2: hindsight-qds image must be the fork pin byte-exact (${PIN}), got ${image || "<missing>"}${at(file, text, image)}`);
		}

		// AC1: ports discipline.
		const maps: HostMap[] = [];
		for (const entry of ports) {
			const m = asHostMap(entry);
			if (m === null) continue; // long-syntax entry with no host side
			if ("refusal" in m) {
				refusals.push(`${m.refusal}${at(file, text, String(entry))}`);
				continue;
			}
			maps.push(m);
		}
		if (name === "hindsight-qds") {
			if (maps.length !== 1) {
				refusals.push(`AC1: hindsight-qds must have exactly one host publish, got ${maps.length}${at(file, text)}`);
			}
			for (const m of maps) {
				if (m.text !== HOST_PUBLISH) {
					refusals.push(`AC1: host publish must be exactly ${HOST_PUBLISH}, got ${m.text}${at(file, text, m.text)}`);
				}
				// "::1" is LIVE, not dead (F-014): the bracket form `[::1]:host:ct` feeds it.
				if (m.hostIp !== "127.0.0.1" && m.hostIp !== "::1") {
					refusals.push(`AC1/INV-Z4-1: host publish must bind loopback, got non-loopback host IP ${m.hostIp} in ${m.text}${at(file, text, m.text)}`);
				}
				if (m.hostPort === "8888" || m.hostPort === "18889") {
					refusals.push(`AC1/INV-Z4-1: host port ${m.hostPort} is forbidden (8888 collides with Hindsight's default; 18889 is the platform tenant stack's map) in ${m.text}${at(file, text, m.text)}`);
				}
			}
		}
		if (name === "m2-gateway" && ports.length > 0) {
			refusals.push(`AC1: m2-gateway publishes NO ports (its only public reach is the existing Caddy front door), got ${JSON.stringify(svc.ports)}${at(file, text, String(svc.ports))}`);
		}
		if (name === "m2-gateway" && svc.restart !== "no") {
			refusals.push(`AC8: m2-gateway restart must be "no" until M2.1's image is published (never green-by-default), got ${String(svc.restart)}${at(file, text)}`);
		}

		// AC6/INV-Z4-3: BOTH services wire the operator secrets file
		// (hindsight-qds consumes the provider key, m2-gateway the tenant key — F-003).
		if (!envFileNames(svc.env_file).includes("hindsight-qds.env")) {
			refusals.push(`AC6/INV-Z4-3: service ${name} must wire env_file: hindsight-qds.env (operator-placed secrets, mode 0600, runbook G3), got ${JSON.stringify(svc.env_file ?? null)}${at(file, text)}`);
		}

		// AC7: no second perimeter — no proxy/TLS service of any name.
		if (PERIMETER_SERVICE_NAMES.test(name)) {
			refusals.push(`AC7: compose ships a second perimeter service "${name}" — extension of the existing front door, never its own proxy/TLS stack (charter §2.2)${at(file, text, name)}`);
		}
		for (const m of maps) {
			if (m.hostPort === "443" || m.hostPort === "80") {
				refusals.push(`AC7: service ${name} publishes perimeter port ${m.hostPort} (${m.text}) — 80/443 belong to the existing control-plane Caddy only${at(file, text, m.text)}`);
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
				refusals.push(`AC7/INV-Z4-1: hindsight-qds must stay OFF the front-door network — the perimeter reaches the gateway only${at(file, text)}`);
			}
		}
	}

	// AC7: the front-door network must be a declared EXTERNAL join, never created.
	const frontDoor = doc.networks?.["front-door"];
	if (!frontDoor) {
		refusals.push(`AC7: compose must declare the front-door network (m2-gateway joins the existing control-plane perimeter)${at(file, text)}`);
	} else {
		if (frontDoor.external !== true) {
			refusals.push(`AC7: front-door network must be external: true — this compose creates nothing, it JOINs the existing perimeter${at(file, text)}`);
		}
	}

	return refusals;
}

// ── AC3: Caddy fragment validator (line/regex level) ─────────────────────────

/** Every AC3/AC7 refusal for a Caddy fragment, each naming file + line + rule. */
function validateCaddy(text: string): string[] {
	const refusals: string[] = [];
	const file = "deploy/vps/Caddyfile.factory.allowlist";
	const code = stripCaddyComments(text);

	// F-009 (SR-1): forwarding is airtight at the TARGET level — ONE global
	// scan over the whole stripped fragment, UNANCHORED: nested-block /
	// one-line / mid-line shapes all match, no body parsing needed. (The
	// per-handle body walk below stays only for the catch-all-404 rule,
	// which is canonical-shape best-effort; the target invariant is the
	// guarantee.)
	for (const target of [...code.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1]!)) {
		if (target !== GATEWAY_UPSTREAM) {
			refusals.push(`AC3/INV-Z4-1: ${file} forwards to ${target} — every reverse_proxy must target ${GATEWAY_UPSTREAM}; the perimeter reaches the gateway only, never a hindsight service${at(file, text, target)}`);
		}
	}

	// AC3: exactly one host block (F-009: one-line blocks counted too);
	// AC7: no second listener — a site address naming :443/:80 or a
	// global-options block would be a deployment, not a fragment.
	const blockLabels = [
		...[...code.matchAll(/^([^\s#][^{}]*)\{\s*$/gm)].map((m) => m[1]!.trim()),
		...[...code.matchAll(/^([^\s#][^{}]*)\{[^{}]*\}\s*$/gm)].map((m) => m[1]!.trim()),
	];
	const hostBlocks = blockLabels.filter((l) => !l.startsWith("@") && !l.startsWith("("));
	if (hostBlocks.length !== 1) {
		refusals.push(`AC3: ${file} must carry exactly ONE host block, got ${hostBlocks.length}: ${hostBlocks.join(", ") || "<none>"}${at(file, text)}`);
	}
	for (const label of hostBlocks) {
		if (/:(?:443|80)\b/.test(label)) {
			refusals.push(`AC7: host block "${label}" names a listener port — fragments add no listener; 80/443 stay the existing front door's${at(file, text, label)}`);
		}
	}

	// Named matcher rows (AC3 idiom) + the handles that consume them.
	const namedHandles = [...code.matchAll(/^[ \t]*handle\s+@(\w[\w-]*)\s*\{\s*$/gm)].map((m) => m[1]!);
	for (const h of namedHandles) {
		const matcher = new RegExp(`^[ \\t]*@${h}\\s*\\{[\\s\\S]*?^[ \\t]*\\}`, "m").exec(code);
		const body = matcher?.[0] ?? "";
		if (!matcher || !/^[ \t]*method\s+\S+/m.test(body) || !/[ \t]path\s+\S+/.test(body)) {
			refusals.push(`AC3: row @${h} must gate on an explicit method+path matcher (E09-GAP-01b/01c/01d idiom)${at(file, text, `@${h}`)}`);
		}
	}
	const handleBodies = [...code.matchAll(/^[ \t]*handle(?:\s+@(\w[\w-]*))?\s*\{\s*$([\s\S]*?)[ \t]*\}\s*$/gm)];
	for (const [, named, handleBody] of handleBodies) {
		if (named) continue; // forwarding already covered by the global target scan
		// The terminal default-404 tail: everything not listed is 404, not forwarded.
		if (!/^[ \t]*respond\s+404\s*$/m.test(handleBody ?? "")) {
			refusals.push(`AC3: catch-all handle must \`respond 404\`, never proxy — the route table is NOT exhaustive by design; that is the point${at(file, text)}`);
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
	// F-025: env grammar strips FULL-LINE comments only — a ` #` inside a
	// value is data, never a comment (dotenv/compose env_file rules).
	// F-015: `export KEY=` and lowercase keys parse too (a literal credential
	// must not evade the scan by spelling); keys normalize UPPERCASE so every
	// downstream key check is spelling-proof.
	return [...stripEnvComments(text).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)].map((m) => ({
		key: m[1]!.toUpperCase(),
		value: (m[2] ?? "").trim(),
	}));
}

/** Placeholder = empty or <…>-wrapped. Anything else on a secret-named key is a literal credential. */
function isPlaceholder(value: string): boolean {
	return value === "" || /^<.*>$/.test(value);
}

// F-015: case-insensitive (parseEnv also normalizes, belt and suspenders).
const SECRET_NAME = /HINDSIGHT_API_|BEARER_TOKEN|HINDSIGHT_API_KEY/i;

/** Every AC6 refusal for an env template; `expectedBase` pins its HINDSIGHT_BASE_URL origin. */
function validateEnvTemplate(text: string, file: string, expectedBase: string): string[] {
	const refusals: string[] = [];
	const entries = parseEnv(text);

	for (const { key, value } of entries) {
		if (SECRET_NAME.test(key) && !isPlaceholder(value)) {
			refusals.push(`AC6/INV-Z4-3: ${file} carries a literal credential value for ${key} — templates carry names, never values${at(file, text, key)}`);
		}
		if (key === "SOLSTICE_TENANT_ID") {
			refusals.push(`AC6/G3-G6: ${file} templates SOLSTICE_TENANT_ID — it stays the swarmclaw stack's .env.local item, never a key here${at(file, text, key)}`);
		}
		if (key === "HINDSIGHT_BASE_URL" && value !== expectedBase) {
			refusals.push(`AC6: ${file} HINDSIGHT_BASE_URL must be exactly ${expectedBase}, got ${value}${at(file, text, key)}`);
		}
	}
	// The annotation may NAME the fence item in a comment; a non-comment
	// occurrence is templating. F-019: trailing ` # …` inline comments strip
	// too (full-line comments already gone via stripEnvComments), so an
	// inline-comment mention is not a false positive.
	const nonComment = stripEnvComments(text)
		.split("\n")
		.map((line) => line.replace(/\s#.*$/, ""))
		.join("\n");
	if (/(^|[^#\n])SOLSTICE_TENANT_ID/.test(nonComment) && !entries.some((e) => e.key === "SOLSTICE_TENANT_ID")) {
		// occurrence outside comments but not as a KEY= line (e.g. a bare value) — still a leak
		refusals.push(`AC6/G3-G6: ${file} mentions SOLSTICE_TENANT_ID outside a comment${at(file, text)}`);
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

/** Per-grammar comment stripping for the tree scan (F-025): env values keep
 * their ` #` (data, not a comment); docs have no comment grammar at all. */
function stripByGrammar(path: string, text: string): string {
	if (path.endsWith(".md")) return text;
	if (path.includes(".env")) return stripEnvComments(text);
	if (path.includes("Caddyfile")) return stripCaddyComments(text);
	return stripShComments(text); // sh / YAML: a trailing ` #` IS a comment
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
		const stripped = stripByGrammar(path, content);
		const count = stripped.split("--driver exedev").length - 1;
		// F-003: the cited line comes from the SAME stripped text the count ran on.
		const line = lineOf(stripped, "--driver exedev");
		const loc = line > 0 ? `:${line}` : "";
		if (path === "deploy/vps/fleet-wrapper.sh") {
			if (count !== 1) refusals.push(`AC5/INV-Z4-2: ${path}${loc} must hold --driver exedev exactly once (non-comment), got ${count}`);
		} else if (count > 0) {
			refusals.push(`AC5/INV-Z4-2: ${path}${loc} carries the --driver exedev grammar — the wrapper is the SOLE holder; swarmclaw never learns QDS's driver grammar (DF5.5 Amendment D)`);
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

	it("AC6/INV-Z4-3: BOTH services wire the operator secrets file hindsight-qds.env", () => {
		const doc = YAML.parse(COMPOSE) as Compose;
		for (const name of ["hindsight-qds", "m2-gateway"]) {
			expect(envFileNames(doc.services?.[name]?.env_file)).toContain("hindsight-qds.env");
		}
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
		expect(stripEnvComments(FACTORY_ENV)).not.toContain("127.0.0.1:8888");
		expect(parseEnv(FACTORY_ENV).filter((e) => e.value.includes("18890") || e.value.includes("18889"))).toEqual([]);
	});
});

describe("AC5: driver-grammar tree scan", () => {
	it("the whole deploy/vps tree + the runbook hold --driver exedev exactly once — in fleet-wrapper.sh (F-002)", () => {
		const files: Record<string, string> = {};
		for (const abs of walkTree(vpsDir)) {
			files[abs.slice(repoRoot.length + 1)] = readFileSync(abs, "utf8");
		}
		// F-002: the runbook is IN the scanned map (the F-016 doc-leak negative
		// control names exactly this path — the positive scan must check it).
		// .md grammar: no comment stripping, every literal counts.
		files[RUNBOOK_PATH] = readFileSync(join(repoRoot, RUNBOOK_PATH), "utf8");
		expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
		expect(Object.keys(files)).toContain("deploy/vps/fleet-wrapper.sh");
		expect(Object.keys(files)).toContain(RUNBOOK_PATH);
		expect(scanDriverGrammar(files)).toEqual([]);
	});

	it("AC5 negative control: a fixture env line exporting the flag to the fork env is refused by name", () => {
		const leaks = scanDriverGrammar({
			"deploy/vps/env/factory.env.example": "SWARMCLAW_FACTORY_FLEET_FLAGS=--driver exedev\n",
		});
		expect(leaks).toHaveLength(1);
		expect(leaks[0]).toContain("deploy/vps/env/factory.env.example:1");
		expect(leaks[0]).toContain("AC5/INV-Z4-2");
	});

	it("AC5 negative control (F-016): a compose VALUE exporting the flag is refused by name", () => {
		const leaks = scanDriverGrammar({
			"deploy/vps/docker-compose.factory.yml": [
				"services:",
				"  m2-gateway:",
				"    environment:",
				"      SWARMCLAW_FACTORY_FLEET_FLAGS: --driver exedev",
			].join("\n"),
		});
		expect(leaks).toHaveLength(1);
		expect(leaks[0]).toContain("deploy/vps/docker-compose.factory.yml:4");
		expect(leaks[0]).toContain("AC5/INV-Z4-2");
	});

	it("AC5 negative control (F-016): a doc-text leak (runbook annotation path) is refused by name", () => {
		const leaks = scanDriverGrammar({
			[RUNBOOK_PATH]: "Run every fleet verb with --driver exedev appended.\n",
		});
		expect(leaks).toHaveLength(1);
		expect(leaks[0]).toContain("2026-09-30-vultr-vps-deploy-runbook.md:1");
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

	it("F-014: bracket-form IPv6 loopback parses (hostIp ::1, loopback-legal); a bare-IPv6 5-part split is refused BY NAME", () => {
		expect(asHostMap("[::1]:18890:8888")).toEqual({ text: "[::1]:18890:8888", hostIp: "::1", hostPort: "18890" });
		const bracket = validateCompose(baseCompose('      - "[::1]:18890:8888"'));
		expect(bracket.some((x) => x.includes("must bind loopback"))).toBe(false); // ::1 is loopback-legal
		const bare = validateCompose(baseCompose('      - "::1:18890:8888"'));
		expect(bare.some((x) => x.startsWith("AC1: unparseable ports entry (possible bare IPv6)"))).toBe(true);
	});

	it("F-018: malformed YAML shapes produce NAMED refusals, never TypeErrors", () => {
		const r = validateCompose(
			[
				"services:",
				"  hindsight-qds:", // null service body
				"  m2-gateway:",
				"    image: ghcr.io/o/qds-m2-gateway:t",
				'    restart: "no"',
				"    ports: 127.0.0.1:8443:8080", // scalar ports, not a list
				"networks:",
				"  front-door:",
				"    external: true",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC1: hindsight-qds must have exactly one host publish, got 0"))).toBe(true);
		expect(r.some((x) => x.startsWith("AC1: service m2-gateway ports must be a list"))).toBe(true);
		expect(r.some((x) => x.startsWith("AC2: service hindsight-qds has no image ref"))).toBe(true);
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

	it("refuses colon-form bare arch tags (:amd64) — same QEMU incident class (F-020)", () => {
		const r = validateCompose([
			"services:",
			"  hindsight-qds:",
			`    image: ${PIN}`,
			`    ports: ["${HOST_PUBLISH}"]`,
			"  m2-gateway:",
			"    image: ghcr.io/o/qds-m2-gateway:amd64",
			'    restart: "no"',
			"networks:",
			"  front-door:",
			"    external: true",
		].join("\n"));
		expect(r.some((x) => x.includes("AC2") && x.includes("arch-suffixed") && x.includes("qds-m2-gateway:amd64"))).toBe(true);
	});

	it("refuses underscore-form arch tags (:v1_arm64) — same QEMU incident class (F-016)", () => {
		const r = validateCompose([
			"services:",
			"  hindsight-qds:",
			`    image: ${PIN}`,
			`    ports: ["${HOST_PUBLISH}"]`,
			"  m2-gateway:",
			"    image: ghcr.io/o/qds-m2-gateway:v1_arm64",
			'    restart: "no"',
			"networks:",
			"  front-door:",
			"    external: true",
		].join("\n"));
		expect(r.some((x) => x.includes("AC2") && x.includes("arch-suffixed") && x.includes("qds-m2-gateway:v1_arm64"))).toBe(true);
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

	it("F-009 (SR-1): a reverse_proxy AFTER a nested header block inside handle @recall is still refused", () => {
		const r = validateCaddy(
			[
				"factory.example.com {",
				"	@recall {",
				"		method POST",
				"		path /v1/recall",
				"	}",
				"	handle @recall {",
				"		header {",
				"			X-Factory true",
				"		}",
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

	it("F-009 (SR-1): a ONE-LINE handle forwarding a hindsight service is refused", () => {
		const r = validateCaddy(
			[
				"factory.example.com {",
				"	handle @recall { reverse_proxy hindsight-qds:8888 }",
				"	handle { respond 404 }",
				"}",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC3/INV-Z4-1") && x.includes("hindsight-qds:8888"))).toBe(true);
	});

	it("F-009 (SR-1): a ONE-LINE second host block makes the count 2 — refused by name", () => {
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
				"		respond 404",
				"	}",
				"}",
				"other.example.com { respond 404 }",
			].join("\n"),
		);
		expect(r.some((x) => x.startsWith("AC3:") && x.includes("exactly ONE host block, got 2"))).toBe(true);
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

	it("F-025: a ` #` inside an env value is DATA, not a comment — parsed intact, no false refusal", () => {
		const text = "SWARMCLAW_ARG_POLICY=deny #fragment-style suffix\n";
		// no false cleanliness: the full value survives (sh-style stripping would truncate at " #")
		expect(parseEnv(text)).toEqual([{ key: "SWARMCLAW_ARG_POLICY", value: "deny #fragment-style suffix" }]);
		// no false refusal
		expect(validateEnvTemplate(text, "fixture.env", "http://hindsight-qds:8888")).toEqual([]);
	});

	it("F-015: export-prefixed and lowercase spellings of a secret are refused; tab-# comments strip", () => {
		for (const line of ["export HINDSIGHT_API_LLM_API_KEY=sk-real\n", "hindsight_api_llm_api_key=sk-real\n"]) {
			const r = validateEnvTemplate(line, "fixture.env", "http://127.0.0.1:18890");
			expect(r.some((x) => x.includes("literal credential value")), line).toBe(true);
		}
		expect(stripShComments("\t# tab-indented comment\nKEY=value\n")).toBe("\nKEY=value\n");
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

	it("AC6/INV-Z4-3 (F-027): a compose dropping the secrets env_file is refused, per service", () => {
		const r = validateCompose(baseCompose(`      - "${HOST_PUBLISH}"`));
		const dropped = r.filter((x) => x.startsWith("AC6/INV-Z4-3"));
		expect(dropped).toHaveLength(2); // hindsight-qds AND m2-gateway both flagged
		expect(dropped[0]).toContain("env_file: hindsight-qds.env");
		expect(dropped[0]).toMatch(/docker-compose\.factory\.yml\)$/); // file named
	});
});

describe("Observability contract (F-014): refusals name file + line + rule", () => {
	it("compose refusals carry a (file:line) suffix wherever the offending line is identifiable", () => {
		const r = validateCompose(baseCompose('      - "0.0.0.0:18890:8888"'));
		const loopback = r.find((x) => x.startsWith("AC1/INV-Z4-1: host publish must bind loopback"));
		expect(loopback).toMatch(/\(deploy\/vps\/docker-compose\.factory\.yml:\d+\)$/);
		const wrongMap = r.find((x) => x.startsWith("AC1: host publish must be exactly"));
		expect(wrongMap).toMatch(/\(deploy\/vps\/docker-compose\.factory\.yml:\d+\)$/);
	});

	it("Caddy refusals carry a (file:line) suffix pointing at the offending row", () => {
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
		const fwd = r.find((x) => x.startsWith("AC3/INV-Z4-1"));
		expect(fwd).toMatch(/\(deploy\/vps\/Caddyfile\.factory\.allowlist:7\)$/); // the reverse_proxy row
	});

	it("env refusals carry a (file:line) suffix pointing at the offending key", () => {
		const r = validateEnvTemplate("HINDSIGHT_BEARER_TOKEN=real-secret-value\n", "fixture.env", "http://hindsight-qds:8888");
		expect(r[0]).toContain("literal credential value for HINDSIGHT_BEARER_TOKEN");
		expect(r[0]).toContain("(fixture.env:1)");
	});
});

// ── AC2/F-006: the fork pin file is the SOLE pin source ──────────────────────
// The compose image must equal <QDS_FORK_CHECKOUT>/config/hindsight-version.txt
// BYTE-EXACT — this is the check that catches a fork pin bump going stale in
// docker-compose.factory.yml (a hardcoded digest agrees with a stale fork
// forever). The fork checkout exists only on dev machines, so this test is
// gated on the QDS_FORK_CHECKOUT env var (ABSOLUTE path to a local swarmclaw
// fork checkout root). Unset ⇒ SKIPPED, and CI without the checkout stays
// green. F-017: SET-BUT-EMPTY counts as unset too — an empty path can never
// satisfy the byte-compare, so it must not masquerade as an enabled check;
// the skip reason is exactly that empty-string = unset. There is deliberately
// NO default path. To run it locally:
//   QDS_FORK_CHECKOUT=/path/to/swarmclaw bun test tests/deploy/vps-profile.test.ts
const FORK_CHECKOUT = process.env.QDS_FORK_CHECKOUT || undefined;

describe("AC2: fork sole-pin-source byte-compare (F-006)", () => {
	it.skipIf(!FORK_CHECKOUT)("compose image equals <QDS_FORK_CHECKOUT>/config/hindsight-version.txt byte-exact", () => {
		const forkPin = readFileSync(join(FORK_CHECKOUT as string, "config", "hindsight-version.txt"), "utf8").trim();
		const composeImage = (YAML.parse(COMPOSE) as Compose).services?.["hindsight-qds"]?.image;
		expect(composeImage).toBe(forkPin);
		// and the fork pin is still the pin the in-file fixtures assert
		expect(forkPin).toBe(PIN);
	});
});
