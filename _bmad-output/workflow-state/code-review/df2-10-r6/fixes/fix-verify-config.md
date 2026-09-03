# F3 fixes — verify-image-pin.yml + register + .dockerignore + SKILL.md + roster

Branch `fix/df2.10-review-round-6`. No commits, no pushes. Files touched: only the
five I own.

## Fixed

All 15 findings in `edge-workflow-verify-misc.md`. Line numbers are post-edit.

### P49 [HIGH] — register read from the BASE tree on a PR
`.github/workflows/verify-image-pin.yml:200-268` (overlay step, renamed
*Overlay the subject ref's pin and exception register*).

The overlay step now fetches `.github/image-pin-exceptions.json` at the head as
well as `src/providers/exedev/driver.ts`, through one shared `fetch_at_ref`
helper, and `cp`s both over the checked-out tree. The shape/type/duplicate
validation and the accept lookup therefore both run against the copy the PR
proposes. The register is fed to `jq` only, never to a shell.

### P50 [HIGH] — printed remediation unreachable in one PR
Same change; see **Decisions** for which of the two options I took.

### P51 [MED] / R6 — daily re-check covered `main` only
`verify-image-pin.yml:139-158` (new `strategy:` block), `:242` (step `if:`),
`:245` (`SOURCE_REF`).

The `verify` job now fans out over `matrix.ref`, which is `["default"]` on
pull_request_target/push and `["default","dev"]` on schedule/workflow_dispatch.
The `dev` leg does **not** check `dev` out — it runs the default branch's gate
logic and overlays `dev`'s driver.ts and register through the exact machinery
the PR leg already uses. That preserves "no `ref:` on the checkout, ever" as a
structural property rather than one an expression must evaluate to empty.
`fail-fast: false` so one branch's verdict cannot cancel the other's.

Consequence recorded in the file header (`:77-85`): the check name becomes
`verify-image-pin / verify (default)`; `verify (dev)` appears only on the
daily/dispatch legs. The matrix value is spelled `default` rather than left
empty precisely so the required-check string stays readable and stable.

### P52 [MED] — the `-e` guard the comment promised was absent
`verify-image-pin.yml:250-268` (`fetch_at_ref`).

`--jq '.content'` became
`--jq 'if (.content // "") == "" then error("contents API returned no usable .content") else .content end'`,
plus a byte floor per file (1024 for driver.ts, 2 for the register) replacing the
`[ ! -s ]` check that a 3-byte `null` decode passed. `fetch_at_ref` `exit`s
rather than `return`s: called from an `if` condition its body would run with
`set -e` suspended, which is the same class of bug as P62.

### P55 [MED] — header claimed the register carries the bootstrap entry
`verify-image-pin.yml:31-36`. Prose corrected, not just softened: the paragraph
now states the array is empty today, that an empty array is the steady state,
and explicitly retracts the old claim ("It never did; the entry was never
committed. Read the file, not this paragraph.").

### P56 [MED] — verify path proven against the pre-cosign producer
`verify-image-pin.yml:530-544`. The bare "Proven end-to-end … (run 33684476912)"
is replaced by a PROOF STATUS paragraph that says the run predates the cosign
swap, names the three bindings that must survive it (Fulcio SAN ref anchor,
`https://slsa.dev/provenance/v1` predicate type, `github-hosted` runner
extension), and names the check to run before this becomes a required check (one
`workflow_dispatch` against the current pin, run id recorded beside the old one).
Prose only — I cannot dispatch the workflow from here, and the reviewer's fix was
an action for the operator, not a code change.

### P53 [MED] — `.dockerignore` credential patterns non-recursive
`.dockerignore:8-13` and `:32-41`. Added `.sandbox` beside `.swarm` (with the
reason: its fake-box fixtures carry their own `.env` files); changed `.env`,
`.env.*`, `*.pem`, `*.key` to their `**/`-prefixed forms.

Verified first that no `COPY` depends on a newly-excluded path: `oci/Dockerfile`
COPYs `pi-vs-claude-code-vendor/` and `oci/.build/NOTICE` (the specific case
flagged — `**/*.key` etc. do not match `NOTICE`, and the existing narrow
`oci/.build/exedev` pattern still spares it); `oci/exedev/Dockerfile` COPYs only
`oci/exedev/systemd/*`. `find pi-vs-claude-code-vendor -name '.env*' -o -name
'*.pem' -o -name '*.key'` returns nothing. The three `.env` files the reviewer
named are all under `.sandbox/`.

### P54 [MED] — SKILL.md named the wrong file set
`.claude/skills/qds-live-e2e/SKILL.md:251-254`. Re-ran the grep myself:
18 of 19 files match; the one that does not is
`tests/fleet/e2e/tier1-registry-auth.live.test.ts`. The parenthetical now names
that file and only that file, and says to run the grep rather than trust a list.

### P57 [LOW] — any-length `sha256:` accepted
`verify-image-pin.yml:373-386`. The `*@sha256:*)` arm now requires
`@sha256:[0-9a-f]{64}$` before anything else, with an error that explicitly tells
the operator this is a typo and **not** to reach for the exception register.
Verified: a `@sha256:9244` pin now exits 1 immediately; the real pin still
resolves `sentinel=0`.

### P58 [LOW] — duplicate guard counted lines, not declarations
`verify-image-pin.yml:277-285` and `:310-311`. Both counts moved onto `$flat`
and onto occurrences: `printf '%s' "$flat" | grep -o 'export const X =' | wc -l`.
Note for the record: the reviewer's suggested `grep -oc` would not have worked —
GNU grep ignores `-o` when `-c` is given. The pattern now includes the ` =`, so
it matches the extraction's own pattern and a `DEFAULT_IMAGE_REFERENCE` cannot
inflate the count. Verified: two declarations on one physical line now report 3
and exit 1.

### P59 [LOW] — register unvalidated while the pin is the sentinel
`verify-image-pin.yml:398-472`. The whole shape-validation block is hoisted into
a new step, *Validate the exception register (shape, every entry, always)*, with
no `if:`. The gated step keeps only the digest lookup. A missing register logs
"absent — verification is strict" and falls through (fail-closed by omission).

While doing this I added one clause to the validation, because the P49 fix is
what made it necessary: `.reason` is the only register field echoed verbatim,
and it is now PR-controlled on the PR leg, so a `\n::error::…` inside it could
forge a workflow-command line out of the accept-path warning. Entries whose
`.reason` contains a codepoint < 32 are now rejected. Checked via `explode`
rather than a regex class because jq's control-character regex escapes are
Oniguruma-dependent.

### P61 [LOW] — a revert-to-sentinel PR passed green
`verify-image-pin.yml:329-355` (sentinel arm) with the stash at `:261-264`.
On the pull_request_target leg only, the overlay step saves the base driver
before overwriting it; the sentinel arm then fails when the base named a real
digest. Scoped to the PR leg deliberately — on the scheduled `dev` leg the
checked-out tree is `main`, and main-vs-dev is promote lag, not a revert.

Verified all three paths locally against the real driver: base real + head
sentinel → exit 1; no base stashed (push/schedule) → exit 0, `sentinel=1`; base
also sentinel (genuine bootstrap PR) → exit 0, `sentinel=1`.

### P62 [LOW] — `base-drift` guard bypassed when its input is unreadable
`verify-image-pin.yml:656-662`. Added `n=${n:-0}` with the reasoning inline.
Verified: with `oci/exedev/Dockerfile` missing, the run now prints the guard's
"a drift watcher that watches the wrong layer is worse than none" message and
exits 1, instead of falling through to `sed: can't read`.

### P63 [LOW] — vestigial single-element loop
`verify-image-pin.yml:559-585`. `for source in oci; do … done` and the
`if [ "$source" = "oci" ]` collapsed to a straight-line `args=(…
--bundle-from-oci)` plus the retry loop, with a comment saying why restoring the
`github` arm must be a deliberate edit (it needs `attestations: read` back).

### P60 [LOW] — `t4.resident.pipeline.json` margin
`config/rosters/t4.resident.pipeline.json:17` (end of the `build` phase
`description`). **No numbers changed.**

The note could not go where the reviewer asked: JSON has no comment syntax and
`PipelineManifestSchema` is `.strict()` (`src/phase-engine/manifest.ts:165`), so
a `$comment` key is rejected at load. It is therefore appended to the `build`
phase's description — which is the field whose bump breaks the budget, so it is
the text the next editor is actually reading. It records the arithmetic
(`1*3*10000 + 2*3*75000 + 2*5000 = 490000` against `runBudgetMs 500000`), that
`manifest.ts` refuses at admission rather than running slow, and the ~76666 ms
ceiling on this `maxDurationMs`.

Verified through the real loader: `loadManifest(...)` succeeds and
`requiredBudgetMs` returns 490000, margin 10000 — exactly what the note claims.

### Also updated (consequence of P49/P50, same owned file)
`.github/image-pin-exceptions.json:2` — the `$comment` now records that the gate
reads this file at the PR head, that one PR may add an entry and move the pin it
covers, and that deleting the file is not how an exception is retired.

## False positives

None. All 15 findings reproduced against the working tree before I touched
anything, including the two I was told to re-verify: the `keyLeakProblems` grep
returns 18/19 with `tier1-registry-auth.live.test.ts` as the sole miss, and the
t4 margin is exactly 10,000 ms.

One correction to a suggested *fix* (not to a finding): P58's proposed
`grep -oc` does not count occurrences — GNU grep ignores `-o` in the presence of
`-c`. I used `grep -o … | wc -l` instead.

## Decisions

**P49/P50 — I took the first option: the head copy is used for BOTH the
validation and the lookup.**

Reasons, in order of weight:

1. The fail-safe alternative (validate on head, look up on base, document the
   two-PR ritual in the error text) leaves the gate's central escape hatch
   requiring an undocumented sequence of two PRs, and a control nobody performs
   is not a control. It also keeps a second, subtler trap: the register the PR
   *validated* and the register the gate *consulted* would be different files,
   which is exactly the sort of split that produced this bug.
2. What the head copy can buy an attacker is bounded and visible. The gate
   logic, the workflow file, `permissions:`, and branch protection all still
   come from the base; the checkout still has no `ref:`; nothing from the head
   is ever executed. The most a PR can do is propose an exception entry that a
   reviewer must read, that names a reason in prose, and that expires on a date
   the daily schedule leg enforces. That is the register's entire design.
3. It makes the gate's own printed remediation true on first use, which is what
   P50 is about.

The hardening I added alongside it (control characters rejected in `.reason`,
byte floors, `jq` assertion on `.content`) exists because head-controlled bytes
now reach one `echo`; without the lookup change none of it would be needed.

**Secondary decision — P51 implemented as a matrix leg that overlays `dev` as
data, not as a second job with `ref: dev` on the checkout.** A second job meant
duplicating ~160 lines of gate shell; a `ref:` expression on the shared checkout
meant trading a structural safety property for one that has to evaluate to
empty. The overlay machinery already existed and already had the right argument
attached to it ("this branch's logic, that ref's data"). Cost, stated: the check
name gains a matrix suffix — `verify-image-pin / verify (default)` — which is
recorded in the header for whoever configures branch protection.

## Gates

```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/verify-image-pin.yml')); print('yaml ok')"
yaml ok

$ python3 -c "import json; json.load(open('.github/image-pin-exceptions.json')); json.load(open('config/rosters/t4.resident.pipeline.json')); print('json ok')"
json ok

$ actionlint .github/workflows/verify-image-pin.yml; echo "exit=$?"
exit=0
(actionlint IS installed at /usr/local/bin/actionlint — it also runs shellcheck
over every `run:` block, so the shell changes are covered.)

$ bunx biome check .github/ config/ 2>&1 | tail -5
Checked 4 files in 70ms. No fixes applied.

$ bun test tests/fleet/resident.test.ts 2>&1 | tail -15
bun test v1.4.0 (34cbb9a40)

 36 pass
 0 fail
 140 expect() calls
Ran 36 tests across 1 file. [4.64s]
```

Additional verification I ran beyond the listed gates (every `run:` block
extracted from the YAML and executed against fixtures):

```
bash -n on all 5 run: blocks                                   ALL PARSE OK

pin step, real driver.ts                    exit 0, sentinel=0, ref+buildId correct
pin step, @sha256:9244                      exit 1, "not a 64-lowercase-hex sha256"
pin step, two decls on one line             exit 1, "found 3"
pin step, sentinel + real base stashed      exit 1, "BACK to the bootstrap sentinel"
pin step, sentinel + no base stashed        exit 0, sentinel=1
pin step, sentinel + sentinel base          exit 0, sentinel=1

overlay step w/ stubbed gh, 200 + content   exit 0, both files overlaid byte-identical,
                                            driver.base.ts stashed on the PR leg only
overlay step, 200 + no .content             exit 1, jq error then the guard message
overlay step, 404                           exit 1, same guard
overlay step, 1-byte register               exit 1, byte-floor message

register jq, committed register             clean
register jq, null reason / bad expires /
  newline in reason / duplicate digest      all 4 reported, gate fails
register jq, well-formed entry              clean

base-drift, missing Dockerfile              exit 1 via the "exactly one FROM" guard
base-drift, zero matching FROM lines        exit 1, same guard

loadManifest(t4.resident.pipeline.json)     ok; runBudgetMs 500000,
                                            requiredBudgetMs 490000, margin 10000
```

No `|| true` swallows a verdict, no `continue-on-error`, `set -euo pipefail` on
every `run:` including the new validation step. The checkout still carries no
`ref:` and `persist-credentials: false`.
