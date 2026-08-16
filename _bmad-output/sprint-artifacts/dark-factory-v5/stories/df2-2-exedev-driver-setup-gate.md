---
baseline_commit: 041b834
---

# DF2.2: exe.dev Driver + Five-Assertion Setup Gate

**Story Points:** 5
**Sprint:** v5-S1 (track B, provider)

**Status:** review

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4, §3.5, §5.1, §5.3, §6 items 1/3/5
- Decision register: v5 §4 **D7** (provider-driver interface, exe.dev + OCI as two first-class drivers), **D8**
- Contracts: provider-driver verbs `create/fill/setup/execute/observe/teardown/reap` (v5 §5.1) — interface owned by DF2.1
- Binding facts: R5 §6 fact **11** (exe.dev figures are vendor-single-origin; no SOC 2 / DPA / SLA), fact **13** (pi catalog stale both ways), fact **15** (in-box evidence is a claim, not proof)
- Source patterns (file:line): R4 §3.4 — `INK/just/sandbox/lifecycle/setup.just:8-10, 18-24, 48-58, 61-65, 90-120, 122-145, 147-151, 169-201, 205-243, 245-271`;
  R4 §3.5 — `create.just:85, 87-89, 108-122, 172-173`; `teardown.just:64, 161`; `observe.just:126-131, 159-161`; `manage/mod.just:29`; `fill.just:74-90`

## User Story

As the factory host,
I want an exe.dev provider driver whose `setup` refuses to return ready until five assertions prove the box is genuinely usable,
so that a run never spends money inside a box whose clone is truncated, whose model registry is empty, or whose cost table silently reports $0.0000.

## Overview

The exe.dev driver implements DF2.1's provider interface over six control-plane command shapes
(`new`, `ls`, `rm`, `share port`, `share set-public`, `whoami`) plus generic `ssh`/`scp`. `fill`
clones the repo and pins the recorded SHA on a `sbx/<run-id>` branch that adds no commit and leaves
the tree byte-identical. `setup` clears the sentinel, provisions, then runs the five-assertion gate
(table below) — C/D/E as one script **inside** the box, so the run key never crosses the wire.

## E2E Slice

**Demonstrable behavior:** Given a run record carrying `commitSha` and a roster path, When
`driver.create() → driver.fill() → driver.setup()` runs, it provisions a VM named `<run-id>`,
resolves `httpsUrl` as `<run-id>.exe.xyz`, clones and pins the SHA on `sbx/<run-id>`, then
returns `ready` only after all five assertions pass — each recorded as
`{ item, ok, note }` evidence (e.g. `"A: HEAD 4f9c2ab, porcelain empty"`,
`"D: pi cost.total 4.3e-05 > 0; 5/5 models priced"`).

**Wiring closed:** On completion of this story, a box can be created, filled at a pinned SHA, and
gated to `ready` using only code merged by this story plus DF2.1's interface and DF2.3's
credential lifecycle. No stub, no `TODO: wire later`, and no sibling story is required to make
this behavior real. DF2.5 harvests from such a box; DF3.1 dispatches to one.

**Dependency edges (predecessors):** DF2.1, DF2.3.

## Acceptance Criteria

1. **(make-or-break)** Given a run record with `commitSha` and an active roster path passed **as
   an argument**, When `setup` runs, Then it returns `ready` only if all five assertions pass, and
   the returned evidence carries one `{item, ok, note}` entry per assertion — pass **and** fail
   alike. `setup` is a driver method, not a process: on any failure it **returns**
   `{ready: false, failedItem, assertionCode, assertions[]}` where `assertionCode` is that
   assertion's code (A=1, B=1, C=2, D=3, E=4 — A and B deliberately **share** 1, so the failing
   `item` is the discriminator and the code never is), **leaves the VM alive**, and carries the
   debug commands plus the teardown command in the payload. Only the `scripts/`-level caller maps
   `assertionCode` to a process exit status; DF3.1's dispatcher keeps it in the payload.
2. Given a box where `pi --list-models` **exits 0 while printing "No models available"**, When
   assertion B runs, Then B fails on content. *Negative control: an implementation that trusts
   `$?` passes this box and MUST fail this test.* `command -v pi` is checked first, so
   "command not found" cannot satisfy a non-empty-output check.
