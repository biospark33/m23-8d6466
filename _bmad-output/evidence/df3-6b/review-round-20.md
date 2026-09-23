# DF3.6b — code review round 20 (universal claims a scope falsifies)

**Date:** 2026-09-20 · **Trigger:** one CodeRabbit Minor on the Overview, which turned out to name a
defect sub-class and led to three findings underneath it.

## CodeRabbit's Minor, and why round 12 missed it

The Overview opened: *"Every pi solicitation runs inside its own cgroup v2 leaf…"* — false for the
host-side `pipeline-run --manifest` shape, which withholds `residentRssBytes` and runs with no cgroup
machinery at all. This is the **fifth** ruling-3b propagation site.

Round 12 swept ruling 3b and found four. It missed this one for a specific, generalisable reason:
**that sweep found sites which MENTION `residentRssBytes`.** This sentence never mentions it. It makes
a universal claim that the scoped invariant falsifies.

> Sweeping by subject finds sites that DISCUSS the subject, not sites the subject INVALIDATES.

Same lesson as round 19's class-vs-instance, one level up. So this round swept the sub-class:
enumerate every SCOPE in the story, then test every absolute ("every", "always", "never", "in
production", "cannot") against all of them.

Eight scopes were enumerated: in-box vs host-side; bound present vs absent; enforceable vs
unenforceable box; kernel ≥ 5.19 vs below; fs-level fake vs real kernel; single-process `--no-tools`
pi vs a future multi-process tree; own-limit OOM vs ruling 9's ambiguous residual; unreclaimable vs
reclaimable growth.

## Finding 1 — the Overview asserted enforcement that has never been observed

> *"The kernel enforces it: crossing the bound OOM-kills that cgroup and nothing else."*

Narrated as established fact, in the paragraph a reader meets first. It is falsified by the
**fake-vs-real-kernel** scope, which this story's own NOT-DONE section states plainly: every mechanism
claim has only ever run against an fs-level fake, and *"the load-bearing kernel behaviour the whole
story exists to invoke has never been observed once."*

The word that would falsify it — "fake", "unconfirmed" — appears nowhere near the sentence, which is
why a subject-driven sweep could never have found it.

Qualified in place: **that paragraph is how this is BUILT, not evidence that it works.**

## Finding 2 — my own fix created the opposite error

Qualifying the opening sentence to "Every **in-box** pi solicitation…" left the paragraph's closing
sentence — *"If the cgroup cannot be created … the resident is not started"* — unscoped and now
actively misleading. A reader who has just absorbed "host-side runs with no cgroup machinery" reads
the next sentence as *"…and therefore the resident refuses to start"*, which is **backwards**:
host-side residents start normally and run unbounded.

Caught by a reviewer asked specifically whether I had over-corrected, and verified in code: the whole
arming block is gated on `boundBytes !== undefined`, so `CgroupUnenforceableError` is unreachable
host-side. The same reviewer confirmed literally that NO leaf is created host-side (not "a leaf
without a bound"), and that exactly one production call site supplies the bound.

## Finding 3 — four DoD checkboxes that do not declare their own environment

DoD items 689/690/691 self-declare as host-side. The four covering AC2/AC3/AC4/AC5 do not — a
test-writer building strictly from the checklist has to cross-reference Files-to-Modify to learn they
are fake-based, and could reasonably budget a live in-box leg the E2E Slice does not fund. Worse,
those four are exactly the ones whose wording *sounds* like enforcement: "cannot trip", "not started",
"exits 97". All four now labelled.

## Finding 4 — the baseline item could write a production constant off a measurement never taken

**The sharpest of the round.** The `PROVISIONAL_RESIDENT_RSS_BYTES` baseline item reads `memory.peak`
from a control solicitation on the live box and re-sets a production default from it. Its falsifiers
are "baseline ≥ 32 MiB" and "baseline ≥ 256 MiB".

`memory.peak` landed in kernel 5.19. Below it the file does not exist and `readLeaf` reads **0**.
**A baseline of 0 passes both falsifiers** — it is neither ≥ 32 MiB nor ≥ 256 MiB — so a round on an
older kernel would silently conclude "the baseline is small", re-set the production constant off a
measurement that was never taken, and report success.

The live-leg item above it already carries the `uname -r` prerequisite for the crossing verdict. It was
never extended to the item that actually writes a production constant. Now required there, with the
rule stated: **treat a 0 reading as MEASUREMENT FAILED, never as a baseline.**

## Finding 5 — an orphaned caveat, the shape that already cost a round

The `memory.max` byte-for-byte readback is fake-only (a real kernel `PAGE_ALIGN`s upward). That caveat
was written into NOT-DONE in round 17 — and **nowhere near the DoD checkbox that generates the test**.
Anyone building from the checkbox alone had no signal. Surfaced at the checkbox.

This is the orphaned-caveat shape: a correct fact recorded once, in a place the person who needs it
will not read. Round 12 found the same shape in rulings that named no members.

## The audit's other half

13 of 17 DoD items came back CLEAN, item by item, and the AC bodies' `Given/When/Then` clauses were
correctly ruled exempt — that is this document's spec-of-intent convention, not a factual assertion.
The live-leg item (AC1) was named the model the others lacked: it already conditions the peak conjunct
on kernel version and says the kernel version is unestablished.

No second PAGE_ALIGN-class instance exists: the AC1 verdict already uses `>=` rather than `==`.

## Gates

No walked input changed — the story is outside `buildIdFileInputs` — so `660ae409` stands and no
re-pin is owed. `check-story-consistency` OK across 42 stories.
