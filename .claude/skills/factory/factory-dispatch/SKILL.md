---
name: factory-dispatch
description: "Route run-start requests to the tested fleet CLI: dispatch for a single run, fanout for best-of-N, many-stories, and race patterns. Use when the operator asks to start, launch, dispatch, or fan out factory runs."
---

# factory-dispatch — start runs through the tested CLI

This skill routes "start work" requests to the fleet dispatcher's two run-starting
verbs: `dispatch` (one run) and `fanout` (N isolated arms as one pattern). The CLI
holds the knowledge — guards, caps, key handling, record-keeping; this skill holds
the judgment about which verb to run and how to read the result.

## The one governing principle: thin skill, fat CLI

Every action you take is a `fleet` command an operator could type. The verb registry
(`src/fleet/verbs.ts`, rendered by `--help`) is the only source of verb and flag
names; this skill never restates flag semantics beyond it and never composes a
command the registry does not export.

- If a verb's behavior is wrong, the fix belongs in the CLI — say so and stop. Do
  not route around it with a workaround in this skill or in the shell.
- Never hand-roll a privileged operation: do not compose an `ssh`, a `curl`, a key
  mint, a key revoke, a VM destroy, or a `git push` yourself. Those encode measured
  guards, and a hand-rolled version drops one silently. They are reachable through a
  registry verb or not at all.

## Which verb: dispatch or fanout

- **One task, done once** → `dispatch`. One brief, one box, one run record.
- **N attempts at the same brief, compared afterward** → `fanout --pattern best-of-n`.
  Scoring the finished arms is `fleet rank`'s job, not this skill's.
- **Independent stories run in parallel** → `fanout --pattern many-stories`.
- **Redundant arms, first good result wins** → `fanout --pattern race`.

When the operator did not ask for a comparison, a parallel batch, or a race, do not
reach for `fanout` — dispatch the single run. `fanout` details the registry owns and
this skill does not repeat: `--n` arm-count ranges per pattern, `--roster` arity,
`--pin` vs the brief's commitSha, and `--cap-micro-usd` as a per-arm cap in integer
micro-dollars. Read them from `--help`; if they look wrong, the CLI is where the fix
goes.

## Commands

Preflight — one command, renders the registry. Any failure means report and stop,
never work around a missing prerequisite by hand:

```bash
bun scripts/fleet.ts --help
```

Single run (canonical form; `fake` is the local no-spend driver):

```bash
bun scripts/fleet.ts dispatch --driver fake --brief brief.json
```

Fan-out, best-of-N and race:

```bash
bun scripts/fleet.ts fanout --driver fake --pattern best-of-n --n 3 --brief brief.json
bun scripts/fleet.ts fanout --driver fake --pattern race --n 2 --brief brief.json
```

The runId the verb prints is the handle — use that string, not the one you typed.
Carry it into every follow-up verb so the requestId chain stays joined across the
session:

```bash
bun scripts/fleet.ts status <runId> --driver fake
```

## Reading the exit code

The registry declares these codes for `dispatch` and `fanout`; the wording below is
the registry's own. Neither verb declares 4 (run-not-found) — a 4 from either is
outside the contract; report it, do not interpret it.

| Exit | Registry meaning | Your move |
| ---- | ---------------- | --------- |
| 0 | success | report the printed runId |
| 1 | run/provider failure; on fanout, a collected arm failure after a result returned | report-and-stop with the CLI's error line verbatim |
| 2 | usage/schema — a flag the verb does not take, an id that fails the grammar, an extra positional | fix the invocation against `--help`; never guess a flag |
| 3 | setup-gate failure, assertion code in the payload (dispatch only) | report-and-stop; the payload's assertion code is the diagnosis |
| 5 | refused before provisioning — the payload code says which guard fired (cap, fleet-busy, no-headroom) | report-and-stop; never retry with a smaller cap or fewer arms |
| 6 | the verb's work LANDED but the CLI's own output or cleanup failed after it — not retryable | see below |

Exit 6 splits by verb, and the split matters:

- **dispatch:** the box is LIVE and the ack could not be written. The registry's
  remediation is teardown now or it keeps billing:

```bash
bun scripts/fleet.ts teardown <runId> --driver fake
```

- **fanout:** the arms landed and only the completion line would not print. Report
  what landed; do not re-run the fan-out.

## When a verb fails

- **Report-and-stop.** Quote the CLI's own stderr JSON — `{ code, message,
  remediation }` — verbatim. Never paraphrase it, never invent a remediation the CLI
  did not print, and never retry in a way the CLI did not offer.
- **A refusal is a decision, not a retry.** Exit 5 means a guard refused before
  anything provisioned. Report the guard's code to the operator and stop; the
  operator decides whether to change the ask.
- **An unrecognised verb fails closed.** If the operator names a verb you do not
  recognize, run the preflight and stop — never guess the nearest verb.

## Hard rules

1. **Never volunteer state.** Volunteered state is guessed state — answer the
   request that was made; do not open with a status sweep nobody asked for.
2. **Report the run id every time.** It is the only handle the next verb, the next
   session, and teardown have.
3. **The registry is the contract.** A flag or verb that is not in `--help` output
   does not exist; document nothing ahead of it.
4. **Failure output travels verbatim.** The CLI's `{ code, message, remediation }`
   line is the report; your job is routing and reading, not re-explaining.

---

Skill structure and doctrine adapted from indydevdan/super-simple-software-factory
and indydevdan/inkwell-agent-sandboxes-and-software-factory, MIT License,
(c) 2026 IndyDevDan.
