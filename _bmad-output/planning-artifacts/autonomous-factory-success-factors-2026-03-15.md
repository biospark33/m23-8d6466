# Autonomous AI Factory — Success Factors Analysis
**Date:** 2026-03-15
**Context:** QDS Engineer v2 — factors required to achieve a fully autonomous AI code factory capable of producing production-ready features with little to no human intervention at PR merge time.

---

## Vision Benchmark

A factory that can be trusted to ship autonomously is measured by five rates:

| Metric | Target (mature factory) |
|--------|------------------------|
| First-attempt CI pass rate | >95% |
| Zero-comment merge rate | >80% |
| Post-merge defect rate | <1 per 50 PRs |
| Self-assessment accuracy | >90% (predicted pass = actual pass) |
| Spec disambiguation catch rate | >85% (ambiguities caught before build, not after) |

The first three are outcome metrics. The last two are what differentiate a factory that gets lucky from one that can be trusted.

---

## 1. Correctness Signals

### Spec Fidelity vs. Spec Interpretation

The largest source of wrong code isn't coding errors — it's ambiguous specs. The factory needs to detect underspecified requirements *before* starting and surface disambiguation questions upfront, not mid-build. A factory that ships confident wrong code is worse than one that pauses and asks.

**Implications for the factory:**
- Spec completeness scoring before story intake is accepted
- Disambiguation dialogue as a first-class phase (not buried in develop phase)
- Track ambiguity-caused rework separately from skill-caused rework

### Edge Case and Error Handling Completeness

Unit tests pass on the happy path. Production fails on the edges. The factory needs to systematically generate adversarial inputs for its own code — empty input, null, network timeout, partial write, concurrent access, malformed data.

### Integration Coverage, Not Just Unit Coverage

A PR where all unit tests pass but no integration test exercises the new code path is not production-ready. The factory needs to write tests at the right layer, not just the easiest layer. Unit tests as the sole coverage signal is a failure mode, not a success state.

---

## 2. Trust Calibration

### Self-Assessment Accuracy

Can the factory correctly predict which of its own PRs will pass human review? This meta-accuracy is the most important signal for autonomous operation. A factory that knows it's uncertain and escalates is far more trustworthy than one that's confidently wrong.

**Track:** predicted-pass vs. actual-pass rate per PR type, scope, domain, and complexity band. Self-assessment accuracy should be a dashboard metric from day one of MVP operation.

### Trust Trajectory by Domain

The factory should earn the right to merge autonomously in different areas incrementally:

1. High-churn utility code (lowest risk)
2. Feature code in well-tested modules
3. Stable business logic
4. Core infrastructure and auth (highest risk)

The system needs a model of its own reliability per codebase area, not a single global confidence level. Auto-merge permissions should be gated by per-domain reliability scores, not a binary on/off switch.

### Regression Risk Awareness

Not all files are equal. A change to `src/utils/format.ts` has a different blast radius than a change to `src/auth/middleware.ts`. The factory should automatically apply higher scrutiny — more BMAD waves, more QA agents, mandatory integration tests — in high-risk areas.

**Risk signal sources:**
- Git history: high change frequency + high defect rate = hot zone
- Dependency fan-out: files imported by many others = high blast radius
- Test density: files with low test coverage = higher regression risk
- Age: recently introduced code is more volatile than stable code

---

## 3. Production-Readiness Signals

### Observability Completeness

Code that works but can't be debugged in production isn't production-ready. Every new code path needs:
- **Structured logging** — what happened, with context
- **Metrics** — how often, how long, error rates
- **Error context** — what was the input state when it failed

Observability must be a first-class acceptance criterion enforced by the QA swarm, not an afterthought left to code review.

### Rollback Safety

Can the feature be disabled without a full rollback deployment? High-risk changes should use feature flags. Dependencies should degrade gracefully when unavailable. Schema changes must be backward-compatible. A PR that cannot be safely reverted in 5 minutes should not be autonomously merged without human sign-off.

### Dependency Hygiene

New dependencies introduced by the factory should be automatically scanned for:
- Known CVEs (NIST NVD, GitHub Advisory Database)
- License compliance (GPL contamination risk)
- Bundle size impact
- Maintenance status (last commit date, open critical issues, abandonment signals)

The factory should not quietly introduce an abandoned or vulnerable package.

### Security Posture

SAST, secret scanning, and OWASP top-10 pattern detection need to be enforcement layers in the QA pipeline — not post-hoc checks. A factory that produces code passing `npm test` but failing `semgrep` is not production-ready. Security gates must block, not warn.

---

## 4. Codebase Coherence

### Pattern Adherence Beyond Linting

Linting catches syntax. Coherence is semantic — does the new code look like it was written by the same team? This includes:
- Naming conventions (variable names, file names, function names)
- Abstraction level (not mixing high-level orchestration with low-level I/O)
- Error propagation patterns (throw vs. return Result vs. callback)
- Where concerns are separated (what belongs in service layer vs. controller vs. util)

The factory's learning system (Mulch + synthesized learnings) is the primary mechanism for encoding codebase-specific patterns. This is one of the most high-value targets for the learning loops.

### Scope Discipline

