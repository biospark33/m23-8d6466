# PR #184 — review round 4 triage ledger

Source: 14 reviewers over 11 diff chunks. Legend: **P** = patch, **D** = defer,
**X** = dismiss, **DN→** = decision_needed, resolved with the fail-safe option.

## Cluster A — CI / supply chain (`.github/`)

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| A1 | BLOCKER | Exception entry with missing/misspelled `expires` is a permanent silent pin-gate bypass. | edge-ci#1, blind-ci#2 | **P** |
| A2 | HIGH | Provenance identity binds `--signer-workflow` = path with **no ref**, so a bundle from any branch verifies. | blind-ci#1 | **P** |
| A3 | MED | Duplicate digests in the register → multi-line `expires` → arbitrary verdict. | blind-ci#7, edge-ci#7 | **DN→P** (assert + fail closed on the real-publish arm) |
| A4 | LOW | Fork-guard comment describes a case `github.repository_owner` cannot select on `pull_request`. | blind-ci#9 | **P** (comment) |
| A5 | MED | Push happens before the digest/buildId gate → mismatch leaves an unattested public tag. | blind-ci#6 | **D** — acknowledged in-file; changing publish ordering is out of round scope. |
| A6 | LOW | Dependabot ecosystem asserted but not visible in the hunk. | blind-ci#12 | **X** — edge-ci confirmed it exists at `.github/dependabot.yml:25-31`. |
