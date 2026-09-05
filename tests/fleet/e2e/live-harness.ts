/**
 * Shared harness for the DF3 fleet live e2e tests (tests/fleet/e2e/*.live.test.ts).
 *
 * HARD RULE (e2e-plan.md): NO FAKES in any *.live.test.ts or in this harness —
 * a FakeDriver/FakeKeyApi/RecordingLedger import here is a bug. Everything in
 * this module touches the real substrate: real `ssh exe.dev` via ExeDevDriver,
 * the real OpenRouter key API via openRouterKeyApi(), real SQLite (readonly
 * reads), real `bun scripts/fleet.ts` subprocesses.
 *
 * Gating (copied from tests/providers/exedev/setup-gate.test.ts:538 and
 * tests/providers/cap-hit-demo.test.ts:978): every live test is
 * `test.todoIf(!process.env.QDS_E2E_LIVE)` so normal `bun test`/CI pays nothing,
 * and the FIRST thing the test body does is `liveGate()` — which THROWS on a
 * half-configured environment rather than silently skipping (a hollow live-fire
 * is a bug, not a pass).
 *
 * Secrets: OPENROUTER_PROVISIONING_KEY and minted key plaintexts are never
 * printed, logged, or written to evidence. `writeEvidence` scrubs
 * `sk-or-…` plaintexts and the provisioning-key value out of every string it
 * serializes, then asserts the written bytes are clean. keyHashes, boxIds,
 * runIds and costs are identifiers, not secrets, and are kept.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { costLedgerOpts } from "../../../scripts/lib/cost-ledger-opts.ts";
import { MAX_VERIFY_PAGES, mintRunKey, openRouterKeyApi, revokeRunKey } from "../../../src/providers/credentials.ts";
import type { KeyApi } from "../../../src/providers/credentials.ts";
import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  // TYPE-ONLY since the box helpers take the CALLER's driver (L23): this module
  // no longer constructs an `ExeDevDriver` anywhere. The one driver a live test
  // uses is the one `exeDevDriverFromEnv` builds in `preflight` — the same
  // factory production registers — so a bare constructor cannot creep back in
  // through a helper.
  type ExeDevDriver,
  exeDevDriverFromEnv,
} from "../../../src/providers/exedev/driver.ts";
import type { RunRecordStore } from "../../../src/providers/run-record.ts";

// ─── layout ──────────────────────────────────────────────────────────────────

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const EVIDENCE_DIR = join(REPO_ROOT, "_bmad-output/evidence/df3-e2e");

const SUBSTRATE_ENV = [
  "QDS_EXEDEV_REPO_URL",
  "QDS_EXEDEV_SHA",
  "QDS_EXEDEV_ROSTER",
  "OPENROUTER_PROVISIONING_KEY", // SECRET — presence-checked, value never read out
] as const;

// ─── gating ──────────────────────────────────────────────────────────────────

/**
 * THROW (never skip) when the live environment is half-configured. Called as
 * the first statement of every live test body. Tier mismatch throws too: a
 * TIER-2 run is a real-money run and must be opt-in via QDS_E2E_TIER=2.
 */
export function liveGate(tier: "1" | "2"): void {
  if (process.env.QDS_E2E_LIVE !== "1") {
    throw new Error("QDS_E2E_LIVE is not 1 — this todoIf-gated test must not run");
  }
  if (process.env.QDS_E2E_TIER !== tier) {
    throw new Error(`QDS_E2E_TIER is ${JSON.stringify(process.env.QDS_E2E_TIER)}, not "${tier}" — refusing to run at the wrong tier`);
  }
  const missing = SUBSTRATE_ENV.filter((name) => (process.env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    // NAMES only — never values (the provisioning key is a secret).
    throw new Error(
      `QDS_E2E_LIVE=1 but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset — refusing to run a hollow live-fire`,
    );
  }
}

/** The todoIf condition every live test uses: off unless the master flag is set. */
export function liveTodoOff(): boolean {
  return process.env.QDS_E2E_LIVE !== "1";
}

// ─── preflight ───────────────────────────────────────────────────────────────

export interface LiveCtx {
  driver: ExeDevDriver;
  repoUrl: string;
  sha: string;
  rosterPath: string;
  whoami: string;
}

/**
 * Fail fast when ssh/exe.dev is unreachable, with the exact operator
 * remediation. `whoami` is content-checked by the driver itself (exit 0 with
 * empty output is a refusal, not an identity).
 *
 * The driver comes from `exeDevDriverFromEnv` — the SAME factory production
 * registers (`src/providers/index.ts`) — never `new ExeDevDriver()` (#189):
 * a bare constructor reads no environment, so every live test was exercising
 * a driver production never constructs, the repo-pin assertions in
 * tier2-image-contract were constant-vs-constant, and the credential-loading
 * path (`QDS_EXEDEV_REGISTRY_AUTH_FILE`) had no live coverage at all. The
 * factory's own refusals (half a pin set, a group-readable auth file) now
 * fire HERE, before a box exists — that is the fail-fast direction, and it is
 * the same refusal the operator's production fleet would hit.
 */
export async function preflight(tier: "1" | "2" = "1"): Promise<LiveCtx> {
  liveGate(tier);
  const driver = exeDevDriverFromEnv();
  // The factory-built driver honours QDS_EXEDEV_IMAGE / QDS_EXEDEV_IMAGE_BUILD_ID
  // for EVERY live test now, not only tier2-image-contract (which keeps its own
  // hard refusal). A leftover export from an image-build session must not
  // silently buy boxes from an unpinned image — but it must not be refused
  // either: a tenant-mirror live round against an override image is legitimate.
  // So: one loud, RECORDED line naming the variable and the refs it buys.
  const imageOverrides = ["QDS_EXEDEV_IMAGE", "QDS_EXEDEV_IMAGE_BUILD_ID"].filter(
    (name) => (process.env[name] ?? "").trim() !== "",
  );
  // RECORDED, not just printed (F16): a stderr line scrolls away and the
  // evidence JSON then reads identically whether the round bought the repo pin
  // or a leftover override — "proven live" must say WHICH image was proven.
  // The stamp is set HERE and consumed by `writeEvidence`, so no tier that
  // calls `preflight` has to remember to carry it. A tier that builds its own
  // driver must call {@link setEffectiveImage} — `writeEvidence` now REFUSES
  // an unstamped write rather than inheriting another test's image (P125).
  setEffectiveImage(driver, { overriddenBy: imageOverrides });
  if (imageOverrides.length > 0) {
    process.stderr.write(
      `[preflight] IMAGE OVERRIDE ACTIVE (${imageOverrides.join(", ")}): every box this round creates boots image=${driver.image} buildId=${driver.imageBuildId} — NOT necessarily the repo pin. tier2-image-contract will refuse; all other tiers proceed against the override.\n`,
    );
  }
  let whoami: string;
  try {
    whoami = await driver.whoami();
  } catch (e) {
    throw new Error(
      `exe.dev preflight failed (whoami): ${(e as Error).message} — remediation: run \`ssh exe.dev whoami\` by hand; if the agent/keys are missing or expired, run the interactive login yourself and re-run. Driver auth = local ssh agent/~/.ssh (TOFU accept-new), no in-repo flow exists.`,
    );
  }
  return {
    driver,
    repoUrl: process.env.QDS_EXEDEV_REPO_URL ?? "",
    sha: process.env.QDS_EXEDEV_SHA ?? "",
    rosterPath: process.env.QDS_EXEDEV_ROSTER ?? "",
    whoami,
  };
}

/**
 * The boot image THIS TEST's driver pins, stamped into its evidence file by
 * {@link writeEvidence} (F16).
 *
 * P125: this used to be set ONLY by `preflight()` and never cleared, so in one
 * `bun test` process a file that builds its own drivers
 * (`tier1-registry-auth.live.test.ts`) inherited the PREVIOUS file's image and
 * stamped "proven live, isRepoPin: true" onto bytes it never booted — and run
 * alone the same file stamped the "preflight did not run" note. The artifact
 * silently changed meaning with invocation order, which is the exact failure
 * F16 exists to prevent.
 *
 * Now it is `undefined` until a test sets it (via `preflight`, or
 * {@link setEffectiveImage} for a test that builds its own driver or boots no
 * box), `writeEvidence` REFUSES to write while it is `undefined`, and a
 * successful write CONSUMES it. So a forgetting test fails closed the same way
 * whether it runs alone or after twenty others — order-independence is the
 * whole point.
 */
let effectiveImage: Record<string, unknown> | undefined;

/**
 * Stamp the boot image for THIS test's evidence file. Called for you by
 * {@link preflight}; call it directly when a test builds its own driver
 * instead, or pass `null` for a test that boots no box at all (D6 lists key
 * hashes and never creates a VM — "no image" is a true, explicit provenance
 * claim; an inherited one is not).
 */
export function setEffectiveImage(
  source: { readonly image: string; readonly imageBuildId: string } | null,
  detail: { overriddenBy?: readonly string[]; note?: string } = {},
): void {
  effectiveImage =
    source === null
      ? { note: detail.note ?? "this test booted no box — no boot-image provenance applies" }
      : {
          ref: source.image,
          buildId: source.imageBuildId,
          overriddenBy: [...(detail.overriddenBy ?? [])],
          isRepoPin: source.image === DEFAULT_IMAGE_REF && source.imageBuildId === DEFAULT_IMAGE_BUILD_ID,
          ...(detail.note === undefined ? {} : { note: detail.note }),
        };
}

// ─── identifiers ─────────────────────────────────────────────────────────────

/** A fresh, grammar-valid, collision-unlikely run/box id: `e2e-<label>-<stamp>`. */
export function runIdFor(label: string): string {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const id = `e2e-${label}-${stamp}`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id) || id.length > 63) {
    throw new Error(`generated run id ${id} is not grammar-valid`);
  }
  return id;
}

