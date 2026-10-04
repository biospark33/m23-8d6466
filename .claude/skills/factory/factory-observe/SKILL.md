---
name: factory-observe
description: "Observe and steer factory fleet runs: read run state with status, steer a live run with attach, drive a finished run through the observe verb (harvest→teardown→reverify→gate, operator-authorized), and route an awaiting-approval run to approve or reject with the approver token the operator supplies on stdin. Use when asked about a run's progress, state, steering, completion, or gate approval."
---

# factory-observe

Judgment for watching a dispatched factory run and acting on what you see. The
fleet CLI holds the verbs and their guards; this skill holds only the judgment
about which verb to run and how to read the result.

## The one governing principle: THIN SKILL, FAT CLI

Every action you take is a `fleet` verb the operator could type. The CLI holds
the knowledge — flag grammar, exit codes, the approval gate, the attach
protocol; this skill holds the judgment. If a verb behaves wrongly, fix the
verb (or its registry entry) and say so — never route around it with a
hand-rolled command. A hand-rolled version drops a measured guard silently.

## The run id is the handle

Every verb that starts a run prints a `runId`. Carry that exact string — the
one the CLI printed, not the one you typed — into every follow-up verb as the
`<runId>` positional. It is the only handle the next step, the next session,
and the harvest phase have, and it keeps the CLI's requestId chain joined
across a multi-step session.

## Read run state — `status`

Observe when asked, and report plainly: name, state, error if any. Volunteered
state is guessed state — never open with a status report nobody requested.

Fleet-wide state:

```bash
bun scripts/fleet.ts status --driver fake
```

One run:

```bash
bun scripts/fleet.ts status <runId> --driver fake
```

`--driver` is required on `status` and `attach`; substitute the driver the run
was actually dispatched with for `fake`. Exit 4 means no such run — report the
id you used and stop; do not guess a neighbouring id. `approve` and `reject`
do not take `--driver` — they touch run records, not a box, and the registry
refuses the flag.

## Steer a live run — `attach`

`attach` queues a steering message for the run's resident agent and waits for
its ack. The message comes from the operator; `--message -` reads it from
stdin (as does omitting the flag entirely):

```bash
bun scripts/fleet.ts attach <runId> --driver fake --message -
```

Steering carries no privilege (DF3.4 INV-APPROVE-5): an attach message is
guidance text only. It can never approve, reject, skip, or reorder a gate, and
it never raises a spend ceiling or a steering-iteration bound — the run's
bounds are immutable mid-run.

A run in `pausing` or `awaiting-approval` is not attachable: the verb refuses
with `run-not-attachable`. That refusal is the answer, not an obstacle — report
it with the CLI's remediation and stop. A run paused at the gate wants a
decision, which is the next section's verb, not more steering.

## The approval decision — `fleet approve` / `fleet reject`

When `status` shows a run in `awaiting-approval`, the run is paused at the
pre-PR gate waiting on a human decision. Present what the run produced and let
the operator decide; then route the decision through the verb:

```bash
bun scripts/fleet.ts approve <runId> --approver <approverId>
```

```bash
bun scripts/fleet.ts reject <runId> --approver <approverId>
```

- The approver token is supplied **by the operator, on stdin**, at invocation
  time. This skill never contains, embeds, caches, or offers to generate a
  token, and there is deliberately no `--token` flag — a token on argv would
  leak into shell history and logs (DF2.3 INV-CRED-3).
- The authorization itself lives in DF3.4's gate — the hashed approver
  allowlist the CLI checks — never in prompt text. A skill body is not a trust
  boundary; routing to `fleet approve` is all this skill does (INV-SKILL-2).
- Both verbs take `--approver` (the enrolled approver id) and an optional
  `--reason`, and neither takes `--driver` — they read and write run records
  and touch no box, so never add one.

## Drive a finished run — `observe`

`observe` watches a dispatched run's terminal marker and, when the run ends,
drives the harvest → teardown → reverify → gate chain itself. The operator has
authorized it: run it without asking first, including the teardown it chains.

```bash
bun scripts/fleet.ts observe <runId> --driver <driver>
bun scripts/fleet.ts observe --all --driver <driver>   # one bounded sweep of every open record
```

`--driver` is required. Exit 1 (`run-completion-unobserved`, `box-unreachable`)
is transient with the box left alive: re-invoke and the poll starts over. Exit 5
is a refusal before anything mutated (run already closed, engine dead, run
locked) and repeats on retry; report it. Exit 6 means the chain landed and a
later step failed (re-verification vetoed, approval leg failed, chain step
threw); report it verbatim and stop.

The consent covers `observe` only. A standalone `teardown` is still the
operator's explicit decision (factory-harvest).

## Reading results and errors

- Exit 0: the verb did what it says. Exit 1: run or provider failure — the
  substrate, not your invocation. Exit 2: usage — your invocation, not the
  run; fix the flags against the registry. Exit 4: no such run. Exit 5:
  refused before anything mutated. Exit 6: the work landed and the CLI's own
  output or cleanup failed after it — not retryable. From `status`, exit 5
  means a run record was skipped or unreadable (an integrity alarm: report it)
  and exit 6 means the rows were computed but the output failed. And on a `--no-harvest` teardown, exit 6 with a
  `teardown.harvest_waived` stdout line means success — the exit code alone
  does not distinguish; parse stdout for the line.
- On any failure, report the CLI's `{ code, message, remediation }` verbatim
  and stop. Never paraphrase the error, never hand-roll a workaround, and
  never retry in a way the CLI did not itself offer.
- If the operator names a verb you do not recognise, do not guess the nearest
  one. Print the registry and stop:

```bash
bun scripts/fleet.ts --help
```

## Hard rules

1. **Observation never mutates, except `observe`'s authorized chain.** `status` reads; that is all. If the operator
   wants the run changed, that is a decision for approve, reject, or attach,
   routed through those verbs — never improvised through another channel.
2. **Report and stop on failure.** A refused verb, a missing prerequisite, or
   an unknown command ends in report-and-stop with the CLI's own remediation
   line. No workaround path, no fallback command.
3. **Never volunteer state.** Observe when observing is the task — a run the
   operator launched or asked about — never to look prepared.
4. **Attach is guidance, not authority.** It cannot raise a ceiling, override
   the gate, or stand in for an approval decision.
5. **The token is never yours.** It arrives from the operator over stdin at
   invocation time and is never written down here.

## When to stop observing

Stop observing when the question changes from "what is the run doing" to "what
do we keep". Collecting a finished run's bundle and artifacts, and any
teardown decision, belong to the **factory-harvest** skill — load it rather
than fencing those verbs here. Observation's job ends with a plain report:
state, outcome, error if any, and the decision routed to its verb.

---

Skill structure and doctrine adapted from indydevdan/super-simple-software-factory
and indydevdan/inkwell-agent-sandboxes-and-software-factory, MIT License,
(c) 2026 IndyDevDan.
