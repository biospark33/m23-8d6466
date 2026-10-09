# Edge Case Hunter — Round 2 (over the round-1 FIX wave)

Scope: `_bmad-output/reviews/m3-1-round2/diff.patch` (F-001..F-033 fixes) + read access to the branch `feature/m3-1-manager-meta-banks-l3-consolidate`. Verification: ran the 7 touched/adjacent suites (264 tests, 0 fail — log `/tmp/qds-edge-r2.log`); every finding below was confirmed against current file state, not the patch alone.

```json
[
  {
    "location": "src/hindsight/nightly-consolidate.ts:246-249,269,447-483",
    "trigger_condition": "deps.wallClockBudgetMs or refreshEvidenceTimeoutMs is NaN",
    "guard_snippet": "if (!Number.isFinite(wallBudgetMs)) throw new MemgateError(\"nightly-budget-invalid\", \"wallClockBudgetMs must be a finite ms number\", \"pass a finite deps.wallClockBudgetMs\"); // same for refreshEvidenceTimeoutMs",
    "potential_consequence": "wallDeadline=NaN; Math.min(x,NaN)=NaN; observeRefresh deadline check never trips — infinite poll loop"
  },
  {
    "location": "scripts/provision-hindsight-banks.ts:529-530",
    "trigger_condition": "rerun of a LEGACY 52-form family fails mid-roster PUT",
    "guard_snippet": "const base = /* detect like rerunAwareProvision */ safeRepoBaseCandidates(resolveBankId(repoSlug)).find((c) => preBankIds.includes(c)) ?? safeRepoBase(repoSlug); const roster = canonicalRoster(base);",
    "potential_consequence": "compensation claims the 50-form roster; created legacy qa/maint meta banks land in residue as unclaimed-created, never compensated"
  },
  {
    "location": "scripts/memory-nightly.ts:207",
    "trigger_condition": "repoBankId resolves to a legacy collision form (e.g. 52-char base + \"-2\" = 55 chars)",
    "guard_snippet": "const banks = LANES.map((l) => `${repoBankId}-${l}-meta`); const invalid = banks.filter((b) => !BankIdSchema.safeParse(b).success); if (invalid.length > 0) return { code: 2, envelope: { ok: false, code: \"bank-id-overflow\", leg: \"crontab\", repoSlug, remediation: `legacy-era family yields ids over the 64-char cap (${invalid.join(\", \")}) — re-provision under the 50-char rule` } };",
    "potential_consequence": "derived -maint-meta id is 66 chars (> 64 cap), that bank can never exist — nightly fails that bank every run"
  },
  {
    "location": "scripts/p0-9/leg-lib.ts:828-830",
    "trigger_condition": "FOREIGN bank exists named the slug's bare 50- or 52-form (no dev-meta sibling)",
    "guard_snippet": "const familyBase = safeRepoBaseCandidates(resolveBankId(repoSlug)).find((c) => opts.existingBankIds.includes(c) && opts.existingBankIds.includes(`${c}-dev-meta`));",
    "potential_consequence": "rerun lane PUT-upserts a manager meta family onto the foreign base and claims it as this attempt's own"
  },
  {
    "location": "src/hindsight/nightly-consolidate.ts:269,447-483",
    "trigger_condition": "preflight+consolidate consume the budget; observeRefresh entered with deadline already past",
    "guard_snippet": "if (nowMs(deps) >= deadlineMs) return { kind: \"missing\", unparseableMatches: 0, budgetExhausted: true }; // and map budgetExhausted to NIGHTLY_BUDGET_EXHAUSTED, not REFRESH_EVIDENCE_MISSING",
    "potential_consequence": "one full page walk (up to 5 fetches) runs post-budget; failure misattributes to REFRESH_EVIDENCE_MISSING"
  },
  {
    "location": "src/hindsight/nightly-consolidate.ts:458-473",
    "trigger_condition": "two triggered models: one refresh failed, one completed, failed row sorts first",
    "guard_snippet": "const seen = { failed: [] as MentalModelOperation[], done: [] as MentalModelOperation[] }; /* collect across all pages */ if (seen.done.length > 0) return observed(seen.done[0]); if (seen.failed.length > 0) return terminalFailure(seen.failed[0]);",
    "potential_consequence": "page-order short-circuit reports REFRESH_FAILED although a triggered refresh succeeded (or the inverse)"
  },
  {
    "location": "scripts/memory-nightly.ts:252-256",
    "trigger_condition": "operator typo with single-dash flag (-h, -help, -dry-run)",
    "guard_snippet": "const badFlag = argv.find((a) => a.startsWith(\"-\") && a !== \"-\"); if (badFlag !== undefined) { writeSync(2, `unknown flag: ${badFlag}\\n${USAGE.split(\"\\n\")[0]}\\n`); process.exit(2); }",
    "potential_consequence": "single-dash typo silently RUNS the real nightly (real writes, real spend) — the class F-024 closed for -- flags"
  },
  {
    "location": "scripts/memory-nightly.ts:181-193",
    "trigger_condition": "listBanks faults with 502 unparseable-body (instance UP) or a client-side bug",
    "guard_snippet": "} catch (e) { return { code: 1, envelope: { ok: false, code: \"BANK_LIST_UNREACHABLE\", leg: \"crontab\", detail: e instanceof Error ? e.message : String(e), remediation: ... } }; }",
    "potential_consequence": "every fault mode collapses to \"check reachability\" — an unparseable-response or code defect reads as a network outage"
  },
  {
    "location": "scripts/memory-nightly.ts:138,176-179",
    "trigger_condition": "HINDSIGHT_BASE_URL unset — client silently defaults to 127.0.0.1:8888",
    "guard_snippet": "const required = [QDS_MEMORY_AGENT_TOKEN, ...REQUIRED_GATEWAY_VARS, \"HINDSIGHT_BASE_URL\"]; // or mirror checkHindsightBaseUrl() before client construction",
    "potential_consequence": "on a both-stacks box the tenant sidecar answers — bank resolution and the whole nightly run against the WRONG instance"
  },
  {
    "location": "src/hindsight/nightly-consolidate.ts:479; scripts/provision-hindsight-banks.ts:853",
    "trigger_condition": "deps.now returns a CONSTANT finite value (frozen clock)",
    "guard_snippet": "let last = nowMs(deps); /* per poll */ const t = nowMs(deps); if (t === last && polls > 1) throw new MemgateError(\"nightly-clock-frozen\", ...); last = t;",
    "potential_consequence": "finite guard passes; deadlines constant; both poll loops spin with real sleeps forever"
  },
  {
    "location": "tests/swarmclaw/fixtures/fake-hindsight-mcp.ts:179",
    "trigger_condition": "comment documents ConsolidateResponseSchema as the legacy counts shape",
    "guard_snippet": "// ConsolidateResponseSchema (F-025 round-1) is {operation_id (required), deduplicated?}; counts are tolerated extras folding to 0. This MCP-tool body bypasses that parse — keep the counts for MCP-consumer assertions.",
    "potential_consequence": "next fixture author copies the documented shape; HindsightClient.consolidate 502s against it at runtime"
  }
]
```

## Confirmed handled

- 51-char base whose 50-truncation equals its 52-truncation: both hyphen-strips collapse to one string; `safeRepoBaseCandidates` dedupes via `legacy === current ? [current]` (bank-provisioner.ts:201-205).
- Both a 52-form family and a 50-form family present: current (50) form probed first, "new-era families win" is documented behavior at bank-provisioner.ts:251-253 — defined, not accidental.
- Read-side collision loop over legacy candidates: pair-check only matches existing banks; `${legacy}-11-dev-meta` = 64 chars exactly, still schema-valid.
- RosterPatternClaim dual-form union: a `${current}-2` shape can string-equal the legacy base; Set dedupes, and over-claim is bounded by the documented claim ∩ diff rule.
- Provision targets order: banks[0] is the repo bank in both fresh (`targets` bank-provisioner.ts:514-520) and rerun (`canonicalRoster`) lanes — `withManagerMentalModels`' `envelope.banks[0]` derivation is sound; MM ids stay ≤ 64 (53-char worst repoBankId + "-maint-mind" = 64).
- Rerun five-bank roster vs pre-M3.1 three-name snapshot: `created = roster − existing` marks the two new meta banks as this attempt's creations (R2-011 rule); a successful rerun converges the family.
- Row stuck pending forever: the `nowMs + pollIntervalMs >= deadlineMs` check bounds the poll within the (possibly bank-scoped) deadline — budget respected.
- Cancelled during polling after an earlier pending sighting: terminal-failure returned on the later poll; pinned by the cancelled test.
- Page-2 pagination: walk bounded at MAX_EVIDENCE_PAGES=5; duplicated rows across churned pages re-match idempotently (return-on-first); limit is a fixed constant so no offset drift.
- ConsolidateResponseSchema tightening vs repo fixtures: memory-round-trip, bridge-round-trip, and swarmclaw fake-hindsight-mcp bodies are consumed via injected clients / MCP JSON-RPC paths that never route through the tightened parse — verified by running the suites (264 pass, 0 fail).
- Mock-mode consolidate body updated to the wire shape; mock consumers read folded counts (0) through `.default(0)` — verified green.
- Collective-slug refusal ordering: gate fires before HindsightClient and gateway construction — the ledger is never opened (pinned by case 19's `existsSync === false`).
- BANK_LIST_UNREACHABLE / refusals emitting stdout-only with no stderr event: matches the header contract ("events flow beside the ONE stdout envelope"; refusals emit nothing by construction).
- withManagerMentalModels folds: success adds rows additively; failure folds to the documented banks-[] idiom retaining createdInAttempt via spread; !ok and empty-banks passthrough pinned by the spy test (zero client calls).
- F-016 fake fix: read-then-record poll statuses; `pollStatuses[0] === "processing"` + `toContain("completed")` are real sequence assertions, not tautologies.
- Stepped-clock budget test: failure timing is fetch-count arithmetic on a deterministic clock, not wall-time racing.
- pollIntervalMs clamp test: clamped 50 visibly issued, nothing below the floor; EVIDENCE_BUDGET_MS retune (40→60) keeps the 50ms floor inside budget arithmetic (~57 < 60 on poll 1).
- waitForCreateOperation retry: listOperations fault swallowed + typed event emitted; fail-loud preserved via deadline for failed/cancelled/timeout.