/**
 * The `mintRunId()` grammar — `dispatch.ts`'s own `MINTED_RUN_ID_RE`, unanchored
 * so it can be found inside a line of free text.
 *
 * ONE source (L13). There used to be two: `emittedRunId` matched
 * `qds-[a-z0-9-]+` inside a JSON `"runId"` field, while every `finally`'s
 * failure-path recovery matched `qds-[0-9]{8}-[a-z0-9]{6}` over the raw text.
 * An id satisfying the first but not the second was recovered on the ACK path
 * and not on the FAILURE path — the only path the fallback exists for — so the
 * two grammars disagreed precisely where the disagreement costs a box.
 */
export const MINTED_RUN_ID_RE = /qds-\d{8}-[a-f0-9]{6}/;

/** The same grammar under either box prefix: `dispatch` mints `qds-…`, the harness's own tiers create `e2e-…`. */
const BOX_NAME_SOURCE = "(?:qds|e2e)-\\d{8}-[a-f0-9]{6}";

/**
 * The ids a REFUSING `fleet dispatch` NAMED, recovered from its raw streams —
 * the failure-path twin of {@link emittedRunId}, and the one copy of it.
 *
 * Every tier-2+ `finally` carried its own inline pair of regexes for this. They
 * are the same three patterns everywhere and they must stay in step with
 * {@link MINTED_RUN_ID_RE}, so they live here: a refusal envelope's debug and
 * teardown remediation lines name the box, and that is the only handle a
 * dispatch which provisioned and THEN failed ever gives the cleanup.
 */
export function recoverDispatchIds(stdout: string, stderr: string): { runId: string; vmName: string } {
  const combined = `${stdout}\n${stderr}`;
  return {
    runId: MINTED_RUN_ID_RE.exec(combined)?.[0] ?? "",
    vmName:
      new RegExp(`ssh (${BOX_NAME_SOURCE})\\.exe\\.xyz`).exec(combined)?.[1] ??
      new RegExp(`(?:teardown|rm) (${BOX_NAME_SOURCE})`).exec(combined)?.[1] ??
      "",
  };
}

/**
 * The runId a `fleet` verb NAMED, read from its raw stdout/stderr rather than
 * from a parsed success ack.
 *
 * WHY IT IS NOT `JSON.parse(ack).runId` (2026-09-03 live round). `dispatch`
 * reaches the substrate and creates a box BEFORE it can still fail — a
 * provisioning timeout, a steering-channel refusal, a gate rejection all land
 * after `ssh exe.dev new` has already made a real VM. Every live tier bound
 * ownership to the ack, i.e. to the success path, so a dispatch that created a
 * box and THEN failed left the test with `runId === ""`: the `finally`'s
 * teardown fallback is guarded on a non-empty runId and never ran, and
 * `fleetLeftovers` could not match a box it had not been told it owned, so a
 * genuine leak was reported as the non-failing "not this run's" stray and the
 * box was left billing. Observed for real on T3.5 — `driver.create` timed out
 * after 60 000 ms and the box outlived the round.
 *
 * This is the same defect class as the AC4 F1 BLOCKER (`posCreated` set after
 * `create()` returned) and it is fixed the same way: ARM OWNERSHIP BEFORE THE
 * ASSERTION THAT CAN THROW. Both the success ack and the failure envelopes
 * carry the id, so reading the raw text covers both paths where parsing the
 * ack covers only one.
 *
 * Returns `undefined` when the verb named no run at all (argv refused, spawn
 * failed) — there is genuinely nothing to own in that case.
 */
export function emittedRunId(stdout: string, stderr: string): string | undefined {
  return new RegExp(`"runId"\\s*:\\s*"(${MINTED_RUN_ID_RE.source})"`).exec(`${stdout}\n${stderr}`)?.[1];
}

// ─── evidence ────────────────────────────────────────────────────────────────

const SECRET_VALUES: readonly string[] = [
  process.env.OPENROUTER_PROVISIONING_KEY ?? "",
  // Minted key plaintexts (sk-or-v1-…): scrub by pattern, not by value — the
  // harness deliberately never retains the plaintext after mintRunKey returns.
].filter((v) => v.length > 0);

function scrubText(s: string): string {
  // Specific pattern first, then generic catch-all (brackets in charset prevent double-scrub).
  let out = s.replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED-KEY]");
  out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED-KEY]");
  for (const secret of SECRET_VALUES) {
    out = out.split(secret).join("[REDACTED-ENV]");
  }
  return out;
}

/**
 * Every credential shape this harness knows, as a FILE sweep (L10).
 *
 * The tar-redaction check in tier2-in-box-engine knew exactly one secret shape
 * — `sk-or-` — while {@link scrubText} above already covered three. The gap is
 * not theoretical: a git token in `QDS_EXEDEV_REPO_URL` (`ghp_…`,
 * `github_pat_…`, or `https://user:pass@…`) reaches the box on the fill, can
 * land in the engine log, and rides off in the harvest tar — the one surface
 * the sweep's own comment calls permanent. It passed both the tar sweep and
 * `writeEvidence`'s scrub.
 *
 * Returns the NAMES of the patterns that matched, never the matched bytes: the
 * caller prints this into a failing assertion, and a leak report that quotes
 * the credential compounds the leak it is reporting.
 */
