# R4 — DF3.4 Steering Channel + Driver Port (READ-ONLY research)

Branch: `feature/df3-4-approval-gate-attach-steering`. Sources read in full:
`src/phase-engine/steering.ts` (450 L), `src/fleet/resident.ts` (639 L),
`src/providers/driver.ts` (1397 L, primitives block read),
`src/providers/fake-driver.ts`, `src/providers/exedev/driver.ts`,
`scripts/pipeline-run.ts` (solicitation wiring), `scripts/pipeline-run-remote.ts`,
`src/reverify/report.ts`, `src/pr/push.ts`, both story specs.

---

## 0. HEADLINE FINDINGS (read these first)

1. **`exec` DOES accept stdin.** `exec(vm, argv, stdin?)` — third positional,
   `string | undefined`. Not a blocker. Both drivers honor it faithfully.
2. **BLOCKER-A — `copyFile` refuses ABSOLUTE paths on BOTH drivers.** The story's
   literal `driver.copyFile(vm, "/run/steering/acks.ndjson", …)` cannot work.
   ExeDev's `assertBoxPathSafe` requires `!p.startsWith("/")`; FakeDriver's
   `resolve(box, "/run/…")` yields an absolute path that fails its
   escapes-the-box check. DF3.4 must use a **box-relative** ack path.
3. **BLOCKER-B (architectural) — the engine and the resident run on the HOST,
   not in the box.** `scripts/pipeline-run-remote.ts:6-12`: "the box image
   carries no bun/node, so `scripts/pipeline-run.ts` cannot run in-box." The
   resident is `Bun.spawn`'d locally (`src/fleet/resident.ts:446-471`). So the
   *drain* at the three solicitation points is NOT a local `fs.readFile` of
   `/run/steering/inbox.ndjson` — it must cross the driver port too, and
   `steering.ts` holds **no driver reference and may not import fleet code**
   (module boundary, steering.ts:12-13). The drain must arrive as an **injected
   port on `createSteering(deps)`** — a new optional dep. This is the single
   biggest design decision DF3.4 must make; the story assumes an in-box engine
   that does not exist.
4. **No `observe` method on `ProviderDriver`** — confirmed. `observeRun` is a
   host-side free function composing `driver.copyFile` (driver.ts:1002-1009).
5. **`/run/steering/` does not exist anywhere in the repo.** Zero hits for
   `/run/steering`, `inbox.ndjson`, `acks.ndjson` outside the story markdown.
   DF3.4 creates it. Precedent for the root: `runMarkerRoot()`
   (`src/phase-engine/journal.ts:38-40`) — `/run` with a `QDS_RUN_ROOT` override
   because `/run` is root-owned on Linux CI and absent on darwin.
6. **The 4_000-char attach bound already exists and is DF3.3-owned, not
   DF3.6-owned.** `DIRECTIVE_TEXT_CHAR_CEILING = 4_000` (steering.ts:33,
   exported). DF3.6 defines only `maxSteeringIterations` / `residentRssBytes` /
   `residentSpendCeilingMicros` — no char bound anywhere in its spec. DF3.4
   should import the DF3.3 constant; the story's "DF3.6's bound" is a
   misattribution.

---

## 1. The solicitation port and the THREE solicitation points

### 1a. The port interfaces (`src/phase-engine/steering.ts`)

```ts
// :94-98
export interface ResidentCaller {
  /** One synchronous solicitation. Returns raw reply text + token usage.
   *  Throws on timeout / unreachable / process death. */
  call(prompt: string): Promise<{ raw: string; usage: { inputTokens: number; outputTokens: number } }>;
}

// :100-107
export interface SolicitCtx {
  runId: string;
  requestId?: string;
  phase?: string;                        // undefined at run_start
  rosterIds?: readonly string[];
  phaseIds?: readonly string[];
  promptContext: string[];               // mutable — DF3.4 will push drained inbox lines pre-render
}

// :138-154
export interface SteeringController {
  readonly telemetry: ResidentTelemetry;
  readonly lastDegradationReason: string | null;
  /** Never throws. Degraded/disabled → resolves { action: "proceed" } */
  solicit(point: SteeringPoint, ctx: SolicitCtx): Promise<SteeringDirective>;
}

// :38
export type SteeringPoint = "run_start" | "post_gate_failure" | "run_end";
```

`SolicitCtx.promptContext` is **explicitly reserved for DF3.4** by DF3.3's own
comment (`steering.ts:106`). The construction site is
`createSteering(deps: { caller, rate, onTripwire? })` at `steering.ts:259-263`.

**Blast radius (GitNexus `impact createSteering upstream`): risk LOW,
impactedCount 3, 1 direct caller** — `scripts/pipeline-run.ts` (`main`).
`SolicitCtx` importers: `scripts/pipeline-run.ts`, `src/phase-engine/journal.ts`,
`src/phase-engine/index.ts` (barrel), `src/fleet/resident.ts`,
`tests/phase-engine/steering.test.ts`. (Index is slightly stale — it reports
`SolicitCtx` at :64; the real line is :100. Line numbers here are from the file.)

### 1b. The three points — WHERE THEY ARE CALLED

The `solicit()` implementation is one function (`solicitSerialized`,
`steering.ts:335-432`); the **three points** are three call sites in
`scripts/pipeline-run.ts`, all through the wrapper
`solicitResident(steering, point, ctx, model)` at `scripts/pipeline-run.ts:774-848`.

| # | Point | Call site | Ctx shape |
|---|-------|-----------|-----------|
| 1 | `run_start` | `scripts/pipeline-run.ts:1799-1805` | `{ runId, requestId, rosterIds, phaseIds, promptContext: residentPromptContext }` |
| 2 | `post_gate_failure` | `scripts/pipeline-run.ts:971-980` | `{ runId, requestId, phase: spec.name, phaseIds, promptContext: resident.promptContext }` — `rosterIds` deliberately absent |
| 3 | `run_end` | `scripts/pipeline-run.ts:1925-1933` | `{ runId, requestId, phase: last outcome name, phaseIds, promptContext }` — `rosterIds` absent |

