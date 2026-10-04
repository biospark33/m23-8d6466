/**
 * Regression test for the EMBEDDINGS_FLAG branch in
 * `scripts/install-gitnexus-plus.sh` (PR #90, issue #74).
 *
 * `--embeddings` aborts the whole `gitnexus analyze` on macOS Intel because
 * onnxruntime-node ships no darwin/x64 native binding. The script drops the
 * flag there (BM25-only index beats no reindex path at all). That branch is
 * the entire point of the PR — and it had no coverage. A silent regression
 * (wrong uname test, quoted `"$EMBEDDINGS_FLAG"` that passes `""` as a literal
 * analyze arg, or an array form that breaks stock macOS bash 3.2 under `set -u`)
 * would only surface as the #74 hang coming back.
 *
 * So we drive the REAL script end-to-end with stubbed `uname` + `gitnexus` +
 * `timeout` on PATH and capture the argv the analyze invocation received. The
 * three cases pin the matrix: darwin/x64 drops the flag; darwin/arm64 and
 * linux/x86_64 keep it. Running the unmodified script (not a re-impl) means an
 * edit to the real branch logic is what flips these green/red.
 *
 * The empty-string case is load-bearing: `EMBEDDINGS_FLAG=""` MUST vanish from
 * argv (zero args), not arrive as an empty-string positional. We assert the
 * analyze argv contains no empty element — that is the Bash 3.2-safe behavior
 * the script's string-not-array comment exists to preserve.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/install-gitnexus-plus.sh");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gn-embed-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// A throwaway git repo so the script's `git rev-parse --show-toplevel` resolves
// to a temp root — the transient `.gitnexusignore` / `.claude/skills/gitnexus-*`
// it writes and cleans up never touch the real working tree.
const repoDir = path.join(tmpRoot, "repo");
fs.mkdirSync(repoDir, { recursive: true });
child_process.spawnSync("git", ["init", "-q"], { cwd: repoDir });
// analyze runs against $REPO_ROOT; the gitnexus shim ignores the path, but git
// needs at least one commit-free HEAD that `rev-parse` is happy with — `init`
// alone is enough, the script never commits.
fs.writeFileSync(path.join(repoDir, ".gitkeep"), "");

// --- PATH shims -------------------------------------------------------------
// Every shim is a tiny bash script. They never reach the network or a real
// gitnexus install: GITNEXUS_SKIP_INSTALL=1 short-circuits the pi branch, and
// the gitnexus/timeout shims replace the binaries the analyze path invokes.
const shimDir = path.join(tmpRoot, "shims");
fs.mkdirSync(shimDir, { recursive: true });

// `uname -s` / `uname -m` are driven by env, so one matrix of tests can fake
// any (kernel, machine) pair on any host.
fs.writeFileSync(
  path.join(shimDir, "uname"),
  `#!/usr/bin/env bash
case "\${1:-}" in
  -s) printf '%s\\n' "\${UNAME_S:-Darwin}";;
  -m) printf '%s\\n' "\${UNAME_M:-arm64}";;
  *)  printf '%s\\n' "$(uname)";;
esac
`,
);

// gitnexus shim: record every invocation's argv to a call log, exit 0. One
// record per invocation. Each arg on its own line so an EMPTY positional is
// preserved (the whole point of the empty-flag test) — `"$*"` would flatten
// `""` into whitespace and hide the regression we're pinning.
const SEP = "===GN_INVOCATION===";
fs.writeFileSync(
  path.join(shimDir, "gitnexus"),
  `#!/usr/bin/env bash
{
  printf '%s\\n' "${SEP}"
  printf 'argc=%d\\n' "$#"
  i=1
  for a in "$@"; do printf 'arg[%d]=%s\\n' "$i" "$a"; i=$((i+1)); done
} >> "$GITNEXUS_CALL_LOG"
exit 0
`,
);

// timeout/gtimeout shim: GNU `timeout`'s own args (`--kill-after=N`, the
// duration) precede the command. Strip them, exec the rest verbatim so the
// gitnexus shim receives the real analyze argv untouched.
const TIMEOUT_SHIM = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    --kill-after=*) shift;;
    [0-9]*) shift;;
    *) break;;
  esac
done
exec "$@"
`;
fs.writeFileSync(path.join(shimDir, "timeout"), TIMEOUT_SHIM);
fs.writeFileSync(path.join(shimDir, "gtimeout"), TIMEOUT_SHIM);

// `sysctl -n hw.optional.arm64` is the MACHINE-arch fact the guard consults alongside
// `uname -m`, added 2026-09-08 after the guard was found firing on Apple Silicon: a
// Rosetta'd x86_64 bash makes `uname -m` answer x86_64 while the machine is arm64, which
// silently degraded every index this repo had ever built to BM25-only.
//
// It MUST be shimmed. Without it these tests read the real host's sysctl, so the whole
// matrix depended on whichever machine happened to run it — on Apple Silicon the
// darwin/x64 case saw the true `1` and (correctly) kept `--embeddings`, and the test that
// still asserted the pre-fix behaviour failed. That is exactly what happened: this file
// went red on the fix commit and stayed red, because a stub that only controls half the
// inputs is not a stub.
fs.writeFileSync(
  path.join(shimDir, "sysctl"),
  `#!/usr/bin/env bash
# Only the machine-arch query is faked; anything else exits non-zero like a
# missing key, which is what the script's \`|| echo 0\` fallback expects.
if [ "\${1:-}" = "-n" ] && [ "\${2:-}" = "hw.optional.arm64" ]; then
  if [ "\${SYSCTL_ARM64:-}" = "1" ]; then printf '1\\n'; exit 0; fi
  exit 1
fi
exit 1
`,
);

for (const s of ["uname", "gitnexus", "timeout", "gtimeout", "sysctl"]) {
  fs.chmodSync(path.join(shimDir, s), 0o755);
}

/**
 * Run install-gitnexus-plus.sh for a given fake (uname -s, uname -m) and return
 * the argv array the analyze invocation received. Throws if the script exited
 * non-zero (the real failure mode is a `set -u` abort or the wrong branch).
 */
