/**
 * Skill-contract tests (Story DF3.5): the four Tier-1 factory skills under
 * `.claude/skills/factory/` vs the DF3.1 verb registry (`src/fleet/verbs.ts`).
 *
 * What this file pins (story AC1-AC7, INV-SKILL-1..6, Definition of Done):
 *
 *  A. Discovery + frontmatter: exactly factory-dispatch, factory-guide,
 *     factory-harvest, factory-observe exist; each frontmatter parses as YAML,
 *     `name` equals the directory, `description` names a registry verb, and the
 *     body stays under the story's 200-line budget.
 *  B. AC1: every fenced `fleet` invocation resolves verb AND flags against
 *     listVerbs(); an unknown verb, an unknown flag, or an omitted required
 *     flag fails with file:line + the offending token (with a did-you-mean for
 *     near-miss flags). Prose outside fences is never parsed.
 *  C. DoD e2e (MANDATORY): the documented dispatch → status sequence runs
 *     in-process against the fake driver; the runId dispatch prints is the
 *     runId the status command is invoked with (`<runId>` substitution).
 *  D. AC2 body clause + INV-SKILL-3: no fenced hand-rolled ssh, curl,
 *     git push, key mint, key revoke, or VM destroy.
 *  E. AC4: the six FIXED case-insensitive commercial patterns, VERBATIM from
 *     the story, over the four SKILL.md files AND this test file; zero hits
 *     outside the two verbatim factory-guide allowlist entries.
 *  F. AC7: factory-guide states the v5.0 containment scope (three clauses plus
 *     a DD-11 citation); the other three skills make no pattern-(f) claim.
 *  G. AC6 + INV-SKILL-1/2: factory-observe routes approval to `fleet approve`
 *     with stdin token delivery; no skill carries a token-shaped value.
 *
 * Accepted invocation prefixes inside fenced blocks (the documented surface):
 *   `bun scripts/fleet.ts <verb> …`  — canonical, matching DF3.1
 *   `fleet <verb> …`                 — the registry shorthand (`Usage: fleet <verb>`)
 * with an optional leading `$ ` prompt. `fleet --help` / `fleet help` /
 * `fleet -h` take no verb and are exempt from verb/flag resolution. One
 * command per line; `|`, `&&`, `;`, `<`, `>` split shell plumbing — a FURTHER
 * fleet invocation in the remainder is parsed and resolved as its own command
 * (non-fleet segments like `&& echo done` are ignored); a bare `<runId>` token
 * is a PLACEHOLDER positional, not a redirect. Flag values may be
 * space-separated or `--flag=value`. Both ``` and ~~~ fences are fences.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type FleetDeps, run } from "../../scripts/fleet.ts";
import { listVerbs, type VerbEntry } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger } from "./helpers.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, ".claude", "skills", "factory");
const SELF_PATH = join(REPO_ROOT, "tests", "fleet", "skill-contract.test.ts");
const SELF_LABEL = "tests/fleet/skill-contract.test.ts";

/** The closed skill set (story "Files to Modify"), in sorted order for readdir parity. */
const EXPECTED_SKILLS = ["factory-dispatch", "factory-guide", "factory-harvest", "factory-observe"] as const;

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-5-skill-contract-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ─── shared types and loaders ────────────────────────────────────────────────

interface SkillFile {
  /** Story-style label used in every error message, e.g. `factory-dispatch/SKILL.md`. */
  label: string;
  text: string;
}

interface FencedLine {
  /** 1-based line number in the whole file (so errors read `file:line`). */
  line: number;
  text: string;
}

interface FleetCommand {
  label: string;
  line: number;
  /** Everything after the invocation prefix up to the first plumbing token, untokenized (the substitution surface). */
  argsText: string;
  /** First token of argsText, or undefined for a bare `fleet` line (skipped, not an invocation). */
  verb: string | undefined;
  /** `fleet --help` / `fleet help` / `fleet -h` take no verb and are exempt. */
  isHelp: boolean;
  tokens: string[];
}

/**
 * Load one skill file or throw the RED-state error. The four files are this
 * story's deliverable, so absence is a failure, not a skip.
 */
function loadSkill(name: string): SkillFile {
  const label = `${name}/SKILL.md`;
  const path = join(SKILLS_ROOT, name, "SKILL.md");
  if (!existsSync(path)) {
    throw new Error(`skill file missing: .claude/skills/factory/${label} — DF3.5 Wave-2 must add it`);
  }
  return { label, text: readFileSync(path, "utf8") };
}

// ─── A: frontmatter ──────────────────────────────────────────────────────────

interface Frontmatter {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(label: string, text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) {
    throw new Error(`${label}: missing or malformed frontmatter block (expected "---" lines around the YAML header)`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1] as string);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: frontmatter is not valid YAML: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${label}: frontmatter did not parse to a mapping`);
  }
  const fm = parsed as { name?: unknown; description?: unknown };
  if (typeof fm.name !== "string" || fm.name.length === 0) {
    throw new Error(`${label}: frontmatter has no non-empty string 'name'`);
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    throw new Error(`${label}: frontmatter has no non-empty string 'description'`);
  }
  return { name: fm.name, description: fm.description, body: text.slice(m[0].length) };
}

// ─── B: fence extraction + registry resolution (AC1) ─────────────────────────

/** Every fenced-code-block content line, with its file line number. Prose outside fences is never seen here. Backtick AND tilde fences count. */
function extractFencedLines(text: string): FencedLine[] {
  const out: FencedLine[] = [];
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] as string;
    if (/^(?:```|~~~)/.test(lineText.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push({ line: i + 1, text: lineText });
  }
  return out;
}