Point 1 construction of the controller: `scripts/pipeline-run.ts:1708-1725`.

### 1c. The KNOWN DF3.3 CEILING — point 2 is code-phase-only

Point 2 sits inside `makeBodyFactory`'s **code-phase** gated retry loop
(`scripts/pipeline-run.ts:955-1048`), reached from the `catch (err)` on
`GateFailureError` after the retry is authorized. Its own comment at
`:957-967` records the seam:

> "DF1.3 authorized attempt N+1 (the branch at
> `src/phase-engine/agents/retry.ts:284-287`, re-spelled here for code
> phases). KNOWN DRIFT from DF1.3, deliberate and fail-closed…"

**Agent phases retry through `src/phase-engine/agents/retry.ts:284-287` and
never solicit.** So an attach message queued while an *agent* phase is looping
is not drained until the run reaches `run_end` (or a later code phase's gate
failure). DF3.4 must NOT "fix" this by adding a drain in retry.ts — that is a
fourth point and breaks INV-APPROVE-5 / DF3.3's containment argument. It is a
documented latency ceiling to restate, not to close.

### 1d. WHERE the drained message is folded into the prompt

Exact fold site — DF3.3 left a labelled seam, `steering.ts:339-342`:

```ts
    if (telemetry.status !== "active") return PROCEED;
    // SEAM DF3.6: checkBounds(point) wraps here — spend/iteration/RSS bounds
    // gate before any prompt is rendered.
    // SEAM DF3.4: drain the resident inbox into ctx.promptContext here,
    // pre-render (the ctx field is mutable for exactly this slot).
    let prompt: string;
    try {
      prompt = renderPrompt(point, ctx);
```

`renderPrompt` (`steering.ts:197-205`) joins `ctx.promptContext` with `\n` and
tail-truncates head-first — **newest-last is the invariant** (`steering.ts:170-176`),
so a drained line MUST be `push`ed (appended), never `unshift`ed, or it becomes
the first thing dropped at the 16 000-char ceiling.

The guidance-text shape to mirror is the accepted-retry push at
`scripts/pipeline-run.ts:1016-1018`:

```ts
resident.promptContext.push(
  `resident guidance for ${spec.name} (attempt ${attempt + 1}): ${sanitizeForMessage(directive.guidance)}`,
);
```

`sanitizeForMessage` is mandatory: an attach `message` is unsanitized operator
free text and a newline in it would forge instruction lines in the prompt.

### 1e. WHERE the ack is appended

Second labelled seam, `steering.ts:429-430`, immediately before the accepted
directive returns:

```ts
      // SEAM DF3.4: ack the reply into the inbox record here.
      return directive;
```

**Ambiguity to flag:** this seam is on the ACCEPTED path only. Every early
return — degraded (`:338`), render failure (`:354`), call failure (`:369`),
malformed limit (`:386`), schema rejection (`:393`), allowlist/roster rejection
(`:401`/`:410`/`:419`) — returns `PROCEED` **without** reaching it. A message
that was drained and folded into the prompt at a solicitation whose reply was
then rejected would be consumed with no ack, and `fleet attach` would report
`attach-not-acked` for a message that DID land. Recommendation: append the ack
where the message is **drained + folded** (the 1d seam) or in a `finally`, not
at 1e — the ack means "this message reached a solicitation's prompt context",
not "the directive was accepted". This is an ADD-ONLY change either way and
touches no DF3.3-owned line, but the story's wording points at 1e.

---

## 2. The closed `.strict()` directive union + INV-APPROVE-5 enforcement

Verbatim, `steering.ts:47-74`:

```ts
export const SteeringDirectiveSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("proceed"), note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional() })
    .strict(),
  z
    .object({
      action: z.literal("retry"),
      guidance: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("select_roster"),
      phase: z.string().max(DIRECTIVE_ID_CHAR_CEILING),
      rosterId: z.string().max(DIRECTIVE_ID_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("abort"),
      reason: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
]);
```

Four actions. **No `approve`, no `skip`, no `reorder`, no ceiling field** — the
privilege INV-APPROVE-5 forbids is not expressible in the union at all.

### Where the containment is enforced TODAY

1. **Direction.** The union is the schema for the **resident's reply**, parsed
   from `deps.caller.call(prompt)` output at `steering.ts:361/375/390`. Prompt
   context is INPUT; a directive is OUTPUT. They are different data paths — an
   attach line entering `promptContext` is text the model reads, never a value
   the parser reads. `parseReply` (`:231-241`) only ever sees `reply.raw`.
2. **Closed-ness is member-level `.strict()`** — an unknown action is
   `invalid_union_discriminator`, an unknown field on a known action is
   `unrecognized_keys`; both are a **rejection**, never a warning
   (`steering.ts:40-46`). Rejection = `reject()` at `:303-321`: one
   `directivesRejected` increment, one `gate_bypass_attempt` tripwire row, and
   `PROCEED` returned. Never an applied effect.
3. **Per-point allowlist** (`POINT_ALLOWLIST`, `:87-91`) — a schema-valid action
   with nothing to steer at that point is also a rejection (`:400-402`).
4. **Fail-closed closed-set validation** for `select_roster`: absent `rosterIds`
   / `phaseIds` read as EMPTY sets, so every pick is rejected (`:406-420`), plus
   a second wiring-layer recheck at `scripts/pipeline-run.ts:1816-1835`.
5. **Approval never travels this path at all.** `fleet approve`/`reject` are
   host-side CLI over `.factory/approvers.json` and `RunRecord.extensions.approval`;
   nothing in `steering.ts` or `pipeline-run.ts` can write an approval extension.

### What DF3.4 MUST ADD so a steering message cannot become a directive

