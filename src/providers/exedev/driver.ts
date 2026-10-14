/**
 * exe.dev provider driver (DF2.2) — the first substrate-backed ProviderDriver.
 *
 * DF2.1 measured inkwell's entire exe.dev surface at SIX control-plane command
 * shapes (`new`, `ls`, `rm`, `share port`, `share set-public`, `whoami`) plus
 * generic `ssh <vm>.exe.xyz` / `scp` (R4 §3.5, exhaustive grep). Everything the
 * driver does routes through one injected command seam so tests swap the
 * substrate, never the driver: `ExeDevDriver` production-constructs with the
 * real `sshCommand()` runner; tests pass the fake substrate's `run`.
 *
 * Response-shape honesty (AC5): only `ls --json`'s `{"vms":[{vm_name,
 * https_url, ssh_dest, …}]}` shape is MEASURED. `new --json`'s key names are
 * UNVERIFIED, so `create` accepts a recognized shape, falls back to re-reading
 * the verified `ls` shape, then derives `https://<name>.exe.xyz` (itself
 * Measured) — and fails CLOSED when both are unusable, after the name has
 * reached the substrate, so the VM stays findable by `ls` and is never
 * orphaned invisibly. Each resolution is logged with its `verified` provenance.
 *
 * INV-2: every box name is a public hostname (`<name>.exe.xyz`), so the run-id
 * grammar (`assertValidRunId`, regex + 63-char limit) is asserted before ANY
 * command is built — an invalid name never reaches the wire.
 *
 * INV-3: nothing here trusts an exit status where content is the question —
 * `whoami` requires non-empty output, `destroy` re-reads `ls` when `rm` fails,
 * and the setup gate (setup-gate.ts) asserts on content throughout.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { log, newRequestId } from "../../lib/log.ts";
import { assertExistingRunId, assertValidRunId } from "../run-record.ts";
import { redactSecrets } from "../step-log.ts";
import type { ExecResult, ProviderDriver, ProviderVm, ProviderVmListing } from "../driver.ts";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_KILLED_EXIT,
  EXEC_TRANSPORT_EXIT,
  ExeDevDriverError,
  imageDigestOf,
  shQuote,
  sshCommand,
  type ExeCommand,
} from "./transport.ts";
import { fillExeDev, type FillOptions } from "./fill.ts";
import { setupGate, type SetupGateOptions, type SetupGateResult } from "./setup-gate.ts";

// ─── shared transport (re-export) ───────────────────────────────────────────

// The error shape, command seam, and serializer live in transport.ts — the LOW
// module fill.ts and setup-gate.ts also import one-way (layering rationale:
// transport.ts header). Re-exported so this module's public surface — and
// src/providers/index.ts's — is unchanged.
export {
  DEFAULT_EXEC_TIMEOUT_MS,
  ExeDevDriverError,
  shQuote,
  sshCommand,
  type ExeCommand,
  // DF2.10: the marker contract lives one layer down (setup-gate.ts reads it
  // and cannot import this module without an ESM cycle), re-exported here so
  // callers still see one exedev surface.
  IMAGE_MARKER_MAX_BYTES,
  IMAGE_MARKER_PATH,
  imageDigestOf,
  imageMarkerFailure,
  parseImageMarker,
  type QdsImageMarker,
} from "./transport.ts";
import { assertPlainBoxPath } from "../path-guard.ts";

// ─── steering channel (DF3.4 AC6) ───────────────────────────────────────────

/**
 * The steering channel is part of the box's SHAPE, provisioned at BIRTH.
 *
 * `fleet attach` and the in-box engine (DF1.10, running ON the box) address
 * `/run/steering` as infrastructure — attach.ts's `BOX_STEERING_ROOT_SH`
 * resolves the very same `${QDS_STEERING_ROOT:-/run/steering}` this script
 * provisions, so the two legs can never disagree about where the channel
 * lives. Measured live
 * 2026-08-30 (T1.8, `_bmad-output/evidence/df3-e2e/2026-08-30-160742-*`): the
 * box's exec user is non-root and `/run` is root-owned 755, so NOTHING in the
 * shipped chain could create the directory — every real attach was
 * `send-failed` before its payload ever reached a wire. The channel must
 * therefore exist before any consumer runs, and the one chokepoint every box
 * passes through is `create()`.
 *
 * The script is a FIXED literal — no host payload is ever interpolated (same
 * discipline as attach's append script); the uid/gid are resolved ON the box
 * at provision time. `install -d` is idempotent and re-applies mode/owner to
 * an existing directory, so a repaired or re-created box converges; the
 * trailing assertions verify-after-provision rather than trust it (a real
 * clock drifts, a substrate's sudo policy drifts faster).
 *
 * The last limb writes the `/etc/tmpfiles.d/qds-steering.conf` drop-in, so
 * systemd-tmpfiles — not any code of ours — recreates the channel at boot
 * (#180, closed declaratively, DF1.11): the ids are NAME-form and expanded
 * by the box's shell at write time (tmpfiles.d itself expands nothing), and
 * a file already present is byte-compared, never overwritten — divergence
 * fails loudly, the image-regression tripwire DF2.10's baked copy rides on.
 * The NAME-form expansions are guarded NON-EMPTY and whitespace-free, and the
 * root whitespace-free, BEFORE the write: a uid/gid with no passwd/group name
 * would otherwise land a userless line tmpfiles.d silently treats as "leave
 * unchanged" (root-owned channel at every boot, zero signal), and a
 * whitespace-bearing id or root a malformed line nothing ever applies. The
 * absent→write branch is itself gated on a CONTROL probe — `sudo -n test
 * true`, the same binary run on a tautology: a non-zero `test -f "$conf"`
 * cannot distinguish a genuinely absent conf from a probe that never ran
 * (scoped sudoers omitting `test`, a missing binary), and an unverified miss
 * would route an existing — possibly divergent — baked copy into the
 * unconditional write, silently overwriting it and disarming that same
 * tripwire. A refused probe therefore refuses at birth; only a
 * verified-working probe may take the write branch. No limb contains a
 * literal " && " — the unit-test harness splits on it to run limbs
 * individually.
 *
 * STRICT on failure: a box whose steering channel cannot be provisioned is
 * defective for its purpose — refusing at birth (typed, remediation named,
 * VM left listable per INV-5) beats the old failure shape, where the defect
 * surfaced as `attach` reason `send-failed` long after anyone could connect
 * it to how the box was made.
 */
const STEERING_PROVISION_SCRIPT = [
  'root="${QDS_STEERING_ROOT:-/run/steering}"',
  'sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$root"',
  'test -w "$root"',
  'test "$(stat -c %a "$root")" = 700',
  '{ case "$root" in *[[:space:]]*) echo "qds-steering: steering root [$root] contains whitespace - a malformed tmpfiles.d line would never recreate the channel" >&2; exit 1;; esac; conf=/etc/tmpfiles.d/qds-steering.conf; u="$(id -un)"; g="$(id -gn)"; [ -n "$u" ] || { echo "qds-steering: id -un resolved EMPTY on this box - an empty user field leaves the boot-recreated channel root-owned" >&2; exit 1; }; [ -n "$g" ] || { echo "qds-steering: id -gn resolved EMPTY on this box - an empty group field leaves the boot-recreated channel root-owned" >&2; exit 1; }; [ -n "$g" ] || { echo "qds-steering: id -gn resolved EMPTY on this box - an empty group field leaves the boot-recreated channel root-owned" >&2; exit 1; }; case "$u" in *[[:space:]]*) echo "qds-steering: user name [$u] contains whitespace - a malformed tmpfiles.d line would never recreate the channel" >&2; exit 1;; esac; case "$g" in *[[:space:]]*) echo "qds-steering: group name [$g] contains whitespace - a malformed tmpfiles.d line would never recreate the channel" >&2; exit 1;; esac; line="d $root 0700 $u $g"; if sudo -n test -f "$conf"; then printf "%s\n" "$line" | sudo -n cmp -s - "$conf" || { echo "qds-steering: $conf differs from [$line], or the byte-compare itself failed (missing cmp, sudo refusal) - refusing to overwrite (image or substrate drift; a relocated QDS_STEERING_ROOT legitimately diverges from the image-baked copy - relocation requires a re-pin bundle, #220)" >&2; exit 1; }; else if sudo -n test true 2>/dev/null; then printf "%s\n" "$line" | sudo -n tee "$conf" >/dev/null; else echo "qds-steering: the sudo -n test probe itself failed on this box - cannot prove $conf ABSENT rather than unreadable, refusing to write blind over a possibly divergent baked copy" >&2; exit 1; fi; fi; }',
].join(" && ");

// `EXEC_KILLED_EXIT` / `EXEC_TRANSPORT_EXIT` are IMPORTED from transport.ts
// (above), not redeclared: this module used to hold a byte-identical private
// pair, and two copies of the same classification can drift in opposite
// directions — the steering-provision path and the marker path would then
// disagree about whether the same exit status was a transport fault. The
// provision script has no arm that exits either way on purpose (`install -d`,
// `test -w` and `stat` are 0/1 commands), so treating these two statuses as
// script semantics would be inventing them.

/**
 * One non-zero provisioning exit, four VERY different boxes to fix.
 *
 * A genuine policy failure (no passwordless sudo, /run not writable) points at
 * the substrate's permission model. A box that never answered at all — the exec
 * budget SIGKILLed it, or ssh reported the connection dead — points at the box
 * or the network, and sending that operator off to audit sudo policy is a
 * remediation for a problem the box does not have. A refusal the script NAMED
 * itself (a `qds-steering:` line on stderr, exit 1 — conf divergence, empty or
 * whitespace ids/root, a refused control probe) is a fourth: the limb's own
 * stderr line is the diagnosis, and the generic sudo remediation would send
 * every one of those operators to re-create a box that re-creation cannot fix.
 * The error CODE stays `steering-channel-unprovisionable` in all four arms
 * (every steering message to the box would be refused at send time either way,
 * and that is the decision callers act on); what differs is the diagnosis and
 * the next command. The stderr tail rides every arm: it is the evidence an
 * operator needs to overrule the classification.
 */
function steeringProvisionFailure(
  name: string,
  exitCode: number,
  stderr: string,
  budgetMs: number,
): { message: string; remediation: string } {
  const tail = stderr.trim().slice(0, 300);
  if (exitCode === EXEC_KILLED_EXIT) {
    return {
      message: `box ${name} never answered its steering-channel provisioning exec — the command hit the ${budgetMs} ms exec budget and was SIGKILLed (exit 137): ${tail} — every steering message to this box would be refused at send time (attach reason "send-failed")`,
      remediation: `this is a box/transport fault, not a sudo-policy finding: check the box answers at all (ssh ${name}.exe.xyz true), re-create it, and raise execTimeoutMs only if the box is merely slow`,
    };
  }
  if (exitCode === EXEC_TRANSPORT_EXIT) {
    return {
      message: `box ${name} could not be reached to provision its steering channel — ssh exited 255 (connection failed or dropped mid-script): ${tail} — every steering message to this box would be refused at send time (attach reason "send-failed")`,
      remediation: `this is a transport fault, not a sudo-policy finding: confirm the box is up (ssh ${name}.exe.xyz true) and re-create it; if the sudo question is still open afterwards, run the provision script by hand`,
    };
  }
  // The script's OWN refusal (round 2, F8): every deliberate limb in
  // STEERING_PROVISION_SCRIPT's tmpfiles clause echoes a `qds-steering:`
  // -prefixed line to stderr and exits 1 — conf divergence, empty or
  // whitespace ids/root, a refused control probe. Exit 1 matches neither arm
  // above, and the generic sudo-policy arm below sends every one of those
  // operators to "grant passwordless sudo / re-create the box", which fixes
  // none of the four causes. Checked on the TAIL and placed AFTER the
  // exit-class arms: the marker rides stderr, so a 137/255 exit whose buffer
  // happens to carry a partial refusal line keeps its exit-class diagnosis —
  // the exit status, not the marker, owns those two arms.
  if (tail.includes("qds-steering:")) {
    return {
      message: `box ${name} refused its own steering-channel provisioning (script-named refusal, exit ${exitCode}): ${tail} — every steering message to this box would be refused at send time (attach reason "send-failed")`,
      remediation:
        "the script's stderr line above IS the diagnosis — read it before touching sudo: a tmpfiles.d conf that DIFFERS is image or substrate drift and needs the #220 re-pin bundle (a relocated QDS_STEERING_ROOT legitimately diverges too); an EMPTY or whitespace id/root is a substrate finding; a refused sudo -n test probe means the sudoers allow-list must also grant the binaries the script invokes (test, cmp, tee, install) — none of these are fixed by re-creating the box",
    };
  }
  return {
    message: `box ${name} came up without a writable steering channel: ${tail} — every steering message to this box would be refused at send time (attach reason "send-failed")`,
    remediation:
      "the substrate must grant the exec user passwordless sudo (sudo -n install -d) or a /run writable by it; re-create the box, and if this persists file a substrate finding",
  };
}

// ─── response shapes ────────────────────────────────────────────────────────

/**
 * The one MEASURED shape: `ls --json` → `{"vms":[{vm_name, https_url, …}]}`.
 *
 * The rows are `unknown`, not a field shape: only the ENVELOPE is measured, and
 * a row that is not an object at all (a bare string, a null) made
 * `typeof v.vm_name` throw a TypeError that surfaced as an opaque crash instead
 * of a named anomaly. Row shape is checked where the row is read.
 */
interface LsShape {
  vms?: unknown[];
}

/** How `create` learned the VM's URL — logged per call (Observability Contract). */
export type CreateProvenance = "new-shape" | "ls-shape" | "derived";