3. Given a fill that produced truncated/zero-byte files, When assertion A runs, Then A fails
   because `git status --porcelain` is non-empty — even though `HEAD` prefix-matches the recorded
   `commitSha`. (Measured upstream: an unsynced clone produced 5,641 zero-byte files and reported
   success.)
4. Given `~/.pi/agent/models.json` with a partial `cost` block (missing `cacheWrite`), When
   assertion D runs, Then it fails naming the whole-roster-drop consequence; given a model whose
   `cost.input` is `0`, D fails rather than letting the factory report `$0.0000` while spending.
   D's first half requires a real `pi -p --mode json` call reporting `cost.total > 0` — diffing
   `/api/v1/key` usage is the wrong instrument and must not be used.
5. Given `ssh exe.dev new --name <id> --json` returns a response whose key names do not match any
   recognized shape, When `create` runs, Then the driver falls back to re-reading the one verified
   shape `ls <name> --json` → `{"vms":[{vm_name, https_url, ssh_dest, …}]}` and derives
   `https_url` from `<name>.exe.xyz`; if both are unusable, `create` fails closed **after** the
   name is recorded, so the VM is findable by `ls` and never orphaned invisibly.
6. Given a box whose `/tmp/PROVISION_READY` sentinel survives from a previous run, When `setup`
   runs, Then it clears the sentinel **before** provisioning — stale readiness is never read as this
   run's. Given a key whose `limit` is `null`, Then E fails: an uncapped key must never gate green.
7. Given a box being provisioned, When `setup` runs, Then it writes `QDS_TEAM_RUNNER=local` into the
   box's run environment — the environment the in-box engine inherits — beside DF2.3's
   `/home/agent/app/.env` key-delivery contract, and the setup-gate test asserts the variable is
   present with exactly that value before `ready` is returned. This is the producer DF1.6's
   `dispatch_task` reads from its **inherited** environment (df1-6 AC5): a box provisioned without it
   refuses at the first `dispatch_task` rather than taking the `warren` branch.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| DF2.1 driver registry resolving `exedev` for `create`/`fill`/`setup`/`execute`/`observe` | in-scope | `tests/providers/exedev/driver.test.ts` | — |
| `setup(runId, rosterPath)` in the create→fill→setup chain | in-scope | `tests/providers/exedev/setup-gate.test.ts` | — |
| One live-fire mount against a real exe.dev account | in-scope | DOD e2e item (evidence run) | — |
| `teardown` / `rm <vm>` (the only VM-destroying path) | out-of-scope | — | DF2.5 |
| `share port` / `share set-public` for the visualizer | out-of-scope | — | DF4.2 |
| `fleet dispatch` CLI selecting a driver | out-of-scope | — | DF3.1 |
| OCI driver implementing the same interface (enterprise tier) | out-of-scope | — | DF2.9 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| exe.dev gateway account + SSH access | exe.dev (Bold Software, Inc.), Personal/Team plan **[VERIFY]** | `ssh exe.dev whoami` preflight returns the expected account before any record is created |
| `vm-sharing admins-only` org setting | exe.dev team settings — flipped day one (design §3.5) | operator attestation recorded once in `.sandbox/exedev-posture.json`; `setPublic()` refuses to run when the attestation is absent |
| Per-run capped LLM key | DF2.3 credential lifecycle | key minted after VM create, delivered before setup; assertion E proves credit remaining |
| Box image with pi **0.55.0** (pinned — R5 §6 facts 1/14), roster, `~/.pi/agent/models.json` | golden VM tag today; OCI image contract later (DF2.9) | assertion B proves the registry loaded; assertion D proves rates are non-zero |
| In-box probe dependencies (`curl`, `python3`, `git`) | box image | assertion script exits `127`-mapped with a named missing dependency rather than a false fail |

## Technical Notes

- **The provider surface is six shapes** (R4 §3.5, verified exhaustively): `new --name <id> --tag
  <tag> --json`, `ls [<name>] --json`, `rm <vm>`, `share port <vm> <port>`,
  `share set-public <vm>`, `whoami`. Everything else is plain `ssh <vm>.exe.xyz "<cmd>"` and
  `scp`. The vendored 2,242-line `exedev` Python CLI is **not** the port target — the recipes
  beside it never call it.
