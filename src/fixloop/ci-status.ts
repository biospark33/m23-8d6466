/**
 * DF6.1b — the SHA-bound CI-verdict poll (`src/fixloop/ci-status.ts`).
 *
 * The required-check verdict is POLLED from the host, never received: three
 * host-authenticated `gh` CLI invocations per poll across two surfaces, because
 * neither surface alone carries both facts — `gh pr view <n> --json
 * headRefOid,headRefName` (issued BEFORE and AFTER the checks read; `gh pr
 * checks` exposes no per-check commit sha) and `gh pr checks <n> --required
 * --json name,state,bucket` (the required-check set with its settled bucket;
 * `gh pr view --json statusCheckRollup` carries no requiredness marker and no
 * `bucket`). Both `headRefOid` reads must equal the recorded `attemptSha` — any
 * inequality discards the whole poll before any state transition (INV-4).
 *
 * The host token is handed to the `gh` CHILD's environment only — never this
 * process's environment, never argv — the same containment `gitEnv` uses for
 * git credentials in `src/pr/push.ts` and `readHostToken` enforces by keeping
 * the token out of `process.env` in the first place.
 *
 * Branch on the OUTPUT, never on the exit code: `gh pr checks` exits 8 for
 * "checks pending" and non-zero for the empty-required-set message, and both
 * are ordinary pending ticks inside the poll window. Malformed output and a
 * missing `gh` binary fail CLOSED immediately — they are never retried into a
 * green and never a green at all.
 *
 * The poll never reruns CI and never marks a PR green on its own authority:
 * green means every required check settled `pass` on a sha-bound read.
 */
import { readHostToken } from "../pr/github.ts";

/** The poll cadence — the story's 30 seconds. */
export const CI_POLL_INTERVAL_MS = 30_000;
/** The CI-poll window — 15 minutes measured from `pushVerifiedSha`'s return. */
export const CI_POLL_WINDOW_MS = 15 * 60_000;

/** One `gh` invocation's result. */
export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The `gh` seam. Production default: `ghRunnerFromToken`, which spawns the real
 * binary with `GH_TOKEN` on the child's environment only. Tests script this.
 */
export type GhRunner = (argv: readonly string[]) => Promise<GhResult>;

/** `ghRunnerFromToken`'s failure: no way to invoke gh, or the host has no token. */
export class GhRunnerUnavailableError extends Error {
  readonly remediation: string;
  constructor(message: string, remediation: string) {
    super(message);
    this.name = "GhRunnerUnavailableError";
    this.remediation = remediation;
  }
}

/**
 * The production `gh` runner: the token rides the CHILD process's environment
 * (`GH_TOKEN`), never this process's environment and never argv — the child env
 * is built per-spawn from a sanitized copy plus the one token.
 */
export function ghRunnerFromToken(token: string): GhRunner {
  return async (argv) => {
    const proc = Bun.spawn(["gh", ...argv], {
      env: { ...process.env, GH_TOKEN: token },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

/** The default runner reads the host token the same way every host verb does. */
export async function defaultGhRunner(): Promise<GhRunner> {
  const token = await readHostToken();
  if (token === null || token === "") {
    throw new GhRunnerUnavailableError(
      "no host GitHub token is available for the gh child (keychain empty and stdin not piped)",
      "store the token in the keychain entry qds-factory-github, or pipe it on stdin",
    );
  }
  return ghRunnerFromToken(token);
}

// ─── the checks read ─────────────────────────────────────────────────────────

export interface CheckEntry {
  name: string;
  state: string;
  bucket: string;
}

/**
 * Parse `gh pr checks --required --json name,state,bucket` output. Throws on
 * anything that is not a JSON array of `{name, bucket}` entries — the parser is
 * the fail-closed point between GitHub's output and a verdict.
 */
export function parseChecksJson(stdout: string): CheckEntry[] {
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw)) throw new Error("gh pr checks output is not a JSON array");
  const out: CheckEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw new Error("gh pr checks entry is not an object");
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.bucket !== "string") {
      throw new Error("gh pr checks entry lacks string name/bucket (an old gh without the bucket field?)");
    }
    out.push({ name: e.name, state: typeof e.state === "string" ? e.state : "", bucket: e.bucket });
  }
  return out;
}