export function secretHitsIn(bytes: Buffer | string): string[] {
  const text = typeof bytes === "string" ? bytes : bytes.toString("latin1");
  const hits: string[] = [];
  if (/sk-or-[A-Za-z0-9_-]+/.test(text)) hits.push("openrouter-key (sk-or-…)");
  if (/sk-[A-Za-z0-9_-]{20,}/.test(text)) hits.push("generic-api-key (sk-…)");
  if (/\bghp_[A-Za-z0-9]{20,}\b/.test(text)) hits.push("github-pat (ghp_…)");
  if (/\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text)) hits.push("github-pat (github_pat_…)");
  // The repo URL's own userinfo, which is a credential whenever it carries one.
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+:[^/@\s]+)@/i.exec(process.env.QDS_EXEDEV_REPO_URL ?? "")?.[1];
  if (userinfo !== undefined && userinfo !== "" && text.includes(userinfo)) hits.push("repo-url userinfo (user:pass@)");
  for (const secret of SECRET_VALUES) if (text.includes(secret)) hits.push("OPENROUTER_PROVISIONING_KEY value");
  return hits;
}

function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[scrubText(k)] = scrubDeep(val);
    return out;
  }
  return v;
}

/**
 * Redacted JSON evidence per test run → `<EVIDENCE_DIR>/<date>-<name>.json`.
 * Written PASS or FAIL (call from `finally`). Post-scrub assertion: if any
 * secret survived, the write FAILS loudly — evidence that leaks is worse than
 * no evidence.
 *
 * Every file carries `image`: the ref/buildId the round's driver actually
 * pinned (F16). A round against `QDS_EXEDEV_IMAGE=<something else>` used to
 * produce evidence indistinguishable from a repo-pinned one, and "proven live"
 * is a claim about WHICH bytes were proven. An UNSTAMPED write is REFUSED
 * (P125) — see {@link setEffectiveImage} — and the harness-owned `writtenAt` /
 * `image` fields are spread LAST so a payload key named `image` cannot silently
 * erase the one field the docstring says no evidence file may omit (P129).
 *
 * `QDS_E2E_EVIDENCE_DIR` overrides the destination — for live-harness.test.ts,
 * which must not dirty the repo's evidence directory from the fast suite.
 */
export function writeEvidence(name: string, payload: Record<string, unknown>): string {
  if (effectiveImage === undefined) {
    // BEFORE mkdirSync: an unstamped write must not even create the directory.
    throw new Error(
      `evidence ${name} has NO boot-image provenance — refusing to write. Call preflight() (which stamps it), or setEffectiveImage(driver) if this test builds its own driver, or setEffectiveImage(null, { note: "…" }) if it boots no box. Refusing rather than inheriting: the stamp is consumed by each write, so an unstamped one would otherwise carry the PREVIOUS test file's image and claim "proven live" for bytes this test never booted (F16/P125).`,
    );
  }
  // CONSUMED here, not on success: a stamp must not survive its own write —
  // failed or not — or a test whose evidence write blew up would silently lend
  // its provenance to the next test in the process, which is P125 again.
  const image = effectiveImage;
  effectiveImage = undefined;
  const dir = process.env.QDS_E2E_EVIDENCE_DIR?.trim() || EVIDENCE_DIR;
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  const path = join(dir, `${stamp}-${name}.json`);
  const body = JSON.stringify(
    { ...(scrubDeep(payload) as Record<string, unknown>), writtenAt: now.toISOString(), image: scrubDeep(image) },
    null,
    2,
  );
  if (/sk-or-/.test(body) || SECRET_VALUES.some((sv) => body.includes(sv))) {
    throw new Error(`evidence ${name} failed the secret scrub — refusing to write ${path}`);
  }
  writeFileSync(path, `${body}\n`);
  return path;
}

// ─── fleet CLI subprocess ────────────────────────────────────────────────────

export interface RunFleetResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `runFleet`'s ceiling firing, CARRYING whatever the child had already written
 * (L1). Without the partials this rejection was a total amnesia: `dispatch` is
 * the verb that creates a real box before it can still fail, and every tier
 * assigns `dispatchOut`/`dispatchErr` on the line AFTER the await — so a
 * ceiling left both `""`, {@link recoverDispatchIds} scanned an empty string,
 * `runId`/`vmName` stayed `""`, every guarded teardown/destroy leg was SKIPPED
 * and `fleetLeftovers` could not match the box it had not been told it owned.
 * The genuinely leaked VM was then classified as another round's stray — a
 * warning — and left billing. The streams are the only handle on the id at that
 * point, so they ride the error.
 */
export class RunFleetTimeoutError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RunFleetTimeoutError";
  }
}

/**
 * How long a killed child's already-drained bytes are waited for before the
 * timeout rejects anyway. The pipes close as soon as the orphaned process is
 * reaped, so this is a bound on a pathological grandchild holding them open —
 * never a wait a healthy path pays.
 */
const TIMEOUT_DRAIN_GRACE_MS = 5_000;

/**
 * Whatever a failed {@link runFleet} had already written, or a pair of empty
 * strings for any other throw. Callers use it to arm ownership on the one path
 * where the ack never arrives — see {@link RunFleetTimeoutError}.
 */
export function fleetPartialOutput(e: unknown): { stdout: string; stderr: string } {
  return e instanceof RunFleetTimeoutError ? { stdout: e.stdout, stderr: e.stderr } : { stdout: "", stderr: "" };
}

/**
 * Real `bun scripts/fleet.ts <verb> …` subprocess (cap-hit-demo's spawn
 * pattern). `cwd` matters: harvest/teardown hardcode `gitCwd: process.cwd()`,
 * so those verbs must run from a host git checkout that owns the pinned base
 * SHA (see scratchClone). `env` overlays process.env.
 */
export async function runFleet(
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunFleetResult> {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fleet.ts"), ...argv],
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env as Record<string, string>, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The ceiling races the WHOLE drain (exit + both pipes), not `exited` alone:
  // a grandchild that inherits the pipes keeps a `Response(...).text()` pending
  // long after the child is dead, so a ceiling gated on the exit can sit
  // resolved while `Promise.all` waits on the streams. On fire we kill the
  // child FIRST, then reject — the dropped readers settle when the orphaned
  // pipe closes instead of pinning the runner, and the `.catch(() => {})`
  // keeps them from surfacing as unhandled rejections.
  const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  drained.catch(() => {}); // dropped, never unhandled, when the ceiling fires
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([proc.exited, drained]).then(([code, [out, err]]) => [code, out, err] as const),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          // The partials are COLLECTED, not discarded (L1). The kill above
          // closes the child's ends, so `drained` settles within milliseconds
          // on every real path; the race against the grace window is only so a
          // pipe held open by a grandchild cannot convert this timeout into a
          // hang. Whatever landed rides the rejection — for `dispatch` that
          // text is the only place the box's name exists on this path.
          void Promise.race([
            drained.catch((): [string, string] => ["", ""]),
            new Promise<[string, string]>((r) => setTimeout(() => r(["", ""]), TIMEOUT_DRAIN_GRACE_MS)),
          ]).then(([out, err]) =>
            reject(
              new RunFleetTimeoutError(
                `runFleet timeout after ${opts.timeoutMs ?? 300_000} ms: fleet ${argv.join(" ")}`,
                out,
                err,
              ),
            ),
          );
        }, opts.timeoutMs ?? 300_000);
      }),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill(); // no-op on an exited process
  }
}

/**
 * `runFleet` with the operator token on fd 0 — the DF3.4 gate-verb shape
 * (`fleet approve … < token`). `stdin: Bun.file(path)` makes fd 0 a REGULAR
 * FILE, which is exactly the shape `assertTokenAttached` accepts; a character
 * device (`/dev/null`, the default for a spawned child) is refused as "no
 * token attached" — that is the guard working, not a harness bug.
 *
 * Extracted from tier1-approval-gate.live.test.ts, which used to carry the
 * only copy; T5.1's approve leg needs the same one.
 */