- **Verified vs unverified is recorded, not assumed.** `ls --json`'s shape and the
  `<name>.exe.xyz` derivation are Measured; `new --json`'s key names are UNVERIFIED. The driver
  carries the split explicitly and prefers a re-read of the verified shape over a guess.
- **Assertion table** (`setup.just:90-255`):

  | # | Assertion | Proves | Exit |
  |---|---|---|---|
  | A | git integrity **by content** | `HEAD` prefix-matches the record's `commitSha` **and** `git status --porcelain` is empty | 1 |
  | B | pi registry loaded | `command -v pi`, then `--list-models` non-empty **and** not containing `no models available` | 1 |
  | C | live model ping per roster | real `chat/completions` per roster model with `provider:{zdr:true, data_collection:"deny"}`; accepts `content` **or** `reasoning` | 2 |
  | D | cost table loaded | real `pi -p --mode json` reports `cost.total > 0`, **and** every model in `models.json` has non-zero `cost.input` | 3 |
  | E | capped credit remaining | `GET /api/v1/key` with the **runtime** key; remaining is **computed** as `limit - usage`; a `null` limit means **uncapped** and E **fails** — DF2.3 INV-CRED-1 requires a capped key. Proves headroom, never liveness: this endpoint returns `200` for a dead key (DF2.3 INV-CRED-4), so C is the liveness proof and must run first | 4 |

- **Three structural rules carried verbatim from the source:** C/D/E run as **one script inside
  the box** so the runtime key never crosses the wire and the gate exercises the box's own egress;
  the roster is an **argument, not an environment variable** (`ssh host 'cmd'` carries no
  environment — a measured bug where every fan-out arm gated against models it would never call);
  and `/tmp/PROVISION_READY` is cleared before provisioning (AC6).
- **Two pi rate-table landmines (R4 §4.2):** `models.json` requires **all four** of
  `input`/`output`/`cacheRead`/`cacheWrite` — a partial block fails validation and pi drops the
  **entire roster**; a missing `cost` block defaults every rate to zero and the factory reports
  `$0.0000` forever while genuinely spending (observed on a 463.6k-token run).
- **Fill semantics** (`fill.just:74-90`): public unauthenticated clone, SHA pinned, branch
  `sbx/<run-id>` created at existing `HEAD` — no commit added, tree byte-identical, so assertion A
  still passes. A re-fill **switches to** the branch, never re-creates it; its commits are the output.
- **Guards/limits:** per-assertion timeout 60_000 ms, whole gate 300_000 ms; `POST https://exe.dev/exec`
  is capped at 30 s / 64 KB **[VERIFY]**, which is why every exec path uses SSH.
- **Deviation/assumption — all exe.dev behavioural and commercial claims are `[VERIFY]`,
  vendor-single-origin** (R5 §6 fact 11): wildcard gateway host key, default port-8000 proxying,
  "only one port can ever be anonymous", ~2 s boot, VMs never expire and bill until killed,
  server-side secret injection, 50-VM / 100 GB-pooled-disk allowances. Each is recorded
  `verified: false` and the driver refuses the dependent operation rather than assuming. **No AC in
  this story assumes a SOC 2 report, a customer-facing DPA, or an SLA exists** — none does.

## Observability Contract

- Every driver operation logs `{ requestId, runId, op, vm, durationMs, outcome, verified }`;
  `verified` records whether the response shape was the Measured one or a fallback.
- requestId propagates from the dispatch that created the run record; errors include
  `{ code, message, remediation }` naming the literal next command.
- Sub-timings: `create_ms`, `fill_ms`, `gate_a_ms` … `gate_e_ms`. Secrets are never logged — the
  gate reports credit as a computed remainder, never the key.

## Files to Modify

- `src/providers/exedev/driver.ts`
- `src/providers/exedev/fill.ts`
- `src/providers/exedev/setup-gate.ts`
- `src/providers/exedev/assertions-in-box.sh`
- `src/providers/index.ts`
- `tests/providers/exedev/driver.test.ts`
- `tests/providers/exedev/setup-gate.test.ts`
- `tests/providers/exedev/fixtures/fake-exedev.ts`

## Security Invariants

- **INV-1 (isolation):** one run per box, single-tenant. `vm-sharing` is `admins-only`; the
  driver's `setPublic()` refuses without the recorded posture attestation, and at most one port is
  ever anonymous **[VERIFY]**. No trace or visualizer port is exposed by this story.