- **Never parse a drained inbox line as a directive.** The drained value goes
  into `ctx.promptContext` as a `string` and nowhere else. No code path may pass
  it to `SteeringDirectiveSchema.safeParse` or to `parseReply`.
- **Prefix + sanitize every folded line**, e.g.
  `` `operator attach ${messageId}: ${sanitizeForMessage(message)}` `` — the
  prefix is what makes prompt-injected JSON legible as quoted operator text, and
  `sanitizeForMessage` (`src/phase-engine/types.ts`) strips the newlines that
  would otherwise forge a fresh instruction line inside the rendered prompt.
- **Bound the message at ingress** to `DIRECTIVE_TEXT_CHAR_CEILING` (4 000,
  imported, not re-declared) — `promptContext` is cumulative and rides every
  later solicitation for the run's lifetime (that is DF3.3's stated reason for
  the constant, `steering.ts:29-33`).
- **Cap the per-drain count.** A queued inbox with N lines folded into one
  prompt is an unbounded prompt-growth vector; the 16 000-char ceiling truncates
  from the HEAD, so an attach flood silently evicts the run's own context lines.
  Bound lines-per-drain and total attach chars per run.
- **Dedupe on `messageId`** so a re-issued message delivers once (AC6).
- No new directive union member, no widening of `ResidentTripwire.cause`
  (DF3.3 froze it to `"gate_bypass_attempt"`, `steering.ts:111-119`).

---

## 3. The DF2.1 DRIVER PORT — verbatim

`src/providers/driver.ts:174-200`:

```ts
export interface ProviderDriver {
  /** Registry name, e.g. `"fake"`, `"exe"`. */
  readonly name: string;
  create(name: string, tag?: string): Promise<ProviderVm>;
  list(name?: string): Promise<ProviderVm[]>;
  listWithAnomalies?(name?: string): Promise<ProviderVmListing>;
  destroy(vm: string): Promise<void>;
  expose(vm: string, port: number): Promise<string>;
  setPublic(vm: string): Promise<void>;
  whoami(): Promise<string>;
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>;
  copyFile(vm: string, remotePath: string, localPath: string): Promise<void>;
}
```

```ts
// :126-130
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

- **`exec` takes stdin: YES.** Third positional parameter, `stdin?: string`.
- **Parameter order:** `(vm: string, argv: string[], stdin?: string)`.
- **`copyFile` order:** `(vm: string, remotePath: string, localPath: string)`,
  returns `Promise<void>` — **box → host only.** Interface doc, `:176-178`:
  "`copyFile` is **box → host only**. Nothing pushes a file into a box — that is
  why DF2.3's credential arrives on `exec` stdin."
- **`observe`: CONFIRMED ABSENT.** Ten members above; no `observe`. The verb
  exists only as a host-side composition, `driver.ts:1001-1009`:
  ```ts
  /** Lifecycle verb `observe` — pull an artifact back out of the box (box → host). */
  export function observeRun(driver, vm, remotePath, localPath): Promise<void> {
    return driver.copyFile(vm, remotePath, localPath);
  }
  ```
  The story's claim ("DF2.1's port defines no `observe` method, so host-side
  observation is a composition of those two verbs") is **verified correct**.
- **Termination contract** (`:162-172`): `exec` boundedness is per-driver.
  ExeDev enforces a transport timeout + SIGKILL. **FakeDriver's exec has NO
  ceiling of its own** — it stays pending until the process group exits or
  `destroy()` kills it. `fleet attach`'s 30 000 ms ack poll must therefore be
  bounded host-side by attach itself, not delegated to the driver.

---

## 4. The `fake` driver — live box, stdin fidelity, negative control

**File:** `src/providers/fake-driver.ts`. A box is a directory with a
`.box.json` metadata file; `exec` spawns a real child process with the box dir
as cwd; `copyFile` is a real `copyFileSync` (`fake-driver.ts:1-11`).

### Spinning up a live fake box in a test

```ts
const boxesDir = mkdtempSync(join(tmpdir(), "qds-fake-boxes-"));
const driver = new FakeDriver(boxesDir);        // or: resolveDriver("fake", { requestId, runId })
await driver.create(name);                       // name must match the run-id grammar
await driver.exec(name, ["sh", "-c", "…"], stdinString);
await driver.copyFile(name, "out/report.txt", localPath);   // BOX-RELATIVE
await driver.destroy(name);
```

- Constructor arg is the boxes root; `resolveDriver("fake")` reads
  `QDS_FAKE_BOXES_DIR` (`fake-driver.ts:28`, `tests/providers/fake-driver.test.ts:39-58`
  — save AND restore that env var, it leaks across suites).
- Box root is created lazily in `create()`, not the constructor
  (`tests/fleet/cli.test.ts:586-592`).
- Fleet-level fixture: `tests/fleet/cli.test.ts:539-551` (`deps()` returning
  `{ driver: new FakeDriver(boxesDir), keyApi, store, ledgerFactory, readBrief, repoRoot }`).

### Does its `exec` faithfully honor stdin? YES

`fake-driver.ts:346-393`:
```ts
  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("exec requires a non-empty argv");
    const cwd = this.boxDir(vm);
    this.readMeta(vm); // assert the box exists before spawning anything
    const proc = Bun.spawn({
      cmd: argv,
      cwd,
      env: process.env,
      detached: true,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
```
Raw UTF-8 bytes to the child's fd 0. Pinned by the shared contract suite,
`tests/providers/driver-contract.test.ts:135-142`:
```ts
    test("exec delivers stdin — the channel DF2.3's key arrives on", async () => {
      const res = await driver.exec(name, ["sh", "-c", "cat"], "secret-on-stdin\n");
      expect(res.stdout).toContain("secret-on-stdin");
```
So `["sh","-c","cat >> <path>"]` + stdin round-trips verbatim under the fake
driver, quotes/backticks/`$( )`/`;`/newlines included — `cat` parses nothing.

### The argv-assertion negative control — CORRECTED (round 2)

**FakeDriver itself records NOTHING.** Re-read `fake-driver.ts:346-393` in full:
`exec` spawns `Bun.spawn` directly and returns `{stdout, stderr, exitCode}`. There
is no call log, no history array, no argv/stdin capture anywhere in the class
(`grep -n "record\|calls\|history" src/providers/fake-driver.ts` → only `RunRecord`
imports and log lines about *listing*, never about exec). So the literal question
"does fake-driver's `exec` record argv and stdin separately" answers **no — it
records neither.**

The separation AC6 needs comes from the wrapper fixture
`tests/providers/fixtures/recording-driver.ts`, and it is **stronger than
separate**:

```ts
// :17-21
export interface RecordedExec {
  vm: string;
  argv: readonly string[];
  hadStdin: boolean;
}

// :55-59
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    this.execCalls.push({ vm, argv: [...argv], hadStdin: stdin !== undefined });
    return this.inner.exec(vm, argv, stdin);
  }
```

argv is captured as a **copied array** (`[...argv]` — immune to later caller
mutation); stdin is captured as a **boolean only**. Its header states the
intent verbatim (`:11-13`): "stdin presence is recorded as a boolean — the
content is deliberately never kept, so the fixture itself cannot leak a secret
into a test artifact."

That is exactly the AC6 negative control: wrap a live `FakeDriver` in
`RecordingDriver`, run the attach, then assert no `messageId` / `requestId` /
`message` substring appears in any `execCalls[i].argv` and that
`hadStdin === true` on the append call. The fixture's own header also names the
threat model it cannot cover (`:5-9`): it records what the CALLER passed, not
what an inner driver might rewrite before spawning — FakeDriver provably does
not rewrite, which is the documented contract being relied on. Reuse this
fixture; do not write a second recorder.

### `copyFile` path rule (BLOCKER-A, fake side)

`fake-driver.ts:396-407`:
```ts
  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    const box = realpathSync(this.boxDir(vm));
    const src = realpathSync(resolve(box, remotePath));
    const rel = relative(box, src);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`remote path escapes the box: ${remotePath}`);
    }
    copyFileSync(src, localPath);
  }