export async function runFleetWithToken(
  argv: readonly string[],
  tokenPath: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<RunFleetResult> {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fleet.ts"), ...argv],
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    stdin: Bun.file(tokenPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Same whole-drain ceiling as `runFleet` above (the grandchild-inherits-the-
  // pipe hang) — the failure mode this 120 s promise exists to bound.
  const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  drained.catch(() => {}); // dropped, never unhandled, when the ceiling fires
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([proc.exited, drained]).then(([code, [out, err]]) => [code, out, err] as const),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`runFleetWithToken timeout: fleet ${argv.join(" ")}`));
        }, opts.timeoutMs ?? 120_000);
      }),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

/**
 * Spawn `bun scripts/fleet.ts …` WITHOUT awaiting — for tests that must act
 * DURING the verb's run (the race pattern: plant the winner's marker while the
 * poller is live). Same env/cwd semantics as runFleet. `output` resolves once
 * BOTH pipes close; read it only after `exited` settles.
 */
export interface SpawnedFleet {
  exited: Promise<number | null>;
  output: Promise<{ stdout: string; stderr: string }>;
  kill: () => void;
}

export function spawnFleet(
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): SpawnedFleet {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fleet.ts"), ...argv],
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env as Record<string, string>, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    output: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
      ([stdout, stderr]) => ({ stdout, stderr }),
    ),
    kill: () => proc.kill(),
  };
}

// ─── host-side git scratch clone (harvest prerequisite) ──────────────────────

/**
 * A real host git repo that POSSESSES the pinned base SHA: `git bundle
 * verify` checks the bundle's prerequisites against this checkout, and the
 * fetch lands under its `refs/sandbox/`. Shallow-fetching exactly the SHA is
 * enough — verify needs the base commit object, not its history. Using a
 * scratch clone keeps the factory repo itself untouched.
 */
