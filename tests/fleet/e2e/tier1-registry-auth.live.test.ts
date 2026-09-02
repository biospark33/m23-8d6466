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
 *  - `ghcr.io/quantum-digital-solutions/qds-exedev-private` holds the SAME bytes as the
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
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  ExeDevDriver,
  exeDevDriverFromEnv,
  IMAGE_MARKER_PATH,
} from "../../../src/providers/exedev/driver.ts";
import { ExeDevDriverError, parseImageMarker } from "../../../src/providers/exedev/transport.ts";
import {
  destroyQuietly,
  fleetCleanupProblems,
  liveGate,
  liveTodoOff,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** The private mirror's repository path. The digest is DERIVED from the pin. */
const PRIVATE_REPO = "ghcr.io/quantum-digital-solutions/qds-exedev-private";
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

    // The package must be GENUINELY private or the positive leg proves nothing.
    //
    // A bare 401 is NOT that proof. ghcr speaks the Docker Registry v2 TOKEN
    // flow: an unauthenticated manifest fetch answers 401 plus a
    // `WWW-Authenticate: Bearer realm="https://ghcr.io/token"…` challenge for
    // PUBLIC packages too, and an anonymous client is expected to take a token
    // from that realm and retry. So a check that never follows the challenge
    // can never see a 200 whatever the visibility — it passes silently on a
    // package someone flipped public, which is exactly the state that makes the
    // negative leg below prove nothing about credentials.
    //
    // Following the challenge separates the two cleanly (measured against this
    // very repo, 2026-09-02): the realm answers `200 {"token":…}` for the public
    // mirror — and that token then serves the manifest 200 — while for the
    // private one it answers `401 UNAUTHORIZED` with no token at all.
    //
    // FAIL-SAFE, and this is the direction chosen deliberately: anything that
    // cannot be turned into a retried probe — an unparseable challenge, a realm
    // that neither grants nor refuses, a malformed token body — REFUSES the run
    // rather than assuming private. An unprovable visibility is not a private
    // one, and refusing costs nothing (no box exists yet).
    const repoPath = PRIVATE_REPO.replace("ghcr.io/", "");
    const manifestUrl = `https://ghcr.io/v2/${repoPath}/manifests/${digest}`;
    const manifestAccept = { Accept: "application/vnd.oci.image.manifest.v1+json" };
    const anon = await fetch(manifestUrl, { method: "HEAD", headers: manifestAccept });
    let anonStatus = anon.status;
    if (anon.status === 401) {
      const challenge = anon.headers.get("www-authenticate") ?? "";
      const param = (k: string): string | undefined => new RegExp(`${k}="([^"]*)"`).exec(challenge)?.[1];
      const realm = param("realm") ?? "";
      if (!realm.startsWith("https://")) {
        throw new Error(
          `ghcr answered 401 for ${PRIVATE_REPO} with no parseable Bearer realm (${challenge.slice(0, 200) || "no WWW-Authenticate header"}) — refusing: without following the challenge this test cannot tell a private package from a public one, and an unprovable visibility is not a private one.`,
        );
      }
      const tokenUrl = new URL(realm);
      tokenUrl.searchParams.set("service", param("service") ?? "ghcr.io");
      tokenUrl.searchParams.set("scope", param("scope") ?? `repository:${repoPath}:pull`);
      const tokenRes = await fetch(tokenUrl);
      if (tokenRes.status === 401 || tokenRes.status === 403) {
        // The realm REFUSED an anonymous pull token. That IS the private
        // verdict, positively evidenced — not inferred from a bare 401.
        anonStatus = tokenRes.status;
      } else if (tokenRes.ok) {
        // A `.json()` that throws on a malformed body escapes here and refuses
        // the run, which is the same fail-safe direction as the branch below.
        const token = ((await tokenRes.json()) as { token?: string }).token ?? "";
        if (token === "") {
          throw new Error(
            `ghcr's token realm answered ${tokenRes.status} for ${PRIVATE_REPO} with no token — refusing: the anonymous retry that would prove visibility cannot be made, and an unprovable visibility is not a private one.`,
          );
        }
        anonStatus = (
          await fetch(manifestUrl, { method: "HEAD", headers: { ...manifestAccept, Authorization: `Bearer ${token}` } })
        ).status;
      } else {
        throw new Error(
          `ghcr's token realm answered ${tokenRes.status} for ${PRIVATE_REPO} — neither a grant nor a refusal, so this test cannot prove the mirror is private. Refusing; check by hand: curl -i ${JSON.stringify(tokenUrl.toString())}`,
        );
      }
    }
    if (anonStatus === 200) {
      throw new Error(
        `the private mirror ${PRIVATE_REPO} served its manifest to an ANONYMOUS client (200 after following ghcr's Bearer challenge) — the package is public, so this test cannot prove the credential path. Set its visibility to private and re-run.`,
      );
    }

    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "pass";
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the finally, never only recorded. */
    const destroyFailures: string[] = [];
    /** Our two names still listed after the sweep; `undefined` = the listing itself failed. */
    let finalBoxes: string[] | undefined;
    const negVm = runIdFor("t1regneg");
    const posVm = runIdFor("t1regpos");
    /**
     * Armed BEFORE `create()`, never after (the tier2-image-contract shape,
     * which assigns its `vm` before the create for exactly this reason).
     * `create` reaches the substrate — `ssh exe.dev new` has already made the
     * box — before three of its own throw sites: `steering-channel-
     * unprovisionable` (twice) and `create-shape-unresolved`, whose message
     * says outright "the VM may be live and unrecorded" (driver.ts). Setting
     * this on the RETURN left every one of those paths with nothing destroyed,
     * no `finally-destroy` entry naming the box, an empty `destroyFailures` —
     * a clean-looking cleanup over a box that bills indefinitely. Steering-
     * provision failure is a first-class retried failure mode, not a
     * hypothesis. A redundant destroy of a box that never got created is free:
     * driver.destroy's `rm` falls through to a `list` that comes back empty and
     * returns idempotent success.
     */
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
      let negCode = "";
      try {
        await negDriver.create(negVm);
      } catch (e) {
        negOutcome = "threw";
        negError = e instanceof Error ? e.message : String(e);
        negCode = e instanceof ExeDevDriverError ? e.code : "";
      }
      evidence.push({
        phase: "negative-control",
        vm: negVm,
        outcome: negOutcome,
        // The recorded failure shape — the answer to the open question.
        code: negCode,
        error: negError.slice(0, 600),
      });
      // Whatever exe.dev did, did it NAME a box? Recorded, never load-bearing:
      // the sweep that used to hang off this probe now lives in the `finally`,
      // because a `list()` that throws here (dropped ssh, `ls --json` timeout,
      // transport abort) escaped to the outer catch with `negVm` never listed,
      // never destroyed, and named only inside a `test-error` string — while
      // the finally had no `negVm` branch at all.
      try {
        const negListed = (await negDriver.list(negVm)).some((b) => b.name === negVm);
        evidence.push({ phase: "negative-control-listed", listed: negListed });
      } catch (e) {
        evidence.push({ phase: "negative-control-listed", error: e instanceof Error ? e.message : String(e) });
      }
      // The control's verdict: an unauthenticated create of a private image
      // must NOT produce a live, listed box that "succeeded". Either the
      // create threw (expected), or exe.dev named a box that must then have
      // failed to boot the image — a created-and-listed box with a clean
      // create() return would mean the package let the pull through.
      expect(negOutcome).toBe("threw");
      // …and the FAILURE SHAPE, not merely "something went wrong". `toBe("threw")`
      // alone is satisfied by an ssh blip, a spawn failure, an exec timeout or
      // `create-shape-unresolved` — one transient exe.dev hiccup on this leg
      // would certify a credential path that was never load-bearing.
      //
      // WHAT IS ASSERTED: the driver's typed code plus the exit form. Together
      // they say `ssh exe.dev new` RAN and the SUBSTRATE REFUSED it —
      // `create-failed` is also the code the transport-rejection arm takes, but
      // that arm's message is "did not complete:" (driver.ts), never
      // "exited <n>:". The two other codes reachable here,
      // `create-shape-unresolved` and `steering-channel-unprovisionable`, both
      // mean the pull SUCCEEDED, which is the opposite of this leg's claim.
      //
      // WHAT IS NOT ASSERTED, and why: any vendor string naming an auth or pull
      // refusal. exe.dev's stderr on this exact path is EMPTY — the live
      // evidence for the first AC4 round records the message verbatim as
      // "… exited 1: " with nothing after the colon
      // (_bmad-output/evidence/df3-e2e/2026-09-01-234604-t1-registry-auth.json).
      // A "names a 401/denied" assertion would therefore fail the AC4 leg on
      // the real substrate rather than tighten it. The non-zero exit is the
      // whole of what exe.dev emits here, and this is the strongest honest read
      // of it; the remaining ambiguity (a quota/rate refusal that also exits
      // non-zero) is bounded by the positive leg below succeeding on the SAME
      // ref moments later.
      expect(negCode).toBe("create-failed");
      expect(negError).toMatch(/ exited [1-9][0-9]*:/);

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
      posCreated = true; // armed BEFORE the create — see the declaration above
      const created = await posDriver.create(posVm);
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
      // ONE sweeper for BOTH boxes: `rm`/`ls` address a box by name, so the
      // image ref this driver carries is irrelevant to the destroy.
      const sweeper = new ExeDevDriver({ image: privateRef, imageBuildId: DEFAULT_IMAGE_BUILD_ID });
      // UNCONDITIONAL, and from here rather than from the body — see the
      // negative-control probe above. `destroyQuietly` never throws, and a
      // destroy of a box that was never created is idempotent success, so this
      // costs one ssh and cannot invent a failure.
      const negDestroyed = await destroyQuietly(sweeper, negVm, evidence);
      if (!negDestroyed.ok) destroyFailures.push(`${negVm}: ${negDestroyed.error}`);
      if (posCreated) {
        const posDestroyed = await destroyQuietly(sweeper, posVm, evidence);
        if (!posDestroyed.ok) destroyFailures.push(`${posVm}: ${posDestroyed.error}`);
      }
      // "We destroyed" is not "they are gone". Filtered to OUR two names so a
      // sibling round's box cannot fail this one; a listing that throws leaves
      // `finalBoxes` undefined, which `fleetCleanupProblems` reads as the
      // problem it is (an unmeasured fleet is never a clean one).
      try {
        const listed = await sweeper.list();
        finalBoxes = listed.filter((b) => b.name === negVm || b.name === posVm).map((b) => b.name);
        evidence.push({ phase: "final-ls", ours: finalBoxes });
      } catch (e) {
        evidence.push({ phase: "final-ls", ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      // `writeEvidenceQuietly` (F11). The hand-rolled catch this replaces got
      // the masking half right — the write could not overwrite the held AC4
      // failure — but it PRINTED the error and nothing more, so a write that
      // failed left no verdict. That matters here for one reason above the
      // others: `writeEvidence` throws on the SECRET-SCRUB REFUSAL, i.e. this
      // file's credential material reaching an evidence file is precisely the
      // condition that was being reported as a stderr line on a green run.
      writeEvidenceQuietly("AC4", "t1-registry-auth", {
        test: "DF2.10-AC4-registry-auth",
        tier: 1,
        outcome,
        privateRef,
        phases: evidence,
      }, destroyFailures);
      // The hoist above exists for exactly this line, and nothing called it:
      // every round left a /tmp/qds-e2e-t1reg-* directory holding the 0600
      // posture file behind (tmpWorkspace's own doc, and tier2-image-contract's
      // finally, both say `rmSync` it here).
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The post-`finally` verdict (EB3), in ONE place. The pair this replaces —
    // `expect(destroyFailures).toEqual([]); if (failure !== undefined) throw
    // failure;` — is correct on a green run and wrong on a red one: when an AC4
    // regression AND a failed cleanup landed on the same run, the `expect` threw
    // its own AssertionError first and the held regression was discarded, so the
    // operator read "cleanup failures: …" where the regression was and paid for
    // another live round to rediscover it. `settleRun` ATTACHES the cleanup
    // problem to the held error and re-throws the ORIGINAL; on a run that
    // otherwise passed, a cleanup problem is still the failure.
    settleRun(failure, fleetCleanupProblems(destroyFailures, finalBoxes));
  },
  900_000,
);