/** Tokens that split a line into command segments. `<runId>` is NOT one — it is the placeholder positional. */
const SHELL_TOKENS = new Set(["|", "||", "&&", ";", "<", ">", ">>", "2>", "2>>", "1>", "2>&1"]);

function cutShell(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (SHELL_TOKENS.has(t) || t.startsWith("2>") || t.startsWith("1>")) break;
    out.push(t);
  }
  return out;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

const INVOKE_RE = /^\s*(?:\$\s*)?(?:bun\s+scripts\/fleet\.ts|fleet)(?=\s|$)(.*)$/;

/** Build a command from one segment's args text; undefined for an empty segment (a bare `fleet` line is not an invocation). */
function commandFrom(label: string, line: number, argsText: string): FleetCommand | undefined {
  const tokens = words(argsText);
  const verb = tokens[0];
  if (verb === undefined) return undefined;
  return { label, line, argsText, verb, isHelp: verb === "--help" || verb === "-h" || verb === "help", tokens };
}

/**
 * Parse one fenced line into fleet invocations (empty when the line has none).
 * The leading command is anchored at line start; after each shell-plumbing
 * token the following segment is RE-TESTED as a fresh invocation, so
 * `fleet dispatch … && fleet reap …` resolves BOTH commands — a bogus second
 * verb cannot hide behind `&&`. Non-fleet segments (`&& echo done`) are
 * ignored.
 */
function parseFleetCommand(label: string, fenced: FencedLine): FleetCommand[] {
  const lead = INVOKE_RE.exec(fenced.text);
  if (!lead) return [];
  const segments: string[] = [""];
  for (const t of words(lead[1] as string)) {
    if (SHELL_TOKENS.has(t) || t.startsWith("2>") || t.startsWith("1>")) {
      segments.push("");
    } else {
      const last = segments.length - 1;
      segments[last] = (segments[last] as string).length === 0 ? t : `${segments[last]} ${t}`;
    }
  }
  const out: FleetCommand[] = [];
  const first = commandFrom(label, fenced.line, (segments[0] as string).trim());
  if (first !== undefined) out.push(first);
  for (let s = 1; s < segments.length; s++) {
    const m = INVOKE_RE.exec(segments[s] as string);
    if (!m) continue; // non-fleet plumbing remainder — ignored
    const cmd = commandFrom(label, fenced.line, (m[1] as string).trim());
    if (cmd !== undefined) out.push(cmd);
  }
  return out;
}

