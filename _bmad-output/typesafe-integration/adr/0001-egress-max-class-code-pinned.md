# ADR 0001 — Egress max-class is code-pinned per stage (config knob deferred to stage-2 ZDR work)

**Status:** ACCEPTED (steve, 2026-09-22 — selected "hardcode + ADR" over config knob in structured sign-off)
**Date:** 2026-09-22
**Supersedes:** none
**Related:** handoff.md §3.7 (LOCKED), §3.8; tracker `2026-09-22-jev-pre-dev-adversarial-review.md` finding JEV2-M5

## Context

Handoff §3.7 (LOCKED) states: "Every seam declares what it ships; config selects max class." The JEV-2 story as written hardcodes the stage-1 maximum egress class (`finding-text` + `ac-prose`; `diff-hunk` refused with the ZDR-gate error). The deviation: no config field selects the max class, so the stage-2 unlock would be a code edit rather than configuration.

## Decision

Keep the stage-1 maximum **code-pinned**. Do not ship a `maxEgressClass` constructor/config field in Wave 2. Record the stage-2 unlock as a deliberate code change, paired with the executed-ZDR precondition it must satisfy.

Rationale:

1. **Zero attack surface now.** A config knob nobody turns until stage 2 is dead surface: one more input to validate, one more way for a future caller to widen egress accidentally. The stricter direction (hardcode) is the one §3.8's redaction posture already takes.
2. **The unlock is not merely configuration.** Stage 2 (`diff-hunk`) is hard-gated on an executed ZDR addendum with defined retention + deletion clauses (§3.7, verified 2026-09-22: published DPA has none). That gate is procedural, not boolean — flipping a config flag cannot carry the obligation the unlock carries. A code change forces the diff through review, where the ZDR precondition is visible.
3. **Deviation is honest.** The story references this ADR (PROPOSED) rather than silently diverging from §3.7.

## Consequences

- Stage-2 work includes: code change raising the pinned max + the config knob, in the same change set, with the ZDR addendum referenced.
- §3.7's "config selects max class" becomes true at stage 2, not stage 1. The LOCKED decision's intent (host code owns the ceiling; every seam declares what it ships) is preserved throughout.
- `scripts/judgment/live-probe.ts` and the contract suite are unaffected (they ship `machine-state` only).
