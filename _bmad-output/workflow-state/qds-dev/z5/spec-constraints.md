# Z5 spec constraints (Track D — spec review)

**Story:** `_bmad-output/sprint-artifacts/dark-factory-v6/stories/z5-chassis-fate.md` (Z5: Chassis fate — utilities to `src/lib/`, dormant server surface per DD-18)
**Compiled:** 2026-10-13, from the seven named sources, every fact re-verified against the working tree this session.

---

## CONSTRAINTS

**SC-1 — Pure extraction of the load-bearing utilities.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:59` (DD-18).
DD-18 rules: utilities `log`/`newRequestId`/`maskEnv` are load-bearing (`maskEnv` in `mcp/tool-bridge.ts`) → extracted to `src/lib/` (Z5), **pure move** — `src/swarmclaw/log.ts` moves verbatim to `src/lib/log.ts`; `maskEnv` moves verbatim to `src/lib/mask-env.ts`; no behavior change in any moved symbol.
Enforced by: AC1 (byte-identical bodies; import-path lines the only permitted diff on moved symbols) + DoD "git mv-equivalent" row.

> DD-18 verbatim (register :59): "**Chassis fate** (`src/swarmclaw/`): utilities `log`/`newRequestId`/`maskEnv` are load-bearing (~50 importers; `maskEnv` in `mcp/tool-bridge.ts`) → extracted to `src/lib/` (Z5), pure move. Server surface (`createServer`/routes/store) is orphan (only `src/index.ts` re-export + tests) → **dormant-retained behind a fixture** pending ADR-2's outcome (an ADR-2 ACCEPT re-opens the query-surface question; REJECT closes it). Z5 implements; a deletion without a named restoration path is refused."

**SC-2 — Dormant retention of the server surface behind a fixture.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:59` (DD-18); charter row `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md:76,117`.
The server surface (`createServer`, `routes/*`, `store/*`, the `src/index.ts` re-export) is retained byte-identical — behavior bodies untouched, import-path lines the only permitted diff — and fenced by a NEW dormancy-guard test. Z5 implements neither arm of ADR-2; ACCEPT re-opens the query-surface question, REJECT closes it — both are named restoration-path events, never silent deletions.
Enforced by: AC2 + AC4 (new `tests/swarmclaw/dormancy.test.ts`) + Trigger Surface rows.

**SC-3 — Deletion without a named restoration path is refused.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:59` (DD-18: "a deletion without a named restoration path is refused"); reaffirmed at `:72`-considered-rejected via story Technical Notes.
No implementation may delete the `src/swarmclaw/` server subtree "because nothing imports it"; revisit is only through the named ADR-2 path (which additionally breaks the p0-10 probe, SC-6).
Enforced by: AC2 negative control (a deleting implementation MUST fail AC2).

**SC-4 — Fixed namespace, story path, and destination home.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:54` (DD-14) + `:26-28` (§1 namespace/layout rows).
The v6 namespace is epics Z/M/A/J/G (Z5 sits in the Z = zeropoint macro-host epic); v6 story files live at `_bmad-output/sprint-artifacts/dark-factory-v6/stories/{id-kebab}-{kebab-title}.md`; and the module-root row fixes the chassis-utilities home at `src/lib/` (Z5) — so the destination paths `src/lib/log.ts` and `src/lib/mask-env.ts` are mandated, not a choice.
Enforced by: AC1 + Files to Modify (the two new `src/lib/` files) — path-level compliance; no AC governs the file's own location beyond AC1/AC3 referencing it.

> DD-14 verbatim (register :54): "**Namespace + split ratified** per §1–§2 above: epics Z/M/A/J/G; S→Z rename; v6a/v6b cut line restated 2026-10-02 (v6a = zero E21 dependency, ships standalone; v6b = E21-gated stories + the E21-independent lane, which proceeds without E21) — supersedes the charter D-1 one-liner 'needs Home bots', which under-counts v6b's independent lane; story paths per §1."

