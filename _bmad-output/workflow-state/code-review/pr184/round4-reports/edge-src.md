# edge-src

## [HIGH] The new `null` transport skip is never counted, so the streak limit still cannot bound a dead arm — the exact failure the change's own comment claims to fix

- **File:line:** `src/fleet/fanout-primitive.ts:756-758` (the new arm) and `src/fleet/fanout-primitive.ts:680-704` (the consumer that ignores it)
- **Trigger:** an arm whose box is permanently unreachable — `ssh` never connects, so the `test -f` probe exits 255 on every tick (or the per-call budget SIGKILLs it, 137). `probeArm` now returns `null` on every tick forever. `runRace` increments `unusableTicks` **only** for `verdict === "unusable"`; `null` falls straight through to `if (verdict !== null) return verdict;` and `continue`s. The arm is never counted, never reaches `MARKER_UNUSABLE_TICKS_LIMIT`, stays in `undecided()`, and the race polls to the full `ceilingMs` (`DEFAULT_FANOUT_CEILING_MS`) with the fleet lock held.
- **Evidence:**
  ```
  // ...so a dead arm could never reach
  // MARKER_UNUSABLE_TICKS_LIMIT and the race spun to its full ceiling with
  // the fleet lock held — the exact failure the streak limit exists to bound.
  if (res.probeExit === undefined || res.probeExit === 1) return "absent";
  skipTick("race-probe-failed", ...);
  return null; // a transport skip: no evidence either way, so it must not reset the streak
  ```
  against `runRace`:
  ```
  if (verdict === "unusable") {
    const ticks = (unusableTicks.get(arm) ?? 0) + 1;
    ...
  }
  if (verdict === "absent") { unusableTicks.delete(arm); continue; }
  if (verdict !== null) return verdict;
  ```
- **Confirmed by:** read `runRace` (`fanout-primitive.ts:660-715`) in full — `unusableTicks` is written in exactly two places, `+1` under `verdict === "unusable"` and `.delete` under `verdict === "absent"`; `null` touches neither. I also confirmed the pre-change behaviour (`"absent"` → `.delete`) also spun to the ceiling, so this is an *unfixed* case rather than a regression — but the change is documented as fixing precisely it. What the change *does* fix is a mixed pattern (corrupt-marker ticks interleaved with transport-failed probes no longer reset the streak); a purely transport-dead arm is still unbounded by the streak. A `"unusable"`-style tick for probe transport failures, or a separate skip counter, is what the stated goal needs.

## [MEDIUM] `expanduser` returning the path UNEXPANDED defeats the new fail-closed path guard — a present registry is read as tolerated absence

- **File:line:** `src/providers/exedev/assertions-in-box.sh:118` (derivation), `:124-126` (the guard), `:149` and `:267` (the two `[ ! -f "$models_json" ]` reads)
- **Trigger:** `HOME` unset in the exec environment **and** the uid has no `/etc/passwd` entry (a systemd exec context, or a box whose passwd mapping broke). `os.path.expanduser` is documented to return the path **unchanged** when expansion fails, so it prints the literal `~/.pi/agent/models.json`. That is a non-empty string, so the new guard passes; then `[ ! -f "~/.pi/agent/models.json" ]` tests a literal-tilde relative path that never exists, is true, and D takes the "custom registry absent — production-legal" tolerance on a box whose registry is actually present and possibly unpriced.
- **Evidence:**
  ```sh
  models_json="$(python3 -c 'import os; print(os.path.expanduser("~/.pi/agent/models.json"))')"
  # FAIL CLOSED on a failed path derivation: if that substitution died ...
  # models_json is empty, and `[ ! -f "" ]` is true — so BOTH the D-pre arms
  # and D's scan would read a PRESENT registry as tolerated absence. That is
  # the one fail-OPEN shape in a gate whose every other arm refuses ...
  if [ -z "$models_json" ]; then
  ```
- **Confirmed by:** the guard tests emptiness only. There is no upstream guard: the script's dependency preamble (`assertions-in-box.sh:44-52`) checks `command -v` for `curl python3 pi` and the env-file mode, and never asserts `HOME` or that the derived path is absolute. `case "$models_json" in /*) ;; *) refuse ;; esac` closes it.

## [MEDIUM] A D-pre refusal exits 3 before C ever runs, so the gate reports `assertionCode: 3` with **no C assertion in `assertions[]` at all**

- **File:line:** `src/providers/exedev/assertions-in-box.sh:125`, `:155`, `:164` (the three `emit D 0` … `exit 3` arms hoisted above C), consumed at `src/providers/exedev/setup-gate.ts:620-630`
- **Trigger:** bump `PI_VERSION` to `0.85.x` without moving `PI_REVIEWED_SERIES`, on any box where `models.json` is absent (i.e. every current factory box). The script emits exactly one line, `{"item":"D","ok":false,…}`, and exits 3.
- **Evidence:** host side —
  ```ts
  const code = res.exitCode as 2 | 3 | 4;
  const controlled =
    (code === 2 || code === 3 || code === 4) &&
    results.some((r) => !r.ok && r.item === ({ 2: "C", 3: "D", 4: "E" } as const)[code]);
  if (controlled) { assertions.push(...results); }
  ```
  `controlled` is true, so only the D line is pushed. `firstFail` is D → `failedItem: "D"`, `assertionCode: 3`, which dispatch reads as the cost-table failure. C — the live per-model ping, the assertion whose absence is the whole point of hoisting this check — is recorded neither as failed nor as skipped; the evidence artifact simply has no C row, indistinguishable from a gate that was never asked to run it.
