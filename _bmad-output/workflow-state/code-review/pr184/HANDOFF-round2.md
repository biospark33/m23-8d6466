# Handoff — DF2.10 / PR #184, round 2: re-examine everything, then prove it on real substrate

You are picking up an open PR that has had one adversarial review round. Your job is to
**re-examine that round's work with fresh eyes, close as much of the remaining ledger as
genuinely can be closed, and prove the result on real infrastructure — not on fakes.**

Read this whole brief before touching anything. Verify the claims in it rather than
trusting them; the previous round's most useful findings all came from someone checking a
confident sentence against the actual source.

---

## 0. Mission, in one paragraph

`feature/df2.10` → `dev`, PR #184: a factory-owned, digest-pinned exe.dev boot image.
Round 1 (nine parallel reviewers) fixed 118 findings, deferred 9 as issues #186–#190, and
dismissed 8 as verified-false. What remains is (a) an independent re-read of that round —
including its *dismissals* and its *conservative decisions*, which are the two places a
review is most likely to have been wrong, (b) the deferred work that is not actually
blocked, and (c) **real end-to-end proof on live boxes**, because several load-bearing
claims in this PR are currently backed only by a fake.

No shortcuts, no bandaids, no mocks/stubs/fakes standing in for the thing itself.

---

## 1. The word "tier" means three different things in this repo. Get this right first.

This is the single most likely way to go wrong. Three unrelated numbering schemes overlap:

| Scheme | Where | Meaning |
|---|---|---|
| **Architecture tiers (D2/D4/D5)** | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md:299-302` | **Tier 1** = local Claude Code cockpit on the operator machine driving a *code* fleet dispatcher. **Tier 2** = resident orchestrator agent per sandbox + deterministic TS phase engine. **Tier 3** = pi teams via `team-lead-driver.ts` + vendored coms-net, *inside each sandbox*. |
| **E2E spend tiers** | `.claude/skills/qds-live-e2e/SKILL.md` | `liveGate("N")` — a **cost** gate. Tier 1 ≈ boxes only, no model spend. Tier 2+ = real OpenRouter spend, explicit approval required. |
| **Test filename prefixes** | `tests/fleet/e2e/tier*.live.test.ts` | **Unreliable.** The skill's own table flags `tier1-image-contract` and `tier5-gate-steering` as **"2 (misnamed)"** — both call `liveGate("2")` despite the prefix. |

**Consequences you must internalise:**

- `tests/fleet/e2e/tier1-image-contract.live.test.ts` — the live test this PR added — is a
  **paid** test. It calls `liveGate("2")`. Running it costs real OpenRouter spend and needs
  `QDS_E2E_TIER=2` plus an explicit go from the operator.
- Never infer cost from a filename. `grep -n '^\s*liveGate(' <file>` and read the argument.
  (Round 1 tightened that grep recipe in the skill because the unanchored version returns
  doc-comment lines too.)

### The pivot you must account for

ADR `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (**ACCEPTED**, operator
decision) restores **architecture tier 2 to inside the sandbox**, where D2/D4/§5.1 always
specified it. The shipped host-side placement — DF3.3's resident via host `Bun.spawn`, the
engine via host `scripts/pipeline-run.ts` / `pipeline-run-remote.ts` — is classified as a
**silent, unratified deviation** and is being unwound by a staged, probe-gated arc:

```
tier 1  operator machine (Claude Code cockpit + fleet dispatcher)
   │      ── ssh ──▶
tier 2  SANDBOX: resident orchestrator agent + deterministic TS phase engine   ← moving IN
   │
tier 3  SANDBOX: pi teams (team-lead-driver + coms-net)                        ← already in
```

**DF2.10 (this PR) is the substrate story** — story 1 of 5 in the v5-S3 in-box restoration
arc, and a strict predecessor of DF1.10. It ships the image tier 2 will boot on: pinned bun,
pinned pi, the systemd assets (`qds-run@.service` with `Restart=no`, the `tmpfiles.d`
steering channel), and a baked `/etc/qds-image.json` identity marker asserted in-box.
**It runs no phase.** DF1.10 relocates the engine and the resident and adds its own build
stage to this Dockerfile, re-pinning as it goes.

So: everything you do here should be judged by *"does this make the box tier 2 is about to
move into a reviewed, provable artifact?"* — not by whether the host-side path still works.

---

## 2. Current state — verify, don't trust

```
branch   feature/df2.10  →  base  dev        (repo convention: ALL feature/fix PRs → dev;
PR       #184, OPEN, MERGEABLE, no review decision yet          dev → main is a periodic promote)
commits  0f94df5  docs: track round-1 deferred work as issues #186-#190
         ddada43  fix: review round 1 — 118 findings across 9 reviewers
         41cb8dd  fix: make the publish pin gate actually run, and converge
         (+4 earlier DF2.10 commits)
story    _bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md
         sprint-status: DF2.10 = in-review   (in this repo `done` means merged)
         DF1.10 = ready-for-dev — it is the next story and it performs the re-pin
```

