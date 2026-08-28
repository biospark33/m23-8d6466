/**
 * gitnexus CLI contract suite — THE drift alarm.
 *
 * Every tool the repo's tests and workflows exercise (query, context, impact —
 * resolved AND ambiguous variants, cypher, list, detect-changes) is validated
 * here against the STRICT full-payload schemas in cli-contract.ts, and the
 * installed CLI version is pinned against tests/gitnexus/gitnexus-cli-contract.json.
 *
 * Design contract (drift triage layer):
 *  - A future upstream update should produce exactly ONE loud, self-explanatory
 *    failure — here — naming the drifted fields and both versions, NOT
 *    scattered zod noise across the functional suite.
 *  - graph-queries.test.ts asserts only the minimal fields its behaviors depend
 *    on (lenient schemas, additive-tolerant). It is NOT the drift alarm; this
 *    file is. Both run under the same `bun test` gate — if gitnexus tests are
 *    ever excluded from a gate, the alarm is disarmed there.
 *  - "Tool broken" (non-zero exit, non-JSON) and "contract drifted" (valid JSON,
 *    wrong shape) and "version moved" (pin mismatch) are three distinct,
 *    labeled failure modes.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  ContextFoundStrict,
  ContextNotFoundStrict,
  CypherResultStrict,
  DETECT_CHANGES_TEXT_RE,
  EXPECTED_CLI_VERSION,
  ImpactAmbiguousStrict,
  QueryResultStrict,
  assertContract,
  assertImpactContract,
} from "./cli-contract.ts";
import {
  FIXTURE_PATH,
  GN,
  REPO_ROOT,
  gn,
  gitnexusVersion,
  preflightOrWarn,
} from "./harness.ts";

const SKIP_REASON = preflightOrWarn("contract.test");
const describeIndexed = describe.skipIf(SKIP_REASON !== null);

// The version pin runs without an INDEX but still needs the BINARY: on a host
// with no gitnexus at all (e.g. a CI runner that never installs it) there is
// nothing to pin — same missing-dependency skip discipline as the index
// preflight, with a diagnostic so the skip is never silent.
const CLI_PROBE = gitnexusVersion();
if (CLI_PROBE.missing) {
  console.warn(
    `[contract.test] SKIPPING version pin — gitnexus binary not found (resolution: ${GN}).`,
  );
}

describe("gitnexus CLI version pin (runs even without an index)", () => {
  test.skipIf(CLI_PROBE.missing)("installed CLI version matches the pinned contract version", () => {
    const installed = CLI_PROBE.version;
    // Distinct failure modes, labeled:
    //  - null  -> the binary ran but produced nothing: TOOL BROKEN, not drift.
    //  - mismatch -> VERSION MOVED: adopt deliberately via the AGENTS.md ritual.
    if (installed === null) {
      throw new Error(
        `[gitnexus tool broken] \`gitnexus --version\` did not produce a version string (binary: ${GN}). The CLI is broken — this is not contract drift. Reinstall/repair gitnexus, then rerun.`,
      );
    }
    if (installed !== EXPECTED_CLI_VERSION) {
      throw new Error(
        `[gitnexus version moved] installed CLI is ${installed}, contract pinned to ${EXPECTED_CLI_VERSION} (tests/gitnexus/gitnexus-cli-contract.json). Adopt the new version deliberately — AGENTS.md upgrade ritual: bump the pin, reindex (scripts/install-gitnexus-plus.sh), run tests/gitnexus/, review the strict-schema diff.`,
      );
    }
  });
});

describeIndexed("strict payload contracts (the drift alarm)", () => {
  const installed = gitnexusVersion().version;

  test("query payload matches the strict contract", () => {
    assertContract("query", gn(["query", "SwarmClaw routes", "-r", REPO_ROOT]), QueryResultStrict, installed);
  });

  test("context found-payload matches the strict contract", () => {
    assertContract(
      "context (found)",
      gn(["context", "registerSwarmClawAgent", "-r", REPO_ROOT]),
      ContextFoundStrict,
      installed,
    );
  });

  test("context not-found payload matches the strict contract", () => {
    const raw = gn(["context", "ZZZ_DEFINITELY_NOT_A_SYMBOL", "-r", REPO_ROOT]);
    // A fuzzy-resolved "found" is ALSO a documented graceful variant (the
    // functional AC-3 test covers the semantic rule) — but its shape must then
    // be the strict found shape. Anything else is drift.
    const notFound = ContextNotFoundStrict.safeParse(raw);
    if (notFound.success) return;
    assertContract("context (not-found)", raw, ContextFoundStrict, installed);
  });

  test("impact resolved payload matches the strict contract (disambiguated target)", () => {
    // -f pins the fixture's registerSwarmClawAgent — a bare unique name today,
    // but the 2026-08 dispatch/dispatch collision proved uniqueness is not a
    // stable property of a growing index.
    const raw = gn(["impact", "registerSwarmClawAgent", "-f", FIXTURE_PATH, "-r", REPO_ROOT, "--direction", "upstream"]);
    const variant = assertImpactContract(raw, installed);
    expect(variant).toBe("resolved");
  });

  test("impact ambiguous payload matches the strict contract (bare 'dispatch' probe)", () => {
    // `dispatch` is ambiguous in this index (fixture + src/fleet/dispatch.ts).
    // If a future tree makes it unique again, the resolved variant satisfies
    // the union and this leg still passes — the contract is the UNION.
    const raw = gn(["impact", "dispatch", "-r", REPO_ROOT, "--direction", "upstream"]);
    const variant = assertImpactContract(raw, installed);
    if (variant === "ambiguous") {
      // Pin the variant's semantic content, not just its shape: the candidates
      // must name both dispatch symbols so a silent candidate-drop is caught.
      const parsed = ImpactAmbiguousStrict.parse(raw);
      expect(parsed.totalCandidates).toBeGreaterThanOrEqual(2);
      expect(parsed.candidates.some((c) => c.filePath === FIXTURE_PATH)).toBe(true);
    }
  });

  test("cypher result matches the strict contract", () => {
    assertContract(
      "cypher",
      gn(["cypher", "MATCH (f:File) RETURN count(f) AS c", "-r", REPO_ROOT]),
      CypherResultStrict,
      installed,
    );
  });

  test("detect-changes text contract holds (the AGENTS.md pre-commit tool)", () => {
    // Text-only output in 1.6.9 (no --json flag). A clean-tree compare against
    // HEAD exercises the zero-change form; the headline regex also accepts the
    // "Changes: N files, M symbols" form, so the pin survives content changes.
    const r = spawnSync(GN, ["detect-changes", "--scope", "compare", "--base-ref", "HEAD", "-r", REPO_ROOT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const out = r.stdout ?? "";
    if (!DETECT_CHANGES_TEXT_RE.test(out)) {
      throw new Error(
        `[gitnexus contract drift] detect-changes text output changed shape.\nInstalled CLI: ${installed ?? "UNREADABLE"} — pinned to ${EXPECTED_CLI_VERSION}.\nFirst 300 chars: ${out.slice(0, 300)}`,
      );
    }
  });
});
