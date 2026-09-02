# Blind adversarial review — chunk-unittests-b.diff

Scope: diff only (`tests/providers/exedev/{fixtures/fake-exedev.ts,image-assets.test.ts,setup-gate.test.ts}`). No repository files consulted. Diff-relative locations use the line numbers of `/tmp/pr184-r2/chunk-unittests-b.diff`.

## F1 [MEDIUM] Fake `test -f` on a plain-absent marker now fabricates stderr a real box never produces

**Location:** fake-exedev.ts hunk `@@ -640,14 +662,51 @@`, diff lines 72–75 (with the `sshStderr` helper at 66–71).

**Claim:** Before this change, `imageMarker === null` made the presence probe return `{stdout:"", stderr:"", exitCode:1}` — exactly what a real `test -f /etc/qds-image.json` does for a missing file: exit 1, silent. After the change, exit 1 routes through `sshStderr(1)`, whose fallback arm emits `sh: /etc/qds-image.json: exit 1\n`. So the ordinary FILE-ABSENT path — not any new knob — now carries invented stderr. The same fallback also serves an `imageMarkerCatExit: 1` "unreadable" simulation, where a real box says `cat: /etc/qds-image.json: Permission denied`.

**Failure scenario:** The gate's absent/unreadable arm builds its operator-facing note from the probe's stderr. Tests written against this fake pass while asserting note text (`sh: ...: exit 1`) that no real box can emit; a live box produces an empty-stderr (or `Permission denied`) note that the blessed wording, dashboards, or note-matching regexes were never validated against. The fake's own header comment says a test asserting on the note should read "what an operator would read" — for these two arms it reads fiction.

## F2 [MEDIUM] `sshStderr` invents "Killed\n" for exit 137 — a SIGKILLed process writes nothing to captured stderr

**Location:** fake-exedev.ts diff lines 63–71.

**Claim:** The comment says 137 is "SIGKILLed at the budget (transport.ts's two constants)" and the fake answers with stderr `Killed\n`. A process terminated by SIGKILL produces no output of its own; the string "Killed" is printed by an interactive shell's job control on a terminal, which neither an ssh exec channel nor a killed local subprocess has. Captured stderr for the 137 case is, in reality, empty (or a partial write from before the kill).

**Failure scenario:** The transport-fault arm these knobs exist to reach (per the `imageMarkerProbeExit` doc comment, diff lines 17–29) gets exercised against a stderr that says `Killed`. Any assertion that the transport-fault note quotes or depends on that stderr passes on the fake and is unfalsifiable on real hardware, where the note built from an empty stderr reads differently. The fake was changed specifically to make this arm reachable, and it is reachable only in a shape a real box never presents.

## F3 [MEDIUM] The "NEVER fall through" guard cannot guarantee the promised red — it returns a well-formed failure, not a seam error

**Location:** fake-exedev.ts diff lines 101–111.

**Claim:** The guard's comment says an unsimulated verb touching the marker path "must turn the test red at the seam." But the guard doesn't throw; it returns an ordinary `ExecResult` with `exitCode: 64` and a message in stderr. That result flows straight into the gate's normal failure classification like any other nonzero exit.

**Failure scenario:** The driver drifts to a third verb (e.g., `readBoxFile` switches to `dd`/`head -c` for the capped read). On a failure-path test that only asserts coarse outcomes — `ready === false`, `failedItem === "B"`, `assertionCode` set — exit 64 is absorbed as just another marker-assert failure and the test stays green while exercising a code path the fake never simulated. The host-/etc leak is prevented (good), but the "loud at the seam" property the comment promises depends entirely on how strictly each individual test matches notes; nothing in the mechanism enforces it.

## F4 [MEDIUM] Driver-source regexes in the "cannot silently diverge" test are first-match, unanchored, and comment-blind

**Location:** image-assets.test.ts diff lines 522–545 (patterns at 528–530).

**Claim:** `/QDS_STEERING_ROOT:-([^"}]+)/`, `/install -d -m (\d+)/`, and `/stat -c %a[^)]*\)" = (\d+)/` each `.exec()` the entire `driver.ts` source and take the FIRST match, with no distinction between the provision script string, other code, and comments, and no assertion that the match is unique. The test asserts the regexes match ("fails loudly rather than quietly checking nothing") but that only covers total disappearance, not mis-aim.

**Failure scenario:** The provision script's mode is changed to `install -d -m 750`, while a documentation comment earlier in driver.ts still shows the old example `install -d -m 700`. First match reads the comment, captures `700`, and the divergence test — whose entire purpose is "the drop-in and the driver's provision script cannot silently diverge" — passes green on a driver that now provisions 0750. Symmetrically, a second unrelated `install -d -m` added above the script makes the test fail on a correct driver.

## F5 [MEDIUM] `imageMarkerTruncated` returns the FULL marker with a flag, contradicting its own "a capped capture is a PREFIX" comment

**Location:** fake-exedev.ts diff lines 92–99 (knob doc at 33–34).