export async function scratchClone(repoUrl: string, sha: string, parentDir: string): Promise<string> {
  const dir = join(parentDir, "host-clone");
  const git = (args: readonly string[]) => {
    const r = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  mkdirSync(dir, { recursive: true });
  const steps: Array<readonly string[]> = [
    ["init", "--quiet"],
    ["remote", "add", "origin", repoUrl],
    ["fetch", "--quiet", "--depth=1", "origin", sha],
    ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
  ];
  for (const step of steps) {
    const r = git(step);
    if (r.exitCode !== 0) {
      // Specialize fetch failures: name the SHA and explain the likely cause.
      const msg = step[2] === "fetch" && step[3] === "--depth=1" && step[4] === "origin"
        ? `scratchClone: pinned base SHA ${sha} not fetchable from origin — is the commit pushed? (git ${step.join(" ")} exited ${r.exitCode}: ${r.stderr.trim()})`
        : `scratchClone: git ${step.join(" ")} exited ${r.exitCode}: ${r.stderr.trim()}`;
      throw new Error(msg);
    }
  }
  return dir;
}

// ─── in-box exec helpers (DF3.4 transport + tier-4 leg reads) ────────────────

/**
 * POSIX single-quote wrapping. F017 keeps the ONE production quoter in
 * `src/providers/exedev/transport.ts` (`shQuote`/`shellQuote`); this copy is
 * deliberate and its scope is its whole justification — its only caller is
 * `fetchBoxFile`'s read-only `cat` probe below. Anything that builds a
 * substrate command a run depends on quotes through the production one.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * One read-only exec on the box, through the CALLER'S driver (L23).
 *
 * The driver is a required parameter and not a `new ExeDevDriver()` built here:
 * a bare constructor reads no environment, so it is the driver production never
 * builds — the same defect this harness's own {@link preflight} docblock flags
 * at #189 — and every tier that used these helpers was reading its box through
 * a different driver from the one its assertions were about. Passing
 * `ctx.driver` also keeps the exec ceilings a tier's budget audit prices real.
 */
export async function boxExec(
  driver: ExeDevDriver,
  vm: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await driver.exec(vm, [...args]);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** Read one file OFF the box; a nonzero `cat` is a refusal, never empty bytes. */
export async function fetchBoxFile(driver: ExeDevDriver, vm: string, boxPath: string): Promise<string> {
  const r = await boxExec(driver, vm, ["sh", "-c", `cat ${shellQuote(boxPath)}`]);
  if (r.exitCode !== 0) {
    throw new Error(`box read of ${boxPath} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
  }
  return r.stdout;
}

/**
 * The box's $HOME, resolved ON THE BOX. A `shellQuote`d path is injected into
 * the remote `sh -c` VERBATIM, so `cat '$HOME/pipeline.yaml'` single-quotes the
 * dollar and cats a literal "$HOME" directory that does not exist. Resolving
 * once here and substituting a real absolute path keeps every later quote both
 * injection-safe and expansion-free.
 */
export async function boxHome(driver: ExeDevDriver, vm: string): Promise<string> {
  const r = await boxExec(driver, vm, ["sh", "-c", 'printf %s "$HOME"']);
  const home = r.stdout.trim();
  if (r.exitCode !== 0 || !/^[A-Za-z0-9._/-]+$/.test(home) || !home.startsWith("/")) {
    throw new Error(`could not resolve $HOME on ${vm} (exit ${r.exitCode}): ${home.slice(0, 120)}`);
  }
  return home;
}

// ─── real key API helpers ────────────────────────────────────────────────────

/**
 * REAL OpenRouter mint (POST /keys) at a tiny cap. The plaintext key never
 * leaves this function's caller scope and is never logged or written; only the
 * provider-side hash (a non-secret identifier, DF2.3) is returned/recorded.
 * Minting costs $0 — only model CALLS spend.
 */
export async function mintCappedKey(
  driver: ExeDevDriver,
  store: RunRecordStore,
  runId: string,
  capMicroUsd: number,
): Promise<{ hash: string }> {
  const keyApi: KeyApi = openRouterKeyApi();
  const res = await mintRunKey({ store, keyApi, driver, capMicroUsd }, runId);
  return { hash: res.hash };
}

/**
 * Every key hash the provider currently lists (revoke verification).
 *
 * THROWS on a truncated listing rather than returning a partial set (D6). The
 * name promises the whole population and all 13 call sites use it that way —
 * and the direction of the unsoundness is what makes this urgent rather than
 * tidy. The leak assertions are `not.toContain(hash)`, which a PARTIAL list
 * satisfies SPURIOUSLY: the hash may be sitting in the pages nobody read, so an
 * empty `leaked` array would mean "we did not look" while claiming "nothing
 * leaked". A key-leak check that cannot see the whole population must refuse to
 * render a verdict.
 *
 * Throwing here rather than returning `{hashes, truncated}` is the root-cause
 * shape: a returned flag puts the guard back in all 13 call sites and rebuilds
 * the inert-by-default trap D1 was filed for, where the one caller who forgets
 * is the one that reports a false green. One throw in the shared callee is what
 * no caller can forget.
 *
 * It is also the posture PRODUCTION already takes on this exact fact:
 * `verifyHash` throws `list-unverified` and `reaper.ts` throws on
 * `res.truncated`, both because `KeyApi`'s contract says the list "either
 * follows pages to exhaustion or reports `truncated: true` — absence is never
 * inferred from a partial page" (`src/providers/credentials.ts`). This harness
 * was the one reader of that API that inferred absence anyway.
 *
 * The bound is `MAX_VERIFY_PAGES`, not the local `10` it used to pass: this
 * harness verifies the same population production verifies, and a second magic
 * number can drift from the real one — leaving the test's ceiling quietly
 * lower than the factory's, which is how this was unsound at 10 while
 * production was sound at 20.
 *
 * `maxPages` is a parameter ONLY so the guard can be proven against the real
 * API instead of a stub (tier1-teardown's `D6` case passes 1). It cannot be
 * used to weaken the check: `listAllKeys` proves exhaustion only by reaching an
 * EMPTY page, so a LOWER bound can only make this throw — the fail-closed
 * direction — and never return a partial set. A higher one only reads further.
 */
export async function listedKeyHashes(maxPages: number = MAX_VERIFY_PAGES): Promise<Set<string>> {
  const keyApi: KeyApi = openRouterKeyApi();
  const { entries, truncated } = await keyApi.listAllKeys(maxPages);
  if (truncated) {
    throw new Error(
      // One template literal, not a concatenation: biome's useTemplate /
      // noUnusedTemplateLiteral both fire on the joined form, and the embedded
      // newlines are wanted anyway — this is read off a failing test's output.
      `key-list-truncated: the provider key list did not enumerate within a ${maxPages}-page budget, so this run
cannot tell a revoked key from an unlisted one and MUST NOT report a leak verdict.
Raise MAX_VERIFY_PAGES (src/providers/credentials.ts) or prune the account, then re-run.
To see the real page count by hand:
  curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  }
  return new Set(entries.map((e) => e.hash));
}

// ─── readonly ledger reads ───────────────────────────────────────────────────

/**
 * Readonly SQLite rows from the cost ledger that lives beside/inside the
 * records dir (same resolution the CLI uses — costLedgerOpts, single source).
 * NEVER writes: opened readonly, closed on return.
 */
export function ledgerRows<T = Record<string, unknown>>(recordsDir: string, sql: string, ...params: (string | number)[]): T[] {
  const path = costLedgerOpts(recordsDir).path;
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

// ─── teardown discipline ─────────────────────────────────────────────────────

/** `destroyQuietly`'s verdict: `ok:false` carries the message a caller asserts on. */
export type DestroyOutcome = { ok: true } | { ok: false; error: string };

/**
 * Best-effort box destroy for `finally` blocks — a failure here must not mask
 * the test's own result, but it must also not be ONLY recorded (#189): nothing
 * reads the `evidence` array during the run, so a record-only failure shipped
 * a green test on the one outcome a live suite must never report green — a
 * real box still billing, discovered by the bill instead of by the suite.
 * Callers accumulate the returned verdict and assert on it AFTER their
 * try/finally (the tier2-image-contract pattern), so a failed destroy can
 * fail the run without masking the body's own error.
 */
export async function destroyQuietly(driver: ExeDevDriver, vm: string, evidence: Record<string, unknown>[]): Promise<DestroyOutcome> {
  try {
    await driver.destroy(vm);
    evidence.push({ phase: "finally-destroy", vm, ok: true });
    return { ok: true };
  } catch (e) {
    // `String(e)` for non-Error throws: `(e as Error).message` would yield
    // undefined and the verdict's `error: string` contract would be a lie.
    const error = e instanceof Error ? e.message : String(e);
    try {
      // stderr as well as evidence: the operator watching a live round needs
      // the remediation NOW, not after opening the evidence JSON. Scrubbed
      // with the same scrubText the evidence write uses — driver/provider
      // errors ride through here verbatim. The `vm` interpolation in the
      // remediation is safe: every driver entry point (destroy included)
      // gates it through assertValidRunId's grammar, so it cannot carry
      // shell metacharacters. The write sits in its own try because an
      // aborting runner's dead stream must not throw out of the one
      // teardown primitive every finally leans on.
      process.stderr.write(scrubText(`[finally-destroy] DESTROY FAILED for ${vm}: ${error} — remediation: ssh exe.dev rm ${vm}\n`));
    } catch {
      // dead stderr — the evidence entry and the returned verdict still land
    }
    evidence.push({ phase: "finally-destroy", vm, ok: false, error });
    return { ok: false, error };
  }
}

/**
 * Best-effort key revoke for `finally` blocks — runs ONLY when the teardown verb
 * failed AND the key was minted. A failure here must not mask the test's own
 * result; logs to stderr and appends to evidence, NEVER throws — including on
 * a missing/half-written run record (#189): the record read used to sit above
 * the `try`, so exactly the runs that die before writing a readable record —
 * the ones that most need the forensic trail — threw out of the caller's
 * `finally`, skipping the box destroy, the evidence write and the workspace
 * cleanup. An unreadable record is recorded as a `finally-revoke ok:false`
 * verdict (the post-finally assertions in the live tests fail on it): it
 * cannot prove no key was minted, so it must not read as a clean revoke.
 *
 * ponytail: uses the same revoke primitive as the teardown verb itself
 * (revokeRunKey), gated by the keyHash presence in the record — no new API,
 * just the belt-and-braces fallback the teardown verb already provides.
 */
export async function revokeQuietly(
  driver: ExeDevDriver,
  store: RunRecordStore,
  runId: string,
  evidence: Record<string, unknown>[],
): Promise<void> {
  try {
    const rec = store.get(runId);
    if (!rec.keyHash) {
      return; // no key was ever minted — nothing to revoke
    }
    const keyApi: KeyApi = openRouterKeyApi();
    const result = await revokeRunKey({ keyApi, driver, store }, runId);
    evidence.push({ phase: "finally-revoke", runId, result, ok: result !== "none" });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Log to stderr so it's visible even if evidence write fails; never throw —
    // which is why the write sits in its own try (a dead stream under an
    // aborting runner must not break this function's never-throws contract)
    // and is scrubbed like every evidence string.
    try {
      process.stderr.write(scrubText(`[finally-revoke] failed for ${runId}: ${error}\n`));
    } catch {
      // dead stderr — the evidence entry still lands
    }
    evidence.push({ phase: "finally-revoke", runId, ok: false, error });
  }
}

/**
 * A `fleet teardown` run as CLEANUP — the same never-throws contract
 * `destroyQuietly` and `revokeQuietly` already keep, and for the same reason.
 *
 * An unguarded `await runFleet(["teardown", …])` inside a `finally` is two bugs
 * at once: a REJECTION (the 180 s ceiling firing, a dead spawn) escapes the
 * `finally`, skipping every later cleanup step — the box destroy, the leftover
 * sweep, the evidence write — and REPLACES the body's held error with a
 * teardown timeout; and a NON-ZERO exit was only ever pushed into `evidence`,
 * which nothing reads during the run, so a teardown that failed to revoke a key
 * or release a lock shipped green.
 *
 * Both become a verdict the caller accumulates alongside `destroyQuietly`'s.
 *
 * EVERY arm records `ok` (F10). Post-hoc evidence auditing in this repo reads
 * `phase === X && ok === false`, so an entry that carries only a non-zero
 * `exitCode` reads as CLEAN in exactly the filter written to find failures.
 *
 * `label` spreads FIRST (F15) so the entry's own fields win: a caller passing
 * `{ phase: … }` must not be able to rewrite the discriminator every one of
 * those filters keys off. Labels distinguish call sites through their own
 * fields (`at`, `arm`, `runId`) — the shape tier3-reaper already uses.
 *
 * `okExitCodes` defaults to `[0]` and exists for ONE real, verified case: a
 * teardown of a run whose record carries a `vmName`, no `closedAt` and NO
 * `keyHash` exits **6** BY DESIGN — `keyUnattributable` in scripts/fleet.ts
 * ("a box but no keyHash: if a key was minted for it, this teardown cannot
 * revoke it"). Every TIER-1 test that provisions without minting produces
 * exactly that record, so `[0]` there would report a spurious cleanup failure
 * on every GREEN round, and a suite that cries leak on a clean run is a suite
 * whose leak verdict stops being read. It can only ever WIDEN what counts as
 * success, so a caller must name the codes and say why — the box half of the
 * verdict (`destroyQuietly` + the cleanup-time listing) is unaffected either
 * way, and remains the check that a widened code cannot weaken.
 */
/**
 * The typed refusal code a fleet verb printed, or `null` if it printed none.
 *
 * The CLI writes one JSON object per line to stderr: the `FleetError` envelope
 * (which carries `code`) and then `logVerb`'s completion line (which does not).
 * The LAST line carrying a `code` is therefore the refusal, and reading it is
 * what makes "exit 5" actionable — `run-locked`, `fleet-busy` and `no-headroom`
 * all exit 5 and want different responses from a reader.
 */
function fleetRefusalCode(stderr: string): string | null {
  let code: string | null = null;
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { code?: unknown };
      if (typeof parsed.code === "string" && parsed.code !== "") code = parsed.code;
    } catch {
      /* a non-JSON line is not a verdict */
    }
  }
  return code;
}

export async function teardownQuietly(
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; okExitCodes?: readonly number[] },
  evidence: Record<string, unknown>[],
  label: Record<string, unknown> = {},
): Promise<DestroyOutcome> {
  const okExitCodes = opts.okExitCodes ?? [0];
  // SCRUBBED at the source (P126): the returned `error` is a cleanup problem
  // that `settleRun` splices into a thrown message and a CI log, and this is
  // the one feeder that carries RAW subprocess stderr — a `fleet teardown`
  // dying while echoing a PAT or an `sk-or-…` would otherwise put a live
  // credential in a PR comment. `settleRun` scrubs again; both, deliberately.
  try {
    const td = await runFleet(argv, opts);
    const ok = td.exitCode !== null && okExitCodes.includes(td.exitCode);
    evidence.push({
      ...label,
      phase: "finally-teardown",
      ok,
      exitCode: td.exitCode,
      // The REFUSAL CODE, not just the tail. A refused verb prints its typed
      // envelope and then `logVerb`'s completion line, and that trailing line
      // is longer than the 300-char tail — so a `run-locked` and a
      // `no-headroom` both arrived here as "exit 5" with the code scrolled off,
      // and diagnosing one cost a full extra live round. `code` is the fleet
      // CLI's stable discriminator (`FleetError`), so the last JSON line that
      // carries one is the verdict.
      refusalCode: fleetRefusalCode(td.stderr),
      stderrTail: scrubText(td.stderr.trim().slice(-300)),
    });
    if (ok) return { ok: true };
    return {
      ok: false,
      error: scrubText(`fleet teardown exited ${String(td.exitCode)} (expected ${okExitCodes.join("/")}): ${td.stderr.trim().slice(-200) || "(no stderr)"}`),
    };
  } catch (e) {
    const error = scrubText(e instanceof Error ? e.message : String(e));
    evidence.push({ ...label, phase: "finally-teardown", ok: false, exitCode: null, error });
    return { ok: false, error: `fleet teardown threw: ${error}` };
  }
}

/**
 * `writeEvidence` as CLEANUP — the same never-throws contract as the teardown
 * primitives above, and for a sharper reason (F11).
 *
 * Nine tiers wrote evidence as `try { writeEvidence(…) } finally { rmSync(…) }`
 * with NO catch, at the bottom of the outer `finally`. `writeEvidence` throws:
 * ENOSPC/EACCES from mkdir/writeFile, and — the case that matters — the
 * secret-scrub REFUSAL. So the one condition that most needs the verdict
 * machinery, a key leaked into evidence, was the one condition that skipped it:
 * the throw propagated out of the `finally` and `settleRun` on the next line
 * never ran, taking the body's real regression and the accumulated leaked-box
 * listing with it.
 *
 * The failure becomes a cleanup problem the caller's `settleRun` renders, and
 * stays LOUD on stderr — it is downgraded from "replaces every other fact" to
 * "reported alongside them", never to a swallowed warning.
 */
export function writeEvidenceQuietly(
  tag: string,
  name: string,
  payload: Record<string, unknown>,
  problems: string[],
): string {
  try {
    const path = writeEvidence(name, payload);
    try {
      process.stderr.write(`[${tag}] evidence: ${path}\n`);
    } catch {
      // dead stderr under an aborting runner — the file is written regardless
    }
    return path;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    problems.push(`the evidence write FAILED: ${error}`);
    try {
      process.stderr.write(scrubText(`[${tag}] EVIDENCE WRITE FAILED: ${error}\n`));
    } catch {
      // dead stderr — the problem entry still reaches settleRun
    }
    return "";
  }
}

/**
 * The standard cleanup verdict pair every fleet live test accumulates, rendered
 * as problem lines for {@link settleRun}. `finalBoxes === undefined` means the
 * final listing itself failed, and an UNMEASURED fleet is never a clean one
 * (D6's rule) — it is a problem, not a pass.
 *
 * `finalBoxes` should be {@link fleetLeftovers}'s `owned` — the boxes THIS RUN
 * owns. Account-wide strays are a warning `fleetLeftovers` already surfaced;
 * they must not fail this run (R4).
 *
 * Pass `evidence` to fold in `finally-revoke ok:false` entries too. T5.1 was
 * the only tier that did this by hand, so a `revokeQuietly` failure in any
 * other tier — including the sweeps that revoke boxes outside the `runIds`
 * {@link keyLeakProblems} checks — was evidence prose nothing asserted. Folding
 * it in HERE is what gives all twelve sites the same verdict.
 */
export function fleetCleanupProblems(
  destroyFailures: readonly string[],
  finalBoxes: string[] | undefined,
  evidence: readonly Record<string, unknown>[] = [],
): string[] {
  const problems: string[] = [];
  if (destroyFailures.length > 0) problems.push(`cleanup failures: ${destroyFailures.join(" | ")}`);
  if (finalBoxes === undefined) problems.push("the final fleet listing FAILED — an unmeasured fleet is never a clean one");
  else if (finalBoxes.length > 0) problems.push(`boxes still listed after cleanup: ${finalBoxes.join(", ")}`);
  const revokeFailures = evidence.filter((p) => p.phase === "finally-revoke" && p.ok === false);
  if (revokeFailures.length > 0) {
    problems.push(
      `revoke failures: ${revokeFailures.map((p) => `${String(p.runId ?? "(no runId)")}: ${String(p.error ?? "(no error recorded)")}`).join(" | ")}`,
    );
  }
  return problems;
}

/** {@link fleetLeftovers}' verdict: what THIS RUN still owns, and what it merely saw. */
export interface FleetLeftoverReport {
  /**
   * Boxes this run owns that are STILL listed after the lag poll AND a destroy
   * attempt. `undefined` means the listing itself failed — feed it straight to
   * {@link fleetCleanupProblems}, which renders that as a problem, not a pass.
   */
  owned: string[] | undefined;
  /**
   * Every other `e2e-`/`qds-` box in the account. WARNED about, never failed on
   * (R4) — and never destroyed, because this run cannot prove it owns them.
   */
  strays: string[];
}

/**
 * The cleanup-time fleet listing, done ONCE and correctly, for all twelve live
 * tests (P127/P128/R4). It replaces the single-shot line every site copied:
 *
 *   const final = (await ctx.driver.list()).map((b) => b.name)
 *     .filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
 *
 * Three things were wrong with that line, and one call site cannot fix them:
 *
 *  1. **It is single-shot.** exe.dev's destroy lag was MEASURED at 25 s+
 *     (r7-T-h1: `rm` exits 0 while the box stays listed). Only
 *     tier2-fanout-bestofn and tier2-dispatch-engine polled; every other site
 *     turned a clean cleanup into a failed paid round, and a leak verdict that
 *     cries wolf stops being read. The poll (5 × 8 s by default, the two
 *     tier-2 files' measured values) is now in one place.
 *  2. **It is account-wide.** One box stranded by a previous round or a
 *     concurrent operator failed EVERY test in the round. So: report wide, act
 *     narrow — only names this run OWNS reach the failing verdict; the rest are
 *     a clearly-labelled warning on stderr and in evidence (R4).
 *  3. **Nothing destroyed what it found.** A backstop that only observes is a
 *     bill. Owned survivors are `destroyQuietly`'d before the verdict is
 *     rendered, and only what survives THAT is reported (P128). Strays are
 *     never destroyed — this run cannot prove they are its own, and killing a
 *     concurrent round's live box is worse than reporting it.
 *
 * NEVER THROWS: every listing is guarded and `destroyQuietly` is total, so this
 * is safe as a bare `await` inside a `finally`.
 *
 * @param owns names this run created — an array, or a predicate for the case
 *   where the box exists under a name the run never learned
 *   (`create-shape-unresolved`), e.g. `(n) => n.startsWith(fanoutId)`.
 */
export async function fleetLeftovers(
  driver: ExeDevDriver,
  owns: readonly string[] | ((name: string) => boolean),
  evidence: Record<string, unknown>[],
  opts: { maxAttempts?: number; retryDelayMs?: number; prefixes?: readonly string[] } = {},
): Promise<FleetLeftoverReport> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const retryDelayMs = opts.retryDelayMs ?? 8_000;
  // F13 lesson: dispatch mints `qds-…` box names — filtering only `e2e-…`
  // reported a false-clean [] while three boxes billed.
  const prefixes = opts.prefixes ?? ["e2e-", "qds-"];
  const isOwned = typeof owns === "function" ? owns : (n: string): boolean => owns.includes(n);

  let lastError = "";
  const sweep = async (): Promise<string[] | undefined> => {
    try {
      return (await driver.list()).map((b) => b.name).filter((n) => prefixes.some((p) => n.startsWith(p)));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  };

  let listed: string[] | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    listed = await sweep();
    if (listed !== undefined && !listed.some(isOwned)) break;
    if (attempt < maxAttempts) {
      evidence.push({
        phase: "final-ls-retry",
        attempt,
        remaining: listed ?? null,
        ...(listed === undefined ? { error: lastError } : {}),
        note: "r7-T-h1: measured 25 s+ substrate destroy lag — polling before reporting a leak",
      });
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  let owned = listed?.filter(isOwned);
  if (owned !== undefined && owned.length > 0) {
    // P128: destroy what the run could own BEFORE reporting what survived.
    for (const name of owned) await destroyQuietly(driver, name, evidence);
    const after = await sweep();
    owned = after?.filter(isOwned);
    listed = after ?? listed;
  }

  const strays = (listed ?? []).filter((n) => !isOwned(n));
  evidence.push({
    phase: "final-ls",
    ok: owned !== undefined && owned.length === 0,
    attempts,
    fleetBoxes: listed ?? null,
    owned: owned ?? null,
    strays,
    ...(listed === undefined ? { error: lastError } : {}),
  });
  if (strays.length > 0) {
    try {
      process.stderr.write(
        scrubText(
          `[final-ls] WARNING (does NOT fail this run): ${strays.length} e2e-/qds- box(es) in the account are NOT this run's and were left alone: ${strays.join(", ")} — if no other live round is in flight, sweep by hand: ssh exe.dev rm <name>\n`,
        ),
      );
    } catch {
      // dead stderr under an aborting runner — the evidence entry still lands
    }
  }
  return { owned, strays };
}

/**
 * "The box the teardown verb destroyed is really gone", POLLED (L3).
 *
 * Five live tiers asserted this with a single `driver.list()` taken
 * milliseconds after `teardown` returned — against exe.dev's MEASURED 25 s+
 * destroy lag (r7-T-h1: `rm` exits 0 while the box stays listed), which is the
 * whole reason {@link fleetLeftovers} polls. So a healthy round went red for
 * substrate lag on the most expensive tests in the tree.
 *
 * This is deliberately NOT `fleetLeftovers`: that helper DESTROYS an owned
 * survivor before rendering its verdict, which is right for a `finally` and
 * wrong for a body assertion about whether the teardown verb did its own job —
 * it would report clean for a teardown that never destroyed anything. This one
 * only ever looks.
 *
 * Never throws: a listing that failed is `{ absent: false, error }`, because an
 * unmeasured fleet is never a clean one (D6's rule).
 */
export async function awaitBoxAbsent(
  driver: ExeDevDriver,
  name: string,
  evidence: Record<string, unknown>[],
  opts: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<{ absent: boolean; attempts: number; error?: string }> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const retryDelayMs = opts.retryDelayMs ?? 8_000;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let listed: string[] | undefined;
    try {
      listed = (await driver.list()).map((b) => b.name);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (listed !== undefined && !listed.includes(name)) {
      evidence.push({ phase: "box-gone", ok: true, name, attempts: attempt });
      return { absent: true, attempts: attempt };
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  evidence.push({
    phase: "box-gone",
    ok: false,
    name,
    attempts: maxAttempts,
    ...(lastError === "" ? {} : { error: lastError }),
  });
  return { absent: false, attempts: maxAttempts, ...(lastError === "" ? {} : { error: lastError }) };
}

/** The last JSON line of a verb's stdout — the verb's OUTPUT, not its prose. */
export function lastJsonLine<T>(stdout: string): T {
  return JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}") as T;
}

/**
 * `fleet status <runId>`, read until the row stops answering `unknown` (L8/L14).
 *
 * DF1.10 AC5 made this row a REAL substrate reading: an absent marker is
 * corroborated by `systemctl is-active` on the run's unit, so one row costs two
 * bounded ssh round trips — and `unknown` is the fail-CLOSED verdict for
 * "neither probe answered", which on a box created seconds ago is a cold first
 * ssh multiplex far more often than it is a fault. A single-shot read therefore
 * turned a zero-spend TIER-1 red for substrate latency.
 *
 * `unknown` is RETRIED, never accepted: this returns the last state it saw, so
 * an unknown that persists to the attempt ceiling still fails the caller's
 * assertion, naming itself. A non-zero verb exit is retried the same way and
 * recorded — one flaky `bun scripts/fleet.ts status` must not end a paid round
 * that is otherwise healthy.
 */
export async function statusStateSettled(
  runId: string,
  recordsDir: string,
  evidence: Record<string, unknown>[],
  opts: { attempts?: number; waitMs?: number; timeoutMs?: number } = {},
): Promise<{ state: string; row: Record<string, unknown>; exitCode: number | null; attempts: number }> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const waitMs = opts.waitMs ?? 5_000;
  let row: Record<string, unknown> = {};
  let exitCode: number | null = null;
  let state = "";
  const seen: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
        timeoutMs: opts.timeoutMs ?? 60_000,
      });
      exitCode = res.exitCode;
      row = res.exitCode === 0 ? lastJsonLine<Record<string, unknown>>(res.stdout) : {};
      state = typeof row.state === "string" ? row.state : "";
      seen.push({ attempt, exitCode, state });
      if (exitCode === 0 && state !== "" && state !== "unknown") break;
    } catch (e) {
      exitCode = null;
      state = "";
      seen.push({ attempt, exitCode: null, error: e instanceof Error ? e.message : String(e) });
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  evidence.push({ phase: "status-read", runId, state, exitCode, seen });
  return { state, row, exitCode, attempts: seen.length };
}

