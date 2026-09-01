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

import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_VERSION, readBunPin } from "../../../../scripts/build-exedev-image.ts";
import type { ExecResult } from "../../../../src/providers/driver.ts";
import {
  DEFAULT_IMAGE_BUILD_ID,
  DEFAULT_IMAGE_REF,
  IMAGE_MARKER_PATH,
} from "../../../../src/providers/exedev/driver.ts";

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
    /** `usage.cost.total` the provider's chat response reports (D's first
     *  half — D's instrument is a curl chat call, NOT `pi -p`, which stalls
     *  nondeterministically on real boxes; see assertions-in-box.sh). */
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
  /** HTTP status the chat endpoint reports to `-w '%{http_code}'` (D). Default 200. */
  chatHttpCode?: number;
  /** Delete the stub `pi` from PATH — "command not found" for B. */
  piMissing?: boolean;
  /** Delete the stub `curl` — assertion C/E missing-dependency path. */
  curlMissing?: boolean;
  /**
   * What `/etc/qds-image.json` holds in this box (DF2.10 gate B, INV-IBOX-2).
   *
   * `null` is the file being ABSENT; any string is exactly what `cat` prints,
   * byte for byte — an over-cap blob, a truncated JSON fragment and a marker
   * whose `buildId` disagrees with the repo pin are all just strings here.
   * Doubling this by CONTENT rather than by exit status is the same discipline
   * the pi/curl stubs follow (INV-3): a box that boots the wrong image answers
   * its marker read successfully, and the WRONG ANSWER is the whole failure.
   *
   * Omitted ⇒ {@link DEFAULT_IMAGE_MARKER}, a well-formed marker carrying the
   * repo pin's own `buildId`, so every pre-DF2.10 box in this suite keeps
   * passing gate B.
   */
  imageMarker?: string | null;
  /**
   * Exit status for the marker's PRESENCE probe (`test -f`), overriding the one
   * {@link FakeBoxConfig.imageMarker} implies.
   *
   * Deriving both exits from `imageMarker === null` made two of
   * `imageMarkerFailure`'s arms unreachable, so nothing could reach them: a
   * foreign image can ship a root-only 0600 marker where `test -f` succeeds and
   * `cat` fails (the `unreadable` arm), and ssh itself can answer 255/137 for
   * either command without saying anything about the image (the transport-fault
   * arm). These are exit-status knobs and that is deliberate: the INV-3 "double
   * by content" rule is about what the box SAYS, and a box that never answered
   * said nothing at all.
   */
  imageMarkerProbeExit?: number;
  /** Exit status for the marker's `cat`, overriding the marker-implied one. */
  imageMarkerCatExit?: number;
  /** The `cat` capture hit the transport read cap — `ExecResult.truncated`. */
  imageMarkerTruncated?: boolean;
}

/**
 * The marker a FACTORY box bakes: well-formed, and every field the build stamps
 * is IMPORTED from where the build stamps it — the pin's `buildId` from
 * `driver.ts`, `piVersion` from the build script's `PI_VERSION`, `bunVersion`
 * from the repo's own `packageManager` pin via `readBunPin`. A hand-copied
 * literal here keeps reading green on the day one of them moves and the boxes
 * stop matching it, which is the entire failure this marker exists to catch.
 */
export const DEFAULT_IMAGE_MARKER = `${JSON.stringify(
  {
    imageRef: DEFAULT_IMAGE_REF,
    buildId: DEFAULT_IMAGE_BUILD_ID,
    piVersion: PI_VERSION,
    bunVersion: readBunPin(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")),
    builtAt: "2026-08-31T00:00:00.000Z",
    gitSha: "b".repeat(40),
  },
  null,
  2,
)}\n`;

/** The full-cost default: a box that passes all five assertions. */
export function passingBoxConfig(): FakeBoxConfig {
  return {
    newShape: "recognized",
    pi: { mode: "table", costTotal: 4.3e-05 },
    // USD-per-million-token rates, matching the catalog the demo ships
    // (tests/providers/fixtures/df2-4-models.json) — the in-box twin must
    // carry the same units the placed file does.
    modelsJson: {
      models: {
        "deepseek/deepseek-v4-flash-0731": {
          cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
          provider: { zdr: true, data_collection: "deny" },
        },
      },
    },
    key: { limit: 20, usage: 0.5 },
    chat: { default: { content: "ready" }, byModel: {} },
    imageMarker: DEFAULT_IMAGE_MARKER,
  };
}

