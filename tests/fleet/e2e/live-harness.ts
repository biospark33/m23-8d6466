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
import { mintRunKey, openRouterKeyApi, revokeRunKey } from "../../../src/providers/credentials.ts";
import type { KeyApi } from "../../../src/providers/credentials.ts";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
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
 */
export async function preflight(tier: "1" | "2" = "1"): Promise<LiveCtx> {
  liveGate(tier);
  let whoami: string;
  try {
    whoami = await new ExeDevDriver().whoami();
  } catch (e) {
    throw new Error(
      `exe.dev preflight failed (whoami): ${(e as Error).message} — remediation: run \`ssh exe.dev whoami\` by hand; if the agent/keys are missing or expired, run the interactive login yourself and re-run. Driver auth = local ssh agent/~/.ssh (TOFU accept-new), no in-repo flow exists.`,
    );
  }
  return {
    driver: new ExeDevDriver(),
    repoUrl: process.env.QDS_EXEDEV_REPO_URL ?? "",
    sha: process.env.QDS_EXEDEV_SHA ?? "",
    rosterPath: process.env.QDS_EXEDEV_ROSTER ?? "",
    whoami,
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
 */
export function writeEvidence(name: string, payload: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  const path = join(EVIDENCE_DIR, `${stamp}-${name}.json`);
  const body = JSON.stringify({ writtenAt: now.toISOString(), ...(scrubDeep(payload) as Record<string, unknown>) }, null, 2);
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
  try {
    const [, stdout, stderr] = await Promise.all([
      Promise.race([
        proc.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`runFleet timeout after ${opts.timeoutMs ?? 300_000} ms: fleet ${argv.join(" ")}`)), opts.timeoutMs ?? 300_000);
        }),
      ]),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).catch(async (e) => {
      proc.kill();
      throw e;
    });
    return { exitCode: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill(); // no-op on an exited process
  }
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

/** Every key hash the provider currently lists (revoke verification). */
export async function listedKeyHashes(): Promise<Set<string>> {
  const keyApi: KeyApi = openRouterKeyApi();
  const { entries } = await keyApi.listAllKeys(10);
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

/** Best-effort box destroy for `finally` blocks — a failure here must not mask the test's own result. */
export async function destroyQuietly(driver: ExeDevDriver, vm: string, evidence: Record<string, unknown>[]): Promise<void> {
  try {
    await driver.destroy(vm);
    evidence.push({ phase: "finally-destroy", vm, ok: true });
  } catch (e) {
    evidence.push({ phase: "finally-destroy", vm, ok: false, error: (e as Error).message });
  }
}

/**
 * Best-effort key revoke for `finally` blocks — runs ONLY when the teardown verb
 * failed AND the key was minted. A failure here must not mask the test's own
 * result; logs to stderr and appends to evidence, never throws.
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
  const rec = store.get(runId);
  if (!rec.keyHash) {
    return; // no key was ever minted — nothing to revoke
  }
  try {
    const keyApi: KeyApi = openRouterKeyApi();
    const result = await revokeRunKey({ keyApi, driver, store }, runId);
    evidence.push({ phase: "finally-revoke", runId, result, ok: result !== "none" });
  } catch (e) {
    // Log to stderr so it's visible even if evidence write fails; never throw.
    process.stderr.write(`[finally-revoke] failed for ${runId}: ${(e as Error).message}\n`);
    evidence.push({ phase: "finally-revoke", runId, ok: false, error: (e as Error).message });
  }
}

/** Fresh tmp workspace; `rmSync` it in the test's outer finally. */
export function tmpWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `qds-e2e-${label}-`));
}
