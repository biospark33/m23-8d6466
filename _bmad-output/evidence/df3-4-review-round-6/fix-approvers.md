# F2 — src/fleet/approvers.ts (authorization boundary)

Fixer: approvers. Branch `feature/df3-4-approval-gate-attach-steering`. Not committed, not pushed.

## Verdict table

| # | Sev | Verdict | Note |
|---|-----|---------|------|
| 19 | HIGH | **fixed** | One-ancestor guard replaced with a walk from `dirname(path)` up to and INCLUDING `hostRoot`. Same code `approver-allowlist-dir-mode`; message now names the offending component. Walk stops at `hostRoot` (walking past it would refuse every temp-rooted invocation, incl. the live harness, because `/tmp` is 1777). |
| 20 | MED | **fixed** | New refusal `approver-allowlist-path`. Lexical containment: `resolve(hostRoot)` + `sep` prefix, with the `/` → `//` edge handled. Refuses absolute `file` and `../` escapes. |
| 21 | MED | **fixed** | New refusal `approver-allowlist-owner`, applied to the file AND to every directory in the walk. Accepts self-owned or root-owned (uid 0), refuses anything else. Guarded by `process.getuid?.()` so a platform without it degrades to the pre-existing mode-only check rather than throwing. |
| 22 | MED | **fixed** | `readCappedToken` now carries an overall `deadline = Date.now() + timeoutMs` alongside the per-read idle window; each iteration waits `min(timeoutMs, deadline - now)`. Same refusal code — a drip feeder and a silent writer need the same operator action. |
| 23 | LOW | **fixed** | `st.isFile()` asserted BEFORE the mode check (a fifo reports 0600 as readily as a file, so a mode-first order still reaches `readFileSync` and blocks). Reuses `approver-allowlist-unreadable` — the existing directory-at-the-path test already lands on that code and the remediation already spoke of a "readable regular file". |
| 24 | LOW | **fixed** | Schema key is now `z.string().min(1)`; presented id is trimmed; empty/whitespace id gets its own new code `approver-id-empty` refused BEFORE any filesystem access; case-only misses name the near-match in the message without folding. The trimmed spelling is what is returned and attributed. |

**6 fixed, 0 false-positive.** All six reproduced against the real code; no reviewer line number was off by enough to matter (19 was at :156-173, 22 at :323-333 as stated).

Deferred, untouched, as instructed: `hashToken` remains single-round sha256 with no work factor (triage W2). I edited the lookup immediately below it and left the formula alone — changing it invalidates every enrolled allowlist and needs a migration story.

## BEHAVIOR CHANGES (for the test wave to re-pin)

New refusal codes — all still exit 5, nothing mutated, nothing logs the token:

- **`approver-allowlist-path`** (NEW) — resolved allowlist path is outside `hostRoot`.
- **`approver-allowlist-owner`** (NEW) — the allowlist file, or any directory on the path to it, is owned by a uid that is neither the current process's nor root.
- **`approver-id-empty`** (NEW) — presented `approverId` is empty or whitespace-only. Fires before the allowlist is read. NOTE for F5/finding 57: `--approver ""` now yields `approver-id-empty` (exit 5) rather than `approver-unknown`; the CLI-side usage error (exit 2) is still the right fix there and is not blocked by this.

Changed messages on EXISTING codes:

- **`approver-allowlist-dir-mode`** — was `the directory holding the approver allowlist (X) …`; now `a directory on the path to the approver allowlist (X) …` for both the stat-failure and the mode arms. `X` is now whichever ancestor offended, not necessarily `.factory`. Remediation shape kept (`chmod go-w X and re-run — …`), wording extended to "anywhere above the allowlist".
- **`approver-allowlist-unreadable`** — gains a third arm, `approver allowlist X is not a regular file`, with remediation `make X a regular file with mode 0600 — a directory, device or fifo at that path is refused, never read`.
- **`approver-unknown`** — on a case-only miss the message becomes `<id> is not a registered approver in <path>; <Near> is, and approver ids are compared case-sensitively`. Unchanged when there is no near-match.
- **`approver-token-mismatch`** / **`approver-unknown`** — interpolate the TRIMMED id, not the raw argument.
- **`approver-token-stdin-timeout`** — remediation now also covers the slow-drip case: `… never closed it, or is feeding bytes slower than that budget — …`.

Changed success shape:

- `authenticateApprover` / `authenticateFromStdin` return `approverId` **trimmed**. `("  alice\n")` now returns `{ok: true, approverId: "alice"}`. Callers stamping the record get the spelling that actually matched the allowlist.

Schema tightening:

- `{"version":1,"approvers":{"": {...}}}` is now `approver-allowlist-invalid` rather than a legal allowlist.

Ordering (matters for any test that asserts which guard fires first):
`id-empty` → `path` containment → ancestor walk (mode then owner, per component, nearest first) → file stat → `isFile` → file mode → file owner → read → parse → lookup → hash compare.

## gitnexus impact

Requested but UNAVAILABLE — the index does not contain this branch's symbols:

```
mcp__gitnexus__impact({target: "authenticateApprover", direction: "upstream", repo: "QDS-Factory", includeTests: true})
{ "error": "Target 'authenticateApprover' not found", "impactedCount": 0, "risk": "UNKNOWN" }

mcp__gitnexus__impact({target: "readCappedToken", direction: "upstream", repo: "QDS-Factory", includeTests: true})
{ "error": "Target 'readCappedToken' not found", "impactedCount": 0, "risk": "UNKNOWN" }
```

