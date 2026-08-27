/**
 * DF3.3 C2 — unit tests for src/fleet/resident.ts (the resident agent, fleet
 * side of the steering pair). The pi subprocess is exercised for real through
 * Bun.spawn against tests/fleet/fixtures/fake-pi-resident.ts (argv-compatible
 * fake binary); rate tables are injected via the module's rate-source seam so
 * nothing here depends on the host's ~/.pi/agent/models.json. Constants are
 * IMPORTED from source, never mirrored. No sleeping: hang/timeout cases rely on
 * Bun.spawn's native timeout with a small QDS_RESIDENT_TIMEOUT_MS override.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _injectRateSources,
  _resolvedSolicitTimeoutMs,
  DEFAULT_RESIDENT_SLUG,
  startResident,
  type ResidentSpawn,
} from "../../src/fleet/resident.ts";
import { RateError, type RateSources } from "../../src/phase-engine/roster/validate.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-3-resident-")));
const fakePi = join(import.meta.dir, "fixtures", "fake-pi-resident.ts");
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Secret-shaped value delivered env-borne — long enough to be redactable. */
const SECRET = "sk-or-v1-df33-resident-fixture-secret-000000111111";
const PROMPT = "Resident: read the dispatch brief and steer at the next point.";

/** $0.08/$0.18 per MTok (R5 §6 fact 9 provenance) → 80_000/180_000 integer µ$. */
const TEST_SOURCES: RateSources = {
  bundled: {
    unit: "usd-per-mtok",
    entries: new Map([
      [
        `openrouter/${DEFAULT_RESIDENT_SLUG}`,
        { input: 0.08, output: 0.18, cacheRead: 0.016, cacheWrite: 0.018 },
      ],
    ]),
  },
  custom: { unit: "usd-per-mtok", entries: new Map() },
};
const EMPTY_SOURCES: RateSources = {
  bundled: { unit: "usd-per-mtok", entries: new Map() },
  custom: { unit: "usd-per-mtok", entries: new Map() },
};

/** DF3.1 brief value — already validated at ingress; only non-emptiness matters here. */
function brief(): Record<string, unknown> {
  return {
    repoSlug: "biospark33/QDS-Factory",
    issueId: 33,
    commitSha: "a".repeat(40),
    manifestPath: "pipeline.yaml",
  };
}

function caseDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpRoot, `${name}-`)));
}

/** Child env for the fake pi: PATH inherited, key env-borne, fake knobs set.
 * Fixture knobs (QDS_FAKE_PI_* and FAKE_RESIDENT_* prefixes) are scrubbed from
 * THIS process's env before the spread so a developer's shell settings cannot
 * leak into a child that sets its own via `over`. */
function piEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(QDS_FAKE_PI_|FAKE_RESIDENT_)/.test(key)) env[key] = value;
  }
  return { ...env, OPENROUTER_API_KEY: SECRET, ...over };
}

function readRecord(dir: string): { argv: string[]; env: { OPENROUTER_API_KEY: string | null }; promptPrePersisted: boolean | null } {
  return JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
}

/** Narrow the disabled union; every caller in this file expects a live spawn. */
function enabled(res: ReturnType<typeof startResident>): ResidentSpawn {
  expect(res).not.toHaveProperty("disabled");
  return res as ResidentSpawn;
}

beforeEach(() => {
  chmodSync(fakePi, 0o755);
  _injectRateSources(TEST_SOURCES);
});
afterEach(() => {
  _injectRateSources(null);
  // `= undefined` stores the string "undefined" under Bun and stays truthy.
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_RESIDENT_TIMEOUT_MS;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_PI_BIN;
});