const EMPTY_REQUIRED_SET_RE = /no required checks reported on the '/;

// ─── the poll ────────────────────────────────────────────────────────────────

export type PollVerdict =
  | { kind: "green"; polls: number; checks: string[] }
  | { kind: "ci-red"; polls: number; failedChecks: { name: string; bucket: string }[] }
  | { kind: "ci-verdict-unavailable"; polls: number; reason: string };

export interface PollRequiredChecksOpts {
  prNumber: number;
  /** The sha `pushVerifiedSha` published — both head reads must equal it. */
  attemptSha: string;
  /** The persisted ISO anchor: when the push returned and the window opened. */
  windowOpenedAt: string;
  gh: GhRunner;
  now?: () => Date;
  /** Injected in tests; the production sleep is the 30-second cadence. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll the PR's required checks every 30 seconds until the required set
 * settles or the 15-minute window (opened at `windowOpenedAt`, the persisted
 * `pushVerifiedSha`-return anchor) expires. Every poll is SHA-bound on BOTH
 * reads; a stale or intermediate sha, a sha that moved between the reads, an
 * empty/partial required set (registration lag), a pending bucket and an exit-8
 * tick are all the same thing inside the window: a pending poll, retried.
 * Malformed output or a throwing runner fails closed immediately.
 */
export async function pollRequiredChecks(o: PollRequiredChecksOpts): Promise<PollVerdict> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const openedMs = Date.parse(o.windowOpenedAt);
  if (!Number.isFinite(openedMs)) {
    return { kind: "ci-verdict-unavailable", polls: 0, reason: "the persisted poll-window anchor is unparseable — failing closed (INV-6), never a restarted window" };
  }
  const deadlineMs = openedMs + CI_POLL_WINDOW_MS;
  const viewArgv = ["pr", "view", String(o.prNumber), "--json", "headRefOid,headRefName"] as const;
  const checksArgv = ["pr", "checks", String(o.prNumber), "--required", "--json", "name,state,bucket"] as const;

  let polls = 0;
  /** One head read: `"retry"` on an API-side non-zero; `"broken:<reason>"` fails closed; else the sha. */
  const readHead = async (): Promise<string | "retry"> => {
    let res: GhResult;
    try {
      res = await o.gh(viewArgv);
    } catch (e) {
      return `broken:the gh runner failed during a head read: ${(e as Error).message}`;
    }
    if (res.exitCode !== 0) return "retry";
    try {
      const parsed = JSON.parse(res.stdout) as { headRefOid?: unknown };
      if (typeof parsed.headRefOid !== "string" || parsed.headRefOid === "") {
        return "broken:gh pr view returned no usable headRefOid";
      }
      return parsed.headRefOid;
    } catch {
      return "broken:gh pr view returned malformed JSON";
    }
  };