```
`resolve(box, "/run/steering/acks.ndjson")` → `/run/steering/acks.ndjson`
(absolute wins), which is outside `box` ⇒ **throws**. Under FakeDriver, "inside
the box" is the box **directory**, and `/run/...` is a host path.

---

## 5. The real exedev driver — signature parity

`src/providers/exedev/driver.ts:437-448`:
```ts
  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    assertValidRunId(vm);
    if (argv.length === 0 || argv.some((a) => a.length === 0 || a.trim().length === 0))
      throw new ExeDevDriverError("empty-argv", "exec requires a non-empty argv with no empty or whitespace-only elements", "pass the command argv");
    const command = argv.map(shQuote).join(" ");
    return this.run(["ssh", this.boxHost(vm), command], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: this.execTimeoutMs,
    });
  }
```
`copyFile`, `:482-495`:
```ts
  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    assertValidRunId(vm);
    assertBoxPathSafe(remotePath);
    const res = await this.run(["scp", "-q", `${this.boxHost(vm)}:${remotePath}`, localPath], {
      timeoutMs: this.execTimeoutMs,
    });
    if (res.exitCode !== 0) { throw new ExeDevDriverError("copy-file-failed", …); }
  }
```

**Signature parity: EXACT** for both methods across fake and exedev. Differences
that matter to DF3.4:

- exedev `exec` **rejects empty / whitespace-only argv elements**; fake only
  rejects an empty array. Keep the attach argv to non-empty tokens.
- exedev `exec` POSIX-quotes argv and ships it as ONE ssh remote command line —
  visible to `ps` on the box. Payload on **stdin only** is not optional hygiene;
  it is the only way the message stays off the remote command line.
- `execTimed(vm, argv, timeoutMs, stdin?)` (`:451-462`) exists as an exedev-only
  extra method (not on the interface) if attach ever needs a per-call budget.
- **BLOCKER-A, exedev side** — `assertBoxPathSafe`, `:604-614`:
  ```ts
  const wellFormed = /^[A-Za-z0-9._/-]+$/.test(p) && p.length > 0 && !p.startsWith("/");
  const noTraversal = p.split("/").every((segment) => segment !== ".." && segment !== "");
  ```
  A leading `/` is refused with code `remote-path-invalid`, remediation "pass a
  box-relative path like out/report.txt". `.ndjson` chars are all inside the
  allow-list, so only the leading slash is the problem.

**Resolution for BLOCKER-A — SUPERSEDED by a live measurement (round 2).**
This exact bug was already hit, in production, by DF2.x's fan-out race, and the
repo already carries the fix. `src/fleet/fanout-primitive.ts:688-696`:

```ts
    // MEASURED live 2026-08-26 (fan-20260826-f04c3c): read the marker through
    // the SAME exec channel the presence probe uses. copyFile is box-RELATIVE
    // by driver contract (ExeDevDriver's assertBoxPathSafe) while
    // runMarkerPath() is ABSOLUTE (/run/journal/final.json) — a copyFile read
    // died "remote-path-invalid" on every tick and the race spun to its
    // ceiling with the marker present and the winner never claimed. cat is
    // subject to the same shellQuote; no driver path-safety surface changes.
    const read = await withTimeout(
      deps.driver.exec(vm, ["sh", "-c", `cat ${shellQuote(markerPath)}`]),
      deadlineMs,
      "race-read",
    );
