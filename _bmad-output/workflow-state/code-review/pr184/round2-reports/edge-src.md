# Edge Case Hunter — PR184 round 2, chunk-src (driver.ts / setup-gate.ts / transport.ts / assertions-in-box.sh)

Scope: /tmp/pr184-r2/chunk-src.diff, verified against the checked-out repo at feature/df2.10.
Method: exhaustive branch/boundary walk of the diff's added/changed code. Handled edges verified and discarded silently — the following are the unhandled ones.

Boundary probes that came back HANDLED (not findings): exactly-4096-byte marker (refused, `>=` + `Buffer.byteLength`), 4095 passes to parse; BOM marker (JSON.parse throws → refused fail-closed); duplicated marker keys (last-wins, buildId still compared to pin); nested object in a marker field (typeof check refuses); empty vs whitespace-only auth file (trim → "" → no-colon refusal); CRLF credential (trim strips edges, internal `\r` refused as control char); unicode username (ASCII-only RE refuses); `#` in password (new arm) and `#` in username (user RE); expiry exactly `Date.now()` (refused via `<=`, deliberately); posture file = `null`/array/string (all refused); D-pre exit-3-before-any-C-line (host's controlled-stop check at setup-gate.ts:604-608 matches item D, no C line required).

---

## F1 [MEDIUM] A marker over the 512 KiB transport cap is classified as a transport fault, and the `oversized` arm is unreachable for it

/Users/steve/QDS-Factory/src/providers/exedev/transport.ts:152-161, 311-321, 329-336; /Users/steve/QDS-Factory/src/providers/bounded-exec.ts:42 (cap) and its `kill` seam.

Claim: when the `cat` output breaches `EXEC_MAX_OUTPUT_BYTES`, `readBounded` calls `kill()` (SIGKILL → the ssh exits 137, the value `driver.ts:139` documents as measured) AND sets `truncated: true`. `readBoxFile` checks `read.exitCode !== 0` (transport.ts:153) BEFORE `read.truncated` (transport.ts:159), so the result is `{kind:"unreadable", exitCode:137}` — and the NEW `transportFault` arm (transport.ts:311-321) converts exit 137 into `image-marker-unreachable`: "the box never answered … SIGKILLed at the exec budget … a box/transport fault, NOT evidence about the image", remediation "re-create it; raise the gate budget only if the box is merely slow". The `{kind:"oversized"}` branch (transport.ts:159-161) can now only be reached when the cap is breached yet the process still exits 0 — a race window, not the main path.

Failure scenario: a non-factory or hostile box serves a >512 KiB `/etc/qds-image.json`. Every gate B0 run reports "box never answered — check the network, re-create the box". The operator (or an automated retry) re-creates boxes indefinitely against a condition the module's own doc calls "permanent — callers must not retry it hoping for a different outcome". The box did answer; the verdict is about the marker, not the transport. Fail-closed is preserved, but the machine `code`, the message, and the remediation all point at the wrong subsystem, and the exit-137-from-budget vs exit-137-from-cap-kill cases are indistinguishable to the caller.

## F2 [MEDIUM] The scope arm accepts a PAT record naming broader scopes alongside `read:packages`

/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:399-405.

Claim: the check is `scope.split(/[\s,]+/).includes("read:packages")` — a membership test, not an exclusivity test — while the adjacent comment (and the AC it cites) states "a record naming a broader one is a different deviation than the one INV-IBOX-3 contemplates".

Failure scenario: posture file records `"scope": "repo admin:org read:packages"` (exactly how GitHub renders a multi-scope PAT). The gate passes, the deviation is treated as ratified, and a PAT with write/admin blast radius rides the private-registry path — the specific broader-deviation case the arm's own comment says it exists to refuse. The boundary input `"read:packages"` alone passes (correct); the boundary input with one extra token also passes (uncontemplated).

## F3 [MEDIUM] Both-or-neither image pinning is enforced only on the env pair — the opts merge and direct construction reintroduce the half-pin

/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:1161-1178 (env-only check), 1215-1220 (`...opts` last), 480-494 (constructor applies defaults independently).

Claim: `hasImage !== hasBuildId` inspects only `env.QDS_EXEDEV_IMAGE`/`QDS_EXEDEV_IMAGE_BUILD_ID`. The constructor then defaults each half independently and never checks that a caller-supplied `image` came with a caller-supplied `imageBuildId`. Two unguarded paths produce exactly the "every box passes A and dies at gate B with a marker mismatch that is really a config fault" failure the env check's message describes:
1. `new ExeDevDriver({ image: myRef })` (or `exeDevDriverFromEnv(env, { image: myRef })`, where `...opts` last overrides the env image but leaves the env/default buildId standing) — a custom image paired with `DEFAULT_IMAGE_BUILD_ID`.
2. `exeDevDriverFromEnv(env, { imageBuildId: id })` with both env vars set — env image paired with a foreign buildId.

Failure scenario: a script boots a rebuilt mirror by passing only `image` through opts. Constructor accepts, every created box fails B0 with `image-marker-mismatch` naming the repo pin, and the operator audits the image publish pipeline instead of the one missing option — the precise misdirection the new env-side refusal was added to prevent, still open on the sibling path.

## F4 [MEDIUM] `boot_ready_ms` can report 0 (or a negative number) on a PASSED A — colliding with the 0-means-never-evaluated sentinel

/Users/steve/QDS-Factory/src/providers/exedev/setup-gate.ts:425-427.

Claim: `boot_ready_ms: aOk ? Date.now() - gateStart : 0` uses the non-monotonic wall clock with no floor/clamp:
- An NTP step backwards between `gateStart` (line 356) and the emit yields a NEGATIVE value — a "measured-looking number" the comment promises never to emit — or exactly 0.
- Under the fake substrate (structural fakes resolve execs in microseconds), a genuinely passed A measures `Date.now() - gateStart === 0`, byte-identical to the failed-A sentinel. Any consumer implementing the stated contract ("a field never evaluated reports 0") reads a passed gate's readiness as never-established.

Failure scenario: dashboards/tests keying `boot_ready_ms > 0` as "box became ready" mark fake-substrate and clock-stepped runs as boot failures on green gates; a negative value poisons percentile aggregation.

## F5 [LOW] `boot_ready_ms` is emitted on no line at all when the gate throws before A

/Users/steve/QDS-Factory/src/providers/exedev/setup-gate.ts:354, 379-386, 396-402 (throw paths before the line-425 emit).

Claim: the field's only carrier is the `gate_a` event. `rosterModels` (354), `sentinel-clear-failed` (380-386) and `run-env-write-failed` (396-402) all throw before it, so those runs report neither a measurement nor the contractual 0 — the field is simply absent for the run. The diff freshly introduces the emission and its 0-on-failure rule but only covers A's four failure shapes (head fail / porcelain fail / prefix mismatch / dirty — all correctly folded into the single `aOk` boolean); the pre-A refusal shapes were not enumerated.

Failure scenario: a fleet-wide sentinel-clear regression produces runs with no `boot_ready_ms` key anywhere; an aggregator treating key-absence as "old code version" (the usual reading) misses that readiness was never established.

## F6 [LOW] B0's catch stringifies non-Error rejections as "undefined" and classifies host-side bugs as `image-marker-unreachable`

/Users/steve/QDS-Factory/src/providers/exedev/setup-gate.ts:489-497.

Claim: the catch wraps `imageMarkerFailure(await readBoxFile(...))` — both calls. (a) A non-Error rejection (a fake substrate rejecting with a string, an AbortSignal reason) renders `${(e as Error).message}` as `undefined` in the payload message. (b) A TypeError thrown by `imageMarkerFailure` itself (host-side bug, not transport) is emitted as `image-marker-unreachable` with remediation "confirm the box answers at all, then re-create it" — the operator re-creates healthy boxes to route around a host code fault.

Failure scenario: a future refactor makes `imageMarkerFailure` throw on an unexpected `BoxFileRead` shape; every gate in the fleet reports an unreachable box while `ssh <host> true` succeeds, and the actual stack trace is discarded.

## F7 [LOW] Probe exits outside {137, 255} are read as "this box did not boot a factory image", and the fanout caller ignores the new `probeExit` discriminator entirely

/Users/steve/QDS-Factory/src/providers/exedev/transport.ts:145, 311-313, 322-328; /Users/steve/QDS-Factory/src/fleet/fanout-primitive.ts:743-744.

Claim: `transportFault` maps only 137 and 255. A `test -f` that dies to a remote SIGTERM (exit 143 — box shutting down / systemd reaping mid-gate) or a remote sh failure (126) returns `{kind:"absent", probeExit:143}` → the finding arm blames the image ("did not boot a factory image, INV-IBOX-2") for what is a dying-box condition. Separately, `probeArm` — the second caller the updated `dp:ok` comment vouches for — still treats every `kind:"absent"` as "a clean read that resets the arm's corruption streak" (fanout-primitive.ts:744) without consulting `probeExit`: an ssh-255 probe (box unreachable) resets the corruption streak as if the marker were verified absent, the exact conflation the new fields were added to make distinguishable.

Failure scenario: during a race, a box drops off the network; every tick's probe exits 255, every tick "resets the streak", and the race spins to its ceiling against a dead arm instead of counting it out.

## F8 [LOW] A 0600 non-regular file (FIFO) passes the mode gate and hangs driver construction forever

/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:1188-1196.

Claim: the new pre-read check inspects `statSync(authFile).mode & 0o777` but never `isFile()`. A FIFO created `mkfifo -m 600` passes the mode check; `readFileSync` on a FIFO with no writer blocks indefinitely. There is no timeout on this path, and it runs inside `exeDevDriverFromEnv` — i.e. inside the driver-registry factory — so the entire dispatch process hangs before any typed refusal can be emitted. (A directory is handled: readFileSync throws EISDIR → `registry-auth-unreadable`.)

Failure scenario: `QDS_EXEDEV_REGISTRY_AUTH_FILE` pointed at a pipe (a secrets-injection pattern that works for single-read consumers) with the producer not yet attached — the factory blocks with no log line, no error, no exit.

## F9 [LOW] An empty `$models_json` makes both D-pre and the D scan treat a PRESENT models.json as absent — D passes without ever scanning the cost table

/Users/steve/QDS-Factory/src/providers/exedev/assertions-in-box.sh:118, 125, 237.

Claim: `models_json="$(python3 -c '…expanduser…')"` — if that substitution fails (python3 present for the line-47 dep check but the invocation fails: broken os module, exec resource limit), `set -u` does not catch it and `models_json` is the empty string. `[ ! -f "" ]` is true, so D-pre runs its absence arms (passing when `pi_series` = 0.84), and the line-237 scan check also reads absent, setting `d_scan` to the "custom registry absent — production-legal" pass note. A real `~/.pi/agent/models.json` with zero-cost entries is never opened. The pre-diff code expanded the path inside the same python process that opened it, so this fail-open shape (empty path → tolerated absence) is newly created by hoisting the expansion to a shell variable with no `[ -n "$models_json" ]` guard.

Failure scenario: contrived but fail-OPEN — the one direction every other arm of this gate refuses to fail — on a box whose python3 can print for `emit` but faults on this one invocation; D reports "rates proven by provider usage.cost" while the registry scan silently never ran.

## F10 [LOW] `pi --version` parsing takes the FIRST semver-shaped token in the output — an update banner triggers a fleet-wide UNREVIEWED refusal on a reviewed box

/Users/steve/QDS-Factory/src/providers/exedev/assertions-in-box.sh:123-124, 133-138.

Claim: `pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1` binds to whichever version string appears first on stdout. CLIs routinely prepend "A new version X.Y.Z is available" banners to version output; if pi ever does, `pi_full` becomes the ADVERTISED version, `pi_series` mismatches `PI_REVIEWED_SERIES`, and every missing-models.json box in the fleet exits 3 with "pi series X.Y is UNREVIEWED … PI_VERSION moved" — blaming a PI_VERSION bump that never happened. Fail-closed, but the refusal message asserts a cause ("PI_VERSION moved without re-checking") the evidence contradicts — the same misattribution the adjacent `-z "$pi_full"` arm was explicitly split out to avoid.

Failure scenario: pi 0.84.x adds an update-notice line above its version output; the whole factory refuses at D-pre until someone reads the raw `pi --version` output by hand.

## F11 [LOW] `expiry` is validated with bare `Date.parse` — non-ISO and timezone-less strings are accepted, and the lapse instant becomes host-local

/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:406-413.

Claim: the arm's message demands "ISO-8601", but `Date.parse` accepts far more: `"expiry": "2027-06-01T00:00:00"` (no offset) parses in the HOST's local timezone, so the same posture file lapses up to 14 hours apart on differently-configured hosts; engine-dependent forms (`"Jun 1 2027"`, bare `"2027"`) also pass. The boundary that matters: a record written as local-intent UTC lapses early on a UTC+13 CI host, refusing box creates while the operator's own machine still validates the file — an environment-dependent refusal with no hint in the message that the timezone is the variable.

Failure scenario: ratification recorded `"2026-09-01T08:00:00"` on a UTC-8 workstation passes there at 07:00 but has already lapsed on the UTC CI runner, producing a "has passed" refusal only in CI, on a date the operator can see is in the future.