function parseFleetCommands(label: string, fenced: FencedLine[]): FleetCommand[] {
  const out: FleetCommand[] = [];
  for (const fl of fenced) {
    out.push(...parseFleetCommand(label, fl));
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Near-miss suggestion: the verb's own flag with edit distance ≤ 3, else nothing (a distant flag is not a near miss). */
function didYouMean(token: string, candidates: string[]): string {
  let best: string | undefined;
  let bestDist = Number.MAX_SAFE_INTEGER;
  for (const c of candidates) {
    const d = levenshtein(token, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= 3 ? ` (did you mean ${best}?)` : "";
}

/**
 * Resolve every parsed invocation against the registry. Errors are strings of
 * the story's shape: `<label>:<line> unknown flag <token> (did you mean …?)`,
 * `unknown verb <token>`, `missing required flag <token> for verb <verb>`.
 */
function checkCommandsAgainstRegistry(commands: FleetCommand[], registry: VerbEntry[]): string[] {
  const errors: string[] = [];
  for (const cmd of commands) {
    if (cmd.isHelp) continue; // fleet --help / help take no verb
    const entry = registry.find((v) => v.verb === cmd.verb);
    if (!entry) {
      errors.push(`${cmd.label}:${cmd.line} unknown verb ${cmd.verb}${didYouMean(cmd.verb as string, registry.map((v) => v.verb))}`);
      continue;
    }
    const seen = new Set<string>();
    const tokens = cmd.tokens;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i] as string;
      // A positional (runId, <runId>, the `-` stdin sentinel VALUE) is per-verb
      // CLI grammar, not a registry flag. ANY other dash-prefixed token must be
      // one — an unknown SHORT flag (-x) fails exactly like an unknown long one.
      if (!t.startsWith("-") || t === "-") continue;
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      const flag = entry.flags.find((f) => f.name === name);
      if (!flag) {
        errors.push(`${cmd.label}:${cmd.line} unknown flag ${name}${didYouMean(name, entry.flags.map((f) => f.name))}`);
        continue;
      }
      if (flag.valueType !== "boolean" && !t.includes("=")) {
        if (i + 1 >= tokens.length) {
          // A value-taking flag with NO value fails, and does not satisfy `required`.
          errors.push(`${cmd.label}:${cmd.line} missing value for flag ${name}`);
          continue;
        }
        seen.add(name);
        i++; // the next token is this flag's value
        continue;
      }
      seen.add(name);
    }
    if (!seen.has("--help")) {
      for (const f of entry.flags) {
        if (f.required && !seen.has(f.name)) {
          errors.push(`${cmd.label}:${cmd.line} missing required flag ${f.name} for verb ${entry.verb}`);
        }
      }
    }
  }
  return errors;
}

// ─── D: prohibited hand-rolled privileged commands (AC2 body clause, INV-SKILL-3) ──

/**
 * Scope choice (documented per the task): ONLY fenced-block command lines are
 * scanned, and fenced `#` comment lines are skipped — a fenced non-comment
 * line is imperative by construction, so this cannot trip on prose like
 * "never run ssh directly". INV-SKILL-3's scanner scope stays fenced commands:
 * prose outside fences is untouched. Within that scope there is NO
 * command-position anchoring — `OUT=$(ssh …)`, `sudo ssh …`, `/usr/bin/ssh …`
 * and `TOKEN=abc curl …` all trip, because the skill bodies never legitimately
 * carry these strings in fences (a comment-form mention is already skipped as
 * a `#` line). Key mint/revoke are order-insensitive per line.
 */
const PROHIBITED_PATTERNS: readonly { id: string; purpose: string; re: RegExp }[] = Object.freeze([
  { id: "ssh", purpose: "hand-rolled ssh into a box", re: /\bssh\b/ },
  { id: "curl", purpose: "hand-rolled curl against a provider API", re: /\bcurl\b/ },
  { id: "git-push", purpose: "hand-rolled git push", re: /\bgit\s+push\b/ },
  { id: "key-mint", purpose: "hand-rolled key mint", re: /\b(?:mint|create)\b[^\n]*\bkey\b|\bkey\b[^\n]*\b(?:mint|create)\b/i },
  { id: "key-revoke", purpose: "hand-rolled key revoke", re: /\brevoke\b[^\n]*\bkey\b|\bkey\b[^\n]*\brevoke\b/i },
  { id: "vm-destroy", purpose: "hand-rolled VM destroy", re: /\b(?:destroy|terminate|delete)\b[^\n]*\b(?:vm|box|instance)\b/i },
]);

function scanProhibited(label: string, text: string): string[] {
  const errors: string[] = [];
  for (const fl of extractFencedLines(text)) {
    if (fl.text.trimStart().startsWith("#")) continue; // fenced comment, not a command
    for (const p of PROHIBITED_PATTERNS) {
      if (p.re.test(fl.text)) errors.push(`${label}:${fl.line} prohibited instruction (${p.id}) — ${p.purpose}`);
    }
  }
  return errors;
}

// ─── E: the six FIXED commercial patterns (AC4), VERBATIM from the story ─────

/**
 * Copied VERBATIM from story DF3.5 AC4 (a-f); do not tune — the lint is fixed
 * precisely so it cannot be argued about at review time. Case-insensitive per
 * the story. Frozen.
 */
const COMMERCIAL_PATTERNS: readonly { id: string; purpose: string; re: RegExp }[] = Object.freeze([
  { id: "a", purpose: "per-unit price claim", re: /\$\s*\d+(\.\d+)?\s*(\/|\bper\b)\s*(run|story|pr|task|issue|box|hour|month|seat)/i },
  { id: "b", purpose: "consumer tier named as the entitlement", re: /\b(max|pro)\b[^.\n]{0,20}\b(plan|subscription|tier|account)\b/i },
  { id: "c", purpose: "a plan asserted to authorize work", re: /\bsubscription\b[^.\n]{0,60}\b(covers|includes|entitles|permits|allows|is enough for)\b/i },
  { id: "d", purpose: "token rate quoted in a skill file", re: /\b\d+(\.\d+)?\s*(usd|\$|dollars?)?[^.\n]{0,20}\bper\b[^.\n]{0,20}\b(million|mtok|1m|1,000,000)\b[^.\n]{0,10}\btokens?\b/i },
  { id: "e", purpose: "personal entitlement stretched over client work", re: /\b(client|customer)s?\b[^.\n]{0,60}\b(personal|individual|my|your own)\b[^.\n]{0,20}\b(account|subscription|plan)\b/i },
  { id: "f", purpose: "per-box containment claim the v5.0 substrate cannot enforce (DD-11)", re: /\b(egress|outbound|network)\b[^.\n]{0,40}\b(allowlist|allow-list|whitelist|restricted|locked[ -]down|firewalled|confined)\b/i },
]);

/** Allowlist entry 1 (AC4): verbatim, and ONLY in factory-guide — exempts patterns a-e for that one line. */
const A1_SENTENCE = "Client deployments run on an org-owned API key under Commercial Terms §A.1.";

/**
 * Allowlist entry 2 (AC4/AC7): the containment-scope sentences exempt pattern
 * (f), again only in factory-guide. Recognition rule: the line must carry the
 * `no per-VM` NEGATION exactly as the allowlisted AC7 clause-2 sentence is
 * phrased — a SCOPE CAVEAT, never a capability claim. A bare DD-11 citation is
 * NEVER enough: a capability claim citing DD-11 still fails.
 */
function isGuideExempt(id: string, lineText: string): boolean {
  // Entry 1: the line, trimmed, must EQUAL the verbatim allowlisted sentence —
  // nothing appended to it rides the exemption.
  if (id !== "f") return lineText.trim() === A1_SENTENCE;
  return /\bno\b[^.\n]{0,12}per-VM/i.test(lineText);
}

function lintCommercial(label: string, text: string, guideExemptions: boolean): string[] {
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] as string;
    for (const p of COMMERCIAL_PATTERNS) {
      if (!p.re.test(lineText)) continue;
      if (guideExemptions && isGuideExempt(p.id, lineText)) continue;
      errors.push(`${label}:${i + 1} commercial-lint pattern (${p.id}) — ${p.purpose}`);
    }
  }
  return errors;
}