const STUB_PI = `#!/usr/bin/env python3
# Fake pi — reads .fake-exedev.json beside it. Content is the contract. The
# version it reports is the IMPORTED pin, not a hand-typed literal: a stub
# stuck on a version no factory box ever ran would land any future
# models.json-absent test in D-pre's UNREVIEWED refusal instead of the arm the
# test meant to exercise.
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
    print("pi ${PI_VERSION}")
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
out_path = None
write_out = None
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
    elif a in ("-o", "--output"):
        out_path = args[i + 1]; i += 1
    elif a in ("-w", "--write-out"):
        write_out = args[i + 1]; i += 1
    elif a.startswith("http://") or a.startswith("https://"):
        url = a
    i += 1

def respond(body_text, status="200"):
    # Real-curl semantics: -o sinks the body, -w appends the write-out string
    # to stdout (only %{http_code} is interpolated — all the script asks for).
    if out_path is not None:
        with open(out_path, "w") as f:
            f.write(body_text)
    if write_out is not None:
        sys.stdout.write(write_out.replace("%{http_code}", status))
    else:
        print(body_text)

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
        if write_out is not None:
            sys.stdout.write(write_out.replace("%{http_code}", "000"))
        print(json.dumps({"error": {"message": f"provider refused {model}"}}), file=sys.stderr)
        sys.exit(1)
    msg = {}
    if entry.get("content") is not None:
        msg["content"] = entry["content"]
    if entry.get("reasoning") is not None:
        msg["reasoning"] = entry["reasoning"]
    if not msg:
        msg["content"] = None  # both-null: C must fail on content, not crash
    # Mirror the real provider shape for gate D: usage.cost.total on the chat
    # response (sourced from the same costTotal / costTotalRaw knobs the old
    # fake-pi served — D's instrument is the provider-computed cost).
    pi = cfg.get("pi", {})
    raw = pi.get("costTotalRaw")
    code = str(cfg.get("chatHttpCode", 200))
    if raw is not None:
        # round 6: hand-built JSON so bare Infinity reaches the parser verbatim
        respond('{"choices": [{"message": ' + json.dumps(msg) + '}], "usage": {"cost": {"total": ' + str(raw) + '}}}', code)
        sys.exit(0)
    total = pi.get("costTotal")
    resp = {"choices": [{"message": msg}]}
    if total is not None:
        resp["usage"] = {"cost": {"total": total}}
    respond(json.dumps(resp), code)
    sys.exit(0)

if url.endswith("/api/v1/key"):
    if cfg.get("keyRawBody") is not None:
        respond(cfg["keyRawBody"])
    elif cfg.get("keyBody") is not None:
        respond(json.dumps(cfg["keyBody"]))
    else:
        key = cfg.get("key", {})
        respond(json.dumps({"data": {"limit": key.get("limit"), "usage": key.get("usage", 0)}}))
    sys.exit(0)

if write_out is not None:
    sys.stdout.write(write_out.replace("%{http_code}", "000"))
print(f"fake curl: unhandled url {url}", file=sys.stderr)
sys.exit(22)
`;

/**
 * One `new` the control plane PARSED (DF2.10 AC3).
 *
 * `calls` records argv the seam SAW; this records what the anchored matcher
 * MADE OF IT. The difference is the point: an argv-substring assertion over
 * `calls` still passes when the matcher missed and the create fell through to
 * exit 64, so the flag would read as "threaded" while the substrate refused it.
 */
export interface FakeCreate {
  name: string;
  tag?: string;
  image: string;
  registryAuth?: string;
}

