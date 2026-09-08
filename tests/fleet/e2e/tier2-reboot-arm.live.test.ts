/**
 * AC2b reboot arm — the COMMITTED, re-runnable form of the reboot proof DF1.11
 * measured once from an ephemeral /tmp script (evidence
 * 2026-09-07-15-09--ac2b-reboot-arm.json, then discarded with its box): a box
 * booted from the pinned image recreates /run/steering AFTER A REBOOT with
 * ZERO qds code running, because the image ships a tmpfiles.d drop-in
 * (#180) and the engine unit declares the dependency it never has to
 * enforce at runtime.
 *
 * What only a LIVE reboot can prove (and why each leg reads what it reads):
 *
 *  - THE VERDICT COMES FROM DIR STATE + JOURNAL, NEVER from the tmpfiles
 *    unit's own exit code. Upstream systemd-tmpfiles-setup.service swallows
 *    DATAERR exits from a single bad line: an exit code of 0 proves nothing
 *    about OUR line having run, and a nonzero one proves nothing about it
 *    having failed. The prior round learned this — `stat` of the directory
 *    and `journalctl -b` naming the service Started+Finished THIS boot are
 *    the two facts that cannot lie.
 *  - mtime ≈ boot: /run is tmpfs, wiped by the reboot. A directory that
 *    reappears with mode 700 exedev:exedev and an mtime AFTER the old boot's
 *    read was recreated by this boot's machinery, not left over — nothing on
 *    tmpfs survives to be left over.
 *  - ZERO qds units active: the recreation is the SUBSTRATE's (systemd
 *    tmpfiles at the tmpfiles-setup target), not a qds unit re-provisioning
 *    its own channel. The engine unit's After=/Requires=/AssertPathIsDirectory=
 *    trio is verified declaratively on the box — the ordering that makes a
 *    later engine start WAIT for the directory without any qds code having
 *    run yet.
 *
 * SPEND: one box from the pinned image for minutes (billed as ~a fraction of
 * the box-hour the cap prices), zero model spend — no dispatch, no key, no
 * manifest. Tier 2 because a rebooting box is a full-substrate act (the
 * spend-go authority), not because anything here talks to a model.
 *
 * Closes review round 1's deferral #1 ("committed, re-runnable AC2b harness").
 */
import { expect, test } from "bun:test";