// ─── G: token-shape heuristic (INV-SKILL-1/2) ────────────────────────────────

/**
 * Conservative high-entropy heuristic: 48+ chars from the base64url/hex
 * alphabet carrying ALL of lowercase, uppercase and digit classes reads as a
 * credential; short ids (runIds), all-lowercase 40-char shas and ordinary
 * words deliberately pass. Known credential prefixes (sk-, a JWT's eyJ) trip
 * at lower length. NOTE: an ALL-CAPS `sk-…` placeholder (e.g. sk-YOUR_API_KEY_HERE)
 * trips the sk- branch and fails the build INTENTIONALLY — do not weaken the
 * regex for it. The "offers to generate one" clause is covered
 * structurally rather than by regex: AC1 rejects any `--token` flag outright,
 * and the AC6 assertion requires stdin delivery to be the documented route.
 */
const TOKEN_SHAPE_RE = /\b(?=[A-Za-z0-9_-]{48,}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b|\b(?:sk-|eyJ)[A-Za-z0-9_-]{16,}\b/g;

function scanForTokenShapes(label: string, text: string): string[] {
  const errors: string[] = [];
  for (const m of text.matchAll(TOKEN_SHAPE_RE)) {
    const found = m[0];
    errors.push(`${label}: token-shaped value (INV-SKILL-1): ${found.slice(0, 8)}… (${found.length} chars)`);
  }
  return errors;
}

// ─── F: containment-scope clause matchers (AC7) ──────────────────────────────
// Each multi-word phrase regex is BUILT from one-word-per-line fragments: a
// regex literal carrying two pattern-(f) trigger words on one source line
// would self-trip the commercial lint over this file.

const CLAUSE1_RE = new RegExp(
  [
    "BYOK",
    "direct-provider",
    "egress",
    "only",
  ].join("\\s+"),
  "i",
);
const CLAUSE2_RE = new RegExp(
  [
    "no per-VM",
    "egress",
    "allowlist",
  ].join("\\s+"),
  "i",
);

// ═══ the suites ═══════════════════════════════════════════════════════════════

describe("DF3.5 skill discovery + frontmatter", () => {
  test("exactly the four factory skills exist under .claude/skills/factory/", () => {
    if (!existsSync(SKILLS_ROOT)) {
      throw new Error(`skill files missing: .claude/skills/factory/ does not exist — DF3.5 expects exactly: ${EXPECTED_SKILLS.join(", ")}`);
    }
    const dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS]);
    for (const name of EXPECTED_SKILLS) loadSkill(name); // throws "skill file missing" per absent SKILL.md
  });

  test("each frontmatter parses: name === directory, description names an exported verb, body ≤ 200 lines", () => {
    const verbs = listVerbs().map((v) => v.verb);
    const verbRe = new RegExp(`\\b(?:${verbs.join("|")})\\b`, "i");
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      const fm = parseFrontmatter(skill.label, skill.text);
      expect({ skill: name, frontmatterName: fm.name }).toEqual({ skill: name, frontmatterName: name });
      expect({ skill: name, namesAVerb: verbRe.test(fm.description) }).toEqual({ skill: name, namesAVerb: true });
      // Story Technical Notes: each SKILL.md body stays under 200 lines.
      const bodyLines = fm.body.split("\n").length;
      expect({ skill: name, withinBudget: bodyLines <= 200 }).toEqual({ skill: name, withinBudget: true });
    }
  });
});