/**
 * The KEY half of the cleanup verdict — the half seven of nine tiers did not
 * have (F17).
 *
 * A `fleet teardown` regression that destroys the box and exits 0 while
 * SKIPPING the revoke passed every one of them green: the box is gone, the exit
 * code is 0, and nothing looked at whether the minted key still existed. A live
 * key surviving a "clean" round is a real-money leak of the same class as a
 * leaked box, and the suite's whole claim is that green means proven.
 *
 * Call from the `finally`, AFTER the teardown/destroy legs, and fold the result
 * into the same problems list {@link fleetCleanupProblems} feeds {@link
 * settleRun} — a bare `expect` here would rebuild the very shape this PR is
 * deleting (a cleanup assertion that throws over the top of the body's error).
 *
 * FAIL-SAFE ORDER: revoke first, report second. A surviving hash is REVOKED by
 * the `revokeQuietly` fallback before anything is reported, so the round does
 * not merely announce a live key — and a round that needed the fallback is
 * still not a clean round, because needing it IS the teardown defect.
 *
 * "Could not look" is never "nothing leaked": a failed listing (including
 * `listedKeyHashes`'s D6 truncation refusal) is a problem, exactly as an
 * unmeasured fleet is.
 *
 * TOTAL (P138): this is `await`ed bare inside every tier-3–5 `finally`, ahead
 * of the evidence write, so a rejection here would discard the held body error,
 * skip `writeEvidenceQuietly`, skip `rmSync` and make `settleRun` unreachable —
 * the exact F2/F11 shape the rest of this harness removes. Making the helper
 * itself total is the one fix no caller can forget.
 */