// ─── factory boot image (DF2.10) ────────────────────────────────────────────

/**
 * The "no digest recorded yet" sentinel.
 *
 * Deliberately WELL-FORMED so the driver still constructs — every existing
 * caller does `new ExeDevDriver()` and a throwing constructor would break the
 * whole provider layer for a bookkeeping reason. The refusal lives where it
 * belongs instead, in two places that answer two different questions:
 * `image-contract.test.ts` asserts the SHIPPED pin is not a sentinel, so a
 * story cannot merge unpinned; and `.github/workflows/publish-exedev-image.yml`
 * detects one and can never go GREEN against it, so a placeholder can never be
 * mistaken for a checked pin. The guarantee is stated here, not the mechanism —
 * the workflow owns which of its steps enforces it.
 *
 * Note the workflow does NOT refuse to publish on a sentinel run, and must not:
 * the bootstrapping ritual needs exactly that run to build and push, because the
 * gate has nothing to compare until a real digest exists. What it refuses is to
 * report success — the run is announced as a BOOTSTRAP and fails with a message
 * naming the sentinel, rather than as an ordinary digest mismatch, which would
 * read as tampering. "Refuses to publish" would be the wrong claim to make here;
 * it would send the next maintainer looking for a pre-push guard that cannot exist.
 *
 * Kept after the first publish on purpose: it is the guard for every FUTURE
 * re-pin, including DF1.10's, which re-issues this pin after adding its engine
 * stage. The digest alone is checked — a buildId sentinel would be redundant,
 * since the two are only ever recorded as a pair.
 */
const UNPINNED_DIGEST = "0".repeat(64);

/** True while the repo pin is still a sentinel. The publish workflow enforces
 *  the SAME check with its own bash string-compare (it cannot call this
 *  predicate); this is the TS spelling the merge-gate tests key on.
 *
 *  Compares the PARSED digest, not a suffix: `endsWith` also fires on a legal
 *  TAG that happens to end in 64 zeros (`…:build-0000…0`), and it says nothing
 *  about the zeros being in the digest POSITION at all — it worked only by
 *  accident of where a digest sits in a reference. `imageDigestOf` returns
 *  `null` for a tag pin, which is the honest "not a digest, so not the digest
 *  sentinel" answer the tag arm below relies on. */
export function isUnpinnedImage(ref: string = DEFAULT_IMAGE_REF): boolean {
  return imageDigestOf(ref) === `sha256:${UNPINNED_DIGEST}`;
}

/**
 * The factory image every box boots, pinned by DIGEST.
 *
 * DF2.10 forks exeuntu (ADR 2026-08-31 consequence 1) so the runtime under a
 * run is a reviewed artifact in git rather than whatever the vendor shipped
 * this week — the drift is MEASURED, not theoretical: stock exeuntu carried pi
 * 0.83.0 on 2026-08-04 and 0.84.4 on 2026-08-31, and upstream runs a weekly
 * no-cache cron rebuild that moves `:latest` under us. A tag would re-acquire
 * exactly the disease this story treats, so the pin is a digest.
 *
 * A digest is content-addressed, which is why this survives the enterprise
 * tier: a customer who mirrors the image into their own registry (`crane copy`
 * into ECR/Harbor/ACR — D7's client-VPC tier) keeps the SAME digest, so this
 * pin and gate B's `buildId` check work unchanged inside their tenant.
 *
 * NOT a `process.env` read (AC3): the registry constructs this driver with NO
 * options (`src/providers/index.ts`), so a default living only on
 * `ExeDevDriverOptions` would never be set in production. Any override is read
 * at the registry factory by {@link exeDevDriverFromEnv}, never here and never
 * inside `create()`.
 */
// REPRODUCIBLE — which is the property that makes this constant a pin rather
// than a note. NOT published by CI: this digest and its two 2026-09-04
// predecessors were built and pushed from the developer's machine, inside
// DF1.10's live round, because each re-pin had to be adopted and PROVEN on a
// real box in the same sitting. The paragraph below about the 2026-09-02
// CI-published digest is kept as the standing record of how the workflow's
// equality check works; it describes that digest, not this one.
//
// SO THE GATE IS UNPROVEN FOR THIS PIN, stated here rather than left to be
// inferred from "NOT published by CI" above. publish-exedev-image.yml's step
// "Assert pushed digest and buildId equal the repo pin" (id: `gate`) is the
// only thing that checks the pushed manifest digest and the build-derived
// buildId against the two constants in this file — and it has never run
// against `sha256:8cdcfe84…` / `c2b0c0f0531078e1`, because these bytes were
// pushed from a laptop. What HAS been verified for this pin is registry state,
// not equality: `imagetools inspect` resolves the digest, an anonymous ghcr
// token reads its manifest (AC4), and `tier1-registry-auth` created a real box
// from it. Gate B still compares the BOX's `/etc/qds-image.json` buildId
// against `DEFAULT_IMAGE_BUILD_ID` on every setup, so a box booting other bytes
// is still caught; what is missing is the upstream half — proof that the digest
// named here is what a reproducible CI build of this source revision produces.
// The next publish run that reproduces this exact pair is what discharges it;
// until then, treat a future CI mismatch on these constants as "the hand-push
// drifted", not as tampering.
//
// FIRST PIN THIS REPOSITORY DID NOT PUSH BY HAND. The 2026-09-01 predecessor
// (…a70674b2…, under ghcr.io/biospark33) was built and pushed from a laptop
// because the publish workflow had never completed a run — which is what the
// `.github/image-pin-exceptions.json` bootstrap entry exists to record, and
// why it can now be deleted. This digest came out of
// publish-exedev-image.yml run 33637763742 on `dev`, and the adoption push of
// THIS commit rebuilds the same source revision and re-publishes the identical
// bytes, which is the workflow's own equality check rather than a claim made
// here.
//
// The namespace moved with the repository: an org repo's GITHUB_TOKEN cannot
// push to a user-owned GHCR package ("The requested installation does not
// exist" — measured, run 33636577505), so the package moved to the org
// alongside the repo. Story Deviation 8.
//
// Before reproducibility landed the digest moved on every rebuild
// (wall-clock layer mtimes, a wall-clock `builtAt` in the marker, and buildx's
// default provenance attestation), so the publish workflow's "pushed digest ==
// this pin" step was a tripwire rather than an equality.
//
// This is a SINGLE-PLATFORM linux/amd64 image manifest, NOT the multi-arch
// index the 2026-08-31 pin (…3c21d5f9…) was. The index existed only because
// buildx attaches a provenance attestation by default and wraps the result in
// one; that attestation embeds build-time data, so the index digest moved
// between two otherwise identical builds (MEASURED: sha256:ded2fc69… then
// sha256:c8042e09… on a probe pair) while the image manifest under it stayed
// put. Turning it off (`--provenance=false --sbom=false`) is what leaves a
// stable digest to pin — the tradeoff is argued in that script's header, and it
// is no longer an unpaid one: publish-exedev-image.yml now signs this digest
// with `actions/attest-build-provenance` AFTER the push and asserts, by
// re-reading the tag, that doing so left the digest and the manifest media type
// alone. A pull by this digest now resolves the amd64 image directly, one
// hop shorter than before; exe.dev's host-side `--image` pull is unaffected.
// Verified in the registry, not merely locally, and RE-verified for THIS
// digest on 2026-09-04 rather than inherited from its predecessor:
// `docker buildx imagetools inspect` returns …8cdcfe84… with mediaType
// `application/vnd.oci.image.manifest.v1+json`, `docker image inspect` reports
// linux/amd64, and an anonymous ghcr token reads its manifest with HTTP 200
// (AC4). The private mirror was re-pushed from this same digest and
// `imagetools inspect qds-exedev-private@sha256:8cdcfe84…` resolves — the
// check that matters there, because `imagetools create` wraps the copy in an
// index under a NEW digest (…f323ab51…) while `tier1-registry-auth` pulls the
// mirror at the digest THIS constant names.
// RE-PINNED 2026-09-06 (#217 bundle, merged as PR #228 + the publish-blocker
// fix in PR #229): this digest came out of publish-exedev-image.yml run
// 34057514236 on `dev` @ 067ae870 — a real CI build and push of the #217
// image edits (per-run marker roots F-D1, absolute-bun wrapper F-D5, su
// assert prints F-D6, R3-a's yaml/zod tree gate). Gate B ran against this
// pair and PRINTED it ("Assert pushed digest and buildId equal the repo
// pin"), so the "gate is unproven for this pin" paragraph above no longer
// describes THIS constant — it is kept as the record of its 8cdcfe84…
// predecessor, the last hand-pushed pin. The bootstrap exception that
// covered that predecessor is retired in the SAME commit as this adoption
// (.github/image-pin-exceptions.json, empty array), and the adoption push
// of this commit is itself the healing run the ritual prescribes.
// Post-adoption TODOs that live outside this file: the private mirror
// (qds-exedev-private) must be re-pushed from this digest before
// tier1-registry-auth can pass again, and the first live round on this
// pin is #226's closer.
// SECOND adoption same day: the manifest newline fix (4a77d7d2, a walked
// image source) moved the bytes, so the pair moved with them — printed by
// gate B from run 34060455391 at src_sha 4a77d7d2. Same ritual, one push.
// THIRD adoption (DF1.11 merge d7dcf8bf): the engine's in-box steering sources
// moved the tracked inputs, so the pair moved with them — printed by gate B
// from run 34137286280 at src_sha e61e7808. Same ritual, one push.
// FIFTH adoption (DF2.11's merge 039d88fd): the teardown run-lock capability
// moved scripts/lib/run-lock.ts + src/fleet/{approval-gate,fanout-primitive}.ts
// — printed by gate B from run 34307353550 at src_sha 85c79e32. Same ritual,
// one push; the tracked-inputs literal moved in the same commit (f03c118b…).
// FOURTH adoption (review round 1's merge b88c13af): the round's attach.ts /
// steering.ts hardening moved the walked inputs again — printed by gate B
// from run 34174243205 at src_sha fdb2b755. Same ritual, one push. The
// tracked-inputs literal (build-exedev-image.test.ts) was already moved to
// this tree's walk (55797a45…) in the same merge, so the pairing debt named
// there is retired BY this adoption rather than created by it.
// SIXTH adoption (DF2-11 review rounds 3–5's merge f1683745, PR #246): the 59
// round-5 patches across 10 src files moved the walked inputs — printed by
// gate B from run 34485220198 at src_sha f1683745. Same ritual, one push.
// The tracked-inputs literal (build-exedev-image.test.ts) already carries this
// tree's walk (round 5 re-pinned it on the settled branch, 895257a2…), so
// nothing outside driver.ts + image-contract.test.ts's two by-hand literals
// moves in this commit.
// SEVENTH adoption (#247's base re-pin, PRs #249+#251): the Dockerfile's
// exeuntu base moved bd447a77 → ea6c3f5c (upstream's weekly no-cache rebuild)
// and exeuntu moved the pi ELF to /home/exedev/.local/pi/pi with it — pair
// printed by gate B from run 34536729175 at src_sha aaa4506 (the first build
// off the new base refused on the moved binary, and #251 moved the license
// entry + placement tie in the same change). The tracked-inputs literal
// already carries this tree's walk; the private mirror re-push and the live
// boot proof follow this commit (#226's closer, now for the seventh pin).
// Eleventh pin (2026-09-18): gate B pair from run 35296406698 at src_sha
// 91fd14c3 — the DF5.3 merge's publish first refused at the engine stage's
// resolution probe (the COPY-set convergence commit names the five COPYs that
// fixed it), and this build off the converged tree pushed
// sha256:de9d165e… / buildId 289c1f234f14102b.
// Twelfth pin (2026-09-18): gate B pair from run 35404469575 at src_sha
// dcfa3c1e — the DF3.8 merge (#265). The eleventh pin predated DF3.6a
// (35d8d5b6, which added the resident bound manifest fields), so the
// image-baked engine rejected DF3.6a-schema manifests ("Unrecognized
// key(s) in object: 'residentSpendCeilingMicros', …") and the DF3.8
// tier-3 observe round died engine-start-refused on a 6.3 s run. This
// build carries DF3.6a and DF3.8 both and pushed
// sha256:8f5941e0… / buildId 438fe0b7d10a3923.
// Thirteenth pin (2026-09-18): gate B pair from run 35407164563 at src_sha
// 66709ef5 — the DF3.8 margin re-derivation (#267). Comment-only as a diff,
// but observe.ts is a walked input, so the bytes moved the image; this build
// pushed sha256:d03f58cb… / buildId 998db8aaab5e4fef. The walked-input
// literal was already re-pinned on the branch (99af1da0…, DF1.10 pairing
// debt) — this adoption is the image half that ritual deferred.
// Fourteenth pin (2026-09-20): gate B pair from run 35537650657 at src_sha
// 1b653f04 — DF6.1a's four walked inputs (brief-schema, dispatch,
// dispatch-task, run-record; the in-box appendix renderer is dispatch-task.ts,
// so the fix-loop round's box MUST run this image or the fixer never sees the
// comments). The walk literal had already moved on the branch (8b670a3d…,
// pairing debt declared); this is the rebuild → publish → adopt that ritual
// owed. Pushed sha256:9c8bfe9a… / buildId 52538541c5430cc5.
//
// TWO CONSEQUENCES THE ADOPTION ITSELF DOES NOT STATE.
// The workflow PRUNES an ungated push (this run deleted package version
// 1272119252), so between the adoption commit and the healing run the digest
// above names bytes NO REGISTRY HOLDS and any `create()` in that window fails
// to pull. Worth naming because the prune step is NEWER than the paragraphs
// below that argue the commit-precedes-push ordering — that reasoning predates
// the behaviour it now has to account for.
// And the private mirror (qds-exedev-private) must be re-pushed from this
// digest before tier1-registry-auth can pass again, per the standing obligation
// above. The twelfth and thirteenth pins record their mirror tags; the
// fourteenth records none, which reads as "not applicable" rather than "not
// done". It is not done.
// (2026-09-25: unchanged in kind — every pin since inherits the same
// obligation; the current pin's re-push is roadmap R0.6.)
// Fifteenth pin (2026-09-24): gate B pair from run 36048175927 at src_sha
// 07db7e3e — the FIRST REAL PUBLISH of the S1 rig_swarm image stages (roadmap
// R0.3). The measurement chain that produced it, all gate-refused dry runs on
// feature/r0-image-convergence: the engine COPY set converged with S1's
// provider closure (7 files, e2660618), NODE_SHA256 measured by run
// 36031582204's refusal and cross-checked against nodejs.org's SHASUMS256.txt,
// OPENRIG_TREE_SHA256 measured by run 36032367862's refusal, and the DF2.9
// license sweep reconciled (10 nested @openrig/cli dep executables, b825949c +
// cbc4563b). This build ALSO discharges the DF3.6b debt the fourteenth pin
// carried — the merged tree's unit (+`Delegate=memory`), the Dockerfile scan,
// `resident.ts` and `steering.ts` are all baked into sha256:9d1822c6…, so the
// resident arms on this pin and DF3.6b's in-box behaviour is reachable.
// Pushed sha256:9d1822c6… / buildId 68fca032d53c0de6; gate B printed the pair
// itself (the ritual's only source — never hand-computed).
//
// ~~AMENDED ON THIS BRANCH BY THE dev MERGE (2026-09-20) — the list above is no
// longer the whole move set, and the difference decides whether the resident
// arms at all. DF3.6b moved two more walked inputs that this pin's substrate
// PREDATES: `oci/exedev/systemd/qds-run@.service` (+`Delegate=memory`) and
// `oci/exedev/Dockerfile` (the unit scan that fences it). So a box booted from
// sha256:9c8bfe9a… runs a unit with NO `Delegate=`, `ensureDelegatedSubtree()`
// finds no memory controller, and the run is classified `rss_unenforceable`
// with the resident DISABLED. That is AC3 behaving correctly, not a bug — but
// it means DF3.6b's in-box behaviour (AC1/AC5 kernel-OOM classification,
// `exitStatus:"overflow"`) is UNREACHABLE on this pin, and DF6.1a's fix-loop
// rounds run residentless too.~~
//
// ~~IT IS SILENT, which is why it is written here rather than left to a gate.
// Gate B compares the box's baked marker against DEFAULT_IMAGE_BUILD_ID; the
// image bakes 52538541c5430cc5 and this constant says 52538541c5430cc5, so
// gate B goes GREEN on a substrate the repo no longer describes. The Dockerfile
// probe DF3.6b added to catch exactly this regression runs at BUILD time, and
// no build happens. Nothing else re-derives the id from the real tree.~~
//
// (2026-10-08, M2.2: the buildId literals in the strikethrough paragraphs
// above are HISTORICAL — they describe a pin the constants have since left.
// The live pairing is DEFAULT_IMAGE_REF's digest + DEFAULT_IMAGE_BUILD_ID
// (both just below): gate B compares the box's baked marker against
// DEFAULT_IMAGE_BUILD_ID, and the pin-adoption commit (scripts/adopt-image-pin.ts)
// is the ONLY writer of those constants and never touches buildId-fed bytes.
// The pairing can drift only if an image is adopted without running the
// re-pin ritual — see the M2.2 re-pin ritual runbook.)
//
// ~~ONE DEBT SURVIVES, and it is DF3.6b's alone.~~ DEBT SETTLED 2026-09-24 by
// the fifteenth pin: the publish rebuilds the MERGED tree, so sha256:9d1822c6…
// bakes the `Delegate=memory` unit, the Dockerfile scan, `resident.ts` and
// `steering.ts` alongside everything the fourteenth pin already carried
// (DF6.1a's brief-schema/dispatch/dispatch-task/run-record). The resident arms
// on this pin; DF3.6b's in-box behaviour is reachable; the silent-green window
// this paragraph described closed with the substrate it described.
//
// TWO CONSEQUENCES THE ADOPTION ITSELF DOES NOT STATE.
// The workflow PRUNES an ungated push (this run deleted package version
// 1272119252), so between the adoption commit and the healing run the digest
// above names bytes NO REGISTRY HOLDS and any `create()` in that window fails
// to pull. Worth naming because the prune step is NEWER than the paragraphs
// below that argue the commit-precedes-push ordering — that reasoning predates
// the behaviour it now has to account for.
// And the private mirror (qds-exedev-private) must be re-pushed from this
// digest before tier1-registry-auth can pass again, per the standing obligation
// above. The twelfth and thirteenth pins record their mirror tags; the
// fourteenth records none, which reads as "not applicable" rather than "not
// done". It is not done.
export const DEFAULT_IMAGE_REF =
  "ghcr.io/quantum-digital-solutions/qds-exedev@sha256:ee80266907399d700b33dbe3ed10895187e87c45dfcb56c54db7aba7acc9bcea";