function analyzeArgsFor(unameS: string, unameM: string, machineIsArm64 = false): string[] {
  const callLog = path.join(tmpRoot, `calls-${unameS}-${unameM}-${machineIsArm64 ? "m1" : "m0"}.log`);
  fs.writeFileSync(callLog, "");

  const proc = child_process.spawnSync("bash", [SCRIPT], {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      // Prepend shim dir so uname/gitnexus/timeout resolve to our stubs, not
      // the host's. Keep the rest of PATH so `git`, `perl`, `command -v` work.
      PATH: `${shimDir}:${process.env.PATH}`,
      GITNEXUS_SKIP_INSTALL: "1",
      UNAME_S: unameS,
      UNAME_M: unameM,
      SYSCTL_ARM64: machineIsArm64 ? "1" : "0",
      GITNEXUS_CALL_LOG: callLog,
    },
  });

  if (proc.status !== 0) {
    throw new Error(
      `script exited ${proc.status} for uname ${unameS}/${unameM}\n` +
        `stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }

  // Split the call log into per-invocation records, parse each into its arg
  // array, and pick the record whose first arg is `analyze` (the other record
  // is `status`). argc and per-arg lines preserve empty positionals exactly.
  const log = fs.readFileSync(callLog, "utf8");
  const records = log.split(`${SEP}\n`).map((r) => r.trim()).filter(Boolean);
  for (const rec of records) {
    const argLines = rec.split("\n").filter((l) => l.startsWith("arg["));
    const args = argLines.map((l) => l.replace(/^arg\[\d+\]=/, ""));
    if (args[0] === "analyze") return args;
  }
  throw new Error(
    `no analyze invocation recorded for ${unameS}/${unameM}; log:\n${log}`,
  );
}

describe("install-gitnexus-plus.sh — EMBEDDINGS_FLAG branch (#74, PR #90)", () => {
  test("Darwin x86_64 on a GENUINE Intel Mac runs analyze WITHOUT --embeddings", () => {
    // Both facts agree the machine is Intel: uname says x86_64 AND hw.optional.arm64
    // is absent. This is the only shape the guard is meant to fire on.
    const args = analyzeArgsFor("Darwin", "x86_64", false);
    expect(args).not.toContain("--embeddings");
  });

  test("Darwin x86_64 under ROSETTA on Apple Silicon KEEPS --embeddings", () => {
    // The regression the guard was rewritten for (2026-09-08). An x86_64 bash earlier
    // on PATH — a /usr/local Homebrew bash on an M-series Mac, the common case — makes
    // `uname -m` answer x86_64 while the machine is arm64 and onnxruntime is arm64
    // native. The pre-fix guard read only `uname -m`, fired here, and silently degraded
    // EVERY index this repo had ever built to BM25-only, whose own warning says
    // "gitnexus_query may miss symbol-name-only hits."
    //
    // This case had NO coverage, which is why the defect survived: the matrix pinned
    // three (kernel, process-arch) pairs and the machine-arch fact was not an input at
    // all. A stub controlling half the guard's inputs cannot fail on the half it omits.
    const args = analyzeArgsFor("Darwin", "x86_64", true);
    expect(args).toContain("--embeddings");
  });

  test("Darwin x86_64 emits NO empty-string positional (Bash 3.2-safe expansion)", () => {
    // The whole reason EMBEDDINGS_FLAG is a plain string, not an array: an
    // empty value must vanish to zero args. If it ever arrived as "" the
    // gitnexus CLI would get a bogus empty positional and (best case) error.
    const args = analyzeArgsFor("Darwin", "x86_64", false);
    expect(args).not.toContain("");
  });

  test("Darwin arm64 includes --embeddings", () => {
    const args = analyzeArgsFor("Darwin", "arm64", true);
    expect(args).toContain("--embeddings");
  });

  test("Linux x86_64 includes --embeddings", () => {
    // No sysctl key on Linux: the shim exits non-zero and the script's `|| echo 0`
    // fallback supplies the value, so the Darwin arm of the guard never applies.
    const args = analyzeArgsFor("Linux", "x86_64", false);
    expect(args).toContain("--embeddings");
  });

  test("every path still passes --force and --skip-agents-md", () => {
    // Guards against a refactor that drops a sibling flag while wiring the
    // conditional — the embeddings branch must not silently eat its neighbors.
    for (const [s, m] of [
      ["Darwin", "x86_64"],
      ["Darwin", "arm64"],
      ["Linux", "x86_64"],
    ] as const) {
      const args = analyzeArgsFor(s, m);
      expect(args).toContain("--force");
      expect(args).toContain("--skip-agents-md");
    }
    // Real git remote round-trips (or script spawns) can outrun bun's 5s
    // default under parallel-suite load — same load-flake family the fleet
    // race tests document; deterministic solo.
  }, 20_000);
});
