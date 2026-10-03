# fx2-observe — z1-r2 fix report

Scope held: only `tests/fleet/observe-contract.ts` and the one test name in `tests/fleet/q1-contract.test.ts`.

## R2-06 — vocabulary-pin direction honesty (PATCH)

`tests/fleet/observe-contract.ts`:

- Added `expect(STATUS_VOCABULARY).toHaveLength(16)` at the vocabulary assertion site (immediately before the per-row wire loop in `assertObserveSurface`), with a comment naming what it forces: an added word shifts the count and fails the ritual, which containment alone would let rot silently.
- Top-level docblock ("STATE-VOCABULARY DEBT" paragraph) rewritten honestly: the suite pins the docblock enumeration as a COPY — the pin enforces wire→vocabulary containment (a new word on the wire fails here by name) plus the list's length; list-vs-src-docblock rot (a word renamed/retired in src/ while the copy stays) is REVIEW-enforced, because src/ is outside this suite's write scope. The passthrough debt note is retained verbatim.
- `STATUS_VOCABULARY` const docblock gained a "PIN DIRECTION (honest)" block stating the same CI-vs-review split.
- Deliberate choice: the length pin lives at the assertion site, not module top-level — a module-scope `expect` would fire at import time and would also run inside Z2's consumer harness, which imports this helper (docblock line 4-5).

## R2-07 — closure test name over-claim (PATCH)

`tests/fleet/q1-contract.test.ts:361` — renamed to exactly what is proven:

> "both observe verbs are present in the registry with result driver-free and status's --driver owned by the deployed wrapper — the fork-side fence is Z2's module allowlist, not this suite (INV-Z1-2)"

Body unchanged (assertion content untouched). INV-Z1-2 tag retained for traceability.

## Process notes

- Impact check per repo rules: `impact({target: "assertObserveSurface", direction: "upstream"})` — symbol not in the (stale) index; the helper is new on this branch, test-only, imported solely by q1-contract.test.ts (and later Z2's harness). Blast radius nil.
- Verification (targeted only, per instruction): `bun test tests/fleet/q1-contract.test.ts` → exit 0, **15 pass / 0 fail** (log: /tmp/fx2-observe-q1.log).