describe("AC4 — empty brief disables the resident before any spawn", () => {
  test.each([null, undefined, {}, ""])("brief %j → {disabled:true}, zero spawn attempts", (empty) => {
    const dir = caseDir("disabled");
    // Rate sources deliberately unusable: the disabled check must fire FIRST,
    // so a rate-less config can never turn "no brief" into a refusal.
    _injectRateSources(EMPTY_SOURCES);
    const res = startResident({
      brief: empty,
      runId: "run-disabled",
      sessionDir: dir,
      bin: fakePi,
      env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
    });
    expect(res).toEqual({ disabled: true });
    // Zero spawn attempts: the recording fake never ran.
    expect(existsSync(join(dir, "record.json"))).toBe(false);
  });

  test("whitespace-only string brief disables; a non-empty string spawns", async () => {
    const dir = caseDir("briefstr");
    _injectRateSources(EMPTY_SOURCES);
    expect(
      startResident({
        brief: "   ",
        runId: "run-blank",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    ).toEqual({ disabled: true });

    _injectRateSources(TEST_SOURCES);
    const live = enabled(
      startResident({
        brief: "steer toward the acceptance criteria",
        runId: "run-text",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await live.caller.call(PROMPT);
    expect(existsSync(join(dir, "record.json"))).toBe(true);
  });
});

describe("ingress validation (runId + slug become paths and argv)", () => {
  test("runId with path traversal refuses BEFORE any spawn", () => {
    const dir = caseDir("runidbad");
    for (const bad of ["../../escape", "sub/dir", "", ".hidden", "a".repeat(129)]) {
      expect(() =>
        startResident({
          brief: brief(),
          runId: bad,
          sessionDir: dir,
          bin: fakePi,
          env: piEnv(),
        }),
      ).toThrow(/runId/);
    }
    // The refusal fires before mkdir: the session dir stays empty.
    expect(existsSync(join(dir, "..", "..", "escape.resident.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "sub", "dir.resident.jsonl"))).toBe(false);
  });

  test("a slug that is not a vendor/model id refuses with a clear error", () => {
    for (const bad of ["openrouter/", "openrouter//x", "/"]) {
      expect(() =>
        startResident({
          brief: brief(),
          runId: "run-slugbad",
          sessionDir: caseDir("slugbad"),
          slug: bad,
          bin: fakePi,
          env: piEnv(),
        }),
      ).toThrow(/vendor\/model/);
    }
  });
});

describe("rate resolution (DF1.5 rule, consumed not re-derived)", () => {
  test("unresolvable slug throws RateError and refuses BEFORE spawn", () => {
    const dir = caseDir("rateerror");
    _injectRateSources(EMPTY_SOURCES);
    expect(() =>
      startResident({
        brief: brief(),
        runId: "run-rate",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    ).toThrow(RateError);
    expect(existsSync(join(dir, "record.json"))).toBe(false);
  });

  test("resolved rate is exposed on the spawn, input/output µ$/MTok only", () => {
    // Pin the slug itself: the provenance default is the FULL vendor/model id,
    // which is what makes it resolvable against the canonical
    // `openrouter/${vendor}/${model}` table key (validate.ts:396).
    expect(DEFAULT_RESIDENT_SLUG).toBe("deepseek/deepseek-v4-flash-0731");
    const spawn = enabled(
      startResident({ brief: brief(), runId: "run-rate-ok", sessionDir: caseDir("rateok"), bin: fakePi, env: piEnv() }),
    );
    expect(spawn.rate).toEqual({ inputPerMTok: 80_000, outputPerMTok: 180_000 });
  });

  test("a provider-qualified roster slug resolves the same rate, argv stays bare", async () => {
    // resolveRate's tables key `${provider}/${model}` (validate.ts:92) — the
    // source-fact fix for the spec's bare-slug lookup. Both slug forms must
    // price identically and pass the bare id to --model.
    const dir = caseDir("qualified");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-qualified",
        sessionDir: dir,
        slug: `openrouter/${DEFAULT_RESIDENT_SLUG}`,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    expect(spawn.rate).toEqual({ inputPerMTok: 80_000, outputPerMTok: 180_000 });
    await spawn.caller.call(PROMPT);
    expect(readRecord(dir).argv).toContain(DEFAULT_RESIDENT_SLUG);
    expect(readRecord(dir).argv).not.toContain(`openrouter/${DEFAULT_RESIDENT_SLUG}`);
  });
});

describe("spawn contract (runWorkerPi-adapted argv, env-borne key)", () => {
  test("argv is exactly the frozen shape; key rides env, never argv", async () => {
    const dir = caseDir("argv");
    const sessionDir = join(dir, "sessions");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-1",
        sessionDir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await spawn.caller.call(PROMPT);
    const rec = readRecord(dir);
    expect(rec.argv).toEqual([
      "--provider",
      "openrouter",
      "--model",
      DEFAULT_RESIDENT_SLUG,
      "--mode",
      "json",
      "--no-tools",
      "--session",
      join(sessionDir, "run-1.resident.jsonl"),
      "-p",
      PROMPT,
    ]);
    // INV-RES-3 / DF1.6 INV-1: the credential is env-borne and absent from argv.
    expect(rec.env.OPENROUTER_API_KEY).toBe(SECRET);
    expect(rec.argv.join(" ")).not.toContain(SECRET);
  });

  test("session path is per-runId (the session FILE is the continuity)", async () => {
    const dir = caseDir("session");
    const sessionDir = join(dir, "sessions");
    for (const runId of ["run-a", "run-b"]) {
      const sub = join(dir, runId);
      mkdirSync(sub, { recursive: true });
      const spawn = enabled(
        startResident({
          brief: brief(),
          runId,
          sessionDir,
          bin: fakePi,
          env: piEnv({ QDS_FAKE_PI_RECORD: join(sub, "record.json") }),
        }),
      );
      await spawn.caller.call(PROMPT);
      expect(readRecord(sub).argv).toContain(join(sessionDir, `${runId}.resident.jsonl`));
    }
  });

  test("bin falls back to QDS_PI_BIN when opts.bin is absent", async () => {
    const dir = caseDir("pibin");
    process.env.QDS_PI_BIN = fakePi;
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-pibin",
        sessionDir: dir,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    const reply = await spawn.caller.call(PROMPT);
    expect(reply.raw).toBe('{"action":"proceed"}');
    expect(existsSync(join(dir, "record.json"))).toBe(true);
  });
});

describe("reply + usage harvest (harvestPiStream, message_end only)", () => {
  test("usage totals come from message_end; decoy events never count", async () => {
    const dir = caseDir("harvest");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-harvest",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_RECORD: join(dir, "record.json"),
          QDS_FAKE_PI_TEXT: '{"action":"retry","guidance":"compare bytes"}',
          QDS_FAKE_PI_INPUT: "7",
          QDS_FAKE_PI_OUTPUT: "11",
        }),
      }),
    );
    const reply = await spawn.caller.call(PROMPT);
    expect(reply.raw).toBe('{"action":"retry","guidance":"compare bytes"}');
    expect(reply.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
    expect(await spawn.exitStatus()).toBe("success");
  });

  test("garbage stdout resolves with empty raw (malformed handling is C1's)", async () => {
    const dir = caseDir("garbage");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-garbage",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json"), QDS_FAKE_PI_MODE: "garbage" }),
      }),
    );
    const reply = await spawn.caller.call(PROMPT);
    expect(reply.raw).toBe("");
    expect(reply.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await spawn.exitStatus()).toBe("success");
  });
});