  for (;;) {
    if (now().getTime() >= deadlineMs) {
      return { kind: "ci-verdict-unavailable", polls, reason: "the 15-minute poll window expired without a settled required-check set — ci-verdict-unavailable, never a green" };
    }
    polls++;

    const before = await readHead();
    if (before === "retry") {
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }
    if (typeof before === "string" && before.startsWith("broken:")) {
      // The tooling itself failed (missing binary, kill, unparseable output) —
      // fail closed NOW, not after fifteen minutes of garbage (INV-6).
      return { kind: "ci-verdict-unavailable", polls, reason: before.slice("broken:".length) };
    }

    let entries: CheckEntry[] | undefined;
    let brokenReason: string | undefined;
    let pendingTick = false;
    try {
      const res = await o.gh(checksArgv);
      try {
        // Branch on the OUTPUT: exit 8 (checks pending) and the empty-set
        // non-zero both still describe the world, but only parseable JSON is a
        // check set.
        entries = parseChecksJson(res.stdout);
      } catch {
        const combined = `${res.stdout}\n${res.stderr}`;
        // registration lag and API-side failures are pending ticks; exit-0
        // garbage is broken tooling.
        pendingTick = EMPTY_REQUIRED_SET_RE.test(combined) || res.exitCode !== 0;
        if (!pendingTick) brokenReason = "gh pr checks returned malformed output";
      }
    } catch (e) {
      // The runner itself broke — fail closed NOW, not after fifteen minutes.
      brokenReason = `the gh runner failed during the checks read: ${(e as Error).message}`;
    }
    if (brokenReason !== undefined) {
      return { kind: "ci-verdict-unavailable", polls, reason: brokenReason };
    }

    // An empty REQUIRED set observed INSIDE the window is registration lag —
    // GitHub has not registered the check runs yet. Pending, retried; only the
    // window's expiry converts it to ci-verdict-unavailable. The attempt-START
    // empty-set refusal lives in probeRequiredChecks, before any dispatch.
    if (pendingTick || entries === undefined || entries.length === 0) {
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }

    const after = await readHead();
    if (after === "retry") {
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }
    if (typeof after === "string" && after.startsWith("broken:")) {
      return { kind: "ci-verdict-unavailable", polls, reason: after.slice("broken:".length) };
    }

    // INV-4: both reads must equal the recorded attemptSha. Any other sha —
    // an earlier commit, an intermediate commit of the same push, a newer
    // commit that landed mid-poll, or a sha that moved between the two reads —
    // discards the WHOLE poll before any state transition.
    if (before !== o.attemptSha || after !== o.attemptSha) {
      // the whole poll is discarded — retry inside the window
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }

    const pending = entries.filter((c) => c.bucket === "pending");
    if (pending.length > 0) {
      await sleep(CI_POLL_INTERVAL_MS);
      continue;
    }
    const failed = entries.filter((c) => c.bucket !== "pass");
    if (failed.length === 0) {
      return { kind: "green", polls, checks: entries.map((c) => c.name) };
    }
    // A settled non-pass required bucket (fail, skipping, cancel) is ci-red.
    // The loop never reruns CI — the operator decides whether to rerun.
    return { kind: "ci-red", polls, failedChecks: failed.map((c) => ({ name: c.name, bucket: c.bucket })) };
  }
}

// ─── the attempt-start probe ─────────────────────────────────────────────────

export type ProbeResult =
  | { present: true; /** The required check names. */ checks: string[]; /** The full entries, buckets included — attempt 2's brief reads the failed ones. */ entries: CheckEntry[] }
  | { present: false; message: string };

/**
 * AC1's attempt-start probe: the empty-required-set refusal is evaluated
 * BEFORE the push, against the PR's required checks as `gh pr checks <n>
 * --required` reports them — whose "no required checks reported on the
 * '<branch>' branch" answer IS the refusal mechanism. A PR whose required set
 * is empty is refused with nothing provisioned, never counted green. Any other
 * failure to read the probe fails closed (a typed error, never `present`).
 */
export async function probeRequiredChecks(o: { prNumber: number; gh: GhRunner }): Promise<ProbeResult> {
  let res: GhResult;
  try {
    res = await o.gh(["pr", "checks", String(o.prNumber), "--required", "--json", "name,state,bucket"]);
  } catch (e) {
    throw new Error(`the attempt-start required-check probe could not run gh: ${(e as Error).message}`);
  }
  try {
    const entries = parseChecksJson(res.stdout);
    return entries.length > 0
      ? { present: true, checks: entries.map((c) => c.name), entries }
      : { present: false, message: res.stderr || res.stdout };
  } catch {
    const combined = `${res.stdout}\n${res.stderr}`;
    if (EMPTY_REQUIRED_SET_RE.test(combined)) {
      return { present: false, message: combined.trim() };
    }
    throw new Error(
      `the attempt-start required-check probe could not read gh pr checks (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(0, 200)}`,
    );
  }
}