Only change what was asked. Every line changed outside scope is a potential regression and a trust violation. Track and minimize unintended file modifications.

**Signal:** A PR that modifies 40 files when the spec called for 3 is a red flag even if all tests pass. Scope creep by the factory is as damaging to trust as functional bugs.

### Architecture Compliance

Does the new code belong in the layer it was placed in? Does it introduce circular dependencies? Does it violate established module boundaries?

The factory needs a structural model of the codebase — not just content familiarity. Architecture violations that pass tests are among the hardest defects to find in review and the most expensive to fix later.

---

## 5. Learning Loop Completeness

### PR Review Feedback as Training Signal

If a human intervenes — adds a comment, requests a change — that event is the highest-quality training signal available. The factory must capture *why* it was wrong, not just *that* it was wrong.

**Defect taxonomy for review feedback:**
- Spec interpretation error (factory understood the requirement differently)
- Codebase pattern miss (valid code, wrong idiom for this codebase)
- Test gap (functional but undertested)
- Scope violation (changed something it shouldn't have)
- Architecture violation (right functionality, wrong layer)
- Observability gap (missing logging/metrics)
- Security issue (SAST/secret/dep vulnerability)

Categorizing review feedback closes the loop from human judgment back to factory behavior systematically.

### CI/CD Failure Attribution

When a build fails in CI after a factory PR, trace the failure back to the specific decision that caused it. This is the production equivalent of the BMAD review — real-world ground truth. CI failures should feed back into the same learning record system as BMAD findings.

### Defect Escape Rate

Track bugs found in production that originated from factory PRs. This is the lagging indicator that validates all the leading indicators. If leading indicators (CI pass rate, BMAD finding rate) are strong but defect escape rate is high, there is a systematic blind spot in the quality pipeline that leading metrics are not capturing.

### Domain Knowledge Accumulation

Beyond code patterns, the factory needs to accumulate understanding of the business domain: what entities mean, what invariants must hold, what operations are idempotent vs. destructive, which integrations are fragile. Domain knowledge is what separates a factory that produces syntactically correct code from one that produces semantically correct code.

---

## 6. Efficiency Beyond Token Count

### Cycle Time

Time from spec submission to merged PR is the developer-facing velocity metric. Token efficiency matters, but a factory that uses 20% more tokens and ships in half the time is net positive. Cycle time should be tracked per story complexity band to normalize for scope.

### Rework Rate

How often does the factory's first attempt require a fix loop? Rework is the hidden cost: it doubles token usage, doubles cycle time, and signals a spec comprehension or pattern miss. Rework rate is a leading indicator for self-assessment accuracy problems.

### Parallelization Yield

How much of a sprint's work can actually run in parallel vs. being serially blocked by dependencies? The factory's value multiplier is its parallelization capability. Stories that could theoretically run in parallel but are blocked by shared file contention, claim conflicts, or unresolved specs represent unrealized capacity.

### PR Decomposition Quality

A 500-line PR has a much lower autonomous-merge probability than three 150-line PRs covering the same scope. The factory should know how to decompose work into reviewable units even when the spec doesn't specify this — and should prefer smaller, safer PRs over large batched PRs when the work can be split.

---

## 7. Systematic Risk Management

### Change Blast Radius Scoring

Before executing a story, score the potential blast radius: how many other modules depend on the files being changed, how many active PRs are touching the same area, what the test coverage is in the affected zone. High blast-radius stories should automatically get elevated scrutiny levels — more agents, more waves, mandatory human notification before merge.

### Confidence-Gated Autonomy

The factory should operate in one of three modes per PR, determined by its confidence score:

| Mode | Condition | Action |
|------|-----------|--------|
| **Autonomous** | High confidence + low blast radius + proven domain | Auto-merge after CI green |
| **Assisted** | Medium confidence or medium blast radius | PR created, human notified, auto-merges after N hours with no objections |
| **Supervised** | Low confidence or high blast radius or novel domain | PR created, human review required before merge |

The threshold for each mode should tighten over time as the factory accumulates a track record in each domain.

### Spec Completeness as a Gate

The factory should refuse to start a story with an underspecified spec — not because it can't make assumptions, but because assumptions are where trust breaks down. A disciplined disambiguation step at intake is cheaper than a rework loop after BMAD review. Spec completeness scoring should be automated, not left to developer judgment.

---

## 8. The Compounding Advantage

The factors above have different time horizons:

| Factor | When it pays off |
|--------|-----------------|
| CI pass rate, test coverage | Immediately — sprint 1 |
| Codebase pattern adherence | 2–4 weeks (enough stories to learn patterns) |
| Self-assessment accuracy | 4–8 weeks (enough PRs to calibrate) |
| Trust trajectory by domain | 2–3 months (enough track record per area) |
| Defect escape rate validation | 3–6 months (lag from merge to production feedback) |
| Domain knowledge depth | 6–12 months (compound accumulation) |

The factory that invests in the learning infrastructure from day one compounds on every dimension simultaneously. The factory that treats quality as a static gate gets better code but not a better factory.

The goal is not a factory that produces good code. It is a factory that produces better code next week than it did this week, on every dimension, without human intervention in the improvement loop itself.