Round-1 gates, as measured: `tsc` 0 · `biome` 0 (307 files) · `actionlint` 0 · `shellcheck` 0 ·
`bun test` **4861 pass / 8 skip / 25 todo / 7 fail**, all 7 being load-driven `git`/`gitnexus`
subprocess timeouts at bun's 5 s default in files this PR does not touch — **133/133 green on
isolated re-run**. Re-verify this yourself; do not inherit it.

Full round-1 artifacts are at `/tmp/pr184-review/` (may be gone — it is `/tmp`):
`triage.md`, `reports/{blind,edge,auditor,fix,test}-*.md`. The durable copy is the story's
`## Review Findings — round 1` section and issues #186–#190.

---

## 3. What to re-examine (the point of this round)

Re-reviewing the same diff the same way will find the same things. Aim at the places round 1
was most likely to be wrong:

### 3a. The 8 dismissals — did round 1 wave anything away?
Listed in the story under "Dismissed — verified false against real source". Each has a stated
refutation. **Check the refutations, not the findings.** One dismissal defended by a wrong
premise is worse than an unfixed bug, because it is now written down as settled.

### 3b. The 6 conservative decisions — were they the right call?
Story § "Decision-needed — resolved conservatively". Round 1 chose the fail-safe branch in
each and recorded a one-line reversal path. Specifically challenge:
- Keeping `--image` an **unconditional** spread when AC3 says "conditional" — is
  always-pinned actually right, or does it remove a needed escape hatch when a published
  digest is unpullable?
- Gate B deliberately **not** comparing `marker.imageRef` (a D7 tenant mirror keeps the
  digest and buildId but not the ref). Now pinned by a test. Still right?
- Keeping `scripts/build-exedev-image.ts` in the workflow's `SOURCE_PATHS` even though
  `.dockerignore` excludes it from the build context, so a comment-only edit re-pins.

### 3c. The new code round 1 *added* — nobody has adversarially reviewed it
This is the biggest blind spot. Round 1's fixers wrote ~3 900 lines that no reviewer has
seen, including:
- `assertRegistryAuthDeviation` in `driver.ts` — a **new security gate** (AC4's ratified
  deviation), with six refusal arms including an expiry-in-the-past check that the fixer
  itself flagged as a judgement call beyond the AC's literal words.
- The B0 try/catch and the `MarkerFailure {code,message,remediation}` payload in
  `setup-gate.ts` / `transport.ts`.
- The leak registry + signal handlers, `resolveRuntimeBaseRef`, `metadataDigests`,
  `tarUnescape`, the `path+sha256` executable diff in `build-exedev-image.ts`.
- ~290 lines of workflow changes, including a **carried** sentinel refusal that deviated
  from its brief (documented in the round-1 report, and correctly so — an early exit would
  deadlock the bootstrap ritual; verify that reasoning holds).

### 3d. Cross-agent seams
Round 1 partitioned work across disjoint file clusters. Seams are where partitioned work
fails. One conflict was caught and fixed by hand (`driver.ts`'s comment claimed the workflow
"refuses to publish" against a sentinel pin; the workflow actually publishes and then refuses
to go **green** — the bootstrap ritual requires that push). **Assume there are others.**

---

## 4. Open work, prioritised

### Unblocked right now — no re-pin, no spend
- **#189 — `live-harness.ts` teardown.** `revokeQuietly` reads the run record *outside* its
  own try (`live-harness.ts:484`), so a missing or half-written record throws out of the
  caller's `finally` and the box destroy never runs. Three live tests each carry a duplicate
  guard; one `try` moved two lines deletes all three. `destroyQuietly` can only record, so a
  **leaked box reports green**. And `preflight` builds `new ExeDevDriver()` while production
  registers `exeDevDriverFromEnv()` (`src/providers/index.ts:138`) — so **no live test
  exercises the factory production actually uses.** That last one directly undercuts the
  "real e2e" goal and should be fixed before the live round, not after.
- **`boot_ready_ms`** — named in DF2.10's Observability Contract, exists nowhere in the repo.
  Round 1 deferred it for a bad reason: the `driver.ts` fixer correctly refused to invent the
  measurement there (`create()` returns when the VM is *named*, before it is bootable), but
  the honest measurement point is gate A in `setup-gate.ts` and the item was never routed to
  that file's owner. Not filed as an issue — it is a process gap. Either emit it where boot
  readiness is genuinely established, or delete the field from the contract. Do not emit a
  constant `0`.