```

So the fix is **not** to relocate the steering paths. **Read the acks with
`driver.exec(vm, ["sh","-c",`cat ${shellQuote(ackPath)}`])`, not
`driver.copyFile`.** That keeps the absolute `/run/steering/…` paths the story
specifies, keeps host and box agreeing on one absolute constant, touches no
driver path-safety surface, and is the precedent the repo already paid for in a
live incident. `shellQuote` is `fanout-primitive.ts:755-757`:

```ts
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
```

(Mirrored verbatim at `scripts/pipeline-run-remote.ts:49-52`, whose
`fetchBoxFile` at `:55-62` is the same read-a-file-off-the-box idiom and
additionally treats a non-zero `cat` as a refusal rather than empty bytes —
copy that error discipline.)

Ranked options, for the record:
1. **RECOMMENDED — `exec` + `cat` + `shellQuote` for the ack read.** Absolute
   paths survive. The story's `copyFile` wording (`df3-4:148-149`, `:231`) is the
   part that must change, not the paths. Flag this to the story owner: it is a
   one-verb correction to the spec, backed by a dated live measurement.
2. Box-relative steering dir + `copyFile`. Works, but forces the spec's absolute
   paths to move and buys nothing over option 1.
3. Widening `assertBoxPathSafe` / FakeDriver's escape check to admit `/run/...`
   is a **DF2.1-owned seam change** and out of DF3.4's Files list. Do not.

Caveat carried from §3: under **FakeDriver** a box is a host *directory* and
`sh -c` runs with that directory as cwd, so an absolute `/run/steering/...` is a
real host path outside the box — writable only if the host allows it (`/run` is
root-owned on Linux, absent on darwin). For the AC6 **fake-box** test the paths
still need an override. Mirror `runMarkerRoot()` (`journal.ts:33-40`) — the
`/run` + `QDS_RUN_ROOT` env-override pattern that exists for precisely this
reason — as a `steeringRoot()` with `QDS_STEERING_ROOT`. Production keeps
`/run/steering`; the test points it at a tmpdir. This is an override knob, not a
path relocation, and it is needed under either option above.

---

## 6. The resident agent — spawn, dirs, user, `/run/steering/`

`startResident(opts)` — `src/fleet/resident.ts:321-639`. Returns
`ResidentSpawn | { disabled: true }`.

- **Spawn:** `Bun.spawn([bin, "--provider","openrouter","--model",modelArg,
  "--mode","json","--no-tools","--session",sessionPath,"-p",prompt], { stdin:"ignore",
  stdout:"pipe", stderr:"pipe", timeout:timeoutMs, killSignal:"SIGKILL", env: childEnv })`
  — `resident.ts:446-471`. **One pi process per call**, on the HOST. Session
  continuity is the `--session <path>` FILE, not a long-lived process
  (`resident.ts:11-14`).
- **`pi 0.55.0`'s prompt contract IS argv — its stdin is "ignore"**
  (`resident.ts:50-59`, and `stdin: "ignore"` at :465). The resident subprocess
  therefore has **no stdin channel of its own**; anything DF3.4 wants the
  resident to see must arrive through `ctx.promptContext` → `renderPrompt` →
  `-p`. This is a second, independent reason the drain cannot be "hand the file
  to the agent".
- **In-box working dirs: THERE ARE NONE.** The resident's dirs are host-side:
  `opts.sessionDir` (holds `${runId}.resident.jsonl`, chmod 0700 dir / 0600 file)
  and `opts.persistDir` (redacted prompt/reply artifacts, 0700/0600). Both are
  wired to `path.dirname(path.resolve(journalPath))` at
  `scripts/pipeline-run.ts:1669-1676`.
- **Agent user:** none in-box. The resident runs as the host user that ran
  `pipeline-run.ts`. In-box phase commands run as the box's ssh user
  (`$HOME/src`, `scripts/pipeline-run-remote.ts:11-12`). The story's "owned by
  the in-box agent user" therefore means the box's exec user, not a resident
  identity — there is no in-box agent process to own anything.
- **`/run/steering/` does not exist and is never created.** DF3.4 must create it
  with mode 0600 on the files (0700 on the dir — 0600 on a directory is not
  traversable; the story text says 0600 for "both paths", read as the files).
  Precedent for the mkdir+chmod discipline:
  `persistArtifact` (`resident.ts:294-313`) — `mkdirSync(dir,{recursive:true,mode:0o700})`,
  explicit `chmodSync(dir, 0o700)` because mkdir's mode applies only to dirs it
  creates, `rmSync(tmp)` then `writeFileSync(tmp, body, {mode:0o600})` then
  `renameSync` (atomic).
- **Least-privilege child env:** `CHILD_ENV_ALLOWLIST` (`resident.ts:235-247`) +
  `QDS_RESIDENT_ENV_PASSTHROUGH` escape hatch. If DF3.4 adds a
  `QDS_STEERING_ROOT`-style env knob read by the resident child, it must be
  allowlisted; if read only host-side by the engine, it need not be.
- **Sequential-call contract:** `current` is a single slot; an overlapping call
  throws "resident busy" (`resident.ts:405-421`). `solicit()` is already
  serialized by a promise chain in `steering.ts:328-333`. A drain that awaits I/O
  inside `solicitSerialized` inherits that serialization — safe, but it extends
  the critical section; keep the drain bounded.

---

## 7. `requestId` propagation — where attach reads it

Four places, all consistent:

1. **`RunRecord` core field** — `src/providers/run-record.ts:67` (`requestId: "string"`
   in the twelve-core-field map), `:108`, `:702`, defaulted via `newRequestId()`
   at `:806`, emitted at `:1866`. **This is where `fleet attach` reads it**:
   load `.sandbox/runs/<runId>.json` through the store, take `record.requestId`.
   Host-side, no box call needed.
2. **The run** — `scripts/pipeline-run.ts:1182` mints
   `let requestId: string = crypto.randomUUID()`; on a correlated run
   `runId = requestId = resolved.requestId` (`:1293` — "One identifier: the run's
   id IS the resolved requestId, never a second").
3. **Into the engine** — `runContextFrom(runId, requestId, manifest, …)`
   (`:369-373`), and `ResidentHooks.requestId` (`:669`) which feeds every
   `SolicitCtx.requestId` at the three points.
4. **Into the resident's opening prompt** — `residentContextLines` pushes
   `requestId: …` from the brief (`:745-750`).

So `attach` echoes the ack's `requestId` from the RunRecord, and the engine-side
ack line can carry `ctx.requestId` (already on `SolicitCtx`, `steering.ts:102`)
— the two agree by construction.

---

## 8. NDJSON append/read idioms already in the repo — REUSE THESE

**Canonical pair — `src/reverify/report.ts:291-323`:**
```ts
export function reportPath(dir: string, runId: string): string {
  return join(dir, `${runId}.jsonl`);
}