- **INV-2 (input validation + ordering):** assertion A runs before any assertion that spends
  money, so a truncated clone is caught before the first paid token. The run-id is validated as a
  hostname (regex plus a 63-char limit) before it becomes a VM name and therefore a public URL.
- **INV-3 (never trust `$?`):** every assertion asserts on **content**, not on exit status —
  `pi --list-models` exits 0 while printing "No models available". A green gate states what it
  verified; a red one names the item and carries the evidence note.
- **INV-4 (credential containment):** the runtime key never crosses the wire during setup. C/D/E
  execute as one in-box script reading the key from the box's own `0600` file; the provisioning
  key is never present in the box at all. See DF2.3 INV-CRED-1 … INV-CRED-3.
- **INV-5 (fail-closed):** a failing gate **never destroys the VM** — destroying it throws away
  the evidence. An unverified vendor claim is never an implicit pass: the dependent operation is
  refused and recorded `verified: false`. In-box gate output is a **claim, not proof** (R5 §6
  fact 15) — nothing here authorizes a PR; host-side re-verification is DF5.1's job.

## Definition of Done

- [x] **Impl:** `src/providers/exedev/driver.ts` implements DF2.1's interface over the six control-plane
      shapes plus `ssh`/`scp`, with the verified/unverified response-shape split recorded per call.
- [x] **Impl:** `fill` clones, pins the record's `commitSha`, and creates-or-switches `sbx/<run-id>` leaving the tree
      byte-identical; a re-fill never re-creates the branch.
- [x] **Impl:** five-assertion gate with source-fixed exit codes (A/B=1, C=2, D=3, E=4), C/D/E as one in-box
      script, roster passed as an argument, sentinel cleared before provisioning.
- [x] **Contract:** setup returns `{ready, failedItem?, assertionCode?, assertions[]}` with one
      `{item, ok, note}` per assertion, recorded on pass and fail alike; no code path in the driver
      calls `process.exit`.
- [x] **Integration:** driver registered in `src/providers/index.ts`; the run key delivered by DF2.3 is
      the key assertion E measures.
- [x] **Integration (team-runner seam, DF1.6 boundary):** `setup` writes `QDS_TEAM_RUNNER=local` into the
      box run environment beside DF2.3's `/home/agent/app/.env` delivery (AC7); the setup-gate test asserts
      the variable and its value are present in that environment before `ready` is returned.
- [x] **Security:** `setPublic()` refuses without the recorded `vm-sharing admins-only` attestation; a
      gate failure leaves the VM alive and prints teardown (INV-1, INV-5).
- [x] **Test (unit):** each of the five assertions has an independent pass case and fail case against the
      exe.dev/box fake.
- [x] **Test (exit-code-trap):** a box whose `pi --list-models` exits 0 printing "No models available"
      fails assertion B; a `$?`-trusting implementation passes it and MUST fail this test.
- [x] **Test (cost-table landmine):** partial `cost` block (missing `cacheWrite`) and zero `cost.input`
      each fail assertion D with the roster-drop / silent-$0.0000 diagnosis named.
- [ ] **Test (e2e demo — MANDATORY):** one live-fire `create → fill → setup` against a real exe.dev
      account produces a `ready` result with all five assertion notes captured to
      `.sandbox/runs/<run-id>-setup.json`. On the successful `ready` path, cleanup runs as a
      finally-style step **after** the artifact is retained, invoking DF2.5's `teardown`/`rm <vm>` verb
      — the only VM-destroying path (see Trigger Surface) — rather than any ad-hoc deletion; VM
      destruction is asserted only from teardown's own confirmation, never assumed from the harness
      issuing the call. A `setup` failure preserves INV-5's fail-closed semantics: the VM stays alive,
      the artifact is retained, and the failure note names the DF2.5/DF2.6 remediation path.
      **[Status: env-gated scaffold shipped — `test.todoIf(!process.env.QDS_EXEDEV_LIVE)` in
      `tests/providers/exedev/setup-gate.test.ts`. Requires a real exe.dev account + key (Infra
      Prerequisites are [VERIFY] vendor-single-origin); the evidence run is an operator action, not
      CI. Artifact path deviates — see Dev Agent Record deviation 1.]**

## Dev Agent Record

### Implementation Plan → what was actually built