- **#190** — three policy decisions needing an owner (attestation has no consumer; major-tag
  vs SHA action pins; `workflow_dispatch` with no `environment:` approval). Decisions, not
  code. Surface them; do not decide unilaterally.

### Blocked on a re-pin — belongs to DF1.10, tracked, cross-referenced
**#186** (bundle), **#187** (the build tag is a digest input), **#188** (AC5 attribution by
basename). All blocked on one fact: `deriveBuildId` hashes the Dockerfile bytes and both
systemd unit bytes, so **any** edit moves the buildId → moves the digest → invalidates the
pin that was live-booted. Already cross-referenced from DF1.10's Technical Notes and its
Definition of Done. **Do not open these unless you are doing a full re-pin** (edit → build →
push to ghcr → record digest+buildId → live e2e to re-prove the boot).

#187 is worth reading even if you do not action it — it was reproduced on demand: the same
tree built under `:local` yields `sha256:bfe8001c…` against the pinned `:df2-10` build's
`sha256:a70674b2…`, with an **identical** buildId `664876fb1a9128ec`. Three digests, one
buildId, and gate B compares only the buildId.

---

## 5. Real E2E — the hard constraint

**No mocks, no stubs, no fakes standing in for the thing under test.** Use the
`qds-live-e2e` skill (`.claude/skills/qds-live-e2e/`) for every live round; it encodes the
gotchas from six prior rounds and it is not optional.

### Why this matters more than usual here

The unit suite leans on `tests/providers/exedev/fixtures/fake-exedev.ts`, and round 1 found
the fake diverging from reality in several places (it fell through to the **host's** `/etc`
for any verb but `test -f`/`cat`; it hand-copied version literals; two of five
`imageMarkerFailure` arms were unreachable through it). Those are fixed — but the deeper
point stands, and one reviewer stated it precisely:

> The fake's `new` grammar encodes the same assumption the driver does — that the flags are
> `--image` and `--registry-auth`, in that position. If exe.dev's actual flag were
> `--from-image`, the fake accepts, every unit assertion passes, and only the live test
> notices. `driver.ts` already flags the `new` **response** shape as UNVERIFIED for the same
> reason.

### What IS already proven live (do not re-litigate)
DF2.10's recorded live round booted a real box from the pinned digest: PID 1 = systemd, ssh
as `exedev`, every setup gate passed, `bun --version` = 1.3.13, `pi --version` = 0.84.4,
marker `buildId` matched, `/run/steering` survived a real `sudo reboot` from the baked
`tmpfiles.d` entry alone, no box leaked, per-run key revoked in the `finally`. Cold pull
≈ 60 s `createMs`; the flattering ≈ 5 s figure is exe.dev's warm image cache and the record
says so.

### What is NOT proven live — this is your target list
1. **`--registry-auth` / the private-registry path has never run against real exe.dev.**
   Verified: `registry-auth` appears **0 times** in the live evidence JSON. The public path
   was used throughout. Round 1 then added a **new gate in front of it**
   (`assertRegistryAuthDeviation`) whose only coverage is unit tests against a fixture. So
   the entire AC4 arm — credential load from a 0600 file, the ratification check, redaction
   in a real failure, the flag actually reaching a real `exe.dev new` — is unproven on the
   substrate.
2. **The publish workflow has never executed.** Not once. The pinned image was built and
   pushed by hand. The ~190-line `attest` job (the only job holding `id-token: write`) has
   never run. Its verification is `actionlint` + `zizmor` + two `run:` blocks extracted and
   exercised offline against stubbed `docker`/`gh` — which is exactly the kind of proof this
   round is meant to replace. **Note #187 first: the workflow's first dispatch will fail its
   digest gate by construction**, because it builds under a different tag than the pin was
   built under. Read #187 before interpreting that failure as a defect.
3. **The B0 transport-fault arm** (`image-marker-unreachable`, ssh exit 255/137) is covered
   only through a fake knob added in round 1. A real slow/dying box is the honest test.
4. **The live e2e never runs in CI** — `liveTodoOff()` is `process.env.QDS_E2E_LIVE !== "1"`
   and CI runs a bare `bun test`. Combined with the publish workflow having no
   `pull_request` trigger, a PR editing `oci/exedev/Dockerfile` is green on every automated
   gate. Decide whether that stays true.

### Live-round discipline (from the skill, and from round 1's own findings)
- A half-configured env makes `liveGate()` **throw** — a hollow live-fire is a bug, not a
  pass. `liveGate()` checks six env vars and never opens the roster; a bogus roster path
  sails through it and dies later, at setup, **after a box may already exist**.
- Free tier first, then paid tiers sequentially, with an explicit spend go before each paid
  one. Evidence JSON per leg.
- **Fix #189 before the live round.** A teardown that can throw before the destroy is how a
  paid round leaks a box.