**SC-5 — Importer census is 74 files / 78 import lines; enumerate by grep, never by guess.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:358-359` (§8a item 15, the DD-18 erratum: "the chassis importer census is 74 files / 78 import lines (greppable); DD-18's '~50' was a pre-census approximation, superseded by Z5's count"); reproduced by the verdict's verified-vs-reality (`_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:38`: "grep -rln 'swarmclaw/log' = 74 (src 27, scripts 8, tests 39)").
DD-18's "~50 importers" is a superseded approximation; the binding census is 74 files / 78 import lines (27 `src/` modules, 8 `scripts/`, 39 test files), and the rewrite set must be enumerated at dev time by grep, not taken from any prose count.
Enforced by: AC3 + Technical Notes ("enumerated at dev time by grep, not guessed") + DoD contract grep (`grep -r "swarmclaw/log" src scripts tests` → 0 files).

**SC-6 — The retained surface is load-bearing twice; the p0-10 gate probe pins `createServer`.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:360-362` (§8a item 15) + `src/gate/assertions/p0-10-gitnexus.ts:11-14,26-27`.
`src/gate/assertions/p0-10-gitnexus.ts:27` sets `PROBE_SYMBOL = "createServer"` — deliberately a real production symbol in `src/swarmclaw/index.ts`, NOT the fixture symbol, because gitnexus's default ignore list filters `fixtures/` so the fixture symbol is absent from the standing index and would produce a false red. If the surface were deleted, `createServer` vanishes from the standing index and the P0.11 sequencing gate (PRD §13 clause 7b — context/impact must return real graph data) goes red: the deletion breaks the gate, independently of ADR-2. The register records the surface as load-bearing twice (ADR-2 restoration path + this probe).
Enforced by: AC2 negative control (deletion MUST fail) + Technical Notes bullet "load-bearing twice".

> p0-10 exact lines (`src/gate/assertions/p0-10-gitnexus.ts:11-14,26-27`):
> "The probe symbol is deliberately a real production symbol (`createServer` in
> src/swarmclaw/index.ts), NOT the fixture symbol P0.10's own test uses:
> gitnexus's default ignore list filters `fixtures/`, so that symbol is absent
> from the standing index and would produce a false red."
> `/** A production symbol that is present in the standing index. */`
> `const PROBE_SYMBOL = "createServer";`