describe("process-end mapping (exitStatus, CC-1 values)", () => {
  test("timeout SIGKILL → call throws, exitStatus 'transient'", async () => {
    const dir = caseDir("timeout");
    process.env.QDS_RESIDENT_TIMEOUT_MS = "500";
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-timeout",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json"), QDS_FAKE_PI_MODE: "hang" }),
      }),
    );
    await expect(spawn.caller.call(PROMPT)).rejects.toThrow();
    expect(await spawn.exitStatus()).toBe("transient");
  });

  test("missing binary (ENOENT) → call throws, exitStatus 'logic' (a misconfig never heals on retry)", async () => {
    const dir = caseDir("enoent");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-enoent",
        sessionDir: dir,
        bin: join(dir, "no-such-pi-binary"),
        env: piEnv(),
      }),
    );
    await expect(spawn.caller.call(PROMPT)).rejects.toThrow();
    expect(await spawn.exitStatus()).toBe("logic");
  });

  test("nonzero exit → call throws, exitStatus 'logic'", async () => {
    const dir = caseDir("fail");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-fail",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json"), QDS_FAKE_PI_MODE: "fail" }),
      }),
    );
    await expect(spawn.caller.call(PROMPT)).rejects.toThrow();
    expect(await spawn.exitStatus()).toBe("logic");
  });

  test("stop() SIGKILLs the in-flight call (DF3.6 decides when, this supplies how)", async () => {
    const dir = caseDir("stop");
    // Timeout deliberately far above the hang fixture's kill: a NO-OP stop()
    // would let the call run to the native timeout, so a rejection arriving
    // well under the budget is the only discrimination a no-op cannot fake.
    process.env.QDS_RESIDENT_TIMEOUT_MS = "30000";
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-stop",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json"), QDS_FAKE_PI_MODE: "hang" }),
      }),
    );
    const startedAt = performance.now();
    const pending = spawn.caller.call(PROMPT);
    await spawn.stop(); // no sleeping: call() reaches its spawn synchronously
    await expect(pending).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(await spawn.exitStatus()).toBe("transient");
    // Idempotent: a second stop with nothing in flight still resolves.
    await spawn.stop();
  });

  test("stop() BEFORE any call → the call refuses instead of spawning into a dead resident", async () => {
    const dir = caseDir("stoptop");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-stoptop",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await spawn.stop();
    await expect(spawn.caller.call(PROMPT)).rejects.toThrow(/stopped/);
    // Nothing was spawned: the recording fake never ran.
    expect(existsSync(join(dir, "record.json"))).toBe(false);
  });
});