/** A recorded argv the fake can assert on from tests (e.g. "no command ran"). */
export interface FakeExeDev {
  readonly root: string;
  /** The command-seam implementation handed to ExeDevDriver. */
  readonly run: FakeCommand;
  /** Every argv the seam saw, in order. */
  readonly calls: string[][];
  /** Every `new` the control-plane matcher accepted, parsed, in order. */
  readonly creates: FakeCreate[];
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
   * The create-time steering-channel provisioning FAILS (exit 1, the shape of
   * a sudo-less substrate): create must refuse with the typed
   * steering-channel-unprovisionable error, the VM left listable (INV-5).
   */
  steeringProvisionFails?: boolean;
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
  const creates: FakeCreate[] = [];

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
    // `detached` makes the child its own process-group leader (pgid === pid) —
    // the same posture FakeDriver.exec gives its exec children — so the
    // deadline below can kill the WHOLE exec tree instead of one pid.
    const proc = Bun.spawn({
      cmd: argv,
      cwd: box.dir,
      env,
      detached: true,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Bun.spawn's own `timeout` option signals only the DIRECT child. A
    // grandchild that inherits stdout/stderr (a backgrounded daemon, a script
    // without a redirect) keeps the pipes open after the leader dies, and the
    // raw `new Response(...).text()` reads below never settle — every later
    // exec on the box then queues behind a seam that never returns. The deadline
    // is ours, and it takes the group: `kill(-pid)` with a bare-`kill` fallback
    // for a group that is already gone (or a Windows host, where it is unsupported).
    const deadline =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {
              try {
                proc.kill(9);
              } catch {
                // already gone
              }
            }
          }, Math.max(1, timeoutMs));
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  const run: FakeCommand = async (argv, callOpts) => { /* dp:ok a rejection here is the test failing — there is nothing to recover */
    calls.push(argv);
    const timeoutMs = callOpts?.timeoutMs;
    const [cmd, target, ...rest] = argv;

    if (cmd === "ssh" && target === "exe.dev") {
      const sub = rest.join(" ");
      // `new --name <id> [--tag <tag>] --image <ref> [--registry-auth <cred>] --json`
      //
      // Still fully ANCHORED (^…$), and deliberately so: the anchoring is the
      // instrument that catches argv drift. A create whose flags moved, gained
      // a sibling, or lost `--image` MISSES here and lands on exit 64 below —
      // loudly — where a non-anchored `/^new /` would swallow the drift and
      // report a healthy box built from an argv nobody asserted (DF2.10 AC3).
      let m = /^new --name (\S+)( --tag (\S+))? --image (\S+)( --registry-auth (\S+))? --json$/.exec(sub);
      if (m) {
        const name = m[1] as string;
        creates.push({
          name,
          ...(m[3] === undefined ? {} : { tag: m[3] }),
          image: m[4] as string,
          ...(m[6] === undefined ? {} : { registryAuth: m[6] }),
        });
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
      // The create-time steering-channel provisioning, SIMULATED — never
      // executed. Its real form would sudo against the HOST /run, which no
      // unit test may do; the driver's create contract needs only the exit
      // status (success, or the sudo-less failure shape) and the call's
      // existence in `calls`, both of which this provides. The success arm
      // MATERIALIZES what it stands for — a 0700 steering root inside the
      // fake box, at the path the SCRIPT's own resolution picks — so a test
      // can assert the script's RESULT (the channel exists, mode 700) and not
      // merely the script's text. The LIVE proof that the real script lands a
      // writable /run/steering is T1.8's.
      if (
        command.includes('root="${QDS_STEERING_ROOT:-/run/steering}"') &&
        command.includes("sudo -n install -d -m 700")
      ) {
        if (opts.steeringProvisionFails) {
          return { stdout: "", stderr: "sudo: a password is required\n", exitCode: 1 };
        }
        // The script's own resolution order — `root="${QDS_STEERING_ROOT:-/run/steering}"`:
        // the env override first, the /run/steering default second. Honoring it
        // here is what makes the driver's script text and the fake's outcome
        // testable against each other: a driver root resolution that drifted
        // from the script's would provision one path while a consumer addressed
        // another, and only an env-honoring fake can see that at the unit layer.
        // A box-absolute root maps INTO the box dir (the fake's only filesystem
        // is `box.dir`) — the same convention the default arm has always used
        // for /run/steering.
        const override = process.env.QDS_STEERING_ROOT?.trim();
        const rootInBox =
          override !== undefined && override !== "" ? override.replace(/^\/+/, "") : join("run", "steering");
        const root = join(box.dir, rootInBox);
        // `install -d -m 700 -o "$(id -u)" -g "$(id -g)"`: create if absent AND
        // re-apply mode to a directory that already exists (mkdirSync's
        // recursive arm does not). The fake's exec user is the test runner
        // itself, so the ownership half holds by construction.
        try {
          mkdirSync(root, { recursive: true, mode: 0o700 });
          chmodSync(root, 0o700);
          // The script's verify chain, run for real rather than waved through:
          // writable by the exec user, and 700 as the mode argument promised.
          accessSync(root, constants.W_OK);
          if ((statSync(root).mode & 0o777) !== 0o700) return { stdout: "", stderr: "", exitCode: 1 };
        } catch {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // Fail closed on a sudo-bearing STEERING command that matched no
      // simulated handler: a provision-script literal edited past the
      // interceptor above must land here as a named fake error that turns the
      // test red at the seam — never fall through to `sh -c`, which would
      // execute a sudo line against the HOST this test runner runs on. Scoped
      // to the channel (every spelling of the script names it: the
      // QDS_STEERING_ROOT var, the /run/steering default) rather than to the
      // bare word, which used to replace ANY handler whose command merely
      // mentioned "sudo" with this refusal.
      if (/\bsudo\b/.test(command) && /steering/i.test(command)) {
        return {
          stdout: "",
          stderr: `fake exe.dev: sudo-bearing command matched no simulated handler (provision-script drift?): ${command.slice(0, 200)}\n`,
          exitCode: 64,
        };
      }
      // `/etc/qds-image.json` — the baked image marker gate B judges (DF2.10
      // AC1c). Served from config, never from a real file: the box's only
      // filesystem is `box.dir`, so the `sh -c` fallthrough below would probe
      // the HOST's own /etc — absent on every dev machine and every CI runner,
      // which reads as "the marker is missing" for a reason that has nothing
      // to do with the box. `readBoxFile` (transport.ts) issues exactly two
      // commands against it, `test -f <path>` then `cat <path>`, each
      // shellQuote'd twice on the way here (once by readBoxFile, once by
      // driver.exec) — so this matches on the PATH plus the verb rather than
      // on a quoting spelling that is not the contract.
      if (command.includes(IMAGE_MARKER_PATH)) {
        const cfg = readConfig(name);
        // `=== undefined` and not `??`: `null` is the FILE ABSENT case and must
        // not fall back to the well-formed default.
        const marker = cfg.imageMarker === undefined ? DEFAULT_IMAGE_MARKER : cfg.imageMarker;
        // REAL failure shapes, so a test asserting on the note reads what an
        // operator would read: `test -f` misses SILENTLY (exit 1, empty
        // stderr); a SIGKILLed process (137, the exec budget) writes NOTHING —
        // "Killed" is an interactive shell's job control on a terminal, which
        // an ssh exec channel does not have; only ssh itself (255) speaks on
        // the way down. A `cat` refused mid-boot says "Permission denied"
        // (the root-only-0600-marker simulation these knobs exist for).
        const sshStderr = (exitCode: number): string =>
          exitCode === 255 ? "ssh: connect to host closed by remote host\n" : "";
        if (/\btest -f\b/.test(command)) {
          const exitCode = cfg.imageMarkerProbeExit ?? (marker === null ? 1 : 0);
          return { stdout: "", stderr: exitCode === 0 ? "" : sshStderr(exitCode), exitCode };
        }
        if (/\bcat\b/.test(command)) {
          const exitCode = cfg.imageMarkerCatExit ?? (marker === null ? 1 : 0);
          if (exitCode !== 0) {
            return {
              stdout: "",
              stderr:
                cfg.imageMarkerCatExit === undefined
                  ? `cat: ${IMAGE_MARKER_PATH}: No such file or directory\n`
                  : exitCode === 255 || exitCode === 137
                    ? sshStderr(exitCode)
                    : `cat: ${IMAGE_MARKER_PATH}: Permission denied\n`,
              exitCode,
            };
          }
          // A capped capture is a PREFIX — serve one, byte-for-byte what a
          // real capped read yields (unparseable), so an implementation that
          // treated `truncated` as advisory and tried to parse could never
          // pass against a whole document the flag calls cut short.
          if (cfg.imageMarkerTruncated) {
            const whole = marker ?? "";
            return {
              stdout: whole.slice(0, Math.floor(whole.length / 2)),
              stderr: "",
              exitCode: 0,
              truncated: true,
            };
          }
          return { stdout: marker ?? "", stderr: "", exitCode: 0 };
        }
        // NEVER fall through. The box's only filesystem is `box.dir`, so
        // `spawnLocal` would run this verb against the HOST's real /etc — and a
        // dev machine that happens to carry its own /etc/qds-image.json would
        // serve FOREIGN content to a gate whose whole job is judging what THIS
        // box booted. A third verb on this path is a driver change the fake has
        // not been taught — THROWN as a host-side test error rather than
        // returned as a well-formed non-zero exit, which the gate's normal
        // failure classification would absorb into just another marker refusal
        // a coarse `ready === false` assertion stays green on. (The gate's B0
        // catch still converts the rejection to a payload, but the payload's
        // message then names this seam verbatim.)
        throw new Error(
          `fake exe.dev: ${IMAGE_MARKER_PATH} touched by an unsimulated verb (readBoxFile drift?) — the fake serves this path from config and must never read the host's /etc: ${command.slice(0, 200)}`,
        );
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
    creates,
    configure,
    boxDir: (name) => ensureBox(name).dir,
    homeDir: (name) => ensureBox(name).home,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A posture file whose INV-IBOX-3 deviation is RATIFIED — AC4's private arm.
 *
 * Separate from {@link writePostureAttestation} on purpose: the plain
 * attestation is what `setPublic` reads, and adding a ratification to it would
 * make every `setPublic` test silently consent to the private-registry
 * deviation as well. A test that wants the deviation asks for it by name.
 */
export function writeRatifiedRegistryDeviation(dir: string): string {
  const path = join(dir, "exedev-posture-ratified.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        vmSharing: "admins-only",
        attestedAt: "2026-08-15T00:00:00.000Z",
        registryAuthDeviation: {
          scope: "read:packages",
          // Far future on purpose: `assertRegistryAuthDeviation` refuses a
          // LAPSED ratification, so a near-dated fixture would turn this suite
          // red on a calendar date rather than on a code change.
          expiry: "2099-01-01T00:00:00.000Z",
          rotationOwner: "platform-oncall",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
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