- `src/providers/exedev/driver.ts` — `ExeDevDriver implements ProviderDriver` (the eight primitives,
  unmodified seam) over `ssh exe.dev <control-plane>` + `ssh <vm>.exe.xyz <cmd>` + `scp`, plus the
  exedev-specific `fill()`/`setup()` lifecycle methods (structural typing; DF2.1's host-side verbs
  untouched). Every box name re-asserts the run-id hostname grammar (`assertValidRunId`) BEFORE a
  command is built (INV-2). `create` carries the verified/unverified split: recognized `new --json`
  shape → fallback re-read of the MEASURED `ls --json` shape → `<name>.exe.xyz` derivation →
  fail-closed with the VM still findable (AC5). `setPublic` refuses without the
  `vm-sharing: admins-only` posture attestation, before any share command (INV-1). `destroy` is
  idempotent by CONTENT: a failed `rm` is re-read via `ls`. Command execution is one injected
  `ExeCommand` seam — production `sshCommand()` (Bun.spawn argv array, timeout+SIGKILL; no local
  shell, no exec()-style string) — tests swap the substrate, never the driver.
- `src/providers/exedev/fill.ts` — clone → pin `commitSha` → create-or-switch `sbx/<run-id>` at HEAD
  (no commit added; tree byte-identical so A still passes). A re-fill fetches and SWITCHES, never
  re-creates — the branch's commits are the run's output (DF2.5 harvests them). Repo URL grammar:
  `https://` (or `file://` for offline tests), NO userinfo — a credential-carrying URL is refused
  (INV-CRED-1).
- `src/providers/exedev/setup-gate.ts` — the gate: sentinel cleared BEFORE provisioning (AC6);
  `QDS_TEAM_RUNNER=local` written beside DF2.3's `KEY_ENV_FILE` and verified by content before
  `ready` (AC7); A (HEAD prefix-match + porcelain empty) and B (`command -v pi`, then list-models
  content: non-empty and not "No models available" — INV-3) host-orchestrated; C/D/E as ONE in-box
  script with the roster and env file as ARGUMENTS (AC1). Roster parsed host-side by DF1.5's
  `parseRoster` (closed schema) — a malformed roster is refused before any spend. Failure RETURNS
  `{ready:false, failedItem, assertionCode, assertions[]}` + debug/teardown commands; the VM is
  never destroyed on failure (INV-5); no `process.exit` anywhere. Sequential by design (INV-2): A
  before any paid assertion, gate stops at first failure; `assertions[]` carries exactly the executed
  items. Sub-timings `gate_a_ms…gate_e_ms`, `gate_ms` (Observability Contract).