describe("persistence + redaction (§5.2 pre-execution, INV-RES-3)", () => {
  test("prompt persists redacted BEFORE spawn; reply persists redacted", async () => {
    const dir = caseDir("persist");
    const persistDir = join(dir, "trace");
    const runId = "run-persist";
    const promptPath = join(persistDir, `${runId}-solicit-1-prompt.txt`);
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId,
        sessionDir: dir,
        bin: fakePi,
        persistDir,
        env: piEnv({
          QDS_FAKE_PI_RECORD: join(dir, "record.json"),
          QDS_FAKE_PI_PROMPT_PATH: promptPath,
          // The reply echoes the secret: persisted reply must be redacted too.
          QDS_FAKE_PI_TEXT: `{"action":"proceed","note":"echo ${SECRET}"}`,
        }),
      }),
    );
    const reply = await spawn.caller.call(`steer this: ${SECRET}`);
    // The caller sees the RAW reply (redaction is for artifacts, not the pipe).
    expect(reply.raw).toContain(SECRET);

    const rec = readRecord(dir);
    expect(rec.promptPrePersisted).toBe(true);
    const promptBody = readFileSync(promptPath, "utf8");
    expect(promptBody).toContain("[REDACTED:OPENROUTER_API_KEY]");
    expect(promptBody).not.toContain(SECRET);
    const replyBody = readFileSync(join(persistDir, `${runId}-solicit-1-reply.txt`), "utf8");
    expect(replyBody).toContain("[REDACTED:OPENROUTER_API_KEY]");
    expect(replyBody).not.toContain(SECRET);
  });

  test("no persistDir → nothing written, call still works", async () => {
    const dir = caseDir("nopersist");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-nopersist",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await spawn.caller.call(PROMPT);
    expect(await spawn.exitStatus()).toBe("success");
  });

  test("B4: QDS_RESIDENT_TIMEOUT_MS is read from opts.env, not this process's env", async () => {
    const dir = caseDir("envtimeout");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-envtimeout",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_RECORD: join(dir, "record.json"),
          QDS_FAKE_PI_MODE: "hang",
          QDS_RESIDENT_TIMEOUT_MS: "500",
        }),
      }),
    );
    const startedAt = performance.now();
    await expect(spawn.caller.call(PROMPT)).rejects.toThrow(/killed by signal/);
    // The opts.env override (500 ms) fired, not the 60 s default.
    expect(performance.now() - startedAt).toBeLessThan(30_000);
    expect(await spawn.exitStatus()).toBe("transient");
  });

  test("B4: an out-of-range timeout override falls back to the default (clamped to 600 000)", () => {
    // Resolution table, asserted directly through the `_resolvedSolicitTimeoutMs`
    // seam (the `_injectRateSources` convention): out-of-range, non-integer,
    // and non-numeric overrides all resolve to the 60 s default instead of
    // Bun.spawn's ~0 ms NaN timeout or a 2^31-1 ms (~24.8 day) hang. The
    // spawn-path wiring of the resolved value is covered by the fast 500 ms
    // in-range leg above — no 60 s hang needed here.
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "600001" })).toBe(60_000);
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "600000" })).toBe(600_000);
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "0" })).toBe(60_000);
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "-5" })).toBe(60_000);
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "1.5" })).toBe(60_000);
    expect(_resolvedSolicitTimeoutMs({ QDS_RESIDENT_TIMEOUT_MS: "not-a-number" })).toBe(60_000);
    expect(_resolvedSolicitTimeoutMs({})).toBe(60_000);
  });

  test("B8: reply persist failure is best-effort — usage still returns", async () => {
    const dir = caseDir("replyfail");
    const persistDir = join(dir, "trace");
    mkdirSync(persistDir, { recursive: true });
    // The REPLY artifact path is a directory, so its write fails (EISDIR) while
    // the prompt artifact — same dir, pre-execution, fail-closed — succeeds.
    mkdirSync(join(persistDir, "run-replyfail-solicit-1-reply.txt"), { recursive: true });
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-replyfail",
        sessionDir: dir,
        bin: fakePi,
        persistDir,
        env: piEnv({
          QDS_FAKE_PI_RECORD: join(dir, "record.json"),
          QDS_FAKE_PI_INPUT: "5",
          QDS_FAKE_PI_OUTPUT: "9",
        }),
      }),
    );
    const reply = await spawn.caller.call(PROMPT);
    expect(reply.raw).toBe('{"action":"proceed"}');
    expect(reply.usage).toEqual({ inputTokens: 5, outputTokens: 9 });
    expect(await spawn.exitStatus()).toBe("success");
  });
});

describe("session continuity (the session FILE is the conversation)", () => {
  test("two calls on one resident append the SAME session file; a new runId starts a fresh one", async () => {
    const dir = caseDir("continuity");
    const sessionDir = join(dir, "sessions");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-cont",
        sessionDir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await spawn.caller.call(PROMPT);
    await spawn.caller.call(PROMPT);
    const sessionPath = join(sessionDir, "run-cont.resident.jsonl");
    const linesAfterTwo = readFileSync(sessionPath, "utf8").trim().split("\n").length;
    expect(linesAfterTwo).toBe(2);

    const other = enabled(
      startResident({
        brief: brief(),
        runId: "run-other",
        sessionDir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    await other.caller.call(PROMPT);
    // A different runId never shares the session file.
    expect(readFileSync(sessionPath, "utf8").trim().split("\n").length).toBe(linesAfterTwo);
    expect(readFileSync(join(sessionDir, "run-other.resident.jsonl"), "utf8")).toContain("called");
  });
});