- Budget the file timeout against the sum of the legs' own declared budgets, not against a
  hopeful number. A bun test-timeout abort is the one path that skips the `finally` — i.e.
  the leaked-box path.

---

## 6. Known traps (each one cost time in a previous round)

1. **Chunk the diff before spawning reviewers.** A 5 492-line full diff killed 3/3 agents'
   context. Chunks of ≤ ~2 100 lines all survived. Split by file cluster with
   `git -C <repo-root> diff origin/dev...HEAD -- <path-glob>` — plain `cd` + a relative
   pathspec produced empty diffs. Verify chunk inventory (file count, line total) **before**
   spawning; a missing chunk is one command to regenerate and four wasted agents to discover.
2. **Reviewer line numbers are diff-relative unless the reviewer had repo access.** Re-locate
   every finding in the real file before acting.
3. **Never run a bare `bun test`.** Tee to a log, then de-CR and strip ANSI before grepping —
   a plain `grep '(fail)'` on the raw log silently matches nothing and reads as "no failures":
   ```
   bun test > /tmp/qds-test.log 2>&1; echo "exit=$?"
   tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
   ```
4. **The GitNexus index goes stale silently.** It predated this PR during round 1, so
   `impact` was answering "no callers" for files it had never seen — the worst possible
   failure mode for a rule that requires it. Reindex with
   `bash scripts/install-gitnexus-plus.sh` (never a bare `gitnexus analyze`) and check
   `.gitnexus/cli-version.json`'s `indexedHead` against `git rev-parse HEAD`.
5. **Known-flaky under load, at bun's 5 s default:** `tests/pr/open-pr.test.ts` (git spawns)
   and `tests/gitnexus/*` (CLI spawns). Confirm by isolated re-run before blaming your diff.
   Round 1 fixed five *other* flakes in `setup-gate.test.ts` — and the obvious fix there
   (widen the per-call tax proportionally) **does not work**, because the condition is
   `0 < budget − real elapsed < 1000`, so tax and budget cancel. Read that fix before
   touching those tests.
6. **Version-does-not-exist claims are a repeat offender.** DF2.9's record documents
   `actions/checkout@v7` being downgraded to `@v4` on a false premise, then re-raised twice
   more. **Check the release list** (`gh api repos/actions/checkout/releases`) before acting
   on any such claim.
7. Do not commit `_bmad-output/evidence/df1-4/*` — those modifications predate all of this.

---

## 7. Working agreements

- **Branch/PR:** stay on `feature/df2.10`, target `dev`. Commit in logical units. Push to the
  same PR. Update the story's `## Review Findings` section and keep issues #186–#190 accurate
  — close or update them as work lands.
- **GitNexus:** `impact` before editing a symbol; `detect_changes` before committing; warn on
  HIGH/CRITICAL. `setupGate` and `ExeDevDriver.create` are both HIGH-fanout — keep edits
  additive and do not change signatures.
- **Gates before every push:** `bunx tsc --noEmit`, `bunx @biomejs/biome check src scripts
  tests oci`, `actionlint` on the workflow, `shellcheck` on the shell, full `bun test` with
  every failure attributed (isolated re-run, or reverted-hunk comparison — never argued from
  a stack trace alone).
- **Spend:** any paid live tier needs an explicit go from the operator first, with the
  expected cost stated.
- **Report honestly.** If something is unproven, say unproven. Round 1's most valuable output
  was a reviewer writing "the attestation steps have never executed" in plain language, and a
  fixer refusing to invent a `boot_ready_ms` measurement to satisfy a grep. Hold that bar: a
  green test that proves nothing is worse than a red one.

---

## 8. Definition of done for this round

- [ ] Round 1's dismissals and conservative decisions independently re-examined; any that do
      not survive scrutiny reopened with evidence
- [ ] Round 1's ~3 900 new lines adversarially reviewed — especially `assertRegistryAuthDeviation`,
      the B0 payload path, and the workflow's carried sentinel refusal
- [ ] #189 fixed (teardown cannot skip the destroy; a failed destroy cannot report green;
      `preflight` builds the driver production registers)
- [ ] `boot_ready_ms` either emitted where boot readiness is genuinely established, or removed
      from the Observability Contract
- [ ] #190's three policy questions put to the operator with a recommendation each
- [ ] A **real** live round on real boxes, per the skill, covering at minimum the AC4
      private-registry path that has never been exercised — evidence JSON per leg, no box
      leaked, key revoked
- [ ] The publish workflow **actually dispatched** at least once, with #187 read first so its
      by-construction gate failure is interpreted correctly and not "fixed" into a bandaid
- [ ] Full suite green with every failure attributed; `detect_changes` blast radius inside the
      PR's own modules
- [ ] Story updated, issues accurate, PR comment posted, CodeRabbit re-review requested

LFG.