- **Confirmed by:** read `setup-gate.ts:601-659`. The `controlled` branch's own comment ("the remaining items simply never ran and are not fabricated") is written on the premise that D can only fail *after* C — the script header at `assertions-in-box.sh:14-17` states the same contract ("first failure stops the gate"). The D-pre hoist breaks that premise, and neither the `cdeComplete` predicate nor the fail-closed `missing` fabricator runs on the `controlled` path.

## [MEDIUM] The AC6 `QDS_*` sweep claims to cover "the complete set" of surfaces but omits every systemd environment surface except the unit file itself

- **File:line:** `oci/exedev/Dockerfile:313-323`
- **Trigger:** a later story (DF1.10 adds the `ExecStart`) drops `/etc/systemd/system/qds-run@.service.d/10-engine.conf` containing `Environment=QDS_RUN_ROOT=/run/qds` — the drop-in reaches the very unit this image ships, `systemctl show qds-run@x` reports the variable, and this RUN greps only the literal `/etc/systemd/system/qds-run@.service`. Same for `DefaultEnvironment=` in `/etc/systemd/system.conf` or `/etc/systemd/system.conf.d/*.conf`, which reaches **every** unit on the box.
- **Evidence:**
  ```dockerfile
  # The four surfaces checked are the complete set of ways a QDS_* variable
  # reaches a booted box from this image: the image environment, the unit, the
  # tmpfiles entry, and the login/session env files.
  ...
  && { ! grep -vE '^[[:space:]]*#' /etc/systemd/system/qds-run@.service | grep -qE 'QDS_[A-Za-z0-9_]*' ...
  && { ! grep -rqE '^[[:space:]]*(export[[:space:]]+)?QDS_' /etc/environment /etc/profile.d/ 2>/dev/null ...
  ```
- **Confirmed by:** the shipped unit (`oci/exedev/systemd/qds-run@.service:33-40`) states the prohibition and points at this build-time assertion as its enforcement ("The Dockerfile asserts this file's freedom from QDS_* at build time") — so the drop-in path has no second guard anywhere. A recursive grep over `/etc/systemd/` rather than the one unit path closes it, and costs the same line.

## [LOW] The credential file is opened, fstat'd, mode-checked and read even when `opts.registryAuth` is about to discard it

- **File:line:** `src/providers/exedev/driver.ts:1262-1305` versus `src/providers/exedev/driver.ts:1337`
- **Trigger:** `QDS_EXEDEV_REGISTRY_AUTH_FILE=/some/0644/file` present in the environment while a caller does `exeDevDriverFromEnv(env, { registryAuth: "u:p" })`. The factory throws `registry-auth-file-mode` naming a file whose contents it was never going to use. It also loads that operator's credential into the process for no reason.
- **Evidence:** `...opts` is spread **last** ("an explicit caller argument beats the environment"), yet the `authFile` block is gated only on `authFile !== undefined && authFile.length > 0` — it does not consult `opts.registryAuth`.
- **Confirmed by:** the sibling image pin in the same function *does* handle this asymmetry explicitly, computing `hasEffectiveImage = opts.image !== undefined || hasImage` before refusing (`driver.ts:1243-1252`); `registryAuth` got no equivalent. Production impact is small — `registerDriver("exedev", () => exeDevDriverFromEnv())` (`src/providers/index.ts:138`) passes no opts, so this is reachable only from scripts/tests that do.

## [LOW] No size bound on the credential file read — `fstatSync`'s `stat.size` is already in hand and unused

- **File:line:** `src/providers/exedev/driver.ts:1274` (fstat) and `src/providers/exedev/driver.ts:1305` (read)
- **Trigger:** an operator mispoints `QDS_EXEDEV_REGISTRY_AUTH_FILE` at a large regular file they own at 0600 — a shell history, a heap dump, a `.env` backup. `isFile()`, mode and uid all pass, and the whole file is slurped into a UTF-8 string before `assertRegistryAuth` rejects it on the `secret.length > 512` arm. The 512-byte ceiling the code already believes in is enforced only *after* the bytes are in memory.
- **Evidence:**
  ```ts
  const stat = fstatSync(fd);
  if (!stat.isFile()) { ... }
  const mode = stat.mode & 0o777;
  ...
  raw = readFileSync(fd, "utf8");
  ```
  `stat.size` is never read.
- **Confirmed by:** `assertRegistryAuth` (`driver.ts`, the `secret.length > 512` refusal) is the only size bound in the path, and it runs in the constructor — after `readFileSync`. No caller of `exeDevDriverFromEnv` pre-validates the path; `src/providers/index.ts:138` passes the raw environment straight through.
