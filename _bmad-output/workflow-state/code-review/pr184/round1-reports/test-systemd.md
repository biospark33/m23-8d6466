# test-systemd — DF2.10 AC6 systemd asset policy

**File (mine, new, only one touched):** `/Users/steve/QDS-Factory/tests/providers/exedev/image-assets.test.ts`
No edits to `oci/exedev/**`, `src/`, `scripts/`, `.github/`, or any other test. No commits, no `git add`. No docker.

## The finding this closes

AC6's stated negative control had no test. `grep -rn "qds-run@" tests/ scripts/ src/` returned nothing before this
file. The Dockerfile's build-time `systemd-analyze verify` proves the unit LOADS and is silent —
`Restart=on-failure`, `%h/app/.env` and `User=root` all pass it cleanly. The AC6 scan greps only for `QDS_`. The
unit's bytes feed `deriveBuildId`, but a policy edit is inert until a rebuild + republish, and the pin gate compares
against whatever the operator pastes in. So the one directive whose wrong value causes double-spend and
double-commit was guarded by review alone.

## Method

A real unit parser, not a substring scan. `logicalLines()` folds `\`-continuations FIRST and decides comment-ness by
where the logical line STARTED (so a comment ending in `\` cannot swallow the directive under it); `parseUnit()`
returns an ORDERED, section-qualified directive list, keeping duplicates. `effectiveScalar()` implements systemd's
last-wins; `effectiveList()` implements accumulation with empty-value RESET. Unparseable lines and directives before
the first `[Section]` are recorded and asserted empty rather than silently dropped.

Assertions are written as seven `Policy` objects with a `violations()` function, so the same code that guards the
shipped file is the code the mutation table drives.

## What is asserted

**`oci/exedev/systemd/qds-run@.service`** (7 policies + 6 direct tests)
- `restart-no` — effective `Restart` is the string `no`, AND no `Restart=` anywhere in any section has another value.
- `user-exedev` — effective `[Service] User=exedev`. (`Type=simple` pinned alongside.)
- `after-tmpfiles` — the accumulated `[Unit] After=` list contains `systemd-tmpfiles-setup.service`.
- `envfile-literal` — `EnvironmentFile=` is EXACTLY one value and it is exactly `/home/exedev/app/.env`.
  Cross-checked against `KEY_ENV_FILE` (`src/providers/credentials.ts:59`, `app/.env`): the expected path is built as
  `/home/${User}/${KEY_ENV_FILE}`, so a change on EITHER side breaks the test.
- `no-home-specifier` — no `%h` in any DIRECTIVE. Scope is deliberate: the shipped file DOES contain `%h`, in the
  comment explaining why it must not be a directive, and the test asserts that (`expect(UNIT_TEXT).toContain("%h")`)
  so nobody "fixes" a raw-text check by deleting the comment. `%i` in `Description=` is untouched.
- `no-qds-var` — no `QDS_` in any directive of either asset; no `Environment=` at all.
- `directive-set` — the exact directive keys per section, in file order: Unit `[Description, After]`, Service
  `[Type, User, Restart, EnvironmentFile]`, Install `[WantedBy]`. This IS the "no ExecStart" contract; DF1.10's one
  added line becomes a deliberate, visible failure. The contract sentence
  `ExecStart=/usr/local/bin/qds-engine run %i` is asserted present in the unit's comments so the next author has
  something to implement against.

**`oci/exedev/systemd/qds-steering.conf`**
- Parses to exactly one entry, exactly `["d", "/run/steering", "0700", "exedev", "exedev"]` (5 fields, asserted
  before any field is read).
- All four copies of the tuple tied together: (1) the drop-in; (2) `driver.ts`'s `STEERING_PROVISION_SCRIPT` — it is
  module-private, so the source text is regex-read for `QDS_STEERING_ROOT:-<path>`, `install -d -m <mode>` and
  `stat -c %a … = <mode>`, and each regex is asserted to MATCH first so a rewrite fails loudly instead of quietly
  checking nothing; (3) `steeringRoot()` from `src/fleet/attach.ts`, called with `QDS_STEERING_ROOT` deleted and
  restored so a stray env var from a concurrent suite cannot decide it; (4) the Dockerfile's literal
  `[ "$(stat -c '%a %U %G' /run/steering)" = "700 exedev exedev" ]`. Mode normalised `0700` ↔ `700`. The drop-in's
  owner is tied to the unit's `User=` via the shared `BOX_USER` constant.

**The `QDS_*` invariant (DF1.11 INV-IBOX-13 / DF3.7 AC4)** — no `Environment=`, no `QDS_` in any directive of either
asset, the sole `EnvironmentFile` is the credential path, and that path itself carries no `QDS_`.

**Deferred Dockerfile finding — recorded as a long comment + a guard test.** The Dockerfile claims "the four surfaces
checked are the complete set of ways a `QDS_*` variable reaches a booted box from this image". It is not complete:
(1) `DefaultEnvironment=` in `/etc/systemd/system.conf` (or `/etc/systemd/system.conf.d/`) is handed by PID 1 to
every unit including `qds-run@`; (2) unit drop-ins `/etc/systemd/system/qds-run@.service.d/*.conf` merge into the
unit at load and can carry `Environment=QDS_RUN_ROOT=…` — the build greps only the unit FILE. Widening the greps is
deferred ON PURPOSE: any Dockerfile edit moves `deriveBuildId` → moves the digest → invalidates the pin that was
live-booted in this PR's e2e round. DF1.10 adds the engine build stage and re-pins; that is the moment. The test
guards the HOLE, not the scan: the Dockerfile contains no `DefaultEnvironment=`, no `system.conf`/`system.conf.d`
reference and no `.service.d` install, and `oci/exedev/systemd/` holds exactly the two asserted files. It
deliberately does NOT assert the greps stay narrow — widening them must never break a test.

## Negative-control evidence

15-row mutation table over an in-memory COPY of the unit text; each row names the policies that MUST reject it, and
the test asserts the failing set EQUALS that list (so over-rejection fails too). A second test asserts every mutation
actually changed the text.

| mutation | rejected by |
|---|---|
| `Restart=no` → `Restart=on-failure` (the AC's named control) | restart-no |
| a LATER `Restart=on-failure` before `[Install]` — **the one `content.includes("Restart=no")` passes**; last-wins makes it live | restart-no, directive-set |
| `Restart=\` + newline + `always` (continuation hides the value from a line grep) | restart-no |
| `# Restart=no` — policy gone, bytes still say it | restart-no, directive-set |
| `Restart=no` demoted into `[Unit]` | restart-no, directive-set |
| `User=root` | user-exedev |
| `EnvironmentFile=%h/app/.env` (the `%h` trap: `/root` in a system unit) | envfile-literal, no-home-specifier |
| `app/.env` → `app/env` (drift from `KEY_ENV_FILE`) | envfile-literal |
| a SECOND `EnvironmentFile=-/etc/qds/extra.env` | envfile-literal, directive-set |
| `After=` → `network-online.target` | after-tmpfiles |
| empty `After=` after the real one (systemd RESETS the list) | after-tmpfiles, directive-set |
| `Environment=QDS_RUN_ROOT=/srv/qds/runs` | no-qds-var, directive-set |
| an early `ExecStart=` | directive-set |
| **ACCEPTED** a `#` comment naming `Restart=on-failure` and `%h/app/.env` | (none) |
| **ACCEPTED** `;`-comments and blank lines | (none) |

Plus a tmpfiles negative set: mode `0755`, `root root` owner, path `/run/qds-steering`, a second entry — all
rejected; a file with a comment + blank line + the real entry is accepted.

**Empirically demonstrated, not just asserted.** I temporarily flipped row 1's `rejectedBy` from `["restart-no"]` to
`[]`, ran the suite, and it FAILED with `Expected []` / `Received ["restart-no"]` on
`negative controls: each assertion rejects the wrong file`; then reverted. So `restart-no` demonstrably rejects
`Restart=on-failure`, and the table is discriminating rather than vacuous.

## Deliberately NOT asserted

- **File modes / ownership of the assets.** `COPY --chmod=0644` in the Dockerfile owns that; a repo-side mode
  assertion would test git's index, not the image.
- **That the Dockerfile's AC6 greps stay narrow.** Asserting the bug persists would make DF1.10's correct widening
  break a test. The comment carries the deferral instead.
- **`systemd-analyze verify` semantics.** That is the Dockerfile's build-time check and needs systemd; this suite is
  no-docker by design and asserts POLICY, which is the axis `verify` is blind to.
- **`WantedBy=multi-user.target` as a standalone claim.** It is covered by `directive-set`; DF2.10 enables nothing,
  so the value is not load-bearing on its own.
- **Anything about a running box.** No `systemctl`, no boot, no e2e — that is the live round's job.
- **Drop-in / `system.conf` contents on a real box.** Cannot be observed without docker; the repo-side guard above is
  the cheap proxy.

## Gate output

```
bun test tests/providers/exedev/image-assets.test.ts   → exit=0   14 pass, 0 fail, 78 expect() calls
bunx tsc --noEmit                                      → exit=0   (clean)
bunx @biomejs/biome check tests                        → exit=0   Checked 164 files, no fixes applied
```
Log-reading used the `tr`/`perl` de-CR/de-ANSI pipeline, not a raw grep.

Two `tsc` errors were found and fixed during the round, both in my file and both mine:
`expect(<string>).toBe(<string | undefined>)` under `noUncheckedIndexedAccess` — resolved by asserting the tmpfiles
entry has 5 fields and destructuring with `= ""` defaults, which also closed a real hole (a short entry would
otherwise have compared `undefined` to `undefined` and passed).
