# DF4.1 — Visualizer Port + Tunneled Auth Gate

`/qds-dev DF4.1` — follow the `qds-dev` skill strictly and explicitly, no step skipped, no phase
collapsed. Use **waves of parallel subagents** for the work so this thread's context stays fresh.
Full enterprise-grade rigor: production-ready code confirmed by real E2E, no shortcuts, no
band-aids, no "wire later", no assumed behavior. Be **≥95% sure** of every claim — verify against
real source or a real run, never memory.

## Story and spec

- Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df4-1-visualizer-port-auth.md`
- Spec: `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`
  §3.3 (visualizer + trace schema adoption), §5.1 (tiers), §6 clause 7 (trace confidentiality),
  §8 step 4 — plus decision register **D6**, **D10**, **R10**, **F11**.
- Predecessors already merged: **DF1.4** (SQLite trace store, PR #113), **DF2.9** (OCI image
  contract + NOTICE sweep, PR #105). Consume them; do not re-implement either.

## Source repos — read these, lift from them, do not modify them

**1. `/Users/i3creations/Development/AI-Tools/disler/super-simple-software-factory`**
Visualizer source is at **`.claude/skills/sssf/apps/visualizer/`** — not the repo root, which looks
docs-only. Clone HEAD is `de31374882e7a4e3e5b7bb9bd09e69dc2f779356`; **that is the pin** recorded
in `visualizer/PROVENANCE.md`.
*Why:* per **D10** the visualizer is the single code adoption from SSSF — everything else in v5 is
pattern harvest. `server/index.ts`, `server/db.ts`, `shared/types.ts`, `src/lib/router.ts` and the
Vue components under `src/components/` are meant to be **vendored close to verbatim**, then
hardened. Copy, don't rewrite. Anything you retype instead of vendoring is a diff you now own
forever and a re-vendor conflict later.

**2. `/Users/i3creations/Development/AI-Tools/disler/inkwell-agent-sandboxes-and-software-factory`**
Specifically **`apps/inkwell/server.ts`** and **`apps/inkwell/server.test.ts`**.
*Why:* the second, independent precedent for a Bun.serve factory server and the shape of its
tests — route layout, static branch, test structure worth copying rather than inventing.
**Not an auth reference:** inkwell leans entirely on exe.dev's proxy gate and ships no in-process
authn. F11/R10 forbid that posture here — the trace holds full compiled prompts, i.e. client
source. Our gate is ours to write.

Neither upstream ships authn, authz, a session concept, or a bind-address restriction (R4 §2.6).
That absence **is** the story: gate on every route, loopback bind, tier-1 SSH forward.

## Ponytail principles apply

Lift over write. Vendored upstream code over a fresh implementation. Stdlib/Bun built-ins over a
new dependency — `Bun.serve`, `bun:sqlite`, `crypto.timingSafeEqual` are already there. Add no
package that a few lines cover. The hardening delta on top of the vendored tree should be small
and legible: an auth module, a hostname bind, a gate on every route, provenance/licence records.
Minimal does **not** apply to the auth boundary, input validation, or the AC0 provenance record —
those get built in full.

## Vendoring is AC0 and runs first

`scripts/vendor-visualizer.ts` takes the pin as an **explicit input** — `VENDOR_VISUALIZER_REPO` /
`VENDOR_VISUALIZER_SHA` env vars or `--repo` / `--sha` flags — and **writes**
`visualizer/PROVENANCE.md`; it never reads that file as its own input (it does not exist yet on a
clean checkout). It must emit `visualizer/LICENSE.upstream` with the upstream MIT text verbatim,
and re-running against the same pin must be a **no-op diff**. Every hardening edit to a vendored
file has to survive that re-run — design for it up front, don't discover it at the gate.

## GitNexus (required by repo CLAUDE.md)

- `impact({target:"<symbol>", direction:"upstream"})` before editing any existing symbol; report
  blast radius; stop and surface HIGH/CRITICAL before proceeding.
- `query({query:"<concept>"})` / `context({name:"<symbol>"})` to find the DF1.4 trace-store API
  instead of grepping.
- `detect_changes({scope:"compare", base_ref:"dev"})` before every commit — blast radius must
  stay inside DF4.1's own modules.
- `rename` for renames. Never find-and-replace.

## Subagent waves

Dispatch disjoint clusters in parallel, one message per wave; agents return reports, **you** hold
the thread. Suggested order:
1. **Vendor wave** — `scripts/vendor-visualizer.ts` + provenance/licence records (AC0 gates
   everything else, so this lands first).
2. **Server wave** — `visualizer/server/*` auth gate, loopback bind, read-only routes over the
   DF1.4 trace DB.
3. **Client wave** — vendored Vue tree + the minimum edits to point it at our API.
4. **Test wave** — after behavior settles, so expectations see final code.

No two agents touch the same file. Fixers verify in real source before editing.

## Definition of done

- `bun test` · `bunx tsc --noEmit` · `bun run typecheck:visualizer` · `bun run lint` ·
  `bun run notice:sweep` — all green, run by you, not reported by an agent.
- Re-run the vendoring step against the pin into a temp dir: no-op diff holds (AC0).
- **Real E2E, not a mock:** a `trace.db` from an actual DF1.4 run, server started with
  `QDS_VIZ_TOKEN` set, `ssh -L 4600:127.0.0.1:4600` forward, browser at `http://127.0.0.1:4600/`
  challenges → session list → swim-lane → phase detail showing compiled system+user prompts, gate
  `checks_json` rows and the cost table. Same request with no credential → `401`, empty body.
  Nothing listening on the externally routable address. Capture evidence to
  `_bmad-output/evidence/df4-1/`.
- Story file updated (status + completion notes), `sprint-status.yaml` updated.
- PR opened per repo rule: **`biospark33` runs `gh pr create` only**, then switch back to
  `i3creations` immediately; every other git/gh operation runs as `i3creations`.

DF4.2 owns tests inventory and per-box deploy. Do not build it here.
