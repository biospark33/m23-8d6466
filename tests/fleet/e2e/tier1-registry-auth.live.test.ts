/**
 * DF2.10 AC4 — the private-registry path, proven on a REAL exe.dev box.
 *
 * Until this file, `--registry-auth` had never once reached real exe.dev
 * (`registry-auth` appeared zero times in the live evidence); the entire AC4
 * arm — credential load from a 0600 file, the INV-IBOX-3 ratification gate,
 * the flag reaching a real `ssh exe.dev new`, a real authenticated pull —
 * was proven only against a fixture whose `new` grammar encodes the same
 * assumptions the driver does. This is the live half.
 *
 * TIER-1 by the only authority that counts (`liveGate("1")`): boxes only,
 * ZERO model spend — no key is minted, no gate C/D/E runs. Cost = box-minutes.
 *
 * Substrate prerequisite (operator-provisioned, out of band):
 *  - `ghcr.io/biospark33/qds-exedev-private` holds the SAME bytes as the
 *    public pin — mirrored by digest, so the digest and therefore the baked
 *    marker and buildId are IDENTICAL to `DEFAULT_IMAGE_REF`'s. The private
 *    ref below derives its digest from the pin, so a DF1.10 re-pin makes this
 *    test fail loudly ("manifest unknown") until the mirror is re-pushed —
 *    the fail-closed direction.
 *  - QDS_E2E_REGISTRY_AUTH_FILE names a 0600 file `biospark33:<PAT>` where
 *    the PAT is fine-grained/classic with read:packages ONLY (the ratified
 *    scope — the deviation gate refuses a record naming anything broader,
 *    and the recorded scope must be the credential's real blast radius for
 *    the audit trail to mean anything).
 *
 * The ratification record: written here to a 0600 tmp file, because the
 * ratification ACT is the operator's — the 2026-09-01 live-round
 * authorization ("Full round incl. AC4") ratified this deviation for this
 * round, and the record's rotationOwner names that operator. The credential
 * value itself is never read by this test: the factory loads it, the
 * driver's redaction owns it, and the evidence carries only paths and
 * booleans.
 *
 * Structure — negative control FIRST, and it is load-bearing twice over:
 *  N. A driver with NO credential must FAIL to create a box from the private
 *     ref. Without this, a package accidentally flipped public would let the
 *     positive leg "prove" a credential path that exercised nothing. The
 *     recorded failure shape also answers the open question from round-2
 *     decision 3: what `ssh exe.dev new` actually does with an unpullable
 *     image (exit? a named box that never boots?).
 *  P. The factory-built driver (exeDevDriverFromEnv over an EXPLICIT env
 *     record — no process.env mutation) with the credential file and the
 *     ratified posture creates a box from the private ref, and the box
 *     proves the SAME buildId as the public pin — an authenticated pull of
 *     byte-identical substrate.
 *
 * NO FAKES: real ssh, real ExeDevDriver, real ghcr, real private pull.
 * Teardown: destroy verdicts accumulated and asserted AFTER the finally
 * (#189 discipline); no key exists to revoke.
 */
