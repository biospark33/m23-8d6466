/**
 * Fake exe.dev substrate for DF2.2 — the command-seam double.
 *
 * The real ExeDevDriver shells out to `ssh exe.dev <control-plane>` and
 * `ssh <vm>.exe.xyz <cmd>` / `scp`. No ssh faking precedent existed in this
 * repo (Track B), so this fake follows the FakeDriver precedent instead: it
 * intercepts the command seam the driver is constructed with and executes box
 * commands FOR REAL on the host, in a per-box directory, with stub `pi` and
 * `curl` binaries prepended to PATH. That way the driver's argv serialization,
 * the gate's orchestration, and `assertions-in-box.sh` itself all run their
 * real logic — only the substrate (exe.dev control plane, OpenRouter, pi) is
 * doubled, and doubled by CONTENT (what the stubs print), never by exit status
 * (INV-3: `pi --list-models` exits 0 while printing "No models available").
 *
 * Not registered as a driver: tests construct `new ExeDevDriver({ run: fake.run })`
 * so the driver under test is the production class, only the seam is swapped.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../../../../src/providers/driver.ts";

/** Structural twin of the driver's ExeCommand seam — no import needed, on purpose. */
export type FakeCommand = (
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<ExecResult>;

/** What `ssh exe.dev new --json` pretends to return (its real shape is UNVERIFIED). */
export type NewShapeMode = "recognized" | "unrecognized" | "empty-url";

/** Stub-`pi` behaviour for `pi --list-models` (B) — content, not exit status. */
export type PiMode = "table" | "no-models";

/** Everything the in-box stubs read at call time, per box. */
export interface FakeBoxConfig {
  /** `new --json` response shape for this box's create (UNVERIFIED-shape test needs "unrecognized"). */
  newShape?: NewShapeMode;
  pi: {
    mode: PiMode;
    /** `cost.total` a `pi -p --mode json` run reports (D's first half). */
    costTotal: number;
    /**
     * Raw `cost.total` emitted VERBATIM in the pi JSON (round 6). `costTotal`
     * rides Python json.dumps, which cannot emit bare Infinity — this knob
     * serves payloads json.load parses as float("inf") (D non-finite guard).
     */
    costTotalRaw?: string;
  };
  /** Planted verbatim at `<home>/.pi/agent/models.json` (D's second half). */
  modelsJson: Record<string, unknown>;
  /** `GET /api/v1/key` answer (E). `limit: null` = uncapped key. */
  key: { limit: number | null; usage: number };
  /** Override the entire /api/v1/key response body (E regression testing). */
  keyBody?: unknown;
  /**
   * Raw `/api/v1/key` body printed VERBATIM (E hardening). `keyBody` rides
   * JSON.stringify, which turns NaN into null — this knob serves payloads
   * Python json.load accepts but JSON.stringify cannot carry, like bare NaN.
   */
  keyRawBody?: string;
  /**
   * `chat/completions` answers by bare model id (C). Omit a model to fall back
   * to `default`. Set an entry to `null` to make that model's ping fail.
   */
  chat: { default?: { content?: string; reasoning?: string }; byModel?: Record<string, { content?: string; reasoning?: string } | null> };
  /** Delete the stub `pi` from PATH — "command not found" for B. */
  piMissing?: boolean;
  /** Delete the stub `curl` — assertion C/E missing-dependency path. */
  curlMissing?: boolean;
}

/** The full-cost default: a box that passes all five assertions. */
export function passingBoxConfig(): FakeBoxConfig {
  return {
    newShape: "recognized",
    pi: { mode: "table", costTotal: 4.3e-05 },
    modelsJson: {
      models: {
        "deepseek/deepseek-v4-flash-0731": {
          cost: { input: 1.4e-07, output: 1.4e-07, cacheRead: 1.4e-08, cacheWrite: 1.4e-07 },
          provider: { zdr: true, data_collection: "deny" },
        },
      },
    },
    key: { limit: 20, usage: 0.5 },
    chat: { default: { content: "ready" }, byModel: {} },
  };
}

const STUB_PI = `#!/usr/bin/env python3
# Fake pi 0.55.0 — reads .fake-exedev.json beside it. Content is the contract.
import json, os, sys

cfg = {}
try:
    with open(os.environ["FAKE_EXEDEV_CONFIG"]) as f:
        cfg = json.load(f)
except Exception:
    pass
pi = cfg.get("pi", {})

args = sys.argv[1:]
if "--version" in args:
    print("pi 0.55.0")
    sys.exit(0)
if "--list-models" in args:
    # THE trap: exit 0 while printing "No models available" (R4 3.4, INV-3).
    if pi.get("mode") == "no-models":
        print("No models available")
        sys.exit(0)
    print("provider  model  context  max-out  thinking  images")
    print("openrouter  deepseek/deepseek-v4-flash-0731  64k  8k  off  no")
    sys.exit(0)
if "-p" in args:
    raw = pi.get("costTotalRaw")
    if raw is not None:
        # round 6: hand-built JSON so bare Infinity reaches json.load as float("inf")
        print('{"content": "ok", "cost": {"total": ' + str(raw) + '}, "usage": {"cost": {"total": ' + str(raw) + '}}}')
        sys.exit(0)
    total = pi.get("costTotal", 0)
    print(json.dumps({"content": "ok", "cost": {"total": total}, "usage": {"cost": {"total": total}}}))
    sys.exit(0)
print("fake pi: unsupported invocation", file=sys.stderr)
sys.exit(64)
`;

const STUB_CURL = `#!/usr/bin/env python3
# Fake curl — serves chat/completions (C) and /api/v1/key (E) from config.
import json, os, sys

cfg = {}
try:
    with open(os.environ["FAKE_EXEDEV_CONFIG"]) as f:
        cfg = json.load(f)
except Exception:
    pass

url = ""
method = "GET"
body = None
args = sys.argv[1:]
# The auth header must ride STDIN (curl -K -), never argv — an argv-carried
# Authorization is exactly the ps-visible leak the real script guards against.
if any(a.lower().startswith("authorization:") for a in args):
    print("fake curl: Authorization header in argv — must ride stdin via -K -", file=sys.stderr)
    sys.exit(21)
i = 0
while i < len(args):
    a = args[i]
    if a in ("-s", "-S", "--silent", "--max-time", "-H"):
        if a == "--max-time":
            i += 1  # swallow the value
        elif a == "-H":
            i += 1  # swallow the header value (never echo it back)
    elif a in ("-K", "--config"):
        # Config file arg; with "-" it is STDIN — consumed and never echoed.
        if i + 1 < len(args) and args[i + 1] == "-":
            sys.stdin.read()
        i += 1  # swallow the config source
    elif a in ("-X", "--request"):
        method = args[i + 1]; i += 1
    elif a in ("-d", "--data"):
        body = args[i + 1]; i += 1
    elif a.startswith("http://") or a.startswith("https://"):
        url = a
    i += 1

if url.endswith("/chat/completions"):
    model = ""
    if body:
        try:
            model = json.loads(body).get("model", "")
        except Exception:
            model = ""
    chat = cfg.get("chat", {})
    entry = chat.get("byModel", {}).get(model, chat.get("default", {}))
    if entry is None:
        print(json.dumps({"error": {"message": f"provider refused {model}"}}), file=sys.stderr)
        sys.exit(1)
    msg = {}
    if entry.get("content") is not None:
        msg["content"] = entry["content"]
    if entry.get("reasoning") is not None:
        msg["reasoning"] = entry["reasoning"]
    if not msg:
        msg["content"] = None  # both-null: C must fail on content, not crash
    print(json.dumps({"choices": [{"message": msg}]}))
    sys.exit(0)

if url.endswith("/api/v1/key"):
    if cfg.get("keyRawBody") is not None:
        print(cfg["keyRawBody"])
    elif cfg.get("keyBody") is not None:
        print(json.dumps(cfg["keyBody"]))
    else:
        key = cfg.get("key", {})
        print(json.dumps({"data": {"limit": key.get("limit"), "usage": key.get("usage", 0)}}))
    sys.exit(0)

print(f"fake curl: unhandled url {url}", file=sys.stderr)
sys.exit(22)
`;

/** A recorded argv the fake can assert on from tests (e.g. "no command ran"). */
export interface FakeExeDev {
  readonly root: string;
  /** The command-seam implementation handed to ExeDevDriver. */
  readonly run: FakeCommand;
  /** Every argv the seam saw, in order. */
  readonly calls: string[][];
  /** (Re)configure a box's stub behaviour. */
  configure(name: string, patch: Partial<FakeBoxConfig>): void;
  /** Box workspace dir (exec cwd) — tests build the git worktree here. */
  boxDir(name: string): string;
  /** Box HOME — models.json/.env live under here. */
  homeDir(name: string): string;
  /** Destroy every box directory (afterAll). */
  cleanup(): void;
}

export interface FakeExeDevOptions {
  root?: string;
  /** Default `new --json` shape for boxes created afterwards. */
  newShape?: NewShapeMode;
  /** When set, `ls <name> --json` reports NOTHING for any name (AC5 both-unusable path). */
  lsAlwaysEmpty?: boolean;
  /** `ls --json` omits `https_url` — exercises create's DERIVED provenance. */
  lsOmitHttps?: boolean;
  /**
   * The in-box gate script "dies" after C's line: the seam returns C's ok line
   * with exit 255 — the measured shape of a dropped connection / killed ssh
   * mid-script. The host MUST fail closed (unproven D/E), never go green on
   * partial evidence.
   */
  truncateScript?: boolean;
  /**
   * The in-box gate script EXITS 0 but emits fabricated evidence — "c-only"
   * (C's line alone) or "duplicates" (C twice + D). Exit 0 is not proof of
   * completeness: the host must fail closed on the unproven remainder.
   */
  fabricateScriptEvidence?: "c-only" | "duplicates";
}

export function fakeExeDev(opts: FakeExeDevOptions = {}): FakeExeDev {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "qds-fake-exedev-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const boxes = new Map<string, { dir: string; home: string; bin: string }>();
  const calls: string[][] = [];

  function ensureBox(name: string): { dir: string; home: string; bin: string } {
    let box = boxes.get(name);
    if (box) return box;
    const dir = join(root, name);
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "app"), { recursive: true, mode: 0o700 });
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    box = { dir, home, bin };
    boxes.set(name, box);
    configure(name, { newShape: opts.newShape });
    return box;
  }

  function configPath(name: string): string {
    return join(boxes.get(name)!.home, ".fake-exedev.json");
  }

  function writeConfig(name: string, cfg: FakeBoxConfig): void {
    const box = ensureBox(name);
    writeFileSync(configPath(name), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(box.home, ".pi", "agent", "models.json"), `${JSON.stringify(cfg.modelsJson, null, 2)}\n`, { mode: 0o600 });
    const piPath = join(box.bin, "pi");
    const curlPath = join(box.bin, "curl");
    rmSync(piPath, { force: true });
    rmSync(curlPath, { force: true });
    if (!cfg.piMissing) writeFileSync(piPath, STUB_PI, { mode: 0o755 });
    if (!cfg.curlMissing) writeFileSync(curlPath, STUB_CURL, { mode: 0o755 });
  }

  function readConfig(name: string): FakeBoxConfig {
    try {
      return JSON.parse(readFileSync(configPath(name), "utf8")) as FakeBoxConfig;
    } catch {
      return passingBoxConfig();
    }
  }

  function configure(name: string, patch: Partial<FakeBoxConfig>): void {
    ensureBox(name);
    const cfg = { ...passingBoxConfig(), ...readConfig(name), ...patch };
    writeConfig(name, cfg);
  }

  /** `ssh exe.dev new --name N --tag T --json` — UNVERIFIED shape, mode-selectable. */
  function newJson(name: string, tag: string | undefined): string {
    const mode = readConfig(name).newShape ?? "recognized";
    if (mode === "unrecognized") {
      // Keys no recognized reader would accept.
      return JSON.stringify({ instance: { displayName: name, kind: "vm" }, ...(tag ? { labels: [tag] } : {}) });
    }
    if (mode === "empty-url") {
      // Recognized shape (vm_name present) but empty https_url — exercises create's derived provenance (F6).
      return JSON.stringify({ vm_name: name, https_url: "", ssh_dest: `${name}.exe.xyz` });
    }
    return JSON.stringify({ vm_name: name, https_url: `https://${name}.exe.xyz`, ssh_dest: `${name}.exe.xyz` });
  }

  /** `ssh exe.dev ls [name] --json` — the ONE Measured shape. */
  function lsJson(name: string | undefined): string {
    const names = [...boxes.keys()].sort().filter((n) => name === undefined || n === name);
    const vms = names.map((n) => {
      const base = { vm_name: n, ssh_dest: `${n}.exe.xyz` };
      // lsOmitHttps: the MEASURED shape permits an absent https_url — the
      // driver must then DERIVE <name>.exe.xyz (its derived provenance).
      return opts.lsOmitHttps ? base : { ...base, https_url: `https://${n}.exe.xyz` };
    });
    return JSON.stringify({ vms });
  }

  async function spawnLocal(
    argv: string[],
    box: { dir: string; home: string; bin: string },
    stdin?: string,
    timeoutMs?: number,
  ): Promise<ExecResult> { /* dp:ok a rejection here is the test failing — there is nothing to recover */
    // Strip host credentials a box must not inherit: a leaked host
    // OPENROUTER_API_KEY would let E pass without DF2.3's delivery file,
    // masking a missing-key bug as a green gate.
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: box.home,
      // Hermetic PATH: the stub bin, then ONLY the system dirs. The host
      // developing this repo has a real `pi` and `curl` on its own PATH —
      // leaking them into a "box" would let B pass with the host's registry
      // exactly the way a $?-trusting implementation does.
      PATH: `${box.bin}:/usr/bin:/bin`,
      FAKE_EXEDEV_CONFIG: join(box.home, ".fake-exedev.json"),
    };
    env.OPENROUTER_API_KEY = undefined;
    const proc = Bun.spawn({
      cmd: argv,
      cwd: box.dir,
      env,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  const run: FakeCommand = async (argv, callOpts) => { /* dp:ok a rejection here is the test failing — there is nothing to recover */
    calls.push(argv);
    const timeoutMs = callOpts?.timeoutMs;
    const [cmd, target, ...rest] = argv;

    if (cmd === "ssh" && target === "exe.dev") {
      const sub = rest.join(" ");
      // `new --name <id> [--tag <tag>] --json`
      let m = /^new --name (\S+)( --tag (\S+))? --json$/.exec(sub);
      if (m) {
        const name = m[1] as string;
        ensureBox(name);
        return { stdout: `${newJson(name, m[3])}\n`, stderr: "", exitCode: 0 };
      }
      // `ls [<name>] --json` — reports only; never creates. An unknown name is
      // an empty vms list, which is what destroy-idempotency re-reads.
      m = /^ls( (\S+))? --json$/.exec(sub);
      if (m) {
        const name = m[2];
        if (opts.lsAlwaysEmpty) return { stdout: '{"vms":[]}\n', stderr: "", exitCode: 0 };
        return { stdout: `${lsJson(name)}\n`, stderr: "", exitCode: 0 };
      }
      // `rm <vm>` — a missing VM fails with a not-found line; the driver must
      // re-read `ls` (content) to honour the idempotent-destroy contract.
      m = /^rm (\S+)$/.exec(sub);
      if (m) {
        const name = m[1] as string;
        if (!boxes.has(name)) {
          return { stdout: "", stderr: `vm not found: ${name}\n`, exitCode: 1 };
        }
        boxes.delete(name);
        rmSync(join(root, name), { recursive: true, force: true });
        return { stdout: `removed ${name}\n`, stderr: "", exitCode: 0 };
      }
      if (/^whoami$/.test(sub)) return { stdout: "fake-exedev-operator\n", stderr: "", exitCode: 0 };
      if (/^share port (\S+) (\d+)$/.test(sub)) return { stdout: `shared ${sub}\n`, stderr: "", exitCode: 0 };
      if (/^share set-public (\S+)$/.test(sub)) return { stdout: `public ${sub}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: `fake exe.dev: unsupported control-plane: ${sub}\n`, exitCode: 64 };
    }

    if (cmd === "ssh" && typeof target === "string" && target.endsWith(".exe.xyz")) {
      const name = target.slice(0, -".exe.xyz".length);
      const box = boxes.get(name);
      if (!box) return { stdout: "", stderr: `no such box: ${name}\n`, exitCode: 255 };
      const command = rest.join(" "); // ssh semantics: trailing args join into one remote command
      // Simulated mid-script death: the in-box gate script's marker + this
      // box's truncateScript flag → C's line arrives, then the "connection"
      // drops (255). The driver must fail closed on the unproven D/E.
      if (opts.truncateScript && command.includes("DF2.2 — setup-gate assertions")) {
        const cLine = JSON.stringify({ item: "C", ok: true, note: "C: simulated line before the drop" });
        return { stdout: `${cLine}\n`, stderr: "ssh: connection closed by remote host\n", exitCode: 255 };
      }
      // Fabricated completeness: the script exits 0 but did NOT prove all of
      // C/D/E — the host's acceptance predicate must refuse the evidence.
      if (opts.fabricateScriptEvidence && command.includes("DF2.2 — setup-gate assertions")) {
        const line = (item: string) => JSON.stringify({ item, ok: true, note: `simulated ${item} line` });
        const stdout =
          opts.fabricateScriptEvidence === "c-only"
            ? `${line("C")}\n`
            : `${line("C")}\n${line("C")}\n${line("D")}\n`;
        return { stdout, stderr: "", exitCode: 0 };
      }
      return spawnLocal(["sh", "-c", command], box, callOpts?.stdin, timeoutMs);
    }

    if (cmd === "scp") {
      // `scp -q <vm>.exe.xyz:<remote> <local>` — box → host only.
      const remoteIdx = argv.findIndex((a) => a.includes(".exe.xyz:"));
      const localIdx = argv.length - 1;
      if (remoteIdx < 0) return { stdout: "", stderr: "fake scp: no remote spec\n", exitCode: 1 };
      const remoteSpec = argv[remoteIdx] as string;
      const at = remoteSpec.indexOf(".exe.xyz:");
      const name = remoteSpec.slice(0, at);
      const remote = remoteSpec.slice(at + ".exe.xyz:".length);
      const box = boxes.get(name);
      if (!box) return { stdout: "", stderr: `no such box: ${name}\n`, exitCode: 1 };
      const res = await spawnLocal(["cp", remote, argv[localIdx] as string], box, undefined, timeoutMs);
      return res;
    }

    return { stdout: "", stderr: `fake exe.dev: unsupported command: ${argv.join(" ")}\n`, exitCode: 64 };
  };

  return {
    root,
    run,
    calls,
    configure,
    boxDir: (name) => ensureBox(name).dir,
    homeDir: (name) => ensureBox(name).home,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An attested `vm-sharing: admins-only` posture file, for the contract suite's setPublic. */
export function writePostureAttestation(dir: string): string {
  const path = join(dir, "exedev-posture.json");
  writeFileSync(
    path,
    `${JSON.stringify({ vmSharing: "admins-only", attestedAt: "2026-08-15T00:00:00.000Z", attestedBy: "test" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}