describe("AC1: fenced fleet invocations resolve against the verb registry", () => {
  test("every fenced invocation in every skill resolves verb AND flags against listVerbs()", () => {
    const registry = listVerbs();
    const errors: string[] = [];
    let skillsParsed = 0;
    let commandsChecked = 0;
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      skillsParsed++;
      const commands = parseFleetCommands(skill.label, extractFencedLines(skill.text));
      commandsChecked += commands.length;
      errors.push(...checkCommandsAgainstRegistry(commands, registry));
    }
    // Observability contract: the test reports skills_parsed / commands_checked.
    console.log(`skill-contract: skills_parsed=${skillsParsed} commands_checked=${commandsChecked}`);
    expect(errors).toEqual([]);
  });

  test("negative control (DoD): a plausible-but-absent flag fails with file, line and token", () => {
    // The story's own example: `fleet dispatch --parallel 4` at line 41 while
    // the registry exports no such flag for dispatch.
    const fixtureLines = ["---", "name: factory-dispatch", "description: dispatch runs", "---", ""];
    while (fixtureLines.length < 39) fixtureLines.push("padding prose line");
    fixtureLines.push("```bash"); // line 40
    fixtureLines.push("fleet dispatch --parallel 4"); // line 41
    fixtureLines.push("```");
    const commands = parseFleetCommands("factory-dispatch/SKILL.md", extractFencedLines(fixtureLines.join("\n")));
    const errors = checkCommandsAgainstRegistry(commands, listVerbs());
    // The command also omits the required --driver, so the checker reports
    // both; the DoD contract is that the unknown flag is named with file:line.
    expect(errors.some((e) => e.includes("factory-dispatch/SKILL.md:41 unknown flag --parallel"))).toBeTrue();
  });

  test("prose mentioning a verb outside fences is NOT parsed", () => {
    const fixture = ["---", "name: x", "description: dispatch", "---", "", "Just run fleet dispatch --parallel 4 in your shell.", ""].join("\n");
    const commands = parseFleetCommands("x/SKILL.md", extractFencedLines(fixture));
    expect(commands).toHaveLength(0);
    expect(checkCommandsAgainstRegistry(commands, listVerbs())).toEqual([]);
  });

  test("an omitted required flag fails with file, line and token", () => {
    // dispatch declares --driver required; a documented call without it exits 2.
    const fixture = ["```", "fleet dispatch --brief b.json", "```"].join("\n");
    const errors = checkCommandsAgainstRegistry(parseFleetCommands("s/SKILL.md", extractFencedLines(fixture)), listVerbs());
    expect(errors).toEqual(["s/SKILL.md:2 missing required flag --driver for verb dispatch"]);
  });

  test("negative control: a fleet invocation behind && is parsed — `&& fleet reap` fails naming reap", () => {
    const fixture = ["```bash", "fleet dispatch --driver fake --brief b.json && fleet reap --driver fake", "```"].join("\n");
    const commands = parseFleetCommands("s/SKILL.md", extractFencedLines(fixture));
    expect(commands.map((c) => c.verb)).toEqual(["dispatch", "reap"]);
    const errors = checkCommandsAgainstRegistry(commands, listVerbs());
    expect(errors.some((e) => e.includes("s/SKILL.md:2 unknown verb reap"))).toBeTrue();
  });

  test("a non-fleet plumbing remainder (&& echo done) is ignored", () => {
    const fixture = ["```", "fleet dispatch --driver fake --brief b.json && echo done", "```"].join("\n");
    const commands = parseFleetCommands("s/SKILL.md", extractFencedLines(fixture));
    expect(commands.map((c) => c.verb)).toEqual(["dispatch"]);
    expect(checkCommandsAgainstRegistry(commands, listVerbs())).toEqual([]);
  });

  test("negative control: tilde fences are fences — a ~~~bash block is scanned by AC1", () => {
    const fixture = ["~~~bash", "fleet dispatch --parallel 4 --driver fake", "~~~"].join("\n");
    const commands = parseFleetCommands("s/SKILL.md", extractFencedLines(fixture));
    expect(commands).toHaveLength(1);
    const errors = checkCommandsAgainstRegistry(commands, listVerbs());
    expect(errors.some((e) => e.includes("s/SKILL.md:2 unknown flag --parallel"))).toBeTrue();
  });

  test("negative control: an unknown SHORT flag fails with file, line and token", () => {
    const fixture = ["```", "fleet status --driver fake -x", "```"].join("\n");
    const errors = checkCommandsAgainstRegistry(parseFleetCommands("s/SKILL.md", extractFencedLines(fixture)), listVerbs());
    expect(errors.some((e) => e.includes("s/SKILL.md:2 unknown flag -x"))).toBeTrue();
  });

  test("negative control: a value-taking flag at end of line with no value fails as missing value", () => {
    const fixture = ["```", "fleet status qds-20260901-000001 --driver", "```"].join("\n");
    const errors = checkCommandsAgainstRegistry(parseFleetCommands("s/SKILL.md", extractFencedLines(fixture)), listVerbs());
    expect(errors.some((e) => e.includes("s/SKILL.md:2 missing value for flag --driver"))).toBeTrue();
    // …and it does NOT count as satisfying the required-flag check either.
    expect(errors.some((e) => e.includes("missing required flag --driver"))).toBeTrue();
  });

  test("AC1 is non-vacuous: every skill yields ≥1 fenced fleet command and the workflow verbs appear", () => {
    // Deleting every fenced block from a skill must NOT keep this suite green.
    // factory-guide's preflight `--help` line counts as its one command.
    let commandsChecked = 0;
    const verbsSeen = new Set<string>();
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      const commands = parseFleetCommands(skill.label, extractFencedLines(skill.text));
      expect({ skill: name, parsed: commands.length >= 1 }).toEqual({ skill: name, parsed: true });
      commandsChecked += commands.length;
      for (const c of commands) if (!c.isHelp && c.verb !== undefined) verbsSeen.add(c.verb);
    }
    // Floor derived from the parse, not a magic number: at least one command per skill.
    expect(commandsChecked).toBeGreaterThanOrEqual(EXPECTED_SKILLS.length);
    // Pins the run-lifecycle verbs to fences (harvest/teardown in factory-harvest, attach in factory-observe).
    for (const v of ["harvest", "teardown", "attach"]) {
      expect({ verb: v, documented: verbsSeen.has(v) }).toEqual({ verb: v, documented: true });
    }
  });
});

