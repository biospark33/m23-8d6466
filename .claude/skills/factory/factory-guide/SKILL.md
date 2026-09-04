---
name: factory-guide
description: "Index, session preflight, and the one-time commercial-terms and containment-scope statements for the factory skills over the fleet CLI. Start here before any dispatch; routes to factory-dispatch, factory-observe, and factory-harvest for per-verb depth."
---

# Factory Guide

This is the index of the four factory skills, the session preflight, and the two one-time
statements (commercial terms and containment scope). It holds no per-verb depth — it routes
to the three sibling skills, which hold the judgment for their verbs. The sole source of
verb and flag names is the DF3.1 verb registry (`listVerbs()` in `src/fleet/verbs.ts`),
rendered by `bun scripts/fleet.ts --help`.

## The one governing principle: THIN SKILL, FAT CLI

Skills route; the CLI guards. Never hand-roll a key mint, a key revoke, an ssh, a curl, a
VM destroy, or a git push — those operations encode measured guards and are reachable only
through a registry verb, or not at all. If a skill and the CLI disagree, the CLI registry
is the truth: fix the skill, never improvise around the CLI.

## Preflight (run once, before the first verb of a session)

Preflight is one command. Any failure means report and stop — a missing prerequisite is
never worked around by hand.

```bash
bun scripts/fleet.ts --help
```

Exit 0 renders the registry and proves the CLI loads. On failure, report the CLI's output
verbatim and stop. The same rule covers an operator-named verb that does not exist: run
the preflight command, report, and stop — never guess the nearest verb.

## The three sibling skills (index)

- **factory-dispatch** — reach for it when work starts: `dispatch` a single run, `fanout`
  N variants from a pattern. Owns run-start judgment and the runId handoff.
- **factory-observe** — reach for it while a run is live: `status` to read a run, `attach`
  to steer it with guidance text, and the approval routing (`approve` / `reject`) when a run
  sits in `awaiting-approval`. Note: `factory-observe` is a skill name, distinct from any
  future fleet verb of a similar name.
- **factory-harvest** — reach for it when a run ends: `harvest` the results early and freely
  (non-destructive), then `teardown` only on an explicit human decision — it is the one
  destructive verb and is never chained off dispatch.

`fleet rank` scores a completed best-of-N fan-out. It is a registry verb no Tier-1
skill wraps: it takes the fanoutId (not a runId) and declares no `--driver` — read
its flags from the preflight render.

## Commercial terms (stated once, here only)

Client deployments run on an org-owned API key under Commercial Terms §A.1.

The operator's own Claude Code subscription extends to this repo's work only; anything
beyond that is a client deployment under the sentence above. Pricing lives with the cost
ledger (DF2.8) — this file, and every skill, quotes no prices, no rates, and no
subscription-tier names.

## Containment scope in v5.0 (stated once, here only — DD-11)

This is a scope caveat, never a sales claim. Per DD-11:

1. DD-11: containment in v5.0 is BYOK direct-provider egress only — the box talks to the
   model provider on the run's own capped key, and nothing routes through a shared account.
2. There is no per-VM egress allowlist on exe.dev (DD-11), because the substrate exposes no
   per-VM egress control today — no v5.0 story can enforce one.
3. DD-11: the policy re-enters with the OCI driver (design §8 step 7), where the network
   namespace is ours.

No skill file may restate containment as a capability beyond these lines.

## Hard rules

1. **Preflight failure means report and stop.** Never work around a missing prerequisite
   by hand.
2. **Verb failure means report and stop**, with the CLI's own `{ code, message,
   remediation }` line verbatim — never a hand-rolled workaround, never a retry the CLI
   did not itself offer.
3. **Unknown verb means preflight and stop.** Run the preflight command, report what the
   registry actually exports, and stop — never guess the nearest verb.
4. **No skill carries a credential.** Secrets and approver tokens are supplied by
   the operator on stdin at invocation time — there is no flag and no env var for them.
5. **Carry the runId.** The runId a verb prints is the handle every follow-up verb takes —
   use the printed string, not the one you typed.
6. **Volunteered state is guessed state.** Observe when asked, through factory-observe —
   never volunteer a status report nobody requested.

---

Skill structure and doctrine adapted from indydevdan/super-simple-software-factory and
indydevdan/inkwell-agent-sandboxes-and-software-factory, MIT License, (c) 2026 IndyDevDan.