/**
 * The `buildId` the repo pin pairs with {@link DEFAULT_IMAGE_REF}'s digest.
 *
 * INV-IBOX-2: a box CANNOT read the digest it was pulled from, and the marker
 * cannot carry that digest either — the digest is the hash of the manifest
 * containing the marker, so baking it changes it. So the host enforces the
 * digest at pull, the box proves this build-generated id, and gate B refuses
 * when they disagree. Derived deterministically from the build inputs, so an
 * identical rebuild is provably the same substrate.
 *
 * MOVED on 2026-09-02 (664876fb1a9128ec → 3cf094fb6990ed66), and that it moved
 * is the check rather than a footnote. It was UNCHANGED across the 2026-09-01
 * reproducibility re-publish — the digest moved there (…3c21d5f9… → …a70674b2…)
 * only because layer timestamps and the attestation wrapper changed, while none
 * of base digest / BUN_VERSION / PI_VERSION / Dockerfile bytes / systemd unit
 * bytes did. This time three of those five genuinely moved: the exeuntu base
 * was re-pinned (…4398215003cf… → …bd447a7715e4…), and the Dockerfile's bytes
 * changed twice over — round 4's edits, then `org.opencontainers.image.source`
 * following the repository to the org. So a buildId that had NOT drifted here
 * would have been the alarm, exactly inverting the 2026-09-01 reading.
 *
 * Both readings come from the same rule: this value tracks the SUBSTRATE, and
 * the digest tracks the BYTES. They move together only when the substrate is
 * what changed.
 *
 * MOVED AGAIN on 2026-09-04 (3cf094fb6990ed66 → e04144e6f4a86fc6), and by that
 * same rule this one HAD to move: DF1.10 replaced the engine's delivery route
 * outright. The Dockerfile's bytes changed (the `bun build --compile` stage is
 * gone, replaced by a staged unbundled source tree, a `node_modules` narrowed to
 * the engine's two runtime packages, and a two-line `exec` wrapper), and the
 * COPY set that feeds this hash changed with it. The substrate is genuinely
 * different — the box now runs `bun` against real source instead of a
 * single compiled ELF — so an UNCHANGED buildId here would have been the alarm.
 *
 * The digest moved too (…92447929… → …eb169d40…), which is the ordinary case:
 * both the substrate and the bytes changed. `--push` re-read the tag from the
 * registry and the registry agreed, so this digest is what ghcr resolves, not
 * merely what the local exporter reported.
 *
 * AND ONCE MORE, the same day (e04144e6f4a86fc6 → c2b0c0f0531078e1, digest
 * …eb169d40… → …8cdcfe84…), because the FIRST live round on the e04144e6 image
 * found that the in-box engine could not create its own runtime directories:
 * `EACCES: mkdir '/run/trace'`, `ExecMainStatus=2`, on a `/run` that is
 * root-owned tmpfs under a `User=exedev` unit. The fix is `RuntimeDirectory=`
 * on `oci/exedev/systemd/qds-run@.service`, and that unit is a `deriveBuildId`
 * input — so the pin above described an image whose engine had never completed
 * a run. THIS is the shape of re-pin the ritual exists for: not a route change,
 * a one-line unit change that no static gate could have told from a working
 * one. The rule holds either way — this value tracks the substrate, and the
 * substrate is what changed.
 *
 * Paired with gitSha 1b653f043b287fd9fced8965fe2a7b840b44e905 (the DF6.1a
 * bounded-fix-attempt commit — the src_sha the workflow's SOURCE_PATHS
 * resolution names for THAT build, the fourteenth pin's; the line this
 * paragraph replaced said 4a77d7d, which was the THIRTEENTH pin's pairing).
 *
 * RE-PIN THIS LINE TOO. It was last set by `4cc6dfcd` (the second adoption) and
 * drifted through the fourteenth — twelve pins naming the wrong source
 * revision: 1cc01c55, 838c7f3e, 1164d85d, ffe93cdd, 706366c5, 075eeb0a,
 * f90c47ce, d63f603d, 1c0bbeb7, 3cb72485, a890dbff, 6ed796c9. Nothing fails
 * when it drifts, which is why twelve went by. (FIXED SINCE: the adoptions
 * from the fifteenth on re-pin the pairing in step — 07db7e3e, 55215f51,
 * aa3d7d33, each named with its full sha in the CURRENT PAIRING block below.)
 *
 * The numbered ledger above DEFAULT_IMAGE_REF is not an intact fallback:
 * it runs THIRD, FIFTH, FOURTH, SIXTH, SEVENTH and then jumps to Eleventh, so
 * the eighth, ninth and tenth src_shas are recorded nowhere in this file
 * (075eeb0a, f90c47ce, d63f603d — their commit subjects name the gate B runs).
 * Of the two defects this paragraph was written against, the pairing-line
 * drift is fixed since; the ledger gap REMAINS.
 *
 * driver.ts is deliberately excluded from SOURCE_PATHS (the
 * workflow's own documented asymmetry) so the pin-adoption commit does not
 * move the revision the pin was adopted for — the healing run rebuilds at
 * the same sha, and gate B is what says whether it is byte identical. The
 * pairing
 * is load-bearing and was nearly got wrong once: an earlier build baked
 * HEAD while 40+ files were uncommitted, which would have stamped
 * /etc/qds-image.json with a commit that CANNOT reproduce the image. The
 * commit precedes the push for that reason.
 *
 * CURRENT PAIRING (thirtieth pin, 2026-09-29): buildId 3aa9227509786a67 —
 * the post-label-fix engine (the round-blocking mismatch: the baked
 * engine pre-#363 rejected runtime "claude-code"), measured LOCALLY via
 * the script itself while GitHub Actions billing is failed;
 * adopted from gate B own paste-ready output on publish run 36373548860
 * (the claude-CLI image: ARG CLAUDE_CODE_VERSION=2.1.283 installed into
 * /opt/openrig, sweep-attributed; prior pairing:
 * this adoption commit rebuilds at the same resolved sha, byte identical, and
 * gate B must close GREEN on it).
 *
 * Why BOTH values moved from the twenty-fourth pin (ed1714e2… /
 * b8e0c53589faadec), with the twenty-fifth intervening UNADOPTED: #314
 * re-pinned OPENRIG_TREE_SHA256 (543e846b… → 41e10c9a…) after upstream ^-
 * range drift inside @openrig/cli@0.5.14 moved the /opt/openrig tree — run
 * 36254811811 printed the twenty-fifth pair (b10112df… / da57d8c95005de7d)
 * but it was superseded within the hour by #315's parser fix (a walked COPY
 * input moved again) and never adopted; its pruned bytes were pulled by
 * nobody. #315 rewrote the seat-cost parser to pi 0.84.4's real session
 * JSONL (entry wrapper + Usage.cost.total) — live rounds 19-21 had priced
 * ZERO of 81 seat turns against the spike's assumed flat shape. The
 * whole-walk literal's debt from that merge is settled in this adoption's
 * same commit (the whole-walk literal now 9f55e706…, its debt declared on
 * the branch).
 */
export const DEFAULT_IMAGE_BUILD_ID = "26b5ce571e50bfcc";



/**
 * Grammar for a container image reference: `host[:port]/path[/path…]` closed by
 * either `@sha256:<64 hex>` or `:<tag>`.
 *
 * An explicit registry host is REQUIRED — a bare `ubuntu:22.04` is refused.
 * This value is a factory pin, not a convenience, and an implicit Docker Hub
 * resolution is precisely the ambiguity a pin exists to remove.
 *
 * INV-2/INV-IBOX-3, the same trust boundary the `tag` check guards: ssh
 * CONCATENATES argv into a remote command line, so anything that reaches
 * `ssh exe.dev new` is validated before a command is built. The charset admits
 * no shell metacharacter, no whitespace and no newline by construction.
 */