describe("AC2 + INV-SKILL-3: no hand-rolled privileged commands", () => {
  test("no skill body instructs composing ssh, curl, key mint/revoke, VM destroy or git push", () => {
    const errors: string[] = [];
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      errors.push(...scanProhibited(skill.label, skill.text));
    }
    expect(errors).toEqual([]);
  });

  test("negative control: a fenced hand-rolled ssh fails with file and line; prose does not trip", () => {
    const fixture = ["prose: never run ssh directly, that drops the guards", "```", "$ ssh vm-42 'id'", "```"].join("\n");
    const errors = scanProhibited("s/SKILL.md", fixture);
    expect(errors).toHaveLength(1);
    expect(errors[0] as string).toContain("s/SKILL.md:3 prohibited instruction (ssh)");
  });

  test("negative control: command-position evasions trip — $(ssh …), sudo ssh, /usr/bin/ssh, VAR=x curl", () => {
    const fixture = [
      "```bash",
      "OUT=$(ssh vm-42 'id')",
      "sudo ssh vm-42 'id'",
      "/usr/bin/ssh vm-42 'id'",
      "TOKEN=abc curl https://api.example.com/x",
      "```",
    ].join("\n");
    const errors = scanProhibited("s/SKILL.md", fixture);
    expect(errors.filter((e) => e.includes("(ssh)"))).toHaveLength(3);
    expect(errors.filter((e) => e.includes("(curl)"))).toHaveLength(1);
  });

  test("negative control: key mint/revoke trip in either word order on the line", () => {
    const fixture = ["```", "create the key by hand", "the key mint endpoint", "key revoke via raw API", "```"].join("\n");
    const errors = scanProhibited("s/SKILL.md", fixture);
    expect(errors.filter((e) => e.includes("(key-mint)"))).toHaveLength(2);
    expect(errors.filter((e) => e.includes("(key-revoke)"))).toHaveLength(1);
  });

  test("negative control: a tilde-fenced hand-rolled ssh fails the prohibited scan", () => {
    const fixture = ["~~~bash", "ssh vm-42 'id'", "~~~"].join("\n");
    const errors = scanProhibited("s/SKILL.md", fixture);
    expect(errors).toHaveLength(1);
    expect(errors[0] as string).toContain("s/SKILL.md:2 prohibited instruction (ssh)");
  });
});

describe("AC4: fixed commercial/containment lint over every file this story adds", () => {
  test("zero pattern hits across the four skills and this test file, outside the two guide allowlist entries", () => {
    const errors: string[] = [];
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      errors.push(...lintCommercial(skill.label, skill.text, name === "factory-guide"));
    }
    errors.push(...lintCommercial(SELF_LABEL, readFileSync(SELF_PATH, "utf8"), false));
    expect(errors).toEqual([]);
  });

  test("negative control (DoD, INV-SKILL-5): a per-run price fails with file:line and pattern id", () => {
    // Constructed at runtime, one fragment per line: a literal occurrence in
    // THIS file would self-trip pattern (a), and (a) needs the price contiguous.
    const perRunPrice = ["$", "0.40 ", "per", " run"].join("");
    const errors = lintCommercial("fixture/SKILL.md", `header line\n${perRunPrice}\n`, false);
    expect(errors).toHaveLength(1);
    expect(errors[0] as string).toContain("fixture/SKILL.md:2 commercial-lint pattern (a)");
  });

  test("negative control (DoD, INV-SKILL-6): a per-VM containment capability claim fails on pattern (f)", () => {
    // Same construction discipline. NOTE: the story's example spelling without
    // a hyphen does NOT match the verbatim (f) regex (its trailing \\b rejects
    // it) — the fixture uses spellings the FIXED pattern actually catches.
    const capabilityClaim = [
      "per-box ",
      "egress is ",
      "restricted to an ",
      "allowlist per VM",
    ].join("");
    const errors = lintCommercial("fixture/SKILL.md", `${capabilityClaim}\n`, false);
    expect(errors).toHaveLength(1);
    expect(errors[0] as string).toContain("fixture/SKILL.md:1 commercial-lint pattern (f)");
  });

  test("the two guide allowlist entries exempt exactly their own lines, in factory-guide only", () => {
    const guideText = `${A1_SENTENCE}\n`;
    expect(lintCommercial("factory-guide/SKILL.md", guideText, true)).toEqual([]);
    // The same line anywhere else is NOT exempt — here it simply matches no
    // pattern, and a genuinely matching a-e line would fail even beside it.
    const scopedCaveat = [
      "containment in v5.0 is BYOK direct-provider ",
      "egress only; there is ",
      "no per-VM ",
      "egress ",
      "allowlist on exe.dev (DD-11)",
    ].join("");
    expect(lintCommercial("factory-guide/SKILL.md", `${scopedCaveat}\n`, true)).toEqual([]);
    expect(lintCommercial("factory-dispatch/SKILL.md", `${scopedCaveat}\n`, false)).toHaveLength(1);
  });

  test("negative control: a bare DD-11 citation does NOT exempt a pattern-(f) capability claim", () => {
    // Evasion probe: the exemption must require the `no per-VM` NEGATION; a
    // claim carrying only "(DD-11)" fails. Built from fragments — a literal
    // here would self-trip the lint over this file.
    const claim = [
      "The box ",
      "network is ",
      "restricted at the ",
      "hypervisor (DD-11).",
    ].join("");
    const errors = lintCommercial("factory-guide/SKILL.md", `${claim}\n`, true);
    expect(errors).toHaveLength(1);
    expect(errors[0] as string).toContain("factory-guide/SKILL.md:1 commercial-lint pattern (f)");
  });

  test("negative control: the §A.1 exemption is the verbatim sentence alone — an appended price claim fails", () => {
    // Evasion probe: appending a price to the allowlisted sentence's line must
    // not ride the exemption. Price built from fragments, same discipline.
    const padded = `${A1_SENTENCE} ${["$", "5 ", "per", " run"].join("")}`;
    const errors = lintCommercial("factory-guide/SKILL.md", `${padded}\n`, true);
    expect(errors.some((e) => e.includes("factory-guide/SKILL.md:1 commercial-lint pattern (a)"))).toBeTrue();
  });
});