**Claim:** The inline comment states "A capped capture is a PREFIX," yet the fake hands back the complete, well-formed `DEFAULT_IMAGE_MARKER` in `stdout` with `truncated: true` bolted on. A real capped read yields a byte-prefix that is not parseable JSON. The fake therefore models a box state that cannot exist: a full valid document flagged as cut short.

**Failure scenario:** A future transport implementation that (defensibly) treats `truncated` as advisory — "try to parse; refuse only if unparseable" — is correct on every real box (the prefix never parses) but turns the fake-driven refusal test red, because on the fake the "truncated" content parses cleanly. The suite then reports a bug that does not exist, and the "fix" pressure runs toward the implementation rather than the fixture. Serving `marker.slice(0, n)` would have made the fake and the comment agree.

## F6 [LOW] Comment added by this same wave miscounts its world: "hand-typed in FOUR places" includes a place this diff just un-hand-typed

**Location:** setup-gate.test.ts diff lines 842–850 (the AC2 binding test comment) vs fake-exedev.ts diff lines 41–55.

**Claim:** The new comment says the pinned pi version "is hand-typed in FOUR places — oci/exedev/Dockerfile (ARG PI_VERSION), scripts/build-exedev-image.ts (export const PI_VERSION), the test fake's marker, and PI_REVIEWED_SERIES in assertions-in-box.sh." The very same diff rewires the fake's marker to IMPORT `PI_VERSION` from the build script (diff line 54), so the fake is no longer a hand-typed copy on the day this comment lands. Note also that of the remaining genuinely hand-typed copies, only the shell constant gets an alarm in this chunk; nothing shown binds the Dockerfile `ARG PI_VERSION`.

**Failure scenario:** The next maintainer bumping the pin follows the comment's inventory, "updates" four places, finds only three, and either wastes time hunting the phantom fourth or — worse — concludes the inventory is unreliable and stops trusting the binding test that actually is the alarm.

## F7 [LOW] The advertised "cross-check that ties the unit to the host side" cannot fail

**Location:** image-assets.test.ts diff lines 475–484 (specifically 480–482).

**Claim:** `expect(EXPECTED_ENV_FILE).toBe(\`/home/${effectiveScalar(UNIT, "Service", "User")}/${KEY_ENV_FILE}\`)` is tautological given the line two above it: `User` was just asserted equal to `BOX_USER`, and `EXPECTED_ENV_FILE` is defined as `/home/${BOX_USER}/${KEY_ENV_FILE}`. Both sides are the same construction; conditional on the earlier assertion, this compares a value with itself. The real unit↔host tie is the `EnvironmentFile` equality on the preceding line.

**Failure scenario:** There is no input under which this assertion fires without an earlier assertion in the same test already having fired. A reader auditing coverage credits a "cross-check" that contributes zero discriminating power, which is precisely the padding this suite's own mutation-table philosophy ("every assertion above can fail") claims to forbid — and this assertion sits outside the mutation table, so its inability to fail is never proven wrong.

## F8 [LOW] The Dockerfile "fourth copy" is a substring check a comment satisfies

**Location:** image-assets.test.ts diff lines 557–561.

**Claim:** The build-time verification of the steering tuple is asserted via `toContain('[ "$(stat -c ...)" = "..." ]')` over the raw Dockerfile text. `toContain` cannot tell a live `RUN` instruction from the same bytes inside a `#` comment or a disabled line.

**Failure scenario:** A refactor comments out the `RUN` carrying the stat-assert (or moves the string into an explanatory comment while deleting the check). The image stops verifying the tuple at build time; the "four copies agree" test still passes because the bytes are present. The one copy that runs against reality is the one this check can lose without noticing.

## F9 [LOW] Round-4's post-stall headroom is exactly ROUND4_REMAINING_MS, and an overrun there masquerades as the floor bug

**Location:** setup-gate.test.ts diff lines 1013–1021 (stall), 1044–1048 (preCdeMs guard), 1057 (the `< 1_000` assertion).

**Claim:** The redesign instruments the PRE-C/D/E side well (`preCdeMs` is measured and asserted `< ROUND4_BUDGET_MS - ROUND4_REMAINING_MS`, so a slow host is named in numbers). But after the stall ends, only ~500 ms of real budget remains before the gate computes the C/D/E remaining; nothing measures or names an overrun in THAT window. Additionally `gateStart` is the test's clock, read before `setup()` — the gate's own start is later, so the actual remaining is `500 ms + δ` with δ unmeasured.

**Failure scenario:** A GC pause or scheduler hiccup of >~500 ms between the ninth seam call returning and the C/D/E launch drives remaining to ≤0; the phase guard refuses, `toContain("C")` fails, and the failure reads as the deadline-floor regression the test exists to catch — with `preCdeMs` reporting an innocent number, pointing the investigation away from the true cause. The test's own comment ("say so in the numbers rather than in a bare toContain") states a standard the post-stall window doesn't meet.