- `src/providers/exedev/assertions-in-box.sh` — C: real `chat/completions` POST per roster model
  with `provider:{zdr:true,data_collection:"deny"}`, accepts `content` OR `reasoning`. D: a real
  `pi -p --mode json` must report `cost.total > 0` (never the /api/v1/key diff — the wrong
  instrument), and EVERY model in `~/.pi/agent/models.json` must carry all four cost keys with
  non-zero `cost.input` (partial block → "pi drops the WHOLE roster"; zero input → "reports $0.0000
  while spending"). E: `GET /api/v1/key`, remaining COMPUTED as `limit - usage`, `null` limit =
  uncapped = fail (INV-CRED-1); reports the computed remainder, never the key. Missing dependencies
  exit 127 with the dependency NAMED (never a false fail). Exit codes: 0 / C=2 / D=3 / E=4, first
  failure stops.
- `src/providers/index.ts` — `registerDriver("exedev", …)` + named exports; the DF2.1 comment's
  predicted name `exe` corrected to `exedev` (deviation 2).
- Tests: `tests/providers/exedev/driver.test.ts` — DF2.1's `runDriverContract` imported UNMODIFIED
  (the suite's own requirement), registry resolution, AC5 fallback trio, INV-1/INV-2 guards, exec
  serialization round-trip (POSIX quoting), timeout enforcement. `tests/providers/exedev/setup-gate.test.ts`
  — AC1 happy path (five notes, AC7 env line, evidence artifact), AC2 exit-0 trap, AC3 dirty-porcelain
  truncation, AC4 both landmines, AC6 sentinel + uncapped-E, C-dead-model, missing-dependency naming,
  INV-4 leak scan over the seam's entire argv corpus, INV-5 VM-alive + payload commands, roster-as-argument,
  malformed-roster-refused-before-spend, source-fixed code map, and the env-gated live-fire DOD item.
- Fixture `tests/providers/exedev/fixtures/fake-exedev.ts` — a command-seam substrate double: the six
  control-plane shapes in memory, box commands executed FOR REAL on the host in per-box dirs with
  hermetic PATH (`<stubbin>:/usr/bin:/bin` — the dev host's real `pi` must not leak into a "box",
  which is exactly how a $? implementation sneaks green), stub `pi`/`curl` faked by CONTENT (the
  stub prints "No models available" and exits 0), DF2.3's `.env` planted host-side so the key never
  enters the argv corpus the INV-4 scan asserts against.

### Deviations (2)

1. **Evidence artifact path:** `.sandbox/setup-gate/<run-id>.json` (0700/0600) instead of the story's
   `.sandbox/runs/<run-id>-setup.json`. `RunRecordStore.list()` parses EVERY `*.json` in the runs dir
   and THROWS on a non-record file (run-record.ts INV-4) — a sibling artifact bricks `list()`,
   `reapRuns`, and every store consumer. The story's own INV-4 discipline wins over its path text.
2. **Registry name `exedev`**, not the `exe` DF2.1's index.ts comment predicted: this story's Trigger
   Surface gates on "registry resolving `exedev`" and its test/directory names all say exedev. The
   comment (in-scope file) was updated to match.

### Self-review round (pre-PR, adversarial — verdict was FIX-FIRST, all findings addressed)

- **FIXED (HIGH):** fill's URL grammar rejected EVERY production https URL (path after host);
  regex now admits a whitespace-free path, still forbids userinfo. Regression test added.
- **FIXED (HIGH):** a partial in-box script result with a non-zero exit could gate GREEN (killed
  ssh / dropped connection / crashed helper after C's line). The host now distinguishes the
  script's CONTROLLED sequential stop (exit 2/3/4 matching a failed line for exactly that item)
  from everything else — anything else records unproven items as failed, fail-closed. Simulated
  mid-script-death fixture (`truncateScript`) + regression test.
- **FIXED (MED):** assertion A ignored `porcelain.exitCode` — a corrupt index (exit 128, EMPTY
  stdout) read as "porcelain empty". Empty-output-on-failed-command is now "unknown", never
  "clean". Corrupt-index regression test added.
- **FIXED (MED):** DEFAULT_FILL_WORKDIR collided with DF2.3's KEY_ENV_FILE directory (key-then-
  fill breaks clone; fill-then-key false-fails A on `?? .env`). Workdir moved to `/home/agent/src`
  (sibling, not parent). Defaults-collision test added.
- **ACCEPTED (MED, documented):** a local timeout SIGKILL kills only the local ssh — the remote
  script keeps its already-bounded budget. Every paid remote call is individually time-boxed
  in-script (`curl --max-time 30`, pi under `timeout 60` when coreutils present), so abandoned-box
  residual spend is bounded by ≤1 ping per roster model; no kill channel engineered.
- **FIXED (LOW):** gate_a metric outcome now reflects A's result; C/D/E use one honest `gate_cde`
  label; parsed `item` strings validated against the A–E set (unknown items dropped, exit-code
  gate stays closed); the derivation test now actually exercises the DERIVED branch (unrecognized
  new-shape + lsOmitHttps); copyFile test reads the LOCAL artifact; the live-fire scaffold throws
  on half-configured env instead of asserting `true`.

### Review Findings (round 3 — BMAD adversarial review, PR #114)

Three parallel reviewers (Blind Hunter / Edge Case Hunter / Acceptance Auditor); 58 raw
findings triaged to 7 patches + 51 dismissed (speculative size/OOM limits, shell-semantics
misreads, working-as-designed items). Auditor: 0 AC violations, all 7 ACs satisfied.

- [x] [Review][Patch] Whole-gate budget never enforced across provision/A/B — only C/D/E see the deadline (spec: whole gate 300_000 ms) [src/providers/exedev/setup-gate.ts:219-290] — fixed: `budget()` = min(assertTimeout, max(1s, deadline-now)) on every exec; hard stop at B and C/D/E phase boundaries records budget-exhausted failures, no spend past deadline
- [x] [Review][Patch] E's python raises uncaught TypeError on `usage: null` / `data: null` → empty fail note [src/providers/exedev/assertions-in-box.sh:152-165] — fixed: non-dict data → named fail; non-numeric usage (incl. null) → 0; non-numeric limit → named fail; null limit unchanged (uncapped)
- [x] [Review][Patch] `workdir` is the one unvalidated path arg (rosterPath/envFile/sentinelPath all get `assertPathSafe`) and interpolates unquoted into debugCommands [src/providers/exedev/setup-gate.ts:207,400] — fixed: `assertPathSafe("workdir", …)`
- [x] [Review][Patch] `create` tag flows unvalidated into ssh argv → remote command line (injection hygiene at trust boundary) [src/providers/exedev/driver.ts:134-140] — fixed: tag regex `^[A-Za-z0-9][A-Za-z0-9._-]*$`, `tag-invalid` error before any command
- [x] [Review][Patch] `timeoutMs <= 0` unclamped in `sshCommand`; `assertTimeoutMs`/`gateTimeoutMs` accept < 1 [src/providers/exedev/transport.ts:70, src/providers/exedev/setup-gate.ts:208] — fixed: `Math.max(1, …)` clamp + `gate-timeout-invalid` validation
- [x] [Review][Patch] pi fallback has no timeout when coreutils `timeout` absent (macOS hits this branch today) [src/providers/exedev/assertions-in-box.sh:97] — fixed: python3 `subprocess.call(timeout=60)` wrapper (python3 is a checked dep), timeout → exit 124
- [x] [Review][Patch] Empty model list → C passes vacuously ("0/0"); host parser guards, standalone script does not [src/providers/exedev/assertions-in-box.sh:65] — fixed: guard after emit() definition (placement matters — before it, `emit` is undefined → exit 127 loses the note), C fails + exit 2

### Debug Log

- RED→GREEN per module (driver → fill → gate), each cycle observed failing first.
- Caught during RED/GREEN: (a) `'/'.join` inside a single-quoted `python3 -c` — shell ate the inner
  quotes, D failed with an empty scan; fixed with `chr(47)`. (b) The dev host's real `pi` on PATH let
  `piMissing` pass B — fake box PATH is now hermetic. (c) The INV-4 test initially planted the key
  via `driver.exec`, putting the key in the very corpus the scan checks — planting moved host-side.
- Full suite: 1518 pass / 3 fail / 1 todo (live-fire scaffold). The 3 failures are PRE-EXISTING and
  unrelated — proven by `git stash` + isolated re-run on clean main (lean-worker-benchmark AC4 env
  test; roster-check live-gate e2e ×2, network-bound). Not touched by this story.

### Completion Notes

- All ACs implemented and tested except the live-fire DOD item, which is an operator evidence run
  against a real account (env-gated scaffold shipped; see DOD item).
- DF1.4's worktree (feature/df1-4-sqlite-trace-store, PR #113) has zero file overlap; untouched.
- Cross-track contracts honored: assertionCode stays in the payload (DF3.1), `exec`/`copyFile`
  primitives intact for DF2.5, teardown named but never invoked by the gate.

## File List

- src/providers/exedev/driver.ts (new)
- src/providers/exedev/fill.ts (new)
- src/providers/exedev/setup-gate.ts (new)
- src/providers/exedev/assertions-in-box.sh (new)
- src/providers/index.ts (modified — registration, exports, name-comment)
- tests/providers/exedev/driver.test.ts (new)
- tests/providers/exedev/setup-gate.test.ts (new)
- tests/providers/exedev/fixtures/fake-exedev.ts (new)
- _bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-2-exedev-driver-setup-gate.md (this record)

## Change Log

- 2026-08-15: DF2.2 implemented via qds-dev (research 0.95 → TDD driver/fill/gate → suite green,
  gates clean). Story status → review.
- 2026-08-16: BMAD round-3 review (Blind Hunter + Edge Case Hunter + Acceptance Auditor in
  parallel; 58 raw findings triaged → 7 patches, 51 dismissed with rationale, 0 AC violations).
  Fixed: whole-gate budget enforcement, E python null-safety, workdir validation, create tag
  guard, timeout clamps, pi fallback timeout, vacuous-C guard. 7 new regression tests;
  exedev suite 60 pass / 0 fail / 1 todo; tsc + biome clean.