/** Append-only: one JSON object per line, never a rewrite of an earlier line. */
export function appendReport(dir: string, report: ReverifyReport): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(reportPath(dir, report.runId), `${JSON.stringify(report)}\n`, { mode: 0o600 });
}

/** Every report for a run, in write order. The LAST is authoritative (DF5.2). */
export function readReports(dir: string, runId: string): ReverifyReport[] {
  let text: string;
  try { text = readFileSync(reportPath(dir, runId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: ReverifyReport[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try { out.push(JSON.parse(line) as ReverifyReport); }
    catch { /* torn or truncated line — ignore it */ }
  }
  return out;
}
```
The **skip-a-torn-line** rule (`report.ts:302-306`) is exactly what an inbox
drain needs: a `cat >>` killed mid-append must not throw the whole solicitation.

**Second precedent — `src/pr/push.ts:138` + `:151`:**
```ts
  return join(dir, `${runId}.refusals.jsonl`);
  …
  appendFileSync(refusalPath(dir, record.runId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
```

**Dedupe key:** no existing NDJSON helper carries one. `messageId` dedupe is
DF3.4-new — the lazy shape is a `Set<string>` of already-drained `messageId`s
held on the steering controller for the run's lifetime (the drain is
process-local and the run is one process), plus the acks file as the durable
record. Do NOT build a generic NDJSON module; these are ~12-line file-local
helpers in the repo's idiom and DF3.4 should follow suit.

**Note:** `src/phase-engine/journal.ts` is **not** NDJSON — it is a whole-file
write-temp + fsync + rename of one JSON document per flush. Do not model the
steering channel on it. What journal.ts DOES contribute is `runMarkerRoot()`
(`:33-40`) — the `/run` + `QDS_RUN_ROOT` override pattern DF3.4 should mirror.

---

## 9. DF3.6 rebase — what DF3.4 must leave structurally easy

**DF3.6 Files to Modify** (`df3-6-resident-agent-bounds.md:228-238`):
- `src/phase-engine/resident-bounds.ts`
- `src/phase-engine/steering.ts` — "**DF3.6 rebases last** and **adds only** the
  `checkBounds(point)` wrapper around the existing call sites: no fourth point,
  no new point, and no edit to a DF3.3- or DF3.4-owned line."
- `src/phase-engine/manifest.ts`
- `tests/phase-engine/resident-bounds.test.ts`
- `tests/phase-engine/fixtures/pipeline.bounds.json`

DF3.6 gates **before** the prompt is rendered — its seam comment is already in
place at `steering.ts:339-341`, one line ABOVE DF3.4's drain seam:

```ts
    // SEAM DF3.6: checkBounds(point) wraps here — spend/iteration/RSS bounds
    // gate before any prompt is rendered.
    // SEAM DF3.4: drain the resident inbox into ctx.promptContext here,
    // pre-render (the ctx field is mutable for exactly this slot).
```

DF3.6 AC (`:58`): a refused bound means the engine "does **not** issue the call:
the resident is stopped". So **`checkBounds` must be able to return before the
drain runs.** What DF3.4 must leave easy:

- **Put the drain in ONE named function** (e.g. `drainInbox(point, ctx)`) called
  from exactly one place, immediately after the DF3.6 seam comment and before
  `renderPrompt`. DF3.6 then inserts one `if (!checkBounds(point)) { … return
  PROCEED; }` ABOVE it without touching a DF3.4 line. An inlined multi-statement
  drain forces DF3.6 to edit around it.
- **Do not move, reorder, or reword either seam comment.** They are the rebase
  anchors named in all three stories.
- **Do not add a `SteeringPoint` member** and do not widen
  `ResidentTripwire.cause` — DF3.6 AC (`:112`) explicitly relies on DF3.3's
  closed three-cause set and closed `ResidentStatus` set staying unchanged.
- **Extend `createSteering`'s `deps` object additively** (a new optional field),
  never by changing its positional shape — DF3.6 adds bounds deps to the same
  object.
- **Do not consume `telemetry.spendMicros`/`steeringIterations` semantics** —
  DF3.6 gates on them.

### The 4 000-char attach bound — DOES IT EXIST? Partly, and NOT where the story says.

- DF3.6 defines **exactly three** bounds (`df3-6:140-143`):
  `maxSteeringIterations` = 8/phase, `residentRssBytes` = 512 MiB,
  `residentSpendCeilingMicros` = 2 000 000 µ$/run. **No character bound.** The
  only DF3.6 mention of attach is `:123` — "operator raising a bound mid-run via
  `attach` | out-of-scope | DF3.4", i.e. DF3.6 delegates *to* DF3.4, not the
  reverse. **DF3.4's "also subject to DF3.6's bound, which the gate consumes
  rather than re-implements" (df3-4:245) is a misattribution.**
- **The 4 000 bound DOES exist today, DF3.3-owned and exported** —
  `steering.ts:29-33`:
  ```ts
  /** Free-text directive field ceiling: accepted guidance is pushed into
   *  promptContext and rides every later solicitation for the run's lifetime,
   *  so a directive string needs its own bound well under PROMPT_CHAR_CEILING.
   *  An over-ceiling field fails schema parse and takes the rejection path. */
  export const DIRECTIVE_TEXT_CHAR_CEILING = 4_000;
  ```
  Its rationale is **verbatim the attach case**: text pushed into
  `promptContext` that rides every later solicitation.

**Interim answer for DF3.4:** import `DIRECTIVE_TEXT_CHAR_CEILING` from
`steering.ts` and bound `message` at ingress with it — that IS "consuming rather
than re-implementing", against the constant that actually exists. No new
constant, no waiting on DF3.6. If DF3.6 later adds a char bound it will be the
same number from the same file. Also worth noting in the story's Dev Agent
Record so the misattribution does not propagate.

---

## 10. The ADD-ONLY seam, concretely

```
steering.ts:259-263   createSteering(deps: { caller, rate, onTripwire? })
                      → ADD one optional dep, e.g.
                        inbox?: {
                          drain(point: SteeringPoint): Promise<{messageId: string; message: string}[]>;
                          ack(messageId: string, point: SteeringPoint): Promise<void>;
                        }
                      (a PORT — steering.ts must not import fleet/driver code)

steering.ts:339-342   the DF3.4 seam comment (already written by DF3.3)
                      → ADD: `await drainInbox(point, ctx)` — one call, one
                        named function, pushing sanitized+prefixed lines onto
                        ctx.promptContext, deduped on messageId

steering.ts:429-430   the DF3.4 ack seam comment
                      → see §1d/§1e: prefer acking at DRAIN time (or in a
                        finally) so a rejected reply does not swallow the ack

scripts/pipeline-run.ts:1708-1725   the ONE createSteering call site
                      → the driver-backed inbox implementation is injected here
                        (fleet side), NOT inside steering.ts
```

Everything above is additive. No DF3.3-owned line is edited.

---

## 11. Open questions / ambiguities to raise before implementation

1. **Who owns the drain implementation?** `steering.ts` cannot import fleet or
   provider code. The concrete driver-backed inbox reader belongs in
   `src/fleet/attach.ts` (already in DF3.4's Files list) and is injected at
   `scripts/pipeline-run.ts:1708`. **But `scripts/pipeline-run.ts` is NOT in
   DF3.4's Files to Modify list** — and it is the only place the dep can be
   wired. Either the Files list needs `scripts/pipeline-run.ts` added, or the
   drain must reach the controller some other way. **Flag this to the story
   owner.** (Same file, same wiring block, one added property — small, but it is
   a scope-list gap, not a judgement call.)
2. **Absolute vs box-relative steering paths** (BLOCKER-A). Recommend box-relative
   + a `steeringRoot()` override mirroring `runMarkerRoot()`.
3. **Host-side engine** (BLOCKER-B). The story's framing ("the engine drains it
   INSIDE the box") does not match the deployed topology. The drain must be a
   `driver.exec` read (`sh -c 'cat <path>'`, like
   `pipeline-run-remote.ts:55-62`) or a `driver.copyFile` — i.e. attach's
   in-box→host leg is a driver round-trip per solicitation, on the host's clock,
   inside the serialized `solicit` chain. Budget it.
4. **Drain-and-truncate semantics.** "Drain" implies the inbox is emptied. There
   is no in-box truncate primitive that is safe against a concurrent `cat >>`
   (the append from `fleet attach` can interleave). Recommend: **never truncate**
   — read the whole file each time and dedupe on `messageId` host/engine-side.
   Cheap, race-free, and the acks file bounds growth diagnostics. This is what
   makes "re-issuing the same messageId delivers once" true.
5. **Ack-on-rejected-reply** (§1e). Decide before writing the test, because the
   test for AC6 ("acks at next DF3.3 solicitation") will encode the choice.
6. **Point-2 latency ceiling.** Attach during an *agent*-phase retry loop is not
   drained until `run_end`. Restate it in the story; do not close it with a
   fourth point.

---

## 12. ADDENDA — round 2 verification (gaps in §§4, 6, 8 closed)

Three questions were under-answered above. Verified directly:

### 12a. The 0600 IN-BOX creation idiom — `deliverScript`, the real reference

§6 cited `persistArtifact` (`resident.ts:294-313`), which is the **host-side**
0600 idiom. The in-box one — and the reference the brief actually named — is
`src/providers/credentials.ts:347-358`:

```ts
/**
 * Deliver the secret over the driver's stdin channel into `KEY_ENV_FILE`
 * (mode 0600). The argv carries only the fixed script — the value never
 * appears in `ps` on either side (fill.just:147-155). Confirmation is by
 * `stat` mode, never by echoing the value back.
 */
function deliverScript(envFile: string): string {
  // Single quotes are safe AND sufficient: assertEnvFileSafe's charset excludes
  // every character (space, quote, $, ...) that could escape them. Belt over
  // braces — the validator is the primary defense, this is the secondary.
  return (
    `umask 077 && mkdir -p "$(dirname '${envFile}')" && cat > '${envFile}' && ` +
    `chmod 600 '${envFile}' && ` +
    // python3 rather than GNU `stat -c`: the fake driver runs on the host, which
    // may be macOS (BSD stat has no -c); inside a real box either works.
    `python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' '${envFile}'`
  );
}
```

Call site, `credentials.ts:380-393`:

```ts
export async function deliverRunKey(deps: CredentialDeps, vm: string, key: string): Promise<void> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId: null };
  const envFile = deps.envFile ?? KEY_ENV_FILE;
  assertEnvFileSafe(envFile);
  const stdin = `${KEY_ENV_VAR}=${key}\n`;
  const res = await timed(ctx, "deliver", () => deps.driver.exec(vm, ["sh", "-c", deliverScript(envFile)], stdin));
  const mode = res.stdout.trim();
  if (res.exitCode !== 0 || mode !== "600") {
    throw new CredentialLifecycleError(
      "delivery-failed",
      `key delivery to ${vm}:${envFile} failed (exit ${res.exitCode}, mode ${mode || "unknown"})`,
      "inspect the box by hand, then re-run teardown for the run",
    );
  }
}
```

Five properties DF3.4's inbox append must copy, each load-bearing:

1. **`umask 077` FIRST**, so the file is 0600 from the instant `cat >` creates
   it — never briefly world-readable, which a create-then-`chmod` would be.
2. **`mkdir -p "$(dirname …)"`** — this is how `/run/steering/` gets created.
   Dir gets 0700 from the umask; the story's "0600 on both" reads as 0600 on the
   *files* (0600 on a directory is not traversable).
3. **`chmod 600` anyway**, belt-over-braces against a pre-existing lax file.
4. **Payload on stdin, argv carries only the fixed script.** The comment states
   the reason: "the value never appears in `ps` on either side". This is the
   same property AC6's negative control asserts — the precedent is already load-
   bearing for DF2.3's key, and attach inherits it for free.
5. **Confirm the mode by reading `stat` back and comparing**, never assume it.
   `mode !== "600"` is a hard refusal. `python3` not `stat -c` because the fake
   driver runs on the host, which may be macOS.

Path safety: `assertEnvFileSafe` (`credentials.ts:362-378`) gates the path
before it is interpolated — charset `[A-Za-z0-9._/-]`, no `..` segments. DF3.4's
steering paths are constants, not operator input, so they pass trivially; keep
the same validator-then-quote discipline anyway.

**Note the asymmetry:** the inbox APPEND is `exec` + stdin, so it is
`deliverScript`-shaped. The ack READ is `exec` + `cat` (§5, corrected). Neither
leg is `copyFile`.

### 12b. Polling with a timeout — the helpers DO exist (§10 of the brief)

Not "none exists". Two reusable pieces, both already imported across the repo:

**Per-call deadline — `src/providers/timeout.ts:46-57`:**
```ts
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  void p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```
Note `void p.catch(() => {})` (no unhandled rejection from the abandoned call)
and the `finally` clearTimeout (no leaked timer). It **abandons**, it does not
cancel — `driver.ts:702` says so explicitly. Already used by `driver.ts:379`,
`reaper.ts:360/386/625`, and fanout.

**Poll-to-a-ceiling loop — `runRace`, `src/fleet/fanout-primitive.ts:602-660`.**
The shape DF3.4's 30 s ack poll should copy, with its **three separate**
constants (`:51-57`):
```ts
/** AC5 poll interval. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** AC5 per-call deadline for every exec probe and copyFile read. */
export const DEFAULT_PER_CALL_DEADLINE_MS = 10_000;
/** AC5/INV-6 fan-out ceiling — undecided arms report armUnknown past it. */
export const DEFAULT_FANOUT_CEILING_MS = 3_600_000;
```
Loop body (`:616-650`), all three injectable via `deps` for tests:
```ts
  const baseline = performanceNow(deps);
  while (undecided().length > 0 && performanceNow(deps) - baseline < ceilingMs) {
    …
    if (undecided().length > 0 && performanceNow(deps) - baseline < ceilingMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
```
Two details worth stealing: the ceiling is re-checked **before** sleeping (no
sleep past the deadline), and a monotonic `performanceNow(deps)` seam is
injected rather than `Date.now()`. Also `MARKER_UNUSABLE_TICKS_LIMIT = 3`
(`:67`) — a *present but unparseable* target is abandoned after 3 consecutive
ticks rather than polled to the ceiling, because "persistent parse failure is
CORRUPTION, not latency". A torn ack line deserves the same treatment.

DF3.4 needs: `pollIntervalMs` (small — the ack is local to the box), a
per-`exec` deadline via `withTimeout`, and the story's 30 000 ms as the ceiling.
Confirming §3's point: **FakeDriver's `exec` has no timeout of its own**, so the
`withTimeout` wrap is mandatory, not decorative.

### 12c. BLOCKER-B is worse than stated — DF3.6 makes the same wrong assumption

§0.3 said DF3.4's story assumes an in-box engine that does not exist. Verified
against `scripts/pipeline-run-remote.ts:5-13`:

> "nothing invokes the phase engine after dispatch, and the box image carries no
> bun/node, so `scripts/pipeline-run.ts` cannot run in-box. This shim proves the
> rest of the chain REAL: … the phases execute ON THE BOX (`sh -c <cmd>` in
> `$HOME/src` via driver.exec) **orchestrated FROM THE HOST**."

and `:17-19`: "HONEST LABEL: this is NOT the in-box executor (**proposed story
DF1.10**)".

**DF3.6's spec assumes the same non-existent topology** —
`df3-6-resident-agent-bounds.md:105-112` requires the ordering check run "at
**manifest load inside the box**, before the resident is spawned", and its Infra
table says "the host-side `.sandbox/runs/<id>.json` record does not exist inside
the box". Today the engine, the resident (`Bun.spawn`, `resident.ts:446-471`),
and the records dir are all **host-side**.

This is therefore not a DF3.4 defect to fix — it is a **shared v5-S2 premise
gap** blocking DF3.4 and DF3.6 alike, pending DF1.10. Raise it once, at the
sprint level, rather than letting DF3.4 invent a private answer. DF3.4's own
work is unaffected in practice: host-side engine + `driver.exec` transport is
exactly what §10's injected-port design already assumes.

### 12d. Verification status of every claim above

Re-read and confirmed in full this round: `steering.ts` (451 L), `resident.ts`
(639 L), `fake-driver.ts:330-410`, `recording-driver.ts` (whole file),
`credentials.ts:340-400`, `driver.ts:180-200`, `timeout.ts:46-57`,
`fanout-primitive.ts:40-70/596-760`, `pipeline-run-remote.ts:1-70`,
`df3-6:50-70/105-150/220-245`.

Carried forward from round 1 and **not** independently re-verified this round:
every `scripts/pipeline-run.ts` line number (§1b, §1d, §7, §10),
`src/reverify/report.ts:291-323`, `src/pr/push.ts:138/151`,
`src/providers/exedev/driver.ts:437-495/604-614`, `src/providers/run-record.ts`
citations, and the GitNexus blast-radius figure in §1a. Treat those as
high-confidence but unconfirmed; re-check before editing at those exact lines.