import { expect, test } from "bun:test";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  ExeDevDriver,
  exeDevDriverFromEnv,
  IMAGE_MARKER_PATH,
} from "../../../src/providers/exedev/driver.ts";
import { parseImageMarker } from "../../../src/providers/exedev/transport.ts";
import {
  destroyQuietly,
  liveGate,
  liveTodoOff,
  runIdFor,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

/** The private mirror's repository path. The digest is DERIVED from the pin. */
const PRIVATE_REPO = "ghcr.io/biospark33/qds-exedev-private";
/** First-create budget: cold authenticated pull measured ≈60 s on the public
 * path; the private mirror shares layers but assume nothing. */
const CREATE_TIMEOUT_MS = 300_000;

test.todoIf(liveTodoOff())(
  "DF2.10 AC4 live: --registry-auth reaches real exe.dev — a private mirror refuses an unauthenticated create and boots an authenticated one to the pinned buildId",
  async () => {
    liveGate("1");

    // ── prerequisites, all free and all BEFORE any box exists ──────────────
    const authFile = process.env.QDS_E2E_REGISTRY_AUTH_FILE ?? "";
    if (authFile.trim() === "") {
      throw new Error(
        "QDS_E2E_REGISTRY_AUTH_FILE is unset — this AC4 leg needs the operator's 0600 `biospark33:<read:packages PAT>` file. A hollow live-fire is a bug, not a pass.",
      );
    }
    // The factory re-asserts this; asserting it here too means a misconfigured
    // file is named before the negative leg spends a single box-minute.
    const mode = statSync(authFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`QDS_E2E_REGISTRY_AUTH_FILE is mode 0${mode.toString(8)} — chmod 600 it first (INV-IBOX-3).`);
    }

    const digest = DEFAULT_IMAGE_REF.split("@")[1] ?? "";
    if (!digest.startsWith("sha256:")) {
      throw new Error(`DEFAULT_IMAGE_REF is not digest-pinned (${DEFAULT_IMAGE_REF}) — AC4's private mirror derives its digest from the pin.`);
    }
    const privateRef = `${PRIVATE_REPO}@${digest}`;

    // The package must be GENUINELY private or the positive leg proves
    // nothing: an anonymous manifest fetch must be refused. (ghcr answers 401
    // for anonymous, 403 for denied — 200 means someone flipped it public.)
    const anon = await fetch(`https://ghcr.io/v2/${PRIVATE_REPO.replace("ghcr.io/", "")}/manifests/${digest}`, {
      method: "HEAD",
      headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    if (anon.status === 200) {
      throw new Error(
        `the private mirror ${PRIVATE_REPO} answered an ANONYMOUS manifest fetch with 200 — the package is public, so this test cannot prove the credential path. Set its visibility to private and re-run.`,
      );
    }

    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "pass";
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the finally, never only recorded. */
    const destroyFailures: string[] = [];
    const negVm = runIdFor("t1regneg");
    const posVm = runIdFor("t1regpos");
    let posCreated = false;

    try {
      workspace = tmpWorkspace("t1reg");

      // ── the operator-ratified INV-IBOX-3 deviation record ────────────────
      // Scope names read:packages and NOTHING else (the round-2 gate refuses
      // broader); expiry is offset-carrying ISO-8601 seven days out — this is
      // a per-round credential, not a standing one; rotationOwner is the
      // operator whose live-round authorization IS the ratification.
      const postureFile = join(workspace, "exedev-posture.json");
      const expiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      writeFileSync(
        postureFile,
        `${JSON.stringify(
          {
            vmSharing: "admins-only",
            registryAuthDeviation: { scope: "read:packages", expiry, rotationOwner: "dr.steve@biosparkhealth.com" },
          },
          null,
          2,
        )}\n`,
      );
      chmodSync(postureFile, 0o600);
      evidence.push({ phase: "posture-ratified", postureFile, expiry, scope: "read:packages" });

      // ── N: the negative control — no credential, private ref ─────────────
      // Direct construction is the documented test seam; the buildId pairs
      // with the image per INV-IBOX-2. What we assert is only that the create
      // FAILS — the failure SHAPE is recorded, not assumed (round-2 decision 3
      // left "what does `new` do with an unpullable image" explicitly open).
      const negDriver = new ExeDevDriver({
        image: privateRef,
        imageBuildId: DEFAULT_IMAGE_BUILD_ID,
        execTimeoutMs: CREATE_TIMEOUT_MS,
      });
      let negOutcome: "created" | "threw" = "created";
      let negError = "";
      try {
        await negDriver.create(negVm);
      } catch (e) {
        negOutcome = "threw";
        negError = e instanceof Error ? e.message : String(e);
      }
      evidence.push({
        phase: "negative-control",
        vm: negVm,
        outcome: negOutcome,
        // The recorded failure shape — the answer to the open question.
        error: negError.slice(0, 600),
      });
      // Whatever exe.dev did, the box name must not survive: if `new` named a
      // box that never boots, it is billing — sweep it before asserting.
      const negListed = (await negDriver.list(negVm)).some((b) => b.name === negVm);
      evidence.push({ phase: "negative-control-listed", listed: negListed });
      if (negListed) {
        const d = await destroyQuietly(negDriver, negVm, evidence);
        if (!d.ok) destroyFailures.push(`${negVm}: ${d.error}`);
      }
      // The control's verdict: an unauthenticated create of a private image
      // must NOT produce a live, listed box that "succeeded". Either the
      // create threw (expected), or exe.dev named a box that must then have
      // failed to boot the image — a created-and-listed box with a clean
      // create() return would mean the package let the pull through.
      expect(negOutcome).toBe("threw");

      // ── P: the positive leg — the production factory, the credential ─────
      // An EXPLICIT env record into the same factory production registers —
      // no process.env mutation, no interference with sibling live tests.
      const posDriver = exeDevDriverFromEnv(
        {
          QDS_EXEDEV_IMAGE: privateRef,
          QDS_EXEDEV_IMAGE_BUILD_ID: DEFAULT_IMAGE_BUILD_ID,
          QDS_EXEDEV_REGISTRY_AUTH_FILE: authFile,
        },
        { postureFile, execTimeoutMs: CREATE_TIMEOUT_MS },
      );
      const tCreate = Date.now();
      const created = await posDriver.create(posVm);
      posCreated = true;
      const createMs = Date.now() - tCreate;
      expect(created.name).toBe(posVm);
      evidence.push({ phase: "authenticated-create", vm: posVm, createMs, imageRef: privateRef });

      // The box proves WHAT it booted: the same buildId as the public pin —
      // the mirror is byte-identical by digest, so gate B's identity assertion
      // holds across the authenticated path. The PRODUCTION parser, as ever.
      const markerCat = await posDriver.exec(posVm, ["cat", IMAGE_MARKER_PATH]);
      expect(markerCat.exitCode).toBe(0);
      const marker = parseImageMarker(markerCat.stdout);
      evidence.push({ phase: "marker", buildId: marker.buildId, imageRef: marker.imageRef });
      expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      // The marker's own imageRef still names the PUBLIC repo it was built
      // under — reported, never compared (decision 4): recorded here as the
      // live proof that a digest-preserving mirror keeps buildId and changes
      // nothing the gate enforces.
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (posCreated) {
        const posDestroyer = new ExeDevDriver({ image: privateRef, imageBuildId: DEFAULT_IMAGE_BUILD_ID });
        const d = await destroyQuietly(posDestroyer, posVm, evidence);
        if (!d.ok) destroyFailures.push(`${posVm}: ${d.error}`);
      }
      try {
        const path = writeEvidence("t1-registry-auth", {
          test: "DF2.10-AC4-registry-auth",
          tier: 1,
          outcome,
          privateRef,
          phases: evidence,
        });
        process.stderr.write(`[AC4] evidence: ${path}\n`);
      } catch (e) {
        process.stderr.write(`[AC4] evidence write failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // Post-finally verdicts (#189): a failed destroy fails the run without
    // masking the body's own error; the held failure is re-thrown after.
    expect(destroyFailures).toEqual([]);
    if (failure !== undefined) throw failure;
  },
  900_000,
);