const IMAGE_REF_RE =
  /^(?=.{1,255}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+|localhost)(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/;

/** `USERNAME:PASSWORD` (exe.dev `doc private-image`). Never echoed on refusal. */
const REGISTRY_AUTH_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Byte ceiling for `QDS_EXEDEV_REGISTRY_AUTH_FILE` — checked at the fstat,
 * before a single byte is read. The longest credential {@link
 * assertRegistryAuth} admits is 128 (username) + 1 + 512 (password) = 641
 * bytes; the slack covers a trailing newline and an operator's stray blank
 * line, and nothing else. A file larger than this is not a credential file,
 * and reading it to find that out is how a mispointed path loads a heap dump.
 */
const REGISTRY_AUTH_FILE_MAX_BYTES = 1024;

/** Where this driver reads operator attestations (INV-1 posture, and the
 *  INV-IBOX-3 registry deviation). ONE spelling: `exeDevDriverFromEnv` needs
 *  the same default the constructor applies, so it could run the ratification
 *  gate BEFORE opening a credential file. */
const DEFAULT_POSTURE_FILE = ".sandbox/exedev-posture.json";

/**
 * The format characters an INVISIBLY-blank argv element can be made of: SHY,
 * ZWSP, WORD JOINER and BOM/ZWNBSP. Such an element is invisible in every
 * log, every review and every terminal, and ships a no-op substring onto the
 * ssh command line — the invisible twin of the whitespace-only element the
 * exec guards below refuse (DF1.10 review round 3, C2-2).
 *
 * `trim()` is genuinely blind to only THREE of the four: SHY, ZWSP and WORD
 * JOINER sit outside ECMAScript's WhiteSpace production, so they survive a
 * trim. BOM/ZWNBSP (U+FEFF) IS in that production and `trim()` already strips
 * it — it stays in the set as a redundant belt so this rule is ONE spelling
 * with `fake-driver.ts`'s mirror, not because it catches anything `trim()`
 * let through (round 4, P53).
 *
 * Deliberately NARROW: refusing is a behavior change, and the broader Cf/Zs
 * zoo is what `fake-driver.ts`'s `displayName` ESCAPES for logging rather
 * than refuses. These four are the ones with no defensible use in a command
 * line. Same spelling as the fake's mirror (the two must stay one rule), and
 * narrower than the manifest loader's invisible-set refusal
 * (phase-engine/manifest.ts), which is the FREE boundary before any box
 * exists and therefore refuses more.
 */
const INVISIBLE_BLANK_RE = /[\u00ad\u200b\u2060\ufeff]/g;

/**
 * Refuse an image reference at the trust boundary.
 *
 * The message ECHOES the rejected value on purpose: an image reference is a
 * public pin, not a credential, and an operator debugging a typo needs to see
 * what was rejected. {@link assertRegistryAuth} deliberately does the opposite.
 */
export function assertImageRef(ref: string): void {
  if (!IMAGE_REF_RE.test(ref)) {
    throw new ExeDevDriverError(
      "image-invalid",
      `image ${JSON.stringify(ref)} is not a valid reference (want host[:port]/path@sha256:<64 hex> or host[:port]/path:<tag>, explicit registry host required, no shell metacharacters)`,
      // Lowercase on purpose: IMAGE_REF_RE's path component admits no
      // uppercase (the OCI rule), so an operator who copies this example
      // literally must not be refused by the very rule it is illustrating.
      "pass a digest-pinned reference, e.g. ghcr.io/owner/image@sha256:<64 hex>",
    );
  }
}

/**
 * Refuse a registry credential at the trust boundary — NAMING the field and the
 * failed rule, NEVER the value (INV-IBOX-3).
 *
 * The `tag-invalid` precedent interpolates the value it rejects. On a
 * credential that interpolation IS the leak: the message travels into logs,
 * into an operator's terminal, and into whatever captured the exception. So
 * this borrows that error's SHAPE and refuses its message style.
 */
export function assertRegistryAuth(value: string): void {
  const refuse = (rule: string): never => {
    throw new ExeDevDriverError(
      "registry-auth-invalid",
      `registryAuth is malformed: ${rule} (value withheld — a registry credential is never echoed, INV-IBOX-3)`,
      "pass USERNAME:PASSWORD from a 0600 host file; check the value without printing it",
    );
  };
  const sep = value.indexOf(":");
  if (sep < 0) refuse("expected USERNAME:PASSWORD, found no ':' separator");
  const user = value.slice(0, sep);
  const secret = value.slice(sep + 1);
  if (!REGISTRY_AUTH_USER_RE.test(user)) refuse("username must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  if (secret.length === 0) refuse("password is empty");
  // The FLOOR is a redaction property, not a strength claim. `redactRegistryAuth`
  // scrubs by `text.split(secret).join(marker)`, and on a one- or two-character
  // secret that shreds the substrate's stderr into confetti — destroying the
  // diagnostic exactly when an operator needs it. The zero-length belt there
  // reasoned about this and stopped one character short of the reachable
  // boundary; this is where the boundary actually belongs. No registry PAT
  // alphabet in use (ghcr `ghp_…`, ECR, Harbor, ACR) is shorter than 8 bytes,
  // so nothing legitimate is refused.
  if (secret.length < 8) refuse("password is shorter than 8 bytes");
  if (secret.length > 512) refuse("password exceeds 512 bytes");
  // ssh concatenates argv into a remote command line: whitespace, control
  // characters and shell metacharacters must never reach it.
  if (/\s/.test(secret)) refuse("password contains whitespace");
  // A control character reaching ssh's remote command line is the injection
  // this guard exists to stop, so matching one is the entire intent here.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(secret)) refuse("password contains a control character");
  // `#` rides the class as defense-in-depth, not because of comment
  // semantics: create() ships the credential as its own argv element
  // (`--registry-auth USERNAME:PASSWORD`), ssh joins argv into one remote
  // command line, and there the password sits MID-WORD, glued to `USERNAME:` —
  // where a POSIX `#` does NOT start a comment. But every extra shell/quoting
  // layer between here and the substrate is a chance for it to land at the
  // start of a word, and refusing it costs a character no PAT alphabet uses.
  // (The genuinely dangerous splitter — whitespace — is refused above.)
  if (/["'`$\\;&|<>()!*?~^{}\[\]#]/.test(secret)) refuse("password contains a shell metacharacter");
}

/**
 * Refuse the private-registry path unless the deviation INV-IBOX-3 demands is
 * RECORDED (AC4).
 *
 * Passing a credential at all deviates from D8's "secrets never in argv":
 * redaction covers logs, and a host process table is not a log. INV-IBOX-3
 * therefore makes the private path conditional on an operator-RATIFIED
 * deviation — an unratified one being the exact failure mode that ADR exists to
 * unwind — and {@link assertRegistryAuth} cannot be that gate, because a shape
 * check says the credential is well-formed, never that anyone agreed to use it.
 *
 * The record lives where this driver ALREADY reads operator attestations: the
 * same `postureFile` `setPublic` refuses without. A second attestation surface
 * would be a second thing to forget, and the failure mode of forgetting is a
 * tenant taking the deviation silently by setting one env var.
 *
 * FAIL CLOSED in every arm — absent file, unparseable file, no record, a field
 * blank or missing, an expiry that is not a date or is already past. Refusal is
 * the default; only a COMPLETE record is consent, and the three fields the AC
 * names (`read:packages` scope, expiry, rotation owner) are exactly the three
 * facts that make a PAT's blast radius and lifetime auditable after the fact.
 */
export function assertRegistryAuthDeviation(postureFile: string): void {
  const refuse: (why: string) => never = (why) => {
    throw new ExeDevDriverError(
      "registry-auth-unratified",
      `the private-registry path requires a recorded, operator-ratified INV-IBOX-3 deviation at ${postureFile}, and ${why} — passing a registry credential puts it in the host process table, which redaction cannot cover`,
      `record the ratified deviation at ${postureFile}: {"vmSharing":"admins-only","registryAuthDeviation":{"scope":"read:packages","expiry":"<iso>","rotationOwner":"<owner or rota>"}} — or unset the credential and boot the public factory image`,
    );
  };
  let posture: unknown;
  try {
    posture = JSON.parse(readFileSync(postureFile, "utf8")) as unknown;
  } catch (e) {
    // Two failure classes, deliberately distinguished: an fs error's message is
    // path/errno text and safe to relay, but a V8 `JSON.parse` SyntaxError
    // QUOTES a snippet of the file it choked on — and the posture path is
    // operator-supplied, so a path mispointed at a secrets file would put file
    // content into this thrown, logged message. Fixed wording, no snippet.
    refuse(
      e instanceof SyntaxError
        ? "the attestation is not valid JSON"
        : `the attestation is unreadable (${(e as Error).message})`,
    );
  }
  const record = (posture as { registryAuthDeviation?: unknown })?.registryAuthDeviation;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    refuse('it records no "registryAuthDeviation"');
  }
  const { scope, expiry, rotationOwner } = record as Record<string, unknown>;
  // The scope is EXCLUSIVE, not merely named: `read:packages` is the least
  // privilege a pull needs, and a record listing broader scopes beside it
  // (`"repo admin:org read:packages"` is how GitHub renders a multi-scope PAT)
  // is a different deviation than the one INV-IBOX-3 contemplates — a
  // membership test would ratify an org-admin PAT through the least-privilege
  // gate. Round-2 strengthening beyond AC4's literal "naming" terms, pending
  // story ratification (same posture as the expiry arms below); the message
  // stays credential-free either way.
  const scopeTokens = typeof scope === "string" ? scope.split(/[\s,]+/).filter((t) => t.length > 0) : [];
  if (scopeTokens.length === 0 || !scopeTokens.every((t) => t === "read:packages")) {
    refuse('its registryAuthDeviation must name the PAT scope "read:packages" and no broader scope');
  }
  // ISO-8601 is ENFORCED, not just claimed: bare `Date.parse` accepts
  // engine-dependent forms ("March 1 2030") and — worse — a timezone-less
  // date-time parses in the HOST's local zone, so the same record would lapse
  // hours apart on differently-configured machines. Date-only is allowed
  // (`Date.parse("YYYY-MM-DD")` is spec'd UTC midnight); any date-time MUST
  // carry Z or an offset so the lapse instant is host-independent. Round-2
  // strengthening pending story ratification, like the lapsed-expiry refusal.
  const ISO_EXPIRY_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
  if (typeof expiry !== "string" || expiry.length === 0) {
    refuse('its registryAuthDeviation names no "expiry"');
  }
  const expiryStr = expiry as string;
  // The regex admits shapes like 2030-13-45 that name no real instant —
  // Date.parse is the second half of the same check, not a fallback.
  const expiresAt = ISO_EXPIRY_RE.test(expiryStr) ? Date.parse(expiryStr) : Number.NaN;
  if (Number.isNaN(expiresAt)) {
    // Present-but-malformed is a DIFFERENT fact from absent, and saying "names
    // no expiry" here sent the operator hunting a field that exists.
    refuse(
      'its registryAuthDeviation "expiry" is present but not ISO-8601 (want YYYY-MM-DD, or a date-time with Z or a ±hh:mm offset so the lapse instant is host-independent)',
    );
  }
  // A ratification with a passed expiry is a lapsed ratification. Refusing here
  // costs one box create; not refusing costs a PAT that expires mid-fleet and
  // breaks every box create at once, with nothing having said it was coming.
  //
  // A DATE-ONLY value means "valid THROUGH that day", not "valid until its
  // first instant". `Date.parse("2026-09-03")` is UTC midnight, so the strict
  // `<=` refused every box on the very day an operator wrote the record — the
  // ratification lapsed before the ink dried. The date-time forms name an
  // instant and are compared as written; only the 10-character date form gets
  // the day it names.
  const lapsesAt = expiryStr.length === 10 ? expiresAt + 86_400_000 : expiresAt;
  if (lapsesAt <= Date.now()) {
    refuse(`the recorded PAT expiry ${JSON.stringify(expiry)} has passed — re-ratify or rotate the PAT`);
  }
  if (typeof rotationOwner !== "string" || rotationOwner.trim().length === 0) {
    refuse('its registryAuthDeviation names no "rotationOwner" — an unowned credential is one nobody rotates');
  }
}



/** Options for {@link ExeDevDriver}. Every field is injectable; none is env-magic. */
export interface ExeDevDriverOptions {
  /** Command seam. Defaults to the production `sshCommand()` runner. */
  run?: ExeCommand;
  /** Path to the `vm-sharing: admins-only` operator attestation (INV-1).
   *  Defaults to {@link DEFAULT_POSTURE_FILE}. */
  postureFile?: string;
  /** Per-exec default ceiling (ms). */
  execTimeoutMs?: number;
  /** Propagated from the dispatch that created the run record (§5.2). */
  requestId?: string;
  /** The box's public hostname suffix. exe.dev derives `<name>.exe.xyz`. */
  hostSuffix?: string;
  /** Boot image reference. Defaults to the digest pin {@link DEFAULT_IMAGE_REF}. */
  image?: string;
  /**
   * `USERNAME:PASSWORD` for a PRIVATE registry — DEFAULT-OFF (AC4).
   *
   * Unset on our own production path: the factory image is published PUBLIC, so
   * no credential reaches the ssh argv at all and D8's "secrets never in argv"
   * holds by construction rather than by mitigation. This field exists for the
   * tenant case — a customer booting from their OWN private mirror — and when
   * set it deviates from D8 (redaction covers logs; a process table is not a
   * log), which INV-IBOX-3 requires be a RECORDED, operator-ratified choice.
   */
  registryAuth?: string;
  /** The `buildId` gate B demands the box prove. Pairs with {@link image}. */
  imageBuildId?: string;
}

// ─── the driver ─────────────────────────────────────────────────────────────

export class ExeDevDriver implements ProviderDriver {
  readonly name = "exedev";

  private readonly run: ExeCommand;
  private readonly postureFile: string;
  private readonly execTimeoutMs: number;
  /** Propagation id (§5.2) — an id, never a credential. */
  readonly requestId: string;
  private readonly hostSuffix: string;
  /** The boot image this driver pins (AC3). Public: gate B reads it. */
  readonly image: string;
  /** The `buildId` gate B demands the box prove (INV-IBOX-2). */
  readonly imageBuildId: string;
  /** DEFAULT-OFF private-registry credential. Never logged, never persisted. */
  private readonly registryAuth?: string;

  constructor(opts: ExeDevDriverOptions = {}) {
    // round 6: constructor is the injection point — validate at the trust boundary
    if (opts.execTimeoutMs !== undefined && (!Number.isFinite(opts.execTimeoutMs) || opts.execTimeoutMs < 1)) {
      throw new ExeDevDriverError("exec-timeout-invalid", `execTimeoutMs ${opts.execTimeoutMs} must be a finite number >= 1 ms`, "pass a positive millisecond ceiling");
    }
    if (opts.hostSuffix !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(opts.hostSuffix)) {
      throw new ExeDevDriverError("host-suffix-invalid", `hostSuffix ${JSON.stringify(opts.hostSuffix)} is not a plain suffix (charset [A-Za-z0-9.-], no leading dot/dash)`, "pass a suffix like exe.xyz");
    }
    // DF2.10 AC3: BOTH image flags are validated HERE, at the same trust
    // boundary — not inside create(). The default is applied first and
    // validated too, so a malformed pin is caught at construction rather than
    // on the first box create, when a run is already in flight.
    this.image = opts.image ?? DEFAULT_IMAGE_REF;
    assertImageRef(this.image);
    this.imageBuildId = opts.imageBuildId ?? DEFAULT_IMAGE_BUILD_ID;
    // The buildId never reaches argv — it is compared with `===` and named in a
    // message — so this is not an injection guard. It is a TYPO guard: an empty
    // or whitespace-only pin refuses every box at gate B with a message that
    // reads as a marker problem, when the fault is one config value. The
    // grammar is what `deriveBuildId` actually emits (16 lowercase hex).
    if (!/^[0-9a-f]{16}$/.test(this.imageBuildId)) {
      throw new ExeDevDriverError(
        "image-build-id-invalid",
        `imageBuildId ${JSON.stringify(this.imageBuildId)} is not a build id (want 16 lowercase hex, as scripts/build-exedev-image.ts derives)`,
        "pass the buildId the image was built with — the build script prints it, and the box repeats it in /etc/qds-image.json",
      );
    }
    this.postureFile = opts.postureFile ?? DEFAULT_POSTURE_FILE;
    if (opts.registryAuth !== undefined) {
      assertRegistryAuth(opts.registryAuth);
      // AC4: shape first, then RATIFICATION. Both refuse at the same trust
      // boundary the image flags do — in the constructor, before any command
      // exists, so no box is created (and paid for) against a deviation nobody
      // recorded.
      assertRegistryAuthDeviation(this.postureFile);
      this.registryAuth = opts.registryAuth;
    }
    this.run = opts.run ?? sshCommand();
    this.execTimeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.requestId = opts.requestId ?? newRequestId();
    this.hostSuffix = opts.hostSuffix ?? "exe.xyz";
    // A tag is a LEGAL image reference (the D7 tenant mirror needs one) and it
    // is also the disease this story treats: `:latest` moves under us. So it is
    // admitted and ANNOUNCED — `imageDigest: null` on every create event is a
    // silence an operator has to notice, while this line names the condition
    // once, at the seam where the override was taken.
    if (imageDigestOf(this.image) === null) {
      this.emit("image_not_digest_pinned", {
        imageRef: this.image,
        why: "the effective boot image is pinned by TAG, which is mutable — a rebuild moves it under this fleet; gate B still proves the buildId, but nothing pins the bytes the host pulls",
      });
    }
    // AC3 authorizes the override; INV-IBOX-2 requires it never be SILENT.
    // The tag arm above fires only for a MUTABLE pin, so a digest-shaped
    // override — the easy path, since the pair is both-or-neither and an
    // operator setting QDS_EXEDEV_IMAGE sets its buildId in the same breath —
    // rode `imageRef`/`imageBuildId` through the create events looking exactly
    // like the repo pin. Gate B then passes, because it checks the box against
    // THIS driver's claim rather than against the repo's: an image no review of
    // this repo covers, booted indistinguishably from one that was reviewed.
    // Announced once per DRIVER CONSTRUCTION — not once per fleet, and the
    // difference is worth stating because `resolveDriver`
    // (`src/providers/index.ts:36-43`) does not memoize: it calls the registered
    // factory on every resolution, so a fanout that resolves per box constructs
    // N drivers and emits N of these. The line is still self-contained (it
    // carries both halves of the pin), and every `create()` event carries the
    // same `imageRef`/`imageDigest`/`imageBuildId` beside a real `runId`, which
    // is the join an operator actually uses. Memoizing the registry factory is
    // the fix for the duplication and it belongs there, not here.
    //
    // `runId: null` on this line is honest rather than a gap: no run exists at
    // construction. The Observability Contract's join key is supplied by
    // `imageFields`, which every create event goes through.
    //
    // Either half is enough to fire it — half a pin is refused at the factory,
    // but a direct `new ExeDevDriver({imageBuildId})` (the documented test
    // seam) is not.
    if (this.image !== DEFAULT_IMAGE_REF || this.imageBuildId !== DEFAULT_IMAGE_BUILD_ID) {
      this.emit("image_override", {
        imageRef: this.image,
        imageDigest: imageDigestOf(this.image),
        imageBuildId: this.imageBuildId,
        why: "this driver boots an image OTHER than the repo pin (QDS_EXEDEV_IMAGE/QDS_EXEDEV_IMAGE_BUILD_ID, or an explicit option) — gate B proves the box against THIS pair, not against DEFAULT_IMAGE_REF, so a green gate says nothing about whether the bytes were reviewed here",
      });
    }
    // `isUnpinnedImage` had TWO enforcement points named in its docblock —
    // `image-contract.test.ts` and the publish workflow — and BOTH cover only
    // the repo pin. Nothing consulted the predicate on the runtime path, so
    // `QDS_EXEDEV_IMAGE=ghcr.io/x/y@sha256:000…0` sailed through: it is a
    // well-formed digest by construction (that is the sentinel's whole design),
    // it satisfies the both-or-neither guard, and it booted with nothing but
    // the generic `image_override` line above.
    //
    // ANNOUNCED, not refused, and deliberately: `UNPINNED_DIGEST`'s own
    // docblock requires the sentinel to still CONSTRUCT — the bootstrap ritual
    // needs exactly that run to build and push, and a throwing constructor
    // would break the provider layer for a bookkeeping reason. So this is the
    // line that says the boot reference resolves to nothing pullable, on the
    // one path (an override) where no merge gate is watching.
    if (isUnpinnedImage(this.image)) {
      this.emit(
        "image_sentinel",
        {
          imageRef: this.image,
          imageDigest: imageDigestOf(this.image),
          imageBuildId: this.imageBuildId,
          why: "the effective boot image is the all-zeros 'no digest recorded yet' SENTINEL — no registry can serve it, so every create will fail at the host-side pull; this is expected only during the image bootstrap ritual",
        },
        "error",
      );
    }
  }

  /** `<name>.exe.xyz` — the MEASURED derivation (create.just:121-122). */
  boxHost(vm: string): string {
    // round 6: hostname construction is the trust boundary
    assertValidRunId(vm);
    return `${vm}.${this.hostSuffix}`;
  }

  /** URL derivation used by both `create`'s fallback and `expose`. */
  derivedUrl(vm: string): string {
    return `https://${this.boxHost(vm)}`;
  }

  private control(sub: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<ExecResult> {
    return this.run(["ssh", "exe.dev", ...sub], opts);
  }

  /**
   * Remove the registry credential from substrate output before it is logged.
   *
   * exe.dev's own stderr can echo the argv it received. Redaction covers logs —
   * it does NOT cover the host process table, which is why the private path
   * requires a ratified deviation rather than merely this scrub (INV-IBOX-3).
   *
   * BOTH SECRET-BEARING spellings are scrubbed — the full `USERNAME:PASSWORD`
   * pair and the bare password — and the password half is the one that matters:
   * a control plane that echoes only the secret, or renders the pair quoted,
   * defeats an exact `USERNAME:PASSWORD` match, and the failure mode of that
   * miss is a credential in a log. Longest-first, so the full pair is replaced
   * as a pair rather than leaving a bare username behind.
   *
   * The BARE USERNAME is deliberately NOT scrubbed, and "both spellings" never
   * meant it. A control plane that masks the password itself (`--registry-auth
   * qdsbot:***`, which several registries and CLIs do) therefore leaves the
   * PAT's owning account name in the log. That is the intended trade: the
   * username is the field `assertRegistryAuth` constrains to a plain
   * `[A-Za-z0-9._-]` token — often a short one like `qdsbot` — and splitting
   * the message on it would shred every unrelated occurrence of that token,
   * which is the same confetti failure the length floor above exists to
   * prevent. An account name is not the credential; the PAT is.
   *
   * COVERAGE, stated honestly: `split(secret)` matches a CONTIGUOUS substring
   * only. A secret the control plane wrapped across a line, hyphenated, or
   * otherwise interrupted is NOT redacted by this — it is a substring match,
   * not a fuzzy one, and claiming otherwise would let a reviewer take this
   * function for a guarantee it cannot give. The guarantee INV-IBOX-3 actually
   * rests on is the ratified deviation (`assertRegistryAuthDeviation`); this is
   * the cheap second layer over the echo shapes we have measured.
   */
  private redactRegistryAuth(text: string): string {
    if (this.registryAuth === undefined || text.length === 0) return text;
    const secret = this.registryAuth.slice(this.registryAuth.indexOf(":") + 1);
    // Belt only: `assertRegistryAuth` refuses an empty password before
    // `this.registryAuth` is ever assigned, so `secret` cannot be "" today.
    // But `text.split("")` interleaves the redaction marker between every
    // character, destroying the message exactly when an operator needs it —
    // cheap to make impossible rather than merely currently-unreachable.
    if (secret.length === 0) return text;
    return text
      .split(this.registryAuth)
      .join("[registry-auth redacted]")
      .split(secret)
      .join("[registry-auth redacted]");
  }

  /**
   * The identity and image fields every create event carries (Observability
   * Contract: `{ requestId, runId, event, imageRef, imageDigest,
   * registryAuthUsed }`).
   *
   * One accessor so no call site can forget one, and — the point — so no call
   * site can accidentally add the credential: `registryAuthUsed` is the only
   * thing said about it anywhere, and it is a boolean.
   */
  private imageFields(name: string): Record<string, unknown> {
    return {
      // The Observability Contract names `runId` on EVERY create event, and
      // `emit` hardcodes `runId: null` for the events (list/expose anomalies)
      // whose subject is not a run of ours. A create's `name` IS a run id —
      // `create()` gates it through `assertValidRunId` before any command — so
      // the contract's stated purpose ("a boot regression joins to its image
      // digest without a second key") held for `vm` and failed for the field
      // the contract actually names. Threaded through this one accessor for
      // the reason the accessor exists: no create site can forget a field.
      vm: name,
      runId: name,
      imageRef: this.image,
      imageDigest: imageDigestOf(this.image),
      // The half of the pin gate B actually compares. Without it, a run whose
      // marker assertion was re-pointed by an env override left no trace of it.
      imageBuildId: this.imageBuildId,
      registryAuthUsed: this.registryAuth !== undefined,
    };
  }

  /** Observability line for shape provenance the primitive proxy cannot know. */
  private emit(op: string, fields: Record<string, unknown>, outcome: "ok" | "error" = "ok"): void {
    log({
      requestId: this.requestId,
      operation: `exedev.${op}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: outcome,
      runId: null,
      driver: this.name,
      ...fields,
    });
  }

  // ── primitives: control plane ─────────────────────────────────────────────

  async create(name: string, tag?: string): Promise<ProviderVm> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    // INV-2: the name becomes a public hostname; refuse before any command.
    assertValidRunId(name);
    // INV-2 (same trust boundary): tag interpolates into ssh argv, which ssh
    // concatenates into the remote command line — validate before any command.
    if (tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
      throw new ExeDevDriverError(
        "tag-invalid",
        `tag ${JSON.stringify(tag)} is not a plain token (charset [A-Za-z0-9._-], must start alphanumeric)`,
        "pass a plain tag: letters, digits, dot, underscore, dash; must start alphanumeric",
      );
    }
    // DF2.10 Observability Contract: the request is logged BEFORE the command,
    // so a create that never returns still joins to the image it asked for.
    // `registryAuthUsed` is a BOOLEAN — the credential itself appears in no
    // field, under no event (INV-IBOX-3).
    const createStartedAt = Date.now();
    // `create_ms: 0` rather than absent: the Observability Contract's "a field
    // never evaluated reports 0" — this event is emitted before the command,
    // so the duration is not unknown, it is zero elapsed.
    this.emit("create_requested", { ...this.imageFields(name), create_ms: 0 });
    // The credential rides argv, so BOTH failure shapes have to be scrubbed and
    // attributed — not just the non-zero exit. A rejection (spawn ENOENT, an
    // exec timeout, a transport abort) routinely carries the whole argv in
    // `err.message`, and that one used to propagate out of `create()`
    // unredacted and with no `create_failed` line: unattributed AND leaking.
    let res: ExecResult;
    try {
      // The ratification is re-asserted per CREATE, not only at construction: a
      // driver instance outlives its construction by hours on a fleet fan-out,
      // and a ratification that lapses (or a posture file that is revoked)
      // mid-fleet must stop the NEXT box create with the typed refusal — not
      // surface later as a mid-fleet mystery the constructor-time check
      // advertised protection against. One local file read per create; the
      // signature and the happy path are unchanged.
      //
      // INSIDE the observed window, deliberately: it used to run before
      // `create_requested` and outside this try, so the one NEW failure mode
      // this re-assertion introduced — a lapse mid-fleet — was the one create
      // failure that emitted no event at all. It now emits `create_requested`
      // then `create_failed` like every other refusal, and the catch preserves
      // its typed code (a lapse must never read as `create-failed`).
      if (this.registryAuth !== undefined) assertRegistryAuthDeviation(this.postureFile);
      res = await this.control([
        "new",
        "--name",
        name,
        ...(tag === undefined ? [] : ["--tag", tag]),
        // `--image` is UNCONDITIONAL — the constructor always assigns a pin, so
        // there is no path through create() that boots the substrate default.
        // That is the fail-safe posture: a conditional spread here would
        // reintroduce an unpinned boot path. `--registry-auth` is the genuinely
        // conditional one (default-off). Both values were validated in the
        // constructor, before any command existed.
        "--image",
        this.image,
        ...(this.registryAuth === undefined ? [] : ["--registry-auth", this.registryAuth]),
        "--json",
      ]);
    } catch (e) {
      // `mayExist` is the field a REAPER can act on, and it is why this arm is
      // not interchangeable with the non-zero-exit arm below despite both
      // emitting `create_failed`. A rejection here means the command was issued
      // and NO answer came back — an exec timeout or a transport abort that
      // landed AFTER exe.dev already accepted the `new` leaves a box alive and
      // billing, and its only trace was an `exitCode: null` identical in shape
      // to a spawn ENOENT where nothing was ever created. The remediation
      // string told a human to check; nothing told a machine.
      //
      // Reported `true` unconditionally on this arm because the two cases are
      // genuinely indistinguishable from here, and the fail-SAFE reading of an
      // unknown is "a box may be billing" — a reaper sweeping a name that was
      // never created is a no-op, the reverse is an invisible box. The
      // non-zero-exit arm below says `false`: the substrate ANSWERED and
      // refused, which is a decision, not a silence.
      this.emit(
        "create_failed",
        { ...this.imageFields(name), exitCode: null, mayExist: true, create_ms: Date.now() - createStartedAt },
        "error",
      );
      // An already-typed refusal keeps its code: relabelling it `create-failed`
      // would send the operator to "re-run" a fault that named its own
      // remediation — the exact anti-pattern the authFile read below refuses.
      //
      // SCRUBBED all the same. This used to rethrow typed errors untouched on
      // the assertion "our own typed errors never carry the credential" — true
      // of every refusal in this module today, but unverifiable AT THIS SEAM:
      // `this.run` is an INJECTED command seam, `ExeDevDriverError` is this
      // module's public error type, and the argv this call was built from
      // carries `--registry-auth USERNAME:PASSWORD`. Redaction costs one string
      // scan on a path that is already failing; the assertion cost a credential
      // in a log the first time any injected transport threw our own type.
      // A new instance only when something was actually removed, so the
      // ordinary case keeps its original stack.
      if (e instanceof ExeDevDriverError) {
        const scrubbed = this.redactRegistryAuth(e.message);
        throw scrubbed === e.message ? e : new ExeDevDriverError(e.code, scrubbed, e.remediation);
      }
      throw new ExeDevDriverError(
        "create-failed",
        `ssh exe.dev new --name ${name} --image ${this.image} did not complete: ${this.redactRegistryAuth(e instanceof Error ? e.message : String(e))}`,
        "re-run; the VM may not exist — confirm with `ssh exe.dev ls --json`; if the failure is an image pull, mirror the pin (crane copy) and set QDS_EXEDEV_IMAGE + QDS_EXEDEV_IMAGE_BUILD_ID",
      );
    }
    const createMs = Date.now() - createStartedAt;
    if (res.exitCode !== 0) {
      // The stderr tail can echo the argv exe.dev received, credential and all.
      // Scrub before it reaches an error message that will be logged.
      const stderr = this.redactRegistryAuth(res.stderr.trim());
      this.emit(
        "create_failed",
        { ...this.imageFields(name), exitCode: res.exitCode, mayExist: false, create_ms: createMs },
        "error",
      );
      // `--image` is UNCONDITIONAL (see the argv comment above), which is the
      // right fail-safe posture and also a new CORRELATED failure class this
      // driver did not have before it: a GHCR outage, an anonymous-pull rate
      // limit, the package flipped private or a pruned digest makes the
      // host-side pull fail for EVERY box in a fanout at once. Each attempt
      // then costs a create the driver refuses to destroy (INV-5), so a fanout
      // that keeps going burns N boxes against a registry that is down.
      //
      // Emitted BESIDE `create_failed`, not instead of it: the generic line is
      // the one every consumer already reads, and this is the extra fact a
      // fanout needs to circuit-break on. A heuristic over the substrate's own
      // stderr is all that is available — exe.dev reports the pull failure in
      // prose — so it is additive only and nothing branches on it here.
      if (/\b(pull|manifest|unauthorized|denied|not found|no such image|toomanyrequests)\b/i.test(stderr)) {
        this.emit("image_pull_failed", { ...this.imageFields(name), exitCode: res.exitCode, why: "the substrate's refusal reads as a host-side IMAGE PULL failure, which is fleet-wide rather than per-box: every arm of a fanout will fail the same way until the registry serves this digest again" }, "error");
      }
      throw new ExeDevDriverError(
        "create-failed",
        `ssh exe.dev new --name ${name} --image ${this.image} exited ${res.exitCode}: ${stderr}`,
        // The mirror clause is the recovery for the one failure "re-run" cannot
        // fix: the pinned digest 404ing at the host-side pull (registry outage,
        // pruned tag). crane copy preserves the digest, so gate B still passes.
        "re-run; the VM may not exist — confirm with `ssh exe.dev ls --json`; if the failure is an image pull, mirror the pin (crane copy) and set QDS_EXEDEV_IMAGE + QDS_EXEDEV_IMAGE_BUILD_ID",
      );
    }
    // UNVERIFIED shape: accept vm_name at top level or under data/vm. Anything
    // else is a miss — never a guess (AC5).
    const parsed = parseJson(res.stdout, "new");
    const raw =
      pickObject(parsed) ??
      pickObject(parsed?.data) ??
      pickObject(parsed?.vm);
    if (raw?.vm_name === name) {
      // round 6: the log must state where the URL actually came from
      const rawUrl = typeof raw.https_url === "string" && raw.https_url.length > 0 ? raw.https_url : null;
      const httpsUrl = rawUrl ?? this.derivedUrl(name);
      this.emit("create_shape", { verified: rawUrl ? "new-shape" : "derived", ...this.imageFields(name), create_ms: createMs });
      await this.provisionSteeringChannel(name);
      return { name, httpsUrl };
    }
    // Fallback 1: re-read the one VERIFIED shape.
    const ls = await this.list(name);
    const hit = ls.find((v) => v.name === name);
    if (hit) {
      const httpsUrl = hit.httpsUrl ?? this.derivedUrl(name);
      this.emit("create_shape", { verified: hit.httpsUrl ? "ls-shape" : "derived", ...this.imageFields(name), create_ms: createMs });
      await this.provisionSteeringChannel(name);
      return { name, httpsUrl };
    }
    // Fallback 2 exhausted: fail CLOSED. The `new` already ran at the
    // substrate, so the VM may exist — name it in the error so an operator
    // (and DF2.6's reaper) can still find it. Never destroy it here (INV-5).
    this.emit("create_shape", { verified: "unresolved", ...this.imageFields(name), create_ms: createMs }, "error");
    throw new ExeDevDriverError(
      "create-shape-unresolved",
      `exe.dev 'new --name ${name}' succeeded but no recognized response shape named the VM, and 'ls ${name} --json' does not list it — refusing to guess; the VM may be live and unrecorded`,
      "ssh exe.dev ls --json  # find the VM by name; rm it via the DF2.5 teardown path if orphaned",
    );
  }

  async list(name?: string): Promise<ProviderVm[]> {
    return (await this.listWithAnomalies(name)).vms;
  }

  /**
   * Give a freshly created box its steering channel (see
   * `STEERING_PROVISION_SCRIPT` for the contract and its measured history).
   * Runs on BOTH create success arms — a box born through the AC5 fallback is
   * just as much a steering target as one born through the recognized shape.
   */
  private async provisionSteeringChannel(name: string): Promise<void> {
    const res = await this.exec(name, ["sh", "-c", STEERING_PROVISION_SCRIPT]);
    if (res.exitCode !== 0) {
      this.emit("steering_provision", { vm: name, exitCode: res.exitCode }, "error");
      const failure = steeringProvisionFailure(name, res.exitCode, res.stderr, this.execTimeoutMs);
      throw new ExeDevDriverError("steering-channel-unprovisionable", failure.message, failure.remediation);
    }
    this.emit("steering_provision", { vm: name });
  }

  /**
   * `list()`, plus the box identifiers this driver refused to name.
   *
   * Two unusable rows, two DIFFERENT dispositions, and the split is the whole
   * design:
   *
   *  - `vm_name` UNREADABLE (not a string, absent). Nothing says what this row
   *    is, so it may be OURS — a live box `reapRuns` cannot see and cannot
   *    reap, spend nobody is accountable for. It rides out as an ANOMALY and
   *    the fleet refuses to reap until it is resolved.
   *  - `vm_name` READABLE but outside every factory grammar. Provably NOT
   *    ours: no build of this factory ever named a box outside the LEGACY id
   *    grammar. It is EXCLUDED from the population and logged — see the call
   *    site for why refusing here would be the unsafe choice, not the safe
   *    one. A name inside the LEGACY grammar but outside the STRICT one (a
   *    `trailing-` box from an earlier build) is POSSIBLY ours and is LISTED.
   *
   * An anomaly has to be FOLLOWABLE, which the bare `vms[3]` placeholder was
   * not: no box is named `vms[3]`, and this is an ACCOUNT-WIDE listing (no name
   * filter), so the index is not even stable between calls. Every other
   * identifying field the row carries — `ssh_dest`, `https_url`, an id, a tag —
   * rides the anomaly instead of being discarded, because those are what an
   * operator matches the row back to a real box with.
   *
   * `FakeDriver.listWithAnomalies` reports a bad NAME as an anomaly, and that
   * is not divergence from this — it is the same rule ("anything that might be
   * ours and is unaccounted-for stops the sweep") over a population of
   * different provenance. `.sandbox/fake-boxes` is OUR directory, so a stray
   * entry in it is suspicious by definition; this account is shared with
   * strangers, so a stranger's box is expected and must not stop anything.
   */
  async listWithAnomalies(name?: string): Promise<ProviderVmListing> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    const res = await this.control(["ls", ...(name === undefined ? [] : [name]), "--json"]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "ls-failed",
        `ssh exe.dev ls exited ${res.exitCode}: ${res.stderr.trim()}`,
        "re-run; exe.dev may be unreachable",
      );
    }
    const shape = parseJson(res.stdout, "ls") as LsShape | null;
    if (shape === null || !Array.isArray(shape.vms)) {
      throw new ExeDevDriverError(
        "ls-unparseable",
        "ssh exe.dev ls --json returned a body without a vms array",
        "re-run `ssh exe.dev ls --json` by hand and compare the shape",
      );
    }
    const skipped: string[] = [];
    const vms = shape.vms.flatMap((v, i): ProviderVm[] => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        // Redacted before it leaves the driver: the raw JSON body can carry
        // `ssh_dest`/`https_url` values that embed credentials (`ghs_…` in a
        // clone URL), and these strings reach error messages and log lines.
        skipped.push(redactSecrets(`vms[${i}] (row is not an object: ${truncate(boundedJson(v) ?? String(v))})`));
        return [];
      }
      const row = v as Record<string, unknown>;
      const vmName = typeof row.vm_name === "string" ? row.vm_name : null;
      if (vmName === null) {
        skipped.push(redactSecrets(`vms[${i}] (vm_name is not a string; ${rowIdentity(row)})`));
        return [];
      }
      // Ownership classification for a READABLE name, against the documented
      // run-id grammars (run-record.ts):
      //
      //  - Passes the LEGACY grammar (`assertExistingRunId` — the rule every
      //    existing-box path accepts): POSSIBLY ours. An earlier build created
      //    box names under exactly this rule (`trailing-` ids exist on disk by
      //    construction), so dropping the row here hid a live factory box from
      //    every listing forever — billed, unreapable, unreported. It rides in
      //    `vms` instead; whether it may be DESTROYED stays with
      //    `isFactoryOwnedVm`, which this listing can never satisfy anyway
      //    (no tag channel), so the fail-safe direction is unchanged.
      //  - Fails even the LEGACY grammar: provably NOT ours — no build of this
      //    factory ever named a box outside it, so this is a stranger's box in
      //    the same account. EXCLUDED — not in `vms`, not in `skipped` — and
      //    logged.
      //
      // Passing a stranger's box through is worse than excluding it: `reapRuns`
      // destroys every box no open record claims, so it gets destroyed (and
      // `destroy` would throw on the name anyway, mid-sweep). Reporting it as
      // an anomaly is worse still: this listing is ACCOUNT-WIDE, so one
      // stranger's box stalls the sweep for the whole account and OUR boxes
      // bill forever — trading a bounded risk for an unbounded one. Exclusion
      // avoids both, and the co-tenant protection holds: nothing excluded here
      // is ever claimed or destroyed downstream.
      let mine = true;
      try {
        assertExistingRunId(vmName);
      } catch {
        mine = false;
      }
      if (!mine) {
        // Redacted like every sibling anomaly string: a name failing the
        // grammar is provider free text, and it can embed credential-shaped
        // material (`ghs_…` in a URL fragment) — truncation alone does not
        // scrub it. `emit`'s fields land verbatim in the JSONL log stream.
        this.emit("list_excluded_foreign_name", {
          vm: redactSecrets(truncate(vmName)),
          verb: "list",
          outcome: "excluded",
          reason: "vm_name is outside every factory box-name grammar — not a box this driver created (nor any earlier build)",
        });
        return [];
      }
      return [
        {
          name: vmName,
          ...(typeof row.https_url === "string" && row.https_url.length > 0 ? { httpsUrl: row.https_url } : {}),
        },
      ];
    });
    return { vms, skipped };
  }

  /**
   * Idempotent by contract (teardownRun/reapRuns both retry): a `rm` failure is
   * confirmed against `ls` content — "not found" is the goal state, not an error.
   *
   * F7 (2026-08-24): `rm` exit 0 is the substrate's CLAIM, not the state — a
   * live incident left a box alive behind an rm that had exited 0. Absence is
   * therefore VERIFIED by `ls` after every successful rm; a box that survives
   * its own rm-ack gets exactly one retry before destroy fails closed.
   */
  async destroy(vm: string): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    let lastRm: { exitCode: number; stderr: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.control(["rm", vm]);
      if (res.exitCode !== 0) {
        lastRm = { exitCode: res.exitCode, stderr: res.stderr };
        break; // fall through to the content check — maybe it died anyway
      }
      lastRm = { exitCode: res.exitCode, stderr: res.stderr };
      const remaining = await this.list(vm);
      if (remaining.length === 0) return; // CONFIRMED gone by real state
      // rm claimed success but the box is still listed — retry once.
    }
    const remaining = await this.list(vm);
    if (remaining.length === 0) return; // already gone — idempotent success
    throw new ExeDevDriverError(
      "rm-failed",
      `ssh exe.dev rm ${vm} exited ${lastRm?.exitCode} and the VM is still listed after one retry: ${lastRm?.stderr.trim()}`,
      `ssh exe.dev rm ${vm}  # then confirm with: ssh exe.dev ls ${vm} --json`,
    );
  }

  async expose(vm: string, port: number): Promise<string> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ExeDevDriverError("invalid-port", `invalid port: ${port}`, "pass an integer 1-65535");
    }
    const res = await this.control(["share", "port", vm, String(port)]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "share-port-failed",
        `ssh exe.dev share port ${vm} ${port} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `retry, or inspect the port with: ssh exe.dev ls ${vm} --json`,
      );
    }
    // The command's own output shape is [VERIFY]; the <name>.exe.xyz derivation
    // is the MEASURED one, so the URL is derived and recorded as such.
    this.emit("expose", { vm, port, verified: "derived" });
    return this.derivedUrl(vm);
  }

  /**
   * INV-1: refuses without the recorded `vm-sharing: admins-only` operator
   * attestation (spec §3.5 — team sharing defaults OPEN and must be flipped
   * day one). The refusal fires BEFORE any share command is issued.
   */
  async setPublic(vm: string): Promise<void> {
    assertValidRunId(vm);
    let posture: unknown;
    try {
      posture = JSON.parse(readFileSync(this.postureFile, "utf8")) as unknown;
    } catch (e) {
      throw new ExeDevDriverError(
        "posture-attestation-missing",
        `cannot read the vm-sharing posture attestation at ${this.postureFile} (${(e as Error).message}) — setPublic refuses: team sharing defaults open and a public box breaks one-run-per-box isolation`,
        `flip 'vm-sharing admins-only' in the exe.dev team settings, record it once: {"vmSharing":"admins-only","attestedAt":"<iso>"} at ${this.postureFile}, then re-run`,
      );
    }
    const vmSharing = (posture as { vmSharing?: unknown })?.vmSharing;
    if (vmSharing !== "admins-only") {
      throw new ExeDevDriverError(
        "posture-attestation-missing",
        `posture file ${this.postureFile} records vmSharing=${JSON.stringify(vmSharing)}, not "admins-only" — setPublic refuses`,
        `flip 'vm-sharing admins-only' in the exe.dev team settings, then update ${this.postureFile}`,
      );
    }
    const res = await this.control(["share", "set-public", vm]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "share-set-public-failed",
        `ssh exe.dev share set-public ${vm} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `retry, or check the org setting: ssh exe.dev share set-public ${vm}`,
      );
    }
  }

  /** Preflight (Infra Prerequisites): names the account BEFORE any record exists. */
  async whoami(): Promise<string> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    const res = await this.control(["whoami"]);
    const account = res.stdout.trim();
    // INV-3: exit 0 with empty output is "no answer", not "verified identity".
    if (res.exitCode !== 0 || account.length === 0) {
      throw new ExeDevDriverError(
        "whoami-failed",
        `ssh exe.dev whoami did not identify the account (exit ${res.exitCode}, output ${JSON.stringify(account)})`,
        "fix local exe.dev SSH access (ssh exe.dev whoami must print the account) before any run is created",
      );
    }
    return account;
  }

  // ── primitives: box access ────────────────────────────────────────────────

  /**
   * `exec` is every fill/setup/execute path: one `ssh <vm>.exe.xyz <command>`
   * where `<command>` is the argv POSIX-quoted and joined — ssh semantics
   * concat trailing args into one remote command line, so quoting once here is
   * quoting once, period. argv elements are never interpolated into a local
   * shell: Bun.spawn takes the array verbatim.
   */
  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    assertValidRunId(vm);
    // round 6: an empty element ships a no-op ssh command
    // round 7: reject whitespace-only elements (no-op substrings)
    // DF1.10 round 3 (C2-2): also reject INVISIBLY-blank elements — SHY, ZWSP
    // and WORD JOINER sit outside ECMAScript's WhiteSpace, so a ZWSP-only
    // element rode `trim()` onto the command line as a no-op nobody could see
    // (BOM/ZWNBSP is in INVISIBLE_BLANK_RE for one-spelling parity with the
    // fake; `trim()` already strips it).
    // ONE predicate for both: `""` trims to `""`, so `a.length === 0` never
    // decided anything the trim did not already. Same rule, same spelling, as
    // the fake this mirrors (`fake-driver.ts` spawnExec).
    if (argv.length === 0 || argv.some((a) => a.replace(INVISIBLE_BLANK_RE, "").trim().length === 0))
      throw new ExeDevDriverError("empty-argv", "exec requires a non-empty argv with no empty or whitespace-only elements", "pass the command argv");
    const command = argv.map(shQuote).join(" ");
    return this.run(["ssh", this.boxHost(vm), command], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: this.execTimeoutMs,
    });
  }

  /** Same as {@link exec} with a per-call timeout — the gate's per-assertion budget. */
  async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    assertValidRunId(vm);
    // round 6: an empty element ships a no-op ssh command
    // round 7: reject whitespace-only elements (no-op substrings)
    // DF1.10 round 3 (C2-2): also reject INVISIBLY-blank elements — SHY, ZWSP
    // and WORD JOINER sit outside ECMAScript's WhiteSpace, so a ZWSP-only
    // element rode `trim()` onto the command line as a no-op nobody could see
    // (BOM/ZWNBSP is in INVISIBLE_BLANK_RE for one-spelling parity with the
    // fake; `trim()` already strips it).
    // ONE predicate for both: `""` trims to `""`, so `a.length === 0` never
    // decided anything the trim did not already. Same rule, same spelling, as
    // the fake this mirrors (`fake-driver.ts` spawnExec).
    if (argv.length === 0 || argv.some((a) => a.replace(INVISIBLE_BLANK_RE, "").trim().length === 0))
      throw new ExeDevDriverError("empty-argv", "exec requires a non-empty argv with no empty or whitespace-only elements", "pass the command argv");
    const command = argv.map(shQuote).join(" ");
    return this.run(["ssh", this.boxHost(vm), command], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs,
    });
  }

  // ── lifecycle: the exedev-specific verbs composed over the primitives ─────
  // DF2.1's seam stays eight primitives; `fill`/`setup` are extra methods on
  // this class (structural typing — the interface is untouched), so the
  // E2E chain is driver.create() → driver.fill() → driver.setup().

  /** Clone + pin + `sbx/<run-id>` branch (see fill.ts). */
  fill(vm: string, opts: FillOptions): Promise<void> {
    return fillExeDev(this, vm, opts);
  }

  /** The five-assertion setup gate (see setup-gate.ts) — a method, not a
   *  process: failure RETURNS a payload and leaves the VM alive (AC1, INV-5). */
  setup(vm: string, opts: SetupGateOptions): Promise<SetupGateResult> {
    return setupGate(this, vm, opts);
  }

  /** Box → host only (the seam's rule). The remote path is grammar-checked
   *  before it is ever placed in a `vm.exe.xyz:` scp argument. */
  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    assertBoxPathSafe(remotePath);
    const res = await this.run(["scp", "-q", `${this.boxHost(vm)}:${remotePath}`, localPath], {
      timeoutMs: this.execTimeoutMs,
    });
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "copy-file-failed",
        `scp ${vm}:${remotePath} → ${localPath} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `confirm the artifact exists: ssh ${this.boxHost(vm)} "ls -l '${remotePath}'"`,
      );
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Anomaly strings land in an error message and a log line — bound their size. */
const ANOMALY_VALUE_MAX = 120;
function truncate(s: string): string {
  return s.length <= ANOMALY_VALUE_MAX ? s : `${s.slice(0, ANOMALY_VALUE_MAX)}…`;
}

/**
 * Bounded stringify: `JSON.stringify` runs to completion before `truncate`
 * gets its cap, so one multi-megabyte provider row blocked the event loop for
 * the whole serialization regardless of the 120-char output ceiling (the same
 * hazard the roster read's byte bound exists for). The replacer form only
 * capped STRING leaves — it still had to VISIT every node to get there, so a
 * provider row with a hundred-thousand-element array was fully walked (and
 * its serialization buffer fully built) before any cap applied.
 *
 * So the value is PROJECTED into a bounded tree first, and only the projection
 * is serialized: traversal depth, object field count and array element count
 * each hit a hard ceiling, truncated containers render as `[…]`/`{…}`, strings
 * keep the leaf cap, and a final character budget bounds the serialized text.
 * `undefined` on serialization failure is preserved for `listWithAnomalies`'
 * `String(v)` fallback.
 */
const ANOMALY_DEPTH_MAX = 4;
const ANOMALY_FIELDS_MAX = 8;
const ANOMALY_ELEMS_MAX = 8;
const ANOMALY_JSON_MAX = 512;
function boundedJson(v: unknown): string | undefined {
  const project = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      return node.length > ANOMALY_VALUE_MAX ? `${node.slice(0, ANOMALY_VALUE_MAX)}…` : node;
    }
    if (Array.isArray(node)) {
      if (depth >= ANOMALY_DEPTH_MAX) return "[…]";
      return node.slice(0, ANOMALY_ELEMS_MAX).map((el) => project(el, depth + 1));
    }
    if (typeof node === "object" && node !== null) {
      if (depth >= ANOMALY_DEPTH_MAX) return "{…}";
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(node).slice(0, ANOMALY_FIELDS_MAX)) {
        out[k] = project(val, depth + 1);
      }
      return out;
    }
    return node;
  };
  try {
    // The projection bounds node count and leaf width; the slice bounds the
    // serialized TEXT. Every consumer passes the result through `truncate`
    // (120 chars) anyway — the 512-char budget just keeps the intermediate
    // buffer honest for any future consumer that skips it.
    return JSON.stringify(project(v, 0))?.slice(0, ANOMALY_JSON_MAX);
  } catch {
    return undefined; // a getter that threw mid-projection — fall through to String(v)
  }
}

/**
 * Whatever identifying fields a row this driver refused to name DOES carry.
 *
 * The refusal `reapRuns` raises on a skipped entry tells an operator to go find
 * it — so the entry has to be findable. `vms[3]` is not: no box is named that,
 * and the account-wide listing's row order is not stable between calls. The
 * row's remaining string fields (`ssh_dest`, `https_url`, an id, a tag) are the
 * only handles the substrate gave us, so they are surfaced rather than dropped.
 * Capped at four fields and truncated per value — this is a diagnostic, not a
 * dump of a provider payload.
 */
function rowIdentity(row: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (k === "vm_name" || typeof v !== "string" || v.length === 0) continue;
    fields.push(`${truncate(k)}=${truncate(boundedJson(v) ?? String(v))}`);
    if (fields.length === 4) break;
  }
  return fields.length === 0 ? "the row carries no other identifying field" : `row fields: ${fields.join(" ")}`;
}

/** Parse or fail with the command named — never pass a guess upstream. */
function parseJson(text: string, what: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    throw new ExeDevDriverError(
      `${what}-unparseable`,
      `exe.dev ${what} returned a body that is not a JSON object`,
      `run 'ssh exe.dev ${what} --json' by hand and compare the shape`,
    );
  }
}

/** A candidate `new --json` body is recognized only if it carries `vm_name`. */
function pickObject(v: unknown): { vm_name?: unknown; https_url?: unknown } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as { vm_name?: unknown; https_url?: unknown };
  return typeof o.vm_name === "string" ? o : null;
}

/**
 * A box path is grammar-checked (charset allow-list, relative, no `..`)
 * BEFORE it is interpolated into a scp remote spec — the same defence
 * DF2.3's `assertEnvFileSafe` gives the delivery path.
 */
function assertBoxPathSafe(p: string): void {
  // F034: shared grammar plus this call site's OWN extra rule — box-RELATIVE,
  // so a leading "/" is refused here (path-guard allows absolute; credentials
  // and fill both need it). Unchanged message. Newly refused: a leading "-".
  try {
    assertPlainBoxPath("remote path", p);
    if (p.startsWith("/")) throw new Error("absolute");
  } catch {
    throw new ExeDevDriverError(
      "remote-path-invalid",
      `remote path ${JSON.stringify(p)} is not a plain box-relative path (charset [A-Za-z0-9._/-], no leading /, no ".." segments)`,
      "pass a box-relative path like out/report.txt",
    );
  }
}

// ─── registry factory seam (DF2.10 AC3) ─────────────────────────────────────

/**
 * Construct the production driver, reading any operator override from the
 * environment — the ONE place in this module that touches `process.env`.
 *
 * AC3's negative control is the reason this exists as a separate function: an
 * implementation that read `process.env` inside `create()` would pass every
 * unit test that constructs the driver directly (they never set those vars) and
 * would still ship env-magic into the hot path. Reading here instead keeps
 * `create()` a pure function of the driver's own fields, keeps
 * `ExeDevDriverOptions`'s "every field is injectable; none is env-magic"
 * contract literally true for the class, and gives tests an injectable `env`
 * so this seam is itself testable without mutating the real process.
 *
 * `QDS_EXEDEV_REGISTRY_AUTH_FILE` is a PATH to a 0600 file, never the credential
 * itself: an env var is readable from `/proc/<pid>/environ` and is inherited by
 * every child process, which for a credential is the same class of leak as argv
 * (INV-IBOX-3). The 0600 is ASSERTED below, not assumed — the whole security
 * property this indirection buys is "the secret lives in a file only this
 * operator can read", and an unchecked claim of it is worth nothing. Unset on
 * our own path — the factory image is public.
 */
export function exeDevDriverFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: ExeDevDriverOptions = {},
): ExeDevDriver {
  // ONE observability line for every refusal on this seam, and it exists
  // because there was previously NONE. `src/providers/index.ts:138` registers
  // this function as the exedev factory and `resolveDriver` wraps only the
  // RETURNED driver in `instrument()` — so a throw from here, or from
  // `new ExeDevDriver` beneath it, happens when no driver exists to call
  // `this.emit` on and no instrumentation is in place. An operator saw a fanout
  // stop on a bare exception with no `image_*` line to join it to. That is the
  // identical hole `create()`'s per-create re-assertion closes one layer down
  // (see its "the one create failure that emitted no event at all" comment),
  // left open at the layer where the FIRST box of a fanout dies.
  //
  // Credential-free by construction: only the typed `code` and the error's own
  // message are logged, and every refusal on this path already withholds values
  // (INV-IBOX-3). Rethrown untouched — this observes, it does not classify.
  try {
    return buildExeDevDriverFromEnv(env, opts);
  } catch (e) {
    const err = e as Error & Partial<ExeDevDriverError>;
    log({
      requestId: opts.requestId ?? newRequestId(),
      operation: "exedev.driver_construct_failed",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      runId: null,
      driver: "exedev",
      error: { code: err.code ?? "driver-construct-failed", message: err.message },
    });
    throw e;
  }
}

/** {@link exeDevDriverFromEnv}'s body — split out only so the refusal above can
 *  be observed without indenting the whole seam. */
function buildExeDevDriverFromEnv(
  env: Record<string, string | undefined>,
  opts: ExeDevDriverOptions,
): ExeDevDriver {
  // Undefined-valued keys are STRIPPED ONCE, and both the guard below and the
  // spread at the bottom read the stripped bag. `{ image: undefined }` is the
  // ordinary shape a caller forwarding an optional config field produces, and
  // it used to be counted as an override by `hasEffectiveImage` while the
  // `...opts` spread (which runs LAST) then wrote that `undefined` OVER the env
  // value — leaving `imageBuildId` at the env's and `image` at
  // DEFAULT_IMAGE_REF. That is the mismatched pair the both-or-neither guard
  // exists to prevent, arriving through the guard itself: every box comes up,
  // passes A, and dies at gate B. Mirror trap for `imageBuildId`.
  const given = Object.fromEntries(
    Object.entries(opts).filter(([, v]) => v !== undefined),
  ) as ExeDevDriverOptions;
  const image = env.QDS_EXEDEV_IMAGE;
  const buildId = env.QDS_EXEDEV_IMAGE_BUILD_ID;
  const hasImage = image !== undefined && image.length > 0;
  const hasBuildId = buildId !== undefined && buildId.length > 0;
  // BOTH-OR-NEITHER. The reference and its buildId are ONE pin — the host
  // enforces the digest at pull, the box proves the buildId, and they are only
  // ever recorded together. Half a pair is not a partial override, it is a
  // guaranteed fleet-wide refusal: every box comes up, passes A, and dies at
  // gate B saying "the box booted an image this repo does not pin" — which
  // reads as "your image is wrong" when the fault is one unset variable. So it
  // is refused HERE, before a box is created, naming the one that is missing.
  //
  // Computed on the EFFECTIVE halves — `opts` beats env, the same precedence
  // the spread below applies — so a caller supplying the missing half through
  // opts is not falsely refused, and a caller SPLITTING the pair through opts
  // is caught. Coverage stated honestly: this guards the factory only; direct
  // `new ExeDevDriver({ image })` remains legal as the documented test seam.
  const hasEffectiveImage = given.image !== undefined || hasImage;
  const hasEffectiveBuildId = given.imageBuildId !== undefined || hasBuildId;
  if (hasEffectiveImage !== hasEffectiveBuildId) {
    const set = hasEffectiveImage ? "QDS_EXEDEV_IMAGE" : "QDS_EXEDEV_IMAGE_BUILD_ID";
    const missing = hasEffectiveImage ? "QDS_EXEDEV_IMAGE_BUILD_ID" : "QDS_EXEDEV_IMAGE";
    throw new ExeDevDriverError(
      "image-pin-incomplete",
      `${set} (env, or its opts half) is set but ${missing} is not — an image reference and its buildId are one pin (INV-IBOX-2), and half a pin makes EVERY box fail gate B with a marker mismatch that is really a missing variable`,
      `set ${missing} too (scripts/build-exedev-image.ts prints the buildId it derived, and the box repeats it in /etc/qds-image.json), or unset ${set} to boot the repo pin`,
    );
  }
  const authFile = env.QDS_EXEDEV_REGISTRY_AUTH_FILE;
  let registryAuth: string | undefined;
  // The EFFECTIVE credential is decided before the file is touched, the same
  // asymmetry the image pin handles above. `...given` spreads LAST ("an
  // explicit caller argument beats the environment"), so an explicit
  // `registryAuth` means this file's bytes were never going to be used — and
  // opening it anyway threw `registry-auth-file-mode` naming a file the driver
  // had no interest in, and loaded an operator's credential into the process
  // for nothing.
  if (given.registryAuth === undefined && authFile !== undefined && authFile.length > 0) {
    // RATIFICATION FIRST, before a single credential byte is opened. The
    // constructor runs this same gate — but only AFTER the file has been read,
    // trimmed and handed to it, so an unratified deviation left the operator's
    // PAT live on the heap (and inside any caller that logs a constructor
    // argument) for a path the driver was about to refuse outright. The
    // adjacent `given.registryAuth` short-circuit above reasons about exactly
    // this cost — "opening it anyway … loaded an operator's credential into the
    // process for nothing" — and stopped one case short.
    //
    // Setting QDS_EXEDEV_REGISTRY_AUTH_FILE IS the intent to take the private
    // path, so the gate has everything it needs to answer here; the constructor
    // re-asserts it (and `create()` re-asserts it per box) unchanged.
    assertRegistryAuthDeviation(given.postureFile ?? DEFAULT_POSTURE_FILE);
    let raw: string;
    let fd: number | undefined;
    try {
      // ONE file descriptor, verified then read: a path-based stat followed by
      // a path-based read checks one inode and consumes another when the file
      // is swapped in between — the fstat below judges the very fd the read
      // uses, so the mode/type/owner the gate approved are the bytes it loads.
      // O_NONBLOCK so that opening a FIFO with no writer returns instead of
      // hanging the whole driver-registry factory forever; it is a no-op for
      // the regular file this must be, and the fstat refuses everything else.
      fd = openSync(authFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        throw new ExeDevDriverError(
          "registry-auth-unreadable",
          `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is not a regular file — a FIFO or device here blocks the read indefinitely, before any refusal could be emitted`,
          "point it at a 0600 regular file containing USERNAME:PASSWORD, or unset it to use the public image",
        );
      }
      // The mode is the property the path-not-value indirection BUYS, so it is
      // checked before the read rather than described in the remediation and
      // trusted. Group or other bits set means the credential is readable by
      // someone this operator did not choose; refuse rather than load it.
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new ExeDevDriverError(
          "registry-auth-file-mode",
          `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is mode 0${mode.toString(8).padStart(3, "0")} — a registry credential must be readable only by its owner (INV-IBOX-3)`,
          `chmod 600 ${JSON.stringify(authFile)}, then re-run`,
        );
      }
      // Owner check, same property in a different axis: 0600 on someone ELSE's
      // file is not "only this operator can read it". POSIX hosts only —
      // `process.getuid` is absent on Windows, where this arm simply does not
      // run (this factory targets macOS/Linux operators).
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new ExeDevDriverError(
          "registry-auth-file-mode",
          `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is owned by uid ${stat.uid}, not this process's uid ${process.getuid()} — a registry credential must belong to the operator loading it (INV-IBOX-3)`,
          "chown the file to the running user (and chmod 600), or point QDS_EXEDEV_REGISTRY_AUTH_FILE at your own 0600 copy",
        );
      }
      // The ceiling is enforced BEFORE the bytes are in memory. `stat.size` is
      // already in hand and `assertRegistryAuth` already believes in a ceiling
      // (512-byte password) — it just enforced it after the read, so a
      // mispointed QDS_EXEDEV_REGISTRY_AUTH_FILE at a large 0600 file the
      // operator owns (shell history, a heap dump, a .env backup) was slurped
      // whole and only then refused. A credential file is one short line.
      if (stat.size > REGISTRY_AUTH_FILE_MAX_BYTES) {
        throw new ExeDevDriverError(
          "registry-auth-file-oversized",
          `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is ${stat.size} bytes, over the ${REGISTRY_AUTH_FILE_MAX_BYTES}-byte ceiling — a USERNAME:PASSWORD line cannot exceed it, so this is not a credential file and its contents are never read`,
          "point it at a 0600 file containing exactly one USERNAME:PASSWORD line, or unset it to use the public image",
        );
      }
      // A BOUNDED read, not `readFileSync(fd)`, because `stat.size` is a claim
      // some regular files do not honour: every procfs entry
      // (`/proc/self/environ` and friends) reports `st_size` 0 while streaming
      // unbounded content, and it passes `isFile()`, the 0400 mode check and
      // the uid check on the way here. Trusting the fstat therefore slurped
      // exactly what the ceiling exists to prevent — "a mispointed path loads a
      // heap dump". One byte over the ceiling is read on purpose, so an
      // oversized file is DETECTED rather than silently truncated into a
      // plausible-looking credential.
      const buf = Buffer.alloc(REGISTRY_AUTH_FILE_MAX_BYTES + 1);
      const read = readSync(fd, buf, 0, buf.length, 0);
      if (read > REGISTRY_AUTH_FILE_MAX_BYTES) {
        throw new ExeDevDriverError(
          "registry-auth-file-oversized",
          `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} yields more than the ${REGISTRY_AUTH_FILE_MAX_BYTES}-byte ceiling (its stat size of ${stat.size} bytes understated it — procfs and other synthetic files do that) — a USERNAME:PASSWORD line cannot exceed it, so this is not a credential file`,
          "point it at a 0600 regular file containing exactly one USERNAME:PASSWORD line, or unset it to use the public image",
        );
      }
      raw = buf.subarray(0, read).toString("utf8");
    } catch (e) {
      // The mode/type/owner refusals are already typed and specific — do not
      // relabel them "unreadable", which sends the operator to the wrong check.
      if (e instanceof ExeDevDriverError) throw e;
      throw new ExeDevDriverError(
        "registry-auth-unreadable",
        `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is unreadable: ${(e as Error).message}`,
        "point it at a 0600 file containing USERNAME:PASSWORD, or unset it to use the public image",
      );
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The verdict above is already decided; a failing close on a
          // read-only fd must not replace it.
        }
      }
    }
    // A trailing newline is what every editor and `echo` writes; it is not part
    // of the credential and must not travel into argv.
    registryAuth = raw.trim();
    // An EMPTY file is its own fact. Left to fall through, `assertRegistryAuth("")`
    // told the operator "expected USERNAME:PASSWORD, found no ':' separator" —
    // sending them to inspect a value that is not there, in a message that
    // withholds values by design so they cannot see that. `touch creds` and
    // `echo > creds` are both ordinary accidents; naming them costs one line
    // and saves a debugging round trip. Still value-free (INV-IBOX-3).
    if (registryAuth.length === 0) {
      throw new ExeDevDriverError(
        "registry-auth-unreadable",
        `QDS_EXEDEV_REGISTRY_AUTH_FILE ${JSON.stringify(authFile)} is empty (or holds only whitespace) — there is no credential in it`,
        "write exactly one USERNAME:PASSWORD line into the 0600 file, or unset it to use the public image",
      );
    }
  }
  // `...given` LAST: an explicit caller argument beats the environment. The
  // reverse order let a stray `QDS_EXEDEV_IMAGE` silently boot a different
  // image than the code asked for — and this is the seam gate B keys on, so
  // "the explicit argument lost" is an expensive surprise to debug. `given`,
  // not `opts`: an explicitly-`undefined` key is not an argument, it is the
  // absence of one, and spreading it here erased the env half of a pin.
  return new ExeDevDriver({
    ...(hasImage ? { image } : {}),
    ...(hasBuildId ? { imageBuildId: buildId } : {}),
    ...(registryAuth === undefined ? {} : { registryAuth }),
    ...given,
  });
}
