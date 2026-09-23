# DF3.6b — code review round 19 (a meta-review finds the class nobody had swept)

**Date:** 2026-09-20 · **Trigger:** one CodeRabbit Minor, plus a deliberate audit of WHY repeated
sweeps of one document keep missing things.

## CodeRabbit's Minor, and why the previous sweep missed it

The Infra Prerequisites table said `rssPeakBytes` feeds "the bounds-check log line" — the
pre-amendment emitter. It rides fleet's `resident_cgroup`, keyed `runId` + per-resident `seq`, and the
engine-side line does not carry the measurement pair at all. Fixed, naming the emitter and the key.

Round 18's sweep **explicitly reports checking that table** — and was not wrong to say so. It swept for
the *lead-then-buried-amendment shape*; this row is plain emitter drift with no amendment nearby.
**A sweep is only as good as the class it is aimed at**, which is the observation this round then
acted on.

An emitter-attribution sweep across the story, the sibling story, all eighteen evidence rounds, the
source comments and the tests came back **clean** — that class is now closed, and it confirmed a
boundary worth recording: the journal `resident` block carries NONE of the memory measurement fields,
only status/directives/spend/exitStatus/tripwires.

## The meta-review

Rather than sweep another class blind, a reviewer was asked to audit the sweeping itself: enumerate
the defect CLASSES a document like this can carry, mark which have been swept, and rank the unswept
ones by whether an instance would mislead someone **writing code or tests** versus merely reading. It
was told explicitly that if the document were genuinely clean it should say so and defend it — a
sweep that can only return "found something" is not a check.

It returned a taxonomy, marked five classes swept, and named one that had never been looked at.

## The unswept class: `file:line` citations that go stale when the file moves

This story inserted **~600 lines of cgroup machinery near the TOP of `src/fleet/resident.ts`.** Every
citation aimed at pre-existing code BELOW the insertion shifted by roughly that amount. Citations to
code this story ADDED stayed correct, because they were written in the same pass as the code — which
is exactly why spot-checking never caught it: **the sample you would naturally check is the clean
half.**

Eight were wrong:

| claim | cited | actually was | corrected to |
|---|---|---|---|
| `ResidentSpawn` ships … and no pid | `:116-127` | a stderr regex | `:689-708` |
| the child handle is closure-local | `:451` | the OOM peak-slack discussion | `:1095` |
| "DF3.6 decides when; this supplies how" | `:125` | mid-regex | `:698` |
| key delivery is env-borne, never argv (×2) | `:137-141` | the cgroup mount doc | `:719-722` |
| AC5's `stop()` latch | `:681-705` | **the rmdir retry ROUND 17 ITSELF INSERTED** | `:1493-1494` |
| every later `call` throws | `:474` | `readLeaf`'s signature | `:1201` |
| an OOM-killed pi is a signal death | `:606-627` | the placement membership check | `:1378-1404` |
| `ResidentTripwire["cause"]` is one closed literal | `steering.ts:199` | an unrelated doc comment | `steering.ts:244` |

The fifth row is the sharpest: **round 17's own extraction moved code into the span a citation
pointed at**, so a fix made three rounds ago silently invalidated a citation written earlier. Nothing
in the pipeline could notice.

**Why this class ranks highest for damage.** This document treats "cited to file and line" as
categorically stronger than assertion — ruling L1 is literally *"verified, not asserted … cited to
file and line."* A wrong citation is therefore worse than an absent one: it either sends a reader to
unrelated code and discredits the document, or gets trusted for a nearby-but-wrong span and copied.

Every correction was verified at **verbatim-quote level** by a second reviewer — SUPPORTS rather than
merely in-range — including the one that needed care, since there are two `lastExit = "transient"`
assignments in that file and only one is the signal-death branch.

A full re-extraction now shows **zero out-of-range citations** in the story.

### And two in a sibling story, broken by THIS branch

`df3-6a-resident-spend-iteration-bounds.md` carries live citations into both files this story shifted:
`resident.ts:410` for the `resolveRate` call (now inside `rmdirBounded`; really `:1010`) and
`steering.ts:204-219` ×2 for the journal `resident` block (now the Inbox transport docs; really
`:233-256`). DF3.6a is a separate, already-merged story — but **this branch is what invalidated them**,
so this branch corrects them, each annotated with what moved and why.

### Clean by construction, and worth knowing

The eighteen evidence files carry **no** `file:line` citations into these sources — they discuss the
mechanism by symbol name. The story carries **no** line-numbered citations into test files either. So
neither can rot this way, and that is a property to preserve rather than an accident to fix.

### The check, recorded so it is re-run rather than re-derived

Extract every `\.ts:N` citation, `sed -n` the range, confirm it matches the claim. Mechanical, finite,
and worth redoing after any large insertion. Written into the story's Split Record beside the
2026-09-08 correction whose targets this round found stale a second time.

## One correction to my own account

I described one skipped citation as referencing a file outside this repo. It does not —
`src/providers/credentials.ts` exists; my extraction script simply failed to resolve the path. The
only genuinely out-of-repo references are to Linux kernel sources (`mm/memcontrol.c`,
`mm/oom_kill.c`), cited by symbol and never by line.

## Gates

No walked input changed — both story files and this evidence file are outside `buildIdFileInputs` —
so `660ae409` stands and no re-pin is owed. `check-story-consistency` OK across 42 stories.