describe("AC7: containment scope is stated, not implied (DD-11)", () => {
  test("factory-guide carries all three scope clauses, the DD-11 citation and the commercial-terms sentence", () => {
    const guide = loadSkill("factory-guide");
    const missing: string[] = [];
    if (!CLAUSE1_RE.test(guide.text)) missing.push("clause 1: BYOK direct-provider egress only");
    // The clause-2 message joins the two (f)-trigger words at runtime — a
    // literal on one source line would self-trip the commercial lint.
    if (!CLAUSE2_RE.test(guide.text)) {
      missing.push(
        [
          "clause 2: no per-VM",
          "egress",
          "allowlist on exe.dev",
        ].join(" "),
      );
    }
    if (!/\bexe\.dev\b/i.test(guide.text)) missing.push("clause 2: the exe.dev substrate named");
    if (!/\bOCI driver\b/i.test(guide.text)) missing.push("clause 3: re-enters with the OCI driver");
    if (!/§8 step 7/.test(guide.text)) missing.push("clause 3: design §8 step 7 cited");
    if (!/\bDD-11\b/.test(guide.text)) missing.push("the DD-11 citation");
    if (!guide.text.includes(A1_SENTENCE)) missing.push("the Commercial Terms §A.1 sentence (verbatim)");
    expect(missing).toEqual([]);
  });

  test("the other three skills make zero pattern-(f) containment claims (INV-SKILL-6)", () => {
    const errors: string[] = [];
    for (const name of EXPECTED_SKILLS) {
      if (name === "factory-guide") continue;
      const skill = loadSkill(name);
      errors.push(...lintCommercial(skill.label, skill.text, false).filter((e) => e.includes("pattern (f)")));
    }
    expect(errors).toEqual([]);
  });

  test("negative control (AC7): 'runs are network isolated' alone does NOT satisfy the scope clauses", () => {
    const bare = [
      "runs are ",
      "network isolated",
    ].join("");
    expect(CLAUSE1_RE.test(bare)).toBeFalse();
    expect(CLAUSE2_RE.test(bare)).toBeFalse();
  });
});

describe("AC6 + INV-SKILL-1/2: approval routing and token hygiene", () => {
  test("factory-observe routes approval to `fleet approve` with stdin token delivery", () => {
    const observe = loadSkill("factory-observe");
    expect(/\bfleet(?:\.ts)?\s+approve\b/.test(observe.text)).toBeTrue();
    expect(/\bstdin\b/i.test(observe.text)).toBeTrue();
    expect(/\btoken\b/i.test(observe.text)).toBeTrue();
  });

  test("no skill file contains a token-shaped value (INV-SKILL-1)", () => {
    const errors: string[] = [];
    for (const name of EXPECTED_SKILLS) {
      const skill = loadSkill(name);
      errors.push(...scanForTokenShapes(skill.label, skill.text));
    }
    expect(errors).toEqual([]);
  });

  test("negative control: the token-shape heuristic trips on a high-entropy string, spares shas and runIds", () => {
    const shaped = scanForTokenShapes("s/SKILL.md", "token: aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK\n");
    expect(shaped).toHaveLength(1);
    expect(scanForTokenShapes("s/SKILL.md", `sha ${"b".repeat(40)} and run qds-20260831-000001\n`)).toEqual([]);
  });
});

// ─── C: the mandatory DoD e2e, in-process against the fake driver ────────────

const E2E_ENV_KEYS = ["QDS_RUNS_DIR", "QDS_FAKE_BOXES_DIR", "QDS_COST_LEDGER_FILE", "QDS_COST_CONFIG_FILE", "OPENROUTER_PROVISIONING_KEY"] as const;

/**
 * The documented `--driver` / `--brief` / `--dir` VALUES are stripped and the
 * test's injected fakes take their place — deliberately: a skill's documented
 * driver name must never reach resolveDriver inside a test (no real spend),
 * and the runs/brief paths must land in the per-test tmpdir, not the repo.
 */