import {
  awaitWithCeiling,
  boxExec,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  liveGate,
  liveTodoOff,
  preflight,
  runIdFor,
  settleRun,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/**
 * The canonical conf bytes, as `cat -A` renders them: `$` marks the line's
 * newline, so matching this string proves the file ends in exactly one
 * newline — a missing trailing newline glues nothing today but is the byte
 * shape every future line appends after, and a CRLF would already be a
 * different file. Mirrors the driver's pinned literal (driver.ts's tmpfiles
 * drop-in writer), restated here so the ON-BOX artifact is asserted against
 * what this test means, not against an import that could drift with the
 * writer it is checking.
 */
// live-mirror: driver.ts's pinned tmpfiles drop-in literal — the exact bytes create's provision script cmp-guards, and the artifact this test reads back on the box
const CANONICAL_CONF_CAT_A = "d /run/steering 0700 exedev exedev$";
/** The tmpfiles drop-in's on-box path (live-mirror: IMAGE_MARKER sibling layout in the pinned image). */
const BOX_CONF = "/etc/tmpfiles.d/qds-steering.conf";
/**
 * Reboot poll: how many × 10 s to wait for the box to come back with a NEW
 * boot_id. The measured round rotated ids within ~10 s of the reboot verb;
 * 30 attempts is several times the healthy margin and BOUNDED, because a
 * poll that never gives up is a paid box that never gets torn down. Each
 * attempt's ssh rides the driver's own 120 s exec ceiling, so the worst case
 * a fired attempt can add is sleep + one refused round trip.
 */
const REBOOT_POLL_ATTEMPTS = 30;
const REBOOT_POLL_WAIT_MS = 10_000;

/** One bounded ssh leg: run, record exit+streams in evidence, return them. */
async function leg(
  driver: Parameters<typeof boxExec>[0],
  vm: string,
  argv: string[],
  evidence: Record<string, unknown>[],
  phase: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const res = await boxExec(driver, vm, argv);
  // TRIMMED here, for the evidence AND the return alike: the live round that
  // shook this file out trimmed only the evidence copy, so the strict
  // `toBe` on the conf bytes compared a trailing-newline-carrying stdout
  // against a canonical literal and red'd on a HEALTHY box (evidence showed
  // canonical, assert saw raw — two spellings of one stream).
  const stdout = res.stdout.trim();
  evidence.push({
    phase,
    exitCode: res.exitCode,
    stdout,
    stderrTail: res.stderr.trim().slice(-300),
  });
  return { exitCode: res.exitCode, stdout, stderr: res.stderr };
}

test.todoIf(liveTodoOff())(
  // live-mirror: steeringRoot() (attach.ts) — the channel root under test in the title's prose
  "AC2b reboot arm: tmpfiles.d recreates /run/steering after reboot, zero qds code running",
  async () => {
    // Tier 2 per the spend protocol: a rebooting real box is a full-substrate
    // act even though nothing here talks to a model. No key is minted and no
    // record is opened, so this file owes no key-hash delta (the
    // tier1-registry-auth precedent: mint nothing, leak nothing).
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const name = runIdFor("ac2b-reboot");
    let outcome = "pass";
    /** The body's own error, held so the post-finally box-absence check runs on the failing path too. */
    let failure: unknown;
    /** Cleanup legs that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    const writeProblems: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    try {
      // ── 1. a box from the PIN, the same driver every dispatch round uses ──
      //    (create provisions the steering channel live — the sudo -n install
      //    the tmpfiles drop-in later stands in for at boot). `awaitWithCeiling`
      //    (P26): the driver's own action timeout bounds the ssh legs, this
      //    bounds the AWAIT — a wedge here is the one abort that skips the
      //    `finally` and leaks a paid box.
      await awaitWithCeiling(ctx.driver.create(name), 240_000, "ac2b box create");
      const listed = await awaitWithCeiling(ctx.driver.list(name), 120_000, "ac2b create-confirm ls");
      expect(listed.map((b) => b.name)).toEqual([name]);
      evidence.push({ phase: "create", ok: true, name });

      // ── 2. the conf bytes, EXACT, before any reboot: `cat -A` so the
      //    trailing newline is part of the assertion (the `$`). ─────────────
      const confPre = await leg(
        ctx.driver,
        name,
        ["sh", "-c", `cat -A ${JSON.stringify(BOX_CONF)}`],
        evidence,
        "conf-pre",
      );
      expect(confPre.exitCode).toBe(0);
      expect(confPre.stdout).toBe(CANONICAL_CONF_CAT_A);

      // ── 3. the directory the boot must recreate, and the boot id it must
      //    recreate it AFTER. mtime as epoch seconds (stat %Y) so the before/
      //    after comparison is arithmetic, not date parsing. ─────────────────
      const dirPre = await leg(
        ctx.driver,
        name,
        // live-mirror: steeringRoot() (attach.ts) — the provisioned channel tmpfs path
        ["sh", "-c", "stat -c '%a %U %G %Y' /run/steering"],
        evidence,
        "dir-pre",
      );
      expect(dirPre.exitCode).toBe(0);
      const mtimePre = Number.parseInt((dirPre.stdout.trim().match(/(\d+)\s*$/) ?? [])[1] ?? "", 10);
      expect(Number.isFinite(mtimePre)).toBe(true); // dp:ok the assert on parse IS the validation — a non-numeric mtime fails right here

      const bootPre = await leg(ctx.driver, name, ["cat", "/proc/sys/kernel/random/boot_id"], evidence, "boot-id-pre");
      expect(bootPre.exitCode).toBe(0);
      const bootIdPre = bootPre.stdout.trim();
      expect(bootIdPre).toMatch(/^[0-9a-f-]{36}$/);

      // ── 4. the engine unit's DECLARATIVE half, read on the box: After= and
      //    Requires= bind the engine's start to tmpfiles-setup having run,
      //    AssertPathIsDirectory= refuses to start without the directory.
      //    This is the "zero qds code" arm's complement: the dependency is
      //    declared in the unit FILE, not enforced by a running process. ────
      const unit = await leg(
        ctx.driver,
        name,
        // live-mirror: the image's engine unit (oci/exedev/systemd/qds-run@.service) — the DF1.10 declarative trio
        ["sh", "-c", "grep -n -E '^(After|Requires|AssertPathIsDirectory)=' /etc/systemd/system/qds-run@.service"],
        evidence,
        "engine-unit-declarative",
      );
      expect(unit.exitCode).toBe(0);
      expect(unit.stdout).toContain("After=systemd-tmpfiles-setup.service");
      expect(unit.stdout).toContain("Requires=systemd-tmpfiles-setup.service");
      // live-mirror: steeringRoot() (attach.ts) — the AssertPath targets the provisioned channel root
      expect(unit.stdout).toContain("AssertPathIsDirectory=/run/steering");

      // ── 5. THE REBOOT. `sudo -n systemctl reboot` returns 0 when the
      //    substrate honors it; 255 is the ssh connection dropping mid-reboot
      //    and is just as good an initiation — the POLL below is the
      //    verification, never this exit code. Any OTHER exit is a real
      //    refusal (sudo scope, systemd) and fails the arm honestly. ─────────
      const reboot = await leg(ctx.driver, name, ["sudo", "-n", "systemctl", "reboot"], evidence, "reboot-verb");
      expect([0, 255]).toContain(reboot.exitCode);

      // ── 6. bounded wait for: box answers ssh again AND boot_id rotated.
      //    A refused ssh is a retry (exit 255, empty stdout), never a verdict.
      let bootIdPost = "";
      const pollStartedAt = Date.now();
      for (let attempt = 1; attempt <= REBOOT_POLL_ATTEMPTS; attempt += 1) {
        const read = await ctx.driver.exec(name, ["cat", "/proc/sys/kernel/random/boot_id"]);
        const id = read.exitCode === 0 ? read.stdout.trim() : "";
        if (id !== "" && id !== bootIdPre) {
          bootIdPost = id;
          break;
        }
        if (attempt < REBOOT_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, REBOOT_POLL_WAIT_MS));
      }
      evidence.push({
        phase: "reboot-poll",
        rotated: bootIdPost !== "",
        waitedMs: Date.now() - pollStartedAt,
        attempts: REBOOT_POLL_ATTEMPTS,
      });
      expect(bootIdPost).toMatch(/^[0-9a-f-]{36}$/);
      expect(bootIdPost).not.toBe(bootIdPre);

      // ── 7. THE RECREATION, judged from dir state (never a unit exit code):
      //    /run is tmpfs — nothing survives — so a directory that answers
      //    stat with 700 exedev exedev was made by THIS boot, and its mtime
      //    post-dates the pre-reboot read. ───────────────────────────────────
      const dirPost = await leg(
        ctx.driver,
        name,
        // live-mirror: steeringRoot() (attach.ts) — the provisioned channel tmpfs path
        ["sh", "-c", "stat -c '%a %U %G %Y' /run/steering"],
        evidence,
        "dir-post",
      );
      expect(dirPost.exitCode).toBe(0);
      expect(dirPost.stdout.trim()).toMatch(/^700 exedev exedev \d+$/);
      const mtimePost = Number.parseInt((dirPost.stdout.trim().match(/(\d+)\s*$/) ?? [])[1] ?? "", 10);
      expect(mtimePost).toBeGreaterThan(mtimePre);

      // The conf itself is unchanged by the reboot (it is on disk, not tmpfs)
      // — asserted again so the recreation cannot be credited to a DIFFERENT
      // rule than the one this test read before the reboot.
      const confPost = await leg(
        ctx.driver,
        name,
        ["sh", "-c", `cat -A ${JSON.stringify(BOX_CONF)}`],
        evidence,
        "conf-post",
      );
      expect(confPost.exitCode).toBe(0);
      expect(confPost.stdout).toBe(CANONICAL_CONF_CAT_A);

      // ── 8. the journal names the recreator, THIS boot (`-b`): Started AND
      //    Finished. This plus the dir state above is the whole verdict. ─────
      const journal = await leg(
        ctx.driver,
        name,
        ["sh", "-c", "journalctl -b -u systemd-tmpfiles-setup.service --no-pager --no-hostname -o cat"],
        evidence,
        "tmpfiles-journal-this-boot",
      );
      expect(journal.exitCode).toBe(0);
      expect(journal.stdout).toContain("Starting systemd-tmpfiles-setup.service");
      expect(journal.stdout).toContain("Finished systemd-tmpfiles-setup.service");

      // ── 9. ZERO qds code ran: no qds unit in any state, and the engine unit
      //    template never instantiated. `list-units --all 'qds-*'` printing
      //    nothing is the claim; wc -l renders it countable in evidence. ────
      const qdsUnits = await leg(
        ctx.driver,
        name,
        ["sh", "-c", "systemctl list-units --all --no-legend --no-pager 'qds-*' | wc -l"],
        evidence,
        "no-qds-units",
      );
      expect(qdsUnits.exitCode).toBe(0);
      expect(qdsUnits.stdout.trim()).toBe("0");

      evidence.push({
        phase: "verdict",
        ok: true,
        // live-mirror: steeringRoot() (attach.ts) — the channel root, named in the verdict's prose
        note: "/run/steering recreated at boot by systemd-tmpfiles (dir state + this-boot journal); zero qds units ran; engine dependency verified declaratively",
      });

      // ── round hygiene: no other e2e-/qds- box lingers (this run's box is
      //    destroyed in the finally and is excluded by name). ────────────────
      const finalLs = await ctx.driver.list();
      evidence.push({ phase: "final-ls", boxes: finalLs.map((b) => b.name), ownBox: name });
      expect(finalLs.filter((b) => /^(e2e|qds)-/.test(b.name) && b.name !== name).map((b) => b.name)).toEqual([]);
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      if (name !== "") {
        // The verdict was READ (#189): a destroy that failed and was only
        // recorded shipped a green test on a box still billing.
        const destroyed = await destroyQuietly(ctx.driver, name, evidence);
        if (!destroyed.ok) destroyFailures.push(`${name}: ${destroyed.error}`);
      }
      // The absolute e2e-|qds- backstop at cleanup time: bounded-retry against
      // the measured destroy lag, a destroy of what this run owns before the
      // verdict is rendered, another round's stray demoted to a warning.
      finalBoxes = (await fleetLeftovers(ctx.driver, [name], evidence)).owned;
      writeEvidenceQuietly("AC2b", "ac2b-reboot-arm", { test: "AC2b", outcome, name, phases: evidence }, writeProblems);
    }

    // The box this run owned must be GENUINELY gone, checked on EVERY path.
    settleRun(failure, fleetCleanupProblems(destroyFailures, finalBoxes, evidence));
  },
  // Budget audit (the tier2 shape), priced at DECLARED CEILINGS, not typical
  // latency. A bun test-timeout abort is the ONE path where `finally` does
  // not execute, so it is the one path where the box created in the body is
  // never destroyed and keeps billing.
  //
  //   preflight whoami    1 ssh control at DEFAULT_EXEC_TIMEOUT_MS 120   120 s
  //   create              control-plane new + steering provision          240 s
  //   create-confirm ls   1 control ls at 120                            120 s
  //   conf/dir/boot/unit  4 driver.exec legs at 120                      480 s
  //   reboot verb         1 driver.exec at 120                            120 s
  //   reboot poll         30 × (10 s sleep + exec ≤120)                 3 900 s
  //   post legs           dir/conf/journal/units 4 × 120                 480 s
  //   round-hygiene ls    1 control ls at 120                            120 s
  //   local writes        evidence                                      10 s
  //                                                             body ────────
  //                                                                   5 590 s
  //   destroyQuietly      CODE-WORST: 2 rm + 3 confirming list at 120    600 s
  //   fleetLeftovers      5 × (control ls 120 + 8 s wait) + destroy pass  360 s
  //   evidence            local                                        10 s
  //                                                           finally ────────
  //                                                                     970 s
  //                                                                   ────────
  //                                                                   6 560 s
  //
  // Hence 7 200 s (margin over the 6 560 s serial worst case; the reboot
  // poll is the dominant leg and every attempt is individually bounded).
  // Every inner ceiling FIRING is safe — it rejects into the catch and the
  // `finally` still runs — so the fail-safe direction for this number is UP.
  7_200_000,
);
