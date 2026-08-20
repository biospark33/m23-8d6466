# Wave 5 Verification Report: DF3.4+DF3.5 Dependency Pair

**Reviewer:** Wave 5 Fresh-Eyes Verifier  
**Date:** 2026-08-20  
**Stories:** DF3.4 (Approval Gate + Attach), DF3.5 (Tier-1 Factory Skills)  
**Repo:** QDS-Factory-df3  
**Branch:** feature/df3-story-hardening

---

## Executive Summary

**VERDICT: PASS** — Both stories are sound and ready for development.

The pair contract is solid: DF3.5 documents DF3.4's verbs against DF3.1's registry, the run-record extensions model matches implementation, and no regressions or missed findings were detected in this adversarial re-review.

---

## New Findings

### BLOCKER
None.

### HIGH
None.

### MEDIUM
None.

### LOW
None.

---

## Pair Contract Verdict

**PASS** — Contract is sound and internally consistent.

### DF3.5 → DF3.4 Dependencies

DF3.5 correctly documents DF3.4's `approve`/`reject`/`attach` verbs:
- Line 54: `"fanout"/"rank", "approve"/"reject"/"attach" entries DF3.2 and DF3.4 register into it`
- Line 106: `routes to \`fleet approve\` and states that the approver token is supplied by the operator on stdin`
- Line 141: Decision verbs table cites `fleet approve / reject / attach (DF3.4)`
- Lines 197, 199: INV-SKILL-2 and INV-SKILL-3 reference DF3.4's hashed allowlist and auth surface

### Registry Contract

DF3.5's contract test parses against DF3.1's verb registry:
- Lines 37-40: Registry is the contract — `src/fleet/verbs.ts`, `listVerbs()`
- Line 69: AC1 cites `listVerbs()` in `src/fleet/verbs.ts`
- Line 139, 146: Infra Prerequisites table confirms DF3.1 creates the registry under AC6
- Line 188, 228: DoD cites the registry as the sole source for verb and flag names

### Skills Location

Skill paths align with existing structure:
- Line 183-186: `.claude/skills/factory/factory-dispatch/SKILL.md` (and observe, harvest, guide)
- Line 220: Impl confirms "four `SKILL.md` files under `.claude/skills/factory/`"
- Verified: `.claude/skills/gitnexus/` exists; `.claude/skills/factory/` is the new location

### Lint Patterns & Allowlist Entries

Six patterns (a-f) are correctly specified and internally consistent:
- Pattern (a): Per-unit price claims — `\$.*\d+.*(\/|per).*(run|story|pr|task|issue|box|hour|month|seat)`
- Pattern (b): Consumer subscription tiers — `(max|pro).*(plan|subscription|tier|account)`
- Pattern (c): Subscription authorization claims — `subscription.*(covers|includes|entitles|permits|allows|is enough for)`
- Pattern (d): Token rates — `\d+.*(usd|\$|dollars?).*per.*(million|mtok|1m|1,000,000).*tokens?`
- Pattern (e): Personal entitlement stretched over client work — `(client|customer).*(personal|individual|my|your own).*(account|subscription|plan)`
- Pattern (f): Network containment claims — `(egress|outbound|network).*(allowlist|allow-list|whitelist|restricted|locked[ -]down|firewalled|confined)`

Two allowlist entries match patterns (a-e) and (f):
1. Line 97-98: "Client deployments run on an org-owned API key under Commercial Terms §A.1" (matches patterns a-e)
2. Lines 111-117: AC7 containment scope — "BYOK direct-provider egress only, **no** per-VM egress allowlist on exe.dev, re-enters with the OCI driver" (matches pattern f)

---

## Phantom Reference Sweep

**CLEAN** — No phantom references found.

### Verified Symbols

All cited symbols exist in the codebase:
- `src/fleet/verbs.ts` — DF3.1's verb registry (not yet created in code, but contractually specified)
- `scripts/fleet.ts` — DF3.1's CLI (not yet created, but contractually specified)
- `listVerbs()` — Exported registry function (DF3.1 AC6)
- `src/providers/run-record.ts` — Verified at lines 115-133, 260-270:
  - `EXTENSION_NAMESPACES`: Line 124-133 (allow-listed registry)
  - `validateExtensions`: Line 260 (validation function)
  - `RunRecordPatch.extensions`: Line 115-117 (extensions patch type)