**SC-7 — ADR-1 is ACCEPTED and closed; Z5's "dormant" is the narrower in-repo sense only.**
Source: `docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md:3,5,16,26` + register `:8-9` ("the v5 register … and ADR-1 are closed records — never edited").
ADR-1 is ACCEPTED (operator-signed 2026-09-30): the zeropoint SwarmClaw (the fork) is awake as protocol orchestrator — it "hosts macro processes via `external_job`", reversing DD-7's chassis-wide dormant premise — while its §Consequences (:26) keeps "DD-7's query-surface chassis role stands unchanged; this ADR only adds the `external_job` hosting role on top of it". So ADR-1's ACCEPT wakes the swarmclaw *product*, not the vendored HTTP surface inside this repo: that surface gains no consumer from ADR-1 and remains an in-repo orphan with zero production consumers in QDS-Factory — Z5's framing "dormant = in-repo orphan only" is consistent with ADR-1, and Z5 must not edit the closed ADR-1 record.
Enforced by: AC2 (the retained-but-dormant posture this framing mandates) + story Spec Reference "ancestry disposition" (DD-7's premise is DEAD as a chassis-wide claim; ADR-1 untouched).

**SC-8 — Charter facts: utilities LOAD-BEARING across four domains; server surface orphan; Z5 = 2 pts, deps none.**
Source: `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md:39` (§2.1) + `:76` (Z5 row) + `:85` (Wave 2 slot).
Charter §2.1 states the "In-repo chassis `src/swarmclaw/`" facts: utilities (`log`/`newRequestId`/`maskEnv`) are LOAD-BEARING — imported by hindsight, judgment, providers, fleet — while the server surface (createServer/routes/store) = orphan, "Fate = DD-18 + Z5". The import rewrite must therefore cover all four production consumer domains, and Z5 has zero dependency edges (charter row: 2 pts, deps none; wave-2 slot).
Enforced by: AC3 (rewrite set spans providers ×15, fleet ×8, audit ×2, judgment/client, reverify, hindsight ×4) + AC2 + E2E Slice "Dependency edges: none".

**SC-9 — R3 pre-move truth: `mcp/` is NOT orphan; the extraction is what severs hindsight's reach into it.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/research/R3-code-facts.md:127-128` (§6) + `:130` ("`mcp/` is NOT orphan — stdio-transport + tool-bridge are hindsight's plumbing").
Pre-move, `mcp/stdio-transport.ts` re-exports the log trio and is imported by all four hindsight modules + `scripts/provision-hindsight-banks.ts`; `maskEnv` is DEFINED in `mcp/tool-bridge.ts:158` and imported by exactly two external consumers — `src/hindsight/client.ts:26` (INV-HM1 env-diagnostics masking; call site `:396`) and `routes/mcp-servers.ts:19,140` (INV-SC5). Hindsight's four modules + the provision script are a SEPARATE rewrite set (they import the stdio re-export, not `swarmclaw/log`, so the AC3 grep does not surface them), and post-move `mcp/`'s remaining content (INV-SC2/SC3 machinery, tool bridge) is the retained surface's own plumbing — R3's "NOT orphan" classification is pre-move truth only.
Enforced by: AC3 (the separate rewrite-set directive + `routes/mcp-servers.ts` imports `src/lib/mask-env`) + AC1 (INV-SC5/INV-HM1 pins pass with unmodified assertion bodies) + Technical Notes "Post-move shape".

**SC-10 — Orphan bounds: only `src/swarmclaw/index.ts` itself, the `src/index.ts` re-export, and tests consume the server surface.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/research/R3-code-facts.md:130` (§6) + verdict verified-vs-reality `z5.json:39`.
R3 confirms: `createServer`/`routes/*`/`store/*` are consumed ONLY by `src/swarmclaw/index.ts` itself (routes+stores are its internals, :16-25), the repo-root re-export `src/index.ts:1-2` (which exports `createServer` and `type { SwarmClawServer }`), and the `tests/swarmclaw/` fixture tests; no production module under `src/` or `scripts/` imports the server surface. Post-move, the ONLY module outside `src/swarmclaw/` referencing it is the dormant re-export barrel `src/index.ts` (the restoration entry point).
Enforced by: AC2 + AC4(a) (the guard's outside-importer check with the `src/index.ts` carve-out) + DoD e2e demo (`bun test tests/swarmclaw/` green on the retained fixture).

**SC-11 — Five intra-swarmclaw relative-import consumers are invisible to the story's greps.**
Source: `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-02-v6-pre-dev-adversarial-review-tracker.md:60` (V12: "1M/4L — 5 intra-swarmclaw relative-import consumers invisible to the story's greps (broken build for a dev following the enumeration)"); re-verified this session: `src/swarmclaw/index.ts:16`, `src/swarmclaw/mcp/tool-bridge.ts:16`, `src/swarmclaw/routes/agents.ts:5`, `src/swarmclaw/routes/mcp-servers.ts:16`, `src/swarmclaw/store/mcp-store.ts:16` all take `log`/`newRequestId` (and `StdioTransport`) through `./mcp/stdio-transport.ts` / `./stdio-transport.ts` relative imports (and `stdio-transport.ts:17-18` imports `../log.ts` directly).
When the log re-export drops and `src/swarmclaw/log.ts` is deleted, these five files' relative imports must be re-pointed — they match neither AC3 grep (`swarmclaw/log`, `maskEnv` from `tool-bridge`), so a dev following only the grep enumeration ships a broken build; the tsc gate is the backstop.
Enforced by: AC2 ("import-path lines are the ONLY permitted diff in retained files" covers exactly these re-points) + Technical Notes region-ownership bullets + DoD `tsc` green.

**SC-12 — The AC4(a) `src/index.ts` carve-out is mandatory, not optional.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:11-14` (applied HIGH) + `src/index.ts:1-2` (verified).
The dormancy guard fails any module outside `src/swarmclaw/` importing `createServer`/`routes/*`/`store/*` — but the story MANDATES keeping `src/index.ts`'s dormant re-export (`createServer`/`SwarmClawServer`) as the restoration entry point, so a guard without the explicit exemption "other than the dormant re-export barrel `src/index.ts`" is red on the story's own end-state tree; the carve-out with rationale must survive to implementation.
Enforced by: AC4(a) carve-out + its rationale clause.

**SC-13 — The six re-export test consumers must be rewritten (import lines only).**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:16-19` (applied MEDIUM).
Dropping stdio-transport's log re-export breaks six test files the naive enumeration misses: `tests/hindsight/{bank-provisioning,bridge-round-trip,client,memory-round-trip,mulch-import}.test.ts` (`setLogSink`/`LogEntry`) and `tests/providers/run-record.test.ts` (`setLogSink`). All six are disjoint from the 39 `swarmclaw/log` test matches (they import `mcp/stdio-transport`), so only the tsc Contract gate catches them if unenumerated; their import lines change, assertion bodies do not.
Enforced by: AC3 (the named six in the directive enumeration) + AC1 (import-lines-only) + Files to Modify.

**SC-14 — The 27-count composition is exact; `src/gate/` has zero log imports.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:21-24` (applied MEDIUM).
The 27 `src/` modules matching `swarmclaw/log` are exactly: providers ×15 (12 + exedev 3), fleet ×8, audit ×2, judgment/client ×1, reverify ×1 = 27. Hindsight's four modules + `provision-hindsight-banks.ts` are the separate stdio-re-export set (SC-9), and `src/gate/` has zero log imports (comment references only) — never count either inside the 27.
Enforced by: AC3 + Technical Notes ("exact counts at spec time: 27 `src/` modules … 8 `scripts/`, 39 test files").

**SC-15 — tool-bridge's import SPLITS — re-point, not add; `StdioTransport` stays; no `maskEnv` import.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:26-29` (applied LOW); verified at `src/swarmclaw/mcp/tool-bridge.ts:16`.
`tool-bridge.ts` imports `{log, newRequestId, StdioTransport}` from `./stdio-transport.ts`: the log pair is re-pointed to `src/lib/log.ts`, the `StdioTransport` type stays on stdio-transport, and NO `maskEnv` import is added (tool-bridge does not consume it — it defines it, and the definition is deleted per the move).
Enforced by: AC2 (import-path-only diff in retained files) + Technical Notes region ownership + Files to Modify.

**SC-16 — AC4(b)'s "swarmclaw utility path" is mechanically defined as AC3's two greps.**
Source: `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json:31-34` (applied LOW).
The dormancy guard's clause (b) — "any module anywhere imports a swarmclaw utility path" — is defined mechanically as exactly AC3's two greps: `swarmclaw/log` anywhere, or `maskEnv` imported from `tool-bridge`. The fixture must implement these mechanically (and its failure messages must name the offending file paths).
Enforced by: AC4(b) + DoD dormancy-guard row.

**SC-17 — The providers → log dependency-direction rule is carried verbatim into `src/lib/log.ts`.**
Source: `src/swarmclaw/log.ts:4-7` (docblock, quoted in story Spec Reference and Security Invariants CC-9).
The moved `src/lib/log.ts` carries the docblock rule verbatim: non-MCP modules log without reaching into the MCP subsystem — "the dependency direction must stay providers → log, never providers → transport." No consumer may be re-wired to import through any transport/bridge path during the rewrite.
Enforced by: AC1 (verbatim body) + Security Invariants CC-9 + AC6.

**SC-18 — stdio-transport's docblock contract is updated to record the re-export's removal; logic untouched.**
Source: `src/swarmclaw/mcp/stdio-transport.ts:11-14` (docblock: "this module re-exports it so existing consumers keep their import paths") via story Technical Notes region-ownership bullet.
When the re-export at `stdio-transport.ts:18` is removed, the docblock's stated contract must be updated to record that removal — the INV-SC2/SC3 allowlist machinery and all logic stay untouched (no cleanup of that machinery is in scope).
Enforced by: AC2 (import-path/docblock-only diff in retained files) + Files to Modify ("docblock updated").

**SC-19 — Box-image neutrality: no Dockerfile or pin-constant edit; no re-pin ritual is owed.**
Source: `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:66` (DD-25 item 6: box image = `oci/exedev/Dockerfile`, COPY set ~:277-355) + verified `oci/exedev/Dockerfile:280` (`COPY src/lib/ src/lib/`) and `:352` (`COPY src/swarmclaw/ src/swarmclaw/`).
Both source and destination directories are already directory-level COPY entries in the enumerated Dockerfile COPY set, so the move does not shift `deriveBuildId` inputs; `oci/exedev/Dockerfile`, `scripts/build-exedev-image.ts`, and `src/providers/exedev/driver.ts` pin constants must be untouched (the standing image-pin red is wave-0 ops — not this story's to fix or worsen).
Enforced by: AC5 (negative control: a Dockerfile edit MUST fail) + DoD integration row.

**SC-20 — Layer rule: moved units are dependency-free; consumers import from the sanctioned low tier.**
Source: verdict verified-vs-reality `z5.json:40-41,44` ("log.ts has zero imports"; "maskEnv … pure/no importers beyond the definer + two consumers"; `src/lib/http.ts` + `file-lock.ts` precedent exists) + charter §2.1 established `src/lib/` home pattern.
`src/lib/log.ts` and `src/lib/mask-env.ts` must import nothing (log.ts has zero imports today; `maskEnv` is a pure function), so the move cannot create a cycle; providers/judgment/fleet/hindsight import them from the sanctioned low tier per the `src/lib/http.ts` precedent, and the rule that `src/providers/` imports no tier-3 workspace code is untouched.
Enforced by: AC6.

**SC-21 — Repo dev rules: GitNexus `impact()` pre-edit, `detect_changes()` pre-commit, never-edit list untouched.**
Source: repo `CLAUDE.md` (GitNexus section, binding) via story Technical Notes "Dev rules (repo CLAUDE.md, binding)" bullet.
GitNexus `impact()` must run on `log`/`setLogSink`/`maskEnv` before editing (these three have the repo's widest fan-out), `detect_changes({scope:"compare", base_ref:"dev"})` before commit, and the never-edit list (`AUDIT_HOPS`, `classifyRunExit`, `classifyDiffScope`, provider-layer import rules) stays untouched — the rewrite touches provider import LINES, never the layer rule itself.
Enforced by: AC6 (last clause) + DoD contract rows + Infra Prerequisites (GitNexus standing-index row).

---

## Verbatim source quotes (full, as required)

**DD-18** — `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:59` (quoted in full under SC-1).

**DD-14** — `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:54` (quoted in full under SC-4).

**ADR-1 "ACCEPTED" for the zeropoint swarmclaw** — `docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md:3`: "**Status:** ACCEPTED — signed by the operator 2026-09-30 (in the OpenRig × Factory closeout session); the program is closed". Decision :16: "**SwarmClaw hosts macro processes via `external_job`.** … Swarmclaw owns process state, scheduling, branching, and notification; the QDS fleet owns provisioning, spend, execution, and the verdict." Consequences :26: "DD-7's query-surface chassis role stands unchanged; this ADR only adds the `external_job` hosting role on top of it." Consistency verdict for Z5: ACCEPTED wakes the swarmclaw product (fork) as orchestrator but assigns the vendored in-repo HTTP surface no new role or consumer — "dormant = in-repo orphan only" is exactly the state ADR-1 leaves it in (SC-7).

**P0.10 probe lines** — `src/gate/assertions/p0-10-gitnexus.ts:11-14,26-27` (quoted in full under SC-6).

**z5 verdict applied findings** — all five are carried as SC-12 (HIGH, AC4 carve-out), SC-13 (MEDIUM, six re-export test consumers), SC-14 (MEDIUM, 27-count correction), SC-15 (LOW, tool-bridge import split), SC-16 (LOW, AC4(b) mechanical definition); verdict `_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/z5.json` converged with 0 surviving findings.

**Adversarial tracker Z5 rows** — `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-02-v6-pre-dev-adversarial-review-tracker.md:35` (Layer-1 Z5: 2 iterations, converged, 1/2/2 applied) and `:60` (V12 Layer-2 finding, carried as SC-11).

CONSTRAINT COUNT: 21