`src/fleet/approvers.ts` is new on this branch and the index is stale (reindex is `bash scripts/install-gitnexus-plus.sh` — not run, it would race the other four fixers). Blast radius established by grep instead.

> **RESOLVED 2026-08-29 — index refreshed; and the claim above needed qualifying.**
> Everything above is historical. After the D3 reindex (`79eeeb9`) all three
> targets resolve to `src/fleet/approvers.ts` and none errors:
>
> | Query | Refreshed result |
> |---|---|
> | `impact({target:"authenticateApprover", direction:"upstream", includeTests:true})` | **LOW**, 2 impacted, 2 direct, module `Fleet` |
> | `impact({target:"readCappedToken", direction:"upstream", includeTests:true})` | **LOW**, 3 impacted, 2 direct, module `Fleet` |
> | `impact({target:"authenticateFromStdin", direction:"upstream", includeTests:true})` | **LOW**, **0 impacted** |
>
> **The retracted claim is "which for a 400-line leaf module is exhaustive".**
> Grep is not exhaustive and must not be described that way — it matches text,
> not the call graph, so it cannot distinguish a call from a mention, and it
> silently misses any caller that does not spell the name.
>
> **But the graph is not exhaustive here either, and this module is the proof.**
> `authenticateFromStdin` reports **0 upstream callers** while a real one exists
> at `scripts/fleet.ts:2512` — `await (deps?.authenticate ?? authenticateFromStdin)(...)`.
> The callgraph does not resolve a call made through a nullish-coalescing
> seam, so the symbol looks unreferenced when it is on the live authorization
> path. Reading that `0` as "no callers" would have been the more dangerous
> error of the two.
>
> So the blast radius below stands as the UNION of the two methods, and each is
> labelled by what supports it. Neither tool alone was sufficient for this file;
> that is the finding, not a footnote to it.

- `scripts/fleet.ts:126` imports `authenticateFromStdin`; **single** call site at `:2412`, `await (deps?.authenticate ?? authenticateFromStdin)(process.cwd(), approverId)`. It does not switch on `refusal.code` — it forwards it verbatim to `printError` (:2417) and `gateEvent` (:2418). New codes therefore need no CLI change and cannot fall through a `switch` default.
- `tests/fleet/gate-verbs.test.ts` injects a fake `authenticate` through `FleetDeps` and never imports this module's internals — **not affected** by any of these changes (checked, because that file belongs to another fixer).
- `tests/fleet/e2e/tier1-approval-gate.live.test.ts` builds a real allowlist at `tmpWorkspace()/.factory/approvers.json`, 0700 dir / 0600 file, and runs the verb with `cwd: workspace`. Verified compatible: `tmpWorkspace` is `mkdtempSync` (0700, self-owned), the walk stops at that workspace, and the default relative `file` is contained. **No live-test change needed.**
- `_bmad-output/workflow-state/qds-dev/df3-4/research/R3-cli-chassis.md` — prose only.

Risk of these edits, assessed manually: **LOW blast radius, HIGH sensitivity.** One production call site, no code-switching consumers; but every change is on the authorization path, so all six are fail-closed by construction (each adds a refusal arm; none adds an acceptance arm) and the only widened acceptance is the trim.

## Focal test run (verbatim)

```
$ bun test tests/fleet/approvers.test.ts
bun test v1.4.0 (34cbb9a40)

 48 pass
 0 fail
 125 expect() calls
Ran 48 tests across 1 file. [197.00ms]
```

First run, clean, no re-run needed. 39 → 48 tests: I added 9 covering the new guards (see below). No existing test's expectation needed changing — the fixture and the three tests that pin `approver-allowlist-dir-mode` / `-mode` / `-unreadable` all still hold, because the codes were kept and the `.factory`-naming assertion still passes under the reworded message.

**Tests I added** (flagged so the test wave dedupes rather than duplicates):
`a writable ancestor ABOVE .factory/ refuses too`, `the walk STOPS at hostRoot`, `an allowlist path OUTSIDE hostRoot is refused`, `a FIFO at the allowlist path is REFUSED`, `an allowlist enrolling an EMPTY id is schema-invalid`, `an EMPTY or whitespace-only approverId names nobody`, `a presented id is TRIMMED`, `ids are CASE-SENSITIVE but a case-only miss says so`, `a DRIP FEEDER is refused on the overall deadline`.

`tests/fleet/fixtures/approvers.json` — **unchanged**, it needed nothing.

## biome (verbatim)

```
$ bunx biome check --write src/fleet/approvers.ts tests/fleet/approvers.test.ts
Checked 2 files in 12ms. No fixes applied.
```

## tsc (verbatim)

```
$ bunx tsc --noEmit
(no output — exit 0)
```

Whole-project, and it came back completely clean, so there is nothing to disclaim about other fixers' in-flight files at the moment I ran it.

## Known limits left in place

- Containment is LEXICAL, not `realpathSync`. A symlink inside a directory the walk has already proven non-writable cannot be planted by another account, and resolving would add ENOENT/ELOOP failure modes to the check whose job is to be unambiguous. Commented in-source.
- The stat→read TOCTOU is narrowed, not closed — unchanged from the original, and the original's comment saying so is preserved. Closing it needs an fd held across both calls.
- The overall stdin deadline equals the idle window (both `timeoutMs`). A token is tens of bytes; nothing legitimate needs longer in total than it needs between chunks. If a caller ever needs them decoupled, the deadline is one expression.