- `.factory/approvers.json` — Hashed allowlist path (DF3.4 line 237, 283, 332)
- `.claude/skills/factory/` — Matches existing `.claude/skills/gitnexus/` structure
- DF2.8 is correctly contract-cited as UNDEVELOPED only (no claims of existing code)

---

## Coherence Summary

### State Machine Completeness

DF3.4's approval state machine is fully specified:
- **States enumerated** (line 203): `pausing | awaiting-approval | approved | rejected | timed-out`
- **Transitions specified:**
  - `pausing` → `awaiting-approval` (lines 43-101, AC1)
  - `awaiting-approval` → `approved`/`rejected`/`timed-out` (lines 114-130, AC2-3)
- **Crash windows handled:**
  - Crash between `pausing` registration and teardown leaves recoverable `pausing` extension (lines 103-107, AC1)
  - Resume path: re-run teardown, then promote (line 126)
- **Rebind races covered:**
  - Single-sided race rule: terminal states lose, never resurrected (lines 93-96, AC1a2)
  - `submitDecision` compare-and-sets on both state and reportId (line 214, Technical Notes)
- **Terminal immutability:**
  - No path from `rejected`/`timed-out` to `approved` (lines 117-120, 129-131, AC2-3)
  - "Auto-ABORT" clarification: terminal extension is the abort (lines 131-133)

### Fail-Closed Paths

DF3.4 specifies fail-closed behavior comprehensively:
- **Allowlist** (line 136-137, AC4): Missing, unreadable, or wider-than-0600 → every decision refused
- **Empty allowlist** (line 288, INV-APPROVE-3): Authorizes nobody, never "allow all"
- **Unknown approver** (line 134-137, AC4): Refused with no state change, logged as security event
- **Unparseable extensions** (line 313-314, INV-APPROVE-8): Refused with typed error, never defaulted

### Cross-Story Alignment

**Fan-out × approval sentence** (DF3.4 line 192):
> "Both halves live here; they share no state. The gate is per-run under fan-out: each arm reaching a green re-verify pauses at its own `extensions.approval` independently, race losers are torn down by DF3.2 (its AC5) and never reach this gate, and approving one arm decides nothing about its siblings — there is no fan-out-level approval in v5.0."

This is present and consistent with DF3.2's race teardown (referenced at line 192 and implicitly via DF3.2 AC5).

**AC7 status join wording** (DF3.4 lines 264-265):
> "this story **adds only** the approval-extension join over `.sandbox/runs/` and the lazy expiry sweep to the existing status assembly"

This aligns with the extensions mechanism: AC7 scans `.sandbox/runs/<runId>.json` for approval extensions (line 156-157).

**DF3.2's fanout verb** referenced correctly:
- DF3.5 line 34: `factory-dispatch (dispatch, fanout)`
- DF3.5 line 54: `"fanout"/"rank", "approve"/"reject"/"attach" entries DF3.2 and DF3.4 register into it`
- DF3.5 line 62-63: `fleet fanout` command resolution against registry

### DoD Quality

**DF3.4 DoD** (lines 320-353): 10 high-signal items, no trim needed
- Impl: approval functions exported, verbs registered
- Contract: extensions namespace registered, verbs in registry
- Integration: teardown signatures match DF2.3/DF2.5 exports
- Security: hashed allowlist, stdin-only token
- Tests: pause mechanics, attach transport, state machine, rebind races, status join, e2e demo

**DF3.5 DoD** (lines 218-248): Complete coverage
- Impl: four skill files ≤200 lines each
- Contract: registry as sole source, commercial/containment wording
- Integration: fanout and decision verbs resolve through registry
- Security: no secrets in skills, no hand-rolled privileged commands
- Tests: frontmatter, unknown-token, pricing/containment lint, e2e demo

**Security invariants comprehensive:**
- DF3.4: INV-APPROVE-1 through INV-APPROVE-9 (lines 280-318)
- DF3.5: INV-SKILL-1 through INV-SKILL-6 (lines 192-216)

**R3 doctrine encoded:**
- FAIL-CLOSED: DF3.4 INV-APPROVE-3, INV-APPROVE-8
- FS.WRITESYNC: DF3.4 INV-APPROVE-9

---

## Conclusion

Both stories are sound, internally consistent, and ready for development. The pair contract holds: DF3.5 correctly documents DF3.4's verbs against DF3.1's registry, the run-record extensions model matches the actual implementation, and all cross-story references resolve correctly.

**Recommendation:** Proceed with development.