export async function keyLeakProblems(
  before: ReadonlySet<string>,
  fallback: {
    driver: ExeDevDriver;
    store?: RunRecordStore;
    runIds: readonly string[];
    /**
     * The provider listing. Defaults to the REAL {@link listedKeyHashes}; the
     * parameter exists only so live-harness.test.ts can prove this verdict
     * offline, the same documented-seam shape the driver's `run` option is.
     * No *.live.test.ts may pass it — that would be a fake.
     */
    list?: () => Promise<Set<string>>;
  },
  evidence: Record<string, unknown>[],
): Promise<string[]> {
  try {
    return await keyLeakProblemsInner(before, fallback, evidence);
  } catch (e) {
    // Belt-and-braces for the never-throws contract: every leg below is already
    // guarded, so reaching here means a future edit broke that — and a broken
    // key check must still be a VERDICT, not an escape from the caller's
    // `finally`.
    const error = e instanceof Error ? e.message : String(e);
    evidence.push({ phase: "key-hash-delta", ok: false, error });
    return [`the key-leak check itself FAILED (${error}) — an unmeasured key population is never a clean one`];
  }
}

async function keyLeakProblemsInner(
  before: ReadonlySet<string>,
  fallback: { driver: ExeDevDriver; store?: RunRecordStore; runIds: readonly string[]; list?: () => Promise<Set<string>> },
  evidence: Record<string, unknown>[],
): Promise<string[]> {
  const listOnce = fallback.list ?? ((): Promise<Set<string>> => listedKeyHashes());
  const list = async (): Promise<{ hashes: Set<string> } | { error: string }> => {
    try {
      return { hashes: await listOnce() };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const first = await list();
  if ("error" in first) {
    evidence.push({ phase: "key-hash-delta", ok: false, error: first.error });
    return [`the key-hash delta could not be rendered (${first.error}) — an unmeasured key population is never a clean one`];
  }
  const leaked = [...first.hashes].filter((h) => !before.has(h));
  evidence.push({ phase: "key-hash-delta", ok: leaked.length === 0, leaked });
  if (leaked.length === 0) return [];
  // Revoke BEFORE reporting: the operator reading the failure should find the
  // key already dead, not a hash to go chase by hand.
  let attemptedRevoke = false;
  for (const runId of fallback.runIds) {
    if (runId === "" || fallback.store === undefined) continue;
    attemptedRevoke = true;
    await revokeQuietly(fallback.driver, fallback.store, runId, evidence);
  }
  // P132: with no runIds (or no store) the loop above did NOTHING, and the
  // "after the harness fallback revoke" wording then told the operator the
  // strongest remediation was already exhausted when it never ran.
  const tried = attemptedRevoke
    ? "after the harness fallback revoke"
    : "and NO record-backed fallback revoke was available (no runIds/store were passed), so nothing has been attempted";
  const second = await list();
  if ("error" in second) {
    evidence.push({ phase: "key-hash-delta-recheck", ok: false, error: second.error, attemptedRevoke });
    return [
      `key hashes outlived the run (${leaked.join(", ")}) and the post-fallback re-list FAILED (${second.error}) — treat every one as LIVE and revoke by hand`,
    ];
  }
  const surviving = leaked.filter((h) => second.hashes.has(h));
  evidence.push({ phase: "key-hash-delta-recheck", ok: surviving.length === 0, surviving, attemptedRevoke });
  if (surviving.length > 0) {
    return [`key hashes STILL LIVE ${tried}: ${surviving.join(", ")} — revoke by hand`];
  }
  return [
    `key hashes outlived the teardown and were revoked by the harness fallback: ${leaked.join(", ")} — needing the fallback IS the defect, so this round is not clean`,
  ];
}

/**
 * The one post-`finally` verdict, and the ordering it exists to fix.
 *
 * The shape this replaces was `expect(destroyFailures).toEqual([]);
 * expect(finalBoxes).toEqual([]); if (failure !== undefined) throw failure;` —
 * correct on a GREEN run and wrong on a red one: when the body had already
 * failed AND a box leaked, the first `expect` threw its own AssertionError
 * about the leak and the held body error was discarded. The operator then reads
 * "boxes still listed" where an engine regression was, and pays for another
 * live round to rediscover it.
 *
 * So a cleanup problem is ATTACHED to the held error and the ORIGINAL is
 * re-thrown — both facts survive, in the right order of importance — while on a
 * run that otherwise passed, a cleanup problem is still the failure.
 */
export function settleRun(failure: unknown, problems: readonly string[]): void {
  // SCRUBBED (P126): `teardownQuietly` feeds up to 200 chars of raw subprocess
  // stderr into `problems`, and these two renderings are what reach a CI log
  // and a PR comment. Every sibling path in this file already scrubs.
  const cleanup = problems.map(scrubText);
  if (failure !== undefined) {
    if (cleanup.length > 0) {
      const line = `[cleanup] ${cleanup.join("; ")}`;
      // ALWAYS on stderr, on both arms: a bun matcher error carries a
      // pre-rendered `matcherResult`, so a reporter that re-renders from it
      // would never print the appended text. The leak must not depend on that.
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // dead stderr under an aborting runner — the held failure still throws
      }
      if (failure instanceof Error) {
        // Appended, not replaced: the ORIGINAL error object is re-thrown so the
        // operator reads the regression first and bun keeps its own rendering.
        // Guarded against a second `settleRun` on the same object double-
        // appending the same block.
        if (!failure.message.includes(line)) failure.message = `${failure.message}\n${line}`;
        throw failure;
      }
      // A non-Error throw has no `message` to append to, and stderr alone is
      // not assertable — the docstring's promise ("both facts survive") did not
      // hold on this arm. Wrap, keeping the original reachable as `cause`.
      throw new Error(`${scrubText(String(failure))}\n${line}`, { cause: failure });
    }
    throw failure;
  }
  if (cleanup.length > 0) throw new Error(`the test body passed but cleanup did not: ${cleanup.join("; ")}`);
}

/** Fresh tmp workspace; `rmSync` it in the test's outer finally. */
export function tmpWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `qds-e2e-${label}-`));
}
