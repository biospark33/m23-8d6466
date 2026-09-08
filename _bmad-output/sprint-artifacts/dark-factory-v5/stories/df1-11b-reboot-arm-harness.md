# DF1.11b — Committed AC2b Reboot-Arm Harness

Follow-up to `df1-11-in-box-steering-executor.md`. Closes that story's review
round 1 deferral #1: the AC2b proof (tmpfiles.d recreates `/run/steering`
after a reboot with zero qds code running) was measured once by an ephemeral
`/tmp/df111-ac2b.ts` that died with its shell — evidence JSON committed, the
means to re-run it not. This story commits the means.

## Story

As the QDS factory, I need the AC2b reboot arm re-runnable on demand, so that
any future change to the pinned image's tmpfiles drop-in, the engine unit's
`After=`/`Requires=`/`AssertPathIsDirectory=` trio, or the steering channel
layout can be re-proven on the real substrate without re-deriving the harness
from the round-1 transcript.

## Acceptance Criteria

**AC1 — the harness proves AC2b on demand.** A committed live test
(`tests/fleet/e2e/tier2-reboot-arm.live.test.ts`, gated `liveGate("2")` +
`preflight("2")`) provisions a pinned-image box, asserts the conf bytes exact
(`d /run/steering 0700 exedev exedev` + trailing newline, via `cat -A`),
captures `boot_id`, reboots with `sudo -n systemctl reboot`, waits bounded,
and asserts: new `boot_id`; `/run/steering` exists again `700 exedev exedev`
with mtime post-dating the pre-reboot read; `systemd-tmpfiles-setup.service`
Started+Finished THIS boot (journal); zero qds units in any state. The verdict
is read from dir state + journal, NEVER the tmpfiles unit's exit code (upstream
swallows DATAERR — round 1's Track A). Teardown + hygiene asserts run on every
path (`destroyQuietly` verdict read, `fleetLeftovers`, `settleRun`); every
awaited leg sits under a ceiling.

## Definition of Done

- [ ] Live-green evidence JSON under `_bmad-output/evidence/df3-e2e/`
      (`*-ac2b-reboot-arm.json`), outcome pass, image stamp = the repo pin.
- [ ] Hygiene: zero `e2e-*`/`qds-*` boxes survive, no lock, no key minted
      (nothing to revoke).
- [ ] df1-11 story's "Filed, not fixed here" pointer updated to this harness.
- [ ] `tsc --noEmit` + `biome check` clean; gated-off load check green.

## Dev Agent Record

Spend: one box from the pinned image for minutes of a box-hour; zero model
spend (no dispatch, no key, no manifest). Tier 2 because a rebooting box is a
full-substrate act, per the spend-go protocol — authorized under the
round's single spend-go (worst ≈ $1: two confirmation rounds + one reboot
box-hour).