function sanitizeArgvForFakeRun(tokens: string[]): string[] {
  const DROP_VALUE_FLAGS = new Set(["--driver", "--brief", "--dir"]);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (DROP_VALUE_FLAGS.has(name)) {
      if (!t.includes("=")) i++; // drop the value token too (space form)
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Substitute the captured runId for `<runId>`; a placeholder before any dispatch is a skill-authoring error. */
function substituteRunId(argsText: string, runId: string | undefined, cmd: FleetCommand): string {
  if (!argsText.includes("<runId>")) return argsText;
  if (runId === undefined) {
    throw new Error(`${cmd.label}:${cmd.line} <runId> placeholder used before any documented dispatch printed a runId`);
  }
  return argsText.split("<runId>").join(runId);
}

function requireDocumentedCommand(skillName: string, verb: string, mustContain?: string): FleetCommand {
  const skill = loadSkill(skillName);
  const commands = parseFleetCommands(skill.label, extractFencedLines(skill.text));
  const found = commands.find((c) => !c.isHelp && c.verb === verb && (mustContain === undefined || c.argsText.includes(mustContain)));
  if (!found) {
    const qualifier = mustContain === undefined ? "" : ` carrying the ${mustContain} placeholder`;
    throw new Error(`${skill.label} documents no fenced '${verb}' command${qualifier} — the DoD e2e needs one`);
  }
  return found;
}

function parseAckRunId(outOnly: string[], cmd: FleetCommand): string {
  const ackLine = outOnly.find((l) => l.includes('"runId"'));
  if (ackLine === undefined) {
    throw new Error(`${cmd.label}:${cmd.line} dispatch printed no '"runId"' ack line on stdout`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ackLine);
  } catch {
    throw new Error(`${cmd.label}:${cmd.line} dispatch ack line is not JSON: ${ackLine.trim()}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { runId?: unknown }).runId !== "string") {
    throw new Error(`${cmd.label}:${cmd.line} dispatch ack has no string runId: ${ackLine.trim()}`);
  }
  return (parsed as { runId: string }).runId;
}

/** Minimal replica of tests/fleet/cli.test.ts's validBriefJson — the manifest must exist on disk under repoRoot. */
function writeBriefFixture(dir: string): string {
  const manifestDir = join(dir, "manifests");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "pipeline.json"),
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "e2e-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    }),
  );
  return JSON.stringify({
    repoSlug: "owner/repo",
    issueId: 42,
    commitSha: "b".repeat(40),
    manifestPath: join("manifests", "pipeline.json"),
    repoUrl: "https://github.com/owner/repo",
  });
}

describe("DoD e2e (MANDATORY): the documented dispatch → observe sequence against the fake driver", () => {
  test("the runId dispatch prints is the runId the observe (status) command is invoked with", async () => {
    const dir = mkdtempSync(join(tmpRoot, "e2e-"));
    const boxesDir = join(dir, "boxes");
    const runsDir = join(dir, "runs");
    const savedEnv: Record<string, string | undefined> = {};
    const outOnly: string[] = [];
    const errCaptured: string[] = [];
    const out = (s: string): void => {
      outOnly.push(s);
    };
    const errOut = (s: string): void => {
      errCaptured.push(s);
    };
    try {
      // Env redirects per the tests/fleet/cli.test.ts precedent: the two
      // directory vars point inside the tmpdir; the explicit ledger/config
      // file vars are unset so nothing escapes to the developer's machine.
      for (const k of E2E_ENV_KEYS) savedEnv[k] = process.env[k];
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_COST_LEDGER_FILE;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_COST_CONFIG_FILE;
      process.env.QDS_RUNS_DIR = join(dir, ".sandbox", "runs");
      process.env.QDS_FAKE_BOXES_DIR = join(dir, ".sandbox", "fake-boxes");
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
      writeFileSync(join(dir, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');

      const briefJson = writeBriefFixture(dir);
      // One shared deps object across the verbs, so store/driver state carries
      // over — the cli.test.ts:562-612 pattern.
      const shared: Partial<FleetDeps> = {
        driver: new FakeDriver(boxesDir),
        keyApi: new FakeKeyApi(),
        store: new RunRecordStore(runsDir),
        ledgerFactory: () => goodLedger(),
        readBrief: async () => briefJson,
        repoRoot: dir,
        lockPath: join(dir, ".sandbox", "fleet.lock"),
      };

      // 1. The documented dispatch command, run exactly as the skill writes it
      //    (modulo the fixture substitutions sanitizeArgvForFakeRun documents).
      const dispatchCmd = requireDocumentedCommand("factory-dispatch", "dispatch");
      const dispatchArgv = sanitizeArgvForFakeRun(cutShell(words(substituteRunId(dispatchCmd.argsText, undefined, dispatchCmd))));
      const dispatchCode = await run(dispatchArgv, out, shared, errOut);
      expect({ argv: dispatchArgv, code: dispatchCode, err: errCaptured.join("") }).toEqual({ argv: dispatchArgv, code: 0, err: "" });
      const runId = parseAckRunId(outOnly, dispatchCmd);

      // 2. The documented observe command carrying the <runId> placeholder;
      //    the extracted sequence chains the captured runId into it.
      const statusCmd = requireDocumentedCommand("factory-observe", "status", "<runId>");
      const statusArgv = sanitizeArgvForFakeRun(cutShell(words(substituteRunId(statusCmd.argsText, runId, statusCmd))));
      outOnly.length = 0;
      errCaptured.length = 0;
      const statusCode = await run(statusArgv, out, shared, errOut);
      expect({ argv: statusArgv, code: statusCode, err: errCaptured.join("") }).toEqual({ argv: statusArgv, code: 0, err: "" });

      // The contract itself: the placeholder carried the dispatch runId, and
      // the observe output is about that run (exit 4 otherwise, not 0).
      expect(statusArgv).toContain(runId);
      expect(outOnly.join("")).toContain(runId);
      console.log(`skill-contract e2e: runId chained dispatch → status (${runId})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`DF3.5 skill-contract e2e (fake driver): ${msg}`);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]; // dynamic key — noDelete does not fire here
        } else {
          process.env[k] = v;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
