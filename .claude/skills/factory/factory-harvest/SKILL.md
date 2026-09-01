---
name: factory-harvest
description: "Route a finished fleet run to harvest (pull its bundle and artifacts) and, only on an explicit operator decision, to teardown (settle spend, revoke, destroy, close). Use when a run finished, results need collecting, or a box must come down."
---

# factory-harvest

This skill routes the operator to two tested fleet verbs: `harvest`, which
collects a finished run's bundle and artifacts, and `teardown`, which ends the
run for good. Thin skill, fat CLI: the verbs and their guards live in the
registry (`src/fleet/verbs.ts`); this skill holds only the judgment — which
verb, how to read its exit code, and when to stop. Never reconstruct what a
verb does by hand; if a verb is wrong, fix the verb, never route around it.

## When to use

- A run finished (or committed work) and its results need pulling to the host.
- The operator has decided a run is over and its box should come down.
- Trigger phrases: "harvest the run", "collect the results", "tear down the
  box", "the run is done, clean it up".

## Harvest — safe to run freely

`harvest` only reads the box and writes results on the host. It is
non-destructive and safe to run repeatedly, so run it early — as soon as a run
commits — rather than letting the results wait on a teardown decision.

```bash
bun scripts/fleet.ts harvest <runId> --driver <driver>
```

`<runId>` is the run id the dispatch or status verb printed — carry that exact
string, not one you retyped, into every follow-up command so the request chain
stays joined.

## Teardown — an explicit, separate decision

`teardown` is the destructive verb, and it is irreversible. It is ALWAYS an
explicit, separate operator decision: never chain it onto a dispatch, a status
check, or a harvest, and never offer it as a workaround when something else
failed. When the operator has decided, run it as written:

```bash
bun scripts/fleet.ts teardown <runId> --driver <driver>
```

The verb's internal order — settle spend via the cost ledger, harvest, revoke,
destroy, close — lives INSIDE the tested verb. This skill never re-sequences,
splits, or re-implements those steps; they are reachable only through the verb.

`--no-harvest` skips the harvest step. Use it only when the operator already
harvested and explicitly asks to skip:

```bash
bun scripts/fleet.ts teardown <runId> --driver <driver> --no-harvest
```

v5.0 exports no `fleet reap` verb: orphan sweeping is the reaper script's job,
not a fleet verb, and this skill documents none.

## Reading the result

Exit codes are a table, not 0-or-bad:

- `0` — success.
- `1` — run or provider failure; read the stderr envelope.
- `2` — usage or schema error; fix the invocation, do not improvise new flags.
- `4` — run not found; check the `<runId>` against what dispatch/status printed.
- `5` — refused before provisioning (the run lock refused); nothing was
  mutated. Report and stop.
- `6` — two meanings, frozen by the registry NOTE: on a `--no-harvest`
  teardown, a `teardown.harvest_waived` line means SUCCESS (the waived step
  reported, not a failure). Otherwise the verb's own work LANDED but its output
  or cleanup failed — report, do not re-run blindly; a retry only re-hits the
  wedged step.

On any failure, stderr carries one JSON line shaped
`{ code, message, remediation }`. Report those three fields verbatim to the
operator and stop — never paraphrase them, and never retry in a way the CLI did
not itself offer.

## Hard rules

1. **Harvest freely, teardown deliberately.** Harvest early and as often as
   useful; teardown only on the operator's explicit say-so, as its own step.
2. **The verb owns the order.** Never hand-sequence teardown's settle /
   harvest / revoke / destroy / close steps, and never compose the underlying
   privileged operations directly — a hand-rolled version drops a measured
   guard silently.
3. **A failed teardown is report-and-stop, full stop.** That is exactly the
   moment hand-rolling a cleanup tempts. Forbidden. Report the CLI's
   `{ code, message, remediation }` verbatim and leave the state for the
   operator.
4. **Unknown verb or flag: stop.** Run the help and stop — do not guess the
   nearest verb:

```bash
bun scripts/fleet.ts --help
```

5. **Carry the runId.** The id the CLI printed is the only handle harvest,
   teardown, and the next session have; use that string in every command.

---

Skill structure and doctrine adapted from
indydevdan/super-simple-software-factory and
indydevdan/inkwell-agent-sandboxes-and-software-factory, MIT License,
(c) 2026 IndyDevDan.
